// SPDX-License-Identifier: GPL-3.0-or-later
// OCR-first vinyl-cover recognition. The image stays in the browser: only
// the extracted text becomes a catalog query. Tesseract is lazy-loaded on
// the first deliberate scan so the normal link workflow pays no download or
// memory cost.

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
const TESSERACT_INTEGRITY = 'sha384-2BQ3U3OdKOb0Uczxqr41I9UvZkzr4V9Hv8uSzMMZAlmhsFClvdZX5wi5fDCzG+tM';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MIN_CANVAS_EDGE = 1000;
const MAX_CANVAS_EDGE = 1600;
const MIN_CANDIDATE_SCORE = 0.3;

const NORMALIZED_NOISE = new Set([
  'stereo', 'mono', 'record', 'records', 'recording', 'vinyl', 'album', 'lp',
  'side a', 'side b', 'side 1', 'side 2', '33 rpm', '33 1 3 rpm', '45 rpm',
]);

const normalize = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const cleanLine = (line) => String(line || '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/^[|_~`^.,:;]+|[|_~`^,;]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export function extractOcrLines(text) {
  const seen = new Set();
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = cleanLine(raw);
    const key = normalize(line);
    if (key.length < 2 || !/[\p{L}\p{N}]/u.test(key) || NORMALIZED_NOISE.has(key) || seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

const bounded = (text, max = 120) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max + 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max)).trim().slice(0, max);
};

export function buildOcrQueries(text, limit = 4) {
  const lines = extractOcrLines(text);
  const proposed = [bounded(lines.join(' ')), ...lines.map((line) => bounded(line))];
  const seen = new Set();
  const queries = [];
  for (const query of proposed) {
    const key = normalize(query);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= limit) break;
  }
  return queries;
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

const tokens = (value) => [...new Set(normalize(value).split(' ').filter((token) => token.length >= 2))];

function tokenMatches(candidate, observed) {
  if (candidate === observed) return true;
  const shorter = Math.min(candidate.length, observed.length);
  if (shorter < 5 || Math.abs(candidate.length - observed.length) > 2) return false;
  return editDistance(candidate, observed) <= (shorter >= 8 ? 2 : 1);
}

function coverageStats(value, observedTokens) {
  const wanted = tokens(value);
  if (!wanted.length) return { coverage: 0, matched: 0 };
  const matched = wanted.filter((token) => observedTokens.some((observed) => tokenMatches(token, observed))).length;
  return { coverage: matched / wanted.length, matched };
}

function comparableTitle(value) {
  const raw = String(value || '').trim();
  return raw
    .replace(/\s*[([][^)\]]*(?:edition|remaster(?:ed)?|deluxe|anniversary|expanded|bonus)[^)\]]*[)\]]/gi, '')
    .replace(/\s[-–—]\s(?:remaster(?:ed)?|deluxe|anniversary|expanded).*$/i, '')
    .trim() || raw;
}

function albumScore(candidate, text) {
  const readableText = extractOcrLines(text).join(' ');
  const observed = tokens(readableText);
  if (!observed.length) return 0;
  const titleText = comparableTitle(candidate.title);
  const title = coverageStats(titleText, observed);
  const artist = coverageStats(candidate.artist, observed);
  // A matching artist alone names a discography, not an album. Likewise a
  // single fuzzy title word is too little evidence to put a confident-looking
  // card on screen ("READE" must not become "Reader").
  if (!title.matched || title.matched + artist.matched < 2) return 0;

  const normalizedLines = extractOcrLines(text).map(normalize);
  const normalizedTitle = normalize(titleText);
  const titleExact = normalizedLines.includes(normalizedTitle) ? 0.03 : 0;
  const artistExact = normalizedLines.includes(normalize(candidate.artist)) ? 0.02 : 0;
  const titlePhrase = normalizedTitle.length >= 5 && normalize(readableText).includes(normalizedTitle) ? 0.08 : 0;
  return Math.min(1,
    title.coverage * 0.62 + artist.coverage * 0.33 + titleExact + artistExact + titlePhrase);
}

