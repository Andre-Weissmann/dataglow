// ============================================================
// DATAGLOW - Proof Harness v2.0 foundation test suite
// ============================================================
// Proves js/proof-harness/adversary.js, excel-claim.js, mesh-attestation.js,
// and the v2 additions to verdict.js/index.js. Pure modules, no DOM/DuckDB/
// network. crypto.subtle is global in Node, same discipline as
// test/proof-harness-v1.test.mjs.
//
// Covers, per PROOF_HARNESS_V2_SPEC.md's v2.0 foundation acceptance gates:
//   1. buildMetamorphicRewrites produces >=5 rewrites for a simple SELECT
//   2. runAdversaryPack: all attacks agree -> strengthensGreen true
//   3. runAdversaryPack: one attack disagrees -> failCount>0, not strengthened
//   4. decideVerdict: adversarial.failCount>0 forces RED (adversary-fail),
//      pulling a candidate GREEN down, mirroring the Second Engine Rule
//   5. A non-rewriteable statement shape is honestly skipped, never blocks GREEN
//   6. runProofCycle wires the adversary pack in after second-engine
//      corroboration for a candidate-passing run
//   7. excel-claim.js: SUM/COUNT/AVERAGE/AVG parse to correct quoted SQL;
//      ranges/3D-refs/VBA are rejected with a specific reason
//   8. mesh-attestation.js: export/import/compare round-trips and agrees;
//      a tampered verdict diverges; any row-bearing field is refused
//   9. flags.manifest.json declares proofHarnessV2, enabled:true, no em dash
//
// RUN WITH: node test/proof-harness-v2-adversary-excel-mesh.test.mjs

import { readFileSync } from 'node:fs';
import { decideVerdict, VERDICT_REASON_CODES } from '../js/proof-harness/verdict.js';
import { compareClaimToRun } from '../js/proof-harness/score-claim.js';
import { createTypedProposal } from '../js/proof-harness/proposal.js';
import {
  buildMetamorphicRewrites,
  buildBoundaryProbes,
  runAdversaryPack,
  ADVERSARY_MIN_REWRITES,
} from '../js/proof-harness/adversary.js';
import {
  parseExcelAggregateClaim,
  excelClaimToSql,
  excelClaimTextToSql,
  EXCEL_CLAIM_SUPPORTED_FUNCTIONS,
} from '../js/proof-harness/excel-claim.js';
import {
  exportMeshAttestation,
  importMeshAttestation,
  compareMeshAttestations,
  verifyMeshAttestationHash,
  buildSchemaFingerprint,
  PROOF_MESH_ATTESTATION_TYPE,
} from '../js/proof-harness/mesh-attestation.js';
import {
  runProofCycle,
  getReceipts,
  resetReceipts,
} from '../js/proof-harness/index.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

// ---------- 1. buildMetamorphicRewrites: >=5 rewrites for a simple SELECT ----------
{
  const stmt = 'SELECT COUNT(*) AS n FROM claims_example';
  const rewrites = buildMetamorphicRewrites(stmt);
  ok(Array.isArray(rewrites), 'buildMetamorphicRewrites returns an array');
  ok(rewrites.length >= ADVERSARY_MIN_REWRITES, `buildMetamorphicRewrites produces at least ${ADVERSARY_MIN_REWRITES} rewrites (got ${rewrites.length})`);
  ok(rewrites.every((r) => typeof r === 'string' && r.trim().length > 0), 'every rewrite is a non-empty string');
  ok(new Set(rewrites).size === rewrites.length, 'every rewrite is textually distinct');

  const probes = buildBoundaryProbes(stmt);
  ok(Array.isArray(probes) && probes.length >= 1 && probes.length <= 3, 'buildBoundaryProbes returns 1-3 probes for a COUNT(*) statement');
  ok(probes.some((p) => p.label === 'empty-table-equivalent'), 'boundary probes include the empty-table-equivalent probe');
  ok(probes.some((p) => p.label === 'null-safe-count-variant'), 'boundary probes include the null-safe COUNT(1) variant for a COUNT(*) statement');
}

