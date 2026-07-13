// ============================================================
// DATAGLOW — Crucible Orchestration unit + shape-compat tests
// ============================================================
// Exercises the PURE, DOM-free, never-throwing orchestrator in
// js/validation/crucible-orchestrator.js:
//   runCrucibleForFix / crucibleReferenceAgent.
// It is verified against the REAL merged modules it wires together — the real
// adversarial packs, the real typed-handoff contract, real buildBlameDetail +
// normalizeBlameEntry for the blame entry, and (for the shape-compat check) the
// real crucible-ui view-model builders — so the output is proven to be exactly
// what the app will produce and what the Crucible tab will consume.
//
// RUN WITH:  node test/crucible-orchestrator.test.mjs   (no DuckDB, no network, no DOM)

import { runCrucibleForFix, crucibleReferenceAgent } from '../js/validation/crucible-orchestrator.js';
import { buildBlameDetail } from '../js/provenance/data-blame.js';
import { buildPipelineModel, buildAdversarialPackListModel, buildRunLogModel } from '../js/validation/crucible-ui.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A realistic recorded provenance step, exactly as provenance.recordStep returns
// it: an op/description plus a `detail` from the real buildBlameDetail.
let idx = 0;
function recordedStep({ rule, column, affectedCount = null, before, after }) {
  const detailArgs = { rule, column, affectedCount };
  if (before !== undefined) detailArgs.before = before;
  if (after !== undefined) detailArgs.after = after;
  return {
    index: idx++, op: 'clean', description: `${rule} on ${column}`,
    ts: Date.now(), hash: `hash-${idx}`, parentHash: `parent-${idx}`,
    detail: buildBlameDetail(detailArgs),
  };
}

