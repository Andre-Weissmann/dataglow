// ============================================================
// DATAGLOW — Phase 3 Equity Stratification Tests
// ============================================================
// Tests for:
//   js/equity/equity-detector.js    -- column classification
//   js/equity/disparity-scorer.js   -- statistical disparity scoring
//   js/equity/equity-stratifier.js  -- DuckDB GROUP BY + scoring
//   js/equity/equity-attestation.js -- signed attestation block
//
// Run: node --import ./test/duckdb-loader-hook.mjs test/equity-phase3.test.mjs

import { detectEquityColumns } from '../js/equity/equity-detector.js';
import {
  scoreDisparities,
  RATE_RATIO_WARN, RATE_RATIO_FAIL,
  ABS_DIFF_WARN, ABS_DIFF_FAIL,
  SMD_WARN, SMD_FAIL,
  MIN_CELL_SIZE,
} from '../js/equity/disparity-scorer.js';
import { stratifyEquity } from '../js/equity/equity-stratifier.js';
import { buildEquityAttestation, ATTESTATION_VERSION } from '../js/equity/equity-attestation.js';
import * as nodeEngine from './node-duckdb-engine.mjs';

const { createTableFromObjects, runQuery, closeConnection } = nodeEngine;

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) {
    passed++;
    console.log('  ok ' + label);
  } else {
    failed++;
    console.log('FAIL ' + label);
  }
}

// ============================================================
// 1. equity-detector.js
// ============================================================
console.log('\n-- detectEquityColumns -- basic stratifiers --');
{
  const cols = [
    { name: 'race_cd', type: 'VARCHAR' },
    { name: 'sex', type: 'VARCHAR' },
    { name: 'zip_code', type: 'VARCHAR' },
    { name: 'payer_class', type: 'VARCHAR' },
    { name: 'readmit_30d', type: 'INTEGER' },
    { name: 'denied', type: 'INTEGER' },
    { name: 'los', type: 'INTEGER' },
    { name: 'claim_amount', type: 'DOUBLE' },
    { name: 'patient_id', type: 'VARCHAR' },
  ];
  const r = detectEquityColumns(cols);
  ok(r.stratifiers.length === 4, 'detects 4 stratifiers');
  ok(r.stratifiers.some(s => s.role === 'race_ethnicity'), 'race_cd -> race_ethnicity');
  ok(r.stratifiers.some(s => s.role === 'sex_gender'), 'sex -> sex_gender');
  ok(r.stratifiers.some(s => s.role === 'geography'), 'zip_code -> geography');
  ok(r.stratifiers.some(s => s.role === 'payer'), 'payer_class -> payer');
  ok(r.metrics.length === 4, 'detects 4 metrics');
  ok(r.metrics.some(m => m.kind === 'readmission'), 'readmit_30d -> readmission');
  ok(r.metrics.some(m => m.kind === 'denial'), 'denied -> denial');
  ok(r.metrics.some(m => m.kind === 'los'), 'los -> los');
  ok(r.metrics.some(m => m.kind === 'cost'), 'claim_amount -> cost');
  ok(r.hasEquityData === true, 'hasEquityData = true');
  ok(!r.stratifiers.some(s => s.name === 'patient_id'), 'patient_id not a stratifier');
}

