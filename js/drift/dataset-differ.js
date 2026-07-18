// ============================================================
// DATAGLOW — Dataset Differ (Phase 4)
// ============================================================
// Compares two dataset snapshots and surfaces what changed:
// schema changes (columns added/removed/type-changed) and
// statistical shifts (row count, null rates, value distributions).
//
// WHY THIS EXISTS:
// "This month's export" and "last month's export" look identical
// on the surface but may differ in ways that matter for analytics:
// a column added, a null rate that jumped from 2% to 15%, a row
// count that dropped 30%. These changes invalidate any cached
// analysis and may indicate upstream ETL issues.
//
// SNAPSHOTS:
// A snapshot is a lightweight summary of a dataset at a point in time.
// It contains schema info, row count, and per-column null rates /
// value distributions. Snapshots are cheap to store (a few KB for
// a 50-column dataset) and can be generated from any DuckDB table.
//
// USAGE:
//   // On first load:
//   const snap1 = await captureSnapshot({ table, cols, engine });
//   // On next load:
//   const snap2 = await captureSnapshot({ table, cols, engine });
//   // Diff them:
//   const diff = diffSnapshots(snap1, snap2);

// ---- Snapshot capture ------------------------------------------------------

/**
 * Capture a lightweight statistical snapshot of a DuckDB table.
 *
 * @param {object} opts
 * @param {string} opts.table - DuckDB table name
 * @param {Array<{name, type}>} opts.cols - column list
 * @param {object} opts.engine - { runQuery }
 * @param {string} [opts.label] - human-readable label (e.g. "July 2026 export")
 * @param {string} [opts.capturedAt] - ISO timestamp; defaults to now
 * @returns {Promise<object>} snapshot
 */
export async function captureSnapshot({ table, cols, engine, label = null, capturedAt = null }) {
  const ts = capturedAt || new Date().toISOString();
  const colArr = Array.isArray(cols) ? cols : [];

  // Row count.
  let rowCount = null;
  try {
    const r = await engine.runQuery('SELECT COUNT(*) AS n FROM ' + q(table));
    rowCount = safeNum(r.rows[0], 'n');
  } catch { /* ok */ }

  // Per-column stats.
  const columnStats = [];
  for (const col of colArr) {
    const name = col && col.name ? String(col.name) : '';
    const type = col && col.type ? String(col.type) : 'VARCHAR';
    if (!name) continue;

    let nullRate = null, distinctCount = null, minVal = null, maxVal = null, meanVal = null;
    try {
      const nullRes = await engine.runQuery(
        'SELECT COUNT(*) AS total, SUM(CASE WHEN ' + q(name) + ' IS NULL THEN 1 ELSE 0 END) AS nulls FROM ' + q(table)
      );
      const total = safeNum(nullRes.rows[0], 'total');
      const nulls = safeNum(nullRes.rows[0], 'nulls');
      nullRate = total > 0 ? nulls / total : null;
    } catch { /* ok */ }

    try {
      const distRes = await engine.runQuery(
        'SELECT COUNT(DISTINCT ' + q(name) + ') AS n FROM ' + q(table)
      );
      distinctCount = safeNum(distRes.rows[0], 'n');
    } catch { /* ok */ }

    // Numeric stats only for numeric types.
    if (isNumericType(type)) {
      try {
        const statRes = await engine.runQuery(
          'SELECT MIN(CAST(' + q(name) + ' AS DOUBLE)) AS mn, MAX(CAST(' + q(name) + ' AS DOUBLE)) AS mx, ' +
          'AVG(CAST(' + q(name) + ' AS DOUBLE)) AS avg FROM ' + q(table)
        );
        minVal = safeFloat(statRes.rows[0], 'mn');
        maxVal = safeFloat(statRes.rows[0], 'mx');
        meanVal = safeFloat(statRes.rows[0], 'avg');
      } catch { /* ok */ }
    }

    columnStats.push({ name, type, nullRate, distinctCount, minVal, maxVal, meanVal });
  }

  return {
    kind: 'dataglow_snapshot',
    version: '1.0',
    label,
    capturedAt: ts,
    table,
    rowCount,
    columnCount: colArr.length,
    columnStats,
  };
}

// ---- Snapshot diff ---------------------------------------------------------

/**
 * Diff two snapshots. Returns a structured diff with schema changes
 * and statistical shifts.
 *
 * @param {object} snapA - earlier snapshot
 * @param {object} snapB - later snapshot
 * @param {object} [opts]
 * @param {number} [opts.rowCountDeltaWarn=0.05]  - warn if row count changes by > 5%
 * @param {number} [opts.rowCountDeltaFail=0.20]  - fail if row count changes by > 20%
 * @param {number} [opts.nullRateDeltaWarn=0.05]  - warn if null rate shifts by > 5 pp
 * @param {number} [opts.nullRateDeltaFail=0.15]  - fail if null rate shifts by > 15 pp
 * @param {number} [opts.meanDeltaWarn=0.20]       - warn if mean shifts by > 20%
 * @param {number} [opts.meanDeltaFail=0.50]       - fail if mean shifts by > 50%
 * @returns {object} diff result
 */
