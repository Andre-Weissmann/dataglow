/* DataGlow — src/js/panels/privacy-audit.js */
/* Refactored from canvas/index.html */

(function () {
  'use strict';

  // CDN hostnames allowed to receive requests (no user data)
  var ALLOWED_HOSTS = [
    'cdn.jsdelivr.net',
    'webr.r-wasm.org',
    'pyodide-cdn2.iodide.io',
    'cdn.pyodide.org',
    'unpkg.com',
    'esm.sh',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
  ];

  var _interceptInstalled = false;
  var _leakLog = [];

  function isAllowedUrl(url) {
    try {
      var host = new URL(url, location.href).hostname;
      return ALLOWED_HOSTS.some(function (h) { return host === h || host.endsWith('.' + h); }) || host === location.hostname;
    } catch (e) { return true; }
  }

  function installIntercept() {
    if (_interceptInstalled) return;
    _interceptInstalled = true;

    // Intercept fetch
    var origFetch = window.fetch;
    window.fetch = function (url, opts) {
      var u = typeof url === 'string' ? url : (url && url.url) || '';
      if (!isAllowedUrl(u)) {
        var body = opts && opts.body ? String(opts.body).substring(0, 200) : '';
        var logEntry = { ts: Date.now(), url: u, method: (opts && opts.method) || 'GET', bodyPreview: body };
        _leakLog.push(logEntry);
        console.warn('[DataGlow Privacy] Unexpected external fetch:', u);
        if (typeof showToast === 'function') {
          showToast('[Privacy] Unexpected external request: ' + new URL(u).hostname + '. Check the audit log.', 'error');
        }
      }
      return origFetch.apply(this, arguments);
    };

    // Intercept XHR
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._dgUrl = url;
      return origOpen.apply(this, arguments);
    };
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      var u = this._dgUrl || '';
      if (!isAllowedUrl(u)) {
        var logEntry = { ts: Date.now(), url: u, method: this._method || 'XHR', bodyPreview: body ? String(body).substring(0, 200) : '' };
        _leakLog.push(logEntry);
        console.warn('[DataGlow Privacy] Unexpected XHR:', u);
      }
      return origSend.apply(this, arguments);
    };
  }

  function showPrivacyAudit() {
    var modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--surface,#1C1B19);border:1px solid var(--border,#393836);border-radius:12px;padding:28px;max-width:520px;width:90%;color:var(--text,#CDCCCA);font-family:inherit;';
    var leakHtml = _leakLog.length === 0
      ? '<p style="color:#4ade80;font-weight:600;">No unexpected network requests detected.</p>'
      : '<p style="color:#f87171;font-weight:600;">' + _leakLog.length + ' unexpected request(s) detected:</p><ul>' + _leakLog.map(function(l){ return '<li style="font-size:12px;margin:4px 0;">' + l.url.substring(0,80) + '</li>'; }).join('') + '</ul>';
    box.innerHTML = '<h2 style="margin:0 0 16px;font-size:18px;color:#4ade80;">Privacy Audit</h2>' +
      '<p style="font-size:13px;color:var(--text-muted,#797876);margin:0 0 16px;">DataGlow processes all data inside your browser using WebAssembly. No row data, column data, or file content is uploaded to any server.</p>' +
      '<div style="background:var(--bg,#171614);border-radius:8px;padding:12px;margin-bottom:16px;font-size:12px;">' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;"><span style="color:#4ade80;">+</span><span>DuckDB-WASM - in-browser SQL engine</span></div>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;"><span style="color:#4ade80;">+</span><span>Pyodide - in-browser Python/pandas</span></div>' +
        '<div style="display:flex;gap:8px;align-items:center;"><span style="color:#4ade80;">+</span><span>WebR - in-browser R engine</span></div>' +
      '</div>' +
      leakHtml +
      '<button onclick="this.closest(\'div[style*=fixed]\').remove()" style="background:var(--primary,#4F98A3);color:#fff;border:none;border-radius:6px;padding:8px 20px;font-size:13px;cursor:pointer;margin-top:8px;">Close</button>';
    modal.appendChild(box);
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e){ if(e.target===modal) modal.remove(); });
  }
  window.showPrivacyAudit = showPrivacyAudit;

  // Install intercept after app initializes
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(installIntercept, 1000);
  });
