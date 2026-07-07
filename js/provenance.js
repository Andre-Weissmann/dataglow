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

import { devAssertConformance } from './protocol-conformance.js';

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

// SHA-256 of a UTF-8 string, hex-encoded. Exported so the selective-disclosure
// proof module (js/selective-disclosure-proof.js) commits its Merkle leaves with
// the identical hash primitive rather than introducing a second hashing approach.
export async function sha256Hex(str) {
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

// The genesis entry's parentHash is the all-zero string. Exported so the
// standalone verifier (test/verify-attestation.mjs) recomputes the chain with
// the identical anchor rather than a copied constant that could silently drift.
export const GENESIS_PARENT = '0'.repeat(64);

// Re-verify an exported chain (array of step entries) from scratch, recomputing
// every hash. Pure and dependency-free so an independent third party — or the
// standalone Node verifier — can confirm the math without any app state. Mirrors
// the closure `verify()` below exactly; both fold parentHash + contentHash into
// each step's SHA-256 the same way.
export async function verifyChainArray(steps) {
  const chain = Array.isArray(steps) ? steps : [];
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

// A provenance chain for a single dataset. Each entry:
//   { index, op, description, detail, ts, parentHash, hash }
export function createProvenanceChain() {
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
  function verify() {
    return verifyChainArray(chain);
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

  async function attest(metadata = {}) {
    return buildAttestation(getTrail(), metadata);
  }

  return { append, verify, getTrail, exportTrail, attest, get length() { return chain.length; } };
}

// ------------------------------------------------------------
// Verifiable Provenance Attestation
// ------------------------------------------------------------
// An attestation packages the full hash chain, dataset metadata, and a
// human-readable summary into a single self-describing JSON document, plus a
// SHA-256 digest of that document's canonical core.
//
// HONEST LABELLING (legal-risk constraint): we do NOT claim the document has
// been notarized/timestamped by a trusted authority. There is no free public
// RFC-3161 / OpenTimestamps endpoint reliably reachable from the browser
// (CORS + rate limits), so rather than fake a timestamp we emit a digest that
// is *ready* for third-party notarization and document exactly how to notarize
// it independently (OpenTimestamps web client, or `openssl ts`). The status is
// labelled "digest-ready-for-notarization", never "notarized".
const ATTESTATION_KIND = 'dataglow-provenance-attestation';
const ATTESTATION_VERSION = 1;

// Canonical core the digest commits to — everything that describes the data and
// its chain of custody. The digest and the volatile notarization block are
// intentionally excluded so the digest is a stable function of the content.
function attestationCore(att) {
  return {
    kind: att.kind,
    version: att.version,
    generatedAt: att.generatedAt,
    algorithm: att.algorithm,
    dataset: att.dataset,
    chain: att.chain,
    summary: att.summary,
  };
}

// SHA-256 over the canonical JSON of the attestation core. Deterministic given
// the same content, so any tampering with the chain or metadata changes it.
export async function computeAttestationDigest(att) {
  return sha256Hex(JSON.stringify(attestationCore(att)));
}

export function buildAttestationSummary(dataset, steps) {
  const n = steps.length;
  const finalHash = n ? steps[n - 1].hash : GENESIS_PARENT;
  const ops = steps.map(s => s.op);
  const rows = dataset.rowCount != null ? dataset.rowCount.toLocaleString() : 'unknown';
  const cols = dataset.colCount != null ? dataset.colCount : 'unknown';
  return `Provenance attestation for dataset "${dataset.table || 'dataset'}" (${rows} rows × ${cols} columns). `
    + `The chain of custody records ${n} step(s)${ops.length ? ` (${ops.join(' → ')})` : ''}, `
    + `anchored by a SHA-256 hash chain whose final hash is ${finalHash.slice(0, 16)}…. `
    + `This is a cryptographic integrity record, not a legal or clinical determination.`;
}

// Build an attestation from a chain trail (array from getTrail()) + metadata.
// `metadata` may carry { table, rowCount, colCount, columns, loadedAt }.
export async function buildAttestation(trail, metadata = {}) {
  const steps = Array.isArray(trail) ? trail.map(e => ({ ...e })) : [];
  const finalHash = steps.length ? steps[steps.length - 1].hash : GENESIS_PARENT;
  const dataset = {
    table: metadata.table ?? null,
    rowCount: metadata.rowCount ?? null,
    colCount: metadata.colCount ?? (Array.isArray(metadata.columns) ? metadata.columns.length : null),
    columns: Array.isArray(metadata.columns) ? metadata.columns : null,
    loadedAt: metadata.loadedAt != null ? new Date(metadata.loadedAt).toISOString() : null,
  };
  const att = {
    kind: ATTESTATION_KIND,
    version: ATTESTATION_VERSION,
    generatedAt: new Date().toISOString(),
    algorithm: 'SHA-256 hash chain (Merkle-style linked hashes)',
    dataset,
    chain: {
      genesisParent: GENESIS_PARENT,
      length: steps.length,
      finalHash,
      steps,
    },
    summary: buildAttestationSummary(dataset, steps),
  };
  const digest = await computeAttestationDigest(att);
  att.digest = { algorithm: 'SHA-256', value: digest, covers: 'kind, version, generatedAt, algorithm, dataset, chain, summary' };
  att.notarization = {
    status: 'digest-ready-for-notarization',
    notarized: false,
    utcTime: new Date().toISOString(),
    note: 'DATAGLOW does not itself notarize this document. The SHA-256 digest above is ready to be submitted to an independent trusted timestamp authority for a tamper-evident proof of existence.',
    howToNotarize: [
      'OpenTimestamps (free, Bitcoin-anchored): drag this JSON file onto https://opentimestamps.org, or run `ots stamp attestation.json` with the OpenTimestamps client. This produces a .ots proof you can later verify with `ots verify`.',
      'RFC 3161 Time-Stamp Protocol: create a request with `openssl ts -query -data attestation.json -sha256 -out request.tsq`, submit it to any RFC-3161 TSA, and save the returned token; verify later with `openssl ts -verify`.',
    ],
    verifyIndependently: 'Recompute the SHA-256 digest of this document\'s canonical core (kind, version, generatedAt, algorithm, dataset, chain, summary) and re-run the hash chain with test/verify-attestation.mjs — no DATAGLOW code or network access required.',
  };
  // Dev-mode, non-fatal: confirm the emitted attestation conforms to the
  // published protocol/schema/provenance-attestation.schema.json.
  devAssertConformance('provenance-attestation', att);
  return att;
}

// Independently re-verify an attestation: (1) re-run the hash chain math, and
// (2) recompute the digest and confirm it matches the stored value. Returns a
// combined report. Used by the standalone verifier and the app's verify button.
export async function verifyAttestation(att) {
  if (!att || att.kind !== ATTESTATION_KIND) {
    return { valid: false, chain: null, digest: null, reason: 'Not a DATAGLOW provenance attestation (missing/incorrect "kind").' };
  }
  const steps = att.chain && Array.isArray(att.chain.steps) ? att.chain.steps : [];
  const chainResult = await verifyChainArray(steps);
  const recomputed = await computeAttestationDigest(att);
  const stored = att.digest && att.digest.value;
  const digestValid = !!stored && recomputed === stored;
  const finalHash = steps.length ? steps[steps.length - 1].hash : GENESIS_PARENT;
  const finalHashMatches = att.chain ? att.chain.finalHash === finalHash : false;
  const valid = chainResult.valid && digestValid && finalHashMatches;
  let reason;
  if (!chainResult.valid) reason = chainResult.reason;
  else if (!finalHashMatches) reason = 'The recorded final hash does not match the recomputed chain — the chain summary was altered.';
  else if (!digestValid) reason = 'The document digest does not match its content — the attestation was modified after export.';
  else reason = `Attestation verified: ${steps.length} chain step(s) intact and the document digest matches its content. (Integrity check only — not a notarization or legal/clinical determination.)`;
  return {
    valid,
    reason,
    chain: chainResult,
    digest: { valid: digestValid, stored: stored || null, recomputed },
    finalHashMatches,
  };
}

function escapeAttHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// PDF-friendly, self-contained HTML rendering of an attestation. Mirrors the
// Validation Receipt certificate styling (inline styles, printable card) so the
// two exports look like siblings. No external assets — safe to print to PDF.
export function renderAttestationHTML(att) {
  const d = att.dataset || {};
  const chain = att.chain || { steps: [], length: 0, finalHash: GENESIS_PARENT };
  const rowsHtml = (chain.steps || []).map(s => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#666;">#${s.index}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap;">${escapeAttHtml(new Date(s.ts).toISOString().replace('T', ' ').slice(0, 19))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;"><strong>${escapeAttHtml(s.op)}</strong>: ${escapeAttHtml(s.description)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px;color:#444;">${escapeAttHtml((s.hash || '').slice(0, 16))}…</td>
      </tr>`).join('');
  const notar = att.notarization || {};
  const howTo = (notar.howToNotarize || []).map(h => `<li style="margin:4px 0;">${escapeAttHtml(h)}</li>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>DATAGLOW Provenance Attestation</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:820px;margin:24px auto;padding:0 20px;line-height:1.5;">
  <div style="border:2px solid #2b6cb0;border-radius:12px;padding:28px 32px;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #2b6cb0;padding-bottom:12px;margin-bottom:18px;">
      <h1 style="margin:0;font-size:22px;color:#2b6cb0;">DATAGLOW Provenance Attestation</h1>
      <span style="font-size:12px;color:#666;">Generated ${escapeAttHtml(att.generatedAt)}</span>
    </div>
    <p style="margin:0 0 16px;">${escapeAttHtml(att.summary)}</p>
    <h2 style="font-size:15px;margin:18px 0 8px;">Dataset</h2>
    <table style="border-collapse:collapse;font-size:13px;">
      <tr><td style="padding:2px 12px 2px 0;color:#666;">Table</td><td>${escapeAttHtml(d.table || '—')}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666;">Rows × Columns</td><td>${d.rowCount != null ? escapeAttHtml(d.rowCount.toLocaleString()) : '—'} × ${d.colCount != null ? escapeAttHtml(String(d.colCount)) : '—'}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666;">Loaded at</td><td>${escapeAttHtml(d.loadedAt || '—')}</td></tr>
    </table>
    <h2 style="font-size:15px;margin:20px 0 8px;">Chain of custody (${escapeAttHtml(String(chain.length))} step${chain.length === 1 ? '' : 's'})</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <thead><tr style="text-align:left;color:#2b6cb0;"><th style="padding:6px 10px;">#</th><th style="padding:6px 10px;">UTC time</th><th style="padding:6px 10px;">Operation</th><th style="padding:6px 10px;">Hash</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="4" style="padding:10px;color:#999;">No steps recorded.</td></tr>'}</tbody>
    </table>
    <h2 style="font-size:15px;margin:20px 0 8px;">Integrity digest</h2>
    <p style="font-family:monospace;font-size:12px;word-break:break-all;background:#f6f8fa;padding:10px;border-radius:6px;margin:0 0 6px;">${escapeAttHtml(att.digest ? att.digest.value : '—')}</p>
    <p style="font-size:12px;color:#666;margin:0 0 4px;">Algorithm: ${escapeAttHtml(att.algorithm)}. Final chain hash: <span style="font-family:monospace;">${escapeAttHtml((chain.finalHash || '').slice(0, 24))}…</span></p>
    <div style="margin-top:18px;padding:14px 16px;background:#fffbea;border:1px solid #f0e0a0;border-radius:8px;">
      <strong style="color:#8a6d00;">Notarization status: ${escapeAttHtml(notar.status || 'digest-ready-for-notarization')}</strong>
      <p style="margin:8px 0 6px;font-size:13px;">${escapeAttHtml(notar.note || '')}</p>
      <p style="margin:6px 0 4px;font-size:13px;">To obtain an independent, tamper-evident timestamp:</p>
      <ul style="margin:4px 0 0;padding-left:20px;font-size:12px;">${howTo}</ul>
    </div>
    <p style="margin-top:18px;font-size:11px;color:#888;border-top:1px solid #eee;padding-top:10px;">
      This attestation is a cryptographic integrity record produced by DATAGLOW. It proves the recorded chain of custody was not altered after export; it is <strong>not</strong> a notarization, and <strong>not</strong> a legal, clinical, or regulatory determination.
    </p>
  </div>
</body></html>`;
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
