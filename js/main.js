// ============================================================
// DATAGLOW — Main Application Controller
// ============================================================

import { state, getActiveDataset, addDataset, setActiveDataset } from './state.js';
import { $, $$, el, toast, formatNumber, escapeHtml, timeAgo, debounce } from './utils.js';
import * as engine from './duckdb-engine.js';
import * as loaders from './loaders.js';
import * as validation from './validation.js';
import * as viz from './visualize.js';
import * as story from './story.js';
import * as clean from './clean.js';
import * as formatFingerprint from './format-fingerprint.js';
import * as missingness from './missingness.js';
import * as imputation from './imputation.js';
import * as fuzzyDedup from './fuzzy-dedup.js';
import * as ruleSuggestions from './rule-suggestions.js';
import * as fixConfidence from './fix-confidence.js';
import * as activeLearning from './active-learning.js';
import * as ondeviceML from './ondevice-ml.js';
import { scoreIsolationForest } from './isolation-forest.js';
import * as spc from './spc-control.js';
import * as catScorecard from './cat-scorecard.js';
import * as materiality from './materiality.js';
import * as goldenSignals from './golden-signals.js';
import * as entityBaseline from './entity-baseline.js';
import * as privacyBudget from './privacy-budget.js';
import * as memoryStore from './memory-store.js';
import * as ledger from './assumption-ledger.js';
import * as provenance from './provenance.js';
import * as sdProof from './selective-disclosure-proof.js';
import * as domainPhysics from './domain-physics.js';
import * as devilsAdvocate from './devils-advocate.js';
import * as syntheticAdversarial from './synthetic-adversarial.js';
import * as pyRuntime from './python-runtime.js';
import * as rRuntime from './r-runtime.js';
import * as swiftPreview from './swift-preview.js';
import * as receipt from './validation-receipt.js';
import * as peerReview from './peer-review.js';
import * as timeTravel from './time-travel-diff.js';
import * as syntheticTwin from './synthetic-twin.js';
import * as timeMachine from './time-machine.js';
import * as fingerprint from './federated-fingerprint.js';
import * as irbMode from './irb-mode.js';
import * as ondeviceLLM from './ondevice-llm.js';
import * as digitalTwin from './digital-twin.js';
import * as watchFolder from './watch-folder.js';
import { withCanonical } from './categorical-consistency.js';

// ============================================================
// Tab Definitions
// ============================================================
const TAB_META = {
  preflight: { label: 'Preflight', icon: 'check-circle' },
  sql: { label: 'SQL', icon: 'database' },
  python: { label: 'Python', icon: 'code' },
  r: { label: 'R', icon: 'bar-chart-2' },
  clean: { label: 'Clean', icon: 'sparkles' },
  validate: { label: 'Validate', icon: 'shield' },
  diff: { label: 'Diff', icon: 'git-compare' },
  visualize: { label: 'Visualize', icon: 'pie-chart' },
  story: { label: 'Story', icon: 'book-open' },
  swift: { label: 'Swift', icon: 'smartphone' },
  twin: { label: 'Digital Twin', icon: 'sliders' },
  watch: { label: 'Watch Folder', icon: 'folder' },
};

const ICONS = {
  'check-circle': '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  'bar-chart-2': '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  sparkles: '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M5 3v4M3 5h4M19 17v4M17 19h4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  'pie-chart': '<path d="M21.21 15.89A10 10 0 118 2.83"/><path d="M22 12A10 10 0 0012 2v10z"/>',
  'book-open': '<path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>',
  smartphone: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/>',
  'git-compare': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><path d="M11 18H8a2 2 0 01-2-2V9"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  folder: '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>',
};

function iconSvg(name, size = 15) {
  return `<svg class="tab-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ICONS[name] || ''}</svg>`;
}

// ============================================================
// Theme
// ============================================================
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('#btn-theme-toggle');
  btn.innerHTML = theme === 'dark'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  $('#theme-chip-light').classList.toggle('active', theme === 'light');
  $('#theme-chip-dark').classList.toggle('active', theme === 'dark');
}

function initTheme() {
  const preferred = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(preferred);
  $('#btn-theme-toggle').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
  $('#theme-chip-light').addEventListener('click', () => applyTheme('light'));
  $('#theme-chip-dark').addEventListener('click', () => applyTheme('dark'));
}

// ============================================================
// Tab Bar (draggable + reorderable)
// ============================================================
let activeTab = 'preflight';

function renderTabBar() {
  const bar = $('#tabbar');
  bar.innerHTML = '';
  state.tabOrder.forEach((tabId, idx) => {
    const meta = TAB_META[tabId];
    const tabEl = el('div', {
      class: `tab ${tabId === activeTab ? 'active' : ''}`,
      draggable: 'true',
      'data-tab': tabId,
      'data-testid': `tab-${tabId}`,
      onclick: () => switchTab(tabId),
    }, [
      el('span', { html: iconSvg(meta.icon) }),
      el('span', {}, meta.label),
    ]);
    tabEl.addEventListener('dragstart', (e) => { tabEl.classList.add('dragging'); e.dataTransfer.setData('text/plain', idx); });
    tabEl.addEventListener('dragend', () => tabEl.classList.remove('dragging'));
    tabEl.addEventListener('dragover', (e) => e.preventDefault());
    tabEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const toIdx = idx;
      if (fromIdx === toIdx) return;
      const arr = [...state.tabOrder];
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      state.tabOrder = arr;
      renderTabBar();
    });
    bar.appendChild(tabEl);
  });
}

function switchTab(tabId) {
  const previousTab = activeTab;
  activeTab = tabId;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tabId));
  // Leaving the SQL tab: terminate the ambient-validation worker so it never
  // lingers in the background (recreated lazily on the next keystroke).
  if (previousTab === 'sql' && tabId !== 'sql') teardownAmbientWorker();
  if (tabId === 'python') ensurePythonRuntime();
  if (tabId === 'r') ensureRRuntime();
  if (tabId === 'twin') buildTwinControls();
  if (tabId === 'swift' && !$('#swift-input').value) {
    $('#swift-input').value = swiftPreview.SWIFT_TEMPLATE;
    $('#swift-note').textContent = 'Structural SwiftUI-syntax preview — renders Text/VStack/HStack/Button/Divider live in the browser. Full SwiftWasm compilation is planned for a future Gen.';
  }
}

// ============================================================
// Dataset Sidebar
// ============================================================
function renderSidebar() {
  const list = $('#dataset-list');
  const tableList = $('#table-list');
  if (state.datasets.length === 0) {
    list.innerHTML = '<div style="font-size:var(--text-xs); color:var(--color-text-faint);">No datasets loaded yet</div>';
    tableList.innerHTML = 'No tables yet';
  } else {
    list.innerHTML = '';
    state.datasets.forEach(ds => {
      const item = el('div', { class: `dataset-item ${ds.name === state.activeDataset ? 'active' : ''}`, onclick: () => { state.activeDataset = ds.name; renderSidebar(); refreshFreshnessBadge(); } }, [
        el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', html: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>' }),
        el('span', { style: 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;' }, ds.name),
      ]);
      list.appendChild(item);
    });
    tableList.innerHTML = state.datasets.map(ds => `<div class="mono" style="padding:4px 0;">${escapeHtml(ds.table)} <span style="color:var(--color-text-faint);">(${ds.rowCount.toLocaleString()})</span></div>`).join('');
  }
  refreshFreshnessBadge();
}

function refreshFreshnessBadge() {
  const ds = getActiveDataset();
  const badge = $('#freshness-badge');
  const text = $('#freshness-text');
  if (!ds) { text.textContent = 'No dataset loaded'; badge.className = 'freshness-badge'; return; }
  const ageHours = (Date.now() - ds.loadedAt) / 3600000;
  const threshold = state.settings.freshnessThresholdHours;
  text.textContent = `${ds.table} — loaded ${timeAgo(ds.loadedAt)}`;
  badge.className = 'freshness-badge' + (ageHours > threshold * 3 ? ' very-stale' : ageHours > threshold ? ' stale' : '');
}
setInterval(refreshFreshnessBadge, 30000);

// ============================================================
// File Loading
// ============================================================
function initFileLoading() {
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault(); dropzone.classList.remove('dragover');
    await handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', async (e) => { await handleFiles(e.target.files); fileInput.value = ''; });

  $('#btn-load-golden').addEventListener('click', async () => {
    await ensureDuckDB();
    await loaders.loadGoldenDataset();
    renderSidebar();
    resetPanelStates();
  });
}

async function handleFiles(files) {
  await ensureDuckDB();
  for (const file of files) {
    try {
      await loaders.loadFile(file);
    } catch (e) { /* toast already shown */ }
  }
  renderSidebar();
  resetPanelStates();
}

function resetPanelStates() {
  const hasData = state.datasets.length > 0;
  $('#preflight-empty').style.display = hasData ? 'none' : '';
  $('#clean-empty').style.display = hasData ? 'none' : '';
  $('#validate-empty').style.display = hasData ? 'none' : '';
  $('#visualize-empty').style.display = hasData ? 'none' : '';
  const twinEmpty = $('#twin-empty');
  if (twinEmpty) { twinEmpty.style.display = hasData ? 'none' : ''; $('#twin-body').style.display = hasData ? '' : 'none'; }
  if (activeTab === 'twin') buildTwinControls();
  if (hasData) {
    $('#sql-input').value = $('#sql-input').value || `SELECT * FROM ${getActiveDataset().table} LIMIT 100;`;
    populateVisualizeBuilder();
  }
}

let duckdbReadyPromise = null;
async function ensureDuckDB() {
  if (state.duckdb.ready) return;
  toast('Starting DuckDB-WASM engine…', 'warn');
  await engine.initDuckDB();
  toast('DuckDB-WASM engine ready', 'success');
}

