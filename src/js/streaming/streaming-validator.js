/* DataGlow — js/streaming/streaming-validator.js */
/* Part of structured refactor — see src/ directory */

var StreamingValidator = (function () {
    function computeSchemaFingerprint(columns) {
      return columns.map(function (c) { return c.name + ':' + c.type; }).sort().join('|');
    }
    function detectSchemaDrift(baseline, current) {
      return { drifted: baseline !== current, baseline: baseline, current: current };
    }
    function computeBatchStats(rows, columnName) {
      var count = rows.length;
      var nullCount = 0;
      var numericValues = [];

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var value = row ? row[columnName] : undefined;
        if (value === null || value === undefined || value === '') { nullCount++; continue; }
        var num = typeof value === 'number' ? value : Number(value);
        if (typeof value === 'number' ? !isNaN(value) : (value !== '' && !isNaN(num))) {
          numericValues.push(num);
        }
      }

      var nullRatio = count > 0 ? nullCount / count : 0;
      var nonNullCount = count - nullCount;
      var isNumeric = nonNullCount > 0 && numericValues.length === nonNullCount;

      if (!isNumeric) {
        return { count: count, nullCount: nullCount, nullRatio: nullRatio, min: null, max: null, mean: null, stddev: null };
      }

      var min = Infinity, max = -Infinity, sum = 0;
      for (var j = 0; j < numericValues.length; j++) {
        var v = numericValues[j];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      var mean = sum / numericValues.length;
      var sumSquaredDiff = 0;
      for (var k = 0; k < numericValues.length; k++) {
        var diff = numericValues[k] - mean;
        sumSquaredDiff += diff * diff;
      }
      var stddev = Math.sqrt(sumSquaredDiff / numericValues.length);

      return { count: count, nullCount: nullCount, nullRatio: nullRatio, min: min, max: max, mean: mean, stddev: stddev };
    }
    function detectValueDrift(baselineStats, currentStats, options) {
      options = options || {};
      var zScoreThreshold = options.zScoreThreshold != null ? options.zScoreThreshold : 2.5;

      var baselineMean = baselineStats ? baselineStats.mean : null;
      var currentMean = currentStats ? currentStats.mean : null;
      var baselineStddev = baselineStats ? baselineStats.stddev : null;
      var baselineNullRatio = baselineStats ? baselineStats.nullRatio : 0;
      var currentNullRatio = currentStats ? currentStats.nullRatio : 0;

      var meanShift = false;
      if (baselineMean !== null && currentMean !== null && baselineStddev !== null && baselineStddev > 0) {
        meanShift = Math.abs(currentMean - baselineMean) > zScoreThreshold * baselineStddev;
      }
      var nullSpike = currentNullRatio > baselineNullRatio + 0.1;

      return {
        drifted: meanShift || nullSpike,
        meanShift: meanShift,
        nullSpike: nullSpike,
        details: { baselineMean: baselineMean, currentMean: currentMean, baselineNullRatio: baselineNullRatio, currentNullRatio: currentNullRatio }
      };
    }
    function detectArrivalAnomaly(expectedRowsPerBatch, actualRows, tolerance) {
      tolerance = tolerance == null ? 0.3 : tolerance;
      var ratio = expectedRowsPerBatch > 0 ? actualRows / expectedRowsPerBatch : (actualRows === 0 ? 1 : Infinity);
      var lowerBound = expectedRowsPerBatch * (1 - tolerance);
      var upperBound = expectedRowsPerBatch * (1 + tolerance);
      var anomaly = actualRows < lowerBound || actualRows > upperBound;
      return { anomaly: anomaly, expected: expectedRowsPerBatch, actual: actualRows, ratio: ratio };
    }
    function makeBatchId() {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
      return 'batch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }
    function runStreamingValidation(batch, baseline, options) {
      options = options || {};
      var zScoreThreshold = options.zScoreThreshold != null ? options.zScoreThreshold : 2.5;
      var arrivalTolerance = options.arrivalTolerance != null ? options.arrivalTolerance : 0.3;
      var columnsToWatch = options.columnsToWatch || [];

      var currentFingerprint = computeSchemaFingerprint(batch.columns);

      var schemaDrift = baseline ? detectSchemaDrift(baseline.schemaFingerprint, currentFingerprint) : null;
      var arrivalAnomaly = baseline ? detectArrivalAnomaly(baseline.expectedRowsPerBatch, batch.rows.length, arrivalTolerance) : null;

      var valueDrift = {};
      var newColumnStats = {};

      columnsToWatch.forEach(function (colName) {
        var currentStats = computeBatchStats(batch.rows, colName);
        newColumnStats[colName] = currentStats;
        if (baseline && baseline.columnStats && baseline.columnStats[colName]) {
          valueDrift[colName] = detectValueDrift(baseline.columnStats[colName], currentStats, { zScoreThreshold: zScoreThreshold });
        }
      });

      var newBaseline = { schemaFingerprint: currentFingerprint, columnStats: newColumnStats, expectedRowsPerBatch: batch.rows.length };

      var schemaFailed = !!(schemaDrift && schemaDrift.drifted);
      var arrivalFailed = !!(arrivalAnomaly && arrivalAnomaly.anomaly);
      var valueDriftValues = Object.keys(valueDrift).map(function (k) { return valueDrift[k]; });
      var meanShiftFailed = valueDriftValues.some(function (v) { return v.meanShift; });
      var nullSpikeOnly = valueDriftValues.some(function (v) { return v.nullSpike; }) && !meanShiftFailed;

      var overallStatus = 'pass';
      if (schemaFailed || arrivalFailed || meanShiftFailed) overallStatus = 'fail';
      else if (nullSpikeOnly) overallStatus = 'warn';

      return {
        batchId: makeBatchId(),
        arrivedAt: batch.arrivedAt,
        schemaDrift: schemaDrift,
        valueDrift: valueDrift,
        arrivalAnomaly: arrivalAnomaly,
        overallStatus: overallStatus,
        newBaseline: newBaseline
      };
    }

    return {
      computeSchemaFingerprint: computeSchemaFingerprint,
      detectSchemaDrift: detectSchemaDrift,
      computeBatchStats: computeBatchStats,
      detectValueDrift: detectValueDrift,
      detectArrivalAnomaly: detectArrivalAnomaly,
      runStreamingValidation: runStreamingValidation
    };
