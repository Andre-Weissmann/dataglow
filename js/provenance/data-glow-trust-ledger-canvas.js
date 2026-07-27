/* ---- from js/provenance/data-glow-trust-ledger-canvas.js ---- */
;(function () {
  'use strict';

  /* Trust Ledger: the calm place the session's trust events land, oldest first.

     The pure engine (js/provenance/trust-ledger.js, published as
     window.DataGlowTrustLedgerEngine) owns the hash chain, the vocabulary and
     the exports. This module owns only what the engine cannot: the button, the
     panel, and the listeners that catch the events the app already dispatches.

     WHAT IT LISTENS TO, and why those. Every source below is an event the app
     genuinely fires today, verified rather than assumed:
       dataglow:pulse-scored      a real validation score was produced
       dataglow:export-triggered  a CSV, XLSX or portfolio card was written
     Nothing is invented for the ledger to look busy. A surface that wants a row
     recorded calls window.DataGlowTrustLedger.record() explicitly, which is how
     the Publish-Safe wire in the notebook toolbar adds its verdict, and why
     dataglow:notebook-app-saved is not in the list above.

     WHAT IT NEVER DOES. It does not persist. The ledger is session-scoped and
     in memory, so closing the tab ends it, and the export buttons are the only
     way a row leaves. It writes nothing to localStorage, cookies or IndexedDB,
     and it makes no network call. It also never edits a row: the panel is a
     reader over an append-only chain.

     Styles are injected at runtime rather than added to the canvas stylesheet,
     matching data-glow-notebook-app-canvas.js. */

  var BTN_ID = 'dg-trust-ledger-btn';
  var PANEL_ID = 'dg-trust-ledger-panel';
  var STYLE_ID = 'dg-trust-ledger-styles';
  var BODY_ID = 'dg-trust-ledger-body';

  var _ledger = null;
  var _verify = null;

  function engine() { return window.DataGlowTrustLedgerEngine || null; }

  /* Same read as the other canvas surfaces (Air-Gap, Shield Packs, PHI Shield):
     a flags provider is honored when present, and its absence means on, since
     the app registers no provider today. window.DATAGLOW_TRUST_LEDGER is the
     explicit local override in either direction. */
  function flagOn() {
    try { if (window.DATAGLOW_TRUST_LEDGER === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_TRUST_LEDGER === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('trustLedger') !== false;
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
    console.info('[Trust Ledger]', msg);
  }

  function ledger() {
    if (_ledger) return _ledger;
    var e = engine();
    if (!e) return null;
    _ledger = e.createTrustLedger();
    return _ledger;
  }

  function entries() {
    var l = ledger();
    return l ? l.getEntries() : [];
  }

  /* ---------------------------- recording -------------------------------- */

  /* Appending is fire and forget on purpose: the engine's record() is async
     because SHA-256 is, and no caller should have to await a log line. A
     failure here must never break the work that was being recorded, so the
     rejected-row discipline in the engine plus this catch are both needed. */
  function record(ev) {
    var l = ledger();
    if (!l) return null;
    var p = l.record(ev);
    /* The badge is refreshed on every append, not only while the panel is open.
       The count and the alert dot are the only signal a user gets that something
       landed in here without them looking, so they must not wait for a render. */
    p.then(function () {
      updateBadge();
      if (isOpen()) renderBody();
    }).catch(function (_e) {});
    return p;
  }

  /* ---------------------------- styles ------------------------------------ */

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#' + BTN_ID + '{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 12px;',
      'border-radius:10px;border:1px solid var(--border,#282D38);background:transparent;',
      'color:var(--text-muted,#9AA1AE);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}',
      '#' + BTN_ID + ':hover{color:var(--text,#E8EAED)}',
      '#' + BTN_ID + ' .dg-tl-dot{width:7px;height:7px;border-radius:50%;background:var(--primary,#20C5B5)}',
      '#' + BTN_ID + '[data-state="alert"] .dg-tl-dot{background:var(--warn,#E3A34A)}',
      '#' + PANEL_ID + '{position:fixed;top:0;right:0;bottom:0;width:min(560px,100%);z-index:12090;',
      'display:none;flex-direction:column;background:var(--surface,#151820);',
      'border-left:1px solid var(--border,#282D38);box-shadow:-18px 0 48px rgba(0,0,0,.45)}',
      '#' + PANEL_ID + '.open{display:flex}',
      '#' + PANEL_ID + ' .dg-tl-head{display:flex;align-items:flex-start;justify-content:space-between;',
      'gap:10px;padding:16px 18px 12px;border-bottom:1px solid var(--border,#282D38)}',
      '#' + PANEL_ID + ' .dg-tl-title{font-size:16px;font-weight:800;margin:0}',
      '#' + PANEL_ID + ' .dg-tl-sub{font-size:12px;color:var(--text-muted,#9AA1AE);margin:4px 0 0;line-height:1.55}',
      '#' + PANEL_ID + ' .dg-tl-x{min-height:44px;min-width:44px;border:none;background:transparent;',
      'color:var(--text-muted,#9AA1AE);font-size:22px;cursor:pointer;border-radius:10px;flex:0 0 auto}',
      '#' + BODY_ID + '{flex:1;overflow-y:auto;padding:14px 18px;-webkit-overflow-scrolling:touch}',
      '#' + PANEL_ID + ' .dg-tl-row{padding:11px 0;border-bottom:1px solid var(--border,#282D38);font-size:13px;line-height:1.55}',
      '#' + PANEL_ID + ' .dg-tl-row:last-child{border-bottom:none}',
      '#' + PANEL_ID + ' .dg-tl-when{font-size:11px;color:var(--text-muted,#9AA1AE);letter-spacing:.03em}',
      '#' + PANEL_ID + ' .dg-tl-what{margin:3px 0 0}',
      '#' + PANEL_ID + ' .dg-tl-hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--dg-text-xs);',
      'color:var(--text-faint,var(--text-muted,#9AA1AE));margin:4px 0 0;word-break:break-all}',
      '#' + PANEL_ID + ' .dg-tl-chip{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;',
      'font-size:var(--dg-text-xs);font-weight:700;border:1px solid var(--border,#282D38);color:var(--text-muted,#9AA1AE)}',
      '#' + PANEL_ID + ' .dg-tl-chip.blocked{border-color:var(--danger,#E5534B);color:var(--danger,#E5534B)}',
      '#' + PANEL_ID + ' .dg-tl-chip.caution{border-color:var(--warn,#E3A34A);color:var(--warn,#E3A34A)}',
      '#' + PANEL_ID + ' .dg-tl-chip.clear{border-color:var(--primary,#20C5B5);color:var(--primary,#20C5B5)}',
      '#' + PANEL_ID + ' .dg-tl-verify{margin:0 0 12px;padding:10px 12px;border-radius:10px;font-size:12.5px;',
      'line-height:1.55;border:1px solid var(--border,#282D38);color:var(--text-secondary,#B4B8C0)}',
      '#' + PANEL_ID + ' .dg-tl-verify.bad{border-color:var(--danger,#E5534B);color:var(--danger,#E5534B)}',
      '#' + PANEL_ID + ' .dg-tl-verify.good{border-color:var(--primary,#20C5B5);color:var(--primary,#20C5B5)}',
      '#' + PANEL_ID + ' .dg-tl-note{font-size:11px;line-height:1.5;color:var(--text-faint,var(--text-muted,#9AA1AE));',
      'padding:10px 2px 4px}',
      '#' + PANEL_ID + ' .dg-tl-foot{display:flex;flex-wrap:wrap;gap:8px;padding:12px 18px 16px;',
      'border-top:1px solid var(--border,#282D38)}',
      '#' + PANEL_ID + ' .dg-tl-btn{min-height:40px;padding:0 13px;border-radius:10px;font:inherit;font-size:12.5px;',
      'font-weight:700;cursor:pointer;border:1px solid var(--border,#282D38);background:transparent;',
      'color:var(--text-muted,#9AA1AE)}',
      '#' + PANEL_ID + ' .dg-tl-btn.primary{background:var(--primary,#20C5B5);color:#04201C;border-color:transparent}',
      '#' + PANEL_ID + ' .dg-tl-btn:hover{opacity:.9}',
      /* A14: on a phone the panel is the screen. The head and foot stay put so
         Verify and Close are reachable without scrolling a long chain, the four
         save buttons go full width so a thumb cannot miss, and every target
         clears 44px. Asserted in test/mobile-viewport-smoke.test.mjs. */
      '@media (max-width:700px){',
      '#' + BTN_ID + '{min-height:44px}',
      '#' + PANEL_ID + '{width:100%;left:0;border-left:none}',
      '#' + PANEL_ID + ' .dg-tl-head{position:sticky;top:0;z-index:2;background:var(--surface,#151820)}',
      '#' + PANEL_ID + ' .dg-tl-foot{position:sticky;bottom:0;z-index:2;background:var(--surface,#151820)}',
      '#' + PANEL_ID + ' .dg-tl-btn{flex:1 1 100%;min-height:44px}',
      '#' + BODY_ID + '{padding:12px 14px}',
      '}'
    ].join('');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ---------------------------- panel ------------------------------------ */

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    ensureStyles();
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Trust Ledger');
    panel.innerHTML =
      '<div class="dg-tl-head">' +
        '<div style="min-width:0">' +
          '<p class="dg-tl-title">Trust Ledger</p>' +
          '<p class="dg-tl-sub" data-tl-summary></p>' +
        '</div>' +
        '<button type="button" class="dg-tl-x" data-tl-close aria-label="Close">×</button>' +
      '</div>' +
      '<div id="' + BODY_ID + '"></div>' +
      '<div class="dg-tl-foot">' +
        '<button type="button" class="dg-tl-btn primary" data-tl-verify>Verify the chain</button>' +
        '<button type="button" class="dg-tl-btn" data-tl-export="text">Save as text</button>' +
        '<button type="button" class="dg-tl-btn" data-tl-export="markdown">Save as Markdown</button>' +
        '<button type="button" class="dg-tl-btn" data-tl-export="json">Save as JSON</button>' +
      '</div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-tl-close]').addEventListener('click', closePanel);
    panel.querySelector('[data-tl-verify]').addEventListener('click', verifyNow);
    var exporters = panel.querySelectorAll('[data-tl-export]');
    for (var i = 0; i < exporters.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () { saveExport(btn.getAttribute('data-tl-export')); });
      })(exporters[i]);
    }
    return panel;
  }

  function outcomeChip(entry) {
    if (!entry || entry.rejected) return '<span class="dg-tl-chip">refused</span>';
    if (!entry.outcome || entry.outcome === 'recorded') return '';
    return '<span class="dg-tl-chip ' + esc(entry.outcome) + '">' + esc(entry.outcome) + '</span>';
  }

  function renderBody() {
    var body = document.getElementById(BODY_ID);
    var e = engine();
    if (!body) return;
    if (!e) {
      body.innerHTML = '<div class="dg-tl-verify">The Trust Ledger engine is unavailable, so nothing can be recorded or shown.</div>';
      return;
    }
    var rows = entries();
    var panel = document.getElementById(PANEL_ID);
    var summary = panel ? panel.querySelector('[data-tl-summary]') : null;
    if (summary) summary.textContent = e.summarizeTrustLedger(rows);

    var html = '';
    if (_verify) {
      html += '<div class="dg-tl-verify ' + (_verify.valid ? 'good' : 'bad') + '">' + esc(_verify.reason) + '</div>';
    }
    if (rows.length === 0) {
      html += '<div class="dg-tl-row"><div class="dg-tl-what">' +
        esc('Nothing has happened yet that belongs in here. Run validation, save a metric definition, '
          + 'or export something, and the row will appear at the bottom of this list.') +
        '</div></div>';
    } else {
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var label = row.rejected ? 'Refused row' : (e.TRUST_EVENT_LABELS[row.kind] || row.kind);
        html += '<div class="dg-tl-row" data-tl-index="' + esc(row.index) + '">' +
          '<div class="dg-tl-when">' + esc(e.formatTrustTime(row.ts)) + ' · ' + esc(label) +
            outcomeChip(row) + '</div>' +
          '<div class="dg-tl-what">' + esc(e.describeTrustEntry(row)) + '</div>' +
          '<div class="dg-tl-hash">' + esc(String(row.hash || '').slice(0, 16)) + '</div>' +
        '</div>';
      }
    }
    html += '<div class="dg-tl-note">' + esc(e.TRUST_LEDGER_DISCLAIMER) + '</div>' +
      '<div class="dg-tl-note">' + esc('This ledger lives in this tab only. It is never saved to disk on '
        + 'its own, so closing the tab ends it and the buttons below are the only way a row leaves.') + '</div>';
    body.innerHTML = html;
  }

  function verifyNow() {
    var e = engine();
    if (!e) return null;
    var p = e.verifyTrustLedger(entries());
    p.then(function (res) {
      _verify = res;
      renderBody();
      updateBadge();
      toast(res.valid ? 'Trust Ledger verified' : 'Trust Ledger chain is broken', res.valid ? 'success' : 'error');
    }).catch(function (_e) {});
    return p;
  }

  /* One file to this device. Same local-only handoff as Notebook to App: a Blob
     and an anchor, no network. */
  function saveExport(format) {
    var e = engine();
    if (!e) return null;
    var text = e.exportTrustLedger(entries(), format);
    var ext = format === 'json' ? 'json' : (format === 'markdown' ? 'md' : 'txt');
    var type = format === 'json' ? 'application/json' : 'text/plain';
    var name = 'dataglow-trust-ledger.' + ext;
    var url = '';
    try {
      url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (_err) {
      if (url) URL.revokeObjectURL(url);
      toast('Could not save the ledger', 'error');
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
    renderBody();
    return true;
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('open');
  }

  function updateBadge() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    var rows = entries();
    var alert = false;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && (rows[i].rejected || rows[i].outcome === 'blocked')) { alert = true; break; }
    }
    if (_verify && !_verify.valid) alert = true;
    btn.setAttribute('data-state', alert ? 'alert' : 'ok');
    var label = btn.querySelector('[data-tl-label]');
    if (label) label.textContent = rows.length > 0 ? 'Trust · ' + rows.length : 'Trust';
  }

  /* ---------------------------- mounting --------------------------------- */

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    ensureStyles();
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open the Trust Ledger');
    btn.title = 'Trust Ledger . what happened here, in order';
    btn.innerHTML = '<span class="dg-tl-dot" aria-hidden="true"></span><span data-tl-label>Trust</span>';
    btn.addEventListener('click', function () {
      if (isOpen()) closePanel(); else openPanel();
    });
    /* Next to Air-Gap, which sits next to Shield Packs, so the whole "can I
       trust this" posture is one row of buttons. Falls back the same way. */
    var anchor = document.getElementById('dg-air-gap-btn') || document.getElementById('dg-shield-packs-btn');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      if (anchor.style.position === 'fixed') {
        btn.style.position = 'fixed';
        btn.style.bottom = '16px';
        btn.style.right = '312px';
        btn.style.zIndex = '12000';
      }
      return;
    }
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header');
    if (!toolbar) {
      toolbar = document.body;
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '312px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  /* Every listener below maps an event the app already fires onto one row. The
     detail shapes are read defensively: a changed payload should cost a vaguer
     sentence, not a thrown error inside someone else's export. */
  function installListeners() {
    document.addEventListener('dataglow:pulse-scored', function (ev) {
      var d = (ev && ev.detail) || {};
      var score = typeof d.score === 'number' ? d.score : null;
      record({
        kind: 'validation-run',
        subject: typeof d.table === 'string' ? d.table : null,
        summary: score === null
          ? 'Validation ran and produced a score.'
          : 'Validation ran and scored ' + score + ' out of 100.',
        actor: 'validation',
        detail: { score: score, source: d.source || null }
      });
    });

    document.addEventListener('dataglow:export-triggered', function (ev) {
      var d = (ev && ev.detail) || {};
      var fmt = typeof d.format === 'string' ? d.format : 'a file';
      record({
        kind: 'export-attempt',
        subject: fmt,
        summary: 'An export was written to this device as ' + fmt + '.'
          + (typeof d.rows === 'number' ? ' It covered ' + d.rows + ' rows.' : ''),
        outcome: 'recorded',
        detail: { format: fmt, rows: typeof d.rows === 'number' ? d.rows : null }
      });
    });

    /* dataglow:notebook-app-saved is deliberately NOT listened to here. That
       surface calls record() itself, because it is the only place holding the
       Publish-Safe verdict the human just read, and a row carrying that verdict
       says more than one reconstructed from the event detail. Listening here as
       well would append the same save twice. */
  }

  function boot() {
    if (flagOn()) {
      injectButton();
      ensurePanel();
      updateBadge();
      installListeners();
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closePanel();
      });
    }

    /* Published whether or not the surface mounted, the same way Air-Gap
       publishes its guards: a caller records a row without needing to know
       whether a panel exists. With the flag off nothing mounted, so the
       listeners are not installed and only explicit callers can append. */
    window.DataGlowTrustLedger = {
      version: 1,
      open: openPanel,
      close: closePanel,
      isOpen: isOpen,
      record: record,
      verify: verifyNow,
      save: saveExport,
      getEntries: entries,
      size: function () { return entries().length; },
      clear: function () { if (_ledger) _ledger.clear(); _verify = null; updateBadge(); if (isOpen()) renderBody(); },
      /* The composers, so a caller hands over what it already produced rather
         than inventing ledger vocabulary. */
      fromReadinessGate: function (g, o) { var e = engine(); return e ? e.fromReadinessGate(g, o || {}) : null; },
      fromContractVersion: function (v, o) { var e = engine(); return e ? e.fromContractVersion(v, o || {}) : null; },
      fromPublishSafe: function (v, o) { var e = engine(); return e ? e.fromPublishSafe(v, o || {}) : null; }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 840); });
  } else {
    setTimeout(boot, 840);
  }
})();
/* ---- end js/provenance/data-glow-trust-ledger-canvas.js ---- */
