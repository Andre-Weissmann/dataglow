// ============================================================
// DATAGLOW - HOTFIX: pyodide-sqlite proxy handling + mesh/excel export
// ============================================================
// HOTFIX_SQLITE_PROXY_MESH_SPEC.md. Live prove on b9add21 found:
//   - COUNT second engine fell to pyodide-pandas (sqlite never won)
//   - SELECT SUM(1) -> pyodide-sql-unavailable
//   - mesh export returned empty object / null digests
//
// Root cause #1: runViaPyodideSqlite read
// `_dg_second_engine_sqlite_error` with a raw `!== undefined && !== null`
// check. A real Pyodide PyProxy wrapping Python's `None` is an OBJECT (not
// JS null/undefined) whose String() is the literal text "None" -- so every
// successful sqlite run (which leaves that global as None) was
// misclassified as an error, and the payload string was JSON.parse()'d
// directly instead of being unwrapped via .toJs()/toString() first.
//
// Root cause #2: when the JS-side listCsvGlobalTableNames(py.globals) walk
// found no dg_csv_* keys (proxy iteration is not always reliable the very
// first tick after buildHelper(py) runs), there was no fallback -- the
// generated Python never looked for tables itself.
//
// Root cause #3 (verification/regression lock): exportMeshAttestation,
// importMeshAttestation, compareMeshAttestations, parseExcelAggregateClaim,
// excelClaimToSql must be reachable on window.DataGlowProofHarness, exactly
// as the canvas Mesh tab's onMeshExport/onMeshCompare call them.
//
// Covers HOTFIX_SQLITE_PROXY_MESH_SPEC.md "Tests" section:
//   1. pyToJs / isRealPyodideErrorValue: None-proxy handling
//   2. runViaPyodideSqlite: a PyProxy-shaped None error global no longer
//      misfires as an error; a PyProxy-shaped payload is unwrapped via
//      toJs()/toString() before JSON.parse
//   3. buildSqliteRegisterAndQuerySnippet: Python-side dg_csv_* discovery
//      fallback when tableNames is empty; explicit non-empty tableNames
//      still takes the direct (non-discovery) path, unchanged
//   4. End-to-end: runProofSecondEngineBridge resolves engine:
//      'pyodide-sqlite' for COUNT/SUM even when every second-engine global
//      is handed back wrapped in a PyProxy-like mock (never a plain value)
//   5. Mesh: window.DataGlowProofHarness exports exportMeshAttestation,
//      importMeshAttestation, compareMeshAttestations,
//      parseExcelAggregateClaim, excelClaimToSql -- and a real export/
//      import/compare round trip succeeds through that exact surface
//   6. Existing sqlite + v2 suites still pass (verified by running them
//      alongside this file; see HOTFIX_SQLITE_PROXY_MESH_RESULT.md)
//
// RUN WITH: node test/hotfix-sqlite-proxy-mesh-export.test.mjs

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

function loadFn(startMarker, fnName) {
  const fnSrc = extractFunctionSource(canvasModuleSrc, startMarker);
  ok(fnSrc !== null, `${fnName} is present verbatim in the shipped canvas module source with a matching closing brace`);
  if (!fnSrc) return null;
  // eslint-disable-next-line no-new-func
  return new Function(`${fnSrc}\nreturn ${fnName};`)();
}

/* A minimal fake PyProxy: NOT a JS primitive, NOT JS null/undefined, but
   represents Python's None. String(proxy) is the literal text "None",
   exactly matching Pyodide's real behavior, and it deliberately has no
   .toJs() (some real Pyodide proxy shapes for None do not expose one, or
   .toJs() on a None proxy simply returns undefined/null -- both must be
   handled). */
function makeNoneProxyNoToJs() {
  return { toString() { return 'None'; } };
}
function makeNoneProxyWithToJs() {
  return { toJs() { return null; }, toString() { return 'None'; } };
}
function makeStringProxy(str) {
  return { toJs() { return str; }, toString() { return str; } };
}

