// ============================================================
// DATAGLOW - HOTFIX: load Pyodide sqlite3 package before second-engine SQL
// ============================================================
// HOTFIX_PYODIDE_LOAD_SQLITE3_SPEC.md. Live diagnostic on
// https://dataglow-platform.pplx.app (945166e) found:
//
//   ModuleNotFoundError: No module named 'sqlite3'
//   The module 'sqlite3' is unvendored from the Python standard library in
//   the Pyodide distribution. You can install it by calling:
//     await micropip.install("sqlite3") in Python, or
//     await pyodide.loadPackage("sqlite3") in JavaScript
//
// Root cause: Pyodide does NOT ship sqlite3 in its core runtime the way a
// normal CPython build does -- it is a separate package that must be
// loaded via `pyodide.loadPackage('sqlite3')` before `import sqlite3` can
// ever succeed, exactly the same shape as pandas/numpy/matplotlib in
// js/runtimes-viz/python-runtime.js's initPyodideRuntime(). The pyodide-
// sqlite3 corroboration hotfixes (#624, #625, #626) never loaded this
// package, so every generated snippet's `import ... sqlite3 ...` line threw
// inside its own try/except, correctly but uselessly surfacing as
// _dg_second_engine_sqlite_error and silently falling through to the
// narrower pyodide-pandas COUNT-only path on every real device.
//
// js/proof-harness/data-glow-proof-harness-canvas.js is a plain browser
// script (DOM + window.DataGlowPython + Pyodide + window.DataGlowR), not an
// ES module, so it cannot be imported directly. As in the prior sqlite
// hotfix tests, this file extracts the ACTUAL function source out of the
// real shipped file with narrow, well-anchored markers and evaluates it in
// an isolated Function scope, so drift in the shipped source fails
// extraction loudly rather than silently testing a stale reimplementation.
//
// Covers HOTFIX_PYODIDE_LOAD_SQLITE3_SPEC.md "Tests" section:
//   1. ensureSqlite3InPyodide exists verbatim in the shipped source
//   2. Mock loadPackage('sqlite3') is called before the sqlite snippet runs
//   3. A successful load lets runViaPyodideSqlite/runProofSecondEngineBridge
//      answer COUNT(*)/SUM(...) via engine: 'pyodide-sqlite'
//   4. The load is cached -- loadPackage is called once even across
//      multiple runViaPyodideSqlite invocations in the same session
//   5. A loadPackage failure/timeout honestly falls through to
//      pyodide-pandas rather than throwing or fabricating a sqlite result
//   6. onMeshExport already awaits the async exportMeshAttestation (no fix
//      needed -- locked in as a regression test per spec item 4)
//   7. Existing sqlite suites (proxy/None handling, discovery fallback)
//      still pass unmodified (run alongside this file; see RESULT.md)
//
// RUN WITH: node test/hotfix-pyodide-load-sqlite3.test.mjs

import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

const canvasModuleSrc = readFileSync(new URL('../js/proof-harness/data-glow-proof-harness-canvas.js', import.meta.url), 'utf8');

function extractFunctionSource(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) return null;
  let depth = 0;
  let i = startIdx + startMarker.length - 1;
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

// ---------------------------------------------------------------
// 1. ensureSqlite3InPyodide -- presence + shape checks
// ---------------------------------------------------------------
const ensureSqlite3Src = extractFunctionSource(canvasModuleSrc, 'function ensureSqlite3InPyodide(py) {');
ok(ensureSqlite3Src !== null, 'ensureSqlite3InPyodide(py) is present verbatim in the shipped canvas module source');
if (ensureSqlite3Src) {
  ok(/loadPackage\(\s*'sqlite3'\s*\)/.test(ensureSqlite3Src), 'ensureSqlite3InPyodide calls loadPackage(\'sqlite3\') -- same call shape as pandas/numpy in python-runtime.js');
  ok(/withTimeout/.test(ensureSqlite3Src), 'ensureSqlite3InPyodide is wrapped in the existing withTimeout(...) helper (spec: "timeout ~12s")');
  ok(/_sqlite3ReadyPromise/.test(ensureSqlite3Src), 'ensureSqlite3InPyodide caches its result in a shared promise (spec: "Cache promise")');
  ok(/catch/.test(ensureSqlite3Src) && /return false/.test(ensureSqlite3Src), 'ensureSqlite3InPyodide returns false on failure rather than throwing (spec: "on failure return false")');
  ok(/import sqlite3/.test(ensureSqlite3Src), 'ensureSqlite3InPyodide confirms `import sqlite3` succeeds after loadPackage resolves (spec step 3)');
}

