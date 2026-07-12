// ============================================================
// DATAGLOW — Personal Data Bill of Materials (BOM)
// ============================================================
// A ONE-CLICK, OFFLINE export/packaging layer on top of the existing
// provenance attestation machinery (js/provenance/provenance.js). It does
// NOT duplicate hash-chain or digest logic — it composes an attestation with
// the extra fields a "data ingredient label" needs that the attestation
// alone doesn't carry: an explicit source description, the dataset's schema
// signature (so two exports of "the same shape" data can be compared), a
// column-distribution snapshot, and — only if the on-device LLM was actually
// used this session — its exact model/quantization identifier.
//
// This mirrors real industry building blocks that today only exist as
// separate, enterprise-facing artifacts:
//   • Software/Data Bill of Materials (SBOM/DBoM) — "ingredient label" idea,
//     and the G7/CISA "SBOM for AI — Minimum Elements" Datasets Properties
//     cluster (provenance + sensitivity).
//   • ML-BOM — the model identity + quantization fields.
//   • Dataset Nutrition Label (Data Nutrition Project) — the distribution
//     snapshot fields.
// DATAGLOW fuses these into one signed, portable, offline JSON (+ printable
// HTML) artifact for a single individual's single analysis — no server, no
// account, no network call.
//
// HONESTY CONSTRAINT (copied verbatim from provenance.js's convention and
// MANDATORY to preserve): this artifact is a self-computed SHA-256 digest.
// It is NEVER described as cryptographically "signed" by a third party, and
// "notarization" always reports status 'digest-ready-for-notarization' with
// notarized:false unless the caller has independently notarized the digest
// (e.g. via OpenTimestamps or an RFC-3161 TSA) and attaches proof of that
// separately. This module never claims otherwise.
//
// EMPOWERMENT CONSTRAINT: this module only ever READS state the user already
// produced (their loaded dataset, their provenance chain, their validation
// run, whether THEY chose to load the on-device model) and packages it into
// a file for the user to inspect/download. It never sends data anywhere, and
// it never triggers, schedules, or performs any change to the user's data —
// the export is presented for the user to review before they choose to save,
// share, or discard it, exactly like every other export in DATAGLOW.

import {
  hashBytes, buildAttestation, computeAttestationDigest,
} from './provenance.js';
import { devAssertConformance } from '../protocol/protocol-conformance.js';

export const BOM_KIND = 'dataglow-personal-data-bom';
export const BOM_VERSION = 1;

// ------------------------------------------------------------
// Schema signature — a stable, human-diffable string identifying the
// dataset's *shape* (column names + types), independent of the DuckDB table
// name or filename. Deliberately re-derived here with the exact same
// definition js/validation/validation.js's schemaSignature() uses, so a BOM
// produced without ever running validation still gets a signature, and BOMs
// produced from the same file shape always match — this is the "schema
// version" field callers can diff across exports of "the same kind of file"
// over time (e.g. this month's export vs. last month's).
// ------------------------------------------------------------
export function schemaSignature(cols) {
  const list = Array.isArray(cols) ? cols : [];
  return JSON.stringify(list.map((c) => [c.name, c.type]).sort());
}

// A short, stable hash of the schema signature — easier to eyeball-compare
// or put in a filename than the full JSON string.
export async function schemaVersionHash(cols) {
  return hashBytes(new TextEncoder().encode(schemaSignature(cols)));
}

// ------------------------------------------------------------
// Local-model provenance — only populated if the caller tells us the
// on-device model was actually loaded/used for this analysis. DATAGLOW never
// silently assumes an LLM was used; the caller (main.js) passes this in only
// when js/narrative/ondevice-llm.js reports isModelLoaded() === true.
// ------------------------------------------------------------
export function buildLocalModelRecord({ modelId, modelLabel, used = false } = {}) {
  if (!used || !modelId) {
    return { used: false, modelId: null, modelLabel: null, note: 'No local AI model was used for this analysis.' };
  }
  return {
    used: true,
    modelId,
    modelLabel: modelLabel || null,
    note: 'Ran fully on-device (WebGPU/WebLLM). No dataset content was ever sent to the model provider or any network endpoint.',
  };
}

