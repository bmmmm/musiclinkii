// SPDX-License-Identifier: GPL-3.0-or-later
// Pure adapter logic: candidate normalization, match selection, artist
// chips, free-text splitting. Network functions stay untested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTitle, splitDashTitle, looselyMatches, searchableTitle, parseFreeText,
  deezerCandidates, itunesCandidates, pickByArtist, strictTitleHits, artistCandidates,
  pickByName, pickMbArtist, mapUrlsToPlatforms,
} from '../js/adapters.mjs';

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

test('parseFreeText splits typed text into artist/title', () => {
  assert.deepEqual(parseFreeText('Will Smith - Miami'), { artist: 'Will Smith', title: 'Miami' });
  assert.deepEqual(parseFreeText('A – B'), { artist: 'A', title: 'B' });
  // Only the FIRST dash splits — the rest stays in the title.
  assert.deepEqual(parseFreeText('A - B - Live'), { artist: 'A', title: 'B - Live' });
  // No dash → everything is the title, artist stays editable.
  assert.deepEqual(parseFreeText('Miami'), { artist: '', title: 'Miami' });
  // Video noise is stripped before splitting.
  assert.deepEqual(parseFreeText('Will Smith - Miami (Official Video)'), { artist: 'Will Smith', title: 'Miami' });
  assert.equal(parseFreeText('   '), null);
  assert.equal(parseFreeText(''), null);
});

test('parseFreeText artist kind never dash-splits', () => {
  // Artist names are one field — a dash split would drop half the name.
  assert.deepEqual(parseFreeText('Simon & Garfunkel', 'artist'), { artist: 'Simon & Garfunkel', title: '' });
  assert.deepEqual(parseFreeText('A - B', 'artist'), { artist: 'A - B', title: '' });
  assert.equal(parseFreeText('  ', 'artist'), null);
  // The default kind keeps the historic split behavior.
  assert.deepEqual(parseFreeText('A - B'), { artist: 'A', title: 'B' });
});

test('deezerCandidates normalizes tracks and albums, tolerates errors', () => {
  // Track rows carry the cover on the nested album object.
  const track = { data: [{ id: 1038058, title: 'Miami', artist: { name: 'Will Smith' }, link: 'https://www.deezer.com/track/1038058', album: { cover_medium: 'https://cdn.dzcdn.net/miami.jpg' } }] };
  assert.deepEqual(deezerCandidates(track, 'track'), [
    { title: 'Miami', artist: 'Will Smith', link: 'https://www.deezer.com/track/1038058', id: '1038058', thumb: 'https://cdn.dzcdn.net/miami.jpg' },
  ]);
  // Album search rows may lack `link` — it is rebuilt from the id — and
  // carry the cover inline.
  const album = { data: [{ id: 302127, title: 'Discovery', artist: { name: 'Daft Punk' }, cover_medium: 'https://cdn.dzcdn.net/discovery.jpg' }] };
  assert.deepEqual(deezerCandidates(album, 'album'), [
    { title: 'Discovery', artist: 'Daft Punk', link: 'https://www.deezer.com/album/302127', id: '302127', thumb: 'https://cdn.dzcdn.net/discovery.jpg' },
  ]);
  assert.deepEqual(deezerCandidates({ error: { code: 4 } }, 'track'), []);
  assert.deepEqual(deezerCandidates(null, 'track'), []);
});

test('deezerCandidates normalizes artist rows', () => {
  // Artist rows carry name/picture_medium, no title; link rebuilt from id.
  const artists = { data: [
    { id: 27, name: 'Daft Punk', link: 'https://www.deezer.com/artist/27', picture_medium: 'https://cdn.dzcdn.net/dp.jpg' },
    { id: 28, name: 'Daft Funk Tribute' },
    { name: 'No Id No Link' },
  ] };
  assert.deepEqual(deezerCandidates(artists, 'artist'), [
    { title: '', artist: 'Daft Punk', link: 'https://www.deezer.com/artist/27', id: '27', thumb: 'https://cdn.dzcdn.net/dp.jpg' },
    { title: '', artist: 'Daft Funk Tribute', link: 'https://www.deezer.com/artist/28', id: '28', thumb: '' },
  ]);
  // Track/album behavior is untouched by the artist lens.
  assert.deepEqual(deezerCandidates(artists, 'track'), []);
});

