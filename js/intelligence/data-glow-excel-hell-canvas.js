/* ---- from js/intelligence/data-glow-excel-hell-canvas.js ---- */
;(function () {
  'use strict';

  var PANEL_ID = 'dg-excel-hell-panel';
  var BTN_ID = 'dg-excel-hell-btn';
  var PREVIEW_ROWS = 20;

  var _dataset = null;
  var _detect = null;   // { findings, recipe }
  var _stepOn = {};      // index -> boolean
  var _applied = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, kind || 'info'); return; } catch (_e) {}
    }
    console.info('[Excel Hell Repair]', msg);
  }

  function flagOn() {
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('excelHellRepair') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function recipeLibraryOn() {
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        if (window.DataGlowFlags.isEnabled('repairRecipeLibrary') === false) return false;
      }
    } catch (_e) {}
    return !!(window.DataGlowRepairRecipeLibraryUI &&
      typeof window.DataGlowRepairRecipeLibraryUI.openSaveDialog === 'function');
  }

  function engine() { return window.DataGlowExcelHellRepair || null; }

  function activeDataset() {
    if (_dataset) return _dataset;
    if (typeof getActiveDataset === 'function') {
      try { var d = getActiveDataset(); if (d) return d; } catch (_e) {}
    }
    if (window.state && window.state.datasets && window.state.datasets[0]) {
      return window.state.datasets[0];
    }
    return null;
  }

  function activeRecipe() {
    if (!_detect || !_detect.recipe) return null;
    var steps = _detect.recipe.steps.filter(function (s, i) {
      return _stepOn[i] !== false;
    });
    var r = {};
    for (var k in _detect.recipe) {
      if (Object.prototype.hasOwnProperty.call(_detect.recipe, k)) r[k] = _detect.recipe[k];
    }
    r.steps = steps;
    return r;
  }

  function stepLabel(step) {
    switch (step.op) {
      case 'promoteHeader': return 'Promote row ' + (step.rowIndex + 1) + ' to header';
      case 'mergeHeaderRows': return 'Merge header rows ' + step.rowIndices.map(function (x) { return x + 1; }).join(' + ');
      case 'dropRows': return 'Drop ' + step.indices.length + ' junk row' + (step.indices.length > 1 ? 's' : '');
      case 'dropRowRange': return 'Drop rows ' + (step.start + 1) + '-' + (step.end + 1);
      case 'renameColumns': return 'Rename columns';
      case 'coerceTypes': return 'Fix ' + Object.keys(step.types).length + ' column type' + (Object.keys(step.types).length > 1 ? 's' : '');
      case 'trimCells': return 'Trim whitespace';
      case 'dropEmptyRows': return 'Drop empty rows';
      case 'dropEmptyColumns': return 'Drop empty columns';
      default: return step.op;
    }
  }

  function needsRepair(det) {
    if (!det || !det.recipe) return false;
    var steps = det.recipe.steps || [];
    // trimCells alone is not "hell"; require a structural or type fix.
    return steps.some(function (s) {
      return s.op !== 'trimCells';
    });
  }

  function scan(ds) {
    var eng = engine();
    if (!eng || !ds) return null;
    try {
      _detect = eng.detect(ds);
      _dataset = ds;
      _stepOn = {};
      (_detect.recipe.steps || []).forEach(function (_s, i) { _stepOn[i] = true; });
      _applied = false;
      return _detect;
    } catch (e) {
      console.warn('[Excel Hell Repair] detect failed', e);
      return null;
    }
  }

  /* ------------------------------- badge ---------------------------------- */

  function badgeState() {
    if (_applied) return 'applied';
    if (needsRepair(_detect)) return 'repair';
    return 'clean';
  }

  function badgeLabel(st) {
    if (st === 'applied') return 'Repaired';
    if (st === 'repair') return 'Repair';
    return 'Repair';
  }

  function updateBadge() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    var st = badgeState();
    btn.setAttribute('data-status', st);
    var lbl = btn.querySelector('[data-eh-label]');
    if (lbl) lbl.textContent = badgeLabel(st);
    var dot = btn.querySelector('.dg-eh-dot');
    if (dot) {
      dot.style.background = st === 'repair'
        ? 'var(--flag, #F5A623)'
        : (st === 'applied' ? 'var(--proof, #4AE38A)' : 'var(--border, #333)');
    }
  }

  /* ------------------------------- panel ---------------------------------- */

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Excel Hell Repair');
    panel.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'height:100%', 'width:min(440px,100%)',
      'background:var(--surface,#141518)', 'color:var(--text,#E8E8E8)',
      'border-left:1px solid var(--border,#2A2C31)', 'box-shadow:-8px 0 32px rgba(0,0,0,.4)',
      'transform:translateX(105%)', 'transition:transform .22s ease', 'z-index:11800',
      'display:flex', 'flex-direction:column'
    ].join(';');
    panel.innerHTML =
      '<div style="width:36px;height:4px;border-radius:2px;background:var(--border,#2A2C31);margin:10px auto 0;flex-shrink:0"></div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid var(--border,#2A2C31);gap:10px">' +
        '<div style="min-width:0">' +
          '<div style="font-weight:800;font-size:15px">Repair</div>' +
          '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:2px">On-device - recipe stays here</div>' +
        '</div>' +
        '<button type="button" data-eh-close style="min-height:44px;min-width:44px;border:none;background:transparent;color:var(--text-muted,#8A8F98);font-size:22px;cursor:pointer;border-radius:10px" aria-label="Close">×</button>' +
      '</div>' +
      '<div id="dg-excel-hell-body" style="flex:1;overflow-y:auto;padding:14px 16px;-webkit-overflow-scrolling:touch"></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-eh-close]').addEventListener('click', closePanel);
    return panel;
  }

  function card(inner) {
    return '<div style="border:1px solid var(--border,#2A2C31);border-radius:12px;padding:12px 14px;margin-bottom:12px;background:var(--surface-2,#1A1C20)">' + inner + '</div>';
  }

  function renderBody() {
    var body = document.getElementById('dg-excel-hell-body');
    if (!body) return;

    if (!_detect) {
      body.innerHTML = card('<div style="color:var(--text-muted,#8A8F98);font-size:13px">Load a spreadsheet and DataGlow will scan it for header, junk rows and type problems. Everything stays on this device.</div>');
      return;
    }

    var findings = _detect.findings || [];
    var eng = engine();

    // Lead with the finding, calm tone.
    var lead = findings.length
      ? findings[0].label
      : 'This file already looks clean';
    var leadDetail = findings.length ? (findings[0].detail || '') : 'No repair needed.';

    // Summary chips.
    var chips = findings.map(function (f) {
      return '<span style="display:inline-block;font-size:11px;padding:4px 9px;border-radius:999px;margin:0 6px 6px 0;' +
        'background:rgba(32,197,181,.12);color:var(--primary,#20C5B5);border:1px solid rgba(32,197,181,.3)">' +
        esc(f.label) + '</span>';
    }).join('') || '<span style="color:var(--text-muted,#8A8F98);font-size:12px">Nothing to fix.</span>';

    // Step list (checkable).
    var steps = (_detect.recipe.steps || []);
    var stepHtml = steps.map(function (s, i) {
      var on = _stepOn[i] !== false;
      return '<label style="display:flex;align-items:center;gap:10px;padding:8px 4px;font-size:13px;cursor:pointer;border-bottom:1px solid var(--border,#22242A)">' +
        '<input type="checkbox" data-eh-step="' + i + '"' + (on ? ' checked' : '') + ' style="width:16px;height:16px;accent-color:var(--primary,#20C5B5)">' +
        '<span>' + esc(stepLabel(s)) + '</span>' +
        '</label>';
    }).join('') || '<div style="color:var(--text-muted,#8A8F98);font-size:12px">No steps.</div>';

    // Preview.
    var previewHtml = '';
    if (eng && _dataset) {
      try {
        var prev = eng.preview(_dataset, activeRecipe(), { limit: PREVIEW_ROWS });
        previewHtml = renderPreview(prev);
      } catch (e) {
        previewHtml = '<div style="color:var(--flag,#F5A623);font-size:12px">Preview unavailable.</div>';
      }
    }

    var canUndo = !!(_dataset && _dataset._excelHellSnapshot);
    var libOn = recipeLibraryOn();

    body.innerHTML =
      card(
        '<div style="font-size:11px;color:var(--text-muted,#8A8F98);letter-spacing:.04em">FINDING</div>' +
        '<div style="font-size:20px;font-weight:800;margin:2px 0 4px;color:var(--primary,#20C5B5)">' + esc(lead) + '</div>' +
        '<div style="font-size:12px;color:var(--text-secondary,#B4B8C0);line-height:1.5">' + esc(leadDetail) + '</div>' +
        '<div style="margin-top:10px">' + chips + '</div>'
      ) +
      card(
        '<div style="font-weight:800;margin-bottom:6px;font-size:13px">Repair steps</div>' +
        '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-bottom:6px">Uncheck any step you want to skip.</div>' +
        stepHtml
      ) +
      card(
        '<div style="font-weight:800;margin-bottom:8px;font-size:13px">Preview (first ' + PREVIEW_ROWS + ' rows)</div>' +
        previewHtml
      ) +
      '<div style="font-size:11px;line-height:1.5;color:var(--text-faint,var(--text-muted,#8A8F98));padding:2px 2px 12px">' +
        'Repair recipe stays on this device. Screening aid for messy files - review before clinical use.' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;padding-bottom:16px">' +
        '<button type="button" data-eh-apply style="flex:1;min-height:44px;border:none;border-radius:10px;background:var(--primary,#20C5B5);color:#04201C;font-weight:800;font-size:14px;cursor:pointer">Apply repair</button>' +
        (canUndo ? '<button type="button" data-eh-undo style="min-height:44px;border:1px solid var(--border,#2A2C31);border-radius:10px;background:transparent;color:var(--text,#E8E8E8);font-weight:600;font-size:13px;padding:0 14px;cursor:pointer">Undo last repair</button>' : '') +
        '<button type="button" data-eh-rescan style="min-height:44px;border:1px solid var(--border,#2A2C31);border-radius:10px;background:transparent;color:var(--text,#E8E8E8);font-weight:600;font-size:13px;padding:0 14px;cursor:pointer">Rescan</button>' +
      '</div>' +
      (libOn
        ? '<div style="display:flex;gap:8px;flex-wrap:wrap;padding-bottom:16px;margin-top:-6px">' +
            '<button type="button" data-eh-save-recipe style="flex:1;min-height:44px;border:1px solid var(--border,#2A2C31);border-radius:10px;background:transparent;color:var(--text,#E8E8E8);font-weight:600;font-size:13px;cursor:pointer">Save recipe</button>' +
            '<button type="button" data-eh-open-library style="flex:1;min-height:44px;border:1px solid var(--border,#2A2C31);border-radius:10px;background:transparent;color:var(--text,#E8E8E8);font-weight:600;font-size:13px;cursor:pointer">Open library</button>' +
          '</div>'
        : '');

    wireBody(body);
  }

  function renderPreview(prev) {
    if (!prev || !prev.columns || !prev.columns.length) {
      return '<div style="color:var(--text-muted,#8A8F98);font-size:12px">Nothing to preview.</div>';
    }
    var head = prev.columns.map(function (c) {
      return '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border,#2A2C31);white-space:nowrap">' +
        esc(c.name) + '<span style="display:block;font-size:9px;color:var(--text-muted,#8A8F98);font-weight:400">' + esc(c.type) + '</span></th>';
    }).join('');
    var bodyRows = prev.rows.map(function (r) {
      var tds = prev.columns.map(function (_c, i) {
        var v = r[i];
        return '<td style="padding:5px 8px;border-bottom:1px solid var(--border,#22242A);white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis">' +
          esc(v == null ? '' : v) + '</td>';
      }).join('');
      return '<tr>' + tds + '</tr>';
    }).join('');
    return '<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:12px;width:100%;font-family:var(--mono,\'Geist Mono\',monospace)">' +
      '<thead><tr>' + head + '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>' +
      '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:6px">' + esc(prev.totalRows) + ' rows after repair</div>';
  }

  function wireBody(body) {
    var checks = body.querySelectorAll('[data-eh-step]');
    for (var i = 0; i < checks.length; i++) {
      checks[i].addEventListener('change', function (e) {
        var idx = parseInt(e.target.getAttribute('data-eh-step'), 10);
        _stepOn[idx] = e.target.checked;
        renderBody();
      });
    }
    var applyBtn = body.querySelector('[data-eh-apply]');
    if (applyBtn) applyBtn.onclick = doApply;
    var undoBtn = body.querySelector('[data-eh-undo]');
    if (undoBtn) undoBtn.onclick = doUndo;
    var rescanBtn = body.querySelector('[data-eh-rescan]');
    if (rescanBtn) rescanBtn.onclick = function () {
      var ds = activeDataset();
      if (!ds) { toast('Load data first', 'warn'); return; }
      scan(ds);
      updateBadge();
      renderBody();
      toast('Rescanned on device');
    };
    var saveBtn = body.querySelector('[data-eh-save-recipe]');
    if (saveBtn) saveBtn.onclick = doSaveRecipe;
    var libBtn = body.querySelector('[data-eh-open-library]');
    if (libBtn) libBtn.onclick = doOpenLibrary;
  }

  function doSaveRecipe() {
    var ui = window.DataGlowRepairRecipeLibraryUI;
    if (!ui || typeof ui.openSaveDialog !== 'function') { toast('Recipe library unavailable', 'warn'); return; }
    var ds = activeDataset();
    var recipe = activeRecipe();
    if (!ds) { toast('Load data first', 'warn'); return; }
    if (!recipe || !recipe.steps.length) { toast('Nothing to save yet', 'warn'); return; }
    ui.openSaveDialog({ kind: 'excelHell', dataset: ds, payload: recipe });
  }

  function doOpenLibrary() {
    var ui = window.DataGlowRepairRecipeLibraryUI;
    if (!ui || typeof ui.openLibrary !== 'function') { toast('Recipe library unavailable', 'warn'); return; }
    ui.openLibrary(activeDataset());
  }

  function doApply() {
    var eng = engine();
    var ds = activeDataset();
    if (!eng || !ds) { toast('Load data first', 'warn'); return; }
    var recipe = activeRecipe();
    if (!recipe || !recipe.steps.length) { toast('Nothing to apply', 'warn'); return; }
    try {
      eng.apply(ds, recipe);
      _applied = true;
      updateBadge();
      notifyDatasetChanged(ds);
      renderBody();
      toast('Repair applied - ' + recipe.steps.length + ' step' + (recipe.steps.length > 1 ? 's' : ''));
    } catch (e) {
      console.warn('[Excel Hell Repair] apply failed', e);
      toast('Repair failed', 'error');
    }
  }

  function doUndo() {
    var eng = engine();
    var ds = activeDataset();
    if (!eng || !ds) return;
    if (eng.undo(ds)) {
      _applied = false;
      scan(ds);
      updateBadge();
      notifyDatasetChanged(ds);
      renderBody();
      toast('Repair undone');
    } else {
      toast('Nothing to undo', 'warn');
    }
  }

  function notifyDatasetChanged(ds) {
    try {
      document.dispatchEvent(new CustomEvent('dataglow:dataset-updated', { detail: { dataset: ds, source: 'excel-hell-repair' } }));
    } catch (_e) {}
    try {
      if (typeof window.renderGrid === 'function') window.renderGrid(ds);
      else if (typeof window.refreshGrid === 'function') window.refreshGrid();
    } catch (_e2) {}
  }

  function openPanel() {
    if (!flagOn()) return;
    var panel = ensurePanel();
    if (!_detect) {
      var ds = activeDataset();
      if (ds) { scan(ds); updateBadge(); }
    }
    renderBody();
    panel.style.transform = 'translateX(0)';
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.transform = 'translateX(105%)';
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header, #analyze-pills, .analyze-pills');
    if (!toolbar) toolbar = document.body;
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open Excel Hell Repair');
    btn.title = 'Repair - clean up messy spreadsheets on device';
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:7px', 'min-height:38px',
      'padding:0 13px', 'border:1px solid var(--border,#2A2C31)', 'border-radius:10px',
      'background:var(--surface-2,#1A1C20)', 'color:var(--text,#E8E8E8)',
      'font-size:13px', 'font-weight:600', 'cursor:pointer'
    ].join(';');
    btn.innerHTML = '<span class="dg-eh-dot" aria-hidden="true" style="width:8px;height:8px;border-radius:50%;background:var(--border,#333);display:inline-block"></span><span data-eh-label>Repair</span>';
    btn.addEventListener('click', function () {
      var panel = document.getElementById(PANEL_ID);
      if (panel && panel.style.transform === 'translateX(0px)') closePanel();
      else openPanel();
    });
    if (toolbar === document.body) {
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '92px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  function onDataset(ds) {
    if (!flagOn() || !ds) return;
    scan(ds);
    updateBadge();
    /* Auto-scan only surfaces the badge; never opens the panel or mutates rows. */
    try {
      if (window.ProvenanceFabric && typeof window.ProvenanceFabric.append === 'function') {
        window.ProvenanceFabric.append('excel_hell_scan', {
          needsRepair: needsRepair(_detect),
          findings: (_detect && _detect.findings ? _detect.findings.length : 0)
        });
      }
    } catch (_e) {}
  }

  function boot() {
    if (!flagOn()) return;
    injectButton();
    ensurePanel();
    updateBadge();

    document.addEventListener('dataglow:dataset-loaded', function (e) {
      var ds = e && e.detail && e.detail.dataset;
      onDataset(ds);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
    });

    window.DataGlowExcelHell = {
      version: 1,
      scan: function (ds) { return scan(ds || activeDataset()); },
      openPanel: openPanel,
      closePanel: closePanel,
      getDetection: function () { return _detect; }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 650); });
  } else {
    setTimeout(boot, 650);
  }
})();
/* ---- end js/intelligence/data-glow-excel-hell-canvas.js ---- */
