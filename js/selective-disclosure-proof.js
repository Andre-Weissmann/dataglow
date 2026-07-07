// ============================================================
// DATAGLOW — Selective-Disclosure Provenance Proof
// ("Prove Specific Claims Without Sharing the Dataset")
// ============================================================
// Extends the Verifiable Provenance Attestation system (js/provenance.js) with a
// cryptographic COMMITMENT + SELECTIVE DISCLOSURE scheme so a third party
// (auditor, partner org, hospital compliance office) can verify specific
// validation claims about a dataset WITHOUT ever receiving the underlying data.
//
// WHAT THIS ACTUALLY IS (precise statement of the cryptographic guarantee):
// This is a Merkle-tree commitment over a canonical set of validation claims,
// using SHA-256 (the same primitive js/provenance.js already uses), combined
// with per-claim Merkle-proof selective disclosure. What it proves:
//   • that the publisher committed to a fixed set of claims BEFORE sharing the
//     root (the root is a binding fingerprint of all claims), and
//   • that each disclosed claim is a genuine member of that committed set,
//     verifiable by anyone holding only the proof artifact — no dataset needed.
//
// WHAT THIS IS NOT (deliberately avoids a cryptographic overclaim):
//   • This is NOT a formal zero-knowledge proof system (not a zk-SNARK, zk-STARK,
//     or any succinct zero-knowledge construction). Do NOT describe it as
//     "zero-knowledge" or "ZK": the disclosed claims are revealed in cleartext.
//   • It does not hide the disclosed claims themselves; only the undisclosed
//     leaves and the raw data stay private. This is selective disclosure with
//     hash-verified membership, not zero knowledge.
//   • It does not prove the ORIGINAL raw data was correct or PHI-compliant, only
//     that DATAGLOW's checks ran and produced the committed pass/fail results
//     against a committed dataset fingerprint.
// The public technique used is a standard "Merkle tree + SHA-256 commitment with
// Merkle-proof selective disclosure" — a well-documented, general-purpose
// construction, not branded after any commercial product.
//
// Merkle construction details (kept explicit for independent re-verification):
//   • Leaves are domain-separated with a 0x00 prefix, internal nodes with 0x01,
//     the standard defence against second-preimage / leaf-vs-node confusion.
//   • An odd node at any level is promoted (hashed with itself) — the common
//     "duplicate last" rule. Recorded in each proof step so the verifier folds
//     identically without the tree.
//   • Everything is SHA-256 hex via crypto.subtle (browser + modern Node), so
//     no third-party crypto library is pulled in.

import { sha256Hex } from './provenance.js';

export const SD_PROOF_KIND = 'dataglow-selective-disclosure-proof';
export const SD_PROOF_VERSION = 1;

export const SD_PROOF_DISCLAIMER =
  'This is a Merkle-tree (SHA-256) cryptographic commitment with selective '
  + 'disclosure — it proves the disclosed validation claims belong to a fixed set '
  + 'committed to by the published root hash, verifiable by anyone with only this '
  + 'artifact and no access to the dataset. It is NOT a formal zero-knowledge '
  + 'proof (not a zk-SNARK/zk-STARK); the disclosed claims are shown in cleartext. '
  + 'It does NOT attest that the original raw data was correct '
  + 'or PHI/HIPAA-compliant — only that DATAGLOW’s checks ran and produced '
  + 'these results against the committed dataset fingerprint. Not a legal, '
  + 'clinical, or regulatory determination.';

// Deterministic JSON of a claim's identifying fields. The order here IS the
// commitment: the verifier recomputes the leaf hash from exactly these fields,
// so any change to a disclosed claim's value changes its leaf hash and breaks
// the Merkle path back to the root.
function canonicalClaim(claim) {
  return JSON.stringify({
    type: claim.type,
    subject: claim.subject ?? null,
    value: claim.value ?? null,
  });
}

// Domain-separated leaf / node hashes. The 'L:' / 'N:' prefixes are the string
// analogue of the 0x00 / 0x01 byte tags used in RFC 6962-style Merkle trees.
export function hashLeaf(claim) {
  return sha256Hex('L:' + canonicalClaim(claim));
}
function hashNode(left, right) {
  return sha256Hex('N:' + left + right);
}

