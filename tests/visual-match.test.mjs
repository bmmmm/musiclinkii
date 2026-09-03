// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canRerankVisually,
  cosineSimilarity,
  rankVisualCandidates,
  rerankVinylCandidates,
} from '../js/visual-match.mjs';

test('visual comparison is offered only for a bounded set with artwork', () => {
  assert.equal(canRerankVisually([{ thumb: 'one' }]), false);
  assert.equal(canRerankVisually([{ thumb: 'one' }, { thumb: '' }]), false);
  assert.equal(canRerankVisually([{ thumb: 'one' }, { thumb: 'two' }]), true);
  assert.equal(canRerankVisually(Array.from({ length: 6 }, () => ({ thumb: 'cover' }))), false);
});

test('cosine similarity handles magnitude and rejects incompatible vectors', () => {
  assert.equal(cosineSimilarity([2, 0], [10, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.throws(() => cosineSimilarity([1], [1, 2]), /dimension/);
  assert.throws(() => cosineSimilarity([0, 0], [1, 0]), /non-zero/);
});

test('visual evidence can correct an ambiguous OCR order without mutating it', () => {
  const candidates = [
    { id: 'ocr-first', title: 'Blue', score: 0.82, thumb: 'one' },
    { id: 'visual-first', title: 'Blue', score: 0.55, thumb: 'two' },
  ];
  const ranked = rankVisualCandidates(candidates, [1, 0], [[0, 1], [1, 0]]);
  assert.deepEqual(ranked.map((candidate) => candidate.id), ['visual-first', 'ocr-first']);
  assert.equal(ranked[0].ocrScore, 0.55);
  assert.equal(ranked[0].visualScore, 1);
  assert.equal(candidates[0].visualScore, undefined);
});

test('the selected image becomes a local object URL and is never passed to fetch', async () => {
  const fetched = [];
  const outputs = [
    new Float32Array([1, 0]),
    new Float32Array([0, 1]),
    new Float32Array([1, 0]),
  ];
  const extractor = async () => ({ dims: [1, 2], data: outputs.shift() });
  const fetcher = async (url, init) => {
    fetched.push({ url, init });
    return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/jpeg' } });
  };
  const candidates = [
    { id: 'one', title: 'One', score: 0.8, thumb: 'https://catalog.example/one.jpg' },
    { id: 'two', title: 'Two', score: 0.5, thumb: 'https://catalog.example/two.jpg' },
  ];
  const ranked = await rerankVinylCandidates(
    new Blob(['private photo'], { type: 'image/jpeg' }),
    candidates,
    { extractor, fetcher },
  );
  assert.equal(ranked[0].id, 'two');
  assert.deepEqual(fetched.map(({ url }) => url), candidates.map(({ thumb }) => thumb));
  assert.ok(fetched.every(({ init }) => init.method === 'GET' && !('body' in init)));
});
