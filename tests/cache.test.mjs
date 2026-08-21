// SPDX-License-Identifier: GPL-3.0-or-later
// The MusicBrainz result cache. Its failure modes are all silent — a
// cached error freezes a throttling window into "no links found", a
// missing expiry pins a fresh release to its empty first answer, an
// unguarded localStorage breaks the whole lookup in private mode. None of
// that shows up in the UI, so it is pinned here.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cachedResult, clearCache, DAY_MS, CACHE_PREFIX, CACHE_MAX_ENTRIES } from '../js/cache.mjs';

// Minimal Storage: the real API surface the module uses (getItem,
// setItem, removeItem, length, key), backed by a Map so insertion order
// is stable and inspectable.
function fakeStorage() {
  const map = new Map();
  return {
    map,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

const entryFor = (store, key) => JSON.parse(store.getItem(CACHE_PREFIX + key));

// defineProperty, not assignment: the private-mode test below installs a
// throwing getter, and a plain assignment cannot replace one.
function installStorage(store) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: store });
}

beforeEach(() => {
  installStorage(fakeStorage());
});

test('a stored result is served without running the lookup again', async () => {
  let runs = 0;
  const lookup = async () => { runs += 1; return { spotify: 'https://open.spotify.com/track/1' }; };

  const first = await cachedResult('mb:isrc:GBARL9300135', DAY_MS, lookup);
  const second = await cachedResult('mb:isrc:GBARL9300135', DAY_MS, lookup);

  assert.equal(runs, 1, 'the second call must not touch MusicBrainz');
  assert.deepEqual(second, first);
});

test('an expired entry is dropped and the lookup runs again', async () => {
  const key = 'mb:isrc:EXPIRED';
  const now = Date.now();
  // Seeded directly: waiting out a TTL is not a test.
  globalThis.localStorage.setItem(
    CACHE_PREFIX + key,
    JSON.stringify({ v: { spotify: 'stale' }, ts: now - 2 * DAY_MS, exp: now - 1000 })
  );

  const fresh = await cachedResult(key, DAY_MS, async () => ({ spotify: 'fresh' }));

  assert.deepEqual(fresh, { spotify: 'fresh' });
  assert.equal(entryFor(globalThis.localStorage, key).v.spotify, 'fresh', 'the stale entry was replaced');
});

test('a TTL function keeps hits far longer than empty answers', async () => {
  const ttl = (links) => (Object.keys(links).length ? 30 * DAY_MS : DAY_MS);
  const before = Date.now();

  await cachedResult('mb:upc:HIT', ttl, async () => ({ spotify: 'https://open.spotify.com/album/1' }));
  await cachedResult('mb:upc:MISS', ttl, async () => ({}));

  const hit = entryFor(globalThis.localStorage, 'mb:upc:HIT');
  const miss = entryFor(globalThis.localStorage, 'mb:upc:MISS');
  assert.ok(hit.exp - before >= 29 * DAY_MS, 'a found release keeps its links for a month');
  assert.ok(miss.exp - before <= DAY_MS + 5000, 'an empty answer is retried tomorrow');
  assert.ok(miss.exp > before, 'but not immediately — one lookup per day is the point');
});

test('a failed lookup is never stored — a 503 must not freeze the result', async () => {
  const key = 'mb:upc:724384960650';
  await assert.rejects(
    cachedResult(key, DAY_MS, async () => { throw new Error('HTTP 503'); }),
    /HTTP 503/,
    'the rejection reaches the caller unchanged'
  );
  assert.equal(globalThis.localStorage.getItem(CACHE_PREFIX + key), null);

  // And the retry after the throttling window still gets through.
  const links = await cachedResult(key, DAY_MS, async () => ({ tidal: 'https://tidal.com/album/1550545' }));
  assert.deepEqual(links, { tidal: 'https://tidal.com/album/1550545' });
});

test('a zero TTL means "do not keep this" — the lookup runs again', async () => {
  let runs = 0;
  const lookup = async () => { runs += 1; return {}; };
  await cachedResult('mb:artist:throttled', () => 0, lookup);
  await cachedResult('mb:artist:throttled', () => 0, lookup);
  assert.equal(runs, 2);
  assert.equal(globalThis.localStorage.length, 0, 'nothing was written');
});

test('the entry cap holds and evicts the oldest first', async () => {
  const store = globalThis.localStorage;
  const now = Date.now();
  // Fill to the cap, oldest = index 0.
  for (let i = 0; i < CACHE_MAX_ENTRIES; i += 1) {
    store.setItem(
      `${CACHE_PREFIX}mb:isrc:FILL${i}`,
      JSON.stringify({ v: { spotify: `u${i}` }, ts: now - (CACHE_MAX_ENTRIES - i) * 1000, exp: now + DAY_MS })
    );
  }
  // A foreign key must survive — the cache only owns its own prefix.
  store.setItem('unrelated', 'keep me');

  await cachedResult('mb:isrc:NEW', DAY_MS, async () => ({ spotify: 'new' }));

  const ours = [...store.map.keys()].filter((k) => k.startsWith(CACHE_PREFIX));
  assert.equal(ours.length, CACHE_MAX_ENTRIES, 'the cap holds after the write');
  assert.equal(store.getItem(`${CACHE_PREFIX}mb:isrc:FILL0`), null, 'the oldest entry made room');
  assert.ok(store.getItem(`${CACHE_PREFIX}mb:isrc:FILL1`), 'the next-oldest survived');
  assert.ok(store.getItem(`${CACHE_PREFIX}mb:isrc:NEW`), 'the new entry landed');
  assert.equal(store.getItem('unrelated'), 'keep me');
});

test('a corrupt entry is a miss, not a crash', async () => {
  const key = 'mb:isrc:CORRUPT';
  globalThis.localStorage.setItem(CACHE_PREFIX + key, '{not json');
  const links = await cachedResult(key, DAY_MS, async () => ({ spotify: 'recovered' }));
  assert.deepEqual(links, { spotify: 'recovered' });
});

test('a store that throws on access degrades to no cache, not to no lookup', async () => {
  // Safari private mode: reading the property itself throws.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError'); },
  });
  let runs = 0;
  const lookup = async () => { runs += 1; return { spotify: 'https://open.spotify.com/track/1' }; };

  assert.deepEqual(await cachedResult('mb:isrc:PRIVATE', DAY_MS, lookup), { spotify: 'https://open.spotify.com/track/1' });
  assert.deepEqual(await cachedResult('mb:isrc:PRIVATE', DAY_MS, lookup), { spotify: 'https://open.spotify.com/track/1' });
  assert.equal(runs, 2, 'every lookup runs, uncached — and none of them throws');
  assert.doesNotThrow(() => clearCache());
});

test('a full store loses the entry, not the result', async () => {
  const store = fakeStorage();
  store.setItem = () => { throw new Error('QuotaExceededError'); };
  installStorage(store);
  const links = await cachedResult('mb:upc:FULL', DAY_MS, async () => ({ qobuz: 'https://www.qobuz.com/album/x' }));
  assert.deepEqual(links, { qobuz: 'https://www.qobuz.com/album/x' });
});

test('clearCache drops our entries and leaves foreign ones alone', async () => {
  await cachedResult('mb:isrc:A', DAY_MS, async () => ({ spotify: 'a' }));
  globalThis.localStorage.setItem('someone-elses-key', 'value');
  clearCache();
  assert.equal(globalThis.localStorage.getItem(`${CACHE_PREFIX}mb:isrc:A`), null);
  assert.equal(globalThis.localStorage.getItem('someone-elses-key'), 'value');
});
