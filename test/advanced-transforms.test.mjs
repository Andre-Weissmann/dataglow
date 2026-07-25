// ============================================================
// DATAGLOW - Bundle 8 advanced transforms test suite
// ============================================================
// Pure, no DuckDB, no network, no DOM.
// Run: node test/advanced-transforms.test.mjs
//
// Written around the way each of these could be quietly wrong rather than around
// its happy path, because each one has a failure mode that produces a
// plausible-looking table nobody questions:
//   A21 a duplicate date drifts the row number and splits one streak into two
//   A22 a warm-up average printed as if it were a full window, or a crossover
//       invented on the first row where both averages happen to exist
//   A23 multi-membership counts presented with an exclusive denominator, so
//       percentages that sum to 180 get rescaled by the reader
//   A28 pairs ranked by raw count, which ranks popularity and not association,
//       plus the mirror image counted twice
//   A30 events in the last N days counted as "did not return", which reads the
//       calendar as a finding and biases the rate down
//   Standardizer a merge applied without confirmation, or with no record of what
//       the cells used to say, which makes it unreviewable and unpickable
import assert from 'assert';

import {
  MS_PER_DAY,
  daysBetween,
  addDays,
  readList,
  cellText,
} from '../js/transforms/transform-core.js';

import {
  ACTIVITY_MODES,
  createEmptyRunConfig,
  suggestRunConfig,
  validateRunConfig,
  isActiveRow,
  buildConsecutiveRunSQL,
  consecutiveRunTransform,
  describeConsecutiveRun,
} from '../js/transforms/consecutive-run.js';

import {
  LARGE_WINDOW_WARN,
  WARMUP_MODES,
  createEmptyMovingAverageConfig,
  suggestMovingAverageConfig,
  validateMovingAverageConfig,
  averageColumnName,
  crossColumnName,
  hasCrossover,
  buildMovingAverageSQL,
  movingAverageTransform,
  describeMovingAverage,
} from '../js/transforms/moving-average.js';

import {
  VALUE_SOURCES,
  CASE_MODES,
  TOO_MANY_DISTINCT,
  NO_VALUE_LABEL,
  createEmptyMultiValueConfig,
  suggestMultiValueConfig,
  validateMultiValueConfig,
  buildMultiValueCountsSQL,
  multiValueCountsTransform,
  describeMultiValueCounts,
} from '../js/transforms/multi-value-counts.js';

import {
  COMBO_SOURCES,
  THIN_SUPPORT,
  MAX_ITEMS_PER_RECORD,
  createEmptyCombinationsConfig,
  suggestCombinationsConfig,
  validateCombinationsConfig,
  itemsOfRow,
  buildCombinationsSQL,
  frequentCombinationsTransform,
  describeFrequentCombinations,
} from '../js/transforms/frequent-combinations.js';

import {
  INDEX_SCOPES,
  DEFAULT_WINDOW_DAYS,
  createEmptyRecurrenceConfig,
  suggestRecurrenceConfig,
  validateRecurrenceConfig,
  buildRecurrenceSQL,
  windowRecurrenceTransform,
  describeWindowRecurrence,
} from '../js/transforms/window-recurrence.js';

import {
  MATCH_MODES,
  IDENTIFIER_DISTINCT_SHARE,
  TOO_MANY_TO_REVIEW,
  createEmptyStandardizerConfig,
  auditColumnName,
  distinctValuesOf,
  normalizeKey,
  proposeMergeGroups,
  mapFromGroups,
  validateStandardizerConfig,
  buildStandardizerSQL,
  valueStandardizerTransform,
  describeValueStandardizer,
  summarizeForConfirm,
} from '../js/transforms/value-standardizer.js';

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error('FAIL ' + name);
  console.log('  ✓ ' + name);
  passed++;
}

function ds(name, cols, rows) {
  return { name: name, columns: cols, rows: rows };
}
function col(n, t) { return { name: n, type: t }; }

function valueAt(res, row, colName) {
  const i = res.columns.findIndex((c) => c.name === colName);
  return i === -1 ? undefined : row[i];
}
function rowWhere(res, colName, value) {
  return res.rows.find((r) => valueAt(res, r, colName) === value);
}
function colOf(res, colName) {
  const i = res.columns.findIndex((c) => c.name === colName);
  return i === -1 ? [] : res.rows.map((r) => r[i]);
}
function names(res) { return res.columns.map((c) => c.name); }

/* ==========================================================================
   Shared core: the day arithmetic all three date transforms depend on
   ========================================================================== */
console.log('\nshared day arithmetic');

ok('a day is 86400000 milliseconds', MS_PER_DAY === 86400000);
ok('one day apart is one day', daysBetween(new Date('2024-03-01'), new Date('2024-03-02')) === 1);
ok('the same day is zero days', daysBetween(new Date('2024-03-01'), new Date('2024-03-01')) === 0);
ok('a backwards span is negative',
  daysBetween(new Date('2024-03-05'), new Date('2024-03-01')) === -4);
// The spring clock change is the classic off-by-one: a naive difference in hours
// makes this span 0.958 days, which floors to zero and loses a day.
ok('a span across the spring clock change is still whole days',
  daysBetween(new Date('2024-03-09'), new Date('2024-03-11')) === 2);
ok('a span across the autumn clock change is still whole days',
  daysBetween(new Date('2024-11-02'), new Date('2024-11-04')) === 2);
ok('a leap day is counted', daysBetween(new Date('2024-02-28'), new Date('2024-03-01')) === 2);
ok('a non-leap February is counted',
  daysBetween(new Date('2023-02-28'), new Date('2023-03-01')) === 1);
ok('an unreadable date gives null, not a number', daysBetween(null, new Date('2024-01-01')) === null);
ok('an invalid date gives null', daysBetween(new Date('nope'), new Date('2024-01-01')) === null);
ok('a non-date gives null', daysBetween('2024-01-01', new Date('2024-01-02')) === null);
ok('adding days moves forward',
  addDays(new Date('2024-03-01'), 3).toISOString().slice(0, 10) === '2024-03-04');
ok('adding negative days moves back',
  addDays(new Date('2024-03-01'), -1).toISOString().slice(0, 10) === '2024-02-29');
ok('adding zero days changes nothing',
  addDays(new Date('2024-03-01'), 0).getTime() === new Date('2024-03-01').getTime());

ok('a delimited cell splits', readList('a,b', 'auto', ',').values.length === 2);
ok('a JSON array cell is recognised', readList('["a","b"]', 'auto', ',').kind === 'json');
ok('a real array is taken as is', readList(['a', 'b'], 'auto', ',').kind === 'array');
ok('an empty cell is empty and not a one-item list', readList('', 'auto', ',').kind === 'empty');
ok('a null cell is empty', readList(null, 'auto', ',').kind === 'empty');
ok('a plain value is a one-item list', readList('solo', 'auto', ',').values.length === 1);
ok('a cell can be read as text', cellText(' x ', true) === 'x');
ok('text can keep its whitespace', cellText(' x ', false) === ' x ');
ok('an object becomes JSON and not [object Object]',
  cellText({ a: 1 }, true) === '{"a":1}');

/* ==========================================================================
   A21 Consecutive run: the duplicate date is the whole risk
   ========================================================================== */
console.log('\nA21 consecutive run');

const activity = ds('activity', [col('user', 'STR'), col('day', 'DATE'), col('minutes', 'INT')], [
  ['a', '2024-03-01', 10],
  ['a', '2024-03-02', 5],
  ['a', '2024-03-02', 7],
  ['a', '2024-03-03', 3],
  ['a', '2024-03-05', 9],
  ['b', '2024-03-02', 0],
  ['b', '2024-03-08', 4],
  ['b', '2024-03-09', 4],
  ['c', 'not a date', 1],
]);
const runCfg = Object.assign(createEmptyRunConfig(), {
  entityColumns: ['user'], dateColumn: 'day', activity: 'present', minLength: 1,
});

ok('the empty run config names no entity', createEmptyRunConfig().entityColumns.length === 0);
ok('the empty run config asks for runs of one or more', createEmptyRunConfig().minLength === 1);
ok('every activity mode is declared', ACTIVITY_MODES.length >= 5);
ok('present is an activity mode', ACTIVITY_MODES.indexOf('present') !== -1);
ok('atLeast is an activity mode', ACTIVITY_MODES.indexOf('atLeast') !== -1);

const runV = validateRunConfig(runCfg, ['user', 'day', 'minutes']);
ok('a complete run config validates', runV.ok === true);
ok('a run config with no entity is refused',
  validateRunConfig(Object.assign({}, runCfg, { entityColumns: [] }), ['user', 'day']).ok === false);
ok('a run config with no date is refused',
  validateRunConfig(Object.assign({}, runCfg, { dateColumn: '' }), ['user', 'day']).ok === false);
ok('a date column missing from the table is refused',
  validateRunConfig(Object.assign({}, runCfg, { dateColumn: 'ghost' }), ['user', 'day']).ok === false);
ok('the date column cannot also be the entity',
  validateRunConfig(Object.assign({}, runCfg, { entityColumns: ['day'] }), ['user', 'day']).ok === false);
ok('a zero minimum length is refused',
  validateRunConfig(Object.assign({}, runCfg, { minLength: 0 }), ['user', 'day']).ok === false);
ok('a fractional minimum length is refused',
  validateRunConfig(Object.assign({}, runCfg, { minLength: 2.5 }), ['user', 'day']).ok === false);
