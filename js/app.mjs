// SPDX-License-Identifier: GPL-3.0-or-later
// UI orchestration around ONE commit path: pasted link, free text and the
// artist/title form all land in commitSearch(), which owns the generation,
// the result reset, the surface sync, the share hash and the lookup
// pipeline. Typing never triggers lookups; "Next search" is the only reset.

import { parseInput, looksLikeLink } from './parsers.mjs';
import { PLATFORMS, regionFromLocale, buildQuery, sourceCardKeys, shareHashFor, linkFromHash } from './links.mjs';
import {
  fetchMetadata, findExactLinks, findArtistLinks, findLinksByArtist, parseFreeText,
  fetchDeezerIsrc, findLinksByIsrc, fetchDeezerUpc, findLinksByUpc,
} from './adapters.mjs';
import { cardModels, cardSignature } from './cards.mjs';
import { iconSvg } from './icons.mjs';

const $ = (sel) => document.querySelector(sel);

const el = {
  input: $('#link-input'),
  status: $('#status'),
  note: $('#note'),
  suggest: $('#suggest'),
  track: $('#track'),
  thumb: $('#thumb'),
  artist: $('#artist-input'),
  title: $('#title-input'),
  results: $('#results'),
  cards: $('#cards'),
  copyAll: $('#copy-all'),
  copyMeta: $('#copy-meta'),
  share: $('#share'),
  nextLink: $('#next-link'),
  go: $('#go'),
  openSearch: $('#open-search'),
  formSearch: $('#form-search'),
  kindToggle: $('#kind-toggle'),
  titleLabel: $('#title-label'),
};

const region = regionFromLocale(navigator.language);

const KINDS = ['track', 'album', 'artist'];

const state = {
  parsed: null,
  exact: {},        // platformKey → exact URL
  sourceKeys: [],   // platform keys covered by the pasted link itself
  sourceTracks: [], // the source artist's top titles — identity probe for catalog picks
  isrc: '',         // from Deezer — unlocks the MusicBrainz link lookup
  isrcChecked: '',  // last ISRC already sent to MusicBrainz (1 req/s budget)
  isrcFrom: '',     // Deezer track id whose ISRC fetch already started
  upc: '',          // from Deezer album — unlocks the MusicBrainz barcode lookup
  upcChecked: '',   // last UPC already sent to MusicBrainz
  upcFrom: '',      // Deezer album id whose UPC fetch already started
  artistChips: null, // { title, names, itunesDown } — chips survive rounds
  kind: 'track',    // form/free-text kind, picked via the Track/Album/Artist toggle
  pending: new Set(), // platform keys whose exact-link stage has not settled
  generation: 0,    // invalidates in-flight fetches when input changes
};

// The entity kind of the current session — a parsed link dictates it,
// free text and the form follow the kind toggle.
const currentKind = () => state.parsed?.kind || state.kind;

// The title field doubles as the album field — its label follows the
// session kind, and artist searches need no title at all.
function syncKindUi() {
  const kind = currentKind();
  const artistOnly = kind === 'artist';
  el.titleLabel.hidden = artistOnly;
  el.title.hidden = artistOnly;
  const label = kind === 'album' ? 'Album' : 'Title';
  el.titleLabel.textContent = label;
  el.title.placeholder = label;
}

function syncKindToggle() {
  for (const b of el.kindToggle.querySelectorAll('.kind-btn')) {
    b.setAttribute('aria-pressed', String(b.dataset.kind === state.kind));
  }
}

// --- Status lines: one owner each, no cross-guards. #status carries the
// pipeline phase and outcome, #note source caveats, #suggest the chips.
function setLine(node, text, tone = 'info') {
  node.textContent = text || '';
  node.dataset.tone = tone;
  node.hidden = !text;
  delete node.dataset.busy;
}

function setStatus(text, tone = 'info') {
  setLine(el.status, text, tone);
}

function setNote(text) {
  setLine(el.note, text, 'warn');
}

// Progress line for a lookup phase, with animated dots. Always writes —
// warnings and chips live on their own lines.
function setPhase(text) {
  setStatus(text);
  el.status.dataset.busy = '1';
}