// ------------------------------------------------------------
// Core builder. Pure: no I/O, no globals, no engine access — every value it
// needs is supplied by the caller. This is what makes it Node-testable
// without DuckDB-WASM, matching the pattern used by drift-watchdog.js.
//
// @param {object} opts
// @param {object} opts.dataset            { table, name, rowCount, cols:[{name,type}], loadedAt, sizeBytes? }
// @param {Array}  opts.trail              A provenance chain's trail array, as returned by createProvenanceChain().getTrail() — an array of step objects, NOT wrapped in { steps }.
// @param {object} [opts.distribution]     Output of validation.js's computeDistributionFingerprint(table, cols), or null if never computed.
// @param {object} [opts.localModel]       { modelId, modelLabel, used } — see buildLocalModelRecord(). If omitted, defaults to "not used".
// @param {string} [opts.sourceDescription] Free-text description of where the data came from (e.g. "Uploaded file: claims_2026_06.csv" or "Databricks query result"). Falls back to dataset.name.
// @param {Date}   [opts.generatedAt]      Override generation timestamp (tests).
// @returns {Promise<object>} the Personal Data BOM document
// ------------------------------------------------------------
export async function buildPersonalDataBom({
  dataset, trail, distribution = null, localModel = null, sourceDescription = null, generatedAt = null,
} = {}) {
  if (!dataset || !dataset.table) throw new Error('buildPersonalDataBom requires a dataset with at least a table name.');
  const cols = Array.isArray(dataset.cols) ? dataset.cols : [];
  const steps = Array.isArray(trail) ? trail : [];

  // Reuse buildAttestation() as-is — do not re-implement hash-chaining or
  // digesting here. This is the "fuse existing provenance machinery" design
  // decision: the BOM's chain-of-custody section IS the attestation.
  // buildAttestation() is async (it computes the attestation's own digest),
  // so this call MUST be awaited — a very easy bug to introduce silently
  // (a missing await here still "works" but bakes an unresolved Promise into
  // bomCore, corrupting the outer digest and every downstream render).
  const attestation = await buildAttestation(
    steps,
    {
      table: dataset.table,
      rowCount: dataset.rowCount ?? null,
      colCount: cols.length || null,
      columns: cols.map((c) => ({ name: c.name, type: c.type })),
      loadedAt: dataset.loadedAt ?? null,
    },
  );

  const schemaSig = schemaSignature(cols);
  const schemaHash = await hashBytes(new TextEncoder().encode(schemaSig));

  const bomCore = {
    kind: BOM_KIND,
    version: BOM_VERSION,
    generatedAt: (generatedAt instanceof Date ? generatedAt : new Date()).toISOString(),
    source: {
      description: sourceDescription || dataset.name || dataset.table,
      table: dataset.table,
      sizeBytes: dataset.sizeBytes ?? null,
      ingestedAt: dataset.loadedAt != null ? new Date(dataset.loadedAt).toISOString() : null,
    },
    schema: {
      columnCount: cols.length,
      columns: cols.map((c) => ({ name: c.name, type: c.type })),
      signature: schemaSig,
      signatureHash: schemaHash,
    },
    distribution: distribution
      ? { computed: true, snapshot: distribution }
      : { computed: false, snapshot: null, note: 'No column-distribution snapshot was computed for this export (run validation first to include one).' },
    localModel: buildLocalModelRecord(localModel || {}),
    // Nest, don't merge, the underlying attestation — the BOM never re-derives
    // or overrides any hash-chain field the attestation already computed.
    attestation,
  };

  // Plain JSON.stringify (no replacer) — matches provenance.js's own digest
  // convention exactly. bomCore's keys are always built in the same fixed
  // order above, so this is deterministic given the same content. A
  // Object.keys(...).sort() "replacer array" was tried here first and
  // rejected: JSON.stringify replacer *arrays* apply the same top-level key
  // allow-list at every nesting level, which silently emptied every nested
  // object (source, schema, distribution, localModel) down to {} — a subtle,
  // dangerous bug for an integrity digest, caught by the smoke test.
  const digestValue = await hashBytes(
    new TextEncoder().encode(JSON.stringify(bomCore)),
  );

  const bom = {
    ...bomCore,
    digest: {
      algorithm: 'SHA-256',
      value: digestValue,
      covers: 'source, schema, distribution, localModel, and the full nested attestation (which carries its own independent digest).',
    },
    // Identical honest-labelling convention to provenance.js's notarization
    // block: a self-computed digest only, never a claimed third-party signature.
    notarization: {
      status: 'digest-ready-for-notarization',
      notarized: false,
      utcTime: new Date().toISOString(),
      note: 'This is a self-computed SHA-256 digest, not a third-party notarization or cryptographic signature. DATAGLOW performs no network calls, so it cannot obtain a trusted timestamp on your behalf.',
      howToNotarize: [
        'OpenTimestamps (opentimestamps.org or the ots CLI) — free, Bitcoin-anchored timestamp proof over this digest.',
        'An RFC-3161 Time-Stamp Authority, e.g.: openssl ts -query -digest <digest.value> -sha256 -cert -out request.tsq',
      ],
      verifyIndependently: 'Recompute the digest over the fields listed in "covers" (sorted keys, UTF-8 JSON) and compare to digest.value. The nested attestation can be independently re-verified with test/verify-attestation.mjs.',
    },
  };
  // Dev-mode-only, non-fatal drift check against protocol/schema/personal-data-bom.schema.json — mirrors provenance.js's own buildAttestation() call exactly (see js/provenance/provenance.js).
  devAssertConformance('personal-data-bom', bom);
  return bom;
}