console.log('\n-- detectEquityColumns -- edge cases --');
{
  // No columns at all.
  const r1 = detectEquityColumns([]);
  ok(r1.hasEquityData === false, 'empty cols: hasEquityData false');
  ok(r1.stratifiers.length === 0, 'empty cols: 0 stratifiers');

  // Stratifier without metrics.
  const r2 = detectEquityColumns([{ name: 'race', type: 'VARCHAR' }, { name: 'name', type: 'VARCHAR' }]);
  ok(r2.hasEquityData === false, 'stratifier without metrics: hasEquityData false');
  ok(r2.stratifiers.length === 1, 'stratifier without metrics: 1 stratifier');
  ok(r2.metrics.length === 0, 'stratifier without metrics: 0 metrics');

  // age_group + readmit.
  const r3 = detectEquityColumns([{ name: 'age_group', type: 'VARCHAR' }, { name: 'readmit_90d', type: 'INTEGER' }]);
  ok(r3.stratifiers.some(s => s.role === 'age_group'), 'age_group detected');
  ok(r3.metrics.some(m => m.kind === 'readmission'), 'readmit_90d detected');

  // Mortality column.
  const r4 = detectEquityColumns([{ name: 'race', type: 'VARCHAR' }, { name: 'deceased', type: 'INTEGER' }]);
  ok(r4.metrics.some(m => m.kind === 'mortality'), 'deceased -> mortality');

  // claim_amount with non-numeric type should NOT become a cost metric.
  const r5 = detectEquityColumns([{ name: 'race', type: 'VARCHAR' }, { name: 'claim_amount', type: 'VARCHAR' }]);
  ok(!r5.metrics.some(m => m.kind === 'cost'), 'claim_amount VARCHAR: not a cost metric');

  // Disability / dual status.
  const r6 = detectEquityColumns([{ name: 'dual_eligible', type: 'VARCHAR' }, { name: 'los', type: 'INTEGER' }]);
  ok(r6.stratifiers.some(s => s.role === 'disability'), 'dual_eligible -> disability');
}

// ============================================================
// 2. disparity-scorer.js
// ============================================================
console.log('\n-- scoreDisparities -- binary (rate ratio) --');
{
  // Clean: all groups within range.
  const groups = [
    { group: 'White', n: 200, rate: 0.10 },
    { group: 'Black', n: 150, rate: 0.11 },
    { group: 'Hispanic', n: 100, rate: 0.09 },
  ];
  const r = scoreDisparities({ groups, metricType: 'binary', metricName: 'Readmission', stratifierName: 'Race' });
  ok(r.status === 'pass', 'clean groups: status pass');
  ok(r.flagged.length === 0, 'clean groups: no flagged');
  ok(r.level === 'none', 'clean groups: level none');
}
{
  // Disparity: one group at 2x reference.
  const groups = [
    { group: 'White', n: 300, rate: 0.10 },
    { group: 'Black', n: 200, rate: 0.20 },  // 2x -> fail
    { group: 'Asian', n: 100, rate: 0.09 },
  ];
  const r = scoreDisparities({ groups, metricType: 'binary', metricName: 'Readmission', stratifierName: 'Race' });
  ok(r.status === 'fail', 'disparity 2x: status fail');
  ok(r.flagged.some(f => f.group === 'Black'), 'Black flagged');
  ok(r.flagged.find(f => f.group === 'Black').level === 'high' || r.flagged.find(f => f.group === 'Black').level === 'medium', 'Black level medium or high');
  ok(r.rationale.length > 0, 'rationale non-empty');
}
{
  // Warn: one group clearly above warn threshold vs population mean.
  // Population mean of [0.08, 0.12] (equal n) = 0.10.
  // Group B ratio = 0.12/0.10 = 1.20 < WARN_RATE_RATIO, but absDiff = 0.02 < ABS_DIFF_WARN.
  // Need group that is 1.25x+ above the mean.
  // Mean of [0.08, 0.13] = (0.08*100 + 0.13*100)/200 = 0.105.
  // Group B ratio = 0.13/0.105 = 1.238 >= RATE_RATIO_WARN (1.25)? Borderline.
  // Use a cleaner case: A=0.06 (n=100), B=0.14 (n=100). Mean=0.10.
  // B: ratio = 0.14/0.10 = 1.40 >= WARN; absDiff = 0.04 >= ABS_DIFF_WARN.
  const groups = [
    { group: 'A', n: 100, rate: 0.06 },
    { group: 'B', n: 100, rate: 0.14 },
  ];
  const r = scoreDisparities({ groups, metricType: 'binary' });
  ok(r.status === 'warn' || r.status === 'fail', 'warn: status warn or fail when 1.4x above mean');
  ok(r.flagged.length > 0, 'warn: flagged group present');
}

