/* ---- from js/semantic/kpi-library.js ---- */
/* ================================================================
   DataGlow KPI Library (Session D, PR #535)
   Feature flag: window.FEATURE_FLAGS.kpiLibrary

   The gap: Metric Studio lets ONE analyst define metrics privately.
   KPI Library promotes those to a shared, searchable, owned library.

   What it adds on top of Metric Studio:
     - KPIs have: name, expr, owner, description, category, pinned
     - Stored in OPFS (dg-kpis.json) -- still local-first, this session
     - "Promote to KPI" button on each Metric Studio metric
     - KPI Registry panel: search, browse by category, pin favorites
     - NL bar resolves KPI names BEFORE personal metric names
       (KPIs win -- they represent the agreed definition)
     - KPI chip: pinned KPIs appear as one-tap chips above the NL bar
     - Emits: dataglow:kpi-added, dataglow:kpi-used, dataglow:kpi-pinned

   Categories (fixed set, analyst picks one):
     revenue | cost | quality | throughput | safety | outcome | custom

   Storage format (dg-kpis.json):
     [ { name, expr, owner, description, category, pinned,
         created, used, promoted_from_metric } ]
================================================================ */
(function () {
  'use strict';

  var FLAG = 'kpiLibrary';
  var OPFS_FILE = 'dg-kpis.json';
  var MAX_KPIS  = 50;

  var CATEGORIES = ['revenue','cost','quality','throughput','safety','outcome','custom'];
  var CAT_COLORS = {
    revenue:    '#4AE38A',
    cost:       '#F5A623',
    quality:    'var(--primary,#20C5B5)',
    throughput: '#A86FDF',
    safety:     '#DD6974',
    outcome:    '#5591C7',
    custom:     'var(--text-muted)'
  };

  function isEnabled() { return !!(window.FEATURE_FLAGS && window.FEATURE_FLAGS[FLAG]); }

  /* ----------------------------------------------------------------
     OPFS
  ---------------------------------------------------------------- */
  var _kpis   = [];
  var _loaded = false;

  function load() {
    if (_loaded) return Promise.resolve(_kpis);
    if (!navigator.storage || !navigator.storage.getDirectory) { _loaded = true; return Promise.resolve([]); }
    return navigator.storage.getDirectory().then(function (root) {
      return root.getFileHandle(OPFS_FILE)
        .then(function (fh) { return fh.getFile(); })
        .then(function (f)  { return f.text(); })
        .then(function (t)  { try { _kpis = JSON.parse(t) || []; } catch(_) { _kpis = []; } _loaded = true; return _kpis; });
    }).catch(function () { _loaded = true; return []; });
  }

  function save() {
    if (!navigator.storage || !navigator.storage.getDirectory) return;
    navigator.storage.getDirectory().then(function (root) {
      return root.getFileHandle(OPFS_FILE, { create: true })
        .then(function (fh) { return fh.createWritable(); })
        .then(function (w)  { return w.write(JSON.stringify(_kpis)).then(function () { return w.close(); }); });
    }).catch(function () {});
  }

  /* ----------------------------------------------------------------
     KPI CRUD
  ---------------------------------------------------------------- */
  function addKPI(opts) {
    /* opts: { name, expr, owner, description, category, promoted_from_metric } */
    var name = (opts.name || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!name || !opts.expr) return { ok: false, error: 'Name and expression required.' };
    if (_kpis.length >= MAX_KPIS) return { ok: false, error: 'Maximum ' + MAX_KPIS + ' KPIs reached.' };
    if (_kpis.some(function (k) { return k.name === name; })) {
      return { ok: false, error: '"' + name + '" already exists as a KPI.' };
    }
    var kpi = {
      name:                  name,
      expr:                  opts.expr.trim(),
      owner:                 opts.owner || 'this analyst',
      description:           opts.description || '',
      category:              CATEGORIES.includes(opts.category) ? opts.category : 'custom',
      pinned:                false,
      created:               Date.now(),
      used:                  0,
      promoted_from_metric:  opts.promoted_from_metric || false
    };
    _kpis.push(kpi);
    save();
    document.dispatchEvent(new CustomEvent('dataglow:kpi-added', { detail: { name: name, category: kpi.category } }));
    renderPinnedChips();
    return { ok: true };
  }

  function deleteKPI(name) {
    _kpis = _kpis.filter(function (k) { return k.name !== name; });
    save();
    renderPinnedChips();
  }

  function pinKPI(name, val) {
    var k = _kpis.find(function (x) { return x.name === name; });
    if (!k) return;
    k.pinned = val !== undefined ? val : !k.pinned;
    save();
    renderPinnedChips();
    document.dispatchEvent(new CustomEvent('dataglow:kpi-pinned', { detail: { name: name, pinned: k.pinned } }));
  }

  function getKPIs(category) {
    if (category) return _kpis.filter(function (k) { return k.category === category; });
    return _kpis.slice();
  }

  /* ----------------------------------------------------------------
     NL substitution -- KPIs resolve BEFORE Metric Studio metrics
  ---------------------------------------------------------------- */
  function substituteKPIs(nlQuery) {
    if (!_kpis.length) return { query: nlQuery, substituted: [] };
    var result = nlQuery;
    var substituted = [];
    _kpis.forEach(function (k) {
      var pattern = new RegExp('\\b' + k.name.replace(/_/g, '[_ ]') + '\\b', 'gi');
      if (pattern.test(result)) {
        result = result.replace(pattern, '(' + k.expr + ')');
        k.used++;
        substituted.push(k.name);
      }
    });
    if (substituted.length) {
      save();
      document.dispatchEvent(new CustomEvent('dataglow:kpi-used', { detail: { names: substituted } }));
    }
    return { query: result, substituted: substituted };
  }

  /* ----------------------------------------------------------------
     Pinned KPI chips (above the NL bar)
  ---------------------------------------------------------------- */
  function renderPinnedChips() {
    var pinned = _kpis.filter(function (k) { return k.pinned; });
    var container = document.getElementById('dg-kpi-chips');
    if (!container) return;
    if (!pinned.length) { container.innerHTML = ''; container.style.display = 'none'; return; }
    container.style.display = 'flex';
    container.innerHTML = pinned.map(function (k) {
      return '<button class="dg-kpi-chip" data-kpi="' + k.name + '"' +
        ' data-testid="chip-kpi-' + k.name + '"' +
        ' style="border-color:' + (CAT_COLORS[k.category] || 'var(--border)') + '"' +
        ' title="' + k.name + ': ' + k.expr + '">' +
        '<span class="dg-kpi-chip-cat" style="color:' + (CAT_COLORS[k.category] || 'var(--text-muted)') + '">' + k.category + '</span>' +
        '<span class="dg-kpi-chip-name">' + k.name + '</span>' +
        '</button>';
    }).join('');

    /* Clicking a chip inserts the KPI name into the NL bar */
    container.querySelectorAll('.dg-kpi-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = document.getElementById('nl-query-input');
        if (input) {
          var val = input.value.trim();
          input.value = val ? val + ' ' + btn.getAttribute('data-kpi') : btn.getAttribute('data-kpi');
          input.focus();
        }
      });
    });
  }

  function injectChipBar() {
    if (document.getElementById('dg-kpi-chips')) return;
    var bar = document.createElement('div');
    bar.id = 'dg-kpi-chips';
    bar.className = 'dg-kpi-chips';
    bar.style.display = 'none';
    bar.setAttribute('data-flag-tier', '1');
    /* Insert above the agent bar */
    var agentBar = document.getElementById('agent-bar');
    if (agentBar && agentBar.parentNode) {
      agentBar.parentNode.insertBefore(bar, agentBar);
    }
    renderPinnedChips();
  }

  /* ----------------------------------------------------------------
     KPI Registry panel
  ---------------------------------------------------------------- */
  var _panelOpen = false;

  function toggleRegistryPanel() {
    var existing = document.getElementById('dg-kpi-panel');
    if (existing) {
      existing.classList.remove('dg-kpi-panel-open');
      setTimeout(function () { if (existing.parentNode) existing.parentNode.removeChild(existing); }, 220);
      _panelOpen = false;
      return;
    }
    _panelOpen = true;
    renderRegistryPanel();
  }

  function renderRegistryPanel() {
    var panel = document.createElement('div');
    panel.id = 'dg-kpi-panel';
    panel.className = 'dg-kpi-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'KPI Library');

    panel.innerHTML = _buildPanelHTML();
    _positionPanel(panel);
    document.body.appendChild(panel);
    requestAnimationFrame(function () { panel.classList.add('dg-kpi-panel-open'); });

    /* Search */
    panel.querySelector('#dg-kpi-search').addEventListener('input', function () {
      panel.querySelector('#dg-kpi-list').innerHTML = _buildKPIList(this.value.trim(), panel.querySelector('[data-cat-filter].active'));
      _wireListEvents(panel);
    });

    /* Category filter tabs */
    panel.querySelectorAll('[data-cat-filter]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        panel.querySelectorAll('[data-cat-filter]').forEach(function (t) { t.classList.remove('active'); });
        this.classList.add('active');
        var search = panel.querySelector('#dg-kpi-search').value.trim();
        panel.querySelector('#dg-kpi-list').innerHTML = _buildKPIList(search, this.getAttribute('data-cat-filter') === 'all' ? null : this.getAttribute('data-cat-filter'));
        _wireListEvents(panel);
      });
    });

    /* Add form */
    panel.querySelector('#dg-kpi-add-btn').addEventListener('click', function () { _handleAdd(panel); });
    ['#dg-kpi-name','#dg-kpi-expr','#dg-kpi-owner','#dg-kpi-desc'].forEach(function (sel) {
      var el = panel.querySelector(sel);
      if (el) el.addEventListener('keydown', function (e) { if (e.key === 'Enter') _handleAdd(panel); });
    });

    /* Close */
    panel.querySelector('.dg-kpi-close').addEventListener('click', toggleRegistryPanel);

    _wireListEvents(panel);

    setTimeout(function () {
      document.addEventListener('click', function onOut(e) {
        var p2 = document.getElementById('dg-kpi-panel');
        var btn = document.getElementById('dg-kpi-registry-btn');
        if (p2 && !p2.contains(e.target) && (!btn || !btn.contains(e.target))) {
          if (p2.parentNode) p2.parentNode.removeChild(p2);
          _panelOpen = false;
          document.removeEventListener('click', onOut);
        }
      });
    }, 50);

    panel.querySelector('#dg-kpi-name').focus();
  }

  function _buildPanelHTML() {
    var catTabs = ['all'].concat(CATEGORIES).map(function (c) {
      return '<button class="dg-kpi-cat-tab' + (c === 'all' ? ' active' : '') + '" data-cat-filter="' + c + '">' + c + '</button>';
    }).join('');

    return '<div class="dg-kpi-header">' +
      '<span class="dg-kpi-title">KPI Library</span>' +
      '<span class="dg-kpi-count">' + _kpis.length + ' / ' + MAX_KPIS + '</span>' +
      '<button class="dg-kpi-close" aria-label="Close KPI Library">' +
        '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>' +
      '</button>' +
    '</div>' +
    '<div class="dg-kpi-search-row">' +
      '<input id="dg-kpi-search" class="dg-kpi-search" type="text" placeholder="Search KPIs..." autocomplete="off" data-testid="input-kpi-search"/>' +
    '</div>' +
    '<div class="dg-kpi-cat-tabs">' + catTabs + '</div>' +
    '<div class="dg-kpi-list" id="dg-kpi-list">' + _buildKPIList('', null) + '</div>' +
    '<div class="dg-kpi-add-form">' +
      '<div class="dg-kpi-add-title">Define KPI</div>' +
      '<input id="dg-kpi-name" class="dg-kpi-input" type="text" placeholder="KPI name (e.g. net_revenue)" maxlength="40" data-testid="input-kpi-name" autocomplete="off"/>' +
      '<input id="dg-kpi-expr" class="dg-kpi-input" type="text" placeholder="SQL expression" data-testid="input-kpi-expr" autocomplete="off"/>' +
      '<div class="dg-kpi-add-row">' +
        '<input id="dg-kpi-owner" class="dg-kpi-input dg-kpi-input-sm" type="text" placeholder="Owner" maxlength="40" data-testid="input-kpi-owner" autocomplete="off"/>' +
        '<select id="dg-kpi-cat" class="dg-kpi-select" data-testid="select-kpi-category">' +
          CATEGORIES.map(function (c) { return '<option value="' + c + '">' + c + '</option>'; }).join('') +
        '</select>' +
      '</div>' +
      '<input id="dg-kpi-desc" class="dg-kpi-input" type="text" placeholder="Description (optional)" data-testid="input-kpi-desc" autocomplete="off"/>' +
      '<p id="dg-kpi-error" class="dg-kpi-error hidden"></p>' +
      '<button id="dg-kpi-add-btn" class="dg-kpi-add-btn" data-testid="button-kpi-add">Add KPI</button>' +
    '</div>';
  }

  function _buildKPIList(search, category) {
    var items = _kpis.filter(function (k) {
      var matchSearch = !search || k.name.includes(search.toLowerCase()) || k.description.toLowerCase().includes(search.toLowerCase());
      var matchCat    = !category || k.category === category;
      return matchSearch && matchCat;
    });
    if (!items.length) return '<p class="dg-kpi-empty">' + (search ? 'No KPIs match "' + search + '".' : 'No KPIs defined yet.') + '</p>';
    return items.map(function (k) {
      var catColor = CAT_COLORS[k.category] || 'var(--text-muted)';
      return '<div class="dg-kpi-item" data-testid="kpi-item-' + k.name + '">' +
        '<div class="dg-kpi-item-top">' +
          '<span class="dg-kpi-cat-badge" style="color:' + catColor + ';border-color:' + catColor + '20">' + k.category + '</span>' +
          '<span class="dg-kpi-name-label">' + k.name + '</span>' +
          '<span class="dg-kpi-owner-label">' + k.owner + '</span>' +
          '<div class="dg-kpi-actions">' +
            '<button class="dg-kpi-pin-btn" data-pin="' + k.name + '" data-testid="button-pin-kpi-' + k.name + '" title="' + (k.pinned ? 'Unpin' : 'Pin to bar') + '">' +
              '<svg viewBox="0 0 16 16" width="12" height="12" fill="' + (k.pinned ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.5"><path d="M9 2l5 5-2 2-2-1-3 3v3l-1 1-1-1V12L2 9l1-1h3L9 5z"/></svg>' +
            '</button>' +
            '<button class="dg-kpi-del-btn" data-del="' + k.name + '" data-testid="button-del-kpi-' + k.name + '" aria-label="Delete ' + k.name + '">' +
              '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>' +
        (k.description ? '<p class="dg-kpi-desc-text">' + k.description + '</p>' : '') +
        '<code class="dg-kpi-expr-code">' + k.expr + '</code>' +
        (k.used ? '<span class="dg-kpi-used-badge">used ' + k.used + 'x</span>' : '') +
      '</div>';
    }).join('');
  }

  function _wireListEvents(panel) {
    panel.querySelectorAll('[data-pin]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        pinKPI(btn.getAttribute('data-pin'));
        /* Re-render the list in place */
        var search = panel.querySelector('#dg-kpi-search').value.trim();
        var activeTab = panel.querySelector('[data-cat-filter].active');
        var cat = activeTab && activeTab.getAttribute('data-cat-filter') !== 'all' ? activeTab.getAttribute('data-cat-filter') : null;
        panel.querySelector('#dg-kpi-list').innerHTML = _buildKPIList(search, cat);
        _wireListEvents(panel);
        panel.querySelector('.dg-kpi-count').textContent = _kpis.length + ' / ' + MAX_KPIS;
      });
    });
    panel.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteKPI(btn.getAttribute('data-del'));
        var search = panel.querySelector('#dg-kpi-search').value.trim();
        var activeTab = panel.querySelector('[data-cat-filter].active');
        var cat = activeTab && activeTab.getAttribute('data-cat-filter') !== 'all' ? activeTab.getAttribute('data-cat-filter') : null;
        panel.querySelector('#dg-kpi-list').innerHTML = _buildKPIList(search, cat);
        _wireListEvents(panel);
        panel.querySelector('.dg-kpi-count').textContent = _kpis.length + ' / ' + MAX_KPIS;
        if (typeof window.showToast === 'function') window.showToast('KPI deleted.', 'info');
      });
    });
  }

  function _handleAdd(panel) {
    var name  = panel.querySelector('#dg-kpi-name').value;
    var expr  = panel.querySelector('#dg-kpi-expr').value;
    var owner = panel.querySelector('#dg-kpi-owner').value;
    var desc  = panel.querySelector('#dg-kpi-desc').value;
    var cat   = panel.querySelector('#dg-kpi-cat').value;
    var err   = panel.querySelector('#dg-kpi-error');
    var result = addKPI({ name: name, expr: expr, owner: owner, description: desc, category: cat });
    if (!result.ok) { err.textContent = result.error; err.classList.remove('hidden'); return; }
    err.classList.add('hidden');
    ['#dg-kpi-name','#dg-kpi-expr','#dg-kpi-owner','#dg-kpi-desc'].forEach(function (sel) {
      var el = panel.querySelector(sel); if (el) el.value = '';
    });
    panel.querySelector('#dg-kpi-list').innerHTML = _buildKPIList('', null);
    _wireListEvents(panel);
    panel.querySelector('.dg-kpi-count').textContent = _kpis.length + ' / ' + MAX_KPIS;
    if (typeof window.showToast === 'function') window.showToast('KPI "' + name.trim().toLowerCase() + '" added.', 'success');
    panel.querySelector('#dg-kpi-name').focus();
  }

  function _positionPanel(panel) {
    var btn = document.getElementById('dg-kpi-registry-btn') || document.getElementById('agent-bar');
    if (btn) {
      var rect = btn.getBoundingClientRect();
      panel.style.cssText = 'position:fixed;bottom:' + (window.innerHeight - rect.top + 8) + 'px;left:' + Math.max(8, rect.left) + 'px;z-index:15000';
    }
  }

  /* ----------------------------------------------------------------
     KPI Registry button (in agent bar, next to Metric button)
  ---------------------------------------------------------------- */
  function injectRegistryBtn() {
    if (document.getElementById('dg-kpi-registry-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'dg-kpi-registry-btn';
    btn.className = 'dg-kpi-registry-btn';
    btn.setAttribute('data-testid', 'button-kpi-registry');
    btn.setAttribute('aria-label', 'KPI Library');
    btn.setAttribute('data-flag-tier', '1');
    btn.title = 'Open KPI Library -- shared metric definitions';
    btn.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><circle cx="12" cy="12" r="3"/></svg> <span>KPIs</span>';
    btn.addEventListener('click', toggleRegistryPanel);

    /* Place next to the Metric Studio button */
    var metricBtn = document.getElementById('dg-metric-define-btn');
    if (metricBtn && metricBtn.parentNode) {
      metricBtn.parentNode.insertBefore(btn, metricBtn.nextSibling);
    } else {
      var wrap = document.getElementById('nl-query-wrap') || document.getElementById('agent-bar');
      if (wrap) wrap.appendChild(btn);
    }
  }

  /* ----------------------------------------------------------------
     NL bar hook -- KPIs resolve first (capture phase, before MetricStudio)
  ---------------------------------------------------------------- */
  function hookNlBar() {
    var input = document.getElementById('nl-query-input');
    if (!input) { setTimeout(hookNlBar, 800); return; }
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || !_kpis.length) return;
      var result = substituteKPIs(input.value);
      if (result.substituted.length) {
        input.value = result.query;
        if (typeof window.showToast === 'function') {
          window.showToast('KPI substituted: ' + result.substituted.join(', '), 'info');
        }
      }
    }, true /* capture -- before MetricStudio's listener */);
  }

  /* ----------------------------------------------------------------
     Promote-from-Metric integration
     If MetricStudio is present, patch its panel to add a Promote button.
  ---------------------------------------------------------------- */
  function patchMetricStudio() {
    if (!window.MetricStudio) return;
    var origList = window.MetricStudio.list;
    document.addEventListener('dataglow:metric-added', function (e) {
      /* After a metric is added, offer promotion if user has KPI access */
      if (!isEnabled()) return;
      /* Inject promote button into Metric Studio panel if open */
      setTimeout(function () {
        var panel = document.getElementById('dg-metric-panel');
        if (!panel) return;
        var items = panel.querySelectorAll('.dg-mp-item');
        items.forEach(function (item) {
          if (item.querySelector('.dg-mp-promote')) return;
          var nameEl = item.querySelector('.dg-mp-name-chip');
          var exprEl = item.querySelector('.dg-mp-expr-preview');
          if (!nameEl || !exprEl) return;
          var name = nameEl.textContent.trim();
          var expr = exprEl.textContent.trim();
          var promBtn = document.createElement('button');
          promBtn.className = 'dg-mp-promote';
          promBtn.setAttribute('data-testid', 'button-promote-' + name);
          promBtn.title = 'Promote to KPI Library';
          promBtn.textContent = 'Promote to KPI';
          promBtn.addEventListener('click', function () {
            var r = addKPI({ name: name, expr: expr, promoted_from_metric: true, category: 'custom' });
            if (r.ok) {
              promBtn.textContent = 'In KPI Library';
              promBtn.disabled = true;
              if (typeof window.showToast === 'function') window.showToast('"' + name + '" promoted to KPI Library.', 'success');
            } else {
              promBtn.textContent = r.error;
            }
          });
          item.querySelector('.dg-mp-item-top').appendChild(promBtn);
        });
      }, 100);
    });
  }

  /* ----------------------------------------------------------------
     Init
  ---------------------------------------------------------------- */
  function init() {
    if (!isEnabled()) return;
    load().then(function () {
      document.addEventListener('dataglow:dataset-loaded', function () {
        injectChipBar();
        injectRegistryBtn();
        hookNlBar();
        patchMetricStudio();
      });
      window.KPILibrary = {
        add:         addKPI,
        remove:      deleteKPI,
        pin:         pinKPI,
        list:        getKPIs,
        substitute:  substituteKPIs,
        openPanel:   toggleRegistryPanel
      };
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
/* ---- end js/semantic/kpi-library.js ---- */
