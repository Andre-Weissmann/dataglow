// ============================================================
// DATAGLOW — Data Diplomacy, Batch 1: two-key approval gate
// ============================================================
// THE RULE THIS FILE EXISTS TO ENFORCE (never relaxed, never bypassed):
//
//   A reconciliation verdict (js/diplomacy/reconciliation-engine.js) between two
//   parties' claims may be PROPOSED, but it only becomes APPLIED once BOTH
//   parties have INDEPENDENTLY approved it. This is the "two-key" rule: unlike
//   the existing single-approver Metric Contract confirm gate
//   (js/metrics/metric-contract-confirm-gate.js), one party's approval is never
//   enough — the request stays 'pending' until the second, different party also
//   approves. There is no auto-approve, no timer, and no "trusted party" bypass.
//
// WHAT AN "APPROVAL REQUEST" IS: a plain, inert data object. createApprovalRequest
// does nothing but construct it — no registry write, no network, exactly as inert
// as writing the object literal by hand. It only changes state when a real party
// calls approve()/reject() on it.
//
// THE STATE MACHINE (a request's only three states):
//   pending  → the default; zero, or exactly one, party has approved so far.
//   applied  → BOTH parties approved. On this transition — and ONLY then — the
//              request is sealed into a tamper-evident `sealedRecord` (reusing
//              js/diplomacy/diplomacy-claim.js's fingerprint primitive; no new
//              crypto). A request reaches 'applied' once; re-approving is a no-op.
//   rejected → either party rejected unilaterally; nothing was sealed, and
//              further approve() calls fail cleanly.
//
// This batch is pure logic ONLY — the DOM presenter (the renderConfirmGate
// equivalent) is a later UI batch, exactly as the Metric Contract gate shipped
// its state machine before its presenter. No DOM, no engine, no network.

import { fingerprintClaimContent } from './diplomacy-claim.js';

export const APPROVAL_REQUEST_KIND = 'dataglow-diplomacy-approval-request';
export const APPROVAL_RECORD_KIND = 'dataglow-diplomacy-approval-record';

/**
 * Construct a two-party approval request — pure data, zero side effects. Throws
 * on a missing party id, or on two identical party ids: the two-key rule is
 * meaningless if "both keys" are the same hand.
 *
 * @param {object} opts
 * @param {object} opts.reconciliationResult  a result from reconcileClaims()
 * @param {string} opts.partyAId  first approving party's id
 * @param {string} opts.partyBId  second approving party's id (must differ from A)
 * @returns {object} an inert pending request; status is always 'pending' at creation
 */
export function createApprovalRequest({ reconciliationResult, partyAId, partyBId } = {}) {
  if (partyAId == null || partyAId === '') throw new Error('createApprovalRequest: partyAId is required');
  if (partyBId == null || partyBId === '') throw new Error('createApprovalRequest: partyBId is required');
  if (partyAId === partyBId) {
    throw new Error('createApprovalRequest: the two parties must be different — one party cannot hold both keys');
  }
  return {
    kind: APPROVAL_REQUEST_KIND,
    reconciliationResult: reconciliationResult ?? null,
    partyAId,
    partyBId,
    status: 'pending',
    approvals: { [partyAId]: false, [partyBId]: false },
    createdAt: Date.now(),
    decidedAt: null,
    rejection: null,
    sealedRecord: null,
  };
}

function bothApproved(request) {
  return request.approvals[request.partyAId] === true && request.approvals[request.partyBId] === true;
}

// Deterministic content the sealedRecord commits to. Excludes volatile fields
// (createdAt) and the fingerprint itself so verifyApprovalRecord reconstructs the
// identical content. Captures WHO approved and WHAT verdict they approved.
function approvalRecordContent(request) {
  const r = request.reconciliationResult || {};
  const winning = r.winningClaim || null;
  return {
    kind: APPROVAL_RECORD_KIND,
    partyAId: request.partyAId,
    partyBId: request.partyBId,
    approvals: {
      [request.partyAId]: request.approvals[request.partyAId] === true,
      [request.partyBId]: request.approvals[request.partyBId] === true,
    },
    reconciliation: {
      resolved: r.resolved === true,
      reason: r.reason ?? null,
      winningSource: winning ? winning.source ?? null : null,
      winningValue: winning ? winning.value ?? null : null,
      winningFingerprint: winning ? winning.fingerprint ?? null : null,
    },
    decidedAt: request.decidedAt,
  };
}

