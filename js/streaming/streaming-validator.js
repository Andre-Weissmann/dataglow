// ============================================================
// DATAGLOW — Streaming Validation Mode (four-pillar micro-batch drift detection)
// ============================================================
// This module is PURE LOGIC. It performs no fetch, no localStorage, no
// IndexedDB, no OPFS access, and no DuckDB calls of its own. It has zero
// browser-API dependencies and is safe to unit-test directly under plain
// Node. The caller is responsible for:
//   1. Extracting rows/columns from a DuckDB-WASM query result and shaping
//      them into the `{ columns, rows, arrivedAt }` batch object this module
//      expects.
//   2. Persisting/retrieving the rolling baseline between runs (this module
//      never touches storage of any kind).
//
// THE OPFS PERSISTENCE PATTERN (how a caller should wire this up):
//   a. On startup / before validating a new micro-batch, the caller reads
//      whatever baseline JSON it previously wrote to OPFS (or elsewhere) and
//      turns it back into an object with `deserializeBaseline(json)`.
//   b. The caller calls `runStreamingValidation(batch, baseline, options)`.
//      On the very first run there is no prior baseline yet, so the caller
//      passes `null` — every pillar that requires history degrades
//      gracefully (schemaDrift / arrivalAnomaly come back as `null`, and
//      valueDrift columns are skipped) instead of throwing.
//   c. The returned `result.newBaseline` reflects the just-validated batch.
//      The caller runs `serializeBaseline(result.newBaseline)` and writes
//      the resulting string to OPFS (e.g. via a FileSystemWritableFileStream),
//      overwriting the previous baseline file so the NEXT micro-batch's run
//      compares against THIS one.
//
// This is intentionally the same shape as the rest of DataGlow's local-first
// validation layers (see js/validation/*.js, js/drift/*.js): a pure function
// core, with all I/O — network, storage, DOM — pushed out to the caller.
//
// FOUR PILLARS implemented here:
//   1. Schema drift        — computeSchemaFingerprint + detectSchemaDrift
//   2. Value/distribution   — computeBatchStats + detectValueDrift (mean shift)
//      drift
//   3. Arrival-rate anomaly — detectArrivalAnomaly (row-count cadence)
//   4. Null-spike tracking  — embedded inside detectValueDrift, surfaced as
//                              its own `nullSpike` flag on the value-drift result
// ============================================================

/**
 * Computes a stable, order-independent fingerprint string for a table schema.
 *
 * @param {Array<{name: string, type: string}>} columns
 * @returns {string} e.g. "amount:DOUBLE|id:BIGINT|name:VARCHAR"
 */
export function computeSchemaFingerprint(columns) {
  return columns
    .map(c => c.name + ':' + c.type)
    .sort()
    .join('|');
}

/**
 * Compares two schema fingerprints and reports whether the schema drifted.
 *
 * @param {string} baseline - fingerprint from a prior batch
 * @param {string} current - fingerprint from the current batch
 * @returns {{ drifted: boolean, baseline: string, current: string }}
 */
export function detectSchemaDrift(baseline, current) {
  return {
    drifted: baseline !== current,
    baseline,
    current,
  };
}

/**
 * Computes descriptive statistics for a single column of a micro-batch.
 * Non-numeric columns still get a valid count/nullCount/nullRatio; the
 * numeric fields (min/max/mean/stddev) come back as `null` rather than
 * throwing or returning NaN.
 *
 * @param {Array<Object>} rows
 * @param {string} columnName
 * @returns {{ count: number, nullCount: number, nullRatio: number, min: number|null, max: number|null, mean: number|null, stddev: number|null }}
 */
export function computeBatchStats(rows, columnName) {
  const count = rows.length;
  let nullCount = 0;
  const numericValues = [];

  for (const row of rows) {
    const value = row ? row[columnName] : undefined;
    if (value === null || value === undefined || value === '') {
      nullCount++;
      continue;
    }
    const num = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'number' ? !Number.isNaN(value) : (value !== '' && !Number.isNaN(num))) {
      numericValues.push(num);
    }
  }

  const nullRatio = count > 0 ? nullCount / count : 0;

  // Only treat the column as numeric if every non-null value parsed cleanly.
  const nonNullCount = count - nullCount;
  const isNumeric = nonNullCount > 0 && numericValues.length === nonNullCount;

  if (!isNumeric) {
    return {
      count,
      nullCount,
      nullRatio,
      min: null,
      max: null,
      mean: null,
      stddev: null,
    };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of numericValues) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / numericValues.length;

  let sumSquaredDiff = 0;
  for (const v of numericValues) {
    const diff = v - mean;
    sumSquaredDiff += diff * diff;
  }
  const stddev = Math.sqrt(sumSquaredDiff / numericValues.length);

  return {
    count,
    nullCount,
    nullRatio,
    min,
    max,
    mean,
    stddev,
  };
}

/**
 * Compares baseline vs. current column stats for value/distribution drift:
 * a Z-score mean shift and/or a null-ratio spike.
 *
 * @param {Object} baselineStats - result of computeBatchStats on the baseline
 * @param {Object} currentStats - result of computeBatchStats on the current batch
 * @param {{ zScoreThreshold?: number }} [options]
 * @returns {{ drifted: boolean, meanShift: boolean, nullSpike: boolean, details: Object }}
 */
