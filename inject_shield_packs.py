#!/usr/bin/env python3
"""Inline the Shield Packs engine + canvas UI into canvas/index.html.

Inserts both modules right before window.addEventListener('appinstalled', and
the pack styles right after the existing PHI Shield block in the inline CSS.
The pure engine is ESM in source; here export keywords are stripped and it is
wrapped in an IIFE that attaches window.DataGlowShieldPacks, matching the
repo's inline convention (see inject_r_notebook.py).
"""
import re
import sys

CANVAS = 'canvas/index.html'
ENGINE_SRC = 'js/intelligence/shield-packs.js'
UI_SRC = 'js/intelligence/data-glow-shield-packs-canvas.js'

ENGINE_MARK = '/* ---- from js/intelligence/shield-packs.js ---- */'
UI_MARK = '/* ---- from js/intelligence/data-glow-shield-packs-canvas.js ---- */'
CSS_MARK = '/* Shield Packs */'

CSS = """  /* Shield Packs */
  #dg-shield-packs-btn {
    min-height: 44px; min-width: 44px; padding: 0 12px; margin-left: 6px;
    border-radius: 10px; border: 1px solid var(--border);
    background: var(--surface-2, var(--surface));
    color: var(--text); cursor: pointer; font-family: inherit;
    font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; gap: 8px;
    white-space: nowrap;
  }
  #dg-shield-packs-btn .dg-sp-dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted);
    flex: 0 0 auto;
  }
  #dg-shield-packs-btn[data-level="elevated"] .dg-sp-dot { background: var(--flag, #F5A623); }
  #dg-shield-packs-btn[data-level="high"] .dg-sp-dot { background: var(--flag, #F5A623); }
  #dg-shield-packs-btn[data-level="maximum"] .dg-sp-dot { background: var(--error, #E85D4C); }
  #dg-shield-packs-btn[data-level="elevated"] { border-color: var(--flag, #F5A623); }
  #dg-shield-packs-btn[data-level="high"] { border-color: var(--flag, #F5A623); }
  #dg-shield-packs-btn[data-level="maximum"] { border-color: var(--error, #E85D4C); }
  #dg-shield-packs-panel {
    position: fixed; top: 0; right: 0; bottom: 0; width: min(400px, 100vw);
    z-index: 12061; background: var(--surface, #131519);
    border-left: 1px solid var(--border);
    transform: translateX(100%);
    transition: transform .28s cubic-bezier(0.34, 1.56, 0.64, 1);
    display: flex; flex-direction: column;
    box-shadow: -8px 0 24px rgba(0,0,0,.35);
  }
  #dg-shield-packs-panel.open { transform: translateX(0); }
  .dg-sp-card {
    border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px;
    background: var(--bg-elevated, var(--bg)); margin-bottom: 10px;
  }
  .dg-sp-card.is-active { border-color: var(--primary); }
  .dg-sp-badge {
    display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 999px;
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    border: 1px solid var(--border); color: var(--text-muted);
  }
  .dg-sp-chip {
    display: inline-flex; align-items: center; min-height: 28px;
    padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 700;
    border: 1px solid var(--border); margin: 0 6px 6px 0; color: var(--text);
  }
  .dg-sp-chip.hot { border-color: var(--error, #E85D4C); color: var(--error, #E85D4C); }
  .dg-sp-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .dg-sp-btn {
    min-height: 44px; padding: 0 14px; border-radius: 10px; font-family: inherit;
    font-size: 12px; font-weight: 700; cursor: pointer;
  }
  .dg-sp-btn.primary { background: var(--primary); color: #fff; border: 1px solid var(--primary); }
  .dg-sp-btn.ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); }
  #dg-shield-packs-banner {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 12062;
    display: none; padding: 10px 16px calc(10px + env(safe-area-inset-bottom, 0px));
    background: var(--error, #E85D4C); color: #fff;
    font-size: 12px; font-weight: 700; text-align: center; line-height: 1.45;
  }
  #dg-shield-packs-banner.open { display: block; }
"""


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def build_engine_iife():
    src = read(ENGINE_SRC)
    # Drop the ESM namespace object + window attach tail (re-added inside the IIFE).
    src = src.split('export const DataGlowShieldPacks')[0]
    src = re.sub(r'^export const ', 'const ', src, flags=re.M)
    src = re.sub(r'^export function ', 'function ', src, flags=re.M)
    return (
        ENGINE_MARK + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + src
        + '\n  window.DataGlowShieldPacks = {\n'
        + '    version: SHIELD_PACKS_VERSION,\n'
        + '    listPacks: listPacks,\n'
        + '    getPack: getPack,\n'
        + '    detectPatterns: detectPatterns,\n'
        + '    scanColumnSamples: scanColumnSamples,\n'
        + '    posture: posture,\n'
        + '    postureCopy: postureCopy\n'
        + '  };\n'
        + '})();\n'
        + '/* ---- end js/intelligence/shield-packs.js ---- */\n'
    )


def main():
    data = read(CANVAS)
    if ENGINE_MARK in data or UI_MARK in data or CSS_MARK in data:
        print('Already inlined; aborting to avoid duplication.')
        sys.exit(1)

    # 1. CSS right after the PHI Shield block (ends at .dg-phi-actions .ghost rule).
    css_anchor = '  .dg-phi-actions .ghost {\n'
    ci = data.find(css_anchor)
    if ci == -1:
        print('CSS anchor not found')
        sys.exit(1)
    ci_end = data.find('\n  }\n', ci)
    if ci_end == -1:
        print('CSS anchor end not found')
        sys.exit(1)
    ci_end += len('\n  }\n')
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
