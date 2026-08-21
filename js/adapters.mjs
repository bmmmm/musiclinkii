// SPDX-License-Identifier: GPL-3.0-or-later
// Metadata adapters — resolve a parsed link to { title, artist, thumb,
// exact } using only keyless endpoints reachable from the browser.
// CORS status of every endpoint was verified empirically 2026-08-19:
//   iTunes lookup/search  ACAO:*            → fetch()
//   YouTube oEmbed        origin reflection → fetch()
//   Spotify oEmbed        ACAO:*            → fetch() (title only, no artist)
//   Deezer API            no ACAO           → JSONP (officially supported)
//   MusicBrainz ws/2      ACAO:*            → fetch() (~1 req/s budget)
//   Tidal                 no usable keyless metadata endpoint

import { slugToWords, parseInput } from './parsers.mjs';

const TIMEOUT_MS = 8000;

async function getJson(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let jsonpCounter = 0;

function jsonp(url, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const cb = `__mlii_jsonp_${Date.now()}_${jsonpCounter++}`;
    const script = document.createElement('script');
    const cleanup = () => {
      delete window[cb];
      script.remove();
    };
    const timer = setTimeout(() => {
      // A script that still arrives later must find a callable — leave a
      // self-removing stub instead of deleting (avoids a ReferenceError).
      window[cb] = () => { delete window[cb]; };
      script.remove();
      reject(new Error('JSONP timeout'));
    }, timeoutMs);
    window[cb] = (data) => { clearTimeout(timer); cleanup(); resolve(data); };
    script.onerror = () => { clearTimeout(timer); cleanup(); reject(new Error('JSONP load error')); };
    script.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${cb}`;
    document.head.appendChild(script);
  });
}

// MusicBrainz allows ~1 req/s for anonymous clients — every MB call goes
// through one queue that spaces requests (fromTidal, findLinksByIsrc).
const MB_GAP_MS = 1100;
let mbChain = Promise.resolve();
let mbLast = 0;
function mbJson(pathAndQuery) {
  const run = mbChain.then(async () => {
    const wait = mbLast + MB_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    mbLast = Date.now();
    // no-store: Chrome caches MB's 503 throttle responses and re-serves
    // them without hitting the network (measured 2026-08-20) — a cached
    // 503 would poison every retry forever.
    const url = `https://musicbrainz.org/ws/2/${pathAndQuery}`;
    try {
      return await getJson(url, { cache: 'no-store' });
    } catch (err) {
      // MB 503s sporadically even under the 1 req/s budget (measured
      // 2026-08-20: one of three spaced calls throttled) — a single
      // longer-spaced retry recovers those without hammering.
      if (!/HTTP 503/.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, MB_GAP_MS * 2));
      mbLast = Date.now();
      return getJson(url, { cache: 'no-store' });
    }
  });
  mbChain = run.then(() => {}, () => {});
  return run;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Token-subset match: every word of the shorter string must appear as a
// whole word in the longer one. Substring matching is too lax — "kitchen"
// must not match "Kitchenware & Candybars".
export function looselyMatches(a, b) {
  const ta = normalize(a).split(' ').filter(Boolean);
  const tb = normalize(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const bigSet = new Set(big);
  return small.every((tok) => bigSet.has(tok));
}

// Strip video-title noise like "(Official Video)" / "[HD]".
export function cleanTitle(title) {
  return String(title || '')
    .replace(/[([][^)\]]*(official|video|audio|lyric|lyrics|visuali[sz]er|remaster(ed)?|hd|4k|mv)[^)\]]*[)\]]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Split a "Artist - Title" YouTube-style string.
export function splitDashTitle(title) {
  const idx = String(title || '').search(/\s[-–—]\s/);
  if (idx < 0) return null;
  const artist = title.slice(0, idx).trim();
  const rest = title.slice(idx).replace(/^\s[-–—]\s/, '').trim();
  if (!artist || !rest) return null;
  return { artist, title: rest };
}

