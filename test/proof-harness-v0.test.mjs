// ============================================================
// DATAGLOW - Proof Harness v0 (VERDICT) test suite
// ============================================================
// Proves js/proof-harness/*: pure modules, no DOM/DuckDB/network. crypto.subtle
// is global in Node (same discipline as test/trust-ledger.test.mjs), so
// createTypedProposal/receipt hashing runs identically here and in a browser.
//
// Covers, per the ticket:
//   - proposal digest (stable, changes when statement changes, free-form
//     execution rejected)
//   - verdict green / red / gray
//   - receipt chain (append-only, hash-chained, tamper detection)
//   - confirm invalidate (digest-bound; a post-confirm edit invalidates it)
//   - flag present in flags.manifest.json
//
// RUN WITH: node test/proof-harness-v0.test.mjs

import { readFileSync } from 'node:fs';
import {
  createTypedProposal,
  validateProposalInput,
  digestProposal,
  proposalMatchesDigest,
  PROOF_HARNESS_SUPPORTED_ENGINES,
} from '../js/proof-harness/proposal.js';
import {
  decideVerdict,
  VERDICT_STATES,
  VERDICT_REASON_CODES,
} from '../js/proof-harness/verdict.js';
import {
  scalarMatches,
  extractRowCount,
  extractScalar,
  compareClaimToRun,
} from '../js/proof-harness/score-claim.js';
import {
  createReceiptLedger,
  verifyReceiptChain,
  buildReceiptPredicate,
  GENESIS_PARENT,
} from '../js/proof-harness/receipt.js';
import {
  runProofCycle,
  confirmProposal,
  getReceipts,
  verifyReceipts,
  resetReceipts,
} from '../js/proof-harness/index.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

// ---------- proposal: reject free-form / invalid input ----------
{
  const badTypes = [null, undefined, 'select 1', 42, ['select 1']];
  for (const bad of badTypes) {
    const v = validateProposalInput(bad);
    ok(v.valid === false, `validateProposalInput rejects non-object input (${JSON.stringify(bad)})`);
  }
  const noStatement = validateProposalInput({ engine: 'duckdb' });
  ok(noStatement.valid === false, 'validateProposalInput rejects a proposal with no statement');

  const badEngine = validateProposalInput({ statement: 'select 1', engine: 'sqlite' });
  ok(badEngine.valid === false, 'validateProposalInput rejects an unsupported engine');
  ok(PROOF_HARNESS_SUPPORTED_ENGINES.includes('duckdb'), 'duckdb is a supported engine');

  const rejectedProposal = await createTypedProposal('select 1 as x');
  ok(rejectedProposal.rejected === true, 'createTypedProposal rejects a bare string instead of an object (no free-form execution)');
}

// ---------- proposal: digest is stable and content-bound ----------
{
  const p1 = await createTypedProposal({ statement: 'select count(*) as n from t', engine: 'duckdb', expected: { rowCount: 1 } });
  ok(p1.rejected === false, 'a well-formed proposal is accepted');
  ok(typeof p1.digest === 'string' && p1.digest.startsWith('sha256:'), 'proposal carries a sha256-prefixed digest');

  const p2 = await createTypedProposal({ statement: 'select count(*) as n from t', engine: 'duckdb', expected: { rowCount: 1 } });
  ok(p1.digest === p2.digest, 'two proposals with identical statement/engine/expected/tables produce the same digest');

  const p3 = await createTypedProposal({ statement: 'select count(*) as n from t2', engine: 'duckdb', expected: { rowCount: 1 } });
  ok(p1.digest !== p3.digest, 'changing the statement changes the digest');

  const p4a = await createTypedProposal({ statement: 'select 1', engine: 'duckdb', author: 'ai' });
  const p4b = await createTypedProposal({ statement: 'select 1', engine: 'duckdb', author: 'human' });
  ok(p4a.digest === p4b.digest, 'author does not affect the digest (same executable content = same digest)');

  const recomputed = await digestProposal(p1);
  ok(recomputed === p1.digest, 'digestProposal recomputes the same digest from the proposal fields');

  const stillMatches = await proposalMatchesDigest(p1);
  ok(stillMatches === true, 'proposalMatchesDigest is true for an unedited proposal');

  const edited = { ...p1, statement: 'select count(*) as n from t where 1=0' };
  const nowMismatched = await proposalMatchesDigest(edited);
  ok(nowMismatched === false, 'proposalMatchesDigest is false after the statement is edited without redigesting');
}

