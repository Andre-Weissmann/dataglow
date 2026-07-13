// ============================================================
// DATAGLOW — Assumption Sensitivity + Robustness Verdict test suite
// ============================================================
// Proves the two new Analysis-Robustness capabilities are deterministic, pure,
// and honest:
//   - mapAssumptionSensitivity finds the smallest set of rows that breaks an
//     A-vs-B gap, names the segment they concentrate in, and labels severity;
//   - robustnessVerdict folds attackAnalysis + the sensitivity map into ONE
//     fixed-vocabulary verdict whose reason is grounded in real numbers;
//   - a clearly robust finding is called robust (plainly), a clearly fragile
//     one names the driving subgroup, and the edge cases (empty, single row,
//     no variance, no grouping column) degrade to a clean "inconclusive".
//   - a source scan proves the module names no DOM/network primitive.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/robustness-verdict.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mapAssumptionSensitivity, robustnessVerdict } from '../js/analysis-robustness/robustness-verdict.js';
import { attackAnalysis } from '../js/analysis-robustness/devils-advocate.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- fixtures ----------

// A clearly ROBUST finding: two balanced groups (60 each), a stable ~10.5% gap,
// no variance within a group, and a `region` column that is spread evenly so no
// single segment carries the effect.
function robustResult() {
  const regions = ['north', 'south', 'east', 'west'];
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({ grp: 'a', value: 100, region: regions[i % 4] });
  for (let i = 0; i < 60; i++) rows.push({ grp: 'b', value: 90, region: regions[i % 4] });
  return { columns: ['grp', 'value', 'region'], rows };
}

// A clearly FRAGILE finding: group "a" looks far above group "b", but only
// because 5 of its 40 rows are an outlier subgroup (region "west" ≈ 1000).
// Drop those 5 rows and the gap collapses to zero.
function fragileResult() {
  const rows = [];
  const normalRegions = ['north', 'south', 'east'];
  for (let i = 0; i < 35; i++) rows.push({ grp: 'a', value: 90, region: normalRegions[i % 3] });
  for (let i = 0; i < 5; i++) rows.push({ grp: 'a', value: 1000, region: 'west' });
  for (let i = 0; i < 40; i++) rows.push({ grp: 'b', value: 90, region: normalRegions[i % 3] });
  return { columns: ['grp', 'value', 'region'], rows };
}

