// ============================================================
// DATAGLOW — Semantic / Metrics Layer test suite
// ============================================================
// Pure, DB-free, browser-free logic — see js/validation/semantic-layer.js.
// Covers: registering a metric (required fields, column derivation, provenance),
// the registry accessors, matching a query against a definition (no flag),
// detecting an expression mismatch via an alias (missing-term hint), the
// comment-based softer signal, the empty-registry passthrough, and the wiring
// into runAnalysisContract — including the hard guarantee that with NO metrics
// option the Contract is byte-for-byte the same three finding classes as before.
//
// RUN WITH:  node test/semantic-layer.test.mjs
// (No DuckDB needed — the registry is a plain in-memory object and the schema
// is a hand-built plain object, matching the design goal of being testable
// without the real engine.)

import {
  registerMetric,
  getRegisteredMetrics,
  getMetric,
  unregisterMetric,
  clearMetrics,
  deriveColumnsFromExpression,
  checkQueryAgainstMetrics,
} from '../js/validation/semantic-layer.js';
import { runAnalysisContract } from '../js/validation/analysis-contract.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Fixture schema reused for the runAnalysisContract wiring tests.
const schema = {
  tables: {
    orders: {
      columns: [
        { name: 'order_id', type: 'BIGINT' },
        { name: 'amount', type: 'DOUBLE' },
        { name: 'refund_amount', type: 'DOUBLE' },
        { name: 'is_test_account', type: 'BOOLEAN' },
      ],
      rowCount: 10000,
      approxDistinct: { order_id: 10000 },
    },
  },
};

// The canonical net_revenue definition used across several cases.
const NET_REVENUE = {
  name: 'net_revenue',
  expression: 'SUM(amount) - SUM(refund_amount)',
  description: 'Revenue after refunds',
  owner: 'finance',
};

