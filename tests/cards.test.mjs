// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardModels, cardSignature } from '../js/cards.mjs';
import { regionFromLocale, PLATFORMS } from '../js/links.mjs';

const DE = regionFromLocale('de-DE');
const byKey = (models, key) => models.find((m) => m.key === key);

test('no query and no exact links → no cards', () => {
  const models = cardModels({ exact: {}, sourceKeys: [], kind: 'track' }, { artist: '', title: '' }, DE, false);
  assert.equal(models.length, 0);
});

test('query only → one search card per platform, no embeds/apps', () => {
  const models = cardModels({ exact: {}, sourceKeys: [], kind: 'track' }, { artist: 'Mine', title: 'Ohne dich' }, DE, false);
  assert.equal(models.length, PLATFORMS.length);
  for (const m of models) {
    assert.equal(m.badge, 'search', m.key);
    assert.equal(m.embed, null, m.key);
    assert.equal(m.app, null, m.key);
    assert.match(m.url, /^https:\/\//, m.key);
  }
});

test('source and match badges, embed and app link for exact spotify track', () => {
  const spotifyUrl = 'https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i';
  const deezerUrl = 'https://www.deezer.com/track/3135556';
  const models = cardModels(
    { exact: { spotify: spotifyUrl, deezer: deezerUrl }, sourceKeys: ['spotify'], kind: 'track' },
    { artist: 'Le Crime', title: 'Kitchen' }, DE, false
  );
  const sp = byKey(models, 'spotify');
  assert.equal(sp.badge, 'source');
  assert.equal(sp.url, spotifyUrl);
  assert.match(sp.embed.src, /open\.spotify\.com\/embed\/track\/0Jcij1eWd5bDMU5iPbxe2i/);
  assert.equal(sp.app.href, 'spotify:track:0Jcij1eWd5bDMU5iPbxe2i');
  const dz = byKey(models, 'deezer');
  assert.equal(dz.badge, 'match');
  assert.equal(dz.url, deezerUrl);
  assert.match(dz.embed.src, /widget\.deezer\.com/);
  // Platforms without an exact link fall back to search
  assert.equal(byKey(models, 'tidal').badge, 'search');
});

test('exact links render cards even without any query', () => {
  const models = cardModels(
    { exact: { spotify: 'https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i' }, sourceKeys: ['spotify'], kind: 'track' },
    { artist: '', title: '' }, DE, false
  );
  assert.equal(models.length, 1);
  assert.equal(models[0].key, 'spotify');
});

test('a known ISRC upgrades the spotify and youtube-music searches only', () => {
  const models = cardModels(
    { exact: {}, sourceKeys: [], kind: 'track', isrc: 'DE1TX2600017' },
    { artist: 'Mine', title: 'Ohne dich' }, DE, false
  );
  const sp = byKey(models, 'spotify');
  assert.match(sp.url, /isrc%3ADE1TX2600017/);
  assert.equal(sp.viaCode, true);
  assert.equal(sp.codeKind, 'isrc');
  assert.equal(sp.badge, 'search');
  const ytm = byKey(models, 'youtubeMusic');
  assert.equal(ytm.url, 'https://music.youtube.com/search?q=DE1TX2600017');
  assert.equal(ytm.viaCode, true);
  assert.equal(models.filter((m) => m.viaCode).length, 2);
  assert.equal(byKey(models, 'deezer').viaCode, false);
  assert.doesNotMatch(byKey(models, 'deezer').url, /isrc/i);
  assert.doesNotMatch(byKey(models, 'youtube').url, /DE1TX2600017/);
  // An exact spotify link (MusicBrainz hit) still wins over the isrc search.
  const withExact = cardModels(
    { exact: { spotify: 'https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i' }, sourceKeys: [], kind: 'track', isrc: 'DE1TX2600017' },
    { artist: 'Mine', title: 'Ohne dich' }, DE, false
  );
  assert.equal(byKey(withExact, 'spotify').badge, 'match');
  assert.equal(byKey(withExact, 'spotify').viaCode, false);
});

test('a known UPC upgrades only the youtube-music album search', () => {
  const models = cardModels(
    { exact: {}, sourceKeys: [], kind: 'album', upc: '724384960650' },
    { artist: 'Daft Punk', title: 'Discovery' }, DE, false
  );
  const ytm = byKey(models, 'youtubeMusic');
  assert.equal(ytm.url, 'https://music.youtube.com/search?q=724384960650');
  assert.equal(ytm.viaCode, true);
  assert.equal(ytm.codeKind, 'upc');
  // Spotify must NOT carry the UPC (measured-dead search filter).
  assert.doesNotMatch(byKey(models, 'spotify').url, /724384960650/);
  assert.equal(models.filter((m) => m.viaCode).length, 1);
  // A UPC on a track (impossible via the app, but defensive) does nothing.
  const asTrack = cardModels(
    { exact: {}, sourceKeys: [], kind: 'track', upc: '724384960650' },
    { artist: 'Daft Punk', title: 'Discovery' }, DE, false
  );
  assert.equal(asTrack.filter((m) => m.viaCode).length, 0);
  // An ISRC on an album kind never fires either.
  const albumIsrc = cardModels(
    { exact: {}, sourceKeys: [], kind: 'album', isrc: 'DE1TX2600017' },
    { artist: 'Mine', title: 'Baum' }, DE, false
  );
  assert.equal(albumIsrc.filter((m) => m.viaCode).length, 0);
});

test('an exact album link from the UPC cascade gets embed and app link', () => {
  const models = cardModels(
    { exact: { spotify: 'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc' }, sourceKeys: [], kind: 'album', upc: '724384960650' },
    { artist: 'Daft Punk', title: 'Discovery' }, DE, false
  );
  const sp = byKey(models, 'spotify');
  assert.equal(sp.badge, 'match');
  assert.equal(sp.viaCode, false);
  assert.match(sp.embed.src, /open\.spotify\.com\/embed\/album\/2noRn2Aes5aoNVsU6iWThc/);
  assert.equal(sp.app.href, 'spotify:album:2noRn2Aes5aoNVsU6iWThc');
});

test('models follow PLATFORMS order', () => {
  const models = cardModels(
    { exact: { qobuz: 'https://open.qobuz.com/track/17985121' }, sourceKeys: ['qobuz'], kind: 'track' },
    { artist: 'a', title: 'b' }, DE, false
  );
  assert.deepEqual(models.map((m) => m.key), PLATFORMS.map((p) => p.key));
});

test('cardSignature changes when url, badge or embed theme changes', () => {
  const st = { exact: { spotify: 'https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i' }, sourceKeys: ['spotify'], kind: 'track' };
  const fields = { artist: 'Le Crime', title: 'Kitchen' };
  const light = byKey(cardModels(st, fields, DE, false), 'spotify');
  const dark = byKey(cardModels(st, fields, DE, true), 'spotify');
  assert.equal(cardSignature(light), cardSignature(light));
  assert.notEqual(cardSignature(light), cardSignature(dark)); // theme param in embed src
  const asMatch = byKey(cardModels({ ...st, sourceKeys: [] }, fields, DE, false), 'spotify');
  assert.notEqual(cardSignature(light), cardSignature(asMatch)); // badge differs
  // Search cards for different queries differ too
  const s1 = byKey(cardModels({ exact: {}, sourceKeys: [], kind: 'track' }, { artist: 'a', title: 'x' }, DE, false), 'tidal');
  const s2 = byKey(cardModels({ exact: {}, sourceKeys: [], kind: 'track' }, { artist: 'a', title: 'y' }, DE, false), 'tidal');
  assert.notEqual(cardSignature(s1), cardSignature(s2));
  // codeKind is part of the signature (the tooltip is rendered from it).
  const plain = byKey(cardModels({ exact: {}, sourceKeys: [], kind: 'album' }, { artist: 'Daft Punk', title: 'Discovery' }, DE, false), 'youtubeMusic');
  const viaUpc = byKey(cardModels({ exact: {}, sourceKeys: [], kind: 'album', upc: '724384960650' }, { artist: 'Daft Punk', title: 'Discovery' }, DE, false), 'youtubeMusic');
  assert.notEqual(cardSignature(plain), cardSignature(viaUpc));
});
