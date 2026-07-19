// ============================================================
// DATAGLOW — Validation Coloring test suite
// ============================================================
// Covers js/grid/validation-coloring.js:
//   • computeCellStyles       — cell-level style descriptors from findings
//   • SEVERITY_COLORS         — exact spec values
//   • buildDiffOverlay        — agent-diff strikethrough/underline pair
//   • cellStylesToUniverFormat — Univer IWorkbookData-compatible styles
//   • computeRowHealth        — worst-severity rollup per row
//
// No Univer import, no DOM — plain Node.
//
// RUN WITH:  node test/grid/validation-coloring.test.js

import {
  computeCellStyles,
  SEVERITY_COLORS,
  buildDiffOverlay,
  cellStylesToUniverFormat,
  computeRowHealth,
} from '../../js/grid/validation-coloring.js';
import { formatRowsForGrid } from '../../js/grid/grid-bridge.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- shared fixture ----------
const columns = [
  { name: 'id', type: 'INTEGER' },
  { name: 'amount', type: 'DOUBLE' },
  { name: 'status', type: 'VARCHAR' },
];
const rows = [
  { id: 1, amount: 100, status: 'ok' },
  { id: 2, amount: -5, status: 'bad' },
  { id: 3, amount: 42, status: 'ok' },
  { id: 4, amount: 999, status: 'flagged' },
];
const findings = [
  { rowIndex: 1, columnName: 'amount', severity: 'warning', message: 'negative amount' },
  { rowIndex: 1, columnName: 'status', severity: 'error', message: 'unrecognized status' },
  { rowIndex: 3, columnName: 'amount', severity: 'critical', message: 'outlier value' },
];
const gridDataset = formatRowsForGrid(rows, columns, findings);

// ============================================================
// SEVERITY_COLORS
// ============================================================
(function testSeverityColors() {
  ok(SEVERITY_COLORS.error.background === 'rgba(161,44,123,0.08)', 'SEVERITY_COLORS: error background matches spec exactly');
  ok(SEVERITY_COLORS.error.border === '#A12C7B', 'SEVERITY_COLORS: error border matches spec exactly');
  ok(SEVERITY_COLORS.error.text === null, 'SEVERITY_COLORS: error text is null per spec');

  ok(SEVERITY_COLORS.warning.background === 'rgba(150,66,25,0.08)', 'SEVERITY_COLORS: warning background matches spec exactly');
  ok(SEVERITY_COLORS.warning.border === '#964219', 'SEVERITY_COLORS: warning border matches spec exactly');

  ok(SEVERITY_COLORS.critical.background === 'rgba(161,44,123,0.12)', 'SEVERITY_COLORS: critical background matches spec exactly');
  ok(SEVERITY_COLORS.critical.border === '#A12C7B', 'SEVERITY_COLORS: critical border matches spec exactly');
  ok(SEVERITY_COLORS.critical.text === '#A12C7B', 'SEVERITY_COLORS: critical text matches spec exactly');

  ok(SEVERITY_COLORS.clean.background === null, 'SEVERITY_COLORS: clean background is null');
  ok(SEVERITY_COLORS.clean.border === null, 'SEVERITY_COLORS: clean border is null');
  ok(SEVERITY_COLORS.clean.text === null, 'SEVERITY_COLORS: clean text is null');

  ok(Object.isFrozen(SEVERITY_COLORS), 'SEVERITY_COLORS: top-level object is frozen');
})();

