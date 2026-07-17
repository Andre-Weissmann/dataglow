// ============================================================
// DATAGLOW — Glow Canvas: multi-chart dashboard layout (Batch 1 of N)
// ============================================================
// WHAT THIS IS: the first step toward a real multi-chart dashboard, replacing
// the single-chart-only limitation of the Visualize tab. Today Visualize can
// only show ONE chart at a time (js/runtimes-viz/visualize.js -> renderChart on
// the single '#viz-chart' node); Glow Canvas holds an ordered set of chart
// "cards", each laid out on a simple CSS grid, and draws each one by REUSING
// that same viz.renderChart — it invents no new chart engine and moves no data.
//
// BATCH 2 adds cross-filtering: clicking a categorical point/bar/slice in one
// card sets a single canvas-wide activeFilter {table, column, value}; every card
// on the SAME table redraws filtered (via viz.renderChart's new whereClause arg)
// and is badged, while different-table cards render unfiltered (there is no
// join-key model yet). Clicking the same point again toggles the filter off.
//
// WHAT THIS BATCH DELIBERATELY STILL DOES NOT DO: no drag-and-drop reordering,
// no cross-table (join-key) filtering, and no wiring into / replacement of the
// existing Visualize tab — those are later batches. It ships fully dark behind the
// `glowCanvas` flag (enabled:false); with the flag off nothing here mounts and
// the app shell is byte-for-byte unchanged. The flag is checked by the CALLER
// in main.js, never inside this module.
//
// Identity split (same convention as js/rooms/room-ui.js): the layout algebra
// (createCanvasLayout / addCard / removeCard / updateCardPosition /
// serializeLayout / deserializeLayout) is PURE, Node-testable, and NEVER
// mutates its input — every mutator returns a NEW layout. The renderer
// (renderCanvas) turns a layout into DOM and is thin enough to leave to the
// browser/e2e path; it delegates every actual chart draw to the injected
// (or imported) viz.renderChart.

import { el } from '../app-shell/utils.js';
import * as viz from './visualize.js';

// A card occupies a rectangle on a fixed-width grid. Batch 1 uses a simple
// 2-column grid and a default card size of 1 column wide by 1 row tall; the
// next-available-slot packer below fills left-to-right, top-to-bottom.
const GRID_COLUMNS = 2;
const DEFAULT_CARD_W = 1;
const DEFAULT_CARD_H = 1;

// The closed set of chart types Batch 1 understands — exactly the ones the
// existing single-chart Visualize builder already offers, so a Glow Canvas card
// can render nothing the Visualize tab could not already draw.
export const CANVAS_CHART_TYPES = ['bar', 'line', 'scatter', 'pie', 'histogram', 'box'];

/**
 * A fresh, empty canvas layout. The shape is intentionally tiny and JSON-safe
 * so it round-trips cleanly through serializeLayout/deserializeLayout and the
 * IndexedDB store. `nextId` is a monotonic counter so ids stay unique and
 * stable even after cards are removed (removing card 2 never lets a later add
 * reuse id 2).
 * @returns {{cards: Array<object>, nextId: number}}
 */
export function createCanvasLayout() {
  return { cards: [], nextId: 1, activeFilter: null };
}

// Normalize any value into a well-formed {table, column, value} cross-filter, or
// null. A filter is only valid with a string table + string column and a
// non-null value (coerced to string, matching how DuckDB categories come back);
// anything else (garbage, partial, wrong types) becomes null and never throws.
function normalizeFilter(filter) {
  if (!filter || typeof filter !== 'object') return null;
  const table = typeof filter.table === 'string' ? filter.table : null;
  const column = typeof filter.column === 'string' ? filter.column : null;
  if (table === null || column === null || filter.value === undefined || filter.value === null) return null;
  return { table, column, value: String(filter.value) };
}

