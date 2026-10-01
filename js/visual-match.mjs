// SPDX-License-Identifier: GPL-3.0-or-later
// Optional visual reranking for OCR candidates. The selected image is exposed
// to the local model through a blob: URL and is never passed to fetch(). Only
// public catalog thumbnails are downloaded for comparison.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
export const VISUAL_MODELS = Object.freeze({
  small: Object.freeze({
    key: 'small', name: 'DINOv2 Small', repository: 'Xenova/dinov2-small',
    variant: 'q4 ONNX', dimensions: 384, bytes: 15035808,
    url: 'https://huggingface.co/Xenova/dinov2-small',
  }),
  base: Object.freeze({
    key: 'base', name: 'DINOv2 Base', repository: 'Xenova/dinov2-base',
    variant: 'q4 ONNX', dimensions: 768, bytes: 56429520,
    url: 'https://huggingface.co/Xenova/dinov2-base',
  }),
  large: Object.freeze({
    key: 'large', name: 'DINOv2 Large', repository: 'Xenova/dinov2-large',
    variant: 'q4 ONNX', dimensions: 1024, bytes: 194059408,
    url: 'https://huggingface.co/Xenova/dinov2-large',
  }),
});
export const DEFAULT_VISUAL_MODEL = 'base';
export const VISUAL_MODEL = VISUAL_MODELS.small;
export const VISUAL_MODEL_CACHE = 'musiclinkii-visual-model-v1';
const LEGACY_MODEL_CACHE = 'transformers-cache';
const MODEL_URL_FRAGMENT = '/Xenova/dinov2-small/';
const MODEL_READY_URL = new URL('../.musiclinkii-visual-model-ready-v1', import.meta.url);
MODEL_READY_URL.search = '';
const DTYPE = 'q4';
const MAX_CANDIDATES = 5;
const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
const OCR_WEIGHT = 0.3;
const VISUAL_WEIGHT = 0.7;

const extractorPromises = new Map();

function selectedModel(modelKey) {
  const model = VISUAL_MODELS[modelKey];
  if (!model) throw new Error(`Unknown visual model: ${modelKey}`);
  return model;
}

export function visualModelCache(modelKey = 'small') {
  selectedModel(modelKey);
  return modelKey === 'small' ? VISUAL_MODEL_CACHE : `${VISUAL_MODEL_CACHE}-${modelKey}`;
}

export async function visualModelStored({ modelKey = 'small', cacheStorage = globalThis.caches } = {}) {
  const cacheName = visualModelCache(modelKey);
  if (!cacheStorage || !await cacheStorage.has(cacheName)) return false;
  const cache = await cacheStorage.open(cacheName);
  return Boolean(await cache.match(MODEL_READY_URL.href));
}

export async function markVisualModelStored({ modelKey = 'small', cacheStorage = globalThis.caches } = {}) {
  if (!cacheStorage) return false;
  const cache = await cacheStorage.open(visualModelCache(modelKey));
  await cache.put(MODEL_READY_URL.href, new Response('ready', {
    headers: { 'Content-Type': 'text/plain' },
  }));
  return true;
}

const requestUrl = (request) => request?.url || String(request);

async function legacyModelRequests(cacheStorage) {
  if (!cacheStorage || !await cacheStorage.has(LEGACY_MODEL_CACHE)) return [];
  const cache = await cacheStorage.open(LEGACY_MODEL_CACHE);
  return (await cache.keys()).filter((request) => requestUrl(request).includes(MODEL_URL_FRAGMENT));
}

export async function migrateLegacyVisualModel({ cacheStorage = globalThis.caches } = {}) {
  if (!cacheStorage || await visualModelStored({ cacheStorage })) return false;
  const requests = await legacyModelRequests(cacheStorage);
  if (!requests.some((request) => /\.onnx(?:$|\?)/.test(requestUrl(request)))) return false;

  const legacy = await cacheStorage.open(LEGACY_MODEL_CACHE);
  const target = await cacheStorage.open(VISUAL_MODEL_CACHE);
  for (const request of requests) {
    const response = await legacy.match(request);
    if (response) await target.put(request, response.clone?.() || response);
  }
  await markVisualModelStored({ cacheStorage });
  for (const request of requests) await legacy.delete(request);
  return true;
}

export async function clearVisualModel({ modelKey = 'small', cacheStorage = globalThis.caches } = {}) {
  selectedModel(modelKey);
  const currentExtractor = extractorPromises.get(modelKey);
  extractorPromises.delete(modelKey);
  if (currentExtractor) {
    try {
      const extractor = await currentExtractor;
      await extractor.dispose?.();
    } catch { /* a failed model load has nothing left to dispose */ }
  }
  if (!cacheStorage) return false;
  let removed = await cacheStorage.delete(visualModelCache(modelKey));
  if (modelKey === 'small' && await cacheStorage.has(LEGACY_MODEL_CACHE)) {
    const legacy = await cacheStorage.open(LEGACY_MODEL_CACHE);
    for (const request of await legacyModelRequests(cacheStorage)) {
      removed = await legacy.delete(request) || removed;
    }
  }
  return removed;
}

