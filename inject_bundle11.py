#!/usr/bin/env python3
"""Inline Bundle 11 (built-in AI status, ambient proof, capability ceiling, Polars path).

Six files go in right before window.addEventListener('appinstalled':

  js/ai/local-ai-status.js               status + registry,  ESM -> IIFE
  js/ai/capability-ceiling.js            honest ceilings,    ESM -> IIFE
  js/ai/ai-claim-guard.js                Tier 2 gate,        ESM -> IIFE
  js/ambient/ambient-proof-strip.js      ambient strip,      ESM -> IIFE
  js/polyglot/polars-path.js             Polars status,      ESM -> IIFE
  js/ai/data-glow-local-ai-canvas.js     canvas UI, already an IIFE

plus one surgical patch to the already-inlined js/agents/guarded-copilot.js span,
for which see PATCHING GUARDED COPILOT below.

WHY THE IMPORTS ARE REWRITTEN RATHER THAN STRIPPED.
Same reason as Bundle 10: the canvas is one big inline script with no module
scope, so an `import` in it is a syntax error. Each import block becomes a read
off the window namespace the imported module already publishes, the modules go in
dependency order, and every imported name is checked against the source module's
own namespace key list rather than assumed.

PATCHING GUARDED COPILOT RATHER THAN RE-SPLICING IT.
js/agents/guarded-copilot.js was inlined by an older script under a marker
convention with no closing marker, and its inlined header hand-rolls the window
reads for three namespaces. Re-generating that header is not this script's to
own. So the three new pieces (the guard resolver, the ledger logger, and the
call site inside refineWithOnDeviceModel) are spliced into the existing span at
their anchors. Idempotent: skipped when the sentinel is already present.

Note the guard resolver reads globalThis.DataGlowAiClaimGuard first precisely so
that the inlined copy works with no import at all. The dynamic import in the
same function is the Node and ESM path and simply fails to a null in the canvas,
which the caller treats as a refusal rather than as permission.

Idempotent overall: re-running after a source edit re-syncs the spans instead of
appending a second copy.
"""
import hashlib
import re
import sys

CANVAS = 'canvas/index.html'

# import specifier -> (source file holding the `export const`, its export name,
#                      the window name it is published under in the canvas)
ALLOWED = {
    './prove-gate.js': (
        'js/ai/prove-gate.js', 'DataGlowProveGate', 'DataGlowProveGate',
    ),
}

# Dependency order. (source path, window namespace == the module's `export const`)
ENGINES = [
    ('js/ai/local-ai-status.js', 'DataGlowLocalAiStatus'),
    ('js/ai/capability-ceiling.js', 'DataGlowCapabilityCeiling'),
    ('js/ai/ai-claim-guard.js', 'DataGlowAiClaimGuard'),
    ('js/ambient/ambient-proof-strip.js', 'DataGlowAmbientProof'),
    ('js/polyglot/polars-path.js', 'DataGlowPolarsPath'),
]

UIS = ['js/ai/data-glow-local-ai-canvas.js']

# ai-claim-guard.js reads window.DataGlowProveGate, so Bundle 10's gate must
# already be inlined or the guard would resolve undefined functions at runtime.
REQUIRED = [
    'js/ai/prove-gate.js',
    'js/agents/guarded-copilot.js',
]

# ---- the guarded-copilot patch ----
GC_SRC = 'js/agents/guarded-copilot.js'
GC_SENTINEL = 'resolveClaimGuard'
GC_HELPERS_START = '// Resolve the claim guard from the global surface first'
GC_HELPERS_ANCHOR = '/**\n * Tier 2 (opt-in): reuse the EXACT on-device model loader'
GC_CALL_OLD = """    refined = refined.trim();
    return refined ? { text: refined, usedOnDeviceModel: true } : fallback;
"""

IMPORT_RE = re.compile(
    r"^import\s*\{([^}]*)\}\s*from\s*'([^']+)';\s*$",
    flags=re.M | re.S,
)

ANY_IMPORT_RE = re.compile(r'^\s*import\b', flags=re.M)


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def marks(path):
    return ('/* ---- from %s ---- */' % path, '/* ---- end %s ---- */' % path)


def namespace_keys(src, ns_name, path):
    """The key list of the module's own `export const <ns> = { ... };`.

    Read from the source so it cannot fall behind when the module gains a
    function, which is the same reason every earlier inject script does it this
    way rather than restating the list here.
    """
    _head, sep, tail = src.partition('export const %s = {' % ns_name)
    if not sep:
        sys.exit('%s: namespace `export const %s` not found' % (path, ns_name))
    keys = re.findall(r'^\s{2}([A-Za-z_$][\w$]*),\s*$', tail.split('};')[0], flags=re.M)
    if not keys:
        sys.exit('%s: could not read the namespace key list' % path)
    return keys


