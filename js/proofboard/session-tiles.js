/**
 * Real tiles from the dataset that is actually loaded.
 *
 * WHY THIS MODULE EXISTS AT ALL.
 * The Proof Board could have shipped with a handful of illustrative tiles so the
 * surface looks populated on first open. That is the single thing it must not
 * do. A demo number on a board whose entire promise is "every number shows its
 * work" is a number with a fabricated proof under it. So the board is built only
 * from figures this module can compute from the rows in memory, and when there
 * are no rows it returns an empty list and the surface shows its empty state.
 *
 * WHY EACH TILE CARRIES SQL IT DID NOT RUN.
 * The counts here are computed in JavaScript over the rows in memory, because
 * DataGlow does not require a query engine to be present. The SQL beside each
 * one is the query that returns the same number, written so a person can take it
 * to their own warehouse and check. That is the house pattern from Guided
 * Unpivot: ship the proof and the transform, and let the tests assert the two
 * agree. Every count in this file is therefore written twice, once as code and
 * once as SQL, and test/proof-board.test.mjs pins them against each other.
 *
 * WHY THE BADGE IS USUALLY `unknown`.
 * These tiles are arithmetic over the loaded rows. No gate has run on them, so
 * they are marked not checked. When a validation result is present on the
 * dataset the score tile carries it, and only that tile earns a real badge.
 *
 * Pure ES module: no DOM, no network.
 */
import { normalizeTile } from './proof-board.js';

/** Table name used in the generated SQL. Named once so every tile agrees. */
export const SQL_RELATION = 'your_table';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A cell is blank when there is nothing in it to count. */
export function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Double-quote an identifier for the generated SQL. */
export function quoteIdent(name) {
  return '"' + String(name === null || name === undefined ? '' : name).replace(/"/g, '""') + '"';
}

function columnNames(ds) {
  if (!isPlainObject(ds) || !Array.isArray(ds.columns)) return [];
  return ds.columns.map(function (c) {
    if (typeof c === 'string') return c;
    return isPlainObject(c) && typeof c.name === 'string' ? c.name : '';
  });
}

/**
 * Rows with no blank cell in any column.
 * The SQL beside it is the same predicate, one IS NOT NULL per column.
 */
export function countCompleteRows(rows, columnCount) {
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    let full = true;
    for (let c = 0; c < columnCount; c += 1) {
      if (isBlank(row[c])) { full = false; break; }
    }
    if (full) n += 1;
  }
  return n;
}

/** Blank cells per column, in column order. */
export function blanksByColumn(rows, columnCount) {
  const out = [];
  for (let c = 0; c < columnCount; c += 1) out.push(0);
  if (!Array.isArray(rows)) return out;
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < columnCount; c += 1) {
      if (isBlank(row[c])) out[c] += 1;
    }
  }
  return out;
}

/** Distinct non-blank values in one column. */
export function countDistinct(rows, colIndex) {
  if (!Array.isArray(rows)) return 0;
  const seen = Object.create(null);
  let n = 0;
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const v = row[colIndex];
    if (isBlank(v)) continue;
    const key = String(v);
    if (!seen[key]) { seen[key] = true; n += 1; }
  }
  return n;
}

/**
 * Build the tiles. Returns [] when there is nothing real to show.
 *
 * @param {{name?:string, columns?:Array, rows?:Array, score?:number}} dataset
 * @param {{fingerprint?:string, validationSummary?:string}} [opts]
 * @returns {Array<object>} normalized tiles
 */
