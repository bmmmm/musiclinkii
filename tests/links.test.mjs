// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORMS, regionFromLocale, buildQuery, sourceCardKeys, shareHashFor, linkFromHash } from '../js/links.mjs';

const DE = regionFromLocale('de-DE');
const US = regionFromLocale('en-US');

function searchUrl(key, q, region = DE, parts) {
  return PLATFORMS.find((p) => p.key === key).searchUrl(q, region, parts);
}

test('search URL templates match the live-verified formats', () => {
  const q = 'daft punk one more time';
  assert.equal(searchUrl('spotify', q), 'https://open.spotify.com/search/daft%20punk%20one%20more%20time');
  assert.equal(searchUrl('appleMusic', q), 'https://music.apple.com/de/search?term=daft%20punk%20one%20more%20time');
  assert.equal(searchUrl('youtube', q), 'https://www.youtube.com/results?search_query=daft%20punk%20one%20more%20time');
  assert.equal(searchUrl('youtubeMusic', q), 'https://music.youtube.com/search?q=daft%20punk%20one%20more%20time');
  assert.equal(searchUrl('deezer', q), 'https://www.deezer.com/search/daft%20punk%20one%20more%20time');
  assert.equal(searchUrl('tidal', q), 'https://tidal.com/search/tracks?q=daft%20punk%20one%20more%20time');
  assert.equal(searchUrl('amazonMusic', q), 'https://music.amazon.de/search/daft%20punk%20one%20more%20time');
  assert.equal(searchUrl('soundcloud', q), 'https://soundcloud.com/search/sounds?q=daft%20punk%20one%20more%20time');
  assert.equal(searchUrl('bandcamp', q), 'https://bandcamp.com/search?q=daft%20punk%20one%20more%20time&item_type=t');
  // open.qobuz.com ignores ?q= — must be the typed path route on www.
  assert.equal(searchUrl('qobuz', q), 'https://www.qobuz.com/de-de/search/tracks/daft%20punk%20one%20more%20time');
});

test('youtube music search uses the plain ISRC as query when known', () => {
  const p = PLATFORMS.find((x) => x.key === 'youtubeMusic');
  assert.equal(
    p.searchUrl('Dilated Peoples Clockwork', DE, { artist: 'Dilated Peoples', title: 'Clockwork', kind: 'track', isrc: 'USCA20101085' }),
    'https://music.youtube.com/search?q=USCA20101085'
  );
  assert.equal(
    p.searchUrl('Dilated Peoples Clockwork', DE, { artist: 'Dilated Peoples', title: 'Clockwork', kind: 'track' }),
    'https://music.youtube.com/search?q=Dilated%20Peoples%20Clockwork'
  );
  // plain youtube stays a free-text search even with an ISRC (the Topic
  // track ranks first there but the music video gets buried)
  const yt = PLATFORMS.find((x) => x.key === 'youtube');
  assert.equal(
    yt.searchUrl('Dilated Peoples Clockwork', DE, { artist: 'Dilated Peoples', title: 'Clockwork', kind: 'track', isrc: 'USCA20101085' }),
    'https://www.youtube.com/results?search_query=Dilated%20Peoples%20Clockwork'
  );
});

test('youtube music search uses the plain UPC as query for albums', () => {
  const p = PLATFORMS.find((x) => x.key === 'youtubeMusic');
  const album = { artist: 'Daft Punk', title: 'Discovery', kind: 'album', upc: '724384960650' };
  assert.equal(p.searchUrl('Daft Punk Discovery', DE, album), 'https://music.youtube.com/search?q=724384960650');
  // UPCs identify albums — a track never searches by UPC.
  assert.equal(
    p.searchUrl('Daft Punk Discovery', DE, { ...album, kind: 'track' }),
    'https://music.youtube.com/search?q=Daft%20Punk%20Discovery'
  );
  // On a track with both codes the ISRC wins.
  assert.equal(
    p.searchUrl('x', DE, { kind: 'track', isrc: 'USCA20101085', upc: '724384960650' }),
    'https://music.youtube.com/search?q=USCA20101085'
  );
});

