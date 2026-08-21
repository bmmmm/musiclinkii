// SPDX-License-Identifier: GPL-3.0-or-later
// MusicBrainz call budget. Every call here is a real, throttled request in
// production, so the interesting property is not the returned map but HOW
// MANY requests produced it — `unmetNeed` alone cannot prove the cascade
// actually stops. fetch is stubbed; the ~1.1 s spacing inside mbJson is
// not, which is why this file is the slow one in the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLinksByUpc, findLinksByArtist } from '../js/adapters.mjs';
import { enrichByCode } from '../js/enrich.mjs';

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

// --- What enrichByCode reports back. The 503/404 split is the whole
// point: only one of them costs links that exist, and only one of them
// may put a line on screen. The ISRC is preset so the Deezer JSONP step
// (which needs a DOM) is skipped — the MB round-trip is what matters.

// Answers every MusicBrainz request with the same HTTP status.
function stubStatus(status) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: status < 400, status, json: async () => ({}) };
  };
  return calls;
}

const enrichState = () => ({
  exact: {}, sourceKeys: [], generation: 1, isrc: 'GBARL9300135', isrcChecked: '',
});
const enrichCtx = (state) => ({ state, gen: 1, render: () => {}, setPhase: () => {} });

test('a throttled MusicBrainz is reported back, so the UI can say so', async () => {
  const calls = stubStatus(503);
  const state = enrichState();
  assert.equal(await enrichByCode('isrc', enrichCtx(state)), true);
  assert.equal(calls.length, 2, 'mbJson retried once before giving up');
  assert.deepEqual(state.exact, {}, 'and no links were invented on the way out');
});

test('a 404 stays silent — MusicBrainz simply has no entry for this release', async () => {
  stubStatus(404);
  assert.equal(await enrichByCode('isrc', enrichCtx(enrichState())), false,
    'the normal case for a fresh release must not raise a rate-limit warning');
});

test('a round that finds links reports no throttling', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      recordings: [{ relations: [{ url: { resource: 'https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i' } }] }],
    }),
  });
  const state = enrichState();
  assert.equal(await enrichByCode('isrc', enrichCtx(state)), false);
  assert.equal(state.exact.spotify, 'https://open.spotify.com/track/0Jcij1eWd5bDMU5iPbxe2i');
});

// --- The artist fan-out reports the same way. It swallows its own errors
// on the way to the name-search fallback, so a throttled round is
// indistinguishable from "MusicBrainz does not know this artist" unless
// it says so itself.

// No `name`, so the name-search fallback is skipped and the round is two
// MB calls (the anchor lookup plus mbJson's one retry) instead of four.
test('a throttled artist fan-out says so instead of looking like an unknown artist', async () => {
  const calls = stubStatus(503);
  const { links, throttled } = await findLinksByArtist({ urls: ['https://www.deezer.com/artist/27'], name: '' });
  assert.equal(throttled, true);
  assert.deepEqual(links, {}, 'and it still resolves — the caller must reach updateOutcome');
  assert.equal(calls.length, 2, 'the anchor lookup and its retry, no name search without a name');
});

test('an artist round that resolves reports no throttling', async () => {
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/url/')
      // The url route answers { urls: [{ relations }] }, artist on the rel.
      ? { urls: [{ relations: [{ artist: { id: 'mbid-daft', name: 'Daft Punk' } }] }] }
      : { relations: [{ url: { resource: 'https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi' } }] }),
  });
  const { links, throttled } = await findLinksByArtist({ urls: ['https://www.deezer.com/artist/27'], name: 'Daft Punk' });
  assert.equal(throttled, false);
  assert.equal(links.spotify, 'https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi');
});

test('a throttled FINAL lookup is reported too — the artist was known, the links were not', async () => {
  let n = 0;
  globalThis.fetch = async (url) => {
    n += 1;
    // Anchor lookup succeeds, every artist/{mbid} attempt throttles.
    if (String(url).includes('/url/')) {
      return { ok: true, status: 200, json: async () => ({ urls: [{ relations: [{ artist: { id: 'mbid-daft', name: 'Daft Punk' } }] }] }) };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };
  const { links, throttled } = await findLinksByArtist({ urls: ['https://www.deezer.com/artist/27'], name: 'Daft Punk' });
  assert.equal(throttled, true, 'the failure the user can actually act on');
  assert.deepEqual(links, {});
  assert.equal(n, 3, 'anchor lookup, then the artist lookup and its retry');
});
