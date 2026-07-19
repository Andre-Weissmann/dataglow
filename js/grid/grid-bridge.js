// ============================================================
// DATAGLOW — Grid Bridge (Univer data contract layer)
// ============================================================
// This module is the DATA CONTRACT layer between DataGlow's validation spine
// (js/validation/*.js) and the Univer spreadsheet grid UI (DataGlow Grid,
// Tier 1 of the DataGlow Canvas feature set). It defines plain-data shapes
// and style descriptors — it never touches the DOM and never imports Univer.
//
// Why the split:
//   • Univer (https://univer.ai, Apache-2.0) is a full npm package loaded by
//     the UI layer only — via CDN <script> tags or an npm dependency. This
//     module has ZERO import of @univerjs/* anything, so the data contracts
//     below are testable in plain Node (see test/grid/grid-bridge.test.js)
//     without a browser runtime or a DOM.
//   • The UI layer is responsible for turning a GridDataset (below) into a
//     Univer IWorkbookData snapshot, and for turning the style descriptors
//     returned by mapSeverityToStyle() into calls against Univer's
//     `setCellStyle()` / range-style APIs. That conversion logic — plus the
//     CDN script tags, IWorkbookData shape, and custom-cell-renderer pattern
//     for agent diffs — is documented in docs/grid-integration.md.
//
// Data flow at a glance:
//   DuckDB rows + columns  ─┐
//   validation findings    ─┼─▶ formatRowsForGrid() ─▶ GridDataset ─▶ UI layer ─▶ Univer sheet
//   agent-proposed edits   ─┘        (this module)                      (renders + tints)
//
// Nothing in this file is DataGlow-Grid-feature-flag-specific; it is pure
// data transformation with no side effects, so callers can unit test it,
// snapshot it, or replay it against golden fixtures freely.

// ------------------------------------------------------------
// Column type → short display chip
// ------------------------------------------------------------

const TYPE_CHIP_MAP = {
  VARCHAR: 'text',
  TEXT: 'text',
  STRING: 'text',
  CHAR: 'text',
  DOUBLE: 'number',
  FLOAT: 'number',
  REAL: 'number',
  DECIMAL: 'number',
  NUMERIC: 'number',
  INTEGER: 'number',
  INT: 'number',
  BIGINT: 'number',
  SMALLINT: 'number',
  TINYINT: 'number',
  HUGEINT: 'number',
  DATE: 'date',
  TIMESTAMP: 'date',
  TIMESTAMPTZ: 'date',
  TIME: 'date',
  BOOLEAN: 'bool',
  BOOL: 'bool',
};

/**
 * Maps a DuckDB column type string to a short display chip used in the
 * Univer column header row (e.g. "text", "number", "date", "bool", "other").
 * Unknown/exotic DuckDB types (STRUCT, LIST, MAP, BLOB, UUID, etc.) fall back
 * to 'other' rather than throwing, since the header schema must never block
 * rendering on an unrecognized type.
 * @param {string} type
 * @returns {string}
 */
function typeToChip(type) {
  if (!type) return 'other';
  const key = String(type).toUpperCase().trim();
  return TYPE_CHIP_MAP[key] || 'other';
}

// ------------------------------------------------------------
// Severity ordering / helpers
// ------------------------------------------------------------

const SEVERITY_RANK = { clean: 0, warning: 1, error: 2, critical: 3 };
const VALID_SEVERITIES = new Set(['warning', 'error', 'critical']);

function worstSeverity(a, b) {
  return (SEVERITY_RANK[a] || 0) >= (SEVERITY_RANK[b] || 0) ? a : b;
}

function healthLabelForScore(score) {
  if (score < 0.5) return 'error';
  if (score < 0.8) return 'warning';
  return 'clean';
}

// ------------------------------------------------------------
// buildColumnHealthScore
// ------------------------------------------------------------

/**
 * Computes a per-column health score from validation findings.
 *
 * Scoring rule (deliberately simple and deterministic — this is a *display*
 * signal for the grid header chip, not a statistical model):
 *   start at 1.0
 *   − 0.1 per row with a 'warning' finding on this column
 *   − 0.2 per row with an 'error' finding on this column
 *   − 0.3 per row with a 'critical' finding on this column
 *   floored at 0.0
 *
 * Each finding is counted once per (rowIndex, columnName) — a row with two
 * warning findings on the same column still only counts once, since the
 * score models "how much of this column is affected," not raw finding volume.
 *
 * @param {string} columnName
 * @param {Array<{rowIndex:number, columnName:string, severity:string, message?:string}>} validationFindings
 * @param {number} totalRows - reserved for future normalization by dataset size; accepted for API stability.
 * @returns {{score:number, label:'clean'|'warning'|'error', warningCount:number, errorCount:number, criticalCount:number}}
 */
