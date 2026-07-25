// ============================================================
// DATAGLOW - Tests: Metric Contract Status (Bundle 4, A11)
// ============================================================
// The audit behind this module found that js/gate/readiness-gate.js has always
// accepted a metricContractStatus argument and nothing ever produced one. These
// tests pin the produced object against BOTH real consumers: the readiness gate
// (which must now actually block on drift) and js/gate/publish-safe.js (which
// must report it as a caution). A status object that no consumer reads the same
// way would be worse than none.

import assert from 'node:assert/strict';
import {
  METRIC_CONTRACT_STATUS_KIND,
  METRIC_CONTRACT_STATUS_VERSION,
  computeMetricContractStatus,
  summarizeMetricContractStatus,
  describeMetricContractStatus,
  DataGlowMetricContractStatus,
} from '../js/metrics/metric-contract-status.js';
import { MetricContractRegistry } from '../js/metrics/metric-contracts.js';
import { MetricRegistry } from '../js/metrics/metric-studio.js';
import { computeReadinessGate } from '../js/gate/readiness-gate.js';
import { evaluatePublishSafe } from '../js/gate/publish-safe.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message}`);
  }
}

const EM_DASH = '—';
const PASSING_LAYERS = [
  { layer: 'types', status: 'pass' },
  { layer: 'missingness', status: 'pass' },
  { layer: 'ranges', status: 'pass' },
];

function metric(over = {}) {
  return {
    id: 'net-revenue',
    name: 'Net revenue',
    plainEnglish: 'Money kept after refunds',
    expression: 'SUM(amount) - SUM(refund)',
    owner: 'finance',
    tag: 'revenue',
    ...over,
  };
}

/** A registry whose recorded latest version matches the metric handed in. */
function recordedFor(m, meta = {}) {
  const reg = new MetricContractRegistry();
  reg.recordVersion(m.id, m, { changedBy: 'ana', reason: 'first agreed definition', ...meta });
  return reg;
}

// ---- shape ----

await test('the status names itself and its version', () => {
  const s = computeMetricContractStatus([], new MetricContractRegistry());
  assert.equal(s.kind, METRIC_CONTRACT_STATUS_KIND);
  assert.equal(s.version, METRIC_CONTRACT_STATUS_VERSION);
  assert.equal(METRIC_CONTRACT_STATUS_VERSION, 1);
});

await test('a metric that still matches its recorded version is not broken', () => {
  const m = metric();
  const s = computeMetricContractStatus([m], recordedFor(m));
  assert.equal(s.ok, true);
  assert.equal(s.broken, false);
  assert.equal(s.contracted, 1);
  assert.equal(s.untracked, 0);
  assert.deepEqual(s.brokenMetrics, []);
});

await test('a live definition that drifted from its recorded version is broken', () => {
  const m = metric();
  const reg = recordedFor(m);
  const drifted = { ...m, expression: 'SUM(amount)' };
  const s = computeMetricContractStatus([drifted], reg);
  assert.equal(s.ok, false);
  assert.equal(s.broken, true);
  assert.equal(s.brokenMetrics.length, 1);
  assert.equal(s.brokenMetrics[0].metricId, 'net-revenue');
  assert.equal(s.brokenMetrics[0].name, 'Net revenue');
  assert.equal(s.brokenMetrics[0].recordedVersion, 1);
  assert.equal(s.brokenMetrics[0].summary, 'expression changed');
  assert.deepEqual(s.brokenMetrics[0].fields, [
    { field: 'expression', before: 'SUM(amount) - SUM(refund)', after: 'SUM(amount)' },
  ]);
});

await test('drift is measured against the newest recorded version, not the first', () => {
  const m = metric();
  const reg = recordedFor(m);
  const v2 = { ...m, expression: 'SUM(amount)' };
  reg.recordVersion(m.id, v2, { changedBy: 'ana', reason: 'gross for now' });
  // The live definition equals version 2, so nothing has drifted, even though
  // it differs from version 1.
  const s = computeMetricContractStatus([v2], reg);
  assert.equal(s.broken, false);
  assert.equal(s.brokenMetrics.length, 0);
});

await test('several fields changing are all reported, not just the first', () => {
  const m = metric();
  const reg = recordedFor(m);
  const s = computeMetricContractStatus([{ ...m, name: 'Revenue', owner: 'sales' }], reg);
  assert.equal(s.brokenMetrics[0].summary, 'name, owner changed');
  assert.equal(s.brokenMetrics[0].fields.length, 2);
});

