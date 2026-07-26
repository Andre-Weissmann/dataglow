# Bundle 18 Hotfix 4: CDN WASM First, No Silent Hang

## Bug report

Playwright, run against the live deploy at https://dataglow-platform.pplx.app after the hybrid
self-host + CDN wasm hotfix ([#611](https://github.com)) merged and published, showed:

- `hybrid:true` present in the shipped HTML fingerprint, confirming the hotfix 3 code was live.
- Network panel: only `duckdb-browser.mjs` and `duckdb-browser-eh.worker.js` ever return a `200`.
- jsDelivr and unpkg wasm URLs are **never requested** (`hybrid_seen=false`), even though hotfix 3
  added the exact retry logic that should have requested them.
- SQL status is stuck on `Error: Cannot read properties of null (reading 'query')`.
- A `pageerror` fires: `Failed to fetch`.

So the hybrid CDN wasm retry hotfix 3 shipped was never executing on the live canvas SQL path that
`pplx.app` actually uses.

## Actual canvas SQL code path

Tracing the live canvas Run button through to the DuckDB call site:

`svRunQuery` (SQL view UI) -> `getSVEngine()` -> `getSQLEngine()` (memoized) -> `SQLEngine.init(...)`
-> the engine's internal DuckDB adapter, built once by `createDuckDBAdapter()` inside
`canvas/index.html` -> `ensureInit()` -> `_dgDoInit()` -> `_dgDuckCandidates()` for the ordered
candidate list -> `_loadDuckFrom(cdnUrl, baseUrl, candidate)` for the first candidate (self-host)
-> `new Worker(workerUrl)` + `adb.instantiate(mainModuleUrl, pthreadWorker)` -> on success,
`query(sql, datasets)` calls `conn.query(sql)`. `js/sql/sql-engine.js` and
`js/app-shell/duckdb-engine.js` mirror the same shape for the SQL Editor overlay and the root
`index.html` surface respectively, both importing the shared candidate list and helpers from
`js/sql/duckdb-load-harden.js`. `canvas/index.html` is the authoritative, single-file surface that
`pplx.app` actually serves and is where the live bug reproduces.

## Root cause: two independent bugs

**1. The hybrid CDN retry could never fire, because `instantiate()` hung instead of rejecting.**
Hotfix 3's hybrid retry lived entirely inside a `catch (eInstantiate)` block wrapped around
`await adb.instantiate(mainModuleUrl, pthreadWorker)`. That only runs if the promise actually
rejects. Live, the self-host wasm fetch failure (the same unfetchable-S3-redirect issue documented
in `BUNDLE18_HOTFIX3_RESULT.md`) does not surface as a rejected promise: it happens **inside the
DuckDB-WASM Worker thread**, in Emscripten's own `instantiateAsync`/`getBinaryPromise` wasm-loading
code, and it fires as an uncaught `error` event on the `Worker` object itself. `AsyncDuckDB`'s own
`onError()` handler (in the vendored `assets/duckdb/duckdb-browser.mjs`) responds to a worker
`error` event by clearing its table of pending requests **without ever calling the promise rejecter**
tied to the in-flight `instantiate()` call. The result: `await adb.instantiate(...)` hangs forever,
the `catch` block (and the CDN retry logic hotfix 3 put inside it) never runs, and no jsDelivr/unpkg
network request is ever made -- exactly the `hybrid_seen=false` symptom from the live report. This
also explains why the fingerprint showed `hybrid:true` (the code shipped) while the network panel
showed no CDN requests (the code that requests them never got a chance to run).

**2. `query()` had no null-connection guard for table-free queries.** Independently of bug 1,
`query(sql, datasets)` only guarded against a null `db`/`conn` inside the `registerDataset()` loop.
A query with zero datasets (a bare `SELECT 1`, or any query run before a dataset is attached) skips
that loop entirely and calls `conn.query(sql)` directly with no guard at all. If `ensureInit()` ever
returned while `db`/`conn` were still null -- including as a direct knock-on effect of bug 1 above,
since a hung `instantiate()` never lets `db`/`conn` get assigned -- this reached a bare
`conn.query(sql)` on a null `conn` and threw exactly `Cannot read properties of null (reading
'query')`.

## Fix

**Preferred fix: make the self-host candidate request CDN wasm unconditionally, from the first
attempt, instead of depending on a caught rejection.**

1. `js/sql/duckdb-load-harden.js`: `SELF_HOST_CANDIDATE` now also carries `wasmCdnFirst` (the same
   `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/` wasm URLs already used by
   `wasmFallback`). A new pure helper,
   `buildSelfHostBundle(workerBundle, variant)`, returns the self-host load bundle with
   `mainModule` **already pointed at the jsDelivr pin**, while `mainWorker` (and therefore the
   entire same-origin worker/`duckdb-browser.mjs` stack) is left untouched. `wasmFallback`,
   `isWasmFetchFailure`, and `buildHybridWasmBundle` (all from hotfix 3) are kept exactly as they
   were, as a second-layer retry-on-catch safety net in case a future regression reintroduces a
   same-origin-only wasm attempt somewhere.
2. `js/sql/sql-engine.js`, `js/app-shell/duckdb-engine.js`, and `canvas/index.html` (authoritative)
   all apply `buildSelfHostBundle()` to the self-host candidate's `mainModule` URL **before the
   first `instantiate()` call**, not only inside a catch block. This guarantees a CDN wasm network
   request fires unconditionally on the very first load attempt for self-host, regardless of
   whether the same-origin wasm fetch would have rejected cleanly, hung, or thrown an uncaught
   worker error.
3. Every `instantiate()` call site (both the primary attempt and the still-present hybrid retry) is
   now wrapped in a new `instantiateWithTimeout()` / `_dgInstantiateWithTimeout()` helper that races
   the real `instantiate()` call against a manual `Worker` `error`-event listener and a 45000ms
   deadline. Either one rejects with a clear, `isWasmFetchFailure`-matching message
   (`Failed to fetch: ...`) if the worker throws or the instantiate call simply never responds, so a
   hang or an uncaught worker error can never again silently starve the caller forever.
4. `ensureInit()` (all three surfaces) now shares a single `initPromise` across every caller instead
   of flipping a boolean flag before the awaited work finished, so two concurrent callers (for
   example the SQL view firing a query while an earlier query is still initializing) always await
   the same in-flight attempt rather than one of them racing ahead and reaching `conn.query()` while
   `conn` is still null.
5. `query(sql, datasets)` (all three surfaces) gained its own unconditional null-`db`/`conn` guard,
   independent of `registerDataset()`, that runs immediately before `conn.query(sql)`: if `db` or
   `conn` is still null, it clears the shared `initPromise` and retries `ensureInit()` once, then
   throws a clear `DuckDB-WASM engine not ready: no candidate host finished loading. Retry to try
   the next host.` error instead of ever reaching a bare null property read. This closes bug 2 for
   table-free queries specifically.

The existing candidate-list walk (self-host -> jsDelivr -> unpkg -> esm.sh) and hotfix 3's
hybrid-retry-on-catch path are both preserved underneath this change as fallback layers; nothing
that previously worked was removed. The wasm version pin stays `1.29.0` everywhere, and no doubled
`assets/duckdb/assets/duckdb/` path is introduced anywhere in `canvas/index.html` or the source
modules (`canvas/integrity.manifest.json` was regenerated and verified clean).

## Tests

New `test/bundle18-hotfix4-wasm-cdn-first.test.mjs` (33 assertions across 6 suites: A shared
helpers, B `sql-engine.js`, C `duckdb-engine.js`, D canvas authoritative, E manifest consistency, F
this result doc) proves: `wasmCdnFirst` and `buildSelfHostBundle()` exist and resolve to the pinned
jsDelivr URLs; every `instantiate()` call site on every surface is wrapped in the new
timeout/error-guarded helper with no bare call sites remaining; the CDN-first override runs before
`new Worker()`/the first `instantiate()` attempt; `ensureInit()` shares one `initPromise`; `query()`
has an unconditional null-`conn` guard that runs before `conn.query(sql)` on all three surfaces; no
doubled `assets/duckdb` path; the `1.29.0` pin is intact everywhere; and the canvas integrity
manifest matches the current `canvas/index.html`.

The pre-existing `test/bundle18-hotfix3-hybrid-cdn-wasm.test.mjs` and
`test/bundle18-hotfix2-wasm-absolute-paths.test.mjs` files were updated in place (following the
same convention hotfix 2 used on the hotfix 1 test file) where their assertions matched the exact
old code shape (a bare `await db.instantiate(...)` call site, an `if (!hybridBundle) throw` guard
with no CDN-first override, an em-dash anchor string that no longer occurs verbatim) that hotfix 4
intentionally changed; all such assertions now match the new `instantiateWithTimeout`/
`_dgInstantiateWithTimeout`-wrapped shape while still proving the same underlying behavior (hybrid
retry still exists and still recovers from a wasm fetch failure). Both files pass fully after the
update (29/29 and 18/18 respectively), as does the new hotfix 4 test file. Other test files that
import the vendored `assets/duckdb/duckdb-browser.mjs` or `@duckdb/node-api` directly
(`csv-ignore-errors.test.mjs`, `cross-column-consistency.test.mjs`, `python-bridge-truncation.test.mjs`,
and others) fail with a pre-existing `ERR_MODULE_NOT_FOUND` for `apache-arrow` / `@duckdb/node-api`
in this sandbox; confirmed via `git stash` that the identical failures occur on unmodified `main`,
so they are a pre-existing missing-dependency issue in this environment, not a regression introduced
by this hotfix.

## Residual notes

The underlying S3-redirect wasm-fetch-unreliability on `pplx.app` (documented in
`BUNDLE18_HOTFIX3_RESULT.md`) and the `crossOriginIsolated: false` residual (documented in
`BUNDLE18_HOTFIX2_RESULT.md`) are both still true of the hosting environment. This hotfix does not
attempt to fix same-origin wasm serving; it routes around it by making the CDN wasm request the
primary path for self-host instead of a same-origin attempt with a fragile retry-on-catch recovery.
