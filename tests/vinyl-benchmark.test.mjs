// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  artistCreditText,
  isLongTail,
  isVinylRelease,
  longTailScore,
  musicBrainzQuery,
  pageOffset,
  parseDiscogsReleaseId,
  shuffled,
  stableShard,
} from '../scripts/vinyl-benchmark-lib.mjs';
import {
  decodeQuantizedIndex,
  encodeQuantizedIndex,
  fetchQuantizedIndex,
  normalizeVector,
  quantizeUnitVector,
  rankQuantized,
} from '../benchmarks/vinyl/benchmark-core.mjs';

test('the sampler is deterministic without preserving input order', () => {
  const values = Array.from({ length: 12 }, (_, index) => index);
  assert.deepEqual(shuffled(values, 42), shuffled(values, 42));
  assert.notDeepEqual(shuffled(values, 42), values);
  assert.notDeepEqual(shuffled(values, 42), shuffled(values, 43));
});

test('stable shards assign every identifier to exactly one valid shard', () => {
  for (const value of ['alpha', 'beta', 'gamma', 'delta']) {
    const shard = stableShard(value, 4);
    assert.ok(shard >= 0 && shard < 4);
    assert.equal(Array.from({ length: 4 }, (_, index) => index === shard).filter(Boolean).length, 1);
  }
});

test('Discogs release identifiers are extracted from canonical and localized URLs', () => {
  assert.equal(parseDiscogsReleaseId([{ url: { resource: 'https://www.discogs.com/release/12345-title' } }]), 12345);
  assert.equal(parseDiscogsReleaseId([{ url: { resource: 'https://www.discogs.com/de/release/67890' } }]), 67890);
  assert.equal(parseDiscogsReleaseId([{ url: { resource: 'https://www.discogs.com/master/12345' } }]), null);
});

test('vinyl and long-tail filters use physical format and explicit Discogs ceilings', () => {
  assert.equal(isVinylRelease({ media: [{ format: '12\" Vinyl' }] }), true);
  assert.equal(isVinylRelease({ media: [{ format: 'CD' }] }), false);
  assert.equal(isLongTail({ have: 100, want: 30 }), true);
  assert.equal(isLongTail({ have: 101, want: 1 }), false);
  assert.equal(isLongTail({ have: 1 }), false);
  assert.equal(longTailScore({ have: 20, want: 10 }), 40);
});

test('MusicBrainz searches are structured and deeper offsets remain bounded', () => {
  assert.equal(
    musicBrainzQuery({ year: 1983, country: 'de' }),
    'format:vinyl AND primarytype:album AND status:official AND date:1983 AND country:DE',
  );
  assert.equal(pageOffset(50, 100, 0.5), 0);
  assert.equal(pageOffset(1000, 100, 0), 315);
  assert.equal(pageOffset(1000, 100, 1), 900);
});

test('artist credits preserve MusicBrainz join phrases', () => {
  assert.equal(artistCreditText([
    { name: 'Alice', joinphrase: ' & ' },
    { artist: { name: 'Bob' } },
  ]), 'Alice & Bob');
});

test('quantized index round-trips and ranks the closest unit vector first', () => {
  const vectors = [
    normalizeVector([1, 0, 0]),
    normalizeVector([0, 1, 0]),
    normalizeVector([0.8, 0.2, 0]),
  ];
  const encoded = encodeQuantizedIndex(vectors.map(quantizeUnitVector));
  const decoded = decodeQuantizedIndex(encoded);
  assert.equal(decoded.dimension, 3);
  assert.equal(decoded.count, 3);
  assert.deepEqual(Array.from(decoded.vectors[0]), [127, 0, 0]);
  assert.deepEqual(rankQuantized(normalizeVector([0.95, 0.05, 0]), decoded, 2).map((item) => item.index), [0, 2]);
});

test('vector helpers reject empty, mismatched, and malformed input', () => {
  assert.throws(() => normalizeVector([]), /non-empty/);
  assert.throws(() => encodeQuantizedIndex([new Int8Array(2), new Int8Array(3)]), /dimension/);
  assert.throws(() => decodeQuantizedIndex(new Uint8Array(4)), /header/);
  const index = decodeQuantizedIndex(encodeQuantizedIndex([new Int8Array([127, 0])]));
  assert.throws(() => rankQuantized([1, 0, 0], index), /dimension/);
});

test('a serialized index can be fetched as a standalone browser asset', async () => {
  const encoded = encodeQuantizedIndex([new Int8Array([127, -12, 4])]);
  let requestedUrl;
  const index = await fetchQuantizedIndex('/assets/vinyl-index.bin', async (url) => {
    requestedUrl = url;
    return new Response(encoded);
  });
  assert.equal(requestedUrl, '/assets/vinyl-index.bin');
  assert.deepEqual(Array.from(index.vectors[0]), [127, -12, 4]);
});
