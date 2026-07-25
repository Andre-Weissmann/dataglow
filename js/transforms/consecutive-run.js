// ============================================================
// DATAGLOW - A21 Consecutive runs (gaps and islands)
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. "How many days in a row?" A member who trained eleven days
// straight, a machine that ran forty shifts without a stop, a patient on a drug
// for six weeks continuously. Every one of those is a streak, and a streak is
// not something a GROUP BY can count, because the answer depends on what is
// missing rather than on what is present.
//
// THE WHOLE TRANSFORM IS ONE IDEA. Sort each entity's active dates, then subtract
// a row number from the date. Inside an unbroken run that difference is constant,
// because both sides advance by one; the moment a day is skipped the difference
// jumps and a new run starts. That constant is the island id. It is the standard
// gaps-and-islands trick and it appears in the glass-box SQL in exactly that
// form, so the query a person reads is the method, not a paraphrase of it.
//
// A DUPLICATE DAY IS NOT A SECOND DAY, AND THIS IS WHERE THE COUNT GOES WRONG.
// Two rows for the same entity on the same date are one active day. A row number
// that counts them twice makes the date-minus-row-number difference drift by one
// inside a genuine run and splits it in half. So dates are collapsed to distinct
// days per entity before anything is numbered, the collapsing is counted, and the
// notes say how many rows it absorbed. Without that step this transform reports
// shorter streaks than the data contains and it does so silently.
//
// A STREAK OF ONE IS STILL A STREAK, AND SAYING SO MATTERS.
// A single active day is a run of length 1. Hiding those makes "average run
// length" a much larger number than the truth, because the short runs are
// exactly the ones dropped. They are kept by default and the minimum length is
// an explicit setting rather than a silent floor.
//
// WHAT "ACTIVE" MEANS IS THE PERSON'S DECISION, NOT THIS MODULE'S.
// A row counts toward a streak when its activity condition holds. That condition
// can be "this row exists", "this column is true", or a comparison against a
// value. Guessing it would be the one part of this nobody could check, so it is
// stated in the config, printed in the SQL WHERE clause, and repeated in the
// notes.
//
// AN OPEN RUN IS NOT A CLOSED ONE.
// The last run for an entity may still be going. Compared against an as-of date
// it is marked open, because "a 40 day streak that ended in March" and "a 40 day
// streak still running" are different facts and a table that renders them
// identically invites the wrong one.

import {
  quoteIdent,
  quoteLiteral,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  suggestDateColumn,
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
  TYPE_STR,
  TYPE_DATE,
  TYPE_BOOL,
  transformResult,
  transformError,
} from './transform-core.js';

export const CONSECUTIVE_RUN_VERSION = 1;

// How a row is judged active. "present" is the honest default: the row being in
// the table at all is the event.
export const ACTIVITY_MODES = Object.freeze(['present', 'truthy', 'equals', 'atLeast', 'greaterThan']);

export const ACTIVITY_LABELS = Object.freeze({
  present: 'Every row counts as an active day',
  truthy: 'Active when a column is true or non-zero',
  equals: 'Active when a column equals a value',
  atLeast: 'Active when a number is at or above a value',
  greaterThan: 'Active when a number is above a value',
});

// Values a spreadsheet export uses for false. Without this list a column of the
// string "FALSE" reads as active on every row, and the streaks come out as long
// as the table.
const FALSEY_TEXT = Object.freeze(['', '0', 'false', 'f', 'no', 'n', 'off', 'null', 'na', 'n/a']);

export function createEmptyRunConfig() {
  return {
    entityColumns: [],
    dateColumn: '',
    activity: 'present',
    activityColumn: '',
    activityValue: '',
    minLength: 1,
    asOf: '',
    longestOnly: false,
  };
}

