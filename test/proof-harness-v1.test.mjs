// ============================================================
// DATAGLOW - Proof Harness v1 (VERDICT Harness) test suite
// ============================================================
// Proves js/proof-harness/second-engine.js, vault.js, cartridge.js, inbox.js,
// and the v1 additions to verdict.js/index.js. Pure modules, no DOM/DuckDB/
// network. crypto.subtle is global in Node, same discipline as
// test/proof-harness-v0.test.mjs.
//
// Covers, per PROOF_HARNESS_V1_SPEC.md's acceptance gates:
//   1. Second engine agree -> GREEN stays; disagree -> not GREEN
//   2. Vault catches a seeded RED 3/3 (re-run always still fails)
//   3. Cartridge export has 0 rows; import mismatch refuses GREEN
//   4. Inbox queue transitions (pending -> awaiting-confirm/red/gray/amber
//      -> confirmed/rejected)
//   5. AMBER on digest drift
//   6. v0 API/behavior is unchanged (byte-for-byte where the spec requires it)
//   7. flags.manifest.json declares proofHarnessV1, enabled:true, no em dash
//
// RUN WITH: node test/proof-harness-v1.test.mjs

import { readFileSync } from 'node:fs';
import { decideVerdict, VERDICT_STATES, VERDICT_REASON_CODES } from '../js/proof-harness/verdict.js';
import { compareClaimToRun } from '../js/proof-harness/score-claim.js';
import { createTypedProposal } from '../js/proof-harness/proposal.js';
import {
  corroborateRun,
  normalizeSecondRun,
  buildCorroborationField,
  resolveSecondEngine,
} from '../js/proof-harness/second-engine.js';
import {
  createVault,
  runVault,
  buildVaultTest,
  VAULT_STORAGE_KEY,
} from '../js/proof-harness/vault.js';
import {
  exportCartridge,
  importCartridge,
  parseCartridge,
  verifyCartridgeHash,
  serializeCartridge,
  PROOF_CARTRIDGE_TYPE,
} from '../js/proof-harness/cartridge.js';
import {
  createInbox,
  buildPendingItem,
  itemFromCycleResult,
  statusLabel,
  INBOX_ITEM_STATUSES,
} from '../js/proof-harness/inbox.js';
import {
  runProofCycle,
  rejectProposal,
  getReceipts,
  resetReceipts,
  getVaultTests,
  getVaultSize,
  runVaultCheck,
  resetVault,
} from '../js/proof-harness/index.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

