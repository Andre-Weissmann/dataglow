#!/usr/bin/env python3
"""Re-inline the Proof Harness engine + canvas UI into canvas/index.html for v2.

Same shape as inject_proof_harness_v1.py, extended to compose the three new
v2.0 foundation pure modules (adversary.js, excel-claim.js, mesh-
attestation.js) into the SAME combined IIFE, and to re-inline the updated
canvas UI module (Excel-style claim fill + adversary note on the Prove tab,
mesh attestation export/compare on the Cartridge tab).

This script REPLACES the existing injected block (bounded by the index.js
ENGINE_MARK/END_MARK and the canvas UI UI_MARK/END_MARK) rather than
inserting a second copy, since canvas/index.html is authoritative and must
never carry two competing window.DataGlowProofHarness publishers. If no
existing markers are found, it falls back to inserting fresh before the
appinstalled anchor (first-run behavior, matching v0/v1's inject scripts).
"""
import re
import sys

CANVAS = 'canvas/index.html'
PROPOSAL_SRC = 'js/proof-harness/proposal.js'
VERDICT_SRC = 'js/proof-harness/verdict.js'
SCORE_SRC = 'js/proof-harness/score-claim.js'
RECEIPT_SRC = 'js/proof-harness/receipt.js'
SECOND_ENGINE_SRC = 'js/proof-harness/second-engine.js'
VAULT_SRC = 'js/proof-harness/vault.js'
CARTRIDGE_SRC = 'js/proof-harness/cartridge.js'
INBOX_SRC = 'js/proof-harness/inbox.js'
ADVERSARY_SRC = 'js/proof-harness/adversary.js'
EXCEL_CLAIM_SRC = 'js/proof-harness/excel-claim.js'
MESH_ATTESTATION_SRC = 'js/proof-harness/mesh-attestation.js'
INDEX_SRC = 'js/proof-harness/index.js'
UI_SRC = 'js/proof-harness/data-glow-proof-harness-canvas.js'

ENGINE_MARK = '/* ---- from js/proof-harness/index.js ---- */'
ENGINE_END_MARK = '/* ---- end js/proof-harness/index.js ---- */'
UI_MARK = '/* ---- from js/proof-harness/data-glow-proof-harness-canvas.js ---- */'
UI_END_MARK = '/* ---- end js/proof-harness/data-glow-proof-harness-canvas.js ---- */'


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def strip_exports(src):
    # Drop import lines (cross-module ESM imports do not resolve when
    # inlined into one script; every symbol they'd import is concatenated
    # into the same IIFE scope below instead).
    src = re.sub(r'^import .*$\n?', '', src, flags=re.M)
    # Strip "export const X = ...", "export function X(...)", "export async
    # function X(...)" -- keeping the declaration body, since everything
    # lands in the same function scope.
    src = re.sub(r'^export const ', 'const ', src, flags=re.M)
    src = re.sub(r'^export function ', 'function ', src, flags=re.M)
    src = re.sub(r'^export async function ', 'async function ', src, flags=re.M)
    # "export { a, b as c } from './x.js';" -- re-exports of symbols already
    # defined earlier in the concatenation; dropped as a no-op.
    src = re.sub(r'^export \{[^}]*\}(?: from [^;]+)?;\s*$\n?', '', src, flags=re.M)
    # "export default X;" -- drop; nothing inside this IIFE needs a default.
    src = re.sub(r'^export default [^;]+;\s*$\n?', '', src, flags=re.M)
    return src


