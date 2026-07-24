#!/usr/bin/env python3
"""Inline the Guided Unpivot engine + canvas UI into canvas/index.html.

Inserts both modules right before window.addEventListener('appinstalled'.
The pure engine is ESM in source; here we strip export keywords and wrap it
in an IIFE that attaches window.DataGlowGuidedUnpivot, matching the repo's
inline convention (see the excel-hell / python-notebook inline blocks).
"""
import re
import sys

CANVAS = 'canvas/index.html'
ENGINE_SRC = 'js/intelligence/guided-unpivot.js'
UI_SRC = 'js/intelligence/data-glow-guided-unpivot-canvas.js'

ENGINE_MARK = '/* ---- from js/intelligence/guided-unpivot.js ---- */'
UI_MARK = '/* ---- from js/intelligence/data-glow-guided-unpivot-canvas.js ---- */'


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def build_engine_iife():
    src = read(ENGINE_SRC)
    # Remove the ESM window-attach tail block (re-added below inside the IIFE).
    src = src.split('export const DataGlowGuidedUnpivot')[0]
    # Strip ESM export syntax -> plain declarations.
    src = re.sub(r'^export const ', 'const ', src, flags=re.M)
    src = re.sub(r'^export function ', 'function ', src, flags=re.M)
    body = (
        ENGINE_MARK + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + src
        + '\n  var DataGlowGuidedUnpivot = {\n'
        + '    version: GUIDED_UNPIVOT_VERSION,\n'
        + '    createEmptyConfig: createEmptyConfig,\n'
        + '    suggestConfig: suggestConfig,\n'
        + '    validateConfig: validateConfig,\n'
        + '    quoteIdent: quoteIdent,\n'
        + '    buildUnpivotSQL: buildUnpivotSQL,\n'
        + '    unpivotTransform: unpivotTransform,\n'
        + '    preview: preview,\n'
        + '    fingerprintColumns: fingerprintColumns,\n'
        + '    serializeConfig: serializeConfig,\n'
        + '    parseConfig: parseConfig\n'
        + '  };\n'
        + '  window.DataGlowGuidedUnpivot = DataGlowGuidedUnpivot;\n'
        + '})();\n'
        + '/* ---- end js/intelligence/guided-unpivot.js ---- */\n'
    )
    return body


def build_ui():
    return read(UI_SRC)


def main():
    data = read(CANVAS)
    if ENGINE_MARK in data or UI_MARK in data:
        print('Already inlined; aborting to avoid duplication.')
        sys.exit(1)

    anchor = "window.addEventListener('appinstalled'"
    idx = data.find(anchor)
    if idx == -1:
        print('Anchor not found')
        sys.exit(1)

    block = build_engine_iife() + '\n' + build_ui() + '\n\n'
    new = data[:idx] + block + data[idx:]
    open(CANVAS, 'w', encoding='utf-8').write(new)
    print('Injected %d chars before appinstalled (offset %d).' % (len(block), idx))


if __name__ == '__main__':
    main()
