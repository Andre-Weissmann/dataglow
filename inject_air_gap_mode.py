#!/usr/bin/env python3
"""Inline the Air-Gap Mode engine + canvas UI into canvas/index.html.

Same shape as inject_shield_packs.py: both modules go in right before
window.addEventListener('appinstalled', and the styles go in right after the
Shield Packs CSS block, so the two privacy surfaces sit together. The pure
engine is ESM in source; here export keywords are stripped and it is wrapped in
an IIFE that attaches window.DataGlowAirGap, matching the repo's inline
convention.
"""
import re
import sys

CANVAS = 'canvas/index.html'
ENGINE_SRC = 'js/privacy/air-gap-mode.js'
UI_SRC = 'js/privacy/data-glow-air-gap-canvas.js'

ENGINE_MARK = '/* ---- from js/privacy/air-gap-mode.js ---- */'
UI_MARK = '/* ---- from js/privacy/data-glow-air-gap-canvas.js ---- */'
CSS_MARK = '/* Air-Gap Mode */'

CSS = """  /* Air-Gap Mode */
  #dg-air-gap-btn {
    min-height: 44px; min-width: 44px; padding: 0 12px; margin-left: 6px;
    border-radius: 10px; border: 1px solid var(--border);
    background: var(--surface-2, var(--surface));
    color: var(--text); cursor: pointer; font-family: inherit;
    font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; gap: 8px;
    white-space: nowrap;
  }
  #dg-air-gap-btn .dg-ag-dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted);
    flex: 0 0 auto;
  }
  #dg-air-gap-btn[data-state="on"] .dg-ag-dot { background: var(--success, #4CAF7D); }
  #dg-air-gap-btn[data-state="on"] { border-color: var(--success, #4CAF7D); }
  #dg-air-gap-panel {
    position: fixed; top: 0; right: 0; bottom: 0; width: min(400px, 100vw);
    z-index: 12063; background: var(--surface, #131519);
    border-left: 1px solid var(--border);
    transform: translateX(100%);
    transition: transform .28s cubic-bezier(0.34, 1.56, 0.64, 1);
    display: flex; flex-direction: column;
    box-shadow: -8px 0 24px rgba(0,0,0,.35);
  }
  #dg-air-gap-panel.open { transform: translateX(0); }
  .dg-ag-card {
    border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px;
    background: var(--bg-elevated, var(--bg)); margin-bottom: 10px;
  }
  .dg-ag-card.is-active { border-color: var(--success, #4CAF7D); }
  .dg-ag-chip {
    display: inline-flex; align-items: center; min-height: 28px;
    padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 700;
    border: 1px solid var(--border); margin: 0 6px 6px 0; color: var(--text);
  }
  .dg-ag-chip.hot { border-color: var(--error, #E85D4C); color: var(--error, #E85D4C); }
  .dg-ag-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .dg-ag-btn {
    min-height: 44px; padding: 0 14px; border-radius: 10px; font-family: inherit;
    font-size: 12px; font-weight: 700; cursor: pointer;
  }
  .dg-ag-btn.primary { background: var(--primary); color: #fff; border: 1px solid var(--primary); }
  .dg-ag-btn.ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); }
  #dg-air-gap-banner {
    position: fixed; left: 0; right: 0; top: 0; z-index: 12064;
    display: none; padding: calc(10px + env(safe-area-inset-top, 0px)) 16px 10px;
    background: var(--success, #4CAF7D); color: #05130C;
    font-size: 12px; font-weight: 700; text-align: center; line-height: 1.45;
  }
  #dg-air-gap-banner.open { display: block; }
"""


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def build_engine_iife():
    src = read(ENGINE_SRC)
    # Drop the ESM namespace object + window attach tail (re-added inside the IIFE).
    src = src.split('export const DataGlowAirGap')[0]
    src = re.sub(r'^export const ', 'const ', src, flags=re.M)
    src = re.sub(r'^export function ', 'function ', src, flags=re.M)
    return (
        ENGINE_MARK + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + src
        + '\n  window.DataGlowAirGap = {\n'
        + '    version: AIR_GAP_VERSION,\n'
        + '    isAirGapActive: isAirGapActive,\n'
        + '    activate: activate,\n'
        + '    deactivate: deactivate,\n'
        + '    shouldBlockNetwork: shouldBlockNetwork,\n'
        + '    classifyFeature: classifyFeature,\n'
        + '    classifyRequestUrl: classifyRequestUrl,\n'
        + '    listLocalFeatures: listLocalFeatures,\n'
        + '    listEgressFeatures: listEgressFeatures,\n'
        + '    getPosture: getPosture,\n'
        + '    postureCopy: postureCopy,\n'
        + '    resetAirGapSession: resetAirGapSession\n'
        + '  };\n'
        + '})();\n'
        + '/* ---- end js/privacy/air-gap-mode.js ---- */\n'
    )


def main():
    data = read(CANVAS)
    if ENGINE_MARK in data or UI_MARK in data or CSS_MARK in data:
        print('Already inlined; aborting to avoid duplication.')
        sys.exit(1)

    # 1. CSS right after the Shield Packs block (ends at the banner open rule).
    css_anchor = '  #dg-shield-packs-banner.open { display: block; }\n'
    ci = data.find(css_anchor)
    if ci == -1:
        print('CSS anchor not found')
        sys.exit(1)
    ci_end = ci + len(css_anchor)
    data = data[:ci_end] + CSS + data[ci_end:]

    # 2. Scripts before the appinstalled listener.
    anchor = "window.addEventListener('appinstalled'"
    idx = data.find(anchor)
    if idx == -1:
        print('Script anchor not found')
        sys.exit(1)
    block = build_engine_iife() + '\n' + read(UI_SRC) + '\n\n'
    data = data[:idx] + block + data[idx:]

    open(CANVAS, 'w', encoding='utf-8').write(data)
    print('Injected %d chars of CSS + %d chars of JS.' % (len(CSS), len(block)))


if __name__ == '__main__':
    main()