// Free-text input ("Will Smith - Miami") → artist/title guess. The dash
// split is a guess — the fields stay editable, so a wrong or reversed
// split is one edit away. Artist searches are one field and never split:
// "Emerson, Lake & Palmer" must survive whole.
export function parseFreeText(raw, kind = 'track') {
  const text = cleanTitle((raw || '').trim());
  if (!text) return null;
  if (kind === 'artist') return { artist: text, title: '' };
  return splitDashTitle(text) || { artist: '', title: text };
}

const meta = (fields) => ({ title: '', artist: '', thumb: '', exact: {}, isrc: '', upc: '', note: '', ...fields });

async function fromApple(parsed) {
  const country = parsed.meta.storefront || 'us';
  if (parsed.kind === 'artist') {
    // entity=song makes ONE call carry the artist row (artistName/
    // artistLinkUrl — no title, no artwork) plus its top songs. The song
    // titles are the identity probe for the catalog matching downstream:
    // names collide ("GRETA" has five exact namesakes on Deezer), catalogs
    // don't.
    const data = await getJson(
      `https://itunes.apple.com/lookup?id=${parsed.id}&entity=song&limit=10&country=${country}`
    );
    const rows = data.results || [];
    const a = rows.find((r) => r.wrapperType === 'artist');
    if (!a) throw new Error('no iTunes result');
    return meta({
      artist: a.artistName || '',
      exact: a.artistLinkUrl ? { appleMusic: a.artistLinkUrl } : {},
      tracks: rows.filter((r) => r.wrapperType === 'track').map((r) => r.trackName).filter(Boolean),
    });
  }
  const data = await getJson(`https://itunes.apple.com/lookup?id=${parsed.id}&country=${country}`);
  const r = (data.results || [])[0];
  if (!r) throw new Error('no iTunes result');
  if (parsed.kind === 'track') {
    return meta({
      title: r.trackName || '',
      artist: r.artistName || '',
      thumb: r.artworkUrl100 || '',
      exact: r.trackViewUrl ? { appleMusic: r.trackViewUrl } : {},
    });
  }
  return meta({
    title: r.collectionName || r.trackName || '',
    artist: r.artistName || '',
    thumb: r.artworkUrl100 || '',
    exact: r.collectionViewUrl ? { appleMusic: r.collectionViewUrl } : {},
  });
}

async function fromDeezer(parsed) {
  const data = await jsonp(`https://api.deezer.com/${parsed.kind}/${parsed.id}`);
  if (!data || data.error) throw new Error('Deezer lookup failed');
  if (parsed.kind === 'artist') {
    // Artist objects carry name/picture, not title/artist.name. Top-track
    // titles ride along as the identity probe for catalog matching.
    let tracks = [];
    try {
      const top = await jsonp(`https://api.deezer.com/artist/${parsed.id}/top?limit=10`);
      tracks = (top?.data || []).map((t) => t.title).filter(Boolean);
    } catch { /* best effort — the probe is optional */ }
    return meta({
      artist: data.name || '',
      thumb: data.picture_medium || '',
      exact: data.link ? { deezer: data.link } : {},
      tracks,
    });
  }
  return meta({
    title: data.title || '',
    artist: data.artist?.name || '',
    thumb: data.album?.cover_medium || data.cover_medium || '',
    isrc: data.isrc || '',
    upc: data.upc || '',
    exact: data.link ? { deezer: data.link } : {},
  });
}

async function fromYoutube(parsed) {
  const watchUrl = `https://www.youtube.com/watch?v=${parsed.id}`;
  const data = await getJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`);
  const raw = data.title || '';
  const channel = data.author_name || '';
  let artist = '';
  let title = cleanTitle(raw);
  if (/ - Topic$/.test(channel)) {
    // Auto-generated YT Music uploads: channel is "<Artist> - Topic", title is clean.
    artist = channel.replace(/ - Topic$/, '');
  } else {
    const split = splitDashTitle(title);
    if (split) ({ artist, title } = split);
  }
  const exact = { youtube: watchUrl, youtubeMusic: `https://music.youtube.com/watch?v=${parsed.id}` };
  return meta({ title, artist, thumb: data.thumbnail_url || '', exact });
}

