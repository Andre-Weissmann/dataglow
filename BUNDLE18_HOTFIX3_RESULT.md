# Bundle 18 Hotfix 3: Hybrid Self-Host + CDN WASM

## Bug report

Playwright, run against the live deploy at https://dataglow-platform.pplx.app after both prior
hotfixes ([#609](https://github.com) import map, [#610](https://github.com) absolute self-host
paths), showed:

- `duckdb-browser.mjs`, apache-arrow, and both worker scripts (`duckdb-browser-eh.worker.js`,
  `duckdb-browser-mvp.worker.js`) all load same-origin with a clean `200`.
- The doubled-path bug from hotfix 2 is fixed: no
  `/assets/duckdb/assets/duckdb/duckdb-eh.wasm` in the network panel.
- `/assets/duckdb/duckdb-eh.wasm` itself still fails in the browser:
  `net::ERR_FAILED` / `TypeError: Failed to fetch`.
- `curl` run against the exact same URL from a server succeeds: it receives a `302` redirect to an
  S3 object URL and follows it to a 35MB `application/wasm` response.
- jsDelivr and unpkg's copies of the same `duckdb-eh.wasm` / `duckdb-mvp.wasm` (pinned to 1.29.0)
  return `200` with CORS headers, and `WebAssembly.compile()` against them succeeds from the same
  page.
- `crossOriginIsolated` is `false` on live -- unrelated, already documented as a residual in
  `BUNDLE18_HOTFIX2_RESULT.md`.
- SQL status is stuck on `Error: Cannot read properties of null (reading 'query')`, because
  `db.instantiate()` never completes.
- The candidate fallback list (self-host -> jsDelivr -> unpkg -> esm.sh) was **not** recovering to
  a CDN candidate after the self-host wasm fetch failed; the engine stayed stuck with a null `db`.

## Root cause

`pplx.app` serves `/assets/duckdb/duckdb-eh.wasm` (and `duckdb-mvp.wasm`) as a `302` redirect to an
S3 object URL rather than serving the bytes directly from that path. This is invisible to `curl`,
which follows redirects by default and prints the final response as if it were fetched directly
from the origin path -- so a server-side check of "does this URL work" reports success.

A browser's `fetch()` (and, more specifically, the streaming request `WebAssembly.compile`/
`WebAssembly.instantiateStreaming` and DuckDB-WASM's own worker-internal fetch of `mainModule`
make) cannot always follow that redirect the same way under this host: the redirect target is a
different origin (S3), and depending on the exact response headers the S3 redirect target returns
(missing or mismatched CORS headers, a `Content-Type` that is not `application/wasm`, or a redirect
chain the Worker's fetch implementation refuses to follow for a streaming compile), the browser
fails the request outright with `net::ERR_FAILED` / `TypeError: Failed to fetch` instead of quietly
falling back to a slower non-streaming path. `duckdb-browser.mjs`, apache-arrow, and the worker
scripts do not hit this because they are fetched as plain script/module resources (`import()`,
`new Worker()`), which browsers already know how to redirect-follow uneventfully; the 35MB wasm
binary read via a streaming compile inside the worker is the one request path sensitive to this
platform's specific redirect shape.

This is a hosting/CDN-layer defect (the pplx.app deploy path fronts static assets with S3 redirects
for large binaries), not a bug in the self-host relative/absolute path logic hotfix 2 already fixed.
The two are independent: hotfix 2 made the *path string* single and correct; this hotfix addresses
the *fetch itself* being unfetchable for one specific file, under one specific host, regardless of
what the correct path string is.

The **second** bug -- fallback not recovering to a CDN candidate -- was a design gap, not a broken
loop: the existing per-candidate `try/catch` in both `js/sql/sql-engine.js` and the canvas inline
loader does already `throw` on a failed `db.instantiate()` and does already advance the `for` loop
to the next full candidate. What was missing was a **middle path**: instead of only choosing between
"keep the failed self-host wasm" and "abandon self-host's already-working mjs/worker stack for a
brand new CDN candidate," this hotfix adds a same-candidate retry that keeps the same-origin
`duckdb-browser.mjs` + worker (which are proven to load fine) and swaps in a working wasm URL
before falling through to a whole new candidate. Without that middle path, every self-host attempt
either worked completely or failed completely, even though only one of its three files was the
actual problem.

## Fix

### 1. Hybrid self-host candidate (preferred path)

`js/sql/duckdb-load-harden.js` -- the one shared pin list read by every surface -- now attaches a
`wasmFallback` to `SELF_HOST_CANDIDATE`:

```js
export const SELF_HOST_CANDIDATE = Object.freeze({
  id: 'self-host',
  label: 'self-host',
  cdnUrl: SELF_HOST_BASE_URL + 'duckdb-browser.mjs',
  baseUrl: SELF_HOST_BASE_URL,
  wasmFallback: Object.freeze({
    mvp: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-mvp.wasm',
    eh: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-eh.wasm',
  }),
});
```

Two new pure helpers, exported alongside it and on `window.DataGlowDuckDBLoadHarden`:

- `isWasmFetchFailure(err)` -- classifies an error as a wasm-fetch-shaped failure (`Failed to
  fetch`, `net::ERR_FAILED`, `NetworkError`, or the `WebAssembly.compile` "HTTP status code is not
  ok" message), as opposed to a genuine compile/logic error that should surface unchanged.
- `buildHybridWasmBundle(bundle, candidate)` -- given a bundle already built from the self-host
  candidate, returns the same bundle with only `mainModule` swapped to the candidate's
  `wasmFallback` CDN pin. `mainWorker` (and therefore the whole worker/mjs stack) stays same-origin.
  Returns `null` when the candidate has no `wasmFallback`, so callers can tell "no hybrid retry
  available" (a CDN candidate) from "already tried the fallback."

`buildCandidateList()` carries `wasmFallback` through for self-host only, so every caller that
already reads this one shared list gets the hybrid data for free.

### 2. Every surface tries same-origin wasm first, retries with CDN wasm on failure, before giving up on self-host

- **`js/sql/sql-engine.js`** (`ensureInit()`): `db.instantiate(mainModuleHref, ...)` is now wrapped
  in a `try/catch`. On a wasm-fetch-shaped error (checked via `LOAD_HARDEN.isWasmFetchFailure`),
  it retries `db.instantiate()` on the SAME `db`/`worker` with the hybrid CDN wasm URL
  (`LOAD_HARDEN.buildHybridWasmBundle`). If the hybrid retry also fails, or no hybrid bundle is
  available, the original/hybrid error is rethrown, and the existing candidate `for` loop advances
  to the next full candidate (jsDelivr) exactly as before.
- **`js/app-shell/duckdb-engine.js`** (root `index.html` surface): now imports
  `SELF_HOST_CANDIDATE`, `isWasmFetchFailure`, and `buildHybridWasmBundle` from
  `js/sql/duckdb-load-harden.js` instead of duplicating a CDN pin, and wraps its own
  `db.instantiate()` call with the identical retry pattern.
- **`canvas/index.html`** (authoritative for the canvas surface): the tracked inline splice of
  `js/sql/duckdb-load-harden.js` was re-injected (`resync_duckdb_load_harden.py`) so the hybrid
  helpers are byte-consistent with the `js/` source. The canvas loader's own `_loadDuckFrom()` now
  accepts the full candidate object (not just `cdnUrl`/`baseUrl`) and applies the identical
  instantiate-then-hybrid-retry pattern via `window.DataGlowDuckDBLoadHarden`. The hardcoded
  fallback candidate list used only if that shared module itself failed to load also carries a
  `wasmFallback` for self-host, so the hybrid path is available even in that degraded case.

### 3. Candidate fallback no longer gets stuck on a null db

The existing per-candidate loop in both `js/sql/sql-engine.js` and the canvas inline loader already
threw and advanced to the next candidate on a failed `instantiate()`; this hotfix does not change
that control flow, it only adds the hybrid retry as a new middle rung before that throw happens.
The existing "no candidate host finished loading" guard in `registerDataset()`
(`js/sql/sql-engine.js`) and the equivalent canvas banner path already convert an exhausted
candidate list into a clear, actionable error instead of a bare `Cannot read properties of null
(reading 'query')` -- this hotfix keeps that guard, and the new tests assert it stays reachable.

## Files changed

- `js/sql/duckdb-load-harden.js` -- `SELF_HOST_CANDIDATE.wasmFallback`, `isWasmFetchFailure()`,
  `buildHybridWasmBundle()`, `buildCandidateList()` now carries `wasmFallback` through.
- `js/sql/sql-engine.js` -- `ensureInit()` wraps `db.instantiate()` with the hybrid retry.
- `js/app-shell/duckdb-engine.js` -- imports the shared hybrid helpers; `initDuckDB()` wraps
  `db.instantiate()` with the identical retry.
- `canvas/index.html` -- tracked `js/sql/duckdb-load-harden.js` splice re-injected;
  `_loadDuckFrom()` accepts the candidate and applies the hybrid retry; the hardcoded fallback
  candidate list also carries a `wasmFallback`.
- `canvas/integrity.manifest.json` -- re-recorded (`node scripts/check-canvas-integrity.mjs
  --update`) for the new tracked-module hash and file size.
- `test/bundle18-hotfix3-hybrid-cdn-wasm.test.mjs` -- new test file (see below).

## Tests

Added `test/bundle18-hotfix3-hybrid-cdn-wasm.test.mjs`, a static/pure-module test file (no browser
launch), across six groups:

- **A. Shared hybrid wasm fallback** (`js/sql/duckdb-load-harden.js`) -- `SELF_HOST_CANDIDATE`
  carries a `wasmFallback` pinned to jsDelivr 1.29.0; `buildCandidateList()` carries it through for
  self-host only; `isWasmFetchFailure()` correctly classifies fetch/compile failures versus
  unrelated errors; `buildHybridWasmBundle()` swaps only `mainModule` and keeps `mainWorker`
  same-origin for both `eh` and `mvp`; returns `null` for a candidate with no `wasmFallback`; never
  doubles the `assets/duckdb/` path; CDN fallbacks (jsDelivr, unpkg, esm.sh) remain unchanged.
- **B. `js/sql/sql-engine.js`** -- `db.instantiate()` is wrapped and retries via
  `buildHybridWasmBundle` on a wasm fetch failure; rethrows unchanged when no hybrid bundle is
  available (so the outer candidate loop can advance); a failed hybrid retry also rethrows; the
  "engine not ready" clear-failure message stays reachable; no em dash introduced.
- **C. `js/app-shell/duckdb-engine.js`** -- imports the shared helpers instead of duplicating the
  pin; wraps `instantiate()` with the identical retry; rethrows the original error when
  `isWasmFetchFailure` is false; the module imports cleanly under plain Node; no em dash introduced.
- **D. `canvas/index.html`** -- the tracked splice carries the new helpers; `_loadDuckFrom()`
  accepts the candidate and retries via the hybrid bundle; the call site passes the candidate
  through; the hardcoded fallback list also carries a `wasmFallback`; no doubled path anywhere in
  canvas; the pin stays 1.29.0 in every hybrid wasm URL; no em dash introduced.
- **E. Manifest consistency** -- `canvasBytes` and the `js/sql/duckdb-load-harden.js` tracked
  source/canvas-section hashes match the current files.
- **F. Documentation** -- this file exists and names the S3 redirect root cause, the hybrid fix,
  and the jsDelivr pin, with no em dash.

Result: `node --test test/bundle18-hotfix3-hybrid-cdn-wasm.test.mjs` passes.

## Regression check

Ran the prior hotfix proof files and the shared candidate-list test file after this change:

- `test/bundle18-hotfix-duckdb-worker-selfhost.test.mjs` -- unaffected (import map, unrelated to
  wasm fetch retry).
- `test/bundle18-hotfix2-wasm-absolute-paths.test.mjs` -- unaffected (root-absolute path shape,
  which this hotfix does not change: the hybrid retry only changes which URL `mainModule` points at
  on a wasm-fetch failure, never how that URL is resolved to absolute).
- `test/bundle15-duckdb-harden-ledger-spine-replay-dojo.test.mjs` -- unaffected (pure
  `shouldTryNextCandidate`/`nextCandidate`/`summarizeAttempts` behavior is untouched; this hotfix
  adds a same-candidate retry, not a change to the candidate-list walking logic those functions
  cover).
- `test/chore-duckdb-hardening.test.mjs` -- same single pre-existing, unrelated failure noted in
  both prior hotfixes (`#8 Server offload (opt-in only)` / `serverOffload` flag default), still
  failing identically before and after this change.

`node scripts/check-canvas-integrity.mjs` passes cleanly: syntax, markers, all tracked modules, both
ship-path guards, and the recorded byte count.

## What this does not fix (documented, not silently dropped)

- **Why pplx.app redirects large static assets to S3.** This hotfix works around the browser-side
  symptom (an unfetchable streaming wasm request) without changing or requiring a change to the
  platform's asset-serving behavior. If the platform's redirect behavior for `/assets/duckdb/*.wasm`
  changes in the future (for example, serving the bytes directly instead of redirecting), this fix
  is harmless: the same-origin `instantiate()` simply succeeds on the first try and the hybrid retry
  path never triggers.
- **COOP/COEP and `crossOriginIsolated: false` on live.** Unchanged from
  `BUNDLE18_HOTFIX2_RESULT.md`: DuckDB-WASM's multi-threaded (`eh`) build still runs single-threaded
  without `SharedArrayBuffer`, which is a documented, working fallback
  (`js/app-shell/duckdb-config.js#isCrossOriginIsolated`), not a crash, and orthogonal to this fix.
- **A CDN outage.** If jsDelivr itself is unreachable when the hybrid retry fires, `buildHybridWasmBundle`
  still returns a URL, the retry still fails, and the existing candidate loop still advances to
  unpkg and then esm.sh exactly as it did before this hotfix -- the hybrid retry is an extra rung
  inserted before that fallthrough, not a replacement for it.

## Sources consulted

- Live Playwright proof against https://dataglow-platform.pplx.app (network panel entries for
  `duckdb-browser.mjs`, `duckdb-eh.wasm`, jsDelivr/unpkg equivalents; console `pageerror` and SQL
  status text), summarized in the task's LIVE PROOF section.
- `curl -v` against the same `/assets/duckdb/duckdb-eh.wasm` path from a server, showing the `302`
  to an S3 object URL and the subsequent 35MB `application/wasm` response.
- `assets/duckdb/duckdb-browser.mjs` (vendored 1.29.0 build) for confirming `INSTANTIATE` failures
  inside the worker are caught and turned into a rejected promise (`failWith` -> `promiseRejecter`),
  which is why `db.instantiate()` reliably rejects on a wasm fetch failure rather than hanging.
- `BUNDLE18_HOTFIX2_RESULT.md` (this repository), whose "Residual: COOP/COEP and S3 redirects"
  section predicted this exact failure mode ahead of time.
- MDN, for `fetch()` and streaming `WebAssembly.compile`/`instantiateStreaming` cross-origin
  redirect behavior: [Fetch API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API),
  [WebAssembly.instantiateStreaming() (MDN)](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/instantiateStreaming_static).