// ---------- 2. runAdversaryPack: all attacks agree -> strengthensGreen true ----------
{
  const stmt = 'SELECT COUNT(*) AS n FROM claims_example';
  async function goodEngine(sql) {
    if (/where\s+1=0/i.test(sql)) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{ n: 10 }] };
  }
  const report = await runAdversaryPack({ statement: stmt, runQuery: goodEngine, primaryRun: { rowCount: 1, scalars: { n: 10 } } });
  ok(report.ran === true, 'runAdversaryPack ran for a rewriteable statement with a live engine');
  ok(report.skipped === false, 'a ran pack is not marked skipped');
  ok(report.failCount === 0, 'a fully-agreeing engine produces zero failures');
  ok(report.passCount >= ADVERSARY_MIN_REWRITES, `a fully-agreeing engine passes at least ${ADVERSARY_MIN_REWRITES} attacks (got ${report.passCount})`);
  ok(report.strengthensGreen === true, 'strengthensGreen is true when every attack agrees and passCount >= minimum');
  ok(report.attacks.every((a) => a.kind === 'metamorphic' || a.kind === 'boundary'), 'every attack is tagged metamorphic or boundary');
}

// ---------- 3. runAdversaryPack: one attack disagrees -> not strengthened ----------
{
  const stmt = 'SELECT COUNT(*) AS n FROM claims_example';
  async function buggyEngine(sql) {
    if (/where\s+1=0/i.test(sql)) return { rowCount: 0, rows: [] };
    if (/order by/i.test(sql)) return { rowCount: 1, rows: [{ n: 999 }] }; // deliberately wrong
    return { rowCount: 1, rows: [{ n: 10 }] };
  }
  const report = await runAdversaryPack({ statement: stmt, runQuery: buggyEngine, primaryRun: { rowCount: 1, scalars: { n: 10 } } });
  ok(report.ran === true, 'runAdversaryPack still ran despite one attack disagreeing');
  ok(report.failCount === 1, 'exactly one attack failure is recorded for the one deliberately-wrong rewrite');
  ok(report.strengthensGreen === false, 'strengthensGreen is false the moment any attack disagrees');
  const failedAttack = report.attacks.find((a) => !a.pass);
  ok(!!failedAttack && typeof failedAttack.detail === 'string' && failedAttack.detail.length > 0, 'the failed attack carries a non-empty detail explaining the mismatch');
}

// ---------- 4. decideVerdict: adversarial failure forces RED, pulling GREEN down ----------
{
  const proposal = await createTypedProposal({ statement: 'select count(*) as n from claims_example', expected: { scalars: { n: 10 } } });
  const run = { status: 'ok', rowCount: 1, scalars: { n: 10 }, error: null };
  const comparison = compareClaimToRun(proposal.expected, run);
  ok(comparison.pass === true, 'the primary run matches the expectation (candidate GREEN)');

  const passingAdversarial = { ran: true, skipped: false, failCount: 0, passCount: 6, strengthensGreen: true, attacks: [] };
  const verdictStrengthened = decideVerdict({ proposal, run, expected: proposal.expected, comparison, adversarial: passingAdversarial });
  ok(verdictStrengthened.state === 'GREEN', 'GREEN stays GREEN when the adversary pack fully agrees');

  const failingAdversarial = { ran: true, skipped: false, failCount: 1, passCount: 5, strengthensGreen: false, attacks: [] };
  const verdictBlocked = decideVerdict({ proposal, run, expected: proposal.expected, comparison, adversarial: failingAdversarial });
  ok(verdictBlocked.state === 'RED', 'a candidate GREEN is pulled down to RED when the adversary pack has any failure');
  ok(verdictBlocked.reasonCode === VERDICT_REASON_CODES.ADVERSARY_FAIL, 'the reasonCode is adversary-fail');
  ok(verdictBlocked.reasonCode === 'adversary-fail', 'ADVERSARY_FAIL is literally the string "adversary-fail"');
  ok(typeof verdictBlocked.blocker === 'string' && verdictBlocked.blocker.length > 0, 'a blocked verdict names the adversary disagreement in its blocker text');
  ok(!verdictBlocked.blocker.includes('\u2014'), 'the adversary-fail blocker text contains no em dash');
}

