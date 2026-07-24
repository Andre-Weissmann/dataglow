/* ---- from js/intelligence/data-glow-column-profiler-hover-canvas.js ---- */
;(function () {
  'use strict';

  var TIP_ID = 'dg-col-profiler-tip';
  var hideTimer = null;
  var pinned = false;
  var lastCol = -1;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pct(n) {
    return Math.round((Number(n) || 0) * 100) + '%';
  }

  function qualityColor(q) {
    if (q >= 80) return 'var(--proof, #4AE38A)';
    if (q >= 55) return 'var(--flag, #F5A623)';
    return 'var(--error, #E85D4C)';
  }

  function ensureTip() {
    var el = document.getElementById(TIP_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = TIP_ID;
    el.setAttribute('role', 'tooltip');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
      'position:fixed',
      'z-index:13000',
      'display:none',
      'min-width:220px',
      'max-width:min(340px,92vw)',
      'padding:12px 14px',
      'border-radius:12px',
      'border:1px solid var(--border,#252930)',
      'background:var(--surface-2, var(--surface,#131519))',
      'box-shadow:var(--shadow-md, 0 12px 32px rgba(0,0,0,.28))',
      'color:var(--text,#E8EAED)',
      'font-family:inherit',
      'font-size:12px',
      'line-height:1.45',
      'pointer-events:auto',
      '-webkit-tap-highlight-color:transparent'
    ].join(';');
    document.body.appendChild(el);

    el.addEventListener('mouseenter', function () {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    });
    el.addEventListener('mouseleave', function () {
      if (!pinned) scheduleHide(120);
    });
    return el;
  }

  function scheduleHide(ms) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      hideTimer = null;
      if (!pinned) hide();
    }, ms == null ? 160 : ms);
  }

  function hide() {
    pinned = false;
    lastCol = -1;
    var el = document.getElementById(TIP_ID);
    if (el) el.style.display = 'none';
  }

  function getProfile(dataset, colIdx) {
    /* Prefer live DataLens cache when it matches this column */
    try {
      if (window.DataLens && typeof window.DataLens.getProfiles === 'function') {
        var list = window.DataLens.getProfiles() || [];
        var col = dataset && dataset.columns && dataset.columns[colIdx];
        var name = col ? (typeof col === 'string' ? col : col.name) : null;
        for (var i = 0; i < list.length; i++) {
          if (name && list[i] && list[i].name === name) return list[i];
        }
      }
    } catch (_e0) {}

    if (window.ColumnProfilerLocal && typeof window.ColumnProfilerLocal.profileColumnLocal === 'function') {
      return window.ColumnProfilerLocal.profileColumnLocal(dataset, colIdx, { sampleCap: 8000 });
    }
    return null;
  }

  function renderTip(profile, meta) {
    var el = ensureTip();
    if (!profile) {
      el.innerHTML = '<div style="font-weight:700">Column</div><div style="color:var(--text-muted)">No profile yet. Load data first.</div>';
      return el;
    }
    var q = Number(profile.quality) || 0;
    var tops = (profile.topValues || []).slice(0, 3).map(function (t) {
      return '<div style="display:flex;justify-content:space-between;gap:10px;min-height:28px;align-items:center">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">' + esc(t.value) + '</span>' +
        '<span style="color:var(--text-muted);font-variant-numeric:tabular-nums">' + esc(t.count) + '</span></div>';
    }).join('');

    var range = '';
    if (profile.min != null && profile.max != null) {
      range = '<div style="display:flex;justify-content:space-between;gap:8px;margin-top:6px"><span style="color:var(--text-muted)">Range</span><span>' +
        esc(profile.min) + ' → ' + esc(profile.max) + '</span></div>';
    }

    var sampleNote = profile.sampled
      ? '<div style="margin-top:6px;font-size:11px;color:var(--text-faint,var(--text-muted))">Sampled ' +
        esc(profile.sampledRows) + ' of ' + esc(profile.rowCount) + ' rows (on device)</div>'
      : '';

    el.innerHTML =
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px">' +
        '<div style="min-width:0">' +
          '<div style="font-weight:800;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(profile.name) + '</div>' +
          '<div style="color:var(--text-muted);font-size:11px;margin-top:2px">' + esc(profile.type || 'STR') + ' · ' + esc(profile.rowCount || 0) + ' rows</div>' +
        '</div>' +
        '<div style="flex:0 0 auto;text-align:right">' +
          '<div style="font-weight:800;font-size:16px;color:' + qualityColor(q) + '">' + q + '</div>' +
          '<div style="font-size:10px;color:var(--text-muted);letter-spacing:.04em">QUALITY</div>' +
        '</div>' +
      '</div>' +
      '<div style="height:6px;border-radius:999px;background:var(--border);overflow:hidden;margin-bottom:10px">' +
        '<div style="height:100%;width:' + q + '%;background:' + qualityColor(q) + ';border-radius:999px"></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">' +
        '<div style="padding:8px 10px;border-radius:8px;background:var(--bg-elevated,var(--bg));border:1px solid var(--border)">' +
          '<div style="font-size:10px;color:var(--text-muted)">Nulls</div>' +
          '<div style="font-weight:700;font-size:14px">' + pct(profile.nullRate) + '</div>' +
        '</div>' +
        '<div style="padding:8px 10px;border-radius:8px;background:var(--bg-elevated,var(--bg));border:1px solid var(--border)">' +
          '<div style="font-size:10px;color:var(--text-muted)">Distinct</div>' +
          '<div style="font-weight:700;font-size:14px">' + esc(profile.cardinality) + '</div>' +
        '</div>' +
      '</div>' +
      range +
      (tops ? '<div style="margin-top:8px;font-size:11px;color:var(--text-muted);margin-bottom:4px">Top values</div>' + tops : '') +
      sampleNote +
      '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
        '<button type="button" data-dg-cp-open style="min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--primary);background:var(--primary);color:#fff;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit">Open DataLens</button>' +
        '<button type="button" data-dg-cp-close style="min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--text-muted);font-weight:600;font-size:12px;cursor:pointer;font-family:inherit">Close</button>' +
      '</div>';

    var openBtn = el.querySelector('[data-dg-cp-open]');
    if (openBtn) {
      openBtn.onclick = function (ev) {
        ev.preventDefault();
        if (window.DataLens && typeof window.DataLens.openPanel === 'function') {
          window.DataLens.openPanel();
        }
      };
    }
    var closeBtn = el.querySelector('[data-dg-cp-close]');
    if (closeBtn) {
      closeBtn.onclick = function (ev) {
        ev.preventDefault();
        hide();
      };
    }
    return el;
  }

  function positionTip(el, info) {
    var hr = info && info.headerRect;
    var vw = window.innerWidth || 360;
    var vh = window.innerHeight || 640;
    el.style.display = 'block';
    var tw = el.offsetWidth || 260;
    var th = el.offsetHeight || 180;
    var left = hr ? hr.left : (info.clientX || 16);
    var top = hr ? (hr.bottom + 8) : ((info.clientY || 40) + 12);
    if (left + tw > vw - 8) left = Math.max(8, vw - tw - 8);
    if (left < 8) left = 8;
    if (top + th > vh - 8) {
      top = hr ? Math.max(8, hr.top - th - 8) : Math.max(8, vh - th - 8);
    }
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  function showFor(info) {
    if (!info || info.colIdx < 0 || !info.dataset) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    lastCol = info.colIdx;
    var profile = getProfile(info.dataset, info.colIdx);
    var el = renderTip(profile, info);
    positionTip(el, info);
  }

  function wrapMount() {
    if (!window.CanvasGrid || typeof window.CanvasGrid.mount !== 'function') return false;
    if (window.CanvasGrid.__dgColProfilerWrapped) return true;
    var orig = window.CanvasGrid.mount;
    window.CanvasGrid.mount = function (container, dataset, opts) {
      opts = opts || {};
      var userHover = opts.onColHover;
      var userEnd = opts.onColHoverEnd;
      opts.onColHover = function (ci, info) {
        try { if (typeof userHover === 'function') userHover(ci, info); } catch (_e) {}
        /* Touch pins; mouse does not */
        pinned = false;
        showFor(info);
      };
      opts.onColHoverEnd = function () {
        try { if (typeof userEnd === 'function') userEnd(); } catch (_e2) {}
        if (!pinned) scheduleHide(140);
      };
      return orig.call(this, container, dataset, opts);
    };
    window.CanvasGrid.__dgColProfilerWrapped = true;
    return true;
  }

  function boot() {
    var tries = 0;
    (function attempt() {
      tries++;
      if (wrapMount()) return;
      if (tries < 40) setTimeout(attempt, 100);
    })();

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hide();
    });
    document.addEventListener('click', function (e) {
      var el = document.getElementById(TIP_ID);
      if (!el || el.style.display === 'none') return;
      if (el.contains(e.target)) return;
      /* Outside click closes (mobile pin friendly) */
      hide();
    });

    window.DataGlowColumnProfilerHover = {
      version: 1,
      showFor: showFor,
      hide: hide,
      getProfile: getProfile
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
/* ---- end js/intelligence/data-glow-column-profiler-hover-canvas.js ---- */
