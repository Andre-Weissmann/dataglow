/* ---- from js/sync/qr-transport.js ---- */
/* ================================================================
   DataGlow QR Transport -- Cross-Device Session Sync
   Phase 1 of 3: QR Code handoff (universal, no permissions needed)

   Architecture:
   - Session Capsule: compressed JSON of shareable session state
     (column cleaning marks, proof chain hash, validation rules,
      assumptions, active gates, narrative seeds)
     NOT raw row data -- that stays in OPFS per device.
   - Encode: capsule -> JSON string -> base64url -> qrcode.js render
   - Decode: jsQR camera scan -> base64url -> JSON -> hydrate state
   - Both qrcode.js and jsQR loaded from CDN on first use

   No server. No API key. No raw data leaves the device.
   ================================================================ */
window.DataGlowQR = (function () {
  'use strict';

  /* ----------------------------------------------------------------
     CDN loaders
  ---------------------------------------------------------------- */
  var QRCODE_CDN  = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js';
  var JSQR_CDN    = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

  var _qrcodeLoaded = false;
  var _jsqrLoaded   = false;

  function loadScript(src, onLoad) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = onLoad;
    s.onerror = function () { console.warn('[DG-QR] CDN load failed:', src); };
    document.head.appendChild(s);
  }

  function ensureQRCode(cb) {
    if (_qrcodeLoaded && window.QRCode) { cb(); return; }
    loadScript(QRCODE_CDN, function () { _qrcodeLoaded = true; cb(); });
  }

  function ensureJSQR(cb) {
    if (_jsqrLoaded && window.jsQR) { cb(); return; }
    loadScript(JSQR_CDN, function () { _jsqrLoaded = true; cb(); });
  }

  /* ----------------------------------------------------------------
     Session Capsule -- what gets encoded into the QR
     Only shareable session metadata, no raw rows.
  ---------------------------------------------------------------- */
  function buildCapsule() {
    var capsule = {
      v:   1,
      ts:  Date.now(),
      src: 'dataglow-qr',
    };

    /* Proof chain hash (from DataGlowProof if available) */
    if (window.DataGlowProof && typeof window.DataGlowProof.getChainHash === 'function') {
      capsule.proofHash = window.DataGlowProof.getChainHash();
    }

    /* Active validation gates */
    if (window.DataGlowGates && typeof window.DataGlowGates.exportState === 'function') {
      capsule.gates = window.DataGlowGates.exportState();
    }

    /* Column cleaning marks (from OPFS metadata if available) */
    if (window.OPFSEngine && typeof window.OPFSEngine.getSessionMeta === 'function') {
      try { capsule.meta = window.OPFSEngine.getSessionMeta(); } catch (_e) {}
    }

    /* Active SQL (from editor) */
    try {
      var sqlEd = document.getElementById('sql-view-input') || document.querySelector('#sql-view textarea');
      if (sqlEd && sqlEd.value && sqlEd.value.trim().length > 0) {
        capsule.sql = sqlEd.value.trim().slice(0, 2000);
      }
    } catch (_e) {}

    /* Narrative assumptions seed */
    if (window.DataGlowNarrative && typeof window.DataGlowNarrative.getAssumptions === 'function') {
      try { capsule.assumptions = window.DataGlowNarrative.getAssumptions(); } catch (_e) {}
    }

    /* Dataset name + column list (not rows) */
    if (window.__DG_DATASET__) {
      capsule.dsName = window.__DG_DATASET__.name || '';
      capsule.dsCols = (window.__DG_DATASET__.columns || []).map(function (c) {
        return { n: c.name || c, t: c.type || 'STR' };
      }).slice(0, 100);
    }

    return capsule;
  }

  function encodeCapsule(capsule) {
    var json = JSON.stringify(capsule);
    /* base64url encode */
    return btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  function decodeCapsule(encoded) {
    try {
      var b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
      var json = decodeURIComponent(escape(atob(b64)));
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  /* ----------------------------------------------------------------
     QR renderer -- renders into a <canvas> el
  ---------------------------------------------------------------- */
  function renderQR(canvasEl, capsuleStr, cb) {
    ensureQRCode(function () {
      if (!window.QRCode) { cb && cb(new Error('QRCode lib failed to load')); return; }
      window.QRCode.toCanvas(canvasEl, capsuleStr, {
        errorCorrectionLevel: 'M',
        width:  256,
        margin: 2,
        color: {
          dark:  '#20C5B5',
          light: '#131519',
        },
      }, function (err) { cb && cb(err); });
    });
  }

  /* ----------------------------------------------------------------
     Scanner -- uses device camera via getUserMedia + jsQR
  ---------------------------------------------------------------- */
  var _scanInterval = null;
  var _videoEl      = null;
  var _streamRef    = null;

  function startScan(videoEl, onResult, onError) {
    ensureJSQR(function () {
      if (!window.jsQR) { onError && onError(new Error('jsQR lib failed to load')); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        onError && onError(new Error('Camera not supported on this device'));
        return;
      }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(function (stream) {
          _streamRef = stream;
          _videoEl   = videoEl;
          videoEl.srcObject = stream;
          videoEl.setAttribute('playsinline', 'true');
          videoEl.play();

          var canvas  = document.createElement('canvas');
          var ctx     = canvas.getContext('2d');

          _scanInterval = setInterval(function () {
            if (videoEl.readyState !== videoEl.HAVE_ENOUGH_DATA) return;
            canvas.width  = videoEl.videoWidth;
            canvas.height = videoEl.videoHeight;
            ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            var code    = window.jsQR(imgData.data, imgData.width, imgData.height, {
              inversionAttempts: 'dontInvert',
            });
            if (code && code.data) {
              stopScan();
              var capsule = decodeCapsule(code.data);
              if (capsule && capsule.src === 'dataglow-qr') {
                onResult && onResult(capsule);
              } else {
                onError && onError(new Error('QR code is not a DataGlow session'));
              }
            }
          }, 200);
        })
        .catch(function (err) { onError && onError(err); });
    });
  }

  function stopScan() {
    if (_scanInterval) { clearInterval(_scanInterval); _scanInterval = null; }
    if (_streamRef) {
      _streamRef.getTracks().forEach(function (t) { t.stop(); });
      _streamRef = null;
    }
    if (_videoEl) { _videoEl.srcObject = null; _videoEl = null; }
  }

  /* ----------------------------------------------------------------
     Hydration -- apply received capsule to current session
  ---------------------------------------------------------------- */
  function hydrateCapsule(capsule) {
    if (!capsule || capsule.v !== 1) return { ok: false, reason: 'Invalid capsule version' };

    var applied = [];

    /* Restore SQL */
    if (capsule.sql) {
      try {
        var sqlEd = document.getElementById('sql-view-input') || document.querySelector('#sql-view textarea');
        if (sqlEd) { sqlEd.value = capsule.sql; applied.push('sql'); }
      } catch (_e) {}
    }

    /* Restore gates */
    if (capsule.gates && window.DataGlowGates && typeof window.DataGlowGates.importState === 'function') {
      try { window.DataGlowGates.importState(capsule.gates); applied.push('gates'); } catch (_e) {}
    }

    /* Restore narrative assumptions */
    if (capsule.assumptions && window.DataGlowNarrative && typeof window.DataGlowNarrative.setAssumptions === 'function') {
      try { window.DataGlowNarrative.setAssumptions(capsule.assumptions); applied.push('assumptions'); } catch (_e) {}
    }

    /* Emit event for other modules to listen */
    document.dispatchEvent(new CustomEvent('dataglow:qr-hydrated', {
      detail: { capsule: capsule, applied: applied },
    }));

    return { ok: true, applied: applied, ts: capsule.ts, dsName: capsule.dsName || '' };
  }

  /* ----------------------------------------------------------------
     Public API
  ---------------------------------------------------------------- */
  return {
    buildCapsule:   buildCapsule,
    encodeCapsule:  encodeCapsule,
    decodeCapsule:  decodeCapsule,
    renderQR:       renderQR,
    startScan:      startScan,
    stopScan:       stopScan,
    hydrateCapsule: hydrateCapsule,
  };

}());
/* ---- end qr-transport.js ---- */
