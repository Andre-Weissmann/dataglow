// ============================================================
// DATAGLOW — Verifiable Check Seal ("Proof-of-Clean")
// (Trust Passport, Batch 3 — Verifiable Local Computation)
// ============================================================
// Seals the result of a validation check — e.g. a Local Analysis Contract run
// (js/validation/analysis-contract.js) or any validation-layer result set —
// into a portable artifact that lets a third party (auditor, partner org,
// reviewer) confirm "a check with these exact parameters ran against data
// matching this exact fingerprint and produced this exact result" WITHOUT ever
// receiving the underlying data.
//
// This module does NOT invent a new cryptographic scheme. It APPLIES the
// Merkle-tree (SHA-256) commitment primitive that
// js/provenance/selective-disclosure-proof.js already implements — the same
// hashLeaf / buildMerkleTree / merkleProof / rootFromProof helpers, folding the
// same SHA-256 primitive (sha256Hex) the rest of js/provenance/ uses. No new
// crypto library is added.
//
// WHAT THIS ACTUALLY IS (precise statement, no overclaim):
// A Merkle-tree commitment over a fixed set of claims describing (a) which
// check ran and with which parameters, (b) a SHA-256 fingerprint of the data it
// ran against, and (c) the result it produced. The raw data is NEVER in the
// artifact — only its fingerprint. A verifier can:
//   • re-derive every disclosed claim's leaf hash and fold it back to the
//     committed root, so ANY change to a sealed value breaks the seal
//     (membership/integrity check — needs only the artifact, no data); and
//   • OPTIONALLY re-fingerprint the data they hold and compare it to the
//     committed data fingerprint, so data that has been modified since sealing
//     fails to match (genuine tamper detection, not a "verified" label).
//
// WHAT THIS IS NOT (deliberately avoids a cryptographic overclaim — matches the
// exact honesty register js/provenance/selective-disclosure-proof.js set):
//   • This is NOT a zero-knowledge proof / zk-SNARK / zk-STARK. The check
//     parameters, the result, and the fingerprints are all shown in cleartext;
//     only the raw data rows stay private. Do NOT call it "zero-knowledge".
//   • It is NOT "blockchain", NOT a "certification", and it is never "certified"
//     nor "cryptographically certified" — it is a hash commitment with a
//     re-checkable data fingerprint, nothing more.
//   • It proves the check RAN against data matching a fingerprint and produced a
//     result. It does NOT prove the data itself is accurate, truthful, complete,
//     or fit for any purpose, and it is not a legal, clinical, or regulatory
//     determination.
//   • The data fingerprint binds to the EXACT canonical serialization it was
//     computed over (see fingerprintData). It detects byte-level change of that
//     serialization; it says nothing about semantically-equivalent re-orderings
//     unless the caller canonicalizes (e.g. sorts) first. If a caller
//     fingerprints only a sample or the schema rather than every row, the seal
//     binds only to what was fingerprinted — state that plainly wherever surfaced.
//
// PURITY: pure logic — no DOM, no engine, no network. It takes plain objects the
// caller already holds and returns plain JSON-serializable objects, so it is
// identical in the browser, the Tauri desktop webview, and headless Node tests.

import { sha256Hex } from './provenance.js';
import {
  hashLeaf,
  buildMerkleTree,
  merkleProof,
  rootFromProof,
} from './selective-disclosure-proof.js';

export const CHECK_SEAL_KIND = 'dataglow-verifiable-check-seal';
export const CHECK_SEAL_VERSION = 1;

export const CHECK_SEAL_ALGORITHM =
  'Merkle tree (SHA-256, domain-separated leaves 0x00 / nodes 0x01) commitment '
  + 'over check-parameter, data-fingerprint, and result claims, reusing '
  + 'js/provenance/selective-disclosure-proof.js';

export const CHECK_SEAL_FINGERPRINT_ALGORITHM =
  'SHA-256 hex over the canonical JSON of the data (object keys sorted '
  + 'recursively); a string input is hashed as-is. Recompute with fingerprintData().';

export const CHECK_SEAL_DISCLAIMER =
  'This is a Verifiable Check Seal: a Merkle-tree (SHA-256) commitment that a '
  + 'specific DATAGLOW check ran, with the stated parameters, against data '
  + 'matching the committed SHA-256 fingerprint, and produced the committed '
  + 'result — re-checkable by anyone holding only this artifact, with no access '
  + 'to the data. It is NOT a zero-knowledge proof (the parameters, result, and '
  + 'fingerprints are shown in cleartext), NOT a certification, and NOT '
  + '"blockchain". It does NOT attest that the underlying data is accurate, '
  + 'truthful, or complete — only that the check ran against data matching the '
  + 'fingerprint and produced this result. The fingerprint binds to the exact '
  + 'serialization it was computed over. Not a legal, clinical, or regulatory '
  + 'determination.';

