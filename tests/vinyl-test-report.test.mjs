// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeQuantizedIndex, encodeQuantizedIndex, normalizeVector } from '../js/vector-index.mjs';
import {
  PAGE_VERSION,
  SCHEMA_VERSION,
  buildReport,
  bytesToBase64,
  base64ToBytes,
  decodeVector,
  encodeVector,
  isSafeEntryId,
  median,
  mergeCandidates,
  normalizeEntry,
  normalizeText,
  percentile,
  reportFilename,
  summarize,
  truthRank,
  validateReport,
} from '../vinyl-test/report.mjs';

const ocrCandidates = [
  { id: 101, artist: 'Dire Straits', title: 'Brothers in Arms', thumb: 'https://cdn.example/101.jpg', link: 'https://deezer.example/101', score: 0.71, queryRank: 0 },
  { id: 102, artist: 'Dire Straits', title: 'Making Movies', thumb: 'https://cdn.example/102.jpg', link: 'https://deezer.example/102', score: 0.55, queryRank: 1 },
  { id: 103, artist: 'Dire Straits', title: 'Love Over Gold', thumb: 'https://cdn.example/103.jpg', link: 'https://deezer.example/103', score: 0.41, queryRank: 1 },
];
const catalogCandidates = [
  { id: 'mb-1', artist: 'Dire Straits', title: 'Brothers in Arms', thumb: 'https://caa.example/mb-1.jpg', score: 0.62, visualScore: 0.62, source: 'visual-index', date: '1985-05-13', country: 'DE' },
  { id: 'mb-2', artist: 'Someone Else', title: 'Other', thumb: 'https://caa.example/mb-2.jpg', score: 0.40, visualScore: 0.40, source: 'visual-index' },
];

function entryWith(overrides = {}) {
  return {
    id: 'e-1',
    capturedAt: '2026-09-06T18:20:03.114Z',
    source: 'camera',
    image: { buffer: Uint8Array.from([255, 216, 255, 217]).buffer, type: 'image/jpeg', width: 480, height: 640, originalBytes: 3120044, originalType: 'image/jpeg', originalWidth: 3024, originalHeight: 4032, orientationSource: 'bitmap' },
    ocr: { text: 'DIRE STRAITS\nBrothers in Arms\n', confidence: 71.4 },
    queries: ['DIRE STRAITS Brothers in Arms'],
    candidates: mergeCandidates({ ocr: ocrCandidates, catalog: catalogCandidates }),
    vector: encodeVector(Float32Array.from({ length: 384 }, (_, index) => Math.sin(index + 1)), { embedMs: 812 }),
    timings: { downscaleMs: 91, ocrMs: 6120, searchMs: 640, embedMs: 812, catalogMs: 210, totalMs: 7873 },
    truth: { chosenIndex: 0, none: false, tags: ['Glanz', 'in Folie', 'Glanz'], note: ' ok ' },
    errors: [],
    ...overrides,
  };
}

test('normalizeText lowercases, strips accents and punctuation', () => {
  assert.equal(normalizeText('  Café — Déjà Vu! '), 'cafe deja vu');
  assert.equal(normalizeText(null), '');
});

test('normalizeEntry copies the chosen tile into the truth text and fills missing timings with null', () => {
  const entry = normalizeEntry(entryWith());
  assert.equal(entry.truth.artist, 'Dire Straits');
  assert.equal(entry.truth.title, 'Brothers in Arms');
  assert.equal(entry.truth.chosenSource, 'ocr');
  assert.equal(entry.truth.chosenId, '101');
  assert.deepEqual(entry.truth.tags, ['Glanz', 'in Folie']);
  assert.equal(entry.truth.note, 'ok');
  assert.equal(entry.timings.rerankMs, null);
  assert.equal(entry.timings.ocrMs, 6120);
  assert.equal(entry.ocr.lineCount, 2);
  assert.equal(entry.ocr.error, null);
  assert.deepEqual(entry.candidateCounts, { ocr: 3, reranked: 0, catalog: 2 });
  assert.match(entry.image.dataUrl, /^data:image\/jpeg;base64,\/9j\/2Q==$/);
  assert.equal(entry.image.bytes, 4);
  assert.equal(entry.image.pipelineInput, 'original');
  assert.equal('buffer' in entry.image, false);
});

test('normalizeEntry keeps typed truth for "none of these" and tolerates a missing image', () => {
  const entry = normalizeEntry(entryWith({
    image: null,
    candidates: [],
    truth: { chosenIndex: 0, none: true, artist: ' Kraftwerk ', title: 'Autobahn', catalogNumber: 'sd 8296' },
    errors: [{ stage: 'ocr', message: 'boom' }, 'plain'],
    ocr: { text: '', error: 'boom' },
  }));
  assert.equal(entry.image, null);
  assert.deepEqual(entry.truth, {
    chosenIndex: null, chosenSource: null, chosenId: null, none: true,
    artist: 'Kraftwerk', title: 'Autobahn', catalogNumber: 'sd 8296', tags: [], note: '',
  });
  assert.deepEqual(entry.errors, [{ stage: 'ocr', message: 'boom' }, { stage: 'unknown', message: 'plain' }]);
  assert.equal(entry.ocr.error, 'boom');
  assert.equal(entry.ocr.lineCount, 0);
});

