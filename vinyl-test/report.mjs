// SPDX-License-Identifier: GPL-3.0-or-later
// Report model of the unlisted vinyl test page (vinyl-test/). Pure functions
// shared by the page, the offline evaluator and the tests: no DOM, no
// network. Photos and vectors stay in the browser until the person shares
// the assembled report.

import { normalizeVector, quantizeUnitVector } from '../js/vector-index.mjs';

export const SCHEMA_VERSION = 1;
export const PAGE_VERSION = 1;
export const VECTOR_QUANTIZATION = 'symmetric-int8-unit-vector';
export const TIMING_KEYS = Object.freeze([
  'downscaleMs', 'ocrMs', 'searchMs', 'embedMs', 'rerankMs', 'catalogMs', 'totalMs',
]);
// 'ocr' is the text-only order, 'final' the order the person saw (image
// rerank where it ran, OCR order otherwise), 'visual-index' the local index.
export const SOURCES = Object.freeze(['ocr', 'final', 'visual-index']);
export const RECALL_CUTOFFS = Object.freeze([1, 3, 5]);
// German because the page is; these are recorded verbatim in the report.
export const SITUATION_TAGS = Object.freeze([
  'Glanz', 'schräg', 'in Folie', 'Aufkleber', 'wenig Licht',
  'Preisschild', 'abgenutzt', 'Klappcover', 'Reflexion', 'unscharf',
]);
const BASE64_CHUNK = 0x8000;
const FAILURE_CUTOFF = 5;
// Entry ids become file names in the held-out export; a report is untrusted
// input by the time it reaches the evaluator.
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSafeEntryId(id) {
  return typeof id === 'string' && ENTRY_ID.test(id);
}

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const text = (value) => (value == null ? '' : String(value));

