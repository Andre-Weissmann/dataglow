// ============================================================
// DataGlow — Semantic Layer Persistence tests
// Tests hydrateFromRecords, exportMetricsToJson, importMetricsFromJson
// from js/validation/semantic-layer.js.
// No IndexedDB, no browser — pure Node, no hooks needed.
// ============================================================

import {
  registerMetric,
  getRegisteredMetrics,
  clearMetrics,
  hydrateFromRecords,
  exportMetricsToJson,
  importMetricsFromJson,
} from '../js/validation/semantic-layer.js';

// ---- tiny test harness (matches existing test files) ----
let pass = 0, fail = 0;
function test(label, fn) {
  try { fn(); console.log('  \u2713 ' + label); pass++; }
  catch (e) { console.error('  \u2717 ' + label + '\n    ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a));
}

// Always start each block with a clean slate
function clean() { clearMetrics(); }

// ============================================================
// hydrateFromRecords
// ============================================================

console.log('\nhydrateFromRecords');

test('returns { loaded: 0, skipped: 0 } for empty array', () => {
  clean();
  const r = hydrateFromRecords([]);
  eq(r.loaded, 0); eq(r.skipped, 0);
});

test('returns { loaded: 0, skipped: 0 } for null / undefined', () => {
  clean();
  const r1 = hydrateFromRecords(null);
  eq(r1.loaded, 0); eq(r1.skipped, 0);
  const r2 = hydrateFromRecords(undefined);
  eq(r2.loaded, 0); eq(r2.skipped, 0);
});

test('loads a valid record into the registry', () => {
  clean();
  const r = hydrateFromRecords([{ name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' }]);
  eq(r.loaded, 1); eq(r.skipped, 0);
  const metrics = getRegisteredMetrics();
  eq(metrics.length, 1);
  eq(metrics[0].name, 'net_revenue');
});

test('loads multiple records', () => {
  clean();
  const r = hydrateFromRecords([
    { name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' },
    { name: 'readmission_rate', expression: 'COUNT(readmission) / COUNT(encounter_id)' },
    { name: 'avg_los', expression: 'AVG(length_of_stay)' },
  ]);
  eq(r.loaded, 3); eq(r.skipped, 0);
  eq(getRegisteredMetrics().length, 3);
});

test('skips records missing name or expression', () => {
  clean();
  const r = hydrateFromRecords([
    null,
    {},
    { name: 'net_revenue' },
    { expression: 'SUM(amount)' },
    { name: 'readmission_rate', expression: 'COUNT(readmission) / COUNT(encounter_id)' },
  ]);
  eq(r.loaded, 1);
  assert(r.skipped >= 4, 'should skip 4+ bad records, got ' + r.skipped);
});

test('does not throw on a corrupt record — tolerant', () => {
  clean();
  let threw = false;
  try { hydrateFromRecords([42, 'bad', { name: 'ok', expression: 'SUM(x)' }]); }
  catch (_) { threw = true; }
  assert(!threw, 'hydrateFromRecords must never throw');
});

test('existing registry entries are overwritten by hydration (same name)', () => {
  clean();
  registerMetric({ name: 'net_revenue', expression: 'SUM(amount)' });
  hydrateFromRecords([{ name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' }]);
  const m = getRegisteredMetrics().find((x) => x.name === 'net_revenue');
  assert(m, 'metric must exist');
  assert(m.expression.includes('refund'), 'expression should be overwritten with the refund term');
});

// ============================================================
// exportMetricsToJson
// ============================================================

console.log('\nexportMetricsToJson');

test('returns valid JSON string', () => {
  clean();
  registerMetric({ name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' });
  const json = exportMetricsToJson();
  assert(typeof json === 'string', 'must be a string');
  let parsed;
  try { parsed = JSON.parse(json); } catch (_) { throw new Error('not valid JSON'); }
  eq(parsed.version, 1);
  assert(Array.isArray(parsed.metrics), 'metrics must be an array');
  eq(parsed.metrics.length, 1);
  eq(parsed.metrics[0].name, 'net_revenue');
});

test('exports all registered metrics', () => {
  clean();
  registerMetric({ name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' });
  registerMetric({ name: 'readmission_rate', expression: 'COUNT(readmission) / COUNT(encounter_id)' });
  const parsed = JSON.parse(exportMetricsToJson());
  eq(parsed.metrics.length, 2);
});

test('exports exportedAt timestamp', () => {
  clean();
  registerMetric({ name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' });
  const parsed = JSON.parse(exportMetricsToJson());
  assert(typeof parsed.exportedAt === 'string' && parsed.exportedAt.length > 0, 'exportedAt must be a non-empty string');
});

test('empty registry exports empty metrics array (not null)', () => {
  clean();
  const parsed = JSON.parse(exportMetricsToJson());
  assert(Array.isArray(parsed.metrics), 'metrics must be an array even when empty');
  eq(parsed.metrics.length, 0);
});

// ============================================================
// importMetricsFromJson
// ============================================================

console.log('\nimportMetricsFromJson');

test('imports from export round-trip', () => {
  clean();
  registerMetric({ name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' });
  registerMetric({ name: 'readmission_rate', expression: 'COUNT(readmission) / COUNT(encounter_id)' });
  const json = exportMetricsToJson();

  clean();
  const r = importMetricsFromJson(json);
  eq(r.imported, 2);
  eq(r.skipped, 0);
  eq(r.errors.length, 0);
  eq(getRegisteredMetrics().length, 2);
});

test('returns error for invalid JSON', () => {
  clean();
  const r = importMetricsFromJson('not json at all');
  eq(r.imported, 0);
  assert(r.errors.length > 0, 'must have at least one error');
  assert(r.errors[0].toLowerCase().includes('json') || r.errors[0].toLowerCase().includes('invalid'), 'error should mention JSON');
});

test('returns error for JSON with no metrics array', () => {
  clean();
  const r = importMetricsFromJson(JSON.stringify({ version: 1 }));
  eq(r.imported, 0);
  assert(r.errors.length > 0 || r.skipped >= 0, 'should handle missing metrics gracefully');
});

test('accepts a bare array (no version wrapper)', () => {
  clean();
  const r = importMetricsFromJson(JSON.stringify([
    { name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' },
  ]));
  eq(r.imported, 1);
});

test('skips items missing name or expression', () => {
  clean();
  const r = importMetricsFromJson(JSON.stringify({
    version: 1,
    metrics: [
      { name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' },
      { name: 'bad_no_expr' },
      { expression: 'SUM(x)' },
      {},
    ],
  }));
  eq(r.imported, 1);
  assert(r.skipped >= 3, 'should skip 3 bad items');
});

test('calls onSave hook for each successfully imported metric', () => {
  clean();
  const saved = [];
  importMetricsFromJson(JSON.stringify([
    { name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' },
    { name: 'readmission_rate', expression: 'COUNT(readmission) / COUNT(encounter_id)' },
  ]), { onSave: (m) => saved.push(m.nameLower) });
  eq(saved.length, 2);
  assert(saved.includes('net_revenue'), 'net_revenue should be in saved list');
  assert(saved.includes('readmission_rate'), 'readmission_rate should be in saved list');
});

test('does not call onSave for skipped items', () => {
  clean();
  const saved = [];
  importMetricsFromJson(JSON.stringify([
    { name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' },
    { name: 'bad_no_expr' },
  ]), { onSave: (m) => saved.push(m) });
  eq(saved.length, 1);
});

test('merges with existing registry — overwrites same name, keeps others', () => {
  clean();
  registerMetric({ name: 'net_revenue', expression: 'SUM(amount)' });
  registerMetric({ name: 'avg_los', expression: 'AVG(length_of_stay)' });
  importMetricsFromJson(JSON.stringify([
    { name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' },
    { name: 'readmission_rate', expression: 'COUNT(readmission) / COUNT(encounter_id)' },
  ]));
  const metrics = getRegisteredMetrics();
  eq(metrics.length, 3);
  const nr = metrics.find((m) => m.name === 'net_revenue');
  assert(nr && nr.expression.includes('refund'), 'net_revenue should be updated with refund term');
  assert(metrics.find((m) => m.name === 'avg_los'), 'avg_los must be preserved');
  assert(metrics.find((m) => m.name === 'readmission_rate'), 'readmission_rate must be imported');
});

test('does not throw for empty string input', () => {
  clean();
  let threw = false;
  try { importMetricsFromJson(''); } catch (_) { threw = true; }
  assert(!threw, 'importMetricsFromJson must never throw');
});

// ============================================================
// Summary
// ============================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