ok('an unreadable as-of date is refused',
  validateRunConfig(Object.assign({}, runCfg, { asOf: 'someday' }), ['user', 'day']).ok === false);
ok('a nonsense activity mode is refused',
  validateRunConfig(Object.assign({}, runCfg, { activity: 'vibes' }), ['user', 'day']).ok === false);
ok('an equals test with no value is refused',
  validateRunConfig(Object.assign({}, runCfg,
    { activity: 'equals', activityColumn: 'minutes', activityValue: '' }), ['user', 'day', 'minutes']).ok === false);
ok('no configuration at all is refused', validateRunConfig(null, ['user']).ok === false);

const runs = consecutiveRunTransform(activity, runCfg);
ok('the run transform runs', runs.ok === true);
ok('the run table names the entity first', names(runs)[0] === 'user');
ok('the run table reports a start', names(runs).indexOf('run_start') !== -1);
ok('the run table reports an end', names(runs).indexOf('run_end') !== -1);
ok('the run table reports a length in days', names(runs).indexOf('run_days') !== -1);
ok('with no as-of date there is no still-running column',
  names(runs).indexOf('still_running') === -1);

const runA1 = runs.rows.find((r) => r[0] === 'a' && valueAt(runs, r, 'run_start') === '2024-03-01');
// If the duplicate March 2 had been counted twice, the row number would have
// drifted and this streak would have come back as 1 day plus 2 days.
ok('a duplicated date does not split a real streak', valueAt(runs, runA1, 'run_days') === 3);
ok('the streak ends on the last active day', valueAt(runs, runA1, 'run_end') === '2024-03-03');
ok('the duplicate day is counted and reported', runs.stats.duplicateDays === 1);
ok('a gap starts a new streak',
  !!runs.rows.find((r) => r[0] === 'a' && valueAt(runs, r, 'run_start') === '2024-03-05'));
ok('a single active day is a run of one',
  valueAt(runs, runs.rows.find((r) => r[0] === 'a'
    && valueAt(runs, r, 'run_start') === '2024-03-05'), 'run_days') === 1);
ok('two entities do not share a streak',
  runs.rows.filter((r) => r[0] === 'b').length === 2);
ok('an unreadable date is dropped and counted', runs.stats.unreadableDates === 1);
ok('the longest run is reported', runs.stats.longestRun === 3);
ok('single-day runs are counted', runs.stats.singleDayRuns >= 2);
ok('the run transform says something about what it did', runs.notes.length > 0);
ok('the run notes mention the duplicate collapse',
  runs.notes.join(' ').toLowerCase().includes('repeated a date')
  || runs.notes.join(' ').toLowerCase().includes('duplicate')
  || runs.notes.join(' ').toLowerCase().includes('twice'));
ok('the run description is a plain sentence',
  typeof describeConsecutiveRun(runs) === 'string' && describeConsecutiveRun(runs).length > 20);

const runsMin = consecutiveRunTransform(activity, Object.assign({}, runCfg, { minLength: 3 }));
ok('a minimum length hides the short runs', runsMin.rows.length === 1);
ok('the hidden runs are counted, not forgotten', runsMin.stats.runsHidden >= 2);
ok('the hidden runs are mentioned',
  runsMin.notes.join(' ').includes('not shown') || runsMin.notes.join(' ').includes('hidden'));

const runsAsOf = consecutiveRunTransform(activity, Object.assign({}, runCfg, { asOf: '2024-03-05' }));
ok('an as-of date adds the still-running column',
  names(runsAsOf).indexOf('still_running') !== -1);
const openRun = runsAsOf.rows.find((r) => r[0] === 'a'
  && valueAt(runsAsOf, r, 'run_start') === '2024-03-05');
ok('a run reaching the as-of date is still running',
  valueAt(runsAsOf, openRun, 'still_running') === true);
const closedRun = runsAsOf.rows.find((r) => r[0] === 'a'
  && valueAt(runsAsOf, r, 'run_start') === '2024-03-01');
ok('a run ending before the as-of date is not still running',
  valueAt(runsAsOf, closedRun, 'still_running') === false);
ok('open runs are counted', runsAsOf.stats.openRuns >= 1);

const runsAtLeast = consecutiveRunTransform(activity, Object.assign({}, runCfg, {
  activity: 'atLeast', activityColumn: 'minutes', activityValue: 4,
}));
ok('an at-least test excludes the days below the threshold',
  runsAtLeast.stats.inactiveRows >= 2);
ok('an at-least test still finds a streak', runsAtLeast.rows.length >= 1);
ok('isActiveRow reads a threshold',
  isActiveRow(['a', '2024-03-01', 10], 2,
    { activity: 'atLeast', activityValue: 4 }) === true);
ok('isActiveRow rejects below a threshold',
  isActiveRow(['a', '2024-03-01', 1], 2,
    { activity: 'atLeast', activityValue: 4 }) === false);
ok('isActiveRow treats zero as inactive under truthy',
  isActiveRow(['a', '2024-03-01', 0], 2, { activity: 'truthy' }) === false);
ok('isActiveRow treats the text false as inactive under truthy',
  isActiveRow(['a', '2024-03-01', 'false'], 2, { activity: 'truthy' }) === false);
ok('isActiveRow treats a real value as active under truthy',
  isActiveRow(['a', '2024-03-01', 'yes'], 2, { activity: 'truthy' }) === true);
// Under present the row existing IS the activity, so the cell is deliberately not
// consulted. A blank there is still an active day.
ok('isActiveRow counts any row as active under present',
  isActiveRow(['a', '2024-03-01', ''], 2, { activity: 'present' }) === true);

const runSql = buildConsecutiveRunSQL(runCfg, 'activity');
ok('the run SQL is produced', runSql.ok === true);
ok('the run SQL uses a row number', runSql.sql.includes('ROW_NUMBER()'));
ok('the run SQL groups by an island key', runSql.sql.includes('island_key'));
ok('the run SQL collapses duplicate days with DISTINCT',
  runSql.sql.includes('SELECT DISTINCT'));
ok('the run SQL explains why DISTINCT is there',
  runSql.sql.toLowerCase().includes('twice') || runSql.sql.toLowerCase().includes('duplicate')
  || runSql.sql.toLowerCase().includes('drift'));
ok('the run SQL partitions by the entity', runSql.sql.includes('PARTITION BY'));
ok('the run SQL carries plain comments', runSql.sql.includes('--'));
ok('the run transform ships its SQL', runs.sql.length > 0);

const emptyRuns = consecutiveRunTransform(ds('empty', [col('user', 'STR'), col('day', 'DATE')], []),
  Object.assign({}, runCfg));
ok('an empty table produces no runs and no crash', emptyRuns.ok === true && emptyRuns.rows.length === 0);
ok('an empty table still explains itself', emptyRuns.notes.length > 0);
ok('a missing table is refused', consecutiveRunTransform(null, runCfg).ok === false);

/* ==========================================================================
   A22 Moving average: warm-up rows and invented crossovers
   ========================================================================== */
console.log('\nA22 moving average');

const series = ds('series', [col('day', 'DATE'), col('value', 'FLOAT')], [
  ['2024-03-01', 1],
  ['2024-03-02', 2],
  ['2024-03-03', 3],
  ['2024-03-04', 10],
  ['2024-03-05', 10],
  ['2024-03-06', 10],
  ['2024-03-07', 10],
  ['2024-03-08', 1],
  ['2024-03-09', 1],
  ['2024-03-10', 1],
  ['2024-03-11', 1],
]);
const maCfg = Object.assign(createEmptyMovingAverageConfig(), {
  valueColumn: 'value', orderColumn: 'day', window: 2, secondWindow: 4, markCrossovers: true,
});

ok('the empty moving average config has a window', createEmptyMovingAverageConfig().window >= 1);
ok('the empty moving average config blanks the warm-up',
  createEmptyMovingAverageConfig().warmup === 'blank');
ok('both warm-up modes exist', WARMUP_MODES.length === 2);
ok('a long window has a warning threshold', LARGE_WINDOW_WARN > 1);
ok('the average column is named after its window', averageColumnName(maCfg, 7) === 'value_ma7');
ok('the crossover column has a fixed name', crossColumnName() === 'ma_cross');
ok('a second window means there is a crossover to look for', hasCrossover(maCfg) === true);
ok('no second window means no crossover',
  hasCrossover(Object.assign({}, maCfg, { secondWindow: 0 })) === false);

ok('a complete moving average config validates',
  validateMovingAverageConfig(maCfg, ['day', 'value']).ok === true);
ok('a moving average with no value column is refused',
  validateMovingAverageConfig(Object.assign({}, maCfg, { valueColumn: '' }), ['day', 'value']).ok === false);
ok('a moving average with no order column is refused',
  validateMovingAverageConfig(Object.assign({}, maCfg, { orderColumn: '' }), ['day', 'value']).ok === false);
ok('a window of zero is refused',
  validateMovingAverageConfig(Object.assign({}, maCfg, { window: 0 }), ['day', 'value']).ok === false);
ok('a fractional window is refused',
  validateMovingAverageConfig(Object.assign({}, maCfg, { window: 3.5 }), ['day', 'value']).ok === false);
// Two identical windows produce two identical averages, which can never cross,
// so a crossover column built from them would always be empty and look like
// "no signal" rather than like a configuration mistake.
ok('two equal windows are refused',
  validateMovingAverageConfig(Object.assign({}, maCfg, { window: 4, secondWindow: 4 }), ['day', 'value']).ok === false);