// Independently re-verify a Personal Data BOM document: recomputes the outer
// digest AND re-verifies the nested attestation (chain + its own digest).
// Pure and dependency-free — usable from Node without the app or DuckDB.
export async function verifyPersonalDataBom(bom) {
  if (!bom || bom.kind !== BOM_KIND) {
    return { valid: false, reason: `Not a ${BOM_KIND} document.` };
  }
  const { digest, notarization, ...core } = bom;
  if (!digest || !digest.value) return { valid: false, reason: 'Missing digest.' };
  const { attestation } = bom;

  // Rebuild bomCore in the EXACT same key order buildPersonalDataBom() used.
  // IMPORTANT: `core` here still includes the nested `attestation` field —
  // the outer digest covers it (see digest.covers), so excluding it from the
  // recompute would always mismatch. Only `digest` and `notarization` (the
  // two volatile/non-content fields, exactly mirroring provenance.js's own
  // attestationCore() convention of excluding its own digest+notarization)
  // are stripped. No replacer array — see the comment in buildPersonalDataBom().
  const recomputed = await hashBytes(
    new TextEncoder().encode(JSON.stringify(core)),
  );
  const outerValid = recomputed === digest.value;

  let attestationResult = { valid: true, reason: 'No nested attestation present.' };
  if (attestation) {
    // Re-derive the same way provenance.js's verifyAttestation() would, without
    // importing it here to avoid a circular dependency; instead recompute the
    // attestation core digest directly using the shared helper.
    const recomputedAttDigest = await computeAttestationDigest(attestation);
    const attDigestValid = attestation.digest && attestation.digest.value === recomputedAttDigest;
    attestationResult = {
      valid: !!attDigestValid,
      reason: attDigestValid ? 'Nested attestation digest matches.' : 'Nested attestation digest MISMATCH.',
    };
  }

  const valid = outerValid && attestationResult.valid;
  return {
    valid,
    reason: valid
      ? 'Personal Data BOM verified: outer digest and nested attestation are both intact.'
      : `Verification failed — ${!outerValid ? 'outer digest mismatch' : ''}${(!outerValid && !attestationResult.valid) ? '; ' : ''}${!attestationResult.valid ? attestationResult.reason : ''}`.trim(),
    outer: { valid: outerValid, stored: digest.value, recomputed },
    attestation: attestationResult,
  };
}

// Turn a verifyPersonalDataBom() result into a small, plain-language,
// UI-agnostic description a non-engineer can act on. Pure (no DOM, no I/O) so
// it is unit-testable and reusable; the caller decides how to render the
// returned strings. `headline` is a one-line verdict; `details` names which
// part changed (source/schema/distribution vs. the chain of custody), falling
// back to the verifier's own reason string when no finer breakdown is present.
export function describeBomVerification(res) {
  if (!res || typeof res !== 'object') {
    return { ok: false, headline: 'Could not verify this Data BOM — it may be malformed.', details: [] };
  }
  if (res.valid) {
    return {
      ok: true,
      headline: '✓ Verified — this Data BOM has not been tampered with.',
      details: ['The overall SHA-256 digest and the nested provenance chain both match what was recorded.'],
    };
  }
  const details = [];
  if (res.outer && res.outer.valid === false) {
    details.push('The source, schema, or column-distribution section was changed after the BOM was generated (overall digest mismatch).');
  }
  if (res.attestation && res.attestation.valid === false) {
    details.push('The provenance chain of custody was altered (nested attestation digest mismatch).');
  }
  if (!details.length) details.push(res.reason || 'The BOM could not be verified.');
  return {
    ok: false,
    headline: '✗ Verification failed — this Data BOM does not match its recorded fingerprint.',
    details,
  };
}

