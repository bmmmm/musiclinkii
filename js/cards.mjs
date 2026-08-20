// SPDX-License-Identifier: GPL-3.0-or-later
// Pure card-model builder: platform registry + current state → what each
// card should show. No DOM access — unit-tested in tests/cards.test.mjs.

import { PLATFORMS, buildQuery } from './links.mjs';
import { parseInput } from './parsers.mjs';
import { embedFor, appLinkFor } from './embeds.mjs';

// → [{ key, name, badge, url, embed, app }] in PLATFORMS order.
export function cardModels({ exact, sourceKeys, kind, isrc, upc }, { artist, title }, region, dark) {
  const query = buildQuery(artist, title);
  const parts = {
    artist: (artist || '').trim(),
    title: (title || '').trim(),
    kind: kind || 'track',
    isrc: isrc || '',
    upc: upc || '',
  };
  const models = [];
  for (const p of PLATFORMS) {
    const exactUrl = exact[p.key];
    const url = exactUrl || (query ? p.searchUrl(query, region, parts) : null);
    if (!url) continue;
    // Exact URLs (source or match) are entities our own parser understands —
    // that's what unlocks embed previews and app links. Search URLs aren't.
    const entity = exactUrl ? parseInput(exactUrl) : null;
    // ISRC/UPC searches land on exactly the right entity — worth a hint.
    // (Both codes are alphanumeric, so a plain substring test is exact.)
    const code = !exactUrl && parts.isrc && url.includes(parts.isrc) ? 'isrc'
      : !exactUrl && parts.upc && url.includes(parts.upc) ? 'upc' : '';
    models.push({
      key: p.key,
      name: p.name,
      badge: sourceKeys.includes(p.key) ? 'source' : (exactUrl ? 'match' : 'search'),
      url,
      viaCode: Boolean(code),
      codeKind: code,
      embed: entity ? embedFor(entity, dark) : null,
      app: entity ? appLinkFor(entity) : null,
    });
  }
  return models;
}

// Change signature: two models with the same signature render identically,
// so the renderer can leave the card's DOM (incl. an open embed) untouched.
// Covers everything buildCard reads. URLs cannot contain a raw newline, so
// the join is unambiguous.
export function cardSignature(m) {
  return [m.badge, m.url, m.codeKind || '', m.embed?.src || '', m.app?.href || ''].join('\n');
}
