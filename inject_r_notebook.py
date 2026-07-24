#!/usr/bin/env python3
"""Inline the R Notebooks-lite engine + canvas UI into canvas/index.html.

Inserts both modules right before window.addEventListener('appinstalled'.
The pure engine is ESM in source; here we strip export keywords and wrap it
in an IIFE that attaches window.DataGlowRNotebookLite, matching the repo's
inline convention (see the python-notebook inline).
"""
import re
import sys

CANVAS = 'canvas/index.html'
ENGINE_SRC = 'js/intelligence/r-notebook-lite.js'
UI_SRC = 'js/intelligence/data-glow-r-notebook-canvas.js'

ENGINE_MARK = '/* ---- from js/intelligence/r-notebook-lite.js ---- */'
UI_MARK = '/* ---- from js/intelligence/data-glow-r-notebook-canvas.js ---- */'


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def build_engine_iife():
    src = read(ENGINE_SRC)
    # Drop the ESM export object + window attach tail (re-added inside the IIFE).
    src = src.split('export const DataGlowRNotebookLite')[0]
    # Strip ESM export syntax -> plain declarations.
    src = re.sub(r'^export const ', 'const ', src, flags=re.M)
    src = re.sub(r'^export function ', 'function ', src, flags=re.M)
    body = (
        ENGINE_MARK + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + src
        + '\n  var DataGlowRNotebookLite = {\n'
        + '    version: R_NOTEBOOK_LITE_VERSION,\n'
        + '    rowLimit: R_ROW_LIMIT,\n'
        + '    fileExt: R_NOTEBOOK_FILE_EXT,\n'
        + '    industries: R_STARTER_INDUSTRIES,\n'
        + '    createNotebook: createNotebook,\n'
        + '    createCell: createCell,\n'
        + '    addCell: addCell,\n'
        + '    removeCell: removeCell,\n'
        + '    updateCellSource: updateCellSource,\n'
        + '    moveCell: moveCell,\n'
        + '    setCellOutput: setCellOutput,\n'
        + '    serializeNotebook: serializeNotebook,\n'
        + '    parseNotebook: parseNotebook,\n'
        + '    defaultStarterCells: defaultStarterCells,\n'
        + '    canRunCell: canRunCell,\n'
        + '    buildRBridgePrelude: buildRBridgePrelude,\n'
        + '    buildRBridgeNotices: buildRBridgeNotices,\n'
        + '    buildRowCapNotice: buildRowCapNotice,\n'
        + '    extractImageDataUrls: extractImageDataUrls,\n'
        + '    suggestStarterSnippets: suggestStarterSnippets,\n'
        + '    escapeHtml: escapeHtml,\n'
        + '    renderMarkdown: renderMarkdown\n'
        + '  };\n'
        + '  window.DataGlowRNotebookLite = DataGlowRNotebookLite;\n'
        + '})();\n'
        + '/* ---- end js/intelligence/r-notebook-lite.js ---- */\n'
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
