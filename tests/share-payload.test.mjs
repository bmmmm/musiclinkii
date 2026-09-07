// SPDX-License-Identifier: GPL-3.0-or-later
// The Web Share API fails silently: navigator.share() resolves as soon as the
// sheet closes, whether or not the target app kept the attachment. On
// 2026-09-07 a vinyl-test report shared from a phone arrived as the bare
// string "musiclinkii Vinyl-Test" — the title had been passed alongside the
// file, the messenger took the string and dropped the file, and the page
// reported "Bericht geteilt." No runtime check can catch that, because the
// browser never tells the page what the target did. So the rule is enforced
// on the source: a share payload that carries files carries nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);

// Every hand-written source in the repo, walked from disk so neither a new
// module nor a new directory can dodge the check by being new. Only build
// output and third-party payloads are skipped.
// `tests` is skipped so this file's own regexes are not mistaken for a payload;
// test code never reaches a share sheet.
const SKIP = new Set(['.git', '.cache', 'node_modules', '.github', 'tests']);
function sources(directory = '', found = []) {
  for (const entry of readdirSync(new URL(directory, root), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const relative = `${directory}${entry.name}`;
    if (entry.isDirectory()) sources(`${relative}/`, found);
    else if (/\.(mjs|js|html)$/.test(entry.name)) found.push(relative);
  }
  return found;
}
const SOURCES = sources();

// The object literal passed to navigator.share(...) / navigator.canShare(...),
// extracted by counting braces so nested objects survive.
function sharePayloads(source, text) {
  const found = [];
  const call = /navigator\.(?:can)?[Ss]hare\??\.?\(\s*\{/g;
  let match;
  while ((match = call.exec(text)) !== null) {
    let depth = 1;
    let index = call.lastIndex;
    while (index < text.length && depth > 0) {
      if (text[index] === '{') depth += 1;
      else if (text[index] === '}') depth -= 1;
      index += 1;
    }
    found.push({ source, literal: text.slice(match.index, index) });
  }
  return found;
}

const PAYLOADS = SOURCES.flatMap((source) => sharePayloads(source, readFileSync(new URL(source, root), 'utf8')));

test('the repo actually shares something — this check cannot pass on an empty set', () => {
  assert.ok(PAYLOADS.length > 0, 'no navigator.share payload found; the check below would be vacuously green');
  assert.ok(PAYLOADS.some((p) => /\bfiles\s*:/.test(p.literal)),
    'no file share found. If the payload was hoisted into a variable, inline it again so the rules below can see it; ' +
    'only delete this test if the file export itself is gone.');
});

test('a share payload carrying files carries nothing else', () => {
  for (const { source, literal } of PAYLOADS) {
    if (!/\bfiles\s*:/.test(literal)) continue;
    for (const key of ['title', 'text', 'url']) {
      assert.doesNotMatch(literal, new RegExp(`\\b${key}\\s*:`),
        `${source}: share({ files, ${key} }) lets the target app keep the ${key} string and drop the file — ` +
        'the user gets a message instead of a report, and share() still resolves. Share the file alone.');
    }
  }
});

// Chromium's share allowlist lives in ShareServiceImpl.java and checks the
// file extension and the MIME type independently — a file passes only when
// both are listed. Neither "json" nor "application/json" is on it, so sharing
// a .json report rejects with NotAllowedError on Android. The check runs in
// the browser process, i.e. after canShare() has already returned true, so
// nothing at runtime warns about it. Only the subset this repo can plausibly
// export is listed here.
const ALLOWED_TYPES = new Set(['text/plain', 'text/csv', 'text/html', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['txt', 'text', 'csv', 'htm', 'html', 'pdf', 'png', 'jpg', 'jpeg', 'webp']);

test('the shared file has an extension and a MIME type the browsers accept', () => {
  const page = readFileSync(new URL('vinyl-test/page.mjs', root), 'utf8');
  // Which binding does the share payload actually send?
  const shared = page.match(/navigator\.share\(\{\s*files:\s*\[(\w+)\]/);
  assert.ok(shared, 'could not find the file passed to navigator.share');
  const binding = shared[1];

  // …and how is that binding built? Either `const x = new File(…)` or `x: new File(…)`.
  // Both arguments are read off the same construction: reading the name from a
  // separate constant would let a refactor pass the .json name into the share
  // file while the test still checked the unused .txt constant.
  const build = page.match(new RegExp(
    `${binding}\\s*[:=]\\s*new File\\(\\s*\\[[^\\]]*\\]\\s*,\\s*([^,]+?)\\s*,\\s*\\{\\s*type:\\s*'([^']+)'`));
  assert.ok(build, `${binding} must be built as new File([body], <name>, { type }) — the test reads both arguments from that call`);
  const [, nameExpression, type] = build;

  assert.ok(ALLOWED_TYPES.has(type),
    `share file type "${type}" is outside the browsers' share allowlist; Android rejects it with NotAllowedError after canShare() said yes`);

  // Resolve whatever expression that call passes as the name: a literal is read
  // directly, an identifier is looked up once. Anything else fails loudly —
  // an unresolvable name is exactly how a .json extension sneaks back in.
  const literal = (expression) => {
    const direct = expression.match(/^[`'"](.+)[`'"]$/);
    if (direct) return direct[1];
    if (!/^\w+$/.test(expression)) return null;
    const bound = page.match(new RegExp(`\\b${expression}\\s*[:=]\\s*[\`'"]([^\`'"]+)[\`'"]`));
    return bound ? bound[1] : null;
  };
  const shareName = literal(nameExpression);
  assert.ok(shareName,
    `cannot resolve the shared file's name from "${nameExpression}" — Chromium checks the extension independently of the MIME type, so it has to be readable here`);
  const extension = shareName.split('.').pop().toLowerCase();
  assert.ok(ALLOWED_EXTENSIONS.has(extension),
    `share file extension ".${extension}" is outside the allowlist — extension and MIME type are checked independently, so text/plain under a .json name still fails`);
});

test('a resolved file share is never reported as a delivered file', () => {
  const page = readFileSync(new URL('vinyl-test/page.mjs', root), 'utf8');
  // The then() handler after a file share must not claim the share worked.
  const handler = page.match(/navigator\.share\(\{\s*files[\s\S]*?\.then\(([\s\S]*?)\)\n/);
  assert.ok(handler, 'the file share must keep a then() handler that reports what actually happened');
  assert.doesNotMatch(handler[1], /geteilt\.|Bericht geteilt|erfolgreich/,
    'share() resolves when the sheet closes, not when the file arrives — the wording must send the user to check');
  assert.match(handler[1], /Prüfe|prüfe/,
    'the message must ask the user to verify the attachment in the target app');
});
