# Hotfix PH v1.2 — real table depth actually works live — Result

## Bug
Live-proven, per `HOTFIX_PH_V1_2_TABLE_DEPTH_SPEC.md`:
`runProofSecondEngine('SELECT COUNT(*) AS n FROM claims_example')` returned
`{engine:'webr-duckdb', scalars:{n:0}}` while primary DuckDB-WASM correctly
returned 10 — a false RED.

Root causes:
1. `dg_csv_claims_example` IS present in Pyodide globals after `buildHelper`
   — a registration target already exists.
2. `micropip.install("duckdb")` does not reliably succeed inside Pyodide
   (privacy warn on pypi.org; install path returns false), so the
   pyodide-duckdb path never runs.
3. The old fall-through `runViaWebRNarrowCount` accepted whatever `nrow()`
   returned, including a stale/false `0` for a table that was never bound in
   the R session — inventing a wrong number instead of refusing.

## Fixes (`js/proof-harness/data-glow-proof-harness-canvas.js`)

**F1 — `runViaPyodidePandasCount(py, statement)` (new).** When the statement
matches the existing narrow `parseCountStarFrom` shape (`SELECT COUNT(*) [AS
alias] FROM <table>`) and `dg_csv_<table>` exists in Pyodide's globals, this
reads the CSV via `pd.read_csv(io.StringIO(...))` and returns `len(df)` as
`{rowCount:1, scalars:{alias:n}, rows:[{alias:n}], engine:'pyodide-pandas',
tablesRegistered:[table]}`. Anything outside that narrow shape, or a missing
CSV global, returns `null` so the caller falls through honestly — never a
guess. This is honest second-engine corroboration on the exact CSV sync
`buildHelper` already provides, independent of whether the `duckdb` Python
package ever installed.

**Bridge priority, reordered in `runProofSecondEngineBridge`:**
1. `pyodide-duckdb` (if duckdb-in-pyodide ready + register + sql ok)
2. `pyodide-pandas` narrow COUNT (if the CSV global exists) — **new step**
3. trivial literal (`SELECT 1` / `SELECT <int> AS alias`, no `FROM`)
4. hardened webR (never returns `n=0` for a missing table)
5. `{error:'pyodide-sql-unavailable'}`

Both the "duckdb never became ready" branch and the "duckdb ready but this
statement's `duckdb.sql(...)` call threw" branch now try pandas before
literal/webR.