// ------------------------------------------------------------
// Self-contained, inline-styled HTML renderer — a printable/PDF-friendly
// "ingredient label" certificate. Deliberately styled to echo the visual
// language of provenance.js's renderAttestationHTML() (plain, high-contrast,
// print-safe; no external CSS or fonts) so the two certificates feel like
// the same family of document.
// ------------------------------------------------------------
export function renderPersonalDataBomHTML(bom) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const distRows = bom.distribution && bom.distribution.computed
    ? Object.entries(bom.distribution.snapshot).map(([name, s]) => `
      <tr>
        <td>${esc(name)}</td><td>${esc(s.kind)}</td>
        <td>${s.nullRate != null ? (s.nullRate * 100).toFixed(1) + '%' : '—'}</td>
        <td>${s.cardinality != null ? s.cardinality.toFixed(3) : '—'}</td>
        <td>${s.kind === 'numeric' ? [s.mean, s.std, s.min, s.max].map((v) => v != null ? v.toFixed(2) : '—').join(' / ') : (s.topLabel || '—')}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="color:#888;">No distribution snapshot computed for this export.</td></tr>`;

  const cols = bom.schema.columns.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.type)}</td></tr>`).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Personal Data Bill of Materials — ${esc(bom.source.table)}</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;color:#111;line-height:1.5;}
  h1{font-size:20px;border-bottom:3px solid #111;padding-bottom:10px;}
  h2{font-size:14px;margin-top:28px;border-bottom:1px solid #ccc;padding-bottom:4px;}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;}
  th,td{border:1px solid #ddd;padding:5px 8px;text-align:left;}
  th{background:#f4f4f4;}
  .mono{font-family:Menlo,Consolas,monospace;font-size:11px;word-break:break-all;}
  .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;background:#eee;}
  .note{font-size:11px;color:#555;background:#fafafa;border:1px solid #eee;padding:8px;border-radius:4px;margin-top:6px;}
  @media print{body{margin:0;}}
</style></head>
<body>
  <h1>Personal Data Bill of Materials</h1>
  <p><span class="badge">${esc(bom.kind)} v${bom.version}</span> generated ${esc(bom.generatedAt)}</p>

  <h2>Source</h2>
  <table>
    <tr><th>Description</th><td>${esc(bom.source.description)}</td></tr>
    <tr><th>Table</th><td>${esc(bom.source.table)}</td></tr>
    <tr><th>Size (bytes)</th><td>${bom.source.sizeBytes ?? '—'}</td></tr>
    <tr><th>Ingested at</th><td>${esc(bom.source.ingestedAt) || '—'}</td></tr>
  </table>

  <h2>Schema (version ${esc(bom.schema.signatureHash.slice(0, 12))}…)</h2>
  <table><tr><th>Column</th><th>Type</th></tr>${cols}</table>

  <h2>Column-Distribution Snapshot</h2>
  <table><tr><th>Column</th><th>Kind</th><th>Null rate</th><th>Cardinality</th><th>Mean/Std/Min/Max or Top value</th></tr>${distRows}</table>

  <h2>Local AI Model</h2>
  <p>${bom.localModel.used
    ? `Used: <strong>${esc(bom.localModel.modelLabel || bom.localModel.modelId)}</strong> (<span class="mono">${esc(bom.localModel.modelId)}</span>)`
    : 'Not used for this export.'}</p>
  <p class="note">${esc(bom.localModel.note)}</p>

  <h2>Chain of Custody &amp; Integrity Digest</h2>
  <p>Chain length: ${bom.attestation.chain.length} step(s). Final hash: <span class="mono">${esc(bom.attestation.chain.finalHash)}</span></p>
  <p>BOM digest (${esc(bom.digest.algorithm)}): <span class="mono">${esc(bom.digest.value)}</span></p>
  <p class="note"><strong>${esc(bom.notarization.status)}</strong> — notarized: ${bom.notarization.notarized}. ${esc(bom.notarization.note)}</p>

  <h2>What this is / is not</h2>
  <p class="note">This is a self-generated, offline data ingredient label: source, schema, distribution shape, and (if used) local-AI-model identity, bound together with a tamper-evident chain-of-custody digest. It is <strong>not</strong> a legal, regulatory, or clinical certification, and the digest is <strong>not</strong> a third-party cryptographic signature unless you independently notarize it (see "How to notarize" in the exported JSON).</p>
</body></html>`;
}
