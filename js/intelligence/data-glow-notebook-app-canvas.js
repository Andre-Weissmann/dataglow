/* ---- from js/intelligence/data-glow-notebook-app-canvas.js ---- */
;(function () {
  'use strict';

  /* Notebook to App: the wire between a notebook that already ran on this
     device and the one-file app the pure engine builds.

     This module owns exactly two things the engine cannot: the "Save as app"
     button inside each notebook toolbar, and the confirm sheet. The sheet is
     not a yes/no. It lists, in plain language, every kind of thing that is
     about to be written, runs the notebook text past PHI Shield first, and only
     then offers the button that hands the file over. Nothing is written until
     that button is pressed.

     Why a sheet instead of window.confirm: the whole point is disclosure, and a
     native confirm cannot show a list, a warning, or the "leave the results
     out" choice that a PHI hit makes the sensible default.

     Styles are injected at runtime here rather than added to the canvas
     stylesheet, matching the two notebook canvases this joins. */

  var SHEET_ID = 'dg-nb-app-sheet';
  var STYLE_ID = 'dg-nb-app-styles';
  var BTN_ATTR = 'data-nb-app-btn';

  /* One entry per notebook surface. Each notebook canvas builds its own toolbar
     the first time its panel is opened, so mounting is retried on nav clicks
     rather than done once at boot. */
  var TARGETS = [
    {
      runtime: 'python',
      toolbarId: 'py-notebook-toolbar',
      btnClass: 'dg-nb-btn',
      nav: '[data-panel="python-view"]',
      global: 'DataGlowPythonNotebook',
      defaultTitle: 'Python notebook'
    },
    {
      runtime: 'r',
      toolbarId: 'r-notebook-toolbar',
      btnClass: 'dg-rnb-btn',
      nav: '[data-panel="r-view"]',
      global: 'DataGlowRNotebook',
      defaultTitle: 'R notebook'
    }
  ];

  var _sheetState = null;

  function engine() { return window.DataGlowNotebookAppExport || null; }

  /* Same read as the notebook surfaces this sits inside: a flags provider is
     honored when present, and its absence means on. */
  function flagOn() {
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('notebookToApp') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, kind || 'info'); return; } catch (_e) {}
    }
    console.info('[Notebook app]', msg);
  }

  function esc(s) {
    var e = engine();
    if (e && typeof e.escapeHtml === 'function') return e.escapeHtml(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function notebookOf(target) {
    try {
      var api = window[target.global];
      if (api && typeof api.getNotebook === 'function') return api.getNotebook();
    } catch (_e) {}
    return null;
  }

  /* ---------------------------- guards ------------------------------------ */

  /* PHI Shield gets the exact text that would travel, before the user is asked.
     A hit does not block the export: it flips the default to leaving results
     out and says why, which is the honest order for a local file the user owns. */
  function scanPhi(text) {
    var out = { available: false, sensitiveFound: false, count: 0, patterns: [] };
    var shield = window.DataGlowPhiShield;
    if (!shield || typeof shield.guardOrBlock !== 'function') return out;
    var res;
    try { res = shield.guardOrBlock({ text: String(text || '') }); } catch (_e) { return out; }
    if (!res || res.ok !== true) return out;
    out.available = true;
    out.sensitiveFound = !!res.sensitiveFound;
    (Array.isArray(res.findings) ? res.findings : []).forEach(function (f) {
      if (!f) return;
      out.count += typeof f.count === 'number' ? f.count : 1;
      var name = f.pattern || f.type;
      if (name && out.patterns.indexOf(name) === -1) out.patterns.push(name);
    });
    return out;
  }

  /* Air-Gap Mode blocks paths that leave the device over the network. Writing a
     file to this machine is not one of them, so the mode must not refuse it.
     What it does change is what is worth saying: while the mode is on, the fact
     that the app file makes no network calls is the reassurance to lead with. */
  function airGapLine() {
    var ui = window.DataGlowAirGapUI;
    if (!ui || typeof ui.isActive !== 'function') return '';
    var on = false;
    try { on = !!ui.isActive(); } catch (_e) { return ''; }
    if (!on) return '';
    return 'Air-Gap Mode is on. This file is built here and calls nothing, so saving it is allowed.';
  }

  /* ---------------------------- styles ------------------------------------ */

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#' + SHEET_ID + '{position:fixed;inset:0;z-index:12080;display:none;',
      'align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.55)}',
      '#' + SHEET_ID + '.open{display:flex}',
      '#' + SHEET_ID + ' .dg-nba-box{width:min(520px,100%);max-height:88vh;overflow-y:auto;',
      'background:var(--surface,#151820);border:1px solid var(--border,#282D38);border-radius:16px;',
      'box-shadow:0 18px 48px rgba(0,0,0,.45)}',
      '#' + SHEET_ID + ' .dg-nba-head{padding:16px 18px 10px;border-bottom:1px solid var(--border,#282D38)}',
      '#' + SHEET_ID + ' .dg-nba-title{font-size:16px;font-weight:800;margin:0}',
      '#' + SHEET_ID + ' .dg-nba-sub{font-size:12px;color:var(--text-muted,#9AA1AE);margin:4px 0 0;line-height:1.5}',
      '#' + SHEET_ID + ' .dg-nba-body{padding:14px 18px}',
      '#' + SHEET_ID + ' .dg-nba-what{font-size:11px;font-weight:700;letter-spacing:.05em;',
      'text-transform:uppercase;color:var(--text-muted,#9AA1AE);margin:0 0 8px}',
      '#' + SHEET_ID + ' ul.dg-nba-list{margin:0;padding:0;list-style:none}',
      '#' + SHEET_ID + ' ul.dg-nba-list li{position:relative;padding:0 0 8px 18px;font-size:13px;line-height:1.55}',
      '#' + SHEET_ID + ' ul.dg-nba-list li:before{content:"";position:absolute;left:2px;top:8px;',
      'width:6px;height:6px;border-radius:50%;background:var(--primary,#20C5B5)}',
      '#' + SHEET_ID + ' .dg-nba-flag{margin:10px 0 0;padding:10px 12px;border-radius:10px;font-size:12.5px;',
      'line-height:1.55;border:1px solid var(--border,#282D38);color:var(--text-secondary,#B4B8C0)}',
      '#' + SHEET_ID + ' .dg-nba-flag.warn{border-color:var(--warn,#E3A34A);color:var(--warn,#E3A34A)}',
      '#' + SHEET_ID + ' .dg-nba-opt{display:flex;gap:10px;align-items:flex-start;margin:14px 0 0;',
      'font-size:13px;line-height:1.5;cursor:pointer}',
      '#' + SHEET_ID + ' .dg-nba-opt input{margin:3px 0 0;width:18px;height:18px;flex:0 0 auto}',
      '#' + SHEET_ID + ' .dg-nba-foot{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end;',
      'padding:12px 18px 16px;border-top:1px solid var(--border,#282D38)}',
      '#' + SHEET_ID + ' .dg-nba-btn{min-height:44px;padding:0 16px;border-radius:10px;font:inherit;',
      'font-size:13px;font-weight:700;cursor:pointer;border:1px solid var(--border,#282D38);',
      'background:transparent;color:var(--text-muted,#9AA1AE)}',
      '#' + SHEET_ID + ' .dg-nba-btn.primary{background:var(--primary,#20C5B5);color:#04201C;border-color:transparent}',
      '#' + SHEET_ID + ' .dg-nba-btn:hover{opacity:.9}',
      '@media (max-width:640px){#' + SHEET_ID + ' .dg-nba-btn{flex:1 1 100%}}'
    ].join('');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ---------------------------- confirm sheet ----------------------------- */

  function ensureSheet() {
    var sheet = document.getElementById(SHEET_ID);
    if (sheet) return sheet;
    ensureStyles();
    sheet = document.createElement('div');
    sheet.id = SHEET_ID;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Save this notebook as an app');
    sheet.innerHTML = '<div class="dg-nba-box"></div>';
    sheet.addEventListener('click', function (ev) {
      if (ev.target === sheet) closeSheet();
    });
    document.body.appendChild(sheet);
    return sheet;
  }

  function closeSheet() {
    var sheet = document.getElementById(SHEET_ID);
    if (sheet) sheet.classList.remove('open');
    _sheetState = null;
  }

  function renderSheet() {
    var st = _sheetState;
    var e = engine();
    if (!st || !e) return;
    var box = document.getElementById(SHEET_ID).querySelector('.dg-nba-box');
    var summary = e.summarizeNotebook(st.notebook, st.runtime);
    var lines = e.describeDisclosure(summary, { includeOutputs: st.includeOutputs });

    var flags = '';
    if (st.phi.sensitiveFound) {
      flags += '<div class="dg-nba-flag warn">' +
        esc('PHI Shield matched ' + st.phi.count + ' possible sensitive value' +
          (st.phi.count === 1 ? '' : 's') + ' in this notebook (' + st.phi.patterns.join(', ') +
          '). Leaving the results out is the safer choice, so it is preselected.') +
        '</div>';
    }
    var ag = airGapLine();
    if (ag) flags += '<div class="dg-nba-flag">' + esc(ag) + '</div>';

    box.innerHTML =
      '<div class="dg-nba-head">' +
        '<p class="dg-nba-title">' + esc('Save as an app') + '</p>' +
        '<p class="dg-nba-sub">' +
          esc('One file that opens by double click, works with no internet, and needs nothing installed. ' +
            'Nothing is written until you press Save.') +
        '</p>' +
      '</div>' +
      '<div class="dg-nba-body">' +
        '<p class="dg-nba-what">' + esc('What goes in the file') + '</p>' +
        '<ul class="dg-nba-list">' +
          lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') +
        '</ul>' +
        flags +
        '<label class="dg-nba-opt">' +
          '<input type="checkbox" data-nba-outputs' + (st.includeOutputs ? ' checked' : '') + '>' +
          '<span>' + esc('Include the results each cell produced, plots included.') + '</span>' +
        '</label>' +
      '</div>' +
      '<div class="dg-nba-foot">' +
        '<button type="button" class="dg-nba-btn" data-nba-cancel>' + esc('Cancel') + '</button>' +
        '<button type="button" class="dg-nba-btn primary" data-nba-save>' + esc('Save the file') + '</button>' +
      '</div>';

    box.querySelector('[data-nba-outputs]').onchange = function (ev) {
      st.includeOutputs = !!ev.target.checked;
      renderSheet();
    };
    box.querySelector('[data-nba-cancel]').onclick = closeSheet;
    box.querySelector('[data-nba-save]').onclick = saveApp;
  }

  function openSheet(runtime) {
    if (!flagOn()) return false;
    var e = engine();
    if (!e) { toast('Notebook app builder unavailable', 'error'); return false; }
    var target = null;
    TARGETS.forEach(function (t) { if (t.runtime === e.normalizeRuntime(runtime)) target = t; });
    if (!target) return false;

    var nb = notebookOf(target);
    if (!nb || !Array.isArray(nb.cells) || nb.cells.length === 0) {
      toast('Add a cell to the notebook first, then save it as an app', 'error');
      return false;
    }

    var phi = scanPhi(e.collectText(nb, { includeOutputs: true }));
    _sheetState = {
      runtime: target.runtime,
      notebook: nb,
      title: (typeof nb.title === 'string' && nb.title.trim()) || target.defaultTitle,
      /* A PHI hit flips the default rather than removing the choice: the user
         still owns the file, and code-only is the safer starting point. */
      includeOutputs: !phi.sensitiveFound,
      phi: phi
    };
    ensureSheet().classList.add('open');
    renderSheet();
    return true;
  }

  /* ---------------------------- the handoff ------------------------------- */

  function saveApp() {
    var st = _sheetState;
    var e = engine();
    if (!st || !e) return null;
    var built = e.buildAppHtml(st.notebook, {
      runtime: st.runtime,
      title: st.title,
      includeOutputs: st.includeOutputs
    });
    if (!built.ok) {
      toast(built.error || 'Could not build the app file', 'error');
      return null;
    }
    var url = '';
    try {
      var blob = new Blob([built.html], { type: 'text/html;charset=utf-8' });
      url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = built.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (_e) {
      if (url) URL.revokeObjectURL(url);
      toast('Could not save the app file', 'error');
      return null;
    }
    setTimeout(function () { if (url) URL.revokeObjectURL(url); }, 1000);
    closeSheet();
    toast('Saved ' + built.filename + ' to this device');
    try {
      document.dispatchEvent(new CustomEvent('dataglow:notebook-app-saved', {
        detail: { filename: built.filename, runtime: st.runtime, bytes: built.bytes, includeOutputs: st.includeOutputs }
      }));
    } catch (_e) {}
    return built;
  }

  /* ---------------------------- mounting --------------------------------- */

  function mountInto(target) {
    var toolbar = document.getElementById(target.toolbarId);
    if (!toolbar) return false;
    if (toolbar.querySelector('[' + BTN_ATTR + ']')) return true;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = target.btnClass;
    btn.setAttribute(BTN_ATTR, target.runtime);
    btn.textContent = 'Save as app';
    btn.title = 'Build a one-file offline app from this notebook';
    btn.addEventListener('click', function () { openSheet(target.runtime); });
    toolbar.appendChild(btn);
    return true;
  }

  function mountAll() {
    if (!flagOn()) return 0;
    var n = 0;
    TARGETS.forEach(function (t) { if (mountInto(t)) n += 1; });
    return n;
  }

  function boot() {
    if (!flagOn()) return;

    mountAll();
    /* The notebook canvases build their toolbars when their panel is first
       opened, so retry on the same nav clicks they listen to. */
    TARGETS.forEach(function (t) {
      var nav = document.querySelector(t.nav);
      if (nav) nav.addEventListener('click', function () { setTimeout(function () { mountInto(t); }, 140); });
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeSheet();
    });

    window.DataGlowNotebookApp = {
      version: 1,
      open: openSheet,
      close: closeSheet,
      mount: mountAll,
      isOpen: function () {
        var sheet = document.getElementById(SHEET_ID);
        return !!(sheet && sheet.classList.contains('open'));
      },
      /* Exposed so a caller can build the file without the sheet. The sheet is
         the human confirm for the button path; a caller reaching for this has
         already decided. */
      build: function (nb, opts) {
        var e = engine();
        return e ? e.buildAppHtml(nb, opts || {}) : null;
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 820); });
  } else {
    setTimeout(boot, 820);
  }
})();
/* ---- end js/intelligence/data-glow-notebook-app-canvas.js ---- */
