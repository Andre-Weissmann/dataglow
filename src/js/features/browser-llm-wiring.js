/* DataGlow — js/features/browser-llm-wiring.js */
/* Part of structured refactor — see src/ directory */

(function() {
  'use strict';

  BrowserLLM.onProgress(function(p) {
    var chip = document.getElementById('llm-status-chip');
    var dot = document.getElementById('llm-status-dot');
    var txt = document.getElementById('llm-status-text');
    var fill = document.getElementById('llm-progress-fill');

    if (!chip) return;
    chip.style.display = 'flex';

    if (p.type === 'loading') {
      chip.classList.remove('hidden');
      chip.classList.remove('ready');
      if (txt) txt.textContent = p.text.slice(0,40);
      if (fill) fill.style.width = Math.round((p.progress||0)*100) + '%';
    } else if (p.type === 'ready') {
      chip.classList.add('ready');
      if (txt) txt.textContent = 'AI Ready';
      setTimeout(function() { chip.classList.add('hidden'); }, 3000);
      var ds = typeof window.getActiveDataset === 'function' ? window.getActiveDataset() : null;
      if (ds && window.QuestionPrompter) {
        BrowserLLM.generateDataQuestions(ds).then(function(qs) {
          if (qs && qs.length && window.QuestionPrompter) {
            window._llmQuestions = qs;
            if (typeof window.showToast === 'function') {
              window.showToast('AI generated ' + qs.length + ' new questions for your data', 'info');
            }
          }
        }).catch(function() {});
      }
    }
  });

  document.addEventListener('click', function(e) {
    var runBtn = e.target.closest ? e.target.closest('#sql-view-run') : null;
    if (!runBtn || !BrowserLLM.isReady()) return;
    setTimeout(function() {
      var input = document.getElementById('sql-view-input');
      if (!input || !input.value.trim()) return;
      var sql = input.value.trim();
      BrowserLLM.explainSQLResult(sql, 0, []).then(function(explanation) {
        if (explanation && typeof window.showToast === 'function') window.showToast(explanation, 'info');
      }).catch(function() {});
    }, 1500);
  });

  document.addEventListener('dataglow:dataset-loaded', function() {
    if (!BrowserLLM.isReady() && !BrowserLLM.isLoading()) {
      BrowserLLM.load().catch(function(e) {
        console.warn('BrowserLLM load failed:', e.message);
      });
    }
  }, { once: true });

  function _updateTriggerBtnState() {
    var btn = document.getElementById('llm-trigger-btn');
    if (!btn) return;
    if (BrowserLLM.isReady()) btn.title = 'Browser AI - Ready';
    else if (BrowserLLM.isLoading()) btn.title = 'Browser AI - Loading...';
    else btn.title = 'Browser AI - Click to load';
  }

  BrowserLLM.onProgress(_updateTriggerBtnState);

  document.addEventListener('click', function(e) {
    var btn = e.target.closest ? e.target.closest('#llm-trigger-btn') : null;
    if (!btn) return;
    var chip = document.getElementById('llm-status-chip');
    if (!chip) return;
    if (chip.classList.contains('hidden')) {
      chip.classList.remove('hidden');
      var txt = document.getElementById('llm-status-text');
      if (BrowserLLM.isReady()) {
        chip.classList.add('ready');
        if (txt) txt.textContent = 'AI Ready';
        setTimeout(function() { chip.classList.add('hidden'); }, 3000);
      } else if (BrowserLLM.isLoading()) {
        if (txt) txt.textContent = 'Loading model...';
      } else {
        if (!BrowserLLM.isWebGPUSupported()) {
          if (txt) txt.textContent = 'WebGPU not supported';
          setTimeout(function() { chip.classList.add('hidden'); }, 3000);
        } else {
          if (txt) txt.textContent = 'Starting AI...';
          BrowserLLM.load().catch(function(e) {
            if (txt) txt.textContent = 'AI load failed';
            console.warn('BrowserLLM load failed:', e.message);
          });
        }
      }
    } else {
      chip.classList.add('hidden');
    }
  });
