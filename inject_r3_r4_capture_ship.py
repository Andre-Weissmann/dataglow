#!/usr/bin/env python3
"""R3/R4 Capture + Ship pack: inject four new tracked modules into
canvas/index.html.

  js/capture/capture.js
      Pure engine (fixed step list, filename building, capture record shape,
      in-memory list model). Exports `export const DataGlowCapture = { ... }`,
      wrapped in an IIFE and published as `window.DataGlowCapture`, same
      convention `build_engine_iife()` uses in inject_a49_question_scout.py.

  js/capture/data-glow-capture-canvas.js
      Canvas UI (Capture step button, panel, html2canvas/native/canvas-draw
      fallback, IndexedDB persistence, per-capture download). Already a
      self-contained IIFE, inlined verbatim.

  js/ship-pack/ship-pack.js
      Pure engine (keepers.json/claims.json/validation_summary.json/
      honest_claims.md builders + buildShipPack()/serializeShipPackFiles()).
      Exports `export const DataGlowShipPackEngine = { ... }`, wrapped the
      same way as the capture engine above.

  js/ship-pack/data-glow-ship-pack-canvas.js
      Canvas UI (Export ship pack button, gathers live Scout/Proof
      Harness/validation/capture inputs, ZIP-or-multi-download, publishes
      window.DataGlowShipPack.export()). Already a self-contained IIFE,
      inlined verbatim.

All four blocks are inserted directly after the Question Scout canvas
module's end marker (the last tracked module in canvas/index.html today),
so R3/R4 sit right after the module that feeds keepers.json.

Idempotent: re-running this script re-syncs all four blocks in place rather
than duplicating them.

Run with:
    python3 inject_r3_r4_capture_ship.py
Then verify with:
    npm run check:canvas-integrity -- --update
"""
import re
import sys

CANVAS = 'canvas/index.html'

ENGINE_SPECS = [
    ('js/capture/capture.js', 'DataGlowCapture'),
    ('js/ship-pack/ship-pack.js', 'DataGlowShipPackEngine'),
]
CANVAS_UI_PATHS = [
    'js/capture/data-glow-capture-canvas.js',
    'js/ship-pack/data-glow-ship-pack-canvas.js',
]

ANCHOR_END_MARKER = '/* ---- end js/question-scout/data-glow-question-scout-canvas.js ---- */'

IMPORT_RE = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*'([^']+)';\s*$", flags=re.M | re.S)
ANY_IMPORT_RE = re.compile(r'^\s*import\b', flags=re.M)


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def marks(path):
    return ('/* ---- from %s ---- */' % path, '/* ---- end %s ---- */' % path)


def namespace_keys(src, ns_name, path):
    _head, sep, tail = src.partition('export const %s = {' % ns_name)
    if not sep:
        sys.exit('%s: namespace `export const %s` not found' % (path, ns_name))
    body = tail.split('};')[0]
    keys = re.findall(r'^\s{2}([A-Za-z_$][\w$]*),?\s*$', body, flags=re.M)
    keys = [k for k in keys if k]
    if not keys:
        sys.exit('%s: no keys found in namespace %s' % (path, ns_name))
    return keys


def build_engine_iife(path, ns_name):
    src = read(path)
    keys = namespace_keys(src, ns_name, path)
    head = src.partition('export const %s = {' % ns_name)[0]

    # Strip a trailing "export default X;" line if present before this point
    # (both engine files place their namespace export before any default
    # export, so `head` should not contain one, but guard anyway).
    head = re.sub(r'^export default [A-Za-z_$][\w$]*;\s*$', '', head, flags=re.M)

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
        + "  try { if (typeof module !== 'undefined') {} } catch (_e) {}\n"
        + '})();\n'
        + end + '\n'
    )


# A real ES module export statement starts a line with `export` followed by
# a keyword/brace (const/function/class/let/var/default/{ ...). This is
# deliberately narrower than a bare `^\s*export\b` because these canvas UI
# files are plain top-level IIFEs that legitimately contain prose comment
# lines beginning with the word "export)" and object-literal properties named
# `export:` (e.g. `window.DataGlowShipPack = { export: runExport }`), neither
# of which is an ESM export and neither of which this script needs to reject.
REAL_EXPORT_STATEMENT_RE = re.compile(r'^\s*export\s+(const|function|async function|class|let|var|default|\{)', flags=re.M)


def build_canvas_ui_block(path):
    """Canvas UI files here are already self-contained top-level IIFEs (no
    ESM import/export), so they are inlined verbatim between markers."""
    src = read(path)
    if ANY_IMPORT_RE.search(src) or REAL_EXPORT_STATEMENT_RE.search(src):
        sys.exit('%s: expected a plain IIFE with no import/export, found one' % path)
    start, end = marks(path)
    return start + '\n' + src.rstrip('\n') + '\n' + end + '\n'


def splice_or_insert(data, path, block, anchor_marker):
    start, end = marks(path)
    i = data.find(start)
    if i != -1:
        j = data.find(end, i)
        if j == -1:
            sys.exit('%s: opening marker with no closing marker in the canvas' % start)
        return data[:i] + block.rstrip('\n') + '\n' + data[j + len(end):]
    anchor_i = data.find(anchor_marker)
    if anchor_i == -1:
        sys.exit('anchor marker not found: %s' % anchor_marker)
    insert_at = anchor_i + len(anchor_marker)
    return data[:insert_at] + '\n' + block.rstrip('\n') + '\n' + data[insert_at:]


def guard(block, path):
    if '</script>' in block:
        sys.exit('%s: refusing to inject, contains a literal </script>.' % path)
    bad = [ord(c) for c in block if ord(c) < 32 and c not in '\t\n\r']
    if bad:
        sys.exit('%s: refusing to inject, contains control characters %s.' % (path, sorted(set(bad))))
    if '\u2014' in block:
        sys.exit('%s: refusing to inject, contains an em dash (U+2014). No em dash in visible UI.' % path)


def main():
    data = read(CANVAS)
    anchor = ANCHOR_END_MARKER

    for path, ns_name in ENGINE_SPECS:
        block = build_engine_iife(path, ns_name)
        guard(block, path)
        data = splice_or_insert(data, path, block, anchor)
        start, end = marks(path)
        pos = data.find(end)
        anchor = end  # chain: next block goes after this one

    for path in CANVAS_UI_PATHS:
        block = build_canvas_ui_block(path)
        guard(block, path)
        data = splice_or_insert(data, path, block, anchor)
        start, end = marks(path)
        anchor = end

    with open(CANVAS, 'w', encoding='utf-8') as f:
        f.write(data)

    print('Injected/re-synced:')
    for path, _ in ENGINE_SPECS:
        print('  ' + path)
    for path in CANVAS_UI_PATHS:
        print('  ' + path)


if __name__ == '__main__':
    main()
