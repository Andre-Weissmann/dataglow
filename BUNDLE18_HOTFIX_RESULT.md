# Bundle 18 Hotfix: DuckDB Worker Self-Host

## Bug report

After Bundle 18 published, interactive SQL in canvas/index.html failed. Live network showed a
successful `200` fetch of `/assets/duckdb/duckdb-browser.mjs` (self-host module), followed by CDN
attempts, followed by a worker crash:

```
error in duckdb worker: Uncaught NetworkError: Failed to execute 'importScripts' on
'WorkerGlobalScope': The script at 'https://esm.sh/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-browse...
```

The SQL UI status also got stuck on "Running..." or reported "No dataset loaded" even for queries
that should not need one, such as `SELECT 1`.

## Root cause

`canvas/index.html` is a standalone single-file document. It has no `<script type="importmap">`
of its own.

`assets/duckdb/duckdb-browser.mjs`, the module the self-host candidate dynamically imports, uses a
bare module specifier: `import * as u from "apache-arrow"`. That module's own code in turn needs
`tslib` and `flatbuffers` as bare specifiers too. The repository's root `index.html` already
declares an import map for exactly this reason, mapping all three specifiers to the vendored files
under `assets/duckdb/vendor/`. Root `index.html`'s module graph resolves correctly because of that
import map.

`canvas/index.html`, however, is a separate document and never inherited that import map. When the
canvas SQL engine's self-host candidate ran `import('./assets/duckdb/duckdb-browser.mjs')`, the
bare specifier `"apache-arrow"` could not resolve, and the dynamic `import()` threw a module
resolution `TypeError`. This is not a network failure, so it never shows up as a failed request in
devtools, which is consistent with the reported "200 duckdb-browser.mjs, then CDN attempts."

The canvas SQL loader's `try/catch` around each candidate swallowed that error and silently fell
through the candidate list: self-host -> jsDelivr -> unpkg -> esm.sh. esm.sh serves an ES-module
resource. `new Worker(bundle.mainWorker)` for an absolute, cross-origin esm.sh URL runs in classic
(non-module) worker mode by default, and the browser's `importScripts` call against an ES-module
resource fails, producing exactly the reported error.

This bug was not introduced by Bundle 18. `git diff 20fe3ea 4329c71 --stat` (Bundle 17 -> Bundle
18) shows canvas/index.html changed only for drill-floor archetype drills and the R Air-Gap
prebundle; none of that diff touches the SQL/DuckDB engine sections. The missing import map was a
pre-existing gap in Bundle 17's self-host work that surfaced once canvas's SQL Editor was
exercised again after the Bundle 18 publish.

A second, unrelated issue was found while investigating the "No dataset loaded" report: canvas's
two SQL runners (`svRunQuery` and `runSQL`) hard-blocked every query with `state.datasets.length ===
0`, even queries with no table reference at all, such as `SELECT 1`. DuckDB can answer that kind of
query from an empty in-memory database with zero datasets loaded, so the gate was stricter than the
engine actually requires.

## Fix

1. **Import map** - added a `<script type="importmap">` block to `canvas/index.html`, placed
   immediately after the `<meta charset="UTF-8">` tag at the very top of `<head>`, before every
   other inline script in the file, so it is registered before the first dynamic `import()` of
   `assets/duckdb/duckdb-browser.mjs` can run:

   ```json
   {
     "imports": {
       "apache-arrow": "./assets/duckdb/vendor/apache-arrow/Arrow.dom.mjs",
       "tslib": "./assets/duckdb/vendor/tslib/tslib.es6.mjs",
       "flatbuffers": "./assets/duckdb/vendor/flatbuffers/mjs/flatbuffers.js"
     }
   }
   ```

   This mirrors the import map root `index.html` already uses, so the self-host candidate resolves
   the same way in both documents. No new asset directory was created; all three paths point at the
   existing `assets/duckdb/vendor/` files.

