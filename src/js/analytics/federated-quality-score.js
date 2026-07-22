/* ---- from js/analytics/federated-quality-score.js ---- */
/* ================================================================
   DataGlow Federated Quality Score (Session C, PR #533)
   Feature flag: window.FEATURE_FLAGS.federatedQualityScore

   Composite 0-100 readiness score shown as a ring in the top nav.
   Aggregates: Pulse (40%) + Bias Preflight (25%) + Peer Review (20%)
               + Training Passport (15%)

   Ring color: < 50 = red, 50-69 = amber, 70-89 = teal, 90+ = green.
   Tapping opens a breakdown panel.
================================================================ */
(function () {
  'use strict';

  var FLAG = 'federatedQualityScore';
  function isEnabled() { return !!(window.FEATURE_FLAGS && window.FEATURE_FLAGS[FLAG]); }

  var _scores = { pulse: null, bias: null, peer: null, passport: null };
  var WEIGHTS = { pulse: 0.40, bias: 0.25, peer: 0.20, passport: 0.15 };
  var LABELS  = { pulse: 'Pulse', bias: 'Bias Check', peer: 'Peer Review', passport: 'Passport' };

  var RING_R = 14;
  var RING_CIRCUM = 2 * Math.PI * RING_R;

  function compute() {
    var total = 0, used = 0;
    Object.keys(WEIGHTS).forEach(function (k) {
      if (_scores[k] !== null) { total += _scores[k] * WEIGHTS[k]; used += WEIGHTS[k]; }
    });
    return used === 0 ? null : Math.round(total / used);
  }

  function color(s) {
    if (s === null) return 'var(--border, #252930)';
    if (s >= 90) return '#4AE38A';
    if (s >= 70) return 'var(--primary, #20C5B5)';
    if (s >= 50) return '#F5A623';
    return '#FF4B6B';
  }

  function buildRing() {
    var btn = document.createElement('button');
    btn.id = 'dg-fqs-ring';
    btn.className = 'dg-fqs-ring';
    btn.setAttribute('aria-label', 'Federated Quality Score');
    btn.setAttribute('data-testid', 'button-fqs-ring');
    btn.setAttribute('data-flag-tier', '3');
    btn.title = 'Data readiness score -- tap to see breakdown';
    btn.innerHTML = '<svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">' +
      '<circle cx="18" cy="18" r="' + RING_R + '" fill="none" stroke="var(--border,#252930)" stroke-width="3"/>' +
      '<circle id="dg-fqs-arc" cx="18" cy="18" r="' + RING_R + '" fill="none"' +
      '  stroke="var(--primary,#20C5B5)" stroke-width="3"' +
      '  stroke-dasharray="' + RING_CIRCUM + '" stroke-dashoffset="' + RING_CIRCUM + '"' +
      '  stroke-linecap="round" transform="rotate(-90 18 18)"' +
      '  style="transition:stroke-dashoffset 0.6s cubic-bezier(0.34,1.56,0.64,1),stroke 0.3s ease"/>' +
      '<text id="dg-fqs-text" x="18" y="22" text-anchor="middle"' +
      '  font-size="9" font-family="Geist Mono,monospace" fill="var(--text-muted)">--</text>' +
      '</svg>';
    btn.addEventListener('click', togglePanel);
    return btn;
  }

  function updateRing(score) {
    var arc = document.getElementById('dg-fqs-arc');
    var txt = document.getElementById('dg-fqs-text');
    if (!arc || !txt) return;
    if (score === null) {
      arc.style.strokeDashoffset = RING_CIRCUM;
      txt.textContent = '--';
      arc.style.stroke = 'var(--border,#252930)';
    } else {
      arc.style.strokeDashoffset = RING_CIRCUM * (1 - score / 100);
      arc.style.stroke = color(score);
      txt.textContent = score;
      txt.style.fill = color(score);
    }
  }

  function togglePanel() {
    var existing = document.getElementById('dg-fqs-panel');
    if (existing) { existing.parentNode.removeChild(existing); return; }
    var score = compute();
    var panel = document.createElement('div');
    panel.id = 'dg-fqs-panel';
    panel.className = 'dg-fqs-panel';
    var rows = Object.keys(LABELS).map(function (k) {
      var s = _scores[k];
      return '<div class="dg-fqs-row">' +
        '<span class="dg-fqs-rl">' + LABELS[k] + '</span>' +
        '<div class="dg-fqs-track"><div class="dg-fqs-bar" style="width:' + (s || 0) + '%;background:' + color(s) + '"></div></div>' +
        '<span class="dg-fqs-rs" style="color:' + color(s) + '">' + (s !== null ? s : '--') + '</span>' +
        '</div>';
    }).join('');
    panel.innerHTML = '<div class="dg-fqs-header"><span>Quality Score</span>' +
      '<span style="color:' + color(score) + ';font-weight:700">' + (score !== null ? score : '--') + '</span></div>' +
      rows +
      '<p class="dg-fqs-note">Weighted: Pulse 40% + Bias 25% + Peer Review 20% + Passport 15%</p>';
    var ring = document.getElementById('dg-fqs-ring');
    if (ring) {
      var rect = ring.getBoundingClientRect();
      panel.style.cssText = 'position:fixed;top:' + (rect.bottom + 8) + 'px;right:' + (window.innerWidth - rect.right) + 'px;z-index:19000';
    }
    document.body.appendChild(panel);
    setTimeout(function () {
      document.addEventListener('click', function close(e) {
        if (!panel.contains(e.target) && e.target.id !== 'dg-fqs-ring') {
          if (panel.parentNode) panel.parentNode.removeChild(panel);
          document.removeEventListener('click', close);
        }
      });
    }, 10);
  }

  function injectRing() {
    if (document.getElementById('dg-fqs-ring')) return;
    var ring = buildRing();
    var container = document.querySelector('#nav-right, .nav-right, #top-nav, .top-nav, nav');
    if (container) container.insertBefore(ring, container.firstChild);
    else {
      ring.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top)+8px);right:16px;z-index:9000';
      document.body.appendChild(ring);
    }
  }

  function broadcast() {
    var score = compute();
    updateRing(score);
    document.dispatchEvent(new CustomEvent('dataglow:fqs-updated', {
      detail: { score: score, breakdown: Object.assign({}, _scores) }
    }));
    if (score !== null) {
      document.dispatchEvent(new CustomEvent('dataglow:pulse-scored', {
        detail: { score: score, source: 'fqs' }
      }));
    }
  }

  function init() {
    if (!isEnabled()) return;

    document.addEventListener('dataglow:pulse-scored', function (e) {
      if (e.detail && e.detail.source === 'fqs') return;
      if (e.detail && e.detail.score !== undefined) { _scores.pulse = e.detail.score; broadcast(); }
    });
    document.addEventListener('dataglow:bias-preflight-complete', function (e) {
      if (e.detail && e.detail.score !== undefined) { _scores.bias = e.detail.score; broadcast(); }
    });
    document.addEventListener('dataglow:peer-review-complete', function (e) {
      if (e.detail && e.detail.score !== undefined) {
        _scores.peer = e.detail.score;
      } else if (e.detail && e.detail.passed !== undefined) {
        _scores.peer = e.detail.passed ? 85 : 40;
      }
      broadcast();
    });
    document.addEventListener('dataglow:training-passport-complete', function (e) {
      if (e.detail && e.detail.completeness !== undefined) { _scores.passport = e.detail.completeness; broadcast(); }
    });
    document.addEventListener('dataglow:dataset-loaded', function () {
      Object.keys(_scores).forEach(function (k) { if (_scores[k] === null) _scores[k] = 0; });
      injectRing();
      broadcast();
    });

    window.FederatedQualityScore = {
      compute: compute,
      getBreakdown: function () { return Object.assign({}, _scores); },
      update: function (key, score) { if (_scores.hasOwnProperty(key)) { _scores[key] = score; broadcast(); } }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
/* ---- end js/analytics/federated-quality-score.js ---- */