/**
 * Record a party's approval. Idempotent per party (double-approve by the same
 * party is a no-op). The request flips to 'applied' — and is sealed — ONLY once
 * BOTH distinct party ids have approved. Async because sealing the final record
 * awaits the SHA-256 fingerprint primitive.
 *
 * @param {object} request  a request from createApprovalRequest() (mutated in place)
 * @param {string} partyId  the approving party (must be one of the two parties)
 * @returns {Promise<{ok:boolean, request?:object, bothApproved?:boolean, error?:string}>}
 */
export async function approve(request, partyId) {
  if (!request || typeof request !== 'object') return { ok: false, error: 'No request given.' };
  if (!(partyId in request.approvals)) {
    return { ok: false, error: `Unknown party "${partyId}" — not one of this request's two parties.` };
  }
  if (request.status === 'rejected') {
    return { ok: false, error: 'This request was rejected; create a new one to try again.' };
  }
  if (request.status === 'applied') {
    // Idempotent: already fully approved and sealed. Never double-seal.
    return { ok: true, request, bothApproved: true };
  }

  request.approvals[partyId] = true;

  if (bothApproved(request)) {
    request.status = 'applied';
    request.decidedAt = Date.now();
    const content = approvalRecordContent(request);
    request.sealedRecord = { ...content, fingerprint: await fingerprintClaimContent(content) };
    return { ok: true, request, bothApproved: true };
  }

  // Only one key turned so far — the two-key rule keeps it pending.
  return { ok: true, request, bothApproved: false };
}

/**
 * Reject the request on behalf of one party. Either party can reject
 * unilaterally. Nothing is sealed. Idempotent: rejecting an already-rejected
 * request is a harmless no-op; rejecting an already-applied request fails
 * cleanly (mirrors the Metric Contract gate's already-applied guard).
 *
 * @param {object} request  a request from createApprovalRequest() (mutated in place)
 * @param {string} partyId  the rejecting party (must be one of the two parties)
 * @param {string} [note]   optional free-text reason
 * @returns {{ok:boolean, request?:object, error?:string}}
 */
export function reject(request, partyId, note = '') {
  if (!request || typeof request !== 'object') return { ok: false, error: 'No request given.' };
  if (!(partyId in request.approvals)) {
    return { ok: false, error: `Unknown party "${partyId}" — not one of this request's two parties.` };
  }
  if (request.status === 'applied') {
    return { ok: false, error: 'This request was already applied; rejecting it now would not undo that.' };
  }
  if (request.status === 'rejected') {
    return { ok: true, request };
  }
  request.status = 'rejected';
  request.decidedAt = Date.now();
  request.rejection = { by: partyId, note };
  return { ok: true, request };
}

/**
 * Recompute a sealed applied-record's fingerprint and report whether it still
 * matches — the verifyClaimSeal-style tamper check for a two-key record. Genuine
 * tamper detection: editing any sealed field (a party's approval, the winning
 * value, …) changes the recomputed hash and fails.
 * @param {object} record  a request.sealedRecord from an applied request
 * @returns {Promise<{valid:boolean, reason?:string}>}
 */
export async function verifyApprovalRecord(record) {
  if (!record || typeof record !== 'object') {
    return { valid: false, reason: 'Not an approval record.' };
  }
  if (record.kind !== APPROVAL_RECORD_KIND) {
    return { valid: false, reason: 'Not a DATAGLOW diplomacy approval record (missing/incorrect "kind").' };
  }
  if (typeof record.fingerprint !== 'string' || !record.fingerprint) {
    return { valid: false, reason: 'Record has no fingerprint to verify.' };
  }
  const { fingerprint, ...content } = record;
  const recomputed = await fingerprintClaimContent(content);
  if (recomputed !== fingerprint) {
    return { valid: false, reason: 'Fingerprint mismatch — the approval record was modified after it was sealed.' };
  }
  return { valid: true };
}
