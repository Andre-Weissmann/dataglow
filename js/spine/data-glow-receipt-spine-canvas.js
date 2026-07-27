/* ---- from js/spine/data-glow-receipt-spine-canvas.js ---- */
/*
 * DATAGLOW - The Start here rail.
 *
 * A strip across the bottom of the page naming the five steps of the path, with
 * the one you are on marked and every step openable. It is the smallest thing
 * that answers "where do I begin", which is the question the product currently
 * does not answer at all.
 *
 * WHY IT DISMISSES AND STAYS DISMISSED.
 * A rail that reappears on every load is a nag, and a nag gets closed without
 * being read the second time. Dismissal is remembered. It can be reopened from
 * the chip, so nothing is lost by closing it.
 *
 * WHY EVERY STEP RESOLVES ITS TARGET BEFORE IT RENDERS A BUTTON.
 * Builds inline different subsets of the modules, so a step can point at a
 * surface that is not in this build. A button that does nothing is worse than a
 * line of text, so a step whose target is unresolvable renders as text and says
 * which surface it wanted.
 *
 * WHY THE RAIL NEVER MARKS A STEP DONE BY ITSELF.
 * Every fact it reports is read from another engine on each render. Nothing is
 * stored, so the rail cannot get out of step with what has actually happened,
 * and closing the page does not leave it believing something that is no longer
 * true.
 */
