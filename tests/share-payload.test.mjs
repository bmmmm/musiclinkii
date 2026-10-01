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

// Comments are removed from the whole file before anything is parsed: they can
// hold an unbalanced brace that truncates a payload, or hide a key from the
// checks below. Strings are collapsed at the same time, so a `//` or a `}`
// inside one cannot pose as syntax either. Doing it once, up front, is what
// keeps the two passes from disagreeing about where a literal ends.
// Comments and strings are removed in ONE left-to-right pass, not by two
// regex sweeps. Sweeping cannot work: a `/*` sitting inside a line comment
// pairs up with a later `*/` and swallows whatever is between them — a
// two-line way to hide a title from every check below (verified 2026-09-08).
// A scanner knows which context it is in, so nothing can pose as syntax from
// inside another. Regex literals in the source are not tracked; they would
// only ever produce a false red, never a false green.
function scan(source, { collapseStrings }) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    if (pair === '//') {
      while (index < source.length && source[index] !== '\n') index += 1;
      out += ' ';
    } else if (pair === '/*') {
      index += 2;
      while (index < source.length && source.slice(index, index + 2) !== '*/') index += 1;
      index += 2;
      out += ' ';
    } else if (pair[0] === '"' || pair[0] === "'" || pair[0] === '`') {
      const quote = source[index];
      const opened = index;
      index += 1;
      while (index < source.length && source[index] !== quote) index += (source[index] === '\\' ? 2 : 1);
      index += 1;
      const raw = source.slice(opened, index);
      // A template literal keeps its `${…}` shape so a name built from one
      // stays recognisable; other strings collapse to a harmless placeholder.
      out += collapseStrings
        ? (quote === '`' ? '`' + raw.slice(1, -1).replace(/[^.\w${}]/g, '') + '`' : quote + 'S' + quote)
        : raw;
    } else {
      out += source[index];
      index += 1;
    }
  }
  return out;
}

const stripComments = (source) => scan(source, { collapseStrings: false });
const normalize = (source) => scan(source, { collapseStrings: true });

