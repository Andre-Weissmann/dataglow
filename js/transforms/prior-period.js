// ============================================================
// DATAGLOW - A18 Compare to previous period (day / week / month over month)
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. "Is this month better than last month?", per entity if the
// data has entities. It aggregates a metric into calendar periods and puts the
// prior period's value, the delta and the percent change beside each one.
//
// THE ONE DECISION THAT MATTERS: WHAT "PRIOR" MEANS.
// The obvious implementation is LAG(value) OVER (ORDER BY period), which returns
// the previous ROW. That is wrong whenever the data has a gap, and real data has
// gaps: a shop closed in February, a sensor offline for a week, a customer who
// bought in January and again in March. LAG would compare March against January
// and label it "month over month", which is a wrong number that looks completely
// reasonable on a chart.
//
// So prior here means the previous CALENDAR period, computed by stepping the
// calendar back one grain and looking that key up. If that period is absent, the
// prior value is null, the delta is null, and the result says so in its notes.
// The generated SQL uses a LEFT JOIN on the stepped-back period key rather than
// a bare LAG, for the same reason and so the proof matches the rows.
//
// A metric is aggregated by SUM by default because that is what "sales this
// month" means. AVG, MIN, MAX and COUNT are offered because "average price this
// month" is just as common a question, and picking SUM for an average is the
// same class of silent error this module exists to avoid.

import {
  PERIOD_GRAINS,
  quoteIdent,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  suggestDateColumn,
  suggestNumericColumn,
  parseDateValue,
  periodKeyOf,
  priorPeriodKeyOf,
  truncUnitFor,
  intervalFor,
  toNumber,
  pctChange,
  isPlainObject,
  asColumnList,
  missingColumns,
  keyOfRow,
  column,
  transformResult,
  transformError,
  TYPE_STR,
  TYPE_FLOAT,
  TYPE_INT,
} from './transform-core.js';

export const PRIOR_PERIOD_VERSION = 1;

// SUM first because it is the common case and the default.
export const PRIOR_PERIOD_AGGREGATES = Object.freeze(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT']);

export const PRIOR_PERIOD_AGGREGATE_LABELS = Object.freeze({
  SUM: 'Total',
  AVG: 'Average',
  MIN: 'Lowest',
  MAX: 'Highest',
  COUNT: 'How many rows',
});

export function createEmptyPriorPeriodConfig() {
  return {
    dateColumn: '',
    metricColumn: '',
    aggregate: 'SUM',
    grain: 'month',
    entityColumns: [],
  };
}

/** A starting point from the loaded table's own shape. A suggestion only:
    nothing runs until a person picks and confirms. */
export function suggestPriorPeriodConfig(dataset) {
  const cfg = createEmptyPriorPeriodConfig();
  cfg.dateColumn = suggestDateColumn(dataset) || '';
  cfg.metricColumn = suggestNumericColumn(dataset) || '';
  return cfg;
}

export function validatePriorPeriodConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  if (!config.dateColumn) errors.push('Pick the column that holds the date.');
  else if (!names.includes(config.dateColumn)) errors.push('The date column ' + config.dateColumn + ' is not in this table.');

  const agg = String(config.aggregate || 'SUM').toUpperCase();
  if (!PRIOR_PERIOD_AGGREGATES.includes(agg)) {
    errors.push('Pick how to combine the metric: ' + PRIOR_PERIOD_AGGREGATES.join(', ') + '.');
  }

  // COUNT is the one aggregate that needs no metric column, since it counts
  // rows rather than measuring anything.
  if (agg !== 'COUNT') {
    if (!config.metricColumn) errors.push('Pick the column you want to compare.');
    else if (!names.includes(config.metricColumn)) errors.push('The metric column ' + config.metricColumn + ' is not in this table.');
  }

  const grain = String(config.grain || 'month');
  if (!PERIOD_GRAINS.includes(grain)) errors.push('Pick a period: day, week or month.');

  const entities = asColumnList(config.entityColumns);
  const missingEntities = missingColumns(names, entities);
  if (missingEntities.length > 0) {
    errors.push('These grouping columns are not in this table: ' + missingEntities.join(', ') + '.');
  }
  if (entities.includes(config.dateColumn)) {
    errors.push('The date column cannot also be a grouping column.');
  }

  return { ok: errors.length === 0, errors: errors };
}

/**
 * The glass-box SQL. A LEFT JOIN of the period totals onto themselves on the
 * stepped-back period key, which is the statement of "the same entity, one
 * period earlier, and nothing else". A reader can paste this into the SQL tab
 * and get the rows this module produced.
 */
