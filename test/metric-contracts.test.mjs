// ============================================================
// DATAGLOW — Metric Contracts test suite (Batch 1: versioned data model)
// ============================================================
// Proves the append-only version history + diff behave as specified:
//   - recordVersion() appends, never edits/removes, an existing entry
//   - snapshots only carry contract fields (not runtime fields like
//     computedValue/status)
//   - diffVersions() reports exactly the fields that actually changed
//   - a no-op re-record (identical definition) is diffed as "no changes"
//   - the registry keys histories per metric id independently
//   - JSON export/import round-trips both the history and the registry
//
// RUN WITH: node test/metric-contracts.test.mjs (pure logic, no DuckDB needed)

import {
  MetricContractHistory, MetricContractRegistry,
  snapshotDefinition, diffVersions, summarizeDiff,
} from '../js/metrics/metric-contracts.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function main() {
  // ---------- 1. snapshotDefinition ----------
  const metric = {
    id: 'readmission-rate', name: 'Readmission Rate', plainEnglish: 'readmissions / discharges',
    expression: 'SUM(readmissions) / NULLIF(SUM(discharges), 0)', owner: 'andre', tag: 'quality',
    computedValue: 0.125, computedAt: 12345, status: 'certified',
  };
  const snap = snapshotDefinition(metric);
  ok(snap.name === 'Readmission Rate' && snap.expression.includes('NULLIF'), 'snapshot: contract fields captured');
  ok(!('computedValue' in snap) && !('status' in snap), 'snapshot: runtime fields excluded (recompute/recertify is not a definition change)');

  // ---------- 2. MetricContractHistory: append-only ----------
  const hist = new MetricContractHistory('readmission-rate');
  ok(hist.length === 0, 'history: starts empty');
  const v1 = hist.recordVersion(metric, { changedBy: 'andre', reason: 'initial definition', source: 'human' });
  ok(v1.version === 1 && v1.source === 'human', 'history: v1 recorded as human, version 1');

  const metricV2 = { ...metric, expression: 'SUM(readmissions) / NULLIF(SUM(total_discharges), 0)' };
  const v2 = hist.recordVersion(metricV2, { changedBy: 'andre', reason: 'fixed column name', source: 'human' });
  ok(v2.version === 2, 'history: v2 appended (not overwritten) after a change');
  ok(hist.length === 2, 'history: length reflects both versions');

  // Mutating a returned copy must not affect the stored history (defensive copies).
  const gotV1 = hist.get(1);
  gotV1.snapshot.name = 'TAMPERED';
  ok(hist.get(1).snapshot.name === 'Readmission Rate', 'history: get() returns a defensive copy, original untouched');

  const latest = hist.latest();
  ok(latest.version === 2, 'history: latest() returns the most recently appended version');

  // ---------- 3. diffVersions ----------
  const diff12 = diffVersions(hist.get(1).snapshot, hist.get(2).snapshot);
  ok(diff12.changed === true && diff12.fields.length === 1 && diff12.fields[0].field === 'expression',
    'diff: exactly the changed field (expression) is reported, nothing else');
  ok(diff12.fields[0].before.includes('SUM(discharges)') && diff12.fields[0].after.includes('SUM(total_discharges)'),
    'diff: before/after values are the actual old/new text');

  const diffSame = diffVersions(metric, metric);
  ok(diffSame.changed === false && diffSame.fields.length === 0, 'diff: identical definitions report no changes');

  const multiChange = diffVersions(metric, { ...metric, name: 'New Name', owner: 'someone-else' });
  ok(multiChange.changed === true && multiChange.fields.length === 2, 'diff: multiple simultaneous field changes are all reported');

  // ---------- 4. summarizeDiff ----------
  ok(summarizeDiff(diff12) === 'expression changed', 'summarize: single-field label');
  ok(summarizeDiff(diffSame) === 'no changes', 'summarize: no-op label');
  ok(summarizeDiff(multiChange) === 'name, owner changed', 'summarize: multi-field label lists all changed fields in order');

  // ---------- 5. MetricContractRegistry: per-metric isolation ----------
  const reg = new MetricContractRegistry();
  reg.recordVersion('metric-a', { name: 'A', expression: 'SUM(x)' }, { changedBy: 'andre' });
  reg.recordVersion('metric-b', { name: 'B', expression: 'SUM(y)' }, { changedBy: 'andre' });
  ok(reg.size === 2, 'registry: two independent metric histories tracked');
  ok(reg.historyFor('metric-a').length === 1 && reg.historyFor('metric-b').length === 1,
    'registry: recording one metric does not affect another');
  ok(!reg.has('metric-c'), 'registry: has() is honest about metrics with no recorded version');

  // ---------- 6. JSON round-trip ----------
  const historyJson = hist.toJSON();
  ok(historyJson.kind === 'dataglow-metric-contract-history' && historyJson.versions.length === 2,
    'history toJSON: kind tag + all versions present');
  const rebuiltHist = MetricContractHistory.fromJSON(historyJson);
  ok(rebuiltHist.length === 2 && rebuiltHist.get(2).snapshot.expression === metricV2.expression,
    'history fromJSON: round-trips version count and snapshot content');

  const registryJson = reg.toJSON();
  const rebuiltReg = MetricContractRegistry.fromJSON(registryJson);
  ok(rebuiltReg.size === 2 && rebuiltReg.historyFor('metric-a').latest().snapshot.name === 'A',
    'registry fromJSON: round-trips every metric\'s history');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
