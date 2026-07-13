// ============================================================
// DATAGLOW — The Crucible: read-only UI view-model unit tests (Batch 2)
// ============================================================
// Exercises the PURE, DOM-free view-model builders in js/validation/crucible-ui.js:
// shouldOfferCrucible (the flag gate), buildPipelineModel (Clean Agent → Crucible
// Validator → Provenance Ledger, each idle/running/done + contract fields),
// buildAdversarialPackListModel and buildRunLogModel (pack pass/fail + escalation
// callout). Fixtures are built by calling the REAL Batch 1 functions
// (buildCleaningResult / buildValidationVerdict / the real packs /
// runAdversarialSuite) — never a hand-rolled fake shape — so the presenter is
// verified against the exact objects it will receive in the app. The builders
// must NEVER throw: malformed/missing input yields a safe idle/empty model.
//
// RUN WITH:  node test/crucible-ui.test.mjs      (no DuckDB, no network, no DOM)

import {
  shouldOfferCrucible,
  buildPipelineModel,
  buildAdversarialPackListModel,
  buildRunLogModel,
} from '../js/validation/crucible-ui.js';
import { buildCleaningResult, buildValidationVerdict } from '../js/validation/crucible-contract.js';
import {
  boundaryDatePack,
  impossibleValuePack,
  runAdversarialSuite,
} from '../js/validation/crucible-adversarial-packs.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// --- Real Batch 1 fixtures -------------------------------------------------
const validChanges = [
  { field: 'patient_name', oldValue: 'Jon Smith', newValue: 'John Smith', rule: 'nickname-normalization' },
  { field: 'dob', oldValue: null, newValue: '1980-01-01', rule: 'date-imputation' },
];
const cleaningResult = buildCleaningResult({ changes: validChanges, confidence: 0.82, rulesCited: ['r1', 'r2'], agentId: 'cleaning-agent-1' }).result;

// A correct date normalizer passes the boundary pack but is wrong-typed for the
// value pack, so runAdversarialSuite gives us a MIX of pass + fail to present.
function strictDateNormalizer(rec) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rec.input);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return dt.toISOString().slice(0, 10);
  return null;
}
const suiteResult = runAdversarialSuite([boundaryDatePack, impossibleValuePack], strictDateNormalizer);
const verdict = buildValidationVerdict({ subjectResult: cleaningResult, packResults: suiteResult.packResults, decision: 'escalate', escalationReason: 'one pack failed' }).verdict;