// ============================================================
// Preflight Tab
// ============================================================
async function runPreflight() {
  const ds = getActiveDataset();
  if (!ds) { toast('Load a dataset first', 'error'); return; }
  $('#preflight-empty').style.display = 'none';
  const resultsEl = $('#preflight-results');
  resultsEl.style.display = '';
  resultsEl.innerHTML = '<div class="skeleton" style="height:120px; border-radius:var(--radius-lg);"></div>';

  const checks = [];
  checks.push({ label: 'Rows loaded', value: ds.rowCount.toLocaleString(), status: ds.rowCount > 0 ? 'pass' : 'fail' });
  checks.push({ label: 'Columns', value: ds.cols.length, status: ds.cols.length > 0 ? 'pass' : 'fail' });

  let nullCols = 0;
  for (const c of ds.cols) {
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${ds.table} WHERE "${c.name}" IS NULL`);
    if (rows[0].n > 0) nullCols++;
  }
  checks.push({ label: 'Columns with nulls', value: `${nullCols} / ${ds.cols.length}`, status: nullCols === 0 ? 'pass' : nullCols < ds.cols.length / 2 ? 'warn' : 'fail' });

  const allCols = ds.cols.map(c => `"${c.name}"`).join(',');
  const { rows: dupRows } = await engine.runQuery(`SELECT SUM(c) - COUNT(*) AS extra FROM (SELECT ${allCols}, COUNT(*) AS c FROM ${ds.table} GROUP BY ${allCols} HAVING COUNT(*) > 1) t`);
  checks.push({ label: 'Duplicate rows', value: dupRows[0].extra || 0, status: !dupRows[0].extra ? 'pass' : 'warn' });

  const ageHours = (Date.now() - ds.loadedAt) / 3600000;
  checks.push({ label: 'Freshness', value: timeAgo(ds.loadedAt), status: ageHours < state.settings.freshnessThresholdHours ? 'pass' : 'warn' });

  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const overall = failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass';

  resultsEl.innerHTML = '';
  const summary = el('div', { class: 'card', style: 'padding:var(--space-5); margin-bottom:var(--space-4); display:flex; align-items:center; gap:var(--space-3);' }, [
    el('span', { class: `status-dot ${overall}`, style: 'width:14px;height:14px;' }),
    el('div', {}, [
      el('div', { style: 'font-weight:600; font-size:var(--text-lg);' }, overall === 'pass' ? 'Ready for analysis' : overall === 'warn' ? 'Usable, with caveats' : 'Needs attention before analysis'),
      el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted);' }, `Dataset: ${ds.table} · ${ds.cols.length} columns · ${ds.rowCount.toLocaleString()} rows`),
    ]),
  ]);
  resultsEl.appendChild(summary);

  const grid = el('div', { class: 'validation-grid' });
  for (const c of checks) {
    grid.appendChild(el('div', { class: 'card validation-card' }, [
      el('div', { class: 'validation-card-head' }, [
        el('span', { class: 'validation-card-name' }, c.label),
        el('span', { class: `validation-status ${c.status}` }, [el('span', { class: `status-dot ${c.status}` }), c.status.toUpperCase()]),
      ]),
      el('div', { style: 'font-size:var(--text-lg); font-weight:600;' }, String(c.value)),
    ]));
  }
  resultsEl.appendChild(grid);

  const colsCard = el('div', { class: 'card', style: 'padding:var(--space-4); margin-top:var(--space-4);' }, [
    el('div', { class: 'sidebar-heading' }, 'Column Schema'),
    el('div', { class: 'result-table-wrap' }, [
      el('table', { class: 'result-table', html: `<thead><tr><th>Column</th><th>Type</th></tr></thead><tbody>${ds.cols.map(c => `<tr><td>${escapeHtml(c.name)}</td><td class="mono">${escapeHtml(c.type)}</td></tr>`).join('')}</tbody>` }),
    ]),
  ]);
  resultsEl.appendChild(colsCard);
}

// ============================================================
// SQL Tab
// ============================================================
async function runSqlQuery() {
  const sql = $('#sql-input').value.trim();
  if (!sql) return;
  await ensureDuckDB();
  const statusEl = $('#sql-status');
  const resultWrap = $('#sql-result-wrap');
  statusEl.textContent = 'Running…';
  resultWrap.innerHTML = '<div class="skeleton" style="height:200px; border-radius:var(--radius-md); margin-top:var(--space-3);"></div>';
  try {
    const result = await engine.runQuery(sql);
    state.lastQuery = sql;
    state.lastQueryResult = result;
    statusEl.textContent = `${result.rowCount.toLocaleString()} row(s) in ${result.elapsedMs.toFixed(0)}ms`;
    renderResultTable(resultWrap, result);
    $('#story-empty').style.display = 'none';
  } catch (err) {
    statusEl.textContent = '';
    resultWrap.innerHTML = `<div class="card" style="padding:var(--space-4); border-color:var(--color-error); color:var(--color-error); font-size:var(--text-sm);" class="mono">${escapeHtml(err.message)}</div>`;
  }
}

function renderResultTable(container, result) {
  if (result.rows.length === 0) {
    container.innerHTML = '<div style="padding:var(--space-6); text-align:center; color:var(--color-text-muted); font-size:var(--text-sm);">Query returned no rows.</div>';
    return;
  }
  const head = `<thead><tr>${result.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${result.rows.slice(0, 500).map(r => `<tr>${result.columns.map(c => `<td>${escapeHtml(formatNumber(r[c]))}</td>`).join('')}</tr>`).join('')}</tbody>`;
  container.innerHTML = `<div class="result-table-wrap" style="margin-top:var(--space-3);"><table class="result-table">${head}${body}</table></div>`;
}

function initSqlTab() {
  $('#btn-sql-run').addEventListener('click', runSqlQuery);
  $('#btn-sql-format').addEventListener('click', () => {
    const el = $('#sql-input');
    el.value = el.value.replace(/\s+/g, ' ').replace(/\bSELECT\b/gi, '\nSELECT').replace(/\bFROM\b/gi, '\nFROM').replace(/\bWHERE\b/gi, '\nWHERE').replace(/\bGROUP BY\b/gi, '\nGROUP BY').replace(/\bORDER BY\b/gi, '\nORDER BY').trim();
    scheduleAmbientCheck();
  });
  $('#sql-input').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runSqlQuery(); }
  });
  initAmbientValidation();
}

// ============================================================
// Ambient Validation (Feature 5) — live, incremental checks as you type,
// run in a Web Worker so the SQL editor never blocks.
// ============================================================
let ambientWorker = null;
let ambientReqId = 0;
// Warnings the user explicitly dismissed this session — keyed so an identical
// warning doesn't nag again until the query text changes it away and back.
const dismissedAmbient = new Set();

function ensureAmbientWorker() {
  if (ambientWorker) return ambientWorker;
  try {
    ambientWorker = new Worker(new URL('./ambient-validation.worker.js', import.meta.url), { type: 'module' });
    ambientWorker.onmessage = (e) => {
      const { requestId, warnings } = e.data || {};
      if (requestId !== ambientReqId) return; // stale result from an earlier keystroke
      renderAmbientWarnings(warnings || []);
    };
    ambientWorker.onerror = () => { /* never let a worker error break typing */ };
  } catch {
    ambientWorker = null; // Worker unsupported — feature silently unavailable
  }
  return ambientWorker;
}

function teardownAmbientWorker() {
  if (ambientWorker) { ambientWorker.terminate(); ambientWorker = null; }
}

const scheduleAmbientCheck = debounce(() => {
  const input = $('#sql-input');
  if (!input) return;
  const sql = input.value || '';
  const worker = ensureAmbientWorker();
  if (!worker) return;
  const ds = getActiveDataset();
  const columns = ds && Array.isArray(ds.cols) ? ds.cols.map(c => c.name) : [];
  ambientReqId += 1;
  worker.postMessage({ requestId: ambientReqId, sql, columns });
}, 800);

function renderAmbientWarnings(warnings) {
  const wrap = $('#ambient-warnings');
  if (!wrap) return;
  const visible = warnings.filter(w => !dismissedAmbient.has(ambientKey(w)));
  wrap.innerHTML = '';
  if (visible.length === 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  for (const w of visible) {
    const tone = w.severity === 'info' ? 'warn' : 'fail';
    const row = el('div', {
      class: `validation-status ${tone}`,
      'data-testid': `ambient-warning-${w.id}`,
      style: 'display:flex; align-items:flex-start; gap:var(--space-2); padding:var(--space-2) var(--space-3); border-radius:var(--radius-md); font-size:var(--text-xs);',
    }, [
      el('span', { class: `status-dot ${tone}`, style: 'margin-top:3px; flex:none;' }),
      el('span', { style: 'flex:1;' }, w.message),
    ]);
    const dismiss = el('button', {
      class: 'btn btn-secondary',
      style: 'font-size:var(--text-xs); padding:2px 8px; flex:none;',
      'data-testid': `ambient-dismiss-${w.id}`,
      onclick: () => { dismissedAmbient.add(ambientKey(w)); renderAmbientWarnings(warnings); },
    }, 'Dismiss');
    row.appendChild(dismiss);
    wrap.appendChild(row);
  }
}

function ambientKey(w) {
  return `${w.id}|${w.column || ''}|${w.message}`;
}

function initAmbientValidation() {
  const input = $('#sql-input');
  if (!input) return;
  input.addEventListener('input', scheduleAmbientCheck);
  // No orphaned workers: tear the worker down when the page goes away.
  window.addEventListener('pagehide', teardownAmbientWorker);
  window.addEventListener('beforeunload', teardownAmbientWorker);
}

// ============================================================
// On-Device SLM Interpreter (Feature 4) — opt-in, in-browser LLM synthesis
// of the validation findings. No data ever leaves the browser.
// ============================================================
function initAISynthesis() {
  const downloadBtn = $('#btn-slm-download');
  const synthBtn = $('#btn-slm-synthesize');
  const statusEl = $('#slm-status');
  const progressWrap = $('#slm-progress-wrap');
  const progressBar = $('#slm-progress-bar');
  const outputEl = $('#slm-output');
  if (!downloadBtn) return;

  if (!ondeviceLLM.isWebGPUAvailable()) {
    downloadBtn.disabled = true;
    statusEl.innerHTML = 'This feature needs a <strong>WebGPU-capable browser</strong> (recent Chrome, Edge, or Chrome on Android; Safari 18+). On-device AI synthesis is unavailable here — every other DATAGLOW feature works as normal.';
    statusEl.setAttribute('data-slm-state', 'no-webgpu');
    return;
  }
  statusEl.textContent = `Ready to download ${ondeviceLLM.MODEL_LABEL}. Runs entirely on your device; nothing is uploaded.`;

  downloadBtn.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    progressWrap.style.display = '';
    statusEl.setAttribute('data-slm-state', 'loading');
    try {
      await ondeviceLLM.loadModel(({ progress, text }) => {
        progressBar.style.width = `${Math.round((progress || 0) * 100)}%`;
        statusEl.textContent = text || `Downloading model… ${Math.round((progress || 0) * 100)}%`;
      });
      progressWrap.style.display = 'none';
      statusEl.textContent = 'Model loaded — running fully offline on your device.';
      statusEl.setAttribute('data-slm-state', 'ready');
      downloadBtn.style.display = 'none';
      synthBtn.style.display = '';
    } catch (err) {
      progressWrap.style.display = 'none';
      downloadBtn.disabled = false;
      statusEl.setAttribute('data-slm-state', err.code === 'NO_WEBGPU' ? 'no-webgpu' : 'error');
      statusEl.textContent = err.message || 'Model failed to load.';
    }
  });

  synthBtn.addEventListener('click', async () => {
    const results = window.__dataglowLastValidation;
    if (!results) { toast('Run the validation suite first', 'error'); return; }
    synthBtn.disabled = true;
    const original = synthBtn.textContent;
    synthBtn.textContent = 'Synthesizing…';
    outputEl.style.display = '';
    outputEl.textContent = '';
    try {
      const context = {
        ledgerEntries: ledger.getLedgerEntries(),
        layerResults: results,
        physicsOutput: window.__dataglowPhysicsOutput || null,
      };
      await ondeviceLLM.synthesizeFindings(context, (partial) => {
        outputEl.textContent = partial;
      });
    } catch (err) {
      outputEl.textContent = 'Synthesis failed: ' + (err.message || err);
    } finally {
      synthBtn.disabled = false;
      synthBtn.textContent = original;
    }
  });
}

// ============================================================
// Python Tab
// ============================================================
let pythonInitStarted = false;
function ensurePythonRuntime() {
  if (pythonInitStarted) return;
  pythonInitStarted = true;
  const statusBadge = $('#py-status');
  pyRuntime.initPyodideRuntime((status) => {
    if (status === 'ready') {
      statusBadge.textContent = 'Ready';
      statusBadge.className = 'badge badge-a';
      $('#btn-py-run').disabled = false;
    } else {
      statusBadge.textContent = status;
    }
  }).catch(err => { statusBadge.textContent = 'Failed to load'; statusBadge.className = 'badge badge-d'; toast('Python runtime failed to load: ' + err.message, 'error'); });
}

function initPythonTab() {
  $('#btn-py-run').addEventListener('click', async () => {
    const code = $('#py-input').value;
    const outWrap = $('#py-output-wrap');
    outWrap.innerHTML = '<div class="skeleton" style="height:100px; border-radius:var(--radius-md); margin-top:var(--space-3);"></div>';
    try {
      const { stdout, result, error } = await pyRuntime.runPython(code, getActiveDataset()?.table);
      let html = '<div class="console-log" style="margin-top:var(--space-3);">';
      if (stdout) html += escapeHtml(stdout);
      if (result) html += (stdout ? '\n' : '') + `<span class="ok">${escapeHtml(result)}</span>`;
      if (error) html += `<span class="err">${escapeHtml(error)}</span>`;
      if (!stdout && !result && !error) html += '<span style="color:var(--color-text-faint);">(no output)</span>';
      html += '</div>';
      outWrap.innerHTML = html;
    } catch (err) {
      outWrap.innerHTML = `<div class="console-log" style="margin-top:var(--space-3);"><span class="err">${escapeHtml(err.message)}</span></div>`;
    }
  });
  $('#py-input').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !$('#btn-py-run').disabled) { e.preventDefault(); $('#btn-py-run').click(); }
  });
}

// ============================================================
// R Tab
// ============================================================
let rInitStarted = false;
function ensureRRuntime() {
  if (rInitStarted) return;
  rInitStarted = true;
  const statusBadge = $('#r-status');
  rRuntime.initWebRRuntime((status) => {
    if (status === 'ready') {
      statusBadge.textContent = 'Ready';
      statusBadge.className = 'badge badge-a';
      $('#btn-r-run').disabled = false;
    } else {
      statusBadge.textContent = status;
    }
  }).catch(err => { statusBadge.textContent = 'Failed to load'; statusBadge.className = 'badge badge-d'; toast('R runtime failed to load: ' + err.message, 'error'); });
}

function initRTab() {
  $('#btn-r-run').addEventListener('click', async () => {
    const code = $('#r-input').value;
    const outWrap = $('#r-output-wrap');
    outWrap.innerHTML = '<div class="skeleton" style="height:100px; border-radius:var(--radius-md); margin-top:var(--space-3);"></div>';
    try {
      const { stdout, error } = await rRuntime.runR(code);
      let html = '<div class="console-log" style="margin-top:var(--space-3);">';
      html += stdout ? escapeHtml(stdout) : '<span style="color:var(--color-text-faint);">(no output)</span>';
      if (error) html += `\n<span class="err">${escapeHtml(error)}</span>`;
      html += '</div>';
      outWrap.innerHTML = html;
    } catch (err) {
      outWrap.innerHTML = `<div class="console-log" style="margin-top:var(--space-3);"><span class="err">${escapeHtml(err.message)}</span></div>`;
    }
  });
}

// ============================================================
// Clean Tab
// ============================================================
async function scanClean() {
  const ds = getActiveDataset();
  if (!ds) { toast('Load a dataset first', 'error'); return; }
  $('#clean-empty').style.display = 'none';
  const resultsEl = $('#clean-results');
  resultsEl.style.display = '';
  resultsEl.innerHTML = '<div class="skeleton" style="height:160px; border-radius:var(--radius-lg);"></div>';

  const issues = await clean.scanForIssues(ds.table, ds.cols);
  const auditLog = [];
  window.__dataglowAuditLog = auditLog;

  if (issues.length === 0) {
    resultsEl.innerHTML = '<div class="card" style="padding:var(--space-6); text-align:center;"><div style="font-size:var(--text-lg); font-weight:600; color:var(--color-grade-a); margin-bottom:4px;">No issues found</div><div style="color:var(--color-text-muted); font-size:var(--text-sm);">This dataset looks clean.</div></div>';
    return;
  }

  resultsEl.innerHTML = '';
  const grid = el('div', { class: 'validation-grid' });
  for (const issue of issues) {
    const card = el('div', { class: 'card validation-card' });
    card.appendChild(el('div', { class: 'validation-card-head' }, [
      el('span', { class: 'validation-card-name' }, issue.label),
    ]));
    const fixRow = el('div', { style: 'display:flex; gap:var(--space-2); flex-wrap:wrap; margin-top:var(--space-2); align-items:center;' });
    for (const fixType of issue.fixes) {
      const conf = fixConfidence.scoreFixConfidence(issue, fixType);
      const confColor = conf.score >= 75 ? 'var(--color-grade-a)' : conf.score >= 50 ? 'var(--color-grade-c)' : 'var(--color-grade-d)';
      const wrap = el('div', { style: 'display:flex; flex-direction:column; gap:2px;' });
      const btn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:6px 10px;', 'data-testid': `button-fix-${issue.id}-${fixType}` }, clean.FIX_LABELS[fixType]);
      btn.appendChild(el('span', { style: `margin-left:6px; font-size:10px; padding:1px 5px; border-radius:8px; background:${confColor}; color:#fff;`, title: conf.label }, `${conf.score}`));
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        await clean.applyFix(ds.table, issue, fixType, auditLog);
        ledger.logAssumption('Data Cleaning', `${clean.FIX_LABELS[fixType]} — ${issue.label}.`);
        await provenance.recordStep(ds.table, 'clean', `${clean.FIX_LABELS[fixType]} — ${issue.label}.`, { fixType, column: issue.column });
        renderAuditLog(auditLog);
        toast(`Applied: ${clean.FIX_LABELS[fixType]}`, 'success');
        card.style.opacity = '0.4';
        card.style.pointerEvents = 'none';
        ds.rowCount = await engine.getRowCount(ds.table);
        renderSidebar();
      });
      wrap.appendChild(btn);
      wrap.appendChild(el('span', { style: `font-size:10px; color:${confColor};` }, conf.label));
      fixRow.appendChild(wrap);
    }
    card.appendChild(fixRow);
    grid.appendChild(card);
  }
  resultsEl.appendChild(grid);
  $('#clean-audit-wrap').style.display = '';
  renderAuditLog(auditLog);
  await renderFormatIssues(ds, auditLog);
  await renderActiveLearning(ds);
  await renderMissingness(ds, auditLog);
  await renderFuzzyDedup(ds, auditLog);
}

// Active-learning: highlight the most uncertain imputation targets first.
async function renderActiveLearning(ds) {
  const ranked = await activeLearning.rankUncertainCells(ds.table, ds.cols, engine).catch(() => []);
  if (!ranked.length) return;
  const note = el('div', { class: 'card', style: 'padding:var(--space-3); margin-top:var(--space-4);' }, [
    el('div', { class: 'sidebar-heading', style: 'margin-bottom:var(--space-2);' }, 'Review First — Most Uncertain Fills (active learning)'),
    el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-bottom:var(--space-2);' }, 'Uncertainty sampling (Settles 2009) — columns whose fill value is least reliable are listed first.'),
  ]);
  ranked.slice(0, 8).forEach((r, i) => {
    const pct = Math.round(r.uncertaintyScore * 100);
    const color = pct >= 66 ? 'var(--color-grade-d)' : pct >= 33 ? 'var(--color-grade-c)' : 'var(--color-grade-a)';
    note.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); padding:4px 0; font-size:var(--text-sm); border-top:1px solid var(--color-divider);' }, [
      el('span', { style: `font-size:10px; padding:1px 6px; border-radius:8px; background:${color}; color:#fff;` }, `${pct}%`),
      el('span', {}, r.reason),
    ]));
  });
  $('#clean-results').appendChild(note);
}

// Missingness Detective + Grouped Imputation Wizard.
async function renderMissingness(ds, auditLog) {
  const wrap = $('#missingness-wrap');
  const list = $('#missingness-list');
  const results = await missingness.analyzeMissingness(ds.table, ds.cols).catch(() => []);
  if (!results.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';
  const grid = el('div', { class: 'validation-grid' });
  const catCols = ds.cols.filter(c => c.type === 'VARCHAR').map(c => c.name);
  for (const m of results) {
    const card = el('div', { class: 'card validation-card', 'data-testid': `card-missingness-${m.column}` });
    card.appendChild(el('div', { class: 'validation-card-head' }, [
      el('span', { class: 'validation-card-name' }, `"${m.column}"`),
      el('span', { class: `validation-status ${m.likelyMCAR ? 'pass' : 'warn'}` }, [el('span', { class: `status-dot ${m.likelyMCAR ? 'pass' : 'warn'}` }), m.likelyMCAR ? 'MCAR' : 'MAR/MNAR']),
    ]));
    card.appendChild(el('div', { class: 'validation-card-desc' }, m.narrative));
    // Offer the imputation wizard for numeric columns (always available on request).
    if (m.isNumeric && catCols.length) {
      const wizWrap = el('div', { style: 'margin-top:var(--space-2);' });
      const label = el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:4px;' }, 'Grouped Imputation Wizard — group by:');
      const sel = el('select', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:4px 8px;' },
        catCols.map(c => el('option', { value: c }, c)));
      const genBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:6px 10px; margin-left:var(--space-2);', 'data-testid': `button-impute-preview-${m.column}` }, 'Preview Imputation');
      const out = el('div', { style: 'margin-top:var(--space-2);' });
      genBtn.addEventListener('click', async () => {
        genBtn.disabled = true;
        try {
          const preview = await imputation.previewGroupedImputation(ds.table, m.column, [sel.value]);
          out.innerHTML = '';
          out.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:4px;' },
            `Would fill ${preview.wouldFill} of ${preview.nullCount} null(s); ${preview.remainingNulls} remain unfilled.`));
          out.appendChild(el('pre', { class: 'mono', style: 'font-size:var(--text-xs); background:var(--color-surface-offset); padding:var(--space-2); border-radius:var(--radius-sm); overflow-x:auto; white-space:pre-wrap;' }, preview.sql));
          const btnRow = el('div', { style: 'display:flex; gap:var(--space-2); margin-top:var(--space-2);' });
          const copyBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:6px 10px;' }, 'Copy SQL');
          copyBtn.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(preview.sql); toast('SQL copied', 'success'); }
            catch (e) { toast('Copy failed: ' + e.message, 'error'); }
          });
          btnRow.appendChild(copyBtn);
          out.appendChild(btnRow);
          out.appendChild(el('div', { style: 'font-size:10px; color:var(--color-text-faint); margin-top:4px;' }, 'Preview only — nothing is written to your data. Copy the SQL to apply it yourself.'));
        } catch (e) {
          out.innerHTML = '';
          out.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-error);' }, 'Preview failed: ' + e.message));
        } finally {
          genBtn.disabled = false;
        }
      });
      wizWrap.appendChild(label);
      const ctrlRow = el('div', { style: 'display:flex; align-items:center; flex-wrap:wrap;' }, [sel, genBtn]);
      wizWrap.appendChild(ctrlRow);
      wizWrap.appendChild(out);
      card.appendChild(wizWrap);
    }
    grid.appendChild(card);
  }
  list.appendChild(grid);
}

