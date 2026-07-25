// ============================================================
// DATAGLOW - A26 Expand a date range into one row per day
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. A row says "bed 4 was occupied from the 3rd to the 9th".
// That is one row, and it cannot be counted, charted by day, or joined to a
// daily calendar. This turns it into seven rows, one per calendar day, which is
// the shape every occupancy, bed-days, licence-days and utilisation question
// actually needs.
//
// THIS IS THE HIGHEST MULTIPLIER IN THE BUNDLE, SO THE COUNT COMES FIRST.
// A17 multiplies by the length of a list, which a person can usually picture. A
// date range multiplies by its length in days, which they cannot: a table of
// annual contracts is a 365x expansion, and 3,000 contracts is 1.1 million rows.
// That is not a slow table, it is a browser tab that stops responding, on a
// phone possibly for good. So previewExpandDateRange() computes the exact output
// count without building a single row, the confirm names it, and above
// MAX_DAILY_ROWS the transform refuses outright rather than trying and dying
// halfway with the dataset already replaced.
//
// AN OPEN END IS A REAL ANSWER, NOT A MISSING ONE, AND IT STILL NEEDS A DATE.
// A blank end date usually means "still going". Expanding that requires knowing
// up to when, and the honest answer is not "today" chosen silently: run the same
// table next month and the numbers change with no edit to the data. So an open
// range is skipped unless the person states an as-at date, and either way the
// count of open rows is reported.
//
// THE END DAY IS INCLUDED BY DEFAULT, AND THAT IS A CHOICE WORTH STATING.
// The 3rd to the 9th is seven days if the end is a stay and six if it is a
// checkout. Both conventions are real and live in different systems, so the
// setting is explicit, defaults to inclusive, and the day count in the notes
// says which was used.

import {
  quoteIdent,
  quoteLiteral,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  isDateType,
  parseDateValue,
  formatISODate,
  MS_PER_DAY,
  daysBetween,
  isPlainObject,
  column,
  typeOfColumn,
  TYPE_INT,
  TYPE_DATE,
  transformResult,
  transformError,
} from './transform-core.js';

export const EXPAND_DATE_RANGE_VERSION = 1;

export const OPEN_END_MODES = Object.freeze(['skip', 'asAt']);

export const OPEN_END_LABELS = Object.freeze({
  skip: 'Leave rows with no end date alone',
  asAt: 'Run them up to a date I choose',
});

// Above this the result is slow to scroll and slow to chart. A warning, not a
// stop: 150,000 daily rows is a legitimate year of a mid-sized service.
export const DAILY_WARN_ROWS = 100000;

// The narrow-screen threshold is much lower, because the same table that is
// merely sluggish on a laptop is what makes a phone tab unresponsive.
export const DAILY_WARN_ROWS_NARROW = 20000;

// A hard refusal. Past this, building the array is itself the failure: the tab
// runs out of memory partway through, and it does so after the person has
// already clicked apply.
export const MAX_DAILY_ROWS = 2000000;

// One range this long is nearly always a data fault, such as a sentinel end date
// of 9999-12-31, rather than a genuinely century-long contract.
export const LONG_RANGE_WARN_DAYS = 3650;

export function createEmptyDateRangeConfig() {
  return {
    startColumn: '',
    endColumn: '',
    dayColumn: 'day',
    includeDayIndex: true,
    includeSpanDays: false,
    endInclusive: true,
    openEnd: 'skip',
    asAtDate: '',
  };
}

export function suggestDateRangeConfig(dataset) {
  const cfg = createEmptyDateRangeConfig();
  const cols = (dataset && dataset.columns) || [];
  const names = columnNamesOf(dataset);

  // Prefer columns the person named, because start/end pairs are almost always
  // named as such, and fall back to the first two date-typed columns in order.
  const hinted = (words) => names.find((n) => {
    const low = String(n).toLowerCase();
    return words.some((w) => low.includes(w));
  }) || '';

  cfg.startColumn = hinted(['start', 'from', 'admit', 'begin', 'open']);
  cfg.endColumn = hinted(['end', 'to_', 'until', 'discharge', 'finish', 'close']);

  if (!cfg.startColumn || !cfg.endColumn || cfg.startColumn === cfg.endColumn) {
    const dates = [];
    for (let i = 0; i < cols.length; i += 1) {
      if (cols[i] && isDateType(cols[i].type)) dates.push(cols[i].name);
    }
    if (!cfg.startColumn) cfg.startColumn = dates[0] || names[0] || '';
    if (!cfg.endColumn || cfg.endColumn === cfg.startColumn) {
      cfg.endColumn = dates.find((n) => n !== cfg.startColumn) || '';
    }
  }
  return cfg;
}

