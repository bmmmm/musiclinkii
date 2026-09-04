// SPDX-License-Identifier: GPL-3.0-or-later
// Static vinyl-cover retrieval. The query vector never leaves this browser;
// only versioned catalog assets are fetched after an explicit user action.

import { fetchQuantizedIndex, rankQuantized } from './vector-index.mjs';

const moduleUrl = new URL(import.meta.url);
const catalogUrl = new URL('../assets/vinyl-index/manifest.json', moduleUrl);
catalogUrl.search = moduleUrl.search;
export const VINYL_CATALOG_URL = catalogUrl.href;
const MODEL = 'Xenova/dinov2-small';
const MAX_RESULTS = 5;

const GET_OPTIONS = Object.freeze({
  method: 'GET',
  cache: 'force-cache',
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
});

async function fetchJson(url, fetcher) {
  const response = await fetcher(url, GET_OPTIONS);
  if (!response?.ok) throw new Error(`Vinyl catalog request failed with HTTP ${response?.status ?? 'unknown'}`);
  return response.json();
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.model !== MODEL) {
    throw new Error('Vinyl catalog manifest is incompatible');
  }
  if (!Number.isInteger(manifest.dimension) || manifest.dimension < 1 ||
      !Number.isInteger(manifest.releaseCount) || manifest.releaseCount < 1 ||
      !Array.isArray(manifest.shards) || !manifest.shards.length) {
    throw new Error('Vinyl catalog manifest is incomplete');
  }
  const shardCount = manifest.shards.reduce((sum, shard) => sum + Number(shard?.count || 0), 0);
  if (shardCount !== manifest.releaseCount || manifest.shards.some((shard) =>
    !shard?.index || !shard?.metadata || !Number.isInteger(shard.count) || shard.count < 1)) {
    throw new Error('Vinyl catalog shard counts do not match');
  }
  return manifest;
}

function shardUrl(name, manifestUrl) {
  const result = new URL(name, manifestUrl);
  const catalogDirectory = new URL('.', manifestUrl);
  if (result.origin !== manifestUrl.origin || !result.pathname.startsWith(catalogDirectory.pathname)) {
    throw new Error('Vinyl catalog shard must stay on the catalog origin');
  }
  result.search = manifestUrl.search;
  return result;
}

function candidateFrom(release, match) {
  if (!release?.musicBrainzReleaseId || !release.artist || !release.title || !release.coverSource) {
    throw new Error('Vinyl catalog metadata is incomplete');
  }
  return {
    id: release.musicBrainzReleaseId,
    artist: release.artist,
    title: release.title,
    date: release.date || '',
    country: release.country || '',
    thumb: release.coverSource,
    score: match.score,
    visualScore: match.score,
    source: 'visual-index',
  };
}

export async function searchVinylCatalog(queryVector, {
  manifestUrl = VINYL_CATALOG_URL,
  fetcher = globalThis.fetch,
  limit = MAX_RESULTS,
  onProgress = () => {},
} = {}) {
  if (!queryVector?.length) throw new Error('A local cover vector is required');
  if (typeof fetcher !== 'function') throw new Error('A fetch implementation is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new Error(`Vinyl catalog result limit must be between 1 and ${MAX_RESULTS}`);
  }

  const manifestBase = new URL(manifestUrl, globalThis.location?.href || 'https://musiclinkii.invalid/');
  const manifest = validateManifest(await fetchJson(manifestBase, fetcher));
  if (queryVector.length !== manifest.dimension) throw new Error('Vinyl catalog vector dimension does not match');

  let candidates = [];
  for (let shardNumber = 0; shardNumber < manifest.shards.length; shardNumber += 1) {
    const shard = manifest.shards[shardNumber];
    onProgress({ stage: 'catalog', current: shardNumber + 1, total: manifest.shards.length });
    const indexUrl = shardUrl(shard.index, manifestBase);
    const metadataUrl = shardUrl(shard.metadata, manifestBase);
    const [index, metadata] = await Promise.all([
      fetchQuantizedIndex(indexUrl, fetcher, GET_OPTIONS),
      fetchJson(metadataUrl, fetcher),
    ]);
    if (index.dimension !== manifest.dimension || index.count !== shard.count ||
        !Array.isArray(metadata?.releases) || metadata.releases.length !== shard.count) {
      throw new Error('Vinyl catalog shard count does not match its metadata');
    }
    const shardCandidates = rankQuantized(queryVector, index, limit)
      .map((match) => candidateFrom(metadata.releases[match.index], match));
    candidates = [...candidates, ...shardCandidates]
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  return { manifest, candidates };
}
