// ============================================================
// DATAGLOW - De-identification screening receipt
// ============================================================
//
// The Safe Harbor verifier already does the work: it walks the eighteen HIPAA
// Safe Harbor categories against the columns and sampled values, and scores how
// easily a row could be re-identified from the indirect identifiers present.
// What it does not do is produce something a person can hand to someone else.
// This turns its report into that artifact.
//
// WHY THE VERDICT IS RENAMED ON THE WAY OUT.
// The verifier returns `pass`, `review` or `fail`. Those are fine as engine
// states and dangerous as printed words. A document that says "PASS" next to a
// hospital's dataset will be read as clearance to release it, and it is not:
// it means a pattern-matching screen did not recognise anything in the column
// names and the sampled values. It cannot see a free-text note with a name in
// it, it did not see the rows it was not given, and it has no view of the
// agreements that actually govern the data. So `pass` is printed as "nothing
// was flagged by this screen" and every rendering carries the same sentence
// saying what the screen could not look at.
//
// WHY THE DISCLAIMER IS A CONSTANT AND NOT AN ARGUMENT.
// This file gets forwarded. It will be read by someone who did not run it and
// has no idea how thin an automated screen is, and a page of clear rows reads
// as a certification to that person. A caller cannot pass a shorter disclaimer,
// cannot pass an empty one, and cannot suppress it, because the one time
// somebody wants to is exactly the time it needs to be there.
//
// This is not a HIPAA certification, it does not make anything HIPAA compliant,
// and nothing in this bundle claims otherwise.
//
// Pure. Builds a model and two renderings. Confirming and downloading belong to
// the surface.

export const DEID_RECEIPT_KIND = 'dataglow-deid-screening-receipt';
export const DEID_RECEIPT_VERSION = 1;

export const DEID_NOT_CERTIFICATION =
  'This is an automated screening aid, not a HIPAA certification. It does not certify that this dataset is de-identified, does not make it safe to release, and is not legal or clinical advice. A Safe Harbor determination is made by a person who is accountable for it.';

export const DEID_WHAT_IT_CANNOT_SEE =
  'What this screen cannot see: identifiers hidden in free text or notes, identifiers in rows it was not given, anything outside the columns and sampled values it was handed, and any agreement or policy that governs this data. A clear result is the absence of a match, not the presence of safety.';

export const DEID_NO_REPORT =
  'No screening result was supplied, so this receipt has nothing to report. Run the de-identification check first.';

/** Engine state to printed words. The mapping is the point of this file. */
export const VERDICT_LABELS = Object.freeze({
  pass: 'Nothing was flagged by this screen',
  review: 'Needs a human review',
  fail: 'Flagged by this screen',
});

export const VERDICT_MEANINGS = Object.freeze({
  pass: 'The screen did not recognise a Safe Harbor identifier in the column names or the sampled values, and the re-identification score came out low. That is not clearance to release.',
  review: 'No direct identifier was flagged, but enough indirect identifiers are present that a person could plausibly be singled out. A human needs to look at this before it goes anywhere.',
  fail: 'At least one Safe Harbor category matched, or the re-identification risk scored high. Treat this dataset as identifiable until that is resolved.',
});

export const RISK_MEANINGS = Object.freeze({
  low: 'Few indirect identifiers were found among the columns.',
  moderate: 'Enough indirect identifiers are present that combinations of them could narrow a row to a small group.',
  high: 'The combination of indirect identifiers present is known to single out individuals in real datasets.',
});