**F2 — hardened `runViaWebRNarrowCount`: never invent 0.** Before accepting
any R count, the bridge now evaluates
`exists("<table>", inherits = FALSE) && is.data.frame(get("<table>"))` in R
and requires it to resolve to `TRUE`. A missing or non-data.frame table
returns `{error:'pyodide-sql-unavailable'}` immediately — neither the
duckdb-in-R path (`requireNamespace("duckdb")` + `duckdb_register` +
`dbGetQuery`) nor the plain `nrow()` fallback is ever attempted against an
unconfirmed table. The duckdb-in-R branch also now requires the returned
value to be both non-`NaN` and finite before accepting it (an empty/`NA`
result from a real bound frame still can't become a false `0`), and the
`nrow()` branch applies the same finite check.

**F3 — `ensureDuckdbInPyodide` install resilience.** Left as-is per spec
("best-effort... keep cache but F1 still works when false") — no change was
needed beyond confirming F1 correctly covers the case where this legitimately
resolves `false`.

**F4 — export for tests.** `runViaPyodidePandasCount` is a plain named
function in the same IIFE scope as every other bridge helper, extracted
verbatim by the test file's brace-depth walker exactly like
`runViaPyodideDuckdb` / `runViaWebRNarrowCount` already are — no additional
`window`-level export was needed or added (this canvas module already
publishes only `window.runProofSecondEngine`, per its own file-level
doctrine comment).

## Tests (`test/proof-harness-v1-2-second-engine-depth.test.mjs`, extended)

Added, on top of the existing 68:
- `runViaPyodidePandasCount` verbatim-presence check.
- Mock: no duckdb, `dg_csv_orders` with 3 rows → `COUNT(*) AS n FROM orders`
  returns `engine:'pyodide-pandas'`, `n===3`, `tablesRegistered` includes
  `orders` (spec's exact scenario).
- Live-prove recipe reproduction: `dg_csv_claims_example` = 10-row CSV,
  duckdb-in-pyodide unavailable, `window.DataGlowR` present but must never be
  reached → `SELECT COUNT(*) AS n FROM claims_example` returns
  `engine:'pyodide-pandas'`, `n===10`, and asserts webR was never called
  (pandas is preferred, not raced).
- Hardened webR, the exact live bug reproduced: `exists("claims_example",
  ...)` mocked `FALSE`, `nrow(claims_example)` mocked to still return the
  bad `0` an unguarded call would have accepted → bridge now returns
  `{error:'pyodide-sql-unavailable'}` and asserts `nrow()` was never called.
- Hardened webR, duckdb-in-R variant: `exists(...)` `FALSE` →
  `requireNamespace("duckdb")` is asserted never called either.
- Existing webR nrow() success-path test updated to mock the new
  `exists()`/`is.data.frame()` gate returning `TRUE` first (this is the only
  change to a pre-existing assertion; the assertion itself — `engine:
  'webr-df'`, `scalars.c === 5` — is unchanged).
- pandas path narrow-refusal: a non-`COUNT(*)` statement with duckdb
  unavailable and no `DataGlowR` → honest unavailable, never a guess.
- pandas path table-miss: duckdb unavailable AND no matching `dg_csv_`
  global for the requested table → honest unavailable, never a fabricated
  count.

Result: **83 passed, 0 failed** in this file (up from 68 before the hotfix).
Prior suites unaffected:

| Suite | Result |
|---|---|
| `test/proof-harness-v0.test.mjs` | 73 passed, 0 failed |
| `test/proof-harness-v0-engine-window.test.mjs` | 18 passed, 0 failed |
| `test/proof-harness-v1.test.mjs` | 129 passed, 0 failed |
| `test/proof-harness-v1-1.test.mjs` | 46 passed, 0 failed |
| `test/proof-harness-v1-1-bridge.test.mjs` | 28 passed, 0 failed |
| `test/proof-harness-v1-2-second-engine-depth.test.mjs` | 83 passed, 0 failed |
| **Total** | **377 passed, 0 failed** |

## Inject + integrity
1. Ran `python3 inject_proof_harness_v1.py` — replaced the existing
   Proof Harness block in `canvas/index.html` in place (161,858 chars).
2. `npm run check:canvas-integrity -- --update` — refreshed the
   `js/proof-harness/data-glow-proof-harness-canvas.js` source/canvas-section
   hashes and `canvasBytes` (6,273,356 bytes) in
   `canvas/integrity.manifest.json`.
3. `npm run check:canvas-integrity` (no `--update`) — all checks green:
   syntax (3 inline `<script>` blocks parse), markers (336 inlined module
   paths, tracked modules paired), tracked (68 modules verified), ship path
   (desktop stage + build.sh clobber guard intact), and the recorded
   6,273,356-byte canvas size matches exactly.

## Live prove recipe (spec)
Claims Demo → SQL warm → `SELECT COUNT(*) AS n FROM claims_example` via
`runProofSecondEngine`. Expected: engine `pyodide-pandas` or
`pyodide-duckdb`, `scalars.n === 10`, cycle GREEN with `agrees:true` when
expected `n=10`. Covered by the new bridge-priority integration test above
using the exact statement and row count from the spec.

## Delivery
- Repo: `Andre-Weissmann/dataglow`
- Base: `main` @ `7ed4278` (#621)
- Branch: `feat/hotfix-ph-v1-2-table-depth-pandas`
- Spec: `HOTFIX_PH_V1_2_TABLE_DEPTH_SPEC.md`

Files changed: `js/proof-harness/data-glow-proof-harness-canvas.js`,
`test/proof-harness-v1-2-second-engine-depth.test.mjs`, `canvas/index.html`,
`canvas/integrity.manifest.json`, `HOTFIX_PH_V1_2_TABLE_DEPTH_RESULT.md`.

PR opened, **not merged**, per instructions. See PR URL and commit SHA
recorded by the delivery step below.
