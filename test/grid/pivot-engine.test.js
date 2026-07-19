// ============================================================
// DATAGLOW — Pivot Engine test suite
// ============================================================
// Covers js/grid/pivot-engine.js:
//   • validatePivotConfig    — every documented failure mode
//   • computePivotValues     — raw accumulator computation
//   • formatPivotValue       — number/count formatting
//   • buildPivotDescriptor   — row/col groups, cells, totals, grand total
//   • pivotToGridDataset     — GridDataset-compatible shape for Univer
//
// No Univer import, no DOM, no DuckDB — plain Node.
//
// RUN WITH:  node test/grid/pivot-engine.test.js

import {
  buildPivotDescriptor,
  computePivotValues,
  formatPivotValue,
  pivotToGridDataset,
  validatePivotConfig,
} from '../../js/grid/pivot-engine.js';
import { formatRowsForGrid } from '../../js/grid/grid-bridge.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
function approx(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

// ---------- shared fixture dataset ----------
const columns = [
  { name: 'region', type: 'VARCHAR' },
  { name: 'product', type: 'VARCHAR' },
  { name: 'amount', type: 'DOUBLE' },
];
const rows = [
  { region: 'East', product: 'Widget', amount: 100 },
  { region: 'East', product: 'Widget', amount: 50 },
  { region: 'East', product: 'Gadget', amount: 200 },
  { region: 'West', product: 'Widget', amount: 30 },
  { region: 'West', product: 'Gadget', amount: 70 },
  { region: 'West', product: 'Gadget', amount: null },
];
const gridDataset = formatRowsForGrid(rows, columns, []);

// ============================================================
// validatePivotConfig
// ============================================================
(function testValidatePivotConfig() {
  const validConfig = { rowFields: ['region'], valueField: 'amount', aggregation: 'sum' };
  const r1 = validatePivotConfig(gridDataset, validConfig);
  ok(r1.valid === true, 'validatePivotConfig: valid config passes');
  ok(r1.errors.length === 0, 'validatePivotConfig: valid config has no errors');

  const r2 = validatePivotConfig(gridDataset, { rowFields: [], valueField: 'amount', aggregation: 'sum' });
  ok(r2.valid === false, 'validatePivotConfig: empty rowFields is invalid');
  ok(r2.errors.some(e => /rowFields/.test(e)), 'validatePivotConfig: empty rowFields reports rowFields error');

  const r3 = validatePivotConfig(gridDataset, { rowFields: ['nonexistent'], valueField: 'amount', aggregation: 'sum' });
  ok(r3.valid === false, 'validatePivotConfig: nonexistent rowField is invalid');
  ok(r3.errors.some(e => /nonexistent/.test(e)), 'validatePivotConfig: nonexistent rowField named in error');

  const r4 = validatePivotConfig(gridDataset, { rowFields: ['region'], valueField: 'nonexistent', aggregation: 'sum' });
  ok(r4.valid === false, 'validatePivotConfig: nonexistent valueField is invalid');

  const r5 = validatePivotConfig(gridDataset, { rowFields: ['region'], valueField: 'amount', aggregation: 'bogus' });
  ok(r5.valid === false, 'validatePivotConfig: invalid aggregation name is invalid');
  ok(r5.errors.some(e => /aggregation/.test(e)), 'validatePivotConfig: invalid aggregation reports aggregation error');

  const r6 = validatePivotConfig(gridDataset, { rowFields: ['region'], valueField: 'product', aggregation: 'sum' });
  ok(r6.valid === false, 'validatePivotConfig: sum on a non-numeric column is invalid');
  ok(r6.errors.some(e => /must be numeric/.test(e)), 'validatePivotConfig: non-numeric valueField reports numeric requirement');

  const r7 = validatePivotConfig(gridDataset, { rowFields: ['region'], valueField: 'product', aggregation: 'count' });
  ok(r7.valid === true, 'validatePivotConfig: count on a non-numeric column is valid');

  const r8 = validatePivotConfig(gridDataset, { rowFields: ['region'], colFields: ['nonexistent'], valueField: 'amount', aggregation: 'sum' });
  ok(r8.valid === false, 'validatePivotConfig: nonexistent colField is invalid');

  const r9 = validatePivotConfig(gridDataset, { rowFields: ['region'], valueField: 'amount', aggregation: 'sum', filters: { nonexistent: ['a'] } });
  ok(r9.valid === false, 'validatePivotConfig: nonexistent filter column is invalid');

  const r10 = validatePivotConfig(gridDataset, {});
  ok(r10.valid === false, 'validatePivotConfig: empty config object is invalid');
  ok(r10.errors.length >= 2, 'validatePivotConfig: empty config reports multiple errors (rowFields + valueField + aggregation)');

  const r11 = validatePivotConfig(gridDataset, null);
  ok(r11.valid === false, 'validatePivotConfig: null config is invalid without throwing');
})();

// ============================================================
// computePivotValues
// ============================================================
(function testComputePivotValues() {
  const plainRows = rows;
  const config = { rowFields: ['region'], valueField: 'amount', aggregation: 'sum' };
  const map = computePivotValues(plainRows, config);

  ok(map instanceof Map, 'computePivotValues: returns a Map');
  ok(map.size === 2, 'computePivotValues: two distinct row groups (East, West)');

  const eastKey = Array.from(map.keys()).find(k => k === 'East');
  ok(eastKey !== undefined, 'computePivotValues: East key present');
  const eastAcc = map.get('East').get('');
  ok(approx(eastAcc.sum, 350), 'computePivotValues: East sum = 350 (100+50+200)');
  ok(eastAcc.count === 3, 'computePivotValues: East count = 3 rows');

  const westAcc = map.get('West').get('');
  ok(approx(westAcc.sum, 100), 'computePivotValues: West sum = 100 (30+70+null-skip)');
  ok(westAcc.count === 3, 'computePivotValues: West count includes the null-amount row');

  // with colFields
  const config2 = { rowFields: ['region'], colFields: ['product'], valueField: 'amount', aggregation: 'sum' };
  const map2 = computePivotValues(plainRows, config2);
  const eastWidget = map2.get('East').get('Widget');
  ok(approx(eastWidget.sum, 150), 'computePivotValues: East/Widget sum = 150 (100+50)');
  const eastGadget = map2.get('East').get('Gadget');
  ok(approx(eastGadget.sum, 200), 'computePivotValues: East/Gadget sum = 200');

  // filters
  const config3 = { rowFields: ['region'], valueField: 'amount', aggregation: 'sum', filters: { region: ['East'] } };
  const map3 = computePivotValues(plainRows, config3);
  ok(map3.size === 1, 'computePivotValues: filters restrict to matching rows only');
  ok(map3.has('East'), 'computePivotValues: filtered map retains East');

  // empty input
  const emptyMap = computePivotValues([], config);
  ok(emptyMap.size === 0, 'computePivotValues: empty rows produce empty map');
  const undefMap = computePivotValues(undefined, config);
  ok(undefMap.size === 0, 'computePivotValues: undefined rows do not throw, produce empty map');
})();

// ============================================================
// formatPivotValue
// ============================================================
(function testFormatPivotValue() {
  ok(formatPivotValue(1234.5, 'sum') === '1,234.50', 'formatPivotValue: sum formats with thousands separator and 2 decimals');
  ok(formatPivotValue(42, 'count') === '42', 'formatPivotValue: count formats as plain integer string');
  ok(formatPivotValue(42.7, 'count') === '43', 'formatPivotValue: count rounds fractional values');
  ok(formatPivotValue(-1234.5, 'sum') === '-1,234.50', 'formatPivotValue: negative numbers keep the minus sign outside the thousands separator');
  ok(formatPivotValue(0, 'sum') === '0.00', 'formatPivotValue: zero formats correctly');
  ok(formatPivotValue(1234567.891, 'avg', 1) === '1,234,567.9', 'formatPivotValue: custom decimalPlaces respected');
  ok(formatPivotValue(null, 'sum') === '', 'formatPivotValue: null returns empty string');
  ok(formatPivotValue(undefined, 'sum') === '', 'formatPivotValue: undefined returns empty string');
  ok(formatPivotValue(NaN, 'sum') === '', 'formatPivotValue: NaN returns empty string');
})();

// ============================================================
// buildPivotDescriptor
// ============================================================
(function testBuildPivotDescriptorNoColFields() {
  const config = { rowFields: ['region'], valueField: 'amount', aggregation: 'sum' };
  const descriptor = buildPivotDescriptor(gridDataset, config);

  ok(descriptor.rowGroups.length === 2, 'buildPivotDescriptor: two row groups (East, West)');
  ok(JSON.stringify(descriptor.rowGroups) === JSON.stringify(['East', 'West']), 'buildPivotDescriptor: row groups sorted alphabetically');
  ok(descriptor.colGroups.length === 0, 'buildPivotDescriptor: no colGroups when colFields is absent');
  ok(descriptor.cells.length === 2, 'buildPivotDescriptor: one cell per row group when no colFields');

  const eastCell = descriptor.cells.find(c => c.rowKey === 'East');
  ok(approx(eastCell.value, 350), 'buildPivotDescriptor: East cell value = 350');
  ok(eastCell.formattedValue === '350.00', 'buildPivotDescriptor: East cell formattedValue = 350.00');

  ok(approx(descriptor.totals.grand.value, 450), 'buildPivotDescriptor: grand total = 450 (350+100)');
  ok(descriptor.totals.row.length === 2, 'buildPivotDescriptor: one row total per row group');
  ok(descriptor.totals.col.length === 1, 'buildPivotDescriptor: one col total when no colFields (single Total column)');
})();

(function testBuildPivotDescriptorWithColFields() {
  const config = { rowFields: ['region'], colFields: ['product'], valueField: 'amount', aggregation: 'sum' };
  const descriptor = buildPivotDescriptor(gridDataset, config);

  ok(descriptor.colGroups.length === 2, 'buildPivotDescriptor: two col groups (Gadget, Widget)');
  ok(descriptor.cells.length === 4, 'buildPivotDescriptor: 2x2 = 4 cells with colFields');

  const eastWidgetCell = descriptor.cells.find(c => c.rowKey === 'East' && c.colKey === 'Widget');
  ok(approx(eastWidgetCell.value, 150), 'buildPivotDescriptor: East/Widget = 150');

  const westGadgetCell = descriptor.cells.find(c => c.rowKey === 'West' && c.colKey === 'Gadget');
  ok(approx(westGadgetCell.value, 70), 'buildPivotDescriptor: West/Gadget = 70 (null amount row skipped from sum)');

  const eastRowTotal = descriptor.totals.row.find(c => c.rowKey === 'East');
  ok(approx(eastRowTotal.value, 350), 'buildPivotDescriptor: East row total = 350 across both products');

  const widgetColTotal = descriptor.totals.col.find(c => c.colKey === 'Widget');
  ok(approx(widgetColTotal.value, 180), 'buildPivotDescriptor: Widget col total = 180 (150 East + 30 West)');

  ok(approx(descriptor.totals.grand.value, 450), 'buildPivotDescriptor: grand total still 450 with colFields present');
})();

(function testBuildPivotDescriptorAggregations() {
  const avgConfig = { rowFields: ['region'], valueField: 'amount', aggregation: 'avg' };
  const avgDescriptor = buildPivotDescriptor(gridDataset, avgConfig);
  const eastAvg = avgDescriptor.cells.find(c => c.rowKey === 'East');
  ok(approx(eastAvg.value, 350 / 3), 'buildPivotDescriptor: avg aggregation computes mean including any non-numeric rows in count');

  const countConfig = { rowFields: ['region'], valueField: 'amount', aggregation: 'count' };
  const countDescriptor = buildPivotDescriptor(gridDataset, countConfig);
  const westCount = countDescriptor.cells.find(c => c.rowKey === 'West');
  ok(westCount.value === 3, 'buildPivotDescriptor: count aggregation counts all rows including null amount');

  const maxConfig = { rowFields: ['region'], valueField: 'amount', aggregation: 'max' };
  const maxDescriptor = buildPivotDescriptor(gridDataset, maxConfig);
  const eastMax = maxDescriptor.cells.find(c => c.rowKey === 'East');
  ok(eastMax.value === 200, 'buildPivotDescriptor: max aggregation for East = 200');

  const minConfig = { rowFields: ['region'], valueField: 'amount', aggregation: 'min' };
  const minDescriptor = buildPivotDescriptor(gridDataset, minConfig);
  const westMin = minDescriptor.cells.find(c => c.rowKey === 'West');
  ok(westMin.value === 30, 'buildPivotDescriptor: min aggregation for West = 30');
})();

(function testBuildPivotDescriptorThrowsOnInvalidConfig() {
  let threw = false;
  try {
    buildPivotDescriptor(gridDataset, { rowFields: [], valueField: 'amount', aggregation: 'sum' });
  } catch (e) {
    threw = true;
    ok(Array.isArray(e.errors), 'buildPivotDescriptor: thrown error carries an errors array');
  }
  ok(threw, 'buildPivotDescriptor: throws on invalid config instead of silently producing garbage');
})();

// ============================================================
// pivotToGridDataset
// ============================================================
(function testPivotToGridDataset() {
  const config = { rowFields: ['region'], colFields: ['product'], valueField: 'amount', aggregation: 'sum' };
  const descriptor = buildPivotDescriptor(gridDataset, config);
  const pivotGrid = pivotToGridDataset(descriptor);

  ok(Array.isArray(pivotGrid.headers), 'pivotToGridDataset: produces a headers array');
  ok(pivotGrid.headers[0].name === '__pivot_row__', 'pivotToGridDataset: first header is the row-label column');
  ok(pivotGrid.headers.every(h => h.typeChip === 'pivot'), 'pivotToGridDataset: every header is typeChip "pivot"');
  ok(pivotGrid.headers.every(h => h.healthLabel === 'clean'), 'pivotToGridDataset: every header has neutral clean health');
  ok(pivotGrid.headers.some(h => h.name === 'Total'), 'pivotToGridDataset: has a Total column header');

  // rows: 2 data rows (East, West) + 1 totals row
  ok(pivotGrid.rows.length === 3, 'pivotToGridDataset: 2 row groups + 1 totals row = 3 rows');

  const eastRow = pivotGrid.rows.find(r => r.cells.__pivot_row__.value === 'East');
  ok(eastRow !== undefined, 'pivotToGridDataset: East row present with row-label cell');
  ok(approx(eastRow.cells.Widget.value, 150), 'pivotToGridDataset: East row Widget cell = 150');
  ok(approx(eastRow.cells.Total.value, 350), 'pivotToGridDataset: East row Total cell = 350');

  const totalsRow = pivotGrid.rows[pivotGrid.rows.length - 1];
  ok(totalsRow.isTotalsRow === true, 'pivotToGridDataset: last row flagged isTotalsRow');
  ok(approx(totalsRow.cells.Total.value, 450), 'pivotToGridDataset: totals row grand total cell = 450');

  ok(pivotGrid.isPivot === true, 'pivotToGridDataset: output flagged isPivot for UI layer branching');
  ok(pivotGrid.stats.overallHealthScore === 1.0, 'pivotToGridDataset: stats.overallHealthScore neutral at 1.0');
  ok(pivotGrid.stats.warningRows === 0 && pivotGrid.stats.errorRows === 0, 'pivotToGridDataset: no validation-derived warning/error rows on pivot output');
})();

(function testPivotToGridDatasetNoColFields() {
  const config = { rowFields: ['region'], valueField: 'amount', aggregation: 'sum' };
  const descriptor = buildPivotDescriptor(gridDataset, config);
  const pivotGrid = pivotToGridDataset(descriptor);

  // Only rowLabel + single Total column expected (no duplicate Total columns).
  ok(pivotGrid.headers.length === 2, 'pivotToGridDataset: rowLabel + Total only, no duplicate Total columns when colFields absent');
  const westRow = pivotGrid.rows.find(r => r.cells.__pivot_row__.value === 'West');
  ok(approx(westRow.cells.Total.value, 100), 'pivotToGridDataset: West Total cell = 100 with no colFields');
})();

// ============================================================
// summary
// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
