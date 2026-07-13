// ============================================================
// DATAGLOW — Analysis Fingerprint
// ("This number came from this exact recorded computation")
// ============================================================
// A lightweight, tamper-evident SHA-256 fingerprint for a single computed
// result — a SQL result set, a chart's underlying data, an exported metric —
// so anyone can later confirm the artifact was produced by the exact
// computation it claims, and has not been altered since. It sits alongside the
// Verifiable Provenance Attestation (js/provenance/provenance.js, whole chain of
// custody) and the Selective-Disclosure Proof (js/provenance/selective-disclosure-proof.js,
// prove-claims-without-the-data): those cover the dataset's lineage and audited
// claims; this covers a single result at the point it is computed.
//
// WHAT THIS ACTUALLY IS (precise statement of the guarantee):
//   A content fingerprint: the SHA-256 hex digest of a canonical JSON payload
//   committing to the result data plus the inputs that produced it (the SQL /
//   pipeline description, the parameters, the metrics-registry version in force,
//   and the dataset's latest provenance-chain hash if one exists). Recomputing
//   the digest from the same inputs reproduces the value exactly; changing ANY
//   committed input — one cell of the result, one character of the SQL, one
//   parameter — changes the digest. That makes the record reproducible and
//   tamper-evident.
//
// WHAT THIS IS NOT (deliberately avoids a cryptographic overclaim):
//   • This is NOT a digital signature and NOT notarized. DATAGLOW has no
//     asymmetric-key / signing infrastructure and no trusted timestamp
//     authority, so this record proves INTEGRITY (the content matches its
//     digest), not AUTHORSHIP (who produced it) or EXISTENCE-AT-A-TIME (when).
//     Do NOT describe it as "signed", "notarized", or "certified".
//   • It is NOT a zero-knowledge proof: the committed inputs are hashed in
//     cleartext form inside the payload the digest covers.
//   • A matching digest proves the RESULT matches the RECORDED inputs; it does
//     not prove those inputs were themselves correct or that the SQL means what
//     the analyst intended.
// A plain, reproducible content hash is the honest, useful thing to ship here —
// so it ships as exactly that, with no signing/notarization claim attached.
//
// Everything is SHA-256 hex via crypto.subtle (browser + modern Node), reusing
// the identical primitive js/provenance/provenance.js already exports — no second
// hashing approach, no third-party crypto library, no zero-knowledge machinery.

import { sha256Hex } from './provenance.js';

export const FINGERPRINT_KIND = 'dataglow-analysis-fingerprint';
export const FINGERPRINT_VERSION = 1;

export const FINGERPRINT_DISCLAIMER =
  'This is a tamper-evident content fingerprint: the SHA-256 digest of a '
  + 'canonical record of a computed result and the inputs that produced it. '
  + 'Recomputing it from the same inputs reproduces the digest exactly, and any '
  + 'change to the result or its recorded inputs changes the digest. It is NOT a '
  + 'digital signature and NOT notarized — DATAGLOW has no signing key or trusted '
  + 'timestamp authority — so it proves integrity (the content matches its '
  + 'digest), not authorship or existence at a particular time. Not a legal, '
  + 'clinical, or regulatory determination.';

// Deterministic JSON of the fields the fingerprint commits to. The order and
// shape here ARE the commitment: verification recomputes the digest from exactly
// these fields, so any change to a committed input changes the digest. Missing
// optional inputs are normalised to null (not omitted) so an absent field and a
// null field fingerprint identically and reproducibly.
export function canonicalFingerprintPayload({
  resultData = null,
  sqlOrPipelineDescription = null,
  parameters = null,
  metricsRegistryVersion = null,
  datasetProvenanceHash = null,
} = {}) {
  return JSON.stringify({
    kind: FINGERPRINT_KIND,
    version: FINGERPRINT_VERSION,
    resultData: resultData ?? null,
    sqlOrPipelineDescription: sqlOrPipelineDescription ?? null,
    parameters: parameters ?? null,
    metricsRegistryVersion: metricsRegistryVersion ?? null,
    datasetProvenanceHash: datasetProvenanceHash ?? null,
  });
}

