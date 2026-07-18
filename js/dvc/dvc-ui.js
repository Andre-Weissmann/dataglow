// ============================================================
// DataGlow Phase 10 — Data Version Control: UI
// ============================================================
// Mounts the DVC tab UI into a host element.
//
// Layout:
//   [ Dataset selector ]  [ + Snapshot now ] [ Export ] [ Import ]
//   ┌────────────────────────────────────────────────────┐
//   │  Timeline — newest first                           │
//   │  ┌─────────────────────────────────────────────┐  │
//   │  │ [fingerprint] "Before dedup" 3:42 PM        │  │
//   │  │  50,000 rows  |  18 cols  [Diff ↕] [Info]  │  │
//   │  └─────────────────────────────────────────────┘  │
//   │  ┌─────────────────────────────────────────────┐  │
//   │  │ [fingerprint] "After dedup"  3:55 PM  CURR  │  │
//   │  │  48,231 rows  |  18 cols  [Diff ↕] [Info]  │  │
//   │  └─────────────────────────────────────────────┘  │
//   └────────────────────────────────────────────────────┘
//   ┌────────────────────────────────────────────────────┐
//   │  Diff panel (when two snapshots selected)          │
//   └────────────────────────────────────────────────────┘
//
// API:
//   mountDVCUI({ host, datasets, getActiveDataset, onSnapshot, onRollback, onToast })
// ============================================================

import { dvcStore, statsFromDataset } from './dvc-store.js';
import { diffSnapshots, diffToHTML, RISK } from './dvc-diff.js';

const STYLES = `
<style>
.dvc-root { display: flex; flex-direction: column; gap: 14px; padding: 16px 0; font-family: inherit; }
.dvc-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dvc-toolbar select { flex: 1; min-width: 160px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border, #D4D1CA); background: var(--bg, #fff); color: var(--text, #28251D); font-size: 13px; }
.dvc-btn { padding: 6px 14px; border-radius: 6px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; transition: opacity 0.15s; }
.dvc-btn:hover { opacity: 0.8; }
.dvc-btn-primary { background: var(--primary, #01696F); color: #fff; }
.dvc-btn-secondary { background: var(--surface-alt, #f0efec); color: var(--text, #28251D); border: 1px solid var(--border, #D4D1CA); }
.dvc-btn-danger { background: #A12C7B; color: #fff; }
.dvc-empty { color: var(--text-muted, #7A7974); font-size: 13px; padding: 24px 0; text-align: center; }
.dvc-timeline { display: flex; flex-direction: column; gap: 8px; }
.dvc-snap-card { border: 1px solid var(--border, #D4D1CA); border-radius: 8px; padding: 12px 14px; background: var(--surface, #F9F8F5); transition: border-color 0.15s; }
.dvc-snap-card.dvc-selected { border-color: var(--primary, #01696F); background: var(--surface-alt, #f0efec); }
.dvc-snap-card.dvc-diff-a { border-color: #006494; }
.dvc-snap-card.dvc-diff-b { border-color: #A84B2F; }
.dvc-snap-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dvc-fingerprint { font-family: monospace; font-size: 11px; color: var(--text-faint, #BAB9B4); background: var(--surface-alt, #eee); padding: 2px 6px; border-radius: 4px; }
.dvc-label { font-weight: 600; font-size: 13px; color: var(--text, #28251D); flex: 1; }
.dvc-label-input { font-weight: 600; font-size: 13px; flex: 1; border: 1px solid var(--primary, #01696F); border-radius: 4px; padding: 2px 6px; background: var(--bg, #fff); color: var(--text, #28251D); }
.dvc-time { font-size: 11px; color: var(--text-muted, #7A7974); }
.dvc-badge { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
.dvc-badge-ok { background: #d4edda; color: #437A22; }
.dvc-badge-warn { background: #fff3cd; color: #964219; }
.dvc-badge-breaking { background: #f8d7da; color: #A12C7B; }
.dvc-snap-meta { display: flex; align-items: center; gap: 14px; margin-top: 8px; font-size: 12px; color: var(--text-muted, #7A7974); }
.dvc-snap-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.dvc-diff-panel { border: 1px solid var(--border, #D4D1CA); border-radius: 8px; padding: 14px 16px; background: var(--surface, #F9F8F5); }
.dvc-diff-panel h3 { font-size: 13px; font-weight: 600; margin: 0 0 10px; }
.dvc-diff-actions { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.dvc-diff-report { font-size: 13px; }
.dvc-diff-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.dvc-risk-badge { color: #fff; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 4px; }
.dvc-diff-title { font-weight: 600; }
.dvc-diff-rows { color: var(--text-muted, #7A7974); margin-bottom: 8px; }
.dvc-arrow { color: var(--text-faint, #BAB9B4); }
.dvc-schema-changes { border-left: 3px solid var(--border, #D4D1CA); padding: 6px 10px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 4px; }
.dvc-change { font-size: 12px; font-family: monospace; }
.dvc-added { color: #437A22; }
.dvc-removed { color: #A12C7B; }
.dvc-type-changed { color: #964219; }
.dvc-type { opacity: 0.7; }
.dvc-stat-flags { display: flex; flex-direction: column; gap: 6px; }
.dvc-col-flag { border-left: 3px solid var(--border, #D4D1CA); padding: 6px 10px; border-radius: 0 4px 4px 0; }
.dvc-risk-ok { border-left-color: #437A22; }
.dvc-risk-warn { border-left-color: #964219; }
.dvc-risk-breaking { border-left-color: #A12C7B; }
.dvc-col-name { font-weight: 600; font-size: 12px; display: block; margin-bottom: 2px; }
.dvc-flag-msg { font-size: 12px; color: var(--text-muted, #7A7974); }
.dvc-ok { color: #437A22; font-size: 13px; }
.dvc-col-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
.dvc-col-table th { text-align: left; padding: 4px 8px; border-bottom: 2px solid var(--border, #D4D1CA); color: var(--text-muted, #7A7974); font-weight: 600; }
.dvc-col-table td { padding: 4px 8px; border-bottom: 1px solid var(--border, #D4D1CA); }
.dvc-delta-pos { color: #437A22; }
.dvc-delta-neg { color: #A12C7B; }
.dvc-delta-zero { color: var(--text-faint, #BAB9B4); }
.dvc-info-panel { border: 1px solid var(--border, #D4D1CA); border-radius: 8px; padding: 14px 16px; background: var(--surface, #F9F8F5); }
.dvc-info-panel h3 { font-size: 13px; font-weight: 600; margin: 0 0 10px; }
</style>
`;

