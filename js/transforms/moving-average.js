// ============================================================
// DATAGLOW - A22 Moving average, and the crossover between two
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. A daily series is too noisy to read. A seven day average
// makes the trend visible, and a second, longer average makes a change of trend
// visible: the short one crossing above the long one is the pattern people call
// a golden cross, crossing below is a death cross. Those names come from finance
// and the arithmetic is the same for daily signups, ward occupancy or scrap rate.
//
// THE FIRST N-1 ROWS ARE THE WHOLE PROBLEM.
// A seven day average of the first three days of data is an average of three
// days. Reporting it as if it were a seven day average is the single most common
// error here, and it is invisible: the column is full, the chart starts at the
// left edge, and the early values are simply wrong in a way that always makes the
// series look flatter or smoother than it was. So the default leaves those rows
// blank and says how many were left blank, a partial window is an explicit
// choice, and either way a rows_in_window column records how many values each
// average actually covers.
//
// A GAP IN THE DATES IS NOT A GAP IN THE WINDOW, AND THIS IS THE HONEST WARNING.
// This averages over ROWS, not over days, exactly as SQL's ROWS BETWEEN does.
// If a date is missing from the table the window silently reaches further back in
// time than the number of days it claims: a "7 day average" over a series missing
// Sundays is really a nine day average. This module counts the gaps and says so
// rather than pretending row order is calendar order. Filling the calendar first
// (A26 expand date range) is the fix, and the note says that too.
//
// A CROSSOVER NEEDS BOTH SIDES TO EXIST.
// The first row where the short average is above the long one is not a crossover
// if the row before it had no long average at all. Warm-up rows produce no signal
// rather than a spurious one on the first complete row, which is where a naive
// implementation reliably fires.
//
// WHAT A CROSSOVER IS NOT.
// It is an arithmetic fact about two averages, not a prediction. Two smoothed
// lines crossing tells you the recent mean moved relative to the older mean. The
// notes say this in plain words, because the pattern's name carries a promise
// that the arithmetic does not.

import {
  quoteIdent,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  suggestDateColumn,
  suggestNumericColumn,
  isPlainObject,
  asColumnList,
  keyOfRow,
  parseDateValue,
  formatISODate,
  daysBetween,
  toNumber,
  column,
  typeOfColumn,
  TYPE_INT,
  TYPE_FLOAT,
  TYPE_STR,
  transformResult,
  transformError,
} from './transform-core.js';

export const MOVING_AVERAGE_VERSION = 1;

// A window of 1 is the series itself, which is a legitimate thing to ask for but
// worth naming rather than silently accepting as smoothing.
export const MIN_WINDOW = 1;

// Past this the average is flatter than most series are long, and the warm-up
// blanks dominate the column.
export const LARGE_WINDOW_WARN = 90;

export const WARMUP_MODES = Object.freeze(['blank', 'partial']);

export const WARMUP_LABELS = Object.freeze({
  blank: 'Leave the first rows blank until the window is full',
  partial: 'Average whatever rows exist so far',
});

export const CROSS_SIGNALS = Object.freeze({
  up: 'up',
  down: 'down',
  none: '',
});

export function createEmptyMovingAverageConfig() {
  return {
    valueColumn: '',
    orderColumn: '',
    groupColumns: [],
    window: 7,
    secondWindow: 0,
    warmup: 'blank',
    markCrossovers: true,
    keepOriginal: true,
  };
}

export function suggestMovingAverageConfig(dataset) {
  const cfg = createEmptyMovingAverageConfig();
  cfg.orderColumn = suggestDateColumn(dataset) || '';
  cfg.valueColumn = suggestNumericColumn(dataset) || '';
  return cfg;
}

