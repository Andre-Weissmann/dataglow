// ============================================================
// DATAGLOW — Query Sentinel verifier test suite (Batch 1)
// ============================================================
// Pure, DB-free, browser-free logic — see js/validation/query-sentinel.js.
// Covers: FANOUT, JOIN_KEY, ADDITIVITY, SENSITIVE_COLUMN, the top-level
// report/summary, and graceful degradation when cardinality stats are
// missing or a query can't be fully parsed.
//
// RUN WITH:  node test/query-sentinel.test.mjs
// (No DuckDB needed — schema is a hand-built plain object, matching
// analysis-contract.test.mjs's own design goal.)

import {
  extractJoins,
  checkFanout,
  checkJoinKey,
  checkAdditivity,
  checkSensitiveColumn,
  runQuerySentinel,
  summarizeQuerySentinel,
} from '../js/validation/query-sentinel.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- fixture schema ----------
// orders: 10,000 rows, order_id fully unique
// line_items: 40,000 rows, order_id only 10,000 distinct (4 items/order) — a
//   classic fan-out risk when joined to orders and aggregated.
// customers: 5,000 rows, customer_id unique; gender is a protected-category
//   column per the shared isSensitiveCategory predicate (categorical-
//   consistency.js), which is what classifySensitiveColumns() delegates to.
const schema = {
  tables: {
    orders: {
      columns: [
        { name: 'order_id', type: 'BIGINT' },
        { name: 'customer_id', type: 'BIGINT' },
        { name: 'total_amount', type: 'DOUBLE' },
      ],
      rowCount: 10000,
      approxDistinct: { order_id: 10000, customer_id: 5000 },
    },
    line_items: {
      columns: [
        { name: 'line_item_id', type: 'BIGINT' },
        { name: 'order_id', type: 'BIGINT' },
        { name: 'sku', type: 'VARCHAR' },
      ],
      rowCount: 40000,
      // order_id: non-unique (fan-out risk). sku: also non-unique (200 distinct
      // SKUs across 40k rows) -- used by the ADDITIVITY test, which groups by
      // sku specifically rather than the join key itself.
      approxDistinct: { order_id: 10000, sku: 200 },
    },
    customers: {
      columns: [
        { name: 'customer_id', type: 'BIGINT' },
        { name: 'gender', type: 'VARCHAR' },
        { name: 'name', type: 'VARCHAR' },
      ],
      rowCount: 5000,
      approxDistinct: { customer_id: 5000 },
    },
  },
};

// ---------- extractJoins ----------
{
  const joins = extractJoins(
    'SELECT * FROM orders o JOIN line_items li ON o.order_id = li.order_id'
  );
  ok(joins.length === 1, 'extractJoins finds exactly one JOIN');
  ok(joins[0]?.table === 'line_items', 'extractJoins captures the joined table name');
  ok(joins[0]?.alias === 'li', 'extractJoins captures the alias');
  ok(joins[0]?.left.column === 'order_id' && joins[0]?.right.column === 'order_id', 'extractJoins captures both ON columns');
}

// ---------- checkFanout ----------
{
  // Real fan-out: SUM(total_amount) after joining orders -> line_items on
  // line_items.order_id, which is NOT unique on line_items (40k rows / 10k distinct).
  const sql = `SELECT o.customer_id, SUM(o.total_amount) AS total
               FROM orders o JOIN line_items li ON o.order_id = li.order_id
               GROUP BY o.customer_id`;
  const flags = checkFanout(sql, schema);
  ok(flags.some(f => f.kind === 'FANOUT' && f.table === 'line_items'), 'checkFanout catches a real one-to-many join before an aggregate');
  ok(flags[0]?.severity === 'fail', 'checkFanout rates a severe fan-out (10k/40k distinct ratio) as fail');
}
{
  // No aggregate in SELECT -> fan-out risk doesn't apply, must stay silent.
  const sql = `SELECT o.order_id, li.sku FROM orders o JOIN line_items li ON o.order_id = li.order_id`;
  const flags = checkFanout(sql, schema);
  ok(flags.length === 0, 'checkFanout stays silent when the query has no aggregate');
}
{
  // Join on a genuinely unique key (customers.customer_id, 5000/5000) -> no flag.
  const sql = `SELECT c.name, SUM(o.total_amount) AS total
               FROM orders o JOIN customers c ON o.customer_id = c.customer_id
               GROUP BY c.name`;
  const flags = checkFanout(sql, schema);
  ok(flags.length === 0, 'checkFanout does not flag a join on a truly unique key');
}
{
  // Missing cardinality stats -> degrades to 'info', never a false 'fail'.
  const noStatsSchema = { tables: { orders: { columns: schema.tables.orders.columns, rowCount: 10000, approxDistinct: {} },
                                     line_items: { columns: schema.tables.line_items.columns, rowCount: 40000, approxDistinct: {} } } };
  const sql = `SELECT SUM(o.total_amount) FROM orders o JOIN line_items li ON o.order_id = li.order_id`;
  const flags = checkFanout(sql, noStatsSchema);
  ok(flags.every(f => f.severity === 'info'), 'checkFanout degrades to info-only when cardinality stats are unmeasured');
}