// ============================================================
// computeCellStyles
// ============================================================
(function testComputeCellStyles() {
  const cellStyleMap = computeCellStyles(gridDataset, findings);

  ok(typeof cellStyleMap === 'object', 'computeCellStyles: returns an object');
  ok(cellStyleMap[1] !== undefined, 'computeCellStyles: row 1 has cell styles (has findings)');
  ok(cellStyleMap[0] === undefined, 'computeCellStyles: row 0 has no entry (no findings)');

  const amountColIndex = gridDataset.headers.findIndex(h => h.name === 'amount');
  const statusColIndex = gridDataset.headers.findIndex(h => h.name === 'status');

  const row1Amount = cellStyleMap[1][amountColIndex];
  ok(row1Amount.background === SEVERITY_COLORS.warning.background, 'computeCellStyles: row1/amount cell gets warning background');
  ok(row1Amount.borderColor === SEVERITY_COLORS.warning.border, 'computeCellStyles: row1/amount cell gets warning border');
  ok(row1Amount.note === 'negative amount', 'computeCellStyles: row1/amount cell note carries the finding message');

  const row1Status = cellStyleMap[1][statusColIndex];
  ok(row1Status.background === SEVERITY_COLORS.error.background, 'computeCellStyles: row1/status cell gets error background');

  const row3Amount = cellStyleMap[3][amountColIndex];
  ok(row3Amount.background === SEVERITY_COLORS.critical.background, 'computeCellStyles: row3/amount cell gets critical background');
  ok(row3Amount.bold === true, 'computeCellStyles: critical cell style is bold');
  ok(row3Amount.textColor === SEVERITY_COLORS.critical.text, 'computeCellStyles: critical cell carries the critical text color');

  // multiple findings on same cell -> worst severity wins, messages concat
  const findingsMulti = [
    { rowIndex: 0, columnName: 'amount', severity: 'warning', message: 'msg1' },
    { rowIndex: 0, columnName: 'amount', severity: 'critical', message: 'msg2' },
  ];
  const multiMap = computeCellStyles(gridDataset, findingsMulti);
  const combinedCell = multiMap[0][amountColIndex];
  ok(combinedCell.background === SEVERITY_COLORS.critical.background, 'computeCellStyles: worst-of-multiple severity wins for a single cell');
  ok(combinedCell.note === 'msg1; msg2', 'computeCellStyles: multiple messages on same cell are concatenated');

  // unknown column in a finding should be skipped, not throw
  const badFindings = [{ rowIndex: 0, columnName: 'nonexistent', severity: 'error', message: 'x' }];
  const safeMap = computeCellStyles(gridDataset, badFindings);
  ok(Object.keys(safeMap).length === 0, 'computeCellStyles: findings on unknown columns are skipped safely');

  // empty/undefined findings
  const emptyMap = computeCellStyles(gridDataset, []);
  ok(Object.keys(emptyMap).length === 0, 'computeCellStyles: empty findings array produces empty map');
  const undefMap = computeCellStyles(gridDataset, undefined);
  ok(Object.keys(undefMap).length === 0, 'computeCellStyles: undefined findings does not throw');
})();

// ============================================================
// buildDiffOverlay
// ============================================================
(function testBuildDiffOverlay() {
  const overlay = buildDiffOverlay('B4', 'old-value', 'new-value');

  ok(overlay.controlAnchor === 'B4', 'buildDiffOverlay: controlAnchor matches the passed cellRef');
  ok(overlay.original.strikethrough === true, 'buildDiffOverlay: original style has strikethrough');
  ok(overlay.original.underline === false, 'buildDiffOverlay: original style has no underline');
  ok(overlay.proposed.underline === true, 'buildDiffOverlay: proposed style has underline');
  ok(overlay.proposed.strikethrough === false, 'buildDiffOverlay: proposed style has no strikethrough');
  ok(overlay.original.note.includes('old-value'), 'buildDiffOverlay: original note mentions the original value');
  ok(overlay.proposed.note.includes('new-value'), 'buildDiffOverlay: proposed note mentions the proposed value');

  const clearOverlay = buildDiffOverlay('C1', 'was-here', null);
  ok(clearOverlay.proposed.note.includes('clear'), 'buildDiffOverlay: null proposed value notes a "clear" operation');

  const fillOverlay = buildDiffOverlay('D2', null, 'filled-in');
  ok(fillOverlay.original.note.includes('empty'), 'buildDiffOverlay: null original value notes an "empty" original');
})();

