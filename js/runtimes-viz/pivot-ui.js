// ============================================================
// DATAGLOW — Pivot Table Tab (ships dark behind the pivotTable flag)
// ============================================================
// Thin DOM/renderer layer over js/pivot/pivot-builder.js's pure SQL-
// generation logic. Owns: the Rows/Columns/Values well UI, the run button,
// error/warning display, and the result table render. Never runs a query
// or generates SQL itself -- every SQL string comes from pivot-builder.js
// so the pivot tab's numbers are provably the same numbers the SQL tab
// would produce for an equivalent hand-written query.
//
// Interaction model: tap-to-add pill buttons (not native HTML5 drag-and-
// drop). DataGlow is mobile-primary (iPhone/iPad) and native drag-and-drop
// is a poor fit for touch — no drag handles, awkward long-press conflicts
// with scrolling, and finicky drop-target hit-testing on small screens. Tap
// a column chip to add it to the currently-focused well; tap an item inside
// a well to remove it. Every interactive control is sized to the app's
// existing 44px mobile touch-target minimum (css/app.css, fixed this same
// run in PR #372) via the shared `.pivot-chip`/`.pivot-well-item` classes
// defined below.

import { el, escapeHtml, formatNumber } from '../app-shell/utils.js';
import * as engine from '../app-shell/duckdb-engine.js';
import {
  AGGREGATIONS,
  classifyColumns,
  createEmptyConfig,
  validateConfig,
  buildPivotQuery,
  buildCardinalityCheckSQL,
  MAX_PIVOT_CARDINALITY,
} from '../pivot/pivot-builder.js';

// Module-level state, mirroring the Glow Canvas pattern: main.js owns
// nothing pivot-specific beyond calling renderPivotTab()/mounting the host
// div — all pivot state lives here, scoped to this file.
let pivotState = {
  sourceTable: null,
  allColumns: [],
  numericColumns: [],
  config: null,
  focusedWell: 'rows', // which well a tapped column chip adds to: rows | columns | values
  result: null, // last executed { columns, rows, elapsedMs } or null
  error: null,
  warning: null, // cardinality warning message, or null
  running: false,
};

function resetForTable(tableName, describeRows) {
  const { allColumns, numericColumns } = classifyColumns(describeRows);
  pivotState = {
    sourceTable: tableName,
    allColumns,
    numericColumns,
    config: createEmptyConfig(tableName),
    focusedWell: 'rows',
    result: null,
    error: null,
    warning: null,
    running: false,
  };
}

function wellChip(label, onRemove) {
  return el('span', { class: 'pivot-well-item', role: 'listitem' }, [
    document.createTextNode(label),
    el('button', {
      class: 'pivot-well-item-remove',
      type: 'button',
      'aria-label': `Remove ${label}`,
      onclick: onRemove,
    }, ['\u00d7']),
  ]);
}

function renderWell(title, key, items, renderItemLabel, onRemove) {
  return el('div', { class: 'pivot-well', 'data-well': key }, [
    el('div', { class: 'pivot-well-header' }, [
      el('span', { class: 'pivot-well-title' }, [title]),
      el('button', {
        class: `pivot-well-focus-btn${pivotState.focusedWell === key ? ' pivot-well-focus-btn--active' : ''}`,
        type: 'button',
        onclick: () => { pivotState.focusedWell = key; redraw(); },
      }, [pivotState.focusedWell === key ? 'Adding here' : 'Add here']),
    ]),
    el('div', { class: 'pivot-well-items', role: 'list' },
      items.length > 0
        ? items.map((item, idx) => wellChip(renderItemLabel(item), () => onRemove(idx))
        )
        : [el('span', { class: 'pivot-well-empty' }, ['Empty'])]
    ),
  ]);
}

function addToFocusedWell(columnName) {
  const cfg = pivotState.config;
  if (pivotState.focusedWell === 'rows') {
    if (!cfg.rows.includes(columnName)) cfg.rows.push(columnName);
  } else if (pivotState.focusedWell === 'columns') {
    if (!cfg.columns.includes(columnName)) cfg.columns.push(columnName);
  } else if (pivotState.focusedWell === 'values') {
    // Values entries are {column, agg} objects, not bare strings, and allow
    // the same column added twice under different aggregations (e.g. both
    // SUM(amount) and AVG(amount) side by side is a normal Excel pattern).
    cfg.values.push({ column: columnName, agg: 'sum' });
  }
  pivotState.result = null;
  pivotState.error = null;
  pivotState.warning = null;
  redraw();
}

