/**
 * anomaly-timeline.js — DataGlow Anomaly Timeline (PR AM)
 *
 * Pinpoints exactly when a metric changed — the exact row/date where
 * a value spiked, dropped, went missing, or crossed a threshold.
 *
 * Public API:
 *   AnomalyTimeline.detect(dataset)   → AnomalyReport
 *   AnomalyTimeline.render(report, containerEl)
 *
 * AnomalyReport: { events: AnomalyEvent[], summary: string }
 * AnomalyEvent:  { type, col, rowIndex, value, expected, delta, deltaPercent, severity, label, description }
 */

export var AnomalyTimeline = (function () {
  'use strict';

  var SEV = { critical: 0, high: 1, medium: 2, low: 3 };

  // ── helpers ───────────────────────────────────────────────────────────────
  function isNum(v) { return v !== null && v !== undefined && v !== '' && !isNaN(parseFloat(v)) && isFinite(v); }
  function num(v)   { return parseFloat(v); }
  function mean(arr) { return arr.reduce(function (s, x) { return s + x; }, 0) / arr.length; }
  function stddev(arr, avg) {
    var m = avg !== undefined ? avg : mean(arr);
    return Math.sqrt(arr.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / arr.length);
  }
  function fmt(n) {
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return parseFloat(n.toFixed(2)).toString();
  }
  function pct(n) { return (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%'; }

  // ── numeric spike/drop detector ───────────────────────────────────────────
  function detectNumericAnomalies(rows, col, events) {
    var vals = rows.map(function (r) { return r[col]; });
    var nums = vals.map(function (v, i) { return isNum(v) ? { i: i, v: num(v) } : null; }).filter(Boolean);
    if (nums.length < 5) return;

    var values = nums.map(function (n) { return n.v; });
    var avg = mean(values);
    var sd  = stddev(values, avg);
    if (sd === 0) return; // constant — no anomalies

    // Z-score each value
    nums.forEach(function (n) {
      var z = (n.v - avg) / sd;
      if (Math.abs(z) < 2.5) return; // below threshold
      var severity = Math.abs(z) >= 4 ? 'critical' : Math.abs(z) >= 3 ? 'high' : 'medium';
      var direction = n.v > avg ? 'spike' : 'drop';
      events.push({
        type: direction,
        col: col,
        rowIndex: n.i,
        value: n.v,
        expected: avg,
        delta: n.v - avg,
        deltaPercent: (n.v - avg) / Math.abs(avg),
        severity: severity,
        label: direction === 'spike' ? 'Spike' : 'Drop',
        description: col + ' row ' + (n.i + 1) + ': ' + fmt(n.v) +
          ' (' + pct((n.v - avg) / Math.abs(avg)) + ' vs avg ' + fmt(avg) + ')'
      });
    });

    // Rate-of-change: consecutive jumps > 3× average step
    var steps = [];
    for (var i = 1; i < nums.length; i++) {
      steps.push({ i: nums[i].i, delta: Math.abs(nums[i].v - nums[i - 1].v), from: nums[i - 1].v, to: nums[i].v });
    }
    if (steps.length < 3) return;
    var stepVals = steps.map(function (s) { return s.delta; });
    var stepAvg = mean(stepVals);
    var stepSd  = stddev(stepVals, stepAvg);
    if (stepSd === 0) return;
    steps.forEach(function (s) {
      var z = (s.delta - stepAvg) / stepSd;
      if (z < 3) return;
      events.push({
        type: 'jump',
        col: col,
        rowIndex: s.i,
        value: s.to,
        expected: s.from,
        delta: s.to - s.from,
        deltaPercent: (s.to - s.from) / (Math.abs(s.from) || 1),
        severity: z >= 4 ? 'high' : 'medium',
        label: 'Sudden change',
        description: col + ' row ' + (s.i + 1) + ': changed ' + fmt(s.from) + ' → ' + fmt(s.to) +
          ' (' + pct((s.to - s.from) / (Math.abs(s.from) || 1)) + ')'
      });
    });
  }

  // ── missing value cluster detector ────────────────────────────────────────
  function detectMissingClusters(rows, col, events) {
    var runStart = -1, runLen = 0;
    rows.forEach(function (r, i) {
      var empty = r[col] === null || r[col] === undefined || r[col] === '';
      if (empty) {
        if (runStart === -1) runStart = i;
        runLen++;
      } else {
        if (runLen >= 3) {
          events.push({
            type: 'missing_cluster',
            col: col,
            rowIndex: runStart,
            value: null,
            expected: '(values)',
            delta: runLen,
            deltaPercent: runLen / rows.length,
            severity: runLen >= 10 ? 'high' : 'medium',
            label: 'Missing cluster',
            description: col + ': ' + runLen + ' consecutive blank values starting at row ' + (runStart + 1)
          });
        }
        runStart = -1; runLen = 0;
      }
    });
  }

  // ── duplicate row detector ────────────────────────────────────────────────
  function detectDuplicateRows(rows, events) {
    var seen = {};
    var dupeRows = [];
    rows.forEach(function (r, i) {
      var key = JSON.stringify(r);
      if (seen[key] !== undefined) {
        dupeRows.push({ i: i, origIdx: seen[key] });
      } else {
        seen[key] = i;
      }
    });
    if (dupeRows.length > 0) {
      events.push({
        type: 'duplicate',
        col: null,
        rowIndex: dupeRows[0].i,
        value: dupeRows.length,
        expected: 0,
        delta: dupeRows.length,
        deltaPercent: dupeRows.length / rows.length,
        severity: dupeRows.length >= 5 ? 'high' : 'medium',
        label: 'Duplicate rows',
        description: dupeRows.length + ' exact duplicate row' + (dupeRows.length === 1 ? '' : 's') +
          ' found (first at row ' + (dupeRows[0].i + 1) + ')'
      });
    }
  }

  // ── date gap detector ─────────────────────────────────────────────────────
  function detectDateGaps(rows, col, events) {
    var pairs = rows.map(function (r, i) {
      var d = new Date(r[col]);
      return isNaN(d) ? null : { i: i, d: d };
    }).filter(Boolean);
    if (pairs.length < 4) return;
    pairs.sort(function (a, b) { return a.d - b.d; });

    var gaps = [];
    for (var i = 1; i < pairs.length; i++) {
      var gapDays = (pairs[i].d - pairs[i - 1].d) / 86400000;
      gaps.push(gapDays);
    }
    var avgGap = mean(gaps);
    var sdGap  = stddev(gaps, avgGap);
    if (sdGap === 0 || avgGap === 0) return;

    for (var j = 0; j < gaps.length; j++) {
      var z = (gaps[j] - avgGap) / sdGap;
      if (z > 2.5) {
        events.push({
          type: 'date_gap',
          col: col,
          rowIndex: pairs[j + 1].i,
          value: gaps[j],
          expected: avgGap,
          delta: gaps[j] - avgGap,
          deltaPercent: (gaps[j] - avgGap) / avgGap,
          severity: z >= 4 ? 'high' : 'medium',
          label: 'Date gap',
          description: col + ': unusually large gap of ' + Math.round(gaps[j]) + ' days before row ' + (pairs[j + 1].i + 1) +
            ' (avg gap: ' + Math.round(avgGap) + ' days)'
        });
      }
    }
  }

  // ── categorical shift detector ────────────────────────────────────────────
  function detectCategoricalShift(rows, col, events) {
    if (rows.length < 20) return;
    var half = Math.floor(rows.length / 2);
    var firstHalf  = rows.slice(0, half);
    var secondHalf = rows.slice(half);

    var freq = function (arr) {
      var f = {};
      arr.forEach(function (r) { var k = String(r[col] || ''); f[k] = (f[k] || 0) + 1; });
      return f;
    };
    var f1 = freq(firstHalf), f2 = freq(secondHalf);
    var allKeys = new Set(Object.keys(f1).concat(Object.keys(f2)));

    allKeys.forEach(function (k) {
      var p1 = (f1[k] || 0) / half;
      var p2 = (f2[k] || 0) / half;
      var shift = Math.abs(p2 - p1);
      if (shift > 0.25 && (p1 > 0.05 || p2 > 0.05)) {
        events.push({
          type: 'category_shift',
          col: col,
          rowIndex: half,
          value: p2,
          expected: p1,
          delta: p2 - p1,
          deltaPercent: p1 > 0 ? (p2 - p1) / p1 : 1,
          severity: shift > 0.4 ? 'high' : 'medium',
          label: 'Category shift',
          description: '"' + k + '" in ' + col + ': ' + Math.round(p1 * 100) + '% → ' + Math.round(p2 * 100) + '% across dataset halves'
        });
      }
    });
  }

  // ── main detect ───────────────────────────────────────────────────────────
  function detect(dataset) {
    if (!dataset || !dataset.rows || dataset.rows.length < 3) {
      return { events: [], summary: 'Not enough data to analyze.' };
    }

    var events = [];
    var rows = dataset.rows;

    // Classify columns
    var numCols = [], dateCols = [], catCols = [];
    dataset.columns.forEach(function (col) {
      var name = col.name;
      var sample = rows.slice(0, 30).map(function (r) { return r[name]; });
      var numCount = sample.filter(isNum).length;
      var dateCount = sample.filter(function (v) {
        return v && /^\d{4}[-/]/.test(String(v));
      }).length;
      if (numCount >= sample.length * 0.6) numCols.push(name);
      else if (dateCount >= 3) dateCols.push(name);
      else catCols.push(name);
    });

    // Run detectors
    numCols.forEach(function (c) { detectNumericAnomalies(rows, c, events); });
    dataset.columns.forEach(function (col) { detectMissingClusters(rows, col.name, events); });
    detectDuplicateRows(rows, events);
    dateCols.forEach(function (c) { detectDateGaps(rows, c, events); });
    catCols.slice(0, 3).forEach(function (c) { detectCategoricalShift(rows, c, events); });

    // Sort by severity then rowIndex
    events.sort(function (a, b) {
      var sd = SEV[a.severity] - SEV[b.severity];
      return sd !== 0 ? sd : (a.rowIndex || 0) - (b.rowIndex || 0);
    });

    // Cap to 30 most significant
    events = events.slice(0, 30);

    var critCount = events.filter(function (e) { return e.severity === 'critical'; }).length;
    var highCount = events.filter(function (e) { return e.severity === 'high'; }).length;
    var summary = events.length === 0
      ? 'No anomalies detected. Your data looks clean.'
      : events.length + ' anomal' + (events.length === 1 ? 'y' : 'ies') + ' found' +
        (critCount ? ' — ' + critCount + ' critical' : '') +
        (highCount ? ', ' + highCount + ' high-severity' : '') + '.';

    return { events: events, summary: summary };
  }

  // ── render ─────────────────────────────────────────────────────────────────
  function render(report, containerEl) {
    containerEl.innerHTML = '';

    var header = document.createElement('div');
    header.className = 'anom-header';
    var dot = report.events.length === 0 ? 'anom-dot-ok' :
              report.events.some(function (e) { return e.severity === 'critical'; }) ? 'anom-dot-crit' :
              report.events.some(function (e) { return e.severity === 'high'; })     ? 'anom-dot-high' : 'anom-dot-med';
    header.innerHTML = '<span class="anom-dot ' + dot + '"></span><span class="anom-summary">' + escHtml(report.summary) + '</span>';
    containerEl.appendChild(header);

    if (!report.events.length) return;

    var timeline = document.createElement('div');
    timeline.className = 'anom-timeline';

    report.events.forEach(function (ev) {
      var item = document.createElement('div');
      item.className = 'anom-item anom-sev-' + ev.severity;
      item.dataset.rowIndex = ev.rowIndex || 0;

      var badge = document.createElement('span');
      badge.className = 'anom-badge';
      badge.textContent = ev.label;

      var desc = document.createElement('span');
      desc.className = 'anom-desc';
      desc.textContent = ev.description;

      var row = document.createElement('span');
      row.className = 'anom-row-ref';
      if (ev.rowIndex != null) row.textContent = 'Row ' + (ev.rowIndex + 1);

      item.appendChild(badge);
      item.appendChild(desc);
      item.appendChild(row);
      timeline.appendChild(item);
    });

    containerEl.appendChild(timeline);
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { detect: detect, render: render };
})();
