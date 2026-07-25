/* ---- from js/glassbox/data-glow-glass-box-canvas.js ---- */
;(function () {
  'use strict';

  /* GlassBox: the "show the math" block that sits under a finding.

     The pure engine (js/glassbox/glass-box.js, published as
     window.DataGlowGlassBoxEngine) owns the model, the badge vocabulary, the
     truncation and the disclaimer. This module owns only what the engine
     cannot: where the block goes, and where the code comes from.

     WHERE IT MOUNTS, and why those three. Each is a place that already shows a
     result with no way to see the work behind it:
       #sql-view-results-wrapper   SQL view result   source #sql-view-input
       #sql-results-wrapper        SQL tab result    source #sql-input
       #py-result-wrap             Python result     source #py-view-input
     Guided Unpivot already has its own glass-box toggle and is deliberately left
     alone: a second one under the same result would be two answers to one
     question.

     WHERE THE CODE COMES FROM. The paired textarea, read at the moment the
     block is opened. Nothing is reconstructed and nothing is cached, so the
     panel either shows the text a person can see in the editor above or says
     plainly that it has nothing. The engine holds the rule; this module holds
     the DOM read.

     HOW IT KNOWS A RESULT ARRIVED. A MutationObserver on each wrapper. The
     result renderers in the canvas are private closures with no event, so
     watching the DOM is the only way to react without editing them.

     WHAT IT NEVER DOES. It does not run anything, does not edit the editor, and
     does not grade: every badge comes from a gate that already ran, read off
     the window namespaces those gates publish. A gate that is not present
     produces no chip at all rather than a passing one.

     Styles are injected at runtime, matching the other canvas surfaces, and
     carry the narrow-viewport rules for A14 so the block is usable on a phone
     without a horizontal trap. */

  var STYLE_ID = 'dg-glass-box-styles';
  var BLOCK_CLASS = 'dg-gb';

  /* Each host is one surface. `rowsFrom` is the tbody whose row count becomes
     the finding, because that is the number a person is looking at. */
  var HOSTS = [
    {
      id: 'sql-view',
      after: 'sql-view-results-wrapper',
      source: 'sql-view-input',
      rowsFrom: 'sql-view-results-tbody',
      language: 'sql',
      engine: 'DuckDB-WASM on this device',
      surface: 'this SQL result'
    },
    {
      id: 'sql-tab',
      after: 'sql-results-wrapper',
      source: 'sql-input',
      rowsFrom: 'sql-results-tbody',
      language: 'sql',
      engine: 'DuckDB-WASM on this device',
      surface: 'this SQL result'
    },
    {
      id: 'py-view',
      after: 'py-result-wrap',
      source: 'py-view-input',
      rowsFrom: 'py-result-tbody',
      language: 'python',
      engine: 'Pyodide on this device',
      surface: 'this Python result'
    }
  ];

  function engine() { return window.DataGlowGlassBoxEngine || null; }

  function flagOn() {
    try { if (window.DATAGLOW_GLASS_BOX === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_GLASS_BOX === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('glassBox') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, kind || 'info'); return; } catch (_e) {}
    }
    console.info('[GlassBox]', msg);
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.' + BLOCK_CLASS + '{margin:10px 0 4px;border:1px solid var(--border,#282D38);border-radius:12px;',
      'background:var(--surface-2,var(--surface,#151820));overflow:hidden}',
      '.' + BLOCK_CLASS + '[hidden]{display:none}',
      '.' + BLOCK_CLASS + ' .dg-gb-toggle{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;',
      'padding:0 13px;border:none;background:transparent;color:var(--text-secondary,#B4B8C0);font:inherit;',
      'font-size:12.5px;font-weight:700;cursor:pointer;text-align:left}',
      '.' + BLOCK_CLASS + ' .dg-gb-toggle:hover{color:var(--text,#E8EAED)}',
      '.' + BLOCK_CLASS + ' .dg-gb-caret{flex:0 0 auto;font-size:10px;color:var(--text-muted,#9AA1AE)}',
      '.' + BLOCK_CLASS + ' .dg-gb-lvl{flex:0 0 auto;width:7px;height:7px;border-radius:50%;',
      'background:var(--text-muted,#9AA1AE)}',
      '.' + BLOCK_CLASS + '[data-level="good"] .dg-gb-lvl{background:var(--primary,#20C5B5)}',
      '.' + BLOCK_CLASS + '[data-level="warn"] .dg-gb-lvl{background:var(--warn,#E3A34A)}',
      '.' + BLOCK_CLASS + '[data-level="bad"] .dg-gb-lvl{background:var(--danger,#E5534B)}',
      '.' + BLOCK_CLASS + ' .dg-gb-body{display:none;padding:2px 13px 13px;border-top:1px solid var(--border,#282D38)}',
      '.' + BLOCK_CLASS + '.open .dg-gb-body{display:block}',
      '.' + BLOCK_CLASS + ' .dg-gb-find{font-size:13px;line-height:1.55;margin:11px 0 0;color:var(--text,#E8EAED)}',
      '.' + BLOCK_CLASS + ' .dg-gb-detail{font-size:12px;line-height:1.55;margin:4px 0 0;',
      'color:var(--text-muted,#9AA1AE)}',
      '.' + BLOCK_CLASS + ' .dg-gb-ran{font-size:11px;margin:11px 0 5px;color:var(--text-muted,#9AA1AE);',
      'letter-spacing:.03em}',
      /* pre wraps rather than scrolls sideways: a phone must never trap the
         page in a horizontal scroll to read a query. */
      '.' + BLOCK_CLASS + ' pre.dg-gb-src{margin:0;padding:11px 12px;border-radius:10px;max-height:340px;',
      'overflow-y:auto;overflow-x:hidden;background:var(--bg,#0E1015);border:1px solid var(--border,#282D38);',
      'font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.6;',
      'color:var(--text-secondary,#B4B8C0);white-space:pre-wrap;word-break:break-word;',
      '-webkit-overflow-scrolling:touch}',
      '.' + BLOCK_CLASS + ' .dg-gb-chips{display:flex;flex-wrap:wrap;gap:6px;margin:11px 0 0}',
      '.' + BLOCK_CLASS + ' .dg-gb-chip{padding:3px 9px;border-radius:999px;font-size:10.5px;font-weight:700;',
      'border:1px solid var(--border,#282D38);color:var(--text-muted,#9AA1AE)}',
      '.' + BLOCK_CLASS + ' .dg-gb-chip[data-level="good"]{border-color:var(--primary,#20C5B5);color:var(--primary,#20C5B5)}',
      '.' + BLOCK_CLASS + ' .dg-gb-chip[data-level="warn"]{border-color:var(--warn,#E3A34A);color:var(--warn,#E3A34A)}',
      '.' + BLOCK_CLASS + ' .dg-gb-chip[data-level="bad"]{border-color:var(--danger,#E5534B);color:var(--danger,#E5534B)}',
      '.' + BLOCK_CLASS + ' .dg-gb-gap{font-size:11.5px;line-height:1.55;margin:9px 0 0;',
      'color:var(--text-faint,var(--text-muted,#9AA1AE))}',
      '.' + BLOCK_CLASS + ' .dg-gb-note{font-size:11px;line-height:1.5;margin:11px 0 0;',
      'color:var(--text-faint,var(--text-muted,#9AA1AE))}',
      '.' + BLOCK_CLASS + ' .dg-gb-foot{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 0}',
      '.' + BLOCK_CLASS + ' .dg-gb-btn{min-height:40px;padding:0 13px;border-radius:10px;font:inherit;',
      'font-size:12.5px;font-weight:700;cursor:pointer;border:1px solid var(--border,#282D38);',
      'background:transparent;color:var(--text-muted,#9AA1AE)}',
      '.' + BLOCK_CLASS + ' .dg-gb-btn:hover{color:var(--text,#E8EAED)}',
      /* A14: at phone width the chips and buttons go full width so a thumb
         cannot miss, and the block loses its side margins to keep the reading
         column as wide as the screen allows. */
      '@media (max-width:700px){',
      '.' + BLOCK_CLASS + ' .dg-gb-btn{flex:1 1 100%;min-height:44px}',
      '.' + BLOCK_CLASS + ' .dg-gb-toggle{min-height:48px;font-size:13px}',
      '.' + BLOCK_CLASS + ' pre.dg-gb-src{max-height:240px;font-size:11.5px}',
      '}'
    ].join('');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ------------------------- evidence gathering --------------------------- */

  /* Gates handed over explicitly by a surface that holds one, keyed the way the
     engine expects. Nothing is written here on this module's own initiative. */
  var _provided = {};

  /* Only two gates publish a readable posture today, and both are read from the
     namespace they already expose:
       window.DataGlowAirGap.isAirGapActive()
       window.DataGlowPhiShield.getLastReport()
     Query Sentinel and the readiness gate are deliberately absent. Their
     functions are published but their results are not: runQuerySentinel needs a
     schema with distinct counts, and computeReadinessGate needs validation layer
     results, neither of which the app keeps anywhere this module can read. So
     they are left to provide(), and until a surface hands one over the engine
     reports their absence rather than a passing chip. Re-deriving them from what
     the DOM happens to show would be a guess wearing a badge. */
  function gatherGates() {
    var gates = {};
    try {
      if (window.DataGlowAirGap && typeof window.DataGlowAirGap.isAirGapActive === 'function') {
        gates.airGap = { active: window.DataGlowAirGap.isAirGapActive() === true };
      }
    } catch (_e0) {}
    try {
      if (window.DataGlowPhiShield && typeof window.DataGlowPhiShield.getLastReport === 'function') {
        var rep = window.DataGlowPhiShield.getLastReport();
        /* The PHI report carries its match under guard.sensitiveFound, and a
           report with no guard section means the guard could not run, which is
           not the same as clean. */
        if (rep && rep.guard && typeof rep.guard.sensitiveFound === 'boolean') {
          gates.phi = { sensitiveFound: rep.guard.sensitiveFound === true };
        }
      }
    } catch (_e1) {}
    for (var k in _provided) {
      if (Object.prototype.hasOwnProperty.call(_provided, k)) gates[k] = _provided[k];
    }
    return gates;
  }

  function sourceText(host) {
    var el = document.getElementById(host.source);
    if (!el) return '';
    var v = el.value;
    return typeof v === 'string' ? v.trim() : '';
  }

  function rowCount(host) {
    var body = document.getElementById(host.rowsFrom);
    if (!body) return null;
    return body.querySelectorAll('tr').length;
  }

  function findingFor(host) {
    var rows = rowCount(host);
    if (rows === null) return { headline: '', detail: '' };
    if (rows === 0) {
      return {
        headline: 'No rows came back.',
        detail: 'That is a real answer, not a failure. The code below is what was asked.'
      };
    }
    var shown = rows === 1 ? '1 row is shown above.' : rows.toLocaleString('en-US') + ' rows are shown above.';
    return {
      headline: shown,
      detail: 'The table above may be a preview of a larger result. The code below is what produced it.'
    };
  }

  function modelFor(host) {
    var e = engine();
    if (!e) return null;
    var find = findingFor(host);
    return e.buildGlassBox({
      surface: host.surface,
      headline: find.headline,
      detail: find.detail,
      language: host.language,
      engine: host.engine,
      source: sourceText(host),
      gates: gatherGates()
    });
  }

  /* ------------------------------ rendering ------------------------------- */

  function renderBody(block, model) {
    var e = engine();
    var html = '';
    html += '<p class="dg-gb-find">' + esc(model.finding.headline) + '</p>';
    if (model.finding.detail) html += '<p class="dg-gb-detail">' + esc(model.finding.detail) + '</p>';

    if (model.math.available) {
      var ran = 'Ran by ' + model.math.engine;
      if (model.math.truncated) {
        ran += '. Showing the first ' + model.math.shownLines + ' of ' + model.math.lineCount + ' lines';
      }
      html += '<p class="dg-gb-ran">' + esc(ran) + '</p>';
      html += '<pre class="dg-gb-src">' + esc(model.math.source) + '</pre>';
    }

    if (model.badges.length > 0) {
      html += '<div class="dg-gb-chips">';
      for (var i = 0; i < model.badges.length; i++) {
        var b = model.badges[i];
        html += '<span class="dg-gb-chip" data-level="' + esc(b.level) + '" title="' + esc(b.why) + '">'
          + esc(b.label) + '</span>';
      }
      html += '</div>';
    }
    for (var j = 0; j < model.missing.length; j++) {
      html += '<p class="dg-gb-gap">' + esc(model.missing[j].why) + '</p>';
    }
    html += '<p class="dg-gb-note">' + esc(model.disclaimer) + '</p>';
    html += '<div class="dg-gb-foot">'
      + '<button type="button" class="dg-gb-btn" data-gb-copy>Copy the math</button>'
      + '</div>';

    var body = block.querySelector('.dg-gb-body');
    body.innerHTML = html;
    var copy = body.querySelector('[data-gb-copy]');
    if (copy) {
      copy.addEventListener('click', function () {
        var text = e ? e.renderGlassBoxText(model) : '';
        if (!text) { toast('Nothing to copy', 'error'); return; }
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(function () {
            toast('The math was copied to this device clipboard');
          }).catch(function () { toast('Could not copy', 'error'); });
          return;
        }
        toast('Copying is unavailable in this browser', 'error');
      });
    }
  }

  function refresh(host) {
    var block = document.getElementById('dg-gb-' + host.id);
    var e = engine();
    if (!block || !e) return null;
    var rows = rowCount(host);
    /* Nothing has run yet, so there is no finding to sit above the proof. The
       block stays out of the way rather than showing an empty frame. */
    if (rows === null || rows === 0 && !sourceText(host)) {
      block.hidden = true;
      return null;
    }
    var model = modelFor(host);
    if (!model) { block.hidden = true; return null; }
    block.hidden = false;
    block.setAttribute('data-level', model.level);
    var label = block.querySelector('[data-gb-label]');
    if (label) label.textContent = e.glassBoxToggleLabel(model);
    if (block.classList.contains('open')) renderBody(block, model);
    block._dgModel = model;
    return model;
  }

  function toggle(host) {
    var block = document.getElementById('dg-gb-' + host.id);
    if (!block) return false;
    var open = block.classList.contains('open');
    if (open) {
      block.classList.remove('open');
      block.querySelector('.dg-gb-toggle').setAttribute('aria-expanded', 'false');
      return false;
    }
    var model = modelFor(host);
    if (model) renderBody(block, model);
    block.classList.add('open');
    block.querySelector('.dg-gb-toggle').setAttribute('aria-expanded', 'true');
    return true;
  }

  /* ------------------------------ mounting -------------------------------- */

  function mountHost(host) {
    if (document.getElementById('dg-gb-' + host.id)) return true;
    var anchor = document.getElementById(host.after);
    if (!anchor || !anchor.parentNode) return false;
    ensureStyles();
    var block = document.createElement('div');
    block.id = 'dg-gb-' + host.id;
    block.className = BLOCK_CLASS;
    block.setAttribute('data-gb-host', host.id);
    block.hidden = true;
    block.innerHTML =
      '<button type="button" class="dg-gb-toggle" aria-expanded="false">'
        + '<span class="dg-gb-lvl" aria-hidden="true"></span>'
        + '<span data-gb-label>Show the math</span>'
        + '<span class="dg-gb-caret" aria-hidden="true">&#9662;</span>'
      + '</button>'
      + '<div class="dg-gb-body"></div>';
    block.querySelector('.dg-gb-toggle').addEventListener('click', function () { toggle(host); });
    anchor.parentNode.insertBefore(block, anchor.nextSibling);

    /* The result renderers are private closures that fire no event, so the DOM
       is the only signal available. Watching the tbody keeps the observer off
       the whole page. */
    var watched = document.getElementById(host.rowsFrom) || anchor;
    try {
      var obs = new MutationObserver(function () { refresh(host); });
      obs.observe(watched, { childList: true, subtree: true });
    } catch (_e) { /* an old browser loses live refresh, not the block */ }
    refresh(host);
    return true;
  }

  function mountAll() {
    var mounted = [];
    for (var i = 0; i < HOSTS.length; i++) {
      if (mountHost(HOSTS[i])) mounted.push(HOSTS[i].id);
    }
    return mounted;
  }

  function hostById(id) {
    for (var i = 0; i < HOSTS.length; i++) if (HOSTS[i].id === id) return HOSTS[i];
    return null;
  }

  function boot() {
    var mounted = [];
    if (flagOn()) mounted = mountAll();

    /* Published whether or not anything mounted, the same way the other
       surfaces publish: a caller can build a model without needing to know
       whether a block exists. */
    window.DataGlowGlassBox = {
      version: 1,
      hosts: HOSTS.map(function (h) { return h.id; }),
      mounted: mounted,
      mount: mountAll,
      refresh: function (id) { var h = hostById(id); return h ? refresh(h) : null; },
      refreshAll: function () {
        var out = [];
        for (var i = 0; i < HOSTS.length; i++) out.push(refresh(HOSTS[i]));
        return out;
      },
      open: function (id) { var h = hostById(id); return h ? toggle(h) : false; },
      model: function (id) { var h = hostById(id); return h ? modelFor(h) : null; },
      /* The gates as this surface sees them right now, so a test or another
         panel can check what evidence was actually available. */
      gates: gatherGates,
      /* A surface holding a gate result the app does not publish, a Query
         Sentinel report or a readiness gate, hands it over here rather than
         having it guessed. Passing null for a key withdraws it. */
      provide: function (bag) {
        if (!bag || typeof bag !== 'object') return gatherGates();
        var keys = ['sentinel', 'gate', 'phi', 'airGap', 'publishSafe'];
        for (var i = 0; i < keys.length; i++) {
          if (!Object.prototype.hasOwnProperty.call(bag, keys[i])) continue;
          if (bag[keys[i]] == null) delete _provided[keys[i]];
          else _provided[keys[i]] = bag[keys[i]];
        }
        for (var j = 0; j < HOSTS.length; j++) refresh(HOSTS[j]);
        return gatherGates();
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 860); });
  } else {
    setTimeout(boot, 860);
  }
})();
/* ---- end js/glassbox/data-glow-glass-box-canvas.js ---- */
