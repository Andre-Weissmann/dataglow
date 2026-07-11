// ============================================================
// DATAGLOW — Data Nutrition Label (portable provenance manifest)
// ============================================================
// A single, portable, human-and-machine-readable "nutrition label" for a
// dataset or exported report. It does NOT compute anything new: it READS the
// outputs the existing js/provenance/ modules already produce — the
// chain-of-custody trail (js/provenance/provenance.js), the Assumption Ledger
// (js/provenance/assumption-ledger.js), and the per-layer validation results
// (as packaged by js/provenance/validation-receipt.js or the raw layer
// summary) — and knits them into ONE self-describing manifest a recipient can
// inspect WITHOUT running DATAGLOW.
//
// HONEST NAMING (hard constraint): this is a MANIFEST / SUMMARY, nothing more.
// It is NOT a "certification", NOT "verified", NOT "blockchain", and it makes
// NO cryptographic guarantee of its own. The tamper-evident hash chain it
// embeds is produced by js/provenance/provenance.js; this module only carries
// that chain's summary along for the ride. Cryptographic disclosure proofs are
// batch 3's job; synthetic-data metadata is batch 4's job. Both are designed to
// attach to this manifest without changing its existing fields (see
// `isSynthetic` and the stable exported API below).
//
// PURITY: pure data assembly — no DOM, no network, no crypto, no engine. It
// takes plain objects the caller already holds, so it is identical in the
// browser, the Tauri desktop webview, and headless Node tests. Same convention
// as buildValidationReceipt()/buildReviewPacket() in the sibling modules.

// The manifest's own format version. Bump ONLY on a breaking shape change so a
// future reader can branch on it. Kept as an integer `1` to match the sibling
// provenance artifacts' convention (the attestation, validation receipt, and
// selective-disclosure proof all carry `version: 1`). This is intentionally
// distinct from protocol/VERSION (the separate semver of the wire-schema
// contract in protocol/); there is no existing schemaVersion field to inherit,
// so we start at 1 and document it here.
export const LABEL_KIND = 'dataglow-data-nutrition-label';
export const LABEL_SCHEMA_VERSION = 1;

// Plainly states what this artifact is and is not, so the honesty constraint
// travels with the exported file rather than living only in this comment.
export const LABEL_DISCLAIMER =
  'This is a Data Nutrition Label: a human- and machine-readable manifest '
  + 'summarizing what DATAGLOW checked, what passed or failed, what '
  + 'transformations were recorded, any assumptions made, and the chain of '
  + 'custody for a dataset. It is a summary only — NOT a certification, NOT a '
  + 'verification, and NOT a legal, clinical, or regulatory determination. The '
  + 'embedded chain-of-custody hashes are produced by DATAGLOW’s provenance '
  + 'trail; this label does not itself add any cryptographic guarantee.';

const STATUS_KEYS = ['pass', 'warn', 'fail', 'idle'];

// Normalize the many shapes a "custody trail" can arrive in into a plain array
// of step entries. Accepts: an array (already a trail from chain.getTrail()),
// a provenance chain object (has getTrail()), or null.
function resolveTrail(source) {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (typeof source.getTrail === 'function') return source.getTrail();
  if (Array.isArray(source.steps)) return source.steps; // attestation.chain shape
  return [];
}

// A single check row, normalized from either a raw validation summary entry
// ({ layer, name, status, summary }) or a validation-receipt layer
// ({ id, name, status, summary }).
function normalizeCheck(c) {
  return {
    id: c.id || c.layer || null,
    name: c.name || c.id || c.layer || 'Unnamed check',
    status: STATUS_KEYS.includes(c.status) ? c.status : 'idle',
    summary: typeof c.summary === 'string' ? c.summary : '',
  };
}

