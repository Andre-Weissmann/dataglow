// ============================================================
// DATAGLOW - A19 Join on date range
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. "Which price list / campaign / shift / contract was in
// force when this event happened?" One table has events with a date. The other
// has rows that are valid over a span. This joins them where the event date
// falls inside the span.
//
// WHY THIS IS THE DANGEROUS KIND OF JOIN.
// An equality join on a key can only ever give you as many rows as the key
// allows, and everyone already expects a duplicate key to duplicate rows. A
// range join has no such intuition attached. If two reference ranges overlap by
// a single day, every event on that day silently becomes two rows, and the total
// afterwards is quietly larger than the total before. Nobody notices, because
// each individual row looks correct.
//
// So this module refuses to be a one-shot. previewDateRangeJoin() counts what
// would happen (matched, unmatched, the worst fanout, the ranges that overlap)
// without producing rows, and that preview is meant to be shown before anyone
// confirms. The fanout number is the headline, not a footnote.
//
// TWO BOUNDARY DECISIONS, BOTH STATED OUT LOUD RATHER THAN GUESSED.
//   1. An empty end date means STILL IN FORCE, not "matches nothing". A current
//      price row with no end date is the normal way to represent "current", and
//      reading it as a closed empty span would drop exactly the rows a person
//      cares most about. Set openEndedEnd to false to read a blank end as a row
//      that cannot match.
//   2. Bounds are inclusive on both sides by default, so an event on the exact
//      end date matches. That is the more common intent, and it is the ambiguity
//      most likely to cause a quiet off-by-one-day, so both the notes and the
//      generated SQL say which rule was applied.

import {
  quoteIdent,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  suggestDateColumn,
  parseDateValue,
  formatISODate,
  isPlainObject,
  keyOfRow,
  column,
  typeOfColumn,
  transformResult,
  transformError,
} from './transform-core.js';

export const DATE_RANGE_JOIN_VERSION = 1;

// Above this many output rows per input row on average, the join is reshaping
// the table rather than annotating it, which is worth saying plainly before a
// person confirms. Not a hard limit: the preview warns, the human decides.
export const FANOUT_WARN_RATIO = 1.5;

export function createEmptyDateRangeJoinConfig() {
  return {
    eventDateColumn: '',
    rangeStartColumn: '',
    rangeEndColumn: '',
    keyPairs: [],
    openEndedEnd: true,
    inclusiveEnd: true,
    keepUnmatched: true,
    rightSuffix: '_range',
  };
}

/** A starting point from the two tables' own shapes. A suggestion only. */
export function suggestDateRangeJoinConfig(eventDataset, rangeDataset) {
  const cfg = createEmptyDateRangeJoinConfig();
  cfg.eventDateColumn = suggestDateColumn(eventDataset) || '';
  const rangeNames = columnNamesOf(rangeDataset);
  cfg.rangeStartColumn = pickByHint(rangeNames, ['start', 'from', 'effective', 'valid_from', 'begin'])
    || suggestDateColumn(rangeDataset) || '';
  cfg.rangeEndColumn = pickByHint(rangeNames, ['end', 'to', 'until', 'valid_to', 'expiry', 'expires'])
    || '';
  return cfg;
}

function pickByHint(names, hints) {
  for (let h = 0; h < hints.length; h += 1) {
    for (let i = 0; i < names.length; i += 1) {
      if (String(names[i] || '').toLowerCase().includes(hints[h])) return names[i];
    }
  }
  return null;
}

