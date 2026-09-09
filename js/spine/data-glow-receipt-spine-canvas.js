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
 *
 * WHY THE RAIL IS TRANSPARENT TO THE POINTER EXCEPT ON ITS OWN CONTROLS.
 * A signpost that swallows clicks is not a signpost, it is a wall. The rail is
 * fixed to the bottom of the viewport at a very high z-index, so every pixel of
 * its padding, its headline, its loaded line and its doctrine note used to sit
 * between the pointer and whatever is underneath. Playwright caught this first,
 * on the Synthetic Twin modal: the click never reached the button because the
 * loaded line and the Compound step were on top of it. A person hits the same
 * wall with the mouse, they just have no log line to read afterwards. So the
 * container carries pointer-events:none and only the things that are meant to
 * be pressed, the step chips, the buttons and the ledger chip, take it back
 * with pointer-events:auto. Nothing about the copy changes: the loaded line and
 * the headline still say exactly what they said, they simply stop intercepting.
 *
 * WHY THE RAIL STEPS ASIDE FOR A DIALOG.
 * pointer-events fixes the clicks that land on the rail's own text; it does not
 * fix the rail visually covering the bottom of a dialog that opened above it,
 * and it does not stop a step chip from sitting on a dialog's primary button.
 * A modal is a question the product is asking right now, and the answer to
 * "where do I begin" can wait. While any dialog is open, the rail and both
 * chips hide themselves. Nothing is remembered by that, so closing the dialog
 * brings the rail straight back in the state it was in. This is also what keeps
 * the bottom bar off the Excel sheet picker on a phone, where the picker's
 * lowest sheet button and the rail want the same 90 pixels.
 */
