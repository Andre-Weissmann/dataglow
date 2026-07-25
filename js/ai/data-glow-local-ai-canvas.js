/* ---- from js/ai/data-glow-local-ai-canvas.js ---- */
/*
 * DATAGLOW - Built-in AI status, ambient proof and capability ceiling surface.
 *
 * DataGlow has been running a language model on the user's own machine for
 * months and there was nowhere on the page that said so. The most distinctive
 * property of the product was invisible. This surface fixes that with a chip
 * that is always present and a panel behind it that says, in order: what the
 * built-in AI is, what state it is in right now and why, what the proof
 * situation is, and where the product stops.
 *
 * WHY THE CHIP READS THE MACHINE ON EVERY RENDER.
 * WebGPU can be absent, Air-Gap Mode can be toggled mid-session, and the model
 * can finish loading while the panel is open. A chip rendered once is a chip
 * that is wrong later, so every render re-observes and re-derives. The
 * derivation itself lives in the pure engine; this file only reports what it
 * can see.
 *
 * WHY THE CEILING IS IN THE SAME PANEL AS THE AI STATUS.
 * They answer the same question. Someone reading "Built-in AI: ready" is
 * forming a belief about what this thing can do, and the honest completion of
 * that sentence is the list of what it cannot. Putting the ceiling behind a
 * separate Help link would let the optimistic half travel on its own.
 *
 * Everything is feature-detected. A missing engine removes a section rather
 * than throwing, because this panel mounts over builds that inline different
 * subsets of the modules.
 */
