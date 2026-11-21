#!/usr/bin/env python3
"""Bundle 16: Repair Ledger wiring residuals (load, quarantine_decision,
excel_hell_apply, python_recipe, r_recipe, export) via the new shared
ledgerAppendFromSurface helper, plus the original RECEIPT drill battery
(three new drills + goldenAnswers + scoreDrillAnswer on top of the existing
Spot the Sale drill).

This script is idempotent: it only touches spans it owns (full-path
`from <path>` / `end <path>` marked blocks: js/spine/repair-ledger.js and
the four other Part A files).

Files re-synced in place, in dependency order:

  ENGINES (ESM -> IIFE wrap, window.DataGlow* namespace):
    js/spine/repair-ledger.js

  UIS (already-IIFE canvas files, spliced verbatim):
    js/spine/data-glow-repair-ledger-canvas.js
    js/dataquality/data-glow-csv-quarantine-canvas.js
    js/intelligence/data-glow-excel-hell-canvas.js
    js/polyglot/data-glow-power-packs-canvas.js

  NOT owned by this script (since 0z4): js/drill-floor/drill-floor-data.js
  and js/drill-floor/drill-floor.js. Their canvas spans carry hand-extended
  tails (window.DrillFloorData table list, the Bundle 18 live-engine resolver,
  the real mountDrillFloor UI, window.DrillFloor) that a regenerated
  template silently regressed (-10.8KB). They are re-synced, tail preserved
  verbatim, by inject_drill_floor_resync.py instead.

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
