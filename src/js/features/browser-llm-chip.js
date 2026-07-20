/* DataGlow — src/js/features/browser-llm-chip.js */
/* Refactored from canvas/index.html */

var BrowserLLM = (function() {
  'use strict';

  var _engine = null;
  var _loading = false;
  var _ready = false;
  var _queue = [];
  var _modelId = 'Phi-3.5-mini-instruct-q4f16_1-MLC';

  var WEBLLM_CDN = 'https://esm.run/@mlc-ai/web-llm@0.2.73';

  var _progressCallbacks = [];

  function onProgress(cb) { _progressCallbacks.push(cb); }

  function _emitProgress(p) {
    _progressCallbacks.forEach(function(cb) { try { cb(p); } catch(e){} });
  }

  function isWebGPUSupported() {
    return !!(navigator.gpu);
  }

  function _dynamicImport(url) {
    return new Promise(function(resolve, reject) {
      var script = document.createElement('script');
      script.type = 'module';
      var blob = new Blob([
        'import * as m from "' + url + '"; window.__webllm_module__ = m;'
      ], { type: 'application/javascript' });
      var blobUrl = URL.createObjectURL(blob);
      script.src = blobUrl;
      script.onload = function() { URL.revokeObjectURL(blobUrl); resolve(window.__webllm_module__); };
      script.onerror = function(e) { URL.revokeObjectURL(blobUrl); reject(e); };
      document.head.appendChild(script);
    });
  }

  function loadEngine() {
    if (_ready) return Promise.resolve(_engine);
    if (_loading) {
      return new Promise(function(res, rej) { _queue.push({ res: res, rej: rej }); });
    }
    _loading = true;

    if (!isWebGPUSupported()) {
      _loading = false;
      var err = new Error('WebGPU not supported in this browser');
      _queue.forEach(function(q) { q.rej(err); });
      _queue = [];
      return Promise.reject(err);
    }

    return _dynamicImport(WEBLLM_CDN).then(function(webllm) {
      return webllm.CreateMLCEngine(_modelId, {
        initProgressCallback: function(progress) {
          _emitProgress({
            type: 'loading',
            text: progress.text || 'Loading model...',
            progress: progress.progress || 0
          });
        }
      });
    }).then(function(engine) {
      _engine = engine;
      _ready = true;
      _loading = false;
      _emitProgress({ type: 'ready', text: 'Model ready' });
      _queue.forEach(function(q) { q.res(engine); });
      _queue = [];
      return engine;
    }).catch(function(err) {
      _loading = false;
      _queue.forEach(function(q) { q.rej(err); });
      _queue = [];
      throw err;
    });
  }

  function generate(prompt, opts) {
    opts = opts || {};
    return loadEngine().then(function(engine) {
      var messages = [
        { role: 'system', content: opts.system || 'You are a helpful data analyst assistant. Be concise.' },
        { role: 'user', content: prompt }
      ];
      return engine.chat.completions.create({
        messages: messages,
        max_tokens: opts.maxTokens || 300,
        temperature: opts.temperature != null ? opts.temperature : 0.3,
        stream: false
      });
    }).then(function(response) {
      return response.choices[0].message.content;
    });
  }

  function generateDataQuestions(ds) {
    if (!ds || !ds.columns) return Promise.resolve(null);
    var colNames = ds.columns.map(function(c) { return c.name + '(' + c.type + ')'; }).join(', ');
    var sampleRow = ds.rows && ds.rows[0] ? ds.rows[0].slice(0,6).join(', ') : 'N/A';
    var rowCount = ds.rows ? ds.rows.length : 0;

    var prompt = 'Dataset: ' + (ds.name || 'data') + '\n' +
      'Columns: ' + colNames + '\n' +
      'Sample row: ' + sampleRow + '\n' +
      'Row count: ' + rowCount + '\n\n' +
      'Generate 5 specific, insightful analytical questions a data analyst should ask about this dataset. ' +
      'Each question should be actionable (answerable with SQL or a chart). ' +
      'Format as a JSON array of objects with keys: "text" (the question), "category" (TREND/DISTRIBUTION/QUALITY/OUTLIER/CORRELATION), "tool" (SQL/CHARTS/STATS). ' +
      'Return ONLY the JSON array, no other text.';

    return generate(prompt, { maxTokens: 500, temperature: 0.4 }).then(function(raw) {
      try {
        var start = raw.indexOf('[');
        var end = raw.lastIndexOf(']') + 1;
        return JSON.parse(raw.slice(start, end));
      } catch(e) {
        return null;
      }
    });
  }

  function explainSQLResult(sql, rowCount, colNames) {
    var prompt = 'SQL query: ' + sql.slice(0, 300) + '\n' +
      'Result: ' + rowCount + ' rows, columns: ' + colNames.slice(0,5).join(', ') + '\n' +
      'Explain this result in 1-2 plain English sentences a business stakeholder would understand.';
    return generate(prompt, { maxTokens: 120, temperature: 0.2 });
  }

  return {
    isWebGPUSupported: isWebGPUSupported,
    isReady: function() { return _ready; },
    isLoading: function() { return _loading; },
    onProgress: onProgress,
    load: loadEngine,
    generate: generate,
    generateDataQuestions: generateDataQuestions,
    explainSQLResult: explainSQLResult
  };
})();

window.BrowserLLM = BrowserLLM;