// Fuzzy Duplicate Radar — Merge / Ignore per candidate pair.
async function renderFuzzyDedup(ds, auditLog) {
  const wrap = $('#fuzzy-dedup-wrap');
  const list = $('#fuzzy-dedup-list');
  const res = await fuzzyDedup.findFuzzyDuplicates(ds.table, ds.cols).catch(() => null);
  if (!res || !res.pairs || !res.pairs.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';
  if (res.warning) {
    list.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-bottom:var(--space-2);' }, res.warning));
  }
  for (const pair of res.pairs.slice(0, 50)) {
    const row = el('div', { class: 'card', style: 'padding:var(--space-3); margin-bottom:var(--space-2); display:flex; align-items:center; gap:var(--space-3); flex-wrap:wrap;', 'data-testid': `pair-fuzzy-${pair.rowA}-${pair.rowB}` });
    row.appendChild(el('span', { style: 'font-size:11px; padding:1px 6px; border-radius:8px; background:var(--color-grade-c); color:#fff;' }, `${(pair.similarity * 100).toFixed(0)}%`));
    row.appendChild(el('span', { class: 'mono', style: 'font-size:var(--text-sm);' }, `"${pair.valueA}"`));
    row.appendChild(el('span', { style: 'color:var(--color-text-faint);' }, '≈'));
    row.appendChild(el('span', { class: 'mono', style: 'font-size:var(--text-sm);' }, `"${pair.valueB}"`));
    const mergeBtn = el('button', { class: 'btn btn-primary', style: 'font-size:var(--text-xs); padding:6px 10px; margin-left:auto;', 'data-testid': `button-merge-${pair.rowA}-${pair.rowB}` }, 'Merge →');
    const ignoreBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:6px 10px;' }, 'Ignore');
    mergeBtn.addEventListener('click', async () => {
      mergeBtn.disabled = true; ignoreBtn.disabled = true;
      try {
        const col = `"${pair.column}"`;
        const from = String(pair.valueB).replace(/'/g, "''");
        const to = String(pair.valueA).replace(/'/g, "''");
        await engine.runQuery(`UPDATE ${ds.table} SET ${col} = '${to}' WHERE ${col} = '${from}'`);
        auditLog.push(`[${new Date().toLocaleTimeString()}] Merged "${pair.valueB}" → "${pair.valueA}" in "${pair.column}".`);
        ledger.logAssumption('Fuzzy Duplicate Radar', `Merged "${pair.valueB}" → "${pair.valueA}" in "${pair.column}".`);
        await provenance.recordStep(ds.table, 'merge', `Merged "${pair.valueB}" → "${pair.valueA}" in "${pair.column}".`, { column: pair.column });
        renderAuditLog(auditLog);
        // Record as a manual correction; may trigger a reusable-rule suggestion.
        ruleSuggestions.recordCorrection(pair.valueB, pair.valueA, pair.column);
        await maybeShowRuleSuggestion(ds);
        row.style.opacity = '0.4'; row.style.pointerEvents = 'none';
        toast('Merged', 'success');
      } catch (e) {
        mergeBtn.disabled = false; ignoreBtn.disabled = false;
        toast('Merge failed: ' + e.message, 'error');
      }
    });
    ignoreBtn.addEventListener('click', () => { row.style.opacity = '0.4'; row.style.pointerEvents = 'none'; });
    row.appendChild(mergeBtn);
    row.appendChild(ignoreBtn);
    list.appendChild(row);
  }
}

// Rule-suggestion banner: appears only after 2+ identical manual corrections.
// The Approve button is the ONLY path that persists a rule.
async function maybeShowRuleSuggestion(ds) {
  const banner = $('#rule-suggestion-banner');
  const suggestions = ruleSuggestions.getSuggestedRules(2);
  if (!suggestions.length) { banner.style.display = 'none'; return; }
  const s = suggestions[0];
  banner.style.display = '';
  banner.innerHTML = '';
  const card = el('div', { class: 'card', style: 'padding:var(--space-3); border-color:var(--color-grade-b);' }, [
    el('div', { style: 'font-weight:600; margin-bottom:4px;' }, 'Reusable rule suggestion'),
    el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-bottom:var(--space-2);' },
      `You corrected "${s.originalValue}" → "${s.correctedValue}" in "${s.column}" ${s.occurrences} times. Save this as a reusable rule?`),
  ]);
  const approveBtn = el('button', { class: 'btn btn-primary', style: 'font-size:var(--text-xs); padding:6px 10px; margin-right:var(--space-2);', 'data-testid': 'button-approve-rule' }, 'Approve & Save Rule');
  const dismissBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:6px 10px;' }, 'Dismiss');
  approveBtn.addEventListener('click', async () => {
    const name = prompt('Name this rule:', `${s.column}: ${s.originalValue}→${s.correctedValue}`);
    if (!name) return; // no name → no persistence (human approval gate)
    try {
      await ruleSuggestions.approveRule(s, name);
      toast('Rule approved and saved to local memory', 'success');
      banner.style.display = 'none';
      await refreshMemoryPanel();
    } catch (e) {
      toast('Could not save rule: ' + e.message, 'error');
    }
  });
  dismissBtn.addEventListener('click', () => { banner.style.display = 'none'; });
  card.appendChild(approveBtn);
  card.appendChild(dismissBtn);
  banner.appendChild(card);
}

async function renderFormatIssues(ds, auditLog) {
  const wrap = $('#format-issues-wrap');
  const list = $('#format-issues-list');
  const issues = await formatFingerprint.scanFormatIssues(ds.table, ds.cols).catch(() => []);
  if (!issues.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  list.innerHTML = '';
  const grid = el('div', { class: 'validation-grid' });
  for (const issue of issues) {
    const card = el('div', { class: 'card validation-card', 'data-testid': `card-format-${issue.column}-${issue.issueType}` });
    card.appendChild(el('div', { class: 'validation-card-head' }, [
      el('span', { class: 'validation-card-name' }, `"${issue.column}" — ${issue.issueType.replace(/_/g, ' ')}`),
    ]));
    card.appendChild(el('div', { class: 'validation-card-desc' }, issue.detail));
    card.appendChild(el('pre', { class: 'mono', style: 'font-size:var(--text-xs); background:var(--color-surface-offset); padding:var(--space-2); border-radius:var(--radius-sm); overflow-x:auto; margin-top:var(--space-2); white-space:pre-wrap;' }, issue.suggestedFixSQL));
    const btnRow = el('div', { style: 'display:flex; gap:var(--space-2); flex-wrap:wrap; margin-top:var(--space-2);' });
    const copyBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:6px 10px;' }, 'Copy SQL');
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(issue.suggestedFixSQL); toast('SQL copied to clipboard', 'success'); }
      catch (e) { toast('Copy failed: ' + e.message, 'error'); }
    });
    const applyBtn = el('button', { class: 'btn btn-primary', style: 'font-size:var(--text-xs); padding:6px 10px;', 'data-testid': `button-format-apply-${issue.column}-${issue.issueType}` }, 'Apply');
    applyBtn.addEventListener('click', async () => {
      applyBtn.disabled = true;
      try {
        for (const stmt of issue.suggestedFixSQL.split(';')) {
          const s = stmt.replace(/--.*$/gm, '').trim();
          if (s) await engine.runQuery(s);
        }
        auditLog.push(`[${new Date().toLocaleTimeString()}] Applied format fix on "${issue.column}" (${issue.issueType}).`);
        renderAuditLog(auditLog);
        toast(`Applied format fix on "${issue.column}"`, 'success');
        card.style.opacity = '0.4';
        card.style.pointerEvents = 'none';
      } catch (e) {
        applyBtn.disabled = false;
        toast('Apply failed: ' + e.message, 'error');
      }
    });
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(applyBtn);
    card.appendChild(btnRow);
    grid.appendChild(card);
  }
  list.appendChild(grid);
}

function renderAuditLog(auditLog) {
  const logEl = $('#clean-audit-log');
  logEl.innerHTML = auditLog.length ? auditLog.map(l => `<div>${escapeHtml(l)}</div>`).join('') : '<span style="color:var(--color-text-faint);">No fixes applied yet.</span>';
  logEl.scrollTop = logEl.scrollHeight;
}

// ============================================================
// Validate Tab (18 layers)
// ============================================================
function statusIcon(status) {
  const icons = { pass: '✓', fail: '✕', warn: '!', idle: '—' };
  return icons[status] || '—';
}

async function runValidation() {
  const ds = getActiveDataset();
  if (!ds) { toast('Load a dataset first', 'error'); return; }
  $('#validate-empty').style.display = 'none';
  const grid = $('#validation-grid');
  grid.style.display = '';
  grid.innerHTML = validation.LAYER_DEFS.map(() => '<div class="skeleton" style="height:110px; border-radius:var(--radius-lg);"></div>').join('');

  const packSel = $('#domain-pack-select');
  const pack = packSel && packSel.value ? packSel.value : 'healthcare';
  // Cross-session fingerprint drift is opt-in: only hand the IndexedDB store to
  // the drift layer when the user has enabled persistence. Off by default.
  const fingerprintStore = state.settings.persistFingerprints ? memoryStore : null;
  const results = await validation.runAllLayers(ds, { freshnessThresholdHours: state.settings.freshnessThresholdHours, pack, fingerprintStore });
  renderValidationResults(results);
  window.__dataglowLastValidation = results;
  await renderTopProblems(ds, results);
  await renderDataHealth(ds, results);
  await renderMultivariate(ds);
  await renderSPC(ds);
  await persistColumnProfiles(ds, results);
  renderAssumptionLedger();
  renderProvenanceTrail();
}

// The Assumption Ledger — a running, exportable log of every judgment call.
function renderAssumptionLedger() {
  const wrap = $('#assumption-ledger-wrap');
  const list = $('#assumption-ledger-list');
  const entries = ledger.getLedgerEntries();
  wrap.style.display = '';
  if (!entries.length) {
    list.innerHTML = '<span style="color:var(--color-text-faint);">No assumptions recorded yet — run validation or apply a cleaning fix.</span>';
    return;
  }
  list.innerHTML = '';
  for (const e of entries) {
    const time = new Date(e.ts).toLocaleTimeString();
    list.appendChild(el('div', { style: 'padding:4px 0; border-top:1px solid var(--color-divider);' }, [
      el('span', { style: 'color:var(--color-text-faint);' }, `[${time}] `),
      el('span', { style: 'font-weight:600; color:var(--color-text-muted);' }, `${e.source}: `),
      el('span', {}, e.action),
    ]));
  }
  list.scrollTop = list.scrollHeight;
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function initLedger() {
  $('#btn-ledger-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ledger.exportLedger('text')); toast('Ledger copied', 'success'); }
    catch (e) { toast('Copy failed: ' + e.message, 'error'); }
  });
  $('#btn-ledger-export-txt').addEventListener('click', () => downloadText('dataglow-assumption-ledger.txt', ledger.exportLedger('text'), 'text/plain'));
  $('#btn-ledger-export-md').addEventListener('click', () => downloadText('dataglow-assumption-ledger.md', ledger.exportLedger('markdown'), 'text/markdown'));
  $('#btn-ledger-export-json').addEventListener('click', () => downloadText('dataglow-assumption-ledger.json', ledger.exportLedger('json'), 'application/json'));
  $('#btn-ledger-clear').addEventListener('click', () => { ledger.clearLedger(); renderAssumptionLedger(); toast('Ledger cleared', 'success'); });
}

// Data Provenance Trail — the tamper-evident cryptographic sibling of the
// Assumption Ledger. Renders the hash-chained transformation timeline for the
// active dataset and lets the analyst verify + export it for audit.
function renderProvenanceTrail() {
  const wrap = $('#provenance-wrap');
  const list = $('#provenance-list');
  if (!wrap || !list) return;
  const ds = getActiveDataset();
  const chain = ds ? provenance.getProvenance(ds.table) : null;
  wrap.style.display = '';
  const trail = chain ? chain.getTrail() : [];
  if (!trail.length) {
    list.innerHTML = '<span style="color:var(--color-text-faint);">No provenance recorded yet — load a dataset to anchor the chain of custody.</span>';
    return;
  }
  list.innerHTML = '';
  for (const e of trail) {
    list.appendChild(el('div', { style: 'padding:5px 0; border-top:1px solid var(--color-divider);' }, [
      el('span', { style: 'color:var(--color-text-faint);' }, `#${e.index} `),
      el('span', { style: 'font-weight:600; color:var(--color-text-muted);' }, `${e.op}: `),
      el('span', {}, e.description),
      el('div', { class: 'mono', style: 'font-size:0.9em; color:var(--color-text-faint);' }, `hash ${e.hash.slice(0, 16)}… ← parent ${e.parentHash.slice(0, 16)}…`),
    ]));
  }
}

function initProvenance() {
  $('#btn-provenance-verify').addEventListener('click', async () => {
    const ds = getActiveDataset();
    const chain = ds ? provenance.getProvenance(ds.table) : null;
    const statusEl = $('#provenance-verify-status');
    if (!chain || !chain.length) { statusEl.textContent = 'Nothing to verify yet.'; statusEl.style.color = 'var(--color-text-faint)'; return; }
    const res = await chain.verify();
    statusEl.textContent = res.reason;
    statusEl.style.color = res.valid ? 'var(--color-grade-a)' : 'var(--color-grade-d)';
    toast(res.valid ? 'Provenance chain intact' : 'Provenance chain broken', res.valid ? 'success' : 'error');
  });
  $('#btn-provenance-export').addEventListener('click', () => {
    const ds = getActiveDataset();
    const chain = ds ? provenance.getProvenance(ds.table) : null;
    if (!chain || !chain.length) { toast('No provenance to export', 'error'); return; }
    downloadText(`dataglow-provenance-${ds.table}.json`, chain.exportTrail('json'), 'application/json');
  });
  const attMeta = (ds) => ({
    table: ds.table,
    rowCount: ds.rowCount,
    colCount: Array.isArray(ds.cols) ? ds.cols.length : null,
    columns: Array.isArray(ds.cols) ? ds.cols.map(c => ({ name: c.name, type: c.type })) : null,
    loadedAt: ds.loadedAt,
  });
  const attBtn = $('#btn-attestation-export');
  if (attBtn) attBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    const chain = ds ? provenance.getProvenance(ds.table) : null;
    if (!chain || !chain.length) { toast('No provenance to attest', 'error'); return; }
    const att = await chain.attest(attMeta(ds));
    downloadText(`dataglow-attestation-${ds.table}.json`, JSON.stringify(att, null, 2), 'application/json');
    toast('Attestation exported — digest ready for third-party notarization', 'success');
  });
  const attHtmlBtn = $('#btn-attestation-html');
  if (attHtmlBtn) attHtmlBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    const chain = ds ? provenance.getProvenance(ds.table) : null;
    if (!chain || !chain.length) { toast('No provenance to attest', 'error'); return; }
    const att = await chain.attest(attMeta(ds));
    downloadText(`dataglow-attestation-${ds.table}.html`, provenance.renderAttestationHTML(att), 'text/html');
    toast('Attestation HTML exported (printable / PDF-friendly)', 'success');
  });
  // Selective-disclosure provenance proof — a Merkle (SHA-256) commitment over
  // the validation claims, shareable to a third party who can verify specific
  // claims without ever receiving the dataset. Honest labelling: this is
  // selective disclosure with hash-verified membership, NOT a zero-knowledge proof.
  const sdBtn = $('#btn-sd-proof-export');
  if (sdBtn) sdBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    const results = state.validationResults || window.__dataglowLastValidation;
    if (!results) { toast('Run validation first to produce claims to prove', 'error'); return; }
    let attestationRef = null;
    const chain = provenance.getProvenance(ds.table);
    if (chain && chain.length) {
      const att = await chain.attest(attMeta(ds));
      attestationRef = { digest: att.digest && att.digest.value, finalHash: att.chain && att.chain.finalHash };
    }
    const artifact = await sdProof.generateProof({
      recordCount: ds.rowCount,
      grades: results.calibratedGrades,
      results,
      dataglow: { version: '1.0.0', build: 'gen10-batch3' },
      attestationRef,
    });
    downloadText(`dataglow-sd-proof-${ds.table}.json`, JSON.stringify(artifact, null, 2), 'application/json');
    toast('Verifiable proof exported — share the root/claims; the dataset stays private', 'success');
  });
}

// Populate the Domain Physics pack selector and re-run validation on change so
// switching packs (or turning reinterpretation off with "None") updates results.
function initDomainPack() {
  const sel = $('#domain-pack-select');
  if (!sel) return;
  const packs = domainPhysics.listPacks();
  sel.innerHTML = '';
  for (const p of packs) {
    const opt = el('option', { value: p.name, title: p.description }, p.label);
    if (p.name === 'healthcare') opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    if (getActiveDataset()) runValidation();
  });
}

// Devil's Advocate Mode — stress-tests the current SQL result and renders a
// robust/sensitive verdict. Logs the attack into the Assumption Ledger.
function initDevilsAdvocate() {
  const btn = $('#btn-attack-analysis');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const out = $('#attack-results');
    if (!state.lastQueryResult || !state.lastQueryResult.rows.length) {
      out.innerHTML = '';
      toast('Run a SQL query with results first', 'error');
      return;
    }
    const report = devilsAdvocate.attackAnalysis(state.lastQueryResult);
    out.innerHTML = '';
    const color = report.robust ? 'var(--color-grade-a)' : 'var(--color-grade-d)';
    out.appendChild(el('div', { class: 'card', style: `padding:var(--space-4); margin-top:var(--space-3); border-color:${color};`, 'data-testid': 'attack-verdict' }, [
      el('div', { style: `font-weight:600; color:${color}; margin-bottom:var(--space-2);` }, report.verdict),
      report.headline ? el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-bottom:var(--space-2);' },
        `Headline tested: mean of "${report.headline.column}" = ${report.headline.value.toFixed(2)} (n=${report.headline.n}).`) : null,
      ...report.checks.map(c => el('div', { style: 'display:flex; gap:var(--space-2); align-items:flex-start; padding:var(--space-2) 0; border-top:1px solid var(--color-divider); font-size:var(--text-sm);' }, [
        el('span', { class: `status-dot ${c.robust ? 'pass' : 'fail'}`, style: 'margin-top:4px; flex:none;' }),
        el('div', {}, [
          el('div', { style: 'font-weight:600;' }, c.name),
          el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, c.detail),
        ]),
      ])),
    ]));
    renderAssumptionLedger();
  });
}

// Shareable Validation Receipts — package the current analysis (Confidence
// grade, all 18 layer statuses, key ledger entries, and the Story narrative)
// into one self-contained HTML file a stakeholder can open without DATAGLOW.
function initReceipts() {
  const btn = $('#btn-export-receipt');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const ds = getActiveDataset();
    const results = window.__dataglowLastValidation;
    if (!ds || !results) { toast('Run all 18 layers first', 'error'); return; }
    const model = receipt.buildValidationReceipt({
      datasetName: ds.name || ds.table,
      results,
      ledgerEntries: ledger.getLedgerEntries(),
      storyText: state.lastStory || null,
    });
    downloadText(`dataglow-receipt-${ds.table}.html`, receipt.renderReceiptHTML(model), 'text/html');
    toast('Validation Receipt exported', 'success');
  });
}

