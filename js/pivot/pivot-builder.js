// ============================================================
// DATAGLOW — Pivot Table Builder
// ============================================================
// Pure logic only (no DOM, no browser globals) so it runs identically in
// headless Node tests. js/runtimes-viz/pivot-ui.js owns the DOM/drag-drop
// wiring and calls into this module for every SQL-generation and shaping
// decision. This module never touches state or the DuckDB connection
// directly — main.js/pivot-ui.js pass in whatever schema/query-result data
// this module needs and run the SQL it returns.
//
// Design choice: DataGlow already ships a full SQL engine (DuckDB-WASM),
// and DuckDB has native PIVOT/UNPIVOT syntax (already recognized by the SQL
// tab's syntax highlighter). Rather than re-implement pivot aggregation in
// JS, this module generates a real DuckDB PIVOT query from the user's
// row/column/value picks and lets the existing engine do the work — this
// keeps pivot results consistent with every other tab's numbers (same
// engine, same NULL handling, same BigInt-safe coercion) and avoids a
// second, parallel aggregation implementation that could silently drift
// from the SQL tab's answers on the same data.

export const AGGREGATIONS = [
  { id: 'sum', label: 'Sum', sql: 'SUM' },
  { id: 'avg', label: 'Average', sql: 'AVG' },
  { id: 'count', label: 'Count', sql: 'COUNT' },
  { id: 'min', label: 'Min', sql: 'MIN' },
  { id: 'max', label: 'Max', sql: 'MAX' },
];

const AGG_BY_ID = new Map(AGGREGATIONS.map((a) => [a.id, a]));

// DuckDB DESCRIBE column_type strings that are safe to treat as numeric for
// the Values well. Deliberately conservative — anything not matched here
// (VARCHAR, DATE, BOOLEAN, etc.) is excluded from the numeric-only Values
// list, since SUM/AVG/MIN/MAX on a non-numeric column either errors or
// produces a meaningless lexicographic result.
const NUMERIC_TYPE_RE = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL|REAL)/i;

// Quote a DuckDB identifier (table/column name) defensively — double-quote
// with internal double-quotes escaped, so a column named e.g. "patient id"
// or one that happens to collide with a SQL keyword is always safe to
// interpolate. Never trust column names as pre-sanitized just because they
// came from DESCRIBE.
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Given DESCRIBE-shaped rows ([{column_name, column_type, ...}]), split into
// { allColumns, numericColumns } — the numeric list is what the Values well
// should offer; the full list is what Rows/Columns should offer (any column
// can be a grouping key, numeric or not).
export function classifyColumns(describeRows) {
  const allColumns = (describeRows || []).map((r) => r.column_name);
  const numericColumns = (describeRows || [])
    .filter((r) => NUMERIC_TYPE_RE.test(String(r.column_type || '')))
    .map((r) => r.column_name);
  return { allColumns, numericColumns };
}

// A pivot "well" config: { rows: [colName,...], columns: [colName,...],
// values: [{ column, agg }], sourceTable }. Rows/columns support multiple
// columns (composite grouping key); values supports multiple measures, each
// with its own aggregation, matching the Excel PivotTable mental model.
export function createEmptyConfig(sourceTable) {
  return { sourceTable, rows: [], columns: [], values: [] };
}

// Validate a config against the current schema before generating SQL. Never
// let a stale/removed column name (e.g. after switching datasets) reach the
// SQL builder silently — surface every problem, not just the first.
export function validateConfig(config, allColumns) {
  const errors = [];
  const known = new Set(allColumns || []);
  if (!config || !config.sourceTable) errors.push('No source table selected.');
  if (!config || config.rows.length === 0) errors.push('Add at least one column to Rows.');
  if (!config || config.values.length === 0) errors.push('Add at least one column to Values.');
  for (const c of [...(config?.rows || []), ...(config?.columns || [])]) {
    if (!known.has(c)) errors.push(`Column "${c}" is no longer in the dataset.`);
  }
  for (const v of config?.values || []) {
    if (!known.has(v.column)) errors.push(`Value column "${v.column}" is no longer in the dataset.`);
    if (!AGG_BY_ID.has(v.agg)) errors.push(`Unknown aggregation "${v.agg}" for "${v.column}".`);
  }
  return errors;
}

