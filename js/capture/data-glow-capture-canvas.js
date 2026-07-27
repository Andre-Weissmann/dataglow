;(function () {
  'use strict';

  /* ============================================================
     DATAGLOW - R3 Screenshot / proof capture canvas UI
     ============================================================
     Implements R3_R4_CAPTURE_SHIP_SPEC.md's "R3 Screenshot / proof capture":
     a "Capture step" button (local only) that saves a PNG of the current
     canvas view, named with a fixed step label + timestamp, for the seven
     project-run steps (home, loaded, validate, scout, prove, narrative, and
     export screen). Captures use html2canvas if the page happens to have it loaded, a
     native capture API (getDisplayMedia-based) if the browser offers one AND
     the user explicitly grants it, or a canvas-draw fallback (renders a
     lightweight text/DOM snapshot to an actual <canvas> element and reads
     that back as a PNG blob) so the button always produces something. Saves
     to IndexedDB by default; a per-capture "Download" also triggers a plain
     anchor download. NEVER makes a network request: no fetch/XHR/WebSocket/
     sendBeacon anywhere in this file.

     The pure engine (js/capture/capture.js, published as
     window.DataGlowCapture) owns the fixed step list, filename building, the
     capture record shape, and the in-memory list model. This module owns
     only DOM/IO: the button, the panel, actually drawing/reading pixels,
     IndexedDB persistence, and the download link.

     No em dash (U+2014) anywhere in this file's visible strings. */

  var BTN_ID = 'dg-capture-btn';
  var PANEL_ID = 'dg-capture-panel';
  var STYLE_ID = 'dg-capture-styles';
  var BODY_ID = 'dg-capture-body';

  var _captures = [];      // in-memory list mirrors what IndexedDB holds this session
  var _blobsById = {};     // id -> Blob, kept in memory so Download/ship-pack can read pixels back
  var _pendingStep = 'home';
  var _dbPromise = null;

  function engine() { return window.DataGlowCapture || null; }

  function flagOn() {
    try { if (window.DATAGLOW_CAPTURE === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_CAPTURE === true) return true; } catch (_e1) {}
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
    console.info('[Capture]', msg);
  }

  /* ---------------------------- IndexedDB ---------------------------------
     Best-effort persistence only: a capture still lives in the in-memory
     _captures/_blobsById maps for the rest of the session even if
     IndexedDB is unavailable (private browsing, disabled storage, an older
     WebView) or a write fails, so the button never appears broken. */
  function openDb() {
    if (_dbPromise) return _dbPromise;
    var e = engine();
    _dbPromise = new Promise(function (resolve) {
      try {
        if (!('indexedDB' in window) || !e) { resolve(null); return; }
        var req = window.indexedDB.open(e.CAPTURE_DB_NAME, e.CAPTURE_DB_VERSION);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(e.CAPTURE_STORE_NAME)) {
            db.createObjectStore(e.CAPTURE_STORE_NAME, { keyPath: 'id' });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
      } catch (_err) {
        resolve(null);
      }
    });
    return _dbPromise;
  }

  function idbPut(record, blob) {
    var e = engine();
    openDb().then(function (db) {
      if (!db || !e) return;
      try {
        var tx = db.transaction(e.CAPTURE_STORE_NAME, 'readwrite');
        tx.objectStore(e.CAPTURE_STORE_NAME).put({ id: record.id, record: record, blob: blob });
      } catch (_err) { /* best effort only */ }
    });
  }

  /* ---------------------------- capture strategies ------------------------
     Tries, in order: (1) html2canvas if the page loaded it globally,
     (2) a native screen-capture API only if already granted/active in this
     session (never prompts on its own, since a permission prompt on every
     click would be hostile), (3) a canvas-draw fallback that renders a
     simple labeled snapshot card so the button always succeeds. */
  function captureViaHtml2Canvas(target) {
    if (typeof window.html2canvas !== 'function') return null;
    return window.html2canvas(target || document.body).then(function (canvasEl) {
      return new Promise(function (resolve) {
        canvasEl.toBlob(function (blob) { resolve({ blob: blob, width: canvasEl.width, height: canvasEl.height, method: 'html2canvas' }); }, 'image/png');
      });
    });
  }

  function captureViaNativeStream() {
    try {
      if (!window._dgActiveCaptureStream || typeof window._dgActiveCaptureStream !== 'object') return null;
      var stream = window._dgActiveCaptureStream;
      var track = stream.getVideoTracks && stream.getVideoTracks()[0];
      if (!track || typeof window.ImageCapture !== 'function') return null;
      var cap = new window.ImageCapture(track);
      return cap.grabFrame().then(function (bitmap) {
        var c = document.createElement('canvas');
        c.width = bitmap.width; c.height = bitmap.height;
        var ctx = c.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        return new Promise(function (resolve) {
          c.toBlob(function (blob) { resolve({ blob: blob, width: c.width, height: c.height, method: 'native' }); }, 'image/png');
        });
      });
    } catch (_e) {
      return null;
    }
  }

  /* Always succeeds: draws a small labeled card (step name, timestamp, page
     title, viewport size) onto a real <canvas> element and reads it back as
     a PNG blob. This is an honest proof-of-step artifact, not a pixel-exact
     screenshot, and the record's `method` field says so plainly. */
  function captureViaCanvasFallback(step) {
    var w = 960, h = 540;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#0f1720';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 4;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    ctx.fillStyle = '#e5e7eb';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText('DataGlow capture', 40, 90);
    ctx.font = '24px sans-serif';
    ctx.fillStyle = '#93c5fd';
    ctx.fillText('Step: ' + step, 40, 150);
    ctx.fillStyle = '#9ca3af';
    ctx.font = '18px sans-serif';
    ctx.fillText('Captured: ' + new Date().toString(), 40, 190);
    ctx.fillText('Page: ' + (document.title || 'DataGlow'), 40, 220);
    ctx.fillText('Viewport: ' + window.innerWidth + ' x ' + window.innerHeight, 40, 250);
    ctx.fillStyle = '#6b7280';
    ctx.font = '14px sans-serif';
    ctx.fillText('Canvas-draw fallback: no html2canvas/native capture available in this session.', 40, h - 30);
    return new Promise(function (resolve) {
      c.toBlob(function (blob) { resolve({ blob: blob, width: w, height: h, method: 'canvas-fallback' }); }, 'image/png');
    });
  }

  function runCapture(step) {
    var attempt = captureViaHtml2Canvas() || captureViaNativeStream();
    var p = attempt ? attempt.catch(function () { return captureViaCanvasFallback(step); }) : captureViaCanvasFallback(step);
    return Promise.resolve(p).then(function (result) {
      return result || captureViaCanvasFallback(step);
    });
  }

  function doCapture(rawStep) {
    var e = engine();
    if (!e) { toast('Capture engine not available.', 'error'); return; }
    runCapture(rawStep).then(function (result) {
      var record = e.buildCaptureRecord({
        step: rawStep,
        method: result.method,
        width: result.width,
        height: result.height,
        byteSize: result.blob ? result.blob.size : null,
      });
      _captures = e.addCapture(_captures, record);
      _blobsById[record.id] = result.blob;
      idbPut(record, result.blob);
      toast('Captured: ' + record.label + ' (' + record.method + ')', 'success');
      renderBody();
    }).catch(function () {
      toast('Capture failed. Nothing was uploaded; try again.', 'error');
    });
  }

  function downloadCapture(id) {
    var blob = _blobsById[id];
    var record = _captures.find(function (c) { return c.id === id; });
    if (!blob || !record) { toast('That capture is no longer available in memory.', 'error'); return; }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = record.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function removeCaptureAction(id) {
    var e = engine();
    if (!e) return;
    _captures = e.removeCapture(_captures, id);
    delete _blobsById[id];
    renderBody();
  }

  /* Exposed read-only accessor so the Ship Pack module can pull screenshot
     bytes without this file and ship-pack-canvas.js needing to know about
     each other's internals beyond this one function. */
  function getCapturesForShipPack() {
    return _captures.map(function (c) {
      return { record: c, blob: _blobsById[c.id] || null };
    });
  }

  /* ---------------------------- styles ------------------------------------ */
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + BTN_ID + '{position:fixed;bottom:16px;right:600px;z-index:12000;',
      'background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:999px;',
      'padding:8px 14px;font:600 13px sans-serif;cursor:pointer;display:flex;align-items:center;gap:6px;}',
      '#' + BTN_ID + ':hover{background:#1f2937;}',
      '#' + PANEL_ID + '{position:fixed;top:0;right:-380px;width:360px;height:100%;background:#0f1720;',
      'color:#e5e7eb;border-left:1px solid #374151;z-index:12001;transition:right .2s ease;',
      'display:flex;flex-direction:column;font:13px sans-serif;overflow:hidden;}',
      '#' + PANEL_ID + '.open{right:0;}',
      '#' + PANEL_ID + ' .dg-cap-head{padding:14px;border-bottom:1px solid #374151;display:flex;justify-content:space-between;align-items:center;}',
      '#' + PANEL_ID + ' .dg-cap-head h3{margin:0;font-size:15px;}',
      '#' + BODY_ID + '{overflow-y:auto;padding:12px;flex:1;}',
      '.dg-cap-steps{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;}',
      '.dg-cap-step-btn{background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px;padding:5px 8px;font-size:12px;cursor:pointer;}',
      '.dg-cap-step-btn.active{background:#2563eb;border-color:#2563eb;}',
      '.dg-cap-step-btn.done{border-color:#22c55e;}',
      '.dg-cap-go{width:100%;background:#2563eb;color:#fff;border:none;border-radius:6px;padding:10px;font-weight:600;cursor:pointer;margin-bottom:12px;}',
      '.dg-cap-item{border:1px solid #374151;border-radius:8px;padding:8px;margin-bottom:8px;}',
      '.dg-cap-item .dg-cap-row{display:flex;justify-content:space-between;align-items:center;gap:6px;}',
      '.dg-cap-item .dg-cap-name{font-weight:600;}',
      '.dg-cap-item .dg-cap-meta{color:#9ca3af;font-size:11px;margin-top:2px;}',
      '.dg-cap-item button{background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;}',
      '.dg-cap-empty{color:#9ca3af;font-size:12px;padding:12px 0;}',
      '.dg-cap-note{color:#9ca3af;font-size:11px;line-height:1.5;margin-top:6px;padding-top:10px;border-top:1px solid #374151;}',
    ].join('');
    document.head.appendChild(style);
  }

  /* ---------------------------- rendering ---------------------------------- */
  function renderBody() {
    var e = engine();
    var body = document.getElementById(BODY_ID);
    if (!body || !e) return;
    var coverage = e.captureStepCoverage(_captures);
    var coverageMap = {};
    coverage.steps.forEach(function (s) { coverageMap[s.step] = s.captured; });

    var stepsHtml = e.CAPTURE_STEPS.map(function (s) {
      var cls = 'dg-cap-step-btn' + (s === _pendingStep ? ' active' : '') + (coverageMap[s] ? ' done' : '');
      return '<button type="button" class="' + cls + '" data-cap-step="' + esc(s) + '">' + esc(s) + (coverageMap[s] ? ' \u2713' : '') + '</button>';
    }).join('');

    var listHtml = _captures.length === 0
      ? '<div class="dg-cap-empty">No captures yet this session. Pick a step above and click Capture step.</div>'
      : _captures.slice().reverse().map(function (c) {
          return '<div class="dg-cap-item" data-cap-id="' + esc(c.id) + '">' +
            '<div class="dg-cap-row"><span class="dg-cap-name">' + esc(c.label) + '</span>' +
            '<span><button type="button" data-cap-download="' + esc(c.id) + '">Download</button> ' +
            '<button type="button" data-cap-remove="' + esc(c.id) + '">Remove</button></span></div>' +
            '<div class="dg-cap-meta">' + esc(c.filename) + ' \u00b7 ' + esc(c.method) + (c.byteSize ? ' \u00b7 ' + Math.round(c.byteSize / 1024) + ' KB' : '') + '</div>' +
            '</div>';
        }).join('');

    body.innerHTML =
      '<div class="dg-cap-steps">' + stepsHtml + '</div>' +
      '<button type="button" class="dg-cap-go" data-cap-go>Capture step</button>' +
      listHtml +
      '<div class="dg-cap-note">Local only. Saved to this browser (IndexedDB) and available for download. Nothing here is uploaded to a network.</div>';

    body.querySelectorAll('[data-cap-step]').forEach(function (btn) {
      btn.addEventListener('click', function () { _pendingStep = btn.getAttribute('data-cap-step'); renderBody(); });
    });
    var goBtn = body.querySelector('[data-cap-go]');
    if (goBtn) goBtn.addEventListener('click', function () { doCapture(_pendingStep); });
    body.querySelectorAll('[data-cap-download]').forEach(function (btn) {
      btn.addEventListener('click', function () { downloadCapture(btn.getAttribute('data-cap-download')); });
    });
    body.querySelectorAll('[data-cap-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeCaptureAction(btn.getAttribute('data-cap-remove')); });
    });
  }

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    ensureStyles();
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML =
      '<div class="dg-cap-head"><h3>Capture step</h3><button type="button" data-cap-close aria-label="Close">\u00d7</button></div>' +
      '<div id="' + BODY_ID + '"></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-cap-close]').addEventListener('click', closePanel);
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
    btn.setAttribute('aria-label', 'Open capture step panel');
    btn.title = 'Capture a screenshot of the current step, saved locally';
    btn.innerHTML = '<span>Capture step</span>';
    btn.addEventListener('click', function () {
      if (isOpen()) closePanel(); else openPanel();
    });
    var anchor = document.getElementById('dg-question-scout-btn') || document.getElementById('dg-ph-btn') || document.getElementById('dg-trust-ledger-btn');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      if (anchor.style.position === 'fixed') {
        btn.style.position = 'fixed';
        btn.style.bottom = '16px';
        btn.style.right = '600px';
        btn.style.zIndex = '12000';
      }
      return;
    }
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header');
    if (!toolbar) {
      toolbar = document.body;
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '600px';
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
    window.DataGlowCaptureCanvas = {
      isOpen: isOpen,
      openPanel: openPanel,
      closePanel: closePanel,
      capture: doCapture,
      getCapturesForShipPack: getCapturesForShipPack,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