// Async Peer Review Mode — export a structured review packet from the current
// analysis for a second person, and re-import their completed review to display
// it alongside the analysis. File-based; no backend.
function initPeerReview() {
  const exportJson = $('#btn-review-export-json');
  const exportMd = $('#btn-review-export-md');
  const importInput = $('#review-import-input');
  if (!exportJson) return;

  const buildPacket = () => {
    const ds = getActiveDataset();
    const results = window.__dataglowLastValidation;
    if (!ds || !results) { toast('Run all 18 layers first', 'error'); return null; }
    return peerReview.buildReviewPacket({
      datasetName: ds.name || ds.table,
      query: state.lastQuery || null,
      results,
      ledgerEntries: ledger.getLedgerEntries(),
    });
  };

  exportJson.addEventListener('click', () => {
    const packet = buildPacket();
    if (!packet) return;
    downloadText(`dataglow-review-packet-${getActiveDataset().table}.json`, peerReview.exportPacket(packet, 'json'), 'application/json');
    toast('Review packet exported (.json)', 'success');
  });
  exportMd.addEventListener('click', () => {
    const packet = buildPacket();
    if (!packet) return;
    downloadText(`dataglow-review-packet-${getActiveDataset().table}.md`, peerReview.exportPacket(packet, 'markdown'), 'text/markdown');
    toast('Review packet exported (.md)', 'success');
  });
  importInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = peerReview.importReview(text);
      const wrap = $('#review-display-wrap');
      wrap.style.display = '';
      $('#review-display').innerHTML = peerReview.renderReviewHTML(imported);
      toast('Peer review imported', 'success');
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
    } finally {
      importInput.value = '';
    }
  });
}

// Time-Travel Diff Mode — load a second version of a dataset and compare it to
// the active one: row-level add/remove/change (keyed on a detected/picked PK),
// distributional drift (layer-18 logic), and which validation layers flip.
function initTimeTravelDiff() {
  const fileInput = $('#diff-file-input');
  const runBtn = $('#btn-diff-run');
  if (!fileInput || !runBtn) return;
  let otherDs = null;

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const base = getActiveDataset();
    if (!base) { toast('Load a primary dataset first', 'error'); fileInput.value = ''; return; }
    try {
      await ensureDuckDB();
      otherDs = await loaders.loadFile(file);
      // loadFile makes the new file active; restore the original as the base.
      setActiveDataset(base.name);
      renderSidebar();
      $('#diff-loaded-note').textContent = `Comparison dataset: ${otherDs.name} (${otherDs.rowCount.toLocaleString()} rows). Base: ${base.name}.`;

      // Populate the key-column picker from columns common to both datasets.
      const shared = base.cols.map(c => c.name).filter(n => otherDs.cols.some(c => c.name === n));
      const picker = $('#diff-key-select');
      picker.innerHTML = '<option value="__auto">Auto-detect key</option>' + shared.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
      runBtn.disabled = false;
    } catch (err) {
      toast('Could not load comparison dataset: ' + err.message, 'error');
    } finally {
      fileInput.value = '';
    }
  });

  runBtn.addEventListener('click', async () => {
    const base = getActiveDataset();
    if (!base || !otherDs) { toast('Load both datasets first', 'error'); return; }
    const out = $('#diff-results');
    out.innerHTML = '<div class="skeleton" style="height:120px; border-radius:var(--radius-md);"></div>';
    try {
      const [aRes, bRes] = [
        await engine.runQuery(`SELECT * FROM ${base.table}`),
        await engine.runQuery(`SELECT * FROM ${otherDs.table}`),
      ];
      const shared = base.cols.map(c => c.name).filter(n => otherDs.cols.some(c => c.name === n));
      const picked = $('#diff-key-select').value;
      const keyCol = picked && picked !== '__auto' ? picked : timeTravel.detectKeyColumn(shared, aRes.rows);

      let rowDiff = null;
      if (keyCol) rowDiff = timeTravel.diffRows(aRes.rows, bRes.rows, keyCol);

      // Aggregate/distributional diff over shared numeric+categorical columns.
      const sharedCols = base.cols.filter(c => otherDs.cols.some(o => o.name === c.name));
      const distDiff = await timeTravel.diffDistributions(base.table, otherDs.table, sharedCols);

      // Which of the 18 layers flip between the two versions.
      const layersA = await validation.runAllLayers(base, { freshnessThresholdHours: state.settings.freshnessThresholdHours });
      const layersB = await validation.runAllLayers(otherDs, { freshnessThresholdHours: state.settings.freshnessThresholdHours });
      setActiveDataset(base.name);
      const flips = timeTravel.diffLayerStatuses(layersA, layersB);

      renderDiffResults(out, { keyCol, rowDiff, distDiff, flips });
    } catch (err) {
      out.innerHTML = '';
      toast('Diff failed: ' + err.message, 'error');
    }
  });
}

function renderDiffResults(out, { keyCol, rowDiff, distDiff, flips }) {
  out.innerHTML = '';
  const section = (title) => el('div', { class: 'sidebar-heading', style: 'margin:var(--space-4) 0 var(--space-2);' }, title);

  // Row-level.
  out.appendChild(section('Row-Level Changes'));
  if (!rowDiff) {
    out.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-faint);' }, 'No unique key column found — pick one above to enable row-level diffing.'));
  } else {
    out.appendChild(el('div', { style: 'font-size:var(--text-sm); margin-bottom:var(--space-2);' }, `Keyed on "${keyCol}". ${rowDiff.added.length} added · ${rowDiff.removed.length} removed · ${rowDiff.changed.length} changed · ${rowDiff.unchanged} unchanged.`));
    for (const ch of rowDiff.changed.slice(0, 10)) {
      out.appendChild(el('div', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted); padding:2px 0;' },
        `#${ch.key}: ` + ch.fields.map(f => `${f.column}: ${f.from} → ${f.to}`).join(', ')));
    }
  }

  // Distributional.
  out.appendChild(section('Distributional Drift (Layer 18 logic)'));
  if (!distDiff.drifts.length) {
    out.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-grade-a);' }, '✓ No column distributions shifted meaningfully between the two versions.'));
  } else {
    distDiff.drifts.forEach(d => out.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-grade-c); padding:2px 0;' }, d)));
  }

  // Layer flips.
  out.appendChild(section('Validation Layer Flips'));
  const flipped = flips.filter(f => f.passFailFlip);
  if (!flipped.length) {
    out.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-faint);' }, 'No layers flipped between PASS and FAIL.'));
  } else {
    flipped.forEach(f => {
      const def = validation.LAYER_DEFS.find(l => l.id === f.layer);
      const color = f.to === 'fail' ? 'var(--color-grade-d)' : 'var(--color-grade-a)';
      out.appendChild(el('div', { style: `font-size:var(--text-sm); color:${color}; padding:2px 0;`, 'data-testid': `diff-flip-${f.layer}` },
        `${def ? def.name : f.layer}: ${f.from.toUpperCase()} → ${f.to.toUpperCase()}`));
    });
  }
}

// ============================================================
// Feature 6 — Synthetic Adversarial Twin (DP synthetic dataset)
// ============================================================
function initSyntheticTwin() {
  const slider = $('#twin-epsilon-slider');
  const genBtn = $('#btn-twin-generate');
  const dlBtn = $('#btn-twin-download');
  if (!slider || !genBtn) return;
  let lastTwin = null;

  const refreshNote = () => {
    const eps = parseFloat(slider.value);
    $('#twin-epsilon-value').textContent = eps;
    $('#twin-epsilon-note').textContent = syntheticTwin.epsilonExplanation(eps);
  };
  slider.addEventListener('input', refreshNote);
  refreshNote();

  genBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    const out = $('#twin-results');
    out.innerHTML = '<div class="skeleton" style="height:100px; border-radius:var(--radius-md);"></div>';
    try {
      const { rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT 100000`);
      const twin = syntheticTwin.generateSyntheticTwin({ columns: ds.cols, rows, epsilon: parseFloat(slider.value) });
      lastTwin = twin;
      dlBtn.disabled = false;
      const disc = $('#twin-disclaimer');
      disc.style.display = 'block';
      disc.textContent = twin.disclaimer;
      out.innerHTML = '';
      out.appendChild(el('div', { style: 'font-size:var(--text-sm); margin-bottom:var(--space-2);', 'data-testid': 'twin-summary' },
        `Generated ${twin.rows.length} synthetic rows (ε=${twin.epsilon}, ${twin.mechanism}).`));
      twin.comparison.forEach(c => {
        let line;
        if (c.type === 'numeric') {
          line = `${c.column} (numeric): real mean ${c.real.mean} / synth ${c.synthetic.mean} · real std ${c.real.std} / synth ${c.synthetic.std}`;
        } else {
          const rt = c.real.top[0] ? c.real.top[0].value : '—';
          const st = c.synthetic.top[0] ? c.synthetic.top[0].value : '—';
          line = `${c.column} (categorical): real top "${rt}" / synth top "${st}"`;
        }
        out.appendChild(el('div', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted); padding:2px 0;', 'data-testid': `twin-cmp-${c.column}` }, line));
      });
      toast('Synthetic twin generated', 'success');
    } catch (err) {
      out.innerHTML = '';
      toast('Twin generation failed: ' + err.message, 'error');
    }
  });

  dlBtn.addEventListener('click', () => {
    if (!lastTwin) return;
    const ds = getActiveDataset();
    downloadText(`dataglow-synthetic-${ds ? ds.table : 'twin'}.csv`, syntheticTwin.toCSV(lastTwin.columns, lastTwin.rows), 'text/csv');
    toast('Synthetic CSV downloaded', 'success');
  });
}

// ============================================================
// Feature 7 — Data Time Machine (explicit snapshot ledger)
// ============================================================
function initTimeMachine() {
  const saveBtn = $('#btn-tm-save');
  const exportBtn = $('#btn-tm-export');
  if (!saveBtn) return;

  const render = async () => {
    const ds = getActiveDataset();
    const listEl = $('#tm-list');
    if (!ds) { listEl.innerHTML = '<span style="color:var(--color-text-faint);">Load a dataset to save snapshots.</span>'; return; }
    let snaps = [];
    try { snaps = await timeMachine.listSnapshots(ds.name || ds.table); } catch { /* IndexedDB unavailable */ }
    if (!snaps.length) { listEl.innerHTML = '<span style="color:var(--color-text-faint);">No snapshots yet for this dataset.</span>'; return; }
    listEl.innerHTML = '';
    snaps.forEach(s => {
      const row = el('div', { style: 'display:flex; align-items:center; justify-content:space-between; gap:var(--space-2); padding:var(--space-2) 0; border-bottom:1px solid var(--color-divider);', 'data-testid': `tm-snap-${s.hash}` }, [
        el('div', {}, [
          el('div', { style: 'font-size:var(--text-sm);' }, `${new Date(s.timestamp).toLocaleString()} — ${s.rowCount} rows`),
          el('div', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-faint);' }, `${s.hash} · ${s.diffSummary.text}`),
        ]),
        el('button', { class: 'btn btn-secondary', 'data-testid': `tm-load-${s.hash}`, onclick: () => loadSnapshot(s) }, 'Load into Diff'),
      ]);
      listEl.appendChild(row);
    });
  };

  const loadSnapshot = async (snap) => {
    if (!snap.rows) { toast('This snapshot did not embed its rows and cannot be reloaded.', 'error'); return; }
    const base = getActiveDataset();
    if (!base) return;
    const out = $('#diff-results');
    out.innerHTML = '<div class="skeleton" style="height:120px; border-radius:var(--radius-md);"></div>';
    try {
      const snapTable = `tm_snap_${snap.hash}`.slice(0, 60);
      await engine.createTableFromRows(snapTable, snap.columns, snap.rows);
      const aRes = await engine.runQuery(`SELECT * FROM ${base.table}`);
      const shared = base.cols.map(c => c.name).filter(n => snap.columns.includes(n));
      const keyCol = timeTravel.detectKeyColumn(shared, aRes.rows);
      const rowDiff = keyCol ? timeTravel.diffRows(snap.rows, aRes.rows, keyCol) : null;
      const sharedCols = base.cols.filter(c => snap.columns.includes(c.name));
      const distDiff = await timeTravel.diffDistributions(snapTable, base.table, sharedCols);
      renderDiffResults(out, { keyCol, rowDiff, distDiff, flips: [] });
      switchTab('diff');
      toast('Snapshot loaded into Diff view', 'success');
    } catch (err) {
      out.innerHTML = '';
      toast('Could not load snapshot: ' + err.message, 'error');
    }
  };

  saveBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    try {
      const quota = await timeMachine.checkStorageQuota();
      const noteEl = $('#tm-quota-note');
      if (quota.supported && quota.nearLimit) {
        noteEl.textContent = `Browser storage is ${(quota.ratio * 100).toFixed(0)}% full — export and prune older snapshots to an archive file to avoid losing data.`;
      } else {
        noteEl.textContent = '';
      }
      const { columns, rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT 100000`);
      const previous = await timeMachine.latestSnapshot(ds.name || ds.table);
      const snap = timeMachine.buildSnapshot({ datasetName: ds.name || ds.table, columns, rows, previous });
      await timeMachine.saveSnapshot(snap);
      await render();
      toast('Snapshot saved', 'success');
    } catch (err) {
      toast('Could not save snapshot: ' + err.message, 'error');
    }
  });

  if (exportBtn) exportBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    try {
      const snaps = await timeMachine.listSnapshots(ds.name || ds.table);
      if (!snaps.length) { toast('No snapshots to export', 'error'); return; }
      downloadText(`dataglow-timemachine-${ds.table}.json`, timeMachine.exportArchive(snaps), 'application/json');
      toast('Snapshot archive exported', 'success');
    } catch (err) {
      toast('Export failed: ' + err.message, 'error');
    }
  });

  render();
}