;(function () {
  'use strict';

  var RAIL_ID = 'dg-spine-rail';
  var CHIP_ID = 'dg-spine-chip';
  var STYLE_ID = 'dg-spine-styles';
  var SEEN_KEY = 'dataglow.receiptSpine.dismissed';
  var LEDGER_CHIP_ID = 'dg-spine-ledger-chip';

  var state = { open: true, expandedId: '', renderable: false };

  /* Every overlay convention in this codebase that means "a dialog is open":
     the app-shell modal (.modal-overlay.open), the command palette, the Excel
     sheet picker, anything that declares itself a modal dialog to assistive
     technology, and the native <dialog>. Matching on the open state rather than
     the class alone matters, because .modal-overlay is in the DOM at all times
     and only becomes visible when .open is added. */
  var OVERLAY_SELECTOR = '.modal-overlay.open,.command-palette-overlay.open,'
    + '#excel-sheet-picker,[role="dialog"][aria-modal="true"],dialog[open]';

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

  /* WHY THIS FUNCTION IS LONGER THAN IT LOOKS LIKE IT SHOULD BE.
     It used to ask only for window.loadedTables, window.currentTableName and
     window.DATAGLOW_STATE.tableName. None of those three exist in this build.
     So the answer was always false, Drop was never marked done, and the rail
     sat at the bottom of the screen reading "Next: Drop. Put a file in.
     Nothing is uploaded." with a workbook open and 56 rows on the table.
     A wrong observation is worse than a missing one, because everything
     downstream of it renders confidently.

     The dataset registry is the engine that owns this answer, and
     window.getActiveDataset() is how the rest of the canvas asks it. That is
     first now. The three old globals stay last as fallbacks for builds that
     do define them. */
  function hasTable() {
    try {
      if (typeof window.getActiveDataset === 'function' && window.getActiveDataset()) return true;
      if (window.state && Array.isArray(window.state.datasets) && window.state.datasets.length > 0) return true;
      if (Array.isArray(window.loadedTables) && window.loadedTables.length > 0) return true;
      if (window.currentTableName) return true;
      if (window.DATAGLOW_STATE && window.DATAGLOW_STATE.tableName) return true;
    } catch (_e) {}
    return false;
  }

  /** The name of what is loaded, so the rail can say it instead of guessing. */
  function activeTableName() {
    try {
      var ds = typeof window.getActiveDataset === 'function' ? window.getActiveDataset() : null;
      if (ds && (ds.name || ds.sheetName || ds.fileName)) return String(ds.name || ds.sheetName || ds.fileName);
      if (window.currentTableName) return String(window.currentTableName);
      if (window.DATAGLOW_STATE && window.DATAGLOW_STATE.tableName) return String(window.DATAGLOW_STATE.tableName);
    } catch (_e) {}
    return '';
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
        tableName: activeTableName(),
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
      /* pointer-events:none on the container is the whole point: the rail is
         drawn on top of the page, so it must not be in the way of it. The
         controls below take it back one at a time. */
      + '#' + RAIL_ID + '{position:fixed;left:0;right:0;bottom:0;z-index:2147482900;display:none;'
      + 'background:var(--color-surface,#fff);border-top:1px solid var(--color-border,#ccc);'
      + 'box-shadow:0 -4px 18px rgba(0,0,0,.10);padding:8px 14px;font-size:16px;line-height:1.45;'
      + 'pointer-events:none}'
      + '#' + RAIL_ID + ' .dg-sp-step,#' + RAIL_ID + ' .dg-sp-btn,'
      + '#' + RAIL_ID + ' .dg-sp-ledger-btn,#' + RAIL_ID + ' .dg-sp-detail{pointer-events:auto}'
      + '#' + RAIL_ID + ' .dg-sp-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}'
      + '#' + RAIL_ID + ' .dg-sp-title{font-weight:600}'
      + '#' + RAIL_ID + ' .dg-sp-head{opacity:.8;flex:1 1 240px;min-width:0}'
      /* The load line rides in the top row beside the headline rather than on a
         row of its own. A rail that grows taller starts covering the page
         behind it, which is how the first cut of this line broke a click on the
         panel underneath. When space runs out it is the file name that gets an
         ellipsis, never the sentence, so "not uploaded" is always readable; the
         full name stays in the title attribute and in the Drop step. Below
         700px the line takes its own row and wraps instead of truncating. */
      + '#' + RAIL_ID + ' .dg-sp-loaded{font-size:14px;opacity:.75;flex:0 1 auto;min-width:0;margin:0;'
      + 'white-space:nowrap;overflow:hidden}'
      + '#' + RAIL_ID + ' .dg-sp-loaded-name{display:inline-block;max-width:min(34vw,380px);'
      + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}'
      + '@media (max-width:700px){#' + RAIL_ID + ' .dg-sp-loaded{flex:0 1 100%;white-space:normal;'
      + 'overflow:visible;margin:2px 0 0}'
      + '#' + RAIL_ID + ' .dg-sp-loaded-name{display:inline;max-width:none;white-space:normal;'
      + 'overflow:visible;overflow-wrap:anywhere}}'
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
      + 'box-shadow:0 2px 8px rgba(0,0,0,.14);pointer-events:auto}'
      + '.dg-sp-ledger-btn{font:inherit;font-size:16px;padding:5px 10px;border-radius:7px;cursor:pointer;'
      + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit;'
      + 'font-weight:600}';
    var tag = el('style', { id: STYLE_ID });
    tag.textContent = css;
    (document.head || document.body).appendChild(tag);
  }

  /* ---------------------------------------------------------------
     Getting out of the way. Two separate jobs: never intercept a
     pointer that was not aimed at a control of ours, and never sit on
     top of a dialog.
     --------------------------------------------------------------- */

  /** True while any dialog is on screen. Cheap enough to ask on every frame. */
  function dialogOpen() {
    try {
      var rail = document.getElementById(RAIL_ID);
      var nodes = document.querySelectorAll(OVERLAY_SELECTOR);
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (rail && (node === rail || rail.contains(node))) continue;
        if (!node.offsetWidth && !node.offsetHeight && !node.getClientRects().length) continue;
        var cs = window.getComputedStyle ? window.getComputedStyle(node) : null;
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
        return true;
      }
    } catch (_e) {}
    return false;
  }

  /* Write only on change. This module watches the DOM for dialogs opening, and
     a write that changes nothing still counts as a mutation, which would put
     the observer in a loop with itself. */
  function setDisplay(node, value) {
    if (!node) return;
    try { if (node.style.display !== value) node.style.display = value; } catch (_e) {}
  }

  /** Rail and chips visible only when they are wanted and nothing is on top. */
  function syncOverlay() {
    var blocked = dialogOpen();
    var rail = document.getElementById(RAIL_ID);
    if (rail) setDisplay(rail, (state.open && state.renderable && !blocked) ? 'block' : 'none');
    var chip = document.getElementById(CHIP_ID);
    if (chip) setDisplay(chip, (state.open || blocked) ? 'none' : 'inline-block');
    var ledgerChip = document.getElementById(LEDGER_CHIP_ID);
    if (ledgerChip && ledgerChip.parentNode === document.body) {
      setDisplay(ledgerChip, blocked ? 'none' : 'inline-block');
    }
  }

  /* A dialog can open at any moment, and the five second re-observation poll is
     far too slow to be the thing that moves a bottom bar off a sheet picker. So
     watch the document instead and answer within a frame. The handler is
     debounced to once per frame and does one querySelectorAll, so a page busy
     rendering a table does not pay for this more than once per paint. */
  function watchOverlays() {
    var pending = false;
    function run() {
      pending = false;
      try { syncOverlay(); } catch (_e) {}
    }
    function schedule() {
      if (pending) return;
      pending = true;
      try {
        if (typeof window.requestAnimationFrame === 'function') { window.requestAnimationFrame(run); return; }
      } catch (_e) {}
      setTimeout(run, 16);
    }
    try {
      if (typeof window.MutationObserver === 'function' && document.body) {
        new window.MutationObserver(schedule).observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'open', 'aria-modal', 'role'],
        });
      }
    } catch (_e2) {}
    /* Belt and braces for anything that opens a dialog without touching the
       attributes above, and for builds with no MutationObserver. */
    try { setInterval(schedule, 400); } catch (_e3) {}
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
      state.renderable = false;
      rail.style.display = 'none';
      return;
    }
    state.renderable = true;
    rail.innerHTML = '';

    var top = el('div', { class: 'dg-sp-top' });
    top.appendChild(el('span', { class: 'dg-sp-title' }, model.title));
    top.appendChild(el('span', { class: 'dg-sp-head' }, model.headline));
    /* Said plainly and in one place: what is loaded, or that nothing is. The
       model computes this line so the rail cannot drift out of step with the
       state it just read. */
    if (model.loadedLine) {
      var loaded = el('p', { class: 'dg-sp-loaded', title: model.loadedLine });
      if (model.tableName && model.loadedLine.indexOf(model.tableName) !== -1) {
        // Same sentence the model computed, split only so the name can shrink.
        var pieces = model.loadedLine.split(model.tableName);
        loaded.appendChild(document.createTextNode(pieces[0]));
        loaded.appendChild(el('span', { class: 'dg-sp-loaded-name' }, model.tableName));
        loaded.appendChild(document.createTextNode(pieces.slice(1).join(model.tableName)));
      } else {
        loaded.textContent = model.loadedLine;
      }
      top.appendChild(loaded);
    }
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

    /* Not an unconditional display:block any more: if a dialog is open the rail
       has already given up its place on screen, and re-rendering must not take
       it back. */
    syncOverlay();
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
      setDisplay(chip, (state.open || dialogOpen()) ? 'none' : 'inline-block');
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
    if (rail) setDisplay(rail, 'none');
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
    watchOverlays();
    syncOverlay();

    /* The rail is a claim about what has happened so far, and things happen
       while it is on screen. Re-observe rather than freeze. */
    try {
      setInterval(function () {
        try { if (state.open) render(); refreshChip(); } catch (_e) {}
      }, 5000);
    } catch (_e2) {}

    /* A five second poll means the rail can spend five seconds telling someone
       no file is loaded immediately after they loaded one. Loading a table is
       announced, so listen for it and re-read at once. */
    try {
      ['dataglow:dataset-loaded', 'dataglow:dataset-updated', 'dataglow:query-complete']
        .forEach(function (evt) {
          window.addEventListener(evt, function () {
            try { if (state.open) render(); refreshChip(); } catch (_e3) {}
          });
        });
    } catch (_e4) {}
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