export function canRerankVisually(candidates) {
  return Array.isArray(candidates) && candidates.length >= 2 &&
    candidates.length <= MAX_CANDIDATES && candidates.every((candidate) => Boolean(candidate?.thumb));
}

export function cosineSimilarity(left, right) {
  if (!left?.length || left.length !== right?.length) throw new Error('Vector dimensions must match');
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Vector values must be finite');
    dot += a * b;
    leftSquared += a * a;
    rightSquared += b * b;
  }
  if (!leftSquared || !rightSquared) throw new Error('Vectors must have non-zero length');
  return dot / Math.sqrt(leftSquared * rightSquared);
}

export function rankVisualCandidates(candidates, queryVector, candidateVectors) {
  if (candidates.length !== candidateVectors.length) throw new Error('Every candidate needs one visual vector');
  return candidates.map((candidate, index) => {
    const ocrScore = Math.max(0, Math.min(1, Number(candidate.score) || 0));
    const visualScore = Math.max(0, Math.min(1, cosineSimilarity(queryVector, candidateVectors[index])));
    return {
      ...candidate,
      ocrScore,
      visualScore,
      score: ocrScore * OCR_WEIGHT + visualScore * VISUAL_WEIGHT,
    };
  }).sort((left, right) => right.score - left.score ||
    (left.queryRank ?? Infinity) - (right.queryRank ?? Infinity));
}

function modelVector(output) {
  const tensor = output?.last_hidden_state || output;
  const dimension = tensor?.dims?.at(-1);
  if (!dimension || !tensor?.data || tensor.data.length < dimension) {
    throw new Error('The visual model returned an unexpected tensor');
  }
  // DINOv2 returns [batch, tokens, hidden]. The first token is its global CLS
  // representation; pooled [batch, hidden] output has the same first slice.
  return Float32Array.from(tensor.data.subarray(0, dimension));
}

async function loadExtractor(modelKey, onProgress) {
  const model = selectedModel(modelKey);
  if (!extractorPromises.has(modelKey)) {
    const loading = import(TRANSFORMERS_URL).then(async ({ env, pipeline }) => {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      env.cacheKey = visualModelCache(modelKey);
      const extractor = await pipeline('image-feature-extraction', model.repository, {
        dtype: DTYPE,
        progress_callback: (progress) => {
          if (progress.status === 'progress' && progress.file) {
            onProgress({
              stage: 'model',
              file: progress.file,
              percent: Math.round(progress.progress || 0),
            });
          }
        },
      });
      await markVisualModelStored({ modelKey }).catch(() => false);
      return extractor;
    }).catch((error) => {
      extractorPromises.delete(modelKey);
      throw error;
    });
    extractorPromises.set(modelKey, loading);
  }
  const extractor = await extractorPromises.get(modelKey);
  onProgress({ stage: 'model-ready' });
  return extractor;
}

export async function prepareVisualModel({ modelKey = DEFAULT_VISUAL_MODEL, onProgress = () => {} } = {}) {
  await loadExtractor(modelKey, onProgress);
}

async function vectorFromBlob(blob, extractor) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    return modelVector(await extractor(objectUrl));
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function embedVinylCover(imageBlob, {
  extractor,
  modelKey = DEFAULT_VISUAL_MODEL,
  onProgress = () => {},
} = {}) {
  if (!(imageBlob instanceof Blob) || !imageBlob.type.startsWith('image/')) {
    throw new Error('A selected image is required for visual comparison');
  }
  const visualExtractor = extractor || await loadExtractor(modelKey, onProgress);
  onProgress({ stage: 'query' });
  return vectorFromBlob(imageBlob, visualExtractor);
}

async function referenceBlob(url, fetcher) {
  const response = await fetcher(url, {
    method: 'GET',
    cache: 'force-cache',
    referrerPolicy: 'no-referrer',
  });
  if (!response?.ok) throw new Error(`Catalog artwork request failed with HTTP ${response?.status ?? 'unknown'}`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('Catalog artwork response is not an image');
  if (!blob.size || blob.size > MAX_REFERENCE_BYTES) throw new Error('Catalog artwork has an invalid size');
  return blob;
}

export async function rerankVinylCandidates(imageBlob, candidates, {
  extractor,
  modelKey = DEFAULT_VISUAL_MODEL,
  fetcher = globalThis.fetch,
  onProgress = () => {},
} = {}) {
  if (!canRerankVisually(candidates)) throw new Error('Visual comparison requires two to five candidates with artwork');
  if (typeof fetcher !== 'function') throw new Error('A fetch implementation is required');

  const visualExtractor = extractor || await loadExtractor(modelKey, onProgress);
  const queryVector = await embedVinylCover(imageBlob, { extractor: visualExtractor, modelKey, onProgress });
  const candidateVectors = [];
  for (let index = 0; index < candidates.length; index += 1) {
    onProgress({ stage: 'reference', current: index + 1, total: candidates.length });
    const blob = await referenceBlob(candidates[index].thumb, fetcher);
    candidateVectors.push(await vectorFromBlob(blob, visualExtractor));
  }
  return rankVisualCandidates(candidates, queryVector, candidateVectors);
}
