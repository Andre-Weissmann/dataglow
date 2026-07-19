// ============================================================
// DATAGLOW — Validation Coloring (Univer cell-level styling layer)
// ============================================================
// Pure-logic validation coloring system. Extends grid-bridge.js's
// column-level health scoring and row-level mapSeverityToStyle() down to
// CELL granularity, and adds the diff-overlay style pair (strikethrough
// original / underlined proposed) that the UI layer renders for
// agent-proposed edits (see buildAgentDiff in grid-bridge.js).
//
// No Univer import, no DOM — cellStylesToUniverFormat() below produces a
// plain-data shape compatible with Univer's IWorkbookData styles object
// (see docs/grid-integration.md), but never imports @univerjs/* anything.

// ------------------------------------------------------------
// SEVERITY_COLORS — exact values per spec
// ------------------------------------------------------------

const SEVERITY_COLORS = Object.freeze({
  error: Object.freeze({ background: 'rgba(161,44,123,0.08)', border: '#A12C7B', text: null }),
  warning: Object.freeze({ background: 'rgba(150,66,25,0.08)', border: '#964219', text: null }),
  critical: Object.freeze({ background: 'rgba(161,44,123,0.12)', border: '#A12C7B', text: '#A12C7B' }),
  clean: Object.freeze({ background: null, border: null, text: null }),
});

const SEVERITY_RANK = { clean: 0, warning: 1, error: 2, critical: 3 };
const VALID_SEVERITIES = new Set(['warning', 'error', 'critical']);

function worstSeverity(a, b) {
  return (SEVERITY_RANK[a] || 0) >= (SEVERITY_RANK[b] || 0) ? a : b;
}

// ------------------------------------------------------------
// CellStyle factory
// ------------------------------------------------------------

function emptyCellStyle() {
  return {
    background: null,
    textColor: null,
    bold: false,
    strikethrough: false,
    underline: false,
    borderColor: null,
    note: null,
  };
}

function cellStyleFromSeverity(severity, message) {
  const colors = SEVERITY_COLORS[severity] || SEVERITY_COLORS.clean;
  const style = emptyCellStyle();
  style.background = colors.background;
  style.borderColor = colors.border;
  style.textColor = colors.text;
  style.bold = severity === 'critical';
  style.note = message || null;
  return style;
}

// ------------------------------------------------------------
// computeCellStyles
// ------------------------------------------------------------

/**
 * Computes cell-level style descriptors for an entire dataset from
 * validation findings. Each finding maps to exactly one cell
 * (rowIndex, columnName); if multiple findings land on the same cell, the
 * worst severity wins and messages are concatenated into the note.
 *
 * @param {Object} gridDataset - a GridDataset from grid-bridge.js
 * @param {Array<{rowIndex:number, columnName:string, severity:string, message?:string}>} findings
 * @returns {Object} CellStyleMap — { [rowIndex]: { [colIndex]: CellStyle } }
 */
function computeCellStyles(gridDataset, findings) {
  const headers = (gridDataset && Array.isArray(gridDataset.headers)) ? gridDataset.headers : [];
  const colIndexByName = new Map(headers.map((h, i) => [h.name, i]));
  const safeFindings = (Array.isArray(findings) ? findings : []).filter(f => f && VALID_SEVERITIES.has(f.severity));

  // rowIndex -> colIndex -> { severity, messages: string[] }
  const accum = new Map();

  for (const f of safeFindings) {
    const colIndex = colIndexByName.get(f.columnName);
    if (colIndex === undefined) continue; // unknown column: skip, never throw

    if (!accum.has(f.rowIndex)) accum.set(f.rowIndex, new Map());
    const rowMap = accum.get(f.rowIndex);

    if (!rowMap.has(colIndex)) {
      rowMap.set(colIndex, { severity: f.severity, messages: [] });
    }
    const entry = rowMap.get(colIndex);
    entry.severity = worstSeverity(entry.severity, f.severity);
    if (f.message) entry.messages.push(f.message);
  }

  const cellStyleMap = {};
  for (const [rowIndex, rowMap] of accum.entries()) {
    cellStyleMap[rowIndex] = {};
    for (const [colIndex, entry] of rowMap.entries()) {
      const combinedMessage = entry.messages.length ? entry.messages.join('; ') : null;
      cellStyleMap[rowIndex][colIndex] = cellStyleFromSeverity(entry.severity, combinedMessage);
    }
  }

  return cellStyleMap;
}

// ------------------------------------------------------------
// buildDiffOverlay
// ------------------------------------------------------------

/**
 * Builds a diff style overlay for an agent-proposed cell edit: a
 * strikethrough style for the original value and an underlined/highlighted
 * style for the proposed value, anchored to the same cell reference.
 *
 * @param {string} cellRef - e.g. "B4"
 * @param {*} originalValue
 * @param {*} proposedValue
 * @returns {{original: Object, proposed: Object, controlAnchor: string}}
 */
