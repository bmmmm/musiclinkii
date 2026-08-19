# musiclinkii

One music link in — every platform out.

Paste a track link from Spotify, Apple Music, YouTube / YouTube Music, Deezer,
TIDAL, Amazon Music, SoundCloud or Bandcamp and get links to the same track on
every other streaming platform. Fully static, no server, no tracking.

**Live: <https://bmmmm.github.io/musiclinkii/>**

## How it works

Everything runs in your browser — there is no backend:

1. **Parse** — the pasted link is matched against each platform's known URL
   schemes (`open.spotify.com/track/{id}`, `music.apple.com/{sf}/album/…?i={id}`,
   `youtu.be/{id}`, `deezer.com/track/{id}`, `tidal.com/track/{id}`, …).
2. **Resolve** — title and artist are fetched from keyless public endpoints
   that allow cross-origin requests (verified empirically):
   [iTunes Lookup/Search](https://performance-partners.apple.com/search-api),
   YouTube oEmbed, Spotify oEmbed, the Deezer API (via JSONP) and
   [MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_API) as a fallback.
   The extracted artist/title stays editable, so a wrong guess is never a
   dead end.
3. **Link out** — exact matches (marked ✓) are found where a platform offers
   keyless search (Deezer, iTunes → Apple Music); every other platform gets an
   honest search link built from its live-verified search URL scheme.

Why no [Odesli/Songlink](https://odesli.co/)? Its public API was sunset in
July 2026 and never allowed cross-origin browser calls — a static page can't
use it.

## Platform support

| Platform | Parse input | Metadata | Exact link out | Search link out | Preview embed | App link |
|---|---|---|---|---|---|---|
| Spotify | ✓ | title (oEmbed) | — | ✓ | ✓ | ✓ `spotify:` |
| Apple Music | ✓ | ✓ (iTunes) | ✓ (iTunes match) | ✓ | — (embed player broken upstream) | — |
| YouTube / YT Music | ✓ | ✓ (oEmbed) | same video | ✓ | ✓ (nocookie) | — |
| Deezer | ✓ | ✓ (JSONP) | ✓ (Deezer search) | ✓ | ✓ | ✓ `deezer://` |
| TIDAL | ✓ | best effort (MusicBrainz) | — | ✓ | ✓ | — |
| Amazon Music | ✓ | — | — | ✓ | — | — |
| SoundCloud | ✓ | best effort (oEmbed) | — | ✓ | ✓ | — |
| Bandcamp | ✓ | guessed from URL | — | ✓ | — | — |
| Qobuz | ✓ | guessed from URL | — | ✓ | — | — |

Short links (`spotify.link`, `link.deezer.com`, `on.soundcloud.com`) can't be
expanded client-side — open them once and paste the full URL instead.

**Previews are click-to-load**: the embed iframe (and its third-party
requests) only exists after you press the Preview button — nothing is loaded
from streaming providers before that. Tracking parameters in pasted links
(`?si=`, `ref=dm_sh_…`, `marketplaceId`, …) are stripped: every shown link is
rebuilt canonically from the parsed ID.

**App links** exist only where a URL scheme is actually documented:
`spotify:track:{id}` (IANA-registered) and, best effort, `deezer://`. Other
platforms have no reliable scheme — on mobile their https links already open
the native app via universal links. If the app isn't installed, browsers
silently ignore the click.

## Development

No build step, no dependencies. Serve the directory and open it:

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

Run the tests (URL parsers and link builders are pure functions):

```sh
node --test 'tests/*.test.mjs'
```

## Credits

Brand icons from [simple-icons](https://github.com/simple-icons/simple-icons)
(CC0-1.0). All trademarks belong to their respective owners.

## Support

If this saves you time, you can [support me on Ko-fi](https://ko-fi.com/bmabma).

## License

[GPL-3.0-or-later](LICENSE)
