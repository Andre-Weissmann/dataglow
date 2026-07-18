// ============================================================
// DATAGLOW — Phase 4 Temporal Drift + Rulepacks Tests
// ============================================================
// Tests for:
//   js/rulepacks/rulepack-registry.js  -- load, validate, version-pin
//   js/rulepacks/packs/healthcare.js   -- healthcare thresholds
//   js/rulepacks/packs/general.js      -- general thresholds
//   js/drift/freshness-decay.js        -- decay multiplier math
//   js/drift/dataset-differ.js         -- snapshot capture + diff
//   js/equity/disparity-scorer.js      -- thresholds param (Phase 4 extension)
//
// No DuckDB needed for rulepack + decay tests.
// DuckDB needed for snapshot capture.
//
// Run (no DuckDB): node test/temporal-drift-rulepacks-phase4.test.mjs
// Run (with DuckDB): node --import ./test/duckdb-loader-hook.mjs test/temporal-drift-rulepacks-phase4.test.mjs

import {
  getRulepack, listRulepacks, registerPack, validatePack,
  buildVersionPin, diffVersionPins,
} from '../js/rulepacks/rulepack-registry.js';
import {
  computeFreshnessDecay, applyFreshnessDecay, freshnessLabel,
} from '../js/drift/freshness-decay.js';
import { captureSnapshot, diffSnapshots } from '../js/drift/dataset-differ.js';
import { scoreDisparities } from '../js/equity/disparity-scorer.js';
import * as nodeEngine from './node-duckdb-engine.mjs';

const { createTableFromObjects, runQuery, closeConnection } = nodeEngine;

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) { passed++; console.log('  ok ' + label); }
  else { failed++; console.log('FAIL ' + label); }
}

// ============================================================
// 1. Rulepack Registry
// ============================================================
console.log('\n-- getRulepack --');
{
  const hc = getRulepack('healthcare');
  ok(hc.id === 'healthcare', 'getRulepack(healthcare): id correct');
  ok(hc.version === '1.0.0', 'getRulepack(healthcare): version 1.0.0');
  ok(hc.domain === 'healthcare', 'getRulepack(healthcare): domain correct');
  ok(hc.equity.binary.rateRatioFail === 1.50, 'healthcare rateRatioFail = 1.50');
  ok(hc.equity.binary.absDiffFail === 0.05, 'healthcare absDiffFail = 0.05');
  ok(hc.freshness.staleAfterDays === 90, 'healthcare staleAfterDays = 90');

  const gen = getRulepack('general');
  ok(gen.id === 'general', 'getRulepack(general): id correct');
  ok(gen.equity.binary.rateRatioFail === 2.00, 'general rateRatioFail = 2.00 (looser)');
  ok(gen.freshness.staleAfterDays === 180, 'general staleAfterDays = 180 (more lenient)');

  // Unknown id falls back to general.
  const fallback = getRulepack('nonexistent');
  ok(fallback.id === 'general', 'unknown pack id falls back to general');
  const nullFallback = getRulepack(null);
  ok(nullFallback.id === 'general', 'null pack id falls back to general');
}

console.log('\n-- listRulepacks --');
{
  const list = listRulepacks();
  ok(list.length >= 2, 'at least 2 built-in packs');
  ok(list.some(p => p.id === 'healthcare'), 'healthcare listed');
  ok(list.some(p => p.id === 'general'), 'general listed');
  ok(list.every(p => p.id && p.version && p.label && p.domain), 'all packs have required summary fields');
}

