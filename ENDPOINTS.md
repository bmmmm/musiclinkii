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
| `api.deezer.com/search?q=` (JSONP) | exact Deezer track match for enrichment. **Plain query only** — quoted `artist:"x" track:"y"` returns empty result sets on the API (web search is fine with it) | none | JSONP | 2026-08-20 | `js/adapters.mjs` `deezerSearch`, `deezerCascade` | same as above |
| `api.deezer.com/search/album?q=` (JSONP) | exact Deezer album match for enrichment (plain "Discovery" ranks Daft Punk #1, verified) | none | JSONP | 2026-08-22 (query cascade, 30-album live sample) | `js/adapters.mjs` `deezerSearch`, `deezerCascade`, `deezerQueries` | **Too specific a query drops the right row**: the full credit "Fred again.., Danny Brown, BEAM, PARISI & JPEGMAFIA OK OK" returns 3 unrelated candidates, "Fred again.. OK OK" returns 5 and hits. So the query degrades in stages — full credit → lead artist → title alone — and only a miss pays for the extra call. The **acceptance never widens**: `pickByArtist` runs against the full credit in every stage, because a title-only query ranks strangers first ("OK OK" → OT7 Quanny). Measured 2026-08-22 over Apple's most-played 30: 26/30 → 28/30, `scripts/measure-deezer-cascade.mjs`. Deezer carries **both** gendered and generic credits for the same kind of release ("Verschiedene Interpret:innen" alongside "Verschiedene Interpreten") — `normalize()` folds the gendered form onto the generic one |
| `api.deezer.com/search/artist?q=` (JSONP) | exact Deezer artist match for artist searches (rows carry `name`/`picture_medium`/`link`/`nb_fan`) | none | JSONP | 2026-08-21 (GRETA case) | `js/adapters.mjs` `deezerSearch`, `deezerCandidates` | **Rank order is untrustworthy for bare names**: "GRETA" returns five exact namesakes with a 2-fan act ranked above the 250-fan real artist, and the most-fans namesake (876, a casting-show catch-all with 135 albums) is wrong too — neither rank nor `nb_fan` identifies the artist. Link sessions prove the pick via the catalog probe below; `nb_fan` ordering is only the guess for typed searches |
| `api.deezer.com/artist/{id}/top?limit=10` (JSONP) | Deezer artist → top-track titles — the **identity probe**: one title shared with the source artist's own tracks proves a same-named candidate (strict searchable-title equality, subset matching would confirm covers). The same probes double as **namesake chips** (`Name — "TopTrack"`) when nothing proves out or a typed search hits ≥2 exact namesakes; a chip click pins the identity through the commit path (`q.pick`) and its top track then catalog-confirms the iTunes side too | none | JSONP | 2026-08-21 (incl. chip pin E2E) | `js/adapters.mjs` `deezerTopTitles`, `confirmByCatalog`, `probeNamesakes`, `fromDeezer` | up to 4 probes per artist search — Deezer JSONP has no hard rate limit |
| `itunes.apple.com/lookup?id=&entity=song&limit=10` | Apple artist id → artist row (`artistName`/`artistLinkUrl`, **no artwork**) PLUS its top songs in ONE call — source metadata and the identity-probe track list together | none | `*` | 2026-08-21 (GRETA 1646937897) | `js/adapters.mjs` `fromApple`, `itunesTopTitles` | first result row is the artist (`wrapperType: "artist"`), the rest are tracks |
| `itunes.apple.com/search?term=&media=music&entity=musicArtist` | exact Apple Music artist match (rows carry `artistName`/`artistLinkUrl`/`artistId`) | none | `*` | untested live — verify field names on first breakage | `js/adapters.mjs` `itunesSearch`, `itunesCandidates` | same as the iTunes rows above (shared 403 cooldown); catalog-probe confirms are capped at 2 lookups |
| `musicbrainz.org/ws/2/url/?resource=…&resource=…&inc=artist-rels` → `artist/{mbid}?inc=url-rels` (fallback: `artist/?query=artist:"…"`) | artist streaming-profile URLs (pasted link + catalog matches) → MB artist → URL relations → exact artist links on other platforms. Anchor-first: a URL identifies the artist, the name search is fuzzy and gated (score ≥ 90 + **exact normalized name** — the loose match let "GRETA" land on "Greta Keller", scored 100) and its hit only counts when the artist's own url-rels confirm an anchor entity. The url lookup carries **no url-rels on the artist stub** — the second lookup is mandatory (same constraint as the barcode cascade); 2–3 spaced MB calls, returned as `{ links, throttled }` | none | `*` | 2026-08-21 (GRETA negative + Daft Punk full fan-out + forced-503 note, E2E) | `js/adapters.mjs` `findLinksByArtist`, `expandArtistAnchor`, `relsConfirmAnchor`, `pickMbArtist`; `js/app.mjs` `runArtistLookup` | **MB stores Apple artist URLs slugless under whatever storefront the editor pasted** (Daft Punk: `music.apple.com/fr/…` AND legacy `itunes.apple.com/fr/artist/id…`) — a single-resource lookup misses routinely. The url route accepts repeated `resource=` params in one request; response shape switches to `{ urls: [{ relations }] }`. Deezer/Spotify/Tidal rel forms are canonical (`www.deezer.com/artist/{id}` etc.) |
| `www.youtube.com/oembed?url=` | YouTube video → title ("Artist - Title"), channel ("X - Topic") | none | origin reflection | 2026-08-19 | `js/adapters.mjs` `fromYoutube` | oEmbed is undocumented by Google; fallback: [noembed.com](https://noembed.com) (CORS `*`) |
| `open.spotify.com/oembed?url=` | Spotify link → title only (**no artist field**), thumbnail | none | `*` | 2026-08-19 | `js/adapters.mjs` `fromSpotify` | [Spotify oEmbed docs](https://developer.spotify.com/documentation/embeds/reference/oembed) |
| `musicbrainz.org/ws/2/url/?resource=` + `/recording/{id}` or `/release/{id}` | Tidal fallback: URL relation → recording (tracks) / release (albums, verified: album 1550545 → "Discovery") / artist via `inc=artist-rels` (artist pages, verified: artist/8847 → "Daft Punk") → artist credits | none (UA not settable from browsers) | `*` | 2026-08-20 | `js/adapters.mjs` `fromTidal` | [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API), rate ~1 req/s, 503 on excess. The queried path must keep the pasted entity kind — `track/{id}` with an artist/video id is a numeric-collision lottery |
| `musicbrainz.org/ws/2/isrc/{isrc}?inc=url-rels` | ISRC (from Deezer) → recording URL relations → **the only keyless path to an exact Spotify link**; also yields Apple/YT Music/Tidal links | none | `*` | 2026-08-20 | `js/adapters.mjs` `findLinksByIsrc`, `js/enrich.mjs` `enrichByCode('isrc')` | same as above. Coverage is community-driven: good for known tracks (Rick Astley, Daft Punk verified), 404/empty for fresh releases (Mine 2026, Dilated Peoples verified empty) |
| `musicbrainz.org/ws/2/release/?query=barcode:{upc}` + `release/{id}?inc=url-rels` | UPC (from Deezer album) → release URL relations → **the only keyless path to an exact Spotify ALBUM link**; Discovery also yielded exact Tidal, Deezer and Qobuz albums | none | `*` | 2026-08-20 | `js/adapters.mjs` `findLinksByUpc`, `js/enrich.mjs` `enrichByCode('upc')` | The search response carries **no url-rels inline** — the two-step (search, then per-release lookup) is mandatory. Capped at 2 release lookups ≈ 3 throttled MB calls through the shared `mbJson` queue; **typically 2 since 2026-08-21** — the caller passes `need` (the MB-only platforms still missing, `js/enrich.mjs` `missingMbKeys`) and the cascade stops as soon as none is open. Measured on `barcode:724384960650`: the 2005 release carries spotify/tidal/qobuz, the 2024 one adds only `music.apple.com`, already covered by release 1's legacy `itunes.apple.com` form. MB stores Apple links id-prefixed (`itunes.apple.com/{cc}/album/id{n}`) — `parseApple` accepts that form |

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
unchanged. Since 2026-08-21 a 503 that survives the retry is no longer
silent: `enrichByCode` reports it back and `runLookup` puts
*"MusicBrainz is rate-limiting — some exact links may be missing. Try
again in a minute."* on the note line (never overwriting a standing
note). A 404 does **not** trigger it — MB having no entry for a fresh
release is the normal case, not a failure. Re-committing the same query
clears `isrcChecked`/`upcChecked` and a 503 is never cached, so "try
again" really does try again.

The artist fan-out reports the same way. `findLinksByArtist` catches
every one of its MB calls — two of the three are *expected* to fail
routinely (MB has no relation for this URL) — and therefore returns
`{ links, throttled }` instead of a bare map, never rejecting.
`runArtistLookup` raises the same note on `throttled`. Two flags gate the
cache write: any 503 in the round, or a failed final `artist/{mbid}`
lookup, means the empty map is ignorance rather than an answer and must
not be stored. All MB fetches use `cache: 'no-store'`: Chrome caches MB's
503 responses and re-serves them without touching the network (measured
2026-08-20), which would otherwise poison every retry.

The three result lookups (`findLinksByIsrc`, `findLinksByUpc`,
`findLinksByArtist`) go through `js/cache.mjs` in localStorage — at
**result** level (a handful of URLs), not response level (the full
url-rels payload). Hits keep for 30 days, empty answers for 1 day (a
fresh release can be edited into MB tomorrow), errors never (a cached
503 would freeze the throttling window into a permanent "no links");
capped at 200 entries, oldest evicted first. Every access is guarded —
private mode throws on the property itself, so the cache degrades to
"no cache", never to a failed lookup.

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
| `embed.music.apple.com/…` | — | ❌ **disabled**: loads MusicKit but never issues a catalog request, stays a grey placeholder. Re-checked 2026-08-21, unchanged — 10 resources return 200 (`musickit.js`, `web-embed.esm.js`, components), nothing hits `amp-api.music.apple.com`, and the only image is a 1×1 WebP placeholder. Tested `/album/{id}?i={trackId}` and `/song/{id}`. Generator: [toolbox.marketingtools.apple.com](https://toolbox.marketingtools.apple.com/apple-music) |
| `w.soundcloud.com/player/?url=` | 166px | ✅ renders (2026-08-21) — verified with `soundcloud.com/forss/flickermood`: artwork, play button, waveform and play count all draw inside the 298×166 iframe |

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
