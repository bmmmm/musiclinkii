#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { decodeQuantizedIndex } from '../js/vector-index.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_INPUT = path.join(ROOT, '.cache', 'vinyl-benchmark', 'pilot-export.json');
const DEFAULT_OUTPUT = path.join(ROOT, 'assets', 'vinyl-index');

function parseArgs(argv) {
  const options = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--input') options.input = path.resolve(value);
    else if (flag === '--output') options.output = path.resolve(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

async function writeAtomic(destination, body) {
  const partial = `${destination}.partial`;
  await writeFile(partial, body);
  await rename(partial, destination);
}

function releaseMetadata(release) {
  if (!release?.musicBrainzReleaseId || !release.artist || !release.title ||
      !release.coverSource || !(release.formats || []).some((format) => /vinyl/i.test(format))) {
    throw new Error('Every pilot row must identify a vinyl release and its cover');
  }
  return {
    musicBrainzReleaseId: release.musicBrainzReleaseId,
    releaseGroupId: release.releaseGroupId || null,
    discogsReleaseId: release.discogsReleaseId || null,
    artist: release.artist,
    title: release.title,
    date: release.date || null,
    country: release.country || null,
    coverSource: release.coverSource,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/build-vinyl-index-assets.mjs [--input export.json] [--output directory]\n');
    return;
  }
  const bundle = JSON.parse(await readFile(options.input, 'utf8'));
  if (!bundle.indexBase64 || bundle.metadata?.schemaVersion !== 1 || bundle.report?.schemaVersion !== 1) {
    throw new Error('Pilot export is incomplete');
  }
  const indexBytes = Buffer.from(bundle.indexBase64, 'base64');
  const index = decodeQuantizedIndex(indexBytes);
  const releases = bundle.metadata.releases.map(releaseMetadata);
  if (bundle.metadata.model !== bundle.report.model || bundle.metadata.model !== 'Xenova/dinov2-small' ||
      bundle.metadata.dimension !== index.dimension || bundle.report.dimension !== index.dimension ||
      releases.length !== index.count || bundle.report.referenceCount !== index.count) {
    throw new Error('Pilot export model, dimensions or row counts do not match');
  }

  const metadata = `${JSON.stringify({ schemaVersion: 1, releases }, null, 2)}\n`;
  const manifest = `${JSON.stringify({
    schemaVersion: 1,
    model: bundle.metadata.model,
    dtype: bundle.metadata.dtype,
    dimension: index.dimension,
    releaseCount: index.count,
    downloadBytes: indexBytes.byteLength + Buffer.byteLength(metadata),
    generatedAt: bundle.report.generatedAt,
    source: {
      type: 'long-tail-pilot',
      musicBrainzSeed: 240824,
      discogsMaxHave: 100,
      discogsMaxWant: 30,
    },
    shards: [{
      index: 'shard-000.bin',
      metadata: 'shard-000.json',
      count: index.count,
      bytes: indexBytes.byteLength,
    }],
  }, null, 2)}\n`;

  await mkdir(options.output, { recursive: true });
  await writeAtomic(path.join(options.output, 'shard-000.bin'), indexBytes);
  await writeAtomic(path.join(options.output, 'shard-000.json'), metadata);
  await writeAtomic(path.join(options.output, 'manifest.json'), manifest);
  process.stdout.write(`Wrote ${index.count} vinyl vectors (${indexBytes.byteLength} bytes) to ${options.output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