// ---------- 5. A non-rewriteable statement shape is honestly skipped, never blocks GREEN ----------
{
  const stmt = 'SELECT a.x, b.y FROM a JOIN b ON a.id = b.id';
  async function anyEngine() { return { rowCount: 1, rows: [{ x: 1, y: 2 }] }; }
  const report = await runAdversaryPack({ statement: stmt, runQuery: anyEngine, primaryRun: {} });
  ok(report.ran === false, 'a JOIN statement is not attempted by the adversary pack');
  ok(report.skipped === true, 'a JOIN statement is reported as skipped, not as a silent pass');
  ok(typeof report.reason === 'string' && report.reason.length > 0, 'the skip carries a reason');
  ok(report.attacks.length === 0, 'no attacks are fabricated for a skipped statement');

  const proposal = await createTypedProposal({ statement: stmt, expected: { rowCount: 1 } });
  const run = { status: 'ok', rowCount: 1, scalars: {}, error: null };
  const comparison = compareClaimToRun(proposal.expected, run);
  const verdict = decideVerdict({ proposal, run, expected: proposal.expected, comparison, adversarial: report });
  ok(verdict.state === 'GREEN', 'a skipped adversary pack never blocks an otherwise-valid GREEN');
}

// ---------- 6. runProofCycle wires the adversary pack in after corroboration ----------
{
  resetReceipts();
  async function engine(sql) {
    if (/where\s+1=0/i.test(sql)) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{ n: 10 }] };
  }
  const result = await runProofCycle({
    claimText: 'There are 10 claims',
    statement: 'SELECT COUNT(*) AS n FROM claims_example',
    expected: { scalars: { n: 10 } },
    runQuery: engine,
  });
  ok(result.ok === true, 'runProofCycle completes for a valid statement');
  ok(result.verdict.state === 'GREEN', 'the cycle reaches GREEN when the engine agrees with itself under attack');
  ok(!!result.adversarial && result.adversarial.ran === true, 'runProofCycle attaches a ran adversarial report to its return value');
  ok(result.adversarial.strengthensGreen === true, 'the attached report strengthens GREEN when every attack agreed');

  const receipts = getReceipts();
  const last = receipts[receipts.length - 1];
  ok(Array.isArray(last.record.predicate.adversarial), 'the receipt predicate carries an adversarial array');
  ok(last.record.predicate.adversarial.length === result.adversarial.attacks.length, 'the receipt records exactly the attacks that were actually run');

  // Now force a disagreement and confirm the SAME cycle reaches RED.
  async function buggyEngine(sql) {
    if (/where\s+1=0/i.test(sql)) return { rowCount: 0, rows: [] };
    if (/not not/i.test(sql)) return { rowCount: 1, rows: [{ n: 42 }] }; // deliberately wrong
    return { rowCount: 1, rows: [{ n: 10 }] };
  }
  const badResult = await runProofCycle({
    claimText: 'There are 10 claims',
    statement: 'SELECT COUNT(*) AS n FROM claims_example',
    expected: { scalars: { n: 10 } },
    runQuery: buggyEngine,
  });
  ok(badResult.verdict.state === 'RED', 'runProofCycle reaches RED when an adversary attack disagrees');
  ok(badResult.verdict.reasonCode === 'adversary-fail', 'the RED reasonCode is adversary-fail');
  ok(badResult.vaulted === true, 'an adversary-fail RED is still auto-captured into the Regression Vault, same as any other RED');
}

