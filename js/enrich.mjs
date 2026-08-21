// SPDX-License-Identifier: GPL-3.0-or-later
// Best-effort enrichment: a Deezer match yields a standard code (ISRC for
// tracks, UPC for albums), MusicBrainz turns that code into exact links on
// platforms we cannot search keylessly. This is the only route to an exact
// Spotify link — Spotify has no keyless search — so coverage is
// community-driven and every failure here is silent by design.
//
// Kept out of app.mjs because the ISRC and UPC paths were near-identical
// copies of each other; they differ only in which entity kind and which
// two adapter calls they use.

import { parseInput } from './parsers.mjs';
import { fetchDeezerIsrc, findLinksByIsrc, fetchDeezerUpc, findLinksByUpc } from './adapters.mjs';

// Measured 2026-08-20 (Issue #1): MB recording *search* and alternate
// Deezer ISRCs both add zero hits over this path — the gap is missing
// Spotify URL relations in MB itself, not the lookup route. Spotify's own
// upc: search is measured dead too (ENDPOINTS.md), so MB is the only way
// to an exact Spotify album link.
const CODES = {
  isrc: { entityKind: 'track', fetchCode: fetchDeezerIsrc, findLinks: findLinksByIsrc },
  upc: { entityKind: 'album', fetchCode: fetchDeezerUpc, findLinks: findLinksByUpc },
};

// MusicBrainz is the ONLY keyless route to these three (ENDPOINTS.md:
// Spotify has no keyless search at all, Tidal and Qobuz none that returns
// an exact album). Every other platform is served by a direct search that
// already ran before this stage, so these three alone decide whether one
// more throttled MB lookup can still pay off. Widening this to every
// platform key would leave it permanently unmet — Bandcamp and Amazon are
// never in MB's release rels — and silently disable the early exit.
export const MB_ONLY_KEYS = ['spotify', 'tidal', 'qobuz'];

// The MB-only platforms this round has not landed yet. A source card
// counts as landed: its pasted link outranks anything MB could add.
export function missingMbKeys(state) {
  return MB_ONLY_KEYS.filter((key) => !state.exact[key] && !state.sourceKeys.includes(key));
}

// Merge a {platformKey: url} map into state.exact. A source card keeps the
// pasted link, and an already-known exact link is never overwritten — the
// earlier stage had better provenance. → true when anything was added, so
// the caller knows whether a re-render is worth it.
export function mergeExactLinks(state, links) {
  let added = false;
  for (const [key, url] of Object.entries(links || {})) {
    if (!state.exact[key] && !state.sourceKeys.includes(key)) {
      state.exact[key] = url;
      added = true;
    }
  }
  return added;
}

// Derive the code from a Deezer *match* only: after a manual title edit the
// pasted source track no longer describes what the fields say. `gen` guards
// every await — a newer commit invalidates this round mid-flight.
export async function enrichByCode(codeKind, { state, gen, render, setPhase }) {
  const cfg = CODES[codeKind];
  const checkedKey = `${codeKind}Checked`;
  const fromKey = `${codeKind}From`;
  try {
    let code = state[codeKind];
    if (!code && state.exact.deezer && !state.sourceKeys.includes('deezer')) {
      const dz = parseInput(state.exact.deezer);
      if (dz.ok && dz.platform === 'deezer' && dz.kind === cfg.entityKind && state[fromKey] !== dz.id) {
        state[fromKey] = dz.id;
        code = await cfg.fetchCode(dz.id);
        if (gen !== state.generation) return;
        state[codeKind] = code;
        // A fresh code upgrades a search card to a code search — show that
        // BEFORE the MusicBrainz round-trip, which may 404 and throw.
        if (code) render();
      }
    }
    if (!code || state[checkedKey] === code) return;
    state[checkedKey] = code;
    setPhase('Checking MusicBrainz for exact links');
    // The album path spends a throttled MB call per release — tell it what
    // is still open so it can stop once nothing is (the ISRC path is a
    // single call and ignores the hint).
    const links = await cfg.findLinks(code, missingMbKeys(state));
    if (gen !== state.generation) return;
    if (mergeExactLinks(state, links)) render();
  } catch { /* best effort — search links stay */ }
}
