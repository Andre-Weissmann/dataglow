// ============================================================
// DATAGLOW — The Crucible: adversarial pack suite (Batch 1)
// ============================================================
// Two jobs:
//
//  1. EMPIRICAL GAP PROOF (integration): run nameOrderSwapPack and
//     ssnTranspositionPack against the REAL findFuzzyDuplicates() from
//     js/cleaning/fuzzy-dedup.js — the exact production code, its DuckDB backend
//     swapped in via the duckdb-loader-hook exactly like fuzzy-dedup-patients —
//     and assert both packs FAIL. That failure is not a regression: it is the
//     honest, reproducible confirmation of the two AHIMA patient-matching gaps
//     NORTH_STAR's 2026-07-12 findings already diagnosed (name-order swap and
//     SSN last-4 transposition are uncaught by the character-similarity matcher).
//
//  2. FRAMEWORK TEETH (unit): run boundaryDatePack and impossibleValuePack against
//     small inline stub validators — a CORRECT one (pack passes) and a NAIVE one
//     (pack fails) — proving the packs reward a sound agent and catch a broken one
//     rather than passing everything. (No canonical date-normalizer ships in js/
//     yet, so a stub is used and noted here; wire the real one when it lands.)
//
// RUN WITH:
//   node --import ./test/duckdb-loader-hook.mjs test/crucible-adversarial-packs.test.mjs

import { createTableFromObjects, closeConnection } from './node-duckdb-engine.mjs';
import { findFuzzyDuplicates } from '../js/cleaning/fuzzy-dedup.js';
import {
  nameOrderSwapPack,
  ssnTranspositionPack,
  boundaryDatePack,
  impossibleValuePack,
  runAdversarialSuite,
  CRUCIBLE_PACKS,
} from '../js/validation/crucible-adversarial-packs.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Does the REAL fuzzy-dedup radar surface the pair (a, b) as near-duplicates on
// the name column? Builds a tiny 2-row table and runs the production function.
let tableSeq = 0;
async function fuzzyFlagsNamePair(a, b) {
  const table = `crucible_probe_${tableSeq++}`;
  await createTableFromObjects(table, [{ patient_name: a }, { patient_name: b }]);
  const cols = [{ name: 'patient_name', type: 'VARCHAR' }];
  const res = await findFuzzyDuplicates(table, cols, { column: 'patient_name' });
  return Array.isArray(res.pairs) && res.pairs.length > 0;
}

// Build a sync matcher (what a pack's evaluate() calls) by PRE-COMPUTING the
// async fuzzy-dedup result for every case, keyed by case id.
async function fuzzyDedupMatcherFor(pack) {
  const cases = pack.generateCases();
  const byId = new Map();
  for (const c of cases) {
    byId.set(c.id, await fuzzyFlagsNamePair(c.left.name, c.right.name));
  }
  return (rec) => byId.get(rec.id) === true;
}