// ============================================================
// Helpers
// ============================================================
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fmtTime(iso) {
  try { return new Date(iso).toLocaleString(); }
  catch (_) { return iso; }
}
function fmtNum(n) { return (n == null ? 'N/A' : Number(n).toLocaleString()); }
function deltaClass(v) { return v > 0 ? 'dvc-delta-pos' : v < 0 ? 'dvc-delta-neg' : 'dvc-delta-zero'; }
function deltaStr(v) { if (v == null) return '—'; return (v > 0 ? '+' : '') + v.toLocaleString(); }
function riskBadge(r) {
  const cls = { ok: 'dvc-badge-ok', warn: 'dvc-badge-warn', breaking: 'dvc-badge-breaking' }[r] || '';
  const lbl = { ok: 'Clean', warn: 'Warn', breaking: 'Breaking' }[r] || r;
  return '<span class="dvc-badge ' + cls + '">' + lbl + '</span>';
}

// ============================================================
// mountDVCUI
// ============================================================

/**
 * Mount the DVC tab into a host element.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.host         - container element
 * @param {Object[]}   opts.datasets      - state.datasets array
 * @param {Function}   [opts.getActiveDataset] - () => dataset object (for snapshot-now)
 * @param {Function}   [opts.onSnapshot]  - called after a snapshot is created (id) => void
 * @param {Function}   [opts.onRollback]  - called when user clicks Rollback (snapMeta) => void
 * @param {Function}   [opts.onToast]     - (msg, type) => void
 */
