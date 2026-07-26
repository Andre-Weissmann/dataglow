// ============================================================
// DATAGLOW - Bundle 18 hotfix 5: Drill Floor <-> shared live DuckDB
// ============================================================
// ROOT CAUSE (verified live 2026-07-26, see BUNDLE18_HOTFIX5_SPEC.md):
// the main SQL view PASSes `SELECT 1` via SQLEngine.init(...).runQuery /
// createDuckDBAdapter().query / the shared ensureInit() (CDN wasm first
// after #612). Drill Floor's canvas shell, though, only ever resolved SQL
// as `(window.engine && window.engine.runQuery) || (window.DuckDBEngine &&
// window.DuckDBEngine.runQuery) || null`, and canvas never assigned
// window.engine, window.DuckDBEngine, or window.SQLEngine anywhere -- so
// Drill Floor always fell straight through to the literal string
// "SQL engine not ready in this canvas.", live strict proof on
// #dg-drill-sql-out, even while the main SQL view's own DuckDB connection
// was live and working.
//
// FIX (canvas/index.html, authoritative):
//   1. `window.SQLEngine = SQLEngine;` exported right after the SQLEngine
//      IIFE (local `var SQLEngine` name kept as-is).
//   2. getSQLEngine() now publishes the live singleton the moment it is
//      first created: window._sqlEngineSingleton, window.DuckDBEngine,
//      window.engine, and window._dgGetSQLEngine (= getSQLEngine itself).
//   3. A new resolveDrillSqlRunQuery() replaces the brittle two-global
//      lookup in the Drill Floor shell (both Run and Check paths, since
//      Check only ever scores whatever the Run handler already produced):
//      prefers window.engine/window.DuckDBEngine, then
//      window._sqlEngineSingleton, then getSQLEngine() if in scope, then
//      window.SQLEngine.init() as a last-resort singleton bootstrap, then
//      a raw window.duckdbConn.query() wrapper, else null with the exact
//      same clear error string as before for the true-unready case.
//   4. ensureDrillTablesLoaded() calls the existing loadDrillTables() with
//      the resolved runQuery once per session (on first panel open AND
//      before first SQL Run, whichever comes first), so drill_orders /
//      drill_promos (+ Bundle 18 archetype tables) land in the SAME live
//      DB the resolver just proved is reachable, never wiping user tables.
//   5. Starter SQL for "Spot the Sale" already existed and is unchanged;
//      this hotfix does not touch DRILLS content.
//
// No second wasm load path is introduced anywhere. No new feature flag is
// required: the existing `drillFloor` flag path is reused as-is.
//
// This is a static/pure-module test file (no browser launch).
//
// RUN WITH:  node --test test/bundle18-hotfix5-drill-shared-engine.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const EM_DASH = '\u2014';

