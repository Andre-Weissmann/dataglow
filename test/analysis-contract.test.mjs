// ============================================================
// DATAGLOW — Local Analysis Contract test suite
// ============================================================
// Pure, DB-free, browser-free logic — see js/validation/analysis-contract.js.
// Covers: schema-hallucination detection (exact miss + near-miss), aggregation
// mismatches (COUNT without DISTINCT across a join; SUM of a rate-like
// column), missing guard-clause detection, the top-level report/summary, and
// graceful degradation on a query none of the checks can fully parse.
//
// Join fan-out risk is intentionally NOT tested here — see
// test/ambient-validation.test.mjs's checkSanityAnchor coverage, which now
// owns that concern (including the stats-aware upgrade).
//
// RUN WITH:  node test/analysis-contract.test.mjs
// (No DuckDB needed — schema is a hand-built plain object, matching this
// module's design goal of being testable without the real engine.)

import {
  buildSchemaIndex,
  checkSchemaHallucination,
  checkAggregationMismatch,
  checkMissingGuardClauses,
  runAnalysisContract,
  summarizeAnalysisContract,
} from '../js/validation/analysis-contract.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- fixture schema ----------
// orders: 10,000 rows, order_id fully unique (10,000 distinct)
// line_items: 40,000 rows, order_id only 10,000 distinct (4 items/order on avg)
// customers: 5,000 rows, one of which is a soft-delete guard column
const schema = {
  tables: {
    orders: {
      columns: [
        { name: 'order_id', type: 'BIGINT' },
        { name: 'customer_id', type: 'BIGINT' },
        { name: 'total_amount', type: 'DOUBLE' },
        { name: 'discount_rate', type: 'DOUBLE' },
        { name: 'is_test_account', type: 'BOOLEAN' },
        { name: 'created_at', type: 'DATE' },
      ],
      rowCount: 10000,
      approxDistinct: { order_id: 10000, customer_id: 3000 },
    },
    line_items: {
      columns: [
        { name: 'line_item_id', type: 'BIGINT' },
        { name: 'order_id', type: 'BIGINT' },
        { name: 'sku', type: 'VARCHAR' },
        { name: 'quantity', type: 'INTEGER' },
      ],
      rowCount: 40000,
      approxDistinct: { line_item_id: 40000, order_id: 10000 },
    },
    customers: {
      columns: [
        { name: 'customer_id', type: 'BIGINT' },
        { name: 'email', type: 'VARCHAR' },
        { name: 'is_deleted', type: 'BOOLEAN' },
      ],
      rowCount: 5000,
      approxDistinct: { customer_id: 5000 },
    },
  },
};

