#!/usr/bin/env python3
"""Backlog 0z3: re-sync js/polyglot/data-glow-power-packs-canvas.js's
already-inlined canvas span after the mobile shared-chip-row join fix.

Deliberately standalone rather than reusing inject_bundle16.py: that script
also regenerates several sibling spans in the same run, including a
hand-written window.DrillFloor mount body for js/drill-floor/drill-floor.js
that is NOT a faithful re-splice of the current js/ source on this repo
snapshot -- running it verbatim shrank that canvas span by roughly 10KB,
silently reverting real shipped behavior that exists only in the canvas
copy, not in the checked-in source file. This script touches only the one
file this fix actually changed, using the same from/end marker splice every
other inject_*.py in this repo relies on.

js/spine/data-glow-project-run-canvas.js (the other file this fix touched)
is re-synced by its own existing, narrow script: inject_r1_project_run.py.
That script already covers only its own two files (js/spine/project-run.js
and this canvas UI file) and was safe to re-run as-is.

Idempotent: re-running after a further source edit re-syncs the span again.

Run with:
    python3 inject_0z3_packs_resync.py
Then verify with:
    npm run check:canvas-integrity -- --update
"""
import sys

CANVAS = 'canvas/index.html'
PATH = 'js/polyglot/data-glow-power-packs-canvas.js'


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def marks(path):
    return ('/* ---- from %s ---- */' % path, '/* ---- end %s ---- */' % path)


def guard(block):
    if '</script>' in block:
        sys.exit('Refusing to inject: the block contains a literal </script>.')
    if '\u2014' in block:
        sys.exit('Refusing to inject: the block contains an em dash (U+2014).')
    bad = [ord(c) for c in block if ord(c) < 32 and c not in '\t\n\r']
    if bad:
        sys.exit('Refusing to inject: the block contains control characters %s.' % sorted(set(bad)))


def splice(data, path, block):
    start, end = marks(path)
    i = data.find(start)
    if i == -1:
        return None
    j = data.find(end, i)
    if j == -1:
        sys.exit('%s: opening marker with no closing marker in the canvas' % path)
    return data[:i] + block.rstrip('\n') + data[j + len(end):]


def main():
    data = read(CANVAS)
    before = len(data)

    block = read(PATH).rstrip('\n') + '\n'
    guard(block)
    start, _ = marks(PATH)
    if start not in block:
        sys.exit('%s: expected the file to carry its own from marker' % PATH)

    spliced = splice(data, PATH, block)
    if spliced is None:
        sys.exit('%s: not currently inlined in %s -- this script only re-syncs an existing span' % (PATH, CANVAS))

    open(CANVAS, 'w', encoding='utf-8').write(spliced)
    print('re-synced  %s' % PATH)
    print('canvas %d -> %d chars (%+d)' % (before, len(spliced), len(spliced) - before))
    print('\nNext: npm run check:canvas-integrity -- --update')


if __name__ == '__main__':
    main()
