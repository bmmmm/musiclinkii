#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  artistCreditText,
  buildSearchSlices,
  isLongTail,
  isVinylRelease,
  longTailScore,
  musicBrainzQuery,
  pageOffset,
  parseDiscogsReleaseId,
  seededRandom,
  shuffled,
  stableShard,
} from './vinyl-benchmark-lib.mjs';

const USER_AGENT = 'musiclinkii-cover-benchmark/0.1 (https://github.com/bmmmm/musiclinkii)';
const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_WORK_DIR = path.join(ROOT, '.cache', 'vinyl-benchmark');
const DEFAULT_COUNTRIES = ['US', 'GB', 'DE', 'FR', 'BR', 'JP', 'NL', 'SE', 'FI', 'PL', 'GR', 'ZA', 'NG', 'IN', 'AU', 'CA'];

function usage() {
  return `Usage: node scripts/build-vinyl-benchmark.mjs [options]

Options:
  --count <n>             Accepted covers to collect (default: 24)
  --seed <n>              Deterministic sample seed (default: 240824)
  --max-candidates <n>    Stop after this many MusicBrainz rows (default: 240)
  --min-year <year>       Earliest release year (default: 1955)
  --max-year <year>       Latest release year (default: 2015)
  --countries <csv>       ISO country codes
  --max-have <n>          Discogs collection ceiling (default: 100)
  --max-want <n>          Discogs wantlist ceiling (default: 30)
  --shards <n>            Deterministically partition candidates (default: 1)
  --shard <n>             Zero-based shard to collect (default: 0)
  --work-dir <path>       Cache and manifest directory
  --help                  Show this message

Discogs images are not downloaded. The optional DISCOGS_TOKEN environment
variable raises the documented API allowance; it is never printed or stored.
`;
}

function positiveInteger(value, name, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return parsed;
}