def build_engine_iife():
    parts = [
        PROPOSAL_SRC, VERDICT_SRC, SCORE_SRC, RECEIPT_SRC,
        SECOND_ENGINE_SRC, VAULT_SRC, CARTRIDGE_SRC, INBOX_SRC,
        ADVERSARY_SRC, EXCEL_CLAIM_SRC, MESH_ATTESTATION_SRC,
        INDEX_SRC,
    ]
    bodies = []
    for p in parts:
        src = read(p)
        # index.js's own window-publish tail is dropped; the combined IIFE
        # below publishes window.DataGlowProofHarness once, at the end, with
        # the full v2 method set.
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
        + '    version: 4,\n'
        + '    runProofCycle: runProofCycle,\n'
        + '    confirmProposal: confirmProposal,\n'
        + '    createTypedProposal: createTypedProposal,\n'
        + '    decideVerdict: decideVerdict,\n'
        + '    compareClaimToRun: compareClaimToRun,\n'
        + '    getReceipts: getReceipts,\n'
        + '    verifyReceipts: verifyReceipts,\n'
        + '    resetReceipts: resetReceipts,\n'
        + '    rejectProposal: rejectProposal,\n'
        + '    getVaultTests: getVaultTests,\n'
        + '    getVaultSize: getVaultSize,\n'
        + '    addVaultTest: addVaultTest,\n'
        + '    runVaultCheck: runVaultCheck,\n'
        + '    resetVault: resetVault,\n'
        + '    parseCartridge: parseCartridge,\n'
        + '    verifyCartridgeHash: verifyCartridgeHash,\n'
        + '    serializeCartridge: serializeCartridge,\n'
        + '    createInbox: createInbox,\n'
        + '    statusLabel: statusLabel,\n'
        + '    resolveSecondEngine: resolveSecondEngine,\n'
        + '    VERDICT_STATES: VERDICT_STATES,\n'
        + '    exportCartridge: exportCartridgeWrapped,\n'
        + '    importCartridge: importCartridgeWrapped,\n'
        + '    roundTripCartridge: roundTripCartridge,\n'
        + '    runAdversaryPack: runAdversaryPack,\n'
        + '    buildMetamorphicRewrites: buildMetamorphicRewrites,\n'
        + '    buildBoundaryProbes: buildBoundaryProbes,\n'
        + '    ADVERSARY_MIN_REWRITES: ADVERSARY_MIN_REWRITES,\n'
        + '    parseExcelAggregateClaim: parseExcelAggregateClaim,\n'
        + '    excelClaimToSql: excelClaimToSql,\n'
        + '    excelClaimTextToSql: excelClaimTextToSql,\n'
        + '    exportMeshAttestation: exportMeshAttestation,\n'
        + '    importMeshAttestation: importMeshAttestation,\n'
        + '    compareMeshAttestations: compareMeshAttestations,\n'
        + '    verifyMeshAttestationHash: verifyMeshAttestationHash\n'
        + '  };\n'
        + '  window.DataGlowProofHarness = DataGlowProofHarness;\n'
        + '})();\n'
        + ENGINE_END_MARK + '\n'
    )


def main():
    data = read(CANVAS)

    engine_start = data.find(ENGINE_MARK)
    engine_end = data.find(ENGINE_END_MARK)
    ui_start = data.find(UI_MARK)
    ui_end = data.find(UI_END_MARK)

    engine_block = build_engine_iife()
    ui_block = read(UI_SRC)

    if engine_start != -1 and engine_end != -1 and ui_start != -1 and ui_end != -1:
        # Replace the existing injected block in place, so canvas/index.html
        # never carries two competing publishers.
        ui_end_full = ui_end + len(UI_END_MARK)
        if ui_start < engine_start:
            print('Unexpected marker order (UI before engine); aborting.')
            sys.exit(1)
        new_block = engine_block + '\n' + ui_block + '\n\n'
        data = data[:engine_start] + new_block + data[ui_end_full:]
        open(CANVAS, 'w', encoding='utf-8').write(data)
        print('Replaced existing Proof Harness block with v2 (%d chars).' % len(new_block))
        return

    if engine_start != -1 or ui_start != -1:
        print('Found only one of the two expected marker pairs; aborting to avoid a partial edit.')
        sys.exit(1)

    anchor = "window.addEventListener('appinstalled'"
    idx = data.find(anchor)
    if idx == -1:
        print('Script anchor not found')
        sys.exit(1)

    block = engine_block + '\n' + ui_block + '\n\n'
    data = data[:idx] + block + data[idx:]
    open(CANVAS, 'w', encoding='utf-8').write(data)
    print('Injected %d chars of JS (fresh insert, no prior block found).' % len(block))


if __name__ == '__main__':
    main()
