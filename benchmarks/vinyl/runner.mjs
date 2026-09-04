// SPDX-License-Identifier: GPL-3.0-or-later

import { env, pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
import {
  encodeQuantizedIndex,
  fetchQuantizedIndex,
  normalizeVector,
  quantizeUnitVector,
  rankQuantized,
} from './benchmark-core.mjs';

const MODEL = 'Xenova/dinov2-small';
const DTYPE = 'q4';
const startButton = document.querySelector('#start');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
const metricsBody = document.querySelector('#metrics');
const details = document.querySelector('#details');
const downloads = document.querySelector('#downloads');

env.allowLocalModels = false;
env.useBrowserCache = true;

function setStatus(message) {
  status.textContent = message;
}

function manifestUrl() {
  const requested = new URL(location.href).searchParams.get('manifest');
  return new URL(requested || '../../.cache/vinyl-benchmark/manifest.json', location.href);
}

function coverUrl(release) {
  return new URL(`../../${release.coverPath}`, location.href).href;
}

async function loadManifest() {
  const response = await fetch(manifestUrl());
  if (!response.ok) throw new Error(`Manifest request failed with HTTP ${response.status}`);
  const manifest = await response.json();
  if (manifest.schemaVersion !== 1 || !manifest.releases?.length) throw new Error('Manifest has no benchmark releases');
  const requestedLimit = Number(new URL(location.href).searchParams.get('limit'));
  return {
    ...manifest,
    releases: Number.isInteger(requestedLimit) && requestedLimit > 0
      ? manifest.releases.slice(0, requestedLimit)
      : manifest.releases,
  };
}

function modelVector(output) {
  const tensor = output?.last_hidden_state || output;
  const dimension = tensor?.dims?.at(-1);
  if (!dimension || !tensor?.data || tensor.data.length < dimension) throw new Error('Model returned an unexpected tensor');
  // DINOv2 returns [batch, tokens, hidden]. Its first token is the global CLS
  // representation used here; a future pooled [batch, hidden] output works too.
  return normalizeVector(tensor.data.subarray(0, dimension));
}

async function createVariant(sourceUrl, strength, seed) {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Cover request failed with HTTP ${response.status}`);
  const source = await createImageBitmap(await response.blob());
  const size = 640;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { alpha: false });
  const hard = strength === 'hard';
  const angle = (hard ? -0.095 : 0.035) * (seed % 2 ? 1 : -1);
  const shear = (hard ? 0.09 : 0.025) * (seed % 3 === 0 ? -1 : 1);
  const scale = hard ? 1.17 : 0.94;
  const brightness = hard ? 0.78 : 0.94;

  context.fillStyle = hard ? '#1f1b18' : '#35302b';
  context.fillRect(0, 0, size, size);
  context.save();
  context.translate(size / 2 + (hard ? 34 : -8), size / 2 + (hard ? -18 : 7));
  context.rotate(angle);
  context.transform(1, shear, -shear * 0.35, 1, 0, 0);
  context.scale(scale, scale);
  context.filter = `brightness(${brightness}) contrast(${hard ? 1.14 : 1.04})`;
  context.drawImage(source, -size / 2, -size / 2, size, size);
  context.restore();

  const glare = context.createLinearGradient(size * 0.15, 0, size * 0.85, size);
  glare.addColorStop(0, 'rgba(255,255,255,0)');
  glare.addColorStop(hard ? 0.62 : 0.72, `rgba(255,255,255,${hard ? 0.30 : 0.10})`);
  glare.addColorStop(hard ? 0.76 : 0.82, 'rgba(255,255,255,0)');
  context.fillStyle = glare;
  context.fillRect(0, 0, size, size);
  source.close();

  const blob = await new Promise((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error('Canvas encoding failed')),
    'image/jpeg',
    hard ? 0.72 : 0.88,
  ));
  return URL.createObjectURL(blob);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(rows, variant) {
  const selected = rows.filter((row) => row.variant === variant);
  return {
    variant,
    count: selected.length,
    recallAt1: selected.filter((row) => row.rank === 1).length / selected.length,
    recallAt5: selected.filter((row) => row.rank <= 5).length / selected.length,
    medianRank: median(selected.map((row) => row.rank)),
  };
}

function addDefinition(term, value) {
  const title = document.createElement('dt');
  const description = document.createElement('dd');
  title.textContent = term;
  description.textContent = value;
  details.append(title, description);
}

function addDownload(label, filename, body, type) {
  const link = document.createElement('a');
  link.className = 'download';
  link.textContent = label;
  link.download = filename;
  link.href = URL.createObjectURL(new Blob([body], { type }));
  downloads.append(link);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function renderReport(report, indexBytes, metadata) {
  metricsBody.replaceChildren();
  details.replaceChildren();
  downloads.replaceChildren();
  for (const metric of report.metrics) {
    const row = document.createElement('tr');
    for (const value of [
      metric.variant,
      `${(metric.recallAt1 * 100).toFixed(1)}% (${Math.round(metric.recallAt1 * metric.count)}/${metric.count})`,
      `${(metric.recallAt5 * 100).toFixed(1)}% (${Math.round(metric.recallAt5 * metric.count)}/${metric.count})`,
      String(metric.medianRank),
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    metricsBody.append(row);
  }
  addDefinition('Model', `${MODEL} (${DTYPE})`);
  addDefinition('Reference covers', String(report.referenceCount));
  addDefinition('Vector dimension', String(report.dimension));
  addDefinition('Int8 index', `${indexBytes.byteLength.toLocaleString()} bytes`);
  addDefinition('Model load', `${report.modelLoadMs.toFixed(0)} ms`);
  addDefinition('Mean inference', `${report.meanInferenceMs.toFixed(0)} ms/image`);
  addDownload('Download index.bin', 'index.bin', indexBytes, 'application/octet-stream');
  addDownload('Download metadata.json', 'metadata.json', `${JSON.stringify(metadata, null, 2)}\n`, 'application/json');
  addDownload('Download results.json', 'results.json', `${JSON.stringify(report, null, 2)}\n`, 'application/json');
  addDownload('Download pilot-export.json', 'pilot-export.json', `${JSON.stringify({
    indexBase64: bytesToBase64(indexBytes), metadata, report,
  })}\n`, 'application/json');
  results.hidden = false;
}

async function run() {
  startButton.disabled = true;
  results.hidden = true;
  const manifest = await loadManifest();
  setStatus(`Loading ${MODEL} (${DTYPE})…`);
  const modelStarted = performance.now();
  const extractor = await pipeline('image-feature-extraction', MODEL, {
    dtype: DTYPE,
    progress_callback: (progress) => {
      if (progress.status === 'progress' && progress.file) {
        setStatus(`Loading model: ${progress.file} ${Math.round(progress.progress || 0)}%`);
      }
    },
  });
  const modelLoadMs = performance.now() - modelStarted;
  const references = [];
  const inferenceTimes = [];

  for (let index = 0; index < manifest.releases.length; index += 1) {
    setStatus(`Embedding reference ${index + 1}/${manifest.releases.length}…`);
    const started = performance.now();
    references.push(modelVector(await extractor(coverUrl(manifest.releases[index]))));
    inferenceTimes.push(performance.now() - started);
  }

  const indexBytes = encodeQuantizedIndex(references.map(quantizeUnitVector));
  const transferUrl = URL.createObjectURL(new Blob([indexBytes], { type: 'application/octet-stream' }));
  let vectorIndex;
  try {
    vectorIndex = await fetchQuantizedIndex(transferUrl);
  } finally {
    URL.revokeObjectURL(transferUrl);
  }
  const rows = [];
  for (const variant of ['mild', 'hard']) {
    for (let expected = 0; expected < manifest.releases.length; expected += 1) {
      setStatus(`Testing ${variant} photo ${expected + 1}/${manifest.releases.length}…`);
      const temporaryUrl = await createVariant(coverUrl(manifest.releases[expected]), variant, expected + manifest.seed);
      try {
        const started = performance.now();
        const query = modelVector(await extractor(temporaryUrl));
        inferenceTimes.push(performance.now() - started);
        const matches = rankQuantized(query, vectorIndex, vectorIndex.count);
        const rank = matches.findIndex((match) => match.index === expected) + 1;
        rows.push({
          variant,
          musicBrainzReleaseId: manifest.releases[expected].musicBrainzReleaseId,
          rank,
          topScore: matches[0].score,
          expectedScore: matches[rank - 1].score,
          margin: matches[0].score - (matches[1]?.score ?? matches[0].score),
        });
      } finally {
        URL.revokeObjectURL(temporaryUrl);
      }
    }
  }

  const metadata = {
    schemaVersion: 1,
    model: MODEL,
    dtype: DTYPE,
    dimension: vectorIndex.dimension,
    quantization: 'symmetric-int8-unit-vector',
    releases: manifest.releases.map((release, index) => ({ index, ...release })),
  };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: MODEL,
    dtype: DTYPE,
    referenceCount: vectorIndex.count,
    dimension: vectorIndex.dimension,
    indexBytes: indexBytes.byteLength,
    modelLoadMs,
    meanInferenceMs: inferenceTimes.reduce((sum, value) => sum + value, 0) / inferenceTimes.length,
    metrics: ['mild', 'hard'].map((variant) => summarize(rows, variant)),
    rows,
  };
  renderReport(report, indexBytes, metadata);
  status.dataset.indexBase64 = bytesToBase64(indexBytes);
  status.dataset.metadata = JSON.stringify(metadata);
  status.dataset.report = JSON.stringify(report);
  setStatus('Benchmark complete.');
  window.vinylBenchmarkResult = report;
}

startButton.addEventListener('click', () => run().catch((error) => {
  setStatus(`Benchmark failed: ${error.message}`);
  startButton.disabled = false;
  console.error(error);
}));

if (new URL(location.href).searchParams.get('autorun') === '1') startButton.click();