console.log('\n-- validatePack --');
{
  // Valid pack.
  const hc = getRulepack('healthcare');
  ok(validatePack(hc).length === 0, 'validatePack(healthcare): no errors');

  // Missing id.
  const bad1 = { ...getRulepack('general'), id: undefined };
  ok(validatePack(bad1).length > 0, 'missing id: validation error');

  // Invalid decayFloor (> 1).
  const bad2 = JSON.parse(JSON.stringify(getRulepack('general')));
  bad2.freshness.decayFloor = 1.5;
  ok(validatePack(bad2).length > 0, 'decayFloor > 1: validation error');

  // Invalid decayShape.
  const bad3 = JSON.parse(JSON.stringify(getRulepack('general')));
  bad3.freshness.decayShape = 'quadratic';
  ok(validatePack(bad3).length > 0, 'invalid decayShape: validation error');

  // Non-numeric threshold.
  const bad4 = JSON.parse(JSON.stringify(getRulepack('general')));
  bad4.equity.binary.rateRatioFail = 'high';
  ok(validatePack(bad4).length > 0, 'non-numeric threshold: validation error');

  // registerPack with bad pack.
  const r = registerPack({ id: 'bad' });
  ok(r.ok === false, 'registerPack: bad pack rejected');
  ok(r.errors.length > 0, 'registerPack: errors returned');
}

console.log('\n-- registerPack (custom) --');
{
  const customPack = {
    id: 'finance',
    version: '1.0.0',
    label: 'Finance (Custom)',
    description: 'Test finance pack.',
    domain: 'finance',
    publishedAt: '2026-07-18',
    freshness: { staleAfterDays: 30, expiredAfterDays: 365, decayFloor: 0.7, decayShape: 'linear', rationale: 'Financial data ages quickly.' },
    equity: {
      binary: { rateRatioWarn: 1.3, rateRatioFail: 1.6, absDiffWarn: 0.04, absDiffFail: 0.08 },
      continuous: { smdWarn: 0.12, smdFail: 0.25 },
      minCellSize: 5, maxGroups: 50, rowSampleLimit: 50000,
      methodologyAttribution: 'Custom finance disparity analysis.',
    },
    changelog: [{ version: '1.0.0', date: '2026-07-18', notes: 'Initial.' }],
  };
  const r = registerPack(customPack);
  ok(r.ok === true, 'registerPack: valid custom pack accepted');
  ok(r.errors.length === 0, 'registerPack: no errors');
  const loaded = getRulepack('finance');
  ok(loaded.id === 'finance', 'custom pack retrievable by id');
  ok(loaded.equity.binary.rateRatioFail === 1.6, 'custom pack threshold preserved');
}

console.log('\n-- buildVersionPin + diffVersionPins --');
{
  const pin1 = buildVersionPin('healthcare');
  ok(pin1.packId === 'healthcare', 'pin: packId correct');
  ok(pin1.packVersion === '1.0.0', 'pin: packVersion correct');
  ok(pin1.packLabel === 'Healthcare (CMS / NCHS)', 'pin: packLabel correct');
  ok(typeof pin1.validatedAt === 'string', 'pin: validatedAt is a string');

  // Same pack + version -> no change.
  const pin2 = buildVersionPin('healthcare');
  const diff1 = diffVersionPins(pin1, pin2);
  ok(diff1.changed === false, 'diffVersionPins: same pack+version = not changed');

  // Different pack -> threshold diff.
  const pin3 = buildVersionPin('general');
  const diff2 = diffVersionPins(pin1, pin3);
  ok(diff2.changed === true, 'diffVersionPins: different packs = changed');
  ok(diff2.packChanged === true, 'diffVersionPins: packChanged = true');
  ok(diff2.thresholdDiff !== null, 'diffVersionPins: thresholdDiff present');
  ok(typeof diff2.summary === 'string', 'diffVersionPins: summary is a string');

  // Null pin.
  const diff3 = diffVersionPins(null, pin1);
  ok(diff3.changed === false, 'diffVersionPins: null pin = not changed');
}

