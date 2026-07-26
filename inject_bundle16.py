#!/usr/bin/env python3
"""Bundle 16: Repair Ledger wiring residuals (load, quarantine_decision,
excel_hell_apply, python_recipe, r_recipe, export) via the new shared
ledgerAppendFromSurface helper, plus the original RECEIPT drill battery
(three new drills + goldenAnswers + scoreDrillAnswer on top of the existing
Spot the Sale drill).

This script is idempotent: it only touches spans it owns (marked from/end
blocks). Two different marker conventions exist in this canvas already and
both are respected as-is (never rewritten):

  * full-path markers  -- `from <path>` / `end <path>`
    (js/spine/repair-ledger.js and the four other Part A files)
  * short-form markers -- `from <path>` / `end <basename>`
    (js/drill-floor/drill-floor-data.js, drill-floor.js -- a legacy
    convention from an earlier hand-splice; drill-diff.js is untouched by
    Bundle 16 so it is left alone)

Files re-synced in place, in dependency order:

  ENGINES (ESM -> IIFE wrap, window.DataGlow* namespace):
    js/spine/repair-ledger.js

  UIS (already-IIFE canvas files, spliced verbatim):
    js/spine/data-glow-repair-ledger-canvas.js
    js/dataquality/data-glow-csv-quarantine-canvas.js
    js/intelligence/data-glow-excel-hell-canvas.js
    js/polyglot/data-glow-power-packs-canvas.js

  DRILL FLOOR (short-form markers, custom splice -- drill-floor-data.js is
  an ENGINE re-wrap; drill-floor.js is an ENGINE re-wrap too, but its canvas
  copy ALSO owns the window.DrillFloor assignment and the overlay-panel
  mount code, which this script regenerates with a REAL mountDrillFloor
  function body (canvas previously had none -- the overlay silently fell
  back to placeholder text) plus the Check-answer / golden-answer / RECEIPT
  UI parity with main.js's tab:
    js/drill-floor/drill-floor-data.js
    js/drill-floor/drill-floor.js

Also updates the canvas flags object (adds repairLedgerWiring,
receiptDrillBattery) if not already present.
"""
import re
import sys
import hashlib

CANVAS = 'canvas/index.html'

ENGINES = [
    'js/spine/repair-ledger.js',
]

UIS = [
    'js/spine/data-glow-repair-ledger-canvas.js',
    'js/dataquality/data-glow-csv-quarantine-canvas.js',
    'js/intelligence/data-glow-excel-hell-canvas.js',
    'js/polyglot/data-glow-power-packs-canvas.js',
]

IMPORT_RE = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*'([^']+)';\s*$", flags=re.M | re.S)
ANY_IMPORT_RE = re.compile(r'^\s*import\b', flags=re.M)


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def marks(path):
    return ('/* ---- from %s ---- */' % path, '/* ---- end %s ---- */' % path)


def marks_short(path, end_name):
    return ('/* ---- from %s ---- */' % path, '/* ---- end %s ---- */' % end_name)


def namespace_keys(src, ns_name, path):
    _head, sep, tail = src.partition('export const %s = {' % ns_name)
    if not sep:
        sys.exit('%s: namespace `export const %s` not found' % (path, ns_name))
    keys = re.findall(r'^\s{2}([A-Za-z_$][\w$]*),\s*$', tail.split('};')[0], flags=re.M)
    if not keys:
        sys.exit('%s: could not read the namespace key list' % path)
    return keys


def guess_ns(path):
    src = read(path)
    m = re.search(r'export const (DataGlow[A-Za-z0-9]+) = \{', src)
    if not m:
        sys.exit('%s: could not find its window namespace export' % path)
    return m.group(1)


def strip_module(src):
    """Strip ESM import/export syntax down to a plain script body. Leaves
    `export const NAME = {` sites alone if any survive -- callers that need
    the namespace object read it back out with namespace_keys() before this
    runs, so those lines get de-exported the same as anything else."""
    body = re.sub(r'^export (const|function|async function|class|let) ', r'\1 ', src, flags=re.M)
    if ANY_IMPORT_RE.search(body):
        # comment out simple `import { a, b } from './x.js';` lines -- this
        # canvas only ever imports sibling pure modules already spliced above
        # (their symbols are read off window.* and re-bound to locals by the
        # caller-supplied preamble instead).
        def _cmt(m):
            return '// [stripped import] ' + m.group(0).rstrip('\n')
        body = re.sub(r'^import\s.*?;\s*$', _cmt, body, flags=re.M | re.S)
    return body


