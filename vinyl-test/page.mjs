// SPDX-License-Identifier: GPL-3.0-or-later
// Unlisted phone test page for the vinyl scanner (German UI). The only file
// in vinyl-test/ that touches the DOM: it runs the app's client-side
// pipeline on real phone photos, records the person's truth per photo and
// assembles a report that leaves the phone only through Share or Download.

import { buildOcrQueries, rankOcrAlbumCandidates, recognizeVinylText } from '../js/vinyl-scan.mjs';
import { findOcrAlbumCandidates } from '../js/adapters.mjs';
import {
  VISUAL_MODELS,
  canRerankVisually,
  embedVinylCover,
  prepareVisualModel,
  rerankVinylCandidates,
  visualModelCache,
  visualModelStored,
} from '../js/visual-match.mjs';
import { VINYL_CATALOG_URL, searchVinylCatalog } from '../js/vinyl-index.mjs';
import {
  PAGE_VERSION,
  SITUATION_TAGS,
  buildReport,
  encodeVector,
  mergeCandidates,
  normalizeEntry,
  reportFilename,
} from './report.mjs';
import { openEntryStore } from './store.mjs';

const MODEL_KEY = 'small';
const MODEL = VISUAL_MODELS[MODEL_KEY];
const MODEL_DTYPE = MODEL.variant.split(' ')[0]; // 'q4 ONNX' → 'q4', as visual-match loads it
const COPY_EDGE = 640;
const COPY_QUALITY = 0.88;
const CONFIRM_MS = 5000;
const REVOKE_MS = 60000;
const MEGABYTE = 1024 * 1024;

const $ = (selector) => document.querySelector(selector);
const el = {
  modelBox: $('#model-box'),
  modelState: $('#model-state'),
  loadModel: $('#load-model'),
  warn: $('#warn'),
  status: $('#status'),
  camera: $('#camera-input'),
  file: $('#file-input'),
  openCamera: $('#open-camera'),
  openFile: $('#open-file'),
  preview: $('#preview'),
  candidates: $('#candidates'),
  form: $('#truth-form'),
  none: $('#truth-none'),
  noneFields: $('#none-fields'),
  artist: $('#truth-artist'),
  title: $('#truth-title'),
  catno: $('#truth-catno'),
  tags: $('#truth-tags'),
  note: $('#truth-note'),
  save: $('#save-entry'),
  discard: $('#discard-entry'),
  entryCount: $('#entry-count'),
  entryList: $('#entry-list'),
  deleteLast: $('#delete-last'),
  exportSize: $('#export-size'),
  share: $('#share-report'),
  download: $('#download-report'),
  clear: $('#clear-report'),
  exportLine: $('#export-line'),
};

const state = {
  store: null,
  entries: [],          // newest first
  busy: false,
  model: { ready: false, loading: false, wasCached: null, loadMs: null },
  catalog: null,
  current: null,        // entry awaiting its truth
  chosenIndex: null,
  none: false,
  tags: new Set(),
  pendingExport: null,  // { file, name } built eagerly for the share gesture
  previewUrl: null,
  counter: 0,
};

function setLine(node, text, tone = 'info') {
  node.textContent = text || '';
  node.dataset.tone = tone;
  node.hidden = !text;
  delete node.dataset.busy;
}

function setStatus(text, tone = 'info', busy = false) {
  setLine(el.status, text, tone);
  if (busy) el.status.dataset.busy = '';
}

function setBusy(busy) {
  state.busy = busy;
  const blocked = busy || state.model.loading;
  for (const node of [el.openCamera, el.openFile, el.camera, el.file]) node.disabled = blocked;
  el.loadModel.disabled = blocked || state.model.ready;
}

function describeProgress(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.stage === 'model') return `Modell wird geladen: ${message.file} ${message.percent} %`;
  if (message.stage === 'query') return 'Bild wird lokal analysiert';
  if (message.stage === 'reference') return `Cover-Vergleich ${message.current}/${message.total}`;
  if (message.stage === 'catalog') return `Lokaler Index ${message.current}/${message.total}`;
  if (message.status === 'recognizing text') return `Text wird gelesen ${Math.round((message.progress || 0) * 100)} %`;
  if (message.status) return 'Texterkennung wird vorbereitet';
  return null;
}

