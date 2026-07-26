# Proof Harness v1.2: Result

Implements `PROOF_HARNESS_V1_2_SPEC.md` on top of main @ `96caedf` ("Hotfix:
Proof Harness canvas inject no longer breaks on stripped ESM aliases (#620)").

Branch: `feat/proof-harness-v1-2-second-engine-depth`. **Not merged** -- left
as an open PR branch per instructions.

## The bug this fixes

The v1.1 second-engine bridge called `duckdb.sql(statement)` inside Pyodide
directly against whatever `DataGlowPython.buildHelper(py)` had already
dropped into Pyodide's Python globals as `dg_csv_<table>` CSV strings, but it
never registered any of those frames as duckdb **tables** first. `duckdb.sql`
reads from its own separate in-memory catalog, not the Python global
namespace, so every `SELECT ... FROM <table>` statement always failed there
and silently fell back to the trivial literal probe (or the honest
`pyodide-sql-unavailable`). Real FROM-queries never actually corroborated
against pyodide-duckdb -- only `SELECT 1`-style literals ever worked.

## Ship summary

### Pillar A -- pyodide-duckdb table registration

**`js/proof-harness/data-glow-proof-harness-canvas.js`**

- `listCsvGlobalTableNames(globalKeys)` (pure): given Pyodide global key
  names (array, Set, Map-shaped PyProxy via `.keys()`, or a plain object),
  returns the deduplicated list of table names to register -- the capture
  group after `dg_csv_`, i.e. exactly what `SQLEngine.safeTableName()` /
  `buildDGHelper` already produce. Handles the real Pyodide `globals` object
  correctly: it behaves as a JS `Map`, so `.keys()` is used (not `.forEach`,
  whose Map callback signature is `(value, key)`, not `(key)` -- an easy trap
  this implementation deliberately avoids).
- `buildRegisterPythonSnippet(tableNames)` (pure): generates the Python
  source that, for each table name, reads the matching `dg_csv_<name>`
  global as a pandas DataFrame via `pd.read_csv(io.StringIO(...))` (no
  filesystem, no re-fetch) and calls `duckdb.register(<name>, df)` -- the
  bare table name, never the `dg_csv_` prefixed global name. Sanitizes table
  names before embedding them (mirrors `safeTableName`'s character
  stripping).
- `registerCsvGlobalsAsDuckdbTables(py)`: runs the generated snippet via
  `py.runPythonAsync`, returns the list of tables actually registered.
  Best-effort -- a bad CSV for one dataset does not block corroboration of
  statements that do not touch it (duckdb.sql will honestly fail on any
  table that never got registered, never fabricating a match).
- `runViaPyodideDuckdb(py, statement)`: now calls
  `registerCsvGlobalsAsDuckdbTables(py)` **before** `duckdb.sql(...)` (the
  core fix), on **every** call -- no fingerprint/skip-if-unchanged shortcut,
  so a dataset swap can never leave a stale table silently corroborating a
  claim against old data (spec A3). Returns
  `{ rowCount, rows, scalars, engine: 'pyodide-duckdb', tablesRegistered }`.
- Engine label honesty (spec A6) preserved: tables registered + duckdb ran
  -> `pyodide-duckdb`; literal-only -> `pyodide-literal` (unchanged); webR
  path -> `webr-duckdb` / `webr-df` (new, see Pillar B).

### Pillar B -- webR best-effort second path

- `parseCountStarFrom(statement)` (pure): recognizes only
  `SELECT COUNT(*) FROM t` / `SELECT count(*) AS c FROM t` (optional quoted
  table name, optional trailing semicolon) and returns `{table, alias}`, or
  `null` for anything else -- deliberately narrow, refuses rather than
  guesses (spec B2.2).
- `runViaWebRNarrowCount(statement)`: only reached when the Pyodide path
  could not answer at all. Uses `window.DataGlowR.init()` -- the one public
  seam the spec allows -- and never reaches into the R tab's private `_webR`
  closure state, never boots a second WebR runtime, and never hands the raw
  SQL statement to `evalR` as if it were R source outside the narrow, parsed
  COUNT(*) path. Tries a quick `duckdb`-in-R path first
  (`requireNamespace("duckdb", quietly = TRUE)`, no slow install attempt) and
  falls back to `nrow(<table>)` against an R data.frame already bound by a
  notebook prelude. `window.DataGlowR` does not currently exist anywhere in
  the codebase (verified via search) -- there is no R Notebooks-lite public
  API yet, only a private per-tab IIFE closure. Per spec B2 ("Use public
  `window.DataGlowR.init()` **when present**"), this is intentionally
  best-effort: the bridge checks for it and honestly returns
  `{error:'pyodide-sql-unavailable'}` when absent, exactly like every other
  path that cannot actually answer. Adding a public `DataGlowR` surface to
  the R tab is out of scope for this spec (non-goal: no A48/Career-Lane-C
  polish) and was not invented here to avoid overreach.
- `runProofSecondEngineBridge` priority order (updated):
  1. Pyodide + duckdb + registered tables (`runViaPyodideDuckdb`)
  2. Trivial literal probe (`evalTrivialLiteralSelect`, unchanged)
  3. webR narrow COUNT(*) path (`runViaWebRNarrowCount`, new)
  4. Honest `{error:'pyodide-sql-unavailable'}` (unchanged error code, kept
     for backward compatibility with existing tests/consumers)

## Pure helpers factored (ship item #2)

So Node tests can cover the registration/webR logic without a full Pyodide
runtime:
- `listCsvGlobalTableNames(globalKeys)`
- `buildRegisterPythonSnippet(tableNames)`
- `parseCountStarFrom(statement)`

All three are extracted **verbatim** from the shipped canvas source in
tests (brace-depth walk + `Function(...)`, same technique
`test/proof-harness-v1-1-bridge.test.mjs` already used for
`evalTrivialLiteralSelect`), so a drift in the shipped source fails
extraction loudly rather than silently testing a stale reimplementation.

## Tests

Six suites, run individually with `node <file>`:

| Suite | Result |
|---|---|
| `test/proof-harness-v0.test.mjs` | 73 passed, 0 failed |
| `test/proof-harness-v0-engine-window.test.mjs` | 18 passed, 0 failed |
| `test/proof-harness-v1.test.mjs` | 129 passed, 0 failed (unchanged) |
| `test/proof-harness-v1-1.test.mjs` | 46 passed, 0 failed (unchanged) |
| `test/proof-harness-v1-1-bridge.test.mjs` | 28 passed, 0 failed (one assertion updated, see below) |
| `test/proof-harness-v1-2-second-engine-depth.test.mjs` (new) | 68 passed, 0 failed |
| **Total** | **362 passed, 0 failed** |

`test/proof-harness-v1-2-second-engine-depth.test.mjs` covers:
1. `listCsvGlobalTableNames` against arrays, Map-keys iterables (the real
   Pyodide globals shape), plain objects, empty/null input, and dedup.
2. `buildRegisterPythonSnippet` generates real `pd.read_csv` +
   `duckdb.register` Python, reading from `io.StringIO` (no filesystem),
   registering under the bare table name (never the `dg_csv_` prefixed
   name), with unsafe characters sanitized.
3. Source-level proof that `registerCsvGlobalsAsDuckdbTables` has no
   fingerprint/cache shortcut (spec A3: re-register every call) and that
   **registration happens before `duckdb.sql(...)` is called** inside
   `runViaPyodideDuckdb` -- the core fix, asserted by string-index order in
   the actual shipped source, not a reimplementation.
4. Source-level confirmation the shipped canvas contains a real
   `duckdb.register(...)` call and never references a stripped ESM `Pure`
   alias like `exportCartridgePure` (regression guard for #620).
5. `parseCountStarFrom` narrow-pattern recognition and refusal of anything
   with a WHERE clause, a join, a non-`COUNT(*)` aggregate, or a non-SELECT
   statement.
6. Source-level proof the webR path only uses `window.DataGlowR`, calls
   `.init()` rather than booting a second runtime, always parses the
   statement through `parseCountStarFrom` first, shares the same honest
   `pyodide-sql-unavailable` error code, and never touches the private
   `_webR` variable.
7. Full end-to-end orchestration against a **mocked Pyodide `py`** (no real
   Pyodide/duckdb needed): a `SELECT COUNT(*) AS n FROM orders` query against
   a table with a matching `dg_csv_orders` global now succeeds and returns
   `engine: 'pyodide-duckdb'` with the correct row count and
   `tablesRegistered: ['orders']` -- proving the core bug is fixed, not just
   that the code looks right. Also proves: an unregistered table name still
   fails honestly; a dataset swap between two bridge calls re-registers
   fresh data (spec A3) rather than serving a stale table; with neither
   Pyodide nor webR available a FROM query is honestly refused; with only
   `window.DataGlowR` available a narrow `COUNT(*) FROM t` is answered via
   the webR `nrow()` fallback (`engine: 'webr-df'`); and a non-narrow
   statement with only webR available is still honestly refused rather than
   guessed at.

`test/proof-harness-v1-1-bridge.test.mjs` -- one assertion updated. v1.1's
test counted `pyodide-sql-unavailable` occurrences strictly inside
`runProofSecondEngineBridge`'s own body (expecting >= 3, one per branch).
v1.2 factored the webR fallback out into `runViaWebRNarrowCount` per this
spec's explicit ship instruction ("Factor pure helpers where possible"), so
some of those literal occurrences now live in the delegate function instead
of being inlined in the bridge body. The updated assertion counts
occurrences across `runProofSecondEngineBridge` **and** its
`runViaWebRNarrowCount` delegate together (still >= 3), preserving the
original contract -- every branch that cannot actually answer resolves
honestly, never with a fabricated `rowCount` -- while accommodating the
legitimate structural refactor. No other v1.1 test changed.

## Canvas re-injection

`inject_proof_harness_v1.py` unchanged (no changes were needed to the
injector itself for v1.2 -- only the UI module's contents changed, and the
injector already inlines that file's full contents verbatim). Ran
`python3 inject_proof_harness_v1.py` -> replaced the existing v1 block in
`canvas/index.html` in place (155,235 chars). Verified:
- `node --check` on the extracted injected block: syntax OK.
- Loaded the extracted block in a stubbed Node `window`/`document` (with a
  fuller DOM stub than a bare object, so `boot()`'s panel construction could
  actually run) and confirmed `window.DataGlowProofHarness.version === 3`,
  `exportCartridge`/`importCartridge`/`roundTripCartridge`/
  `resolveSecondEngine` are all present as functions, and
  `window.runProofSecondEngine` is installed as a function once the
  `boot()` timeout fires -- the same lazy-install contract v1.1 shipped.
- `grep` confirms `canvas/index.html` contains a real `duckdb.register(`
  call (4 occurrences: the injected UI module's registration snippet
  builder plus its own source-comment references) and **zero** occurrences
  of `exportCartridgePure` (the #620 regression this spec explicitly guards
  against).
- `npm run check:canvas-integrity -- --update` -> manifest hashes refreshed.
- `node scripts/check-canvas-integrity.mjs` (no `--update`) afterward ->
  clean pass (`canvas bundle integrity OK`, 68 tracked modules verified,
  recorded byte count matches).
- `node scripts/check-capability-map.mjs` -> clean pass, no drift (268
  shipped, 0 behind-flag; no new public capability was added, only existing
  modules edited).

## How to live-prove this (recipe for the parent Playwright pass)

1. **Load sample data.** Open the app, use the "Load sample" / try-example
   data button on the Data view (or upload any CSV) so at least one dataset
   is active. Note the dataset's display name -- the second engine will
   register it under `SQLEngine.safeTableName(name)`, the same sanitized
   name (extension stripped, non-alphanumerics replaced with `_`) the
   primary DuckDB-WASM engine already uses for `FROM` clauses in the SQL
   tab. For the built-in sample data this is typically a name like `orders`
   or `sales_data` -- check the Drill Floor SQL tab's schema panel or run
   `SELECT * FROM <name> LIMIT 5` there first to confirm the exact table
   name before using it in Prove.
2. **Open the Proof Harness panel** (the claim bar button in the corner) and
   go to the **Prove** tab.
3. **Type a real FROM query** referencing that table name, for example:
   ```sql
   SELECT COUNT(*) AS n FROM orders
   ```
   (substitute the actual sample table name from step 1). Set the expected
   value to match what the primary DuckDB-WASM engine returns for the same
   query (run it once in the Drill Floor SQL tab to get the real count).
4. **Click Prove.** On the first Prove click that needs corroboration, the
   bridge lazily loads Pyodide (~10 MB, first run only) and installs duckdb
   inside it if not already present, then registers every `dg_csv_*` frame
   as a duckdb table before running the statement.
5. **Check the result.** With Pyodide/duckdb-in-Pyodide available (requires
   network access to the Pyodide CDN and the `duckdb` wheel):
   - `corroboration.ran === true`
   - `corroboration.engine === 'pyodide-duckdb'` (not `pyodide-literal`)
   - `corroboration.tablesRegistered` includes the table name used
   - The claim reaches GREEN when the expected value matches, confirming a
     genuine second-engine agreement on real data, not a trivial literal.
6. **Cartridge round-trip** (still GREEN): once the claim above is GREEN,
   use "Export cartridge" then "Re-prove on this device" (Cartridge tab) and
   confirm it re-verifies GREEN against the same live engine.
7. **Disagree injection** (still RED): change the expected value to
   something wrong (e.g. `n + 1`) and Prove again -- confirm the verdict
   downgrades to RED, proving the harness does not rubber-stamp.
8. **webR fallback (optional, needs `window.DataGlowR` to exist -- it does
   not yet in this codebase):** if/when a future change publishes
   `window.DataGlowR.init()` from the R tab, `SELECT COUNT(*) FROM <table>`
   with Pyodide unavailable should corroborate via `engine: 'webr-df'`
   (using `nrow()`) or `engine: 'webr-duckdb'` (if the R `duckdb` package is
   available). Until then, this path stays honestly unreachable and the
   bridge falls through to `pyodide-sql-unavailable` when Pyodide is also
   unavailable, exactly as designed.

If the Pyodide CDN or duckdb wheel is unreachable in the live environment,
the bridge honestly reports `{error:'pyodide-sql-unavailable'}` (no false
GREEN, no false RED) -- this is expected residual behavior per spec, not a
bug; the registration unit tests above already prove the fix works
end-to-end against a mocked Pyodide/duckdb layer regardless of live network
conditions.

## Constraints honored

- `window.DataGlowPython.run` (the Python notebook/code-panel executor) was
  not modified -- the bridge only calls its existing public
  `loadRuntime`/`buildHelper` methods, unchanged from v1.1.
- The second-engine bridge never invents agreement: every path that cannot
  actually answer a statement returns `{error:'pyodide-sql-unavailable'}`,
  never a fabricated `rowCount`, verified both by source inspection and by
  the mocked end-to-end integration tests (unregistered table, no engines
  available, non-narrow statement with only webR available).
- Registration re-runs on every bridge call (spec A3) -- no
  fingerprint/skip-if-unchanged shortcut was added, so a dataset swap cannot
  silently serve stale data.
- No new `window.DataGlowProofHarness`-shaped global was introduced;
  `canvas/index.html` remains the sole authoritative, integrity-verified
  bundle.
- No ESM `Pure` aliases were introduced (regression guard for #620),
  verified by both `grep` and an automated test assertion.
- No em dashes introduced in any new/edited file.
- Branch was not merged.

## Files changed

```
canvas/index.html                                       | ~460 lines changed (re-injected UI module)
canvas/integrity.manifest.json                           |  14 +-
js/proof-harness/data-glow-proof-harness-canvas.js       | ~230 ++++++++
test/proof-harness-v1-1-bridge.test.mjs                  |  17 +-
test/proof-harness-v1-2-second-engine-depth.test.mjs     | new file (68 tests)
PROOF_HARNESS_V1_2_RESULT.md                             | new file (this document)
```

## Spec source

See `PROOF_HARNESS_V1_2_SPEC.md` in the repository root for the full spec
this implements.