// ============================================================
// Feature 8 — Federated Fingerprinting (Experimental)
// ============================================================
function initFederatedFingerprint() {
  const exportBtn = $('#btn-fp-export');
  const fileA = $('#fp-file-a');
  const fileB = $('#fp-file-b');
  const compareBtn = $('#btn-fp-compare');
  if (!exportBtn) return;
  $('#fp-disclaimer').textContent = fingerprint.FINGERPRINT_DISCLAIMER;
  let fpA = null, fpB = null;

  exportBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    try {
      const { rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT 100000`);
      const fp = fingerprint.buildFingerprint({ datasetName: ds.name || ds.table, columns: ds.cols, rows });
      downloadText(`dataglow-fingerprint-${ds.table}.json`, JSON.stringify(fp, null, 2), 'application/json');
      toast('Fingerprint exported', 'success');
    } catch (err) {
      toast('Fingerprint export failed: ' + err.message, 'error');
    }
  });

  const readFp = (file, which) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const fp = fingerprint.parseFingerprint(reader.result);
        if (which === 'a') fpA = fp; else fpB = fp;
        $('#fp-loaded-note').textContent = `${fpA ? 'A: ' + fpA.datasetName : 'A: —'} · ${fpB ? 'B: ' + fpB.datasetName : 'B: —'}`;
        compareBtn.disabled = !(fpA && fpB);
      } catch (err) {
        toast('Not a valid fingerprint file: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  };
  fileA.addEventListener('change', e => { if (e.target.files[0]) readFp(e.target.files[0], 'a'); e.target.value = ''; });
  fileB.addEventListener('change', e => { if (e.target.files[0]) readFp(e.target.files[0], 'b'); e.target.value = ''; });

  compareBtn.addEventListener('click', () => {
    if (!fpA || !fpB) return;
    const out = $('#fp-results');
    out.innerHTML = '';
    try {
      const cmp = fingerprint.compareFingerprints(fpA, fpB);
      out.appendChild(el('div', { style: 'font-size:var(--text-sm); margin-bottom:var(--space-2);', 'data-testid': 'fp-compare-summary' },
        `${cmp.summary.meaningfullyDifferent} of ${cmp.summary.sharedColumns} shared column(s) differ meaningfully (JSD > ${cmp.threshold}).`));
      cmp.columns.forEach(c => {
        const color = c.meaningful ? 'var(--color-grade-c)' : 'var(--color-text-muted)';
        const jsdTxt = c.jsd != null ? `JSD ${c.jsd}` : (c.note || '—');
        out.appendChild(el('div', { style: `font-size:var(--text-xs); color:${color}; padding:2px 0;`, 'data-testid': `fp-col-${c.column}` },
          `${c.column} [${c.present}]: ${jsdTxt}${c.meaningful ? ' — meaningfully different' : ''}`));
      });
    } catch (err) {
      toast('Comparison failed: ' + err.message, 'error');
    }
  });
}

// ============================================================
// Feature 9 — IRB / Regulatory Language Auto-Translation Mode
// ============================================================
function initIRBMode() {
  const btn = $('#btn-export-irb');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    const results = window.__dataglowLastValidation;
    if (!ds || !results) { toast('Run all 18 layers first', 'error'); return; }
    try {
      const chain = provenance.getProvenance(ds.table);
      const provenanceTrail = chain ? chain.getTrail() : [];
      const provenanceVerification = chain && chain.length ? await chain.verify() : null;
      const model = irbMode.buildIRBDocument({
        datasetName: ds.name || ds.table,
        results,
        ledgerEntries: ledger.getLedgerEntries(),
        provenanceTrail,
        provenanceVerification,
        storyText: state.lastStory || null,
      });
      downloadText(`dataglow-irb-${ds.table}.html`, irbMode.renderIRBHTML(model), 'text/html');
      toast('IRB / compliance document exported', 'success');
    } catch (err) {
      toast('IRB export failed: ' + err.message, 'error');
    }
  });
}

// Top 5 Problems — a scannable pre-analysis checklist (checklist methodology
// popularized by Atul Gawande, "The Checklist Manifesto"). Surfaces the
// highest-severity findings across all layers with jump-links.
async function renderTopProblems(ds, results) {
  const wrap = $('#top-problems-wrap');
  const list = $('#top-problems-list');
  const sevRank = { fail: 3, warn: 2, pass: 0, idle: 0 };
  const problems = [];
  for (const layer of validation.LAYER_DEFS) {
    if (layer.id === 'confidence' || layer.id === 'red_team') continue;
    const r = results[layer.id];
    if (!r || !sevRank[r.status]) continue;
    problems.push({ id: layer.id, name: layer.name, status: r.status, summary: r.summary || layer.desc, sev: sevRank[r.status] });
  }
  problems.sort((a, b) => b.sev - a.sev);
  const top = problems.slice(0, 5);
  if (!top.length) {
    wrap.style.display = '';
    list.innerHTML = '<div style="font-size:var(--text-sm); color:var(--color-grade-a);">✓ No significant problems found across the validation layers.</div>';
    return;
  }
  wrap.style.display = '';
  list.innerHTML = '';
  top.forEach((p, i) => {
    const color = p.status === 'fail' ? 'var(--color-grade-d)' : 'var(--color-grade-c)';
    const row = el('div', { style: 'display:flex; align-items:flex-start; gap:var(--space-2); padding:6px 0; border-top:1px solid var(--color-divider); cursor:pointer;', 'data-testid': `top-problem-${p.id}` }, [
      el('span', { style: `margin-top:2px; width:12px; height:12px; border-radius:3px; flex:0 0 auto; background:${color};` }),
      el('div', {}, [
        el('div', { style: 'font-weight:600; font-size:var(--text-sm);' }, `${i + 1}. ${p.name}`),
        el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, p.summary),
      ]),
    ]);
    row.addEventListener('click', () => {
      const card = document.querySelector(`[data-testid="card-validation-${p.id}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    list.appendChild(row);
  });
}

// Data Health Dashboard: CAT scorecard + Golden Signals + materiality slider
// + optional per-entity baselines.
let __materialityIssues = null;
async function renderDataHealth(ds, results) {
  const wrap = $('#data-health-wrap');
  wrap.style.display = '';

  // Confidence-Calibrated Grades (two honest, heuristic axes). The combined
  // Overall grade is the headline signal; the Integrity/Domain breakdown sits
  // one tap away. The legacy CAT scorecard + confidence ring are de-prioritised
  // under the Advanced/Legacy disclosure (see index.html). Hover each card for
  // the plain-English reason.
  renderCalibratedGrades(results && results.calibratedGrades);

  // CAT scorecard (CDC Data Quality Framework) — now under Advanced/Legacy.
  const cat = await catScorecard.computeCATScore(ds, results).catch(() => null);
  const catEl = $('#cat-scorecard');
  catEl.innerHTML = '';
  if (cat) {
    const gradeColor = g => ({ A: 'var(--color-grade-a)', B: 'var(--color-grade-b)', C: 'var(--color-grade-c)', D: 'var(--color-grade-d)', F: 'var(--color-grade-d)' }[g] || 'var(--color-text-muted)');
    const cell = (name, g) => el('div', { style: 'text-align:center; min-width:80px;' }, [
      el('div', { style: `font-size:var(--text-2xl,28px); font-weight:700; color:${gradeColor(g.grade)};` }, g.grade),
      el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, name),
    ]);
    catEl.appendChild(cell('Overall', cat.overall));
    catEl.appendChild(cell('Completeness', cat.completeness));
    catEl.appendChild(cell('Accuracy', cat.accuracy));
    catEl.appendChild(cell('Timeliness', cat.timeliness));
  }

  // Golden Signals (Google SRE-inspired, mapped to data quality).
  const gs = await goldenSignals.computeGoldenSignals(ds, results).catch(() => null);
  const gsEl = $('#golden-signals');
  gsEl.innerHTML = '';
  if (gs) {
    const sig = (label, val) => el('div', { style: 'text-align:center; min-width:90px;' }, [
      el('div', { style: 'font-size:var(--text-lg); font-weight:600;' }, val),
      el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, label),
    ]);
    gsEl.appendChild(sig('Missingness', `${(gs.missingnessRate * 100).toFixed(1)}%`));
    gsEl.appendChild(sig('Out-of-range', `${(gs.outOfRangeRate * 100).toFixed(1)}%`));
    gsEl.appendChild(sig('Duplicates', `${(gs.duplicateRate * 100).toFixed(1)}%`));
    gsEl.appendChild(sig('Freshness', `${gs.freshnessHours.toFixed(1)}h`));
  }

  // Materiality slider — filters clean-issues by % of rows affected.
  __materialityIssues = await clean.scanForIssues(ds.table, ds.cols).catch(() => []);
  const slider = $('#materiality-slider');
  const updateMateriality = () => {
    const thr = parseFloat(slider.value);
    $('#materiality-value').textContent = thr.toFixed(1);
    const material = materiality.filterByMateriality(__materialityIssues, thr, ds.rowCount);
    $('#materiality-note').textContent =
      `${material.length} of ${__materialityIssues.length} detected issue(s) affect at least ${thr.toFixed(1)}% of rows (material). Issues below this threshold are treated as noise (PCAOB AS 2305).`;
  };
  slider.oninput = updateMateriality;
  updateMateriality();

  // Per-entity baselines (UEBA) if an ID-like + numeric column pair exists.
  await renderEntityBaselines(ds);
}

// Render the two-axis Confidence-Calibrated Grades with an explicit visual
// hierarchy so the three coexisting quality surfaces stop competing:
//   1. the combined "Overall" grade is the headline, single-glance signal;
//   2. the Data Integrity (mechanical well-formedness) and Domain Confidence
//      (real-world plausibility) breakdown sits one tap away, explaining the why.
// The legacy confidence ring and CAT scorecard live under the Advanced/Legacy
// disclosure in index.html. All axes are explicitly heuristics (labelled), not
// legal/clinical determinations.
function renderCalibratedGrades(cg) {
  const box = $('#calibrated-grades');
  const headline = $('#overall-headline');
  if (!box) return;
  if (!cg) {
    box.style.display = 'none'; box.innerHTML = '';
    if (headline) { headline.style.display = 'none'; headline.innerHTML = ''; }
    return;
  }
  const gradeColor = g => ({ A: 'var(--color-grade-a)', B: 'var(--color-grade-b)', C: 'var(--color-grade-c)', D: 'var(--color-grade-d)', F: 'var(--color-grade-d)' }[g] || 'var(--color-text-muted)');

  // PRIMARY: the Overall combined grade, rendered large as THE headline number.
  if (headline) {
    headline.innerHTML = '';
    if (cg.overall) {
      headline.appendChild(el('div', {
        style: 'display:flex; align-items:center; gap:var(--space-4); padding:var(--space-4) var(--space-5); border:1px solid var(--color-divider); border-radius:var(--radius-lg); background:var(--color-surface-offset,transparent); cursor:help;',
        title: cg.overall.explanation,
        'data-testid': 'grade-overall',
      }, [
        el('div', { style: `font-size:var(--text-4xl,56px); line-height:1; font-weight:800; color:${gradeColor(cg.overall.grade)};`, 'data-testid': 'grade-overall-grade' }, cg.overall.grade),
        el('div', {}, [
          el('div', { style: 'font-size:var(--text-lg); font-weight:700;' }, 'Overall Data Quality'),
          el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-top:2px;' }, cg.overall.explanation || 'Combined Integrity & Domain Confidence grade.'),
        ]),
      ]));
      headline.style.display = '';
    } else {
      headline.style.display = 'none';
    }
  }

  // SECONDARY: the two-axis breakdown behind the Overall grade.
  const card = (title, subtitle, axis, testid) => el('div', {
    style: 'flex:1; min-width:240px; padding:var(--space-4); border:1px solid var(--color-divider); border-radius:var(--radius-lg); cursor:help;',
    title: axis.explanation,
    'data-testid': testid,
  }, [
    el('div', { style: 'display:flex; align-items:baseline; gap:var(--space-3);' }, [
      el('div', { style: `font-size:var(--text-2xl,28px); font-weight:700; color:${gradeColor(axis.grade)};`, 'data-testid': `${testid}-grade` }, axis.grade),
      el('div', { style: 'font-weight:600;' }, title),
    ]),
    el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-top:var(--space-1); font-weight:500;' }, subtitle),
    el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint,var(--color-text-muted)); margin-top:var(--space-2);' }, axis.explanation),
  ]);
  box.innerHTML = '';
  box.appendChild(card(
    'Data Integrity',
    'How internally consistent and well-formed this data is.',
    cg.integrity, 'grade-integrity'));
  box.appendChild(card(
    'Domain Confidence',
    'How plausible this data is given real-world domain knowledge.',
    cg.plausibility, 'grade-plausibility'));
  box.style.display = 'flex';
}

async function renderEntityBaselines(ds) {
  const wrap = $('#entity-baseline-wrap');
  const list = $('#entity-baseline-list');
  const entityCol = ds.cols.find(c => c.type === 'VARCHAR' && /vendor|customer|account|entity|user|company|supplier|merchant|id|name/i.test(c.name));
  const valueCol = ds.cols.find(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type) && /amount|value|price|cost|total|revenue|salary|invoice|balance/i.test(c.name));
  if (!entityCol || !valueCol) { wrap.style.display = 'none'; return; }
  const baselines = await entityBaseline.computeEntityBaselines(ds.table, entityCol.name, valueCol.name, engine).catch(() => null);
  if (!baselines) { wrap.style.display = 'none'; return; }
  const flags = await entityBaseline.flagEntityDeviations(ds.table, entityCol.name, valueCol.name, baselines, engine).catch(() => []);
  if (!flags.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';
  list.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-bottom:var(--space-2);' },
    `Comparing "${valueCol.name}" against each "${entityCol.name}"'s own baseline.`));
  flags.slice(0, 15).forEach(f => {
    list.appendChild(el('div', { style: 'font-size:var(--text-sm); padding:4px 0; border-top:1px solid var(--color-divider);' }, [
      el('span', { style: 'font-weight:600;' }, `${f.entity}: `),
      el('span', {}, f.reason),
    ]));
  });
}

// Multivariate Outliers: diagonal-Mahalanobis (ondevice-ml) + Isolation Forest.
async function renderMultivariate(ds) {
  const wrap = $('#multivariate-wrap');
  const list = $('#multivariate-list');
  const numericCols = ds.cols.filter(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type));
  if (numericCols.length < 2) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';

  const maha = await ondeviceML.scoreMultivariateAnomalies(ds.table, numericCols, engine).catch(() => null);
  const iforest = await scoreIsolationForest(ds.table, numericCols, engine).catch(() => null);

  // Peer-group column for the on-device Anomaly Explainer: first low-cardinality
  // categorical (VARCHAR) column, so contributions read relative to a real peer
  // set (e.g. Geography) rather than the whole table.
  const groupColumn = await ondeviceML.pickPeerGroupColumn(ds.table, ds.cols, engine, { rowCount: ds.rowCount });

  const section = (title, cite, res) => {
    const block = el('div', { style: 'margin-bottom:var(--space-4);' });
    block.appendChild(el('div', { style: 'font-weight:600; font-size:var(--text-sm); margin-bottom:2px;' }, title));
    block.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-bottom:var(--space-2);' }, cite));
    if (!res || !res.rows || !res.rows.length) {
      block.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted);' }, 'No rows scored.'));
      return block;
    }
    const anomalies = res.rows.filter(r => r.isAnomaly);
    block.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-bottom:var(--space-2);' },
      `${anomalies.length} row(s) flagged as anomalous (top ${Math.min(5, res.rows.length)} shown by score).`));
    res.rows.slice(0, 5).forEach(r => {
      const color = r.isAnomaly ? 'var(--color-grade-d)' : 'var(--color-text-muted)';
      const rowEl = el('div', { style: 'font-size:var(--text-xs); padding:3px 0; border-top:1px solid var(--color-divider); display:flex; gap:var(--space-2); align-items:center;' }, [
        el('span', { style: `font-weight:600; color:${color};` }, `#${r.rowIndex} · ${r.anomalyScore}`),
        el('span', { class: 'mono', style: 'color:var(--color-text-muted); overflow:hidden; text-overflow:ellipsis; flex:1;' }, Object.entries(r.values).map(([k, v]) => `${k}=${v}`).join(', ')),
      ]);
      // On-Device Anomaly Explainer (Feature 4): explain WHY this row is flagged.
      const explainBtn = el('button', { class: 'btn', style: 'font-size:11px; padding:2px 8px; flex:none;', 'data-testid': `explain-anomaly-${r.rowIndex}` }, 'Explain');
      const reasonEl = el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin:2px 0 4px var(--space-3);' });
      explainBtn.addEventListener('click', async () => {
        explainBtn.disabled = true;
        try {
          const ex = await ondeviceML.explainAnomaly(ds.table, numericCols, r.rowIndex, engine, groupColumn ? { groupColumn } : {});
          reasonEl.setAttribute('data-testid', `anomaly-reason-${r.rowIndex}`);
          reasonEl.textContent = ex.reason;
        } catch (e) {
          reasonEl.textContent = 'Could not explain: ' + e.message;
        }
      });
      rowEl.appendChild(explainBtn);
      block.appendChild(rowEl);
      block.appendChild(reasonEl);
    });
    return block;
  };

  list.appendChild(section('Mahalanobis (diagonal approximation)', 'Mahalanobis (1936) — standardized distance from the centroid.', maha));
  list.appendChild(section('Isolation Forest', 'Liu, Ting & Zhou (2008) — anomalies isolate in shorter tree paths.', iforest));
}

// SPC control charts + Cpk badge per numeric column, rendered as inline SVG.
async function renderSPC(ds) {
  const wrap = $('#spc-wrap');
  const list = $('#spc-list');
  const analyses = await spc.analyzeAllNumericSPC(ds.table, ds.cols, engine).catch(() => []);
  if (!analyses.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';
  for (const a of analyses) {
    const card = el('div', { class: 'card', style: 'padding:var(--space-3); margin-bottom:var(--space-3);', 'data-testid': `spc-${a.column}` });
    const cpkText = a.cpk.cpk == null ? 'n/a' : a.cpk.cpk.toString();
    const cpkColor = a.cpk.cpk == null ? 'var(--color-text-muted)' : a.cpk.cpk >= 1.33 ? 'var(--color-grade-a)' : a.cpk.cpk >= 1.0 ? 'var(--color-grade-c)' : 'var(--color-grade-d)';
    card.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); margin-bottom:var(--space-2);' }, [
      el('span', { style: 'font-weight:600;' }, `"${a.column}"`),
      el('span', { style: `font-size:11px; padding:1px 6px; border-radius:8px; background:${cpkColor}; color:#fff;`, title: a.cpk.inferredSpec ? 'Spec limits inferred from data spread' : 'From supplied spec limits' }, `Cpk ${cpkText}`),
      el('span', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, `${a.outOfControl} point(s) out of control · n=${a.limits.n}`),
    ]));
    card.appendChild(el('div', { html: spcSvg(a) }));
    list.appendChild(card);
  }
}

