// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORMS, regionFromLocale, buildQuery, sourceCardKeys, shareHashFor, linkFromHash } from '../js/links.mjs';
import { cleanTitle, splitDashTitle, looselyMatches, searchableTitle } from '../js/adapters.mjs';

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
  assert.equal(linkFromHash(shareHashFor(link)), link);
  assert.equal(shareHashFor('  '), '');
  assert.equal(linkFromHash(''), null);
  assert.equal(linkFromHash('#other=1'), null);
  assert.equal(linkFromHash('#l=%E2'), null);
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

test('cleanTitle strips video noise', () => {
  assert.equal(cleanTitle('Blinding Lights (Official Video)'), 'Blinding Lights');
  assert.equal(cleanTitle('Song [Official Lyric Video] (4K)'), 'Song');
  assert.equal(cleanTitle('Plain Title'), 'Plain Title');
  assert.equal(cleanTitle('Keep (Not Noise) Brackets'), 'Keep (Not Noise) Brackets');
});

test('looselyMatches is token-based, not substring-based', () => {
  assert.equal(looselyMatches('Kitchen', 'Kitchenware & Candybars'), false);
  assert.equal(looselyMatches('Take On Me', 'Take On Me (1985 12" Mix) [2015 Remastered]'), true);
  assert.equal(looselyMatches('The Weeknd', 'Weeknd'), true);
  assert.equal(looselyMatches('a-ha', 'a‐ha'), true);
  assert.equal(looselyMatches('Sigur Rós', 'sigur ros'), true);
  assert.equal(looselyMatches('', 'anything'), false);
});

test('searchableTitle strips bracketed noise and quotes', () => {
  assert.equal(searchableTitle('Take On Me (1985 12" Mix) [2015 Remastered]'), 'Take On Me');
  assert.equal(searchableTitle('Plain Song'), 'Plain Song');
  // A fully bracketed title must not collapse to nothing.
  assert.equal(searchableTitle('(Untitled)'), '(Untitled)');
});

test('splitDashTitle splits artist from title', () => {
  assert.deepEqual(splitDashTitle('The Weeknd - Blinding Lights'), { artist: 'The Weeknd', title: 'Blinding Lights' });
  assert.deepEqual(splitDashTitle('A – B'), { artist: 'A', title: 'B' });
  assert.equal(splitDashTitle('No separator here'), null);
  assert.equal(splitDashTitle('Hyphen-ated word'), null);
});
