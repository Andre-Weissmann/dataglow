// ============================================================
// DATAGLOW - Value standardizer
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS DOES. A category column holds "CA", "ca", "Calif.", "California" and
// " California ". Those are one category typed five ways, and every count, chart
// and group-by over that column is wrong until they are one value. This proposes
// the merges, shows the arithmetic, and applies only the map a person confirmed.
//
// NOTHING IS APPLIED WITHOUT CONFIRMATION, AND THE PROPOSAL IS NOT THE MAP.
// proposeMergeGroups() returns suggestions and nothing else. It cannot change a
// table. Applying requires a map that a person has seen, plus confirmed:true, and
// the transform refuses to run without both. This is not ceremony: a wrong merge
// is invisible afterwards, because the evidence that it was wrong is the thing
// that got overwritten.
//
// SO THE ORIGINAL VALUE IS KEPT. An audit column records what each recoded cell
// used to say. Without it the merge is unreviewable and unpickable, and "we
// standardised the values" becomes an unfalsifiable claim.
//
// THE ARITHMETIC THIS REFUSES TO HIDE.
// Merging never drops a row, it only relabels one, so the total row count is
// unchanged and every group count after the merge is exactly the sum of the
// counts before it. That sum is shown per group, so a merge that quietly doubles
// a category is visible as a sum rather than discovered later in a chart.
//
// CASE IS NOT ALWAYS NOISE. "CA" and "ca" are the same state, but in gene names,
// SKUs, currency pairs and file paths they are different things, and a column
// where almost every value is distinct is not a set of categories at all. Both
// conditions are detected and reported before anything is proposed.
//
// FUZZY MATCHING IS OPTIONAL AND INJECTED, NEVER ASSUMED.
// The deterministic modes (case, whitespace, punctuation) are reversible facts
// about the text. Similarity scoring is a guess, so it only runs when a clusterer
// is handed in, and its groups are labelled as guesses in the reason field.

import {
  quoteIdent,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  isPlainObject,
  cellText,
  column,
  typeOfColumn,
  transformResult,
  transformError,
  TYPE_INT,
  TYPE_STR,
} from './transform-core.js';

export const VALUE_STANDARDIZER_VERSION = 1;

export const MATCH_MODES = Object.freeze(['case', 'whitespace', 'punctuation']);

export const MATCH_MODE_LABELS = Object.freeze({
  case: 'Ignore capitalisation',
  whitespace: 'Ignore extra spaces',
  punctuation: 'Ignore dots, dashes and underscores',
});

/** Above this share of distinct values per row the column is closer to an
    identifier than to a category, and merging identifiers destroys the join. */
export const IDENTIFIER_DISTINCT_SHARE = 0.9;

/** More distinct values than this and a person cannot review the map, which means
    confirmation stops being confirmation. */
export const TOO_MANY_TO_REVIEW = 300;

export const DEFAULT_AUDIT_SUFFIX = '_original';

export function createEmptyStandardizerConfig() {
  return {
    valueColumn: '',
    matchModes: ['case', 'whitespace'],
    fuzzy: false,
    map: {},
    keepAudit: true,
    auditColumn: '',
    confirmed: false,
  };
}

export function auditColumnName(config) {
  if (config && config.auditColumn) return String(config.auditColumn);
  return String((config && config.valueColumn) || 'value') + DEFAULT_AUDIT_SUFFIX;
}

/** Every distinct value with its row count, most common first. This is the thing
    a person reads before confirming anything, so the count is not optional. */
