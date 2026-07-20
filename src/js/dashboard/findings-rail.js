/* DataGlow — js/dashboard/findings-rail.js */
/* Part of structured refactor — see src/ directory */

/**
 * findings-rail.js — DataGlow Findings Rail (PR AU)
 *
 * The Findings Rail sits above the KPI cards in the dashboard view.
 * It reads the dataset's validation findings + stats and produces
 * 3-5 ranked, plain-English insight cards, each containing:
 *   - A context-anchored headline (anomaly-first when triggered)
 *   - A "why this matters" sentence
 *   - A root-cause decomposition when an anomaly is present
 *   - A one-line suggested next step
 *   - A provenance tag (which column + which rows)
 *   - A JSON export in a <details> tag for agent consumption
 *
 * Zero external dependencies. All compute is synchronous over data
 * already in browser memory. Nothing is transmitted.
 *
 * Public API:
 *   FindingsRail.render(dataset, containerEl)
 *   FindingsRail.clear(containerEl)
 */

var FindingsRail = (function () {
  'use strict';

  // ── Helpers ───────────────────────────────────────────────────────────────
  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return 'N/A';
    var abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    if (n !== Math.floor(n)) return parseFloat(n.toFixed(2)).toLocaleString();
    return n.toLocaleString();
  }
  function pct(n) { return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function isNum(v) { return v !== null && v !== undefined && v !== '' && !isNaN(parseFloat(v)) && isFinite(v); }
  function num(v)  { return parseFloat(v); }
  function colIdx(dataset, name) {
    for (var i = 0; i < dataset.columns.length; i++) {
      if (dataset.columns[i].name === name) return i;
    }
    return -1;
  }
  function colVals(dataset, colName) {
    var ci = colIdx(dataset, colName);
    if (ci < 0) return [];
    return dataset.rows.map(function (r) { return r[ci]; });
  }
  function numVals(dataset, colName) {
    return colVals(dataset, colName).filter(isNum).map(num);
  }
  function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce(function (s, v) { return s + v; }, 0) / arr.length;
  }
  function stddev(arr) {
    if (arr.length < 2) return 0;
    var m = mean(arr);
    return Math.sqrt(arr.reduce(function (s, v) { return s + Math.pow(v - m, 2); }, 0) / arr.length);
  }
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function titleCase(s) {
    return s.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // ── Finding generators ────────────────────────────────────────────────────

  // 1. Summary card  -  overall data health
  function findingSummary(dataset) {
    var totalRows = dataset.rows.length;
    var totalCols = dataset.columns.length;
    var findings  = dataset.findings || [];
    var errors    = (dataset.rowFlags || []).filter(function (f) { return f && f.error; }).length;
    var warnings  = (dataset.rowFlags || []).filter(function (f) { return f && f.warning; }).length;
    var score     = dataset.score != null ? dataset.score : null;

    var scoreLabel = score !== null
      ? (score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 60 ? 'Fair' : 'Poor')
      : null;

    var headline, detail, action;
    if (errors === 0 && warnings === 0) {
      headline = totalRows.toLocaleString() + ' rows, ' + totalCols + ' columns, no issues found.';
      detail   = 'Every value passed validation. This dataset is ready for analysis and dashboard delivery.';
      action   = 'You can proceed directly to SQL queries or the Dashboard view.';
    } else if (errors > 0) {
      headline = errors.toLocaleString() + ' row' + (errors === 1 ? '' : 's') + ' with errors detected.';
      detail   = 'Errors prevent reliable aggregation. Fix or exclude these rows before sharing results.';
      action   = 'Open the Validation Rail to see which rows are affected and why.';
    } else {
      headline = warnings.toLocaleString() + ' row' + (warnings === 1 ? '' : 's') + ' flagged for review.';
      detail   = 'Warnings do not block analysis but may skew averages and totals if left in.';
      action   = 'Review flagged rows in the Validation Rail. Consider filtering them before aggregating.';
    }

    return {
      id: 'summary',
      priority: 1,
      icon: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok',
      headline: headline,
      detail: detail,
      action: action,
      provenance: totalRows + ' rows across ' + totalCols + ' columns',
      scoreLabel: scoreLabel,
      score: score,
      json: {
        type: 'summary',
        rows: totalRows,
        columns: totalCols,
        errors: errors,
        warnings: warnings,
        score: score
      }
    };
  }

  // 2. Anomaly finding for each numeric column
  function findingAnomalies(dataset) {
    var results = [];
    dataset.columns.forEach(function (col, ci) {
      if (col.type !== 'INT' && col.type !== 'FLOAT' &&
          col.type !== 'number' && col.type !== 'integer' && col.type !== 'float' && col.type !== 'double') return;

      var vals = dataset.rows.map(function (r) { return r[ci]; }).filter(isNum).map(num);
      if (vals.length < 5) return;

      var m   = mean(vals);
      var sd  = stddev(vals);
      if (sd === 0) return;

      // Find outlier rows
      var outlierRows = [];
      dataset.rows.forEach(function (r, ri) {
        var v = r[ci];
        if (!isNum(v)) return;
        var z = Math.abs((num(v) - m) / sd);
        if (z > 2.5) outlierRows.push({ rowIdx: ri, value: num(v), z: z });
      });

      if (!outlierRows.length) return;

      // Root-cause: which categorical column best explains outliers?
      var catDrivers = [];
      dataset.columns.forEach(function (catCol, cci) {
        if (cci === ci) return;
        if (catCol.type === 'INT' || catCol.type === 'FLOAT' ||
            catCol.type === 'number' || catCol.type === 'float' || catCol.type === 'integer') return;
        var outlierKeys = outlierRows.map(function (o) { return String(dataset.rows[o.rowIdx][cci]); });
        var allKeys     = dataset.rows.map(function (r) { return String(r[cci]); });
        // Check if outliers concentrate in one group
        var freq = {};
        outlierKeys.forEach(function (k) { freq[k] = (freq[k] || 0) + 1; });
        var topKey = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; })[0];
        if (!topKey) return;
        var topCount   = freq[topKey];
        var totalInGrp = allKeys.filter(function (k) { return k === topKey; }).length;
        if (topCount / outlierRows.length >= 0.5 && totalInGrp > 0) {
          catDrivers.push({ colName: catCol.name, groupName: topKey, count: topCount, groupTotal: totalInGrp });
        }
      });

      var topDriver = catDrivers.length ? catDrivers[0] : null;
      var direction = outlierRows[0].value > m ? 'above' : 'below';
      var extreme   = outlierRows.reduce(function (a, b) { return b.z > a.z ? b : a; });

      var headline = titleCase(col.name) + ': ' + outlierRows.length + ' outlier' +
        (outlierRows.length === 1 ? '' : 's') + ' detected (' + direction + ' average).';
      var detail = 'Average ' + titleCase(col.name) + ' is ' + fmt(m) +
        '. The extreme value is ' + fmt(extreme.value) + ' (' + extreme.z.toFixed(1) + '\u03c3 from mean).';
      var action = topDriver
        ? 'Investigate rows where ' + titleCase(topDriver.colName) + ' = "' + topDriver.groupName +
          '" (' + topDriver.count + ' of ' + outlierRows.length + ' outliers cluster there).'
        : 'Filter for rows with ' + titleCase(col.name) + ' outside ' + fmt(m - 2*sd) +
          ' to ' + fmt(m + 2*sd) + ' and validate manually.';

      results.push({
        id: 'anomaly-' + col.name,
        priority: 2,
        icon: 'anomaly',
        headline: headline,
        detail: detail,
        action: action,
        provenance: col.name + '  -  ' + vals.length + ' values, ' + outlierRows.length + ' outliers',
        rootCause: topDriver ? (titleCase(topDriver.colName) + ' = "' + topDriver.groupName + '"') : null,
        json: {
          type: 'anomaly',
          column: col.name,
          mean: parseFloat(m.toFixed(4)),
          stddev: parseFloat(sd.toFixed(4)),
          outlierCount: outlierRows.length,
          extremeValue: extreme.value,
          driver: topDriver
        }
      });
    });
    return results;
  }

  // 3. Missing data finding
  function findingMissing(dataset) {
    var results = [];
    dataset.columns.forEach(function (col, ci) {
      var nullCount = dataset.rows.filter(function (r) {
        var v = r[ci];
        return v === null || v === undefined || v === '';
      }).length;
      var pctMiss = nullCount / dataset.rows.length;
      if (pctMiss < 0.05) return; // ignore < 5%

      var headline = titleCase(col.name) + ': ' + nullCount.toLocaleString() +
        ' missing values (' + (pctMiss * 100).toFixed(0) + '% of rows).';
      var detail = pctMiss >= 0.3
        ? 'Over 30% of ' + titleCase(col.name) + ' is blank. This column may be unreliable for aggregations.'
        : 'Scattered nulls in ' + titleCase(col.name) + ' will produce understated counts and averages.';
      var action = pctMiss >= 0.5
        ? 'Consider dropping this column or imputing with a default value before analysis.'
        : 'Filter out nulls with WHERE "' + col.name + '" IS NOT NULL before aggregating.';

      results.push({
        id: 'missing-' + col.name,
        priority: 3,
        icon: 'warning',
        headline: headline,
        detail: detail,
        action: action,
        provenance: col.name + '  -  ' + nullCount + '/' + dataset.rows.length + ' rows null',
        json: {
          type: 'missing',
          column: col.name,
          nullCount: nullCount,
          totalRows: dataset.rows.length,
          pctMissing: parseFloat((pctMiss * 100).toFixed(1))
        }
      });
    });
    return results.slice(0, 2); // max 2 missing findings
  }

  // 4. Context-anchored KPI finding (trailing comparison)
  function findingKPIContext(dataset) {
    var results = [];
    var numCols = dataset.columns.filter(function (col, ci) {
      var vals = dataset.rows.map(function (r) { return r[ci]; }).filter(isNum);
      return vals.length >= dataset.rows.length * 0.6;
    });
    if (numCols.length === 0) return results;

    // Split into first half vs second half
    var mid = Math.floor(dataset.rows.length / 2);
    var firstHalf  = dataset.rows.slice(0, mid);
    var secondHalf = dataset.rows.slice(mid);

    numCols.slice(0, 2).forEach(function (col) {
      var ci = dataset.columns.indexOf(col);
      var v1 = mean(firstHalf.map(function (r) { return r[ci]; }).filter(isNum).map(num));
      var v2 = mean(secondHalf.map(function (r) { return r[ci]; }).filter(isNum).map(num));
      if (!v1 || !v2 || v1 === 0) return;
      var delta = ((v2 - v1) / Math.abs(v1)) * 100;
      if (Math.abs(delta) < 3) return; // ignore tiny changes

      var dir = delta > 0 ? 'increased' : 'decreased';
      var headline = titleCase(col.name) + ' ' + dir + ' ' + Math.abs(delta).toFixed(1) +
        '% from first half to second half of the dataset.';
      var detail = 'First-half average: ' + fmt(v1) + '. Second-half average: ' + fmt(v2) + '.';
      var action = 'Sort by a date column and re-run for a time-series trend. This comparison is row-order based.';

      results.push({
        id: 'kpi-trend-' + col.name,
        priority: 4,
        icon: delta > 0 ? 'up' : 'down',
        headline: headline,
        detail: detail,
        action: action,
        provenance: col.name + '  -  rows 1-' + mid + ' vs ' + (mid+1) + '-' + dataset.rows.length,
        json: {
          type: 'kpi_trend',
          column: col.name,
          firstHalfMean: parseFloat(v1.toFixed(4)),
          secondHalfMean: parseFloat(v2.toFixed(4)),
          deltaPercent: parseFloat(delta.toFixed(2))
        }
      });
    });
    return results;
  }

  // ── Render a single finding card ─────────────────────────────────────────
  function iconSVG(type) {
    var icons = {
      ok:      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="#16A34A" stroke-width="1.5"/><path d="M5 8l2 2 4-4" stroke="#16A34A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      warning: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2L14.5 13.5H1.5L8 2Z" stroke="#D97706" stroke-width="1.5" stroke-linejoin="round"/><line x1="8" y1="6.5" x2="8" y2="9.5" stroke="#D97706" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.75" fill="#D97706"/></svg>',
      error:   '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="#DC2626" stroke-width="1.5"/><line x1="5.5" y1="5.5" x2="10.5" y2="10.5" stroke="#DC2626" stroke-width="1.5" stroke-linecap="round"/><line x1="10.5" y1="5.5" x2="5.5" y2="10.5" stroke="#DC2626" stroke-width="1.5" stroke-linecap="round"/></svg>',
      anomaly: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 10l3-5 3 3 2-4 4 6" stroke="#4F98A3" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      up:      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 12V4M4 8l4-4 4 4" stroke="#16A34A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      down:    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 4v8M4 8l4 4 4-4" stroke="#DC2626" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    };
    return icons[type] || icons.ok;
  }

  function renderCard(finding) {
    var card = document.createElement('div');
    card.className = 'fr-card fr-card-' + finding.icon;

    var jsonStr = JSON.stringify(finding.json, null, 2);

    card.innerHTML =
      '<div class="fr-card-header">' +
        '<span class="fr-icon">' + iconSVG(finding.icon) + '</span>' +
        '<span class="fr-headline">' + escHtml(finding.headline) + '</span>' +
      '</div>' +
      '<p class="fr-detail">' + escHtml(finding.detail) + '</p>' +
      (finding.rootCause
        ? '<div class="fr-root-cause"><span class="fr-rc-label">Driver:</span> ' + escHtml(finding.rootCause) + '</div>'
        : '') +
      '<div class="fr-action"><span class="fr-action-label">Next step:</span> ' + escHtml(finding.action) + '</div>' +
      '<details class="fr-json-block">' +
        '<summary class="fr-json-toggle">View details</summary>' +
        '<pre class="fr-json-pre">' + escHtml(jsonStr) + '</pre>' +
      '</details>' +
      '<div class="fr-provenance">' + escHtml(finding.provenance) + '</div>';

    return card;
  }

  // ── Main render ───────────────────────────────────────────────────────────
  function render(dataset, containerEl) {
    if (!containerEl) return;
    containerEl.innerHTML = '';

    if (!dataset || !dataset.rows || !dataset.rows.length) {
      containerEl.innerHTML = '<div class="fr-empty">Drop a dataset to see findings.</div>';
      return;
    }

    // Collect all findings
    var all = [];
    all.push(findingSummary(dataset));
    findingAnomalies(dataset).forEach(function (f) { all.push(f); });
    findingMissing(dataset).forEach(function (f) { all.push(f); });
    findingKPIContext(dataset).forEach(function (f) { all.push(f); });

    // Sort by priority, cap at 5
    all.sort(function (a, b) { return a.priority - b.priority; });
    var shown = all.slice(0, 5);

    // Rail header
    var header = document.createElement('div');
    header.className = 'fr-header';
    header.innerHTML =
      '<span class="fr-header-title">Findings</span>' +
      '<span class="fr-header-count">' + shown.length + ' insight' + (shown.length === 1 ? '' : 's') + '</span>';
    containerEl.appendChild(header);

    // Cards
    var list = document.createElement('div');
    list.className = 'fr-list';
    shown.forEach(function (f) { list.appendChild(renderCard(f)); });
    containerEl.appendChild(list);

    // "No anomalies" footer when clean
    if (shown.length === 1 && shown[0].id === 'summary' && shown[0].icon === 'ok') {
      var footer = document.createElement('div');
      footer.className = 'fr-clean-footer';
      footer.textContent = 'No anomalies or data quality issues detected. Proceed with confidence.';
      containerEl.appendChild(footer);
    }
  }

  function clear(containerEl) {
    if (containerEl) containerEl.innerHTML = '';
  }

  return { render: render, clear: clear };
