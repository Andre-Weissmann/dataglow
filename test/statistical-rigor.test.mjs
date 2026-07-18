// ============================================================
// DATAGLOW — Statistical Rigor Layer test suite
// ============================================================
// Proves Batch 1 of "The Rigor Engine" is deterministic, pure, and honest:
//   - mean/sampleStdDev handle empty/singleton/normal inputs correctly;
//   - confidenceIntervalForMean produces a real, checkable interval and
//     degrades to null rather than guessing when n < 2;
//   - classifySampleSize / classifyConfidence never call a small sample
//     "sufficient" (the exact honesty property Batch 3's Agent Honesty Layer
//     will depend on);
//   - cohensD returns correct magnitude buckets against known textbook
//     examples, and null rather than a divide-by-zero when there's no
//     variance to normalize by;
//   - bonferroniAdjustedAlpha divides correctly and floors comparisons at 1;
//   - detectSimpsonsParadox correctly flags a real textbook-style reversal
//     and correctly reports "no reversal" for consistent data;
//   - a source scan proves the module names no DOM/network/DuckDB primitive,
//     matching every other pure-math module in this repo (Benford's Law,
//     on-device anomaly scoring, robustness verdict).
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/statistical-rigor.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  mean,
  sampleStdDev,
  confidenceIntervalForMean,
  classifySampleSize,
  cohensD,
  bonferroniAdjustedAlpha,
  detectSimpsonsParadox,
  classifyConfidence,
} from '../js/rigor/statistical-rigor.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
function close(a, b, tolerance = 0.001) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance;
}

// ---------- mean / sampleStdDev ----------
ok(mean([]) === null, 'mean([]) returns null');
ok(mean([5]) === 5, 'mean([5]) === 5');
ok(close(mean([1, 2, 3, 4, 5]), 3), 'mean([1..5]) === 3');
ok(mean([1, 'x', NaN, 3]) === 2, 'mean() filters out non-finite/non-numeric entries');

ok(sampleStdDev([]) === null, 'sampleStdDev([]) returns null');
ok(sampleStdDev([5]) === null, 'sampleStdDev([single value]) returns null (need n>=2)');
ok(close(sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9]), 2.13809, 0.01), 'sampleStdDev matches known textbook value');

// ---------- confidenceIntervalForMean ----------
ok(confidenceIntervalForMean([1]) === null, 'CI returns null for n<2');
{
  const ci = confidenceIntervalForMean([10, 12, 11, 13, 9, 14, 10, 12, 11, 13], 0.95);
  ok(ci !== null, 'CI computed for n=10 sample');
  ok(ci.n === 10, 'CI reports correct n');
  ok(ci.lower < ci.mean && ci.mean < ci.upper, 'CI lower < mean < upper');
  ok(close(ci.marginOfError, 1.96 * (sampleStdDev([10, 12, 11, 13, 9, 14, 10, 12, 11, 13]) / Math.sqrt(10)), 0.0001),
    'CI margin of error uses z=1.96 for 95% confidence');
}
{
  const ci90 = confidenceIntervalForMean([10, 12, 11, 13, 9], 0.90);
  const ci99 = confidenceIntervalForMean([10, 12, 11, 13, 9], 0.99);
  ok(ci90.marginOfError < ci99.marginOfError, '90% CI is narrower than 99% CI for the same sample');
}

// ---------- classifySampleSize / classifyConfidence (the honesty property) ----------
ok(classifySampleSize(5) === 'insufficient', 'n=5 classified insufficient');
ok(classifySampleSize(9) === 'insufficient', 'n=9 classified insufficient (below low threshold)');
ok(classifySampleSize(10) === 'low', 'n=10 classified low');
ok(classifySampleSize(29) === 'low', 'n=29 classified low (below sufficient threshold)');
ok(classifySampleSize(30) === 'sufficient', 'n=30 classified sufficient');
ok(classifySampleSize(1000) === 'sufficient', 'n=1000 classified sufficient');

{
  const smallSample = [298.6, 210, 305, 190, 220]; // n=5, mirrors today's Humana/Molina-style low-N finding
  const verdict = classifyConfidence(smallSample);
  ok(verdict.verdict === 'insufficient', 'classifyConfidence never calls n=5 "sufficient" (honesty property)');
  ok(verdict.reason.includes('too few'), 'classifyConfidence gives a human-readable reason for low-N rejection');
}
{
  const largeSample = Array.from({ length: 428 }, (_, i) => 400 + (i % 17)); // mirrors today's Medicare n=428 finding
  const verdict = classifyConfidence(largeSample);
  ok(verdict.verdict === 'sufficient', 'classifyConfidence correctly calls n=428 "sufficient"');
  ok(verdict.ci !== null, 'classifyConfidence returns a real CI object when sufficient');
}
ok(classifyConfidence([]).verdict === 'insufficient', 'classifyConfidence([]) degrades to insufficient, never throws');

