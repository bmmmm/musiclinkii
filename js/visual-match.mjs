// SPDX-License-Identifier: GPL-3.0-or-later
// Optional visual reranking for OCR candidates. The selected image is exposed
// to the local model through a blob: URL and is never passed to fetch(). Only
// public catalog thumbnails are downloaded for comparison.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const MODEL = 'Xenova/dinov2-small';
const DTYPE = 'q4';
const MAX_CANDIDATES = 5;
const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
const OCR_WEIGHT = 0.3;
const VISUAL_WEIGHT = 0.7;

let extractorPromise;

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

async function loadExtractor(onProgress) {
  if (!extractorPromise) {
    extractorPromise = import(TRANSFORMERS_URL).then(async ({ env, pipeline }) => {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      return pipeline('image-feature-extraction', MODEL, {
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
    }).catch((error) => {
      extractorPromise = null;
      throw error;
    });
  }
  return extractorPromise;
}

async function vectorFromBlob(blob, extractor) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    return modelVector(await extractor(objectUrl));
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
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
  fetcher = globalThis.fetch,
  onProgress = () => {},
} = {}) {
  if (!(imageBlob instanceof Blob) || !imageBlob.type.startsWith('image/')) {
    throw new Error('A selected image is required for visual comparison');
  }
  if (!canRerankVisually(candidates)) throw new Error('Visual comparison requires two to five candidates with artwork');
  if (typeof fetcher !== 'function') throw new Error('A fetch implementation is required');

  const visualExtractor = extractor || await loadExtractor(onProgress);
  onProgress({ stage: 'query', current: 0, total: candidates.length });
  const queryVector = await vectorFromBlob(imageBlob, visualExtractor);
  const candidateVectors = [];
  for (let index = 0; index < candidates.length; index += 1) {
    onProgress({ stage: 'reference', current: index + 1, total: candidates.length });
    const blob = await referenceBlob(candidates[index].thumb, fetcher);
    candidateVectors.push(await vectorFromBlob(blob, visualExtractor));
  }
  return rankVisualCandidates(candidates, queryVector, candidateVectors);
}
