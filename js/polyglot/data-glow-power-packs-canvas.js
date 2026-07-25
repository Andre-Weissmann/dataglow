/* ---- from js/polyglot/data-glow-power-packs-canvas.js ---- */
/*
 * DATAGLOW - The power packs panel.
 *
 * One panel holding the starter material for the four places a person writes
 * something in this product: SQL, the Excel repair path, Python and R. Each tab
 * leads with what the runtime cannot do before it offers a snippet, because a
 * snippet that fails is worse than no snippet.
 *
 * WHY THE CEILING IS AT THE TOP OF EVERY TAB AND NOT IN A FOOTNOTE.
 * The reason people distrust in-browser runtimes is not that they are limited.
 * It is that they discover the limit ten minutes in, from an error message,
 * after building on the assumption it was not there. Stating it first costs one
 * paragraph and buys the rest of the panel some credibility.
 *
 * WHY COPY IS THE ONLY ACTION.
 * The panel never runs anything and never inserts into an editor behind your
 * back. It puts text on the clipboard, tells you it did, and stops. Where a
 * snippet has placeholders they are named next to the button, because a query
 * run against a table called your_table is a wasted click.
 *
 * WHY R AND PYTHON READ THEIR STATE FROM THE RUNTIMES.
 * Whether ggplot2 installed and how many rows crossed the Python bridge are
 * facts owned by the runtime modules. This panel asks them on every render
 * rather than caching, so a tab opened before a table was loaded and read after
 * is not stale.
 */