export function suggestRunConfig(dataset) {
  const cfg = createEmptyRunConfig();
  const names = columnNamesOf(dataset);
  cfg.dateColumn = suggestDateColumn(dataset) || '';

  // The entity column should be the one that repeats most, since a streak needs
  // several rows per entity. A column that is unique per row produces nothing
  // but runs of length one, which would demonstrate the opposite of the point.
  const rows = rowsOf(dataset);
  let best = null;
  for (let i = 0; i < names.length; i += 1) {
    if (names[i] === cfg.dateColumn) continue;
    const seen = new Set();
    let looked = 0;
    for (let r = 0; r < rows.length && looked < 500; r += 1) {
      if (!Array.isArray(rows[r])) continue;
      looked += 1;
      seen.add(rows[r][i] == null ? '\u0000null' : String(rows[r][i]));
    }
    if (!looked || seen.size < 2 || seen.size >= looked) continue;
    const perEntity = looked / seen.size;
    if (!best || perEntity > best.perEntity) best = { name: names[i], perEntity: perEntity };
  }
  if (best) cfg.entityColumns = [best.name];
  return cfg;
}

export function validateRunConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  const entity = asColumnList(config.entityColumns);
  if (!entity.length) {
    errors.push('Pick the column that says whose streak this is. Without it every row in '
      + 'the table would be counted as one entity and the answer would be a single run.');
  }
  for (let i = 0; i < entity.length; i += 1) {
    if (!names.includes(entity[i])) errors.push('The column ' + entity[i] + ' is not in this table.');
  }

  if (!config.dateColumn) {
    errors.push('Pick the date column. Consecutive means consecutive in days, so this needs one.');
  } else if (!names.includes(config.dateColumn)) {
    errors.push('The date column ' + config.dateColumn + ' is not in this table.');
  } else if (entity.includes(config.dateColumn)) {
    errors.push('The date column cannot also be an entity column.');
  }

  const mode = String(config.activity || 'present');
  if (ACTIVITY_MODES.indexOf(mode) === -1) {
    errors.push('Choose how a row is judged active.');
  }
  if (mode !== 'present') {
    if (!config.activityColumn) {
      errors.push('Pick the column that says whether the row was active.');
    } else if (!names.includes(config.activityColumn)) {
      errors.push('The column ' + config.activityColumn + ' is not in this table.');
    }
  }
  if ((mode === 'atLeast' || mode === 'greaterThan') && toNumber(config.activityValue) === null) {
    errors.push('Give the number to compare against.');
  }
  if (mode === 'equals' && (config.activityValue === '' || config.activityValue == null)) {
    errors.push('Give the value a row must equal to count as active.');
  }

  const min = Number(config.minLength);
  if (config.minLength !== '' && config.minLength != null
    && (!Number.isFinite(min) || min < 1 || Math.floor(min) !== min)) {
    errors.push('The shortest run to report has to be a whole number of one or more.');
  }

  if (config.asOf && !parseDateValue(config.asOf)) {
    errors.push('The as-of date could not be read. Use a form like 2024-03-05.');
  }

  return { ok: errors.length === 0, errors: errors };
}

/** Whether one row counts as an active day, by the stated rule. */
export function isActiveRow(row, activityIdx, config) {
  const mode = String((config && config.activity) || 'present');
  if (mode === 'present') return true;
  if (activityIdx < 0) return false;
  const raw = row[activityIdx];

  if (mode === 'truthy') {
    if (raw == null) return false;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    return FALSEY_TEXT.indexOf(String(raw).trim().toLowerCase()) === -1;
  }
  if (mode === 'equals') {
    if (raw == null) return false;
    return String(raw).trim().toLowerCase()
      === String(config.activityValue == null ? '' : config.activityValue).trim().toLowerCase();
  }
  const n = toNumber(raw);
  const against = toNumber(config.activityValue);
  if (n === null || against === null) return false;
  if (mode === 'atLeast') return n >= against;
  return n > against;
}

/** The activity condition as one SQL predicate, so the glass-box query filters
    on exactly the rule the computed table used. */
export function activityPredicate(config) {
  const mode = String((config && config.activity) || 'present');
  if (mode === 'present') return '';
  const col = quoteIdent(config.activityColumn);
  if (mode === 'truthy') {
    return col + ' IS NOT NULL AND lower(trim(CAST(' + col + " AS VARCHAR))) NOT IN ('', '0', "
      + "'false', 'f', 'no', 'n', 'off', 'null', 'na', 'n/a')";
  }
  if (mode === 'equals') {
    return 'lower(trim(CAST(' + col + ' AS VARCHAR))) = lower(trim('
      + quoteLiteral(String(config.activityValue == null ? '' : config.activityValue)) + '))';
  }
  const op = mode === 'atLeast' ? '>=' : '>';
  return col + ' ' + op + ' ' + String(toNumber(config.activityValue));
}