export function validateDateRangeJoinConfig(config, eventNames, rangeNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const left = Array.isArray(eventNames) ? eventNames : [];
  const right = Array.isArray(rangeNames) ? rangeNames : [];

  if (!config.eventDateColumn) errors.push('Pick the date column on the events table.');
  else if (!left.includes(config.eventDateColumn)) {
    errors.push('The event date column ' + config.eventDateColumn + ' is not in the events table.');
  }

  if (!config.rangeStartColumn) errors.push('Pick the start-of-range column on the second table.');
  else if (!right.includes(config.rangeStartColumn)) {
    errors.push('The start column ' + config.rangeStartColumn + ' is not in the second table.');
  }

  // An absent end column is a legitimate configuration: every range is then
  // open-ended and the join means "at or after the start date".
  if (config.rangeEndColumn && !right.includes(config.rangeEndColumn)) {
    errors.push('The end column ' + config.rangeEndColumn + ' is not in the second table.');
  }

  const pairs = normalizeKeyPairs(config.keyPairs);
  for (let i = 0; i < pairs.length; i += 1) {
    if (!left.includes(pairs[i].left)) {
      errors.push('The matching column ' + pairs[i].left + ' is not in the events table.');
    }
    if (!right.includes(pairs[i].right)) {
      errors.push('The matching column ' + pairs[i].right + ' is not in the second table.');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

export function normalizeKeyPairs(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const p = value[i];
    if (!isPlainObject(p)) continue;
    const l = p.left == null ? '' : String(p.left);
    const r = p.right == null ? '' : String(p.right);
    if (l && r) out.push({ left: l, right: r });
  }
  return out;
}

/**
 * The glass-box SQL. A non-equi LEFT JOIN, written so the boundary rules are
 * visible rather than implied: the open-ended end appears as an explicit
 * `OR end IS NULL`, and the inclusive end appears as `<=` rather than `<`.
 */
export function buildDateRangeJoinSQL(config, eventRelation, rangeRelation) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };

  const l = relationName(eventRelation, 'events');
  const r = relationName(rangeRelation, 'ranges');
  const eventDate = 'e.' + quoteIdent(config.eventDateColumn);
  const startCol = 'r.' + quoteIdent(config.rangeStartColumn);
  const pairs = normalizeKeyPairs(config.keyPairs);
  const inclusiveEnd = config.inclusiveEnd !== false;
  const openEnded = config.openEndedEnd !== false;
  const keepUnmatched = config.keepUnmatched !== false;

  const onParts = pairs.map((p) => 'e.' + quoteIdent(p.left) + ' = r.' + quoteIdent(p.right));
  onParts.push(eventDate + ' >= ' + startCol);

  if (config.rangeEndColumn) {
    const endCol = 'r.' + quoteIdent(config.rangeEndColumn);
    const cmp = eventDate + (inclusiveEnd ? ' <= ' : ' < ') + endCol;
    onParts.push(openEnded ? '(' + cmp + ' OR ' + endCol + ' IS NULL)' : cmp);
  }

  const lines = [
    '-- Join on date range: the event date falls inside the span on ' + r,
    '-- ' + (inclusiveEnd ? 'The end date is INCLUDED: an event on the end date matches.'
      : 'The end date is EXCLUDED: an event on the end date does not match.'),
  ];
  if (config.rangeEndColumn && openEnded) {
    lines.push('-- A blank end date means still in force, so it matches any later event.');
  }
  if (!config.rangeEndColumn) {
    lines.push('-- No end column was chosen, so every range runs from its start onward.');
  }
  lines.push(
    '-- Overlapping ranges produce more than one row per event. That is a fanout,',
    '-- not an error, and the count is reported beside the result.',
    'SELECT e.*, r.*',
    'FROM ' + l + ' AS e',
    (keepUnmatched ? 'LEFT JOIN ' : 'INNER JOIN ') + r + ' AS r',
    '  ON ' + onParts.join('\n  AND '),
  );

  return { ok: true, sql: lines.join('\n') };
}

/**
 * Count what the join would do, without building the rows.
 *
 * This exists so the fanout is knowable before anyone confirms. It is the part
 * of A19 that earns the module: the join itself is four comparisons, while the
 * number of rows it will produce is the thing that actually surprises people.
 */