// ------------------------------------------------------------
// Data fingerprinting
// ------------------------------------------------------------
// Deterministic canonical JSON: object keys sorted recursively so the same
// logical value always serializes to the same string (and therefore the same
// hash). Arrays keep their order — row order IS part of the fingerprint, so a
// caller who wants order-independence must sort before fingerprinting. Kept
// tiny and dependency-free so a third-party verifier can re-implement it.
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

// SHA-256 hex fingerprint of the data the check ran against. Accepts a string
// (hashed as-is) or any JSON-serializable value (canonicalized first). This is
// the ONLY thing about the raw data that ever enters a seal.
export async function fingerprintData(data) {
  const str = typeof data === 'string' ? data : canonicalJSON(data ?? null);
  return sha256Hex(str);
}

// ------------------------------------------------------------
// Claim construction
// ------------------------------------------------------------
// Turn a check result + context into a fixed, deterministically-ordered set of
// claims. Order is fixed so the same inputs always build the same tree/root.
// Every claim carries a human-readable `statement` (not part of the leaf hash —
// same convention as selective-disclosure-proof.js) plus the {type,subject,value}
// triple that IS hashed into the leaf.
async function buildCheckSealClaims(result, context, dataFingerprint) {
  const check = context.check || {};
  const dataset = context.dataset || {};
  const status = result && typeof result.status === 'string' ? result.status : 'unknown';
  const flagCount = Number.isFinite(result && result.flagCount) ? result.flagCount : null;

  // Fingerprint of the check's parameters (e.g. the SQL query text + check kind)
  // so the params are committed even if a caller would rather not disclose the
  // full query text in cleartext.
  const paramsFingerprint = await sha256Hex(canonicalJSON({
    kind: check.kind ?? null,
    name: check.name ?? null,
    params: context.params ?? null,
  }));
  // Fingerprint of the FULL result object, so the exact result (including every
  // flag) is bound, not just the headline status/flagCount.
  const resultFingerprint = await sha256Hex(canonicalJSON(result ?? null));
  const columnNames = Array.isArray(dataset.columnNames) ? dataset.columnNames.slice() : [];
  const columnsFingerprint = await sha256Hex(canonicalJSON(columnNames.slice().sort()));

  const claims = [
    {
      type: 'check_name', subject: null, value: check.name || check.kind || 'validation check',
      statement: `Check "${check.name || check.kind || 'validation check'}" was run.`,
    },
    {
      type: 'check_kind', subject: null, value: check.kind ?? null,
      statement: `Check kind was "${check.kind ?? 'unspecified'}".`,
    },
    {
      type: 'check_params_fingerprint', subject: null, value: paramsFingerprint,
      statement: `Check parameters had SHA-256 fingerprint ${paramsFingerprint.slice(0, 16)}….`,
    },
    {
      type: 'data_fingerprint', subject: null, value: dataFingerprint,
      statement: `Data ran against had SHA-256 fingerprint ${dataFingerprint.slice(0, 16)}….`,
    },
    {
      type: 'dataset_identity', subject: null,
      value: `${dataset.name || 'dataset'}|${Number.isFinite(dataset.rowCount) ? dataset.rowCount : 'n/a'}x${columnNames.length}`,
      statement: `Dataset "${dataset.name || 'dataset'}" had `
        + `${Number.isFinite(dataset.rowCount) ? dataset.rowCount.toLocaleString() : 'an unrecorded number of'} row(s) `
        + `and ${columnNames.length} named column(s).`,
    },
    {
      type: 'dataset_columns_fingerprint', subject: null, value: columnsFingerprint,
      statement: `Sorted column names had SHA-256 fingerprint ${columnsFingerprint.slice(0, 16)}….`,
    },
    {
      type: 'result_status', subject: null, value: status,
      statement: `Check produced status "${status}".`,
    },
    {
      type: 'result_flag_count', subject: null, value: flagCount,
      statement: flagCount == null
        ? 'Check did not report a flag count.'
        : `Check produced ${flagCount} flag(s).`,
    },
    {
      type: 'result_fingerprint', subject: null, value: resultFingerprint,
      statement: `Full result had SHA-256 fingerprint ${resultFingerprint.slice(0, 16)}….`,
    },
  ];

  return { claims, paramsFingerprint, resultFingerprint, columnsFingerprint };
}