test('itunesCandidates normalizes musicArtist rows', () => {
  const artists = { results: [
    { artistId: 5468295, artistName: 'Daft Punk', artistLinkUrl: 'https://music.apple.com/de/artist/daft-punk/5468295' },
    { trackId: 5, trackName: 'Miami', artistName: 'Will Smith', trackViewUrl: 'https://x' }, // song row → no artistLinkUrl
  ] };
  assert.deepEqual(itunesCandidates(artists, 'artist'), [
    { title: '', artist: 'Daft Punk', link: 'https://music.apple.com/de/artist/daft-punk/5468295', id: '5468295', thumb: '' },
  ]);
});

test('pickByName follows catalog rank with a loose match', () => {
  const cands = [
    { title: '', artist: 'Daft Funk Tribute', link: 'a', id: '1' },
    { title: '', artist: 'Daft Punk', link: 'b', id: '2' },
  ];
  // The token-subset match skips the tribute act (no "punk" token) and
  // takes the first real hit in catalog rank order.
  assert.equal(pickByName(cands, 'Daft Punk')?.id, '2');
  assert.equal(pickByName(cands, 'daft punk')?.id, '2');
  assert.equal(pickByName(cands, 'Nobody Known'), null);
  assert.equal(pickByName([], 'Daft Punk'), null);
});

test('pickMbArtist handles url-rels and name-search shapes', () => {
  const rels = { relations: [{ type: 'free streaming' }, { artist: { id: 'mbid-1', name: 'Daft Punk' } }] };
  assert.deepEqual(pickMbArtist(rels, 'Daft Punk'), { id: 'mbid-1', name: 'Daft Punk' });
  const search = { artists: [
    { id: 'mbid-2', name: 'Daft Punk', score: 100 },
    { id: 'mbid-3', name: 'Daft Punk Cover Band', score: 100 },
  ] };
  assert.deepEqual(pickMbArtist(search, 'Daft Punk'), { id: 'mbid-2', name: 'Daft Punk' });
  // Low score or a name mismatch never picks — fuzzier is worse than nothing.
  assert.equal(pickMbArtist({ artists: [{ id: 'x', name: 'Daft Punk', score: 62 }] }, 'Daft Punk'), null);
  assert.equal(pickMbArtist({ artists: [{ id: 'x', name: 'Punk Floyd', score: 100 }] }, 'Daft Punk'), null);
  assert.equal(pickMbArtist({}, 'Daft Punk'), null);
});

test('mapUrlsToPlatforms kind filter is opt-in', () => {
  const urls = [
    'https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi',
    'https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i',
    'https://www.deezer.com/artist/27',
  ];
  // With the artist lens the stray track rel is dropped.
  assert.deepEqual(Object.keys(mapUrlsToPlatforms(urls, 'artist')).sort(), ['deezer', 'spotify']);
  assert.match(mapUrlsToPlatforms(urls, 'artist').spotify, /artist/);
  // Without an arg the behavior is unchanged — first hit per platform wins
  // (regression guard for the ISRC/UPC callers).
  assert.match(mapUrlsToPlatforms(urls).spotify, /artist\/4tZwfgrHOc3mvqYlEYSvVi/);
  assert.deepEqual(mapUrlsToPlatforms([], 'artist'), {});
});

test('itunesCandidates normalizes songs and albums, tolerates errors', () => {
  const song = { results: [{ trackId: 5, trackName: 'Miami', artistName: 'Will Smith', trackViewUrl: 'https://music.apple.com/de/album/miami/1?i=5', artworkUrl100: 'https://is1.mzstatic.com/miami.jpg' }] };
  assert.deepEqual(itunesCandidates(song, 'track'), [
    { title: 'Miami', artist: 'Will Smith', link: 'https://music.apple.com/de/album/miami/1?i=5', id: '5', thumb: 'https://is1.mzstatic.com/miami.jpg' },
  ]);
  const album = { results: [{ collectionId: 697194953, collectionName: 'Discovery', artistName: 'Daft Punk', collectionViewUrl: 'https://music.apple.com/de/album/discovery/697194953' }] };
  assert.deepEqual(itunesCandidates(album, 'album'), [
    { title: 'Discovery', artist: 'Daft Punk', link: 'https://music.apple.com/de/album/discovery/697194953', id: '697194953', thumb: '' },
  ]);
  // A song row fed through the album lens has no collection fields → dropped.
  assert.deepEqual(itunesCandidates(song, 'album'), []);
  assert.deepEqual(itunesCandidates(undefined, 'track'), []);
});

