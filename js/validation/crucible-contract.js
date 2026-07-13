// ============================================================
// DATAGLOW — The Crucible: typed handoff contract (Batch 1 of 3)
// ============================================================
// The Crucible is an adversarial validator that stress-tests another agent's (or
// rule's) PROPOSED data changes BEFORE anything is applied. This module ships the
// two typed objects that flow across that boundary — nothing else. It is pure,
// Node-testable, DOM/DuckDB/network-free, and NEVER throws: malformed or empty
// input returns a safe { ok:false, errors:[...] } result instead of a valid object.
//
// Handoff direction (borrowing Salesforce Agentforce's framing informally: a
// one-way `@utils.transition` handoff hands control off and does not expect a
// reply on the same channel, whereas a round-trip `@topic` call awaits a return):
//   • CleaningResult    — a ONE-WAY handoff INTO the Crucible. The Cleaning Agent
//                         states what it wants to change and how sure it is; it
//                         does not itself wait for a structured answer here.
//   • ValidationVerdict — a ONE-WAY handoff OUT of the Crucible, back to whatever
//                         orchestration layer decides to apply or discard the
//                         changes. The Validator does not apply anything itself.
// Neither object is a round-trip request/response: the Crucible is a gate in a
// pipeline, not a conversational partner. Batch 1 does NOT build the orchestration
// layer that reads a verdict and applies/reverts changes (that is Batch 3) nor any
// UI (Batch 2) — it builds only these two typed objects and their validation.

import { sha256Hex } from '../provenance/provenance.js';

const DECISIONS = Object.freeze(['accept', 'reject', 'escalate']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// A single proposed change: which field, its current value, the value the agent
// wants to write, and the rule that motivated it. oldValue/newValue may be any
// JSON-ish scalar (including null), so only field and rule are shape-checked.
function validateChange(change, index) {
  const errors = [];
  if (!isPlainObject(change)) {
    errors.push(`changes[${index}] must be an object`);
    return errors;
  }
  if (!isNonEmptyString(change.field)) errors.push(`changes[${index}].field must be a non-empty string`);
  if (!('oldValue' in change)) errors.push(`changes[${index}].oldValue is required (may be null)`);
  if (!('newValue' in change)) errors.push(`changes[${index}].newValue is required (may be null)`);
  if (!isNonEmptyString(change.rule)) errors.push(`changes[${index}].rule must be a non-empty string`);
  return errors;
}

/**
 * Construct and validate a CleaningResult — the one-way handoff INTO the Crucible.
 * Never throws; malformed input returns { ok:false, errors:[...] }.
 *
 * @param {{changes:Array<{field:string, oldValue:*, newValue:*, rule:string}>,
 *          confidence:number, rulesCited:string[], agentId:string}} input
 * @returns {{ok:true, result:object} | {ok:false, errors:string[]}}
 */
export function buildCleaningResult(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['input must be an object'] };
  }
  const { changes, confidence, rulesCited, agentId } = input;

  if (!Array.isArray(changes)) {
    errors.push('changes must be an array');
  } else {
    changes.forEach((c, i) => errors.push(...validateChange(c, i)));
  }

  if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    errors.push('confidence must be a number in [0, 1]');
  }

  if (!Array.isArray(rulesCited) || !rulesCited.every(isNonEmptyString)) {
    errors.push('rulesCited must be an array of non-empty strings');
  }

  if (!isNonEmptyString(agentId)) {
    errors.push('agentId must be a non-empty string');
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    result: {
      kind: 'CleaningResult',
      agentId,
      confidence,
      rulesCited: [...rulesCited],
      changes: changes.map((c) => ({ field: c.field, oldValue: c.oldValue, newValue: c.newValue, rule: c.rule })),
    },
  };
}

// A pack result is one adversarial pack's outcome. Kept permissive on purpose —
// runAdversarialSuite() in crucible-adversarial-packs.js is the authority on the
// exact shape; here we only assert the fields the verdict actually reasons about.
function validatePackResult(pr, index) {
  const errors = [];
  if (!isPlainObject(pr)) {
    errors.push(`packResults[${index}] must be an object`);
    return errors;
  }
  if (!isNonEmptyString(pr.id)) errors.push(`packResults[${index}].id must be a non-empty string`);
  if (typeof pr.passed !== 'boolean') errors.push(`packResults[${index}].passed must be a boolean`);
  return errors;
}

/**
 * Construct and validate a ValidationVerdict — the one-way handoff OUT of the
 * Crucible. Never throws; malformed input returns { ok:false, errors:[...] }.
 *
 * @param {{subjectResult:object,
 *          packResults:Array<{id:string, passed:boolean}>,
 *          decision:'accept'|'reject'|'escalate',
 *          escalationReason?:string}} input
 * @returns {{ok:true, verdict:object} | {ok:false, errors:string[]}}
 */
export function buildValidationVerdict(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['input must be an object'] };
  }
  const { subjectResult, packResults, decision, escalationReason } = input;

  if (!isPlainObject(subjectResult)) {
    errors.push('subjectResult must be an object (a CleaningResult)');
  }

  if (!Array.isArray(packResults)) {
    errors.push('packResults must be an array');
  } else {
    packResults.forEach((pr, i) => errors.push(...validatePackResult(pr, i)));
  }

  if (!DECISIONS.includes(decision)) {
    errors.push(`decision must be one of ${DECISIONS.join(' | ')}`);
  }

  // An escalation with no stated reason is not actionable by a human reviewer.
  if (decision === 'escalate' && !isNonEmptyString(escalationReason)) {
    errors.push('escalationReason must be a non-empty string when decision is "escalate"');
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    verdict: {
      kind: 'ValidationVerdict',
      decision,
      subjectResult,
      packResults: [...packResults],
      escalationReason: isNonEmptyString(escalationReason) ? escalationReason : null,
    },
  };
}

/**
 * Stable content fingerprint for a CleaningResult, reusing the provenance
 * sha256Hex primitive (no new crypto). Gives the one-way handoff a deterministic
 * id so a later orchestration batch can dedupe / audit which result a verdict
 * answered. Async only because SHA-256 is; the builders above stay sync.
 *
 * @param {object} result a CleaningResult (the `.result` of a successful build)
 * @returns {Promise<string>} hex SHA-256, or '' for a non-object input
 */
export async function fingerprintCleaningResult(result) {
  if (!isPlainObject(result)) return '';
  // Canonicalize the fields that define the proposed change, order-stable.
  const canonical = JSON.stringify({
    agentId: result.agentId ?? null,
    confidence: result.confidence ?? null,
    rulesCited: Array.isArray(result.rulesCited) ? result.rulesCited : [],
    changes: Array.isArray(result.changes)
      ? result.changes.map((c) => [c.field, c.oldValue, c.newValue, c.rule])
      : [],
  });
  return sha256Hex(canonical);
}

export const CRUCIBLE_DECISIONS = DECISIONS;
