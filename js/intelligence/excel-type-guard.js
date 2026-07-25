// ============================================================
// DATAGLOW - Excel type guard: identifiers a spreadsheet already destroyed
// ============================================================
//
// In 2016 a study found that roughly a fifth of published genomics papers with
// supplementary spreadsheets contained gene names that Excel had silently
// converted to dates. SEPT2 became 2-Sep. MARCH1 became 1-Mar. The authors did
// not do anything wrong; they opened a file. In 2020 the gene naming committee
// renamed the genes, because renaming twenty-seven genes turned out to be
// easier than changing Excel.
//
// That is the famous case. The same coercion eats a lot of other things:
// part numbers like 3-10 or 1E5, ISBNs and account codes that lose a leading
// zero, phone numbers, postcodes, version strings like 1.10 that become 1.1.
//
// WHAT THIS CAN AND CANNOT SEE.
// By the time a value reaches this product it is usually already a string, and
// the damage, if it happened, happened in Excel before the file was saved. So
// there are two different findings here and they are not the same claim:
//
//   `already_coerced`  a column of identifiers where some cells now look like
//                      dates or scientific notation. The conversion has already
//                      happened upstream and the original text may be gone.
//   `at_risk`          a column of identifiers that would be converted if this
//                      file were opened in a spreadsheet and saved. Nothing is
//                      wrong yet.
//
// Saying "we fixed your gene names" would be a lie in the first case, because
// 2-Sep does not carry enough information to know whether it was SEPT2 or
// SEPT02. So the guard names the column, shows the cells, and offers to keep
// the column as text. Recovering the original value is the person's call and
// sometimes it is not possible at all, which is worth saying out loud.
//
// WHY IT IS A PREVIEW AND A CONFIRM.
// Forcing a column to text is the right answer often and not always: a column
// of real dates that happens to be named something gene-like should stay a
// date. The detector is a heuristic and heuristics that apply themselves are
// how a repair tool becomes a thing people turn off.
//
// Pure. No DOM, no file handle, no network. Rows in, findings out.

export const TYPE_GUARD_KIND = 'dataglow-excel-type-guard';
export const TYPE_GUARD_VERSION = 1;

/** Below this share of matching cells a column is a coincidence, not a pattern. */
export const GUARD_MIN_SHARE = 0.15;

/** Cells sampled per column. Enough to be confident, small enough to be instant. */
export const GUARD_SAMPLE = 500;

/** How many offending cells a finding carries as evidence. */
export const GUARD_EXAMPLES = 8;

export const TYPE_GUARD_HONESTY =
  'This finds columns a spreadsheet would convert, and columns where it looks like one already did. It does not undo a conversion that happened before the file reached this page, because the original text is not in the file any more.';

/**
 * Values that look like what Excel turns an identifier into.
 *
 * `1-Mar` / `Mar-1` is the gene case. A bare `1.10E+05` is the scientific
 * notation case, which eats long numeric identifiers.
 */
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
const COERCED_DATE_RE = new RegExp('^(?:(\\d{1,2})[-/](' + MONTHS + ')|(' + MONTHS + ')[-/](\\d{1,2}))$', 'i');
const SCIENTIFIC_RE = /^[+-]?\d(?:\.\d+)?[eE][+-]?\d+$/;

/** Identifiers a spreadsheet would eat on the next save. */
const AT_RISK_DATE_RE = new RegExp('^(?:' + MONTHS + ')[0-9]{1,2}$|^[0-9]{1,2}(?:' + MONTHS + ')$', 'i');
const AT_RISK_SCIENTIFIC_RE = /^[0-9]+[eE][0-9]+$/;
const AT_RISK_LEADING_ZERO_RE = /^0[0-9]{3,}$/;
const AT_RISK_RATIO_RE = /^[0-9]{1,2}[-/][0-9]{1,2}$/;