function main() {
  const schemaIndex = buildSchemaIndex(schema);

  // ===== buildSchemaIndex =====
  ok(schemaIndex.tableNames.has('orders'), 'buildSchemaIndex: recognizes table names');
  ok(schemaIndex.allColumns.has('order_id'), 'buildSchemaIndex: indexes column names lowercase');
  ok(schemaIndex.allColumns.get('order_id').length === 2, 'buildSchemaIndex: same column name across two tables both indexed');

  // ===== Check 1: Schema hallucination =====
  const hallucinated = checkSchemaHallucination('SELECT total_revenue FROM orders', schemaIndex);
  ok(hallucinated.some(f => f.kind === 'schema_hallucination' && f.identifier === 'total_revenue'),
    'schema_hallucination: flags a column that does not exist anywhere in the schema');
  ok(hallucinated.find(f => f.identifier === 'total_revenue').severity === 'fail',
    'schema_hallucination: a totally unrelated identifier is severity fail (no close match)');

  const nearMiss = checkSchemaHallucination('SELECT totl_amount FROM orders', schemaIndex);
  const nm = nearMiss.find(f => f.identifier === 'totl_amount');
  ok(nm && nm.suggestion === 'total_amount', 'schema_hallucination: near-miss spelling suggests the real column');
  ok(nm && nm.severity === 'warn', 'schema_hallucination: a close-match near-miss is severity warn, not fail');

  const clean = checkSchemaHallucination('SELECT order_id, total_amount FROM orders WHERE customer_id = 1', schemaIndex);
  ok(clean.length === 0, 'schema_hallucination: a query using only real columns produces zero flags');

  const realTableRef = checkSchemaHallucination('SELECT o.order_id FROM orders o JOIN line_items li ON o.order_id = li.order_id', schemaIndex);
  ok(realTableRef.length === 0, 'schema_hallucination: table names and short aliases are not flagged as hallucinated columns');

  // ===== Check 2: Aggregation mismatches =====

  const countJoinSql = `SELECT o.customer_id, COUNT(o.order_id) AS n
                         FROM orders o JOIN line_items li ON o.order_id = li.order_id
                         GROUP BY o.customer_id`;
  const countFlags = checkAggregationMismatch(countJoinSql);
  ok(countFlags.some(f => f.aggregate === 'COUNT'), 'aggregation_mismatch: flags COUNT(col) without DISTINCT across a JOIN');

  const countDistinctSql = `SELECT COUNT(DISTINCT o.order_id) AS n FROM orders o JOIN line_items li ON o.order_id = li.order_id`;
  const countDistinctFlags = checkAggregationMismatch(countDistinctSql);
  ok(!countDistinctFlags.some(f => f.aggregate === 'COUNT'), 'aggregation_mismatch: COUNT(DISTINCT col) across a JOIN is not flagged');

  const sumRateSql = `SELECT SUM(discount_rate) AS total_discount FROM orders`;
  const sumRateFlags = checkAggregationMismatch(sumRateSql);
  ok(sumRateFlags.some(f => f.aggregate === 'SUM' && f.column === 'discount_rate'),
    'aggregation_mismatch: flags SUM() of a column whose name suggests it is a rate/ratio/average');
  ok(sumRateFlags.find(f => f.aggregate === 'SUM').severity === 'warn', 'aggregation_mismatch: SUM-of-a-rate is severity warn');

  const sumAmountSql = `SELECT SUM(total_amount) AS revenue FROM orders`;
  ok(checkAggregationMismatch(sumAmountSql).length === 0,
    'aggregation_mismatch: SUM() of an ordinary amount column (not rate-like) is not flagged');

  // ===== Check 3: Missing guard clauses =====
  const noGuardSql = `SELECT SUM(total_amount) AS revenue FROM orders`;
  const guardFlags = checkMissingGuardClauses(noGuardSql, schemaIndex);
  ok(guardFlags.some(f => f.column === 'is_test_account'),
    'missing_guard_clause: flags an aggregate query that never references a known test-account guard column');

  const withGuardSql = `SELECT SUM(total_amount) AS revenue FROM orders WHERE is_test_account = false`;
  ok(checkMissingGuardClauses(withGuardSql, schemaIndex).length === 0,
    'missing_guard_clause: referencing the guard column anywhere in the query suppresses the flag');

  const noAggGuardSql = `SELECT order_id FROM orders`;
  ok(checkMissingGuardClauses(noAggGuardSql, schemaIndex).length === 0,
    'missing_guard_clause: a non-aggregating query is not flagged (guard clauses matter most for totals)');

  const deletedCustomersSql = `SELECT COUNT(customer_id) FROM customers`;
  const delFlags = checkMissingGuardClauses(deletedCustomersSql, schemaIndex);
  ok(delFlags.some(f => f.column === 'is_deleted'), 'missing_guard_clause: also catches is_deleted-style guard columns, not just test-account ones');

  // ===== Top-level: runAnalysisContract =====
  const cleanReport = runAnalysisContract(
    'SELECT customer_id, SUM(total_amount) AS revenue FROM orders WHERE is_test_account = false GROUP BY customer_id',
    schema
  );
  ok(cleanReport.status === 'pass', 'runAnalysisContract: a well-formed, guarded query against real columns reports status=pass');
  ok(cleanReport.flagCount === 0, 'runAnalysisContract: the clean query has zero flags');

  const messyReport = runAnalysisContract(
    `SELECT o.customer_id, COUNT(o.order_id) AS orders_count, SUM(discount_rate) AS total_discount
     FROM orders o JOIN line_items li ON o.order_id = li.order_id
     GROUP BY o.customer_id`,
    schema
  );
  ok(messyReport.status === 'warn', 'runAnalysisContract: a query with only warn/info-level flags reports status=warn (no fail-level flags present)');
  ok(messyReport.flags.length >= 2, `runAnalysisContract: multiple independent checks all contribute flags to one report (got ${messyReport.flags.length})`);
  ok(messyReport.flags[0].severity !== 'info' || messyReport.flags.every(f => f.severity === 'info'),
    'runAnalysisContract: flags are sorted worst-severity-first');

  const failReport = runAnalysisContract('SELECT made_up_column FROM orders', schema);
  ok(failReport.status === 'fail', 'runAnalysisContract: a hallucinated column with no close match escalates overall status to fail');

  // ===== Graceful degradation =====
  // A query DATAGLOW's checks can't cleanly parse (e.g. malformed JOIN syntax)
  // must never throw out of the top-level entry point — each check silently
  // contributes nothing rather than blocking the others.
  let degradedReport;
  let threw = false;
  try {
    degradedReport = runAnalysisContract('SELECT * FROM orders JOIN ON WHERE ===', schema);
  } catch {
    threw = true;
  }
  ok(!threw, 'runAnalysisContract: never throws on malformed/unparseable SQL, even with garbage JOIN syntax');
  ok(degradedReport && typeof degradedReport.status === 'string', 'runAnalysisContract: still returns a well-shaped report on malformed SQL');

  // ===== summarizeAnalysisContract =====
  ok(summarizeAnalysisContract(cleanReport).includes('No schema'), 'summarizeAnalysisContract: clean report summary reads as all-clear');
  const summary = summarizeAnalysisContract(messyReport);
  ok(summary.length > 0 && !summary.includes('undefined'), 'summarizeAnalysisContract: produces a readable one-line summary with no undefined values');
  ok(/review/i.test(summary), 'summarizeAnalysisContract: a report with flags tells the analyst to review before trusting the result');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