ok('the value column cannot also be the order column',
  validateMovingAverageConfig(Object.assign({}, maCfg, { orderColumn: 'value' }), ['day', 'value']).ok === false);
ok('a nonsense warm-up mode is refused',
  validateMovingAverageConfig(Object.assign({}, maCfg, { warmup: 'guess' }), ['day', 'value']).ok === false);
ok('no moving average configuration at all is refused',
  validateMovingAverageConfig(null, ['day']).ok === false);

const ma = movingAverageTransform(series, maCfg);
ok('the moving average runs', ma.ok === true);
ok('one output row per input row', ma.rows.length === series.rows.length);
ok('the short average column is present', names(ma).indexOf('value_ma2') !== -1);
ok('the long average column is present', names(ma).indexOf('value_ma4') !== -1);
ok('the window fill is reported per row', names(ma).indexOf('rows_in_window') !== -1);
ok('the crossover column is present', names(ma).indexOf('ma_cross') !== -1);
ok('the original value is kept', names(ma).indexOf('value') !== -1);

const ma2 = colOf(ma, 'value_ma2');
const ma4 = colOf(ma, 'value_ma4');
const fill = colOf(ma, 'rows_in_window');
// The first row has one value behind it, not two, so a two-row average of it is
// not a two-row average. Reporting 1.0 there is the silent lie this guards.
ok('the first row of a two-row average is blank, not the value itself', ma2[0] === null);
ok('the second row of a two-row average is the average of the first two', ma2[1] === 1.5);
ok('the fill count starts at one', fill[0] === 1);
// rows_in_window reports the primary window, so it tops out at 2 here and never
// at the second window's 4.
ok('the fill count reaches the window and stops', fill[fill.length - 1] === 2);
ok('the first three rows of a four-row average are blank',
  ma4[0] === null && ma4[1] === null && ma4[2] === null);
ok('the fourth row of a four-row average is the average of four', ma4[3] === 4);
ok('the warm-up rows are counted', ma.stats.warmupBlanks === 1);
ok('the warm-up is mentioned in the notes',
  ma.notes.join(' ').toLowerCase().includes('window'));

const crosses = colOf(ma, 'ma_cross');
const crossRows = ma.rows.filter((r) => valueAt(ma, r, 'ma_cross'));
// A cross needs both averages on this row AND on the previous row. Without the
// previous-row test, the first row where both exist looks like a crossing.
ok('no crossover is invented on the first row where both averages exist',
  crosses[3] === '' || crosses[3] == null);
ok('exactly one crossover is found in this series', crossRows.length === 1);
ok('the crossover is the downward one', valueAt(ma, crossRows[0], 'ma_cross') === 'down');
ok('the crossover lands where the series actually turns',
  valueAt(ma, crossRows[0], 'day') === '2024-03-08');
ok('the crossover count is reported', ma.stats.crossUp + ma.stats.crossDown === 1);
ok('the downward crossover count is reported', ma.stats.crossDown === 1);
ok('no upward crossover is claimed', ma.stats.crossUp === 0);

const maPartial = movingAverageTransform(series, Object.assign({}, maCfg, { warmup: 'partial' }));
ok('a partial warm-up fills the first row', colOf(maPartial, 'value_ma2')[0] === 1);
ok('a partial warm-up still reports how full the window was',
  colOf(maPartial, 'rows_in_window')[0] === 1);
ok('a partial warm-up says the early rows are not comparable',
  maPartial.notes.join(' ').toLowerCase().includes('fewer')
  || maPartial.notes.join(' ').toLowerCase().includes('partial')
  || maPartial.notes.join(' ').toLowerCase().includes('warm'));

const gappy = ds('gappy', [col('day', 'DATE'), col('value', 'FLOAT')], [
  ['2024-03-01', 1], ['2024-03-02', 2], ['2024-06-01', 3], ['2024-06-02', 4],
]);
const maGap = movingAverageTransform(gappy, Object.assign({}, maCfg, { secondWindow: 0, window: 2 }));
// A window of rows is not a window of days. Averaging across a three-month gap
// is arithmetic on two unrelated periods.
ok('a calendar gap inside the window is detected', maGap.stats.largestGapDays >= 80);
ok('the calendar gap is stated in the notes',
  maGap.notes.join(' ').toLowerCase().includes('gap'));

const grouped = ds('grouped', [col('site', 'STR'), col('day', 'DATE'), col('value', 'FLOAT')], [
  ['x', '2024-03-01', 1], ['x', '2024-03-02', 1],
  ['y', '2024-03-01', 100], ['y', '2024-03-02', 100],
]);
const maGrouped = movingAverageTransform(grouped, Object.assign({}, maCfg, {
  groupColumns: ['site'], window: 2, secondWindow: 0,
}));
const yFirst = maGrouped.rows.find((r) => r[0] === 'y');
ok('a group boundary restarts the window, so no average mixes two series',
  valueAt(maGrouped, yFirst, 'value_ma2') === null);
ok('the group count is reported', maGrouped.stats.series === 2);

const maSql = buildMovingAverageSQL(maCfg, 'series');
ok('the moving average SQL is produced', maSql.ok === true);
ok('the moving average SQL uses a row frame', maSql.sql.includes('ROWS BETWEEN'));
ok('the moving average SQL names the preceding rows', maSql.sql.includes('PRECEDING'));
ok('the moving average SQL counts the window to blank the warm-up',
  maSql.sql.includes('COUNT('));
ok('the moving average SQL explains the crossover as a LAG pair',
  maSql.sql.includes('LAG('));
ok('the moving average SQL carries plain comments', maSql.sql.includes('--'));
ok('the moving average description is a plain sentence',
  describeMovingAverage(ma).length > 20);
ok('a missing table is refused', movingAverageTransform(null, maCfg).ok === false);

/* ==========================================================================
   A23 Multi-value counts: the denominator that must not lie
   ========================================================================== */
console.log('\nA23 multi-value counts');

const tagged = ds('tagged', [col('patient', 'STR'), col('tags', 'STR')], [
  ['p1', 'Cardiology; Endocrinology'],
  ['p2', 'cardiology'],
  ['p3', ''],
  ['p4', 'asthma; asthma'],
  ['p5', 'Endocrinology;asthma'],
]);
const mvCfg = Object.assign(createEmptyMultiValueConfig(), {
  valueColumn: 'tags', source: 'auto', delimiter: ';', caseMode: 'fold', recordColumns: ['patient'],
});

ok('every value source is declared', VALUE_SOURCES.length === 3);
ok('both case modes exist', CASE_MODES.length === 2);
ok('there is a ceiling past which this is free text', TOO_MANY_DISTINCT > 100);
ok('the empty value is labelled rather than blank', NO_VALUE_LABEL.length > 0);
ok('the empty config folds case by default', createEmptyMultiValueConfig().caseMode === 'fold');
ok('the empty config keeps the records with no value',
  createEmptyMultiValueConfig().includeEmpty === true);

ok('a complete multi-value config validates',
  validateMultiValueConfig(mvCfg, ['patient', 'tags']).ok === true);
ok('a multi-value config with no column is refused',
  validateMultiValueConfig(Object.assign({}, mvCfg, { valueColumn: '' }), ['patient', 'tags']).ok === false);
ok('a column missing from the table is refused',
  validateMultiValueConfig(Object.assign({}, mvCfg, { valueColumn: 'ghost' }), ['patient', 'tags']).ok === false);
ok('a delimited source with no delimiter is refused',
  validateMultiValueConfig(Object.assign({}, mvCfg, { source: 'delimited', delimiter: '' }), ['patient', 'tags']).ok === false);
ok('the value column cannot also identify the record',
  validateMultiValueConfig(Object.assign({}, mvCfg, { recordColumns: ['tags'] }), ['patient', 'tags']).ok === false);
ok('a nonsense source is refused',
  validateMultiValueConfig(Object.assign({}, mvCfg, { source: 'magic' }), ['patient', 'tags']).ok === false);
ok('a zero minimum count is refused',
  validateMultiValueConfig(Object.assign({}, mvCfg, { minCount: 0 }), ['patient', 'tags']).ok === false);
ok('no multi-value configuration at all is refused', validateMultiValueConfig(null, []).ok === false);

const mv = multiValueCountsTransform(tagged, mvCfg);
ok('the multi-value count runs', mv.ok === true);
ok('the count table names the value column first', names(mv)[0] === 'tags');
ok('the count table reports records', names(mv).indexOf('records') !== -1);
ok('the count table reports mentions', names(mv).indexOf('mentions') !== -1);
// Both percentages, both labelled, is the whole point: either one alone gets
// read as the other, and a reader who rescales 180% to 100% draws a wrong
// conclusion from a correct number.
ok('the count table reports the share of records',
  names(mv).indexOf('pct_of_records') !== -1);
ok('the count table reports the share of mentions',
  names(mv).indexOf('pct_of_mentions') !== -1);

const cardiology = rowWhere(mv, 'tags', 'Cardiology');
ok('a folded value merges two spellings', valueAt(mv, cardiology, 'records') === 2);
const asthma = rowWhere(mv, 'tags', 'asthma');
// "asthma; asthma" is one patient with asthma, not two.
ok('a repeated value in one cell counts the record once',
  valueAt(mv, asthma, 'records') === 2);
ok('a repeated value in one cell still counts both mentions',
  valueAt(mv, asthma, 'mentions') === 3);
