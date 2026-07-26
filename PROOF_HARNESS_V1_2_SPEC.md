# Proof Harness v1.2 SPEC — Second engine depth (real tables)

**Baseline:** main `96caedf` (PH v1.1 #619 + inject hotfix #620)  
**Goal:** Make `window.runProofSecondEngine(sql)` re-run claims against **real in-memory tables**, not only trivial `SELECT 1` literals. Pyodide+duckdb preferred; webR best-effort.

## Problem (live-proven)

v1.1 bridge:
1. Calls `DataGlowPython.buildHelper(py)` which puts CSVs in `dg_csv_*` globals and `dg.df()`
2. Runs `duckdb.sql(statement)` **without registering those frames as DuckDB tables**
3. Any `SELECT ... FROM <table>` fails → falls back to literal or `pyodide-sql-unavailable`
4. webR is not used as a second path for table SQL

## Non-goals
- Full SQL dialect parity / query planner
- Auto-loading warehouse connectors
- A48 polish / Career Lane C
- Inventing agreement when tables missing
- Breaking `DataGlowPython.run` code panel

## Pillar A — Pyodide-duckdb table registration

### A1. Register every synced dataset before SQL
After successful `buildHelper(py)` (or equivalent), and after `ensureDuckdbInPyodide`:

```
for each global key matching ^dg_csv_(.+)$:
  table_name = capture group 1  # already SQLEngine.safeTableName style
  df = pd.read_csv(io.StringIO(csv))
  duckdb.register(table_name, df)
```

Use the **default** duckdb connection that `duckdb.sql` uses (or an explicit connection kept for the bridge session). Prefer `duckdb.register` over `read_csv` file paths (no filesystem needed).

### A2. Naming parity with primary engine
Table names must match what primary DuckDB-WASM uses for the same dataset:
- `SQLEngine.safeTableName(dataset.name)` → same as `dg_csv_` suffix from buildDGHelper
- Document that statements proven on primary against `orders` must use `orders` on second engine

### A3. Fresh register each bridge call
Re-register every call (or fingerprint datasets and skip if unchanged). Stale tables after dataset swap must not silently corroborate.

### A4. Result shape (unchanged contract)
Success:
```js
{ rowCount, rows, scalars, engine: 'pyodide-duckdb', tablesRegistered: ['a','b'] }
```
Failure still honest:
```js
{ error: 'pyodide-sql-unavailable', detail?: string }
```
Never invent rowCount.

### A5. Optional public helper
If useful: `DataGlowPython.prepareProofTables = async function(py){...}` that only registers tables (callable from tests). Prefer keeping logic inside the PH canvas bridge if touching Python host is risky; either is fine if documented.

### A6. Engine label honesty
- Tables registered + duckdb ran → `pyodide-duckdb`
- Literal fallback only → `pyodide-literal` (unchanged)
- webR path → `webr-duckdb` or `webr-df` as applicable

## Pillar B — webR best-effort second path

### B1. When to try webR
Only if Pyodide path returned unavailable **or** as an optional additional resolver name when Pyodide missing entirely.

Priority inside `runProofSecondEngineBridge`:
1. Pyodide + duckdb + registered tables
2. Trivial literal (unchanged)
3. webR table path (new)
4. `{error:'pyodide-sql-unavailable'}` (keep this error code for backward tests; optional `engineAttempted: ['pyodide','webr']`)

### B2. webR mechanism
Use public `window.DataGlowR.init()` when present (do not boot a second WebR if notebook owns kernel).

Best-effort order:
1. If R can install/import `duckdb` quickly (timeout ≤12s), bind data frames and `duckdb$query(sql)` / DBI
2. Else if datasets already bound as R data.frames (notebook prelude), support **narrow** patterns only:
   - `SELECT COUNT(*) FROM t` / `SELECT count(*) AS c FROM t` → `nrow(t)`
   - refuse other SQL with unavailable
3. Never call `DataGlowR.run` with raw SQL as if it were R source blindly

### B3. Marker
If exposing `window.runDrillR` for proof, set `.isProofRunner = true` only on a SQL-shaped wrapper, never on the notebook cell runner.

## Pillar C — Canvas UX note
When corroboration.ran && engine is `pyodide-duckdb`, Prove tab note may say:  
`Second engine (pyodide-duckdb) agreed on registered tables.`  
Keep short; no em dash in UI strings.

## Tests

### Unit (extract or pure helpers)
1. Table registration Python snippet / JS orchestrator: given mock globals `dg_csv_orders`, registration list includes `orders`
2. Statement with FROM is NOT accepted by `evalTrivialLiteralSelect` (regression)
3. Bridge source contains `duckdb.register` (or equivalent) and `dg_csv_` discovery
4. webR narrow COUNT pattern parser if implemented

### Integration-style (Node with mocks)
Mock `window.DataGlowPython`:
- loadRuntime → fake py with globals map
- buildHelper → sets `dg_csv_demo` CSV with 2 rows
- fake duckdb path: either extract `registerTablesInPyodideDuckdb` logic and unit test it, or simulate bridge function after extraction

Minimum bar: **source-verbatim extraction tests** proving registration code exists and a pure `registerTablesFromCsvGlobals` helper is unit-tested if factored out.

### Live prove (parent Playwright after merge)
1. Load sample data (click Load sample / try-example)
2. SQL warm + identify a real table name from schema/UI
3. Prove `SELECT count(*) AS n FROM <table>` with expected rowCount matching primary
4. Assert corroboration.ran===true and engine is `pyodide-duckdb` (or webr-*) — not only literal
5. Cartridge round-trip still GREEN
6. Disagree injection still RED

If Pyodide CDN/duckdb wheel fails in CI-like live env, record honest `pyodide-sql-unavailable` but still PASS registration unit tests; live note residual.

## Inject / integrity
- Edit `js/proof-harness/data-glow-proof-harness-canvas.js`
- `python3 inject_proof_harness_v1.py`
- `npm run check:canvas-integrity -- --update`
- **No ESM Pure aliases** (use Core names only; regression from #620)

## Success criteria
- [ ] Registration runs before duckdb.sql
- [ ] Unit tests green (v0 + v1 + v1.1 + new v1.2)
- [ ] PR open
- [ ] After merge+publish: live prove documents engine tag for a real FROM query when CDN allows

## Residuals OK
- Complex joins/windows may still fail on duckdb-in-pyodide version skew → unavailable, not false GREEN
- webR full SQL optional if duckdb R package unavailable