// Build the SQL for a config with NO Columns well populated -- a plain
// GROUP BY summary (still a valid, common pivot shape: "total X by Y", no
// cross-tab). Kept as its own function since DuckDB's PIVOT clause requires
// at least one pivot column; the group-by-only case is a distinct SQL shape.
export function buildGroupBySQL(config) {
  const rowCols = config.rows.map(quoteIdent);
  const selectParts = [...rowCols];
  const aliasFor = (v, idx) => `${AGG_BY_ID.get(v.agg).sql.toLowerCase()}_${v.column}`.replace(/[^a-zA-Z0-9_]/g, '_') || `value_${idx}`;
  config.values.forEach((v, idx) => {
    const agg = AGG_BY_ID.get(v.agg);
    const alias = aliasFor(v, idx);
    const expr = agg.id === 'count' ? `COUNT(${quoteIdent(v.column)})` : `${agg.sql}(${quoteIdent(v.column)})`;
    selectParts.push(`${expr} AS ${quoteIdent(alias)}`);
  });
  const sql = `SELECT ${selectParts.join(', ')}\nFROM ${quoteIdent(config.sourceTable)}\nGROUP BY ${rowCols.join(', ')}\nORDER BY ${rowCols.join(', ')}`;
  return sql;
}

// Build a DuckDB PIVOT query for a config WITH at least one Columns well
// entry. DuckDB's PIVOT syntax:
//   PIVOT source ON col1[, col2] USING agg(value_col) [AS alias][, ...]
//   GROUP BY row1[, row2]
// Multiple value measures each get their own USING clause item. DuckDB
// names each RESULT column "<pivot-value>_<using-alias>" whenever the USING
// clause carries an explicit alias (confirmed by direct execution, see
// test/pivot-builder.test.mjs) -- e.g. a Columns well on "payer" with values
// Aetna/Cigna and USING SUM(amount) AS sum produces columns "Aetna_sum" and
// "Cigna_sum", never bare "Aetna"/"Cigna". pivot-ui.js's result renderer
// must read column headers directly from the query result (never assume
// the raw pivot-column value is the header string) so this naming is
// handled generically instead of parsed/reverse-engineered.
export function buildPivotSQL(config) {
  const rowCols = config.rows.map(quoteIdent);
  const pivotCols = config.columns.map(quoteIdent);
  const usingParts = config.values.map((v, idx) => {
    const agg = AGG_BY_ID.get(v.agg);
    const expr = agg.id === 'count' ? `COUNT(${quoteIdent(v.column)})` : `${agg.sql}(${quoteIdent(v.column)})`;
    const alias = config.values.length > 1
      ? `${agg.sql.toLowerCase()}_${v.column}`.replace(/[^a-zA-Z0-9_]/g, '_')
      : agg.sql.toLowerCase();
    return `${expr} AS ${quoteIdent(alias)}`;
  });
  const sql = `PIVOT ${quoteIdent(config.sourceTable)}\nON ${pivotCols.join(', ')}\nUSING ${usingParts.join(', ')}\nGROUP BY ${rowCols.join(', ')}\nORDER BY ${rowCols.join(', ')}`;
  return sql;
}

// Single entry point: validate, then dispatch to the right SQL shape. Throws
// on validation failure with all errors joined -- callers should validate
// separately first if they want per-field error display instead of a single
// thrown message.
export function buildPivotQuery(config, allColumns) {
  const errors = validateConfig(config, allColumns);
  if (errors.length > 0) throw new Error(errors.join(' '));
  return config.columns.length > 0 ? buildPivotSQL(config) : buildGroupBySQL(config);
}

// Cap on distinct values allowed in a single Columns well entry before we
// refuse to auto-run the pivot and surface a warning instead. A pivot column
// with, say, 50,000 distinct claim IDs would generate a 50,000-column result
// table -- technically valid SQL, practically unusable and slow to render.
// This is a UI-layer safety check, not a DuckDB limitation.
export const MAX_PIVOT_CARDINALITY = 200;

export function buildCardinalityCheckSQL(sourceTable, pivotColumns) {
  const cols = pivotColumns.map(quoteIdent);
  // Distinct COMBINATIONS of all pivot columns, not per-column -- a 2-column
  // pivot's real column-explosion risk is the product of both columns'
  // cardinalities, not the larger of the two individually.
  return `SELECT COUNT(*) AS n FROM (SELECT DISTINCT ${cols.join(', ')} FROM ${quoteIdent(sourceTable)}) t`;
}