export function distinctValuesOf(dataset, columnName) {
  const names = columnNamesOf(dataset);
  const idx = indexOfColumn(names, columnName);
  const rows = rowsOf(dataset);
  const counts = new Map();
  let blanks = 0;
  if (idx < 0) return { values: [], blanks: 0, rows: rows.length };
  for (let i = 0; i < rows.length; i += 1) {
    if (!Array.isArray(rows[i])) continue;
    const text = cellText(rows[i][idx], false);
    if (text == null || text.trim() === '') { blanks += 1; continue; }
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  const values = Array.from(counts.entries()).map((e) => ({ value: e[0], count: e[1] }));
  values.sort((a, b) => (b.count - a.count) || a.value.localeCompare(b.value));
  return { values: values, blanks: blanks, rows: rows.length };
}

/**
 * The comparison key. Each mode strips one kind of difference that is a fact
 * about the typing rather than about the category, so two values sharing a key
 * differ only in ways the caller declared irrelevant.
 */
export function normalizeKey(text, config) {
  const modes = Array.isArray(config && config.matchModes) ? config.matchModes : [];
  let s = String(text == null ? '' : text).trim();
  if (modes.indexOf('punctuation') !== -1) s = s.replace(/[.\-_/\\]+/g, ' ');
  if (modes.indexOf('whitespace') !== -1) s = s.replace(/\s+/g, ' ').trim();
  else s = s.trim();
  if (modes.indexOf('case') !== -1) s = s.toLowerCase();
  return s;
}

/**
 * Groups of values that look like one category. Proposals only: this returns
 * nothing that can be applied, and the caller must build a map from it and have
 * a person confirm that map.
 *
 * `options.clusterer` may be a function (values) => arrays of grouped values, for
 * the fuzzy pass. `options.isSensitive` may be a function (columnName) => boolean.
 */
export function proposeMergeGroups(dataset, config, options) {
  const opts = isPlainObject(options) ? options : {};
  const found = distinctValuesOf(dataset, (config || {}).valueColumn);
  const warnings = [];
  const groups = [];

  const distinct = found.values.length;
  const filled = found.rows - found.blanks;
  if (filled > 0 && distinct / filled >= IDENTIFIER_DISTINCT_SHARE && distinct > 20) {
    warnings.push('Nearly every row in this column holds a different value, so it is closer to an '
      + 'identifier than to a category. Merging identifiers breaks whatever joins on them, and no '
      + 'grouping of this column would have been meaningful in the first place.');
  }
  if (distinct > TOO_MANY_TO_REVIEW) {
    warnings.push('There are ' + distinct + ' distinct values, which is more than anybody will '
      + 'actually read before confirming. Confirming a map this size is a rubber stamp rather '
      + 'than a review, so narrow the column or standardise it in passes.');
  }
  if (typeof opts.isSensitive === 'function' && config && config.valueColumn
    && opts.isSensitive(config.valueColumn)) {
    warnings.push('This column looks like a sensitive category. Merging its values changes what '
      + 'is reported about the people in those groups, so the merge needs a stated reason and not '
      + 'just a similarity score.');
  }

  // Deterministic pass: values that share a normalised key differ only in ways
  // the caller declared irrelevant, which is a fact rather than a guess.
  const byKey = new Map();
  for (let i = 0; i < found.values.length; i += 1) {
    const v = found.values[i];
    const key = normalizeKey(v.value, config);
    if (key === '') continue;
    let bucket = byKey.get(key);
    if (!bucket) { bucket = []; byKey.set(key, bucket); }
    bucket.push(v);
  }
  const grouped = new Set();
  const keys = Array.from(byKey.keys());
  for (let i = 0; i < keys.length; i += 1) {
    const members = byKey.get(keys[i]);
    if (members.length < 2) continue;
    // The most common tidy spelling wins: it is the one already in use everywhere
    // else and the one a reader will recognise.
    members.sort(preferCanonical);
    for (let m = 0; m < members.length; m += 1) grouped.add(members[m].value);
    groups.push({
      canonical: members[0].value,
      members: members.slice(),
      totalCount: members.reduce((acc, m) => acc + m.count, 0),
      certain: true,
      reason: 'These differ only by ' + describeModes(config) + ', so they are the same value '
        + 'typed differently.',
    });
  }

  // Fuzzy pass, only when a clusterer was handed in. Guesses are labelled.
  if (config && config.fuzzy && typeof opts.clusterer === 'function') {
    const remaining = found.values.filter((v) => !grouped.has(v.value));
    let clusters = [];
    try {
      clusters = opts.clusterer(remaining) || [];
    } catch (err) {
      warnings.push('The similarity matcher failed, so only the exact matches above are proposed.');
      clusters = [];
    }
    for (let i = 0; i < clusters.length; i += 1) {
      const raw = Array.isArray(clusters[i]) ? clusters[i] : [];
      const members = raw.map((entry) => (isPlainObject(entry)
        ? { value: String(entry.value), count: Number(entry.count) || 0 }
        : { value: String(entry), count: (found.values.find((v) => v.value === String(entry))
          || { count: 0 }).count }))
        .filter((m) => m.value !== '' && !grouped.has(m.value));
      if (members.length < 2) continue;
      members.sort(preferCanonical);
      for (let m = 0; m < members.length; m += 1) grouped.add(members[m].value);
      groups.push({
        canonical: members[0].value,
        members: members,
        totalCount: members.reduce((acc, m) => acc + m.count, 0),
        certain: false,
        reason: 'These only look similar. That is a guess and not a fact about the text, so check '
          + 'each one before confirming it.',
      });
    }
    if (clusters.length) {
      warnings.push('Some groups below come from similarity scoring rather than from an exact '
        + 'match. A similarity score cannot tell "Smith Ltd" from "Smyth Ltd", so those groups '
        + 'need reading one by one.');
    }
  }

  groups.sort((a, b) => (b.totalCount - a.totalCount)
    || a.canonical.localeCompare(b.canonical));

  return {
    groups: groups,
    distinct: distinct,
    blanks: found.blanks,
    rows: found.rows,
    ungrouped: distinct - grouped.size,
    warnings: warnings,
  };
}

/** A value with no stray or doubled whitespace. Untidy spacing is a typing
    artifact, so merging everything into it would propagate the artifact rather
    than remove it, however common that spelling happens to be. */
function isTidy(value) {
  const s = String(value);
  return s === s.trim().replace(/\s+/g, ' ');
}

/**
 * Order the members of a group so the first one is the canonical spelling.
 *
 * Tidiness comes before frequency on purpose: if " California " appears fifty
 * times and "California" twice, the majority spelling is still a mistake, and
 * standardising onto it would write the mistake into every row.
 */
function preferCanonical(a, b) {
  const ta = isTidy(a.value);
  const tb = isTidy(b.value);
  if (ta !== tb) return ta ? -1 : 1;
  if (a.count !== b.count) return b.count - a.count;
  // Counts are equal, so there is no evidence about which spelling is in use.
  // Prefer deliberate capitalisation over all-caps or all-lowercase, which are
  // usually a habit of entry rather than the name of the category.
  const ca = caseScore(a.value);
  const cb = caseScore(b.value);
  if (ca !== cb) return ca - cb;
  return a.value.localeCompare(b.value);
}

function caseScore(value) {
  const s = String(value);
  if (!/[a-z]/i.test(s)) return 1;
  if (s === s.toLowerCase() || s === s.toUpperCase()) return 1;
  return 0;
}

function describeModes(config) {
  const modes = Array.isArray(config && config.matchModes) ? config.matchModes : [];
  const parts = [];
  if (modes.indexOf('case') !== -1) parts.push('capitalisation');
  if (modes.indexOf('whitespace') !== -1) parts.push('spacing');
  if (modes.indexOf('punctuation') !== -1) parts.push('punctuation');
  if (!parts.length) return 'nothing at all, so they are already identical';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

/** A starting map from proposed groups: every non-canonical member points at the
    canonical one. The caller must show this to a person and let them edit it. */
export function mapFromGroups(groups) {
  const map = {};
  const list = Array.isArray(groups) ? groups : [];
  for (let i = 0; i < list.length; i += 1) {
    const g = list[i];
    if (!g || !Array.isArray(g.members)) continue;
    for (let m = 0; m < g.members.length; m += 1) {
      const from = g.members[m].value;
      if (from === g.canonical) continue;
      map[from] = g.canonical;
    }
  }
  return map;
}

export function validateStandardizerConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  if (!config.valueColumn) {
    errors.push('Pick the column whose values should be standardised.');
  } else if (!names.includes(config.valueColumn)) {
    errors.push('The column ' + config.valueColumn + ' is not in this table.');
  }

  const modes = Array.isArray(config.matchModes) ? config.matchModes : [];
  for (let i = 0; i < modes.length; i += 1) {
    if (MATCH_MODES.indexOf(modes[i]) === -1) {
      errors.push('The matching option ' + modes[i] + ' is not one this can do.');
    }
  }

  const map = isPlainObject(config.map) ? config.map : {};
  const froms = Object.keys(map);
  if (!froms.length) {
    errors.push('There are no merges to apply. Confirm at least one before running this.');
  }
  for (let i = 0; i < froms.length; i += 1) {
    const to = map[froms[i]];
    if (typeof to !== 'string' || to.trim() === '') {
      errors.push('The value ' + froms[i] + ' has no replacement, so it is not clear what to do '
        + 'with it. To delete a value, filter the rows out instead of blanking them.');
    } else if (to === froms[i]) {
      errors.push('The value ' + froms[i] + ' is mapped to itself, which does nothing.');
    } else if (Object.prototype.hasOwnProperty.call(map, to)) {
      // a -> b and b -> c would give a different table depending on which
      // replacement ran first, which is not a merge, it is a coin flip.
      errors.push('The value ' + froms[i] + ' is replaced by ' + to + ', but ' + to
        + ' is itself being replaced. Point them both at the final value instead, because a chain '
        + 'gives a different answer depending on the order the replacements run in.');
    }
  }

  if (config.keepAudit !== false) {
    const audit = auditColumnName(config);
    if (names.includes(audit)) {
      errors.push('The table already has a column called ' + audit
        + '. Choose another name for the record of the original values.');
    }
  }

  if (config.confirmed !== true) {
    errors.push('These merges have not been confirmed. Nothing is changed until somebody has read '
      + 'the list of replacements and said yes to it.');
  }

  return { ok: errors.length === 0, errors: errors };
}

/**
 * The glass-box SQL.
 *
 * Two statements, in this order, because the audit column has to capture the old
 * value before the UPDATE overwrites it. Every replacement is one WHEN, spelled
 * out, so the map a person confirmed and the SQL that runs are the same list read
 * twice rather than two things that have to be trusted to agree.
 */
export function buildStandardizerSQL(config, sourceRelation) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const rel = relationName(sourceRelation, 'your_table');
  const col = quoteIdent(config.valueColumn);
  const map = isPlainObject(config.map) ? config.map : {};
  const froms = Object.keys(map);
  const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

  const lines = [
    '-- Standardise ' + col + ' by applying the confirmed replacements below.',
    '-- ' + froms.length + ' value' + (froms.length === 1 ? '' : 's') + ' ' + (froms.length === 1
      ? 'is' : 'are') + ' replaced. No row is added or removed by this, only relabelled, so the',
    '-- row count is unchanged and each group count afterwards is the sum of the ones before.',
  ];

  if (config.keepAudit !== false) {
    const audit = quoteIdent(auditColumnName(config));
    lines.push('');
    lines.push('-- First, keep what the cell used to say. This runs BEFORE the update, because');
    lines.push('-- afterwards the original value no longer exists anywhere and the merge could');
    lines.push('-- not be reviewed or undone.');
    lines.push('ALTER TABLE ' + rel + ' ADD COLUMN ' + audit + ' VARCHAR;');
    lines.push('UPDATE ' + rel + ' SET ' + audit + ' = CAST(' + col + ' AS VARCHAR)');
    lines.push('WHERE CAST(' + col + ' AS VARCHAR) IN (');
    lines.push('  ' + froms.map(lit).join(', '));
    lines.push(');');
  }

  lines.push('');
  lines.push('-- Then the merge itself. One WHEN per confirmed replacement, and the ELSE hands');
  lines.push('-- back the value untouched, so anything not in the map keeps exactly what it had.');
  lines.push('UPDATE ' + rel + ' SET ' + col + ' = CASE CAST(' + col + ' AS VARCHAR)');
  for (let i = 0; i < froms.length; i += 1) {
    lines.push('  WHEN ' + lit(froms[i]) + ' THEN ' + lit(map[froms[i]]));
  }
  lines.push('  ELSE CAST(' + col + ' AS VARCHAR)');
  lines.push('END');
  lines.push('WHERE CAST(' + col + ' AS VARCHAR) IN (');
  lines.push('  ' + froms.map(lit).join(', '));
  lines.push(');');
  lines.push('');
  lines.push('-- Check afterwards: the count per value should have moved between groups without');
  lines.push('-- the total moving at all.');
  lines.push('-- SELECT ' + col + ', COUNT(*) FROM ' + rel + ' GROUP BY 1 ORDER BY 2 DESC;');

  return { ok: true, sql: lines.join('\n') };
}

