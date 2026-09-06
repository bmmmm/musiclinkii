# AGENTS.md — working on musiclinkii

Condensed rules for coding agents. User-facing detail and rationale:
`README.md`; endpoint contracts: `ENDPOINTS.md`.

## Commands

```sh
python3 -m http.server 8000        # serve the repo root → http://localhost:8000
node --test 'tests/*.test.mjs'     # full suite; gates the Pages deploy
node scripts/build-vinyl-index-assets.mjs --input .cache/vinyl-benchmark/pilot-export.json
node scripts/evaluate-vinyl-test-report.mjs --input <report.json> [--heldout .cache/vinyl-heldout]
```

## Map

- `index.html` + `js/app.mjs` — the app. `app.mjs` is DOM orchestration
  around one commit path and exports nothing; it is not importable.
- `js/parsers.mjs`, `links.mjs`, `cards.mjs` — pure link parsing, platform
  registry and card models; unit-tested.
- `js/adapters.mjs`, `enrich.mjs`, `cache.mjs` — keyless metadata lookups
  (Deezer JSONP, iTunes, MusicBrainz through one ~1 req/s queue) and the
  localStorage result cache.
- `js/vinyl-scan.mjs`, `visual-match.mjs`, `vinyl-index.mjs`,
  `vector-index.mjs` — vinyl cover pipeline: OCR, DINOv2 rerank, static Int8
  index under `assets/vinyl-index/`.
- `benchmarks/vinyl/` — retrieval benchmark and spikes; `vinyl-test/` —
  unlisted phone test page; `scripts/` — Node build and evaluation tools;
  `docs/vinyl-index-plan.md` — the index roadmap.

## Traps

- No bundler, no `package.json`. `index.html` loads `js/app.mjs` by
  `<script>` and every other `js/*.mjs` through the import map with `?v=dev`;
  the Pages workflow stamps that marker. `tests/assets.test.mjs` fails on any
  `js/` module without an import-map entry. Code that is not part of the app
  (benchmarks, vinyl-test) lives outside `js/`, imports relatively and carries
  no `?v=`.
- Every `.mjs` starts with `// SPDX-License-Identifier: GPL-3.0-or-later`.
  Code, comments, strings and commits are English; only the `vinyl-test/` UI
  is German by decision.
- Images never leave the browser: OCR text and catalog thumbnails are the
  only things that cross the network. Keep the wording in `index.html`,
  `vinyl-test/` and README honest about what goes to Deezer.
- MusicBrainz throttling looks exactly like a regression (fewer exact
  matches). Look for 503s in the network log before debugging a diff.
- Cover images under `.cache/` are third-party and never committed; the repo
  ships only vectors and identifiers.
- Deploy is `git push` to `main` on both remotes (`origin` Forgejo, `github`);
  the test job gates the Pages deploy.

## Definition of done

1. `node --test 'tests/*.test.mjs'` green — run it, do not assume.
2. A UI or network change is proven in Chrome against `http.server`, not
   only in unit tests: pure modules get unit tests, the app has no DOM test
   harness.
3. A new `js/` module has its import-map entry in `index.html`; README and
   ENDPOINTS follow when commands or endpoints change.
4. `git diff --stat` checked for accidental `.cache/` or third-party image
   content before the push.
