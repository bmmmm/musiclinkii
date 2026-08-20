// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, looksLikeLink, slugToWords } from '../js/parsers.mjs';
import { parseFreeText } from '../js/adapters.mjs';
import { REGRESSION_CASES } from './fixtures/regression-cases.mjs';

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
  // MusicBrainz stores Apple URL relations id-prefixed — required for the
  // ISRC/UPC cascades to turn them into match badges.
  expectOk('https://itunes.apple.com/gb/album/id697194953',
    { platform: 'appleMusic', kind: 'album', id: '697194953', url: 'https://music.apple.com/gb/album/697194953' });
  assert.equal(parseInput('https://itunes.apple.com/gb/album/idfoo').ok, false);
});

test('looksLikeLink separates links from free text', () => {
  for (const link of [
    'https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i',
    'open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i',
    'spotify:track:0Jcij1eWd5bDMU5iPbxe2i',
    'www.deezer.com/album/302127',
    'music.apple.com/de/album/discovery/697194953',
    'youtu.be/dQw4w9WgXcQ',
    'https://example.com/whatever',
  ]) assert.equal(looksLikeLink(link), true, link);
  for (const text of [
    'Will Smith - Miami',
    'Miami',
    'N.W.A',
    'R.E.M. - Losing My Religion',
    'Blink-182',
    'AC/DC - Thunderstruck',
    'Sigur Rós - Hoppípolla',
    '',
    '   ',
  ]) assert.equal(looksLikeLink(text), false, text);
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

test('qobuz URL variants', () => {
  expectOk('https://www.qobuz.com/de-de/album/uberall-kopf-3lna/mm9mf2wj0a54u',
    { platform: 'qobuz', kind: 'album', id: 'mm9mf2wj0a54u', meta: { slug: 'uberall-kopf-3lna', storefront: 'de-de' } });
  expectOk('https://www.qobuz.com/de-de/interpreter/daft-punk/36819',
    { platform: 'qobuz', kind: 'artist', id: '36819' });
  expectOk('https://open.qobuz.com/track/17985121',
    { platform: 'qobuz', kind: 'track', id: '17985121', url: 'https://open.qobuz.com/track/17985121' });
  expectOk('https://play.qobuz.com/album/qxjbxh1dc3xyb',
    { platform: 'qobuz', kind: 'album', id: 'qxjbxh1dc3xyb', url: 'https://open.qobuz.com/album/qxjbxh1dc3xyb' });
  expectOk('https://open.qobuz.com/artist/68534', { platform: 'qobuz', kind: 'artist', id: '68534' });
  assert.equal(parseInput('https://www.qobuz.com/de-de/search/tracks/foo').ok, false);
});

test('song.link/album.link platform prefixes resolve natively', () => {
  expectOk('https://song.link/s/0tgVpDi06FyKpA1z0VMD4v',
    { platform: 'spotify', kind: 'track', id: '0tgVpDi06FyKpA1z0VMD4v' });
  expectOk('https://song.link/i/1035048414',
    { platform: 'appleMusic', kind: 'track', id: '1035048414' });
  expectOk('https://song.link/y/dQw4w9WgXcQ', { platform: 'youtube', kind: 'track', id: 'dQw4w9WgXcQ' });
  expectOk('https://song.link/d/3135556', { platform: 'deezer', kind: 'track', id: '3135556' });
  expectOk('https://song.link/t/86024647', { platform: 'tidal', kind: 'track', id: '86024647' });
  expectOk('https://album.link/s/4m2880jivSbbyEGAKfITCa',
    { platform: 'spotify', kind: 'album', id: '4m2880jivSbbyEGAKfITCa' });
  // Custom odesli slugs can't be resolved — flagged as smart link.
  assert.equal(parseInput('https://song.link/some-custom-slug').reason, 'smartlink');
});

test('smart-link services are recognized and explained', () => {
  for (const url of [
    'https://taylor.lnk.to/SpeakNowTaylorsVersion',
    'https://lnk.to/xyz',
    'https://ffm.to/forevernowsf',
    'https://orcd.co/o7vrxkn',
    'https://bfan.link/a-digital-nowhere-deluxe',
    'https://distrokid.com/hyperfollow/kylegee/bLAm',
    'https://hypeddit.com/v7988l',
  ]) {
    const r = parseInput(url);
    assert.equal(r.ok, false, url);
    assert.equal(r.reason, 'smartlink', url);
    assert.match(r.note, /smart link/i);
  }
  // Dead services get a dead notice instead.
  assert.match(parseInput('https://smarturl.it/xyz').note, /dead|shut down/i);
  assert.match(parseInput('https://fanlink.to/revenge').note, /dead|shut down/i);
});

test('garbage input fails cleanly', () => {
  assert.equal(parseInput('').ok, false);
  assert.equal(parseInput('   ').ok, false);
  assert.equal(parseInput('hello world').ok, false);
  assert.equal(parseInput('https://example.com/track/123').ok, false);
  assert.equal(parseInput('https://open.spotify.com/track/tooshort').ok, false);
  assert.equal(parseInput('https://www.youtube.com/watch?v=bad').ok, false);
});

test('regression cases from real sessions parse as documented', () => {
  for (const c of REGRESSION_CASES) {
    if (c.text) {
      // Free-text cases never reach parseInput — they take the text path.
      assert.equal(looksLikeLink(c.input), false, c.input);
      assert.deepEqual(parseFreeText(c.input), c.text, c.input);
      continue;
    }
    const r = parseInput(c.input);
    if (c.parse) {
      assert.equal(r.ok, true, c.input);
      for (const [k, v] of Object.entries(c.parse)) {
        if (k === 'meta') {
          for (const [mk, mv] of Object.entries(v)) assert.equal(r.meta[mk], mv, `${c.input} meta.${mk}`);
        } else {
          assert.equal(r[k], v, `${c.input} → ${k}`);
        }
      }
    } else {
      assert.equal(r.ok, false, c.input);
      assert.equal(r.reason, c.fail.reason, c.input);
      assert.match(r.note, c.fail.note, c.input);
    }
  }
});

test('slugToWords', () => {
  assert.equal(slugToWords('harder-better-faster_stronger'), 'harder better faster stronger');
  assert.equal(slugToWords(''), '');
});
