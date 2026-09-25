// Federated Learning real-world stress test (Structural Readiness Phase item 1,
// fourth and final module). See test-harness/federated-realworld/stress_cases.md
// for the full method, ground truth, and an honest account of a first fix
// attempt (mean-based cap) that was caught not actually working before this
// (median-based) fix landed.
//
// Found and fixed: aggregateRound's FedAvg weighting has no upper bound on
// a contributor's self-reported sampleCount -- Math.max(1, ...) only
// enforces a floor. A single peer (malicious, buggy, or misconfigured)
// reporting a fabricated, enormous sampleCount could fully dominate the
// weighted average and erase an honest cohort's real signal -- a textbook
// FedAvg data-poisoning vector. Fixed by capping each contributor's
// effective sampleCount at 3x the cohort's MEDIAN sampleCount before
// weighting (median, not mean, since the mean is itself skewed by the same
// outlier it needs to constrain).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRound, MODEL_DIM, MAX_PEER_WEIGHT_SHARE_MULTIPLE } from '../js/federated/federated-learning.js';

function mkUpdate(val) {
  const v = new Array(MODEL_DIM).fill(0);
  v[0] = val;
  return v;
}

describe('aggregateRound -- existing honest-cohort behavior unaffected', () => {
  test('an honest cohort with no outliers aggregates exactly as before (no capping triggered)', () => {
    const contribs = [
      { update: mkUpdate(0.05), sampleCount: 10 },
      { update: mkUpdate(0.05), sampleCount: 12 },
      { update: mkUpdate(0.05), sampleCount: 8 },
    ];
    const agg = aggregateRound(contribs, new Array(MODEL_DIM).fill(0.5), { minCohort: 3 });
    assert.equal(agg.applied, true);
    assert.equal(agg.weightCapped, false, 'no contributor should be flagged as capped when none is an outlier');
    assert.ok(agg.weights[0] > 0.5, 'three peers agreeing on a positive delta should still nudge the weight up');
  });

  test('the pre-existing higher-sample-contributor test case still passes within its original bounds', () => {
    // Same fixture as test/federated-learning.test.mjs's own FedAvg case
    // (sampleCount: 30, 1, 1) -- confirms the fix doesn't break that test's
    // qualitative claim ("the sample-weighted mean pulls toward the
    // higher-sample contributor"), even though the exact value shifts from
    // 0.875 (uncapped) to 0.74 (median=1, capped at 3x=3) because 30 is
    // itself now treated as a capped outlier relative to its own cohort.
    const contribs = [
      { update: mkUpdate(0.4), sampleCount: 30 },
      { update: mkUpdate(0.0), sampleCount: 1 },
      { update: mkUpdate(0.0), sampleCount: 1 },
    ];
    const agg = aggregateRound(contribs, new Array(MODEL_DIM).fill(0.5), { minCohort: 3 });
    assert.equal(agg.applied, true);
    assert.ok(agg.weights[0] > 0.5 && agg.weights[0] < 0.9, 'still pulls toward the higher-sample contributor, within original bounds');
  });
});

describe('aggregateRound -- adversarial / implausible sampleCount (found bug, now fixed)', () => {
  test('a fabricated, enormous sampleCount no longer fully dominates and erases an honest cohort', () => {
    // Real bug (pre-fix): this scored weights[0] === 0.5 exactly (fully
    // dominated by the outlier's negative update, honest cohort's positive
    // signal completely erased -- verified via test-harness before the fix).
    const honestOnly = [
      { update: mkUpdate(0.05), sampleCount: 10 },
      { update: mkUpdate(0.05), sampleCount: 12 },
      { update: mkUpdate(0.05), sampleCount: 8 },
    ];
    const withFabricatedOutlier = [
      ...honestOnly,
      { update: mkUpdate(-0.9), sampleCount: 999999999 },
    ];
    const agg = aggregateRound(withFabricatedOutlier, new Array(MODEL_DIM).fill(0.5), { minCohort: 3 });
    assert.equal(agg.applied, true);
    assert.equal(agg.weightCapped, true, 'the fabricated sampleCount must be flagged as capped');
    assert.ok(agg.weights[0] > 0, 'the honest cohort\'s positive signal must survive at least partially, not be fully erased to 0');
    assert.ok(agg.weights[0] < 0.5, 'the outlier still has real (bounded) negative pull -- the cap limits domination, it does not veto the peer entirely');
  });

  test('the cap is anchored to the median, not the mean, so an extreme outlier cannot inflate its own ceiling', () => {
    // This is the specific regression the first (mean-based) fix attempt
    // had: an extreme value drags the mean up almost as much as it drags
    // the raw total up, so "3x mean" barely constrains anything. Locking in
    // that the cap actually bites for a realistic honest-cohort shape.
    const contribs = [
      { update: mkUpdate(0), sampleCount: 10 },
      { update: mkUpdate(0), sampleCount: 12 },
      { update: mkUpdate(0), sampleCount: 8 },
      { update: mkUpdate(1), sampleCount: 999999999 },
    ];
    const agg = aggregateRound(contribs, new Array(MODEL_DIM).fill(0.5), { minCohort: 3 });
    const medianOfHonest = 10; // median of [8, 10, 12]
    const expectedCappedShare = medianOfHonest * MAX_PEER_WEIGHT_SHARE_MULTIPLE; // 30
    const expectedTotal = 8 + 10 + 12 + expectedCappedShare; // 60
    const expectedWeight = 0.5 + (1 * expectedCappedShare) / expectedTotal;
    assert.ok(Math.abs(agg.weights[0] - expectedWeight) < 1e-9, `expected the outlier's effective weight share to be capped at ${expectedCappedShare} (3x median of honest peers), got weights[0]=${agg.weights[0]}`);
  });

  test('a genuinely more-active (but plausible) peer still gets real extra weight, not flattened by the cap', () => {
    const contribs = [
      { update: mkUpdate(0.05), sampleCount: 10 },
      { update: mkUpdate(0.05), sampleCount: 12 },
      { update: mkUpdate(0.05), sampleCount: 8 },
      { update: mkUpdate(0.10), sampleCount: 50 }, // ~5x the others, plausible, not fabricated
    ];
    const agg = aggregateRound(contribs, new Array(MODEL_DIM).fill(0.5), { minCohort: 3 });
    assert.equal(agg.weightCapped, true, '50 still exceeds 3x the median of [8,10,12]=10, so it is capped to 30');
    assert.ok(agg.weights[0] > 0.55, 'a genuinely more-active peer must still pull the aggregate meaningfully further than an all-equal cohort would');
  });
});
