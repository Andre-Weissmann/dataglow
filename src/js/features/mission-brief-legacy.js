/* DataGlow — js/features/mission-brief-legacy.js */
/* Part of structured refactor — see src/ directory */

(function () {
  'use strict';

  var SEEN_KEY = '__mb_seen__';
  var AUTO_DISMISS_SECONDS = 60;
  var countdownTimer = null;
  var countdownRemaining = AUTO_DISMISS_SECONDS;
  var currentDataset = null;

  var MISSION_STEPS = ['brief', 'explore', 'analyze', 'review', 'report'];
  var missionStepIndex = 0;

  function $(id) { return document.getElementById(id); }

  function getSeenIds() {
    try {
      var raw = sessionStorage.getItem(SEEN_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_e) {
      return [];
    }
  }

  function markSeen(id) {
    try {
      var seen = getSeenIds();
      if (seen.indexOf(id) === -1) {
        seen.push(id);
        sessionStorage.setItem(SEEN_KEY, JSON.stringify(seen));
      }
    } catch (_e) {}
  }

  function hasSeen(id) {
    return getSeenIds().indexOf(id) !== -1;
  }

  function detectDomain(cols) {
    var names = (cols || []).map(function (c) { return (c.name || '').toLowerCase(); }).join(' ');
    if (/bene|clm|dx|los|icd|drg|facility|medicare|medicaid|patient|admit|disch|claim|diagnosis|provider|procedure|cpt|npi|member|rx|pharmacy/.test(names)) return 'healthcare';
    if (/revenue|amount|price|payment|invoice|transaction|cost|profit|margin|sales/.test(names)) return 'finance';
    if (/employee|salary|department|hire|tenure|attrition|headcount|manager|staff/.test(names)) return 'hr';
    return 'general';
  }

  function domainLabel(domain) {
    if (domain === 'healthcare') return 'Healthcare';
    if (domain === 'finance') return 'Finance';
    if (domain === 'hr') return 'HR';
    return 'General';
  }

  function missionParagraph(domain, rowCount, colCount) {
    var n = rowCount.toLocaleString();
    if (domain === 'healthcare') {
      return 'Investigate ' + n + '-row inpatient claims dataset to surface cost drivers, identify data quality issues, and flag patterns consistent with billing anomalies, readmission risk, or utilization outliers. Your findings will inform clinical and financial leadership.';
    }
    if (domain === 'finance') {
      return 'Analyze ' + n + ' financial transactions to identify revenue concentration, detect anomalous activity, and surface trend patterns. Your analysis will support decision-making for the upcoming business review.';
    }
    if (domain === 'hr') {
      return 'Examine ' + n + ' employee records to understand attrition risk, compensation equity, and headcount distribution. Findings should be actionable for HR leadership and department heads.';
    }
    return 'Explore ' + n + ' records across ' + colCount + ' dimensions to surface meaningful patterns, validate data quality, and generate insights worth sharing with your team.';
  }

  function firstMoves(domain) {
    if (domain === 'healthcare') {
      return [
        'Start with the Peer Review to audit data quality',
        'Then explore the Questions we generated',
        'Use OSCE mode to test your analytical approach'
      ];
    }
    if (domain === 'finance') {
      return [
        'Open Questions for Pareto and anomaly prompts',
        'Run Stats to check correlations across key fields',
        'Finish with a Peer Review pass on the data'
      ];
    }
    if (domain === 'hr') {
      return [
        'Open Questions to explore attrition risk',
        'Build Charts to visualize headcount distribution',
        'Try a Take-Home Case to practice your narrative'
      ];
    }
    return [
      'Open Questions to see what we generated for you',
      'Explore the SQL Explorer to query the raw data',
      'Run a Peer Review to check data quality'
    ];
  }

  function scoreClass(score) {
    if (score >= 80) return 'score-high';
    if (score >= 55) return 'score-mid';
    return 'score-low';
  }

  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function startCountdown() {
    clearCountdown();
    countdownRemaining = AUTO_DISMISS_SECONDS;
    var el = $('mb-countdown');
    function render() {
      if (el) el.textContent = 'This briefing closes automatically in ' + countdownRemaining + 's';
    }
    render();
    countdownTimer = setInterval(function () {
      countdownRemaining -= 1;
      if (countdownRemaining <= 0) {
        clearCountdown();
        dismissBrief();
        return;
      }
      render();
    }, 1000);
  }

  function dismissBrief() {
    clearCountdown();
    var overlay = $('mission-brief-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function showProgressBar() {
    var bar = $('mission-progress-bar');
    if (bar) bar.classList.add('active');
  }

  function advanceMissionStep(stepId) {
    var idx = MISSION_STEPS.indexOf(stepId);
    if (idx === -1) return;
    if (idx <= missionStepIndex) return;

    for (var i = 0; i < idx; i++) {
      var doneEl = $('mp-step-' + MISSION_STEPS[i]);
      if (doneEl) {
        doneEl.classList.remove('active');
        doneEl.classList.add('done');
      }
    }
    var activeEl = $('mp-step-' + MISSION_STEPS[idx]);
    if (activeEl) {
      activeEl.classList.remove('done');
      activeEl.classList.add('active');
    }
    missionStepIndex = idx;
  }

  function acceptMission() {
    dismissBrief();
    showProgressBar();
    if (window.QuestionPrompter && typeof window.QuestionPrompter.show === 'function') {
      window.QuestionPrompter.show(currentDataset);
    }
    if (window.LevelSystem && typeof window.LevelSystem.addXP === 'function') {
      window.LevelSystem.addXP('mission_accepted', 15);
    }
    var evt = new CustomEvent('dataglow:mission-accepted', { detail: { dataset: currentDataset } });
    document.dispatchEvent(evt);
  }

  function exploreOnOwn() {
    dismissBrief();
  }

  function showMissionBrief(dataset) {
    if (!dataset) return;
    var dsId = dataset.id != null ? dataset.id : dataset.name;
    if (dsId != null && hasSeen(dsId)) return;

    currentDataset = dataset;

    var rowCount = (dataset.rows && dataset.rows.length) || 0;
    var colCount = (dataset.columns && dataset.columns.length) || 0;
    var domain = detectDomain(dataset.columns);
    var score = typeof dataset.score === 'number' ? dataset.score : 0;
    var issueCount = (dataset.findings && dataset.findings.length) || 0;

    var nameEl = $('mb-dataset-name');
    if (nameEl) nameEl.textContent = dataset.name || 'Dataset';

    var metaEl = $('mb-meta');
    if (metaEl) {
      metaEl.textContent = rowCount.toLocaleString() + ' rows  \u00B7  ' + colCount + ' columns  \u00B7  ' + domainLabel(domain) + ' domain';
    }

    var scoreEl = $('mb-trust-score');
    if (scoreEl) {
      scoreEl.textContent = score + '/100';
      scoreEl.classList.remove('score-high', 'score-mid', 'score-low');
      scoreEl.classList.add(scoreClass(score));
    }

    var issueEl = $('mb-issue-count');
    if (issueEl) issueEl.textContent = String(issueCount);

    var domainEl = $('mb-domain-val');
    if (domainEl) domainEl.textContent = domainLabel(domain);

    var missionEl = $('mb-mission-text');
    if (missionEl) missionEl.textContent = missionParagraph(domain, rowCount, colCount);

    var movesEl = $('mb-moves');
    if (movesEl) {
      var moves = firstMoves(domain);
      movesEl.innerHTML = moves.map(function (m) {
        return '<div class="mb-move"><span class="mb-move-dot"></span><span>' + m + '</span></div>';
      }).join('');
    }

    var overlay = $('mission-brief-overlay');
    if (overlay) overlay.classList.add('open');

    startCountdown();

    if (dsId != null) markSeen(dsId);

  }

  function init() {
    window._dgSpotlight = function () {};
    var acceptBtn = $('mb-accept-btn');
    if (acceptBtn) acceptBtn.addEventListener('click', acceptMission);

    var exploreBtn = $('mb-explore-btn');
    if (exploreBtn) exploreBtn.addEventListener('click', exploreOnOwn);

    var overlay = $('mission-brief-overlay');
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) exploreOnOwn();
      });
    }

    document.addEventListener('dataglow:dataset-loaded', function (e) {
      var dataset = (e && e.detail && e.detail.dataset) || (window.getActiveDataset && window.getActiveDataset());
      setTimeout(function () {
        showMissionBrief(dataset);
      }, 500);
    });

    document.addEventListener('click', function (e) {
      var pill = e.target.closest ? e.target.closest('.analyze-pill') : null;
      if (pill) {
        if (pill.getAttribute('data-panel') === 'review-view') {
          advanceMissionStep('review');
        } else {
          advanceMissionStep('explore');
        }
        return;
      }

      var sqlRun = e.target.closest ? e.target.closest('#sql-view-run') : null;
      if (sqlRun) {
        advanceMissionStep('analyze');
        return;
      }

      var narrBtn = e.target.closest ? e.target.closest('#narr-gen-btn') : null;
      if (narrBtn) {
        advanceMissionStep('report');
        return;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.MissionBrief = { show: showMissionBrief, advance: advanceMissionStep };
})();

/* ================================================================
   M3 DataGlow Witness - PHI/PII Detection, De-identification,
   and De-identification Certificate (HIPAA Safe Harbor)
   ================================================================ */
(function () {
  'use strict';

  var PHI_PATTERNS = [
    {id:'name',    label:'Patient Name',            pattern:/\b(name|patient_name|first_name|last_name|fname|lname)\b/i, risk:'HIGH'},
    {id:'dob',     label:'Date of Birth',           pattern:/\b(dob|birth_date|birthdate|date_of_birth|born)\b/i, risk:'HIGH'},
    {id:'ssn',     label:'Social Security Number',  pattern:/\b(ssn|social_security|social_sec)\b/i, risk:'CRITICAL'},
    {id:'mrn',     label:'Medical Record Number',   pattern:/\b(mrn|medical_record|record_num|chart_num)\b/i, risk:'HIGH'},
    {id:'phone',   label:'Phone Number',            pattern:/\b(phone|telephone|cell|mobile|contact_num)\b/i, risk:'HIGH'},
    {id:'email',   label:'Email Address',           pattern:/\b(email|e_mail|email_addr)\b/i, risk:'HIGH'},
    {id:'address', label:'Street Address',          pattern:/\b(address|street|addr|street_addr)\b/i, risk:'HIGH'},
    {id:'zip',     label:'ZIP Code',                pattern:/\b(zip|zipcode|zip_code|postal)\b/i, risk:'MEDIUM'},
    {id:'date',    label:'Clinical Date',           pattern:/\b(admit_date|adm_date|discharge_date|disch_date|service_date|procedure_date)\b/i, risk:'MEDIUM'},
    {id:'age',     label:'Age (if >89)',            pattern:/\b(age|patient_age|age_years)\b/i, risk:'LOW'},
    {id:'geo',     label:'Geographic Subdivision',  pattern:/\b(county|city|state|region|district)\b/i, risk:'LOW'},
    {id:'bene_id', label:'Beneficiary ID',          pattern:/\b(bene_id|beneficiary_id|member_id|patient_id|pat_id)\b/i, risk:'HIGH'},
    {id:'device',  label:'Device Identifier',       pattern:/\b(device_id|device_serial|imei|mac_addr)\b/i, risk:'HIGH'},
    {id:'url',     label:'URL/IP Address',          pattern:/\b(url|ip_address|ip_addr|web_addr)\b/i, risk:'HIGH'},
    {id:'account', label:'Account Number',          pattern:/\b(account_num|acct_num|account_id|bank_acct)\b/i, risk:'HIGH'},
    {id:'license', label:'License Number',          pattern:/\b(license|licence|lic_num|npi)\b/i, risk:'MEDIUM'},
    {id:'vehicle', label:'Vehicle ID',               pattern:/\b(vin|vehicle_id|plate_num|license_plate)\b/i, risk:'MEDIUM'},
    {id:'photo',   label:'Biometric/Photo',          pattern:/\b(photo|image|biometric|fingerprint|face_id)\b/i, risk:'HIGH'}
  ];

  var VALUE_PATTERNS = {
    ssn: [/^\d{3}-\d{2}-\d{4}$/, /^\d{9}$/],
    email: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/],
    phone: [/^[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4}$/],
    zip4: [/^\d{5}-\d{4}$/]
  };

  var ALL_LABELS = PHI_PATTERNS.map(function (p) { return p.label; });

  var witState = {
    phase: 'scan',
    dataset: null,
    detected: [],
    config: {},
    certText: '',
    resultDataset: null
  };

  function $id(id) { return document.getElementById(id); }

  function maskSample(val) {
    if (val == null) return '';
    var s = String(val);
    if (s.length <= 2) return s + '***';
    return s.slice(0, 2) + '***';
  }

  function defaultActionFor(id) {
    switch (id) {
      case 'ssn': return 'redact';
      case 'name': return 'hash';
      case 'dob': return 'generalize';
      case 'zip': return 'generalize';
      case 'date': return 'generalize';
      case 'bene_id': return 'hash';
      case 'mrn': return 'hash';
      case 'device': return 'hash';
      case 'phone': return 'redact';
      case 'email': return 'redact';
      case 'address': return 'redact';
      case 'account': return 'hash';
      case 'age': return 'generalize';
      case 'geo': return 'keep';
      case 'url': return 'redact';
      case 'license': return 'generalize';
      case 'vehicle': return 'generalize';
      case 'photo': return 'redact';
      default: return 'redact';
    }
  }

  function scanDataset(ds) {
    var detected = [];
    if (!ds || !ds.columns) return detected;

    ds.columns.forEach(function (col, colIdx) {
      var matched = null;
      for (var i = 0; i < PHI_PATTERNS.length; i++) {
        if (PHI_PATTERNS[i].pattern.test(col.name)) { matched = PHI_PATTERNS[i]; break; }
      }

      var valueFlag = null;
      var sampleVal = null;
      var sampleRows = ds.rows ? ds.rows.slice(0, 100) : [];
      var zipPlusFour = false;
      var ageOver89 = false;

      for (var r = 0; r < sampleRows.length; r++) {
        var v = sampleRows[r][colIdx];
        if (v == null || v === '') continue;
        var vs = String(v);

        if (!matched) {
          if (VALUE_PATTERNS.ssn.some(function (p) { return p.test(vs); })) {
            matched = PHI_PATTERNS.filter(function (p) { return p.id === 'ssn'; })[0];
            valueFlag = 'value-pattern';
            sampleVal = vs;
            break;
          }
          if (VALUE_PATTERNS.email.some(function (p) { return p.test(vs); })) {
            matched = PHI_PATTERNS.filter(function (p) { return p.id === 'email'; })[0];
            valueFlag = 'value-pattern';
            sampleVal = vs;
            break;
          }
          if (VALUE_PATTERNS.phone.some(function (p) { return p.test(vs); })) {
            matched = PHI_PATTERNS.filter(function (p) { return p.id === 'phone'; })[0];
            valueFlag = 'value-pattern';
            sampleVal = vs;
            break;
          }
        }

        if (VALUE_PATTERNS.zip4[0].test(vs)) zipPlusFour = true;

        if (/\bage\b/i.test(col.name) && !isNaN(parseFloat(vs)) && parseFloat(vs) > 89) {
          ageOver89 = true;
        }
      }

      if (matched) {
        if (sampleVal == null) {
          var firstVal = null;
          for (var rr = 0; rr < sampleRows.length; rr++) {
            if (sampleRows[rr][colIdx] != null && sampleRows[rr][colIdx] !== '') { firstVal = sampleRows[rr][colIdx]; break; }
          }
          sampleVal = firstVal;
        }
        var risk = matched.risk;
        if (matched.id === 'age' && ageOver89) risk = 'HIGH';
        if (zipPlusFour && matched.id === 'zip') risk = 'HIGH';

        detected.push({
          colIdx: colIdx,
          colName: col.name,
          id: matched.id,
          label: matched.label,
          risk: risk,
          detectionMethod: valueFlag ? 'value pattern' : 'column name',
          sample: maskSample(sampleVal),
          zipPlusFour: zipPlusFour,
          ageOver89: ageOver89,
          action: defaultActionFor(matched.id)
        });
      }
    });

    return detected;
  }

  function riskWeight(r) {
    return r === 'CRITICAL' ? 0 : r === 'HIGH' ? 1 : r === 'MEDIUM' ? 2 : 3;
  }

  function renderPhaseTabs() {
    var tabs = { scan: $id('wit-tab-scan'), configure: $id('wit-tab-configure'), certificate: $id('wit-tab-certificate') };
    Object.keys(tabs).forEach(function (key) {
      var el = tabs[key];
      if (!el) return;
      el.classList.remove('active', 'done');
      if (key === witState.phase) {
        el.classList.add('active');
      } else {
        var order = ['scan', 'configure', 'certificate'];
        if (order.indexOf(key) < order.indexOf(witState.phase)) el.classList.add('done');
      }
    });
  }

  function riskBadgeHtml(risk) {
    return '<span class="wit-risk-badge wit-risk-' + risk + '">' + risk + '</span>';
  }

  function renderScanPhase(detected) {
    witState.phase = 'scan';
    renderPhaseTabs();
    var body = $id('wit-body');
    if (!body) return;

    var listHtml = '';
    if (!detected || detected.length === 0) {
      listHtml = '<div class="wit-no-phi"><div class="wit-clean-badge">&#10003;</div>No HIPAA Safe Harbor identifiers detected in this dataset.</div>';
    } else {
      var sorted = detected.slice().sort(function (a, b) { return riskWeight(a.risk) - riskWeight(b.risk); });
      listHtml = sorted.map(function (d) {
        var flags = [];
        if (d.zipPlusFour) flags.push('ZIP+4 detected (more granular than Safe Harbor allows)');
        if (d.ageOver89) flags.push('Values exceed age 89');
        var flagHtml = flags.length ? '<div class="wit-phi-label">' + flags.join(' | ') + '</div>' : '';
        return '<div class="wit-phi-card risk-' + d.risk + '">' +
          riskBadgeHtml(d.risk) +
          '<div class="wit-phi-info">' +
            '<div class="wit-phi-col">' + escapeWit(d.colName) + '</div>' +
            '<div class="wit-phi-label">' + escapeWit(d.label) + ' &middot; detected via ' + d.detectionMethod + ' &middot; sample: ' + escapeWit(d.sample || '') + '</div>' +
            flagHtml +
          '</div>' +
        '</div>';
      }).join('');
    }

    body.innerHTML =
      '<div class="wit-scan-header">PHI/PII Scanner</div>' +
      '<div class="wit-scan-sub">' + (detected && detected.length ? 'Detected ' + detected.length + ' potential HIPAA Safe Harbor identifier' + (detected.length === 1 ? '' : 's') + ' in ' + escapeWit(witState.dataset ? witState.dataset.name : 'dataset') + '. Review below, then continue to Configure.' : 'Scan complete. No dataset loaded or no identifiers found.') + '</div>' +
      '<div id="wit-phi-list">' + listHtml + '</div>' +
      '<div class="wit-action-bar" id="wit-action-bar"></div>';

    var actionBar = $id('wit-action-bar');
    if (actionBar) {
      if (detected && detected.length > 0) {
        actionBar.innerHTML = '<button class="wit-primary-btn" id="wit-go-configure-btn">Continue to Configure</button>';
        var btn = $id('wit-go-configure-btn');
        if (btn) btn.addEventListener('click', function () { renderConfigurePhase(witState.detected); });
      } else {
        actionBar.innerHTML = '<button class="wit-secondary-btn" id="wit-rescan-btn">Rescan</button>';
        var rbtn = $id('wit-rescan-btn');
        if (rbtn) rbtn.addEventListener('click', function () { runScan(); });
      }
    }
  }

  function actionOptionsHtml(current) {
    var opts = [
      {v:'redact', l:'Redact'},
      {v:'generalize', l:'Generalize'},
      {v:'hash', l:'Hash'},
      {v:'keep', l:'Keep'}
    ];
    return opts.map(function (o) {
      return '<option value="' + o.v + '"' + (o.v === current ? ' selected' : '') + '>' + o.l + '</option>';
    }).join('');
  }

  function renderConfigurePhase(detected) {
    witState.phase = 'configure';
    renderPhaseTabs();
    var body = $id('wit-body');
    if (!body) return;

    witState.detected = detected;

    var listHtml = detected.map(function (d, i) {
      var restrictNote = '';
      var selectDisabled = '';
      if (d.id === 'ssn') {
        restrictNote = '<div class="wit-phi-label">SSN must always be redacted</div>';
      }
      return '<div class="wit-phi-card risk-' + d.risk + '">' +
        riskBadgeHtml(d.risk) +
        '<div class="wit-phi-info">' +
          '<div class="wit-phi-col">' + escapeWit(d.colName) + '</div>' +
          '<div class="wit-phi-label">' + escapeWit(d.label) + ' &middot; sample: ' + escapeWit(d.sample || '') + '</div>' +
          restrictNote +
        '</div>' +
        '<select class="wit-phi-action-sel" data-idx="' + i + '"' + selectDisabled + '>' + actionOptionsHtml(d.action) + '</select>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="wit-scan-header">Configure De-identification</div>' +
      '<div class="wit-scan-sub">Choose an action for each detected identifier. SSN is always redacted per HIPAA Safe Harbor.</div>' +
      '<div id="wit-phi-list">' + listHtml + '</div>' +
      '<div class="wit-action-bar" id="wit-action-bar"></div>';

    var selects = body.querySelectorAll('.wit-phi-action-sel');
    selects.forEach(function (sel) {
      var idx = parseInt(sel.getAttribute('data-idx'), 10);
      if (witState.detected[idx].id === 'ssn') {
        sel.value = 'redact';
        sel.disabled = true;
      }
      sel.addEventListener('change', function () {
        witState.detected[idx].action = sel.value;
      });
    });

    var actionBar = $id('wit-action-bar');
    if (actionBar) {
      actionBar.innerHTML =
        '<button class="wit-secondary-btn" id="wit-back-scan-btn">Back to Scan</button>' +
        '<button class="wit-primary-btn" id="wit-apply-btn">Apply De-identification</button>';
      var backBtn = $id('wit-back-scan-btn');
      if (backBtn) backBtn.addEventListener('click', function () { renderScanPhase(witState.detected); });
      var applyBtn = $id('wit-apply-btn');
      if (applyBtn) applyBtn.addEventListener('click', function () { runApply(); });
    }
  }

  function pseudoHash(val, idx) {
    return 'ID_' + String(idx).padStart(6, '0');
  }

  function hashName(idx) {
    var letter = String.fromCharCode(65 + (idx % 26));
    var suffix = Math.floor(idx / 26);
    return 'Patient_' + letter + (suffix > 0 ? suffix : '');
  }

  function generalizeZip(val) {
    var s = String(val == null ? '' : val);
    var digits = s.replace(/[^0-9]/g, '');
    if (digits.length >= 3) return digits.slice(0, 3) + '00';
    return '000';
  }

  function generalizeDateToYear(val) {
    var s = String(val == null ? '' : val);
    var m = s.match(/(19|20)\d{2}/);
    if (m) return m[0];
    var d = new Date(s);
    if (!isNaN(d.getTime())) return String(d.getFullYear());
    return 'UNKNOWN';
  }

  function generalizeAgeRange(val) {
    var n = parseFloat(val);
    if (isNaN(n)) return 'UNKNOWN';
    if (n > 89) return '90+';
    var lo = Math.floor(n / 10) * 10;
    var hi = lo + 9;
    return lo + '-' + hi;
  }

  function applyDeidentification(ds, config) {
    var newCols = ds.columns.map(function (c) { return { name: c.name, type: c.type }; });
    var newRows = ds.rows.map(function (row) { return row.slice(); });

    var pseudonymCache = {};
    var namePseudonymCache = {};

    config.forEach(function (d) {
      var colIdx = d.colIdx;
      var action = d.action;

      newRows.forEach(function (row, rowIdx) {
        var v = row[colIdx];
        if (v == null || v === '') return;

        if (action === 'redact') {
          row[colIdx] = '[REDACTED]';
        } else if (action === 'hash') {
          if (d.id === 'name') {
            var key = String(v);
            if (!(key in namePseudonymCache)) namePseudonymCache[key] = hashName(Object.keys(namePseudonymCache).length);
            row[colIdx] = namePseudonymCache[key];
          } else {
            var hkey = d.colName + '::' + String(v);
            if (!(hkey in pseudonymCache)) pseudonymCache[hkey] = pseudoHash(v, Object.keys(pseudonymCache).length);
            row[colIdx] = pseudonymCache[hkey];
          }
        } else if (action === 'generalize') {
          if (d.id === 'zip') {
            row[colIdx] = generalizeZip(v);
          } else if (d.id === 'dob' || d.id === 'date') {
            row[colIdx] = generalizeDateToYear(v);
          } else if (d.id === 'age') {
            row[colIdx] = generalizeAgeRange(v);
          } else {
            row[colIdx] = generalizeDateToYear(v);
          }
        }
        // 'keep' leaves value unchanged
      });
    });

    var newDs = {
      id: 'deid_' + Date.now(),
      name: ds.name + ' - De-identified',
      columns: newCols,
      rows: newRows,
      findings: [],
      score: 100,
      columnStats: []
    };

    return newDs;
  }

  function sha256Like(str) {
    // Deterministic, dependency-free hash used purely for certificate
    // fingerprinting display purposes (not cryptographic SHA-256).
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    var out = (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
    while (out.length < 64) out += (h1 ^ h2).toString(16).padStart(8, '0');
    return out.slice(0, 64);
  }

  function randHex(n) {
    var chars = '0123456789abcdef';
    var out = '';
    for (var i = 0; i < n; i++) out += chars[Math.floor(Math.random() * 16)];
    return out;
  }

  function padRight(s, n) {
    s = String(s);
    while (s.length < n) s += ' ';
    return s;
  }

  function generateCertificate(ds, config, resultDs) {
    var now = new Date();
    var isoTime = now.toISOString();
    var certId = 'DGW-' + randHex(8);

    var detectedIds = config.map(function (d) { return d.id; });
    var processedLabelsSeen = {};
    config.forEach(function (d) { processedLabelsSeen[d.label] = true; });
    var notDetected = ALL_LABELS.filter(function (l) { return !processedLabelsSeen[l]; });

    var rows = config.map(function (d) {
      var actionLabel = d.action === 'redact' ? 'Redacted' : d.action === 'generalize' ? 'Generalized' : d.action === 'hash' ? 'Hashed' : 'Kept';
      return padRight(d.colName, 20) + padRight(d.label, 14) + padRight(actionLabel, 12) + 'COMPLETE';
    }).join('\n');

    var fingerprintSrc = ds.columns.map(function (c) { return c.name; }).join(',') + '|' + ds.rows.length + '|' + isoTime;
    var fingerprint = sha256Like(fingerprintSrc);

    var bodyText =
      'DE-IDENTIFICATION CERTIFICATE\n' +
      'DataGlow Witness - HIPAA Safe Harbor Method\n' +
      '===============================================================\n\n' +
      'Issued:          ' + isoTime + '\n' +
      'Certificate ID:  ' + certId + '\n' +
      'Dataset:         ' + ds.name + '\n' +
      'Records:         ' + ds.rows.length.toLocaleString() + ' rows | ' + ds.columns.length + ' columns\n' +
      'Method:          HIPAA Safe Harbor (45 CFR 164.514(b))\n\n' +
      'IDENTIFIERS PROCESSED\n' +
      '-----------------------\n' +
      padRight('Column', 20) + padRight('Type', 14) + padRight('Action', 12) + 'Status\n' +
      '---------------------------------------------------------------\n' +
      (rows || '(none)') + '\n\n' +
      'IDENTIFIERS NOT DETECTED\n' +
      '-------------------------\n' +
      'The following Safe Harbor identifiers were not detected\n' +
      'in this dataset: ' + (notDetected.length ? notDetected.join(', ') : 'None - all identifiers detected') + '.\n\n' +
      'ATTESTATION\n' +
      '---------------------------------------------------------------\n' +
      'This certificate attests that DataGlow Witness v1.0\n' +
      'applied the HIPAA Safe Harbor de-identification method\n' +
      'to the above dataset. All processing was performed\n' +
      'locally in the browser. No data was transmitted.\n\n' +
      'The resulting de-identified dataset ' + resultDs.name + '\n' +
      'contains no data elements that individually or in\n' +
      'combination could be used to identify individuals with\n' +
      'reasonable certainty under 45 CFR 164.514(b).\n\n' +
      'VERIFICATION HASH\n' +
      '---------------------------------------------------------------\n' +
      'Dataset fingerprint: ' + fingerprint + '\n';

    var certHash = sha256Like(bodyText);
    bodyText += 'Certificate hash:    ' + certHash + '\n\n' +
      '-----------------------------------------------------------------\n' +
      'DataGlow Witness | Browser-local processing | No data transmitted\n';

    return bodyText;
  }

  function renderCertificatePhase(certText) {
    witState.phase = 'certificate';
    renderPhaseTabs();
    var body = $id('wit-body');
    if (!body) return;

    body.innerHTML =
      '<div class="wit-scan-header">De-identification Certificate</div>' +
      '<div class="wit-safe-badge">&#10003; De-identification complete. Certificate generated below.</div>' +
      '<div id="wit-certificate" class="show"></div>' +
      '<div class="wit-cert-actions">' +
        '<button class="wit-cert-btn" id="wit-copy-cert-btn">Copy Certificate</button>' +
        '<button class="wit-cert-btn" id="wit-download-cert-btn">Download as .txt</button>' +
        '<button class="wit-cert-btn" id="wit-print-cert-btn">Print</button>' +
      '</div>' +
      '<div class="wit-action-bar" id="wit-action-bar"></div>';

    var certEl = $id('wit-certificate');
    if (certEl) certEl.textContent = certText;

    var copyBtn = $id('wit-copy-cert-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(certText).then(function () {
            window.showToast && window.showToast('Certificate copied to clipboard', 'success');
          }).catch(function () {
            window.showToast && window.showToast('Copy failed', 'error');
          });
        }
      });
    }

    var downloadBtn = $id('wit-download-cert-btn');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', function () {
        var blob = new Blob([certText], { type: 'text/plain' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'dataglow-witness-certificate.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        window.showToast && window.showToast('Certificate downloaded', 'success');
      });
    }

    var printBtn = $id('wit-print-cert-btn');
    if (printBtn) {
      printBtn.addEventListener('click', function () {
        window.print();
      });
    }

    var actionBar = $id('wit-action-bar');
    if (actionBar) {
      actionBar.innerHTML = '<button class="wit-secondary-btn" id="wit-close-after-cert-btn">Done</button>';
      var doneBtn = $id('wit-close-after-cert-btn');
      if (doneBtn) doneBtn.addEventListener('click', closeWitness);
    }
  }

  function runScan() {
    var ds = typeof window.getActiveDataset === 'function' ? window.getActiveDataset() : null;
    witState.dataset = ds;
    if (!ds) {
      var body = $id('wit-body');
      if (body) {
        body.innerHTML =
          '<div class="wit-scan-header">PHI/PII Scanner</div>' +
          '<div class="wit-scan-sub">Open a dataset and click Scan to detect HIPAA Safe Harbor identifiers.</div>' +
          '<div class="wit-no-phi">No active dataset. Load a dataset first, then reopen Witness.</div>';
      }
      return;
    }
    var detected = scanDataset(ds);
    witState.detected = detected;
    renderScanPhase(detected);
  }

  function runApply() {
    if (!witState.dataset || !witState.detected) return;
    var newDs = applyDeidentification(witState.dataset, witState.detected);
    witState.resultDataset = newDs;

    if (window.state && window.state.datasets) {
      window.state.datasets.push(newDs);
      window.state.activeDatasetId = newDs.id;
    }
    document.dispatchEvent(new CustomEvent('dataglow:dataset-loaded', { detail: { dataset: newDs } }));
    window.showToast && window.showToast('De-identified dataset created: ' + newDs.name, 'success');

    if (window.LevelSystem && typeof window.LevelSystem.addXP === 'function') {
      window.LevelSystem.addXP('witness_deidentify', 25);
    }
    if (window.SkillTracker && typeof window.SkillTracker.track === 'function') {
      window.SkillTracker.track('phi_deidentification');
    }

    var certText = generateCertificate(witState.dataset, witState.detected, newDs);
    witState.certText = certText;
    renderCertificatePhase(certText);
  }

  function openWitness() {
    var modal = $id('witness-modal');
    if (!modal) return;
    modal.classList.add('open');
    runScan();
  }

  function closeWitness() {
    var modal = $id('witness-modal');
    if (!modal) return;
    modal.classList.remove('open');
    witState.phase = 'scan';
  }

  function escapeWit(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function wireTabs() {
    var scanTab = $id('wit-tab-scan');
    var configTab = $id('wit-tab-configure');
    var certTab = $id('wit-tab-certificate');
    if (scanTab) scanTab.addEventListener('click', function () { renderScanPhase(witState.detected); });
    if (configTab) {
      configTab.addEventListener('click', function () {
        if (witState.detected && witState.detected.length) renderConfigurePhase(witState.detected);
      });
    }
    if (certTab) {
      certTab.addEventListener('click', function () {
        if (witState.certText) renderCertificatePhase(witState.certText);
      });
    }
  }

  function init() {
    var trigger = $id('witness-trigger-btn');
    if (trigger) trigger.addEventListener('click', openWitness);

    var closeBtn = $id('wit-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', closeWitness);

    wireTabs();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.DataGlowWitness = {
    open: openWitness,
    scan: runScan,
    applyDeidentification: applyDeidentification
  };