def build_engine_iife(path, ns_name):
    src = read(path)
    keys = namespace_keys(src, ns_name, path)
    head = src.partition('export const %s = {' % ns_name)[0]

    def rewrite(m):
        names = [n.strip() for n in m.group(1).split(',') if n.strip()]
        spec = m.group(2)
        if spec not in ALLOWED:
            sys.exit('%s: refusing to rewrite an import from %s. Add it to ALLOWED with the\n'
                     '  window name it is published under, or move the helper.' % (path, spec))
        src_file, src_ns, win_ns = ALLOWED[spec]
        avail = namespace_keys(read(src_file), src_ns, src_file)
        missing = [n for n in names if n not in avail]
        if missing:
            sys.exit('%s: imports names %s does not publish on its namespace: %s'
                     % (path, src_file, ', '.join(missing)))
        return ('  // Inlined build: no module scope in the canvas, so this is read off\n'
                '  // window.%s instead of imported.\n' % win_ns
                + '  var ' + ', '.join('%s = window.%s.%s' % (n, win_ns, n) for n in names) + ';')

    body = IMPORT_RE.sub(rewrite, head)
    body = re.sub(r'^export (const|function|async function|class|let) ', r'\1 ', body, flags=re.M)
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
    # Every string in this bundle is user-facing product text, so the em-dash
    # rule applies to all of it and this is the last gate before it ships.
    if '—' in block:
        sys.exit('Refusing to inject: the block contains an em dash (U+2014).')
    bad = [ord(c) for c in block if ord(c) < 32 and c not in '\t\n\r']
    if bad:
        sys.exit('Refusing to inject: the block contains control characters %s.' % sorted(set(bad)))


def gc_helpers():
    """The two guard helpers, lifted verbatim from the guarded-copilot source."""
    src = read(GC_SRC)
    i = src.find(GC_HELPERS_START)
    if i == -1:
        sys.exit('%s: the claim guard helpers are missing from the source' % GC_SRC)
    j = src.find(GC_HELPERS_ANCHOR, i)
    if j == -1:
        sys.exit('%s: no Tier 2 docblock after the claim guard helpers' % GC_SRC)
    block = src[i:j]
    if GC_SENTINEL not in block:
        sys.exit('%s: the extracted block does not define the resolver' % GC_SRC)
    return block


def gc_call_new():
    """The guarded return, lifted verbatim from the guarded-copilot source."""
    src = read(GC_SRC)
    i = src.find('    refined = refined.trim();\n    if (!refined) return fallback;')
    if i == -1:
        sys.exit('%s: the guarded Tier 2 return is missing from the source' % GC_SRC)
    j = src.find('  } catch {', i)
    if j == -1:
        sys.exit('%s: no catch after the guarded Tier 2 return' % GC_SRC)
    return src[i:j]


def patch_guarded_copilot(data):
    if GC_SENTINEL in data:
        return data, False
    start, _ = marks(GC_SRC)
    i = data.find(start)
    if i == -1:
        sys.exit('canvas: %s is not inlined, so there is nothing to patch' % GC_SRC)

    # 1. the call site. Replace the unguarded return with the guarded one.
    j = data.find(GC_CALL_OLD, i)
    if j == -1:
        sys.exit('canvas: the unguarded Tier 2 return was not found in the inlined span')
    new_call = gc_call_new()
    guard(new_call)
    data = data[:j] + new_call + data[j + len(GC_CALL_OLD):]

    # 2. the helpers, immediately before the function that calls them.
    fn_anchor = 'async function refineWithOnDeviceModel('
    k = data.find(fn_anchor, i)
    if k == -1:
        sys.exit('canvas: refineWithOnDeviceModel was not found in the inlined span')
    # Back up to the start of that line so the helpers land at column zero.
    k = data.rfind('\n', 0, k) + 1
    helpers = gc_helpers()
    guard(helpers)
    data = data[:k] + helpers + data[k:]
    return data, True


def main():
    data = read(CANVAS)
    before = len(data)

    for path in REQUIRED:
        if marks(path)[0] not in data:
            sys.exit('canvas: %s is not inlined, so Bundle 11 would read a namespace\n'
                     '  that does not exist at runtime.' % path)

    new_blocks = []
    resynced = []

    for path, ns_name in ENGINES:
        block = build_engine_iife(path, ns_name)
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

    data, patched = patch_guarded_copilot(data)

    open(CANVAS, 'w', encoding='utf-8').write(data)

    for p in resynced:
        print('re-synced  %s' % p)
    for b in new_blocks:
        print('injected   %s' % b.split(' ---- ')[1].replace('from ', ''))
    print('copilot    %s' % ('patched with the claim guard' if patched else 'already patched'))
    print('canvas %d -> %d chars (%+d)' % (before, len(data), len(data) - before))
    print('sha256(canvas) = %s' % hashlib.sha256(data.encode('utf-8')).hexdigest()[:16])
    print('\nNext: node --check the inline script, then')
    print('      npm run check:canvas-integrity -- --update')


if __name__ == '__main__':
    main()
