/* DataGlow -- js/ethics/purpose-contract.js */
/* PR A1: Data Expiry + Purpose Contracts                                     */
/*                                                                             */
/* When a dataset loads, analyst declares WHY they are using it.               */
/* That declaration becomes a signed contract: purpose, expiry, restrictions.  */
/* Crossing a purpose boundary or hitting expiry triggers a flag.              */
/* Mirrors HIPAA minimum-necessary + GDPR purpose-limitation in the workflow.  */

(function () {
  'use strict';

  /* ---- constants ---- */
  var PURPOSES = [
    {
      id: 'exploration',
      label: 'Exploration',
      desc: 'Initial data familiarization. No conclusions drawn.',
      expiry_ms: 4 * 60 * 60 * 1000,
      restrictions: ['no_export', 'no_model_training'],
      color: '#4AE38A',
    },
    {
      id: 'cleaning',
      label: 'Data Cleaning',
      desc: 'Standardizing, deduplicating, and repairing data quality issues.',
      expiry_ms: 8 * 60 * 60 * 1000,
      restrictions: ['no_model_training'],
      color: '#20C5B5',
    },
    {
      id: 'analysis',
      label: 'Analysis & Reporting',
      desc: 'Deriving insights for internal reporting or dashboards.',
      expiry_ms: 24 * 60 * 60 * 1000,
      restrictions: [],
      color: '#4F98A3',
    },
    {
      id: 'model_training',
      label: 'Model Training',
      desc: 'Preparing data as a training corpus for a machine learning model.',
      expiry_ms: 72 * 60 * 60 * 1000,
      restrictions: ['requires_passport'],
      color: '#F5A623',
    },
    {
      id: 'audit',
      label: 'Compliance Audit',
      desc: 'Reviewing data for regulatory or policy compliance purposes.',
      expiry_ms: 48 * 60 * 60 * 1000,
      restrictions: ['read_only'],
      color: '#7A39BB',
    },
  ];

  var STORAGE_KEY = 'dg_purpose_contracts';

  /* ---- state ---- */
  var _contracts = {};
  var _expiryTimers = {};
  var _currentDatasetId = null;

  /* ---- helpers ---- */
  function _now() { return Date.now(); }

  function _purposeById(id) {
    return PURPOSES.find(function (p) { return p.id === id; }) || PURPOSES[0];
  }

  function _saveContracts() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(_contracts));
    } catch (e) { /* OPFS not needed -- contracts are session-scoped */ }
  }

  function _loadContracts() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) _contracts = JSON.parse(raw);
    } catch (e) { _contracts = {}; }
  }

  function _hashContract(contract) {
    /* Lightweight fingerprint -- not cryptographic, but unique per contract */
    var str = contract.datasetId + '|' + contract.purposeId + '|' + contract.signedAt;
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16).toUpperCase().padStart(8, '0');
  }

  function _formatExpiry(ms) {
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    if (h > 0) return h + 'h ' + (m > 0 ? m + 'm' : '');
    return m + 'm';
  }

  /* ---- contract lifecycle ---- */
  function signContract(datasetId, purposeId, analystNote) {
    var purpose = _purposeById(purposeId);
    var now = _now();
    var contract = {
      datasetId: datasetId,
      purposeId: purposeId,
      purposeLabel: purpose.label,
      restrictions: purpose.restrictions.slice(),
      signedAt: now,
      expiresAt: now + purpose.expiry_ms,
      analystNote: analystNote || '',
      breached: false,
      breachReason: null,
      active: true,
    };
    contract.signature = _hashContract(contract);
    _contracts[datasetId] = contract;
    _saveContracts();
    _startExpiryTimer(datasetId);
    document.dispatchEvent(new CustomEvent('dataglow:contract-signed', { detail: { contract: contract } }));
    return contract;
  }

  function getContract(datasetId) {
    return _contracts[datasetId] || null;
  }

  function getActiveContract() {
    return _currentDatasetId ? getContract(_currentDatasetId) : null;
  }

  function checkRestriction(restriction) {
    var c = getActiveContract();
    if (!c || !c.active) return false;
    return c.restrictions.indexOf(restriction) !== -1;
  }

  function flagBreach(datasetId, reason) {
    var c = _contracts[datasetId];
    if (!c) return;
    c.breached = true;
    c.breachReason = reason;
    c.active = false;
    _saveContracts();
    document.dispatchEvent(new CustomEvent('dataglow:contract-breached', {
      detail: { contract: c, reason: reason }
    }));
  }

  function _startExpiryTimer(datasetId) {
    clearTimeout(_expiryTimers[datasetId]);
    var c = _contracts[datasetId];
    if (!c) return;
    var remaining = c.expiresAt - _now();
    if (remaining <= 0) {
      flagBreach(datasetId, 'Session expired -- purpose contract time limit reached.');
      return;
    }
    /* Warn at 10% of total window remaining */
    var purpose = _purposeById(c.purposeId);
    var warnAt = purpose.expiry_ms * 0.1;
    if (remaining > warnAt) {
      var warnDelay = remaining - warnAt;
      setTimeout(function () {
        if (_contracts[datasetId] && _contracts[datasetId].active) {
          document.dispatchEvent(new CustomEvent('dataglow:contract-expiry-warning', {
            detail: { contract: _contracts[datasetId], remainingMs: warnAt }
          }));
        }
      }, warnDelay);
    }
    _expiryTimers[datasetId] = setTimeout(function () {
      flagBreach(datasetId, 'Session expired -- purpose contract time limit reached.');
    }, remaining);
  }

  /* ---- UI panel ---- */
  var PANEL_ID = 'dg-purpose-contract-panel';
  var OVERLAY_ID = 'dg-purpose-contract-overlay';

  function _buildPanel() {
    if (document.getElementById(PANEL_ID)) return;

    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      'position:fixed;inset:0;background:rgba(13,14,16,0.82);backdrop-filter:blur(4px);',
      'z-index:9000;display:flex;align-items:center;justify-content:center;',
      'opacity:0;pointer-events:none;transition:opacity 0.2s;',
    ].join('');

    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'background:#131519;border:1px solid #252930;border-radius:16px;',
      'width:min(520px,92vw);padding:32px;font-family:\'Geist Mono\',monospace;',
      'transform:translateY(16px);transition:transform 0.25s cubic-bezier(0.34,1.56,0.64,1);',
    ].join('');

    panel.innerHTML = [
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">',
      '  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">',
      '    <path d="M10 2L3 6v4c0 4.418 3.134 8.109 7 9 3.866-.891 7-4.582 7-9V6L10 2z"',
      '      stroke="#20C5B5" stroke-width="1.5" stroke-linejoin="round"/>',
      '    <path d="M7 10l2 2 4-4" stroke="#4AE38A" stroke-width="1.5"',
      '      stroke-linecap="round" stroke-linejoin="round"/>',
      '  </svg>',
      '  <span style="color:#CDCCCA;font-size:13px;font-weight:600;letter-spacing:0.08em;">',
      '    PURPOSE CONTRACT',
      '  </span>',
      '</div>',
      '<p style="color:#797876;font-size:12px;margin:0 0 20px;line-height:1.6;">',
      '  Declare why you are using this dataset. Your declaration becomes a signed',
      '  contract that governs how the data may be used and for how long.',
      '</p>',

      '<div id="dg-pc-dataset-name" style="',
      '  background:#0D0E10;border:1px solid #252930;border-radius:8px;',
      '  padding:10px 14px;margin-bottom:20px;color:#CDCCCA;font-size:12px;">',
      '</div>',

      '<div style="margin-bottom:16px;">',
      '  <div style="color:#797876;font-size:11px;letter-spacing:0.06em;margin-bottom:10px;">',
      '    SELECT PURPOSE',
      '  </div>',
      '  <div id="dg-pc-purpose-grid" style="display:grid;gap:8px;">',
      PURPOSES.map(function (p) {
        return [
          '<button data-purpose="' + p.id + '" class="dg-pc-purpose-btn" style="',
          '  background:#0D0E10;border:1px solid #252930;border-radius:10px;',
          '  padding:12px 14px;text-align:left;cursor:pointer;transition:all 0.15s;',
          '  display:flex;flex-direction:column;gap:4px;">',
          '  <div style="display:flex;align-items:center;gap:8px;">',
          '    <div style="width:8px;height:8px;border-radius:50%;background:' + p.color + ';flex-shrink:0;"></div>',
          '    <span style="color:#CDCCCA;font-size:12px;font-weight:600;">' + p.label + '</span>',
          '    <span style="color:#5A5957;font-size:10px;margin-left:auto;">' + _formatExpiry(p.expiry_ms) + '</span>',
          '  </div>',
          '  <div style="color:#797876;font-size:11px;padding-left:16px;">' + p.desc + '</div>',
          '</button>',
        ].join('');
      }).join(''),
      '  </div>',
      '</div>',

      '<div style="margin-bottom:20px;">',
      '  <div style="color:#797876;font-size:11px;letter-spacing:0.06em;margin-bottom:8px;">',
      '    ANALYST NOTE <span style="color:#5A5957;">(optional)</span>',
      '  </div>',
      '  <textarea id="dg-pc-note" rows="2" placeholder="e.g. Q3 fraud review for compliance team..." style="',
      '    width:100%;box-sizing:border-box;background:#0D0E10;border:1px solid #252930;',
      '    border-radius:8px;padding:10px 12px;color:#CDCCCA;font-family:\'Geist Mono\',monospace;',
      '    font-size:12px;resize:none;outline:none;line-height:1.5;"></textarea>',
      '</div>',

      '<div style="display:flex;gap:10px;">',
      '  <button id="dg-pc-sign-btn" disabled style="',
      '    flex:1;background:#20C5B5;color:#0D0E10;border:none;border-radius:8px;',
      '    padding:12px;font-family:\'Geist Mono\',monospace;font-size:12px;',
      '    font-weight:700;cursor:not-allowed;opacity:0.4;transition:all 0.15s;">',
      '    SIGN CONTRACT',
      '  </button>',
      '  <button id="dg-pc-skip-btn" style="',
      '    padding:12px 16px;background:transparent;border:1px solid #252930;',
      '    border-radius:8px;color:#797876;font-family:\'Geist Mono\',monospace;',
      '    font-size:11px;cursor:pointer;">',
      '    Skip',
      '  </button>',
      '</div>',

      '<div id="dg-pc-status" style="',
      '  margin-top:12px;font-size:11px;color:#5A5957;text-align:center;min-height:16px;">',
      '</div>',
    ].join('');

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    /* wire events */
    var selectedPurpose = null;

    panel.querySelectorAll('.dg-pc-purpose-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        panel.querySelectorAll('.dg-pc-purpose-btn').forEach(function (b) {
          b.style.borderColor = '#252930';
          b.style.background = '#0D0E10';
        });
        selectedPurpose = btn.dataset.purpose;
        var p = _purposeById(selectedPurpose);
        btn.style.borderColor = p.color;
        btn.style.background = 'rgba(32,197,181,0.06)';
        var signBtn = document.getElementById('dg-pc-sign-btn');
        if (signBtn) {
          signBtn.disabled = false;
          signBtn.style.opacity = '1';
          signBtn.style.cursor = 'pointer';
        }
        var status = document.getElementById('dg-pc-status');
        if (status) {
          var restrictions = p.restrictions.length
            ? p.restrictions.map(function (r) { return r.replace(/_/g, ' '); }).join(', ')
            : 'none';
          status.textContent = 'Expiry: ' + _formatExpiry(p.expiry_ms) + '  |  Restrictions: ' + restrictions;
          status.style.color = p.color;
        }
      });
    });

    document.getElementById('dg-pc-sign-btn').addEventListener('click', function () {
      if (!selectedPurpose || !_currentDatasetId) return;
      var note = (document.getElementById('dg-pc-note') || {}).value || '';
      var contract = signContract(_currentDatasetId, selectedPurpose, note);
      _showSignedConfirmation(contract);
      setTimeout(function () { _hidePanel(); }, 1800);
    });

    document.getElementById('dg-pc-skip-btn').addEventListener('click', function () {
      _hidePanel();
    });
  }

  function _showSignedConfirmation(contract) {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    var p = _purposeById(contract.purposeId);
    panel.innerHTML = [
      '<div style="text-align:center;padding:20px 0;">',
      '  <div style="width:56px;height:56px;border-radius:50%;background:rgba(74,227,138,0.12);',
      '    border:2px solid #4AE38A;display:flex;align-items:center;justify-content:center;',
      '    margin:0 auto 20px;">',
      '    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">',
      '      <path d="M5 13l4 4L19 7" stroke="#4AE38A" stroke-width="2"',
      '        stroke-linecap="round" stroke-linejoin="round"/>',
      '    </svg>',
      '  </div>',
      '  <div style="color:#4AE38A;font-size:13px;font-weight:700;letter-spacing:0.08em;margin-bottom:8px;">',
      '    CONTRACT SIGNED',
      '  </div>',
      '  <div style="color:#797876;font-size:12px;margin-bottom:16px;">',
      '    ' + contract.purposeLabel + '  |  Expires in ' + _formatExpiry(_purposeById(contract.purposeId).expiry_ms),
      '  </div>',
      '  <div style="background:#0D0E10;border:1px solid #252930;border-radius:8px;padding:10px;',
      '    font-size:10px;color:#5A5957;letter-spacing:0.06em;">',
      '    SIG: ' + contract.signature,
      '  </div>',
      '</div>',
    ].join('');
  }

  function _showPanel(datasetId, datasetName) {
    _buildPanel();
    _currentDatasetId = datasetId;
    var nameEl = document.getElementById('dg-pc-dataset-name');
    if (nameEl) nameEl.textContent = datasetName || datasetId;

    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.style.pointerEvents = 'auto';
      requestAnimationFrame(function () {
        overlay.style.opacity = '1';
        var panel = document.getElementById(PANEL_ID);
        if (panel) panel.style.transform = 'translateY(0)';
      });
    }
  }

  function _hidePanel() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.style.opacity = '0';
      overlay.style.pointerEvents = 'none';
      var panel = document.getElementById(PANEL_ID);
      if (panel) panel.style.transform = 'translateY(16px)';
    }
  }

  /* ---- badge in toolbar ---- */
  function _upsertContractBadge(contract) {
    var badge = document.getElementById('dg-pc-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'dg-pc-badge';
      badge.style.cssText = [
        'display:inline-flex;align-items:center;gap:6px;',
        'padding:4px 10px;border-radius:20px;font-size:10px;',
        'font-family:\'Geist Mono\',monospace;font-weight:600;',
        'border:1px solid;cursor:pointer;transition:all 0.15s;',
        'letter-spacing:0.06em;',
      ].join('');
      badge.title = 'Purpose Contract active -- click to view details';
      badge.addEventListener('click', function () { _showContractSummary(); });
      var toolbar = document.querySelector('.nav-right, .toolbar-right, [class*="nav-right"]');
      if (toolbar) toolbar.insertBefore(badge, toolbar.firstChild);
    }
    var p = _purposeById(contract.purposeId);
    var remaining = contract.expiresAt - _now();
    badge.style.color = p.color;
    badge.style.borderColor = p.color + '40';
    badge.style.background = p.color + '12';
    badge.innerHTML = [
      '<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="' + p.color + '"/></svg>',
      p.label.toUpperCase(),
      '<span style="opacity:0.6;">' + _formatExpiry(remaining) + '</span>',
    ].join('');
  }

  function _showContractSummary() {
    var c = getActiveContract();
    if (!c) return;
    var p = _purposeById(c.purposeId);
    var remaining = c.expiresAt - _now();
    var msg = c.purposeLabel + '\n' +
      'Expires in: ' + _formatExpiry(remaining) + '\n' +
      'Signed: ' + new Date(c.signedAt).toLocaleTimeString() + '\n' +
      'Restrictions: ' + (c.restrictions.length ? c.restrictions.join(', ') : 'none') + '\n' +
      'Signature: ' + c.signature;
    if (window.showToast) window.showToast(msg, 4000);
  }

  /* ---- breach UI ---- */
  function _showBreachBanner(reason) {
    var existing = document.getElementById('dg-pc-breach-banner');
    if (existing) existing.remove();
    var banner = document.createElement('div');
    banner.id = 'dg-pc-breach-banner';
    banner.style.cssText = [
      'position:fixed;top:48px;left:50%;transform:translateX(-50%);',
      'background:#2D1A1A;border:1px solid #A12C7B;border-radius:10px;',
      'padding:12px 20px;z-index:8999;font-family:\'Geist Mono\',monospace;',
      'font-size:12px;color:#D163A7;max-width:460px;text-align:center;',
      'display:flex;align-items:center;gap:10px;box-shadow:0 4px 24px rgba(161,44,123,0.2);',
    ].join('');
    banner.innerHTML = [
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">',
      '  <path d="M8 2L2 13h12L8 2z" stroke="#D163A7" stroke-width="1.2"/>',
      '  <path d="M8 7v3" stroke="#D163A7" stroke-width="1.2" stroke-linecap="round"/>',
      '  <circle cx="8" cy="11.5" r="0.5" fill="#D163A7"/>',
      '</svg>',
      '<span>PURPOSE CONTRACT BREACH -- ' + reason + '</span>',
    ].join('');
    document.body.appendChild(banner);
  }

  /* ---- event listeners ---- */
  _loadContracts();

  document.addEventListener('dataglow:dataset-loaded', function (e) {
    var ds = e.detail && e.detail.dataset;
    if (!ds) return;
    _currentDatasetId = ds.id;
    /* Only show if no active contract for this dataset */
    var existing = getContract(ds.id);
    if (!existing || !existing.active) {
      if (window.FEATURE_FLAGS && window.FEATURE_FLAGS.purposeContracts) {
        setTimeout(function () {
          _showPanel(ds.id, ds.name || ds.id);
        }, 600);
      }
    } else {
      _upsertContractBadge(existing);
    }
  });

  document.addEventListener('dataglow:contract-signed', function (e) {
    var c = e.detail && e.detail.contract;
    if (c) _upsertContractBadge(c);
  });

  document.addEventListener('dataglow:contract-breached', function (e) {
    var c = e.detail && e.detail.contract;
    var reason = e.detail && e.detail.reason;
    if (reason) _showBreachBanner(reason);
    var badge = document.getElementById('dg-pc-badge');
    if (badge) {
      badge.style.color = '#D163A7';
      badge.style.borderColor = '#D163A7';
      badge.style.background = 'rgba(161,44,123,0.12)';
      badge.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="#D163A7"/></svg> EXPIRED';
    }
  });

  document.addEventListener('dataglow:contract-expiry-warning', function (e) {
    var remaining = e.detail && e.detail.remainingMs;
    if (window.showToast) {
      window.showToast('Purpose contract expiring in ' + _formatExpiry(remaining) + ' -- save your work.', 5000);
    }
  });

  /* ---- export API ---- */
  window.PurposeContract = {
    purposes: PURPOSES,
    sign: signContract,
    get: getContract,
    getActive: getActiveContract,
    checkRestriction: checkRestriction,
    flagBreach: flagBreach,
    show: _showPanel,
  };

})();