export function validateDateRangeConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  if (!config.startColumn) errors.push('Pick the column holding the start date.');
  else if (!names.includes(config.startColumn)) {
    errors.push('The column ' + config.startColumn + ' is not in this table.');
  }
  if (!config.endColumn) errors.push('Pick the column holding the end date.');
  else if (!names.includes(config.endColumn)) {
    errors.push('The column ' + config.endColumn + ' is not in this table.');
  }
  if (config.startColumn && config.startColumn === config.endColumn) {
    errors.push('The start and end columns have to be different. '
      + 'A range from a day to itself is one row, which is what you already have.');
  }

  const day = dayColumnName(config);
  if (names.includes(day)) {
    errors.push('This table already has a column called ' + day
      + '. Choose another name for the day column, so the original is not overwritten.');
  }
  if (config.includeDayIndex !== false && names.includes(day + '_index')) {
    errors.push('This table already has a column called ' + day + '_index.');
  }

  const mode = config.openEnd || 'skip';
  if (OPEN_END_MODES.indexOf(mode) === -1) {
    errors.push('Choose what happens to rows with no end date.');
  } else if (mode === 'asAt') {
    if (!config.asAtDate) {
      errors.push('Give the date to run open ranges up to. '
        + 'Leaving it to "today" would change the answer every time this is run.');
    } else if (!parseDateValue(config.asAtDate)) {
      errors.push('The as-at date ' + config.asAtDate + ' could not be read. Use YYYY-MM-DD.');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

/** The name of the generated day column. */
export function dayColumnName(config) {
  const explicit = String((config && config.dayColumn) || '').trim();
  return explicit || 'day';
}

/**
 * Read one row's range.
 *
 * Returns the reason as well as the dates, because every reason here is a
 * counted, reported outcome rather than a row that quietly vanishes.
 */
function readRange(row, startIdx, endIdx, config, asAt) {
  const start = parseDateValue(row[startIdx]);
  if (!start) return { kind: 'unreadableStart', days: 0 };

  const rawEnd = row[endIdx];
  const blankEnd = rawEnd == null || rawEnd === '';
  let end;
  if (blankEnd) {
    if (!asAt) return { kind: 'open', days: 0 };
    end = asAt;
    // An open range that started after the as-at date has not begun yet. It is
    // not a reversed range and calling it one would misreport the cause.
    if (daysBetween(start, end) < 0) return { kind: 'notYetStarted', days: 0 };
  } else {
    end = parseDateValue(rawEnd);
    // An unreadable end is not an open end. Reading 31/13/2024 as "still going"
    // would silently stretch a closed range to the as-at date.
    if (!end) return { kind: 'unreadableEnd', days: 0 };
    if (daysBetween(start, end) < 0) return { kind: 'reversed', days: 0 };
  }

  const inclusive = config.endInclusive !== false;
  const days = daysBetween(start, end) + (inclusive ? 1 : 0);
  if (days <= 0) {
    // Only reachable with an exclusive end on a same-day range, which is a
    // zero-length stay: a real thing, and correctly zero rows.
    return { kind: 'zeroLength', days: 0, start: start, end: end };
  }
  return { kind: 'range', days: days, start: start, end: end, open: blankEnd };
}

/**
 * Count what apply would produce, without building it.
 *
 * A separate pass on purpose. "Build it and read length" is exactly the thing
 * this exists to prevent, since the build is what runs the tab out of memory.
 */
export function previewExpandDateRange(dataset, config, options) {
  if (!dataset || typeof dataset !== 'object') {
    return { ok: false, error: 'There is no table loaded.' };
  }
  const names = columnNamesOf(dataset);
  const v = validateDateRangeConfig(config, names);
  if (!v.ok) return { ok: false, error: v.errors.join(' ') };

  const startIdx = indexOfColumn(names, config.startColumn);
  const endIdx = indexOfColumn(names, config.endColumn);
  const rows = rowsOf(dataset);
  const asAt = (config.openEnd === 'asAt') ? parseDateValue(config.asAtDate) : null;
  const narrow = !!(options && options.narrow);

  const counts = {
    range: 0, open: 0, reversed: 0, zeroLength: 0,
    unreadableStart: 0, unreadableEnd: 0, notYetStarted: 0,
  };
  let days = 0;
  let longest = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const r = readRange(row, startIdx, endIdx, config, asAt);
    counts[r.kind] = (counts[r.kind] || 0) + 1;
    if (r.kind !== 'range') continue;
    days += r.days;
    if (r.days > longest) longest = r.days;
  }

  const rowsIn = rows.length;
  const warnings = [];
  const overCap = days > MAX_DAILY_ROWS;

  if (overCap) {
    warnings.push('This would make ' + days.toLocaleString() + ' rows, which is over the limit of '
      + MAX_DAILY_ROWS.toLocaleString() + '. It will not run. Filter the table down or narrow the '
      + 'date range first: a table this size does not finish building in a browser tab.');
  } else if (narrow && days > DAILY_WARN_ROWS_NARROW) {
    warnings.push('This makes ' + days.toLocaleString() + ' rows on a phone-sized screen. That is '
      + 'enough to make this tab stop responding. Consider doing it on a larger screen, or '
      + 'filtering the table first.');
  } else if (days > DAILY_WARN_ROWS) {
    warnings.push('This makes ' + days.toLocaleString() + ' rows, which is more than '
      + DAILY_WARN_ROWS.toLocaleString() + '. A table that size is slow to scroll and slow to '
      + 'chart. Consider filtering first.');
  }

  if (longest > LONG_RANGE_WARN_DAYS) {
    warnings.push('One range alone covers ' + longest.toLocaleString() + ' days. That is usually a '
      + 'placeholder end date such as 9999-12-31 rather than a real span.');
  }
  if (counts.open > 0 && config.openEnd !== 'asAt') {
    warnings.push(counts.open + ' row' + (counts.open === 1 ? ' has' : 's have') + ' no end date '
      + 'and will not be expanded. Set an as-at date if those should run up to a chosen day.');
  }

  return {
    ok: true,
    rowsIn: rowsIn,
    rowsOut: days,
    ratio: rowsIn > 0 ? days / rowsIn : 1,
    expandable: counts.range,
    openRows: counts.open,
    reversedRows: counts.reversed,
    zeroLengthRows: counts.zeroLength,
    unreadableStart: counts.unreadableStart,
    unreadableEnd: counts.unreadableEnd,
    notYetStarted: counts.notYetStarted,
    longestRange: longest,
    overCap: overCap,
    willGrow: days > rowsIn,
    warnings: warnings,
  };
}

/**
 * The glass-box SQL.
 *
 * generate_series over a date range, joined laterally so every source column
 * comes with each day. The INTERVAL 1 DAY step and the inclusive/exclusive end
 * are both visible in the text, because those are the two things a reader needs
 * to check against their own definition of a day count.
 */
export function buildExpandDateRangeSQL(config, sourceRelation) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const t = relationName(sourceRelation, 'source');
  const s = quoteIdent(config.startColumn);
  const e = quoteIdent(config.endColumn);
  const day = quoteIdent(dayColumnName(config));
  const inclusive = config.endInclusive !== false;
  const asAt = (config.openEnd === 'asAt') ? parseDateValue(config.asAtDate) : null;

  // The upper bound of the series. An exclusive end stops a day short; an as-at
  // date substitutes for a null end, and is a literal so the query means the
  // same thing tomorrow as it does today.
  const endExpr = asAt
    ? 'COALESCE(src.' + e + ', CAST(' + quoteLiteral(formatISODate(asAt)) + ' AS DATE))'
    : 'src.' + e;
  const upper = inclusive ? endExpr : '(' + endExpr + ' - INTERVAL 1 DAY)';

  const idxCol = config.includeDayIndex !== false
    ? ',\n  CAST(date_diff(' + quoteLiteral('day') + ', src.' + s + ', d.' + day
      + ') AS BIGINT) + 1 AS ' + quoteIdent(dayColumnName(config) + '_index')
    : '';
  const spanCol = config.includeSpanDays
    ? ',\n  CAST(date_diff(' + quoteLiteral('day') + ', src.' + s + ', ' + endExpr + ') AS BIGINT) + '
      + (inclusive ? '1' : '0') + ' AS ' + quoteIdent(dayColumnName(config) + '_span')
    : '';

  const lines = [
    '-- One row per calendar day between ' + s + ' and ' + e + '.',
    '-- Every other column is repeated on each day, so any total already computed',
    '-- over this table will be multiplied by the length of each range. That is the',
    '-- reason for the row count shown beside this SQL.',
    '-- The end day is ' + (inclusive ? 'included' : 'excluded')
      + ': the 3rd to the 9th is ' + (inclusive ? 'seven' : 'six') + ' days.',
    'SELECT',
    '  src.*,',
    '  CAST(d.' + day + ' AS DATE) AS ' + day + idxCol + spanCol,
    'FROM ' + t + ' AS src',
    'CROSS JOIN LATERAL generate_series(',
    '  CAST(src.' + s + ' AS DATE),',
    '  CAST(' + upper + ' AS DATE),',
    '  INTERVAL 1 DAY',
    ') AS d(' + day + ')',
  ];

  if (asAt) {
    lines.push('');
    lines.push('-- Rows with no end date run to ' + formatISODate(asAt) + ', written as a literal');
    lines.push('-- rather than current_date so this query gives the same answer next month.');
  } else {
    lines.push('');
    lines.push('-- Rows with no end date produce nothing here, because generate_series with a');
    lines.push('-- NULL bound returns no rows. They are counted and named in the notes rather');
    lines.push('-- than being run to today, which would change the answer on every rerun.');
  }
  lines.push('-- A range whose end is before its start also produces nothing, which is the');
  lines.push('-- same refusal the computed result makes.');

  return { ok: true, sql: lines.join('\n') };
}

