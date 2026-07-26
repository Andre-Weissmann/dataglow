# Bundle 18 Hotfix 5 — Drill Floor ↔ shared live DuckDB

## Root cause (verified live 2026-07-26)

Main SQL view PASSes (`SELECT 1` → `1 row · 22ms · DuckDB-WASM`) via canvas
`SQLEngine.init(...).runQuery` / `createDuckDBAdapter().query` / shared
`ensureInit()` (CDN wasm first after #612).

Drill Floor canvas shell resolves SQL only as:

```js
var runQuery = (window.engine && window.engine.runQuery)
  || (window.DuckDBEngine && window.DuckDBEngine.runQuery)
  || null;
// else: "SQL engine not ready in this canvas."
```

But canvas never assigns `window.engine`, `window.DuckDBEngine`, or
`window.SQLEngine`. The working engine lives in a local `var SQLEngine` IIFE
plus `getSQLEngine()` / `sqlEngineInstance` used by the SQL view only.

Live strict proof: `#dg-drill-sql-out` = `SQL engine not ready in this canvas.`

## Goal

Drill Floor SQL Run + Check answer use the **same** DuckDB connection as the
main SQL view. No second wasm load path. No new product feature.

## Required changes (canvas/index.html is AUTHORITATIVE)

1. **Export the factory** after the SQLEngine IIFE:
   - `window.SQLEngine = SQLEngine;`
   (keep existing local `var SQLEngine` name)

2. **Publish the live singleton** wherever `sqlEngineInstance` is first created
   in `getSQLEngine()` (and any equivalent path):
   - `window._sqlEngineSingleton = sqlEngineInstance;`
   - `window.DuckDBEngine = sqlEngineInstance;`
   - `window.engine = sqlEngineInstance;`
   - Prefer also `window._dgGetSQLEngine = getSQLEngine` if getSQLEngine is in scope

3. **Drill Floor resolve helper** (canvas drill shell, both Run and Check paths):
   Replace the brittle two-global lookup with a shared resolver, e.g.
   `resolveDrillSqlRunQuery()` that returns a function `(sql) => Promise`:
   - Prefer `window.engine.runQuery` / `window.DuckDBEngine.runQuery`
   - Else if `window._sqlEngineSingleton?.runQuery`
   - Else if `typeof getSQLEngine === 'function'` → await getSQLEngine() then runQuery
   - Else if `window.SQLEngine?.init` → init once (reuse singleton if present) then runQuery
   - Else if `window.duckdbConn?.query` → wrap to `{ columns, rows }` shape
   - Else null → existing clear error string

   The returned runQuery must accept `(sql)` only (drill injects that). Internally
   call `engine.runQuery(sql, [])` or `engine.runQuery(sql, state.datasets||[])`
   — prefer **empty datasets array** for drill CREATE/SELECT against
   `drill_*` tables already registered in the same DB, OR pass datasets if that
   is what main path uses without dropping tables.

4. **Load drill tables** when Drill Floor panel first opens / first SQL Run,
   if not already loaded this session:
   - Call existing `loadDrillTables({ runQuery })` with the resolved runQuery
   - Tables: drill_orders, drill_promos (+ B18 tables when archetype flag on)
   - Must not wipe user tables; dedicated drill_* names only

5. **Starter SQL**: ensure Spot the Sale textarea has starter SQL so Check can
   score after Run (existing starters OK if present).

6. **Mirror in modular sources if present** (keep in sync):
   - `js/sql/sql-engine.js` only if it is the source of the canvas IIFE export
   - Do NOT break app-shell `js/app-shell/duckdb-engine.js` module path
   - Canvas remains authoritative for live publish

## Tests (Node, no network)

Add `test/bundle18-hotfix5-drill-shared-engine.test.mjs`:

- canvas source contains `window.SQLEngine = SQLEngine` (or equivalent assign)
- canvas source assigns `window.DuckDBEngine` and/or `window.engine` from the
  live SQL engine singleton
- canvas drill SQL path no longer ONLY checks engine/DuckDBEngine without fallback
- canvas still has the clear error string for true unready case
- extractRowCount still works on `{ columns, rows }` shape (rows.length)
- spot-the-sale golden still rowCount 133
- no em dash (U+2014) in new user-visible strings
- NO new feature flag required (wire existing `drillFloor` path)

## Out of scope

- A48 polish, Proof Harness v0 UI, ambient AI, career Lane C
- Python/R drill readiness (nice if free; not required for this hotfix PASS)
- R air-gap package bundling

## Definition of done

1. PR opened, CI green, squash-merged to main (parent handles merge confirm)
2. Live republish site_id `de9dce04-e555-4b78-979f-9a036db4599a`
3. Honest Playwright:
   - Main SQL still PASS `SELECT 1`
   - Drill Floor Spot the Sale: Run SQL then Check answer → **pass:true** /
     expected 133 / got 133 (not QuerySentinel, not quality-score)

## Ship notes

- Branch: `feat/bundle18-hotfix5-drill-shared-engine`
- Worktree: existing `/home/user/workspace/dataglow-f2133f3e-e20d9956` only
- Do NOT managed-clone
- Keep canvas/index.html integrity.manifest updated if the project requires it
- Result file: `BUNDLE18_HOTFIX5_RESULT.md`
