// SPDX-License-Identifier: GPL-3.0-or-later
// Parse a pasted music link into { platform, kind, id, ... }.
// Pure functions only — unit-tested in tests/parsers.test.mjs.

const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;
const YOUTUBE_ID = /^[0-9A-Za-z_-]{11}$/;
const NUMERIC_ID = /^\d+$/;
const ASIN = /^[A-Z0-9]{10}$/i;

function ok(platform, kind, id, url, meta = {}) {
  return { ok: true, platform, kind, id, url, meta };
}

function fail(reason, note = '') {
  return { ok: false, reason, note };
}

function withScheme(text) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
}

// Short-link domains that cannot be expanded from client-side JS
// (JS redirects or CORS-opaque responses). deezer.page.link is dead
// entirely — Firebase Dynamic Links shut down 2025-08-25.
const SHORTLINK_HOSTS = {
  'spotify.link': 'Spotify short links can’t be expanded in the browser — open it once and paste the full open.spotify.com link.',
  'spotify.app.link': 'Spotify short links can’t be expanded in the browser — open it once and paste the full open.spotify.com link.',
  'link.deezer.com': 'Deezer short links can’t be expanded in the browser — open it once and paste the full deezer.com link.',
  'deezer.page.link': 'This Deezer short link format is dead (Firebase Dynamic Links shut down in 2025) — it won’t open anywhere.',
  'dzr.page.link': 'This Deezer short link format is dead (Firebase Dynamic Links shut down in 2025) — it won’t open anywhere.',
  'on.soundcloud.com': 'SoundCloud short links can’t be expanded in the browser — open it once and paste the full soundcloud.com link.',
  'snd.sc': 'SoundCloud short links can’t be expanded in the browser — open it once and paste the full soundcloud.com link.',
};

// Music smart-link services (Linkfire, Feature.fm, …). Their pages hold
// the per-platform links, but none of them sends CORS headers (verified
// 2026-08-20), so a static page cannot extract them — recognize and
// explain instead. `dead: true` marks services that no longer resolve.
const SMARTLINK_HOSTS = [
  { match: (h) => h === 'lnk.to' || h.endsWith('.lnk.to'), name: 'Linkfire' },
  { match: (h) => h === 'ffm.to', name: 'Feature.fm' },
  { match: (h) => h === 'orcd.co', name: 'The Orchard' },
  { match: (h) => h === 'bfan.link', name: 'Believe' },
  { match: (h) => h === 'hyperfollow.com', name: 'DistroKid HyperFollow' },
  { match: (h, segs) => h === 'distrokid.com' && segs[0] === 'hyperfollow', name: 'DistroKid HyperFollow' },
  { match: (h) => h === 'hypeddit.com', name: 'Hypeddit' },
  { match: (h) => h === 'click.soundplate.com' || h === 'clicks.soundplate.com', name: 'Soundplate' },
  { match: (h) => h === 'show.co', name: 'Show.co' },
  { match: (h) => h === 'smarturl.it' || h.endsWith('.smarturl.it'), name: 'smartURL', dead: true },
  { match: (h) => h === 'fanlink.to', name: 'ToneDen fanlink.to', dead: true },
];

function smartlinkNote(name, dead) {
  if (dead) return `${name} links are dead — the service shut down, this link won’t open anywhere.`;
  return `This is a ${name} smart link. It already holds the per-platform links, but browsers block reading it from another site — open it, copy the link for one platform and paste that here.`;
}

