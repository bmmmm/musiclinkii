// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canRerankVisually,
  cosineSimilarity,
  clearVisualModel,
  markVisualModelStored,
  migrateLegacyVisualModel,
  rankVisualCandidates,
  rerankVinylCandidates,
  visualModelStored,
  VISUAL_MODEL,
  VISUAL_MODEL_CACHE,
} from '../js/visual-match.mjs';

test('visual model metadata describes the exact q4 files loaded by the pipeline', () => {
  assert.deepEqual(VISUAL_MODEL, {
    name: 'DINOv2 Small',
    repository: 'Xenova/dinov2-small',
    variant: 'q4 ONNX',
    dimensions: 384,
    bytes: 15035808,
    url: 'https://huggingface.co/Xenova/dinov2-small',
    fileUrl: 'https://huggingface.co/Xenova/dinov2-small/resolve/main/onnx/model_q4.onnx',
  });
});

function memoryCacheStorage() {
  const stores = new Map();
  return {
    async has(name) { return stores.has(name); },
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(key) { return store.get(String(key)); },
        async put(key, value) { store.set(String(key), value); },
        async keys() { return [...store.keys()]; },
        async delete(key) { return store.delete(String(key)); },
      };
    },
    async delete(name) { return stores.delete(name); },
  };
}

test('visual comparison is offered only for a bounded set with artwork', () => {
  assert.equal(canRerankVisually([{ thumb: 'one' }]), false);
  assert.equal(canRerankVisually([{ thumb: 'one' }, { thumb: '' }]), false);
  assert.equal(canRerankVisually([{ thumb: 'one' }, { thumb: 'two' }]), true);
  assert.equal(canRerankVisually(Array.from({ length: 6 }, () => ({ thumb: 'cover' }))), false);
});

test('the visual model owns a persistent cache with an explicit delete path', async () => {
  const cacheStorage = memoryCacheStorage();
  assert.match(VISUAL_MODEL_CACHE, /^musiclinkii-/);
  assert.equal(await visualModelStored({ cacheStorage }), false);
  await markVisualModelStored({ cacheStorage });
  assert.equal(await visualModelStored({ cacheStorage }), true);
  assert.equal(await clearVisualModel({ cacheStorage }), true);
  assert.equal(await visualModelStored({ cacheStorage }), false);
});

test('a previously downloaded DINO model migrates without touching foreign cache rows', async () => {
  const cacheStorage = memoryCacheStorage();
  const legacy = await cacheStorage.open('transformers-cache');
  const modelUrl = 'https://huggingface.co/Xenova/dinov2-small/resolve/main/onnx/model_q4.onnx';
  const foreignUrl = 'https://huggingface.co/another/model/config.json';
  await legacy.put(modelUrl, new Response('model'));
  await legacy.put(foreignUrl, new Response('foreign'));

  assert.equal(await migrateLegacyVisualModel({ cacheStorage }), true);
  assert.equal(await visualModelStored({ cacheStorage }), true);
  assert.equal(await legacy.match(modelUrl), undefined);
  assert.ok(await legacy.match(foreignUrl));
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