const RULES = Object.freeze([
  Object.freeze({
    id: 'coerced-date',
    severity: 'already_coerced',
    test: v => COERCED_DATE_RE.test(v),
    label: 'Values that look like a spreadsheet already turned them into dates',
    detail: 'Cells such as 1-Mar are what Excel writes when it decides an identifier like MARCH1 was a date. The original text is not recoverable from the converted value, so this is a finding rather than a repair.',
  }),
  Object.freeze({
    id: 'coerced-scientific',
    severity: 'already_coerced',
    test: v => SCIENTIFIC_RE.test(v),
    label: 'Values already written in scientific notation',
    detail: 'A long numeric identifier stored as 1.23E+11 has lost its final digits. Widening the column does not bring them back; the file has to be produced again with the column as text.',
  }),
  Object.freeze({
    id: 'risk-gene-date',
    severity: 'at_risk',
    test: v => AT_RISK_DATE_RE.test(v),
    label: 'Identifiers a spreadsheet would convert to dates',
    detail: 'Values of the SEPT2 or 2SEP shape are converted on open by default in most spreadsheet software. They are intact here. They will not survive a round trip through a spreadsheet unless the column is imported as text.',
  }),
  Object.freeze({
    id: 'risk-scientific',
    severity: 'at_risk',
    test: v => AT_RISK_SCIENTIFIC_RE.test(v),
    label: 'Identifiers a spreadsheet would read as scientific notation',
    detail: 'A code like 1E5 is read as one hundred thousand. Intact here, lost on the next spreadsheet round trip.',
  }),
  Object.freeze({
    id: 'risk-leading-zero',
    severity: 'at_risk',
    test: v => AT_RISK_LEADING_ZERO_RE.test(v),
    label: 'Codes with a leading zero',
    detail: 'Account numbers, postcodes and product codes lose the leading zero when a column is read as a number. Keeping the column as text preserves it.',
  }),
  Object.freeze({
    id: 'risk-ratio-date',
    severity: 'at_risk',
    test: v => AT_RISK_RATIO_RE.test(v),
    label: 'Values of the form 3-10 that a spreadsheet reads as a date',
    detail: 'Part numbers, ratios and score lines in this shape become dates on open. Intact here.',
  }),
]);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return '';
}

