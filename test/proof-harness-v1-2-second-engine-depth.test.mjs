// ============================================================
// DATAGLOW - Proof Harness v1.2 second-engine table depth test suite
// ============================================================
// js/proof-harness/data-glow-proof-harness-canvas.js is a plain browser
// script (DOM + window.DataGlowPython + Pyodide + window.DataGlowR), not an
// ES module, so it cannot be imported directly the way the pure
// proof-harness modules are. As in
// test/proof-harness-v1-1-bridge.test.mjs, this file extracts the ACTUAL
// function source out of the real shipped file with narrow, well-anchored
// markers and evaluates it in an isolated Function scope, so a drift in the
// shipped source fails extraction loudly rather than silently testing a
// stale reimplementation.
//
// Covers PROOF_HARNESS_V1_2_SPEC.md:
//   - Pillar A: dg_csv_* global discovery, the pandas read_csv + duckdb
//     register Python snippet, and that runViaPyodideDuckdb/
//     runProofSecondEngineBridge register tables BEFORE calling duckdb.sql
//     (the core bug this spec fixes).
//   - Pillar B: the narrow webR COUNT(*) FROM t pattern parser, and that the
//     bridge only ever calls window.DataGlowR.init() (never reimplements or
//     reaches into private webR state), passing raw SQL to R only through
//     the narrow-count path, never as R source.
//   - Regression: evalTrivialLiteralSelect still refuses any FROM-bearing
//     statement (spec Unit test #2).
//
// RUN WITH: node test/proof-harness-v1-2-second-engine-depth.test.mjs

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

// ---------------------------------------------------------------
// Pillar A1/A2: listCsvGlobalTableNames -- pure helper, no Pyodide needed
// ---------------------------------------------------------------
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

const listCsvGlobalTableNames = loadFnWithPrelude(dgCsvGlobalReSrc, 'function listCsvGlobalTableNames(globalKeys) {', 'listCsvGlobalTableNames');

if (listCsvGlobalTableNames) {
  const fromArray = listCsvGlobalTableNames(['dg_csv_orders', 'dg_csv_customers', 'not_a_dataset', 'dg_csv_line_items']);
  ok(Array.isArray(fromArray) && fromArray.includes('orders'), 'dg_csv_orders yields table name "orders"');
  ok(fromArray.includes('customers'), 'dg_csv_customers yields table name "customers"');
  ok(fromArray.includes('line_items'), 'dg_csv_line_items yields table name "line_items" (underscores in dataset name preserved)');
  ok(!fromArray.some((n) => n === 'not_a_dataset'), 'a global key that does not match ^dg_csv_(.+)$ is not treated as a table');
  ok(fromArray.length === 3, 'exactly the three dg_csv_* globals become table names, no more, no fewer');

  const fromMapKeys = listCsvGlobalTableNames(new Map([['dg_csv_orders', '1'], ['dg_show_result', null]]).keys());
  ok(fromMapKeys.includes('orders') && fromMapKeys.length === 1, 'a Map-like keys() iterable (approximating a Pyodide PyProxy globals map) is handled via the iterator/forEach path');

  const fromPlainObject = listCsvGlobalTableNames({ dg_csv_demo: '1', dg_csv_second: '2', unrelated: '3' });
  ok(fromPlainObject.includes('demo') && fromPlainObject.includes('second') && fromPlainObject.length === 2, 'a plain object (Object.keys fallback) is handled correctly');

  ok(Array.isArray(listCsvGlobalTableNames([])) && listCsvGlobalTableNames([]).length === 0, 'no dg_csv_* globals yields an empty array, not null/undefined/throw');
  ok(Array.isArray(listCsvGlobalTableNames(null)) && listCsvGlobalTableNames(null).length === 0, 'a null/undefined input is refused gracefully (empty array, never throws)');

  const dedup = listCsvGlobalTableNames(['dg_csv_orders', 'dg_csv_orders']);
  ok(dedup.length === 1, 'duplicate dg_csv_* globals for the same table name are de-duplicated');
}

