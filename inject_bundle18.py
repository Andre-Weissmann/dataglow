#!/usr/bin/env python3
"""Bundle 18: three new archetype Drill Floor drills (scd-as-of,
streak-islands, basket-pairs) added to the existing drill-floor-data.js /
drill-floor.js short-form-marker splice, plus a new R Air-Gap prebundle
module (js/polyglot/r-air-gap-prebundle.js) added as a tracked ENGINE.

This script is idempotent: it only touches spans it owns (marked from/end
blocks) and it never invents a brand-new marker pair in the canvas by
itself for a file that has never been spliced before -- for the two
drill-floor files (already-present short-form markers from Bundle 16) it
re-syncs in place exactly like inject_bundle16.py/17.py did; for the new
r-air-gap-prebundle.js file, this script ADDS one new full-path marker
pair (there is no existing one to re-sync), directly before the
r-power-pack.js block, and registers it in canvas/integrity.manifest.json
as a newly-tracked entry (that registration is a separate, manual step
recorded in BUNDLE18_RESULT.md; this script only writes the canvas HTML).

Files re-synced/added in place, in dependency order:

  ENGINES (ESM -> IIFE wrap, window.DataGlow* namespace), existing:
    (none changed by Bundle 18)

  ENGINES, NEW (added, not just re-synced):
    js/polyglot/r-air-gap-prebundle.js

  DRILL FLOOR (short-form markers, re-synced, three new drills added to the
  SAME DRILLS array / DrillFloorData namespace as Bundle 16's four):
    js/drill-floor/drill-floor-data.js
    js/drill-floor/drill-floor.js

Also updates the canvas's legacy inline flags object (the `drillFloor:
true,` anchor line) to add archetypeDrillsExpand and rAirGapPrebundle, the
same anchor-based, best-effort approach as inject_bundle16.py's
update_flags -- a no-op if the anchor is not found, since flags.manifest.json
is the actual source of truth checked by scripts/check-canvas-integrity.mjs
and by build-flags.js at runtime.

Run with:
    python3 inject_bundle18.py
Then verify with:
    npm run check:canvas-integrity -- --update
"""
import re
import sys
import hashlib

CANVAS = 'canvas/index.html'

# New tracked ENGINE this bundle adds (added fresh, no prior canvas splice).
NEW_ENGINES = [
    'js/polyglot/r-air-gap-prebundle.js',
]

# The existing tracked ENGINE this new module's canvas block is inserted
# directly before, so it lands in the same polyglot/R neighborhood as
# r-power-pack.js and r-deepen.js rather than at an arbitrary spot.
NEW_ENGINE_ANCHOR_BEFORE = 'js/polyglot/r-power-pack.js'

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
    """Strip ESM import/export syntax down to a plain script body.

    An `import { ... } from '...';` statement may span MULTIPLE lines (the
    drill-floor.js source wraps its import across several lines once it
    names more than a couple of symbols, as Bundle 18's does). Every line of
    such a statement must be commented out, not just its first line, or the
    bare `NAME,` continuation lines survive into the canvas as invalid
    top-level syntax. Each line gets its own `//` prefix (rather than one
    `/* ... */` wrapping the whole statement) so a later re-run of this same
    strip on already-commented output stays idempotent and so nothing here
    can accidentally nest a block comment."""
    body = re.sub(r'^export (const|function|async function|class|let) ', r'\1 ', src, flags=re.M)
    if ANY_IMPORT_RE.search(body):
        def _cmt(m):
            commented_lines = '\n'.join('// [stripped import] ' + line for line in m.group(0).rstrip('\n').split('\n'))
            return commented_lines
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


def insert_before(data, anchor_path, block):
    """Insert a brand-new marker-delimited block directly before an existing
    tracked block's `from` marker (used only for a file with no prior canvas
    splice at all, unlike splice() which re-syncs an existing one)."""
    anchor_start, _end = marks(anchor_path)
    i = data.find(anchor_start)
    if i == -1:
        sys.exit('%s: anchor block not found in canvas, cannot place new engine relative to it' % anchor_path)
    return data[:i] + block.rstrip('\n') + '\n\n' + data[i:]


