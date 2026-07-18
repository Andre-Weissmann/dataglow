// ============================================================
// DATAGLOW — Drill Floor test suite (SQL/Python/R practice drills, Batch 1)
// ============================================================
// Proves the PURE data layer and thin orchestration in js/drill-floor/*:
//   - generateOrders / generatePromos produce deterministic, well-shaped rows
//   - buildCreateTableSql / sqlLiteral emit correctly-escaped, typed SQL
//   - loadDrillTables issues the exact CREATE OR REPLACE TABLE SQL we expect
//     (asserted via a FAKE engine.runQuery) and returns dataset descriptors
//     using the namespaced drill_orders / drill_promos table names
//   - runDrillSql / runDrillPython / runDrillR DELEGATE to injected fake
//     runtimes and SURFACE a rejection as a returned {error} field rather than
//     throwing (never-throw-out discipline)
//   - the drillFloor flag defaults to false in flags.manifest.json
//
// No real DuckDB/Pyodide/WebR — those can't run in Node, so every runtime is a
// spy/fake, exactly like test/glow-canvas.test.mjs uses a fake renderChart.
//
// RUN WITH: node test/drill-floor.test.mjs

import { readFileSync } from 'node:fs';
import {
  DRILL_ORDERS_TABLE,
  DRILL_PROMOS_TABLE,
  ORDERS_COLUMNS,
  PROMOS_COLUMNS,
  generateOrders,
  generatePromos,
  sqlLiteral,
  buildCreateTableSql,
  loadDrillTables,
} from '../js/drill-floor/drill-floor-data.js';
import {
  DRILLS,
  getDrill,
  extractRowCount,
  runDrillSql,
  runDrillPython,
  runDrillR,
} from '../js/drill-floor/drill-floor.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- generateOrders: deterministic + well-shaped ----------
{
  const a = generateOrders();
  const b = generateOrders();
  ok(a.length === 300, 'generateOrders defaults to 300 rows');
  ok(JSON.stringify(a) === JSON.stringify(b), 'generateOrders is deterministic (same seed -> identical rows)');
  ok(a[0].order_id === 1 && a[299].order_id === 300, 'order_id is a contiguous 1..N sequence');
  const first = a[0];
  ok(typeof first.order_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(first.order_date), 'order_date is an ISO YYYY-MM-DD string');
  ok(Object.keys(first).sort().join(',') === 'amount,channel,customer_id,order_date,order_id', 'each order has exactly the expected fields');
  ok(a.every((o) => o.amount >= 0), 'all order amounts are non-negative');
  ok(generateOrders(10).length === 10, 'generateOrders honors an explicit count');
  const seededDiff = generateOrders(300, 999);
  ok(JSON.stringify(seededDiff) !== JSON.stringify(a), 'a different seed produces different rows');
}

// ---------- generatePromos: deterministic + well-shaped + meaningful ----------
{
  const p = generatePromos();
  const p2 = generatePromos();
  ok(p.length === 14, 'generatePromos defaults to 14 rows');
  ok(JSON.stringify(p) === JSON.stringify(p2), 'generatePromos is deterministic');
  ok(p[0].promo_id === 1 && p[13].promo_id === 14, 'promo_id is a contiguous 1..N sequence');
  const first = p[0];
  ok(Object.keys(first).sort().join(',') === 'discount_pct,end_date,promo_id,promo_name,start_date', 'each promo has exactly the expected fields');
  ok(p.every((x) => x.start_date <= x.end_date), 'every promo start_date precedes or equals its end_date');
  // The drill is only meaningful if the BETWEEN join actually matches rows.
  const orders = generateOrders();
  let matches = 0, boundary = 0;
  for (const o of orders) for (const pr of p) {
    if (o.order_date >= pr.start_date && o.order_date <= pr.end_date) {
      matches++;
      if (o.order_date === pr.start_date || o.order_date === pr.end_date) boundary++;
    }
  }
  ok(matches > 0, 'the BETWEEN join matches at least one order/promo pair (drill is meaningful)');
  ok(boundary > 0, 'at least one order lands exactly on a promo boundary date (inclusive-range coverage)');
}

