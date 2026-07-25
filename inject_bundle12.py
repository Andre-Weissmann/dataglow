#!/usr/bin/env python3
"""Inline Bundle 12 (supply-chain pinning, CSP, RECEIPT spine, desktop llama.cpp, power packs).

Nine files go in right before window.addEventListener('appinstalled':

  js/ai/model-supply-chain.js                 runtime pins,      ESM -> IIFE
  js/security/csp-policy.js                   derived CSP,       ESM -> IIFE
  js/ai/desktop-local-llm.js                  sidecar status,    ESM -> IIFE
  js/spine/receipt-spine.js                   the five steps,    ESM -> IIFE
  js/polyglot/sql-power-pack.js               DuckDB snippets,   ESM -> IIFE
  js/polyglot/python-power-pack.js            pandas cells,      ESM -> IIFE
  js/polyglot/r-power-pack.js                 base R cells,      ESM -> IIFE
  js/spine/data-glow-receipt-spine-canvas.js  the rail,          already an IIFE
  js/polyglot/data-glow-power-packs-canvas.js the packs panel,   already an IIFE

plus js/ai/data-glow-local-ai-canvas.js re-spliced, and two surgical patches for
which see below.

WHY THE ONDEVICE-LLM SPAN IS PATCHED RATHER THAN RE-SPLICED.
js/narrative/ondevice-llm.js was inlined by an older script under an asymmetric
marker convention (its opening marker names the full path and its closing marker
does not), and its body carries em dashes in comments that predate the em-dash
rule. Regenerating that span would either trip this script's own guard or force a
blind sweep over prose nobody asked to change. So the four things Bundle 12 needs
are spliced in at exact anchors instead:

  1. the modelReady / modelLoading pair, because the inlined isModelLoaded()
     returned `enginePromise != null`, which is true from the instant someone
     clicks through the entire multi-minute weight download. A status chip built
     on that shows ready while nothing can run.
  2. loadModel setting both flags, and clearing them on failure.
  3. clearModelCache clearing them too.
  4. the window.OnDeviceLLM footer, which today publishes four names the module
     has never exported (generateNarrative, isOnDeviceAvailable,
     buildPromptContext, ON_DEVICE_MODELS) and so hands out null, a function
     returning false, null and an empty array. The four stay, so nothing reading
     them breaks, and the names that actually exist are added beside them.

WHY window.DataGlowR GAINS A packages() READER.
The WebR kernel is the only thing that knows whether jsonlite and ggplot2
installed, because it is what tried, and it keeps that in two closure variables.
The R power pack has to ask something. Without this it assumes neither installed
and lists more recipes as unavailable than may be true, which is the safe
direction but not the honest one.

Idempotent throughout: re-running after a source edit re-syncs the spans, and
each surgical patch is skipped when its sentinel is already present.
"""
import hashlib
import re
import sys

CANVAS = 'canvas/index.html'

# import specifier -> (source file holding the `export const`, its export name,
#                      the window name it is published under in the canvas)
ALLOWED = {
    '../ai/model-supply-chain.js': (
        'js/ai/model-supply-chain.js', 'DataGlowModelSupplyChain', 'DataGlowModelSupplyChain',
    ),
}

# Dependency order. csp-policy reads model-supply-chain, so it follows it.
ENGINES = [
    ('js/ai/model-supply-chain.js', 'DataGlowModelSupplyChain'),
    ('js/security/csp-policy.js', 'DataGlowCspPolicy'),
    ('js/ai/desktop-local-llm.js', 'DataGlowDesktopLocalLlm'),
    ('js/spine/receipt-spine.js', 'DataGlowReceiptSpine'),
    ('js/polyglot/sql-power-pack.js', 'DataGlowSqlPowerPack'),
    ('js/polyglot/python-power-pack.js', 'DataGlowPythonPowerPack'),
    ('js/polyglot/r-power-pack.js', 'DataGlowRPowerPack'),
]

UIS = [
    'js/spine/data-glow-receipt-spine-canvas.js',
    'js/polyglot/data-glow-power-packs-canvas.js',
    'js/ai/data-glow-local-ai-canvas.js',
]

