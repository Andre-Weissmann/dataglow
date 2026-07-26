/* ---- from js/spine/data-glow-repair-ledger-canvas.js ---- */
/*
 * DATAGLOW - The Repair Ledger panel.
 *
 * An append-only list of every step logged this session: what ran, in what
 * engine, against what table, and whether it was applied, skipped, failed, or
 * only proposed. This is the Applied Steps list Power Query has and DataGlow
 * never did, mounted as a panel rather than a 24th top-nav item, opened from
 * the power packs panel or the RECEIPT spine chip.
 *
 * WHY THE ARRAY LIVES HERE, NOT IN THE ENGINE.
 * js/spine/repair-ledger.js is pure: it builds and reads entries but owns no
 * storage of its own, on purpose, so it has no global state to leak between
 * tests. This canvas module is the one place that holds the actual array for
 * the running page and exposes it as `ledgerArray()`, so any other canvas
 * module (power packs, the type guard, Excel Hell) can append to the same
 * log by asking this module for it rather than each other.
 *
 * WHY EXPORT NEVER RUNS ANYTHING AND RE-RUN NEVER EITHER.
 * Export builds a JSON or markdown string and copies it or triggers a
 * download; it does not touch a database. Re-run resolves to `rerunPlan()`
 * from the engine, which for a rerunnable step hands back the exact SQL and
 * stops. Whether it actually runs again is a click on a "Copy" button, same
 * as every other snippet in this product; nothing in this panel executes SQL
 * on its own initiative.
 *
 * WHY UNWIRED SOURCES ARE NAMED RATHER THAN HIDDEN.
 * wiringReport() compares which of the nine known surfaces have appended at
 * least one step this session against the full known list, and the panel
 * shows the gap in plain text. A ledger that quietly only reflects some of
 * what happened is more misleading than an empty one that says so.
 */
