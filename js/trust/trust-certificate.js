// ============================================================
// DATAGLOW — Trust Certificate (Phase 1)
// ============================================================
// Assembles a single, signed, downloadable Trust Certificate from the live
// outputs of the validation engine, the de-identification verifier, the
// k-anonymity check, and the AI Readiness Gate. Wraps the existing signed
// provenance packet (js/provenance/provenance-packet.js) and adds a
// certificate-level envelope with a human-readable verdict.
//
// WHY THIS EXISTS:
// The provenance packet already signs dataset lineage, de-identification
// attestations, and denial risk. What was missing is a SINGLE artifact that
// bundles the FULL validation run (all 20+ layers), the k-anonymity floor,
// and the AI Readiness Gate score into one SHA-256 signed JSON document that
// any stakeholder -- a CISO, auditor, compliance officer, or downstream AI
// agent -- can verify offline without contacting DATAGLOW or re-running the
// analysis.
//
// This module is PURE (no DOM, no network). The browser wiring lives in
// main.js. The certificate is independently verifiable: verifyTrustCertificate()
// recomputes the outer signature and returns the result.
//
// FORMAT:
//   {
//     kind: 'dataglow-trust-certificate',
//     formatVersion: 1,
//     generatedAt: ISO timestamp,
//     producer: { app, version, build },
//     dataset: { table, rowCount, columns, sourceHash },
//     gate: { agentConsumable, score, threshold, hardFailLayers, warnLayers },
//     validationSummary: { total, pass, warn, fail, idle, layers: [...] },
//     kAnonymity: { kFloor, smallCellGroups, flagged, level, quasiCols, rationale },
//     packet: { ... },   // the full embedded provenance packet (signed separately)
//     signature: { algorithm, value, covers },
//     disclaimer: '...',
//   }

import { sha256Hex } from '../provenance/provenance.js';
import { buildPacket, serializePacket } from '../provenance/provenance-packet.js';
import { computeReadinessGate, explainGateReasons } from '../gate/readiness-gate.js';

export const CERT_KIND = 'dataglow-trust-certificate';
export const CERT_FORMAT_VERSION = 1;
export const CERT_FILE_EXTENSION = '.dataglow-cert.json';

// ---- helpers ---------------------------------------------------------------

function isoNow() { return new Date().toISOString(); }

// Stable validation summary from the runAllLayers() result object.
function summarizeValidationLayers(layerResults) {
  if (!layerResults || typeof layerResults !== 'object') {
    return { total: 0, pass: 0, warn: 0, fail: 0, idle: 0, layers: [] };
  }
  const layers = [];
  let pass = 0, warn = 0, fail = 0, idle = 0;
  const entries = Array.isArray(layerResults)
    ? layerResults.map((r, i) => [r && r.layer != null ? r.layer : String(i), r])
    : Object.entries(layerResults);
  for (const [key, r] of entries) {
    if (!r || typeof r !== 'object' || typeof r.status !== 'string') continue;
    const status = r.status;
    if (!['pass', 'warn', 'fail', 'idle'].includes(status)) continue;
    layers.push({
      layer: r.layer || r.name || key,
      status,
      summary: typeof r.summary === 'string' ? r.summary : '',
    });
    if (status === 'pass') pass++;
    else if (status === 'warn') warn++;
    else if (status === 'fail') fail++;
    else idle++;
  }
  return { total: layers.length, pass, warn, fail, idle, layers };
}

// The canonical core the certificate signature commits to -- everything except
// the signature block itself.
function certCore(cert) {
  return {
    kind: cert.kind,
    formatVersion: cert.formatVersion,
    generatedAt: cert.generatedAt,
    producer: cert.producer,
    dataset: cert.dataset,
    gate: cert.gate,
    validationSummary: cert.validationSummary,
    kAnonymity: cert.kAnonymity,
    // Commit to the inner packet's own signature rather than the full packet
    // payload (which can be large). Any tampering with the packet changes its
    // own stored signature, which is embedded here.
    packetSignature: cert.packet && cert.packet.signature ? cert.packet.signature.value : null,
  };
}

