/* ---- from js/ai/gemma-engine.js ---- */
/* ================================================================
   DataGlow Gemma3 Engine -- Local AI Reflex (Session B)
   Feature flag: window.FEATURE_FLAGS.gemmaReflex

   Four reflexes:
     1. Column name repair  -- fires on file load when >20% generic headers
     2. NL-to-SQL correction -- fires when analyst edits generated SQL
     3. Narrative draft      -- fires on dataglow:peer-review-complete
     4. Schema inference     -- fires on JSON/XML/nested file load

   Model: Gemma3-1B-IT, 4-bit quantized via @huggingface/transformers
   Size: ~650 MB (OPFS cached after first download)
   Runtime: Transformers.js (WebAssembly, no GPU required)
================================================================ */
(function () {
  'use strict';

  var FLAG = 'gemmaReflex';
  var MODEL_ID = 'gemma3-1b';
  var MODEL_SIZE_MB = 650;

  /* Transformers.js pipeline handle -- lazy loaded */
  var _pipeline = null;
  var _loading = false;
  var _loadPromise = null;

  /* Reflex toggle state -- each can be disabled in Feature Settings */
  var _reflexEnabled = {
    columnRepair:  true,
    nlCorrection:  true,
    narrativeDraft: true,
    schemaInference: true
  };

  /* ----------------------------------------------------------------
     Model loading
  ---------------------------------------------------------------- */
  function isEnabled() {
    return !!(window.FEATURE_FLAGS && window.FEATURE_FLAGS[FLAG]);
  }

  function loadModel() {
    if (_loadPromise) return _loadPromise;
    if (_loading) return _loadPromise;
    _loading = true;

    /* Show download bar if not cached */
    if (window.ModelLoader) {
      window.ModelLoader.showDownloadBar(
        MODEL_ID,
        'Downloading local AI (Gemma3)',
        MODEL_SIZE_MB
      );
    }

    /* Use Transformers.js from CDN -- loaded inline in bundle */
    /* We rely on the global `transformers` object injected by the pipeline below */
    _loadPromise = new Promise(function (resolve, reject) {
      /* Dynamic import via esm.sh CDN -- runs in browser main thread */
      var script = document.createElement('script');
      script.type = 'module';
      script.textContent = [
        'import { pipeline, env } from "https://esm.sh/@huggingface/transformers@3.5.0";',
        'env.allowLocalModels = false;',
        'env.useBrowserCache = true; /* IndexedDB cache as fallback */',
        'env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";',
        'async function loadGemma() {',
        '  try {',
        '    var pipe = await pipeline(',
        '      "text-generation",',
        '      "onnx-community/gemma-3-1b-it-ONNX-GQA",',
        '      { dtype: "q4", device: "wasm" }',
        '    );',
        '    window._dgGemmaPipeline = pipe;',
        '    document.dispatchEvent(new CustomEvent("dataglow:gemma-ready"));',
        '  } catch (e) {',
        '    document.dispatchEvent(new CustomEvent("dataglow:gemma-error", { detail: { error: e.message } }));',
        '  }',
        '}',
        'loadGemma();'
      ].join('\n');

      document.addEventListener('dataglow:gemma-ready', function onReady() {
        document.removeEventListener('dataglow:gemma-ready', onReady);
        _pipeline = window._dgGemmaPipeline;
        _loading = false;
        if (window.ModelLoader) {
          document.dispatchEvent(new CustomEvent('dataglow:model-ready', { detail: { modelId: MODEL_ID } }));
        }
        resolve(_pipeline);
      });

      document.addEventListener('dataglow:gemma-error', function onErr(e) {
        document.removeEventListener('dataglow:gemma-error', onErr);
        _loading = false;
        _loadPromise = null;
        reject(new Error(e.detail && e.detail.error));
      });

      document.head.appendChild(script);
    });

    return _loadPromise;
  }

  /* ----------------------------------------------------------------
     Core inference -- short, deterministic prompts only
  ---------------------------------------------------------------- */
  function infer(prompt, maxNewTokens) {
    maxNewTokens = maxNewTokens || 80;
    return loadModel().then(function (pipe) {
      return pipe(prompt, {
        max_new_tokens: maxNewTokens,
        temperature: 0.1,     /* deterministic -- we want facts, not creativity */
        do_sample: false,
        repetition_penalty: 1.2
      }).then(function (result) {
        var raw = result && result[0] && result[0].generated_text || '';
        /* Strip the prompt prefix back out */
        var answer = raw.slice(prompt.length).trim();
        /* Remove any trailing partial sentence */
        var lastPeriod = Math.max(answer.lastIndexOf('.'), answer.lastIndexOf('!'), answer.lastIndexOf('?'));
        if (lastPeriod > answer.length * 0.5) answer = answer.slice(0, lastPeriod + 1);
        return answer;
      });
    });
  }

  /* ----------------------------------------------------------------
     REFLEX 1: Column name repair
     Fires on dataglow:dataset-loaded when >20% of columns are generic.
     Generic = matches /^(col_?\d+|column\d+|unnamed[_\d]*|var_?\d+|field\d*)$/i
  ---------------------------------------------------------------- */
  var GENERIC_PATTERN = /^(col_?\d+|column\d+|unnamed[_\d]*|var_?\d+|field\d*|f\d+)$/i;

  function isGenericName(name) {
    return GENERIC_PATTERN.test(name.trim());
  }

  function sampleValues(col, dataset, n) {
    n = n || 5;
    var vals = [];
    for (var i = 0; i < Math.min(dataset.rows.length, n * 3); i++) {
      var v = dataset.rows[i][col.index !== undefined ? col.index : dataset.columns.indexOf(col)];
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        vals.push(String(v).trim());
        if (vals.length >= n) break;
      }
    }
    return vals;
  }

  function repairColumnNames(dataset) {
    if (!isEnabled() || !_reflexEnabled.columnRepair) return;
    if (!dataset || !dataset.columns) return;

    var genericCols = dataset.columns.filter(function (c) { return isGenericName(c.name); });
    var genericRatio = genericCols.length / dataset.columns.length;
    if (genericRatio < 0.2) return; /* threshold: 20% generic */

    /* Build a compact prompt for all generic columns at once */
    var colDescriptions = genericCols.map(function (col, idx) {
      var samples = sampleValues(col, dataset, 5);
      return (idx + 1) + '. Current name: "' + col.name + '" | Type: ' + (col.type || 'unknown') + ' | Sample values: ' + samples.join(', ');
    }).join('\n');

    var prompt = [
      '<start_of_turn>user',
      'You are a data analyst. Below are columns from a CSV file with generic names. Infer the best semantic column name for each based on its data type and sample values. Respond with ONLY a numbered list matching the input. One name per line. No explanations.',
      '',
      colDescriptions,
      '<end_of_turn>',
      '<start_of_turn>model'
    ].join('\n');

    infer(prompt, 120).then(function (response) {
      /* Parse numbered list -- "1. patient_id\n2. gender..." */
      var lines = response.split('\n').filter(function (l) { return /^\d+\./.test(l.trim()); });
      var suggestions = {};
      lines.forEach(function (line, i) {
        if (genericCols[i]) {
          var name = line.replace(/^\d+\.\s*/, '').trim()
            .replace(/[^a-z0-9_]/gi, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .toLowerCase();
          if (name) suggestions[genericCols[i].name] = name;
        }
      });

      if (Object.keys(suggestions).length === 0) return;

      /* Show non-intrusive suggestion toast with accept/dismiss */
      showColumnRepairSuggestion(suggestions, dataset);
    }).catch(function (err) {
      console.warn('[Gemma3] Column repair failed:', err);
    });
  }

  function showColumnRepairSuggestion(suggestions, dataset) {
    var count = Object.keys(suggestions).length;
    var msg = 'AI detected ' + count + ' column name' + (count > 1 ? 's' : '') + ' to repair.';

    if (typeof window.showToast === 'function') {
      window.showToast(msg + ' Accept?', 'info', 0, function () {
        /* Accept: apply renames */
        applyColumnRenames(suggestions, dataset);
      });
    } else {
      /* Fallback: always apply if no toast system */
      applyColumnRenames(suggestions, dataset);
    }
  }

  function applyColumnRenames(suggestions, dataset) {
    dataset.columns.forEach(function (col) {
      if (suggestions[col.name]) {
        col.originalName = col.name;
        col.name = suggestions[col.name];
      }
    });
    /* Notify grid to re-render headers */
    document.dispatchEvent(new CustomEvent('dataglow:columns-renamed', { detail: { dataset: dataset } }));
    if (typeof window.showToast === 'function') {
      window.showToast('Column names updated.', 'success');
    }
  }

  /* ----------------------------------------------------------------
     REFLEX 2: NL-to-SQL correction
     Fires when analyst manually edits a generated SQL query.
     Suggests a corrected NL phrasing for the edited query.
  ---------------------------------------------------------------- */
  function suggestNlCorrection(originalNl, generatedSql, editedSql) {
    if (!isEnabled() || !_reflexEnabled.nlCorrection) return Promise.resolve(null);
    if (originalNl === editedSql || !editedSql.trim()) return Promise.resolve(null);

    var prompt = [
      '<start_of_turn>user',
      'A user asked: "' + originalNl + '"',
      'The system generated this SQL:',
      generatedSql,
      'The user corrected it to:',
      editedSql,
      'Write a one-sentence plain-English query that would produce the corrected SQL. Be concise.',
      '<end_of_turn>',
      '<start_of_turn>model'
    ].join('\n');

    return infer(prompt, 60).then(function (suggestion) {
      return suggestion || null;
    }).catch(function () { return null; });
  }

  /* ----------------------------------------------------------------
     REFLEX 3: Narrative draft
     Fires on dataglow:peer-review-complete.
     Returns a plain-English finding summary.
  ---------------------------------------------------------------- */
  function draftNarrative(reviewResults) {
    if (!isEnabled() || !_reflexEnabled.narrativeDraft) return Promise.resolve(null);
    if (!reviewResults || !reviewResults.findings) return Promise.resolve(null);

    var findings = reviewResults.findings.slice(0, 6).map(function (f, i) {
      return (i + 1) + '. ' + (f.label || f.type || 'Issue') + ': ' + (f.detail || f.value || '');
    }).join('\n');

    var prompt = [
      '<start_of_turn>user',
      'Write a 2-3 sentence plain-English data quality summary for an analyst. Use specific numbers where provided. Do not use bullet points.',
      '',
      'Findings:',
      findings,
      '<end_of_turn>',
      '<start_of_turn>model'
    ].join('\n');

    return infer(prompt, 120).catch(function () { return null; });
  }

  /* ----------------------------------------------------------------
     REFLEX 4: Schema inference
     Fires on dataglow:json-file-loaded with raw JSON/nested data.
     Proposes column names and types for a flat schema.
  ---------------------------------------------------------------- */
  function inferSchema(rawSample) {
    if (!isEnabled() || !_reflexEnabled.schemaInference) return Promise.resolve(null);
    if (!rawSample) return Promise.resolve(null);

    /* Truncate sample to keep prompt short */
    var sampleStr = JSON.stringify(rawSample).slice(0, 600);

    var prompt = [
      '<start_of_turn>user',
      'Given this JSON data sample, propose a flat relational schema. List each column as: name | type (INT/FLOAT/STR/DATE/BOOL). One column per line. No explanations.',
      '',
      sampleStr,
      '<end_of_turn>',
      '<start_of_turn>model'
    ].join('\n');

    return infer(prompt, 100).then(function (response) {
      /* Parse "name | type" lines */
      var cols = [];
      response.split('\n').forEach(function (line) {
        var parts = line.split('|');
        if (parts.length >= 2) {
          var name = parts[0].trim().toLowerCase().replace(/\s+/g, '_');
          var type = parts[1].trim().toUpperCase();
          if (name && ['INT','FLOAT','STR','DATE','BOOL'].indexOf(type) >= 0) {
            cols.push({ name: name, type: type });
          }
        }
      });
      return cols.length ? cols : null;
    }).catch(function () { return null; });
  }

  /* ----------------------------------------------------------------
     Event wiring -- all reflexes connect to DataGlow events here
  ---------------------------------------------------------------- */
  function init() {
    if (!isEnabled()) return;

    /* Reflex 1: column repair on file load */
    document.addEventListener('dataglow:dataset-loaded', function (e) {
      if (!_reflexEnabled.columnRepair) return;
      var ds = e.detail && e.detail.dataset;
      if (!ds) {
        /* Try global */
        ds = typeof window.getActiveDataset === 'function' ? window.getActiveDataset() : null;
      }
      if (ds) {
        /* Lazy-load model only if actually needed */
        var genericCols = (ds.columns || []).filter(function (c) { return isGenericName(c.name); });
        if (genericCols.length / Math.max(ds.columns.length, 1) >= 0.2) {
          loadModel().then(function () { repairColumnNames(ds); }).catch(function () {});
        }
      }
    });

    /* Reflex 2: NL correction -- listen for SQL edit event */
    document.addEventListener('dataglow:sql-edited-after-nl', function (e) {
      if (!_reflexEnabled.nlCorrection) return;
      var d = e.detail || {};
      loadModel().then(function () {
        return suggestNlCorrection(d.originalNl, d.generatedSql, d.editedSql);
      }).then(function (suggestion) {
        if (suggestion && typeof window.showToast === 'function') {
          window.showToast('Did you mean: "' + suggestion + '"?', 'info');
        }
      }).catch(function () {});
    });

    /* Reflex 3: narrative draft on peer review complete */
    document.addEventListener('dataglow:peer-review-complete', function (e) {
      if (!_reflexEnabled.narrativeDraft) return;
      var results = e.detail && e.detail.results;
      loadModel().then(function () {
        return draftNarrative(results);
      }).then(function (narrative) {
        if (!narrative) return;
        document.dispatchEvent(new CustomEvent('dataglow:narrative-draft-ready', {
          detail: { narrative: narrative }
        }));
      }).catch(function () {});
    });

    /* Reflex 4: schema inference on JSON load */
    document.addEventListener('dataglow:json-file-loaded', function (e) {
      if (!_reflexEnabled.schemaInference) return;
      var sample = e.detail && e.detail.sample;
      loadModel().then(function () {
        return inferSchema(sample);
      }).then(function (cols) {
        if (!cols) return;
        document.dispatchEvent(new CustomEvent('dataglow:schema-suggested', { detail: { columns: cols } }));
      }).catch(function () {});
    });

    /* Expose reflex toggles for Feature Settings drawer */
    window.GemmaEngine = {
      setReflexEnabled: function (reflex, enabled) {
        if (_reflexEnabled.hasOwnProperty(reflex)) {
          _reflexEnabled[reflex] = !!enabled;
        }
      },
      getReflexState: function () { return Object.assign({}, _reflexEnabled); },
      isLoaded: function () { return _pipeline !== null; },
      loadNow: loadModel,
      draftNarrative: draftNarrative,
      inferSchema: inferSchema,
      suggestNlCorrection: suggestNlCorrection
    };
  }

  /* Init after DOM ready */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
/* ---- end js/ai/gemma-engine.js ---- */
