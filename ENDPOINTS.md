# External endpoints & URL schemes — maintenance map

Everything musiclinkii touches outside its own origin, in one place.
When something breaks, find the row, check "Where to look", fix the one
code location. All statuses were verified empirically on the date given
(browser fetch with a foreign `Origin`, logged-out).

## Metadata APIs (called from the browser)

| Endpoint | Purpose | Auth | CORS | Verified | Code | Where to look on breakage |
|---|---|---|---|---|---|---|
| `itunes.apple.com/lookup?id=&country=` | Apple track/album → title, artist, artwork, exact link | none | `*` | 2026-08-19 | `js/adapters.mjs` `fromApple` | [iTunes Search API docs](https://performance-partners.apple.com/search-api) |
| `itunes.apple.com/search?term=&media=music&entity=song` | exact Apple Music match for enrichment | none | `*` | 2026-08-19 | `js/adapters.mjs` `findExactLinks` | same as above |
| `api.deezer.com/track/{id}` (JSONP) | Deezer track → title, artist, **ISRC**, cover | none | blocked → JSONP (`output=jsonp&callback=`) | 2026-08-19 | `js/adapters.mjs` `fromDeezer`, `jsonp()` | [developers.deezer.com](https://developers.deezer.com/api) |
| `api.deezer.com/search?q=` (JSONP) | exact Deezer match for enrichment. **Plain query only** — quoted `artist:"x" track:"y"` returns empty result sets on the API (web search is fine with it) | none | JSONP | 2026-08-20 | `js/adapters.mjs` `findExactLinks` | same as above |
| `www.youtube.com/oembed?url=` | YouTube video → title ("Artist - Title"), channel ("X - Topic") | none | origin reflection | 2026-08-19 | `js/adapters.mjs` `fromYoutube` | oEmbed is undocumented by Google; fallback: [noembed.com](https://noembed.com) (CORS `*`) |
| `open.spotify.com/oembed?url=` | Spotify link → title only (**no artist field**), thumbnail | none | `*` | 2026-08-19 | `js/adapters.mjs` `fromSpotify` | [Spotify oEmbed docs](https://developer.spotify.com/documentation/embeds/reference/oembed) |
| `musicbrainz.org/ws/2/url/?resource=` + `/recording/{id}` | Tidal fallback: URL relation → recording → artist credits | none (UA not settable from browsers) | `*` | 2026-08-19 | `js/adapters.mjs` `fromTidal` | [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API), rate ~1 req/s, 503 on excess |
| `soundcloud.com/oembed?url=` | SoundCloud track → "Title by Artist" | none | untested, wrapped in try/catch | — | `js/adapters.mjs` `fromSoundcloud` | [SC oEmbed docs](https://developers.soundcloud.com/docs/oembed) |

No keyless metadata path exists (verified, not an oversight): **Tidal**
(oembed.tidal.com has no fields, tidal.com/oembed sits behind DataDome),
**Amazon Music**, **Bandcamp**, **Qobuz** (API partner-keyed, autosuggest
auth-gated). **Odesli/Songlink API is dead** (401 since 2026-07-31, never
CORS-open) — do not rebuild on it.

## Search URL schemes (structured where supported — all live-verified 2026-08-20)

| Platform | Scheme | Structure used |
|---|---|---|
| Spotify | `open.spotify.com/search/{q}` | field filters `artist:X track:"Y"` / `album:"Y"` in the path |
| Deezer | `deezer.com/search/{q}` | field filters `artist:"X" track:"Y"` / `album:"Y"` (web only!) |
| TIDAL | `tidal.com/search/{tracks\|albums\|artists}?q=` | typed route |
| SoundCloud | `soundcloud.com/search/{sounds\|albums\|people}?q=` | typed route |
| Qobuz | `www.qobuz.com/{sf}/search/{tracks\|albums\|artists}/{q}` | typed route (`open.qobuz.com` ignores `?q=`) |
| Bandcamp | `bandcamp.com/search?q=&item_type={t\|a\|b}` | item_type facet |
| Apple Music | `music.apple.com/{sf}/search?term=` | plain — no documented field syntax |
| YouTube | `youtube.com/results?search_query=` | plain |
| YouTube Music | `music.youtube.com/search?q=` | plain |
| Amazon Music | `music.amazon.{tld}/search/{q}` | plain |

All builders live in `js/links.mjs` (`PLATFORMS[].searchUrl`), tests in
`tests/links.test.mjs`.

## Input link parsing

All recognized URL shapes live in `js/parsers.mjs` with per-platform
comments; smart-link domains (Linkfire `lnk.to`, Feature.fm `ffm.to`,
Orchard `orcd.co`, Believe `bfan.link`, DistroKid, Hypeddit, …) are
recognized but not fetchable (no CORS on any of them, verified
2026-08-20). `song.link`/`album.link` `/s|i|y|d|t/{id}` paths resolve
natively. Tests: `tests/parsers.test.mjs`.

## Embed players (`js/embeds.mjs`, click-to-load only)

| Host | Template | Status |
|---|---|---|
| `open.spotify.com/embed/{track\|album}/{id}?theme=` | 152/352px | ✅ renders (2026-08-20) |
| `www.youtube-nocookie.com/embed/{id}` | 16:9 | ✅ renders — [official privacy host](https://support.google.com/youtube/answer/171780) |
| `widget.deezer.com/widget/auto/{track\|album}/{id}` | 150/300px | ✅ renders |
| `embed.tidal.com/{tracks\|albums}/{id}` | 120/275px | ✅ renders — [TIDAL embeds](https://developer.tidal.com/documentation/embeds/embeds-overview) |
| `embed.music.apple.com/…` | — | ❌ **disabled**: loads MusicKit but never issues a catalog request, stays a grey placeholder (2026-08-20). Re-check occasionally; generator: [toolbox.marketingtools.apple.com](https://toolbox.marketingtools.apple.com/apple-music) |
| `w.soundcloud.com/player/?url=` | 166px | in code, untested render |

## App deep links (`js/embeds.mjs` `appLinkFor`)

- `spotify:{kind}:{id}` — [IANA-registered](https://www.iana.org/assignments/uri-schemes/prov/spotify), documented by Spotify.
- `deezer://www.deezer.com/{kind}/{id}` — community practice, best effort.
- `music://music.apple.com/…` — the `https→music` transform of the
  canonical URL; long-standing pattern on Apple platforms, not formally
  documented. Best effort.
- Everything else has no documented scheme (checked 2026-08-20: Tidal,
  YouTube Music, Amazon, SoundCloud, Qobuz) — https universal links
  already open those apps on mobile.

## Share links

`#l={encodeURIComponent(pasted link)}` in the fragment — parsed on load
(`js/app.mjs`), built by `shareHashFor`/`linkFromHash` in `js/links.mjs`.
Fragment-only by design: it never reaches a server.