// Phase lines are transient: if one is still standing when the pipeline
// ends (error, early return), drop it — outcomes write their own line.
function clearPhase() {
  if (el.status.dataset.busy) setStatus('');
}

// Title-only lookups on an ambiguous title ("Cooked") can't know which
// artist the pasted item belongs to — offer catalog candidates as
// one-click chips on their own line. state.artistChips is keyed by the
// title so a later round WITHOUT candidates can't wipe fresh chips, and a
// title edit invalidates them implicitly. A chip click is a normal form
// commit, so the full match cascade follows.
function showArtistChips() {
  const chips = state.artistChips;
  const current = el.artist.value.trim();
  const names = chips && chips.title === el.title.value.trim()
    ? chips.names.filter((n) => n !== current)
    : [];
  el.suggest.replaceChildren();
  el.suggest.hidden = !names.length;
  if (!names.length) return;
  const prefix = current
    ? 'Not right? '
    : (chips.itunesDown ? 'Apple Music is rate-limiting — pick the artist: ' : 'Which artist? ');
  el.suggest.append(prefix);
  names.forEach((name, i) => {
    if (i) el.suggest.append(' ');
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = name;
    chip.addEventListener('click', () => {
      el.artist.value = name;
      commitFromFields();
    });
    el.suggest.appendChild(chip);
  });
}

// Outcome line after a lookup round. Chips render on their own line, so
// outcome and suggestion coexist.
function updateOutcome(kind) {
  showArtistChips();
  if (!el.artist.value.trim() && el.title.value.trim()
      && kind !== 'artist' && kind !== 'playlist') {
    setStatus('Artist unknown — add it above for better matches.');
    return;
  }
  const matches = Object.keys(state.exact).filter((k) => !state.sourceKeys.includes(k)).length;
  if (matches) {
    setStatus(`${matches} exact ${matches === 1 ? 'match' : 'matches'} found — the other cards open searches.`);
  } else if ((el.title.value.trim() || kind === 'artist') && kind !== 'playlist') {
    setStatus('No exact matches — every card opens a search.');
  }
}

// All values land in the DOM via createElement/textContent/properties —
// never via innerHTML — so API-supplied URLs and titles cannot inject
// markup. The only insertAdjacentHTML is our own static icon SVG.
function buildCard(m) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.platform = m.key;
  card.dataset.sig = cardSignature(m);
  if (m.pending) card.dataset.pending = '1';

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
    {
      exact: state.exact, sourceKeys: state.sourceKeys, kind: currentKind(),
      isrc: state.isrc, upc: state.upc, pending: state.pending,
    },
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
    setNote('Clipboard unavailable — copy the link manually.');
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

// --- Query model: what a commit is made of. A query is either a link
// ({ link, parsed, origin }) or a structured search ({ kind, artist,
// title, origin }); origin says which surface committed it.

function inputQuery() {
  const raw = el.input.value.trim();
  if (!raw) return null;
  if (looksLikeLink(raw)) return { link: raw, parsed: parseInput(raw), origin: 'input' };
  const parts = parseFreeText(raw, state.kind);
  if (!parts) return null;
  return { kind: state.kind, artist: parts.artist, title: parts.title, origin: 'input' };
}

function fieldsQuery() {
  const kind = currentKind();
  const artist = el.artist.value.trim();
  const title = kind === 'artist' ? '' : el.title.value.trim();
  if (!artist && !title) return null;
  return { kind, artist, title, origin: 'fields' };
}

// Canonical text for a structured query — what the main input and the
// share hash carry.
function queryText(q) {
  if (q.kind === 'artist') return q.artist;
  return [q.artist, q.title].filter(Boolean).join(' - ');
}

function queryKey(q) {
  return q.link ? `link:${q.link}` : `${q.kind}:${q.artist}\n${q.title}`;
}

// --- Result state. resetResults touches results only — never the input
// surfaces; keepSource preserves a link session's own cards through a
// fields refinement. artistChips survive on purpose: they describe the
// TITLE and self-invalidate when it changes.
function resetResults({ keepSource = false } = {}) {
  if (!keepSource) {
    state.parsed = null;
    state.sourceKeys = [];
    state.sourceTracks = [];
  }
  state.exact = {};
  for (const key of state.sourceKeys) state.exact[key] = state.parsed.url;
  state.isrc = '';
  state.isrcChecked = '';
  state.isrcFrom = '';
  state.upc = '';
  state.upcChecked = '';
  state.upcFrom = '';
  state.pending = new Set();
}

