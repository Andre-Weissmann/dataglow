/* ---- from js/intelligence/data-glow-python-notebook-canvas.js ---- */
;(function () {
  'use strict';

  /* Python Notebooks-lite: upgrades the single-cell Python REPL into a
     multi-cell on-device notebook when the pythonNotebooksLite flag is on.
     Reuses the existing Pyodide kernel via window.DataGlowPython (one kernel,
     top-to-bottom state). Flag off leaves the single REPL untouched. */

  var HOST_ID = 'py-notebook-host';
  var TOOLBAR_ID = 'py-notebook-toolbar';
  var STYLE_ID = 'py-notebook-styles';
  var MAX_TABLE_ROWS = 50;

  var _nb = null;
  var _focusedCellId = null;
  var _wired = false;

  function engine() { return window.DataGlowPythonNotebookLite || null; }
  function bridge() { return window.DataGlowPython || null; }

  function flagOn() {
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('pythonNotebooksLite') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, kind || 'info'); return; } catch (_e) {}
    }
    console.info('[Python Notebook]', msg);
  }

  function esc(s) {
    var eng = engine();
    if (eng && typeof eng.escapeHtml === 'function') return eng.escapeHtml(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ------------------------------- styles --------------------------------- */

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '#' + TOOLBAR_ID + '{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 12px}',
      '#' + TOOLBAR_ID + ' .dg-nb-btn{min-height:38px;padding:0 12px;border:1px solid var(--border,#2A2C31);border-radius:10px;background:var(--surface-2,#1A1C20);color:var(--text,#E8E8E8);font-size:13px;font-weight:600;cursor:pointer}',
      '#' + TOOLBAR_ID + ' .dg-nb-btn.primary{background:var(--primary,#20C5B5);color:#04201C;border-color:transparent}',
      '#' + TOOLBAR_ID + ' .dg-nb-btn:hover{opacity:.9}',
      '.dg-nb-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}',
      '.dg-nb-chip{font-size:12px;padding:5px 10px;border-radius:999px;border:1px solid var(--border,#2A2C31);background:transparent;color:var(--text-secondary,#B4B8C0);cursor:pointer}',
      '.dg-nb-chip:hover{border-color:var(--primary,#20C5B5);color:var(--primary,#20C5B5)}',
      '.dg-nb-cell{border:1px solid var(--border,#2A2C31);border-radius:12px;margin:0 0 14px;background:var(--surface,#141518);overflow:hidden}',
      '.dg-nb-cell.focused{border-color:var(--primary,#20C5B5)}',
      '.dg-nb-cell-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border,#22242A);font-size:11px;color:var(--text-muted,#8A8F98)}',
      '.dg-nb-cell-head .grow{flex:1}',
      '.dg-nb-cell-kind{font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
      '.dg-nb-iconbtn{min-height:30px;min-width:30px;border:none;background:transparent;color:var(--text-muted,#8A8F98);font-size:15px;cursor:pointer;border-radius:8px}',
      '.dg-nb-iconbtn:hover{color:var(--text,#E8E8E8);background:var(--surface-2,#1A1C20)}',
      '.dg-nb-src{width:100%;box-sizing:border-box;border:none;background:transparent;color:var(--text,#E8E8E8);font-family:var(--mono,"Geist Mono",monospace);font-size:13px;line-height:1.5;padding:10px 12px;resize:vertical;min-height:64px;outline:none}',
      '.dg-nb-cell-actions{display:flex;align-items:center;gap:10px;padding:6px 10px;border-top:1px solid var(--border,#22242A)}',
      '.dg-nb-run{min-height:44px;min-width:88px;border:none;border-radius:10px;background:var(--primary,#20C5B5);color:#04201C;font-weight:800;font-size:13px;cursor:pointer}',
      '.dg-nb-run:hover{opacity:.9}',
      '.dg-nb-status{font-size:11px;color:var(--text-muted,#8A8F98)}',
      '.dg-nb-status.error{color:#DC2626}',
      '.dg-nb-status.ok{color:var(--proof,#4AE38A)}',
      '.dg-nb-out{margin:0;padding:10px 12px;font-family:var(--mono,"Geist Mono",monospace);font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--text-secondary,#B4B8C0);border-top:1px solid var(--border,#22242A)}',
      '.dg-nb-out.error{color:#DC2626}',
      '.dg-nb-tablewrap{overflow-x:auto;border-top:1px solid var(--border,#22242A)}',
      '.dg-nb-table{border-collapse:collapse;width:100%;font-family:var(--mono,"Geist Mono",monospace);font-size:12px}',
      '.dg-nb-table th,.dg-nb-table td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--border,#22242A);white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}',
      '.dg-nb-md{padding:12px 14px;font-size:14px;line-height:1.6;color:var(--text,#E8E8E8)}',
      '.dg-nb-md code{font-family:var(--mono,"Geist Mono",monospace);background:var(--surface-2,#1A1C20);padding:1px 5px;border-radius:5px}',
      '@media (max-width:640px){.dg-nb-cell-actions{flex-wrap:wrap}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ------------------------------- transform ------------------------------ */

  function hide(el) { if (el) el.style.display = 'none'; }

  function transformPanel() {
    var pane = document.getElementById('py-view-editor-pane');
    if (!pane) return false;
    if (document.getElementById(HOST_ID)) return true; // already transformed

    ensureStyles();

    // Retitle (badge stays "Pyodide + pandas").
    var title = document.getElementById('py-view-title');
    if (title) title.textContent = 'Python Notebook';

    // Hide the single-REPL controls; keep the schema side panel.
    ['py-view-suggestions-bar', 'py-nl-bar', 'py-save-bar', 'py-view-textarea-wrap',
     'py-view-actions-row', 'py-output-wrap', 'py-result-wrap', 'py-progress-msg',
     'py-progress-bar-wrap'].forEach(function (id) { hide(document.getElementById(id)); });

    // Toolbar.
    var toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.innerHTML =
      '<button type="button" class="dg-nb-btn" data-nb="add-code">+ Code</button>' +
      '<button type="button" class="dg-nb-btn" data-nb="add-text">+ Text</button>' +
      '<button type="button" class="dg-nb-btn primary" data-nb="run-all">Run all</button>' +
      '<button type="button" class="dg-nb-btn" data-nb="save">Save .dgnb</button>' +
      '<button type="button" class="dg-nb-btn" data-nb="load">Load</button>' +
      '<span class="dg-nb-status" style="margin-left:auto">On device - rows never leave this browser</span>';

    // Starter chips insert into the focused cell.
    var chips = document.createElement('div');
    chips.className = 'dg-nb-chips';
    var starters = (bridge() && bridge().starters) || [];
    starters.forEach(function (s) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dg-nb-chip';
      chip.textContent = s.label;
      chip.addEventListener('click', function () { insertIntoFocused(s.code); });
      chips.appendChild(chip);
    });

    var host = document.createElement('div');
    host.id = HOST_ID;

    // Hidden file input for Load.
    var file = document.createElement('input');
    file.type = 'file';
    file.accept = '.dgnb,.json,application/json';
    file.style.display = 'none';
    file.id = 'py-notebook-file';
    file.addEventListener('change', onFilePicked);

    pane.appendChild(toolbar);
    pane.appendChild(chips);
    pane.appendChild(host);
    pane.appendChild(file);

    toolbar.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-nb]');
      if (!btn) return;
      var act = btn.getAttribute('data-nb');
      if (act === 'add-code') addCellAndRender('code');
      else if (act === 'add-text') addCellAndRender('markdown');
      else if (act === 'run-all') runAll();
      else if (act === 'save') saveNotebook();
      else if (act === 'load') file.click();
    });

    return true;
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
    // fall back to last code cell.
    for (var i = _nb.cells.length - 1; i >= 0; i--) {
      if (_nb.cells[i].type === 'code') return _nb.cells[i];
    }
    return _nb.cells[_nb.cells.length - 1] || null;
  }

  function insertIntoFocused(code) {
    var cell = focusedCell();
    if (!cell) { addCellAndRender('code', code); return; }
    var eng = engine();
    eng.updateCellSource(_nb, cell.id, code);
    renderCells();
    var ta = document.querySelector('[data-cell-src="' + cell.id + '"]');
    if (ta) { ta.focus(); }
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
    var ta = document.querySelector('[data-cell-src="' + cell.id + '"]');
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
    wrap.className = 'dg-nb-cell' + (cell.id === _focusedCellId ? ' focused' : '');
    wrap.setAttribute('data-cell', cell.id);

    var head = document.createElement('div');
    head.className = 'dg-nb-cell-head';
    head.innerHTML =
      '<span class="dg-nb-cell-kind">' + (cell.type === 'markdown' ? 'Text' : 'Code') + '</span>' +
      '<span class="grow"></span>' +
      '<button type="button" class="dg-nb-iconbtn" data-cell-up title="Move up">&#8593;</button>' +
      '<button type="button" class="dg-nb-iconbtn" data-cell-down title="Move down">&#8595;</button>' +
      '<button type="button" class="dg-nb-iconbtn" data-cell-del title="Delete cell">&times;</button>';
    wrap.appendChild(head);

    var ta = document.createElement('textarea');
    ta.className = 'dg-nb-src';
    ta.value = cell.source || '';
    ta.spellcheck = false;
    ta.setAttribute('data-cell-src', cell.id);
    ta.setAttribute('rows', cell.type === 'markdown' ? '3' : '4');
    ta.addEventListener('focus', function () {
      _focusedCellId = cell.id;
      var cur = document.querySelector('.dg-nb-cell.focused');
      if (cur) cur.classList.remove('focused');
      wrap.classList.add('focused');
    });
    ta.addEventListener('input', function () {
      engine().updateCellSource(_nb, cell.id, ta.value);
      if (cell.type === 'markdown') updateMarkdownPreview(wrap, ta.value);
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
      md.className = 'dg-nb-md';
      md.setAttribute('data-cell-md', cell.id);
      md.innerHTML = engine().renderMarkdown(cell.source || '');
      wrap.appendChild(md);
    } else {
      var actions = document.createElement('div');
      actions.className = 'dg-nb-cell-actions';
      actions.innerHTML =
        '<button type="button" class="dg-nb-run" data-cell-run="' + cell.id + '">&#9654; Run</button>' +
        '<span class="dg-nb-status" data-cell-status="' + cell.id + '">Ctrl+Enter</span>';
      wrap.appendChild(actions);

      var outHost = document.createElement('div');
      outHost.setAttribute('data-cell-out', cell.id);
      wrap.appendChild(outHost);
      renderOutput(outHost, cell.output);
    }

    // Head button wiring.
    head.querySelector('[data-cell-del]').addEventListener('click', function () {
      engine().removeCell(_nb, cell.id);
      if (_focusedCellId === cell.id) _focusedCellId = null;
      renderCells();
    });
    head.querySelector('[data-cell-up]').addEventListener('click', function () {
      engine().moveCell(_nb, cell.id, index - 1);
      renderCells();
    });
    head.querySelector('[data-cell-down]').addEventListener('click', function () {
      engine().moveCell(_nb, cell.id, index + 1);
      renderCells();
    });
    var runBtn = wrap.querySelector('[data-cell-run]');
    if (runBtn) runBtn.addEventListener('click', function () { runCell(cell.id); });

    return wrap;
  }

  function updateMarkdownPreview(wrap, source) {
    var md = wrap.querySelector('[data-cell-md]');
    if (md) md.innerHTML = engine().renderMarkdown(source || '');
  }

  function renderOutput(hostEl, output) {
    if (!hostEl) return;
    hostEl.innerHTML = '';
    if (!output) return;
    if (output.status === 'error' || output.status === 'blocked') {
      var err = document.createElement('pre');
      err.className = 'dg-nb-out error';
      err.textContent = output.error || 'Error';
      hostEl.appendChild(err);
      return;
    }
    if (output.stdout && output.stdout.length) {
      var pre = document.createElement('pre');
      pre.className = 'dg-nb-out';
      pre.textContent = output.stdout;
      hostEl.appendChild(pre);
    }
    if (output.table && output.table.columns && output.table.columns.length) {
      hostEl.appendChild(renderTable(output.table));
    }
    if ((!output.stdout || !output.stdout.length) && !(output.table && output.table.columns)) {
      var empty = document.createElement('pre');
      empty.className = 'dg-nb-out';
      empty.textContent = '(No output)';
      hostEl.appendChild(empty);
    }
  }

  function renderTable(table) {
    var wrap = document.createElement('div');
    wrap.className = 'dg-nb-tablewrap';
    var t = document.createElement('table');
    t.className = 'dg-nb-table';
    var head = '<tr>' + table.columns.map(function (c) {
      return '<th>' + esc(c) + '</th>';
    }).join('') + '</tr>';
    var rows = (table.rows || []).slice(0, MAX_TABLE_ROWS).map(function (r) {
      return '<tr>' + table.columns.map(function (_c, i) {
        var v = r[i];
        return '<td>' + esc(v == null ? '' : v) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    t.innerHTML = '<thead>' + head + '</thead><tbody>' + rows + '</tbody>';
    wrap.appendChild(t);
    return wrap;
  }

  /* ------------------------------- execution ------------------------------ */

  function setStatus(cellId, text, kind) {
    var el = document.querySelector('[data-cell-status="' + cellId + '"]');
    if (!el) return;
    el.className = 'dg-nb-status' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }

  function runCell(cellId) {
    var eng = engine();
    var br = bridge();
    if (!eng || !_nb) return Promise.resolve(null);
    var cell = _nb.cells.filter(function (c) { return c.id === cellId; })[0];
    if (!cell || cell.type !== 'code') return Promise.resolve(null);
    if (!eng.canRunCell(cell)) { setStatus(cellId, 'Nothing to run', 'error'); return Promise.resolve(null); }
    if (!br || typeof br.run !== 'function') {
      setStatus(cellId, 'Python runtime not available', 'error');
      return Promise.resolve(null);
    }
    setStatus(cellId, 'Running...', null);
    return br.run(cell.source).then(function (result) {
      result = result || { status: 'error', error: 'No result' };
      eng.setCellOutput(_nb, cellId, result);
      var outHost = document.querySelector('[data-cell-out="' + cellId + '"]');
      renderOutput(outHost, result);
      if (result.status === 'ok') setStatus(cellId, 'Done in ' + (result.elapsedMs || 0) + ' ms', 'ok');
      else if (result.status === 'blocked') setStatus(cellId, 'Blocked by SecurityAdvisor', 'error');
      else setStatus(cellId, 'Error', 'error');
      return result;
    }).catch(function (e) {
      var result = { status: 'error', stdout: '', error: String(e), table: null, elapsedMs: 0 };
      eng.setCellOutput(_nb, cellId, result);
      renderOutput(document.querySelector('[data-cell-out="' + cellId + '"]'), result);
      setStatus(cellId, 'Error', 'error');
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
    return chain.then(function () { toast('Ran ' + codeCells.length + ' cell' + (codeCells.length === 1 ? '' : 's')); });
  }

  /* ------------------------------- save / load ---------------------------- */

  function saveNotebook() {
    var eng = engine();
    if (!eng || !_nb) return;
    var json = eng.serializeNotebook(_nb);
    try {
      var blob = new Blob([json], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'notebook.dgnb';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast('Notebook saved to this device');
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
      toast('Notebook loaded on device');
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

    // Re-activate when the Python panel is opened via nav (panel exists at load,
    // but this guards against late DOM construction).
    var pyNav = document.querySelector('[data-panel="python-view"]');
    if (pyNav) pyNav.addEventListener('click', function () { setTimeout(activate, 60); });

    // Refresh starter chips + schema when a dataset loads.
    document.addEventListener('dataglow:dataset-loaded', function () {
      if (bridge() && typeof bridge().refreshSchema === 'function') bridge().refreshSchema();
    });

    window.DataGlowPythonNotebook = {
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
      runAll: runAll
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 700); });
  } else {
    setTimeout(boot, 700);
  }
})();
/* ---- end js/intelligence/data-glow-python-notebook-canvas.js ---- */
