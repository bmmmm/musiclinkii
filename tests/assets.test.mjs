// SPDX-License-Identifier: GPL-3.0-or-later
// index.html is the one hand-maintained file the deploy depends on: every
// asset reference must carry the ?v=dev placeholder the pages workflow
// stamps with the commit SHA. An unversioned reference deploys silently
// and only shows up as a stale stylesheet or a mixed module chain in a
// user's browser, so it is checked here — the test job gates the deploy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');

// The entry point is loaded by <script src>, everything else through the
// import map — derived from disk so a new module cannot slip through.
const MODULES = readdirSync(new URL('js/', root)).filter((f) => f.endsWith('.mjs'));
const ENTRY = 'app.mjs';

test('every js module is versioned: entry via <script src>, rest via the import map', () => {
  assert.ok(MODULES.includes(ENTRY), 'js/app.mjs is the documented entry point');
  assert.match(html, new RegExp(`<script type="module" src="js/${ENTRY}\\?v=dev"`),
    'the entry script must be loaded with the ?v=dev placeholder');

  for (const mod of MODULES.filter((m) => m !== ENTRY)) {
    assert.match(html, new RegExp(`"\\./js/${mod}": "\\./js/${mod}\\?v=dev"`),
      `js/${mod} needs an import map entry — without one it ships unversioned`);
  }
});

test('the stylesheet is versioned too', () => {
  assert.match(html, /<link rel="stylesheet" href="css\/style\.css\?v=dev">/,
    'css/style.css must carry ?v=dev, or a deploy can serve new HTML with old CSS');
});

// The workflow refuses to deploy when it finds fewer than 8 placeholders
// (see .github/workflows/pages.yml). Keep that floor honest here so the
// mismatch surfaces in a local test run, not in a failed deploy.
test('placeholder count matches what the deploy workflow expects', () => {
  const found = html.match(/\?v=dev/g)?.length ?? 0;
  assert.equal(found, MODULES.length + 1, // every module + the stylesheet
    `expected ${MODULES.length + 1} ?v=dev references, found ${found}`);
  assert.ok(found >= 8, 'the pages workflow hard-fails below 8');
});

test('no hand-bumped version survives — ?v=dev is the only form', () => {
  const stray = [...html.matchAll(/\?v=([^"']+)/g)].map((m) => m[1]).filter((v) => v !== 'dev');
  assert.deepEqual(stray, [], 'versions are stamped at deploy time, never by hand');
});
