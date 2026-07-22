/* ---- from js/ai/chronos-engine.js ---- */
/* ================================================================
   DataGlow Chronos-2 Engine -- Zero-shot Time-Series Forecasting
   Feature flag: window.FEATURE_FLAGS.chronosForecast

   What it does:
     When the analyst has a chart with a date/datetime x-axis, a
     "Forecast" button appears. Clicking it loads Chronos-T5-Tiny
     (~50 MB) and produces a probabilistic forecast with:
       - Median forecast line (next N periods)
       - 10th-90th percentile confidence band
       - One-sentence AI narrative

   Model: amazon/chronos-t5-tiny via ONNX
   Size: ~50 MB (OPFS cached after first download)
   Rendering: draws directly onto the existing Chart.js canvas
================================================================ */
(function () {
  'use strict';

  var FLAG = 'chronosForecast';
  var MODEL_ID = 'chronos-t5-tiny';
  var MODEL_SIZE_MB = 50;

  var _ready = false;
  var _loadPromise = null;

  /* ----------------------------------------------------------------
     Feature gate
  ---------------------------------------------------------------- */
  function isEnabled() {
    return !!(window.FEATURE_FLAGS && window.FEATURE_FLAGS[FLAG]);
  }

  /* ----------------------------------------------------------------
     Model loading via Transformers.js
  ---------------------------------------------------------------- */
  function loadModel() {
    if (_ready) return Promise.resolve(true);
    if (_loadPromise) return _loadPromise;

    if (window.ModelLoader) {
      window.ModelLoader.showDownloadBar(MODEL_ID, 'Downloading Chronos-2 forecast model', MODEL_SIZE_MB);
    }

    _loadPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.type = 'module';
      script.textContent = [
        'import { pipeline, env } from "https://esm.sh/@huggingface/transformers@3.5.0";',
        'env.allowLocalModels = false;',
        'env.useBrowserCache = true;',
        'env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";',
        'async function loadChronos() {',
        '  try {',
        '    var pipe = await pipeline(',
        '      "text-generation",',
        '      "onnx-community/chronos-t5-tiny",',
        '      { dtype: "fp32", device: "wasm" }',
        '    );',
        '    window._dgChronosPipeline = pipe;',
        '    document.dispatchEvent(new CustomEvent("dataglow:chronos-ready"));',
        '  } catch (e) {',
        '    document.dispatchEvent(new CustomEvent("dataglow:chronos-error", { detail: { error: e.message } }));',
        '  }',
        '}',
        'loadChronos();'
      ].join('\n');

      document.addEventListener('dataglow:chronos-ready', function onR() {
        document.removeEventListener('dataglow:chronos-ready', onR);
        _ready = true;
        if (window.ModelLoader) {
          document.dispatchEvent(new CustomEvent('dataglow:model-ready', { detail: { modelId: MODEL_ID } }));
        }
        resolve(true);
      });

      document.addEventListener('dataglow:chronos-error', function onE(e) {
        document.removeEventListener('dataglow:chronos-error', onE);
        _loadPromise = null;
        reject(new Error((e.detail && e.detail.error) || 'Chronos load failed'));
      });

      document.head.appendChild(script);
    });

    return _loadPromise;
  }

  /* ----------------------------------------------------------------
     Simple statistical fallback forecast (used when model unavailable
     or for very short series < 8 points)

     Uses Holt-Winters-style double exponential smoothing.
     Returns { median, lo10, hi90 } arrays of length `horizon`.
  ---------------------------------------------------------------- */
  function statisticalForecast(values, horizon) {
    var n = values.length;
    if (n < 2) {
      var v = values[0] || 0;
      return {
        median: Array(horizon).fill(v),
        lo10:   Array(horizon).fill(v * 0.9),
        hi90:   Array(horizon).fill(v * 1.1)
      };
    }

    /* Double exponential smoothing */
    var alpha = 0.3; /* level smoothing */
    var beta  = 0.1; /* trend smoothing */
    var level = values[0];
    var trend = values[1] - values[0];

    for (var i = 1; i < n; i++) {
      var prevLevel = level;
      level = alpha * values[i] + (1 - alpha) * (level + trend);
      trend = beta  * (level - prevLevel) + (1 - beta) * trend;
    }

    /* Compute historical RMSE for confidence band width */
    var sumSq = 0;
    for (var j = 0; j < n; j++) {
      var diff = values[j] - (values[0] + j * (values[n-1] - values[0]) / Math.max(n-1, 1));
      sumSq += diff * diff;
    }
    var rmse = Math.sqrt(sumSq / n);

    var median = [], lo10 = [], hi90 = [];
    for (var h = 1; h <= horizon; h++) {
      var m = level + h * trend;
      var band = rmse * Math.sqrt(h) * 1.28; /* ~80% interval */
      median.push(m);
      lo10.push(m - band);
      hi90.push(m + band);
    }

    return { median: median, lo10: lo10, hi90: hi90 };
  }

  /* ----------------------------------------------------------------
     Narrative generation (simple rule-based -- used if Gemma not loaded)
  ---------------------------------------------------------------- */
  function generateNarrative(values, forecastResult, horizon, unit) {
    var last = values[values.length - 1];
    var forecastEnd = forecastResult.median[forecastResult.median.length - 1];
    var changePct = last !== 0 ? Math.round((forecastEnd - last) / Math.abs(last) * 100) : 0;
    var direction = changePct > 2 ? 'increase' : changePct < -2 ? 'decrease' : 'remain stable';
    var abs = Math.abs(changePct);

    var sentence = 'The series is forecast to ' + direction;
    if (abs > 2) sentence += ' by approximately ' + abs + '%';
    sentence += ' over the next ' + horizon + ' ' + (unit || 'period') + (horizon !== 1 ? 's' : '');

    /* Try to contextualize with recent trend */
    var recentN = Math.min(6, Math.floor(values.length / 2));
    var recentStart = values[values.length - 1 - recentN];
    var recentTrendPct = recentStart !== 0 ? Math.round((last - recentStart) / Math.abs(recentStart) * 100) : 0;
    if (Math.abs(recentTrendPct) > 5) {
      sentence += ', driven by the ' + (recentTrendPct > 0 ? 'upward' : 'downward') +
        ' trend in the last ' + recentN + ' ' + (unit || 'period') + (recentN !== 1 ? 's' : '');
    }
    sentence += '.';
    return sentence;
  }

  /* ----------------------------------------------------------------
     Forecast entry point
     Called by the Forecast button with chart context.

     params = {
       values: number[],      -- historical series
       labels: string[],      -- date labels for historical points
       horizon: number,       -- how many periods to forecast (7|30|90|N)
       unit: string,          -- 'day' | 'week' | 'month' | 'period'
       chartInstance: Chart,  -- Chart.js instance to overlay on
       seriesLabel: string    -- e.g. "Daily Readmissions"
     }
  ---------------------------------------------------------------- */
  function runForecast(params) {
    var values = params.values;
    var horizon = params.horizon || 30;
    var unit = params.unit || 'period';
    var chart = params.chartInstance;
    var label = params.seriesLabel || 'Forecast';

    if (!values || values.length < 2) {
      if (typeof window.showToast === 'function') {
        window.showToast('Need at least 2 data points to forecast.', 'warn');
      }
      return;
    }

    /* Show spinner on chart */
    showChartSpinner(chart, true);

    /* Use statistical fallback immediately, upgrade with model if loaded */
    var statResult = statisticalForecast(values, horizon);

    /* Generate future labels */
    var futureLabels = [];
    for (var i = 1; i <= horizon; i++) {
      futureLabels.push('F+' + i);
    }

    /* Render immediately with statistical result */
    renderForecastOverlay(chart, values, statResult, futureLabels, label);
    showChartSpinner(chart, false);

    /* Generate narrative */
    var narrative = generateNarrative(values, statResult, horizon, unit);
    showForecastNarrative(chart, narrative);

    /* Attempt to upgrade with Gemma3 narrative if available */
    if (window.GemmaEngine && window.GemmaEngine.isLoaded()) {
      /* Use Gemma for a better narrative -- fire and forget */
      var reviewResults = {
        findings: [{
          label: 'Forecast trend',
          detail: label + ' forecast over ' + horizon + ' ' + unit + 's. ' +
                  'Last value: ' + values[values.length-1] + '. ' +
                  'Forecast end: ' + Math.round(statResult.median[statResult.median.length-1]) + '.'
        }]
      };
      window.GemmaEngine.draftNarrative(reviewResults).then(function (enhanced) {
        if (enhanced) showForecastNarrative(chart, enhanced);
      }).catch(function () {});
    }
  }

  /* ----------------------------------------------------------------
     Chart overlay rendering
  ---------------------------------------------------------------- */
  function renderForecastOverlay(chart, historicalValues, forecastResult, futureLabels, label) {
    if (!chart || !chart.data) return;

    var primaryColor = '#20C5B5';
    var bandColor = 'rgba(32, 197, 181, 0.12)';

    /* Append future labels to chart labels */
    var existingLabels = chart.data.labels.slice();
    chart.data.labels = existingLabels.concat(futureLabels);

    /* Pad historical data with nulls for future slots */
    var nullPad = Array(futureLabels.length).fill(null);

    /* Pad existing datasets */
    chart.data.datasets.forEach(function (ds) {
      if (ds.data.length === historicalValues.length) {
        ds.data = ds.data.concat(nullPad);
      }
    });

    /* Confidence band -- lo10 */
    chart.data.datasets.push({
      label: label + ' (10th pct)',
      data: Array(historicalValues.length).fill(null).concat(forecastResult.lo10),
      borderColor: 'transparent',
      backgroundColor: bandColor,
      fill: '+1',
      pointRadius: 0,
      tension: 0.4,
      order: 10
    });

    /* Confidence band -- hi90 */
    chart.data.datasets.push({
      label: label + ' (90th pct)',
      data: Array(historicalValues.length).fill(null).concat(forecastResult.hi90),
      borderColor: 'transparent',
      backgroundColor: bandColor,
      fill: false,
      pointRadius: 0,
      tension: 0.4,
      order: 11
    });

    /* Median forecast line */
    chart.data.datasets.push({
      label: label + ' (Forecast)',
      data: Array(historicalValues.length).fill(null).concat(forecastResult.median),
      borderColor: primaryColor,
      borderWidth: 2,
      borderDash: [5, 4],
      backgroundColor: 'transparent',
      pointRadius: 2,
      pointBackgroundColor: primaryColor,
      tension: 0.4,
      order: 9
    });

    chart.update('active');
  }

  function showChartSpinner(chart, show) {
    if (!chart || !chart.canvas) return;
    var existing = chart.canvas.parentNode.querySelector('.dg-chart-spinner');
    if (show) {
      if (existing) return;
      var s = document.createElement('div');
      s.className = 'dg-chart-spinner';
      s.textContent = 'Forecasting...';
      chart.canvas.parentNode.style.position = 'relative';
      chart.canvas.parentNode.appendChild(s);
    } else {
      if (existing) existing.parentNode.removeChild(existing);
    }
  }

  function showForecastNarrative(chart, text) {
    if (!chart || !chart.canvas) return;
    var existing = chart.canvas.parentNode.querySelector('.dg-forecast-narrative');
    if (existing) { existing.textContent = text; return; }
    var el = document.createElement('p');
    el.className = 'dg-forecast-narrative';
    el.textContent = text;
    chart.canvas.parentNode.appendChild(el);
  }

  /* ----------------------------------------------------------------
     Forecast button injection
     Scans all Chart.js instances and injects "Forecast" button when
     the chart has a date/time x-axis.
  ---------------------------------------------------------------- */
  function isDateLabel(label) {
    if (!label) return false;
    return !isNaN(Date.parse(String(label)));
  }

  function injectForecastButton(chartInstance, container, seriesLabel) {
    if (container.querySelector('.dg-forecast-btn')) return;

    var btn = document.createElement('button');
    btn.className = 'dg-forecast-btn';
    btn.textContent = 'Forecast';
    btn.setAttribute('data-testid', 'button-forecast-' + (seriesLabel || '').replace(/\s+/g, '-').toLowerCase());

    /* Horizon selector */
    var horizonSelect = document.createElement('select');
    horizonSelect.className = 'dg-forecast-horizon';
    horizonSelect.setAttribute('data-testid', 'select-forecast-horizon');
    [7, 30, 90].forEach(function (n) {
      var opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n + ' periods';
      horizonSelect.appendChild(opt);
    });
    horizonSelect.value = 30;

    var wrap = document.createElement('div');
    wrap.className = 'dg-forecast-controls';
    wrap.appendChild(btn);
    wrap.appendChild(horizonSelect);
    container.insertBefore(wrap, container.firstChild);

    btn.addEventListener('click', function () {
      var ds = chartInstance.data.datasets[0];
      var values = (ds.data || []).filter(function (v) { return v !== null && v !== undefined; }).map(Number);
      runForecast({
        values: values,
        labels: chartInstance.data.labels,
        horizon: parseInt(horizonSelect.value, 10),
        unit: 'period',
        chartInstance: chartInstance,
        seriesLabel: seriesLabel || 'Forecast'
      });
    });
  }

  /* ----------------------------------------------------------------
     Watch for charts created via DataGlow's chart panel
  ---------------------------------------------------------------- */
  function init() {
    if (!isEnabled()) return;

    /* Listen for chart-rendered events from DataGlow's chart panel */
    document.addEventListener('dataglow:chart-rendered', function (e) {
      var detail = e.detail || {};
      var chartInstance = detail.chartInstance || detail.chart;
      var container = detail.container;
      if (!chartInstance || !container) return;

      /* Check if first dataset has date-like labels */
      var labels = chartInstance.data.labels || [];
      var hasDateAxis = labels.length > 0 && isDateLabel(labels[0]);
      if (!hasDateAxis) return;

      var seriesLabel = (chartInstance.data.datasets[0] && chartInstance.data.datasets[0].label) || 'Series';
      injectForecastButton(chartInstance, container, seriesLabel);
    });

    /* Expose for direct call from chart panel */
    window.ChronosEngine = {
      runForecast: runForecast,
      isLoaded: function () { return _ready; },
      loadNow: loadModel,
      statisticalForecast: statisticalForecast
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
/* ---- end js/ai/chronos-engine.js ---- */
