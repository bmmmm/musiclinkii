// SPDX-License-Identifier: GPL-3.0-or-later
// mergeExactLinks used to live three times inside app.mjs — in both enrich
// paths and in the artist fan-out — where no test could reach it. Its two
// guards (never overwrite a better-provenance link, never touch a source
// card) decide whether a pasted link survives a later catalog round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeExactLinks, missingMbKeys, MB_ONLY_KEYS } from '../js/enrich.mjs';

const stateWith = (exact = {}, sourceKeys = []) => ({ exact: { ...exact }, sourceKeys });

// Feeds the UPC early exit: too wide a set never empties and the second
// release lookup runs forever; too narrow a one drops exact links.
test('missingMbKeys covers only the platforms MusicBrainz alone can reach', () => {
  assert.deepEqual(MB_ONLY_KEYS, ['spotify', 'tidal', 'qobuz'],
    'Deezer, Apple and YouTube have direct keyless routes that already ran');
  assert.deepEqual(missingMbKeys(stateWith()), ['spotify', 'tidal', 'qobuz']);
});

test('missingMbKeys treats an exact link and a source card alike — both are landed', () => {
  const state = stateWith(
    { tidal: 'https://tidal.com/album/1550545', appleMusic: 'https://music.apple.com/de/album/697194953' },
    ['spotify']
  );
  assert.deepEqual(missingMbKeys(state), ['qobuz'], 'only the open MB-only platform is worth a call');
});

test('missingMbKeys goes empty once every MB-only platform is known', () => {
  const state = stateWith(
    { spotify: 'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc', qobuz: 'https://www.qobuz.com/album/x/0724384960650' },
    ['tidal']
  );
  assert.deepEqual(missingMbKeys(state), []);
});

test('mergeExactLinks adds unknown platforms and reports that it did', () => {
  const state = stateWith();
  const added = mergeExactLinks(state, {
    spotify: 'https://open.spotify.com/track/5W3cjX2J3tjhG8zb6u0qHn',
    tidal: 'https://tidal.com/track/86024647',
  });
  assert.equal(added, true);
  assert.deepEqual(state.exact, {
    spotify: 'https://open.spotify.com/track/5W3cjX2J3tjhG8zb6u0qHn',
    tidal: 'https://tidal.com/track/86024647',
  });
});

test('an already-known exact link wins — the earlier stage had better provenance', () => {
  const state = stateWith({ spotify: 'https://open.spotify.com/track/KEEPKEEPKEEPKEEPKEEPKE' });
  const added = mergeExactLinks(state, { spotify: 'https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i' });
  assert.equal(added, false, 'nothing changed, so no re-render');
  assert.equal(state.exact.spotify, 'https://open.spotify.com/track/KEEPKEEPKEEPKEEPKEEPKE');
});

test('a source card is never overwritten, even when its key is absent from exact', () => {
  const state = stateWith({}, ['deezer']);
  const added = mergeExactLinks(state, { deezer: 'https://www.deezer.com/track/999' });
  assert.equal(added, false);
  assert.deepEqual(state.exact, {}, 'the pasted link stays the source of truth');
});

test('a mixed round adds only what is genuinely new', () => {
  const state = stateWith({ appleMusic: 'https://music.apple.com/de/album/1?i=2' }, ['spotify']);
  const added = mergeExactLinks(state, {
    spotify: 'https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i', // source — skipped
    appleMusic: 'https://music.apple.com/de/album/9?i=9',             // known — skipped
    deezer: 'https://www.deezer.com/track/3135556',                   // new — added
  });
  assert.equal(added, true);
  assert.deepEqual(Object.keys(state.exact).sort(), ['appleMusic', 'deezer']);
  assert.equal(state.exact.appleMusic, 'https://music.apple.com/de/album/1?i=2');
});

test('an empty or missing link map is a no-op, not a crash', () => {
  const state = stateWith({ deezer: 'https://www.deezer.com/track/1' });
  assert.equal(mergeExactLinks(state, {}), false);
  assert.equal(mergeExactLinks(state, null), false);
  assert.equal(mergeExactLinks(state, undefined), false);
  assert.deepEqual(state.exact, { deezer: 'https://www.deezer.com/track/1' });
});