function parseArgs(argv) {
  const options = {
    count: 24,
    seed: 240824,
    maxCandidates: 240,
    minYear: 1955,
    maxYear: 2015,
    countries: DEFAULT_COUNTRIES,
    maxHave: 100,
    maxWant: 30,
    shards: 1,
    shard: 0,
    workDir: DEFAULT_WORK_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--count') options.count = positiveInteger(value, flag);
    else if (flag === '--seed') options.seed = positiveInteger(value, flag, 0);
    else if (flag === '--max-candidates') options.maxCandidates = positiveInteger(value, flag);
    else if (flag === '--min-year') options.minYear = positiveInteger(value, flag, 1900);
    else if (flag === '--max-year') options.maxYear = positiveInteger(value, flag, 1900);
    else if (flag === '--countries') options.countries = value.split(',').map((country) => country.trim().toUpperCase()).filter(Boolean);
    else if (flag === '--max-have') options.maxHave = positiveInteger(value, flag, 0);
    else if (flag === '--max-want') options.maxWant = positiveInteger(value, flag, 0);
    else if (flag === '--shards') options.shards = positiveInteger(value, flag);
    else if (flag === '--shard') options.shard = positiveInteger(value, flag, 0);
    else if (flag === '--work-dir') options.workDir = path.resolve(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (options.maxYear < options.minYear) throw new Error('--max-year must be >= --min-year');
  if (!options.countries.length) throw new Error('--countries must not be empty');
  if (options.shard >= options.shards) throw new Error('--shard must be smaller than --shards');
  return options;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class PoliteClient {
  constructor({ name, minimumInterval, cacheDir, headers = {} }) {
    this.name = name;
    this.minimumInterval = minimumInterval;
    this.cacheDir = cacheDir;
    this.headers = headers;
    this.lastRequestAt = 0;
  }

  cachePath(url, extension) {
    const hash = createHash('sha256').update(url).digest('hex');
    return path.join(this.cacheDir, `${hash}.${extension}`);
  }

  async waitForTurn() {
    const remaining = this.minimumInterval - (Date.now() - this.lastRequestAt);
    if (remaining > 0) await sleep(remaining);
    this.lastRequestAt = Date.now();
  }

  async request(url, { extension = 'json', accept = 'application/json', retries = 4 } = {}) {
    const cached = this.cachePath(url, extension);
    const missing = this.cachePath(url, 'missing');
    try {
      return { bytes: await readFile(cached), cached: true, url };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await readFile(missing);
      return null;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await this.waitForTurn();
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { Accept: accept, 'User-Agent': USER_AGENT, ...this.headers },
      });
      if (response.status === 404) {
        await mkdir(this.cacheDir, { recursive: true });
        await writeFile(missing, `${new Date().toISOString()} ${url}\n`);
        return null;
      }
      if (response.status === 429 || response.status === 503) {
        if (attempt === retries) throw new Error(`${this.name} stayed unavailable after ${retries + 1} attempts (${response.status})`);
        const retryAfter = Number(response.headers.get('retry-after')) * 1000;
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1500 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw new Error(`${this.name} request failed: HTTP ${response.status} for ${url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await mkdir(this.cacheDir, { recursive: true });
      const partial = `${cached}.partial`;
      await writeFile(partial, bytes);
      await rename(partial, cached);
      return { bytes, cached: false, url: response.url };
    }
    throw new Error(`${this.name} request failed unexpectedly`);
  }

  async json(url) {
    const response = await this.request(url);
    return response ? JSON.parse(response.bytes.toString('utf8')) : null;
  }
}

function yearsBetween(minimum, maximum) {
  return Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index);
}

function searchUrl(query, limit, offset) {
  const url = new URL('https://musicbrainz.org/ws/2/release/');
  url.searchParams.set('query', query);
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  return url.href;
}

function releaseUrl(mbid) {
  const url = new URL(`https://musicbrainz.org/ws/2/release/${mbid}`);
  url.searchParams.set('inc', 'url-rels');
  url.searchParams.set('fmt', 'json');
  return url.href;
}

function discogsHeaders() {
  const token = process.env.DISCOGS_TOKEN;
  return token ? { Authorization: `Discogs token=${token}` } : {};
}

async function saveCover(client, mbid, destination) {
  try {
    await readFile(destination);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const url = `https://coverartarchive.org/release/${mbid}/front-500`;
  const response = await client.request(url, { extension: 'jpg', accept: 'image/*' });
  if (!response) return false;
  if (response.bytes.length < 1000) throw new Error(`Cover response for ${mbid} is unexpectedly small`);
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  await writeFile(partial, response.bytes);
  await rename(partial, destination);
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  await mkdir(options.workDir, { recursive: true });
  const coversDir = path.join(options.workDir, 'covers');
  const cacheRoot = path.join(options.workDir, 'http-cache');
  const discogsTokenPresent = Boolean(process.env.DISCOGS_TOKEN);
  const musicBrainz = new PoliteClient({
    name: 'MusicBrainz', minimumInterval: 1100, cacheDir: path.join(cacheRoot, 'musicbrainz'),
  });
  const coverArchive = new PoliteClient({
    name: 'Cover Art Archive', minimumInterval: 350, cacheDir: path.join(cacheRoot, 'cover-art-archive'),
  });
  const discogs = new PoliteClient({
    name: 'Discogs', minimumInterval: discogsTokenPresent ? 1100 : 2600,
    cacheDir: path.join(cacheRoot, 'discogs'), headers: discogsHeaders(),
  });

  const random = seededRandom(options.seed);
  const slices = buildSearchSlices({
    years: yearsBetween(options.minYear, options.maxYear),
    countries: options.countries,
    seed: options.seed,
  });
  const accepted = [];
  const seen = new Set();
  let candidates = 0;

  for (const slice of slices) {
    if (accepted.length >= options.count || candidates >= options.maxCandidates) break;
    const query = musicBrainzQuery(slice);
    const countResult = await musicBrainz.json(searchUrl(query, 1, 0));
    const total = Number(countResult?.count) || 0;
    if (!total) continue;
    const limit = Math.min(100, total, options.maxCandidates - candidates);
    const offset = pageOffset(total, limit, random());
    const page = await musicBrainz.json(searchUrl(query, limit, offset));
    const rows = shuffled(page?.releases || [], Math.floor(random() * 0xffffffff));

    for (const row of rows) {
      if (accepted.length >= options.count || candidates >= options.maxCandidates) break;
      if (!row?.id || seen.has(row.id) || !isVinylRelease(row)) continue;
      seen.add(row.id);
      if (stableShard(row.id, options.shards) !== options.shard) continue;
      candidates += 1;
      process.stdout.write(`[${accepted.length}/${options.count}] ${row.id} ${artistCreditText(row['artist-credit'])} — ${row.title}\n`);

      const coverPath = path.join(coversDir, `${row.id}.jpg`);
      if (!await saveCover(coverArchive, row.id, coverPath)) continue;
      const detail = await musicBrainz.json(releaseUrl(row.id));
      const discogsReleaseId = parseDiscogsReleaseId(detail?.relations);
      if (!discogsReleaseId) continue;
      const discogsRelease = await discogs.json(`https://api.discogs.com/releases/${discogsReleaseId}`);
      const stats = {
        have: Number(discogsRelease?.community?.have),
        want: Number(discogsRelease?.community?.want),
      };
      if (!isLongTail(stats, options)) continue;

      accepted.push({
        musicBrainzReleaseId: row.id,
        releaseGroupId: row['release-group']?.id || null,
        discogsReleaseId,
        artist: artistCreditText(row['artist-credit']),
        title: row.title,
        date: row.date || null,
        country: row.country || null,
        formats: (row.media || []).map((medium) => medium.format).filter(Boolean),
        discogs: { ...stats, longTailScore: longTailScore(stats) },
        coverPath: path.relative(ROOT, coverPath),
        coverSource: `https://coverartarchive.org/release/${row.id}/front-500`,
      });
    }
  }

  accepted.sort((left, right) => left.discogs.longTailScore - right.discogs.longTailScore ||
    left.musicBrainzReleaseId.localeCompare(right.musicBrainzReleaseId));
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    seed: options.seed,
    shard: { index: options.shard, count: options.shards },
    policy: {
      musicBrainzMinimumIntervalMs: 1100,
      coverArtArchiveMinimumIntervalMs: 350,
      discogsMinimumIntervalMs: discogsTokenPresent ? 1100 : 2600,
      discogsAuthenticated: discogsTokenPresent,
      maxHave: options.maxHave,
      maxWant: options.maxWant,
    },
    examinedCandidates: candidates,
    releases: accepted,
  };
  const manifestPath = path.join(options.workDir, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Collected ${accepted.length} long-tail vinyl covers after ${candidates} candidates.\n`);
  process.stdout.write(`Manifest: ${manifestPath}\n`);
  if (accepted.length < options.count) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