export function diffSnapshots(snapA, snapB, {
  rowCountDeltaWarn = 0.05,
  rowCountDeltaFail = 0.20,
  nullRateDeltaWarn = 0.05,
  nullRateDeltaFail = 0.15,
  meanDeltaWarn     = 0.20,
  meanDeltaFail     = 0.50,
} = {}) {
  if (!snapA || !snapB) {
    return {
      layer: 'dataset_diff', status: 'idle', level: 'none',
      rationale: 'One or both snapshots are null -- diff cannot be computed.',
      schemaDiff: null, statsDiff: null,
    };
  }

  const findings = [];

  // ---- Row count diff ----
  const rowCountDiff = rowCountChange(snapA.rowCount, snapB.rowCount, rowCountDeltaWarn, rowCountDeltaFail);
  if (rowCountDiff) findings.push(rowCountDiff);

  // ---- Column count diff ----
  const colCountDiff = snapA.columnCount !== snapB.columnCount
    ? {
        kind: 'column_count_changed',
        status: snapA.columnCount !== snapB.columnCount ? 'warn' : 'pass',
        level: 'low',
        detail: 'Column count changed from ' + snapA.columnCount + ' to ' + snapB.columnCount + '.',
      }
    : null;
  if (colCountDiff) findings.push(colCountDiff);

  // ---- Schema diff: added / removed / type-changed columns ----
  const schemaDiff = buildSchemaDiff(snapA.columnStats || [], snapB.columnStats || []);
  for (const s of schemaDiff.findings) findings.push(s);

  // ---- Stats diff: null rate + numeric distribution shifts ----
  const statsDiff = buildStatsDiff(
    snapA.columnStats || [], snapB.columnStats || [],
    nullRateDeltaWarn, nullRateDeltaFail,
    meanDeltaWarn, meanDeltaFail,
  );
  for (const s of statsDiff.findings) findings.push(s);

  // ---- Roll up ----
  const worstStatus = findings.some(f => f.status === 'fail') ? 'fail'
    : findings.some(f => f.status === 'warn') ? 'warn'
    : findings.length === 0 ? 'pass' : 'pass';
  const worstLevel = findings.some(f => f.level === 'high') ? 'high'
    : findings.some(f => f.level === 'medium') ? 'medium'
    : findings.some(f => f.level === 'low') ? 'low' : 'none';

  const flaggedCount = findings.filter(f => f.status !== 'pass').length;
  const rationale = flaggedCount === 0
    ? 'No significant schema or statistical drift detected between "' +
      (snapA.label || snapA.capturedAt) + '" and "' + (snapB.label || snapB.capturedAt) + '".'
    : flaggedCount + ' drift finding(s) between "' +
      (snapA.label || snapA.capturedAt) + '" and "' + (snapB.label || snapB.capturedAt) + '": ' +
      findings.filter(f => f.status !== 'pass').map(f => f.detail).slice(0, 3).join('; ') +
      (flaggedCount > 3 ? ' (+ ' + (flaggedCount - 3) + ' more).' : '.');

  return {
    layer: 'dataset_diff',
    status: worstStatus,
    level: worstLevel,
    snapshotA: { label: snapA.label, capturedAt: snapA.capturedAt, rowCount: snapA.rowCount, columnCount: snapA.columnCount },
    snapshotB: { label: snapB.label, capturedAt: snapB.capturedAt, rowCount: snapB.rowCount, columnCount: snapB.columnCount },
    findings,
    flaggedCount,
    schemaDiff,
    statsDiff,
    rationale,
  };
}

// ---- helpers ---------------------------------------------------------------

function rowCountChange(a, b, warnDelta, failDelta) {
  if (a === null || b === null) return null;
  if (a === 0 && b === 0) return null;
  const delta = a === 0 ? (b > 0 ? 1 : 0) : Math.abs((b - a) / a);
  const direction = b > a ? 'increased' : b < a ? 'decreased' : 'unchanged';
  if (delta === 0) return null;
  const status = delta >= failDelta ? 'fail' : delta >= warnDelta ? 'warn' : 'pass';
  const level = delta >= failDelta ? (delta >= 0.5 ? 'high' : 'medium') : delta >= warnDelta ? 'low' : 'none';
  return {
    kind: 'row_count_changed',
    column: null, status, level,
    detail: 'Row count ' + direction + ' from ' + a.toLocaleString() + ' to ' + b.toLocaleString() +
      ' (' + (delta * 100).toFixed(1) + '% change).',
    deltaFraction: parseFloat(delta.toFixed(4)),
    oldValue: a, newValue: b,
  };
}

