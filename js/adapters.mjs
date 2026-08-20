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

async function getJson(url, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
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
    return getJson(`https://musicbrainz.org/ws/2/${pathAndQuery}`);
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

const meta = (fields) => ({ title: '', artist: '', thumb: '', exact: {}, isrc: '', note: '', ...fields });

async function fromApple(parsed) {
  const country = parsed.meta.storefront || 'us';
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
  return meta({
    title: data.title || '',
    artist: data.artist?.name || '',
    thumb: data.album?.cover_medium || data.cover_medium || '',
    isrc: data.isrc || '',
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
  // Best effort: MusicBrainz keeps URL relationships for many Tidal links.
  const candidates = [
    `https://tidal.com/track/${parsed.id}`,
    `https://listen.tidal.com/track/${parsed.id}`,
  ];
  for (const resource of candidates) {
    try {
      const data = await mbJson(`url/?resource=${encodeURIComponent(resource)}&inc=recording-rels&fmt=json`);
      const rec = (data.relations || []).map((rel) => rel.recording).find(Boolean);
      if (!rec) continue;
      let artist = '';
      try {
        const full = await mbJson(`recording/${rec.id}?inc=artist-credits&fmt=json`);
        artist = (full['artist-credit'] || []).map((c) => c.name).join(', ');
      } catch { /* keep title-only result */ }
      return meta({ title: rec.title || '', artist });
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
export function mapUrlsToPlatforms(urls) {
  const out = {};
  for (const url of urls || []) {
    const parsed = parseInput(url);
    if (!parsed.ok) continue;
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

export async function findExactLinks({ artist, title }, region) {
  if (!title) return {};
  const out = {};
  const qTitle = searchableTitle(title);
  const strictEq = (cand) => normalize(searchableTitle(cand)) === normalize(qTitle);
  const titleOk = (cand) => looselyMatches(cand, title) || looselyMatches(cand, qTitle);

  // Plain queries — Deezer's quoted artist:"…" track:"…" syntax returns
  // empty result sets for many valid tracks (verified live).
  const query = `${artist || ''} ${qTitle}`.trim();
  const [deezer, itunes] = await Promise.allSettled([
    jsonp(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=10`),
    getJson(
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}` +
      `&media=music&entity=song&limit=10&country=${region.country}`
    ),
  ]);

  const dHits = deezer.status === 'fulfilled' ? deezer.value?.data || [] : [];
  const iHits = itunes.status === 'fulfilled' ? itunes.value?.results || [] : [];

  if (artist) {
    const d = dHits.find((t) => titleOk(t.title) && looselyMatches(t.artist?.name, artist));
    if (d) out.deezer = d.link;
    const i = iHits.find((t) => titleOk(t.trackName) && looselyMatches(t.artistName, artist));
    if (i) out.appleMusic = i.trackViewUrl;
  } else {
    // Title-only (e.g. Spotify oEmbed gives no artist): only trust a match
    // when two independent catalogs agree on the artist for an exact-title
    // hit — a single catalog's top hit is too often the wrong song (covers
    // and remixes rank above the original in title-only searches).
    const d = dHits.find((t) => strictEq(t.title));
    if (d?.artist?.name) {
      let iHit = iHits.find((t) =>
        strictEq(t.trackName) && looselyMatches(t.artistName, d.artist.name));
      if (!iHit) {
        // The original may rank below covers in the title-only results —
        // confirm with a second, artist-targeted iTunes search.
        try {
          const confirm = await getJson(
            `https://itunes.apple.com/search?term=${encodeURIComponent(`${d.artist.name} ${qTitle}`)}` +
            `&media=music&entity=song&limit=10&country=${region.country}`
          );
          iHit = (confirm.results || []).find((t) =>
            titleOk(t.trackName) && looselyMatches(t.artistName, d.artist.name));
        } catch { /* no confirmation possible — stay conservative */ }
      }
      if (iHit) {
        out.artist = d.artist.name;
        out.deezer = d.link;
        out.appleMusic = iHit.trackViewUrl;
      } else {
        // Deezer's top hit found no backing at all — the title is shared
        // by many artists ("Cooked"). Don't guess: offer the artists BOTH
        // catalogs agree on and let the user pick with one click.
        out.artistCandidates = artistCandidates(dHits, iHits, qTitle);
      }
    }
  }

  return out;
}

// Artists that appear with a strict-equal title in BOTH title-only result
// lists (Deezer order kept — their ranking is the relevance signal).
export function artistCandidates(dHits, iHits, qTitle) {
  const strictEq = (cand) => normalize(searchableTitle(cand)) === normalize(qTitle);
  const iStrict = (iHits || []).filter((t) => strictEq(t.trackName));
  const seen = new Set();
  const out = [];
  for (const d of dHits || []) {
    if (!strictEq(d.title)) continue;
    const name = d.artist?.name || '';
    const key = normalize(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (iStrict.some((t) => looselyMatches(t.artistName, name))) out.push(name);
  }
  return out.slice(0, 4);
}
