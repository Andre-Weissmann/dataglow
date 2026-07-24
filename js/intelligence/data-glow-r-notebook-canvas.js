/* ---- from js/intelligence/data-glow-r-notebook-canvas.js ---- */
;(function () {
  'use strict';

  /* R Notebooks-lite (any industry): upgrades the single-cell R console into a
     multi-cell on-device WebR notebook when the rNotebooksLite flag is on.
     One WebR kernel is shared by every cell (window.DataGlowR), so cell N sees
     the objects earlier cells created. Flag off leaves the single R console
     untouched, and the modular js/runtimes-viz/r-runtime.js path is not
     involved at all. Rows never leave the device: only the WebR runtime itself
     is fetched, from the official CDN. */

  var HOST_ID = 'r-notebook-host';
  var TOOLBAR_ID = 'r-notebook-toolbar';
  var STYLE_ID = 'r-notebook-styles';
  var WEBR_CDN = 'https://webr.r-wasm.org/v0.6.0/webr.mjs';
  var ROW_LIMIT = 200000;

  var _nb = null;
  var _focusedCellId = null;
  var _wired = false;
  var _industry = 'all';

  function engine() { return window.DataGlowRNotebookLite || null; }

  function flagOn() {
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('rNotebooksLite') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, kind || 'info'); return; } catch (_e) {}
    }
    console.info('[R Notebook]', msg);
  }

  function esc(s) {
    var eng = engine();
    if (eng && typeof eng.escapeHtml === 'function') return eng.escapeHtml(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ------------------------- shared WebR kernel --------------------------- */

  var _webR = null;
  var _initPromise = null;
  var _hasJsonlite = null;
  var _graphicsAvailable = null;
  var _boundFingerprint = '';
  var _rowCapNotices = [];
  var _kernelStatus = 'idle';

  function setKernelStatus(text) {
    _kernelStatus = text;
    var el = document.getElementById('r-nb-kernel-status');
    if (el) el.textContent = text;
    var legacy = document.getElementById('r-load-status');
    if (legacy) legacy.textContent = text;
  }

  function activeDatasets() {
    var out = [];
    try {
      if (typeof window.getAllDatasets === 'function') {
        var all = window.getAllDatasets() || [];
        all.forEach(function (d) { if (d && d.columns && d.rows) out.push(d); });
      }
      if (!out.length && typeof window.getActiveDataset === 'function') {
        var ds = window.getActiveDataset();
        if (ds && ds.columns && ds.rows) out.push(ds);
      }
    } catch (_e) {}
    return out;
  }

  function tableNameFor(ds, index) {
    var raw = ds && (ds.table || ds.name) ? String(ds.table || ds.name) : ('dataset_' + (index + 1));
    var safe = raw.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9_]/g, '_');
    if (!/^[A-Za-z]/.test(safe)) safe = 't_' + safe;
    return safe;
  }

  /* Rows are arrays in the canvas dataset model; R reads them as an array of
     flat objects, capped at ROW_LIMIT with a visible notice. */
  function rowsAsObjects(ds) {
    var cols = (ds.columns || []).map(function (c) { return c && c.name != null ? String(c.name) : ''; });
    var rows = ds.rows || [];
    var limited = rows.length > ROW_LIMIT ? rows.slice(0, ROW_LIMIT) : rows;
    return limited.map(function (r) {
      var o = {};
      for (var i = 0; i < cols.length; i++) {
        var v = Array.isArray(r) ? r[i] : (r ? r[cols[i]] : null);
        o[cols[i]] = v === undefined || v === '' ? null : v;
      }
      return o;
    });
  }

  function datasetMeta(list) {
    return list.map(function (ds, i) {
      return {
        table: tableNameFor(ds, i),
        rows: Math.min((ds.rows || []).length, ROW_LIMIT),
        columns: (ds.columns || []).map(function (c) { return c && c.name; })
      };
    });
  }

  function fingerprint(list) {
    return list.map(function (ds, i) {
      return tableNameFor(ds, i) + ':' + (ds.rows || []).length + ':' + (ds.columns || []).length;
    }).join('|');
  }

  function bindDatasets() {
    var eng = engine();
    var list = activeDatasets();
    var fp = fingerprint(list);
    if (fp === _boundFingerprint && fp !== '') return Promise.resolve();
    _rowCapNotices = [];
    var chain = Promise.resolve();
    list.forEach(function (ds, i) {
      var name = tableNameFor(ds, i);
      var total = (ds.rows || []).length;
      if (eng && typeof eng.buildRowCapNotice === 'function') {
        var note = eng.buildRowCapNotice(total, ROW_LIMIT);
        if (note) _rowCapNotices.push(name + ': ' + note);
      }
      chain = chain.then(function () {
        return _webR.objs.globalEnv.bind('.dataglow_json_' + name, JSON.stringify(rowsAsObjects(ds)));
      });
    });
    return chain.then(function () {
      var prelude = eng && typeof eng.buildRBridgePrelude === 'function'
        ? eng.buildRBridgePrelude(datasetMeta(list), { hasJsonlite: _hasJsonlite !== false })
        : '';
      var setup = prelude + '\ntry(df <- dataglow_get_df(), silent = TRUE)\n';
      return _webR.evalRVoid(setup);
    }).then(function () {
      _boundFingerprint = fp;
    });
  }

  function initKernel() {
    if (_initPromise) return _initPromise;
    _initPromise = (function () {
      setKernelStatus('Downloading R runtime...');
      return import(WEBR_CDN).then(function (mod) {
        setKernelStatus('Starting R...');
        var webR = new mod.WebR();
        return webR.init().then(function () { return webR; });
      }).then(function (webR) {
        _webR = webR;
        setKernelStatus('Installing packages...');
        // jsonlite powers the dataset bridge; ggplot2 is a nicety. Both are
        // best-effort: WebR ships base R only, and a failed install must
        // degrade honestly rather than break the notebook.
        return webR.installPackages(['jsonlite']).then(function () {
          _hasJsonlite = true;
        }).catch(function (e) {
          console.warn('[R Notebook] jsonlite unavailable, using base-R bridge:', e);
          _hasJsonlite = false;
        }).then(function () {
          return webR.installPackages(['ggplot2']).then(function () {
            _graphicsAvailable = true;
          }).catch(function (e) {
            console.warn('[R Notebook] ggplot2 unavailable, base R plotting still works:', e);
            _graphicsAvailable = false;
          });
        });
      }).then(function () {
        setKernelStatus('Loading your tables...');
        return bindDatasets();
      }).then(function () {
        setKernelStatus('R ready');
        return _webR;
      }).catch(function (e) {
        setKernelStatus('R runtime unavailable');
        _initPromise = null;
        throw e;
      });
    })();
    return _initPromise;
  }

  function bitmapsToDataUrls(images) {
    var urls = [];
    (images || []).forEach(function (bmp) {
      try {
        var cv = document.createElement('canvas');
        cv.width = bmp.width;
        cv.height = bmp.height;
        cv.getContext('2d').drawImage(bmp, 0, 0);
        urls.push(cv.toDataURL('image/png'));
        if (typeof bmp.close === 'function') bmp.close();
      } catch (_e) { /* skip a bitmap we could not rasterize */ }
    });
    return urls;
  }

  function notices() {
    var eng = engine();
    if (!eng || typeof eng.buildRBridgeNotices !== 'function') return [];
    return eng.buildRBridgeNotices({
      hasJsonlite: _hasJsonlite,
      graphicsAvailable: _graphicsAvailable,
      rowCapNotices: _rowCapNotices
    });
  }

  function runR(code) {
    return initKernel().then(function () {
      if (window.SecurityAdvisor) {
        var scan = window.SecurityAdvisor.scan(code, 'r');
        if (scan && scan.ok === false) {
          (scan.blocked || []).forEach(function (f) {
            toast('[' + f.id + '] BLOCKED: ' + f.message, 'error');
          });
          return {
            status: 'blocked', stdout: '', error: 'Blocked by SecurityAdvisor - see Sentinel panel.',
            images: [], notices: notices(), elapsedMs: 0
          };
        }
        ((scan && scan.warned) || []).forEach(function (f) {
          toast('[' + f.id + '] Warning: ' + f.message, 'warn');
        });
      }
      return bindDatasets().then(function () {
        var t0 = Date.now();
        return new _webR.Shelter().then(function (shelter) {
          return shelter.captureR(code, {
            withAutoprint: true,
            captureStreams: true,
            captureConditions: true,
            captureGraphics: true
          }).then(function (result) {
            var stdout = (result.output || [])
              .filter(function (o) { return o.type === 'stdout' || o.type === 'stderr'; })
              .map(function (o) { return o.data; })
              .join('\n');
            var images = bitmapsToDataUrls(result.images);
            return shelter.purge().then(function () {
              logProvenance(code, Date.now() - t0);
              return {
                status: 'ok', stdout: stdout, error: null, images: images,
                notices: notices(), elapsedMs: Date.now() - t0
              };
            });
          }).catch(function (err) {
            return shelter.purge().catch(function () {}).then(function () {
              return {
                status: 'error', stdout: '', error: explainRError(err),
                images: [], notices: notices(), elapsedMs: Date.now() - t0
              };
            });
          });
        });
      });
    }).catch(function (e) {
      return {
        status: 'error', stdout: '', error: explainRError(e),
        images: [], notices: notices(), elapsedMs: 0
      };
    });
  }

  function explainRError(err) {
    var msg = (err && err.message) || String(err);
    if (/object .* not found/.test(msg)) {
      return msg + '\nCheck the spelling matches your column names exactly.';
    }
    if (msg.indexOf('subscript out of bounds') !== -1) {
      return msg + '\nYour table may have fewer columns than the code expects.';
    }
    return msg;
  }

  function logProvenance(code, elapsed) {
    if (!window.ProvenanceFabric) return;
    try {
      window.ProvenanceFabric.append('r_exec', {
        codeHash: window.ProvenanceFabric._fnv1a(code),
        elapsed: elapsed,
        via: 'notebook'
      });
    } catch (_e) {}
  }

  /* ------------------------------- styles --------------------------------- */

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '#' + TOOLBAR_ID + '{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 10px}',
      '#' + TOOLBAR_ID + ' .dg-rnb-btn{min-height:44px;padding:0 14px;border:1px solid var(--border,#2A2C31);border-radius:10px;background:var(--surface-alt,#1A1C20);color:var(--text,#E8E8E8);font-size:13px;font-weight:600;cursor:pointer}',
      '#' + TOOLBAR_ID + ' .dg-rnb-btn.primary{background:var(--primary,#20C5B5);color:#04201C;border-color:transparent}',
      '#' + TOOLBAR_ID + ' .dg-rnb-btn:hover{opacity:.9}',
      '.dg-rnb-sub{font-size:12px;color:var(--text-muted,#8A8F98);margin:2px 0 8px}',
      '.dg-rnb-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}',
      '.dg-rnb-chip{font-size:12px;min-height:34px;padding:6px 11px;border-radius:999px;border:1px solid var(--border,#2A2C31);background:transparent;color:var(--text-muted,#B4B8C0);cursor:pointer}',
      '.dg-rnb-chip.pack{font-weight:700;color:var(--text,#E8E8E8)}',
      '.dg-rnb-chip.pack.on{border-color:var(--primary,#20C5B5);color:var(--primary,#20C5B5)}',
      '.dg-rnb-chip:hover{border-color:var(--primary,#20C5B5);color:var(--primary,#20C5B5)}',
      '#' + HOST_ID + '{overflow-y:auto;flex:1;min-height:0}',
      '.dg-rnb-cell{border:1px solid var(--border,#2A2C31);border-radius:12px;margin:0 0 14px;background:var(--surface,#141518);overflow:hidden}',
      '.dg-rnb-cell.focused{border-color:var(--primary,#20C5B5)}',
      '.dg-rnb-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border,#22242A);font-size:11px;color:var(--text-muted,#8A8F98)}',
      '.dg-rnb-head .grow{flex:1}',
      '.dg-rnb-kind{font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
      '.dg-rnb-iconbtn{min-height:34px;min-width:34px;border:none;background:transparent;color:var(--text-muted,#8A8F98);font-size:15px;cursor:pointer;border-radius:8px}',
      '.dg-rnb-iconbtn:hover{color:var(--text,#E8E8E8);background:var(--surface-alt,#1A1C20)}',
      '.dg-rnb-src{width:100%;box-sizing:border-box;border:none;background:transparent;color:var(--text,#E8E8E8);font-family:var(--mono,"Geist Mono",monospace);font-size:13px;line-height:1.5;padding:10px 12px;resize:vertical;min-height:64px;outline:none}',
      '.dg-rnb-actions{display:flex;align-items:center;gap:10px;padding:6px 10px;border-top:1px solid var(--border,#22242A);flex-wrap:wrap}',
      '.dg-rnb-run{min-height:44px;min-width:96px;border:none;border-radius:10px;background:var(--primary,#20C5B5);color:#04201C;font-weight:800;font-size:13px;cursor:pointer}',
      '.dg-rnb-run:hover{opacity:.9}',
      '.dg-rnb-status{font-size:11px;color:var(--text-muted,#8A8F98)}',
      '.dg-rnb-status.error{color:#DC2626}',
      '.dg-rnb-status.ok{color:var(--proof,#4AE38A)}',
      '.dg-rnb-out{margin:0;padding:10px 12px;font-family:var(--mono,"Geist Mono",monospace);font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--text-secondary,#B4B8C0);border-top:1px solid var(--border,#22242A)}',
      '.dg-rnb-out.error{color:#DC2626}',
      '.dg-rnb-note{padding:6px 12px;font-size:11px;color:var(--warn,#E3A34A);border-top:1px solid var(--border,#22242A)}',
      '.dg-rnb-plot{display:block;max-width:100%;border-top:1px solid var(--border,#22242A);background:#fff}',
      '.dg-rnb-md{padding:12px 14px;font-size:14px;line-height:1.6;color:var(--text,#E8E8E8)}',
      '.dg-rnb-md code{font-family:var(--mono,"Geist Mono",monospace);background:var(--surface-alt,#1A1C20);padding:1px 5px;border-radius:5px}',
      '@media (max-width:640px){#' + TOOLBAR_ID + ' .dg-rnb-btn{flex:1 1 44%}.dg-rnb-run{width:100%}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ------------------------------- transform ------------------------------ */

  function hide(el) { if (el) el.style.display = 'none'; }

  function transformPanel() {
    var pane = document.getElementById('r-view-inner');
    if (!pane) return false;
    if (document.getElementById(HOST_ID)) return true;

    ensureStyles();

    // Retitle the panel head, keep the WebR badge.
    var head = pane.firstElementChild;
    if (head) {
      var titleEl = head.firstElementChild;
      if (titleEl) titleEl.textContent = 'R notebook';
    }

    // Hide the single-cell console controls.
    var rInput = document.getElementById('r-input');
    var rRun = document.getElementById('r-run-btn');
    hide(rInput);
    hide(document.getElementById('r-output'));
    hide(document.getElementById('r-suggestions-bar'));
    if (rRun && rRun.parentElement) hide(rRun.parentElement);
    var domainSel = document.getElementById('r-domain-filter');
    if (domainSel && domainSel.parentElement) hide(domainSel.parentElement);

    var sub = document.createElement('div');
    sub.className = 'dg-rnb-sub';
    sub.textContent = 'On-device R for any industry. Stats, finance, research, ops, healthcare. ' +
      'Rows never leave this browser; only the R runtime is downloaded.';

    var toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.innerHTML =
      '<button type="button" class="dg-rnb-btn" data-rnb="add-code">+ Code</button>' +
      '<button type="button" class="dg-rnb-btn" data-rnb="add-text">+ Text</button>' +
      '<button type="button" class="dg-rnb-btn primary" data-rnb="run-all">Run all</button>' +
      '<button type="button" class="dg-rnb-btn" data-rnb="save">Save .dgrnb</button>' +
      '<button type="button" class="dg-rnb-btn" data-rnb="load">Load</button>' +
      '<span class="dg-rnb-status" id="r-nb-kernel-status" style="margin-left:auto">' +
      esc(_kernelStatus === 'idle' ? 'R starts on first run' : _kernelStatus) + '</span>';

    var chips = document.createElement('div');
    chips.className = 'dg-rnb-chips';
    chips.id = 'r-notebook-chips';

    var host = document.createElement('div');
    host.id = HOST_ID;

    var file = document.createElement('input');
    file.type = 'file';
    file.accept = '.dgrnb,.json,application/json';
    file.style.display = 'none';
    file.id = 'r-notebook-file';
    file.addEventListener('change', onFilePicked);

    pane.appendChild(sub);
    pane.appendChild(toolbar);
    pane.appendChild(chips);
    pane.appendChild(host);
    pane.appendChild(file);

    toolbar.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-rnb]');
      if (!btn) return;
      var act = btn.getAttribute('data-rnb');
      if (act === 'add-code') addCellAndRender('code');
      else if (act === 'add-text') addCellAndRender('markdown');
      else if (act === 'run-all') runAll();
      else if (act === 'save') saveNotebook();
      else if (act === 'load') file.click();
    });

    renderChips();
    return true;
  }

  /* Pack-style industry chips: pick a pack, then insert a starter snippet. */
  function renderChips() {
    var wrap = document.getElementById('r-notebook-chips');
    var eng = engine();
    if (!wrap || !eng) return;
    wrap.innerHTML = '';
    var packs = [
      { id: 'general', label: 'General' },
      { id: 'stats', label: 'Stats' },
      { id: 'finance', label: 'Finance' },
      { id: 'healthcare', label: 'Healthcare' }
    ];
    packs.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dg-rnb-chip pack' + (_industry === p.id ? ' on' : '');
      b.textContent = p.label;
      b.addEventListener('click', function () {
        _industry = _industry === p.id ? 'all' : p.id;
        renderChips();
      });
      wrap.appendChild(b);
    });
    eng.suggestStarterSnippets(_industry === 'all' ? 'general' : _industry).forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dg-rnb-chip';
      b.textContent = s.label;
      b.addEventListener('click', function () { insertIntoFocused(s.code); });
      wrap.appendChild(b);
    });
  }

  /* ------------------------------- notebook ------------------------------- */

  function ensureNotebook() {
    var eng = engine();
    if (!eng) return null;
    if (!_nb) _nb = eng.createNotebook();
    return _nb;
  }

  function focusedCell() {
    if (!_nb) return null;
    var byId = _focusedCellId && _nb.cells.filter(function (c) { return c.id === _focusedCellId; })[0];
    if (byId) return byId;
    for (var i = _nb.cells.length - 1; i >= 0; i--) {
      if (_nb.cells[i].type === 'code') return _nb.cells[i];
    }
    return _nb.cells[_nb.cells.length - 1] || null;
  }

  function insertIntoFocused(code) {
    var cell = focusedCell();
    if (!cell || cell.type !== 'code') { addCellAndRender('code', code); return; }
    engine().updateCellSource(_nb, cell.id, code);
    renderCells();
    var ta = document.querySelector('[data-rcell-src="' + cell.id + '"]');
    if (ta) ta.focus();
  }

  function addCellAndRender(type, source) {
    var eng = engine();
    ensureNotebook();
    var cell = eng.createCell({ type: type, source: source || '' });
    var idx = -1;
    var f = focusedCell();
    if (f) {
      for (var i = 0; i < _nb.cells.length; i++) { if (_nb.cells[i].id === f.id) { idx = i + 1; break; } }
    }
    eng.addCell(_nb, idx === -1 ? _nb.cells.length : idx, cell);
    _focusedCellId = cell.id;
    renderCells();
    var ta = document.querySelector('[data-rcell-src="' + cell.id + '"]');
    if (ta) ta.focus();
  }

  /* ------------------------------- rendering ------------------------------ */

  function renderCells() {
    var host = document.getElementById(HOST_ID);
    if (!host || !_nb) return;
    host.innerHTML = '';
    _nb.cells.forEach(function (cell, index) {
      host.appendChild(renderCell(cell, index));
    });
  }

  function renderCell(cell, index) {
    var wrap = document.createElement('div');
    wrap.className = 'dg-rnb-cell' + (cell.id === _focusedCellId ? ' focused' : '');
    wrap.setAttribute('data-rcell', cell.id);

    var head = document.createElement('div');
    head.className = 'dg-rnb-head';
    head.innerHTML =
      '<span class="dg-rnb-kind">' + (cell.type === 'markdown' ? 'Text' : 'R') + '</span>' +
      '<span class="grow"></span>' +
      '<button type="button" class="dg-rnb-iconbtn" data-rcell-up title="Move up">&#8593;</button>' +
      '<button type="button" class="dg-rnb-iconbtn" data-rcell-down title="Move down">&#8595;</button>' +
      '<button type="button" class="dg-rnb-iconbtn" data-rcell-del title="Delete cell">&times;</button>';
    wrap.appendChild(head);

    var ta = document.createElement('textarea');
    ta.className = 'dg-rnb-src';
    ta.value = cell.source || '';
    ta.spellcheck = false;
    ta.setAttribute('data-rcell-src', cell.id);
    ta.setAttribute('rows', cell.type === 'markdown' ? '3' : '5');
    ta.addEventListener('focus', function () {
      _focusedCellId = cell.id;
      var cur = document.querySelector('.dg-rnb-cell.focused');
      if (cur) cur.classList.remove('focused');
      wrap.classList.add('focused');
    });
    ta.addEventListener('input', function () {
      engine().updateCellSource(_nb, cell.id, ta.value);
      if (cell.type === 'markdown') {
        var md = wrap.querySelector('[data-rcell-md]');
        if (md) md.innerHTML = engine().renderMarkdown(ta.value);
      }
    });
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (cell.type === 'code') runCell(cell.id);
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        var s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.substring(0, s) + '  ' + ta.value.substring(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
        engine().updateCellSource(_nb, cell.id, ta.value);
      }
    });
    wrap.appendChild(ta);

    if (cell.type === 'markdown') {
      var md = document.createElement('div');
      md.className = 'dg-rnb-md';
      md.setAttribute('data-rcell-md', cell.id);
      md.innerHTML = engine().renderMarkdown(cell.source || '');
      wrap.appendChild(md);
    } else {
      var actions = document.createElement('div');
      actions.className = 'dg-rnb-actions';
      actions.innerHTML =
        '<button type="button" class="dg-rnb-run" data-rcell-run="' + cell.id + '">&#9654; Run</button>' +
        '<span class="dg-rnb-status" data-rcell-status="' + cell.id + '">Ctrl+Enter</span>';
      wrap.appendChild(actions);

      var outHost = document.createElement('div');
      outHost.setAttribute('data-rcell-out', cell.id);
      wrap.appendChild(outHost);
      renderOutput(outHost, cell.output);
    }

    head.querySelector('[data-rcell-del]').addEventListener('click', function () {
      engine().removeCell(_nb, cell.id);
      if (_focusedCellId === cell.id) _focusedCellId = null;
      renderCells();
    });
    head.querySelector('[data-rcell-up]').addEventListener('click', function () {
      engine().moveCell(_nb, cell.id, index - 1);
      renderCells();
    });
    head.querySelector('[data-rcell-down]').addEventListener('click', function () {
      engine().moveCell(_nb, cell.id, index + 1);
      renderCells();
    });
    var runBtn = wrap.querySelector('[data-rcell-run]');
    if (runBtn) runBtn.addEventListener('click', function () { runCell(cell.id); });

    return wrap;
  }

  function renderOutput(hostEl, output) {
    if (!hostEl) return;
    hostEl.innerHTML = '';
    if (!output) return;
    if (output.status === 'error' || output.status === 'blocked') {
      var err = document.createElement('pre');
      err.className = 'dg-rnb-out error';
      err.textContent = output.error || 'Error';
      hostEl.appendChild(err);
    } else if (output.stdout && output.stdout.length) {
      var pre = document.createElement('pre');
      pre.className = 'dg-rnb-out';
      pre.textContent = output.stdout;
      hostEl.appendChild(pre);
    }
    var imgs = engine().extractImageDataUrls(output.images);
    imgs.forEach(function (src) {
      var img = document.createElement('img');
      img.className = 'dg-rnb-plot';
      img.alt = 'R plot';
      img.src = src;
      hostEl.appendChild(img);
    });
    (output.notices || []).forEach(function (n) {
      var note = document.createElement('div');
      note.className = 'dg-rnb-note';
      note.textContent = n;
      hostEl.appendChild(note);
    });
    if (output.status === 'ok' && !imgs.length && !(output.stdout && output.stdout.length)) {
      var empty = document.createElement('pre');
      empty.className = 'dg-rnb-out';
      empty.textContent = '(No output)';
      hostEl.appendChild(empty);
    }
  }

  /* ------------------------------- execution ------------------------------ */

  function setStatus(cellId, text, kind) {
    var el = document.querySelector('[data-rcell-status="' + cellId + '"]');
    if (!el) return;
    el.className = 'dg-rnb-status' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }

  function runCell(cellId) {
    var eng = engine();
    if (!eng || !_nb) return Promise.resolve(null);
    var cell = _nb.cells.filter(function (c) { return c.id === cellId; })[0];
    if (!cell || cell.type !== 'code') return Promise.resolve(null);
    if (!eng.canRunCell(cell)) { setStatus(cellId, 'Nothing to run', 'error'); return Promise.resolve(null); }
    setStatus(cellId, 'Running...', null);
    return runR(cell.source).then(function (result) {
      result = result || { status: 'error', error: 'No result' };
      eng.setCellOutput(_nb, cellId, result);
      renderOutput(document.querySelector('[data-rcell-out="' + cellId + '"]'), result);
      if (result.status === 'ok') setStatus(cellId, 'Done in ' + (result.elapsedMs || 0) + ' ms', 'ok');
      else if (result.status === 'blocked') setStatus(cellId, 'Blocked by SecurityAdvisor', 'error');
      else setStatus(cellId, 'Error', 'error');
      return result;
    });
  }

  function runAll() {
    if (!_nb) return Promise.resolve();
    var codeCells = _nb.cells.filter(function (c) { return c.type === 'code' && engine().canRunCell(c); });
    var chain = Promise.resolve();
    codeCells.forEach(function (c) {
      chain = chain.then(function () { return runCell(c.id); });
    });
    return chain.then(function () {
      toast('Ran ' + codeCells.length + ' R cell' + (codeCells.length === 1 ? '' : 's') + ' on this device');
    });
  }

  /* ------------------------------- save / load ---------------------------- */

  function saveNotebook() {
    var eng = engine();
    if (!eng || !_nb) return;
    try {
      var blob = new Blob([eng.serializeNotebook(_nb)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'notebook.dgrnb';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast('R notebook saved to this device');
    } catch (e) {
      toast('Save failed', 'error');
    }
  }

  function onFilePicked(e) {
    var input = e.target;
    var f = input.files && input.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = engine().parseNotebook(String(reader.result || ''));
      if (!parsed.ok) { toast('Could not load notebook: ' + parsed.error, 'error'); input.value = ''; return; }
      _nb = parsed.notebook;
      _focusedCellId = null;
      renderCells();
      toast('R notebook loaded on device');
      input.value = '';
    };
    reader.onerror = function () { toast('Could not read file', 'error'); input.value = ''; };
    reader.readAsText(f);
  }

  /* ------------------------------- boot ----------------------------------- */

  function activate() {
    if (!flagOn()) return;
    if (!engine()) return;
    if (!transformPanel()) return;
    ensureNotebook();
    if (!_wired) {
      _wired = true;
      renderCells();
    }
  }

  function boot() {
    if (!flagOn()) return;
    activate();

    var rNav = document.querySelector('[data-panel="r-view"]');
    if (rNav) rNav.addEventListener('click', function () { setTimeout(activate, 60); });

    // A new dataset means the R side must rebind before the next run.
    document.addEventListener('dataglow:dataset-loaded', function () { _boundFingerprint = ''; });

    window.DataGlowR = {
      version: 1,
      rowLimit: ROW_LIMIT,
      init: initKernel,
      run: runR,
      status: function () { return _kernelStatus; }
    };

    window.DataGlowRNotebook = {
      version: 1,
      getNotebook: function () { return _nb; },
      setNotebook: function (nb) {
        var eng = engine();
        if (!eng) return;
        _nb = nb && nb.cells ? eng.createNotebook(nb) : eng.createNotebook();
        _focusedCellId = null;
        renderCells();
      },
      runCell: runCell,
      runAll: runAll,
      setIndustry: function (id) { _industry = id || 'all'; renderChips(); }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 800); });
  } else {
    setTimeout(boot, 800);
  }
})();
/* ---- end js/intelligence/data-glow-r-notebook-canvas.js ---- */
