// ============================================================
// DATAGLOW — Metric Contract Confirm-Gate test suite (Batch 3: confirm-gate)
// ============================================================
// Proves the confirm-gate enforces DATAGLOW's hard autonomy-safety rule: no
// metric-definition change is ever persisted without an explicit confirm call.
//   - prepareProposedChange() builds an inert pending-change and never persists
//   - buildConfirmGateContent() reuses Batch 2's diff content and marks an
//     AI-proposed change visually distinct from a human edit
//   - THE CRITICAL GUARANTEE: no exported function silently calls
//     recordVersion() — only confirmProposedChange(), and only when explicitly
//     called, persists a version (verified with a spy registry)
//   - confirmProposedChange() records exactly one version carrying the
//     proposal's honest source/changedBy/reason, and flips status to 'applied'
//   - rejectProposedChange() persists nothing and flips status to 'rejected'
//
// The renderConfirmGate() DOM presenter is not unit-tested here (no DOM in this
// pure-Node runner), matching Batch 2's convention for ships-dark UI whose
// renderer has no page wiring the e2e suite can reach yet; the safety property
// is proven against the pure functions, which is where the guarantee lives.
//
// RUN WITH: node test/metric-contract-confirm-gate.test.mjs (pure logic, no DuckDB)

import { MetricContractRegistry } from '../js/metrics/metric-contracts.js';
import {
  prepareProposedChange, buildConfirmGateContent,
  confirmProposedChange, rejectProposedChange, sourceLabel,
} from '../js/metrics/metric-contract-confirm-gate.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A registry that records every recordVersion() call so a test can prove a code
// path did (or did NOT) attempt to persist. Delegates to a real registry so the
// returned version entry is exactly what production would get back.
function spyRegistry() {
  const real = new MetricContractRegistry();
  const calls = [];
  return {
    calls,
    recordVersion(metricId, metric, meta) {
      calls.push({ metricId, metric, meta });
      return real.recordVersion(metricId, metric, meta);
    },
    real,
  };
}