// Minimal inline SVG control chart (no chart dependency).
function spcSvg(a) {
  const w = 640, h = 140, pad = 4;
  const vals = a.values;
  const { mean, ucl, lcl } = a.limits;
  const lo = Math.min(lcl, ...vals), hi = Math.max(ucl, ...vals);
  const span = (hi - lo) || 1;
  const x = i => pad + (i / Math.max(1, vals.length - 1)) * (w - 2 * pad);
  const y = v => h - pad - ((v - lo) / span) * (h - 2 * pad);
  const line = (yv, color, dash) => `<line x1="${pad}" y1="${y(yv).toFixed(1)}" x2="${w - pad}" y2="${y(yv).toFixed(1)}" stroke="${color}" stroke-width="1" ${dash ? 'stroke-dasharray="4 3"' : ''}/>`;
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const dots = vals.map((v, i) => {
    const out = v > ucl || v < lcl;
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${out ? 3 : 1.8}" fill="${out ? 'var(--color-grade-d)' : 'var(--color-accent, #FF6B6B)'}"/>`;
  }).join('');
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="background:var(--color-surface-offset); border-radius:var(--radius-sm);">
    ${line(ucl, 'var(--color-grade-d)', true)}
    ${line(mean, 'var(--color-text-muted)', false)}
    ${line(lcl, 'var(--color-grade-d)', true)}
    <polyline points="${pts}" fill="none" stroke="var(--color-accent, #FF6B6B)" stroke-width="1.2"/>
    ${dots}
  </svg>`;
}

// Persist a small column profile per validation run (local memory only).
async function persistColumnProfiles(ds, results) {
  try {
    await memoryStore.initMemoryStore();
    for (const c of ds.cols) {
      await memoryStore.saveColumnProfile({
        columnNameHash: `${ds.table}::${c.name}`,
        table: ds.table,
        column: c.name,
        type: c.type,
        rowCount: ds.rowCount,
      });
    }
    await refreshMemoryPanel();
  } catch (e) { /* IndexedDB unavailable — non-fatal */ }
}

// ============================================================
// Local Memory Panel (Settings)
// ============================================================
async function refreshMemoryPanel() {
  const statsEl = $('#memory-stats');
  if (!statsEl) return;
  try {
    await memoryStore.initMemoryStore();
    const rules = await memoryStore.getApprovedRules();
    statsEl.textContent = `${rules.length} approved rule(s) stored locally.`;
  } catch (e) {
    statsEl.textContent = 'Local memory unavailable in this browser.';
  }
}

// Consent for cross-session fingerprint persistence is a single boolean UI
// preference (not user data), so it lives in localStorage; the fingerprints
// themselves stay in IndexedDB (js/memory-store.js).
const FP_CONSENT_KEY = 'dataglow_persist_fingerprints';

async function refreshFingerprintStats() {
  const el = $('#fingerprint-stats');
  if (!el) return;
  if (!state.settings.persistFingerprints) {
    el.textContent = 'Persistence off — fingerprints are compared only within the current session.';
    return;
  }
  try {
    const n = await memoryStore.countBaselines();
    el.textContent = `${n} schema fingerprint(s) stored locally on this device.`;
  } catch (e) {
    el.textContent = 'Local storage unavailable in this browser.';
  }
}

function initMemory() {
  memoryStore.initMemoryStore().then(refreshMemoryPanel).catch(() => {
    const el0 = $('#memory-stats');
    if (el0) el0.textContent = 'Local memory unavailable in this browser.';
  });
  $('#btn-memory-clear').addEventListener('click', async () => {
    if (!confirm('Clear all locally stored column profiles, baselines, and approved rules? This cannot be undone.')) return;
    try {
      const rules = await memoryStore.getApprovedRules();
      for (const r of rules) await memoryStore.deleteApprovedRule(r.ruleName);
      // Column profiles/baselines: drop the whole database for a clean slate.
      if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase('dataglow_memory');
      toast('Local memory cleared', 'success');
      $('#memory-stats').textContent = '0 approved rule(s) stored locally.';
      refreshFingerprintStats();
    } catch (e) {
      toast('Clear failed: ' + e.message, 'error');
    }
  });

  // ---- Distribution Fingerprint Drift: opt-in persistence ----
  const toggle = $('#toggle-persist-fingerprints');
  if (toggle) {
    state.settings.persistFingerprints = localStorage.getItem(FP_CONSENT_KEY) === '1';
    toggle.checked = state.settings.persistFingerprints;
    toggle.addEventListener('change', () => {
      state.settings.persistFingerprints = toggle.checked;
      localStorage.setItem(FP_CONSENT_KEY, toggle.checked ? '1' : '0');
      toast(toggle.checked
        ? 'Fingerprint persistence enabled — only summary stats are stored locally.'
        : 'Fingerprint persistence disabled.', 'success');
      refreshFingerprintStats();
    });
  }
  $('#btn-clear-fingerprints').addEventListener('click', async () => {
    if (!confirm('Clear all stored distribution fingerprints from this device? This cannot be undone.')) return;
    try {
      await memoryStore.clearBaselines();
      toast('Stored fingerprints cleared', 'success');
    } catch (e) {
      toast('Clear failed: ' + e.message, 'error');
    }
    refreshFingerprintStats();
  });
  refreshFingerprintStats();
}

// ============================================================
// Anonymized Export (Differential Privacy)
// ============================================================
function initAnonExport() {
  const slider = $('#anon-epsilon-slider');
  slider.addEventListener('input', () => { $('#anon-epsilon-value').textContent = parseFloat(slider.value).toFixed(1); });
  $('#btn-anon-export').addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    const epsilon = parseFloat(slider.value);
    const addNoise = $('#anon-noise-toggle').checked;
    const noteEl = $('#anon-note');
    try {
      const { columns, rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT 100000`);
      const numericCols = ds.cols.filter(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type)).map(c => c.name);
      const esc = v => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [columns.join(',')];
      for (const r of rows) {
        lines.push(columns.map(c => {
          let v = r[c];
          if (addNoise && numericCols.includes(c) && typeof v === 'number' && Number.isFinite(v)) {
            v = privacyBudget.addPrivacyBudgetNoise(v, 1, epsilon);
            v = Number(v.toFixed(4));
          }
          return esc(v);
        }).join(','));
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dataglow-${ds.table}-${addNoise ? `anon-eps${epsilon}` : 'export'}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      noteEl.textContent = addNoise
        ? `Exported ${rows.length} rows with Laplace noise (ε=${epsilon}) added to ${numericCols.length} numeric column(s).`
        : `Exported ${rows.length} rows (no noise — enable the toggle for differential privacy).`;
      toast('Export ready', 'success');
    } catch (e) {
      toast('Export failed: ' + e.message, 'error');
    }
  });
}

function renderValidationResults(results) {
  const grid = $('#validation-grid');
  grid.innerHTML = '';
  for (const layer of validation.LAYER_DEFS) {
    if (layer.id === 'confidence') {
      renderConfidenceSummary(results.confidence);
      continue;
    }
    if (layer.id === 'red_team') continue; // rendered via modal
    const r = results[layer.id] || { status: 'idle', summary: 'Not run' };
    const card = el('div', { class: 'card validation-card', 'data-testid': `card-validation-${layer.id}` }, [
      el('div', { class: 'validation-card-head' }, [
        el('span', { class: 'validation-card-name' }, layer.name),
        el('span', { class: `validation-status ${r.status}` }, [el('span', { class: `status-dot ${r.status}` }), r.status.toUpperCase()]),
      ]),
      el('div', { class: 'validation-card-desc' }, layer.desc),
      el('div', { style: 'font-size:var(--text-sm); margin-top:var(--space-1);' }, r.summary),
    ]);
    if (r.detail && Array.isArray(r.detail)) {
      const detailList = el('ul', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); padding-left:var(--space-4); margin-top:var(--space-1);' });
      r.detail.slice(0, 5).forEach(d => detailList.appendChild(el('li', {}, d)));
      card.appendChild(detailList);
    }
    // Explainable Benford Gate (Feature 6): when the eligibility gate skips a
    // column, show a plain-language "why" note so the skip teaches rather than
    // silently passing. Skipped columns are grouped by their cause (bounded
    // range, too few rows, too narrow a range, binary flag) and each group is
    // shown under the teaching paragraph that explains THAT specific reason.
    if (layer.id === 'benford' && Array.isArray(r.skips) && r.skips.length) {
      const details = el('details', { style: 'margin-top:var(--space-2); font-size:var(--text-xs);', 'data-testid': 'benford-teaching' });
      details.appendChild(el('summary', { style: 'cursor:pointer; color:var(--color-text-muted);' }, `Why ${r.skips.length} column(s) were skipped`));
      for (const group of validation.benfordTeachingGroups(r.skips)) {
        if (group.teaching) details.appendChild(el('div', { style: 'color:var(--color-text-muted); margin:var(--space-2) 0;', 'data-testid': `benford-teaching-${group.cause}` }, group.teaching));
        const ul = el('ul', { style: 'color:var(--color-text-muted); padding-left:var(--space-4); margin:0;' });
        group.skips.slice(0, 8).forEach(s => ul.appendChild(el('li', {}, s)));
        details.appendChild(ul);
      }
      card.appendChild(details);
    }
    // Categorical Consistency Engine: offer a one-click canonical merge per
    // cluster, reusing the same UPDATE mechanism as the Clean tab's fuzzy dedup.
    if (layer.id === 'categorical_consistency' && Array.isArray(r.clusters) && r.clusters.length) {
      const ds = getActiveDataset();
      for (const cl of r.clusters.slice(0, 10)) {
        const clRow = el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap; margin-top:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': `cat-cluster-${layer.id}-${cl.column}` }, [
          el('span', { class: 'mono', style: 'font-size:var(--text-xs);' }, `${cl.merges.map(m => `"${m.from}"`).join(', ')} → "${cl.canonical}"`),
        ]);
        // Sensitive demographic/payer columns: never offer an auto-merge —
        // textually similar values may be legally/clinically distinct.
        if (cl.sensitive) {
          clRow.appendChild(el('span', {
            style: 'font-size:var(--text-xs); font-weight:600; padding:3px 8px; border-radius:6px; color:#fff; background:var(--color-grade-c); margin-left:auto;',
            'data-testid': `cat-sensitive-badge-${cl.column}`,
            title: 'These values may be legally/clinically distinct even if textually similar.',
          }, 'Sensitive category — merges disabled'));
          card.appendChild(clRow);
          continue;
        }
        // The suggested canonical is editable: the analyst can accept it as-is,
        // type a different spelling (even one not among the variants), or reject
        // the whole cluster. Nothing is applied until "Apply Merge" is clicked.
        const canonInput = el('input', {
          type: 'text', value: cl.canonical, class: 'mono',
          style: 'font-size:var(--text-xs); padding:4px 8px; border:1px solid var(--color-divider); border-radius:6px; background:var(--color-surface); color:var(--color-text); min-width:140px; margin-left:auto;',
          'data-testid': `input-cat-canonical-${cl.column}`,
          title: 'Edit the canonical value all variants will be merged into.',
        });
        const mergeBtn = el('button', { class: 'btn btn-primary', style: 'font-size:var(--text-xs); padding:5px 10px;', 'data-testid': `button-cat-merge-${cl.column}` }, 'Apply Merge');
        const rejectBtn = el('button', { class: 'btn btn-ghost', style: 'font-size:var(--text-xs); padding:5px 10px;', 'data-testid': `button-cat-reject-${cl.column}` }, 'Reject');
        mergeBtn.addEventListener('click', async () => {
          const chosen = String(canonInput.value).trim();
          if (!chosen) { toast('Canonical value cannot be empty', 'error'); return; }
          // Recompute the merge mapping against the (possibly edited) canonical.
          const applied = withCanonical(cl, chosen);
          if (!applied.merges.length) { toast('Nothing to merge into that value', 'error'); return; }
          mergeBtn.disabled = true; rejectBtn.disabled = true;
          try {
            const col = `"${cl.column}"`;
            const to = String(applied.canonical).replace(/'/g, "''");
            for (const m of applied.merges) {
              const from = String(m.from).replace(/'/g, "''");
              await engine.runQuery(`UPDATE ${ds.table} SET ${col} = '${to}' WHERE ${col} = '${from}'`);
            }
            const edited = applied.canonical !== cl.canonical ? ' (canonical edited by user)' : '';
            ledger.logAssumption('Categorical Consistency Engine',
              `Applied merge: ${applied.merges.map(m => `"${m.from}"`).join(', ')} → "${applied.canonical}" in "${cl.column}"${edited}.`);
            await provenance.recordStep(ds.table, 'merge',
              `Categorical merge: ${applied.merges.map(m => `"${m.from}"`).join(', ')} → "${applied.canonical}" in "${cl.column}"${edited}.`, { column: cl.column, canonical: applied.canonical, edited: applied.canonical !== cl.canonical });
            renderAssumptionLedger();
            renderProvenanceTrail();
            clRow.style.opacity = '0.4'; clRow.style.pointerEvents = 'none';
            toast(`Merged into "${applied.canonical}"`, 'success');
          } catch (e) {
            mergeBtn.disabled = false; rejectBtn.disabled = false;
            toast('Merge failed: ' + e.message, 'error');
          }
        });
        rejectBtn.addEventListener('click', () => {
          // Explicit rejection is a decision too — record it in the audit trail
          // so a skipped merge is visible rather than silently forgotten.
          ledger.logAssumption('Categorical Consistency Engine',
            `Rejected suggested merge for "${cl.column}" (${cl.variants.map(v => `"${v.value}"`).join(', ')}) — values kept distinct.`,
            { column: cl.column, rejected: true, variants: cl.variants });
          renderAssumptionLedger();
          clRow.style.opacity = '0.4'; clRow.style.pointerEvents = 'none';
          toast('Suggestion rejected', 'success');
        });
        clRow.appendChild(canonInput);
        clRow.appendChild(mergeBtn);
        clRow.appendChild(rejectBtn);
        card.appendChild(clRow);
      }
    }
    // Cross-Column Logical Consistency: show each contradiction with the exact
    // rule, the columns involved, and a plain-language reason. The analyst can
    // dismiss a flag they judge acceptable — the dismissal is written to the
    // Assumption Ledger and Provenance Trail, same as a categorical reject.
    if (layer.id === 'cross_column_logic' && Array.isArray(r.findings) && r.findings.length) {
      const ds = getActiveDataset();
      for (const f of r.findings) {
        const fRow = el('div', { style: 'margin-top:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': `xcol-finding-${f.rule}` }, [
          el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap;' }, [
            el('span', { style: 'font-size:var(--text-xs); font-weight:600; padding:2px 8px; border-radius:6px; color:#fff; background:var(--color-grade-d);' }, f.ruleLabel),
            el('span', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, f.columns.map(c => `"${c}"`).join(' × ')),
            el('button', { class: 'btn btn-ghost', style: 'font-size:var(--text-xs); padding:4px 9px; margin-left:auto;', 'data-testid': `button-xcol-dismiss-${f.rule}` }, 'Dismiss'),
          ]),
          el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1);' }, f.explanation),
        ]);
        const dismissBtn = fRow.querySelector('button');
        dismissBtn.addEventListener('click', async () => {
          ledger.logAssumption('Cross-Column Logical Consistency',
            `Analyst dismissed ${f.count} flagged row(s) for "${f.ruleLabel}" on ${f.columns.map(c => `"${c}"`).join(', ')} — accepted as valid.`,
            { rule: f.rule, columns: f.columns, count: f.count, dismissed: true });
          if (ds) await provenance.recordStep(ds.table, 'validate',
            `Dismissed cross-column flag: ${f.ruleLabel} on ${f.columns.map(c => `"${c}"`).join(', ')}.`, { rule: f.rule, columns: f.columns, dismissed: true });
          renderAssumptionLedger();
          renderProvenanceTrail();
          fRow.style.opacity = '0.4'; fRow.style.pointerEvents = 'none';
          toast('Flag dismissed and recorded in the audit trail', 'success');
        });
        card.appendChild(fRow);
      }
    }
    // Physiological Plausibility: show the per-finding "why it's implausible"
    // explanation and ALWAYS surface the visible, non-clinical disclaimer so it
    // travels with the results wherever this card is shown.
    if (layer.id === 'physiological_plausibility') {
      if (r.checkedLabel) {
        card.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1);', 'data-testid': 'physio-checked' }, `Columns checked: ${r.checkedLabel}`));
      }
      if (Array.isArray(r.findings) && r.findings.length) {
        for (const f of r.findings) {
          card.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': `physio-finding-${f.vital}` }, [
            el('div', { style: 'font-weight:600;' }, f.columns ? f.columns.map(c => `"${c}"`).join(' × ') : `"${f.column}"`),
            el('div', {}, f.explanation),
          ]));
        }
      }
      if (r.disclaimer) {
        card.appendChild(el('div', {
          'data-testid': 'physio-disclaimer',
          style: 'margin-top:var(--space-2); padding:var(--space-2); border-left:3px solid var(--color-grade-c); background:rgba(255,180,0,0.08); font-size:var(--text-xs); color:var(--color-text-muted); border-radius:6px;',
        }, r.disclaimer));
      }
    }
    // Upper-Bound Sanity Anchor: show which bounded columns were checked, a
    // per-column plain-language "why it's impossible by definition" explanation,
    // and the conservative-scope note. Each flag can be dismissed — the
    // dismissal is written to the Assumption Ledger and Provenance Trail, exactly
    // like a Cross-Column flag.
    if (layer.id === 'upper_bound_sanity') {
      if (r.checkedLabel) {
        card.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1);', 'data-testid': 'upperbound-checked' }, `Columns checked: ${r.checkedLabel}`));
      }
      if (Array.isArray(r.findings) && r.findings.length) {
        const ds = getActiveDataset();
        for (const f of r.findings) {
          const fRow = el('div', { style: 'margin-top:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': `upperbound-finding-${f.column}` }, [
            el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap;' }, [
              el('span', { style: 'font-size:var(--text-xs); font-weight:600; padding:2px 8px; border-radius:6px; color:#fff; background:var(--color-grade-c);' }, `${f.category} ${f.low}–${f.high}`),
              el('span', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, `"${f.column}"`),
              el('button', { class: 'btn btn-ghost', style: 'font-size:var(--text-xs); padding:4px 9px; margin-left:auto;', 'data-testid': `button-upperbound-dismiss-${f.column}` }, 'Dismiss'),
            ]),
            el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1);' }, f.explanation),
          ]);
          const dismissBtn = fRow.querySelector('button');
          dismissBtn.addEventListener('click', async () => {
            ledger.logAssumption('Upper-Bound Sanity Anchor',
              `Analyst dismissed ${f.count} out-of-bound value(s) in "${f.column}" (${f.category} ${f.low}–${f.high}) — accepted as valid.`,
              { column: f.column, category: f.category, count: f.count, dismissed: true });
            if (ds) await provenance.recordStep(ds.table, 'validate',
              `Dismissed upper-bound flag on "${f.column}" (${f.category} ${f.low}–${f.high}).`, { column: f.column, dismissed: true });
            renderAssumptionLedger();
            renderProvenanceTrail();
            fRow.style.opacity = '0.4'; fRow.style.pointerEvents = 'none';
            toast('Flag dismissed and recorded in the audit trail', 'success');
          });
          card.appendChild(fRow);
        }
      }
      if (r.note) {
        card.appendChild(el('div', {
          'data-testid': 'upperbound-note',
          style: 'margin-top:var(--space-2); padding:var(--space-2); border-left:3px solid var(--color-grade-c); background:rgba(255,180,0,0.08); font-size:var(--text-xs); color:var(--color-text-muted); border-radius:6px;',
        }, r.note));
      }
    }
    // Missingness Detective: for each analysed column show its MCAR/MAR/MNAR
    // classification badge, the plain-language narrative (with the driver column
    // named + effect size for MAR), the "why it matters for analysis" note, and
    // any conservative — clearly labelled — MNAR hypothesis. Closes with the
    // taxonomy note explaining what the classifications do and don't prove.
    if (layer.id === 'missingness_detective') {
      if (r.checkedLabel) {
        card.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1);', 'data-testid': 'missingness-checked' }, `Columns analysed: ${r.checkedLabel}`));
      }
      if (Array.isArray(r.findings) && r.findings.length) {
        const badgeColor = (f) => f.classification === 'MAR' ? 'var(--color-grade-c)' : 'var(--color-grade-a)';
        for (const f of r.findings) {
          const fRow = el('div', { style: 'margin-top:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': `missingness-finding-${f.column}` }, [
            el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap;' }, [
              el('span', { style: `font-size:var(--text-xs); font-weight:600; padding:2px 8px; border-radius:6px; color:#fff; background:${badgeColor(f)};` }, f.classification === 'MAR' ? 'Likely MAR' : 'MCAR (no driver)'),
              el('span', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, `"${f.column}" — ${f.missingRate}% missing`),
              ...(f.mnarCaution ? [el('span', { style: 'font-size:var(--text-xs); font-weight:600; padding:2px 8px; border-radius:6px; color:#fff; background:var(--color-grade-d);', 'data-testid': `missingness-mnar-${f.column}` }, 'MNAR risk?')] : []),
            ]),
            el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1);' }, f.narrative),
            el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1); font-style:italic;' }, f.why),
          ]);
          if (f.mnarNote) {
            fRow.appendChild(el('div', {
              style: 'margin-top:var(--space-2); padding:var(--space-2); border-left:3px solid var(--color-grade-d); background:rgba(220,80,80,0.08); font-size:var(--text-xs); color:var(--color-text-muted); border-radius:6px;',
            }, f.mnarNote));
          }
          card.appendChild(fRow);
        }
      }
      if (r.note) {
        card.appendChild(el('div', {
          'data-testid': 'missingness-note',
          style: 'margin-top:var(--space-2); padding:var(--space-2); border-left:3px solid var(--color-grade-c); background:rgba(255,180,0,0.08); font-size:var(--text-xs); color:var(--color-text-muted); border-radius:6px;',
        }, r.note));
      }
    }
    grid.appendChild(card);
  }
}

