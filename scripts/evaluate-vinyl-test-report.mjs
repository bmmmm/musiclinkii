#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Offline evaluation of a vinyl-test/ report: recall per source, stage
// timings, failed-tag breakdown, and optionally a held-out set (photos plus
// index.json) the benchmark spike scripts can point at.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  RECALL_CUTOFFS,
  SOURCES,
  TIMING_KEYS,
  isSafeEntryId,
  summarize,
  validateReport,
} from '../vinyl-test/report.mjs';

const HELDOUT_EDGE = 640;

const SOURCE_LABELS = {
  ocr: 'Text (OCR order)',
  final: 'Text, final order (image rerank where it ran)',
  'visual-index': 'Local index',
};

function parseArgs(argv) {
  const options = { input: null, heldout: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--input') options.input = path.resolve(value);
    else if (flag === '--heldout') options.heldout = path.resolve(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.input) throw new Error('--input <report.json> is required');
  return options;
}

async function writeAtomic(destination, body) {
  const partial = `${destination}.partial`;
  await writeFile(partial, body);
  await rename(partial, destination);
}

const percent = (ratio) => (ratio.total ? `${ratio.hits}/${ratio.total} (${Math.round(ratio.rate * 100)} %)` : '–');
const number = (value) => (value === null || value === undefined ? '–' : String(Math.round(value)));
const rankText = (rank) => (rank === null ? '–' : String(rank));
const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function evaluateReport(report) {
  validateReport(report);
  return summarize(report.entries);
}

export function renderSummary(report, summary, sourceName) {
  const lines = [];
  lines.push(`# Vinyl test report: ${sourceName}`, '');
  lines.push(`- Created: ${report.createdAt || '–'}`);
  lines.push(`- Page version: ${report.pageVersion}`);
  if (report.device) {
    lines.push(`- Device: ${cell(report.device.platform)} · ${report.device.screenWidth}×${report.device.screenHeight} @${report.device.devicePixelRatio} · ${cell(report.device.userAgent)}`);
  }
  if (report.model) {
    lines.push(`- Model: ${report.model.repository} (${report.model.dtype}, ${report.model.dimension} d) · cached before: ${report.model.wasCached} · load ${number(report.model.loadMs)} ms`);
  }
  if (report.catalog) {
    lines.push(`- Index: ${report.catalog.releaseCount ?? '–'} covers · generated ${report.catalog.generatedAt || '–'}`);
  }
  lines.push(`- Entries: ${summary.entryCount} · none-of-these: ${summary.noneCount} · empty OCR: ${summary.ocrEmptyCount} · reranked: ${summary.rerankedCount} · stage errors: ${summary.errorCount}`);
  const stages = Object.entries(summary.errorStages).map(([stage, count]) => `${stage} ×${count}`).join(', ');
  if (stages) lines.push(`- Errors by stage: ${stages}`);
  lines.push('');

  lines.push('## Recall', '');
  lines.push(`| Source | ${RECALL_CUTOFFS.map((cutoff) => `Recall@${cutoff}`).join(' | ')} | Entries with candidates |`);
  lines.push(`|---|${RECALL_CUTOFFS.map(() => '---').join('|')}|---|`);
  for (const source of SOURCES) {
    const recall = summary.recall[source];
    lines.push(`| ${SOURCE_LABELS[source]} | ${RECALL_CUTOFFS.map((cutoff) => percent(recall[`at${cutoff}`])).join(' | ')} | ${recall.withCandidates} |`);
  }
  lines.push('');

  lines.push('## Timings (ms)', '');
  lines.push('| Stage | n | Median | p90 |', '|---|---|---|---|');
  for (const key of TIMING_KEYS) {
    const timing = summary.timings[key];
    lines.push(`| ${key} | ${timing.count} | ${number(timing.median)} | ${number(timing.p90)} |`);
  }
  lines.push('', 'rerankMs includes a second query embedding (rerankVinylCandidates embeds the photo itself).', '');

  lines.push('## Situations', '');
  if (summary.tags.length) {
    lines.push('| Tag | Photos | Failed (truth in no top 5) |', '|---|---|---|');
    for (const tag of summary.tags) lines.push(`| ${cell(tag.tag)} | ${tag.total} | ${tag.failed} |`);
  } else {
    lines.push('No situation tags recorded.');
  }
  lines.push('');

  lines.push('## Entries to look at', '');
  if (summary.failures.length) {
    for (const row of summary.failures) {
      const ranks = SOURCES.map((source) => `${source} ${rankText(row.ranks[source])}`).join(', ');
      const details = [
        row.none ? 'none of these' : null,
        row.ocrEmpty ? 'empty OCR' : null,
        row.tags.length ? row.tags.join(', ') : null,
        row.note ? `note: ${row.note}` : null,
        ...row.errors.map((error) => `${error.stage}: ${error.message}`),
      ].filter(Boolean).join(' · ');
      lines.push(`- \`${row.id}\` — ${cell(row.artist)} — ${cell(row.title)} · ranks ${ranks}${details ? ` · ${cell(details)}` : ''}`);
    }
  } else {
    lines.push('Every truth was found in a top 5.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function dataUrlBytes(dataUrl) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!match) throw new Error('Image is not a base64 data URL');
  return Buffer.from(match[2], 'base64');
}

// Held-out set in the row layout of benchmarks/vinyl/spikes/*/data/index.json
// (`name`, `original`; the spike's synthetic `mild`/`hard` variants do not
// exist for real photos) plus the truth and the recorded vector.
export async function writeHeldOut(report, directory) {
  const photos = path.join(directory, 'photos');
  await mkdir(photos, { recursive: true });
  const rows = [];
  for (const entry of report.entries) {
    if (!entry.image?.dataUrl) continue;
    // The id names a file: refuse anything that could leave photos/.
    if (!isSafeEntryId(entry.id)) throw new Error(`Entry id is unsafe for a file name: ${JSON.stringify(entry.id)}`);
    const photo = `photos/${entry.id}.jpg`;
    await writeAtomic(path.join(directory, photo), dataUrlBytes(entry.image.dataUrl));
    rows.push({
      name: entry.id,
      original: photo,
      artist: entry.truth.artist,
      title: entry.truth.title,
      catalogNumber: entry.truth.catalogNumber || null,
      musicBrainzReleaseId: entry.truth.chosenSource === 'visual-index' ? entry.truth.chosenId : null,
      none: Boolean(entry.truth.none),
      tags: entry.truth.tags || [],
      vectorBase64: entry.vector?.base64 || null,
    });
  }
  const index = {
    schemaVersion: 1,
    source: 'vinyl-test-report',
    createdAt: report.createdAt,
    model: report.model?.repository || null,
    dimension: report.model?.dimension || null,
    quantization: report.entries.find((entry) => entry.vector)?.vector.quantization || null,
    size: HELDOUT_EDGE,
    count: rows.length,
    rows,
  };
  await writeAtomic(path.join(directory, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/evaluate-vinyl-test-report.mjs --input <report.json> [--heldout <directory>]\n');
    return;
  }
  const report = JSON.parse(await readFile(options.input, 'utf8'));
  const summary = evaluateReport(report);
  const basename = path.basename(options.input, path.extname(options.input));
  const summaryPath = path.join(path.dirname(options.input), `${basename}.summary.md`);
  await writeAtomic(summaryPath, renderSummary(report, summary, basename));
  process.stdout.write(`Wrote ${summaryPath} (${summary.entryCount} entries, ${summary.failures.length} to look at)\n`);
  if (options.heldout) {
    const index = await writeHeldOut(report, options.heldout);
    process.stdout.write(`Wrote ${index.count} held-out photos to ${options.heldout}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
