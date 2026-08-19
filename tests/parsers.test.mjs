// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, slugToWords } from '../js/parsers.mjs';

const SPOTIFY_ID = '0Jcij1eWd5bDMU5iPbxe2i';

function expectOk(input, expected) {
  const r = parseInput(input);
  assert.equal(r.ok, true, `should parse: ${input}`);
  for (const [k, v] of Object.entries(expected)) {
    if (k === 'meta') {
      for (const [mk, mv] of Object.entries(v)) assert.equal(r.meta[mk], mv, `${input} meta.${mk}`);
    } else {
      assert.equal(r[k], v, `${input} → ${k}`);
    }
  }
  return r;
}

test('spotify track URL variants', () => {
  expectOk(`https://open.spotify.com/track/${SPOTIFY_ID}`, { platform: 'spotify', kind: 'track', id: SPOTIFY_ID });
  expectOk(`https://open.spotify.com/track/${SPOTIFY_ID}?si=abc123`, { platform: 'spotify', kind: 'track', id: SPOTIFY_ID });
  expectOk(`https://open.spotify.com/intl-de/track/${SPOTIFY_ID}`, { platform: 'spotify', kind: 'track', id: SPOTIFY_ID });
  expectOk(`open.spotify.com/track/${SPOTIFY_ID}`, { platform: 'spotify', kind: 'track', id: SPOTIFY_ID });
  expectOk(`spotify:track:${SPOTIFY_ID}`, { platform: 'spotify', kind: 'track', id: SPOTIFY_ID });
  expectOk(`https://open.spotify.com/album/${SPOTIFY_ID}`, { platform: 'spotify', kind: 'album' });
  expectOk(`https://open.spotify.com/artist/${SPOTIFY_ID}`, { platform: 'spotify', kind: 'artist' });
});

test('spotify short links are flagged, not parsed', () => {
  const r = parseInput('https://spotify.link/AbCdEf');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'shortlink');
  assert.match(r.note, /open\.spotify\.com/);
});

test('apple music URL variants', () => {
  expectOk('https://music.apple.com/us/album/take-on-me-1985-12-mix-2015-remastered/1035047659?i=1035048414',
    { platform: 'appleMusic', kind: 'track', id: '1035048414', meta: { storefront: 'us', albumId: '1035047659' } });
  expectOk('https://music.apple.com/de/song/blinding-lights/1499378615',
    { platform: 'appleMusic', kind: 'track', id: '1499378615', meta: { storefront: 'de' } });
  expectOk('https://music.apple.com/de/album/after-hours/1499378108',
    { platform: 'appleMusic', kind: 'album', id: '1499378108' });
  expectOk('https://music.apple.com/de/artist/the-weeknd/479756766',
    { platform: 'appleMusic', kind: 'artist', id: '479756766' });
  // geo. and legacy itunes. hosts behave identically
  expectOk('https://geo.music.apple.com/us/album/x/1035047659?i=1035048414',
    { platform: 'appleMusic', kind: 'track', id: '1035048414' });
  expectOk('https://itunes.apple.com/us/album/x/1035047659?i=1035048414',
    { platform: 'appleMusic', kind: 'track', id: '1035048414' });
});

test('youtube URL variants share one ID space', () => {
  const id = 'dQw4w9WgXcQ';
  expectOk(`https://www.youtube.com/watch?v=${id}`, { platform: 'youtube', kind: 'track', id });
  expectOk(`https://youtu.be/${id}`, { platform: 'youtube', kind: 'track', id });
  expectOk(`https://youtu.be/${id}?t=42`, { platform: 'youtube', kind: 'track', id });
  expectOk(`https://m.youtube.com/watch?v=${id}`, { platform: 'youtube', kind: 'track', id });
  expectOk(`https://www.youtube.com/shorts/${id}`, { platform: 'youtube', kind: 'track', id });
  expectOk(`https://www.youtube.com/watch?v=${id}&list=PLx`, { platform: 'youtube', kind: 'track', id });
  const r = expectOk(`https://music.youtube.com/watch?v=${id}`, { platform: 'youtube', kind: 'track', id });
  assert.equal(r.meta.music, true);
});

