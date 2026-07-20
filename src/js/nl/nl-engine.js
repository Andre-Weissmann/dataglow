/* DataGlow — js/nl/nl-engine.js */
/* Part of structured refactor — see src/ directory */

/**
 * nl-engine.js — DataGlow Natural Language to Everything (PR AH)
 *
 * Converts plain-English questions into deterministic DuckDB-style queries
 * over the in-memory dataset, then renders the answer as a sentence.
 *
 * Zero LLM. Zero server. Pure keyword-pattern matching + aggregation logic.
 * Never hallucinates because it never guesses — it either runs a query and
 * returns the exact answer, or says "I didn't understand that."
 *
 * Public API:
 *   NLEngine.ask(question, dataset) → Promise<NLAnswer>
 *   NLEngine.getSuggestions(dataset) → string[]   (4 example questions)
 *
 * NLAnswer: { answer, sql, type, confidence, error }
 */

var NLEngine = (function () {
  'use strict';

  // ── helpers ───────────────────────────────────────────────────────────────

  function isNum(v) {
    return v !== null && v !== undefined && v !== '' && !isNaN(parseFloat(v)) && isFinite(v);
  }
  function num(v) { return parseFloat(v); }
  function fmt(n) {
    if (typeof n !== 'number' || isNaN(n)) return String(n);
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    if (n === Math.floor(n)) return n.toLocaleString();
    return n.toFixed(2);
  }
  function pct(p) { return Math.round(p * 100) + '%'; }
  function titleCase(s) {
    return s.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function lower(s) { return String(s || '').toLowerCase(); }

  // ── column matching ────────────────────────────────────────────────────────

  function findCol(cols, keywords) {
    // Exact substring match first, then partial
    var kws = Array.isArray(keywords) ? keywords : [keywords];
    for (var i = 0; i < kws.length; i++) {
      var kw = lower(kws[i]);
      for (var j = 0; j < cols.length; j++) {
        if (lower(cols[j]) === kw) return cols[j];
      }
    }
    for (var i = 0; i < kws.length; i++) {
      var kw = lower(kws[i]);
      for (var j = 0; j < cols.length; j++) {
        if (lower(cols[j]).includes(kw)) return cols[j];
      }
    }
    return null;
  }

  function numericCols(dataset) {
    return dataset.columns.filter(function (col) {
      var sample = dataset.rows.slice(0, 10).filter(function (r) { return isNum(r[col]); });
      return sample.length >= 3;
    });
  }

  function categoricalCols(dataset) {
    return dataset.columns.filter(function (col) {
      var sample = dataset.rows.slice(0, 10).filter(function (r) { return isNum(r[col]); });
      return sample.length < 3;
    });
  }

  function dateCols(dataset) {
    return dataset.columns.filter(function (col) {
      var sample = dataset.rows.slice(0, 5).map(function (r) { return String(r[col] || ''); });
      return sample.some(function (v) { return /^\d{4}[-/]/.test(v) || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(v); });
    });
  }

  // ── aggregation functions ─────────────────────────────────────────────────

  function groupBy(rows, groupCol, valueCol, agg) {
    var groups = {};
    rows.forEach(function (r) {
      var k = String(r[groupCol] == null ? '(blank)' : r[groupCol]).trim();
      var v = r[valueCol];
      if (!groups[k]) groups[k] = [];
      groups[k].push(v);
    });
    return Object.keys(groups).map(function (k) {
      var vals = groups[k];
      var numVals = vals.filter(isNum).map(num);
      var result;
      if (agg === 'count') result = vals.length;
      else if (agg === 'sum') result = numVals.reduce(function (s, v) { return s + v; }, 0);
      else if (agg === 'avg') result = numVals.length ? numVals.reduce(function (s, v) { return s + v; }, 0) / numVals.length : null;
      else if (agg === 'max') result = numVals.length ? Math.max.apply(null, numVals) : null;
      else if (agg === 'min') result = numVals.length ? Math.min.apply(null, numVals) : null;
      else result = vals.length;
      // For numeric aggregations, skip groups with no numeric data
      if (agg !== 'count' && result === null) return null;
      return { key: k, value: result, count: vals.length };
    }).filter(Boolean);
  }

  function topN(arr, n, descending) {
    return arr.slice().sort(function (a, b) {
      return descending ? b.value - a.value : a.value - b.value;
    }).slice(0, n);
  }

  // ── intent patterns ────────────────────────────────────────────────────────

  var INTENTS = [
    // HIGHEST / TOP / MOST
    {
      pattern: /\b(highest|most|top|largest|biggest|maximum|max|best)\b/i,
      type: 'top',
      direction: 'desc'
    },
    // LOWEST / BOTTOM / LEAST
    {
      pattern: /\b(lowest|least|bottom|smallest|minimum|min|worst|fewest)\b/i,
      type: 'top',
      direction: 'asc'
    },
    // AVERAGE / MEAN  -  before COUNT so "average claim count" resolves to avg not count
    {
      pattern: /\b(average|avg|mean|typical)\b/i,
      type: 'avg'
    },
    // SUM / TOTAL
    {
      pattern: /\b(sum|total|add up|combined|aggregate)\b/i,
      type: 'sum'
    },
    // COUNT / HOW MANY
    {
      pattern: /\b(count|how many|number of|total number|frequency)\b/i,
      type: 'count'
    },
    // DISTRIBUTION / BREAKDOWN
    {
      pattern: /\b(distribution|breakdown|split|breakdown by|by category|proportion|percentage|percent)\b/i,
      type: 'distribution'
    },
    // UNIQUE / DISTINCT
    {
      pattern: /\b(unique|distinct|different|how many types|variety)\b/i,
      type: 'unique'
    },
    // MISSING / NULL
    {
      pattern: /\b(missing|null|blank|empty|n\/a|not filled|incomplete)\b/i,
      type: 'missing'
    },
    // TREND / OVER TIME
    {
      pattern: /\b(trend|over time|change|grew|growth|decline|by month|by year|by date|timeline)\b/i,
      type: 'trend'
    },
    // COMPARE
    {
      pattern: /\b(compare|comparison|difference|vs\.?|versus|against)\b/i,
      type: 'compare'
    },
    // WHAT IS / TELL ME
    {
      pattern: /\b(what is|what are|tell me|show me|give me|find|list|display)\b/i,
      type: 'describe'
    },
    // ROWS / RECORDS
    {
      pattern: /\b(rows|records|entries|observations)\b/i,
      type: 'rowcount'
    }
  ];

  function detectIntent(q) {
    for (var i = 0; i < INTENTS.length; i++) {
      if (INTENTS[i].pattern.test(q)) return INTENTS[i];
    }
    return null;
  }

  // Extract column references from question text
  function extractCols(q, dataset) {
    var mentioned = [];
    var lq = lower(q);
    dataset.columns.forEach(function (col) {
      var lc = lower(col).replace(/_/g, ' ');
      if (lq.includes(lc) || lq.includes(lower(col))) {
        mentioned.push(col);
      }
    });
    return mentioned;
  }

  // ── answer builders ────────────────────────────────────────────────────────

  function answerTop(q, dataset, direction) {
    var rows = dataset.rows;
    var cols = dataset.columns;
    var mentionedCols = extractCols(q, dataset);
    var catCols = categoricalCols(dataset);
    var numCols_ = numericCols(dataset);

    var groupCol = mentionedCols.find(function (c) { return catCols.includes(c); }) || catCols[0];
    var valueCol = mentionedCols.find(function (c) { return numCols_.includes(c); }) || numCols_[0];

    if (!groupCol && !valueCol) {
      // No grouping  -  just find max/min value across all numeric cols
      if (!numCols_.length) return null;
      var col = numCols_[0];
      var vals = rows.map(function (r) { return r[col]; }).filter(isNum).map(num);
      if (!vals.length) return null;
      var extreme = direction === 'desc' ? Math.max.apply(null, vals) : Math.min.apply(null, vals);
      var word = direction === 'desc' ? 'highest' : 'lowest';
      return {
        answer: 'The ' + word + ' value of ' + titleCase(col) + ' is ' + fmt(extreme) + '.',
        sql: 'SELECT ' + (direction === 'desc' ? 'MAX' : 'MIN') + '("' + col + '") FROM data',
        type: 'top', confidence: 0.8
      };
    }

    if (groupCol && !valueCol) {
      // Count by group, find top
      var groups = groupBy(rows, groupCol, groupCol, 'count');
      var sorted = topN(groups, 1, direction === 'desc');
      if (!sorted.length) return null;
      var top = sorted[0];
      var word = direction === 'desc' ? 'most' : 'fewest';
      var total = rows.length;
      return {
        answer: '"' + top.key + '" has the ' + word + ' records in ' + titleCase(groupCol) +
          ' with ' + top.value.toLocaleString() + ' (' + pct(top.value / total) + ' of ' + total.toLocaleString() + ' total).',
        sql: 'SELECT "' + groupCol + '", COUNT(*) FROM data GROUP BY 1 ORDER BY 2 ' + (direction === 'desc' ? 'DESC' : 'ASC') + ' LIMIT 1',
        type: 'top', confidence: 0.85
      };
    }

    if (groupCol && valueCol) {
      var agg = /rate|percent|pct|ratio|avg|average|mean/i.test(q) ? 'avg' : 'sum';
      var groups = groupBy(rows, groupCol, valueCol, agg);
      var sorted = topN(groups, 1, direction === 'desc');
      if (!sorted.length) return null;
      var top = sorted[0];
      var aggWord = agg === 'avg' ? 'average' : 'total';
      var word = direction === 'desc' ? 'highest' : 'lowest';
      return {
        answer: '"' + top.key + '" has the ' + word + ' ' + aggWord + ' ' + titleCase(valueCol) +
          ' at ' + fmt(top.value) + ' (across ' + top.count.toLocaleString() + ' records).',
        sql: 'SELECT "' + groupCol + '", ' + agg.toUpperCase() + '("' + valueCol + '") FROM data GROUP BY 1 ORDER BY 2 ' + (direction === 'desc' ? 'DESC' : 'ASC') + ' LIMIT 1',
        type: 'top', confidence: 0.9
      };
    }

    return null;
  }

  function answerCount(q, dataset) {
    var rows = dataset.rows;
    var catCols = categoricalCols(dataset);
    var mentionedCols = extractCols(q, dataset);
    var groupCol = mentionedCols.find(function (c) { return catCols.includes(c); }) || catCols[0];

    if (groupCol) {
      var groups = groupBy(rows, groupCol, groupCol, 'count');
      groups.sort(function (a, b) { return b.value - a.value; });
      var top3 = groups.slice(0, 3);
      var parts = top3.map(function (g) {
        return '"' + g.key + '" (' + g.value.toLocaleString() + ')';
      });
      return {
        answer: titleCase(groupCol) + ' has ' + groups.length + ' unique values across ' +
          rows.length.toLocaleString() + ' rows. Top: ' + parts.join(', ') + '.',
        sql: 'SELECT "' + groupCol + '", COUNT(*) FROM data GROUP BY 1 ORDER BY 2 DESC LIMIT 3',
        type: 'count', confidence: 0.88
      };
    }

    return {
      answer: 'There are ' + rows.length.toLocaleString() + ' rows and ' +
        dataset.columns.length + ' columns in this dataset.',
      sql: 'SELECT COUNT(*) FROM data',
      type: 'rowcount', confidence: 1.0
    };
  }

  function answerSum(q, dataset) {
    var rows = dataset.rows;
    var numCols_ = numericCols(dataset);
    var catCols = categoricalCols(dataset);
    var mentionedCols = extractCols(q, dataset);
    var valueCol = mentionedCols.find(function (c) { return numCols_.includes(c); }) || numCols_[0];
    var groupCol = mentionedCols.find(function (c) { return catCols.includes(c); }) || null;

    if (!valueCol) return null;

    if (groupCol) {
      var groups = groupBy(rows, groupCol, valueCol, 'sum');
      groups.sort(function (a, b) { return b.value - a.value; });
      var top3 = groups.slice(0, 3);
      var parts = top3.map(function (g) { return '"' + g.key + '" (' + fmt(g.value) + ')'; });
      var total = groups.reduce(function (s, g) { return s + g.value; }, 0);
      return {
        answer: 'Total ' + titleCase(valueCol) + ' is ' + fmt(total) + '. By ' + titleCase(groupCol) +
          ': ' + parts.join(', ') + (groups.length > 3 ? ' and ' + (groups.length - 3) + ' more.' : '.'),
        sql: 'SELECT "' + groupCol + '", SUM("' + valueCol + '") FROM data GROUP BY 1 ORDER BY 2 DESC',
        type: 'sum', confidence: 0.9
      };
    }

    var total = rows.map(function (r) { return r[valueCol]; }).filter(isNum).map(num)
      .reduce(function (s, v) { return s + v; }, 0);
    return {
      answer: 'Total ' + titleCase(valueCol) + ' is ' + fmt(total) + ' across all ' + rows.length.toLocaleString() + ' rows.',
      sql: 'SELECT SUM("' + valueCol + '") FROM data',
      type: 'sum', confidence: 0.92
    };
  }

  function answerAvg(q, dataset) {
    var rows = dataset.rows;
    var numCols_ = numericCols(dataset);
    var catCols = categoricalCols(dataset);
    var mentionedCols = extractCols(q, dataset);
    var valueCol = mentionedCols.find(function (c) { return numCols_.includes(c); }) || numCols_[0];
    var groupCol = mentionedCols.find(function (c) { return catCols.includes(c); });

    if (!valueCol) return null;

    if (groupCol) {
      var groups = groupBy(rows, groupCol, valueCol, 'avg');
      groups.sort(function (a, b) { return b.value - a.value; });
      var top = groups[0];
      var bottom = groups[groups.length - 1];
      return {
        answer: 'Average ' + titleCase(valueCol) + ' by ' + titleCase(groupCol) + ': highest is "' +
          top.key + '" at ' + fmt(top.value) + ', lowest is "' + bottom.key + '" at ' + fmt(bottom.value) + '.',
        sql: 'SELECT "' + groupCol + '", AVG("' + valueCol + '") FROM data GROUP BY 1 ORDER BY 2 DESC',
        type: 'avg', confidence: 0.88
      };
    }

    var vals = rows.map(function (r) { return r[valueCol]; }).filter(isNum).map(num);
    var avg = vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
    return {
      answer: 'Average ' + titleCase(valueCol) + ' is ' + fmt(avg) + ' across ' + vals.length.toLocaleString() + ' rows.',
      sql: 'SELECT AVG("' + valueCol + '") FROM data',
      type: 'avg', confidence: 0.92
    };
  }

  function answerDistribution(q, dataset) {
    var catCols = categoricalCols(dataset);
    var mentionedCols = extractCols(q, dataset);
    var groupCol = mentionedCols.find(function (c) { return catCols.includes(c); }) || catCols[0];

    if (!groupCol) return null;

    var groups = groupBy(dataset.rows, groupCol, groupCol, 'count');
    groups.sort(function (a, b) { return b.value - a.value; });
    var total = dataset.rows.length;
    var top5 = groups.slice(0, 5);
    var parts = top5.map(function (g) {
      return '"' + g.key + '" ' + pct(g.value / total);
    });
    return {
      answer: titleCase(groupCol) + ' breakdown (' + groups.length + ' values): ' + parts.join(', ') +
        (groups.length > 5 ? ' + ' + (groups.length - 5) + ' more.' : '.'),
      sql: 'SELECT "' + groupCol + '", COUNT(*), COUNT(*)*1.0/SUM(COUNT(*)) OVER () AS pct FROM data GROUP BY 1 ORDER BY 2 DESC',
      type: 'distribution', confidence: 0.9
    };
  }

  function answerUnique(q, dataset) {
    var mentionedCols = extractCols(q, dataset);
    var col = mentionedCols[0] || dataset.columns[0];
    var vals = new Set(dataset.rows.map(function (r) { return r[col]; }));
    return {
      answer: titleCase(col) + ' has ' + vals.size.toLocaleString() + ' unique values across ' +
        dataset.rows.length.toLocaleString() + ' rows.',
      sql: 'SELECT COUNT(DISTINCT "' + col + '") FROM data',
      type: 'unique', confidence: 0.9
    };
  }

  function answerMissing(q, dataset) {
    var rows = dataset.rows;
    var mentionedCols = extractCols(q, dataset);
    var col = mentionedCols[0];

    if (col) {
      var nulls = rows.filter(function (r) { return r[col] == null || r[col] === ''; }).length;
      return {
        answer: titleCase(col) + ' has ' + nulls.toLocaleString() + ' missing values (' +
          pct(nulls / rows.length) + ' of ' + rows.length.toLocaleString() + ' rows).',
        sql: 'SELECT COUNT(*) FROM data WHERE "' + col + '" IS NULL OR "' + col + '" = \'\'',
        type: 'missing', confidence: 0.92
      };
    }

    // Report all columns with missing values
    var withMissing = dataset.columns.map(function (c) {
      var n = rows.filter(function (r) { return r[c] == null || r[c] === ''; }).length;
      return { col: c, n: n };
    }).filter(function (x) { return x.n > 0; });

    if (!withMissing.length) {
      return {
        answer: 'No missing values found across any column in this dataset.',
        sql: 'SELECT * FROM data WHERE any column IS NULL',
        type: 'missing', confidence: 1.0
      };
    }
    withMissing.sort(function (a, b) { return b.n - a.n; });
    var parts = withMissing.slice(0, 3).map(function (x) {
      return titleCase(x.col) + ' (' + x.n + ')';
    });
    return {
      answer: withMissing.length + ' column' + (withMissing.length === 1 ? '' : 's') +
        ' have missing values. Worst: ' + parts.join(', ') + '.',
      sql: 'SELECT column_name, COUNT(*) missing FROM data WHERE value IS NULL GROUP BY 1',
      type: 'missing', confidence: 0.88
    };
  }

  function answerRowCount(q, dataset) {
    return {
      answer: 'This dataset has ' + dataset.rows.length.toLocaleString() + ' rows and ' +
        dataset.columns.length + ' columns (' + dataset.columns.join(', ') + ').',
      sql: 'SELECT COUNT(*) FROM data',
      type: 'rowcount', confidence: 1.0
    };
  }

  function answerDescribe(q, dataset) {
    var mentionedCols = extractCols(q, dataset);
    if (!mentionedCols.length) return answerRowCount(q, dataset);

    var col = mentionedCols[0];
    var rows = dataset.rows;
    var vals = rows.map(function (r) { return r[col]; }).filter(function (v) { return v != null && v !== ''; });

    if (numericCols(dataset).includes(col)) {
      var nums = vals.filter(isNum).map(num);
      if (!nums.length) return null;
      var sum = nums.reduce(function (s, v) { return s + v; }, 0);
      var avg = sum / nums.length;
      var sorted = nums.slice().sort(function (a, b) { return a - b; });
      return {
        answer: titleCase(col) + ': ' + nums.length.toLocaleString() + ' values, min ' + fmt(sorted[0]) +
          ', max ' + fmt(sorted[sorted.length - 1]) + ', avg ' + fmt(avg) + '.',
        sql: 'SELECT MIN("' + col + '"), MAX("' + col + '"), AVG("' + col + '"), COUNT("' + col + '") FROM data',
        type: 'describe', confidence: 0.9
      };
    }

    var freq = {};
    vals.forEach(function (v) { freq[String(v)] = (freq[String(v)] || 0) + 1; });
    var entries = Object.keys(freq).map(function (k) { return { k: k, n: freq[k] }; });
    entries.sort(function (a, b) { return b.n - a.n; });
    var unique = entries.length;
    var top3 = entries.slice(0, 3).map(function (e) { return '"' + e.k + '" (' + e.n + ')'; });
    return {
      answer: titleCase(col) + ': ' + unique + ' unique values, ' + vals.length.toLocaleString() +
        ' non-null. Top: ' + top3.join(', ') + '.',
      sql: 'SELECT "' + col + '", COUNT(*) FROM data GROUP BY 1 ORDER BY 2 DESC LIMIT 3',
      type: 'describe', confidence: 0.88
    };
  }

  // ── main entry point ──────────────────────────────────────────────────────

  function ask(question, dataset) {
    return new Promise(function (resolve) {
      if (!question || !question.trim()) {
        return resolve({ answer: '', sql: '', type: 'empty', confidence: 0 });
      }
      if (!dataset || !dataset.rows || !dataset.rows.length) {
        return resolve({ answer: 'No data loaded yet. Drop a file first.', sql: '', type: 'nodata', confidence: 0 });
      }

      var q = question.trim();
      var intent = detectIntent(q);
      var result = null;

      try {
        if (!intent) {
          // Try describe as fallback if column name is mentioned
          var mentioned = extractCols(q, dataset);
          if (mentioned.length) {
            result = answerDescribe(q, dataset);
          } else {
            result = answerRowCount(q, dataset);
          }
        } else {
          switch (intent.type) {
            case 'top':
              result = answerTop(q, dataset, intent.direction || 'desc');
              break;
            case 'count':
              result = answerCount(q, dataset);
              break;
            case 'sum':
              result = answerSum(q, dataset);
              break;
            case 'avg':
              result = answerAvg(q, dataset);
              break;
            case 'distribution':
              result = answerDistribution(q, dataset);
              break;
            case 'unique':
              result = answerUnique(q, dataset);
              break;
            case 'missing':
              result = answerMissing(q, dataset);
              break;
            case 'rowcount':
              result = answerRowCount(q, dataset);
              break;
            case 'describe':
              result = answerDescribe(q, dataset);
              break;
            case 'compare':
              result = answerDistribution(q, dataset) || answerTop(q, dataset, 'desc');
              break;
            case 'trend':
              // Trend: find date col + numeric col
              var dCols = dateCols(dataset);
              var nCols = numericCols(dataset);
              if (dCols.length && nCols.length) {
                var mentioned2 = extractCols(q, dataset);
                var numCol = mentioned2.find(function (c) { return nCols.includes(c); }) || nCols[0];
                result = {
                  answer: 'Found date column "' + dCols[0] + '" and metric "' + titleCase(numCol) +
                    '". The data spans ' + dataset.rows.length.toLocaleString() + ' records. ' +
                    'Drop the file into the Chart Layer (coming soon) to visualize the trend.',
                  sql: 'SELECT "' + dCols[0] + '", SUM("' + numCol + '") FROM data GROUP BY 1 ORDER BY 1',
                  type: 'trend', confidence: 0.7
                };
              } else {
                result = answerRowCount(q, dataset);
              }
              break;
            default:
              result = answerDescribe(q, dataset);
          }
        }
      } catch (e) {
        result = null;
      }

      if (!result) {
        result = {
          answer: "I understood your question but couldn't find the right columns to answer it. Try asking about a specific column name  -  for example: \"what is the total " + ((dataset.columns[0] && dataset.columns[0].name) || 'value') + "?\"",
          sql: '',
          type: 'unclear', confidence: 0.2
        };
      }

      resolve(result);
    });
  }

  // Generate 4 contextual example questions based on the actual columns
  // ── Smart question seeder  -  column-aware, data-specific ─────────────────
  function getSuggestions(dataset) {
    // Use workspace profile to enhance domain detection
    var _prof = window._workspaceProfile;
    var _profDomain = _prof ? (_prof.domain || '') : '';
    var _profTerms = _prof ? (_prof.terms || '') : '';

    if (!dataset || !dataset.columns || !dataset.columns.length) {
      return [
        'How many rows are there?',
        'Are there any missing values?',
        'What does this data contain?',
        'What is the distribution of the first column?'
      ];
    }

    var suggestions = [];
    var numCols_  = numericCols(dataset);
    var catCols_  = categoricalCols(dataset);
    var rows      = dataset.rows;
    var cols      = dataset.columns;

    // Detect domain hints from column names
    var allNames  = cols.map(function (c) { return c.name.toLowerCase(); }).join(' ');
    var isHealth  = _profDomain === 'healthcare' || /claim|diagnosis|patient|icd|provider|admit|discharge|procedure|cpt|drg|npi|member|rx|pharmacy/.test(allNames + ' ' + _profTerms);
    var isFinance = /revenue|amount|cost|price|sale|profit|margin|spend|budget|invoice|payment|charge/.test(allNames);
    var isSales   = /order|customer|product|region|territory|rep|quota|pipeline|lead|deal|account/.test(allNames);
    var isHR      = /employee|salary|department|hire|tenure|headcount|role|position|manager|review/.test(allNames);
    var hasDate   = cols.some(function (c) {
      var ci = cols.indexOf(c);
      var sample = rows.slice(0, 6).map(function (r) { return String(r[ci] || ''); });
      return sample.some(function (v) { return /^\d{4}[-/]/.test(v) || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(v); });
    });

    // Domain-specific questions
    if (isHealth && catCols_.length && numCols_.length) {
      var provCol = cols.find(function (c) { return /provider|physician|npi|doctor/.test(c.name.toLowerCase()); });
      var claimCol = cols.find(function (c) { return /claim|amount|charge|cost/.test(c.name.toLowerCase()); });
      var dxCol = cols.find(function (c) { return /diag|icd|dx|code/.test(c.name.toLowerCase()); });
      if (provCol && claimCol) suggestions.push('Which provider has the highest average ' + claimCol.name + '?');
      if (dxCol) suggestions.push('What are the most common diagnosis codes?');
      if (claimCol) suggestions.push('Are there any unusually large claims worth reviewing?');
      if (hasDate && claimCol) suggestions.push('How has ' + claimCol.name + ' trended over time?');
    }

    if (isFinance && numCols_.length) {
      var amtCol = cols.find(function (c) { return /amount|revenue|sale|cost|price/.test(c.name.toLowerCase()); });
      if (amtCol && catCols_.length) suggestions.push('Which ' + catCols_[0] + ' drives the most ' + amtCol.name + '?');
      if (amtCol) suggestions.push('What is the total ' + amtCol.name + ' and how does it vary?');
      if (hasDate && amtCol) suggestions.push('Show me the monthly trend for ' + amtCol.name);
    }

    if (isSales && catCols_.length && numCols_.length) {
      var valCol = cols.find(function (c) { return /revenue|amount|deal|value|sale/.test(c.name.toLowerCase()); });
      var regCol = cols.find(function (c) { return /region|territory|area|market/.test(c.name.toLowerCase()); });
      if (regCol && valCol) suggestions.push('Which region has the highest ' + valCol.name + '?');
      suggestions.push('Who are the top 10 customers by ' + (valCol ? valCol.name : numCols_[0]) + '?');
    }

    if (isHR && catCols_.length && numCols_.length) {
      var salCol = cols.find(function (c) { return /salary|pay|compensation|wage/.test(c.name.toLowerCase()); });
      var deptCol = cols.find(function (c) { return /dept|department|team|group/.test(c.name.toLowerCase()); });
      if (deptCol && salCol) suggestions.push('Which department has the highest average ' + salCol.name + '?');
      if (salCol) suggestions.push('What is the salary distribution across the organization?');
    }

    // Universal smart questions based on column shape
    if (catCols_.length >= 1 && numCols_.length >= 1 && suggestions.length < 5) {
      suggestions.push('Which ' + catCols_[0] + ' has the highest ' + numCols_[0] + '?');
    }
    if (numCols_.length >= 2 && suggestions.length < 5) {
      suggestions.push('Is there a relationship between ' + numCols_[0] + ' and ' + numCols_[1] + '?');
    }
    if (catCols_.length >= 1 && suggestions.length < 5) {
      suggestions.push('What is the breakdown of ' + catCols_[0] + '?');
    }
    if (numCols_.length >= 1 && suggestions.length < 5) {
      suggestions.push('Are there any outliers in ' + numCols_[0] + '?');
    }
    if (hasDate && numCols_.length >= 1 && suggestions.length < 5) {
      suggestions.push('How has ' + numCols_[0] + ' changed over time?');
    }

    // Always-useful fallbacks
    if (suggestions.length < 3) suggestions.push('Are there any missing values?');
    if (suggestions.length < 3) suggestions.push('Show me a summary of this dataset');

    // Deduplicate and return top 5
    var seen = {};
    return suggestions.filter(function (s) {
      if (seen[s]) return false;
      seen[s] = true;
      return true;
    }).slice(0, 5);
  }

  return { ask: ask, getSuggestions: getSuggestions };