export function buildPriorPeriodSQL(config, sourceRelation) {
  const v = validatePriorPeriodConfig(config, allNamesFrom(config));
  if (!isPlainObject(config)) return { ok: false, errors: v.errors };

  const rel = relationName(sourceRelation, 'your_table');
  const grain = String(config.grain || 'month');
  const unit = truncUnitFor(grain);
  const step = intervalFor(grain);
  const agg = String(config.aggregate || 'SUM').toUpperCase();
  const dateCol = quoteIdent(config.dateColumn);
  const entities = asColumnList(config.entityColumns);
  const entityCols = entities.map(quoteIdent);

  const measure = agg === 'COUNT' ? 'COUNT(*)' : agg + '(' + quoteIdent(config.metricColumn) + ')';

  const groupSelect = entityCols.concat([
    'date_trunc(' + "'" + unit + "'" + ', ' + dateCol + ') AS period_start',
    measure + ' AS metric_value',
  ]);
  const groupBy = entityCols.concat(['period_start']);

  // The join condition: same entity, and the current row's period start minus
  // exactly one grain equals the other row's period start.
  const onParts = entities.map((e) => 'prior.' + quoteIdent(e) + ' IS NOT DISTINCT FROM cur.' + quoteIdent(e));
  onParts.push('prior.period_start = cur.period_start - ' + step);

  const outSelect = entities.map((e) => 'cur.' + quoteIdent(e))
    .concat([
      'cur.period_start',
      'cur.metric_value',
      'prior.metric_value AS prior_value',
      'cur.metric_value - prior.metric_value AS change',
      // Guarded so a prior of zero yields NULL rather than a division error or
      // an infinity printed next to real numbers.
      'CASE WHEN prior.metric_value IS NULL OR prior.metric_value = 0 THEN NULL'
        + ' ELSE (cur.metric_value - prior.metric_value) / abs(prior.metric_value) END AS pct_change',
    ]);

  const lines = [
    '-- Compare to previous period (' + grain + ' over ' + grain + ')',
    '-- Prior is the previous CALENDAR ' + grain + ', not simply the previous row:',
    '-- a gap in the data yields no prior rather than a misleading comparison.',
    'WITH by_period AS (',
    '  SELECT ' + groupSelect.join(', '),
    '  FROM ' + rel,
    '  WHERE ' + dateCol + ' IS NOT NULL',
    '  GROUP BY ' + groupBy.join(', '),
    ')',
    'SELECT ' + outSelect.join(', '),
    'FROM by_period AS cur',
    'LEFT JOIN by_period AS prior',
    '  ON ' + onParts.join(' AND '),
    'ORDER BY ' + (entityCols.length ? entityCols.map((e) => 'cur.' + e).join(', ') + ', ' : '') + 'cur.period_start',
  ];

  return { ok: true, sql: lines.join('\n') };
}

function allNamesFrom(config) {
  // buildPriorPeriodSQL is sometimes called for display before a dataset is in
  // hand. Validating against the config's own names keeps it honest about
  // structure without requiring the table.
  if (!isPlainObject(config)) return [];
  return asColumnList(config.entityColumns)
    .concat([config.dateColumn, config.metricColumn])
    .filter(Boolean);
}

/**
 * Do the work. Returns the standard transform shape: columns, rows, the SQL that
 * states what happened, counts, and notes naming everything it could not do.
 */