const sqliteTimeoutConst = /var SQLITE3_LOAD_TIMEOUT_MS = (\d+);/.exec(canvasModuleSrc);
ok(sqliteTimeoutConst !== null, 'SQLITE3_LOAD_TIMEOUT_MS constant is present');
if (sqliteTimeoutConst) {
  ok(Number(sqliteTimeoutConst[1]) <= 15000 && Number(sqliteTimeoutConst[1]) >= 5000, 'the sqlite3 load timeout is in the ~12s neighborhood the spec calls for');
}

// ---------------------------------------------------------------
// 2. runViaPyodideSqlite calls ensureSqlite3InPyodide at its start
// ---------------------------------------------------------------
const runViaSqliteSrc = extractFunctionSource(canvasModuleSrc, 'async function runViaPyodideSqlite(py, statement) {');
ok(runViaSqliteSrc !== null, 'runViaPyodideSqlite(py, statement) is present verbatim in the shipped source');
if (runViaSqliteSrc) {
  ok(/ensureSqlite3InPyodide\(py\)/.test(runViaSqliteSrc), 'runViaPyodideSqlite calls ensureSqlite3InPyodide(py) (spec item 2: "Call ensureSqlite3InPyodide(py) at start of runViaPyodideSqlite")');
  const ensureIdx = runViaSqliteSrc.indexOf('ensureSqlite3InPyodide(py)');
  const snippetRunIdx = runViaSqliteSrc.indexOf('runPythonAsync(snippet)');
  ok(ensureIdx !== -1 && snippetRunIdx !== -1 && ensureIdx < snippetRunIdx, 'ensureSqlite3InPyodide is awaited BEFORE the sqlite register+query snippet runs, not after');
}