/**
 * The glass-box SQL.
 *
 * Written as the actual island trick rather than a description of one: DISTINCT
 * the active days per entity, number them, and subtract the row number from the
 * date. Rows sharing an island key are one run. The DISTINCT is not decoration,
 * it is the step that stops a duplicated day splitting a real streak, and it is
 * commented as such because it is the line a reader is most likely to delete.
 */
export function buildConsecutiveRunSQL(config, sourceRelation) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const rel = relationName(sourceRelation, 'your_table');
  const entity = asColumnList(config.entityColumns);
  const keys = entity.map(quoteIdent).join(', ');
  const dateCol = quoteIdent(config.dateColumn);
  const pred = activityPredicate(config);
  const min = Math.max(1, Math.floor(Number(config.minLength) || 1));
  const asOf = config.asOf ? parseDateValue(config.asOf) : null;

  const lines = [
    '-- Consecutive runs of active days per ' + (keys || 'table') + '.',
    '-- The method is date minus row number. Inside an unbroken run both advance by',
    '-- one, so the difference is constant and identifies the run. A skipped day makes',
    '-- it jump, which is where one run ends and the next begins.',
    'WITH active_days AS (',
    '  -- DISTINCT is load-bearing. Two rows on one date are one active day; counting',
    '  -- them twice would drift the row number and split a real streak in half.',
    '  SELECT DISTINCT ' + (keys ? keys + ', ' : '') + 'CAST(' + dateCol + ' AS DATE) AS day',
    '  FROM ' + rel,
    '  WHERE ' + dateCol + ' IS NOT NULL' + (pred ? '\n    AND (' + pred + ')' : ''),
    '), islands AS (',
    '  SELECT *,',
    '    day - CAST(ROW_NUMBER() OVER (',
    '      ' + (keys ? 'PARTITION BY ' + keys + ' ' : '') + 'ORDER BY day',
    "    ) AS INTEGER) * INTERVAL '1 day' AS island_key",
    '  FROM active_days',
    ')',
    'SELECT ' + (keys ? keys + ',' : ''),
    '  MIN(day) AS run_start,',
    '  MAX(day) AS run_end,',
    '  COUNT(*) AS run_days',
  ];
  if (asOf) {
    lines.push('  , MAX(day) >= DATE ' + quoteLiteral(formatISODate(asOf)) + ' AS still_running');
  }
  lines.push('FROM islands');
  lines.push('GROUP BY ' + (keys ? keys + ', island_key' : 'island_key'));
  if (min > 1) {
    lines.push('HAVING COUNT(*) >= ' + min);
  }
  lines.push('ORDER BY run_days DESC' + (keys ? ', ' + keys : '') + ', run_start');

  if (min <= 1) {
    lines.push('');
    lines.push('-- Runs of a single day are included. Dropping them would make an average run');
    lines.push('-- length far longer than the truth, because the short runs are exactly the');
    lines.push('-- ones removed.');
  }
  return { ok: true, sql: lines.join('\n') };
}

