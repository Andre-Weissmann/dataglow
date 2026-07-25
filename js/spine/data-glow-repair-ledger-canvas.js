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

  function engine(name) {
    try { return window[name] || null; } catch (_e) { return null; }
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
      if (download('repair-ledger.json', json, 'application/json')) toast('Ledger exported as JSON.');
      else copy(json, 'Ledger JSON');
    });
    actions.appendChild(exportJsonBtn);

    var exportMdBtn = el('button', { class: 'dg-lg-btn', type: 'button' }, 'Export Markdown');
    exportMdBtn.addEventListener('click', function () {
      var md = eng.exportLedgerMarkdown(state.ledger);
      if (download('repair-ledger.md', md, 'text/markdown')) toast('Ledger exported as Markdown.');
      else copy(md, 'Ledger Markdown');
    });
    actions.appendChild(exportMdBtn);
    panel.appendChild(actions);

    if (typeof eng.wiringReport === 'function') {
      var fired = [];
      try {
        var pk = window.DataGlowPowerPacksUI;
        if (pk && Array.isArray(pk._ledgerFired)) fired = fired.concat(pk._ledgerFired);
      } catch (_e) {}
      var report = eng.wiringReport({ firedSources: fired });
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
  };
})();
/* ---- end js/spine/data-glow-repair-ledger-canvas.js ---- */