const progress = (message) => {
  const text = describeProgress(message);
  if (text) setStatus(text, 'info', true);
};

// --- Model box: never downloads on its own; from the cache it initialises
// silently so the first photo does not wait for the 15 MB decision.

async function loadModel(fromCache) {
  state.model.loading = true;
  setBusy(state.busy);
  el.modelState.textContent = fromCache ? 'Modell wird aus dem Browser-Speicher geladen …' : 'Modell wird geladen …';
  const started = performance.now();
  try {
    await prepareVisualModel({
      modelKey: MODEL_KEY,
      onProgress: (message) => {
        const text = describeProgress(message);
        if (text) el.modelState.textContent = text;
      },
    });
    state.model.loadMs = Math.round(performance.now() - started);
    state.model.ready = true;
    el.modelBox.dataset.stored = 'true';
    el.modelState.textContent = 'Modell gespeichert und bereit.';
    el.loadModel.hidden = true;
  } catch (error) {
    el.modelState.textContent = `Modell konnte nicht geladen werden: ${error?.message || error}`;
    el.loadModel.hidden = false;
  } finally {
    state.model.loading = false;
    setBusy(state.busy);
  }
}

// The ready marker can outlive the weights (cache eviction). Only when the
// ONNX file is still there does the boot load from cache without asking;
// otherwise the 15 MB stay behind the button.
async function modelWeightsCached() {
  if (!globalThis.caches) return false;
  const cache = await caches.open(visualModelCache(MODEL_KEY));
  return (await cache.keys()).some((request) => /\.onnx(?:$|\?)/.test(request.url));
}

async function initModel() {
  let stored = false;
  try {
    stored = await visualModelStored({ modelKey: MODEL_KEY }) && await modelWeightsCached();
  } catch { /* no Cache API: treat as not stored */ }
  state.model.wasCached = stored;
  if (stored) {
    await loadModel(true);
    return;
  }
  el.modelState.textContent = `Modell nicht geladen (${MODEL.name}, ${(MODEL.bytes / 1e6).toFixed(1).replace('.', ',')} MB).`;
  el.loadModel.hidden = false;
  el.loadModel.disabled = false;
}

el.loadModel.addEventListener('click', () => loadModel(false));

// --- Photo copy for the report. The pipeline itself runs on the original
// blob, exactly like the app; this 640 px JPEG is only the record.

async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return {
        source: bitmap, width: bitmap.width, height: bitmap.height,
        orientationSource: 'bitmap', release: () => bitmap.close(),
      };
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('Image decode failed');
  }
  return {
    source: image, width: image.naturalWidth, height: image.naturalHeight,
    orientationSource: 'img', release: () => URL.revokeObjectURL(url),
  };
}

async function downscale(blob) {
  const decoded = await decodeImage(blob);
  try {
    const scale = Math.min(1, COPY_EDGE / Math.max(decoded.width, decoded.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    const copy = await new Promise((resolve, reject) => canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('Canvas encoding failed'))),
      'image/jpeg',
      COPY_QUALITY,
    ));
    return {
      buffer: await copy.arrayBuffer(),
      type: copy.type || 'image/jpeg',
      width: canvas.width,
      height: canvas.height,
      bytes: copy.size,
      originalBytes: blob.size,
      originalType: blob.type,
      originalWidth: decoded.width,
      originalHeight: decoded.height,
      pipelineInput: 'original',
      orientationSource: decoded.orientationSource,
    };
  } finally {
    decoded.release();
  }
}

// --- Pipeline: every stage in its own try/catch, timed, errors recorded;
// the next stage still runs so one failing service does not lose the photo.

function rememberCatalog(manifest) {
  state.catalog = {
    manifestUrl: VINYL_CATALOG_URL,
    model: manifest.model,
    dimension: manifest.dimension,
    releaseCount: manifest.releaseCount,
    generatedAt: manifest.generatedAt || null,
  };
}