function renderColumnPicker() {
  const isValuesFocus = pivotState.focusedWell === 'values';
  const source = isValuesFocus ? pivotState.numericColumns : pivotState.allColumns;
  const hint = isValuesFocus
    ? 'Numeric columns only — Values needs something to aggregate.'
    : 'Any column can group rows or split columns.';
  return el('div', { class: 'pivot-column-picker' }, [
    el('div', { class: 'pivot-column-picker-hint' }, [hint]),
    el('div', { class: 'pivot-column-picker-chips' },
      source.length > 0
        ? source.map((c) => el('button', {
            class: 'pivot-chip',
            type: 'button',
            onclick: () => addToFocusedWell(c),
          }, [c]))
        : [el('span', { class: 'pivot-well-empty' }, [isValuesFocus ? 'No numeric columns in this dataset.' : 'No columns available.'])]
    ),
  ]);
}

function renderValuesWell() {
  const cfg = pivotState.config;
  return el('div', { class: 'pivot-well', 'data-well': 'values' }, [
    el('div', { class: 'pivot-well-header' }, [
      el('span', { class: 'pivot-well-title' }, ['Values']),
      el('button', {
        class: `pivot-well-focus-btn${pivotState.focusedWell === 'values' ? ' pivot-well-focus-btn--active' : ''}`,
        type: 'button',
        onclick: () => { pivotState.focusedWell = 'values'; redraw(); },
      }, [pivotState.focusedWell === 'values' ? 'Adding here' : 'Add here']),
    ]),
    el('div', { class: 'pivot-well-items', role: 'list' },
      cfg.values.length > 0
        ? cfg.values.map((v, idx) => el('span', { class: 'pivot-well-item pivot-well-item--value', role: 'listitem' }, [
            document.createTextNode(v.column + ' '),
            el('select', {
              class: 'pivot-agg-select',
              'aria-label': `Aggregation for ${v.column}`,
              onchange: (e) => { v.agg = e.target.value; pivotState.result = null; redraw(); },
            }, AGGREGATIONS.map((a) => el('option', { value: a.id, selected: a.id === v.agg ? 'selected' : null }, [a.label]))),
            el('button', {
              class: 'pivot-well-item-remove',
              type: 'button',
              'aria-label': `Remove ${v.column}`,
              onclick: () => { cfg.values.splice(idx, 1); pivotState.result = null; redraw(); },
            }, ['\u00d7']),
          ]))
        : [el('span', { class: 'pivot-well-empty' }, ['Empty'])]
    ),
  ]);
}

async function runPivot() {
  const cfg = pivotState.config;
  const errors = validateConfig(cfg, pivotState.allColumns);
  if (errors.length > 0) {
    pivotState.error = errors.join(' ');
    pivotState.result = null;
    redraw();
    return;
  }
  pivotState.error = null;
  pivotState.warning = null;
  pivotState.running = true;
  redraw();
  try {
    // Cardinality pre-flight: only meaningful when a Columns well is
    // populated (a group-by-only pivot has no column-explosion risk).
    if (cfg.columns.length > 0) {
      const cardSql = buildCardinalityCheckSQL(cfg.sourceTable, cfg.columns);
      const cardResult = await engine.runQuery(cardSql);
      const distinctCombos = Number(cardResult.rows[0]?.n || 0);
      if (distinctCombos > MAX_PIVOT_CARDINALITY) {
        pivotState.warning = `The Columns well would produce ${distinctCombos.toLocaleString()} distinct columns (over the ${MAX_PIVOT_CARDINALITY} limit). Pick a lower-cardinality column, or use the SQL tab directly if you really need the full spread.`;
        pivotState.running = false;
        redraw();
        return;
      }
    }
    const sql = buildPivotQuery(cfg, pivotState.allColumns);
    const t0 = performance.now();
    const result = await engine.runQuery(sql);
    pivotState.result = { ...result, elapsedMs: performance.now() - t0, sql };
  } catch (e) {
    pivotState.error = e && e.message ? e.message : String(e);
    pivotState.result = null;
  } finally {
    pivotState.running = false;
    redraw();
  }
}