function buildDiffOverlay(cellRef, originalValue, proposedValue) {
  const original = emptyCellStyle();
  original.strikethrough = true;
  original.textColor = '#C62828';
  original.background = 'rgba(198,40,40,0.08)';
  original.note = originalValue === null || originalValue === undefined
    ? 'Original value: (empty)'
    : `Original value: ${String(originalValue)}`;

  const proposed = emptyCellStyle();
  proposed.underline = true;
  proposed.bold = true;
  proposed.textColor = '#2E7D32';
  proposed.background = 'rgba(46,125,50,0.10)';
  proposed.note = proposedValue === null || proposedValue === undefined
    ? 'Proposed value: (clear)'
    : `Proposed value: ${String(proposedValue)}`;

  return { original, proposed, controlAnchor: cellRef };
}

// ------------------------------------------------------------
// cellStylesToUniverFormat
// ------------------------------------------------------------

/**
 * Converts a CellStyleMap into a partial Univer IWorkbookData `styles`
 * object: a flat dictionary of style-id -> IStyleData, plus a matching
 * cellData patch (row -> col -> { s: styleId }) that the UI layer merges
 * into its existing IWorkbookData sheet before calling
 * univerAPI.createWorkbook()/worksheet.setStyle() (see
 * docs/grid-integration.md section 3–4 for the base IWorkbookData shape).
 *
 * Univer's IStyleData uses: bg (fill), cl (font color), bl (bold 0/1),
 * st (strikethrough {s:0/1}), ul (underline {s:0/1}), bd (border).
 *
 * @param {Object} cellStyleMap - as produced by computeCellStyles
 * @returns {{styles: Object, cellStylePatch: Object}}
 */
function cellStylesToUniverFormat(cellStyleMap) {
  const styles = {};
  const cellStylePatch = {};
  let nextId = 0;

  // Dedupe identical styles into a single style-id, per Univer's style-table
  // convention (IWorkbookData.styles is a flat lookup table referenced by id).
  const styleKeyToId = new Map();

  for (const rowIndexStr of Object.keys(cellStyleMap || {})) {
    const rowIndex = Number(rowIndexStr);
    const rowStyles = cellStyleMap[rowIndexStr];
    cellStylePatch[rowIndex] = {};

    for (const colIndexStr of Object.keys(rowStyles)) {
      const colIndex = Number(colIndexStr);
      const cellStyle = rowStyles[colIndexStr];

      const univerStyle = toUniverStyleData(cellStyle);
      const key = JSON.stringify(univerStyle);

      let styleId = styleKeyToId.get(key);
      if (styleId === undefined) {
        styleId = `s${nextId++}`;
        styleKeyToId.set(key, styleId);
        styles[styleId] = univerStyle;
      }

      cellStylePatch[rowIndex][colIndex] = { s: styleId };
    }
  }

  return { styles, cellStylePatch };
}

function toUniverStyleData(cellStyle) {
  const style = {};
  if (cellStyle.background) {
    style.bg = { rgb: cellStyle.background };
  }
  if (cellStyle.textColor) {
    style.cl = { rgb: cellStyle.textColor };
  }
  if (cellStyle.bold) {
    style.bl = 1;
  }
  if (cellStyle.strikethrough) {
    style.st = { s: 1 };
  }
  if (cellStyle.underline) {
    style.ul = { s: 1 };
  }
  if (cellStyle.borderColor) {
    style.bd = {
      l: { s: 1, cl: { rgb: cellStyle.borderColor } },
    };
  }
  return style;
}

// ------------------------------------------------------------
// computeRowHealth
// ------------------------------------------------------------

/**
 * Computes the aggregate health of a row from its cell styles: the worst
 * severity found among any of the row's cell notes/colors. Since CellStyle
 * doesn't carry severity directly, this reverse-maps background color to
 * severity via SEVERITY_COLORS.
 *
 * @param {Object} cellStyleMap - as produced by computeCellStyles
 * @param {number} rowIndex
 * @returns {'clean'|'warning'|'error'|'critical'}
 */
function computeRowHealth(cellStyleMap, rowIndex) {
  const rowStyles = cellStyleMap ? cellStyleMap[rowIndex] : undefined;
  if (!rowStyles) return 'clean';

  const backgroundToSeverity = new Map(
    Object.entries(SEVERITY_COLORS)
      .filter(([, v]) => v.background)
      .map(([sev, v]) => [v.background, sev])
  );

  let worst = 'clean';
  for (const cellStyle of Object.values(rowStyles)) {
    const severity = backgroundToSeverity.get(cellStyle.background) || 'clean';
    worst = worstSeverity(worst, severity);
  }
  return worst;
}

// ------------------------------------------------------------
// exports
// ------------------------------------------------------------

export {
  computeCellStyles,
  SEVERITY_COLORS,
  buildDiffOverlay,
  cellStylesToUniverFormat,
  computeRowHealth,
};
