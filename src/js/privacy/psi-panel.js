/* ---- from js/privacy/psi-panel.js ---- */
;(function(){
  'use strict';
// ============================================================
// DATAGLOW -- PSI Panel UI
// PR #520 | Private Set Intersection: Dataset Handshake
// ============================================================
// WHAT THIS IS:
//   The UI layer for psi-engine.js. Mounts inside the "PSI" slide-out
//   panel (same pattern as Diplomacy, Meeting, etc.).
//
//   Two modes:
//     INITIATOR (Party A) -- builds a handshake blob and shows it for copy/share.
//     RESPONDER (Party B) -- pastes Party A's blob, processes it, gets results.
//
//   Cross-device / cross-tab delivery is done by copy-paste JSON.
//   Same-tab testing (two datasets in same DataGlow) is also supported.
//
// WHAT IT DOES NOT DO:
//   - No server calls. No WebRTC at this stage (that is Rooms).
//   - Does not send any raw data values anywhere at any time.
//   - Does not store blobs to OPFS (blobs are session-ephemeral).
//
// DEPENDENCIES (injected via window, per DataGlow convention):
//   window.DataGlowPSI  -- psi-engine.js
//   window._dgEl        -- shared el() helper (optional, falls back)
// ============================================================

  var _psi = null; // lazy-resolved after WASM loads

  /* ---- shared el() helper ---- */
  var el = (typeof window._dgEl === 'function') ? window._dgEl
    : function(tag, attrs, children) {
        var node = document.createElement(tag);
        if (attrs) Object.entries(attrs).forEach(function(entry) {
          var k = entry[0], v = entry[1];
          if (k === 'class') node.className = v;
          else if (k === 'style') node.style.cssText = v;
          else node.setAttribute(k, v);
        });
        if (children) [].concat(children).forEach(function(c) {
          node.append(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return node;
      };

  /* ---- toast helper (falls back gracefully) ---- */
  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
  }

  /* ---- CSS ---- */
  var PSI_CSS = [
    '.dg-psi-panel{display:flex;flex-direction:column;gap:0;height:100%;}',
    '.dg-psi-header{padding:20px 20px 12px;border-bottom:1px solid var(--border);}',
    '.dg-psi-header h2{margin:0 0 4px;font-size:17px;font-weight:700;color:var(--text);letter-spacing:-.02em;}',
    '.dg-psi-header p{margin:0;font-size:12px;color:var(--text-muted);line-height:1.5;}',
    '.dg-psi-mode-row{display:flex;gap:8px;padding:14px 20px;border-bottom:1px solid var(--border);}',
    '.dg-psi-mode-btn{flex:1;padding:8px 12px;border-radius:var(--radius-sm,6px);border:1px solid var(--border);background:var(--surface);color:var(--text-muted);font-size:12px;font-weight:600;cursor:pointer;transition:all .18s;}',
    '.dg-psi-mode-btn.active{background:var(--primary);color:#fff;border-color:var(--primary);}',
    '.dg-psi-body{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px;}',
    '.dg-psi-section{display:flex;flex-direction:column;gap:6px;}',
    '.dg-psi-label{font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;}',
    '.dg-psi-select{width:100%;padding:8px 10px;border-radius:var(--radius-sm,6px);border:1px solid var(--border);background:var(--surface-2,var(--surface));color:var(--text);font-size:13px;cursor:pointer;}',
    '.dg-psi-btn{padding:10px 16px;border-radius:var(--radius-sm,6px);border:none;font-size:13px;font-weight:700;cursor:pointer;transition:all .18s;}',
    '.dg-psi-btn-primary{background:var(--primary);color:#fff;}',
    '.dg-psi-btn-primary:hover{background:var(--primary-hover,var(--primary));}',
    '.dg-psi-btn-secondary{background:var(--surface-2,var(--surface));color:var(--text);border:1px solid var(--border);}',
    '.dg-psi-blob-box{font-family:var(--mono,monospace);font-size:10px;background:var(--surface-2,var(--surface));border:1px solid var(--border);border-radius:var(--radius-sm,6px);padding:10px;max-height:120px;overflow-y:auto;word-break:break-all;color:var(--text-muted);white-space:pre-wrap;user-select:all;}',
    '.dg-psi-result{background:var(--proof-bg,rgba(45,155,111,.08));border:1.5px solid var(--proof,#2D9B6F);border-radius:var(--radius-md,12px);padding:18px 20px;display:flex;flex-direction:column;gap:8px;}',
    '.dg-psi-result-count{font-size:40px;font-weight:800;color:var(--proof,#2D9B6F);line-height:1;font-variant-numeric:tabular-nums;}',
    '.dg-psi-result-label{font-size:12px;color:var(--text-muted);font-weight:600;}',
    '.dg-psi-result-note{font-size:11px;color:var(--text-faint,#999);line-height:1.5;margin-top:4px;}',
    '.dg-psi-matches{background:var(--surface-2,var(--surface));border:1px solid var(--border);border-radius:var(--radius-sm,6px);padding:10px;max-height:160px;overflow-y:auto;}',
    '.dg-psi-match-chip{display:inline-block;background:var(--proof-bg,rgba(45,155,111,.12));color:var(--proof,#2D9B6F);border-radius:20px;padding:3px 10px;font-size:11px;font-weight:600;margin:2px;font-family:var(--mono,monospace);}',
    '.dg-psi-spinner{width:18px;height:18px;border:2.5px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:dg-spin .7s linear infinite;display:inline-block;vertical-align:middle;margin-right:8px;}',
    '.dg-psi-status{font-size:12px;color:var(--text-muted);padding:8px 0;display:flex;align-items:center;gap:6px;}',
    '.dg-psi-warning{background:var(--flag-bg,rgba(200,123,42,.08));border:1px solid var(--flag,#C87B2A);border-radius:var(--radius-sm,6px);padding:10px 12px;font-size:11px;color:var(--flag,#C87B2A);line-height:1.5;}',
    '.dg-psi-textarea{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:var(--radius-sm,6px);border:1px solid var(--border);background:var(--surface-2,var(--surface));color:var(--text);font-size:11px;font-family:var(--mono,monospace);min-height:80px;resize:vertical;}',
    '@keyframes dg-spin{to{transform:rotate(360deg)}}',
  ].join('');

  function injectStyles() {
    if (document.getElementById('dg-psi-styles')) return;
    var style = document.createElement('style');
    style.id  = 'dg-psi-styles';
    style.textContent = PSI_CSS;
    document.head.appendChild(style);
  }

  /* ---- dataset picker helpers ---- */
  function getLoadedTables() {
    // DataGlow stores the loaded dataset in window._dgState or similar
    var state = window._dgState || window.DataGlowState || {};
    var tables = [];
    // Try the canonical store
    if (state.tables && typeof state.tables === 'object') {
      Object.keys(state.tables).forEach(function(k) {
        tables.push({ name: k, data: state.tables[k] });
      });
    }
    // Fallback: single loaded dataset
    if (!tables.length && state.rows && state.columns) {
      tables.push({ name: state.fileName || 'Current Dataset', data: state });
    }
    // Second fallback: window._dgLoadedDataset (set by drop-zone)
    if (!tables.length && window._dgLoadedDataset) {
      tables.push({ name: window._dgLoadedDataset.fileName || 'Loaded Dataset', data: window._dgLoadedDataset });
    }
    return tables;
  }

  function getColumns(tableData) {
    if (!tableData) return [];
    var cols = tableData.columns || tableData.cols || [];
    return cols.map(function(c, i) {
      return { name: (typeof c === 'string' ? c : (c.name || c.id || ('col_' + i))), idx: i };
    });
  }

  /* ---- Copy to clipboard ---- */
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        toast('Copied to clipboard', 'success');
      }).catch(function() {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('Copied', 'success');
  }

  /* ====================================================
   * mountPSIPanel
   * Main entry point. Renders into `host` container.
   * ==================================================== */
  function mountPSIPanel(host) {
    injectStyles();

    var mode    = 'initiator'; // 'initiator' | 'responder'
    var session = null;
    var handshakeBlob = null;

    /* ---- root panel ---- */
    var panel = el('div', { class: 'dg-psi-panel', 'data-testid': 'psi-panel' });
    host.appendChild(panel);

    /* ---- header ---- */
    var header = el('div', { class: 'dg-psi-header' }, [
      el('h2', {}, 'Dataset Handshake'),
      el('p', {}, 'Discover shared rows with another analyst. Zero raw data leaves either device. No server. No API key.'),
    ]);
    panel.appendChild(header);

    /* ---- mode switcher ---- */
    var modeRow  = el('div', { class: 'dg-psi-mode-row' });
    var btnInit  = el('button', { class: 'dg-psi-mode-btn active', 'data-testid': 'psi-mode-initiator' }, 'Step 1: Start Handshake');
    var btnResp  = el('button', { class: 'dg-psi-mode-btn', 'data-testid': 'psi-mode-responder' }, 'Step 2: Respond');
    modeRow.append(btnInit, btnResp);
    panel.appendChild(modeRow);

    /* ---- body (re-rendered on mode switch) ---- */
    var body = el('div', { class: 'dg-psi-body', 'data-testid': 'psi-body' });
    panel.appendChild(body);

    function switchMode(m) {
      mode = m;
      btnInit.classList.toggle('active', m === 'initiator');
      btnResp.classList.toggle('active', m === 'responder');
      renderBody();
    }

    btnInit.addEventListener('click', function() { switchMode('initiator'); });
    btnResp.addEventListener('click', function() { switchMode('responder'); });

    /* ================================================
     * INITIATOR VIEW (Party A)
     * ============================================== */
    function renderInitiator() {
      body.innerHTML = '';

      var tables  = getLoadedTables();

      if (!tables.length) {
        body.appendChild(el('div', { class: 'dg-psi-warning' },
          'No dataset loaded. Drop a CSV or connect a file first, then come back here.'));
        return;
      }

      /* Table selector */
      var tableSection = el('div', { class: 'dg-psi-section' });
      tableSection.appendChild(el('div', { class: 'dg-psi-label' }, 'Your Dataset'));
      var tableSelect = el('select', { class: 'dg-psi-select', 'data-testid': 'psi-table-select' });
      tables.forEach(function(t, i) {
        var opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = t.name;
        tableSelect.appendChild(opt);
      });
      tableSection.appendChild(tableSelect);
      body.appendChild(tableSection);

      /* Column selector */
      var colSection = el('div', { class: 'dg-psi-section' });
      colSection.appendChild(el('div', { class: 'dg-psi-label' }, 'Match Column (the key both sides share)'));
      var colSelect = el('select', { class: 'dg-psi-select', 'data-testid': 'psi-col-select' });
      colSection.appendChild(colSelect);
      body.appendChild(colSection);

      function refreshCols() {
        colSelect.innerHTML = '';
        var tIdx = parseInt(tableSelect.value, 10);
        var cols = getColumns(tables[tIdx] ? tables[tIdx].data : null);
        if (!cols.length) {
          var opt = document.createElement('option');
          opt.textContent = 'No columns found';
          colSelect.appendChild(opt);
          return;
        }
        cols.forEach(function(c) {
          var opt = document.createElement('option');
          opt.value = String(c.idx);
          opt.textContent = c.name;
          colSelect.appendChild(opt);
        });
      }
      tableSelect.addEventListener('change', refreshCols);
      refreshCols();

      /* Status display */
      var statusDiv = el('div', { class: 'dg-psi-status', style: 'display:none;' });
      body.appendChild(statusDiv);

      /* Build button */
      var buildBtn = el('button', {
        class: 'dg-psi-btn dg-psi-btn-primary',
        'data-testid': 'psi-build-btn',
        style: 'width:100%;',
      }, 'Build Handshake Blob');

      body.appendChild(buildBtn);

      /* Result area (shown after build) */
      var resultArea = el('div', { style: 'display:none;' });
      body.appendChild(resultArea);

      buildBtn.addEventListener('click', function() {
        var tIdx   = parseInt(tableSelect.value, 10);
        var colIdx = parseInt(colSelect.value, 10);
        var tableData = tables[tIdx] ? tables[tIdx].data : null;
        if (!tableData) { toast('No dataset selected', 'error'); return; }

        var rows = tableData.rows || tableData.data || [];
        if (!rows.length) { toast('Dataset has no rows', 'error'); return; }

        buildBtn.disabled = true;
        statusDiv.style.display = 'flex';
        statusDiv.innerHTML = '<span class="dg-psi-spinner"></span>Loading WASM...';

        var PSI = window.DataGlowPSI;
        if (!PSI) { toast('PSI engine not loaded', 'error'); buildBtn.disabled = false; return; }

        session = PSI.getOrCreateSession();

        session.init().then(function() {
          statusDiv.innerHTML = '<span class="dg-psi-spinner"></span>Building cryptographic handshake...';
          return new Promise(function(resolve, reject) {
            setTimeout(function() {
              try {
                handshakeBlob = session.startHandshake(rows, colIdx, { revealIntersection: true });
                resolve();
              } catch(e) {
                reject(e);
              }
            }, 0);
          });
        }).then(function() {
          statusDiv.style.display = 'none';
          buildBtn.disabled = false;
          showHandshakeResult(resultArea, handshakeBlob, rows, colIdx);
        }).catch(function(err) {
          statusDiv.style.display = 'none';
          buildBtn.disabled = false;
          toast('PSI error: ' + (err.message || String(err)), 'error');
        });
      });
    }

    function showHandshakeResult(container, blob, rows, colIdx) {
      container.style.display = 'block';
      container.innerHTML = '';

      var blobStr = JSON.stringify(blob);

      container.appendChild(el('div', { class: 'dg-psi-label' }, 'Step 1 Complete'));
      container.appendChild(el('div', { class: 'dg-psi-warning', style: 'margin-bottom:4px;' },
        'Your dataset has ' + rows.length + ' rows. The blob below is a cryptographic ciphertext -- no raw values are included.'));

      var blobBox = el('div', { class: 'dg-psi-blob-box', 'data-testid': 'psi-blob-box' }, blobStr);
      container.appendChild(blobBox);

      var copyBtn = el('button', {
        class: 'dg-psi-btn dg-psi-btn-secondary',
        'data-testid': 'psi-copy-blob',
        style: 'width:100%;margin-top:6px;',
      }, 'Copy Handshake Blob');
      copyBtn.addEventListener('click', function() { copyToClipboard(blobStr); });
      container.appendChild(copyBtn);

      container.appendChild(el('div', { class: 'dg-psi-label', style: 'margin-top:12px;' },
        'Step 2: Send this blob to the other analyst'));
      container.appendChild(el('p', { style: 'font-size:11px;color:var(--text-muted);line-height:1.6;margin:0;' },
        'Have them open DataGlow, go to PSI, click "Step 2: Respond", paste the blob, and load their dataset. They will send you back a Response Blob.'));

      /* Step 3: paste response blob from Party B */
      container.appendChild(el('div', { class: 'dg-psi-label', style: 'margin-top:14px;' }, 'Step 3: Paste Response Blob'));
      var responseTextarea = el('textarea', {
        class: 'dg-psi-textarea',
        'data-testid': 'psi-response-input',
        placeholder: 'Paste the Response Blob from the other analyst here...',
      });
      container.appendChild(responseTextarea);

      var computeBtn = el('button', {
        class: 'dg-psi-btn dg-psi-btn-primary',
        'data-testid': 'psi-compute-btn',
        style: 'width:100%;margin-top:6px;',
      }, 'Compute Intersection');

      container.appendChild(computeBtn);

      var finalResultDiv = el('div', { style: 'display:none;' });
      container.appendChild(finalResultDiv);

      computeBtn.addEventListener('click', function() {
        var raw = responseTextarea.value.trim();
        if (!raw) { toast('Paste the Response Blob first', 'error'); return; }

        var responseBlob;
        try { responseBlob = JSON.parse(raw); } catch(e) { toast('Invalid JSON blob', 'error'); return; }

        computeBtn.disabled = true;
        try {
          var result = session.finish(responseBlob);
          computeBtn.disabled = false;
          showFinalResult(finalResultDiv, result, rows.length, responseBlob.numElementsB || '?');
        } catch(e) {
          computeBtn.disabled = false;
          toast('Compute error: ' + (e.message || String(e)), 'error');
        }
      });
    }

    /* ================================================
     * RESPONDER VIEW (Party B)
     * ============================================== */
    function renderResponder() {
      body.innerHTML = '';

      var tables = getLoadedTables();

      /* Paste Party A's blob */
      var pasteSection = el('div', { class: 'dg-psi-section' });
      pasteSection.appendChild(el('div', { class: 'dg-psi-label' }, 'Step 2: Paste Handshake Blob from Party A'));
      var pasteArea = el('textarea', {
        class: 'dg-psi-textarea',
        'data-testid': 'psi-paste-blob',
        placeholder: 'Paste the Handshake Blob from the initiating analyst...',
        style: 'min-height:90px;',
      });
      pasteSection.appendChild(pasteArea);
      body.appendChild(pasteSection);

      if (!tables.length) {
        body.appendChild(el('div', { class: 'dg-psi-warning' },
          'No dataset loaded. Drop a CSV first, then paste the blob above.'));
      }

      /* Table selector */
      var tableSection = el('div', { class: 'dg-psi-section' });
      tableSection.appendChild(el('div', { class: 'dg-psi-label' }, 'Your Dataset'));
      var tableSelect = el('select', { class: 'dg-psi-select', 'data-testid': 'psi-resp-table-select' });
      tables.forEach(function(t, i) {
        var opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = t.name;
        tableSelect.appendChild(opt);
      });
      tableSection.appendChild(tableSelect);
      body.appendChild(tableSection);

      /* Column selector */
      var colSection = el('div', { class: 'dg-psi-section' });
      colSection.appendChild(el('div', { class: 'dg-psi-label' }, 'Match Column'));
      var colSelect = el('select', { class: 'dg-psi-select', 'data-testid': 'psi-resp-col-select' });
      colSection.appendChild(colSelect);
      body.appendChild(colSection);

      function refreshCols() {
        colSelect.innerHTML = '';
        var tIdx = parseInt(tableSelect.value, 10);
        var cols = getColumns(tables[tIdx] ? tables[tIdx].data : null);
        cols.forEach(function(c) {
          var opt = document.createElement('option');
          opt.value = String(c.idx);
          opt.textContent = c.name;
          colSelect.appendChild(opt);
        });
      }
      tableSelect.addEventListener('change', refreshCols);
      refreshCols();

      var statusDiv = el('div', { class: 'dg-psi-status', style: 'display:none;' });
      body.appendChild(statusDiv);

      var respondBtn = el('button', {
        class: 'dg-psi-btn dg-psi-btn-primary',
        'data-testid': 'psi-respond-btn',
        style: 'width:100%;',
      }, 'Process + Generate Response Blob');
      body.appendChild(respondBtn);

      var responseArea = el('div', { style: 'display:none;' });
      body.appendChild(responseArea);

      respondBtn.addEventListener('click', function() {
        var raw = pasteArea.value.trim();
        if (!raw) { toast('Paste the Handshake Blob first', 'error'); return; }

        var partyABlob;
        try { partyABlob = JSON.parse(raw); } catch(e) { toast('Invalid JSON blob', 'error'); return; }

        var tIdx   = parseInt(tableSelect.value, 10);
        var colIdx = parseInt(colSelect.value, 10);
        var tableData = tables[tIdx] ? tables[tIdx].data : null;
        if (!tableData) { toast('No dataset selected', 'error'); return; }

        var rows = tableData.rows || tableData.data || [];
        if (!rows.length) { toast('Dataset has no rows', 'error'); return; }

        respondBtn.disabled = true;
        statusDiv.style.display = 'flex';
        statusDiv.innerHTML = '<span class="dg-psi-spinner"></span>Loading WASM...';

        var PSI = window.DataGlowPSI;
        if (!PSI) { toast('PSI engine not loaded', 'error'); respondBtn.disabled = false; return; }

        var sessionB = new PSI.PSISession();

        sessionB.init().then(function() {
          statusDiv.innerHTML = '<span class="dg-psi-spinner"></span>Computing intersection protocol...';
          return new Promise(function(resolve, reject) {
            setTimeout(function() {
              try {
                var responseBlob = sessionB.respond(partyABlob, rows, colIdx);
                resolve(responseBlob);
              } catch(e) {
                reject(e);
              }
            }, 0);
          });
        }).then(function(responseBlob) {
          statusDiv.style.display = 'none';
          respondBtn.disabled = false;
          showResponseBlob(responseArea, responseBlob, rows);
        }).catch(function(err) {
          statusDiv.style.display = 'none';
          respondBtn.disabled = false;
          toast('PSI error: ' + (err.message || String(err)), 'error');
        });
      });
    }

    function showResponseBlob(container, blob, rows) {
      container.style.display = 'block';
      container.innerHTML = '';

      var blobStr = JSON.stringify(blob);

      container.appendChild(el('div', { class: 'dg-psi-label' }, 'Response Blob Ready'));
      container.appendChild(el('div', { class: 'dg-psi-warning', style: 'margin-bottom:4px;' },
        rows.length + ' rows processed. No raw values in this blob.'));

      var blobBox = el('div', { class: 'dg-psi-blob-box', 'data-testid': 'psi-response-blob-box' }, blobStr);
      container.appendChild(blobBox);

      var copyBtn = el('button', {
        class: 'dg-psi-btn dg-psi-btn-secondary',
        'data-testid': 'psi-copy-response',
        style: 'width:100%;margin-top:6px;',
      }, 'Copy Response Blob');
      copyBtn.addEventListener('click', function() { copyToClipboard(blobStr); });
      container.appendChild(copyBtn);

      container.appendChild(el('p', { style: 'font-size:11px;color:var(--text-muted);line-height:1.6;margin:8px 0 0;' },
        'Send this Response Blob back to Party A. They paste it in Step 3 of their panel to see the final intersection count.'));
    }

    /* ================================================
     * FINAL RESULT (shown to Party A after compute)
     * ============================================== */
    function showFinalResult(container, result, totalA, totalB) {
      container.style.display = 'block';
      container.innerHTML = '';

      var count = result.count || 0;
      var matches = result.matches || [];

      container.appendChild(el('div', { class: 'dg-psi-result', 'data-testid': 'psi-result' }, [
        el('div', { class: 'dg-psi-result-count', 'data-testid': 'psi-result-count' }, String(count)),
        el('div', { class: 'dg-psi-result-label' }, 'Shared rows found'),
        el('div', { class: 'dg-psi-result-note' },
          'Your dataset: ' + totalA + ' rows. Their dataset: ' + totalB + ' rows. ' +
          'Intersection computed without either party seeing the other\'s raw data.'),
      ]));

      if (matches.length > 0) {
        container.appendChild(el('div', { class: 'dg-psi-label', style: 'margin-top:6px;' },
          'Matched Values (shared column)'));
        var matchBox = el('div', { class: 'dg-psi-matches', 'data-testid': 'psi-matches' });
        matches.slice(0, 200).forEach(function(m) {
          matchBox.appendChild(el('span', { class: 'dg-psi-match-chip' }, String(m)));
        });
        if (matches.length > 200) {
          matchBox.appendChild(el('span', { class: 'dg-psi-match-chip', style: 'background:var(--flag-bg);color:var(--flag);' },
            '+' + (matches.length - 200) + ' more'));
        }
        container.appendChild(matchBox);
      }

      /* Proof chain event */
      try {
        document.dispatchEvent(new CustomEvent('dataglow:psi-complete', {
          detail: {
            count:    count,
            totalA:   totalA,
            totalB:   totalB,
            hasMatches: matches.length > 0,
            timestamp: Date.now(),
          }
        }));
      } catch(e) {}
    }

    /* ---- initial render ---- */
    function renderBody() {
      if (mode === 'initiator') renderInitiator();
      else renderResponder();
    }

    renderBody();
  }

  /* ====================================================
   * initUI_dg_psi
   * Registers the PSI button in the overflow grid and
   * tools sheet (same pattern as all other overflow panels).
   * ==================================================== */
  function initUI_dg_psi() {
    var panelId = 'dg-psi-panel-host';

    function toggle() {
      var p = document.getElementById(panelId);
      if (!p) {
        p = document.createElement('div');
        p.id = panelId;
        p.style.cssText = [
          'position:fixed;top:0;right:0;',
          'width:480px;max-width:100vw;height:100vh;',
          'background:var(--surface,#fff);',
          'border-left:1px solid var(--border,#e5e5e5);',
          'z-index:861;overflow-y:auto;',
          'box-shadow:-8px 0 32px rgba(0,0,0,.18);',
        ].join('');
        document.body.appendChild(p);
      }

      if (p.style.display === 'none' || !p.style.display) {
        p.style.display = 'block';
        p.innerHTML = '';

        /* Close button */
        var cx = document.createElement('button');
        cx.textContent = '\u00D7';
        cx.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;z-index:1;';
        cx.addEventListener('click', function() { p.style.display = 'none'; });
        p.appendChild(cx);

        mountPSIPanel(p);
      } else {
        p.style.display = 'none';
      }
    }

    /* Overflow grid (desktop More popover) */
    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('dg-ov-psi')) {
      var btn = document.createElement('button');
      btn.id        = 'dg-ov-psi';
      btn.className = 'dg-ov-btn';
      btn.setAttribute('data-testid', 'psi-overflow-btn');
      btn.innerHTML = '\uD83D\uDD17<br><span>Handshake</span>';
      btn.addEventListener('click', function() {
        ['dg-overflow-popover', 'dg-overflow-overlay'].forEach(function(id) {
          var e2 = document.getElementById(id);
          if (e2) e2.classList.remove('open');
        });
        toggle();
      });
      ovGrid.appendChild(btn);
    }

    /* Mobile tools sheet */
    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('dg-ts-psi')) {
      var btn2 = document.createElement('button');
      btn2.id        = 'dg-ts-psi';
      btn2.className = 'dg-ov-btn';
      btn2.setAttribute('data-testid', 'psi-tools-btn');
      btn2.innerHTML = '\uD83D\uDD17<br><span>Handshake</span>';
      btn2.addEventListener('click', function() {
        var sh = document.getElementById('dg-tools-sheet');
        if (sh) sh.classList.remove('open');
        toggle();
      });
      tsGrid.appendChild(btn2);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI_dg_psi);
  } else {
    setTimeout(initUI_dg_psi, 1100); // after diplomacy-ui's 1000ms
  }

  /* Public surface */
  window.DataGlowPSIPanel = {
    mount: mountPSIPanel,
  };

}());
/* ---- end psi-panel.js ---- */