export function valueStandardizerTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateStandardizerConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const idx = indexOfColumn(names, config.valueColumn);
  const map = config.map;
  const keepAudit = config.keepAudit !== false;
  const audit = auditColumnName(config);

  const srcRows = rowsOf(dataset);
  const outColumns = names.map((n) => column(n, typeOfColumn(dataset, n) || TYPE_STR));
  if (keepAudit) outColumns.push(column(audit, TYPE_STR));

  const before = new Map();
  const after = new Map();
  const usedFrom = new Map();
  let recoded = 0;
  let untouched = 0;
  let blanks = 0;

  const rowsOut = [];
  for (let i = 0; i < srcRows.length; i += 1) {
    const row = srcRows[i];
    if (!Array.isArray(row)) continue;
    const out = row.slice();
    const text = cellText(row[idx], false);
    const key = text == null ? '' : text;
    if (key.trim() === '') blanks += 1;
    before.set(key, (before.get(key) || 0) + 1);

    let changed = false;
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      out[idx] = map[key];
      usedFrom.set(key, (usedFrom.get(key) || 0) + 1);
      recoded += 1;
      changed = true;
    } else {
      untouched += 1;
    }
    const nowText = cellText(out[idx], false);
    after.set(nowText == null ? '' : nowText, (after.get(nowText == null ? '' : nowText) || 0) + 1);
    // The audit column is blank where nothing changed, so a filled cell always
    // means "this was recoded" and never "this happened to be the same".
    if (keepAudit) out.push(changed ? key : '');
    rowsOut.push(out);
  }

  const froms = Object.keys(map);
  const unusedFrom = froms.filter((f) => !usedFrom.has(f));
  const targets = Object.keys(map).map((f) => map[f]);
  const newLabels = targets.filter((t, i) => targets.indexOf(t) === i && !before.has(t));

  const built = buildStandardizerSQL(config, dataset.name);
  const notes = [];

  notes.push(recoded + ' cell' + (recoded === 1 ? '' : 's') + ' in ' + config.valueColumn
    + ' ' + (recoded === 1 ? 'was' : 'were') + ' relabelled and ' + untouched + ' '
    + (untouched === 1 ? 'was' : 'were') + ' left exactly as ' + (untouched === 1 ? 'it was'
      : 'they were') + '. No row was added or removed, so the table still has '
    + rowsOut.length + ' row' + (rowsOut.length === 1 ? '' : 's') + ' and every count that grew '
    + 'here grew by exactly what another count lost.');

  notes.push('The values went from ' + before.size + ' distinct to ' + after.size + '. '
    + (before.size === after.size
      ? 'That is the same number, which means the merges renamed values rather than combining '
        + 'them. Check that this is what was wanted.'
      : 'That is ' + (before.size - after.size) + ' fewer, which is the point, and it also means '
        + 'any earlier count, chart or export from this column will no longer match this one.'));

  if (keepAudit) {
    notes.push('The column ' + audit + ' holds what each relabelled cell used to say, and is '
      + 'blank on the rows that were not touched. Keep it: it is the only record that the merge '
      + 'happened, the only way to review whether each merge was right, and the only way back.');
  } else {
    notes.push('No record of the original values was kept, at your instruction. The merge is now '
      + 'unreviewable and cannot be undone from this table, because the evidence that a cell said '
      + 'something else is the thing that was overwritten.');
  }

  if (newLabels.length) {
    notes.push(newLabels.length + ' replacement'
      + (newLabels.length === 1 ? ' introduces' : 's introduce')
      + ' a label that was not in the column before: ' + newLabels.slice(0, 5).join(', ')
      + (newLabels.length > 5 ? ' and others' : '') + '. That is allowed, but it means the '
      + 'standardised column now contains a value no source row ever held.');
  }
  if (unusedFrom.length) {
    notes.push(unusedFrom.length + ' confirmed replacement'
      + (unusedFrom.length === 1 ? ' matched no row' : 's matched no rows') + ': '
      + unusedFrom.slice(0, 5).join(', ') + (unusedFrom.length > 5 ? ' and others' : '')
      + '. Either the value is spelled differently from the map, or it was already merged by '
      + 'an earlier pass. Nothing was changed for ' + (unusedFrom.length === 1 ? 'it' : 'them') + '.');
  }
  if (blanks > 0) {
    notes.push(blanks + ' row' + (blanks === 1 ? ' has' : 's have') + ' no value in this column at '
      + 'all. Blank is not a spelling of anything, so nothing was merged into it and nothing was '
      + 'merged out of it.');
  }

  return transformResult({
    columns: outColumns,
    rows: rowsOut,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: srcRows.length,
      rowsOut: rowsOut.length,
      recodedCells: recoded,
      untouchedCells: untouched,
      distinctBefore: before.size,
      distinctAfter: after.size,
      distinctRemoved: before.size - after.size,
      replacements: froms.length,
      unusedReplacements: unusedFrom.length,
      newLabels: newLabels.length,
      blanks: blanks,
      auditColumn: keepAudit ? audit : '',
    },
    notes: notes,
  });
}

