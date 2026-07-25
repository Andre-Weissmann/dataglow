/* ---- from js/intelligence/data-glow-shield-packs-canvas.js ---- */
;(function () {
  'use strict';

  var PANEL_ID = 'dg-shield-packs-panel';
  var BTN_ID = 'dg-shield-packs-btn';
  var BANNER_ID = 'dg-shield-packs-banner';
  var PHI_PACK_ID = 'healthcare-phi';
  var SAMPLE_CAP = 400;

  /* Active pack ids for this session. In-memory only: no localStorage, no
     cookies, so the posture never silently persists across visits. */
  var _active = Object.create(null);
  var _scans = Object.create(null);
  var _dataset = null;

  function engine() { return window.DataGlowShieldPacks || null; }

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
    console.info('[Shield Packs]', msg);
  }

  function flagOn() {
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('shieldPacks') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function phiFlagOn() {
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('phiShield') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function activeIds() {
    var out = [];
    var packs = engine() ? engine().listPacks() : [];
    for (var i = 0; i < packs.length; i++) {
      if (_active[packs[i].id]) out.push(packs[i].id);
    }
    return out;
  }

  function currentPosture() {
    var e = engine();
    if (!e) return null;
    try { return e.posture({ activeIds: activeIds() }); } catch (_e) { return null; }
  }

  function activeDataset() {
    if (_dataset) return _dataset;
    try {
      if (typeof getActiveDataset === 'function') {
        var ds = getActiveDataset();
        if (ds) return ds;
      }
    } catch (_e) {}
    try {
      if (window.state && window.state.datasets && window.state.datasets[0]) {
        return window.state.datasets[0];
      }
    } catch (_e2) {}
    return null;
  }

  function colNames(ds) {
    var cols = (ds && ds.columns) || [];
    return cols.map(function (c, i) {
      if (typeof c === 'string') return c;
      return (c && (c.name || c.field)) || ('col' + i);
    });
  }

  /* Column-indexed row access (r[colIdx]), never r[col.name]: canvas grids
     carry array rows. Object rows are tolerated as a fallback. */
  function buildSamples(ds) {
    var names = colNames(ds);
    var rows = (ds && ds.rows) || [];
    var n = Math.min(rows.length, SAMPLE_CAP);
    var samples = {};
    for (var i = 0; i < names.length; i++) samples[names[i]] = [];
    for (var r = 0; r < n; r++) {
      var row = rows[r];
      if (!row) continue;
      for (var c = 0; c < names.length; c++) {
        var v = Array.isArray(row) ? row[c] : row[names[c]];
        if (v != null && v !== '') samples[names[c]].push(String(v));
      }
    }
    return samples;
  }

  function scanPack(packId, ds) {
    var e = engine();
    if (!e || packId === PHI_PACK_ID) return null;
    var target = ds || activeDataset();
    if (!target) return null;
    try {
      var res = e.scanColumnSamples(buildSamples(target), packId);
      _scans[packId] = res;
      return res;
    } catch (err) {
      console.warn('[Shield Packs] scan failed for ' + packId, err);
      return null;
    }
  }

  function rescanActive(ds) {
    var ids = activeIds();
    for (var i = 0; i < ids.length; i++) scanPack(ids[i], ds);
  }

  /* ---------- fail-closed banner ---------- */

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
    var p = currentPosture();
    var el = ensureBanner();
    if (!p || !p.banner) {
      el.classList.remove('open');
      el.innerHTML = '';
      return;
    }
    var parts = ['High sensitivity pack active.'];
    if (!p.aiAllowed) parts.push('AI paths blocked.');
    if (!p.exportAllowed) parts.push('Export blocked.');
    parts.push('Everything stays on this device.');
    el.innerHTML = '<span>' + esc(parts.join(' ')) + '</span>';
    el.classList.add('open');
  }

  /* ---------- panel ---------- */

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Shield Packs');
    panel.innerHTML =
      '<div style="width:36px;height:4px;border-radius:2px;background:var(--border);margin:10px auto 0;flex-shrink:0"></div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid var(--border);gap:10px">' +
        '<div style="min-width:0">' +
          '<div style="font-weight:800;font-size:15px">Shield Packs</div>' +
          '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">On-device privacy packs. Rows never leave this device.</div>' +
        '</div>' +
        '<button type="button" data-sp-close style="min-height:44px;min-width:44px;border:none;background:transparent;color:var(--text-muted);font-size:22px;cursor:pointer;border-radius:10px" aria-label="Close">\u00D7</button>' +
      '</div>' +
      '<div id="dg-shield-packs-body" style="flex:1;overflow-y:auto;padding:14px 16px;-webkit-overflow-scrolling:touch"></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-sp-close]').addEventListener('click', closePanel);
    return panel;
  }

  function packStatusLine(pack) {
    if (pack.id === PHI_PACK_ID) {
      var rep = null;
      try {
        rep = window.DataGlowPhiShield && window.DataGlowPhiShield.getLastReport
          ? window.DataGlowPhiShield.getLastReport() : null;
      } catch (_e) {}
      if (!rep) return 'Pack zero. Open the PHI panel to screen this dataset.';
      var st = rep.status || rep.verdict || 'review';
      var label = st === 'pass' ? 'Clear' : (st === 'fail' ? 'PHI risk' : 'Review');
      return 'Pack zero. Last screen: ' + label + '.';
    }
    var scan = _scans[pack.id];
    if (!_active[pack.id]) return pack.summary;
    if (!scan) return 'Active. Load a dataset to flag matching columns.';
    if (!scan.flaggedColumns.length) return 'Active. No matching columns in the sample.';
    return 'Active. ' + scan.flaggedColumns.length + ' column(s) flagged, ' + scan.hitCount + ' hit(s).';
  }

  function renderBody() {
    var body = document.getElementById('dg-shield-packs-body');
    var e = engine();
    if (!body) return;
    if (!e) {
      body.innerHTML = '<div class="dg-sp-card" style="color:var(--text-muted)">Shield Packs engine unavailable.</div>';
      return;
    }
    var packs = e.listPacks();
    var p = currentPosture();
    var copy = e.postureCopy(p);

    var cards = packs.map(function (pack) {
      var on = pack.id === PHI_PACK_ID ? phiFlagOn() : !!_active[pack.id];
      var isPhi = pack.id === PHI_PACK_ID;
      var badge = isPhi
        ? '<span class="dg-sp-badge">Pack 0</span>'
        : '<span class="dg-sp-badge">' + esc(pack.sensitivity) + '</span>';
      var action = isPhi
        ? '<button type="button" class="dg-sp-btn ghost" data-sp-open-phi>Open PHI panel</button>'
        : '<button type="button" class="dg-sp-btn ' + (on ? 'primary' : 'ghost') + '" data-sp-toggle="' + esc(pack.id) + '">' +
            (on ? 'Turn off' : 'Activate') + '</button>';
      var flaggedCols = '';
      if (!isPhi && on && _scans[pack.id] && _scans[pack.id].flaggedColumns.length) {
        flaggedCols = '<div style="margin-top:8px">' + _scans[pack.id].columns.slice(0, 12).map(function (c) {
          return '<span class="dg-sp-chip hot">' + esc(c.column) + '</span>';
        }).join('') + '</div>';
      }
      return '<div class="dg-sp-card' + (on ? ' is-active' : '') + '">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
          '<div style="min-width:0">' +
            '<div style="font-weight:800;font-size:13px">' + esc(pack.name) + ' ' + badge + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.5">' +
              esc(packStatusLine(pack)) + '</div>' +
          '</div>' +
          '<div style="flex:0 0 auto">' + action + '</div>' +
        '</div>' + flaggedCols +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="dg-sp-card" style="border-color:' + (p && p.banner ? 'var(--error, #E85D4C)' : 'var(--border)') + '">' +
        '<div style="font-size:11px;color:var(--text-muted);letter-spacing:.04em">POSTURE</div>' +
        '<div style="font-size:20px;font-weight:800;margin-top:2px">' + esc(copy.title) + '</div>' +
        '<div style="margin-top:8px;font-size:12px;line-height:1.55;color:var(--text-secondary,var(--text-muted))">' +
          esc(copy.body) + '<br>' + esc(copy.ai) + '<br>' + esc(copy.exportLine) +
        '</div>' +
      '</div>' +
      cards +
      '<div style="font-size:11px;line-height:1.5;color:var(--text-faint,var(--text-muted));padding:4px 2px 8px">' +
        esc(copy.disclaimer) +
      '</div>' +
      '<div class="dg-sp-actions">' +
        '<button type="button" class="dg-sp-btn primary" data-sp-rescan>Scan again</button>' +
        '<button type="button" class="dg-sp-btn ghost" data-sp-clear>Turn all off</button>' +
      '</div>';

    Array.prototype.forEach.call(body.querySelectorAll('[data-sp-toggle]'), function (btn) {
      btn.onclick = function () { togglePack(btn.getAttribute('data-sp-toggle')); };
    });
    var phiBtn = body.querySelector('[data-sp-open-phi]');
    if (phiBtn) phiBtn.onclick = function () {
      if (window.DataGlowPhiShield && window.DataGlowPhiShield.openPanel) {
        window.DataGlowPhiShield.openPanel();
      } else {
        toast('PHI Shield unavailable', 'warn');
      }
    };
    var rescan = body.querySelector('[data-sp-rescan]');
    if (rescan) rescan.onclick = function () {
      if (!activeDataset()) { toast('Load data first', 'warn'); return; }
      rescanActive();
      renderBody();
      toast('Shield Packs rescanned on device');
    };
    var clear = body.querySelector('[data-sp-clear]');
    if (clear) clear.onclick = function () {
      _active = Object.create(null);
      _scans = Object.create(null);
      afterChange();
      toast('All packs off');
    };
  }

  function togglePack(id) {
    var e = engine();
    if (!e || !e.getPack(id) || id === PHI_PACK_ID) return;
    if (_active[id]) {
      delete _active[id];
      delete _scans[id];
    } else {
      _active[id] = true;
      scanPack(id);
    }
    afterChange();
  }

  function afterChange() {
    updateBadge();
    renderBanner();
    renderBody();
    var p = currentPosture();
    // Deliberately NOT logged to ProvenanceFabric. Its ProofChain mirror resets
    // its re-entrancy guard synchronously around an async append(), so append()'s
    // continuation re-enters addStep and recurses without bound, freezing the
    // page. A posture toggle is the first thing a user clicks, so it must not
    // reach that path. The posture event below is the integration point instead.
    try {
      document.dispatchEvent(new CustomEvent('dataglow:shield-packs-posture', { detail: { posture: p } }));
    } catch (_e2) {}
  }

  function updateBadge() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    var p = currentPosture();
    var count = p ? p.activeCount : 0;
    btn.setAttribute('data-level', p ? p.level : 'standard');
    var label = btn.querySelector('[data-sp-label]');
    if (label) label.textContent = count > 0 ? 'Packs · ' + count : 'Packs';
  }

  function openPanel() {
    if (!flagOn()) return;
    ensurePanel();
    rescanActive();
    renderBody();
    document.getElementById(PANEL_ID).classList.add('open');
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('open');
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header');
    if (!toolbar) toolbar = document.body;
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open Shield Packs');
    btn.title = 'Shield Packs . on-device privacy packs';
    btn.innerHTML = '<span class="dg-sp-dot" aria-hidden="true"></span><span data-sp-label>Packs</span>';
    btn.addEventListener('click', function () {
      var panel = document.getElementById(PANEL_ID);
      if (panel && panel.classList.contains('open')) closePanel();
      else openPanel();
    });
    if (toolbar === document.body) {
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '96px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  function boot() {
    if (!flagOn()) return;
    injectButton();
    ensurePanel();
    updateBadge();

    document.addEventListener('dataglow:dataset-loaded', function (ev) {
      var ds = ev && ev.detail && ev.detail.dataset;
      if (!ds) return;
      _dataset = ds;
      rescanActive(ds);
      updateBadge();
      if (document.getElementById(PANEL_ID) &&
          document.getElementById(PANEL_ID).classList.contains('open')) renderBody();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closePanel();
    });

    window.DataGlowShieldPacksUI = {
      version: 1,
      openPanel: openPanel,
      closePanel: closePanel,
      listPacks: function () { return engine() ? engine().listPacks() : []; },
      getActiveIds: activeIds,
      activate: function (id) { if (!_active[id]) togglePack(id); },
      deactivate: function (id) { if (_active[id]) togglePack(id); },
      getPosture: currentPosture,
      getScan: function (id) { return _scans[id] || null; },
      /* Fail-closed guards any AI or export path can call before acting. */
      allowAi: function () {
        var p = currentPosture();
        return !p || p.aiAllowed === true;
      },
      allowExport: function () {
        var p = currentPosture();
        return !p || p.exportAllowed === true;
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 700); });
  } else {
    setTimeout(boot, 700);
  }
})();
/* ---- end js/intelligence/data-glow-shield-packs-canvas.js ---- */
