// ============================================================
// Glow Canvas Tab (Batch 1 — ships dark behind the glowCanvas flag)
// ============================================================
// The multi-chart dashboard surface. This module owns the live layout state
// and its persistence (the IndexedDB canvasLayouts store); js/runtimes-viz/
// glow-canvas.js only holds the PURE layout algebra and the thin renderer,
// which delegates every actual chart draw to the existing viz.renderChart. The
// glowCanvas flag is checked HERE (the caller), never inside that module.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, 2026-09-25) — byte-for-byte identical
// behavior, only the file location changed.

import { state } from '../state.js';
import { isEnabled } from '../../build/build-flags.js';
import * as glowCanvas from '../../runtimes-viz/glow-canvas.js';
import * as memoryStore from '../../learning/memory-store.js';
// Step 6: reuse the existing pure API-feed + readiness-gate modules (no copies).
import { validateFeedUrl, normalizeApiResponse, buildPollSchedule, buildFeedDataset } from '../../ingestion/api-feed.js';

const GLOW_CANVAS_LAYOUT_NAME = 'default';
let glowCanvasLayout = glowCanvas.createCanvasLayout();
let glowCanvasLoaded = false;

// Batch 4 (Cleaning Crew bridge): a one-shot handoff, not persisted state. A
// caller (cleaning-crew-tab.js) sets this immediately before calling
// switchTab('glowcanvas'); renderGlowCanvasTab() reads it into the very next
// renderCanvas() call, then clears it so a later, unrelated activation of this
// tab never re-opens the add-form with a stale table.
let pendingPrefillTable = '';

/**
 * Request that the NEXT render of the Glow Canvas tab open with the "Add chart"
 * form pre-populated for `tableName`. Exported so other tabs (Cleaning Crew) can
 * hand off a just-loaded, just-gated table without importing any Glow-Canvas-
 * internal state directly — the same arm's-length pattern this app already uses
 * for cross-tab handoffs (e.g. join-builder-tab.js's switchTab callback).
 * @param {string} tableName
 */
export function requestGlowCanvasPrefill(tableName) {
  pendingPrefillTable = typeof tableName === 'string' ? tableName : '';
}

// Step 6: per-table refresh state + poll timers (owned here, never in the pure
// renderer). Timers exist only after a user explicitly picks an interval.
const refreshRegistry = glowCanvas.createRefreshRegistry();

// DuckDB is imported lazily so this module stays loadable in plain Node tests.
async function getEngine() {
  return import('../duckdb-engine.js');
}

function datasetForTable(table) {
  return (state.datasets || []).find((d) => d && d.table === table) || null;
}

// Re-run a single table's refresh. API-backed datasets (with a valid URL) are
// re-fetched, normalized via normalizeApiResponse and reloaded into DuckDB; a
// failure records an error on the registry and leaves the table (and so the
// chart) exactly as it was. Local tables are simply re-queried and redrawn.
// Because a reload changes the data, any earlier validation result is stale, so
// it is dropped and the card honestly shows "Unverified" until validation re-runs.
export async function refreshDatasetOnCanvas(table) {
  if (!table || !refreshRegistry.markRefreshing(table)) return;
  drawGlowCanvas();
  try {
    const ds = datasetForTable(table);
    const engine = await getEngine();
    if (ds && glowCanvas.isLiveFeedDataset(ds) && ds.meta && ds.meta.source) {
      const v = validateFeedUrl(ds.meta.source);
      if (!v.valid) throw new Error(v.error || 'Invalid feed URL');
      const res = await fetch(v.normalized);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const normalized = normalizeApiResponse(await res.json());
      if (!normalized.rows.length) throw new Error(normalized.warning || 'Feed returned no rows');
      const schedule = buildPollSchedule(refreshRegistry.get(table).pollIntervalMs, 'GET', v.normalized, {});
      const fed = buildFeedDataset(normalized.rows, v.normalized, schedule);
      await engine.createTableFromRows(table, fed.columns, fed.rows);
      ds.rowCount = await engine.getRowCount(table);
      ds.meta = fed.meta;
      delete ds.gateResult;
      delete ds.layerResults;
    } else if (ds) {
      ds.rowCount = await engine.getRowCount(table);
    }
    refreshRegistry.markSuccess(table);
  } catch (err) {
    refreshRegistry.markError(table, err);
  }
  drawGlowCanvas();
}

function refreshAllTables() {
  const tables = [...new Set(glowCanvasLayout.cards.map((c) => c.table).filter(Boolean))];
  tables.forEach((t) => { refreshDatasetOnCanvas(t); });
}

