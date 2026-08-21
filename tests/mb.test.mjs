// SPDX-License-Identifier: GPL-3.0-or-later
// MusicBrainz call budget. Every call here is a real, throttled request in
// production, so the interesting property is not the returned map but HOW
// MANY requests produced it — `unmetNeed` alone cannot prove the cascade
// actually stops. fetch is stubbed; the ~1.1 s spacing inside mbJson is
// not, which is why this file is the slow one in the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLinksByUpc } from '../js/adapters.mjs';

// Measured 2026-08-21, barcode:724384960650 (Daft Punk — Discovery): the
// 2005 release carries the MB-only platforms, the 2024 one adds nothing
// but an Apple URL that the first release already covers in its legacy
// itunes.apple.com form.
const SEARCH = { releases: [{ id: 'rel-2005' }, { id: 'rel-2024' }] };
const REL_2005 = {
  relations: [
    { url: { resource: 'https://www.deezer.com/album/302127' } },
    { url: { resource: 'https://itunes.apple.com/de/album/id697194953' } },
    { url: { resource: 'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc' } },
    { url: { resource: 'https://tidal.com/album/1550545' } },
    { url: { resource: 'https://www.qobuz.com/de-de/album/discovery/0724384960650' } },
  ],
};
const REL_2024 = {
  relations: [
    { url: { resource: 'https://music.apple.com/de/album/697194953' } },
    { url: { resource: 'https://www.deezer.com/album/302127' } },
    { url: { resource: 'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc' } },
  ],
};

// Serves the fixtures above and records every URL MusicBrainz was asked for.
function stubMb(bodies = { 'rel-2005': REL_2005, 'rel-2024': REL_2024 }) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const id = Object.keys(bodies).find((k) => String(url).includes(k));
    const body = id ? bodies[id] : SEARCH;
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

test('the second release lookup is skipped once nothing wanted is open', async () => {
  const calls = stubMb();
  const links = await findLinksByUpc('724384960650', ['spotify', 'tidal', 'qobuz']);
  assert.equal(calls.length, 2, 'search + one release lookup — down from three');
  assert.ok(calls[1].includes('rel-2005'), 'the skipped call is the second release, not the first');
  // Lossless where it counts: the four platforms the app shows are all there.
  assert.deepEqual(
    Object.keys(links).sort(),
    ['appleMusic', 'deezer', 'qobuz', 'spotify', 'tidal']
  );
});

test('a still-open platform keeps the full budget', async () => {
  // Qobuz is missing from the first release, so the second call must run.
  const calls = stubMb({ 'rel-2005': { relations: REL_2005.relations.slice(0, 4) }, 'rel-2024': REL_2024 });
  await findLinksByUpc('724384960650', ['spotify', 'tidal', 'qobuz']);
  assert.equal(calls.length, 3, 'an unmet need is worth the throttled call');
});

test('without a need hint every release is looked up, exactly as before', async () => {
  const calls = stubMb();
  const links = await findLinksByUpc('724384960650');
  assert.equal(calls.length, 3);
  assert.equal(links.spotify, 'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc');
});
