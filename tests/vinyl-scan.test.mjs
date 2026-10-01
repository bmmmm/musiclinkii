// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOcrLines, buildOcrQueries, fetchImage, pastedImage, rankOcrAlbumCandidates,
} from '../js/vinyl-scan.mjs';

test('OCR lines discard sleeve boilerplate without discarding label names', () => {
  assert.deepEqual(extractOcrLines(`
    DAFT PUNK
    DISCOVERY
    STEREO
    SIDE A
    Columbia Records
    DAFT PUNK
  `), ['DAFT PUNK', 'DISCOVERY', 'Columbia Records']);
});

test('OCR queries combine split artist and title lines before widening', () => {
  const queries = buildOcrQueries('DAFT PUNK\nDISCOVERY\nSTEREO');
  assert.deepEqual(queries, [
    'DAFT PUNK DISCOVERY',
    'DAFT PUNK',
    'DISCOVERY',
  ]);
});

test('OCR queries are bounded even when liner notes fill the image', () => {
  const text = Array.from({ length: 20 }, (_, i) => `Readable line number ${i}`).join('\n');
  const queries = buildOcrQueries(text);
  assert.ok(queries.length > 0, 'a non-empty OCR result must produce a query');
  assert.ok(queries.length <= 4, 'one scan must not fan out into an unbounded catalog burst');
  assert.ok(queries.every((query) => query.length <= 120));
});

test('album ranking uses all OCR lines, not only the catalog query that found a row', () => {
  const candidates = [
    { title: 'The Dark Side of the Moon', artist: 'Pink Floyd', link: 'right', queryRank: 1 },
    { title: 'Dark Side', artist: 'Blind Channel', link: 'wrong-artist', queryRank: 0 },
    { title: 'The Wall', artist: 'Pink Floyd', link: 'wrong-title', queryRank: 0 },
  ];
  const ranked = rankOcrAlbumCandidates(
    candidates,
    'PINK FLOYD\nTHE DARK SIDE\nOF THE MOON\nSTEREO'
  );
  assert.equal(ranked[0].link, 'right');
  assert.ok(ranked[0].score > ranked[1].score);
});

test('album ranking tolerates common OCR substitutions inside long tokens', () => {
  const candidates = [
    { title: 'Rumours', artist: 'Fleetwood Mac', link: 'right', queryRank: 1 },
    { title: 'Rumor', artist: 'Lee Brice', link: 'wrong', queryRank: 0 },
  ];
  const ranked = rankOcrAlbumCandidates(candidates, 'FLEETW00D MAC\nRUM0URS');
  assert.equal(ranked[0].link, 'right');
  assert.ok(ranked[0].score >= 0.8);
});

test('album ranking removes duplicates and requires title evidence', () => {
  const candidates = [
    { title: 'Discovery', artist: 'Daft Punk', link: 'first', queryRank: 0 },
    { title: 'Discovery', artist: 'DAFT PUNK', link: 'duplicate', queryRank: 1 },
    { title: 'Random Access Memories', artist: 'Daft Punk', link: 'wrong', queryRank: 0 },
    { title: 'Unrelated', artist: 'Someone Else', link: 'zero', queryRank: 0 },
  ];
  const ranked = rankOcrAlbumCandidates(candidates, 'DAFT PUNK\nDISCOVERY');
  assert.deepEqual(ranked.map((candidate) => candidate.link), ['first']);
});

test('album ranking does not present weak one-word overlaps as possible matches', () => {
  const candidates = [
    { title: 'As Vozes (Ao Vivo)', artist: 'Péricles', link: 'noise-1', queryRank: 0 },
    { title: 'As We Get High', artist: 'bees & honey', link: 'noise-2', queryRank: 0 },
  ];
  assert.deepEqual(rankOcrAlbumCandidates(candidates, '. - As VW [I'), []);
});

test('one fuzzy word is not enough evidence for an album candidate', () => {
  const candidates = [
    { title: 'Reader', artist: 'R.M.F.C.', link: 'noise', queryRank: 0 },
  ];
  assert.deepEqual(rankOcrAlbumCandidates(candidates, 'READE'), []);
});

test('a printed title phrase beats an album assembled from personnel names', () => {
  const candidates = [
    { title: 'Miles & Coltrane', artist: 'Miles Davis', link: 'personnel', queryRank: 0 },
    { title: 'Kind Of Blue (Legacy Edition)', artist: 'Miles Davis', link: 'album', queryRank: 1 },
  ];
  const text = 'MILES DAVIS Kind of Blue with Julian Cannonball Adderley John Coltrane Bill Evans';
  assert.equal(rankOcrAlbumCandidates(candidates, text)[0].link, 'album');
});

test('an image clipboard item is separated from ordinary pasted text', () => {
  const image = new Blob(['image'], { type: 'image/png' });
  const clipboard = { items: [
    { kind: 'string', type: 'text/plain', getAsFile: () => null },
    { kind: 'file', type: 'image/png', getAsFile: () => image },
  ] };
  assert.equal(pastedImage(clipboard), image);
  assert.equal(pastedImage({ items: clipboard.items.slice(0, 1) }), null);
});

test('an image URL is fetched directly by the client without an upload body', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
  };
  try {
    const image = await fetchImage('https://covers.example/user-selected.jpg');
    assert.equal(image.type, 'image/jpeg');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(request, {
    url: 'https://covers.example/user-selected.jpg',
    init: undefined,
  });
});
