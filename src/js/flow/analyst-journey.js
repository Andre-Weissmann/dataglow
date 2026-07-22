/* ---- from js/flow/analyst-journey.js ---- */
/* ================================================================
   DataGlow Analyst Journey -- end-to-end flow enhancement
   PR #522

   Owns four moments:
   1. LANDING COACH     -- after welcome brief closes, before drop
   2. POST-DROP NUDGE   -- right after dataset loads, 2-second delay
   3. PULSE INTERPRETER -- after Pulse sheet renders, adds contextual
                           "Do this first" recommendation
   4. FINISH LINE       -- fires when user reaches report/export step,
                           surfaces PortfolioExport with celebration

   Design rule: nudges stay visible until the analyst acts or closes them. Never auto-dismiss -- the analyst decides when they are done reading.
   ================================================================ */
(function () {
  'use strict';

  /* ----------------------------------------------------------------
     Shared helpers
  ---------------------------------------------------------------- */
  function $ (id) { return document.getElementById(id); }

  var CSS = [
    /* Landing coach -- floats below drop zone */
    '#dg-aj-coach{position:absolute;bottom:28px;left:50%;transform:translateX(-50%);',
    'display:flex;flex-direction:column;align-items:center;gap:10px;',
    'pointer-events:none;opacity:0;transition:opacity .4s ease;z-index:900}',
    '#dg-aj-coach.visible{opacity:1;pointer-events:auto}',
    '.dg-aj-step{display:flex;align-items:center;gap:10px;',
    'background:rgba(19,21,25,.92);border:1px solid #252930;',
    'border-radius:10px;padding:10px 16px;backdrop-filter:blur(8px);',
    'cursor:default;transition:border-color .2s}',
    '.dg-aj-step:hover{border-color:#20C5B5}',
    '.dg-aj-step-num{width:22px;height:22px;border-radius:50%;',
    'background:#20C5B5;color:#0D0E10;font:700 11px/22px "Geist Mono",monospace;',
    'text-align:center;flex-shrink:0}',
    '.dg-aj-step-text{font:400 12px/1.4 "Geist Mono",monospace;color:#CDCCCA}',
    '.dg-aj-step-text strong{color:#20C5B5;font-weight:700}',
    '.dg-aj-connector{width:1px;height:10px;background:#252930}',

    /* Post-drop nudge toast */
    '#dg-aj-nudge{position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(12px);',
    'background:#131519;border:1px solid #20C5B5;border-radius:12px;',
    'padding:14px 20px;max-width:360px;width:calc(100vw - 40px);',
    'box-shadow:0 8px 32px rgba(0,0,0,.55);z-index:10500;',
    'opacity:0;transition:opacity .35s,transform .35s;pointer-events:none}',
    '#dg-aj-nudge.visible{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}',
    '.dg-aj-nudge-header{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
    '.dg-aj-nudge-icon{font-size:18px;line-height:1}',
    '.dg-aj-nudge-title{font:700 13px/1.3 "Geist Mono",monospace;color:#CDCCCA;flex:1}',
    '.dg-aj-nudge-close{background:none;border:none;color:#797876;cursor:pointer;',
    'font-size:16px;padding:0 4px;line-height:1}',
    '.dg-aj-nudge-close:hover{color:#CDCCCA}',
    '.dg-aj-nudge-body{font:400 12px/1.6 "Geist Mono",monospace;color:#797876;margin-bottom:12px}',
    '.dg-aj-nudge-actions{display:flex;gap:8px;flex-wrap:wrap}',
    '.dg-aj-nudge-btn{padding:8px 14px;border-radius:6px;border:none;',
    'font:600 11px/1 "Geist Mono",monospace;cursor:pointer;transition:background .15s;white-space:nowrap}',
    '.dg-aj-nudge-btn-primary{background:#20C5B5;color:#0D0E10}',
    '.dg-aj-nudge-btn-primary:hover{background:#19a99a}',
    '.dg-aj-nudge-btn-ghost{background:#252930;color:#CDCCCA}',
    '.dg-aj-nudge-btn-ghost:hover{background:#2e3540}',

    /* Pulse interpreter -- injected into pulse sheet body */
    '.dg-aj-pulse-rec{margin:12px 0 4px;padding:12px 14px;',
    'background:rgba(32,197,181,.07);border:1px solid rgba(32,197,181,.25);',
    'border-radius:8px;display:flex;flex-direction:column;gap:6px}',
    '.dg-aj-pulse-rec-label{font:700 10px/1 "Geist Mono",monospace;',
    'color:#20C5B5;letter-spacing:.08em;text-transform:uppercase}',
    '.dg-aj-pulse-rec-text{font:400 12px/1.5 "Geist Mono",monospace;color:#CDCCCA}',
    '.dg-aj-pulse-rec-cta{align-self:flex-start;padding:7px 14px;border-radius:6px;',
    'border:none;background:#20C5B5;color:#0D0E10;',
    'font:600 11px/1 "Geist Mono",monospace;cursor:pointer;transition:background .15s}',
    '.dg-aj-pulse-rec-cta:hover{background:#19a99a}',

    /* Finish line celebration */
    '#dg-aj-finish{position:fixed;inset:0;z-index:19000;',
    'background:rgba(13,14,16,.92);display:flex;align-items:center;justify-content:center;',
    'padding:20px;opacity:0;transition:opacity .4s;pointer-events:none}',
    '#dg-aj-finish.visible{opacity:1;pointer-events:auto}',
    '.dg-aj-finish-card{background:#131519;border:1px solid #252930;',
    'border-radius:16px;padding:32px;max-width:440px;width:100%;',
    'display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center;',
    'box-shadow:0 24px 64px rgba(0,0,0,.6)}',
    '.dg-aj-finish-spark{font-size:40px;line-height:1}',
    '.dg-aj-finish-title{font:700 20px/1.25 "Geist Mono",monospace;color:#CDCCCA}',
    '.dg-aj-finish-sub{font:400 13px/1.6 "Geist Mono",monospace;color:#797876;max-width:320px}',
    '.dg-aj-finish-proof{font:400 11px/1.4 "Geist Mono",monospace;',
    'color:#4AE38A;background:rgba(74,227,138,.08);border:1px solid rgba(74,227,138,.2);',
    'border-radius:6px;padding:8px 12px;width:100%;text-align:left}',
    '.dg-aj-finish-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;width:100%}',
    '.dg-aj-finish-btn{padding:11px 20px;border-radius:8px;border:none;',
    'font:600 12px/1 "Geist Mono",monospace;cursor:pointer;transition:background .15s;flex:1;min-width:120px}',
    '.dg-aj-finish-btn-primary{background:#20C5B5;color:#0D0E10}',
    '.dg-aj-finish-btn-primary:hover{background:#19a99a}',
    '.dg-aj-finish-btn-ghost{background:#252930;color:#CDCCCA}',
    '.dg-aj-finish-btn-ghost:hover{background:#2e3540}',
    '.dg-aj-finish-dismiss{background:none;border:none;color:#797876;cursor:pointer;',
    'font:400 11px/1 "Geist Mono",monospace;margin-top:4px}',
    '.dg-aj-finish-dismiss:hover{color:#CDCCCA}',
  ].join('');

  function injectCSS() {
    if (document.getElementById('dg-aj-styles')) return;
    var s = document.createElement('style');
    s.id = 'dg-aj-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ================================================================
     MOMENT 1: Landing Coach
     Shows step-by-step preview BELOW the drop zone so the user
     knows exactly what happens after they drop a file.
     Auto-hides when a file is dropped.
  ================================================================ */
  var _coachEl = null;
  var _coachHidden = false;

  function buildLandingCoach() {
    if ($('dg-aj-coach')) return;

    var steps = [
      { n: '1', label: 'Drop any CSV, Excel, JSON, or Parquet file' },
      { n: '2', label: 'DataGlow reads your data <strong>-- nothing uploads</strong>' },
      { n: '3', label: 'Pulse scores it instantly' },
      { n: '4', label: 'Explore with SQL, Python, R, or Charts' },
      { n: '5', label: 'Export your findings + proof chain' },
    ];

    var coach = document.createElement('div');
    coach.id = 'dg-aj-coach';
    coach.innerHTML = steps.map(function (s, i) {
      return (i > 0 ? '<div class="dg-aj-connector"></div>' : '') +
        '<div class="dg-aj-step">' +
          '<div class="dg-aj-step-num">' + s.n + '</div>' +
          '<div class="dg-aj-step-text">' + s.label + '</div>' +
        '</div>';
    }).join('');

    /* Attach to drop zone parent */
    var dz = $('drop-zone');
    if (!dz) return;
    dz.style.position = 'relative';
    dz.appendChild(coach);
    _coachEl = coach;

    /* Reveal after brief delay */
    setTimeout(function () {
      if (!_coachHidden) coach.classList.add('visible');
    }, 900);

    /* Hide on drop */
    document.addEventListener('dataglow:dataset-loaded', function hideCoach() {
      _coachHidden = true;
      coach.classList.remove('visible');
      document.removeEventListener('dataglow:dataset-loaded', hideCoach);
    }, { once: true });

    /* Also hide if welcome brief is still open and user clicks Drop my own file */
    document.addEventListener('click', function (e) {
      var ghost = e.target.closest && e.target.closest('.wb-btn-ghost');
      if (ghost) { _coachHidden = true; coach.classList.remove('visible'); }
    });
  }

  /* ================================================================
     MOMENT 2: Post-Drop Nudge
     Fires 1.8s after dataset-loaded.
     Reads health score + issue count from Pulse data.
     Tells user exactly what to do first based on their actual data.
  ================================================================ */
  var _nudgeShown = false;

  function buildNudge() {
    if ($('dg-aj-nudge')) return;
    var el = document.createElement('div');
    el.id = 'dg-aj-nudge';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }

  function showNudge(dataset) {
    if (_nudgeShown) return;
    _nudgeShown = true;

    var el = $('dg-aj-nudge');
    if (!el) return;

    var score   = typeof dataset.score === 'number' ? dataset.score : null;
    var issues  = (dataset.findings && dataset.findings.length) || 0;
    var rows    = (dataset.rows && dataset.rows.length) || 0;
    var cols    = (dataset.columns && dataset.columns.length) || 0;
    var dsName  = dataset.name || 'your dataset';

    /* Determine primary recommendation */
    var rec = getFirstRecommendation(score, issues, rows, cols, dataset.columns || []);

    el.innerHTML = [
      '<div class="dg-aj-nudge-header">',
        '<span class="dg-aj-nudge-icon">' + rec.icon + '</span>',
        '<span class="dg-aj-nudge-title">' + dsName + ' is loaded.</span>',
        '<button class="dg-aj-nudge-close" id="dg-aj-nudge-close" aria-label="Dismiss">&#x00D7;</button>',
      '</div>',
      '<div class="dg-aj-nudge-body">' + rec.body + '</div>',
      '<div class="dg-aj-nudge-actions">',
        rec.actions.map(function (a) {
          return '<button class="dg-aj-nudge-btn ' + a.cls + '" data-action="' + a.action + '">' + a.label + '</button>';
        }).join(''),
      '</div>',
    ].join('');

    /* Show */
    el.classList.add('visible');

    /* Wire buttons */
    el.querySelectorAll('.dg-aj-nudge-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        handleNudgeAction(btn.getAttribute('data-action'));
        dismissNudge();
      });
    });
    var closeBtn = $('dg-aj-nudge-close');
    if (closeBtn) closeBtn.addEventListener('click', dismissNudge);

    /* No auto-dismiss -- stays until the analyst acts or closes it. */
  }

  function dismissNudge() {
    var el = $('dg-aj-nudge');
    if (!el) return;
    el.classList.remove('visible');
  }

  function getFirstRecommendation(score, issues, rows, cols, columns) {
    // PHILOSOPHY: Diagnose, clean, verify, then look. A chart built on
    // unvalidated data does not look wrong -- it looks exactly like a
    // chart built on good data. By the time someone notices the numbers
    // are off, three decisions have already been made from it. This
    // routing exists so trust is earned step by step, not assumed at
    // score zero. Dashboard is the reward, not the starting point.

    /* PHI risk -- always highest priority regardless of score */
    var colNames = columns.map(function (c) { return (c.name || c || '').toLowerCase(); }).join(' ');
    var hasPHI = /\b(ssn|dob|mrn|patient|name|birth|social_sec)\b/.test(colNames);
    if (hasPHI) {
      return {
        icon: '\u26A0\uFE0F',
        body: 'Potential PHI detected in column names. Run Witness first to identify and flag identifiers -- do not explore this data until you know what you are handling.',
        actions: [
          { label: 'Open Witness', action: 'witness', cls: 'dg-aj-nudge-btn-primary' },
          { label: 'I understand the risk', action: 'explore', cls: 'dg-aj-nudge-btn-ghost' },
        ],
      };
    }

    /* Band 1: Critical (0-39) -- structural problems, SQL cleaning required */
    if (score !== null && score < 40) {
      return {
        icon: '\uD83D\uDED1',
        body: issues + ' critical issue' + (issues !== 1 ? 's' : '') + ' found. Any query or chart you run right now is built on broken data -- run the cleaning pass first, or your results will confidently lie to you.',
        actions: [
          { label: 'Run the cleaning pass', action: 'sql', cls: 'dg-aj-nudge-btn-primary' },
          { label: 'See what is broken first', action: 'review', cls: 'dg-aj-nudge-btn-ghost' },
        ],
      };
    }

    /* Band 2: Poor (40-59) -- bad rows skew every number, isolate before proceeding */
    if (score !== null && score < 60) {
      return {
        icon: '\u26A0\uFE0F',
        body: score + '/100. Most rows are usable, but the exceptions are large enough to skew every aggregate -- isolate and fix the bad rows before you trust anything you see.',
        actions: [
          { label: 'Isolate and fix the bad rows', action: 'sql', cls: 'dg-aj-nudge-btn-primary' },
          { label: 'Review the issues first', action: 'review', cls: 'dg-aj-nudge-btn-ghost' },
        ],
      };
    }

    /* Band 3: Fair (60-74) -- cleaning done, verify provenance before trusting results */
    if (score !== null && score < 75) {
      return {
        icon: '\uD83D\uDD0D',
        body: score + '/100. The obvious errors are gone, but you have not verified where this data actually came from or what transformed it -- a clean-looking dataset with unverified lineage will still mislead you.',
        actions: [
          { label: 'Trace where this came from', action: 'witness', cls: 'dg-aj-nudge-btn-primary' },
          { label: 'Continue with SQL', action: 'sql', cls: 'dg-aj-nudge-btn-ghost' },
        ],
      };
    }

    /* Band 4: Good (75-89) -- clean and sourced, get a second set of eyes */
    if (score !== null && score < 90) {
      return {
        icon: '\uD83D\uDC40',
        body: score + '/100. This data is clean enough to work with but not clean enough to ship from -- have a second pass catch the assumptions you have stopped noticing before you turn this into anything anyone else acts on.',
        actions: [
          { label: 'Get a second set of eyes', action: 'review', cls: 'dg-aj-nudge-btn-primary' },
          { label: 'Start writing SQL', action: 'sql', cls: 'dg-aj-nudge-btn-ghost' },
        ],
      };
    }

    /* Band 5: Excellent (90-100) -- earned the right to visualize */
    if (rows > 100000) {
      return {
        icon: '\u2705',
        body: score + '/100 and ' + rows.toLocaleString() + ' rows. Data is trusted -- start with SQL to slice it into a focused view, then build the dashboard from what you find.',
        actions: [
          { label: 'Write the SQL first', action: 'sql', cls: 'dg-aj-nudge-btn-primary' },
          { label: 'Build the dashboard', action: 'dashboard', cls: 'dg-aj-nudge-btn-ghost' },
        ],
      };
    }
    return {
      icon: '\u2705',
      body: score + '/100. This data has been cleaned, sourced, and reviewed -- it has earned the right to be visualized. A chart built on this will tell the truth instead of a convincing story.',
      actions: [
        { label: 'Build the dashboard', action: 'dashboard', cls: 'dg-aj-nudge-btn-primary' },
        { label: 'Write SQL', action: 'sql', cls: 'dg-aj-nudge-btn-ghost' },
        { label: 'Write narrative', action: 'narrative', cls: 'dg-aj-nudge-btn-ghost' },
      ],
    };
  }

  function handleNudgeAction(action) {
    var panelMap = {
      charts:    'charts-view',
      sql:       'sql-view',
      dashboard: 'dashboard-view',
      review:    'review-view',
      narrative: 'narrative-view',
    };
    if (action === 'explore') {
      var analyzeBtn = document.querySelector('.nav-btn[data-view="analyze"]');
      if (analyzeBtn) analyzeBtn.click();
      return;
    }
    if (action === 'witness') {
      var witnessBtn = document.getElementById('sidebar-witness-btn');
      var analyzeBtn2 = document.querySelector('.nav-btn[data-view="analyze"]');
      if (analyzeBtn2) analyzeBtn2.click();
      setTimeout(function () { if (witnessBtn) witnessBtn.click(); }, 300);
      return;
    }
    if (panelMap[action]) {
      var analyzeNav = document.querySelector('.nav-btn[data-view="analyze"]');
      if (analyzeNav) analyzeNav.click();
      setTimeout(function () {
        var pill = document.querySelector('.sidebar-nav-item[data-panel="' + panelMap[action] + '"]');
        if (pill) pill.click();
      }, 300);
    }
  }

  /* ================================================================
     MOMENT 3: Pulse Interpreter
     Injects a "Do this first" recommendation block into the Pulse
     sheet after it populates with real scores.
     Reads the score and findings already rendered in the sheet.
  ================================================================ */
  function attachPulseInterpreter() {
    /* Watch for the pulse sheet to open and populate */
    var observer = new MutationObserver(function () {
      var sheet = document.getElementById('dg-pulse-sheet');
      if (!sheet || !sheet.classList.contains('open')) return;

      /* Already injected? */
      if (sheet.querySelector('.dg-aj-pulse-rec')) return;

      /* Wait for real score to render (not skeleton) */
      var healthEl = document.getElementById('dg-ps-health-val');
      if (!healthEl || healthEl.textContent === '--') return;

      injectPulseRec(sheet, healthEl.textContent);
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  function injectPulseRec(sheet, scoreText) {
    var score = parseInt(scoreText, 10);
    if (isNaN(score)) return;

    var rec = getPulseRec(score);
    var body = document.getElementById('dg-ps-body');
    if (!body) return;

    var recEl = document.createElement('div');
    recEl.className = 'dg-aj-pulse-rec';
    recEl.innerHTML = [
      '<div class="dg-aj-pulse-rec-label">Do this first</div>',
      '<div class="dg-aj-pulse-rec-text">' + rec.text + '</div>',
      '<button class="dg-aj-pulse-rec-cta" data-action="' + rec.action + '">' + rec.label + '</button>',
    ].join('');

    recEl.querySelector('.dg-aj-pulse-rec-cta').addEventListener('click', function () {
      /* Close pulse sheet */
      var closeBtn = document.getElementById('dg-ps-close');
      if (closeBtn) closeBtn.click();
      setTimeout(function () { handleNudgeAction(rec.action); }, 200);
    });

    /* Insert at top of body */
    body.insertBefore(recEl, body.firstChild);
  }

  // PHILOSOPHY: Pulse Interpreter routing exists to enforce the order every
  // competent data professional already follows in their head: diagnose,
  // clean, verify, then look. A dashboard built on unvalidated data does not
  // just fail to help -- it actively lies with confidence, and by the time
  // someone notices the numbers are wrong, three other people have already
  // made decisions off the chart. Routing an analyst to visualization before
  // their data has earned it is the single most expensive mistake this
  // feature can make, because bad charts do not look bad -- they look exactly
  // like good ones. This ladder exists so trust is earned band by band, not
  // assumed at score zero.
  function getPulseRec(score) {
    /* Band 1: Critical (0-39) -- structural problems, SQL cleaning required */
    if (score < 40) {
      return {
        text: 'Your data has structural problems severe enough that any query, chart, or review built on it right now would be built on garbage. Fix the foundation before you do anything else.',
        action: 'sql',
        label: 'Run the cleaning pass',
      };
    }
    /* Band 2: Poor (40-59) -- bad rows skew every downstream number */
    if (score < 60) {
      return {
        text: 'Most of this dataset is usable, but the exceptions are large enough to skew every downstream number. Query out the problem rows before you trust anything you see.',
        action: 'sql',
        label: 'Isolate and fix the bad rows',
      };
    }
    /* Band 3: Fair (60-74) -- cleaning done, trace provenance before trusting results */
    if (score < 75) {
      return {
        text: 'The obvious errors are cleaned up, but you have not verified the source, lineage, or transformation history. A chart built on unverified provenance will mislead you even if the numbers look tidy.',
        action: 'witness',
        label: 'Trace where this data actually came from',
      };
    }
    /* Band 4: Good (75-89) -- clean and sourced, peer review before shipping */
    if (score < 90) {
      return {
        text: 'This dataset is clean enough to work with but not yet clean enough to publish from. Get a second pass to sanity-check your assumptions before you turn it into a visual anyone else will act on.',
        action: 'review',
        label: 'Get a second set of eyes before you ship this',
      };
    }
    /* Band 5: Excellent (90-100) -- earned the right to visualize */
    return {
      text: 'This data has been cleaned, traced, and reviewed -- it has earned the right to be visualized. Now a chart will tell the truth instead of a convincing story.',
      action: 'dashboard',
      label: 'Build the dashboard',
    };
  }

  /* ================================================================
     MOMENT 4: Finish Line
     Fires when the user clicks the narrative generate button or
     reaches the portfolio export step.
     Shows a celebration card with export + portfolio actions.
  ================================================================ */
  var _finishShown = false;

  function buildFinishLine() {
    if ($('dg-aj-finish')) return;
    var el = document.createElement('div');
    el.id = 'dg-aj-finish';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Analysis complete');
    document.body.appendChild(el);
  }

  function showFinishLine(context) {
    if (_finishShown) return;
    _finishShown = true;

    var el = $('dg-aj-finish');
    if (!el) return;

    var dsName   = (context && context.dsName)   || 'your analysis';
    var proofHash = (context && context.proofHash) || null;

    el.innerHTML = [
      '<div class="dg-aj-finish-card">',
        '<div class="dg-aj-finish-spark">&#x2728;</div>',
        '<div class="dg-aj-finish-title">Analysis complete.</div>',
        '<div class="dg-aj-finish-sub">',
          dsName + ' is ready to share. Your proof chain is sealed -- every cleaning step, SQL query, and validation decision is logged.',
        '</div>',
        proofHash
          ? '<div class="dg-aj-finish-proof">Proof fingerprint: ' + proofHash + '</div>'
          : '',
        '<div class="dg-aj-finish-actions">',
          '<button class="dg-aj-finish-btn dg-aj-finish-btn-primary" data-action="export" data-testid="finish-export-btn">Export findings</button>',
          '<button class="dg-aj-finish-btn dg-aj-finish-btn-ghost"    data-action="portfolio" data-testid="finish-portfolio-btn">Add to portfolio</button>',
          '<button class="dg-aj-finish-btn dg-aj-finish-btn-ghost"    data-action="qr" data-testid="finish-qr-btn">QR Sync to mobile</button>',
        '</div>',
        '<button class="dg-aj-finish-dismiss" id="dg-aj-finish-dismiss">Keep exploring</button>',
      '</div>',
    ].join('');

    el.style.display = 'flex';
    setTimeout(function () { el.classList.add('visible'); }, 10);

    /* Wire buttons */
    el.querySelectorAll('.dg-aj-finish-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        handleFinishAction(btn.getAttribute('data-action'));
        dismissFinish();
      });
    });
    $('dg-aj-finish-dismiss').addEventListener('click', dismissFinish);
  }

  function dismissFinish() {
    var el = $('dg-aj-finish');
    if (!el) return;
    el.classList.remove('visible');
    setTimeout(function () { el.style.display = 'none'; }, 420);
  }

  function handleFinishAction(action) {
    if (action === 'export') {
      /* Trigger portfolio export */
      if (window.PortfolioExport && typeof window.PortfolioExport.generate === 'function') {
        window.PortfolioExport.generate();
      } else {
        var exportBtn = document.getElementById('portfolio-export-btn') ||
                        document.querySelector('[data-action="portfolio-export"]');
        if (exportBtn) exportBtn.click();
      }
    }
    if (action === 'portfolio') {
      var portfolioBtn = document.querySelector('[data-action="portfolio"]') ||
                         document.getElementById('dg-ov-portfolio');
      if (portfolioBtn) portfolioBtn.click();
    }
    if (action === 'qr') {
      if (window.DataGlowQRPanel) window.DataGlowQRPanel.open();
    }
  }

  /* ================================================================
     Event wiring
  ================================================================ */
  function wireEvents() {
    /* Moment 2: post-drop nudge */
    document.addEventListener('dataglow:dataset-loaded', function (e) {
      var dataset = (e && e.detail && e.detail.dataset) || {};
      setTimeout(function () { showNudge(dataset); }, 1800);
    });

    /* Moment 4: narrative generate button -> finish line */
    document.addEventListener('click', function (e) {
      var narrBtn = e.target.closest && e.target.closest('#narr-gen-btn, [data-action="generate-narrative"]');
      if (narrBtn) {
        /* Give narrative time to render, then show finish */
        setTimeout(function () {
          var dsName   = window.__DG_DATASET__ ? window.__DG_DATASET__.name : '';
          var proofHash = null;
          if (window.DataGlowProof && typeof window.DataGlowProof.getChainHash === 'function') {
            try { proofHash = window.DataGlowProof.getChainHash(); } catch (_e) {}
          }
          showFinishLine({ dsName: dsName, proofHash: proofHash });
        }, 3500);
        return;
      }

      /* Portfolio export button also triggers finish */
      var exportBtn = e.target.closest && e.target.closest('#portfolio-export-btn, [data-action="portfolio-export"]');
      if (exportBtn) {
        setTimeout(function () {
          showFinishLine({ dsName: window.__DG_DATASET__ ? window.__DG_DATASET__.name : '' });
        }, 500);
      }
    });

    /* Moment 1: hide coach once welcome brief loads sample */
    document.addEventListener('dataglow:dataset-loaded', function () {
      _coachHidden = true;
      if (_coachEl) _coachEl.classList.remove('visible');
    }, { once: true });
  }

  /* ================================================================
     Init
  ================================================================ */
  function init() {
    injectCSS();
    buildNudge();
    buildFinishLine();

    /* Moment 1: landing coach */
    var dz = $('drop-zone');
    if (dz) {
      buildLandingCoach();
    } else {
      /* Drop zone may not exist yet -- wait */
      var dzObs = new MutationObserver(function () {
        if ($('drop-zone')) {
          dzObs.disconnect();
          buildLandingCoach();
        }
      });
      dzObs.observe(document.body, { childList: true, subtree: true });
    }

    /* Moment 3: pulse interpreter */
    attachPulseInterpreter();

    wireEvents();
  }

  /* Delay slightly to let all other modules register first */
  setTimeout(init, 1400);

  window.DataGlowJourney = {
    showFinishLine: showFinishLine,
    showNudge:      showNudge,
    dismissNudge:   dismissNudge,
    dismissFinish:  dismissFinish,
  };

}());
/* ---- end analyst-journey.js ---- */