def build_engine_iife(path):
    ns_name = guess_ns(path)
    src = read(path)
    keys = namespace_keys(src, ns_name, path)
    head = src.partition('export const %s = {' % ns_name)[0]

    if IMPORT_RE.search(head):
        sys.exit('%s: has an import this script does not know how to rewrite' % path)

    body = re.sub(r'^export (const|function|async function|class|let) ', r'\1 ', head, flags=re.M)
    if ANY_IMPORT_RE.search(body) or re.search(r'^\s*export\b', body, flags=re.M):
        sys.exit('%s: an export or import survived the rewrite' % path)

    start, end = marks(path)
    return (
        start + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + body.rstrip('\n') + '\n'
        + '  window.%s = {\n' % ns_name
        + ''.join('    %s: %s,\n' % (k, k) for k in keys)
        + '  };\n'
        + '})();\n'
        + end + '\n'
    )


def splice(data, start, end, block):
    i = data.find(start)
    if i == -1:
        return None
    j = data.find(end, i)
    if j == -1:
        sys.exit('%s: opening marker with no closing marker in the canvas' % start)
    return data[:i] + block.rstrip('\n') + data[j + len(end):]


def guard(block, path):
    if '</script>' in block:
        sys.exit('%s: refusing to inject, contains a literal </script>.' % path)
    if '\u2014' in block:
        sys.exit('%s: refusing to inject, contains an em dash (U+2014).' % path)
    bad = [ord(c) for c in block if ord(c) < 32 and c not in '\t\n\r']
    if bad:
        sys.exit('%s: refusing to inject, contains control characters %s.' % (path, sorted(set(bad))))


# ---------------------------------------------------------------------------
# Drill Floor: custom splice (short-form end markers; drill-floor.js also
# regenerates the overlay panel's mount wiring with a REAL mountDrillFloor).
# ---------------------------------------------------------------------------

def build_drill_floor_data_block():
    path = 'js/drill-floor/drill-floor-data.js'
    src = read(path)
    body = strip_module(src)
    start, end = marks_short(path, 'drill-floor-data.js')
    return (
        start + '\n'
        + ';(function(){\n'
        + "  'use strict';\n"
        + body.rstrip('\n') + '\n'
        + '  window.DrillFloorData = {\n'
        + '    DRILL_ORDERS_TABLE: typeof DRILL_ORDERS_TABLE !== \'undefined\' ? DRILL_ORDERS_TABLE : null,\n'
        + '    DRILL_PROMOS_TABLE: typeof DRILL_PROMOS_TABLE !== \'undefined\' ? DRILL_PROMOS_TABLE : null,\n'
        + '    generateOrders: typeof generateOrders !== \'undefined\' ? generateOrders : null,\n'
        + '    generatePromos: typeof generatePromos !== \'undefined\' ? generatePromos : null,\n'
        + '    buildCreateTableSql: typeof buildCreateTableSql !== \'undefined\' ? buildCreateTableSql : null,\n'
        + '    loadDrillTables: typeof loadDrillTables !== \'undefined\' ? loadDrillTables : null,\n'
        + '  };\n'
        + '}());\n'
        + end + '\n'
    )


