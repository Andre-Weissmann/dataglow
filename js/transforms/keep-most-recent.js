// ============================================================
// DATAGLOW - A29 Keep the most recent record per group
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. A table has a customer three times because they were
// exported three times, or a patient twice because two systems fed the same
// registry. You want one row each, the newest. This is the single most common
// cleaning step before any count, because "how many customers" over a table with
// duplicates is wrong in a way nobody notices until two reports disagree.
//
// THIS IS A DELETION, WHICH MAKES IT DIFFERENT FROM A20.
// js/transforms/first-last-event.js answers a question: "what was each entity's
// latest event?" The dropped rows were never wanted. Here the dropped rows were
// part of the table a moment ago, and the whole risk is that they were not
// duplicates at all. So the two modules share their ordering rules, deliberately,
// through sortableOrderValue and compareValues in transform-core, and then part
// ways on what they report: A20 reports the events it found, and this reports
// what it destroyed.
//
// THE NUMBER THAT MATTERS IS NOT "ROWS REMOVED", IT IS "ROWS REMOVED THAT
// DISAGREED".
// Dropping an exact copy of a row loses nothing. Dropping a row that shared the
// key but held a different address, a different amount, a different diagnosis is
// throwing away a fact. Those two cases have the same row count and are not the
// same event, so this counts them separately and names the columns where the
// discarded rows disagreed with the row that was kept. That list is the actual
// output worth reading: it says whether this was a de-duplication or a choice.
//
// TIES ARE STILL THE HARD PART, AND THE RULE IS THE SAME ONE.
// Two rows for one key with the same timestamp: the winner is decided by every
// remaining column in table order, which is total, identical in the JS and in the
// SQL, and identical run to run. It is also arbitrary, and when it happens the
// notes say so, because deterministic is not the same as correct.
//
// A ROW WITH NO READABLE ORDER VALUE IS NOT SILENTLY DELETED.
// It cannot be the most recent anything. By default such rows are kept, because
// dropping a row on the grounds that its date was mistyped is a data loss the
// person did not ask for. Dropping them is available and stated.

import {
  quoteIdent,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  suggestDateColumn,
  isPlainObject,
  asColumnList,
  keyOfRow,
  sortableOrderValue,
  compareSortable,
  compareValues,
  column,
  typeOfColumn,
  isDateType,
  TYPE_INT,
  transformResult,
  transformError,
} from './transform-core.js';

export const KEEP_MOST_RECENT_VERSION = 1;

export const KEEP_PICKS = Object.freeze(['newest', 'oldest']);

export const KEEP_PICK_LABELS = Object.freeze({
  newest: 'Keep the newest',
  oldest: 'Keep the oldest',
});

// What happens to a row whose order value cannot be read. Keeping is the default
// because this transform deletes, and a deletion caused by a typo in a date is
// the worst outcome available here.
export const UNDATED_MODES = Object.freeze(['keep', 'drop']);

export const UNDATED_LABELS = Object.freeze({
  keep: 'Keep rows with no readable date',
  drop: 'Drop rows with no readable date',
});

// A sentinel so a blank cell and a missing one are not counted as the same
// value while looking for a column that repeats. Written as an escape rather
// than a literal control byte, which would be invisible in review and would
// travel into the one big inline script in canvas/index.html.
const NULL_TALLY = '\u0000null';

export function createEmptyKeepConfig() {
  return {
    keyColumns: [],
    orderColumn: '',
    pick: 'newest',
    undated: 'keep',
    includeDroppedCount: true,
  };
}

export function suggestKeepConfig(dataset) {
  const cfg = createEmptyKeepConfig();
  const names = columnNamesOf(dataset);
  const rows = rowsOf(dataset);
  cfg.orderColumn = suggestDateColumn(dataset) || '';

  // Suggest the column that actually repeats, since a key with no duplicates
  // makes this a no-op and the first thing shown should demonstrate the point.
  // An id column that is unique per row is exactly the wrong suggestion.
  let best = null;
  for (let i = 0; i < names.length; i += 1) {
    if (names[i] === cfg.orderColumn) continue;
    const seen = new Set();
    let looked = 0;
    for (let r = 0; r < rows.length && looked < 500; r += 1) {
      if (!Array.isArray(rows[r])) continue;
      looked += 1;
      seen.add(rows[r][i] == null ? NULL_TALLY : String(rows[r][i]));
    }
    if (!looked || seen.size < 2 || seen.size >= looked) continue;
    const dupes = looked - seen.size;
    if (!best || dupes > best.dupes) best = { name: names[i], dupes: dupes };
  }
  if (best) cfg.keyColumns = [best.name];
  else cfg.keyColumns = names.filter((n) => n !== cfg.orderColumn).slice(0, 1);
  return cfg;
}