test('pickByArtist: the known artist beats a foreign top hit', () => {
  // The reported bug: pasted Spotify ALBUM "Discovery" (Daft Punk) ran
  // through the track path and auto-picked Tony Ann's track instead.
  const cands = [
    { title: 'Discovery', artist: 'Tony Ann', link: 'https://www.deezer.com/track/2576777332', id: '2576777332' },
    { title: 'Discovery', artist: 'Daft Punk', link: 'https://www.deezer.com/album/302127', id: '302127' },
  ];
  assert.equal(pickByArtist(cands, 'Daft Punk', 'Discovery')?.id, '302127');
  // Title variants ("Deluxe Edition") still match via the loose title check.
  const deluxe = [{ title: 'Discovery (Deluxe Edition)', artist: 'Daft Punk', link: 'x', id: '1' }];
  assert.equal(pickByArtist(deluxe, 'Daft Punk', 'Discovery')?.id, '1');
  assert.equal(pickByArtist(cands, 'Nobody Known', 'Discovery'), null);
  assert.equal(pickByArtist([], 'Daft Punk', 'Discovery'), null);
});

test('strictTitleHits keeps rank order and drops near-titles', () => {
  const cands = [
    { title: 'Miami (feat. X)', artist: 'Odeal', link: 'a', id: '1' },
    { title: 'MIAMI', artist: 'Tokischa', link: 'b', id: '2' },
    { title: 'Miami', artist: 'Will Smith', link: 'c', id: '3' },
  ];
  // Bracketed suffixes are noise-stripped by searchableTitle, so the Odeal
  // entry counts as strict too — but never jumps ahead of its rank.
  assert.deepEqual(strictTitleHits(cands, 'Miami').map((c) => c.id), ['1', '2', '3']);
  assert.deepEqual(strictTitleHits([{ title: 'Miami Nights', artist: 'Y', link: 'd', id: '4' }], 'Miami'), []);
});

test('artistCandidates: confirmed names first, Deezer-only fallback', () => {
  // The real "Cooked" shape (2026-08-20), in the normalized form.
  const dCands = [
    { title: 'COOOK PARDON', artist: 'Lvbel C5', link: 'l1', id: '1' },
    { title: 'COOKED', artist: 'The Skinner Brothers', link: 'l2', id: '2' },
    { title: 'cooked', artist: 'ase paperchase', link: 'l3', id: '3' },
    { title: 'Cooked', artist: 'Amélie', link: 'l4', id: '4' },
    { title: 'Cooked', artist: 'Samurai Breaks', link: 'l5', id: '5' },
    { title: 'Cooked', artist: 'Amélie', link: 'l6', id: '6' }, // duplicate artist
  ];
  const iCands = [
    { title: 'Cooked', artist: 'amelie', link: 'i1', id: 'a' },
    { title: 'Good Thing', artist: 'Fine Young Cannibals', link: 'i2', id: 'b' },
    { title: 'Cooked', artist: 'Samurai Breaks', link: 'i3', id: 'c' },
    { title: 'Overcooked', artist: 'The Skinner Brothers', link: 'i4', id: 'd' }, // different title → no confirm
  ];
  // Both-catalog names lead, Deezer-only names pad up to the cap.
  assert.deepEqual(
    artistCandidates(dCands, iCands, 'Cooked'),
    ['Amélie', 'Samurai Breaks', 'The Skinner Brothers', 'ase paperchase']
  );
  // iTunes down (null) ≠ iTunes empty ([]) — both still yield chips, because
  // a chip is a user choice, not an auto-pick. This is the "Miami" fix.
  assert.deepEqual(
    artistCandidates(dCands, null, 'Cooked'),
    ['The Skinner Brothers', 'ase paperchase', 'Amélie', 'Samurai Breaks']
  );
  assert.deepEqual(
    artistCandidates(dCands, [], 'Cooked'),
    ['The Skinner Brothers', 'ase paperchase', 'Amélie', 'Samurai Breaks']
  );
  assert.deepEqual(artistCandidates([], iCands, 'Cooked'), []);
  // The cap holds.
  assert.equal(artistCandidates(dCands, iCands, 'Cooked', 2).length, 2);
});