export function detectValueDrift(baselineStats, currentStats, options = {}) {
  const zScoreThreshold = options.zScoreThreshold ?? 2.5;

  const baselineMean = baselineStats ? baselineStats.mean : null;
  const currentMean = currentStats ? currentStats.mean : null;
  const baselineStddev = baselineStats ? baselineStats.stddev : null;
  const baselineNullRatio = baselineStats ? baselineStats.nullRatio : 0;
  const currentNullRatio = currentStats ? currentStats.nullRatio : 0;

  let meanShift = false;
  if (
    baselineMean !== null &&
    currentMean !== null &&
    baselineStddev !== null &&
    baselineStddev > 0
  ) {
    meanShift = Math.abs(currentMean - baselineMean) > zScoreThreshold * baselineStddev;
  }

  const nullSpike = currentNullRatio > baselineNullRatio + 0.1;

  return {
    drifted: meanShift || nullSpike,
    meanShift,
    nullSpike,
    details: {
      baselineMean,
      currentMean,
      baselineNullRatio,
      currentNullRatio,
    },
  };
}

/**
 * Flags a micro-batch whose row count falls outside the expected cadence.
 *
 * @param {number} expectedRowsPerBatch
 * @param {number} actualRows
 * @param {number} [tolerance=0.3] - fractional tolerance band, e.g. 0.3 = ±30%
 * @returns {{ anomaly: boolean, expected: number, actual: number, ratio: number }}
 */
export function detectArrivalAnomaly(expectedRowsPerBatch, actualRows, tolerance = 0.3) {
  const ratio = expectedRowsPerBatch > 0 ? actualRows / expectedRowsPerBatch : (actualRows === 0 ? 1 : Infinity);
  const lowerBound = expectedRowsPerBatch * (1 - tolerance);
  const upperBound = expectedRowsPerBatch * (1 + tolerance);
  const anomaly = actualRows < lowerBound || actualRows > upperBound;

  return {
    anomaly,
    expected: expectedRowsPerBatch,
    actual: actualRows,
    ratio,
  };
}

function makeBatchId() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Timestamp-based fallback with a random suffix for uniqueness when
  // crypto.randomUUID isn't available (e.g. older runtimes).
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Runs all four drift-detection pillars against a single incoming
 * micro-batch, comparing it to the supplied baseline (or skipping
 * history-dependent checks if `baseline` is null, i.e. first run).
 *
 * @param {{ columns: Array<{name: string, type: string}>, rows: Array<Object>, arrivedAt: string }} batch
 * @param {{ schemaFingerprint: string, columnStats: Object, expectedRowsPerBatch: number } | null} baseline
 * @param {{ zScoreThreshold?: number, arrivalTolerance?: number, columnsToWatch?: string[] }} [options]
 * @returns {Object} validation result, including the newBaseline to persist
 */
export function runStreamingValidation(batch, baseline, options = {}) {
  const zScoreThreshold = options.zScoreThreshold ?? 2.5;
  const arrivalTolerance = options.arrivalTolerance ?? 0.3;
  const columnsToWatch = options.columnsToWatch ?? [];

  const currentFingerprint = computeSchemaFingerprint(batch.columns);

  const schemaDrift = baseline
    ? detectSchemaDrift(baseline.schemaFingerprint, currentFingerprint)
    : null;

  const arrivalAnomaly = baseline
    ? detectArrivalAnomaly(baseline.expectedRowsPerBatch, batch.rows.length, arrivalTolerance)
    : null;

  const valueDrift = {};
  const newColumnStats = {};

  // Always compute fresh stats for every watched column so the new baseline
  // is complete, even on the first run (when there's nothing to compare to).
  for (const colName of columnsToWatch) {
    const currentStats = computeBatchStats(batch.rows, colName);
    newColumnStats[colName] = currentStats;

    if (baseline && baseline.columnStats && baseline.columnStats[colName]) {
      valueDrift[colName] = detectValueDrift(baseline.columnStats[colName], currentStats, { zScoreThreshold });
    }
  }

  const newBaseline = {
    schemaFingerprint: currentFingerprint,
    columnStats: newColumnStats,
    expectedRowsPerBatch: batch.rows.length,
  };

  // overallStatus: 'fail' if any pillar actually drifted (schema, mean
  // shift, or arrival anomaly); 'warn' if the only issue is a null spike;
  // otherwise 'pass'.
  const schemaFailed = !!(schemaDrift && schemaDrift.drifted);
  const arrivalFailed = !!(arrivalAnomaly && arrivalAnomaly.anomaly);
  const meanShiftFailed = Object.values(valueDrift).some(v => v.meanShift);
  const nullSpikeOnly = Object.values(valueDrift).some(v => v.nullSpike) && !meanShiftFailed;

  let overallStatus = 'pass';
  if (schemaFailed || arrivalFailed || meanShiftFailed) {
    overallStatus = 'fail';
  } else if (nullSpikeOnly) {
    overallStatus = 'warn';
  }

  return {
    batchId: makeBatchId(),
    arrivedAt: batch.arrivedAt,
    schemaDrift,
    valueDrift,
    arrivalAnomaly,
    overallStatus,
    newBaseline,
  };
}

/**
 * Serializes a baseline object to a JSON string, stamped with a version
 * field so future format changes can be detected by the caller before
 * writing it to OPFS.
 *
 * @param {Object} baseline
 * @returns {string}
 */
export function serializeBaseline(baseline) {
  return JSON.stringify({ _v: 1, ...baseline });
}

/**
 * Parses a baseline JSON string (as previously produced by
 * `serializeBaseline` and read back from OPFS) into a plain object.
 *
 * @param {string} json
 * @returns {Object}
 */
export function deserializeBaseline(json) {
  return JSON.parse(json);
}
