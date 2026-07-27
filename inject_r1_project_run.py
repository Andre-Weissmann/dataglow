#!/usr/bin/env python3
"""R1 Project Run: inject two new tracked modules into canvas/index.html.

  js/spine/project-run.js
      Pure engine (seven-step model: Ingest, Purpose, Validate, Scout,
      Prove, Narrate, Export; auto-advance from observed facts; manual
      `blocked` override; dataset-name-hash storage keying). Exports
      `export const DataGlowProjectRun = { ... }` -- wrapped in an IIFE and
      published as `window.DataGlowProjectRun`, same convention
      `build_engine_iife()` uses in inject_a49_question_scout.py.

  js/spine/data-glow-project-run-canvas.js
      Canvas UI (right-side drawer, checklist, per-dataset localStorage
      persistence, entry points: claims the previously-dead global
      `openProjects()` the bottom nav's Projects tab already calls, plus a
      floating reopen chip). Already a self-contained IIFE (matches the
      RECEIPT spine canvas module's own convention) -- inlined verbatim, no
      rewriting needed.

Both blocks are inserted directly after the RECEIPT spine canvas module's end
marker (`/* ---- end js/spine/data-glow-receipt-spine-canvas.js ---- */`), so
Project Run sits right next to the sibling spine module it deliberately does
NOT replace or import, in canvas/index.html's module order.

Idempotent: re-running this script re-syncs both blocks in place rather than
duplicating them.

Run with:
    python3 inject_r1_project_run.py
Then verify with:
    npm run check:canvas-integrity -- --update
"""
import re
import sys

CANVAS = 'canvas/index.html'

ENGINE_PATH = 'js/spine/project-run.js'
CANVAS_UI_PATH = 'js/spine/data-glow-project-run-canvas.js'

ANCHOR_END_MARKER = '/* ---- end js/spine/data-glow-receipt-spine-canvas.js ---- */'

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
    keys = re.findall(r'^\s{2}([A-Za-z_$][\w$]*),\s*$', body, flags=re.M)
    if not keys:
        sys.exit('%s: no keys found in namespace %s' % (path, ns_name))
    return keys


def build_engine_iife(path, ns_name):
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
        + "  try { if (typeof module !== 'undefined') {} } catch (_e) {}\n"
        + '})();\n'
        + end + '\n'
    )


def build_canvas_ui_block(path):
    """The canvas UI file is already a self-contained top-level IIFE (no ESM
    import/export at all), so it is inlined verbatim between markers, exactly
    like js/spine/data-glow-receipt-spine-canvas.js was."""
    src = read(path)
    if ANY_IMPORT_RE.search(src) or re.search(r'^\s*export\b', src, flags=re.M):
        sys.exit('%s: expected a plain IIFE with no import/export, found one' % path)
    start, end = marks(path)
    return start + '\n' + src.rstrip('\n') + '\n' + end + '\n'


def splice_or_insert(data, path, block):
    start, end = marks(path)
    i = data.find(start)
    if i != -1:
        j = data.find(end, i)
        if j == -1:
            sys.exit('%s: opening marker with no closing marker in the canvas' % start)
        return data[:i] + block.rstrip('\n') + '\n' + data[j + len(end):]
    # First-time insertion: place after ANCHOR_END_MARKER.
    anchor_i = data.find(ANCHOR_END_MARKER)
    if anchor_i == -1:
        sys.exit('anchor marker not found: %s' % ANCHOR_END_MARKER)
    insert_at = anchor_i + len(ANCHOR_END_MARKER)
    return data[:insert_at] + '\n' + block.rstrip('\n') + '\n' + data[insert_at:]


def guard(block, path):
    # Refuse anything that would break out of the surrounding <script> tag,
    # contains raw control characters, or (per the R1 SPEC) an em dash in
    # visible UI-facing source.
    if '</script>' in block:
        sys.exit('%s: refusing to inject, contains a literal </script>.' % path)
    bad = [ord(c) for c in block if ord(c) < 32 and c not in '\t\n\r']
    if bad:
        sys.exit('%s: refusing to inject, contains control characters %s.' % (path, sorted(set(bad))))
    if '\u2014' in block:
        sys.exit('%s: refusing to inject, contains an em dash (U+2014). R1 SPEC: no em dash in visible UI.' % path)


def main():
    data = read(CANVAS)

    engine_block = build_engine_iife(ENGINE_PATH, 'DataGlowProjectRun')
    guard(engine_block, ENGINE_PATH)
    data2 = splice_or_insert(data, ENGINE_PATH, engine_block)
    if data2 is None:
        sys.exit('failed to splice %s' % ENGINE_PATH)

    ui_block = build_canvas_ui_block(CANVAS_UI_PATH)
    guard(ui_block, CANVAS_UI_PATH)
    # Insert the UI block right after the engine block so Project Run's two
    # files sit adjacent to each other and to the RECEIPT spine.
    start, end = marks(ENGINE_PATH)
    engine_end_marker_pos = data2.find(end)
    if engine_end_marker_pos == -1:
        sys.exit('engine end marker missing after splice, cannot place UI block')
    insert_at = engine_end_marker_pos + len(end)
    ui_start, ui_end = marks(CANVAS_UI_PATH)
    if ui_start in data2:
        data3 = splice_or_insert(data2, CANVAS_UI_PATH, ui_block)
    else:
        data3 = data2[:insert_at] + '\n' + ui_block.rstrip('\n') + '\n' + data2[insert_at:]

    with open(CANVAS, 'w', encoding='utf-8') as f:
        f.write(data3)

    print('Injected/re-synced:')
    print('  ' + ENGINE_PATH)
    print('  ' + CANVAS_UI_PATH)
    print('Canvas bytes before: %d, after: %d' % (len(data), len(data3)))


if __name__ == '__main__':
    main()