async function fromSpotify(parsed) {
  const data = await getJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(parsed.url)}`);
  // Spotify's oEmbed title is the bare track/album name — no artist field.
  return meta({ title: data.title || '', thumb: data.thumbnail_url || '' });
}

async function fromTidal(parsed) {
  // Best effort: MusicBrainz keeps URL relationships for many Tidal links —
  // recording rels for tracks, release rels for albums, artist rels for
  // artist pages (verified live 2026-08-20: album/1550545 → "Discovery",
  // artist/8847 → "Daft Punk"). The queried path must keep the pasted
  // entity kind: asking for track/{id} with an artist or video id is a
  // numeric-collision lottery that can return a foreign track's title.
  const album = parsed.kind === 'album';
  const artistPage = parsed.kind === 'artist';
  const rels = artistPage ? 'artist' : album ? 'release' : 'recording';
  // parsed.url preserves the original path kind — for videos that is /video/.
  const path = new URL(parsed.url).pathname;
  const candidates = [`https://tidal.com${path}`, `https://listen.tidal.com${path}`];
  for (const resource of candidates) {
    try {
      const data = await mbJson(
        `url/?resource=${encodeURIComponent(resource)}&inc=${rels}-rels&fmt=json`
      );
      if (artistPage) {
        const name = (data.relations || []).map((rel) => rel.artist?.name).find(Boolean);
        if (!name) continue;
        return meta({ artist: name });
      }
      const entity = (data.relations || []).map((rel) => (album ? rel.release : rel.recording)).find(Boolean);
      if (!entity) continue;
      let artist = '';
      try {
        const full = await mbJson(`${album ? 'release' : 'recording'}/${entity.id}?inc=artist-credits&fmt=json`);
        artist = (full['artist-credit'] || []).map((c) => c.name).join(', ');
      } catch { /* keep title-only result */ }
      return meta({ title: entity.title || '', artist });
    } catch { /* try next candidate */ }
  }
  throw new Error('no keyless metadata for Tidal');
}

async function fromSoundcloud(parsed) {
  try {
    const data = await getJson(
      `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(parsed.url)}`
    );
    // oEmbed title is usually "Title by Uploader".
    const m = String(data.title || '').match(/^(.*)\s+by\s+(.*)$/i);
    return meta({
      title: m ? m[1].trim() : data.title || '',
      artist: m ? m[2].trim() : data.author_name || '',
      thumb: data.thumbnail_url || '',
      exact: { soundcloud: parsed.url },
    });
  } catch {
    return meta({
      title: slugToWords(parsed.meta.slug),
      artist: '',
      exact: { soundcloud: parsed.url },
      note: 'SoundCloud metadata unavailable — guessed from the URL.',
    });
  }
}

function fromQobuz(parsed) {
  // No keyless CORS-open Qobuz endpoint exists (API is partner-keyed,
  // autosuggest is auth-gated) — guess from the URL, no network call.
  // Album slugs are "{album-title}-{artist}" (live-verified), so keeping
  // every slug word puts title AND artist into the search query.
  const words = slugToWords(parsed.meta?.slug);
  const note = words
    ? 'Qobuz has no keyless metadata API — guessed from the URL (slug holds title and artist together).'
    : 'Qobuz has no keyless metadata API — enter artist and title above.';
  if (parsed.kind === 'artist') {
    return meta({ artist: words, exact: { qobuz: parsed.url }, note });
  }
  return meta({ title: words, exact: { qobuz: parsed.url }, note });
}

function fromBandcamp(parsed) {
  return meta({
    title: slugToWords(parsed.meta.slug),
    artist: slugToWords(parsed.meta.artist),
    exact: { bandcamp: parsed.url },
    note: 'Bandcamp has no public metadata API — guessed from the URL.',
  });
}

function fromAmazon(parsed) {
  return meta({
    exact: { amazonMusic: parsed.url },
    note: 'Amazon Music has no keyless metadata API — enter artist and title above.',
  });
}

