// ============================================================
// DATAGLOW — Agent Action Firewall (DataGlow Passport, Batch 1)
// ============================================================
// The single, central checkpoint every code path that proposes to MUTATE loaded
// data must pass through: cleaning fixes, self-learning rule auto-application, a
// conversational-pack-builder finalize that writes back, meeting-scribe action
// items, and any future autonomous agent. Its one job is to make a hard,
// non-negotiable guarantee structurally true rather than merely conventional:
//
//   NO autonomous agent, suggestion engine, or AI-generated proposal may modify,
//   clean, delete, or otherwise mutate loaded data without an explicit,
//   per-action human confirmation — AND there is NO "trusted mode", "auto",
//   "force", or any other parameter anywhere that skips this gate.
//
// This is the direct, coded lesson of the April 2026 industry incident where an
// AI coding agent, given unrestricted permissions, deleted a company's
// production database and all backups in nine seconds with no confirmation step.
// The gate here FAILS CLOSED: absent a valid, per-action human confirmation the
// mutation simply does not run, and the caller-supplied executor is never
// invoked.
//
// DESIGN (why it can't be bypassed):
//   * A mutation is a two-phase handshake. `proposeAction()` classifies and
//     freezes a proposal and mints a single-use, per-proposal nonce. It NEVER
//     executes anything.
//   * `confirmAndApply()` runs the caller's executor ONLY after it verifies a
//     confirmation object that (a) says confirmed === true, (b) carries the
//     proposal's exact nonce (so a confirmation for action A cannot be replayed
//     to authorize action B), (c) carries an authenticated human identity, and
//     (d) supplies the executor. Any missing/invalid piece throws
//     AgentActionBlocked and the executor is not called.
//   * There is deliberately NO options argument that can relax any of the above.
//     A red-team suite (test/agent-action-firewall.test.mjs) asserts that extra
//     properties like { trusted:true }, { force:true }, { auto:true } are inert.
//
// THE IDENTITY RIDER (closes the "who authorized this?" audit gap): the identity
// is captured at the EXACT moment of confirmation and handed to the audit
// recorder, so the chain-of-custody records which human authorized each
// mutation. Identity is deliberately minimal and LOCAL — a locally-set display
// name and/or a browser/session identifier — NOT a new account system or network
// auth. Zero-upload / local-first is preserved: this module names no network
// primitive and imports nothing.
//
// This module is pure: no DOM, no network, no storage, no imports. Provenance /
// ledger writing is done through an INJECTED recorder callback (same injected-
// dependency pattern as the pack builder's fetcher), so the module stays
// browser-free and unit-testable in Node.

// ------------------------------------------------------------
// Risk / reversibility classification
// ------------------------------------------------------------
// Every mutating action is classified so the confirmation UI (and the audit
// trail) can state, plainly, how dangerous and how reversible it is. The gate
// does NOT change based on risk — EVERY mutation needs confirmation, a LOW-risk
// annotation as much as a CRITICAL delete — but the classification is recorded so
// a human confirming a CRITICAL, irreversible action sees exactly that.

export const ActionRisk = Object.freeze({
  LOW: 'low',
  MODERATE: 'moderate',
  HIGH: 'high',
  CRITICAL: 'critical',
});

// Action kinds this firewall understands. Anything not listed is treated as an
// UNKNOWN mutation and classified CRITICAL/irreversible — an unrecognized action
// gets the MOST cautious treatment, never the least (fail safe, not fail open).
const ACTION_KINDS = Object.freeze({
  // Destructive, non-recoverable once applied to the loaded table.
  'delete-rows': { risk: ActionRisk.CRITICAL, reversible: false, category: 'destructive' },
  'drop-column': { risk: ActionRisk.CRITICAL, reversible: false, category: 'destructive' },
  'drop-table': { risk: ActionRisk.CRITICAL, reversible: false, category: 'destructive' },
  'truncate': { risk: ActionRisk.CRITICAL, reversible: false, category: 'destructive' },
  'dedupe': { risk: ActionRisk.HIGH, reversible: false, category: 'destructive' },
  // In-place value mutations: recoverable only by reloading the source.
  'update-values': { risk: ActionRisk.MODERATE, reversible: false, category: 'mutating' },
  'impute': { risk: ActionRisk.MODERATE, reversible: false, category: 'mutating' },
  'transform-column': { risk: ActionRisk.MODERATE, reversible: false, category: 'mutating' },
  'merge-categories': { risk: ActionRisk.MODERATE, reversible: false, category: 'mutating' },
  // Additive / metadata-only: does not alter existing cell values in place.
  'annotate': { risk: ActionRisk.LOW, reversible: true, category: 'additive' },
  'apply-rule': { risk: ActionRisk.LOW, reversible: true, category: 'additive' },
  'add-column': { risk: ActionRisk.LOW, reversible: true, category: 'additive' },
});