export function normalizeText(value) {
  return text(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const textKey = (record) => `${normalizeText(record?.artist)}|${normalizeText(record?.title)}`;

// btoa() over one string of the whole payload; the naive per-byte
// concatenation in benchmarks/vinyl/runner.mjs is fine for 384 bytes but
// not for 70 KB photos, so this walks the buffer in 32 KiB pieces.
export function bytesToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(text(base64));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// Same encoding as the index shards: unit vector, symmetric Int8. A later
// index can be scored against these photos without re-embedding them.
export function encodeVector(values, { embedMs = null } = {}) {
  const quantized = quantizeUnitVector(normalizeVector(values));
  return {
    base64: bytesToBase64(new Uint8Array(quantized.buffer, quantized.byteOffset, quantized.byteLength)),
    dimension: quantized.length,
    quantization: VECTOR_QUANTIZATION,
    embedMs: finiteOrNull(embedMs),
  };
}

export function decodeVector(vector) {
  if (vector?.quantization !== VECTOR_QUANTIZATION) throw new Error('Unsupported vector quantization');
  const bytes = base64ToBytes(vector.base64);
  if (bytes.length !== vector.dimension) throw new Error('Vector payload does not match its dimension');
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

function candidateRecord(candidate, source) {
  const id = text(candidate?.id);
  return {
    source,
    rank: null,
    ocrRank: null,
    reranked: false,
    id,
    artist: text(candidate?.artist),
    title: text(candidate?.title),
    thumb: text(candidate?.thumb),
    link: text(candidate?.link) || (source === 'visual-index' && id ? `https://musicbrainz.org/release/${id}` : ''),
    ocrScore: finiteOrNull(candidate?.ocrScore ?? (source === 'ocr' ? candidate?.score : null)),
    visualScore: finiteOrNull(candidate?.visualScore),
    score: finiteOrNull(candidate?.score),
    queryRank: Number.isInteger(candidate?.queryRank) ? candidate.queryRank : null,
    date: text(candidate?.date),
    country: text(candidate?.country),
  };
}

const sameAlbum = (left, right) => (left.id && left.id === right.id) || textKey(left) === textKey(right);

// One flat tile list: text candidates first (in the order the person saw
// them), then index candidates. ocrRank keeps the text-only position so the
// evaluator can score the rerank against plain OCR from the same report.
export function mergeCandidates({ ocr = [], reranked = null, catalog = [] } = {}) {
  const seen = new Set();
  const merged = [];
  const ranks = new Map();
  const add = (candidates, source, decorate) => {
    for (const candidate of candidates || []) {
      const record = candidateRecord(candidate, source);
      const key = `${source}:${record.id || textKey(record)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rank = (ranks.get(source) || 0) + 1;
      ranks.set(source, rank);
      record.rank = rank;
      decorate(record);
      merged.push(record);
    }
  };
  const textOrder = Array.isArray(reranked) && reranked.length ? reranked : ocr;
  const isReranked = textOrder !== ocr;
  const plain = (ocr || []).map((candidate) => candidateRecord(candidate, 'ocr'));
  const decorateText = (record) => {
    record.reranked = isReranked;
    const position = plain.findIndex((candidate) => sameAlbum(candidate, record));
    record.ocrRank = position === -1 ? record.rank : position + 1;
  };
  add(textOrder, 'ocr', decorateText);
  // A rerank that returned fewer rows must not hide OCR candidates.
  if (isReranked) add(ocr, 'ocr', decorateText);
  add(catalog, 'visual-index', () => {});
  return merged;
}

function imageRecord(image) {
  if (!image) return null;
  const buffer = image.buffer ?? null;
  const dataUrl = image.dataUrl ||
    (buffer ? `data:${image.type || 'image/jpeg'};base64,${bytesToBase64(buffer)}` : null);
  if (!dataUrl) return null;
  return {
    dataUrl,
    width: finiteOrNull(image.width),
    height: finiteOrNull(image.height),
    bytes: finiteOrNull(image.bytes ?? buffer?.byteLength),
    originalBytes: finiteOrNull(image.originalBytes),
    originalType: text(image.originalType),
    originalWidth: finiteOrNull(image.originalWidth),
    originalHeight: finiteOrNull(image.originalHeight),
    pipelineInput: text(image.pipelineInput) || 'original',
    orientationSource: text(image.orientationSource) || null,
  };
}

const lineCount = (value) => text(value).split(/\r?\n/).filter((line) => line.trim()).length;

export function normalizeEntry(entry) {
  if (!entry?.id) throw new Error('Entry needs an id');
  const candidates = (entry.candidates || []).map((candidate) => ({
    ...candidateRecord(candidate, candidate?.source === 'visual-index' ? 'visual-index' : 'ocr'),
    rank: Number.isInteger(candidate?.rank) ? candidate.rank : null,
    ocrRank: Number.isInteger(candidate?.ocrRank) ? candidate.ocrRank : null,
    reranked: Boolean(candidate?.reranked),
  }));
  const rawTruth = entry.truth || {};
  const truth = {
    chosenIndex: Number.isInteger(rawTruth.chosenIndex) ? rawTruth.chosenIndex : null,
    chosenSource: null,
    chosenId: null,
    none: Boolean(rawTruth.none),
    artist: text(rawTruth.artist).trim(),
    title: text(rawTruth.title).trim(),
    catalogNumber: text(rawTruth.catalogNumber).trim(),
    tags: [...new Set((rawTruth.tags || []).map((tag) => text(tag).trim()).filter(Boolean))],
    note: text(rawTruth.note).trim(),
  };
  const chosen = !truth.none && truth.chosenIndex !== null ? candidates[truth.chosenIndex] : null;
  if (chosen) {
    // The evaluator scores every source by text, so the chosen tile's
    // artist and title become the truth text as well.
    truth.chosenSource = chosen.source;
    truth.chosenId = chosen.id;
    truth.artist = chosen.artist;
    truth.title = chosen.title;
  } else {
    truth.chosenIndex = null;
  }
  const ocr = entry.ocr || {};
  const ocrText = text(ocr.text);
  const vector = entry.vector?.base64 ? {
    base64: entry.vector.base64,
    dimension: finiteOrNull(entry.vector.dimension),
    quantization: text(entry.vector.quantization) || VECTOR_QUANTIZATION,
    embedMs: finiteOrNull(entry.vector.embedMs ?? entry.timings?.embedMs),
  } : null;
  return {
    id: text(entry.id),
    capturedAt: text(entry.capturedAt),
    source: text(entry.source) || 'file',
    image: imageRecord(entry.image),
    ocr: {
      text: ocrText,
      confidence: finiteOrNull(ocr.confidence),
      lineCount: Number.isInteger(ocr.lineCount) ? ocr.lineCount : lineCount(ocrText),
      error: ocr.error ? text(ocr.error) : null,
    },
    queries: (entry.queries || []).map(text).filter(Boolean),
    candidates,
    candidateCounts: {
      ocr: candidates.filter((candidate) => candidate.source === 'ocr').length,
      reranked: candidates.filter((candidate) => candidate.source === 'ocr' && candidate.reranked).length,
      catalog: candidates.filter((candidate) => candidate.source === 'visual-index').length,
    },
    vector,
    timings: Object.fromEntries(TIMING_KEYS.map((key) => [key, finiteOrNull(entry.timings?.[key])])),
    truth,
    errors: (entry.errors || []).map((error) => ({
      stage: text(error?.stage) || 'unknown',
      message: text(error?.message ?? error),
    })),
  };
}

export function buildReport({
  device = null,
  model = null,
  catalog = null,
  entries = [],
  createdAt = new Date().toISOString(),
  pageVersion = PAGE_VERSION,
} = {}) {
  const normalized = entries.map(normalizeEntry)
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.id.localeCompare(right.id));
  return {
    schemaVersion: SCHEMA_VERSION,
    pageVersion,
    createdAt,
    device,
    model,
    catalog,
    entryCount: normalized.length,
    entries: normalized,
  };
}

export function validateReport(report) {
  if (report?.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported report schema: ${report?.schemaVersion}`);
  if (!Number.isInteger(report.pageVersion)) throw new Error('Report is missing an integer pageVersion');
  if (!Array.isArray(report.entries) || !report.entries.length) throw new Error('Report has no entries');
  for (const entry of report.entries) {
    if (!isSafeEntryId(entry?.id)) throw new Error(`Entry id is missing or unsafe: ${JSON.stringify(entry?.id ?? null)}`);
    if (!entry.truth?.artist || !entry.truth?.title) throw new Error(`Entry ${entry.id} has no truth artist and title`);
    if (!entry.timings || typeof entry.timings !== 'object') throw new Error(`Entry ${entry.id} has no timings`);
  }
  return report;
}

export function reportFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `musiclinkii-vinyl-test-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

const byRank = (key) => (left, right) => left[key] - right[key];

function sourceCandidates(entry, source) {
  const all = entry?.candidates || [];
  if (source === 'visual-index') {
    return all.filter((candidate) => candidate.source === 'visual-index' && Number.isInteger(candidate.rank)).sort(byRank('rank'));
  }
  const textual = all.filter((candidate) => candidate.source === 'ocr');
  if (source === 'final') return textual.filter((candidate) => Number.isInteger(candidate.rank)).sort(byRank('rank'));
  if (source === 'ocr') return textual.filter((candidate) => Number.isInteger(candidate.ocrRank)).sort(byRank('ocrRank'));
  throw new Error(`Unknown source: ${source}`);
}

// 1-based position of the truth among one source's candidates, null when it
// is absent. "None of these" is a miss for every source by definition.
export function truthRank(entry, source) {
  const truth = entry?.truth;
  if (!truth || truth.none) return null;
  const candidates = sourceCandidates(entry, source);
  const chosenSource = source === 'visual-index' ? 'visual-index' : 'ocr';
  const byId = truth.chosenId && truth.chosenSource === chosenSource ? text(truth.chosenId) : null;
  const wanted = textKey(truth);
  // The tapped tile wins over a text twin (two pressings of one release).
  const match = (byId !== null ? candidates.find((candidate) => candidate.id === byId) : null) ||
    (wanted !== '|' ? candidates.find((candidate) => textKey(candidate) === wanted) : null);
  if (!match) return null;
  return source === 'ocr' ? match.ocrRank : match.rank;
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Nearest-rank percentile: the smallest value at or above the fraction.
export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[position - 1];
}

const ratio = (hits, total) => ({ hits, total, rate: total ? hits / total : null });

export function summarize(entries) {
  const rows = entries.map((entry) => {
    const ranks = Object.fromEntries(SOURCES.map((source) => [source, truthRank(entry, source)]));
    return {
      id: entry.id,
      artist: entry.truth?.artist || '',
      title: entry.truth?.title || '',
      none: Boolean(entry.truth?.none),
      tags: entry.truth?.tags || [],
      note: entry.truth?.note || '',
      ocrEmpty: !text(entry.ocr?.text).trim(),
      reranked: (entry.candidates || []).some((candidate) => candidate.source === 'ocr' && candidate.reranked),
      errors: entry.errors || [],
      ranks,
      failed: !Object.values(ranks).some((rank) => rank !== null && rank <= FAILURE_CUTOFF),
    };
  });
  const recall = Object.fromEntries(SOURCES.map((source) => [source, {
    withCandidates: entries.filter((entry) => sourceCandidates(entry, source).length).length,
    ...Object.fromEntries(RECALL_CUTOFFS.map((cutoff) => [`at${cutoff}`,
      ratio(rows.filter((row) => row.ranks[source] !== null && row.ranks[source] <= cutoff).length, rows.length)])),
  }]));
  const timings = Object.fromEntries(TIMING_KEYS.map((key) => {
    const values = entries.map((entry) => entry.timings?.[key]).filter(Number.isFinite);
    return [key, { count: values.length, median: median(values), p90: percentile(values, 0.9) }];
  }));
  const tagMap = new Map();
  for (const row of rows) {
    for (const tag of row.tags) {
      const bucket = tagMap.get(tag) || { tag, total: 0, failed: 0 };
      bucket.total += 1;
      if (row.failed) bucket.failed += 1;
      tagMap.set(tag, bucket);
    }
  }
  const errorStages = {};
  for (const row of rows) {
    for (const error of row.errors) errorStages[error.stage] = (errorStages[error.stage] || 0) + 1;
  }
  return {
    entryCount: rows.length,
    noneCount: rows.filter((row) => row.none).length,
    ocrEmptyCount: rows.filter((row) => row.ocrEmpty).length,
    rerankedCount: rows.filter((row) => row.reranked).length,
    errorCount: rows.reduce((sum, row) => sum + row.errors.length, 0),
    errorStages,
    recall,
    timings,
    tags: [...tagMap.values()].sort((left, right) => right.failed - left.failed || right.total - left.total || left.tag.localeCompare(right.tag)),
    failures: rows.filter((row) => row.failed),
    rows,
  };
}
