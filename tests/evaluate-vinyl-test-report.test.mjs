// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildReport, encodeVector, mergeCandidates } from '../vinyl-test/report.mjs';
import { evaluateReport, renderSummary, writeHeldOut } from '../scripts/evaluate-vinyl-test-report.mjs';

const run = promisify(execFile);
const SCRIPT = new URL('../scripts/evaluate-vinyl-test-report.mjs', import.meta.url);

const ocr = [
  { id: 1, artist: 'Dire Straits', title: 'Brothers in Arms', thumb: 'https://cdn.example/1.jpg', link: 'https://deezer.example/1', score: 0.71, queryRank: 0 },
  { id: 2, artist: 'Dire Straits', title: 'Making Movies', thumb: 'https://cdn.example/2.jpg', link: 'https://deezer.example/2', score: 0.55, queryRank: 0 },
  { id: 3, artist: 'Dire Straits', title: 'Love Over Gold', thumb: 'https://cdn.example/3.jpg', link: 'https://deezer.example/3', score: 0.41, queryRank: 1 },
];
const catalog = [
  { id: 'mb-x', artist: 'Someone', title: 'Else', thumb: 'https://caa.example/x.jpg', score: 0.5, visualScore: 0.5, source: 'visual-index' },
  { id: 'mb-1', artist: 'Dire Straits', title: 'Brothers in Arms', thumb: 'https://caa.example/1.jpg', score: 0.45, visualScore: 0.45, source: 'visual-index' },
];
const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const image = { buffer: jpegBytes.buffer, type: 'image/jpeg', width: 480, height: 640, originalBytes: 3000000, originalType: 'image/jpeg', originalWidth: 3024, originalHeight: 4032, orientationSource: 'bitmap' };
const vector = () => encodeVector(Float32Array.from({ length: 384 }, (_, index) => Math.sin(index)), { embedMs: 800 });

function fixtureReport() {
  return buildReport({
    createdAt: '2026-09-06T18:30:00.000Z',
    device: { userAgent: 'TestAgent/1', platform: 'iPhone', language: 'de-DE', screenWidth: 393, screenHeight: 852, devicePixelRatio: 3, hardwareConcurrency: 6, deviceMemory: null },
    model: { key: 'small', repository: 'Xenova/dinov2-small', dtype: 'q4', dimension: 384, bytes: 15035808, wasCached: false, loadMs: 4210 },
    catalog: { manifestUrl: 'https://example.test/assets/vinyl-index/manifest.json', model: 'Xenova/dinov2-small', dimension: 384, releaseCount: 12, generatedAt: '2026-09-03T23:20:31.402Z' },
    entries: [
      {
        id: 'e-1', capturedAt: '2026-09-06T18:20:00.000Z', source: 'camera', image,
        ocr: { text: 'DIRE STRAITS\nBROTHERS IN ARMS', confidence: 70 }, queries: ['DIRE STRAITS BROTHERS IN ARMS'],
        candidates: mergeCandidates({ ocr, catalog }), vector: vector(),
        timings: { downscaleMs: 90, ocrMs: 6000, searchMs: 600, embedMs: 800, catalogMs: 200, totalMs: 7690 },
        truth: { chosenIndex: 0, tags: ['Glanz'] }, errors: [],
      },
      {
        id: 'e-2', capturedAt: '2026-09-06T18:22:00.000Z', source: 'camera', image,
        ocr: { text: 'DIRE STRAITS', confidence: 55 }, queries: ['DIRE STRAITS'],
        candidates: mergeCandidates({ ocr, reranked: [
          { ...ocr[2], ocrScore: 0.41, visualScore: 0.9, score: 0.75 },
          { ...ocr[0], ocrScore: 0.71, visualScore: 0.4, score: 0.49 },
          { ...ocr[1], ocrScore: 0.55, visualScore: 0.3, score: 0.38 },
        ], catalog: [] }),
        vector: vector(),
        timings: { downscaleMs: 110, ocrMs: 7000, searchMs: 700, embedMs: 900, rerankMs: 3900, catalogMs: 210, totalMs: 12820 },
        truth: { chosenIndex: 0, tags: ['schräg'] }, errors: [],
      },
      {
        id: 'e-3', capturedAt: '2026-09-06T18:24:00.000Z', source: 'file', image: null,
        ocr: { text: '', confidence: 0, error: 'The OCR library could not be downloaded.' }, queries: [], candidates: [], vector: null,
        timings: { downscaleMs: null, ocrMs: 300, totalMs: 400 },
        truth: { none: true, artist: 'Kraftwerk', title: 'Autobahn', catalogNumber: '1C 062-82 076', tags: ['Glanz', 'in Folie'], note: 'Folie spiegelt' },
        errors: [{ stage: 'downscale', message: 'decode failed' }, { stage: 'ocr', message: 'The OCR library could not be downloaded.' }],
      },
    ],
  });
}