// Normalize any value into a well-formed layout object. Used by every pure
// function so a caller passing a partial/garbage layout never throws and never
// corrupts stored state. Always returns a NEW object with a fresh cards array.
function normalizeLayout(layout) {
  const l = (layout && typeof layout === 'object') ? layout : {};
  const cards = Array.isArray(l.cards) ? l.cards.filter(c => c && typeof c === 'object') : [];
  // nextId must always be strictly greater than every existing id so a new add
  // can never collide with a card that is already present.
  const maxId = cards.reduce((m, c) => (Number.isFinite(c.id) && c.id > m ? c.id : m), 0);
  const declared = Number.isFinite(l.nextId) ? l.nextId : 1;
  const nextId = Math.max(declared, maxId + 1);
  return {
    cards: cards.map(c => ({ ...c, gridPos: { ...(c.gridPos || {}) } })),
    nextId,
    activeFilter: normalizeFilter(l.activeFilter),
  };
}

// Find the next free grid slot, scanning row-by-row, column-by-column, so a new
// card lands in the first open cell of a fixed-width (GRID_COLUMNS) grid. This
// is deliberately a simple packer (Batch 1 has no drag-reorder); it only needs
// to produce a sensible, non-overlapping default position for single-cell cards.
function nextAvailableSlot(cards) {
  const occupied = new Set();
  for (const c of cards) {
    const gp = c.gridPos || {};
    const row = Number.isFinite(gp.row) ? gp.row : 0;
    const col = Number.isFinite(gp.col) ? gp.col : 0;
    const w = Number.isFinite(gp.w) && gp.w > 0 ? gp.w : DEFAULT_CARD_W;
    const h = Number.isFinite(gp.h) && gp.h > 0 ? gp.h : DEFAULT_CARD_H;
    for (let r = row; r < row + h; r++) {
      for (let col2 = col; col2 < col + w; col2++) occupied.add(`${r},${col2}`);
    }
  }
  for (let row = 0; ; row++) {
    for (let col = 0; col < GRID_COLUMNS; col++) {
      if (!occupied.has(`${row},${col}`)) return { row, col, w: DEFAULT_CARD_W, h: DEFAULT_CARD_H };
    }
  }
}

/**
 * PURE. Return a NEW layout with `cardSpec` appended, auto-assigning an
 * incrementing id and a sensible default gridPos (next free cell in the grid)
 * unless the caller supplied a gridPos explicitly. The input layout is never
 * mutated.
 * @param {object} layout
 * @param {{table?:string, chartType?:string, xCol?:string, yCol?:string, title?:string, gridPos?:object}} cardSpec
 * @returns {{cards: Array<object>, nextId: number}}
 */
export function addCard(layout, cardSpec = {}) {
  const l = normalizeLayout(layout);
  const spec = (cardSpec && typeof cardSpec === 'object') ? cardSpec : {};
  const id = l.nextId;
  const suppliedPos = (spec.gridPos && typeof spec.gridPos === 'object') ? spec.gridPos : null;
  const gridPos = suppliedPos
    ? {
        row: Number.isFinite(suppliedPos.row) ? suppliedPos.row : 0,
        col: Number.isFinite(suppliedPos.col) ? suppliedPos.col : 0,
        w: Number.isFinite(suppliedPos.w) && suppliedPos.w > 0 ? suppliedPos.w : DEFAULT_CARD_W,
        h: Number.isFinite(suppliedPos.h) && suppliedPos.h > 0 ? suppliedPos.h : DEFAULT_CARD_H,
      }
    : nextAvailableSlot(l.cards);
  const card = {
    id,
    table: typeof spec.table === 'string' ? spec.table : '',
    chartType: typeof spec.chartType === 'string' ? spec.chartType : 'bar',
    xCol: typeof spec.xCol === 'string' ? spec.xCol : '',
    yCol: typeof spec.yCol === 'string' ? spec.yCol : '',
    title: typeof spec.title === 'string' ? spec.title : '',
    gridPos,
  };
  return { cards: [...l.cards, card], nextId: id + 1, activeFilter: l.activeFilter };
}

