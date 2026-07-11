// Batch 3 — confirm gate. Pure-logic tests only (no DOM/browser), matching
// this repo's established convention: renderConfirmGate() has no live caller
// wired into main.js yet, so only proposeContractChange/approve/reject are
// unit-tested here; a DOM/e2e test is added once a later batch wires this
// into a real page (per metric-studio.test.mjs / trust-strip-proof-drawer's
// precedent, reaffirmed again in Batch 1 and Batch 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricContractRegistry } from '../js/metrics/metric-contracts.js';
import { proposeContractChange, buildProposalDiffContent, approve, reject } from '../js/metrics/metric-contract-confirm-gate.js';

function fakeMetricRegistry(initial) {
  const store = new Map();
  store.set(initial.id, { ...initial });
  return {
    update(id, patch) {
      const cur = store.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, id };
      store.set(id, next);
      return next;
    },
    get(id) { return store.get(id); },
  };
}

// ---------- proposeContractChange: pure data, zero side effects ----------

test('propose: creates a pending proposal, writes nothing anywhere', () => {
  const contractRegistry = new MetricContractRegistry();
  const metricRegistry = fakeMetricRegistry({ id: 'm1', name: 'Churn', expression: 'a/b', owner: 'alice', tag: 'growth', plainEnglish: 'churn rate' });

  const proposal = proposeContractChange({
    metricId: 'm1',
    currentMetric: metricRegistry.get('m1'),
    candidate: { name: 'Churn', expression: 'a/b*100', owner: 'alice', tag: 'growth', plainEnglish: 'churn rate as a percent' },
    proposedBy: 'metric-copilot',
    reason: 'Normalize to a percentage for readability.',
  });

  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.metricId, 'm1');
  assert.equal(proposal.decidedAt, null);
  // Nothing was written: history is still empty, metric is unchanged.
  assert.equal(contractRegistry.historyFor('m1').list().length, 0);
  assert.equal(metricRegistry.get('m1').expression, 'a/b');
});

test('propose: throws without a metricId or candidate — cannot construct a vague proposal', () => {
  assert.throws(() => proposeContractChange({ candidate: { name: 'x' } }));
  assert.throws(() => proposeContractChange({ metricId: 'm1' }));
});

test('propose: snapshots only contract fields from currentMetric, drops runtime fields like computedValue/status', () => {
  const proposal = proposeContractChange({
    metricId: 'm1',
    currentMetric: { name: 'Churn', expression: 'a/b', owner: 'alice', tag: 'growth', plainEnglish: 'x', computedValue: 42, status: 'active' },
    candidate: { name: 'Churn', expression: 'a/b*100', owner: 'alice', tag: 'growth', plainEnglish: 'x' },
  });
  assert.equal(proposal.before.computedValue, undefined);
  assert.equal(proposal.before.status, undefined);
});

// ---------- buildProposalDiffContent: reuses Batch 2's exact builder ----------

test('diff content: pending proposal is honestly labelled AI-agent proposed, no changedAt (nothing happened yet)', () => {
  const proposal = proposeContractChange({
    metricId: 'm1',
    currentMetric: { name: 'Churn', expression: 'a/b', owner: 'alice', tag: 'growth', plainEnglish: 'x' },
    candidate: { name: 'Churn', expression: 'a/b*100', owner: 'alice', tag: 'growth', plainEnglish: 'x' },
    proposedBy: 'metric-copilot',
    reason: 'Normalize to a percent.',
  });
  const content = buildProposalDiffContent({ metricName: 'Churn', proposal });
  const sourceBlock = content.blocks.find(b => b.label === 'Source');
  const changedAtBlock = content.blocks.find(b => b.label === 'Changed at');
  const reasonBlock = content.blocks.find(b => b.label === 'Reason given');
  const fieldDiffBlock = content.blocks.find(b => b.kind === 'field-diff');

  assert.equal(sourceBlock.value, 'AI-agent proposed');
  assert.equal(changedAtBlock, undefined); // nothing recorded yet — no fake timestamp
  assert.equal(reasonBlock.text, 'Normalize to a percent.');
  assert.ok(fieldDiffBlock);
  assert.ok(fieldDiffBlock.fields.some(f => f.field === 'expression'));
});

