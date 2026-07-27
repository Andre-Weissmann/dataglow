/*
 * DATAGLOW - R1 Project Run: the guided-spine drawer.
 *
 * A drawer, opened deliberately (from the bottom "Projects" tab or a
 * post-load spotlight action), naming the seven steps of one run on one
 * dataset -- Ingest, Purpose, Validate, Scout, Prove, Narrate, Export -- each
 * marked todo, doing, done or blocked. It is not the RECEIPT spine's
 * permanent bottom rail (js/spine/data-glow-receipt-spine-canvas.js), which
 * answers "where does this product begin" every session; this answers "did
 * THIS run, on THIS dataset, actually finish".
 *
 * WHY THE CHECKLIST PERSISTS PER DATASET NAME HASH.
 * Closing the drawer and reopening it later (even after a reload) should
 * find the SAME run where it was left, for the SAME dataset -- and a
 * different dataset loaded later should start its own, separate checklist
 * rather than inherit whatever the last dataset's run looked like. Each
 * dataset's checklist is written under its own localStorage key, keyed by
 * `DataGlowProjectRun.storageKeyForDataset(name)` (a short deterministic
 * hash of the dataset's name, not a security boundary -- see the engine
 * module's header).
 *
 * WHY AUTO-ADVANCE ONLY EVER MOVES A STEP TO DONE, NEVER BACKWARD.
 * The seven done-signals (table loaded, purpose signed, validation viewed,
 * a keeper kept, a GREEN verdict, a narrative draft, an export confirmed)
 * are read fresh on every render exactly like the RECEIPT spine reads its
 * own five, and a step that was never touched can be marked `blocked` by
 * hand -- but nothing in this file ever un-does a `done`. Once true, a
 * done-signal can stay true even if, say, the query result panel is later
 * cleared; treating that as regression would make the checklist flicker
 * between done and not-done as a person keeps working, which is worse than
 * a checklist that only ever moves forward within a session.
 *
 * WHY MISSING SURFACES RENDER AS TEXT, NOT DEAD BUTTONS.
 * Same discipline as the RECEIPT spine's resolveTarget: a step whose target
 * surface is not mounted in this build (a flag off, a panel not present)
 * shows a plain sentence instead of a button that does nothing when clicked.
 */
