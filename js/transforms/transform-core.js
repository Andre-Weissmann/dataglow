// ============================================================
// DATAGLOW - Shared core for the time and join transforms (Bundle 6)
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB. Every function here is
// deterministic and Node-testable, which is the point: the four transforms in
// this directory all turn a loaded table plus a config into (a) the SQL a
// person can read and check, and (b) the rows that SQL would have produced.
// Both halves have to agree, so the shared vocabulary lives in one place.
//
// WHY THE ROWS ARE COMPUTED IN JS AND THE SQL IS ONLY SHOWN.
// This follows Guided Unpivot (js/intelligence/guided-unpivot.js), which is the
// house pattern for a confirm-gated transform: buildUnpivotSQL() renders the
// proof and unpivotTransform() does the work. Computing locally means the
// transform runs with no engine warm-up, works with Air-Gap Mode on, and can be
// tested without DuckDB. The SQL is not decoration: it is the glass-box
// statement of what was done, written so a person can paste it into the SQL tab
// and get the same answer.
//
// DATES ARE THE WHOLE PROBLEM.
// Every transform here compares dates, and a date column in a real file arrives
// as a string, a Date, or a number, sometimes with a time attached and sometimes
// not. parseDateValue() is deliberately strict and returns null rather than
// guessing, because a date silently misread by a day is exactly the class of
// wrong number this bundle exists to prevent. A row whose date cannot be read is
// never quietly dropped and never assumed: it is counted and reported.

export const TRANSFORM_CORE_VERSION = 1;

// The grains a period comparison can use. Kept small on purpose: quarter and
// year are easy to add but each needs its own honest prior-period rule, and an
// unfinished grain in the dropdown is worse than one that is not offered.
export const PERIOD_GRAINS = Object.freeze(['day', 'week', 'month']);

export const PERIOD_GRAIN_LABELS = Object.freeze({
  day: 'Day over day',
  week: 'Week over week',
  month: 'Month over month',
});

// House type vocabulary, uppercase, as used by guided-unpivot and the grid.
export const TYPE_INT = 'INT';
export const TYPE_FLOAT = 'FLOAT';
export const TYPE_STR = 'STR';
export const TYPE_DATE = 'DATE';
export const TYPE_BOOL = 'BOOL';