# The real mountDrillFloor() browser UI, spliced in verbatim as part of the
# drill-floor.js block's IIFE tail. Deliberately mirrors main.js's
# renderDrillFloorTab (picker, honesty note, excel note, three run panes,
# Check-answer buttons, RECEIPT export) rather than inventing a second UI
# shape -- built fresh into an arbitrary host node instead of a fixed tab id
# since the overlay panel is a floating side panel, not a tab.
MOUNT_DRILL_FLOOR_JS = r"""
  // Bundle 16: the canvas overlay panel previously had no real mount function
  // (this evaluated to `typeof mountDrillFloor === 'undefined'`, so opening
  // the Drill overlay button only ever showed a static placeholder sentence).
  // mountDrillFloor(opts) builds the SAME drill battery main.js's Drill Floor
  // TAB shows -- picker, honesty note, excel note, three runnable panes, a
  // Check-answer button per language scored against goldenAnswers, and a
  // small RECEIPT line on each check -- into an arbitrary host node so it
  // works equally as a floating panel here or a tab body in main.js.
  function mountDrillFloor(opts) {
    opts = opts || {};
    var host = opts.host;
    if (!host || typeof document === 'undefined') return;
    var onToast = typeof opts.onToast === 'function' ? opts.onToast : function () {};

    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    var flags = window.DataGlowFlags || null;
    var battleOn = true;
    try {
      if (flags && typeof flags.isEnabled === 'function') battleOn = flags.isEnabled('receiptDrillBattery');
    } catch (_e) {}

    var drills = (DRILLS && DRILLS.length) ? DRILLS : [];
    if (!drills.length) {
      host.innerHTML = '<p style="padding:20px;color:var(--text-muted,#888);">Drill Floor: no drills registered.</p>';
      return;
    }
    var activeId = drills[0].id;

    function getActive() {
      var d = null;
      for (var i = 0; i < drills.length; i++) { if (drills[i].id === activeId) { d = drills[i]; break; } }
      return d || drills[0];
    }

    var drillResults = { sql: null, python: null, r: null };

    function render() {
      var drill = getActive();
      var picker = (battleOn && drills.length > 1)
        ? '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">' +
          drills.map(function (d) {
            var active = d.id === drill.id;
            return '<button type="button" data-drill-id="' + escapeHtml(d.id) + '" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border,#ddd);background:' +
              (active ? 'var(--accent,#3b6ef6)' : 'transparent') + ';color:' + (active ? '#fff' : 'inherit') + ';cursor:pointer;font-size:12px;">' +
              escapeHtml(d.title) + '</button>';
          }).join('') + '</div>'
        : '';
      var honesty = battleOn
        ? '<p style="font-size:12px;color:var(--text-muted,#888);margin:4px 0 8px;">' + escapeHtml(DRILL_BATTERY_HONESTY_NOTE) + '</p>'
        : '';
      var excelNote = (battleOn && drill.excelNote)
        ? '<p style="font-size:12px;color:var(--text-muted,#888);margin:0 0 10px;">' + escapeHtml(drill.excelNote) + '</p>'
        : '';

      function pane(lang, label, taId, btnId, outId) {
        var code = lang === 'sql' ? drill.starterSql : lang === 'python' ? drill.starterPython : drill.starterR;
        return '<div style="margin-bottom:14px;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">' +
          '<strong style="font-size:13px;">' + escapeHtml(label) + '</strong>' +
          '<button type="button" id="' + btnId + '" style="padding:3px 10px;border-radius:6px;border:1px solid var(--border,#ddd);background:var(--accent,#3b6ef6);color:#fff;cursor:pointer;font-size:12px;">Run</button>' +
          '</div>' +
          '<textarea id="' + taId + '" spellcheck="false" style="width:100%;min-height:110px;font-family:monospace;font-size:12px;box-sizing:border-box;">' + escapeHtml(code) + '</textarea>' +
          '<div id="' + outId + '" style="min-height:30px;font-size:12px;margin-top:4px;"><span style="color:var(--text-muted,#888);">(not run yet)</span></div>' +
          (battleOn ? '<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">' +
            '<button type="button" id="' + btnId + '-check" style="padding:3px 10px;border-radius:6px;border:1px solid var(--border,#ddd);background:transparent;cursor:pointer;font-size:12px;">Check answer</button>' +
            '<span id="' + outId + '-check-status" style="font-size:12px;color:var(--text-muted,#888);"></span>' +
            '</div>' : '') +
          '</div>';
      }

      host.innerHTML =
        '<div style="padding:16px 20px 24px;">' +
        '<h3 style="margin:0 0 4px;font-size:15px;">' + escapeHtml(drill.title) +
        ' <span style="font-size:11px;font-weight:normal;color:var(--text-muted,#888);">(' + escapeHtml(drill.difficulty) + ')</span></h3>' +
        '<p style="font-size:12px;color:var(--text-muted,#888);margin:0 0 8px;">' + escapeHtml(drill.description) + '</p>' +
        honesty + excelNote + picker +
        pane('sql', 'SQL', 'dg-drill-sql-in', 'dg-drill-sql-run', 'dg-drill-sql-out') +
        pane('python', 'Python', 'dg-drill-py-in', 'dg-drill-py-run', 'dg-drill-py-out') +
        pane('r', 'R', 'dg-drill-r-in', 'dg-drill-r-run', 'dg-drill-r-out') +
        '<div id="dg-drill-comparison" style="font-size:12px;color:var(--text-muted,#888);"></div>' +
        '</div>';

      if (picker) {
        var btns = host.querySelectorAll('[data-drill-id]');
        for (var bi = 0; bi < btns.length; bi++) {
          btns[bi].addEventListener('click', (function (btn) {
            return function () {
              var id = btn.getAttribute('data-drill-id');
              if (id && id !== activeId) { activeId = id; drillResults.sql = null; drillResults.python = null; drillResults.r = null; render(); }
            };
          })(btns[bi]));
        }
      }

      function renderOut(outId, res) {
        var out = document.getElementById(outId);
        if (!out) return;
        var html = '';
        var rc = (typeof extractRowCount === 'function') ? extractRowCount(res && res.result !== undefined ? res.result : res) : null;
        if (typeof rc === 'number') html += '<div><strong>' + rc + '</strong> row(s)</div>';
        if (res && res.stdout) html += '<div>' + escapeHtml(res.stdout) + '</div>';
        if (res && typeof res.result === 'string' && res.result !== '') html += '<div>' + escapeHtml(res.result) + '</div>';
        if (res && res.error) html += '<div style="color:#cf222e;">' + escapeHtml(res.error) + '</div>';
        if (!html) html = '<span style="color:var(--text-muted,#888);">(no output)</span>';
        out.innerHTML = html;
      }

      function recordDrillReceipt(score) {
        try {
          var engineLabel = score.engine === 'sql' ? 'SQL' : score.engine === 'python' ? 'Python' : score.engine === 'r' ? 'R' : String(score.engine);
          var verdict = score.pass ? 'PASS' : 'FAIL';
          var numbers = (score.expected !== null && score.expected !== undefined)
            ? ('expected ' + score.expected + ', got ' + (score.got === null || score.got === undefined ? 'unknown' : score.got))
            : (score.error || 'no comparable result');
          var line = 'Drill "' + score.drillId + '" (' + engineLabel + '): ' + verdict + ' - ' + numbers;
          var t = window.DataGlowTrustLedger;
          if (t && typeof t.record === 'function') t.record({ line: line, drillId: score.drillId, engine: score.engine, pass: score.pass });
          try { console.log('[drill receipt] ' + line); } catch (_e0) {}
          var ui = window.DataGlowRepairLedgerUI;
          if (ui && typeof ui.appendFromSurface === 'function') {
            var kind = score.engine === 'python' ? 'python_recipe' : score.engine === 'r' ? 'r_recipe' : 'sql_recipe_run';
            ui.appendFromSurface(kind, {
              engine: score.engine === 'sql' ? 'sql' : score.engine,
              title: 'Drill check: ' + score.drillId,
              summary: line,
              status: score.pass ? 'applied' : 'failed',
            });
          }
        } catch (_e) {}
      }

      function wireRun(lang, btnId, inId, outId) {
        var btn = document.getElementById(btnId);
        if (!btn) return;
        btn.addEventListener('click', function () {
          var out = document.getElementById(outId);
          if (out) out.innerHTML = '<span style="color:var(--text-muted,#888);">Running...</span>';
          var code = document.getElementById(inId).value;
          var p;
          if (lang === 'sql') {
            var runQuery = (window.engine && window.engine.runQuery) || (window.DuckDBEngine && window.DuckDBEngine.runQuery) || null;
            p = runQuery ? runDrillSql(code, { runQuery: runQuery }) : Promise.resolve({ error: 'SQL engine not ready in this canvas.' });
          } else if (lang === 'python') {
            var runPython = window.dgRunPython || (window.pyRuntime && window.pyRuntime.runPython) || null;
            p = runPython ? runDrillPython(code, { runPython: runPython }) : Promise.resolve({ error: 'Python runtime not ready in this canvas.' });
          } else {
            var runR = window.dgRunR || (window.rRuntime && window.rRuntime.runR) || null;
            p = runR ? runDrillR(code, { runR: runR }) : Promise.resolve({ error: 'R runtime not ready in this canvas.' });
          }
          p.then(function (res) {
            renderOut(outId, res);
            drillResults[lang] = res;
          });
        });
      }
      wireRun('sql', 'dg-drill-sql-run', 'dg-drill-sql-in', 'dg-drill-sql-out');
      wireRun('python', 'dg-drill-py-run', 'dg-drill-py-in', 'dg-drill-py-out');
      wireRun('r', 'dg-drill-r-run', 'dg-drill-r-in', 'dg-drill-r-out');

      if (battleOn) {
        function wireCheck(lang, btnId, outId) {
          var btn = document.getElementById(btnId + '-check');
          if (!btn) return;
          btn.addEventListener('click', function () {
            var statusEl = document.getElementById(outId + '-check-status');
            var latest = drillResults[lang];
            if (!latest) {
              if (statusEl) statusEl.textContent = 'Run this language first.';
              return;
            }
            var score = scoreDrillAnswer(getActive().id, lang, latest);
            if (statusEl) {
              statusEl.textContent = score.pass
                ? ('Pass - ' + score.got + ' row(s), matches the golden answer.')
                : ('Not yet - expected ' + (score.expected === null ? 'n/a' : score.expected) + ', got ' + (score.got === null ? 'unknown' : score.got) + (score.error ? ' (' + score.error + ')' : ''));
              statusEl.style.color = score.pass ? '#1a7f37' : '#cf222e';
            }
            recordDrillReceipt(score);
          });
        }
        wireCheck('sql', 'dg-drill-sql-run', 'dg-drill-sql-out');
        wireCheck('python', 'dg-drill-py-run', 'dg-drill-py-out');
        wireCheck('r', 'dg-drill-r-run', 'dg-drill-r-out');
      }
    }

    render();
    onToast('Drill Floor ready.', 'info');
  }
"""