export function tilesFromDataset(dataset, opts) {
  const o = isPlainObject(opts) ? opts : {};
  if (!isPlainObject(dataset)) return [];
  const names = columnNames(dataset);
  const rows = Array.isArray(dataset.rows) ? dataset.rows : [];
  if (names.length === 0 || rows.length === 0) return [];

  const fingerprint = typeof o.fingerprint === 'string' ? o.fingerprint : '';
  const raw = [];

  raw.push({
    id: 'rows',
    title: 'Rows loaded',
    value: rows.length,
    unit: 'rows',
    language: 'sql',
    engine: 'this device',
    sqlOrCode: 'SELECT COUNT(*) AS rows_loaded\nFROM ' + SQL_RELATION + ';',
    checksSummary: 'Counted from the rows held in memory on this device. Nothing was uploaded to '
      + 'produce this number.',
    datasetFingerprint: fingerprint,
  });

  const complete = countCompleteRows(rows, names.length);
  const notNullPredicate = names.map(function (n) { return '  ' + quoteIdent(n) + ' IS NOT NULL'; })
    .join('\n  AND ');
  raw.push({
    id: 'complete-rows',
    title: 'Rows with no blank cell',
    value: complete,
    unit: 'of ' + rows.length,
    language: 'sql',
    engine: 'this device',
    sqlOrCode: 'SELECT COUNT(*) AS complete_rows\nFROM ' + SQL_RELATION + '\nWHERE\n'
      + notNullPredicate + ';',
    checksSummary: complete === rows.length
      ? 'Every row is complete across all ' + names.length + ' columns.'
      : (rows.length - complete) + ' row(s) have at least one blank cell. A blank is counted as '
        + 'blank and never as a zero.',
    sourceCols: names.slice(),
    datasetFingerprint: fingerprint,
  });

  const blanks = blanksByColumn(rows, names.length);
  let worst = 0;
  for (let i = 1; i < blanks.length; i += 1) if (blanks[i] > blanks[worst]) worst = i;
  if (blanks[worst] > 0) {
    raw.push({
      id: 'emptiest-column',
      title: 'Blank cells in ' + names[worst],
      value: blanks[worst],
      unit: 'of ' + rows.length,
      language: 'sql',
      engine: 'this device',
      sqlOrCode: 'SELECT COUNT(*) AS blank_cells\nFROM ' + SQL_RELATION + '\nWHERE '
        + quoteIdent(names[worst]) + ' IS NULL;',
      checksSummary: 'The column with the most blanks. It is shown because a column that is mostly '
        + 'empty makes every average taken over it smaller than it looks.',
      sourceCols: [names[worst]],
      datasetFingerprint: fingerprint,
    });
  }

  const distinct = countDistinct(rows, 0);
  raw.push({
    id: 'distinct-first-column',
    title: 'Distinct values in ' + names[0],
    value: distinct,
    unit: '',
    language: 'sql',
    engine: 'this device',
    sqlOrCode: 'SELECT COUNT(DISTINCT ' + quoteIdent(names[0]) + ') AS distinct_values\nFROM '
      + SQL_RELATION + '\nWHERE ' + quoteIdent(names[0]) + ' IS NOT NULL;',
    checksSummary: distinct === rows.length
      ? 'Every value in this column is different, so it behaves like a key.'
      : 'Blank values are excluded from the count, the same way COUNT(DISTINCT) excludes NULL.',
    sourceCols: [names[0]],
    datasetFingerprint: fingerprint,
  });

  // Only real when the validation pass has actually run and left a score behind.
  if (typeof dataset.score === 'number' && Number.isFinite(dataset.score)) {
    raw.push({
      id: 'health-score',
      title: 'Data health score',
      value: dataset.score,
      unit: 'of 100',
      language: 'text',
      engine: 'DataGlow validation',
      sqlOrCode: 'Computed by the DataGlow validation pass over this dataset on this device.\n'
        + 'It is a summary of the checks that ran, not a query result, so there is no SQL\n'
        + 'that reproduces it.',
      gateBadge: dataset.score >= 80 ? 'clear' : (dataset.score >= 50 ? 'caution' : 'blocked'),
      checksSummary: (typeof o.validationSummary === 'string' && o.validationSummary
        ? o.validationSummary + ' '
        : 'From the validation pass that has already run on this dataset. ')
        + 'The badge bands that score: 80 and above reads as passed, 50 to 79 as passed with '
        + 'cautions, below 50 as blocked. The band is a summary of a check that ran, not a '
        + 'separate check.',
      datasetFingerprint: fingerprint,
    });
  }

  return raw.map(function (t, i) { return normalizeTile(t, i); });
}

export const DataGlowProofBoardTiles = {
  SQL_RELATION,
  isBlank,
  quoteIdent,
  countCompleteRows,
  blanksByColumn,
  countDistinct,
  tilesFromDataset,
};

try {
  if (typeof window !== 'undefined') window.DataGlowProofBoardTiles = DataGlowProofBoardTiles;
} catch (_e) { /* no window in Node tests */ }