// --- Correct + naive stub agents for the value packs. ---
function strictDateNormalizer(rec) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rec.input);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Reject any input the calendar rolled over (e.g. Feb 29 -> Mar 1).
  if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) {
    return dt.toISOString().slice(0, 10);
  }
  return null;
}
// The dangerous kind: JS Date silently rolls impossible dates into plausible ones.
function naiveDateNormalizer(rec) {
  const dt = new Date(rec.input);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

function plausibilityValidator(rec) {
  const v = rec.value;
  if (rec.field === 'age') return v < 0 || v > 130;
  if (rec.field === 'heart_rate') return v < 0 || v > 400;
  if (rec.field === 'body_temp_c') return v < 0 || v > 45;
  return false;
}
// Silently passes everything through — never flags anything.
const passThroughValidator = () => false;

async function main() {
  // ---------------------------------------------------------------
  // 1. Integration: packs vs the REAL fuzzy-dedup — expected to FAIL.
  // ---------------------------------------------------------------
  const nameMatcher = await fuzzyDedupMatcherFor(nameOrderSwapPack);
  const nameOutcome = nameOrderSwapPack.evaluate(nameMatcher, nameOrderSwapPack.generateCases());
  ok(nameOutcome.passed === false, 'nameOrderSwapPack FAILS against real fuzzy-dedup (documents the AHIMA name-order-swap gap)');
  const swapFails = nameOutcome.failures.filter(f => /NOT flagged/.test(f.reason));
  ok(swapFails.length === 6, `nameOrderSwapPack: all 6 name-order-swap pairs go uncaught (got ${swapFails.length})`);
  ok(!nameOutcome.failures.some(f => f.id === 'name-swap-control'), 'nameOrderSwapPack: the distinct control pair is NOT a false positive');

  const ssnMatcher = await fuzzyDedupMatcherFor(ssnTranspositionPack);
  const ssnOutcome = ssnTranspositionPack.evaluate(ssnMatcher, ssnTranspositionPack.generateCases());
  ok(ssnOutcome.passed === false, 'ssnTranspositionPack FAILS against real fuzzy-dedup (documents the AHIMA SSN-transposition gap)');
  const ssnFails = ssnOutcome.failures.filter(f => /NOT flagged/.test(f.reason));
  ok(ssnFails.length === 6, `ssnTranspositionPack: all 6 SSN-transposition pairs go uncaught (got ${ssnFails.length})`);

  console.log('\n--- Empirical gap proof (real fuzzy-dedup as agent-under-test) ---');
  console.log(`name-order-swap pairs uncaught: ${swapFails.length}/6`);
  console.log(`ssn-transposition pairs uncaught: ${ssnFails.length}/6`);
  console.log('-----------------------------------------------------------------\n');

  // ---------------------------------------------------------------
  // 2. Framework teeth: value packs vs correct + naive stub agents.
  // ---------------------------------------------------------------
  const dateGood = boundaryDatePack.evaluate(strictDateNormalizer, boundaryDatePack.generateCases());
  ok(dateGood.passed === true, 'boundaryDatePack PASSES against a strict date normalizer');
  const dateBad = boundaryDatePack.evaluate(naiveDateNormalizer, boundaryDatePack.generateCases());
  ok(dateBad.passed === false, 'boundaryDatePack FAILS against a naive normalizer that silently rolls impossible dates');
  ok(dateBad.failures.some(f => f.id === 'date-feb29-nonleap'), 'boundaryDatePack: catches Feb 29 non-leap silently normalized');

  const valGood = impossibleValuePack.evaluate(plausibilityValidator, impossibleValuePack.generateCases());
  ok(valGood.passed === true, 'impossibleValuePack PASSES against a correct plausibility validator');
  const valBad = impossibleValuePack.evaluate(passThroughValidator, impossibleValuePack.generateCases());
  ok(valBad.passed === false, 'impossibleValuePack FAILS against a pass-through validator');
  ok(valBad.failures.filter(f => /silently passed through/.test(f.reason)).length === 5, 'impossibleValuePack: all 5 impossible values flagged as uncaught by pass-through');

  // ---------------------------------------------------------------
  // 3. Determinism + never-throw discipline.
  // ---------------------------------------------------------------
  ok(JSON.stringify(nameOrderSwapPack.generateCases()) === JSON.stringify(nameOrderSwapPack.generateCases()),
    'generateCases() is deterministic (identical across calls)');

  const threw = boundaryDatePack.evaluate(() => { throw new Error('boom'); }, boundaryDatePack.generateCases());
  ok(threw.passed === false && threw.failures.every(f => /threw/.test(f.reason)), 'evaluate: an agent that throws is recorded as failures, not a crash');

  const notFn = nameOrderSwapPack.evaluate(null, nameOrderSwapPack.generateCases());
  ok(notFn.passed === false && /not a function/.test(notFn.failures[0].reason), 'evaluate: a non-function agent is handled safely');

  // ---------------------------------------------------------------
  // 4. runAdversarialSuite: summary shape for buildValidationVerdict.
  // ---------------------------------------------------------------
  const suite = runAdversarialSuite([boundaryDatePack, impossibleValuePack], strictDateNormalizer);
  ok(suite.ok === true && Array.isArray(suite.packResults), 'runAdversarialSuite: returns ok + packResults array');
  ok(suite.packResults.every(p => typeof p.id === 'string' && typeof p.passed === 'boolean'),
    'runAdversarialSuite: each packResult has the {id, passed} shape buildValidationVerdict expects');
  // strictDateNormalizer is right for dates but wrong-typed for the value pack,
  // so exactly one pack passes — proving the counts add up.
  ok(suite.passedCount + suite.failedCount === suite.packResults.length, 'runAdversarialSuite: passed + failed counts reconcile');

  const badSuite = runAdversarialSuite('not-an-array', () => true);
  ok(badSuite.ok === false && badSuite.packResults.length === 0, 'runAdversarialSuite: non-array packs handled safely');

  const malformed = runAdversarialSuite([{ id: 'x' }], () => true);
  ok(malformed.packResults[0].passed === false, 'runAdversarialSuite: a malformed pack is a failed pack, not a crash');

  ok(CRUCIBLE_PACKS.length === 4, 'CRUCIBLE_PACKS exports all four packs');

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