// The report names the index it was made against even when no photo was
// taken in this session (entries restored from the store).
async function loadCatalogInfo() {
  try {
    const response = await fetch(VINYL_CATALOG_URL, { cache: 'force-cache', credentials: 'omit' });
    if (response.ok) rememberCatalog(await response.json());
  } catch { /* the first index search fills it in instead */ }
}

async function runPipeline(blob, source) {
  state.counter += 1;
  const entry = {
    id: `e-${Date.now()}-${state.counter}`,
    capturedAt: new Date().toISOString(),
    source,
    image: null,
    ocr: { text: '', confidence: null, error: null },
    queries: [],
    candidates: [],
    vector: null,
    timings: {},
    truth: {},
    errors: [],
  };
  const started = performance.now();
  const attempt = async (stage, key, task) => {
    const stageStarted = performance.now();
    try {
      return await task();
    } catch (error) {
      entry.errors.push({ stage, message: error?.message || String(error) });
      return null;
    } finally {
      entry.timings[key] = Math.round(performance.now() - stageStarted);
    }
  };

  setStatus('Kopie fürs Protokoll wird erstellt', 'info', true);
  entry.image = await attempt('downscale', 'downscaleMs', () => downscale(blob));

  setStatus('Texterkennung wird vorbereitet', 'info', true);
  const ocr = await attempt('ocr', 'ocrMs', () => recognizeVinylText(blob, progress));
  if (ocr) {
    entry.ocr = { text: ocr.text.trim(), confidence: ocr.confidence, error: null };
  } else {
    entry.ocr.error = entry.errors.at(-1)?.message || 'OCR failed';
  }

  entry.queries = entry.ocr.text ? buildOcrQueries(entry.ocr.text) : [];
  let ocrCandidates = [];
  if (entry.queries.length) {
    setStatus('Alben werden gesucht', 'info', true);
    ocrCandidates = await attempt('search', 'searchMs', async () =>
      rankOcrAlbumCandidates(await findOcrAlbumCandidates(entry.queries), entry.ocr.text)) || [];
  }

  setStatus('Bild wird lokal analysiert', 'info', true);
  const embedded = await attempt('embed', 'embedMs', async () => {
    const raw = await embedVinylCover(blob, { modelKey: MODEL_KEY, onProgress: progress });
    return { raw, encoded: encodeVector(raw) };
  });
  const vector = embedded?.raw ?? null;
  if (embedded) entry.vector = { ...embedded.encoded, embedMs: entry.timings.embedMs };

  let reranked = null;
  if (canRerankVisually(ocrCandidates)) {
    setStatus('Cover-Vergleich wird vorbereitet', 'info', true);
    // Includes a second query embedding: rerankVinylCandidates embeds the
    // photo itself, so rerankMs is not comparable with embedMs.
    reranked = await attempt('rerank', 'rerankMs', () =>
      rerankVinylCandidates(blob, ocrCandidates, { modelKey: MODEL_KEY, onProgress: progress }));
  }

  let catalog = [];
  if (vector) {
    setStatus('Lokaler Index wird durchsucht', 'info', true);
    catalog = await attempt('catalog', 'catalogMs', async () => {
      const result = await searchVinylCatalog(vector, { onProgress: progress });
      rememberCatalog(result.manifest);
      return result.candidates;
    }) || [];
  }

  entry.candidates = mergeCandidates({ ocr: ocrCandidates, reranked, catalog });
  entry.timings.totalMs = Math.round(performance.now() - started);
  return entry;
}

// --- Capture flow

function showPreview(blob) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(blob);
  el.preview.src = state.previewUrl;
  el.preview.hidden = false;
}

function clearPreview() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  el.preview.removeAttribute('src');
  el.preview.hidden = true;
}

