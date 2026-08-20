// SPDX-License-Identifier: GPL-3.0-or-later
// UI orchestration: paste → parse → fetch metadata → render cards.

import { parseInput, looksLikeLink } from './parsers.mjs';
import { regionFromLocale, buildQuery, sourceCardKeys, shareHashFor, linkFromHash } from './links.mjs';
import {
  fetchMetadata, findExactLinks, parseFreeText,
  fetchDeezerIsrc, findLinksByIsrc, fetchDeezerUpc, findLinksByUpc,
} from './adapters.mjs';
import { cardModels, cardSignature } from './cards.mjs';
import { iconSvg } from './icons.mjs';

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
  copyMeta: $('#copy-meta'),
  share: $('#share'),
};

const region = regionFromLocale(navigator.language);

const state = {
  parsed: null,
  exact: {},        // platformKey → exact URL
  sourceKeys: [],   // platform keys covered by the pasted link itself
  isrc: '',         // from Deezer — unlocks the MusicBrainz link lookup
  isrcChecked: '',  // last ISRC already sent to MusicBrainz (1 req/s budget)
  isrcFrom: '',     // Deezer track id whose ISRC fetch already started
  upc: '',          // from Deezer album — unlocks the MusicBrainz barcode lookup
  upcChecked: '',   // last UPC already sent to MusicBrainz
  upcFrom: '',      // Deezer album id whose UPC fetch already started
  artistChips: null, // { title, names, picked, itunesDown } — chips survive rounds
  generation: 0,    // invalidates in-flight fetches when input changes
};

// The entity kind of the current session — free text has no parsed link
// and behaves like a track.
const currentKind = () => state.parsed?.kind || 'track';

function setStatus(text, tone = 'info') {
  el.status.textContent = text || '';
  el.status.dataset.tone = tone;
  el.status.hidden = !text;
}

// Title-only lookups on an ambiguous title ("Cooked") can't know which
// artist the pasted item belongs to — offer catalog candidates as
// one-click chips. state.artistChips is keyed by the title so a later
// enrich round WITHOUT candidates (e.g. after the auto-artist fill) can't
// wipe fresh chips, and a title edit invalidates them implicitly.
// Clicking runs the normal manual-edit path (invalidate + re-enrich), so
// the full match cascade follows.
function showArtistChips() {
  const chips = state.artistChips;
  if (!chips || chips.title !== el.title.value.trim()) return false;
  // Hide whoever is currently in the field — chips.picked only feeds the
  // prefix wording, so a manual edit re-offers the previously picked name.
  const current = el.artist.value.trim();
  const names = chips.names.filter((n) => n !== current);
  if (!names.length) return false;
  el.status.textContent = '';
  el.status.dataset.tone = 'info';
  const prefix = chips.picked || el.artist.value.trim()
    ? 'Not right? '
    : (chips.itunesDown ? 'Apple Music is rate-limiting — pick the artist: ' : 'Which artist? ');
  el.status.append(prefix);
  names.forEach((name, i) => {
    if (i) el.status.append(' ');
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = name;
    chip.addEventListener('click', () => {
      state.artistChips.picked = name;
      el.artist.value = name;
      el.artist.dispatchEvent(new Event('input', { bubbles: true }));
    });
    el.status.appendChild(chip);
  });
  el.status.hidden = false;
  return true;
}

