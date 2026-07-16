// ============================================================
// DATAGLOW — Fuzzy Duplicate Radar
// ============================================================
// Surfaces near-duplicate text values for human review. Never
// auto-merges. Similarity is the max of two public string metrics.

import * as engine from '../app-shell/duckdb-engine.js';
import { isLikelyIdentifierColumn } from '../shared/identifier-columns.js';

const MAX_ROWS = 2000;

// ------------------------------------------------------------
// P0 safety guard — unique-identifier columns must never be fuzzy-matched.
//
// Bug this fixes (found 2026-07-15, Run 5 "Portfolio-readiness" test): this
// radar judges values by pure string similarity (Levenshtein/Jaro-Winkler)
// with no awareness of column semantics. On a business-key column such as
// claim_id, two unrelated identifiers can be textually "close" purely by
// digit permutation (e.g. "CLM100001" vs "CLM100010", or "CLM100001" vs
// "CLM101000") — confirmed live: this exact input produces 98%-confidence
// "Merge →" suggestions. Because the Clean tab's radar is presented as a
// destructive-merge candidate list, a false-positive pair on a unique-ID
// column is not a cosmetic miss — a user acting on it would silently
// collapse two distinct claims' or patients' records onto the same key.
//
// A near-identical NAME-based guard already exists in
// categorical-consistency.js (PR #198, 2026-07-12) but was never ported to
// this sibling module — this is the second, previously-unpatched code path
// the same bug class lived in. Both modules import the identical name-
// pattern regex from the shared, dependency-free js/shared/identifier-
// columns.js instead of hand-duplicating it a third time.
//
// Deliberately NAME-ONLY here, unlike categorical-consistency.js's guard
// (which also checks cardinality ratio). Cardinality-based near-uniqueness
// is the WRONG signal for this specific module: fuzzy-dedup's whole purpose
// is finding near-duplicates in free-text columns (patient names, company
// names) where every value being distinct is the expected, healthy case —
// applying a >=0.9-distinct-ratio guard here was tried and immediately
// broke the radar's own 100%-catch-rate benchmark on a genuine patient_name
// column (36 rows, 12 seeded near-dup pairs, ~35 distinct values — a ratio
// that trips a cardinality guard just as hard as a real identifier column
// would). categorical-consistency.js's guard exists for a different shape
// of column (bounded-vocabulary categoricals, where near-uniqueness really
// is anomalous) — the two modules share the name pattern but must NOT share
// the cardinality heuristic.
function isGuardedIdentifierColumn(columnName) {
  return isLikelyIdentifierColumn(columnName);
}

// Levenshtein edit distance (Levenshtein 1965, public algorithm).
export function levenshtein(a, b) {
  a = a || ''; b = b || '';
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// Normalized Levenshtein similarity in [0,1].
export function levenshteinSimilarity(a, b) {
  a = a || ''; b = b || '';
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// Jaro-Winkler similarity (Jaro 1989 / Winkler 1990, public algorithm).
export function jaroWinkler(a, b) {
  a = a || ''; b = b || '';
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  // Count transpositions.
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions) / m) / 3;

  // Winkler prefix bonus (up to 4 leading chars, scaling factor 0.1).
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// Combined similarity — take the stronger of the two metrics.
export function similarity(a, b) {
  return Math.max(levenshteinSimilarity(a, b), jaroWinkler(a, b));
}

function pickBestTextColumn(cols) {
  // Identifier-like columns are excluded from auto-selection at the source —
  // never let the radar default onto a unique-key column even by name-match
  // coincidence (a column named e.g. "customer_id" would otherwise match the
  // name-like preference below).
  const varchars = cols.filter(c => c.type === 'VARCHAR' && !isLikelyIdentifierColumn(c.name));
  if (varchars.length === 0) return null;
  // Prefer name-like columns; else first VARCHAR.
  return (varchars.find(c => /name|title|company|city|address|email|customer|vendor/i.test(c.name)) || varchars[0]).name;
}

export async function findFuzzyDuplicates(table, cols, options = {}) {
  const threshold = options.threshold != null ? options.threshold : 0.85;
  const column = options.column || pickBestTextColumn(cols);
  if (!column) return { column: null, pairs: [], warning: 'No text column available for fuzzy matching.' };

  const { rows: cntRows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table}`);
  const totalRows = cntRows[0].n || 0;
  let warning = null;
  if (totalRows > MAX_ROWS) {
    warning = `Table has ${totalRows.toLocaleString()} rows; fuzzy comparison capped at the first ${MAX_ROWS} for performance.`;
  }

  const { rows } = await engine.runQuery(
    `SELECT ROW_NUMBER() OVER () AS __rn, "${column}" AS v FROM ${table} WHERE "${column}" IS NOT NULL LIMIT ${MAX_ROWS}`
  );
  const items = rows.map(r => ({ rn: Number(r.__rn), value: String(r.v) }));

  // P0 guard, run BEFORE any similarity comparison — even an explicitly
  // passed `options.column` (not just the auto-picked default above) must
  // never reach the O(n^2) comparison loop below if it's identifier-like,
  // since an explicit caller-supplied column bypasses pickBestTextColumn
  // entirely.
  if (!options.skipIdentifierGuard && isGuardedIdentifierColumn(column)) {
    return {
      column,
      threshold,
      comparedRows: 0,
      pairs: [],
      warning: `"${column}" looks like a unique-identifier column by name — fuzzy matching is disabled here to avoid suggesting destructive merges between distinct records.`,
    };
  }

  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].value === items[j].value) continue; // exact dupes handled elsewhere
      const score = similarity(items[i].value, items[j].value);
      if (score > threshold) {
        pairs.push({
          rowA: items[i].rn,
          rowB: items[j].rn,
          column,
          similarity: Number(score.toFixed(3)),
          valueA: items[i].value,
          valueB: items[j].value,
        });
      }
    }
  }
  pairs.sort((a, b) => b.similarity - a.similarity);

  return { column, threshold, comparedRows: items.length, pairs, warning };
}