// ------------------------------------------------------------
// Seal generation
// ------------------------------------------------------------
/**
 * Seal a validation check result into a portable, re-verifiable artifact.
 * ALWAYS an explicit caller action — this module never seals anything on its own.
 *
 * @param {object} result  A validation result, e.g. runAnalysisContract()'s
 *   `{status, flagCount, flags, ts}`, or any object with a `status`.
 * @param {object} context
 * @param {object} [context.check]    { name, kind } describing the check.
 * @param {*}      [context.params]   Check parameters to commit (e.g. the SQL text).
 * @param {object} [context.dataset]  { name, rowCount, columnNames } identity of the data.
 * @param {*}      [context.data]     The data itself (string or JSON-able) to fingerprint.
 * @param {string} [context.dataFingerprint]  A precomputed fingerprint (use when the
 *   data is too large to pass in full, e.g. computed once over a DuckDB table). If
 *   both `data` and `dataFingerprint` are given, `dataFingerprint` wins and a note
 *   records that it was caller-supplied.
 * @param {string} [context.labelAnchor]  A Data Nutrition Label custodyChain.finalHash
 *   to anchor this seal to (batch 2 shape). Optional.
 * @param {object} [context.dataglow]  { version, build } provenance of the tool.
 * @param {number|Date} [context.generatedAt]  Override generation timestamp (tests).
 * @returns {Promise<object>} A JSON-serializable seal artifact.
 */
export async function sealCheckResult(result, context = {}) {
  const fingerprintSource = context.dataFingerprint != null
    ? 'caller-supplied'
    : (context.data !== undefined ? 'computed-from-data' : 'absent');
  const dataFingerprint = context.dataFingerprint != null
    ? String(context.dataFingerprint)
    : (context.data !== undefined ? await fingerprintData(context.data) : null);

  if (dataFingerprint == null) {
    // Refuse to mint a seal with nothing binding it to any data — a seal with no
    // data fingerprint could "verify" against anything, which is exactly the
    // empty-guarantee this module exists to avoid.
    throw new Error(
      'sealCheckResult: a data fingerprint is required. Pass context.data (to '
      + 'fingerprint here) or context.dataFingerprint (precomputed). Refusing to '
      + 'mint a seal that binds to no data.');
  }

  const { claims, paramsFingerprint, resultFingerprint, columnsFingerprint } =
    await buildCheckSealClaims(result, context, dataFingerprint);

  const leafHashes = await Promise.all(claims.map(hashLeaf));
  const tree = await buildMerkleTree(leafHashes);

  // A seal DISCLOSES every claim (full transparency of the check itself); only
  // the raw data stays private, represented by data_fingerprint. Each disclosed
  // claim carries its Merkle path so a verifier folds it back to the root.
  const disclosedClaims = claims.map((claim, index) => ({
    index,
    type: claim.type,
    subject: claim.subject ?? null,
    value: claim.value ?? null,
    statement: claim.statement,
    proof: merkleProof(tree, index),
  }));

  const check = context.check || {};
  const dataglow = context.dataglow || {};

  return {
    kind: CHECK_SEAL_KIND,
    version: CHECK_SEAL_VERSION,
    generatedAt: context.generatedAt != null
      ? new Date(context.generatedAt).toISOString()
      : new Date().toISOString(),
    algorithm: CHECK_SEAL_ALGORITHM,
    fingerprintAlgorithm: CHECK_SEAL_FINGERPRINT_ALGORITHM,
    check: { name: check.name ?? null, kind: check.kind ?? null },
    result: {
      status: result && typeof result.status === 'string' ? result.status : 'unknown',
      flagCount: Number.isFinite(result && result.flagCount) ? result.flagCount : null,
    },
    dataglow: {
      version: dataglow.version ?? null,
      build: dataglow.build ?? null,
      note: 'The verifier does not trust this field; it only recomputes hashes.',
    },
    // The finalHash of a Data Nutrition Label's custodyChain (batch 2), if the
    // caller anchored this seal to one. The verifier does not require it.
    labelAnchor: context.labelAnchor ?? null,
    fingerprints: {
      data: dataFingerprint,
      dataSource: fingerprintSource,
      params: paramsFingerprint,
      result: resultFingerprint,
      columns: columnsFingerprint,
    },
    commitment: {
      merkleRoot: tree.root,
      leafCount: claims.length,
      leafHash: 'SHA-256 of "L:" + canonicalClaim(type,subject,value)',
      nodeHash: 'SHA-256 of "N:" + leftHex + rightHex',
    },
    disclosedClaims,
    disclaimer: CHECK_SEAL_DISCLAIMER,
  };
}

