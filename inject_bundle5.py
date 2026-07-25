#!/usr/bin/env python3
"""Inline Bundle 5 (Explain + GlassBox) into canvas/index.html.

Same shape as inject_bundle4.py. Four modules go in right before
window.addEventListener('appinstalled', so they boot with the other canvas
surfaces:

  js/explain/explain-engine.js                   pure engine, ESM -> IIFE
  js/glassbox/glass-box.js                       pure engine, ESM -> IIFE
  js/glassbox/data-glow-glass-box-canvas.js      canvas UI, already an IIFE
  js/explain/data-glow-explain-canvas.js         canvas UI, already an IIFE

The two pure engines are ESM in source. Here the export keywords are stripped
and each is wrapped in an IIFE that attaches its window namespace, matching the
repo's inline convention: the inlined copy has no module scope, so the canvas
surfaces read the engines off window. The canvas UIs already carry their own
from/end markers and are inlined verbatim.

Order matters. GlassBox is injected before Explain because Explain reads the
gates GlassBox holds, and both boot on timers (860ms and 880ms) that assume that
order. Injecting Explain first would still work, but it would put the two
surfaces on the page in the opposite order to the one their comments describe.

Bundle 5 also EDITED an already-inlined module, js/provenance/data-glow-trust-
ledger-canvas.js, adding the narrow-viewport rules A14 needs. Its inlined span is
re-synced in place here rather than by hand, because the two copies drifting is
exactly what npm run check:canvas-integrity fails on.

No CSS block: both UIs inject their own <style> at runtime, the way the surfaces
they mount beside already do.

Idempotent: re-running after a source edit re-syncs the spans instead of
appending a second copy.
"""
import hashlib
import re
import sys

CANVAS = 'canvas/index.html'

# Pure engines: (source path, namespace attached to window, namespace const name)
ENGINES = [
    ('js/explain/explain-engine.js', 'DataGlowExplainEngine', 'DataGlowExplain'),
    ('js/glassbox/glass-box.js', 'DataGlowGlassBoxEngine', 'DataGlowGlassBox'),
]

# Canvas UIs, inlined verbatim because they are already IIFEs with markers.
# GlassBox first: see the ordering note in the module docstring.
UIS = [
    'js/glassbox/data-glow-glass-box-canvas.js',
    'js/explain/data-glow-explain-canvas.js',
]

# Already inlined by an earlier bundle, edited by this one, so re-sync in place.
RESYNC = ['js/provenance/data-glow-trust-ledger-canvas.js']


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def marks(path):
    return ('/* ---- from %s ---- */' % path, '/* ---- end %s ---- */' % path)


def build_engine_iife(path, window_name, ns_name):
    """ESM source to an IIFE that attaches window.<window_name>.

    The namespace object and the window-attach tail are dropped and rebuilt
    inside the IIFE, keeping the shape identical to inject_bundle4.py.
    """
    src = read(path)
    head, sep, _tail = src.partition('export const %s = {' % ns_name)
    if not sep:
        sys.exit('%s: namespace `export const %s` not found' % (path, ns_name))

    # The namespace's own key list is the honest source of what to re-export, so
    # this cannot fall behind when the engine gains a function.
    keys = re.findall(r'^\s{2}([A-Za-z_$][\w$]*),\s*$', _tail.split('};')[0], flags=re.M)
    if not keys:
        sys.exit('%s: could not read the namespace key list' % path)

    body = re.sub(r'^export (const|function|async function|class|let) ', r'\1 ', head, flags=re.M)
    # Only statement position matters. Both engines say "export" in prose too,
    # so an unanchored search would fail on a comment.
    if re.search(r'^export\b', body, flags=re.M):
        sys.exit('%s: an export keyword survived the rewrite' % path)

    start, end = marks(path)
    return (
        start + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + body.rstrip('\n') + '\n'
        + '  window.%s = {\n' % window_name
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
    # inline <script> early and truncate the page. The sources write <\/script>,
    # so this guards against a future edit forgetting that.
    if '</script>' in block:
        sys.exit('Refusing to inject: the block contains a literal </script>.')
    # Bundle 5 ships plain-language product text. An em dash in it is a hard rule
    # violation, and this is the last gate before it reaches the shipped page.
    if '—' in block:
        sys.exit('Refusing to inject: the block contains an em dash (U+2014).')


def main():
    data = read(CANVAS)
    before = len(data)

    new_blocks = []
    resynced = []

    for path, window_name, ns_name in ENGINES:
        block = build_engine_iife(path, window_name, ns_name)
        guard(block)
        spliced = splice(data, path, block)
        if spliced is None:
            new_blocks.append(block)
        else:
            data = spliced
            resynced.append(path)

    for path in UIS + RESYNC:
        block = read(path).rstrip('\n') + '\n'
        guard(block)
        start, _ = marks(path)
        if start not in block:
            sys.exit('%s: expected the file to carry its own from marker' % path)
        spliced = splice(data, path, block)
        if spliced is None:
            if path in RESYNC:
                sys.exit('%s: expected to be inlined already, but no marker found' % path)
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