// ---------------------------------------------------------------
// 1. pyToJs -- pure helper unit tests
// ---------------------------------------------------------------
const pyToJs = loadFn('function pyToJs(v) {', 'pyToJs');
if (pyToJs) {
  ok(pyToJs(null) === null, 'pyToJs(null) -> null');
  ok(pyToJs(undefined) === null, 'pyToJs(undefined) -> null');
  ok(pyToJs('hello') === 'hello', 'pyToJs(a real string) returns the string unchanged');
  ok(pyToJs(makeStringProxy('{"a":1}')) === '{"a":1}', 'pyToJs(a proxy with .toJs()) returns the .toJs() conversion');
  ok(pyToJs(makeNoneProxyWithToJs()) === null, 'pyToJs(a None-proxy whose .toJs() returns null) -> null (never the object itself)');
  ok(pyToJs(makeNoneProxyNoToJs()) === 'None', 'pyToJs(a None-proxy with no .toJs(), only toString()) falls back to String(v) === "None"');
  ok(pyToJs(42) === '42', 'pyToJs(a bare number, e.g. a test mock with no proxy at all) coerces via String()');
  const throwingProxy = { toJs() { throw new Error('boom'); }, toString() { return 'fallback-text'; } };
  ok(pyToJs(throwingProxy) === 'fallback-text', 'pyToJs swallows a throwing .toJs() and falls back to the string path instead of propagating');
  const totallyBroken = { toJs() { throw new Error('boom'); }, toString() { throw new Error('also boom'); } };
  ok(pyToJs(totallyBroken) === null, 'pyToJs never throws even when every conversion path fails -- returns null as the last resort');
}

// ---------------------------------------------------------------
// 2. isRealPyodideErrorValue -- the None vs error discriminator
// ---------------------------------------------------------------
function loadFnWithPyToJs(startMarker, fnName) {
  const fnSrc = extractFunctionSource(canvasModuleSrc, startMarker);
  const pyToJsSrcForPrelude = extractFunctionSource(canvasModuleSrc, 'function pyToJs(v) {');
  ok(fnSrc !== null, `${fnName} is present verbatim in the shipped canvas module source with a matching closing brace`);
  if (!fnSrc || !pyToJsSrcForPrelude) return null;
  // eslint-disable-next-line no-new-func
  return new Function(`${pyToJsSrcForPrelude}\n${fnSrc}\nreturn ${fnName};`)();
}

const isRealPyodideErrorValue = loadFnWithPyToJs('function isRealPyodideErrorValue(v) {', 'isRealPyodideErrorValue');
if (isRealPyodideErrorValue) {
  ok(isRealPyodideErrorValue(null) === false, 'null is never treated as an error');
  ok(isRealPyodideErrorValue(undefined) === false, 'undefined is never treated as an error');
  ok(isRealPyodideErrorValue('') === false, 'an empty string is never treated as an error');
  ok(isRealPyodideErrorValue('None') === false, 'the literal string "None" is never treated as an error (spec: ignore null/undefined/\'\'/\'None\')');
  ok(isRealPyodideErrorValue(makeNoneProxyNoToJs()) === false, 'THE LIVE BUG: a PyProxy representing Python None (String(proxy) === "None", no .toJs()) is truthy under `!== undefined && !== null` but must still NOT be treated as an error');
  ok(isRealPyodideErrorValue(makeNoneProxyWithToJs()) === false, 'a PyProxy representing Python None whose .toJs() returns null is not treated as an error either');
  ok(isRealPyodideErrorValue('no such table: orders') === true, 'a genuine non-empty error string IS treated as an error');
  ok(isRealPyodideErrorValue(makeStringProxy('near "X": syntax error')) === true, 'a genuine error message wrapped in a PyProxy with .toJs() is still recognized as a real error');
  ok(isRealPyodideErrorValue('   ') === false, 'a whitespace-only string is treated the same as empty -- not a real error');
}