export function previewDateRangeJoin(eventDataset, rangeDataset, config) {
  const prep = prepare(eventDataset, rangeDataset, config);
  if (!prep.ok) return prep;

  let matchedEvents = 0;
  let unmatchedEvents = 0;
  let pairs = 0;
  let maxFanout = 0;
  let multiMatchEvents = 0;

  for (let i = 0; i < prep.eventRows.length; i += 1) {
    const hits = prep.matchesFor(prep.eventRows[i]);
    if (hits === null) { unmatchedEvents += 1; continue; }
    if (hits.length === 0) { unmatchedEvents += 1; continue; }
    matchedEvents += 1;
    pairs += hits.length;
    if (hits.length > maxFanout) maxFanout = hits.length;
    if (hits.length > 1) multiMatchEvents += 1;
  }

  const rowsIn = prep.eventRows.length;
  const rowsOut = pairs + (config.keepUnmatched !== false ? unmatchedEvents : 0);
  const ratio = rowsIn === 0 ? 0 : rowsOut / rowsIn;

  const warnings = [];
  if (multiMatchEvents > 0) {
    warnings.push(multiMatchEvents + ' of ' + rowsIn + ' event row'
      + (rowsIn === 1 ? '' : 's') + ' fall inside more than one range, so they will appear '
      + 'more than once. The most any single row matches is ' + maxFanout + '. '
      + 'If the ranges are not meant to overlap, that is a problem in the second table, '
      + 'not in this join.');
  }
  if (ratio > FANOUT_WARN_RATIO) {
    warnings.push('This join would turn ' + rowsIn + ' row' + (rowsIn === 1 ? '' : 's')
      + ' into ' + rowsOut + '. Any total you take afterwards will be larger than the '
      + 'same total before the join.');
  }
  if (unmatchedEvents > 0) {
    warnings.push(unmatchedEvents + ' event row' + (unmatchedEvents === 1 ? '' : 's')
      + ' fall outside every range'
      + (config.keepUnmatched !== false
        ? ' and will be kept with blank values from the second table.'
        : ' and will be dropped.'));
  }
  if (prep.unreadableEventDates > 0) {
    warnings.push(prep.unreadableEventDates + ' event row'
      + (prep.unreadableEventDates === 1 ? '' : 's')
      + ' had a date that could not be read, so they can match nothing. Check the format of '
      + config.eventDateColumn + '.');
  }
  if (prep.unreadableRangeBounds > 0) {
    warnings.push(prep.unreadableRangeBounds + ' row' + (prep.unreadableRangeBounds === 1 ? '' : 's')
      + ' in the second table had a start date that could not be read and were skipped.');
  }

  return {
    ok: true,
    stats: {
      rowsIn: rowsIn,
      rowsOut: rowsOut,
      matchedEvents: matchedEvents,
      unmatchedEvents: unmatchedEvents,
      pairs: pairs,
      maxFanout: maxFanout,
      multiMatchEvents: multiMatchEvents,
      fanoutRatio: ratio,
      unreadableEventDates: prep.unreadableEventDates,
      unreadableRangeBounds: prep.unreadableRangeBounds,
    },
    warnings: warnings,
  };
}

/** Do the work. Same result shape as every other transform here. */
export function dateRangeJoinTransform(eventDataset, rangeDataset, config) {
  const prep = prepare(eventDataset, rangeDataset, config);
  if (!prep.ok) return transformError(prep.errors.join(' '));

  const keepUnmatched = config.keepUnmatched !== false;
  const suffix = String(config.rightSuffix || '_range');
  const outColumns = prep.eventNames.map((n) => column(n, typeOfColumn(eventDataset, n)))
    .concat(prep.rangeNames.map((n) => column(
      prep.eventNames.includes(n) ? n + suffix : n,
      typeOfColumn(rangeDataset, n),
    )));

  const blankRight = prep.rangeNames.map(() => null);
  const outRows = [];
  let matchedEvents = 0;
  let unmatchedEvents = 0;
  let maxFanout = 0;
  let multiMatchEvents = 0;

  for (let i = 0; i < prep.eventRows.length; i += 1) {
    const row = prep.eventRows[i];
    const hits = prep.matchesFor(row);
    const list = hits === null ? [] : hits;
    if (list.length === 0) {
      unmatchedEvents += 1;
      if (keepUnmatched) outRows.push(row.concat(blankRight));
      continue;
    }
    matchedEvents += 1;
    if (list.length > maxFanout) maxFanout = list.length;
    if (list.length > 1) multiMatchEvents += 1;
    for (let h = 0; h < list.length; h += 1) {
      outRows.push(row.concat(list[h].values));
    }
  }

  const built = buildDateRangeJoinSQL(config, eventDataset && eventDataset.name, rangeDataset && rangeDataset.name);
  const preview = previewDateRangeJoin(eventDataset, rangeDataset, config);

  return transformResult({
    columns: outColumns,
    rows: outRows,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: prep.eventRows.length,
      rowsOut: outRows.length,
      matchedEvents: matchedEvents,
      unmatchedEvents: unmatchedEvents,
      maxFanout: maxFanout,
      multiMatchEvents: multiMatchEvents,
      unreadableEventDates: prep.unreadableEventDates,
      unreadableRangeBounds: prep.unreadableRangeBounds,
      inclusiveEnd: config.inclusiveEnd !== false,
      openEndedEnd: config.openEndedEnd !== false,
    },
    notes: preview.ok ? preview.warnings : [],
  });
}

/**
 * Shared setup for the preview and the join, so the two cannot disagree about
 * what matches. A preview that used different rules from the apply would be
 * worse than no preview at all.
 */