export function validateMovingAverageConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  if (!config.valueColumn) {
    errors.push('Pick the number column to smooth.');
  } else if (!names.includes(config.valueColumn)) {
    errors.push('The value column ' + config.valueColumn + ' is not in this table.');
  }

  if (!config.orderColumn) {
    errors.push('Pick the column that puts the rows in order. A moving average over rows in an '
      + 'arbitrary order is not a moving average of anything.');
  } else if (!names.includes(config.orderColumn)) {
    errors.push('The order column ' + config.orderColumn + ' is not in this table.');
  } else if (config.orderColumn === config.valueColumn) {
    errors.push('The order column and the value column cannot be the same column.');
  }

  const groups = asColumnList(config.groupColumns);
  for (let i = 0; i < groups.length; i += 1) {
    if (!names.includes(groups[i])) {
      errors.push('The column ' + groups[i] + ' is not in this table.');
    } else if (groups[i] === config.valueColumn) {
      errors.push('The value column cannot also be a grouping column.');
    }
  }

  const w = Number(config.window);
  if (!Number.isFinite(w) || w < MIN_WINDOW || Math.floor(w) !== w) {
    errors.push('The window has to be a whole number of rows, one or more.');
  }

  const w2 = Number(config.secondWindow || 0);
  if (config.secondWindow && (!Number.isFinite(w2) || w2 < MIN_WINDOW || Math.floor(w2) !== w2)) {
    errors.push('The second window has to be a whole number of rows, one or more.');
  }
  if (w2 && w2 === w) {
    errors.push('The two windows are the same size, so the two averages would be identical and '
      + 'could never cross. Use different lengths or leave the second one empty.');
  }

  if (config.warmup && WARMUP_MODES.indexOf(config.warmup) === -1) {
    errors.push('Choose what happens to the rows before the window is full.');
  }

  return { ok: errors.length === 0, errors: errors };
}

/** The name of the average column for a given window, so the SQL and the table
    cannot disagree about what to call it. */
export function averageColumnName(config, windowSize) {
  const base = String((config && config.valueColumn) || 'value');
  return base + '_ma' + String(windowSize);
}

export function crossColumnName() {
  return 'ma_cross';
}

/** Whether the pair of windows can produce a crossover at all. */
export function hasCrossover(config) {
  const w2 = Number((config && config.secondWindow) || 0);
  return Boolean(w2) && w2 !== Number(config && config.window)
    && (config && config.markCrossovers) !== false;
}

/**
 * The glass-box SQL.
 *
 * ROWS BETWEEN n-1 PRECEDING AND CURRENT ROW, which is what the computed column
 * does. The comment says out loud that this counts rows and not days, because
 * that is the difference between the query being right and the answer being
 * right, and only the reader knows whether their calendar has holes in it.
 */
export function buildMovingAverageSQL(config, sourceRelation) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const rel = relationName(sourceRelation, 'your_table');
  const val = quoteIdent(config.valueColumn);
  const ord = quoteIdent(config.orderColumn);
  const groups = asColumnList(config.groupColumns);
  const part = groups.length ? 'PARTITION BY ' + groups.map(quoteIdent).join(', ') + ' ' : '';
  const w = Math.max(MIN_WINDOW, Math.floor(Number(config.window) || 1));
  const w2 = Math.max(0, Math.floor(Number(config.secondWindow) || 0));
  const blank = String(config.warmup || 'blank') !== 'partial';

  function avgExpr(size) {
    const over = 'OVER (' + part + 'ORDER BY ' + ord
      + ' ROWS BETWEEN ' + (size - 1) + ' PRECEDING AND CURRENT ROW)';
    const avg = 'AVG(' + val + ') ' + over;
    if (!blank) return avg;
    // The blank until full rule, written as SQL rather than described: an average
    // over fewer rows than asked for is not the average that was asked for.
    return 'CASE WHEN COUNT(' + val + ') ' + over + ' = ' + size
      + ' THEN ' + avg + ' END';
  }

  const lines = [
    '-- A ' + w + ' row moving average of ' + val + ', in ' + ord + ' order'
      + (groups.length ? ', per ' + groups.map(quoteIdent).join(', ') : '') + '.',
    '-- ROWS BETWEEN counts ROWS, not days. If a date is missing from the table this',
    '-- window reaches further back in time than ' + w + ' days while still being',
    '-- labelled ' + w + '. Fill the calendar first if that matters.',
  ];
  if (blank) {
    lines.push('-- The CASE leaves a row blank until ' + w + ' values exist. An average of the');
    lines.push('-- first three rows is not a ' + w + ' row average, and printing it as one makes');
    lines.push('-- the start of the series look smoother than it was.');
  } else {
    lines.push('-- Partial windows are averaged as-is, so the earliest rows average fewer than');
    lines.push('-- ' + w + ' values. rows_in_window says how many each one covers.');
  }

  const selects = [];
  if (config.keepOriginal !== false) selects.push('  *,');
  else selects.push('  ' + (groups.length ? groups.map(quoteIdent).join(', ') + ', ' : '')
    + ord + ', ' + val + ',');
  selects.push('  ' + avgExpr(w) + ' AS ' + quoteIdent(averageColumnName(config, w)) + ',');
  selects.push('  COUNT(' + val + ') OVER (' + part + 'ORDER BY ' + ord
    + ' ROWS BETWEEN ' + (w - 1) + ' PRECEDING AND CURRENT ROW) AS rows_in_window');
  if (w2) {
    selects[selects.length - 1] += ',';
    selects.push('  ' + avgExpr(w2) + ' AS ' + quoteIdent(averageColumnName(config, w2)));
  }

  lines.push('SELECT');
  for (let i = 0; i < selects.length; i += 1) lines.push(selects[i]);
  lines.push('FROM ' + rel);
  lines.push('ORDER BY ' + (groups.length ? groups.map(quoteIdent).join(', ') + ', ' : '') + ord);

  if (w2 && hasCrossover(config)) {
    lines.push('');
    lines.push('-- The crossover column above is computed in the table rather than here, because');
    lines.push('-- it compares each row to the one before it AND requires both averages to exist');
    lines.push('-- on both rows. Expressed in SQL that is a LAG over the two CASE expressions:');
    lines.push('--   short > long AND LAG(short) <= LAG(long)  ->  up');
    lines.push('--   short < long AND LAG(short) >= LAG(long)  ->  down');
    lines.push('-- Without the both-exist condition the first complete row always reports a');
    lines.push('-- crossover, which is an artefact of the warm-up and not a change in the series.');
  }

  return { ok: true, sql: lines.join('\n') };
}

