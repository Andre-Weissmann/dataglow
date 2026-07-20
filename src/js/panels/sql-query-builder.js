/* DataGlow — src/js/panels/sql-query-builder.js */
/* Refactored from canvas/index.html */

(function () {
    'use strict';

    var panel   = document.getElementById('sql-qb-panel');
    var tableEl = document.getElementById('qb-table');
    var colsEl  = document.getElementById('qb-columns');
    var filtsEl = document.getElementById('qb-filters');
    var groupEl = document.getElementById('qb-groupby');
    var orderEl = document.getElementById('qb-orderby');
    var dirEl   = document.getElementById('qb-order-dir');
    var limitEl = document.getElementById('qb-limit');
    var applyBtn = document.getElementById('qb-apply-btn');
    var closeBtn = document.getElementById('qb-close-btn');
    var toggleBtn = document.getElementById('sql-qb-toggle-btn');
    var sqlViewInput = document.getElementById('sql-view-input');

    if (!panel || !toggleBtn) return;

    var _selectedCols = [];

    function openQB() {
      panel.classList.add('open');
      populateQB();
    }

    function closeQB() {
      panel.classList.remove('open');
    }

    function populateQB() {
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds) {
        window.showToast && window.showToast('Load a dataset first to use the Query Builder.', 'warn');
        closeQB();
        return;
      }

      // Table
      tableEl.innerHTML = '<option value="' + ds.name + '">' + ds.name + '</option>';

      // Columns
      _selectedCols = ds.columns.map(function (c) { return c.name; });
      colsEl.innerHTML = '';
      ds.columns.forEach(function (col) {
        var chip = document.createElement('div');
        chip.className = 'qb-col-chip selected';
        chip.dataset.col = col.name;
        chip.innerHTML = '<span>' + col.name + '</span><span style="opacity:0.6;font-size:10px;">' + col.type + '</span>';
        chip.addEventListener('click', function () {
          var idx = _selectedCols.indexOf(col.name);
          if (idx === -1) { _selectedCols.push(col.name); chip.classList.add('selected'); }
          else { _selectedCols.splice(idx, 1); chip.classList.remove('selected'); }
        });
        colsEl.appendChild(chip);
      });

      // Filters - populate column dropdowns
      var filterColSelects = filtsEl.querySelectorAll('.qb-fcol');
      filterColSelects.forEach(function (sel) {
        var cur = sel.value;
        sel.innerHTML = '<option value="">-- column --</option>';
        ds.columns.forEach(function (col) {
          sel.innerHTML += '<option value="' + col.name + '"' + (cur === col.name ? ' selected' : '') + '>' + col.name + '</option>';
        });
      });

      // Hide value input for NULL ops
      filtsEl.querySelectorAll('.qb-filter-row').forEach(function (row) {
        var op = row.querySelector('.qb-op');
        var val = row.querySelector('.qb-val');
        if (!op || !val) return;
        function updateVal() {
          val.style.display = (op.value === 'IS NULL' || op.value === 'IS NOT NULL') ? 'none' : '';
        }
        op.addEventListener('change', updateVal);
        updateVal();
      });

      // Group By / Order By
      var noOpt = '<option value="">None</option>';
      var colOpts = ds.columns.map(function (c) { return '<option value="' + c.name + '">' + c.name + '</option>'; }).join('');
      groupEl.innerHTML = noOpt + colOpts;
      orderEl.innerHTML = noOpt + colOpts;
    }

    function buildSQL() {
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds) return '';

      var cols = _selectedCols.length > 0 ? _selectedCols.map(function (c) { return '"' + c + '"'; }).join(', ') : '*';
      var tableName = ds.name.replace(/\.[^.]+$/, '');
      var sql = 'SELECT ' + cols + '\nFROM ' + tableName;

      // WHERE
      var conditions = [];
      filtsEl.querySelectorAll('.qb-filter-row').forEach(function (row) {
        var col = row.querySelector('.qb-fcol').value;
        var op  = row.querySelector('.qb-op').value;
        var val = row.querySelector('.qb-val').value.trim();
        if (!col) return;
        if (op === 'IS NULL' || op === 'IS NOT NULL') {
          conditions.push('"' + col + '" ' + op);
        } else if (val !== '') {
          var quoted = (op === 'LIKE' || isNaN(Number(val))) ? "'" + val.replace(/'/g, "''") + "'" : val;
          conditions.push('"' + col + '" ' + op + ' ' + quoted);
        }
      });
      if (conditions.length > 0) sql += '\nWHERE ' + conditions.join('\n  AND ');

      // GROUP BY
      if (groupEl.value) sql += '\nGROUP BY "' + groupEl.value + '"';

      // ORDER BY
      if (orderEl.value) sql += '\nORDER BY "' + orderEl.value + '" ' + (dirEl.value || 'DESC');

      // LIMIT
      var lim = parseInt(limitEl.value, 10);
      if (!isNaN(lim) && lim > 0) sql += '\nLIMIT ' + lim;

      return sql;
    }

    toggleBtn.addEventListener('click', function () {
      if (panel.classList.contains('open')) { closeQB(); } else { openQB(); }
    });

    if (closeBtn) closeBtn.addEventListener('click', closeQB);

    if (applyBtn) applyBtn.addEventListener('click', function () {
      var sql = buildSQL();
      if (!sql) return;
      if (sqlViewInput) {
        sqlViewInput.value = sql;
        sqlViewInput.focus();
      }
      closeQB();
      window.showToast && window.showToast('SQL generated - press Run to execute.', 'success');
    });

    // Refresh on dataset load
    document.addEventListener('dataglow:dataset-loaded', function () {
      if (panel.classList.contains('open')) populateQB();
    });