ok('the duplicate mentions are counted', mv.stats.duplicateMentions === 1);
ok('the duplicate mentions are explained',
  mv.notes.join(' ').toLowerCase().includes('twice')
  || mv.notes.join(' ').toLowerCase().includes('repeat'));

const recordPct = mv.rows.filter((r) => r[0] !== NO_VALUE_LABEL)
  .reduce((a, r) => a + valueAt(mv, r, 'pct_of_records'), 0);
const mentionPct = mv.rows.filter((r) => r[0] !== NO_VALUE_LABEL)
  .reduce((a, r) => a + valueAt(mv, r, 'pct_of_mentions'), 0);
ok('the record shares sum to more than 100 when records hold several values',
  recordPct > 100);
ok('the mention shares sum to about 100', Math.abs(mentionPct - 100) < 0.5);
ok('the record share sum is stated out loud rather than left to be discovered',
  mv.notes.join(' ').includes('%'));
ok('the notes name the actual sum', mv.notes.join(' ').includes(String(mv.stats.recordPctSum)));
ok('the notes say the sum above 100 is correct and not a fault',
  mv.notes.join(' ').toLowerCase().includes('correct'));
ok('the transform reports that the values are not exclusive', mv.stats.exclusive === false);
ok('the multi-value records are counted', mv.stats.multiValueRecords === 2);
ok('the largest number of values in one record is reported', mv.stats.maxPerRecord === 2);
ok('the description leads with the double count',
  describeMultiValueCounts(mv).includes('%'));

const noValueRow = rowWhere(mv, 'tags', NO_VALUE_LABEL);
ok('a record with no values gets its own labelled row', !!noValueRow);
ok('the record with no values is counted', valueAt(mv, noValueRow, 'records') === 1);
// Dropping it would raise every percentage in the table.
ok('the record with no values stays in the denominator', mv.stats.records === 5);
ok('the empty records are explained',
  mv.notes.join(' ').toLowerCase().includes('denominator'));

const mvNoEmpty = multiValueCountsTransform(tagged, Object.assign({}, mvCfg, { includeEmpty: false }));
ok('hiding the empty row removes it from the table',
  !rowWhere(mvNoEmpty, 'tags', NO_VALUE_LABEL));
ok('hiding the empty row does not remove it from the denominator',
  mvNoEmpty.stats.records === 5);
ok('hiding the empty row says the denominator is unchanged',
  mvNoEmpty.notes.join(' ').toLowerCase().includes('denominator'));

const mvExclusive = multiValueCountsTransform(
  ds('single', [col('id', 'STR'), col('tags', 'STR')], [['a', 'x'], ['b', 'y']]),
  Object.assign({}, mvCfg, { recordColumns: ['id'] }));
ok('a column that never splits is reported as exclusive', mvExclusive.stats.exclusive === true);
ok('an exclusive column says so plainly',
  mvExclusive.notes.join(' ').toLowerCase().includes('ordinary')
  || mvExclusive.notes.join(' ').toLowerCase().includes('exactly one'));
ok('an exclusive column still warns that this stops being true',
  mvExclusive.notes.join(' ').toLowerCase().includes('stops being true')
  || mvExclusive.notes.join(' ').toLowerCase().includes('moment'));

const mvTop = multiValueCountsTransform(tagged, Object.assign({}, mvCfg, { topN: 1 }));
ok('a top-N limit shortens the table',
  mvTop.rows.filter((r) => r[0] !== NO_VALUE_LABEL).length === 1);
ok('the values left out are counted', mvTop.stats.hidden >= 2);
ok('the values left out are mentioned',
  mvTop.notes.join(' ').toLowerCase().includes('not shown'));
ok('the percentages are still over everything, not over what is visible',
  mvTop.notes.join(' ').toLowerCase().includes('will not add up')
  || mvTop.notes.join(' ').toLowerCase().includes('everything'));

const mvJson = multiValueCountsTransform(
  ds('j', [col('id', 'STR'), col('tags', 'STR')], [['a', '["email","sms"]'], ['b', '["email"]']]),
  Object.assign({}, mvCfg, { recordColumns: ['id'], source: 'auto', delimiter: ',' }));
ok('a JSON array cell is split', mvJson.rows.length >= 2);
ok('a JSON array value is counted per record',
  valueAt(mvJson, rowWhere(mvJson, 'tags', 'email'), 'records') === 2);

const mvSql = buildMultiValueCountsSQL(mvCfg, 'tagged');
ok('the multi-value SQL is produced', mvSql.ok === true);
ok('the multi-value SQL unnests the list', mvSql.sql.includes('UNNEST('));
ok('the multi-value SQL counts distinct records, not rows',
  mvSql.sql.includes('COUNT(DISTINCT record_key)'));
ok('the multi-value SQL counts mentions separately', mvSql.sql.includes('AS mentions'));
ok('the multi-value SQL shows both denominators', mvSql.sql.split('SELECT COUNT(*)').length > 1
  || mvSql.sql.includes('SUM(mentions)'));
ok('the multi-value SQL names the unnest alias so it cannot collide with a table',
  mvSql.sql.includes('dg_values(item)'));
ok('the multi-value SQL explains the two percentages',
  mvSql.sql.includes('pct_of_records') && mvSql.sql.includes('pct_of_mentions'));
ok('the multi-value SQL warns about reading one as the other',
  mvSql.sql.toLowerCase().includes('mistake'));
ok('the multi-value SQL keeps the empty records in the denominator explicitly',
  mvSql.sql.toLowerCase().includes('denominator'));
ok('a JSON source uses the JSON extractor',
  buildMultiValueCountsSQL(Object.assign({}, mvCfg, { source: 'json' }), 't').sql.includes('json_extract_string'));
ok('a delimiter with a quote in it is escaped',
  buildMultiValueCountsSQL(Object.assign({}, mvCfg, { source: 'delimited', delimiter: "'" }), 't').sql.includes("''"));

const mvEmptyTable = multiValueCountsTransform(
  ds('none', [col('id', 'STR'), col('tags', 'STR')], []), Object.assign({}, mvCfg, { recordColumns: ['id'] }));
ok('an empty table counts nothing and does not crash', mvEmptyTable.ok === true);
ok('an empty table says there is nothing to count',
  mvEmptyTable.notes.join(' ').toLowerCase().includes('no rows'));
ok('a missing table is refused', multiValueCountsTransform(null, mvCfg).ok === false);

/* ==========================================================================
   A28 Frequent combinations: popularity is not association
   ========================================================================== */
console.log('\nA28 frequent combinations');

const basket = ds('basket', [col('order', 'STR'), col('items', 'STR')], [
  ['o1', 'bread,butter'],
  ['o2', 'bread,butter'],
  ['o3', 'bread,jam'],
  ['o4', 'bread'],
  ['o5', 'caviar,truffle'],
  ['o6', ''],
  ['o7', 'bread,butter,jam'],
]);
const comboCfg = Object.assign(createEmptyCombinationsConfig(), {
  source: 'multivalue', valueColumn: 'items', delimiter: ',', minSupport: 1, topN: 10,
});

ok('both combination sources are declared', COMBO_SOURCES.length === 2);
ok('there is a threshold below which a lift is noise', THIN_SUPPORT > 1);
ok('there is a ceiling on values per record', MAX_ITEMS_PER_RECORD > 1);
ok('the empty combinations config asks for at least two records',
  createEmptyCombinationsConfig().minSupport === 2);
ok('the empty combinations config labels values with their column',
  createEmptyCombinationsConfig().labelWithColumn === true);

ok('a complete combinations config validates',
  validateCombinationsConfig(comboCfg, ['order', 'items']).ok === true);
ok('a multi-value combination with no column is refused',
  validateCombinationsConfig(Object.assign({}, comboCfg, { valueColumn: '' }), ['order', 'items']).ok === false);
ok('a column combination needs two columns',
  validateCombinationsConfig({ source: 'columns', itemColumns: ['a'] }, ['a', 'b']).ok === false);
ok('a column combination with two columns validates',
  validateCombinationsConfig({ source: 'columns', itemColumns: ['a', 'b'] }, ['a', 'b']).ok === true);
ok('a missing column is refused',
  validateCombinationsConfig({ source: 'columns', itemColumns: ['a', 'ghost'] }, ['a', 'b']).ok === false);
ok('a nonsense source is refused',
  validateCombinationsConfig(Object.assign({}, comboCfg, { source: 'guess' }), ['order', 'items']).ok === false);
ok('a zero minimum support is refused',
  validateCombinationsConfig(Object.assign({}, comboCfg, { minSupport: 0 }), ['order', 'items']).ok === false);
ok('no combinations configuration at all is refused', validateCombinationsConfig(null, []).ok === false);

const combos = frequentCombinationsTransform(basket, comboCfg);
ok('the combinations transform runs', combos.ok === true);
ok('the combination table names both items',
  names(combos)[0] === 'item_a' && names(combos)[1] === 'item_b');
ok('the combination table reports the support count',
  names(combos).indexOf('records') !== -1);
// The marginals sit next to every pair because a big pair count is usually just
// two common values, and ranking by count alone ranks popularity.
ok('the combination table reports how common the first value is on its own',
  names(combos).indexOf('count_a') !== -1);
ok('the combination table reports how common the second value is on its own',
  names(combos).indexOf('count_b') !== -1);
ok('the combination table reports a lift', names(combos).indexOf('lift') !== -1);