// A manual artist/title edit means every found match may now be wrong:
// invalidate in-flight lookups and drop everything except the source link
// itself — the next commit re-derives matches for the new words.
function invalidateMatches() {
  state.generation += 1;
  resetResults({ keepSource: Boolean(state.parsed) });
}

function hideTrack() {
  el.artist.value = '';
  el.title.value = '';
  el.thumb.hidden = true;
  el.thumb.removeAttribute('src');
  el.track.hidden = true;
  el.kindToggle.hidden = false;
  el.openSearch.hidden = false;
}

// Keep both input surfaces telling the same story. A fields commit inside
// a link session keeps the pasted link in the main input (and its hash) —
// the source card must stay explicable.
function syncSurfaces(q) {
  if (q.link) {
    el.input.value = q.link;
    el.artist.value = '';
    el.title.value = '';
    el.kindToggle.hidden = true; // the parsed link dictates the kind
  } else {
    el.artist.value = q.artist;
    el.title.value = q.title;
    if (!state.parsed) el.input.value = queryText(q);
    el.kindToggle.hidden = Boolean(state.parsed);
  }
  if (q.link || !state.parsed) {
    el.thumb.hidden = true;
    el.thumb.removeAttribute('src');
  }
  el.track.hidden = false;
  el.openSearch.hidden = true;
}

// The permalink always mirrors the committed query; only a link that
// failed to parse gets none. A fields commit inside a link session keeps
// the link hash it already has.
function writeHash(q) {
  if (!q.link && state.parsed) return;
  const hash = q.link
    ? (q.parsed.ok ? shareHashFor(q.link) : '')
    : shareHashFor(queryText(q), q.kind);
  history.replaceState(null, '', location.pathname + location.search + hash);
}

// --- Per-card pending: "an exact link for this card may still arrive".
// Seeded per commit (only when a lookup will actually run), narrowed as
// stages settle, keyed to the generation so a stale pipeline can never
// mutate a newer commit's set. resetResults re-creates the Set on every
// commit — there is no counter, so nothing can leak or drift.
function seedPending(q) {
  const kind = currentKind();
  const willLookup = q.link
    ? KINDS.includes(kind)
    : (kind === 'artist' ? Boolean(q.artist) : Boolean(q.title));
  state.pending = new Set(
    willLookup ? PLATFORMS.map((p) => p.key).filter((k) => !state.sourceKeys.includes(k)) : []
  );
}

function settlePending(keys, gen) {
  if (gen !== state.generation) return;
  if (keys === 'all') state.pending.clear();
  else for (const k of keys) state.pending.delete(k);
}

// --- The ONE commit path. Every trigger (input Enter/paste/magnifier,
// form Enter/Search, chip click, share hash on load) lands here.
let running = null; // { key, gen } — guards an identical query still in flight

async function commitSearch(q) {
  if (!q) return;
  const key = queryKey(q);
  // Drop only an identical query that is STILL running for the current
  // generation — a finished or invalidated run may be committed again.
  if (running && running.key === key && running.gen === state.generation) return;
  state.generation += 1;
  const gen = state.generation;
  running = { key, gen };
  setStatus('');
  setNote('');
  setLine(el.suggest, '');
  try {
    if (q.link) {
      resetResults();
      writeHash(q);
      if (!q.parsed.ok) {
        hideTrack();
        render();
        if (q.parsed.reason === 'shortlink' || q.parsed.reason === 'smartlink') setNote(q.parsed.note);
        else setNote('That doesn’t look like a music link from a known platform.');
        return;
      }
      state.parsed = q.parsed;
      state.sourceKeys = sourceCardKeys(q.parsed);
      for (const k of state.sourceKeys) state.exact[k] = q.parsed.url;
      syncSurfaces(q);
      syncKindUi();
      seedPending(q);
      render();
      await runLinkPipeline(q, gen);
    } else {
      // A fields commit refines the session on screen (source card stays);
      // a main-input commit starts a fresh one.
      resetResults({ keepSource: q.origin === 'fields' && Boolean(state.parsed) });
      if (!state.parsed) state.kind = q.kind;
      syncSurfaces(q);
      writeHash(q);
      syncKindUi();
      seedPending(q);
      render();
      await runLookup(gen);
    }
  } catch { /* every stage is best effort — search links stay */ }
  finally {
    if (running && running.gen === gen) running = null;
    if (gen === state.generation) clearPhase();
  }
}

