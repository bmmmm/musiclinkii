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
const app = readFileSync(new URL('js/app.mjs', root), 'utf8');
const vinylScan = readFileSync(new URL('js/vinyl-scan.mjs', root), 'utf8');

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

test('image paste waits for a user paste event instead of requesting clipboard access', () => {
  assert.doesNotMatch(`${app}\n${vinylScan}`, /navigator\.clipboard\??\.read/);
  assert.match(html, /id="scan-paste"[\s\S]*press ⌘V or Ctrl\+V/i);
});

test('the homepage offers three primary input modes with explicit text-search formats', () => {
  assert.match(html, /id="search-mode-toggle"[\s\S]*data-mode="url"[\s\S]*data-mode="search"[\s\S]*data-mode="vinyl"/);
  assert.match(html, /id="url-search"[\s\S]*placeholder="Paste a music URL"/);
  assert.match(html, /Artist \+ song[\s\S]*data-kind="album"[\s\S]*>Album</);
  assert.match(html, /id="search-format"[^>]*>Format: Artist — Song/);
  assert.doesNotMatch(html, /id="open-search"|id="open-vinyl-scan"/);
  assert.match(app, /function setInputMode\(mode/);
});

test('the scanner offers every DINOv2 size with download, storage state and deletion', () => {
  assert.match(html, /Small — 15\.0 MB · fastest/);
  assert.match(html, /Base — 56\.4 MB · recommended/);
  assert.match(html, /Large — 194\.1 MB · highest detail/);
  assert.match(html, /id="visual-model-details"/);
  assert.match(html, /id="visual-model-url"/);
  assert.match(html, /id="visual-model-state"/);
  assert.match(html, /id="download-visual-model"[\s\S]*Download model/);
  assert.match(html, /id="delete-visual-model"[\s\S]*Delete local model/);
  assert.match(app, /Search the local 12-cover pilot \(uses Small\)/);
});

// A .btn variant and .btn itself have the same specificity, so the later rule
// wins. .btn-go once sat above .btn and its gradient was silently overridden by
// .btn's background — every primary action rendered as a secondary one, and
// nothing but a screenshot could show it. The rule is therefore: a variant must
// follow EVERY .btn rule, not merely the first one found. Anchoring on the
// first would let a harmless decoy `.btn {}` earlier in the file re-open the
// exact hole this guards.
test('every .btn variant is declared after every .btn rule', () => {
  const css = readFileSync(new URL('css/style.css', root), 'utf8');
  // Comments out of the way first, then every selector list with its offset.
  // Offsets are only ever compared with each other, so the shift is harmless.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...clean.matchAll(/([^{}]+)\{/g)]
    .map((m) => ({ index: m.index, parts: m[1].split(',').map((part) => part.trim()).filter(Boolean) }));

  const bases = rules.filter((rule) => rule.parts.includes('.btn'));
  const variants = rules.flatMap((rule) => rule.parts
    .filter((part) => /^\.btn-[\w-]+$/.test(part))
    .map((part) => ({ index: rule.index, name: part })));

  assert.ok(bases.length > 0, 'no rule whose selector list contains exactly ".btn" — the base rule was renamed or reshaped, not deleted');
  assert.ok(variants.length >= 4, `expected the known .btn- variants, found ${variants.length}`);

  const lastBase = Math.max(...bases.map((base) => base.index));
  for (const variant of variants) {
    assert.ok(variant.index > lastBase,
      `${variant.name} is declared before a .btn rule — same specificity, so .btn wins and this variant renders as a plain button`);
  }
});

// --- Contrast on the accent gradient.
//
// White on that gradient measures 2.14-4.51:1 across the two palettes and
// misses AA everywhere. Checking that the rules *mention* --accent-ink would
// only test spelling: the token could be redefined to #fff and every button
// would still read as compliant. So compute the real thing — resolve each
// gradient surface's text colour and measure it against every stop of the
// gradient, in both palettes. What is asserted is legibility, not wording.
const srgb = (channel) => (channel /= 255, channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// The two palettes: bare :root, then whatever the dark block overrides.
function palettes(css) {
  const tokens = (block) => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {'))));
  const darkBlock = css.slice(css.indexOf('prefers-color-scheme: dark'));
  return { light, dark: { ...light, ...tokens(darkBlock.slice(0, darkBlock.indexOf('\n  }'))) } };
}

const resolve = (value, palette) => {
  const token = value.match(/var\((--[\w-]+)\)/);
  const hex = (token ? palette[token[1]] : value.trim());
  return /^#[0-9a-f]{6}$/i.test(hex || '') ? rgbOf(hex) : null;
};

test('every text colour on the accent gradient clears AA in both palettes', () => {
  const css = readFileSync(new URL('css/style.css', root), 'utf8');
  const themes = palettes(css);
  assert.ok(themes.light['--accent'] && themes.dark['--accent'], 'both palettes must define the accent colours');

  // The stylesheet plus every inline <style> block: a page-local rule paints
  // the same buttons and would otherwise never be looked at.
  const inline = ['index.html', 'vinyl-test/index.html']
    .flatMap((page) => [...readFileSync(new URL(page, root), 'utf8').matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]));
  const allCss = [css, ...inline].join('\n');

  // Any rule whose background is an accent gradient, however it is written.
  const surfaces = [...allCss.matchAll(/\{[^{}]*\}/g)]
    .map(([block]) => block)
    .filter((block) => /linear-gradient\([^)]*--accent/.test(block));
  assert.ok(surfaces.length >= 4, `expected the accent-gradient surfaces, found ${surfaces.length}`);

  let checked = 0;
  for (const block of surfaces) {
    const stopNames = [...block.matchAll(/var\((--accent(?:-2)?)\)/g)].map((m) => m[1]);
    // Every declaration that can paint glyphs; the last one wins, as in CSS.
    const inks = [...block.matchAll(/(?:^|[;{])\s*(?:-webkit-text-fill-color|color)\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
    const ink = inks.at(-1);
    if (!ink || ink === 'transparent') continue; // the logo clips the gradient into the glyphs
    for (const [name, palette] of Object.entries(themes)) {
      const text = resolve(ink, palette);
      assert.ok(text, `cannot resolve text colour "${ink}" — an unresolvable colour cannot be proven legible`);
      const stops = stopNames.map((token) => resolve(`var(${token})`, palette));
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        for (let i = 0; i + 1 < stops.length; i += 1) {
          const ratio = contrast(text, mix(stops[i], stops[i + 1], t));
          assert.ok(ratio >= 4.5,
            `${name} palette: "${ink}" on the accent gradient measures ${ratio.toFixed(2)}:1 at stop ${t} — AA needs 4.5. ` +
            'Use var(--accent-ink), and if that is what this already is, the token itself has drifted too light.');
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked >= 40, `only ${checked} contrast pairs measured — the surfaces stopped being found`);
});