export function expandDateRangeTransform(dataset, config, options) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateDateRangeConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  // The cap is checked before anything is built, not while building. A refusal
  // partway through would leave the caller holding half a table.
  const pre = previewExpandDateRange(dataset, config, options);
  if (pre.ok && pre.overCap) {
    return transformError('This would make ' + pre.rowsOut.toLocaleString() + ' rows, over the '
      + 'limit of ' + MAX_DAILY_ROWS.toLocaleString() + '. Filter the table or narrow the dates '
      + 'first. Nothing was changed.');
  }

  const startIdx = indexOfColumn(names, config.startColumn);
  const endIdx = indexOfColumn(names, config.endColumn);
  const rows = rowsOf(dataset);
  const asAt = (config.openEnd === 'asAt') ? parseDateValue(config.asAtDate) : null;
  const withIndex = config.includeDayIndex !== false;
  const withSpan = !!config.includeSpanDays;
  const dayName = dayColumnName(config);

  const outColumns = names.map((n) => column(n, typeOfColumn(dataset, n)));
  outColumns.push(column(dayName, TYPE_DATE));
  if (withIndex) outColumns.push(column(dayName + '_index', TYPE_INT));
  if (withSpan) outColumns.push(column(dayName + '_span', TYPE_INT));

  const counts = {
    range: 0, open: 0, reversed: 0, zeroLength: 0,
    unreadableStart: 0, unreadableEnd: 0, notYetStarted: 0,
  };
  const out = [];
  let longest = 0;
  let openExpanded = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const r = readRange(row, startIdx, endIdx, config, asAt);
    counts[r.kind] = (counts[r.kind] || 0) + 1;
    // Branches mirror previewExpandDateRange() case for case. The two
    // disagreeing about the row count would make the confirm a lie, which is the
    // one thing the preview exists to prevent.
    if (r.kind !== 'range') continue;
    if (r.open) openExpanded += 1;
    if (r.days > longest) longest = r.days;

    for (let d = 0; d < r.days; d += 1) {
      const day = formatISODate(new Date(r.start.getTime() + d * MS_PER_DAY));
      const extra = [day];
      if (withIndex) extra.push(d + 1);
      if (withSpan) extra.push(r.days);
      out.push(row.concat(extra));
    }
  }

  const built = buildExpandDateRangeSQL(config, dataset.name);
  const notes = [];
  const inclusive = config.endInclusive !== false;

  // Keyed on whether any row actually multiplied, not on whether the table grew
  // overall. A table can come out shorter because unreadable rows were left
  // behind while every row that did expand still repeats its values.
  if (longest > 1) {
    notes.push('Every column other than the new ones is repeated once per day. Any total, average '
      + 'or count already computed over this table will change, and a sum of a repeated column '
      + 'will be multiplied by the length of each range. That is expected here, not a fault, but '
      + 'it is the reason to re-check any number carried over from before.');
  }
  notes.push('The end day is ' + (inclusive ? 'counted' : 'not counted')
    + ', so a range from the 3rd to the 9th is ' + (inclusive ? 'seven' : 'six') + ' days. '
    + 'Both conventions are in use, and which one is right depends on whether the end date is the '
    + 'last day of the stay or the day it ended.');

  // With an as-at date an open row is expanded, so it counts as a range and
  // never lands in counts.open. openExpanded is the count that survives it.
  const openSeen = asAt ? openExpanded : counts.open;
  if (openSeen > 0) {
    notes.push(asAt
      ? openSeen + ' row' + (openSeen === 1 ? '' : 's') + ' had no end date and '
        + (openSeen === 1 ? 'was' : 'were') + ' run up to ' + formatISODate(asAt)
        + '. That date is recorded here because the answer depends on it: run against a different '
        + 'as-at date, these counts change.'
      : counts.open + ' row' + (counts.open === 1 ? '' : 's') + ' had no end date and produced no '
        + 'days. An open range needs an as-at date to expand, and defaulting to today would mean '
        + 'this table gave a different answer every time it was built.');
  }
  if (counts.reversed > 0) {
    notes.push(counts.reversed + ' row' + (counts.reversed === 1 ? ' has an end date' : 's have end '
      + 'dates') + ' before ' + (counts.reversed === 1 ? 'its' : 'their') + ' start date and '
      + 'produced no days. That is a data fault worth looking at rather than something to expand.');
  }
  if (counts.zeroLength > 0) {
    notes.push(counts.zeroLength + ' row' + (counts.zeroLength === 1 ? '' : 's')
      + ' started and ended on the same day, which is zero days with the end excluded, so '
      + (counts.zeroLength === 1 ? 'it' : 'they') + ' produced no rows.');
  }
  if (counts.unreadableStart > 0 || counts.unreadableEnd > 0) {
    const bad = counts.unreadableStart + counts.unreadableEnd;
    notes.push(bad + ' row' + (bad === 1 ? '' : 's') + ' had a date that could not be read and '
      + (bad === 1 ? 'was' : 'were') + ' left out. An unreadable end is not treated as an open '
      + 'range: stretching a closed range to the as-at date because its end was mistyped would be '
      + 'a much larger error than dropping it.');
  }
  if (counts.notYetStarted > 0) {
    notes.push(counts.notYetStarted + ' open row' + (counts.notYetStarted === 1 ? '' : 's')
      + ' started after the as-at date, so ' + (counts.notYetStarted === 1 ? 'it has' : 'they have')
      + ' not begun yet and produced no days.');
  }
  if (longest > LONG_RANGE_WARN_DAYS) {
    notes.push('The longest single range covers ' + longest + ' days, which usually means a '
      + 'placeholder end date rather than a real span.');
  }
  if (out.length === 0 && rows.length > 0) {
    notes.push('No row produced a day. Check that the start and end columns are the right ones and '
      + 'that their dates can be read.');
  }

  return transformResult({
    columns: outColumns,
    rows: out,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: rows.length,
      rowsOut: out.length,
      expandable: counts.range,
      openRows: counts.open,
      openExpanded: openExpanded,
      reversedRows: counts.reversed,
      zeroLengthRows: counts.zeroLength,
      unreadableStart: counts.unreadableStart,
      unreadableEnd: counts.unreadableEnd,
      notYetStarted: counts.notYetStarted,
      longestRange: longest,
      ratio: rows.length ? out.length / rows.length : 1,
    },
    notes: notes,
  });
}