console.log('\n-- scoreDisparities -- continuous --');
{
  // LOS: one group 40% higher than reference.
  const groups = [
    { group: 'Medicaid', n: 200, mean: 5.0 },
    { group: 'Commercial', n: 300, mean: 3.5 },
    { group: 'Medicare', n: 100, mean: 4.2 },
  ];
  const r = scoreDisparities({ groups, metricType: 'continuous', metricName: 'LOS' });
  ok(r.status === 'fail' || r.status === 'warn', 'LOS disparity detected (fail or warn)');
  ok(r.findings.length === 3, 'all 3 groups scored');
}
{
  // All near-equal: pass.
  const groups = [
    { group: 'A', n: 100, mean: 4.0 },
    { group: 'B', n: 100, mean: 4.1 },
  ];
  const r = scoreDisparities({ groups, metricType: 'continuous' });
  ok(r.status === 'pass', 'near-equal continuous: pass');
}

console.log('\n-- scoreDisparities -- edge cases --');
{
  // Small-cell suppression: all groups below MIN_CELL_SIZE.
  const groups = [
    { group: 'A', n: 3, rate: 0.50 },
    { group: 'B', n: 2, rate: 0.10 },
  ];
  const r = scoreDisparities({ groups, metricType: 'binary' });
  ok(r.status === 'idle', 'all small cells: idle');
  ok(r.suppressed.length === 2, 'both groups suppressed');
}
{
  // Only one eligible group: idle.
  const groups = [
    { group: 'A', n: 100, rate: 0.10 },
    { group: 'B', n: 3, rate: 0.90 },
  ];
  const r = scoreDisparities({ groups, metricType: 'binary' });
  ok(r.status === 'idle', 'one eligible group: idle');
}
{
  // Reference = 0 rate, any non-zero is extreme.
  const groups = [
    { group: 'A', n: 100, rate: 0.0 },
    { group: 'B', n: 100, rate: 0.10 },
  ];
  const r = scoreDisparities({ groups, metricType: 'binary' });
  ok(r.status === 'fail' || r.status === 'warn', 'zero reference with non-zero group: flagged');
}
{
  // All groups empty values (no rate/mean): idle.
  const groups = [
    { group: 'A', n: 100 },
    { group: 'B', n: 100 },
  ];
  const r = scoreDisparities({ groups, metricType: 'binary' });
  ok(r.status === 'idle', 'missing values: idle');
}