// ------------------------------------------------------------
// Seal verification
// ------------------------------------------------------------
/**
 * Verify a seal. Two independent, genuinely-checkable layers:
 *   1. COMMITMENT: re-derive each disclosed claim's leaf hash and fold it up its
 *      recorded Merkle path; every claim must reach the committed root. Any
 *      altered claim value or inconsistent path fails. Needs ONLY the artifact.
 *   2. DATA MATCH (optional): if `data` (or a precomputed fingerprint) is given,
 *      re-fingerprint it and compare to the committed data_fingerprint claim.
 *      Data modified since sealing fails to match. If no data is given this layer
 *      is reported as `null` (not checked) — never silently "passed".
 *
 * @param {object} seal  A seal from sealCheckResult.
 * @param {*} [data]  The data to re-fingerprint (string or JSON-able), OR an
 *   object { dataFingerprint } with a precomputed fingerprint. Omit to skip layer 2.
 * @returns {Promise<object>} { valid, reason, root, commitmentValid, dataMatch, claims }
 */
export async function verifySeal(seal, data) {
  if (!seal || seal.kind !== CHECK_SEAL_KIND) {
    return {
      valid: false,
      reason: 'Not a DATAGLOW verifiable check seal (missing/incorrect "kind").',
      root: null, commitmentValid: false, dataMatch: null, claims: [],
    };
  }
  const root = seal.commitment && seal.commitment.merkleRoot;
  if (!root) {
    return {
      valid: false, reason: 'Seal has no committed Merkle root.',
      root: null, commitmentValid: false, dataMatch: null, claims: [],
    };
  }
  const disclosed = Array.isArray(seal.disclosedClaims) ? seal.disclosedClaims : [];
  if (!disclosed.length) {
    return {
      valid: false, reason: 'Seal discloses no claims to verify.',
      root, commitmentValid: false, dataMatch: null, claims: [],
    };
  }

  // Layer 1 — commitment / membership.
  const claimResults = [];
  for (const d of disclosed) {
    const leaf = await hashLeaf({ type: d.type, subject: d.subject ?? null, value: d.value ?? null });
    const path = Array.isArray(d.proof) ? d.proof : [];
    const derivedRoot = await rootFromProof(leaf, path);
    const ok = derivedRoot === root;
    claimResults.push({
      index: d.index,
      type: d.type,
      statement: d.statement,
      value: d.value ?? null,
      valid: ok,
      reason: ok
        ? 'Claim is a verified member of the committed set.'
        : 'Claim does NOT belong to the committed set — a sealed value was altered or its proof path is inconsistent with the root.',
    });
  }
  const commitmentValid = claimResults.every(c => c.valid);

  // Layer 2 — data match (optional). Find the committed data fingerprint.
  const committedFp = (() => {
    const c = disclosed.find(d => d.type === 'data_fingerprint');
    return c ? c.value : (seal.fingerprints && seal.fingerprints.data) || null;
  })();

  let dataMatch = null;
  let dataReason = 'Data match NOT checked (no data supplied) — commitment/integrity only.';
  if (data !== undefined) {
    let recomputed;
    if (data && typeof data === 'object' && typeof data.dataFingerprint === 'string' && !Array.isArray(data)) {
      recomputed = data.dataFingerprint;
    } else {
      recomputed = await fingerprintData(data);
    }
    dataMatch = recomputed === committedFp;
    dataReason = dataMatch
      ? 'Supplied data re-fingerprints to the committed value — it matches the sealed data.'
      : 'Supplied data does NOT re-fingerprint to the committed value — the data was modified since sealing (or is different data).';
  }

  const valid = commitmentValid && dataMatch !== false;
  let reason;
  if (!commitmentValid) {
    reason = `${claimResults.filter(c => !c.valid).length} of ${claimResults.length} sealed claim(s) FAILED the commitment check — the seal was tampered with.`;
  } else if (dataMatch === false) {
    reason = 'Seal commitment is intact, but the supplied data does NOT match the sealed fingerprint — the data was modified. '
      + '(Integrity check only — not a legal, clinical, or regulatory determination.)';
  } else if (dataMatch === true) {
    reason = `All ${claimResults.length} sealed claim(s) verified against the committed root AND the supplied data matches the sealed fingerprint. `
      + '(Integrity/membership check only — not a legal, clinical, or regulatory determination.)';
  } else {
    reason = `All ${claimResults.length} sealed claim(s) verified against the committed root. `
      + dataReason
      + ' (Integrity/membership check only — not a legal, clinical, or regulatory determination.)';
  }

  return { valid, reason, root, commitmentValid, dataMatch, claims: claimResults };
}