const breadButter = combos.rows.find((r) => r[0] === 'bread' && r[1] === 'butter');
ok('the common pair is found', !!breadButter);
ok('the common pair is counted once per record',
  valueAt(combos, breadButter, 'records') === 3);
ok('the marginal count of the first value is larger than the pair count',
  valueAt(combos, breadButter, 'count_a') === 5);
ok('the marginal count of the second value is reported',
  valueAt(combos, breadButter, 'count_b') === 3);
ok('a common pair has a modest lift', valueAt(combos, breadButter, 'lift') < 2);
const caviar = combos.rows.find((r) => r[0] === 'caviar' && r[1] === 'truffle');
ok('a rare but exclusive pair has a high lift',
  valueAt(combos, caviar, 'lift') > valueAt(combos, breadButter, 'lift'));
ok('a rare pair still has a small support count',
  valueAt(combos, caviar, 'records') === 1);
ok('pairs resting on almost no records are counted', combos.stats.thinSupport >= 1);
ok('pairs resting on almost no records are flagged in the notes',
  combos.notes.join(' ').toLowerCase().includes('hint')
  || combos.notes.join(' ').toLowerCase().includes('wildly'));
ok('the notes explain that a big count can be two big values',
  combos.notes.join(' ').toLowerCase().includes('association'));

// (bread, butter) and (butter, bread) are the same pair. Emitting both would
// double every count.
const mirrored = combos.rows.filter((r) => r[0] === 'butter' && r[1] === 'bread');
ok('the mirror image of a pair is never emitted', mirrored.length === 0);
ok('no value is paired with itself',
  combos.rows.every((r) => r[0] !== r[1]));
ok('the pairs are ordered within themselves',
  combos.rows.every((r) => String(r[0]).toLowerCase() <= String(r[1]).toLowerCase()));

ok('a record with one value forms no pair', combos.stats.singleItemRecords === 1);
ok('a record with one value still counts towards the marginals',
  valueAt(combos, breadButter, 'count_a') > valueAt(combos, breadButter, 'records'));
ok('the single-value records are explained',
  combos.notes.join(' ').toLowerCase().includes('one value'));
ok('a record with no values is counted', combos.stats.noItemRecords === 1);
ok('a record with no values stays in the denominator', combos.stats.records === 7);
ok('the pairing records are counted', combos.stats.pairedRecords === 5);
ok('the largest number of values in one record is reported',
  combos.stats.maxItemsPerRecord === 3);
ok('the combinations description is a plain sentence',
  describeFrequentCombinations(combos).length > 20);

const churn = ds('churn', [col('status', 'STR'), col('plan', 'STR')], [
  ['active', 'pro'], ['active', 'pro'], ['active', 'free'], ['churned', 'free'], ['churned', ''],
]);
const colCfg = { source: 'columns', itemColumns: ['status', 'plan'], caseMode: 'fold', labelWithColumn: true, minSupport: 1, topN: 10 };
const colCombos = frequentCombinationsTransform(churn, colCfg);
ok('a column combination runs', colCombos.ok === true);
// "active" in status and "active" in a subscription column are different facts.
ok('values are tagged with the column they came from',
  colCombos.rows.every((r) => String(r[0]).includes('=') && String(r[1]).includes('=')));
ok('a column pair is counted',
  valueAt(colCombos, colCombos.rows.find((r) => r[0] === 'plan=pro'), 'records') === 2);
const unlabelled = frequentCombinationsTransform(churn,
  Object.assign({}, colCfg, { labelWithColumn: false }));
ok('the column tag can be turned off',
  unlabelled.rows.every((r) => !String(r[0]).includes('=')));
ok('a blank cell contributes no item', colCombos.stats.singleItemRecords === 1);

const items = itemsOfRow(['active', 'pro'], colCfg,
  { itemNames: ['status', 'plan'], itemIdxs: [0, 1], valueIdx: -1 });
ok('a row contributes one item per filled column', items.length === 2);
ok('the item carries its column name', items[0].label === 'status=active');
ok('the item key is folded', items[0].key === 'status=active');
const dupItems = itemsOfRow(['x', 'x'], Object.assign({}, colCfg, { labelWithColumn: false }),
  { itemNames: ['status', 'plan'], itemIdxs: [0, 1], valueIdx: -1 });
ok('the same value in two columns is one item when the tag is off', dupItems.length === 1);

const comboMin = frequentCombinationsTransform(basket, Object.assign({}, comboCfg, { minSupport: 3 }));
ok('a minimum support hides the rare pairs', comboMin.rows.length === 1);
ok('the hidden pairs are counted', comboMin.stats.hidden >= 3);
ok('the hidden pairs are mentioned',
  comboMin.notes.join(' ').toLowerCase().includes('not shown'));

const comboSql = buildCombinationsSQL(comboCfg, 'basket');
ok('the combinations SQL is produced', comboSql.ok === true);
ok('the combinations SQL self joins on the record', comboSql.sql.includes('a.record_key = b.record_key'));
ok('the combinations SQL uses the inequality to make the pair unordered',
  comboSql.sql.includes('a.item < b.item'));
ok('the combinations SQL explains the inequality',
  comboSql.sql.toLowerCase().includes('mirror'));
ok('the combinations SQL joins the marginals back in',
  comboSql.sql.includes('marginals'));
ok('the combinations SQL shows the lift as a division',
  comboSql.sql.includes('NULLIF(') && comboSql.sql.includes('lift'));
ok('the combinations SQL carries plain comments', comboSql.sql.includes('--'));
const colSql = buildCombinationsSQL(colCfg, 'churn');
ok('a column combination SQL unions the columns', colSql.sql.includes('UNION ALL'));
ok('a column combination SQL tags the value with the column name',
  colSql.sql.includes("'status='"));
ok('a multi-value combination SQL unnests', comboSql.sql.includes('UNNEST('));
ok('a multi-value combination SQL deduplicates per record',
  comboSql.sql.includes('SELECT DISTINCT'));

const comboNone = frequentCombinationsTransform(
  ds('n', [col('id', 'STR'), col('items', 'STR')], [['a', 'x'], ['b', 'y']]),
  Object.assign({}, comboCfg, { minSupport: 1 }));
ok('a column that never combines produces no pairs', comboNone.rows.length === 0);
ok('a column that never combines says why',
  comboNone.notes.join(' ').toLowerCase().includes('two values at once'));
ok('a missing table is refused', frequentCombinationsTransform(null, comboCfg).ok === false);

/* ==========================================================================
   A30 Return within a window: the censored tail is the whole argument
   ========================================================================== */
console.log('\nA30 return within a window');

const admissions = ds('admissions',
  [col('patient', 'STR'), col('admit', 'DATE'), col('ward', 'STR')], [
    ['p1', '2024-01-01', 'A'],
    ['p1', '2024-01-10', 'B'],
    ['p1', '2024-01-15', 'A'],
    ['p2', '2024-01-05', 'A'],
    ['p2', '2024-03-20', 'B'],
    ['p3', '2024-01-07', 'C'],
    ['p4', '2024-03-25', 'A'],
    ['p4', '2024-03-25', 'A'],
    ['p5', 'not a date', 'A'],
  ]);
const recCfg = Object.assign(createEmptyRecurrenceConfig(), {
  entityColumns: ['patient'], dateColumn: 'admit', windowDays: 30, minGapDays: 1,
  carryColumns: ['ward'],
});

ok('the default window is 30 days', DEFAULT_WINDOW_DAYS === 30);
ok('every index scope is declared', INDEX_SCOPES.length === 3);
ok('the empty recurrence config excludes the same day by default',
  createEmptyRecurrenceConfig().minGapDays === 1);
ok('the empty recurrence config excludes the censored tail by default',
  createEmptyRecurrenceConfig().excludeCensored === true);

ok('a complete recurrence config validates',
  validateRecurrenceConfig(recCfg, ['patient', 'admit', 'ward']).ok === true);
ok('a recurrence config with no entity is refused',
  validateRecurrenceConfig(Object.assign({}, recCfg, { entityColumns: [] }), ['patient', 'admit']).ok === false);
ok('a recurrence config with no date is refused',
  validateRecurrenceConfig(Object.assign({}, recCfg, { dateColumn: '' }), ['patient', 'admit']).ok === false);
ok('the date column cannot also be the entity',
  validateRecurrenceConfig(Object.assign({}, recCfg, { entityColumns: ['admit'] }), ['patient', 'admit']).ok === false);
ok('a zero window is refused',
  validateRecurrenceConfig(Object.assign({}, recCfg, { windowDays: 0 }), ['patient', 'admit', 'ward']).ok === false);
ok('a fractional window is refused',
  validateRecurrenceConfig(Object.assign({}, recCfg, { windowDays: 1.5 }), ['patient', 'admit', 'ward']).ok === false);
ok('a negative minimum gap is refused',
  validateRecurrenceConfig(Object.assign({}, recCfg, { minGapDays: -1 }), ['patient', 'admit', 'ward']).ok === false);
// A gap larger than the window means no return could ever be inside both bounds,
// so the table would always be empty and read as "nobody returns".
ok('a minimum gap larger than the window is refused',
  validateRecurrenceConfig(Object.assign({}, recCfg, { minGapDays: 40 }), ['patient', 'admit', 'ward']).ok === false);
ok('an unreadable observation end is refused',
  validateRecurrenceConfig(Object.assign({}, recCfg, { observationEnd: 'later' }), ['patient', 'admit', 'ward']).ok === false);