;(function () {
  'use strict';

  var DRAWER_ID = 'dg-project-run-drawer';
  var OVERLAY_ID = 'dg-project-run-overlay';
  var CHIP_ID = 'dg-project-run-chip';
  var STYLE_ID = 'dg-project-run-styles';

  var state = { open: false, expandedId: '' };

  function flag(explicitKey, flagKey) {
    try { if (window[explicitKey] === false) return false; } catch (_e0) {}
    try { if (window[explicitKey] === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled(flagKey) !== false;
      }
      if (window.FEATURE_FLAGS && Object.prototype.hasOwnProperty.call(window.FEATURE_FLAGS, flagKey)) {
        return window.FEATURE_FLAGS[flagKey] !== false;
      }
    } catch (_e) {}
    return true;
  }

  function projectRunOn() { return flag('DATAGLOW_PROJECT_RUN', 'projectRun'); }

  function engine(name) {
    try { return window[name] || null; } catch (_e) { return null; }
  }

  function core() { return engine('DataGlowProjectRun'); }

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
    try { console.log('[project-run] ' + message); } catch (_e2) {}
  }

  /* ---------------------------------------------------------------
     Dataset identity + persisted storage.
     --------------------------------------------------------------- */

  function activeDatasetName() {
    try {
      var ds = typeof window.getActiveDataset === 'function' ? window.getActiveDataset() : null;
      if (ds && typeof ds.name === 'string' && ds.name.trim()) return ds.name.trim();
    } catch (_e) {}
    try {
      if (window.state && Array.isArray(window.state.datasets) && window.state.datasets.length) {
        var last = window.state.datasets[window.state.datasets.length - 1];
        if (last && typeof last.name === 'string' && last.name.trim()) return last.name.trim();
      }
    } catch (_e2) {}
    return '';
  }

  function storageKey(name) {
    var eng = core();
    if (eng && typeof eng.storageKeyForDataset === 'function') return eng.storageKeyForDataset(name);
    return 'dataglow.projectRun.' + (name || 'untitled');
  }

  function readStored(name) {
    try {
      if (!window.localStorage) return {};
      var raw = window.localStorage.getItem(storageKey(name));
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_e) { return {}; }
  }

  function writeStored(name, statuses) {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(storageKey(name), JSON.stringify(statuses));
    } catch (_e) {}
  }

  /* ---------------------------------------------------------------
     Observation. Every signal is a question asked of the engine that owns
     the answer, defensively, so a build missing a given surface reads as
     "not done yet" rather than throwing.
     --------------------------------------------------------------- */

  function hasTable() {
    try {
      var ds = typeof window.getActiveDataset === 'function' ? window.getActiveDataset() : null;
      if (ds) return true;
      if (window.state && Array.isArray(window.state.datasets) && window.state.datasets.length > 0) return true;
    } catch (_e) {}
    return false;
  }

  function purposeSigned() {
    try {
      if (window.PurposeContract && typeof window.PurposeContract.isSigned === 'function') {
        return window.PurposeContract.isSigned() === true;
      }
      if (window.PurposeContract && typeof window.PurposeContract.getContract === 'function') {
        var c = window.PurposeContract.getContract();
        return !!(c && (c.purpose || c.signedAt));
      }
    } catch (_e) {}
    return signalSeen.purposeSigned;
  }

  function validationViewed() {
    return signalSeen.validationViewed;
  }

  function keepersCount() {
    return signalSeen.keepersCount || 0;
  }

  function proveGreenCount() {
    try {
      var ph = engine('DataGlowProofHarness');
      if (ph && typeof ph.getReceipts === 'function') {
        var receipts = ph.getReceipts() || [];
        var n = 0;
        for (var i = 0; i < receipts.length; i++) {
          var r = receipts[i];
          try {
            if (r && r.record && r.record.predicate && r.record.predicate.verdict &&
                r.record.predicate.verdict.state === 'GREEN') n++;
          } catch (_ei) {}
        }
        if (n > 0) return n;
      }
    } catch (_e) {}
    return signalSeen.proveGreenCount || 0;
  }

  function narrativeDraft() {
    try {
      if (window.state && window.state.lastStory) return true;
    } catch (_e) {}
    return signalSeen.narrativeDraft;
  }

  function exportDone() {
    return signalSeen.exportDone;
  }

  /* Events this app already fires, listened for once at mount time, that
     this module cannot otherwise observe from a public getter. These never
     mark a step done by themselves before the corresponding real evidence
     exists -- they are a fallback for the (validate/scout/narrate/export)
     signals that have no queryable window API, same honesty rule the
     RECEIPT spine applies to `hasShipped`. */
  var signalSeen = {
    purposeSigned: false,
    validationViewed: false,
    keepersCount: 0,
    proveGreenCount: 0,
    narrativeDraft: false,
    exportDone: false,
  };

  function wireObservers() {
    document.addEventListener('dataglow:contract-signed', function () {
      signalSeen.purposeSigned = true;
      render();
    });
    document.addEventListener('dataglow:export-triggered', function () {
      signalSeen.exportDone = true;
      render();
    });
    /* Scout keeper events: the Question Scout canvas UI does not publish a
       keepers-count getter, so this listens for its own custom event if one
       is ever dispatched, and otherwise the "Take me there" affordance is
       the only path -- never invents a count from nothing. */
    document.addEventListener('dataglow:scout-keeper-added', function () {
      signalSeen.keepersCount = (signalSeen.keepersCount || 0) + 1;
      render();
    });
    document.addEventListener('dataglow:proof-harness-prefill', function () {
      /* Sending a keeper to Prove is itself evidence Scout produced
         something worth proving -- count it if nothing else already has. */
      if (!signalSeen.keepersCount) { signalSeen.keepersCount = 1; render(); }
    });
  }

  /* ---------------------------------------------------------------
     Targets. Same resolveTarget discipline as the RECEIPT spine: an intent
     becomes a function only when the surface it needs is actually mounted.
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
    if (intent === 'open-purpose') {
      return clickId('dg-pc-sign-btn') || function () {
        var p = document.getElementById('dg-purpose-contract-panel');
        if (p) p.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
    }
    if (intent === 'open-validate') {
      return clickId('tab-validate') || function () {
        signalSeen.validationViewed = true;
        var nb = document.querySelector('.nav-btn[data-view="analyze"]');
        if (nb) nb.click();
        render();
      };
    }
    if (intent === 'open-scout') {
      return clickId('dg-question-scout-btn');
    }
    if (intent === 'open-prove') {
      return clickId('dg-proof-harness-btn');
    }
    if (intent === 'open-narrate') {
      return clickId('story-trigger-btn');
    }
    if (intent === 'open-export') {
      return panel('DataGlowProofToPostUI', 'open') || clickId('sidebar-export-btn');
    }
    return null;
  }

  /* ---------------------------------------------------------------
     Model
     --------------------------------------------------------------- */

  function run() {
    var eng = core();
    if (!eng || typeof eng.buildProjectRun !== 'function') return null;
    var name = activeDatasetName();
    var stored = readStored(name);
    var model;
    try {
      model = eng.buildProjectRun({
        stored: stored,
        observed: {
          hasTable: hasTable(),
          purposeSigned: purposeSigned(),
          validationViewed: validationViewed(),
          keepersCount: keepersCount(),
          proveGreenCount: proveGreenCount(),
          narrativeDraft: narrativeDraft(),
          exportDone: exportDone(),
        },
      });
    } catch (_e) { return null; }
    model._datasetName = name;
    /* Persist auto-advanced statuses back so a reload keeps a done step
       done even for signals this module cannot re-observe cold (e.g. Scout
       keepers reset on reload but the fact one was kept this session should
       not vanish from the record). */
    if (name) writeStored(name, eng.toStoredStatuses(model));
    return model;
  }

  function setBlocked(stepId, blocked) {
    var eng = core();
    if (!eng) return;
    var name = activeDatasetName();
    var stored = readStored(name);
    var next = eng.setManualStatus(stored, stepId, blocked ? 'blocked' : 'todo');
    if (name) writeStored(name, next);
    render();
  }

  /* ---------------------------------------------------------------
     Rendering
     --------------------------------------------------------------- */

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      + '#' + OVERLAY_ID + '{position:fixed;inset:0;z-index:2147483000;display:none;'
      + 'background:rgba(0,0,0,.32)}'
      + '#' + OVERLAY_ID + '.open{display:block}'
      + '#' + DRAWER_ID + '{position:fixed;right:0;top:0;bottom:0;width:min(380px,92vw);z-index:2147483001;'
      + 'display:none;flex-direction:column;background:var(--color-surface,#fff);'
      + 'border-left:1px solid var(--color-border,#ccc);box-shadow:-6px 0 24px rgba(0,0,0,.16);'
      + 'padding:16px;font-size:13px;line-height:1.45;overflow-y:auto}'
      + '#' + DRAWER_ID + '.open{display:flex}'
      + '.dg-pr-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}'
      + '.dg-pr-title{font-weight:700;font-size:15px}'
      + '.dg-pr-dataset{opacity:.7;font-size:12px;margin-bottom:10px;word-break:break-word}'
      + '.dg-pr-progress{font-size:12px;opacity:.8;margin-bottom:10px}'
      + '.dg-pr-list{display:flex;flex-direction:column;gap:6px}'
      + '.dg-pr-step{border:1px solid var(--color-border,#ccc);border-radius:9px;padding:8px 10px;cursor:pointer;background:var(--color-surface,#fff);color:inherit}'
      + '.dg-pr-step[data-status="done"]{opacity:.62}'
      + '.dg-pr-step[data-status="doing"]{border-color:currentColor;border-width:2px;font-weight:700}'
      + '.dg-pr-step[data-status="blocked"]{border-style:dashed}'
      + '.dg-pr-row{display:flex;align-items:center;justify-content:space-between;gap:8px}'
      + '.dg-pr-badge{font-size:10px;text-transform:uppercase;letter-spacing:.03em;padding:2px 7px;border-radius:999px;'
      + 'border:1px solid var(--color-border,#ccc)}'
      + '.dg-pr-detail{margin-top:6px;font-size:12px;opacity:.85}'
      + '.dg-pr-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}'
      + '.dg-pr-btn{font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;cursor:pointer;'
      + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit}'
      + '.dg-pr-doctrine{opacity:.7;font-size:12px;margin-top:14px;padding-top:10px;border-top:1px solid var(--color-border,#ddd)}'
      + '#' + CHIP_ID + '{position:fixed;bottom:18px;right:18px;z-index:2147482950;'
      + 'font:inherit;font-size:12px;padding:6px 11px;border-radius:999px;cursor:pointer;display:none;'
      + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.14)}';
    var tag = el('style', { id: STYLE_ID });
    tag.textContent = css;
    (document.head || document.body).appendChild(tag);
  }

  function statusWord(s) {
    if (s === 'done') return 'done';
    if (s === 'doing') return 'doing';
    if (s === 'blocked') return 'blocked';
    return 'todo';
  }

  function renderDetail(host, step) {
    var box = el('div', { class: 'dg-pr-detail' });
    box.appendChild(el('div', {}, 'Marked done when: ' + step.doneWhen));

    var actions = el('div', { class: 'dg-pr-actions' });
    var go = resolveTarget(step.opens);
    if (go) {
      var b = el('button', { class: 'dg-pr-btn', type: 'button' }, 'Take me there');
      b.addEventListener('click', function () { go(); });
      actions.appendChild(b);
    } else {
      box.appendChild(el('div', {}, 'That surface is not mounted in this build.'));
    }
    var blockBtn = el('button', { class: 'dg-pr-btn', type: 'button' },
      step.status === 'blocked' ? 'Unblock' : 'Mark blocked');
    blockBtn.addEventListener('click', function () { setBlocked(step.id, step.status !== 'blocked'); });
    actions.appendChild(blockBtn);
    box.appendChild(actions);
    host.appendChild(box);
  }

  function render() {
    var drawer = document.getElementById(DRAWER_ID);
    if (!drawer) return;
    var model = run();
    drawer.innerHTML = '';
    if (!model) {
      drawer.appendChild(el('p', {}, 'Project Run is not available in this build.'));
      return;
    }

    var head = el('div', { class: 'dg-pr-head' });
    head.appendChild(el('span', { class: 'dg-pr-title' }, model.title));
    var closeBtn = el('button', { class: 'dg-pr-btn', type: 'button', 'aria-label': 'Close Project Run' }, 'Close');
    closeBtn.addEventListener('click', close);
    head.appendChild(closeBtn);
    drawer.appendChild(head);

    drawer.appendChild(el('div', { class: 'dg-pr-dataset' },
      model._datasetName ? 'Dataset: ' + model._datasetName : 'No dataset loaded yet.'));
    drawer.appendChild(el('div', { class: 'dg-pr-progress' }, model.headline));

    var list = el('div', { class: 'dg-pr-list' });
    model.steps.forEach(function (step) {
      var item = el('div', { class: 'dg-pr-step', 'data-status': step.status });
      var row = el('div', { class: 'dg-pr-row' });
      row.appendChild(el('span', {}, step.ordinal + '. ' + step.title));
      row.appendChild(el('span', { class: 'dg-pr-badge' }, statusWord(step.status)));
      item.appendChild(row);
      item.appendChild(el('div', { class: 'dg-pr-detail' }, step.oneLine));
      item.addEventListener('click', function (e) {
        if (e.target && e.target.tagName === 'BUTTON') return;
        state.expandedId = state.expandedId === step.id ? '' : step.id;
        render();
      });
      if (state.expandedId === step.id) renderDetail(item, step);
      list.appendChild(item);
    });
    drawer.appendChild(list);

    drawer.appendChild(el('p', { class: 'dg-pr-doctrine' }, model.doctrine));
  }

  function refreshChip() {
    var chip = document.getElementById(CHIP_ID);
    if (!chip) return;
    var model = run();
    var eng = core();
    var label = 'Project Run';
    if (eng && model && typeof eng.projectRunChipLabel === 'function') {
      try { label = eng.projectRunChipLabel(model); } catch (_e) {}
    }
    chip.textContent = label;
    chip.style.display = state.open ? 'none' : 'inline-block';
  }

  function open() {
    if (!document.getElementById(DRAWER_ID)) mount();
    state.open = true;
    var overlay = document.getElementById(OVERLAY_ID);
    var drawer = document.getElementById(DRAWER_ID);
    if (overlay) overlay.classList.add('open');
    if (drawer) drawer.classList.add('open');
    render();
    refreshChip();
  }

  function close() {
    state.open = false;
    var overlay = document.getElementById(OVERLAY_ID);
    var drawer = document.getElementById(DRAWER_ID);
    if (overlay) overlay.classList.remove('open');
    if (drawer) drawer.classList.remove('open');
    refreshChip();
  }

  function toggle() {
    if (state.open) close(); else open();
  }

  function mount() {
    if (!projectRunOn()) return;
    if (document.getElementById(DRAWER_ID)) return;
    if (!document.body) return;
    if (!core()) return;
    styles();

    var overlay = el('div', { id: OVERLAY_ID });
    overlay.addEventListener('click', close);
    document.body.appendChild(overlay);

    document.body.appendChild(el('div', { id: DRAWER_ID, role: 'dialog', 'aria-label': 'Project Run' }));

    var chip = el('button', { id: CHIP_ID, type: 'button' }, 'Project Run');
    chip.addEventListener('click', open);
    document.body.appendChild(chip);

    wireObservers();
    refreshChip();

    document.addEventListener('dataglow:dataset-loaded', function () {
      toast('Project Run: dataset loaded, Ingest marked done.');
      if (state.open) render();
      refreshChip();
    });

    /* Re-observe periodically while open, same as the RECEIPT spine, so the
       drawer never freezes on a stale snapshot while a person keeps
       working elsewhere on the page. */
    try {
      setInterval(function () {
        try { if (state.open) render(); refreshChip(); } catch (_e) {}
      }, 4000);
    } catch (_e2) {}
  }

  function boot() {
    try {
      mount();
      /* Entry point 1: the bottom "Projects" tab (js/nav/bottom-nav.js's
         #dg-tab-projects) calls a global openProjects() on click that has
         never been defined in this build -- a dead tap target on mobile.
         Project Run claims it, without touching the SEPARATE existing
         "Projects" dataset-workspace panel (#projects-panel /
         window.ProjectEngine, opened by #projects-trigger-btn), which is a
         different feature this module does not rename, hide or replace. */
      if (typeof window.openProjects !== 'function') {
        window.openProjects = function () { open(); };
      }
    } catch (_e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1000); });
  } else {
    setTimeout(boot, 1000);
  }

  window.DataGlowProjectRunUI = {
    version: 1,
    mounted: function () { return !!document.getElementById(DRAWER_ID); },
    open: open,
    close: close,
    toggle: toggle,
    isOpen: function () { return state.open === true; },
    refresh: render,
    model: run,
    resolveTarget: resolveTarget,
    /* Test/integration hook: lets the post-load spotlight (or any other
       caller) record a Scout/Narrate/Export signal this module has no
       public getter for, without reaching into its closure. Mirrors the
       receipt-spine's read-only philosophy but this module additionally
       exposes a narrow WRITE hook because, unlike the RECEIPT spine's five
       signals (all independently observable via other engines' public
       APIs), Scout's keeper count and a raw "narrative drafted" moment are
       not observable from outside their own panels in this build. */
    recordSignal: function (name) {
      if (Object.prototype.hasOwnProperty.call(signalSeen, name)) {
        if (name === 'keepersCount') signalSeen.keepersCount = (signalSeen.keepersCount || 0) + 1;
        else signalSeen[name] = true;
        if (state.open) render();
        refreshChip();
      }
    },
  };
})();