/**
 * Assemble a Data Nutrition Label manifest from pieces the caller already holds.
 * Pure — no I/O. Every argument is optional so a partially-analyzed dataset
 * still yields a valid (if sparse) label.
 *
 * @param {object} ctx
 * @param {object} [ctx.dataset]      { name, table, rowCount, columnCount|colCount, columnNames|columns, loadedAt }
 * @param {Array|object} [ctx.custody] A trail array (chain.getTrail()), a provenance chain object, or an attestation.chain object.
 * @param {Array<{ts:number,source:string,action:string}>} [ctx.assumptions] Assumption Ledger entries (ledger.getLedgerEntries()).
 * @param {Array<object>} [ctx.checks] Per-layer results ({layer|id,name,status,summary}) — from the export view's validation summary or a receipt's layers.
 * @param {boolean} [ctx.isSynthetic] Whether the data is synthetic/DP-generated. Default false; batch 4 sets this true for synthetic exports.
 * @param {number|Date} [ctx.generatedAt] Override the generation timestamp (tests).
 * @returns {object} A JSON-serializable Data Nutrition Label manifest.
 */
export function buildDataNutritionLabel(ctx = {}) {
  const ds = ctx.dataset || {};
  const trail = resolveTrail(ctx.custody);
  const assumptionsIn = Array.isArray(ctx.assumptions) ? ctx.assumptions : [];
  const checksIn = Array.isArray(ctx.checks) ? ctx.checks : [];
  const generatedAt = (ctx.generatedAt instanceof Date
    ? ctx.generatedAt
    : (ctx.generatedAt != null ? new Date(ctx.generatedAt) : new Date())).toISOString();

  const columnNames = Array.isArray(ds.columnNames)
    ? ds.columnNames.slice()
    : (Array.isArray(ds.columns)
        ? ds.columns.map((c) => (typeof c === 'string' ? c : (c && c.name))).filter(Boolean)
        : []);
  const columnCount = Number.isFinite(ds.columnCount)
    ? ds.columnCount
    : (Number.isFinite(ds.colCount) ? ds.colCount : columnNames.length);

  const dataset = {
    name: ds.name || ds.table || 'dataset',
    table: ds.table || null,
    rowCount: Number.isFinite(ds.rowCount) ? ds.rowCount : null,
    columnCount,
    columnNames,
    loadedAt: ds.loadedAt != null ? new Date(ds.loadedAt).toISOString() : null,
  };

  const checksRun = checksIn.map(normalizeCheck);
  const bySeverity = { pass: 0, warn: 0, fail: 0, idle: 0 };
  for (const c of checksRun) bySeverity[c.status] = (bySeverity[c.status] || 0) + 1;

  // custodyChain: the authoritative, tamper-evident record as produced by
  // js/provenance/provenance.js. We carry the hashes so a recipient can
  // re-verify with verifyChainArray() without DATAGLOW. finalHash is surfaced at
  // the top of the object so batch 3 can anchor a disclosure proof to it.
  const steps = trail.map((e) => ({
    index: e.index,
    op: e.op,
    description: e.description,
    detail: e.detail ?? null,
    ts: e.ts,
    parentHash: e.parentHash ?? null,
    hash: e.hash ?? null,
  }));
  const finalHash = steps.length ? steps[steps.length - 1].hash : null;
  const custodyChain = {
    algorithm: 'SHA-256 hash chain (Merkle-style linked hashes)',
    length: steps.length,
    finalHash,
    steps,
  };

  // transformations: a lightweight, human-readable PROJECTION of the same
  // custody steps (op + description + time), for a reader who wants "what was
  // done" without the hashes. It is derived from custodyChain, not a second
  // source of truth — the hashes in custodyChain remain authoritative.
  const transformations = steps.map((s) => ({
    step: s.index,
    op: s.op,
    description: s.description,
    at: s.ts != null ? new Date(s.ts).toISOString() : null,
  }));

  const assumptions = assumptionsIn.map((e) => ({
    at: e.ts != null ? new Date(e.ts).toISOString() : null,
    source: e.source || null,
    action: e.action || '',
  }));

  return {
    kind: LABEL_KIND,
    schemaVersion: LABEL_SCHEMA_VERSION,
    generatedAt,
    dataset,
    checksRun,
    findingsSummary: {
      total: checksRun.length,
      bySeverity,
    },
    transformations,
    assumptions,
    // Default false. Batch 4 (Governed Synthetic Data Passport) sets this true
    // and may attach a `synthetic` block alongside it; the field exists now so
    // the shape is forward-compatible.
    isSynthetic: ctx.isSynthetic === true,
    custodyChain,
    disclaimer: LABEL_DISCLAIMER,
  };
}

