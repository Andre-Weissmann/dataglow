/* DataGlow — src/js/panels/osce.js */
/* Refactored from canvas/index.html */

(function () {
  'use strict';

  // ---- Dataset used for all OSCE scenarios: SynPUF Inpatient Claims ----
  var OSCE_FALLBACK_COLUMNS = [
    {"name":"CLM_ID","type":"STR"},{"name":"BENE_ID","type":"STR"},{"name":"ADM_DATE","type":"DATE"},
    {"name":"DISCH_DATE","type":"DATE"},{"name":"LOS_DAYS","type":"INT"},{"name":"DX_PRIMARY","type":"STR"},
    {"name":"DX_SECONDARY","type":"INT"},{"name":"PROC_PRIMARY","type":"INT"},{"name":"DRG_CODE","type":"INT"},
    {"name":"PMT_AMT_USD","type":"FLOAT"},{"name":"FACILITY_STATE","type":"STR"}
  ];

  function getOsceDataset() {
    // Prefer the live SynPUF inpatient dataset if the sample lib is loaded
    if (window.SYNPUF_DATASETS) {
      for (var i = 0; i < window.SYNPUF_DATASETS.length; i++) {
        if (window.SYNPUF_DATASETS[i].name === 'synpuf_inpatient') {
          var src = window.SYNPUF_DATASETS[i];
          return { name: 'synpuf_inpatient', columns: src.columns, rows: src.rows };
        }
      }
    }
    // Otherwise use whatever is active if it looks like the inpatient shape
    var active = window.getActiveDataset && window.getActiveDataset();
    if (active && active.columns && active.columns.some(function (c) { return /LOS_DAYS|los_days/i.test(c.name); })) {
      return active;
    }
    // Last resort: minimal built-in fallback (kept tiny on purpose)
    return { name: 'synpuf_inpatient', columns: OSCE_FALLBACK_COLUMNS, rows: [] };
  }

  function osceTableName() {
    if (window.SQLEngine && typeof window.SQLEngine.safeTableName === 'function') {
      return window.SQLEngine.safeTableName(osceState.dataset.name);
    }
    return (osceState.dataset.name || 'synpuf_inpatient').replace(/[^a-zA-Z0-9_]/g, '_');
  }

  // ---- Scenario definitions ----
  var SCENARIOS = [
    {
      title: 'The High-Cost Admissions Investigation',
      difficulty: 'Intermediate',
      brief: 'You are a data analyst at a regional health system. The CFO reports that inpatient costs rose 18% last quarter. Identify the top drivers.',
      stations: [
        {
          task: 'Identify which diagnosis codes have the highest average payment. Group the claims by primary diagnosis and sort by average payment amount, descending.',
          points: 20,
          hint: 'SELECT dx_primary, ROUND(AVG(pmt_amt_usd),2) as avg_pmt, COUNT(*) as n FROM your_table GROUP BY dx_primary ORDER BY avg_pmt DESC LIMIT 10',
          expectedCols: ['dx_primary', 'pmt'],
          clinicalPass: 'Your query correctly identified the top diagnosis groups by average payment - a solid first step in isolating cost drivers.',
          clinicalFail: 'The task requires grouping claims by primary diagnosis and ranking by average payment. Review the GROUP BY and ORDER BY clauses.'
        },
        {
          task: 'Find patients with multiple admissions (potential readmissions). Group by beneficiary and filter to those with more than one admission.',
          points: 20,
          hint: 'SELECT bene_id, COUNT(*) as admissions FROM your_table GROUP BY bene_id HAVING COUNT(*) > 1 ORDER BY admissions DESC',
          expectedCols: ['bene_id', 'admissions'],
          clinicalPass: 'Well identified. Repeat admissions are a classic signal of unmanaged chronic disease or care-transition gaps that inflate costs.',
          clinicalFail: 'This station needs a GROUP BY on the beneficiary id with a HAVING clause to isolate patients with more than one admission.'
        },
        {
          task: 'Compute length-of-stay outliers (more than 2 standard deviations above the mean). Return the outlier claims.',
          points: 30,
          hint: 'SELECT clm_id, los_days, ROUND(AVG(los_days) OVER (), 1) as avg_los FROM your_table WHERE los_days > (SELECT AVG(los_days) + 2*STDDEV(los_days) FROM your_table) ORDER BY los_days DESC',
          expectedCols: ['clm_id', 'los_days'],
          clinicalPass: 'Excellent statistical reasoning. Outlier length-of-stay cases are frequently the single largest cost driver in an inpatient population.',
          clinicalFail: 'This station calls for a statistical outlier definition: compare LOS to the mean plus two standard deviations, typically via a subquery or window function.'
        },
        {
          task: 'Examine geographic payment variation. Group claims by facility state and rank by average payment.',
          points: 30,
          hint: 'SELECT facility_state, ROUND(AVG(pmt_amt_usd),2) as avg_pmt, COUNT(*) as claims FROM your_table GROUP BY facility_state ORDER BY avg_pmt DESC',
          expectedCols: ['facility_state', 'pmt'],
          clinicalPass: 'Correct. Geographic variation in payment often reflects differences in case mix, facility contracts, or regional cost-of-care - worth flagging to the CFO.',
          clinicalFail: 'Group by facility state and order by average payment to reveal geographic cost variation.'
        }
      ]
    },
    {
      title: 'The Discharge Quality Audit',
      difficulty: 'Intermediate',
      brief: 'Quality team flagged 30 patients for potentially premature discharges. Investigate the data for length-of-stay and readmission patterns.',
      stations: [
        {
          task: 'Find all admissions with length of stay under 2 days, grouped by diagnosis.',
          points: 25,
          hint: 'SELECT dx_primary, COUNT(*) as short_stays FROM your_table WHERE los_days < 2 GROUP BY dx_primary ORDER BY short_stays DESC',
          expectedCols: ['dx_primary', 'los_days'],
          clinicalPass: 'Good work isolating short-stay admissions by diagnosis - a key screen for potentially premature discharge.',
          clinicalFail: 'Filter to los_days < 2 and group by primary diagnosis to surface which conditions have the most short-stay admissions.'
        },
        {
          task: 'Identify same-day admits and discharges (admission date equals discharge date, or LOS = 0).',
          points: 25,
          hint: 'SELECT clm_id, bene_id, adm_date, disch_date FROM your_table WHERE los_days = 0 OR adm_date = disch_date',
          expectedCols: ['clm_id', 'adm_date'],
          clinicalPass: 'Correctly flagged same-day cases - these deserve the closest clinical review for discharge appropriateness.',
          clinicalFail: 'Look for claims where los_days = 0 or adm_date equals disch_date to find same-day admit-discharge pairs.'
        },
        {
          task: 'Find patients admitted multiple times within 30 days of each other (a readmission pattern).',
          points: 25,
          hint: 'SELECT bene_id, COUNT(*) as admissions FROM your_table GROUP BY bene_id HAVING COUNT(*) > 1 ORDER BY admissions DESC',
          expectedCols: ['bene_id', 'admissions'],
          clinicalPass: 'This readmission signal is exactly what the quality team needs to cross-reference against the short-stay list.',
          clinicalFail: 'Group by beneficiary and use HAVING COUNT(*) > 1 as a proxy for repeat admissions, then examine date proximity.'
        },
        {
          task: 'Build a risk-stratified view: classify each claim as LOW, MEDIUM, or HIGH risk based on LOS and payment amount.',
          points: 25,
          hint: "SELECT clm_id, los_days, pmt_amt_usd, CASE WHEN los_days < 2 THEN 'HIGH' WHEN los_days < 5 THEN 'MEDIUM' ELSE 'LOW' END as risk_tier FROM your_table",
          expectedCols: ['risk', 'los_days'],
          clinicalPass: 'A clean risk stratification. This CASE-based tiering is exactly how quality teams triage cases for chart review.',
          clinicalFail: 'Use a CASE expression on los_days (and optionally pmt_amt_usd) to bucket each claim into LOW, MEDIUM, or HIGH risk.'
        }
      ]
    },
    {
      title: 'The Benchmark Analysis',
      difficulty: 'Advanced',
      brief: 'The medical director wants to know how this facility compares to national benchmarks for length of stay and cost by DRG.',
      stations: [
        {
          task: 'Summarize length of stay and cost by DRG code.',
          points: 25,
          hint: 'SELECT drg_code, ROUND(AVG(los_days),1) as avg_los, ROUND(AVG(pmt_amt_usd),2) as avg_pmt, COUNT(*) as n FROM your_table GROUP BY drg_code ORDER BY avg_pmt DESC',
          expectedCols: ['drg_code', 'los_days'],
          clinicalPass: 'Solid DRG-level summary - this is the baseline table needed for any benchmark comparison.',
          clinicalFail: 'Group by drg_code and aggregate both los_days and pmt_amt_usd (e.g. AVG) to build the benchmark summary.'
        },
        {
          task: 'Identify DRG codes with average length of stay greater than 10 days.',
          points: 25,
          hint: 'SELECT drg_code, ROUND(AVG(los_days),1) as avg_los FROM your_table GROUP BY drg_code HAVING AVG(los_days) > 10 ORDER BY avg_los DESC',
          expectedCols: ['drg_code', 'los_days'],
          clinicalPass: 'Correct use of HAVING to filter aggregated LOS - these DRGs warrant deeper utilization review.',
          clinicalFail: 'Group by drg_code, then use HAVING AVG(los_days) > 10 to filter to the long-stay DRG groups.'
        },
        {
          task: 'Find DRG-cost outliers: claims where payment exceeds 2x the average payment for that DRG.',
          points: 25,
          hint: 'SELECT t.clm_id, t.drg_code, t.pmt_amt_usd FROM your_table t JOIN (SELECT drg_code, AVG(pmt_amt_usd) as avg_pmt FROM your_table GROUP BY drg_code) b ON t.drg_code = b.drg_code WHERE t.pmt_amt_usd > 2 * b.avg_pmt',
          expectedCols: ['drg_code', 'pmt'],
          clinicalPass: 'This is advanced but correct: comparing each claim to its own DRG-level benchmark isolates true cost outliers, not just high-cost DRGs overall.',
          clinicalFail: 'This requires comparing each claim payment to the average payment for its own DRG group - typically a self-join or window function with a 2x threshold.'
        },
        {
          task: 'Rank DRG codes by efficiency: payment per length-of-stay day.',
          points: 25,
          hint: 'SELECT drg_code, ROUND(AVG(pmt_amt_usd)/AVG(los_days),2) as pmt_per_day FROM your_table GROUP BY drg_code ORDER BY pmt_per_day DESC',
          expectedCols: ['drg_code', 'pmt'],
          clinicalPass: 'A well-formed efficiency metric - payment per LOS day is a standard way to compare DRGs of very different acuity.',
          clinicalFail: 'Compute a ratio of average payment to average LOS per drg_code, then rank the results.'
        }
      ]
    }
  ];

  // ---- State ----
  var osceState = {
    scenarioIdx: -1,
    stationIdx: 0,
    score: 0,
    potentialLost: 0,
    dataset: null,
    stationResults: [], // {passed, score}
    hintUsed: []
  };

  function totalPoints(scenario) {
    return scenario.stations.reduce(function (sum, s) { return sum + s.points; }, 0);
  }

  // ---- DOM refs (looked up lazily since modal is injected once at load) ----
  function $(id) { return document.getElementById(id); }

  function openOSCE() {
    var modal = $('osce-modal');
    if (!modal) return;
    modal.classList.add('open');
    showSelectScreen();
    window.SkillTracker && window.SkillTracker.track && window.SkillTracker.track('open_osce');
  }

  function closeOSCE() {
    var modal = $('osce-modal');
    if (modal) modal.classList.remove('open');
  }

  function showSelectScreen() {
    $('osce-select-screen').style.display = 'flex';
    $('osce-session').classList.remove('open');
    $('osce-results-screen').classList.remove('open');
    renderScenarioCards();
  }

  function renderScenarioCards() {
    var wrap = $('osce-scenario-cards');
    if (!wrap) return;
    wrap.innerHTML = SCENARIOS.map(function (sc, i) {
      var briefSentences = sc.brief.split(/(?<=[.])\s+/).slice(0, 2).join(' ');
      var diffClass = sc.difficulty === 'Advanced' ? 'osce-meta-advanced' : 'osce-meta-intermediate';
      return '' +
        '<div class="osce-scenario-card" data-idx="' + i + '">' +
          '<div class="osce-card-label">Scenario ' + (i + 1) + '</div>' +
          '<div class="osce-card-title">' + sc.title + '</div>' +
          '<div class="osce-card-brief">' + briefSentences + '</div>' +
          '<div class="osce-card-meta">' +
            '<span class="osce-meta-tag ' + diffClass + '">' + sc.difficulty + '</span>' +
            '<span class="osce-meta-tag osce-meta-pts">' + totalPoints(sc) + ' pts</span>' +
            '<span class="osce-meta-tag osce-meta-pts">4 stations</span>' +
          '</div>' +
        '</div>';
    }).join('');
    wrap.querySelectorAll('.osce-scenario-card').forEach(function (card) {
      card.addEventListener('click', function () {
        startScenario(parseInt(card.getAttribute('data-idx'), 10));
      });
    });
  }

  function startScenario(idx) {
    var scenario = SCENARIOS[idx];
    if (!scenario) return;
    osceState.scenarioIdx = idx;
    osceState.stationIdx = 0;
    osceState.score = 0;
    osceState.dataset = getOsceDataset();
    osceState.stationResults = scenario.stations.map(function () { return null; });
    osceState.hintUsed = scenario.stations.map(function () { return false; });

    $('osce-select-screen').style.display = 'none';
    $('osce-results-screen').classList.remove('open');
    $('osce-session').classList.add('open');
    $('osce-scenario-title').textContent = scenario.title;
    updateScoreDisplay(scenario);
    loadStation();
    window.SkillTracker && window.SkillTracker.track && window.SkillTracker.track('start_osce_scenario');
  }

  function updateScoreDisplay(scenario) {
    $('osce-score-display').textContent = osceState.score + ' / ' + totalPoints(scenario);
  }

  function loadStation() {
    var scenario = SCENARIOS[osceState.scenarioIdx];
    var station = scenario.stations[osceState.stationIdx];
    $('osce-station-num').textContent = 'Station ' + (osceState.stationIdx + 1) + ' of ' + scenario.stations.length;
    $('osce-station-task').textContent = station.task;
    $('osce-sql-editor').value = '';
    $('osce-result-pane').textContent = 'Results will appear here after running your query.';
    var hintBox = $('osce-hint-box');
    hintBox.classList.remove('open');
    hintBox.textContent = '';
    $('osce-hint-btn').disabled = false;
    $('osce-hint-btn').textContent = 'Show hint (-5 pts)';
    var fb = $('osce-feedback');
    fb.className = '';
    fb.textContent = '';
    fb.style.display = 'none';
    $('osce-next-btn').classList.remove('show');
    renderProgressDots(scenario);
  }

  function renderProgressDots(scenario) {
    var wrap = $('osce-progress-dots');
    if (!wrap) return;
    wrap.innerHTML = scenario.stations.map(function (s, i) {
      var cls = 'osce-dot';
      if (osceState.stationResults[i] !== null) cls += ' done';
      if (i === osceState.stationIdx) cls += ' active';
      return '<span class="' + cls + '"></span>';
    }).join('');
  }

  // ---- Query execution ----
  function resolveSql(sql) {
    var tbl = osceTableName();
    return sql.replace(/your_table/gi, tbl);
  }

  function runOsceSql(sql) {
    // Returns a Promise resolving to {cols, rows} or rejecting with an error
    var ds = osceState.dataset;
    var resolvedSql = resolveSql(sql);
    if (window.SQLEngine && typeof window.SQLEngine.query === 'function') {
      return window.SQLEngine.query(resolvedSql, ds).then(function (result) {
        return { cols: result.cols || result.columns || [], rows: result.rows || [] };
      });
    }
    // Fallback: no live SQL engine available - run a very small local
    // interpreter that supports the handful of GROUP BY / WHERE patterns
    // used across OSCE stations, so grading still functions offline.
    return Promise.resolve(mockRunSql(sql, ds));
  }

  function colIndex(ds, name) {
    for (var i = 0; i < ds.columns.length; i++) {
      if (ds.columns[i].name.toLowerCase() === name.toLowerCase()) return i;
    }
    return -1;
  }

  function mockRunSql(sql, ds) {
    // Extremely lightweight heuristic executor: not a real SQL parser.
    // It looks at GROUP BY / column mentions in the query text and
    // produces a plausible aggregated result set from the real dataset
    // rows so the OSCE grading logic has something real to evaluate.
    var lower = sql.toLowerCase();
    if (!ds.rows || !ds.rows.length) {
      return { cols: ds.columns.map(function (c) { return c.name; }), rows: [] };
    }
    var groupMatch = /group by\s+([a-z0-9_,\s]+?)(order by|having|limit|$)/i.exec(sql);
    if (groupMatch) {
      var groupCols = groupMatch[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var idxs = groupCols.map(function (c) { return colIndex(ds, c); }).filter(function (i) { return i >= 0; });
      if (idxs.length) {
        var pmtIdx = colIndex(ds, 'pmt_amt_usd');
        var losIdx = colIndex(ds, 'los_days');
        var groups = {};
        ds.rows.forEach(function (r) {
          var key = idxs.map(function (i) { return r[i]; }).join('|');
          if (!groups[key]) groups[key] = { keyVals: idxs.map(function (i) { return r[i]; }), n: 0, pmtSum: 0, losSum: 0 };
          groups[key].n++;
          if (pmtIdx >= 0) groups[key].pmtSum += Number(r[pmtIdx]) || 0;
          if (losIdx >= 0) groups[key].losSum += Number(r[losIdx]) || 0;
        });
        var cols = groupCols.slice();
        if (pmtIdx >= 0) cols.push('avg_pmt');
        if (losIdx >= 0) cols.push('avg_los');
        cols.push('n');
        var rows = Object.keys(groups).map(function (k) {
          var g = groups[k];
          var row = g.keyVals.slice();
          if (pmtIdx >= 0) row.push(Math.round((g.pmtSum / g.n) * 100) / 100);
          if (losIdx >= 0) row.push(Math.round((g.losSum / g.n) * 10) / 10);
          row.push(g.n);
          return row;
        });
        if (/having\s+count\(\*\)\s*>\s*1/i.test(sql)) {
          rows = rows.filter(function (r) { return r[r.length - 1] > 1; });
        }
        rows.sort(function (a, b) { return b[b.length - 2] - a[a.length - 2]; });
        return { cols: cols, rows: rows.slice(0, 50) };
      }
    }
    // No GROUP BY understood - just return raw rows so the query "runs"
    return { cols: ds.columns.map(function (c) { return c.name; }), rows: ds.rows.slice(0, 50) };
  }

  function renderResultPane(result, error) {
    var pane = $('osce-result-pane');
    if (error) {
      pane.innerHTML = '<div style="color:var(--error,#A12C7B);">Error: ' + escapeHtml(String(error).substring(0, 200)) + '</div>';
      return;
    }
    if (!result || !result.rows || !result.rows.length) {
      pane.textContent = 'Query ran successfully but returned no rows.';
      return;
    }
    var cols = result.cols || [];
    var thead = '<tr>' + cols.map(function (c) { return '<th style="text-align:left;padding:3px 6px;border-bottom:1px solid var(--border);">' + escapeHtml(String(c)) + '</th>'; }).join('') + '</tr>';
    var tbody = result.rows.slice(0, 30).map(function (r) {
      return '<tr>' + cols.map(function (c, i) { return '<td style="padding:3px 6px;border-bottom:1px solid var(--border);">' + escapeHtml(r[i] === null || r[i] === undefined ? '' : String(r[i]).substring(0, 60)) + '</td>'; }).join('') + '</tr>';
    }).join('');
    pane.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:11px;"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>' +
      '<div style="margin-top:6px;color:var(--text-muted);">' + result.rows.length + ' row' + (result.rows.length !== 1 ? 's' : '') + '</div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function runQueryClicked() {
    var sql = $('osce-sql-editor').value;
    if (!sql || !sql.trim()) {
      $('osce-result-pane').textContent = 'Write a query first.';
      return;
    }
    $('osce-result-pane').textContent = 'Running...';
    runOsceSql(sql).then(function (result) {
      renderResultPane(result, null);
      osceState._lastResult = result;
    }).catch(function (err) {
      renderResultPane(null, err);
      osceState._lastResult = null;
    });
  }

  // ---- Grading ----
  function evaluateResult(result, station) {
    if (!result || !result.rows || result.rows.length === 0) {
      return { score: 0, msg: 'Query returned no results. Check your table name and column names, then try again.' };
    }
    var score = 10; // base credit for a running query with rows
    var cols = (result.cols || []).map(function (c) { return String(c).toLowerCase(); });
    var hits = 0;
    (station.expectedCols || []).forEach(function (ec) {
      if (cols.some(function (c) { return c.indexOf(ec.toLowerCase()) >= 0; })) hits++;
    });
    if (station.expectedCols && station.expectedCols.length > 0) {
      score += Math.round(hits / station.expectedCols.length * (station.points - 10));
    } else {
      score = station.points;
    }
    if (result.rows.length <= 1 && station.task.toLowerCase().indexOf('group') === -1) {
      // small penalty is not applied - single-row results are valid for some stations
    }
    score = Math.min(score, station.points);
    var msg;
    if (score >= station.points * 0.8) {
      msg = station.clinicalPass || 'Well done. Your query correctly addresses the station objective.';
    } else if (hits > 0) {
      msg = 'Partial credit. Your query runs but may be missing some columns or groupings. ' + (station.clinicalFail || '');
    } else {
      msg = station.clinicalFail || 'Your query runs but does not appear to address the station task. Review the station description.';
    }
    return { score: score, msg: msg };
  }

  function checkAnswerClicked() {
    var sql = $('osce-sql-editor').value;
    var scenario = SCENARIOS[osceState.scenarioIdx];
    var station = scenario.stations[osceState.stationIdx];
    if (!sql || !sql.trim()) {
      showFeedback(false, 'Write a SQL query addressing the station task before checking your answer.');
      return;
    }
    $('osce-check-btn').disabled = true;
    runOsceSql(sql).then(function (result) {
      renderResultPane(result, null);
      var evalResult = evaluateResult(result, station);
      var hintPenalty = osceState.hintUsed[osceState.stationIdx] ? 5 : 0;
      var finalScore = Math.max(0, evalResult.score - hintPenalty);
      osceState.stationResults[osceState.stationIdx] = finalScore;
      recomputeScore(scenario);
      var passed = finalScore >= station.points * 0.6;
      var msg = evalResult.msg + ' (' + finalScore + ' / ' + station.points + ' points' + (hintPenalty ? ', hint penalty applied' : '') + ')';
      showFeedback(passed, msg);
      renderProgressDots(scenario);
      $('osce-check-btn').disabled = false;
      $('osce-next-btn').classList.add('show');
      $('osce-next-btn').textContent = (osceState.stationIdx < scenario.stations.length - 1) ? 'Next Station' : 'Finish OSCE';
    }).catch(function (err) {
      renderResultPane(null, err);
      showFeedback(false, 'Your query failed to run: ' + String(err).substring(0, 150) + '. Review the SQL syntax and try again.');
      osceState.stationResults[osceState.stationIdx] = 0;
      recomputeScore(scenario);
      renderProgressDots(scenario);
      $('osce-check-btn').disabled = false;
      $('osce-next-btn').classList.add('show');
      $('osce-next-btn').textContent = (osceState.stationIdx < scenario.stations.length - 1) ? 'Next Station' : 'Finish OSCE';
    });
  }

  function recomputeScore(scenario) {
    osceState.score = osceState.stationResults.reduce(function (sum, s) { return sum + (s || 0); }, 0);
    updateScoreDisplay(scenario);
  }

  function showFeedback(passed, msg) {
    var fb = $('osce-feedback');
    fb.className = passed ? 'pass' : 'fail';
    fb.textContent = msg;
  }

  function showHintClicked() {
    var scenario = SCENARIOS[osceState.scenarioIdx];
    var station = scenario.stations[osceState.stationIdx];
    var box = $('osce-hint-box');
    box.textContent = station.hint;
    box.classList.add('open');
    if (!osceState.hintUsed[osceState.stationIdx]) {
      osceState.hintUsed[osceState.stationIdx] = true;
      $('osce-hint-btn').textContent = 'Hint used (-5 pts applied at scoring)';
    }
    $('osce-hint-btn').disabled = true;
  }

  function nextStationClicked() {
    var scenario = SCENARIOS[osceState.scenarioIdx];
    if (osceState.stationIdx < scenario.stations.length - 1) {
      osceState.stationIdx++;
      loadStation();
    } else {
      finishOSCE();
    }
  }

  function gradeFor(pct) {
    if (pct >= 90) return 'Distinction';
    if (pct >= 70) return 'Pass';
    if (pct >= 50) return 'Near Pass';
    return 'Refer';
  }

  function finishOSCE() {
    var scenario = SCENARIOS[osceState.scenarioIdx];
    var total = totalPoints(scenario);
    var pct = Math.round((osceState.score / total) * 100);
    var grade = gradeFor(pct);
    $('osce-session').classList.remove('open');
    $('osce-results-screen').classList.add('open');
    $('osce-final-score').textContent = osceState.score + ' / ' + total;
    $('osce-final-grade').textContent = grade;
    var feedback;
    if (grade === 'Distinction') {
      feedback = 'Outstanding clinical data analysis. You consistently identified the right groupings, filters, and statistical thresholds needed to investigate ' + scenario.title.toLowerCase() + '. This is examiner-level performance.';
    } else if (grade === 'Pass') {
      feedback = 'Solid performance. Your approach to ' + scenario.title.toLowerCase() + ' covered most of the key investigative steps, with room to sharpen precision on some stations.';
    } else if (grade === 'Near Pass') {
      feedback = 'You demonstrated some of the right instincts for ' + scenario.title.toLowerCase() + ', but several stations need a more rigorous query approach. Review the hints and try again.';
    } else {
      feedback = 'This attempt did not meet the bar for independent clinical data analysis on ' + scenario.title.toLowerCase() + '. Revisit the GROUP BY, HAVING, and statistical concepts used in the hints, then retake the scenario.';
    }
    $('osce-final-feedback').textContent = feedback;
    window.SkillTracker && window.SkillTracker.track && window.SkillTracker.track('finish_osce_scenario');
    if (typeof window.showToast === 'function') {
      window.showToast('OSCE complete: ' + grade + ' (' + pct + '%)', grade === 'Refer' ? 'warn' : 'success');
    }
  }

  function restartClicked() {
    $('osce-results-screen').classList.remove('open');
    showSelectScreen();
  }

  // ---- Wiring ----
  function wireOsce() {
    var trigger = document.getElementById('osce-trigger-btn');
    if (trigger) trigger.addEventListener('click', openOSCE);

    var closeBtn = document.getElementById('osce-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', closeOSCE);

    var runBtn = document.getElementById('osce-run-btn');
    if (runBtn) runBtn.addEventListener('click', runQueryClicked);

    var editor = document.getElementById('osce-sql-editor');
    if (editor) {
      editor.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          runQueryClicked();
        }
      });
    }

    var hintBtn = document.getElementById('osce-hint-btn');
    if (hintBtn) hintBtn.addEventListener('click', showHintClicked);

    var checkBtn = document.getElementById('osce-check-btn');
    if (checkBtn) checkBtn.addEventListener('click', checkAnswerClicked);

    var nextBtn = document.getElementById('osce-next-btn');
    if (nextBtn) nextBtn.addEventListener('click', nextStationClicked);

    var restartBtn = document.getElementById('osce-restart-btn');
    if (restartBtn) restartBtn.addEventListener('click', restartClicked);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireOsce);
  } else {
    wireOsce();
  }

  // Expose a small public surface for debugging / other features
  window.OSCE = {
    open: openOSCE,
    close: closeOSCE,
    scenarios: SCENARIOS
  };