// ---------- verdict: GREEN ----------
{
  const proposal = await createTypedProposal({ statement: 'select count(*) as n from t', expected: { rowCount: 5 } });
  const run = { status: 'ok', rowCount: 5, error: null };
  const comparison = compareClaimToRun(proposal.expected, run);
  ok(comparison.pass === true, 'compareClaimToRun passes when rowCount matches expected');
  const verdict = decideVerdict({ proposal, run, expected: proposal.expected, comparison });
  ok(verdict.state === 'GREEN', 'decideVerdict returns GREEN when the run matches the expectation');
  ok(verdict.blocker === null, 'a GREEN verdict carries no blocker');
  ok(!('confidence' in verdict), 'verdict never carries a confidence field (doctrine: no confidence percentages on verdicts)');
}

// ---------- verdict: RED (mismatch) ----------
{
  const proposal = await createTypedProposal({ statement: 'select count(*) as n from t', expected: { rowCount: 5 } });
  const run = { status: 'ok', rowCount: 3, error: null };
  const comparison = compareClaimToRun(proposal.expected, run);
  ok(comparison.pass === false, 'compareClaimToRun fails when rowCount does not match');
  const verdict = decideVerdict({ proposal, run, expected: proposal.expected, comparison });
  ok(verdict.state === 'RED', 'decideVerdict returns RED when the run contradicts the expectation');
  ok(typeof verdict.blocker === 'string' && verdict.blocker.length > 0, 'a RED verdict names what mismatched');
}

// ---------- verdict: RED (engine error) ----------
{
  const proposal = await createTypedProposal({ statement: 'select * from missing_table', expected: { rowCount: 1 } });
  const run = { status: 'error', rowCount: null, error: 'Table with name missing_table does not exist' };
  const verdict = decideVerdict({ proposal, run, expected: proposal.expected });
  ok(verdict.state === 'RED', 'decideVerdict returns RED when the engine could not execute the statement');
  ok(verdict.reasonCode === VERDICT_REASON_CODES.RUN_ERROR, 'a run error carries the run-error reason code');
}

// ---------- verdict: GRAY (no run yet) ----------
{
  const proposal = await createTypedProposal({ statement: 'select 1', expected: { rowCount: 1 } });
  const verdict = decideVerdict({ proposal, run: null, expected: proposal.expected });
  ok(verdict.state === 'GRAY', 'decideVerdict returns GRAY when the proposal has not been run yet');
  ok(typeof verdict.blocker === 'string' && verdict.blocker.length > 0, 'a GRAY verdict names the blocker');
}

// ---------- verdict: GRAY (no expectation to check) ----------
{
  const proposal = await createTypedProposal({ statement: 'select 1' });
  const run = { status: 'ok', rowCount: 1, error: null };
  const verdict = decideVerdict({ proposal, run, expected: proposal.expected });
  ok(verdict.state === 'GRAY', 'decideVerdict returns GRAY when nothing was specified to check the run against');
  ok(verdict.reasonCode === VERDICT_REASON_CODES.NO_EXPECTATION, 'the GRAY carries the no-expectation reason code');
}

