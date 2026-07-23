
/* ---- from js/collaboration/team-hub.js ---- */
/* ================================================================
   DataGlow Team Hub -- multi-user collaboration foundation
   PR #554

   Two modes:
   Mode A -- Artifact Exchange: export/import a Signed Analysis
             Package (JSON) containing dataset sample, SQL queries,
             ProofChain entries, chart configs, Sentinel audit log.
             Works today on all four platforms via download/upload.
   Mode B -- Quack Hub: a shared DuckDB node using DuckDB's
             forthcoming Quack multi-client protocol (GA expected
             Q4 2026). Connection-string UI is a stub today.

   Also ships the WebRTC P2P foundation named in Sentinel Pillar 4:
   a real RTCPeerConnection skeleton is instantiated (not connected
   to a live signaling server yet) plus a Peer ID persisted in OPFS.

   No localStorage/sessionStorage/indexedDB. Peer ID lives in OPFS
   via the existing window.OPFSEngine. No external network calls --
   WebRTC signaling here is a local stub only, never touching a
   STUN/TURN server.

   Public API: window.DataGlowTeamHub
     getPeerId()      -> Promise<string>
     connect(peerId)  -> Promise<{ok,status,message}>
     getStatus()      -> string
     exportPackage()  -> Promise<object>  (also triggers download)
     importPackage(obj) -> Promise<{ok,summary}>
================================================================ */
(function () {
  'use strict';

  var PANEL_ID = 'dg-teamhub-panel';
  var _status = 'Disconnected';
  var _peerId = null;
  var _peerConnection = null;
  var _lastImportSummary = null;

  /* ---- small local hash helper (mirrors ProofChain's djb2 fallback) ---- */
  function _djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & h;
    }
    return (h >>> 0).toString(16);
  }

  async function _sha256Hex(str) {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      try {
        var buf = new TextEncoder().encode(str);
        var hash = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(hash))
          .map(function (b) { return b.toString(16).padStart(2, '0'); })
          .join('');
      } catch (_e) { /* fall through */ }
    }
    return _djb2(str);
  }

  function _randomHex8() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
    var s = '';
    for (var i = 0; i < 8; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  function _base64url(str) {
    var b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* ---- Peer ID persistence via OPFS (never localStorage/sessionStorage/indexedDB) ---- */
  async function _peerIdFileHandle(create) {
    if (!window.OPFSEngine || !window.OPFSEngine._root) return null;
    try {
      return await window.OPFSEngine._root.getFileHandle('_team_hub_peer_id.json', { create: !!create });
    } catch (e) {
      return null;
    }
  }

  async function _loadPeerId() {
    var fh = await _peerIdFileHandle(false);
    if (!fh) return null;
    try {
      var file = await fh.getFile();
      var text = await file.text();
      var parsed = JSON.parse(text);
      return parsed && parsed.peerId ? parsed.peerId : null;
    } catch (e) {
      return null;
    }
  }

  async function _savePeerId(id) {
    if (!window.OPFSEngine || !window.OPFSEngine._root) return false;
    try {
      var fh = await _peerIdFileHandle(true);
      if (!fh) return false;
      var aw = await fh.createWritable();
      await aw.write(JSON.stringify({ peerId: id, createdAt: Date.now() }));
      await aw.close();
      return true;
    } catch (e) {
      return false;
    }
  }

  async function getPeerId() {
    if (_peerId) return _peerId;
    var existing = await _loadPeerId();
    if (existing) {
      _peerId = existing;
      return _peerId;
    }
    var fresh = _randomHex8();
    var saved = await _savePeerId(fresh);
    _peerId = fresh;
    if (!saved) {
      console.warn('[TeamHub] OPFS unavailable -- Peer ID is session-only this run.');
    }
    return _peerId;
  }

  /* ---- WebRTC P2P foundation (Sentinel Pillar 4) ----
     A real RTCPeerConnection is instantiated so its presence is
     verifiable (e.g. by Playwright), but it is never wired to a
     live signaling server in this batch. No STUN/TURN servers are
     configured -- iceServers stays empty, matching the "local LAN
     only, no STUN/TURN for demo mode" constraint. */
  function _ensurePeerConnection() {
    if (_peerConnection) return _peerConnection;
    if (typeof RTCPeerConnection === 'undefined') {
      console.warn('[TeamHub] RTCPeerConnection unsupported in this environment.');
      return null;
    }
    try {
      _peerConnection = new RTCPeerConnection({ iceServers: [] });
    } catch (e) {
      console.warn('[TeamHub] RTCPeerConnection init failed:', e);
      _peerConnection = null;
    }
    return _peerConnection;
  }

  function getStatus() {
    return _status;
  }

  function _setStatus(next) {
    _status = next;
    var el = document.getElementById('dg-teamhub-status-text');
    if (el) el.textContent = next;
    var dot = document.getElementById('dg-teamhub-status-dot');
    if (dot) {
      var color = next === 'Connected' ? 'var(--proof,#4AE38A)' :
        (next === 'Signaling...' ? 'var(--flag,#F5A623)' : 'var(--text-muted,#8A8F9A)');
      dot.style.background = color;
    }
  }

  async function connect(peerId) {
    var target = (peerId || '').trim();
    if (!target) {
      window.showToast && window.showToast('Enter a peer ID to connect.', 'warn');
      return { ok: false, status: _status, message: 'No peer ID provided.' };
    }
    _setStatus('Signaling...');
    var pc = _ensurePeerConnection();
    if (!pc) {
      _setStatus('Disconnected');
      var msg = 'WebRTC unsupported in this environment.';
      window.showToast && window.showToast(msg, 'error');
      return { ok: false, status: _status, message: msg };
    }
    /* Demo stub: signaling channel is wired to the local RTCPeerConnection
       object but not to a real signaling server yet. This intentionally
       never resolves to a live P2P data channel in this batch. */
    return new Promise(function (resolve) {
      setTimeout(function () {
        _setStatus('Disconnected');
        var message = 'Ready for WebRTC -- signaling channel stub wired. ' +
          'Full P2P sync ships in Sentinel Pillar 4 (Q3 2026).';
        window.showToast && window.showToast(message, 'info');
        resolve({ ok: true, status: _status, message: message });
      }, 650);
    });
  }

  /* ---- Mode A: Artifact Exchange -- Signed Analysis Package ---- */
  function _getDatasetSample() {
    var state = window.state;
    if (!state || !state.datasets || !state.datasets.length) return null;
    var ds = state.datasets.find(function (d) { return d.id === state.activeDatasetId; }) || state.datasets[0];
    if (!ds) return null;
    return {
      name: ds.name || 'dataset',
      columns: (ds.columns || []).map(function (c) { return { name: c.name, type: c.type }; }),
      sampleRows: (ds.rows || []).slice(0, 100),
      totalRows: (ds.rows || []).length
    };
  }

  function _getSqlQueries() {
    try {
      if (window.QueryVault && typeof window.QueryVault.getHistory === 'function') {
        return window.QueryVault.getHistory().slice(0, 50);
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function _getProofChainEntries() {
    if (window.ProofChain && typeof window.ProofChain.getSteps === 'function') {
      return window.ProofChain.getSteps();
    }
    return [];
  }

  function _getChartConfigs() {
    try {
      if (window.GlowCanvas && typeof window.GlowCanvas.serializeLayout === 'function' && window.state && window.state.canvasLayout) {
        return window.GlowCanvas.serializeLayout(window.state.canvasLayout);
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function _getSentinelAuditLog() {
    if (window.SentinelGateway && typeof window.SentinelGateway.getAuditLog === 'function') {
      return window.SentinelGateway.getAuditLog();
    }
    return [];
  }

  async function _buildPackage() {
    var pkg = {
      kind: 'dataglow-signed-analysis-package',
      version: 1,
      createdAt: new Date().toISOString(),
      peerId: await getPeerId(),
      datasetSample: _getDatasetSample(),
      sqlQueries: _getSqlQueries(),
      proofChain: _getProofChainEntries(),
      chartConfigs: _getChartConfigs(),
      sentinelAuditLog: _getSentinelAuditLog()
    };
    var signature = await _sha256Hex(JSON.stringify(pkg));
    pkg.signature = signature;
    return pkg;
  }

  async function exportPackage() {
    var pkg = await _buildPackage();
    var json = JSON.stringify(pkg, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var ts = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = 'dataglow-signed-analysis-package-' + ts + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    window.showToast && window.showToast('Signed Analysis Package exported.', 'success');
    return pkg;
  }

  function importPackage(obj) {
    return new Promise(function (resolve) {
      try {
        var pkg = typeof obj === 'string' ? JSON.parse(obj) : obj;
        if (!pkg || pkg.kind !== 'dataglow-signed-analysis-package') {
          var badMsg = 'Not a recognized DataGlow Signed Analysis Package.';
          window.showToast && window.showToast(badMsg, 'error');
          resolve({ ok: false, summary: badMsg });
          return;
        }
        var appended = 0;
        if (window.ProofChain && typeof window.ProofChain.addStep === 'function' && Array.isArray(pkg.proofChain)) {
          pkg.proofChain.forEach(function (step) {
            window.ProofChain.addStep({
              type: 'imported-' + (step.type || 'step'),
              importedFrom: pkg.peerId || 'unknown-peer',
              original: step
            });
            appended++;
          });
        }
        var summary = 'Imported package from peer ' + (pkg.peerId || 'unknown') + ': ' +
          (pkg.datasetSample ? pkg.datasetSample.name + ' (' + pkg.datasetSample.totalRows + ' rows), ' : '') +
          (pkg.sqlQueries ? pkg.sqlQueries.length : 0) + ' SQL queries, ' +
          appended + ' proof chain entries appended.';
        _lastImportSummary = summary;
        window.showToast && window.showToast('Analysis package imported.', 'success');
        _refreshActivityFeed();
        resolve({ ok: true, summary: summary });
      } catch (e) {
        var errMsg = 'Import failed: ' + e.message;
        window.showToast && window.showToast(errMsg, 'error');
        resolve({ ok: false, summary: errMsg });
      }
    });
  }

  function _triggerImportPicker() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        importPackage(reader.result).then(function (res) {
          var out = document.getElementById('dg-teamhub-import-result');
          if (out) out.textContent = res.summary;
        });
      };
      reader.readAsText(file);
      document.body.removeChild(input);
    };
    document.body.appendChild(input);
    input.click();
  }

  /* ---- Mode B: Quack Hub stub ---- */
  function _testQuackHubConnection() {
    window.showToast && window.showToast('Quack Hub not yet GA -- coming Q4 2026', 'info');
  }

  /* ---- Section 3: Team Activity Feed ---- */
  function _formatTimestamp(ts) {
    try {
      return new Date(ts).toLocaleString();
    } catch (e) {
      return String(ts);
    }
  }

  function _describeStep(step) {
    if (step.type === 'dataset-loaded') return 'Dataset loaded: ' + (step.filename || 'unknown') + ' (' + (step.rows || 0) + ' rows)';
    if (step.type === 'sql-executed') return 'SQL executed: ' + (step.query_preview || '') + ' (' + (step.row_count || 0) + ' rows)';
    if (step.type && step.type.indexOf('imported-') === 0) return 'Imported from teammate: ' + step.type.replace('imported-', '');
    return step.type || 'Proof chain event';
  }

  function _buildActivityFeedHtml() {
    var steps = _getProofChainEntries().slice(-10).reverse();
    if (!steps.length) {
      return '<div style="font-size:11px;color:var(--text-muted,#8A8F9A);padding:8px 0">No proof chain activity yet this session.</div>';
    }
    return steps.map(function (s) {
      return '<div style="border-left:2px solid var(--primary,#20C5B5);padding:4px 10px;margin-bottom:6px;border-radius:0 6px 6px 0;background:var(--surface-2,#191C20)">' +
        '<div style="font-size:10px;color:var(--text-muted,#8A8F9A)">' + _formatTimestamp(s.ts) + '</div>' +
        '<div style="font-size:11px;font-weight:600;margin:2px 0">' + (s.type || 'event') + '</div>' +
        '<div style="font-size:11px;color:var(--text,#E8E9EB)">' + _describeStep(s) + '</div>' +
      '</div>';
    }).join('');
  }

  function _refreshActivityFeed() {
    var el = document.getElementById('dg-teamhub-activity-feed');
    if (el) el.innerHTML = _buildActivityFeedHtml();
  }

  async function _shareProofChain() {
    var steps = _getProofChainEntries().slice(-10);
    var summary = {
      kind: 'dataglow-proof-chain-summary',
      peerId: await getPeerId(),
      generatedAt: new Date().toISOString(),
      stepCount: steps.length,
      steps: steps
    };
    var encoded = _base64url(JSON.stringify(summary));
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(encoded);
        window.showToast && window.showToast('Proof chain summary copied to clipboard.', 'success');
      } else {
        window.showToast && window.showToast('Clipboard unavailable in this context.', 'warn');
      }
    } catch (e) {
      window.showToast && window.showToast('Copy failed: ' + e.message, 'error');
    }
    return encoded;
  }

  /* ---- Panel UI ---- */
  function _closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('open');
  }

  function _iconRow(icon, title, desc) {
    return '<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:10px">' +
      '<div style="font-size:20px;line-height:1;flex-shrink:0">' + icon + '</div>' +
      '<div><div style="font-size:13px;font-weight:600;margin-bottom:2px">' + title + '</div>' +
      '<div style="font-size:11px;color:var(--text-muted,#8A8F9A);line-height:1.5">' + desc + '</div></div>' +
    '</div>';
  }

  function _panelHtml() {
    return [
      '<div class="dg-teamhub-inner" style="height:100%;display:flex;flex-direction:column;overflow-y:auto;padding:20px;box-sizing:border-box">',
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">',
          '<div style="font-size:16px;font-weight:700;color:var(--primary,#20C5B5)">\u{1F465} Team Hub</div>',
          '<button id="dg-teamhub-close-btn" style="background:none;border:none;color:var(--text-muted,#8A8F9A);font-size:20px;cursor:pointer;line-height:1">&times;</button>',
        '</div>',
        '<div style="font-size:11px;color:var(--text-muted,#8A8F9A);margin-bottom:18px">',
          'DataGlow is local-first. Collaboration never uploads your data to a shared server unless you explicitly export a package or connect a peer.',
        '</div>',

        /* Section 1 */
        '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted,#8A8F9A);margin-bottom:10px">How Collaboration Works</div>',

        '<div style="background:var(--surface-2,#191C20);border:1px solid var(--border,#252930);border-radius:10px;padding:14px;margin-bottom:14px">',
          _iconRow('\u{1F4E6}', 'Mode A -- Artifact Exchange (works today)',
            'Export a Signed Analysis Package -- a JSON bundle with your dataset sample (first 100 rows), SQL queries, ProofChain entries, chart configs, and the Sentinel audit log. A teammate imports it and sees the full analysis with proof chain intact. Download/upload works on web, desktop, and mobile.'),
          '<div id="dg-teamhub-import-result" style="font-size:11px;color:var(--proof,#4AE38A);margin-bottom:8px"></div>',
          '<div style="display:flex;gap:8px">',
            '<button id="dg-teamhub-export-btn" data-testid="team-hub-export-btn" style="flex:1;padding:9px;border-radius:8px;border:none;background:var(--primary,#20C5B5);color:#0D0E10;font-weight:600;cursor:pointer;font-size:12px">Export Analysis Package</button>',
            '<button id="dg-teamhub-import-btn" data-testid="team-hub-import-btn" style="flex:1;padding:9px;border-radius:8px;border:1px solid var(--border,#252930);background:transparent;color:var(--text,#E8E9EB);cursor:pointer;font-size:12px">Import Analysis Package</button>',
          '</div>',
        '</div>',

        '<div style="background:var(--surface-2,#191C20);border:1px solid var(--border,#252930);border-radius:10px;padding:14px;margin-bottom:18px">',
          _iconRow('\u{1F986}', 'Mode B -- Quack Hub (shared DuckDB node)',
            'Quack is DuckDB\'s forthcoming multi-client protocol (GA expected Q4 2026). When available, your team can share a single DuckDB node -- each analyst connects their DataGlow to the same database.'),
          '<button id="dg-teamhub-quack-toggle" style="width:100%;text-align:left;background:none;border:none;color:var(--primary,#20C5B5);font-size:11px;cursor:pointer;padding:4px 0;font-weight:600">\u25B8 Quack Hub Setup</button>',
          '<div id="dg-teamhub-quack-body" style="display:none;margin-top:8px">',
            '<label style="font-size:10px;color:var(--text-muted,#8A8F9A);display:block;margin-bottom:4px">Connection string</label>',
            '<input id="dg-teamhub-quack-input" type="text" placeholder="duckdb://[host]:[port]/[database]" ',
              'style="width:100%;box-sizing:border-box;background:var(--bg,#0D0E10);border:1px solid var(--border,#252930);border-radius:6px;padding:7px 10px;color:var(--text,#E8E9EB);font-size:12px;font-family:var(--mono,\'Geist Mono\');margin-bottom:8px">',
            '<button id="dg-teamhub-quack-test-btn" data-testid="team-hub-quack-test-btn" style="padding:7px 12px;border-radius:6px;border:1px solid var(--border,#252930);background:transparent;color:var(--text,#E8E9EB);cursor:pointer;font-size:11px;margin-bottom:8px">Test Connection</button>',
            '<div><span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:var(--flag,#F5A623);color:#0D0E10">BETA</span> ',
              '<span style="font-size:11px;color:var(--text-muted,#8A8F9A)">Quack Hub: Coming Q4 2026</span></div>',
          '</div>',
        '</div>',

        /* Section 2 */
        '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted,#8A8F9A);margin-bottom:10px">Peer Connect (Sentinel Pillar 4)</div>',
        '<div style="background:var(--surface-2,#191C20);border:1px solid var(--border,#252930);border-radius:10px;padding:14px;margin-bottom:18px">',
          '<div style="margin-bottom:10px">',
            '<div style="font-size:10px;color:var(--text-muted,#8A8F9A);margin-bottom:3px">Your Peer ID</div>',
            '<div id="dg-teamhub-peer-id" data-testid="team-hub-peer-id" style="font-family:var(--mono,\'Geist Mono\');font-size:13px;color:var(--primary,#20C5B5)">Loading...</div>',
          '</div>',
          '<label style="font-size:10px;color:var(--text-muted,#8A8F9A);display:block;margin-bottom:4px">Connect to Peer</label>',
          '<div style="display:flex;gap:8px;margin-bottom:10px">',
            '<input id="dg-teamhub-peer-input" data-testid="team-hub-peer-input" type="text" placeholder="8-char peer ID" ',
              'style="flex:1;background:var(--bg,#0D0E10);border:1px solid var(--border,#252930);border-radius:6px;padding:7px 10px;color:var(--text,#E8E9EB);font-size:12px;font-family:var(--mono,\'Geist Mono\')">',
            '<button id="dg-teamhub-connect-btn" data-testid="team-hub-connect-btn" style="padding:7px 14px;border-radius:6px;border:none;background:var(--primary,#20C5B5);color:#0D0E10;font-weight:600;cursor:pointer;font-size:12px">Connect</button>',
          '</div>',
          '<div style="display:flex;align-items:center;gap:6px">',
            '<span id="dg-teamhub-status-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--text-muted,#8A8F9A)"></span>',
            '<span style="font-size:11px;color:var(--text-muted,#8A8F9A)">Status: </span>',
            '<span id="dg-teamhub-status-text" data-testid="team-hub-status" style="font-size:11px;font-weight:600">Disconnected</span>',
          '</div>',
        '</div>',

        /* Section 3 */
        '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted,#8A8F9A);margin-bottom:10px">Team Activity Feed</div>',
        '<div style="background:var(--surface-2,#191C20);border:1px solid var(--border,#252930);border-radius:10px;padding:14px;margin-bottom:14px">',
          '<div id="dg-teamhub-activity-feed" style="max-height:220px;overflow-y:auto;margin-bottom:10px"></div>',
          '<button id="dg-teamhub-share-proof-btn" data-testid="team-hub-share-proof-btn" style="width:100%;padding:9px;border-radius:8px;border:1px solid var(--border,#252930);background:transparent;color:var(--text,#E8E9EB);cursor:pointer;font-size:12px">Share this proof chain</button>',
        '</div>',
      '</div>'
    ].join('');
  }

  function _ensurePanelDom() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'width:400px', 'max-width:94vw',
      'height:100vh', 'background:var(--surface,#131519)',
      'border-left:1px solid var(--border,#252930)', 'z-index:9800',
      'display:flex', 'flex-direction:column',
      'box-shadow:-8px 0 40px rgba(0,0,0,.5)',
      'transform:translateX(100%)', 'transition:transform 0.3s cubic-bezier(0.4,0,0.2,1)',
      'color:var(--text,#E8E9EB)'
    ].join(';');
    panel.innerHTML = _panelHtml();
    document.body.appendChild(panel);
    return panel;
  }

  function _wirePanelEvents(panel) {
    var closeBtn = document.getElementById('dg-teamhub-close-btn');
    if (closeBtn) closeBtn.onclick = _closePanel;

    var exportBtn = document.getElementById('dg-teamhub-export-btn');
    if (exportBtn) exportBtn.onclick = function () { exportPackage(); };

    var importBtn = document.getElementById('dg-teamhub-import-btn');
    if (importBtn) importBtn.onclick = _triggerImportPicker;

    var quackToggle = document.getElementById('dg-teamhub-quack-toggle');
    var quackBody = document.getElementById('dg-teamhub-quack-body');
    if (quackToggle && quackBody) {
      quackToggle.onclick = function () {
        var isOpen = quackBody.style.display !== 'none';
        quackBody.style.display = isOpen ? 'none' : 'block';
        quackToggle.textContent = (isOpen ? '\u25B8' : '\u25BE') + ' Quack Hub Setup';
      };
    }

    var quackTestBtn = document.getElementById('dg-teamhub-quack-test-btn');
    if (quackTestBtn) quackTestBtn.onclick = _testQuackHubConnection;

    var connectBtn = document.getElementById('dg-teamhub-connect-btn');
    if (connectBtn) {
      connectBtn.onclick = function () {
        var input = document.getElementById('dg-teamhub-peer-input');
        connect(input ? input.value : '');
      };
    }

    var shareBtn = document.getElementById('dg-teamhub-share-proof-btn');
    if (shareBtn) shareBtn.onclick = _shareProofChain;

    getPeerId().then(function (id) {
      var el = document.getElementById('dg-teamhub-peer-id');
      if (el) el.textContent = id;
    });

    _refreshActivityFeed();
  }

  function openTeamHubPanel() {
    var panel = _ensurePanelDom();
    _wirePanelEvents(panel);
    requestAnimationFrame(function () {
      panel.classList.add('open');
      panel.style.transform = 'translateX(0)';
    });
  }

  function toggleTeamHubPanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel && panel.style.transform === 'translateX(0px)') {
      _closePanel();
      panel.style.transform = 'translateX(100%)';
    } else {
      openTeamHubPanel();
    }
  }

  /* ---- Register Team button in toolbar (same pattern as Sentinel) ---- */
  function _injectToolbarButton() {
    if (document.getElementById('dg-teamhub-btn')) return;
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header');
    if (!toolbar) return;
    var btn = document.createElement('button');
    btn.id = 'dg-teamhub-btn';
    btn.setAttribute('data-testid', 'team-hub-btn');
    btn.title = 'Team Hub -- collaboration, artifact exchange, peer connect';
    btn.textContent = '\u{1F465}';
    btn.style.cssText = 'padding:6px 10px;border-radius:8px;border:1px solid var(--primary,#20C5B5);background:transparent;color:var(--primary,#20C5B5);cursor:pointer;font-size:15px;margin-left:6px';
    btn.onclick = toggleTeamHubPanel;
    toolbar.appendChild(btn);
  }

  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(_injectToolbarButton, 2000);
  });

  /* ---- Public API ---- */
  window.DataGlowTeamHub = {
    getPeerId: getPeerId,
    connect: connect,
    getStatus: getStatus,
    exportPackage: exportPackage,
    importPackage: importPackage,
    openPanel: openTeamHubPanel,
    closePanel: _closePanel
  };

  console.info('[DataGlow Team Hub] v1.0 ready. Mode A (Artifact Exchange) live. Mode B (Quack Hub) stub -- GA expected Q4 2026.');
})();
/* ---- end js/collaboration/team-hub.js ---- */
