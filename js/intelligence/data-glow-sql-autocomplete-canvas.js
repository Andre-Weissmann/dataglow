/* ---- from js/intelligence/data-glow-sql-autocomplete-canvas.js ---- */
;(function () {
  'use strict';

  var MAX_ITEMS = 12;
  var DEBOUNCE_MS = 40;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getPolyglot() {
    return window.PolyglotAutocomplete || null;
  }

  function normalizeColumns(cols) {
    if (!cols) return [];
    if (!Array.isArray(cols)) return [];
    return cols.map(function (col, i) {
      if (typeof col === 'string') return { name: col, type: 'STR' };
      if (!col || typeof col !== 'object') return { name: 'col' + i, type: 'STR' };
      var name = col.name || col.column || col.field || col.key || ('col' + i);
      var type = col.type || col.dtype || col.dataType || 'STR';
      return { name: String(name), type: String(type) };
    });
  }

  function collectObjectSpaceEntries() {
    var entries = [];
    var seen = Object.create(null);

    function pushEntry(name, columns, rowCount, originLanguage) {
      if (!name || seen[name]) return;
      seen[name] = true;
      entries.push({
        name: String(name),
        originLanguage: originLanguage || 'sql',
        kind: 'dataframe',
        schema: normalizeColumns(columns),
        rowCount: typeof rowCount === 'number' ? rowCount : 0,
        provenance: String(name)
      });
    }

    try {
      if (window.ObjectSpace && typeof window.ObjectSpace.createObjectSpace === 'function') {
        /* registry may already exist on a singleton if app created one */
      }
    } catch (_e0) {}

    try {
      var src = null;
      if (typeof window.getDataGlowDatasets === 'function') src = window.getDataGlowDatasets();
      else if (window.state && Array.isArray(window.state.datasets)) src = window.state.datasets;
      if (src && src.length) {
        src.forEach(function (d, i) {
          if (!d) return;
          var name = d.name || d.table || d.tableName || ('dataset_' + i);
          var cols = d.columns || d.schema || d.fields || [];
          var rc = d.rowCount;
          if (rc == null && Array.isArray(d.rows)) rc = d.rows.length;
          pushEntry(name, cols, rc, 'sql');
        });
      }
    } catch (_e1) {}

    try {
      if (typeof getActiveDataset === 'function') {
        var ad = getActiveDataset();
        if (ad) {
          var n = ad.name || ad.table || 'data';
          pushEntry(n, ad.columns || ad.schema || [], Array.isArray(ad.rows) ? ad.rows.length : 0, 'sql');
        }
      }
    } catch (_e2) {}

    try {
      if (window._dgSqlEngine && typeof window._dgSqlEngine.listTables === 'function') {
        var tables = window._dgSqlEngine.listTables() || [];
        tables.forEach(function (t) {
          if (!t) return;
          if (typeof t === 'string') pushEntry(t, [], 0, 'sql');
          else pushEntry(t.name || t.table, t.columns || t.schema || [], t.rowCount || 0, 'sql');
        });
      }
    } catch (_e3) {}

    return entries;
  }

  function wordBeforeCursor(value, pos) {
    var before = String(value || '').slice(0, pos);
    var m = /[A-Za-z_][\w\.]*$/.exec(before);
    if (m) return m[0];
    m = /"([^"]*)$/.exec(before);
    if (m) return m[1] || '';
    return '';
  }

  function mountOnTextarea(textarea, language) {
    if (!textarea || textarea.getAttribute('data-dg-ac') === '1') return null;
    textarea.setAttribute('data-dg-ac', '1');

    var parent = textarea.parentElement;
    if (parent) {
      var cs = window.getComputedStyle(parent);
      if (cs.position === 'static') parent.style.position = 'relative';
    }

    var menu = document.createElement('div');
    menu.className = 'dg-sql-ac-menu';
    menu.id = 'dg-ac-' + (textarea.id || language) + '-' + Math.random().toString(36).slice(2, 7);
    menu.style.display = 'none';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'SQL suggestions');
    if (parent) parent.appendChild(menu);
    else document.body.appendChild(menu);

    var items = [];
    var active = -1;
    var timer = null;
    var open = false;

    function hide() {
      open = false;
      active = -1;
      items = [];
      menu.style.display = 'none';
      menu.innerHTML = '';
      textarea.removeAttribute('aria-activedescendant');
    }

    function position() {
      /* Prefer below the textarea inside relative parent */
      menu.style.left = '8px';
      menu.style.right = '8px';
      menu.style.top = Math.min(textarea.offsetHeight - 8, 120) + 'px';
      menu.style.width = 'auto';
    }

    function render() {
      menu.innerHTML = '';
      if (!items.length) { hide(); return; }
      open = true;
      items.forEach(function (it, idx) {
        var row = document.createElement('div');
        row.className = 'dg-sql-ac-item' + (idx === active ? ' is-active' : '');
        row.id = menu.id + '-opt-' + idx;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', idx === active ? 'true' : 'false');
        row.innerHTML =
          '<span class="dg-sql-ac-badge ' + esc(it.kind || 'keyword') + '">' + esc(it.kind || 'item') + '</span>' +
          '<span class="dg-sql-ac-name">' + esc(it.text) + '</span>' +
          '<span class="dg-sql-ac-meta">' + esc(it.origin || '') + '</span>';
        row.addEventListener('mousedown', function (e) {
          e.preventDefault();
          apply(it);
        });
        menu.appendChild(row);
      });
      position();
      menu.style.display = 'block';
      if (active >= 0) {
        var el = menu.querySelector('.is-active');
        if (el) {
          textarea.setAttribute('aria-activedescendant', el.id);
          try { el.scrollIntoView({ block: 'nearest' }); } catch (_s) {}
        }
      }
    }

    function apply(it) {
      if (!it) return;
      var pos = textarea.selectionStart || 0;
      var val = textarea.value || '';
      var before = val.slice(0, pos);
      var after = val.slice(pos);
      var m = /[A-Za-z_][\w\.]*$/.exec(before);
      var start = m ? pos - m[0].length : pos;
      /* Prefer full token text for replacement (stable vs suffix-only ghost) */
      var insert = it.text || it.insertText || '';
      textarea.value = val.slice(0, start) + insert + after;
      var np = start + insert.length;
      try { textarea.setSelectionRange(np, np); } catch (_e) {}
      hide();
      textarea.focus();
      try { textarea.dispatchEvent(new Event('input', { bubbles: true })); } catch (_e2) {}
    }

    function refresh() {
      var poly = getPolyglot();
      if (!poly || typeof poly.getSuggestions !== 'function') { hide(); return; }
      var pos = textarea.selectionStart || 0;
      var typed = wordBeforeCursor(textarea.value, pos);
      if (!typed || typed.length < 1) { hide(); return; }
      var entries = collectObjectSpaceEntries();
      var list = [];
      try {
        list = poly.getSuggestions(typed, language || 'sql', entries, {
          maxResults: MAX_ITEMS,
          includeBridgePrefixes: true
        }) || [];
      } catch (_e) { list = []; }
      items = list;
      active = list.length ? 0 : -1;
      render();
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, DEBOUNCE_MS);
    }

    textarea.addEventListener('input', schedule);
    textarea.addEventListener('click', schedule);
    textarea.addEventListener('blur', function () {
      setTimeout(hide, 150);
    });
    textarea.addEventListener('keydown', function (e) {
      if (!open || !items.length) {
        if (e.key === 'Escape') hide();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        active = (active + 1) % items.length;
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active - 1 + items.length) % items.length;
        render();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (active >= 0 && items[active]) {
          e.preventDefault();
          apply(items[active]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hide();
      }
    });

    return { refresh: refresh, hide: hide, el: menu };
  }

  function boot() {
    var poly = getPolyglot();
    if (!poly || typeof poly.getSuggestions !== 'function') {
      console.info('[DataGlowSqlAutocomplete] PolyglotAutocomplete.getSuggestions not ready');
    }

    var mounts = [];
    var sqlView = document.getElementById('sql-view-input');
    var sqlLegacy = document.getElementById('sql-input');
    var pyView = document.getElementById('py-view-input');
    var rView = document.getElementById('r-view-input') || document.getElementById('r-input');

    if (sqlView) mounts.push(mountOnTextarea(sqlView, 'sql'));
    if (sqlLegacy) mounts.push(mountOnTextarea(sqlLegacy, 'sql'));
    if (pyView) mounts.push(mountOnTextarea(pyView, 'python'));
    if (rView) mounts.push(mountOnTextarea(rView, 'r'));

    /* Re-bind if Analyze panel is rebuilt later */
    document.addEventListener('dataglow:datasets-changed', function () {
      mounts.forEach(function (m) { if (m && m.refresh) m.refresh(); });
    });

    window.DataGlowSqlAutocomplete = {
      version: 1,
      collectObjectSpaceEntries: collectObjectSpaceEntries,
      mountOnTextarea: mountOnTextarea,
      refreshAll: function () {
        mounts.forEach(function (m) { if (m && m.refresh) m.refresh(); });
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
/* ---- end js/intelligence/data-glow-sql-autocomplete-canvas.js ---- */