function readRepoFile(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

const canvas = readRepoFile(join('canvas', 'index.html'));

// ------------------------------------------------------------
// A. window.SQLEngine export, right after the SQLEngine IIFE.
// ------------------------------------------------------------

describe('bundle18 hotfix5 A: canvas exports window.SQLEngine from the local SQLEngine IIFE', () => {
  it('canvas source contains `window.SQLEngine = SQLEngine;` after the IIFE closes', () => {
    assert.match(canvas, /window\.SQLEngine = SQLEngine;/);
  });

  it('the export sits after the SQLEngine IIFE closes, not inside it (still reachable from outer scope)', () => {
    const iifeIdx = canvas.indexOf('var SQLEngine = (function () {');
    assert.notEqual(iifeIdx, -1, 'var SQLEngine IIFE not found');
    const closeIdx = canvas.indexOf('\n})();', iifeIdx);
    assert.notEqual(closeIdx, -1);
    const exportIdx = canvas.indexOf('window.SQLEngine = SQLEngine;', iifeIdx);
    assert.ok(exportIdx !== -1 && exportIdx > closeIdx, 'window.SQLEngine export must come after the IIFE close');
  });

  it('the local `var SQLEngine` binding name is kept as-is (spec requires no rename)', () => {
    assert.match(canvas, /var SQLEngine = \(function \(\) \{/);
  });

  it('js/sql/sql-engine.js mirrors the same window.SQLEngine export (kept in sync)', () => {
    const src = readRepoFile(join('js', 'sql', 'sql-engine.js'));
    assert.match(src, /window\.SQLEngine = SQLEngine;/);
  });
});

// ------------------------------------------------------------
// B. getSQLEngine() publishes the live singleton on every reachable global.
// ------------------------------------------------------------

describe('bundle18 hotfix5 B: getSQLEngine() publishes the live singleton', () => {
  it('canvas assigns window._sqlEngineSingleton, window.DuckDBEngine, and window.engine from sqlEngineInstance', () => {
    const idx = canvas.indexOf('function getSQLEngine() {');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 1200);
    assert.match(region, /window\._sqlEngineSingleton = sqlEngineInstance;/);
    assert.match(region, /window\.DuckDBEngine = sqlEngineInstance;/);
    assert.match(region, /window\.engine = sqlEngineInstance;/);
  });

  it('canvas also publishes window._dgGetSQLEngine = getSQLEngine for a scoped fallback path', () => {
    const idx = canvas.indexOf('function getSQLEngine() {');
    const region = canvas.slice(idx, idx + 1200);
    assert.match(region, /window\._dgGetSQLEngine = getSQLEngine;/);
  });

  it('the publish happens at singleton-creation time, before the function returns it', () => {
    const idx = canvas.indexOf('function getSQLEngine() {');
    const region = canvas.slice(idx, idx + 1200);
    const createIdx = region.indexOf('sqlEngineInstance = SQLEngine.init(');
    const publishIdx = region.indexOf('window._sqlEngineSingleton = sqlEngineInstance;');
    const returnIdx = region.indexOf('return Promise.resolve(sqlEngineInstance);', publishIdx);
    assert.ok(createIdx !== -1 && publishIdx !== -1 && returnIdx !== -1);
    assert.ok(createIdx < publishIdx && publishIdx < returnIdx, 'publish must happen after creation and before return');
  });
});

// ------------------------------------------------------------
// C. Drill Floor shared resolver: no longer a brittle two-global check with
//    no fallback, and the true-unready case still has a clear error string.
// ------------------------------------------------------------

describe('bundle18 hotfix5 C: resolveDrillSqlRunQuery() replaces the brittle two-global lookup', () => {
  it('resolveDrillSqlRunQuery is defined in canvas', () => {
    assert.match(canvas, /function resolveDrillSqlRunQuery\(\) \{/);
  });

  it('the drill Run path (SQL branch) no longer inlines the old two-global-only check with a hard null fallback', () => {
    // The literal old brittle expression must not appear anywhere feeding
    // the drill Run click handler. It's fine for the OLD shape to appear
    // only inside a comment describing the root cause (prose), never as
    // live code assigning `runQuery`.
    const codeOnly = canvas
      .split('\n')
      .map((line) => (line.trim().startsWith('//') ? '' : line.replace(/\/\/.*$/, '')))
      .join('\n');
    assert.doesNotMatch(
      codeOnly,
      /var runQuery = \(window\.engine && window\.engine\.runQuery\) \|\| \(window\.DuckDBEngine && window\.DuckDBEngine\.runQuery\) \|\| null;/
    );
  });

  it('the drill Run SQL branch calls resolveDrillSqlRunQuery() instead of the old inline lookup', () => {
    const idx = canvas.indexOf('function wireRun(lang, btnId, inId, outId) {');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 1600);
    assert.match(region, /resolveDrillSqlRunQuery\(\)/);
  });

  it('resolver tries window.engine / window.DuckDBEngine first, preserving the original preferred globals', () => {
    const idx = canvas.indexOf('function resolveDrillSqlRunQuery() {');
    const region = canvas.slice(idx, idx + 2400);
    assert.match(region, /window\.engine && typeof window\.engine\.runQuery === 'function'/);
    assert.match(region, /window\.DuckDBEngine && typeof window\.DuckDBEngine\.runQuery === 'function'/);
  });

  it('resolver falls back to window._sqlEngineSingleton, then a getSQLEngine()-shaped scoped fallback, then window.SQLEngine.init(), then window.duckdbConn.query()', () => {
    const idx = canvas.indexOf('function resolveDrillSqlRunQuery() {');
    const region = canvas.slice(idx, idx + 2600);
    assert.match(region, /window\._sqlEngineSingleton && typeof window\._sqlEngineSingleton\.runQuery === 'function'/);
    assert.match(region, /typeof window\._dgGetSQLEngine === 'function'/);
    assert.match(region, /window\.SQLEngine && typeof window\.SQLEngine\.init === 'function'/);
    assert.match(region, /window\.duckdbConn && typeof window\.duckdbConn\.query === 'function'/);
  });

  it('resolver returns null (not a throw) when nothing is reachable, and the true-unready case still shows the exact same clear error string', () => {
    const idx = canvas.indexOf('function resolveDrillSqlRunQuery() {');
    const region = canvas.slice(idx, idx + 3000);
    assert.match(region, /return null;\s*\n\}/);

    const wireIdx = canvas.indexOf('function wireRun(lang, btnId, inId, outId) {');
    const wireRegion = canvas.slice(wireIdx, wireIdx + 1600);
    assert.match(wireRegion, /if \(!drillRunQuery\) \{\s*\n\s*p = Promise\.resolve\(\{ error: 'SQL engine not ready in this canvas\.' \}\);/);
  });

  it('the resolved runQuery is called with an empty datasets array for drill CREATE/SELECT (drill_* tables already registered in the same DB)', () => {
    const idx = canvas.indexOf('function _dgWrapEngineRunQuery(engineObj) {');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 700);
    assert.match(region, /engineObj\.runQuery\(sql, \[\]\)/);
  });
});

// ------------------------------------------------------------
// D. Drill tables are loaded into the same live DB, once per session, on
//    panel open and/or first SQL Run, without wiping user tables.
// ------------------------------------------------------------

describe('bundle18 hotfix5 D: ensureDrillTablesLoaded() wires loadDrillTables() with the resolved runQuery', () => {
  it('ensureDrillTablesLoaded is defined and calls the existing window.DrillFloorData.loadDrillTables', () => {
    const idx = canvas.indexOf('function ensureDrillTablesLoaded(runQuery) {');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 700);
    assert.match(region, /dfd\.loadDrillTables\(\{ runQuery: runQuery \}\)/);
  });

  it('ensureDrillTablesLoaded only loads once per session (module-level loaded flag, short-circuits on repeat calls)', () => {
    assert.match(canvas, /var _dgDrillTablesLoaded = false;/);
    const idx = canvas.indexOf('function ensureDrillTablesLoaded(runQuery) {');
    const region = canvas.slice(idx, idx + 700);
    assert.match(region, /if \(_dgDrillTablesLoaded\) return Promise\.resolve\(\);/);
    assert.match(region, /_dgDrillTablesLoaded = true;/);
  });

  it('the drill Run SQL branch awaits ensureDrillTablesLoaded(drillRunQuery) before running the drill SQL', () => {
    const idx = canvas.indexOf('function wireRun(lang, btnId, inId, outId) {');
    const region = canvas.slice(idx, idx + 1600);
    const ensureIdx = region.indexOf('ensureDrillTablesLoaded(drillRunQuery)');
    const runIdx = region.indexOf('runDrillSql(code, { runQuery: drillRunQuery })');
    assert.ok(ensureIdx !== -1 && runIdx !== -1 && ensureIdx < runIdx, 'tables must be ensured loaded before running drill SQL');
  });

  it('the Drill Floor panel also preloads drill tables best-effort at mount/open time (mountDrillFloor)', () => {
    const idx = canvas.indexOf('function mountDrillFloor(opts) {');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 900);
    assert.match(region, /resolveDrillSqlRunQuery\(\)/);
    assert.match(region, /ensureDrillTablesLoaded\(_preloadRunQuery\)/);
  });

  it('only dedicated drill_* table names are ever loaded (no user-table collision)', () => {
    assert.match(canvas, /const DRILL_ORDERS_TABLE = 'drill_orders';/);
    assert.match(canvas, /const DRILL_PROMOS_TABLE = 'drill_promos';/);
  });
});

