// AI Council real-world stress test (Structural Readiness Phase item 1).
//
// Existing tests in phase11-ai-council.test.mjs prove scoreAlignment handles
// clean, textbook-worded findings correctly. This file locks in the results
// of a stress test against the kind of verbose, hedged, negated findings a
// real LLM actually writes in a structured FINDING section -- see
// test-harness/council-realworld/stress_cases.md for the full method,
// ground-truth reasoning, and an honest account of what the fix did and did
// not resolve.
//
// Found and fixed: scoreAlignment had no negation handling at all, so
// "Revenue did NOT increase significantly" counted "increase"/"significant"
// as positive hits identical to a genuinely positive finding -- two directly
// contradicting findings could score as AGREE. Fixed with local negation
// detection scoped to directional signal words only (not magnitude/
// confidence words like "significant"/"strong"/"weak", where negation
// doesn't reverse direction -- "not significant" means small/uncertain, not
// opposite-direction).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAlignment } from '../js/council/council-engine.js';

describe('scoreAlignment -- values that already worked correctly (no regression)', () => {
  test('two clean textbook-positive findings still agree', () => {
    assert.equal(scoreAlignment('Revenue increased significantly', 'Strong positive growth observed'), 1);
  });

  test('two clean textbook-neutral findings still score neutral', () => {
    assert.equal(scoreAlignment('neutral observation with no clear direction', 'another neutral finding here'), 0);
  });

  test('empty and null inputs still score neutral', () => {
    assert.equal(scoreAlignment('', ''), 0);
    assert.equal(scoreAlignment(null, null), 0);
  });

  test('hedged-positive vs confident-positive still agree (both positive-leaning)', () => {
    const a = 'The trend is positive and the increase is significant, but this could decline if the underlying driver weakens.';
    const b = 'This shows a clear positive, significant increase with strong supporting evidence.';
    assert.equal(scoreAlignment(a, b), 1);
  });
});

describe('scoreAlignment -- real-world negation and hedging (found bugs, now fixed)', () => {
  test('a directly negated directional claim no longer scores as AGREE with its positive counterpart', () => {
    // Real bug (pre-fix): this scored 1 (AGREE) because "increase"/"significant"
    // matched as positive hits in both strings with no negation awareness --
    // two directly contradicting findings were told to align. Post-fix: 0
    // (NEUTRAL) -- not a perfect CONTRADICT (that would need clause-level
    // parsing), but no longer a false, dangerous AGREE. See stress_cases.md
    // point 1 for the full trace of why NEUTRAL, not CONTRADICT, is where a
    // word-window heuristic honestly lands here.
    const a = 'Revenue increased significantly this quarter.';
    const b = 'Revenue did not increase significantly; the apparent growth was seasonal noise.';
    const score = scoreAlignment(a, b);
    assert.notEqual(score, 1, 'must not score a negated claim as AGREE with the un-negated original');
  });

  test('a magnitude hedge ("not strong enough to be significant") does not over-negate into a false agreement', () => {
    // Real bug found during fix iteration: an earlier, broader negation rule
    // (flipping ALL signal words, not just directional ones) misread "not
    // strong enough to be significant" as a full polarity reversal, which
    // flipped this correctly-contradicting pair into a false AGREE. Negation
    // is now scoped to directional words only (increase/decrease, better/
    // worse, etc.) -- magnitude words like "significant"/"strong"/"weak" are
    // deliberately excluded, since "not significant" means small/uncertain,
    // not reversed-direction.
    const weakPositive = 'There is a modest positive signal, though it is weak and the improvement is not strong enough to be significant on its own.';
    const clearNegative = 'The data shows a clear negative trend; performance has declined and is significantly worse than the prior period.';
    assert.equal(scoreAlignment(weakPositive, clearNegative), -1, 'a weak-but-positive finding must still contradict a clearly negative one');
  });

  test('findings with no catalog signal words at all score neutral, not a false match (documented recall gap)', () => {
    // Not a regression target for this pass -- documented as a known
    // limitation. Both findings describe an upward move in different words
    // ("increased" vs "shifted upward"), but neither uses a catalog word, so
    // the scorer has no signal to act on. Fixing this would mean expanding
    // vocabulary coverage or moving to semantic similarity -- out of scope
    // here. This test locks in the CURRENT (imperfect but honest) behavior
    // so a future change to this is a deliberate decision, not silent drift.
    const a = 'The metric moved from 4.2 to 4.7 over the observed window.';
    const b = "The value shifted upward across the same period, consistent with the prior quarter's trajectory.";
    assert.equal(scoreAlignment(a, b), 0);
  });
});