export function movingAverageTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateMovingAverageConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const valIdx = indexOfColumn(names, config.valueColumn);
  const ordIdx = indexOfColumn(names, config.orderColumn);
  const groups = asColumnList(config.groupColumns);
  const groupIdxs = groups.map((n) => indexOfColumn(names, n));
  const w = Math.max(MIN_WINDOW, Math.floor(Number(config.window) || 1));
  const w2 = Math.max(0, Math.floor(Number(config.secondWindow) || 0));
  const blank = String(config.warmup || 'blank') !== 'partial';
  const keepOriginal = config.keepOriginal !== false;
  const wantCross = Boolean(w2) && hasCrossover(config);

  const orderIsDate = Boolean(parseDateValue((rowsOf(dataset)[0] || [])[ordIdx]));
  const srcRows = rowsOf(dataset);

  const series = new Map();
  let unreadableOrder = 0;
  let nonNumeric = 0;

  for (let i = 0; i < srcRows.length; i += 1) {
    const row = srcRows[i];
    if (!Array.isArray(row)) continue;
    const rawOrder = row[ordIdx];
    const asDate = parseDateValue(rawOrder);
    const sortKey = asDate ? asDate.getTime() : toNumber(rawOrder);
    if (sortKey === null || sortKey === undefined) {
      // A row with no readable position cannot be placed in a window at all.
      // Dropping it silently would shorten the series without saying so.
      unreadableOrder += 1;
      continue;
    }
    const n = toNumber(row[valIdx]);
    if (n === null) nonNumeric += 1;

    const key = keyOfRow(row, groupIdxs);
    let s = series.get(key);
    if (!s) { s = { key: key, rows: [], seq: series.size }; series.set(key, s); }
    s.rows.push({ row: row, sortKey: sortKey, value: n, date: asDate });
  }

  const outColumns = [];
  if (keepOriginal) {
    for (let i = 0; i < names.length; i += 1) outColumns.push(column(names[i], typeOfColumn(dataset, names[i])));
  } else {
    for (let i = 0; i < groups.length; i += 1) outColumns.push(column(groups[i], typeOfColumn(dataset, groups[i])));
    outColumns.push(column(config.orderColumn, typeOfColumn(dataset, config.orderColumn)));
    outColumns.push(column(config.valueColumn, typeOfColumn(dataset, config.valueColumn)));
  }
  outColumns.push(column(averageColumnName(config, w), TYPE_FLOAT));
  outColumns.push(column('rows_in_window', TYPE_INT));
  if (w2) outColumns.push(column(averageColumnName(config, w2), TYPE_FLOAT));
  if (wantCross) outColumns.push(column(crossColumnName(), TYPE_STR));

  const outRows = [];
  let warmupBlanks = 0;
  let partialWindows = 0;
  let dateGaps = 0;
  let largestGapDays = 0;
  let crossUp = 0;
  let crossDown = 0;

  function windowAverage(rows, at, size) {
    let sum = 0;
    let count = 0;
    for (let i = at; i > at - size && i >= 0; i -= 1) {
      if (rows[i].value !== null) { sum += rows[i].value; count += 1; }
    }
    // A window whose rows exist but whose values are all blank has no average,
    // which is different from a window that is not full yet.
    if (!count) return { avg: null, count: 0, full: at + 1 >= size };
    return { avg: sum / count, count: count, full: at + 1 >= size };
  }

  const ordered = Array.from(series.values()).sort((a, b) => a.seq - b.seq);
  for (let g = 0; g < ordered.length; g += 1) {
    const rows = ordered[g].rows;
    rows.sort((a, b) => a.sortKey - b.sortKey);

    let prevShort = null;
    let prevLong = null;

    for (let i = 0; i < rows.length; i += 1) {
      if (i > 0 && rows[i].date && rows[i - 1].date) {
        const step = daysBetween(rows[i - 1].date, rows[i].date);
        if (step !== null && step > 1) {
          dateGaps += 1;
          if (step - 1 > largestGapDays) largestGapDays = step - 1;
        }
      }

      const short = windowAverage(rows, i, w);
      let shortValue = short.avg;
      if (blank && !short.full) { shortValue = null; warmupBlanks += 1; }
      else if (!short.full) partialWindows += 1;

      let longValue = null;
      if (w2) {
        const long = windowAverage(rows, i, w2);
        longValue = long.avg;
        if (blank && !long.full) longValue = null;
      }

      let signal = '';
      if (wantCross && shortValue !== null && longValue !== null
        && prevShort !== null && prevLong !== null) {
        // Both averages must exist on this row AND the row before it. Without
        // that the first complete row always fires, which is a warm-up artefact.
        if (shortValue > longValue && prevShort <= prevLong) { signal = CROSS_SIGNALS.up; crossUp += 1; }
        else if (shortValue < longValue && prevShort >= prevLong) { signal = CROSS_SIGNALS.down; crossDown += 1; }
      }
      prevShort = shortValue;
      prevLong = longValue;

      const base = keepOriginal ? rows[i].row.slice()
        : groupIdxs.map((ix) => rows[i].row[ix])
          .concat([rows[i].row[ordIdx], rows[i].row[valIdx]]);
      base.push(shortValue);
      base.push(short.count);
      if (w2) base.push(longValue);
      if (wantCross) base.push(signal);
      outRows.push(base);
    }
  }

  const built = buildMovingAverageSQL(config, dataset.name);
  const notes = [];

  notes.push('The average covers ' + w + ' row' + (w === 1 ? '' : 's') + ', not ' + w + ' '
    + (orderIsDate ? 'days' : 'units') + '. Those are the same thing only when every step in '
    + config.orderColumn + ' is present. This is the same ROWS BETWEEN rule the SQL uses, so the '
    + 'two agree, including where they are both wrong about the calendar.');

  if (dateGaps > 0) {
    notes.push(dateGaps + ' gap' + (dateGaps === 1 ? '' : 's') + ' were found in '
      + config.orderColumn + ', the largest skipping ' + largestGapDays + ' day'
      + (largestGapDays === 1 ? '' : 's') + '. Across a gap the window reaches further back in '
      + 'time than ' + w + ' days while still being labelled ' + w + '. If that matters, expand '
      + 'the calendar to one row per day first, then average.');
  } else {
    notes.push('No gap was found in ' + config.orderColumn + ', so a window of ' + w + ' rows is '
      + 'also a window of ' + w + ' steps here.');
  }

  if (blank && warmupBlanks > 0) {
    notes.push('The first ' + warmupBlanks + ' row' + (warmupBlanks === 1 ? '' : 's')
      + (ordered.length > 1 ? ' across all series' : '') + ' have a blank average, because fewer '
      + 'than ' + w + ' values existed yet. That blank is deliberate. Filling it with an average '
      + 'of three rows and calling it a ' + w + ' row average would make the start of the series '
      + 'look smoother than it was.');
  }
  if (!blank && partialWindows > 0) {
    notes.push(partialWindows + ' row' + (partialWindows === 1 ? '' : 's') + ' were averaged over '
      + 'fewer than ' + w + ' values, as configured. Read rows_in_window before comparing the '
      + 'start of the series to the rest of it: those early points are noisier, not smoother, '
      + 'and any conclusion about a trend beginning there is about the window and not the data.');
  }

  if (w2) {
    notes.push('Two averages are shown, over ' + w + ' and ' + w2 + ' rows. The longer one moves '
      + 'later, which is the whole reason a crossing between them is treated as a change of '
      + 'direction.');
  }
  if (wantCross) {
    if (crossUp || crossDown) {
      notes.push(crossUp + ' crossing' + (crossUp === 1 ? '' : 's') + ' upward and ' + crossDown
        + ' downward were marked in ' + crossColumnName() + '. A crossing is an arithmetic fact '
        + 'about two averages: the recent mean moved relative to the older mean. It is not a '
        + 'forecast, and on a short or noisy series these will appear and reverse repeatedly.');
    } else {
      notes.push('No crossing was found. The two averages never changed which one was on top, '
        + 'within the rows where both existed.');
    }
    notes.push('A crossing is only marked where both averages exist on this row and on the row '
      + 'before it. Otherwise the first row with a full window would always look like a crossing, '
      + 'which is an artefact of the warm-up rather than anything in the series.');
  }

  if (w >= LARGE_WINDOW_WARN || (w2 && w2 >= LARGE_WINDOW_WARN)) {
    notes.push('A window this long removes most of the variation, including real movements that '
      + 'lasted weeks. It also blanks or weakens a long run at the start of the series.');
  }
  if (nonNumeric > 0) {
    notes.push(nonNumeric + ' row' + (nonNumeric === 1 ? '' : 's') + ' had no readable number in '
      + config.valueColumn + '. Those rows still occupy a position in the window, so a window '
      + 'containing them averages fewer values than its label; rows_in_window shows the real count.');
  }
  if (unreadableOrder > 0) {
    notes.push(unreadableOrder + ' row' + (unreadableOrder === 1 ? '' : 's') + ' had no readable '
      + config.orderColumn + ' and are not in this result at all, because a row with no position '
      + 'cannot be placed in a window.');
  }

  return transformResult({
    columns: outColumns,
    rows: outRows,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: srcRows.length,
      rowsOut: outRows.length,
      series: ordered.length,
      window: w,
      secondWindow: w2,
      warmupBlanks: warmupBlanks,
      partialWindows: partialWindows,
      dateGaps: dateGaps,
      largestGapDays: largestGapDays,
      crossUp: crossUp,
      crossDown: crossDown,
      nonNumeric: nonNumeric,
      unreadableOrder: unreadableOrder,
    },
    notes: notes,
  });
}