// Build the full Merkle tree from an ordered list of leaf hashes. Returns the
// root plus every level (leaves first) so proof paths can be extracted. Odd
// nodes are promoted by hashing with themselves.
export async function buildMerkleTree(leafHashes) {
  if (!leafHashes.length) {
    const empty = await sha256Hex('L:empty');
    return { root: empty, levels: [[empty]] };
  }
  const levels = [leafHashes.slice()];
  let level = leafHashes.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(await hashNode(left, right));
    }
    levels.push(next);
    level = next;
  }
  return { root: level[0], levels };
}

// The audit path for a leaf: the sibling hash at each level plus its side, which
// is all the verifier needs to fold the leaf back up to the root.
export function merkleProof(tree, leafIndex) {
  const path = [];
  let idx = leafIndex;
  for (let l = 0; l < tree.levels.length - 1; l++) {
    const level = tree.levels[l];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    // Odd node promoted with itself: its sibling is a copy of itself.
    const sibling = siblingIdx < level.length ? level[siblingIdx] : level[idx];
    path.push({ hash: sibling, position: isRight ? 'left' : 'right' });
    idx = Math.floor(idx / 2);
  }
  return path;
}

// Fold a leaf hash up through its proof path and return the resulting root. Pure
// and dependency-free (only sha256Hex) so an independent verifier needs nothing
// but the artifact.
export async function rootFromProof(leafHash, path) {
  let acc = leafHash;
  for (const step of path) {
    acc = step.position === 'left'
      ? await hashNode(step.hash, acc)
      : await hashNode(acc, step.hash);
  }
  return acc;
}

// ------------------------------------------------------------
// Claim extraction — the "provable" subset (spec §2)
// ------------------------------------------------------------
// From the existing Confidence-Calibrated Grades + validation-layer results +
// record count, derive a stable, ordered set of claims. Ordering is fixed
// (record count, then the two grade axes, then layers alphabetically) so the
// same inputs always produce the same tree and root.
const STATUS_SET = new Set(['pass', 'warn', 'fail', 'idle']);

export function buildClaims({ recordCount = null, grades = null, results = {} } = {}) {
  const claims = [];

  if (recordCount != null) {
    claims.push({
      type: 'record_count',
      subject: null,
      value: recordCount,
      statement: `Dataset contained exactly ${Number(recordCount).toLocaleString()} record(s).`,
    });
  }

  if (grades) {
    if (grades.integrity && grades.integrity.grade) {
      claims.push({
        type: 'grade',
        subject: 'integrity',
        value: grades.integrity.grade,
        statement: `Data Integrity grade was "${grades.integrity.grade}".`,
      });
    }
    if (grades.plausibility && grades.plausibility.grade) {
      claims.push({
        type: 'grade',
        subject: 'plausibility',
        value: grades.plausibility.grade,
        statement: `Domain Plausibility Confidence grade was "${grades.plausibility.grade}".`,
      });
    }
  }

  const layerIds = Object.keys(results)
    .filter(id => results[id] && typeof results[id] === 'object' && STATUS_SET.has(results[id].status))
    .sort();
  for (const id of layerIds) {
    const status = results[id].status;
    claims.push({
      type: 'layer_status',
      subject: id,
      value: status,
      statement: `Validation layer "${id}" resulted in status "${status}".`,
    });
  }

  // Also commit to the pass/fail HEADLINE: how many layers passed. Lets a
  // verifier confirm "N layers passed" without disclosing which.
  const considered = layerIds.filter(id => results[id].status !== 'idle');
  const passed = considered.filter(id => results[id].status === 'pass').length;
  if (considered.length) {
    claims.push({
      type: 'layers_passed',
      subject: null,
      value: `${passed}/${considered.length}`,
      statement: `${passed} of ${considered.length} run validation layer(s) passed.`,
    });
  }

  return claims;
}