export async function connectApiFeedOnCanvas(rawName, rawUrl) {
  const table = String(rawName || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) {
    throw new Error("Enter a valid SQL table name (letters, numbers, underscores).");
  }
  const v = validateFeedUrl(rawUrl);
  if (!v.valid) throw new Error(v.error || "Invalid HTTPS feed URL");
  const res = await fetch(v.normalized);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const normalized = normalizeApiResponse(await res.json());
  if (!normalized.rows.length) throw new Error(normalized.warning || "Feed returned no rows");
  const schedule = buildPollSchedule(0, "GET", v.normalized, {});
  const fed = buildFeedDataset(normalized.rows, v.normalized, schedule);
  const engine = await getEngine();
  await engine.createTableFromRows(table, fed.columns, fed.rows);
  const rowCount = await engine.getRowCount(table);
  const cols = fed.columns.map((c) => ({ name: c, type: "VARCHAR" }));
  if (!Array.isArray(state.datasets)) state.datasets = [];
  const existing = datasetForTable(table);
  if (existing) {
    existing.rowCount = rowCount;
    existing.columns = cols;
    existing.meta = fed.meta;
    delete existing.gateResult;
    delete existing.layerResults;
  } else {
    state.datasets.push({ name: table, table, rowCount, columns: cols, meta: fed.meta });
  }
  refreshRegistry.markSuccess(table);
  pendingPrefillTable = table;
  drawGlowCanvas();
  return { table, rowCount };
}

function onPollChange(card, ms) {
  const table = card.table;
  refreshRegistry.setPollInterval(table, ms, () => {
    // Stop quietly if the tab is gone / flag was turned off.
    if (typeof document === 'undefined' || !document.getElementById('glow-canvas-body') || !isEnabled('glowCanvasLiveRefresh')) {
      refreshRegistry.stopAllRefreshTimers();
      return;
    }
    refreshDatasetOnCanvas(table);
  });
  drawGlowCanvas();
}

// Step 9: the callout number always comes from a real DuckDB SQL query built by
// buildCalloutSQL (identifiers quoted, cross-filter WHERE applied) — never AI.
async function computeCallout(card, whereClause) {
  const sql = glowCanvas.buildCalloutSQL(card.table, card.story, whereClause);
  if (!sql) return { value: null, formatted: glowCanvas.formatCalloutValue(null), validCount: 0 };
  const engine = await getEngine();
  const { rows } = await engine.runQuery(sql);
  const raw = rows && rows[0] ? Number(rows[0].value) : NaN;
  const value = Number.isFinite(raw) ? raw : null;
  const validCount = rows && rows[0] ? Number(rows[0].valid_count) || 0 : 0;
  return { value, formatted: glowCanvas.formatCalloutValue(value), validCount };
}

async function persistGlowCanvasLayout() {
  try {
    await memoryStore.saveCanvasLayout(GLOW_CANVAS_LAYOUT_NAME, glowCanvas.serializeLayout(glowCanvasLayout));
  } catch (_e) { /* persistence is best-effort — a save failure must never break the canvas */ }
}

function drawGlowCanvas() {
  const prefillTable = pendingPrefillTable;
  pendingPrefillTable = ''; // one-shot: consumed by this render, cleared for the next
  const enableLiveRefresh = isEnabled('glowCanvasLiveRefresh');
  const enableStorytelling = isEnabled('glowCanvasStorytelling');
  // With both new flags off, the options are exactly what they were before.
  const opts = {
    datasets: state.datasets || [],
    prefillTable,
    onChange: (next) => {
      glowCanvasLayout = next;
      persistGlowCanvasLayout();
      if (enableLiveRefresh) refreshRegistry.pruneTables(next.cards.map((c) => c.table));
      drawGlowCanvas();
    },
  };
  if (enableLiveRefresh) {
    // Attach the latest validation evidence (if any) so the readiness pill is
    // honest; tables without evidence stay "Unverified".
    opts.datasets = (state.datasets || []).map((ds) => {
      const lr = state.lastLayerResults && ds && state.lastLayerResults[ds.table];
      return lr && !ds.layerResults && !ds.gateResult ? Object.assign({}, ds, { layerResults: lr }) : ds;
    });
    opts.enableLiveRefresh = true;
    opts.refreshRegistry = refreshRegistry;
    opts.onRefreshCard = (card) => refreshDatasetOnCanvas(card.table);
    opts.onRefreshAll = refreshAllTables;
    opts.onPollChange = onPollChange;
    opts.onConnectApiFeed = connectApiFeedOnCanvas;
  }
  if (enableStorytelling) {
    opts.enableStorytelling = true;
    opts.computeCallout = computeCallout;
  }
  glowCanvas.renderCanvas('glow-canvas-body', glowCanvasLayout, opts);
}

export async function renderGlowCanvasTab() {
  const host = document.getElementById('glow-canvas-body');
  if (!host) return;
  if (!isEnabled('glowCanvas')) { refreshRegistry.stopAllRefreshTimers(); host.innerHTML = ''; glowCanvasLoaded = false; return; }
  if (!isEnabled('glowCanvasLiveRefresh')) refreshRegistry.stopAllRefreshTimers();
  // Load the saved layout once per session, then draw. Subsequent activations
  // just redraw the in-memory layout (kept in sync by onChange above).
  if (!glowCanvasLoaded) {
    glowCanvasLoaded = true;
    try {
      const saved = await memoryStore.getCanvasLayout(GLOW_CANVAS_LAYOUT_NAME);
      if (saved && saved.layoutJson) glowCanvasLayout = glowCanvas.deserializeLayout(saved.layoutJson);
    } catch (_e) { /* no saved layout / store unavailable — start from the empty layout */ }
  }
  drawGlowCanvas();
}
