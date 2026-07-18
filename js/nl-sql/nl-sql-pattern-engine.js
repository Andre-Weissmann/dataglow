// ============================================================
// DATAGLOW -- NL->SQL Pattern Engine (zero-cost, zero-API-key)
// ============================================================
// This is the PRIMARY path for turning a natural-language question into
// DuckDB SQL. It uses pure logic -- column detection, intent detection, and
// metric-contract injection -- so the common questions a data analyst asks
// are answered instantly, offline, with no API key and no network call.
//
// The LLM path (see nl-sql-engine.js) is SECONDARY -- it only runs for
// freeform questions the pattern engine cannot answer confidently.
//
// Philosophy (Steve Jobs): every answer should feel obvious. The engine
// prefers a clear, simple query over a clever one, and returns plain-English
// explanations and reasoning steps so a non-technical person understands it.
//
// Privacy: this file only ever touches column NAMES and TYPES from the schema
// context. It never reads a single row of user data.
//
// Coding constraints (iOS WKWebView): NO template literals (backticks)
// anywhere; NO apostrophes inside single-quoted strings (use double quotes).
// String building uses + concatenation only.
// ============================================================

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------

// Normalise a string for loose comparison: lowercase, strip underscores,
// spaces, and hyphens so "denial reason" == "denial_reason" == "denialreason".
function normalizeToken(s) {
  return String(s || '').toLowerCase().replace(/[_\s-]+/g, '');
}

// Quote an identifier for DuckDB with double quotes.
function q(identifier) {
  return '"' + String(identifier).replace(/"/g, '""') + '"';
}

// Simple stop-words we never treat as a referenced column.
var STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'by', 'in', 'on', 'for', 'to', 'and', 'or',
  'me', 'my', 'show', 'list', 'all', 'each', 'per', 'is', 'are', 'was',
  'were', 'what', 'which', 'how', 'many', 'much', 'with', 'without',
  'that', 'this', 'these', 'those', 'from', 'where', 'group', 'over',
  'time', 'top', 'bottom', 'highest', 'lowest', 'best', 'worst', 'count',
  'number', 'total', 'average', 'mean', 'avg', 'sum', 'display', 'give',
]);

// ---------------------------------------------------------------
// detectColumns(question, allCols)
// ---------------------------------------------------------------
// Returns { exact: string[], fuzzy: string[] } -- columns from allCols that
// appear to be referenced in the question. Matching is lowercase and ignores
// underscores; partial word matching contributes to the fuzzy bucket.
export function detectColumns(question, allCols) {
  var exact = [];
  var fuzzy = [];
  if (!question || !Array.isArray(allCols) || !allCols.length) {
    return { exact: exact, fuzzy: fuzzy };
  }

  var qLowerNorm = normalizeToken(question);   // squashed question, no spaces
  var qLowerSpaced = String(question).toLowerCase();

  // Tokenise the question into words (letters/digits only).
  var words = qLowerSpaced.split(/[^a-z0-9]+/).filter(function (w) {
    return w && !STOP_WORDS.has(w) && w.length >= 3;
  });

  for (var i = 0; i < allCols.length; i++) {
    var col = allCols[i];
    var colNorm = normalizeToken(col);          // e.g. "denialreason"
    if (!colNorm) continue;

    // 1. EXACT: the whole (normalised) column name appears in the question.
    if (qLowerNorm.indexOf(colNorm) !== -1) {
      if (exact.indexOf(col) === -1) exact.push(col);
      continue;
    }

    // 2. FUZZY: any question word matches a piece of the column name.
    var colParts = String(col).toLowerCase().split(/[_\s-]+/).filter(Boolean);
    var matched = false;
    for (var w = 0; w < words.length && !matched; w++) {
      var word = words[w];
      // whole-word matches a column part, or column part contains the word,
      // or the word contains a column part (partial word matching).
      for (var p = 0; p < colParts.length; p++) {
        var part = colParts[p];
        if (part.length < 3) continue;
        if (part === word ||
            part.indexOf(word) !== -1 ||
            word.indexOf(part) !== -1) {
          matched = true;
          break;
        }
      }
    }
    if (matched && exact.indexOf(col) === -1 && fuzzy.indexOf(col) === -1) {
      fuzzy.push(col);
    }
  }

  return { exact: exact, fuzzy: fuzzy };
}