// ============================================================
// 3. equity-stratifier.js (DuckDB)
// ============================================================
console.log('\n-- stratifyEquity -- DuckDB --');
{
  // Build a small encounters table with equity columns.
  await createTableFromObjects('enc_eq', [
    { race: 'White',    payer: 'Commercial', readmit_30d: 0, los: 3 },
    { race: 'White',    payer: 'Commercial', readmit_30d: 0, los: 4 },
    { race: 'White',    payer: 'Commercial', readmit_30d: 0, los: 3 },
    { race: 'White',    payer: 'Medicaid',   readmit_30d: 0, los: 3 },
    { race: 'White',    payer: 'Medicaid',   readmit_30d: 0, los: 3 },
    { race: 'Black',    payer: 'Medicaid',   readmit_30d: 1, los: 7 },
    { race: 'Black',    payer: 'Medicaid',   readmit_30d: 1, los: 8 },
    { race: 'Black',    payer: 'Medicaid',   readmit_30d: 1, los: 6 },
    { race: 'Black',    payer: 'Medicaid',   readmit_30d: 1, los: 7 },
    { race: 'Black',    payer: 'Medicaid',   readmit_30d: 1, los: 7 },
    { race: 'Hispanic', payer: 'Medicaid',   readmit_30d: 0, los: 4 },
    { race: 'Hispanic', payer: 'Medicare',   readmit_30d: 0, los: 5 },
    { race: 'Hispanic', payer: 'Medicare',   readmit_30d: 0, los: 4 },
    { race: 'Hispanic', payer: 'Medicare',   readmit_30d: 0, los: 5 },
    { race: 'Hispanic', payer: 'Medicare',   readmit_30d: 0, los: 5 },
    { race: 'Asian',    payer: 'Commercial', readmit_30d: 0, los: 3 },
    { race: 'Asian',    payer: 'Commercial', readmit_30d: 0, los: 3 },
    { race: 'Asian',    payer: 'Commercial', readmit_30d: 0, los: 4 },
    { race: 'Asian',    payer: 'Commercial', readmit_30d: 0, los: 3 },
    { race: 'Asian',    payer: 'Commercial', readmit_30d: 0, los: 3 },
  ]);

  const stratifiers = [
    { name: 'race', type: 'VARCHAR', role: 'race_ethnicity', roleLabel: 'Race / Ethnicity' },
    { name: 'payer', type: 'VARCHAR', role: 'payer', roleLabel: 'Payer / Coverage' },
  ];
  const metrics = [
    { name: 'readmit_30d', type: 'INTEGER', kind: 'readmission', kindLabel: 'Readmission', numeric: true },
    { name: 'los', type: 'INTEGER', kind: 'los', kindLabel: 'Length of Stay', numeric: true },
  ];
  const engine = { runQuery: nodeEngine.runQuery };

  const r = await stratifyEquity({ table: 'enc_eq', stratifiers, metrics, engine });

  ok(r.analyses.length === 4, 'stratifyEquity: 4 analyses (2 stratifiers x 2 metrics)');
  ok(r.status === 'fail' || r.status === 'warn', 'stratifyEquity: disparity detected (fail or warn)');

  // Black group should have 100% readmit rate vs ~0% others -- extreme disparity.
  const raceReadmit = r.analyses.find(a => a.stratifier.role === 'race_ethnicity' && a.metric.kind === 'readmission');
  ok(raceReadmit, 'race x readmit analysis present');
  ok(raceReadmit.status === 'fail', 'race x readmit: fail (Black at 100% vs 0%)');
  ok(raceReadmit.groups.some(g => g.group === 'Black' && g.rate === 1.0), 'Black group rate = 1.0');

  // LOS: Black ~7 days vs others ~3-5 -- should flag.
  const raceLos = r.analyses.find(a => a.stratifier.role === 'race_ethnicity' && a.metric.kind === 'los');
  ok(raceLos, 'race x LOS analysis present');
  ok(raceLos.status === 'fail' || raceLos.status === 'warn', 'race x LOS: disparity detected');

  ok(r.summary.total === 4, 'summary.total = 4');
  ok(r.summary.flaggedPairs > 0, 'summary.flaggedPairs > 0');
  ok(r.rationale.length > 0, 'stratifyEquity: rationale non-empty');
}

console.log('\n-- stratifyEquity -- idle when no equity cols --');
{
  const r = await stratifyEquity({
    table: 'enc_eq',
    stratifiers: [],
    metrics: [],
    engine: { runQuery: nodeEngine.runQuery },
  });
  ok(r.status === 'idle', 'no stratifiers/metrics: idle');
  ok(r.analyses.length === 0, 'no analyses');
}

console.log('\n-- stratifyEquity -- too many distinct groups --');
{
  // zip with 60 distinct values should produce idle (max 50).
  const rows = Array.from({ length: 60 }, (_, i) => ({
    zip: String(60000 + i), los: 4 + (i % 3), readmit_30d: i % 5 === 0 ? 1 : 0,
  }));
  await createTableFromObjects('enc_zip', rows);
  const r = await stratifyEquity({
    table: 'enc_zip',
    stratifiers: [{ name: 'zip', type: 'VARCHAR', role: 'geography', roleLabel: 'Geography' }],
    metrics: [{ name: 'readmit_30d', type: 'INTEGER', kind: 'readmission', kindLabel: 'Readmission', numeric: true }],
    engine: { runQuery: nodeEngine.runQuery },
  });
  ok(r.analyses.length === 1, 'zip analysis attempted');
  ok(r.analyses[0].status === 'idle', 'too many groups: idle');
  ok(r.analyses[0].rationale.includes('50'), 'rationale mentions max groups');
}

