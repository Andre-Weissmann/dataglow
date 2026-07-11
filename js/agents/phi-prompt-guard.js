// ============================================================
// DATAGLOW — Open Floor: PHI / sensitive-field pre-submit prompt guard (Batch A)
// ============================================================
// A last checkpoint that runs BEFORE any text is handed to an LLM path — the
// WebLLM narrative/story engines (js/narrative/ondevice-llm.js,
// js/narrative/story.js) today, and any future natural-language-to-SQL path —
// so protected / sensitive values are redacted out of the prompt payload
// regardless of which model (on-device or remote) is behind it.
//
// TWO layers of classification, and BOTH always run:
//
//   1. Column-name classification via the EXISTING domain-pack sensitive-category
//      logic — `isSensitiveCategory` in js/validation/categorical-consistency.js,
//      the same predicate the healthcare pack's protected-category merge guard
//      uses (js/packs/builtin/healthcare.pack.js →
//      js/validation/domain-physics.js). We do NOT reinvent that list; we import
//      it. Any column whose NAME matches (race / ethnicity / insurance / payer /
//      gender / sex / religion / marital) has its VALUES redacted from the prompt.
//
//   2. A minimal, always-on value-pattern scan for the shapes that are sensitive
//      no matter what the column is called and no matter whether a domain pack is
//      active — SSN-shaped and MRN-shaped strings, plus emails and long digit
//      runs. This is what makes the guard useful even with NO pack selected: the
//      pattern scan does not depend on a healthcare pack (or any pack) being
//      loaded.
//
// EMPOWERMENT / PRIVACY POSTURE: the guard only ever REMOVES sensitive content
// before it would be sent; it never adds, rewrites for meaning, or blocks a
// legitimate non-sensitive prompt. It returns both the redacted payload and a
// findings list so a caller can decide whether to warn the user. Pure, no DOM,
// no network, no storage — unit-testable in Node.

import { isSensitiveCategory } from '../validation/categorical-consistency.js';

// Minimal, always-on sensitive value patterns. These are deliberately generic
// SHAPES, not a domain pack: they fire even when no pack is active. Order
// matters only for the label attached to a match; redaction is idempotent.
export const DEFAULT_SENSITIVE_PATTERNS = Object.freeze([
  // US Social Security number: 3-2-4 digits with - or space separators.
  { id: 'ssn', label: 'SSN', re: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g },
  // Medical record number: an "MRN"/"medical record" label followed by digits.
  { id: 'mrn', label: 'MRN', re: /\b(?:mrn|medical\s+record(?:\s+(?:no|number|#))?)\s*[:#]?\s*[A-Z]?\d{5,}\b/gi },
  // Email address.
  { id: 'email', label: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // A long bare digit run (>=9 digits) — catches unlabelled SSNs, account/record
  // ids. Kept last and word-bounded so ordinary counts (e.g. "1250 rows") are
  // untouched; 9 digits is above any plausible small count in a prompt summary.
  { id: 'longdigits', label: 'ID', re: /\b\d{9,}\b/g },
]);

const REDACTION = (label) => `[REDACTED:${label}]`;

/**
 * Which of the given column names are sensitive, per the shared domain-pack
 * classifier. Pure; independent of whether any pack is active (the predicate is
 * a name-shape test, not a pack lookup).
 * @param {string[]} columns
 * @returns {string[]} the subset that is sensitive
 */
export function classifySensitiveColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns.filter((c) => isSensitiveCategory(c));
}

/**
 * Redact the always-on sensitive value patterns from a free-text string.
 * @param {string} text
 * @param {{patterns?:Array}} [opts]
 * @returns {{text:string, findings:Array<{type:string, pattern:string, count:number}>}}
 */
export function redactSensitiveText(text, { patterns = DEFAULT_SENSITIVE_PATTERNS } = {}) {
  const findings = [];
  if (typeof text !== 'string' || text === '') return { text: text ?? '', findings };
  let out = text;
  for (const p of patterns) {
    let count = 0;
    out = out.replace(new RegExp(p.re.source, p.re.flags), () => { count++; return REDACTION(p.label); });
    if (count > 0) findings.push({ type: 'pattern', pattern: p.id, count });
  }
  return { text: out, findings };
}

/**
 * Redact sensitive columns out of structured sample rows before they are
 * serialized into a prompt, AND pattern-scan every remaining value. Sensitive
 * columns are dropped entirely (their presence alone can be identifying); the
 * remaining values are pattern-redacted in place. Never mutates the input rows.
 *
 * @param {Array<object>} rows      sample rows (the {col: value} shape)
 * @param {string[]} columns        the column names present
 * @param {{patterns?:Array, sensitiveColumns?:string[]}} [opts]
 * @returns {{rows:Array<object>, droppedColumns:string[], findings:Array}}
 */
export function redactSampleRows(rows, columns, opts = {}) {
  const findings = [];
  if (!Array.isArray(rows)) return { rows: [], droppedColumns: [], findings };
  const cols = Array.isArray(columns) && columns.length
    ? columns
    : (rows.length ? Object.keys(rows[0]) : []);
  const sensitive = new Set(
    Array.isArray(opts.sensitiveColumns) ? opts.sensitiveColumns : classifySensitiveColumns(cols)
  );
  const patterns = opts.patterns || DEFAULT_SENSITIVE_PATTERNS;
  const droppedColumns = cols.filter((c) => sensitive.has(c));
  if (droppedColumns.length) findings.push({ type: 'column', columns: droppedColumns.slice() });

  const safeRows = rows.map((r) => {
    const out = {};
    for (const c of cols) {
      if (sensitive.has(c)) continue; // drop sensitive column value entirely
      const v = r ? r[c] : undefined;
      if (typeof v === 'string') {
        const { text, findings: f } = redactSensitiveText(v, { patterns });
        out[c] = text;
        for (const one of f) findings.push({ ...one, column: c });
      } else {
        out[c] = v;
      }
    }
    return out;
  });
  return { rows: safeRows, droppedColumns, findings };
}

/**
 * The single pre-submit entry point a caller uses right before sending text into
 * an LLM path. Handles both a free-text prompt and (optionally) the structured
 * sample rows the prompt is built from. Returns a redacted payload plus a
 * findings list and a `sensitiveFound` flag the caller can surface as a warning.
 *
 * Runs identically with or without a domain pack: the column classifier is a
 * name-shape predicate and the value scan is always on.
 *
 * @param {object} payload
 * @param {string} [payload.text]        free-text prompt / user question
 * @param {Array<object>} [payload.rows] structured sample rows to be embedded
 * @param {string[]} [payload.columns]   the columns present in `rows`
 * @param {object} [opts]
 * @returns {{text:string, rows:Array<object>|null, droppedColumns:string[],
 *   findings:Array, sensitiveFound:boolean}}
 */
export function guardPromptPayload({ text = '', rows = null, columns = [] } = {}, opts = {}) {
  const findings = [];
  const { text: safeText, findings: textFindings } = redactSensitiveText(text, opts);
  for (const f of textFindings) findings.push({ ...f, in: 'text' });

  let safeRows = null;
  let droppedColumns = [];
  if (Array.isArray(rows)) {
    const r = redactSampleRows(rows, columns, opts);
    safeRows = r.rows;
    droppedColumns = r.droppedColumns;
    for (const f of r.findings) findings.push({ ...f, in: 'rows' });
  }

  return {
    text: safeText,
    rows: safeRows,
    droppedColumns,
    findings,
    sensitiveFound: findings.length > 0,
  };
}
