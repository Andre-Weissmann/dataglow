# Hotfix PH v1.2 — real table depth actually works live

**Baseline:** main `7ed4278` (#621)  
**Live fail:** `runProofSecondEngine('SELECT COUNT(*) AS n FROM claims_example')` returned `{engine:'webr-duckdb', scalars:{n:0}}` while primary DuckDB-WASM correctly returns 10.  
**Root causes (live-proven):**
1. `dg_csv_claims_example` IS present after `buildHelper` — registration target exists.
2. `micropip.install("duckdb")` does not reliably succeed (privacy warn on pypi.org; install path returns false) → pyodide-duckdb path never runs.
3. Fall-through `runViaWebRNarrowCount` returns `webr-duckdb` with **n=0** when the R table is missing/empty — invents a wrong number → false RED. Spec forbids inventing answers.

## Fixes

### F1. Pyodide-pandas narrow COUNT (must work offline of pypi duckdb wheel)
When duckdb-in-pyodide is unavailable OR duckdb.sql throws after empty registration:
- If statement matches `parseCountStarFrom` AND `dg_csv_<table>` exists in py globals:
  - `pd.read_csv` → `len(df)` → return `{rowCount:1, scalars:{alias:n}, rows:[{alias:n}], engine:'pyodide-pandas', tablesRegistered:[table]}`
- This is honest second-engine corroboration on the same CSV sync buildHelper already provides.
- Prefer order in bridge:
  1. pyodide-duckdb (if duckdb ready + register + sql ok)
  2. pyodide-pandas narrow COUNT (if CSV global exists)
  3. trivial literal
  4. webR narrow (hardened)
  5. `{error:'pyodide-sql-unavailable'}`

### F2. Harden webR — never invent 0
Before accepting any R count:
- Require `exists(table, inherits=FALSE) && is.data.frame(get(table))`
- If missing → `{error:'pyodide-sql-unavailable'}` (do not return 0)
- duckdb-in-R path: only accept if requireNamespace succeeded AND table exists as df AND value is finite; empty missing must not become 0 success
- Prefer not tagging engine webr-duckdb unless duckdb R package truly ran a query against a real bound frame

### F3. Duckdb install resilience (best-effort)
In `ensureDuckdbInPyodide`:
- Keep loadPackage('micropip') then micropip.install('duckdb')
- On failure, try one jsdelivr/pyodide-friendly fallback if known; else mark false and rely on F1
- Do not cache `_secondEngineDuckdbReady = false` forever across a later successful path if we only failed install once... actually keep cache but F1 still works when false

### F4. Optional: export helpers for tests
- `runViaPyodidePandasCount(py, statement)` pure-orchestrated
- Tests: pandas path returns correct n from mock csv global; webR missing table → error not 0; bridge priority prefers pandas over webr when duckdb false

## Tests
- New/extend `test/proof-harness-v1-2-second-engine-depth.test.mjs`
- Mock: no duckdb, has dg_csv_orders with 3 rows → COUNT returns engine pyodide-pandas n=3
- Mock webR returns 0 without exists → bridge must error not accept 0
- Prior suites still green

## Inject + integrity + PR (no merge)

## Live prove recipe
Claims Demo → SQL warm → `SELECT COUNT(*) AS n FROM claims_example` via `runProofSecondEngine`  
Expect: engine `pyodide-pandas` or `pyodide-duckdb`, scalars.n === 10, cycle GREEN with agrees true when expected n=10
