/* DataGlow -- js/ux/ux-session-b-prep.js */
/* UX Session B-Prep: three targeted fixes before Session B AI engines land  */
/*                                                                            */
/* Fix 1 -- Touch-aware drop zone                                             */
/*   Detects touch-primary devices and swaps copy + affordance hierarchy.     */
/*   "Drop your data here" -> "Tap to add your data" on touch.                */
/*   File-picker becomes the primary CTA button (not a fallback link).        */
/*                                                                            */
/* Fix 2 -- Sidebar progressive disclosure                                    */
/*   On mobile (<= 768px), analyze sidebar starts collapsed.                  */
/*   The pills bar only shows tools for the ACTIVE mode tab.                  */
/*   A 'More tools' expander reveals the full list.                           */
/*                                                                            */
/* Fix 3 -- Feature surfacing via Analyst Journey                             */
/*   Listens for key DataGlow events and emits contextual nudges              */
/*   pointing users to the right tool at the right moment.                   */
/*   No auto-dismiss. Nudge stays until the analyst acts or closes it.       */

(function () {
  'use strict';

  /* ================================================================
     SHARED HELPERS
  ================================================================ */

  function $(id) { return document.getElementById(id); }

  var isTouchPrimary = (function () {
    /* True when the primary interaction model is touch (no mouse), i.e.
       phones and tablets. A Surface with touch screen but attached keyboard
       still has a mouse -- coarse pointer detects the real case. */
    if (typeof window.matchMedia === 'function') {
      if (window.matchMedia('(pointer: coarse)').matches) return true;
    }
    /* Fallback: touch events present AND no fine pointer */
    return ('ontouchstart' in window) && !window.matchMedia('(pointer: fine)').matches;
  })();

  /* ================================================================
     FIX 1 -- TOUCH-AWARE DROP ZONE
  ================================================================ */

  function initTouchDropZone() {
    if (!isTouchPrimary) return; /* desktop/mouse: no change needed */

    /* Swap the drop zone headline */
    var dropText = $('drop-text');
    if (dropText) {
      dropText.textContent = 'Tap to add your data';
    }

    /* Swap the formats hint to something touch-friendly */
    var dropFormats = $('drop-formats');
    if (dropFormats) {
      dropFormats.textContent = 'CSV, JSON, Excel, Parquet, PDF, and more';
    }

    /* Make the entire drop zone card a tap-to-pick-file target */
    var dropZone = $('drop-zone');
    var fileInput = $('file-input');
    if (dropZone && fileInput) {
      dropZone.style.cursor = 'pointer';
      dropZone.addEventListener('click', function (e) {
        /* Don't intercept clicks on the browse/load links or resume banner */
        var tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'button' || tag === 'a' || tag === 'span') {
          /* Let dedicated buttons handle their own clicks */
          if (e.target.id === 'browse-link' ||
              e.target.id === 'try-example-link' ||
              e.target.id === 'resume-btn' ||
              e.target.id === 'resume-dismiss-btn') return;
        }
        fileInput.click();
      });
    }

    /* Elevate "browse files" to a real primary button for touch */
    var hint = $('drop-zone-hint');
    if (hint && fileInput) {
      /* Build a proper tappable button above the hint */
      var btn = document.createElement('button');
      btn.id = 'touch-pick-btn';
      btn.textContent = 'Choose File';
      btn.setAttribute('aria-label', 'Choose a file to analyze');
      btn.style.cssText = [
        'display:block;margin:12px auto 4px;',
        'background:var(--primary);color:#fff;',
        'border:none;border-radius:10px;',
        'padding:11px 28px;font-size:14px;font-weight:700;',
        'font-family:inherit;cursor:pointer;',
        'letter-spacing:0.02em;',
        'box-shadow:0 2px 8px rgba(32,197,181,0.25);',
      ].join('');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        fileInput.click();
      });
      /* Insert before the hint paragraph */
      hint.parentNode.insertBefore(btn, hint);
      /* Demote the browse link text */
      hint.innerHTML = 'or <span id="browse-link" style="cursor:pointer;">browse files</span> &nbsp;&middot;&nbsp; <span id="try-example-link" style="cursor:pointer;">load example data</span>';
      /* Re-wire the newly created span since it replaced the old one */
      var newBrowse = $('browse-link');
      if (newBrowse) {
        newBrowse.addEventListener('click', function () { fileInput.click(); });
      }
      var newExample = $('try-example-link');
      if (newExample) {
        newExample.addEventListener('click', function () {
          var existing = document.querySelector('[data-sample]') ||
                         document.querySelector('#sample-btn') ||
                         document.querySelector('#load-sample-btn');
          if (existing) { existing.click(); return; }
          /* Fallback: dispatch the same event the old try-example-link used */
          document.dispatchEvent(new CustomEvent('dataglow:load-sample'));
        });
      }
    }
  }

  /* ================================================================
     FIX 2 -- ANALYZE PILLS: show only active-mode tools
  ================================================================ */

  /* Mode-to-panel mapping: which pills belong to which mode tab */
  var MODE_PANELS = {
    explore:  ['charts-view', 'dashboard-view', 'stats-view', 'arena-view'],
    query:    ['sql-view', 'python-view', 'r-view', 'excel-view'],
    validate: ['review-view', 'cases-view'],
  };

  /* All panels (for hide-all pass) */
  var ALL_PANEL_IDS = Object.values(MODE_PANELS).reduce(function (acc, arr) {
    return acc.concat(arr);
  }, []);

  function updatePillsForMode(mode) {
    var pillsBar = $('analyze-pills-bar');
    if (!pillsBar) return;
    var pills = pillsBar.querySelectorAll('.analyze-pill');
    var activePanels = MODE_PANELS[mode] || ALL_PANEL_IDS;
    pills.forEach(function (pill) {
      var target = pill.getAttribute('data-panel');
      if (activePanels.indexOf(target) !== -1) {
        pill.style.display = '';
        pill.removeAttribute('aria-hidden');
      } else {
        pill.style.display = 'none';
        pill.setAttribute('aria-hidden', 'true');
      }
    });
  }

  function initSidebarProgressiveDisclosure() {
    /* Wire mode-tab clicks to filter the pills bar */
    var modeTabs = document.querySelectorAll('.atb-mode-tab');
    modeTabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var mode = tab.getAttribute('data-atb-mode');
        if (mode) updatePillsForMode(mode);
      });
    });

    /* Set initial state based on whichever tab is active */
    var activeTab = document.querySelector('.atb-mode-tab.active');
    if (activeTab) {
      var initialMode = activeTab.getAttribute('data-atb-mode');
      if (initialMode) updatePillsForMode(initialMode);
    }

    /* On mobile: collapse the sidebar by default when analyze view opens */
    if (window.innerWidth <= 768) {
      var sidebar = document.getElementById('analyze-sidebar');
      if (sidebar && !sidebar.classList.contains('sidebar-collapsed')) {
        sidebar.classList.add('sidebar-collapsed');
      }
    }
  }

  /* Re-apply when the analyze view becomes visible */
  document.addEventListener('dataglow:view-changed', function (e) {
    if (e.detail && e.detail.view === 'analyze') {
      var activeTab = document.querySelector('.atb-mode-tab.active');
      if (activeTab) updatePillsForMode(activeTab.getAttribute('data-atb-mode'));
    }
  });

  /* ================================================================
     FIX 3 -- CONTEXTUAL FEATURE SURFACING VIA ANALYST JOURNEY
  ================================================================ */

  /* Nudge registry: event -> nudge config                                     */
  /* Each nudge fires once per session (keyed by id in sessionStorage).        */
  /* No auto-dismiss. Stays until analyst acts or closes it.                  */

  var SEEN_NUDGE_KEY = 'dg_ctx_nudges_seen';

  function getSeenNudges() {
    try { return JSON.parse(sessionStorage.getItem(SEEN_NUDGE_KEY) || '[]'); } catch (_) { return []; }
  }
  function markNudgeSeen(id) {
    try {
      var seen = getSeenNudges();
      if (seen.indexOf(id) === -1) { seen.push(id); sessionStorage.setItem(SEEN_NUDGE_KEY, JSON.stringify(seen)); }
    } catch (_) {}
  }
  function hasSeenNudge(id) { return getSeenNudges().indexOf(id) !== -1; }

  var NUDGE_CONTAINER_ID = 'dg-ctx-nudge';

  function showContextNudge(cfg) {
    /* cfg: { id, icon, title, body, action, actionLabel, panel } */
    if (!cfg || !cfg.id) return;
    if (hasSeenNudge(cfg.id)) return;
    if (!window.FEATURE_FLAGS || !window.FEATURE_FLAGS.analystJourney) return;

    /* Remove any existing nudge first */
    var existing = $(NUDGE_CONTAINER_ID);
    if (existing) existing.remove();

    var el = document.createElement('div');
    el.id = NUDGE_CONTAINER_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
      'position:fixed;bottom:66px;left:50%;transform:translateX(-50%);',
      'z-index:8000;width:min(380px,92vw);',
      'background:var(--surface);border:1px solid var(--primary);',
      'border-radius:14px;padding:14px 16px;',
      'box-shadow:0 8px 32px rgba(0,0,0,0.35);',
      'font-family:\'Geist Mono\',monospace;',
      'animation:dg-nudge-in 0.3s cubic-bezier(0.34,1.56,0.64,1) both;',
    ].join('');

    var actionHtml = cfg.action ? [
      '<button id="dg-ctx-nudge-action" style="',
      'background:var(--primary);color:#fff;border:none;',
      'border-radius:8px;padding:7px 14px;font-size:11px;font-weight:700;',
      'font-family:\'Geist Mono\',monospace;cursor:pointer;',
      'letter-spacing:0.04em;margin-top:10px;display:block;">',
      cfg.actionLabel || 'Open',
      '</button>',
    ].join('') : '';

    el.innerHTML = [
      '<div style="display:flex;align-items:flex-start;gap:10px;">',
      '  <span style="font-size:18px;flex-shrink:0;">' + (cfg.icon || '') + '</span>',
      '  <div style="flex:1;min-width:0;">',
      '    <div style="color:var(--primary);font-size:11px;font-weight:700;letter-spacing:0.06em;margin-bottom:3px;">' + (cfg.title || '') + '</div>',
      '    <div style="color:var(--text-muted);font-size:11px;line-height:1.5;">' + (cfg.body || '') + '</div>',
      actionHtml,
      '  </div>',
      '  <button id="dg-ctx-nudge-close" aria-label="Dismiss" style="',
      '    background:none;border:none;color:var(--text-faint);cursor:pointer;',
      '    font-size:14px;padding:2px 4px;flex-shrink:0;line-height:1;">',
      '    &#x2715;',
      '  </button>',
      '</div>',
    ].join('');

    document.body.appendChild(el);
    markNudgeSeen(cfg.id);

    /* Wire close button -- no auto-dismiss, analyst decides */
    var closeBtn = $('dg-ctx-nudge-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () { el.remove(); });
    }

    /* Wire action button */
    if (cfg.action) {
      var actionBtn = $('dg-ctx-nudge-action');
      if (actionBtn) {
        actionBtn.addEventListener('click', function () {
          el.remove();
          cfg.action();
        });
      }
    }
  }

  /* Add the keyframe animation once */
  (function injectNudgeKeyframe() {
    if (document.getElementById('dg-ctx-nudge-kf')) return;
    var style = document.createElement('style');
    style.id = 'dg-ctx-nudge-kf';
    style.textContent = '@keyframes dg-nudge-in { from { opacity:0; transform:translateX(-50%) translateY(12px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }';
    document.head.appendChild(style);
  })();

  /* Helpers to navigate to a panel */
  function goToPanel(panelId, modeHint) {
    /* Switch to analyze view */
    var analyzeBtn = document.querySelector('.nav-btn[data-view="analyze"]') ||
                     document.querySelector('[data-view="analyze"]');
    if (analyzeBtn) analyzeBtn.click();
    /* Switch mode tab if hint provided */
    if (modeHint) {
      var modeTab = document.querySelector('.atb-mode-tab[data-atb-mode="' + modeHint + '"]');
      if (modeTab) modeTab.click();
    }
    /* Switch panel */
    setTimeout(function () {
      var panelBtn = document.querySelector('[data-panel="' + panelId + '"]');
      if (panelBtn) panelBtn.click();
    }, 80);
  }

  /* ---- Nudge definitions: event -> what to surface ---- */

  /* After data loads: if bias pre-flight found high-severity signals, nudge toward Peer Review */
  document.addEventListener('dataglow:bias-preflight-complete', function (e) {
    var result = e.detail && e.detail.result;
    if (!result) return;
    var highCount = (result.findings || []).filter(function (f) { return f.severity === 'high'; }).length;
    if (highCount === 0) return;
    showContextNudge({
      id: 'bias-high-review',
      icon: '',
      title: 'BIAS SIGNALS DETECTED',
      body: highCount + ' high-severity pattern' + (highCount > 1 ? 's' : '') + ' found in your data. Run Peer Review before querying to catch structural issues early.',
      actionLabel: 'Open Peer Review',
      action: function () { goToPanel('review-view', 'validate'); },
    });
  });

  /* After purpose contract signed as model_training: nudge toward Training Passport */
  document.addEventListener('dataglow:contract-signed', function (e) {
    var contract = e.detail && e.detail.contract;
    if (!contract || contract.purposeId !== 'model_training') return;
    if (!window.FEATURE_FLAGS || !window.FEATURE_FLAGS.trainingPassport) return;
    showContextNudge({
      id: 'training-passport-prompt',
      icon: '',
      title: 'TRAINING PURPOSE ACTIVE',
      body: 'Your passport is ready. It documents the dataset fingerprint, bias audit, and contract signature for governance disclosure.',
      actionLabel: 'Generate Passport',
      action: function () {
        var btn = $('dg-passport-trigger');
        if (btn) btn.click();
      },
    });
  });

  /* After first SQL query runs: if Python panel never opened, nudge toward Python */
  document.addEventListener('dataglow:sql-query-run', function () {
    setTimeout(function () {
      showContextNudge({
        id: 'first-sql-python-hint',
        icon: '',
        title: 'WANT RICHER ANALYSIS?',
        body: 'SQL is great for filtering. Switch to Python for pandas, scikit-learn, or matplotlib visualizations -- all running locally in your browser.',
        actionLabel: 'Try Python',
        action: function () { goToPanel('python-view', 'query'); },
      });
    }, 2000); /* slight delay so it doesn't collide with the SQL result */
  });

  /* After peer review runs: if score < 60, nudge toward SQL cleaning pass */
  document.addEventListener('dataglow:peer-review-complete', function (e) {
    var score = e.detail && typeof e.detail.score === 'number' ? e.detail.score : null;
    if (score === null || score >= 60) return;
    showContextNudge({
      id: 'review-low-score-sql',
      icon: '',
      title: 'DATA QUALITY BELOW THRESHOLD',
      body: 'Score: ' + score + '/100. Run a SQL cleaning pass to fix nulls, duplicates, and type mismatches before moving to analysis.',
      actionLabel: 'Open SQL',
      action: function () { goToPanel('sql-view', 'query'); },
    });
  });

  /* After 3 charts built: nudge toward Dashboard to compose them */
  document.addEventListener('dataglow:chart-added', (function () {
    var chartCount = 0;
    return function () {
      chartCount++;
      if (chartCount !== 3) return;
      showContextNudge({
        id: 'three-charts-dashboard',
        icon: '',
        title: 'READY TO COMPOSE?',
        body: "You've built 3 charts. Switch to Dashboard to arrange them into a shareable view.",
        actionLabel: 'Open Dashboard',
        action: function () { goToPanel('dashboard-view', 'explore'); },
      });
    };
  })());

  /* After dataset loads with >100k rows: surface Arena (AI model comparison) */
  document.addEventListener('dataglow:dataset-loaded', function (e) {
    var ds = e.detail && e.detail.dataset;
    if (!ds || !ds.rows || ds.rows.length < 100000) return;
    if (!window.FEATURE_FLAGS || !window.FEATURE_FLAGS.arena) return;
    showContextNudge({
      id: 'large-dataset-arena',
      icon: '',
      title: 'LARGE DATASET DETECTED',
      body: ds.rows.length.toLocaleString() + ' rows. Use Arena to benchmark SQL vs Python vs R query performance side-by-side.',
      actionLabel: 'Open Arena',
      action: function () { goToPanel('arena-view', 'explore'); },
    });
  });

  /* ================================================================
     INIT
  ================================================================ */

  function init() {
    initTouchDropZone();
    initSidebarProgressiveDisclosure();
    /* Feature surfacing nudges are event-driven -- no init needed */
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.UXBPrep = {
    isTouchPrimary: isTouchPrimary,
    showContextNudge: showContextNudge,
  };

})();