test('evaluateReport scores OCR, the final order and the index per entry', () => {
  const summary = evaluateReport(fixtureReport());
  assert.equal(summary.entryCount, 3);
  assert.deepEqual(summary.recall.ocr.at1, { hits: 1, total: 3, rate: 1 / 3 });
  assert.deepEqual(summary.recall.ocr.at3, { hits: 2, total: 3, rate: 2 / 3 });
  assert.deepEqual(summary.recall.final.at1, { hits: 2, total: 3, rate: 2 / 3 });
  assert.deepEqual(summary.recall['visual-index'].at1, { hits: 0, total: 3, rate: 0 });
  assert.deepEqual(summary.recall['visual-index'].at3, { hits: 1, total: 3, rate: 1 / 3 });
  assert.equal(summary.recall['visual-index'].withCandidates, 1);
  assert.equal(summary.rerankedCount, 1);
  assert.equal(summary.ocrEmptyCount, 1);
  assert.equal(summary.noneCount, 1);
  assert.deepEqual(summary.errorStages, { downscale: 1, ocr: 1 });
  assert.equal(summary.timings.ocrMs.median, 6000);
  assert.equal(summary.timings.ocrMs.p90, 7000);
  assert.equal(summary.timings.downscaleMs.count, 2);
  assert.deepEqual(summary.failures.map((row) => row.id), ['e-3']);
  assert.deepEqual(summary.tags, [
    { tag: 'Glanz', total: 2, failed: 1 },
    { tag: 'in Folie', total: 1, failed: 1 },
    { tag: 'schräg', total: 1, failed: 0 },
  ]);
});

test('the markdown summary carries every section and the entries to look at', () => {
  const report = fixtureReport();
  const markdown = renderSummary(report, evaluateReport(report), 'fixture');
  for (const heading of ['# Vinyl test report: fixture', '## Recall', '## Timings (ms)', '## Situations', '## Entries to look at']) {
    assert.ok(markdown.includes(`\n${heading}\n`) || markdown.startsWith(`${heading}\n`), `missing ${heading}`);
  }
  assert.match(markdown, /\| Text \(OCR order\) \| 1\/3 \(33 %\) \| 2\/3 \(67 %\) \| 2\/3 \(67 %\) \| 2 \|/);
  assert.match(markdown, /\| ocrMs \| 3 \| 6000 \| 7000 \|/);
  assert.match(markdown, /\| Glanz \| 2 \| 1 \|/);
  assert.match(markdown, /- `e-3` — Kraftwerk — Autobahn · ranks ocr –, final –, visual-index – · none of these · empty OCR · Glanz, in Folie · note: Folie spiegelt · downscale: decode failed/);
});

test('the script writes the summary next to the input and a held-out set on request', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vinyl-test-'));
  const input = path.join(directory, 'musiclinkii-vinyl-test-2026-09-06.json');
  await writeFile(input, JSON.stringify(fixtureReport()));
  const heldout = path.join(directory, 'heldout');
  const { stdout } = await run(process.execPath, [SCRIPT.pathname, '--input', input, '--heldout', heldout]);
  assert.match(stdout, /Wrote .*musiclinkii-vinyl-test-2026-09-06\.summary\.md \(3 entries, 1 to look at\)/);
  assert.match(stdout, /Wrote 2 held-out photos/);
  const summary = await readFile(path.join(directory, 'musiclinkii-vinyl-test-2026-09-06.summary.md'), 'utf8');
  assert.match(summary, /^# Vinyl test report: musiclinkii-vinyl-test-2026-09-06\n/);
  const index = JSON.parse(await readFile(path.join(heldout, 'index.json'), 'utf8'));
  assert.equal(index.count, 2);
  assert.equal(index.size, 640);
  assert.deepEqual(index.rows.map((row) => row.original), ['photos/e-1.jpg', 'photos/e-2.jpg']);
  assert.deepEqual(Object.keys(index.rows[0]), ['name', 'original', 'artist', 'title', 'catalogNumber', 'musicBrainzReleaseId', 'none', 'tags', 'vectorBase64']);
  assert.equal(index.rows[0].artist, 'Dire Straits');
  assert.equal(index.rows[0].vectorBase64.length, 512);
  const photo = await readFile(path.join(heldout, 'photos', 'e-1.jpg'));
  assert.deepEqual([...photo], [...jpegBytes]);
  await assert.rejects(stat(path.join(heldout, 'photos', 'e-3.jpg')));
});

test('writeHeldOut rejects a non-base64 image', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vinyl-heldout-'));
  const report = fixtureReport();
  report.entries[0].image.dataUrl = 'blob:nope';
  await assert.rejects(writeHeldOut(report, directory), /base64 data URL/);
});

test('a report cannot write photos outside the held-out directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vinyl-heldout-'));
  const heldout = path.join(directory, 'heldout');
  const report = fixtureReport();
  report.entries[0].id = '../../escape';
  await assert.rejects(writeHeldOut(report, heldout), /unsafe/);
  await assert.rejects(stat(path.join(directory, 'escape.jpg')));
  await assert.rejects(stat(path.join(directory, 'escape.jpg.partial')));
  const input = path.join(directory, 'report.json');
  await writeFile(input, JSON.stringify(report));
  await assert.rejects(run(process.execPath, [SCRIPT.pathname, '--input', input, '--heldout', heldout]), /unsafe/);
});

test('an invalid report is rejected with the entry id', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vinyl-test-bad-'));
  const input = path.join(directory, 'bad.json');
  const report = fixtureReport();
  report.entries[1].truth.title = '';
  await writeFile(input, JSON.stringify(report));
  await assert.rejects(run(process.execPath, [SCRIPT.pathname, '--input', input]), /Entry e-2 has no truth artist and title/);
});