function prepare(eventDataset, rangeDataset, config) {
  if (!eventDataset || typeof eventDataset !== 'object') {
    return { ok: false, errors: ['There is no events table loaded.'] };
  }
  if (!rangeDataset || typeof rangeDataset !== 'object') {
    return { ok: false, errors: ['Pick a second table that holds the date ranges.'] };
  }
  const eventNames = columnNamesOf(eventDataset);
  const rangeNames = columnNamesOf(rangeDataset);
  const v = validateDateRangeJoinConfig(config, eventNames, rangeNames);
  if (!v.ok) return { ok: false, errors: v.errors };

  const pairs = normalizeKeyPairs(config.keyPairs);
  const eventDateIdx = indexOfColumn(eventNames, config.eventDateColumn);
  const startIdx = indexOfColumn(rangeNames, config.rangeStartColumn);
  const endIdx = config.rangeEndColumn ? indexOfColumn(rangeNames, config.rangeEndColumn) : -1;
  const leftKeyIdxs = pairs.map((p) => indexOfColumn(eventNames, p.left));
  const rightKeyIdxs = pairs.map((p) => indexOfColumn(rangeNames, p.right));
  const inclusiveEnd = config.inclusiveEnd !== false;
  const openEnded = config.openEndedEnd !== false;

  // Group the range rows by their key so a keyed join looks at only its own
  // candidates. Without a key every event has to consider every range, which is
  // correct but quadratic; with one it is usually a handful.
  const byKey = new Map();
  let unreadableRangeBounds = 0;
  const rangeRows = rowsOf(rangeDataset);
  for (let i = 0; i < rangeRows.length; i += 1) {
    const row = rangeRows[i];
    if (!Array.isArray(row)) continue;
    const start = parseDateValue(row[startIdx]);
    if (!start) { unreadableRangeBounds += 1; continue; }
    const rawEnd = endIdx >= 0 ? row[endIdx] : null;
    const endMissing = endIdx < 0 || rawEnd == null || rawEnd === '';
    let end = null;
    let isOpen;
    if (endMissing) {
      // No end column at all means every range runs onward. A blank end in a
      // real end column means "still in force" unless the person said otherwise,
      // in which case the row can match nothing and is dropped here.
      if (endIdx < 0) isOpen = true;
      else if (openEnded) isOpen = true;
      else continue;
    } else {
      end = parseDateValue(rawEnd);
      // An end that is present but unreadable is NOT treated as open: reading
      // "31/13/2024" as forever would silently extend a closed range.
      if (!end) { unreadableRangeBounds += 1; continue; }
      isOpen = false;
    }

    const key = keyOfRow(row, rightKeyIdxs);
    let list = byKey.get(key);
    if (!list) { list = []; byKey.set(key, list); }
    list.push({
      start: start.getTime(),
      end: end ? end.getTime() : null,
      open: isOpen,
      values: row.slice(),
      startISO: formatISODate(start),
    });
  }

  let unreadableEventDates = 0;
  const eventRows = rowsOf(eventDataset).filter((r) => Array.isArray(r));

  function matchesFor(row) {
    const d = parseDateValue(row[eventDateIdx]);
    if (!d) { unreadableEventDates += 1; return null; }
    const t = d.getTime();
    const candidates = byKey.get(keyOfRow(row, leftKeyIdxs));
    if (!candidates) return [];
    const hits = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const c = candidates[i];
      if (t < c.start) continue;
      if (!c.open) {
        if (inclusiveEnd ? t > c.end : t >= c.end) continue;
      }
      hits.push(c);
    }
    return hits;
  }

  // unreadableEventDates is only known after the caller has walked every row, so
  // it is a getter rather than a snapshot taken before the walk.
  return {
    ok: true,
    eventNames: eventNames,
    rangeNames: rangeNames,
    eventRows: eventRows,
    matchesFor: matchesFor,
    unreadableRangeBounds: unreadableRangeBounds,
    get unreadableEventDates() { return unreadableEventDates; },
  };
}

/** One plain sentence for the panel header. Leads with the fanout, because that
    is the number a person needs before they agree to anything. */
export function describeDateRangeJoin(result) {
  if (!result || !result.ok) return 'This join did not run.';
  const s = result.stats || {};
  if ((s.rowsIn || 0) === 0) return 'The events table has no rows, so there is nothing to join.';
  const base = (s.matchedEvents || 0) + ' of ' + s.rowsIn + ' event rows fall inside a range';
  if ((s.maxFanout || 0) > 1) {
    return base + ', and ' + s.rowsIn + ' rows became ' + s.rowsOut
      + ' because some fall inside more than one.';
  }
  return base + ', one row each.';
}

export const DataGlowDateRangeJoin = {
  DATE_RANGE_JOIN_VERSION,
  FANOUT_WARN_RATIO,
  createEmptyDateRangeJoinConfig,
  suggestDateRangeJoinConfig,
  validateDateRangeJoinConfig,
  normalizeKeyPairs,
  buildDateRangeJoinSQL,
  previewDateRangeJoin,
  dateRangeJoinTransform,
  describeDateRangeJoin,
};
