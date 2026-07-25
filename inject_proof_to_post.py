#!/usr/bin/env python3
"""Inline Bundle 10 (Proof to Post, prove gate, BI hand-off, de-id receipt).

Five files go in right before window.addEventListener('appinstalled':

  js/ai/prove-gate.js                             claim gate,   ESM -> IIFE
  js/export/bi-handoff.js                         BI pack,      ESM -> IIFE
  js/privacy/deid-receipt.js                      receipt,      ESM -> IIFE
  js/proofpost/proof-to-post.js                   post pack,    ESM -> IIFE
  js/proofpost/data-glow-proof-to-post-canvas.js  canvas UI, already an IIFE

plus one surgical patch to the already-inlined js/nl-sql/nl-sql-ui.js span, for
which see PATCHING NL-SQL below.

WHY THE IMPORTS ARE REWRITTEN RATHER THAN STRIPPED.
The canvas has no module scope: it is one big inline script, so an `import` in it
is a syntax error. Each import block is rewritten into a read off the window
namespace the imported module already publishes, and the modules go in dependency
order so that object exists by the time the next one runs. The rewrite is checked
rather than trusted: every imported name must be a key of the source module's own
namespace object, and the key list is read from the source, so a module that
starts importing a new helper fails this script instead of failing silently in the
browser with an undefined function.

PATCHING NL-SQL RATHER THAN RE-SPLICING IT.
js/nl-sql/nl-sql-ui.js was inlined by an older script under a different marker
convention, and its inlined header hand-rolls the window reads for five separate
namespaces. Re-generating that from source would mean re-deriving a header this
script does not own, so instead the one new block (the Add to Proof Board button)
is spliced into the existing span at its anchor. The splice is idempotent: it is
skipped when the button's test id is already present.

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
    '../proofboard/proof-board.js': (
        'js/proofboard/proof-board.js', 'DataGlowProofBoard', 'DataGlowProofBoard',
    ),
    '../proofboard/coach-moments.js': (
        'js/proofboard/coach-moments.js', 'DataGlowProofBoardCoach', 'DataGlowProofBoardCoach',
    ),
    '../ai/prove-gate.js': (
        'js/ai/prove-gate.js', 'DataGlowProveGate', 'DataGlowProveGate',
    ),
}

# Dependency order. (source path, window namespace == the module's `export const`)
ENGINES = [
    ('js/ai/prove-gate.js', 'DataGlowProveGate'),
    ('js/export/bi-handoff.js', 'DataGlowBIHandoff'),
    ('js/privacy/deid-receipt.js', 'DataGlowDeidReceipt'),
    ('js/proofpost/proof-to-post.js', 'DataGlowProofToPost'),
]

UIS = ['js/proofpost/data-glow-proof-to-post-canvas.js']

# The Proof Board must already be inlined: proof-to-post.js reads
# window.DataGlowProofBoard and the UI reads window.DataGlowProofBoardUI.
REQUIRED = [
    'js/proofboard/proof-board.js',
    'js/proofboard/coach-moments.js',
    'js/proofboard/data-glow-proof-board-canvas.js',
]

# ---- the NL-SQL patch ----
NLSQL_SRC = 'js/nl-sql/nl-sql-ui.js'
NLSQL_BLOCK_START = '      // ---- Add to Proof Board ----\n'
NLSQL_ANCHOR = '      resultWrap.appendChild(btnRow);'
NLSQL_SENTINEL = 'nlsql-add-to-proof-board'

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
    function, which is the same reason inject_proof_board.py does it this way.
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
    # Bundle 10 ships a post draft, a markdown write-up and an exported HTML
    # receipt. An em dash in any of them is a hard rule violation, and this is
    # the last gate before it reaches the shipped page.
    if '—' in block:
        sys.exit('Refusing to inject: the block contains an em dash (U+2014).')
    # A raw control byte inside the one big inline script is invisible in review
    # and painful to diagnose. Sentinels belong in the source as \\u escapes.
    bad = [ord(c) for c in block if ord(c) < 32 and c not in '\t\n\r']
    if bad:
        sys.exit('Refusing to inject: the block contains control characters %s.' % sorted(set(bad)))


def nlsql_block():
    """The Add to Proof Board block, lifted verbatim from the NL-SQL source."""
    src = read(NLSQL_SRC)
    i = src.find(NLSQL_BLOCK_START)
    if i == -1:
        sys.exit('%s: the Add to Proof Board block is missing from the source' % NLSQL_SRC)
    j = src.find(NLSQL_ANCHOR, i)
    if j == -1:
        sys.exit('%s: no anchor after the Add to Proof Board block' % NLSQL_SRC)
    block = src[i:j]
    if NLSQL_SENTINEL not in block:
        sys.exit('%s: the extracted block does not contain the button' % NLSQL_SRC)
    return block


def patch_nlsql(data):
    if NLSQL_SENTINEL in data:
        return data, False
    start, _ = marks(NLSQL_SRC)
    i = data.find(start)
    if i == -1:
        sys.exit('canvas: %s is not inlined, so there is nothing to patch' % NLSQL_SRC)
    j = data.find(NLSQL_ANCHOR, i)
    if j == -1:
        sys.exit('canvas: the NL-SQL button row anchor was not found in the inlined span')
    block = nlsql_block()
    guard(block)
    return data[:j] + block + data[j:], True


def main():
    data = read(CANVAS)
    before = len(data)

    for path in REQUIRED:
        if marks(path)[0] not in data:
            sys.exit('canvas: %s is not inlined, so Bundle 10 would read a namespace\n'
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

    data, patched = patch_nlsql(data)

    open(CANVAS, 'w', encoding='utf-8').write(data)

    for p in resynced:
        print('re-synced  %s' % p)
    for b in new_blocks:
        print('injected   %s' % b.split(' ---- ')[1].replace('from ', ''))
    print('nl-sql     %s' % ('patched with Add to Proof Board' if patched else 'already patched'))
    print('canvas %d -> %d chars (%+d)' % (before, len(data), len(data) - before))
    print('sha256(canvas) = %s' % hashlib.sha256(data.encode('utf-8')).hexdigest()[:16])
    print('\nNext: node --check the inline script, then')
    print('      npm run check:canvas-integrity -- --update')


if __name__ == '__main__':
    main()