test('deezer URL variants', () => {
  expectOk('https://www.deezer.com/track/3135556', { platform: 'deezer', kind: 'track', id: '3135556' });
  expectOk('https://www.deezer.com/en/track/3135556', { platform: 'deezer', kind: 'track', id: '3135556' });
  expectOk('https://deezer.com/de/album/302127', { platform: 'deezer', kind: 'album', id: '302127' });
  expectOk('https://www.deezer.com/artist/27', { platform: 'deezer', kind: 'artist', id: '27' });
});

test('deezer short links are flagged; page.link is dead', () => {
  assert.equal(parseInput('https://link.deezer.com/s/abc123').reason, 'shortlink');
  const dead = parseInput('https://deezer.page.link/xyz');
  assert.equal(dead.reason, 'shortlink');
  assert.match(dead.note, /dead|shut down/i);
});

test('tidal URL variants', () => {
  expectOk('https://tidal.com/track/86024647', { platform: 'tidal', kind: 'track', id: '86024647' });
  expectOk('https://tidal.com/browse/track/86024647', { platform: 'tidal', kind: 'track', id: '86024647' });
  expectOk('https://listen.tidal.com/track/86024647', { platform: 'tidal', kind: 'track', id: '86024647' });
  expectOk('https://tidal.com/browse/album/86024646', { platform: 'tidal', kind: 'album', id: '86024646' });
});

test('amazon music URL variants', () => {
  expectOk('https://music.amazon.de/albums/B08F6QDPXY?trackAsin=B08F6R281V',
    { platform: 'amazonMusic', kind: 'track', id: 'B08F6R281V', meta: { tld: 'de', albumAsin: 'B08F6QDPXY' } });
  expectOk('https://music.amazon.com/tracks/B08F6R281V', { platform: 'amazonMusic', kind: 'track', id: 'B08F6R281V' });
  expectOk('https://music.amazon.co.uk/artists/B000QJPU8Y', { platform: 'amazonMusic', kind: 'artist', meta: { tld: 'co.uk' } });
  expectOk('https://music.amazon.de/albums/B08F6QDPXY', { platform: 'amazonMusic', kind: 'album' });
});

test('soundcloud URL variants', () => {
  expectOk('https://soundcloud.com/forss/flickermood',
    { platform: 'soundcloud', kind: 'track', meta: { user: 'forss', slug: 'flickermood' } });
  expectOk('https://soundcloud.com/user/sets/some-playlist', { platform: 'soundcloud', kind: 'album' });
  assert.equal(parseInput('https://on.soundcloud.com/abc').reason, 'shortlink');
  assert.equal(parseInput('https://snd.sc/abc').reason, 'shortlink');
  assert.equal(parseInput('https://soundcloud.com/search?q=x').ok, false);
});

test('bandcamp URL variants', () => {
  expectOk('https://artistname.bandcamp.com/track/some-song',
    { platform: 'bandcamp', kind: 'track', meta: { artist: 'artistname', slug: 'some-song' } });
  expectOk('https://artistname.bandcamp.com/album/some-album', { platform: 'bandcamp', kind: 'album' });
});

test('garbage input fails cleanly', () => {
  assert.equal(parseInput('').ok, false);
  assert.equal(parseInput('   ').ok, false);
  assert.equal(parseInput('hello world').ok, false);
  assert.equal(parseInput('https://example.com/track/123').ok, false);
  assert.equal(parseInput('https://open.spotify.com/track/tooshort').ok, false);
  assert.equal(parseInput('https://www.youtube.com/watch?v=bad').ok, false);
});

test('slugToWords', () => {
  assert.equal(slugToWords('harder-better-faster_stronger'), 'harder better faster stronger');
  assert.equal(slugToWords(''), '');
});
