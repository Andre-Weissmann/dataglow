// ============================================================
// DATAGLOW - Hotfix test: mesh export rejects on full receipt (nested rows)
// ============================================================
// WHY THIS EXISTS
// HOTFIX_MESH_RECEIPT_STRIP_SPEC.md: onMeshExport() in
// js/proof-harness/data-glow-proof-harness-canvas.js used to pass
// `receipt: _lastResult.receipt` -- the FULL receipt ledger entry
// ({index, prevHash, hash, ts, record: {predicate: {inputs, run,
// corroboration, adversarial, ...}}}), not a {hash} shape -- straight into
// exportMeshAttestation(). mesh-attestation.js's forbidden-key scan walks
// the entire input tree and refuses ANY payload carrying a rows/samples/
// csv/cells/sheetData key anywhere, so a ledger entry whose predicate.inputs
// (or run/corroboration/adversarial) happens to carry one of those keys
// causes every mesh export to be rejected.
//
// This suite builds a REAL ledger entry via receipt.js's own
// createReceiptLedger()/buildReceiptPredicate() (not a hand-rolled stand-in)
// to prove:
//   1. passing that entry WHOLE as `receipt` is rejected (reproduces the bug
//      exactly as diagnosed);
//   2. reducing it to `{ hash: entry.hash }` first (the fix) succeeds and
//      the resulting attestation's receiptHash matches;
//   3. a receipt with no string .hash still exports with receiptHash: null
//      (existing mesh-attestation.js contract, unaffected by the fix);
//   4. a proposal.expected that itself carries a forbidden key is refused
//      by the module regardless (defense-in-depth double-check for the
//      canvas's own belt-and-suspenders proposal-stripping logic).
//
// PURITY: no DOM. crypto.subtle is global in Node, same discipline as every
// other proof-harness test file.
//
// RUN WITH: node test/hotfix-mesh-receipt-strip.test.mjs

import { createReceiptLedger, buildReceiptPredicate } from '../js/proof-harness/receipt.js';
import { exportMeshAttestation } from '../js/proof-harness/mesh-attestation.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

const proposal = {
  statement: 'SELECT COUNT(*) AS n FROM claims_example',
  digest: 'digest-mesh-hotfix-1',
  expected: { n: 10 },
  engine: 'duckdb',
};
const verdict = { state: 'GREEN', reasonCode: 'match' };

// ---------- Build a REAL ledger entry whose predicate.inputs carries rows ----------
const ledger = createReceiptLedger();
const predicate = buildReceiptPredicate({
  claim: { text: 'count of claims', predicate_ast: null, metric_ids: [] },
  proposal: { engine: 'duckdb', statement: proposal.statement, expected: proposal.expected, author: 'ai', model_id: null, digest: proposal.digest },
  // predicate.inputs: a free-form per-input descriptor array. This is
  // exactly the kind of field that can carry a `rows` key without any
  // single call site "meaning" to put it there (see SPEC).
  inputs: [{ name: 'claims_example', rows: [[1, 2, 3], [4, 5, 6]] }],
  run: { status: 'ok', rowcount: 1, scalars: { n: 10 }, column_types: {}, duration_ms: 5, error: null },
  corroboration: null,
  adversarial: [],
  environment: { engine_build: 'duckdb', app_version: 'proof-harness-v2' },
  verdict: { state: verdict.state, reason_code: verdict.reasonCode, blocker: null },
});
let realLedgerEntry;

async function run() {
  realLedgerEntry = await ledger.append({ subjectName: 'claims_example', subjectDigest: proposal.digest, predicate });

  ok(typeof realLedgerEntry.hash === 'string' && realLedgerEntry.hash.length > 0, 'the real receipt ledger entry carries a string .hash');
  ok(Array.isArray(realLedgerEntry.record.predicate.inputs) && 'rows' in realLedgerEntry.record.predicate.inputs[0], 'sanity: the ledger entry used in this test really does carry a nested rows field in predicate.inputs, matching the diagnosed shape');

  // ---------- 1. Passing the FULL ledger entry as `receipt` reproduces the bug ----------
  {
    const exportedFull = await exportMeshAttestation({
      proposal,
      verdict,
      receipt: realLedgerEntry, // the pre-fix call shape: the whole ledger entry
    });
    ok(exportedFull.rejected === true, 'exportMeshAttestation REJECTS when the full receipt ledger entry (with nested predicate.inputs[].rows) is passed as `receipt` -- reproduces the bug exactly as diagnosed');
    ok(typeof exportedFull.reason === 'string' && /rows/.test(exportedFull.reason), 'the rejection reason names the offending "rows" field');
  }

  // ---------- 2. The fix: reduce receipt to { hash } before exporting ----------
  {
    const safeReceipt = (realLedgerEntry && typeof realLedgerEntry.hash === 'string')
      ? { hash: realLedgerEntry.hash }
      : null;
    ok(safeReceipt && Object.keys(safeReceipt).length === 1, 'the hash-only extraction produces an object with exactly one key');

    const exportedSafe = await exportMeshAttestation({
      proposal,
      verdict,
      receipt: safeReceipt,
      environment: {},
    });
    ok(exportedSafe.rejected === false, 'exportMeshAttestation SUCCEEDS when the same receipt is reduced to {hash} first -- proves the hotfix extraction fixes the export');
    ok(exportedSafe.attestation.receiptHash === realLedgerEntry.hash, 'the exported attestation carries the exact same receiptHash as the original (real) ledger entry -- no information the module actually uses was lost');
    ok(!('rows' in JSON.parse(JSON.stringify(exportedSafe.attestation))) , 'the exported attestation itself carries no rows key');
    ok(JSON.stringify(exportedSafe.attestation).indexOf('"rows"') === -1, 'the serialized attestation contains no "rows" key anywhere in its JSON text');
  }

  // ---------- 3. receipt present but no string .hash -> receiptHash: null (unaffected contract) ----------
  {
    const exportedNoHash = await exportMeshAttestation({ proposal, verdict, receipt: {} });
    ok(exportedNoHash.rejected === false, 'a receipt object with no .hash still exports successfully');
    ok(exportedNoHash.attestation.receiptHash === null, 'receiptHash is null when the receipt carries no string hash, matching mesh-attestation.js\'s existing contract');

    const exportedNullReceipt = await exportMeshAttestation({ proposal, verdict, receipt: null });
    ok(exportedNullReceipt.rejected === false, 'a null receipt still exports successfully');
    ok(exportedNullReceipt.attestation.receiptHash === null, 'receiptHash is null when receipt is null');
  }

  // ---------- 4. proposal.expected carrying a forbidden key is still refused (defense-in-depth) ----------
  {
    const badProposal = { ...proposal, expected: { n: 10, rows: [[1]] } };
    const exportedBadProposal = await exportMeshAttestation({ proposal: badProposal, verdict, receipt: { hash: realLedgerEntry.hash } });
    ok(exportedBadProposal.rejected === true, 'exportMeshAttestation still refuses when proposal.expected itself carries a forbidden rows key, independent of the receipt fix');
  }

  // ---------- 5. safeRun-style summary (rowCount/scalars only) + hash-only receipt together succeed ----------
  {
    const safeRun = { status: 'ok', rowCount: 1, scalars: { n: 10 }, error: null };
    const exportedFullSafe = await exportMeshAttestation({
      proposal,
      verdict,
      run: safeRun,
      receipt: { hash: realLedgerEntry.hash },
      environment: {},
    });
    ok(exportedFullSafe.rejected === false, 'the full canvas-shaped safe payload (safeProposal-equivalent + safeRun + hash-only receipt + empty environment) exports successfully end to end');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