test('diff content: a no-op proposal (candidate identical to current) says so plainly', () => {
  const same = { name: 'Churn', expression: 'a/b', owner: 'alice', tag: 'growth', plainEnglish: 'x' };
  const proposal = proposeContractChange({ metricId: 'm1', currentMetric: same, candidate: same });
  const content = buildProposalDiffContent({ metricName: 'Churn', proposal });
  assert.equal(content.subtitle, 'no changes');
  assert.ok(content.blocks.some(b => b.text === 'No changes between these two versions.'));
});

// ---------- approve(): the only write path, and its guardrails ----------

test('approve: records an agent-proposed version AND applies it to the live metric registry', () => {
  const contractRegistry = new MetricContractRegistry();
  const metricRegistry = fakeMetricRegistry({ id: 'm1', name: 'Churn', expression: 'a/b', owner: 'alice', tag: 'growth', plainEnglish: 'churn rate' });
  const proposal = proposeContractChange({
    metricId: 'm1',
    currentMetric: metricRegistry.get('m1'),
    candidate: { name: 'Churn', expression: 'a/b*100', owner: 'alice', tag: 'growth', plainEnglish: 'churn rate as a percent' },
    proposedBy: 'metric-copilot',
    reason: 'Normalize to a percentage.',
  });

  const result = approve({ proposal, contractRegistry, metricRegistry });

  assert.equal(result.ok, true);
  assert.equal(result.version.source, 'agent-proposed');
  assert.equal(result.version.changedBy, 'metric-copilot');
  assert.equal(proposal.status, 'applied');
  assert.ok(proposal.decidedAt);

  const history = contractRegistry.historyFor('m1').list();
  assert.equal(history.length, 1);
  assert.equal(history[0].source, 'agent-proposed');
  assert.equal(metricRegistry.get('m1').expression, 'a/b*100');
});

test('approve: refuses without a contract registry — cannot silently skip recording history', () => {
  const metricRegistry = fakeMetricRegistry({ id: 'm1', name: 'x', expression: 'a', owner: 'o', tag: 't', plainEnglish: 'p' });
  const proposal = proposeContractChange({ metricId: 'm1', currentMetric: metricRegistry.get('m1'), candidate: { name: 'y', expression: 'a', owner: 'o', tag: 't', plainEnglish: 'p' } });
  const result = approve({ proposal, metricRegistry });
  assert.equal(result.ok, false);
  assert.equal(proposal.status, 'pending'); // unchanged — refusal does not silently mark it applied
});

test('approve: refuses without a metric registry — cannot apply to a metric it cannot reach', () => {
  const contractRegistry = new MetricContractRegistry();
  const proposal = proposeContractChange({ metricId: 'm1', currentMetric: { name: 'x' }, candidate: { name: 'y' } });
  const result = approve({ proposal, contractRegistry });
  assert.equal(result.ok, false);
  assert.equal(proposal.status, 'pending');
  assert.equal(contractRegistry.historyFor('m1').list().length, 0); // no partial write either
});

test('approve: idempotent — approving an already-applied proposal twice never double-appends history', () => {
  const contractRegistry = new MetricContractRegistry();
  const metricRegistry = fakeMetricRegistry({ id: 'm1', name: 'x', expression: 'a', owner: 'o', tag: 't', plainEnglish: 'p' });
  const proposal = proposeContractChange({ metricId: 'm1', currentMetric: metricRegistry.get('m1'), candidate: { name: 'y', expression: 'a', owner: 'o', tag: 't', plainEnglish: 'p' } });

  const first = approve({ proposal, contractRegistry, metricRegistry });
  const second = approve({ proposal, contractRegistry, metricRegistry });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(second.version, first.version);
  assert.equal(contractRegistry.historyFor('m1').list().length, 1); // still just one entry
});