export function validateKeepConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  const keys = asColumnList(config.keyColumns);
  if (!keys.length) {
    errors.push('Pick the column or columns that say which rows are the same thing. '
      + 'Without them this would keep one row for the whole table.');
  }
  for (let i = 0; i < keys.length; i += 1) {
    if (!names.includes(keys[i])) {
      errors.push('The column ' + keys[i] + ' is not in this table.');
    }
  }

  if (!config.orderColumn) {
    errors.push('Pick the column that says which row is more recent.');
  } else if (!names.includes(config.orderColumn)) {
    errors.push('The order column ' + config.orderColumn + ' is not in this table.');
  } else if (keys.includes(config.orderColumn)) {
    errors.push('The order column cannot also be one of the key columns. '
      + 'If it were, every row would already be its own group and nothing would be removed.');
  }

  if (config.pick && KEEP_PICKS.indexOf(config.pick) === -1) {
    errors.push('Choose whether the newest or the oldest row is kept.');
  }
  if (config.undated && UNDATED_MODES.indexOf(config.undated) === -1) {
    errors.push('Choose what happens to rows with no readable date.');
  }

  return { ok: errors.length === 0, errors: errors };
}

/** Every column that is neither a key column nor the order column, in table
    order. These are both the tie-break and the columns worth comparing when a
    discarded row disagreed with the kept one. */
export function comparableColumns(columnNames, config) {
  const names = Array.isArray(columnNames) ? columnNames : [];
  const keys = asColumnList(config && config.keyColumns);
  const orderColumn = (config && config.orderColumn) || '';
  return names.filter((n) => n !== orderColumn && !keys.includes(n));
}

/**
 * The glass-box SQL.
 *
 * QUALIFY on ROW_NUMBER, with the whole tie-break written into the ORDER BY
 * rather than left implicit, so the query a person reads returns these exact
 * rows. Without the tie-break columns the same query is free to keep a different
 * row on the next run, and a de-duplication that is not reproducible is not a
 * cleaning step, it is a coin toss.
 */
export function buildKeepMostRecentSQL(config, sourceRelation, columnNames) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const rel = relationName(sourceRelation, 'your_table');
  const keys = asColumnList(config.keyColumns);
  const pick = String(config.pick || 'newest').toLowerCase();
  const dir = pick === 'oldest' ? 'ASC' : 'DESC';
  const orderCol = quoteIdent(config.orderColumn);
  const dropUndated = config.undated === 'drop';

  // NULLS LAST in both directions: a row with no order value must never win the
  // slot, which is what the computed result does too.
  const orderParts = [orderCol + ' ' + dir + ' NULLS LAST'];
  const tie = comparableColumns(columnNames, config);
  for (let i = 0; i < tie.length; i += 1) {
    orderParts.push(quoteIdent(tie[i]) + ' ' + dir + ' NULLS LAST');
  }

  const over = 'ROW_NUMBER() OVER (\n'
    + (keys.length ? '    PARTITION BY ' + keys.map(quoteIdent).join(', ') + '\n' : '')
    + '    ORDER BY ' + orderParts.join(', ') + '\n  )';

  const lines = [
    '-- Keep one row per ' + (keys.length ? keys.map(quoteIdent).join(', ') : 'table')
      + ', the ' + (pick === 'oldest' ? 'oldest' : 'newest') + ' by ' + orderCol + '.',
    '-- This deletes rows. Rows sharing a key are only duplicates if they agree on',
    '-- their other columns; where they disagree, the ones dropped here held facts',
    '-- that are now gone. The computed result names those columns.',
    '-- Ties on ' + orderCol + ' are broken by every remaining column in table order,',
    '-- so this keeps the same row on every run rather than whichever the engine',
    '-- reached first. Repeatable, and still arbitrary.',
    'SELECT * EXCLUDE (keep_rank) FROM (',
    '  SELECT *,',
    '  ' + over + ' AS keep_rank',
    '  FROM ' + rel,
  ];
  if (dropUndated) {
    lines.push('  WHERE ' + orderCol + ' IS NOT NULL');
  }
  lines.push(')');
  lines.push('WHERE keep_rank = 1');
  lines.push('ORDER BY ' + (keys.length ? keys.map(quoteIdent).join(', ') : orderCol));

  if (!dropUndated) {
    lines.push('');
    lines.push('-- Rows with no ' + config.orderColumn + ' are kept in the running above rather');
    lines.push('-- than filtered out, and NULLS LAST stops them winning a slot a dated row');
    lines.push('-- could take. A key whose every row is undated still keeps one, because');
    lines.push('-- deleting an entity outright over an unreadable date is not a cleaning step.');
  }

  return { ok: true, sql: lines.join('\n') };
}

