// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput } from '../js/parsers.mjs';
import { embedFor, appLinkFor } from '../js/embeds.mjs';
import { mapUrlsToPlatforms } from '../js/adapters.mjs';

const parse = (url) => parseInput(url);

test('embedFor builds the documented embed URLs', () => {
  assert.deepEqual(embedFor(parse('https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i'), true), {
    src: 'https://open.spotify.com/embed/track/0Jcij1eWd5bDMU5iPbxe2i?utm_source=generator&theme=0',
    height: 152,
  });
  assert.equal(embedFor(parse('https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i'), false).src.endsWith('theme=1'), true);
  assert.deepEqual(embedFor(parse('https://youtu.be/dQw4w9WgXcQ')), {
    src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    aspect: '16 / 9',
  });
  assert.deepEqual(embedFor(parse('https://www.deezer.com/track/3135556')), {
    src: 'https://widget.deezer.com/widget/auto/track/3135556',
    height: 150,
  });
  assert.deepEqual(embedFor(parse('https://tidal.com/album/528973835/u')), {
    src: 'https://embed.tidal.com/albums/528973835',
    height: 275,
  });
  assert.deepEqual(embedFor(parse('https://tidal.com/browse/track/86024647')), {
    src: 'https://embed.tidal.com/tracks/86024647',
    height: 120,
  });
  assert.equal(
    embedFor(parse('https://soundcloud.com/forss/flickermood')).src,
    'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fforss%2Fflickermood&show_comments=false'
  );
});

test('embedFor returns null where no embed is buildable', () => {
  // Apple Music: disabled — player provably fails to initialize (2026-08-20).
  assert.equal(embedFor(parse('https://music.apple.com/us/album/x/1035047659?i=1035048414')), null);
  assert.equal(embedFor(parse('https://artistname.bandcamp.com/track/some-song')), null);
  assert.equal(embedFor(parse('https://music.amazon.de/tracks/B0H3BMWT2H')), null);
  assert.equal(embedFor(parse('https://open.qobuz.com/album/mm9mf2wj0a54u')), null);
  assert.equal(embedFor({ ok: false }), null);
  assert.equal(embedFor(null), null);
});

test('mapUrlsToPlatforms maps MusicBrainz URL relations onto cards', () => {
  // Real relation set from the ISRC chain measurement (Rick Astley).
  const mapped = mapUrlsToPlatforms([
    'https://music.youtube.com/watch?v=Om61naQC8is',
    'https://open.spotify.com/track/1Ojc3QD0dfJ5HG8uzLsfTg',
    'https://open.spotify.com/track/6JEK0CvvjDjjMUBFoXShNZ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://rateyourmusic.com/song/rick-astley/never-gonna-give-you-up/',
    'https://music.apple.com/gb/song/1438556832',
  ]);
  assert.deepEqual(mapped, {
    youtubeMusic: 'https://music.youtube.com/watch?v=Om61naQC8is',
    spotify: 'https://open.spotify.com/track/1Ojc3QD0dfJ5HG8uzLsfTg',
    youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    appleMusic: 'https://music.apple.com/gb/song/1438556832',
  });
  assert.deepEqual(mapUrlsToPlatforms([]), {});
  assert.deepEqual(mapUrlsToPlatforms(['https://example.com/x']), {});
});

test('appLinkFor: only documented schemes (Spotify) plus Deezer best effort', () => {
  assert.equal(appLinkFor(parse('https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i')).href,
    'spotify:track:0Jcij1eWd5bDMU5iPbxe2i');
  assert.equal(appLinkFor(parse('https://www.deezer.com/track/3135556')).href,
    'deezer://www.deezer.com/track/3135556');
  assert.equal(appLinkFor(parse('https://music.apple.com/us/album/x/1035047659?i=1035048414')).href,
    'music://music.apple.com/us/album/1035047659?i=1035048414');
  assert.equal(appLinkFor(parse('https://tidal.com/track/86024647')), null);
  assert.equal(appLinkFor(parse('https://youtu.be/dQw4w9WgXcQ')), null);
  assert.equal(appLinkFor(null), null);
});

// Whenever the parser resolves an entity on a platform that has a scheme,
// the app link must be offered — no kind may silently fall through.
test('appLinkFor: every kind the parser resolves gets an app link', () => {
  const cases = [
    ['https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i', 'spotify:track:0Jcij1eWd5bDMU5iPbxe2i'],
    ['https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa', 'spotify:album:4m2880jivSbbyEGAKfITCa'],
    ['https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi', 'spotify:artist:4tZwfgrHOc3mvqYlEYSvVi'],
    ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'],
    ['https://open.spotify.com/intl-de/track/0Jcij1eWd5bDMU5iPbxe2i', 'spotify:track:0Jcij1eWd5bDMU5iPbxe2i'],
    ['spotify:track:0Jcij1eWd5bDMU5iPbxe2i', 'spotify:track:0Jcij1eWd5bDMU5iPbxe2i'],
    ['https://music.apple.com/de/album/697194953', 'music://music.apple.com/de/album/697194953'],
    ['https://music.apple.com/gb/song/1438556832', 'music://music.apple.com/gb/song/1438556832'],
    ['https://music.apple.com/de/artist/greta/1646937897', 'music://music.apple.com/de/artist/1646937897'],
    ['https://www.deezer.com/album/302127', 'deezer://www.deezer.com/album/302127'],
    ['https://www.deezer.com/artist/27', 'deezer://www.deezer.com/artist/27'],
    ['https://www.deezer.com/playlist/1479458365', 'deezer://www.deezer.com/playlist/1479458365'],
  ];
  for (const [url, href] of cases) {
    assert.equal(appLinkFor(parse(url))?.href, href, url);
  }
});