// ---------------------------------------------------------------
// Pillar A1: buildRegisterPythonSnippet -- the pandas read_csv +
// duckdb.register Python source, generated purely from table names
// ---------------------------------------------------------------
const buildRegisterPythonSnippet = loadFn('function buildRegisterPythonSnippet(tableNames) {', 'buildRegisterPythonSnippet');

if (buildRegisterPythonSnippet) {
  const snippet = buildRegisterPythonSnippet(['orders', 'customers']);
  ok(typeof snippet === 'string' && snippet.length > 0, 'buildRegisterPythonSnippet returns a non-empty Python source string');
  ok(/import\s+.*duckdb/.test(snippet), 'the generated snippet imports duckdb');
  ok(/pd\.read_csv/.test(snippet), 'the generated snippet reads each dataset via pandas read_csv (spec A1)');
  ok(/io\.StringIO/.test(snippet), 'pandas reads from an in-memory StringIO, never a filesystem path (spec A1: "no filesystem needed")');
  ok(snippet.includes('"dg_csv_orders"'), 'the snippet looks up the dg_csv_orders global for the "orders" table');
  ok(snippet.includes('"dg_csv_customers"'), 'the snippet looks up the dg_csv_customers global for the "customers" table');
  ok(/duckdb\.register\(\s*"orders"/.test(snippet), 'duckdb.register is called with the bare table name "orders" (naming parity with SQLEngine.safeTableName, spec A2)');
  ok(/duckdb\.register\(\s*"customers"/.test(snippet), 'duckdb.register is called with the bare table name "customers"');
  ok(!/duckdb\.register\(\s*"dg_csv_/.test(snippet), 'duckdb.register is never called with the dg_csv_ prefixed global name -- only the bare table name');

  const emptySnippet = buildRegisterPythonSnippet([]);
  ok(typeof emptySnippet === 'string' && /import\s+.*duckdb/.test(emptySnippet) && !/\.register\(/.test(emptySnippet), 'an empty table list still produces valid, safe Python (imports only, no registration calls)');

  const sqlInjectionAttempt = buildRegisterPythonSnippet(['orders"; import os #']);
  ok(!/import os/.test(sqlInjectionAttempt.split('\n').slice(2).join('\n')) || sqlInjectionAttempt.includes('orders___import_os__'), 'a table name with unsafe characters is sanitized before being embedded (mirrors safeTableName-style character stripping), not interpolated raw into a register() call target');
}

// ---------------------------------------------------------------
// Pillar A3: fresh registration every call -- registerCsvGlobalsAsDuckdbTables
// and runViaPyodideDuckdb call the register step unconditionally, no
// fingerprint/skip-if-unchanged shortcut that could serve stale tables.
// ---------------------------------------------------------------
{
  const registerFnSrc = extractFunctionSource(canvasModuleSrc, 'async function registerCsvGlobalsAsDuckdbTables(py) {');
  ok(registerFnSrc !== null, 'registerCsvGlobalsAsDuckdbTables(py) is present verbatim in the shipped source');
  if (registerFnSrc) {
    ok(!/fingerprint/i.test(registerFnSrc), 'registerCsvGlobalsAsDuckdbTables does not skip registration via a fingerprint/cache shortcut (spec A3: re-register every call)');
  }

  const runViaDuckdbSrc = extractFunctionSource(canvasModuleSrc, 'async function runViaPyodideDuckdb(py, statement) {');
  ok(runViaDuckdbSrc !== null, 'runViaPyodideDuckdb(py, statement) is present verbatim in the shipped source');
  if (runViaDuckdbSrc) {
    ok(/registerCsvGlobalsAsDuckdbTables\(py\)/.test(runViaDuckdbSrc), 'runViaPyodideDuckdb calls registerCsvGlobalsAsDuckdbTables(py) -- registration happens on every call, not once');
    const registerCallIdx = runViaDuckdbSrc.indexOf('registerCsvGlobalsAsDuckdbTables(py)');
    const duckdbSqlIdx = runViaDuckdbSrc.indexOf('duckdb.sql(');
    ok(registerCallIdx !== -1 && duckdbSqlIdx !== -1 && registerCallIdx < duckdbSqlIdx, 'THE CORE FIX: table registration happens BEFORE duckdb.sql(...) is called, not after or never');
    ok(/tablesRegistered:\s*tablesRegistered/.test(runViaDuckdbSrc), 'runViaPyodideDuckdb returns tablesRegistered in its result (spec A4 result shape)');
    ok(/engine:\s*'pyodide-duckdb'/.test(runViaDuckdbSrc), 'runViaPyodideDuckdb tags its result engine: pyodide-duckdb (spec A6)');
  }
}

// ---------------------------------------------------------------
// Pillar A: canvas source-level check that duckdb.register is actually
// present in the shipped bridge (not just registerCsvGlobalsAsDuckdbTables
// calling something that doesn't exist).
// ---------------------------------------------------------------
{
  ok(canvasModuleSrc.includes('duckdb.register') || canvasModuleSrc.includes('_dg_duckdb.register'), 'the shipped canvas source contains a duckdb.register(...) call (the core bug fix)');
  ok(!canvasModuleSrc.includes('exportCartridgePure'), 'the shipped canvas source never references a stripped ESM "Pure" alias like exportCartridgePure (regression guard for #620)');
}

// ---------------------------------------------------------------
// Pillar B4: parseCountStarFrom -- narrow COUNT(*) FROM t pattern, refuses
// anything else
// ---------------------------------------------------------------
const parseCountStarFrom = loadFn('function parseCountStarFrom(statement) {', 'parseCountStarFrom');

if (parseCountStarFrom) {
  const basic = parseCountStarFrom('SELECT COUNT(*) FROM orders');
  ok(basic && basic.table === 'orders' && basic.alias === 'c', 'SELECT COUNT(*) FROM orders parses to {table:"orders", alias:"c"} (default alias)');

  const aliased = parseCountStarFrom('select count(*) as n from customers');
  ok(aliased && aliased.table === 'customers' && aliased.alias === 'n', 'select count(*) as n from customers uses the given alias');

  const quoted = parseCountStarFrom('SELECT COUNT(*) FROM "line_items";');
  ok(quoted && quoted.table === 'line_items', 'a quoted table name with a trailing semicolon is parsed correctly');

  const whitespace = parseCountStarFrom('  SELECT   COUNT( * )   FROM   orders  ');
  ok(whitespace && whitespace.table === 'orders', 'extra internal whitespace around COUNT(*) and FROM does not prevent recognition');

  ok(parseCountStarFrom('SELECT * FROM orders') === null, 'a non-COUNT(*) SELECT is refused, never guessed at');
  ok(parseCountStarFrom('SELECT COUNT(*) FROM orders WHERE x = 1') === null, 'a COUNT(*) with a WHERE clause is refused (narrow pattern only, spec B2.2)');
  ok(parseCountStarFrom('SELECT COUNT(id) FROM orders') === null, 'COUNT(id) (not COUNT(*)) is refused');
  ok(parseCountStarFrom('SELECT COUNT(*) FROM orders JOIN customers ON 1=1') === null, 'a join is refused, never partially matched');
  ok(parseCountStarFrom('DROP TABLE orders') === null, 'a non-SELECT statement is refused outright');
  ok(parseCountStarFrom('') === null, 'an empty statement is refused, never throws');
  ok(parseCountStarFrom(null) === null, 'a null statement is refused, never throws');
  ok(parseCountStarFrom(undefined) === null, 'an undefined statement is refused, never throws');
}

// ---------------------------------------------------------------
// Pillar B: source-level checks for the webR best-effort path -- uses only
// the public window.DataGlowR.init() seam, never reimplements/reaches into
// private webR closure state, and never hands raw SQL to evalR as if it
// were R source outside the narrow, parsed COUNT(*) path.
// ---------------------------------------------------------------
{
  const webrFnSrc = extractFunctionSource(canvasModuleSrc, 'async function runViaWebRNarrowCount(statement) {');
  ok(webrFnSrc !== null, 'runViaWebRNarrowCount(statement) is present verbatim in the shipped source');
  if (webrFnSrc) {
    ok(/window\.DataGlowR/.test(webrFnSrc), 'the webR path uses window.DataGlowR, the documented public seam (spec B2)');
    ok(/window\.DataGlowR\.init/.test(webrFnSrc), 'the webR path calls window.DataGlowR.init() rather than booting a second WebR runtime itself');
    ok(/parseCountStarFrom\(statement\)/.test(webrFnSrc), 'the webR path parses the statement through parseCountStarFrom before doing anything with it -- never hands the raw statement to evalR as R source');
    ok(/error:\s*'pyodide-sql-unavailable'/.test(webrFnSrc), 'the webR path shares the same honest unavailable error code when it cannot answer (spec B1 #4: keep this error code)');
    ok(!/_webR\b/.test(webrFnSrc), 'the webR path never reaches into the R tab\'s private _webR closure variable -- window.DataGlowR is the only seam used');
  }
}

// ---------------------------------------------------------------
// Regression (spec Unit test #2): evalTrivialLiteralSelect still refuses
// any FROM-bearing statement -- extracted verbatim, same as v1.1's test,
// re-asserted here because this is the spec's explicit v1.2 regression
// bar.
// ---------------------------------------------------------------
const evalTrivialLiteralSelect = loadFn('function evalTrivialLiteralSelect(statement) {', 'evalTrivialLiteralSelect');
if (evalTrivialLiteralSelect) {
  ok(evalTrivialLiteralSelect('SELECT count(*) FROM orders') === null, 'evalTrivialLiteralSelect still refuses a FROM-bearing statement after the v1.2 changes (regression guard)');
  ok(evalTrivialLiteralSelect('SELECT 1') !== null, 'evalTrivialLiteralSelect still recognizes a trivial literal after the v1.2 changes');
}

// ---------------------------------------------------------------
// Integration-style: full bridge orchestration with a mocked Pyodide `py`
// object (no real Pyodide/duckdb needed) proving registration actually
// happens, table names match SQLEngine.safeTableName-style naming, and a
// FROM query against a registered table succeeds end-to-end through the
// extracted runProofSecondEngineBridge.
// ---------------------------------------------------------------
{
  const bridgeSrc = extractFunctionSource(canvasModuleSrc, 'async function runProofSecondEngineBridge(statement) {');
  const ensureDuckdbSrc = extractFunctionSource(canvasModuleSrc, 'async function ensureDuckdbInPyodide(py) {');
  const registerSrc = extractFunctionSource(canvasModuleSrc, 'async function registerCsvGlobalsAsDuckdbTables(py) {');
  const listCsvSrc = extractFunctionSource(canvasModuleSrc, 'function listCsvGlobalTableNames(globalKeys) {');
  const buildSnippetSrc = extractFunctionSource(canvasModuleSrc, 'function buildRegisterPythonSnippet(tableNames) {');
  const runViaDuckdbSrc2 = extractFunctionSource(canvasModuleSrc, 'async function runViaPyodideDuckdb(py, statement) {');
  const evalTrivialSrc = extractFunctionSource(canvasModuleSrc, 'function evalTrivialLiteralSelect(statement) {');
  const parseCountSrc = extractFunctionSource(canvasModuleSrc, 'function parseCountStarFrom(statement) {');
  const runViaWebRSrc = extractFunctionSource(canvasModuleSrc, 'async function runViaWebRNarrowCount(statement) {');
  const withTimeoutSrc = extractFunctionSource(canvasModuleSrc, 'function withTimeout(promise, ms) {');

  const allPresent = [bridgeSrc, ensureDuckdbSrc, registerSrc, listCsvSrc, buildSnippetSrc, runViaDuckdbSrc2, evalTrivialSrc, parseCountSrc, runViaWebRSrc, withTimeoutSrc].every(Boolean);
  ok(allPresent, 'all pieces needed to assemble the full second-engine bridge are present verbatim in the shipped source');

  if (allPresent) {
    // Build a fake in-Pyodide "duckdb" + pandas layer entirely in JS to
    // prove the ORCHESTRATION (register-before-query) is correct, without
    // needing a real Pyodide runtime in Node.
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
      ${runViaDuckdbSrc2}
      ${parseCountSrc}
      ${runViaWebRSrc}
      ${bridgeSrc}
      return runProofSecondEngineBridge;
    `;
    // eslint-disable-next-line no-new-func
    const buildBridge = new Function(harnessSrc);

    function makeMockPy(csvByTable) {
      const globals = new Map();
      Object.keys(csvByTable).forEach((t) => globals.set('dg_csv_' + t, csvByTable[t]));
      const duckdbTables = {}; // registered tables: name -> parsed rows
      function parseCsv(csv) {
        const lines = String(csv).split('\n');
        const header = lines[0].split(',').map((h) => JSON.parse(h));
        const rows = lines.slice(1).filter(Boolean).map((line) => {
          // naive CSV split matching the simple quoting the canvas source uses
          return line.split(',').map((c) => JSON.parse(c));
        });
        return { header, rows };
      }
      const py = {
        globals: {
          set(k, v) { globals.set(k, v); },
          get(k) { return globals.get(k); },
          keys() { return globals.keys(); },
        },
        runPython(code) {
          if (code === 'import duckdb') return; // pretend duckdb is always importable in the mock
          throw new Error('unsupported runPython: ' + code);
        },
        async runPythonAsync(code) {
          if (/^import pandas/.test(code)) {
            // this is buildRegisterPythonSnippet's output; walk the
            // generated "if globals().get(...)" blocks and populate
            // duckdbTables from the corresponding dg_csv_* global, proving
            // the register step reads the SAME globals map runProofSecondEngineBridge
            // populated.
            const registered = [];
            const re = /globals\(\)\[("dg_csv_[a-zA-Z0-9_]+")\][^\n]*\n\s*_dg_duckdb\.register\("([a-zA-Z0-9_]+)"/g;
            let m;
            while ((m = re.exec(code))) {
              const globalKey = JSON.parse(m[1]);
              const tableName = m[2];
              const csv = globals.get(globalKey);
              if (csv !== undefined) {
                duckdbTables[tableName] = parseCsv(csv);
                registered.push(tableName);
              }
            }
            globals.set('_dg_second_engine_tables_registered', registered);
            return;
          }
          if (/duckdb\.sql\(_dg_second_engine_sql\)/.test(code)) {
            const sql = globals.get('_dg_second_engine_sql');
            const m = /select\s+count\(\*\)\s+as\s+n\s+from\s+([a-zA-Z0-9_]+)/i.exec(sql) || /select\s+\*\s+from\s+([a-zA-Z0-9_]+)/i.exec(sql);
            if (!m || !duckdbTables[m[1]]) {
              throw new Error('Catalog Error: Table with name ' + (m ? m[1] : '?') + ' does not exist!');
            }
            const table = duckdbTables[m[1]];
            let payload;
            if (/count\(\*\)/i.test(sql)) {
              payload = { columns: ['n'], rows: [[table.rows.length]], rowCount: 1 };
            } else {
              payload = { columns: table.header, rows: table.rows, rowCount: table.rows.length };
            }
            globals.set('_dg_second_engine_payload', JSON.stringify(payload));
            return;
          }
          throw new Error('unsupported runPythonAsync: ' + code);
        },
      };
      return py;
    }

    // ---- Test: FROM query against a registered dg_csv_orders table succeeds ----
    {
      const csv = '"id","amount"\n"1","10"\n"2","20"\n"3","30"';
      const mockPy = makeMockPy({ orders: csv });
      globalThis.__mockWindow = {
        DataGlowPython: {
          loadRuntime: async () => mockPy,
          buildHelper: () => {}, // globals already seeded by makeMockPy
        },
      };
      const bridge = buildBridge();
      const result = await bridge('SELECT COUNT(*) AS n FROM orders');
      ok(!result.error, 'a real FROM query against a table with a matching dg_csv_ global succeeds (THE CORE BUG IS FIXED)');
      ok(result.engine === 'pyodide-duckdb', 'the successful FROM-query result is tagged engine: pyodide-duckdb');
      ok(result.scalars && result.scalars.n === 3, 'SELECT COUNT(*) AS n FROM orders against a 3-row registered table returns n=3');
      ok(Array.isArray(result.tablesRegistered) && result.tablesRegistered.includes('orders'), 'the result reports tablesRegistered including "orders"');
    }

    // ---- Test: unregistered table name still fails honestly (never a false match) ----
    {
      const mockPy = makeMockPy({ orders: '"id"\n"1"' });
      globalThis.__mockWindow = {
        DataGlowPython: { loadRuntime: async () => mockPy, buildHelper: () => {} },
      };
      const bridge = buildBridge();
      const result = await bridge('SELECT COUNT(*) AS n FROM nonexistent_table');
      ok(result.error === 'pyodide-sql-unavailable', 'a FROM query against a table with NO matching dg_csv_ global honestly fails rather than fabricating a row count');
    }

    // ---- Test: dataset swap re-registers fresh tables each call (spec A3) ----
    {
      const csvV1 = '"id"\n"1"\n"2"';
      const mockPy = makeMockPy({ demo: csvV1 });
      globalThis.__mockWindow = {
        DataGlowPython: { loadRuntime: async () => mockPy, buildHelper: () => {} },
      };
      const bridge = buildBridge();
      const first = await bridge('SELECT COUNT(*) AS n FROM demo');
      ok(first.scalars && first.scalars.n === 2, 'first call sees the original 2-row dataset');
      // Simulate a dataset swap: buildHelper would repopulate dg_csv_demo
      // with new content on the next call. Directly mutate the mock's
      // global to simulate that swap happening between bridge calls.
      mockPy.globals.set('dg_csv_demo', '"id"\n"1"\n"2"\n"3"\n"4"');
      const second = await bridge('SELECT COUNT(*) AS n FROM demo');
      ok(second.scalars && second.scalars.n === 4, 'a second call after a dataset swap re-registers and sees the NEW 4-row dataset, not a stale cached table (spec A3)');
    }

    // ---- Test: no window.DataGlowPython at all and no window.DataGlowR falls to honest unavailable for a FROM query ----
    {
      globalThis.__mockWindow = {};
      const bridge = buildBridge();
      const result = await bridge('SELECT COUNT(*) FROM orders');
      ok(result.error === 'pyodide-sql-unavailable', 'with neither DataGlowPython nor DataGlowR present, a FROM query honestly reports unavailable, never a fabricated result');
    }

    // ---- Test: no window.DataGlowPython but window.DataGlowR answers narrow COUNT(*) via nrow() ----
    {
      globalThis.__mockWindow = {
        DataGlowR: {
          init: async () => ({
            evalR: async (code) => {
              if (/requireNamespace\("duckdb"/.test(code)) {
                throw new Error('duckdb R package not installed in this mock');
              }
              if (code === 'nrow(orders)') {
                return { toArray: async () => [5] };
              }
              throw new Error('unsupported evalR: ' + code);
            },
          }),
        },
      };
      const bridge = buildBridge();
      const result = await bridge('SELECT COUNT(*) FROM orders');
      ok(!result.error, 'with only window.DataGlowR present, a narrow COUNT(*) FROM t query is answered via the webR nrow() path');
      ok(result.engine === 'webr-df', 'the webR nrow() fallback result is tagged engine: webr-df');
      ok(result.scalars && result.scalars.c === 5, 'the webR path correctly reports the R data.frame row count under the default alias "c"');
    }

    // ---- Test: window.DataGlowR present but statement is not the narrow shape -> unavailable, never guessed ----
    {
      globalThis.__mockWindow = {
        DataGlowR: { init: async () => ({ evalR: async () => { throw new Error('should not be called'); } }) },
      };
      const bridge = buildBridge();
      const result = await bridge('SELECT * FROM orders WHERE amount > 100');
      ok(result.error === 'pyodide-sql-unavailable', 'a non-trivial, non-COUNT(*) statement with only webR available is honestly refused, never guessed at via R');
    }

    delete globalThis.__mockWindow;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