// ---------- checkJoinKey ----------
{
  // sku (VARCHAR) joined against order_id-shaped numeric column - mismatched types.
  const sql = `SELECT * FROM orders o JOIN line_items li ON o.order_id = li.sku`;
  const flags = checkJoinKey(sql, schema);
  ok(flags.some(f => f.kind === 'JOIN_KEY'), 'checkJoinKey flags a numeric-vs-VARCHAR type mismatch on the join condition');
}
{
  const sql = `SELECT * FROM orders o JOIN line_items li ON o.order_id = li.order_id`;
  const flags = checkJoinKey(sql, schema);
  ok(flags.length === 0, 'checkJoinKey does not flag a join where both sides declare the same type');
}

// ---------- checkAdditivity ----------
{
  // Groups by line_items.sku (non-unique on line_items) while summing a
  // driving-table column -> the per-group totals won't add back up.
  const sql = `SELECT li.sku, SUM(o.total_amount) AS total
               FROM orders o JOIN line_items li ON o.order_id = li.order_id
               GROUP BY li.sku`;
  const flags = checkAdditivity(sql, schema);
  ok(flags.some(f => f.kind === 'ADDITIVITY'), 'checkAdditivity flags grouping by a non-unique joined-table column while aggregating the driving table');
}
{
  // Groups by a column with no cardinality signal available -> stays silent.
  const sql = `SELECT c.name, SUM(o.total_amount) AS total
               FROM orders o JOIN customers c ON o.customer_id = c.customer_id
               GROUP BY c.name`;
  const flags = checkAdditivity(sql, schema);
  ok(flags.length === 0, 'checkAdditivity does not flag grouping by a table that is unique on the join key');
}

// ---------- checkSensitiveColumn ----------
{
  const sql = `SELECT gender, name FROM customers WHERE gender IS NOT NULL`;
  const flags = checkSensitiveColumn(sql, schema);
  ok(flags.some(f => f.kind === 'SENSITIVE_COLUMN' && f.column.toLowerCase() === 'gender'), 'checkSensitiveColumn flags a referenced protected-category column (delegates to the shared isSensitiveCategory predicate)');
}
{
  const sql = `SELECT name FROM customers`;
  const flags = checkSensitiveColumn(sql, schema);
  ok(!flags.some(f => f.column?.toLowerCase() === 'gender'), 'checkSensitiveColumn does not flag a sensitive column the query never actually references');
}

// ---------- runQuerySentinel / summarizeQuerySentinel (top-level) ----------
{
  const sql = `SELECT o.customer_id, SUM(o.total_amount) AS total
               FROM orders o JOIN line_items li ON o.order_id = li.order_id
               GROUP BY o.customer_id`;
  const report = runQuerySentinel(sql, schema);
  ok(report.status === 'fail', 'runQuerySentinel surfaces the worst severity across all four checks as top-level status');
  ok(report.flagCount >= 1, 'runQuerySentinel flagCount matches the flags array length');
  ok(typeof report.ts === 'number', 'runQuerySentinel stamps a numeric timestamp');
  const summary = summarizeQuerySentinel(report);
  ok(summary.includes('FANOUT'), 'summarizeQuerySentinel names the offending check class in plain language');
}
{
  const sql = `SELECT c.name, SUM(o.total_amount) AS total
               FROM orders o JOIN customers c ON o.customer_id = c.customer_id
               GROUP BY c.name`;
  const report = runQuerySentinel(sql, schema);
  ok(report.status === 'pass' && report.flagCount === 0, 'runQuerySentinel reports a clean pass for a genuinely sound query');
  ok(summarizeQuerySentinel(report).toLowerCase().includes('no'), 'summarizeQuerySentinel states plainly when nothing was found');
}
{
  // A query none of the checks can parse (no FROM/JOIN at all) must never throw.
  const report = runQuerySentinel('SELECT 1', schema);
  ok(report.status === 'pass', 'runQuerySentinel degrades gracefully (no throw) on a query with nothing to check');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