// ---------- Second Engine Rule: agree keeps GREEN, disagree blocks it ----------
{
  const proposal = await createTypedProposal({ statement: 'select count(*) as n from t', expected: { rowCount: 5 } });
  const run = { status: 'ok', rowCount: 5, scalars: {}, error: null };
  const comparison = compareClaimToRun(proposal.expected, run);
  ok(comparison.pass === true, 'primary run matches the expectation (candidate GREEN)');

  const agreeingCorroboration = corroborateRun({
    primaryRun: run,
    secondRun: { result: { rows: [1, 2, 3, 4, 5] } },
    secondEngineName: 'pyodide',
    expected: proposal.expected,
  });
  ok(agreeingCorroboration.ran === true, 'corroborateRun ran when a second run was supplied');
  ok(agreeingCorroboration.agrees === true, 'corroborateRun agrees when rowCounts match');

  const verdictAgree = decideVerdict({ proposal, run, expected: proposal.expected, comparison, corroboration: agreeingCorroboration });
  ok(verdictAgree.state === 'GREEN', 'GREEN stays GREEN when the second engine agrees');

  const disagreeingCorroboration = corroborateRun({
    primaryRun: run,
    secondRun: { result: { rows: [1, 2, 3] } }, // 3 rows, primary said 5
    secondEngineName: 'pyodide',
    expected: proposal.expected,
  });
  ok(disagreeingCorroboration.agrees === false, 'corroborateRun disagrees when rowCounts differ');
  ok(disagreeingCorroboration.divergence_class === 'result-mismatch', 'a rowCount disagreement is classed as result-mismatch');

  const verdictDisagree = decideVerdict({ proposal, run, expected: proposal.expected, comparison, corroboration: disagreeingCorroboration });
  ok(verdictDisagree.state !== 'GREEN', 'disagreement blocks GREEN');
  ok(verdictDisagree.state === 'RED', 'disagreement resolves to RED, not a silent pass-through');
  ok(verdictDisagree.reasonCode === VERDICT_REASON_CODES.CORROBORATION_DISAGREE, 'the RED carries the corroboration-disagree reason code');

  // No second engine at all: v0 single-engine strength, verdict unaffected.
  const noSecond = corroborateRun({ primaryRun: run, secondRun: undefined, expected: proposal.expected });
  ok(noSecond.ran === false && noSecond.agrees === null, 'no second engine supplied is ran:false, agrees:null (not a disagreement)');
  const verdictNoSecond = decideVerdict({ proposal, run, expected: proposal.expected, comparison, corroboration: noSecond });
  ok(verdictNoSecond.state === 'GREEN', 'GREEN stands when no second engine ran at all (v0 strength preserved)');

  // A second engine that itself errors is a disagreement, never silently ignored.
  const erroredSecond = corroborateRun({ primaryRun: run, secondRun: { error: 'pyodide crashed' }, expected: proposal.expected });
  ok(erroredSecond.agrees === false, 'a second engine that errors counts as disagreement');
  ok(erroredSecond.divergence_class === 'second-engine-error', 'an errored second engine is classed as second-engine-error');

  ok(buildCorroborationField(noSecond) === null, 'buildCorroborationField returns null when no second engine ran (no predicate field invented)');
  ok(buildCorroborationField(agreeingCorroboration) !== null && buildCorroborationField(agreeingCorroboration).agrees === true, 'buildCorroborationField carries agrees:true through to the receipt predicate shape');

  ok(resolveSecondEngine({}) === null, 'resolveSecondEngine returns null in Node with nothing injected and no window (never throws)');
  const injected = resolveSecondEngine({ runSecondEngine: async () => ({}), secondEngineName: 'webr' });
  ok(injected && injected.name === 'webr' && typeof injected.run === 'function', 'resolveSecondEngine returns the injected runner when supplied');
}

// ---------- normalizeSecondRun shapes ----------
{
  ok(normalizeSecondRun({ result: { rows: [1, 2] } }).rowCount === 2, 'normalizeSecondRun reads rowCount from a nested DuckDB-shaped result');
  ok(normalizeSecondRun({ result: [1, 2, 3] }).rowCount === 3, 'normalizeSecondRun reads rowCount from a bare array result');
  ok(normalizeSecondRun(null).rowCount === null, 'normalizeSecondRun never throws on null, returns null rowCount');
  ok(normalizeSecondRun({ error: 'boom' }).error === 'boom', 'normalizeSecondRun surfaces a second engine error');
}

// ---------- verdict: AMBER on digest drift ----------
{
  const proposal = await createTypedProposal({ statement: 'select count(*) as n from t', expected: { rowCount: 5 } });
  const staleVerdict = decideVerdict({ proposal, run: { status: 'ok', rowCount: 5, error: null }, expected: proposal.expected, staleness: { stale: true, reason: 'digest drift' } });
  ok(staleVerdict.state === 'AMBER', 'decideVerdict returns AMBER when staleness.stale is true');
  ok(staleVerdict.reasonCode === VERDICT_REASON_CODES.STALE_DIGEST, 'an AMBER verdict carries the stale-digest reason code');
  ok(staleVerdict.blocker === 'digest drift', 'the AMBER blocker carries the supplied staleness reason');
  ok(VERDICT_STATES.includes('AMBER'), 'AMBER is part of the closed VERDICT_STATES vocabulary');
  ok(VERDICT_STATES.length === 4, 'VERDICT_STATES has exactly four states, no fifth mystery state');

  const freshVerdict = decideVerdict({ proposal, run: { status: 'ok', rowCount: 5, error: null }, expected: proposal.expected, staleness: { stale: false } });
  ok(freshVerdict.state === 'GREEN', 'decideVerdict is unaffected when staleness.stale is false');

  const noStalenessSupplied = decideVerdict({ proposal, run: { status: 'ok', rowCount: 5, error: null }, expected: proposal.expected });
  ok(noStalenessSupplied.state === 'GREEN', 'omitting staleness entirely behaves exactly like v0 (no AMBER by default)');
}