function main() {
  // ---- Happy path: a real fix runs through the whole pipeline ----
  {
    const blameEntry = recordedStep({ rule: 'fill_zero', column: 'age', affectedCount: 4, before: null, after: 0 });
    const r = runCrucibleForFix({ fixType: 'fill_zero', issue: { column: 'age', count: 4 }, blameEntry });

    ok(r && typeof r === 'object', 'returns an object');
    ok(['cleaningResult', 'validationVerdict', 'suiteResult', 'revertProposal'].every(k => k in r), 'returns the full four-key shape');

    ok(r.cleaningResult && r.cleaningResult.kind === 'CleaningResult', 'cleaningResult is a real CleaningResult');
    ok(r.cleaningResult.rulesCited.includes('fill_zero'), 'cleaningResult cites the fix rule');
    ok(r.cleaningResult.confidence >= 0 && r.cleaningResult.confidence <= 1, 'confidence is scaled into [0,1]');
    ok(r.cleaningResult.changes.length === 1 && r.cleaningResult.changes[0].field === 'age', 'change targets the fixed column');

    ok(r.suiteResult && Array.isArray(r.suiteResult.packResults) && r.suiteResult.packResults.length === 4, 'ran all four adversarial packs');

    ok(r.validationVerdict && r.validationVerdict.kind === 'ValidationVerdict', 'validationVerdict is a real ValidationVerdict');
    ok(r.validationVerdict.decision === 'accept' || r.validationVerdict.decision === 'escalate', 'decision is accept or escalate — NEVER reject');
    ok(r.validationVerdict.decision !== 'reject', 'never returns reject (no authority to reject an applied fix)');

    ok(r.revertProposal && typeof r.revertProposal === 'object', 'classified revert-eligibility for the blame entry');
  }

  // ---- Standing suite is honest: escalates on the documented gaps ----
  {
    const r = runCrucibleForFix({ fixType: 'drop_rows', issue: { column: 'age', count: 2 }, blameEntry: recordedStep({ rule: 'drop_rows', column: 'age', affectedCount: 2 }) });
    const byId = Object.fromEntries(r.suiteResult.packResults.map(p => [p.id, p.passed]));
    ok(byId['boundary-date'] === true, 'boundary-date pack passes (Date.UTC calendar validity is objectively correct)');
    ok(byId['ssn-transposition'] === true, 'ssn-transposition pack passes (one-digit slip stays same-entity)');
    ok(byId['name-order-swap'] === false, 'name-order-swap pack honestly FAILS (documented AHIMA character-matcher gap)');
    ok(byId['impossible-value'] === false, 'impossible-value pack honestly FAILS (age is not a vital — surfaced coverage gap)');
    ok(r.validationVerdict.decision === 'escalate' && typeof r.validationVerdict.escalationReason === 'string' && r.validationVerdict.escalationReason.length > 0, 'a failing suite escalates with a non-empty reason');
  }

  // ---- crucibleReferenceAgent dispatches correctly by case shape ----
  {
    ok(crucibleReferenceAgent({ input: '2024-02-29' }) === '2024-02-29', 'agent accepts a real leap-day date');
    ok(crucibleReferenceAgent({ input: '2023-02-29' }) === null, 'agent rejects Feb 29 in a non-leap year');
    ok(crucibleReferenceAgent({ input: '2023-01-32' }) === null, 'agent rejects day 32');
    ok(crucibleReferenceAgent({ field: 'heart_rate', value: 450 }) === true, 'agent flags an impossible heart rate');
    ok(crucibleReferenceAgent({ field: 'heart_rate', value: 72 }) === false, 'agent passes a normal heart rate');
    ok(crucibleReferenceAgent({ field: 'age', value: 240 }) === false, 'agent honestly cannot judge age (not a vital)');
    ok(crucibleReferenceAgent({ left: { name: 'Nadia Petrova', ssn: '123-45-6789' }, right: { name: 'Nadia Petrova', ssn: '123-45-6798' } }) === true, 'agent reunites a one-digit SSN transposition');
    ok(crucibleReferenceAgent({ left: { name: 'Maria Garcia Lopez' }, right: { name: 'Lopez, Maria Garcia' } }) === false, 'agent misses a name-order swap (honest gap)');
  }

  // ---- Never throws on malformed input; always the safe empty shape ----
  {
    const EMPTY = ['cleaningResult', 'validationVerdict', 'suiteResult', 'revertProposal'];
    for (const bad of [undefined, null, 42, 'x', {}, [], { fixType: null }, { fixType: 123 }, { issue: {} }]) {
      let r;
      try { r = runCrucibleForFix(bad); } catch (e) { r = { threw: true }; }
      ok(r && r.threw !== true && EMPTY.every(k => r[k] === null), `runCrucibleForFix(${JSON.stringify(bad)}) -> safe all-null shape, never throws`);
    }
    // Forced internal failure: a blame entry whose getters throw must still be swallowed.
    const hostile = { fixType: 'fill_zero', issue: { get column() { throw new Error('boom'); } }, blameEntry: { get detail() { throw new Error('boom'); } } };
    let r;
    try { r = runCrucibleForFix(hostile); } catch (e) { r = { threw: true }; }
    ok(r && r.threw !== true && ('cleaningResult' in r), 'forced internal failure is swallowed and returns the safe shape');

    for (const bad of [undefined, null, 42, 'x', [], { left: null }]) {
      let v;
      try { v = crucibleReferenceAgent(bad); } catch (e) { v = 'THREW'; }
      ok(v !== 'THREW', `crucibleReferenceAgent(${JSON.stringify(bad)}) never throws`);
    }
  }

  // ---- Shape-compat: output feeds the real crucible-ui builders without throwing ----
  {
    const r = runCrucibleForFix({ fixType: 'abs_value', issue: { column: 'balance', count: 3 }, blameEntry: recordedStep({ rule: 'abs_value', column: 'balance', before: -5, after: 5 }) });
    let threw = false, pipeline, packs, log;
    try {
      pipeline = buildPipelineModel(r.cleaningResult, r.validationVerdict);
      packs = buildAdversarialPackListModel(r.suiteResult);
      log = buildRunLogModel(r.suiteResult);
    } catch (e) { threw = true; }
    ok(!threw, 'crucible-ui builders consume the orchestrator output without throwing');
    ok(pipeline && typeof pipeline === 'object', 'buildPipelineModel returns a model');
    ok(Array.isArray(packs) ? packs.length === 4 : (packs && Array.isArray(packs.packs) && packs.packs.length === 4), 'pack list model reflects all four packs');
    ok(log && typeof log === 'object', 'buildRunLogModel returns a model');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