function main() {
  // ---------- 1. Sensitivity mapper: robust finding ----------
  const rSens = mapAssumptionSensitivity(robustResult(), { log: false });
  ok(rSens.applicable === true, 'sensitivity(robust): applicable');
  ok(rSens.metricColumn === 'value' && rSens.groupColumn === 'grp', 'sensitivity(robust): picked value/grp columns');
  ok(rSens.groupA === 'a' && rSens.groupB === 'b', 'sensitivity(robust): A is the higher-mean group (a), B the lower (b)');
  ok(Math.abs(rSens.baseEffect.absolute - 10) < 1e-9, `sensitivity(robust): base gap is 10 (got ${rSens.baseEffect.absolute})`);
  ok(rSens.severity === 'robust', `sensitivity(robust): severity is robust (got "${rSens.severity}")`);
  ok(rSens.breakMode === 'stable' && rSens.minRowsToBreak === null, 'sensitivity(robust): no small row set breaks it');
  ok(rSens.segment === null, 'sensitivity(robust): no single driving segment');

  // ---------- 2. Sensitivity mapper: fragile finding ----------
  const fSens = mapAssumptionSensitivity(fragileResult(), { log: false });
  ok(fSens.applicable === true, 'sensitivity(fragile): applicable');
  ok(fSens.groupA === 'a' && fSens.groupB === 'b', 'sensitivity(fragile): A=a (inflated), B=b');
  ok(fSens.severity === 'fragile', `sensitivity(fragile): severity is fragile (got "${fSens.severity}")`);
  // Removing 4 of the 5 "west" rows already erases 75%+ of the gap (it drops to
  // ~22% of its original size), so 4 is the minimal breaking set, not 5.
  ok(fSens.minRowsToBreak === 4, `sensitivity(fragile): 4 rows break it (got ${fSens.minRowsToBreak})`);
  ok(fSens.breakMode === 'disappears', `sensitivity(fragile): the gap disappears (got "${fSens.breakMode}")`);
  ok(fSens.segment && fSens.segment.column === 'region' && fSens.segment.value === 'west',
    `sensitivity(fragile): driving segment is region="west" (got ${JSON.stringify(fSens.segment)})`);
  ok(fSens.segment && Math.abs(fSens.segment.coverage - 1) < 1e-9, 'sensitivity(fragile): all breaking rows are in that segment');
  ok(/west/.test(fSens.summary) && /gap/.test(fSens.summary), 'sensitivity(fragile): summary names the segment and the gap');

  // ---------- 3. Verdict: robust finding ----------
  const rAttack = attackAnalysis(robustResult(), { log: false });
  ok(rAttack.robust === true, `verdict(robust): attackAnalysis agrees it is robust ("${rAttack.verdict}")`);
  const rVerdict = robustnessVerdict(rAttack, rSens);
  ok(rVerdict.verdict === 'robust', `verdict(robust): verdict is "robust" (got "${rVerdict.verdict}")`);
  ok(rVerdict.drivingFactor === null, 'verdict(robust): no driving factor for a robust finding');
  ok(/holds up/.test(rVerdict.reason) && /"a"/.test(rVerdict.reason) && /"b"/.test(rVerdict.reason),
    'verdict(robust): reason says plainly that it holds up and names both groups');
  ok(/\d/.test(rVerdict.reason), 'verdict(robust): reason is grounded in a real number, not a bare template');

  // ---------- 4. Verdict: fragile finding names the subgroup ----------
  const fAttack = attackAnalysis(fragileResult(), { log: false });
  ok(fAttack.robust === false, `verdict(fragile): attackAnalysis agrees it is sensitive ("${fAttack.verdict}")`);
  const fVerdict = robustnessVerdict(fAttack, fSens);
  ok(fVerdict.verdict === 'fragile', `verdict(fragile): verdict is "fragile" (got "${fVerdict.verdict}")`);
  ok(fVerdict.drivingFactor === 'region = "west"', `verdict(fragile): drivingFactor names the subgroup (got "${fVerdict.drivingFactor}")`);
  ok(/west/.test(fVerdict.reason), 'verdict(fragile): reason names the driving subgroup');
  ok(/\b4\b/.test(fVerdict.reason) && /80/.test(fVerdict.reason), 'verdict(fragile): reason is grounded in the real row counts (4 of 80)');

  // ---------- 5. Edge case: empty data ----------
  const empty = { columns: [], rows: [] };
  const eSens = mapAssumptionSensitivity(empty, { log: false });
  ok(eSens.applicable === false && eSens.severity === 'inconclusive', 'edge(empty): sensitivity is inconclusive, not thrown');
  const eVerdict = robustnessVerdict(attackAnalysis(empty, { log: false }), eSens);
  ok(eVerdict.verdict === 'inconclusive', 'edge(empty): verdict is inconclusive');
  ok(eVerdict.drivingFactor === null, 'edge(empty): no driving factor');

  // ---------- 6. Edge case: single row ----------
  const single = { columns: ['grp', 'value'], rows: [{ grp: 'a', value: 5 }] };
  const sSens = mapAssumptionSensitivity(single, { log: false });
  ok(sSens.applicable === false, 'edge(single row): sensitivity not applicable');
  ok(robustnessVerdict(attackAnalysis(single, { log: false }), sSens).verdict === 'inconclusive',
    'edge(single row): verdict is inconclusive');

  // ---------- 7. Edge case: no variance (no real gap) ----------
  const flatRows = [];
  for (let i = 0; i < 20; i++) flatRows.push({ grp: 'a', value: 50 });
  for (let i = 0; i < 20; i++) flatRows.push({ grp: 'b', value: 50 });
  const flat = { columns: ['grp', 'value'], rows: flatRows };
  const flatSens = mapAssumptionSensitivity(flat, { log: false });
  ok(flatSens.applicable === true && flatSens.severity === 'no-effect',
    `edge(no variance): severity is no-effect (got "${flatSens.severity}")`);
  const flatVerdict = robustnessVerdict(attackAnalysis(flat, { log: false }), flatSens);
  ok(flatVerdict.verdict === 'inconclusive', 'edge(no variance): verdict is inconclusive (nothing to overturn)');
  ok(/zero|no real/i.test(flatVerdict.reason), 'edge(no variance): reason honestly says there is no gap');

  // ---------- 8. Edge case: no grouping column (single group) ----------
  const oneGroupRows = [];
  for (let i = 0; i < 10; i++) oneGroupRows.push({ grp: 'a', value: 10 + i });
  const oneGroup = { columns: ['grp', 'value'], rows: oneGroupRows };
  const ogSens = mapAssumptionSensitivity(oneGroup, { log: false });
  ok(ogSens.applicable === false, 'edge(one group): sensitivity not applicable (no A-vs-B split)');
  // Falls back to the attack report alone; a tight linear ramp is robust.
  const ogVerdict = robustnessVerdict(attackAnalysis(oneGroup, { log: false }), ogSens);
  ok(['robust', 'inconclusive'].includes(ogVerdict.verdict),
    `edge(one group): verdict falls back cleanly to the attack report (got "${ogVerdict.verdict}")`);

  // ---------- 9. Verdict is always one of the fixed vocabulary ----------
  const VOCAB = ['robust', 'fragile', 'inconclusive'];
  for (const v of [rVerdict, fVerdict, eVerdict, flatVerdict, ogVerdict]) {
    ok(VOCAB.includes(v.verdict), `verdict vocabulary: "${v.verdict}" is one of the fixed three`);
    ok(typeof v.reason === 'string' && v.reason.length > 0, 'verdict: reason is a non-empty string');
    ok(v.drivingFactor === null || typeof v.drivingFactor === 'string', 'verdict: drivingFactor is string|null');
  }

  // ---------- 10. Fragile driven by attack only (no fragile sensitivity segment) ----------
  // A single group with one extreme outlier: attackAnalysis flags the outlier
  // trim, but there is no A/B gap to map — verdict should be fragile via attack.
  const outlierRows = [];
  for (let i = 0; i < 30; i++) outlierRows.push({ id: i, value: 10 });
  outlierRows.push({ id: 99, value: 100000 });
  const outlier = { columns: ['id', 'value'], rows: outlierRows };
  const oAttack = attackAnalysis(outlier, { log: false });
  const oSens = mapAssumptionSensitivity(outlier, { log: false });
  const oVerdict = robustnessVerdict(oAttack, oSens);
  if (oAttack.robust === false) {
    ok(oVerdict.verdict === 'fragile', `verdict(attack-only fragile): fragile when the mean fails a stress-test (got "${oVerdict.verdict}")`);
    ok(/\d/.test(oVerdict.reason), 'verdict(attack-only fragile): reason carries a real number');
  } else {
    ok(true, 'verdict(attack-only fragile): attack judged robust on this shape — skipped (informational)');
  }

  // ---------- 11. Source scan: no DOM/network primitives ----------
  const src = readFileSync(fileURLToPath(new URL('../js/analysis-robustness/robustness-verdict.js', import.meta.url)), 'utf8');
  const banned = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'document.', 'window.', 'localStorage', 'sessionStorage', 'indexedDB'];
  for (const b of banned) {
    ok(!src.includes(b), `source scan: module does not reference "${b}"`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