export function consecutiveRunTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateRunConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const entity = asColumnList(config.entityColumns);
  const entityIdxs = entity.map((n) => indexOfColumn(names, n));
  const dateIdx = indexOfColumn(names, config.dateColumn);
  const activityIdx = config.activityColumn ? indexOfColumn(names, config.activityColumn) : -1;
  const min = Math.max(1, Math.floor(Number(config.minLength) || 1));
  const asOf = config.asOf ? parseDateValue(config.asOf) : null;
  const longestOnly = config.longestOnly === true;

  const srcRows = rowsOf(dataset);
  const groups = new Map();
  let inactive = 0;
  let unreadableDates = 0;
  let duplicateDays = 0;

  for (let i = 0; i < srcRows.length; i += 1) {
    const row = srcRows[i];
    if (!Array.isArray(row)) continue;
    if (!isActiveRow(row, activityIdx, config)) { inactive += 1; continue; }
    const d = parseDateValue(row[dateIdx]);
    if (!d) { unreadableDates += 1; continue; }

    const key = keyOfRow(row, entityIdxs);
    let g = groups.get(key);
    if (!g) {
      g = { key: key, label: entityIdxs.map((ix) => row[ix]), days: new Map(), seq: groups.size };
      groups.set(key, g);
    }
    const iso = formatISODate(d);
    // The collapse that keeps a duplicated day from splitting a streak. Counted
    // rather than absorbed silently, because a table with many of these is a
    // table where somebody's export ran twice.
    if (g.days.has(iso)) { duplicateDays += 1; continue; }
    g.days.set(iso, d);
  }

  const outColumns = entity.map((n) => column(n, typeOfColumn(dataset, n)))
    .concat([
      column('run_start', TYPE_DATE),
      column('run_end', TYPE_DATE),
      column('run_days', TYPE_INT),
    ]);
  if (asOf) outColumns.push(column('still_running', TYPE_BOOL));
  if (!entity.length) outColumns.unshift(column('group', TYPE_STR));

  const ordered = Array.from(groups.values()).sort((a, b) => a.seq - b.seq);
  const outRows = [];
  let runsFound = 0;
  let runsHidden = 0;
  let openRuns = 0;
  let longest = 0;
  let totalRunDays = 0;
  let singleDayRuns = 0;
  let entitiesWithRun = 0;

  for (let k = 0; k < ordered.length; k += 1) {
    const g = ordered[k];
    const isos = Array.from(g.days.keys()).sort();
    const runs = [];
    let start = 0;
    for (let i = 1; i <= isos.length; i += 1) {
      const broken = i === isos.length
        || daysBetween(g.days.get(isos[i - 1]), g.days.get(isos[i])) !== 1;
      if (broken) {
        runs.push({ start: isos[start], end: isos[i - 1], days: i - start });
        start = i;
      }
    }
    if (!runs.length) continue;
    entitiesWithRun += 1;

    let keep = runs;
    if (longestOnly) {
      // Ties on length go to the earlier run, which is at least stated rather
      // than being whichever the sort happened to leave first.
      let pickIdx = 0;
      for (let i = 1; i < runs.length; i += 1) {
        if (runs[i].days > runs[pickIdx].days) pickIdx = i;
      }
      keep = [runs[pickIdx]];
      runsHidden += runs.length - 1;
    }

    for (let i = 0; i < keep.length; i += 1) {
      const r = keep[i];
      runsFound += 1;
      totalRunDays += r.days;
      if (r.days === 1) singleDayRuns += 1;
      if (r.days > longest) longest = r.days;
      if (r.days < min) { runsHidden += 1; continue; }
      const open = asOf ? daysBetween(parseDateValue(r.end), asOf) <= 0 : false;
      if (open) openRuns += 1;
      const base = entity.length ? g.label.slice() : [g.key];
      const out = base.concat([r.start, r.end, r.days]);
      if (asOf) out.push(open);
      outRows.push(out);
    }
  }

  // Longest first: the question behind this transform is almost always "who has
  // the longest", and making that the first row saves a sort nobody thinks to do.
  const lenIdx = outColumns.length - (asOf ? 2 : 1);
  outRows.sort((a, b) => (b[lenIdx] - a[lenIdx]) || String(a[0]).localeCompare(String(b[0])));

  const built = buildConsecutiveRunSQL(config, dataset.name);
  const notes = [];

  if (!runsFound) {
    notes.push('No run was found. Either no row met the activity condition, or no date could '
      + 'be read in ' + config.dateColumn + '. This is a real answer about the table rather '
      + 'than an error, but it is worth checking the condition before believing it.');
  } else {
    notes.push('The longest run is ' + longest + ' day' + (longest === 1 ? '' : 's') + ', across '
      + entitiesWithRun + ' ' + (entity.length ? entity.join(', ') : 'group')
      + ' value' + (entitiesWithRun === 1 ? '' : 's') + ' that had at least one active day.');
  }

  if (duplicateDays > 0) {
    notes.push(duplicateDays + ' row' + (duplicateDays === 1 ? '' : 's')
      + ' repeated a date that was already counted for the same entity and '
      + (duplicateDays === 1 ? 'was' : 'were') + ' collapsed into the single active day '
      + (duplicateDays === 1 ? 'it' : 'they') + ' represents. This step is why the run lengths '
      + 'below are day counts and not row counts. A large number here usually means an export '
      + 'ran more than once.');
  }
  if (singleDayRuns > 0 && min <= 1) {
    notes.push(singleDayRuns + ' of the runs '
      + (singleDayRuns === 1 ? 'is' : 'are') + ' a single day long and '
      + (singleDayRuns === 1 ? 'is' : 'are') + ' included. An average taken over these rows is '
      + 'the honest average; leaving them out would raise it by removing exactly the short runs.');
  }
  if (runsHidden > 0) {
    notes.push(runsHidden + ' run' + (runsHidden === 1 ? ' was' : 's were') + ' found but not '
      + 'shown, because of the ' + (longestOnly ? 'longest-run-only setting' : 'minimum length of '
        + min) + '. They still exist in the data, so any total taken from this table is a total '
      + 'over the runs shown and not over the table.');
  }
  if (asOf) {
    notes.push(openRuns + ' run' + (openRuns === 1 ? '' : 's') + ' reach '
      + formatISODate(asOf) + ' and '
      + (openRuns === 1 ? 'is' : 'are') + ' marked still_running. A streak that is still going '
      + 'and one that ended are different facts, and a run marked open will be longer tomorrow.');
  } else {
    notes.push('No as-of date was given, so no run is marked as still running. The last run for '
      + 'each entity may simply be the point where the data stops rather than where the activity '
      + 'stopped.');
  }
  if (inactive > 0) {
    notes.push(inactive + ' row' + (inactive === 1 ? '' : 's') + ' did not meet the condition "'
      + (ACTIVITY_LABELS[String(config.activity || 'present')] || 'active')
      + '" and ' + (inactive === 1 ? 'was' : 'were') + ' treated as a gap. A gap is what breaks '
      + 'a run, so this count is the other half of every number above.');
  }
  if (unreadableDates > 0) {
    notes.push(unreadableDates + ' active row' + (unreadableDates === 1 ? '' : 's') + ' had no '
      + 'readable date and could not be placed in any run. Those days are missing from the '
      + 'streaks rather than breaking them, which means a run here could be shorter than the '
      + 'truth, not longer.');
  }

  return transformResult({
    columns: outColumns,
    rows: outRows,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: srcRows.length,
      rowsOut: outRows.length,
      entities: ordered.length,
      entitiesWithRun: entitiesWithRun,
      runsFound: runsFound,
      runsHidden: runsHidden,
      longestRun: longest,
      singleDayRuns: singleDayRuns,
      averageRun: runsFound ? totalRunDays / runsFound : 0,
      openRuns: openRuns,
      inactiveRows: inactive,
      duplicateDays: duplicateDays,
      unreadableDates: unreadableDates,
    },
    notes: notes,
  });
}

