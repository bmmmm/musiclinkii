# External endpoints & URL schemes — maintenance map

Everything musiclinkii touches outside its own origin, in one place.
When something breaks, find the row, check "Where to look", fix the one
code location. All statuses were verified empirically on the date given
(browser fetch with a foreign `Origin`, logged-out).

## Metadata APIs (called from the browser)

| Endpoint | Purpose | Auth | CORS | Verified | Code | Where to look on breakage |
|---|---|---|---|---|---|---|
| `itunes.apple.com/lookup?id=&country=` | Apple track/album → title, artist, artwork, exact link | none | `*` | 2026-08-19 | `js/adapters.mjs` `fromApple` | [iTunes Search API docs](https://performance-partners.apple.com/search-api) |
| `itunes.apple.com/search?term=&media=music&entity=song` | exact Apple Music track match for enrichment | none | `*` | 2026-08-19 | `js/adapters.mjs` `itunesSearch` | same as above. **Rate limit:** bursts get 403'd; after any rejection `itunesSearch` cools down for 60 s and returns "no signal" — the title-only path degrades to Deezer-only artist chips instead of failing silently. The title-only flow makes exactly ONE artist-targeted iTunes call (Deezer runs first). Apple-source pastes skip the enrichment search entirely — the source card keeps the pasted link, so the result would be discarded (verified 2026-08-20: only `/lookup` fires) |
| `itunes.apple.com/search?term=&media=music&entity=album` | exact Apple Music album match for enrichment ("Daft Punk Discovery" → right album #1, verified) | none | `*` | 2026-08-20 | `js/adapters.mjs` `itunesSearch` | same as above |
| `api.deezer.com/track/{id}` (JSONP) | Deezer track → title, artist, **ISRC**, cover | none | blocked → JSONP (`output=jsonp&callback=`) | 2026-08-19 | `js/adapters.mjs` `fromDeezer`, `jsonp()` | [developers.deezer.com](https://developers.deezer.com/api) |
| `api.deezer.com/album/{id}` (JSONP) | Deezer album → title, artist, **UPC/barcode**, cover | none | JSONP | 2026-08-20 | `js/adapters.mjs` `fromDeezer`, `fetchDeezerUpc` | same as above |
| `api.deezer.com/search?q=` (JSONP) | exact Deezer track match for enrichment. **Plain query only** — quoted `artist:"x" track:"y"` returns empty result sets on the API (web search is fine with it) | none | JSONP | 2026-08-20 | `js/adapters.mjs` `deezerSearch` | same as above |
| `api.deezer.com/search/album?q=` (JSONP) | exact Deezer album match for enrichment (plain "Discovery" ranks Daft Punk #1, verified) | none | JSONP | 2026-08-20 | `js/adapters.mjs` `deezerSearch` | same as above |
| `api.deezer.com/search/artist?q=` (JSONP) | exact Deezer artist match for artist searches (rows carry `name`/`picture_medium`/`link`) | none | JSONP | untested live — verify field names on first breakage | `js/adapters.mjs` `deezerSearch`, `deezerCandidates` | same as above |
| `itunes.apple.com/search?term=&media=music&entity=musicArtist` | exact Apple Music artist match (rows carry `artistName`/`artistLinkUrl`/`artistId`) | none | `*` | untested live — verify field names on first breakage | `js/adapters.mjs` `itunesSearch`, `itunesCandidates` | same as the iTunes rows above (shared 403 cooldown) |
| `musicbrainz.org/ws/2/url/?resource=&inc=artist-rels` → `artist/{mbid}?inc=url-rels` (fallback: `artist/?query=artist:"…"`) | artist streaming-profile URL (Deezer/Apple match or the pasted link) → MB artist → URL relations → exact artist links on other platforms. Anchor-first: the URL identifies the artist, the name search is fuzzy and gated (score ≥ 90 + loose match). The url lookup carries **no url-rels on the artist stub** — the second lookup is mandatory (same constraint as the barcode cascade); 2–3 spaced MB calls | none | `*` | url-route verified 2026-08-20 (`fromTidal`); artist fan-out untested live | `js/adapters.mjs` `findLinksByArtist`, `pickMbArtist`; `js/app.mjs` `runArtistLookup` | same MB notes as above |
| `www.youtube.com/oembed?url=` | YouTube video → title ("Artist - Title"), channel ("X - Topic") | none | origin reflection | 2026-08-19 | `js/adapters.mjs` `fromYoutube` | oEmbed is undocumented by Google; fallback: [noembed.com](https://noembed.com) (CORS `*`) |
| `open.spotify.com/oembed?url=` | Spotify link → title only (**no artist field**), thumbnail | none | `*` | 2026-08-19 | `js/adapters.mjs` `fromSpotify` | [Spotify oEmbed docs](https://developer.spotify.com/documentation/embeds/reference/oembed) |
| `musicbrainz.org/ws/2/url/?resource=` + `/recording/{id}` or `/release/{id}` | Tidal fallback: URL relation → recording (tracks) / release (albums, verified: album 1550545 → "Discovery") / artist via `inc=artist-rels` (artist pages, verified: artist/8847 → "Daft Punk") → artist credits | none (UA not settable from browsers) | `*` | 2026-08-20 | `js/adapters.mjs` `fromTidal` | [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API), rate ~1 req/s, 503 on excess. The queried path must keep the pasted entity kind — `track/{id}` with an artist/video id is a numeric-collision lottery |
| `musicbrainz.org/ws/2/isrc/{isrc}?inc=url-rels` | ISRC (from Deezer) → recording URL relations → **the only keyless path to an exact Spotify link**; also yields Apple/YT Music/Tidal links | none | `*` | 2026-08-20 | `js/adapters.mjs` `findLinksByIsrc`, `js/app.mjs` `enrichViaIsrc` | same as above. Coverage is community-driven: good for known tracks (Rick Astley, Daft Punk verified), 404/empty for fresh releases (Mine 2026, Dilated Peoples verified empty) |
| `musicbrainz.org/ws/2/release/?query=barcode:{upc}` + `release/{id}?inc=url-rels` | UPC (from Deezer album) → release URL relations → **the only keyless path to an exact Spotify ALBUM link**; Discovery also yielded exact Tidal, Deezer and Qobuz albums | none | `*` | 2026-08-20 | `js/adapters.mjs` `findLinksByUpc`, `js/app.mjs` `enrichViaUpc` | The search response carries **no url-rels inline** — the two-step (search, then per-release lookup) is mandatory. Capped at 2 release lookups ≈ 3 throttled MB calls through the shared `mbJson` queue. MB stores Apple links id-prefixed (`itunes.apple.com/{cc}/album/id{n}`) — `parseApple` accepts that form |

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
spacing) to respect the 1 req/s budget. MB still 503s sporadically even
under that budget (measured 2026-08-20: one of three spaced calls
throttled, silently costing the Tidal/Qobuz album rels) — `mbJson`
retries a 503 once after a double gap; other errors (404) surface
unchanged. All MB fetches use `cache: 'no-store'`: Chrome caches MB's
503 responses and re-serves them without touching the network (measured
2026-08-20), which would otherwise poison every retry.

The honest keyless fallback where MB has nothing: Spotify's own `isrc:`
**search filter** (see the search table below) — a search page, not a
track permalink, but it lands on exactly the right track. A keyless
Spotify search *API* still does not exist: `/v1/search` needs OAuth, and
the anonymous web-player token (`open.spotify.com/get_access_token`) was
locked down with a TOTP scheme in 2025 (breaks repeatedly, see
librespot#1475) and never sent CORS headers for foreign origins anyway.

**Measured dead ends for ALBUMS (2026-08-20, do not rebuild):** Spotify's
documented `upc:` search filter returns **zero results** logged-out
(`open.spotify.com/search/upc:724384960650` → "no results" for Daft Punk
Discovery), and a plain-UPC query returns unrelated noise — the album
analog of the `isrc:` filter does not exist in practice; the exact
Spotify album link comes only via the MB barcode cascade above. The
Spotify **embed page** (`open.spotify.com/embed/track/{id}`, which embeds
the artist in its page JSON) sends no CORS headers — fetch from a foreign
origin fails; there is still no keyless direct source for a Spotify
track's artist.
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
| YouTube Music | `music.youtube.com/search?q=` | **plain ISRC as query when known** (tracks only) — Content-ID makes ISRCs searchable, returns exactly the right song incl. fresh releases (Clockwork + Mine verified logged-out 2026-08-20). **Plain UPC as query for albums** — lands exactly "Discovery — Album — Daft Punk" (verified logged-out 2026-08-20). Plain youtube.com ranks the Topic track first but buries the music video, and Tidal/Amazon return nothing/noise for ISRC queries (verified) — so only this card and Spotify search by ISRC; for UPC only this card (Spotify's `upc:` filter is dead, see above). Else plain free-text |
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

**Free-text input:** anything that doesn't look like a link
(`looksLikeLink` in `js/parsers.mjs`: no scheme, no `spotify:` URI, and
the pre-path token has no TLD-shaped last dot-label) is treated as an
"Artist - Title" search — `parseFreeText` (`js/adapters.mjs`) splits at
the first spaced dash, the normal enrich pipeline runs, and `#l=` carries
the text just like a link. With the **Artist** kind selected the text is
never dash-split — the whole input is the artist name. Dotted band names ("N.W.A", "R.E.M.") stay
text because their last label is a single letter; a space-free dotted
title like "Wow.Wow" is a known accepted miss (treated as a link).

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
Non-track searches append `&k={album|artist}` so a shared search keeps
its kind. Fragment-only by design: it never reaches a server.