// ---------- end-to-end: runProofCycle AMBER via priorReceiptDigest ----------
{
  resetReceipts();
  const fakeRunQuery = async () => ({ columns: [{ name: 'n' }], rows: [{ n: 5 }], rowCount: 1 });
  const cycle1 = await runProofCycle({
    claimText: 'there are 5 widgets',
    statement: 'select 5 as n',
    expected: { rowCount: 1 },
    runQuery: fakeRunQuery,
  });
  ok(cycle1.verdict.state === 'GREEN', 'first cycle proves GREEN');
  ok(cycle1.staleness && cycle1.staleness.stale === false, 'a fresh cycle with no priorReceiptDigest reports staleness.stale === false');

  const cycle2 = await runProofCycle({
    claimText: 'there are 5 widgets',
    statement: 'select 5 as n where 1=1', // edited statement -> different digest
    expected: { rowCount: 1 },
    runQuery: fakeRunQuery,
    priorReceiptDigest: cycle1.proposal.digest,
  });
  ok(cycle2.verdict.state === 'AMBER', 'runProofCycle surfaces AMBER when the statement changed since the prior receipt digest');
  ok(cycle2.staleness.stale === true, 'runProofCycle reports staleness.stale === true on digest drift');
  resetReceipts();
}

// ---------- Regression Vault: seeded RED caught 3/3 ----------
{
  const testVault = createVault({ storage: null }); // no localStorage in Node; in-memory only
  ok(testVault.size() === 0, 'a new vault starts empty');

  const added = await testVault.add({
    claimText: 'total revenue is 100',
    statement: 'select 999 as n',
    expected: { rowCount: 1, scalars: { n: 100 } },
    source: 'red',
  });
  ok(typeof added.id === 'string' && added.id.startsWith('vault-'), 'a vault test carries a vault-prefixed id');
  ok(added.source === 'red', 'the vault test records its source (red)');
  ok(testVault.size() === 1, 'the vault grew by one after add()');

  // Seeded repeat of the SAME bad run three times: must fail again every time.
  const seededBadRunQuery = async () => ({ columns: [{ name: 'n' }], rows: [{ n: 999 }], rowCount: 1 });
  for (let i = 0; i < 3; i++) {
    const result = await runVault({ runQuery: seededBadRunQuery, tests: testVault.list(), compareClaimToRun });
    ok(result.total === 1, `vault run ${i + 1}/3: exactly one test evaluated`);
    ok(result.caught === 1 && result.escaped === 0, `vault run ${i + 1}/3: the seeded RED is still caught (3/3 discipline)`);
  }

  // A fixed regression (run now matches expected) is the vault's alarm: escaped.
  const fixedRunQuery = async () => ({ columns: [{ name: 'n' }], rows: [{ n: 100 }], rowCount: 1 });
  const fixedResult = await runVault({ runQuery: fixedRunQuery, tests: testVault.list(), compareClaimToRun });
  ok(fixedResult.escaped === 1 && fixedResult.caught === 0, 'a vault test whose run now matches expected is reported as escaped, not silently passed');

  // A rejection also appends a vault test.
  await testVault.add({ claimText: 'claim x', statement: 'select 1', expected: { rowCount: 5 }, source: 'reject' });
  ok(testVault.size() === 2, 'a rejection also appends to the vault');
  ok(testVault.list()[1].source === 'reject', 'the second vault test records source reject');

  testVault.clear();
  ok(testVault.size() === 0, 'clear() empties the vault');
}