function columnValues(rows, index, key) {
  const out = [];
  const cap = Math.min(rows.length, GUARD_SAMPLE);
  for (let i = 0; i < cap; i++) {
    const row = rows[i];
    let v;
    if (Array.isArray(row)) v = row[index];
    else if (isPlainObject(row)) v = row[key];
    const t = cellText(v);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Scan one column.
 *
 * Returns null when nothing crosses the threshold, so a caller can map and
 * filter without a shape check per column.
 */
export function scanColumn(name, values) {
  const vals = Array.isArray(values) ? values.map(cellText).filter(Boolean) : [];
  if (!vals.length) return null;

  let best = null;
  for (const rule of RULES) {
    const hits = [];
    for (const v of vals) {
      if (rule.test(v)) hits.push(v);
    }
    if (!hits.length) continue;
    const share = hits.length / vals.length;
    if (share < GUARD_MIN_SHARE) continue;
    // `already_coerced` outranks `at_risk` regardless of share: damage that has
    // happened matters more than damage that might.
    const better = !best
      || (best.severity === 'at_risk' && rule.severity === 'already_coerced')
      || (best.severity === rule.severity && share > best.share);
    if (better) {
      best = {
        column: name,
        ruleId: rule.id,
        severity: rule.severity,
        label: rule.label,
        detail: rule.detail,
        matched: hits.length,
        sampled: vals.length,
        share,
        sharePercent: Math.round(share * 1000) / 10,
        examples: hits.slice(0, GUARD_EXAMPLES),
      };
    }
  }
  return best;
}

/**
 * Scan a dataset.
 *
 * Accepts the two row shapes this product carries: arrays of arrays with a
 * separate `columns` list, and arrays of objects.
 *
 * @param {{columns?:Array<string>, rows?:Array}} [dataset]
 */
export function detectTypeRisks(dataset) {
  const ds = isPlainObject(dataset) ? dataset : {};
  const rows = Array.isArray(ds.rows) ? ds.rows : [];
  let columns = Array.isArray(ds.columns) ? ds.columns.slice() : [];
  if (!columns.length && rows.length && isPlainObject(rows[0])) columns = Object.keys(rows[0]);

  const findings = [];
  for (let i = 0; i < columns.length; i++) {
    const name = typeof columns[i] === 'string' ? columns[i] : String(columns[i] && columns[i].name || i);
    const found = scanColumn(name, columnValues(rows, i, name));
    if (found) findings.push(found);
  }

  const coerced = findings.filter(f => f.severity === 'already_coerced');
  const atRisk = findings.filter(f => f.severity === 'at_risk');

  return {
    kind: TYPE_GUARD_KIND,
    version: TYPE_GUARD_VERSION,
    scannedColumns: columns.length,
    sampledRows: Math.min(rows.length, GUARD_SAMPLE),
    totalRows: rows.length,
    findings,
    alreadyCoerced: coerced,
    atRisk,
    fired: findings.length > 0,
    honesty: TYPE_GUARD_HONESTY,
    headline: !findings.length
      ? 'No column looks like a spreadsheet ate it, and none is at risk of that on the next round trip.'
      : coerced.length
        ? coerced.length + ' column' + (coerced.length === 1 ? '' : 's') + ' contain values that a spreadsheet appears to have already converted'
        : atRisk.length + ' column' + (atRisk.length === 1 ? '' : 's') + ' hold identifiers a spreadsheet would convert on the next save',
  };
}

/**
 * What applying the guard would change, before it changes it.
 *
 * The only action offered is keeping the column as text, because that is the
 * only action that is safe in every case. Reversing a conversion is guesswork
 * and this module does not guess.
 */
export function previewGuard(detection, columnNames) {
  const det = isPlainObject(detection) ? detection : { findings: [] };
  const wanted = Array.isArray(columnNames) && columnNames.length
    ? columnNames
    : (det.findings || []).filter(f => f.severity === 'at_risk').map(f => f.column);

  const steps = [];
  const declined = [];
  for (const f of (det.findings || [])) {
    if (wanted.indexOf(f.column) < 0) continue;
    if (f.severity === 'already_coerced') {
      declined.push({
        column: f.column,
        why: 'The conversion is already in the file. Forcing this column to text preserves the converted value, it does not restore the original one.',
      });
      continue;
    }
    steps.push({
      op: 'holdAsText',
      column: f.column,
      why: f.label,
      affects: f.matched,
    });
  }

  return {
    kind: TYPE_GUARD_KIND,
    steps,
    declined,
    // Nothing has happened yet. The caller has to say so separately.
    applied: false,
    reversible: true,
    summary: steps.length
      ? 'Hold ' + steps.length + ' column' + (steps.length === 1 ? '' : 's') + ' as text. No cell value changes; the type does.'
      : 'Nothing to apply. Either no column is at risk, or the only findings are conversions that already happened.',
    confirmRequired: true,
    confirmPrompt: steps.length
      ? 'Keep ' + steps.map(s => s.column).join(', ') + ' as text?'
      : '',
  };
}

/**
 * The receipt line.
 *
 * Written when the guard fires and the person accepts, and written when the
 * person overrides it. An override is a decision and a decision without a
 * record is the thing this module exists to prevent.
 *
 * @param {object} detection
 * @param {'applied'|'overridden'|'clean'} outcome
 * @param {Array<string>} [columns]
 */
export function typeGuardReceiptLine(detection, outcome, columns) {
  const det = isPlainObject(detection) ? detection : {};
  const cols = Array.isArray(columns) && columns.length
    ? columns
    : (det.findings || []).map(f => f.column);
  const list = cols.join(', ');

  if (outcome === 'clean' || !det.fired) {
    return {
      kind: TYPE_GUARD_KIND,
      outcome: 'clean',
      severity: 'info',
      line: 'Import type guard ran over ' + (det.scannedColumns || 0)
        + ' column(s) and found nothing a spreadsheet would have converted.',
    };
  }
  if (outcome === 'overridden') {
    return {
      kind: TYPE_GUARD_KIND,
      outcome: 'overridden',
      severity: 'caution',
      line: 'Import type guard flagged ' + list + ' and the person chose to import unchanged. '
        + 'Values in those columns may be read as dates or numbers downstream.',
      columns: cols,
    };
  }
  return {
    kind: TYPE_GUARD_KIND,
    outcome: 'applied',
    severity: 'info',
    line: 'Import type guard held ' + list + ' as text, confirmed by the person importing. '
      + 'Cell values are unchanged; only the column type was pinned.',
    columns: cols,
  };
}

export const DataGlowExcelTypeGuard = {
  TYPE_GUARD_KIND,
  TYPE_GUARD_VERSION,
  GUARD_MIN_SHARE,
  GUARD_SAMPLE,
  GUARD_EXAMPLES,
  TYPE_GUARD_HONESTY,
  scanColumn,
  detectTypeRisks,
  previewGuard,
  typeGuardReceiptLine,
};

try {
  if (typeof window !== 'undefined') window.DataGlowExcelTypeGuard = DataGlowExcelTypeGuard;
} catch (_e) {}
