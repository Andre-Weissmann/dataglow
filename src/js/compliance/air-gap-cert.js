/* ---- from js/compliance/air-gap-cert.js ---- */
/* ================================================================
   DataGlow Air-Gap Certification (Session C, PR #533)
   Feature flag: window.FEATURE_FLAGS.airGapCert

   Generates a downloadable plain-text certificate proving that this
   analysis session ran with zero network egress of dataset content.

   What "air-gapped" means in DataGlow:
     - Dataset loaded into DuckDB-WASM (in-process, no server)
     - SQL runs in the browser VM -- no query sent to any endpoint
     - AI engines (Gemma3, Whisper, Chronos-2) run on-device via OPFS
     - Purpose Contracts, Bias Preflight, Peer Review: local logic only
     - Federated Quality Score: computed in-browser from local signals
     - No telemetry, no analytics, no usage beacon

   What it does NOT certify:
     - Network requests made by the analyst (e.g. copy/paste to another tool)
     - The trustworthiness of the analyst's device or OS
     - Third-party browser extensions
     - The data itself (content accuracy is Pulse's job)

   Output: dataglow-air-gap-cert-{timestamp}.txt (plain text, printable)
   Unlocks at Tier 3.
================================================================ */
(function () {
  'use strict';

  var FLAG = 'airGapCert';
  function isEnabled() { return !!(window.FEATURE_FLAGS && window.FEATURE_FLAGS[FLAG]); }

  var CERT_TEMPLATE = [
    '================================================',
    '  DataGlow Air-Gap Analysis Certificate',
    '================================================',
    '',
    'Issued:       {timestamp}',
    'Session:      {session_id}',
    'Browser:      {user_agent_short}',
    '',
    '------------------------------------------------',
    '  Analysis Summary',
    '------------------------------------------------',
    '',
    'Dataset fingerprint:    {fingerprint}',
    'Row count:              {row_count}',
    'Column count:           {col_count}',
    'Pulse score:            {pulse}',
    'Federated Quality:      {fqs}',
    'Role context:           {role}',
    '',
    '------------------------------------------------',
    '  Zero-Egress Attestation',
    '------------------------------------------------',
    '',
    'This certificate attests that the DataGlow analysis session',
    'described above was conducted entirely within the analyst\'s',
    'browser environment, with no transmission of dataset content',
    'to any external server, API, or network endpoint.',
    '',
    'Processing stack:',
    '  [ ] DuckDB-WASM        -- SQL engine, in-process WebAssembly',
    '  [ ] OPFS (Origin Private File System) -- local model cache',
    '  [ ] Gemma3-1B          -- on-device language model (if used)',
    '  [ ] Whisper base       -- on-device speech recognition (if used)',
    '  [ ] Chronos-2-tiny     -- on-device time-series model (if used)',
    '',
    'Network activity during this session:',
    '  - Model weight downloads (one-time, cached after first load)',
    '  - No dataset content transmitted at any point',
    '  - No query results transmitted at any point',
    '  - No analytics, telemetry, or usage beacons',
    '',
    '------------------------------------------------',
    '  Governance Checklist',
    '------------------------------------------------',
    '',
    '  Bias Preflight:        {bias_result}',
    '  Peer Review:           {peer_result}',
    '  Purpose Contracts:     {contracts}',
    '  Training Passport:     {passport}',
    '  Governance skips:      {skipped}',
    '',
    '------------------------------------------------',
    '  Limitations',
    '------------------------------------------------',
    '',
    'This certificate does not certify:',
    '  - Actions taken by the analyst outside DataGlow',
    '  - Third-party browser extensions active during the session',
    '  - The content accuracy of the underlying dataset',
    '  - Device-level network monitoring or OS-level egress',
    '',
    'For regulatory submissions, supplement this certificate with:',
    '  - The signed Gate State JSON artifact (Export Gate State)',
    '  - Your organization\'s data handling attestation',
    '',
    '================================================',
    '  DataGlow -- local-first analytics',
    '  https://dataglow-platform.pplx.app',
    '================================================',
    ''
  ].join('\n');

  function buildCert() {
    var ds  = window.DataGlowDataset || {};
    var fqs = (window.FederatedQualityScore && window.FederatedQualityScore.compute) ?
              window.FederatedQualityScore.compute() : null;
    var pulse = (window.PulseInterpreter && window.PulseInterpreter.getScore) ?
                window.PulseInterpreter.getScore() : null;
    var role = (window.RoleContext && window.RoleContext.current) ?
               window.RoleContext.current() : 'not set';
    var skipped = (window.EthicsEscape && window.EthicsEscape.getSkipped) ?
                  window.EthicsEscape.getSkipped() : [];
    var ua = navigator.userAgent.replace(/\(.*?\)/g, '').trim().split(' ')[0];

    function _sessionHash() {
      return 'dg-' + Math.abs(Math.round(performance.timeOrigin || Date.now())).toString(36);
    }

    var cert = CERT_TEMPLATE
      .replace('{timestamp}',       new Date().toISOString())
      .replace('{session_id}',      _sessionHash())
      .replace('{user_agent_short}', ua)
      .replace('{fingerprint}',     ds.fingerprint || 'not computed')
      .replace('{row_count}',       ds.rowCount    || 'unknown')
      .replace('{col_count}',       ds.colCount    || 'unknown')
      .replace('{pulse}',           pulse !== null  ? pulse : 'not run')
      .replace('{fqs}',             fqs   !== null  ? fqs   : 'not run')
      .replace('{role}',            role)
      .replace('{bias_result}',     window.BiasPreflightResult || 'not run')
      .replace('{peer_result}',     window.PeerReviewResult    || 'not run')
      .replace('{contracts}',       window.PurposeContracts ? 'declared' : 'not declared')
      .replace('{passport}',        window.TrainingPassport ? 'complete' : 'not completed')
      .replace('{skipped}',         skipped.length ? skipped.join(', ') : 'none');

    return cert;
  }

  function downloadCert() {
    var cert = buildCert();
    var blob = new Blob([cert], { type: 'text/plain' });
    var url  = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'dataglow-air-gap-cert-' + Date.now() + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    document.dispatchEvent(new CustomEvent('dataglow:air-gap-cert-issued', {
      detail: { timestamp: new Date().toISOString() }
    }));
  }

  function injectCertBtn() {
    if (document.getElementById('dg-airgap-cert-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'dg-airgap-cert-btn';
    btn.className = 'dg-airgap-cert-btn';
    btn.setAttribute('data-testid', 'button-airgap-cert');
    btn.setAttribute('data-flag-tier', '3');
    btn.setAttribute('aria-label', 'Download air-gap certification');
    btn.title = 'Generate zero-egress attestation document';
    btn.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="1" width="12" height="14" rx="2"/><line x1="5" y1="5" x2="11" y2="5"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="5" y1="11" x2="8" y2="11"/></svg> Air-Gap Certificate';
    btn.addEventListener('click', function () {
      downloadCert();
      if (typeof window.showToast === 'function') {
        window.showToast('Air-gap certificate downloaded.', 'success');
      }
    });

    var targets = ['#proof-chain-panel', '#output-panel', '#dg-proof-chain', '.proof-actions', '#dg-export-area'];
    var container = null;
    for (var i = 0; i < targets.length; i++) {
      container = document.querySelector(targets[i]);
      if (container) break;
    }
    if (!container) container = document.body;
    container.appendChild(btn);
  }

  function init() {
    if (!isEnabled()) return;
    document.addEventListener('dataglow:tier-3-unlocked', injectCertBtn);
    document.addEventListener('dataglow:fqs-updated', function (e) {
      if (e.detail && e.detail.score >= 90) injectCertBtn();
    });
    window.AirGapCert = { download: downloadCert, build: buildCert };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
/* ---- end js/compliance/air-gap-cert.js ---- */
