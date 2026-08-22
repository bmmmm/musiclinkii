#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Live before/after for the Deezer query cascade and the gendered-name fold
// (issue #5). Reads the real matchers out of js/adapters.mjs and asks
// api.deezer.com directly — in Node there is no CORS wall, so no JSONP and
// no browser needed. Two samples: Apple's own most-played album feed (the
// shape of input the app gets from a pasted Apple Music album link) and the
// documented cases from the issue, which a top-30 feed does not contain.
//
//   node scripts/measure-deezer-cascade.mjs [count]
//
// BEFORE is the matcher as it stood before this change: one query built from
// the full credit, and a normalize() that leaves gendered names alone. It is
// copied in here on purpose — the point is to measure against what shipped,
// not against the code under test.
import {
  searchableTitle, stripReleaseKind, pickByArtist, deezerCandidates, deezerQueries,
} from '../js/adapters.mjs';

const COUNT = Number(process.argv[2] || 30);
const FEED = `https://rss.applemarketingtools.com/api/v2/de/music/most-played/${COUNT}/albums.json`;

// The two misses the issue measured, plus the gendered pair. Apple hands us
// the generic spelling, Deezer credits this release to "Verschiedene
// Interpret:innen" — the same catalog carries both forms.
const DOCUMENTED = [
  { artist: 'Fred again.., Danny Brown, BEAM, PARISI & JPEGMAFIA', title: 'OK OK' },
  { artist: 'Verschiedene Interpreten', title: 'Kapitel Eins: Zeit für was echtes' },
  { artist: 'Verschiedene Interpret:innen', title: 'Classical Piano' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deezerAlbums(query) {
  const url = `https://api.deezer.com/search/album?q=${encodeURIComponent(query)}&limit=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  await sleep(150); // Deezer allows 50 requests / 5s — stay well under it.
  return deezerCandidates(json, 'album');
}

// --- the shipped matcher, frozen ------------------------------------------
const legacyNormalize = (s) => String(s || '')
  .toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const legacyLoose = (a, b) => {
  const ta = legacyNormalize(a).split(' ').filter(Boolean);
  const tb = legacyNormalize(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const bigSet = new Set(big);
  return small.every((tok) => bigSet.has(tok));
};
const legacyPick = (cands, artist, title) => {
  const qTitle = searchableTitle(title);
  return (cands || []).find(
    (c) => (legacyLoose(c.title, title) || legacyLoose(c.title, qTitle)) && legacyLoose(c.artist, artist)
  ) || null;
};
// --------------------------------------------------------------------------

async function measure(label, sample) {
  console.log(`\n=== ${label}: ${sample.length} albums\n`);
  let before = 0;
  let after = 0;
  const gained = [];
  for (const [i, a] of sample.entries()) {
    const stages = deezerQueries(a.artist, searchableTitle(a.title));
    let hitBefore = null;
    let hitAfter = null;
    let used = 0;
    for (const [n, q] of stages.entries()) {
      let cands;
      try {
        cands = await deezerAlbums(q);
      } catch (err) {
        console.log(`   ! ${q}: ${err.message}`);
        break;
      }
      if (n === 0) hitBefore = legacyPick(cands, a.artist, a.title);
      hitAfter = pickByArtist(cands, a.artist, a.title);
      used = n;
      if (hitAfter) break;
    }
    if (hitBefore) before++;
    if (hitAfter) after++;
    if (!hitBefore && hitAfter) gained.push(`${a.artist} — ${a.title}\n      stage ${used + 1}: "${stages[used]}" → ${hitAfter.link}`);
    const mark = hitAfter ? (hitBefore ? 'ok ' : 'NEW') : 'MISS';
    console.log(`${String(i + 1).padStart(2)}. ${mark.padEnd(4)} ${a.artist} — ${a.title}`);
  }
  console.log(`\n  before: ${before}/${sample.length}   after: ${after}/${sample.length}`);
  if (gained.length) console.log('  gained:\n' + gained.map((g) => `    + ${g}`).join('\n'));
}

const feed = await (await fetch(FEED)).json();
await measure('Apple most-played (de)', (feed?.feed?.results || []).map((r) => ({
  artist: r.artistName,
  title: stripReleaseKind(r.name),
})));
await measure('documented cases (issue #5)', DOCUMENTED);