function str(v) {
  return typeof v === 'string' ? v : '';
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function escapeHtml(value) {
  return str(value === null || value === undefined ? '' : String(value))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Normalize the verifier's report into a receipt model. Tolerates a missing or
 * malformed report by saying so, because a receipt that renders an empty table
 * as a clean result would be the worst possible failure of this file.
 */
export function buildDeidReceipt(report, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const r = isPlainObject(report) ? report : null;

  if (!r) {
    return {
      kind: DEID_RECEIPT_KIND,
      version: DEID_RECEIPT_VERSION,
      available: false,
      problem: DEID_NO_REPORT,
      generatedAt: str(options.generatedAt),
      dataset: { table: null, rowCount: null, columnCount: 0 },
      verdict: null,
      verdictLabel: 'No result',
      verdictMeaning: DEID_NO_REPORT,
      flagged: [],
      clearCount: 0,
      flaggedCount: 0,
      risk: null,
      datasetFingerprint: str(options.datasetFingerprint),
      notCertification: DEID_NOT_CERTIFICATION,
      cannotSee: DEID_WHAT_IT_CANNOT_SEE,
    };
  }

  const sh = isPlainObject(r.safeHarbor) ? r.safeHarbor : { categories: [], flaggedCount: 0, clearCount: 0 };
  const categories = Array.isArray(sh.categories) ? sh.categories.filter(isPlainObject) : [];
  const flagged = categories
    .filter(c => str(c.status) === 'flag')
    .map(c => ({
      id: str(c.id),
      n: c.n,
      label: str(c.label),
      columns: (Array.isArray(c.matchedColumns) ? c.matchedColumns : [])
        .filter(isPlainObject)
        .map(m => ({ column: str(m.column), reason: str(m.reason) })),
    }));

  const reid = isPlainObject(r.reidentification) ? r.reidentification : null;
  const level = reid ? str(reid.level) : '';
  const verdict = str(r.verdict);

  return {
    kind: DEID_RECEIPT_KIND,
    version: DEID_RECEIPT_VERSION,
    available: true,
    problem: '',
    generatedAt: str(options.generatedAt) || str(r.generatedAt),
    dataset: {
      table: isPlainObject(r.dataset) ? (r.dataset.table || null) : null,
      rowCount: isPlainObject(r.dataset) && typeof r.dataset.rowCount === 'number' ? r.dataset.rowCount : null,
      columnCount: isPlainObject(r.dataset) && Array.isArray(r.dataset.columns) ? r.dataset.columns.length : 0,
    },
    verdict: verdict || null,
    verdictLabel: VERDICT_LABELS[verdict] || 'Not reported',
    verdictMeaning: VERDICT_MEANINGS[verdict] || 'The screen did not return a verdict this receipt recognises, so nothing is claimed about it.',
    categories,
    flagged,
    flaggedCount: typeof sh.flaggedCount === 'number' ? sh.flaggedCount : flagged.length,
    clearCount: typeof sh.clearCount === 'number' ? sh.clearCount : Math.max(0, categories.length - flagged.length),
    risk: reid
      ? {
          score: typeof reid.score === 'number' ? reid.score : null,
          level: level || null,
          levelMeaning: RISK_MEANINGS[level] || 'The screen did not return a risk level this receipt recognises.',
          present: Array.isArray(reid.present) ? reid.present.map(str) : [],
          quasiIdentifierCount: typeof reid.quasiIdentifierCount === 'number' ? reid.quasiIdentifierCount : null,
          rationale: str(reid.rationale),
        }
      : null,
    datasetFingerprint: str(options.datasetFingerprint),
    notCertification: DEID_NOT_CERTIFICATION,
    cannotSee: DEID_WHAT_IT_CANNOT_SEE,
  };
}

export function renderDeidReceiptMarkdown(model) {
  const m = isPlainObject(model) ? model : buildDeidReceipt(null);
  const out = ['# De-identification screening receipt', ''];
  out.push('**' + DEID_NOT_CERTIFICATION + '**', '');

  if (!m.available) {
    out.push(m.problem, '', DEID_WHAT_IT_CANNOT_SEE, '');
    return out.join('\n');
  }

  out.push('## Result', '');
  out.push('- Screen result: ' + m.verdictLabel);
  out.push('- What that means: ' + m.verdictMeaning);
  if (m.generatedAt) out.push('- Screened at: ' + m.generatedAt);
  if (m.dataset.table) out.push('- Table: ' + m.dataset.table);
  if (typeof m.dataset.rowCount === 'number') out.push('- Rows screened: ' + m.dataset.rowCount);
  out.push('- Columns screened: ' + m.dataset.columnCount);
  if (m.datasetFingerprint) out.push('- Dataset fingerprint: ' + m.datasetFingerprint);
  out.push('');

  out.push('## Safe Harbor categories', '');
  out.push('- Flagged: ' + m.flaggedCount);
  out.push('- Not flagged: ' + m.clearCount);
  out.push('');
  if (m.flagged.length) {
    out.push('| Category | Column | Why it was flagged |', '|---|---|---|');
    for (const f of m.flagged) {
      if (!f.columns.length) {
        out.push('| ' + cell(f.label) + ' | (not named) | flagged |');
        continue;
      }
      for (const c of f.columns) {
        out.push('| ' + cell(f.label) + ' | ' + cell(c.column) + ' | ' + cell(c.reason) + ' |');
      }
    }
    out.push('');
  } else {
    out.push('No Safe Harbor category matched. Read that as "this screen did not recognise one", not as "there is none".', '');
  }

  if (m.risk) {
    out.push('## Re-identification risk', '');
    if (m.risk.level) out.push('- Level: ' + m.risk.level);
    if (typeof m.risk.score === 'number') out.push('- Score: ' + m.risk.score + ' out of 100');
    out.push('- What that means: ' + m.risk.levelMeaning);
    if (m.risk.present.length) out.push('- Indirect identifiers present: ' + m.risk.present.join(', '));
    if (m.risk.rationale) out.push('- Detail: ' + m.risk.rationale);
    out.push('');
  }

  out.push('## Limits of this receipt', '');
  out.push(DEID_WHAT_IT_CANNOT_SEE, '');
  out.push('---', '', DEID_NOT_CERTIFICATION, '');
  return out.join('\n');
}

function cell(v) {
  return str(v === null || v === undefined ? '' : String(v)).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

const RECEIPT_CSS = [
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.55;',
  'max-width:820px;margin:0 auto;padding:32px 20px;color:#1a1a1a;background:#fff}',
  'h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:26px 0 8px}',
  '.dg-warn{border:2px solid #A12C7B;background:#fdf2f8;color:#7a1f5c;padding:12px 14px;',
  'border-radius:6px;margin:14px 0;font-weight:600}',
  '.dg-note{border-left:3px solid #999;background:#f6f6f6;padding:10px 14px;margin:14px 0;font-size:14px}',
  'table{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px}',
  'th,td{border:1px solid #ddd;padding:7px 9px;text-align:left;vertical-align:top}',
  'th{background:#f2f2f2}ul{margin:8px 0;padding-left:20px}',
  '.dg-verdict{font-size:17px;font-weight:700;margin:8px 0}',
].join('');

/** One self-contained HTML file. No script, no stylesheet link, no fetch: this
 *  document gets forwarded, and a forwarded page must not reach the network. */
export function renderDeidReceiptHTML(model) {
  const m = isPlainObject(model) ? model : buildDeidReceipt(null);
  const parts = [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>De-identification screening receipt</title>',
    '<style>' + RECEIPT_CSS + '</style></head><body>',
    '<h1>De-identification screening receipt</h1>',
    '<div class="dg-warn">' + escapeHtml(DEID_NOT_CERTIFICATION) + '</div>',
  ];

  if (!m.available) {
    parts.push('<p>' + escapeHtml(m.problem) + '</p>');
    parts.push('<div class="dg-note">' + escapeHtml(DEID_WHAT_IT_CANNOT_SEE) + '</div>');
    parts.push('</body></html>');
    return parts.join('\n');
  }

  parts.push('<h2>Result</h2>');
  parts.push('<div class="dg-verdict">' + escapeHtml(m.verdictLabel) + '</div>');
  parts.push('<p>' + escapeHtml(m.verdictMeaning) + '</p>');
  parts.push('<ul>');
  if (m.generatedAt) parts.push('<li>Screened at: ' + escapeHtml(m.generatedAt) + '</li>');
  if (m.dataset.table) parts.push('<li>Table: ' + escapeHtml(m.dataset.table) + '</li>');
  if (typeof m.dataset.rowCount === 'number') parts.push('<li>Rows screened: ' + escapeHtml(m.dataset.rowCount) + '</li>');
  parts.push('<li>Columns screened: ' + escapeHtml(m.dataset.columnCount) + '</li>');
  if (m.datasetFingerprint) parts.push('<li>Dataset fingerprint: ' + escapeHtml(m.datasetFingerprint) + '</li>');
  parts.push('</ul>');

  parts.push('<h2>Safe Harbor categories</h2>');
  parts.push('<p>Flagged: ' + escapeHtml(m.flaggedCount) + '. Not flagged: ' + escapeHtml(m.clearCount) + '.</p>');
  if (m.flagged.length) {
    parts.push('<table><thead><tr><th>Category</th><th>Column</th><th>Why it was flagged</th></tr></thead><tbody>');
    for (const f of m.flagged) {
      if (!f.columns.length) {
        parts.push('<tr><td>' + escapeHtml(f.label) + '</td><td>(not named)</td><td>flagged</td></tr>');
        continue;
      }
      for (const c of f.columns) {
        parts.push('<tr><td>' + escapeHtml(f.label) + '</td><td>' + escapeHtml(c.column) + '</td><td>' + escapeHtml(c.reason) + '</td></tr>');
      }
    }
    parts.push('</tbody></table>');
  } else {
    parts.push('<p>No Safe Harbor category matched. Read that as "this screen did not recognise one", not as "there is none".</p>');
  }

  if (m.risk) {
    parts.push('<h2>Re-identification risk</h2><ul>');
    if (m.risk.level) parts.push('<li>Level: ' + escapeHtml(m.risk.level) + '</li>');
    if (typeof m.risk.score === 'number') parts.push('<li>Score: ' + escapeHtml(m.risk.score) + ' out of 100</li>');
    parts.push('<li>' + escapeHtml(m.risk.levelMeaning) + '</li>');
    if (m.risk.present.length) parts.push('<li>Indirect identifiers present: ' + escapeHtml(m.risk.present.join(', ')) + '</li>');
    if (m.risk.rationale) parts.push('<li>' + escapeHtml(m.risk.rationale) + '</li>');
    parts.push('</ul>');
  }

  parts.push('<h2>Limits of this receipt</h2>');
  parts.push('<div class="dg-note">' + escapeHtml(DEID_WHAT_IT_CANNOT_SEE) + '</div>');
  parts.push('<div class="dg-warn">' + escapeHtml(DEID_NOT_CERTIFICATION) + '</div>');
  parts.push('</body></html>');
  return parts.join('\n');
}

export const DataGlowDeidReceipt = {
  DEID_RECEIPT_KIND,
  DEID_RECEIPT_VERSION,
  DEID_NOT_CERTIFICATION,
  DEID_WHAT_IT_CANNOT_SEE,
  DEID_NO_REPORT,
  VERDICT_LABELS,
  VERDICT_MEANINGS,
  RISK_MEANINGS,
  escapeHtml,
  buildDeidReceipt,
  renderDeidReceiptMarkdown,
  renderDeidReceiptHTML,
};

try {
  if (typeof window !== 'undefined') window.DataGlowDeidReceipt = DataGlowDeidReceipt;
} catch (_e) {}