// ---------- cohensD ----------
ok(cohensD([1], [1, 2, 3]) === null, 'cohensD returns null when a group has <2 values');
ok(cohensD([5, 5, 5], [5, 5, 5]) === null, 'cohensD returns null (not NaN/Infinity) when pooled SD is 0');
{
  // Known example: two groups differing by exactly 1 pooled SD → |d| ≈ 1 (large)
  const groupA = [10, 12, 11, 13, 9, 14, 10, 12];
  const sdA = sampleStdDev(groupA);
  const groupB = groupA.map((v) => v - sdA); // shift every value down by one pooled-ish SD
  const result = cohensD(groupA, groupB);
  ok(result !== null, 'cohensD computed for a real two-group example');
  ok(result.d > 0, 'cohensD sign is positive when group A > group B');
  ok(['medium', 'large'].includes(result.magnitude), 'cohensD magnitude bucket is medium/large for a ~1-SD shift');
}
{
  const tiny = cohensD([10, 10.1, 9.9, 10.05], [10, 10.05, 9.95, 10.1]);
  ok(tiny !== null && tiny.magnitude === 'negligible', 'cohensD correctly buckets a near-identical pair as negligible');
}

// ---------- bonferroniAdjustedAlpha ----------
ok(close(bonferroniAdjustedAlpha(1), 0.05), 'bonferroniAdjustedAlpha(1) === familyWiseAlpha unchanged');
ok(close(bonferroniAdjustedAlpha(6), 0.05 / 6), 'bonferroniAdjustedAlpha(6) divides by 6 (matches 6-payer-group scenario)');
ok(close(bonferroniAdjustedAlpha(0), 0.05), 'bonferroniAdjustedAlpha floors comparisons at 1, never divides by 0');
ok(close(bonferroniAdjustedAlpha(4, 0.10), 0.025), 'bonferroniAdjustedAlpha respects a custom family-wise alpha');

// ---------- detectSimpsonsParadox ----------
{
  // Classic-style reversal: B beats A in both segments individually, but A's
  // large-n segment happens to be its high-scoring one (and vice versa for
  // B), so the weighted overall average flips in A's favor. Verified by hand
  // (segment-weighted arithmetic) before encoding here.
  const reversalRows = [
    { segment: 'seg1', group: 'A', value: 80, n: 190 },
    { segment: 'seg1', group: 'B', value: 90, n: 10 },
    { segment: 'seg2', group: 'A', value: 30, n: 10 },
    { segment: 'seg2', group: 'B', value: 40, n: 190 },
  ];
  const result = detectSimpsonsParadox(reversalRows, 'A', 'B');
  ok(result.segmentDirections.seg1 === 'B', 'segment 1 correctly shows B ahead');
  ok(result.segmentDirections.seg2 === 'B', 'segment 2 correctly shows B ahead');
  ok(result.overallDirection === 'A', 'weighted overall correctly favors A despite B winning every segment');
  ok(result.reversalDetected === true, 'detectSimpsonsParadox flags the reversal');
}
{
  // Consistent data: A wins overall and in every segment — no paradox.
  const consistentRows = [
    { segment: 'seg1', group: 'A', value: 100, n: 50 },
    { segment: 'seg1', group: 'B', value: 80, n: 50 },
    { segment: 'seg2', group: 'A', value: 90, n: 50 },
    { segment: 'seg2', group: 'B', value: 70, n: 50 },
  ];
  const result = detectSimpsonsParadox(consistentRows, 'A', 'B');
  ok(result.reversalDetected === false, 'detectSimpsonsParadox correctly reports no reversal for consistent data');
}
{
  // Real dataset shape from today's test findings: no reversal when segmented by claim_type.
  const noReversalRows = [
    { segment: 'inpatient', group: 'Medicare', value: 420, n: 200 },
    { segment: 'inpatient', group: 'Humana', value: 300, n: 6 },
    { segment: 'outpatient', group: 'Medicare', value: 405, n: 228 },
    { segment: 'outpatient', group: 'Humana', value: 295, n: 5 },
  ];
  const result = detectSimpsonsParadox(noReversalRows, 'Medicare', 'Humana');
  ok(result.reversalDetected === false, 'detectSimpsonsParadox matches today\'s finding: no reversal for Medicare vs Humana by claim_type');
}
ok(detectSimpsonsParadox([], 'A', 'B').reversalDetected === false, 'detectSimpsonsParadox degrades cleanly on empty input, never throws');

// ---------- source scan: prove this module names no DOM/network/DuckDB primitive ----------
{
  const __filename = fileURLToPath(import.meta.url);
  const modulePath = new URL('../js/rigor/statistical-rigor.js', import.meta.url);
  const source = readFileSync(modulePath, 'utf8');
  const forbidden = ['document.', 'window.', 'fetch(', 'XMLHttpRequest', 'runQuery', 'localStorage', 'indexedDB'];
  const found = forbidden.filter((token) => source.includes(token));
  ok(found.length === 0, `statistical-rigor.js names no DOM/network/DuckDB primitive (checked: ${forbidden.join(', ')})`);
}

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