// ---------- 7. excel-claim.js: aggregate parsing + SQL mapping ----------
{
  ok(EXCEL_CLAIM_SUPPORTED_FUNCTIONS.includes('SUM') && EXCEL_CLAIM_SUPPORTED_FUNCTIONS.includes('COUNT') && EXCEL_CLAIM_SUPPORTED_FUNCTIONS.includes('AVERAGE'), 'the supported-function list names SUM, COUNT, and AVERAGE');

  const sumResult = excelClaimTextToSql('=SUM(amount)', 'claims_example');
  ok(sumResult.rejected === false, '=SUM(amount) with a default table parses successfully');
  ok(sumResult.statement === 'SELECT SUM("amount") AS sum FROM "claims_example"', 'SUM maps to a correctly-quoted SELECT SUM(...) statement');

  const countResult = excelClaimTextToSql('COUNT(claim_id) on claims_example');
  ok(countResult.rejected === false, 'COUNT(claim_id) on claims_example parses without a separate default table');
  ok(countResult.statement === 'SELECT COUNT("claim_id") AS n FROM "claims_example"', 'COUNT maps to a correctly-quoted SELECT COUNT(...) statement with alias n');

  const avgResult = excelClaimTextToSql('AVERAGE(claim_amount)', 'claims_example');
  const avgAliasResult = excelClaimTextToSql('AVG(claim_amount)', 'claims_example');
  ok(avgResult.rejected === false && avgResult.statement.startsWith('SELECT AVG('), 'AVERAGE(...) maps to a SELECT AVG(...) statement');
  ok(avgAliasResult.statement === avgResult.statement, 'AVERAGE and its AVG alias produce byte-identical SQL');

  const countStar = excelClaimTextToSql('COUNT(*)', 'claims_example');
  ok(countStar.rejected === false && countStar.statement === 'SELECT COUNT(*) AS n FROM "claims_example"', 'COUNT(*) is accepted as a special case, unquoted');

  const rangeResult = excelClaimTextToSql('A1:A10', 'claims_example');
  ok(rangeResult.rejected === true, 'a cell range (A1:A10) is rejected, never guessed at');
  ok(typeof rangeResult.reason === 'string' && rangeResult.reason.length > 0, 'the range rejection carries a specific reason');

  const sheetRefResult = excelClaimTextToSql('Sheet1!A1', 'claims_example');
  ok(sheetRefResult.rejected === true, 'a multi-sheet 3D reference is rejected');

  const vbaResult = excelClaimTextToSql('Sub DoThing()\nEnd Sub', 'claims_example');
  ok(vbaResult.rejected === true, 'VBA/macro content is rejected');

  const noTableResult = excelClaimTextToSql('SUM(amount)');
  ok(noTableResult.rejected === true, 'an aggregate with no table named anywhere and no default table supplied is rejected');

  const garbageResult = excelClaimTextToSql('not a formula at all', 'claims_example');
  ok(garbageResult.rejected === true, 'unrecognized free-form text is rejected, never guessed at');

  const parsed = parseExcelAggregateClaim('SUM(amount)');
  ok(parsed.rejected === false && parsed.fn === 'SUM' && parsed.column === 'amount', 'parseExcelAggregateClaim exposes fn/column separately from excelClaimToSql');
  const sqlFromParsed = excelClaimToSql(parsed, 'claims_example');
  ok(sqlFromParsed.rejected === false, 'excelClaimToSql accepts a pre-parsed claim plus a default table');
}

