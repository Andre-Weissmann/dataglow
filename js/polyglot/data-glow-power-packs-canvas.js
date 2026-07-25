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

  /* Bundle 13 deepen flags. Each one gates a section inside an existing tab and
     none of them adds a tab, because the point of the drawer was to stop this
     product growing a button per capability. Off means the section is absent
     and the tab renders exactly as it did before. */
  function sqlDeepOn() { return flag('DATAGLOW_SQL_POWER_DEEPEN', 'sqlPowerDeepen'); }
  function pyDeepOn() { return flag('DATAGLOW_PYTHON_POWER_DEEPEN', 'pythonPowerDeepen'); }
  function rDeepOn() { return flag('DATAGLOW_R_POWER_DEEPEN', 'rPowerDeepen'); }
  function typeGuardOn() { return flag('DATAGLOW_EXCEL_TYPE_GUARD', 'excelTypeGuard'); }
  function arrowOn() { return flag('DATAGLOW_ARROW_BRIDGE', 'arrowBridge'); }
  function pqNoteOn() { return flag('DATAGLOW_POWER_QUERY_HONEST_NOTE', 'powerQueryHonestNote'); }

  /* Bundle 14 flags. Same rule as Bundle 13's: each one gates a section inside
     an existing tab, or (project lanes) a tab of its own, never a new top-nav
     item. */
  function pqParityOn() { return flag('DATAGLOW_PQ_PARITY_RECIPES', 'pqParityRecipes'); }
  function arrowDeepenOn() { return flag('DATAGLOW_ARROW_BRIDGE_DEEPEN', 'arrowBridgeDeepen'); }
  function lanesOn() { return flag('DATAGLOW_POLYGLOT_PROJECT_LANES', 'polyglotProjectLanes'); }
  function ledgerOn() { return flag('DATAGLOW_REPAIR_LEDGER', 'repairLedger'); }

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

  /* Bundle 11 and 12 answered this with a hard-coded false. That was the right
     answer and it was arrived at the wrong way: nobody asked. Now the probe in
     js/polyglot/python-deepen.js records what the interpreter said, and this
     reads that record. An unprobed session still answers false, because the
     recipes are gated on `available` and not on `not known to be absent`. */
  function pythonProbe() {
    try {
      var p = window.DATAGLOW_PY_PROBE;
      if (p && typeof p === 'object') return { probed: true, packages: p };
    } catch (_e) {}
    return { probed: false, packages: {} };
  }

  function polarsAvailable() {
    var p = pythonProbe();
    return p.probed === true && p.packages.polars === true;
  }

  function airGapActive() {
    try {
      var ag = window.DataGlowAirGap;
      if (ag && typeof ag.isAirGapActive === 'function') return ag.isAirGapActive() === true;
    } catch (_e) {}
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
    b.addEventListener('click', function () {
      copy(code, what || 'Snippet');
      if (what === 'Query') {
        ledgerAppend({
          kind: 'sql_recipe_run',
          engine: 'sql',
          title: title,
          code: code,
          summary: title + ' copied to the clipboard',
          status: 'proposed',
        });
      }
    });
    row.appendChild(b);
    if (placeholders && placeholders.length) {
      row.appendChild(el('span', { class: 'dg-pk-note' }, 'Replace: ' + placeholders.join(', ')));
    }
    card.appendChild(row);
    host.appendChild(card);
  }

  /* ---------------------------------------------------------------
     Bundle 13: profiling that becomes proof
     --------------------------------------------------------------- */

  async function runSql(sql) {
    var conn = null;
    try { conn = window.duckdbConn; } catch (_e) {}
    if (!conn || typeof conn.query !== 'function') throw new Error('no-engine');
    var res = await conn.query(sql);
    var rows = [];
    try {
      rows = typeof res.toArray === 'function'
        ? res.toArray().map(function (r) { return typeof r.toJSON === 'function' ? r.toJSON() : r; })
        : (Array.isArray(res) ? res : []);
    } catch (_e2) { rows = []; }
    return rows;
  }

  function activeTable() {
    try {
      var s = window.DATAGLOW_STATE;
      if (s && Array.isArray(s.datasets) && s.datasets.length) {
        var ds = s.datasets[s.activeDatasetIndex || 0] || s.datasets[0];
        if (ds && (ds.table || ds.name)) return ds.table || ds.name;
      }
    } catch (_e) {}
    return '';
  }

  /* One button, pressed by a person, which is the only thing in this panel that
     executes anything. Everything it produces is a Proof Board tile carrying
     the SQL that produced it, so "show the work" is a real link. */
  function profileTable(statusHost) {
    var eng = engine('DataGlowSqlDeepen');
    var board = engine('DataGlowProofBoardUI');
    var table = activeTable();

    function say(text) {
      statusHost.textContent = text;
    }

    if (!eng || typeof eng.summarizeToTiles !== 'function') {
      say('The profiling engine is not mounted in this build.');
      return;
    }
    if (!table) {
      say('No table is loaded, so there is nothing to profile. Load a file first.');
      return;
    }
    say('Profiling ' + table + '...');

    runSql(eng.summarizeSql(table)).then(function (rows) {
      var out = eng.summarizeToTiles({ table: table, rows: rows });
      if (!out.tiles.length) {
        say(out.headline);
        return;
      }
      var added = 0;
      if (board && typeof board.addTile === 'function') {
        for (var i = 0; i < out.tiles.length; i++) {
          try { if (board.addTile(out.tiles[i])) added++; } catch (_e) {}
        }
      }
      say(added
        ? out.headline + ' ' + added + ' tile' + (added === 1 ? '' : 's') + ' added to the Proof Board.'
        : out.headline + ' The Proof Board is not mounted in this build, so nothing was added to it.');
      toast(out.headline);
      ledgerAppend({
        kind: 'summarize_tiles',
        engine: 'sql',
        title: 'SUMMARIZE profile of ' + table,
        code: eng.summarizeSql(table),
        inputTable: table,
        summary: out.headline,
        status: 'applied',
      });
    }, function (err) {
      say(String(err && err.message) === 'no-engine'
        ? 'DuckDB has not started in this page yet, so there is nothing to profile. Run a query first.'
        : 'SUMMARIZE did not run against ' + table + '. The table may be empty or the engine may still be starting.');
    });
  }

  function renderSqlDeepen(host) {
    var eng = engine('DataGlowSqlDeepen');
    if (!eng || typeof eng.buildSqlDeepen !== 'function') return;
    var deep;
    try { deep = eng.buildSqlDeepen(); } catch (_e) { return; }

    host.appendChild(el('h4', {}, 'Profile the table, and keep what it finds'));
    host.appendChild(el('p', { class: 'dg-pk-note' }, deep.summarizeHonesty));
    var row = el('div', { class: 'dg-pk-row' });
    var btn = el('button', { class: 'dg-pk-btn', type: 'button' }, 'Run SUMMARIZE and add findings to the Proof Board');
    var status = el('div', { class: 'dg-pk-note' }, activeTable()
      ? 'Ready to profile ' + activeTable() + '.'
      : 'No table is loaded yet.');
    btn.addEventListener('click', function () { profileTable(status); });
    row.appendChild(btn);
    host.appendChild(row);
    host.appendChild(status);

    var q = engine('DataGlowCsvQuarantineUI');
    if (q && typeof q.open === 'function') {
      var qrow = el('div', { class: 'dg-pk-row' });
      var qbtn = el('button', { class: 'dg-pk-btn', type: 'button' }, 'Show the last quarantined rows');
      qbtn.addEventListener('click', function () {
        var m = typeof q.model === 'function' ? q.model() : null;
        if (m) q.open(m, null);
        else toast('Nothing has been quarantined in this session. Every line of every file loaded so far parsed.');
      });
      qrow.appendChild(qbtn);
      qrow.appendChild(el('span', { class: 'dg-pk-note' },
        'Rows a CSV load could not parse are held out and listed rather than dropped silently.'));
      host.appendChild(qrow);
    }

    host.appendChild(el('h4', {}, 'The shapes people rebuild from memory'));
    for (var i = 0; i < deep.snippets.length; i++) {
      codeCard(host, deep.snippets[i].title, deep.snippets[i].why, deep.snippets[i].sql,
        deep.snippets[i].substitute, 'Query');
    }
  }

  /* ---------------------------------------------------------------
     Bundle 14: PQ-parity recipes. DuckDB SQL, never M. Same codeCard shape
     as every other snippet list in this panel, so it reads as one more
     section rather than a bolted-on feature.
     --------------------------------------------------------------- */
  function renderPqParity(host) {
    var eng = engine('DataGlowPqParityRecipes');
    if (!eng || typeof eng.buildPqParityPack !== 'function') return;
    var pack;
    try { pack = eng.buildPqParityPack(); } catch (_e) { return; }

    host.appendChild(el('h4', {}, 'The Power Query steps, as DuckDB SQL'));
    host.appendChild(el('p', { class: 'dg-pk-note' }, pack.honesty));
    host.appendChild(el('p', { class: 'dg-pk-note' }, pack.appliedStepsBlurb));

    var ledger = engine('DataGlowRepairLedgerUI');
    if (ledger && typeof ledger.open === 'function') {
      var lrow = el('div', { class: 'dg-pk-row' });
      var lbtn = el('button', { class: 'dg-pk-btn', type: 'button' }, 'Open the Repair Ledger');
      lbtn.addEventListener('click', function () { ledger.open(); });
      lrow.appendChild(lbtn);
      host.appendChild(lrow);
    }

    for (var i = 0; i < pack.recipes.length; i++) {
      var r = pack.recipes[i];
      codeCard(host, r.title + ' (' + r.pqStep + ')', r.why, r.sql, r.substitute, 'Query');
    }
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

    if (sqlDeepOn()) renderSqlDeepen(host);
    if (pqParityOn()) renderPqParity(host);

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

  /* ---------------------------------------------------------------
     Bundle 13: the import type guard, and the Power Query answer
     --------------------------------------------------------------- */

  function activeDataset() {
    try {
      var s = window.DATAGLOW_STATE;
      if (s && Array.isArray(s.datasets) && s.datasets.length) {
        return s.datasets[s.activeDatasetIndex || 0] || s.datasets[0];
      }
    } catch (_e) {}
    return null;
  }

  function recordGuardReceipt(line) {
    if (!line) return;
    try {
      var t = window.DataGlowTrustLedger;
      if (t && typeof t.record === 'function') { t.record(line); }
    } catch (_e) {}
    try { console.log('[type guard receipt] ' + line.line); } catch (_e2) {}
    try { window.DataGlowPowerPacksUI._lastGuardReceipt = line; } catch (_e3) {}
    ledgerAppend({ kind: 'type_guard', engine: 'excel', title: 'Excel type guard check', summary: String(line && line.line || 'Type guard ran'), status: 'applied' });
  }

  /* ---------------------------------------------------------------
     Bundle 14: best-effort Repair Ledger wiring. Never throws, never blocks
     the surface it is called from; a ledger append that fails is a step this
     panel loses sight of, not a step that fails to happen for the user.
     Sources fired are recorded on window.DataGlowPowerPacksUI._ledgerFired so
     wiringReport() can name what has and has not appended this session.
     --------------------------------------------------------------- */
  function ledgerAppend(input) {
    try {
      var eng = engine('DataGlowRepairLedger');
      var ui = engine('DataGlowRepairLedgerUI');
      if (!eng || typeof eng.appendStep !== 'function' || !ui || typeof ui.ledgerArray !== 'function') return null;
      var arr = ui.ledgerArray();
      if (!Array.isArray(arr)) return null;
      var step = eng.appendStep(arr, input);
      try {
        var fired = window.DataGlowPowerPacksUI && window.DataGlowPowerPacksUI._ledgerFired;
        if (!Array.isArray(fired)) { fired = []; window.DataGlowPowerPacksUI._ledgerFired = fired; }
        var src = input && input.kind === 'type_guard' ? 'type_guard' : (input && input.kind === 'summarize_tiles' ? 'summarize_tiles' : (input && input.kind));
        if (src && fired.indexOf(src) < 0) fired.push(src);
      } catch (_e4) {}
      if (ui && typeof ui.refresh === 'function') { try { ui.refresh(); } catch (_e5) {} }
      return step;
    } catch (_e) { return null; }
  }

  function renderTypeGuard(host) {
    var eng = engine('DataGlowExcelTypeGuard');
    if (!eng || typeof eng.detectTypeRisks !== 'function') return;

    host.appendChild(el('h4', {}, 'Identifiers a spreadsheet eats'));
    host.appendChild(el('p', { class: 'dg-pk-note' }, eng.TYPE_GUARD_HONESTY));

    var results = el('div', {});
    var row = el('div', { class: 'dg-pk-row' });
    var btn = el('button', { class: 'dg-pk-btn', type: 'button' }, 'Check the loaded table');
    btn.addEventListener('click', function () {
      results.innerHTML = '';
      var ds = activeDataset();
      if (!ds || !Array.isArray(ds.rows) || !ds.rows.length) {
        results.appendChild(el('p', { class: 'dg-pk-note' }, 'No table is loaded, so there is nothing to check.'));
        return;
      }
      var det;
      try { det = eng.detectTypeRisks({ columns: ds.columns, rows: ds.rows }); }
      catch (_e) {
        results.appendChild(el('p', { class: 'dg-pk-note' }, 'The guard could not read this table.'));
        return;
      }
      results.appendChild(el('p', {}, det.headline));
      if (!det.fired) {
        recordGuardReceipt(eng.typeGuardReceiptLine(det, 'clean'));
        return;
      }
      for (var i = 0; i < det.findings.length; i++) {
        var f = det.findings[i];
        var card = el('div', { class: 'dg-pk-card' });
        card.appendChild(el('b', {}, f.column + ': ' + f.label));
        card.appendChild(el('div', { class: 'dg-pk-note' }, f.detail));
        card.appendChild(el('div', { class: 'dg-pk-note' },
          f.matched + ' of ' + f.sampled + ' sampled cells (' + f.sharePercent + ' percent). For example: ' + f.examples.join(', ')));
        results.appendChild(card);
      }

      // Preview, then confirm. Nothing is applied by looking.
      var prev = eng.previewGuard(det, null);
      var pv = el('div', { class: 'dg-pk-warn' });
      pv.appendChild(el('b', {}, prev.summary));
      for (var d = 0; d < prev.declined.length; d++) {
        pv.appendChild(el('div', { class: 'dg-pk-note' }, prev.declined[d].column + ': ' + prev.declined[d].why));
      }
      results.appendChild(pv);

      if (prev.steps.length) {
        var actions = el('div', { class: 'dg-pk-row' });
        var apply = el('button', { class: 'dg-pk-btn', type: 'button' }, prev.confirmPrompt);
        apply.addEventListener('click', function () {
          var cols = prev.steps.map(function (s) { return s.column; });
          var applied = false;
          var hell = engine('DataGlowExcelHellUI');
          if (hell && typeof hell.open === 'function') {
            // The repair panel owns apply and undo. This hands the columns over
            // rather than mutating a dataset behind that panel's back.
            try { window.DATAGLOW_TYPE_GUARD_HOLD = cols; hell.open(); applied = true; } catch (_e2) {}
          }
          recordGuardReceipt(eng.typeGuardReceiptLine(det, 'applied', cols));
          toast(applied
            ? 'Opened the repair panel with ' + cols.join(', ') + ' marked to hold as text. Confirm there to apply, and it is undoable.'
            : 'Recorded that ' + cols.join(', ') + ' should be held as text. The repair panel is not mounted in this build, so apply it there when it is.');
        });
        var override = el('button', { class: 'dg-pk-btn', type: 'button' }, 'Import unchanged');
        override.addEventListener('click', function () {
          recordGuardReceipt(eng.typeGuardReceiptLine(det, 'overridden', det.findings.map(function (f2) { return f2.column; })));
          toast('Recorded as an override. The columns stay as they are and the receipt says who decided that.');
        });
        actions.appendChild(apply);
        actions.appendChild(override);
        results.appendChild(actions);
      }
    });
    row.appendChild(btn);
    host.appendChild(row);
    host.appendChild(results);
  }

  function renderPowerQueryNote(host) {
    var eng = engine('DataGlowPowerQueryNote');
    if (!eng || typeof eng.buildPowerQueryNote !== 'function') return;
    var pq;
    try { pq = eng.buildPowerQueryNote(); } catch (_e) { return; }

    host.appendChild(el('h4', {}, 'Power Query'));
    host.appendChild(el('p', {}, pq.note));
    host.appendChild(el('p', { class: 'dg-pk-note' }, pq.detail));
    var ul = el('ul', { class: 'dg-pk-ul' });
    for (var i = 0; i < pq.equivalents.length; i++) {
      ul.appendChild(el('li', {}, pq.equivalents[i].step + ': ' + pq.equivalents[i].here));
    }
    host.appendChild(ul);
    host.appendChild(el('p', { class: 'dg-pk-note' }, pq.handoff));
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

    if (typeGuardOn()) renderTypeGuard(host);
    if (pqNoteOn()) renderPowerQueryNote(host);
  }

  /* ---------------------------------------------------------------
     Bundle 13: the probe, the packages it unlocks, and the Arrow status
     --------------------------------------------------------------- */

  function renderArrowStatus(host) {
    var eng = engine('DataGlowArrowBridge');
    if (!eng || typeof eng.buildArrowBridgeStatus !== 'function') return;
    var probe = pythonProbe();
    var input = {
      // DuckDB-WASM in this page materialises rows for the bridge rather than
      // handing out an Arrow buffer, so this is false until that changes. It
      // is written as an observation rather than a constant so the one place
      // to change is here.
      duckdbArrow: false,
      pyarrow: probe.packages.pyarrow === true,
      pythonReady: pythonRowLimit() > 0,
      rowLimit: pythonRowLimit(),
      rowCount: pythonRowCount(),
    };
    var status;
    try { status = eng.buildArrowBridgeStatus(input); } catch (_e) { return; }

    var warn = el('div', { class: 'dg-pk-warn' });
    warn.appendChild(el('b', {}, status.label));
    warn.appendChild(el('div', { class: 'dg-pk-note' }, status.detail));
    for (var i = 0; i < status.missingPieces.length; i++) {
      warn.appendChild(el('div', { class: 'dg-pk-note' }, 'Missing: ' + status.missingPieces[i] + '.'));
    }
    warn.appendChild(el('div', { class: 'dg-pk-note' }, status.neverUnlimited));
    host.appendChild(warn);

    if (arrowDeepenOn() && typeof eng.buildArrowBridgeStatusV2 === 'function') {
      var v2;
      try { v2 = eng.buildArrowBridgeStatusV2(input); } catch (_e2) { v2 = null; }
      if (v2) {
        var deep = el('div', { class: 'dg-pk-warn' });
        deep.appendChild(el('b', {}, 'Transfer in use: ' + v2.transferKind));
        deep.appendChild(el('div', { class: 'dg-pk-note' }, v2.headline));
        host.appendChild(deep);

        if (typeof eng.roundTripFixture === 'function') {
          var rtRow = el('div', { class: 'dg-pk-row' });
          var rtBtn = el('button', { class: 'dg-pk-btn', type: 'button' }, 'Prove the batch round trip on a fixture');
          var rtStatus = el('span', { class: 'dg-pk-note' }, '');
          rtBtn.addEventListener('click', function () {
            var proof;
            try { proof = eng.roundTripFixture(); } catch (_e3) { proof = null; }
            rtStatus.textContent = proof ? proof.note : 'The round-trip proof did not run in this build.';
          });
          rtRow.appendChild(rtBtn);
          rtRow.appendChild(rtStatus);
          host.appendChild(rtRow);
        }
        if (eng.BATCH_BRIDGE_CEILING) {
          host.appendChild(el('div', { class: 'dg-pk-note' }, eng.BATCH_BRIDGE_CEILING));
        }
      }
    }
  }

  function renderPythonDeepen(host) {
    var eng = engine('DataGlowPythonDeepen');
    if (!eng || typeof eng.buildPythonDeepen !== 'function') return;
    var probe = pythonProbe();
    var deep;
    try {
      deep = eng.buildPythonDeepen({ probed: probe.probed, packages: probe.packages, airGap: airGapActive() });
    } catch (_e) { return; }

    host.appendChild(el('h4', {}, 'Beyond pandas'));
    host.appendChild(el('p', {}, deep.headline));
    host.appendChild(el('p', { class: 'dg-pk-note' }, deep.honesty));
    codeCard(host, 'Ask this session what it has', 'One line per package, so a missing one does not hide the others. Paste the printed answers into window.DATAGLOW_PY_PROBE to make this panel read them.', deep.probeCell, null, 'Probe cell');

    if (arrowOn()) renderArrowStatus(host);

    for (var i = 0; i < deep.recipes.length; i++) {
      codeCard(host, deep.recipes[i].title, deep.recipes[i].answers, deep.recipes[i].code, null, 'Cell');
    }

    if (deep.blocked.length) {
      host.appendChild(el('h4', {}, 'Listed, but not runnable in this session'));
      for (var j = 0; j < deep.blocked.length; j++) {
        var b = deep.blocked[j];
        var card = el('div', { class: 'dg-pk-card' });
        card.appendChild(el('b', {}, b.title));
        card.appendChild(el('div', { class: 'dg-pk-note' }, b.reason));
        if (b.howToEnable) card.appendChild(el('div', { class: 'dg-pk-note' }, b.howToEnable));
        host.appendChild(card);
      }
    }
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

    if (pyDeepOn()) renderPythonDeepen(host);
  }

  /* Bundle 13. dplyr and tidyr are never fetched by the runtime at startup, so
     there is nothing in rCapabilities() that could answer for them; the only
     honest source is a person running install.packages and reporting back,
     the same probe shape the Python deepen pack uses. */
  function rProbe() {
    try {
      var p = window.DATAGLOW_R_PROBE;
      if (p && typeof p === 'object') return p;
    } catch (_e) {}
    return {};
  }

  function renderRDeepen(host) {
    var eng = engine('DataGlowRDeepen');
    if (!eng || typeof eng.buildRDeepen !== 'function') return;
    var caps = rCapabilities();
    var probe = rProbe();
    var deep;
    try {
      deep = eng.buildRDeepen({
        hasJsonlite: caps.hasJsonlite,
        hasGgplot2: caps.hasGgplot2,
        hasDplyr: probe.dplyr === true,
        hasTidyr: probe.tidyr === true,
        airGap: airGapActive(),
        offline: (typeof navigator !== 'undefined' && navigator.onLine === false),
      });
    } catch (_e) { return; }

    host.appendChild(el('h4', {}, 'Beyond base R'));
    host.appendChild(el('p', {}, deep.headline));
    host.appendChild(el('p', { class: 'dg-pk-note' }, deep.honesty));

    for (var i = 0; i < deep.recipes.length; i++) {
      codeCard(host, deep.recipes[i].title, deep.recipes[i].answers, deep.recipes[i].code, null, 'Cell');
    }

    if (deep.blocked.length) {
      host.appendChild(el('h4', {}, 'Listed, but not runnable in this session'));
      for (var j = 0; j < deep.blocked.length; j++) {
        var b = deep.blocked[j];
        var card = el('div', { class: 'dg-pk-card' });
        card.appendChild(el('b', {}, b.title));
        card.appendChild(el('div', { class: 'dg-pk-note' }, b.reason));
        if (b.instead) card.appendChild(el('div', { class: 'dg-pk-note' }, 'Instead: ' + b.instead.title + '.'));
        if (b.howToEnable) card.appendChild(el('div', { class: 'dg-pk-note' }, b.howToEnable));
        host.appendChild(card);
      }
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

    if (rDeepOn()) renderRDeepen(host);
  }

  /* ---------------------------------------------------------------
     Bundle 14: full-project lane cards. "Can I do a whole project here",
     answered per lane, with a named hand-off. Its own tab because it is a
     different question from any single runtime's snippet list, not a
     capability of one runtime.
     --------------------------------------------------------------- */
  function renderLanes(host) {
    var eng = engine('DataGlowProjectLanes');
    if (!eng || typeof eng.buildProjectLanes !== 'function') {
      host.appendChild(el('p', { class: 'dg-pk-note' }, 'The project lanes engine is not mounted in this build.'));
      return;
    }
    var model;
    try { model = eng.buildProjectLanes(); } catch (_e) { return; }

    host.appendChild(el('p', {}, model.headline));
    host.appendChild(el('p', { class: 'dg-pk-note' }, model.neverClaims));

    for (var i = 0; i < model.lanes.length; i++) {
      var lane = model.lanes[i];
      var card = el('div', { class: 'dg-pk-card' });
      card.appendChild(el('b', {}, lane.label + ': ' + (lane.canDoWholeProject ? 'yes, within limits' : 'partial, named limits')));
      card.appendChild(el('div', { class: 'dg-pk-note' }, 'Yes for: ' + lane.yesFor));
      card.appendChild(el('div', { class: 'dg-pk-note' }, 'Stay here when: ' + lane.stayWhen));
      card.appendChild(el('div', { class: 'dg-pk-note' }, 'Hand off when: ' + lane.handOffWhen));
      card.appendChild(el('div', { class: 'dg-pk-note' }, 'Hand off to: ' + lane.handOffTo));
      var ul = el('ul', { class: 'dg-pk-ul' });
      for (var j = 0; j < lane.limits.length; j++) ul.appendChild(el('li', {}, lane.limits[j]));
      card.appendChild(ul);
      var row = el('div', { class: 'dg-pk-row' });
      var b = el('button', { class: 'dg-pk-btn', type: 'button' }, 'Go to ' + lane.label);
      b.addEventListener('click', function (targetTab) {
        return function () { show(targetTab); };
      }(lane.id === 'excel' ? 'excel' : lane.id));
      row.appendChild(b);
      card.appendChild(row);
      host.appendChild(card);
    }
  }

  function tabs() {
    var out = [];
    if (sqlOn()) out.push({ id: 'sql', label: 'SQL' });
    if (excelOn()) out.push({ id: 'excel', label: 'Spreadsheets' });
    if (pyOn()) out.push({ id: 'python', label: 'Python' });
    if (rOn()) out.push({ id: 'r', label: 'R' });
    if (lanesOn()) out.push({ id: 'lanes', label: 'Project fit' });
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
    else if (state.tab === 'lanes') renderLanes(body);
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
    models: function () {
      var lanesEng = engine('DataGlowProjectLanes');
      var pqEng = engine('DataGlowPqParityRecipes');
      return {
        sql: sqlPack(),
        python: pyPack(),
        r: rPack(),
        lanes: lanesEng && typeof lanesEng.buildProjectLanes === 'function' ? lanesEng.buildProjectLanes() : null,
        pqParity: pqEng && typeof pqEng.buildPqParityPack === 'function' ? pqEng.buildPqParityPack() : null,
      };
    },
  };
})();
/* ---- end js/polyglot/data-glow-power-packs-canvas.js ---- */