function renderConfidenceSummary(c) {
  if (!c) return;
  $('#confidence-summary').style.display = '';
  $('#confidence-score').textContent = c.score;
  $('#confidence-grade-label').textContent = `Grade ${c.grade}`;
  const gradeColors = { A: 'var(--color-grade-a)', B: 'var(--color-grade-b)', C: 'var(--color-grade-c)', D: 'var(--color-grade-d)' };
  $('#confidence-ring-arc').setAttribute('stroke', gradeColors[c.grade]);
  $('#confidence-grade-label').style.color = gradeColors[c.grade];
  const circumference = 264;
  $('#confidence-ring-arc').setAttribute('stroke-dashoffset', String(circumference * (1 - c.score / 100)));
  $('#confidence-verdict').textContent = c.verdict;
  $('#confidence-verdict').style.color = c.status === 'pass' ? 'var(--color-grade-a)' : c.status === 'warn' ? 'var(--color-grade-c)' : 'var(--color-grade-d)';
  $('#confidence-detail').textContent = `Score computed from 6 signals: sample coverage, null rate, variance, subsample stability, sample size, and anomaly concentration.`;
  const signalsEl = $('#confidence-signals');
  signalsEl.innerHTML = '';
  for (const [label, val] of Object.entries(c.signals)) {
    signalsEl.appendChild(el('div', { style: 'text-align:center;' }, [
      el('div', { style: 'font-size:var(--text-lg); font-weight:600;' }, `${val}`),
      el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); max-width:80px;' }, label),
    ]));
  }
}

// ============================================================
// Red Team Mode
// ============================================================
function initRedTeam() {
  $('#btn-red-team').addEventListener('click', () => $('#redteam-modal').classList.add('open'));
  $('#btn-redteam-close').addEventListener('click', () => $('#redteam-modal').classList.remove('open'));
  $('#btn-redteam-run').addEventListener('click', async () => {
    const resultsEl = $('#redteam-results');
    resultsEl.innerHTML = '<div class="skeleton" style="height:100px; border-radius:var(--radius-md);"></div>';
    await ensureDuckDB();
    const ds = await loaders.loadGoldenDataset();
    renderSidebar();
    resetPanelStates();
    const results = await validation.runAllLayers(ds, { freshnessThresholdHours: state.settings.freshnessThresholdHours });
    const expected = validation.getExpectedGoldenFindings();

    const checks = [
      { layer: 'unit_tests', label: 'Unit Test Layer', pass: results.unit_tests.status === 'fail' },
      { layer: 'semantic_drift', label: 'Semantic Drift Detector', pass: results.semantic_drift.status === 'fail' },
      { layer: 'sanity_anchor', label: 'Sanity Anchor', pass: results.sanity_anchor.status === 'pass' },
      { layer: 'schema_fingerprint', label: 'Schema Fingerprint', pass: results.schema_fingerprint.status === 'pass' },
      { layer: 'confidence', label: 'Confidence Layer', pass: results.confidence.score < 80 },
    ];
    const allPassed = checks.every(c => c.pass);

    resultsEl.innerHTML = '';
    resultsEl.appendChild(el('div', { class: 'card', style: `padding:var(--space-4); margin-bottom:var(--space-3); border-color:${allPassed ? 'var(--color-grade-a)' : 'var(--color-grade-d)'};` }, [
      el('div', { style: `font-weight:600; color:${allPassed ? 'var(--color-grade-a)' : 'var(--color-grade-d)'};` }, allPassed ? 'Self-attack test PASSED — validation layers are catching real issues.' : 'Self-attack test FAILED — one or more layers missed a known issue.'),
    ]));
    for (const c of checks) {
      resultsEl.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) 0; border-bottom:1px solid var(--color-divider); font-size:var(--text-sm);' }, [
        el('span', { class: `status-dot ${c.pass ? 'pass' : 'fail'}` }),
        el('span', {}, c.label),
        el('span', { style: 'margin-left:auto; color:var(--color-text-faint); font-size:var(--text-xs);' }, c.pass ? 'caught it' : 'missed it'),
      ]));
    }
    switchTab('validate');
    renderValidationResults(results);
    $('#redteam-modal').classList.remove('open');
    toast(allPassed ? 'Red Team self-test passed' : 'Red Team self-test found a gap', allPassed ? 'success' : 'error');
  });

  // Red Team Mode v2 (Feature 5): synthesize a fresh adversarial dataset that
  // matches the ACTIVE dataset's schema, load it, run all layers, and report
  // which seeded issue categories the validation stack caught.
  const v2Btn = $('#btn-redteam-v2');
  if (v2Btn) v2Btn.addEventListener('click', async () => {
    const resultsEl = $('#redteam-results');
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first to model its schema', 'error'); return; }
    resultsEl.innerHTML = '<div class="skeleton" style="height:100px; border-radius:var(--radius-md);"></div>';
    await ensureDuckDB();
    const gen = syntheticAdversarial.generateAdversarialDataset(ds.cols);
    const tableName = `redteam_v2_${ds.table}`.slice(0, 60);
    await engine.createTableFromRows(tableName, gen.columns, gen.rows);
    const synthDs = {
      name: `${tableName}.synthetic`, table: tableName, rowCount: gen.rows.length,
      cols: (await engine.getTableSchema(tableName)).map(s => ({ name: s.column_name, type: s.column_type })),
      loadedAt: Date.now(), isSynthetic: true,
    };
    addDataset(synthDs);
    renderSidebar();
    const results = await validation.runAllLayers(synthDs, { freshnessThresholdHours: state.settings.freshnessThresholdHours });

    // Map each seeded issue category to the layer(s) expected to catch it.
    const CATEGORY_LAYERS = {
      categorical_variants: ['categorical_consistency'],
      cross_column_dates: ['cross_column_logic'],
      cross_column_age: ['cross_column_logic'],
      cross_column_numeric: ['cross_column_logic'],
      duplicates: ['unit_tests'],
      nulls: ['unit_tests'],
      semantic_outlier: ['semantic_drift', 'outlier_detection', 'sanity_anchor', 'unit_tests'],
      future_date: ['freshness', 'unit_tests'],
      negative_magnitude: ['outlier_detection', 'unit_tests'],
    };
    const seededKeys = Object.keys(gen.seeded || {});
    const checks = seededKeys.map(cat => {
      const layers = CATEGORY_LAYERS[cat] || [];
      const caught = layers.some(lid => results[lid] && (results[lid].status === 'fail' || results[lid].status === 'warn'));
      return { cat, caught, layers };
    });
    const caughtCount = checks.filter(c => c.caught).length;

    resultsEl.innerHTML = '';
    resultsEl.appendChild(el('div', { class: 'card', style: `padding:var(--space-4); margin-bottom:var(--space-3); border-color:${caughtCount === checks.length ? 'var(--color-grade-a)' : 'var(--color-grade-c)'};`, 'data-testid': 'redteam-v2-verdict' }, [
      el('div', { style: 'font-weight:600;' }, `Red Team v2 — synthesized ${gen.rows.length} rows matching "${ds.name}" schema; caught ${caughtCount}/${checks.length} seeded issue categories.`),
    ]));
    for (const c of checks) {
      resultsEl.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) 0; border-bottom:1px solid var(--color-divider); font-size:var(--text-sm);', 'data-testid': `redteam-v2-cat-${c.cat}` }, [
        el('span', { class: `status-dot ${c.caught ? 'pass' : 'fail'}` }),
        el('span', {}, c.cat.replace(/_/g, ' ')),
        el('span', { style: 'margin-left:auto; color:var(--color-text-faint); font-size:var(--text-xs);' }, c.caught ? 'caught it' : 'missed it'),
      ]));
    }
    switchTab('validate');
    renderValidationResults(results);
    $('#redteam-modal').classList.remove('open');
    toast(`Red Team v2 caught ${caughtCount}/${checks.length} categories`, caughtCount === checks.length ? 'success' : 'error');
  });
}

// ============================================================
// Visualize Tab
// ============================================================
function populateVisualizeBuilder() {
  const ds = getActiveDataset();
  if (!ds) return;
  $('#visualize-builder').style.display = '';
  const xSel = $('#viz-x'), ySel = $('#viz-y');
  xSel.innerHTML = ds.cols.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  ySel.innerHTML = ds.cols.filter(c => ['DOUBLE','BIGINT','INTEGER','HUGEINT','FLOAT'].includes(c.type)).map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
}

function initVisualizeTab() {
  $('#viz-chart-type').addEventListener('change', () => {
    const type = $('#viz-chart-type').value;
    $('#viz-y-wrap').style.display = ['pie', 'histogram', 'box'].includes(type) ? 'none' : '';
  });
  $('#btn-viz-generate').addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    const type = $('#viz-chart-type').value;
    const x = $('#viz-x').value;
    const y = $('#viz-y').value;
    try {
      await viz.renderChart('viz-chart', ds.table, type, x, y);
    } catch (err) {
      toast('Chart error: ' + err.message, 'error');
    }
  });
  $('#btn-viz-export').addEventListener('click', () => viz.exportChartPNG('viz-chart', `dataglow-${getActiveDataset()?.table || 'chart'}`));
}

// ============================================================
// Story Tab
// ============================================================
function updateStoryBadgePreview() {
  const badge = $('#story-model-badge');
  if (!badge) return;
  const provider = state.settings.modelProvider;
  const providerDef = story.MODEL_PROVIDERS.find(p => p.id === provider);
  const hasKey = providerDef && providerDef.requiresKey && !!state.settings.apiKeys[provider];
  if (!providerDef || providerDef.id === 'local') {
    badge.textContent = 'Rule-based (offline)';
  } else if (!providerDef.requiresKey) {
    badge.textContent = providerDef.name;
  } else if (hasKey) {
    badge.textContent = providerDef.name;
  } else {
    badge.textContent = 'Rule-based (no API key set)';
  }
}

function initStoryTab() {
  updateStoryBadgePreview();
  $('#btn-story-generate').addEventListener('click', async () => {
    if (!state.lastQueryResult) { toast('Run a SQL query first', 'error'); return; }
    const btn = $('#btn-story-generate');
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      const provider = state.settings.modelProvider;
      const apiKey = state.settings.apiKeys[provider];
      const { text, source } = await story.generateStory(state.lastQueryResult, getActiveDataset().table, provider, apiKey);
      state.lastStory = text.replace(/<[^>]+>/g, ''); // plain text kept for consistency checker
      $('#story-empty').style.display = 'none';
      $('#story-content-wrap').style.display = '';
      // Local stories are built from hardcoded-safe markup wrapping escapeHtml()'d
      // data values, so they render as-is. Any other source is free-form text from
      // a third-party model (a crafted dataset could prompt-inject it into emitting
      // raw HTML), so it is escaped before hitting innerHTML.
      const storyHtml = (source === 'local' || source === 'local-fallback') ? text : escapeHtml(text);
      $('#story-text').innerHTML = `<p>${storyHtml}</p>`;
      const consistency = await validation.checkNarrativeConsistency(state.lastStory, state.lastQueryResult);
      const consistEl = $('#story-consistency');
      if (consistency.status === 'pass') {
        consistEl.innerHTML = `<div class="validation-status pass"><span class="status-dot pass"></span> All numbers in this story match the underlying query result.</div>`;
      } else {
        consistEl.innerHTML = `<div class="validation-status fail"><span class="status-dot fail"></span> ${consistency.mismatches.length} number(s) don't clearly match the query result: ${consistency.mismatches.slice(0,5).map(escapeHtml).join(', ')}</div>`;
      }
      const badge = $('#story-model-badge');
      badge.textContent = source === 'local' ? 'Rule-based (offline)' : source === 'local-fallback' ? 'Rule-based (API fallback)' : story.MODEL_PROVIDERS.find(p => p.id === provider)?.name || provider;
      renderStoryClaims(state.lastQueryResult);
    } catch (err) {
      toast('Story generation failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Generate Story';
    }
  });
}

// Confidence-Aware Narration (Feature 3): render each quantitative claim from
// the story with its per-claim confidence badge, scored by the Confidence Layer.
function renderStoryClaims(queryResult) {
  const wrap = $('#story-claims');
  if (!wrap) return;
  const claims = story.buildStoryClaims(queryResult);
  wrap.innerHTML = '';
  if (!claims.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const gradeClass = { A: 'badge-a', B: 'badge-b', C: 'badge-c', D: 'badge-d' };
  wrap.appendChild(el('div', { style: 'font-weight:600; font-size:var(--text-sm); margin-bottom:var(--space-2);' }, 'Claim-level confidence'));
  for (const c of claims) {
    const conf = c.confidence;
    const pctMissing = (conf.missingRate * 100).toFixed(conf.missingRate ? 1 : 0);
    wrap.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) 0; border-top:1px solid var(--color-divider); font-size:var(--text-sm);', 'data-testid': `story-claim-${c.kind}` }, [
      el('span', { style: 'flex:1;' }, c.text),
      el('span', { class: `badge ${gradeClass[conf.grade] || ''}`, style: 'flex:none;', 'data-testid': `claim-badge-${c.kind}` }, `${conf.grade} · n=${conf.n} · ${pctMissing}% missing`),
    ]));
  }
}

// ============================================================
// Swift Tab
// ============================================================
function initSwiftTab() {
  $('#btn-swift-run').addEventListener('click', () => {
    swiftPreview.renderSwiftPreview($('#swift-input').value, 'swift-preview-wrap');
  });
}

// ============================================================
// Settings Modal
// ============================================================
function initSettings() {
  const providerList = $('#model-provider-list');
  story.MODEL_PROVIDERS.forEach(p => {
    const chip = el('div', {
      class: `chip ${state.settings.modelProvider === p.id ? 'active' : ''}`,
      style: 'width:100%; justify-content:flex-start; padding:var(--space-3);',
      'data-testid': `chip-provider-${p.id}`,
      onclick: () => {
        state.settings.modelProvider = p.id;
        $$('.chip[data-provider]').forEach(c => c.classList.remove('active'));
        $$('#model-provider-list .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        $('#api-key-section').style.display = (p.requiresKey) ? '' : 'none';
        $('#model-api-key').value = state.settings.apiKeys[p.id] || '';
        updateStoryBadgePreview();
      },
    }, [
      el('span', {}, p.name),
      p.requiresKey ? el('span', { class: 'badge badge-b', style: 'margin-left:auto;' }, 'Requires API key') : el('span', { class: 'badge badge-a', style: 'margin-left:auto;' }, 'No key needed'),
    ]);
    chip.setAttribute('data-provider', p.id);
    providerList.appendChild(chip);
  });

  $('#btn-settings').addEventListener('click', () => $('#settings-modal').classList.add('open'));
  $('#btn-settings-close').addEventListener('click', () => $('#settings-modal').classList.remove('open'));
  $('#freshness-threshold').addEventListener('change', (e) => { state.settings.freshnessThresholdHours = parseInt(e.target.value, 10); });
  $('#btn-settings-save').addEventListener('click', () => {
    const provider = state.settings.modelProvider;
    const key = $('#model-api-key').value.trim();
    if (key) state.settings.apiKeys[provider] = key;
    $('#settings-modal').classList.remove('open');
    refreshFreshnessBadge();
    updateStoryBadgePreview();
    toast('Settings saved', 'success');
  });
}

// ============================================================
// In-app Diagnostics (?diag=1)
// ============================================================
// Visible on-page self-check: boots the engine, times it, and runs a trivial
// sanity query. Only activates when the URL carries ?diag=1 — the normal app
// is completely unaffected otherwise. Reuses the existing card / status-dot /
// mono CSS so it needs no new styles.
async function runDiagnostics() {
  const panel = el('div', { id: 'diag-panel', style: 'position:fixed; right:16px; bottom:16px; z-index:9999; max-width:440px; width:calc(100% - 32px);' });
  const card = el('div', { class: 'card', style: 'padding:var(--space-4);' });
  const head = el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); margin-bottom:var(--space-2);' }, [
    el('span', { style: 'font-weight:600; font-size:var(--text-lg); flex:1;' }, 'DATAGLOW Diagnostics'),
  ]);
  const closeBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:4px 8px;' }, 'Close');
  closeBtn.addEventListener('click', () => panel.remove());
  head.appendChild(closeBtn);
  card.appendChild(head);
  const rows = el('div', {});
  card.appendChild(rows);
  panel.appendChild(card);
  document.body.appendChild(panel);

  const addRow = (label, status, detail) => {
    rows.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) 0; border-top:1px solid var(--color-divider);', 'data-testid': `diag-${status}` }, [
      el('span', { class: `validation-status ${status}` }, [el('span', { class: `status-dot ${status}` }), status.toUpperCase()]),
      el('span', { style: 'flex:1; font-size:var(--text-sm);' }, label),
      el('span', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, detail || ''),
    ]));
  };

  addRow('Page & modules loaded', 'pass', 'ok');

  let t0 = performance.now();
  try {
    await engine.initDuckDB();
    addRow('DuckDB-WASM engine init', 'pass', `${(performance.now() - t0).toFixed(0)} ms`);
  } catch (e) {
    addRow('DuckDB-WASM engine init', 'fail', e.message);
    return;
  }

  t0 = performance.now();
  try {
    const res = await engine.runQuery('SELECT 1 AS ok');
    const ok = res.rows.length === 1 && Number(res.rows[0].ok) === 1;
    addRow('Sanity query (SELECT 1)', ok ? 'pass' : 'fail', `${res.elapsedMs.toFixed(1)} ms`);
  } catch (e) {
    addRow('Sanity query (SELECT 1)', 'fail', e.message);
  }
}

