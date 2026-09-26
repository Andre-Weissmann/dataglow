// ============================================================
// NL->SQL Tab (Phase 9 + 11 unified -- ships dark behind the nlSql flag)
// ============================================================
// Ask questions about your data in plain English. Query mode writes SQL from
// your schema instantly. Council mode (Phase 11) sends the same question to
// three AI models and compares their answers -- see tabs/council-tab.js.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, 2026-09-26) -- byte-for-byte identical
// behavior, only the file location changed. renderNLSQLTab now takes a
// `switchTab` callback since the real tab-switch dispatcher stays in main.js
// (extracting it would create a circular import).

import { state } from '../state.js';
import { isEnabled } from '../../build/build-flags.js';
import { toast } from '../utils.js';
import { mountNLSQLUI } from '../../nl-sql/nl-sql-ui.js';
import { renderCouncilTab } from './council-tab.js';

export function renderNLSQLTab(switchTab) {
  const host = document.getElementById('nl-sql-body');
  if (!host) return;
  if (!isEnabled('nlSql')) { host.innerHTML = ''; return; }

  const datasets = state.datasets || [];

  function onRunSQL(sql) {
    const sqlEditor = document.getElementById('sql-editor');
    if (sqlEditor) sqlEditor.value = sql;
    switchTab('sql');
    const runBtn = document.getElementById('btn-run-sql') || document.querySelector('[data-testid="btn-run-sql"]');
    if (runBtn) runBtn.click();
  }

  mountNLSQLUI({
    host,
    datasets,
    onRunSQL,
    onToast: toast,
  });

  // Wire AI mode switcher (Query <-> Council)
  var queryBtn = document.getElementById('ai-mode-query');
  var councilBtn = document.getElementById('ai-mode-council');
  var queryBody = document.getElementById('ai-mode-query-body');
  var councilBody = document.getElementById('ai-mode-council-body');

  function activateMode(mode) {
    var isQuery = mode === 'query';
    if (queryBody) queryBody.style.display = isQuery ? '' : 'none';
    if (councilBody) councilBody.style.display = isQuery ? 'none' : '';
    if (queryBtn) {
      queryBtn.style.background = isQuery ? 'var(--color-primary)' : 'transparent';
      queryBtn.style.color = isQuery ? '#fff' : 'var(--color-text-muted)';
      queryBtn.style.border = isQuery ? '1px solid var(--color-primary)' : '1px solid var(--color-border)';
    }
    if (councilBtn) {
      councilBtn.style.background = isQuery ? 'transparent' : 'var(--color-primary)';
      councilBtn.style.color = isQuery ? 'var(--color-text-muted)' : '#fff';
      councilBtn.style.border = isQuery ? '1px solid var(--color-border)' : '1px solid var(--color-primary)';
    }
    // Mount council lazily on first switch
    if (!isQuery && isEnabled('aiCouncil')) {
      renderCouncilTab();
    }
  }

  if (queryBtn) queryBtn.addEventListener('click', function() { activateMode('query'); });
  if (councilBtn) councilBtn.addEventListener('click', function() { activateMode('council'); });
}