function main() {
  // ---- shouldOfferCrucible ----
  ok(shouldOfferCrucible({ enabled: true }) === true, 'shouldOfferCrucible: enabled:true -> true');
  for (const bad of [{ enabled: false }, {}, undefined, null, { enabled: 'yes' }, { enabled: 1 }]) {
    ok(shouldOfferCrucible(bad) === false, `shouldOfferCrucible: ${JSON.stringify(bad)} -> false`);
  }

  // ---- buildPipelineModel: honest idle skeleton on empty/missing input ----
  {
    for (const [a, b] of [[undefined, undefined], [null, null], [42, 'nope'], [{}, []]]) {
      const m = buildPipelineModel(a, b);
      ok(m.steps.length === 3, `buildPipelineModel(${JSON.stringify(a)}, ${JSON.stringify(b)}): always 3 steps`);
      ok(m.hasData === false, 'buildPipelineModel: garbage input -> hasData false');
      ok(m.steps.every(s => s.status === 'idle'), 'buildPipelineModel: garbage input -> every step idle');
      ok(m.steps[0].fields.changesCount === 0 && m.steps[0].fields.confidence === null, 'buildPipelineModel: idle Clean step fabricates no numbers');
    }
  }

  // ---- buildPipelineModel: real CleaningResult only -> clean done, validator running ----
  {
    const m = buildPipelineModel(cleaningResult, null);
    ok(m.hasData === true, 'buildPipelineModel: real CleaningResult -> hasData true');
    ok(m.steps[0].status === 'done', 'buildPipelineModel: Clean Agent step done with a CleaningResult');
    ok(m.steps[0].fields.changesCount === 2 && m.steps[0].fields.confidence === 0.82, 'buildPipelineModel: Clean step reflects real changes/confidence');
    ok(m.steps[0].fields.agentId === 'cleaning-agent-1' && m.steps[0].fields.rulesCited.length === 2, 'buildPipelineModel: Clean step reflects real agentId/rulesCited');
    ok(m.steps[1].status === 'running', 'buildPipelineModel: Crucible Validator is running while a proposal awaits a verdict');
    ok(m.steps[2].status === 'idle' && typeof m.steps[2].note === 'string', 'buildPipelineModel: Provenance Ledger step is idle with a future-batch note');
  }

  // ---- buildPipelineModel: real CleaningResult + ValidationVerdict -> validator done ----
  {
    const m = buildPipelineModel(cleaningResult, verdict);
    ok(m.steps[1].status === 'done', 'buildPipelineModel: Crucible Validator done with a verdict');
    ok(m.steps[1].fields.decision === 'escalate', 'buildPipelineModel: validator step reflects the real decision');
    ok(m.steps[1].fields.escalationReason === 'one pack failed', 'buildPipelineModel: validator step reflects the real escalationReason');
    ok(m.steps[1].fields.packCount === suiteResult.packResults.length, 'buildPipelineModel: validator step counts the real packResults');
    // accepts the wrapped { ok:true, result/verdict } shapes too
    const wrapped = buildPipelineModel(
      buildCleaningResult({ changes: validChanges, confidence: 0.5, rulesCited: ['r'], agentId: 'a' }),
      buildValidationVerdict({ subjectResult: cleaningResult, packResults: [], decision: 'accept' }));
    ok(wrapped.steps[0].status === 'done' && wrapped.steps[1].status === 'done', 'buildPipelineModel: accepts the wrapped { ok, result/verdict } build outputs');
  }

  // ---- buildAdversarialPackListModel ----
  {
    const empty = buildAdversarialPackListModel(undefined);
    ok(empty.isEmpty === true && empty.packs.length === 0 && empty.total === 0, 'buildAdversarialPackListModel: missing input -> empty list');
    for (const bad of [null, 42, 'x', {}]) ok(buildAdversarialPackListModel(bad).isEmpty === true, `buildAdversarialPackListModel: ${JSON.stringify(bad)} -> empty, never throws`);

    // from a runAdversarialSuite summary
    const fromSuite = buildAdversarialPackListModel(suiteResult);
    ok(fromSuite.total === 2, 'buildAdversarialPackListModel: reads packResults out of a suite summary');
    ok(fromSuite.passedCount + fromSuite.failedCount === fromSuite.total, 'buildAdversarialPackListModel: pass + fail counts reconcile');
    ok(fromSuite.packs.every(p => typeof p.label === 'string' && p.badge && typeof p.badge.className === 'string'), 'buildAdversarialPackListModel: every pack has a label + badge');
    // from the raw array
    const fromArray = buildAdversarialPackListModel(suiteResult.packResults);
    ok(fromArray.total === 2, 'buildAdversarialPackListModel: accepts the raw packResults array too');
    const date = fromArray.packs.find(p => p.id === 'boundary-date');
    ok(date && date.passed === true && date.badge.label === 'Pass', 'buildAdversarialPackListModel: a passing pack -> Pass badge');
    const val = fromArray.packs.find(p => p.id === 'impossible-value');
    ok(val && val.passed === false && val.badge.label === 'Fail', 'buildAdversarialPackListModel: a failing pack -> Fail badge');
  }

  // ---- buildRunLogModel ----
  {
    for (const bad of [undefined, null, 42, 'x', {}, []]) {
      const m = buildRunLogModel(bad);
      ok(m.isEmpty === true && m.rows.length === 0 && m.escalation.needed === false, `buildRunLogModel: ${JSON.stringify(bad)} -> safe empty log, never throws`);
    }
    const log = buildRunLogModel(suiteResult);
    ok(log.isEmpty === false && log.rows.length === 2, 'buildRunLogModel: one row per pack');
    ok(log.passedCount === suiteResult.passedCount && log.failedCount === suiteResult.failedCount, 'buildRunLogModel: counts match the suite summary');
    ok(log.escalation.needed === true, 'buildRunLogModel: a failed pack raises the escalation callout');
    ok(log.escalation.failedPacks.length === log.failedCount, 'buildRunLogModel: escalation names every failed pack');
    ok(typeof log.escalation.message === 'string' && /escalate/i.test(log.escalation.message), 'buildRunLogModel: escalation message mentions escalation');
    const failRow = log.rows.find(r => !r.passed);
    ok(failRow && failRow.failureCount > 0 && failRow.failures.every(f => typeof f.text === 'string'), 'buildRunLogModel: a failed row carries readable failure text');

    // an all-pass suite -> no escalation
    const allPass = runAdversarialSuite([boundaryDatePack], strictDateNormalizer);
    const passLog = buildRunLogModel(allPass);
    ok(passLog.allPassed === true && passLog.escalation.needed === false && passLog.escalation.message === null, 'buildRunLogModel: an all-pass suite raises no escalation');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