// ============================================================
// cellStylesToUniverFormat
// ============================================================
(function testCellStylesToUniverFormat() {
  const cellStyleMap = computeCellStyles(gridDataset, findings);
  const { styles, cellStylePatch } = cellStylesToUniverFormat(cellStyleMap);

  ok(typeof styles === 'object', 'cellStylesToUniverFormat: returns a styles lookup object');
  ok(typeof cellStylePatch === 'object', 'cellStylesToUniverFormat: returns a cellStylePatch object');

  ok(cellStylePatch[1] !== undefined, 'cellStylesToUniverFormat: cellStylePatch has an entry for row 1');
  const amountColIndex = gridDataset.headers.findIndex(h => h.name === 'amount');
  const row1AmountPatch = cellStylePatch[1][amountColIndex];
  ok(typeof row1AmountPatch.s === 'string', 'cellStylesToUniverFormat: patch cell references a style id string');
  ok(styles[row1AmountPatch.s] !== undefined, 'cellStylesToUniverFormat: referenced style id exists in the styles table');
  ok(styles[row1AmountPatch.s].bg.rgb === SEVERITY_COLORS.warning.background, 'cellStylesToUniverFormat: style bg.rgb matches the warning background color');

  // dedupe: two cells with the identical style should share one style id
  const row3AmountColIndex = amountColIndex;
  const row1StatusColIndex = gridDataset.headers.findIndex(h => h.name === 'status');
  const findingsIdentical = [
    { rowIndex: 0, columnName: 'amount', severity: 'error', message: null },
    { rowIndex: 1, columnName: 'status', severity: 'error', message: null },
  ];
  const identicalMap = computeCellStyles(gridDataset, findingsIdentical);
  const identicalResult = cellStylesToUniverFormat(identicalMap);
  const id1 = identicalResult.cellStylePatch[0][amountColIndex].s;
  const id2 = identicalResult.cellStylePatch[1][row1StatusColIndex].s;
  ok(id1 === id2, 'cellStylesToUniverFormat: identical cell styles are deduped to the same style id');
  ok(Object.keys(identicalResult.styles).length === 1, 'cellStylesToUniverFormat: dedupe results in a single styles table entry');

  // bold/strikethrough/underline mapping
  const boldStyleMap = { 0: { 0: { background: null, textColor: null, bold: true, strikethrough: true, underline: false, borderColor: null, note: null } } };
  const boldResult = cellStylesToUniverFormat(boldStyleMap);
  const boldStyleId = boldResult.cellStylePatch[0][0].s;
  ok(boldResult.styles[boldStyleId].bl === 1, 'cellStylesToUniverFormat: bold maps to Univer bl:1');
  ok(boldResult.styles[boldStyleId].st.s === 1, 'cellStylesToUniverFormat: strikethrough maps to Univer st:{s:1}');
  ok(boldResult.styles[boldStyleId].ul === undefined, 'cellStylesToUniverFormat: underline:false omits the ul key entirely');

  // empty map
  const emptyResult = cellStylesToUniverFormat({});
  ok(Object.keys(emptyResult.styles).length === 0, 'cellStylesToUniverFormat: empty cellStyleMap produces empty styles table');
})();

// ============================================================
// computeRowHealth
// ============================================================
(function testComputeRowHealth() {
  const cellStyleMap = computeCellStyles(gridDataset, findings);

  ok(computeRowHealth(cellStyleMap, 1) === 'error', 'computeRowHealth: row 1 worst severity is error (warning + error cells)');
  ok(computeRowHealth(cellStyleMap, 3) === 'critical', 'computeRowHealth: row 3 worst severity is critical');
  ok(computeRowHealth(cellStyleMap, 0) === 'clean', 'computeRowHealth: row with no styled cells is clean');
  ok(computeRowHealth(cellStyleMap, 999) === 'clean', 'computeRowHealth: nonexistent row index defaults to clean without throwing');
  ok(computeRowHealth(undefined, 0) === 'clean', 'computeRowHealth: undefined cellStyleMap does not throw, defaults clean');
})();

// ============================================================
// summary
// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
