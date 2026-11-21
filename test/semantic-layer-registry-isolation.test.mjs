// Tests that createSemanticRegistry() instances are isolated from each other
// and from the module-level default registry (Roadmap Step 10a, 2026-11-21).
import assert from 'node:assert/strict';
import {
  createSemanticRegistry, registerMetric, getRegisteredMetrics, getMetric,
  unregisterMetric, clearMetrics, checkQueryAgainstMetrics,
} from '../js/validation/semantic-layer.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}\n    ${e.message}`); }
}

const NET = { name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' };
const BAD_SQL = 'SELECT SUM(amount) AS net_revenue FROM orders';

clearMetrics();

test('factory exposes the six-method API', () => {
  const r = createSemanticRegistry();
  for (const k of ['registerMetric', 'getRegisteredMetrics', 'getMetric', 'unregisterMetric', 'clearMetrics', 'checkQueryAgainstMetrics']) {
    assert.equal(typeof r[k], 'function', k);
  }
});

test('registrations do not leak between instances or into the default registry', () => {
  const a = createSemanticRegistry(), b = createSemanticRegistry();
  a.registerMetric(NET);
  assert.equal(a.getRegisteredMetrics().length, 1);
  assert.equal(b.getRegisteredMetrics().length, 0);
  assert.equal(getRegisteredMetrics().length, 0);
  assert.equal(b.getMetric('net_revenue'), null);
  assert.equal(getMetric('net_revenue'), null);
});

test('default-registry registrations do not leak into instances', () => {
  const a = createSemanticRegistry();
  registerMetric({ name: 'los_days', expression: 'AVG(los)' });
  assert.equal(a.getRegisteredMetrics().length, 0);
  assert.equal(getRegisteredMetrics().length, 1);
  clearMetrics();
});

test('overwrites are per-instance', () => {
  const a = createSemanticRegistry(), b = createSemanticRegistry();
  a.registerMetric(NET); b.registerMetric(NET);
  a.registerMetric({ name: 'NET_REVENUE', expression: 'SUM(gross)' });
  assert.equal(a.getMetric('net_revenue').expression, 'SUM(gross)');
  assert.equal(b.getMetric('net_revenue').expression, NET.expression);
});

test('clearMetrics / unregisterMetric on one instance leave others intact', () => {
  const a = createSemanticRegistry(), b = createSemanticRegistry();
  a.registerMetric(NET); b.registerMetric(NET);
  registerMetric(NET);
  assert.equal(a.unregisterMetric('Net_Revenue'), true);
  assert.equal(b.getRegisteredMetrics().length, 1);
  b.clearMetrics();
  assert.equal(getRegisteredMetrics().length, 1, 'default untouched by instance clear');
  clearMetrics();
  a.registerMetric(NET);
  assert.equal(a.getRegisteredMetrics().length, 1, 'default clear does not touch instance');
});

test('checkQueryAgainstMetrics verdicts are isolated (default metrics source)', () => {
  const a = createSemanticRegistry(), b = createSemanticRegistry();
  a.registerMetric(NET);
  assert.equal(a.checkQueryAgainstMetrics(BAD_SQL).length, 1);
  assert.equal(a.checkQueryAgainstMetrics(BAD_SQL)[0].metric, 'net_revenue');
  assert.equal(b.checkQueryAgainstMetrics(BAD_SQL).length, 0);
  assert.equal(checkQueryAgainstMetrics(BAD_SQL).length, 0);
});

test('same metric name, different definitions -> different verdicts per session', () => {
  const a = createSemanticRegistry(), b = createSemanticRegistry();
  a.registerMetric({ name: 'net_revenue', expression: 'SUM(amount)' });
  b.registerMetric(NET);
  assert.equal(a.checkQueryAgainstMetrics(BAD_SQL).length, 0);
  assert.equal(b.checkQueryAgainstMetrics(BAD_SQL).length, 1);
});

test('explicit metrics argument still overrides the instance registry', () => {
  const a = createSemanticRegistry();
  assert.equal(a.checkQueryAgainstMetrics(BAD_SQL, [NET]).length, 1);
});

test('returned definitions are copies (mutation cannot corrupt an instance)', () => {
  const a = createSemanticRegistry();
  a.registerMetric(NET);
  a.getMetric('net_revenue').expression = 'HACKED';
  a.getRegisteredMetrics()[0].expression = 'HACKED';
  assert.equal(a.getMetric('net_revenue').expression, NET.expression);
});

test('validation errors are thrown per instance without state change', () => {
  const a = createSemanticRegistry();
  assert.throws(() => a.registerMetric({ name: '', expression: 'x' }));
  assert.throws(() => a.registerMetric(null));
  assert.equal(a.getRegisteredMetrics().length, 0);
});

test('many concurrent sessions stay independent', () => {
  const sessions = Array.from({ length: 25 }, () => createSemanticRegistry());
  sessions.forEach((s, i) => s.registerMetric({ name: `m${i}`, expression: `SUM(c${i})` }));
  sessions.forEach((s, i) => {
    assert.equal(s.getRegisteredMetrics().length, 1);
    assert.equal(s.getRegisteredMetrics()[0].name, `m${i}`);
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