function buildColumnHealthScore(columnName, validationFindings, totalRows) {
  const findings = Array.isArray(validationFindings) ? validationFindings : [];

  // Dedupe by rowIndex so a row contributes at most once per severity bucket
  // for this column (see scoring rule above).
  const warningRows = new Set();
  const errorRows = new Set();
  const criticalRows = new Set();

  for (const f of findings) {
    if (!f || f.columnName !== columnName) continue;
    if (f.severity === 'warning') warningRows.add(f.rowIndex);
    else if (f.severity === 'error') errorRows.add(f.rowIndex);
    else if (f.severity === 'critical') criticalRows.add(f.rowIndex);
  }

  const warningCount = warningRows.size;
  const errorCount = errorRows.size;
  const criticalCount = criticalRows.size;

  let score = 1.0 - warningCount * 0.1 - errorCount * 0.2 - criticalCount * 0.3;
  if (score < 0) score = 0;
  // Guard against floating point artifacts (e.g. 0.7999999999999999).
  score = Math.round(score * 1000) / 1000;

  return {
    score,
    label: healthLabelForScore(score),
    warningCount,
    errorCount,
    criticalCount,
  };
}

// ------------------------------------------------------------
// mapSeverityToStyle
// ------------------------------------------------------------

const SEVERITY_STYLES = Object.freeze({
  warning: Object.freeze({ backgroundColor: '#FFF3E0', borderLeft: '3px solid #964219' }),
  error: Object.freeze({ backgroundColor: '#FCE4EC', borderLeft: '3px solid #A12C7B' }),
  critical: Object.freeze({ backgroundColor: '#FFEBEE', borderLeft: '3px solid #C62828', pulse: true }),
  clean: Object.freeze({ backgroundColor: null, borderLeft: null }),
});

/**
 * Maps a validation severity (or row/column rollup severity) to a style
 * descriptor. This descriptor is UI-framework-agnostic; the UI layer applies
 * it to Univer cells via `setCellStyle()` (see docs/grid-integration.md).
 * Unknown severities fall back to the 'clean' (no-op) descriptor so a bad
 * value never produces an undefined style.
 * @param {'clean'|'warning'|'error'|'critical'} severity
 * @returns {{backgroundColor: string|null, borderLeft: string|null, pulse?: boolean}}
 */
function mapSeverityToStyle(severity) {
  return SEVERITY_STYLES[severity] || SEVERITY_STYLES.clean;
}

// ------------------------------------------------------------
// formatRowsForGrid
// ------------------------------------------------------------

/**
 * Converts a DuckDB query result (rows + column metadata) plus validation
 * findings into a GridDataset — the single shape the UI layer needs to
 * render (and tint) a Univer sheet.
 *
 * @param {Array<Object>} rows - row objects keyed by column name
 * @param {Array<{name:string, type:string}>} columns
 * @param {Array<{rowIndex:number, columnName:string, severity:string, message?:string}>} validationFindings
 * @returns {Object} GridDataset
 */
function formatRowsForGrid(rows, columns, validationFindings) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeColumns = Array.isArray(columns) ? columns : [];
  const findings = (Array.isArray(validationFindings) ? validationFindings : [])
    .filter(f => f && VALID_SEVERITIES.has(f.severity));

  const totalRows = safeRows.length;
  const totalColumns = safeColumns.length;

  // ---- headers ----
  const headers = safeColumns.map(col => {
    const health = buildColumnHealthScore(col.name, findings, totalRows);
    return {
      name: col.name,
      type: col.type,
      healthScore: health.score,
      healthLabel: health.label,
      typeChip: typeToChip(col.type),
    };
  });

  // ---- per-row finding rollup: rowIndex -> worst severity ----
  const rowSeverityMap = new Map();
  for (const f of findings) {
    const current = rowSeverityMap.get(f.rowIndex) || 'clean';
    rowSeverityMap.set(f.rowIndex, worstSeverity(current, f.severity));
  }

  // ---- rows ----
  let warningRows = 0;
  let errorRows = 0;
  let criticalRows = 0;

  const outRows = safeRows.map((row, index) => {
    const cells = {};
    for (const col of safeColumns) {
      const value = row == null ? undefined : row[col.name];
      cells[col.name] = { value, displayValue: value == null ? '' : String(value) };
    }
    const rowSeverity = rowSeverityMap.get(index) || 'clean';
    if (rowSeverity === 'warning') warningRows++;
    else if (rowSeverity === 'error') errorRows++;
    else if (rowSeverity === 'critical') criticalRows++;

    return { index, cells, rowSeverity };
  });

  // ---- overall health score: weighted average of column health scores ----
  // "Weighted" by column presence — every header contributes equally today
  // (uniform weighting), which is equivalent to a plain mean. The weighted
  // form is kept explicit (rather than collapsing to a raw average) so a
  // future weighting scheme (e.g. by column cardinality or PII sensitivity)
  // can be introduced without changing this function's return contract.
  const overallHealthScore = headers.length
    ? Math.round((headers.reduce((sum, h) => sum + h.healthScore, 0) / headers.length) * 1000) / 1000
    : 1.0;

  return {
    headers,
    rows: outRows,
    stats: {
      totalRows,
      totalColumns,
      warningRows,
      errorRows,
      criticalRows,
      overallHealthScore,
    },
  };
}

