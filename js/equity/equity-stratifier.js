// ============================================================
// DATAGLOW — Equity Stratifier (Phase 3)
// ============================================================
// The DuckDB-WASM-aware engine that stratifies outcome metrics by equity
// stratifier columns. Takes the detected columns from equity-detector.js,
// runs GROUP BY queries against the live DuckDB table, and feeds the results
// to disparity-scorer.js.
//
// WHY THIS EXISTS:
// The detector finds the columns. The scorer does the statistics. This module
// is the bridge: it generates and runs the right SQL for each
// (metric × stratifier) combination and normalises the results into the shape
// the scorer expects.
//
// DESIGN:
// Pure DuckDB-WASM adapter. No DOM, no network. Engine parameter matches the
// shape used by the Phase 2 relational checkers: { runQuery(sql) -> {rows} }.
//
// SAMPLING:
// For large tables we sample up to STRATIFY_ROW_LIMIT rows to keep the query
// fast. The sample is always labelled in the output. All GROUP BY queries run
// on the sample, so rates are estimates on large datasets.

import { scoreDisparities, MIN_CELL_SIZE } from './disparity-scorer.js';

export const STRATIFY_ROW_LIMIT = 50000; // rows to sample per run
export const MAX_GROUPS         = 50;    // max distinct values per stratifier col

/**
 * Run equity stratification for all (metric × stratifier) combinations.
 *
 * @param {object} opts
 * @param {string} opts.table - DuckDB table name
 * @param {Array<{name,type,role,roleLabel}>} opts.stratifiers
 * @param {Array<{name,type,kind,kindLabel,numeric}>} opts.metrics
 * @param {object} opts.engine - { runQuery }
 * @param {number} [opts.rowLimit]
 * @returns {Promise<object>} { analyses, summary, status, level, rationale }
 */
export async function stratifyEquity({ table, stratifiers, metrics, engine, rowLimit = STRATIFY_ROW_LIMIT }) {
  if (!stratifiers.length || !metrics.length) {
    return {
      analyses: [], status: 'idle', level: 'none',
      summary: { total: 0, pass: 0, warn: 0, fail: 0, idle: 0, flaggedPairs: 0 },
      rationale: 'Equity stratification skipped -- no stratifier/metric pairs available.',
    };
  }

  // Get total row count to decide whether to sample.
  let totalRows = null;
  try {
    const cRes = await engine.runQuery('SELECT COUNT(*) AS n FROM ' + q(table));
    totalRows = safeNum(cRes.rows[0], 'n');
  } catch { /* ok */ }

  const useSample = totalRows !== null && totalRows > rowLimit;
  const sampleClause = useSample
    ? ' FROM ' + q(table) + ' USING SAMPLE ' + rowLimit + ' ROWS'
    : ' FROM ' + q(table);

  const analyses = [];

  for (const stratifier of stratifiers) {
    for (const metric of metrics) {
      const analysis = await runOneAnalysis({ table, stratifier, metric, engine, sampleClause, totalRows, rowLimit, useSample });
      analyses.push(analysis);
    }
  }

  // Aggregate summary.
  const summary = { total: analyses.length, pass: 0, warn: 0, fail: 0, idle: 0, flaggedPairs: 0 };
  for (const a of analyses) {
    summary[a.status] = (summary[a.status] || 0) + 1;
    if (a.status === 'fail' || a.status === 'warn') summary.flaggedPairs++;
  }

  const worstStatus = analyses.some(a => a.status === 'fail') ? 'fail'
    : analyses.some(a => a.status === 'warn') ? 'warn'
    : analyses.every(a => a.status === 'idle') ? 'idle' : 'pass';
  const worstLevel = analyses.some(a => a.level === 'high') ? 'high'
    : analyses.some(a => a.level === 'medium') ? 'medium'
    : analyses.some(a => a.level === 'low') ? 'low' : 'none';

  const rationale = summary.flaggedPairs === 0
    ? 'No significant equity disparities detected across ' + summary.total + ' stratification(s).'
    : summary.flaggedPairs + '/' + summary.total + ' stratification(s) show significant disparities. '
      + 'These differences may indicate systemic inequities in care delivery or data collection. '
      + (useSample ? '(Analysis based on a sample of ' + rowLimit.toLocaleString() + '/' + totalRows.toLocaleString() + ' rows.)' : '');

  return { analyses, summary, status: worstStatus, level: worstLevel, rationale, totalRows, useSample };
}

// ---- single (metric × stratifier) analysis ---------------------------------