// ============================================================
// 2. Freshness Decay
// ============================================================
console.log('\n-- computeFreshnessDecay -- fresh --');
{
  const asOf = new Date('2026-07-18');
  const fresh = computeFreshnessDecay({ dataDate: '2026-06-01', asOf, packId: 'healthcare' });
  // 47 days old < staleAfterDays=90
  ok(fresh.status === 'fresh', 'fresh: status fresh');
  ok(fresh.multiplier === 1.0, 'fresh: multiplier 1.0');
  ok(fresh.ageDays > 40 && fresh.ageDays < 60, 'fresh: ageDays in range');
  ok(fresh.rationale.includes('No trust penalty'), 'fresh: rationale mentions no penalty');
}

console.log('\n-- computeFreshnessDecay -- stale (linear) --');
{
  const asOf = new Date('2026-07-18');
  // 180 days old; healthcare staleAfterDays=90, expiredAfterDays=365.
  // decayProgress = (180-90)/(365-90) = 90/275 = 0.327
  // multiplier = 1.0 - (1.0 - 0.5) * 0.327 = 1.0 - 0.164 = 0.836
  const stale = computeFreshnessDecay({ dataDate: '2026-01-18', asOf, packId: 'healthcare' });
  ok(stale.status === 'stale', 'stale: status stale');
  ok(stale.multiplier > 0.5 && stale.multiplier < 1.0, 'stale: multiplier between floor and 1.0');
  ok(stale.rationale.includes('stale'), 'stale: rationale mentions stale');
}

console.log('\n-- computeFreshnessDecay -- expired --');
{
  const asOf = new Date('2026-07-18');
  // 2 years old -> expired for healthcare (expiredAfterDays=365)
  const expired = computeFreshnessDecay({ dataDate: '2024-07-18', asOf, packId: 'healthcare' });
  ok(expired.status === 'expired', 'expired: status expired');
  ok(expired.multiplier === 0.5, 'expired: multiplier = decayFloor (0.5)');
  ok(expired.rationale.includes('expired'), 'expired: rationale mentions expired');
}

console.log('\n-- computeFreshnessDecay -- edge cases --');
{
  // No data date -> unknown.
  const r1 = computeFreshnessDecay({ dataDate: null, packId: 'general' });
  ok(r1.status === 'unknown', 'null dataDate: status unknown');
  ok(r1.multiplier === 1.0, 'null dataDate: multiplier 1.0 (no penalty)');

  // Invalid date string.
  const r2 = computeFreshnessDecay({ dataDate: 'not-a-date', packId: 'general' });
  ok(r2.status === 'unknown', 'invalid date: status unknown');

  // Exponential decay.
  const asOf = new Date('2026-07-18');
  const r3 = computeFreshnessDecay({
    dataDate: '2026-01-18', asOf,
    freshnessConfig: { staleAfterDays: 30, expiredAfterDays: 365, decayFloor: 0.5, decayShape: 'exponential', rationale: '' },
  });
  ok(r3.status === 'stale', 'exponential: stale');
  ok(r3.multiplier > 0.5 && r3.multiplier < 1.0, 'exponential: multiplier in range');
  // Exponential should decay faster than linear for same progress.
  const r4 = computeFreshnessDecay({
    dataDate: '2026-01-18', asOf,
    freshnessConfig: { staleAfterDays: 30, expiredAfterDays: 365, decayFloor: 0.5, decayShape: 'linear', rationale: '' },
  });
  ok(r3.multiplier < r4.multiplier, 'exponential decays faster than linear at same progress');

  // General pack: 160 days old should be fresh (staleAfterDays=180).
  const r5 = computeFreshnessDecay({ dataDate: '2026-02-07', asOf, packId: 'general' });
  ok(r5.status === 'fresh', 'general pack: 160 days = still fresh (threshold 180)');
}