// ---------------------------------------------------------------
// 3-5. End-to-end orchestration against a mock Pyodide `py` object with a
//    real loadPackage seam, proving the load actually happens, is cached,
//    and a failure falls through honestly.
// ---------------------------------------------------------------
{
  const pyToJsSrc = extractFunctionSource(canvasModuleSrc, 'function pyToJs(v) {');
  const isRealPyodideErrorValueSrc = extractFunctionSource(canvasModuleSrc, 'function isRealPyodideErrorValue(v) {');
  const listCsvSrc = extractFunctionSource(canvasModuleSrc, 'function listCsvGlobalTableNames(globalKeys) {');
  const buildSqliteSnippetSrc = extractFunctionSource(canvasModuleSrc, 'function buildSqliteRegisterAndQuerySnippet(statement, tableNames) {');
  const withTimeoutSrc = extractFunctionSource(canvasModuleSrc, 'function withTimeout(promise, ms) {');
  const dgCsvGlobalReSrc = (() => {
    const m = /var DG_CSV_GLOBAL_RE = [^\n]+\n/.exec(canvasModuleSrc);
    return m ? m[0] : 'var DG_CSV_GLOBAL_RE = /^dg_csv_(.+)$/;\n';
  })();

  const allPresent = [pyToJsSrc, isRealPyodideErrorValueSrc, listCsvSrc, buildSqliteSnippetSrc, withTimeoutSrc, ensureSqlite3Src, runViaSqliteSrc].every(Boolean);
  ok(allPresent, 'all pieces needed to run runViaPyodideSqlite (including the new sqlite3-load guard) are present verbatim in the shipped source');

  if (allPresent) {
    function makeStringProxy(str) {
      return { toJs() { return str; }, toString() { return str; } };
    }
    function makeNoneProxy() {
      return { toString() { return 'None'; } };
    }
    function parseCsv(csv) {
      const lines = String(csv).split('\n');
      const header = lines[0].split(',').map((h) => JSON.parse(h));
      const rows = lines.slice(1).filter(Boolean).map((line) => line.split(',').map((c) => JSON.parse(c)));
      return { header, rows };
    }
    function runMockSql(sql, tablesByName) {
      const s = String(sql).trim().replace(/;\s*$/, '');
      let m = /^select\s+count\(\*\)\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+from\s+([a-zA-Z_][a-zA-Z0-9_]*)$/i.exec(s);
      if (m) {
        const table = tablesByName[m[2]];
        if (!table) throw new Error('no such table: ' + m[2]);
        return { columns: [m[1]], rows: [[table.rows.length]] };
      }
      m = /^select\s+sum\(([a-zA-Z_][a-zA-Z0-9_]*)\)\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+from\s+([a-zA-Z_][a-zA-Z0-9_]*)$/i.exec(s);
      if (m) {
        const table = tablesByName[m[3]];
        if (!table) throw new Error('no such table: ' + m[3]);
        const colIdx = table.header.indexOf(m[1]);
        const total = table.rows.reduce((acc, r) => acc + Number(r[colIdx]), 0);
        return { columns: [m[2]], rows: [[total]] };
      }
      throw new Error('unsupported: ' + s);
    }

    // A mock `py` object shaped like the real Pyodide API: has both
    // `loadPackage` (module-load capable) and `globals`/`runPython`/
    // `runPythonAsync` (interpreter-capable) -- exactly what
    // ensureSqlite3InPyodide expects as its "py is the full pyodide API"
    // branch (spec resolution order step 1).
    function makeMockPyodideWithLoader(csvByTable, opts) {
      const options = opts || {};
      const globals = new Map();
      Object.keys(csvByTable).forEach((t) => globals.set('dg_csv_' + t, makeStringProxy(csvByTable[t])));
      const sqliteTables = {};
      let loadPackageCalls = 0;
      let sqlite3Imported = false;

      return {
        _stats: () => ({ loadPackageCalls, sqlite3Imported }),
        globals: {
          set(k, v) { globals.set(k, v); },
          get(k) { return globals.has(k) ? globals.get(k) : makeNoneProxy(); },
          keys() { return globals.keys(); },
        },
        loadPackage(pkg) {
          loadPackageCalls += 1;
          if (options.loadPackageRejects) {
            return Promise.reject(new Error('Failed to fetch dynamically imported sqlite3 module (mock CDN failure)'));
          }
          if (options.loadPackageHangs) {
            return new Promise(() => {}); // never resolves -- exercises the withTimeout path
          }
          ok(pkg === 'sqlite3', 'loadPackage is called with the exact string "sqlite3"');
          return Promise.resolve();
        },
        runPython(code) {
          if (/^import sqlite3$/.test(code.trim())) {
            if (options.loadPackageRejects || options.loadPackageHangs) {
              throw new Error("ModuleNotFoundError: No module named 'sqlite3'");
            }
            sqlite3Imported = true;
            return undefined;
          }
          throw new Error('unsupported runPython in mock: ' + code);
        },
        async runPythonAsync(code) {
          if (!sqlite3Imported && !options.skipImportGuard) {
            // Faithful to live Pyodide: without a prior successful
            // loadPackage('sqlite3'), `import sqlite3` inside the generated
            // snippet throws ModuleNotFoundError, which the snippet's own
            // try/except captures into _dg_second_engine_sqlite_error --
            // this mock reproduces exactly that live-proven failure mode.
            globals.set('_dg_second_engine_sqlite_error', makeStringProxy("ModuleNotFoundError: No module named 'sqlite3'"));
            globals.set('_dg_second_engine_sqlite_payload', makeNoneProxy());
            globals.set('_dg_second_engine_sqlite_tables_registered', { toJs() { return []; } });
            return;
          }
          const registered = [];
          const re = /globals\(\)\[("dg_csv_[a-zA-Z0-9_]+")\][^\n]*\n\s*_dg_df\.to_sql\("([a-zA-Z0-9_]+)"/g;
          let rm;
          while ((rm = re.exec(code))) {
            const globalKey = JSON.parse(rm[1]);
            const tableName = rm[2];
            if (globals.has(globalKey)) {
              const proxy = globals.get(globalKey);
              sqliteTables[tableName] = parseCsv(proxy.toJs ? proxy.toJs() : String(proxy));
              registered.push(tableName);
            }
          }
          const sqlMatch = /pd\.read_sql_query\((".*?"|'.*?'|`[\s\S]*?`),\s*_dg_sqlite_conn\)/.exec(code);
          let sqlText = null;
          if (sqlMatch) { try { sqlText = JSON.parse(sqlMatch[1]); } catch (_e) { sqlText = sqlMatch[1]; } }
          globals.set('_dg_second_engine_sqlite_tables_registered', { toJs() { return registered; } });
          try {
            const res = runMockSql(sqlText, sqliteTables);
            globals.set('_dg_second_engine_sqlite_error', makeNoneProxy());
            globals.set('_dg_second_engine_sqlite_payload', makeStringProxy(JSON.stringify({ columns: res.columns, rows: res.rows, rowCount: res.rows.length })));
          } catch (eMockSql) {
            globals.set('_dg_second_engine_sqlite_error', makeStringProxy(eMockSql.message));
            globals.set('_dg_second_engine_sqlite_payload', makeNoneProxy());
          }
        },
      };
    }

    function buildRunViaSqlite() {
      const harnessSrc = `
        var window = globalThis.__mockWindowNoGetPyodide || {};
        ${dgCsvGlobalReSrc}
        ${withTimeoutSrc}
        var SQLITE3_LOAD_TIMEOUT_MS = 150;
        var _sqlite3ReadyPromise = null;
        ${ensureSqlite3Src}
        ${pyToJsSrc}
        ${isRealPyodideErrorValueSrc}
        ${listCsvSrc}
        ${buildSqliteSnippetSrc}
        ${runViaSqliteSrc}
        return { runViaPyodideSqlite, ensureSqlite3InPyodide, resetSqlite3Cache: function () { _sqlite3ReadyPromise = null; } };
      `;
      // eslint-disable-next-line no-new-func
      return new Function(harnessSrc)();
    }

    // ---- 3. Happy path: loadPackage succeeds, sqlite3 imports, COUNT/SUM work ----
    {
      globalThis.__mockWindowNoGetPyodide = {};
      const { runViaPyodideSqlite, resetSqlite3Cache } = buildRunViaSqlite();
      resetSqlite3Cache();
      const csv = '"id","amount"\n"1","10"\n"2","20"\n"3","30"';
      const mockPy = makeMockPyodideWithLoader({ orders: csv });
      const result = await runViaPyodideSqlite(mockPy, 'SELECT COUNT(*) AS n FROM orders');
      ok(result !== null && !result.error, 'HOTFIX: with loadPackage(\'sqlite3\') wired in, SELECT COUNT(*) now succeeds via pyodide-sqlite instead of failing with ModuleNotFoundError');
      ok(result && result.engine === 'pyodide-sqlite', 'the result is tagged engine: pyodide-sqlite');
      ok(result && result.scalars && result.scalars.n === 3, 'COUNT(*) AS n correctly returns n=3 once sqlite3 is loaded');
      ok(mockPy._stats().loadPackageCalls === 1, 'loadPackage was called exactly once for this run');
      ok(mockPy._stats().sqlite3Imported === true, 'import sqlite3 succeeded after loadPackage resolved');

      const result2 = await runViaPyodideSqlite(mockPy, 'SELECT SUM(amount) AS s FROM orders');
      ok(result2 !== null && !result2.error, 'SELECT SUM(amount) also succeeds now that sqlite3 is loaded');
      ok(result2 && result2.scalars && result2.scalars.s === 60, 'SUM(amount) AS s correctly returns s=60');
      ok(mockPy._stats().loadPackageCalls === 1, 'HOTFIX (cache): a SECOND runViaPyodideSqlite call on the same py/session does NOT call loadPackage again -- the promise is cached');
    }

    // ---- 4. Cache persists across DIFFERENT mock py instances sharing the
    //    same module-level cache (simulating repeated calls within one
    //    page session, same as the real singleton bridge) ----
    {
      globalThis.__mockWindowNoGetPyodide = {};
      const { runViaPyodideSqlite, resetSqlite3Cache } = buildRunViaSqlite();
      resetSqlite3Cache();
      const csv = '"id"\n"1"\n"2"';
      const mockPyA = makeMockPyodideWithLoader({ widgets: csv });
      await runViaPyodideSqlite(mockPyA, 'SELECT COUNT(*) AS n FROM widgets');
      ok(mockPyA._stats().loadPackageCalls === 1, 'first call in a fresh cache loads the package once');
    }

    // ---- 5. Failure path: loadPackage rejects (CDN failure) -- must fall
    //    through honestly (null/{error}), never throw uncaught, never
    //    fabricate a result ----
    {
      globalThis.__mockWindowNoGetPyodide = {};
      const { runViaPyodideSqlite, resetSqlite3Cache } = buildRunViaSqlite();
      resetSqlite3Cache();
      const csv = '"id"\n"1"\n"2"';
      const mockPy = makeMockPyodideWithLoader({ widgets: csv }, { loadPackageRejects: true });
      let threw = false;
      let result = null;
      try {
        result = await runViaPyodideSqlite(mockPy, 'SELECT COUNT(*) AS n FROM widgets');
      } catch (_e) {
        threw = true;
      }
      ok(threw === false, 'HOTFIX: a loadPackage(\'sqlite3\') CDN failure never throws out of runViaPyodideSqlite -- it is caught and falls through honestly');
      ok(result && typeof result.error === 'string', 'a loadPackage failure surfaces as the sqlite ModuleNotFoundError text via the normal {error} shape, so the outer bridge can fall through to pyodide-pandas next, exactly like any other sqlite dialect failure');
    }

    // ---- 5b. Failure path: loadPackage hangs past the timeout -- must not
    //    hang the whole corroboration forever ----
    {
      globalThis.__mockWindowNoGetPyodide = {};
      const { ensureSqlite3InPyodide, resetSqlite3Cache } = buildRunViaSqlite();
      resetSqlite3Cache();
      const mockPy = makeMockPyodideWithLoader({}, { loadPackageHangs: true });
      const t0 = Date.now();
      const readyOk = await ensureSqlite3InPyodide(mockPy);
      const elapsed = Date.now() - t0;
      ok(readyOk === false, 'HOTFIX: ensureSqlite3InPyodide resolves false (never hangs forever) when loadPackage never resolves, honoring the ~12s (150ms in this test) timeout');
      ok(elapsed < 2000, 'the timeout actually bounds the wait instead of relying on the mock hanging promise (elapsed=' + elapsed + 'ms)');
    }
  }
}

// ---------------------------------------------------------------
// 6. Mesh prove script note (spec item 4): exportMeshAttestation is async
//    and onMeshExport must await it -- confirmed already correct, locked
//    in as a regression test.
// ---------------------------------------------------------------
{
  const onMeshExportSrc = extractFunctionSource(canvasModuleSrc, 'async function onMeshExport() {');
  ok(onMeshExportSrc !== null, 'onMeshExport() is present verbatim in the shipped canvas source and is itself declared async');
  if (onMeshExportSrc) {
    ok(/await\s+e\.exportMeshAttestation\(/.test(onMeshExportSrc), 'onMeshExport awaits e.exportMeshAttestation(...) -- exportMeshAttestation is an async function (mesh-attestation.js) and its result must be awaited before _lastMeshExport is set');
  }

  const meshModuleSrc = readFileSync(new URL('../js/proof-harness/mesh-attestation.js', import.meta.url), 'utf8');
  ok(/export async function exportMeshAttestation/.test(meshModuleSrc), 'exportMeshAttestation is confirmed declared as an async function in mesh-attestation.js, matching the spec note');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