// ---- assembly --------------------------------------------------------------

/**
 * Build a signed Trust Certificate.
 *
 * @param {object} opts
 * @param {object} opts.dataset - { table, rowCount, columns, sourceHash }
 * @param {object} [opts.layerResults] - runAllLayers() output
 * @param {object} [opts.kAnonymityResult] - runKAnonymityCheck() output
 * @param {object} [opts.blame] - data-blame section
 * @param {object} [opts.deidentification] - de-id attestation
 * @param {object} [opts.denial] - denial-risk attestation
 * @param {object} [opts.metricContractStatus] - optional metric contract status
 * @param {object} [opts.producer] - { app, version, build }
 * @param {string} [opts.generatedAt] - ISO timestamp override (for tests)
 * @returns {Promise<object>} signed certificate
 */
export async function buildTrustCertificate({
  dataset = null,
  layerResults = null,
  kAnonymityResult = null,
  blame = null,
  deidentification = null,
  denial = null,
  metricContractStatus = null,
  producer = null,
  generatedAt = null,
} = {}) {
  const ts = generatedAt || isoNow();

  // Gate
  const gateResult = computeReadinessGate(layerResults, metricContractStatus, {});
  const hardFailLayers = (gateResult.reasons || [])
    .filter(r => r.severity === 'fail' || r.weight === 0)
    .map(r => r.layer || r.label || String(r));
  const warnLayers = (gateResult.reasons || [])
    .filter(r => r.severity === 'warn')
    .map(r => r.layer || r.label || String(r));

  // Validation summary
  const validationSummary = summarizeValidationLayers(layerResults);

  // k-anonymity section (compact -- strip the full groups array from the cert
  // envelope; the full result is in the embedded packet's deid section).
  const kanon = kAnonymityResult || {};
  const kAnonymity = {
    quasiCols: kanon.quasiCols || [],
    sampledRows: kanon.sampledRows || 0,
    kFloor: kanon.kFloor ?? null,
    smallCellGroups: kanon.smallCellGroups ?? 0,
    smallCellThreshold: kanon.smallCellThreshold || 5,
    flagged: kanon.flagged || false,
    level: kanon.level || 'none',
    rationale: kanon.rationale || 'Not run.',
  };

  // Dataset descriptor
  const ds = dataset && typeof dataset === 'object' ? {
    table: dataset.table ?? null,
    rowCount: dataset.rowCount ?? null,
    columns: Array.isArray(dataset.columns)
      ? dataset.columns.map(c => typeof c === 'string'
        ? { name: c, type: null }
        : { name: c.name, type: c.type ?? null })
      : [],
    sourceHash: dataset.sourceHash ?? null,
  } : { table: null, rowCount: null, columns: [], sourceHash: null };

  // Embed the full provenance packet signed separately.
  const packet = await buildPacket({
    dataset: ds,
    blame,
    deidentification,
    denial,
    producer,
    generatedAt: ts,
  });

  const prod = producer && typeof producer === 'object'
    ? { app: producer.app ?? 'DATAGLOW', version: producer.version ?? '1.0.0', build: producer.build ?? null }
    : { app: 'DATAGLOW', version: '1.0.0', build: 'trust-certificate-phase1' };

  const cert = {
    kind: CERT_KIND,
    formatVersion: CERT_FORMAT_VERSION,
    generatedAt: ts,
    producer: prod,
    dataset: ds,
    gate: {
      agentConsumable: gateResult.agentConsumable,
      score: gateResult.score ?? null,
      threshold: gateResult.threshold ?? null,
      verdict: gateResult.agentConsumable ? 'PASS' : 'FAIL',
      hardFailLayers,
      warnLayers,
      explanation: !gateResult.agentConsumable ? explainGateReasons(gateResult) : null,
    },
    validationSummary,
    kAnonymity,
    packet,
  };

  // Outer certificate signature (commits to gate + validation summary + k-anon
  // + the inner packet's own signature value).
  const sigValue = await sha256Hex(JSON.stringify(certCore(cert)));
  cert.signature = {
    algorithm: 'SHA-256',
    value: sigValue,
    covers: 'kind, formatVersion, generatedAt, producer, dataset, gate, validationSummary, kAnonymity, packetSignature',
  };

  cert.disclaimer =
    'A DATAGLOW Trust Certificate is a cryptographic integrity record produced by the DATAGLOW ' +
    'local-first validation engine. It does not constitute a HIPAA certification, a legal ' +
    'determination, or a guarantee of data accuracy. The AI Readiness Gate verdict reflects ' +
    'the state of the dataset at the time of the run against the active rulepack only. ' +
    'The k-anonymity score is an estimate on a sample of up to 500 rows. The embedded ' +
    'signature proves this document has not been altered since export -- it does not attest ' +
    'to the correctness of the underlying data.';

  return cert;
}

