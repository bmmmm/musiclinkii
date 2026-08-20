// SPDX-License-Identifier: GPL-3.0-or-later
// Platform registry + search-URL builders. All search URL formats were
// live-verified 2026-08-19 (logged-out, EU): they open real result pages.

const AMAZON_TLDS = {
  de: 'de', at: 'de', fr: 'fr', it: 'it', es: 'es',
  gb: 'co.uk', uk: 'co.uk', jp: 'co.jp', us: 'com',
};

const QOBUZ_STOREFRONTS = {
  de: 'de-de', fr: 'fr-fr', it: 'it-it', es: 'es-es',
  nl: 'nl-nl', gb: 'gb-en', uk: 'gb-en', us: 'us-en',
};

const LANG_TO_COUNTRY = { de: 'de', fr: 'fr', it: 'it', es: 'es', nl: 'nl', ja: 'jp', en: 'us' };

// Derive storefront settings from a BCP-47 locale ("de-DE", "en-GB", "fr").
export function regionFromLocale(locale) {
  const parts = String(locale || '').toLowerCase().split(/[-_]/);
  const country = (parts[1] && /^[a-z]{2}$/.test(parts[1]) && parts[1])
    || LANG_TO_COUNTRY[parts[0]] || 'us';
  return {
    country,
    appleStorefront: country,
    amazonTld: AMAZON_TLDS[country] || 'com',
    qobuzStorefront: QOBUZ_STOREFRONTS[country] || 'us-en',
  };
}

const enc = encodeURIComponent;

// Where a platform supports structured search — field filters or typed
// result routes — use it: free-text ranking drowns generic names ("Mine").
// Everything below is live-verified 2026-08-20 in logged-out browsers;
// platforms without documented syntax (Apple, YouTube, YT Music, Amazon)
// stay plain free-text on purpose. See ENDPOINTS.md.
const stripQuotes = (s) => String(s || '').replace(/"/g, '');
const kindOf = (parts) => parts?.kind || 'track';

export const PLATFORMS = [
  {
    key: 'spotify', name: 'Spotify',
    // Documented field filters, work URL-encoded in the /search/ path.
    searchUrl: (q, r, parts) => {
      const kind = kindOf(parts);
      // ISRC beats everything: Spotify indexes its own catalog's ISRCs,
      // so this search lands on exactly the right track — even for fresh
      // releases MusicBrainz doesn't know. All three MB-miss regression
      // cases verified logged-out 2026-08-20.
      if (parts?.isrc && kind === 'track') {
        return `https://open.spotify.com/search/${enc(`isrc:${parts.isrc}`)}`;
      }
      if (parts?.artist && parts?.title) {
        const field = kind === 'album' ? 'album' : 'track';
        return `https://open.spotify.com/search/${enc(`artist:"${stripQuotes(parts.artist)}" ${field}:"${stripQuotes(parts.title)}"`)}`;
      }
      if (parts?.artist && kind === 'artist') {
        return `https://open.spotify.com/search/${enc(`artist:"${stripQuotes(parts.artist)}"`)}`;
      }
      return `https://open.spotify.com/search/${enc(q)}`;
    },
  },
  {
    key: 'appleMusic', name: 'Apple Music',
    searchUrl: (q, r) => `https://music.apple.com/${r.appleStorefront}/search?term=${enc(q)}`,
  },
  {
    key: 'youtube', name: 'YouTube',
    searchUrl: (q) => `https://www.youtube.com/results?search_query=${enc(q)}`,
  },
  {
    key: 'youtubeMusic', name: 'YouTube Music',
    // Content-ID makes ISRCs searchable here: an ISRC query returns exactly
    // the right song (Clockwork + fresh-2026 release verified logged-out
    // 2026-08-20). Plain youtube.com ranks the Topic track first but buries
    // the music video, so only the Music card searches by ISRC.
    searchUrl: (q, r, parts) => {
      if (parts?.isrc && kindOf(parts) === 'track') {
        return `https://music.youtube.com/search?q=${enc(parts.isrc)}`;
      }
      return `https://music.youtube.com/search?q=${enc(q)}`;
    },
  },
  {
    key: 'deezer', name: 'Deezer',
    // The WEB search supports quoted field syntax (the JSONP API does not).
    searchUrl: (q, r, parts) => {
      if (parts?.artist && parts?.title) {
        const field = kindOf(parts) === 'album' ? 'album' : 'track';
        return `https://www.deezer.com/search/${enc(`artist:"${stripQuotes(parts.artist)}" ${field}:"${stripQuotes(parts.title)}"`)}`;
      }
      return `https://www.deezer.com/search/${enc(q)}`;
    },
  },
  {
    key: 'tidal', name: 'TIDAL',
    searchUrl: (q, r, parts) => {
      const route = { track: 'tracks', album: 'albums', artist: 'artists' }[kindOf(parts)] || 'tracks';
      return `https://tidal.com/search/${route}?q=${enc(q)}`;
    },
  },
  {
    key: 'amazonMusic', name: 'Amazon Music',
    searchUrl: (q, r) => `https://music.amazon.${r.amazonTld}/search/${enc(q)}`,
  },
  {
    key: 'soundcloud', name: 'SoundCloud',
    searchUrl: (q, r, parts) => {
      const route = { track: 'sounds', album: 'albums', artist: 'people' }[kindOf(parts)] || 'sounds';
      return `https://soundcloud.com/search/${route}?q=${enc(q)}`;
    },
  },
  {
    key: 'bandcamp', name: 'Bandcamp',
    searchUrl: (q, r, parts) => {
      const itemType = { track: 't', album: 'a', artist: 'b' }[kindOf(parts)] || 't';
      return `https://bandcamp.com/search?q=${enc(q)}&item_type=${itemType}`;
    },
  },
  {
    key: 'qobuz', name: 'Qobuz',
    // open.qobuz.com ignores ?q= — the typed path route on www.qobuz.com works.
    searchUrl: (q, r, parts) => {
      const route = { track: 'tracks', album: 'albums', artist: 'artists' }[kindOf(parts)] || 'tracks';
      return `https://www.qobuz.com/${r.qobuzStorefront}/search/${route}/${enc(q)}`;
    },
  },
];

// Map a parsed source platform key to the registry key used for the
// YouTube Music card when the source is a music.youtube.com link.
export function sourceCardKeys(parsed) {
  if (parsed.platform === 'youtube') {
    return parsed.meta?.music ? ['youtube', 'youtubeMusic'] : ['youtube'];
  }
  return [parsed.platform];
}

export function buildQuery(artist, title) {
  return [artist, title].map((s) => (s || '').trim()).filter(Boolean).join(' ');
}

// Shareable permalink: the pasted link travels in the fragment, which
// never reaches any server (not even GitHub Pages logs).
export function shareHashFor(link) {
  const trimmed = (link || '').trim();
  return trimmed ? `#l=${encodeURIComponent(trimmed)}` : '';
}

export function linkFromHash(hash) {
  const m = /^#l=(.+)$/.exec(hash || '');
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