/** One plain sentence for the panel header. */
export function describeMovingAverage(result) {
  if (!result || !result.ok) return 'This did not run.';
  const s = result.stats || {};
  if (!s.rowsIn) return 'The table has no rows, so there is nothing to smooth.';
  const parts = ['A ' + s.window + ' row average'
    + (s.secondWindow ? ' and a ' + s.secondWindow + ' row average' : '') + ' over '
    + s.rowsOut.toLocaleString() + ' rows'
    + (s.series > 1 ? ' in ' + s.series + ' series' : '') + '.'];
  if (s.warmupBlanks) {
    parts.push(s.warmupBlanks.toLocaleString() + ' warm-up row'
      + (s.warmupBlanks === 1 ? '' : 's') + ' left blank.');
  }
  if (s.secondWindow) {
    parts.push((s.crossUp + s.crossDown) + ' crossing'
      + (s.crossUp + s.crossDown === 1 ? '' : 's') + ' marked.');
  }
  if (s.dateGaps) {
    parts.push(s.dateGaps.toLocaleString() + ' date gap'
      + (s.dateGaps === 1 ? '' : 's') + ', so the window is wider in days than in rows.');
  }
  return parts.join(' ');
}

export const DataGlowMovingAverage = {
  MOVING_AVERAGE_VERSION,
  MIN_WINDOW,
  LARGE_WINDOW_WARN,
  WARMUP_MODES,
  WARMUP_LABELS,
  CROSS_SIGNALS,
  createEmptyMovingAverageConfig,
  suggestMovingAverageConfig,
  validateMovingAverageConfig,
  averageColumnName,
  crossColumnName,
  hasCrossover,
  buildMovingAverageSQL,
  movingAverageTransform,
  describeMovingAverage,
};
