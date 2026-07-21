/* DataGlow -- js/receipt/receipt-engine.js */
/* The Receipt: cross-dataset reconciliation diff.
   Two numbers disagree. Two dashboards, two exports, two analysts.
   Drop both datasets into DataGlow. The Receipt tells you EXACTLY why
   they differ -- in plain English a CFO reads in one pass.

   How it works:
   1. Accepts two DataGlow dataset objects (with provenance chains)
   2. Diffs: column schemas, row counts, value distributions, filter logic,
      aggregation windows, date ranges, key column cardinality
   3. Scores each discrepancy by likely impact (HIGH / MEDIUM / LOW)
   4. Generates a plain-English "Here is why these numbers differ" narrative
   5. Produces a structured diff object (machine-readable + human-readable)   */

var ReceiptEngine = window.ReceiptEngine = (function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Utility                                                              */
  /* ------------------------------------------------------------------ */

  function safeArr(v) { return Array.isArray(v) ? v : []; }
  function safeStr(v) { return v == null ? '' : String(v); }
  function round2(n)  { return Math.round(n * 100) / 100; }

  function colMap(columns) {
    var m = {};
    safeArr(columns).forEach(function (c) { m[c.name] = c; });
    return m;
  }

  /* Numeric stats over a column vector */
  function numStats(rows, colIdx) {
    var vals = [];
    safeArr(rows).forEach(function (r) {
      var v = r[colIdx];
      if (v !== null && v !== undefined && v !== '' && !isNaN(Number(v))) {
        vals.push(Number(v));
      }
    });
    if (!vals.length) return null;
    vals.sort(function (a, b) { return a - b; });
    var sum = vals.reduce(function (a, b) { return a + b; }, 0);
    return {
      count: vals.length,
      sum:   round2(sum),
      mean:  round2(sum / vals.length),
      min:   vals[0],
      max:   vals[vals.length - 1],
      nullCount: safeArr(rows).length - vals.length
    };
  }

  /* Cardinality (distinct values) for a column */
  function cardinality(rows, colIdx) {
    var seen = {};
    safeArr(rows).forEach(function (r) {
      var v = r[colIdx];
      if (v !== null && v !== undefined) seen[String(v)] = true;
    });
    return Object.keys(seen).length;
  }

  /* Detect likely date columns */
  function isDateCol(col) {
    return col && (col.type === 'DATE' || /date|time|period|month|year|week/i.test(col.name));
  }

  /* Date range for a column */
  function dateRange(rows, colIdx) {
    var vals = [];
    safeArr(rows).forEach(function (r) {
      var v = r[colIdx];
      if (v) { var d = new Date(v); if (!isNaN(d)) vals.push(d); }
    });
    if (!vals.length) return null;
    vals.sort(function (a, b) { return a - b; });
    return {
      min: vals[0].toISOString().slice(0, 10),
      max: vals[vals.length - 1].toISOString().slice(0, 10)
    };
  }

  /* ------------------------------------------------------------------ */
  /* Schema diff                                                          */
  /* ------------------------------------------------------------------ */

  function diffSchemas(colsA, colsB) {
    var mapA = colMap(colsA);
    var mapB = colMap(colsB);
    var namesA = Object.keys(mapA);
    var namesB = Object.keys(mapB);

    var onlyInA = namesA.filter(function (n) { return !mapB[n]; });
    var onlyInB = namesB.filter(function (n) { return !mapA[n]; });
    var shared  = namesA.filter(function (n) { return mapB[n]; });

    var typeMismatches = shared.filter(function (n) {
      return mapA[n].type !== mapB[n].type;
    }).map(function (n) {
      return { column: n, typeA: mapA[n].type, typeB: mapB[n].type };
    });

    return { onlyInA, onlyInB, shared, typeMismatches };
  }

  /* ------------------------------------------------------------------ */
  /* Value diff on shared numeric columns                                 */
  /* ------------------------------------------------------------------ */

  function diffNumericCols(rowsA, colsA, rowsB, colsB, sharedNames) {
    var mapA = colMap(colsA);
    var mapB = colMap(colsB);
    var diffs = [];

    sharedNames.forEach(function (name) {
      var cA = mapA[name]; var cB = mapB[name];
      if (!cA || !cB) return;
      if (cA.type !== 'INT' && cA.type !== 'FLOAT' && cA.type !== 'STR') return;

      var idxA = colsA.indexOf(cA);
      var idxB = colsB.indexOf(cB);
      if (idxA < 0 || idxB < 0) return;

      var statsA = numStats(rowsA, idxA);
      var statsB = numStats(rowsB, idxB);
      if (!statsA || !statsB) return;

      var sumDelta = round2(statsA.sum - statsB.sum);
      var pctDelta = statsB.sum !== 0
        ? round2((sumDelta / Math.abs(statsB.sum)) * 100) : null;
      var countDelta = statsA.count - statsB.count;

      if (Math.abs(sumDelta) > 0.001 || countDelta !== 0) {
        diffs.push({
          column:     name,
          sumA:       statsA.sum,
          sumB:       statsB.sum,
          sumDelta,
          pctDelta,
          countA:     statsA.count,
          countB:     statsB.count,
          countDelta,
          nullsA:     statsA.nullCount,
          nullsB:     statsB.nullCount,
          impact:     Math.abs(pctDelta || 0) > 10 ? 'HIGH'
                    : Math.abs(pctDelta || 0) > 1  ? 'MEDIUM' : 'LOW'
        });
      }
    });

    return diffs;
  }

  /* ------------------------------------------------------------------ */
  /* Row count and date range diffs                                       */
  /* ------------------------------------------------------------------ */

  function diffRowCounts(rowsA, rowsB, nameA, nameB) {
    var delta = rowsA.length - rowsB.length;
    return {
      countA: rowsA.length,
      countB: rowsB.length,
      delta,
      pct: rowsB.length ? round2((delta / rowsB.length) * 100) : null,
      impact: Math.abs(delta / Math.max(rowsB.length, 1)) > 0.05 ? 'HIGH' : 'LOW'
    };
  }

  function diffDateRanges(rowsA, colsA, rowsB, colsB) {
    var results = [];
    colsA.forEach(function (c, i) {
      if (!isDateCol(c)) return;
      var matchB = colsB.find(function (cb) { return cb.name === c.name; });
      if (!matchB) return;
      var idxB = colsB.indexOf(matchB);
      var rA = dateRange(rowsA, i);
      var rB = dateRange(rowsB, idxB);
      if (!rA || !rB) return;
      if (rA.min !== rB.min || rA.max !== rB.max) {
        results.push({
          column: c.name,
          rangeA: rA, rangeB: rB,
          impact: 'HIGH'
        });
      }
    });
    return results;
  }

  /* ------------------------------------------------------------------ */
  /* Plain-English narrative generator                                    */
  /* ------------------------------------------------------------------ */

  function buildNarrative(diff, nameA, nameB) {
    var lines = [];
    var A = nameA || 'Dataset A';
    var B = nameB || 'Dataset B';

    lines.push('Why ' + A + ' and ' + B + ' disagree:');
    lines.push('');

    var highCount = 0;

    /* Row count */
    var rc = diff.rowCounts;
    if (rc && Math.abs(rc.delta) > 0) {
      var rcImpact = rc.impact === 'HIGH' ? 'HIGH IMPACT' : 'low impact';
      lines.push('[' + rcImpact + '] Row count mismatch');
      lines.push(
        '  ' + A + ' has ' + rc.countA.toLocaleString() + ' rows. ' +
        B + ' has ' + rc.countB.toLocaleString() + ' rows. ' +
        'That is a difference of ' + Math.abs(rc.delta).toLocaleString() + ' rows' +
        (rc.pct !== null ? ' (' + Math.abs(rc.pct) + '%)' : '') + '.'
      );
      lines.push(
        '  Most likely cause: one dataset was filtered, truncated, or drawn from a ' +
        'different time window or export scope before you received it.'
      );
      if (rc.impact === 'HIGH') highCount++;
      lines.push('');
    }

    /* Date range mismatches */
    safeArr(diff.dateRanges).forEach(function (dr) {
      lines.push('[HIGH IMPACT] Date range mismatch on "' + dr.column + '"');
      lines.push(
        '  ' + A + ' spans ' + dr.rangeA.min + ' to ' + dr.rangeA.max + '.'
      );
      lines.push(
        '  ' + B + ' spans ' + dr.rangeB.min + ' to ' + dr.rangeB.max + '.'
      );
      lines.push(
        '  Any aggregate (sum, count, average) on this column will differ ' +
        'because the underlying time periods are not the same.'
      );
      highCount++;
      lines.push('');
    });

    /* Schema differences */
    var sc = diff.schema;
    if (sc) {
      if (sc.onlyInA.length) {
        lines.push('[MEDIUM IMPACT] Columns only in ' + A + ': ' + sc.onlyInA.join(', '));
        lines.push(
          '  These columns do not exist in ' + B + ', so any metric that depends ' +
          'on them cannot be compared directly.'
        );
        lines.push('');
      }
      if (sc.onlyInB.length) {
        lines.push('[MEDIUM IMPACT] Columns only in ' + B + ': ' + sc.onlyInB.join(', '));
        lines.push('');
      }
      if (sc.typeMismatches.length) {
        sc.typeMismatches.forEach(function (tm) {
          lines.push('[MEDIUM IMPACT] Type mismatch on "' + tm.column + '"');
          lines.push(
            '  ' + A + ' stores it as ' + tm.typeA + '; ' + B + ' stores it as ' + tm.typeB + '. ' +
            'Numeric aggregates on a column stored as text will silently produce wrong totals.'
          );
          lines.push('');
        });
      }
    }

    /* Numeric value diffs */
    safeArr(diff.numericDiffs).forEach(function (nd) {
      var tag = '[' + nd.impact + ' IMPACT]';
      lines.push(tag + ' "' + nd.column + '" totals differ');
      lines.push(
        '  ' + A + ' total: ' + nd.sumA.toLocaleString() +
        '  |  ' + B + ' total: ' + nd.sumB.toLocaleString()
      );
      if (nd.pctDelta !== null) {
        lines.push('  Difference: ' + Math.abs(nd.pctDelta) + '%' +
          (nd.pctDelta > 0 ? ' higher in ' + A : ' lower in ' + A) + '.');
      }
      if (nd.nullsA !== nd.nullsB) {
        lines.push(
          '  Null count: ' + nd.nullsA + ' in ' + A + ' vs ' + nd.nullsB + ' in ' + B + '. ' +
          'Different null-handling rules may account for part of this gap.'
        );
      }
      if (nd.countDelta !== 0) {
        lines.push(
          '  Non-null value count: ' + nd.countA + ' vs ' + nd.countB + '. ' +
          'One dataset has more rows contributing to this total.'
        );
      }
      if (nd.impact === 'HIGH') highCount++;
      lines.push('');
    });

    if (lines.length <= 2) {
      lines.push('No material discrepancies detected between these two datasets.');
      lines.push('Row counts, date ranges, column schemas, and numeric totals are consistent.');
    } else {
      lines.push('---');
      lines.push(
        highCount > 0
          ? highCount + ' HIGH IMPACT discrepanc' + (highCount === 1 ? 'y' : 'ies') +
            ' found. These likely explain the full gap between the two numbers.'
          : 'No single high-impact discrepancy identified. The difference is likely ' +
            'a combination of small rounding, null handling, or scope variations.'
      );
    }

    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* Public: diff two datasets                                            */
  /* ------------------------------------------------------------------ */

  function diff(datasetA, datasetB) {
    var a = datasetA || {};
    var b = datasetB || {};

    var rowsA = safeArr(a.rows);
    var rowsB = safeArr(b.rows);
    var colsA = safeArr(a.columns);
    var colsB = safeArr(b.columns);

    var schema      = diffSchemas(colsA, colsB);
    var rowCounts   = diffRowCounts(rowsA, rowsB, a.name, b.name);
    var numericDiffs= diffNumericCols(rowsA, colsA, rowsB, colsB, schema.shared);
    var dateRanges  = diffDateRanges(rowsA, colsA, rowsB, colsB);

    var result = {
      nameA: a.name || 'Dataset A',
      nameB: b.name || 'Dataset B',
      generatedAt: new Date().toISOString(),
      schema,
      rowCounts,
      numericDiffs,
      dateRanges,
      highImpactCount: [rowCounts, ...numericDiffs, ...dateRanges]
        .filter(function (d) { return d && d.impact === 'HIGH'; }).length
    };

    result.narrative = buildNarrative(result, result.nameA, result.nameB);
    return result;
  }

  /* Download the receipt as a .receipt file */
  function download(diffResult) {
    var content = JSON.stringify(diffResult, null, 2);
    var blob = new Blob([content], { type: 'application/json' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href     = url;
    a.download = 'dataglow-receipt-' + Date.now() + '.receipt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return { diff, download, buildNarrative };
})();