export function rankOcrAlbumCandidates(candidates, text, limit = 5) {
  const best = new Map();
  for (const candidate of candidates || []) {
    if (!candidate?.title || !candidate?.artist) continue;
    const score = albumScore(candidate, text);
    if (score < MIN_CANDIDATE_SCORE) continue;
    const key = `${normalize(candidate.artist)}|${normalize(candidate.title)}`;
    const ranked = { ...candidate, score };
    const current = best.get(key);
    if (!current || ranked.score > current.score ||
        (ranked.score === current.score && (ranked.queryRank ?? Infinity) < (current.queryRank ?? Infinity))) {
      best.set(key, ranked);
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || (a.queryRank ?? Infinity) - (b.queryRank ?? Infinity))
    .slice(0, limit);
}

function assertImage(blob) {
  if (!(blob instanceof Blob) || !blob.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('The image is larger than 25 MB.');
  return blob;
}

export function pastedImage(clipboardData) {
  const item = [...(clipboardData?.items || [])].find((entry) => entry.kind === 'file' && entry.type.startsWith('image/'));
  return item?.getAsFile() || null;
}

export async function fetchImage(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    throw new Error('Enter a valid image URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use an http or https image URL.');
  let response;
  try {
    response = await fetch(parsed.href);
  } catch {
    throw new Error('That image host blocks browser access. Save the image and choose it instead.');
  }
  if (!response.ok) throw new Error(`The image request failed (HTTP ${response.status}).`);
  return assertImage(await response.blob());
}

function loadTesseract() {
  if (globalThis.Tesseract?.createWorker) return Promise.resolve(globalThis.Tesseract);
  if (loadTesseract.pending) return loadTesseract.pending;
  loadTesseract.pending = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TESSERACT_URL;
    script.integrity = TESSERACT_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.onload = () => globalThis.Tesseract?.createWorker
      ? resolve(globalThis.Tesseract)
      : reject(new Error('The OCR library did not initialize.'));
    script.onerror = () => reject(new Error('The OCR library could not be downloaded.'));
    document.head.appendChild(script);
  }).catch((error) => {
    loadTesseract.pending = null;
    throw error;
  });
  return loadTesseract.pending;
}

async function imageCanvas(blob) {
  assertImage(blob);
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const longestEdge = Math.max(bitmap.width, bitmap.height);
  // Catalog thumbnails are commonly only 250–500 px wide. Upscaling does
  // not invent detail, but it gives Tesseract enough pixels to segment the
  // small display type; phone photos are capped instead to bound memory.
  const scale = Math.min(MAX_CANVAS_EDGE / longestEdge, Math.max(1, MIN_CANVAS_EDGE / longestEdge));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  // Album typography often sits only a few brightness levels above a dark
  // photograph. Stretch the grayscale histogram and put dark text on a light
  // background when the cover is predominantly dark. This is the OCR input;
  // the preview remains the untouched image.
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const histogram = new Uint32Array(256);
  let luminanceSum = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const luminance = Math.round(
      image.data[i] * 0.2126 + image.data[i + 1] * 0.7152 + image.data[i + 2] * 0.0722
    );
    histogram[luminance] += 1;
    luminanceSum += luminance;
  }
  const pixels = canvas.width * canvas.height;
  const percentile = Math.max(1, Math.floor(pixels * 0.01));
  let low = 0;
  let lowCount = 0;
  while (low < 255 && (lowCount += histogram[low]) < percentile) low += 1;
  let high = 255;
  let highCount = 0;
  while (high > 0 && (highCount += histogram[high]) < percentile) high -= 1;
  const range = Math.max(24, high - low);
  const invert = luminanceSum / pixels < 112;
  for (let i = 0; i < image.data.length; i += 4) {
    const luminance = image.data[i] * 0.2126 + image.data[i + 1] * 0.7152 + image.data[i + 2] * 0.0722;
    const stretched = Math.max(0, Math.min(255, Math.round((luminance - low) * 255 / range)));
    const value = invert ? 255 - stretched : stretched;
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function verticalCrop(source, topRatio, heightRatio) {
  if (topRatio === 0 && heightRatio === 1) return source;
  const sourceY = Math.round(source.height * topRatio);
  const sourceHeight = Math.max(1, Math.round(source.height * heightRatio));
  const scale = Math.min(2, MAX_CANVAS_EDGE / source.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(sourceHeight * scale);
  const context = canvas.getContext('2d', { alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    source, 0, sourceY, source.width, sourceHeight,
    0, 0, canvas.width, canvas.height
  );
  return canvas;
}

export async function recognizeVinylText(blob, onProgress = () => {}) {
  const tesseract = await loadTesseract();
  const canvas = await imageCanvas(blob);
  const worker = await tesseract.createWorker('eng', tesseract.OEM?.LSTM_ONLY ?? 1, {
    logger: (message) => onProgress(message),
  });
  try {
    const results = [];
    const sparse = tesseract.PSM?.SPARSE_TEXT ?? '11';
    const block = tesseract.PSM?.SINGLE_BLOCK ?? '6';
    const passes = [
      { image: canvas, mode: sparse },
      { image: verticalCrop(canvas, 0, 0.48), mode: sparse },
      { image: verticalCrop(canvas, 0.24, 0.52), mode: block },
      { image: verticalCrop(canvas, 0.52, 0.48), mode: sparse },
    ];
    for (const pass of passes) {
      const mode = pass.mode;
      await worker.setParameters({ tessedit_pageseg_mode: mode });
      results.push(await worker.recognize(pass.image));
    }
    const result = results.sort((a, b) => {
      const signal = (entry) => {
        const text = extractOcrLines(entry.data?.text || '').join(' ');
        const words = tokens(text).filter((token) => token.length >= 3).length;
        const characters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
        return Math.min(words, 8) * 5 + Math.min(characters, 80) * 0.5 +
          (Number(entry.data?.confidence) || 0) * 2;
      };
      return signal(b) - signal(a);
    })[0];
    return {
      text: result.data?.text || '',
      confidence: Number(result.data?.confidence) || 0,
    };
  } finally {
    await worker.terminate();
  }
}