/** One plain sentence for the panel header. */
export function describeValueStandardizer(result) {
  if (!result || !result.ok) return 'This did not run.';
  const s = result.stats || {};
  return s.recodedCells.toLocaleString() + ' cell'
    + (s.recodedCells === 1 ? '' : 's') + ' relabelled, taking the column from '
    + s.distinctBefore.toLocaleString() + ' distinct values to '
    + s.distinctAfter.toLocaleString() + '. No row was added or removed.'
    + (s.auditColumn ? ' The original values are kept in ' + s.auditColumn + '.'
      : ' The original values were not kept.');
}

/** The confirmation text a person reads before anything is applied. Every
    replacement is listed, because "12 merges" is not something you can agree to.
    Values are quoted, because stray whitespace is exactly what is being merged and
    an unquoted "California -> California" looks like a pointless no-op. */
export function summarizeForConfirm(config) {
  const map = isPlainObject(config && config.map) ? config.map : {};
  const froms = Object.keys(map).sort();
  if (!froms.length) return 'There are no merges to confirm.';
  const lines = froms.map((f) => '  "' + f + '"  ->  "' + map[f] + '"');
  return froms.length + ' value' + (froms.length === 1 ? '' : 's') + ' in '
    + String((config && config.valueColumn) || 'the column') + ' will be relabelled:\n'
    + lines.join('\n')
    + '\nNothing else in the table changes, and no row is added or removed.';
}

export const DataGlowValueStandardizer = {
  VALUE_STANDARDIZER_VERSION,
  MATCH_MODES,
  MATCH_MODE_LABELS,
  IDENTIFIER_DISTINCT_SHARE,
  TOO_MANY_TO_REVIEW,
  DEFAULT_AUDIT_SUFFIX,
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
};
