/* DataGlow — src/js/panels/arena.js */
/* Refactored from canvas/index.html */

(function () {
    'use strict';

    var resultsA = null; // {cols, rows}
    var resultsB = null;

    function getTableName() {
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds) return 'your_table';
      if (window.SQLEngine && window.SQLEngine.safeTableName) return window.SQLEngine.safeTableName(ds.name);
      return (ds.name || 'data').replace(/[^a-zA-Z0-9_]/g,'_');
    }

    function renderTable(data, container, statusEl) {
      if (!data || !data.cols || !data.rows) {
        container.innerHTML = '<div class="arena-empty">No results</div>';
        return;
      }
      var rowCount = data.rows.length;
      if (statusEl) statusEl.textContent = rowCount + ' row' + (rowCount !== 1 ? 's' : '');
      var thead = '<tr>' + data.cols.map(function(c){ return '<th>' + c + '</th>'; }).join('') + '</tr>';
      var tbody = data.rows.slice(0,200).map(function(r){
        return '<tr>' + data.cols.map(function(c,i){ return '<td>' + (r[i] === null || r[i] === undefined ? '' : String(r[i]).substring(0,60)) + '</td>'; }).join('') + '</tr>';
      }).join('');
      container.innerHTML = '<table class="arena-result-table"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>';
    }

    function buildDiff() {
      var diffEl = document.getElementById('arena-diff');
      if (!diffEl) return;
      if (!resultsA || !resultsB) { diffEl.textContent = 'Run both queries to see a comparison.'; return; }
      var parts = [];

      // Row count
      var ra = resultsA.rows.length, rb = resultsB.rows.length;
      if (ra === rb) parts.push('<strong>' + ra + ' rows</strong> in both');
      else parts.push('<strong>A: ' + ra + ' rows</strong>, <strong>B: ' + rb + ' rows</strong> (' + (ra > rb ? 'A has ' + (ra-rb) + ' more' : 'B has ' + (rb-ra) + ' more') + ')');

      // Columns
      var ca = resultsA.cols, cb = resultsB.cols;
      if (ca.join(',') === cb.join(',')) {
        parts.push('same ' + ca.length + ' columns');
      } else {
        var onlyA = ca.filter(function(c){ return cb.indexOf(c) < 0; });
        var onlyB = cb.filter(function(c){ return ca.indexOf(c) < 0; });
        if (onlyA.length) parts.push('A only: ' + onlyA.join(', '));
        if (onlyB.length) parts.push('B only: ' + onlyB.join(', '));
      }

      // First shared column value overlap
      var shared = ca.filter(function(c){ return cb.indexOf(c) >= 0; });
      if (shared.length && ra > 0 && rb > 0) {
        var col = shared[0];
        var aVals = resultsA.rows.slice(0,20).map(function(r){ return String(r[ca.indexOf(col)]); });
        var bVals = resultsB.rows.slice(0,20).map(function(r){ return String(r[cb.indexOf(col)]); });
        var aSet = {}; aVals.forEach(function(v){ aSet[v]=1; });
        var bSet = {}; bVals.forEach(function(v){ bSet[v]=1; });
        var overlap = aVals.filter(function(v){ return bSet[v]; }).length;
        var pct = Math.round(overlap / Math.max(aVals.length, bVals.length) * 100);
        parts.push(col + ': ' + pct + '% value overlap (first 20 rows)');
      }

      diffEl.innerHTML = parts.join(' \u00b7 ');
    }

    function runQuery(sql, resultsEl, statusEl, label, callback) {
      if (!sql.trim()) { resultsEl.innerHTML = '<div class="arena-empty">Enter a query above</div>'; return; }
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds) { resultsEl.innerHTML = '<div class="arena-empty">Load a dataset first</div>'; return; }
      if (statusEl) statusEl.textContent = 'Running...';

      // Replace placeholder table name
      var tbl = getTableName();
      var resolvedSql = sql.replace(/your_table/g, tbl);

      if (window.SQLEngine && window.SQLEngine.query) {
        window.SQLEngine.query(resolvedSql, ds).then(function(result) {
          var data = { cols: result.cols || result.columns || [], rows: result.rows || [] };
          renderTable(data, resultsEl, statusEl);
          callback(data);
          buildDiff();
        }).catch(function(err) {
          resultsEl.innerHTML = '<div class="arena-empty" style="color:var(--error);">Error: ' + String(err).substring(0,120) + '</div>';
          if (statusEl) statusEl.textContent = 'Error';
          callback(null);
        });
      } else {
        // Fallback: show all rows
        var cols = ds.columns.map(function(c){ return c.name; });
        var data = { cols: cols, rows: ds.rows.slice(0, 100) };
        renderTable(data, resultsEl, statusEl);
        callback(data);
        buildDiff();
      }
    }

    function wireUp() {
      var editorA = document.getElementById('arena-editor-a');
      var editorB = document.getElementById('arena-editor-b');
      var resultsElA = document.getElementById('arena-results-a');
      var resultsElB = document.getElementById('arena-results-b');
      var statusA = document.getElementById('arena-status-a');
      var statusB = document.getElementById('arena-status-b');
      var runABtn = document.getElementById('arena-run-a');
      var runBBtn = document.getElementById('arena-run-b');
      var runBothBtn = document.getElementById('arena-run-both');

      if (!editorA || !editorB) return;

      // Auto-fill table name when dataset loads
      document.addEventListener('dataglow:dataset-loaded', function() {
        var tbl = getTableName();
        editorA.value = 'SELECT * FROM ' + tbl + ' LIMIT 10';
        editorB.value = 'SELECT * FROM ' + tbl + ' LIMIT 10';
      });

      if (runABtn) runABtn.addEventListener('click', function() {
        runQuery(editorA.value, resultsElA, statusA, 'A', function(d) { resultsA = d; });
      });
      if (runBBtn) runBBtn.addEventListener('click', function() {
        runQuery(editorB.value, resultsElB, statusB, 'B', function(d) { resultsB = d; });
      });
      if (runBothBtn) runBothBtn.addEventListener('click', function() {
        runQuery(editorA.value, resultsElA, statusA, 'A', function(d) { resultsA = d; buildDiff(); });
        runQuery(editorB.value, resultsElB, statusB, 'B', function(d) { resultsB = d; buildDiff(); });
      });

      // Ctrl+Enter to run in focused editor
      [editorA, editorB].forEach(function(ed, idx) {
        ed.addEventListener('keydown', function(e) {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (idx === 0) runABtn && runABtn.click();
            else runBBtn && runBBtn.click();
          }
        });
      });
    }

    // Wire up immediately and on Arena pill click
    wireUp();
    var arenaPill = document.querySelector('[data-panel="arena-view"]');
    if (arenaPill) arenaPill.addEventListener('click', function() {
      var tbl = getTableName();
      var ea = document.getElementById('arena-editor-a');
      var eb = document.getElementById('arena-editor-b');
      if (ea && ea.value.indexOf('your_table') >= 0) ea.value = 'SELECT * FROM ' + tbl + ' LIMIT 10';
      if (eb && eb.value.indexOf('your_table') >= 0) eb.value = 'SELECT * FROM ' + tbl + ' LIMIT 10';
    });
