/* DataGlow — src/js/features/replay-wiring.js */
/* Refactored from canvas/index.html */

document.addEventListener('dataglow:dataset-loaded', function (e) {
    var ds = (e && e.detail && e.detail.dataset) || (typeof window.getActiveDataset === 'function' ? window.getActiveDataset() : null);
    if (!ds) return;
    record('dataset_load', {
      name: ds.name || 'dataset',
      rowCount: ds.rows ? ds.rows.length : null,
      colCount: ds.columns ? ds.columns.length : null
    });
  });

  document.addEventListener('click', function (e) {
    var runBtn = e.target && e.target.closest ? e.target.closest('#sql-view-run') : null;
    if (runBtn) {
      setTimeout(function () {
        var statusEl = $id('sql-view-status');
        var queryEl = $id('sql-view-input');
        var rowCount = null;
        if (statusEl && statusEl.textContent) {
          var m = statusEl.textContent.match(/(\d[\d,]*)/);
          if (m) rowCount = parseInt(m[1].replace(/,/g, ''), 10);
        }
        record('sql_run', {
          query: queryEl ? (queryEl.value || '').slice(0, 200) : '',
          rowCount: rowCount
        });
      }, 500);
      return;
    }
    var pill = e.target && e.target.closest ? e.target.closest('.analyze-pill') : null;
    if (pill) {
      record('panel_switch', {
        panel: pill.getAttribute('data-panel') || pill.textContent.trim()
      });
    }
  });

  var _origQuestionShow = window.QuestionPrompter && window.QuestionPrompter.show;
  if (window.QuestionPrompter && typeof _origQuestionShow === 'function') {
    window.QuestionPrompter.show = function (ds) {
      var result = _origQuestionShow.apply(this, arguments);
      record('question_asked', {
        question: ds && ds.name ? ('Questions for ' + ds.name) : 'Questions drawer opened'
      });
      return result;
    };
  }
})();
/* ============================================================
   M6 AUTOPILOT ENGINE - background data watchdog (Batch 12)
   Monitors loaded datasets on an interval and on load; surfaces
   anomalies, quality issues, and drift in a persistent alert feed.
   ============================================================ */