function main() {
  // ===== deriveColumnsFromExpression =====
  const cols = deriveColumnsFromExpression('SUM(amount) - SUM(refund_amount)');
  ok(cols.includes('amount') && cols.includes('refund_amount'),
    'deriveColumnsFromExpression: pulls out the column identifiers');
  ok(!cols.includes('sum'),
    'deriveColumnsFromExpression: drops aggregate/function names and keywords');
  ok(deriveColumnsFromExpression('SUM(o.amount) - SUM(o.refund_amount)').join(',') === 'amount,refund_amount',
    'deriveColumnsFromExpression: strips table qualifiers so o.amount => amount');

  // ===== registerMetric / registry accessors =====
  clearMetrics();
  const stored = registerMetric(NET_REVENUE);
  ok(stored.name === 'net_revenue' && stored.expression === 'SUM(amount) - SUM(refund_amount)',
    'registerMetric: stores exactly the name + expression it was given');
  ok(Array.isArray(stored.requiredColumns) && stored.requiredColumns.includes('refund_amount'),
    'registerMetric: derives requiredColumns from the expression when not supplied');
  ok(typeof stored.createdAt !== 'undefined' && stored.owner === 'finance',
    'registerMetric: carries owner/createdAt provenance');
  ok(getRegisteredMetrics().length === 1 && getMetric('NET_REVENUE').name === 'net_revenue',
    'registry: getRegisteredMetrics/getMetric are case-insensitive on name');

  let threw = false;
  try { registerMetric({ name: 'x' }); } catch { threw = true; }
  ok(threw, 'registerMetric: refuses a definition with no expression (never invents one)');

  // ===== checkQueryAgainstMetrics: match vs. mismatch (alias) =====
  const registry = getRegisteredMetrics();

  const matchSql = 'SELECT SUM(amount) - SUM(refund_amount) AS net_revenue FROM orders';
  ok(checkQueryAgainstMetrics(matchSql, registry).length === 0,
    'checkQueryAgainstMetrics: a query whose expression MATCHES the definition is not flagged');

  const matchQualifiedSql = 'SELECT SUM(o.amount) - SUM(o.refund_amount) AS net_revenue FROM orders o';
  ok(checkQueryAgainstMetrics(matchQualifiedSql, registry).length === 0,
    'checkQueryAgainstMetrics: table-qualified columns still count as a match (o.amount == amount)');

  const mismatchSql = 'SELECT SUM(amount) AS net_revenue FROM orders';
  const mmFlags = checkQueryAgainstMetrics(mismatchSql, registry);
  const mm = mmFlags.find(f => f.metric === 'net_revenue');
  ok(mm && mm.kind === 'metric_definition_mismatch' && mm.severity === 'warn',
    'checkQueryAgainstMetrics: SUM(amount) AS net_revenue is flagged as a metric_definition_mismatch (warn)');
  ok(mm && mm.missingColumns.includes('refund_amount'),
    'checkQueryAgainstMetrics: names the missing term (refund_amount)');
  ok(mm && mm.expected === 'SUM(amount) - SUM(refund_amount)' && mm.found === 'SUM(amount)',
    'checkQueryAgainstMetrics: reports both the registered and the computed expression');

  const quotedAliasSql = 'SELECT SUM(amount) AS "net_revenue" FROM orders';
  ok(checkQueryAgainstMetrics(quotedAliasSql, registry).some(f => f.metric === 'net_revenue'),
    'checkQueryAgainstMetrics: detects a quoted alias too');

  // ===== comment-based softer signal =====
  const commentSql = 'SELECT SUM(amount) AS total FROM orders -- net_revenue for the quarter';
  const cFlags = checkQueryAgainstMetrics(commentSql, registry);
  const c = cFlags.find(f => f.metric === 'net_revenue');
  ok(c && c.severity === 'info' && c.found === null && c.missingColumns.includes('refund_amount'),
    'checkQueryAgainstMetrics: a comment naming the metric while a required term is absent is an info-level flag');

  const commentButCorrectSql = 'SELECT SUM(amount) - SUM(refund_amount) AS r FROM orders -- net_revenue';
  ok(!checkQueryAgainstMetrics(commentButCorrectSql, registry).some(f => f.metric === 'net_revenue'),
    'checkQueryAgainstMetrics: a comment naming the metric is NOT flagged when the canonical expression is present (no crying wolf)');

  const unrelatedSql = 'SELECT COUNT(*) FROM orders';
  ok(checkQueryAgainstMetrics(unrelatedSql, registry).length === 0,
    'checkQueryAgainstMetrics: a query that never claims the metric produces no flags');

  // ===== empty-registry passthrough =====
  ok(checkQueryAgainstMetrics(mismatchSql, []).length === 0,
    'checkQueryAgainstMetrics: an empty registry produces no flags (flag-off passthrough)');

  // ===== runAnalysisContract wiring =====
  // (a) Flag-OFF passthrough: no metrics option => the metric check never runs,
  //     so a mismatching alias produces NO metric_definition_mismatch flag and
  //     the report is exactly the pre-existing three finding classes.
  const offReport = runAnalysisContract(mismatchSql, schema);
  ok(!offReport.flags.some(f => f.kind === 'metric_definition_mismatch'),
    'runAnalysisContract: with NO metrics option, the metric check does not run (byte-for-byte the original 3 classes)');

  const offReportEmpty = runAnalysisContract(mismatchSql, schema, { metrics: [] });
  ok(!offReportEmpty.flags.some(f => f.kind === 'metric_definition_mismatch'),
    'runAnalysisContract: an empty metrics array is treated the same as flag-off — no metric flags');

  // (b) Flag-ON: passing the registry adds the 4th finding class alongside the
  //     others without disturbing them.
  const onReport = runAnalysisContract(mismatchSql, schema, { metrics: registry });
  ok(onReport.flags.some(f => f.kind === 'metric_definition_mismatch'),
    'runAnalysisContract: passing a metric registry surfaces the 4th finding class (metric_definition_mismatch)');
  ok(onReport.status === 'warn',
    'runAnalysisContract: a metric mismatch (warn) with no fail-level flags reports status=warn');

  // (c) A correct query with metrics supplied still passes clean.
  const cleanOn = runAnalysisContract(
    'SELECT SUM(amount) - SUM(refund_amount) AS net_revenue FROM orders WHERE is_test_account = false',
    schema,
    { metrics: registry }
  );
  ok(!cleanOn.flags.some(f => f.kind === 'metric_definition_mismatch'),
    'runAnalysisContract: a query matching the definition adds no metric flag even with the registry supplied');

  // ===== unregister / clear =====
  ok(unregisterMetric('net_revenue') && getRegisteredMetrics().length === 0,
    'unregisterMetric: removes a metric by (case-insensitive) name');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