/**
 * PURE. Return a NEW layout with the card whose id === cardId removed. If no
 * such card exists the layout is returned unchanged (but still a fresh copy).
 * nextId is preserved so removing a card never lets a future add reuse its id.
 * @param {object} layout
 * @param {number} cardId
 * @returns {{cards: Array<object>, nextId: number}}
 */
export function removeCard(layout, cardId) {
  const l = normalizeLayout(layout);
  return { cards: l.cards.filter(c => c.id !== cardId), nextId: l.nextId, activeFilter: l.activeFilter };
}

/**
 * PURE. Return a NEW layout with exactly one card's gridPos replaced. Unknown
 * ids leave the layout unchanged (fresh copy). Only the four grid fields are
 * taken from `gridPos`, each falling back to the card's current value so a
 * partial update (e.g. just a new row) is safe.
 * @param {object} layout
 * @param {number} cardId
 * @param {{row?:number, col?:number, w?:number, h?:number}} gridPos
 * @returns {{cards: Array<object>, nextId: number}}
 */
export function updateCardPosition(layout, cardId, gridPos = {}) {
  const l = normalizeLayout(layout);
  const gp = (gridPos && typeof gridPos === 'object') ? gridPos : {};
  const cards = l.cards.map((c) => {
    if (c.id !== cardId) return c;
    const cur = c.gridPos || {};
    return {
      ...c,
      gridPos: {
        row: Number.isFinite(gp.row) ? gp.row : (Number.isFinite(cur.row) ? cur.row : 0),
        col: Number.isFinite(gp.col) ? gp.col : (Number.isFinite(cur.col) ? cur.col : 0),
        w: Number.isFinite(gp.w) && gp.w > 0 ? gp.w : (Number.isFinite(cur.w) && cur.w > 0 ? cur.w : DEFAULT_CARD_W),
        h: Number.isFinite(gp.h) && gp.h > 0 ? gp.h : (Number.isFinite(cur.h) && cur.h > 0 ? cur.h : DEFAULT_CARD_H),
      },
    };
  });
  return { cards, nextId: l.nextId, activeFilter: l.activeFilter };
}

// ---------- cross-filter (Batch 2): a single canvas-wide active filter ----------
// The filter is a top-level {table, column, value} on the LAYOUT (not per-card).
// Cross-filter semantic for this batch: a card reacts ONLY if its `table` equals
// the filter's table (there is no join-key model yet, so different-table cards
// cannot be meaningfully filtered — that's a future batch). All three functions
// follow the same never-mutate / return-a-new-layout discipline as addCard.

/**
 * PURE. Return a NEW layout whose activeFilter is set to `filter` (normalized;
 * garbage becomes null). The input layout is never mutated.
 * @param {object} layout
 * @param {{table:string, column:string, value:*}|null} filter
 * @returns {{cards: Array<object>, nextId: number, activeFilter: object|null}}
 */
export function setActiveFilter(layout, filter) {
  const l = normalizeLayout(layout);
  return { cards: l.cards, nextId: l.nextId, activeFilter: normalizeFilter(filter) };
}

/**
 * PURE. Return a NEW layout with no active filter. The input is never mutated.
 * @param {object} layout
 * @returns {{cards: Array<object>, nextId: number, activeFilter: null}}
 */
export function clearActiveFilter(layout) {
  const l = normalizeLayout(layout);
  return { cards: l.cards, nextId: l.nextId, activeFilter: null };
}

/**
 * PURE. Toggle a cross-filter: if `filter` is already exactly the active one
 * (same table+column+value), clear it; otherwise set it. This gives the real
 * cross-filter UX where clicking the same point again turns the filter off.
 * @param {object} layout
 * @param {{table:string, column:string, value:*}} filter
 * @returns {{cards: Array<object>, nextId: number, activeFilter: object|null}}
 */
export function toggleFilter(layout, filter) {
  const l = normalizeLayout(layout);
  const next = normalizeFilter(filter);
  const cur = l.activeFilter;
  if (next && cur && cur.table === next.table && cur.column === next.column && cur.value === next.value) {
    return { cards: l.cards, nextId: l.nextId, activeFilter: null };
  }
  return { cards: l.cards, nextId: l.nextId, activeFilter: next };
}

