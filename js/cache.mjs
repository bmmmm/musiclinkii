// SPDX-License-Identifier: GPL-3.0-or-later
// A small localStorage cache for expensive lookup RESULTS. Written for
// MusicBrainz, which allows ~1 req/s and 503s even inside that budget —
// repeating a lookup we already answered once is the cheapest throttling
// we can avoid.
//
// Deliberately at result level, not at response level: a cached MB
// response carries the full url-rels payload, a cached result is a
// handful of URLs. And deliberately not a fetch wrapper: only the caller
// knows whether a result is worth keeping for a month or for a day.
//
// Every localStorage touch is guarded. In Safari's private mode the
// property access itself throws, and a full quota throws on write — the
// cache is an optimization, so a broken store must degrade to "no cache",
// never to a broken lookup.

const PREFIX = 'mlii:';

// Roughly a few hundred KB of small link maps. The cap exists so a long
// browsing session cannot grow the store without bound; it is not a
// correctness boundary.
const MAX_ENTRIES = 200;

export const DAY_MS = 24 * 60 * 60 * 1000;

// Exported for the tests — the eviction path is otherwise only reachable
// after 200 real lookups.
export const CACHE_PREFIX = PREFIX;
export const CACHE_MAX_ENTRIES = MAX_ENTRIES;

function store() {
  try {
    const s = globalThis.localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    return null; // private mode: the getter itself throws
  }
}

function ourKeys(s) {
  const keys = [];
  for (let i = 0; i < s.length; i += 1) {
    const k = s.key(i);
    if (k && k.startsWith(PREFIX)) keys.push(k);
  }
  return keys;
}

// Read-through with expiry. A corrupt or foreign-shaped entry is treated
// as a miss and dropped: it can only have come from an older format.
function read(s, key) {
  const full = PREFIX + key;
  try {
    const raw = s.getItem(full);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry.exp !== 'number' || !('v' in entry)) {
      s.removeItem(full);
      return null;
    }
    if (entry.exp <= Date.now()) {
      s.removeItem(full);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

// Make room for one more entry, oldest first. An entry we cannot parse
// sorts as the oldest — dropping it is the point.
function evictOldest(s) {
  const keys = ourKeys(s);
  const over = keys.length - MAX_ENTRIES + 1;
  if (over <= 0) return;
  const dated = keys.map((k) => {
    let ts = 0;
    try {
      ts = JSON.parse(s.getItem(k))?.ts || 0;
    } catch { /* unparseable → evict first */ }
    return { k, ts };
  });
  dated.sort((a, b) => a.ts - b.ts);
  for (const { k } of dated.slice(0, over)) s.removeItem(k);
}

function write(s, key, value, ttlMs) {
  // A TTL of 0 is the caller's way of saying "this answer is not worth
  // keeping" — a throttled lookup that fell back to an empty result.
  const ttl = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
  if (!(ttl > 0)) return;
  try {
    evictOldest(s);
    const now = Date.now();
    s.setItem(PREFIX + key, JSON.stringify({ v: value, ts: now, exp: now + ttl }));
  } catch { /* quota or private mode — losing the cache is fine */ }
}

// Run `fn` unless `key` still holds a live result. `ttlMs` is either a
// number of milliseconds or a function of the resolved value, so the
// caller can keep a hit far longer than an empty answer.
//
// A rejection propagates and is NEVER stored: caching a 503 would freeze
// a throttling window into a permanent "no links found".
export async function cachedResult(key, ttlMs, fn) {
  const s = store();
  const hit = s && read(s, key);
  if (hit) return hit.v;
  const value = await fn();
  if (s) write(s, key, value, ttlMs);
  return value;
}

// Drop everything this module owns. Not wired to any UI — it exists so a
// format change has an escape hatch and the tests have a clean slate.
export function clearCache() {
  const s = store();
  if (!s) return;
  try {
    for (const k of ourKeys(s)) s.removeItem(k);
  } catch { /* best effort */ }
}