# The spine rail reads the proof-to-post pack and the local AI panel reads the
# status engine, so both must already be in the page.
REQUIRED = [
    'js/ai/local-ai-status.js',
    'js/ai/capability-ceiling.js',
    'js/polyglot/polars-path.js',
]

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
    """The key list of the module's own `export const <ns> = { ... };`."""
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
    if '</script>' in block:
        sys.exit('Refusing to inject: the block contains a literal </script>.')
    if '—' in block:
        sys.exit('Refusing to inject: the block contains an em dash (U+2014).')
    bad = [ord(c) for c in block if ord(c) < 32 and c not in '\t\n\r']
    if bad:
        sys.exit('Refusing to inject: the block contains control characters %s.' % sorted(set(bad)))


# ---------------------------------------------------------------
# Surgical patch 1: the on-device model loader's idea of "loaded"
# ---------------------------------------------------------------

LLM_SPAN_START = '/* ---- from js/narrative/ondevice-llm.js ---- */'
LLM_SPAN_END = '/* ---- end ondevice-llm.js ---- */'
LLM_SENTINEL = 'modelReady'

LLM_EDITS = [
    (
        'let enginePromise = null;\n',
        'let enginePromise = null;\n'
        '\n'
        "// `enginePromise != null` used to be the whole definition of \"loaded\", which\n"
        '// meant the model counted as loaded from the instant someone clicked, through\n'
        '// the entire multi-minute weight download. Any status surface built on it would\n'
        '// show ready while nothing could yet run. These two track the real thing: one\n'
        '// says a download is in flight, the other says an engine actually exists.\n'
        'let modelReady = false;\n'
        'let modelLoading = false;\n',
    ),
    (
        '  if (enginePromise) return enginePromise;\n  enginePromise = (async () => {\n',
        '  if (enginePromise) return enginePromise;\n  modelLoading = true;\n  enginePromise = (async () => {\n',
    ),
    (
        '    });\n    return engine;\n  })().catch(err => {\n'
        '    enginePromise = null; // allow retry after a failed load\n'
        '    throw err;\n  });\n',
        '    });\n    modelReady = true;\n    modelLoading = false;\n    return engine;\n  })().catch(err => {\n'
        '    enginePromise = null; // allow retry after a failed load\n'
        '    modelReady = false;\n    modelLoading = false;\n'
        '    throw err;\n  });\n',
    ),
    (
        'function isModelLoaded() {\n  return enginePromise != null;\n}\n',
        '/** True only once an engine exists and inference would actually run. */\n'
        'function isModelLoaded() {\n  return modelReady === true;\n}\n'
        '\n'
        '/** True while the weights are downloading. Not the same as loaded, on purpose. */\n'
        'function isModelLoading() {\n  return modelLoading === true;\n}\n',
    ),
    (
        'async function clearModelCache() {\n  enginePromise = null;\n',
        'async function clearModelCache() {\n  enginePromise = null;\n  modelReady = false;\n  modelLoading = false;\n',
    ),
]

LLM_FOOTER_OLD = """  window.OnDeviceLLM = {
    generateNarrative: typeof generateNarrative !== 'undefined' ? generateNarrative : null,
    isOnDeviceAvailable: typeof isOnDeviceAvailable !== 'undefined' ? isOnDeviceAvailable : function(){ return false; },
    buildPromptContext: typeof buildPromptContext !== 'undefined' ? buildPromptContext : null,
    ON_DEVICE_MODELS: typeof ON_DEVICE_MODELS !== 'undefined' ? ON_DEVICE_MODELS : [],
  };
"""

