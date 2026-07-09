// ============================================================
// DATAGLOW — Fuzzy Duplicate Radar
// ============================================================
// Surfaces near-duplicate text values for human review. Never
// auto-merges. Similarity is the max of two public string metrics.

import * as engine from '../app-shell/duckdb-engine.js';

const MAX_ROWS = 2000;

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
  const varchars = cols.filter(c => c.type === 'VARCHAR');
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
