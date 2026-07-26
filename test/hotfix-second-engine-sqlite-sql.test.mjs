// ============================================================
// DATAGLOW - HOTFIX: second-engine full SQL via Pyodide stdlib sqlite3
// ============================================================
// HOTFIX_SECOND_ENGINE_SQLITE_SQL_SPEC.md: micropip.install("duckdb")
// cannot work in browser Pyodide -- PyPI ships only NATIVE wheels
// (manylinux/macosx/win) for the duckdb package; there is no such wheel in
// the Pyodide lockfile. This hotfix ships a full second-engine SQL path
// via Python's stdlib sqlite3 (always present, no network, no micropip):
// every dg_csv_* global is loaded via pandas.read_csv + df.to_sql into a
// fresh sqlite3 in-memory connection, then the proof statement runs via
// pandas.read_sql_query -- answering arbitrary SQL (SUM, GROUP BY, JOIN,
// WHERE, ...), not just the old narrow COUNT(*)-only pandas fallback.
//
// js/proof-harness/data-glow-proof-harness-canvas.js is a plain browser
// script (DOM + window.DataGlowPython + Pyodide + window.DataGlowR), not an
// ES module, so it cannot be imported directly. As in
// test/proof-harness-v1-2-second-engine-depth.test.mjs, this file extracts
// the ACTUAL function source out of the real shipped file with narrow,
// well-anchored markers and evaluates it in an isolated Function scope, so
// drift in the shipped source fails extraction loudly rather than silently
// testing a stale reimplementation.
//
// Covers HOTFIX_SECOND_ENGINE_SQLITE_SQL_SPEC.md "Tests" section:
//   1. Register + SELECT COUNT(*) AS n FROM t -> n matches
//   2. SELECT SUM(x) AS s FROM t works
//   3. Priority: sqlite preferred over pandas when both possible
//   4. Engine tag is pyodide-sqlite
//   5. Existing pandas COUNT / literal / adversary(webR) tests still pass
//      (regression, exercised via the same extracted bridge)
//
// RUN WITH: node test/hotfix-second-engine-sqlite-sql.test.mjs

import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

const canvasModuleSrc = readFileSync(new URL('../js/proof-harness/data-glow-proof-harness-canvas.js', import.meta.url), 'utf8');

/* ---- generic verbatim extractor: declaration-name -> brace-depth walk ---- */
function extractFunctionSource(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) return null;
  let depth = 0;
  let i = startIdx + startMarker.length - 1; // at the opening brace
  let endIdx = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }
  if (endIdx === -1) return null;
  return src.slice(startIdx, endIdx);
}

function loadFn(startMarker, fnName) {
  const fnSrc = extractFunctionSource(canvasModuleSrc, startMarker);
  ok(fnSrc !== null, `${fnName} is present verbatim in the shipped canvas module source with a matching closing brace`);
  if (!fnSrc) return null;
  // eslint-disable-next-line no-new-func
  return new Function(`${fnSrc}\nreturn ${fnName};`)();
}

const dgCsvGlobalReSrc = (() => {
  const m = /var DG_CSV_GLOBAL_RE = [^\n]+\n/.exec(canvasModuleSrc);
  ok(m !== null, 'the DG_CSV_GLOBAL_RE module-level regex constant is present verbatim in the shipped source');
  return m ? m[0] : 'var DG_CSV_GLOBAL_RE = /^dg_csv_(.+)$/;\n';
})();

function loadFnWithPrelude(prelude, startMarker, fnName) {
  const fnSrc = extractFunctionSource(canvasModuleSrc, startMarker);
  ok(fnSrc !== null, `${fnName} is present verbatim in the shipped canvas module source with a matching closing brace`);
  if (!fnSrc) return null;
  // eslint-disable-next-line no-new-func
  return new Function(`${prelude}${fnSrc}\nreturn ${fnName};`)();
}

// ---------------------------------------------------------------
// buildSqliteRegisterAndQuerySnippet -- pure helper, no Pyodide needed
// ---------------------------------------------------------------
const buildSqliteRegisterAndQuerySnippet = loadFn('function buildSqliteRegisterAndQuerySnippet(statement, tableNames) {', 'buildSqliteRegisterAndQuerySnippet');

