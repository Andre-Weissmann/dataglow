// Data Diplomacy, Batch 2 — UI model builders. Pure-logic tests only (no DOM).
// Exercises the two DOM-free view-model builders the presenter is split around,
// mirroring how js/gate/readiness-gate-ui.js's buildReadinessBadgeModel is
// tested. The DOM painter (renderDiplomacyPanel) is deliberately left to the
// browser/e2e path — these assert the honest resolved vs. unresolved split that
// painter reads, especially that an unresolved verdict NEVER offers approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimCardModel, buildReconciliationPanelModel } from '../js/diplomacy/diplomacy-ui.js';
import { reconcileClaims } from '../js/diplomacy/reconciliation-engine.js';

// Plain claim-like objects are enough for the pure engine + card builder (they
// only read entityId/field/value/confidence/source/…); no async sealing needed.
const claim = (over = {}) => ({
  entityId: 'account-4821', field: 'q3_net_revenue', value: 128400,
  confidence: 0.9, source: 'warehouse-export', sealedBy: 'analyst',
  fingerprint: 'abcdef0123456789abcdef0123456789', ...over,
});

// ---------- buildClaimCardModel ----------

test('buildClaimCardModel: surfaces the real claim fields and a shortened fingerprint', () => {
  const m = buildClaimCardModel(claim());
  assert.equal(m.source, 'warehouse-export');
  assert.equal(m.entityId, 'account-4821');
  assert.equal(m.field, 'q3_net_revenue');
  assert.equal(m.valueText, '128400');
  assert.equal(m.hasConfidence, true);
  assert.match(m.confidenceText, /0\.9/);
  assert.equal(m.sealedBy, 'analyst');
  assert.ok(m.fingerprintShort && m.fingerprintShort.length < 'abcdef0123456789abcdef0123456789'.length);
});

test('buildClaimCardModel: a missing confidence is stated honestly, not faked as 0', () => {
  const m = buildClaimCardModel(claim({ confidence: undefined }));
  assert.equal(m.hasConfidence, false);
  assert.match(m.confidenceText, /no confidence/i);
});

test('buildClaimCardModel: a string value is passed through verbatim', () => {
  const m = buildClaimCardModel(claim({ value: 'Pacific' }));
  assert.equal(m.valueText, 'Pacific');
});

test('buildClaimCardModel: never throws on a malformed/absent claim, returns a placeholder', () => {
  for (const bad of [null, undefined, 42, 'nope', {}]) {
    const m = buildClaimCardModel(bad);
    assert.equal(typeof m.source, 'string');
    assert.equal(typeof m.valueText, 'string');
    assert.equal(m.hasConfidence, false);
  }
});

// ---------- buildReconciliationPanelModel: RESOLVED ----------

test('buildReconciliationPanelModel: a resolved verdict exposes the proposed value AND offers approval', () => {
  const a = claim({ value: 128400, confidence: 0.92, source: 'warehouse-export' });
  const b = claim({ value: 131750, confidence: 0.6, source: 'finance-spreadsheet' });
  const result = reconcileClaims(a, b);
  assert.equal(result.resolved, true); // sanity: this scenario really does resolve

  const m = buildReconciliationPanelModel(result);
  assert.equal(m.resolved, true);
  assert.equal(m.showApproval, true);
  assert.equal(m.winningSource, 'warehouse-export');
  assert.equal(m.proposedValueText, '128400');
  assert.match(m.headline, /resolved/i);
  assert.ok(m.rationale.length > 0);
  // The proposed value is the winning claim's REAL value, never invented.
  assert.equal(m.proposedValueText, '128400');
});

// ---------- buildReconciliationPanelModel: UNRESOLVED (the honesty case) ----------

test('buildReconciliationPanelModel: an unresolved verdict shows "needs human debate" and offers NO approval', () => {
  const a = claim({ value: 'West', confidence: 0.8, source: 'crm' });
  const b = claim({ value: 'Pacific', confidence: 0.82, source: 'erp' }); // margin 0.02 < tie threshold
  const result = reconcileClaims(a, b);
  assert.equal(result.resolved, false); // sanity: the engine really refused

  const m = buildReconciliationPanelModel(result);
  assert.equal(m.resolved, false);
  assert.equal(m.showApproval, false, 'an unresolved conflict must NEVER offer approval UI');
  assert.equal(m.proposedValueText, null, 'there is no proposed value when unresolved');
  assert.equal(m.winningSource, null);
  assert.match(m.headline, /human debate/i);
  assert.ok(m.rationale.length > 0);
});

test('buildReconciliationPanelModel: entity/field mismatch is unresolved with no approval', () => {
  const a = claim({ entityId: 'account-1', field: 'revenue' });
  const b = claim({ entityId: 'account-2', field: 'revenue' });
  const m = buildReconciliationPanelModel(reconcileClaims(a, b));
  assert.equal(m.resolved, false);
  assert.equal(m.showApproval, false);
});

test('buildReconciliationPanelModel: never throws on a missing/malformed result, treated as unresolved', () => {
  for (const bad of [null, undefined, 42, 'nope', {}]) {
    const m = buildReconciliationPanelModel(bad);
    assert.equal(m.resolved, false);
    assert.equal(m.showApproval, false);
    assert.equal(typeof m.rationale, 'string');
    assert.equal(typeof m.explanation, 'string');
  }
});
