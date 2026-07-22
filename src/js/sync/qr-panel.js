/* ---- from js/sync/qr-panel.js ---- */
/* ================================================================
   DataGlow QR Panel -- Cross-Device Session Share UI
   Registered in overflow grid (desktop) + tools sheet (mobile)
   Also wired as "Share via QR" inside PSI panel (optional bridge)

   Two modes:
   1. SHARE  -- builds capsule, renders QR for another device to scan
   2. SCAN   -- opens camera, decodes QR, hydrates session state
   ================================================================ */
(function () {
  'use strict';

  var INIT_DELAY = 1200;

  var CSS = [
    '#dg-qr-panel-host{position:fixed;top:0;right:0;bottom:0;z-index:10400;width:360px;max-width:100vw;',
    'background:#131519;border-left:1px solid #252930;display:none;flex-direction:column;',
    'box-shadow:-8px 0 32px rgba(0,0,0,.55);transition:transform .32s cubic-bezier(.4,0,.2,1);',
    'transform:translateX(100%)}',
    '#dg-qr-panel-host.open{display:flex;transform:translateX(0)}',
    '.dg-qr-header{display:flex;align-items:center;gap:10px;padding:18px 16px 14px;',
    'border-bottom:1px solid #252930;flex-shrink:0}',
    '.dg-qr-header h2{flex:1;margin:0;font:600 15px/1.3 "Geist Mono",monospace;color:#CDCCCA;letter-spacing:-.01em}',
    '.dg-qr-close{background:none;border:none;color:#797876;cursor:pointer;font-size:20px;padding:2px 6px;',
    'border-radius:4px;line-height:1}',
    '.dg-qr-close:hover{background:#252930;color:#CDCCCA}',
    '.dg-qr-tabs{display:flex;border-bottom:1px solid #252930;flex-shrink:0}',
    '.dg-qr-tab{flex:1;background:none;border:none;padding:12px 8px;font:500 12px/1 "Geist Mono",monospace;',
    'color:#797876;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s}',
    '.dg-qr-tab.active{color:#20C5B5;border-bottom-color:#20C5B5}',
    '.dg-qr-tab:hover:not(.active){color:#CDCCCA}',
    '.dg-qr-body{flex:1;overflow-y:auto;padding:20px 16px;display:flex;flex-direction:column;gap:16px}',
    '.dg-qr-canvas-wrap{display:flex;flex-direction:column;align-items:center;gap:12px}',
    '#dg-qr-canvas{border-radius:10px;border:2px solid #252930;background:#0D0E10}',
    '.dg-qr-hint{font:400 12px/1.5 "Geist Mono",monospace;color:#797876;text-align:center;max-width:280px}',
    '.dg-qr-btn{padding:10px 18px;border-radius:6px;border:none;font:600 12px/1 "Geist Mono",monospace;',
    'cursor:pointer;transition:background .15s,opacity .15s;width:100%}',
    '.dg-qr-btn-primary{background:#20C5B5;color:#0D0E10}',
    '.dg-qr-btn-primary:hover{background:#19a99a}',
    '.dg-qr-btn-secondary{background:#252930;color:#CDCCCA}',
    '.dg-qr-btn-secondary:hover{background:#2e3540}',
    '.dg-qr-video-wrap{position:relative;border-radius:10px;overflow:hidden;border:2px solid #252930;',
    'background:#0D0E10;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center}',
    '#dg-qr-video{width:100%;height:100%;object-fit:cover}',
    '.dg-qr-scan-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
    'pointer-events:none}',
    '.dg-qr-scan-frame{width:60%;height:60%;border:2px solid #20C5B5;border-radius:8px;',
    'box-shadow:0 0 0 9999px rgba(13,14,16,.55)}',
    '.dg-qr-status{font:400 12px/1.5 "Geist Mono",monospace;padding:10px 12px;border-radius:6px;',
    'background:#191C20;border:1px solid #252930;color:#CDCCCA;text-align:center}',
    '.dg-qr-status.success{border-color:#4AE38A;color:#4AE38A;background:rgba(74,227,138,.08)}',
    '.dg-qr-status.error{border-color:#F5A623;color:#F5A623;background:rgba(245,166,35,.08)}',
    '.dg-qr-applied-list{font:400 11px/1.6 "Geist Mono",monospace;color:#797876;margin:0;padding-left:16px}',
    '.dg-qr-applied-list li{color:#20C5B5}',
  ].join('');

  function injectCSS() {
    if (document.getElementById('dg-qr-styles')) return;
    var s = document.createElement('style');
    s.id = 'dg-qr-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ----------------------------------------------------------------
     Panel HTML
  ---------------------------------------------------------------- */
  function buildPanel() {
    var host = document.createElement('div');
    host.id = 'dg-qr-panel-host';
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-label', 'DataGlow QR Transport -- cross-device session sync');
    host.innerHTML = [
      '<div class="dg-qr-header">',
        '<span style="font-size:20px">&#x1F4F1;</span>',
        '<h2>QR Sync</h2>',
        '<button class="dg-qr-close" id="dg-qr-close" data-testid="qr-close-btn" aria-label="Close QR panel">&#x00D7;</button>',
      '</div>',
      '<div class="dg-qr-tabs">',
        '<button class="dg-qr-tab active" data-testid="qr-tab-share" id="dg-qr-tab-share">&#x1F4E4; Share</button>',
        '<button class="dg-qr-tab"        data-testid="qr-tab-scan"  id="dg-qr-tab-scan" >&#x1F4F7; Scan</button>',
      '</div>',
      '<div class="dg-qr-body" id="dg-qr-body">',
        renderShareTab(),
      '</div>',
    ].join('');
    document.body.appendChild(host);

    document.getElementById('dg-qr-close').addEventListener('click', closePanel);
    document.getElementById('dg-qr-tab-share').addEventListener('click', function () { switchTab('share'); });
    document.getElementById('dg-qr-tab-scan').addEventListener('click',  function () { switchTab('scan');  });
    document.getElementById('dg-qr-gen-btn').addEventListener('click', generateQR);
    document.getElementById('dg-qr-scan-start-btn').addEventListener('click', startScanMode);
    document.getElementById('dg-qr-scan-stop-btn').addEventListener('click', stopScanMode);
  }

  function renderShareTab() {
    return [
      '<div class="dg-qr-canvas-wrap" id="dg-qr-canvas-wrap">',
        '<canvas id="dg-qr-canvas" width="256" height="256"></canvas>',
        '<p class="dg-qr-hint" id="dg-qr-share-hint">',
          'Generate a QR code to share your current session state (SQL, gates, validation rules) with another device.',
          ' No raw data is encoded.',
        '</p>',
      '</div>',
      '<button class="dg-qr-btn dg-qr-btn-primary" id="dg-qr-gen-btn" data-testid="qr-generate-btn">',
        'Generate Session QR',
      '</button>',
      '<div class="dg-qr-status" id="dg-qr-share-status" style="display:none"></div>',
      /* Scan tab content -- hidden by default, revealed on tab switch */
      '<div id="dg-qr-scan-content" style="display:none">',
        '<div class="dg-qr-video-wrap">',
          '<video id="dg-qr-video" autoplay playsinline muted></video>',
          '<div class="dg-qr-scan-overlay"><div class="dg-qr-scan-frame"></div></div>',
        '</div>',
        '<p class="dg-qr-hint">Point your camera at a DataGlow QR code to sync the session to this device.</p>',
        '<button class="dg-qr-btn dg-qr-btn-secondary" id="dg-qr-scan-stop-btn" data-testid="qr-stop-scan-btn" style="display:none">',
          'Stop Camera',
        '</button>',
        '<div class="dg-qr-status" id="dg-qr-scan-status" style="display:none"></div>',
      '</div>',
      '<div id="dg-qr-share-tab-wrap">',
        '<button class="dg-qr-btn dg-qr-btn-secondary" id="dg-qr-scan-start-btn" data-testid="qr-start-scan-btn" style="display:none">',
          'Start Camera Scan',
        '</button>',
      '</div>',
    ].join('');
  }

  /* ----------------------------------------------------------------
     Tab switching
  ---------------------------------------------------------------- */
  function switchTab(tab) {
    stopScanMode();
    document.getElementById('dg-qr-tab-share').classList.toggle('active', tab === 'share');
    document.getElementById('dg-qr-tab-scan').classList.toggle('active',  tab === 'scan');

    var shareWrap = document.getElementById('dg-qr-canvas-wrap');
    var genBtn    = document.getElementById('dg-qr-gen-btn');
    var scanWrap  = document.getElementById('dg-qr-scan-content');
    var startBtn  = document.getElementById('dg-qr-scan-start-btn');

    if (tab === 'share') {
      if (shareWrap) shareWrap.style.display = '';
      if (genBtn)    genBtn.style.display    = '';
      if (scanWrap)  scanWrap.style.display  = 'none';
      if (startBtn)  startBtn.style.display  = 'none';
    } else {
      if (shareWrap) shareWrap.style.display = 'none';
      if (genBtn)    genBtn.style.display    = 'none';
      if (scanWrap)  scanWrap.style.display  = '';
      if (startBtn)  startBtn.style.display  = '';
      startScanMode();
    }
  }

  /* ----------------------------------------------------------------
     Generate QR
  ---------------------------------------------------------------- */
  function generateQR() {
    if (!window.DataGlowQR) { setShareStatus('error', 'QR engine not loaded.'); return; }
    var capsule = window.DataGlowQR.buildCapsule();
    var encoded = window.DataGlowQR.encodeCapsule(capsule);
    if (encoded.length > 2000) {
      setShareStatus('error', 'Session state too large for QR. Try clearing SQL or assumptions first.');
      return;
    }
    var canvas = document.getElementById('dg-qr-canvas');
    setShareStatus('', 'Generating...');
    window.DataGlowQR.renderQR(canvas, encoded, function (err) {
      if (err) { setShareStatus('error', 'QR render failed: ' + err.message); return; }
      setShareStatus('success', 'QR ready. Scan with another DataGlow session to sync.');
    });
  }

  function setShareStatus(type, msg) {
    var el = document.getElementById('dg-qr-share-status');
    if (!el) return;
    el.style.display = msg ? '' : 'none';
    el.className = 'dg-qr-status' + (type ? ' ' + type : '');
    el.textContent = msg;
  }

  /* ----------------------------------------------------------------
     Scanner
  ---------------------------------------------------------------- */
  function startScanMode() {
    if (!window.DataGlowQR) { setScanStatus('error', 'QR engine not loaded.'); return; }
    var videoEl  = document.getElementById('dg-qr-video');
    var stopBtn  = document.getElementById('dg-qr-scan-stop-btn');
    var startBtn = document.getElementById('dg-qr-scan-start-btn');
    if (stopBtn)  stopBtn.style.display  = '';
    if (startBtn) startBtn.style.display = 'none';
    setScanStatus('', 'Camera starting...');

    window.DataGlowQR.startScan(
      videoEl,
      function onResult(capsule) {
        setScanStatus('', 'Applying session...');
        var result = window.DataGlowQR.hydrateCapsule(capsule);
        if (result.ok) {
          var appliedList = result.applied.length
            ? '<ul class="dg-qr-applied-list">' + result.applied.map(function (a) { return '<li>' + a + '</li>'; }).join('') + '</ul>'
            : '';
          setScanStatus('success', 'Session synced from ' + (capsule.dsName || 'remote device') + '.' + appliedList, true);
          document.dispatchEvent(new CustomEvent('dataglow:qr-sync-complete', { detail: { capsule: capsule } }));
        } else {
          setScanStatus('error', 'Could not apply session: ' + (result.reason || 'unknown error'));
        }
        if (stopBtn)  stopBtn.style.display  = 'none';
        if (startBtn) startBtn.style.display = '';
      },
      function onError(err) {
        setScanStatus('error', err.message || 'Camera error');
        if (stopBtn)  stopBtn.style.display  = 'none';
        if (startBtn) startBtn.style.display = '';
      }
    );
  }

  function stopScanMode() {
    if (window.DataGlowQR) window.DataGlowQR.stopScan();
    var stopBtn  = document.getElementById('dg-qr-scan-stop-btn');
    var startBtn = document.getElementById('dg-qr-scan-start-btn');
    if (stopBtn)  stopBtn.style.display  = 'none';
    if (startBtn) startBtn.style.display = '';
  }

  function setScanStatus(type, msg, asHTML) {
    var el = document.getElementById('dg-qr-scan-status');
    if (!el) return;
    el.style.display = msg ? '' : 'none';
    el.className = 'dg-qr-status' + (type ? ' ' + type : '');
    if (asHTML) { el.innerHTML = msg; } else { el.textContent = msg; }
  }

  /* ----------------------------------------------------------------
     Open / close
  ---------------------------------------------------------------- */
  function openPanel() {
    var host = document.getElementById('dg-qr-panel-host');
    if (!host) return;
    host.style.display = 'flex';
    setTimeout(function () { host.classList.add('open'); }, 10);
  }

  function closePanel() {
    stopScanMode();
    var host = document.getElementById('dg-qr-panel-host');
    if (!host) return;
    host.classList.remove('open');
    setTimeout(function () { host.style.display = 'none'; }, 340);
  }

  /* ----------------------------------------------------------------
     Register in overflow grid + tools sheet
  ---------------------------------------------------------------- */
  function registerButtons() {
    /* Desktop overflow grid */
    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('dg-ov-qr')) {
      var btn = document.createElement('button');
      btn.className = 'dg-ov-btn';
      btn.id = 'dg-ov-qr';
      btn.setAttribute('data-testid', 'qr-overflow-btn');
      btn.innerHTML = '<span class="dg-ov-icon">&#x1F4F1;</span><span class="dg-ov-label">QR Sync</span>';
      btn.addEventListener('click', function () {
        var pop = document.getElementById('dg-overflow-popover');
        if (pop) pop.classList.remove('open');
        openPanel();
      });
      ovGrid.appendChild(btn);
    }

    /* Mobile tools sheet */
    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('dg-ts-qr')) {
      var tsBtn = document.createElement('button');
      tsBtn.className = 'dg-ov-btn';
      tsBtn.id = 'dg-ts-qr';
      tsBtn.setAttribute('data-testid', 'qr-tools-btn');
      tsBtn.innerHTML = '<span class="dg-ov-icon">&#x1F4F1;</span><span class="dg-ov-label">QR Sync</span>';
      tsBtn.addEventListener('click', function () {
        var sheet = document.getElementById('agent-more-sheet');
        var overlay = document.getElementById('agent-more-sheet-overlay');
        if (sheet)   sheet.classList.remove('open');
        if (overlay) { overlay.classList.remove('open'); overlay.style.display = 'none'; }
        openPanel();
      });
      tsGrid.appendChild(tsBtn);
    }

    /* Bridge: add "Share via QR" button inside PSI panel initiator if present */
    var psiShareZone = document.getElementById('dg-psi-share-bridge');
    if (psiShareZone && !document.getElementById('dg-psi-qr-bridge-btn')) {
      var bridgeBtn = document.createElement('button');
      bridgeBtn.id = 'dg-psi-qr-bridge-btn';
      bridgeBtn.className = 'dg-qr-btn dg-qr-btn-secondary';
      bridgeBtn.setAttribute('data-testid', 'psi-qr-bridge-btn');
      bridgeBtn.textContent = 'Share via QR instead';
      bridgeBtn.style.marginTop = '8px';
      bridgeBtn.addEventListener('click', function () {
        closePanel();
        openPanel();
      });
      psiShareZone.appendChild(bridgeBtn);
    }
  }

  /* ----------------------------------------------------------------
     Init
  ---------------------------------------------------------------- */
  function init() {
    if (!window.FEATURE_FLAGS || !window.FEATURE_FLAGS.qrTransport) return;
    injectCSS();
    buildPanel();
    setTimeout(registerButtons, 600);
  }

  setTimeout(init, INIT_DELAY);

  window.DataGlowQRPanel = { open: openPanel, close: closePanel };

}());
/* ---- end qr-panel.js ---- */
