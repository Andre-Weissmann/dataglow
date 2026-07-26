# Bundle 18 Hotfix 2: DuckDB-WASM Absolute Self-Host Paths

## Bug report

After the Bundle 18 import-map hotfix ([#609](https://github.com)), Playwright proved the
DuckDB-WASM self-host mjs, apache-arrow, and worker files all loaded with a `200`. The wasm file
did not. The network panel showed the request URL doubled:

```
/assets/duckdb/assets/duckdb/duckdb-eh.wasm  ->  404
```

The SQL Editor then failed every query with:

```
Cannot read properties of null (reading 'query')
```

because `instantiate()` never completed, and the page console showed:

```
pageerror: Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok
```

## Root cause

`SELF_HOST_BASE_URL` in `js/sql/duckdb-load-harden.js` was a relative path, `'./assets/duckdb/'`.
That module is the single shared source the SQL Editor engine (`js/sql/sql-engine.js`), the
canvas-inlined loader, and `js/app-shell/duckdb-config.js`'s neighbor `duckdb-engine.js` all read
from.

The DuckDB-WASM worker script itself is served from `/assets/duckdb/duckdb-browser-eh.worker.js`.
Once that worker starts running, it resolves the `mainModule` (wasm) path it was handed relative to
**its own script location**, not the page's. A relative base of `./assets/duckdb/` handed to code
already executing from inside `/assets/duckdb/` resolves one more `assets/duckdb/` segment deeper,
landing on the doubled, 404ing path reported above. This is a classic relative-URL resolution bug:
the same string resolves differently depending on who resolves it, and the worker and the page did
not agree.

The failure only appeared for the **wasm** URL and not the `.mjs` module, apache-arrow, or the
worker script itself, because those are all fetched by the *page* (via `import()` and `new
Worker()`, both of which resolve against the document), while the wasm path is read by
`db.instantiate()` running *inside* the worker.

## Fix

Root-absolute paths everywhere the self-host base is used, plus a defensive
resolve-before-use pattern at every `Worker`/`instantiate()` call site so page and worker can never
disagree even if a future candidate ships a relative base again.

1. **`js/sql/duckdb-load-harden.js`** (the one shared pin list read by both surfaces):
   - `SELF_HOST_BASE_URL` changed from `'./assets/duckdb/'` to `'/assets/duckdb/'`.
   - Added `resolveSelfHostBaseUrl(href)`, a pure helper that resolves the root-absolute path via
     `new URL(SELF_HOST_BASE_URL, href || globalThis.location?.href || 'http://localhost/')`, for
     any caller that needs an origin-qualified absolute URL instead of a root-absolute one. Proven
     in tests to resolve to the *identical* URL whether the caller passes a page href or a
     worker-script href already inside `/assets/duckdb/`.

2. **`js/sql/sql-engine.js`** (`ensureInit()`): the `Worker` is now constructed from an absolute
   URL, `new URL(bundle.mainWorker, location.href).href` when `bundle.mainWorker` is not already
   absolute, and `bundle.mainModule` is resolved the same way before being passed to
   `db.instantiate()`.

3. **`canvas/index.html`** (canvas is authoritative for the canvas surface):
   - The tracked inline splice of `js/sql/duckdb-load-harden.js` was re-injected from the updated
     source (`resync_duckdb_load_harden.py`, the same IIFE-wrap transform `inject_bundle15.py`
     originally used), so its `SELF_HOST_BASE_URL` and new `resolveSelfHostBaseUrl()` are
     byte-consistent with the `js/` source.
   - The canvas loader's own manual fallback candidate list constant, `DUCKDB_SELF_HOST_BASE`,
     changed from `'./assets/duckdb/'` to `'/assets/duckdb/'`.
   - The canvas loader's `Worker`/`instantiate()` call site now resolves both `bundle.mainWorker`
     and `bundle.mainModule` to absolute URLs via a small local `_dgAbsUrl(u)` helper
     (`new URL(u, location.href).href` when `u` is not already absolute) before use.
   - `canvas/integrity.manifest.json` was re-recorded (`node scripts/check-canvas-integrity.mjs
     --update`) for the new tracked-module hash and file size.

4. **CDN fallbacks are untouched.** jsDelivr, unpkg, and esm.sh remain absolute `https://` URLs,
   tried in the same order after self-host, in both `js/sql/duckdb-load-harden.js` and the canvas
   loader's manual fallback list.

## Exact path change

| Location | Before | After |
|---|---|---|
| `js/sql/duckdb-load-harden.js` `SELF_HOST_BASE_URL` | `./assets/duckdb/` | `/assets/duckdb/` |
| `js/sql/duckdb-load-harden.js` `SELF_HOST_CANDIDATE.cdnUrl` | `./assets/duckdb/duckdb-browser.mjs` | `/assets/duckdb/duckdb-browser.mjs` |
| resolved `mainModule` (eh) | `./assets/duckdb/duckdb-eh.wasm` (doubles to `/assets/duckdb/assets/duckdb/duckdb-eh.wasm` when resolved by the worker) | `/assets/duckdb/duckdb-eh.wasm` (identical whether resolved by page or worker) |
| resolved `mainModule` (mvp) | `./assets/duckdb/duckdb-mvp.wasm` | `/assets/duckdb/duckdb-mvp.wasm` |
| canvas `DUCKDB_SELF_HOST_BASE` | `./assets/duckdb/` | `/assets/duckdb/` |

## Tests

Added `test/bundle18-hotfix2-wasm-absolute-paths.test.mjs`, a static/pure-module test file (no
browser launch), 18 assertions across five groups:

- **A. `js/sql/duckdb-load-harden.js`** - `SELF_HOST_BASE_URL` is root-absolute, not relative;
  `SELF_HOST_CANDIDATE` cdnUrl/baseUrl are both root-absolute with exactly one `assets/duckdb/`
  segment; manually built mvp/eh bundles from the self-host base never double the path;
  `resolveSelfHostBaseUrl()` agrees for a page-origin href and a worker-origin href already inside
  `assets/duckdb/`; `resolveSelfHostBaseUrl()` never throws under plain Node; CDN fallbacks are
  untouched (still absolute `https://`, still ordered after self-host).
- **B. `js/sql/sql-engine.js`** - the Worker is constructed from an absolute URL; `mainModule` is
  resolved to an absolute URL before `instantiate()`; no em dash introduced.
- **C. `canvas/index.html`** - the tracked splice carries the root-absolute base and the new
  resolver; the manual fallback candidate list is root-absolute; the loader resolves worker and
  mainModule to absolute URLs before use; no doubled `assets/duckdb/assets/duckdb` path pattern
  exists anywhere in the file; CDN fallback candidates in the manual list are unchanged; no em dash
  introduced.
- **D. Manifest consistency** - `canvasBytes` matches the actual file size; the
  `js/sql/duckdb-load-harden.js` manifest hash matches the current source file.
- **E. Residual documentation** - this file documents the COOP/COEP residual (below).

Result: `node --test test/bundle18-hotfix2-wasm-absolute-paths.test.mjs` -> 18 passed, 0 failed.

Updated `test/bundle18-hotfix-duckdb-worker-selfhost.test.mjs` (the prior hotfix's proof file):
three of its assertions asserted the *old* relative-path shape (`^\./assets\/duckdb\/$`) and needed
updating to the new root-absolute shape; one candidate-host-comparison helper needed to stop
assuming a leading `.` meant same-origin (root-absolute paths do not start with `.`). Added one new
assertion proving `resolveSelfHostBaseUrl()` exists and resolves correctly. All 20 assertions in
that file now pass against the new fix.

## Regression check

Ran the full `test/` directory before and after this change (`node --test test/`):

- Both before and after: the only pre-existing, unrelated failure is `#8 Server offload (opt-in
  only)` in `test/chore-duckdb-hardening.test.mjs` (a `serverOffload` flag default check unrelated
  to DuckDB loading paths, already noted as failing in both directions in the prior hotfix's
  result doc).
- `test/bundle18-hotfix-duckdb-worker-selfhost.test.mjs`: 20/20 passing (after the 3 assertion
  updates described above).
- `test/bundle18-hotfix2-wasm-absolute-paths.test.mjs` (new): 18/18 passing.
- `test/bundle15-duckdb-harden-ledger-spine-replay-dojo.test.mjs`: 40/40 passing, unaffected.

`node scripts/check-canvas-integrity.mjs` passes cleanly: syntax, markers, all 66 tracked modules,
both ship-path guards, and the recorded byte count.

## Residual: COOP/COEP and S3 redirects (documented, not fixed here)

This hotfix fixes the path-doubling bug, which is a same-origin relative-URL resolution defect
present regardless of hosting platform. It does **not** address, and this fix does not depend on:

- **COOP/COEP headers.** DuckDB-WASM's multi-threaded (`eh`) build needs `SharedArrayBuffer`, which
  requires `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
  require-corp` on every response (see `DEPLOY.md`, section "#4 - COOP/COEP for DuckDB
  multi-threading"). Without these headers, `crossOriginIsolated` is `false` and DuckDB-WASM falls
  back to the single-threaded `mvp` bundle automatically (see
  `js/app-shell/duckdb-config.js#isCrossOriginIsolated`). This is a documented, working fallback,
  not a crash, and is unrelated to the wasm URL doubling this hotfix fixes.
- **S3 (or any object-storage/CDN) redirect behavior.** If DataGlow is deployed behind an S3
  bucket, CloudFront, or similar origin that issues redirects for asset paths (for example a
  trailing-slash normalization or a signed-URL redirect), a root-absolute `/assets/duckdb/...`
  path assumes the deploy is served from a domain root with no such redirect in front of
  `/assets/duckdb/`. If a future deploy target puts DataGlow behind a sub-path or a redirecting
  CDN in front of `assets/duckdb/`, the fix to reach for is
  `resolveSelfHostBaseUrl(globalThis.location.href)` (added in this hotfix, currently unused by
  default) at the call sites, which resolves against the actual runtime origin instead of assuming
  a bare root-absolute path is always correct. That change was not made unconditionally here
  because the repository's actual deploy targets (`DEPLOY.md`, `dataglow-live-publish`) all serve
  from a domain root today, and switching every call site to `resolveSelfHostBaseUrl()`
  unconditionally is a larger, separable change from this hotfix's scope (fixing the reported
  doubling with the smallest safe diff).

Both residuals are pre-existing operational/hosting concerns, not regressions introduced by this
change, and are called out here rather than silently left undocumented.

## Sources consulted

- MDN, for confirming relative URL resolution inside a Worker resolves against the worker's own
  script location, not the creating document's: [Worker() constructor (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker),
  [URL() constructor (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/URL/URL).
- This repository's `DEPLOY.md` for the existing COOP/COEP header requirements.
- `js/app-shell/duckdb-config.js` (`isCrossOriginIsolated`, `coiDiagnostic`) for the existing,
  already-shipped single-threaded fallback behavior when cross-origin isolation is not active.
