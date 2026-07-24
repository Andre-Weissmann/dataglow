#!/usr/bin/env python3
"""Inline the Mobile PHI chip + first-run calm modules into canvas/index.html.

Inserts two modules right before window.addEventListener('appinstalled'):
  1. the pure helper (ESM in source) - export keywords stripped and wrapped in an
     IIFE that re-attaches window.DataGlowMobilePhiFirstRunCalm, matching the
     repo's inline convention (see inject_repair_recipe_library.py).
  2. the canvas UI module, which is already an IIFE and is emitted verbatim.

Idempotent: aborts if either marker is already present.
"""
import re
import sys

CANVAS = 'canvas/index.html'
PURE_SRC = 'js/intelligence/mobile-phi-firstrun-calm.js'
UI_SRC = 'js/intelligence/data-glow-mobile-phi-firstrun-canvas.js'

PURE_MARK = '/* ---- from js/intelligence/mobile-phi-firstrun-calm.js ---- */'
UI_MARK = '/* ---- from js/intelligence/data-glow-mobile-phi-firstrun-canvas.js ---- */'


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def strip_exports(src):
    src = re.sub(r'^export const ', 'const ', src, flags=re.M)
    src = re.sub(r'^export function ', 'function ', src, flags=re.M)
    return src


def build_pure_iife():
    src = read(PURE_SRC)
    # Drop the ESM tail (the exported namespace object + window attach); the IIFE
    # re-attaches the same global below.
    src = src.split('export const DataGlowMobilePhiFirstRunCalm')[0]
    src = strip_exports(src)
    return (
        PURE_MARK + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + src
        + '\n  var DataGlowMobilePhiFirstRunCalm = {\n'
        + '    version: MOBILE_PHI_FIRSTRUN_CALM_VERSION,\n'
        + '    FIRST_RUN_STORAGE_KEY: FIRST_RUN_STORAGE_KEY,\n'
        + '    isFirstRun: isFirstRun,\n'
        + '    markFirstRunSeen: markFirstRunSeen,\n'
        + '    chipLabel: chipLabel,\n'
        + '    shouldShowCalmStrip: shouldShowCalmStrip,\n'
        + '    calmCopy: calmCopy\n'
        + '  };\n'
        + '  window.DataGlowMobilePhiFirstRunCalm = DataGlowMobilePhiFirstRunCalm;\n'
        + '})();\n'
        + '/* ---- end js/intelligence/mobile-phi-firstrun-calm.js ---- */\n'
    )


def build_ui():
    return read(UI_SRC)


def main():
    data = read(CANVAS)
    if PURE_MARK in data or UI_MARK in data:
        print('Already inlined; aborting to avoid duplication.')
        sys.exit(1)

    anchor = "window.addEventListener('appinstalled'"
    idx = data.find(anchor)
    if idx == -1:
        print('Anchor not found')
        sys.exit(1)

    block = build_pure_iife() + '\n' + build_ui() + '\n\n'
    new = data[:idx] + block + data[idx:]
    open(CANVAS, 'w', encoding='utf-8').write(new)
    print('Injected %d chars before appinstalled (offset %d).' % (len(block), idx))


if __name__ == '__main__':
    main()
