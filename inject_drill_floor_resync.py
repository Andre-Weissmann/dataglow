#!/usr/bin/env python3
"""Drill Floor resync (NORTH_STAR 0z4): narrow, tail-preserving splice for the
two Drill Floor spans in canvas/index.html.

WHY this exists. inject_bundle16.py used to regenerate these two spans from a
hand-written template and silently regressed the live canvas (drill-floor.js
span -10KB, drill-floor-data.js span -800 bytes), because the live spans carry
hand-extended tails that no template knew about. inject_bundle16.py no longer
touches them. This script owns them instead, with a different strategy:

  span = HEAD (generated)  +  ENGINE BODY (from js/ source)  +  TAIL (live)

  * HEAD   -- `from` marker, `;(function(){`, 'use strict', and (drill-floor.js
              only) the window.DrillFloorData / window.DrillDiff local rebinds.
  * ENGINE BODY -- the checked-in js/drill-floor/*.js source with `export `
              dropped and ES `import ... ;` statements commented out.
  * TAIL   -- everything from a fixed anchor to the `end` marker is read back
              OUT OF THE CURRENT canvas and re-emitted byte for byte:
                drill-floor-data.js: the window.DrillFloorData = {...} export
                drill-floor.js: the Bundle 18 live-engine resolver, the real
                  mountDrillFloor UI, window.DrillFloor, overlay-panel wiring

Running this on an in-sync canvas is a byte-for-byte no-op. If the js/ source
changed, only the engine body moves. Exits non-zero (writing nothing) if an
anchor is missing, a marker is duplicated, or the data-file tail does not
expose every table/generator the source exports.

Usage:  python3 inject_drill_floor_resync.py [--check]
        --check  write nothing; exit 1 if the canvas would change.
"""
import re
import sys

CANVAS = 'canvas/index.html'

DATA_PATH = 'js/drill-floor/drill-floor-data.js'
DATA_END = 'drill-floor-data.js'
FLOOR_PATH = 'js/drill-floor/drill-floor.js'
FLOOR_END = 'drill-floor.js'

DATA_TAIL_ANCHOR = '  window.DrillFloorData = {'
FLOOR_TAIL_ANCHOR = '// Bundle 18 hotfix 5: shared live-engine resolver'

FLOOR_PREAMBLE = (
    "  var _dfd = window.DrillFloorData || {};\n"
    "  var DRILL_ORDERS_TABLE = _dfd.DRILL_ORDERS_TABLE;\n"
    "  var DRILL_PROMOS_TABLE = _dfd.DRILL_PROMOS_TABLE;\n"
    "  var DRILL_PRICE_HISTORY_TABLE = _dfd.DRILL_PRICE_HISTORY_TABLE;\n"
    "  var DRILL_SALES_TABLE = _dfd.DRILL_SALES_TABLE;\n"
    "  var DRILL_ACTIVITY_DAYS_TABLE = _dfd.DRILL_ACTIVITY_DAYS_TABLE;\n"
    "  var DRILL_BASKET_LINES_TABLE = _dfd.DRILL_BASKET_LINES_TABLE;\n"
    "  var _dd = window.DrillDiff || {};\n"
    "  var computeDrillDiff = _dd.computeDrillDiff;\n"
)

# An import statement plus any blank lines right after it (the live canvas
# spans have always collapsed that blank run, so the comment block sits flush
# against the next comment).
IMPORT_STMT_RE = re.compile(r"^import\b[^;]*;[ \t]*\n(?:[ \t]*\n)*", flags=re.M)


def read(p):
    return open(p, encoding='utf-8', newline='').read()


def strip_module(src):
    body = re.sub(r'^export (const|function|async function|class|let) ', r'\1 ', src, flags=re.M)

    def _cmt(m):
        lines = m.group(0).rstrip('\n').split('\n')
        return '\n'.join('// [stripped import] ' + ln for ln in lines) + '\n'


    body = IMPORT_STMT_RE.sub(_cmt, body)
    if re.search(r'^\s*(import|export)\b', body, flags=re.M):
        sys.exit('an import/export survived the rewrite; refusing to inject')
    return body


def span_bounds(data, path, end_name):
    start = '/* ---- from %s ---- */' % path
    end = '/* ---- end %s ---- */' % end_name
    if data.count(start) != 1 or data.count(end) != 1:
        sys.exit('%s: expected exactly one from/end marker pair in the canvas' % path)
    i = data.index(start)
    j = data.index(end, i) + len(end)
    return i, j, start


def live_tail(span, anchor, path, back_to_blank_rule=False):
    k = span.find(anchor)
    if k == -1 or span.count(anchor) != 1:
        sys.exit('%s: tail anchor %r not found exactly once in live span' % (path, anchor))
    if back_to_blank_rule:
        # tail begins at the blank line + `// -----` rule that precedes the anchor comment
        m = span.rfind('\n\n// ---', 0, k)
        if m == -1:
            sys.exit('%s: could not locate the start of the live tail' % path)
        return span[m + 1:]
    return span[k:]


def guard(block, path):
    if '</script>' in block:
        sys.exit('%s: refusing to inject, contains a literal </script>.' % path)


def check_data_exports(src, tail):
    names = re.findall(r'^export (?:const|function|async function) (DRILL_[A-Z_]+_TABLE|generate\w+|buildCreateTableSql|loadDrillTables)\b', src, flags=re.M)
    missing = [n for n in names if (n + ':') not in tail]
    if missing:
        sys.exit('%s exports %s which the live window.DrillFloorData tail does not expose; '
                 'update the tail in canvas/index.html by hand first' % (DATA_PATH, missing))


def rebuild(data, path, end_name, head_extra, anchor, blank_rule, check=None):
    i, j, start = span_bounds(data, path, end_name)
    span = data[i:j]
    tail = live_tail(span, anchor, path, blank_rule)
    src = read(path)
    if check:
        check(src, tail)
    body = strip_module(src)
    block = (start + '\n;(function(){\n  \'use strict\';\n' + head_extra
             + body.rstrip('\n') + '\n' + tail)
    guard(block, path)
    return data[:i] + block + data[j:], len(span), len(block)


def main():
    check_only = '--check' in sys.argv[1:]
    data = read(CANVAS)
    orig = data
    data, a0, a1 = rebuild(data, DATA_PATH, DATA_END, '', DATA_TAIL_ANCHOR, False, check_data_exports)
    data, b0, b1 = rebuild(data, FLOOR_PATH, FLOOR_END, FLOOR_PREAMBLE, FLOOR_TAIL_ANCHOR, True)
    print('%s span %d -> %d (%+d)' % (DATA_PATH, a0, a1, a1 - a0))
    print('%s span %d -> %d (%+d)' % (FLOOR_PATH, b0, b1, b1 - b0))
    if data == orig:
        print('canvas unchanged (already in sync)')
        return 0
    if check_only:
        print('canvas would change (--check, nothing written)')
        return 1
    open(CANVAS, 'w', encoding='utf-8', newline='').write(data)
    print('canvas updated: %d -> %d' % (len(orig), len(data)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