// Status line after an enrich round: never clobber a warn note (Qobuz,
// Bandcamp, SoundCloud explain themselves there), prefer chips, else be
// honest about a missing artist — except for artist/playlist links, where
// no artist resolution exists by design.
function updateStatusLine(kind) {
  if (!el.status.hidden && el.status.dataset.tone === 'warn') return;
  if (showArtistChips()) return;
  if (!el.artist.value.trim() && el.title.value.trim()
      && kind !== 'artist' && kind !== 'playlist') {
    setStatus('Artist unknown — add it above for better matches.', 'info');
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// All values land in the DOM via createElement/textContent/properties —
// never via innerHTML — so API-supplied URLs and titles cannot inject
// markup. The only insertAdjacentHTML is our own static icon SVG.
function buildCard(m) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.platform = m.key;
  card.dataset.sig = cardSignature(m);

  const row = document.createElement('div');
  row.className = 'card-row';
  row.insertAdjacentHTML('beforeend', iconSvg(m.key));

  const body = document.createElement('div');
  body.className = 'card-body';
  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = m.name;
  const badge = document.createElement('span');
  badge.className = `badge badge-${m.badge}`;
  badge.textContent = m.badge;
  if (m.viaCode) {
    badge.title = m.codeKind === 'upc'
      ? 'Search by barcode (UPC) — usually lands on exactly the right album'
      : 'Search by ISRC — usually lands on exactly the right track';
  }
  body.append(name, badge);
  row.appendChild(body);

  if (m.embed) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-preview';
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.dataset.src = m.embed.src;
    btn.dataset.height = m.embed.height || '';
    btn.dataset.aspect = m.embed.aspect || '';
    btn.title = `Load the ${m.name} preview player (third-party content)`;
    btn.textContent = 'Preview';
    row.appendChild(btn);
  }
  if (m.app) {
    const app = document.createElement('a');
    app.className = 'btn btn-app';
    app.href = m.app.href;
    app.title = m.app.title;
    app.textContent = 'App';
    row.appendChild(app);
  }

  const open = document.createElement('a');
  open.className = 'btn btn-open';
  open.href = m.url;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.textContent = 'Open';
  row.appendChild(open);

  const copy = document.createElement('button');
  copy.className = 'btn btn-copy';
  copy.type = 'button';
  copy.dataset.url = m.url;
  copy.setAttribute('aria-label', `Copy ${m.name} link`);
  copy.textContent = 'Copy';
  row.appendChild(copy);

  const slot = document.createElement('div');
  slot.className = 'embed-slot';
  slot.hidden = true;
  card.append(row, slot);
  return card;
}

// Differential render: a card whose signature is unchanged keeps its DOM,
// so an open preview iframe survives typing in the artist/title fields.
function syncCards(models) {
  const wanted = new Set(models.map((m) => m.key));
  for (const child of [...el.cards.children]) {
    if (!wanted.has(child.dataset.platform)) child.remove();
  }
  let anchor = null; // last correctly placed card
  for (const m of models) {
    let card = [...el.cards.children].find((c) => c.dataset.platform === m.key);
    if (!card || card.dataset.sig !== cardSignature(m)) {
      const fresh = buildCard(m);
      if (card) card.replaceWith(fresh);
      card = fresh;
    }
    const ref = anchor ? anchor.nextElementSibling : el.cards.firstElementChild;
    if (card !== ref) el.cards.insertBefore(card, ref);
    anchor = card;
  }
}

function render() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const models = cardModels(
    { exact: state.exact, sourceKeys: state.sourceKeys, kind: currentKind(), isrc: state.isrc, upc: state.upc },
    { artist: el.artist.value, title: el.title.value },
    region, dark
  );
  el.results.hidden = models.length === 0;
  if (el.results.hidden) {
    el.cards.replaceChildren();
    return;
  }
  syncCards(models);
}