ok('a nonsense index scope is refused',
  validateRecurrenceConfig(Object.assign({}, recCfg, { indexScope: 'some' }), ['patient', 'admit', 'ward']).ok === false);
ok('a carried column missing from the table is refused',
  validateRecurrenceConfig(Object.assign({}, recCfg, { carryColumns: ['ghost'] }), ['patient', 'admit', 'ward']).ok === false);
ok('no recurrence configuration at all is refused', validateRecurrenceConfig(null, []).ok === false);

const rec = windowRecurrenceTransform(admissions, recCfg);
ok('the recurrence transform runs', rec.ok === true);
ok('the pair table names the entity first', names(rec)[0] === 'patient');
ok('the pair table names the index event', names(rec).indexOf('index_date') !== -1);
ok('the pair table names the return event', names(rec).indexOf('return_date') !== -1);
ok('the pair table reports the gap', names(rec).indexOf('days_to_return') !== -1);
ok('the pair table flags the censored tail',
  names(rec).indexOf('within_censored_tail') !== -1);
ok('a carried column comes along', names(rec).indexOf('ward') !== -1);

// Events on day 1, 10 and 15 are two pairs, not three. Counting every
// combination inflates the count quadratically.
ok('an entity with three events gives two pairs and not three',
  rec.rows.filter((r) => r[0] === 'p1').length === 2);
const firstPair = rec.rows.find((r) => valueAt(rec, r, 'index_date') === '2024-01-01');
ok('the pair points at the very next event',
  valueAt(rec, firstPair, 'return_date') === '2024-01-10');
ok('the gap is counted in whole days', valueAt(rec, firstPair, 'days_to_return') === 9);
ok('the carried value comes from the index event',
  valueAt(rec, firstPair, 'ward') === 'A');
ok('a return outside the window is not a pair',
  !rec.rows.find((r) => r[0] === 'p2'));
ok('the events beyond the window are counted', rec.stats.beyondWindow === 1);
ok('the events beyond the window are mentioned',
  rec.notes.join(' ').toLowerCase().includes('later than'));

// Two events on the same date is duplicate data far more often than it is a
// genuine same-day return.
ok('two events on the same date are not a return',
  !rec.rows.find((r) => r[0] === 'p4'));
ok('the same-day pairs are counted', rec.stats.sameDayPairs === 1);
ok('the same-day pairs are explained',
  rec.notes.join(' ').toLowerCase().includes('share a date'));
const recZeroGap = windowRecurrenceTransform(admissions, Object.assign({}, recCfg, { minGapDays: 0 }));
ok('a zero minimum gap lets a same-day return count',
  !!recZeroGap.rows.find((r) => r[0] === 'p4'));

// The heart of it: an event in the last 30 days has not had 30 days to recur.
ok('the events too recent to have had the window are counted',
  rec.stats.censoredIndexEvents === 3);
ok('the eligible events exclude them',
  rec.stats.eligibleIndexEvents + rec.stats.censoredIndexEvents === rec.stats.indexEvents);
ok('the honest rate uses the eligible denominator', rec.stats.rateEligible === 40);
ok('the naive rate over every event is lower', rec.stats.rateAll < rec.stats.rateEligible);
ok('both rates are reported so the gap is visible',
  rec.notes.join(' ').includes(String(rec.stats.rateEligible))
  && rec.notes.join(' ').includes(String(rec.stats.rateAll)));
ok('the last date in the data is stated', rec.stats.observationEnd === '2024-03-25');
ok('the censoring is explained rather than applied silently',
  rec.notes.join(' ').toLowerCase().includes('long enough'));
ok('the notes say the two rates answer different questions',
  rec.notes.join(' ').toLowerCase().includes('not a correction'));
ok('the description names the denominator alongside the rate',
  describeWindowRecurrence(rec).toLowerCase().includes('long enough'));
ok('the description gives the naive rate too',
  describeWindowRecurrence(rec).includes(String(rec.stats.rateAll)));

const recDeclared = windowRecurrenceTransform(admissions,
  Object.assign({}, recCfg, { observationEnd: '2024-06-30' }));
ok('a declared observation end is used instead of the last row',
  recDeclared.stats.observationEnd === '2024-06-30');
ok('a declared observation end is recorded as declared',
  recDeclared.stats.observationEndDeclared === true);
// With a later cut-off, nothing sits in the censored tail any more.
ok('a later observation end leaves nothing censored',
  recDeclared.stats.censoredIndexEvents === 0);
ok('with nothing censored the two rates agree',
  recDeclared.stats.rateEligible === recDeclared.stats.rateAll);
ok('an undeclared end says the export may simply have stopped',
  rec.notes.join(' ').toLowerCase().includes('export'));

ok('an entity with one event cannot return', rec.stats.singleEventEntities === 1);
ok('the single-event entities stay in the denominator',
  rec.notes.join(' ').toLowerCase().includes('never came back'));
ok('an unreadable date is dropped and counted', rec.stats.unreadableDates === 1);
ok('the dropped rows are called a floor rather than an exact figure',
  rec.notes.join(' ').toLowerCase().includes('floor'));
ok('the average gap is reported', rec.stats.averageDays === 7);
ok('the entities are counted', rec.stats.entities === 4);
ok('the pairs come back in date order',
  rec.rows.every((r, i) => i === 0
    || valueAt(rec, rec.rows[i - 1], 'index_date') <= valueAt(rec, r, 'index_date')));

const recFirst = windowRecurrenceTransform(admissions,
  Object.assign({}, recCfg, { indexScope: 'first' }));
ok('only the first event per entity starts a window',
  recFirst.rows.filter((r) => r[0] === 'p1').length === 1);
ok('the first-only scope is a rate per entity and says so',
  recFirst.notes.join(' ').toLowerCase().includes('per entity'));
ok('the first-only scope warns the two rates are not comparable',
  recFirst.notes.join(' ').toLowerCase().includes('not comparable'));
const recLast = windowRecurrenceTransform(admissions,
  Object.assign({}, recCfg, { indexScope: 'last' }));
ok('the most recent event alone finds no return, because nothing follows it',
  recLast.rows.length === 0);

const recSql = buildRecurrenceSQL(recCfg, 'admissions');
ok('the recurrence SQL is produced', recSql.ok === true);
ok('the recurrence SQL uses LEAD for the next event', recSql.sql.includes('LEAD('));
ok('the recurrence SQL partitions by the entity', recSql.sql.includes('PARTITION BY'));
ok('the recurrence SQL bounds the gap on both sides', recSql.sql.includes('BETWEEN 1 AND 30'));
ok('the recurrence SQL marks the censored tail as its own visible predicate',
  recSql.sql.includes('AS censored'));
ok('the recurrence SQL explains why the tail is censored',
  recSql.sql.toLowerCase().includes('has not had'));
ok('the recurrence SQL shows both rates', recSql.sql.includes('eligible_events')
  && recSql.sql.includes('all_events'));
ok('the recurrence SQL explains the next-event rule',
  recSql.sql.toLowerCase().includes('at most one return'));
ok('the recurrence SQL carries plain comments', recSql.sql.includes('--'));
ok('the recurrence SQL narrows to the first event when asked',
  buildRecurrenceSQL(Object.assign({}, recCfg, { indexScope: 'first' }), 't').sql.includes('MIN('));

const recEmpty = windowRecurrenceTransform(
  ds('none', [col('patient', 'STR'), col('admit', 'DATE')], []),
  Object.assign({}, recCfg, { carryColumns: [] }));
ok('an empty table measures nothing and does not crash', recEmpty.ok === true);
ok('an empty table says no date could be read',
  recEmpty.notes.join(' ').toLowerCase().includes('readable date'));
ok('a missing table is refused', windowRecurrenceTransform(null, recCfg).ok === false);

/* ==========================================================================
   Value standardizer: nothing is applied without confirmation
   ========================================================================== */
console.log('\nvalue standardizer');

const people = ds('people', [col('id', 'STR'), col('state', 'STR')], [
  ['1', 'California'],
  ['2', 'california'],
  ['3', ' California '],
  ['4', 'CA'],
  ['5', 'Texas'],
  ['6', 'TEXAS'],
  ['7', ''],
]);
const stdCfg = Object.assign(createEmptyStandardizerConfig(), {
  valueColumn: 'state', matchModes: ['case', 'whitespace'],
});

ok('every match mode is declared', MATCH_MODES.length === 3);
ok('there is a share above which a column is an identifier',
  IDENTIFIER_DISTINCT_SHARE > 0.5 && IDENTIFIER_DISTINCT_SHARE <= 1);
ok('there is a count above which a map cannot be reviewed', TOO_MANY_TO_REVIEW > 10);
ok('the empty standardizer config is not confirmed',
  createEmptyStandardizerConfig().confirmed === false);
ok('the empty standardizer config keeps an audit trail',
  createEmptyStandardizerConfig().keepAudit === true);
ok('the empty standardizer config has no merges yet',
  Object.keys(createEmptyStandardizerConfig().map).length === 0);
ok('the audit column is named after the value column',
  auditColumnName(stdCfg) === 'state_original');
ok('the audit column name can be chosen',
  auditColumnName({ valueColumn: 'state', auditColumn: 'was' }) === 'was');

const found = distinctValuesOf(people, 'state');
ok('the distinct values are listed', found.values.length === 6);
ok('the distinct values carry their counts',
  found.values.every((v) => typeof v.count === 'number' && v.count >= 1));
