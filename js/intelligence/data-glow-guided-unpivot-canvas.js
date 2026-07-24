/* ---- from js/intelligence/data-glow-guided-unpivot-canvas.js ---- */
;(function () {
  'use strict';

  // Panel + host ids double as the live capability markers (unpivot-view /
  // unpivot-body). Self-contained slide-in panel like the Excel Hell canvas so
  // it works identically on web, Tauri desktop, and the PWA without depending
  // on the analyze-pill panel switcher internals.
  var PANEL_ID = 'unpivot-view';
  var BODY_ID = 'unpivot-body';
  var BTN_ID = 'dg-unpivot-btn';
  var PREVIEW_ROWS = 20;

  var _dataset = null;
  var _config = null;
  var _focusWell = 'unpivot'; // 'keep' | 'unpivot' - which well a picker click fills
  var _sqlOpen = false;
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
    console.info('[Guided Unpivot]', msg);
  }

  function flagOn() {
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('guidedUnpivot') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function engine() { return window.DataGlowGuidedUnpivot || null; }

  function activeDataset() {
    if (typeof window.getActiveDataset === 'function') {
      try { var d = window.getActiveDataset(); if (d) return d; } catch (_e) {}
    }
    if (_dataset) return _dataset;
    if (window.state && window.state.datasets && window.state.datasets[0]) {
      return window.state.datasets[0];
    }
    return null;
  }

  function columnNames(ds) {
    var cols = (ds && ds.columns) || [];
    return cols.map(function (c, i) {
      if (c == null) return 'col' + (i + 1);
      return (typeof c === 'string') ? c : (c.name || ('col' + (i + 1)));
    });
  }

  function ensureConfig(ds) {
    var eng = engine();
    if (!eng || !ds) return null;
    var names = columnNames(ds);
    var sample = (ds.rows || []).slice(0, 30);
    _config = eng.suggestConfig(names, sample);
    _config.allColumns = names;
    _config.sourceTable = ds.name || 'dataset';
    _applied = false;
    _dataset = ds;
    return _config;
  }

  /* ------------------------------- badge ---------------------------------- */

  function updateBadge() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    var dot = btn.querySelector('.dg-up-dot');
    if (dot) {
      dot.style.background = _applied
        ? 'var(--proof, #4AE38A)'
        : 'var(--primary, #20C5B5)';
    }
  }

  /* ------------------------------- panel ---------------------------------- */

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Guided Unpivot');
    panel.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'height:100%', 'width:min(460px,100%)',
      'background:var(--surface,#141518)', 'color:var(--text,#E8E8E8)',
      'border-left:1px solid var(--border,#2A2C31)', 'box-shadow:-8px 0 32px rgba(0,0,0,.4)',
      'transform:translateX(105%)', 'transition:transform .22s ease', 'z-index:11800',
      'display:flex', 'flex-direction:column'
    ].join(';');
    panel.innerHTML =
      '<div style="width:36px;height:4px;border-radius:2px;background:var(--border,#2A2C31);margin:10px auto 0;flex-shrink:0"></div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid var(--border,#2A2C31);gap:10px">' +
        '<div style="min-width:0">' +
          '<div style="font-weight:800;font-size:15px">Guided Unpivot</div>' +
          '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:2px">On-device reshape</div>' +
        '</div>' +
        '<button type="button" data-up-close style="min-height:44px;min-width:44px;border:none;background:transparent;color:var(--text-muted,#8A8F98);font-size:22px;cursor:pointer;border-radius:10px" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div id="' + BODY_ID + '" style="flex:1;overflow-y:auto;padding:14px 16px;-webkit-overflow-scrolling:touch"></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-up-close]').addEventListener('click', closePanel);
    return panel;
  }

  function card(inner) {
    return '<div style="border:1px solid var(--border,#2A2C31);border-radius:12px;padding:12px 14px;margin-bottom:12px;background:var(--surface-2,#1A1C20)">' + inner + '</div>';
  }

  function chip(label, well, active) {
    var bg = well === 'keep' ? 'rgba(74,227,138,.14)' : 'rgba(32,197,181,.14)';
    var bd = well === 'keep' ? 'rgba(74,227,138,.4)' : 'rgba(32,197,181,.4)';
    var col = well === 'keep' ? 'var(--proof,#4AE38A)' : 'var(--primary,#20C5B5)';
    return '<button type="button" data-up-chip="' + esc(label) + '" data-up-well="' + well + '" ' +
      'style="display:inline-flex;align-items:center;gap:6px;min-height:32px;font-size:12px;padding:5px 11px;border-radius:999px;margin:0 6px 6px 0;cursor:pointer;' +
      'background:' + bg + ';color:' + col + ';border:1px solid ' + bd + '">' +
      esc(label) + '<span aria-hidden="true" style="opacity:.7">&times;</span></button>';
  }

  function pickerItem(name, inKeep, inUnpiv) {
    var tag = inKeep ? ' &middot; keep' : (inUnpiv ? ' &middot; unpivot' : '');
    var used = inKeep || inUnpiv;
    return '<button type="button" data-up-pick="' + esc(name) + '" ' +
      'style="display:block;width:100%;text-align:left;min-height:40px;font-size:13px;padding:8px 10px;margin-bottom:4px;border-radius:8px;cursor:pointer;' +
      'background:' + (used ? 'var(--surface,#141518)' : 'var(--surface-2,#1A1C20)') + ';color:var(--text,#E8E8E8);' +
      'border:1px solid var(--border,#2A2C31)">' + esc(name) + '<span style="color:var(--text-muted,#8A8F98);font-size:11px">' + tag + '</span></button>';
  }

  function renderBody() {
    var body = document.getElementById(BODY_ID);
    if (!body) return;
    var eng = engine();

    if (!_config || !_dataset) {
      body.innerHTML = card('<div style="color:var(--text-muted,#8A8F98);font-size:13px">Load a wide "report style" sheet (for example Jan, Feb, Mar columns) and Guided Unpivot will help turn it into tidy long form. Everything stays on this device.</div>');
      return;
    }

    var keep = _config.keepColumns || [];
    var unpiv = _config.unpivotColumns || [];
    var names = _config.allColumns || columnNames(_dataset);

    // Lead with the finding.
    var finding = keep.length + ' id column' + (keep.length === 1 ? '' : 's') + ' stay. ' +
      unpiv.length + ' wide column' + (unpiv.length === 1 ? '' : 's') + ' become rows.';

    // Chip wells.
    var keepChips = keep.length
      ? keep.map(function (n) { return chip(n, 'keep', true); }).join('')
      : '<span style="color:var(--text-muted,#8A8F98);font-size:12px">Click columns below to keep them wide.</span>';
    var unpivChips = unpiv.length
      ? unpiv.map(function (n) { return chip(n, 'unpivot', true); }).join('')
      : '<span style="color:var(--text-muted,#8A8F98);font-size:12px">Click columns below to unpivot them.</span>';

    // Column picker.
    var pickHtml = names.map(function (n) {
      return pickerItem(n, keep.indexOf(n) !== -1, unpiv.indexOf(n) !== -1);
    }).join('');

    // Preview + SQL.
    var previewHtml = '';
    var sqlHtml = '';
    var estimate = 0;
    if (eng) {
      try {
        var prev = eng.preview(_dataset, _config, { maxRows: PREVIEW_ROWS });
        if (prev.ok) {
          estimate = prev.outputRowEstimate;
          previewHtml = renderPreview(prev);
        } else {
          previewHtml = '<div style="color:var(--flag,#F5A623);font-size:12px">' + esc(prev.error || 'Preview unavailable.') + '</div>';
        }
      } catch (_e) {
        previewHtml = '<div style="color:var(--flag,#F5A623);font-size:12px">Preview unavailable.</div>';
      }
      try {
        var s = eng.buildUnpivotSQL(_config, eng.quoteIdent(_config.sourceTable || 'dataset'));
        sqlHtml = s.ok
          ? '<pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-family:var(--mono,\'Geist Mono\',monospace);font-size:11px;color:var(--text-secondary,#B4B8C0)">' + esc(s.sql) + '</pre>'
          : '<div style="color:var(--text-muted,#8A8F98);font-size:12px">Pick columns to see SQL.</div>';
      } catch (_e2) {
        sqlHtml = '<div style="color:var(--text-muted,#8A8F98);font-size:12px">SQL unavailable.</div>';
      }
    }

    var canUndo = !!(_dataset && _dataset._unpivotSnapshot);
    var focusKeep = _focusWell === 'keep';

    body.innerHTML =
      card(
        '<div style="font-size:11px;color:var(--text-muted,#8A8F98);letter-spacing:.04em">FINDING</div>' +
        '<div style="font-size:19px;font-weight:800;margin:2px 0 4px;color:var(--primary,#20C5B5)">' + esc(finding) + '</div>' +
        '<div style="font-size:12px;color:var(--text-secondary,#B4B8C0);line-height:1.5">Estimated ' + esc(estimate) + ' rows after reshape.</div>'
      ) +
      card(
        '<div style="display:flex;gap:8px;margin-bottom:8px">' +
          '<button type="button" data-up-focus="keep" style="flex:1;min-height:36px;border-radius:8px;cursor:pointer;font-weight:700;font-size:12px;' +
            'border:1px solid ' + (focusKeep ? 'var(--proof,#4AE38A)' : 'var(--border,#2A2C31)') + ';' +
            'background:' + (focusKeep ? 'rgba(74,227,138,.14)' : 'transparent') + ';color:var(--text,#E8E8E8)">Keep (' + keep.length + ')</button>' +
          '<button type="button" data-up-focus="unpivot" style="flex:1;min-height:36px;border-radius:8px;cursor:pointer;font-weight:700;font-size:12px;' +
            'border:1px solid ' + (!focusKeep ? 'var(--primary,#20C5B5)' : 'var(--border,#2A2C31)') + ';' +
            'background:' + (!focusKeep ? 'rgba(32,197,181,.14)' : 'transparent') + ';color:var(--text,#E8E8E8)">Unpivot these (' + unpiv.length + ')</button>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-bottom:6px">Keep</div>' +
        '<div style="margin-bottom:10px">' + keepChips + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-bottom:6px">Unpivot these</div>' +
        '<div>' + unpivChips + '</div>'
      ) +
      card(
        '<div style="font-weight:800;margin-bottom:6px;font-size:13px">Columns</div>' +
        '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-bottom:8px">Click a column to add it to the focused well. Click a chip to remove it.</div>' +
        pickHtml
      ) +
      card(
        '<div style="font-weight:800;margin-bottom:8px;font-size:13px">New column names</div>' +
        '<label style="display:block;font-size:11px;color:var(--text-muted,#8A8F98);margin-bottom:4px">Name column</label>' +
        '<input type="text" data-up-name value="' + esc(_config.nameColumn || 'attribute') + '" style="width:100%;min-height:40px;box-sizing:border-box;margin-bottom:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--border,#2A2C31);background:var(--surface,#141518);color:var(--text,#E8E8E8);font-size:13px">' +
        '<label style="display:block;font-size:11px;color:var(--text-muted,#8A8F98);margin-bottom:4px">Value column</label>' +
        '<input type="text" data-up-value value="' + esc(_config.valueColumn || 'value') + '" style="width:100%;min-height:40px;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--border,#2A2C31);background:var(--surface,#141518);color:var(--text,#E8E8E8);font-size:13px">'
      ) +
      card(
        '<div style="font-weight:800;margin-bottom:8px;font-size:13px">Preview (first ' + PREVIEW_ROWS + ' rows)</div>' +
        previewHtml
      ) +
      card(
        '<button type="button" data-up-sqltoggle style="width:100%;text-align:left;background:transparent;border:none;color:var(--text,#E8E8E8);font-weight:800;font-size:13px;cursor:pointer;padding:0">' +
          (_sqlOpen ? '&#9662;' : '&#9656;') + ' DuckDB SQL (glass-box)</button>' +
        '<div style="' + (_sqlOpen ? '' : 'display:none;') + 'margin-top:10px;overflow-x:auto">' + sqlHtml + '</div>'
      ) +
      '<div style="font-size:11px;line-height:1.5;color:var(--text-faint,var(--text-muted,#8A8F98));padding:2px 2px 12px">' +
        'Reshape runs on this device. Preview first; Apply only on your click.' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;padding-bottom:20px">' +
        '<button type="button" data-up-apply style="flex:1;min-height:44px;border:none;border-radius:10px;background:var(--primary,#20C5B5);color:#04201C;font-weight:800;font-size:14px;cursor:pointer">Apply</button>' +
        '<button type="button" data-up-suggest style="min-height:44px;border:1px solid var(--border,#2A2C31);border-radius:10px;background:transparent;color:var(--text,#E8E8E8);font-weight:600;font-size:13px;padding:0 14px;cursor:pointer">Suggest</button>' +
        '<button type="button" data-up-preview style="min-height:44px;border:1px solid var(--border,#2A2C31);border-radius:10px;background:transparent;color:var(--text,#E8E8E8);font-weight:600;font-size:13px;padding:0 14px;cursor:pointer">Preview</button>' +
        (canUndo ? '<button type="button" data-up-undo style="min-height:44px;border:1px solid var(--border,#2A2C31);border-radius:10px;background:transparent;color:var(--text,#E8E8E8);font-weight:600;font-size:13px;padding:0 14px;cursor:pointer">Undo</button>' : '') +
      '</div>';

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
    var rows = prev.rows.map(function (r) {
      var tds = prev.columns.map(function (_c, i) {
        var v = r[i];
        return '<td style="padding:5px 8px;border-bottom:1px solid var(--border,#22242A);white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis">' +
          esc(v == null ? '' : v) + '</td>';
      }).join('');
      return '<tr>' + tds + '</tr>';
    }).join('');
    return '<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:12px;width:100%;font-family:var(--mono,\'Geist Mono\',monospace)">' +
      '<thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:6px">' + esc(prev.totalRows) + ' rows long form</div>';
  }

  function toggleInWell(list, name) {
    var i = list.indexOf(name);
    if (i === -1) list.push(name);
    else list.splice(i, 1);
    return list;
  }

  function wireBody(body) {
    var focusBtns = body.querySelectorAll('[data-up-focus]');
    for (var f = 0; f < focusBtns.length; f++) {
      focusBtns[f].addEventListener('click', function (e) {
        _focusWell = e.currentTarget.getAttribute('data-up-focus');
        renderBody();
      });
    }

    var picks = body.querySelectorAll('[data-up-pick]');
    for (var p = 0; p < picks.length; p++) {
      picks[p].addEventListener('click', function (e) {
        var name = e.currentTarget.getAttribute('data-up-pick');
        // Remove from both wells first so a column lives in exactly one well.
        var other = _focusWell === 'keep' ? _config.unpivotColumns : _config.keepColumns;
        var oi = other.indexOf(name);
        if (oi !== -1) other.splice(oi, 1);
        var target = _focusWell === 'keep' ? _config.keepColumns : _config.unpivotColumns;
        toggleInWell(target, name);
        renderBody();
      });
    }

    var chips = body.querySelectorAll('[data-up-chip]');
    for (var c = 0; c < chips.length; c++) {
      chips[c].addEventListener('click', function (e) {
        var name = e.currentTarget.getAttribute('data-up-chip');
        var well = e.currentTarget.getAttribute('data-up-well');
        var list = well === 'keep' ? _config.keepColumns : _config.unpivotColumns;
        var i = list.indexOf(name);
        if (i !== -1) list.splice(i, 1);
        renderBody();
      });
    }

    var nameInput = body.querySelector('[data-up-name]');
    if (nameInput) nameInput.addEventListener('input', function (e) { _config.nameColumn = e.target.value; });
    var valInput = body.querySelector('[data-up-value]');
    if (valInput) valInput.addEventListener('input', function (e) { _config.valueColumn = e.target.value; });

    var sqlToggle = body.querySelector('[data-up-sqltoggle]');
    if (sqlToggle) sqlToggle.onclick = function () { _sqlOpen = !_sqlOpen; renderBody(); };

    var suggestBtn = body.querySelector('[data-up-suggest]');
    if (suggestBtn) suggestBtn.onclick = function () {
      var ds = activeDataset();
      if (!ds) { toast('Load data first', 'warn'); return; }
      ensureConfig(ds);
      renderBody();
      toast('Suggested keep and unpivot columns');
    };

    var previewBtn = body.querySelector('[data-up-preview]');
    if (previewBtn) previewBtn.onclick = function () { renderBody(); };

    var applyBtn = body.querySelector('[data-up-apply]');
    if (applyBtn) applyBtn.onclick = doApply;

    var undoBtn = body.querySelector('[data-up-undo]');
    if (undoBtn) undoBtn.onclick = doUndo;
  }

  function snapshot(ds) {
    return {
      columns: JSON.parse(JSON.stringify(ds.columns || [])),
      rows: JSON.parse(JSON.stringify(ds.rows || [])),
    };
  }

  // Apply is click-only. Primary path: pure in-memory transform, replace the
  // active dataset in place, and keep a pre-image snapshot so Undo is fully
  // reversible (mirrors Excel Hell). No data leaves the device.
  function doApply() {
    var eng = engine();
    var ds = activeDataset();
    if (!eng || !ds) { toast('Load data first', 'warn'); return; }
    var v = eng.validateConfig(_config, columnNames(ds));
    if (!v.ok) { toast(v.errors[0] || 'Fix the configuration first', 'warn'); return; }

    var out = eng.unpivotTransform(ds, _config);
    if (!out.ok) { toast(out.error || 'Reshape failed', 'error'); return; }

    try { ds._unpivotSnapshot = snapshot(ds); } catch (_e) {}
    ds.columns = out.columns;
    ds.rows = out.rows;
    _applied = true;

    try {
      if (window.ProvenanceFabric && typeof window.ProvenanceFabric.append === 'function') {
        window.ProvenanceFabric.append('guided_unpivot', {
          keep: (_config.keepColumns || []).length,
          unpivot: (_config.unpivotColumns || []).length,
          rows: out.rows.length,
        });
      }
    } catch (_e2) {}

    updateBadge();
    notifyDatasetChanged(ds);
    renderBody();
    toast('Reshaped to long form: ' + out.rows.length + ' rows');
  }

  function doUndo() {
    var ds = activeDataset();
    if (!ds || !ds._unpivotSnapshot) { toast('Nothing to undo', 'warn'); return; }
    ds.columns = ds._unpivotSnapshot.columns;
    ds.rows = ds._unpivotSnapshot.rows;
    delete ds._unpivotSnapshot;
    _applied = false;
    ensureConfig(ds);
    updateBadge();
    notifyDatasetChanged(ds);
    renderBody();
    toast('Reshape undone');
  }

  function notifyDatasetChanged(ds) {
    try {
      document.dispatchEvent(new CustomEvent('dataglow:dataset-updated', { detail: { dataset: ds, source: 'guided-unpivot' } }));
    } catch (_e) {}
    try {
      if (typeof window.renderGrid === 'function') window.renderGrid(ds);
      else if (typeof window.refreshGrid === 'function') window.refreshGrid();
    } catch (_e2) {}
  }

  function openPanel() {
    if (!flagOn()) return;
    var panel = ensurePanel();
    if (!_config) {
      var ds = activeDataset();
      if (ds) { ensureConfig(ds); updateBadge(); }
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
    btn.setAttribute('aria-label', 'Open Guided Unpivot');
    btn.title = 'Guided Unpivot - reshape wide sheets to long form on device';
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:7px', 'min-height:38px',
      'padding:0 13px', 'border:1px solid var(--border,#2A2C31)', 'border-radius:10px',
      'background:var(--surface-2,#1A1C20)', 'color:var(--text,#E8E8E8)',
      'font-size:13px', 'font-weight:600', 'cursor:pointer'
    ].join(';');
    btn.innerHTML = '<span class="dg-up-dot" aria-hidden="true" style="width:8px;height:8px;border-radius:50%;background:var(--primary,#20C5B5);display:inline-block"></span><span>Unpivot</span>';
    btn.addEventListener('click', function () {
      var panel = document.getElementById(PANEL_ID);
      if (panel && panel.style.transform === 'translateX(0px)') closePanel();
      else openPanel();
    });
    if (toolbar === document.body) {
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '160px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  function onDataset(ds) {
    if (!flagOn() || !ds) return;
    ensureConfig(ds);
    updateBadge();
  }

  function boot() {
    if (!flagOn()) return; // flag off: no pill, no panel, no dead clicks
    injectButton();
    ensurePanel();
    updateBadge();

    document.addEventListener('dataglow:dataset-loaded', function (e) {
      var ds = e && e.detail && e.detail.dataset;
      onDataset(ds || activeDataset());
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
    });

    window.DataGlowGuidedUnpivotUI = {
      version: 1,
      openPanel: openPanel,
      closePanel: closePanel,
      getConfig: function () { return _config; },
      suggest: function () { var ds = activeDataset(); return ds ? ensureConfig(ds) : null; },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 700); });
  } else {
    setTimeout(boot, 700);
  }
})();
/* ---- end js/intelligence/data-glow-guided-unpivot-canvas.js ---- */