function commitFromInput() {
  commitSearch(inputQuery());
}

function commitFromFields() {
  commitSearch(fieldsQuery());
}

// "Next search": one click back to a clean slate — the only reset.
function resetAll() {
  state.generation += 1; // invalidate anything in flight
  running = null;
  resetResults();
  state.artistChips = null;
  el.input.value = '';
  hideTrack();
  setStatus('');
  setNote('');
  setLine(el.suggest, '');
  el.results.hidden = true;
  el.cards.replaceChildren();
  history.replaceState(null, '', location.pathname + location.search);
  syncKindUi();
}

// --- Pipeline. Link sessions fetch source metadata first, then everything
// funnels into runLookup, whose finally-block settles the pending set.

async function runLinkPipeline(q, gen) {
  setPhase('Looking up track info');
  try {
    const meta = await fetchMetadata(q.parsed);
    if (gen !== state.generation) return;
    el.artist.value = meta.artist || '';
    el.title.value = meta.title || '';
    // Spotify artist pages: oEmbed puts the artist name in the title.
    if (q.parsed.kind === 'artist' && !el.artist.value && el.title.value) {
      el.artist.value = el.title.value;
      el.title.value = '';
    }
    if (meta.thumb) {
      el.thumb.src = meta.thumb;
      el.thumb.hidden = false;
    }
    Object.assign(state.exact, meta.exact || {});
    if (meta.tracks?.length) state.sourceTracks = meta.tracks;
    if (meta.isrc) state.isrc = meta.isrc;
    if (meta.upc) state.upc = meta.upc;
    for (const k of state.sourceKeys) state.exact[k] = q.parsed.url;
    if (meta.note) setNote(meta.note);
  } catch {
    if (gen !== state.generation) return;
    setNote('Couldn’t fetch track info — enter artist and title to build the links.');
  }
  render();
  await runLookup(gen);
}

// Merge one catalog round into state and the form fields. Field values are
// assigned directly, WITHOUT dispatching input events: the field listener
// would run invalidateMatches() and wipe the dedupe guards
// (isrcFrom/upcChecked) that keep later rounds from redoing work.
function applyFound(found) {
  if (found.artist && !el.artist.value.trim()) el.artist.value = found.artist;
  // A confirmed catalog match upgrades the display: cover art for any
  // session still missing one, canonical spelling for text/form sessions
  // (pasted links keep their own fetched metadata).
  if (found.thumb && el.thumb.hidden) {
    el.thumb.src = found.thumb;
    el.thumb.hidden = false;
  }
  if (!state.parsed) {
    if (found.canonicalArtist) el.artist.value = found.canonicalArtist;
    if (found.canonicalTitle) el.title.value = found.canonicalTitle;
  }
  for (const key of ['deezer', 'appleMusic']) {
    if (found[key] && !state.sourceKeys.includes(key)) state.exact[key] = found[key];
  }
  // Only a round WITH candidates may overwrite the chips — a round with
  // the artist known (no candidates returned) must leave them standing.
  // Keyed by the field value, which canonicalization may just have
  // changed — the chips must describe what the title field shows NOW.
  if (found.artistCandidates?.length) {
    state.artistChips = {
      title: el.title.value.trim(),
      // Keep the auto-pick in the pool: after a correction it becomes a
      // chip again, so a wrong correction has a one-click way back.
      names: found.artist ? [found.artist, ...found.artistCandidates] : found.artistCandidates,
      itunesDown: Boolean(found.itunesDown),
    };
  }
}

