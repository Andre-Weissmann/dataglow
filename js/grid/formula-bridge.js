// ============================================================
// DATAGLOW — Formula Bridge (Univer formula ↔ DuckDB SQL bridge)
// ============================================================
// Pure-logic bridge between Univer's Excel-compatible formula engine
// (@univerjs/engine-formula — see docs/grid-integration.md section 1) and
// DataGlow's DuckDB-WASM query layer. This module does NOT parse formulas
// — Univer already parses/evaluates the Excel-grammar AST client-side and
// hands DataGlow the resulting cell values. What this module DOES do:
//
//   1. Maps well-known Excel formula names to their DuckDB SQL equivalents,
//      purely for documentation/audit purposes (e.g. Story View surfacing
//      "this SUM() is equivalent to running `SELECT SUM(amount) ...`" so an
//      analyst can trust that the grid and the validation spine agree).
//   2. Bridges Univer's computed formula RESULTS back into DataGlow's
//      Dataset object (buildFormulaAudit) so Story View / the validation
//      rail can reason about which cells are formulas vs. raw data.
//   3. Cross-checks a formula's result against the column's validation
//      health score, flagging results that are likely misleading (e.g. a
//      SUM of a column full of nulls silently returning 0).
//
// No Univer import, no DOM, no DuckDB connection — this is why it's testable
// in plain Node (see test/grid/formula-bridge.test.js).

// ------------------------------------------------------------
// FORMULA_SQL_MAP
// ------------------------------------------------------------

/**
 * Map of Excel formula names (as Univer's formula engine names them) to
 * their DuckDB SQL equivalents. `{col}` is replaced with the target column
 * name (quoted appropriately by the caller); `{op}`/`{val}` are used by
 * conditional aggregates like COUNTIF/SUMIF/AVERAGEIF.
 */
const FORMULA_SQL_MAP = Object.freeze({
  SUM: 'SUM({col})',
  AVERAGE: 'AVG({col})',
  COUNT: 'COUNT({col})',
  COUNTA: 'COUNT({col})',
  COUNTBLANK: 'COUNT(*) FILTER (WHERE {col} IS NULL)',
  COUNTIF: 'COUNT(*) FILTER (WHERE {col} {op} {val})',
  SUMIF: 'SUM({col}) FILTER (WHERE {col} {op} {val})',
  AVERAGEIF: 'AVG({col}) FILTER (WHERE {col} {op} {val})',
  MAX: 'MAX({col})',
  MIN: 'MIN({col})',
  STDEV: 'STDDEV({col})',
  STDEVP: 'STDDEV_POP({col})',
  VAR: 'VARIANCE({col})',
  VARP: 'VAR_POP({col})',
  MEDIAN: 'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {col})',
  DISTINCTCOUNT: 'COUNT(DISTINCT {col})',
  MODE: 'MODE() WITHIN GROUP (ORDER BY {col})',
  PRODUCT: 'PRODUCT({col})',
});

const FORMULA_NAMES = new Set(Object.keys(FORMULA_SQL_MAP));

// ------------------------------------------------------------
// isFormulaSupported
// ------------------------------------------------------------

/**
 * Checks if a formula name has a documented DuckDB SQL equivalent.
 * Case-insensitive; trims whitespace. Never throws on bad input.
 * @param {string} formulaName
 * @returns {boolean}
 */
function isFormulaSupported(formulaName) {
  if (!formulaName || typeof formulaName !== 'string') return false;
  return FORMULA_NAMES.has(formulaName.trim().toUpperCase());
}

// ------------------------------------------------------------
// getFormulaSQL
// ------------------------------------------------------------

/**
 * Returns the DuckDB SQL equivalent for a formula, with {col} replaced by
 * columnName (double-quoted per DuckDB identifier convention) and, for
 * conditional aggregates, {op}/{val} filled in from options.
 * @param {string} formulaName
 * @param {string} columnName
 * @param {{op?: string, val?: (string|number)}} options
 * @returns {string|null} SQL fragment, or null if formula is not supported
 */