// ---------- verdict: GRAY (no proposal) ----------
{
  const verdict = decideVerdict({ proposal: null, run: null, expected: null });
  ok(verdict.state === 'GRAY', 'decideVerdict returns GRAY when there is no proposal at all');
  ok(VERDICT_STATES.includes(verdict.state), 'the returned state is one of the closed VERDICT_STATES vocabulary');
  // v0 shipped GREEN/RED/GRAY only; v1 (test/proof-harness-v1.test.mjs) adds the
  // fourth doctrine state, AMBER, for staleness only, via an opt-in `staleness`
  // input this same decideVerdict() now also accepts. Nothing in this v0 suite
  // exercises staleness, so every assertion in this file still resolves to
  // GREEN/RED/GRAY exactly as before -- this line just stops pinning AMBER's
  // absence now that v1 has intentionally added it to the closed vocabulary.
  ok(VERDICT_STATES.includes('AMBER'), 'VERDICT_STATES now includes AMBER, added in v1 for staleness only');
}

// ---------- score-claim: scalarMatches / extract helpers ----------
{
  ok(scalarMatches(5, 5) === true, 'scalarMatches: identical numbers match');
  ok(scalarMatches(5, 5.0000001) === true, 'scalarMatches: numbers within epsilon match');
  ok(scalarMatches(5, 5.1) === false, 'scalarMatches: numbers outside epsilon do not match');
  ok(scalarMatches('abc', ' abc ') === true, 'scalarMatches: strings match after trim');
  ok(scalarMatches('abc', 'abd') === false, 'scalarMatches: different strings do not match');
  ok(extractRowCount({ rows: [1, 2, 3] }) === 3, 'extractRowCount reads rows.length from a DuckDB-shaped result');
  ok(extractRowCount([1, 2]) === 2, 'extractRowCount reads length from a bare array result');
  ok(extractRowCount(null) === null, 'extractRowCount never throws on null, returns null');
  ok(extractScalar({ columns: ['n'], rows: [{ n: 42 }] }, 'n') === 42, 'extractScalar reads a named column from an object row');
  ok(extractScalar({ columns: ['n'], rows: [[42]] }, 'n') === 42, 'extractScalar reads a named column from an array row via column index');
}

// ---------- receipt: append-only hash chain ----------
{
  const receiptLedger = createReceiptLedger();
  ok(receiptLedger.size === 0, 'a new receipt ledger starts empty');

  const r1 = await receiptLedger.append({ subjectName: 'claim-1', predicate: buildReceiptPredicate({ claim: { text: 'revenue is 100' } }) });
  ok(r1.index === 0, 'the first receipt is index 0');
  ok(r1.prevHash === GENESIS_PARENT, 'the first receipt chains from GENESIS_PARENT');
  ok(typeof r1.hash === 'string' && r1.hash.length === 64, 'each receipt carries a 64-char hex sha256 hash');
  ok(r1.record._type === 'dataglow/receipt/v1', 'the receipt record carries the dataglow/receipt/v1 type');

  const r2 = await receiptLedger.append({ subjectName: 'claim-2', predicate: buildReceiptPredicate({ claim: { text: 'revenue is 200' } }) });
  ok(r2.index === 1, 'the second receipt is index 1');
  ok(r2.prevHash === r1.hash, 'the second receipt chains from the first receipt\'s hash');
  ok(receiptLedger.size === 2, 'the ledger size reflects both appended receipts');

  const verify1 = await verifyReceiptChain(receiptLedger.getEntries());
  ok(verify1.valid === true, 'an untouched receipt chain verifies as valid');

  // Tamper with a record after the fact and confirm the chain catches it.
  const tampered = receiptLedger.getEntries();
  tampered[0].record.predicate.claim.text = 'revenue is 999 (tampered)';
  const verify2 = await verifyReceiptChain(tampered);
  ok(verify2.valid === false, 'a tampered receipt chain fails verification');
  ok(verify2.brokenAt === 0, 'verification reports the tampered index');

  // No update/remove mutator is exposed besides append/clear.
  const exposedKeys = Object.keys(receiptLedger).sort();
  ok(!exposedKeys.includes('update') && !exposedKeys.includes('remove') && !exposedKeys.includes('set'),
    'the receipt ledger exposes no update/remove/set mutator, only append (and clear for a fresh session)');
}

