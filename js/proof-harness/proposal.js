// ============================================================
// DATAGLOW - Proof Harness v0 (VERDICT): typed Proposal
// ============================================================
// WHY THIS EXISTS
// The MASTER PROMPT doctrine is explicit: "No execution path may accept a
// free-form model string. Every execution begins as a typed Proposal object.
// Reject any design that pastes model text into an executor." This module is
// that gate. It is the ONLY way a SQL statement is allowed to become
// something a runner will execute in the Proof Harness: createTypedProposal()
// validates the shape, computes a content digest that binds the statement
// (plus its engine/expected/tables) to a fixed value, and returns a frozen
// Proposal. There is no sibling function that lets a caller skip validation
// and hand a raw string straight to an executor -- runProposal()-style
// callers in the canvas UI only ever accept a Proposal object, never a
// string, so "reject free-form execution" is enforced by there being no other
// door in, not by a runtime check alone.
//
// PURITY: no DOM, no network, no engine call. sha256Hex mirrors the same
// restated-per-module discipline as js/provenance/trust-ledger.js (see that
// file's header for why: this module is also inlined into canvas/index.html's
// single inline <script>, where ESM imports do not resolve).
//
// DIGEST: sha256 over a canonical JSON of the fields that define what will be
// run (engine, statement, expected, tables, claimText). `author` is carried on
// the Proposal but deliberately EXCLUDED from the digest: the same statement
// proposed by "ai" or by "human" is still the same proposal to prove or
// refute, and confirm-gate invalidation must fire only when the executable
// content changes, not when authorship metadata is edited.

const SUPPORTED_ENGINES = Object.freeze(['duckdb', 'pyodide', 'webr']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** SHA-256 of a string, lowercase hex. Same algorithm as trust-ledger.js. */
export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a raw proposal input before it is allowed to become a Proposal.
 * Never throws: returns { valid, reason }.
 * @param {object} input
 */
export function validateProposalInput(input) {
  if (!isPlainObject(input)) {
    return { valid: false, reason: 'proposal input must be a plain object' };
  }
  if (typeof input.statement !== 'string' || !input.statement.trim()) {
    return { valid: false, reason: 'proposal.statement is required and must be a non-empty SQL string' };
  }
  const engine = typeof input.engine === 'string' ? input.engine : 'duckdb';
  if (!SUPPORTED_ENGINES.includes(engine)) {
    return { valid: false, reason: `proposal.engine must be one of: ${SUPPORTED_ENGINES.join(', ')}` };
  }
  if (input.expected !== undefined && !isPlainObject(input.expected)) {
    return { valid: false, reason: 'proposal.expected must be a plain object when provided' };
  }
  if (input.tables !== undefined && !Array.isArray(input.tables)) {
    return { valid: false, reason: 'proposal.tables must be an array of table names when provided' };
  }
  return { valid: true, reason: null };
}

// Deterministic serialization of exactly the fields the digest commits to, so
// the same proposal always hashes identically regardless of key order.
function canonicalProposalPayload(p) {
  const fields = {
    claimText: p.claimText ?? null,
    engine: p.engine,
    expected: p.expected ?? null,
    statement: p.statement,
    tables: Array.isArray(p.tables) ? p.tables.slice().sort() : [],
  };
  return JSON.stringify(fields);
}

/**
 * Build a typed Proposal. THIS IS THE ONLY LEGAL WAY IN: an executor must
 * never accept a bare SQL string, only the object this returns. Rejects
 * malformed input with { rejected: true, reason } rather than throwing, so a
 * caller can show a remediation message instead of crashing.
 *
 * @param {{statement:string, engine?:'duckdb'|'pyodide'|'webr', expected?:object,
 *          tables?:string[], author?:'ai'|'human', claimText?:string, modelId?:string}} input
 * @returns {Promise<{rejected:true, reason:string} | {rejected:false, statement:string,
 *   engine:string, expected:object, tables:string[], author:string, claimText:string|null,
 *   modelId:string|null, digest:string, createdAt:number}>}
 */
export async function createTypedProposal(input) {
  const { valid, reason } = validateProposalInput(input);
  if (!valid) {
    return { rejected: true, reason };
  }
  const proposal = {
    statement: input.statement.trim(),
    engine: typeof input.engine === 'string' ? input.engine : 'duckdb',
    expected: isPlainObject(input.expected) ? { ...input.expected } : {},
    tables: Array.isArray(input.tables) ? input.tables.slice() : [],
    author: input.author === 'human' ? 'human' : (input.author === 'ai' ? 'ai' : 'human'),
    claimText: typeof input.claimText === 'string' && input.claimText.trim() ? input.claimText.trim() : null,
    modelId: typeof input.modelId === 'string' && input.modelId.trim() ? input.modelId.trim() : null,
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
  };
  const digest = await sha256Hex(canonicalProposalPayload(proposal));
  return { rejected: false, ...proposal, digest: `sha256:${digest}` };
}

/**
 * Recompute a proposal's digest from its current field values, for comparing
 * against a previously stored digest (confirm-gate invalidation). Returns the
 * SAME digest string shape ("sha256:<hex>") createTypedProposal() produces.
 * @param {object} proposal a proposal object (rejected proposals have no digest)
 */
export async function digestProposal(proposal) {
  if (!isPlainObject(proposal)) return null;
  const digest = await sha256Hex(canonicalProposalPayload({
    claimText: proposal.claimText ?? null,
    engine: proposal.engine,
    expected: proposal.expected ?? {},
    statement: proposal.statement,
    tables: proposal.tables ?? [],
  }));
  return `sha256:${digest}`;
}

/**
 * Whether a proposal's current fields still match its own recorded digest.
 * Used by the confirm gate to detect a byte-level edit after confirm was
 * bound: if the statement (or engine/expected/tables) changed since the
 * digest was computed, this returns false and the confirm must be redone.
 * @param {object} proposal
 */
export async function proposalMatchesDigest(proposal) {
  if (!isPlainObject(proposal) || typeof proposal.digest !== 'string') return false;
  const recomputed = await digestProposal(proposal);
  return recomputed === proposal.digest;
}

export const PROOF_HARNESS_SUPPORTED_ENGINES = SUPPORTED_ENGINES;
