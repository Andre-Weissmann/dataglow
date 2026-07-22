/* DataGlow -- js/ethics/training-passport.js */
/* PR A1: Model Training Passport                                               */
/*                                                                             */
/* Generates a machine-readable provenance document for datasets headed toward  */
/* ML training. Captures: cleaning steps from audit trail, bias signals from   */
/* pre-flight, purpose contract terms, and a dataset fingerprint at export.    */
/* The artifact that answers: "where did this training data come from and was  */
/* it handled responsibly."                                                     */

(function () {
  'use strict';

  var PANEL_ID = 'dg-passport-panel';
  var TRIGGER_ID = 'dg-passport-trigger';

  /* ---- fingerprint ---- */
  function _fingerprint(dataset) {
    if (!dataset || !dataset.rows) return '00000000';
    var sample = dataset.rows.slice(0, 100);
    var str = JSON.stringify(sample);
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    var h2 = dataset.rows.length * 31 + (dataset.columns ? dataset.columns.length * 17 : 0);
    return (Math.abs(hash) ^ Math.abs(h2)).toString(16).toUpperCase().padStart(12, '0');
  }

  /* ---- audit trail reader ---- */
  function _readAuditSteps(datasetId) {
    /* Pull from ProofChainRail if available */
    if (window.ProofChainRail && typeof window.ProofChainRail.getSteps === 'function') {
      return window.ProofChainRail.getSteps(datasetId) || [];
    }
    /* Fallback: read from global audit log if present */
    var log = window._dgAuditLog || [];
    return log.filter(function (e) { return !datasetId || e.datasetId === datasetId; });
  }

  /* ---- passport generator ---- */
  function generatePassport(dataset) {
    if (!dataset) return null;

    var contract = window.PurposeContract ? window.PurposeContract.get(dataset.id) : null;
    var biasResult = window._dgLastBiasPreflight || null;
    var auditSteps = _readAuditSteps(dataset.id);
    var fp = _fingerprint(dataset);
    var now = Date.now();

    /* Passport ID: FP prefix + timestamp */
    var passportId = 'DGP-' + fp.slice(0, 8) + '-' + now.toString(36).toUpperCase();

    var passport = {
      passportId: passportId,
      version: '1.0',
      generatedAt: now,
      generatedAtISO: new Date(now).toISOString(),

      dataset: {
        id: dataset.id,
        name: dataset.name || dataset.id,
        rowCount: dataset.rows ? dataset.rows.length : 0,
        colCount: dataset.columns ? dataset.columns.length : 0,
        fingerprint: fp,
        fingerprintAlgo: 'DG-FP-v1 (djb2 XOR row+col hash)',
      },

      purposeContract: contract ? {
        purposeId: contract.purposeId,
        purposeLabel: contract.purposeLabel,
        signedAt: new Date(contract.signedAt).toISOString(),
        expiresAt: new Date(contract.expiresAt).toISOString(),
        restrictions: contract.restrictions,
        signature: contract.signature,
        analystNote: contract.analystNote || '',
        breached: contract.breached,
        breachReason: contract.breachReason || null,
      } : null,

      biasAudit: biasResult ? {
        score: biasResult.score,
        grade: biasResult.grade,
        findingCount: biasResult.findings.length,
        highSeverityCount: biasResult.findings.filter(function (f) { return f.severity === 'high'; }).length,
        findings: biasResult.findings.map(function (f) {
          return {
            type: f.type,
            severity: f.severity,
            column: f.column,
            detail: f.detail,
            impact: f.impact,
          };
        }),
        ranAt: new Date(biasResult.ranAt).toISOString(),
      } : null,

      cleaningSteps: auditSteps.length > 0
        ? auditSteps.map(function (s, i) {
          return {
            step: i + 1,
            operation: s.operation || s.type || 'unknown',
            description: s.description || s.detail || '',
            timestamp: s.timestamp ? new Date(s.timestamp).toISOString() : null,
          };
        })
        : [],

      readinessAssessment: _assessReadiness(contract, biasResult, auditSteps),
    };

    return passport;
  }

  function _assessReadiness(contract, biasResult, auditSteps) {
    var issues = [];
    var score = 100;

    if (!contract) {
      issues.push({ flag: 'NO_PURPOSE_CONTRACT', desc: 'No purpose contract was signed for this dataset.', severity: 'high' });
      score -= 30;
    } else if (contract.purposeId !== 'model_training') {
      issues.push({ flag: 'PURPOSE_MISMATCH', desc: 'Dataset contract purpose is "' + contract.purposeLabel + '", not Model Training.', severity: 'moderate' });
      score -= 15;
    } else if (contract.breached) {
      issues.push({ flag: 'CONTRACT_BREACHED', desc: 'Purpose contract was breached: ' + contract.breachReason, severity: 'high' });
      score -= 40;
    }

    if (biasResult) {
      var highBias = biasResult.findings.filter(function (f) { return f.severity === 'high'; }).length;
      if (highBias > 0) {
        issues.push({ flag: 'HIGH_BIAS_SIGNALS', desc: highBias + ' high-severity bias signal(s) unresolved.', severity: 'high' });
        score -= highBias * 15;
      } else if (biasResult.findings.length > 0) {
        issues.push({ flag: 'MODERATE_BIAS_SIGNALS', desc: biasResult.findings.length + ' moderate bias signal(s) detected.', severity: 'moderate' });
        score -= biasResult.findings.length * 5;
      }
    } else {
      issues.push({ flag: 'NO_BIAS_AUDIT', desc: 'Data Mirror pre-flight was not run.', severity: 'moderate' });
      score -= 20;
    }

    if (auditSteps.length === 0) {
      issues.push({ flag: 'NO_CLEANING_RECORD', desc: 'No cleaning steps were recorded in the audit trail.', severity: 'low' });
      score -= 10;
    }

    score = Math.max(0, score);
    var verdict = score >= 80 ? 'READY' : score >= 55 ? 'CONDITIONAL' : 'NOT_READY';
    var verdictColor = score >= 80 ? '#4AE38A' : score >= 55 ? '#F5A623' : '#D163A7';

    return {
      score: score,
      verdict: verdict,
      verdictColor: verdictColor,
      issues: issues,
    };
  }

  /* ---- export to JSON ---- */
  function downloadPassport(passport) {
    var json = JSON.stringify(passport, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = passport.passportId + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ---- UI panel ---- */
  function _buildTrigger(ds) {
    var existing = document.getElementById(TRIGGER_ID);
    if (existing) existing.remove();

    var trigger = document.createElement('button');
    trigger.id = TRIGGER_ID;
    trigger.title = 'Generate Model Training Passport for this dataset';
    trigger.style.cssText = [
      'position:fixed;bottom:110px;right:20px;z-index:7400;',
      'display:flex;align-items:center;gap:6px;',
      'background:#131519;border:1px solid #F5A62340;',
      'border-radius:24px;padding:7px 14px 7px 10px;cursor:pointer;',
      'font-family:\'Geist Mono\',monospace;font-size:10px;color:#F5A623;',
      'box-shadow:0 4px 16px rgba(0,0,0,0.4);transition:all 0.15s;',
      'letter-spacing:0.05em;font-weight:600;',
    ].join('');

    trigger.innerHTML = [
      '<svg width="14" height="14" viewBox="0 0 14 14" fill="none">',
      '  <rect x="2" y="1" width="10" height="12" rx="2" stroke="#F5A623" stroke-width="1.2"/>',
      '  <path d="M4 4h6M4 6.5h6M4 9h4" stroke="#F5A623" stroke-width="1" stroke-linecap="round"/>',
      '  <circle cx="11" cy="11" r="2.5" fill="#131519" stroke="#4AE38A" stroke-width="1"/>',
      '  <path d="M10 11l.7.7 1.3-1.3" stroke="#4AE38A" stroke-width="0.8" stroke-linecap="round"/>',
      '</svg>',
      'PASSPORT',
    ].join('');

    trigger.addEventListener('click', function () { _showPanel(ds); });
    trigger.addEventListener('mouseenter', function () { trigger.style.borderColor = '#F5A623'; });
    trigger.addEventListener('mouseleave', function () { trigger.style.borderColor = '#F5A62340'; });
    document.body.appendChild(trigger);
  }

  function _showPanel(dataset) {
    var existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); return; }

    var passport = generatePassport(dataset);
    if (!passport) return;

    var assessment = passport.readinessAssessment;

    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed;bottom:150px;right:20px;z-index:7500;',
      'width:min(420px,94vw);background:#131519;',
      'border:1px solid #252930;border-radius:16px;',
      'font-family:\'Geist Mono\',monospace;',
      'box-shadow:0 8px 40px rgba(0,0,0,0.5);overflow:hidden;',
    ].join('');

    panel.innerHTML = [
      /* header */
      '<div style="padding:16px 20px;border-bottom:1px solid #252930;display:flex;align-items:center;gap:10px;">',
      '  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">',
      '    <rect x="2" y="1" width="12" height="14" rx="2" stroke="#F5A623" stroke-width="1.2"/>',
      '    <path d="M5 5h6M5 7.5h6M5 10h4" stroke="#F5A623" stroke-width="1" stroke-linecap="round"/>',
      '  </svg>',
      '  <span style="color:#CDCCCA;font-size:12px;font-weight:600;letter-spacing:0.08em;">TRAINING PASSPORT</span>',
      '  <div style="margin-left:auto;display:flex;align-items:center;gap:6px;">',
      '    <span style="color:' + assessment.verdictColor + ';font-size:10px;font-weight:700;',
      '      background:' + assessment.verdictColor + '18;padding:2px 8px;border-radius:10px;">',
      '      ' + assessment.verdict.replace('_', ' '),
      '    </span>',
      '  </div>',
      '</div>',

      /* passport ID */
      '<div style="padding:12px 20px;border-bottom:1px solid #1A1D21;background:#0D0E10;">',
      '  <div style="color:#5A5957;font-size:10px;margin-bottom:4px;">PASSPORT ID</div>',
      '  <div style="color:#CDCCCA;font-size:11px;letter-spacing:0.04em;">' + passport.passportId + '</div>',
      '</div>',

      /* readiness issues */
      assessment.issues.length > 0 ? [
        '<div style="padding:12px 20px;border-bottom:1px solid #252930;">',
        '  <div style="color:#797876;font-size:10px;letter-spacing:0.06em;margin-bottom:8px;">READINESS FLAGS</div>',
        assessment.issues.map(function (issue) {
          var c = issue.severity === 'high' ? '#D163A7' : issue.severity === 'moderate' ? '#F5A623' : '#4F98A3';
          return [
            '<div style="display:flex;gap:8px;margin-bottom:6px;align-items:flex-start;">',
            '  <div style="width:6px;height:6px;border-radius:50%;background:' + c + ';margin-top:4px;flex-shrink:0;"></div>',
            '  <div style="color:#797876;font-size:11px;line-height:1.4;">' + issue.desc + '</div>',
            '</div>',
          ].join('');
        }).join(''),
        '</div>',
      ].join('') : '',

      /* sections summary */
      '<div style="padding:12px 20px;display:flex;flex-direction:column;gap:8px;">',

      /* dataset */
      '<div style="background:#0D0E10;border:1px solid #252930;border-radius:8px;padding:10px 12px;">',
      '  <div style="color:#5A5957;font-size:10px;margin-bottom:6px;">DATASET</div>',
      '  <div style="color:#CDCCCA;font-size:11px;">' + passport.dataset.name + '</div>',
      '  <div style="color:#797876;font-size:10px;">' + passport.dataset.rowCount.toLocaleString() + ' rows / ' + passport.dataset.colCount + ' cols</div>',
      '  <div style="color:#5A5957;font-size:10px;margin-top:4px;">FP: ' + passport.dataset.fingerprint + '</div>',
      '</div>',

      /* contract */
      passport.purposeContract ? [
        '<div style="background:#0D0E10;border:1px solid #252930;border-radius:8px;padding:10px 12px;">',
        '  <div style="color:#5A5957;font-size:10px;margin-bottom:6px;">PURPOSE CONTRACT</div>',
        '  <div style="color:#CDCCCA;font-size:11px;">' + passport.purposeContract.purposeLabel + '</div>',
        '  <div style="color:#797876;font-size:10px;">Signed ' + new Date(passport.purposeContract.signedAt).toLocaleTimeString() + '  |  Sig: ' + passport.purposeContract.signature + '</div>',
        '  <div style="color:#5A5957;font-size:10px;margin-top:2px;">Restrictions: ' + (passport.purposeContract.restrictions.length ? passport.purposeContract.restrictions.join(', ') : 'none') + '</div>',
        '</div>',
      ].join('') : '<div style="background:#0D0E10;border:1px solid #252930;border-radius:8px;padding:10px 12px;color:#5A5957;font-size:11px;">No purpose contract signed.</div>',

      /* bias */
      passport.biasAudit ? [
        '<div style="background:#0D0E10;border:1px solid #252930;border-radius:8px;padding:10px 12px;">',
        '  <div style="color:#5A5957;font-size:10px;margin-bottom:6px;">BIAS PRE-FLIGHT</div>',
        '  <div style="color:#CDCCCA;font-size:11px;">Score: ' + passport.biasAudit.score + ' / ' + passport.biasAudit.grade + '</div>',
        '  <div style="color:#797876;font-size:10px;">' + passport.biasAudit.findingCount + ' signal(s) -- ' + passport.biasAudit.highSeverityCount + ' high severity</div>',
        '</div>',
      ].join('') : '<div style="background:#0D0E10;border:1px solid #252930;border-radius:8px;padding:10px 12px;color:#5A5957;font-size:11px;">Data Mirror not run.</div>',

      /* cleaning steps */
      '<div style="background:#0D0E10;border:1px solid #252930;border-radius:8px;padding:10px 12px;">',
      '  <div style="color:#5A5957;font-size:10px;margin-bottom:4px;">CLEANING STEPS</div>',
      '  <div style="color:#797876;font-size:11px;">' + (passport.cleaningSteps.length > 0 ? passport.cleaningSteps.length + ' recorded operation(s)' : 'No cleaning steps recorded.') + '</div>',
      '</div>',

      '</div>',

      /* footer actions */
      '<div style="padding:12px 20px;border-top:1px solid #252930;display:flex;gap:8px;">',
      '  <button id="dg-passport-download" style="',
      '    flex:1;background:#F5A623;color:#0D0E10;border:none;border-radius:8px;',
      '    padding:9px;font-family:\'Geist Mono\',monospace;font-size:11px;',
      '    font-weight:700;cursor:pointer;letter-spacing:0.04em;">',
      '    DOWNLOAD JSON',
      '  </button>',
      '  <button id="dg-passport-close" style="',
      '    padding:9px 14px;background:transparent;border:1px solid #252930;',
      '    border-radius:8px;color:#797876;font-family:\'Geist Mono\',monospace;',
      '    font-size:11px;cursor:pointer;">',
      '    Close',
      '  </button>',
      '</div>',
    ].join('');

    document.body.appendChild(panel);

    document.getElementById('dg-passport-download').addEventListener('click', function () {
      downloadPassport(passport);
    });
    document.getElementById('dg-passport-close').addEventListener('click', function () {
      panel.remove();
    });
  }

  /* ---- listen for model_training purpose to show trigger ---- */
  document.addEventListener('dataglow:contract-signed', function (e) {
    var c = e.detail && e.detail.contract;
    if (!c || c.purposeId !== 'model_training') return;
    if (!window.FEATURE_FLAGS || !window.FEATURE_FLAGS.trainingPassport) return;
    /* Find current dataset from state */
    var ds = window.state && window.state.datasets && window.state.datasets.length
      ? window.state.datasets[window.state.datasets.length - 1]
      : null;
    if (ds) _buildTrigger(ds);
  });

  /* Also show when dataset-loaded AND a model_training contract already exists */
  document.addEventListener('dataglow:dataset-loaded', function (e) {
    var ds = e.detail && e.detail.dataset;
    if (!ds) return;
    if (!window.FEATURE_FLAGS || !window.FEATURE_FLAGS.trainingPassport) return;
    var contract = window.PurposeContract ? window.PurposeContract.get(ds.id) : null;
    if (contract && contract.purposeId === 'model_training') {
      _buildTrigger(ds);
    }
  });

  /* ---- export API ---- */
  window.TrainingPassport = {
    generate: generatePassport,
    download: downloadPassport,
  };

})();
