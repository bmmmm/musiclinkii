// SPDX-License-Identifier: GPL-3.0-or-later
// Pure adapter logic: candidate normalization, match selection, artist
// chips, free-text splitting. Network functions stay untested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTitle, splitDashTitle, looselyMatches, searchableTitle, parseFreeText, stripReleaseKind,
  deezerCandidates, itunesCandidates, pickByArtist, strictTitleHits, artistCandidates,
  pickByName, pickMbArtist, mapUrlsToPlatforms, expandArtistAnchor, relsConfirmAnchor,
  titlesOverlap, confirmByCatalog, probeNamesakes, namesakeChipLabel, unmetNeed, isThrottled,
  primaryArtist, deezerQueries,
} from '../js/adapters.mjs';

// Decides whether the user gets a rate-limit line. A 404 is the normal
// answer for a release MusicBrainz has never seen and must stay silent.
test('isThrottled separates a MusicBrainz 503 from an ordinary miss', () => {
  assert.equal(isThrottled(new Error('HTTP 503')), true);
  assert.equal(isThrottled(new Error('HTTP 404')), false);
  assert.equal(isThrottled(new Error('The operation was aborted')), false);
  assert.equal(isThrottled(undefined), false);
});

// The album path's biggest single loss: measured 2026-08-22, the Apple
// "- Single" suffix made the Deezer album search return zero candidates
// for 8 of 8 sampled singles, which costs the UPC and with it every
// MusicBrainz-only link — Spotify above all.
test('stripReleaseKind removes the Apple single/EP suffix', () => {
  assert.equal(stripReleaseKind('Blinding Lights - Single'), 'Blinding Lights');
  assert.equal(stripReleaseKind('Bunny Is A Rider - Single'), 'Bunny Is A Rider');
  assert.equal(stripReleaseKind('Rammstein - EP'), 'Rammstein');
  assert.equal(stripReleaseKind('Moth To A Flame – Single'), 'Moth To A Flame'); // en dash
  assert.equal(stripReleaseKind('single ladies - single'), 'single ladies'); // case-insensitive
});

test('stripReleaseKind leaves real titles alone', () => {
  // Only a trailing " - Single"/" - EP" goes; the words are common enough
  // inside titles that anything else must survive untouched.
  assert.equal(stripReleaseKind('Single Ladies'), 'Single Ladies');
  assert.equal(stripReleaseKind('EP Blues'), 'EP Blues');
  assert.equal(stripReleaseKind('Every Single Day'), 'Every Single Day');
  assert.equal(stripReleaseKind('Discovery'), 'Discovery');
  assert.equal(stripReleaseKind('- Single'), '- Single'); // nothing left over → keep as-is
  assert.equal(stripReleaseKind(''), '');
  assert.equal(stripReleaseKind(undefined), '');
});

// The suffixed title used to come back through the iTunes album candidates
// as canonicalTitle, land in the title field, and make the next Deezer
// round miss again — the loop this strip closes.
test('itunesCandidates strips the suffix from album rows', () => {
  const cands = itunesCandidates({
    results: [{ collectionName: 'Blinding Lights - Single', artistName: 'The Weeknd', collectionViewUrl: 'https://music.apple.com/us/album/1', collectionId: 1 }],
  }, 'album');
  assert.equal(cands[0].title, 'Blinding Lights');
});

