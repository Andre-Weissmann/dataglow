/* ---- from js/semantic/metric-studio.js ---- */
/* ================================================================
   DataGlow Metric Studio (Session C, PR #532)
   Feature flag: window.FEATURE_FLAGS.metricStudio

   The semantic gap: two analysts ask "show me revenue" and get
   two different answers because "revenue" is undefined in the system.
   Metric Studio closes that gap -- locally, privately, for this analyst.

   What it does:
     - Analyst defines up to 20 named metrics: name + SQL expression
     - Stored in OPFS (never uploaded, survives page refresh)
     - NL bar interception: before NL-to-SQL runs, MetricStudio
       substitutes known metric names with their SQL expressions
     - "Define Metric" button in the agent bar opens a 2-field form
     - Metrics panel shows all defined metrics, inline edit/delete

   Example:
     Metric: "revenue" = "SUM(amount) WHERE status = 'paid'"
     Analyst types: "show me revenue by month"
     System sees:   "show me SUM(amount) WHERE status = 'paid' by month"
     SQL generated: SELECT strftime('%Y-%m', date), SUM(amount)
                    FROM data WHERE status = 'paid' GROUP BY 1

   Storage format (OPFS file: dg-metrics.json):
     [ { name: "revenue", expr: "SUM(amount) WHERE status='paid'",
         created: 1234567890, used: 3 } ]
================================================================ */
(function () {
  'use strict';

  var FLAG = 'metricStudio';
  var OPFS_FILE = 'dg-metrics.json';
  var MAX_METRICS = 20;

  function isEnabled() {
    return !!(window.FEATURE_FLAGS && window.FEATURE_FLAGS[FLAG]);
  }

  /* ----------------------------------------------------------------
     OPFS persistence
  ---------------------------------------------------------------- */
  var _metrics = [];   /* in-memory cache */
  var _loaded  = false;

  function loadMetrics() {
    if (_loaded) return Promise.resolve(_metrics);
    if (!navigator.storage || !navigator.storage.getDirectory) {
      _loaded = true;
      return Promise.resolve([]);
    }
    return navigator.storage.getDirectory().then(function (root) {
      return root.getFileHandle(OPFS_FILE)
        .then(function (fh) { return fh.getFile(); })
        .then(function (f)  { return f.text(); })
        .then(function (txt) {
          try { _metrics = JSON.parse(txt) || []; } catch (_) { _metrics = []; }
          _loaded = true;
          return _metrics;
        });
    }).catch(function () {
      _loaded = true;
      return [];
    });
  }

  function saveMetrics() {
    if (!navigator.storage || !navigator.storage.getDirectory) return Promise.resolve();
    return navigator.storage.getDirectory().then(function (root) {
      return root.getFileHandle(OPFS_FILE, { create: true })
        .then(function (fh) { return fh.createWritable(); })
        .then(function (w)  { return w.write(JSON.stringify(_metrics)).then(function () { return w.close(); }); });
    }).catch(function () {});
  }

  /* ----------------------------------------------------------------
     Metric CRUD
  ---------------------------------------------------------------- */
  function addMetric(name, expr) {
    name = name.trim().toLowerCase().replace(/\s+/g, '_');
    expr = expr.trim();
    if (!name || !expr) return { ok: false, error: 'Name and expression are required.' };
    if (_metrics.length >= MAX_METRICS) return { ok: false, error: 'Maximum ' + MAX_METRICS + ' metrics reached.' };
    if (_metrics.some(function (m) { return m.name === name; })) {
      return { ok: false, error: '"' + name + '" already exists. Delete it first.' };
    }
    _metrics.push({ name: name, expr: expr, created: Date.now(), used: 0 });
    saveMetrics();
    document.dispatchEvent(new CustomEvent('dataglow:metric-added', { detail: { name: name } }));
    return { ok: true };
  }

  function deleteMetric(name) {
    _metrics = _metrics.filter(function (m) { return m.name !== name; });
    saveMetrics();
    document.dispatchEvent(new CustomEvent('dataglow:metric-deleted', { detail: { name: name } }));
  }

  function updateMetric(name, newExpr) {
    var m = _metrics.find(function (x) { return x.name === name; });
    if (!m) return false;
    m.expr = newExpr.trim();
    saveMetrics();
    return true;
  }

  function getMetrics() { return _metrics.slice(); }

  /* ----------------------------------------------------------------
     NL bar interception
     Before NL-to-SQL runs, replace metric names with their expressions.
     Matches whole words only (case-insensitive).
  ---------------------------------------------------------------- */
  function substituteMetrics(nlQuery) {
    if (!_metrics.length) return { query: nlQuery, substituted: [] };
    var result = nlQuery;
    var substituted = [];
    _metrics.forEach(function (m) {
      var pattern = new RegExp('\\b' + m.name.replace(/_/g, '[_ ]') + '\\b', 'gi');
      if (pattern.test(result)) {
        result = result.replace(pattern, '(' + m.expr + ')');
        m.used = (m.used || 0) + 1;
        substituted.push(m.name);
      }
    });
    if (substituted.length) saveMetrics();
    return { query: result, substituted: substituted };
  }

  /* ----------------------------------------------------------------
     "Define Metric" button + inline form
  ---------------------------------------------------------------- */
  function buildDefineBtn() {
    var btn = document.createElement('button');
    btn.id = 'dg-metric-define-btn';
    btn.className = 'dg-metric-define-btn';
    btn.setAttribute('data-testid', 'button-define-metric');
    btn.setAttribute('aria-label', 'Define a metric');
    btn.title = 'Define a named metric (e.g. revenue = SUM(amount))';
    btn.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg> <span>Metric</span>';
    btn.addEventListener('click', function () { toggleMetricPanel(); });
    return btn;
  }

  /* ----------------------------------------------------------------
     Metric panel (define + list)
  ---------------------------------------------------------------- */
  var _panelOpen = false;

  function toggleMetricPanel() {
    var existing = document.getElementById('dg-metric-panel');
    if (existing) {
      existing.classList.remove('dg-metric-panel-open');
      setTimeout(function () {
        if (existing.parentNode) existing.parentNode.removeChild(existing);
      }, 220);
      _panelOpen = false;
      return;
    }
    _panelOpen = true;
    renderPanel();
  }

  function renderPanel() {
    var panel = document.createElement('div');
    panel.id = 'dg-metric-panel';
    panel.className = 'dg-metric-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Metric Studio');

    var header = '<div class="dg-mp-header">' +
      '<span class="dg-mp-title">Metric Studio</span>' +
      '<span class="dg-mp-count">' + _metrics.length + ' / ' + MAX_METRICS + '</span>' +
      '<button class="dg-mp-close" data-testid="button-metric-panel-close" aria-label="Close Metric Studio">' +
        '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>' +
      '</button>' +
      '</div>';

    var form = '<div class="dg-mp-form">' +
      '<input id="dg-mp-name" class="dg-mp-input" type="text" placeholder="Metric name (e.g. revenue)" maxlength="40" data-testid="input-metric-name" autocomplete="off" />' +
      '<input id="dg-mp-expr" class="dg-mp-input" type="text" placeholder="SQL expression (e.g. SUM(amount) WHERE status=\'paid\')" data-testid="input-metric-expr" autocomplete="off" />' +
      '<button id="dg-mp-add" class="dg-mp-add-btn" data-testid="button-metric-add">Define</button>' +
      '<p id="dg-mp-error" class="dg-mp-error hidden"></p>' +
      '</div>';

    var list = '<div class="dg-mp-list" id="dg-mp-list">' + renderMetricList() + '</div>';

    var hint = _metrics.length === 0
      ? '<p class="dg-mp-hint">Define a metric once. Use it in any query by name.<br>Example: <code>revenue</code> = <code>SUM(amount) WHERE status=\'paid\'</code></p>'
      : '';

    panel.innerHTML = header + form + list + hint;

    /* Position below the define button */
    var defBtn = document.getElementById('dg-metric-define-btn');
    var agentBar = document.getElementById('agent-bar');
    var anchor = defBtn || agentBar;
    if (anchor) {
      var rect = anchor.getBoundingClientRect();
      panel.style.cssText = 'position:fixed;bottom:' + (window.innerHeight - rect.top + 8) + 'px;left:' + Math.max(8, rect.left) + 'px;z-index:15000';
    }

    document.body.appendChild(panel);
    requestAnimationFrame(function () { panel.classList.add('dg-metric-panel-open'); });

    /* Wire close */
    panel.querySelector('.dg-mp-close').addEventListener('click', toggleMetricPanel);

    /* Wire add button */
    panel.querySelector('#dg-mp-add').addEventListener('click', function () {
      var name = panel.querySelector('#dg-mp-name').value;
      var expr = panel.querySelector('#dg-mp-expr').value;
      var result = addMetric(name, expr);
      if (!result.ok) {
        var errEl = panel.querySelector('#dg-mp-error');
        errEl.textContent = result.error;
        errEl.classList.remove('hidden');
        return;
      }
      panel.querySelector('#dg-mp-name').value = '';
      panel.querySelector('#dg-mp-expr').value = '';
      panel.querySelector('#dg-mp-list').innerHTML = renderMetricList();
      panel.querySelector('#dg-mp-error').classList.add('hidden');
      panel.querySelector('.dg-mp-count').textContent = _metrics.length + ' / ' + MAX_METRICS;
      if (typeof window.showToast === 'function') {
        window.showToast('Metric "' + name.trim().toLowerCase() + '" defined.', 'success');
      }
    });

    /* Enter key submits */
    [panel.querySelector('#dg-mp-name'), panel.querySelector('#dg-mp-expr')].forEach(function (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') panel.querySelector('#dg-mp-add').click();
      });
    });

    /* Wire delete buttons (delegated) */
    panel.querySelector('#dg-mp-list').addEventListener('click', function (e) {
      var delBtn = e.target.closest('[data-delete-metric]');
      if (delBtn) {
        deleteMetric(delBtn.getAttribute('data-delete-metric'));
        panel.querySelector('#dg-mp-list').innerHTML = renderMetricList();
        panel.querySelector('.dg-mp-count').textContent = _metrics.length + ' / ' + MAX_METRICS;
      }
    });

    /* Close on outside click */
    setTimeout(function () {
      document.addEventListener('click', function onOut(e) {
        var panel2 = document.getElementById('dg-metric-panel');
        var btn = document.getElementById('dg-metric-define-btn');
        if (panel2 && !panel2.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
          if (panel2.parentNode) panel2.parentNode.removeChild(panel2);
          _panelOpen = false;
          document.removeEventListener('click', onOut);
        }
      });
    }, 50);

    panel.querySelector('#dg-mp-name').focus();
  }

  function renderMetricList() {
    if (!_metrics.length) return '<p class="dg-mp-empty">No metrics defined yet.</p>';
    return _metrics.map(function (m) {
      return '<div class="dg-mp-item" data-testid="metric-item-' + m.name + '">' +
        '<div class="dg-mp-item-top">' +
          '<span class="dg-mp-name-chip">' + m.name + '</span>' +
          '<button class="dg-mp-del" data-delete-metric="' + m.name + '" data-testid="button-delete-metric-' + m.name + '" aria-label="Delete ' + m.name + '">' +
            '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>' +
          '</button>' +
        '</div>' +
        '<code class="dg-mp-expr-preview">' + m.expr + '</code>' +
        (m.used ? '<span class="dg-mp-used">used ' + m.used + 'x</span>' : '') +
        '</div>';
    }).join('');
  }

  /* ----------------------------------------------------------------
     NL bar interception -- hook into the existing NL pipeline
  ---------------------------------------------------------------- */
  function hookNlBar() {
    var input = document.getElementById('nl-query-input');
    if (!input) { setTimeout(hookNlBar, 800); return; }

    /* Intercept submit -- fires before existing NL-to-SQL handler */
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (!_metrics.length) return; /* nothing to substitute */
      var val = input.value;
      var result = substituteMetrics(val);
      if (result.substituted.length) {
        input.value = result.query;
        /* Visual feedback */
        if (typeof window.showToast === 'function') {
          window.showToast(
            'Metric substituted: ' + result.substituted.join(', '),
            'info'
          );
        }
      }
    }, true /* capture -- runs before existing listeners */);
  }

  /* ----------------------------------------------------------------
     Inject define button into agent bar
  ---------------------------------------------------------------- */
  function injectDefineButton() {
    if (document.getElementById('dg-metric-define-btn')) return;
    var btn = buildDefineBtn();

    /* Place before the mic button if present, else at end of nl-query-wrap */
    var wrap = document.getElementById('nl-query-wrap');
    var agentBar = document.getElementById('agent-bar');
    var micBtn = document.getElementById('dg-mic-btn');

    if (micBtn && micBtn.parentNode) {
      micBtn.parentNode.insertBefore(btn, micBtn);
    } else if (wrap) {
      wrap.appendChild(btn);
    } else if (agentBar) {
      agentBar.appendChild(btn);
    }
  }

  /* ----------------------------------------------------------------
     Init
  ---------------------------------------------------------------- */
  function init() {
    if (!isEnabled()) return;

    loadMetrics().then(function () {
      /* Only inject UI when data is present (Tier 1) */
      document.addEventListener('dataglow:dataset-loaded', function () {
        injectDefineButton();
        hookNlBar();
      });

      /* Also expose globally so other modules can use MetricStudio */
      window.MetricStudio = {
        add:         addMetric,
        remove:      deleteMetric,
        update:      updateMetric,
        list:        getMetrics,
        substitute:  substituteMetrics,
        openPanel:   toggleMetricPanel
      };
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
/* ---- end js/semantic/metric-studio.js ---- */