test('approve: refuses to apply an already-rejected proposal', () => {
  const contractRegistry = new MetricContractRegistry();
  const metricRegistry = fakeMetricRegistry({ id: 'm1', name: 'x', expression: 'a', owner: 'o', tag: 't', plainEnglish: 'p' });
  const proposal = proposeContractChange({ metricId: 'm1', currentMetric: metricRegistry.get('m1'), candidate: { name: 'y', expression: 'a', owner: 'o', tag: 't', plainEnglish: 'p' } });

  reject({ proposal });
  const result = approve({ proposal, contractRegistry, metricRegistry });

  assert.equal(result.ok, false);
  assert.equal(contractRegistry.historyFor('m1').list().length, 0);
  assert.equal(metricRegistry.get('m1').name, 'x'); // untouched
});

test('approve: refuses a missing proposal object', () => {
  const result = approve({ contractRegistry: new MetricContractRegistry(), metricRegistry: fakeMetricRegistry({ id: 'm1', name: 'x' }) });
  assert.equal(result.ok, false);
});

// ---------- reject(): writes nothing, ever ----------

test('reject: pending proposal becomes rejected, writes nothing anywhere', () => {
  const contractRegistry = new MetricContractRegistry();
  const metricRegistry = fakeMetricRegistry({ id: 'm1', name: 'x', expression: 'a', owner: 'o', tag: 't', plainEnglish: 'p' });
  const proposal = proposeContractChange({ metricId: 'm1', currentMetric: metricRegistry.get('m1'), candidate: { name: 'y', expression: 'a', owner: 'o', tag: 't', plainEnglish: 'p' } });

  const result = reject({ proposal, note: 'Not needed right now.' });

  assert.equal(result.ok, true);
  assert.equal(proposal.status, 'rejected');
  assert.equal(proposal.rejectionNote, 'Not needed right now.');
  assert.equal(contractRegistry.historyFor('m1').list().length, 0);
  assert.equal(metricRegistry.get('m1').name, 'x');
});

test('reject: idempotent — rejecting twice is harmless', () => {
  const proposal = proposeContractChange({ metricId: 'm1', currentMetric: { name: 'x' }, candidate: { name: 'y' } });
  reject({ proposal });
  const second = reject({ proposal, note: 'again' });
  assert.equal(second.ok, true);
  assert.equal(proposal.status, 'rejected');
});

test('reject: refuses to retroactively reject an already-applied proposal', () => {
  const contractRegistry = new MetricContractRegistry();
  const metricRegistry = fakeMetricRegistry({ id: 'm1', name: 'x', expression: 'a', owner: 'o', tag: 't', plainEnglish: 'p' });
  const proposal = proposeContractChange({ metricId: 'm1', currentMetric: metricRegistry.get('m1'), candidate: { name: 'y', expression: 'a', owner: 'o', tag: 't', plainEnglish: 'p' } });
  approve({ proposal, contractRegistry, metricRegistry });

  const result = reject({ proposal });
  assert.equal(result.ok, false);
  assert.equal(proposal.status, 'applied'); // unchanged
});

test('reject: refuses a missing proposal object', () => {
  const result = reject({});
  assert.equal(result.ok, false);
});

// ---------- End-to-end safety scenario: the whole point of this batch ----------

test('safety scenario: an unreviewed proposal never touches the live metric or the contract history, no matter how many times its content is rendered/read', () => {
  const contractRegistry = new MetricContractRegistry();
  const metricRegistry = fakeMetricRegistry({ id: 'm1', name: 'Revenue', expression: 'sum(amount)', owner: 'bob', tag: 'finance', plainEnglish: 'total revenue' });
  const proposal = proposeContractChange({
    metricId: 'm1',
    currentMetric: metricRegistry.get('m1'),
    candidate: { name: 'Revenue', expression: 'sum(amount) - sum(refunds)', owner: 'bob', tag: 'finance', plainEnglish: 'net revenue' },
    proposedBy: 'metric-copilot',
    reason: 'Account for refunds.',
  });

  // Read/render the diff many times — reading must never be a side effect.
  for (let i = 0; i < 5; i++) buildProposalDiffContent({ metricName: 'Revenue', proposal });

  assert.equal(proposal.status, 'pending');
  assert.equal(metricRegistry.get('m1').expression, 'sum(amount)');
  assert.equal(contractRegistry.historyFor('m1').list().length, 0);
});