// ============================================================
// Digital Twin — What-If Simulator (Gen 10 Batch 2, Feature 1)
// ============================================================
// Perturbs an in-memory SAMPLE of the active dataset and re-runs the exact same
// runAllLayers + Confidence-Calibrated Grades pipeline against a throwaway copy
// table (__twin_sim), never touching the real dataset. See js/digital-twin.js
// for the pure perturbation engine + isolation guarantee.
const TWIN_SAMPLE_CAP = 5000;      // rows pulled into the sandbox for live speed
const TWIN_TABLE = '__twin_sim';   // throwaway table, dropped/rebuilt each sim
let twinState = null;              // { table, cols, rows, sampled, total, knobs, baseline }
let twinSimSeq = 0;                // guards against out-of-order async renders

// A compact "concerns" summary of a results map: how many layers fail/warn.
function twinConcernSummary(results) {
  let fail = 0, warn = 0;
  for (const [k, v] of Object.entries(results)) {
    if (k === 'domainPack' || k === 'calibratedGrades' || k === 'confidence') continue;
    if (v && v.status === 'fail') fail++;
    else if (v && v.status === 'warn') warn++;
  }
  return { fail, warn };
}

function selectedPack() {
  const sel = $('#domain-pack-select');
  return sel && sel.value ? sel.value : 'healthcare';
}

// Run one what-if simulation: perturb the sampled rows, load them into the
// throwaway table, and run the full validation + grading pipeline on that copy.
// Simulations are serialized through twinChain because they share a single
// throwaway table (__twin_sim); overlapping runs would DROP it mid-query.
let twinChain = Promise.resolve();
function runTwinSimulation(knobs) {
  const run = () => runTwinSimulationInner(knobs);
  twinChain = twinChain.then(run, run);
  return twinChain;
}

async function runTwinSimulationInner(knobs) {
  const t = twinState;
  const { rows: pRows, columns: pCols } = digitalTwin.perturbRows(t.rows, t.cols, knobs);
  await ensureDuckDB();
  await engine.createTableFromRows(TWIN_TABLE, pCols, pRows);
  const schema = await engine.getTableSchema(TWIN_TABLE);
  const twinDs = {
    name: `${t.table}.__twin`, table: TWIN_TABLE, rowCount: pRows.length,
    cols: schema.map(s => ({ name: s.column_name, type: s.column_type })),
    loadedAt: Date.now(), isSynthetic: true,
  };
  // runAllLayers writes state.validationResults as a side effect; snapshot and
  // restore it so a what-if never clobbers the real Validate tab's state.
  const savedResults = state.validationResults;
  let results;
  try {
    results = await validation.runAllLayers(twinDs, {
      freshnessThresholdHours: state.settings.freshnessThresholdHours, pack: selectedPack(),
    });
  } finally {
    state.validationResults = savedResults;
  }
  return results;
}

function renderTwinComparison(baseline, sim) {
  const wrap = $('#twin-comparison');
  if (!wrap) return;
  const gradeColor = g => ({ A: 'var(--color-grade-a)', B: 'var(--color-grade-b)', C: 'var(--color-grade-c)', D: 'var(--color-grade-d)', F: 'var(--color-grade-d)' }[g] || 'var(--color-text-muted)');
  const axisRow = (label, baseAxis, simAxis, testid) => {
    const delta = digitalTwin.gradeDelta(baseAxis.grade, simAxis.grade);
    const arrow = delta < 0 ? '▼' : delta > 0 ? '▲' : '=';
    const arrowColor = delta < 0 ? 'var(--color-grade-d)' : delta > 0 ? 'var(--color-grade-a)' : 'var(--color-text-faint)';
    return el('div', { style: 'display:flex; align-items:center; gap:var(--space-3); padding:var(--space-2) 0; border-bottom:1px solid var(--color-divider);', 'data-testid': testid }, [
      el('div', { style: 'flex:1; font-size:var(--text-sm);' }, label),
      el('div', { style: `font-weight:700; font-size:var(--text-lg); color:${gradeColor(baseAxis.grade)};`, 'data-testid': `${testid}-baseline` }, baseAxis.grade),
      el('div', { style: `color:${arrowColor}; font-weight:700;` }, arrow),
      el('div', { style: `font-weight:700; font-size:var(--text-lg); color:${gradeColor(simAxis.grade)};`, 'data-testid': `${testid}-sim` }, simAxis.grade),
    ]);
  };
  const bc = twinConcernSummary(baseline);
  const sc = twinConcernSummary(sim);
  wrap.innerHTML = '';
  wrap.appendChild(el('div', { style: 'display:flex; gap:var(--space-3); font-size:var(--text-xs); color:var(--color-text-faint); padding-bottom:var(--space-2);' }, [
    el('div', { style: 'flex:1;' }, ''), el('div', {}, 'Baseline'), el('div', {}, '→'), el('div', {}, 'Simulated'),
  ]));
  wrap.appendChild(axisRow('Data Integrity', baseline.calibratedGrades.integrity, sim.calibratedGrades.integrity, 'twin-grade-integrity'));
  wrap.appendChild(axisRow('Domain Confidence', baseline.calibratedGrades.plausibility, sim.calibratedGrades.plausibility, 'twin-grade-plausibility'));
  wrap.appendChild(el('div', { style: 'padding:var(--space-2) 0; font-size:var(--text-sm);', 'data-testid': 'twin-flag-summary' }, [
    el('span', { style: 'flex:1;' }, 'Layers flagged (fail / warn): '),
    el('span', { style: 'color:var(--color-text-muted);' }, `${bc.fail}/${bc.warn}`),
    el('span', { style: 'color:var(--color-text-faint);' }, '  →  '),
    el('span', { style: 'font-weight:600;' }, `${sc.fail}/${sc.warn}`),
  ]));
}

const runTwinDebounced = debounce(async () => {
  if (!twinState) return;
  const seq = ++twinSimSeq;
  try {
    const sim = await runTwinSimulation(twinState.knobs);
    if (seq !== twinSimSeq) return; // a newer drag superseded this one
    renderTwinComparison(twinState.baseline, sim);
  } catch (err) {
    toast('Twin simulation failed: ' + (err && err.message || err), 'error');
  }
}, 220);

function renderTwinControls() {
  const host = $('#twin-controls');
  if (!host) return;
  host.innerHTML = '';
  const sliders = digitalTwin.inferPerturbations(twinState.cols);
  for (const s of sliders) {
    const valSpan = el('span', { style: 'min-width:38px; text-align:right; font-variant-numeric:tabular-nums; color:var(--color-text-muted);' }, `${twinState.knobs[s.key] || 0}%`);
    const input = el('input', {
      type: 'range', min: String(s.min), max: String(s.max), step: String(s.step),
      value: String(twinState.knobs[s.key] || 0), 'data-testid': `twin-slider-${s.key}`,
      style: 'flex:1;',
    });
    input.addEventListener('input', () => {
      twinState.knobs[s.key] = Number(input.value);
      valSpan.textContent = `${input.value}%`;
      runTwinDebounced();
    });
    host.appendChild(el('div', { style: 'margin-bottom:var(--space-3);' }, [
      el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:4px;' }, s.label),
      el('div', { style: 'display:flex; align-items:center; gap:var(--space-2);' }, [input, valSpan]),
    ]));
  }
}

// Build (or rebuild) the twin sandbox for the active dataset: sample its rows,
// compute the baseline grades on that same sample, and render controls.
let twinBuilding = false;
async function buildTwinControls() {
  const ds = getActiveDataset();
  const empty = $('#twin-empty');
  const body = $('#twin-body');
  if (!empty || !body) return;
  if (!ds) { empty.style.display = ''; body.style.display = 'none'; return; }
  empty.style.display = 'none'; body.style.display = '';
  // Reuse an existing sandbox if it's already built for this table.
  if (twinState && twinState.table === ds.table) { renderTwinControls(); return; }
  if (twinBuilding) return;
  twinBuilding = true;
  try {
    await ensureDuckDB();
    const { rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT ${TWIN_SAMPLE_CAP}`);
    twinState = {
      table: ds.table, cols: ds.cols.map(c => ({ name: c.name, type: c.type })),
      rows, sampled: ds.rowCount > TWIN_SAMPLE_CAP, total: ds.rowCount, knobs: {}, baseline: null,
    };
    const note = $('#twin-sample-note');
    if (twinState.sampled) {
      note.style.display = '';
      note.textContent = `For responsiveness, this what-if simulator runs on a sample of ${rows.length.toLocaleString()} rows out of ${ds.rowCount.toLocaleString()} total. Grades are indicative of the sample.`;
    } else {
      note.style.display = 'none';
    }
    renderTwinControls();
    // Baseline = the same sample with zero perturbation, so before/after is
    // an apples-to-apples comparison on identical rows.
    twinState.baseline = await runTwinSimulation({});
    renderTwinComparison(twinState.baseline, twinState.baseline);
  } catch (err) {
    toast('Could not build digital twin: ' + (err && err.message || err), 'error');
  } finally {
    twinBuilding = false;
  }
}

function initDigitalTwin() {
  const resetBtn = $('#btn-twin-reset');
  if (!resetBtn) return;
  resetBtn.addEventListener('click', () => {
    if (!twinState) return;
    twinState.knobs = {};
    renderTwinControls();
    if (twinState.baseline) renderTwinComparison(twinState.baseline, twinState.baseline);
  });
}

// ============================================================
// Ambient Watch Folder Mode (Gen 10 Batch 2, Feature 2)
// ============================================================
// Points DATAGLOW at a local folder via the File System Access API and polls it
// for new/changed files, running each through the SAME loaders.loadFile +
// runAllLayers path as a manual upload. Zero network I/O. See js/watch-folder.js.
let watchController = null;
const watchStatuses = new Map(); // name -> { name, ok, grade, detail, ts }

function gradeFromResults(results) {
  if (results && results.calibratedGrades && results.calibratedGrades.integrity) {
    return results.calibratedGrades.integrity.grade;
  }
  if (results && results.confidence && results.confidence.grade) return results.confidence.grade;
  return '?';
}

function renderWatchStatus(headline) {
  const host = $('#watch-status');
  if (!host) return;
  host.innerHTML = '';
  if (headline) {
    host.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-bottom:var(--space-3);', 'data-testid': 'watch-headline' }, headline));
  }
  const items = [...watchStatuses.values()].sort((a, b) => b.ts - a.ts);
  if (!items.length) {
    host.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-faint);' }, 'No files validated yet.'));
    return;
  }
  for (const s of items) {
    host.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) 0; border-bottom:1px solid var(--color-divider); font-size:var(--text-sm);', 'data-testid': `watch-file-${s.name}` }, [
      el('span', { class: `status-dot ${s.ok ? 'pass' : 'fail'}` }),
      el('span', { class: 'mono', style: 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;' }, s.name),
      el('span', { style: 'font-weight:700;' }, s.ok ? `Grade ${s.grade}` : 'Error'),
      el('span', { style: 'color:var(--color-text-faint); font-size:var(--text-xs);' }, new Date(s.ts).toLocaleTimeString()),
    ]));
  }
}

// The shared ingest path — deliberately the SAME functions the manual upload
// button uses (loaders.loadFile + validation.runAllLayers), not a copy.
async function watchIngestAndValidate(file /*, entry */) {
  await ensureDuckDB();
  const ds = await loaders.loadFile(file);
  renderSidebar();
  resetPanelStates();
  const results = await validation.runAllLayers(ds, {
    freshnessThresholdHours: state.settings.freshnessThresholdHours, pack: selectedPack(),
  });
  return { ds, results, grade: gradeFromResults(results) };
}

function initWatchFolder() {
  const connectBtn = $('#btn-watch-connect');
  const stopBtn = $('#btn-watch-stop');
  if (!connectBtn) return;

  $('#watch-privacy').textContent = watchFolder.PRIVACY_NOTICE;

  if (!watchFolder.directoryPickerSupported(window)) {
    const msg = $('#watch-unsupported');
    msg.style.display = '';
    msg.textContent = watchFolder.UNSUPPORTED_MESSAGE;
    connectBtn.disabled = true;
    connectBtn.title = 'Not supported in this browser';
    return;
  }

  watchController = new watchFolder.WatchFolderController({
    ingestAndValidate: watchIngestAndValidate,
    intervalMs: 4000,
  });
  watchController.onUpdate = ({ name, ok, result, error, ts }) => {
    watchStatuses.set(name, {
      name, ok, ts,
      grade: ok && result ? result.grade : null,
      detail: ok ? '' : (error && error.message || String(error)),
    });
    renderWatchStatus('Watching folder — files auto-validate on drop or change.');
  };
  watchController.onError = (err) => {
    stopBtn.style.display = 'none';
    connectBtn.style.display = '';
    renderWatchStatus('Permission lost or folder unavailable — please reconnect. (' + (err && err.message || err) + ')');
  };

  connectBtn.addEventListener('click', async () => {
    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker();
    } catch (err) {
      return; // user dismissed the native picker — not an error
    }
    await ensureDuckDB();
    watchStatuses.clear();
    await watchController.start(dirHandle);
    connectBtn.style.display = 'none';
    stopBtn.style.display = '';
    renderWatchStatus('Watching folder — files auto-validate on drop or change.');
    toast('Watching folder for changes', 'success');
  });

  stopBtn.addEventListener('click', () => {
    watchController.stop();
    stopBtn.style.display = 'none';
    connectBtn.style.display = '';
    renderWatchStatus('Stopped watching. Reconnect a folder to resume.');
    toast('Stopped watching folder', 'success');
  });

  // Don't leave a poll loop dangling if the user navigates away.
  window.addEventListener('beforeunload', () => { if (watchController) watchController.stop(); });

  // Test/automation hook: drive the controller with a mock directory handle so
  // the poll + ingest path can be exercised without the native picker (which
  // needs a user gesture and can't run headless). Not used in normal operation.
  window.__dataglowStartWatch = async (mockHandle) => {
    watchStatuses.clear();
    await watchController.start(mockHandle);
    connectBtn.style.display = 'none';
    stopBtn.style.display = '';
    renderWatchStatus('Watching folder — files auto-validate on drop or change.');
    return watchController;
  };
  window.__dataglowWatchController = watchController;
}

// ============================================================
// Init
// ============================================================
function init() {
  renderTabBar();
  switchTab('preflight');
  initTheme();
  initFileLoading();
  initSqlTab();
  initPythonTab();
  initRTab();
  initVisualizeTab();
  initStoryTab();
  initSwiftTab();
  initSettings();
  initRedTeam();
  initMemory();
  initAnonExport();
  initLedger();
  initProvenance();
  initDomainPack();
  initDevilsAdvocate();
  initReceipts();
  initPeerReview();
  initTimeTravelDiff();
  initSyntheticTwin();
  initTimeMachine();
  initFederatedFingerprint();
  initIRBMode();
  initAISynthesis();
  initDigitalTwin();
  initWatchFolder();

  $('#btn-run-preflight').addEventListener('click', runPreflight);
  $('#btn-clean-scan').addEventListener('click', scanClean);
  $('#btn-validate-run').addEventListener('click', runValidation);

  renderSidebar();

  // Signal that the synchronous app init (DOM wiring, tabs, feature panels) is
  // done — independent of the async DuckDB-WASM warm-up below. The ambient
  // validation and SLM-degradation e2e paths key off this since they don't need
  // the SQL engine to be live.
  window.__dataglowInit = true;

  // Pre-warm the query engine in the background so it's live as soon as a
  // dataset is loaded. Sets window.__dataglowReady once the engine responds
  // (used by the Playwright e2e smoke test as its "app is live" signal). The
  // page stays fully interactive while this runs; a failure is recorded but
  // never blocks the UI.
  engine.initDuckDB()
    .then(() => { window.__dataglowReady = true; })
    .catch(err => { window.__dataglowInitError = String(err && err.message || err); });

  if (new URLSearchParams(location.search).get('diag') === '1') {
    runDiagnostics();
  }
}

document.addEventListener('DOMContentLoaded', init);
