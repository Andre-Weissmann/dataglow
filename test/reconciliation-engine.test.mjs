// Data Diplomacy, Batch 1 — reconciliation engine. Pure-logic tests only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealClaim } from '../js/diplomacy/diplomacy-claim.js';
import { reconcileClaims, explainReconciliation, DEFAULT_TIE_THRESHOLD } from '../js/diplomacy/reconciliation-engine.js';

const claim = (over = {}) => sealClaim({
  entityId: 'cust-42', field: 'region', value: 'West', source: 'src', ...over,
});

test('higher confidence wins, and the rationale cites the real numbers', async () => {
  const a = await claim({ value: 'West', confidence: 0.9, source: 'riverside-crm' });
  const b = await claim({ value: 'Pacific', confidence: 0.6, source: 'lakeside-erp' });
  const res = reconcileClaims(a, b);
  assert.equal(res.resolved, true);
  assert.equal(res.reason, 'resolved by confidence');
  assert.equal(res.winningClaim.source, 'riverside-crm');
  assert.equal(res.losingClaim.source, 'lakeside-erp');
  assert.ok(Math.abs(res.marginOfConfidence - 0.3) < 1e-9);
  // rationale cites the actual confidence values, never invented ones.
  assert.match(res.rationale, /0\.9/);
  assert.match(res.rationale, /0\.6/);
});

test('confidences within the tie threshold → honest refusal (no source ranking)', async () => {
  const a = await claim({ confidence: 0.80, source: 'riverside-crm' });
  const b = await claim({ confidence: 0.83, source: 'lakeside-erp' }); // diff 0.03 < 0.05
  const res = reconcileClaims(a, b);
  assert.equal(res.resolved, false);
  assert.match(res.reason, /insufficient signal/);
  assert.equal(res.winningClaim, null);
  assert.equal(res.marginOfConfidence, null);
});

test('tie broken by a caller-supplied source-trust ranking (array form)', async () => {
  const a = await claim({ confidence: 0.80, source: 'riverside-crm' });
  const b = await claim({ confidence: 0.82, source: 'lakeside-erp' });
  const res = reconcileClaims(a, b, { sourceTrust: ['lakeside-erp', 'riverside-crm'] });
  assert.equal(res.resolved, true);
  assert.equal(res.reason, 'resolved by source trust');
  assert.equal(res.winningClaim.source, 'lakeside-erp');
  assert.equal(res.marginOfConfidence, null);
  assert.match(res.rationale, /source trust/);
});

test('missing confidence falls straight to source trust (map form)', async () => {
  const a = await claim({ source: 'riverside-crm' }); // no confidence
  const b = await claim({ confidence: 0.9, source: 'lakeside-erp' });
  const res = reconcileClaims(a, b, { sourceTrust: { 'riverside-crm': 10, 'lakeside-erp': 3 } });
  assert.equal(res.resolved, true);
  assert.equal(res.reason, 'resolved by source trust');
  assert.equal(res.winningClaim.source, 'riverside-crm');
});

test('missing confidence and no source ranking → honest refusal', async () => {
  const a = await claim({ source: 'riverside-crm' });
  const b = await claim({ source: 'lakeside-erp' });
  const res = reconcileClaims(a, b);
  assert.equal(res.resolved, false);
  assert.match(res.reason, /insufficient signal/);
});

test('entity/field mismatch → honest refusal, never a guess', async () => {
  const a = await sealClaim({ entityId: 'cust-1', field: 'region', value: 'West', confidence: 0.9, source: 's1' });
  const b = await sealClaim({ entityId: 'cust-2', field: 'region', value: 'East', confidence: 0.1, source: 's2' });
  const res = reconcileClaims(a, b);
  assert.equal(res.resolved, false);
  assert.equal(res.reason, 'entity/field mismatch');
  assert.equal(res.winningClaim, null);

  const c = await sealClaim({ entityId: 'cust-1', field: 'tier', value: 'gold', confidence: 0.1, source: 's3' });
  const res2 = reconcileClaims(a, c);
  assert.equal(res2.resolved, false);
  assert.equal(res2.reason, 'entity/field mismatch');
});

test('custom tieThreshold widens what counts as a tie', async () => {
  const a = await claim({ confidence: 0.7, source: 's1' });
  const b = await claim({ confidence: 0.6, source: 's2' }); // diff 0.1
  assert.equal(reconcileClaims(a, b).resolved, true);            // default 0.05 → decided
  assert.equal(reconcileClaims(a, b, { tieThreshold: 0.2 }).resolved, false); // now a tie → refuse
});

test('PURE: never throws on garbage or empty input, always well-formed', () => {
  for (const [x, y] of [[null, null], [undefined, {}], [{}, {}], [42, 'nope'], [{ entityId: 'e' }, { field: 'f' }]]) {
    const res = reconcileClaims(x, y);
    assert.equal(res.resolved, false);
    assert.equal(typeof res.reason, 'string');
    assert.equal(typeof res.rationale, 'string');
    assert.equal(res.winningClaim, null);
    assert.equal(res.marginOfConfidence, null);
  }
});

test('explainReconciliation: readable resolved + unresolved summaries', async () => {
  const a = await claim({ value: 'West', confidence: 0.9, source: 'riverside-crm' });
  const b = await claim({ value: 'Pacific', confidence: 0.6, source: 'lakeside-erp' });
  const resolved = explainReconciliation(reconcileClaims(a, b));
  assert.match(resolved, /^RESOLVED/);
  assert.match(resolved, /riverside-crm/);

  const c = await claim({ confidence: 0.88, source: 'lakeside-erp' }); // margin 0.02 < 0.05 → tie
  const unresolved = explainReconciliation(reconcileClaims(a, c));
  assert.match(unresolved, /^UNRESOLVED/);
  assert.equal(explainReconciliation(null), 'No reconciliation result to explain.');
});

test('DEFAULT_TIE_THRESHOLD is exported and is 0.05', () => {
  assert.equal(DEFAULT_TIE_THRESHOLD, 0.05);
});
