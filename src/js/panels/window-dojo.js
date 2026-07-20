/* DataGlow — src/js/panels/window-dojo.js */
/* Refactored from canvas/index.html */

(function () {
    'use strict';

    var FN_DEFS = {
      rank:   { label:'Rank',         needsValue:false, needsPartition:true,  needsOrder:true,  desc:'Rank each row within a partition, giving the same rank to ties.' },
      rownum: { label:'Row Number',   needsValue:false, needsPartition:false, needsOrder:true,  desc:'Assign a unique sequential number to each row based on order.' },
      runsum: { label:'Running Total',needsValue:true,  needsPartition:false, needsOrder:true,  desc:'Cumulative sum of a numeric column, growing row by row.' },
      movavg: { label:'Moving Avg',   needsValue:true,  needsPartition:false, needsOrder:true,  desc:'3-row rolling average: smooths out spikes to reveal trends.' },
      lag:    { label:'Lag',          needsValue:true,  needsPartition:false, needsOrder:true,  desc:'The previous row\'s value. Useful for period-over-period change.' },
      lead:   { label:'Lead',         needsValue:true,  needsPartition:false, needsOrder:true,  desc:'The next row\'s value. Pairs with LAG for change detection.' },
      pct:    { label:'% of Total',   needsValue:true,  needsPartition:false, needsOrder:false, desc:'Each value expressed as a percentage of the column grand total.' },
      drank:  { label:'Dense Rank',   needsValue:false, needsPartition:true,  needsOrder:true,  desc:'Like RANK but with no gaps after ties - 1,2,2,3 not 1,2,2,4.' }
    };

    var currentFn = 'rank';

    function getTableName() {
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds) return 'your_table';
      try {
        if (window.SQLEngine && typeof window.SQLEngine.safeTableName === 'function') {
          return '"' + window.SQLEngine.safeTableName(ds.name) + '"';
        }
      } catch (e) {}
      return '"' + (ds.name || 'data') + '"';
    }

    function buildSQL(fn, partition, orderby, valuecol) {
      var tbl = getTableName();
      var alias = fn + '_result';
      var over = '';

      if (fn === 'rank') {
        var parts = [];
        if (partition) parts.push('PARTITION BY ' + partition);
        if (orderby) parts.push('ORDER BY ' + orderby + ' DESC');
        over = parts.join('\n  ');
        return 'SELECT *,\n  RANK() OVER (\n  ' + over + '\n) AS ' + alias + '\nFROM ' + tbl + '\nLIMIT 100;';
      }
      if (fn === 'rownum') {
        return 'SELECT *,\n  ROW_NUMBER() OVER (\n  ORDER BY ' + (orderby||'rowid') + '\n) AS row_num\nFROM ' + tbl + '\nLIMIT 100;';
      }
      if (fn === 'runsum') {
        return 'SELECT *,\n  SUM(' + (valuecol||'value') + ') OVER (\n  ORDER BY ' + (orderby||'rowid') + '\n  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\n) AS running_total\nFROM ' + tbl + '\nLIMIT 100;';
      }
      if (fn === 'movavg') {
        return 'SELECT *,\n  AVG(' + (valuecol||'value') + ') OVER (\n  ORDER BY ' + (orderby||'rowid') + '\n  ROWS BETWEEN 2 PRECEDING AND CURRENT ROW\n) AS moving_avg_3\nFROM ' + tbl + '\nLIMIT 100;';
      }
      if (fn === 'lag') {
        return 'SELECT *,\n  LAG(' + (valuecol||'value') + ', 1) OVER (\n  ORDER BY ' + (orderby||'rowid') + '\n) AS prev_value,\n  ' + (valuecol||'value') + ' - LAG(' + (valuecol||'value') + ', 1) OVER (ORDER BY ' + (orderby||'rowid') + ') AS delta\nFROM ' + tbl + '\nLIMIT 100;';
      }
      if (fn === 'lead') {
        return 'SELECT *,\n  LEAD(' + (valuecol||'value') + ', 1) OVER (\n  ORDER BY ' + (orderby||'rowid') + '\n) AS next_value\nFROM ' + tbl + '\nLIMIT 100;';
      }
      if (fn === 'pct') {
        return 'SELECT *,\n  ROUND(\n    ' + (valuecol||'value') + ' * 100.0 / SUM(' + (valuecol||'value') + ') OVER (),\n  2) AS pct_of_total\nFROM ' + tbl + '\nLIMIT 100;';
      }
      if (fn === 'drank') {
        var dparts = [];
        if (partition) dparts.push('PARTITION BY ' + partition);
        if (orderby) dparts.push('ORDER BY ' + orderby + ' DESC');
        var dover = dparts.join('\n  ');
        return 'SELECT *,\n  DENSE_RANK() OVER (\n  ' + dover + '\n) AS dense_rank_result\nFROM ' + tbl + '\nLIMIT 100;';
      }
      return '-- Select columns above';
    }

    function updatePreview() {
      var preview = document.getElementById('dojo-preview');
      if (!preview) return;
      var partition = (document.getElementById('dojo-partition')||{}).value || '';
      var orderby   = (document.getElementById('dojo-orderby')||{}).value || '';
      var valuecol  = (document.getElementById('dojo-valuecol')||{}).value || '';
      preview.textContent = buildSQL(currentFn, partition, orderby, valuecol);
    }

    function populateDropdowns() {
      var ds = window.getActiveDataset && window.getActiveDataset();
      var allCols = ds ? ds.columns.map(function(c){return c.name;}) : [];
      var numCols = ds ? ds.columns.filter(function(c){return c.type==='FLOAT'||c.type==='INT';}).map(function(c){return c.name;}) : [];
      var catCols = ds ? ds.columns.filter(function(c){return c.type==='STR'||c.type==='DATE';}).map(function(c){return c.name;}) : [];

      function opts(cols, withNone) {
        var base = withNone ? '<option value="">(none)</option>' : '<option value="">(select)</option>';
        return base + cols.map(function(c){return '<option value="'+c+'">'+c+'</option>';}).join('');
      }

      var partEl = document.getElementById('dojo-partition');
      var ordEl = document.getElementById('dojo-orderby');
      var valEl = document.getElementById('dojo-valuecol');

      if (partEl) partEl.innerHTML = opts(catCols.concat(allCols.filter(function(c){return catCols.indexOf(c)<0;})), true);
      if (ordEl) ordEl.innerHTML = opts(allCols, false);
      if (valEl) valEl.innerHTML = opts(numCols, false);

      // Auto-select first reasonable defaults
      if (ordEl && allCols.length) ordEl.value = allCols[0];
      if (valEl && numCols.length) valEl.value = numCols[0];
      if (partEl && catCols.length) partEl.value = catCols[0];

      updatePreview();
    }

    function updateControlVisibility() {
      var def = FN_DEFS[currentFn];
      if (!def) return;
      var cgPart = document.getElementById('dojo-cg-partition');
      var cgVal  = document.getElementById('dojo-cg-value');
      var cgOrd  = document.getElementById('dojo-cg-order');
      if (cgPart) cgPart.style.display = def.needsPartition ? '' : 'none';
      if (cgVal)  cgVal.style.display  = def.needsValue     ? '' : 'none';
      if (cgOrd)  cgOrd.style.display  = def.needsOrder     ? '' : 'none';
    }

    // -- Events --------------------------------------------------------
    var dojoEditorBtn = document.getElementById('dojo-editor-btn');
    var dojoBtn       = document.getElementById('dojo-btn');
    var dojoPanel     = document.getElementById('dojo-panel');

    if (dojoBtn) dojoBtn.addEventListener('click', function() {
      dojoBtn.classList.add('active'); dojoEditorBtn && dojoEditorBtn.classList.remove('active');
      dojoPanel && dojoPanel.classList.add('open');
      populateDropdowns();
    });
    if (dojoEditorBtn) dojoEditorBtn.addEventListener('click', function() {
      dojoEditorBtn.classList.add('active'); dojoBtn && dojoBtn.classList.remove('active');
      dojoPanel && dojoPanel.classList.remove('open');
    });

    // Function card clicks
    document.querySelectorAll('#dojo-fn-grid .dojo-fn-card').forEach(function(card) {
      card.addEventListener('click', function() {
        document.querySelectorAll('#dojo-fn-grid .dojo-fn-card').forEach(function(c){c.classList.remove('active');});
        card.classList.add('active');
        currentFn = card.dataset.fn;
        var def = FN_DEFS[currentFn];
        var descEl = document.getElementById('dojo-fn-desc');
        if (descEl && def) descEl.textContent = def.desc;
        updateControlVisibility();
        updatePreview();
      });
    });

    // Dropdown changes
    ['dojo-partition','dojo-orderby','dojo-valuecol'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', updatePreview);
    });

    // Run button - copy SQL into editor and run
    var runBtn = document.getElementById('dojo-run-btn');
    if (runBtn) runBtn.addEventListener('click', function() {
      var preview = document.getElementById('dojo-preview');
      if (!preview) return;
      var sql = preview.textContent;

      // Find the SQL editor textarea and set its value
      var sqlEditor = document.getElementById('sql-view-input');
      if (sqlEditor) {
        sqlEditor.value = sql;
        sqlEditor.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Switch to editor view
      dojoEditorBtn && dojoEditorBtn.click();

      // Click the Run SQL button after a short delay
      setTimeout(function() {
        var runSqlBtn = document.getElementById('sql-view-run');
        if (runSqlBtn) runSqlBtn.click();
        else window.showToast && window.showToast('SQL copied to editor - click Run to execute.', 'info');
      }, 100);
    });

    // Auto-populate when dataset loads
    document.addEventListener('dataglow:dataset-loaded', function() {
      if (dojoPanel && dojoPanel.classList.contains('open')) populateDropdowns();
    });

    updateControlVisibility();