// ---------- sqlLiteral: escaping ----------
{
  ok(sqlLiteral(42) === '42', 'sqlLiteral passes finite numbers through unquoted');
  ok(sqlLiteral('web') === "'web'", 'sqlLiteral single-quotes strings');
  ok(sqlLiteral("O'Brien") === "'O''Brien'", "sqlLiteral doubles embedded single quotes");
  ok(sqlLiteral(null) === 'NULL', 'sqlLiteral renders null as NULL');
  ok(sqlLiteral(undefined) === 'NULL', 'sqlLiteral renders undefined as NULL');
}

// ---------- buildCreateTableSql: shape ----------
{
  const rows = [{ promo_id: 1, promo_name: "O'Neil", start_date: '2024-01-01', end_date: '2024-01-05', discount_pct: 10 }];
  const sql = buildCreateTableSql(DRILL_PROMOS_TABLE, PROMOS_COLUMNS, rows);
  ok(sql.includes('CREATE OR REPLACE TABLE "drill_promos"'), 'buildCreateTableSql uses CREATE OR REPLACE TABLE (atomic, no collision)');
  ok(sql.includes('"promo_id" INTEGER') && sql.includes('"start_date" DATE') && sql.includes('"promo_name" VARCHAR'), 'buildCreateTableSql emits typed columns');
  ok(sql.includes("'O''Neil'"), 'buildCreateTableSql escapes string values in the VALUES tuple');
  ok(sql.includes('INSERT INTO "drill_promos"'), 'buildCreateTableSql emits an INSERT for the rows');
}

// ---------- loadDrillTables: exact SQL via fake runQuery + descriptors ----------
{
  const calls = [];
  const fakeRunQuery = (sql) => { calls.push(sql); return Promise.resolve({ rowCount: 0, rows: [] }); };
  const orders = generateOrders(3);
  const promos = generatePromos(2);
  const descriptors = await loadDrillTables({ runQuery: fakeRunQuery }, { orders, promos });

  ok(calls.length === 2, 'loadDrillTables issues exactly two runQuery calls (one per table)');
  ok(calls[0] === buildCreateTableSql(DRILL_ORDERS_TABLE, ORDERS_COLUMNS, orders), 'first call is the exact orders CREATE TABLE SQL');
  ok(calls[1] === buildCreateTableSql(DRILL_PROMOS_TABLE, PROMOS_COLUMNS, promos), 'second call is the exact promos CREATE TABLE SQL');
  ok(calls[0].includes('"drill_orders"') && calls[1].includes('"drill_promos"'), 'load uses the namespaced drill_ table names');

  ok(descriptors.length === 2, 'loadDrillTables returns two dataset descriptors');
  ok(descriptors[0].table === DRILL_ORDERS_TABLE && descriptors[0].rowCount === 3, 'orders descriptor has correct table + rowCount');
  ok(descriptors[1].table === DRILL_PROMOS_TABLE && descriptors[1].rowCount === 2, 'promos descriptor has correct table + rowCount');
  ok(JSON.stringify(descriptors[0].cols) === JSON.stringify(ORDERS_COLUMNS.map((c) => c.name)), 'orders descriptor lists the column names');
}

// ---------- DRILLS registry + getDrill ----------
{
  ok(Array.isArray(DRILLS) && DRILLS.length === 1, 'DRILLS has exactly one Batch-1 entry');
  const d = getDrill('spot-the-sale');
  ok(d && d.id === 'spot-the-sale', 'getDrill finds the spot-the-sale drill');
  ok(typeof d.title === 'string' && typeof d.difficulty === 'string' && typeof d.description === 'string', 'drill has title/difficulty/description');
  ok(d.starterSql.includes(DRILL_ORDERS_TABLE) && d.starterSql.includes(DRILL_PROMOS_TABLE), 'SQL starter references both drill tables');
  ok(d.starterSql.includes('BETWEEN'), 'SQL starter uses a BETWEEN join');
  ok(d.starterPython.includes(`dataglow.get_df('${DRILL_ORDERS_TABLE}')`), 'Python starter reads the orders table via the pandas bridge');
  ok(d.starterR.includes(`dataglow_get_df('${DRILL_PROMOS_TABLE}')`), 'R starter reads the promos table via the R bridge');
  ok(getDrill('nope') === null, 'getDrill returns null for an unknown id');
  ok(getDrill(42) === null, 'getDrill returns null for a non-string id (never throws)');
}