// Escape a value as a DuckDB/standard-SQL single-quoted string literal by
// doubling any embedded single quote, so a category value like "O'Brien" or a
// hostile "x' OR '1'='1" can never break out of the literal.
function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * PURE. The raw-SQL WHERE clause a given card should be drawn with, given the
 * layout's active filter. Returns '' when there is no filter or the card is on a
 * DIFFERENT table (different-table cards render unfiltered — the cross-filter
 * semantic for this batch). The column identifier is double-quoted (embedded
 * double quotes doubled) and the value is single-quote escaped.
 * @param {object} layout
 * @param {{table?:string}} card
 * @returns {string}
 */
export function filterWhereClause(layout, card) {
  const l = normalizeLayout(layout);
  const f = l.activeFilter;
  if (!f || !card || card.table !== f.table) return '';
  const col = String(f.column).replace(/"/g, '""');
  return `"${col}" = ${sqlStringLiteral(f.value)}`;
}

/**
 * PURE. Serialize a layout to a JSON string for save/reload. Normalizes first
 * so the stored form is always well-shaped.
 * @param {object} layout
 * @returns {string}
 */
export function serializeLayout(layout) {
  return JSON.stringify(normalizeLayout(layout));
}

/**
 * PURE. Parse a layout from a JSON string. Malformed JSON — or JSON that does
 * not describe a layout — returns a safe empty layout and NEVER throws, so a
 * corrupt stored value can never take down the canvas.
 * @param {string} json
 * @returns {{cards: Array<object>, nextId: number}}
 */
export function deserializeLayout(json) {
  if (typeof json !== 'string' || !json) return createCanvasLayout();
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_e) {
    return createCanvasLayout();
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cards)) {
    return createCanvasLayout();
  }
  return normalizeLayout(parsed);
}

// ---------- thin DOM renderer (browser-only, left to the e2e path) ----------

/**
 * Render `layout` into the container with id `containerId`. Thin: it draws each
 * card as a titled tile positioned on a CSS grid and delegates the actual chart
 * draw to viz.renderChart (never reimplementing it). It holds no layout state of
 * its own — the caller owns the layout and re-invokes this after any mutation.
 *
 * @param {string} containerId  id of the host element
 * @param {object} layout       a layout from the pure functions above
 * @param {object} [opts]
 * @param {(layout:object)=>void} [opts.onChange]  called with the NEW layout after
 *   a card is removed or added, so the caller can persist + re-render
 * @param {Array<{table:string, cols?:Array<{name:string}>}>} [opts.datasets]  optional
 *   dataset list to drive the "Add chart" form; a text-input fallback is used otherwise
 * @param {typeof viz.renderChart} [opts.renderChart]  injectable chart renderer (defaults to viz.renderChart)
 * @returns {{layout:object}|undefined}
 */