// ---------- confirm: digest-bound; byte-change invalidates ----------
{
  const proposal = await createTypedProposal({ statement: 'select count(*) as n from t', expected: { rowCount: 5 } });
  const confirmed = await confirmProposal(proposal, { by: 'local-user' });
  ok(confirmed.confirmed === true, 'confirmProposal succeeds for an unedited proposal');
  ok(confirmed.boundDigest === proposal.digest, 'the confirm record is bound to the proposal\'s digest');
  ok(typeof confirmed.at === 'string' && !Number.isNaN(Date.parse(confirmed.at)), 'the confirm record carries a valid ISO8601 timestamp');

  const editedProposal = { ...proposal, statement: 'select count(*) as n from t where flag=1' };
  const invalidated = await confirmProposal(editedProposal, { by: 'local-user' });
  ok(invalidated.confirmed === false, 'confirmProposal fails once the statement changed after the digest was computed');
  ok(typeof invalidated.reason === 'string' && invalidated.reason.length > 0, 'an invalidated confirm explains why');
}

// ---------- end-to-end: runProofCycle wires proposal -> run -> verdict -> receipt ----------
{
  resetReceipts();
  const fakeRunQuery = async (sql) => {
    ok(typeof sql === 'string' && sql.length > 0, 'runProofCycle hands the executor a real SQL string, never an object');
    return { columns: [{ name: 'n' }], rows: [{ n: 7 }], rowCount: 1 };
  };
  const cycle = await runProofCycle({
    claimText: 'there is exactly 1 row',
    statement: 'select 7 as n',
    engine: 'duckdb',
    expected: { rowCount: 1 },
    runQuery: fakeRunQuery,
  });
  ok(cycle.ok === true, 'runProofCycle completes successfully end to end');
  ok(cycle.verdict.state === 'GREEN', 'the end-to-end cycle reaches GREEN when the run matches the expectation');
  ok(cycle.receipt && typeof cycle.receipt.hash === 'string', 'runProofCycle appends a receipt with a hash');
  ok(getReceipts().length === 1, 'the session receipt ledger now holds the one appended receipt');

  const verify = await verifyReceipts();
  ok(verify.valid === true, 'the session receipt chain verifies after an end-to-end prove cycle');

  // A second cycle with a run that throws surfaces as RED, never as a thrown error.
  const throwingRunQuery = async () => { throw new Error('network is not available'); };
  const cycle2 = await runProofCycle({
    claimText: 'this cannot run',
    statement: 'select * from nowhere',
    expected: { rowCount: 1 },
    runQuery: throwingRunQuery,
  });
  ok(cycle2.ok === true, 'runProofCycle never throws even when the injected engine rejects');
  ok(cycle2.verdict.state === 'RED', 'a rejecting engine run resolves to a RED verdict, not a crash');
  ok(getReceipts().length === 2, 'the failed cycle still appended its own receipt (every prove cycle is a receipt)');
  resetReceipts();
}

// ---------- flag present ----------
{
  const manifest = JSON.parse(readFileSync(new URL('../flags.manifest.json', import.meta.url), 'utf8'));
  ok(!!manifest.flags.proofHarness, 'flags.manifest.json declares the proofHarness flag');
  ok(manifest.flags.proofHarness.enabled === true, 'the proofHarness flag is enabled:true');
  ok(typeof manifest.flags.proofHarness.description === 'string' && manifest.flags.proofHarness.description.length > 0,
    'the proofHarness flag carries a description');
  ok(!manifest.flags.proofHarness.description.includes('\u2014'), 'the proofHarness flag description contains no em dash');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