// ---------- Regression Vault: never-throw on a throwing runner ----------
{
  const t = createVault({ storage: null });
  await t.add({ claimText: 'c', statement: 'select * from missing', expected: { rowCount: 1 }, source: 'red' });
  const throwingRunQuery = async () => { throw new Error('table missing'); };
  const result = await runVault({ runQuery: throwingRunQuery, tests: t.list(), compareClaimToRun });
  ok(result.caught === 1, 'a runner that throws again is treated as still caught, never crashes runVault');
}

// ---------- runProofCycle auto-captures RED into the vault ----------
{
  resetReceipts();
  resetVault();
  const mismatchRunQuery = async () => ({ columns: [{ name: 'n' }], rows: [{ n: 3 }], rowCount: 1 });
  const cycle = await runProofCycle({
    claimText: 'there are 5 widgets',
    statement: 'select 3 as n',
    expected: { rowCount: 1, scalars: { n: 5 } },
    runQuery: mismatchRunQuery,
  });
  ok(cycle.verdict.state === 'RED', 'a mismatched cycle resolves to RED');
  ok(cycle.vaulted === true, 'runProofCycle reports that the RED verdict was vaulted');
  ok(getVaultSize() === 1, 'the module-level vault grew by one after a RED cycle');
  ok(getVaultTests()[0].source === 'red', 'the auto-captured vault test records source red');

  const vaultRerun = await runVaultCheck(mismatchRunQuery);
  ok(vaultRerun.total === 1 && vaultRerun.caught === 1, 'runVaultCheck re-runs the auto-captured RED and still catches it');

  resetReceipts();
  resetVault();
}

// ---------- rejectProposal appends a vault test ----------
{
  resetVault();
  const rejection = await rejectProposal(
    { claimText: 'claim y', statement: 'select 1 as n', expected: { rowCount: 1 } },
    { reason: 'Not the right table', by: 'reviewer-1' },
  );
  ok(rejection.rejected === true, 'rejectProposal returns rejected:true');
  ok(rejection.by === 'reviewer-1', 'rejectProposal records who rejected it');
  ok(typeof rejection.vaultTestId === 'string', 'rejectProposal returns the id of the vault test it created');
  ok(getVaultSize() === 1, 'rejecting a proposal appends exactly one vault test');
  ok(getVaultTests()[0].source === 'reject', 'the rejection vault test records source reject');
  resetVault();
}

