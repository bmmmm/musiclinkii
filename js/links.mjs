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

export const PLATFORMS = [
  {
    key: 'spotify', name: 'Spotify',
    searchUrl: (q) => `https://open.spotify.com/search/${enc(q)}`,
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
    searchUrl: (q) => `https://music.youtube.com/search?q=${enc(q)}`,
  },
  {
    key: 'deezer', name: 'Deezer',
    searchUrl: (q) => `https://www.deezer.com/search/${enc(q)}`,
  },
  {
    key: 'tidal', name: 'TIDAL',
    searchUrl: (q) => `https://tidal.com/search?q=${enc(q)}`,
  },
  {
    key: 'amazonMusic', name: 'Amazon Music',
    searchUrl: (q, r) => `https://music.amazon.${r.amazonTld}/search/${enc(q)}`,
  },
  {
    key: 'soundcloud', name: 'SoundCloud',
    searchUrl: (q) => `https://soundcloud.com/search?q=${enc(q)}`,
  },
  {
    key: 'bandcamp', name: 'Bandcamp',
    searchUrl: (q) => `https://bandcamp.com/search?q=${enc(q)}`,
  },
  {
    key: 'qobuz', name: 'Qobuz',
    // open.qobuz.com ignores ?q= — the typed path route on www.qobuz.com works.
    searchUrl: (q, r) => `https://www.qobuz.com/${r.qobuzStorefront}/search/tracks/${enc(q)}`,
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