LLM_FOOTER_NEW = """  // The four names below have never been exported by this module, so each one
  // resolves to its fallback. They are kept because something may read them and
  // a sudden undefined is worse than a null. Everything after them is real.
  window.OnDeviceLLM = {
    generateNarrative: typeof generateNarrative !== 'undefined' ? generateNarrative : null,
    isOnDeviceAvailable: typeof isOnDeviceAvailable !== 'undefined' ? isOnDeviceAvailable : function(){ return false; },
    buildPromptContext: typeof buildPromptContext !== 'undefined' ? buildPromptContext : null,
    ON_DEVICE_MODELS: typeof ON_DEVICE_MODELS !== 'undefined' ? ON_DEVICE_MODELS : [],

    MODEL_ID: MODEL_ID,
    MODEL_LABEL: MODEL_LABEL,
    isWebGPUAvailable: isWebGPUAvailable,
    isModelLoaded: isModelLoaded,
    isModelLoading: isModelLoading,
    loadModel: loadModel,
    clearModelCache: clearModelCache,
    synthesizeFindings: synthesizeFindings,
    generateStoryNarrative: generateStoryNarrative,
    buildSynthesisPrompt: buildSynthesisPrompt,
    buildStoryModelPrompt: buildStoryModelPrompt,
  };
"""


def patch_ondevice_llm(data):
    i = data.find(LLM_SPAN_START)
    if i == -1:
        sys.exit('canvas: the ondevice-llm span is not inlined, so there is nothing to patch')
    j = data.find(LLM_SPAN_END, i)
    if j == -1:
        sys.exit('canvas: the ondevice-llm span has no closing marker')
    span = data[i:j]
    if LLM_SENTINEL in span:
        return data, False

    # Only what this bundle inserts is guarded. The span itself predates the
    # em-dash rule and carries them in comments; guarding the whole thing would
    # refuse a patch over prose nobody asked to change.
    for _old, new in LLM_EDITS:
        guard(new)
    guard(LLM_FOOTER_NEW)

    for old, new in LLM_EDITS:
        if span.count(old) != 1:
            sys.exit('canvas: expected exactly one match in the ondevice-llm span for:\n%r' % old[:70])
        span = span.replace(old, new, 1)

    if span.count(LLM_FOOTER_OLD) != 1:
        sys.exit('canvas: the OnDeviceLLM footer is not the shape this patch expects')
    span = span.replace(LLM_FOOTER_OLD, LLM_FOOTER_NEW, 1)

    return data[:i] + span + data[j:], True


# ---------------------------------------------------------------
# Surgical patch 2: let the R power pack ask what installed
# ---------------------------------------------------------------

R_SENTINEL = 'packages: function () { return { jsonlite:'

R_OLD = """    window.DataGlowR = {
      version: 1,
      rowLimit: ROW_LIMIT,
"""

R_NEW = """    window.DataGlowR = {
      version: 1,
      rowLimit: ROW_LIMIT,
      // The kernel is the only thing that knows whether the two optional
      // packages installed, because it is what tried. Anything asking from
      // outside would otherwise have to guess.
      packages: function () { return { jsonlite: _hasJsonlite === true, ggplot2: _graphicsAvailable === true }; },
"""


def patch_r_kernel(data):
    if R_SENTINEL in data:
        return data, False
    if data.count(R_OLD) != 1:
        sys.exit('canvas: the DataGlowR public block is not the shape this patch expects')
    guard(R_NEW)
    return data.replace(R_OLD, R_NEW, 1), True


def main():
    data = read(CANVAS)
    before = len(data)

    for path in REQUIRED:
        if marks(path)[0] not in data:
            sys.exit('canvas: %s is not inlined, so Bundle 12 would read a namespace\n'
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

    data, llm_patched = patch_ondevice_llm(data)
    data, r_patched = patch_r_kernel(data)

    open(CANVAS, 'w', encoding='utf-8').write(data)

    for p in resynced:
        print('re-synced  %s' % p)
    for b in new_blocks:
        print('injected   %s' % b.split(' ---- ')[1].replace('from ', ''))
    print('llm        %s' % ('patched with real loaded state' if llm_patched else 'already patched'))
    print('r kernel   %s' % ('patched with packages()' if r_patched else 'already patched'))
    print('canvas %d -> %d chars (%+d)' % (before, len(data), len(data) - before))
    print('sha256(canvas) = %s' % hashlib.sha256(data.encode('utf-8')).hexdigest()[:16])
    print('\nNext: node --check the inline script, then')
    print('      npm run check:canvas-integrity -- --update')


if __name__ == '__main__':
    main()
