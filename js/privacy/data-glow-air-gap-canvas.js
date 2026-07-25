/* ---- from js/privacy/data-glow-air-gap-canvas.js ---- */
;(function () {
  'use strict';

  var BTN_ID = 'dg-air-gap-btn';
  var PANEL_ID = 'dg-air-gap-panel';
  var BANNER_ID = 'dg-air-gap-banner';

  /* Session-scoped only. The engine holds the posture; this layer holds the
     saved network primitives it swaps out while the mode is on. Nothing here
     writes to localStorage, cookies, or IndexedDB. */
  var _savedFetch = null;
  var _savedXhrOpen = null;

  function engine() { return window.DataGlowAirGap || null; }

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
    console.info('[Air-Gap]', msg);
  }

  /* The airGapMode flag ships ON, so the surface mounts by default: the toggle,
     panel and banner are there on every load with no console opt-in. This is the
     same read the other canvas surfaces use (Shield Packs, PHI Shield, Excel
     Hell): a flags provider is honored when one is present, and its absence
     means on rather than off, since the app registers no provider today.
     Mounting the surface does not engage the block. The posture still starts
     off and the user turns it on, or back off, for the session.
     window.DATAGLOW_AIR_GAP is the explicit local override in either
     direction: false keeps the surface off entirely, true forces it on even if a
     provider reports the flag disabled. */
  function flagOn() {
    try { if (window.DATAGLOW_AIR_GAP === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_AIR_GAP === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('airGapMode') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function posture() {
    var e = engine();
    if (!e) return null;
    try { return e.getPosture(); } catch (_e) { return null; }
  }

  function isActive() {
    var p = posture();
    return !!(p && p.active);
  }

  /* ---------- fail-closed network guards ---------- */

  function pageOrigin() {
    try { return window.location && window.location.origin ? window.location.origin : ''; } catch (_e) { return ''; }
  }

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    if (input && typeof input.toString === 'function') return input.toString();
    return '';
  }

  function blockedError(target) {
    var err = new Error('Air-Gap Mode is on. ' + target + ' would leave this device, so the request was refused.');
    err.name = 'AirGapBlockedError';
    return err;
  }

  /* Wrapping fetch/XHR is what gives the toggle teeth: any code path that did
     not check shouldBlockNetwork() first still cannot reach the wire. Same
     origin stays open so the self-hosted DuckDB-WASM, Plotly, and SheetJS
     assets under assets/ keep loading and local engines keep working. */
  function installGuards() {
    var e = engine();
    if (!e || _savedFetch) return;
    if (typeof window.fetch === 'function') {
      _savedFetch = window.fetch;
      window.fetch = function (input, init) {
        var verdict = e.classifyRequestUrl(urlOf(input), pageOrigin());
        if (verdict.blocked) {
          reportBlock(verdict.reason);
          return Promise.reject(blockedError(verdict.reason));
        }
        return _savedFetch.apply(window, arguments);
      };
    }
    if (window.XMLHttpRequest && window.XMLHttpRequest.prototype && !_savedXhrOpen) {
      _savedXhrOpen = window.XMLHttpRequest.prototype.open;
      window.XMLHttpRequest.prototype.open = function (method, url) {
        var verdict = e.classifyRequestUrl(url, pageOrigin());
        if (verdict.blocked) {
          reportBlock(verdict.reason);
          throw blockedError(verdict.reason);
        }
        return _savedXhrOpen.apply(this, arguments);
      };
    }
  }

  function removeGuards() {
    if (_savedFetch) { window.fetch = _savedFetch; _savedFetch = null; }
    if (_savedXhrOpen) { window.XMLHttpRequest.prototype.open = _savedXhrOpen; _savedXhrOpen = null; }
  }

  function reportBlock(reason) {
    toast('Air-Gap Mode blocked an outbound request', 'warn');
    try {
      document.dispatchEvent(new CustomEvent('dataglow:air-gap-blocked', { detail: { reason: reason } }));
    } catch (_e) {}
  }

  /* The guard any AI, MCP, or server-offload call site can ask before acting.
     Returns true when the feature may proceed. */
  function allow(feature) {
    var e = engine();
    if (!e) return true;
    var d;
    try { d = e.shouldBlockNetwork(feature); } catch (_err) { return true; }
    if (d && d.blocked) {
      toast(d.message, 'warn');
      return false;
    }
    return true;
  }

  /* ---------- banner ---------- */

  function ensureBanner() {
    var el = document.getElementById(BANNER_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
    return el;
  }

  function renderBanner() {
    var el = ensureBanner();
    if (!isActive()) {
      el.classList.remove('open');
      el.innerHTML = '';
      return;
    }
    el.innerHTML = '<span>' + esc('Air-Gap Mode is on. Nothing leaves this device. Local engines keep working.') + '</span>';
    el.classList.add('open');
  }

  /* ---------- panel ---------- */

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Air-Gap Mode');
    panel.innerHTML =
      '<div style="width:36px;height:4px;border-radius:2px;background:var(--border);margin:10px auto 0;flex-shrink:0"></div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid var(--border);gap:10px">' +
        '<div style="min-width:0">' +
          '<div style="font-weight:800;font-size:15px">Air-Gap Mode</div>' +
          '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">One switch for a room where data must not leave.</div>' +
        '</div>' +
        '<button type="button" data-ag-close style="min-height:44px;min-width:44px;border:none;background:transparent;color:var(--text-muted);font-size:22px;cursor:pointer;border-radius:10px" aria-label="Close">\u00D7</button>' +
      '</div>' +
      '<div id="dg-air-gap-body" style="flex:1;overflow-y:auto;padding:14px 16px;-webkit-overflow-scrolling:touch"></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-ag-close]').addEventListener('click', closePanel);
    return panel;
  }

  function chips(ids, hot) {
    return ids.map(function (id) {
      return '<span class="dg-ag-chip' + (hot ? ' hot' : '') + '">' + esc(id) + '</span>';
    }).join('');
  }

  function renderBody() {
    var body = document.getElementById('dg-air-gap-body');
    var e = engine();
    if (!body) return;
    if (!e) {
      body.innerHTML = '<div class="dg-ag-card" style="color:var(--text-muted)">Air-Gap engine unavailable.</div>';
      return;
    }
    var p = posture();
    var copy = e.postureCopy(p);
    var on = !!(p && p.active);

    body.innerHTML =
      '<div class="dg-ag-card' + (on ? ' is-active' : '') + '">' +
        '<div style="font-size:11px;color:var(--text-muted);letter-spacing:.04em">POSTURE</div>' +
        '<div style="font-size:20px;font-weight:800;margin-top:2px">' + esc(copy.title) + '</div>' +
        '<div style="margin-top:8px;font-size:12px;line-height:1.55;color:var(--text-secondary,var(--text-muted))">' +
          esc(copy.body) + '<br>' + esc(copy.blocked) + '<br>' + esc(copy.local) +
        '</div>' +
        '<div class="dg-ag-actions">' +
          '<button type="button" class="dg-ag-btn ' + (on ? 'ghost' : 'primary') + '" data-ag-toggle>' +
            (on ? 'Turn off' : 'Turn on') + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="dg-ag-card">' +
        '<div style="font-weight:800;font-size:13px">Stays local</div>' +
        '<div style="margin-top:8px">' + chips(e.listLocalFeatures(), false) + '</div>' +
      '</div>' +
      '<div class="dg-ag-card">' +
        '<div style="font-weight:800;font-size:13px">Blocked while on</div>' +
        '<div style="margin-top:8px">' + chips(e.listEgressFeatures(), on) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.5">' +
          esc('Anything not on the local list is blocked too. Air-Gap Mode fails closed.') +
        '</div>' +
      '</div>' +
      '<div style="font-size:11px;line-height:1.5;color:var(--text-faint,var(--text-muted));padding:4px 2px 8px">' +
        esc(copy.disclaimer) +
      '</div>';

    var btn = body.querySelector('[data-ag-toggle]');
    if (btn) btn.onclick = function () { setActive(!isActive()); };
  }

  function setActive(next) {
    var e = engine();
    if (!e) return;
    if (next) {
      e.activate('user toggle');
      installGuards();
      toast('Air-Gap Mode on. Outbound paths blocked.');
    } else {
      e.deactivate();
      removeGuards();
      toast('Air-Gap Mode off. Outbound paths available again.');
    }
    afterChange();
  }

  function afterChange() {
    updateBadge();
    renderBanner();
    renderBody();
    /* Deliberately NOT logged to ProvenanceFabric: its ProofChain mirror can
       recurse on append and freeze the page (see the Shield Packs note). The
       event below is the integration point instead. */
    try {
      document.dispatchEvent(new CustomEvent('dataglow:air-gap-posture', { detail: { posture: posture() } }));
    } catch (_e) {}
  }

  function updateBadge() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    var on = isActive();
    btn.setAttribute('data-state', on ? 'on' : 'off');
    var label = btn.querySelector('[data-ag-label]');
    if (label) label.textContent = on ? 'Air-Gap · on' : 'Air-Gap';
  }

  function openPanel() {
    if (!flagOn()) return;
    ensurePanel();
    renderBody();
    document.getElementById(PANEL_ID).classList.add('open');
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('open');
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open Air-Gap Mode');
    btn.title = 'Air-Gap Mode . block every outbound path';
    btn.innerHTML = '<span class="dg-ag-dot" aria-hidden="true"></span><span data-ag-label>Air-Gap</span>';
    btn.addEventListener('click', function () {
      var panel = document.getElementById(PANEL_ID);
      if (panel && panel.classList.contains('open')) closePanel();
      else openPanel();
    });
    /* Sits next to the Shield Packs button so the whole privacy posture is one
       place, and falls back to the same fixed corner when no toolbar exists. */
    var packs = document.getElementById('dg-shield-packs-btn');
    if (packs && packs.parentNode) {
      packs.parentNode.insertBefore(btn, packs.nextSibling);
      if (packs.style.position === 'fixed') {
        btn.style.position = 'fixed';
        btn.style.bottom = '16px';
        btn.style.right = '212px';
        btn.style.zIndex = '12000';
      }
      return;
    }
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header');
    if (!toolbar) {
      toolbar = document.body;
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '212px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  function boot() {
    /* The surface is flag-gated, but the guards are always published: an AI or
       MCP call site can ask allowNetwork() without knowing whether the surface
       was built, and gets an honest "allowed" while the mode is off. */
    if (flagOn()) {
      injectButton();
      ensurePanel();
      updateBadge();
      renderBanner();
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closePanel();
      });
    }

    window.DataGlowAirGapUI = {
      version: 1,
      openPanel: openPanel,
      closePanel: closePanel,
      activate: function () { setActive(true); },
      deactivate: function () { setActive(false); },
      isActive: isActive,
      getPosture: posture,
      /* Fail-closed guards an AI, MCP, or offload call site checks first. */
      allowNetwork: allow,
      allowAi: function () { return allow('ai'); },
      allowMcp: function () { return allow('mcp'); },
      allowServerOffload: function () { return allow('serverOffload'); }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 760); });
  } else {
    setTimeout(boot, 760);
  }
})();
/* ---- end js/privacy/data-glow-air-gap-canvas.js ---- */