// ---------------------------------------------------------------
// 3. buildSqliteRegisterAndQuerySnippet -- Python-side discovery fallback
// ---------------------------------------------------------------
const buildSqliteRegisterAndQuerySnippet = loadFn('function buildSqliteRegisterAndQuerySnippet(statement, tableNames) {', 'buildSqliteRegisterAndQuerySnippet');
if (buildSqliteRegisterAndQuerySnippet) {
  const emptySnippet = buildSqliteRegisterAndQuerySnippet('SELECT COUNT(*) AS n FROM orders', []);
  ok(/list\(globals\(\)\)/.test(emptySnippet), 'HOTFIX #2: an empty tableNames list makes the snippet discover dg_csv_* tables itself via list(globals()) inside Python');
  ok(/dg_csv_\(\.\+\)/.test(emptySnippet) || /\^dg_csv_/.test(emptySnippet), 'the Python-side discovery regex matches the same dg_csv_<name> prefix convention as the JS-side DG_CSV_GLOBAL_RE');
  ok(/\.to_sql\(/.test(emptySnippet), 'discovered tables are still registered via to_sql, same as the explicit-name path');
  ok(emptySnippet.includes('SELECT COUNT(*) AS n FROM orders'), 'the caller statement is still embedded verbatim when falling back to discovery');

  const explicitSnippet = buildSqliteRegisterAndQuerySnippet('SELECT COUNT(*) AS n FROM orders', ['orders']);
  ok(!/_dg_discovered_csv_names/.test(explicitSnippet), 'a NON-empty tableNames list takes the direct explicit-name path, unchanged -- discovery is a fallback only, never a replacement');
  ok(explicitSnippet.includes('"dg_csv_orders"'), 'the explicit path still looks up the dg_csv_orders global by exact name');

  const namesWithUnsafeChars = buildSqliteRegisterAndQuerySnippet('SELECT 1', []);
  ok(/_dg_re\.sub\(/.test(namesWithUnsafeChars), 'the discovery path sanitizes discovered names the same way the JS side does (non [A-Za-z0-9_] -> "_") before use as a sqlite table name');
}

// ---------------------------------------------------------------
// 4. End-to-end: runViaPyodideSqlite against a PyProxy-only mock py.globals
//    (every value is wrapped, nothing is ever a bare JS null/string) --
//    this is the realistic shape of a live Pyodide runtime, unlike the
//    plain-value mocks used elsewhere.
// ---------------------------------------------------------------
{
  const listCsvSrc = extractFunctionSource(canvasModuleSrc, 'function listCsvGlobalTableNames(globalKeys) {');
  const pyToJsSrc = extractFunctionSource(canvasModuleSrc, 'function pyToJs(v) {');
  const isRealErrSrc = extractFunctionSource(canvasModuleSrc, 'function isRealPyodideErrorValue(v) {');
  const buildSqliteSnippetSrc = extractFunctionSource(canvasModuleSrc, 'function buildSqliteRegisterAndQuerySnippet(statement, tableNames) {');
  const runViaSqliteSrc = extractFunctionSource(canvasModuleSrc, 'async function runViaPyodideSqlite(py, statement) {');
  // HOTFIX_PYODIDE_LOAD_SQLITE3_SPEC.md: runViaPyodideSqlite now calls
  // ensureSqlite3InPyodide(py) first, so the harness must include it (and
  // its withTimeout dependency) or the call throws ReferenceError inside
  // runViaPyodideSqlite's own try/catch, masking every result as null.
  const ensureSqlite3Src = extractFunctionSource(canvasModuleSrc, 'function ensureSqlite3InPyodide(py) {');
  const withTimeoutSrc = extractFunctionSource(canvasModuleSrc, 'function withTimeout(promise, ms) {');
  const dgCsvGlobalReSrc = (() => {
    const m = /var DG_CSV_GLOBAL_RE = [^\n]+\n/.exec(canvasModuleSrc);
    return m ? m[0] : 'var DG_CSV_GLOBAL_RE = /^dg_csv_(.+)$/;\n';
  })();

  const allPresent = [listCsvSrc, pyToJsSrc, isRealErrSrc, buildSqliteSnippetSrc, runViaSqliteSrc, ensureSqlite3Src, withTimeoutSrc].every(Boolean);
  ok(allPresent, 'all pieces needed to run runViaPyodideSqlite in isolation (including the sqlite3-load guard) are present verbatim in the shipped source');

  if (allPresent) {
    const harnessSrc = `
      var window = globalThis.__mockWindowProxyMesh || {};
      ${dgCsvGlobalReSrc}
      ${withTimeoutSrc}
      var SQLITE3_LOAD_TIMEOUT_MS = 150;
      var _sqlite3ReadyPromise = null;
      ${ensureSqlite3Src}
      ${pyToJsSrc}
      ${isRealErrSrc}
      ${listCsvSrc}
      ${buildSqliteSnippetSrc}
      ${runViaSqliteSrc}
      return runViaPyodideSqlite;
    `;
    // eslint-disable-next-line no-new-func
    const buildRunViaSqlite = new Function(harnessSrc);
    const runViaPyodideSqlite = buildRunViaSqlite();

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

    /* A PyProxy-faithful mock: EVERY global read/write goes through proxy-
       shaped wrappers, and a value that was never explicitly set (e.g.
       Python None at declaration time) comes back as a None-proxy, not
       JS undefined -- this is the exact shape that broke the pre-hotfix
       `errProxy !== undefined && errProxy !== null` check. */
    function makeProxyFaithfulMockPy(csvByTable) {
      const globals = new Map();
      Object.keys(csvByTable).forEach((t) => globals.set('dg_csv_' + t, makeStringProxy(csvByTable[t])));
      const sqliteTables = {};
      return {
        globals: {
          set(k, v) { globals.set(k, v); },
          get(k) {
            if (!globals.has(k)) return makeNoneProxyNoToJs();
            return globals.get(k);
          },
          keys() { return globals.keys(); },
        },
        async runPythonAsync(code) {
          if (!/^import pandas as pd, io, sqlite3, json/.test(code)) throw new Error('unsupported runPythonAsync: ' + code);
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
          // Python-side discovery loop shape (HOTFIX #2): no literal
          // per-table lines to match above -- discover every dg_csv_*
          // global directly, mirroring list(globals()) at runtime.
          if (/_dg_discovered_csv_names/.test(code) && registered.length === 0) {
            for (const key of globals.keys()) {
              const m = /^dg_csv_(.+)$/.exec(key);
              if (!m) continue;
              const proxy = globals.get(key);
              if (!proxy) continue;
              const tableName = m[1].replace(/[^a-zA-Z0-9_]/g, '_');
              sqliteTables[tableName] = parseCsv(proxy.toJs ? proxy.toJs() : String(proxy));
              registered.push(tableName);
            }
          }
          const sqlMatch = /pd\.read_sql_query\((".*?"|'.*?'|`[\s\S]*?`),\s*_dg_sqlite_conn\)/.exec(code);
          let sqlText = null;
          if (sqlMatch) { try { sqlText = JSON.parse(sqlMatch[1]); } catch (_e) { sqlText = sqlMatch[1]; } }
          // Proxy-shaped writes, mirroring live Pyodide: registered names as
          // a proxy with .toJs(), the error flag as a None-proxy on success
          // (NEVER JS null/undefined), and the payload as a proxy whose
          // .toJs() returns the JSON string (never a bare string either).
          globals.set('_dg_second_engine_sqlite_tables_registered', { toJs() { return registered; } });
          try {
            const res = runMockSql(sqlText, sqliteTables);
            globals.set('_dg_second_engine_sqlite_error', makeNoneProxyNoToJs());
            globals.set('_dg_second_engine_sqlite_payload', makeStringProxy(JSON.stringify({ columns: res.columns, rows: res.rows, rowCount: res.rows.length })));
          } catch (eMockSql) {
            globals.set('_dg_second_engine_sqlite_error', makeStringProxy(eMockSql.message));
            globals.set('_dg_second_engine_sqlite_payload', makeNoneProxyNoToJs());
          }
        },
      };
    }

    // ---- THE live-proven bug, reproduced and fixed: COUNT(*) via a fully
    // proxy-shaped mock must succeed, not silently fall through ----
    {
      const csv = '"id","amount"\n"1","10"\n"2","20"\n"3","30"';
      const mockPy = makeProxyFaithfulMockPy({ orders: csv });
      const result = await runViaPyodideSqlite(mockPy, 'SELECT COUNT(*) AS n FROM orders');
      ok(result !== null && !result.error, 'HOTFIX: SELECT COUNT(*) succeeds against a fully PyProxy-shaped mock (None-proxy error flag, proxy-wrapped payload) -- this is exactly the live-proven bug (COUNT fell through to pyodide-pandas)');
      ok(result && result.engine === 'pyodide-sqlite', 'the result is tagged engine: pyodide-sqlite even when every Pyodide global came back as a proxy');
      ok(result && result.scalars && result.scalars.n === 3, 'COUNT(*) AS n correctly returns n=3 through the proxy-shaped path');
    }

    // ---- SELECT SUM(...) via the same proxy-shaped mock (spec: "SELECT
    // SUM(1) -> pyodide-sql-unavailable" was the live-proven symptom) ----
    {
      const csv = '"id","amount"\n"1","10"\n"2","20"\n"3","30"';
      const mockPy = makeProxyFaithfulMockPy({ orders: csv });
      const result = await runViaPyodideSqlite(mockPy, 'SELECT SUM(amount) AS s FROM orders');
      ok(result !== null && !result.error, 'HOTFIX: SELECT SUM(amount) succeeds against the proxy-shaped mock (previously this shape of statement surfaced pyodide-sql-unavailable live)');
      ok(result && result.scalars && result.scalars.s === 60, 'SUM(amount) AS s correctly returns s=60 through the proxy-shaped path');
    }

    // ---- A genuine sqlite error (not a None proxy) is still surfaced ----
    {
      const mockPy = makeProxyFaithfulMockPy({ orders: '"id"\n"1"' });
      const result = await runViaPyodideSqlite(mockPy, 'SELECT COUNT(*) AS n FROM nonexistent_table');
      ok(result && !!result.error, 'a genuine sqlite error (missing table) is still correctly surfaced as {error} even with a fully proxy-shaped mock -- the None-vs-error fix never masks a REAL error');
      ok(typeof result.error === 'string' && result.error.includes('no such table'), 'the surfaced error is the real, unwrapped error text, not "[object Object]" or a stringified proxy');
    }

    // ---- Empty JS-side tableNames -> Python-side discovery still finds
    // the table and succeeds (root cause #2, exercised end-to-end) ----
    {
      const csv = '"id"\n"1"\n"2"\n"3"\n"4"';
      const mockPy = makeProxyFaithfulMockPy({ widgets: csv });
      // Force the JS-side listCsvGlobalTableNames() walk to see nothing,
      // simulating the live "proxy iteration unreliable on first tick"
      // failure mode -- .keys() throws, listCsvGlobalTableNames's own
      // try/catch in runViaPyodideSqlite already handles this by using [].
      const originalKeys = mockPy.globals.keys;
      mockPy.globals.keys = () => { throw new Error('proxy iteration not ready yet'); };
      const result = await runViaPyodideSqlite(mockPy, 'SELECT COUNT(*) AS n FROM widgets');
      ok(result !== null && !result.error, 'HOTFIX #2: even when the JS-side table listing throws/returns empty, Python-side list(globals()) discovery still finds dg_csv_widgets and answers the query');
      ok(result && result.scalars && result.scalars.n === 4, 'the Python-discovered table still returns the correct COUNT(*), n=4');
      mockPy.globals.keys = originalKeys;
    }
  }
}

// ---------------------------------------------------------------
// 5. Mesh + Excel helpers on window.DataGlowProofHarness
// ---------------------------------------------------------------
{
  const inject = readFileSync(new URL('../inject_proof_harness_v2.py', import.meta.url), 'utf8');
  const requiredKeys = [
    'exportMeshAttestation',
    'importMeshAttestation',
    'compareMeshAttestations',
    'verifyMeshAttestationHash',
    'parseExcelAggregateClaim',
    'excelClaimToSql',
  ];
  for (const key of requiredKeys) {
    ok(new RegExp(`${key}:\\s*${key}`).test(inject), `inject_proof_harness_v2.py's DataGlowProofHarness object literal publishes ${key} (canvas Mesh/Excel UI calls window.DataGlowProofHarness.${key})`);
  }

  const indexSrc = readFileSync(new URL('../js/proof-harness/index.js', import.meta.url), 'utf8');
  for (const key of requiredKeys) {
    ok(indexSrc.includes(key), `js/proof-harness/index.js re-exports/defines ${key}`);
  }
  ok(/window\.DataGlowProofHarness\s*=\s*DataGlowProofHarness/.test(indexSrc), 'index.js publishes the combined object as window.DataGlowProofHarness (desktop/ESM path)');

  const canvasHtml = readFileSync(new URL('../canvas/index.html', import.meta.url), 'utf8');
  for (const key of requiredKeys) {
    ok(new RegExp(`${key}:\\s*${key}`).test(canvasHtml), `the shipped canvas/index.html bundle publishes ${key} on window.DataGlowProofHarness (this is what a live prove() actually loads)`);
  }
}

// ---------------------------------------------------------------
// 6. Mesh export: a real round trip through the exact pure-module surface
//    the canvas Mesh tab calls (exportMeshAttestation -> importMeshAttestation
//    -> compareMeshAttestations), proving the shape the canvas depends on
//    still produces a non-empty attestation with real digests (spec: "mesh
//    export returned empty object / null digests").
// ---------------------------------------------------------------
{
  const { exportMeshAttestation, importMeshAttestation, compareMeshAttestations } = await import('../js/proof-harness/mesh-attestation.js');

  const proposal = { statement: 'SELECT COUNT(*) AS n FROM claims_example', digest: 'sha256:deadbeef', expected: { rowCount: 1, scalars: { n: 10 } }, engine: 'duckdb' };
  const verdict = { state: 'GREEN', reasonCode: null };
  const run = { status: 'ok', rowCount: 1, scalars: { n: 10 }, error: null };
  const receipt = { hash: 'sha256:abc123' };

  const exported = await exportMeshAttestation({ proposal, verdict, run, receipt, schema: [{ name: 'n', type: 'BIGINT' }] });
  ok(exported.rejected === false, 'exportMeshAttestation succeeds for a normal GREEN proven cycle (spec: must not return an empty object)');
  if (!exported.rejected) {
    ok(typeof exported.attestation.attestationHash === 'string' && exported.attestation.attestationHash.startsWith('sha256:'), 'the exported attestation carries a real, non-null attestationHash digest (spec: "mesh export returned ... null digests")');
    ok(exported.attestation.statement === proposal.statement, 'the exported attestation carries the real statement text');
    ok(exported.attestation.verdict && exported.attestation.verdict.state === 'GREEN', 'the exported attestation carries the real verdict state');
    ok(typeof exported.attestation.schemaFingerprint === 'string' && exported.attestation.schemaFingerprint.length > 0, 'the exported attestation carries a non-null schemaFingerprint digest');
    ok(!('rows' in exported.attestation) && !('result' in exported.attestation), 'the exported attestation is row-free -- no rows/result field leaked through');

    const imported = importMeshAttestation(JSON.stringify(exported.attestation));
    ok(imported.rejected === false, 'importMeshAttestation successfully parses the exported attestation JSON text (the exact string the canvas textarea holds)');

    const comparison = compareMeshAttestations(imported.attestation, imported.attestation);
    ok(comparison.agree === true, 'comparing an attestation to itself agrees, proving the full export -> import -> compare surface the canvas Mesh tab drives is functional end to end');
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