export function priorPeriodTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded to compare.');
  const names = columnNamesOf(dataset);
  const v = validatePriorPeriodConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const grain = String(config.grain || 'month');
  const agg = String(config.aggregate || 'SUM').toUpperCase();
  const entities = asColumnList(config.entityColumns);
  const dateIdx = indexOfColumn(names, config.dateColumn);
  const metricIdx = agg === 'COUNT' ? -1 : indexOfColumn(names, config.metricColumn);
  const entityIdxs = entities.map((e) => indexOfColumn(names, e));

  const srcRows = rowsOf(dataset);
  const buckets = new Map();
  let unreadableDates = 0;
  let unreadableMetrics = 0;

  for (let i = 0; i < srcRows.length; i += 1) {
    const row = srcRows[i];
    if (!Array.isArray(row)) continue;
    const d = parseDateValue(row[dateIdx]);
    if (!d) { unreadableDates += 1; continue; }
    const period = periodKeyOf(d, grain);
    if (!period) { unreadableDates += 1; continue; }

    let value = null;
    if (agg === 'COUNT') {
      value = 1;
    } else {
      value = toNumber(row[metricIdx]);
      if (value === null) { unreadableMetrics += 1; continue; }
    }

    const entityKey = keyOfRow(row, entityIdxs);
    // Escape rather than a literal control byte, so this module stays safe to
    // inline into canvas/index.html and reviewable in a diff.
    const bucketKey = entityKey + '\u001e' + period;
    let b = buckets.get(bucketKey);
    if (!b) {
      b = {
        entityKey: entityKey,
        entityValues: entityIdxs.map((idx) => (idx >= 0 ? row[idx] : null)),
        period: period,
        sum: 0, count: 0, min: null, max: null,
      };
      buckets.set(bucketKey, b);
    }
    b.sum += value;
    b.count += 1;
    if (b.min === null || value < b.min) b.min = value;
    if (b.max === null || value > b.max) b.max = value;
  }

  // Index by entity then period so the prior lookup is a direct hit rather than
  // a scan, and so a missing period is genuinely absent instead of being the
  // nearest neighbour.
  const byEntityPeriod = new Map();
  for (const b of buckets.values()) {
    let m = byEntityPeriod.get(b.entityKey);
    if (!m) { m = new Map(); byEntityPeriod.set(b.entityKey, m); }
    m.set(b.period, aggregateOf(b, agg));
  }

  const outColumns = entities.map((e) => column(e, dsType(dataset, e)))
    .concat([
      column('period_start', TYPE_STR),
      column('metric_value', agg === 'COUNT' ? TYPE_INT : TYPE_FLOAT),
      column('prior_value', agg === 'COUNT' ? TYPE_INT : TYPE_FLOAT),
      column('change', TYPE_FLOAT),
      column('pct_change', TYPE_FLOAT),
    ]);

  const ordered = Array.from(buckets.values()).sort((a, b) => {
    if (a.entityKey < b.entityKey) return -1;
    if (a.entityKey > b.entityKey) return 1;
    if (a.period < b.period) return -1;
    if (a.period > b.period) return 1;
    return 0;
  });

  const outRows = [];
  let withoutPrior = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const b = ordered[i];
    const current = aggregateOf(b, agg);
    const priorKey = priorPeriodKeyOf(b.period, grain);
    const periods = byEntityPeriod.get(b.entityKey);
    const prior = priorKey && periods && periods.has(priorKey) ? periods.get(priorKey) : null;
    if (prior === null) withoutPrior += 1;
    const change = prior === null ? null : current - prior;
    outRows.push(b.entityValues.concat([
      b.period,
      current,
      prior,
      change,
      pctChange(current, prior),
    ]));
  }

  const built = buildPriorPeriodSQL(config, dataset.name);
  const notes = [];
  if (withoutPrior > 0) {
    notes.push(withoutPrior + ' of ' + outRows.length + ' period'
      + (outRows.length === 1 ? '' : 's') + ' had no previous ' + grain
      + ' in this table, so the prior value is blank rather than estimated.');
  }
  if (unreadableDates > 0) {
    notes.push(unreadableDates + ' row' + (unreadableDates === 1 ? '' : 's')
      + ' had a date that could not be read and were left out. Check the format of '
      + config.dateColumn + '.');
  }
  if (unreadableMetrics > 0) {
    notes.push(unreadableMetrics + ' row' + (unreadableMetrics === 1 ? '' : 's')
      + ' had no number in ' + config.metricColumn + ' and were left out of the totals.');
  }

  return transformResult({
    columns: outColumns,
    rows: outRows,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: srcRows.length,
      rowsOut: outRows.length,
      periods: outRows.length,
      withoutPrior: withoutPrior,
      unreadableDates: unreadableDates,
      unreadableMetrics: unreadableMetrics,
      grain: grain,
      aggregate: agg,
    },
    notes: notes,
  });
}

function aggregateOf(bucket, agg) {
  if (agg === 'COUNT') return bucket.count;
  if (agg === 'AVG') return bucket.count === 0 ? null : bucket.sum / bucket.count;
  if (agg === 'MIN') return bucket.min;
  if (agg === 'MAX') return bucket.max;
  return bucket.sum;
}

function dsType(dataset, name) {
  const cols = (dataset && dataset.columns) || [];
  for (let i = 0; i < cols.length; i += 1) {
    if (cols[i] && cols[i].name === name) return String(cols[i].type || TYPE_STR).toUpperCase();
  }
  return TYPE_STR;
}

/** One plain sentence for the panel header, so the finding leads and the proof
    follows. Never claims a comparison that did not happen. */
export function describePriorPeriod(result, config) {
  if (!result || !result.ok) return 'This comparison did not run.';
  const grain = String((config && config.grain) || 'month');
  const s = result.stats || {};
  const compared = (s.rowsOut || 0) - (s.withoutPrior || 0);
  if ((s.rowsOut || 0) === 0) return 'No periods came back, so there is nothing to compare.';
  if (compared === 0) {
    return 'None of the ' + s.rowsOut + ' periods had a previous ' + grain + ' to compare against.';
  }
  return compared + ' of ' + s.rowsOut + ' periods have a previous ' + grain + ' to compare against.';
}

export const DataGlowPriorPeriod = {
  PRIOR_PERIOD_VERSION,
  PRIOR_PERIOD_AGGREGATES,
  PRIOR_PERIOD_AGGREGATE_LABELS,
  createEmptyPriorPeriodConfig,
  suggestPriorPeriodConfig,
  validatePriorPeriodConfig,
  buildPriorPeriodSQL,
  priorPeriodTransform,
  describePriorPeriod,
};