export function keepMostRecentTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateKeepConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const keys = asColumnList(config.keyColumns);
  const keyIdxs = keys.map((k) => indexOfColumn(names, k));
  const orderIdx = indexOfColumn(names, config.orderColumn);
  const orderIsDate = isDateType(typeOfColumn(dataset, config.orderColumn));
  const pick = String(config.pick || 'newest').toLowerCase();
  const dropUndated = config.undated === 'drop';
  const withCount = config.includeDroppedCount !== false;
  const compareCols = comparableColumns(names, config);
  const compareIdxs = compareCols.map((n) => indexOfColumn(names, n));

  const srcRows = rowsOf(dataset);
  const groups = new Map();
  let undatedRows = 0;
  let droppedUndated = 0;

  for (let i = 0; i < srcRows.length; i += 1) {
    const row = srcRows[i];
    if (!Array.isArray(row)) continue;
    const sort = sortableOrderValue(row[orderIdx], orderIsDate);
    if (sort === null) {
      undatedRows += 1;
      if (dropUndated) { droppedUndated += 1; continue; }
    }
    const key = keyOfRow(row, keyIdxs);
    let g = groups.get(key);
    if (!g) { g = { key: key, rows: [], seq: groups.size }; groups.set(key, g); }
    g.rows.push({ row: row, sort: sort });
  }

  const sign = pick === 'oldest' ? 1 : -1;
  const outColumns = names.map((n) => column(n, typeOfColumn(dataset, n)));
  if (withCount) outColumns.push(column('rows_dropped', TYPE_INT));

  // Groups come out in the order they were first seen, not sorted by key: a
  // cleaning step that also silently reorders the table makes a diff against the
  // original unreadable.
  const ordered = Array.from(groups.values()).sort((a, b) => a.seq - b.seq);
  const outRows = [];
  let removed = 0;
  let tiedGroups = 0;
  let conflictedGroups = 0;
  const conflictColumns = new Map();

  for (let k = 0; k < ordered.length; k += 1) {
    const g = ordered[k];
    g.rows.sort((a, b) => {
      // An undated row never wins, in either direction. This is the JS form of
      // NULLS LAST, and it is why the comparison cannot just be sign * compare.
      if (a.sort === null && b.sort === null) return 0;
      if (a.sort === null) return 1;
      if (b.sort === null) return -1;
      const c = compareSortable(a.sort, b.sort);
      if (c !== 0) return sign * c;
      for (let t = 0; t < compareIdxs.length; t += 1) {
        const tc = compareValues(a.row[compareIdxs[t]], b.row[compareIdxs[t]]);
        if (tc !== 0) return sign * tc;
      }
      return 0;
    });

    const kept = g.rows[0];
    const dropped = g.rows.length - 1;
    removed += dropped;

    if (g.rows.length > 1 && kept.sort !== null && g.rows[1].sort !== null
      && compareSortable(kept.sort, g.rows[1].sort) === 0) {
      tiedGroups += 1;
    }

    // The distinction the whole module turns on: was the dropped row a copy, or
    // did it hold something different?
    let conflicted = false;
    for (let r = 1; r < g.rows.length; r += 1) {
      for (let t = 0; t < compareIdxs.length; t += 1) {
        if (compareValues(kept.row[compareIdxs[t]], g.rows[r].row[compareIdxs[t]]) !== 0) {
          conflicted = true;
          const name = compareCols[t];
          conflictColumns.set(name, (conflictColumns.get(name) || 0) + 1);
        }
      }
    }
    if (conflicted) conflictedGroups += 1;

    outRows.push(withCount ? kept.row.concat([dropped]) : kept.row.slice());
  }

  const built = buildKeepMostRecentSQL(config, dataset.name, names);
  const notes = [];
  const word = pick === 'oldest' ? 'oldest' : 'newest';
  const conflictList = Array.from(conflictColumns.keys());

  if (removed === 0) {
    notes.push('No row was removed: every combination of '
      + keys.join(', ') + ' appears once already. Nothing was lost, and nothing was gained '
      + 'either, which is worth knowing before this step is added to a routine.');
  } else {
    notes.push(removed + ' row' + (removed === 1 ? ' was' : 's were') + ' removed. This is a '
      + 'deletion, not a filter: the values in those rows are not in the result and cannot be '
      + 'recovered from it. Undo restores them.');
  }

  if (conflictedGroups > 0) {
    notes.push(conflictedGroups + ' group' + (conflictedGroups === 1 ? '' : 's')
      + ' had rows that disagreed with the row kept, in: ' + conflictList.join(', ')
      + '. Those are not duplicate records, they are different records sharing a key, and the '
      + 'earlier values have now been discarded. If any of those columns matters, this was a '
      + 'choice about the data rather than a tidy-up, and it is worth looking at those groups '
      + 'before moving on.');
  } else if (removed > 0) {
    notes.push('Every removed row agreed with the row kept on all its other columns, so nothing '
      + 'beyond the duplicate rows themselves was lost.');
  }

  if (tiedGroups > 0) {
    notes.push(tiedGroups + ' group' + (tiedGroups === 1 ? '' : 's') + ' had two or more rows '
      + 'sharing the same ' + config.orderColumn + '. The row kept was chosen by comparing the '
      + 'remaining columns in table order, which gives the same answer every run but is arbitrary: '
      + 'when two records genuinely share a timestamp, no rule recovers which one is current.');
  }
  if (undatedRows > 0) {
    notes.push(undatedRows + ' row' + (undatedRows === 1 ? '' : 's') + ' had no readable value in '
      + config.orderColumn + (dropUndated
        ? ' and ' + (undatedRows === 1 ? 'was' : 'were') + ' dropped, as configured. That is a '
          + 'deletion on the strength of an unreadable date, so it is worth confirming those rows '
          + 'were not simply mistyped.'
        : '. They cannot be the ' + word + ' record, so they never win a group that has a dated '
          + 'row. A group where every row is undated still keeps one, rather than losing the '
          + 'entity entirely.'));
  }
  if (withCount) {
    notes.push('The rows_dropped column says how many rows each kept row stands for. A value above '
      + 'zero means that row is a survivor rather than a sole record, which is the difference '
      + 'between "one customer" and "one customer, three times".');
  }
  notes.push('Counts over this table now mean something different: one row per '
    + keys.join(', ') + ' rather than one row per record. A sum of a value column will be smaller, '
    + 'correctly if the duplicates were duplicates, and wrongly if they were separate events.');

  return transformResult({
    columns: outColumns,
    rows: outRows,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: srcRows.length,
      rowsOut: outRows.length,
      groups: ordered.length,
      removed: removed,
      conflictedGroups: conflictedGroups,
      conflictColumns: conflictList,
      tiedGroups: tiedGroups,
      undatedRows: undatedRows,
      droppedUndated: droppedUndated,
      pick: pick,
    },
    notes: notes,
  });
}