test('mergeCandidates puts text tiles before index tiles, ranks each source and dedupes on source:id', () => {
  const merged = mergeCandidates({
    ocr: [...ocrCandidates, ocrCandidates[0]],
    catalog: [...catalogCandidates, catalogCandidates[1]],
  });
  assert.deepEqual(merged.map((candidate) => `${candidate.source}:${candidate.id}:${candidate.rank}`), [
    'ocr:101:1', 'ocr:102:2', 'ocr:103:3', 'visual-index:mb-1:1', 'visual-index:mb-2:2',
  ]);
  assert.deepEqual(merged.map((candidate) => candidate.ocrRank), [1, 2, 3, null, null]);
  assert.ok(merged.every((candidate) => candidate.reranked === false));
  assert.equal(merged[0].ocrScore, 0.71);
  assert.equal(merged[0].visualScore, null);
  assert.equal(merged[3].visualScore, 0.62);
  assert.equal(merged[3].ocrScore, null);
  assert.equal(merged[3].link, 'https://musicbrainz.org/release/mb-1');
  assert.equal(merged[3].date, '1985-05-13');
  // The same album may appear once per source: that is what the evaluator compares.
  assert.equal(merged.filter((candidate) => candidate.title === 'Brothers in Arms').length, 2);
});

test('mergeCandidates records the reranked order and remembers the text-only position', () => {
  const reranked = [
    { ...ocrCandidates[2], ocrScore: 0.41, visualScore: 0.9, score: 0.753 },
    { ...ocrCandidates[0], ocrScore: 0.71, visualScore: 0.5, score: 0.563 },
    { ...ocrCandidates[1], ocrScore: 0.55, visualScore: 0.3, score: 0.375 },
  ];
  const merged = mergeCandidates({ ocr: ocrCandidates, reranked, catalog: [] });
  assert.deepEqual(merged.map((candidate) => [candidate.id, candidate.rank, candidate.ocrRank, candidate.reranked]), [
    ['103', 1, 3, true], ['101', 2, 1, true], ['102', 3, 2, true],
  ]);
  assert.equal(merged[0].visualScore, 0.9);
  assert.equal(merged[0].ocrScore, 0.41);
});

test('mergeCandidates keeps OCR candidates a shorter rerank left out', () => {
  const merged = mergeCandidates({ ocr: ocrCandidates.slice(0, 2), reranked: [ocrCandidates[1]], catalog: [] });
  assert.deepEqual(merged.map((candidate) => [candidate.id, candidate.rank, candidate.ocrRank]), [['102', 1, 2], ['101', 2, 1]]);
});

test('normalizeEntry tolerates a null candidate slot', () => {
  const entry = normalizeEntry(entryWith({ candidates: [null, ...ocrCandidates], truth: { chosenIndex: 1 } }));
  assert.equal(entry.candidates[0].id, '');
  assert.equal(entry.truth.title, 'Brothers in Arms');
});

test('vectors round-trip through base64 as the index shards encode them', () => {
  const values = Float32Array.from({ length: 384 }, (_, index) => Math.cos(index / 7) * 3);
  const encoded = encodeVector(values, { embedMs: 812 });
  assert.equal(encoded.dimension, 384);
  assert.equal(encoded.base64.length, 512);
  assert.equal(encoded.quantization, 'symmetric-int8-unit-vector');
  assert.equal(encoded.embedMs, 812);
  const decoded = decodeVector(encoded);
  assert.ok(decoded instanceof Int8Array);
  assert.equal(decoded.length, 384);
  const index = decodeQuantizedIndex(encodeQuantizedIndex([decoded]));
  assert.equal(index.dimension, 384);
  assert.equal(index.count, 1);
  assert.deepEqual([...index.vectors[0]], [...decoded]);
  const unit = normalizeVector(values);
  assert.equal(decoded[0], Math.round(unit[0] * 127));
  assert.equal(decoded[383], Math.round(unit[383] * 127));
  assert.throws(() => decodeVector({ ...encoded, dimension: 12 }), /dimension/);
});

test('bytesToBase64 handles payloads larger than one chunk', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, index) => index % 251);
  const encoded = bytesToBase64(bytes);
  assert.equal(encoded, Buffer.from(bytes).toString('base64'));
  assert.deepEqual([...base64ToBytes(encoded)], [...bytes]);
});

test('buildReport sorts entries, counts them and survives a JSON round-trip unchanged', () => {
  const later = entryWith({ id: 'e-2', capturedAt: '2026-09-06T18:25:00.000Z' });
  const report = buildReport({
    device: { platform: 'iPhone' },
    model: { key: 'small', wasCached: false, loadMs: 4210 },
    catalog: { releaseCount: 12 },
    entries: [later, entryWith()],
    createdAt: '2026-09-06T18:30:00.000Z',
  });
  assert.equal(report.schemaVersion, SCHEMA_VERSION);
  assert.equal(report.pageVersion, PAGE_VERSION);
  assert.equal(report.entryCount, 2);
  assert.deepEqual(report.entries.map((entry) => entry.id), ['e-1', 'e-2']);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.equal(validateReport(report), report);
  assert.throws(() => validateReport({ ...report, entries: [] }), /no entries/);
  assert.throws(() => validateReport({ ...report, entries: [{ ...report.entries[0], truth: { ...report.entries[0].truth, title: '' } }] }), /e-1/);
  assert.throws(() => validateReport({ ...report, entries: [{ ...report.entries[0], id: '../../escape' }] }), /unsafe/);
});

