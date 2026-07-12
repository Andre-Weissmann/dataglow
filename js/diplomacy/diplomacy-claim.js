// ============================================================
// DATAGLOW — Data Diplomacy, Batch 1: claim + seal builder
// ============================================================
// WHY THIS EXISTS (the new capability, batch 1):
// Every other DATAGLOW trust surface reasons about ONE dataset: is it clean, is
// it ready, is its provenance intact. Data Diplomacy is the first capability
// built around DISAGREEMENT between TWO parties who each hold a claim about the
// same real-world thing — e.g. a Riverside record says a customer's region is
// "West" while a Lakeside record says "Pacific". Before two parties can debate
// which claim wins, each claim must be made INERT and TAMPER-EVIDENT: sealed so
// it can later be re-verified as the exact thing that was put on the table, not
// something quietly edited mid-negotiation.
//
// WHAT THIS MODULE IS: a PURE claim builder + verifier. `sealClaim()` turns the
// caller's raw assertion into an inert, fingerprinted claim object; nothing is
// written to any registry, sent anywhere, or negotiated here. `verifyClaimSeal()`
// recomputes the fingerprint so a mutated claim fails — genuine tamper
// detection, not a "trusted" label.
//
// IT DOES NOT INVENT CRYPTO. The fingerprint is a SHA-256 hex over the claim's
// canonical JSON, reusing the SAME `sha256Hex` primitive the rest of
// js/provenance/ folds and the SAME `canonicalJSON` serializer
// js/provenance/verifiable-check-seal.js already commits with. If a new
// commitment behaviour is ever needed, extend those primitives — do not fork a
// second hashing scheme here.
//
// WHAT IT DELIBERATELY DOES NOT DO YET (deferred to later batches):
//   - Batch 2: a thin two-key approval UI wiring (a DOM presenter).
//   - A later batch: real peer-to-peer transport of sealed claims.
// This batch is pure logic + tests ONLY. Nothing in the app calls it yet.
//
// PURITY: no DOM, no engine, no network — identical in the browser, the Tauri
// desktop webview, and headless Node tests.

import { sha256Hex } from '../provenance/provenance.js';
import { canonicalJSON } from '../provenance/verifiable-check-seal.js';

export const CLAIM_KIND = 'dataglow-diplomacy-claim';

// A claim value of null/undefined is meaningless (there is nothing to reconcile),
// so those are treated as missing; 0, false, and '' are legitimate values and
// pass. confidence is genuinely optional — Riverside/Lakeside-style records may
// or may not carry one — so it defaults to null and only a present-but-invalid
// confidence (outside [0,1], or non-numeric) is rejected.
function normalizeConfidence(confidence) {
  if (confidence == null) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(
      `sealClaim: confidence must be a number in [0,1] or omitted; got ${JSON.stringify(confidence)}`);
  }
  return confidence;
}

// The exact, key-order-independent content the fingerprint commits to. Kept
// separate from the returned object so verifyClaimSeal reconstructs the IDENTICAL
// content and any edit to a sealed field changes the recomputed hash.
function claimContent({ entityId, field, value, confidence, source, sealedBy, sealedAt }) {
  return { kind: CLAIM_KIND, entityId, field, value, confidence, source, sealedBy, sealedAt };
}

/**
 * SHA-256 hex fingerprint over the canonical JSON of a claim's content. Exported
 * so the approval gate (js/diplomacy/diplomacy-approval-gate.js) seals its final
 * applied record with the IDENTICAL primitive rather than duplicating crypto.
 * @param {object} content
 * @returns {Promise<string>}
 */
export function fingerprintClaimContent(content) {
  return sha256Hex(canonicalJSON(content));
}

/**
 * Build an inert, sealed claim. ALWAYS an explicit caller action — nothing is
 * negotiated, written, or sent. Throws on a missing required field (entityId,
 * field, value, source) because an unidentified claim can never be reconciled.
 *
 * @param {object} opts
 * @param {string} opts.entityId  the entity the claim is about (e.g. a customer id)
 * @param {string} opts.field     the field being asserted (e.g. "region")
 * @param {*}      opts.value      the asserted value (0/false/'' are valid; null/undefined are not)
 * @param {number} [opts.confidence]  optional 0-1 confidence; omitted → null
 * @param {string} opts.source    where the claim came from (e.g. "riverside-crm")
 * @param {string} [opts.sealedBy] optional party/agent id that sealed it
 * @param {number|Date} [opts.sealedAt] optional seal timestamp (tests); defaults to now
 * @returns {Promise<{kind:string, entityId:string, field:string, value:*, confidence:(number|null), source:string, sealedBy:(string|null), sealedAt:string, fingerprint:string}>}
 */
export async function sealClaim({ entityId, field, value, confidence, source, sealedBy, sealedAt } = {}) {
  const missing = [];
  if (entityId == null || entityId === '') missing.push('entityId');
  if (field == null || field === '') missing.push('field');
  if (value == null) missing.push('value');
  if (source == null || source === '') missing.push('source');
  if (missing.length) {
    throw new Error(`sealClaim: missing required field(s): ${missing.join(', ')}`);
  }

  const content = claimContent({
    entityId,
    field,
    value,
    confidence: normalizeConfidence(confidence),
    source,
    sealedBy: sealedBy ?? null,
    sealedAt: sealedAt != null ? new Date(sealedAt).toISOString() : new Date().toISOString(),
  });

  const fingerprint = await fingerprintClaimContent(content);
  return { ...content, fingerprint };
}

/**
 * Recompute a claim's fingerprint and report whether it still matches. Genuine
 * tamper detection: any edit to a sealed field (value, confidence, source, …)
 * changes the recomputed hash and fails. Needs only the claim itself.
 * @param {object} claim  a claim from sealClaim()
 * @returns {Promise<{valid:boolean, reason?:string}>}
 */
export async function verifyClaimSeal(claim) {
  if (!claim || typeof claim !== 'object') {
    return { valid: false, reason: 'Not a claim object.' };
  }
  if (claim.kind !== CLAIM_KIND) {
    return { valid: false, reason: 'Not a DATAGLOW diplomacy claim (missing/incorrect "kind").' };
  }
  if (typeof claim.fingerprint !== 'string' || !claim.fingerprint) {
    return { valid: false, reason: 'Claim has no fingerprint to verify.' };
  }
  const recomputed = await fingerprintClaimContent(claimContent({
    entityId: claim.entityId,
    field: claim.field,
    value: claim.value,
    confidence: claim.confidence ?? null,
    source: claim.source,
    sealedBy: claim.sealedBy ?? null,
    sealedAt: claim.sealedAt,
  }));
  if (recomputed !== claim.fingerprint) {
    return { valid: false, reason: 'Fingerprint mismatch — the claim was modified after it was sealed.' };
  }
  return { valid: true };
}