// SHA-256 over the canonical payload. Deterministic given the same inputs, so
// the same computation always fingerprints to the same value and any tampering
// changes it. Exposed on its own so a verifier can recompute without building a
// full record.
export async function computeFingerprintDigest(inputs) {
  return sha256Hex(canonicalFingerprintPayload(inputs));
}

/**
 * Build a fingerprint record for a computed result. Fast (a single SHA-256 over
 * a JSON string — milliseconds) and pure aside from the timestamp it stamps.
 *
 * @param {object} inputs
 * @param {*}      inputs.resultData                 canonical representation of the result (rows, series, metric value…)
 * @param {string} [inputs.sqlOrPipelineDescription] the SQL or pipeline that produced it
 * @param {*}      [inputs.parameters]               bound parameters / options that affected the result
 * @param {number} [inputs.metricsRegistryVersion]   metrics-registry version in force (see js/app-shell/metrics-registry.js)
 * @param {string} [inputs.datasetProvenanceHash]    the dataset chain's latest hash (see js/provenance/provenance.js)
 * @param {object} [meta]                            { label, generatedAt } — descriptive only, NOT part of the digest
 * @returns {Promise<object>} a self-describing fingerprint record
 */
export async function computeAnalysisFingerprint(inputs = {}, meta = {}) {
  const committed = {
    // Descriptive form of what was committed. The digest is over the canonical
    // payload of the SAME fields (via canonicalFingerprintPayload), so this
    // block is exactly what a verifier must feed back in to reproduce it.
    sqlOrPipelineDescription: inputs.sqlOrPipelineDescription ?? null,
    parameters: inputs.parameters ?? null,
    metricsRegistryVersion: inputs.metricsRegistryVersion ?? null,
    datasetProvenanceHash: inputs.datasetProvenanceHash ?? null,
    hasResultData: inputs.resultData != null,
  };
  const digest = await computeFingerprintDigest(inputs);
  return {
    kind: FINGERPRINT_KIND,
    version: FINGERPRINT_VERSION,
    generatedAt: meta.generatedAt != null ? new Date(meta.generatedAt).toISOString() : new Date().toISOString(),
    label: meta.label ?? null,
    algorithm: 'SHA-256 of canonical JSON payload (kind, version, resultData, sqlOrPipelineDescription, parameters, metricsRegistryVersion, datasetProvenanceHash)',
    committed,
    digest: {
      algorithm: 'SHA-256',
      value: digest,
      covers: 'resultData + sqlOrPipelineDescription + parameters + metricsRegistryVersion + datasetProvenanceHash',
    },
    disclaimer: FINGERPRINT_DISCLAIMER,
  };
}

/**
 * Independently verify a fingerprint record by recomputing the digest from the
 * inputs the verifier re-supplies (the result data + committed inputs) and
 * comparing. Pure and dependency-free (only sha256Hex) — references no app
 * state, so a third party can run it on the record + a fresh recomputation of
 * the same analysis.
 *
 * @param {object} record            a computeAnalysisFingerprint() return value
 * @param {object} recomputedInputs  the same-shaped inputs, recomputed independently
 * @returns {Promise<{valid:boolean, reason:string, stored:(string|null), recomputed:(string|null)}>}
 */
export async function verifyAnalysisFingerprint(record, recomputedInputs) {
  if (!record || record.kind !== FINGERPRINT_KIND) {
    return { valid: false, reason: 'Not a DATAGLOW analysis fingerprint (missing/incorrect "kind").', stored: null, recomputed: null };
  }
  const stored = record.digest && typeof record.digest.value === 'string' ? record.digest.value : null;
  if (!stored) {
    return { valid: false, reason: 'Fingerprint record carries no digest value.', stored: null, recomputed: null };
  }
  const recomputed = await computeFingerprintDigest(recomputedInputs);
  const valid = recomputed === stored;
  return {
    valid,
    reason: valid
      ? 'Fingerprint verified: the recomputed result and inputs reproduce the recorded digest exactly. (Integrity check only — not a signature, notarization, or legal/clinical determination.)'
      : 'Fingerprint MISMATCH: the recomputed result or inputs differ from what the record committed to — the result or one of its recorded inputs was altered.',
    stored,
    recomputed,
  };
}