;(function () {
  'use strict';

  var PANEL_ID = 'dg-ledger-panel';
  var BTN_ID = 'dg-ledger-btn';
  var STYLE_ID = 'dg-ledger-styles';

  var state = { open: false, ledger: [] };

  function flag(explicitKey, flagKey) {
    try { if (window[explicitKey] === false) return false; } catch (_e0) {}
    try { if (window[explicitKey] === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled(flagKey) !== false;
      }
    } catch (_e) {}
    return true;
  }

  function ledgerOn() { return flag('DATAGLOW_REPAIR_LEDGER', 'repairLedger'); }

  /* Bundle 15: thin Replay. "Thin" on purpose - it inserts the exact SQL
     text `rerunPlan()` already hands back into the real SQL editor and runs
     it through the real Run button, the same path a person copying and
     pasting would use. It never touches a database directly, never runs
     without a human confirming the specific step first, and never claims to
     replay a full Excel/Python DAG - only the SQL steps this session already
     marked canRerun. */
  function replayOn() { return flag('DATAGLOW_REPLAY_RECEIPT_THIN', 'replayReceiptThin'); }

  function sqlEngineMissing() {
    try { return !(window.SQLEngine || window.duckdbConn || window.db); } catch (_e) { return true; }
  }

  /** Insert SQL into the real editor and click the real Run button. Returns
   *  true if it found both; false (with a toast) if it could not. */
  function runSqlInEditor(sql) {
    try {
      var sqlEditor = document.getElementById('sql-view-input');
      var sqlPill = document.querySelector('[data-panel="sql-view"]');
      if (!sqlEditor) { toast('SQL editor is not available right now.'); return false; }
      sqlEditor.value = sql;
      sqlEditor.dispatchEvent(new Event('input', { bubbles: true }));
      if (sqlPill) sqlPill.click();
      setTimeout(function () {
        var runSqlBtn = document.getElementById('sql-view-run');
        if (runSqlBtn) runSqlBtn.click();
        else toast('SQL copied to editor - click Run to execute.');
      }, 100);
      return true;
    } catch (_e) {
      toast('Could not run this step. The SQL is still on your clipboard if you copied it.');
      return false;
    }
  }

  function engine(name) {
    try { return window[name] || null; } catch (_e) { return null; }
  }

  /** Replay every canRerun SQL step in ledger order. One confirm names every
   *  step up front (their titles, in the order they will run), then each
   *  runs in sequence with a short pause between so an engine that only
   *  accepts one statement at a time is not overrun. Honest about the
   *  engine: if it never shows up, later steps still queue but each one
   *  reports it could not run rather than hanging. */
  function replayAllSqlSteps(steps) {
    var eng = engine('DataGlowRepairLedger');
    if (!eng) { toast('The ledger engine is not mounted in this build.'); return; }
    if (!steps || !steps.length) { toast('No rerunnable SQL steps to replay.'); return; }
    var names = steps.map(function (s, i) { return (i + 1) + '. ' + s.title; }).join('\n');
    var confirmed = window.confirm('Replay ' + steps.length + ' SQL step(s) in order?\n\n' + names);
    if (!confirmed) { toast('Not run. Nothing changed.'); return; }

    var i = 0;
    function runNext() {
      if (i >= steps.length) { toast('Replay finished: ' + steps.length + ' step(s) sent to the editor.'); return; }
      var plan = eng.rerunPlan(steps[i]);
      i += 1;
      if (!plan.ok) { toast('Step skipped: ' + plan.reason); setTimeout(runNext, 150); return; }
      if (sqlEngineMissing()) { toast('SQL engine is not ready yet; stopping replay at step ' + i + ' of ' + steps.length + '.'); return; }
      runSqlInEditor(plan.code);
      setTimeout(runNext, 600);
    }
    runNext();
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'style') node.setAttribute('style', attrs[k]);
        else if (k === 'class') node.className = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function toast(message) {
    try {
      if (typeof window.showToast === 'function') { window.showToast(message); return; }
    } catch (_e) {}
    try { console.log('[repair ledger] ' + message); } catch (_e2) {}
  }

  function copy(text, what) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(function () {
          toast((what || 'Text') + ' copied to the clipboard.');
        }, function () {
          toast('Could not copy ' + (what || 'text') + '. Select and copy it by hand.');
        });
        return;
      }
    } catch (_e) {}
    toast('Clipboard is not available here. Select and copy the text by hand.');
  }

  function download(filename, contents, mime) {
    try {
      var blob = new Blob([contents], { type: mime || 'text/plain' });
      var url = URL.createObjectURL(blob);
      var a = el('a', { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (_e) {} }, 2000);
      return true;
    } catch (_e2) { return false; }
  }

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      + '#' + PANEL_ID + '{position:fixed;left:16px;bottom:16px;width:min(560px,calc(100vw - 32px));'
      + 'max-height:70vh;overflow:auto;background:#11151c;color:#e7ebf3;border:1px solid #2a3140;'
      + 'border-radius:10px;padding:14px;box-shadow:0 12px 28px rgba(0,0,0,.4);z-index:2147482800;display:none;'
      + 'font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}'
      + '#' + PANEL_ID + ' h3{margin:0 0 2px;font-size:15px}'
      + '#' + PANEL_ID + ' h4{margin:12px 0 4px;font-size:13px}'
      + '.dg-lg-note{color:#9aa4b6;font-size:12px;margin:4px 0}'
      + '.dg-lg-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}'
      + '.dg-lg-btn{background:#1d2430;color:#e7ebf3;border:1px solid #33405a;border-radius:6px;'
      + 'padding:5px 10px;font-size:12px;cursor:pointer}'
      + '.dg-lg-btn:hover{background:#242c3a}'
      + '.dg-lg-step{border:1px solid #262d3a;border-radius:8px;padding:8px;margin:6px 0;background:#0d1017}'
      + '.dg-lg-badge{display:inline-block;font-size:11px;padding:1px 6px;border-radius:999px;margin-left:6px}'
      + '.dg-lg-badge.applied{background:#173a24;color:#7be1a0}'
      + '.dg-lg-badge.proposed{background:#3a3417;color:#e1cc7b}'
      + '.dg-lg-badge.skipped{background:#33384a;color:#b7bfd6}'
      + '.dg-lg-badge.failed{background:#3a1717;color:#e17b7b}'
      + '#' + BTN_ID + '{position:fixed;bottom:18px;left:16px;z-index:2147482790;'
      + 'background:#1d2430;color:#e7ebf3;border:1px solid #33405a;border-radius:999px;'
      + 'padding:8px 14px;font-size:12px;cursor:pointer;box-shadow:0 6px 16px rgba(0,0,0,.35)}';
    var style = el('style', { id: STYLE_ID });
    style.textContent = css;
    document.head.appendChild(style);
  }

  /** The shared array. Any other canvas module can append to this same log. */
  function ledgerArray() {
    return state.ledger;
  }

  /* Bundle 16: the single shared place a fired surface is recorded, so
     wiringReport() has ONE list to read instead of asking each caller (power
     packs, quarantine, Excel Hell, drill floor...) to keep its own copy in
     sync. window.DataGlowPowerPacksUI._ledgerFired (Bundle 14) is still read
     and folded in below for backward compatibility with any build where only
     that surface fired, but every NEW caller should go through
     ledgerAppendFromSurface() so this array is the one source of truth. */
  function firedSources() {
    if (!Array.isArray(state.ledgerFired)) state.ledgerFired = [];
    return state.ledgerFired;
  }

  function markFired(source) {
    if (typeof source !== 'string' || !source) return;
    var fired = firedSources();
    if (fired.indexOf(source) < 0) fired.push(source);
  }

  /**
   * Bundle 16 shared helper: append one step to the ledger from ANY surface
   * (load, quarantine, Excel Hell apply, a Python/R recipe run, an export,
   * the SQL editor, a drill) with never-throw discipline and one shared
   * firedSources record. Every call site in this codebase that wires the
   * Repair Ledger should call this instead of hand-rolling its own try/catch
   * around DataGlowRepairLedger.appendStep, so a missing engine or a missing
   * UI mount degrades to "nothing logged" rather than a thrown error the
   * caller's real feature (a file load, a repair, a recipe run) would have to
   * survive.
   *
   * @param {string} kind  one of REPAIR_LEDGER_KINDS; also the fired-source name
   * @param {object} [payload]  the rest of buildStep()'s input (title, engine,
   *   code, status, summary, inputTable, outputTable, recipeId, at)
   * @returns {object|null} the appended step, or null if nothing was appended
   */
  function ledgerAppendFromSurface(kind, payload) {
    try {
      var eng = engine('DataGlowRepairLedger');
      if (!eng || typeof eng.appendStep !== 'function') return null;
      var arr = ledgerArray();
      if (!Array.isArray(arr)) return null;
      var input = Object.assign({}, payload || {}, { kind: kind });
      var step = eng.appendStep(arr, input);
      markFired(step.kind);
      try { refreshChip(); } catch (_e1) {}
      try { if (state.open) render(); } catch (_e2) {}
      return step;
    } catch (_e) {
      return null;
    }
  }

  /** Every source this session, folding in the Bundle 14 power-packs list so a
   *  build that still only fires through that path reports accurately. */
  function allFiredSources() {
    var out = firedSources().slice();
    try {
      var pk = window.DataGlowPowerPacksUI;
      if (pk && Array.isArray(pk._ledgerFired)) {
        for (var i = 0; i < pk._ledgerFired.length; i++) {
          if (out.indexOf(pk._ledgerFired[i]) < 0) out.push(pk._ledgerFired[i]);
        }
      }
    } catch (_e) {}
    return out;
  }

  function summary() {
    var eng = engine('DataGlowRepairLedger');
    if (!eng || typeof eng.ledgerSummary !== 'function') return null;
    try { return eng.ledgerSummary(state.ledger); } catch (_e) { return null; }
  }

  function renderStep(host, step) {
    var eng = engine('DataGlowRepairLedger');
    var row = el('div', { class: 'dg-lg-step' });
    var head = el('div', {});
    head.appendChild(el('b', {}, step.title));
    head.appendChild(el('span', { class: 'dg-lg-badge ' + step.status }, step.status));
    row.appendChild(head);
    row.appendChild(el('div', { class: 'dg-lg-note' }, step.engine + ' / ' + step.kind + ' - ' + new Date(step.at).toLocaleString()));
    if (step.summary) row.appendChild(el('div', { class: 'dg-lg-note' }, step.summary));

    var actions = el('div', { class: 'dg-lg-row' });
    if (step.code) {
      var copyBtn = el('button', { class: 'dg-lg-btn', type: 'button' }, 'Copy code');
      copyBtn.addEventListener('click', function () { copy(step.code, 'Step code'); });
      actions.appendChild(copyBtn);
    }
    if (eng && typeof eng.canRerun === 'function' && eng.canRerun(step)) {
      var rerunBtn = el('button', { class: 'dg-lg-btn', type: 'button' }, 'Re-run plan');
      rerunBtn.addEventListener('click', function () {
        var plan = eng.rerunPlan(step);
        if (plan.ok) { copy(plan.code, 'Re-run SQL'); toast(plan.note); }
        else toast(plan.reason);
      });
      actions.appendChild(rerunBtn);

      if (replayOn()) {
        var runAgainBtn = el('button', { class: 'dg-lg-btn', type: 'button' }, 'Run again');
        runAgainBtn.addEventListener('click', function () {
          var plan2 = eng.rerunPlan(step);
          if (!plan2.ok) { toast(plan2.reason); return; }
          if (sqlEngineMissing()) { toast('SQL engine is not ready yet. Copy the SQL above and run it once the engine loads.'); return; }
          /* Human confirm before anything runs again - this is the one line
             standing between "Run again" and an auto-mutating replay. */
          var confirmed = window.confirm('Run this SQL step again?\n\n' + plan2.code);
          if (!confirmed) { toast('Not run. Nothing changed.'); return; }
          runSqlInEditor(plan2.code);
        });
        actions.appendChild(runAgainBtn);
      }
    }
    if (actions.childNodes.length) row.appendChild(actions);
    host.appendChild(row);
  }

  function render() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.innerHTML = '';

    var head = el('div', { class: 'dg-lg-row' });
    var title = el('div', {});
    title.appendChild(el('h3', {}, 'Repair Ledger'));
    var eng = engine('DataGlowRepairLedger');
    title.appendChild(el('div', { class: 'dg-lg-note' }, eng ? eng.APPLIED_STEPS_EQUIVALENT : 'The ledger engine is not mounted in this build.'));
    head.appendChild(title);
    var close = el('button', { class: 'dg-lg-btn', type: 'button' }, 'Close');
    close.addEventListener('click', dismiss);
    head.appendChild(close);
    panel.appendChild(head);

    if (!eng) { panel.style.display = 'block'; return; }

    var sum = summary();
    if (sum) panel.appendChild(el('p', { class: 'dg-lg-note' }, sum.headline));

    var actions = el('div', { class: 'dg-lg-row' });
    var exportJsonBtn = el('button', { class: 'dg-lg-btn', type: 'button' }, 'Export JSON');
    exportJsonBtn.addEventListener('click', function () {
      var json = eng.exportLedgerJson(state.ledger);
      var wroteFile = download('repair-ledger.json', json, 'application/json');
      if (wroteFile) toast('Ledger exported as JSON.');
      else copy(json, 'Ledger JSON');
      /* Bundle 16: the export itself becomes a step, appended AFTER the
         download so it does not count itself in the JSON/Markdown it just
         wrote. Recorded directly (not via render()) so an export click never
         recurses into another render() mid-click. */
      try {
        markFired('export');
        eng.appendStep(state.ledger, {
          kind: 'export', engine: 'system', title: 'Repair Ledger exported as JSON',
          summary: wroteFile ? 'Downloaded repair-ledger.json' : 'Copied ledger JSON to the clipboard',
          status: 'applied',
        });
        refreshChip();
      } catch (_eExp) {}
    });
    actions.appendChild(exportJsonBtn);

    var exportMdBtn = el('button', { class: 'dg-lg-btn', type: 'button' }, 'Export Markdown');
    exportMdBtn.addEventListener('click', function () {
      var md = eng.exportLedgerMarkdown(state.ledger);
      var wroteFile = download('repair-ledger.md', md, 'text/markdown');
      if (wroteFile) toast('Ledger exported as Markdown.');
      else copy(md, 'Ledger Markdown');
      try {
        markFired('export');
        eng.appendStep(state.ledger, {
          kind: 'export', engine: 'system', title: 'Repair Ledger exported as Markdown',
          summary: wroteFile ? 'Downloaded repair-ledger.md' : 'Copied ledger Markdown to the clipboard',
          status: 'applied',
        });
        refreshChip();
      } catch (_eExp2) {}
    });
    actions.appendChild(exportMdBtn);

    if (replayOn() && typeof eng.canRerun === 'function' && typeof eng.listSteps === 'function') {
      var rerunnable = eng.listSteps(state.ledger).filter(function (s) { return eng.canRerun(s); });
      if (rerunnable.length > 1) {
        var replayAllBtn = el('button', { class: 'dg-lg-btn', type: 'button' }, 'Replay all SQL steps in order (' + rerunnable.length + ')');
        replayAllBtn.addEventListener('click', function () { replayAllSqlSteps(rerunnable); });
        actions.appendChild(replayAllBtn);
      }
    }
    panel.appendChild(actions);

    if (typeof eng.wiringReport === 'function') {
      var report = eng.wiringReport({ firedSources: allFiredSources() });
      panel.appendChild(el('p', { class: 'dg-lg-note' }, report.headline));
    }

    var steps = eng.listSteps(state.ledger);
    if (!steps.length) {
      panel.appendChild(el('p', { class: 'dg-lg-note' }, 'Nothing logged yet this session. Run a SUMMARIZE profile, check the type guard, or copy a PQ-parity recipe to see a step here.'));
    } else {
      var list = el('div', {});
      for (var i = steps.length - 1; i >= 0; i--) renderStep(list, steps[i]);
      panel.appendChild(list);
    }

    panel.style.display = 'block';
  }

  function refreshChip() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    var sum = summary();
    btn.textContent = 'Repair Ledger' + (sum && sum.total ? ' (' + sum.total + ')' : '');
  }

  function open() {
    state.open = true;
    render();
    refreshChip();
  }

  function dismiss() {
    var panel = document.getElementById(PANEL_ID);
    state.open = false;
    if (panel) panel.style.display = 'none';
  }

  function toggle() {
    if (state.open) dismiss(); else open();
  }

  function mount() {
    if (!ledgerOn()) return;
    if (document.getElementById(PANEL_ID)) return;
    if (!document.body) return;
    if (!engine('DataGlowRepairLedger')) return;
    styles();

    document.body.appendChild(el('div', {
      id: PANEL_ID,
      role: 'dialog',
      'aria-label': 'Repair Ledger: every step logged this session',
    }));
    var btn = el('button', { id: BTN_ID, type: 'button' }, 'Repair Ledger');
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);
    refreshChip();
  }

  function unmount() {
    var panel = document.getElementById(PANEL_ID);
    var btn = document.getElementById(BTN_ID);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
  }

  /* Bundle 16: 'load' wiring. Rather than reach into every load path
     (sample-dataset buttons, dropped CSV/Excel files, the desktop app-shell's
     runDatasetLoad()), this listens for the ONE event every load path already
     dispatches when a dataset finishes loading: 'dataglow:dataset-loaded'
     (canvas), mirrored by a direct call from js/app-shell/main.js's
     runDatasetLoad() for the non-canvas build, which does not go through
     this DOM event. Listening instead of hooking each call site means a
     future load path that also dispatches this event is covered for free. */
  function onDatasetLoaded(evt) {
    try {
      var ds = evt && evt.detail && evt.detail.dataset;
      if (!ds) return;
      var table = ds.table || ds.name || '';
      var rowCount = Array.isArray(ds.rows) ? ds.rows.length : null;
      ledgerAppendFromSurface('load', {
        engine: 'system',
        title: 'Dataset loaded' + (table ? ': ' + table : ''),
        outputTable: table,
        summary: table
          ? ('Loaded ' + table + (rowCount !== null ? ' (' + rowCount + ' rows)' : ''))
          : 'A dataset finished loading',
        status: 'applied',
      });
    } catch (_e) { /* best-effort; a load must never fail because of this */ }
  }
  try {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('dataglow:dataset-loaded', onDatasetLoaded);
    }
  } catch (_eListen) {}

  function boot() {
    try {
      if (!ledgerOn()) { unmount(); return; }
      mount();
    } catch (_e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1400); });
  } else {
    setTimeout(boot, 1400);
  }

  window.DataGlowRepairLedgerUI = {
    version: 1,
    mounted: function () { return !!document.getElementById(PANEL_ID); },
    open: open,
    close: dismiss,
    toggle: toggle,
    isOpen: function () { return state.open === true; },
    refresh: render,
    ledgerArray: ledgerArray,
    summary: summary,
    /* Bundle 16: the shared, never-throwing append every surface should use. */
    appendFromSurface: ledgerAppendFromSurface,
    firedSources: allFiredSources,
    _ledgerFired: firedSources(),
  };
})();
/* ---- end js/spine/data-glow-repair-ledger-canvas.js ---- */
