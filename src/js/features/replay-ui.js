/* DataGlow — src/js/features/replay-ui.js */
/* Refactored from canvas/index.html */

function $id(id) { return document.getElementById(id); }

  function updateTriggerBtnUI() {
    syncPublicFlag();
    var btn = $id('replay-trigger-btn');
    if (btn) {
      if (replayState.isRecording) {
        btn.classList.add('recording');
      } else {
        btn.classList.remove('recording');
      }
    }
    var toggle = $id('replay-record-toggle-btn');
    var label = $id('replay-record-toggle-label');
    if (toggle) {
      if (replayState.isRecording) {
        toggle.classList.add('active');
      } else {
        toggle.classList.remove('active');
      }
    }
    if (label) {
      label.textContent = replayState.isRecording ? 'Recording...' : 'Record';
    }
  }

  function formatDelta(ms) {
    if (!replayState.startedAt) return '';
    var deltaSec = Math.max(0, Math.round((ms - replayState.startedAt) / 1000));
    if (deltaSec < 60) return '+' + deltaSec + 's';
    var mins = Math.floor(deltaSec / 60);
    var secs = deltaSec % 60;
    return '+' + mins + 'm' + secs + 's';
  }

  function updateModalUI() {
    var timeline = $id('replay-timeline');
    var emptyState = $id('replay-empty-state');
    if (!timeline) return;
    if (!replayState.steps.length) {
      timeline.innerHTML = '';
      var placeholder = document.createElement('div');
      placeholder.className = 'replay-empty-state';
      placeholder.id = 'replay-empty-state';
      placeholder.innerHTML = '<div class="replay-empty-icon">&#9654;</div><div>Start recording to capture your analysis session</div>';
      timeline.appendChild(placeholder);
      return;
    }
    var html = '';
    replayState.steps.forEach(function (step, i) {
      var icon = ACTION_ICONS[step.action] || '\u25CF';
      var desc = describeStep(step);
      var delta = formatDelta(step.timestamp);
      html += '<div class="replay-step-card">' +
        '<span class="replay-step-num">' + (i + 1) + '</span>' +
        '<span class="replay-step-icon">' + icon + '</span>' +
        '<span class="replay-step-body">' +
        '<div class="replay-step-desc">' + escapeHtml(desc) + '</div>' +
        '<div class="replay-step-meta">' + escapeHtml(step.action) + ' &middot; ' + delta + '</div>' +
        '</span>' +
        '</div>';
    });
    timeline.innerHTML = html;
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function openReplayModal() {
    var modal = $id('replay-modal');
    if (modal) {
      modal.classList.add('open');
      updateModalUI();
      updateTriggerBtnUI();
    }
  }

  function closeReplayModal() {
    var modal = $id('replay-modal');
    if (modal) modal.classList.remove('open');
  }

  function initReplayUI() {
    var triggerBtn = $id('replay-trigger-btn');
    if (triggerBtn) {
      triggerBtn.addEventListener('click', function () {
        openReplayModal();
      });
    }
    var closeBtn = $id('replay-modal-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        closeReplayModal();
      });
    }
    var modal = $id('replay-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeReplayModal();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var m = $id('replay-modal');
        if (m && m.classList.contains('open')) closeReplayModal();
      }
    });
    var toggleBtn = $id('replay-record-toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        if (replayState.isRecording) {
          stop();
        } else {
          start();
        }
      });
    }
    var exportBtn = $id('replay-export-json-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', function () {
        exportJSON();
        if (typeof window.showToast === 'function') {
          window.showToast('Session exported as JSON', 'success');
        }
      });
    }
    var narrBtn = $id('replay-gen-narrative-btn');
    if (narrBtn) {
      narrBtn.addEventListener('click', function () {
        var box = $id('replay-narrative-box');
        if (box) {
          box.classList.add('visible');
          box.textContent = 'Generating narrative...';
        }
        exportNarrative().then(function (text) {
          if (box) box.textContent = text;
        });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReplayUI);
  } else {
    initReplayUI();
  }