const NUMERIC_TYPES = Object.freeze(['INT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'BIGINT', 'NUMBER', 'NUMERIC']);
const DATE_TYPES = Object.freeze(['DATE', 'DATETIME', 'TIMESTAMP', 'TIME']);

/* ---------------------------- identifiers -------------------------------- */

/** Double-quote an identifier, escaping internal quotes. Same as the house
    quoteIdent() in guided-unpivot.js and q() in join-builder/join-sql.js. */
export function quoteIdent(name) {
  return '"' + String(name == null ? '' : name).replace(/"/g, '""') + '"';
}

/** Single-quote a literal for the glass-box SQL. Only ever used on values this
    module generated (period keys, grain names), never on raw cell data, but it
    escapes anyway so a hand-edited config cannot produce broken SQL. */
export function quoteLiteral(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
}

/** A relation name safe to interpolate. A dataset name with a quote or a
    newline in it would otherwise produce SQL that does not parse. */
export function relationName(name, fallback) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return quoteIdent(fallback || 'source');
  return quoteIdent(raw);
}

/* ------------------------------ columns ---------------------------------- */

export function columnNamesOf(dataset) {
  const cols = (dataset && dataset.columns) || [];
  return cols.map((c) => (c && typeof c === 'object' ? c.name : c));
}

/** Positional index of a column. Rows are arrays addressed as r[colIdx], never
    r[col.name], which is the house convention. */
export function indexOfColumn(names, name) {
  for (let i = 0; i < names.length; i += 1) {
    if (names[i] === name) return i;
  }
  return -1;
}

export function typeOfColumn(dataset, name) {
  const cols = (dataset && dataset.columns) || [];
  for (let i = 0; i < cols.length; i += 1) {
    const c = cols[i];
    if (c && typeof c === 'object' && c.name === name) {
      return String(c.type || TYPE_STR).toUpperCase();
    }
  }
  return TYPE_STR;
}

export function isNumericType(type) {
  return NUMERIC_TYPES.includes(String(type || '').toUpperCase());
}

export function isDateType(type) {
  return DATE_TYPES.includes(String(type || '').toUpperCase());
}

export function rowsOf(dataset) {
  return Array.isArray(dataset && dataset.rows) ? dataset.rows : [];
}

/** Suggest the column most likely to hold the date, by declared type first and
    name second. A suggestion only: nothing is applied without a person picking. */
export function suggestDateColumn(dataset) {
  const cols = (dataset && dataset.columns) || [];
  for (let i = 0; i < cols.length; i += 1) {
    if (cols[i] && isDateType(cols[i].type)) return cols[i].name;
  }
  const hints = ['date', 'day', 'timestamp', 'time', 'created', 'occurred', 'as_of', 'period'];
  for (let i = 0; i < cols.length; i += 1) {
    const n = String((cols[i] && cols[i].name) || '').toLowerCase();
    for (let h = 0; h < hints.length; h += 1) {
      if (n.includes(hints[h])) return cols[i].name;
    }
  }
  return null;
}

export function suggestNumericColumn(dataset) {
  const cols = (dataset && dataset.columns) || [];
  for (let i = 0; i < cols.length; i += 1) {
    if (cols[i] && isNumericType(cols[i].type)) return cols[i].name;
  }
  return null;
}

/* -------------------------------- dates ---------------------------------- */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * Parse a cell into a UTC calendar date, or null when it cannot be read.
 *
 * Returns a Date pinned to UTC midnight, so two dates that name the same day
 * compare equal regardless of any time component or the machine's timezone. A
 * local-time Date would shift the day for anyone east or west of UTC, which is
 * the quiet off-by-one this whole bundle is meant to prevent.
 *
 * Deliberately narrow. ISO (the overwhelmingly common case, and what DuckDB
 * emits), US M/D/YYYY, a real Date, and an epoch number are accepted. Anything
 * else returns null rather than being handed to Date.parse, whose behaviour on
 * ambiguous input is implementation-defined: "03/04/2024" is two different days
 * depending on the reader, and a transform that picks one silently is worse than
 * one that says it could not read the column.
 */
export function parseDateValue(value) {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return utcDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return utcDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  const s = String(value).trim();
  if (!s) return null;

  const iso = ISO_DATE.exec(s);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const out = utcDate(y, m, d);
    // Rejects 2024-02-31, which would otherwise roll forward into March and
    // land the row in the wrong month.
    if (out.getUTCMonth() + 1 !== m || out.getUTCDate() !== d) return null;
    return out;
  }

  const us = US_DATE.exec(s);
  if (us) {
    const m = Number(us[1]);
    const d = Number(us[2]);
    const y = Number(us[3]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const out = utcDate(y, m, d);
    if (out.getUTCMonth() + 1 !== m || out.getUTCDate() !== d) return null;
    return out;
  }

  return null;
}

function utcDate(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d));
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

export function formatISODate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
}

export const MS_PER_DAY = 86400000;

/**
 * Whole days from a to b, both UTC midnights, so no daylight-saving hour makes a
 * span one day short. Negative when b precedes a; null when either is unreadable.
 *
 * Lives here rather than in one engine because three transforms count days and
 * they must all count them the same way: a streak that thinks March 10 to March
 * 11 is two days apart and a return-window that thinks it is one would disagree
 * about the same table.
 */
export function daysBetween(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return null;
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/** A date shifted by whole days, still at UTC midnight. */
export function addDays(date, days) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + Math.round(days) * MS_PER_DAY);
}

/**
 * Read one cell as a list.
 *
 * Order matters. A real array first, then JSON, then the delimiter. Trying the
 * delimiter before JSON would turn "[1, 2]" into "[1" and " 2]", which is worse
 * than failing because it looks like it worked.
 *
 * Shared by every transform that treats one cell as several values, so the row
 * count one of them previews and the memberships another one counts are always
 * derived from the same reading of the same cell.
 */