export function renderCanvas(containerId, layout, opts = {}) {
  const host = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
  if (!host) return;
  const current = normalizeLayout(layout);
  const { onChange, datasets = [], renderChart = viz.renderChart } = opts;
  host.innerHTML = '';

  const emit = (next) => { if (typeof onChange === 'function') onChange(next); };

  // A click on a categorical point cross-filters: toggle the layout's active
  // filter (clicking the same point again clears it) and re-render. Passed as a
  // generic opts.onPointClick into viz.renderChart, which stays Glow-Canvas-
  // agnostic. `current` is the layout at render time, which is exactly what the
  // toggle must compare against.
  const onPointClick = (table, column, value) => emit(toggleFilter(current, { table, column, value }));

  // ---- toolbar: "Add chart", the chart count, and (when filtered) Clear filter ----
  const toolbarChildren = [
    el('button', {
      type: 'button',
      class: 'btn btn-primary',
      'data-testid': 'glow-canvas-add',
      onclick: () => toggleAddForm(),
    }, 'Add chart'),
    el('span', {
      'data-testid': 'glow-canvas-count',
      style: 'color:var(--color-text-muted,#666); font-size:var(--text-sm,13px);',
    }, current.cards.length === 1 ? '1 chart' : `${current.cards.length} charts`),
  ];
  if (current.activeFilter) {
    const f = current.activeFilter;
    toolbarChildren.push(el('span', {
      'data-testid': 'glow-canvas-filter-indicator',
      style: 'margin-left:auto; color:var(--color-text-muted,#666); font-size:var(--text-sm,13px);',
    }, `Filtered: ${f.column} = ${f.value}`));
    toolbarChildren.push(el('button', {
      type: 'button',
      class: 'btn btn-secondary',
      'data-testid': 'glow-canvas-clear-filter',
      onclick: () => emit(clearActiveFilter(current)),
    }, 'Clear filter'));
  }
  const toolbar = el('div', {
    'data-testid': 'glow-canvas-toolbar',
    style: 'display:flex; align-items:center; gap:var(--space-2,8px); margin-bottom:var(--space-3,12px);',
  }, toolbarChildren);
  host.appendChild(toolbar);

  // ---- inline add form (minimal; text-input fallback acceptable for Batch 1) ----
  const form = el('form', {
    'data-testid': 'glow-canvas-add-form',
    style: 'display:none; gap:var(--space-2,8px); flex-wrap:wrap; align-items:flex-end; margin-bottom:var(--space-3,12px); padding:var(--space-3,12px); border:1px solid var(--color-border,#e2e2e2); border-radius:var(--radius,8px);',
  });
  function field(label, input) {
    return el('label', { style: 'display:flex; flex-direction:column; gap:2px; font-size:var(--text-xs,12px); color:var(--color-text-muted,#666);' }, [label, input]);
  }
  const tableInput = datasets.length
    ? el('select', { 'data-testid': 'glow-canvas-field-table', class: 'btn btn-secondary' },
        datasets.filter(d => d && d.table).map(d => el('option', { value: d.table }, d.table)))
    : el('input', { 'data-testid': 'glow-canvas-field-table', type: 'text', placeholder: 'table', class: 'btn btn-secondary' });
  const typeInput = el('select', { 'data-testid': 'glow-canvas-field-type', class: 'btn btn-secondary' },
    CANVAS_CHART_TYPES.map(t => el('option', { value: t }, t)));
  const xInput = el('input', { 'data-testid': 'glow-canvas-field-x', type: 'text', placeholder: 'x column', class: 'btn btn-secondary' });
  const yInput = el('input', { 'data-testid': 'glow-canvas-field-y', type: 'text', placeholder: 'y column', class: 'btn btn-secondary' });
  const titleInput = el('input', { 'data-testid': 'glow-canvas-field-title', type: 'text', placeholder: 'title (optional)', class: 'btn btn-secondary' });
  form.appendChild(field('Table', tableInput));
  form.appendChild(field('Type', typeInput));
  form.appendChild(field('X', xInput));
  form.appendChild(field('Y', yInput));
  form.appendChild(field('Title', titleInput));
  form.appendChild(el('button', { type: 'submit', class: 'btn btn-primary', 'data-testid': 'glow-canvas-add-submit' }, 'Add'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = addCard(current, {
      table: (tableInput.value || '').trim(),
      chartType: typeInput.value,
      xCol: (xInput.value || '').trim(),
      yCol: (yInput.value || '').trim(),
      title: (titleInput.value || '').trim(),
    });
    emit(next);
  });
  function toggleAddForm() { form.style.display = form.style.display === 'none' ? 'flex' : 'none'; }
  host.appendChild(form);

  // ---- empty state ----
  if (current.cards.length === 0) {
    host.appendChild(el('div', {
      'data-testid': 'glow-canvas-empty',
      style: 'padding:var(--space-6,24px); text-align:center; color:var(--color-text-muted,#666);',
    }, 'No charts yet. Click "Add chart" to build your dashboard.'));
    return { layout: current };
  }

  // ---- the grid of cards ----
  const grid = el('div', {
    'data-testid': 'glow-canvas-grid',
    class: 'glow-canvas-grid',
    style: `display:grid; grid-template-columns:repeat(${GRID_COLUMNS}, 1fr); gap:var(--space-4,16px);`,
  });

  for (const card of current.cards) {
    const gp = card.gridPos || {};
    const col = (Number.isFinite(gp.col) ? gp.col : 0) + 1; // CSS grid is 1-based
    const row = (Number.isFinite(gp.row) ? gp.row : 0) + 1;
    const w = Number.isFinite(gp.w) && gp.w > 0 ? gp.w : DEFAULT_CARD_W;
    const h = Number.isFinite(gp.h) && gp.h > 0 ? gp.h : DEFAULT_CARD_H;
    const chartContainerId = `glow-canvas-chart-${card.id}`;

    // Cross-filter: this card is affected only when the active filter targets its
    // table. Filtered cards get a badge + border treatment so the user can see
    // which charts are reacting; the whereClause is passed to viz.renderChart.
    const whereClause = filterWhereClause(current, card);
    const isFiltered = whereClause !== '';

    const titleChildren = [
      el('div', {
        'data-testid': 'glow-canvas-card-title',
        style: 'font-weight:600; font-size:var(--text-sm,13px); color:var(--color-text,#111);',
      }, card.title || `${card.chartType} of ${card.table || '—'}`),
    ];
    if (isFiltered) {
      titleChildren.push(el('span', {
        'data-testid': 'glow-canvas-card-filtered',
        title: `Filtered by ${current.activeFilter.column} = ${current.activeFilter.value}`,
        style: 'margin-left:var(--space-2,8px); padding:1px 6px; font-size:var(--text-xs,12px); border-radius:999px; background:var(--color-accent,#0A7E8C); color:#fff;',
      }, 'Filtered'));
    }

    const header = el('div', {
      style: 'display:flex; align-items:center; justify-content:space-between; margin-bottom:var(--space-2,8px);',
    }, [
      el('div', { style: 'display:flex; align-items:center;' }, titleChildren),
      el('button', {
        type: 'button',
        class: 'btn btn-secondary',
        'data-testid': 'glow-canvas-card-remove',
        'data-card-id': String(card.id),
        title: 'Remove this chart',
        style: 'padding:2px 8px; font-size:var(--text-xs,12px);',
        onclick: () => emit(removeCard(current, card.id)),
      }, 'Remove'),
    ]);

    const chartBox = el('div', {
      id: chartContainerId,
      'data-testid': 'glow-canvas-card-chart',
      style: 'min-height:280px;',
    });

    const cardEl = el('div', {
      class: `card glow-canvas-card${isFiltered ? ' glow-canvas-card--filtered' : ''}`,
      'data-testid': 'glow-canvas-card',
      'data-card-id': String(card.id),
      'data-filtered': isFiltered ? 'true' : 'false',
      style: `grid-column:${col} / span ${w}; grid-row:${row} / span ${h}; padding:var(--space-4,16px);${isFiltered ? ' outline:2px solid var(--color-accent,#0A7E8C); outline-offset:-2px;' : ''}`,
    }, [header, chartBox]);
    grid.appendChild(cardEl);

    // Delegate the actual draw to the existing single-chart renderer, per card,
    // now passing the cross-filter whereClause ('' when this card is unaffected)
    // and the generic onPointClick so a click anywhere cross-filters the canvas.
    // A failure in one card must never abort the others or throw out of render.
    if (card.table && typeof renderChart === 'function') {
      Promise.resolve()
        .then(() => renderChart(chartContainerId, card.table, card.chartType, card.xCol, card.yCol, whereClause, { onPointClick }))
        .catch(() => {
          const node = document.getElementById(chartContainerId);
          if (node) node.textContent = 'Chart error.';
        });
    }
  }

  host.appendChild(grid);
  return { layout: current };
}