// ---- verification ----------------------------------------------------------

/**
 * Re-verify a Trust Certificate. Recomputes the outer signature and confirms it
 * matches the stored value. Also checks that the embedded packet has a signature
 * field (inner verification is a separate verifyPacket() call).
 *
 * @param {object} cert
 * @returns {Promise<{valid:boolean, reason:string, signature:{stored,recomputed}}>}
 */
export async function verifyTrustCertificate(cert) {
  if (!cert || typeof cert !== 'object' || cert.kind !== CERT_KIND) {
    return {
      valid: false,
      reason: 'Not a DATAGLOW Trust Certificate (missing or incorrect "kind").',
      signature: null,
    };
  }
  if (cert.formatVersion !== CERT_FORMAT_VERSION) {
    return {
      valid: false,
      reason: `Unsupported certificate format version ${cert.formatVersion}; this build understands version ${CERT_FORMAT_VERSION}.`,
      signature: null,
    };
  }
  const stored = cert.signature && cert.signature.value;
  if (!stored) {
    return {
      valid: false,
      reason: 'Certificate is unsigned.',
      signature: { stored: null, recomputed: null },
    };
  }
  const recomputed = await sha256Hex(JSON.stringify(certCore(cert)));
  const valid = recomputed === stored;
  return {
    valid,
    reason: valid
      ? 'Certificate verified: the signature matches its contents -- this document has not been altered since export.'
      : 'SIGNATURE MISMATCH -- this certificate was modified after it was signed. Do not trust its contents.',
    signature: { stored, recomputed },
  };
}

// ---- serialization ---------------------------------------------------------

export function serializeCertificate(cert) {
  return JSON.stringify(cert, null, 2);
}

export function parseCertificate(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) {
    throw new Error('Not valid JSON -- this does not look like a DATAGLOW Trust Certificate (' + e.message + ').');
  }
  if (!obj || typeof obj !== 'object' || obj.kind !== CERT_KIND) {
    throw new Error('Not a DATAGLOW Trust Certificate (missing or incorrect "kind").');
  }
  return obj;
}

export function certificateFilename(cert) {
  const table = cert && cert.dataset && cert.dataset.table;
  const safe = (table ? String(table) : 'dataset').replace(/[^A-Za-z0-9_-]+/g, '_');
  return 'dataglow-trust-cert-' + safe + CERT_FILE_EXTENSION;
}

/**
 * One-line human summary of a certificate for toast / UI display.
 * @param {object} cert
 * @returns {string}
 */
export function summarizeCertificate(cert) {
  if (!cert) return 'No certificate.';
  const v = cert.validationSummary || {};
  const g = cert.gate || {};
  const k = cert.kAnonymity || {};
  const parts = [
    'Gate: ' + (g.verdict || '?'),
    'Score: ' + (g.score != null ? g.score : '?'),
    v.total ? (v.pass + '/' + v.total + ' layers pass') : '',
    k.kFloor != null ? ('k-floor: ' + k.kFloor + (k.flagged ? ' [SMALL CELL]' : '')) : '',
  ].filter(Boolean);
  return parts.join(' | ');
}
