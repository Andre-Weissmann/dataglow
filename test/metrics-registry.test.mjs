// ============================================================
// DATAGLOW — Shared Metrics Registry test suite
// ============================================================
// Covers the in-session "define once" metrics registry:
//   - defineMetric validation (name shape, empty/invalid SQL expression,
//     statement rejection, unbalanced parens, unterminated string literal)
//   - duplicate-name rejection unless { overwrite: true } + version bump
//   - getMetric / hasMetric / listMetrics (sorted) / removeMetric
//   - resolveMetricSql (parenthesized fragment + aliased select form)
//   - expandMetricReferences (@name expansion, multi-ref, unknown → throw,
//     no-ref passthrough, no-registry passthrough)
//   - optional SHA-256 content fingerprint (reuses provenance sha256Hex)
//
// RUN WITH:  node test/metrics-registry.test.mjs
//
// Engine-free (no DuckDB): every unit under test is pure JS. Mirrors the
// signal-store / self-learning-rules suites.

import {
  createMetricsRegistry,
  expandMetricReferences,
  validateMetricName,
  validateSqlExpression,
  MetricError,
} from '../js/app-shell/metrics-registry.js';

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
function throws(fn, type, msg) {
  try { fn(); ok(false, msg + ' (expected throw)'); }
  catch (e) { ok(type ? e instanceof type : true, msg); }
}