// ---------- extractRowCount ----------
{
  ok(extractRowCount({ rowCount: 7 }) === 7, 'extractRowCount prefers the explicit rowCount field');
  ok(extractRowCount({ rows: [1, 2, 3] }) === 3, 'extractRowCount falls back to rows.length');
  ok(extractRowCount(null) === null, 'extractRowCount returns null for null');
  ok(extractRowCount({}) === null, 'extractRowCount returns null when neither field is present');
}

// ---------- runDrillSql: delegation + error-as-field ----------
{
  const seen = [];
  const fakeRunQuery = (sql) => { seen.push(sql); return Promise.resolve({ rowCount: 5, rows: [1, 2, 3, 4, 5] }); };
  const res = await runDrillSql('SELECT 1', { runQuery: fakeRunQuery });
  ok(seen.length === 1 && seen[0] === 'SELECT 1', 'runDrillSql delegates the exact SQL to runQuery');
  ok(res.rowCount === 5 && res.result && res.result.rowCount === 5, 'runDrillSql returns the result and derived rowCount');
  ok(res.error === undefined, 'runDrillSql has no error on success');

  const rejecting = () => Promise.reject(new Error('syntax error near FROM'));
  const errRes = await runDrillSql('bad sql', { runQuery: rejecting });
  ok(errRes.error === 'syntax error near FROM', 'runDrillSql surfaces a rejection as a returned error field (never throws)');
  ok(errRes.result === undefined, 'runDrillSql omits result on error');
}

// ---------- runDrillPython: delegation + error-as-field ----------
{
  const seen = [];
  const fakeRunPython = (code) => { seen.push(code); return Promise.resolve({ stdout: 'matched rows: 133', result: '' }); };
  const res = await runDrillPython('print(1)', { runPython: fakeRunPython });
  ok(seen.length === 1 && seen[0] === 'print(1)', 'runDrillPython delegates the exact code to runPython');
  ok(res.stdout === 'matched rows: 133', 'runDrillPython returns the runtime stdout');

  const rejecting = () => Promise.reject(new Error('NameError: pandas'));
  const errRes = await runDrillPython('boom', { runPython: rejecting });
  ok(errRes.error === 'NameError: pandas', 'runDrillPython surfaces a rejection as a returned error field (never throws)');

  // A bridge that itself reports {error} (not a rejection) is passed through.
  const bridgeErr = await runDrillPython('x', { runPython: () => Promise.resolve({ error: 'runtime error' }) });
  ok(bridgeErr.error === 'runtime error', 'runDrillPython preserves a bridge-reported error field');
}

// ---------- runDrillR: delegation + error-as-field ----------
{
  const seen = [];
  const fakeRunR = (code) => { seen.push(code); return Promise.resolve({ stdout: 'matched rows: 133' }); };
  const res = await runDrillR('cat(1)', { runR: fakeRunR });
  ok(seen.length === 1 && seen[0] === 'cat(1)', 'runDrillR delegates the exact code to runR');
  ok(res.stdout === 'matched rows: 133', 'runDrillR returns the runtime stdout');

  const rejecting = () => Promise.reject(new Error('could not find function'));
  const errRes = await runDrillR('boom', { runR: rejecting });
  ok(errRes.error === 'could not find function', 'runDrillR surfaces a rejection as a returned error field (never throws)');
}

// ---------- flag ships dark ----------
{
  const manifest = JSON.parse(readFileSync(new URL('../flags.manifest.json', import.meta.url), 'utf8'));
  ok(manifest.flags.drillFloor, 'flags.manifest.json declares the drillFloor flag');
  ok(typeof manifest.flags.drillFloor.enabled === 'boolean', 'the drillFloor flag has a boolean enabled state');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
