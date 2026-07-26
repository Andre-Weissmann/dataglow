# RESULT — Hotfix: Second-engine full SQL via Pyodide SQLite

**Spec:** `HOTFIX_SECOND_ENGINE_SQLITE_SQL_SPEC.md`
**Branch:** `fix/second-engine-pyodide-sqlite-sql`
**Baseline:** `main` @ `8d92d16` (post-#623)
**Status:** Implemented, tested, PR opened. **NOT merged** (per instructions).

## Why

`micropip.install("duckdb")` cannot ever succeed inside browser Pyodide — PyPI
only ships **native** wheels (manylinux/macosx/win) for the `duckdb` package;
there is no pure-Python/wasm build in the Pyodide lockfile at all. Before this
hotfix, `ensureDuckdbInPyodide()` honestly detected that failure but the only
fallback with access to real registered tables was `runViaPyodidePandasCount`
— a narrow `SELECT COUNT(*) FROM t` matcher. Anything else (`SUM`, `GROUP BY`,
`JOIN`, `WHERE`, ...) fell straight through to webR's equally narrow
COUNT(*)-only path or the honest `pyodide-sql-unavailable` error. Real
second-engine SQL corroboration was never actually possible for anything but
a bare row count.

## Solution shipped

Added a new rung to the second-engine bridge in
`js/proof-harness/data-glow-proof-harness-canvas.js` using Python's stdlib
`sqlite3` module — always present in Pyodide, no network, no micropip:

- **`buildSqliteRegisterAndQuerySnippet(statement, tableNames)`** (pure
  helper): generates Python that opens a fresh `sqlite3.connect(":memory:")`,
  loads every `dg_csv_<table>` global via `pd.read_csv` +
  `df.to_sql(table, conn, index=False, if_exists="replace")`, then runs the
  caller's `statement` via `pandas.read_sql_query` and serializes
  `{columns, rows, rowCount}` as JSON (`default=str` for non-JSON-native
  values). Wrapped in `try/except/finally` so any dialect/runtime failure
  sets an error flag instead of throwing past the Pyodide call boundary, and
  the connection is always closed.
- **`runViaPyodideSqlite(py, statement)`**: discovers tables via the existing
  `listCsvGlobalTableNames`, runs the snippet above, and returns
  `{ rowCount, rows, scalars, engine: 'pyodide-sqlite', tablesRegistered }` on
  success, `{ error }` on a genuine SQL/dialect failure, or `null` when there
  is nothing to run at all (caller falls through, same contract as the
  duckdb path).
- **`runProofSecondEngineBridge`** priority order updated to match the spec
  exactly:
  1. `pyodide-duckdb` (if `import duckdb` already works — rare, kept for a
     future Pyodide lockfile)
  2. **`pyodide-sqlite`** full SQL — NEW default path for real corroboration
  3. `pyodide-pandas` narrow `COUNT(*)` (fallback if sqlite errors or finds
     no tables)
  4. trivial literal `SELECT <n>`
  5. hardened webR (never invents `n=0`)
  6. `{error:'pyodide-sql-unavailable'}`

## Honesty guarantees preserved

- Engine is tagged `pyodide-sqlite`, **never** `pyodide-duckdb`, unless
  duckdb genuinely ran.
- DuckDB-only syntax (QUALIFY, some list comprehensions, DuckDB-specific
  functions) may legitimately fail against sqlite — this surfaces as an
  honest error, never a fabricated row.
- Fresh `sqlite3.connect(":memory:")` and `if_exists="replace"` registration
  on **every** call — no stale-table caching across a dataset swap (same
  discipline as the duckdb path's "always re-register").
- Capability note: second-engine full SQL is SQLite's dialect in Python, not
  a second DuckDB.

## Files touched

- `js/proof-harness/data-glow-proof-harness-canvas.js` — added
  `buildSqliteRegisterAndQuerySnippet`, `runViaPyodideSqlite`, and rewired
  `runProofSecondEngineBridge`'s priority order. No other second-engine
  helper, and no canvas UI/panel code, was touched.
- `test/hotfix-second-engine-sqlite-sql.test.mjs` — **new**, 59 assertions.
- `test/proof-harness-v1-2-second-engine-depth.test.mjs` — updated its
  hand-assembled mock-bridge harness to also include the two new functions
  (otherwise the real, extracted `runProofSecondEngineBridge` throws a
  `ReferenceError` on `runViaPyodideSqlite` before ever reaching that file's
  pandas/literal/webR scenarios). No assertions in that file were changed;
  it now passes 83/83 (unchanged assertion count) against the real shipped
  bridge with the new sqlite rung inserted.

`js/proof-harness/second-engine.js` (the pure corroboration comparator) was
**not** touched — it already reads `rowCount`/`scalars` generically and needs
no changes to consume the new `pyodide-sqlite` engine tag.

## Concurrency note

Another agent was concurrently shipping PH v2 (adversary/excel/mesh) in the
same shared working tree (`js/proof-harness/index.js`,
`js/proof-harness/verdict.js`, new `adversary.js` / `excel-claim.js` /
`mesh-attestation.js` files, and `PROOF_HARNESS_V2_SPEC.md`). Per
instructions, this hotfix touched only `data-glow-proof-harness-canvas.js`
(the second-engine bridge) and its own tests; `index.js`, `verdict.js`, and
the v2 files were left completely alone and are **not** part of this branch's
commit. The canvas file was re-diffed against the branch HEAD immediately
before the final commit to confirm no unexpected content had been injected —
the diff contained exactly this hotfix's own changes, nothing else.

## Tests

All run with `node <file>.mjs`:

| File | Result |
|---|---|
| `test/hotfix-second-engine-sqlite-sql.test.mjs` (new) | **59 passed, 0 failed** |
| `test/proof-harness-v1-2-second-engine-depth.test.mjs` (harness updated) | **83 passed, 0 failed** |
| `test/proof-harness-v1-1-bridge.test.mjs` (regression) | 28 passed, 0 failed |
| `test/proof-harness-v0-engine-window.test.mjs` (regression) | 18 passed, 0 failed |

New/updated total: **142 passed, 0 failed** across the two files this hotfix
owns.

Coverage of the spec's "Tests" section:

1. Register + `SELECT COUNT(*) AS n FROM t` → n matches — covered.
2. `SELECT SUM(x) AS s FROM t` works (plus a `WHERE`-filtered `COUNT`) —
   covered; this is the capability the old pandas-only fallback could never
   provide.
3. Priority: sqlite preferred over pandas when both possible — covered
   (asserts the narrow pandas path is never even invoked once sqlite
   answers).
4. Engine tag is `pyodide-sqlite` — covered, plus an explicit "never
   `pyodide-duckdb`" honesty check.
5. Existing pandas COUNT / literal / webR tests still pass — covered via
   both the new file's regression section and by fixing
   `proof-harness-v1-2-second-engine-depth.test.mjs`'s harness to include
   the new functions so its pre-existing 83 assertions keep passing against
   the real shipped bridge.

## PR

Branch `fix/second-engine-pyodide-sqlite-sql` pushed to origin. **Not
merged**, per instructions.