// Click-to-load: the iframe (and its third-party requests) only exists
// after the user asks for it; a second click removes it again.
function togglePreview(btn) {
  const slot = btn.closest('.card').querySelector('.embed-slot');
  const open = !slot.hidden;
  slot.replaceChildren();
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

el.copyMeta.addEventListener('click', () => {
  const text = [el.artist.value.trim(), el.title.value.trim()].filter(Boolean).join(' - ');
  if (text) copyText(text, el.copyMeta);
});

el.share.addEventListener('click', async () => {
  const url = location.href;
  const text = buildQuery(el.artist.value, el.title.value);
  if (navigator.share) {
    try {
      await navigator.share({ title: 'musiclinkii', text, url });
      return;
    } catch { /* user cancelled or unsupported payload — fall back to copy */ }
  }
  copyText(url, el.share);
});

const enrich = debounce(async () => {
  const gen = state.generation;
  const artist = el.artist.value.trim();
  const title = el.title.value.trim();
  if (!title) return;
  try {
    const kind = currentKind();
    const found = await findExactLinks({ artist, title, kind }, region);
    if (gen !== state.generation) return;
    if (found.artist && !el.artist.value.trim()) {
      // Assigned directly, WITHOUT dispatching an input event: the field
      // listener would run invalidateMatches() and wipe the dedupe guards
      // (isrcFrom/upcChecked) that keep round 2 from redoing work.
      el.artist.value = found.artist;
      // The artist was found in this round — run one more round so the
      // artist-dependent lookups (iTunes exact match) can use it.
      enrich();
    }
    for (const key of ['deezer', 'appleMusic']) {
      if (found[key] && !state.sourceKeys.includes(key)) state.exact[key] = found[key];
    }
    // Only a round WITH candidates may overwrite the chips — round 2
    // (artist known, no candidates returned) must leave them standing.
    if (found.artistCandidates?.length) {
      state.artistChips = {
        title,
        // Keep the auto-pick in the pool: after a correction it becomes a
        // chip again, so a wrong correction has a one-click way back.
        names: found.artist ? [found.artist, ...found.artistCandidates] : found.artistCandidates,
        picked: found.artist || '',
        itunesDown: Boolean(found.itunesDown),
      };
    }
    updateStatusLine(kind);
    render();
    if (kind === 'album') await enrichViaUpc(gen);
    else await enrichViaIsrc(gen);
  } catch { /* search links stay — enrichment is best effort */ }
}, 500);

// Second best-effort stage: ISRC → MusicBrainz URL relations. This is
// the only keyless path to an exact Spotify link (Spotify has no keyless
// search); coverage is community-driven, so failures are silent.
// Measured 2026-08-20 (Issue #1): MB recording *search* and alternate
// Deezer ISRCs both add zero hits over this path — the gap is missing
// Spotify URL relations in MB itself, not the lookup route.
async function enrichViaIsrc(gen) {
  try {
    let isrc = state.isrc;
    // Derive the ISRC from a Deezer *match* only — after a manual edit the
    // pasted source track no longer describes what the fields say.
    if (!isrc && state.exact.deezer && !state.sourceKeys.includes('deezer')) {
      const dz = parseInput(state.exact.deezer);
      if (dz.ok && dz.platform === 'deezer' && dz.kind === 'track' && state.isrcFrom !== dz.id) {
        state.isrcFrom = dz.id;
        isrc = await fetchDeezerIsrc(dz.id);
        if (gen !== state.generation) return;
        state.isrc = isrc;
        // A fresh ISRC upgrades the Spotify card to an isrc: search — show
        // that BEFORE the MusicBrainz round-trip, which may 404 and throw.
        if (isrc) render();
      }
    }
    if (!isrc || state.isrcChecked === isrc) return;
    state.isrcChecked = isrc;
    const links = await findLinksByIsrc(isrc);
    if (gen !== state.generation) return;
    let added = false;
    for (const [key, url] of Object.entries(links)) {
      if (!state.exact[key] && !state.sourceKeys.includes(key)) {
        state.exact[key] = url;
        added = true;
      }
    }
    if (added) render();
  } catch { /* best effort — search links stay */ }
}

// Album analog of enrichViaIsrc: Deezer album → UPC (barcode) → MusicBrainz
// release URL relations → exact album links. Spotify's own upc: search is
// measured dead (ENDPOINTS.md) — MB is the only keyless path to an exact
// Spotify album link.
async function enrichViaUpc(gen) {
  try {
    let upc = state.upc;
    // Derive the UPC from a Deezer *match* only — after a manual edit the
    // pasted source album no longer describes what the fields say.
    if (!upc && state.exact.deezer && !state.sourceKeys.includes('deezer')) {
      const dz = parseInput(state.exact.deezer);
      if (dz.ok && dz.platform === 'deezer' && dz.kind === 'album' && state.upcFrom !== dz.id) {
        state.upcFrom = dz.id;
        upc = await fetchDeezerUpc(dz.id);
        if (gen !== state.generation) return;
        state.upc = upc;
        // A fresh UPC upgrades the YT Music card to a barcode search — show
        // that BEFORE the MusicBrainz round-trip, which may 404 and throw.
        if (upc) render();
      }
    }
    if (!upc || state.upcChecked === upc) return;
    state.upcChecked = upc;
    const links = await findLinksByUpc(upc);
    if (gen !== state.generation) return;
    let added = false;
    for (const [key, url] of Object.entries(links)) {
      if (!state.exact[key] && !state.sourceKeys.includes(key)) {
        state.exact[key] = url;
        added = true;
      }
    }
    if (added) render();
  } catch { /* best effort — search links stay */ }
}

function resetTrack() {
  state.parsed = null;
  state.exact = {};
  state.sourceKeys = [];
  state.isrc = '';
  state.isrcChecked = '';
  state.isrcFrom = '';
  state.upc = '';
  state.upcChecked = '';
  state.upcFrom = '';
  state.artistChips = null;
  el.artist.value = '';
  el.title.value = '';
  el.thumb.hidden = true;
  el.thumb.removeAttribute('src');
  el.track.hidden = true;
  el.results.hidden = true;
  el.cards.replaceChildren();
}

// A manual artist/title edit means every found match may now be wrong:
// invalidate in-flight enrichment and drop everything except the source
// link itself, then let enrich() re-derive matches for the new words.
// state.artistChips survives on purpose — the candidates describe the
// TITLE, not the matches, and self-invalidate when the title changes.
function invalidateMatches() {
  state.generation++;
  state.exact = {};
  if (state.parsed) for (const key of state.sourceKeys) state.exact[key] = state.parsed.url;
  state.isrc = '';
  state.isrcChecked = '';
  state.isrcFrom = '';
  state.upc = '';
  state.upcChecked = '';
  state.upcFrom = '';
  lastHandled = null; // re-pasting the same link must reset the edits
}

let lastHandled = null; // dedupes the paste-event + input-event double fire

async function handleInput() {
  const raw = el.input.value;
  if (raw === lastHandled) return;
  lastHandled = raw;
  state.generation++;
  const gen = state.generation;
  resetTrack();

  if (!raw.trim()) {
    setStatus('');
    history.replaceState(null, '', location.pathname + location.search);
    return;
  }

  // Non-link text ("Will Smith - Miami") is a search request, not an
  // error: split it into the fields and run the normal enrich pipeline —
  // no source card, no metadata fetch. The hash keeps text shareable too.
  if (!looksLikeLink(raw)) {
    const parts = parseFreeText(raw);
    if (!parts) {
      setStatus('');
      history.replaceState(null, '', location.pathname + location.search);
      return;
    }
    history.replaceState(null, '', location.pathname + location.search + shareHashFor(raw));
    el.artist.value = parts.artist;
    el.title.value = parts.title;
    el.track.hidden = false;
    setStatus('No link detected — building search links from the text.', 'info');
    render();
    enrich();
    return;
  }

  const parsed = parseInput(raw);
  // Keep the address bar shareable: the pasted link travels in the hash.
  history.replaceState(null, '', location.pathname + location.search + (parsed.ok ? shareHashFor(raw) : ''));
  if (!parsed.ok) {
    if (parsed.reason === 'shortlink' || parsed.reason === 'smartlink') setStatus(parsed.note, 'warn');
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
    if (meta.isrc) state.isrc = meta.isrc;
    if (meta.upc) state.upc = meta.upc;
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
// Paste still resolves instantly; the trailing input event is deduped by
// lastHandled instead of running the whole pipeline a second time.
el.input.addEventListener('paste', () => setTimeout(handleInput, 0));

for (const field of [el.artist, el.title]) {
  field.addEventListener('input', () => {
    invalidateMatches();
    render();
    enrich();
  });
}

// Arriving via a share link (#l=…): populate and resolve immediately.
const sharedLink = linkFromHash(location.hash);
if (sharedLink) {
  el.input.value = sharedLink;
  handleInput();
}

el.input.focus();
