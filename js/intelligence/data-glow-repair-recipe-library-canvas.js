/* ---- from js/intelligence/data-glow-repair-recipe-library-canvas.js ---- */
;(function () {
  'use strict';

  var PANEL_ID = 'dg-recipe-library-panel';
  var PREVIEW_ROWS = 12;

  // Pending save context handed in from Excel Hell / Unpivot before the dialog
  // opens: { kind, dataset, payload }.
  var _pending = null;
  var _store = null;

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
    console.info('[Repair Recipe Library]', msg);
  }

  function flagOn() {
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('repairRecipeLibrary') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function lib() { return window.DataGlowRepairRecipeLibrary || null; }

  function store() {
    if (_store) return _store;
    try {
      if (window.DataGlowRepairRecipeStore &&
          typeof window.DataGlowRepairRecipeStore.createRepairRecipeStore === 'function') {
        _store = window.DataGlowRepairRecipeStore.createRepairRecipeStore();
      }
    } catch (_e) {}
    return _store;
  }

  function activeDataset(pref) {
    if (pref) return pref;
    if (typeof window.getActiveDataset === 'function') {
      try { var d = window.getActiveDataset(); if (d) return d; } catch (_e) {}
    }
    if (window.state && window.state.datasets && window.state.datasets[0]) {
      return window.state.datasets[0];
    }
    return null;
  }

  function columnNamesOf(ds) {
    var l = lib();
    if (l && typeof l.normalizeColumnNames === 'function') return l.normalizeColumnNames(ds);
    var cols = (ds && ds.columns) || [];
    return cols.map(function (c, i) { return typeof c === 'string' ? c : (c.name || ('col' + (i + 1))); });
  }

  function datasetLabel(ds) {
    return (ds && (ds.name || ds.label || ds.fileName)) || 'dataset';
  }

  function shortDate(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_e) { return String(iso || ''); }
  }

  function kindLabel(kind) {
    return kind === 'guidedUnpivot' ? 'Unpivot' : 'Excel Hell';
  }

  /* ------------------------------- panel ---------------------------------- */

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Repair Recipe Library');
    panel.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'height:100%', 'width:min(460px,100%)',
      'background:var(--surface,#141518)', 'color:var(--text,#E8E8E8)',
      'border-left:1px solid var(--border,#2A2C31)', 'box-shadow:-8px 0 32px rgba(0,0,0,.4)',
      'transform:translateX(105%)', 'transition:transform .22s ease', 'z-index:11850',
      'display:flex', 'flex-direction:column'
    ].join(';');
    panel.innerHTML =
      '<div style="width:36px;height:4px;border-radius:2px;background:var(--border,#2A2C31);margin:10px auto 0;flex-shrink:0"></div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid var(--border,#2A2C31);gap:10px">' +
        '<div style="min-width:0">' +
          '<div style="font-weight:800;font-size:15px">Recipe Library</div>' +
          '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:2px">On-device - metadata only, no rows stored</div>' +
        '</div>' +
        '<button type="button" data-rl-close style="min-height:44px;min-width:44px;border:none;background:transparent;color:var(--text-muted,#8A8F98);font-size:22px;cursor:pointer;border-radius:10px" aria-label="Close">×</button>' +
      '</div>' +
      '<div id="dg-recipe-library-body" style="flex:1;overflow-y:auto;padding:14px 16px;-webkit-overflow-scrolling:touch"></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-rl-close]').addEventListener('click', closePanel);
    return panel;
  }

  function card(inner) {
    return '<div style="border:1px solid var(--border,#2A2C31);border-radius:12px;padding:12px 14px;margin-bottom:12px;background:var(--surface-2,#1A1C20)">' + inner + '</div>';
  }

  function openPanel() {
    if (!flagOn()) return;
    ensurePanel().style.transform = 'translateX(0)';
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.transform = 'translateX(105%)';
  }

  /* ------------------------------ library list ---------------------------- */

  function openLibrary(dsPref) {
    if (!flagOn()) return;
    ensurePanel();
    openPanel();
    renderLibrary(activeDataset(dsPref));
  }

  function renderLibrary(ds) {
    var body = document.getElementById('dg-recipe-library-body');
    if (!body) return;
    var st = store();
    var l = lib();
    if (!st || !l) {
      body.innerHTML = card('<div style="color:var(--flag,#F5A623);font-size:13px">Library engine unavailable.</div>');
      return;
    }
    body.innerHTML = card('<div style="color:var(--text-muted,#8A8F98);font-size:13px">Loading recipes...</div>');
    st.listRecipes().then(function (records) {
      var sorted = l.sortRecipes(records, 'updatedAt');
      renderLibraryList(body, sorted, ds);
    }).catch(function () {
      body.innerHTML = card('<div style="color:var(--flag,#F5A623);font-size:13px">Could not read the library.</div>');
    });
  }

  function renderLibraryList(body, records, ds) {
    var l = lib();
    var cols = columnNamesOf(ds);

    if (!records.length) {
      body.innerHTML = card(
        '<div style="font-weight:800;font-size:13px;margin-bottom:4px">No saved recipes yet</div>' +
        '<div style="color:var(--text-muted,#8A8F98);font-size:12px;line-height:1.5">Repair a messy file with Excel Hell, then use <b>Save recipe</b> to keep the steps here for the next file of the same shape. Recipes stay on this device and never include your rows.</div>'
      );
      return;
    }

    var cardsHtml = records.map(function (r) {
      var match = l.scoreRecipeMatch(r, cols);
      var scoreColor = match.score >= 80 ? 'var(--proof,#4AE38A)'
        : (match.score >= 50 ? 'var(--primary,#20C5B5)' : 'var(--flag,#F5A623)');
      var warnHtml = match.warning
        ? '<div style="font-size:11px;color:var(--flag,#F5A623);margin-top:6px;line-height:1.4">' + esc(match.warning) + '</div>'
        : '';
      return '<div data-rl-card="' + esc(r.id) + '" style="border:1px solid var(--border,#2A2C31);border-radius:12px;padding:12px 14px;margin-bottom:12px;background:var(--surface-2,#1A1C20)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
          '<div style="font-weight:800;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.name) + '</div>' +
          '<span style="flex-shrink:0;font-size:10px;padding:3px 8px;border-radius:999px;background:rgba(32,197,181,.12);color:var(--primary,#20C5B5);border:1px solid rgba(32,197,181,.3)">' + esc(kindLabel(r.kind)) + '</span>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:4px">' +
          (r.sourceName ? esc(r.sourceName) + ' - ' : '') + esc(shortDate(r.updatedAt)) +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;margin-top:8px">' +
          '<span style="font-size:11px;color:var(--text-muted,#8A8F98)">Match</span>' +
          '<span style="font-weight:800;font-size:13px;color:' + scoreColor + '">' + match.score + '%</span>' +
        '</div>' +
        warnHtml +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
          '<button type="button" data-rl-preview="' + esc(r.id) + '" style="flex:1;min-height:40px;border:1px solid var(--border,#2A2C31);border-radius:10px;background:transparent;color:var(--text,#E8E8E8);font-weight:600;font-size:13px;cursor:pointer">Preview</button>' +
          '<button type="button" data-rl-delete="' + esc(r.id) + '" style="min-height:40px;border:1px solid var(--border,#2A2C31);border-radius:10px;background:transparent;color:var(--text-muted,#8A8F98);font-weight:600;font-size:13px;padding:0 12px;cursor:pointer" aria-label="Delete recipe">Delete</button>' +
        '</div>' +
        '<div data-rl-detail="' + esc(r.id) + '"></div>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-bottom:10px;line-height:1.5">' +
        esc(records.length) + ' saved recipe' + (records.length > 1 ? 's' : '') +
        '. Match score compares each recipe to <b>' + esc(datasetLabel(ds)) + '</b> (' + cols.length + ' columns).' +
      '</div>' + cardsHtml;

    wireLibrary(body, records, ds);
  }

  function wireLibrary(body, records, ds) {
    var byId = {};
    records.forEach(function (r) { byId[r.id] = r; });

    var prev = body.querySelectorAll('[data-rl-preview]');
    for (var i = 0; i < prev.length; i++) {
      prev[i].addEventListener('click', function (e) {
        var id = e.currentTarget.getAttribute('data-rl-preview');
        showPreview(byId[id], ds, body);
      });
    }
    var del = body.querySelectorAll('[data-rl-delete]');
    for (var j = 0; j < del.length; j++) {
      del[j].addEventListener('click', function (e) {
        var id = e.currentTarget.getAttribute('data-rl-delete');
        doDelete(byId[id], ds);
      });
    }
  }

  /* ------------------------------ preview + apply ------------------------- */

  function computePreview(record, ds) {
    var l = lib();
    var ap = l.getApplyPayload(record);
    if (!ap.ok) return { ok: false, error: ap.error };
    try {
      if (ap.kind === 'excelHell') {
        var eh = window.DataGlowExcelHellRepair;
        if (!eh) return { ok: false, error: 'Excel Hell engine not loaded.' };
        var p = eh.preview(ds, ap.payload, { limit: PREVIEW_ROWS });
        return { ok: true, columns: p.columns, rows: p.rows, totalRows: p.totalRows };
      }
      if (ap.kind === 'guidedUnpivot') {
        var up = window.DataGlowGuidedUnpivot;
        if (!up) return { ok: false, error: 'Unpivot engine not loaded.' };
        var pr = up.preview(ds, ap.payload, { maxRows: PREVIEW_ROWS });
        if (!pr.ok) return { ok: false, error: pr.error };
        return { ok: true, columns: pr.columns, rows: pr.rows, totalRows: pr.totalRows };
      }
    } catch (e) {
      return { ok: false, error: 'Preview failed: ' + e.message };
    }
    return { ok: false, error: 'Unknown recipe kind.' };
  }

  function showPreview(record, ds, body) {
    if (!record) return;
    ds = activeDataset(ds);
    var host = body.querySelector('[data-rl-detail="' + cssEscape(record.id) + '"]');
    if (!host) return;
    if (!ds) { host.innerHTML = detailNote('Load a dataset first.'); return; }

    var l = lib();
    var match = l.scoreRecipeMatch(record, columnNamesOf(ds));
    var prev = computePreview(record, ds);

    if (!prev.ok) {
      host.innerHTML = detailNote(prev.error || 'Preview unavailable.');
      return;
    }

    var canApply = match.canApply && prev.columns && prev.columns.length > 0;
    host.innerHTML =
      '<div style="margin-top:10px;border-top:1px solid var(--border,#22242A);padding-top:10px">' +
        (match.warning ? '<div style="font-size:11px;color:var(--flag,#F5A623);margin-bottom:8px;line-height:1.4">' + esc(match.warning) + '</div>' : '') +
        '<div style="font-weight:700;font-size:12px;margin-bottom:6px">Preview (first ' + PREVIEW_ROWS + ' rows)</div>' +
        renderPreviewTable(prev) +
        '<div style="display:flex;gap:8px;margin-top:10px">' +
          '<button type="button" data-rl-apply="' + esc(record.id) + '"' + (canApply ? '' : ' disabled') +
            ' style="flex:1;min-height:44px;border:none;border-radius:10px;background:' +
            (canApply ? 'var(--primary,#20C5B5)' : 'var(--border,#2A2C31)') +
            ';color:' + (canApply ? '#04201C' : 'var(--text-muted,#8A8F98)') +
            ';font-weight:800;font-size:14px;cursor:' + (canApply ? 'pointer' : 'not-allowed') + '">Apply to this dataset</button>' +
        '</div>' +
        (canApply ? '' : '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:6px">Too few matching columns to apply safely.</div>') +
      '</div>';

    var applyBtn = host.querySelector('[data-rl-apply]');
    if (applyBtn && canApply) {
      applyBtn.addEventListener('click', function () { doApply(record, ds); });
    }
  }

  function detailNote(msg) {
    return '<div style="margin-top:10px;border-top:1px solid var(--border,#22242A);padding-top:10px;font-size:12px;color:var(--flag,#F5A623)">' + esc(msg) + '</div>';
  }

  function renderPreviewTable(prev) {
    if (!prev.columns || !prev.columns.length) {
      return '<div style="color:var(--text-muted,#8A8F98);font-size:12px">Nothing to preview.</div>';
    }
    var head = prev.columns.map(function (c) {
      return '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border,#2A2C31);white-space:nowrap">' +
        esc(c.name) + '<span style="display:block;font-size:9px;color:var(--text-muted,#8A8F98);font-weight:400">' + esc(c.type) + '</span></th>';
    }).join('');
    var rows = (prev.rows || []).map(function (r) {
      var tds = prev.columns.map(function (_c, i) {
        return '<td style="padding:5px 8px;border-bottom:1px solid var(--border,#22242A);white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis">' +
          esc(r[i] == null ? '' : r[i]) + '</td>';
      }).join('');
      return '<tr>' + tds + '</tr>';
    }).join('');
    return '<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:12px;width:100%;font-family:var(--mono,\'Geist Mono\',monospace)">' +
      '<thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (prev.totalRows != null ? '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:6px">' + esc(prev.totalRows) + ' rows after apply</div>' : '');
  }

  // Apply is click-only. Delegates to the same engine paths Excel Hell / Unpivot
  // use, keeping a pre-image snapshot so the existing Undo affordances work.
  function doApply(record, ds) {
    ds = activeDataset(ds);
    if (!ds) { toast('Load a dataset first', 'warn'); return; }
    var l = lib();
    var ap = l.getApplyPayload(record);
    if (!ap.ok) { toast(ap.error || 'Cannot apply', 'error'); return; }

    try {
      if (ap.kind === 'excelHell') {
        var eh = window.DataGlowExcelHellRepair;
        if (!eh) { toast('Excel Hell engine not loaded', 'error'); return; }
        eh.apply(ds, ap.payload);
      } else if (ap.kind === 'guidedUnpivot') {
        var up = window.DataGlowGuidedUnpivot;
        if (!up) { toast('Unpivot engine not loaded', 'error'); return; }
        var out = up.unpivotTransform(ds, ap.payload);
        if (!out.ok) { toast(out.error || 'Reshape failed', 'error'); return; }
        try {
          ds._unpivotSnapshot = {
            columns: JSON.parse(JSON.stringify(ds.columns || [])),
            rows: JSON.parse(JSON.stringify(ds.rows || [])),
          };
        } catch (_e) {}
        ds.columns = out.columns;
        ds.rows = out.rows;
      } else {
        toast('Unknown recipe kind', 'error');
        return;
      }
    } catch (e) {
      console.warn('[Repair Recipe Library] apply failed', e);
      toast('Apply failed', 'error');
      return;
    }

    notifyDatasetChanged(ds, record.kind);
    toast('Recipe "' + record.name + '" applied');
    closePanel();
  }

  function notifyDatasetChanged(ds, kind) {
    try {
      document.dispatchEvent(new CustomEvent('dataglow:dataset-updated', { detail: { dataset: ds, source: 'repair-recipe-library:' + kind } }));
    } catch (_e) {}
    try {
      if (typeof window.renderGrid === 'function') window.renderGrid(ds);
      else if (typeof window.refreshGrid === 'function') window.refreshGrid();
    } catch (_e2) {}
    try {
      if (window.ProvenanceFabric && typeof window.ProvenanceFabric.append === 'function') {
        window.ProvenanceFabric.append('repair_recipe_reapply', { kind: kind });
      }
    } catch (_e3) {}
  }

  function doDelete(record, ds) {
    if (!record) return;
    var st = store();
    if (!st) return;
    st.deleteRecipe(record.id).then(function () {
      toast('Recipe deleted');
      renderLibrary(activeDataset(ds));
    }).catch(function () { toast('Delete failed', 'error'); });
  }

  /* ------------------------------ save dialog ----------------------------- */

  // context: { kind, dataset, payload }
  function openSaveDialog(context) {
    if (!flagOn()) return;
    var l = lib();
    if (!l) { toast('Library engine unavailable', 'warn'); return; }
    context = context || {};
    var ds = activeDataset(context.dataset);
    if (!context.payload) { toast('Nothing to save yet', 'warn'); return; }
    _pending = { kind: context.kind || 'excelHell', dataset: ds, payload: context.payload };

    ensurePanel();
    openPanel();
    renderSaveDialog();
  }

  function defaultName(ds, kind) {
    var d = new Date();
    var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    return datasetLabel(ds) + ' ' + kindLabel(kind) + ' ' + stamp;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function renderSaveDialog() {
    var body = document.getElementById('dg-recipe-library-body');
    if (!body || !_pending) return;
    var ds = _pending.dataset;
    var cols = columnNamesOf(ds);
    var name = defaultName(ds, _pending.kind);

    body.innerHTML =
      card(
        '<div style="font-weight:800;font-size:14px;margin-bottom:2px">Save recipe</div>' +
        '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-bottom:10px;line-height:1.5">Saves the ' + esc(kindLabel(_pending.kind)) + ' steps and the ' + cols.length + ' column name' + (cols.length === 1 ? '' : 's') + ' seen now. Your rows are never stored.</div>' +
        '<label style="display:block;font-size:11px;color:var(--text-muted,#8A8F98);margin-bottom:4px">Recipe name</label>' +
        '<input type="text" data-rl-name value="' + esc(name) + '" style="width:100%;box-sizing:border-box;min-height:44px;padding:8px 10px;border-radius:8px;border:1px solid var(--border,#2A2C31);background:var(--surface,#141518);color:var(--text,#E8E8E8);font-size:13px;margin-bottom:12px">' +
        '<label style="display:block;font-size:11px;color:var(--text-muted,#8A8F98);margin-bottom:4px">Notes (optional)</label>' +
        '<input type="text" data-rl-notes value="" placeholder="e.g. monthly claims export" style="width:100%;box-sizing:border-box;min-height:44px;padding:8px 10px;border-radius:8px;border:1px solid var(--border,#2A2C31);background:var(--surface,#141518);color:var(--text,#E8E8E8);font-size:13px;margin-bottom:14px">' +
        '<div style="display:flex;gap:8px">' +
          '<button type="button" data-rl-save style="flex:1;min-height:44px;border:none;border-radius:10px;background:var(--primary,#20C5B5);color:#04201C;font-weight:800;font-size:14px;cursor:pointer">Save to library</button>' +
          '<button type="button" data-rl-tolist style="min-height:44px;border:1px solid var(--border,#2A2C31);border-radius:10px;background:transparent;color:var(--text,#E8E8E8);font-weight:600;font-size:13px;padding:0 14px;cursor:pointer">Library</button>' +
        '</div>'
      );

    body.querySelector('[data-rl-save]').addEventListener('click', doSave);
    body.querySelector('[data-rl-tolist]').addEventListener('click', function () {
      openLibrary(_pending && _pending.dataset);
    });
  }

  function doSave() {
    var body = document.getElementById('dg-recipe-library-body');
    if (!body || !_pending) return;
    var l = lib();
    var st = store();
    if (!l || !st) { toast('Library unavailable', 'error'); return; }

    var nameInput = body.querySelector('[data-rl-name]');
    var notesInput = body.querySelector('[data-rl-notes]');
    var ds = _pending.dataset;

    var record = l.createRecipeRecord({
      name: nameInput ? nameInput.value : '',
      kind: _pending.kind,
      payload: _pending.payload,
      columnNames: columnNamesOf(ds),
      sourceName: datasetLabel(ds),
      fingerprint: (_pending.payload && _pending.payload.sourceFingerprint) || undefined,
      notes: notesInput ? notesInput.value : '',
    });

    var v = l.validateRecord(record);
    if (!v.ok) { toast(v.errors[0] || 'Recipe is not valid', 'error'); return; }

    st.putRecipe(record).then(function () {
      toast('Saved "' + record.name + '" to library');
      _pending = null;
      renderLibrary(activeDataset(ds));
    }).catch(function () { toast('Could not save recipe', 'error'); });
  }

  /* ------------------------------ misc ------------------------------------ */

  // Minimal CSS attribute-selector escape for ids we generate (which are safe,
  // but be defensive).
  function cssEscape(s) {
    return String(s).replace(/["\\\]]/g, '\\$&');
  }

  function boot() {
    if (!flagOn()) return;
    ensurePanel();
    window.DataGlowRepairRecipeLibraryUI = {
      version: 1,
      openLibrary: openLibrary,
      openSaveDialog: openSaveDialog,
      closePanel: closePanel,
    };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 680); });
  } else {
    setTimeout(boot, 680);
  }
})();
/* ---- end js/intelligence/data-glow-repair-recipe-library-canvas.js ---- */