async function runLookup(gen) {
  const kind = currentKind();
  const artist = el.artist.value.trim();
  const title = el.title.value.trim();
  try {
    if (kind === 'artist') {
      await runArtistLookup(gen, artist);
      return;
    }
    if (kind !== 'track' && kind !== 'album') return; // playlists: nothing to match
    if (!title) return; // artist-only in track/album kind: search links only
    setPhase('Searching catalogs');
    const found = await findExactLinks({ artist, title, kind }, region, state.sourceKeys);
    if (gen !== state.generation) return;
    applyFound(found);
    // The artist was only just discovered — run one more catalog round so
    // the artist-dependent lookups (iTunes exact match) can use it.
    // Awaited sequentially: "the catalog stage is done" must be one
    // well-defined moment for the pending set to key on.
    if (found.artist && !artist) {
      const again = await findExactLinks(
        { artist: el.artist.value.trim(), title: el.title.value.trim(), kind },
        region, state.sourceKeys
      );
      if (gen !== state.generation) return;
      applyFound(again);
    }
    settlePending(['deezer', 'appleMusic'], gen);
    updateOutcome(kind);
    render();
    if (kind === 'album') await enrichViaUpc(gen);
    else await enrichViaIsrc(gen);
    if (gen !== state.generation) return;
    updateOutcome(kind);
  } finally {
    settlePending('all', gen);
    if (gen === state.generation) render();
  }
}

// Artist pipeline: catalog artist search (Deezer + iTunes), then the
// MusicBrainz artist fan-out. The pasted artist URL is the best anchor —
// it IS the identity; a catalog match is only a ranked guess.
async function runArtistLookup(gen, artist) {
  if (!artist) return;
  setPhase('Searching catalogs');
  const found = await findArtistLinks(
    { artist, tracks: state.sourceTracks }, region, state.sourceKeys
  );
  if (gen !== state.generation) return;
  applyFound(found);
  settlePending(['deezer', 'appleMusic'], gen);
  render();
  setPhase('Checking MusicBrainz for exact links');
  // Every known profile URL anchors the MB lookup — the pasted link AND
  // the catalog matches. MB may hold any one of them (one request either way).
  const anchorUrls = [state.parsed?.url, state.exact.deezer, state.exact.appleMusic];
  const links = await findLinksByArtist({ urls: anchorUrls, name: el.artist.value.trim() });
  if (gen !== state.generation) return;
  for (const [key, url] of Object.entries(links)) {
    if (!state.exact[key] && !state.sourceKeys.includes(key)) state.exact[key] = url;
  }
  render();
  updateOutcome('artist');
}

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
    setPhase('Checking MusicBrainz for exact links');
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
    setPhase('Checking MusicBrainz for exact links');
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

function setKind(kind) {
  if (state.kind === kind) return;
  state.kind = kind;
  syncKindToggle();
  syncKindUi();
  // A different kind means different entities — matches are stale, but
  // the search itself stays a deliberate commit away.
  invalidateMatches();
  render();
}

// --- Listeners. Typing stays quiet everywhere; only commits act.

el.nextLink.addEventListener('click', () => {
  resetAll();
  el.input.focus();
});

// The opener hides while text is present because the form is an
// alternative to typing, not a companion.
el.input.addEventListener('input', () => {
  if (el.track.hidden) el.openSearch.hidden = Boolean(el.input.value.trim());
});
// Paste is a complete entry — resolve it instantly, no extra click.
el.input.addEventListener('paste', () => setTimeout(commitFromInput, 0));
el.input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commitFromInput(); });
el.go.addEventListener('click', commitFromInput);

el.openSearch.addEventListener('click', () => {
  el.openSearch.hidden = true;
  el.track.hidden = false;
  el.artist.focus();
});

for (const field of [el.artist, el.title]) {
  // Typing only invalidates stale match badges on the visible cards —
  // the web lookups wait for the Search button, Enter, or a chip click.
  field.addEventListener('input', () => {
    invalidateMatches();
    render();
  });
  field.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commitFromFields(); });
}
el.formSearch.addEventListener('click', commitFromFields);

for (const btn of el.kindToggle.querySelectorAll('.kind-btn')) {
  btn.addEventListener('click', () => setKind(btn.dataset.kind));
}

// Arriving via a share link (#l=…): populate and resolve immediately.
const shared = linkFromHash(location.hash);
if (shared) {
  if (KINDS.includes(shared.kind)) state.kind = shared.kind;
  syncKindToggle();
  syncKindUi();
  el.input.value = shared.link;
  commitFromInput();
}

el.input.focus();