2. **SQL dataset gate** - relaxed the hard "No dataset loaded" gate in both `svRunQuery()` and
   `runSQL()` in `canvas/index.html` so it only blocks a query when the query text contains a
   `FROM` keyword and no dataset is loaded. A table-free query like `SELECT 1` now runs immediately
   instead of being blocked before it ever reaches the engine. Queries that do reference a table
   still get the same helpful "No dataset loaded. Drop a file first." message when nothing is
   loaded.

3. **Integrity manifest** - `canvas/integrity.manifest.json`'s `canvasBytes` field was updated via
   `node scripts/check-canvas-integrity.mjs --update` to match the new file size. No tracked module
   hash changed, since both edits live outside every tracked `/* ---- from <path> ---- */` marker
   span.

No new dependency, asset directory, or third-party service was introduced. `assets/duckdb/` remains
the only self-host location.

## Files changed

- `canvas/index.html` - import map added; `svRunQuery()` and `runSQL()` dataset gates relaxed.
- `canvas/integrity.manifest.json` - `canvasBytes` re-recorded.
- `test/bundle18-hotfix-duckdb-worker-selfhost.test.mjs` - new test file (see below).

## Tests

Added `test/bundle18-hotfix-duckdb-worker-selfhost.test.mjs`, a static/pure-module test file (no
browser launch) with 19 assertions across four groups:

- **A. Shared candidate list** (`js/sql/duckdb-load-harden.js`) - self-host is first in
  `buildCandidateList()`; its `baseUrl`/`cdnUrl` are same-origin relative paths under
  `assets/duckdb/`, never a CDN; every candidate's worker/wasm paths stay on the same host as its
  main module; a manually built self-host bundle (mirroring what `duckdb-engine.js`/`sql-engine.js`/
  the canvas loader each do) never resolves to `esm.sh`, `jsdelivr`, or `unpkg`; `rewriteBundleUrl`
  is a no-op for a self-host URL against an esm.sh base.
- **B. Vendored artifacts on disk** - worker + wasm files exist for both `mvp` and `eh` bundles;
  the vendored `apache-arrow`, `tslib`, and `flatbuffers` files the import map points at actually
  exist; `duckdb-browser.mjs` really does bare-import `apache-arrow` (so the test would fail if that
  assumption ever changes upstream); no worker file bakes in a hardcoded CDN URL.
- **C. canvas/index.html fix** - exactly one import map script tag exists; it resolves all three
  bare specifiers to the correct vendored paths; it appears before every other inline script; the
  canvas loader's own manual bundle builder never points a worker or wasm URL at esm.sh; both SQL
  runners no longer hard-block a table-free query; the helpful message still exists for queries that
  truly need a table; no em dash was introduced in the edited regions.
- **D. Manifest consistency** - `canvasBytes` in `canvas/integrity.manifest.json` matches the actual
  file size.

Result: `node --test test/bundle18-hotfix-duckdb-worker-selfhost.test.mjs` -> 19 passed, 0 failed.

## Regression check

Ran the full `test/` directory before and after this change (`node --test test/`):

- Before (base commit `4329c71`): 903 passed / 59 failed (plus the new test file, added in this
  branch, which correctly failed against the unfixed canvas).
- After (this branch, fix applied): 903 passed / 59 failed, plus the new test file now passing (19/19).

The 59 pre-existing failures are identical in both runs (for example `test/node-duckdb-engine.mjs`
fails in both because the optional `@duckdb/node-api` package is not installed in this environment,
and `\#8 Server offload (opt-in only)` fails in both for reasons unrelated to this hotfix). This
change introduces zero new regressions.

`node scripts/check-canvas-integrity.mjs` passes cleanly: syntax, markers, all 66 tracked modules,
both ship-path guards, and the recorded byte count.

## Sources consulted

- Bundle history and diff: local git log/diff (`20fe3ea` Bundle 17, `4329c71` Bundle 18) in this
  repository workspace.
- MDN, for confirming import map and classic-vs-module Worker/`importScripts` behavior referenced in
  the root cause reasoning: [Using JavaScript modules - import maps (MDN)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules#import_maps), [Worker() constructor (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker), [WorkerGlobalScope: importScripts() (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/importScripts).
