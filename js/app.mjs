// SPDX-License-Identifier: GPL-3.0-or-later
// UI orchestration: paste → parse → fetch metadata → render cards.

import { parseInput } from './parsers.mjs';
import { PLATFORMS, regionFromLocale, buildQuery, sourceCardKeys } from './links.mjs';
import { fetchMetadata, findExactLinks } from './adapters.mjs';
import { iconSvg } from './icons.mjs';
import { embedFor, appLinkFor } from './embeds.mjs';

const $ = (sel) => document.querySelector(sel);

const el = {
  input: $('#link-input'),
  status: $('#status'),
  track: $('#track'),
  thumb: $('#thumb'),
  artist: $('#artist-input'),
  title: $('#title-input'),
  results: $('#results'),
  cards: $('#cards'),
  copyAll: $('#copy-all'),
};

const region = regionFromLocale(navigator.language);

const state = {
  parsed: null,
  exact: {},        // platformKey → exact URL
  sourceKeys: [],   // platform keys covered by the pasted link itself
  generation: 0,    // invalidates in-flight fetches when input changes
};

function setStatus(text, tone = 'info') {
  el.status.textContent = text || '';
  el.status.dataset.tone = tone;
  el.status.hidden = !text;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function render() {
  const query = buildQuery(el.artist.value, el.title.value);
  el.results.hidden = !query && Object.keys(state.exact).length === 0;
  if (el.results.hidden) return;

  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  el.cards.innerHTML = '';
  for (const p of PLATFORMS) {
    const exactUrl = state.exact[p.key];
    const isSource = state.sourceKeys.includes(p.key);
    const url = exactUrl || (query ? p.searchUrl(query, region) : null);
    if (!url) continue;

    // Exact URLs (source or match) are entities our own parser understands —
    // that's what unlocks embed previews and app links. Search URLs aren't.
    const entity = exactUrl ? parseInput(exactUrl) : null;
    const embed = entity ? embedFor(entity, dark) : null;
    const app = entity ? appLinkFor(entity) : null;

    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.platform = p.key;
    const badge = isSource ? 'source' : (exactUrl ? 'match' : 'search');
    card.innerHTML = `
      <div class="card-row">
        ${iconSvg(p.key)}
        <div class="card-body">
          <span class="card-name">${p.name}</span>
          <span class="badge badge-${badge}">${badge}</span>
        </div>
        ${embed ? `<button class="btn btn-preview" type="button" aria-expanded="false"
            data-src="${embed.src}" data-height="${embed.height || ''}" data-aspect="${embed.aspect || ''}"
            title="Load the ${p.name} preview player (third-party content)">Preview</button>` : ''}
        ${app ? `<a class="btn btn-app" href="${app.href}" title="${app.title}">App</a>` : ''}
        <a class="btn btn-open" href="${url}" target="_blank" rel="noopener noreferrer">Open</a>
        <button class="btn btn-copy" type="button" data-url="${url}" aria-label="Copy ${p.name} link">Copy</button>
      </div>
      <div class="embed-slot" hidden></div>
    `;
    el.cards.appendChild(card);
  }
}

// Click-to-load: the iframe (and its third-party requests) only exists
// after the user asks for it; a second click removes it again.
function togglePreview(btn) {
  const slot = btn.closest('.card').querySelector('.embed-slot');
  const open = !slot.hidden;
  slot.innerHTML = '';
  slot.hidden = open;
  btn.setAttribute('aria-expanded', String(!open));
  if (open) return;
  const iframe = document.createElement('iframe');
  iframe.src = btn.dataset.src;
  iframe.loading = 'lazy';
  iframe.allow = 'encrypted-media; fullscreen; clipboard-write';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  if (btn.dataset.aspect) iframe.style.aspectRatio = btn.dataset.aspect;
  else iframe.height = btn.dataset.height;
  slot.appendChild(iframe);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const old = button.textContent;
      button.textContent = 'Copied!';
      setTimeout(() => { button.textContent = old; }, 1200);
    }
  } catch {
    setStatus('Clipboard unavailable — copy the link manually.', 'warn');
  }
}

el.cards.addEventListener('click', (ev) => {
  const copyBtn = ev.target.closest('.btn-copy');
  if (copyBtn) copyText(copyBtn.dataset.url, copyBtn);
  const previewBtn = ev.target.closest('.btn-preview');
  if (previewBtn) togglePreview(previewBtn);
});

el.copyAll.addEventListener('click', () => {
  const lines = [...el.cards.querySelectorAll('.card')].map((card) => {
    const name = card.querySelector('.card-name').textContent;
    const url = card.querySelector('.btn-open').href;
    return `${name}: ${url}`;
  });
  copyText(lines.join('\n'), el.copyAll);
});

const enrich = debounce(async () => {
  const gen = state.generation;
  const artist = el.artist.value.trim();
  const title = el.title.value.trim();
  if (!title) return;
  try {
    const found = await findExactLinks({ artist, title }, region);
    if (gen !== state.generation) return;
    if (found.artist && !el.artist.value.trim()) {
      el.artist.value = found.artist;
      // The artist was found in this round — run one more round so the
      // artist-dependent lookups (iTunes exact match) can use it.
      enrich();
    }
    for (const key of ['deezer', 'appleMusic']) {
      if (found[key] && !state.sourceKeys.includes(key)) state.exact[key] = found[key];
    }
    if (!el.artist.value.trim() && el.title.value.trim()) {
      setStatus('Artist unknown — add it above for better matches.', 'info');
    }
    render();
  } catch { /* search links stay — enrichment is best effort */ }
}, 500);

function resetTrack() {
  state.exact = {};
  state.sourceKeys = [];
  el.artist.value = '';
  el.title.value = '';
  el.thumb.hidden = true;
  el.thumb.removeAttribute('src');
  el.track.hidden = true;
  el.results.hidden = true;
  el.cards.innerHTML = '';
}

async function handleInput() {
  const raw = el.input.value;
  state.generation++;
  const gen = state.generation;
  resetTrack();

  if (!raw.trim()) {
    setStatus('');
    return;
  }

  const parsed = parseInput(raw);
  if (!parsed.ok) {
    if (parsed.reason === 'shortlink') setStatus(parsed.note, 'warn');
    else setStatus('That doesn’t look like a music link from a known platform.', 'warn');
    return;
  }

  state.parsed = parsed;
  state.sourceKeys = sourceCardKeys(parsed);
  for (const key of state.sourceKeys) state.exact[key] = parsed.url;
  el.track.hidden = false;
  setStatus('Looking up track info…', 'info');

  try {
    const meta = await fetchMetadata(parsed);
    if (gen !== state.generation) return;
    el.artist.value = meta.artist || '';
    el.title.value = meta.title || '';
    if (meta.thumb) {
      el.thumb.src = meta.thumb;
      el.thumb.hidden = false;
    }
    Object.assign(state.exact, meta.exact || {});
    for (const key of state.sourceKeys) state.exact[key] = parsed.url;
    setStatus(meta.note || '', meta.note ? 'warn' : 'info');
  } catch {
    if (gen !== state.generation) return;
    setStatus('Couldn’t fetch track info — enter artist and title to build the links.', 'warn');
  }

  render();
  enrich();
}

el.input.addEventListener('input', debounce(handleInput, 250));
el.input.addEventListener('paste', () => setTimeout(handleInput, 0));

for (const field of [el.artist, el.title]) {
  field.addEventListener('input', () => {
    render();
    enrich();
  });
}

el.input.focus();