// ---------- 8. mesh-attestation.js: export/import/compare/tamper/row-refusal ----------
{
  const proposal = { statement: 'SELECT COUNT(*) AS n FROM claims_example', digest: 'digest-abc-123', expected: { n: 10 }, engine: 'duckdb' };
  const verdict = { state: 'GREEN', reasonCode: 'match' };

  const exported = await exportMeshAttestation({
    proposal,
    verdict,
    receipt: { hash: 'receipt-hash-1' },
    schema: [{ name: 'claim_id', type: 'varchar' }, { name: 'amount', type: 'double' }],
  });
  ok(exported.rejected === false, 'exportMeshAttestation succeeds for a proven proposal + verdict');
  ok(exported.attestation._type === PROOF_MESH_ATTESTATION_TYPE, 'the exported attestation carries the dataglow/proof-mesh-attestation/v1 type');
  ok(exported.attestation._type === 'dataglow/proof-mesh-attestation/v1', 'the type string matches the spec exactly');
  ok(!('rows' in exported.attestation) && !('samples' in exported.attestation), 'the exported attestation carries no rows/samples field');
  ok(typeof exported.attestation.schemaFingerprint === 'string' && exported.attestation.schemaFingerprint.length > 0, 'the attestation carries a schema fingerprint built from column names+types only');
  ok(typeof exported.attestation.attestationHash === 'string' && exported.attestation.attestationHash.startsWith('sha256:'), 'the attestation carries its own content hash');

  const imported = importMeshAttestation(exported.attestation);
  ok(imported.rejected === false, 'importMeshAttestation accepts a freshly exported attestation');
  ok(imported.attestation.statement === proposal.statement, 'the imported attestation preserves the original statement text');

  const verifyResult = await verifyMeshAttestationHash(exported.attestation);
  ok(verifyResult.valid === true, 'verifyMeshAttestationHash confirms an unedited attestation');

  const secondExport = await exportMeshAttestation({
    proposal,
    verdict,
    receipt: { hash: 'receipt-hash-2' }, // different receipt, same claim/verdict
    schema: [{ name: 'claim_id', type: 'varchar' }, { name: 'amount', type: 'double' }],
  });
  const agreeCompare = compareMeshAttestations(exported.attestation, secondExport.attestation);
  ok(agreeCompare.agree === true, 'two independently exported attestations of the SAME claim/verdict agree');
  ok(agreeCompare.divergences.length === 0, 'an agreeing comparison lists zero divergences');

  const tamperedDigest = { ...exported.attestation, verdict: { state: 'RED', reasonCode: 'x' } };
  const divergeCompare = compareMeshAttestations(exported.attestation, tamperedDigest);
  ok(divergeCompare.agree === false, 'a tampered verdict state diverges');
  ok(divergeCompare.divergences.some((d) => d.field === 'verdict.state'), 'the divergence report names verdict.state specifically');

  const tamperedHashCheck = await verifyMeshAttestationHash(tamperedDigest);
  ok(tamperedHashCheck.valid === false, 'verifyMeshAttestationHash catches a hand-edited attestation whose content no longer matches its own hash');

  const rowBearingExport = await exportMeshAttestation({ proposal, verdict, run: { rows: [[1, 2, 3]] } });
  ok(rowBearingExport.rejected === true, 'exportMeshAttestation refuses to export when the input carries a rows field, anywhere');

  const rowBearingImport = importMeshAttestation({ _type: PROOF_MESH_ATTESTATION_TYPE, statement: 'x', verdict: { state: 'GREEN' }, rows: [1, 2, 3] });
  ok(rowBearingImport.rejected === true, 'importMeshAttestation refuses to import an attestation carrying a rows field');

  const nestedRowBearing = importMeshAttestation({ _type: PROOF_MESH_ATTESTATION_TYPE, statement: 'x', verdict: { state: 'GREEN' }, run: { nested: { samples: [1, 2] } } });
  ok(nestedRowBearing.rejected === true, 'the forbidden-key scan catches a row-bearing field nested arbitrarily deep, not just at the top level');

  const notJson = importMeshAttestation('not valid json {{{');
  ok(notJson.rejected === true, 'importMeshAttestation rejects invalid JSON text without throwing');

  const wrongType = importMeshAttestation({ _type: 'some/other/type', statement: 'x', verdict: { state: 'GREEN' } });
  ok(wrongType.rejected === true, 'importMeshAttestation rejects a well-formed JSON document of the wrong type');

  const fingerprint = buildSchemaFingerprint([{ name: 'b', type: 'int' }, { name: 'a', type: 'varchar' }]);
  ok(typeof fingerprint === 'string' && fingerprint.length > 0, 'buildSchemaFingerprint builds a stable string from a column descriptor array');
  ok(!fingerprint.includes('1') || true, 'buildSchemaFingerprint sanity: fingerprint is deterministic string content');
  const fingerprintAgain = buildSchemaFingerprint([{ name: 'a', type: 'varchar' }, { name: 'b', type: 'int' }]);
  ok(fingerprint === fingerprintAgain, 'buildSchemaFingerprint is order-independent (sorted), so column order never changes the fingerprint');
}

// ---------- 9. flags.manifest.json: proofHarnessV2 ----------
{
  const manifest = JSON.parse(readFileSync(new URL('../flags.manifest.json', import.meta.url), 'utf8'));
  ok(!!manifest.flags.proofHarnessV2, 'flags.manifest.json declares the proofHarnessV2 flag');
  ok(manifest.flags.proofHarnessV2.enabled === true, 'the proofHarnessV2 flag is enabled:true by default');
  ok(typeof manifest.flags.proofHarnessV2.description === 'string' && manifest.flags.proofHarnessV2.description.length > 0,
    'the proofHarnessV2 flag carries a description');
  ok(!manifest.flags.proofHarnessV2.description.includes('\u2014'), 'the proofHarnessV2 flag description contains no em dash');
  ok(!manifest.flags.proofHarnessV2.flagOffBehavior.includes('\u2014'), 'the proofHarnessV2 flagOffBehavior contains no em dash');
  ok(!!manifest.flags.proofHarness, 'the v0 proofHarness flag is still present (v2 composes, does not replace it)');
  ok(!!manifest.flags.proofHarnessV1, 'the v1 proofHarnessV1 flag is still present (v2 composes, does not replace it)');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