export function mountDVCUI({ host, datasets = [], getActiveDataset, onSnapshot, onRollback, onToast }) {
  if (!host) return;

  // Inject styles once
  if (!document.getElementById('dvc-styles')) {
    const styleEl = document.createElement('div');
    styleEl.id = 'dvc-styles';
    styleEl.innerHTML = STYLES;
    document.head.appendChild(styleEl.firstElementChild);
  }

  // State
  let selectedDataset = '';
  let diffSnapA = null; // id
  let diffSnapB = null; // id
  let inspectId = null; // id — info panel
  let editingLabelId = null;

  function toast(msg, type = 'info') {
    if (onToast) onToast(msg, type);
  }

  // ---- Render ----
  function render() {
    const snaps = dvcStore.list(selectedDataset || undefined);

    const datasetOptions = (datasets.length > 0
      ? ['<option value="">All datasets</option>',
         ...datasets.map(d => {
           const n = d.name || d.tableName || '';
           return '<option value="' + esc(n) + '"' + (selectedDataset === n ? ' selected' : '') + '>' + esc(n) + '</option>';
         })]
      : ['<option value="">No datasets loaded</option>']).join('');

    const snapCount = snaps.length;

    const timelineHTML = snapCount === 0
      ? '<div class="dvc-empty">No snapshots yet. Load a dataset and click <strong>Snapshot now</strong>.</div>'
      : snaps.map(snap => renderSnapCard(snap)).join('');

    let diffPanelHTML = '';
    if (diffSnapA && diffSnapB) {
      const a = dvcStore.get(diffSnapA);
      const b = dvcStore.get(diffSnapB);
      if (a && b) {
        const diff = diffSnapshots(a, b);
        diffPanelHTML = renderDiffPanel(diff);
      }
    }

    let infoPanelHTML = '';
    if (inspectId) {
      const snap = dvcStore.get(inspectId);
      if (snap) infoPanelHTML = renderInfoPanel(snap);
    }

    host.innerHTML = [
      '<div class="dvc-root" data-testid="dvc-root">',
      '  <div class="dvc-toolbar" data-testid="dvc-toolbar">',
      '    <select data-testid="dvc-dataset-select" id="dvc-dataset-select">' + datasetOptions + '</select>',
      '    <button class="dvc-btn dvc-btn-primary" data-testid="dvc-snapshot-btn" id="dvc-snapshot-btn">+ Snapshot now</button>',
      '    <button class="dvc-btn dvc-btn-secondary" data-testid="dvc-export-btn" id="dvc-export-btn">Export</button>',
      '    <button class="dvc-btn dvc-btn-secondary" data-testid="dvc-import-btn" id="dvc-import-btn">Import</button>',
      '    <input type="file" id="dvc-import-file" accept=".json" style="display:none" data-testid="dvc-import-file">',
      '  </div>',
      snapCount > 0
        ? '  <div class="dvc-help" style="font-size:12px;color:var(--text-muted,#7A7974)">Click <strong>Diff A</strong> on one snapshot and <strong>Diff B</strong> on another to compare them.</div>'
        : '',
      '  <div class="dvc-timeline" data-testid="dvc-timeline" id="dvc-timeline">',
      timelineHTML,
      '  </div>',
      diffPanelHTML,
      infoPanelHTML,
      '</div>',
    ].join('\n');

    attachHandlers();
  }

  function renderSnapCard(snap) {
    const isA = snap.id === diffSnapA;
    const isB = snap.id === diffSnapB;
    const cls = isA ? ' dvc-diff-a' : isB ? ' dvc-diff-b' : '';
    const isEditing = snap.id === editingLabelId;
    const labelHTML = isEditing
      ? '<input class="dvc-label-input" data-testid="dvc-label-input-' + snap.id + '" id="dvc-label-input" value="' + esc(snap.label) + '">'
      : '<span class="dvc-label">' + esc(snap.label) + '</span>';

    return [
      '<div class="dvc-snap-card' + cls + '" data-snap-id="' + esc(snap.id) + '" data-testid="snap-card-' + esc(snap.id) + '">',
      '  <div class="dvc-snap-top">',
      '    <span class="dvc-fingerprint" title="Content fingerprint">' + esc(snap.fingerprint) + '</span>',
      labelHTML,
      '    <span class="dvc-time">' + esc(fmtTime(snap.createdAt)) + '</span>',
      isA ? '<span class="dvc-badge" style="background:#006494;color:#fff">A</span>' : '',
      isB ? '<span class="dvc-badge" style="background:#A84B2F;color:#fff">B</span>' : '',
      '  </div>',
      '  <div class="dvc-snap-meta">',
      '    <span>' + fmtNum(snap.rowCount) + ' rows</span>',
      '    <span>' + snap.cols.length + ' cols</span>',
      '    <span>' + esc(snap.datasetName) + '</span>',
      '  </div>',
      '  <div class="dvc-snap-actions">',
      '    <button class="dvc-btn dvc-btn-secondary" data-action="diff-a" data-snap-id="' + esc(snap.id) + '" data-testid="diff-a-' + esc(snap.id) + '"' + (isA ? ' style="border-color:#006494"' : '') + '>Diff A</button>',
      '    <button class="dvc-btn dvc-btn-secondary" data-action="diff-b" data-snap-id="' + esc(snap.id) + '" data-testid="diff-b-' + esc(snap.id) + '"' + (isB ? ' style="border-color:#A84B2F"' : '') + '>Diff B</button>',
      '    <button class="dvc-btn dvc-btn-secondary" data-action="inspect" data-snap-id="' + esc(snap.id) + '" data-testid="inspect-' + esc(snap.id) + '">Info</button>',
      '    <button class="dvc-btn dvc-btn-secondary" data-action="rename" data-snap-id="' + esc(snap.id) + '" data-testid="rename-' + esc(snap.id) + '">' + (isEditing ? 'Save' : 'Rename') + '</button>',
      '    <button class="dvc-btn dvc-btn-secondary" data-action="rollback" data-snap-id="' + esc(snap.id) + '" data-testid="rollback-' + esc(snap.id) + '">Rollback</button>',
      '    <button class="dvc-btn dvc-btn-danger" data-action="delete" data-snap-id="' + esc(snap.id) + '" data-testid="delete-' + esc(snap.id) + '">Delete</button>',
      '  </div>',
      '</div>',
    ].join('\n');
  }

  function renderDiffPanel(diff) {
    const colTableRows = diff.colDiffs.map(cd => {
      const nd = Math.round(cd.nullRateDelta * 1000) / 10;
      const ndStr = (nd > 0 ? '+' : '') + nd + '%';
      const ndClass = deltaClass(cd.nullRateDelta);
      const dd = cd.distinctDelta;
      const mdStr = cd.meanDelta !== null ? deltaStr(cd.meanDelta) : '—';
      return '<tr>' +
        '<td>' + esc(cd.name) + '</td>' +
        '<td>' + esc(cd.type) + '</td>' +
        '<td class="' + ndClass + '">' + ndStr + '</td>' +
        '<td class="' + deltaClass(dd) + '">' + deltaStr(dd) + '</td>' +
        '<td class="' + deltaClass(cd.meanDelta) + '">' + mdStr + '</td>' +
        '<td>' + riskBadge(cd.risk) + '</td>' +
        '</tr>';
    }).join('');

    return [
      '<div class="dvc-diff-panel" data-testid="dvc-diff-panel">',
      '  <h3>Diff: <span style="color:#006494">A</span> vs <span style="color:#A84B2F">B</span></h3>',
      '  <div class="dvc-diff-actions">',
      '    <button class="dvc-btn dvc-btn-secondary" id="dvc-clear-diff" data-testid="dvc-clear-diff">Clear diff</button>',
      '  </div>',
      diffToHTML(diff),
      diff.colDiffs.length > 0 ? [
        '  <table class="dvc-col-table" data-testid="dvc-col-table">',
        '    <thead><tr><th>Column</th><th>Type</th><th>Null rate Δ</th><th>Distinct Δ</th><th>Mean Δ</th><th>Risk</th></tr></thead>',
        '    <tbody>' + colTableRows + '</tbody>',
        '  </table>',
      ].join('\n') : '',
      '</div>',
    ].join('\n');
  }

  function renderInfoPanel(snap) {
    const colRows = snap.cols.map(c => {
      const nullPct = snap.rowCount > 0 ? Math.round(c.nullCount / snap.rowCount * 1000) / 10 + '%' : '—';
      return '<tr>' +
        '<td>' + esc(c.name) + '</td>' +
        '<td>' + esc(c.rawType) + '</td>' +
        '<td>' + nullPct + '</td>' +
        '<td>' + fmtNum(c.distinctCount) + '</td>' +
        '<td>' + fmtNum(c.min) + '</td>' +
        '<td>' + fmtNum(c.max) + '</td>' +
        '<td>' + fmtNum(c.mean) + '</td>' +
        '</tr>';
    }).join('');

    return [
      '<div class="dvc-info-panel" data-testid="dvc-info-panel">',
      '  <h3>Snapshot info: ' + esc(snap.label) + '</h3>',
      '  <div style="font-size:12px;color:var(--text-muted,#7A7974);margin-bottom:10px">',
      '    ID: ' + esc(snap.id) + ' &middot; ' + fmtTime(snap.createdAt) + ' &middot; fingerprint: ' + esc(snap.fingerprint),
      '  </div>',
      '  <table class="dvc-col-table" data-testid="dvc-info-col-table">',
      '    <thead><tr><th>Column</th><th>Type</th><th>Null %</th><th>Distinct</th><th>Min</th><th>Max</th><th>Mean</th></tr></thead>',
      '    <tbody>' + colRows + '</tbody>',
      '  </table>',
      '  <div style="margin-top:8px"><button class="dvc-btn dvc-btn-secondary" id="dvc-close-info" data-testid="dvc-close-info">Close</button></div>',
      '</div>',
    ].join('\n');
  }

  // ---- Event handlers ----
  function attachHandlers() {
    // Dataset selector
    const sel = document.getElementById('dvc-dataset-select');
    if (sel) sel.addEventListener('change', () => { selectedDataset = sel.value; render(); });

    // Snapshot now
    const snapBtn = document.getElementById('dvc-snapshot-btn');
    if (snapBtn) snapBtn.addEventListener('click', () => {
      const ds = getActiveDataset ? getActiveDataset() : null;
      if (!ds) { toast('No active dataset to snapshot', 'warn'); return; }
      const label = 'Snapshot ' + new Date().toLocaleTimeString();
      const id = dvcStore.snapshot(ds, { label });
      selectedDataset = ds.name || ds.tableName || '';
      toast('Snapshot created: ' + label, 'success');
      if (onSnapshot) onSnapshot(id);
      render();
    });

    // Export
    const exportBtn = document.getElementById('dvc-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', () => {
      const json = dvcStore.exportJSON();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'dataglow-snapshots.json';
      a.click();
      URL.revokeObjectURL(url);
      toast('Snapshots exported', 'success');
    });

    // Import
    const importBtn = document.getElementById('dvc-import-btn');
    const importFile = document.getElementById('dvc-import-file');
    if (importBtn && importFile) {
      importBtn.addEventListener('click', () => importFile.click());
      importFile.addEventListener('change', () => {
        const file = importFile.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
          try {
            const { DVCStore } = { DVCStore: dvcStore.constructor };
            const imported = DVCStore.fromJSON(e.target.result);
            dvcStore.merge(imported);
            toast('Snapshots imported', 'success');
            render();
          } catch (err) {
            toast('Import failed: ' + err.message, 'error');
          }
        };
        reader.readAsText(file);
      });
    }

    // Card action buttons (delegated)
    const timeline = document.getElementById('dvc-timeline');
    if (timeline) {
      timeline.addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const snapId = btn.dataset.snapId;

        if (action === 'diff-a') {
          diffSnapA = snapId;
          if (diffSnapA === diffSnapB) diffSnapB = null;
          render();
        } else if (action === 'diff-b') {
          diffSnapB = snapId;
          if (diffSnapB === diffSnapA) diffSnapA = null;
          render();
        } else if (action === 'inspect') {
          inspectId = inspectId === snapId ? null : snapId;
          render();
        } else if (action === 'rename') {
          if (editingLabelId === snapId) {
            // Save
            const input = document.getElementById('dvc-label-input');
            if (input) { dvcStore.relabel(snapId, input.value.trim() || 'Snapshot'); }
            editingLabelId = null;
          } else {
            editingLabelId = snapId;
          }
          render();
        } else if (action === 'rollback') {
          const meta = dvcStore.rollbackMeta(snapId);
          if (meta && onRollback) {
            onRollback(meta);
            toast('Rollback info for "' + meta.label + '" passed to DataGlow', 'info');
          } else {
            toast('No rollback handler registered', 'warn');
          }
        } else if (action === 'delete') {
          const snap = dvcStore.get(snapId);
          if (!snap) return;
          dvcStore.remove(snapId);
          if (diffSnapA === snapId) diffSnapA = null;
          if (diffSnapB === snapId) diffSnapB = null;
          if (inspectId === snapId) inspectId = null;
          toast('Snapshot deleted', 'info');
          render();
        }
      });
    }

    // Clear diff
    const clearDiff = document.getElementById('dvc-clear-diff');
    if (clearDiff) clearDiff.addEventListener('click', () => { diffSnapA = null; diffSnapB = null; render(); });

    // Close info
    const closeInfo = document.getElementById('dvc-close-info');
    if (closeInfo) closeInfo.addEventListener('click', () => { inspectId = null; render(); });
  }

  // Initial render
  render();

  // Return refresh handle so main.js can re-mount when datasets change
  return { refresh: render };
}