await test('a metric with no recorded history is untracked, not broken', () => {
  const s = computeMetricContractStatus([metric()], new MetricContractRegistry());
  assert.equal(s.ok, true);
  assert.equal(s.broken, false);
  assert.equal(s.contracted, 0);
  assert.equal(s.untracked, 1);
  assert.equal(s.checked, 1);
});

await test('asking about a metric does not create a history for it', () => {
  const reg = new MetricContractRegistry();
  computeMetricContractStatus([metric()], reg);
  assert.equal(reg.size, 0, 'a read must not write');
  assert.equal(reg.has('net-revenue'), false);
});

await test('tracked and untracked metrics are counted separately', () => {
  const tracked = metric();
  const other = metric({ id: 'churn', name: 'Churn' });
  const s = computeMetricContractStatus([tracked, other], recordedFor(tracked));
  assert.equal(s.checked, 2);
  assert.equal(s.contracted, 1);
  assert.equal(s.untracked, 1);
  assert.equal(s.broken, false);
});

await test('only the drifted metric is named when others are fine', () => {
  const a = metric();
  const b = metric({ id: 'churn', name: 'Churn', expression: 'COUNT(lost)' });
  const reg = recordedFor(a);
  reg.recordVersion(b.id, b, { changedBy: 'ana' });
  const s = computeMetricContractStatus([a, { ...b, expression: 'COUNT(*)' }], reg);
  assert.equal(s.brokenMetrics.length, 1);
  assert.equal(s.brokenMetrics[0].name, 'Churn');
});

// ---- it reads what the real registries produce ----

await test('a real MetricRegistry is accepted, not only a plain array', () => {
  const metrics = new MetricRegistry();
  const stored = metrics.add(metric());
  const reg = new MetricContractRegistry();
  reg.recordVersion(stored.id, stored, { changedBy: 'ana' });
  const clean = computeMetricContractStatus(metrics, reg);
  assert.equal(clean.contracted, 1);
  assert.equal(clean.broken, false);
});

await test('an in-place MetricRegistry update is caught as drift', () => {
  const metrics = new MetricRegistry();
  const stored = metrics.add(metric());
  const reg = new MetricContractRegistry();
  reg.recordVersion(stored.id, stored, { changedBy: 'ana' });
  // This is the exact failure metric-contracts.js was written to expose:
  // MetricRegistry.update() replaces the definition in place.
  metrics.update(stored.id, { expression: 'SUM(amount)' });
  const s = computeMetricContractStatus(metrics, reg);
  assert.equal(s.broken, true, 'an unrecorded in-place edit must show as drift');
  assert.equal(s.brokenMetrics[0].summary, 'expression changed');
});

// ---- never throws ----

await test('computeMetricContractStatus never throws on junk', () => {
  for (const badMetrics of [null, undefined, 42, 'metrics', {}]) {
    for (const badRegistry of [null, undefined, 42, {}]) {
      const s = computeMetricContractStatus(badMetrics, badRegistry);
      assert.equal(s.ok, true);
      assert.equal(typeof s.summary, 'string');
    }
  }
});

await test('a registry whose history throws is treated as no history, not a crash', () => {
  const hostile = {
    has: () => true,
    historyFor: () => { throw new Error('boom'); },
  };
  const s = computeMetricContractStatus([metric()], hostile);
  assert.equal(s.ok, true);
  assert.equal(s.contracted, 0);
});

// ---- the readiness gate consumer ----

await test('the readiness gate now actually blocks on a broken contract', () => {
  const m = metric();
  const status = computeMetricContractStatus([{ ...m, expression: 'SUM(amount)' }], recordedFor(m));
  const gate = computeReadinessGate(PASSING_LAYERS, status);
  assert.equal(status.ok, false);
  assert.equal(gate.blockedByContract, true);
  assert.equal(gate.agentConsumable, false, 'clean layers must not pass while a definition has drifted');
});

await test('a clean contract status does not block a passing gate', () => {
  const m = metric();
  const status = computeMetricContractStatus([m], recordedFor(m));
  const gate = computeReadinessGate(PASSING_LAYERS, status);
  assert.equal(gate.blockedByContract, false);
  assert.equal(gate.agentConsumable, true);
});

await test('untracked metrics do not block the gate either', () => {
  const status = computeMetricContractStatus([metric()], new MetricContractRegistry());
  const gate = computeReadinessGate(PASSING_LAYERS, status);
  assert.equal(gate.blockedByContract, false);
  assert.equal(gate.agentConsumable, true);
});