function renderResultSection() {
  if (pivotState.error) {
    return el('div', { class: 'pivot-error', role: 'alert' }, [pivotState.error]);
  }
  if (pivotState.warning) {
    return el('div', { class: 'pivot-warning', role: 'alert' }, [pivotState.warning]);
  }
  if (!pivotState.result) {
    return el('div', { class: 'pivot-result-empty' }, ['Build a pivot above, then tap Run Pivot.']);
  }
  const { columns, rows, elapsedMs } = pivotState.result;
  if (rows.length === 0) {
    return el('div', { class: 'pivot-result-empty' }, ['Pivot ran successfully but returned no rows.']);
  }
  const head = el('thead', {}, [el('tr', {}, columns.map((c) => el('th', {}, [c])))]);
  const body = el('tbody', {}, rows.slice(0, 500).map((r) => el('tr', {}, columns.map((c) => el('td', { html: escapeHtml(formatNumber(r[c])) })))));
  const wrap = el('div', { class: 'result-table-wrap pivot-result-table-wrap' }, [
    el('table', { class: 'result-table' }, [head, body]),
  ]);
  const meta = el('div', { class: 'pivot-result-meta' }, [
    `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'} \u00b7 ${columns.length} column${columns.length === 1 ? '' : 's'} \u00b7 ${elapsedMs.toFixed(0)}ms`,
  ]);
  return el('div', {}, [meta, wrap]);
}

function renderSourcePicker(datasets) {
  return el('select', {
    class: 'pivot-source-select',
    'aria-label': 'Pivot source dataset',
    onchange: async (e) => {
      const ds = datasets.find((d) => d.table === e.target.value);
      if (!ds) return;
      const describeRows = await engine.getTableSchema(ds.table);
      resetForTable(ds.table, describeRows);
      redraw();
    },
  }, datasets.map((d) => el('option', { value: d.table, selected: d.table === pivotState.sourceTable ? 'selected' : null }, [d.name])));
}

let currentHostId = null;
let currentDatasets = [];

function redraw() {
  if (!currentHostId) return;
  const host = document.getElementById(currentHostId);
  if (!host) return;
  host.innerHTML = '';
  host.appendChild(build());
}

function build() {
  if (currentDatasets.length === 0) {
    return el('div', { class: 'pivot-empty-state' }, ['Load a dataset first — the Pivot tab builds on whatever you\u2019ve already loaded into DataGlow.']);
  }
  if (!pivotState.sourceTable) {
    // First render with datasets available: default to the first dataset.
    // The actual schema fetch is async, so render a lightweight loading
    // state and let the source-picker's own onchange (fired programmatically
    // below) populate real state.
    return el('div', { class: 'pivot-loading' }, ['Loading columns\u2026']);
  }
  const cfg = pivotState.config;
  return el('div', { class: 'pivot-builder' }, [
    el('div', { class: 'pivot-source-row' }, [
      el('span', { class: 'pivot-source-label' }, ['Dataset:']),
      renderSourcePicker(currentDatasets),
    ]),
    el('div', { class: 'pivot-wells' }, [
      renderWell('Rows', 'rows', cfg.rows, (c) => c, (idx) => { cfg.rows.splice(idx, 1); pivotState.result = null; redraw(); }),
      renderWell('Columns', 'columns', cfg.columns, (c) => c, (idx) => { cfg.columns.splice(idx, 1); pivotState.result = null; redraw(); }),
      renderValuesWell(),
    ]),
    renderColumnPicker(),
    el('div', { class: 'pivot-actions' }, [
      el('button', {
        class: 'pivot-run-btn btn btn-primary',
        type: 'button',
        disabled: pivotState.running ? 'disabled' : null,
        onclick: runPivot,
      }, [pivotState.running ? 'Running\u2026' : 'Run Pivot']),
    ]),
    el('div', { class: 'pivot-result' }, [renderResultSection()]),
  ]);
}

// Entry point called by main.js on every activation of the Pivot tab.
// datasets: state.datasets (the same array every other tab reads).
export async function renderPivotTab(hostId, datasets) {
  currentHostId = hostId;
  currentDatasets = datasets || [];
  const host = document.getElementById(hostId);
  if (!host) return;

  if (currentDatasets.length === 0) {
    pivotState.sourceTable = null;
    redraw();
    return;
  }

  // If the previously-selected source table no longer exists (dataset was
  // removed/replaced), or nothing has been selected yet, default to the
  // first available dataset and fetch its schema.
  const stillValid = pivotState.sourceTable && currentDatasets.some((d) => d.table === pivotState.sourceTable);
  if (!stillValid) {
    const first = currentDatasets[0];
    const describeRows = await engine.getTableSchema(first.table);
    resetForTable(first.table, describeRows);
  }
  redraw();
}
