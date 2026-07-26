#!/usr/bin/env python3
"""Bundle 17 finish: re-sync the canvas-inlined copy of
js/sql/duckdb-load-harden.js after pointing SELF_HOST_BASE_URL at
assets/duckdb/ (the real, already-vendored DuckDB-WASM 1.29.0 runtime)
instead of a second canvas/vendor/duckdb-wasm/ copy.

This script only re-splices the ONE tracked engine module that changed
(js/sql/duckdb-load-harden.js). It follows the same engine-IIFE convention
as inject_bundle16.py's build_engine_iife: strip `export`, wrap in an IIFE,
and re-attach the window.DataGlowDuckDBLoadHarden namespace object from the
same key list the source module exports.

Run with:
    python3 inject_bundle17.py
Then verify with:
    npm run check:canvas-integrity -- --update
"""
import re
import sys
import hashlib

CANVAS = 'canvas/index.html'

ENGINES = [
    'js/sql/duckdb-load-harden.js',
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

    if missing:
        sys.exit('Missing expected existing canvas blocks for: %s' % missing)

    open(CANVAS, 'w', encoding='utf-8').write(data)

    for p in resynced:
        print('re-synced  %s' % p)
    print('canvas %d -> %d chars (%+d)' % (before, len(data), len(data) - before))
    print('sha256(canvas) = %s' % hashlib.sha256(data.encode('utf-8')).hexdigest()[:16])


if __name__ == '__main__':
    main()