export function readList(value, source, delimiter) {
  if (Array.isArray(value)) {
    return { kind: 'array', values: value.slice() };
  }
  if (value == null || value === '') {
    return { kind: 'empty', values: [] };
  }
  if (isPlainObject(value)) {
    // An object is not a list. Widening it is the flattener's job, not this
    // module's, so it is left alone and reported rather than half-handled.
    return { kind: 'scalar', values: [value] };
  }

  const text = String(value).trim();
  if (!text) return { kind: 'empty', values: [] };

  const mode = source || 'auto';
  if (mode === 'auto' || mode === 'json') {
    if (text.charAt(0) === '[' && text.charAt(text.length - 1) === ']') {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return { kind: 'json', values: parsed };
      } catch (_e) {
        // Looks like JSON and is not. In auto mode fall through to the
        // delimiter; in json mode say so rather than quietly splitting.
        if (mode === 'json') return { kind: 'unreadable', values: [] };
      }
    } else if (mode === 'json') {
      return { kind: 'unreadable', values: [] };
    }
  }

  if (mode === 'auto' || mode === 'delimited') {
    const d = String(delimiter || ',');
    if (d && text.indexOf(d) !== -1) {
      return { kind: 'delimited', values: text.split(d) };
    }
  }

  return { kind: 'scalar', values: [text] };
}

/** One cell as text, with objects stringified rather than rendered as
    [object Object]. Trimming is the caller's decision because A17 keeps
    element-level whitespace on purpose and the counting transforms do not. */
export function cellText(v, trim) {
  if (v == null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return trim ? s.trim() : s;
}

/**
 * The period a date belongs to, as a sortable string key.
 *   day    2024-03-05
 *   week   2024-03-04   (the Monday of that ISO week)
 *   month  2024-03
 * Monday is the week anchor because ISO 8601 says so and DuckDB's date_trunc
 * agrees, so the glass-box SQL and these rows cannot disagree about which week
 * a Sunday belongs to.
 */
export function periodKeyOf(date, grain) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  if (grain === 'month') {
    return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1);
  }
  if (grain === 'week') {
    const dow = date.getUTCDay(); // 0 Sunday .. 6 Saturday
    const backToMonday = dow === 0 ? 6 : dow - 1;
    const monday = new Date(date.getTime() - backToMonday * 86400000);
    return formatISODate(monday);
  }
  return formatISODate(date);
}

/**
 * The key of the period immediately before this one.
 *
 * This is the honest heart of A18. It steps the calendar back by exactly one
 * grain rather than reaching for whatever row happens to precede this one, so a
 * gap in the data produces no prior value instead of silently comparing March
 * against January and calling it month over month.
 */
export function priorPeriodKeyOf(key, grain) {
  if (typeof key !== 'string' || !key) return null;
  if (grain === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m) return null;
    let year = Number(m[1]);
    let month = Number(m[2]) - 1;
    if (month < 1) { month = 12; year -= 1; }
    return year + '-' + pad2(month);
  }
  const d = parseDateValue(key);
  if (!d) return null;
  const stepDays = grain === 'week' ? 7 : 1;
  return formatISODate(new Date(d.getTime() - stepDays * 86400000));
}

/** DuckDB's date_trunc unit for a grain, used by the glass-box SQL. */
export function truncUnitFor(grain) {
  if (grain === 'month') return 'month';
  if (grain === 'week') return 'week';
  return 'day';
}

/** The INTERVAL literal that steps back one grain, for the glass-box SQL. */
export function intervalFor(grain) {
  if (grain === 'month') return "INTERVAL 1 MONTH";
  if (grain === 'week') return "INTERVAL 7 DAY";
  return "INTERVAL 1 DAY";
}

/* ------------------------------ numbers ---------------------------------- */

/** A cell as a finite number, or null. Blank is null rather than zero: a
    missing measurement and a measured zero are different facts, and averaging
    them together is how a dashboard starts lying. */
export function toNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const s = String(value).trim().replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Percent change from prior to current, or null when it cannot be stated.
    A prior of zero has no percent change: dividing by it would produce
    Infinity, and printing "Infinity%" next to a real number invites someone to
    act on it. The delta is still reported in that case. */
export function pctChange(current, prior) {
  if (current == null || prior == null) return null;
  if (prior === 0) return null;
  return (current - prior) / Math.abs(prior);
}

/* ------------------------------- config ---------------------------------- */

/** A plain object, used to reject arrays and null before reading keys. */
export function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Normalize a column-list config value to an array of non-empty strings. */
export function asColumnList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    const s = arr[i] == null ? '' : String(arr[i]);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Every named column that is not in the dataset, so validation can name the
    missing ones instead of failing with a generic message. */
export function missingColumns(names, wanted) {
  return asColumnList(wanted).filter((n) => !names.includes(n));
}

// Written as escapes rather than literal control characters so this module stays
// safe to inline into canvas/index.html: a raw control byte inside the one big
// inline script is invisible in review and painful to diagnose.
const UNIT_SEP = '\u001f';
const NULL_SENTINEL = '\u0000null';