export async function fetchMetadata(parsed) {
  switch (parsed.platform) {
    case 'appleMusic': return fromApple(parsed);
    case 'deezer': return fromDeezer(parsed);
    case 'youtube': return fromYoutube(parsed);
    case 'spotify': return fromSpotify(parsed);
    case 'tidal': return fromTidal(parsed);
    case 'soundcloud': return fromSoundcloud(parsed);
    case 'bandcamp': return fromBandcamp(parsed);
    case 'qobuz': return fromQobuz(parsed);
    case 'amazonMusic': return fromAmazon(parsed);
    default: throw new Error(`no adapter for ${parsed.platform}`);
  }
}

// Best-effort exact matches on platforms with keyless search.
// Returns { deezer?, appleMusic?, artist?, title? } — artist/title are
// enrichment suggestions when the caller had no artist yet.
// Query variant of a title: drop bracketed suffixes ("(1985 12\" Mix)") and
// quotes — they add noise and rarely help matching.
export function searchableTitle(title) {
  const stripped = String(title || '')
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || String(title || '').replace(/"/g, '').trim();
}

// Feed a list of URLs through our own parser and keep the first hit per
// platform card. music.youtube.com links count for the YouTube Music card.
// wantKind is opt-in: the ISRC/UPC callers pass nothing (their rels are
// already entity-scoped), the artist fan-out filters to artist pages so a
// stray track/release rel can't land on an artist card.
export function mapUrlsToPlatforms(urls, wantKind = '') {
  const out = {};
  for (const url of urls || []) {
    const parsed = parseInput(url);
    if (!parsed.ok) continue;
    if (wantKind && parsed.kind !== wantKind) continue;
    const isYtMusic = parsed.platform === 'youtube' && parsed.meta?.music;
    const key = isYtMusic ? 'youtubeMusic' : parsed.platform;
    if (!out[key]) out[key] = isYtMusic ? `https://music.youtube.com/watch?v=${parsed.id}` : parsed.url;
  }
  return out;
}

// Deezer track lookup → ISRC (Deezer is the only keyless source of ISRCs).
export async function fetchDeezerIsrc(trackId) {
  const data = await jsonp(`https://api.deezer.com/track/${trackId}`);
  return data?.isrc || '';
}

// Deezer album lookup → UPC/barcode (the album analog of fetchDeezerIsrc).
export async function fetchDeezerUpc(albumId) {
  const data = await jsonp(`https://api.deezer.com/album/${albumId}`);
  if (!data || data.error) return '';
  const upc = String(data.upc || '').trim();
  // Guard against placeholder values like "0" — real barcodes are long digits.
  return /^\d{6,}$/.test(upc) ? upc : '';
}

// UPC → MusicBrainz release search → per-release URL relations → exact
// album links on other platforms (Spotify/Tidal/Qobuz/Deezer verified for
// Discovery, 2026-08-20). The search response carries no url-rels inline,
// so the two-step is mandatory; capped at 2 release lookups ≈ 3 throttled
// MB calls — that is the whole budget, don't raise it. Spotify's own upc:
// search filter is measured dead (see ENDPOINTS.md) — this is the only
// keyless path to an exact Spotify album link.
export async function findLinksByUpc(upc) {
  if (!upc) return {};
  const data = await mbJson(`release/?query=${encodeURIComponent(`barcode:${upc}`)}&fmt=json&limit=2`);
  const urls = [];
  for (const release of (data.releases || []).slice(0, 2)) {
    try {
      const full = await mbJson(`release/${release.id}?inc=url-rels&fmt=json`);
      urls.push(...(full.relations || []).map((rel) => rel.url?.resource).filter(Boolean));
    } catch { /* one missing release must not kill the other */ }
  }
  return mapUrlsToPlatforms(urls);
}

// ISRC → MusicBrainz recording URL relations → exact links on other
// platforms (notably Spotify, which has no keyless search). Community
// coverage: good for known tracks, absent for fresh releases — callers
// must treat this as best effort. Measured 2026-08-20: neither the MB
// recording search nor alternate Deezer ISRCs add any hits beyond this
// path (the rels simply don't exist in MB) — don't rebuild that idea.
export async function findLinksByIsrc(isrc) {
  if (!isrc) return {};
  const data = await mbJson(`isrc/${encodeURIComponent(isrc)}?fmt=json&inc=url-rels`);
  const urls = (data.recordings || [])
    .flatMap((rec) => (rec.relations || []).map((rel) => rel.url?.resource))
    .filter(Boolean);
  return mapUrlsToPlatforms(urls);
}

// --- Catalog search: one candidate shape for both catalogs and kinds ---
// { title, artist, link, id } — the selection logic below is written once
// and serves tracks and albums alike.

export function deezerCandidates(data, kind = 'track') {
  const rows = Array.isArray(data?.data) ? data.data : [];
  if (kind === 'artist') {
    // Artist rows carry name/picture_medium and no title. nb_fan is the
    // only keyless popularity signal — pickByName uses it to break ties
    // between same-named artists (Deezer's rank order does not).
    return rows
      .map((r) => ({
        title: '',
        artist: r.name || '',
        link: r.link || (r.id != null ? `https://www.deezer.com/artist/${r.id}` : ''),
        id: r.id != null ? String(r.id) : '',
        thumb: r.picture_medium || '',
        fans: Number(r.nb_fan) || 0,
      }))
      .filter((c) => c.artist && c.link);
  }
  return rows
    .map((r) => ({
      title: r.title || '',
      artist: r.artist?.name || '',
      link: r.link || (kind === 'album' && r.id ? `https://www.deezer.com/album/${r.id}` : ''),
      id: r.id != null ? String(r.id) : '',
      // Track rows carry the cover on the album object, album rows inline.
      thumb: r.album?.cover_medium || r.cover_medium || '',
    }))
    .filter((c) => c.title && c.link);
}

export function itunesCandidates(data, kind = 'track') {
  const rows = Array.isArray(data?.results) ? data.results : [];
  if (kind === 'artist') {
    // musicArtist rows: artistName/artistLinkUrl/artistId, no artwork.
    return rows
      .map((r) => ({ title: '', artist: r.artistName || '', link: r.artistLinkUrl || '', id: r.artistId != null ? String(r.artistId) : '', thumb: '' }))
      .filter((c) => c.artist && c.link);
  }
  return rows
    .map((r) => (kind === 'album'
      ? { title: r.collectionName || '', artist: r.artistName || '', link: r.collectionViewUrl || '', id: r.collectionId != null ? String(r.collectionId) : '', thumb: r.artworkUrl100 || '' }
      : { title: r.trackName || '', artist: r.artistName || '', link: r.trackViewUrl || '', id: r.trackId != null ? String(r.trackId) : '', thumb: r.artworkUrl100 || '' }))
    .filter((c) => c.title && c.link);
}

// Exact-name candidates, most plausible first: fan count descending
// (live-verified: Deezer ranks a 2-fan namesake above the 250-fan real
// act), catalog rank breaking ties (sort is stable; iTunes rows carry no
// fans at all).
export function exactNameCandidates(cands, name) {
  const q = normalize(name);
  return (cands || [])
    .filter((c) => normalize(c.artist) === q)
    .sort((a, b) => (b.fans || 0) - (a.fans || 0));
}

// Artist-kind analog of pickByArtist. Exact (normalized) name equality
// wins over the token-subset match — a one-word query like "GRETA" must
// not land on the first "Greta Something". The loose match stays as the
// fallback for spelling variants. Popularity is still only a guess —
// callers with a source track list use confirmByCatalog instead.
export function pickByName(cands, name) {
  const exact = exactNameCandidates(cands, name);
  if (exact.length) return exact[0];
  return (cands || []).find((c) => looselyMatches(c.artist, name)) || null;
}

// Does any title appear in both lists? Strict equality on searchable
// titles — the token-subset match would let "Mercy (Blind Audition Live)"
// confirm any artist with a track called Mercy.
export function titlesOverlap(a, b) {
  const setA = new Set((a || []).map((t) => normalize(searchableTitle(t))).filter(Boolean));
  return (b || []).some((t) => setA.has(normalize(searchableTitle(t))));
}

// Identity-proven artist pick: probe exact-name candidates against the
// source's own track list (fetchTop(cand) → that candidate's top titles).
// One shared title proves the candidate; with a track list in hand an
// unproven pick is a likely WRONG pick (live-verified: the most popular
// "Greta" on Deezer is a casting-show act, not the pasted artist) — so
// this returns null rather than falling back to popularity.
export async function confirmByCatalog(cands, name, tracks, fetchTop, cap = 4) {
  for (const cand of exactNameCandidates(cands, name).slice(0, cap)) {
    try {
      if (titlesOverlap(tracks, await fetchTop(cand))) return cand;
    } catch { /* unreachable candidate — try the next */ }
  }
  return null;
}

// MB artist from any response shape: a single-resource URL lookup
// ({ relations: [{ artist }] }), a multi-resource one ({ urls: [...] }),
// or an artist name search ({ artists }). Name-search hits must score
// high AND equal the queried name after normalization — the old subset
// match let "GRETA" land on "Greta Keller" (MB scores her 100 for that
// query); MB's search is fuzzy enough to rank tribute acts too.
export function pickMbArtist(json, name) {
  const relLists = json?.urls ? json.urls.map((u) => u.relations || []) : [json?.relations || []];
  const fromRels = relLists.flat().map((rel) => rel.artist).find(Boolean);
  if (fromRels?.id) return { id: fromRels.id, name: fromRels.name || '' };
  const hit = (json?.artists || []).find(
    (a) => a?.id && Number(a.score) >= 90 && normalize(a.name) === normalize(name)
  );
  return hit ? { id: hit.id, name: hit.name || '' } : null;
}

// First candidate whose title fits and whose artist matches — the order of
// `cands` is the catalog's own relevance ranking.
export function pickByArtist(cands, artist, title) {
  const qTitle = searchableTitle(title);
  const titleOk = (c) => looselyMatches(c, title) || looselyMatches(c, qTitle);
  return (cands || []).find((c) => titleOk(c.title) && looselyMatches(c.artist, artist)) || null;
}

// Candidates whose title equals the query title (rank preserved).
export function strictTitleHits(cands, qTitle) {
  const q = normalize(searchableTitle(qTitle));
  return (cands || []).filter((c) => normalize(searchableTitle(c.title)) === q);
}

// Artist chips for an ambiguous title: strict-title artists from Deezer in
// rank order, names iTunes also lists hoisted to the front. iCands === null
// means iTunes gave no signal (down or rate-limited) — Deezer-only chips
// are still offered: a chip is a user choice, not an auto-pick.
export function artistCandidates(dCands, iCands, qTitle, limit = 4) {
  const iStrict = iCands ? strictTitleHits(iCands, qTitle) : [];
  const seen = new Set();
  const confirmed = [];
  const unconfirmed = [];
  for (const d of strictTitleHits(dCands, qTitle)) {
    const key = normalize(d.artist);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    (iStrict.some((c) => looselyMatches(c.artist, d.artist)) ? confirmed : unconfirmed).push(d.artist);
  }
  return confirmed.concat(unconfirmed).slice(0, limit);
}

// Plain queries — Deezer's quoted artist:"…" track:"…" syntax returns
// empty result sets for many valid tracks (verified live).
async function deezerSearch(kind, query) {
  const route = kind === 'album' ? 'search/album' : kind === 'artist' ? 'search/artist' : 'search';
  const data = await jsonp(`https://api.deezer.com/${route}?q=${encodeURIComponent(query)}&limit=10`);
  return deezerCandidates(data, kind);
}

// iTunes rate-limits hard (bursts of 403s) — after a rejection, skip iTunes
// for a minute instead of hammering. Returns null for "no signal" (failed
// or cooling down) and [] for "searched, found nothing" — callers branch
// on the difference.
let itunesBlockedUntil = 0;
const ITUNES_COOLDOWN_MS = 60_000;

async function itunesSearch(kind, term, region) {
  if (Date.now() < itunesBlockedUntil) return null;
  const entity = kind === 'album' ? 'album' : kind === 'artist' ? 'musicArtist' : 'song';
  try {
    const data = await getJson(
      `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
      `&media=music&entity=${entity}&limit=10&country=${region.country}`
    );
    return itunesCandidates(data, kind);
  } catch {
    itunesBlockedUntil = Date.now() + ITUNES_COOLDOWN_MS;
    return null;
  }
}

// Title-only resolve (Spotify sources carry no artist): Deezer first —
// JSONP, no rate limit — then ONE artist-targeted iTunes confirm. Only a
// two-catalog agreement auto-picks (a single catalog's top hit is too
// often a cover or remix); anything less becomes chips for the user.
async function resolveTitleOnly(kind, title, region) {
  const qTitle = searchableTitle(title);
  let dCands;
  try {
    dCands = await deezerSearch(kind, qTitle);
  } catch {
    return {};
  }
  const primary = strictTitleHits(dCands, qTitle)[0];
  if (!primary?.artist) return {};
  const iCands = await itunesSearch(kind, `${primary.artist} ${qTitle}`, region);
  const iHit = iCands ? pickByArtist(iCands, primary.artist, title) : null;
  if (iHit) {
    return {
      artist: primary.artist,
      deezer: primary.link,
      appleMusic: iHit.link,
      // A two-catalog agreement is trustworthy enough to upgrade the
      // display: canonical spelling and cover art from the matched entity.
      canonicalTitle: primary.title,
      thumb: primary.thumb || iHit.thumb || '',
      // "Not right?" chips: the ranked alternatives minus the picked one.
      artistCandidates: artistCandidates(dCands, iCands, qTitle)
        .filter((name) => !looselyMatches(name, primary.artist)),
    };
  }
  return {
    artistCandidates: artistCandidates(dCands, iCands, qTitle),
    itunesDown: iCands === null,
  };
}

// Top titles of one catalog artist — the fetchTop probes for confirmByCatalog.
const deezerTopTitles = (cand) =>
  jsonp(`https://api.deezer.com/artist/${cand.id}/top?limit=10`)
    .then((d) => (d?.data || []).map((t) => t.title).filter(Boolean));
const itunesTopTitles = (cand) =>
  getJson(`https://itunes.apple.com/lookup?id=${cand.id}&entity=song&limit=10`)
    .then((d) => (d.results || []).filter((r) => r.wrapperType === 'track')
      .map((r) => r.trackName).filter(Boolean));

// Artist analog of findExactLinks: Deezer + iTunes artist search in
// parallel. With source tracks (link sessions) each catalog pick must be
// PROVEN by a shared track title; without them (typed searches) the
// popularity pick stands. iTunes probes are capped at 2 — its rate limit
// is the scarce budget. → { deezer?, appleMusic?, canonicalArtist?, thumb? }
export async function findArtistLinks({ artist, tracks = [] }, region, sourceKeys = []) {
  if (!artist) return {};
  const [dz, it] = await Promise.allSettled([
    deezerSearch('artist', artist),
    sourceKeys.includes('appleMusic') ? null : itunesSearch('artist', artist, region),
  ]);
  const out = {};
  const dCands = dz.status === 'fulfilled' ? dz.value : [];
  const d = tracks.length
    ? await confirmByCatalog(dCands, artist, tracks, deezerTopTitles)
    : pickByName(dCands, artist);
  if (d) {
    out.deezer = d.link;
    out.canonicalArtist = d.artist;
    out.thumb = d.thumb;
  }
  const iCands = it.status === 'fulfilled' && it.value ? it.value : null;
  const i = iCands
    ? (tracks.length
      ? await confirmByCatalog(iCands, artist, tracks, itunesTopTitles, 2)
      : pickByName(iCands, artist))
    : null;
  if (i) {
    out.appleMusic = i.link;
    if (!out.canonicalArtist) out.canonicalArtist = i.artist;
  }
  return out;
}

// MB stores artist URLs in normalized but not predictable forms
// (live-verified 2026-08-21: Daft Punk's Apple rels are music.apple.com/fr/
// and itunes.apple.com/fr/ — the storefront is whatever the editor pasted,
// never the slug form). One anchor URL therefore misses routinely — expand
// each anchor into the store's known shapes and query them all at once
// (the url route accepts repeated resource params in ONE request).
export function expandArtistAnchor(url) {
  const parsed = parseInput(url);
  if (!parsed.ok || parsed.kind !== 'artist') return [url];
  if (parsed.platform === 'appleMusic') {
    const fronts = [...new Set([parsed.meta?.storefront || 'us', 'us'])];
    return fronts.flatMap((cc) => [
      `https://music.apple.com/${cc}/artist/${parsed.id}`,
      `https://itunes.apple.com/${cc}/artist/id${parsed.id}`,
    ]);
  }
  if (parsed.platform === 'tidal') {
    return [`https://tidal.com/artist/${parsed.id}`, `https://listen.tidal.com/artist/${parsed.id}`];
  }
  return [parsed.url];
}

// Do the MB artist's own url-rels confirm one of our anchor URLs? Compared
// as parsed entities (platform+kind+id), so storefront/slug variants match.
export function relsConfirmAnchor(relUrls, anchorUrls) {
  const anchors = (anchorUrls || []).map(parseInput).filter((p) => p.ok);
  return (relUrls || []).some((u) => {
    const p = parseInput(u);
    return p.ok && anchors.some((a) => a.platform === p.platform && a.kind === p.kind && a.id === p.id);
  });
}

// Artist links via MusicBrainz URL relations. Anchor-first: a known
// streaming-profile URL identifies the artist exactly; the name search is
// only the fallback and gated hard in pickMbArtist. Even then a name is
// just a guess ("GRETA" finds an unrelated US band scored ≥90), so a
// name-search hit only counts when the artist's own url-rels confirm one
// of the anchors — that check rides on the artist/{mbid} lookup we make
// anyway. 2-3 spaced MB calls total, all through mbChain.
export async function findLinksByArtist({ urls = [], name }) {
  const anchors = urls.filter(Boolean);
  const resources = [...new Set(anchors.flatMap(expandArtistAnchor))];
  let found = null;
  let anchored = false;
  if (resources.length) {
    try {
      const query = resources.map((u) => `resource=${encodeURIComponent(u)}`).join('&');
      found = pickMbArtist(await mbJson(`url/?${query}&inc=artist-rels&fmt=json`), name);
      anchored = Boolean(found);
    } catch { /* fall through to the name search */ }
  }
  if (!found && name) {
    try {
      const query = `artist:"${name.replace(/"/g, '')}"`;
      found = pickMbArtist(
        await mbJson(`artist/?query=${encodeURIComponent(query)}&fmt=json&limit=3`), name
      );
    } catch { /* best effort */ }
  }
  if (!found) return {};
  const full = await mbJson(`artist/${found.id}?inc=url-rels&fmt=json`);
  const relUrls = (full.relations || []).map((rel) => rel.url?.resource).filter(Boolean);
  if (!anchored && anchors.length && !relsConfirmAnchor(relUrls, anchors)) return {};
  return mapUrlsToPlatforms(relUrls, 'artist');
}

export async function findExactLinks({ artist, title, kind = 'track' }, region, sourceKeys = []) {
  if (!title) return {};
  // Artist and playlist links have nothing to title-match — the track
  // pipeline would fabricate confident nonsense for them.
  if (kind === 'artist' || kind === 'playlist') return {};

  if (!artist) return resolveTitleOnly(kind, title, region);

  const query = `${artist} ${searchableTitle(title)}`.trim();
  // An Apple-source card keeps the pasted link, so the iTunes result would
  // be discarded — skip the request: every needless iTunes call burns the
  // shared rate-limit budget. The Deezer search always runs: its match is
  // what unlocks the ISRC/UPC derivation for non-Deezer sources.
  const [dz, it] = await Promise.allSettled([
    deezerSearch(kind, query),
    sourceKeys.includes('appleMusic') ? null : itunesSearch(kind, query, region),
  ]);
  const out = {};
  const d = dz.status === 'fulfilled' ? pickByArtist(dz.value, artist, title) : null;
  if (d) {
    out.deezer = d.link;
    out.canonicalArtist = d.artist;
    out.canonicalTitle = d.title;
    out.thumb = d.thumb;
  }
  const i = it.status === 'fulfilled' && it.value ? pickByArtist(it.value, artist, title) : null;
  if (i) {
    out.appleMusic = i.link;
    if (!out.thumb) out.thumb = i.thumb;
    if (!out.canonicalArtist) {
      out.canonicalArtist = i.artist;
      out.canonicalTitle = i.title;
    }
  }
  return out;
}
