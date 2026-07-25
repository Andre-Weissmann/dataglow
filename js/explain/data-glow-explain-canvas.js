/* ---- from js/explain/data-glow-explain-canvas.js ---- */
;(function () {
  'use strict';

  /* Explain: one calm panel that says what the thing on screen means, in words,
     using only what the checks on this device already found.

     The pure engine (js/explain/explain-engine.js, published as
     window.DataGlowExplainEngine) owns the sentences, the ordering, the
     confidence rule and the em dash normalisation of anything borrowed from an
     older engine. This module owns only what the engine cannot: the button, the
     panel, and gathering the evidence off the surfaces that publish it.

     WHERE THE EVIDENCE COMES FROM. Every source below is read from the namespace
     that surface already exposes, verified rather than assumed:
       window.DataGlowAirGap.isAirGapActive()      the network posture
       window.DataGlowPhiShield.getLastReport()    the last PHI scan, if one ran
       window.DataGlowTrustLedger.getEntries()     what is on the record
       window.DataGlowGlassBox.gates()             gates a surface handed over
       the visible result table                    the shape of the answer
     Query Sentinel and the readiness gate publish their functions but not their
     results: runQuerySentinel needs a schema with distinct counts and
     computeReadinessGate needs validation layer results, and the app keeps
     neither anywhere a panel can read. They are therefore reported as not known,
     which is exactly what the engine's unknowns list is for. A surface holding
     one hands it over through provide().

     WHY IT NEVER RE-DERIVES. Running a check here would produce a second,
     quieter opinion competing with the panel that owns it. This module composes
     or says nothing. With no evidence at all the panel says there is nothing to
     explain, rather than reassuring anyone.

     NO NETWORK. There is no fetch here and no model call. The explanation is
     composed on this device from local state, so it works with Air-Gap Mode on.

     Styles are injected at runtime, matching the other canvas surfaces, and
     carry the narrow-viewport rules for A14: full-width panel, sticky header and
     footer, and 44px targets. */

  var BTN_ID = 'dg-explain-btn';
  var PANEL_ID = 'dg-explain-panel';
  var STYLE_ID = 'dg-explain-styles';
  var BODY_ID = 'dg-explain-body';

  /* Result tables a person could be looking at, most specific first. The first
     one visible with rows is the subject of the explanation. */
  var RESULT_HOSTS = [
    { wrap: 'sql-view-results-wrapper', body: 'sql-view-results-tbody', head: 'sql-view-results-thead', subject: 'this SQL result' },
    { wrap: 'sql-results-wrapper', body: 'sql-results-tbody', head: 'sql-results-thead', subject: 'this SQL result' },
    { wrap: 'py-result-wrap', body: 'py-result-tbody', head: 'py-result-thead', subject: 'this Python result' }
  ];

  var _provided = {};

  function engine() { return window.DataGlowExplainEngine || null; }

  function flagOn() {
    try { if (window.DATAGLOW_EXPLAIN === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_EXPLAIN === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('explain') !== false;
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
    console.info('[Explain]', msg);
  }

  function visible(el) {
    if (!el) return false;
    if (el.hidden || el.classList.contains('hidden')) return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  /* ------------------------- evidence gathering --------------------------- */

  function resultShape() {
    for (var i = 0; i < RESULT_HOSTS.length; i++) {
      var host = RESULT_HOSTS[i];
      var wrap = document.getElementById(host.wrap);
      var body = document.getElementById(host.body);
      if (!body || !visible(wrap)) continue;
      var rows = body.querySelectorAll('tr').length;
      var head = document.getElementById(host.head);
      var cols = head ? head.querySelectorAll('th').length : 0;
      if (rows === 0 && cols === 0) continue;
      return { shape: { rows: rows, columns: cols }, subject: host.subject };
    }
    return { shape: null, subject: 'this result' };
  }

  function airGapEvidence() {
    try {
      if (window.DataGlowAirGap && typeof window.DataGlowAirGap.isAirGapActive === 'function') {
        return { active: window.DataGlowAirGap.isAirGapActive() === true };
      }
    } catch (_e) {}
    return null;
  }

  function phiEvidence() {
    try {
      if (!window.DataGlowPhiShield || typeof window.DataGlowPhiShield.getLastReport !== 'function') return null;
      var rep = window.DataGlowPhiShield.getLastReport();
      if (!rep) return null;
      /* available:false is the engine's way of saying a check could not run, and
         it deliberately does not read as clean. A report with no guard section
         is exactly that case. */
      if (!rep.guard || typeof rep.guard.sensitiveFound !== 'boolean') return { available: false };
      var hits = typeof rep.patternHitCount === 'number' ? rep.patternHitCount : 0;
      return {
        available: true,
        sensitiveFound: rep.guard.sensitiveFound === true,
        findings: hits > 0 ? [{ count: hits }] : []
      };
    } catch (_e) {}
    return null;
  }

  function trustEvidence() {
    try {
      if (!window.DataGlowTrustLedger || typeof window.DataGlowTrustLedger.getEntries !== 'function') return null;
      var rows = window.DataGlowTrustLedger.getEntries();
      if (!Array.isArray(rows)) return null;
      return { size: rows.length };
    } catch (_e) {}
    return null;
  }

  /* Gates GlassBox was handed are the same gates Explain should read: one panel
     saying a query is clean while the other says nothing is known would be two
     answers to one question. */
  function glassBoxGates() {
    try {
      if (window.DataGlowGlassBox && typeof window.DataGlowGlassBox.gates === 'function') {
        var g = window.DataGlowGlassBox.gates();
        return g && typeof g === 'object' ? g : {};
      }
    } catch (_e) {}
    return {};
  }

  function gatherEvidence() {
    var found = resultShape();
    var borrowed = glassBoxGates();
    var evidence = {
      subject: found.subject,
      resultShape: found.shape,
      airGap: airGapEvidence(),
      phi: phiEvidence(),
      trustLedger: trustEvidence(),
      sentinel: borrowed.sentinel || null,
      gate: borrowed.gate || null,
      publishSafe: borrowed.publishSafe || null
    };
    for (var k in _provided) {
      if (Object.prototype.hasOwnProperty.call(_provided, k)) evidence[k] = _provided[k];
    }
    return evidence;
  }

  function build() {
    var e = engine();
    if (!e) return null;
    return e.explainResult(gatherEvidence());
  }

  /* ------------------------------- styles --------------------------------- */

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#' + BTN_ID + '{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 12px;',
      'border-radius:10px;border:1px solid var(--border,#282D38);background:transparent;',
      'color:var(--text-muted,#9AA1AE);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}',
      '#' + BTN_ID + ':hover{color:var(--text,#E8EAED)}',
      '#' + BTN_ID + ' .dg-ex-dot{width:7px;height:7px;border-radius:50%;background:var(--text-muted,#9AA1AE)}',
      '#' + BTN_ID + '[data-level="good"] .dg-ex-dot{background:var(--primary,#20C5B5)}',
      '#' + BTN_ID + '[data-level="warn"] .dg-ex-dot{background:var(--warn,#E3A34A)}',
      '#' + BTN_ID + '[data-level="bad"] .dg-ex-dot{background:var(--danger,#E5534B)}',
      '#' + PANEL_ID + '{position:fixed;top:0;right:0;bottom:0;width:min(560px,100%);z-index:12080;',
      'display:none;flex-direction:column;background:var(--surface,#151820);',
      'border-left:1px solid var(--border,#282D38);box-shadow:-18px 0 48px rgba(0,0,0,.45)}',
      '#' + PANEL_ID + '.open{display:flex}',
      '#' + PANEL_ID + ' .dg-ex-head{display:flex;align-items:flex-start;justify-content:space-between;',
      'gap:10px;padding:16px 18px 12px;border-bottom:1px solid var(--border,#282D38);',
      'background:var(--surface,#151820)}',
      '#' + PANEL_ID + ' .dg-ex-title{font-size:16px;font-weight:800;margin:0}',
      '#' + PANEL_ID + ' .dg-ex-sub{font-size:12px;color:var(--text-muted,#9AA1AE);margin:4px 0 0;line-height:1.55}',
      '#' + PANEL_ID + ' .dg-ex-x{min-height:44px;min-width:44px;border:none;background:transparent;',
      'color:var(--text-muted,#9AA1AE);font-size:22px;cursor:pointer;border-radius:10px;flex:0 0 auto}',
      '#' + BODY_ID + '{flex:1;overflow-y:auto;overflow-x:hidden;padding:14px 18px;',
      '-webkit-overflow-scrolling:touch}',
      '#' + PANEL_ID + ' .dg-ex-headline{font-size:14px;line-height:1.6;margin:0 0 4px;font-weight:700;',
      'color:var(--text,#E8EAED)}',
      '#' + PANEL_ID + ' .dg-ex-conf{display:inline-block;margin:0 0 12px;padding:2px 9px;border-radius:999px;',
      'font-size:10.5px;font-weight:700;border:1px solid var(--border,#282D38);color:var(--text-muted,#9AA1AE)}',
      '#' + PANEL_ID + ' .dg-ex-sec{padding:11px 0;border-bottom:1px solid var(--border,#282D38)}',
      '#' + PANEL_ID + ' .dg-ex-sec:last-of-type{border-bottom:none}',
      '#' + PANEL_ID + ' .dg-ex-label{font-size:11px;letter-spacing:.04em;text-transform:uppercase;',
      'color:var(--text-muted,#9AA1AE);margin:0 0 3px;display:flex;align-items:center;gap:6px}',
      '#' + PANEL_ID + ' .dg-ex-pip{width:6px;height:6px;border-radius:50%;flex:0 0 auto;',
      'background:var(--text-muted,#9AA1AE)}',
      '#' + PANEL_ID + ' .dg-ex-sec[data-level="good"] .dg-ex-pip{background:var(--primary,#20C5B5)}',
      '#' + PANEL_ID + ' .dg-ex-sec[data-level="warn"] .dg-ex-pip{background:var(--warn,#E3A34A)}',
      '#' + PANEL_ID + ' .dg-ex-sec[data-level="bad"] .dg-ex-pip{background:var(--danger,#E5534B)}',
      '#' + PANEL_ID + ' .dg-ex-text{font-size:13px;line-height:1.6;margin:0;color:var(--text-secondary,#B4B8C0);',
      'word-break:break-word}',
      '#' + PANEL_ID + ' .dg-ex-unknown-h{font-size:11px;letter-spacing:.04em;text-transform:uppercase;',
      'color:var(--text-muted,#9AA1AE);margin:16px 0 6px}',
      '#' + PANEL_ID + ' .dg-ex-unknown{font-size:12px;line-height:1.55;margin:0 0 7px;',
      'color:var(--text-faint,var(--text-muted,#9AA1AE))}',
      '#' + PANEL_ID + ' .dg-ex-note{font-size:11px;line-height:1.5;color:var(--text-faint,var(--text-muted,#9AA1AE));',
      'padding:14px 2px 4px}',
      '#' + PANEL_ID + ' .dg-ex-foot{display:flex;flex-wrap:wrap;gap:8px;padding:12px 18px 16px;',
      'border-top:1px solid var(--border,#282D38);background:var(--surface,#151820)}',
      '#' + PANEL_ID + ' .dg-ex-btn{min-height:44px;padding:0 13px;border-radius:10px;font:inherit;font-size:12.5px;',
      'font-weight:700;cursor:pointer;border:1px solid var(--border,#282D38);background:transparent;',
      'color:var(--text-muted,#9AA1AE)}',
      '#' + PANEL_ID + ' .dg-ex-btn.primary{background:var(--primary,#20C5B5);color:#04201C;border-color:transparent}',
      '#' + PANEL_ID + ' .dg-ex-btn:hover{opacity:.9}',
      /* A14: on a phone the panel is the screen. It slides over everything, the
         head and foot stay put so Refresh and Close are always reachable, and
         the buttons go full width so a thumb cannot miss. */
      '@media (max-width:700px){',
      '#' + PANEL_ID + '{width:100%;left:0;border-left:none}',
      '#' + PANEL_ID + ' .dg-ex-head{position:sticky;top:0;z-index:2}',
      '#' + PANEL_ID + ' .dg-ex-foot{position:sticky;bottom:0;z-index:2}',
      '#' + PANEL_ID + ' .dg-ex-btn{flex:1 1 100%}',
      '#' + BODY_ID + '{padding:12px 14px}',
      '#' + BTN_ID + '{min-height:44px}',
      '}'
    ].join('');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ------------------------------- panel ---------------------------------- */

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    ensureStyles();
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Explain this result');
    panel.innerHTML =
      '<div class="dg-ex-head">' +
        '<div style="min-width:0">' +
          '<p class="dg-ex-title">Explain</p>' +
          '<p class="dg-ex-sub" data-ex-subject></p>' +
        '</div>' +
        '<button type="button" class="dg-ex-x" data-ex-close aria-label="Close">&times;</button>' +
      '</div>' +
      '<div id="' + BODY_ID + '"></div>' +
      '<div class="dg-ex-foot">' +
        '<button type="button" class="dg-ex-btn primary" data-ex-refresh>Look again</button>' +
        '<button type="button" class="dg-ex-btn" data-ex-copy>Copy this explanation</button>' +
        '<button type="button" class="dg-ex-btn" data-ex-save>Save as text</button>' +
      '</div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-ex-close]').addEventListener('click', closePanel);
    panel.querySelector('[data-ex-refresh]').addEventListener('click', function () { render(); });
    panel.querySelector('[data-ex-copy]').addEventListener('click', copyText);
    panel.querySelector('[data-ex-save]').addEventListener('click', saveText);
    return panel;
  }

  var _last = null;

  function render() {
    var body = document.getElementById(BODY_ID);
    var e = engine();
    if (!body) return null;
    if (!e) {
      body.innerHTML = '<p class="dg-ex-text">The Explain engine is unavailable, so nothing can be explained here.</p>';
      return null;
    }
    var exp = build();
    _last = exp;

    var panel = document.getElementById(PANEL_ID);
    var sub = panel ? panel.querySelector('[data-ex-subject]') : null;
    if (sub) sub.textContent = 'What is known about ' + exp.subject + ', and what is not.';

    var html = '';
    html += '<p class="dg-ex-headline">' + esc(exp.headline) + '</p>';
    html += '<span class="dg-ex-conf">' + esc(exp.confidence) + '</span>';
    for (var i = 0; i < exp.sections.length; i++) {
      var s = exp.sections[i];
      html += '<div class="dg-ex-sec" data-ex-sec="' + esc(s.id) + '" data-level="' + esc(s.level) + '">'
        + '<p class="dg-ex-label"><span class="dg-ex-pip" aria-hidden="true"></span>' + esc(s.label) + '</p>'
        + '<p class="dg-ex-text">' + esc(s.text) + '</p>'
        + '</div>';
    }
    if (exp.unknowns.length > 0) {
      html += '<p class="dg-ex-unknown-h">Not known</p>';
      for (var j = 0; j < exp.unknowns.length; j++) {
        html += '<p class="dg-ex-unknown">' + esc(exp.unknowns[j].why) + '</p>';
      }
    }
    html += '<p class="dg-ex-note">' + esc(exp.disclaimer) + '</p>';
    body.innerHTML = html;
    updateBadge(exp);
    return exp;
  }

  function textOf() {
    var e = engine();
    var exp = _last || build();
    if (!e || !exp) return '';
    return e.describeExplanation(exp);
  }

  function copyText() {
    var text = textOf();
    if (!text) { toast('Nothing to copy', 'error'); return; }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () {
        toast('The explanation was copied to this device clipboard');
      }).catch(function () { toast('Could not copy', 'error'); });
      return;
    }
    toast('Copying is unavailable in this browser', 'error');
  }

  /* One file to this device. Same local-only handoff the Trust Ledger uses: a
     Blob and an anchor, no network. */
  function saveText() {
    var text = textOf();
    if (!text) { toast('Nothing to save', 'error'); return null; }
    var name = 'dataglow-explanation.txt';
    var url = '';
    try {
      url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (_err) {
      if (url) URL.revokeObjectURL(url);
      toast('Could not save the explanation', 'error');
      return null;
    }
    setTimeout(function () { if (url) URL.revokeObjectURL(url); }, 1000);
    toast('Saved ' + name + ' to this device');
    return { filename: name, bytes: text.length };
  }

  function isOpen() {
    var panel = document.getElementById(PANEL_ID);
    return !!(panel && panel.classList.contains('open'));
  }

  function openPanel() {
    if (!flagOn()) return false;
    ensurePanel().classList.add('open');
    render();
    return true;
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('open');
  }

  function updateBadge(exp) {
    var btn = document.getElementById(BTN_ID);
    var e = engine();
    if (!btn || !e) return;
    var badge = e.explainBadge(exp || null);
    btn.setAttribute('data-level', badge.level);
    btn.setAttribute('title', 'Explain. ' + badge.text);
  }

  /* ------------------------------ mounting -------------------------------- */

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    ensureStyles();
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Explain what is on screen');
    btn.title = 'Explain. What is known about this, and what is not';
    btn.innerHTML = '<span class="dg-ex-dot" aria-hidden="true"></span><span data-ex-label>Explain</span>';
    btn.addEventListener('click', function () {
      if (isOpen()) closePanel(); else openPanel();
    });
    /* Beside Trust, which sits beside Air-Gap: the whole "can I trust this"
       row stays together, and Explain is the plain-language door into it. */
    var anchor = document.getElementById('dg-trust-ledger-btn')
      || document.getElementById('dg-air-gap-btn')
      || document.getElementById('dg-shield-packs-btn');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      if (anchor.style.position === 'fixed') {
        btn.style.position = 'fixed';
        btn.style.bottom = '16px';
        btn.style.right = '400px';
        btn.style.zIndex = '12000';
      }
      return;
    }
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header');
    if (!toolbar) {
      toolbar = document.body;
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '400px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  function boot() {
    if (flagOn()) {
      injectButton();
      ensurePanel();
      updateBadge(null);
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closePanel();
      });
    }

    /* Published whether or not the panel mounted, the same way the other
       surfaces publish: a caller can compose an explanation without needing to
       know whether a button exists. */
    window.DataGlowExplain = {
      version: 1,
      open: openPanel,
      close: closePanel,
      isOpen: isOpen,
      refresh: render,
      explain: build,
      evidence: gatherEvidence,
      text: textOf,
      save: saveText,
      /* Evidence the app does not publish anywhere readable, a Query Sentinel
         report or a readiness gate, is handed over here rather than guessed.
         Passing null for a key withdraws it. */
      provide: function (bag) {
        if (!bag || typeof bag !== 'object') return gatherEvidence();
        var keys = ['sentinel', 'sentinelSuggestions', 'gate', 'phi', 'airGap',
          'publishSafe', 'trustLedger', 'resultShape', 'subject', 'expect'];
        for (var i = 0; i < keys.length; i++) {
          if (!Object.prototype.hasOwnProperty.call(bag, keys[i])) continue;
          if (bag[keys[i]] == null) delete _provided[keys[i]];
          else _provided[keys[i]] = bag[keys[i]];
        }
        if (isOpen()) render();
        return gatherEvidence();
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 880); });
  } else {
    setTimeout(boot, 880);
  }
})();
/* ---- end js/explain/data-glow-explain-canvas.js ---- */