// Every object literal passed to navigator.share(...) / canShare(...), found by
// counting braces. ALL of them — a second, later call is exactly how a rejected
// payload gets reintroduced while the first one still looks correct.
function sharePayloads(source, text) {
  const found = [];
  const call = /navigator\s*(?:\.\s*(?:can)?[Ss]hare|\[\s*['"`](?:can)?[Ss]hare['"`]\s*\])\s*\??\.?\(\s*\{/g;
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

const PAYLOADS = SOURCES.flatMap((source) => sharePayloads(source, normalize(readFileSync(new URL(source, root), 'utf8'))));

// A key counts whether it is written out (`url: location.href`), quoted
// (`'text': q`) or passed as a shorthand (`{ …, url }`) — the shorthand form is
// how `text` and `url` slipped past an earlier version of these checks. The
// literal arrives already normalized, so no comment or string can hide a key.
const hasKey = (literal, key) => new RegExp(`[{,]\\s*['"\`]?${key}['"\`]?\\s*[:,}]`).test(literal);

// Reading keys out of source text can only judge keys that are written there.
// A spread or a computed key moves them somewhere this file cannot follow, and
// the honest answer is to refuse the payload rather than to call it clean —
// `share({ files, ...meta })` reintroduces the 2026-09-07 bug in one line.
function assertReadable(source, literal) {
  assert.doesNotMatch(literal, /\.\.\./,
    `${source}: a spread hides what this payload really carries — inline the keys so the rules below can see them`);
  assert.doesNotMatch(literal, /[{,]\s*\[/,
    `${source}: a computed key hides what this payload really carries — write the key literally`);
}

// Only a literal argument can be read here. A payload handed over as a variable
// is invisible to every rule below, and the anti-vacuity brake does not save us
// because the canShare() guard next to it already carries a `files` literal.
test('every share call passes its payload as a literal', () => {
  for (const source of SOURCES) {
    const text = normalize(readFileSync(new URL(source, root), 'utf8'));
    for (const [call] of text.matchAll(/navigator\s*(?:\.\s*(?:can)?[Ss]hare|\[[^\]]*\])\s*\??\.?\(\s*[^{\s)]/g)) {
      assert.fail(`${source}: ${call.trim()}… hands share() a value this check cannot read. Inline the object literal.`);
    }
  }
});

test('the repo actually shares something — this check cannot pass on an empty set', () => {
  assert.ok(PAYLOADS.length > 0, 'no navigator.share payload found; the check below would be vacuously green');
  assert.ok(PAYLOADS.some((p) => hasKey(p.literal, 'files')),
    'no file share found. If the payload was hoisted into a variable, inline it again so the rules below can see it; ' +
    'only delete this test if the file export itself is gone.');
  assert.ok(PAYLOADS.some((p) => hasKey(p.literal, 'url')),
    'no link share found — the link-share rule below would be vacuously green');
});

test('a share payload carrying files carries nothing else', () => {
  for (const { source, literal } of PAYLOADS) {
    assertReadable(source, literal);
    if (!hasKey(literal, 'files')) continue;
    for (const key of ['title', 'text', 'url']) {
      assert.ok(!hasKey(literal, key),
        `${source}: share({ files, ${key} }) lets the target app keep the ${key} string and drop the file — ` +
        'the user gets a message instead of a report, and share() still resolves. Share the file alone.');
    }
  }
});

// The same "one item, not two" rule without files: WKShareSheet.mm appends
// `text` as its own NSString item and the URL as a second one, so a target app
// that keeps the string drops the link. A link share names itself through
// `title` — WebKit uses it as the URL item's metadata title — and never
// competes with itself through `text`.
test('a link share does not compete with itself', () => {
  for (const { source, literal } of PAYLOADS) {
    if (hasKey(literal, 'files') || !hasKey(literal, 'url')) continue;
    assert.ok(!hasKey(literal, 'text'),
      `${source}: share({ text, url }) offers the target app two items; an app that keeps the text sends no link. Put the wording in title.`);
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

test('every shared file has an extension and a MIME type the browsers accept', () => {
  // Comments only: this check reads actual string values, which normalize() collapses.
  const page = stripComments(readFileSync(new URL('vinyl-test/page.mjs', root), 'utf8'));

  // EVERY binding any share payload sends, not just the first: a second call
  // added later as a fallback is exactly how the rejected form comes back.
  const bindings = [...page.matchAll(/navigator\.share\(\{\s*files:\s*\[(\w+)\]/g)].map((m) => m[1]);
  assert.ok(bindings.length > 0, 'could not find any file passed to navigator.share');

  // Resolve an expression to a string: a literal directly, an identifier by
  // looking up EVERY binding of that name. All of them have to be acceptable —
  // taking the first would let a decoy assignment elsewhere answer for the real
  // one, and a conditional reassignment would never be looked at.
  const literals = (expression) => {
    const direct = expression.match(/^[`'"](.*)[`'"]$/);
    if (direct) return [direct[1]];
    if (!/^\w+$/.test(expression)) return [];
    return [...page.matchAll(new RegExp(`\\b${expression}\\s*[:=]\\s*[\`'"]([^\`'"]*)[\`'"]`, 'g'))].map((m) => m[1]);
  };

  let checked = 0;
  for (const binding of new Set(bindings)) {
    // Every construction of that binding, so a later reassignment counts too.
    const builds = [...page.matchAll(new RegExp(
      `\\b${binding}\\s*[:=]\\s*new File\\(\\s*\\[[^\\]]*\\]\\s*,\\s*([^,]+?)\\s*,\\s*\\{\\s*type:\\s*'([^']*)'`, 'g'))];
    assert.ok(builds.length > 0,
      `${binding} must be built as new File([body], <name>, { type: '…' }) — the test reads both arguments from that call, ` +
      'so a helper or a variable type puts the share beyond what can be checked here');

    for (const [, nameExpression, type] of builds) {
      assert.ok(ALLOWED_TYPES.has(type),
        `share file type "${type}" is outside the browsers' share allowlist; Android rejects it with NotAllowedError after canShare() said yes`);

      const names = literals(nameExpression);
      assert.ok(names.length > 0,
        `cannot resolve the shared file's name from "${nameExpression}" — Chromium checks the extension independently of the MIME type, so it has to be readable here`);
      for (const name of names) {
        const extension = name.split('.').pop().toLowerCase();
        assert.ok(ALLOWED_EXTENSIONS.has(extension),
          `share file extension ".${extension}" (from ${nameExpression} = "${name}") is outside the allowlist — ` +
          'extension and MIME type are checked independently, so text/plain under a .json name still fails');
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, 'no name/type pair was actually measured');
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