// ---------- Proof Cartridge: export has 0 rows ----------
{
  const proposal = await createTypedProposal({ statement: 'select count(*) as n from t', expected: { rowCount: 1 } });
  const verdict = { state: 'GREEN', reasonCode: 'match' };
  const exported = await exportCartridge({ proposal, verdict, run: { rowCount: 1 }, receipt: { hash: 'abc123' } });
  ok(exported.rejected === false, 'exporting a GREEN result succeeds');
  ok(Array.isArray(exported.cartridge.rows) && exported.cartridge.rows.length === 0, 'the exported cartridge carries zero rows of source data');
  ok(exported.cartridge._type === PROOF_CARTRIDGE_TYPE, 'the cartridge carries the dataglow proof-cartridge type');
  ok(typeof exported.cartridge.cartridgeHash === 'string' && exported.cartridge.cartridgeHash.startsWith('sha256:'), 'the cartridge carries a sha256-prefixed integrity hash');
  ok(exported.cartridge.statement === proposal.statement, 'the cartridge carries the proven statement');
  ok(exported.cartridge.proposalDigest === proposal.digest, 'the cartridge carries the proposal digest');

  // Refuses to export a non-GREEN result.
  const refused = await exportCartridge({ proposal, verdict: { state: 'RED' } });
  ok(refused.rejected === true, 'exportCartridge refuses a non-GREEN verdict');

  const serialized = serializeCartridge(exported.cartridge);
  ok(typeof serialized === 'string' && serialized.includes(PROOF_CARTRIDGE_TYPE), 'serializeCartridge produces JSON text carrying the cartridge type');

  // ---------- Proof Cartridge: import re-runs and can refuse GREEN ----------
  const matchingRunQuery = async () => ({ columns: [{ name: 'n' }], rows: [{ n: 1 }], rowCount: 1 });
  const importOk = await importCartridge({ cartridgeText: serialized, runQuery: matchingRunQuery, compareClaimToRun });
  ok(importOk.ok === true && importOk.state === 'GREEN', 'importing a cartridge and reproducing the result resolves to GREEN');

  const mismatchingRunQuery = async () => ({ columns: [{ name: 'n' }], rows: [], rowCount: 0 });
  const importMismatch = await importCartridge({ cartridgeText: serialized, runQuery: mismatchingRunQuery, compareClaimToRun });
  ok(importMismatch.ok === false, 'importing a cartridge that no longer reproduces the result refuses ok:true');
  ok(importMismatch.state === 'RED', 'a reproduction mismatch on import resolves to RED, never a guessed GREEN');
  ok(Array.isArray(importMismatch.divergence) && importMismatch.divergence.length > 0, 'a mismatched import names the precise divergence');

  // Tampering with the cartridge after export breaks the hash and refuses import.
  const tampered = JSON.parse(serialized);
  tampered.statement = 'select 999999 as n';
  const tamperedText = JSON.stringify(tampered);
  const importTampered = await importCartridge({ cartridgeText: tamperedText, runQuery: matchingRunQuery, compareClaimToRun });
  ok(importTampered.ok === false, 'importing a hand-edited cartridge refuses ok:true');
  ok(importTampered.state === 'RED', 'a broken integrity hash on import resolves to RED, not a silent pass');

  // Malformed JSON is handled without throwing.
  const parsedBad = parseCartridge('not json');
  ok(parsedBad.rejected === true, 'parseCartridge rejects invalid JSON without throwing');
  const parsedWrongType = parseCartridge(JSON.stringify({ _type: 'something-else' }));
  ok(parsedWrongType.rejected === true, 'parseCartridge rejects JSON that is not a proof cartridge');

  const verify = await verifyCartridgeHash(exported.cartridge);
  ok(verify.valid === true, 'verifyCartridgeHash confirms an unedited cartridge');
}