function summaryLine(entry) {
  const counts = {
    text: entry.candidates.filter((candidate) => candidate.source === 'ocr').length,
    index: entry.candidates.filter((candidate) => candidate.source === 'visual-index').length,
  };
  const seconds = (entry.timings.totalMs / 1000).toFixed(1).replace('.', ',');
  const parts = [`${counts.text} Text-Treffer, ${counts.index} Index-Treffer in ${seconds} s.`];
  if (!entry.ocr.text) parts.push('Kein Text erkannt.');
  if (entry.errors.length) parts.push(`${entry.errors.length} Stufe(n) mit Fehler, trotzdem speichern.`);
  parts.push('Tippe auf den richtigen Treffer oder auf „Keins davon“.');
  return parts.join(' ');
}

async function handlePhoto(input, source) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (state.model.loading) {
    setStatus('Das Modell wird gerade geladen, bitte kurz warten.', 'warn');
    return;
  }
  if (state.busy) return;
  if (!state.model.ready) {
    setStatus('Bitte zuerst oben das Modell laden.', 'warn');
    return;
  }
  if (!file.type.startsWith('image/')) {
    setStatus('Bitte ein Bild wählen.', 'warn');
    return;
  }
  discardCurrent();
  setBusy(true);
  showPreview(file);
  try {
    const entry = await runPipeline(file, source);
    state.current = entry;
    renderCandidates(entry.candidates);
    resetForm();
    el.form.hidden = false;
    setStatus(summaryLine(entry), entry.errors.length ? 'warn' : 'info');
  } catch (error) {
    setStatus(`Fehler: ${error?.message || error}`, 'warn');
    clearPreview();
  } finally {
    setBusy(false);
  }
}

el.openCamera.addEventListener('click', () => el.camera.click());
el.openFile.addEventListener('click', () => el.file.click());
el.camera.addEventListener('change', () => handlePhoto(el.camera, 'camera'));
el.file.addEventListener('change', () => handlePhoto(el.file, 'file'));

// --- Tiles and the truth form

function tile(candidate, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'scan-candidate';
  button.dataset.index = String(index);
  button.setAttribute('aria-pressed', 'false');
  if (candidate.thumb) {
    const image = document.createElement('img');
    image.src = candidate.thumb;
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    button.appendChild(image);
  }
  const copy = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = candidate.title;
  const artist = document.createElement('small');
  artist.textContent = [candidate.artist, candidate.date?.slice(0, 4), candidate.country]
    .filter(Boolean).join(' · ');
  copy.append(title, artist);
  button.appendChild(copy);
  button.addEventListener('click', () => chooseTile(index));
  return button;
}

function renderCandidates(candidates) {
  el.candidates.replaceChildren();
  const reranked = candidates.some((candidate) => candidate.source === 'ocr' && candidate.reranked);
  const groups = [
    { source: 'ocr', label: reranked ? 'Text + Bild' : 'Text' },
    {
      source: 'visual-index',
      label: state.catalog?.releaseCount
        ? `Index (nur ${state.catalog.releaseCount} Cover, Treffer unwahrscheinlich)`
        : 'Index (kleiner Pilot, Treffer unwahrscheinlich)',
    },
  ];
  for (const group of groups) {
    const heading = document.createElement('p');
    heading.className = 'scan-privacy group-label';
    const members = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.source === group.source);
    heading.textContent = members.length ? group.label : `${group.label}: keine Treffer`;
    el.candidates.appendChild(heading);
    for (const { candidate, index } of members) el.candidates.appendChild(tile(candidate, index));
  }
}

function syncTiles() {
  for (const button of el.candidates.querySelectorAll('.scan-candidate')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.index) === state.chosenIndex));
  }
}

function setNone(none) {
  state.none = none;
  el.none.setAttribute('aria-pressed', String(none));
  el.noneFields.hidden = !none;
  if (none) {
    state.chosenIndex = null;
    syncTiles();
    el.artist.focus();
  }
  updateSaveButton();
}

function chooseTile(index) {
  state.chosenIndex = state.chosenIndex === index ? null : index;
  if (state.chosenIndex !== null && state.none) {
    state.none = false;
    el.none.setAttribute('aria-pressed', 'false');
    el.noneFields.hidden = true;
  }
  syncTiles();
  updateSaveButton();
}