function buildSchemaDiff(colsA, colsB) {
  const mapA = new Map(colsA.map(c => [c.name, c]));
  const mapB = new Map(colsB.map(c => [c.name, c]));
  const findings = [];
  const added = [], removed = [], typeChanged = [];

  for (const [name, colB] of mapB) {
    if (!mapA.has(name)) {
      added.push(name);
      findings.push({ kind: 'column_added', column: name, status: 'warn', level: 'low',
        detail: 'Column "' + name + '" (' + colB.type + ') added.' });
    }
  }
  for (const [name, colA] of mapA) {
    if (!mapB.has(name)) {
      removed.push(name);
      findings.push({ kind: 'column_removed', column: name, status: 'fail', level: 'medium',
        detail: 'Column "' + name + '" (' + colA.type + ') removed.' });
    } else {
      const colB = mapB.get(name);
      if (colA.type !== colB.type) {
        typeChanged.push(name);
        findings.push({ kind: 'type_changed', column: name, status: 'warn', level: 'medium',
          detail: 'Column "' + name + '" type changed from ' + colA.type + ' to ' + colB.type + '.' });
      }
    }
  }

  return { added, removed, typeChanged, findings };
}

function buildStatsDiff(colsA, colsB, nullWarn, nullFail, meanWarn, meanFail) {
  const mapA = new Map(colsA.map(c => [c.name, c]));
  const mapB = new Map(colsB.map(c => [c.name, c]));
  const findings = [];

  for (const [name, colB] of mapB) {
    const colA = mapA.get(name);
    if (!colA) continue;

    // Null rate shift.
    if (colA.nullRate !== null && colB.nullRate !== null) {
      const nullDelta = Math.abs(colB.nullRate - colA.nullRate);
      if (nullDelta >= nullFail) {
        findings.push({ kind: 'null_rate_shifted', column: name, status: 'fail',
          level: nullDelta >= 0.30 ? 'high' : 'medium',
          detail: 'Null rate in "' + name + '" shifted from ' + fmtPct(colA.nullRate) + ' to ' + fmtPct(colB.nullRate) + ' (' + fmtPct(nullDelta) + ' change).',
          oldValue: colA.nullRate, newValue: colB.nullRate, delta: nullDelta });
      } else if (nullDelta >= nullWarn) {
        findings.push({ kind: 'null_rate_shifted', column: name, status: 'warn',
          level: 'low',
          detail: 'Null rate in "' + name + '" shifted from ' + fmtPct(colA.nullRate) + ' to ' + fmtPct(colB.nullRate) + ' (' + fmtPct(nullDelta) + ' change).',
          oldValue: colA.nullRate, newValue: colB.nullRate, delta: nullDelta });
      }
    }

    // Mean shift (numeric columns only).
    if (colA.meanVal !== null && colB.meanVal !== null && colA.meanVal !== 0) {
      const meanDelta = Math.abs((colB.meanVal - colA.meanVal) / colA.meanVal);
      if (meanDelta >= meanFail) {
        findings.push({ kind: 'mean_shifted', column: name, status: 'fail',
          level: meanDelta >= 1.0 ? 'high' : 'medium',
          detail: 'Mean of "' + name + '" shifted from ' + colA.meanVal.toFixed(2) + ' to ' + colB.meanVal.toFixed(2) + ' (' + fmtPct(meanDelta) + ' relative change).',
          oldValue: colA.meanVal, newValue: colB.meanVal, delta: meanDelta });
      } else if (meanDelta >= meanWarn) {
        findings.push({ kind: 'mean_shifted', column: name, status: 'warn', level: 'low',
          detail: 'Mean of "' + name + '" shifted from ' + colA.meanVal.toFixed(2) + ' to ' + colB.meanVal.toFixed(2) + ' (' + fmtPct(meanDelta) + ' relative change).',
          oldValue: colA.meanVal, newValue: colB.meanVal, delta: meanDelta });
      }
    }
  }

  return { findings };
}

function q(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
function safeNum(row, key) {
  if (!row) return 0;
  const v = row[key];
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' ? v : parseInt(String(v), 10) || 0;
}
function safeFloat(row, key) {
  if (!row) return null;
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' ? v : parseFloat(String(v)) || null;
}
const NUMERIC_TYPES = new Set(['INTEGER','BIGINT','DOUBLE','FLOAT','DECIMAL','NUMERIC','REAL','SMALLINT','TINYINT','HUGEINT','INT','INT4','INT8','FLOAT4','FLOAT8']);
function isNumericType(t) { return t && NUMERIC_TYPES.has(t.toUpperCase().split('(')[0].trim()); }
function fmtPct(v) { return (v * 100).toFixed(1) + '%'; }