function getFormulaSQL(formulaName, columnName, options = {}) {
  if (!isFormulaSupported(formulaName)) return null;
  if (!columnName || typeof columnName !== 'string') return null;

  const key = formulaName.trim().toUpperCase();
  const template = FORMULA_SQL_MAP[key];
  const quotedCol = quoteIdent(columnName);

  let sql = template.split('{col}').join(quotedCol);

  if (sql.includes('{op}') || sql.includes('{val}')) {
    const op = options.op || '=';
    const val = formatSqlLiteral(options.val);
    sql = sql.split('{op}').join(op).split('{val}').join(val);
  }

  return sql;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function formatSqlLiteral(val) {
  if (val === undefined || val === null) return 'NULL';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  return `'${String(val).replace(/'/g, "''")}'`;
}

// ------------------------------------------------------------
// buildFormulaAudit
// ------------------------------------------------------------

/**
 * Builds a column-level formula summary for Story View from a list of
 * formula cells discovered in a Univer sheet.
 * @param {Array<{cellRef:string, formulaName:string, columnName:string, result:*}>} formulaCells
 * @returns {{supportedCount:number, unsupportedCount:number, formulasByType:Object, sqlEquivalents:string[]}}
 */
function buildFormulaAudit(formulaCells) {
  const cells = Array.isArray(formulaCells) ? formulaCells : [];

  let supportedCount = 0;
  let unsupportedCount = 0;
  const formulasByType = {};
  const sqlEquivalents = [];

  for (const cell of cells) {
    if (!cell || !cell.formulaName) continue;
    const name = cell.formulaName.trim().toUpperCase();
    formulasByType[name] = (formulasByType[name] || 0) + 1;

    if (isFormulaSupported(name)) {
      supportedCount++;
      const sql = getFormulaSQL(name, cell.columnName || 'value');
      if (sql) sqlEquivalents.push(sql);
    } else {
      unsupportedCount++;
    }
  }

  return { supportedCount, unsupportedCount, formulasByType, sqlEquivalents };
}

// ------------------------------------------------------------
// validateFormulaResult
// ------------------------------------------------------------

/**
 * Cross-checks a formula's computed result against the column's validation
 * health score, to flag results that are numerically valid but potentially
 * misleading given known data-quality issues in that column.
 *
 * Heuristics (deliberately simple, display-layer signals — not statistics):
 *   - SUM/AVERAGE/MIN/MAX/STDEV/MEDIAN/VAR of a column with health < 0.8 and
 *     a result of exactly 0 (or null/undefined) is flagged as potentially
 *     misleading — it could mean "the data really is all zero" or it could
 *     mean "the column is mostly null/invalid and the aggregate collapsed
 *     silently to a default."
 *   - COUNT/COUNTA/DISTINCTCOUNT of a column with a low health score below
 *     0.5 is flagged as a lower-confidence read (counts under heavy
 *     data-quality erosion may not reflect the true population).
 *   - Any formula on a column with health >= 0.8 is considered consistent.
 *
 * @param {string} formulaName
 * @param {*} result
 * @param {number} columnHealthScore - 0.0–1.0, from buildColumnHealthScore in grid-bridge.js
 * @returns {{consistent: boolean, warning: string|null}}
 */
function validateFormulaResult(formulaName, result, columnHealthScore) {
  const name = (formulaName || '').trim().toUpperCase();
  const health = typeof columnHealthScore === 'number' ? columnHealthScore : 1.0;

  if (health >= 0.8) {
    return { consistent: true, warning: null };
  }

  const zeroLikeAggregates = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'STDEV', 'STDEVP', 'VAR', 'VARP', 'MEDIAN']);
  const isZeroLike = result === 0 || result === null || result === undefined || Number.isNaN(result);

  if (zeroLikeAggregates.has(name) && isZeroLike) {
    return {
      consistent: false,
      warning: `${name} returned ${result === null || result === undefined ? 'no value' : result} on a column with health score ${health.toFixed(2)} — this may reflect missing/invalid data rather than a true zero.`,
    };
  }

  const countAggregates = new Set(['COUNT', 'COUNTA', 'DISTINCTCOUNT']);
  if (countAggregates.has(name) && health < 0.5) {
    return {
      consistent: false,
      warning: `${name} was computed on a column with a low health score (${health.toFixed(2)}) — the count may not reflect the true population due to data-quality issues.`,
    };
  }

  return { consistent: true, warning: null };
}

// ------------------------------------------------------------
// exports
// ------------------------------------------------------------

export {
  FORMULA_SQL_MAP,
  isFormulaSupported,
  getFormulaSQL,
  buildFormulaAudit,
  validateFormulaResult,
};
