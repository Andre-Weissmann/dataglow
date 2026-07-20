/* DataGlow — src/js/features/replay-engine.js */
/* Refactored from canvas/index.html */

(function () {
  var replayState = {
    isRecording: false,
    startedAt: null,
    steps: []
  };

  var ACTION_ICONS = {
    dataset_load: '\uD83D\uDCC2',
    panel_switch: '\uD83D\uDD00',
    sql_run: '\uD83D\uDD0D',
    chart_view: '\uD83D\uDCCA',
    question_asked: '\u2753',
    peer_review_run: '\uD83E\uDD1D',
    note_saved: '\uD83D\uDCDD',
    export_done: '\uD83D\uDCE4'
  };

  var NARRATIVE_TEMPLATES = {
    dataset_load: function (d) {
      return 'Loaded ' + (d.name || 'a dataset') + ' (' + (d.rowCount != null ? d.rowCount : '?') + ' rows, ' + (d.colCount != null ? d.colCount : '?') + ' columns).';
    },
    panel_switch: function (d) {
      return 'Switched to the ' + (d.panel || 'a') + ' panel.';
    },
    sql_run: function (d) {
      return 'Ran a SQL query' + (d.rowCount != null ? ' and got ' + d.rowCount + ' rows back' : '') + '.';
    },
    chart_view: function (d) {
      return 'Viewed a ' + (d.chartType || '') + ' chart' + (d.columns && d.columns.length ? ' using ' + d.columns.join(', ') : '') + '.';
    },
    question_asked: function (d) {
      return 'Asked an analytical question' + (d.question ? (': ' + d.question) : '') + '.';
    },
    peer_review_run: function (d) {
      return 'Ran a peer review, scoring ' + (d.score != null ? d.score : '?') + ' with ' + (d.findingCount != null ? d.findingCount : '?') + ' findings.';
    },
    note_saved: function (d) {
      return 'Saved a note (' + (d.length != null ? d.length : '?') + ' characters).';
    },
    export_done: function (d) {
      return 'Exported results as ' + (d.format || 'a file') + '.';
    }
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function describeStep(step) {
    var tpl = NARRATIVE_TEMPLATES[step.action];
    if (tpl) {
      try { return tpl(step.details || {}); } catch (e) { /* fall through */ }
    }
    return step.action.replace(/_/g, ' ');
  }

  function start() {
    replayState.isRecording = true;
    replayState.startedAt = Date.now();
    replayState.steps = [];
    updateTriggerBtnUI();
    updateModalUI();
    if (typeof window.showToast === 'function') {
      window.showToast('Session recording started', 'info');
    }
  }

  function stop() {
    replayState.isRecording = false;
    updateTriggerBtnUI();
    updateModalUI();
    if (typeof window.showToast === 'function') {
      window.showToast('Session recording stopped', 'info');
    }
  }

  function record(action, details) {
    if (!replayState.isRecording) return null;
    var step = {
      action: action,
      details: details || {},
      timestamp: Date.now()
    };
    replayState.steps.push(step);
    updateModalUI();
    return step;
  }

  function getSession() {
    return {
      startedAt: replayState.startedAt,
      steps: replayState.steps.slice()
    };
  }

  function exportJSON() {
    var payload = {
      startedAt: replayState.startedAt,
      exportedAt: nowIso(),
      steps: replayState.steps
    };
    var json = JSON.stringify(payload, null, 2);
    try {
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'dataglow-session-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 300);
    } catch (e) {
      if (typeof window.showToast === 'function') {
        window.showToast('Could not export session JSON', 'error');
      }
    }
    return json;
  }

  function buildTemplateNarrative() {
    if (!replayState.steps.length) {
      return 'No steps recorded yet. Start recording to capture your analysis session.';
    }
    var lines = [];
    replayState.steps.forEach(function (step, i) {
      lines.push('Step ' + (i + 1) + ': ' + describeStep(step));
    });
    return lines.join('\n');
  }

  function exportNarrative() {
    return new Promise(function (resolve) {
      if (!replayState.steps.length) {
        resolve('No steps recorded yet. Start recording to capture your analysis session.');
        return;
      }
      if (window.BrowserLLM && typeof window.BrowserLLM.isReady === 'function' && window.BrowserLLM.isReady()) {
        var summary = replayState.steps.map(function (step, i) {
          return (i + 1) + '. ' + step.action.replace(/_/g, ' ') + ' - ' + JSON.stringify(step.details || {});
        }).join('\n');
        var prompt = 'A data analyst had a DataGlow session with these recorded steps:\n' + summary + '\n' +
          'Write a short, clear narrative (3-6 sentences) describing what they did, in past tense, as if summarizing their analysis session for a colleague. No preamble, no markdown.';
        window.BrowserLLM.generate(prompt, { maxTokens: 220, temperature: 0.5 })
          .then(function (text) {
            if (text && text.trim()) {
              resolve(text.trim());
            } else {
              resolve(buildTemplateNarrative());
            }
          })
          .catch(function () {
            resolve(buildTemplateNarrative());
          });
      } else {
        resolve(buildTemplateNarrative());
      }
    });
  }

  window.DataGlowReplay = {
    isRecording: false,
    start: start,
    stop: stop,
    record: record,
    getSession: getSession,
    exportJSON: exportJSON,
    exportNarrative: exportNarrative
  };

  function syncPublicFlag() {
    window.DataGlowReplay.isRecording = replayState.isRecording;
  }