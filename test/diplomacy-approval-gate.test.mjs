// Data Diplomacy, Batch 1 — two-key approval gate. Pure-logic tests only (no
// DOM/browser). The two-key rule is the safety-critical invariant and is proven
// exhaustively below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealClaim } from '../js/diplomacy/diplomacy-claim.js';
import { reconcileClaims } from '../js/diplomacy/reconciliation-engine.js';
import {
  createApprovalRequest,
  approve,
  reject,
  verifyApprovalRecord,
} from '../js/diplomacy/diplomacy-approval-gate.js';

async function resolvedVerdict() {
  const a = await sealClaim({ entityId: 'cust-42', field: 'region', value: 'West', confidence: 0.9, source: 'riverside-crm' });
  const b = await sealClaim({ entityId: 'cust-42', field: 'region', value: 'Pacific', confidence: 0.6, source: 'lakeside-erp' });
  return reconcileClaims(a, b);
}

function newRequest(reconciliationResult) {
  return createApprovalRequest({ reconciliationResult, partyAId: 'party-a', partyBId: 'party-b' });
}

test('createApprovalRequest: inert pending request with both approvals false', async () => {
  const req = newRequest(await resolvedVerdict());
  assert.equal(req.status, 'pending');
  assert.deepEqual(req.approvals, { 'party-a': false, 'party-b': false });
  assert.equal(req.sealedRecord, null);
  assert.equal(req.decidedAt, null);
});

test('createApprovalRequest: throws on missing or identical party ids', () => {
  assert.throws(() => createApprovalRequest({ partyBId: 'b' }), /partyAId/);
  assert.throws(() => createApprovalRequest({ partyAId: 'a' }), /partyBId/);
  assert.throws(() => createApprovalRequest({ partyAId: 'x', partyBId: 'x' }), /different/);
});

// ---------- THE TWO-KEY RULE (mandatory) ----------

test('two-key: a SINGLE party approving NEVER applies the request', async () => {
  const req = newRequest(await resolvedVerdict());
  const res = await approve(req, 'party-a');
  assert.equal(res.ok, true);
  assert.equal(res.bothApproved, false);
  assert.equal(req.status, 'pending');       // still pending!
  assert.equal(req.sealedRecord, null);       // nothing sealed
  assert.equal(req.approvals['party-a'], true);
  assert.equal(req.approvals['party-b'], false);
});

test('two-key: BOTH parties approving (A then B) applies and seals', async () => {
  const req = newRequest(await resolvedVerdict());
  await approve(req, 'party-a');
  const res = await approve(req, 'party-b');
  assert.equal(res.bothApproved, true);
  assert.equal(req.status, 'applied');
  assert.ok(req.sealedRecord);
  assert.equal((await verifyApprovalRecord(req.sealedRecord)).valid, true);
});

test('two-key: order does not matter (B then A also applies)', async () => {
  const req = newRequest(await resolvedVerdict());
  await approve(req, 'party-b');
  assert.equal(req.status, 'pending');
  const res = await approve(req, 'party-a');
  assert.equal(res.bothApproved, true);
  assert.equal(req.status, 'applied');
});

test('idempotent: the same party approving twice does NOT satisfy the second key', async () => {
  const req = newRequest(await resolvedVerdict());
  await approve(req, 'party-a');
  const again = await approve(req, 'party-a');
  assert.equal(again.bothApproved, false);
  assert.equal(req.status, 'pending');       // double-approve by one party is a no-op
});

test('idempotent: approving an already-applied request never double-seals', async () => {
  const req = newRequest(await resolvedVerdict());
  await approve(req, 'party-a');
  await approve(req, 'party-b');
  const sealed = req.sealedRecord;
  const res = await approve(req, 'party-a');
  assert.equal(res.ok, true);
  assert.equal(res.bothApproved, true);
  assert.equal(req.sealedRecord, sealed);    // same record object, not resealed
});

test('approve: rejects an unknown party cleanly', async () => {
  const req = newRequest(await resolvedVerdict());
  const res = await approve(req, 'party-c');
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown party/);
  assert.equal(req.status, 'pending');
});

// ---------- reject blocks further approval ----------

test('reject: either party can reject; further approve() then fails cleanly', async () => {
  const req = newRequest(await resolvedVerdict());
  await approve(req, 'party-a');
  const rej = reject(req, 'party-b', 'I dispute the confidence scores');
  assert.equal(rej.ok, true);
  assert.equal(req.status, 'rejected');
  assert.deepEqual(req.rejection, { by: 'party-b', note: 'I dispute the confidence scores' });

  const res = await approve(req, 'party-a');
  assert.equal(res.ok, false);
  assert.match(res.error, /rejected/);
  assert.equal(req.sealedRecord, null);
});

test('reject: cannot reject an already-applied request', async () => {
  const req = newRequest(await resolvedVerdict());
  await approve(req, 'party-a');
  await approve(req, 'party-b');
  const rej = reject(req, 'party-a');
  assert.equal(rej.ok, false);
  assert.match(rej.error, /already applied/);
  assert.equal(req.status, 'applied');
});

test('reject: idempotent no-op on an already-rejected request', async () => {
  const req = newRequest(await resolvedVerdict());
  reject(req, 'party-a');
  const again = reject(req, 'party-b');
  assert.equal(again.ok, true);
  assert.equal(req.status, 'rejected');
});

// ---------- the sealed record is genuinely tamper-evident ----------

test('sealedRecord: verifies clean, fails when a sealed field is mutated', async () => {
  const req = newRequest(await resolvedVerdict());
  await approve(req, 'party-a');
  await approve(req, 'party-b');
  const rec = req.sealedRecord;
  assert.equal((await verifyApprovalRecord(rec)).valid, true);

  // Tamper with a recorded approval.
  const tampered = { ...rec, approvals: { 'party-a': true, 'party-b': false } };
  assert.equal((await verifyApprovalRecord(tampered)).valid, false);

  // Tamper with the recorded winning verdict.
  const tampered2 = { ...rec, reconciliation: { ...rec.reconciliation, winningSource: 'lakeside-erp' } };
  assert.equal((await verifyApprovalRecord(tampered2)).valid, false);

  // Non-records are rejected honestly.
  assert.equal((await verifyApprovalRecord(null)).valid, false);
  assert.equal((await verifyApprovalRecord({})).valid, false);
});