async function main() {
  // ============================================================
  // 1) defineMetric happy path + metadata
  // ============================================================
  const reg = createMetricsRegistry();
  ok(reg.size === 0, 'new registry: empty');

  const m = reg.defineMetric({ name: 'revenue', sqlExpression: 'SUM(amount)', unit: 'USD', description: 'Total booked revenue' });
  ok(reg.size === 1 && m.name === 'revenue' && m.sqlExpression === 'SUM(amount)', 'defineMetric: stores name + expression');
  ok(m.unit === 'USD' && m.description === 'Total booked revenue', 'defineMetric: keeps optional unit + description');
  ok(m.version === 1 && Number.isFinite(m.definedAt), 'defineMetric: first version is 1, records definedAt');

  // optional metadata defaults to null
  const bare = reg.defineMetric({ name: 'row_count', sqlExpression: 'COUNT(*)' });
  ok(bare.unit === null && bare.description === null, 'defineMetric: unit/description default to null');

  // whitespace in name/expression is trimmed
  const trimmed = reg.defineMetric({ name: '  aov  ', sqlExpression: '  SUM(amount) / COUNT(*)  ' });
  ok(trimmed.name === 'aov' && trimmed.sqlExpression === 'SUM(amount) / COUNT(*)', 'defineMetric: trims name and expression');

  // ============================================================
  // 2) Validation: names
  // ============================================================
  throws(() => reg.defineMetric({ name: '', sqlExpression: 'COUNT(*)' }), MetricError, 'reject: empty name');
  throws(() => reg.defineMetric({ name: '1bad', sqlExpression: 'COUNT(*)' }), MetricError, 'reject: name starting with a digit');
  throws(() => reg.defineMetric({ name: 'has space', sqlExpression: 'COUNT(*)' }), MetricError, 'reject: name with a space');
  throws(() => reg.defineMetric({ name: 'drop;table', sqlExpression: 'COUNT(*)' }), MetricError, 'reject: name with punctuation');
  ok(validateMetricName('active_customer') === 'active_customer', 'validateMetricName: accepts a valid identifier');

  // ============================================================
  // 3) Validation: SQL expressions (lightweight, no second parser)
  // ============================================================
  throws(() => reg.defineMetric({ name: 'empty', sqlExpression: '   ' }), MetricError, 'reject: empty/whitespace expression');
  throws(() => reg.defineMetric({ name: 'multi', sqlExpression: 'COUNT(*); DROP TABLE t' }), MetricError, 'reject: expression containing a semicolon');
  throws(() => reg.defineMetric({ name: 'stmt', sqlExpression: 'SELECT COUNT(*) FROM t' }), MetricError, 'reject: full SELECT statement, not an expression');
  throws(() => reg.defineMetric({ name: 'ddl', sqlExpression: 'DROP TABLE t' }), MetricError, 'reject: DDL statement');
  throws(() => reg.defineMetric({ name: 'parens', sqlExpression: 'SUM(amount' }), MetricError, 'reject: unbalanced parentheses');
  throws(() => reg.defineMetric({ name: 'parens2', sqlExpression: 'amount)' }), MetricError, 'reject: closing paren with no opener');
  throws(() => reg.defineMetric({ name: 'str', sqlExpression: "status = 'active" }), MetricError, 'reject: unterminated string literal');
  throws(() => reg.defineMetric({ name: 'nonstr', sqlExpression: 123 }), MetricError, 'reject: non-string expression');
  // a legitimately quoted literal with an escaped quote is fine
  const quoted = reg.defineMetric({ name: 'active_flag', sqlExpression: "COUNT(*) FILTER (WHERE status = 'ac''tive')" });
  ok(quoted.name === 'active_flag', 'accept: expression with a valid (escaped) string literal + FILTER');
  ok(validateSqlExpression(' SUM(x) ') === 'SUM(x)', 'validateSqlExpression: returns the trimmed expression');

  // ============================================================
  // 4) Duplicate handling + overwrite + version bump
  // ============================================================
  throws(() => reg.defineMetric({ name: 'revenue', sqlExpression: 'SUM(net_amount)' }), MetricError, 'reject: duplicate name without overwrite');
  const v2 = reg.defineMetric({ name: 'revenue', sqlExpression: 'SUM(net_amount)' }, { overwrite: true });
  ok(v2.version === 2 && v2.sqlExpression === 'SUM(net_amount)', 'overwrite: redefine bumps version to 2 and updates expression');
  ok(reg.getMetric('revenue').version === 2, 'overwrite: getMetric reflects the new version');

  // ============================================================
  // 5) get / has / list / remove
  // ============================================================
  ok(reg.getMetric('nope') === null, 'getMetric: unknown name returns null');
  ok(reg.hasMetric('revenue') === true && reg.hasMetric('nope') === false, 'hasMetric: boolean membership');
  // getMetric returns a copy — mutating it must not corrupt the store
  const copy = reg.getMetric('revenue');
  copy.sqlExpression = 'HACKED';
  ok(reg.getMetric('revenue').sqlExpression === 'SUM(net_amount)', 'getMetric: returns a defensive copy');
  const names = reg.listMetrics().map(x => x.name);
  ok(names.length === 4 && names.join(',') === [...names].sort().join(','), 'listMetrics: returns all metrics sorted by name');
  ok(reg.removeMetric('row_count') === true && reg.hasMetric('row_count') === false, 'removeMetric: deletes a metric');
  ok(reg.removeMetric('row_count') === false, 'removeMetric: returns false for an already-absent metric');

  // ============================================================
  // 6) resolveMetricSql: fragment + aliased select form
  // ============================================================
  ok(reg.resolveMetricSql('revenue') === '(SUM(net_amount))', 'resolveMetricSql: parenthesized fragment');
  ok(reg.resolveMetricSql('revenue', { alias: true }) === '(SUM(net_amount)) AS "revenue"', 'resolveMetricSql: aliased select form');
  throws(() => reg.resolveMetricSql('ghost'), MetricError, 'resolveMetricSql: unknown metric throws');

  // ============================================================
  // 7) expandMetricReferences: the "a surface reads from the registry" path
  // ============================================================
  const e1 = expandMetricReferences('SELECT @revenue FROM sales', reg);
  ok(e1.sql === 'SELECT (SUM(net_amount)) FROM sales' && e1.used.join() === 'revenue',
    'expand: replaces a single @metric with its compiled fragment and reports usage');

  const e2 = expandMetricReferences('SELECT @revenue, @aov, @revenue FROM sales', reg);
  ok(e2.sql === 'SELECT (SUM(net_amount)), (SUM(amount) / COUNT(*)), (SUM(net_amount)) FROM sales',
    'expand: replaces every occurrence, including a repeated reference');
  ok(e2.used.length === 2 && e2.used.includes('revenue') && e2.used.includes('aov'),
    'expand: reports DISTINCT used metric names');

  const noRef = expandMetricReferences('SELECT * FROM sales LIMIT 10', reg);
  ok(noRef.sql === 'SELECT * FROM sales LIMIT 10' && noRef.used.length === 0,
    'expand: a query with no @refs is returned unchanged');

  // no registry is fine as long as there are no references
  const noRegNoRef = expandMetricReferences('SELECT 1', null);
  ok(noRegNoRef.sql === 'SELECT 1' && noRegNoRef.used.length === 0, 'expand: no registry + no refs → passthrough');

  throws(() => expandMetricReferences('SELECT @missing FROM t', reg), MetricError, 'expand: an unknown @metric throws MetricError');
  throws(() => expandMetricReferences('SELECT @revenue FROM t', null), MetricError, 'expand: @ref with no registry throws MetricError');

  // ============================================================
  // 8) Isolation: two registries never share state (per-dataset guarantee)
  // ============================================================
  const regA = createMetricsRegistry();
  const regB = createMetricsRegistry();
  regA.defineMetric({ name: 'revenue', sqlExpression: 'SUM(a)' });
  ok(regA.hasMetric('revenue') && !regB.hasMetric('revenue'), 'isolation: a metric in one registry is invisible in another');

  // ============================================================
  // 9) Optional content fingerprint (reuses provenance sha256Hex)
  // ============================================================
  const fp1 = await regA.fingerprint('revenue');
  ok(typeof fp1 === 'string' && /^[0-9a-f]{64}$/.test(fp1), 'fingerprint: 64-hex SHA-256 string');
  regA.defineMetric({ name: 'revenue', sqlExpression: 'SUM(a)' }, { overwrite: true });
  const fp1b = await regA.fingerprint('revenue');
  ok(fp1 === fp1b, 'fingerprint: identical definition → identical hash (content-addressed)');
  regA.defineMetric({ name: 'revenue', sqlExpression: 'SUM(b)' }, { overwrite: true });
  const fp2 = await regA.fingerprint('revenue');
  ok(fp1 !== fp2, 'fingerprint: a changed expression → a different hash');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