// ------------------------------------------------------------
// buildAgentDiff
// ------------------------------------------------------------

/**
 * Builds a descriptor for a single agent-proposed cell edit. The UI layer
 * renders this as an inline diff overlay on the Univer grid (strikethrough
 * original + green proposed value, with Accept/Dismiss buttons) — see
 * docs/grid-integration.md for the custom-cell-renderer pattern.
 *
 * diffType detection:
 *   'clear'   — proposedValue is null/undefined (agent proposes removing a value)
 *   'fill'    — originalValue is null/undefined (agent proposes filling an empty cell)
 *   'replace' — both originalValue and proposedValue are present
 *
 * @param {string} columnName
 * @param {number} rowIndex
 * @param {*} originalValue
 * @param {*} proposedValue
 * @param {string} reason
 * @returns {Object} AgentDiff
 */
function buildAgentDiff(columnName, rowIndex, originalValue, proposedValue, reason) {
  const originalIsEmpty = originalValue === null || originalValue === undefined;
  const proposedIsEmpty = proposedValue === null || proposedValue === undefined;

  let diffType;
  if (proposedIsEmpty) diffType = 'clear';
  else if (originalIsEmpty) diffType = 'fill';
  else diffType = 'replace';

  return {
    columnName,
    rowIndex,
    originalValue,
    proposedValue,
    displayOriginal: originalIsEmpty ? '' : String(originalValue),
    displayProposed: proposedIsEmpty ? '' : String(proposedValue),
    reason,
    diffType,
    accepted: false,
    dismissed: false,
  };
}

// ------------------------------------------------------------
// applyAgentDiffs
// ------------------------------------------------------------

/**
 * Returns a NEW GridDataset with all `accepted === true` diffs applied to
 * cell values. Diffs that are dismissed, or simply not yet accepted, are
 * ignored. Never mutates the input `gridDataset` or the input `diffs`.
 *
 * @param {Object} gridDataset - a GridDataset as produced by formatRowsForGrid
 * @param {Array<Object>} diffs - AgentDiff descriptors, as produced by buildAgentDiff
 * @returns {Object} a new GridDataset
 */
function applyAgentDiffs(gridDataset, diffs) {
  const safeDiffs = (Array.isArray(diffs) ? diffs : []).filter(d => d && d.accepted === true && !d.dismissed);

  // Index accepted diffs by rowIndex for O(1) lookup while rebuilding rows.
  const byRow = new Map();
  for (const diff of safeDiffs) {
    if (!byRow.has(diff.rowIndex)) byRow.set(diff.rowIndex, []);
    byRow.get(diff.rowIndex).push(diff);
  }

  const newRows = (gridDataset.rows || []).map(row => {
    const applicable = byRow.get(row.index);
    if (!applicable || applicable.length === 0) {
      // No accepted diffs for this row — still return a fresh row/cells copy
      // so the caller never accidentally shares references with the input.
      return { ...row, cells: cloneCells(row.cells) };
    }

    const newCells = cloneCells(row.cells);
    for (const diff of applicable) {
      const existing = newCells[diff.columnName] || {};
      newCells[diff.columnName] = {
        ...existing,
        value: diff.proposedValue,
        displayValue: diff.proposedValue == null ? '' : String(diff.proposedValue),
      };
    }
    return { ...row, cells: newCells };
  });

  return {
    ...gridDataset,
    headers: (gridDataset.headers || []).map(h => ({ ...h })),
    rows: newRows,
    stats: { ...gridDataset.stats },
  };
}

function cloneCells(cells) {
  const out = {};
  for (const key of Object.keys(cells || {})) {
    out[key] = { ...cells[key] };
  }
  return out;
}

// ------------------------------------------------------------
// serialize / deserialize
// ------------------------------------------------------------

const GRID_DATASET_VERSION = 1;

/**
 * Serializes a GridDataset to a JSON string, stamped with a version field
 * so future shape changes can be migrated on deserialize.
 * @param {Object} gridDataset
 * @returns {string}
 */
function serializeGridDataset(gridDataset) {
  return JSON.stringify({ _v: GRID_DATASET_VERSION, ...gridDataset });
}

/**
 * Parses a JSON string produced by serializeGridDataset back into a
 * GridDataset-shaped object (the `_v` version field is preserved on the
 * returned object so callers can branch on it if the shape ever changes).
 * @param {string} json
 * @returns {Object}
 */
function deserializeGridDataset(json) {
  return JSON.parse(json);
}

// ------------------------------------------------------------
// exports
// ------------------------------------------------------------

export {
  formatRowsForGrid,
  buildColumnHealthScore,
  mapSeverityToStyle,
  buildAgentDiff,
  applyAgentDiffs,
  serializeGridDataset,
  deserializeGridDataset,
  typeToChip,
};