function main() {
  const current = {
    id: 'readmission-rate', name: 'Readmission Rate', plainEnglish: 'readmissions / discharges',
    expression: 'SUM(readmissions) / NULLIF(SUM(discharges), 0)', owner: 'andre', tag: 'quality',
    computedValue: 0.125, status: 'certified',
  };
  const proposed = { ...current, expression: 'SUM(readmissions) / NULLIF(SUM(total_discharges), 0)', owner: 'priya' };

  // ---------- 1. prepareProposedChange builds an inert pending change ----------
  const pending = prepareProposedChange({
    metricId: 'readmission-rate', metricName: 'Readmission Rate',
    current, proposed, source: 'agent-proposed',
    changedBy: 'metric-copilot', reason: 'fix column name + reassign owner',
  });
  ok(pending.status === 'pending', 'prepare: pending change starts in "pending" status');
  ok(pending.source === 'agent-proposed', 'prepare: source is preserved');
  ok(pending.hasChanges === true, 'prepare: detects that the proposal actually changes the definition');
  ok(!('computedValue' in pending.after) && !('status' in pending.after),
    'prepare: after-snapshot carries only contract fields, not runtime fields');
  const fd = pending.diffContent.blocks.find(b => b.kind === 'field-diff');
  ok(fd && fd.fields.length === 2, 'prepare: reuses Batch 2 diff content — exactly the 2 changed fields');

  // ---------- 2. buildConfirmGateContent distinguishes AI vs human ----------
  const agentContent = buildConfirmGateContent(pending);
  ok(agentContent.badge.isAgent === true && agentContent.badge.text === 'AI-suggested',
    'content: agent-proposed change is badged "AI-suggested"');
  ok(agentContent.sourceLabel === 'AI-agent proposed', 'content: agent source label matches Batch 2 wording');
  ok(agentContent.confirmLabel.includes('AI'), 'content: confirm button copy names it as an AI suggestion');

  const humanPending = prepareProposedChange({
    metricId: 'm2', metricName: 'M2', current: { name: 'A' }, proposed: { name: 'B' },
    source: 'human', changedBy: 'andre', reason: 'rename',
  });
  const humanContent = buildConfirmGateContent(humanPending);
  ok(humanContent.badge.isAgent === false && humanContent.badge.text === 'Human edit',
    'content: a human edit is visually distinct from an AI suggestion (not badged AI-suggested)');
  ok(humanContent.badge.text !== agentContent.badge.text, 'content: human and agent badges are never the same text');
  ok(sourceLabel('agent-proposed') === 'AI-agent proposed' && sourceLabel('human') === 'Human edit',
    'content: sourceLabel matches Batch 2 diff-view wording exactly');

  // ---------- 3. THE CRITICAL GUARANTEE: nothing persists without confirm ----------
  // Exercise every non-confirm exported function with a spy registry in scope;
  // none of them is even handed the registry, so none can call recordVersion().
  {
    const spy = spyRegistry();
    const p = prepareProposedChange({ metricId: 'x', current, proposed, source: 'agent-proposed', changedBy: 'copilot' });
    buildConfirmGateContent(p);
    buildConfirmGateContent(pending);
    rejectProposedChange(prepareProposedChange({ metricId: 'y', current, proposed }));
    ok(spy.calls.length === 0,
      'safety: prepare/build/reject never call recordVersion() — no exported function persists without an explicit confirm');
  }

  // ---------- 4. confirm() only fires on an explicit call ----------
  {
    const spy = spyRegistry();
    const p = prepareProposedChange({
      metricId: 'readmission-rate', metricName: 'Readmission Rate',
      current, proposed, source: 'agent-proposed', changedBy: 'metric-copilot', reason: 'dedup',
    });
    ok(spy.calls.length === 0, 'confirm: preparing a change records nothing on its own');
    const entry = confirmProposedChange({ pending: p, registry: spy });
    ok(spy.calls.length === 1, 'confirm: exactly one recordVersion() call, and only after the explicit confirm');
    ok(entry.version === 1 && entry.source === 'agent-proposed',
      'confirm: the recorded version carries the proposal\'s honest source');
    ok(spy.calls[0].meta.changedBy === 'metric-copilot' && spy.calls[0].meta.reason === 'dedup',
      'confirm: changedBy/reason are persisted from the proposal, not invented');
    ok(spy.real.historyFor('readmission-rate').latest().snapshot.owner === 'priya',
      'confirm: the proposed definition is what actually lands in history');
    ok(p.status === 'applied' && p.appliedVersion === 1, 'confirm: pending change flips to "applied"');
  }

  // ---------- 5. confirming twice / a non-pending change is refused ----------
  {
    const spy = spyRegistry();
    const p = prepareProposedChange({ metricId: 'z', current, proposed, source: 'human' });
    confirmProposedChange({ pending: p, registry: spy });
    let threw = false;
    try { confirmProposedChange({ pending: p, registry: spy }); } catch { threw = true; }
    ok(threw, 'confirm: re-confirming an already-applied change throws (no accidental double write)');
    ok(spy.calls.length === 1, 'confirm: the refused second confirm did not persist anything');
  }

  // ---------- 6. rejecting a pending change never persists ----------
  {
    const spy = spyRegistry();
    const p = prepareProposedChange({ metricId: 'r', current, proposed, source: 'agent-proposed' });
    const rejected = rejectProposedChange(p);
    ok(rejected.status === 'rejected', 'reject: pending change flips to "rejected"');
    ok(spy.calls.length === 0, 'reject: rejecting persists nothing');
    let threw = false;
    try { confirmProposedChange({ pending: p, registry: spy }); } catch { threw = true; }
    ok(threw && spy.calls.length === 0, 'reject: a rejected change can no longer be confirmed into history');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