// ============================================================
// 4. equity-attestation.js
// ============================================================
console.log('\n-- buildEquityAttestation -- structure + signature --');
{
  const detectionResult = {
    stratifiers: [{ name: 'race', role: 'race_ethnicity', roleLabel: 'Race / Ethnicity' }],
    metrics: [{ name: 'readmit_30d', kind: 'readmission', kindLabel: 'Readmission' }],
    hasEquityData: true,
    summary: 'Equity analysis possible.',
  };
  const stratificationResult = {
    analyses: [],
    summary: { total: 1, pass: 0, warn: 0, fail: 1, idle: 0, flaggedPairs: 1 },
    status: 'fail',
    level: 'high',
    rationale: '1/1 stratification(s) show significant disparities.',
  };
  const att = await buildEquityAttestation({
    tableName: 'enc_eq',
    runId: 'test-run-001',
    detectionResult,
    stratificationResult,
  });

  ok(att.version === ATTESTATION_VERSION, 'attestation version correct');
  ok(att.runId === 'test-run-001', 'runId preserved');
  ok(att.tableName === 'enc_eq', 'tableName preserved');
  ok(att.status === 'fail', 'attestation status = fail');
  ok(att.level === 'high', 'attestation level = high');
  ok(typeof att.signature === 'string' && att.signature.length > 0, 'signature non-empty');
  ok(att.signatureAlgorithm === 'SHA-256', 'signature algorithm SHA-256');
  ok(att.equityAnalysisPerformed === true, 'equityAnalysisPerformed = true');
  ok(typeof att.verdict === 'string' && att.verdict.length > 0, 'verdict non-empty');
  ok(typeof att.methodology === 'string' && att.methodology.length > 0, 'methodology non-empty');
  ok(att.stratifiersDetected.length === 1, 'stratifiersDetected length 1');
  ok(att.metricsDetected.length === 1, 'metricsDetected length 1');
  ok(att.flaggedPairs === 1, 'flaggedPairs = 1');
  ok(att.analysisCount === 1, 'analysisCount = 1');
  ok(typeof att.analysedAt === 'string', 'analysedAt is a string');
}
{
  // Idle case: no equity data.
  const att = await buildEquityAttestation({
    tableName: 'no_equity',
    runId: null,
    detectionResult: { stratifiers: [], metrics: [], hasEquityData: false, summary: 'None.' },
    stratificationResult: { analyses: [], summary: {}, status: 'idle', level: 'none', rationale: 'No equity columns.' },
  });
  ok(att.status === 'idle', 'idle attestation: status idle');
  ok(att.equityAnalysisPerformed === false, 'idle attestation: not performed');
  ok(att.verdict.includes('not'), 'idle attestation: verdict mentions not performed');
  ok(typeof att.signature === 'string', 'idle attestation: still has signature');
}
{
  // Pass case: all within range.
  const att = await buildEquityAttestation({
    tableName: 'clean_table',
    runId: 'test-run-002',
    detectionResult: { stratifiers: [{ name: 'race', role: 'race_ethnicity', roleLabel: 'Race' }], metrics: [{ name: 'readmit_30d', kind: 'readmission', kindLabel: 'Readmission' }], hasEquityData: true },
    stratificationResult: { analyses: [], summary: { total: 1, pass: 1, warn: 0, fail: 0, idle: 0, flaggedPairs: 0 }, status: 'pass', level: 'none', rationale: 'No disparities.' },
  });
  ok(att.status === 'pass', 'pass attestation: status pass');
  ok(att.verdict.includes('No significant'), 'pass attestation: verdict positive');
}
{
  // Signature determinism: same input -> same signature.
  const inputs = {
    tableName: 'table_x', runId: 'run-abc',
    detectionResult: { stratifiers: [], metrics: [], hasEquityData: false, summary: '' },
    stratificationResult: { analyses: [], summary: {}, status: 'idle', level: 'none', rationale: '' },
    analysedAt: '2026-07-18T00:00:00.000Z',
  };
  const att1 = await buildEquityAttestation(inputs);
  const att2 = await buildEquityAttestation(inputs);
  ok(att1.signature === att2.signature, 'signature is deterministic');
}

// ============================================================
// Teardown
// ============================================================
if (typeof closeConnection === 'function') await closeConnection();

console.log('\n==========================================');
console.log(passed + ' passed, ' + failed + ' failed');
console.log('==========================================');
if (failed > 0) process.exit(1);
