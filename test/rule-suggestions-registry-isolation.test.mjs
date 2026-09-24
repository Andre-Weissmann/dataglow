// Tests for js/learning/rule-suggestions.js: the module-level default
// tracker must keep its original behavior unchanged, and the new
// createCorrectionTracker() factory must produce genuinely isolated
// instances -- enterprise-readiness singleton-isolation retrofit
// (2026-09-24), retrofit 4/4 (final file).
//
// This file also happens to be rule-suggestions.js's first dedicated test
// coverage (none existed before this retrofit), so it exercises the basic
// recordCorrection/getSuggestedRules contract in addition to isolation.
import assert from 'node:assert/strict';
import {
  recordCorrection,
  getSuggestedRules,
  createCorrectionTracker,
} from '../js/learning/rule-suggestions.js';

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ---- Default (module-level) singleton behavior is unchanged ----

test('default tracker: a correction below minOccurrences is not suggested', () => {
  const col = `default_below_threshold_${Date.now()}`;
  recordCorrection('orig1', 'fixed1', col);
  const suggestions = getSuggestedRules(3).filter(s => s.column === col);
  assert.strictEqual(suggestions.length, 0, 'a single occurrence should not clear the default threshold of 3');
});

test('default tracker: repeated identical corrections aggregate into one counted entry', () => {
  const col = `default_aggregate_${Date.now()}`;
  recordCorrection('origA', 'fixedA', col);
  recordCorrection('origA', 'fixedA', col);
  recordCorrection('origA', 'fixedA', col);
  const suggestions = getSuggestedRules(3).filter(s => s.column === col);
  assert.strictEqual(suggestions.length, 1, 'three identical corrections should aggregate to exactly one suggestion entry');
  assert.strictEqual(suggestions[0].occurrences, 3);
});

test('default tracker: identical original and corrected value is a no-op (not counted)', () => {
  const col = `default_noop_${Date.now()}`;
  const result = recordCorrection('same', 'same', col);
  assert.strictEqual(result, undefined, 'recordCorrection should return undefined for a no-op correction');
});

// ---- New factory: genuinely isolated instances ----

test('createCorrectionTracker: returns the full tracker API surface', () => {
  const tracker = createCorrectionTracker();
  assert.strictEqual(typeof tracker.recordCorrection, 'function');
  assert.strictEqual(typeof tracker.getSuggestedRules, 'function');
});

test('createCorrectionTracker: starts with zero suggestions (no built-in seed data, unlike the other three registries)', () => {
  const tracker = createCorrectionTracker();
  assert.strictEqual(tracker.getSuggestedRules(1).length, 0, 'a freshly created tracker should have no corrections recorded yet');
});

test('createCorrectionTracker: corrections recorded on one instance are invisible to another (the core isolation guarantee)', () => {
  const trackerA = createCorrectionTracker();
  const trackerB = createCorrectionTracker();
  const col = 'isolation_test_column';

  trackerA.recordCorrection('valX', 'valY', col);
  trackerA.recordCorrection('valX', 'valY', col);

  const suggestionsA = trackerA.getSuggestedRules(2);
  const suggestionsB = trackerB.getSuggestedRules(1);

  assert.strictEqual(suggestionsA.length, 1, 'trackerA should see its own recorded corrections');
  assert.strictEqual(suggestionsB.length, 0, 'trackerB must NOT see trackerA\'s corrections -- this is the actual multi-tenancy bug this retrofit prevents');
});

test('createCorrectionTracker: a factory-tracked correction does not leak into the module-level default tracker', () => {
  const isolated = createCorrectionTracker();
  const col = `isolated_only_${Date.now()}`;
  isolated.recordCorrection('p', 'q', col);
  isolated.recordCorrection('p', 'q', col);
  isolated.recordCorrection('p', 'q', col);

  assert.strictEqual(isolated.getSuggestedRules(3).length, 1, 'isolated tracker should have its own recorded correction');
  const leaked = getSuggestedRules(1).filter(s => s.column === col);
  assert.strictEqual(leaked.length, 0, 'the default module-level tracker must not see a correction recorded only on an isolated factory instance');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