test('itunesCandidates leaves track rows untouched', () => {
  // Track names never carry the suffix — only the collection does.
  const cands = itunesCandidates({
    results: [{ trackName: 'Blinding Lights', artistName: 'The Weeknd', trackViewUrl: 'https://music.apple.com/us/album/1?i=2', trackId: 2 }],
  }, 'track');
  assert.equal(cands[0].title, 'Blinding Lights');
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

// Apple localises "Various Artists" into the storefront language and genders
// it; Deezer carries the generic form. Live pair: Apple "Verschiedene
// Interpret:innen" vs Deezer "Verschiedene Interpreten".
test('looselyMatches folds German gendered forms onto the generic one', () => {
  for (const gendered of [
    'Verschiedene Interpret:innen',
    'Verschiedene Interpret*innen',
    'Verschiedene Interpret_innen',
    'Verschiedene InterpretInnen',
  ]) assert.equal(looselyMatches(gendered, 'Verschiedene Interpreten'), true, gendered);
  // A stem already ending in -er is its own plural — no "Kuenstleren".
  assert.equal(looselyMatches('K\u00fcnstler:innen', 'K\u00fcnstler'), true);
  assert.equal(looselyMatches('S\u00e4nger*in', 'S\u00e4nger'), true);
  // The fold must not buy laxness anywhere else: the separatorless spelling
  // is honoured for the plural only, so a capital-I word survives it.
  assert.equal(looselyMatches('LinkedIn', 'Linkeden'), false);
  assert.equal(looselyMatches('Kitchen', 'Kitchenware & Candybars'), false);
  assert.equal(looselyMatches('Interpreten', 'Interpretation'), false);
});

test('primaryArtist keeps the lead of a featuring credit', () => {
  assert.equal(primaryArtist('Fred again.., Danny Brown, BEAM, PARISI & JPEGMAFIA'), 'Fred again..');
  assert.equal(primaryArtist('Calvin Harris feat. Dua Lipa'), 'Calvin Harris');
  assert.equal(primaryArtist('Drake ft Rihanna'), 'Drake');
  assert.equal(primaryArtist('Kygo with Selena Gomez'), 'Kygo');
  // A solo credit is its own lead, and a name that IS an ampersand pair is
  // only split for the query — pickByArtist still checks the full credit.
  assert.equal(primaryArtist('The Weeknd'), 'The Weeknd');
  assert.equal(primaryArtist('  '), '');
});

// The cascade widens the query in stages and stops adding stages it would
// only repeat.
test('deezerQueries degrades full credit to lead artist to title', () => {
  assert.deepEqual(
    deezerQueries('Fred again.., Danny Brown', 'OK OK'),
    ['Fred again.., Danny Brown OK OK', 'Fred again.. OK OK', 'OK OK']
  );
  assert.deepEqual(deezerQueries('The Weeknd', 'Blinding Lights'),
    ['The Weeknd Blinding Lights', 'Blinding Lights']);
});

// D3: the cascade widens the QUERY, never the acceptance. A title-only
// query returns strangers — measured, "OK OK" ranks OT7 Quanny first — and
// pickByArtist still runs against the full credit, so they stay rejected.
test('a title-only stage still rejects a foreign artist', () => {
  const cands = [
    { title: 'OK OK', artist: 'OT7 Quanny', link: 'wrong', id: '1' },
    { title: 'OK OK', artist: 'Fred again..', link: 'right', id: '2' },
  ];
  assert.equal(pickByArtist(cands, 'Fred again.., Danny Brown', 'OK OK')?.link, 'right');
  assert.equal(pickByArtist([cands[0]], 'Fred again.., Danny Brown', 'OK OK'), null);
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
    { title: '', artist: 'Daft Punk', link: 'https://www.deezer.com/artist/27', id: '27', thumb: 'https://cdn.dzcdn.net/dp.jpg', fans: 0 },
    { title: '', artist: 'Daft Funk Tribute', link: 'https://www.deezer.com/artist/28', id: '28', thumb: '', fans: 0 },
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

test('pickByName prefers exact names and breaks ties by fan count', () => {
  // Real shape of the GRETA case: Deezer ranks a 2-fan namesake first and
  // the token-subset match would even accept "Greta Van Fleet".
  const cands = [
    { title: '', artist: 'Greta Van Fleet', link: 'a', id: '1', fans: 900000 },
    { title: '', artist: 'Greta', link: 'b', id: '2', fans: 2 },
    { title: '', artist: 'GRETA', link: 'c', id: '3', fans: 250 },
  ];
  assert.equal(pickByName(cands, 'GRETA')?.id, '3');
  // Equal fan counts fall back to catalog rank (first wins).
  const tie = [
    { title: '', artist: 'Greta', link: 'b', id: '2', fans: 5 },
    { title: '', artist: 'GRETA', link: 'c', id: '3', fans: 5 },
  ];
  assert.equal(pickByName(tie, 'greta')?.id, '2');
  // Punctuation never blocks the exact path — normalize eats it.
  assert.equal(pickByName([{ title: '', artist: 'Emerson, Lake & Palmer', link: 'd', id: '4' }], 'Emerson Lake Palmer')?.id, '4');
  // No exact hit → loose match still works (iTunes rows carry no fans).
  assert.equal(pickByName([{ title: '', artist: 'Tyler Childers and the Food Stamps', link: 'e', id: '5' }], 'Tyler Childers')?.id, '5');
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

test('titlesOverlap needs one strictly equal searchable title', () => {
  const source = ['chaos im kopf', 'wetten dass', 'ganz schön high'];
  assert.equal(titlesOverlap(source, ['ZEN', 'wetten dass', 'Explaining Men']), true);
  // Bracketed noise is stripped before comparing.
  assert.equal(titlesOverlap(source, ['Wetten Dass (Live)']), true);
  // A subset match must NOT count — live shape of the wrong "Greta":
  // casting-show covers share words but never whole searchable titles.
  assert.equal(titlesOverlap(source, ['Mercy (aus "The Voice Kids") (Blind Audition Live)', 'Sk8er Boi']), false);
  assert.equal(titlesOverlap([], ['ZEN']), false);
  assert.equal(titlesOverlap(source, []), false);
});

test('confirmByCatalog proves candidates by shared tracks, never by popularity', async () => {
  // Live shape of the GRETA case: the most popular exact namesake is a
  // casting-show act; the real artist ranks second by fans.
  const cands = [
    { artist: 'Greta', link: 'wrong', id: '58203', fans: 876 },
    { artist: 'GRETA', link: 'right', id: '184643867', fans: 250 },
    { artist: 'Greta Van Fleet', link: 'gvf', id: '5674606', fans: 195636 },
  ];
  const tops = {
    58203: ['Mercy (Blind Audition Live)', 'Sk8er Boi'],
    184643867: ['ZEN', 'wetten dass', 'chaos im kopf'],
  };
  const probed = [];
  const fetchTop = async (c) => { probed.push(c.id); return tops[c.id] || []; };
  const hit = await confirmByCatalog(cands, 'GRETA', ['wetten dass', 'holidaze'], fetchTop);
  assert.equal(hit?.link, 'right');
  // Probes run in fan order over exact names only — Van Fleet never probed.
  assert.deepEqual(probed, ['58203', '184643867']);
  // No overlap anywhere → null, NOT the popular namesake.
  assert.equal(await confirmByCatalog(cands, 'GRETA', ['auseinander'], fetchTop), null);
  // A failing probe skips to the next candidate instead of aborting.
  const flaky = async (c) => { if (c.id === '58203') throw new Error('down'); return tops[c.id] || []; };
  assert.equal((await confirmByCatalog(cands, 'GRETA', ['zen'], flaky))?.link, 'right');
});

test('namesakeChipLabel disambiguates by top track, falls back to the bare name', () => {
  assert.equal(namesakeChipLabel({ name: 'GRETA', track: 'wetten dass' }), 'GRETA — “wetten dass”');
  assert.equal(namesakeChipLabel({ name: 'GRETA', track: '' }), 'GRETA');
});

test('probeNamesakes maps candidates to chips, capped, tolerant of failed probes', async () => {
  const cands = [
    { artist: 'Greta', link: 'a', id: '1', thumb: 't1' },
    { artist: 'GRETA', link: 'b', id: '2', thumb: 't2' },
    { artist: 'Greta', link: 'c', id: '3', thumb: '' },
  ];
  const fetchTop = async (c) => {
    if (c.id === '2') return ['ZEN', 'wetten dass'];
    throw new Error('down');
  };
  // Cap holds; a failed probe keeps the candidate with a bare-name chip.
  assert.deepEqual(await probeNamesakes(cands, fetchTop, 2), [
    { name: 'Greta', link: 'a', id: '1', thumb: 't1', track: '' },
    { name: 'GRETA', link: 'b', id: '2', thumb: 't2', track: 'ZEN' },
  ]);
  assert.deepEqual(await probeNamesakes([], fetchTop), []);
});

test('confirmByCatalog reports every probe via onProbe without changing its verdict', async () => {
  const cands = [
    { artist: 'Greta', link: 'wrong', id: '58203', fans: 876 },
    { artist: 'GRETA', link: 'right', id: '184643867', fans: 250 },
  ];
  const tops = { 58203: ['Mercy'], 184643867: ['ZEN', 'wetten dass'] };
  const fetchTop = async (c) => tops[c.id] || [];
  const probed = [];
  const hit = await confirmByCatalog(cands, 'GRETA', ['wetten dass'], fetchTop, 4,
    (cand, top) => probed.push({ id: cand.id, top }));
  assert.equal(hit?.link, 'right');
  // Probes arrive in fan order, including the one that proved out.
  assert.deepEqual(probed, [
    { id: '58203', top: ['Mercy'] },
    { id: '184643867', top: ['ZEN', 'wetten dass'] },
  ]);
  // A fetch failure reports as an empty probe, not a skip — the chip row
  // must still offer that candidate.
  const flaky = async (c) => { if (c.id === '58203') throw new Error('down'); return tops[c.id]; };
  const probed2 = [];
  assert.equal(await confirmByCatalog(cands, 'GRETA', ['nomatch'], flaky, 4,
    (cand, top) => probed2.push({ id: cand.id, top })), null);
  assert.deepEqual(probed2, [
    { id: '58203', top: [] },
    { id: '184643867', top: ['ZEN', 'wetten dass'] },
  ]);
});

test('pickMbArtist name search needs exact equality, not a token subset', () => {
  // Live shape: MB scores "Greta Keller" 100 for the query artist:"GRETA".
  const search = { artists: [
    { id: 'mbid-keller', name: 'Greta Keller', score: 100 },
    { id: 'mbid-band', name: 'Greta', score: 91 },
  ] };
  assert.deepEqual(pickMbArtist(search, 'GRETA'), { id: 'mbid-band', name: 'Greta' });
});

test('pickMbArtist reads the multi-resource url response shape', () => {
  const multi = { 'url-count': 2, urls: [
    { relations: [] },
    { relations: [{ artist: { id: 'mbid-dp', name: 'Daft Punk' } }] },
  ] };
  assert.deepEqual(pickMbArtist(multi, 'Daft Punk'), { id: 'mbid-dp', name: 'Daft Punk' });
});

test('expandArtistAnchor covers the URL forms MB actually stores', () => {
  // Apple: MB holds slugless music.apple.com AND legacy itunes.apple.com
  // forms under editor-chosen storefronts — cover pasted + us.
  assert.deepEqual(expandArtistAnchor('https://music.apple.com/de/artist/greta/1646937897'), [
    'https://music.apple.com/de/artist/1646937897',
    'https://itunes.apple.com/de/artist/id1646937897',
    'https://music.apple.com/us/artist/1646937897',
    'https://itunes.apple.com/us/artist/id1646937897',
  ]);
  // A us link expands without duplicates.
  assert.equal(expandArtistAnchor('https://music.apple.com/us/artist/5468295').length, 2);
  assert.deepEqual(expandArtistAnchor('https://tidal.com/artist/8847'), [
    'https://tidal.com/artist/8847',
    'https://listen.tidal.com/artist/8847',
  ]);
  // Canonical single-form platforms pass through normalized.
  assert.deepEqual(expandArtistAnchor('https://www.deezer.com/artist/27'), ['https://www.deezer.com/artist/27']);
  // Non-artist and unparseable URLs stay untouched.
  assert.deepEqual(expandArtistAnchor('https://example.com/x'), ['https://example.com/x']);
});

test('relsConfirmAnchor compares parsed entities, not URL strings', () => {
  const rels = ['https://music.apple.com/fr/artist/1646937897', 'https://tidal.com/artist/1'];
  // Storefront and slug differences must not block the confirmation.
  assert.equal(relsConfirmAnchor(rels, ['https://music.apple.com/de/artist/greta/1646937897']), true);
  assert.equal(relsConfirmAnchor(rels, ['https://www.deezer.com/artist/184643867']), false);
  assert.equal(relsConfirmAnchor([], ['https://www.deezer.com/artist/184643867']), false);
  assert.equal(relsConfirmAnchor(rels, []), false);
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

// The whole point of the UPC early exit: one throttled MB call is spent
// only while something the caller asked for is still open.
test('unmetNeed reports exactly the wanted keys a link map misses', () => {
  const links = {
    spotify: 'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc',
    qobuz: 'https://www.qobuz.com/album/discovery/0724384960650',
  };
  assert.deepEqual(unmetNeed(['spotify', 'tidal', 'qobuz'], links), ['tidal']);
  assert.deepEqual(unmetNeed(['spotify', 'qobuz'], links), [], 'everything wanted is covered');
  // Platforms outside `need` never keep the cascade alive.
  assert.deepEqual(unmetNeed([], links), []);
  // Nothing found yet → everything stays open (first release lookup).
  assert.deepEqual(unmetNeed(['spotify'], {}), ['spotify']);
  // Defensive: a missing need or link map must not throw mid-cascade.
  assert.deepEqual(unmetNeed(null, links), []);
  assert.deepEqual(unmetNeed(['tidal'], null), ['tidal']);
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
