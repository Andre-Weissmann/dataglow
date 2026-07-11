// ============================================================
// DATAGLOW — Python-bridge truncation warning tests (Bug 1)
// ============================================================
// The Python tab re-serializes every loaded DuckDB table to JSON and rebuilds
// it as a pandas DataFrame on each cell run, capped at PY_BRIDGE_ROW_LIMIT rows.
// That cap used to be SILENT. These tests prove the cap is now surfaced:
//   1. computeBridgeTruncation() flags datasets larger than the limit (and only
//      those), reporting the real row count and the limit.
//   2. runPython() returns a `truncated` descriptor for an oversized table,
//      driving the UI warning — exercised against a real (native) DuckDB table
//      of >PY_BRIDGE_ROW_LIMIT rows, with a stubbed Pyodide.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/python-bridge-truncation.test.mjs
// (the loader hook redirects the browser-only duckdb-engine.js to the native
//  node-api engine, so the exact production runPython code runs under Node.)

import { state } from '../js/app-shell/state.js';
import * as engine from '../js/app-shell/duckdb-engine.js';
import {
  PY_BRIDGE_ROW_LIMIT,
  computeBridgeTruncation,
  runPython,
} from '../js/runtimes-viz/python-runtime.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}

console.log('\ncomputeBridgeTruncation (pure)');
ok('PY_BRIDGE_ROW_LIMIT is 200000', PY_BRIDGE_ROW_LIMIT === 200000, `got ${PY_BRIDGE_ROW_LIMIT}`);

const over = computeBridgeTruncation(
  [{ table: 'big', name: 'big.csv', rowCount: PY_BRIDGE_ROW_LIMIT + 50000 }],
  PY_BRIDGE_ROW_LIMIT
);
ok('flags a dataset larger than the limit', over.length === 1);
ok('reports the real row count', over[0]?.rowCount === PY_BRIDGE_ROW_LIMIT + 50000);
ok('reports the limit', over[0]?.limit === PY_BRIDGE_ROW_LIMIT);

const atLimit = computeBridgeTruncation([{ table: 't', rowCount: PY_BRIDGE_ROW_LIMIT }]);
ok('does NOT flag a dataset exactly at the limit', atLimit.length === 0);
const under = computeBridgeTruncation([{ table: 't', rowCount: 10 }]);
ok('does NOT flag a small dataset', under.length === 0);

console.log('\nrunPython (real DuckDB table > limit, stubbed Pyodide)');
try {
  // Build a table with more rows than the bridge limit, fast, via range().
  const bigRows = PY_BRIDGE_ROW_LIMIT + 1234;
  await engine.runQuery(`CREATE OR REPLACE TABLE big AS SELECT i AS id FROM range(${bigRows}) t(i)`);
  await engine.runQuery(`CREATE OR REPLACE TABLE small AS SELECT i AS id FROM range(100) t(i)`);

  state.datasets = [
    { table: 'big', name: 'big.csv', rowCount: bigRows },
    { table: 'small', name: 'small.csv', rowCount: 100 },
  ];

  // Minimal Pyodide stub: records registered tables, runs no real Python.
  const registered = {};
  let lastName = null, lastJson = null;
  state.pyodide = {
    globals: {
      set(k, v) { if (k === '_tmp_name') lastName = v; if (k === '_tmp_json') lastJson = v; },
    },
    setStdout() {},
    setStderr() {},
    async runPythonAsync(code) {
      if (code.includes('_register')) { registered[lastName] = JSON.parse(lastJson).length; return undefined; }
      return 'ok';
    },
  };

  const res = await runPython('df = dataglow.get_df("big")', 'big');
  ok('runPython returns a truncated array', Array.isArray(res.truncated));
  const bigTrunc = res.truncated.find(t => t.table === 'big');
  ok('the oversized table is reported as truncated', !!bigTrunc, JSON.stringify(res.truncated));
  ok('truncation reports the full row count', bigTrunc?.rowCount === bigRows);
  ok('small table is NOT reported as truncated', !res.truncated.some(t => t.table === 'small'));
  ok('the bridge actually capped the big table to the limit', registered.big === PY_BRIDGE_ROW_LIMIT,
     `registered ${registered.big} rows`);
  ok('the small table was passed in full', registered.small === 100);

  await engine.closeConnection?.();
} catch (e) {
  ok('runPython truncation path executes without throwing', false, e.stack || e.message);
}

console.log(`\n${failed === 0 ? '✓ PASSED' : '✗ FAILED'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
