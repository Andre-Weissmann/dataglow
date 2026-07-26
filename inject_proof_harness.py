#!/usr/bin/env python3
"""Inline the Proof Harness v0 (VERDICT) engine + canvas UI into canvas/index.html.

Same shape as inject_air_gap_mode.py: the pure engine modules are ESM in
source; here `export` keywords are stripped and each is wrapped into ONE
combined IIFE that attaches window.DataGlowProofHarness, matching the repo's
inline convention (js/proof-harness/index.js is the ESM source of truth for
desktop/index.html and for Node tests; this script produces the canvas-only
mirror). The canvas UI module (js/proof-harness/data-glow-proof-harness-canvas.js)
is already a plain IIFE and is inlined verbatim, unchanged, right after it.
"""
import re
import sys

CANVAS = 'canvas/index.html'
PROPOSAL_SRC = 'js/proof-harness/proposal.js'
VERDICT_SRC = 'js/proof-harness/verdict.js'
SCORE_SRC = 'js/proof-harness/score-claim.js'
RECEIPT_SRC = 'js/proof-harness/receipt.js'
INDEX_SRC = 'js/proof-harness/index.js'
UI_SRC = 'js/proof-harness/data-glow-proof-harness-canvas.js'

ENGINE_MARK = '/* ---- from js/proof-harness/index.js ---- */'
UI_MARK = '/* ---- from js/proof-harness/data-glow-proof-harness-canvas.js ---- */'


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def strip_exports(src):
    # Drop import lines (cross-module ESM imports do not resolve when
    # inlined into one script; every symbol they'd import is concatenated
    # into the same IIFE scope below instead).
    src = re.sub(r'^import .*$\n?', '', src, flags=re.M)
    # Strip "export const X = ...", "export function X(...)", "export async
    # function X(...)", "export default X" -- keeping the declaration body,
    # since everything lands in the same function scope.
    src = re.sub(r'^export const ', 'const ', src, flags=re.M)
    src = re.sub(r'^export function ', 'function ', src, flags=re.M)
    src = re.sub(r'^export async function ', 'async function ', src, flags=re.M)
    # "export { a, b as c } from './x.js';" (index.js has several) -- these
    # just re-export symbols already defined earlier in the concatenation, so
    # the whole statement is dropped as a no-op inside a single scope.
    src = re.sub(r'^export \{[^}]*\}(?: from [^;]+)?;\s*$\n?', '', src, flags=re.M)
    # "export default X;" -- drop; nothing inside this IIFE needs a default.
    src = re.sub(r'^export default [^;]+;\s*$\n?', '', src, flags=re.M)
    return src


def build_engine_iife():
    parts = [PROPOSAL_SRC, VERDICT_SRC, SCORE_SRC, RECEIPT_SRC, INDEX_SRC]
    bodies = []
    for p in parts:
        src = read(p)
        # index.js's own window-publish tail is dropped; the combined IIFE
        # below publishes window.DataGlowProofHarness once, at the end.
        if p == INDEX_SRC:
            src = src.split('const DataGlowProofHarness = {')[0]
        bodies.append('  /* ---- ' + p + ' ---- */\n' + strip_exports(src).rstrip() + '\n')

    combined_body = '\n'.join(bodies)

    return (
        ENGINE_MARK + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + combined_body
        + '\n  const DataGlowProofHarness = {\n'
        + '    version: 1,\n'
        + '    runProofCycle: runProofCycle,\n'
        + '    confirmProposal: confirmProposal,\n'
        + '    createTypedProposal: createTypedProposal,\n'
        + '    decideVerdict: decideVerdict,\n'
        + '    compareClaimToRun: compareClaimToRun,\n'
        + '    getReceipts: getReceipts,\n'
        + '    verifyReceipts: verifyReceipts,\n'
        + '    resetReceipts: resetReceipts\n'
        + '  };\n'
        + '  window.DataGlowProofHarness = DataGlowProofHarness;\n'
        + '})();\n'
        + '/* ---- end js/proof-harness/index.js ---- */\n'
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
    data = data[:idx] + block + data[idx:]

    open(CANVAS, 'w', encoding='utf-8').write(data)
    print('Injected %d chars of JS.' % len(block))


if __name__ == '__main__':
    main()
