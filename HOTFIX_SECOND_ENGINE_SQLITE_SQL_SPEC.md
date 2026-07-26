# Hotfix SPEC — Second-engine full SQL via Pyodide SQLite

**Baseline:** main after #623 (`8d92d16` or current)  
**Why:** `micropip.install("duckdb")` cannot work in browser Pyodide. PyPI ships only **native** wheels (manylinux/macosx/win); there is no duckdb package in the Pyodide lockfile. Live path correctly fell to `pyodide-pandas` for `COUNT(*)` only. User asked for full arbitrary SQL residual.

## Solution

Use Pyodide's **stdlib `sqlite3`** (always present, no network, no micropip):

1. For each `dg_csv_*` global → `pd.read_csv` → `df.to_sql(table_name, conn, index=False, if_exists='replace')` on `sqlite3.connect(':memory:')`
2. Execute the proof `statement` via `pandas.read_sql_query` or cursor
3. Return `{ engine: 'pyodide-sqlite', tablesRegistered, rowCount, rows, scalars }`

## Bridge priority (replace current order in `runProofSecondEngine`)

1. `pyodide-duckdb` if `import duckdb` already succeeds (rare; keep)
2. **`pyodide-sqlite` full SQL** (new default for real tables)
3. `pyodide-pandas` narrow COUNT only (fallback if sqlite path throws)
4. literal `SELECT <n>`
5. hardened webR
6. unavailable

## Pure helpers (optional extract)

- `listCsvGlobalTableNames` already exists
- `buildSqliteRegisterAndQuerySnippet(statement, tableNames)` → Python code string
- Dialect honesty: if sqlite raises, return error (do not invent); UI may show engine name

## Honesty

- Label engine `pyodide-sqlite` never `pyodide-duckdb` unless duckdb actually ran
- DuckDB-only SQL (e.g. some list comprehensions, QUALIFY) may fail → RED/GRAY with error, not fake numbers
- Capability note: second engine full SQL is SQLite dialect in Python, not a second DuckDB

## Tests

`test/hotfix-second-engine-sqlite-sql.test.mjs`

1. Register + `SELECT COUNT(*) AS n FROM t` → n matches
2. `SELECT SUM(x) AS s FROM t` works
3. Priority: sqlite preferred over pandas when both possible
4. Engine tag is `pyodide-sqlite`
5. Existing pandas COUNT / literal / adversary tests still pass

## PR

Branch `fix/second-engine-pyodide-sqlite-sql`  
Do NOT merge.  
RESULT: `HOTFIX_SECOND_ENGINE_SQLITE_SQL_RESULT.md`