export function parseInput(raw) {
  const text = (raw || '').trim();
  if (!text) return fail('empty');

  const uri = text.match(/^spotify:(track|album|artist|playlist):([0-9A-Za-z]{22})$/);
  if (uri) {
    return ok('spotify', uri[1], uri[2], `https://open.spotify.com/${uri[1]}/${uri[2]}`);
  }

  let url;
  try {
    url = new URL(withScheme(text));
  } catch {
    return fail('unrecognized');
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segs = url.pathname.split('/').filter(Boolean);

  if (SHORTLINK_HOSTS[host]) return fail('shortlink', SHORTLINK_HOSTS[host]);

  // song.link/album.link carry the source-platform ID in the path
  // (s=Spotify, i=iTunes, y=YouTube, d=Deezer, t=Tidal) — natively
  // resolvable even though the Odesli API itself is gone.
  if (host === 'song.link' || host === 'album.link') {
    return parseOdesliPage(host, segs);
  }
  const smart = SMARTLINK_HOSTS.find((s) => s.match(host, segs));
  if (smart) return fail('smartlink', smartlinkNote(smart.name, smart.dead));

  if (host === 'open.spotify.com') return parseSpotify(url, segs);
  if (host === 'music.apple.com' || host === 'geo.music.apple.com' || host === 'itunes.apple.com') {
    return parseApple(url, segs);
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    return parseYoutube(url, segs, host === 'music.youtube.com');
  }
  if (host === 'youtu.be') {
    const id = segs[0];
    if (id && YOUTUBE_ID.test(id)) {
      return ok('youtube', 'track', id, `https://www.youtube.com/watch?v=${id}`);
    }
    return fail('unrecognized');
  }
  if (host === 'deezer.com') return parseDeezer(segs);
  if (host === 'tidal.com' || host === 'listen.tidal.com' || host === 'desktop.tidal.com') {
    return parseTidal(segs);
  }
  if (/^music\.amazon\.[a-z.]+$/.test(host)) return parseAmazon(url, segs, host);
  if (host === 'soundcloud.com') return parseSoundcloud(segs);
  if (host.endsWith('.bandcamp.com')) return parseBandcamp(host, segs);
  if (host === 'qobuz.com' || host === 'open.qobuz.com' || host === 'play.qobuz.com') {
    return parseQobuz(url, host, segs);
  }

  return fail('unrecognized');
}

function parseSpotify(url, segs) {
  // Optional locale segment: open.spotify.com/intl-de/track/{id}
  if (segs[0] && /^intl-[a-z]{2,4}$/i.test(segs[0])) segs = segs.slice(1);
  const [kind, id] = segs;
  if (['track', 'album', 'artist', 'playlist'].includes(kind) && id && SPOTIFY_ID.test(id)) {
    return ok('spotify', kind, id, `https://open.spotify.com/${kind}/${id}`);
  }
  return fail('unrecognized');
}

function parseApple(url, segs) {
  let storefront = 'us';
  if (segs[0] && /^[a-z]{2}$/i.test(segs[0])) {
    storefront = segs[0].toLowerCase();
    segs = segs.slice(1);
  }
  const kind = segs[0];
  const lastNumeric = [...segs].reverse().find((s) => NUMERIC_ID.test(s));
  if (kind === 'album' && lastNumeric) {
    const trackId = url.searchParams.get('i');
    if (trackId && NUMERIC_ID.test(trackId)) {
      return ok('appleMusic', 'track', trackId,
        `https://music.apple.com/${storefront}/album/${lastNumeric}?i=${trackId}`,
        { storefront, albumId: lastNumeric });
    }
    return ok('appleMusic', 'album', lastNumeric,
      `https://music.apple.com/${storefront}/album/${lastNumeric}`, { storefront });
  }
  if (kind === 'song' && lastNumeric) {
    return ok('appleMusic', 'track', lastNumeric,
      `https://music.apple.com/${storefront}/song/${lastNumeric}`, { storefront });
  }
  if (kind === 'artist' && lastNumeric) {
    return ok('appleMusic', 'artist', lastNumeric,
      `https://music.apple.com/${storefront}/artist/${lastNumeric}`, { storefront });
  }
  return fail('unrecognized');
}

function parseYoutube(url, segs, isMusic) {
  let id = null;
  if (segs[0] === 'watch') id = url.searchParams.get('v');
  else if (segs[0] === 'shorts' || segs[0] === 'live') id = segs[1];
  else if (url.searchParams.get('v')) id = url.searchParams.get('v');
  if (id && YOUTUBE_ID.test(id)) {
    return ok('youtube', 'track', id, `https://www.youtube.com/watch?v=${id}`, { music: isMusic });
  }
  return fail('unrecognized');
}

function parseDeezer(segs) {
  // Optional language segment: deezer.com/en/track/{id}
  if (segs[0] && /^[a-z]{2}$/i.test(segs[0]) && segs.length > 2) segs = segs.slice(1);
  const [kind, id] = segs;
  if (['track', 'album', 'artist', 'playlist'].includes(kind) && id && NUMERIC_ID.test(id)) {
    return ok('deezer', kind, id, `https://www.deezer.com/${kind}/${id}`);
  }
  return fail('unrecognized');
}

function parseTidal(segs) {
  if (segs[0] === 'browse') segs = segs.slice(1);
  const [kind, id] = segs;
  if (['track', 'album', 'artist', 'video'].includes(kind) && id && NUMERIC_ID.test(id)) {
    const norm = kind === 'video' ? 'track' : kind;
    return ok('tidal', norm, id, `https://tidal.com/${kind}/${id}`);
  }
  return fail('unrecognized');
}

function parseAmazon(url, segs, host) {
  const tld = host.replace(/^music\.amazon\./, '');
  const [kind, id] = segs;
  if (kind === 'albums' && id && ASIN.test(id)) {
    const trackAsin = url.searchParams.get('trackAsin');
    if (trackAsin && ASIN.test(trackAsin)) {
      return ok('amazonMusic', 'track', trackAsin,
        `https://music.amazon.${tld}/albums/${id}?trackAsin=${trackAsin}`, { tld, albumAsin: id });
    }
    return ok('amazonMusic', 'album', id, `https://music.amazon.${tld}/albums/${id}`, { tld });
  }
  if (kind === 'tracks' && id && ASIN.test(id)) {
    return ok('amazonMusic', 'track', id, `https://music.amazon.${tld}/tracks/${id}`, { tld });
  }
  if (kind === 'artists' && id && ASIN.test(id)) {
    return ok('amazonMusic', 'artist', id, `https://music.amazon.${tld}/artists/${id}`, { tld });
  }
  return fail('unrecognized');
}

function parseSoundcloud(segs) {
  const reserved = ['search', 'discover', 'you', 'stream', 'upload', 'charts'];
  if (segs.length >= 2 && !reserved.includes(segs[0])) {
    if (segs[1] === 'sets' && segs[2]) {
      return ok('soundcloud', 'album', `${segs[0]}/sets/${segs[2]}`,
        `https://soundcloud.com/${segs[0]}/sets/${segs[2]}`, { user: segs[0], slug: segs[2] });
    }
    return ok('soundcloud', 'track', `${segs[0]}/${segs[1]}`,
      `https://soundcloud.com/${segs[0]}/${segs[1]}`, { user: segs[0], slug: segs[1] });
  }
  return fail('unrecognized');
}

function parseBandcamp(host, segs) {
  const artist = host.replace(/\.bandcamp\.com$/, '');
  const [kind, slug] = segs;
  if ((kind === 'track' || kind === 'album') && slug) {
    return ok('bandcamp', kind, `${artist}/${kind}/${slug}`,
      `https://${artist}.bandcamp.com/${kind}/${slug}`, { artist, slug });
  }
  return fail('unrecognized');
}

function parseOdesliPage(host, segs) {
  const kind = host === 'album.link' ? 'album' : 'track';
  const [prefix, id] = segs;
  if (prefix === 's' && id && SPOTIFY_ID.test(id)) {
    return ok('spotify', kind, id, `https://open.spotify.com/${kind}/${id}`);
  }
  if (prefix === 'i' && id && NUMERIC_ID.test(id)) {
    return kind === 'album'
      ? ok('appleMusic', 'album', id, `https://music.apple.com/us/album/${id}`, { storefront: 'us' })
      : ok('appleMusic', 'track', id, `https://music.apple.com/us/song/${id}`, { storefront: 'us' });
  }
  if (prefix === 'y' && id && YOUTUBE_ID.test(id)) {
    return ok('youtube', 'track', id, `https://www.youtube.com/watch?v=${id}`);
  }
  if (prefix === 'd' && id && NUMERIC_ID.test(id)) {
    return ok('deezer', kind, id, `https://www.deezer.com/${kind}/${id}`);
  }
  if (prefix === 't' && id && NUMERIC_ID.test(id)) {
    return ok('tidal', kind, id, `https://tidal.com/${kind}/${id}`);
  }
  return fail('smartlink', smartlinkNote('song.link/album.link', false));
}

// Qobuz ID rule (live-verified 2026-08-20): album IDs are alphanumeric
// (e.g. "mm9mf2wj0a54u"), track/artist/playlist IDs are purely numeric.
// The album ID is identical across www./open./play.qobuz.com.
const QOBUZ_ALBUM_ID = /^[a-z0-9]{6,}$/i;

function parseQobuz(url, host, segs) {
  if (host === 'qobuz.com') {
    // www.qobuz.com/{storefront}/album/{slug}/{albumId} — storefront like "de-de"
    let storefront = '';
    if (segs[0] && /^[a-z]{2}-[a-z]{2}$/i.test(segs[0])) {
      storefront = segs[0].toLowerCase();
      segs = segs.slice(1);
    }
    const [kind, slug, id] = segs;
    if (kind === 'album' && slug && id && QOBUZ_ALBUM_ID.test(id)) {
      return ok('qobuz', 'album', id, url.origin + url.pathname, { slug, storefront });
    }
    if (kind === 'interpreter' && slug && id && NUMERIC_ID.test(id)) {
      return ok('qobuz', 'artist', id, url.origin + url.pathname, { slug, storefront });
    }
    return fail('unrecognized');
  }
  // open.qobuz.com / play.qobuz.com — bare IDs, no slug
  const [kind, id] = segs;
  if (kind === 'track' && id && NUMERIC_ID.test(id)) {
    return ok('qobuz', 'track', id, `https://open.qobuz.com/track/${id}`);
  }
  if (kind === 'album' && id && QOBUZ_ALBUM_ID.test(id)) {
    return ok('qobuz', 'album', id, `https://open.qobuz.com/album/${id}`);
  }
  if (kind === 'artist' && id && NUMERIC_ID.test(id)) {
    return ok('qobuz', 'artist', id, `https://open.qobuz.com/artist/${id}`);
  }
  return fail('unrecognized');
}

// Turn a URL slug into a human search hint ("harder-better-faster" → "harder better faster").
export function slugToWords(slug) {
  return (slug || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}