test('spotify album search never uses the UPC (measured-dead endpoint)', () => {
  const p = PLATFORMS.find((x) => x.key === 'spotify');
  const album = { artist: 'Daft Punk', title: 'Discovery', kind: 'album', upc: '724384960650' };
  const url = p.searchUrl('Daft Punk Discovery', DE, album);
  // Regression guard: the upc: filter returns zero results logged-out
  // (2026-08-20) — albums must stay on the field filters.
  assert.equal(url, `https://open.spotify.com/search/${encodeURIComponent('artist:"Daft Punk" album:"Discovery"')}`);
  assert.ok(!url.includes('724384960650'));
});

test('spotify search prefers the ISRC filter when an ISRC is known', () => {
  const p = PLATFORMS.find((x) => x.key === 'spotify');
  assert.equal(
    p.searchUrl('Mine Ohne dich', DE, { artist: 'Mine', title: 'Ohne dich', kind: 'track', isrc: 'DE1TX2600017' }),
    'https://open.spotify.com/search/isrc%3ADE1TX2600017'
  );
  // ISRCs identify recordings, not albums/artists — those kinds ignore it.
  assert.equal(
    p.searchUrl('x', DE, { artist: 'Mine', title: 'Baum', kind: 'album', isrc: 'DE1TX2600017' }),
    `https://open.spotify.com/search/${encodeURIComponent('artist:"Mine" album:"Baum"')}`
  );
});

test('spotify search uses field filters when artist and title are known', () => {
  const p = PLATFORMS.find((x) => x.key === 'spotify');
  // Multi-word artists must be quoted or only the first word binds to
  // the filter (reported with "Dilated Peoples").
  assert.equal(
    p.searchUrl('Mine Ohne dich', DE, { artist: 'Mine', title: 'Ohne dich' }),
    'https://open.spotify.com/search/artist%3A%22Mine%22%20track%3A%22Ohne%20dich%22'
  );
  assert.equal(
    p.searchUrl('x', DE, { artist: 'Dilated Peoples', title: 'Worst Comes To Worst' }),
    'https://open.spotify.com/search/artist%3A%22Dilated%20Peoples%22%20track%3A%22Worst%20Comes%20To%20Worst%22'
  );
  // Quotes inside the title must not break the quoted filter.
  assert.ok(!p.searchUrl('q', DE, { artist: 'a-ha', title: 'Take On Me (12" Mix)' }).includes('%22%20Mix'));
  // Title-only stays a plain free-text search.
  assert.equal(
    p.searchUrl('Ohne dich', DE, { artist: '', title: 'Ohne dich' }),
    'https://open.spotify.com/search/Ohne%20dich'
  );
  assert.equal(p.searchUrl('plain', DE), 'https://open.spotify.com/search/plain');
});

test('special characters are URL-encoded', () => {
  assert.equal(searchUrl('spotify', 'AC/DC T.N.T.'), 'https://open.spotify.com/search/AC%2FDC%20T.N.T.');
  assert.ok(searchUrl('tidal', 'Sigur Rós ágætis').includes('Sigur%20R%C3%B3s'));
});

