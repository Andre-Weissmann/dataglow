/* DataGlow — js/infra/infrastructure.js */
/* Part of structured refactor — see src/ directory */

(function() {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 1. SQL ERROR TRANSLATOR
// Converts raw DuckDB error messages into plain English with suggestions
// ═══════════════════════════════════════════════════════════════════════
var SQLErrorTranslator = window.SQLErrorTranslator = {
  translate: function(rawMsg, datasets) {
    if (!rawMsg) return null;
    var msg = String(rawMsg);
    var columns = [];
    if (datasets && datasets.length) {
      datasets.forEach(function(ds) {
        (ds.columns || []).forEach(function(c) {
          // Accept both column objects {name} and plain strings
          columns.push(typeof c === 'string' ? c : (c.name || ''));
        });
      });
    }

    // Column not found  -  suggest closest match
    var colNotFound = msg.match(/(?:Referenced column|Column)\s+["']?([^"'\s]+)["']?\s+(?:not found|does not exist)/i);
    if (colNotFound) {
      var bad = colNotFound[1];
      var suggestion = SQLErrorTranslator._closest(bad, columns);
      return {
        title: 'Column not found',
        plain: 'The column "' + bad + '" does not exist in your dataset.',
        suggestion: suggestion ? 'Did you mean "' + suggestion + '"?' : 'Check the schema panel on the left for available column names.',
        fix: suggestion ? '"' + suggestion + '"' : null,
        raw: msg
      };
    }

    // Table not found
    var tblNotFound = msg.match(/(?:Table|Catalog Entry)\s+["']?([^"'\s]+)["']?\s+(?:not found|does not exist)/i);
    if (tblNotFound) {
      return {
        title: 'Table not found',
        plain: 'The table "' + tblNotFound[1] + '" is not loaded.',
        suggestion: 'Load a dataset first, or check the table name in the schema panel.',
        fix: null,
        raw: msg
      };
    }

    // Syntax error
    if (/syntax error/i.test(msg) || /Parser Error/i.test(msg)) {
      var near = msg.match(/near\s+"([^"]+)"/i);
      return {
        title: 'SQL syntax error',
        plain: 'There is a syntax problem in your query' + (near ? ' near "' + near[1] + '"' : '') + '.',
        suggestion: 'Check for missing commas, unmatched parentheses, or misspelled keywords like SELECT, FROM, WHERE, GROUP BY.',
        fix: null,
        raw: msg
      };
    }

    // Type mismatch
    if (/cannot be cast\|type mismatch\|conversion error\|invalid input syntax/i.test(msg)) {
      return {
        title: 'Data type mismatch',
        plain: 'You are comparing or combining columns of incompatible types (e.g. text vs. number).',
        suggestion: 'Use CAST(column AS INTEGER) or CAST(column AS VARCHAR) to convert types explicitly.',
        fix: null,
        raw: msg
      };
    }

    // Division by zero
    if (/division by zero/i.test(msg)) {
      return {
        title: 'Division by zero',
        plain: 'Your query divides by a value that is zero or null in some rows.',
        suggestion: 'Use NULLIF to protect: NULLIF(denominator, 0) returns NULL instead of crashing.',
        fix: null,
        raw: msg
      };
    }

    // Ambiguous column
    if (/ambiguous/i.test(msg)) {
      return {
        title: 'Ambiguous column name',
        plain: 'The same column name exists in multiple tables. DuckDB does not know which one to use.',
        suggestion: 'Qualify the column with the table name, e.g. table_name.column_name.',
        fix: null,
        raw: msg
      };
    }

    // Out of memory
    if (/out of memory\|memory limit\|not enough memory/i.test(msg)) {
      return {
        title: 'Not enough memory',
        plain: 'This query tried to use more memory than the browser allows.',
        suggestion: 'Add a LIMIT clause to reduce result size, or filter rows with a WHERE clause before aggregating.',
        fix: null,
        raw: msg
      };
    }

    // Generic fallback
    return {
      title: 'Query error',
      plain: 'Something went wrong running this query.',
      suggestion: null,
      fix: null,
      raw: msg
    };
  },

  // Levenshtein-based closest match
  _closest: function(target, candidates) {
    if (!candidates.length) return null;
    var tl = target.toLowerCase();
    var best = null, bestDist = Infinity;
    candidates.forEach(function(c) {
      var d = SQLErrorTranslator._lev(tl, c.toLowerCase());
      if (d < bestDist) { bestDist = d; best = c; }
    });
    return bestDist <= 4 ? best : null;
  },
  _lev: function(a, b) {
    var m = a.length, n = b.length;
    var dp = [];
    for (var i = 0; i <= m; i++) { dp[i] = [i]; }
    for (var j = 0; j <= n; j++) { dp[0][j] = j; }
    for (var i = 1; i <= m; i++) {
      for (var j = 1; j <= n; j++) {
        dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      }
    }
    return dp[m][n];
  }
};

// ═══════════════════════════════════════════════════════════════════════
// 2. PYTHON ERROR TRANSLATOR
// Converts raw Python/Pandas tracebacks into plain English
// ═══════════════════════════════════════════════════════════════════════
var PythonErrorTranslator = window.PythonErrorTranslator = {
  translate: function(rawMsg, columns) {
    if (!rawMsg) return null;
    var msg = String(rawMsg);
    columns = columns || [];

    // AttributeError  -  wrong method name
    var attrErr = msg.match(/AttributeError.*has no attribute ['"]([^'"]+)['"]/);
    if (attrErr) {
      return {
        title: 'Attribute error',
        plain: '"' + attrErr[1] + '" is not a valid method or property.',
        suggestion: 'Check the spelling. Common pandas methods: .groupby(), .merge(), .pivot_table(), .describe(), .value_counts()',
        raw: msg
      };
    }

    // KeyError  -  wrong column name
    var keyErr = msg.match(/KeyError:\s*['"]?([^'"]+)['"]?/);
    if (keyErr) {
      var bad = keyErr[1].trim();
      var suggestion = SQLErrorTranslator._closest(bad, columns);
      return {
        title: 'Column not found',
        plain: 'The column "' + bad + '" does not exist in this DataFrame.',
        suggestion: suggestion
          ? 'Did you mean "' + suggestion + '"? Available columns: ' + columns.slice(0,5).join(', ')
          : 'Available columns: ' + (columns.length ? columns.slice(0,5).join(', ') : 'use dg.df().columns to list them'),
        raw: msg
      };
    }

    // NameError
    var nameErr = msg.match(/NameError.*name ['"]([^'"]+)['"] is not defined/);
    if (nameErr) {
      return {
        title: 'Variable not defined',
        plain: '"' + nameErr[1] + '" has not been created yet.',
        suggestion: nameErr[1] === 'df' || nameErr[1] === 'dg'
          ? 'Start with: df = dg.df()   -  this loads your active dataset as a pandas DataFrame.'
          : 'Make sure you have defined "' + nameErr[1] + '" in a previous line.',
        raw: msg
      };
    }

    // IndentationError
    if (/IndentationError/i.test(msg)) {
      return {
        title: 'Indentation error',
        plain: 'Python requires consistent indentation (spaces, not tabs).',
        suggestion: 'Use 4 spaces for each level of indentation. Check that all lines in a block are aligned.',
        raw: msg
      };
    }

    // SyntaxError
    if (/SyntaxError/i.test(msg)) {
      return {
        title: 'Syntax error',
        plain: 'Python cannot understand this code.',
        suggestion: 'Check for missing colons after if/for/def, unmatched parentheses or quotes.',
        raw: msg
      };
    }

    // TypeError
    var typeErr = msg.match(/TypeError[:\s]+(.+)/);
    if (typeErr) {
      return {
        title: 'Type error',
        plain: typeErr[1].replace(/\n.*/,'').trim(),
        suggestion: 'You may be mixing strings and numbers, or calling a function with the wrong argument type.',
        raw: msg
      };
    }

    // Memory
    if (/MemoryError\|out of memory/i.test(msg)) {
      return {
        title: 'Out of memory',
        plain: 'This operation used more memory than the browser allows.',
        suggestion: 'Try filtering the DataFrame first: df = df.head(10000) or df = df[df["column"] == value]',
        raw: msg
      };
    }

    return {
      title: 'Python error',
      plain: msg.split('\n').filter(function(l){ return l.trim(); }).pop() || msg,
      suggestion: null,
      raw: msg
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════
// 3. MEMORY GUARD
// Watches WASM heap usage and warns before crash
// ═══════════════════════════════════════════════════════════════════════
var MemoryGuard = window.MemoryGuard = (function() {
  var _banner = null;
  var _dismissed = false;
  var _interval = null;
  var WARN_MB  = 3200;  // warn at 3.2GB used (4GB WASM limit)
  var DANGER_MB = 3700; // danger at 3.7GB

  function getMB() {
    // Chrome exposes performance.memory (non-standard but widely used)
    if (window.performance && window.performance.memory) {
      return Math.round(window.performance.memory.usedJSHeapSize / 1024 / 1024);
    }
    return null;
  }

  function ensureBanner() {
    if (_banner && document.body.contains(_banner)) return _banner;
    _banner = document.createElement('div');
    _banner.id = 'dg-memory-guard';
    _banner.className = 'hidden';
    _banner.innerHTML =
      '<span class="dg-mem-icon">&#9888;</span>' +
      '<span class="dg-mem-text"><strong id="dg-mem-title">Memory warning</strong><span id="dg-mem-body">Loading large data may cause the page to crash.</span></span>' +
      '<button class="dg-mem-dismiss" title="Dismiss" onclick="MemoryGuard.dismiss()">&#215;</button>';
    document.body.appendChild(_banner);
    return _banner;
  }

  return {
    start: function() {
      if (_interval) return;
      _interval = setInterval(function() {
        if (_dismissed) return;
        var mb = getMB();
        if (mb === null) return;
        if (mb >= DANGER_MB) {
          MemoryGuard.show('danger', mb);
        } else if (mb >= WARN_MB) {
          MemoryGuard.show('warn', mb);
        }
      }, 10000); // check every 10s
    },

    show: function(level, mb) {
      var banner = ensureBanner();
      var title = document.getElementById('dg-mem-title');
      var body  = document.getElementById('dg-mem-body');
      if (level === 'danger') {
        banner.className = 'danger';
        if (title) title.textContent = 'Critical memory usage  -  ' + mb + ' MB used';
        if (body) body.textContent = 'The browser is near its limit. Export your work and refresh the page before it crashes.';
      } else {
        banner.className = '';
        if (title) title.textContent = 'High memory usage  -  ' + mb + ' MB used';
        if (body) body.textContent = 'Large datasets are using significant memory. Consider filtering your data or closing unused datasets.';
      }
    },

    dismiss: function() {
      _dismissed = true;
      if (_banner) _banner.className = 'hidden';
      // Re-enable after 5 minutes for danger level
      setTimeout(function() { _dismissed = false; }, 5 * 60 * 1000);
    },

    // Call this after loading large file  -  immediate check
    checkNow: function() {
      _dismissed = false;
      var mb = getMB();
      if (mb !== null && mb >= WARN_MB) MemoryGuard.show(mb >= DANGER_MB ? 'danger' : 'warn', mb);
    }
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// 4. ERROR BOUNDARY WRAPPER
// Wraps any function call  -  catches errors, renders friendly UI
// ═══════════════════════════════════════════════════════════════════════
var ErrorBoundary = window.ErrorBoundary = {
  // Wrap a sync or async function  -  on error, render into containerEl
  wrap: function(fn, containerEl, retryFn) {
    try {
      var result = fn();
      if (result && typeof result.catch === 'function') {
        result.catch(function(e) {
          ErrorBoundary.render(containerEl, e, retryFn);
        });
      }
      return result;
    } catch(e) {
      ErrorBoundary.render(containerEl, e, retryFn);
    }
  },

  render: function(containerEl, err, retryFn) {
    if (!containerEl) return;
    var msg = err && err.message ? err.message : String(err);
    var id = 'eb-retry-' + Date.now();
    containerEl.innerHTML =
      '<div class="dg-error-boundary">' +
        '<div class="dg-error-boundary-icon">&#9888;&#65039;</div>' +
        '<div class="dg-error-boundary-title">Something went wrong</div>' +
        '<div class="dg-error-boundary-msg">' + String(msg).slice(0, 200) + '</div>' +
        (retryFn
          ? '<button class="dg-error-boundary-retry" id="' + id + '">Try again</button>'
          : '') +
      '</div>';
    if (retryFn) {
      var btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', function() {
        containerEl.innerHTML = '';
        ErrorBoundary.wrap(retryFn, containerEl, retryFn);
      });
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════
// 5. LOADING STATE HELPERS
// Show/hide skeleton and spinner states on any element
// ═══════════════════════════════════════════════════════════════════════
var LoadingStates = window.LoadingStates = {
  // Show spinner text on a status element
  setLoading: function(el, text) {
    if (!el) return;
    el.className = 'loading';
    el.textContent = text || 'Loading…';
  },

  // Render skeleton rows into a container
  skeleton: function(containerEl, rows, cols) {
    if (!containerEl) return;
    rows = rows || 3; cols = cols || 4;
    var html = '';
    for (var r = 0; r < rows; r++) {
      html += '<div style="display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--border);">';
      for (var c = 0; c < cols; c++) {
        var w = 60 + Math.random() * 80;
        html += '<span class="dg-skeleton" style="width:' + Math.round(w) + 'px;"></span>';
      }
      html += '</div>';
    }
    containerEl.innerHTML = html;
  },

  clear: function(el) {
    if (!el) return;
    el.className = '';
    el.textContent = '';
  }
};

// Auto-start memory guard on page load
document.addEventListener('DOMContentLoaded', function() {
  MemoryGuard.start();
});
// Also start immediately if DOM already ready
if (document.readyState !== 'loading') MemoryGuard.start();