console.log('\n-- applyFreshnessDecay + freshnessLabel --');
{
  const asOf = new Date('2026-07-18');
  const expiredDecay = computeFreshnessDecay({ dataDate: '2024-07-18', asOf, packId: 'healthcare' });
  const applied = applyFreshnessDecay(80, expiredDecay);
  ok(applied.originalScore === 80, 'applyFreshnessDecay: originalScore preserved');
  ok(applied.adjustedScore === 40, 'applyFreshnessDecay: 80 * 0.5 = 40');
  ok(applied.multiplier === 0.5, 'applyFreshnessDecay: multiplier 0.5');

  const freshDecay = computeFreshnessDecay({ dataDate: '2026-06-01', asOf, packId: 'healthcare' });
  const freshApplied = applyFreshnessDecay(80, freshDecay);
  ok(freshApplied.adjustedScore === 80, 'applyFreshnessDecay: fresh data unchanged');

  ok(freshnessLabel(expiredDecay).includes('Expired'), 'freshnessLabel: expired label');
  ok(freshnessLabel(freshDecay).includes('Fresh'), 'freshnessLabel: fresh label');
  ok(freshnessLabel(null) === 'Unknown', 'freshnessLabel: null = Unknown');
}

// ============================================================
// 3. Dataset Differ (DuckDB)
// ============================================================
console.log('\n-- captureSnapshot --');
{
  await createTableFromObjects('snap_test', [
    { patient_id: 'P001', los: 3, readmit_30d: 0, race: 'White' },
    { patient_id: 'P002', los: 7, readmit_30d: 1, race: 'Black' },
    { patient_id: 'P003', los: null, readmit_30d: 0, race: 'Hispanic' },
    { patient_id: 'P004', los: 5, readmit_30d: null, race: null },
  ]);
  const cols = [
    { name: 'patient_id', type: 'VARCHAR' },
    { name: 'los', type: 'INTEGER' },
    { name: 'readmit_30d', type: 'INTEGER' },
    { name: 'race', type: 'VARCHAR' },
  ];
  const engine = { runQuery: nodeEngine.runQuery };
  const snap = await captureSnapshot({ table: 'snap_test', cols, engine, label: 'July 2026' });

  ok(snap.kind === 'dataglow_snapshot', 'snapshot: kind correct');
  ok(snap.rowCount === 4, 'snapshot: rowCount = 4');
  ok(snap.columnCount === 4, 'snapshot: columnCount = 4');
  ok(snap.label === 'July 2026', 'snapshot: label preserved');
  ok(typeof snap.capturedAt === 'string', 'snapshot: capturedAt is a string');
  const losStat = snap.columnStats.find(c => c.name === 'los');
  ok(losStat, 'snapshot: los stat present');
  ok(losStat.nullRate === 0.25, 'snapshot: los nullRate = 0.25 (1/4)');
  ok(losStat.distinctCount === 3, 'snapshot: los distinctCount = 3 (non-null distinct)');
  ok(losStat.meanVal !== null, 'snapshot: los meanVal computed');
  const raceStat = snap.columnStats.find(c => c.name === 'race');
  ok(raceStat.nullRate === 0.25, 'snapshot: race nullRate = 0.25');
  ok(raceStat.minVal === null, 'snapshot: race minVal null (non-numeric)');
}

console.log('\n-- diffSnapshots -- no changes --');
{
  const colsA = [{ name: 'los', type: 'INTEGER', nullRate: 0.05, distinctCount: 50, minVal: 1, maxVal: 30, meanVal: 5.2 }];
  const colsB = [{ name: 'los', type: 'INTEGER', nullRate: 0.05, distinctCount: 50, minVal: 1, maxVal: 30, meanVal: 5.2 }];
  const snapA = { kind: 'dataglow_snapshot', label: 'Jan', capturedAt: '2026-01-01T00:00:00Z', rowCount: 1000, columnCount: 1, columnStats: colsA };
  const snapB = { kind: 'dataglow_snapshot', label: 'Feb', capturedAt: '2026-02-01T00:00:00Z', rowCount: 1000, columnCount: 1, columnStats: colsB };
  const diff = diffSnapshots(snapA, snapB);
  ok(diff.status === 'pass', 'no changes: status pass');
  ok(diff.flaggedCount === 0, 'no changes: 0 flagged');
  ok(diff.rationale.includes('No significant'), 'no changes: rationale positive');
}

