#!/usr/bin/env python3
"""Inline the Notebook-to-App engine + canvas UI into canvas/index.html.

Same shape as inject_air_gap_mode.py: both modules go in right before
window.addEventListener('appinstalled', so they boot with the other canvas
surfaces. The pure engine is ESM in source; here the export keywords are
stripped and it is wrapped in an IIFE that attaches
window.DataGlowNotebookAppExport, matching the repo's inline convention. The
canvas UI is already an IIFE carrying its own from/end markers, so it is inlined
verbatim.

No CSS block: the UI injects its own <style> at runtime, the way the two
notebook canvases it mounts into already do.
"""
import re
import sys

CANVAS = 'canvas/index.html'
ENGINE_SRC = 'js/intelligence/notebook-app-export.js'
UI_SRC = 'js/intelligence/data-glow-notebook-app-canvas.js'

ENGINE_MARK = '/* ---- from js/intelligence/notebook-app-export.js ---- */'
UI_MARK = '/* ---- from js/intelligence/data-glow-notebook-app-canvas.js ---- */'


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def build_engine_iife():
    src = read(ENGINE_SRC)
    # Drop the ESM namespace object + window attach tail (re-added inside the IIFE).
    src = src.split('export const DataGlowNotebookAppExport')[0]
    src = re.sub(r'^export const ', 'const ', src, flags=re.M)
    src = re.sub(r'^export function ', 'function ', src, flags=re.M)
    return (
        ENGINE_MARK + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + src
        + '\n  window.DataGlowNotebookAppExport = {\n'
        + '    version: NOTEBOOK_APP_VERSION,\n'
        + '    kind: NOTEBOOK_APP_KIND,\n'
        + '    runtimes: NOTEBOOK_APP_RUNTIMES,\n'
        + '    normalizeRuntime: normalizeRuntime,\n'
        + '    runtimeLabel: runtimeLabel,\n'
        + '    escapeHtml: escapeHtml,\n'
        + '    slugify: slugify,\n'
        + '    buildAppFilename: buildAppFilename,\n'
        + '    imagesOf: imagesOf,\n'
        + '    summarizeNotebook: summarizeNotebook,\n'
        + '    collectText: collectText,\n'
        + '    describeDisclosure: describeDisclosure,\n'
        + '    findExternalReferences: findExternalReferences,\n'
        + '    assertOfflineSafe: assertOfflineSafe,\n'
        + '    buildAppHtml: buildAppHtml\n'
        + '  };\n'
        + '})();\n'
        + '/* ---- end js/intelligence/notebook-app-export.js ---- */\n'
    )


def main():
    data = read(CANVAS)
    if ENGINE_MARK in data or UI_MARK in data:
        print('Already inlined; aborting to avoid duplication.')
        sys.exit(1)

    anchor = "window.addEventListener('appinstalled'"
    idx = data.find(anchor)
    if idx == -1:
        print('Script anchor not found')
        sys.exit(1)

    block = build_engine_iife() + '\n' + read(UI_SRC) + '\n\n'
    # A literal </script> anywhere in the block would end the canvas's one big
    # inline <script> early and truncate the page. The sources write <\/script>,
    # so this is a guard against a future edit forgetting that.
    if '</script>' in block:
        print('Refusing to inject: the block contains a literal </script>.')
        sys.exit(1)

    data = data[:idx] + block + data[idx:]
    open(CANVAS, 'w', encoding='utf-8').write(data)
    print('Injected %d chars of JS.' % len(block))


if __name__ == '__main__':
    main()
