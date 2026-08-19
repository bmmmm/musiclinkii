// SPDX-License-Identifier: GPL-3.0-or-later
// Embed previews and open-in-app links. Only the dedicated embed hosts
// allow framing from foreign origins (open.spotify.com/embed, widget.
// deezer.com, embed.tidal.com, embed.music.apple.com, youtube-nocookie,
// w.soundcloud.com) — never frame the product pages themselves.
// Bandcamp (numeric ID not derivable from the URL), Amazon Music
// (undocumented mandatory params) and Qobuz (no known embed) get none.

const EMBED_BUILDERS = {
  spotify(p, dark) {
    if (p.kind !== 'track' && p.kind !== 'album') return null;
    return {
      src: `https://open.spotify.com/embed/${p.kind}/${p.id}?utm_source=generator&theme=${dark ? '0' : '1'}`,
      height: p.kind === 'track' ? 152 : 352,
    };
  },
  youtube(p) {
    // youtube-nocookie.com is Google's documented privacy-enhanced host.
    return { src: `https://www.youtube-nocookie.com/embed/${p.id}`, aspect: '16 / 9' };
  },
  deezer(p) {
    if (p.kind !== 'track' && p.kind !== 'album') return null;
    return {
      src: `https://widget.deezer.com/widget/auto/${p.kind}/${p.id}`,
      height: p.kind === 'track' ? 150 : 300,
    };
  },
  tidal(p) {
    if (p.kind !== 'track' && p.kind !== 'album') return null;
    return {
      src: `https://embed.tidal.com/${p.kind === 'track' ? 'tracks' : 'albums'}/${p.id}`,
      height: p.kind === 'track' ? 120 : 275,
    };
  },
  // Apple Music embeds (embed.music.apple.com/{sf}/album/{id}?i={trackId})
  // are disabled: tested 2026-08-20 in real Chrome, the player loads
  // MusicKit but never issues a catalog request and stays a grey
  // placeholder — in an iframe and opened directly, with and without the
  // slug, for /album and /song alike. Re-enable once it provably renders.
  appleMusic() {
    return null;
  },
  soundcloud(p) {
    if (p.kind !== 'track' && p.kind !== 'album') return null;
    return {
      src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(p.url)}&show_comments=false`,
      height: 166,
    };
  },
};

// → { src, height? , aspect? } or null when no embed exists for this entity.
export function embedFor(parsed, dark = false) {
  if (!parsed?.ok) return null;
  return EMBED_BUILDERS[parsed.platform]?.(parsed, dark) ?? null;
}

// Open-in-app deep links — only where the scheme is actually documented:
// spotify: is IANA-registered and officially documented; deezer:// is
// long-standing community practice (best effort). Everything else has no
// reliable scheme; https universal links already open those apps on mobile.
export function appLinkFor(parsed) {
  if (!parsed?.ok) return null;
  if (parsed.platform === 'spotify' && ['track', 'album', 'artist', 'playlist'].includes(parsed.kind)) {
    return {
      href: `spotify:${parsed.kind}:${parsed.id}`,
      title: 'Open in the Spotify app — nothing happens if it isn’t installed',
    };
  }
  if (parsed.platform === 'deezer' && ['track', 'album', 'artist'].includes(parsed.kind)) {
    return {
      href: `deezer://www.deezer.com/${parsed.kind}/${parsed.id}`,
      title: 'Open in the Deezer app — nothing happens if it isn’t installed',
    };
  }
  if (parsed.platform === 'appleMusic' && parsed.url?.startsWith('https://music.apple.com/')) {
    // No formally documented scheme, but the music:// transform of the
    // canonical URL is the long-standing pattern that opens the Music
    // app on Apple platforms. Best effort.
    return {
      href: parsed.url.replace(/^https:\/\//, 'music://'),
      title: 'Open in the Apple Music app — best effort, nothing happens if it isn’t installed',
    };
  }
  return null;
}
