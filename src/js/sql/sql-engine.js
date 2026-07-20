/* DataGlow — js/sql/sql-engine.js */
/* Part of structured refactor — see src/ directory */

/**
 * sql-engine.js — DataGlow Real SQL Engine (PR AO)
 *
 * Powers the SQL Mode overlay with real DuckDB-WASM execution,
 * smart autocomplete, query history, schema sidebar, and explain output.
 *
 * Public API:
 *   SQLEngine.init(containerEl, getDatasets, opts) → instance
 *   instance.loadDataset(dataset)   — registers dataset as DuckDB table
 *   instance.runQuery(sql)          → Promise<{columns, rows, durationMs}>
 *   instance.destroy()
 *
 * Smart features:
 *   - Schema panel: table name, column names + types at a glance
 *   - Autocomplete: column names, table name, SQL keywords, functions
 *   - Query history (last 20, navigable with ↑↓)
 *   - EXPLAIN plan toggle
 *   - Error messages translated to plain English
 *   - "Export results as CSV" after any query
 *   - AI suggestions: if query returns 0 rows, suggest a fix
 *   - Multi-dataset: each loaded file becomes its own table
 */

var SQLEngine = (function () {
  'use strict';

  // DuckDB-WASM CDN (ESM bundle  -  loads via dynamic import in init)
  var DUCKDB_CDN = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-esm.js';

  var SQL_KEYWORDS = [
    'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
    'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'ON',
    'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL',
    'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
    'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT',
    'WITH', 'CTE', 'PARTITION BY', 'OVER', 'ROW_NUMBER', 'RANK', 'DENSE_RANK',
    'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
    'CAST', 'TRY_CAST', 'COALESCE', 'NULLIF', 'IFF',
    'STRFTIME', 'DATE_TRUNC', 'DATE_DIFF', 'NOW', 'CURRENT_DATE',
    'ROUND', 'FLOOR', 'CEIL', 'ABS', 'MOD',
    'LOWER', 'UPPER', 'TRIM', 'LENGTH', 'SUBSTRING', 'REPLACE', 'CONCAT',
    'ARRAY_AGG', 'STRING_AGG', 'LIST_AGG',
    'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST',
    'CREATE', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER',
    'TRUE', 'FALSE', 'NULL'
  ];

  // Friendly error translations
  var ERROR_TRANSLATIONS = [
    { pattern: /Table.*not found|No table.*named/i, msg: 'Table not found. Check the table name in the Schema panel on the left.' },
    { pattern: /Column.*not found|No column.*named/i, msg: 'Column not found. Check the column names in the Schema panel.' },
    { pattern: /Syntax error/i, msg: 'SQL syntax error. Check for missing commas, unclosed parentheses, or misspelled keywords.' },
    { pattern: /division by zero/i, msg: 'Division by zero detected. Add a WHERE or NULLIF guard around your denominator.' },
    { pattern: /conversion.*failed|cannot cast/i, msg: 'Type conversion failed. A column may contain text where a number is expected.' },
    { pattern: /ambiguous.*column/i, msg: 'Ambiguous column name. Prefix it with the table name: `tablename.columnname`.' }
  ];

  function translateError(msg) {
    for (var i = 0; i < ERROR_TRANSLATIONS.length; i++) {
      if (ERROR_TRANSLATIONS[i].pattern.test(msg)) return ERROR_TRANSLATIONS[i].msg;
    }
    return msg;
  }

  // Smart query suggestions when 0 rows returned
  function zeroRowsSuggestion(sql, dataset) {
    var suggestions = [];
    if (/WHERE/i.test(sql)) {
      suggestions.push('Your WHERE clause may be too restrictive. Try removing it temporarily to see if rows exist.');
    }
    if (/LIMIT\s+0/i.test(sql)) {
      suggestions.push('LIMIT 0 returns no rows by design. Increase your LIMIT value.');
    }
    if (dataset && dataset.rows && dataset.rows.length > 0) {
      suggestions.push('The table has ' + dataset.rows.length.toLocaleString() + ' rows  -  try SELECT * FROM "' + safeTableName(dataset.name) + '" LIMIT 5 to verify access.');
    }
    return suggestions.length ? suggestions[0] : null;
  }

  function safeTableName(filename) {
    return (filename || 'dataset').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_');
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── DuckDB-WASM wrapper ────────────────────────────────────────────────────
  function createDuckDBAdapter() {
    var db = null, conn = null, initialised = false, registeredTables = {};

    async function ensureInit() {
      if (initialised) return;
      initialised = true;
      try {
        // Dynamic import of DuckDB-WASM ESM bundle
        var mod = await import(DUCKDB_CDN);
        var JSDELIVR_BUNDLES = mod.getJsDelivrBundles ? mod.getJsDelivrBundles() : mod.selectBundle ? mod.selectBundle(mod.getJsDelivrBundles()) : null;
        var bundle = JSDELIVR_BUNDLES || {
          mainModule: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-eh.wasm',
          mainWorker: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-browser-eh.worker.js'
        };
        if (mod.selectBundle) bundle = mod.selectBundle(mod.getJsDelivrBundles());
        var worker = new Worker(bundle.mainWorker);
        var logger = new mod.ConsoleLogger ? new mod.ConsoleLogger() : { log: function(){} };
        db = new mod.AsyncDuckDB(logger, worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        conn = await db.connect();
      } catch (e) {
        db = null; conn = null; initialised = false;
        throw new Error('DuckDB-WASM failed to load: ' + e.message);
      }
    }

    async function registerDataset(dataset) {
      await ensureInit();
      var tbl = safeTableName(dataset.name);
      if (registeredTables[tbl]) return tbl; // already registered

      // Build CSV string from dataset rows
      var cols = dataset.columns.map(function (c) { return c.name; });
      var lines = [cols.map(function (c) { return JSON.stringify(String(c)); }).join(',')];
      dataset.rows.forEach(function (row) {
        lines.push(cols.map(function (c) {
          var v = row[c];
          if (v === null || v === undefined) return '';
          return JSON.stringify(String(v));
        }).join(','));
      });
      var csv = lines.join('\n');

      // Register as in-memory CSV
      var encoder = new TextEncoder();
      var bytes = encoder.encode(csv);
      var fname = tbl + '.csv';
      await db.registerFileBuffer(fname, bytes);
      await conn.query("CREATE OR REPLACE TABLE \"" + tbl + "\" AS SELECT * FROM read_csv_auto('" + fname + "', header=true)");
      registeredTables[tbl] = true;
      return tbl;
    }

    async function query(sql, datasets) {
      await ensureInit();
      // Register all datasets
      for (var i = 0; i < datasets.length; i++) {
        await registerDataset(datasets[i]);
      }
      var t0 = Date.now();
      var result = await conn.query(sql);
      var durationMs = Date.now() - t0;

      var schema = result.schema.fields;
      var columns = schema.map(function (f) { return { name: f.name, type: String(f.type) }; });
      var rows = result.toArray().map(function (r) {
        return r.toJSON ? r.toJSON() : Object.fromEntries(columns.map(function (c) { return [c.name, r[c.name]]; }));
      });
      return { columns: columns, rows: rows, durationMs: durationMs };
    }

    return { query: query, registerDataset: registerDataset };
  }

  // ── Autocomplete ──────────────────────────────────────────────────────────
  function buildAutocomplete(textarea, getSchemaTokens) {
    var dropEl = document.createElement('div');
    dropEl.className = 'sql-autocomplete';
    dropEl.style.display = 'none';
    textarea.parentNode.style.position = 'relative';
    textarea.parentNode.appendChild(dropEl);

    var items = [], activeIdx = -1;

    function getWordBefore() {
      var pos = textarea.selectionStart;
      var text = textarea.value.slice(0, pos);
      var m = /[\w"]+$/.exec(text);
      return m ? m[0] : '';
    }

    function show(matches) {
      items = matches;
      activeIdx = -1;
      if (!matches.length) { dropEl.style.display = 'none'; return; }
      dropEl.innerHTML = matches.slice(0, 8).map(function (m, i) {
        return '<div class="sql-ac-item" data-idx="' + i + '">' + escHtml(m.text) +
          (m.detail ? '<span class="sql-ac-detail">' + escHtml(m.detail) + '</span>' : '') + '</div>';
      }).join('');
      dropEl.style.display = 'block';
      dropEl.querySelectorAll('.sql-ac-item').forEach(function (el) {
        el.addEventListener('mousedown', function (e) {
          e.preventDefault();
          applyCompletion(items[+el.dataset.idx].text);
        });
      });
    }

    function hide() { dropEl.style.display = 'none'; items = []; activeIdx = -1; }

    function applyCompletion(text) {
      var pos = textarea.selectionStart;
      var before = textarea.value.slice(0, pos);
      var after = textarea.value.slice(pos);
      var m = /[\w"]+$/.exec(before);
      var start = m ? pos - m[0].length : pos;
      textarea.value = before.slice(0, start) + text + after;
      textarea.selectionStart = textarea.selectionEnd = start + text.length;
      hide();
      textarea.focus();
    }

    textarea.addEventListener('input', function () {
      var word = getWordBefore();
      if (word.length < 1) { hide(); return; }
      var tokens = getSchemaTokens();
      var all = SQL_KEYWORDS.map(function (k) { return { text: k, detail: 'keyword' }; })
        .concat(tokens.map(function (t) { return { text: t.text, detail: t.detail }; }));
      var lc = word.toLowerCase();
      var matches = all.filter(function (t) { return t.text.toLowerCase().startsWith(lc) && t.text.toLowerCase() !== lc; });
      show(matches);
    });

    textarea.addEventListener('keydown', function (e) {
      if (dropEl.style.display === 'none') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, Math.min(items.length, 8) - 1);
        dropEl.querySelectorAll('.sql-ac-item').forEach(function (el, i) { el.classList.toggle('active', i === activeIdx); });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        dropEl.querySelectorAll('.sql-ac-item').forEach(function (el, i) { el.classList.toggle('active', i === activeIdx); });
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (activeIdx >= 0 && items[activeIdx]) { e.preventDefault(); applyCompletion(items[activeIdx].text); }
        else hide();
      } else if (e.key === 'Escape') {
        hide();
      }
    });

    document.addEventListener('click', function (e) { if (!dropEl.contains(e.target) && e.target !== textarea) hide(); });
  }

  // ── Query history ─────────────────────────────────────────────────────────
  function createHistory() {
    var items = [], idx = -1;
    return {
      push: function (sql) { items.unshift(sql); if (items.length > 20) items.pop(); idx = -1; },
      prev: function () { if (idx < items.length - 1) idx++; return items[idx] || null; },
      next: function () { if (idx > 0) idx--; return items[idx] || null; },
      all: function () { return items.slice(); }
    };
  }

  // ── Smart SQL suggestions ─────────────────────────────────────────────────
  function buildSmartSuggestions(dataset) {
    if (!dataset || !dataset.columns) return [];
    var tbl = '"' + safeTableName(dataset.name) + '"';
    var cols = dataset.columns;
    var numCols = cols.filter(function (c) { return c.type === 'number' || c.type === 'integer' || c.type === 'double'; });
    var catCols = cols.filter(function (c) { return c.type === 'text' || c.type === 'varchar'; });
    var dateCols = cols.filter(function (c) { return c.type === 'date' || c.type === 'timestamp'; });
    var suggestions = [];

    // Row count
    suggestions.push({ label: 'Count all rows', sql: 'SELECT COUNT(*) AS total_rows\nFROM ' + tbl });

    // Null check
    if (cols.length) {
      suggestions.push({
        label: 'Check null counts',
        sql: 'SELECT\n' + cols.slice(0, 6).map(function (c) {
          return '  COUNT(*) - COUNT("' + c.name + '") AS "' + c.name + '_nulls"';
        }).join(',\n') + '\nFROM ' + tbl
      });
    }

    // Group by + avg for first categorical + numeric pair
    if (catCols.length && numCols.length) {
      suggestions.push({
        label: 'Group by ' + catCols[0].name,
        sql: 'SELECT\n  "' + catCols[0].name + '",\n  COUNT(*) AS count,\n  ROUND(AVG("' + numCols[0].name + '"), 2) AS avg_' + numCols[0].name.replace(/[^a-z0-9]/gi, '_') + '\nFROM ' + tbl + '\nGROUP BY "' + catCols[0].name + '"\nORDER BY count DESC\nLIMIT 10'
      });
    }

    // Top N by numeric
    if (numCols.length) {
      suggestions.push({
        label: 'Top 10 by ' + numCols[0].name,
        sql: 'SELECT *\nFROM ' + tbl + '\nORDER BY "' + numCols[0].name + '" DESC\nLIMIT 10'
      });
    }

    // Date trend
    if (dateCols.length && numCols.length) {
      suggestions.push({
        label: 'Monthly trend',
        sql: 'SELECT\n  DATE_TRUNC(\'month\', "' + dateCols[0].name + '") AS month,\n  COUNT(*) AS count,\n  ROUND(SUM("' + numCols[0].name + '"), 2) AS total\nFROM ' + tbl + '\nGROUP BY month\nORDER BY month'
      });
    }

    // Duplicates
    if (cols.length) {
      suggestions.push({
        label: 'Find duplicates',
        sql: 'SELECT\n  ' + cols.slice(0, 3).map(function (c) { return '"' + c.name + '"'; }).join(', ') + ',\n  COUNT(*) AS occurrences\nFROM ' + tbl + '\nGROUP BY ' + cols.slice(0, 3).map(function (c) { return '"' + c.name + '"'; }).join(', ') + '\nHAVING COUNT(*) > 1\nORDER BY occurrences DESC'
      });
    }

    return suggestions;
  }

  // ── Results export ────────────────────────────────────────────────────────
  function exportResultsCSV(columns, rows) {
    var lines = [columns.map(function (c) { return JSON.stringify(c.name); }).join(',')];
    rows.forEach(function (row) {
      lines.push(columns.map(function (c) {
        var v = row[c.name];
        return v === null || v === undefined ? '' : JSON.stringify(String(v));
      }).join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'query_results.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // ── Public init ───────────────────────────────────────────────────────────
  function init(opts) {
    // opts: { getDatasets, onResultReady, onError }
    var adapter = createDuckDBAdapter();
    var history = createHistory();
    var lastResult = null;

    return {
      loadDataset: async function (dataset) {
        try { await adapter.registerDataset(dataset); } catch (e) { /* silent */ }
      },
      runQuery: async function (sql, datasets) {
        try {
          var result = await adapter.query(sql, datasets || []);
          lastResult = result;
          if (opts && opts.onResultReady) opts.onResultReady(result, sql);
          return result;
        } catch (e) {
          var msg = translateError(e.message || String(e));
          if (opts && opts.onError) opts.onError(msg, sql);
          throw new Error(msg);
        }
      },
      history: history,
      getLastResult: function () { return lastResult; },
      exportLastResult: function () {
        if (lastResult) exportResultsCSV(lastResult.columns, lastResult.rows);
      },
      buildSmartSuggestions: buildSmartSuggestions,
      buildAutocomplete: buildAutocomplete,
      safeTableName: safeTableName
    };
  }

  return { init: init, SQL_KEYWORDS: SQL_KEYWORDS, safeTableName: safeTableName, exportResultsCSV: exportResultsCSV };