// ------------------------------------------------------------
// E. extractRowCount still works on the { columns, rows } shape (rows.length),
//    since query() returns that shape with no explicit rowCount field.
// ------------------------------------------------------------

describe('bundle18 hotfix5 E: extractRowCount still supports the { columns, rows } shape', () => {
  it('extractRowCount is defined and falls back to rows.length when rowCount is absent', () => {
    const idx = canvas.indexOf('function extractRowCount(queryResult) {');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 300);
    assert.match(region, /if \(typeof queryResult\.rowCount === 'number'\) return queryResult\.rowCount;/);
    assert.match(region, /if \(Array\.isArray\(queryResult\.rows\)\) return queryResult\.rows\.length;/);
  });

  it('behaviorally returns rows.length for a { columns, rows } result with no rowCount field (the real query() return shape)', () => {
    // extractRowCount is a pure global function statement in canvas; evaluate
    // it in an isolated scope to exercise the actual logic without needing a
    // browser or DuckDB.
    const idx = canvas.indexOf('function extractRowCount(queryResult) {');
    const endIdx = canvas.indexOf('\n}', idx) + 2;
    const src = canvas.slice(idx, endIdx);
    const fn = new Function(`${src}\nreturn extractRowCount;`)();
    assert.equal(fn({ columns: [{ name: 'a' }], rows: [{ a: 1 }, { a: 2 }] }), 2);
    assert.equal(fn({ rowCount: 5, rows: [{ a: 1 }] }), 5);
    assert.equal(fn(null), null);
    assert.equal(fn({}), null);
  });
});

// ------------------------------------------------------------
// F. Spot the Sale golden answer stays rowCount 133 (unchanged by this hotfix).
// ------------------------------------------------------------