function updateSaveButton() {
  const typed = el.artist.value.trim() && el.title.value.trim();
  el.save.disabled = !(state.chosenIndex !== null || (state.none && typed));
}

function renderChips() {
  el.tags.replaceChildren();
  for (const tag of SITUATION_TAGS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip';
    chip.textContent = tag;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => {
      const pressed = !state.tags.has(tag);
      if (pressed) state.tags.add(tag);
      else state.tags.delete(tag);
      chip.setAttribute('aria-pressed', String(pressed));
    });
    el.tags.appendChild(chip);
  }
}

function resetForm() {
  state.chosenIndex = null;
  state.none = false;
  state.tags.clear();
  el.none.setAttribute('aria-pressed', 'false');
  el.noneFields.hidden = true;
  for (const field of [el.artist, el.title, el.catno, el.note]) field.value = '';
  for (const chip of el.tags.querySelectorAll('.tag-chip')) chip.setAttribute('aria-pressed', 'false');
  syncTiles();
  updateSaveButton();
}

function discardCurrent() {
  state.current = null;
  el.form.hidden = true;
  el.candidates.replaceChildren();
  clearPreview();
  resetForm();
}

el.none.addEventListener('click', () => setNone(!state.none));
el.artist.addEventListener('input', updateSaveButton);
el.title.addEventListener('input', updateSaveButton);
el.discard.addEventListener('click', () => {
  discardCurrent();
  setStatus('Foto verworfen.', 'info');
});

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const entry = state.current;
  if (!entry || el.save.disabled) return;
  entry.truth = {
    chosenIndex: state.chosenIndex,
    none: state.none,
    artist: el.artist.value.trim(),
    title: el.title.value.trim(),
    catalogNumber: el.catno.value.trim(),
    tags: [...state.tags],
    note: el.note.value.trim(),
  };
  state.entries.unshift(entry);
  // Persist first, unawaited: a throw while re-rendering must not leave a
  // photo that only lives in memory, and the camera re-open below has to
  // stay inside the tap's user activation.
  state.store.put(entry).catch((error) => {
    setLine(el.warn, `Speichern im Browser fehlgeschlagen (${error?.message || error}). Der Eintrag bleibt nur bis zum Neuladen erhalten; bitte den Bericht bald teilen.`, 'warn');
  });
  discardCurrent();
  renderEntries();
  rebuildExport();
  setStatus('Gespeichert. Nächstes Foto?', 'info');
  if (entry.source === 'camera') el.camera.click();
});

// --- Entry list, deletion, export

function entryLabel(entry) {
  const truth = entry.truth || {};
  const chosen = !truth.none && Number.isInteger(truth.chosenIndex) ? entry.candidates[truth.chosenIndex] : null;
  const name = chosen ? `${chosen.title} — ${chosen.artist}` : `Keins davon: ${truth.title} — ${truth.artist}`;
  const tags = (truth.tags || []).join(', ');
  return tags ? `${name} · ${tags}` : name;
}

function renderEntries() {
  const count = state.entries.length;
  el.entryCount.textContent = `${count} ${count === 1 ? 'Foto' : 'Fotos'} gespeichert`;
  el.entryList.replaceChildren(...state.entries.map((entry) => {
    const item = document.createElement('li');
    item.textContent = entryLabel(entry);
    return item;
  }));
  el.deleteLast.hidden = !count;
}

function deviceInfo() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform || navigator.platform || '',
    language: navigator.language,
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
  };
}

function modelInfo() {
  return {
    key: MODEL_KEY,
    repository: MODEL.repository,
    dtype: MODEL_DTYPE,
    dimension: MODEL.dimensions,
    bytes: MODEL.bytes,
    wasCached: state.model.wasCached,
    loadMs: state.model.loadMs,
  };
}

// The 640 px copies are base64-encoded once per entry, not once per save.
const normalizedEntries = new WeakMap();
function normalizedEntry(entry) {
  let normalized = normalizedEntries.get(entry);
  if (!normalized) {
    normalized = normalizeEntry(entry);
    normalizedEntries.set(entry, normalized);
  }
  return normalized;
}