/**
 * Render the manifest as a plain-text summary suitable for embedding in the
 * exported PDF report or an .xlsx sheet. Returns an ARRAY of lines, matching the
 * line-oriented style buildReportLines() uses in js/export/export-report.js so
 * the two read as siblings. Use renderLabelSummary() for a single string.
 * @param {object} label A manifest from buildDataNutritionLabel.
 * @returns {string[]}
 */
export function renderLabelSummaryLines(label) {
  if (!label || label.kind !== LABEL_KIND) return ['Data Nutrition Label: (not available).'];
  const d = label.dataset || {};
  const f = label.findingsSummary || { total: 0, bySeverity: {} };
  const sev = f.bySeverity || {};
  const lines = [];
  lines.push('Data Nutrition Label');
  lines.push(`  (Summary manifest — not a certification. Schema v${label.schemaVersion}.)`);
  lines.push(`  Generated: ${label.generatedAt}`);
  lines.push(`  Dataset: ${d.name}${d.table ? `  (table: ${d.table})` : ''}`);
  const rows = d.rowCount != null ? d.rowCount.toLocaleString() : 'unknown';
  lines.push(`  Rows × Columns: ${rows} × ${d.columnCount != null ? d.columnCount : 'unknown'}`);
  if (d.columnNames && d.columnNames.length) {
    const shown = d.columnNames.slice(0, 30).join(', ');
    lines.push(`  Columns: ${shown}${d.columnNames.length > 30 ? ', …' : ''}`);
  }
  lines.push(`  Synthetic data: ${label.isSynthetic ? 'yes' : 'no'}`);
  lines.push('');
  lines.push(`  Checks run: ${f.total} `
    + `(${sev.pass || 0} passed, ${sev.warn || 0} warned, ${sev.fail || 0} failed, ${sev.idle || 0} not run)`);
  for (const c of label.checksRun || []) {
    lines.push(`    [${(c.status || 'idle').toUpperCase()}] ${c.name}`);
  }
  lines.push('');
  const tx = label.transformations || [];
  lines.push(`  Transformations recorded: ${tx.length}`);
  for (const t of tx) {
    lines.push(`    #${t.step} ${t.op}: ${t.description}`);
  }
  lines.push('');
  const asm = label.assumptions || [];
  lines.push(`  Assumptions logged: ${asm.length}`);
  for (const a of asm) {
    lines.push(`    (${a.source || 'unknown'}) ${a.action}`);
  }
  lines.push('');
  const chain = label.custodyChain || { length: 0, finalHash: null };
  lines.push(`  Chain of custody: ${chain.length} step(s)`
    + (chain.finalHash ? `, final hash ${String(chain.finalHash).slice(0, 16)}…` : '.'));
  return lines;
}

/**
 * Render the manifest as a single plain-text block (joined lines).
 * @param {object} label
 * @returns {string}
 */
export function renderLabelSummary(label) {
  return renderLabelSummaryLines(label).join('\n');
}

/**
 * Serialize the manifest to pretty-printed JSON. This is the portable,
 * machine-readable artifact a recipient inspects or re-verifies. Round-trips
 * losslessly via JSON.parse.
 * @param {object} label
 * @returns {string}
 */
export function exportLabelAsJSON(label) {
  return JSON.stringify(label, null, 2);
}