;(function () {
  'use strict';

  var CHIP_ID = 'dg-lai-chip';
  var PANEL_ID = 'dg-lai-panel';
  var STYLE_ID = 'dg-lai-styles';

  var state = { open: false, tab: 'ai', copiedOnce: false };

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

  function statusOn() { return flag('DATAGLOW_LOCAL_AI_STATUS', 'localAiStatus'); }
  function ambientOn() { return flag('DATAGLOW_AMBIENT_PROOF_STRIP', 'ambientProofStrip'); }
  function ceilingOn() { return flag('DATAGLOW_CAPABILITY_CEILING', 'capabilityCeiling'); }
  function polarsOn() { return flag('DATAGLOW_POLARS_SECONDARY_PATH', 'polarsSecondaryPath'); }

  function engine(name) {
    try { return window[name] || null; } catch (_e) { return null; }
  }

  function askHuman(question) {
    try {
      if (typeof window.confirm === 'function') return window.confirm(question) === true;
    } catch (_e) {}
    return false;
  }

  function toast(message) {
    try {
      if (typeof window.showToast === 'function') { window.showToast(message); return; }
    } catch (_e) {}
    try { console.log('[local-ai] ' + message); } catch (_e2) {}
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

  /* ---------------------------------------------------------------
     Observation. Four facts about this machine, each read defensively,
     because every one of them lives behind an API that may not exist.
     --------------------------------------------------------------- */

  function hasWebGPU() {
    try {
      if (typeof navigator === 'undefined') return false;
      return !!navigator.gpu;
    } catch (_e) { return false; }
  }

  function modelIsLoaded() {
    var llm = engine('OnDeviceLLM');
    if (!llm) return false;
    try {
      if (typeof llm.isModelLoaded === 'function') return llm.isModelLoaded() === true;
    } catch (_e) {}
    return false;
  }

  function airGapIsOn() {
    var ag = engine('DataGlowAirGap');
    if (ag) {
      try {
        if (typeof ag.isAirGapEnabled === 'function') return ag.isAirGapEnabled() === true;
        if (typeof ag.isEnabled === 'function') return ag.isEnabled() === true;
      } catch (_e) {}
    }
    try { if (window.DATAGLOW_AIR_GAP === true) return true; } catch (_e2) {}
    return false;
  }

  function pythonIsReady() {
    try {
      if (window.DataGlowPython && typeof window.DataGlowPython.isReady === 'function') {
        return window.DataGlowPython.isReady() === true;
      }
    } catch (_e) {}
    return false;
  }

  function platformName() {
    try {
      if (window.DATAGLOW_PLATFORM === 'desktop') return 'desktop';
      if (window.__TAURI__ || window.electronAPI) return 'desktop';
    } catch (_e) {}
    return 'web';
  }

  function aiStatus() {
    var eng = engine('DataGlowLocalAiStatus');
    if (!eng || typeof eng.buildLocalAiStatus !== 'function') return null;
    try {
      return eng.buildLocalAiStatus({
        webgpu: hasWebGPU(),
        modelLoaded: modelIsLoaded(),
        loading: false,
        airGap: airGapIsOn(),
        modelCached: false,
        enabled: statusOn(),
        platform: platformName(),
      });
    } catch (_e) { return null; }
  }

  function ambientStrip() {
    var eng = engine('DataGlowAmbientProof');
    if (!eng || typeof eng.buildAmbientProofStrip !== 'function') return null;
    var caveats = 0;
    try {
      var board = engine('DataGlowProofBoardUI');
      if (board && typeof board.tiles === 'function') {
        var tiles = board.tiles() || [];
        for (var i = 0; i < tiles.length; i++) {
          if (tiles[i] && tiles[i].gateBadge && tiles[i].gateBadge !== 'clear') caveats++;
        }
      }
    } catch (_e) {}
    try {
      return eng.buildAmbientProofStrip({
        prove: lastProve(),
        airGap: airGapIsOn(),
        openCaveats: caveats,
      });
    } catch (_e2) { return null; }
  }

  /* The last gate result this session, if some surface recorded one. Nothing
     is fabricated when none has: the strip reports "nothing checked yet",
     which is the truth and is not a pass. */
  function lastProve() {
    try {
      var p2p = engine('DataGlowProofToPostUI');
      if (p2p && typeof p2p.pack === 'function') {
        var pack = p2p.pack();
        if (pack && pack.validation) return pack.validation;
      }
    } catch (_e) {}
    return null;
  }

  function ceiling() {
    var eng = engine('DataGlowCapabilityCeiling');
    if (!eng || typeof eng.buildCapabilityCeiling !== 'function') return null;
    try { return eng.buildCapabilityCeiling({ platform: platformName() }); } catch (_e) { return null; }
  }

  function polars() {
    var eng = engine('DataGlowPolarsPath');
    if (!eng || typeof eng.buildPolarsAvailability !== 'function') return null;
    try {
      return eng.buildPolarsAvailability({ pythonReady: pythonIsReady(), pyodideHasPolars: false, platform: platformName() });
    } catch (_e) { return null; }
  }

  /* ---------------------------------------------------------------
     Rendering
     --------------------------------------------------------------- */

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      + '#' + PANEL_ID + '{position:fixed;bottom:60px;right:16px;width:min(520px,calc(100vw - 32px));'
      + 'max-height:min(72vh,720px);overflow:auto;z-index:2147483000;display:none;'
      + 'background:var(--color-surface,#fff);color:inherit;border:1px solid var(--color-border,#ccc);'
      + 'border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.22);padding:16px;font-size:13px;line-height:1.5}'
      + '#' + PANEL_ID + ' h3{margin:0 0 2px;font-size:15px}'
      + '#' + PANEL_ID + ' h4{margin:14px 0 4px;font-size:13px}'
      + '.dg-lai-note{opacity:.75;font-size:12px;margin:6px 0}'
      + '.dg-lai-btn{font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;cursor:pointer;'
      + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit}'
      + '.dg-lai-btn[aria-selected="true"]{font-weight:600;border-color:currentColor}'
      + '.dg-lai-row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}'
      + '.dg-lai-fact{border:1px solid var(--color-border,#ddd);border-radius:8px;padding:8px 10px;margin:6px 0}'
      + '.dg-lai-fact b{display:block;font-size:12px;opacity:.7;font-weight:600}'
      + '.dg-lai-not{margin:4px 0 0;padding-left:10px;border-left:2px solid currentColor;opacity:.9}';
    var tag = el('style', { id: STYLE_ID });
    tag.textContent = css;
    (document.head || document.body).appendChild(tag);
  }

  function chipText() {
    var eng = engine('DataGlowLocalAiStatus');
    var st = aiStatus();
    if (eng && typeof eng.statusChipLabel === 'function') {
      try { return eng.statusChipLabel(st); } catch (_e) {}
    }
    return 'Built-in AI';
  }

  function renderAiTab(host) {
    var st = aiStatus();
    var eng = engine('DataGlowLocalAiStatus');
    if (!st || !eng) {
      host.appendChild(el('p', { class: 'dg-lai-note' }, 'The built-in AI status engine is not present in this build.'));
      return;
    }

    var top = el('div', { class: 'dg-lai-fact' });
    top.appendChild(el('b', {}, st.headline));
    top.appendChild(el('div', {}, st.detail));
    if (st.nextStep) top.appendChild(el('div', { class: 'dg-lai-note' }, st.nextStep));
    host.appendChild(top);

    host.appendChild(el('h4', {}, 'What the built-in AI does'));
    var list = eng.WHAT_BUILT_IN_AI_DOES || [];
    for (var i = 0; i < list.length; i++) {
      var f = el('div', { class: 'dg-lai-fact' });
      f.appendChild(el('b', {}, list[i].title));
      f.appendChild(el('div', {}, list[i].body));
      host.appendChild(f);
    }
    host.appendChild(el('p', { class: 'dg-lai-note' }, eng.AI_DIVISION_OF_LABOUR));

    host.appendChild(el('h4', {}, 'The model'));
    host.appendChild(el('div', {}, st.modelLabel));
    var models = typeof eng.listRecommendedLocalModels === 'function' ? eng.listRecommendedLocalModels() : [];
    for (var j = 0; j < models.length; j++) {
      var m = models[j];
      var row = el('div', { class: 'dg-lai-fact' });
      row.appendChild(el('b', {}, m.label + '  (' + m.fit.replace(/_/g, ' ') + ')'));
      row.appendChild(el('div', {}, m.sizeHint + ', ' + m.license));
      row.appendChild(el('div', { class: 'dg-lai-note' }, m.why));
      host.appendChild(row);
    }
    host.appendChild(el('p', { class: 'dg-lai-note' }, eng.NOT_A_CERTIFICATION_NOTE));
  }

  function renderAmbientTab(host) {
    var strip = ambientStrip();
    var eng = engine('DataGlowAmbientProof');
    if (!strip || !eng) {
      host.appendChild(el('p', { class: 'dg-lai-note' }, 'The ambient proof engine is not present in this build.'));
      return;
    }
    var top = el('div', { class: 'dg-lai-fact' });
    top.appendChild(el('b', {}, strip.label));
    top.appendChild(el('div', {}, strip.doctrine));
    host.appendChild(top);

    for (var i = 0; i < strip.facts.length; i++) {
      var f = strip.facts[i];
      var row = el('div', { class: 'dg-lai-fact' });
      row.appendChild(el('b', {}, f.label));
      row.appendChild(el('div', {}, f.value));
      row.appendChild(el('div', { class: 'dg-lai-note' }, f.detail));
      host.appendChild(row);
    }
    host.appendChild(el('p', { class: 'dg-lai-note' }, strip.outboundRule));
    host.appendChild(el('p', { class: 'dg-lai-note' }, strip.note));
  }

  function renderCeilingTab(host) {
    var c = ceiling();
    if (!c) {
      host.appendChild(el('p', { class: 'dg-lai-note' }, 'The capability ceiling engine is not present in this build.'));
      return;
    }
    host.appendChild(el('p', { class: 'dg-lai-note' }, c.preamble));
    for (var i = 0; i < c.groups.length; i++) {
      var g = c.groups[i];
      var row = el('div', { class: 'dg-lai-fact' });
      row.appendChild(el('b', {}, g.title));
      row.appendChild(el('div', {}, g.does));
      row.appendChild(el('div', { class: 'dg-lai-not' }, g.notThis));
      if (g.detail) row.appendChild(el('div', { class: 'dg-lai-note' }, g.detail));
      host.appendChild(row);
    }

    if (polarsOn()) {
      var p = polars();
      if (p) {
        var pr = el('div', { class: 'dg-lai-fact' });
        pr.appendChild(el('b', {}, p.label));
        pr.appendChild(el('div', {}, p.detail));
        pr.appendChild(el('div', { class: 'dg-lai-note' }, p.primaryEngine));
        host.appendChild(pr);
      }
    }

    host.appendChild(el('p', { class: 'dg-lai-note' }, c.closing));

    var row2 = el('div', { class: 'dg-lai-row' });
    var copyBtn = el('button', { class: 'dg-lai-btn' }, 'Copy as markdown');
    copyBtn.addEventListener('click', function () { copyCeiling(); });
    row2.appendChild(copyBtn);
    host.appendChild(row2);
  }

  /* The one outbound action on this panel. It writes to the clipboard, which is
     a way data leaves the app, so it asks first exactly like every other
     outbound path in the product. */
  function copyCeiling() {
    var eng = engine('DataGlowCapabilityCeiling');
    var c = ceiling();
    if (!eng || !c || typeof eng.renderCeilingMarkdown !== 'function') { toast('Nothing to copy.'); return; }
    if (!askHuman('Copy the capability ceiling to your clipboard as markdown?')) { toast('Not copied.'); return; }
    var text = eng.renderCeilingMarkdown(c);
    try {
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(function () {
          state.copiedOnce = true;
          toast('Capability ceiling copied.');
        }, function () { toast('The browser refused the clipboard.'); });
        return;
      }
    } catch (_e) {}
    toast('No clipboard access in this browser.');
  }

  function render() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.innerHTML = '';

    var head = el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:10px' });
    var titleWrap = el('div');
    titleWrap.appendChild(el('h3', {}, 'Built-in AI, on this machine'));
    titleWrap.appendChild(el('div', { class: 'dg-lai-note', style: 'margin:0' }, 'What it is, what state it is in, and where it stops.'));
    head.appendChild(titleWrap);
    var closeBtn = el('button', { class: 'dg-lai-btn' }, 'Close');
    closeBtn.addEventListener('click', close);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var tabs = el('div', { class: 'dg-lai-row', role: 'tablist' });
    var defs = [['ai', 'Built-in AI']];
    if (ambientOn()) defs.push(['ambient', 'Ambient proof']);
    if (ceilingOn()) defs.push(['ceiling', 'What this machine can do']);
    if (defs.length > 1) {
      for (var i = 0; i < defs.length; i++) {
        (function (key, label) {
          var b = el('button', { class: 'dg-lai-btn', role: 'tab', 'aria-selected': state.tab === key ? 'true' : 'false' }, label);
          b.addEventListener('click', function () { state.tab = key; render(); });
          tabs.appendChild(b);
        })(defs[i][0], defs[i][1]);
      }
      panel.appendChild(tabs);
    }

    var body = el('div');
    panel.appendChild(body);
    if (state.tab === 'ambient' && ambientOn()) renderAmbientTab(body);
    else if (state.tab === 'ceiling' && ceilingOn()) renderCeilingTab(body);
    else renderAiTab(body);
  }

  function refreshChip() {
    var chip = document.getElementById(CHIP_ID);
    if (!chip) return;
    chip.textContent = chipText();
    var st = aiStatus();
    chip.setAttribute('title', st ? st.detail : 'Built-in AI status');
  }

  function open() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    state.open = true;
    panel.style.display = 'block';
    render();
  }

  function close() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    state.open = false;
    panel.style.display = 'none';
  }

  function mount() {
    if (!statusOn()) return;
    if (document.getElementById(CHIP_ID)) return;
    if (!document.body) return;
    styles();

    var chip = el('button', {
      id: CHIP_ID,
      type: 'button',
      style: 'position:fixed;bottom:18px;left:18px;z-index:2147483000;'
        + 'font:inherit;font-size:12px;padding:6px 11px;border-radius:999px;cursor:pointer;'
        + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit;'
        + 'box-shadow:0 2px 8px rgba(0,0,0,.14)',
    }, chipText());
    chip.addEventListener('click', function () { if (state.open) close(); else open(); });
    document.body.appendChild(chip);
    document.body.appendChild(el('div', { id: PANEL_ID, role: 'dialog', 'aria-label': 'Built-in AI status' }));
    refreshChip();

    /* Re-observe on a slow interval. The chip is a claim about right now, and
       WebGPU, Air-Gap Mode and model loadedness all change without telling us. */
    try {
      setInterval(function () {
        try { refreshChip(); if (state.open) render(); } catch (_e) {}
      }, 5000);
    } catch (_e2) {}
  }

  function boot() {
    try { mount(); } catch (_e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1000); });
  } else {
    setTimeout(boot, 1000);
  }

  window.DataGlowLocalAiUI = {
    version: 1,
    mounted: function () { return !!document.getElementById(CHIP_ID); },
    open: open,
    close: close,
    isOpen: function () { return state.open === true; },
    refresh: render,
    chipText: chipText,
    status: aiStatus,
    ambient: ambientStrip,
    ceiling: ceiling,
    polars: polars,
    copyCeiling: copyCeiling,
  };
})();
/* ---- end js/ai/data-glow-local-ai-canvas.js ---- */