// ------------------------------------------------------------
// Proof-artifact generation
// ------------------------------------------------------------
// Commit to ALL claims (that is the binding fingerprint) but only DISCLOSE the
// selected subset. `disclose` is a predicate over a claim, or null for "all".
export async function generateProof({
  recordCount = null, grades = null, results = {},
  disclose = null, dataglow = {}, attestationRef = null, generatedAt = null,
} = {}) {
  const claims = buildClaims({ recordCount, grades, results });
  const leafHashes = await Promise.all(claims.map(hashLeaf));
  const tree = await buildMerkleTree(leafHashes);

  const chosen = claims
    .map((claim, index) => ({ claim, index }))
    .filter(({ claim }) => (disclose ? disclose(claim) : true));

  const disclosedClaims = chosen.map(({ claim, index }) => ({
    index,
    type: claim.type,
    subject: claim.subject ?? null,
    value: claim.value ?? null,
    statement: claim.statement,
    proof: merkleProof(tree, index),
  }));

  return {
    kind: SD_PROOF_KIND,
    version: SD_PROOF_VERSION,
    generatedAt: generatedAt != null ? new Date(generatedAt).toISOString() : new Date().toISOString(),
    algorithm: 'Merkle tree (SHA-256, domain-separated leaves 0x00 / nodes 0x01) commitment with Merkle-proof selective disclosure',
    dataglow: {
      version: dataglow.version ?? null,
      build: dataglow.build ?? null,
      note: 'The verifier does not trust this field; it only recomputes hashes.',
    },
    // Link back to the existing Provenance Attestation so this proof is anchored
    // to the same chain of custody (spec: build on top of, not replace).
    attestationRef: attestationRef
      ? { digest: attestationRef.digest ?? null, finalHash: attestationRef.finalHash ?? null }
      : null,
    commitment: {
      merkleRoot: tree.root,
      leafCount: claims.length,
      leafHash: 'SHA-256 of "L:" + canonicalClaim(type,subject,value)',
      nodeHash: 'SHA-256 of "N:" + leftHex + rightHex',
    },
    disclosedClaims,
    disclaimer: SD_PROOF_DISCLAIMER,
  };
}

// ------------------------------------------------------------
// Independent verifier (spec §4)
// ------------------------------------------------------------
// Takes ONLY the proof artifact. Re-derives each disclosed claim's leaf hash
// from its committed fields, folds it up the recorded proof path, and checks the
// result equals the published root. Never references the original dataset — that
// is the entire point. Returns per-claim results plus an overall verdict.
export async function verifyProof(artifact) {
  if (!artifact || artifact.kind !== SD_PROOF_KIND) {
    return { valid: false, reason: 'Not a DATAGLOW selective-disclosure provenance proof (missing/incorrect "kind").', root: null, claims: [] };
  }
  const root = artifact.commitment && artifact.commitment.merkleRoot;
  if (!root) {
    return { valid: false, reason: 'Proof artifact has no committed Merkle root.', root: null, claims: [] };
  }
  const disclosed = Array.isArray(artifact.disclosedClaims) ? artifact.disclosedClaims : [];
  if (!disclosed.length) {
    return { valid: false, reason: 'Proof artifact discloses no claims to verify.', root, claims: [] };
  }

  const claimResults = [];
  for (const d of disclosed) {
    const leaf = await hashLeaf({ type: d.type, subject: d.subject ?? null, value: d.value ?? null });
    const path = Array.isArray(d.proof) ? d.proof : [];
    const derivedRoot = await rootFromProof(leaf, path);
    const valid = derivedRoot === root;
    claimResults.push({
      index: d.index,
      statement: d.statement,
      value: d.value ?? null,
      valid,
      derivedRoot,
      reason: valid
        ? 'Claim is a verified member of the committed set.'
        : 'Claim does NOT belong to the committed set — value was altered or its proof path is inconsistent with the root.',
    });
  }

  const allValid = claimResults.every(c => c.valid);
  return {
    valid: allValid,
    reason: allValid
      ? `All ${claimResults.length} disclosed claim(s) verified against the committed Merkle root. (Integrity/membership check only — not a legal, clinical, or regulatory determination.)`
      : `${claimResults.filter(c => !c.valid).length} of ${claimResults.length} disclosed claim(s) FAILED verification — the proof was tampered with or is inconsistent.`,
    root,
    claims: claimResults,
  };
}
