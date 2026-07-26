# Bundle 18 Hotfix 5 result: Drill Floor <-> shared live DuckDB

## Root cause (confirmed against BUNDLE18_HOTFIX5_SPEC.md)

The main SQL view PASSes `SELECT 1` (`1 row - 22ms - DuckDB-WASM`) through a
working chain: `SQLEngine.init(...).runQuery` calls `createDuckDBAdapter().query`,
which shares one `ensureInit()` (CDN wasm first, per #612). That engine is real
and live.

Drill Floor's canvas shell, however, resolved SQL only as:

```js
var runQuery = (window.engine && window.engine.runQuery)
  || (window.DuckDBEngine && window.DuckDBEngine.runQuery)
  || null;
// else: "SQL engine not ready in this canvas."
```

Nothing in canvas ever assigned `window.engine`, `window.DuckDBEngine`, or
`window.SQLEngine`. The only working engine lived in a local `var SQLEngine`
IIFE plus a module-private `getSQLEngine()` / `sqlEngineInstance`, used
exclusively by the main SQL view's own render/init path. So Drill Floor's Run
and Check buttons always fell straight through to the literal error string
`SQL engine not ready in this canvas.`, live strict proof on
`#dg-drill-sql-out`, even while the main SQL view's own connection was
working fine one panel over.

## Fix (canvas/index.html, authoritative)

1. **Exported the factory.** Right after the `SQLEngine` IIFE closes:
   `window.SQLEngine = SQLEngine;` (kept the existing local `var SQLEngine`
   name; this is a plain reference assignment, no new load path).

2. **Published the live singleton** the moment `getSQLEngine()` first
   creates it:
   - `window._sqlEngineSingleton = sqlEngineInstance;`
   - `window.DuckDBEngine = sqlEngineInstance;`
   - `window.engine = sqlEngineInstance;`
   - `window._dgGetSQLEngine = getSQLEngine;`

   This runs once, at creation time, before `getSQLEngine()` returns the
   instance to its own caller, so every later reader (including Drill Floor)
   sees the SAME object the main SQL view is already using.

3. **`resolveDrillSqlRunQuery()`**, a new shared resolver used by both the
   Drill Floor Run and Check paths (Check only ever scores whatever Run's
   handler already produced, so wiring Run is sufficient for both):
   - Prefer `window.engine.runQuery` / `window.DuckDBEngine.runQuery`
     (unchanged preference order from the old code).
   - Else `window._sqlEngineSingleton.runQuery`.
   - Else, if `window._dgGetSQLEngine` is in scope, `await` it then use its
     `runQuery`.
   - Else, if `window.SQLEngine.init` is reachable, bootstrap the singleton
     once (reusing it on any later call) and use its `runQuery`.
   - Else, if `window.duckdbConn.query` is reachable, wrap it into the same
     `{ columns, rows }` shape the rest of the drill code already expects.
   - Else `null`, and the drill Run handler still shows the exact same
     `SQL engine not ready in this canvas.` string for the true-unready case.

   Every resolved path is wrapped so the function handed to drill code has
   the `(sql) => Promise` shape the drill injects, internally always calling
   `engine.runQuery(sql, [])`: drill tables are registered directly against
   the shared DB by `loadDrillTables()`, so the query path never needs to
   re-register a dataset to see `drill_*` tables.

4. **`ensureDrillTablesLoaded(runQuery)`**: calls the existing
   `window.DrillFloorData.loadDrillTables({ runQuery })` once per session,
   guarded by a module-level flag so repeat Runs and repeat panel opens are
   no-ops after the first successful load. Wired into two places:
   - Best-effort at `mountDrillFloor()` time (panel open), swallowing any
     error silently since the engine may not be ready yet.
   - Awaited before every SQL Run, so the very first Run after a cold
     open still loads the tables on demand if the panel-open preload
     could not run yet.

   Only the dedicated `drill_orders` / `drill_promos` (+ Bundle 18 archetype
   tables) names are ever created; user-loaded dataset tables are never
   touched.

5. **Starter SQL**: "Spot the Sale" already had a valid, non-empty
   `starterSql` with a golden answer of `rowCount: 133`. Unchanged by this
   hotfix; Check can score immediately after Run.

6. **Mirrored the trivial export** in `js/sql/sql-engine.js`
   (`window.SQLEngine = SQLEngine;`) to keep it in sync with the canvas
   splice. The rest of that file has materially diverged from the canvas
   IIFE across hotfixes 1 through 4 (self-host/CDN-first loading, timeout
   guards, CSV quarantine handling are canvas-only so far), so it is not the
   literal source of the canvas splice today; only the safe, behavior-neutral
   export line was mirrored, per the spec's "only if it is the source"
   guidance. `js/app-shell/duckdb-engine.js` (the root `index.html` module
   path) was not touched.

## What did not change

- No second wasm load path, no new DuckDB connection, no new feature flag.
  The existing `drillFloor` flag path is reused as-is.
- `js/drill-floor/drill-floor.js` (the ESM module) has no `mountDrillFloor`
  function at all today; that function, and therefore the Run/Check wiring
  this hotfix touches, only exists in canvas. The ESM module's exported
  `DRILLS` / `getDrill` / `scoreDrillAnswer` / `extractRowCount` are
  untouched and still agree with canvas (`spot-the-sale` golden `rowCount:
  133`).
- `extractRowCount` still prefers an explicit `rowCount` field and falls
  back to `rows.length`, which is what the real `query()` return shape
  (`{ columns, rows, durationMs }`, no `rowCount` field) needs.

## Files changed

- `canvas/index.html` (authoritative): `window.SQLEngine` export,
  `getSQLEngine()` singleton publish, `resolveDrillSqlRunQuery()`,
  `ensureDrillTablesLoaded()`, and the Drill Floor Run handler's SQL branch.
- `js/sql/sql-engine.js`: mirrored `window.SQLEngine` export only.
- `canvas/integrity.manifest.json`: `canvasBytes` updated to match the
  edited `canvas/index.html` size.
- `test/bundle18-hotfix5-drill-shared-engine.test.mjs`: new test file (see
  below).
- `BUNDLE18_HOTFIX5_RESULT.md`: this file.

## Tests

`node --test test/bundle18-hotfix5-drill-shared-engine.test.mjs` - static,
no-network, no-browser assertions on `canvas/index.html` source plus the
`js/drill-floor/drill-floor.js` ESM module import, covering:

- `window.SQLEngine = SQLEngine` (and its `js/sql/sql-engine.js` mirror).
- `getSQLEngine()` assigns `window.DuckDBEngine` / `window.engine` /
  `window._sqlEngineSingleton` / `window._dgGetSQLEngine` from the live
  singleton, before returning it.
- The Drill Floor SQL path no longer resolves ONLY via the old two-global
  check with a hard `null` fallback; it now calls
  `resolveDrillSqlRunQuery()`, which itself tries every fallback layer in
  order and still returns `null` (not a throw) for the true-unready case,
  which still surfaces the identical `SQL engine not ready in this canvas.`
  string.
- `ensureDrillTablesLoaded()` wires the existing `loadDrillTables()`, loads
  once per session, and is called both at panel-open and before the first
  SQL Run.
- `extractRowCount` still resolves `rows.length` on the `{ columns, rows }`
  shape.
- The `spot-the-sale` golden answer is untouched at `rowCount: 133`, in both
  canvas and the ESM module, and its `starterSql` is present.
- No em dash (U+2014) in any newly-edited region.
- No new feature flag name introduced.
- `canvas/integrity.manifest.json` `canvasBytes` matches the edited file.

All 9 describe blocks / 32 individual assertions pass locally under Node v20.

## Definition of done (this hotfix's portion)

- [x] PR opened (see PR link returned alongside this file), CI to run.
- [ ] Live republish of site_id `de9dce04-e555-4b78-979f-9a036db4599a` -- not
      performed by this hotfix; parent handles publish after merge.
- [ ] Honest Playwright confirmation (main SQL `SELECT 1` PASS, Drill Floor
      Spot the Sale Run then Check -> `pass:true` / expected 133 / got 133)
      -- requires a live/published environment; not run in this sandbox,
      which has no network access and no browser runtime for the canvas.
      The static test suite above is the strongest verification available
      in this environment; the parent agent should run the Playwright check
      against the republished site before merge.

Branch: `feat/bundle18-hotfix5-drill-shared-engine`. Not merged, not
published, per instructions.
