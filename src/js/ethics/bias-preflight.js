/* DataGlow -- js/ethics/bias-preflight.js */
/* PR A1: Data Mirror / Bias Pre-Flight                                        */
/*                                                                             */
/* Runs a silent structural audit on every loaded dataset BEFORE the analyst   */
/* writes their first query. Surfaces signals of bias -- class imbalance,      */
/* missing-data clustering, distribution skew -- as a mirror, not a gatekeeper.*/
/* The framing: "here is what your data reflects about where it came from."    */

(function () {
  'use strict';

  /* ---- constants ---- */
  var PANEL_ID = 'dg-bias-preflight-panel';
  var TRIGGER_ID = 'dg-bias-preflight-trigger';

  /* Column name heuristics for demographic-adjacent fields */
  var DEMOGRAPHIC_TERMS = [
    'race', 'gender', 'sex', 'age', 'ethnicity', 'nationality',
    'religion', 'disability', 'income', 'education', 'zip', 'zipcode',
    'postal', 'region', 'county', 'state', 'country', 'language',
    'marital', 'veteran', 'citizen', 'birth', 'dob',
  ];

  var IMBALANCE_THRESHOLD = 0.70; /* >70% in one category = imbalance signal */
  var MISSING_CLUSTER_THRESHOLD = 0.25; /* >25% null in a column = missing signal */

  /* ---- analysis engine ---- */
  function runPreflight(dataset) {
    if (!dataset || !dataset.columns || !dataset.rows) return null;

    var cols = dataset.columns;
    var rows = dataset.rows;
    var n = rows.length;
    if (n === 0) return null;

    var findings = [];
    var score = 100; /* starts clean, deductions per finding */

    /* --- B1: Class imbalance in categorical columns --- */
    cols.forEach(function (col, ci) {
      if (col.type !== 'STR') return;
      var freq = {};
      var nonNull = 0;
      rows.forEach(function (r) {
        var v = r[ci];
        if (v === null || v === undefined || v === '') return;
        nonNull++;
        var key = String(v).trim();
        freq[key] = (freq[key] || 0) + 1;
      });
      if (nonNull < 5) return;
      var keys = Object.keys(freq);
      if (keys.length < 2 || keys.length > 30) return; /* skip high-cardinality */
      var maxCount = Math.max.apply(null, keys.map(function (k) { return freq[k]; }));
      var ratio = maxCount / nonNull;
      if (ratio >= IMBALANCE_THRESHOLD) {
        var topVal = keys.find(function (k) { return freq[k] === maxCount; });
        var severity = ratio >= 0.90 ? 'high' : 'moderate';
        findings.push({
          type: 'class_imbalance',
          severity: severity,
          column: col.name,
          detail: '"' + topVal + '" accounts for ' + Math.round(ratio * 100) + '% of ' + col.name,
          impact: 'A model trained on this column will be biased toward "' + topVal + '".',
        });
        score -= severity === 'high' ? 20 : 10;
      }
    });

    /* --- B2: Missing data clustering by demographic-adjacent columns --- */
    var demoCols = cols.filter(function (c) {
      var lower = c.name.toLowerCase();
      return DEMOGRAPHIC_TERMS.some(function (t) { return lower.indexOf(t) !== -1; });
    });

    cols.forEach(function (col, ci) {
      var nullRate = rows.filter(function (r) {
        var v = r[ci];
        return v === null || v === undefined || v === '';
      }).length / n;

      if (nullRate < MISSING_CLUSTER_THRESHOLD) return;

      /* Check if nulls cluster by a demographic column */
      demoCols.forEach(function (dCol) {
        var di = cols.indexOf(dCol);
        if (di === ci) return;
        var nullsByDemo = {};
        var totalByDemo = {};
        rows.forEach(function (r) {
          var dv = r[di] !== null && r[di] !== undefined && r[di] !== '' ? String(r[di]).trim() : '__null__';
          totalByDemo[dv] = (totalByDemo[dv] || 0) + 1;
          var isNull = r[ci] === null || r[ci] === undefined || r[ci] === '';
          if (isNull) nullsByDemo[dv] = (nullsByDemo[dv] || 0) + 1;
        });
        /* Find the demo group with highest null rate */
        var groups = Object.keys(totalByDemo).filter(function (k) { return k !== '__null__' && totalByDemo[k] >= 5; });
        var worst = groups.reduce(function (acc, g) {
          var rate = (nullsByDemo[g] || 0) / totalByDemo[g];
          return rate > acc.rate ? { g: g, rate: rate } : acc;
        }, { g: null, rate: 0 });
        var overall = nullRate;
        if (worst.g && worst.rate > overall * 1.4) {
          findings.push({
            type: 'missing_cluster',
            severity: worst.rate > 0.5 ? 'high' : 'moderate',
            column: col.name,
            demoColumn: dCol.name,
            detail: col.name + ' is ' + Math.round(worst.rate * 100) + '% null for ' + dCol.name + '="' + worst.g + '" (overall: ' + Math.round(overall * 100) + '%)',
            impact: 'Missing data is not random -- it clusters around a demographic group.',
          });
          score -= worst.rate > 0.5 ? 18 : 8;
        }
      });
    });

    /* --- B3: Distribution skew in numeric columns --- */
    cols.forEach(function (col, ci) {
      if (col.type !== 'INT' && col.type !== 'FLOAT') return;
      var vals = rows.map(function (r) {
        var v = r[ci];
        return v !== null && v !== undefined && v !== '' ? parseFloat(v) : null;
      }).filter(function (v) { return v !== null && isFinite(v); });

      if (vals.length < 20) return;
      vals.sort(function (a, b) { return a - b; });
      var mean = vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
      var variance = vals.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / vals.length;
      var std = Math.sqrt(variance);
      if (std === 0) return;
      /* Pearson skewness approximation */
      var med = vals[Math.floor(vals.length / 2)];
      var skew = (mean - med) / std;
      var absSkew = Math.abs(skew);
      if (absSkew > 1.0) {
        var dir = skew > 0 ? 'right-skewed (long tail of high values)' : 'left-skewed (long tail of low values)';
        findings.push({
          type: 'distribution_skew',
          severity: absSkew > 2.0 ? 'high' : 'moderate',
          column: col.name,
          detail: col.name + ' is ' + dir + ' (skew ' + skew.toFixed(2) + ')',
          impact: 'Summary statistics will misrepresent typical values. Subgroup analysis may amplify this.',
        });
        score -= absSkew > 2.0 ? 12 : 6;
      }
    });

    /* --- B4: Overall null burden --- */
    var totalCells = n * cols.length;
    var totalNulls = 0;
    cols.forEach(function (col, ci) {
      rows.forEach(function (r) {
        if (r[ci] === null || r[ci] === undefined || r[ci] === '') totalNulls++;
      });
    });
    var nullBurden = totalNulls / totalCells;
    if (nullBurden > 0.15) {
      findings.push({
        type: 'null_burden',
        severity: nullBurden > 0.3 ? 'high' : 'moderate',
        column: 'dataset-wide',
        detail: Math.round(nullBurden * 100) + '% of all cells are empty',
        impact: 'High overall missingness reduces representativeness.',
      });
      score -= nullBurden > 0.3 ? 15 : 8;
    }

    score = Math.max(0, score);
    var grade = score >= 80 ? 'CLEAN' : score >= 60 ? 'REVIEW' : score >= 40 ? 'CAUTION' : 'CONCERN';
    var gradeColor = score >= 80 ? '#4AE38A' : score >= 60 ? '#20C5B5' : score >= 40 ? '#F5A623' : '#D163A7';

    return {
      datasetId: dataset.id,
      datasetName: dataset.name,
      rowCount: n,
      colCount: cols.length,
      findings: findings,
      score: score,
      grade: grade,
      gradeColor: gradeColor,
      ranAt: Date.now(),
    };
  }

  /* ---- UI panel ---- */
  function _buildTrigger(result) {
    var existing = document.getElementById(TRIGGER_ID);
    if (existing) existing.remove();

    var trigger = document.createElement('div');
    trigger.id = TRIGGER_ID;
    trigger.style.cssText = [
      'position:fixed;bottom:72px;right:20px;z-index:7500;',
      'display:flex;align-items:center;gap:8px;',
      'background:#131519;border:1px solid ' + result.gradeColor + '40;',
      'border-radius:24px;padding:8px 14px 8px 10px;cursor:pointer;',
      'font-family:\'Geist Mono\',monospace;font-size:11px;',
      'box-shadow:0 4px 20px rgba(0,0,0,0.4);transition:all 0.15s;',
      'max-width:220px;',
    ].join('');

    var icon = result.findings.length === 0
      ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#4AE38A" stroke-width="1.2"/><path d="M5 8l2 2 4-4" stroke="#4AE38A" stroke-width="1.2" stroke-linecap="round"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2L2 13h12L8 2z" stroke="' + result.gradeColor + '" stroke-width="1.2"/><path d="M8 7v3" stroke="' + result.gradeColor + '" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.5" fill="' + result.gradeColor + '"/></svg>';

    trigger.innerHTML = [
      icon,
      '<span style="color:' + result.gradeColor + ';font-weight:600;">DATA MIRROR</span>',
      '<span style="color:#5A5957;">' + result.findings.length + ' signal' + (result.findings.length !== 1 ? 's' : '') + '</span>',
    ].join('');

    trigger.addEventListener('click', function () { _showPanel(result); });
    trigger.addEventListener('mouseenter', function () { trigger.style.borderColor = result.gradeColor; });
    trigger.addEventListener('mouseleave', function () { trigger.style.borderColor = result.gradeColor + '40'; });

    document.body.appendChild(trigger);
  }

  function _severityColor(s) {
    return s === 'high' ? '#D163A7' : s === 'moderate' ? '#F5A623' : '#20C5B5';
  }

  function _typeLabel(t) {
    return {
      class_imbalance: 'Class Imbalance',
      missing_cluster: 'Missing Data Cluster',
      distribution_skew: 'Distribution Skew',
      null_burden: 'Null Burden',
    }[t] || t;
  }

  function _showPanel(result) {
    var existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); return; }

    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed;bottom:116px;right:20px;z-index:7600;',
      'width:min(400px,92vw);background:#131519;',
      'border:1px solid #252930;border-radius:16px;',
      'font-family:\'Geist Mono\',monospace;',
      'box-shadow:0 8px 40px rgba(0,0,0,0.5);',
      'overflow:hidden;',
    ].join('');

    var empty = result.findings.length === 0;

    panel.innerHTML = [
      /* header */
      '<div style="padding:16px 20px;border-bottom:1px solid #252930;display:flex;align-items:center;gap:10px;">',
      '  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">',
      '    <rect x="1" y="1" width="14" height="14" rx="2" stroke="#20C5B5" stroke-width="1.2"/>',
      '    <path d="M4 8h8M4 5h5M4 11h6" stroke="#20C5B5" stroke-width="1.2" stroke-linecap="round"/>',
      '  </svg>',
      '  <span style="color:#CDCCCA;font-size:12px;font-weight:600;letter-spacing:0.08em;">DATA MIRROR</span>',
      '  <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">',
      '    <span style="color:' + result.gradeColor + ';font-size:13px;font-weight:700;">' + result.score + '</span>',
      '    <span style="color:' + result.gradeColor + ';font-size:10px;font-weight:600;',
      '      background:' + result.gradeColor + '18;padding:2px 8px;border-radius:10px;">' + result.grade + '</span>',
      '  </div>',
      '</div>',
      /* meta */
      '<div style="padding:12px 20px;border-bottom:1px solid #252930;display:flex;gap:20px;">',
      '  <div style="font-size:11px;color:#5A5957;">',
      '    <div style="color:#797876;margin-bottom:2px;">' + result.rowCount.toLocaleString() + ' rows</div>',
      '    <div>' + result.colCount + ' columns</div>',
      '  </div>',
      '  <div style="font-size:11px;color:#5A5957;flex:1;">',
      '    <div style="color:#797876;margin-bottom:2px;">Pre-flight ran before your first query.</div>',
      '    <div>This is a mirror -- not a verdict.</div>',
      '  </div>',
      '</div>',
      /* findings */
      '<div style="max-height:320px;overflow-y:auto;padding:12px 20px;display:flex;flex-direction:column;gap:10px;">',
      empty
        ? '<div style="text-align:center;padding:24px;color:#4AE38A;font-size:12px;">No structural bias signals detected. Data looks representative.</div>'
        : result.findings.map(function (f) {
          return [
            '<div style="background:#0D0E10;border:1px solid #252930;border-radius:10px;padding:12px;',
            '  border-left:3px solid ' + _severityColor(f.severity) + ';">',
            '  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">',
            '    <span style="color:' + _severityColor(f.severity) + ';font-size:10px;font-weight:700;">',
            '      ' + f.severity.toUpperCase(),
            '    </span>',
            '    <span style="color:#CDCCCA;font-size:11px;">' + _typeLabel(f.type) + '</span>',
            '    <span style="color:#5A5957;font-size:10px;margin-left:auto;">' + (f.column !== 'dataset-wide' ? f.column : '') + '</span>',
            '  </div>',
            '  <div style="color:#797876;font-size:11px;margin-bottom:4px;">' + f.detail + '</div>',
            '  <div style="color:#5A5957;font-size:10px;font-style:italic;">' + f.impact + '</div>',
            '</div>',
          ].join('');
        }).join(''),
      '</div>',
      /* footer */
      '<div style="padding:12px 20px;border-top:1px solid #252930;display:flex;justify-content:space-between;align-items:center;">',
      '  <span style="color:#5A5957;font-size:10px;">Run at ' + new Date(result.ranAt).toLocaleTimeString() + '</span>',
      '  <button id="dg-bias-close" style="background:transparent;border:1px solid #252930;border-radius:6px;',
      '    padding:4px 10px;color:#797876;font-family:\'Geist Mono\',monospace;font-size:10px;cursor:pointer;">',
      '    Dismiss',
      '  </button>',
      '</div>',
    ].join('');

    document.body.appendChild(panel);
    document.getElementById('dg-bias-close').addEventListener('click', function () {
      panel.remove();
    });
  }

  /* ---- event listener ---- */
  document.addEventListener('dataglow:dataset-loaded', function (e) {
    var ds = e.detail && e.detail.dataset;
    if (!ds) return;
    if (!window.FEATURE_FLAGS || !window.FEATURE_FLAGS.biasPreflight) return;

    /* Run async so it doesn't block the load event chain */
    setTimeout(function () {
      var result = runPreflight(ds);
      if (!result) return;

      /* Store result for passport use */
      window._dgLastBiasPreflight = result;

      /* Surface trigger pill */
      _buildTrigger(result);

      /* Emit event for other modules (passport, pulse) */
      document.dispatchEvent(new CustomEvent('dataglow:bias-preflight-complete', {
        detail: { result: result }
      }));

      /* High-severity findings get a toast nudge */
      var highCount = result.findings.filter(function (f) { return f.severity === 'high'; }).length;
      if (highCount > 0 && window.showToast) {
        window.showToast(
          'Data Mirror found ' + highCount + ' high-severity signal' + (highCount > 1 ? 's' : '') + ' -- check before analysis.',
          4000
        );
      }
    }, 1200);
  });

  /* ---- export API ---- */
  window.BiasPreflight = {
    run: runPreflight,
  };

})();