test('entry ids that name files stay inside one directory', () => {
  assert.ok(isSafeEntryId('e-1757181603114-1'));
  for (const bad of ['', '../x', 'a/b', 'a\\b', '.hidden', 'x'.repeat(65), 42, null]) assert.equal(isSafeEntryId(bad), false, String(bad));
});

test('truthRank matches by id for the chosen source and by text for the other', () => {
  const entry = normalizeEntry(entryWith());
  assert.equal(truthRank(entry, 'ocr'), 1);
  assert.equal(truthRank(entry, 'final'), 1);
  assert.equal(truthRank(entry, 'visual-index'), 1);
  const missed = normalizeEntry(entryWith({ truth: { chosenIndex: 4 } }));
  assert.equal(missed.truth.chosenId, 'mb-2');
  assert.equal(truthRank(missed, 'ocr'), null);
  assert.equal(truthRank(missed, 'visual-index'), 2);
  const none = normalizeEntry(entryWith({ truth: { none: true, artist: 'Dire Straits', title: 'Brothers in Arms' } }));
  assert.equal(truthRank(none, 'ocr'), null);
  assert.equal(truthRank(none, 'visual-index'), null);
  const reranked = normalizeEntry(entryWith({
    candidates: mergeCandidates({ ocr: ocrCandidates, reranked: [ocrCandidates[2], ocrCandidates[0], ocrCandidates[1]], catalog: [] }),
    truth: { chosenIndex: 1 },
  }));
  assert.equal(truthRank(reranked, 'ocr'), 1);
  assert.equal(truthRank(reranked, 'final'), 2);
  assert.throws(() => truthRank(reranked, 'bogus'), /Unknown source/);
  // Two pressings with the same text: the tapped tile decides, not the twin above it.
  const twins = normalizeEntry(entryWith({
    candidates: mergeCandidates({ ocr: [], catalog: [catalogCandidates[0], { ...catalogCandidates[0], id: 'mb-1b', date: '1990' }] }),
    truth: { chosenIndex: 1 },
  }));
  assert.equal(twins.truth.chosenId, 'mb-1b');
  assert.equal(truthRank(twins, 'visual-index'), 2);
});

test('median and percentile cover odd and even counts', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9), 90);
  assert.equal(percentile([3, 1, 2], 0.9), 3);
  assert.equal(percentile([7], 0.5), 7);
});

test('summarize computes recall per source, stage timings and the failed-tag breakdown', () => {
  const entries = [
    normalizeEntry(entryWith()),
    normalizeEntry(entryWith({ id: 'e-2', truth: { chosenIndex: 2 }, timings: { ocrMs: 8000, totalMs: 9000 } })),
    normalizeEntry(entryWith({
      id: 'e-3', candidates: [], ocr: { text: '', error: 'no text' }, image: null,
      truth: { none: true, artist: 'X', title: 'Y', tags: ['Glanz', 'unscharf'] },
      errors: [{ stage: 'ocr', message: 'no text' }], timings: { totalMs: 1000 },
    })),
  ];
  const summary = summarize(entries);
  assert.equal(summary.entryCount, 3);
  assert.equal(summary.noneCount, 1);
  assert.equal(summary.ocrEmptyCount, 1);
  assert.equal(summary.errorCount, 1);
  assert.deepEqual(summary.errorStages, { ocr: 1 });
  assert.deepEqual(summary.recall.ocr.at1, { hits: 1, total: 3, rate: 1 / 3 });
  assert.deepEqual(summary.recall.ocr.at3, { hits: 2, total: 3, rate: 2 / 3 });
  assert.equal(summary.recall.ocr.withCandidates, 2);
  assert.deepEqual(summary.recall['visual-index'].at1, { hits: 1, total: 3, rate: 1 / 3 });
  assert.equal(summary.timings.ocrMs.median, 7060);
  assert.equal(summary.timings.ocrMs.p90, 8000);
  assert.equal(summary.timings.ocrMs.count, 2);
  assert.equal(summary.timings.rerankMs.median, null);
  assert.deepEqual(summary.failures.map((row) => row.id), ['e-3']);
  assert.deepEqual(summary.tags, [
    { tag: 'Glanz', total: 2, failed: 1 },
    { tag: 'unscharf', total: 1, failed: 1 },
    { tag: 'in Folie', total: 1, failed: 0 },
  ]);
});

test('reportFilename uses the local calendar date', () => {
  assert.equal(reportFilename(new Date(2026, 8, 6, 23, 59)), 'musiclinkii-vinyl-test-2026-09-06.json');
});
