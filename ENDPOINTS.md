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
| `musicbrainz.org/ws/2/isrc/{isrc}?inc=url-rels` | ISRC (from Deezer) → recording URL relations → **the only keyless path to an exact Spotify link**; also yields Apple/YT Music/Tidal links | none | `*` | 2026-08-20 | `js/adapters.mjs` `findLinksByIsrc`, `js/app.mjs` `enrichViaIsrc` | same as above. Coverage is community-driven: good for known tracks (Rick Astley, Daft Punk verified), 404/empty for fresh releases (Mine 2026, Dilated Peoples verified empty) |

**Measured dead ends for the Spotify match rate (2026-08-20, regression
list, do not rebuild):** the MB *recording search*
(`/ws/2/recording?query=…` + per-recording `inc=url-rels` lookup) scored
0/6 — search returns valid recordings (score 100), but the Spotify rels
hang on *other* recordings of the same song that only the ISRC lookup
aggregates; even Rick Astley/Daft Punk miss via search. Trying *alternate
Deezer ISRCs* (remasters/compilations) also adds 0 — they are either not
in MB at all (404) or point to recordings without url-rels. The coverage
gap is missing Spotify URL relations in MusicBrainz itself, not the
lookup route. All MB calls share one throttle queue (`mbJson`, ~1.1 s
spacing) to respect the 1 req/s budget.

The honest keyless fallback where MB has nothing: Spotify's own `isrc:`
**search filter** (see the search table below) — a search page, not a
track permalink, but it lands on exactly the right track. A keyless
Spotify search *API* still does not exist: `/v1/search` needs OAuth, and
the anonymous web-player token (`open.spotify.com/get_access_token`) was
locked down with a TOTP scheme in 2025 (breaks repeatedly, see
librespot#1475) and never sent CORS headers for foreign origins anyway.
| `soundcloud.com/oembed?url=` | SoundCloud track → "Title by Artist" | none | untested, wrapped in try/catch | — | `js/adapters.mjs` `fromSoundcloud` | [SC oEmbed docs](https://developers.soundcloud.com/docs/oembed) |

No keyless metadata path exists (verified, not an oversight): **Tidal**
(oembed.tidal.com has no fields, tidal.com/oembed sits behind DataDome),
**Amazon Music**, **Bandcamp**, **Qobuz** (API partner-keyed, autosuggest
auth-gated). **Odesli/Songlink API is dead** (401 since 2026-07-31, never
CORS-open) — do not rebuild on it.

## Search URL schemes (structured where supported — all live-verified 2026-08-20)

| Platform | Scheme | Structure used |
|---|---|---|
| Spotify | `open.spotify.com/search/{q}` | **`isrc:{ISRC}` when an ISRC is known** (tracks only) — Spotify indexes its own ISRCs, so this lands the exact track even where MusicBrainz has nothing; all three MB-miss regression cases verified logged-out 2026-08-20. Else field filters `artist:X track:"Y"` / `album:"Y"` in the path |
| Deezer | `deezer.com/search/{q}` | field filters `artist:"X" track:"Y"` / `album:"Y"` (web only!) |
| TIDAL | `tidal.com/search/{tracks\|albums\|artists}?q=` | typed route |
| SoundCloud | `soundcloud.com/search/{sounds\|albums\|people}?q=` | typed route |
| Qobuz | `www.qobuz.com/{sf}/search/{tracks\|albums\|artists}/{q}` | typed route (`open.qobuz.com` ignores `?q=`) |
| Bandcamp | `bandcamp.com/search?q=&item_type={t\|a\|b}` | item_type facet |
| Apple Music | `music.apple.com/{sf}/search?term=` | plain — no documented field syntax |
| YouTube | `youtube.com/results?search_query=` | plain |
| YouTube Music | `music.youtube.com/search?q=` | **plain ISRC as query when known** (tracks only) — Content-ID makes ISRCs searchable, returns exactly the right song incl. fresh releases (Clockwork + Mine verified logged-out 2026-08-20). Plain youtube.com ranks the Topic track first but buries the music video, and Tidal/Amazon return nothing/noise for ISRC queries (verified) — so only this card and Spotify search by ISRC. Else plain free-text |
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
