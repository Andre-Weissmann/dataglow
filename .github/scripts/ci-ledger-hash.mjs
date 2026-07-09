// ============================================================
// DATAGLOW — CI Provenance Ledger: shared hashing primitives
// ============================================================
// Zero-dependency helpers shared by the appender (.github/scripts/append-ci-ledger.mjs)
// and the offline verifier (.github/scripts/verify-ci-provenance.mjs). Keeping the
// canonical serialization + hashing in ONE place is what makes the chain verifiable:
// if the writer and the verifier disagreed on how an entry is serialized, every hash
// would mismatch. Node built-ins only (`node:crypto`) — no network, no npm deps.

import { createHash } from 'node:crypto';

// prev_hash of the very first entry: 64 zero hex chars (a fixed genesis anchor).
export const GENESIS_PREV_HASH = '0'.repeat(64);

// The fields that make up an entry's hashable content, in FIXED order. `entry_hash`
// is intentionally NOT in this list: it is the output of hashing these fields, so it
// cannot hash itself.
export const HASHED_FIELDS = ['commit', 'timestamp', 'test_conclusion', 'sbom_hash', 'prev_hash'];

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

// Deterministic serialization of an entry's hashable content: pick the hashed fields
// in their fixed order and JSON-stringify them. Reordering or extra keys on the input
// object cannot change the output, so a re-read line hashes identically to the original.
export function canonicalize(entry) {
  const ordered = {};
  for (const key of HASHED_FIELDS) ordered[key] = entry[key];
  return JSON.stringify(ordered);
}

export function computeEntryHash(entry) {
  return sha256(canonicalize(entry));
}
