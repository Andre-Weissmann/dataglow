/* ---- from js/intelligence/data-glow-mobile-phi-firstrun-canvas.js ---- */
;(function () {
  'use strict';

  var STRIP_ID = 'dg-firstrun-calm-strip';
  var STYLE_ID = 'dg-firstrun-calm-styles';
  var PHI_BTN_ID = 'dg-phi-shield-btn';
  var CHIP_MOBILE_CLASS = 'dg-phi-chip-mobile';

  function calm() { return window.DataGlowMobilePhiFirstRunCalm || null; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function flagOn() {
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('mobilePhiFirstRunCalm') !== false;
      }
    } catch (_e) {}
    return true;
  }

  // A dataset is loaded when the app has flipped body.has-data (the same signal
  // that hides #dg-landing-ctas) or state carries at least one dataset.
  function hasDataset() {
    try {
      if (document.body && document.body.classList.contains('has-data')) return true;
    } catch (_e) {}
    try {
      if (window.state && window.state.datasets && window.state.datasets.length > 0) return true;
    } catch (_e2) {}
    return false;
  }

  function firstRun() {
    var c = calm();
    if (!c) return false;
    try { return c.isFirstRun() === true; } catch (_e) { return false; }
  }

  function markSeen() {
    var c = calm();
    if (!c) return;
    try { c.markFirstRunSeen(); } catch (_e) {}
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      /* Mobile-safe PHI chip: 44px touch target, safe-area aware, no truncation
         into emptiness (short labels come from the pure helper). */
      '#' + PHI_BTN_ID + '.' + CHIP_MOBILE_CLASS + '{' +
        'min-height:44px;min-width:44px;white-space:nowrap;' +
        'max-width:none;overflow:visible;text-overflow:clip;' +
      '}' +
      '#' + PHI_BTN_ID + '.' + CHIP_MOBILE_CLASS + ' [data-phi-label]{' +
        'overflow:hidden;text-overflow:ellipsis;max-width:8.5em;' +
      '}' +

      /* First-run calm strip: one quiet line, no modal, no timer. */
      '#' + STRIP_ID + '{' +
        'position:fixed;left:0;right:0;z-index:11000;' +
        'bottom:calc(env(safe-area-inset-bottom, 0px) + 12px);' +
        'margin:0 auto;max-width:640px;box-sizing:border-box;' +
        'padding:12px 14px;' +
        'padding-left:calc(14px + env(safe-area-inset-left, 0px));' +
        'padding-right:calc(14px + env(safe-area-inset-right, 0px));' +
        'display:flex;align-items:center;gap:12px;' +
        'background:var(--surface, #131519);color:var(--text, #E6E9EF);' +
        'border:1px solid var(--border, #2A2E37);border-radius:14px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.28);' +
        'font-family:inherit;font-size:13px;line-height:1.4;' +
        'transform:translateY(8px);opacity:0;transition:opacity .2s ease, transform .2s ease;' +
      '}' +
      '#' + STRIP_ID + '.open{transform:translateY(0);opacity:1;}' +
      '#' + STRIP_ID + ' .dg-fr-dot{' +
        'width:8px;height:8px;border-radius:50%;flex:0 0 auto;' +
        'background:var(--proof, #4AE38A);' +
      '}' +
      /* A50.1: title/primary raised to the 16px floor (was 13px/12px);
         body caption raised to the 14px caption floor (was 12px). */
      '#' + STRIP_ID + ' .dg-fr-text{flex:1 1 auto;min-width:0;}' +
      '#' + STRIP_ID + ' .dg-fr-title{font-weight:800;font-size:16px;}' +
      '#' + STRIP_ID + ' .dg-fr-body{color:var(--text-muted, #8A8F98);font-size:14px;margin-top:2px;}' +
      '#' + STRIP_ID + ' .dg-fr-primary{' +
        'min-height:44px;padding:0 14px;border-radius:10px;flex:0 0 auto;' +
        'background:var(--primary, #01696F);color:#fff;border:1px solid var(--primary, #01696F);' +
        'font-family:inherit;font-size:16px;font-weight:700;cursor:pointer;' +
      '}' +
      '#' + STRIP_ID + ' .dg-fr-dismiss{' +
        'min-height:44px;min-width:44px;flex:0 0 auto;' +
        'background:transparent;border:none;color:var(--text-muted, #8A8F98);' +
        'font-size:20px;line-height:1;cursor:pointer;border-radius:10px;' +
      '}' +

      /* Narrow screens: full-bleed chrome, stack the strip so nothing clips. */
      '@media (max-width: 720px){' +
        '#' + PHI_BTN_ID + '.' + CHIP_MOBILE_CLASS + '{margin-left:4px;padding:0 10px;}' +
        '#' + PHI_BTN_ID + '.' + CHIP_MOBILE_CLASS + ' [data-phi-label]{max-width:6.5em;}' +
        '#' + STRIP_ID + '{' +
          'left:8px;right:8px;bottom:calc(env(safe-area-inset-bottom, 0px) + 8px);' +
          'flex-wrap:wrap;' +
        '}' +
        '#' + STRIP_ID + ' .dg-fr-text{flex:1 1 100%;order:1;}' +
        '#' + STRIP_ID + ' .dg-fr-dot{order:0;}' +
        '#' + STRIP_ID + ' .dg-fr-primary{order:2;flex:1 1 auto;}' +
        '#' + STRIP_ID + ' .dg-fr-dismiss{order:3;}' +
      '}';
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Progressive enhancement of the existing PHI Shield chip: add the mobile
  // class + a marker attribute. Never replaces or breaks the shield's own
  // behavior; if the button is not present yet we simply skip (boot retries).
  function enhanceChip() {
    var btn = document.getElementById(PHI_BTN_ID);
    if (!btn) return false;
    btn.classList.add(CHIP_MOBILE_CLASS);
    btn.setAttribute('data-phi-chip-mobile', '1');
    return true;
  }

  function triggerLoad() {
    var browse = document.getElementById('browse-link');
    if (browse) { try { browse.click(); return; } catch (_e) {} }
    var input = document.getElementById('file-input');
    if (input) { try { input.click(); return; } catch (_e2) {} }
    var dz = document.getElementById('drop-zone');
    if (dz && typeof dz.scrollIntoView === 'function') {
      try { dz.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_e3) {}
    }
  }

  function removeStrip() {
    var el = document.getElementById(STRIP_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // Dismiss = user chose to close the calm line. Persist "seen" so it never
  // returns on later visits, then remove it. No timer path ever calls this.
  function dismiss() {
    markSeen();
    removeStrip();
  }

  function buildStrip() {
    var c = calm();
    var copy = c ? c.calmCopy() : {
      title: 'Your data stays on this device',
      body: 'Files stay on this device. PHI Shield watches locally.',
      primary: 'Drop a file or browse',
      dismiss: 'Dismiss',
    };
    var strip = document.createElement('div');
    strip.id = STRIP_ID;
    strip.setAttribute('role', 'region');
    strip.setAttribute('aria-label', 'On-device privacy notice');
    strip.innerHTML =
      '<span class="dg-fr-dot" aria-hidden="true"></span>' +
      '<div class="dg-fr-text">' +
        '<div class="dg-fr-title">' + esc(copy.title) + '</div>' +
        '<div class="dg-fr-body">' + esc(copy.body) + '</div>' +
      '</div>' +
      '<button type="button" class="dg-fr-primary" data-fr-primary>' + esc(copy.primary) + '</button>' +
      '<button type="button" class="dg-fr-dismiss" data-fr-dismiss aria-label="' + esc(copy.dismiss) + '">×</button>';
    strip.querySelector('[data-fr-primary]').addEventListener('click', function () {
      triggerLoad();
    });
    strip.querySelector('[data-fr-dismiss]').addEventListener('click', dismiss);
    return strip;
  }

  function shouldShow() {
    var c = calm();
    var state = { hasDataset: hasDataset(), firstRun: firstRun(), flagOn: flagOn() };
    if (c && typeof c.shouldShowCalmStrip === 'function') {
      return c.shouldShowCalmStrip(state) === true;
    }
    return state.flagOn && !state.hasDataset && state.firstRun;
  }

  // Render (or refresh) the strip based on current state. Idempotent: called on
  // boot and whenever state may have changed.
  function refresh() {
    ensureStyles();
    enhanceChip();
    if (!shouldShow()) {
      removeStrip();
      return;
    }
    if (document.getElementById(STRIP_ID)) return;
    var strip = buildStrip();
    document.body.appendChild(strip);
    /* next frame -> transition in */
    requestAnimationFrame(function () { strip.classList.add('open'); });
  }

  function onDatasetLoaded() {
    // A file arrived: the calm strip's job is done. Mark seen so it does not
    // reappear, then remove it.
    markSeen();
    removeStrip();
  }

  function boot() {
    if (!flagOn()) return;
    refresh();

    document.addEventListener('dataglow:dataset-loaded', onDatasetLoaded);

    // The PHI Shield button mounts on a delay; retry the chip enhancement a few
    // times so the mobile class lands even if we booted first.
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (enhanceChip() || tries >= 10) clearInterval(iv);
    }, 400);

    window.DataGlowMobilePhiFirstRunUI = {
      version: 1,
      refresh: refresh,
      dismiss: dismiss,
      enhanceChip: enhanceChip,
      shouldShow: shouldShow,
      isVisible: function () { return !!document.getElementById(STRIP_ID); },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 650); });
  } else {
    setTimeout(boot, 650);
  }
})();
/* ---- end js/intelligence/data-glow-mobile-phi-firstrun-canvas.js ---- */
