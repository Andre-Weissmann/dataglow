#!/usr/bin/env python3
"""Bundle 15: DuckDB-WASM multi-CDN load harden (one shared pin list), the
Repair Ledger chip mounted on the RECEIPT spine instead of a floating-only
button, a thin human-confirmed Replay control on the ledger panel, and SQL
Dojo crash-safety guards (canvas-only edits, applied by hand earlier in this
branch, not re-applied here).

This script is idempotent: it only touches spans it owns (marked from/end
blocks). The SQL Dojo hardening lives inline in canvas/index.html directly
(the Dojo has no js/ source module of its own -- see CODEMAP note), so it is
not part of this splice; only the new engine and the two re-synced spine UI
modules are.

Files spliced in, in dependency order (engines before the UIs that read them):

  js/sql/duckdb-load-harden.js                     (new, ESM -> IIFE wrap)
  js/spine/data-glow-receipt-spine-canvas.js       (re-synced, already an IIFE)
  js/spine/data-glow-repair-ledger-canvas.js       (re-synced, already an IIFE)
"""
import re
import sys
import hashlib

CANVAS = 'canvas/index.html'

ENGINES = [
    'js/sql/duckdb-load-harden.js',
]

UIS = [
    'js/spine/data-glow-receipt-spine-canvas.js',
    'js/spine/data-glow-repair-ledger-canvas.js',
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


def splice(data, path, block):
    start, end = marks(path)
    i = data.find(start)
    if i == -1:
        return None
    j = data.find(end, i)
    if j == -1:
        sys.exit('%s: opening marker with no closing marker in the canvas' % path)
    return data[:i] + block.rstrip('\n') + data[j + len(end):]


def guard(block, path):
    if '</script>' in block:
        sys.exit('%s: refusing to inject, contains a literal </script>.' % path)
    if '\u2014' in block:
        sys.exit('%s: refusing to inject, contains an em dash (U+2014).' % path)
    bad = [ord(c) for c in block if ord(c) < 32 and c not in '\t\n\r']
    if bad:
        sys.exit('%s: refusing to inject, contains control characters %s.' % (path, sorted(set(bad))))


def main():
    data = read(CANVAS)
    before = len(data)

    new_blocks = []
    resynced = []

    for path in ENGINES:
        block = build_engine_iife(path)
        guard(block, path)
        spliced = splice(data, path, block)
        if spliced is None:
            new_blocks.append(block)
        else:
            data = spliced
            resynced.append(path)

    for path in UIS:
        block = read(path).rstrip('\n') + '\n'
        guard(block, path)
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


if __name__ == '__main__':
    main()