async function runOneAnalysis({ table, stratifier, metric, engine, sampleClause, totalRows, rowLimit, useSample }) {
  const sName = stratifier.name;
  const mName = metric.name;
  const metricType = metric.kind === 'los' || metric.kind === 'cost' || metric.kind === 'quality'
    ? 'continuous' : 'binary';
  const label = metric.kindLabel + ' by ' + stratifier.roleLabel;

  try {
    // Check how many distinct stratifier values exist (cap to avoid explosion).
    const distRes = await engine.runQuery(
      'SELECT COUNT(DISTINCT ' + q(sName) + ') AS n' + sampleClause + ' WHERE ' + q(sName) + ' IS NOT NULL'
    );
    const distinctCount = safeNum(distRes.rows[0], 'n');

    if (distinctCount === 0) {
      return makeAnalysis({ stratifier, metric, metricType, label, groups: [],
        scoring: { status: 'idle', level: 'none', findings: [], flagged: [],
          rationale: 'No non-null values in stratifier column "' + sName + '".' },
        useSample, totalRows, rowLimit });
    }

    if (distinctCount > MAX_GROUPS) {
      return makeAnalysis({ stratifier, metric, metricType, label, groups: [],
        scoring: { status: 'idle', level: 'none', findings: [], flagged: [],
          rationale: '"' + sName + '" has ' + distinctCount + ' distinct values (max ' + MAX_GROUPS + ') -- too many groups for stratification. Consider binning this column.' },
        useSample, totalRows, rowLimit });
    }

    // Run the GROUP BY query.
    let sql;
    if (metricType === 'binary') {
      // rate = AVG of the binary column (0/1) = proportion.
      sql = 'SELECT ' + q(sName) + ' AS grp, COUNT(*) AS n, AVG(CAST(' + q(mName) + ' AS DOUBLE)) AS rate'
        + sampleClause
        + ' WHERE ' + q(sName) + ' IS NOT NULL AND ' + q(mName) + ' IS NOT NULL'
        + ' GROUP BY ' + q(sName)
        + ' ORDER BY n DESC';
    } else {
      // Continuous: mean and sum.
      sql = 'SELECT ' + q(sName) + ' AS grp, COUNT(*) AS n, AVG(CAST(' + q(mName) + ' AS DOUBLE)) AS mean_val, SUM(CAST(' + q(mName) + ' AS DOUBLE)) AS sum_val'
        + sampleClause
        + ' WHERE ' + q(sName) + ' IS NOT NULL AND ' + q(mName) + ' IS NOT NULL'
        + ' GROUP BY ' + q(sName)
        + ' ORDER BY n DESC';
    }

    const { rows } = await engine.runQuery(sql);

    const groups = rows.map(r => ({
      group: String(r.grp ?? '(unknown)'),
      n: safeNum(r, 'n'),
      rate: metricType === 'binary' ? safeFloat(r, 'rate') : undefined,
      mean: metricType === 'continuous' ? safeFloat(r, 'mean_val') : undefined,
      sum: metricType === 'continuous' ? safeFloat(r, 'sum_val') : undefined,
    }));

    // Score disparities.
    const scoring = scoreDisparities({
      groups, metricType,
      metricName: metric.kindLabel,
      stratifierName: stratifier.roleLabel,
    });

    return makeAnalysis({ stratifier, metric, metricType, label, groups, scoring, useSample, totalRows, rowLimit });

  } catch (err) {
    return makeAnalysis({ stratifier, metric, metricType, label, groups: [],
      scoring: { status: 'idle', level: 'none', findings: [], flagged: [],
        rationale: 'Stratification query failed for ' + label + ': ' + String(err && err.message ? err.message : err) },
      useSample, totalRows, rowLimit, error: String(err) });
  }
}

// ---- helpers ---------------------------------------------------------------

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

function makeAnalysis({ stratifier, metric, metricType, label, groups, scoring, useSample, totalRows, rowLimit, error = null }) {
  return {
    layer: 'equity_stratification',
    label,
    stratifier: { name: stratifier.name, role: stratifier.role, roleLabel: stratifier.roleLabel },
    metric: { name: metric.name, kind: metric.kind, kindLabel: metric.kindLabel },
    metricType,
    groups,
    scoring,
    status: scoring.status,
    level: scoring.level,
    rationale: scoring.rationale,
    useSample,
    totalRows,
    sampleLimit: useSample ? rowLimit : null,
    ...(error ? { error } : {}),
  };
}