describe('bundle18 hotfix5 F: Spot the Sale golden answer is untouched (rowCount 133)', () => {
  it('canvas DRILLS still carries goldenAnswers.sql.rowCount === 133 for spot-the-sale', () => {
    const idx = canvas.indexOf("id: 'spot-the-sale',");
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 1600);
    assert.match(region, /goldenAnswers:\s*\{\s*\n\s*sql:\s*\{\s*rowCount:\s*133,/);
  });

  it('the drill-floor.js ESM module (js/drill-floor/drill-floor.js) agrees: spot-the-sale golden rowCount is 133', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    const drill = mod.getDrill('spot-the-sale');
    assert.ok(drill, 'spot-the-sale drill missing from js/drill-floor/drill-floor.js');
    assert.equal(drill.goldenAnswers.sql.rowCount, 133);
  });

  it('scoreDrillAnswer in the ESM module passes when given a { columns, rows } SQL result with 133 rows', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    const fakeRows = Array.from({ length: 133 }, (_, i) => ({ order_id: i }));
    const score = mod.scoreDrillAnswer('spot-the-sale', 'sql', { result: { columns: [], rows: fakeRows }, rowCount: 133 });
    assert.equal(score.pass, true);
    assert.equal(score.expected, 133);
    assert.equal(score.got, 133);
  });

  it('starterSql for spot-the-sale is present and non-empty, so Check can score right after Run', () => {
    const idx = canvas.indexOf("id: 'spot-the-sale',");
    const region = canvas.slice(idx, idx + 2000);
    const starterIdx = region.indexOf('starterSql:');
    assert.notEqual(starterIdx, -1);
    assert.match(region.slice(starterIdx, starterIdx + 400), /SELECT/);
  });
});

// ------------------------------------------------------------
// G. No em dash in new user-visible strings, and no new feature flag needed.
// ------------------------------------------------------------

describe('bundle18 hotfix5 G: style + flag-scope guardrails', () => {
  it('no em dash (U+2014) anywhere in the newly-edited resolver/loader region', () => {
    const idx = canvas.indexOf('Bundle 18 hotfix 5: shared live-engine resolver for Drill Floor SQL.');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx - 50, idx + 6000);
    assert.doesNotMatch(region, new RegExp(EM_DASH));
  });

  it('no em dash in the getSQLEngine() singleton-publish region', () => {
    const idx = canvas.indexOf('function getSQLEngine() {');
    const region = canvas.slice(idx, idx + 1200);
    assert.doesNotMatch(region, new RegExp(EM_DASH));
  });

  it('no em dash in the window.SQLEngine export comment region', () => {
    const idx = canvas.indexOf('window.SQLEngine = SQLEngine;');
    const region = canvas.slice(idx - 400, idx + 50);
    assert.doesNotMatch(region, new RegExp(EM_DASH));
  });

  it('the exact user-visible error string has no em dash', () => {
    assert.doesNotMatch('SQL engine not ready in this canvas.', new RegExp(EM_DASH));
  });

  it('no new feature flag name is introduced; the existing drillFloor flag path is reused as-is', () => {
    assert.match(canvas, /drillFloor: true,/);
    const idx = canvas.indexOf('function resolveDrillSqlRunQuery() {');
    const region = canvas.slice(idx, idx + 3000);
    assert.doesNotMatch(region, /isEnabled\('drillFloorSharedEngine'\)/);
    assert.doesNotMatch(region, /DataGlowFlags/);
  });
});

// ------------------------------------------------------------
// H. Sanity: canvasBytes in the manifest matches the actual file size (this
//    hotfix edits canvas/index.html, so the manifest must track the change).
// ------------------------------------------------------------

describe('bundle18 hotfix5 H: canvas integrity manifest byte count matches the edited file', () => {
  it('canvasBytes in the manifest matches the current canvas/index.html size', () => {
    const manifest = JSON.parse(readRepoFile(join('canvas', 'integrity.manifest.json')));
    const bytes = statSync(join(REPO_ROOT, 'canvas', 'index.html')).size;
    assert.equal(manifest.canvasBytes, bytes);
  });
});

// ------------------------------------------------------------
// I. Result doc documents the root cause and the fix.
// ------------------------------------------------------------

describe('bundle18 hotfix5 I: BUNDLE18_HOTFIX5_RESULT.md documents root cause and fix', () => {
  it('the result doc exists and names the shared-engine root cause and fix', () => {
    const doc = readRepoFile('BUNDLE18_HOTFIX5_RESULT.md');
    assert.match(doc, /window\.engine/);
    assert.match(doc, /window\.DuckDBEngine/);
    assert.match(doc, /resolveDrillSqlRunQuery/i);
    assert.match(doc, /SQL engine not ready in this canvas/);
    assert.doesNotMatch(doc, new RegExp(EM_DASH));
  });
});