// ------------------------------------------------------------
// Integration with the Data Nutrition Label (batch 2)
// ------------------------------------------------------------
/**
 * Attach a seal to a Data Nutrition Label's custodyChain. ADDITIVE and
 * non-mutating: returns a NEW label with the seal appended to a
 * `custodyChain.seals` array (created if absent). No existing batch-2 field is
 * changed — `algorithm`, `length`, `finalHash`, and `steps` are all preserved
 * exactly, so a reader that predates this batch sees an unchanged manifest plus
 * one new array it can ignore.
 *
 * If the seal was not already anchored, its `labelAnchor` is set to this label's
 * custodyChain.finalHash so a reader can tie the two together.
 *
 * @param {object} label  A Data Nutrition Label (buildDataNutritionLabel output).
 * @param {object} seal   A seal from sealCheckResult.
 * @returns {object} A new label object with the seal attached.
 */
export function attachSealToLabel(label, seal) {
  if (!label || typeof label !== 'object') {
    throw new Error('attachSealToLabel: label must be an object.');
  }
  if (!seal || seal.kind !== CHECK_SEAL_KIND) {
    throw new Error('attachSealToLabel: second argument must be a verifiable check seal.');
  }
  const existingChain = label.custodyChain || {};
  const finalHash = existingChain.finalHash ?? null;
  const anchoredSeal = seal.labelAnchor == null && finalHash != null
    ? { ...seal, labelAnchor: finalHash }
    : seal;
  const existingSeals = Array.isArray(existingChain.seals) ? existingChain.seals : [];
  return {
    ...label,
    custodyChain: {
      ...existingChain,
      seals: [...existingSeals, anchoredSeal],
    },
  };
}

// ------------------------------------------------------------
// Human-readable summary (sibling to renderLabelSummaryLines)
// ------------------------------------------------------------
/**
 * Render a seal as plain-text lines for a compact UI panel or an export.
 * @param {object} seal
 * @returns {string[]}
 */
export function renderSealSummaryLines(seal) {
  if (!seal || seal.kind !== CHECK_SEAL_KIND) return ['Verifiable Check Seal: (not available).'];
  const root = (seal.commitment && seal.commitment.merkleRoot) || '';
  const lines = [];
  lines.push('Verifiable Check Seal');
  lines.push('  (Commitment + data-fingerprint check — not a certification, not zero-knowledge.)');
  lines.push(`  Generated: ${seal.generatedAt}`);
  lines.push(`  Check: ${seal.check && seal.check.name ? seal.check.name : 'validation check'}`
    + (seal.check && seal.check.kind ? `  (kind: ${seal.check.kind})` : ''));
  lines.push(`  Result: status "${seal.result ? seal.result.status : 'unknown'}"`
    + (seal.result && seal.result.flagCount != null ? `, ${seal.result.flagCount} flag(s)` : ''));
  lines.push(`  Data fingerprint: ${seal.fingerprints ? String(seal.fingerprints.data).slice(0, 24) : '(none)'}…`
    + (seal.fingerprints && seal.fingerprints.dataSource ? `  (${seal.fingerprints.dataSource})` : ''));
  lines.push(`  Committed Merkle root: ${String(root).slice(0, 24)}…`);
  if (seal.labelAnchor) lines.push(`  Anchored to label custody finalHash: ${String(seal.labelAnchor).slice(0, 16)}…`);
  lines.push(`  Sealed claims: ${Array.isArray(seal.disclosedClaims) ? seal.disclosedClaims.length : 0}`);
  return lines;
}

/**
 * Serialize a seal to pretty-printed JSON — the portable artifact a recipient
 * inspects or re-verifies. Round-trips losslessly via JSON.parse.
 * @param {object} seal
 * @returns {string}
 */
export function exportSealAsJSON(seal) {
  return JSON.stringify(seal, null, 2);
}
