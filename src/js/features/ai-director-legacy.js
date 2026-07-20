/* DataGlow — js/features/ai-director-legacy.js */
/* Part of structured refactor — see src/ directory */

(function () {
    'use strict';

    var CHART_TYPES = [
      { id:'bar', label:'Bar' },
      { id:'line', label:'Line' },
      { id:'scatter', label:'Scatter' },
      { id:'histogram', label:'Distribution' },
      { id:'hbar', label:'Horiz. Bar' }
    ];

    function analyzeDataset(ds) {
      if (!ds || !ds.columns || !ds.rows) return null;
      var cols = ds.columns;
      var rows = ds.rows;
      var n = rows.length;

      var numCols = cols.filter(function(c){return c.type==='FLOAT'||c.type==='INT';});
      var dateCols = cols.filter(function(c){return c.type==='DATE';});
      var catCols  = cols.filter(function(c){return c.type==='STR'||c.type==='BOOL';});

      // Count unique values for each cat column
      function uniq(col) {
        var i=cols.indexOf(col), seen={};
        rows.forEach(function(r){seen[String(r[i])]=1;});
        return Object.keys(seen).length;
      }

      var pick = null;
      var reason = '';
      var fullReason = '';
      var alternatives = [];

      if (dateCols.length >= 1 && numCols.length >= 1) {
        pick = 'line';
        reason = 'Time series detected: your data has a date/time dimension. Tracking change over time reveals trends invisible in snapshots.';
        fullReason = 'Your dataset contains a DATE column ('+dateCols[0].name+') and '+numCols.length+' numeric column(s). A line chart plots each date on the x-axis and the numeric measure on the y-axis, making it easy to see growth, seasonality, or drops over time. Alternatives like bar charts would hide the temporal ordering.';
        alternatives = ['bar', 'histogram'];
      } else if (numCols.length >= 2 && n >= 30) {
        pick = 'scatter';
        reason = 'Two numeric variables with enough data points - ideal for exploring correlation and clusters.';
        fullReason = 'With '+numCols.length+' numeric columns and '+n+' rows, scatter plots reveal whether '+numCols[0].name+' and '+numCols[1].name+' move together, diverge, or cluster. This is the most honest first view of a two-variable numeric relationship.';
        alternatives = ['bar', 'line'];
      } else if (catCols.length >= 1 && numCols.length >= 1) {
        var u = uniq(catCols[0]);
        if (u <= 8) {
          pick = 'bar';
          reason = 'Category comparison: '+catCols[0].name+' has '+u+' unique values - a bar chart communicates differences at a glance.';
          fullReason = 'Bar charts are optimal when you have a categorical grouping ('+catCols[0].name+') with '+u+' levels and a numeric measure to compare. Fewer than ~10 categories keeps the chart scannable. Each bar length encodes the value with no ambiguity.';
          alternatives = ['hbar', 'line', 'scatter'];
        } else {
          pick = 'hbar';
          reason = 'Ranking view: '+catCols[0].name+' has '+u+' unique values - horizontal bars keep long labels readable.';
          fullReason = 'When a categorical column has many distinct values (here: '+u+'), vertical bars crush the labels together. A horizontal layout gives each category label room to breathe, and the rank order (longest to shortest) is immediately scannable.';
          alternatives = ['bar', 'scatter'];
        }
      } else if (numCols.length === 1) {
        pick = 'histogram';
        reason = 'Distribution analysis: one numeric column - understanding its spread is the first question to ask.';
        fullReason = 'With a single numeric column ('+numCols[0].name+'), the first question is: what is the shape of this distribution? Is it normal, skewed, bimodal? A histogram bins the values and shows frequency, revealing outliers and the center of mass immediately.';
        alternatives = ['bar'];
      } else {
        pick = 'bar';
        reason = 'General overview: bar charts are the most universally readable starting point for mixed data.';
        fullReason = 'No single strong signal (date+numeric, two numerics, or cat+numeric) was found. A bar chart provides a reliable, widely understood view of your data as a starting point for exploration.';
        alternatives = ['line', 'histogram'];
      }

      return {
        pick: pick,
        reason: reason,
        fullReason: fullReason,
        alternatives: alternatives,
        stats: { rows: n, numCols: numCols.length, catCols: catCols.length, dateCols: dateCols.length }
      };
    }

    function buildBanner(analysis) {
      if (!analysis) return;
      var chartView = document.getElementById('charts-view');
      if (!chartView) return;

      // Remove old banner if present
      var old = chartView.querySelector('.ai-director-banner');
      if (old) old.remove();

      var pickLabel = (CHART_TYPES.find(function(t){return t.id===analysis.pick;})||{label:analysis.pick}).label;
      var altBtns = ['bar','line','scatter','histogram','hbar'].map(function(id){
        var lbl = (CHART_TYPES.find(function(t){return t.id===id;})||{label:id}).label;
        var isAlt = analysis.alternatives.indexOf(id) >= 0 || id === analysis.pick;
        if (!isAlt) return '';
        return '<button class="ai-director-type-btn'+(id===analysis.pick?' active':'')+'" data-chart-type="'+id+'">'+lbl+'</button>';
      }).join('');

      var statsHtml = '<span class="ai-director-stat">'+analysis.stats.rows+' rows</span>'+
        (analysis.stats.numCols?'<span class="ai-director-stat">'+analysis.stats.numCols+' numeric</span>':'')+
        (analysis.stats.catCols?'<span class="ai-director-stat">'+analysis.stats.catCols+' categorical</span>':'')+
        (analysis.stats.dateCols?'<span class="ai-director-stat">'+analysis.stats.dateCols+' date</span>':'');

      var banner = document.createElement('div');
      banner.className = 'ai-director-banner';
      banner.innerHTML =
        '<div class="ai-director-label">AI Director</div>'+
        '<div class="ai-director-pick">Recommended: '+pickLabel+'</div>'+
        '<div class="ai-director-reason">'+escH(analysis.reason)+'</div>'+
        '<div class="ai-director-row">'+altBtns+'<button class="ai-director-why-btn">Why this chart? +</button></div>'+
        '<div class="ai-director-expand"><strong>Full reasoning:</strong><br>'+escH(analysis.fullReason)+'<br><br>'+statsHtml+'</div>';

      // Insert as first child of charts-view
      chartView.insertBefore(banner, chartView.firstChild);

      // Why expand toggle
      var whyBtn = banner.querySelector('.ai-director-why-btn');
      var expand = banner.querySelector('.ai-director-expand');
      if (whyBtn && expand) {
        whyBtn.addEventListener('click', function() {
          expand.classList.toggle('open');
          whyBtn.textContent = expand.classList.contains('open') ? 'Why this chart? -' : 'Why this chart? +';
        });
      }

      // Type switch buttons
      banner.querySelectorAll('.ai-director-type-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          banner.querySelectorAll('.ai-director-type-btn').forEach(function(b){b.classList.remove('active');});
          btn.classList.add('active');
          var newPick = banner.querySelector('.ai-director-pick');
          var t = CHART_TYPES.find(function(x){return x.id===btn.dataset.chartType;});
          if (newPick && t) newPick.textContent = 'Recommended: '+t.label+' (manual override)';
          window.showToast && window.showToast('Chart type overridden to '+btn.textContent, 'info');
        });
      });
    }

    function escH(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Hook into dataset load event
    document.addEventListener('dataglow:dataset-loaded', function (e) {
      var ds = e.detail && e.detail.dataset;
      if (!ds) ds = window.getActiveDataset && window.getActiveDataset();
      setTimeout(function() {
        var a = analyzeDataset(window.getActiveDataset && window.getActiveDataset());
        if (a) buildBanner(a);
      }, 200);
    });

    // Also fire when charts tab is clicked
    var chartsPill = document.querySelector('[data-panel="charts-view"]');
    if (chartsPill) chartsPill.addEventListener('click', function() {
      setTimeout(function() {
        var a = analyzeDataset(window.getActiveDataset && window.getActiveDataset());
        if (a) buildBanner(a);
      }, 100);
    });
