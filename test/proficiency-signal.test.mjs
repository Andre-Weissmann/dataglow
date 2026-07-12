// ============================================================
// DATAGLOW — Session Proficiency Signal test suite (Glow Path, Batch B)
// ============================================================
// Proves js/learning/proficiency-signal.js is an honest, PURE, session-scoped
// tally + classifier:
//   - an empty tracker starts at 'low' with all-zero counts
//   - each density threshold boundary is crossed exactly (4 vs 5, 24 vs 25)
//   - recordAction increments only the given tabId and leaves the others alone
//   - getActionCounts returns a defensive snapshot (mutating it is harmless)
//   - reset() zeroes everything
//   - classifyDensity is directly callable, pure and side-effect-free
//   - the exported threshold constants are the ones the classifier uses
//
// RUN WITH: node test/proficiency-signal.test.mjs (pure logic, no deps)

import {
  createProficiencyTracker,
  classifyDensity,
  DENSITY_MID_THRESHOLD,
  DENSITY_HIGH_THRESHOLD,
} from '../js/learning/proficiency-signal.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Record a tab action `n` times on a tracker.
function bump(tracker, tabId, n) {
  for (let i = 0; i < n; i++) tracker.recordAction(tabId);
}

function main() {
  // --- exported threshold constants are the documented starting heuristic ---
  ok(DENSITY_MID_THRESHOLD === 5, 'DENSITY_MID_THRESHOLD is 5');
  ok(DENSITY_HIGH_THRESHOLD === 25, 'DENSITY_HIGH_THRESHOLD is 25');

  // --- empty tracker: 'low', zero total, empty snapshot ---
  {
    const t = createProficiencyTracker();
    ok(t.getTotalActions() === 0, 'empty tracker has 0 total actions');
    ok(JSON.stringify(t.getActionCounts()) === '{}', 'empty tracker has an empty counts snapshot');
    ok(t.getDensityLevel() === 'low', 'empty tracker classifies as low');
  }

  // --- recordAction increments the right tab only ---
  {
    const t = createProficiencyTracker();
    t.recordAction('sql');
    t.recordAction('sql');
    t.recordAction('python');
    const counts = t.getActionCounts();
    ok(counts.sql === 2, 'recordAction increments the sql counter (2)');
    ok(counts.python === 1, 'recordAction increments the python counter (1)');
    ok(counts.r === undefined, 'a tab never acted on stays absent from the snapshot');
    ok(t.getTotalActions() === 3, 'getTotalActions sums across tabs (3)');
  }

  // --- recordAction leaves other tabs untouched ---
  {
    const t = createProficiencyTracker();
    bump(t, 'sql', 3);
    bump(t, 'r', 1);
    const before = t.getActionCounts();
    t.recordAction('python');
    const after = t.getActionCounts();
    ok(after.sql === before.sql, 'recording python leaves sql untouched');
    ok(after.r === before.r, 'recording python leaves r untouched');
    ok(after.python === 1, 'recording python creates exactly its own counter');
  }

  // --- ignores empty / null tabId rather than throwing ---
  {
    const t = createProficiencyTracker();
    t.recordAction('');
    t.recordAction(null);
    t.recordAction(undefined);
    ok(t.getTotalActions() === 0, 'empty/null/undefined tabId is ignored, records nothing');
  }

  // --- threshold boundary: 4 => low, 5 => mid (exact) ---
  {
    const t = createProficiencyTracker();
    bump(t, 'sql', 4);
    ok(t.getTotalActions() === 4 && t.getDensityLevel() === 'low', '4 total actions is still low (below mid threshold)');
    t.recordAction('sql');
    ok(t.getTotalActions() === 5 && t.getDensityLevel() === 'mid', 'the 5th action crosses exactly into mid');
  }

  // --- threshold boundary: 24 => mid, 25 => high (exact) ---
  {
    const t = createProficiencyTracker();
    bump(t, 'sql', 24);
    ok(t.getTotalActions() === 24 && t.getDensityLevel() === 'mid', '24 total actions is still mid (below high threshold)');
    t.recordAction('sql');
    ok(t.getTotalActions() === 25 && t.getDensityLevel() === 'high', 'the 25th action crosses exactly into high');
  }

  // --- totals accumulate across MULTIPLE tabs toward the same thresholds ---
  {
    const t = createProficiencyTracker();
    bump(t, 'sql', 3);
    bump(t, 'python', 2);
    ok(t.getTotalActions() === 5 && t.getDensityLevel() === 'mid', 'mixed-tab actions summing to 5 reach mid');
    bump(t, 'r', 20);
    ok(t.getTotalActions() === 25 && t.getDensityLevel() === 'high', 'mixed-tab actions summing to 25 reach high');
  }

  // --- getActionCounts is a defensive snapshot: mutating it is harmless ---
  {
    const t = createProficiencyTracker();
    bump(t, 'sql', 2);
    const snap = t.getActionCounts();
    snap.sql = 999;
    snap.injected = 42;
    ok(t.getActionCounts().sql === 2, 'mutating a snapshot does not change the stored sql count');
    ok(t.getActionCounts().injected === undefined, 'adding a key to a snapshot does not leak into the tracker');
    ok(t.getTotalActions() === 2, 'total is unaffected by snapshot mutation');
  }

  // --- reset() zeroes everything ---
  {
    const t = createProficiencyTracker();
    bump(t, 'sql', 20);
    bump(t, 'python', 5);
    ok(t.getDensityLevel() === 'high', 'pre-reset the tracker is high (25 actions)');
    t.reset();
    ok(t.getTotalActions() === 0, 'reset zeroes the total');
    ok(JSON.stringify(t.getActionCounts()) === '{}', 'reset empties the counts snapshot');
    ok(t.getDensityLevel() === 'low', 'reset returns the level to low');
    t.recordAction('sql');
    ok(t.getTotalActions() === 1, 'the tracker is fully usable again after reset');
  }

  // --- classifyDensity is directly callable and pure ---
  {
    ok(classifyDensity(0, 0) === 'low', 'classifyDensity(0) is low');
    ok(classifyDensity(4, 1) === 'low', 'classifyDensity(4) is low');
    ok(classifyDensity(5, 1) === 'mid', 'classifyDensity(5) is mid (boundary)');
    ok(classifyDensity(24, 3) === 'mid', 'classifyDensity(24) is mid');
    ok(classifyDensity(25, 3) === 'high', 'classifyDensity(25) is high (boundary)');
    ok(classifyDensity(1000, 4) === 'high', 'classifyDensity(large) is high');

    // Pure: same inputs always produce the same output.
    ok(classifyDensity(7, 2) === classifyDensity(7, 2), 'classifyDensity is deterministic for identical inputs');

    // distinctTabsUsed is currently unused: it must NOT change the result for a
    // fixed total, and in particular must never lower the level.
    ok(classifyDensity(30, 1) === classifyDensity(30, 4), 'distinctTabsUsed does not change the level (reserved, unused)');
    ok(classifyDensity(5, 5) === 'mid', 'many distinct tabs never lowers a mid total below mid');

    // Tolerant of junk input rather than throwing (treated as 0).
    ok(classifyDensity(undefined, undefined) === 'low', 'classifyDensity(undefined) safely returns low');
    ok(classifyDensity(NaN, 0) === 'low', 'classifyDensity(NaN) safely returns low');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