;(function () {
  'use strict';

  var PANEL_ID = 'dg-packs-panel';
  var BTN_ID = 'dg-packs-btn';
  var STYLE_ID = 'dg-packs-styles';

  var state = { open: false, tab: 'sql', topic: '' };

  function flag(explicitKey, flagKey) {
    try { if (window[explicitKey] === false) return false; } catch (_e0) {}
    try { if (window[explicitKey] === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled(flagKey) !== false;
      }
    } catch (_e) {}
    return true;
  }

  function sqlOn() { return flag('DATAGLOW_SQL_POWER_PACK', 'sqlPowerPack'); }
  function pyOn() { return flag('DATAGLOW_PYTHON_POWER_PACK', 'pythonPowerPack'); }
  function rOn() { return flag('DATAGLOW_R_POWER_PACK', 'rPowerPack'); }
  function excelOn() { return flag('DATAGLOW_EXCEL_HELL_REPAIR', 'excelHellRepair'); }

  function engine(name) {
    try { return window[name] || null; } catch (_e) { return null; }
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'style') node.setAttribute('style', attrs[k]);
        else if (k === 'class') node.className = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function toast(message) {
    try {
      if (typeof window.showToast === 'function') { window.showToast(message); return; }
    } catch (_e) {}
    try { console.log('[packs] ' + message); } catch (_e2) {}
  }

  function copy(text, what) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(function () {
          toast(what + ' copied. Paste it into the editor and change the placeholder names.');
        }, function () {
          toast('Could not reach the clipboard. Select the text and copy it by hand.');
        });
        return;
      }
    } catch (_e) {}
    toast('Could not reach the clipboard. Select the text and copy it by hand.');
  }

  /* ---------------------------------------------------------------
     Observation of the two runtimes that have variable capability.
     --------------------------------------------------------------- */

  function pythonRowCount() {
    try {
      if (window.DATAGLOW_STATE && typeof window.DATAGLOW_STATE.rowCount === 'number') {
        return window.DATAGLOW_STATE.rowCount;
      }
      var r = window.lastQueryResult;
      if (r && typeof r.rowCount === 'number') return r.rowCount;
      if (r && Array.isArray(r.rows)) return r.rows.length;
    } catch (_e) {}
    return 0;
  }

  /* Zero means "not observed here", which the pure pack turns into its own
     default. That default is pinned to the runtime's real limit by a test, so
     the fallback and the truth cannot drift apart silently. */
  function pythonRowLimit() {
    try {
      var py = engine('DataGlowPython');
      if (py && typeof py.rowLimit === 'number') return py.rowLimit;
    } catch (_e) {}
    return 0;
  }

  /* Nothing in this build imports polars, so the honest answer is false rather
     than unknown. When something does, this is the one place to change. */
  function polarsAvailable() {
    return false;
  }

  /* The WebR kernel is the only thing that knows whether the two optional
     packages installed, because it is what tried. Absent that answer we say no,
     which lists more recipes as unavailable than may be true. Overstating what
     installed is the worse error: it hands out a ggplot call that errors. */
  function rCapabilities() {
    try {
      var r = engine('DataGlowR');
      if (r && typeof r.packages === 'function') {
        var c = r.packages() || {};
        return { hasJsonlite: c.jsonlite === true, hasGgplot2: c.ggplot2 === true };
      }
    } catch (_e) {}
    return { hasJsonlite: false, hasGgplot2: false };
  }

  /* ---------------------------------------------------------------
     Models
     --------------------------------------------------------------- */

  function sqlPack() {
    var eng = engine('DataGlowSqlPowerPack');
    if (!eng || typeof eng.buildSqlPowerPack !== 'function') return null;
    try { return eng.buildSqlPowerPack(); } catch (_e) { return null; }
  }

  function pyPack() {
    var eng = engine('DataGlowPythonPowerPack');
    if (!eng || typeof eng.buildPythonPowerPack !== 'function') return null;
    try {
      return eng.buildPythonPowerPack({
        rowCount: pythonRowCount(),
        rowLimit: pythonRowLimit(),
        polarsAvailable: polarsAvailable(),
      });
    } catch (_e) { return null; }
  }

  function rPack() {
    var eng = engine('DataGlowRPowerPack');
    if (!eng || typeof eng.buildRPowerPack !== 'function') return null;
    try { return eng.buildRPowerPack(rCapabilities()); } catch (_e) { return null; }
  }

  /* ---------------------------------------------------------------
     Rendering
     --------------------------------------------------------------- */

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      + '#' + PANEL_ID + '{position:fixed;right:16px;bottom:16px;width:min(560px,calc(100vw - 32px));'
      + 'max-height:min(78vh,780px);overflow:auto;z-index:2147482800;display:none;'
      + 'background:var(--color-surface,#fff);color:inherit;border:1px solid var(--color-border,#ccc);'
      + 'border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.22);padding:14px 16px;font-size:13px;line-height:1.5}'
      + '#' + PANEL_ID + ' h3{margin:0 0 2px;font-size:15px}'
      + '#' + PANEL_ID + ' h4{margin:14px 0 4px;font-size:13px}'
      + '.dg-pk-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'
      + '.dg-pk-note{opacity:.78;font-size:12px;margin:4px 0 0}'
      + '.dg-pk-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 4px}'
      + '.dg-pk-tab,.dg-pk-chip{font:inherit;font-size:12px;padding:5px 11px;border-radius:999px;cursor:pointer;'
      + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit}'
      + '.dg-pk-tab[aria-selected="true"]{font-weight:700;border-color:currentColor;border-width:2px}'
      + '.dg-pk-chip[aria-pressed="true"]{font-weight:700;border-color:currentColor}'
      + '.dg-pk-card{border:1px solid var(--color-border,#ddd);border-radius:9px;padding:9px 11px;margin:8px 0}'
      + '.dg-pk-card b{display:block;font-size:13px}'
      + '.dg-pk-code{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;'
      + 'background:var(--color-bg-alt,rgba(127,127,127,.10));border-radius:7px;padding:8px 9px;margin:6px 0 0;overflow-x:auto}'
      + '.dg-pk-btn{font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;cursor:pointer;'
      + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit}'
      + '.dg-pk-warn{border-left:3px solid currentColor;padding-left:9px;margin:8px 0}'
      + '.dg-pk-ul{margin:4px 0 0;padding-left:18px}'
      + '.dg-pk-ul li{margin:2px 0}'
      + '#' + BTN_ID + '{position:fixed;bottom:18px;right:16px;z-index:2147482790;'
      + 'font:inherit;font-size:12px;padding:6px 11px;border-radius:999px;cursor:pointer;'
      + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.14)}';
    var tag = el('style', { id: STYLE_ID });
    tag.textContent = css;
    (document.head || document.body).appendChild(tag);
  }

  function bullets(host, items) {
    var ul = el('ul', { class: 'dg-pk-ul' });
    for (var i = 0; i < items.length; i++) ul.appendChild(el('li', {}, items[i]));
    host.appendChild(ul);
  }

  function topicChips(host, topics) {
    var row = el('div', { class: 'dg-pk-tabs' });
    var all = [''].concat(topics);
    for (var i = 0; i < all.length; i++) {
      (function (t) {
        var b = el('button', {
          class: 'dg-pk-chip',
          type: 'button',
          'aria-pressed': state.topic === t ? 'true' : 'false',
        }, t || 'Everything');
        b.addEventListener('click', function () {
          state.topic = state.topic === t ? '' : t;
          render();
        });
        row.appendChild(b);
      })(all[i]);
    }
    host.appendChild(row);
  }

  function codeCard(host, title, why, code, placeholders, what) {
    var card = el('div', { class: 'dg-pk-card' });
    card.appendChild(el('b', {}, title));
    if (why) card.appendChild(el('div', { class: 'dg-pk-note' }, why));
    card.appendChild(el('pre', { class: 'dg-pk-code' }, code));
    var row = el('div', { class: 'dg-pk-row' });
    var b = el('button', { class: 'dg-pk-btn', type: 'button' }, 'Copy');
    b.addEventListener('click', function () { copy(code, what || 'Snippet'); });
    row.appendChild(b);
    if (placeholders && placeholders.length) {
      row.appendChild(el('span', { class: 'dg-pk-note' }, 'Replace: ' + placeholders.join(', ')));
    }
    card.appendChild(row);
    host.appendChild(card);
  }

  function renderSql(host) {
    var pack = sqlPack();
    if (!pack) {
      host.appendChild(el('p', { class: 'dg-pk-note' }, 'The SQL pack is not mounted in this build.'));
      return;
    }
    host.appendChild(el('p', { class: 'dg-pk-note' }, pack.engine));
    host.appendChild(el('p', {}, pack.honesty));

    host.appendChild(el('h4', {}, 'Not here at all'));
    bullets(host, pack.notSupported);

    host.appendChild(el('h4', {}, 'Snippets'));
    topicChips(host, pack.topics);
    var eng = engine('DataGlowSqlPowerPack');
    var rows = state.topic && eng && typeof eng.listSnippets === 'function'
      ? eng.listSnippets(state.topic)
      : pack.snippets;
    for (var i = 0; i < rows.length; i++) {
      codeCard(host, rows[i].title, rows[i].why, rows[i].sql, rows[i].substitute, 'Query');
    }

    host.appendChild(el('h4', {}, 'Where DuckDB and Postgres part company'));
    for (var j = 0; j < pack.divergences.length; j++) {
      var d = pack.divergences[j];
      var card = el('div', { class: 'dg-pk-card' });
      card.appendChild(el('b', {}, d.topic));
      card.appendChild(el('div', { class: 'dg-pk-note' }, d.note));
      card.appendChild(el('pre', { class: 'dg-pk-code' }, 'DuckDB:   ' + d.duckdb + '\nPostgres: ' + d.postgres));
      host.appendChild(card);
    }
  }

  function renderExcel(host) {
    host.appendChild(el('p', {}, 'The spreadsheet path is its own surface rather than a snippet list, because the work is repairing a file rather than writing a query. It reads the sheet, names every repair it wants to make, and applies nothing until you say so.'));
    var row = el('div', { class: 'dg-pk-row' });
    var hell = engine('DataGlowExcelHellUI');
    var lib = engine('DataGlowRepairRecipeLibraryUI');
    if (hell && typeof hell.open === 'function') {
      var b = el('button', { class: 'dg-pk-btn', type: 'button' }, 'Open the spreadsheet repair panel');
      b.addEventListener('click', function () { hell.open(); });
      row.appendChild(b);
    }
    if (lib && typeof lib.open === 'function') {
      var b2 = el('button', { class: 'dg-pk-btn', type: 'button' }, 'Open saved repair methods');
      b2.addEventListener('click', function () { lib.open(); });
      row.appendChild(b2);
    }
    if (row.childNodes.length) host.appendChild(row);
    else host.appendChild(el('p', { class: 'dg-pk-note' }, 'Neither spreadsheet surface is mounted in this build, so there is nothing to open from here.'));

    host.appendChild(el('h4', {}, 'What it will not do'));
    bullets(host, [
      'It does not write back to your original file. Nothing on your disk is touched.',
      'It does not guess a repair and apply it. Every change is proposed, and refusing one is a normal outcome.',
      'It does not read a password-protected workbook, and it does not evaluate macros.',
    ]);
  }

  function renderPython(host) {
    var pack = pyPack();
    if (!pack) {
      host.appendChild(el('p', { class: 'dg-pk-note' }, 'The Python pack is not mounted in this build.'));
      return;
    }
    host.appendChild(el('p', { class: 'dg-pk-note' }, pack.runtime));
    host.appendChild(el('p', {}, pack.honesty));

    var warn = el('div', { class: 'dg-pk-warn' });
    warn.appendChild(el('b', {}, pack.bridge.headline));
    warn.appendChild(el('div', { class: 'dg-pk-note' }, pack.bridge.detail));
    host.appendChild(warn);

    host.appendChild(el('p', { class: 'dg-pk-note' }, pack.polars));

    host.appendChild(el('h4', {}, 'Not here at all'));
    bullets(host, pack.notAvailable);

    host.appendChild(el('h4', {}, 'Starter cells'));
    host.appendChild(el('p', { class: 'dg-pk-note' }, 'The bridged dataframe is called ' + pack.frameVariable + '.'));
    topicChips(host, pack.topics);
    var eng = engine('DataGlowPythonPowerPack');
    var rows = state.topic && eng && typeof eng.listRecipes === 'function'
      ? eng.listRecipes(state.topic)
      : pack.recipes;
    for (var i = 0; i < rows.length; i++) {
      codeCard(host, rows[i].title, rows[i].answers, rows[i].code, null, 'Cell');
    }
  }

  function renderR(host) {
    var pack = rPack();
    if (!pack) {
      host.appendChild(el('p', { class: 'dg-pk-note' }, 'The R pack is not mounted in this build.'));
      return;
    }
    host.appendChild(el('p', { class: 'dg-pk-note' }, pack.runtime));
    host.appendChild(el('p', {}, pack.honesty));
    host.appendChild(el('p', {}, pack.headline));

    host.appendChild(el('h4', {}, 'Not here at all'));
    bullets(host, pack.notAvailable);

    host.appendChild(el('h4', {}, 'Starter cells'));
    host.appendChild(el('p', { class: 'dg-pk-note' }, 'The bridge call is ' + pack.bridgeCall + '.'));
    for (var i = 0; i < pack.recipes.length; i++) {
      codeCard(host, pack.recipes[i].title, pack.recipes[i].answers, pack.recipes[i].code, null, 'Cell');
    }

    if (pack.unavailable.length) {
      host.appendChild(el('h4', {}, 'Listed, but not runnable in this session'));
      for (var j = 0; j < pack.unavailable.length; j++) {
        var u = pack.unavailable[j];
        var card = el('div', { class: 'dg-pk-card' });
        card.appendChild(el('b', {}, u.title));
        card.appendChild(el('div', { class: 'dg-pk-note' }, u.reason));
        host.appendChild(card);
      }
    }
  }

  function tabs() {
    var out = [];
    if (sqlOn()) out.push({ id: 'sql', label: 'SQL' });
    if (excelOn()) out.push({ id: 'excel', label: 'Spreadsheets' });
    if (pyOn()) out.push({ id: 'python', label: 'Python' });
    if (rOn()) out.push({ id: 'r', label: 'R' });
    return out;
  }

  function render() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.innerHTML = '';

    var head = el('div', { class: 'dg-pk-row' });
    var title = el('div', {});
    title.appendChild(el('h3', {}, 'Starter material'));
    title.appendChild(el('div', { class: 'dg-pk-note' }, 'What each runtime here can do, what it cannot, and something that runs.'));
    head.appendChild(title);
    var close = el('button', { class: 'dg-pk-btn', type: 'button' }, 'Close');
    close.addEventListener('click', hide);
    head.appendChild(close);
    panel.appendChild(head);

    var list = tabs();
    if (!list.length) {
      panel.appendChild(el('p', { class: 'dg-pk-note' }, 'Every pack is switched off in this build.'));
      panel.style.display = 'block';
      return;
    }
    if (!list.filter(function (t) { return t.id === state.tab; }).length) state.tab = list[0].id;

    var row = el('div', { class: 'dg-pk-tabs', role: 'tablist' });
    for (var i = 0; i < list.length; i++) {
      (function (t) {
        var b = el('button', {
          class: 'dg-pk-tab',
          type: 'button',
          role: 'tab',
          'aria-selected': state.tab === t.id ? 'true' : 'false',
        }, t.label);
        b.addEventListener('click', function () {
          if (state.tab !== t.id) { state.tab = t.id; state.topic = ''; }
          render();
        });
        row.appendChild(b);
      })(list[i]);
    }
    panel.appendChild(row);

    var body = el('div', {});
    if (state.tab === 'sql') renderSql(body);
    else if (state.tab === 'excel') renderExcel(body);
    else if (state.tab === 'python') renderPython(body);
    else if (state.tab === 'r') renderR(body);
    panel.appendChild(body);

    panel.style.display = 'block';
  }

  function show(tab) {
    if (typeof tab === 'string' && tab) { state.tab = tab; state.topic = ''; }
    state.open = true;
    render();
  }

  function hide() {
    state.open = false;
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = 'none';
  }

  function toggle() {
    if (state.open) hide(); else show();
  }

  function anyOn() { return tabs().length > 0; }

  function mount() {
    if (!anyOn()) return;
    if (document.getElementById(PANEL_ID)) return;
    if (!document.body) return;
    styles();
    document.body.appendChild(el('div', {
      id: PANEL_ID,
      role: 'dialog',
      'aria-label': 'Starter material for the runtimes in this page',
    }));
    var btn = el('button', { id: BTN_ID, type: 'button' }, 'Starter material');
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);
  }

  function boot() {
    try { mount(); } catch (_e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1400); });
  } else {
    setTimeout(boot, 1400);
  }

  window.DataGlowPowerPacksUI = {
    version: 1,
    mounted: function () { return !!document.getElementById(PANEL_ID); },
    open: show,
    close: hide,
    toggle: toggle,
    isOpen: function () { return state.open === true; },
    refresh: render,
    tabs: tabs,
    models: function () { return { sql: sqlPack(), python: pyPack(), r: rPack() }; },
  };
})();
/* ---- end js/polyglot/data-glow-power-packs-canvas.js ---- */
