;(function () {
  'use strict';

  /* ============================================================
     DATAGLOW - R4 Ship pack canvas UI
     ============================================================
     Implements R3_R4_CAPTURE_SHIP_SPEC.md's "R4 Ship pack": an
     "Export ship pack" button that gathers keepers.json (from Scout, if
     present), claims.json (proven claims + SQL + engine ids, from Proof
     Harness receipts), validation_summary.json, an honest_claims.md
     template, and screenshots/ (from R3 captures, if any), then downloads
     them as a single ZIP when JSZip happens to be available on the page, or
     as a sequence of individual file downloads otherwise ("ZIP or
     multi-download bundle" per SPEC). Exposes window.DataGlowShipPack.export()
     as the SPEC's exact requested public API.

     The pure engine (js/ship-pack/ship-pack.js, published as
     window.DataGlowShipPackEngine) owns all data shaping: this module only
     discovers live inputs (best-effort, never throws), calls the engine, and
     turns the result into actual downloaded files. No network request is
     ever made by this file.

     No em dash (U+2014) anywhere in this file's visible strings. */

  var BTN_ID = 'dg-ship-pack-btn';
  var PANEL_ID = 'dg-ship-pack-panel';
  var STYLE_ID = 'dg-ship-pack-styles';
  var BODY_ID = 'dg-ship-pack-body';

  var _lastPack = null;
  var _busy = false;

  function engine() { return window.DataGlowShipPackEngine || null; }

  function flagOn() {
    try { if (window.DATAGLOW_SHIP_PACK === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_SHIP_PACK === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('captureShipPack') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, kind || 'info'); return; } catch (_e) {}
    }
    console.info('[Ship pack]', msg);
  }

  /* ---------------------------- input discovery ----------------------------
     Every lookup here is best-effort and wrapped so a missing/absent module
     never blocks the export: an honest empty section beats a crash. Mirrors
     Question Scout's own discoverTables() convention. */
  function discoverKeepersExport() {
    try {
      var qsCanvas = window.DataGlowQuestionScoutCanvas;
      var qsEngine = window.DataGlowQuestionScout;
      if (qsCanvas && typeof qsCanvas.getKeepers === 'function' && qsEngine && typeof qsEngine.buildKeepersExport === 'function') {
        var keepers = qsCanvas.getKeepers();
        var strip = (typeof qsCanvas.getProfileStrip === 'function') ? qsCanvas.getProfileStrip() : null;
        return qsEngine.buildKeepersExport(keepers, strip);
      }
    } catch (_e) {}
    return null;
  }

  function discoverReceiptEntries() {
    try {
      if (window.DataGlowProofHarness && typeof window.DataGlowProofHarness.getReceipts === 'function') {
        var entries = window.DataGlowProofHarness.getReceipts();
        if (Array.isArray(entries)) return entries;
      }
    } catch (_e) {}
    return [];
  }

  function discoverValidationLayers() {
    try {
      if (typeof window.dgGetValidationSummary === 'function') {
        var v = window.dgGetValidationSummary();
        if (Array.isArray(v)) return v;
      }
    } catch (_e0) {}
    try {
      if (Array.isArray(window._dgValidationLayers)) return window._dgValidationLayers;
    } catch (_e1) {}
    try {
      if (window.DataGlowState && Array.isArray(window.DataGlowState.validation)) return window.DataGlowState.validation;
    } catch (_e2) {}
    return [];
  }

  function discoverCaptures() {
    try {
      if (window.DataGlowCaptureCanvas && typeof window.DataGlowCaptureCanvas.getCapturesForShipPack === 'function') {
        var items = window.DataGlowCaptureCanvas.getCapturesForShipPack();
        if (Array.isArray(items)) return items;
      }
    } catch (_e) {}
    return [];
  }

  function discoverDatasetName() {
    try {
      if (window.dataset && typeof window.dataset.name === 'string') return window.dataset.name;
    } catch (_e0) {}
    try {
      if (window.DataGlowState && typeof window.DataGlowState.datasetName === 'string') return window.DataGlowState.datasetName;
    } catch (_e1) {}
    return null;
  }

  /* ---------------------------- build + download --------------------------- */
  function gatherAndBuild() {
    var e = engine();
    if (!e) return null;
    var captureItems = discoverCaptures();
    var capEngine = window.DataGlowCapture;
    var screenshotManifest = (capEngine && typeof capEngine.buildScreenshotManifest === 'function')
      ? capEngine.buildScreenshotManifest(captureItems.map(function (it) { return it.record; }))
      : [];
    var pack = e.buildShipPack({
      keepersExport: discoverKeepersExport(),
      receiptEntries: discoverReceiptEntries(),
      validationLayers: discoverValidationLayers(),
      screenshotManifest: screenshotManifest,
      datasetName: discoverDatasetName(),
    });
    return { pack: pack, captureItems: captureItems };
  }

  function triggerDownload(filename, contents, mimeType) {
    var blob = (contents instanceof Blob) ? contents : new Blob([contents], { type: mimeType || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function safePathToFilename(path) {
    return path.replace(/\//g, '__');
  }

  function downloadAsZipOrFiles(pack, captureItems) {
    var e = engine();
    var files = e.serializeShipPackFiles(pack);
    var haveJSZip = typeof window.JSZip === 'function';

    if (haveJSZip) {
      var zip = new window.JSZip();
      files.forEach(function (f) { zip.file(f.path, f.contents); });
      captureItems.forEach(function (item) {
        if (item.blob) zip.file('screenshots/' + item.record.filename, item.blob);
      });
      return zip.generateAsync({ type: 'blob' }).then(function (blob) {
        triggerDownload('dataglow-ship-pack.zip', blob, 'application/zip');
        return { mode: 'zip', fileCount: files.length + captureItems.length };
      });
    }

    /* Multi-download fallback: one file per download, prefixed so a folder
       listing groups them together and screenshots keep their own names. */
    files.forEach(function (f) {
      triggerDownload('dataglow-ship-pack_' + safePathToFilename(f.path), f.contents, f.mimeType);
    });
    captureItems.forEach(function (item) {
      if (item.blob) triggerDownload('dataglow-ship-pack_screenshots__' + item.record.filename, item.blob, 'image/png');
    });
    return Promise.resolve({ mode: 'multi-download', fileCount: files.length + captureItems.length });
  }

  function runExport() {
    if (_busy) return Promise.resolve(null);
    _busy = true;
    var result = gatherAndBuild();
    if (!result) {
      _busy = false;
      toast('Ship pack engine not available.', 'error');
      return Promise.resolve(null);
    }
    _lastPack = result.pack;
    renderBody();
    return downloadAsZipOrFiles(result.pack, result.captureItems).then(function (info) {
      _busy = false;
      toast('Ship pack exported (' + info.mode + ', ' + info.fileCount + ' file(s)).', 'success');
      renderBody();
      return result.pack;
    }).catch(function () {
      _busy = false;
      toast('Ship pack export failed. Nothing was uploaded; try again.', 'error');
      return null;
    });
  }

  /* ---------------------------- styles ------------------------------------ */
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + BTN_ID + '{position:fixed;bottom:16px;right:760px;z-index:12000;',
      'background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:999px;',
      'padding:8px 14px;font:600 13px sans-serif;cursor:pointer;}',
      '#' + BTN_ID + ':hover{background:#1f2937;}',
      '#' + PANEL_ID + '{position:fixed;top:0;right:-380px;width:360px;height:100%;background:#0f1720;',
      'color:#e5e7eb;border-left:1px solid #374151;z-index:12001;transition:right .2s ease;',
      'display:flex;flex-direction:column;font:13px sans-serif;overflow:hidden;}',
      '#' + PANEL_ID + '.open{right:0;}',
      '#' + PANEL_ID + ' .dg-sp-head{padding:14px;border-bottom:1px solid #374151;display:flex;justify-content:space-between;align-items:center;}',
      '#' + PANEL_ID + ' .dg-sp-head h3{margin:0;font-size:15px;}',
      '#' + BODY_ID + '{overflow-y:auto;padding:12px;flex:1;}',
      '.dg-sp-go{width:100%;background:#2563eb;color:#fff;border:none;border-radius:6px;padding:10px;font-weight:600;cursor:pointer;margin-bottom:12px;}',
      '.dg-sp-go[disabled]{opacity:.6;cursor:default;}',
      '.dg-sp-file{border:1px solid #374151;border-radius:8px;padding:8px;margin-bottom:8px;font-size:12px;}',
      '.dg-sp-file .dg-sp-name{font-weight:600;}',
      '.dg-sp-empty{color:#9ca3af;font-size:12px;padding:12px 0;}',
      '.dg-sp-note{color:#9ca3af;font-size:11px;line-height:1.5;margin-top:6px;padding-top:10px;border-top:1px solid #374151;}',
    ].join('');
    document.head.appendChild(style);
  }

  /* ---------------------------- rendering ---------------------------------- */
  function renderBody() {
    var body = document.getElementById(BODY_ID);
    if (!body) return;
    var summary = '<div class="dg-sp-empty">Nothing exported yet this session. Click Export ship pack below.</div>';
    if (_lastPack) {
      summary = (_lastPack.fileNames || []).map(function (name) {
        return '<div class="dg-sp-file"><span class="dg-sp-name">' + esc(name) + '</span></div>';
      }).join('');
    }
    body.innerHTML =
      '<button type="button" class="dg-sp-go" data-sp-go' + (_busy ? ' disabled' : '') + '>' + (_busy ? 'Exporting...' : 'Export ship pack') + '</button>' +
      summary +
      '<div class="dg-sp-note">Bundles keepers.json, claims.json, validation_summary.json, honest_claims.md, and any captured screenshots into a ZIP (or separate downloads if a ZIP library is not present). Local only, nothing is uploaded.</div>';
    var goBtn = body.querySelector('[data-sp-go]');
    if (goBtn) goBtn.addEventListener('click', runExport);
  }

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    ensureStyles();
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML =
      '<div class="dg-sp-head"><h3>Ship pack</h3><button type="button" data-sp-close aria-label="Close">\u00d7</button></div>' +
      '<div id="' + BODY_ID + '"></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-sp-close]').addEventListener('click', closePanel);
    renderBody();
    return panel;
  }

  function isOpen() {
    var panel = document.getElementById(PANEL_ID);
    return !!(panel && panel.classList.contains('open'));
  }

  function openPanel() {
    if (!flagOn()) return false;
    ensurePanel().classList.add('open');
    renderBody();
    return true;
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('open');
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    ensureStyles();
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open ship pack panel');
    btn.title = 'Export a portable ship pack: keepers, proven claims, validation summary, honest claims, screenshots';
    btn.innerHTML = '<span>Export ship pack</span>';
    btn.addEventListener('click', function () {
      if (isOpen()) closePanel(); else openPanel();
    });
    var anchor = document.getElementById('dg-capture-btn') || document.getElementById('dg-question-scout-btn') || document.getElementById('dg-ph-btn');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      if (anchor.style.position === 'fixed') {
        btn.style.position = 'fixed';
        btn.style.bottom = '16px';
        btn.style.right = '760px';
        btn.style.zIndex = '12000';
      }
      return;
    }
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header');
    if (!toolbar) {
      toolbar = document.body;
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '760px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  function boot() {
    if (flagOn()) {
      injectButton();
      ensurePanel();
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closePanel();
      });
    }
    /* SPEC's exact requested public API: window.DataGlowShipPack.export() */
    window.DataGlowShipPack = {
      export: runExport,
      buildPreview: function () { var r = gatherAndBuild(); return r ? r.pack : null; },
      getLastPack: function () { return _lastPack; },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
