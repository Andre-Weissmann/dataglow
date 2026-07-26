// ============================================================
// DATAGLOW - Proof Harness v0 (VERDICT): receipt ledger
// ============================================================
// WHY THIS EXISTS
// Doctrine invariant #5: "The RECEIPT ledger is the spine. If an action
// cannot be expressed as an append-only receipt, it is not a feature; it is a
// leak." This module is that spine for v0: an append-only, SHA-256
// hash-chained log of receipt records shaped like the MASTER PROMPT's
// in-toto/SLSA-flavored predicate (see MASTER_PROMPT_DataGlow_VERDICT_Proof_
// Harness_July_2026.md, "DATA MODEL"). It composes the SAME hash-chain
// discipline already shipped in js/provenance/trust-ledger.js
// (createTrustLedger/record/verify) rather than inventing a second scheme:
// canonical JSON over the fields the hash commits to, each entry carrying the
// previous entry's hash, GENESIS_PARENT for the first record.
//
// NEVER REWRITE. append() is the only mutator. There is no update/delete.
// "Corrections are new records referencing the old digest" (doctrine): a
// caller that needs to correct a prior receipt appends a NEW one whose
// predicate can reference the old record's digest; this module does not do
// that referencing for the caller, it only guarantees the old record itself
// can never be edited or removed.
//
// PURITY: no DOM, no network, no engine. crypto.subtle only (Node test-runner
// and every real browser both provide it), so this behaves identically
// everywhere, matching every other ledger in this codebase.

const RECEIPT_TYPE = 'dataglow/receipt/v1';

// Mirrors GENESIS_PARENT in js/provenance/trust-ledger.js and provenance.js so
// every hash-chained ledger in this codebase anchors identically.
export const GENESIS_PARENT = '0'.repeat(64);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** SHA-256 of a string, lowercase hex. Same algorithm as trust-ledger.js. */
export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Deterministic serialization of exactly the fields a receipt's hash commits
// to: the full predicate content plus the chain link (prevHash). Sorted keys
// throughout so the same content always hashes identically.
function canonicalReceiptPayload(prevHash, predicate) {
  return JSON.stringify({ predicate: sortDeep(predicate), prevHash });
}

// Recursively sort object keys so JSON.stringify output is canonical
// regardless of insertion order, matching stableDetail()'s intent in
// trust-ledger.js but applied to the whole predicate tree (the receipt
// predicate is deeper/nested, unlike a trust event's flat detail map).
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * Build the predicate body (everything under receipt.predicate) from the
 * pieces a Prove cycle produces. Fields not supplied default to v0-appropriate
 * empty/null values so the shape always matches the MASTER PROMPT's DATA
 * MODEL even when v1-only sections (corroboration, invariants, adversarial)
 * are not populated yet.
 * @param {object} parts
 */
export function buildReceiptPredicate(parts) {
  const p = isPlainObject(parts) ? parts : {};
  return {
    claim: isPlainObject(p.claim) ? p.claim : { text: null, predicate_ast: null, metric_ids: [] },
    proposal: isPlainObject(p.proposal) ? p.proposal : null,
    inputs: Array.isArray(p.inputs) ? p.inputs : [],
    run: isPlainObject(p.run) ? p.run : { status: null, rowcount: null, scalars: {}, column_types: {}, duration_ms: null, error: null },
    corroboration: isPlainObject(p.corroboration) ? p.corroboration : null,
    invariants: Array.isArray(p.invariants) ? p.invariants : [],
    adversarial: Array.isArray(p.adversarial) ? p.adversarial : [],
    environment: isPlainObject(p.environment) ? p.environment : {},
    verdict: isPlainObject(p.verdict) ? p.verdict : { state: null, reason_code: null, blocker: null },
    confirm: isPlainObject(p.confirm) ? p.confirm : null,
  };
}

/**
 * An append-only, hash-chained receipt ledger. Plain data and closures, same
 * shape as createTrustLedger() in js/provenance/trust-ledger.js. NEVER
 * rewrites or removes a record: append() is the only mutator exposed.
 */
export function createReceiptLedger() {
  const chain = [];

  /**
   * Append one receipt record. Never throws: a malformed predicate still
   * produces a record (defaults fill the gaps via buildReceiptPredicate), so
   * appending itself cannot fail and break the chain's monotonic index.
   * @param {{subjectName?:string, subjectDigest?:string, predicate:object}} input
   */
  async function append(input) {
    const inp = isPlainObject(input) ? input : {};
    const predicate = buildReceiptPredicate(inp.predicate);
    const prevHash = chain.length ? chain[chain.length - 1].hash : GENESIS_PARENT;
    const record = {
      _type: RECEIPT_TYPE,
      subject: [{
        name: typeof inp.subjectName === 'string' && inp.subjectName.trim() ? inp.subjectName.trim() : `claim-${chain.length}`,
        digest: { sha256: typeof inp.subjectDigest === 'string' ? inp.subjectDigest.replace(/^sha256:/, '') : null },
      }],
      predicate,
    };
    const index = chain.length;
    const hash = await sha256Hex(canonicalReceiptPayload(prevHash, predicate));
    const entry = { index, prevHash, hash, ts: Date.now(), record };
    chain.push(entry);
    return entry;
  }

  return {
    append,
    getEntries: () => chain.slice(),
    get size() { return chain.length; },
    // Deliberately NO update/remove/clear-by-index. clear() exists only for
    // starting a brand new session ledger (tests / explicit user "reset"),
    // never for editing history mid-chain.
    clear: () => { chain.length = 0; },
  };
}

/**
 * Re-derive every entry's hash from its recorded predicate + prevHash link and
 * confirm it still matches. Any edit, reorder, or deletion breaks the chain at
 * the first altered link. Mirrors verifyTrustLedger()'s discipline.
 * @param {Array<{index:number, prevHash:string, hash:string, record:object}>} entries
 */
export async function verifyReceiptChain(entries) {
  if (!Array.isArray(entries)) {
    return { valid: false, brokenAt: -1, reason: 'entries must be an array' };
  }
  if (entries.length === 0) {
    return { valid: true, brokenAt: -1, reason: 'No receipts recorded yet.' };
  }
  let prevHash = GENESIS_PARENT;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isPlainObject(e) || !isPlainObject(e.record) || !isPlainObject(e.record.predicate)) {
      return { valid: false, brokenAt: i, reason: `Record at index ${i} is missing or malformed.` };
    }
    if (e.prevHash !== prevHash) {
      return { valid: false, brokenAt: i, reason: `Record at index ${i} does not chain from the previous record's hash.` };
    }
    const expectedHash = await sha256Hex(canonicalReceiptPayload(prevHash, e.record.predicate));
    if (expectedHash !== e.hash) {
      return { valid: false, brokenAt: i, reason: `Record at index ${i} has been altered since it was written.` };
    }
    prevHash = e.hash;
  }
  return { valid: true, brokenAt: -1, reason: `All ${entries.length} receipt(s) verified intact.` };
}

export const RECEIPT_TYPE_ID = RECEIPT_TYPE;