// Human-readable reason string for the classification, used in the confirm UI
// and recorded in the audit trail.
function classificationReason(kind, meta) {
  const affected = meta && Number.isFinite(meta.affectedCount) ? meta.affectedCount : null;
  const scope = affected != null ? ` (${affected} value(s)/row(s) affected)` : '';
  const known = ACTION_KINDS[kind];
  if (!known) {
    return `Unrecognized action "${kind}" — treated as a CRITICAL, irreversible mutation and requires explicit human confirmation${scope}.`;
  }
  if (known.category === 'destructive') {
    return `Destructive action "${kind}" cannot be undone in-app once applied${scope}; requires explicit human confirmation.`;
  }
  if (known.category === 'mutating') {
    return `Action "${kind}" mutates loaded values in place${scope}; requires explicit human confirmation.`;
  }
  return `Action "${kind}" is additive/metadata-only${scope} but, like every mutation, still requires explicit human confirmation.`;
}

/**
 * Classify a proposed action's risk and reversibility. Pure and total — never
 * throws for a bad kind; an unknown/blank kind is classified CRITICAL and
 * irreversible so the most dangerous default applies to anything unrecognized.
 * @param {{kind:string, affectedCount?:number}} action
 * @returns {{kind:string, risk:string, reversible:boolean, category:string, reason:string, known:boolean}}
 */
export function classifyAction(action = {}) {
  const kind = typeof action.kind === 'string' ? action.kind.trim() : '';
  const known = ACTION_KINDS[kind];
  const base = known || { risk: ActionRisk.CRITICAL, reversible: false, category: 'unknown' };
  return {
    kind: kind || '(unspecified)',
    risk: base.risk,
    reversible: base.reversible,
    category: base.category,
    reason: classificationReason(kind, action),
    known: !!known,
  };
}

/** Error thrown whenever the gate refuses to let a mutation proceed. */
export class AgentActionBlocked extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentActionBlocked';
    this.code = code || 'blocked';
    // Always safe to surface: this is the app doing its job, not a crash.
    this.blockedByFirewall = true;
  }
}

// A monotonically-increasing counter mixed into each nonce so two proposals in
// the same millisecond still get distinct nonces. Module-local, never exported.
let _nonceSeq = 0;

// Mint a single-use, per-proposal nonce. It does not need to be cryptographically
// unguessable — it is not a secret, it is a binding token proving a confirmation
// belongs to THIS proposal — only unique and unforgeable-by-accident.
function mintNonce() {
  _nonceSeq = (_nonceSeq + 1) % Number.MAX_SAFE_INTEGER;
  const rand = Math.floor(Math.random() * 1e9);
  return `aaf-${Date.now().toString(36)}-${_nonceSeq.toString(36)}-${rand.toString(36)}`;
}

/**
 * Normalize / validate an authenticated human identity. Minimal + local by
 * design: a display name and/or a local device/session id, plus an optional
 * source label. At least one non-empty identifier is REQUIRED — an anonymous
 * confirmation is not a confirmation, which is the whole point of the rider.
 * @param {{displayName?:string, sessionId?:string, deviceId?:string, source?:string}} identity
 * @returns {{displayName:string|null, sessionId:string|null, source:string, label:string}|null}
 *   null when no usable identifier is present (caller must then fail closed).
 */
export function normalizeIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  const displayName = strOrNull(identity.displayName);
  const sessionId = strOrNull(identity.sessionId) || strOrNull(identity.deviceId);
  if (!displayName && !sessionId) return null;
  const source = strOrNull(identity.source) || 'local-device';
  const label = displayName
    ? (sessionId ? `${displayName} (${sessionId})` : displayName)
    : sessionId;
  return { displayName: displayName || null, sessionId: sessionId || null, source, label };
}

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Phase 1 — propose (never executes). Validate + classify the action and mint a
 * single-use nonce that a matching confirmation must echo back. Returns a frozen
 * proposal; the nonce is the binding between this proposal and its confirmation.
 * @param {{kind:string, table?:string, column?:string, description?:string, affectedCount?:number}} action
 * @returns {Readonly<{id:string, nonce:string, action:object, classification:object, createdAt:number}>}
 */
export function proposeAction(action = {}) {
  if (!action || typeof action !== 'object') {
    throw new AgentActionBlocked('Firewall: an action proposal must be an object.', 'invalid-action');
  }
  if (!strOrNull(action.kind)) {
    throw new AgentActionBlocked('Firewall: an action proposal must name a "kind".', 'invalid-action');
  }
  const classification = classifyAction(action);
  const nonce = mintNonce();
  const proposal = {
    id: nonce,
    nonce,
    action: Object.freeze({
      kind: classification.kind,
      table: strOrNull(action.table),
      column: strOrNull(action.column),
      description: strOrNull(action.description) || classification.reason,
      affectedCount: Number.isFinite(action.affectedCount) ? action.affectedCount : null,
    }),
    classification: Object.freeze(classification),
    createdAt: Date.now(),
  };
  return Object.freeze(proposal);
}

