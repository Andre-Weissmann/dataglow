#!/usr/bin/env python3
"""Inline Bundle 6 (A18/A19/A20/A24 time and join transforms) into canvas/index.html.

Same shape as inject_bundle5.py. Six modules go in right before
window.addEventListener('appinstalled', so they boot with the other canvas
surfaces:

  js/transforms/transform-core.js                shared pure core, ESM -> IIFE
  js/transforms/prior-period.js                  A18 engine,       ESM -> IIFE
  js/transforms/date-range-join.js               A19 engine,       ESM -> IIFE
  js/transforms/first-last-event.js              A20 engine,       ESM -> IIFE
  js/transforms/as-of-lookup.js                  A24 engine,       ESM -> IIFE
  js/transforms/data-glow-time-joins-canvas.js   canvas UI, already an IIFE

WHAT IS DIFFERENT FROM BUNDLE 5, AND WHY IT MATTERS.
Bundle 5's two engines were standalone. These four import from a shared core, and
the canvas has no module scope: it is one big inline script, so an `import`
statement in it is a syntax error. Each import block is therefore rewritten into
a destructure off window.DataGlowTransformCore, and the core is injected first so
that object exists by the time the others run.

The rewrite is checked rather than trusted. Every name a module imports must be a
key of the core's own namespace object, and the check reads that key list from the
source rather than from a hand-written list here, so an engine that starts
importing a new helper fails this script instead of failing silently in the
browser with an undefined function. That is the whole failure mode worth guarding:
a stripped import produces a page that parses fine and throws only when someone
clicks.

No CSS block: the UI injects its own inline styles at runtime, the way the
surfaces it mounts beside already do.

Idempotent: re-running after a source edit re-syncs the spans instead of
appending a second copy.
"""
import hashlib
import re
import sys

CANVAS = 'canvas/index.html'

CORE = ('js/transforms/transform-core.js', 'DataGlowTransformCore')

# (source path, window namespace == the module's own `export const` name)
ENGINES = [
    CORE,
    ('js/transforms/prior-period.js', 'DataGlowPriorPeriod'),
    ('js/transforms/date-range-join.js', 'DataGlowDateRangeJoin'),
    ('js/transforms/first-last-event.js', 'DataGlowFirstLastEvent'),
    ('js/transforms/as-of-lookup.js', 'DataGlowAsOfLookup'),
]

UIS = ['js/transforms/data-glow-time-joins-canvas.js']

IMPORT_RE = re.compile(
    r"^import\s*\{([^}]*)\}\s*from\s*'\./transform-core\.js';\s*$",
    flags=re.M | re.S,
)


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def marks(path):
    return ('/* ---- from %s ---- */' % path, '/* ---- end %s ---- */' % path)


def namespace_keys(src, ns_name, path):
    """The key list of the module's own `export const <ns> = { ... };`.

    Read from the source so it cannot fall behind when the module gains a
    function, which is the same reason inject_bundle5.py does it this way.
    """
    _head, sep, tail = src.partition('export const %s = {' % ns_name)
    if not sep:
        sys.exit('%s: namespace `export const %s` not found' % (path, ns_name))
    keys = re.findall(r'^\s{2}([A-Za-z_$][\w$]*),\s*$', tail.split('};')[0], flags=re.M)
    if not keys:
        sys.exit('%s: could not read the namespace key list' % path)
    return keys


def build_engine_iife(path, ns_name, core_keys):
    src = read(path)
    keys = namespace_keys(src, ns_name, path)
    head = src.partition('export const %s = {' % ns_name)[0]

    # Rewrite the cross-module import into a read off the already-inlined core.
    imported = []

    def rewrite(m):
        names = [n.strip() for n in m.group(1).split(',') if n.strip()]
        imported.extend(names)
        return ('  // Inlined build: no module scope in the canvas, so the shared core is\n'
                '  // read off window instead of imported.\n'
                '  var ' + ', '.join('%s = C.%s' % (n, n) for n in names) + ';')

    body, n_imports = IMPORT_RE.subn(rewrite, head)
    if path != CORE[0] and n_imports != 1:
        sys.exit('%s: expected exactly one transform-core import, found %d' % (path, n_imports))

    missing = [n for n in imported if n not in core_keys]
    if missing:
        sys.exit('%s: imports names the core does not publish on its namespace: %s'
                 % (path, ', '.join(missing)))

    body = re.sub(r'^export (const|function|async function|class|let) ', r'\1 ', body, flags=re.M)
    if re.search(r'^\s*(export|import)\b', body, flags=re.M):
        sys.exit('%s: an export or import survived the rewrite' % path)

    prelude = '' if path == CORE[0] else '  var C = window.%s;\n' % CORE[1]
    start, end = marks(path)
    return (
        start + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + prelude
        + body.rstrip('\n') + '\n'
        + '  window.%s = {\n' % ns_name
        + ''.join('    %s: %s,\n' % (k, k) for k in keys)
        + '  };\n'
        + '})();\n'
        + end + '\n'
    )


def splice(data, path, block):
    """Replace an existing from/end span, or return None if it is not inlined."""
    start, end = marks(path)
    i = data.find(start)
    if i == -1:
        return None
    j = data.find(end, i)
    if j == -1:
        sys.exit('%s: opening marker with no closing marker in the canvas' % path)
    return data[:i] + block.rstrip('\n') + data[j + len(end):]


def guard(block):
    # A literal </script> anywhere in the block would end the canvas's one big
    # inline <script> early and truncate the page.
    if '</script>' in block:
        sys.exit('Refusing to inject: the block contains a literal </script>.')
    # Bundle 6 ships plain-language product text and generated SQL comments. An
    # em dash in either is a hard rule violation, and this is the last gate
    # before it reaches the shipped page.
    if '—' in block:
        sys.exit('Refusing to inject: the block contains an em dash (U+2014).')


def main():
    data = read(CANVAS)
    before = len(data)

    core_keys = namespace_keys(read(CORE[0]), CORE[1], CORE[0])

    new_blocks = []
    resynced = []

    for path, ns_name in ENGINES:
        block = build_engine_iife(path, ns_name, core_keys)
        guard(block)
        spliced = splice(data, path, block)
        if spliced is None:
            new_blocks.append(block)
        else:
            data = spliced
            resynced.append(path)

    for path in UIS:
        block = read(path).rstrip('\n') + '\n'
        guard(block)
        start, _ = marks(path)
        if start not in block:
            sys.exit('%s: expected the file to carry its own from marker' % path)
        spliced = splice(data, path, block)
        if spliced is None:
            new_blocks.append(block)
        else:
            data = spliced
            resynced.append(path)

    if new_blocks:
        anchor = "window.addEventListener('appinstalled'"
        idx = data.find(anchor)
        if idx == -1:
            sys.exit('Script anchor not found')
        added = '\n'.join(b.rstrip('\n') for b in new_blocks) + '\n\n'
        data = data[:idx] + added + data[idx:]

    open(CANVAS, 'w', encoding='utf-8').write(data)

    for p in resynced:
        print('re-synced  %s' % p)
    for b in new_blocks:
        print('injected   %s' % b.split(' ---- ')[1].replace('from ', ''))
    print('canvas %d -> %d chars (%+d)' % (before, len(data), len(data) - before))
    print('sha256(canvas) = %s' % hashlib.sha256(data.encode('utf-8')).hexdigest()[:16])
    print('\nNext: node --check the inline script, then')
    print('      npm run check:canvas-integrity -- --update')


if __name__ == '__main__':
    main()
