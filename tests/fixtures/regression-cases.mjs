// SPDX-License-Identifier: GPL-3.0-or-later
// The real-world regression cases collected across sessions (Issue #1).
// `parse` is asserted offline in parsers.test.mjs. `live` documents the
// verified online behavior (dates given) for manual E2E runs — network
// results drift over time, so they are documentation, not assertions.

export const REGRESSION_CASES = [
  {
    input: 'https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i',
    parse: { platform: 'spotify', kind: 'track', id: '0Jcij1eWd5bDMU5iPbxe2i' },
    live: '"Kitchen" (Le Crime, JKSN). Spotify oEmbed has no artist field — the title-only two-catalog confirm (Deezer+iTunes agree) fills the artist. ISRC FR8FB2520070 not in MB (404) but the Spotify isrc: search lands the track (verified logged-out 2026-08-20).',
  },
  {
    input: 'https://www.youtube.com/watch?v=_6972XBM88E',
    parse: { platform: 'youtube', kind: 'track', id: '_6972XBM88E' },
    live: 'Mine – Ohne dich (fresh 2026 release). ISRC DE1TX2600017 not in MB (404, 2026-08-20) → no match badge, but the Spotify isrc: search link lands on exactly the right track (verified logged-out 2026-08-20).',
  },
  {
    input: 'https://youtu.be/sevZEOUXpw4',
    parse: { platform: 'youtube', kind: 'track', id: 'sevZEOUXpw4' },
    live: 'Dilated Peoples – Worst Comes to Worst. MB knows ISRC USCA20101256 but its recording has zero url-rels (2026-08-20) → the Spotify isrc: search link lands the track (verified logged-out); multi-word artist must stay quoted in the non-ISRC filter fallback.',
  },
  {
    input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    parse: { platform: 'youtube', kind: 'track', id: 'dQw4w9WgXcQ' },
    live: 'Rick Astley. ISRC GBARL0600786 → MB url-rels → exact Spotify track 1Ojc3QD0dfJ5HG8uzLsfTg expected as match badge (verified 2026-08-20).',
  },
  {
    input: 'https://www.deezer.com/track/3135556',
    parse: { platform: 'deezer', kind: 'track', id: '3135556' },
    live: 'Daft Punk – Harder, Better, Faster, Stronger. Deezer metadata carries the ISRC directly → MB → exact Spotify 5W3cjX2J3tjhG8zb6u0qHn plus Tidal/YouTube matches (live-verified 2026-08-20).',
  },
  {
    input: 'https://music.apple.com/us/album/take-on-me-1985-12-mix-2015-remastered/1035047659?i=1035048414',
    parse: { platform: 'appleMusic', kind: 'track', id: '1035048414', meta: { storefront: 'us', albumId: '1035047659' } },
    live: 'a-ha – Take On Me. iTunes lookup fills metadata; searchableTitle strips the "(1985 12" Mix)" suffix for cross-platform queries.',
  },
  {
    input: 'https://www.qobuz.com/de-de/album/uberall-kopf-3lna/mm9mf2wj0a54u',
    parse: { platform: 'qobuz', kind: 'album', id: 'mm9mf2wj0a54u', meta: { slug: 'uberall-kopf-3lna' } },
    live: 'Qobuz has no keyless metadata API — the slug (title+artist mixed) becomes the search guess, note explains it.',
  },
  {
    input: 'https://open.spotify.com/intl-de/track/7piFVylkRO6hOmQanHlDOZ',
    parse: { platform: 'spotify', kind: 'track', id: '7piFVylkRO6hOmQanHlDOZ' },
    live: '"Cooked" (amelie) — reported: artist stayed empty. The title is shared by many artists, so guessing is wrong by design; the status line offers the catalog-confirmed artist candidates as one-click chips (amelie among them, verified 2026-08-20).',
  },
  {
    input: 'https://music.apple.com/de/album/clockwork/715477135?i=715477207',
    parse: { platform: 'appleMusic', kind: 'track', id: '715477207', meta: { storefront: 'de', albumId: '715477135' } },
    live: 'Dilated Peoples – Clockwork — reported: no YouTube match. MB knows ISRC USCA20101085 but has zero url-rels; Content-ID saves the day: the YouTube Music ISRC search returns exactly this song (verified logged-out 2026-08-20), so the YT Music card searches by ISRC.',
  },
  {
    input: 'https://tidal.com/album/528973835/u',
    parse: { platform: 'tidal', kind: 'album', id: '528973835' },
    live: 'Tidal share links append /u — the parser must ignore the suffix. No keyless Tidal metadata; MB URL-relation fallback is best effort.',
  },
  {
    input: 'https://song.link/s/0Jcij1eWd5bDMU5iPbxe2i',
    parse: { platform: 'spotify', kind: 'track', id: '0Jcij1eWd5bDMU5iPbxe2i' },
    live: 'song.link /s|i|y|d|t paths resolve natively even though the Odesli API is dead.',
  },
  {
    input: 'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc',
    parse: { platform: 'spotify', kind: 'album', id: '2noRn2Aes5aoNVsU6iWThc' },
    live: '"Discovery" (Daft Punk) — reported 2026-08-20: the album ran through the TRACK pipeline and auto-picked "Tony Ann" with track links as matches. Album path: Deezer /search/album + iTunes entity=album both rank Daft Punk #1; the Deezer album match yields UPC 724384960650 → MB barcode → exact Spotify/Tidal 1550545/Qobuz album links; YT Music UPC query lands "Discovery — Album — Daft Punk" (all verified logged-out 2026-08-20).',
  },
  {
    input: 'https://www.deezer.com/album/302127',
    parse: { platform: 'deezer', kind: 'album', id: '302127' },
    live: 'Daft Punk – Discovery. Deezer album metadata carries upc 724384960650 directly → MB barcode cascade; the pasted Deezer card must stay "source" (sourceKeys exclusion). Spotify upc: search filter and plain-UPC query are measured dead (2026-08-20) — exact Spotify album only via MB.',
  },
  {
    input: 'https://itunes.apple.com/gb/album/id697194953',
    parse: { platform: 'appleMusic', kind: 'album', id: '697194953' },
    live: 'The id-prefixed Apple form MusicBrainz stores in URL relations — parseApple must accept it or mapUrlsToPlatforms drops the Apple album match from the ISRC/UPC cascades.',
  },
  {
    input: 'Will Smith - Miami',
    text: { artist: 'Will Smith', title: 'Miami' },
    live: 'Free-text input: no link, the dash splits artist from title, the normal enrich pipeline runs (search cards + catalog matches, no source card).',
  },
  {
    input: 'Miami',
    text: { artist: '', title: 'Miami' },
    live: 'Reported 2026-08-20 as "Artist unknown" on the Spotify Miami track: title-only resolve depended on a single iTunes answer (rate-limited 403s). Now: Deezer-first + one targeted iTunes confirm auto-picks Will Smith (Deezer #1 + iTunes agree, verified); if iTunes is down, Deezer-only artist chips appear instead of silence.',
  },
  {
    input: 'https://spotify.link/AbCdEfGhIj',
    fail: { reason: 'shortlink', note: /open\.spotify\.com/ },
    live: 'Cannot be expanded client-side — user is told to open it once and paste the full link.',
  },
  {
    input: 'https://taylor.lnk.to/SpeakNowTaylorsVersion',
    fail: { reason: 'smartlink', note: /smart link/i },
    live: 'Linkfire pages hold the per-platform links but send no CORS headers (verified 2026-08-20).',
  },
  {
    input: 'https://smarturl.it/anything',
    fail: { reason: 'smartlink', note: /dead|shut down/i },
    live: 'smartURL is dead — the user gets told the link won’t open anywhere.',
  },
];