test('structured search follows the entity kind where supported', () => {
  const album = { artist: 'Daft Punk', title: 'Discovery', kind: 'album' };
  const artistOnly = { artist: 'Daft Punk', title: '', kind: 'artist' };
  assert.equal(
    searchUrl('spotify', 'Daft Punk Discovery', DE, album),
    'https://open.spotify.com/search/artist%3A%22Daft%20Punk%22%20album%3A%22Discovery%22'
  );
  assert.equal(
    searchUrl('spotify', 'Daft Punk', DE, artistOnly),
    'https://open.spotify.com/search/artist%3A%22Daft%20Punk%22'
  );
  assert.equal(
    searchUrl('deezer', 'Mine Ohne dich', DE, { artist: 'Mine', title: 'Ohne dich', kind: 'track' }),
    'https://www.deezer.com/search/artist%3A%22Mine%22%20track%3A%22Ohne%20dich%22'
  );
  assert.equal(
    searchUrl('deezer', 'Daft Punk Discovery', DE, album),
    'https://www.deezer.com/search/artist%3A%22Daft%20Punk%22%20album%3A%22Discovery%22'
  );
  assert.equal(searchUrl('tidal', 'x', DE, album), 'https://tidal.com/search/albums?q=x');
  assert.equal(searchUrl('tidal', 'x', DE, artistOnly), 'https://tidal.com/search/artists?q=x');
  assert.equal(searchUrl('soundcloud', 'x', DE, album), 'https://soundcloud.com/search/albums?q=x');
  assert.equal(searchUrl('soundcloud', 'x', DE, artistOnly), 'https://soundcloud.com/search/people?q=x');
  assert.equal(searchUrl('bandcamp', 'x', DE, album), 'https://bandcamp.com/search?q=x&item_type=a');
  assert.equal(searchUrl('bandcamp', 'x', DE, artistOnly), 'https://bandcamp.com/search?q=x&item_type=b');
  assert.equal(searchUrl('qobuz', 'x', DE, album), 'https://www.qobuz.com/de-de/search/albums/x');
  assert.equal(searchUrl('qobuz', 'x', DE, artistOnly), 'https://www.qobuz.com/de-de/search/artists/x');
  // Unknown kinds fall back to the track route, not a broken URL.
  assert.equal(searchUrl('tidal', 'x', DE, { kind: 'playlist' }), 'https://tidal.com/search/tracks?q=x');
});

test('regionFromLocale storefront mapping', () => {
  assert.deepEqual(DE, { country: 'de', appleStorefront: 'de', amazonTld: 'de', qobuzStorefront: 'de-de' });
  assert.deepEqual(US, { country: 'us', appleStorefront: 'us', amazonTld: 'com', qobuzStorefront: 'us-en' });
  assert.equal(regionFromLocale('en-GB').amazonTld, 'co.uk');
  assert.equal(regionFromLocale('fr').country, 'fr');
  // Unknown locales fall back to a working US storefront.
  assert.equal(regionFromLocale('xx-YY').amazonTld, 'com');
  assert.equal(regionFromLocale('').qobuzStorefront, 'us-en');
});

test('share hash round-trips the pasted link', () => {
  const link = 'https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i?si=x';
  assert.deepEqual(linkFromHash(shareHashFor(link)), { link, kind: '' });
  assert.equal(shareHashFor('  '), '');
  assert.equal(linkFromHash(''), null);
  assert.equal(linkFromHash('#other=1'), null);
  assert.equal(linkFromHash('#l=%E2'), null);
});

test('share hash carries a non-track search kind', () => {
  // Track is the default — it must not clutter the hash.
  assert.equal(shareHashFor('Daft Punk - Discovery', 'track'), '#l=Daft%20Punk%20-%20Discovery');
  const hash = shareHashFor('Daft Punk - Discovery', 'album');
  assert.equal(hash, '#l=Daft%20Punk%20-%20Discovery&k=album');
  assert.deepEqual(linkFromHash(hash), { link: 'Daft Punk - Discovery', kind: 'album' });
  // Free text containing a literal & is percent-encoded, so the &k=
  // separator stays unambiguous.
  const amp = shareHashFor('Simon & Garfunkel - America', 'album');
  assert.deepEqual(linkFromHash(amp), { link: 'Simon & Garfunkel - America', kind: 'album' });
});

test('buildQuery joins and trims', () => {
  assert.equal(buildQuery('Daft Punk', 'One More Time'), 'Daft Punk One More Time');
  assert.equal(buildQuery('', 'One More Time'), 'One More Time');
  assert.equal(buildQuery('  ', ''), '');
});

test('sourceCardKeys marks both YouTube cards for music.youtube links', () => {
  assert.deepEqual(sourceCardKeys({ platform: 'youtube', meta: { music: true } }), ['youtube', 'youtubeMusic']);
  assert.deepEqual(sourceCardKeys({ platform: 'youtube', meta: { music: false } }), ['youtube']);
  assert.deepEqual(sourceCardKeys({ platform: 'deezer', meta: {} }), ['deezer']);
});

// cleanTitle/looselyMatches/searchableTitle/splitDashTitle/artistCandidates
// tests moved to tests/adapters.test.mjs — this file is about URL builders.
