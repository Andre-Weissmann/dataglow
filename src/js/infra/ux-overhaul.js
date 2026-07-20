/* DataGlow — src/js/infra/ux-overhaul.js */
/* Refactored from canvas/index.html */

(function () {
    'use strict';

    // ── Spotlight ──────────────────────────────────────────────────────────────
    function gotoAnalyzePanel(panelId) {
      // Switch top nav to Analyze
      document.querySelectorAll('.nav-btn').forEach(function(b){ b.classList.remove('active'); });
      var ab = document.querySelector('[data-view="analyze"]');
      if (ab) ab.classList.add('active');
      document.querySelectorAll('.view').forEach(function(v){
        v.classList.add('hidden'); v.classList.remove('active');
      });
      var av = document.getElementById('analyze-view');
      if (av) { av.classList.remove('hidden'); av.classList.add('active'); }
      // Activate panel
      document.querySelectorAll('.analyze-panel').forEach(function(p){
        p.classList.remove('active'); p.classList.add('hidden'); p.style.display = '';
      });
      document.querySelectorAll('.analyze-pill').forEach(function(p){ p.classList.remove('active'); });
      var panel = document.getElementById(panelId);
      if (panel) { panel.classList.remove('hidden'); panel.classList.add('active'); panel.style.display = ''; }
      var pill = document.querySelector('[data-panel="' + panelId + '"]');
      if (pill) pill.classList.add('active');
      // Trigger renders
      var ds = typeof getActiveDataset === 'function' ? getActiveDataset() : null;
      if (panelId === 'charts-view' && typeof ChartEngine !== 'undefined' && ds) {
        var cg = document.getElementById('chart-grid');
        if (cg) ChartEngine.renderAll(ds, cg);
      }
      if (panelId === 'dashboard-view' && typeof DashboardEngine !== 'undefined' && ds) {
        var dv = document.getElementById('dashboard-view-inner');
        if (dv) DashboardEngine.render(ds, dv);
      }
      if (panelId === 'stats-view') {
        setTimeout(function() {
          var btn = document.querySelector('#stats-seg .stats-seg-btn.active') ||
                    document.querySelector('#stats-seg .stats-seg-btn');
          if (btn) btn.click();
        }, 60);
      }
      if (panelId === 'sql-view' && typeof window._svRefresh === 'function') window._svRefresh();
    }

    function showSpotlight(dataset, filename) {
      var overlay = document.getElementById('action-spotlight');
      if (!overlay) return;
      var headline = document.getElementById('spotlight-headline');
      var nameBadge = document.getElementById('spotlight-name');
      var rows = dataset && dataset.rows ? dataset.rows.length : 0;
      var cols = dataset && dataset.columns ? dataset.columns.length : 0;
      var name = filename || (dataset && dataset.name) || 'Dataset';
      if (headline) headline.textContent = rows.toLocaleString() + ' rows. ' + cols + ' columns. Ready.';
      if (nameBadge) nameBadge.textContent = name;
      overlay.classList.add('visible');
    }

    function hideSpotlight() {
      var overlay = document.getElementById('action-spotlight');
      if (overlay) overlay.classList.remove('visible');
    }

    // Wire action buttons
    document.querySelectorAll('.spotlight-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        hideSpotlight();
        var target = btn.dataset.goto;
        if (target) gotoAnalyzePanel(target);
      });
    });

    // Skip button + click-outside
    var skipBtn = document.getElementById('spotlight-skip');
    if (skipBtn) skipBtn.addEventListener('click', hideSpotlight);
    var overlay = document.getElementById('action-spotlight');
    if (overlay) overlay.addEventListener('click', function(e) {
      if (e.target === overlay) hideSpotlight();
    });

    // Expose
    window._dgSpotlight = showSpotlight;

    // ── NL bar pulse on load ────────────────────────────────────────────────────
    document.addEventListener('dataglow:dataset-loaded', function() {
      var nl = document.getElementById('nl-query-input');
      if (!nl) return;
      nl.classList.remove('nl-pulse');
      void nl.offsetWidth; // reflow to restart animation
      nl.classList.add('nl-pulse');
      setTimeout(function(){ nl.classList.remove('nl-pulse'); }, 2600);
    });

    // ── Chart empty state ───────────────────────────────────────────────────────
    var chartGrid = document.getElementById('chart-grid');
    function checkChartEmpty() {
      if (!chartGrid) return;
      var realChildren = Array.from(chartGrid.children).filter(function(c){
        return !c.classList.contains('dg-empty');
      });
      if (realChildren.length === 0 && !chartGrid.querySelector('.dg-empty')) {
        chartGrid.innerHTML = '<div class="dg-empty">' +
          '<div class="dg-empty-icon">&#x1F4CA;</div>' +
          '<div class="dg-empty-title">No data loaded yet</div>' +
          '<div class="dg-empty-sub">Drop a CSV, Excel, or JSON file to auto-generate charts.</div>' +
          '<button class="dg-empty-btn" id="dg-empty-chart-btn">Go to Data tab</button>' +
          '</div>';
      } else if (realChildren.length > 0) {
        var emp = chartGrid.querySelector('.dg-empty');
        if (emp) emp.remove();
      }
    }
    if (chartGrid) {
      var mo = new MutationObserver(checkChartEmpty);
      mo.observe(chartGrid, { childList: true });
      checkChartEmpty();
    }
    // Wire the empty state button (event delegation since it's dynamically injected)
    if (chartGrid) {
      chartGrid.addEventListener('click', function(e) {
        if (e.target && e.target.id === 'dg-empty-chart-btn') {
          var dataBtn = document.querySelector('[data-view="data"]');
          if (dataBtn) dataBtn.click();
        }
      });
    }

    // ── Stats empty state on panel show ────────────────────────────────────────
    document.addEventListener('dataglow:dataset-loaded', function() {
      // Populate stats dropdowns when data arrives
      var ds = typeof getActiveDataset === 'function' ? getActiveDataset() : null;
      if (!ds) return;
      var numCols = ds.columns.filter(function(c){ return c.type === 'INT' || c.type === 'FLOAT'; });
      ['stats-reg-x','stats-reg-y','stats-hyp-col','stats-chi-a','stats-chi-b'].forEach(function(id) {
        var sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = '<option value="">-- select --</option>';
        numCols.forEach(function(c) {
          var opt = document.createElement('option');
          opt.value = c.name; opt.textContent = c.name;
          sel.appendChild(opt);
        });
      });
    });
