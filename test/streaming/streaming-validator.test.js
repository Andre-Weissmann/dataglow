// ============================================================
// DATAGLOW — Streaming Validation Mode test suite
// ============================================================
// Covers the four-pillar micro-batch drift detector in
// js/streaming/streaming-validator.js. This module is pure logic (no
// browser APIs, no DuckDB, no OPFS), so this suite runs directly under
// plain Node with zero setup.
//
// RUN WITH:  node test/streaming/streaming-validator.test.js
//
// Pillars covered:
//   1. Schema drift        — computeSchemaFingerprint / detectSchemaDrift
//   2. Value/distribution   — computeBatchStats / detectValueDrift
//      drift
//   3. Arrival-rate anomaly — detectArrivalAnomaly
//   4. Full integration     — runStreamingValidation end-to-end
// ============================================================

import {
  computeSchemaFingerprint,
  detectSchemaDrift,
  computeBatchStats,
  detectValueDrift,
  detectArrivalAnomaly,
  runStreamingValidation,
  serializeBaseline,
  deserializeBaseline,
} from '../../js/streaming/streaming-validator.js';

// ---------- tiny test harness (mirrors the rest of the repo's *.test.mjs files) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

function main() {
  // ===== computeSchemaFingerprint =====
  const colsA = [
    { name: 'id', type: 'BIGINT' },
    { name: 'amount', type: 'DOUBLE' },
    { name: 'name', type: 'VARCHAR' },
  ];
  const colsAReordered = [
    { name: 'name', type: 'VARCHAR' },
    { name: 'id', type: 'BIGINT' },
    { name: 'amount', type: 'DOUBLE' },
  ];
  const fpA = computeSchemaFingerprint(colsA);
  const fpAReordered = computeSchemaFingerprint(colsAReordered);
  ok(fpA === fpAReordered, 'computeSchemaFingerprint: same columns in a different order produce the same fingerprint');
  ok(fpA === 'amount:DOUBLE|id:BIGINT|name:VARCHAR', `computeSchemaFingerprint: fingerprint format is name:type joined/sorted (got "${fpA}")`);

  // ===== detectSchemaDrift =====
  const colsB = [...colsA, { name: 'region', type: 'VARCHAR' }]; // added column
  const fpB = computeSchemaFingerprint(colsB);
  const driftAdded = detectSchemaDrift(fpA, fpB);
  ok(driftAdded.drifted === true, 'detectSchemaDrift: adding a column flags drifted: true');
  ok(driftAdded.baseline === fpA && driftAdded.current === fpB, 'detectSchemaDrift: baseline/current echoed back correctly');

  const driftSame = detectSchemaDrift(fpA, fpAReordered);
  ok(driftSame.drifted === false, 'detectSchemaDrift: identical schema (reordered) is NOT drifted');

  // ===== computeBatchStats =====
  const rows5 = [
    { amount: 10 },
    { amount: 20 },
    { amount: 30 },
    { amount: null }, // null
    { amount: 40 },
  ];
  const stats5 = computeBatchStats(rows5, 'amount');
  ok(stats5.count === 5, `computeBatchStats: count is 5 (got ${stats5.count})`);
  ok(stats5.nullCount === 1, `computeBatchStats: nullCount is 1 (got ${stats5.nullCount})`);
  ok(approx(stats5.nullRatio, 0.2), `computeBatchStats: nullRatio is 0.2 (got ${stats5.nullRatio})`);
  // non-null values: 10, 20, 30, 40 -> mean = 25
  ok(approx(stats5.mean, 25), `computeBatchStats: mean of [10,20,30,40] is 25 (got ${stats5.mean})`);
  // population stddev of [10,20,30,40] around mean 25: diffs -15,-5,5,15 -> squares 225,25,25,225 -> avg 125 -> sqrt ~11.1803
  ok(approx(stats5.stddev, Math.sqrt(125), 1e-6), `computeBatchStats: stddev matches population formula (got ${stats5.stddev})`);
  ok(stats5.min === 10 && stats5.max === 40, `computeBatchStats: min/max are 10/40 (got ${stats5.min}/${stats5.max})`);

  // non-numeric column: still counts nulls, numeric fields come back null
  const rowsText = [
    { label: 'a' },
    { label: null },
    { label: 'b' },
  ];
  const statsText = computeBatchStats(rowsText, 'label');
  ok(statsText.count === 3 && statsText.nullCount === 1, 'computeBatchStats: non-numeric column still counts rows/nulls correctly');
  ok(statsText.min === null && statsText.max === null && statsText.mean === null && statsText.stddev === null,
    'computeBatchStats: non-numeric column returns null for min/max/mean/stddev');

  // ===== detectValueDrift =====
  const baselineStats = { count: 100, nullCount: 5, nullRatio: 0.05, min: 0, max: 100, mean: 50, stddev: 10 };

  const shiftedStats = { count: 100, nullCount: 5, nullRatio: 0.05, min: 0, max: 130, mean: 80, stddev: 10 }; // |80-50|=30 > 2.5*10=25
  const shiftedDrift = detectValueDrift(baselineStats, shiftedStats);
  ok(shiftedDrift.meanShift === true, 'detectValueDrift: mean shifted beyond zScoreThreshold is flagged (meanShift: true)');
  ok(shiftedDrift.drifted === true, 'detectValueDrift: overall drifted is true when meanShift fires');

  const withinStats = { count: 100, nullCount: 5, nullRatio: 0.05, min: 0, max: 105, mean: 55, stddev: 10 }; // |55-50|=5 < 25
  const withinDrift = detectValueDrift(baselineStats, withinStats);
  ok(withinDrift.meanShift === false, 'detectValueDrift: mean shift within threshold is NOT flagged');
  ok(withinDrift.drifted === false, 'detectValueDrift: overall drifted is false when nothing fires');

  const nullSpikeStats = { count: 100, nullCount: 20, nullRatio: 0.2, min: 0, max: 100, mean: 50, stddev: 10 }; // 0.2 > 0.05+0.1
  const nullSpikeDrift = detectValueDrift(baselineStats, nullSpikeStats);
  ok(nullSpikeDrift.nullSpike === true, 'detectValueDrift: nullRatio increase beyond +0.1 is flagged (nullSpike: true)');
  ok(nullSpikeDrift.meanShift === false, 'detectValueDrift: null spike case has no mean shift');
  ok(nullSpikeDrift.details.baselineMean === 50 && nullSpikeDrift.details.currentMean === 50,
    'detectValueDrift: details echoes baseline/current mean and nullRatio');

  // custom threshold
  const customThresholdDrift = detectValueDrift(baselineStats, withinStats, { zScoreThreshold: 0.1 }); // 5 > 0.1*10=1
  ok(customThresholdDrift.meanShift === true, 'detectValueDrift: a tighter zScoreThreshold option flags a shift that the default would miss');

  // ===== detectArrivalAnomaly =====
  const expected = 1000;
  const anomaly60 = detectArrivalAnomaly(expected, 600); // 60% of expected, default tolerance 0.3 -> lower bound 700
  ok(anomaly60.anomaly === true, `detectArrivalAnomaly: 60% of expected rows flags anomaly (ratio=${anomaly60.ratio})`);
  ok(approx(anomaly60.ratio, 0.6), 'detectArrivalAnomaly: ratio is actual/expected = 0.6');

  const anomaly95 = detectArrivalAnomaly(expected, 950); // 95% of expected, within default ±30%
  ok(anomaly95.anomaly === false, `detectArrivalAnomaly: 95% of expected rows does NOT flag anomaly (ratio=${anomaly95.ratio})`);

  const anomalyHigh = detectArrivalAnomaly(expected, 1400); // 140%, outside default ±30%
  ok(anomalyHigh.anomaly === true, 'detectArrivalAnomaly: a spike well above tolerance also flags anomaly');

  const anomalyCustomTolerance = detectArrivalAnomaly(expected, 600, 0.5); // 60%, tolerance 0.5 -> lower bound 500 -> not anomaly
  ok(anomalyCustomTolerance.anomaly === false, 'detectArrivalAnomaly: a wider custom tolerance can turn an anomaly into a pass');

  // ===== runStreamingValidation — full integration =====
  const columns = [
    { name: 'id', type: 'BIGINT' },
    { name: 'amount', type: 'DOUBLE' },
  ];
  const firstBatchRows = Array.from({ length: 100 }, (_, i) => ({ id: i, amount: 50 + (i % 10) })); // mean ~54.5, tight spread
  const firstBatch = { columns, rows: firstBatchRows, arrivedAt: '2026-07-19T09:00:00Z' };

  const firstResult = runStreamingValidation(firstBatch, null, { columnsToWatch: ['amount'] });
  ok(firstResult.schemaDrift === null, 'runStreamingValidation: first run (null baseline) has schemaDrift: null');
  ok(firstResult.arrivalAnomaly === null, 'runStreamingValidation: first run (null baseline) has arrivalAnomaly: null');
  ok(firstResult.overallStatus === 'pass', `runStreamingValidation: first run has no baseline to compare against, so overallStatus is 'pass' (got '${firstResult.overallStatus}')`);
  ok(typeof firstResult.batchId === 'string' && firstResult.batchId.length > 0, 'runStreamingValidation: batchId is a non-empty string');
  ok(firstResult.newBaseline.expectedRowsPerBatch === 100, 'runStreamingValidation: newBaseline.expectedRowsPerBatch reflects first batch row count');
  ok(!!firstResult.newBaseline.columnStats.amount, 'runStreamingValidation: newBaseline.columnStats captures stats for watched column');

  // Second run: same schema, but 'amount' column has drifted way up, plus a
  // large drop in row count (arrival anomaly) to prove overallStatus='fail'.
  const secondBatchRows = Array.from({ length: 40 }, (_, i) => ({ id: i, amount: 500 + i })); // mean ~519.5, big jump, and only 40 rows vs expected 100
  const secondBatch = { columns, rows: secondBatchRows, arrivedAt: '2026-07-19T10:00:00Z' };

  const secondResult = runStreamingValidation(secondBatch, firstResult.newBaseline, { columnsToWatch: ['amount'] });
  ok(secondResult.schemaDrift.drifted === false, 'runStreamingValidation: second run, unchanged schema -> schemaDrift.drifted is false');
  ok(secondResult.arrivalAnomaly.anomaly === true, 'runStreamingValidation: second run, 40 rows vs expected 100 -> arrivalAnomaly.anomaly is true');
  ok(secondResult.valueDrift.amount.meanShift === true, 'runStreamingValidation: second run, amount mean jumped far beyond threshold -> meanShift true');
  ok(secondResult.overallStatus === 'fail', `runStreamingValidation: drift present in value + arrival pillars -> overallStatus is 'fail' (got '${secondResult.overallStatus}')`);

  // Third scenario: only a null spike (no mean shift, no schema/arrival issue) -> 'warn'.
  const thirdBatchRows = Array.from({ length: 100 }, (_, i) => ({
    id: i,
    amount: i < 25 ? null : 50 + (i % 10), // 25% null vs baseline's ~0%
  }));
  const thirdBatch = { columns, rows: thirdBatchRows, arrivedAt: '2026-07-19T11:00:00Z' };
  const thirdResult = runStreamingValidation(thirdBatch, firstResult.newBaseline, { columnsToWatch: ['amount'] });
  ok(thirdResult.schemaDrift.drifted === false, 'runStreamingValidation: warn scenario has no schema drift');
  ok(thirdResult.arrivalAnomaly.anomaly === false, 'runStreamingValidation: warn scenario has no arrival anomaly (same row count)');
  ok(thirdResult.valueDrift.amount.nullSpike === true, 'runStreamingValidation: warn scenario has a null spike on amount');
  ok(thirdResult.valueDrift.amount.meanShift === false, 'runStreamingValidation: warn scenario has no mean shift on amount');
  ok(thirdResult.overallStatus === 'warn', `runStreamingValidation: null-spike-only drift -> overallStatus is 'warn' (got '${thirdResult.overallStatus}')`);

  // ===== serializeBaseline / deserializeBaseline =====
  const serialized = serializeBaseline(firstResult.newBaseline);
  const parsed = JSON.parse(serialized);
  ok(parsed._v === 1, 'serializeBaseline: stamps a _v: 1 version field');
  ok(parsed.expectedRowsPerBatch === firstResult.newBaseline.expectedRowsPerBatch, 'serializeBaseline: round-trips the original baseline fields');

  const deserialized = deserializeBaseline(serialized);
  ok(deserialized.schemaFingerprint === firstResult.newBaseline.schemaFingerprint, 'deserializeBaseline: parses back into an equivalent object (schemaFingerprint)');
  ok(JSON.stringify(deserialized.columnStats) === JSON.stringify(firstResult.newBaseline.columnStats), 'deserializeBaseline: parses back into an equivalent object (columnStats)');

  // A deserialized baseline should be directly usable as input to the next run.
  const fourthResult = runStreamingValidation(secondBatch, deserialized, { columnsToWatch: ['amount'] });
  ok(fourthResult.overallStatus === 'fail', 'runStreamingValidation: a round-tripped (serialize/deserialize) baseline works identically as a live baseline object');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