/** One plain sentence for the panel header. */
export function describeConsecutiveRun(result) {
  if (!result || !result.ok) return 'This did not run.';
  const s = result.stats || {};
  if (!s.rowsIn) return 'The table has no rows, so there is no run to find.';
  if (!s.runsFound) return 'No active day was found, so there is no run to report.';
  const avg = Math.round(s.averageRun * 10) / 10;
  return s.runsFound.toLocaleString() + ' run' + (s.runsFound === 1 ? '' : 's') + ' found. The '
    + 'longest is ' + s.longestRun.toLocaleString() + ' day'
    + (s.longestRun === 1 ? '' : 's') + ', the average is ' + avg + '.'
    + (s.duplicateDays ? ' ' + s.duplicateDays.toLocaleString() + ' repeated date'
      + (s.duplicateDays === 1 ? '' : 's') + ' collapsed first.' : '');
}

export const DataGlowConsecutiveRun = {
  CONSECUTIVE_RUN_VERSION,
  ACTIVITY_MODES,
  ACTIVITY_LABELS,
  createEmptyRunConfig,
  suggestRunConfig,
  validateRunConfig,
  isActiveRow,
  activityPredicate,
  buildConsecutiveRunSQL,
  consecutiveRunTransform,
  describeConsecutiveRun,
};