console.log('\n-- diffSnapshots -- row count drop --');
{
  const col = { name: 'los', type: 'INTEGER', nullRate: 0.05, distinctCount: 50, minVal: 1, maxVal: 30, meanVal: 5.2 };
  const snapA = { label: 'Jan', capturedAt: '2026-01-01T00:00:00Z', rowCount: 1000, columnCount: 1, columnStats: [col] };
  const snapB = { label: 'Feb', capturedAt: '2026-02-01T00:00:00Z', rowCount: 700, columnCount: 1, columnStats: [col] };
  const diff = diffSnapshots(snapA, snapB);
  ok(diff.status === 'fail', 'row count drop 30%: status fail');
  ok(diff.findings.some(f => f.kind === 'row_count_changed'), 'row count finding present');
  ok(diff.findings.find(f => f.kind === 'row_count_changed').deltaFraction > 0.20, 'row count delta > 20%');
}

console.log('\n-- diffSnapshots -- null rate spike --');
{
  const colA = { name: 'race', type: 'VARCHAR', nullRate: 0.02, distinctCount: 5, minVal: null, maxVal: null, meanVal: null };
  const colB = { name: 'race', type: 'VARCHAR', nullRate: 0.25, distinctCount: 5, minVal: null, maxVal: null, meanVal: null };
  const snapA = { label: 'Jan', capturedAt: '2026-01-01T00:00:00Z', rowCount: 1000, columnCount: 1, columnStats: [colA] };
  const snapB = { label: 'Feb', capturedAt: '2026-02-01T00:00:00Z', rowCount: 1000, columnCount: 1, columnStats: [colB] };
  const diff = diffSnapshots(snapA, snapB);
  ok(diff.status === 'fail', 'null rate spike 23pp: status fail');
  ok(diff.findings.some(f => f.kind === 'null_rate_shifted' && f.column === 'race'), 'null rate finding for race');
  ok(diff.statsDiff.findings.length > 0, 'statsDiff has findings');
}

console.log('\n-- diffSnapshots -- schema changes --');
{
  const colA = { name: 'los', type: 'INTEGER', nullRate: 0.05, distinctCount: 50, minVal: 1, maxVal: 30, meanVal: 5.2 };
  const colB1 = { name: 'los', type: 'DOUBLE', nullRate: 0.05, distinctCount: 50, minVal: 1, maxVal: 30, meanVal: 5.2 };
  const colB2 = { name: 'readmit_30d', type: 'INTEGER', nullRate: 0.0, distinctCount: 2, minVal: 0, maxVal: 1, meanVal: 0.1 };
  const snapA = { label: 'Jan', capturedAt: '2026-01-01T00:00:00Z', rowCount: 1000, columnCount: 1, columnStats: [colA] };
  const snapB = { label: 'Feb', capturedAt: '2026-02-01T00:00:00Z', rowCount: 1000, columnCount: 2, columnStats: [colB1, colB2] };
  const diff = diffSnapshots(snapA, snapB);
  ok(diff.schemaDiff.typeChanged.includes('los'), 'type change detected for los');
  ok(diff.schemaDiff.added.includes('readmit_30d'), 'column addition detected');
  ok(diff.status !== 'pass', 'schema changes: status not pass');
}

console.log('\n-- diffSnapshots -- removed column (fail) --');
{
  const colA = { name: 'race', type: 'VARCHAR', nullRate: 0.0, distinctCount: 5, minVal: null, maxVal: null, meanVal: null };
  const snapA = { label: 'Jan', capturedAt: '2026-01-01T00:00:00Z', rowCount: 1000, columnCount: 1, columnStats: [colA] };
  const snapB = { label: 'Feb', capturedAt: '2026-02-01T00:00:00Z', rowCount: 1000, columnCount: 0, columnStats: [] };
  const diff = diffSnapshots(snapA, snapB);
  ok(diff.schemaDiff.removed.includes('race'), 'removed column detected');
  ok(diff.status === 'fail', 'removed column: status fail');
}