// Nonces already spent, so a confirmation can be used AT MOST once (replay
// protection: a captured confirmation cannot re-authorize the same proposal a
// second time). Module-local set; bounded pruning keeps it from growing without
// limit in a long session.
const _spentNonces = new Set();
function markSpent(nonce) {
  _spentNonces.add(nonce);
  if (_spentNonces.size > 5000) {
    // Drop the oldest ~half. Insertion order is preserved by Set.
    let drop = _spentNonces.size - 2500;
    for (const n of _spentNonces) { if (drop-- <= 0) break; _spentNonces.delete(n); }
  }
}

/**
 * Phase 2 — confirm + apply. Runs `apply` ONLY after every check below passes;
 * otherwise throws AgentActionBlocked and `apply` is never called. There is no
 * options object and no code path that relaxes these checks — that absence is
 * the guarantee.
 *
 * @param {object} args
 * @param {object} args.proposal      a proposal from proposeAction()
 * @param {object} args.confirmation  { confirmed:true, nonce, identity }
 *                                     - confirmed MUST be strictly true
 *                                     - nonce MUST equal the proposal's nonce
 *                                     - identity MUST resolve to a real local id
 * @param {() => (any|Promise<any>)} args.apply  the actual mutation executor
 * @param {(record:object) => (any|Promise<any>)} [args.recordAudit]  injected
 *        recorder; called AFTER a successful gate with the authorization record
 *        (identity + classification) so the chain-of-custody names the human.
 * @returns {Promise<{ok:true, result:any, authorization:object}>}
 * @throws {AgentActionBlocked}
 */
export async function confirmAndApply(args = {}) {
  const { proposal, confirmation, apply, recordAudit } = args;

  if (!proposal || typeof proposal !== 'object' || typeof proposal.nonce !== 'string') {
    throw new AgentActionBlocked('Firewall: a valid proposal (from proposeAction) is required.', 'invalid-proposal');
  }
  if (typeof apply !== 'function') {
    throw new AgentActionBlocked('Firewall: no executor supplied — nothing to apply, refusing to proceed.', 'no-executor');
  }
  // The heart of the gate: an explicit, affirmative, per-action human confirm.
  if (!confirmation || typeof confirmation !== 'object') {
    throw new AgentActionBlocked('Firewall: this mutation was not confirmed by a human — blocked.', 'no-confirmation');
  }
  if (confirmation.confirmed !== true) {
    throw new AgentActionBlocked('Firewall: confirmation.confirmed must be exactly true — blocked.', 'not-confirmed');
  }
  if (confirmation.nonce !== proposal.nonce) {
    throw new AgentActionBlocked('Firewall: confirmation does not match this proposal (nonce mismatch) — a confirmation cannot be replayed onto a different action.', 'nonce-mismatch');
  }
  if (_spentNonces.has(proposal.nonce)) {
    throw new AgentActionBlocked('Firewall: this confirmation was already used — a confirmation authorizes exactly one mutation.', 'nonce-spent');
  }
  // The RIDER: an authenticated human identity is mandatory at confirm time.
  const identity = normalizeIdentity(confirmation.identity);
  if (!identity) {
    throw new AgentActionBlocked('Firewall: no authenticated human identity accompanied the confirmation — the audit trail must record who authorized this mutation.', 'no-identity');
  }

  // All checks passed. Spend the nonce BEFORE executing so a re-entrant or
  // duplicate call cannot double-apply.
  markSpent(proposal.nonce);

  const authorization = Object.freeze({
    authorizedBy: identity,
    action: proposal.action,
    classification: proposal.classification,
    confirmedAt: Date.now(),
    nonce: proposal.nonce,
  });

  // Record the authorization into the chain-of-custody FIRST (via the injected
  // recorder), so even if the executor itself throws mid-way, the trail already
  // shows a human authorized the attempt. Recorder errors never mask the gate.
  if (typeof recordAudit === 'function') {
    try { await recordAudit(authorization); } catch { /* audit best-effort; never blocks a confirmed action */ }
  }

  const result = await apply();
  return { ok: true, result, authorization };
}

/**
 * Convenience one-shot for callers that already hold both the action spec and a
 * fresh human confirmation (e.g. a click handler): propose + confirm + apply in
 * one call. The confirmation supplies { confirmed, identity }; the nonce is
 * threaded internally so the caller never has to. Same fail-closed guarantees.
 * @param {object} action           passed to proposeAction()
 * @param {object} confirmation     { confirmed:true, identity }
 * @param {() => any} apply         mutation executor
 * @param {(rec:object)=>any} [recordAudit]
 */
export async function guardMutation(action, confirmation, apply, recordAudit) {
  const proposal = proposeAction(action);
  const conf = { ...(confirmation || {}), nonce: proposal.nonce };
  return confirmAndApply({ proposal, confirmation: conf, apply, recordAudit });
}

// Reset spent-nonce bookkeeping. For tests only; the app never calls this.
export function _resetFirewallForTests() {
  _spentNonces.clear();
  _nonceSeq = 0;
}