if (buildSqliteRegisterAndQuerySnippet) {
  const snippet = buildSqliteRegisterAndQuerySnippet('SELECT COUNT(*) AS n FROM orders', ['orders', 'customers']);
  ok(typeof snippet === 'string' && snippet.length > 0, 'buildSqliteRegisterAndQuerySnippet returns a non-empty Python source string');
  ok(/import\s+.*sqlite3/.test(snippet), 'the generated snippet imports stdlib sqlite3 (no micropip, no network)');
  ok(!/micropip/i.test(snippet), 'the generated snippet never references micropip -- stdlib sqlite3 needs no install');
  ok(/pd\.read_csv/.test(snippet), 'the generated snippet reads each dataset via pandas read_csv');
  ok(/io\.StringIO/.test(snippet), 'pandas reads from an in-memory StringIO, never a filesystem path');
  ok(/sqlite3\.connect\(\s*":memory:"\s*\)/.test(snippet), 'a fresh in-memory sqlite3 connection is opened (spec: "always fresh, no cross-call caching")');
  ok(snippet.includes('"dg_csv_orders"'), 'the snippet looks up the dg_csv_orders global for the "orders" table');
  ok(snippet.includes('"dg_csv_customers"'), 'the snippet looks up the dg_csv_customers global for the "customers" table');
  ok(/\.to_sql\(\s*"orders"/.test(snippet), 'to_sql is called with the bare table name "orders" (naming parity with the duckdb path)');
  ok(/\.to_sql\(\s*"customers"/.test(snippet), 'to_sql is called with the bare table name "customers"');
  ok(/if_exists\s*=\s*"replace"/.test(snippet), 'to_sql uses if_exists="replace" so a re-run never collides with a stale prior table (spec A3 parity)');
  ok(!/\.to_sql\(\s*"dg_csv_/.test(snippet), 'to_sql is never called with the dg_csv_ prefixed global name -- only the bare table name');
  ok(/pd\.read_sql_query\(/.test(snippet), 'the proof statement is executed via pandas.read_sql_query');
  ok(snippet.includes('SELECT COUNT(*) AS n FROM orders'), 'the caller-supplied statement is embedded verbatim into the read_sql_query call');
  ok(/default\s*=\s*str/.test(snippet), 'json.dumps uses default=str so non-JSON-native values (Timestamp/Decimal/numpy scalar) degrade to a string instead of throwing');
  ok(/except Exception/.test(snippet), 'the snippet wraps registration+query in a try/except so a dialect/runtime failure is captured as an error flag, never an uncaught Python exception');
  ok(/_dg_second_engine_sqlite_error/.test(snippet), 'a dedicated error flag global is set on failure (spec: "if sqlite raises, return error, do not invent")');
  ok(/_dg_sqlite_conn\.close\(\)/.test(snippet), 'the sqlite connection is closed in a finally block regardless of success/failure');

  const emptySnippet = buildSqliteRegisterAndQuerySnippet('SELECT 1', []);
  ok(typeof emptySnippet === 'string' && /import\s+.*sqlite3/.test(emptySnippet) && !/\.to_sql\(/.test(emptySnippet), 'an empty table list still produces valid Python (imports + connect only, no registration calls)');

  const sqlInjectionAttempt = buildSqliteRegisterAndQuerySnippet('SELECT 1', ['orders"; import os #']);
  ok(!/import os/.test(sqlInjectionAttempt.split('\n').slice(1).join('\n')) || sqlInjectionAttempt.includes('orders___import_os__'), 'a table name with unsafe characters is sanitized before being embedded, not interpolated raw into a to_sql() call target');
}

// ---------------------------------------------------------------
// Bridge priority order verbatim source checks: pyodide-sqlite must sit
// between pyodide-duckdb and pyodide-pandas in runProofSecondEngineBridge.
// ---------------------------------------------------------------
{
  const bridgeSrc = extractFunctionSource(canvasModuleSrc, 'async function runProofSecondEngineBridge(statement) {');
  ok(bridgeSrc !== null, 'runProofSecondEngineBridge(statement) is present verbatim in the shipped source');
  if (bridgeSrc) {
    // Priority is verified within the primary (duckdb-unavailable) fall-
    // through branch -- the ONLY branch spec Tests #3's "sqlite preferred
    // over pandas when both possible" actually exercises on a real
    // device, since duckdb-in-pyodide is virtually always unavailable per
    // this hotfix's root cause. (The bridge also has an earlier
    // no-DataGlowPython-at-all short-circuit and a duckdb-succeeded-then-
    // statement-failed catch branch, each with their own independent
    // literal/webR calls that do not participate in this ordering.)
    const mainBranchSrc = bridgeSrc.slice(bridgeSrc.indexOf('duckdb-in-pyodide is unavailable'));
    const duckdbCallIdx = bridgeSrc.indexOf('runViaPyodideDuckdb(py, statement)');
    const sqliteCallIdx = bridgeSrc.indexOf('runViaPyodideSqlite(py, statement)');
    const sqliteMainIdx = mainBranchSrc.indexOf('runViaPyodideSqlite(py, statement)');
    const pandasMainIdx = mainBranchSrc.indexOf('runViaPyodidePandasCount(py, statement)');
    const literalMainIdx = mainBranchSrc.indexOf('evalTrivialLiteralSelect(statement)');
    const webrMainIdx = mainBranchSrc.indexOf('runViaWebRNarrowCount(statement)');
    ok(sqliteCallIdx !== -1, 'the bridge calls runViaPyodideSqlite(py, statement)');
    ok(duckdbCallIdx !== -1 && sqliteCallIdx !== -1 && duckdbCallIdx < sqliteCallIdx, 'PRIORITY: pyodide-duckdb is attempted before pyodide-sqlite');
    ok(sqliteMainIdx !== -1 && pandasMainIdx !== -1 && sqliteMainIdx < pandasMainIdx, 'PRIORITY: pyodide-sqlite is attempted before pyodide-pandas in the main (duckdb-unavailable) fall-through branch (spec: sqlite is now the default full-SQL path)');
    ok(pandasMainIdx !== -1 && literalMainIdx !== -1 && pandasMainIdx < literalMainIdx, 'PRIORITY: pyodide-pandas is attempted before the trivial literal probe in the main branch');
    ok(literalMainIdx !== -1 && webrMainIdx !== -1 && literalMainIdx < webrMainIdx, 'PRIORITY: the trivial literal probe is attempted before hardened webR in the main branch (webR remains last-resort)');
    ok(/pyodide-sqlite/.test(bridgeSrc), 'the bridge references the new pyodide-sqlite path by name');
  }

  const sqliteFnSrc = extractFunctionSource(canvasModuleSrc, 'async function runViaPyodideSqlite(py, statement) {');
  ok(sqliteFnSrc !== null, 'runViaPyodideSqlite(py, statement) is present verbatim in the shipped source');
  if (sqliteFnSrc) {
    ok(/engine:\s*'pyodide-sqlite'/.test(sqliteFnSrc), 'runViaPyodideSqlite tags its successful result engine: pyodide-sqlite (never pyodide-duckdb)');
    ok(!/engine:\s*'pyodide-duckdb'/.test(sqliteFnSrc), 'runViaPyodideSqlite never tags a result as pyodide-duckdb -- honesty per spec ("Label engine pyodide-sqlite never pyodide-duckdb unless duckdb actually ran")');
    ok(/tablesRegistered/.test(sqliteFnSrc), 'runViaPyodideSqlite reports tablesRegistered in its result shape (parity with the duckdb path)');
    ok(/listCsvGlobalTableNames\(py\.globals\)/.test(sqliteFnSrc), 'runViaPyodideSqlite discovers tables via the existing listCsvGlobalTableNames helper (spec: "listCsvGlobalTableNames already exists")');
  }
}

// ---------------------------------------------------------------
// End-to-end orchestration test: build a fake in-Pyodide "sqlite3" + pandas
// layer entirely in JS to prove registration + query works, without a real
// Pyodide runtime in Node.
// ---------------------------------------------------------------
{
  const bridgeSrc = extractFunctionSource(canvasModuleSrc, 'async function runProofSecondEngineBridge(statement) {');
  const ensureDuckdbSrc = extractFunctionSource(canvasModuleSrc, 'async function ensureDuckdbInPyodide(py) {');
  const registerSrc = extractFunctionSource(canvasModuleSrc, 'async function registerCsvGlobalsAsDuckdbTables(py) {');
  const listCsvSrc = extractFunctionSource(canvasModuleSrc, 'function listCsvGlobalTableNames(globalKeys) {');
  const buildSnippetSrc = extractFunctionSource(canvasModuleSrc, 'function buildRegisterPythonSnippet(tableNames) {');
  const runViaDuckdbSrc = extractFunctionSource(canvasModuleSrc, 'async function runViaPyodideDuckdb(py, statement) {');
  const evalTrivialSrc = extractFunctionSource(canvasModuleSrc, 'function evalTrivialLiteralSelect(statement) {');
  const parseCountSrc = extractFunctionSource(canvasModuleSrc, 'function parseCountStarFrom(statement) {');
  const runViaWebRSrc = extractFunctionSource(canvasModuleSrc, 'async function runViaWebRNarrowCount(statement) {');
  const withTimeoutSrc = extractFunctionSource(canvasModuleSrc, 'function withTimeout(promise, ms) {');
  const runViaPandasSrc = extractFunctionSource(canvasModuleSrc, 'async function runViaPyodidePandasCount(py, statement) {');
  const buildSqliteSnippetSrc = extractFunctionSource(canvasModuleSrc, 'function buildSqliteRegisterAndQuerySnippet(statement, tableNames) {');
  const runViaSqliteSrc = extractFunctionSource(canvasModuleSrc, 'async function runViaPyodideSqlite(py, statement) {');
  const bridgeSrc2 = bridgeSrc;

  const allPresent = [bridgeSrc2, ensureDuckdbSrc, registerSrc, listCsvSrc, buildSnippetSrc, runViaDuckdbSrc, evalTrivialSrc, parseCountSrc, runViaWebRSrc, withTimeoutSrc, runViaPandasSrc, buildSqliteSnippetSrc, runViaSqliteSrc].every(Boolean);
  ok(allPresent, 'all pieces needed to assemble the full second-engine bridge (including the new pyodide-sqlite path) are present verbatim in the shipped source');

  if (allPresent) {
    const harnessSrc = `
      'use strict';
      var window = globalThis.__mockWindow;
      var SECOND_ENGINE_DUCKDB_INSTALL_TIMEOUT_MS = 12000;
      var _secondEngineDuckdbReady = null;
      ${dgCsvGlobalReSrc}
      ${withTimeoutSrc}
      ${evalTrivialSrc}
      ${ensureDuckdbSrc}
      ${listCsvSrc}
      ${buildSnippetSrc}
      ${registerSrc}
      ${runViaDuckdbSrc}
      ${parseCountSrc}
      ${runViaPandasSrc}
      ${buildSqliteSnippetSrc}
      ${runViaSqliteSrc}
      ${runViaWebRSrc}
      ${bridgeSrc2}
      return runProofSecondEngineBridge;
    `;
    // eslint-disable-next-line no-new-func
    const buildBridge = new Function(harnessSrc);

    // A tiny real-ish SQL executor over parsed CSV tables, driving the
    // mock sqlite3 behavior: supports SELECT COUNT(*)/SUM(col)/plain col
    // list FROM a single table, with an optional WHERE col = value or
    // col > value clause -- enough to prove sqlite answers MORE than
    // COUNT(*) (the entire point of this hotfix), without needing a real
    // sqlite3 or duckdb binary in this Node test process.
    function parseCsv(csv) {
      const lines = String(csv).split('\n');
      const header = lines[0].split(',').map((h) => JSON.parse(h));
      const rows = lines.slice(1).filter(Boolean).map((line) => line.split(',').map((c) => JSON.parse(c)));
      return { header, rows };
    }

    function runMockSql(sql, tablesByName) {
      const s = String(sql).trim().replace(/;\s*$/, '');
      // SELECT COUNT(*) AS alias FROM t [WHERE col OP val]
      let m = /^select\s+count\(\*\)\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+from\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+where\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(=|>|<)\s*(-?\d+(?:\.\d+)?))?$/i.exec(s);
      if (m) {
        const table = tablesByName[m[2]];
        if (!table) throw new Error('no such table: ' + m[2]);
        let rows = table.rows;
        if (m[3]) {
          const colIdx = table.header.indexOf(m[3]);
          rows = rows.filter((r) => {
            const v = Number(r[colIdx]);
            if (m[4] === '=') return v === Number(m[5]);
            if (m[4] === '>') return v > Number(m[5]);
            return v < Number(m[5]);
          });
        }
        return { columns: [m[1]], rows: [[rows.length]] };
      }
      // SELECT SUM(col) AS alias FROM t
      m = /^select\s+sum\(([a-zA-Z_][a-zA-Z0-9_]*)\)\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+from\s+([a-zA-Z_][a-zA-Z0-9_]*)$/i.exec(s);
      if (m) {
        const table = tablesByName[m[3]];
        if (!table) throw new Error('no such table: ' + m[3]);
        const colIdx = table.header.indexOf(m[1]);
        if (colIdx === -1) throw new Error('no such column: ' + m[1]);
        const total = table.rows.reduce((acc, r) => acc + Number(r[colIdx]), 0);
        return { columns: [m[2]], rows: [[total]] };
      }
      throw new Error('near "' + s + '": syntax error (mock does not support this shape)');
    }

    function makeMockPy(csvByTable, opts) {
      const options = opts || {};
      const duckdbUnavailable = !!options.duckdbUnavailable;
      const globals = new Map();
      Object.keys(csvByTable).forEach((t) => globals.set('dg_csv_' + t, csvByTable[t]));
      const sqliteTables = {};
      const duckdbTables = {};
      const py = {
        globals: {
          set(k, v) { globals.set(k, v); },
          get(k) { return globals.get(k); },
          keys() { return globals.keys(); },
        },
        loadPackage() { return Promise.resolve(); },
        runPython(code) {
          if (code === 'import duckdb') {
            if (duckdbUnavailable) throw new Error('ModuleNotFoundError: duckdb (mock: never installed -- structural, per hotfix spec)');
            return;
          }
          throw new Error('unsupported runPython: ' + code);
        },
        async runPythonAsync(code) {
          if (/micropip\.install\("duckdb"\)/.test(code)) {
            // Structural failure per this hotfix's spec: duckdb can never
            // install in Pyodide (no wasm wheel exists at all), so this
            // always throws when duckdbUnavailable is set, exactly like
            // ensureDuckdbInPyodide's real live-proven failure mode.
            if (duckdbUnavailable) throw new Error('micropip install failed (mock: no duckdb wheel exists for Pyodide platform)');
            return;
          }
          if (/_dg_second_engine_pandas_n = len/.test(code)) {
            const globalKey = globals.get('_dg_second_engine_pandas_key');
            const csv = globals.get(globalKey);
            if (csv === undefined || csv === null) throw new Error('pandas mock: ' + globalKey + ' not found');
            const parsed = parseCsv(csv);
            globals.set('_dg_second_engine_pandas_n', parsed.rows.length);
            return;
          }
          if (/duckdb\.sql\(_dg_second_engine_sql\)/.test(code)) {
            // pyodide-duckdb path -- only reachable when duckdb import
            // succeeded above (duckdbUnavailable=false in these tests, or
            // exercised standalone by the existing v1.2 suite already).
            const sql = globals.get('_dg_second_engine_sql');
            const res = runMockSql(sql, duckdbTables);
            globals.set('_dg_second_engine_payload', JSON.stringify({ columns: res.columns, rows: res.rows, rowCount: res.rows.length }));
            return;
          }
          if (/^import pandas as pd, io, duckdb/.test(code)) {
            // duckdb registration snippet (buildRegisterPythonSnippet)
            const registered = [];
            const re = /globals\(\)\[("dg_csv_[a-zA-Z0-9_]+")\][^\n]*\n\s*_dg_duckdb\.register\("([a-zA-Z0-9_]+)"/g;
            let rm;
            while ((rm = re.exec(code))) {
              const globalKey = JSON.parse(rm[1]);
              const tableName = rm[2];
              const csv = globals.get(globalKey);
              if (csv !== undefined) { duckdbTables[tableName] = parseCsv(csv); registered.push(tableName); }
            }
            globals.set('_dg_second_engine_tables_registered', registered);
            return;
          }
          if (/^import pandas as pd, io, sqlite3, json/.test(code)) {
            // THIS is the new pyodide-sqlite path's generated snippet --
            // simulate: register every dg_csv_* table found in the code by
            // regex (mirroring to_sql calls), then run the embedded
            // statement via the mock SQL executor, mirroring
            // pandas.read_sql_query's success/exception behavior exactly
            // (including surfacing a real "table not found"/"syntax
            // error" as _dg_second_engine_sqlite_error, never a fabricated
            // row -- the same honesty contract the real snippet's
            // try/except/finally provides).
            const registered = [];
            const re = /globals\(\)\[("dg_csv_[a-zA-Z0-9_]+")\][^\n]*\n\s*_dg_df\.to_sql\("([a-zA-Z0-9_]+)"/g;
            let rm;
            while ((rm = re.exec(code))) {
              const globalKey = JSON.parse(rm[1]);
              const tableName = rm[2];
              const csv = globals.get(globalKey);
              if (csv !== undefined) { sqliteTables[tableName] = parseCsv(csv); registered.push(tableName); }
            }
            const sqlMatch = /pd\.read_sql_query\((".*?"|'.*?'|`[\s\S]*?`),\s*_dg_sqlite_conn\)/.exec(code) || /_dg_sqlite_res = pd\.read_sql_query\(([\s\S]*?), _dg_sqlite_conn\)/.exec(code);
            let sqlText = null;
            if (sqlMatch) {
              try { sqlText = JSON.parse(sqlMatch[1]); } catch (_eParse) { sqlText = sqlMatch[1]; }
            }
            globals.set('_dg_second_engine_sqlite_tables_registered', registered);
            try {
              const res = runMockSql(sqlText, sqliteTables);
              globals.set('_dg_second_engine_sqlite_error', null);
              globals.set('_dg_second_engine_sqlite_payload', JSON.stringify({ columns: res.columns, rows: res.rows, rowCount: res.rows.length }));
            } catch (eMockSql) {
              globals.set('_dg_second_engine_sqlite_error', eMockSql.message);
              globals.set('_dg_second_engine_sqlite_payload', null);
            }
            return;
          }
          throw new Error('unsupported runPythonAsync: ' + code);
        },
      };
      return py;
    }

    // ---- Test 1 (spec Tests #1): register + COUNT(*) AS n FROM t -> n matches ----
    {
      const csv = '"id","amount"\n"1","10"\n"2","20"\n"3","30"';
      const mockPy = makeMockPy({ orders: csv }, { duckdbUnavailable: true });
      globalThis.__mockWindow = { DataGlowPython: { loadRuntime: async () => mockPy, buildHelper: () => {} } };
      const bridge = buildBridge();
      const result = await bridge('SELECT COUNT(*) AS n FROM orders');
      ok(!result.error, 'SELECT COUNT(*) AS n FROM orders succeeds via the new pyodide-sqlite path when duckdb is unavailable');
      ok(result.engine === 'pyodide-sqlite', 'the successful COUNT(*) result is tagged engine: pyodide-sqlite');
      ok(result.scalars && result.scalars.n === 3, 'COUNT(*) AS n FROM a 3-row registered table returns n=3 (matches the primary engine)');
      ok(Array.isArray(result.tablesRegistered) && result.tablesRegistered.includes('orders'), 'the result reports tablesRegistered including "orders"');
    }

    // ---- Test 2 (spec Tests #2): SELECT SUM(x) AS s FROM t works ----
    {
      const csv = '"id","amount"\n"1","10"\n"2","20"\n"3","30"';
      const mockPy = makeMockPy({ orders: csv }, { duckdbUnavailable: true });
      globalThis.__mockWindow = { DataGlowPython: { loadRuntime: async () => mockPy, buildHelper: () => {} } };
      const bridge = buildBridge();
      const result = await bridge('SELECT SUM(amount) AS s FROM orders');
      ok(!result.error, 'SELECT SUM(amount) AS s FROM orders succeeds -- THE CORE CAPABILITY THIS HOTFIX SHIPS (the old pandas-only fallback could never answer this, only COUNT(*))');
      ok(result.engine === 'pyodide-sqlite', 'the SUM result is tagged engine: pyodide-sqlite');
      ok(result.scalars && result.scalars.s === 60, 'SUM(amount) AS s FROM the 10/20/30 rows correctly returns s=60');
    }

    // ---- Test 2b: WHERE-filtered query also works (further than COUNT(*)) ----
    {
      const csv = '"id","amount"\n"1","10"\n"2","20"\n"3","30"';
      const mockPy = makeMockPy({ orders: csv }, { duckdbUnavailable: true });
      globalThis.__mockWindow = { DataGlowPython: { loadRuntime: async () => mockPy, buildHelper: () => {} } };
      const bridge = buildBridge();
      const result = await bridge('SELECT COUNT(*) AS n FROM orders WHERE amount > 15');
      ok(!result.error && result.scalars && result.scalars.n === 2, 'a WHERE-filtered COUNT (amount > 15) correctly returns n=2, proving real SQL beyond a bare COUNT(*) is honored');
    }

    // ---- Test 3 (spec Tests #3): priority -- sqlite preferred over pandas when both possible ----
    {
      const csv = '"id"\n"1"\n"2"\n"3"\n"4"\n"5"';
      const mockPy = makeMockPy({ orders: csv }, { duckdbUnavailable: true });
      let pandasWasCalled = false;
      const origRunPythonAsync = mockPy.runPythonAsync.bind(mockPy);
      mockPy.runPythonAsync = async (code) => {
        if (/_dg_second_engine_pandas_n = len/.test(code)) pandasWasCalled = true;
        return origRunPythonAsync(code);
      };
      globalThis.__mockWindow = { DataGlowPython: { loadRuntime: async () => mockPy, buildHelper: () => {} } };
      const bridge = buildBridge();
      const result = await bridge('SELECT COUNT(*) AS n FROM orders');
      ok(result.engine === 'pyodide-sqlite', 'PRIORITY: when both pyodide-sqlite and pyodide-pandas could answer a COUNT(*), sqlite is preferred (spec Tests #3)');
      ok(!pandasWasCalled, 'the narrow pandas COUNT path is never even invoked once sqlite has already answered successfully');
      ok(result.scalars && result.scalars.n === 5, 'the preferred sqlite path still returns the correct count, n=5');
    }

    // ---- Test 4 (spec Tests #4): engine tag is pyodide-sqlite, never pyodide-duckdb ----
    {
      const csv = '"id"\n"1"\n"2"';
      const mockPy = makeMockPy({ demo: csv }, { duckdbUnavailable: true });
      globalThis.__mockWindow = { DataGlowPython: { loadRuntime: async () => mockPy, buildHelper: () => {} } };
      const bridge = buildBridge();
      const result = await bridge('SELECT COUNT(*) AS n FROM demo');
      ok(result.engine === 'pyodide-sqlite', 'the engine tag is exactly "pyodide-sqlite"');
      ok(result.engine !== 'pyodide-duckdb', 'the engine tag is never "pyodide-duckdb" when duckdb never actually ran (honesty per spec)');
    }

    // ---- Dialect honesty: a sqlite-incompatible / genuinely bad statement errors, never fabricates ----
    {
      const csv = '"id"\n"1"\n"2"';
      const mockPy = makeMockPy({ demo: csv }, { duckdbUnavailable: true });
      globalThis.__mockWindow = { DataGlowPython: { loadRuntime: async () => mockPy, buildHelper: () => {} } };
      const bridge = buildBridge();
      const result = await bridge('SELECT QUALIFY_NONSENSE(*) FROM demo');
      ok(!!result.error, 'a statement the mock sqlite executor cannot run surfaces an honest error rather than a fabricated result (spec: "do not invent")');
      ok(result.engine === undefined, 'an errored result carries no fabricated engine tag');
    }

    // ---- Missing table: sqlite honestly fails (no fabricated 0) ----
    {
      const mockPy = makeMockPy({ orders: '"id"\n"1"' }, { duckdbUnavailable: true });
      globalThis.__mockWindow = { DataGlowPython: { loadRuntime: async () => mockPy, buildHelper: () => {} } };
      const bridge = buildBridge();
      const result = await bridge('SELECT COUNT(*) AS n FROM nonexistent_table');
      ok(!!result.error, 'a FROM query against a table with no matching dg_csv_ global honestly fails via sqlite (no such table), never a fabricated 0');
    }

    // ---------------------------------------------------------------
    // Regression (spec Tests #5): existing pandas COUNT / literal / webR
    // paths still pass through the SAME extracted bridge that now also
    // has the sqlite rung inserted.
    // ---------------------------------------------------------------

    // pandas COUNT fallback still reachable if sqlite genuinely cannot
    // register any tables at all (no dg_csv_* present) -- exercised here
    // by a statement sqlite can't run because there ARE no tables, forcing
    // the null fall-through to pandas, which then ALSO has nothing so both
    // fall through to the literal probe.
    {
      globalThis.__mockWindow = { DataGlowPython: { loadRuntime: async () => makeMockPy({}), buildHelper: () => {} } };
      const bridge = buildBridge();
      const result = await bridge('SELECT 42 AS answer');
      ok(!result.error, 'the trivial literal probe still works end-to-end through the bridge with the new sqlite rung inserted');
      ok(result.engine === 'pyodide-literal', 'a literal SELECT with no dg_csv_* tables anywhere falls through sqlite and pandas to the literal probe, unchanged from before this hotfix');
      ok(result.scalars && result.scalars.answer === 42, 'the literal probe still returns the correct scalar');
    }

    // pandas COUNT still directly reachable as a fallback when sqlite
    // itself throws for a table it also cannot resolve fully (simulated by
    // making the mock sqlite executor fail while pandas mock still finds
    // the CSV global directly).
    {
      const csv = '"id"\n"1"\n"2"\n"3"';
      const mockPy = makeMockPy({ orders: csv }, { duckdbUnavailable: true });
      const origRunPythonAsync = mockPy.runPythonAsync.bind(mockPy);
      mockPy.runPythonAsync = async (code) => {
        if (/^import pandas as pd, io, sqlite3, json/.test(code)) {
          // Simulate the sqlite snippet's own except-branch firing for a
          // reason unrelated to table availability (e.g. a locked/corrupt
          // in-memory db in a hypothetical edge case) -- still an honest
          // {error: ...}, not a JS throw, exactly like the real snippet's
          // try/except/finally always resolving cleanly.
          const globals = mockPy.globals;
          globals.set('_dg_second_engine_sqlite_error', 'simulated sqlite runtime failure');
          globals.set('_dg_second_engine_sqlite_payload', null);
          globals.set('_dg_second_engine_sqlite_tables_registered', []);
          return;
        }
        return origRunPythonAsync(code);
      };
      globalThis.__mockWindow = { DataGlowPython: { loadRuntime: async () => mockPy, buildHelper: () => {} } };
      const bridge = buildBridge();
      const result = await bridge('SELECT COUNT(*) AS n FROM orders');
      ok(!result.error, 'when sqlite itself reports an error, the bridge still falls through to the pandas COUNT(*) fallback rather than surfacing the sqlite error immediately (pandas answers first)');
      ok(result.engine === 'pyodide-pandas', 'the pandas-COUNT fallback (engine: pyodide-pandas) still fires exactly as before this hotfix when sqlite cannot answer');
      ok(result.scalars && result.scalars.n === 3, 'the pandas fallback still returns the correct count, n=3');
    }

    // webR last-resort path still reachable (no DataGlowPython at all)
    {
      globalThis.__mockWindow = {
        DataGlowR: {
          init: async () => ({
            evalR: async (code) => {
              if (/^exists\("orders"/.test(code)) return { toArray: async () => [true] };
              if (/requireNamespace\("duckdb"/.test(code)) throw new Error('duckdb R package not installed in this mock');
              if (code === 'nrow(orders)') return { toArray: async () => [7] };
              throw new Error('unsupported evalR: ' + code);
            },
          }),
        },
      };
      const bridge = buildBridge();
      const result = await bridge('SELECT COUNT(*) FROM orders');
      ok(!result.error && result.engine === 'webr-df', 'with no window.DataGlowPython at all, the bridge still reaches the unchanged webR fallback last-resort path');
      ok(result.scalars && result.scalars.c === 7, 'the webR fallback still reports the correct row count under the default alias "c"');
    }

    delete globalThis.__mockWindow;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