// ---------------------------------------------------------------
// detectIntent(question)
// ---------------------------------------------------------------
// Returns one of: aggregate, filter, group, rank, trend, compare, count,
// list, general. Order matters: more specific intents win over generic ones.
export function detectIntent(question) {
  var q0 = String(question || '').toLowerCase();
  if (!q0.trim()) return 'general';

  var has = function (arr) {
    for (var i = 0; i < arr.length; i++) {
      if (q0.indexOf(arr[i]) !== -1) return true;
    }
    return false;
  };
  // Whole-word check: avoids matching "count" inside "encounters".
  var hasWord = function (arr) {
    for (var i = 0; i < arr.length; i++) {
      var re = new RegExp('\\b' + arr[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      if (re.test(q0)) return true;
    }
    return false;
  };

  // count is very specific -- check before aggregate/list. Use whole-word
  // matching so "encounters" does not trigger the "count" keyword.
  if (has(['how many', 'number of', 'total count']) ||
      hasWord(['count'])) return 'count';

  // trend / time-series
  if (has(['over time', 'by month', 'by week', 'by year', 'by day',
           'trend', 'timeline', 'history', 'monthly', 'weekly', 'yearly',
           'daily', 'per month', 'per week', 'per year'])) return 'trend';

  // rank / top-bottom
  if (has(['top ', 'bottom ', 'highest', 'lowest', 'best', 'worst',
           'ranked', 'ranking', 'rank'])) return 'rank';

  // compare
  if (has([' versus ', ' vs ', ' vs.', 'compare', 'difference', 'between'])) {
    return 'compare';
  }

  // aggregate (average / sum / total)
  if (has(['average', 'mean', 'avg', 'sum', 'total'])) return 'aggregate';

  // group / breakdown
  if (has([' by ', ' per ', 'each ', 'group', 'breakdown', 'break down',
           'split'])) return 'group';

  // filter
  if (has(['where', 'only', 'filter', 'exclude', 'include', ' with ',
           'without'])) return 'filter';

  // list
  if (has(['show me', 'list', 'display', ' all ', 'every '])) return 'list';

  return 'general';
}

// ---------------------------------------------------------------
// Internal: pick the primary table + a flat column list.
// ---------------------------------------------------------------
function pickPrimaryTable(schemaCtx) {
  if (!schemaCtx || !Array.isArray(schemaCtx.tables) || !schemaCtx.tables.length) {
    return null;
  }
  return schemaCtx.tables[0];
}

function tableCols(table) {
  if (!table || !Array.isArray(table.cols)) return [];
  return table.cols;
}

// Consider BOTH the normalised type group and the raw type so we work whether
// the schema carries type="number" or type="other"+rawType="DECIMAL(18,2)".
function colTypeText(col) {
  if (!col) return '';
  return (String(col.type || '') + ' ' + String(col.rawType || '')).toLowerCase();
}

function isNumericCol(col) {
  var t = colTypeText(col);
  return /\bnumber\b/.test(t) ||
    /int|dec|float|double|numeric|real|bigint/.test(t);
}

function isDateCol(col) {
  var t = colTypeText(col);
  return /\bdate\b/.test(t) || /time|timestamp/.test(t);
}

// Find a categorical (text / low-cardinality) column referenced in the
// question, useful for GROUP BY.
function findGroupCol(detected, table) {
  var cols = tableCols(table);
  var candidates = detected.exact.concat(detected.fuzzy);
  for (var i = 0; i < candidates.length; i++) {
    var name = candidates[i];
    var col = cols.find(function (c) { return c.name === name; });
    if (col && !isNumericCol(col) && !isDateCol(col)) return name;
  }
  // fallback: first referenced column that is not numeric/date
  for (var j = 0; j < candidates.length; j++) {
    var n2 = candidates[j];
    var c2 = cols.find(function (c) { return c.name === n2; });
    if (c2 && !isNumericCol(c2)) return n2;
  }
  return null;
}

function findDateCol(detected, table) {
  var cols = tableCols(table);
  var candidates = detected.exact.concat(detected.fuzzy);
  for (var i = 0; i < candidates.length; i++) {
    var col = cols.find(function (c) { return c.name === candidates[i]; });
    if (col && isDateCol(col)) return col.name;
  }
  // fallback: any date column in the table
  var anyDate = cols.find(function (c) { return isDateCol(c); });
  return anyDate ? anyDate.name : null;
}

function findNumericCol(detected, table) {
  var cols = tableCols(table);
  var candidates = detected.exact.concat(detected.fuzzy);
  for (var i = 0; i < candidates.length; i++) {
    var col = cols.find(function (c) { return c.name === candidates[i]; });
    if (col && isNumericCol(col)) return col.name;
  }
  return null;
}

// ---------------------------------------------------------------
// buildPatternSQL(question, schemaCtx, matchedContracts)
// ---------------------------------------------------------------
// Returns { sql, explanation, steps, confidence }.
// sql is null when the engine cannot build a confident query (falls to LLM).
export function buildPatternSQL(question, schemaCtx, matchedContracts) {
  var steps = [];
  var fail = function () {
    return { sql: null, explanation: '', steps: steps, confidence: 'low' };
  };

  var table = pickPrimaryTable(schemaCtx);
  if (!table) {
    steps.push('No tables available in schema.');
    return fail();
  }

  var allCols = [];
  var tables = schemaCtx.tables;
  for (var t = 0; t < tables.length; t++) {
    for (var c = 0; c < tables[t].cols.length; c++) {
      allCols.push(tables[t].cols[c].name);
    }
  }

  var intent = detectIntent(question);
  var detected = detectColumns(question, allCols);
  var contracts = Array.isArray(matchedContracts) ? matchedContracts : [];

  steps.push('Detected intent: ' + intent);
  steps.push('Primary table: ' + table.tableName);
  if (detected.exact.length) {
    steps.push('Matched columns (exact): ' + detected.exact.join(', '));
  }
  if (detected.fuzzy.length) {
    steps.push('Matched columns (fuzzy): ' + detected.fuzzy.join(', '));
  }
  if (contracts.length) {
    steps.push('Metric contracts matched: ' +
      contracts.map(function (m) { return m.alias || m.name || m.id; }).join(', '));
  }

  var tbl = q(table.tableName);
  var groupCol = findGroupCol(detected, table);
  var dateCol = findDateCol(detected, table);

  // Detect multi-condition complexity that warrants a CTE.
  var lowerQ = String(question || '').toLowerCase();
  var andCount = (lowerQ.match(/\band\b/g) || []).length;
  var isComplex = andCount >= 2 ||
    (contracts.length >= 1 && groupCol && dateCol) ||
    (contracts.length >= 2);

  // ---- Metric contract path (highest confidence) ----
  if (contracts.length) {
    var selectExprs = [];
    var usedCol = groupCol || findGroupCol(detected, table);

    // Build metric SELECT expressions from each matched contract.
    for (var m = 0; m < contracts.length; m++) {
      var mc = contracts[m];
      var expr = String(mc.expression || '');
      // Substitute {{table}} placeholder and {{col}} placeholder if present.
      expr = expr.replace(/\{\{table\}\}/g, table.tableName);
      if (expr.indexOf('{{col}}') !== -1) {
        var target = findNumericCol(detected, table) || usedCol;
        if (!target) {
          steps.push('Contract needs a column but none was referenced.');
          continue;
        }
        expr = expr.replace(/\{\{col\}\}/g, q(target));
      }
      selectExprs.push(expr + ' AS ' + q(mc.alias || ('metric_' + (m + 1))));
    }

    if (selectExprs.length) {
      var groupPart = '';
      var selectHead = '';
      if (usedCol && intent !== 'count') {
        selectHead = q(usedCol) + ', ' + selectExprs.join(', ');
        groupPart = ' GROUP BY ' + q(usedCol);
        steps.push('Group by: ' + usedCol);
      } else {
        selectHead = selectExprs.join(', ');
      }

      var sqlC;
      if (isComplex && usedCol) {
        // Build a CTE that isolates the base table then aggregates.
        var cte = 'WITH base AS (SELECT * FROM ' + tbl + ')\n';
        sqlC = cte + 'SELECT ' + selectHead + ' FROM base' +
          (usedCol && intent !== 'count' ? ' GROUP BY ' + q(usedCol) : '') +
          (usedCol && intent !== 'count' ? ' ORDER BY ' + q(usedCol) : '') +
          ' LIMIT 1000';
        steps.push('Built CTE for multi-step aggregation.');
      } else {
        sqlC = 'SELECT ' + selectHead + ' FROM ' + tbl + groupPart +
          (usedCol && intent !== 'count' ? ' ORDER BY ' + q(usedCol) : '') +
          ' LIMIT 1000';
      }

      var explC = explainSQL(sqlC, schemaCtx);
      return { sql: sqlC, explanation: explC, steps: steps, confidence: 'high' };
    }
  }

  // ---- COUNT path ----
  if (intent === 'count') {
    var sqlCount;
    if (groupCol) {
      sqlCount = 'SELECT ' + q(groupCol) + ', COUNT(*) AS ' + q('row_count') +
        ' FROM ' + tbl + ' GROUP BY ' + q(groupCol) +
        ' ORDER BY ' + q('row_count') + ' DESC LIMIT 1000';
      steps.push('Group by: ' + groupCol);
    } else {
      sqlCount = 'SELECT COUNT(*) AS ' + q('row_count') + ' FROM ' + tbl;
    }
    return {
      sql: sqlCount,
      explanation: explainSQL(sqlCount, schemaCtx),
      steps: steps,
      confidence: 'high',
    };
  }

  // ---- AGGREGATE path (average / sum) ----
  if (intent === 'aggregate') {
    var numCol = findNumericCol(detected, table);
    if (!numCol) {
      steps.push('Aggregate intent but no numeric column referenced.');
      return fail();
    }
    var func = /sum|total/.test(lowerQ) ? 'SUM' : 'AVG';
    var aggAlias = (func === 'SUM' ? 'total_' : 'avg_') + numCol;
    var sqlAgg;
    if (groupCol) {
      sqlAgg = 'SELECT ' + q(groupCol) + ', ROUND(' + func + '(' + q(numCol) +
        '), 2) AS ' + q(aggAlias) + ' FROM ' + tbl +
        ' GROUP BY ' + q(groupCol) + ' ORDER BY ' + q(aggAlias) +
        ' DESC LIMIT 1000';
      steps.push('Group by: ' + groupCol);
    } else {
      sqlAgg = 'SELECT ROUND(' + func + '(' + q(numCol) + '), 2) AS ' +
        q(aggAlias) + ' FROM ' + tbl;
    }
    steps.push('Aggregate: ' + func + ' on ' + numCol);
    return {
      sql: sqlAgg,
      explanation: explainSQL(sqlAgg, schemaCtx),
      steps: steps,
      confidence: 'high',
    };
  }

  // ---- TREND path ----
  if (intent === 'trend' && dateCol) {
    var grain = 'month';
    if (/by week|weekly|per week/.test(lowerQ)) grain = 'week';
    else if (/by year|yearly|per year/.test(lowerQ)) grain = 'year';
    else if (/by day|daily|per day/.test(lowerQ)) grain = 'day';
    var bucket = 'DATE_TRUNC(' + "'" + grain + "'" + ', ' + q(dateCol) + ')';
    var sqlTrend = 'SELECT ' + bucket + ' AS ' + q('period') +
      ', COUNT(*) AS ' + q('row_count') + ' FROM ' + tbl +
      ' GROUP BY ' + bucket + ' ORDER BY ' + q('period') + ' LIMIT 1000';
    steps.push('Time grain: ' + grain + ' on ' + dateCol);
    return {
      sql: sqlTrend,
      explanation: explainSQL(sqlTrend, schemaCtx),
      steps: steps,
      confidence: 'medium',
    };
  }

  // ---- RANK path ----
  if (intent === 'rank' && groupCol) {
    var dir = /bottom|lowest|worst/.test(lowerQ) ? 'ASC' : 'DESC';
    var sqlRank = 'SELECT ' + q(groupCol) + ', COUNT(*) AS ' + q('row_count') +
      ' FROM ' + tbl + ' GROUP BY ' + q(groupCol) +
      ' ORDER BY ' + q('row_count') + ' ' + dir + ' LIMIT 10';
    steps.push('Ranking ' + groupCol + ' by count (' + dir + '), top 10');
    return {
      sql: sqlRank,
      explanation: explainSQL(sqlRank, schemaCtx),
      steps: steps,
      confidence: 'medium',
    };
  }

  // ---- GROUP path ----
  if (intent === 'group' && groupCol) {
    var sqlGroup = 'SELECT ' + q(groupCol) + ', COUNT(*) AS ' + q('row_count') +
      ' FROM ' + tbl + ' GROUP BY ' + q(groupCol) +
      ' ORDER BY ' + q('row_count') + ' DESC LIMIT 1000';
    steps.push('Group by: ' + groupCol);
    return {
      sql: sqlGroup,
      explanation: explainSQL(sqlGroup, schemaCtx),
      steps: steps,
      confidence: 'high',
    };
  }

  // ---- LIST path ----
  if (intent === 'list') {
    var sqlList;
    if (detected.exact.length) {
      sqlList = 'SELECT ' + detected.exact.map(q).join(', ') +
        ' FROM ' + tbl + ' LIMIT 1000';
      steps.push('Selecting referenced columns.');
    } else {
      sqlList = 'SELECT * FROM ' + tbl + ' LIMIT 1000';
      steps.push('Selecting all columns.');
    }
    return {
      sql: sqlList,
      explanation: explainSQL(sqlList, schemaCtx),
      steps: steps,
      confidence: 'medium',
    };
  }

  // ---- FILTER path (simple equality on a referenced categorical col) ----
  if (intent === 'filter' && groupCol) {
    // We cannot know the value without row data, so fall back to a preview
    // selection that surfaces the column -- still useful and honest.
    var sqlFilter = 'SELECT * FROM ' + tbl + ' LIMIT 1000';
    steps.push('Filter intent detected; value unknown, returning preview.');
    return {
      sql: sqlFilter,
      explanation: explainSQL(sqlFilter, schemaCtx),
      steps: steps,
      confidence: 'low',
    };
  }

  // Nothing confident -- fall through to LLM.
  steps.push('No confident pattern matched; deferring to AI model.');
  return fail();
}

// ---------------------------------------------------------------
// autoFixSQL(badSQL, errorMessage, schemaCtx)
// ---------------------------------------------------------------
// Returns { sql, fix } -- a repaired SQL string plus a plain description of
// what changed, or { sql: null, fix } when it cannot be fixed.
export function autoFixSQL(badSQL, errorMessage, schemaCtx) {
  if (!badSQL || !errorMessage) {
    return { sql: null, fix: 'Nothing to fix.' };
  }
  var err = String(errorMessage).toLowerCase();

  // Collect all known column and table names.
  var allCols = [];
  var allTables = [];
  if (schemaCtx && Array.isArray(schemaCtx.tables)) {
    for (var t = 0; t < schemaCtx.tables.length; t++) {
      allTables.push(schemaCtx.tables[t].tableName);
      for (var c = 0; c < schemaCtx.tables[t].cols.length; c++) {
        allCols.push(schemaCtx.tables[t].cols[c].name);
      }
    }
  }

  // Find the closest name to a given target from a candidate list.
  var closest = function (target, candidates) {
    var tn = normalizeToken(target);
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < candidates.length; i++) {
      var cn = normalizeToken(candidates[i]);
      var score = 0;
      if (cn === tn) score = 100;
      else if (cn.indexOf(tn) !== -1 || tn.indexOf(cn) !== -1) {
        score = 60 - Math.abs(cn.length - tn.length);
      } else {
        // shared-prefix scoring
        var minLen = Math.min(cn.length, tn.length);
        var shared = 0;
        for (var k = 0; k < minLen; k++) {
          if (cn[k] === tn[k]) shared++; else break;
        }
        score = shared;
      }
      if (score > bestScore) { bestScore = score; best = candidates[i]; }
    }
    return bestScore >= 2 ? best : null;
  };

  // Pull the offending name out of the error message.
  var extractName = function () {
    // Character class includes single-quote, double-quote, and backtick.
    var quoteClass = '[' + String.fromCharCode(34, 39, 96) + ']';
    var m = errorMessage.match(new RegExp(quoteClass + '([A-Za-z0-9_]+)' + quoteClass));
    if (m) return m[1];
    var m2 = errorMessage.match(/column\s+([A-Za-z0-9_]+)/i);
    if (m2) return m2[1];
    var m3 = errorMessage.match(/table\s+([A-Za-z0-9_]+)/i);
    if (m3) return m3[1];
    return null;
  };

  // 1. column not found -> substitute a similar column name.
  if (err.indexOf('column') !== -1 &&
      (err.indexOf('not found') !== -1 || err.indexOf('does not exist') !== -1 ||
       err.indexOf('referenced column') !== -1)) {
    var badCol = extractName();
    if (badCol) {
      var goodCol = closest(badCol, allCols);
      if (goodCol && goodCol !== badCol) {
        var reCol = new RegExp('"?' + badCol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"?', 'g');
        var fixedCol = badSQL.replace(reCol, '"' + goodCol + '"');
        return {
          sql: fixedCol,
          fix: 'Replaced unknown column "' + badCol + '" with "' + goodCol + '".',
        };
      }
    }
    return { sql: null, fix: 'Column not found and no close match in schema.' };
  }

  // 2. table not found -> substitute a similar table name.
  if (err.indexOf('table') !== -1 &&
      (err.indexOf('not found') !== -1 || err.indexOf('does not exist') !== -1)) {
    var badTbl = extractName();
    if (badTbl) {
      var goodTbl = closest(badTbl, allTables);
      if (goodTbl && goodTbl !== badTbl) {
        var reTbl = new RegExp('"?' + badTbl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"?', 'g');
        var fixedTbl = badSQL.replace(reTbl, '"' + goodTbl + '"');
        return {
          sql: fixedTbl,
          fix: 'Replaced unknown table "' + badTbl + '" with "' + goodTbl + '".',
        };
      }
    }
    return { sql: null, fix: 'Table not found and no close match in schema.' };
  }

  // 3. ambiguous column -> qualify with the primary table name.
  if (err.indexOf('ambiguous') !== -1) {
    var ambName = extractName();
    var primary = allTables.length ? allTables[0] : null;
    if (ambName && primary) {
      var reAmb = new RegExp('(?<![\\.\\w"])"?' +
        ambName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"?(?![\\w"])', 'g');
      var qualified = badSQL.replace(reAmb, '"' + primary + '"."' + ambName + '"');
      return {
        sql: qualified,
        fix: 'Qualified ambiguous column "' + ambName + '" with table "' + primary + '".',
      };
    }
    return { sql: null, fix: 'Ambiguous column but no table to qualify with.' };
  }

  // 4. syntax error near X -> try removing the offending trailing clause.
  if (err.indexOf('syntax error') !== -1 || err.indexOf('parser error') !== -1) {
    // Strip a trailing LIMIT / ORDER BY / GROUP BY that may be malformed.
    var trimmed = badSQL
      .replace(/\s+LIMIT\s+[^;]*$/i, '')
      .replace(/\s+ORDER\s+BY\s+[^;]*$/i, '')
      .trim();
    if (trimmed && trimmed !== badSQL.trim()) {
      return {
        sql: trimmed,
        fix: 'Removed a trailing clause that caused a syntax error.',
      };
    }
    return { sql: null, fix: 'Syntax error could not be automatically repaired.' };
  }

  return { sql: null, fix: 'No automatic fix is available for this error.' };
}

// ---------------------------------------------------------------
// explainSQL(sql, schemaCtx)
// ---------------------------------------------------------------
// Returns a plain-English one-to-two sentence description of the query.
// No SQL jargon -- a non-technical person should understand it.
export function explainSQL(sql, schemaCtx) {
  if (!sql || !String(sql).trim()) return 'No query to explain.';
  var s = String(sql).replace(/\s+/g, ' ').trim();
  var upper = s.toUpperCase();

  // Verb: what the query does.
  var verb = 'shows';
  if (/COUNT\s*\(/i.test(s)) verb = 'counts';
  else if (/\bAVG\s*\(/i.test(s)) verb = 'averages';
  else if (/\bSUM\s*\(/i.test(s)) verb = 'totals';
  else if (/DATE_TRUNC/i.test(s)) verb = 'tracks';

  // Table: what it looks at.
  var tableName = 'the data';
  var fromMatch = s.match(/FROM\s+"?([A-Za-z0-9_]+)"?/i);
  if (fromMatch) tableName = fromMatch[1].replace(/_/g, ' ');
  else if (/FROM base/i.test(s)) {
    // CTE case: use the primary table from schema.
    if (schemaCtx && schemaCtx.tables && schemaCtx.tables.length) {
      tableName = String(schemaCtx.tables[0].tableName).replace(/_/g, ' ');
    }
  }

  // Group by clause.
  var groupPhrase = '';
  var groupMatch = s.match(/GROUP BY\s+"?([A-Za-z0-9_]+)"?/i);
  if (groupMatch && !/DATE_TRUNC/i.test(s)) {
    groupPhrase = ' broken down by ' + groupMatch[1].replace(/_/g, ' ');
  }

  // Time grain.
  var timePhrase = '';
  var truncMatch = s.match(/DATE_TRUNC\(\s*'([a-z]+)'/i);
  if (truncMatch) timePhrase = ' over each ' + truncMatch[1];

  // Order / rank.
  var orderPhrase = '';
  if (/ORDER BY[^)]*\bASC\b/i.test(upper)) orderPhrase = ' from lowest to highest';
  else if (/ORDER BY[^)]*\bDESC\b/i.test(upper)) orderPhrase = ' from highest to lowest';

  // Limit.
  var limitPhrase = '';
  var limitMatch = s.match(/LIMIT\s+(\d+)/i);
  if (limitMatch && Number(limitMatch[1]) <= 50) {
    limitPhrase = ', keeping the top ' + limitMatch[1];
  }

  // What is being measured (best-effort noun).
  var noun = '';
  if (verb === 'counts') noun = ' the number of records';
  else if (verb === 'averages') {
    var avgCol = s.match(/AVG\s*\(\s*"?([A-Za-z0-9_]+)"?/i);
    noun = avgCol ? ' ' + avgCol[1].replace(/_/g, ' ') : ' the values';
  } else if (verb === 'totals') {
    var sumCol = s.match(/SUM\s*\(\s*"?([A-Za-z0-9_]+)"?/i);
    noun = sumCol ? ' ' + sumCol[1].replace(/_/g, ' ') : ' the values';
  } else if (verb === 'tracks') {
    noun = ' how records change';
  } else {
    noun = ' records';
  }

  var sentence = 'This query ' + verb + noun + ' from ' + tableName +
    timePhrase + groupPhrase + orderPhrase + limitPhrase + '.';

  // Tidy double spaces.
  return sentence.replace(/\s+/g, ' ').replace(/\s+\./g, '.');
}