/** One plain sentence for the panel header, leading with the row count because
    that is the consequence a person is agreeing to. */
export function describeExpandDateRange(result) {
  if (!result || !result.ok) return 'This did not run.';
  const s = result.stats || {};
  if (!s.rowsIn) return 'The table has no rows, so there is nothing to expand.';
  if (!s.rowsOut) return 'No row produced a day, so this would leave an empty table.';
  const times = (s.ratio || 1).toFixed(1).replace(/\.0$/, '');
  const left = s.openRows && !s.openExpanded
    ? ' ' + s.openRows + ' row' + (s.openRows === 1 ? '' : 's') + ' with no end date produced none.'
    : '';
  return s.rowsIn.toLocaleString() + ' rows become ' + s.rowsOut.toLocaleString()
    + ', about ' + times + ' times as many, one per calendar day.' + left;
}

export const DataGlowExpandDateRange = {
  EXPAND_DATE_RANGE_VERSION,
  OPEN_END_MODES,
  OPEN_END_LABELS,
  DAILY_WARN_ROWS,
  DAILY_WARN_ROWS_NARROW,
  MAX_DAILY_ROWS,
  LONG_RANGE_WARN_DAYS,
  createEmptyDateRangeConfig,
  suggestDateRangeConfig,
  validateDateRangeConfig,
  dayColumnName,
  previewExpandDateRange,
  buildExpandDateRangeSQL,
  expandDateRangeTransform,
  describeExpandDateRange,
};
