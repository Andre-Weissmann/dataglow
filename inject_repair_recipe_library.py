#!/usr/bin/env python3
"""Inline the Repair Recipe Library engine + store + canvas UI into canvas/index.html.

Inserts all three modules right before window.addEventListener('appinstalled'.
The pure engine and store are ESM in source; here we strip export keywords and
wrap each in an IIFE that attaches its window global, matching the repo's inline
convention (see the excel-hell / guided-unpivot inline blocks).
"""
import re
import sys

CANVAS = 'canvas/index.html'
ENGINE_SRC = 'js/intelligence/repair-recipe-library.js'
STORE_SRC = 'js/intelligence/repair-recipe-store.js'
UI_SRC = 'js/intelligence/data-glow-repair-recipe-library-canvas.js'

ENGINE_MARK = '/* ---- from js/intelligence/repair-recipe-library.js ---- */'
STORE_MARK = '/* ---- from js/intelligence/repair-recipe-store.js ---- */'
UI_MARK = '/* ---- from js/intelligence/data-glow-repair-recipe-library-canvas.js ---- */'


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def strip_exports(src):
    src = re.sub(r'^export const ', 'const ', src, flags=re.M)
    src = re.sub(r'^export function ', 'function ', src, flags=re.M)
    return src


def build_engine_iife():
    src = read(ENGINE_SRC)
    # Drop the ESM tail (const DataGlow... object literal + window attach); the
    # IIFE re-attaches the same global below.
    src = src.split('export const DataGlowRepairRecipeLibrary')[0]
    src = strip_exports(src)
    return (
        ENGINE_MARK + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + src
        + '\n  var DataGlowRepairRecipeLibrary = {\n'
        + '    version: REPAIR_RECIPE_LIBRARY_VERSION,\n'
        + '    RECIPE_KINDS: RECIPE_KINDS,\n'
        + '    createRecipeRecord: createRecipeRecord,\n'
        + '    validateRecord: validateRecord,\n'
        + '    serializeLibrary: serializeLibrary,\n'
        + '    parseLibrary: parseLibrary,\n'
        + '    scoreRecipeMatch: scoreRecipeMatch,\n'
        + '    getApplyPayload: getApplyPayload,\n'
        + '    sortRecipes: sortRecipes,\n'
        + '    filterRecipes: filterRecipes,\n'
        + '    normalizeColumnNames: normalizeColumnNames\n'
        + '  };\n'
        + '  window.DataGlowRepairRecipeLibrary = DataGlowRepairRecipeLibrary;\n'
        + '})();\n'
        + '/* ---- end js/intelligence/repair-recipe-library.js ---- */\n'
    )


def build_store_iife():
    src = read(STORE_SRC)
    src = src.split('export const DataGlowRepairRecipeStore')[0]
    src = strip_exports(src)
    return (
        STORE_MARK + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + src
        + '\n  var DataGlowRepairRecipeStore = {\n'
        + '    version: REPAIR_RECIPE_STORE_VERSION,\n'
        + '    createRepairRecipeStore: createRepairRecipeStore,\n'
        + '    createMemoryStore: createMemoryStore,\n'
        + '    DB_NAME: DB_NAME,\n'
        + '    STORE_NAME: STORE_NAME\n'
        + '  };\n'
        + '  window.DataGlowRepairRecipeStore = DataGlowRepairRecipeStore;\n'
        + '})();\n'
        + '/* ---- end js/intelligence/repair-recipe-store.js ---- */\n'
    )


def build_ui():
    return read(UI_SRC)


def main():
    data = read(CANVAS)
    if ENGINE_MARK in data or STORE_MARK in data or UI_MARK in data:
        print('Already inlined; aborting to avoid duplication.')
        sys.exit(1)

    anchor = "window.addEventListener('appinstalled'"
    idx = data.find(anchor)
    if idx == -1:
        print('Anchor not found')
        sys.exit(1)

    block = build_engine_iife() + '\n' + build_store_iife() + '\n' + build_ui() + '\n\n'
    new = data[:idx] + block + data[idx:]
    open(CANVAS, 'w', encoding='utf-8').write(new)
    print('Injected %d chars before appinstalled (offset %d).' % (len(block), idx))


if __name__ == '__main__':
    main()