/** One plain sentence for the panel header. Leads with what is removed, because
    this transform's consequence is a deletion. */
export function describeKeepMostRecent(result) {
  if (!result || !result.ok) return 'This did not run.';
  const s = result.stats || {};
  if (!s.rowsIn) return 'The table has no rows, so there is nothing to de-duplicate.';
  if (!s.removed) {
    return 'No rows would be removed: each key appears once already.';
  }
  const conflict = s.conflictedGroups
    ? ' ' + s.conflictedGroups + ' group' + (s.conflictedGroups === 1 ? '' : 's')
      + ' had rows that disagreed with the one kept, so real values are discarded.'
    : ' Every removed row was an exact match on its other columns.';
  return s.rowsIn.toLocaleString() + ' rows become ' + s.rowsOut.toLocaleString() + ', removing '
    + s.removed.toLocaleString() + ' row' + (s.removed === 1 ? '' : 's') + '.' + conflict;
}

export const DataGlowKeepMostRecent = {
  KEEP_MOST_RECENT_VERSION,
  KEEP_PICKS,
  KEEP_PICK_LABELS,
  UNDATED_MODES,
  UNDATED_LABELS,
  createEmptyKeepConfig,
  suggestKeepConfig,
  validateKeepConfig,
  comparableColumns,
  buildKeepMostRecentSQL,
  keepMostRecentTransform,
  describeKeepMostRecent,
};
