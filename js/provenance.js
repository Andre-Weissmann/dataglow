// ============================================================
// DATAGLOW — Data Provenance Trail (Chain of Custody)
// ============================================================
// A tamper-evident, hash-chained record of every transformation from raw
// file load to final query/chart. This is the cryptographic sibling of the
// Assumption Ledger: the Ledger is the human-readable list of judgment calls,
// this is the machine-verifiable proof that the recorded timeline was not
// altered after the fact — the HIPAA/audit "chain of custody".
//
// Standard hash-chaining (the same construction underlying a Merkle/blockchain
// linked hash list): each step's hash folds in its parent's hash, so mutating
// any earlier step invalidates every hash after it. SHA-256 via the built-in
// Web Crypto API (crypto.subtle) — available in both the browser and modern
// Node, so no external crypto library is pulled in.

// Canonical serialization of the fields that a step's hash commits to. Kept
// stable and explicit so re-verification is reproducible.
function stepPayload(parentHash, step) {
  return JSON.stringify({
    index: step.index,
    parentHash,
    op: step.op,
    description: step.description,
    detail: step.detail ?? null,
    ts: step.ts,
  });
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Hash of the raw bytes of a loaded file (ArrayBuffer / Uint8Array). Anchors
// the chain to the exact input the analyst started from.
export async function hashBytes(bytes) {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const buf = await crypto.subtle.digest('SHA-256', view);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// A provenance chain for a single dataset. Each entry:
//   { index, op, description, detail, ts, parentHash, hash }
// The genesis entry's parentHash is the all-zero string.
export function createProvenanceChain() {
  const GENESIS_PARENT = '0'.repeat(64);
  const chain = [];

  async function append(op, description, detail = null, contentHash = null) {
    const parentHash = chain.length ? chain[chain.length - 1].hash : GENESIS_PARENT;
    const step = {
      index: chain.length,
      op,
      description,
      detail,
      // contentHash lets a step also commit to a data snapshot (e.g. the raw
      // file bytes on load); folded into the chained hash below.
      contentHash: contentHash ?? null,
      ts: Date.now(),
    };
    const hash = await sha256Hex(stepPayload(parentHash, step) + (step.contentHash || ''));
    const entry = { ...step, parentHash, hash };
    chain.push(entry);
    return entry;
  }

  // Recompute the whole chain and report whether it is intact. Returns the
  // index of the first broken link (or -1 if valid) plus a human summary.
  async function verify() {
    let parentHash = GENESIS_PARENT;
    for (let i = 0; i < chain.length; i++) {
      const e = chain[i];
      if (e.parentHash !== parentHash) {
        return { valid: false, brokenAt: i, reason: `Step ${i} ("${e.description}") does not link to the previous step's hash — the chain was re-ordered or an earlier step was altered.` };
      }
      const expected = await sha256Hex(stepPayload(parentHash, e) + (e.contentHash || ''));
      if (expected !== e.hash) {
        return { valid: false, brokenAt: i, reason: `Step ${i} ("${e.description}") has been modified since it was recorded — its contents no longer match its hash.` };
      }
      parentHash = e.hash;
    }
    return { valid: true, brokenAt: -1, reason: `All ${chain.length} step(s) verified — the provenance chain is intact.` };
  }

  function getTrail() {
    return chain.map(e => ({ ...e }));
  }

  function exportTrail(format = 'json') {
    if (format === 'json') {
      return JSON.stringify({
        generatedAt: new Date().toISOString(),
        algorithm: 'SHA-256 hash chain (Merkle-style linked hashes)',
        steps: chain,
      }, null, 2);
    }
    // plain text timeline
    const lines = ['DATAGLOW Data Provenance Trail (Chain of Custody)', `Exported ${new Date().toISOString()}`, ''];
    for (const e of chain) {
      lines.push(`#${e.index} [${new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19)}] ${e.op}: ${e.description}`);
      lines.push(`     hash=${e.hash.slice(0, 16)}… parent=${e.parentHash.slice(0, 16)}…`);
    }
    return lines.join('\n');
  }

  return { append, verify, getTrail, exportTrail, get length() { return chain.length; } };
}

// ---- App-level singleton registry, keyed by dataset table name ----
// Each loaded dataset gets its own chain of custody. Kept module-local so the
// browser app shares one registry; tests create their own chains directly.
const chains = new Map();

export function startProvenance(tableName) {
  const chain = createProvenanceChain();
  chains.set(tableName, chain);
  return chain;
}

export function getProvenance(tableName) {
  return chains.get(tableName) || null;
}

// Convenience: record a step against a dataset's chain if one exists. Silently
// no-ops if the dataset was never registered (e.g. transformations before load).
export async function recordStep(tableName, op, description, detail = null) {
  const chain = chains.get(tableName);
  if (!chain) return null;
  return chain.append(op, description, detail);
}
