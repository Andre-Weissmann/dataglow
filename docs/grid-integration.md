# DataGlow Grid — Univer Integration Guide

**Status:** Architecture scaffold (PR K) plus the full contract layer (PR W).
This document accompanies `js/grid/grid-bridge.js`, `js/grid/pivot-engine.js`,
`js/grid/formula-bridge.js`, and `js/grid/validation-coloring.js` — together
the data contract layer between DataGlow's validation spine and the
[Univer](https://univer.ai) spreadsheet grid UI. It is Tier 1 of the
DataGlow Canvas feature set ("DataGlow Grid").

This is **not** a full Univer integration. Univer is a full npm package that
is loaded and driven entirely by the UI layer; none of the four modules above
import it. This doc describes the pattern the UI layer follows to consume the
data contracts they export.

| Module | Role |
|---|---|
| `js/grid/grid-bridge.js` | Base data contract: `GridDataset`, column health scoring, row/severity styling, agent diff descriptors (PR K, #388) |
| `js/grid/pivot-engine.js` | Pure-logic pivot table engine — builds a `PivotDescriptor` from a `GridDataset` and converts it back into a renderable `GridDataset` |
| `js/grid/formula-bridge.js` | Maps Excel formula names (as Univer's formula engine names them) to DuckDB SQL equivalents, for audit/documentation and Story View |
| `js/grid/validation-coloring.js` | Cell- and row-level style descriptors, agent-diff overlay pair, and the Univer `IWorkbookData` styles conversion |

---

## 1. What Univer is, and why it was chosen

[Univer](https://github.com/dream-num/univer) is an open-source spreadsheet
(and document/slide) engine built by a team that includes former Google
Sheets engineers. For DataGlow Grid, three properties made it the clear
choice over alternatives (Handsontable, AG Grid, Luckysheet, x-spreadsheet):

- **Apache-2.0 license** — no copyleft obligations, no per-seat licensing
  fees, compatible with DataGlow's zero-upload / zero-server / client-only
  distribution model ([license](https://github.com/dream-num/univer/blob/dev/LICENSE)).
- **Excel-compatible formula engine** — Univer ships its own formula engine
  (`@univerjs/engine-formula`) supporting the standard Excel function set,
  which matters for DataGlow because analysts frequently paste DuckDB output
  into Excel today; a grid that understands the same formula grammar removes
  that round-trip.
- **100k+ row performance** via virtualized rendering (`@univerjs/engine-render`)
  — DataGlow regularly loads DuckDB result sets in the tens of thousands of
  rows, and a naive DOM-per-cell grid would not survive that.
- **Active maintenance** — frequent releases (0.25.x as of this writing) and
  a team with production spreadsheet-engine experience, which reduces the
  risk of adopting an abandoned dependency for a Tier 1 feature.

Full package listing: [npm @univerjs/core](https://www.npmjs.com/package/@univerjs/core).

---

## 2. Loading Univer via CDN

DataGlow's browser environment (client-only, no bundler-required distribution
path) loads Univer via `<script>`/`<link>` tags from unpkg, following
Univer's own documented CDN pattern
([Univer CDN docs](https://docs.univer.ai/guides/sheets/getting-started/installation/cdn)).
The **preset** bundle (`@univerjs/presets` + `@univerjs/preset-sheets-core`)
is the recommended entry point — it bundles core, render engine, formula
engine, sheets, and sheets-ui into two script tags instead of manually wiring
a dozen plugin packages:

```html
<!-- Peer dependencies -->
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/rxjs@7.8.1/dist/bundles/rxjs.umd.min.js"></script>

<!-- Univer preset (bundles core + ui + sheets + sheets-ui) -->
<script src="https://unpkg.com/@univerjs/presets@0.25.1/lib/umd/index.js"></script>
<script src="https://unpkg.com/@univerjs/preset-sheets-core@0.25.1/lib/umd/index.js"></script>
<script src="https://unpkg.com/@univerjs/preset-sheets-core@0.25.1/lib/umd/locales/en-US.js"></script>
<link rel="stylesheet" href="https://unpkg.com/@univerjs/preset-sheets-core@0.25.1/lib/index.css" />
```

Pin the version (`@0.25.1` above) rather than leaving it unpinned, so a
Univer release never silently changes DataGlow Grid's behavior without a
deliberate version bump in this repo.

The task's four named packages map onto the preset like this if lower-level,
per-plugin control is later required instead of the preset bundle:

| Package | unpkg URL pattern | Role |
|---|---|---|
| `@univerjs/core` | `https://unpkg.com/@univerjs/core@<version>/lib/umd/index.js` | Univer instance, locale/theme system, IWorkbookData model |
| `@univerjs/ui` | `https://unpkg.com/@univerjs/ui@<version>/lib/umd/index.js` | Base UI shell, workbench, toolbar |
| `@univerjs/sheets` | `https://unpkg.com/@univerjs/sheets@<version>/lib/umd/index.js` | Sheet data model and commands (headless) |
| `@univerjs/sheets-ui` | `https://unpkg.com/@univerjs/sheets-ui@<version>/lib/umd/index.js` | Rendered grid canvas, cell styling APIs |

(Per-plugin UMD wiring is considerably more verbose — every plugin package
and its own locale/CSS files must be loaded in dependency order — so the
preset bundle above is the recommended default; see
[Univer's own plugin-mode example](https://docs.univer.ai/guides/sheets/getting-started/installation/cdn)
if per-plugin control becomes necessary.)

---

## 3. GridDataset → Univer IWorkbookData

`grid-bridge.js` produces a `GridDataset` (headers, rows, stats) that has no
knowledge of Univer's internal cell model. The UI layer is responsible for
converting a `GridDataset` into Univer's `IWorkbookData` snapshot shape,
which is what `univerAPI.createWorkbook(...)` / `univer.createUnit(...)`
consumes.

Conversion pattern:

```js
import { formatRowsForGrid } from '../js/grid/grid-bridge.js';

// 1. Run the DuckDB query, get validation findings from the validation spine.
const gridDataset = formatRowsForGrid(rows, columns, validationFindings);

// 2. Convert GridDataset -> Univer IWorkbookData cellData shape.
//    Univer's sheet cellData is keyed by row index -> column index -> ICellData.
function toUniverCellData(gridDataset) {
  const cellData = {};
  const colIndexByName = new Map(gridDataset.headers.map((h, i) => [h.name, i]));

  // header row (row 0)
  cellData[0] = {};
  gridDataset.headers.forEach((header, colIndex) => {
    cellData[0][colIndex] = { v: `${header.name} (${header.typeChip})` };
  });

  // data rows (offset by 1 for the header row)
  gridDataset.rows.forEach(row => {
    const rowIndex = row.index + 1;
    cellData[rowIndex] = {};
    for (const [colName, cell] of Object.entries(row.cells)) {
      const colIndex = colIndexByName.get(colName);
      cellData[rowIndex][colIndex] = { v: cell.value };
    }
  });

  return cellData;
}

const workbookData = {
  id: 'dataglow-grid',
  sheetOrder: ['sheet-01'],
  sheets: {
    'sheet-01': {
      id: 'sheet-01',
      name: 'DataGlow Grid',
      rowCount: gridDataset.rows.length + 1,
      columnCount: gridDataset.headers.length,
      cellData: toUniverCellData(gridDataset),
    },
  },
};

const { univerAPI } = createUniver({
  presets: [UniverSheetsCorePreset({ container: 'dataglow-grid-root' })],
});
univerAPI.createWorkbook(workbookData);
```

The `GridDataset.stats` block (`overallHealthScore`, `warningRows`,
`errorRows`, `criticalRows`) is rendered by the UI layer *outside* the Univer
canvas — typically as a header strip above the grid — since Univer has no
native concept of a dataset-level health score.

---

## 4. Validation tinting

Cell tinting is driven entirely by `mapSeverityToStyle()`. The UI layer
iterates `GridDataset.rows`, resolves a style descriptor per row (or per
cell, if per-cell severity is later added), and applies it through Univer's
range/cell style API:

```js
import { mapSeverityToStyle } from '../js/grid/grid-bridge.js';

const worksheet = univerAPI.getActiveWorkbook().getActiveSheet();

gridDataset.rows.forEach(row => {
  const style = mapSeverityToStyle(row.rowSeverity);
  if (!style.backgroundColor) return; // 'clean' rows: no-op, nothing to tint

  const univerRowIndex = row.index + 1; // +1 for the header row offset
  const range = worksheet.getRange(univerRowIndex, 0, 1, gridDataset.headers.length);

  range.setBackgroundColor(style.backgroundColor);
  // borderLeft ('3px solid #RRGGBB') is parsed into Univer's setBorder() call;
  // style.pulse (critical only) drives a CSS animation class applied to the
  // rendered range's DOM overlay, since Univer's style model has no native
  // "pulse" concept.
});
```

Column header health (`header.healthLabel`, `header.healthScore`) is applied
the same way to the header row range, plus rendered as a small chip
(`header.typeChip` + a colored dot for `healthLabel`) in the column header —
DataGlow Grid's column header schema described in the PR.

---

## 5. Rendering agent diffs

Agent-proposed edits (`buildAgentDiff()`) are **not** written directly into
Univer cell values. Instead, the UI layer uses
[Univer's custom cell renderer](https://docs.univer.ai) to overlay a diff
view on top of the current cell value:

- `diff.displayOriginal` is rendered with a strikethrough style.
- `diff.displayProposed` is rendered in green immediately after it.
- An inline **Accept** / **Dismiss** button pair is rendered in the same
  custom cell.
- Clicking **Accept** sets `diff.accepted = true`, then the UI layer calls
  `applyAgentDiffs(gridDataset, diffs)` to produce a new `GridDataset`, and
  re-renders only that cell's Univer value (via `range.setValue(...)`) —
  it does not require rebuilding the whole sheet.
- Clicking **Dismiss** sets `diff.dismissed = true` and removes the overlay;
  the underlying cell value is untouched, since `applyAgentDiffs` already
  ignores dismissed diffs.

Sketch of the custom renderer registration:

```js
worksheet.registerCellRenderer(diff.rowIndex + 1, colIndex, (ctx) => {
  ctx.drawText(diff.displayOriginal, { strikethrough: true, color: '#999' });
  ctx.drawText(diff.displayProposed, { color: '#2E7D32', offsetX: ctx.textWidth + 6 });
  ctx.drawButton('Accept', { onClick: () => onAcceptDiff(diff) });
  ctx.drawButton('Dismiss', { onClick: () => onDismissDiff(diff) });
});
```

(Exact custom-renderer API surface — `registerCellRenderer` vs. a
`ICellRenderer` class Univer expects registered per-cell-type — is resolved
when the UI layer is implemented against a pinned Univer version; this
scaffold intentionally does not depend on Univer's exact renderer API since
that would require the npm package as a dependency of this bridge module.)

---

## 6. Minimal Univer initialization with DataGlow data

Putting the previous sections together, the minimal path from a DuckDB
result to a rendered, tinted Univer sheet:

```html
<div id="dataglow-grid-root" style="height: 100vh"></div>

<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/rxjs@7.8.1/dist/bundles/rxjs.umd.min.js"></script>
<script src="https://unpkg.com/@univerjs/presets@0.25.1/lib/umd/index.js"></script>
<script src="https://unpkg.com/@univerjs/preset-sheets-core@0.25.1/lib/umd/index.js"></script>
<script src="https://unpkg.com/@univerjs/preset-sheets-core@0.25.1/lib/umd/locales/en-US.js"></script>
<link rel="stylesheet" href="https://unpkg.com/@univerjs/preset-sheets-core@0.25.1/lib/index.css" />

<script type="module">
  import { formatRowsForGrid, mapSeverityToStyle } from '/js/grid/grid-bridge.js';

  const { createUniver, LocaleType, mergeLocales } = UniverPresets;
  const { UniverSheetsCorePreset } = UniverPresetSheetsCore;

  async function renderDataGlowGrid(rows, columns, validationFindings) {
    const gridDataset = formatRowsForGrid(rows, columns, validationFindings);

    const { univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      locales: { [LocaleType.EN_US]: mergeLocales(UniverPresetSheetsCoreEnUS) },
      presets: [UniverSheetsCorePreset({ container: 'dataglow-grid-root' })],
    });

    const workbook = univerAPI.createWorkbook(toWorkbookData(gridDataset)); // see section 3
    const worksheet = workbook.getActiveSheet();

    gridDataset.rows.forEach(row => {
      const style = mapSeverityToStyle(row.rowSeverity);
      if (!style.backgroundColor) return;
      worksheet
        .getRange(row.index + 1, 0, 1, gridDataset.headers.length)
        .setBackgroundColor(style.backgroundColor);
    });

    return { univerAPI, workbook, gridDataset };
  }
</script>
```

---

## 7. Pivot tables

`js/grid/pivot-engine.js` builds pivot tables entirely from a `GridDataset` —
no DuckDB re-query, no Univer dependency. The pipeline is:

```js
import { formatRowsForGrid } from '../js/grid/grid-bridge.js';
import {
  validatePivotConfig,
  buildPivotDescriptor,
  pivotToGridDataset,
} from '../js/grid/pivot-engine.js';

const gridDataset = formatRowsForGrid(rows, columns, validationFindings);

const pivotConfig = {
  rowFields: ['region'],
  colFields: ['product'],       // optional — omit for a single "Total" column
  valueField: 'amount',
  aggregation: 'sum',            // 'sum' | 'avg' | 'count' | 'min' | 'max'
  filters: { region: ['East', 'West'] }, // optional
};

const { valid, errors } = validatePivotConfig(gridDataset, pivotConfig);
if (!valid) throw new Error(errors.join('; '));

const pivotDescriptor = buildPivotDescriptor(gridDataset, pivotConfig);
// pivotDescriptor: { config, rowGroups, colGroups, cells, totals: { row, col, grand } }

// Convert back into a GridDataset-compatible shape so it can be rendered
// through the exact same toUniverCellData() pipeline described in section 3.
const pivotGridDataset = pivotToGridDataset(pivotDescriptor);
const workbookData = {
  id: 'dataglow-grid-pivot',
  sheetOrder: ['pivot-01'],
  sheets: {
    'pivot-01': {
      id: 'pivot-01',
      name: 'Pivot',
      rowCount: pivotGridDataset.rows.length + 1,
      columnCount: pivotGridDataset.headers.length,
      cellData: toUniverCellData(pivotGridDataset), // reuse section 3's helper
    },
  },
};
univerAPI.createWorkbook(workbookData);
```

Key properties of pivot output:

- The first column (`__pivot_row__`) holds the row-group labels; if
  `colFields` is supplied, one column is emitted per unique column-group
  value, followed by a trailing `Total` column; with no `colFields`, there is
  just a single `Total` value column.
- A trailing `Total` row holds column totals plus the grand total in the
  bottom-right cell.
- Every header in a pivot `GridDataset` carries `typeChip: 'pivot'` and a
  neutral `healthLabel: 'clean'` / `healthScore: 1.0` — validation findings
  are anchored to raw source rows, not derived aggregates, so pivot output is
  intentionally never tinted by `mapSeverityToStyle()`. The UI layer should
  branch on `pivotGridDataset.isPivot === true` to skip the validation-tinting
  step from section 4 entirely for a pivot sheet.
- `formatPivotValue(value, aggregation, decimalPlaces = 2)` renders numeric
  aggregates with thousands separators (`"1,234.56"`) and integer counts
  (`"42"`), and is what populates `displayValue` on every pivot cell.

---

## 8. Formula bridge

Univer ships its own Excel-compatible formula engine
(`@univerjs/engine-formula`, see section 1) — it parses and evaluates
formulas client-side. `js/grid/formula-bridge.js` does **not** re-implement
formula parsing; instead it documents the DuckDB SQL equivalent of each
supported formula (for Story View / audit trails) and cross-checks computed
formula results against DataGlow's column health scores.

`FORMULA_SQL_MAP` (18 formulas as of this writing):

| Excel formula | DuckDB SQL equivalent |
|---|---|
| `SUM` | `SUM({col})` |
| `AVERAGE` | `AVG({col})` |
| `COUNT` / `COUNTA` | `COUNT({col})` |
| `COUNTBLANK` | `COUNT(*) FILTER (WHERE {col} IS NULL)` |
| `COUNTIF` | `COUNT(*) FILTER (WHERE {col} {op} {val})` |
| `SUMIF` | `SUM({col}) FILTER (WHERE {col} {op} {val})` |
| `AVERAGEIF` | `AVG({col}) FILTER (WHERE {col} {op} {val})` |
| `MAX` / `MIN` | `MAX({col})` / `MIN({col})` |
| `STDEV` / `STDEVP` | `STDDEV({col})` / `STDDEV_POP({col})` |
| `VAR` / `VARP` | `VARIANCE({col})` / `VAR_POP({col})` |
| `MEDIAN` | `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {col})` |
| `DISTINCTCOUNT` | `COUNT(DISTINCT {col})` |
| `MODE` | `MODE() WITHIN GROUP (ORDER BY {col})` |
| `PRODUCT` | `PRODUCT({col})` |

Usage:

```js
import {
  isFormulaSupported,
  getFormulaSQL,
  buildFormulaAudit,
  validateFormulaResult,
} from '../js/grid/formula-bridge.js';

isFormulaSupported('SUM');              // true
isFormulaSupported('VLOOKUP');          // false — not in the SQL map

getFormulaSQL('SUM', 'amount');         // 'SUM("amount")'
getFormulaSQL('COUNTIF', 'status', { op: '=', val: 'denied' });
// => `COUNT(*) FILTER (WHERE "status" = 'denied')`

// After Univer evaluates the formulas on the sheet, hand the results back
// to the audit builder for Story View:
const audit = buildFormulaAudit([
  { cellRef: 'B1', formulaName: 'SUM', columnName: 'amount', result: 450 },
  { cellRef: 'B2', formulaName: 'VLOOKUP', columnName: 'amount', result: 'x' },
]);
// => { supportedCount: 1, unsupportedCount: 1,
//      formulasByType: { SUM: 1, VLOOKUP: 1 },
//      sqlEquivalents: ['SUM("amount")'] }

// Cross-check a formula result against the column's health score
// (buildColumnHealthScore from grid-bridge.js) to flag misleading aggregates:
const check = validateFormulaResult('SUM', 0, columnHealthScore);
if (!check.consistent) showWarningBadge(check.warning);
```

`validateFormulaResult` is a display-layer heuristic, not a statistical
test: it flags `SUM`/`AVERAGE`/`MIN`/`MAX`/`STDEV`/`MEDIAN`/`VAR`-family
results that collapse to `0`/`null` on a column with a health score below
0.8 (possible silent null-collapse), and flags `COUNT`-family results on a
column with a health score below 0.5 (population may be understated).

---

## 9. Cell-level validation coloring

`grid-bridge.js`'s `mapSeverityToStyle()` (section 4) operates at row
granularity. `js/grid/validation-coloring.js` extends the same severity
model down to individual cells, and adds the diff-overlay pair used when
rendering agent-proposed edits (section 5).

```js
import {
  computeCellStyles,
  SEVERITY_COLORS,
  buildDiffOverlay,
  cellStylesToUniverFormat,
  computeRowHealth,
} from '../js/grid/validation-coloring.js';

// 1. Compute a CellStyleMap from the same validation findings passed to
//    formatRowsForGrid() — { [rowIndex]: { [colIndex]: CellStyle } }
const cellStyleMap = computeCellStyles(gridDataset, validationFindings);

// 2. Convert to a partial Univer IWorkbookData `styles` table + a cellData
//    patch keyed the same way as toUniverCellData() in section 3.
const { styles, cellStylePatch } = cellStylesToUniverFormat(cellStyleMap);

// 3. Merge into the workbook snapshot before createWorkbook(), or apply
//    post-hoc via worksheet.setStyle(row, col, styleId) per patched cell.
workbookData.sheets['sheet-01'].styles = styles;
for (const [rowIndex, cols] of Object.entries(cellStylePatch)) {
  for (const [colIndex, { s }] of Object.entries(cols)) {
    workbookData.sheets['sheet-01'].cellData[rowIndex][colIndex].s = s;
  }
}

// 4. Row-level rollup (e.g. for a left-rail row-health gutter):
const rowHealth = computeRowHealth(cellStyleMap, someRowIndex); // 'clean'|'warning'|'error'|'critical'
```

`SEVERITY_COLORS` are the canonical severity → color values (also re-derived
by `computeRowHealth`'s reverse lookup):

| Severity | background | border | text |
|---|---|---|---|
| `error` | `rgba(161,44,123,0.08)` | `#A12C7B` | `null` |
| `warning` | `rgba(150,66,25,0.08)` | `#964219` | `null` |
| `critical` | `rgba(161,44,123,0.12)` | `#A12C7B` | `#A12C7B` |
| `clean` | `null` | `null` | `null` |

Agent diff overlays (section 5) get their style pair from `buildDiffOverlay`:

```js
const overlay = buildDiffOverlay('B4', originalValue, proposedValue);
// overlay.original: red background + strikethrough text, note = "Original value: ..."
// overlay.proposed: green background + underline + bold text, note = "Proposed value: ..."
// overlay.controlAnchor === 'B4' — the cell the Accept/Dismiss buttons render against
```

The Univer style keys used by `cellStylesToUniverFormat()` follow Univer's
`IStyleData` shape: `bg` (fill, `{ rgb }`), `cl` (font color, `{ rgb }`),
`bl` (bold, `0`/`1`), `st`/`ul` (strikethrough/underline, `{ s: 0|1 }`), and
`bd` (border, per-side `{ s, cl }`). Identical `CellStyle` objects are
de-duplicated into a single style-id entry in the `styles` table, matching
Univer's flat style-lookup convention.

---

## References

- [Univer GitHub repository](https://github.com/dream-num/univer)
- [Univer CDN installation guide](https://docs.univer.ai/guides/sheets/getting-started/installation/cdn)
- [Univer installation & basic usage](https://docs.univer.ai/guides/sheets/getting-started/installation)
- [@univerjs/core on npm](https://www.npmjs.com/package/@univerjs/core)
- [@univerjs/sheets on npm](https://www.npmjs.com/package/@univerjs/sheets)
- [@univerjs/sheets-ui on npm](https://www.npmjs.com/package/@univerjs/sheets-ui)
- [Univer license (Apache-2.0)](https://github.com/dream-num/univer/blob/dev/LICENSE)

## Related source

- `js/grid/grid-bridge.js` — the base data contract layer this doc describes
- `js/grid/pivot-engine.js` — pivot table engine (section 7)
- `js/grid/formula-bridge.js` — Excel formula → DuckDB SQL bridge (section 8)
- `js/grid/validation-coloring.js` — cell-level validation coloring and diff overlay (section 9)
- `test/grid/grid-bridge.test.js` — the base contract test suite
- `test/grid/pivot-engine.test.js` — pivot engine test suite
- `test/grid/formula-bridge.test.js` — formula bridge test suite
- `test/grid/validation-coloring.test.js` — validation coloring test suite
