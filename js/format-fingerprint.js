// ============================================================
// DATAGLOW — Format Fingerprint Auto-Standardizer
// ============================================================
// Scans VARCHAR columns for three classic format problems:
//   (a) currency-contaminated numerics stored as text
//   (b) mixed date formats within one column
//   (c) fake-null sentinel strings ("N/A", "-", "unknown", …)
// Generates previewable DuckDB SQL only — never auto-applies,
// mirroring the human-approval pattern in clean.js applyFix.

import * as engine from './duckdb-engine.js';

const SAMPLE_SIZE = 100;
const CURRENCY_RE = /^\$?[\d,]+\.?\d*$/;
const FAKE_NULLS = ['null', 'n/a', 'na', 'none', '-', 'unknown', ''];

// Distinct date-format signatures we can tell apart from a string sample.
const DATE_PATTERNS = [
  { name: 'MM/DD/YYYY', re: /^\d{1,2}\/\d{1,2}\/\d{4}$/ },
  { name: 'YYYY-MM-DD', re: /^\d{4}-\d{1,2}-\d{1,2}$/ },
  { name: 'DD-MM-YYYY', re: /^\d{1,2}-\d{1,2}-\d{4}$/ },
  { name: 'DD.MM.YYYY', re: /^\d{1,2}\.\d{1,2}\.\d{4}$/ },
];

async function sampleValues(table, col) {
  const { rows } = await engine.runQuery(
    `SELECT "${col}" AS v FROM ${table} WHERE "${col}" IS NOT NULL LIMIT ${SAMPLE_SIZE}`
  );
  return rows.map(r => String(r.v));
}

export async function scanFormatIssues(table, cols) {
  const varcharCols = cols.filter(c => c.type === 'VARCHAR');
  const issues = [];

  for (const c of varcharCols) {
    const col = c.name;
    const values = await sampleValues(table, col);
    if (values.length === 0) continue;

    // (a) currency-symbol-contaminated numeric column stored as VARCHAR
    const currencyMatches = values.filter(v => CURRENCY_RE.test(v.trim()));
    const hasCurrencySymbol = currencyMatches.some(v => /[$,]/.test(v));
    if (currencyMatches.length / values.length > 0.7 && hasCurrencySymbol) {
      issues.push({
        column: col,
        issueType: 'currency_contaminated',
        detail: `${((currencyMatches.length / values.length) * 100).toFixed(0)}% of sampled values look like currency/numeric text (e.g. "${currencyMatches[0]}"). Stored as VARCHAR — arithmetic and aggregation will fail.`,
        sampleValues: currencyMatches.slice(0, 5),
        // Strip $ and thousands separators, then TRY_CAST to DOUBLE.
        suggestedFixSQL: `ALTER TABLE ${table} ADD COLUMN "${col}_num" DOUBLE;\nUPDATE ${table} SET "${col}_num" = TRY_CAST(REPLACE(REPLACE("${col}", '$', ''), ',', '') AS DOUBLE);`,
      });
    }

    // (b) mixed date formats
    const formatsFound = new Set();
    for (const v of values) {
      for (const p of DATE_PATTERNS) {
        if (p.re.test(v.trim())) formatsFound.add(p.name);
      }
    }
    if (formatsFound.size >= 2) {
      const fmts = [...formatsFound];
      issues.push({
        column: col,
        issueType: 'mixed_date_format',
        detail: `${fmts.length} distinct date formats detected in one column: ${fmts.join(', ')}. Downstream date parsing will be inconsistent.`,
        sampleValues: values.filter(v => DATE_PATTERNS.some(p => p.re.test(v.trim()))).slice(0, 5),
        // TRY_CAST lets DuckDB coerce ISO dates; the rest need manual mapping.
        suggestedFixSQL: `-- Standardize "${col}" to ISO (YYYY-MM-DD). Review before applying:\nALTER TABLE ${table} ADD COLUMN "${col}_date" DATE;\nUPDATE ${table} SET "${col}_date" = TRY_CAST("${col}" AS DATE);`,
      });
    }

    // (c) fake-null sentinel strings
    const fakeNullCounts = {};
    for (const v of values) {
      const norm = v.trim().toLowerCase();
      if (FAKE_NULLS.includes(norm)) fakeNullCounts[norm] = (fakeNullCounts[norm] || 0) + 1;
    }
    const fakeNullFound = Object.keys(fakeNullCounts);
    if (fakeNullFound.length > 0) {
      const inList = FAKE_NULLS.filter(s => s !== '')
        .map(s => `'${s.replace(/'/g, "''")}'`).join(', ');
      issues.push({
        column: col,
        issueType: 'fake_null',
        detail: `Fake-null sentinel string(s) found in sample: ${fakeNullFound.map(s => `"${s}"`).join(', ')}. These masquerade as data but mean "missing".`,
        sampleValues: fakeNullFound.slice(0, 5),
        // Convert sentinel strings (case-insensitive, trimmed) to real NULL.
        suggestedFixSQL: `UPDATE ${table} SET "${col}" = NULL WHERE LOWER(TRIM("${col}")) IN (${inList}) OR TRIM("${col}") = '';`,
      });
    }
  }

  return issues;
}