/** The composite key of a row, as a string safe to use as an object key.
    Values are joined with a unit separator and any embedded separator is
    stripped, so ['a', 'b'] and ['a<sep>b'] cannot collide into one entity. A
    null gets its own sentinel rather than an empty string, because a genuinely
    blank key value and a missing one are different entities. */
export function keyOfRow(row, idxs) {
  const parts = [];
  for (let i = 0; i < idxs.length; i += 1) {
    const v = idxs[i] >= 0 ? row[idxs[i]] : null;
    parts.push(v == null ? NULL_SENTINEL : String(v).split(UNIT_SEP).join(''));
  }
  return parts.join(UNIT_SEP);
}

/* ------------------------------ ordering --------------------------------- */

/**
 * The order value as something comparable, or null when the row cannot take part.
 *
 * A declared date column is parsed as a date so that "2024-3-5" and "2024-03-05"
 * order correctly rather than as strings. Anything numeric orders as a number so
 * that 9 comes before 10. Everything else orders as a string, which is at least
 * total and stable.
 *
 * Lives here rather than in one transform because two transforms now pick a row
 * per group by an order column, and if they read "latest" differently the app
 * would give two answers to one question.
 */
export function sortableOrderValue(value, preferDate) {
  if (value == null || value === '') return null;
  if (preferDate || value instanceof Date) {
    const d = parseDateValue(value);
    if (d) return { kind: 'n', v: d.getTime() };
    if (preferDate) return null;
  }
  const n = toNumber(value);
  if (n !== null && typeof value !== 'boolean') return { kind: 'n', v: n };
  const d2 = parseDateValue(value);
  if (d2) return { kind: 'n', v: d2.getTime() };
  return { kind: 's', v: String(value) };
}

export function compareSortable(a, b) {
  if (a.kind === 'n' && b.kind === 'n') return a.v < b.v ? -1 : (a.v > b.v ? 1 : 0);
  const as = String(a.v);
  const bs = String(b.v);
  return as < bs ? -1 : (as > bs ? 1 : 0);
}

/** A total order over two raw cells, for the tie-break. Null sorts last in the
    ascending direction so a blank never wins a slot a real value could take. */
export function compareValues(a, b) {
  const aNull = a == null || a === '';
  const bNull = b == null || b === '';
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  const an = toNumber(a);
  const bn = toNumber(b);
  if (an !== null && bn !== null) return an < bn ? -1 : (an > bn ? 1 : 0);
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : (as > bs ? 1 : 0);
}

/* ------------------------------- output ---------------------------------- */

/** A column descriptor in the house shape. */
export function column(name, type) {
  return { name: name, type: String(type || TYPE_STR).toUpperCase() };
}

/**
 * The standard shape every transform in this directory returns, so the canvas
 * wire can render any of them with one code path and a test can assert one
 * contract. `notes` is where a transform says what it could not do: unread
 * dates, facts with no match, rows with no prior period. It is part of the
 * result rather than a console warning because an honest gap the user never
 * sees is the same as a hidden one.
 */
export function transformResult(fields) {
  return {
    ok: true,
    columns: fields.columns || [],
    rows: fields.rows || [],
    sql: fields.sql || '',
    stats: fields.stats || {},
    notes: fields.notes || [],
  };
}

export function transformError(message) {
  return { ok: false, error: String(message || 'The transform could not run.') };
}

// The TYPE_* constants belong in the namespace as well as the ESM exports: the
// canvas build inlines these modules with their imports rewritten to read this
// object, so a name that is exported but absent here would be undefined only in
// the shipped page and nowhere in the tests.
export const DataGlowTransformCore = {
  TRANSFORM_CORE_VERSION,
  PERIOD_GRAINS,
  PERIOD_GRAIN_LABELS,
  TYPE_INT,
  TYPE_FLOAT,
  TYPE_STR,
  TYPE_DATE,
  TYPE_BOOL,
  quoteIdent,
  quoteLiteral,
  relationName,
  columnNamesOf,
  indexOfColumn,
  typeOfColumn,
  isNumericType,
  isDateType,
  rowsOf,
  suggestDateColumn,
  suggestNumericColumn,
  parseDateValue,
  formatISODate,
  MS_PER_DAY,
  daysBetween,
  addDays,
  readList,
  cellText,
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
  sortableOrderValue,
  compareSortable,
  compareValues,
  column,
  transformResult,
  transformError,
};
