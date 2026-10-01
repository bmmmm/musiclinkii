// SPDX-License-Identifier: GPL-3.0-or-later

const DISCOGS_RELEASE_PATTERN = /(?:www\.)?discogs\.com\/(?:[^/]+\/)?release\/(\d+)/i;

export function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(values, seed) {
  const result = [...values];
  const random = seededRandom(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export function stableShard(value, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('shardCount must be a positive integer');
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % shardCount;
}

export function parseDiscogsReleaseId(relations) {
  for (const relation of relations || []) {
    const resource = relation?.url?.resource || relation?.resource || '';
    const match = String(resource).match(DISCOGS_RELEASE_PATTERN);
    if (match) return Number(match[1]);
  }
  return null;
}

export function isVinylRelease(release) {
  return (release?.media || []).some((medium) => /vinyl/i.test(medium?.format || ''));
}

export function longTailScore(stats) {
  const have = Math.max(0, Number(stats?.have) || 0);
  const want = Math.max(0, Number(stats?.want) || 0);
  return have + want * 2;
}

export function isLongTail(stats, { maxHave = 100, maxWant = 30 } = {}) {
  const have = Number(stats?.have);
  const want = Number(stats?.want);
  return Number.isFinite(have) && Number.isFinite(want) && have <= maxHave && want <= maxWant;
}

export function musicBrainzQuery({ year, country }) {
  const filters = [
    'format:vinyl',
    'primarytype:album',
    'status:official',
    `date:${Number(year)}`,
  ];
  if (country) filters.push(`country:${String(country).toUpperCase()}`);
  return filters.join(' AND ');
}

export function buildSearchSlices({ years, countries, seed }) {
  const slices = [];
  for (const year of years) {
    for (const country of countries) slices.push({ year, country });
  }
  return shuffled(slices, seed);
}

export function pageOffset(total, pageSize, randomValue) {
  const lastOffset = Math.max(0, Number(total) - pageSize);
  if (!lastOffset) return 0;
  // The first third of a structured MusicBrainz result set tends to contain
  // the best-known and most completely entered records. Sample deeper pages,
  // then let Discogs have/want counts make the actual long-tail decision.
  return Math.floor((0.35 + Math.max(0, Math.min(1, randomValue)) * 0.65) * lastOffset);
}

export function artistCreditText(credit) {
  return (credit || []).map((part) => `${part?.name || part?.artist?.name || ''}${part?.joinphrase || ''}`).join('').trim();
}