def build_drill_floor_block():
    path = 'js/drill-floor/drill-floor.js'
    src = read(path)
    body = strip_module(src)
    start, end = marks_short(path, 'drill-floor.js')
    return (
        start + '\n'
        + ';(function(){\n'
        + "  'use strict';\n"
        + '  var _dfd = window.DrillFloorData || {};\n'
        + '  var DRILL_ORDERS_TABLE = _dfd.DRILL_ORDERS_TABLE;\n'
        + '  var DRILL_PROMOS_TABLE = _dfd.DRILL_PROMOS_TABLE;\n'
        + '  var _dd = window.DrillDiff || {};\n'
        + '  var computeDrillDiff = _dd.computeDrillDiff;\n'
        + body.rstrip('\n') + '\n'
        + MOUNT_DRILL_FLOOR_JS.rstrip('\n') + '\n'
        + '  window.DrillFloor = {\n'
        + '    mountDrillFloor: typeof mountDrillFloor !== \'undefined\' ? mountDrillFloor : null,\n'
        + '    getDrill: typeof getDrill !== \'undefined\' ? getDrill : null,\n'
        + '    DRILLS: typeof DRILLS !== \'undefined\' ? DRILLS : [],\n'
        + '    scoreDrillAnswer: typeof scoreDrillAnswer !== \'undefined\' ? scoreDrillAnswer : null,\n'
        + '    DRILL_BATTERY_HONESTY_NOTE: typeof DRILL_BATTERY_HONESTY_NOTE !== \'undefined\' ? DRILL_BATTERY_HONESTY_NOTE : \'\',\n'
        + '  };\n'
        + '\n'
        + "  function initUI_dg_ov_drillfloor() {\n"
        + "    var panelId = 'dg-drillfloor-panel';\n"
        + "    if (!document.getElementById(panelId)) {\n"
        + "      var p = document.createElement('div');\n"
        + "      p.id = panelId;\n"
        + "      p.style.cssText = 'position:fixed;top:0;right:0;width:480px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:876;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';\n"
        + "      document.body.appendChild(p);\n"
        + "    }\n"
        + "    function toggle() {\n"
        + "      var p = document.getElementById(panelId);\n"
        + "      if (!p) return;\n"
        + "      if (p.style.display === 'none' || !p.style.display) {\n"
        + "        p.style.display = 'block'; p.innerHTML = '';\n"
        + "        var cx = document.createElement('button');\n"
        + "        cx.textContent = '\\u00D7';\n"
        + "        cx.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;';\n"
        + "        cx.addEventListener('click', function(){ p.style.display='none'; });\n"
        + "        p.appendChild(cx);\n"
        + "        if (typeof mountDrillFloor === 'function') {\n"
        + "          mountDrillFloor({ host: p, onToast: function(m,t){ if(typeof showToast==='function') showToast(m,t); } });\n"
        + "        } else {\n"
        + "          var msg = document.createElement('p');\n"
        + "          msg.style.cssText = 'padding:20px;font-size:13px;color:var(--text-muted,#888);line-height:1.6;';\n"
        + "          msg.textContent = 'Drill Floor: interactive practice environment for SQL and analysis skills.';\n"
        + "          p.appendChild(msg);\n"
        + "        }\n"
        + "      } else { p.style.display = 'none'; }\n"
        + "    }\n"
        + "    ['dg-overflow-grid','dg-tools-sheet-grid'].forEach(function(gridId, i) {\n"
        + "      var grid = document.getElementById(gridId);\n"
        + "      var btnId = i === 0 ? 'dg-ov-drillfloor' : 'dg-ts-drillfloor';\n"
        + "      if (grid && !document.getElementById(btnId)) {\n"
        + "        var btn = document.createElement('button');\n"
        + "        btn.id = btnId; btn.className = 'dg-ov-btn';\n"
        + "        btn.innerHTML = '\U0001f9e0<br><span>Drill</span>';\n"
        + "        btn.addEventListener('click', function(){\n"
        + "          if (i === 0) { ['dg-overflow-popover','dg-overflow-overlay'].forEach(function(id){ var e=document.getElementById(id); if(e) e.classList.remove('open'); }); }\n"
        + "          else { var sh=document.getElementById('dg-tools-sheet'); if(sh) sh.classList.remove('open'); }\n"
        + "          toggle();\n"
        + "        });\n"
        + "        grid.appendChild(btn);\n"
        + "      }\n"
        + "    });\n"
        + "  }\n"
        + "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI_dg_ov_drillfloor);\n"
        + "  else setTimeout(initUI_dg_ov_drillfloor, 1850);\n"
        + '\n'
        + '}());\n'
        + end + '\n'
    )