// ---------- Proof Inbox: queue transitions ----------
{
  const inbox = createInbox();
  ok(inbox.size() === 0, 'a new inbox starts empty');

  const pending = inbox.enqueue({ claimText: 'revenue is 100', statement: 'select 100 as n', expected: { rowCount: 1 } });
  ok(pending.status === 'pending-prove', 'a newly enqueued item starts pending-prove');
  ok(inbox.size() === 1, 'enqueue grows the inbox by one');
  ok(INBOX_ITEM_STATUSES.includes('pending-prove'), 'pending-prove is part of the closed inbox status vocabulary');

  const greenCycle = { proposal: { claimText: 'revenue is 100', statement: 'select 100 as n', expected: { rowCount: 1 }, digest: 'sha256:x' }, run: { rowCount: 1 }, verdict: { state: 'GREEN', reasonCode: 'match' }, receipt: { hash: 'h1' } };
  const afterProve = inbox.recordCycleResult(pending.id, greenCycle);
  ok(afterProve.status === 'awaiting-confirm', 'a GREEN cycle result moves the item to awaiting-confirm');
  ok(afterProve.verdict.state === 'GREEN', 'the item carries the verdict from the cycle result');

  const confirmed = inbox.confirm(pending.id, { confirmed: true, by: 'reviewer' });
  ok(confirmed.status === 'confirmed', 'confirm() moves the item to confirmed');
  ok(inbox.pendingReview().length === 0, 'a confirmed item no longer needs review');

  const pending2 = inbox.enqueue({ claimText: 'revenue is 200', statement: 'select 1 as n', expected: { rowCount: 5 } });
  const redCycle = { proposal: { claimText: 'revenue is 200', statement: 'select 1 as n', expected: { rowCount: 5 } }, run: { rowCount: 1 }, verdict: { state: 'RED', reasonCode: 'rowcount-mismatch' }, receipt: { hash: 'h2' } };
  inbox.recordCycleResult(pending2.id, redCycle);
  const rejected = inbox.reject(pending2.id, 'Wrong table');
  ok(rejected.status === 'rejected', 'reject() moves the item to rejected');
  ok(rejected.rejectReason === 'Wrong table', 'reject() records the reason');

  const pending3 = inbox.enqueue({ claimText: 'revenue is 300', statement: 'select 1', expected: {} });
  const grayCycle = { proposal: { claimText: 'revenue is 300', statement: 'select 1' }, run: { rowCount: 1 }, verdict: { state: 'GRAY', reasonCode: 'no-expectation' } };
  const afterGray = inbox.recordCycleResult(pending3.id, grayCycle);
  ok(afterGray.status === 'gray', 'a GRAY cycle result moves the item to gray');

  const pending4 = inbox.enqueue({ claimText: 'revenue is 400', statement: 'select 1' });
  const amberCycle = { proposal: { claimText: 'revenue is 400', statement: 'select 1' }, run: null, verdict: { state: 'AMBER', reasonCode: 'stale-digest' } };
  const afterAmber = inbox.recordCycleResult(pending4.id, amberCycle);
  ok(afterAmber.status === 'amber', 'an AMBER cycle result moves the item to amber');

  ok(inbox.list().length === 4, 'the inbox lists every enqueued item');
  ok(inbox.get(pending.id).status === 'confirmed', 'get() retrieves an item by id');
  ok(inbox.get('nonexistent') === null, 'get() returns null for an unknown id, never throws');

  for (const status of ['pending-prove', 'awaiting-confirm', 'red', 'gray', 'amber', 'confirmed', 'rejected']) {
    const label = statusLabel(status);
    ok(typeof label === 'string' && label.length > 0, `statusLabel has a plain-language label for ${status}`);
    ok(!label.includes('\u2014'), `statusLabel for ${status} contains no em dash`);
  }

  inbox.clear();
  ok(inbox.size() === 0, 'clear() empties the inbox');
}

// ---------- buildPendingItem / itemFromCycleResult never throw on malformed input ----------
{
  const item = buildPendingItem(null);
  ok(item.status === 'pending-prove' && item.claimText === '', 'buildPendingItem never throws on null input, returns safe defaults');
  const fromBad = itemFromCycleResult(null, item);
  ok(fromBad.status === 'gray', 'itemFromCycleResult never throws on a null cycle result, defaults to gray');
}

// ---------- flags.manifest.json: proofHarnessV1 ----------
{
  const manifest = JSON.parse(readFileSync(new URL('../flags.manifest.json', import.meta.url), 'utf8'));
  ok(!!manifest.flags.proofHarnessV1, 'flags.manifest.json declares the proofHarnessV1 flag');
  ok(manifest.flags.proofHarnessV1.enabled === true, 'the proofHarnessV1 flag is enabled:true');
  ok(typeof manifest.flags.proofHarnessV1.description === 'string' && manifest.flags.proofHarnessV1.description.length > 0,
    'the proofHarnessV1 flag carries a description');
  ok(!manifest.flags.proofHarnessV1.description.includes('\u2014'), 'the proofHarnessV1 flag description contains no em dash');
  ok(!!manifest.flags.proofHarness, 'the v0 proofHarness flag is still present (v1 composes, does not replace it)');
}

// ---------- vault storage key constant is stable ----------
{
  ok(VAULT_STORAGE_KEY === 'dataglow.proofHarness.vault.v1', 'the vault storage key is the documented constant');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
