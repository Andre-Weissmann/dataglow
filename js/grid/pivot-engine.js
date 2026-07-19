// ============================================================
// DATAGLOW — Pivot Engine (Univer grid pivot layer)
// ============================================================
// Pure-logic pivot table engine. Builds on the GridDataset shape produced by
// js/grid/grid-bridge.js — it never imports Univer and never touches the
// DOM, so the whole surface here is testable in plain Node (see
// test/grid/pivot-engine.test.js).
//
// Data flow:
//   GridDataset + PivotConfig ─▶ buildPivotDescriptor() ─▶ PivotDescriptor
//   PivotDescriptor ─▶ pivotToGridDataset() ─▶ GridDataset ─▶ UI layer renders in Univer
//
// This module does NOT duplicate grid-bridge.js's column-health scoring or
// severity styling — pivot output cells are intentionally "neutral" (see
// pivotToGridDataset below), since a pivot is a derived/aggregated view and
// validation findings are anchored to raw source rows, not aggregates.

// ------------------------------------------------------------
// constants
// ------------------------------------------------------------

const VALID_AGGREGATIONS = new Set(['sum', 'avg', 'count', 'min', 'max']);
const GRAND_TOTAL_LABEL = 'Total';

// ------------------------------------------------------------
// small helpers
// ------------------------------------------------------------

function isNumeric(value) {
  if (value === null || value === undefined || value === '') return false;
  return typeof value === 'number' ? Number.isFinite(value) : Number.isFinite(Number(value));
}

function toNumber(value) {
  return typeof value === 'number' ? value : Number(value);
}

function compositeKey(values) {
  // Join with a separator unlikely to appear in real data, so
  // e.g. ["a","b"] and ["a|b"] don't collide.
  return values.map(v => (v === null || v === undefined ? '' : String(v))).join('\u0001');
}

