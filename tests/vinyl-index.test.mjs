// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodeQuantizedIndex, quantizeUnitVector } from '../benchmarks/vinyl/benchmark-core.mjs';
import { decodeQuantizedIndex } from '../js/vector-index.mjs';
import { searchVinylCatalog } from '../js/vinyl-index.mjs';

function response(body, type = 'application/json') {
  return new Response(body, { headers: { 'Content-Type': type } });
}

test('static vinyl shards are searched locally without sending the query vector', async () => {
  const calls = [];
  const assets = new Map([
    ['https://catalog.example/manifest.json?v=build', response(JSON.stringify({
      schemaVersion: 1,
      model: 'Xenova/dinov2-small',
      dimension: 2,
      releaseCount: 2,
      downloadBytes: 28,
      shards: [
        { index: 'zero.bin', metadata: 'zero.json', count: 1, bytes: 14 },
        { index: 'one.bin', metadata: 'one.json', count: 1, bytes: 14 },
      ],
    }))],
    ['https://catalog.example/zero.bin?v=build', response(encodeQuantizedIndex([
      quantizeUnitVector([0, 1]),
    ]), 'application/octet-stream')],
    ['https://catalog.example/zero.json?v=build', response(JSON.stringify({ releases: [
      { musicBrainzReleaseId: 'zero', artist: 'First', title: 'Far', coverSource: 'https://covers.example/zero.jpg' },
    ] }))],
    ['https://catalog.example/one.bin?v=build', response(encodeQuantizedIndex([
      quantizeUnitVector([1, 0]),
    ]), 'application/octet-stream')],
    ['https://catalog.example/one.json?v=build', response(JSON.stringify({ releases: [
      { musicBrainzReleaseId: 'one', artist: 'Second', title: 'Near', date: '1984-03-01', country: 'GB', coverSource: 'https://covers.example/one.jpg' },
    ] }))],
  ]);
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    const asset = assets.get(String(url));
    if (!asset) return new Response('', { status: 404 });
    return asset.clone();
  };

  const result = await searchVinylCatalog([1, 0], {
    manifestUrl: 'https://catalog.example/manifest.json?v=build',
    fetcher,
  });

  assert.equal(result.manifest.releaseCount, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ['one', 'zero']);
  assert.equal(result.candidates[0].thumb, 'https://covers.example/one.jpg');
  assert.equal(result.candidates[0].date, '1984-03-01');
  assert.equal(result.candidates[0].country, 'GB');
  assert.ok(calls.every(({ init }) => init.method === 'GET' && !('body' in init)));
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://catalog.example/manifest.json?v=build',
    'https://catalog.example/zero.bin?v=build',
    'https://catalog.example/zero.json?v=build',
    'https://catalog.example/one.bin?v=build',
    'https://catalog.example/one.json?v=build',
  ]);
});

test('a mismatched shard is rejected instead of pairing the wrong album with a vector', async () => {
  const index = encodeQuantizedIndex([quantizeUnitVector([1, 0])]);
  const fetcher = async (url) => {
    if (String(url).endsWith('manifest.json')) return response(JSON.stringify({
      schemaVersion: 1,
      model: 'Xenova/dinov2-small',
      dimension: 2,
      releaseCount: 2,
      downloadBytes: index.byteLength,
      shards: [{ index: 'index.bin', metadata: 'metadata.json', count: 2, bytes: index.byteLength }],
    }));
    if (String(url).endsWith('.bin')) return response(index, 'application/octet-stream');
    return response(JSON.stringify({ releases: [
      { musicBrainzReleaseId: 'only-one', artist: 'One', title: 'One', coverSource: 'https://covers.example/one.jpg' },
    ] }));
  };

  await assert.rejects(
    searchVinylCatalog([1, 0], { manifestUrl: 'https://catalog.example/manifest.json', fetcher }),
    /count does not match/,
  );
});

test('a catalog manifest cannot redirect shard downloads to another origin', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    return response(JSON.stringify({
      schemaVersion: 1,
      model: 'Xenova/dinov2-small',
      dimension: 2,
      releaseCount: 1,
      downloadBytes: 14,
      shards: [{
        index: 'https://unexpected.example/index.bin',
        metadata: 'metadata.json',
        count: 1,
        bytes: 14,
      }],
    }));
  };

  await assert.rejects(
    searchVinylCatalog([1, 0], { manifestUrl: 'https://catalog.example/manifest.json', fetcher }),
    /catalog origin/,
  );
  assert.deepEqual(calls, ['https://catalog.example/manifest.json']);
});

test('the shipped pilot has a non-empty one-to-one vector and vinyl metadata set', async () => {
  const manifest = JSON.parse(await readFile('assets/vinyl-index/manifest.json', 'utf8'));
  const metadata = JSON.parse(await readFile('assets/vinyl-index/shard-000.json', 'utf8'));
  const bytes = await readFile('assets/vinyl-index/shard-000.bin');
  const index = decodeQuantizedIndex(bytes);

  assert.equal(manifest.releaseCount, 12);
  assert.equal(index.count, manifest.releaseCount);
  assert.equal(index.dimension, manifest.dimension);
  assert.equal(metadata.releases.length, manifest.releaseCount);
  assert.equal(new Set(metadata.releases.map((release) => release.musicBrainzReleaseId)).size, manifest.releaseCount);
  assert.ok(metadata.releases.every((release) =>
    release.coverSource === `https://coverartarchive.org/release/${release.musicBrainzReleaseId}/front-500`));
  assert.ok(metadata.releases.every((release) => !('coverPath' in release)));
});