// ---- the Publish-Safe consumer ----

await test('Publish-Safe reads the same status as a caution and names the metric', () => {
  const m = metric();
  const status = computeMetricContractStatus([{ ...m, expression: 'SUM(amount)' }], recordedFor(m));
  const v = evaluatePublishSafe({
    destination: 'this-device',
    phi: { available: true, sensitiveFound: false, count: 0, patterns: [] },
    readiness: { agentConsumable: true, score: 90, threshold: 70, failingLayers: [] },
    metricContract: status,
  });
  assert.equal(v.checked.metricContract, 'broken');
  assert.equal(v.level, 'caution');
  assert.match(v.lines.join(' '), /Net revenue/);
});

await test('Publish-Safe reports a healthy status as a passing check', () => {
  const m = metric();
  const status = computeMetricContractStatus([m], recordedFor(m));
  const v = evaluatePublishSafe({
    destination: 'this-device',
    phi: { available: true, sensitiveFound: false, count: 0, patterns: [] },
    readiness: { agentConsumable: true, score: 90, threshold: 70, failingLayers: [] },
    metricContract: status,
  });
  assert.equal(v.checked.metricContract, 'ok');
  assert.equal(v.level, 'clear');
});

// ---- human-readable output ----

await test('the summary of a healthy status says what it compared', () => {
  const m = metric();
  const s = computeMetricContractStatus([m], recordedFor(m));
  assert.match(s.summary, /All 1 metric definition with a recorded history still match/);
});

await test('the summary of a healthy status mentions untracked metrics honestly', () => {
  const a = metric();
  const s = computeMetricContractStatus([a, metric({ id: 'churn', name: 'Churn' })], recordedFor(a));
  assert.match(s.summary, /1 other metric has no recorded history yet/);
});

await test('the summary of a broken status blames the missing record, not the person', () => {
  const m = metric();
  const s = computeMetricContractStatus([{ ...m, expression: 'SUM(amount)' }], recordedFor(m));
  assert.match(s.summary, /no longer match the version that was agreed/);
  assert.match(s.summary, /Net revenue/);
  assert.match(s.summary, /without recording it/);
});

await test('a status with no recorded histories says there is nothing to compare against', () => {
  const s = computeMetricContractStatus([metric()], new MetricContractRegistry());
  assert.match(s.summary, /No metric has a recorded definition history yet/);
  assert.match(s.summary, /the one metric/);
});

await test('an empty project says there are no metrics rather than implying a pass', () => {
  const s = computeMetricContractStatus([], new MetricContractRegistry());
  assert.match(s.summary, /no metrics to check/);
});

await test('describeMetricContractStatus shows the before and after of each field', () => {
  const m = metric();
  const s = computeMetricContractStatus([{ ...m, expression: 'SUM(amount)' }], recordedFor(m));
  const text = describeMetricContractStatus(s);
  assert.match(text, /Net revenue: expression changed since version 1\./);
  assert.match(text, /expression was "SUM\(amount\) - SUM\(refund\)" and is now "SUM\(amount\)"\./);
});

await test('the describers never throw on junk', () => {
  assert.match(summarizeMetricContractStatus(null), /were not checked/);
  assert.match(describeMetricContractStatus('status'), /were not checked/);
});

// ---- no em dashes ----

await test('no status string contains an em dash', () => {
  const m = metric();
  const cases = [
    computeMetricContractStatus([], new MetricContractRegistry()),
    computeMetricContractStatus([m], new MetricContractRegistry()),
    computeMetricContractStatus([m], recordedFor(m)),
    computeMetricContractStatus([{ ...m, name: 'Revenue', expression: 'SUM(amount)' }], recordedFor(m)),
    computeMetricContractStatus([m, metric({ id: 'churn', name: 'Churn' })], recordedFor(m)),
  ];
  for (const s of cases) {
    for (const str of [s.summary, summarizeMetricContractStatus(s), describeMetricContractStatus(s)]) {
      assert.ok(!String(str).includes(EM_DASH), `em dash found in: ${String(str).slice(0, 100)}`);
    }
  }
});

await test('the namespace publishes what a surface needs', () => {
  for (const key of ['computeMetricContractStatus', 'summarizeMetricContractStatus', 'describeMetricContractStatus']) {
    assert.ok(key in DataGlowMetricContractStatus, `${key} missing`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