ok('the blanks are counted separately', found.blanks === 1);
ok('the row count is reported', found.rows === 7);
ok('a missing column lists nothing', distinctValuesOf(people, 'ghost').values.length === 0);

ok('folding case makes two spellings one key',
  normalizeKey('California', stdCfg) === normalizeKey('california', stdCfg));
ok('collapsing whitespace makes two spellings one key',
  normalizeKey(' California ', stdCfg) === normalizeKey('California', stdCfg));
ok('two different values keep different keys',
  normalizeKey('Texas', stdCfg) !== normalizeKey('California', stdCfg));
ok('punctuation is only ignored when asked',
  normalizeKey('U.S.A', stdCfg) !== normalizeKey('USA', stdCfg));
ok('punctuation can be ignored',
  normalizeKey('U.S.A', { matchModes: ['punctuation', 'whitespace', 'case'] })
  === normalizeKey('U S A', { matchModes: ['punctuation', 'whitespace', 'case'] }));
ok('with no modes a value is only itself',
  normalizeKey('California', { matchModes: [] }) !== normalizeKey('california', { matchModes: [] }));

const proposal = proposeMergeGroups(people, stdCfg, {});
ok('the proposal finds the groups', proposal.groups.length === 2);
ok('the proposal is only a proposal and carries no map',
  proposal.map === undefined);
// Standardising onto " California " would write the stray whitespace into every
// row, however common that spelling happened to be.
ok('the canonical spelling is the tidy one', proposal.groups[0].canonical === 'California');
ok('the group lists every member', proposal.groups[0].members.length === 3);
ok('the group sums the counts of its members', proposal.groups[0].totalCount === 3);
ok('a deterministic group is marked certain', proposal.groups[0].certain === true);
ok('a deterministic group says what makes it certain',
  proposal.groups[0].reason.toLowerCase().includes('same value'));
ok('a value matching nothing is left out of every group', proposal.ungrouped === 1);
ok('the distinct count is reported', proposal.distinct === 6);
ok('the blanks are reported', proposal.blanks === 1);
ok('the second group is found', proposal.groups[1].canonical === 'Texas');
ok('an all-caps spelling is not chosen as canonical',
  proposal.groups[1].canonical !== 'TEXAS');

const identifiers = ds('ids', [col('code', 'STR')],
  Array.from({ length: 40 }, (_, i) => ['code-' + i]));
const idProposal = proposeMergeGroups(identifiers, { valueColumn: 'code', matchModes: ['case'] }, {});
ok('a column of near-unique values is called out as an identifier',
  idProposal.warnings.join(' ').toLowerCase().includes('identifier'));
ok('merging identifiers is described as breaking joins',
  idProposal.warnings.join(' ').toLowerCase().includes('join'));

const sensitiveProposal = proposeMergeGroups(people, stdCfg, { isSensitive: () => true });
ok('a sensitive category is called out',
  sensitiveProposal.warnings.join(' ').toLowerCase().includes('sensitive'));
ok('a sensitive category is told it needs a reason and not a score',
  sensitiveProposal.warnings.join(' ').toLowerCase().includes('reason'));

// The clusterer only ever sees the values the deterministic passes left alone, so
// this fixture carries two abbreviations that no case or whitespace rule can join.
const abbreviated = ds('abbreviated', [col('id', 'STR'), col('state', 'STR')], [
  ['1', 'California'],
  ['2', 'california'],
  ['3', 'CA'],
  ['4', 'Calif.'],
]);
const fuzzyProposal = proposeMergeGroups(abbreviated, Object.assign({}, stdCfg, { fuzzy: true }), {
  clusterer: (values) => [values.filter((v) => v.value === 'CA' || v.value === 'Calif.')],
});
const guess = fuzzyProposal.groups.find((g) => g.certain === false);
ok('an injected clusterer can add a group', !!guess);
ok('a fuzzy group is marked as a guess', guess.certain === false);
ok('a fuzzy group says it is a guess in words',
  guess.reason.toLowerCase().includes('guess'));
ok('a fuzzy pass warns that similarity is not a fact',
  fuzzyProposal.warnings.join(' ').toLowerCase().includes('similarity'));
ok('without a clusterer no fuzzy group appears',
  proposeMergeGroups(people, Object.assign({}, stdCfg, { fuzzy: true }), {})
    .groups.every((g) => g.certain === true));
const brokenFuzzy = proposeMergeGroups(people, Object.assign({}, stdCfg, { fuzzy: true }),
  { clusterer: () => { throw new Error('nope'); } });
ok('a failing clusterer does not take the proposal down',
  brokenFuzzy.groups.length === 2);
ok('a failing clusterer is reported',
  brokenFuzzy.warnings.join(' ').toLowerCase().includes('failed'));

const map = mapFromGroups(proposal.groups);
ok('the map points every member at its canonical', map.california === 'California');
ok('the map includes the untidy spelling', map[' California '] === 'California');
ok('the map does not point the canonical at itself', map.California === undefined);
ok('the map covers the second group', map.TEXAS === 'Texas');
ok('an empty group list gives an empty map', Object.keys(mapFromGroups([])).length === 0);
ok('a nonsense group list gives an empty map', Object.keys(mapFromGroups(null)).length === 0);

// The confirm gate. This is the acceptance criterion, not a nicety: a wrong
// merge is invisible afterwards because the evidence got overwritten.
const unconfirmed = valueStandardizerTransform(people, Object.assign({}, stdCfg, { map: map }));
ok('an unconfirmed merge is refused outright', unconfirmed.ok === false);
ok('the refusal says confirmation is what is missing',
  String(unconfirmed.error).toLowerCase().includes('confirm'));
ok('an empty map is refused even when confirmed',
  validateStandardizerConfig(Object.assign({}, stdCfg, { map: {}, confirmed: true }),
    ['id', 'state']).ok === false);
ok('a confirmed map with merges validates',
  validateStandardizerConfig(Object.assign({}, stdCfg, { map: map, confirmed: true }),
    ['id', 'state']).ok === true);
ok('a value mapped to itself is refused',
  validateStandardizerConfig(Object.assign({}, stdCfg, { map: { a: 'a' }, confirmed: true }),
    ['id', 'state']).ok === false);
ok('a value mapped to nothing is refused',
  validateStandardizerConfig(Object.assign({}, stdCfg, { map: { a: '' }, confirmed: true }),
    ['id', 'state']).ok === false);
// a -> b and b -> c gives a different table depending on which ran first.
const chain = validateStandardizerConfig(
  Object.assign({}, stdCfg, { map: { a: 'b', b: 'c' }, confirmed: true }), ['id', 'state']);
ok('a chained replacement is refused', chain.ok === false);
ok('the refusal explains that order would decide the answer',
  chain.errors.join(' ').toLowerCase().includes('order'));
ok('an audit column that already exists is refused',
  validateStandardizerConfig(Object.assign({}, stdCfg,
    { map: map, confirmed: true, auditColumn: 'id' }), ['id', 'state']).ok === false);
ok('a missing value column is refused',
  validateStandardizerConfig(Object.assign({}, stdCfg,
    { valueColumn: 'ghost', map: map, confirmed: true }), ['id', 'state']).ok === false);
ok('a nonsense match mode is refused',
  validateStandardizerConfig(Object.assign({}, stdCfg,
    { matchModes: ['vibes'], map: map, confirmed: true }), ['id', 'state']).ok === false);
ok('no standardizer configuration at all is refused',
  validateStandardizerConfig(null, ['id']).ok === false);

const confirmedMap = Object.assign({}, map, { CA: 'California' });
const std = valueStandardizerTransform(people,
  Object.assign({}, stdCfg, { map: confirmedMap, confirmed: true }));
ok('a confirmed merge runs', std.ok === true);
ok('the table keeps its own columns', names(std).indexOf('id') !== -1);
ok('the audit column is added', names(std).indexOf('state_original') !== -1);
// Merging relabels, it never drops.
ok('no row is added or removed', std.rows.length === people.rows.length);
ok('the merged value is written', valueAt(std, std.rows[1], 'state') === 'California');
ok('the original value is kept', valueAt(std, std.rows[1], 'state_original') === 'california');
ok('the untidy spelling is merged too', valueAt(std, std.rows[2], 'state') === 'California');
ok('the untidy original is kept exactly',
  valueAt(std, std.rows[2], 'state_original') === ' California ');
ok('an unmatched abbreviation is merged when confirmed',
  valueAt(std, std.rows[3], 'state') === 'California');
ok('a row that was not touched has a blank audit cell',
  valueAt(std, std.rows[0], 'state_original') === '');
ok('a row that was not touched keeps its value',
  valueAt(std, std.rows[0], 'state') === 'California');
ok('a blank stays blank', valueAt(std, std.rows[6], 'state') === '');
ok('the recoded cells are counted', std.stats.recodedCells === 4);
ok('the untouched cells are counted', std.stats.untouchedCells === 3);
ok('the distinct count before is reported', std.stats.distinctBefore === 7);
ok('the distinct count after is reported', std.stats.distinctAfter === 3);
ok('the reduction is reported', std.stats.distinctRemoved === 4);
ok('the audit column is named in the stats', std.stats.auditColumn === 'state_original');
ok('the blanks are counted', std.stats.blanks === 1);
ok('the notes state that no row moved',
  std.notes.join(' ').toLowerCase().includes('no row was added or removed'));
ok('the notes state that every gain is another count loss',
  std.notes.join(' ').toLowerCase().includes('lost'));