function sortedUnique(values) {
  return Array.from(new Set(values)).sort((a, b) => {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

function rowMatchesFilters(row, filters) {
  if (!filters) return true;
  for (const [col, allowed] of Object.entries(filters)) {
    if (!Array.isArray(allowed) || allowed.length === 0) continue;
    const val = row[col];
    const strVal = val === null || val === undefined ? '' : String(val);
    if (!allowed.map(String).includes(strVal)) return false;
  }
  return true;
}

function buildGroupKey(row, fields) {
  if (!fields || fields.length === 0) return '';
  return compositeKey(fields.map(f => row[f]));
}

function buildGroupLabel(row, fields) {
  if (!fields || fields.length === 0) return GRAND_TOTAL_LABEL;
  return fields.map(f => (row[f] === null || row[f] === undefined ? '(blank)' : String(row[f]))).join(' / ');
}

// ------------------------------------------------------------
// validatePivotConfig
// ------------------------------------------------------------

/**
 * Validates a pivot config against a GridDataset's header schema, before
 * attempting to build a pivot descriptor from it.
 * @param {Object} gridDataset - a GridDataset as produced by grid-bridge.js's formatRowsForGrid
 * @param {Object} config - PivotConfig (see buildPivotDescriptor)
 * @returns {{valid: boolean, errors: string[]}}
 */
function validatePivotConfig(gridDataset, config) {
  const errors = [];
  const headers = (gridDataset && Array.isArray(gridDataset.headers)) ? gridDataset.headers : [];
  const headerByName = new Map(headers.map(h => [h.name, h]));

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['config is required'] };
  }

  const rowFields = Array.isArray(config.rowFields) ? config.rowFields : [];
  const colFields = Array.isArray(config.colFields) ? config.colFields : [];

  if (rowFields.length === 0) {
    errors.push('rowFields must contain at least one column name');
  }
  for (const f of rowFields) {
    if (!headerByName.has(f)) errors.push(`rowFields: column "${f}" does not exist in dataset`);
  }
  for (const f of colFields) {
    if (!headerByName.has(f)) errors.push(`colFields: column "${f}" does not exist in dataset`);
  }

  if (!config.valueField) {
    errors.push('valueField is required');
  } else if (!headerByName.has(config.valueField)) {
    errors.push(`valueField: column "${config.valueField}" does not exist in dataset`);
  }

  if (!config.aggregation) {
    errors.push('aggregation is required');
  } else if (!VALID_AGGREGATIONS.has(config.aggregation)) {
    errors.push(`aggregation: "${config.aggregation}" is not one of sum, avg, count, min, max`);
  }

  // Numeric requirement: sum/avg/min/max need a numeric valueField (count works on anything).
  if (config.aggregation && config.aggregation !== 'count' && config.valueField && headerByName.has(config.valueField)) {
    const header = headerByName.get(config.valueField);
    if (header.typeChip !== 'number') {
      errors.push(`valueField "${config.valueField}" must be numeric for aggregation "${config.aggregation}" (found typeChip "${header.typeChip}")`);
    }
  }

  if (config.filters && typeof config.filters === 'object') {
    for (const col of Object.keys(config.filters)) {
      if (!headerByName.has(col)) errors.push(`filters: column "${col}" does not exist in dataset`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ------------------------------------------------------------
// computePivotValues
// ------------------------------------------------------------

/**
 * Computes raw aggregation accumulators from plain row objects.
 * @param {Array<Object>} rows - plain objects keyed by column name
 * @param {Object} config - PivotConfig
 * @returns {Map<string, Map<string, {sum:number, count:number, min:number, max:number}>>}
 *   Outer map key: rowKey (composite of rowFields values)
 *   Inner map key: colKey (composite of colFields values, or '' if no colFields)
 */
function computePivotValues(rows, config) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const rowFields = Array.isArray(config.rowFields) ? config.rowFields : [];
  const colFields = Array.isArray(config.colFields) ? config.colFields : [];
  const valueField = config.valueField;
  const filters = config.filters;

  const result = new Map();

  for (const row of safeRows) {
    if (!row || !rowMatchesFilters(row, filters)) continue;

    const rowKey = buildGroupKey(row, rowFields);
    const colKey = buildGroupKey(row, colFields);

    if (!result.has(rowKey)) result.set(rowKey, new Map());
    const inner = result.get(rowKey);
    if (!inner.has(colKey)) inner.set(colKey, { sum: 0, count: 0, min: Infinity, max: -Infinity });

    const acc = inner.get(colKey);
    const rawValue = row[valueField];

    // count counts every matching row (even non-numeric/null values);
    // sum/avg/min/max only fold in values that parse as numbers.
    acc.count += 1;
    if (isNumeric(rawValue)) {
      const n = toNumber(rawValue);
      acc.sum += n;
      if (n < acc.min) acc.min = n;
      if (n > acc.max) acc.max = n;
    }
  }

  return result;
}

function accToAggregatedValue(acc, aggregation) {
  if (!acc) return { value: 0, count: 0 };
  switch (aggregation) {
    case 'sum':
      return { value: acc.sum, count: acc.count };
    case 'avg':
      return { value: acc.count > 0 ? acc.sum / acc.count : 0, count: acc.count };
    case 'count':
      return { value: acc.count, count: acc.count };
    case 'min':
      return { value: acc.min === Infinity ? 0 : acc.min, count: acc.count };
    case 'max':
      return { value: acc.max === -Infinity ? 0 : acc.max, count: acc.count };
    default:
      return { value: 0, count: acc.count };
  }
}

// ------------------------------------------------------------
// formatPivotValue
// ------------------------------------------------------------

/**
 * Formats a pivot aggregation value for display.
 * @param {number} value
 * @param {'sum'|'avg'|'count'|'min'|'max'} aggregation
 * @param {number} decimalPlaces
 * @returns {string}
 */
function formatPivotValue(value, aggregation, decimalPlaces = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  if (aggregation === 'count') {
    return String(Math.round(value));
  }
  const fixed = Number(value).toFixed(decimalPlaces);
  const [intPart, decPart] = fixed.split('.');
  const negative = intPart.startsWith('-');
  const digits = negative ? intPart.slice(1) : intPart;
  const withCommas = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const signedInt = negative ? `-${withCommas}` : withCommas;
  return decPart !== undefined ? `${signedInt}.${decPart}` : signedInt;
}

// ------------------------------------------------------------
// buildPivotDescriptor
// ------------------------------------------------------------

/**
 * Builds a pivot table descriptor from a GridDataset.
 * @param {Object} gridDataset - a GridDataset as produced by grid-bridge.js's formatRowsForGrid
 * @param {Object} config - {
 *   rowFields: string[], colFields?: string[], valueField: string,
 *   aggregation: 'sum'|'avg'|'count'|'min'|'max',
 *   filters?: { [columnName]: string[] }
 * }
 * @returns {Object} PivotDescriptor
 */
function buildPivotDescriptor(gridDataset, config) {
  const { valid, errors } = validatePivotConfig(gridDataset, config);
  if (!valid) {
    const err = new Error(`Invalid pivot config: ${errors.join('; ')}`);
    err.errors = errors;
    throw err;
  }

  const rowFields = config.rowFields;
  const colFields = Array.isArray(config.colFields) ? config.colFields : [];
  const aggregation = config.aggregation;

  // Convert GridDataset rows -> plain row objects keyed by column name.
  const plainRows = (gridDataset.rows || []).map(r => {
    const obj = {};
    for (const [colName, cell] of Object.entries(r.cells || {})) {
      obj[colName] = cell.value;
    }
    return obj;
  });

  const valuesMap = computePivotValues(plainRows, config);

  // Collect row/col group keys+labels, sorted by label for deterministic display.
  const rowKeyToLabel = new Map();
  const colKeyToLabel = new Map();
  for (const row of plainRows) {
    if (!rowMatchesFilters(row, config.filters)) continue;
    const rk = buildGroupKey(row, rowFields);
    const rl = buildGroupLabel(row, rowFields);
    if (!rowKeyToLabel.has(rk)) rowKeyToLabel.set(rk, rl);
    const ck = buildGroupKey(row, colFields);
    const cl = colFields.length ? buildGroupLabel(row, colFields) : '';
    if (!colKeyToLabel.has(ck)) colKeyToLabel.set(ck, cl);
  }

  const rowGroups = sortedUnique(Array.from(rowKeyToLabel.values()));
  const colGroups = colFields.length ? sortedUnique(Array.from(colKeyToLabel.values())) : [];

  // Reverse lookups: label -> key, since valuesMap is keyed by composite key not label.
  const labelToRowKey = new Map(Array.from(rowKeyToLabel.entries()).map(([k, v]) => [v, k]));
  const labelToColKey = new Map(Array.from(colKeyToLabel.entries()).map(([k, v]) => [v, k]));

  // ---- cells: one per rowGroup x colGroup (or rowGroup x '' if no colFields) ----
  const cells = [];
  const colGroupsForCells = colFields.length ? colGroups : [''];

  for (const rowLabel of rowGroups) {
    const rk = labelToRowKey.get(rowLabel);
    const inner = valuesMap.get(rk);
    for (const colLabel of colGroupsForCells) {
      const ck = colFields.length ? labelToColKey.get(colLabel) : '';
      const acc = inner ? inner.get(ck) : undefined;
      const { value, count } = accToAggregatedValue(acc, aggregation);
      cells.push({
        rowKey: rowLabel,
        colKey: colFields.length ? colLabel : GRAND_TOTAL_LABEL,
        value,
        count,
        formattedValue: formatPivotValue(value, aggregation),
      });
    }
  }

  // ---- row totals: aggregate across all colGroups for each rowGroup ----
  const rowTotals = rowGroups.map(rowLabel => {
    const rk = labelToRowKey.get(rowLabel);
    const inner = valuesMap.get(rk);
    const combined = combineAccumulators(inner ? Array.from(inner.values()) : []);
    const { value, count } = accToAggregatedValue(combined, aggregation);
    return {
      rowKey: rowLabel,
      colKey: GRAND_TOTAL_LABEL,
      value,
      count,
      formattedValue: formatPivotValue(value, aggregation),
    };
  });

  // ---- col totals: aggregate across all rowGroups for each colGroup ----
  const colTotals = colGroupsForCells.map(colLabel => {
    const ck = colFields.length ? labelToColKey.get(colLabel) : '';
    const accsForCol = [];
    for (const rowLabel of rowGroups) {
      const rk = labelToRowKey.get(rowLabel);
      const inner = valuesMap.get(rk);
      const acc = inner ? inner.get(ck) : undefined;
      if (acc) accsForCol.push(acc);
    }
    const combined = combineAccumulators(accsForCol);
    const { value, count } = accToAggregatedValue(combined, aggregation);
    return {
      rowKey: GRAND_TOTAL_LABEL,
      colKey: colFields.length ? colLabel : GRAND_TOTAL_LABEL,
      value,
      count,
      formattedValue: formatPivotValue(value, aggregation),
    };
  });

  // ---- grand total: aggregate across everything ----
  const allAccs = [];
  for (const inner of valuesMap.values()) {
    for (const acc of inner.values()) allAccs.push(acc);
  }
  const grandCombined = combineAccumulators(allAccs);
  const grand = accToAggregatedValue(grandCombined, aggregation);
  const grandCell = {
    rowKey: GRAND_TOTAL_LABEL,
    colKey: GRAND_TOTAL_LABEL,
    value: grand.value,
    count: grand.count,
    formattedValue: formatPivotValue(grand.value, aggregation),
  };

  return {
    config,
    rowGroups,
    colGroups,
    cells,
    totals: { row: rowTotals, col: colTotals, grand: grandCell },
  };
}

function combineAccumulators(accs) {
  const combined = { sum: 0, count: 0, min: Infinity, max: -Infinity };
  for (const acc of accs) {
    combined.sum += acc.sum;
    combined.count += acc.count;
    if (acc.min < combined.min) combined.min = acc.min;
    if (acc.max > combined.max) combined.max = acc.max;
  }
  return combined;
}

// ------------------------------------------------------------
// pivotToGridDataset
// ------------------------------------------------------------

/**
 * Converts a PivotDescriptor into a GridDataset-compatible shape so the UI
 * layer can render pivot output through the exact same
 * GridDataset -> Univer IWorkbookData pipeline used for raw data (see
 * docs/grid-integration.md section 3).
 *
 * Shape:
 *   - first column = row group labels ("__pivot_row__")
 *   - one column per colGroup (or a single "Total" column if no colFields)
 *   - a trailing "Total" column with row totals
 *   - a trailing "Total" row with col totals + the grand total
 *   - every header is typeChip 'pivot' with neutral health (no validation
 *     runs against derived/aggregated data)
 *
 * @param {Object} pivotDescriptor
 * @returns {Object} GridDataset
 */
function pivotToGridDataset(pivotDescriptor) {
  const { rowGroups, colGroups, cells, totals, config } = pivotDescriptor;
  const hasColFields = Array.isArray(config.colFields) && config.colFields.length > 0;
  const colLabels = hasColFields ? colGroups : [GRAND_TOTAL_LABEL];

  const rowLabelColumnName = '__pivot_row__';
  const columnNames = [rowLabelColumnName, ...colLabels, GRAND_TOTAL_LABEL === colLabels[colLabels.length - 1] ? null : GRAND_TOTAL_LABEL]
    .filter(Boolean);

  // Avoid duplicate "Total" if there's already exactly one colLabel called "Total"
  // (only possible when hasColFields is false, where colLabels = ['Total']).
  const finalColumnNames = hasColFields ? [rowLabelColumnName, ...colLabels, GRAND_TOTAL_LABEL] : [rowLabelColumnName, GRAND_TOTAL_LABEL];

  const neutralHealth = { score: 1.0, label: 'clean' };
  const headers = finalColumnNames.map(name => ({
    name,
    type: name === rowLabelColumnName ? 'VARCHAR' : 'DOUBLE',
    healthScore: neutralHealth.score,
    healthLabel: neutralHealth.label,
    typeChip: 'pivot',
  }));

  // Build a lookup: rowKey -> colKey -> cell
  const cellLookup = new Map();
  for (const c of cells) {
    if (!cellLookup.has(c.rowKey)) cellLookup.set(c.rowKey, new Map());
    cellLookup.get(c.rowKey).set(c.colKey, c);
  }
  const rowTotalLookup = new Map(totals.row.map(c => [c.rowKey, c]));
  const colTotalLookup = new Map(totals.col.map(c => [c.colKey, c]));

  const outRows = rowGroups.map((rowLabel, index) => {
    const rowCells = {};
    rowCells[rowLabelColumnName] = { value: rowLabel, displayValue: rowLabel };

    for (const colLabel of colLabels) {
      const cell = hasColFields
        ? cellLookup.get(rowLabel) && cellLookup.get(rowLabel).get(colLabel)
        : cellLookup.get(rowLabel) && cellLookup.get(rowLabel).get(GRAND_TOTAL_LABEL);
      const value = cell ? cell.value : 0;
      const formatted = cell ? cell.formattedValue : formatPivotValue(0, config.aggregation);
      rowCells[colLabel] = { value, displayValue: formatted };
    }

    const rowTotal = rowTotalLookup.get(rowLabel);
    rowCells[GRAND_TOTAL_LABEL] = {
      value: rowTotal ? rowTotal.value : 0,
      displayValue: rowTotal ? rowTotal.formattedValue : formatPivotValue(0, config.aggregation),
    };

    return { index, cells: rowCells, rowSeverity: 'clean' };
  });

  // ---- totals row (bottom) ----
  const totalsRowCells = {};
  totalsRowCells[rowLabelColumnName] = { value: GRAND_TOTAL_LABEL, displayValue: GRAND_TOTAL_LABEL };
  for (const colLabel of colLabels) {
    const colTotal = colTotalLookup.get(colLabel);
    totalsRowCells[colLabel] = {
      value: colTotal ? colTotal.value : 0,
      displayValue: colTotal ? colTotal.formattedValue : formatPivotValue(0, config.aggregation),
    };
  }
  totalsRowCells[GRAND_TOTAL_LABEL] = {
    value: totals.grand.value,
    displayValue: totals.grand.formattedValue,
  };
  outRows.push({ index: outRows.length, cells: totalsRowCells, rowSeverity: 'clean', isTotalsRow: true });

  return {
    headers,
    rows: outRows,
    stats: {
      totalRows: outRows.length,
      totalColumns: headers.length,
      warningRows: 0,
      errorRows: 0,
      criticalRows: 0,
      overallHealthScore: 1.0,
    },
    isPivot: true,
    pivotConfig: config,
  };
}

// ------------------------------------------------------------
// exports
// ------------------------------------------------------------

export {
  buildPivotDescriptor,
  computePivotValues,
  formatPivotValue,
  pivotToGridDataset,
  validatePivotConfig,
};