console.log('\n-- diffSnapshots -- null input --');
{
  const diff = diffSnapshots(null, null);
  ok(diff.status === 'idle', 'null snapshots: status idle');
}

// ============================================================
// 4. scoreDisparities with rulepack thresholds
// ============================================================
console.log('\n-- scoreDisparities -- rulepack thresholds (general pack) --');
{
  // General pack has rateRatioFail=2.0 (vs healthcare 1.5).
  // A 1.7x ratio should WARN under healthcare but WARN/FAIL under general differently.
  // Under healthcare thresholds: 1.7 >= 1.5 -> fail
  // Under general thresholds: 1.7 >= 1.25 (warn) but < 2.0 (fail) -> warn
  const groups = [
    { group: 'A', n: 200, rate: 0.10 },
    { group: 'B', n: 200, rate: 0.17 },
  ];
  // Default (healthcare constants from Phase 3).
  const rDefault = scoreDisparities({ groups, metricType: 'binary' });
  // With general rulepack thresholds.
  const generalPack = getRulepack('general');
  const rGeneral = scoreDisparities({ groups, metricType: 'binary', thresholds: generalPack.equity });
  // Under healthcare defaults B is above population mean 0.135, ratio = 0.17/0.135 = 1.26 -> warn (not fail)
  // Under general: same ratio, but warn threshold is 1.50 -> B is only 1.26 -> might pass
  ok(rDefault.status !== undefined, 'default thresholds: status defined');
  ok(rGeneral.status !== undefined, 'general thresholds: status defined');
  // The key test: thresholds param is accepted without error.
  ok(typeof rGeneral.rationale === 'string', 'general thresholds: rationale produced');
}
{
  // Force a finding that differs by threshold set.
  // Healthcare rateRatioFail=1.5: a 1.6x group should fail.
  // General rateRatioFail=2.0: a 1.6x group should only warn.
  // Use population-mean reference with controlled groups.
  // Groups: A=0.10 (n=200), B=0.16 (n=200). Mean = 0.13.
  // B ratio = 0.16/0.13 = 1.23 < 1.25 (warn) -> might pass even healthcare.
  // Use A=0.05 (n=200), B=0.10 (n=200). Mean = 0.075.
  // B ratio = 0.10/0.075 = 1.33 -> healthcare: 1.33 >= 1.25 warn; absDiff = 0.025 < 3pp -> warn
  //                               -> general: 1.33 < 1.50 warn; absDiff = 0.025 < 5pp -> pass!
  const groups2 = [
    { group: 'A', n: 200, rate: 0.05 },
    { group: 'B', n: 200, rate: 0.10 },
  ];
  const hcPack = getRulepack('healthcare');
  const genPack = getRulepack('general');
  const rHC = scoreDisparities({ groups: groups2, metricType: 'binary', thresholds: hcPack.equity });
  const rGen = scoreDisparities({ groups: groups2, metricType: 'binary', thresholds: genPack.equity });
  // Healthcare: warn or fail (1.33x ratio >= 1.25 warn threshold)
  ok(rHC.status === 'warn' || rHC.status === 'fail', 'healthcare thresholds: 1.33x ratio flagged');
  // General: pass (1.33x < 1.50 warn threshold and absDiff 0.025 < 5pp)
  ok(rGen.status === 'pass', 'general thresholds: same 1.33x ratio passes (looser thresholds)');
}

// ============================================================
// Teardown
// ============================================================
if (typeof closeConnection === 'function') await closeConnection();

console.log('\n==========================================');
console.log(passed + ' passed, ' + failed + ' failed');
console.log('==========================================');
if (failed > 0) process.exit(1);