ok('the notes warn that earlier counts will no longer match',
  std.notes.join(' ').toLowerCase().includes('no longer match'));
ok('the notes explain what the audit column is for',
  std.notes.join(' ').toLowerCase().includes('only way back'));
ok('the description names the audit column',
  describeValueStandardizer(std).includes('state_original'));

const stdUnused = valueStandardizerTransform(people, Object.assign({}, stdCfg, {
  map: Object.assign({}, confirmedMap, { Nevada: 'NV' }), confirmed: true,
}));
ok('a replacement matching no row is counted', stdUnused.stats.unusedReplacements === 1);
ok('a replacement matching no row is reported',
  stdUnused.notes.join(' ').toLowerCase().includes('matched no row'));
ok('a label the column never held is counted', stdUnused.stats.newLabels === 1);
ok('a label the column never held is reported',
  stdUnused.notes.join(' ').toLowerCase().includes('was not in the column before'));

const stdNoAudit = valueStandardizerTransform(people, Object.assign({}, stdCfg, {
  map: confirmedMap, confirmed: true, keepAudit: false,
}));
ok('the audit column can be turned off',
  names(stdNoAudit).indexOf('state_original') === -1);
ok('turning off the audit says the merge is now unpickable',
  stdNoAudit.notes.join(' ').toLowerCase().includes('cannot be undone'));
ok('turning off the audit reports no audit column', stdNoAudit.stats.auditColumn === '');

const confirmText = summarizeForConfirm(Object.assign({}, stdCfg, { map: confirmedMap }));
ok('the confirmation text lists every replacement',
  Object.keys(confirmedMap).every((k) => confirmText.includes(k)));
// Unquoted, " California " -> "California" looks like a pointless no-op.
ok('the confirmation text quotes the values so whitespace is visible',
  confirmText.includes('" California "'));
ok('the confirmation text says nothing else changes',
  confirmText.toLowerCase().includes('nothing else'));
ok('the confirmation text says no row moves',
  confirmText.toLowerCase().includes('no row is added or removed'));
ok('an empty map has nothing to confirm',
  summarizeForConfirm({ map: {} }).toLowerCase().includes('no merges'));

const stdSql = buildStandardizerSQL(Object.assign({}, stdCfg, { map: confirmedMap }), 'people');
ok('the standardizer SQL is produced', stdSql.ok === true);
ok('the standardizer SQL adds the audit column before updating',
  stdSql.sql.indexOf('ADD COLUMN') < stdSql.sql.indexOf('SET "state" ='));
ok('the standardizer SQL explains why the audit comes first',
  stdSql.sql.toLowerCase().includes('before the update'));
ok('the standardizer SQL spells out every replacement',
  Object.keys(confirmedMap).every((k) => stdSql.sql.includes("'" + k + "'")));
ok('the standardizer SQL hands back untouched values in the ELSE',
  stdSql.sql.includes('ELSE CAST("state" AS VARCHAR)'));
ok('the standardizer SQL narrows the update to the mapped values',
  stdSql.sql.includes('WHERE CAST("state" AS VARCHAR) IN ('));
ok('the standardizer SQL offers the check that the total did not move',
  stdSql.sql.includes('GROUP BY 1'));
ok('the standardizer SQL states that no row is added or removed',
  stdSql.sql.toLowerCase().includes('only relabelled'));
ok('the standardizer SQL carries plain comments', stdSql.sql.includes('--'));
ok('a value with a quote in it is escaped',
  buildStandardizerSQL({ valueColumn: 'state', map: { "O'Neill": 'ONeill' } }, 't').sql.includes("'O''Neill'"));
ok('with no audit column the SQL has no ALTER',
  buildStandardizerSQL(Object.assign({}, stdCfg,
    { map: confirmedMap, keepAudit: false }), 'people').sql.indexOf('ADD COLUMN') === -1);
ok('a missing table is refused',
  valueStandardizerTransform(null, Object.assign({}, stdCfg, { map: map, confirmed: true })).ok === false);

/* ==========================================================================
   Suggestions: a starting point, never an answer
   ========================================================================== */
console.log('\nsuggestions');

const runSuggest = suggestRunConfig(activity);
ok('a run config is suggested', !!runSuggest);
ok('the suggested run config picks a date column', runSuggest.dateColumn === 'day');
ok('the suggested run config picks a repeating entity',
  runSuggest.entityColumns.length >= 1);
const maSuggest = suggestMovingAverageConfig(series);
ok('a moving average config is suggested', maSuggest.valueColumn === 'value');
ok('the suggested moving average orders by the date', maSuggest.orderColumn === 'day');
ok('the suggested window is at least one', maSuggest.window >= 1);
const mvSuggest = suggestMultiValueConfig(tagged);
ok('the column that most often splits is suggested', mvSuggest.valueColumn === 'tags');
const comboSuggest = suggestCombinationsConfig(basket);
ok('a multi-value column is suggested as a combination source',
  comboSuggest.source === 'multivalue' && comboSuggest.valueColumn === 'items');
const colComboSuggest = suggestCombinationsConfig(churn);
ok('two low-cardinality columns are suggested when nothing splits',
  colComboSuggest.itemColumns.length === 2);
const recSuggest = suggestRecurrenceConfig(admissions);
ok('a recurrence date column is suggested', recSuggest.dateColumn === 'admit');
ok('a recurrence entity column is suggested',
  recSuggest.entityColumns.indexOf('patient') !== -1);
ok('suggesting against an empty dataset does not crash',
  !!suggestRunConfig(ds('e', [], [])) && !!suggestMultiValueConfig(ds('e', [], []))
  && !!suggestCombinationsConfig(ds('e', [], []))
  && !!suggestRecurrenceConfig(ds('e', [], []))
  && !!suggestMovingAverageConfig(ds('e', [], [])));

/* ==========================================================================
   House shape: everything the panel and the injector rely on
   ========================================================================== */
console.log('\nhouse shape');

const allResults = [runs, runsAsOf, ma, maPartial, maGrouped, mv, mvNoEmpty, combos, colCombos,
  rec, recDeclared, recFirst, std, stdNoAudit];
const allSql = [runSql.sql, maSql.sql, mvSql.sql, comboSql.sql, colSql.sql, recSql.sql, stdSql.sql];

for (const res of allResults) {
  assert(res.ok === true, 'result ok');
  assert(Array.isArray(res.columns) && Array.isArray(res.rows), 'shape');
  assert(typeof res.sql === 'string' && res.sql.length > 0, 'sql present');
  assert(res.stats && typeof res.stats === 'object', 'stats present');
  assert(Array.isArray(res.notes) && res.notes.length > 0, 'notes present');
  for (const r of res.rows) {
    assert(Array.isArray(r) && r.length === res.columns.length, 'row width');
  }
}
ok('every transform returns the house result shape with matching row widths', true);
ok('every column type is an uppercase house type',
  allResults.every((r) => r.columns.every((c) => c.type === c.type.toUpperCase())));
ok('every column has a name',
  allResults.every((r) => r.columns.every((c) => typeof c.name === 'string' && c.name.length > 0)));
ok('no output table has a duplicate column name',
  allResults.every((r) => new Set(r.columns.map((c) => c.name)).size === r.columns.length));
ok('every transform ships its glass-box SQL alongside the rows',
  allResults.every((r) => r.sql.includes('SELECT') || r.sql.includes('WITH')
    || r.sql.includes('UPDATE')));
ok('every transform says something about what it could not do',
  allResults.every((r) => r.notes.length > 0));
ok('every note is a plain sentence and not a code fragment',
  allResults.every((r) => r.notes.every((n) => typeof n === 'string' && n.length > 20)));
ok('every SQL proof carries a plain-language comment', allSql.every((s) => s.includes('--')));
// The canvas inlines these modules into one script tag, so an em dash or a
// control character in product text breaks the injector guard.
ok('no product text carries an em dash',
  allResults.every((r) => r.notes.every((n) => !n.includes('—')))
  && allSql.every((s) => !s.includes('—')));
ok('no SQL proof can close the script tag it will be inlined into',
  allSql.every((s) => !s.includes('</script>')));
ok('every stats block reports how many rows came in',
  allResults.every((r) => typeof r.stats.rowsIn === 'number'));
ok('every stats block reports how many rows went out',
  allResults.every((r) => typeof r.stats.rowsOut === 'number'));
ok('every description is a sentence a person could read aloud',
  [describeConsecutiveRun(runs), describeMovingAverage(ma), describeMultiValueCounts(mv),
    describeFrequentCombinations(combos), describeWindowRecurrence(rec),
    describeValueStandardizer(std)]
    .every((s) => typeof s === 'string' && s.length > 20 && !s.includes('—')));
ok('every description handles a failed result',
  [describeConsecutiveRun, describeMovingAverage, describeMultiValueCounts,
    describeFrequentCombinations, describeWindowRecurrence, describeValueStandardizer]
    .every((f) => f({ ok: false }) === 'This did not run.'));
ok('no transform mutates the dataset it was given',
  activity.rows.length === 9 && series.rows.length === 11 && tagged.rows.length === 5
  && basket.rows.length === 7 && admissions.rows.length === 9 && people.rows.length === 7);
ok('the source rows are unchanged, not just the same count',
  people.rows[1][1] === 'california' && admissions.rows[0][1] === '2024-01-01');

console.log('\n' + passed + ' passed');
assert(passed >= 300, 'expected at least 300 assertions, got ' + passed);
console.log('advanced-transforms: all ' + passed + ' assertions passed');