(function () {
  var CHECK_INTERVAL_MS = 30000;
  var alertIdCounter = 1;

  var autopilot = {
    isActive: false,
    alerts: [],
    lastSnapshot: {},
    _timer: null,

    enable: function () {
      if (autopilot._timer) { return; }
      autopilot.isActive = true;
      autopilot._timer = setInterval(autopilot.runCheck, CHECK_INTERVAL_MS);
      updateTriggerDot();
    },

    disable: function () {
      if (autopilot._timer) {
        clearInterval(autopilot._timer);
        autopilot._timer = null;
      }
      autopilot.isActive = false;
      updateTriggerDot();
    },

    runCheck: function () {
      var datasets = getDatasets();
      if (!datasets.length) {
        autopilot.disable();
        return;
      }
      var newAlerts = [];
      for (var i = 0; i < datasets.length; i++) {
        newAlerts = newAlerts.concat(checkDataset(datasets[i]));
      }
      if (newAlerts.length) {
        for (var j = 0; j < newAlerts.length; j++) {
          autopilot.alerts.unshift(newAlerts[j]);
        }
        renderFeed();
        updateTriggerDot();

        var criticalCount = 0;
        for (var k = 0; k < newAlerts.length; k++) {
          if (newAlerts[k].severity === 'critical') { criticalCount++; }
        }
        if (criticalCount > 0 && window.LevelSystem && typeof window.LevelSystem.addXP === 'function') {

        }
        if (window.DataGlowMirror && typeof window.DataGlowMirror.observe === 'function') {
          window.DataGlowMirror.observe('autopilot_check', { alertCount: newAlerts.length });
        }
        if (window.DataGlowReplay && window.DataGlowReplay.isRecording && typeof window.DataGlowReplay.record === 'function') {
          var worstSeverity = 'info';
          for (var m = 0; m < newAlerts.length; m++) {
            if (newAlerts[m].severity === 'critical') { worstSeverity = 'critical'; break; }
            if (newAlerts[m].severity === 'warn' && worstSeverity !== 'critical') { worstSeverity = 'warn'; }
          }
          window.DataGlowReplay.record('autopilot_alert', { count: newAlerts.length, severity: worstSeverity });
        }
      }
      updateLastChecked();
    },

    dismiss: function (alertId) {
      for (var i = 0; i < autopilot.alerts.length; i++) {
        if (autopilot.alerts[i].id === alertId) {
          autopilot.alerts[i].dismissed = true;
          break;
        }
      }
      renderFeed();
      updateTriggerDot();
    },

    clearAll: function () {
      autopilot.alerts = [];
      renderFeed();
      updateTriggerDot();
    },

    getUnread: function () {
      return autopilot.alerts.filter(function (a) { return !a.dismissed; });
    },

    openPanel: function () {
      var panel = document.getElementById('autopilot-panel');
      if (!panel) { return; }
      panel.classList.remove('hidden');
      panel.classList.add('open');
      renderFeed();
    },

    closePanel: function () {
      var panel = document.getElementById('autopilot-panel');
      if (!panel) { return; }
      panel.classList.remove('open');
    }
  };

  function getDatasets() {
    if (window.state && window.state.datasets) { return window.state.datasets; }
    return [];
  }

  function makeAlert(datasetName, type, severity, message) {
    return {
      id: 'ap-' + (alertIdCounter++),
      datasetName: datasetName,
      type: type,
      severity: severity,
      message: message,
      detectedAt: Date.now(),
      dismissed: false
    };
  }

  function computeColumnStats(dataset) {
    var columns = dataset.columns || [];
    var rows = dataset.rows || [];
    var stats = [];
    for (var c = 0; c < columns.length; c++) {
      var col = columns[c];
      var nullCount = 0;
      var uniqueSet = {};
      var uniqueCount = 0;
      var numericValues = [];
      var nonNumericCount = 0;
      for (var r = 0; r < rows.length; r++) {
        var v = rows[r][c];
        if (v === null || v === undefined || v === '') {
          nullCount++;
          continue;
        }
        var key = String(v);
        if (!uniqueSet[key]) {
          uniqueSet[key] = true;
          uniqueCount++;
        }
        if (col.type === 'INT' || col.type === 'FLOAT') {
          var num = Number(v);
          if (isNaN(num)) {
            nonNumericCount++;
          } else {
            numericValues.push(num);
          }
        }
      }
      var nullRate = rows.length ? (nullCount / rows.length) : 0;
      stats.push({
        name: col.name,
        type: col.type,
        nullRate: nullRate,
        uniqueCount: uniqueCount,
        numericValues: numericValues,
        nonNumericCount: nonNumericCount
      });
    }
    return stats;
  }

  function meanOf(arr) {
    if (!arr.length) { return 0; }
    var sum = 0;
    for (var i = 0; i < arr.length; i++) { sum += arr[i]; }
    return sum / arr.length;
  }

  function stdDevOf(arr, avg) {
    if (arr.length < 2) { return 0; }
    var sumSq = 0;
    for (var i = 0; i < arr.length; i++) {
      var diff = arr[i] - avg;
      sumSq += diff * diff;
    }
    return Math.sqrt(sumSq / arr.length);
  }

  function countDuplicateRows(rows) {
    var seen = {};
    var dupCount = 0;
    for (var i = 0; i < rows.length; i++) {
      var key = JSON.stringify(rows[i]);
      if (seen[key]) {
        dupCount++;
      } else {
        seen[key] = true;
      }
    }
    return dupCount;
  }

  function checkDataset(dataset) {
    var found = [];
    var name = dataset.name || 'Untitled dataset';
    var rows = dataset.rows || [];
    var prevSnap = autopilot.lastSnapshot[dataset.id];

    /* 7. Empty dataset */
    if (rows.length === 0) {
      found.push(makeAlert(name, 'empty_dataset', 'critical', name + ' has 0 rows after load.'));
      autopilot.lastSnapshot[dataset.id] = { nullRates: {}, cardinalities: {}, rowCount: 0 };
      return found;
    }

    var colStats = computeColumnStats(dataset);
    var nullRates = {};
    var cardinalities = {};

    for (var i = 0; i < colStats.length; i++) {
      var cs = colStats[i];
      nullRates[cs.name] = cs.nullRate;
      cardinalities[cs.name] = cs.uniqueCount;

      /* 1. Null spike */
      if (prevSnap && prevSnap.nullRates && typeof prevSnap.nullRates[cs.name] === 'number') {
        var prevRate = prevSnap.nullRates[cs.name];
        var deltaPoints = (cs.nullRate - prevRate) * 100;
        if (deltaPoints > 25) {
          found.push(makeAlert(name, 'null_spike', 'critical', 'Column "' + cs.name + '" null rate jumped ' + deltaPoints.toFixed(1) + ' points in ' + name + '.'));
        } else if (deltaPoints > 10) {
          found.push(makeAlert(name, 'null_spike', 'warn', 'Column "' + cs.name + '" null rate jumped ' + deltaPoints.toFixed(1) + ' points in ' + name + '.'));
        }
      }

      /* 2. Cardinality shift */
      if (prevSnap && prevSnap.cardinalities && typeof prevSnap.cardinalities[cs.name] === 'number' && prevSnap.cardinalities[cs.name] > 0) {
        var prevCard = prevSnap.cardinalities[cs.name];
        var pctChange = Math.abs(cs.uniqueCount - prevCard) / prevCard * 100;
        if (pctChange > 50) {
          found.push(makeAlert(name, 'cardinality_shift', 'warn', 'Column "' + cs.name + '" unique value count shifted ' + pctChange.toFixed(0) + '% in ' + name + '.'));
        } else if (pctChange > 20) {
          found.push(makeAlert(name, 'cardinality_shift', 'info', 'Column "' + cs.name + '" unique value count shifted ' + pctChange.toFixed(0) + '% in ' + name + '.'));
        }
      }

      /* 3. Numeric outlier */
      if (cs.numericValues.length > 2) {
        var avg = meanOf(cs.numericValues);
        var sd = stdDevOf(cs.numericValues, avg);
        if (sd > 0) {
          for (var v = 0; v < cs.numericValues.length; v++) {
            var zscore = Math.abs(cs.numericValues[v] - avg) / sd;
            if (zscore > 4) {
              found.push(makeAlert(name, 'numeric_outlier', 'critical', 'Column "' + cs.name + '" has a value ' + zscore.toFixed(1) + ' standard deviations from the mean in ' + name + '.'));
              break;
            }
          }
        }
      }

      /* 5. Type inconsistency */
      if ((cs.type === 'INT' || cs.type === 'FLOAT') && cs.nonNumericCount > 0) {
        found.push(makeAlert(name, 'type_inconsistency', 'critical', 'Column "' + cs.name + '" is tagged ' + cs.type + ' but has ' + cs.nonNumericCount + ' non-numeric value(s) in ' + name + '.'));
      }
    }

    /* 4. Row count change */
    if (prevSnap && typeof prevSnap.rowCount === 'number' && prevSnap.rowCount !== rows.length) {
      found.push(makeAlert(name, 'row_count_change', 'info', name + ' row count changed from ' + prevSnap.rowCount + ' to ' + rows.length + '.'));
    }

    /* 6. Duplicate rows */
    var dupCount = countDuplicateRows(rows);
    if (rows.length > 0 && (dupCount / rows.length) > 0.01) {
      found.push(makeAlert(name, 'duplicate_rows', 'warn', name + ' has ' + dupCount + ' duplicate row(s), over 1% of total rows.'));
    }

    autopilot.lastSnapshot[dataset.id] = {
      nullRates: nullRates,
      cardinalities: cardinalities,
      rowCount: rows.length
    };

    return found;
  }

  function timeAgo(ts) {
    var diffMs = Date.now() - ts;
    var diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) { return diffSec + 's ago'; }
    var diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) { return diffMin + 'm ago'; }
    var diffHour = Math.floor(diffMin / 60);
    return diffHour + 'h ago';
  }

  function severityIcon(severity) {
    if (severity === 'critical') { return '&#9679;'; }
    if (severity === 'warn') { return '&#9679;'; }
    return '&#9679;';
  }

  function renderFeed() {
    var feed = document.getElementById('autopilot-feed');
    if (!feed) { return; }
    var visible = autopilot.alerts.filter(function (a) { return !a.dismissed; });
    if (!visible.length) {
      feed.innerHTML = '<div class="autopilot-empty-state"><div class="autopilot-empty-icon">&#10003;</div><div>All clear. Autopilot is watching.</div></div>';
      return;
    }
    var html = '';
    for (var i = 0; i < visible.length; i++) {
      var a = visible[i];
      html += '<div class="autopilot-alert-card severity-' + a.severity + '" data-alert-id="' + a.id + '">';
      html += '<div class="autopilot-alert-top">';
      html += '<span class="autopilot-alert-icon severity-' + a.severity + '">' + severityIcon(a.severity) + '</span>';
      html += '<span class="autopilot-alert-message">' + escapeAutopilotHtml(a.message) + '</span>';
      html += '<button class="autopilot-alert-dismiss" data-dismiss-id="' + a.id + '" title="Dismiss">&#10005;</button>';
      html += '</div>';
      html += '<div class="autopilot-alert-meta"><span>' + escapeAutopilotHtml(a.datasetName) + '</span><span>' + timeAgo(a.detectedAt) + '</span></div>';
      html += '</div>';
    }
    feed.innerHTML = html;

    var dismissBtns = feed.querySelectorAll('[data-dismiss-id]');
    for (var j = 0; j < dismissBtns.length; j++) {
      dismissBtns[j].addEventListener('click', function (e) {
        var id = e.currentTarget.getAttribute('data-dismiss-id');
        autopilot.dismiss(id);
      });
    }
  }

  function escapeAutopilotHtml(str) {
    var div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
  }

  function updateTriggerDot() {
    var dot = document.getElementById('autopilot-dot');
    if (!dot) { return; }
    var hasCritical = autopilot.alerts.some(function (a) { return !a.dismissed && a.severity === 'critical'; });
    dot.classList.remove('is-critical', 'is-paused');
    if (!autopilot.isActive) {
      dot.classList.add('is-paused');
    } else if (hasCritical) {
      dot.classList.add('is-critical');
    }
  }

  function updateLastChecked() {
    var el = document.getElementById('autopilot-last-checked');
    if (!el) { return; }
    var now = new Date();
    var hh = now.getHours();
    var mm = now.getMinutes();
    var mmStr = mm < 10 ? ('0' + mm) : String(mm);
    var ampm = hh >= 12 ? 'PM' : 'AM';
    var hh12 = hh % 12;
    if (hh12 === 0) { hh12 = 12; }
    el.textContent = 'Checked at ' + hh12 + ':' + mmStr + ' ' + ampm;
  }

  function wireUi() {
    var triggerBtn = document.getElementById('autopilot-trigger-btn');
    var closeBtn = document.getElementById('autopilot-close-btn');
    var clearBtn = document.getElementById('autopilot-clear-btn');
    var toggleInput = document.getElementById('autopilot-toggle-input');

    if (triggerBtn) {
      triggerBtn.addEventListener('click', function () {
        autopilot.openPanel();
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        autopilot.closePanel();
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        autopilot.clearAll();
      });
    }
    if (toggleInput) {
      toggleInput.addEventListener('change', function (e) {
        if (e.target.checked) {
          autopilot.enable();
          if (getDatasets().length) { autopilot.runCheck(); }
        } else {
          autopilot.disable();
        }
      });
    }
  }

  function onDatasetLoaded() {
    var toggleInput = document.getElementById('autopilot-toggle-input');
    var wantsActive = !toggleInput || toggleInput.checked;
    if (wantsActive) {
      autopilot.enable();
      autopilot.runCheck();
    }
  }

  document.addEventListener('dataglow:dataset-loaded', onDatasetLoaded);

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(wireUi, 0);
  } else {
    document.addEventListener('DOMContentLoaded', wireUi);
  }

  window.DataGlowAutopilot = {
    isActive: false,
    alerts: autopilot.alerts,
    lastSnapshot: autopilot.lastSnapshot,
    enable: autopilot.enable,
    disable: autopilot.disable,
    runCheck: autopilot.runCheck,
    dismiss: autopilot.dismiss,
    clearAll: autopilot.clearAll,
    getUnread: autopilot.getUnread,
    openPanel: autopilot.openPanel,
    closePanel: autopilot.closePanel
  };

  Object.defineProperty(window.DataGlowAutopilot, 'isActive', {
    get: function () { return autopilot.isActive; }
  });
  Object.defineProperty(window.DataGlowAutopilot, 'alerts', {
    get: function () { return autopilot.alerts; }
  });
  Object.defineProperty(window.DataGlowAutopilot, 'lastSnapshot', {
    get: function () { return autopilot.lastSnapshot; }
  });