;(function () {
  'use strict';

  var RAIL_ID = 'dg-spine-rail';
  var CHIP_ID = 'dg-spine-chip';
  var STYLE_ID = 'dg-spine-styles';
  var SEEN_KEY = 'dataglow.receiptSpine.dismissed';
  var LEDGER_CHIP_ID = 'dg-spine-ledger-chip';

  var state = { open: true, expandedId: '' };

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

  function spineOn() { return flag('DATAGLOW_RECEIPT_SPINE', 'receiptSpine'); }

  /* Bundle 15: the Repair Ledger chip mounted on this rail rather than a 25th
     top-nav item. Off by default gate is its own flag, repairLedgerSpine, so
     a build can run the rail without the chip and the chip never appears
     when the underlying Repair Ledger itself is off. */
  function ledgerSpineOn() { return flag('DATAGLOW_REPAIR_LEDGER_SPINE', 'repairLedgerSpine'); }

  function engine(name) {
    try { return window[name] || null; } catch (_e) { return null; }
  }

  function remembered(key) {
    try { return window.localStorage && window.localStorage.getItem(key) === '1'; } catch (_e) { return false; }
  }

  function remember(key) {
    try { if (window.localStorage) window.localStorage.setItem(key, '1'); } catch (_e) {}
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
    try { console.log('[spine] ' + message); } catch (_e2) {}
  }

  /* ---------------------------------------------------------------
     Observation. Each of these is a question asked of the engine that
     owns the answer, never a flag this module sets when a button is
     clicked.
     --------------------------------------------------------------- */

  function hasTable() {
    try {
      if (Array.isArray(window.loadedTables) && window.loadedTables.length > 0) return true;
      if (window.currentTableName) return true;
      if (window.DATAGLOW_STATE && window.DATAGLOW_STATE.tableName) return true;
    } catch (_e) {}
    return false;
  }

  function hasQueryResult() {
    try {
      if (window.lastQueryResult) return true;
      if (window.DATAGLOW_STATE && window.DATAGLOW_STATE.lastQueryResult) return true;
    } catch (_e) {}
    return false;
  }

  function proveRan() {
    try {
      var p2p = engine('DataGlowProofToPostUI');
      if (p2p && typeof p2p.pack === 'function') {
        var pack = p2p.pack();
        if (pack && pack.validation) return true;
      }
    } catch (_e) {}
    return false;
  }

  function hasShipped() {
    try {
      var p2p = engine('DataGlowProofToPostUI');
      if (p2p && typeof p2p.copiedOnce === 'function') return p2p.copiedOnce() === true;
    } catch (_e) {}
    try { return window.DATAGLOW_SHIPPED_ONCE === true; } catch (_e2) {}
    return false;
  }

  function hasSavedMethod() {
    try {
      var lib = engine('DataGlowRepairRecipeLibraryUI') || engine('DataGlowRepairRecipeLibrary');
      if (lib && typeof lib.count === 'function') return lib.count() > 0;
      if (lib && typeof lib.list === 'function') {
        var rows = lib.list() || [];
        return rows.length > 0;
      }
    } catch (_e) {}
    return false;
  }

  function spine() {
    var eng = engine('DataGlowReceiptSpine');
    if (!eng || typeof eng.buildReceiptSpine !== 'function') return null;
    try {
      return eng.buildReceiptSpine({
        hasTable: hasTable(),
        hasQueryResult: hasQueryResult(),
        proveRan: proveRan(),
        hasShipped: hasShipped(),
        hasSavedMethod: hasSavedMethod(),
      });
    } catch (_e) { return null; }
  }

  /* ---------------------------------------------------------------
     Targets. An intent id becomes a function only when the surface it
     needs is actually mounted in this build.
     --------------------------------------------------------------- */

  function resolveTarget(intent) {
    function panel(globalName, method) {
      var g = engine(globalName);
      if (g && typeof g[method] === 'function') return function () { g[method](); };
      return null;
    }
    function clickId(id) {
      var node = null;
      try { node = document.getElementById(id); } catch (_e) {}
      if (!node) return null;
      return function () {
        try { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_e2) {}
        try { node.click(); } catch (_e3) {}
      };
    }

    if (intent === 'open-file') {
      return clickId('fileInput') || clickId('dropZone') || clickId('btnLoadFile');
    }
    if (intent === 'fix-spreadsheet') {
      return panel('DataGlowExcelHellUI', 'open') || panel('DataGlowRepairRecipeLibraryUI', 'open');
    }
    if (intent === 'open-ask') {
      return clickId('nlQueryInput') || clickId('sqlEditor') || clickId('tab-sql');
    }
    if (intent === 'open-proof-board') {
      return panel('DataGlowProofBoardUI', 'open');
    }
    if (intent === 'open-ship') {
      return panel('DataGlowProofToPostUI', 'open');
    }
    if (intent === 'open-compound') {
      return panel('DataGlowRepairRecipeLibraryUI', 'open') || panel('DataGlowLocalAiUI', 'open');
    }
    if (intent === 'open-ledger') {
      return panel('DataGlowRepairLedgerUI', 'open');
    }
    return null;
  }

  /* ---------------------------------------------------------------
     Rendering
     --------------------------------------------------------------- */

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      /* A50.1: RECEIPT spine is a permanent bottom nav rail, so its base
         text/step/button labels count as nav labels/buttons (raised to
         the 16px floor, was 13px/12px); notes/details are captions
         (raised to the 14px caption floor, was 12px). */
      + '#' + RAIL_ID + '{position:fixed;left:0;right:0;bottom:0;z-index:2147482900;display:none;'
      + 'background:var(--color-surface,#fff);border-top:1px solid var(--color-border,#ccc);'
      + 'box-shadow:0 -4px 18px rgba(0,0,0,.10);padding:8px 14px;font-size:16px;line-height:1.45}'
      + '#' + RAIL_ID + ' .dg-sp-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}'
      + '#' + RAIL_ID + ' .dg-sp-title{font-weight:600}'
      + '#' + RAIL_ID + ' .dg-sp-head{opacity:.8;flex:1 1 240px;min-width:0}'
      + '.dg-sp-steps{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}'
      + '.dg-sp-step{font:inherit;font-size:16px;padding:5px 11px;border-radius:999px;cursor:pointer;'
      + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit;text-align:left}'
      + '.dg-sp-step[data-state="current"]{font-weight:700;border-color:currentColor;border-width:2px}'
      + '.dg-sp-step[data-state="done"]{opacity:.62}'
      + '.dg-sp-step[data-state="skipped"]{border-style:dashed;font-weight:600}'
      + '.dg-sp-detail{margin-top:8px;padding:9px 11px;border:1px solid var(--color-border,#ddd);border-radius:8px}'
      + '.dg-sp-detail b{display:block;font-size:14px;opacity:.7}'
      + '.dg-sp-note{opacity:.75;font-size:14px;margin:5px 0 0}'
      + '.dg-sp-btn{font:inherit;font-size:16px;padding:5px 10px;border-radius:7px;cursor:pointer;'
      + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit}'
      + '#' + CHIP_ID + '{position:fixed;bottom:18px;left:210px;z-index:2147482900;'
      + 'font:inherit;font-size:16px;padding:6px 11px;border-radius:999px;cursor:pointer;display:none;'
      + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.14)}'
      + '.dg-sp-ledger-btn{font:inherit;font-size:16px;padding:5px 10px;border-radius:7px;cursor:pointer;'
      + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit;'
      + 'font-weight:600}';
    var tag = el('style', { id: STYLE_ID });
    tag.textContent = css;
    (document.head || document.body).appendChild(tag);
  }

  function stateWord(s) {
    if (s === 'done') return 'done';
    if (s === 'current') return 'you are here';
    if (s === 'skipped') return 'passed over';
    return 'not yet';
  }

  function renderDetail(host, step) {
    var box = el('div', { class: 'dg-sp-detail' });
    box.appendChild(el('b', {}, step.ordinal + '. ' + step.title + '  (' + stateWord(step.state) + ')'));
    box.appendChild(el('div', {}, step.body));
    if (step.note) box.appendChild(el('div', { class: 'dg-sp-note' }, step.note));

    var row = el('div', { class: 'dg-sp-steps' });
    var go = resolveTarget(step.opens);
    if (go) {
      var b = el('button', { class: 'dg-sp-btn' }, 'Take me there');
      b.addEventListener('click', function () { go(); });
      row.appendChild(b);
    } else {
      box.appendChild(el('div', { class: 'dg-sp-note' }, 'That surface is not mounted in this build, so there is nothing to open from here.'));
    }
    if (step.also) {
      var alsoGo = resolveTarget(step.also);
      if (alsoGo) {
        var b2 = el('button', { class: 'dg-sp-btn' }, step.alsoLabel || 'Also');
        b2.addEventListener('click', function () { alsoGo(); });
        row.appendChild(b2);
      }
    }
    if (row.childNodes.length) box.appendChild(row);
    box.appendChild(el('div', { class: 'dg-sp-note' }, 'Marked done when: ' + step.doneWhen));
    host.appendChild(box);
  }

  function render() {
    var rail = document.getElementById(RAIL_ID);
    if (!rail) return;
    var model = spine();
    if (!model) {
      rail.style.display = 'none';
      return;
    }
    rail.innerHTML = '';

    var top = el('div', { class: 'dg-sp-top' });
    top.appendChild(el('span', { class: 'dg-sp-title' }, model.title));
    top.appendChild(el('span', { class: 'dg-sp-head' }, model.headline));
    /* Bundle 15: Repair Ledger chip lives in the rail's Prove/Ship area, next
       to Hide, so the ledger is findable from the same strip that already
       names the path rather than a new top-nav item. Only rendered when both
       this flag and the ledger panel itself are mounted. */
    if (ledgerSpineOn()) {
      var ledgerGo = resolveTarget('open-ledger');
      if (ledgerGo) {
        var ledgerBtn = el('button', {
          id: LEDGER_CHIP_ID,
          class: 'dg-sp-ledger-btn',
          type: 'button',
          title: 'Applied steps: every repair step logged this session',
        }, 'Repair Ledger');
        ledgerBtn.addEventListener('click', function () { ledgerGo(); });
        top.appendChild(ledgerBtn);
      }
    }
    var hide = el('button', { class: 'dg-sp-btn' }, 'Hide');
    hide.addEventListener('click', function () { dismiss(); });
    top.appendChild(hide);
    rail.appendChild(top);

    var steps = el('div', { class: 'dg-sp-steps' });
    for (var i = 0; i < model.steps.length; i++) {
      (function (step) {
        var b = el('button', {
          class: 'dg-sp-step',
          'data-state': step.state,
          type: 'button',
          title: step.oneLine,
          'aria-expanded': state.expandedId === step.id ? 'true' : 'false',
        }, step.ordinal + '. ' + step.title);
        b.addEventListener('click', function () {
          state.expandedId = state.expandedId === step.id ? '' : step.id;
          render();
        });
        steps.appendChild(b);
      })(model.steps[i]);
    }
    rail.appendChild(steps);

    if (state.expandedId) {
      var chosen = model.steps.filter(function (s) { return s.id === state.expandedId; })[0];
      if (chosen) renderDetail(rail, chosen);
    } else {
      rail.appendChild(el('p', { class: 'dg-sp-note' }, model.doctrine));
    }

    rail.style.display = 'block';
  }

  function refreshChip() {
    var chip = document.getElementById(CHIP_ID);
    if (chip) {
      var model = spine();
      var eng = engine('DataGlowReceiptSpine');
      var label = 'Start here';
      if (eng && typeof eng.spineChipLabel === 'function') {
        try { label = eng.spineChipLabel(model); } catch (_e) {}
      }
      chip.textContent = label;
      chip.style.display = state.open ? 'none' : 'inline-block';
    }

    /* The Repair Ledger chip stays findable even when the rail itself is
       collapsed: it is not part of what "Hide" hides, because it answers a
       different question (what has this session done so far) than the rail
       does (where am I in the path). */
    var ledgerChip = document.getElementById(LEDGER_CHIP_ID);
    if (!ledgerChip && ledgerSpineOn() && !state.open) {
      var ledgerGo2 = resolveTarget('open-ledger');
      if (ledgerGo2 && document.body) {
        var collapsedLedgerBtn = el('button', {
          id: LEDGER_CHIP_ID,
          class: 'dg-sp-ledger-btn',
          type: 'button',
          style: 'position:fixed;bottom:18px;left:340px;z-index:2147482900;box-shadow:0 2px 8px rgba(0,0,0,.14)',
          title: 'Applied steps: every repair step logged this session',
        }, 'Repair Ledger');
        collapsedLedgerBtn.addEventListener('click', function () { ledgerGo2(); });
        document.body.appendChild(collapsedLedgerBtn);
      }
    } else if (ledgerChip && state.open) {
      /* Rail is open and renders its own copy inside the top row; drop the
         floating collapsed one so there are never two at once. */
      if (ledgerChip.parentNode === document.body) {
        ledgerChip.parentNode.removeChild(ledgerChip);
      }
    }
  }

  function open() {
    state.open = true;
    render();
    refreshChip();
  }

  function dismiss() {
    var rail = document.getElementById(RAIL_ID);
    state.open = false;
    if (rail) rail.style.display = 'none';
    remember(SEEN_KEY);
    refreshChip();
    toast('Start here hidden. The chip on the left reopens it.');
  }

  function mount() {
    if (!spineOn()) return;
    if (document.getElementById(RAIL_ID)) return;
    if (!document.body) return;
    if (!engine('DataGlowReceiptSpine')) return;
    styles();

    state.open = !remembered(SEEN_KEY);

    document.body.appendChild(el('div', { id: RAIL_ID, role: 'region', 'aria-label': 'Start here' }));
    var chip = el('button', { id: CHIP_ID, type: 'button' }, 'Start here');
    chip.addEventListener('click', open);
    document.body.appendChild(chip);

    if (state.open) render();
    refreshChip();

    /* The rail is a claim about what has happened so far, and things happen
       while it is on screen. Re-observe rather than freeze. */
    try {
      setInterval(function () {
        try { if (state.open) render(); refreshChip(); } catch (_e) {}
      }, 5000);
    } catch (_e2) {}
  }

  function boot() {
    try { mount(); } catch (_e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1200); });
  } else {
    setTimeout(boot, 1200);
  }

  window.DataGlowReceiptSpineUI = {
    version: 1,
    mounted: function () { return !!document.getElementById(RAIL_ID); },
    open: open,
    dismiss: dismiss,
    isOpen: function () { return state.open === true; },
    refresh: render,
    model: spine,
    resolveTarget: resolveTarget,
  };
})();
/* ---- end js/spine/data-glow-receipt-spine-canvas.js ---- */