function rebuildExport() {
  const count = state.entries.length;
  for (const button of [el.share, el.download, el.clear]) button.disabled = !count;
  if (!count) {
    state.pendingExport = null;
    el.exportSize.textContent = 'Noch kein Eintrag gespeichert.';
    return;
  }
  const report = buildReport({
    device: deviceInfo(),
    model: modelInfo(),
    catalog: state.catalog || { manifestUrl: VINYL_CATALOG_URL, model: null, dimension: null, releaseCount: null, generatedAt: null },
    entries: state.entries.map(normalizedEntry),
    pageVersion: PAGE_VERSION,
  });
  const name = reportFilename();
  const file = new File([JSON.stringify(report)], name, { type: 'application/json' });
  state.pendingExport = { file, name };
  el.exportSize.textContent = `${name} · ≈ ${(file.size / MEGABYTE).toFixed(1).replace('.', ',')} MB`;
}

function downloadReport() {
  const { file, name } = state.pendingExport;
  const link = document.createElement('a');
  const url = URL.createObjectURL(file);
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Safari may still be reading the blob after click(); revoke later.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
  setLine(el.exportLine, `Download gestartet: ${name}`, 'info');
}

el.download.addEventListener('click', () => {
  if (state.pendingExport) downloadReport();
});

el.share.addEventListener('click', () => {
  if (!state.pendingExport) return;
  const { file } = state.pendingExport;
  // navigator.share must run synchronously inside the tap; an await before
  // it loses the user activation on iOS.
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file], title: 'musiclinkii Vinyl-Test' })
      .then(() => setLine(el.exportLine, 'Bericht geteilt.', 'info'))
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        setLine(el.exportLine, `Teilen fehlgeschlagen (${error?.message || error}). Nutze den Download.`, 'warn');
      });
    return;
  }
  downloadReport();
});

function twoStep(button, label, armedLabel, action) {
  let timer = null;
  const reset = () => {
    clearTimeout(timer);
    timer = null;
    button.textContent = label;
    button.classList.remove('armed');
  };
  button.addEventListener('click', () => {
    if (timer === null) {
      button.textContent = armedLabel;
      button.classList.add('armed');
      timer = setTimeout(reset, CONFIRM_MS);
      return;
    }
    reset();
    action();
  });
}

twoStep(el.deleteLast, 'Letzten Eintrag löschen', 'Wirklich löschen?', () => {
  const [removed] = state.entries.splice(0, 1);
  if (!removed) return;
  renderEntries();
  rebuildExport();
  state.store.deleteById(removed.id).catch((error) => {
    setLine(el.warn, `Löschen im Browser fehlgeschlagen (${error?.message || error}). Der Eintrag erscheint nach dem Neuladen wieder.`, 'warn');
  });
});

twoStep(el.clear, 'Bericht löschen', 'Wirklich alles löschen?', () => {
  state.entries = [];
  renderEntries();
  rebuildExport();
  setLine(el.exportLine, 'Bericht gelöscht.', 'info');
  state.store.clear().catch((error) => {
    setLine(el.warn, `Löschen im Browser fehlgeschlagen (${error?.message || error}). Die Einträge erscheinen nach dem Neuladen wieder.`, 'warn');
  });
});

// --- Boot

async function init() {
  renderChips();
  state.store = await openEntryStore();
  if (!state.store.persistent) {
    setLine(el.warn, 'Dieser Browser speichert nichts dauerhaft. Bitte den Bericht am Ende sofort teilen.', 'warn');
  }
  const stored = await state.store.getAll();
  state.entries = stored.sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)));
  renderEntries();
  rebuildExport();
  await Promise.all([loadCatalogInfo(), initModel()]);
  // Model and index facts arrive after the first build; rebuild so a report
  // exported without a new photo still carries them.
  rebuildExport();
}

init().catch((error) => setStatus(`Seite konnte nicht starten: ${error?.message || error}`, 'warn'));