def guard(block, path):
    if '</script>' in block:
        sys.exit('%s: refusing to inject, contains a literal </script>.' % path)
    if '\u2014' in block:
        sys.exit('%s: refusing to inject, contains an em dash (U+2014).' % path)
    bad = [ord(c) for c in block if ord(c) < 32 and c not in '\t\n\r']
    if bad:
        sys.exit('%s: refusing to inject, contains control characters %s.' % (path, sorted(set(bad))))


# ---------------------------------------------------------------------------
# Drill Floor: re-sync (short-form end markers), now with the three new
# Bundle 18 drills/tables riding along inside the SAME re-synced body.
# ---------------------------------------------------------------------------

# Canvas-only tail for drill-floor.js -- the real mountDrillFloor() UI,
# the primary #drillfloor-trigger-btn wiring (Bundle 17), and the
# overflow/tools-sheet button wiring. Extracted verbatim, once, from the
# existing canvas (this code has never lived in js/drill-floor/drill-floor.js;
# it is canvas-only, same convention inject_bundle16.py originally used for
# MOUNT_DRILL_FLOOR_JS). Split around the `window.DrillFloor = {...}`
# assignment so build_drill_floor_block() can add new namespace keys
# without touching a single byte of the surrounding UI code.
DRILL_FLOOR_CANVAS_TAIL_PRE_NS = """  // Bundle 16: the canvas overlay panel previously had no real mount function
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

DRILL_FLOOR_CANVAS_TAIL_POST_NS = """
  function initUI_dg_ov_drillfloor() {
    var panelId = 'dg-drillfloor-panel';
    if (!document.getElementById(panelId)) {
      var p = document.createElement('div');
      p.id = panelId;
      p.style.cssText = 'position:fixed;top:0;right:0;width:480px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:876;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(p);
    }
    function toggle() {
      var p = document.getElementById(panelId);
      if (!p) return;
      if (p.style.display === 'none' || !p.style.display) {
        p.style.display = 'block'; p.innerHTML = '';
        var cx = document.createElement('button');
        cx.textContent = '\\u00D7';
        cx.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;';
        cx.addEventListener('click', function(){ p.style.display='none'; });
        p.appendChild(cx);
        if (typeof mountDrillFloor === 'function') {
          mountDrillFloor({ host: p, onToast: function(m,t){ if(typeof showToast==='function') showToast(m,t); } });
        } else {
          var msg = document.createElement('p');
          msg.style.cssText = 'padding:20px;font-size:13px;color:var(--text-muted,#888);line-height:1.6;';
          msg.textContent = 'Drill Floor: interactive practice environment for SQL and analysis skills.';
          p.appendChild(msg);
        }
      } else { p.style.display = 'none'; }
    }
    // Bundle 17: the Drill Floor previously had NO primary, always-visible
    // entry point of its own -- it was reachable only through the overflow
    // popover / mobile tools sheet, which are both appended at runtime and
    // easy to miss next to OSCE's dedicated agent-bar button. This wires a
    // primary #drillfloor-trigger-btn (agent-bar-right, next to but visually
    // and functionally SEPARATE from #osce-trigger-btn -- different id,
    // different label "Drill" vs "OSCE", same click-to-toggle-panel pattern)
    // so Drill Floor is findable without opening the overflow grid at all.
    var primaryBtn = document.getElementById('drillfloor-trigger-btn');
    if (primaryBtn && !primaryBtn._dgWired) {
      primaryBtn._dgWired = true;
      try {
        var flagsOff = window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function'
          && window.DataGlowFlags.isEnabled('drillFloor') === false;
        if (flagsOff) primaryBtn.style.display = 'none';
      } catch (_flagErr) {}
      primaryBtn.addEventListener('click', function () {
        // Close any open OSCE panel first so the two never visually stack --
        // this is the "nav collision" fix: Drill Floor and OSCE Exam are
        // reachable independently and never fight for the same screen space.
        try {
          var osceOverlay = document.getElementById('osce-overlay') || document.getElementById('osce-screen');
          if (osceOverlay && typeof closeOSCE === 'function') closeOSCE();
        } catch (_osceErr) {}
        toggle();
      });
    }
    ['dg-overflow-grid','dg-tools-sheet-grid'].forEach(function(gridId, i) {
      var grid = document.getElementById(gridId);
      var btnId = i === 0 ? 'dg-ov-drillfloor' : 'dg-ts-drillfloor';
      if (grid && !document.getElementById(btnId)) {
        var btn = document.createElement('button');
        btn.id = btnId; btn.className = 'dg-ov-btn';
        btn.innerHTML = '🧠<br><span>Drill</span>';
        btn.addEventListener('click', function(){
          if (i === 0) { ['dg-overflow-popover','dg-overflow-overlay'].forEach(function(id){ var e=document.getElementById(id); if(e) e.classList.remove('open'); }); }
          else { var sh=document.getElementById('dg-tools-sheet'); if(sh) sh.classList.remove('open'); }
          toggle();
        });
        grid.appendChild(btn);
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI_dg_ov_drillfloor);
  else setTimeout(initUI_dg_ov_drillfloor, 1850);

}());
/* ---- end drill-floor.js ---- */"""


def build_drill_floor_data_block():
    path = 'js/drill-floor/drill-floor-data.js'
    src = read(path)
    body = strip_module(src)
    start, end = marks_short(path, 'drill-floor-data.js')
    names = [
        'DRILL_ORDERS_TABLE', 'DRILL_PROMOS_TABLE',
        'DRILL_PRICE_HISTORY_TABLE', 'DRILL_SALES_TABLE',
        'DRILL_ACTIVITY_DAYS_TABLE', 'DRILL_BASKET_LINES_TABLE',
        'generateOrders', 'generatePromos',
        'generatePriceHistory', 'generateSales',
        'generateActivityDays', 'generateBasketLines',
        'buildCreateTableSql', 'loadDrillTables',
    ]
    ns_lines = ''.join(
        "    %s: typeof %s !== 'undefined' ? %s : null,\n" % (n, n, n) for n in names
    )
    return (
        start + '\n'
        + ';(function(){\n'
        + "  'use strict';\n"
        + body.rstrip('\n') + '\n'
        + '  window.DrillFloorData = {\n'
        + ns_lines
        + '  };\n'
        + '}());\n'
        + end + '\n'
    )


def build_drill_floor_block():
    """Re-sync js/drill-floor/drill-floor.js's canvas splice. The source
    module body is re-stripped fresh (so the three new Bundle 18 drills,
    scoreDrillExtras, and scalarMatches all ride along), while the
    CANVAS-ONLY tail -- the real mountDrillFloor() UI, the primary
    #drillfloor-trigger-btn wiring (Bundle 17), and the overflow/tools-sheet
    button wiring -- is preserved BYTE-FOR-BYTE from the existing canvas
    (extracted once into the two constants below), because that UI code has
    never existed in the js/ source file at all; it is canvas-only, exactly
    like inject_bundle16.py originally hand-wrote it. Only the small
    `window.DrillFloor = {...}` namespace object sandwiched in the middle of
    that tail gets two new keys (scoreDrillExtras, scalarMatches)."""
    path = 'js/drill-floor/drill-floor.js'
    src = read(path)
    body = strip_module(src)
    start, end = marks_short(path, 'drill-floor.js')

    ns_body = (
        "    mountDrillFloor: typeof mountDrillFloor !== 'undefined' ? mountDrillFloor : null,\n"
        "    getDrill: typeof getDrill !== 'undefined' ? getDrill : null,\n"
        "    DRILLS: typeof DRILLS !== 'undefined' ? DRILLS : [],\n"
        "    scoreDrillAnswer: typeof scoreDrillAnswer !== 'undefined' ? scoreDrillAnswer : null,\n"
        "    scoreDrillExtras: typeof scoreDrillExtras !== 'undefined' ? scoreDrillExtras : null,\n"
        "    scalarMatches: typeof scalarMatches !== 'undefined' ? scalarMatches : null,\n"
        "    DRILL_BATTERY_HONESTY_NOTE: typeof DRILL_BATTERY_HONESTY_NOTE !== 'undefined' ? DRILL_BATTERY_HONESTY_NOTE : \'\',\n"
    )

    return (
        start + '\n'
        + ';(function(){\n'
        + "  'use strict';\n"
        + '  var _dfd = window.DrillFloorData || {};\n'
        + '  var DRILL_ORDERS_TABLE = _dfd.DRILL_ORDERS_TABLE;\n'
        + '  var DRILL_PROMOS_TABLE = _dfd.DRILL_PROMOS_TABLE;\n'
        + '  var DRILL_PRICE_HISTORY_TABLE = _dfd.DRILL_PRICE_HISTORY_TABLE;\n'
        + '  var DRILL_SALES_TABLE = _dfd.DRILL_SALES_TABLE;\n'
        + '  var DRILL_ACTIVITY_DAYS_TABLE = _dfd.DRILL_ACTIVITY_DAYS_TABLE;\n'
        + '  var DRILL_BASKET_LINES_TABLE = _dfd.DRILL_BASKET_LINES_TABLE;\n'
        + '  var _dd = window.DrillDiff || {};\n'
        + '  var computeDrillDiff = _dd.computeDrillDiff;\n'
        + body.rstrip('\n') + '\n'
        + DRILL_FLOOR_CANVAS_TAIL_PRE_NS
        + '  window.DrillFloor = {\n'
        + ns_body
        + '  };\n'
        + DRILL_FLOOR_CANVAS_TAIL_POST_NS.rstrip('\n') + '\n'
    )


def update_flags(data):
    """Add archetypeDrillsExpand / rAirGapPrebundle to the canvas's legacy
    inline flags object (anchor: `drillFloor: true,`), best-effort like
    inject_bundle16.py's update_flags -- a no-op if already present or if
    the anchor is missing. Checks for the actual FLAG-OBJECT LINE (`    name:
    true,`), not a bare substring match, since Bundle 18's own spliced
    module bodies mention both flag names in comments (r-air-gap-prebundle.js
    names `rAirGapPrebundle` in its own doc comment; drill-floor-data.js now
    says `Bundle 18 (archetypeDrillsExpand)`), which a plain `in data` check
    would misread as "already registered"."""
    already = ('    archetypeDrillsExpand: true,\n' in data
                and '    rAirGapPrebundle: true,\n' in data)
    if already:
        return data, False
    anchor = '    drillFloor: true,\n'
    idx = data.find(anchor)
    if idx == -1:
        return data, False
    insertion = '    archetypeDrillsExpand: true,\n    rAirGapPrebundle: true,\n'
    return data[:idx] + anchor + insertion + data[idx + len(anchor):], True


def main():
    data = read(CANVAS)
    before = len(data)

    resynced = []
    added = []
    missing = []

    # New engine: r-air-gap-prebundle.js. Added fresh (no prior splice to
    # re-sync), placed directly before the existing r-power-pack.js block.
    for path in NEW_ENGINES:
        block = build_engine_iife(path)
        guard(block, path)
        start, _end = marks(path)
        if start in data:
            # Already present (re-run of this script): re-sync in place
            # instead of inserting a second copy.
            s, e = marks(path)
            spliced = splice(data, s, e, block)
            data = spliced
            resynced.append(path)
        else:
            data = insert_before(data, NEW_ENGINE_ANCHOR_BEFORE, block)
            added.append(path)

    # Drill Floor: short-form end markers, custom builders, re-synced with
    # the three new drills riding inside the same body.
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
        sys.exit('Missing expected existing canvas blocks for: %s' % missing)

    data, flags_added = update_flags(data)

    open(CANVAS, 'w', encoding='utf-8').write(data)

    for p in added:
        print('added      %s' % p)
    for p in resynced:
        print('re-synced  %s' % p)
    print('flags block updated: %s' % flags_added)
    print('canvas %d -> %d chars (%+d)' % (before, len(data), len(data) - before))
    print('sha256(canvas) = %s' % hashlib.sha256(data.encode('utf-8')).hexdigest()[:16])


if __name__ == '__main__':
    main()
