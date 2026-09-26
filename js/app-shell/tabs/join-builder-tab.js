// ============================================================
// Join Builder Tab (Phase 8 -- ships dark behind the joinBuilder flag)
// ============================================================
// Visual multi-table join builder. Gated by ONE flag (joinBuilder, off by
// default). The join-model and join-sql modules are pure and have no DOM
// dependency; join-canvas.js is the browser-side renderer. All graph state
// lives HERE (in joinGraph) so the graph survives tab switches and re-renders.
// The canvas is destroyed and rebuilt on every tab activation so it always
// reflects the latest graph.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, 2026-09-26) -- byte-for-byte identical
// behavior, only the file location changed. renderJoinBuilderTab now takes a
// `switchTab` callback since the real tab-switch dispatcher stays in main.js
// (extracting it would create a circular import); every other dependency was
// already a normal module import.

import { state } from '../state.js';
import { isEnabled } from '../../build/build-flags.js';
import { createJoinGraph } from '../../join-builder/join-model.js';
import { renderJoinCanvas, buildJoinToolbar } from '../../join-builder/join-canvas.js';

let joinGraph = createJoinGraph();
let joinBuilderLoaded = false;

export function renderJoinBuilderTab(switchTab) {
  const host = document.getElementById('join-builder-body');
  if (!host) return;
  if (!isEnabled('joinBuilder')) { host.innerHTML = ''; joinBuilderLoaded = false; return; }

  // Build a map of loaded tables -> ColDef[] from the global dataset state.
  // DataGlow stores loaded schemas in the global `state.datasets` array.
  const datasets = (window.__dataglow_datasets || state.datasets || []);
  const availableTables = datasets.map(d => d.name || d.tableName).filter(Boolean);
  const tableColsMap = {};
  for (const d of datasets) {
    const name = d.name || d.tableName;
    if (name) tableColsMap[name] = (d.columns || d.cols || []).map(c =>
      typeof c === 'string' ? { name: c, type: '' } : { name: c.name || c.col || '', type: c.type || '' }
    );
  }

  // Stable onGraphChange callback — updates joinGraph and re-renders.
  function onGraphChange(newGraph) {
    joinGraph = newGraph;
    renderJoinBuilderTab(switchTab);
  }

  // When the user clicks Run, push the SQL into the SQL tab and switch to it.
  function onRunSQL(sql) {
    const sqlEditor = document.getElementById('sql-editor');
    if (sqlEditor) sqlEditor.value = sql;
    switchTab('sql');
    // Trigger a run if the run-sql button is present.
    const runBtn = document.getElementById('btn-run-sql') || document.querySelector('[data-testid="btn-run-sql"]');
    if (runBtn) runBtn.click();
  }

  host.innerHTML = '';

  // Toolbar (add-table selector, run/clear buttons)
  const toolbar = buildJoinToolbar({
    graph: joinGraph,
    availableTables,
    tableColsMap,
    onGraphChange,
    onRunSQL,
  });
  host.appendChild(toolbar);

  // Instruction hint when canvas is empty
  if (joinGraph.cards.length === 0) {
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:32px; color:var(--color-text-muted); font-size:14px; text-align:center;';
    hint.innerHTML = 'Select a table from the dropdown above to add it to the canvas.<br><br>' +
      'Click a column connector dot, then click a column on another table to draw a join line.<br>' +
      'Click any join line to change the join type (INNER / LEFT / RIGHT / FULL).';
    host.appendChild(hint);
    joinBuilderLoaded = true;
    return;
  }

  // Canvas container
  const canvasHost = document.createElement('div');
  canvasHost.style.cssText = 'height:560px; overflow:auto; border:1px solid var(--color-border); border-radius:8px; background:var(--color-surface-alt);';
  host.appendChild(canvasHost);

  // SQL preview panel
  const sqlPre = document.createElement('pre');
  sqlPre.setAttribute('data-testid', 'join-builder-sql-preview');
  sqlPre.style.cssText = 'margin-top:12px; padding:12px; background:var(--color-surface); border:1px solid var(--color-border); border-radius:6px; font-size:12px; overflow-x:auto; white-space:pre-wrap; color:var(--color-text);';
  host.appendChild(sqlPre);

  renderJoinCanvas({
    host: canvasHost,
    graph: joinGraph,
    onGraphChange,
    onSQLChange: ({ sql, warnings }) => {
      sqlPre.textContent = sql || (warnings.length ? warnings.join('\n') : '');
    },
    onRunSQL,
  });

  joinBuilderLoaded = true;
}