def update_flags(data):
    """Add repairLedgerWiring / receiptDrillBattery to the canvas's inline
    flags object (the `drillFloor: true,` anchor line already present, per
    the sprint6-era flags block) if not already present. Best-effort: if the
    exact anchor is not found (canvas flags may already be sourced from
    flags.manifest.json in a later batch), this is a no-op rather than a
    hard failure -- runtime isEnabled() checks in the spliced JS above
    already default sensibly."""
    if 'repairLedgerWiring' in data and 'receiptDrillBattery' in data:
        return data, False
    anchor = '    drillFloor: true,\n'
    idx = data.find(anchor)
    if idx == -1:
        return data, False
    insertion = '    repairLedgerWiring: true,\n    receiptDrillBattery: true,\n'
    return data[:idx] + anchor + insertion + data[idx + len(anchor):], True


def main():
    data = read(CANVAS)
    before = len(data)

    resynced = []
    missing = []

    for path in ENGINES:
        block = build_engine_iife(path)
        guard(block, path)
        start, end = marks(path)
        spliced = splice(data, start, end, block)
        if spliced is None:
            missing.append(path)
        else:
            data = spliced
            resynced.append(path)

    for path in UIS:
        block = read(path).rstrip('\n') + '\n'
        guard(block, path)
        start, end = marks(path)
        if start not in block:
            sys.exit('%s: expected the file to carry its own from marker' % path)
        spliced = splice(data, start, end, block)
        if spliced is None:
            missing.append(path)
        else:
            data = spliced
            resynced.append(path)

    # Drill Floor: short-form end markers, custom builders.
    df_data_path = 'js/drill-floor/drill-floor-data.js'
    df_data_block = build_drill_floor_data_block()
    guard(df_data_block, df_data_path)
    s, e = marks_short(df_data_path, 'drill-floor-data.js')
    spliced = splice(data, s, e, df_data_block)
    if spliced is None:
        missing.append(df_data_path)
    else:
        data = spliced
        resynced.append(df_data_path)

    df_path = 'js/drill-floor/drill-floor.js'
    df_block = build_drill_floor_block()
    guard(df_block, df_path)
    s, e = marks_short(df_path, 'drill-floor.js')
    spliced = splice(data, s, e, df_block)
    if spliced is None:
        missing.append(df_path)
    else:
        data = spliced
        resynced.append(df_path)

    if missing:
        sys.exit('Missing expected existing canvas blocks for: %s (Bundle 16 only re-syncs existing splices, it does not add new ones)' % missing)

    data, flags_added = update_flags(data)

    open(CANVAS, 'w', encoding='utf-8').write(data)

    for p in resynced:
        print('re-synced  %s' % p)
    print('flags block updated: %s' % flags_added)
    print('canvas %d -> %d chars (%+d)' % (before, len(data), len(data) - before))
    print('sha256(canvas) = %s' % hashlib.sha256(data.encode('utf-8')).hexdigest()[:16])


if __name__ == '__main__':
    main()
