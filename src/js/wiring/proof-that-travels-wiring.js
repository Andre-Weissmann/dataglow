/* DataGlow -- js/wiring/proof-that-travels-wiring.js
   UI wiring for: Live Wire, The Notary, The Receipt
   Injected at end of bundle.js by build process.          */

/* ============================================================
   FEATURE: Live Wire -- folder watch + auto-ingest
   ============================================================ */
(function bindLiveWireFeature() {
  var panel    = null;
  var pickBtn  = null;
  var stopBtn  = null;
  var statusEl = null;
  var logEl    = null;

  function log(msg) {
    if (!logEl) return;
    var ts = new Date().toLocaleTimeString();
    logEl.textContent = '[' + ts + '] ' + msg + '\n' + logEl.textContent;
  }

  function updateStatus() {
    if (!statusEl || typeof LiveWireEngine === 'undefined') return;
    if (LiveWireEngine.isWatching()) {
      statusEl.textContent = 'Watching: ' + LiveWireEngine.watchedDir() +
        '  (' + LiveWireEngine.fileCount() + ' files tracked)';
      statusEl.style.color = 'var(--success, #437A22)';
      if (pickBtn) pickBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = '';
    } else {
      statusEl.textContent = LiveWireEngine.isSupported()
        ? 'Not watching any folder.'
        : 'Not supported in this browser. Use Chrome or Edge.';
      statusEl.style.color = 'var(--text-muted)';
      if (pickBtn) pickBtn.style.display = '';
      if (stopBtn) stopBtn.style.display = 'none';
    }
  }

  function handleNewFile(file, filename) {
    log('New file detected: ' + filename + ' (' + (file.size / 1024).toFixed(1) + ' KB)');
    if (typeof window.handleFile === 'function') {
      window.handleFile(file);
      log('Auto-imported: ' + filename);
    }
  }

  function handleUpdatedFile(file, filename) {
    log('Updated: ' + filename + '  re-importing...');
    if (typeof window.handleFile === 'function') window.handleFile(file);
  }

  function openPanel() {
    if (!panel) panel = document.getElementById('livewire-panel');
    if (!panel) return;
    pickBtn  = document.getElementById('livewire-pick-btn');
    stopBtn  = document.getElementById('livewire-stop-btn');
    statusEl = document.getElementById('livewire-status');
    logEl    = document.getElementById('livewire-log');

    panel.style.display = 'flex';
    updateStatus();

    if (pickBtn && !pickBtn._wired) {
      pickBtn._wired = true;
      pickBtn.addEventListener('click', async function () {
        var result = await LiveWireEngine.pickAndWatch(handleNewFile, handleUpdatedFile);
        if (result.ok) {
          log('Started watching: ' + result.dirName + '  (' + result.fileCount + ' existing files tracked)');
        } else {
          log('Could not start: ' + result.reason);
        }
        updateStatus();
      });
    }

    if (stopBtn && !stopBtn._wired) {
      stopBtn._wired = true;
      stopBtn.addEventListener('click', function () {
        LiveWireEngine.stop();
        log('Stopped watching.');
        updateStatus();
      });
    }

    var closeBtn = document.getElementById('livewire-close-btn');
    if (closeBtn && !closeBtn._wired) {
      closeBtn._wired = true;
      closeBtn.addEventListener('click', function () { panel.style.display = 'none'; });
    }
  }

  function wire() {
    var triggerBtn = document.getElementById('livewire-trigger-btn');
    if (triggerBtn && !triggerBtn._lw) {
      triggerBtn._lw = true;
      triggerBtn.addEventListener('click', openPanel);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

/* ============================================================
   FEATURE: The Notary -- .dgnot portable proof bundle
   ============================================================ */
(function bindNotaryFeature() {
  var notaryBtn = null;

  function updateNotaryBtnState() {
    notaryBtn = notaryBtn || document.getElementById('notary-export-btn');
    if (!notaryBtn) return;
    var dataset = (typeof getActiveDataset === 'function') ? getActiveDataset() : null;
    var hasStory = !!(typeof state !== 'undefined' && state.currentStoryDoc);
    var findings = dataset ? (dataset.findings || []) : [];
    var noCritical = findings.every(function (f) {
      return !(f && f.severity === 'critical' && f.status !== 'resolved');
    });
    if (dataset && hasStory && noCritical) {
      notaryBtn.disabled = false;
      notaryBtn.title = 'Export independently verifiable .dgnot proof bundle';
    } else if (!hasStory) {
      notaryBtn.disabled = true;
      notaryBtn.title = 'Generate a story first';
    } else {
      notaryBtn.disabled = true;
      notaryBtn.title = 'Resolve Critical findings first';
    }
  }

  function wire() {
    notaryBtn = document.getElementById('notary-export-btn');
    if (!notaryBtn || notaryBtn._notaryWired) return;
    notaryBtn._notaryWired = true;
    updateNotaryBtnState();

    notaryBtn.addEventListener('click', async function () {
      if (notaryBtn.disabled) return;
      var dataset = (typeof getActiveDataset === 'function') ? getActiveDataset() : null;
      if (!dataset || !state.currentStoryDoc) return;

      notaryBtn.disabled = true;
      notaryBtn.textContent = 'Notarizing...';

      try {
        var bundle = await NotaryEngine.notarize({
          datasetName:        dataset.name,
          rowCount:           dataset.rows.length,
          columnCount:        dataset.columns.length,
          sourceFileHash:     dataset.fileHash || null,
          validationFindings: dataset.findings || [],
          storyDoc:           state.currentStoryDoc,
          memoryStore:        state.memoryStore,
          queryText:          state.lastQueryText || null,
          resultRows:         state.lastResultRows || [],
          notarizedAt:        new Date().toISOString(),
          toolVersion:        'dataglow-canvas'
        }, {
          renderMarkdown:        (typeof StoryBuilder !== 'undefined' ? StoryBuilder.renderMarkdown : null),
          computeStoryHash:      (typeof StoryBuilder !== 'undefined' ? StoryBuilder.computeStoryHash : null),
          generateTimeline:      (typeof InstitutionalMemory !== 'undefined' ? InstitutionalMemory.generateTimeline : null),
          computeProvenanceHash: (typeof InstitutionalMemory !== 'undefined' ? InstitutionalMemory.computeProvenanceHash : null)
        });

        NotaryEngine.download(bundle, dataset.name);

        if (window._activeProjectId && typeof ProjectWorkspace !== 'undefined' && ProjectWorkspace.isReady()) {
          await ProjectWorkspace.saveNotarizedBundle(window._activeProjectId, NotaryEngine.serialize(bundle));
        }

        if (typeof window.showToast === 'function') {
          window.showToast('Notarized .dgnot downloaded. Verify: npx dataglow-verify@latest <file>', 'success');
        }
      } catch (e) {
        if (typeof window.showToast === 'function') {
          window.showToast('Notarization failed: ' + e.message, 'error');
        }
      }

      notaryBtn.disabled = false;
      notaryBtn.innerHTML = '&#128274; Notarize';
      updateNotaryBtnState();
    });

    document.addEventListener('dataglow:story-updated',   updateNotaryBtnState);
    document.addEventListener('dataglow:dataset-loaded',  updateNotaryBtnState);
    document.addEventListener('dataglow:findings-updated',updateNotaryBtnState);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

/* ============================================================
   FEATURE: The Receipt -- cross-dataset reconciliation diff
   ============================================================ */
(function bindReceiptFeature() {
  var panel       = null;
  var dsASelect   = null;
  var dsBSelect   = null;
  var runBtn      = null;
  var downloadBtn = null;
  var outputEl    = null;
  var lastDiff    = null;

  function populateSelects() {
    var datasets = (typeof state !== 'undefined' && state.datasets) ? state.datasets : [];
    var opts = '<option value="">Select dataset...</option>' +
      datasets.map(function (ds) {
        return '<option value="' + ds.id + '">' +
          (ds.name || 'Untitled') + ' (' + (ds.rows ? ds.rows.length : 0) + ' rows)</option>';
      }).join('');
    if (dsASelect) dsASelect.innerHTML = opts;
    if (dsBSelect) dsBSelect.innerHTML = opts;
  }

  function openPanel() {
    if (!panel) panel = document.getElementById('receipt-panel');
    if (!panel) return;
    dsASelect   = document.getElementById('receipt-ds-a');
    dsBSelect   = document.getElementById('receipt-ds-b');
    runBtn      = document.getElementById('receipt-run-btn');
    downloadBtn = document.getElementById('receipt-download-btn');
    outputEl    = document.getElementById('receipt-output');

    panel.style.display = 'flex';
    populateSelects();
    if (outputEl)    outputEl.style.display = 'none';
    if (downloadBtn) downloadBtn.style.display = 'none';
    lastDiff = null;

    var closeBtn = document.getElementById('receipt-close-btn');
    if (closeBtn && !closeBtn._wired) {
      closeBtn._wired = true;
      closeBtn.addEventListener('click', function () { panel.style.display = 'none'; });
    }

    if (runBtn && !runBtn._wired) {
      runBtn._wired = true;
      runBtn.addEventListener('click', function () {
        var idA = dsASelect && dsASelect.value;
        var idB = dsBSelect && dsBSelect.value;
        if (!idA || !idB) {
          if (typeof window.showToast === 'function') window.showToast('Select two datasets to compare.', 'warn');
          return;
        }
        if (idA === idB) {
          if (typeof window.showToast === 'function') window.showToast('Select two different datasets.', 'warn');
          return;
        }
        var datasets = (typeof state !== 'undefined' && state.datasets) ? state.datasets : [];
        var dsA = datasets.find(function (d) { return d.id === idA; });
        var dsB = datasets.find(function (d) { return d.id === idB; });
        if (!dsA || !dsB) return;

        runBtn.disabled = true;
        runBtn.textContent = 'Analysing...';

        try {
          lastDiff = ReceiptEngine.diff(dsA, dsB);
          if (outputEl) {
            outputEl.textContent = lastDiff.narrative;
            outputEl.style.display = 'block';
          }
          if (downloadBtn) downloadBtn.style.display = '';
        } catch (e) {
          if (outputEl) {
            outputEl.textContent = 'Error: ' + e.message;
            outputEl.style.display = 'block';
          }
        }

        runBtn.disabled = false;
        runBtn.textContent = 'Generate Receipt';
      });
    }

    if (downloadBtn && !downloadBtn._wired) {
      downloadBtn._wired = true;
      downloadBtn.addEventListener('click', function () {
        if (lastDiff) ReceiptEngine.download(lastDiff);
      });
    }
  }

  function wire() {
    var triggerBtn = document.getElementById('receipt-trigger-btn');
    if (triggerBtn && !triggerBtn._rc) {
      triggerBtn._rc = true;
      triggerBtn.addEventListener('click', openPanel);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
