// ============================================================
// DATAGLOW - A28 Frequent combinations (co-occurrence)
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. Which values turn up together in the same record. Two
// category columns, or one multi-value cell, and the question is "what pairs
// with what": which two products are bought together, which two tags sit on the
// same ticket, which two diagnoses appear on the same patient.
//
// THE ARITHMETIC THIS REFUSES TO HIDE IS THAT A BIG PAIR COUNT IS USUALLY JUST
// TWO BIG VALUES. If 80% of records carry "email" and 70% carry "sms", then
// roughly 56% of records carry both, and that pair will sit at the top of any
// support-ordered list while telling you nothing at all. Ranking pairs by raw
// count therefore ranks popularity, not association, and reading it as
// association is the standard mistake.
//
// SO EVERY PAIR CARRIES ITS OWN MARGINALS AND A LIFT.
//   records      how many records hold both values.
//   count_a      how many hold the first, count_b how many hold the second.
//   pct_of_records share of all records holding both.
//   lift         observed together / expected together if the two were
//                independent. 1.0 means "exactly as often as chance", above
//                means they attract, below means they avoid. It is a ratio of
//                two estimates, so at small counts it is noise, and this module
//                says so rather than printing a confident 4.7.
//
// PAIRS ARE UNORDERED AND COUNTED ONCE. (email, sms) and (sms, email) are the
// same pair, so the values are ordered within the pair and the mirror image is
// never emitted. Emitting both halves doubles every count and is the second
// standard mistake.
//
// A RECORD WITH ONE VALUE CONTRIBUTES NO PAIR, AND IS STILL A RECORD.
// It stays in the denominator of every percentage, because "how many of our
// records show this combination" is a question about all records, not only the
// ones that happened to combine.

import {
  quoteIdent,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  isPlainObject,
  asColumnList,
  readList,
  cellText,
  column,
  transformResult,
  transformError,
  TYPE_INT,
  TYPE_FLOAT,
  TYPE_STR,
} from './transform-core.js';

export const FREQUENT_COMBINATIONS_VERSION = 1;

export const COMBO_SOURCES = Object.freeze(['columns', 'multivalue']);

export const COMBO_SOURCE_LABELS = Object.freeze({
  columns: 'Values from several columns',
  multivalue: 'Values inside one multi-value column',
});

/** Below this a lift is arithmetic on almost no data. Reported, but flagged. */
export const THIN_SUPPORT = 5;

// Pairs grow as the square of the distinct values, so a column with thousands of
// them produces millions of pairs and no insight. Stop rather than hang.
export const MAX_ITEMS_PER_RECORD = 40;
export const MAX_PAIRS = 200000;

export function createEmptyCombinationsConfig() {
  return {
    source: 'columns',
    itemColumns: [],
    valueColumn: '',
    valueSource: 'auto',
    delimiter: ',',
    caseMode: 'fold',
    labelWithColumn: true,
    minSupport: 2,
    topN: 25,
  };
}

export function suggestCombinationsConfig(dataset) {
  const cfg = createEmptyCombinationsConfig();
  const names = columnNamesOf(dataset);
  const rows = rowsOf(dataset);

  // A column worth pairing has few distinct values relative to its rows. One
  // distinct value pairs with nothing; one per row is an identifier.
  const scored = [];
  for (let i = 0; i < names.length; i += 1) {
    const seen = new Set();
    let looked = 0;
    let multi = 0;
    for (let r = 0; r < rows.length && looked < 400; r += 1) {
      if (!Array.isArray(rows[r])) continue;
      const cell = rows[r][i];
      if (cell == null || cell === '') continue;
      looked += 1;
      seen.add(String(cell));
      if (readList(cell, 'auto', ',').values.length > 1) multi += 1;
    }
    if (!looked) continue;
    if (multi / looked > 0.3) {
      cfg.source = 'multivalue';
      cfg.valueColumn = names[i];
      return cfg;
    }
    if (seen.size > 1 && seen.size <= Math.max(2, looked * 0.5)) {
      scored.push({ name: names[i], distinct: seen.size });
    }
  }
  scored.sort((a, b) => a.distinct - b.distinct);
  cfg.itemColumns = scored.slice(0, 2).map((s) => s.name);
  return cfg;
}

export function validateCombinationsConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];
  const source = String(config.source || 'columns');

  if (COMBO_SOURCES.indexOf(source) === -1) {
    errors.push('Choose where the values to combine come from.');
  }

  if (source === 'multivalue') {
    if (!config.valueColumn) {
      errors.push('Pick the column that holds several values in one cell.');
    } else if (!names.includes(config.valueColumn)) {
      errors.push('The column ' + config.valueColumn + ' is not in this table.');
    }
  } else {
    const cols = asColumnList(config.itemColumns);
    if (cols.length < 2) {
      errors.push('Pick at least two columns, because a combination needs two values.');
    }
    for (let i = 0; i < cols.length; i += 1) {
      if (!names.includes(cols[i])) {
        errors.push('The column ' + cols[i] + ' is not in this table.');
      }
    }
  }

  const min = Number(config.minSupport);
  if (config.minSupport !== '' && config.minSupport != null
    && (!Number.isFinite(min) || min < 1 || Math.floor(min) !== min)) {
    errors.push('The smallest number of records to show has to be a whole number of one or more.');
  }
  const top = Number(config.topN || 0);
  if (config.topN && (!Number.isFinite(top) || top < 1 || Math.floor(top) !== top)) {
    errors.push('The number of combinations to show has to be a whole number of one or more.');
  }

  return { ok: errors.length === 0, errors: errors };
}

function fold(text, config) {
  const s = String(text).trim();
  return String((config && config.caseMode) || 'fold') === 'fold' ? s.toLowerCase() : s;
}

/** The items one record contributes, deduplicated, as {key, label} pairs. */
export function itemsOfRow(row, config, plan) {
  const out = [];
  const seen = new Set();
  const push = (label, key) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key: key, label: label });
  };

  if (String(config.source || 'columns') === 'multivalue') {
    const parsed = readList(row[plan.valueIdx], String(config.valueSource || 'auto'),
      String(config.delimiter || ','));
    for (let i = 0; i < parsed.values.length; i += 1) {
      const text = cellText(parsed.values[i], true);
      if (text == null || text === '') continue;
      const key = fold(text, config);
      if (key === '') continue;
      push(text, key);
    }
    return out;
  }

  for (let i = 0; i < plan.itemIdxs.length; i += 1) {
    const text = cellText(row[plan.itemIdxs[i]], true);
    if (text == null || text === '') continue;
    // Labelled with the column by default, because "active" in status and
    // "active" in subscription are different facts that must not merge.
    const name = plan.itemNames[i];
    const label = config.labelWithColumn === false ? text : name + '=' + text;
    push(label, fold(label, config));
  }
  return out;
}

/**
 * The glass-box SQL.
 *
 * A self join on the record key with a < b on the value, which is the whole of
 * unordered pair counting: the inequality both removes the mirror image and stops
 * a value pairing with itself. The marginal counts join back in so the lift is
 * visible as division rather than arriving as a finished number.
 */
export function buildCombinationsSQL(config, sourceRelation) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const rel = relationName(sourceRelation, 'your_table');
  const source = String(config.source || 'columns');
  const folded = String(config.caseMode || 'fold') === 'fold';
  const min = Math.max(1, Math.floor(Number(config.minSupport) || 1));
  const top = Math.max(0, Math.floor(Number(config.topN) || 0));
  const wrap = (e) => (folded ? 'lower(trim(' + e + '))' : 'trim(' + e + ')');

  const lines = [
    '-- Which values turn up together in the same record.',
    '-- records is the count of records holding BOTH values. count_a and count_b are',
    '-- how common each value is on its own, and they are here because a large pair',
    '-- count is usually just two common values rather than a real association.',
    '-- lift compares the two: above 1 the pair happens more than chance would give.',
    'WITH items AS (',
  ];

  if (source === 'multivalue') {
    const col = quoteIdent(config.valueColumn);
    const delim = String(config.delimiter || ',');
    const split = String(config.valueSource || 'auto') === 'json'
      ? 'json_extract_string(' + col + ", '$[*]')"
      : 'str_split(CAST(' + col + ' AS VARCHAR), ' + "'" + delim.replace(/'/g, "''") + "')";
    lines.push('  -- One row per record per value. DISTINCT so a cell listing a value twice');
    lines.push('  -- does not pair it with itself or double the pair count.');
    lines.push('  SELECT DISTINCT rowid AS record_key, ' + wrap('item') + ' AS item');
    lines.push('  FROM ' + rel + ', UNNEST(' + split + ') AS dg_values(item)');
    lines.push("  WHERE item IS NOT NULL AND trim(item) <> ''");
  } else {
    const cols = asColumnList(config.itemColumns);
    const parts = cols.map((name) => {
      const q = quoteIdent(name);
      const label = config.labelWithColumn === false
        ? 'CAST(' + q + ' AS VARCHAR)'
        : "'" + name.replace(/'/g, "''") + "=' || CAST(" + q + ' AS VARCHAR)';
      return '  SELECT rowid AS record_key, ' + wrap(label) + ' AS item FROM ' + rel
        + ' WHERE ' + q + ' IS NOT NULL AND CAST(' + q + " AS VARCHAR) <> ''";
    });
    lines.push('  -- Every column contributes its value as one item, tagged with the column');
    lines.push('  -- name so the same word in two columns stays two different facts.');
    lines.push(parts.join('\n  UNION ALL\n'));
  }

  lines.push('), marginals AS (');
  lines.push('  SELECT item, COUNT(DISTINCT record_key) AS records FROM items GROUP BY item');
  lines.push('), pairs AS (');
  lines.push('  -- a.item < b.item is the unordered pair. It drops the mirror image and');
  lines.push('  -- stops a value pairing with itself, so no count is doubled.');
  lines.push('  SELECT a.item AS item_a, b.item AS item_b,');
  lines.push('    COUNT(DISTINCT a.record_key) AS records');
  lines.push('  FROM items a JOIN items b');
  lines.push('    ON a.record_key = b.record_key AND a.item < b.item');
  lines.push('  GROUP BY a.item, b.item');
  lines.push(')');
  lines.push('SELECT p.item_a, p.item_b, p.records,');
  lines.push('  ma.records AS count_a,');
  lines.push('  mb.records AS count_b,');
  lines.push('  ROUND(100.0 * p.records / (SELECT COUNT(*) FROM ' + rel + '), 1) AS pct_of_records,');
  lines.push('  ROUND(');
  lines.push('    (1.0 * p.records / (SELECT COUNT(*) FROM ' + rel + '))');
  lines.push('    / NULLIF(');
  lines.push('      (1.0 * ma.records / (SELECT COUNT(*) FROM ' + rel + '))');
  lines.push('      * (1.0 * mb.records / (SELECT COUNT(*) FROM ' + rel + ')), 0), 2) AS lift');
  lines.push('FROM pairs p');
  lines.push('  JOIN marginals ma ON ma.item = p.item_a');
  lines.push('  JOIN marginals mb ON mb.item = p.item_b');
  if (min > 1) lines.push('WHERE p.records >= ' + min);
  lines.push('ORDER BY p.records DESC, p.item_a, p.item_b');
  if (top) lines.push('LIMIT ' + top);

  lines.push('');
  lines.push('-- Every percentage and every lift here uses COUNT(*) over the whole table as');
  lines.push('-- the denominator, including records that held one value or none and so could');
  lines.push('-- not form a pair. Those records are real and stay in the denominator.');

  return { ok: true, sql: lines.join('\n') };
}

export function frequentCombinationsTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateCombinationsConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const source = String(config.source || 'columns');
  const itemNames = source === 'multivalue' ? [] : asColumnList(config.itemColumns);
  const plan = {
    valueIdx: indexOfColumn(names, config.valueColumn),
    itemNames: itemNames,
    itemIdxs: itemNames.map((n) => indexOfColumn(names, n)),
  };
  const min = Math.max(1, Math.floor(Number(config.minSupport) || 1));
  const top = Math.max(0, Math.floor(Number(config.topN) || 0));

  const srcRows = rowsOf(dataset);
  const marginal = new Map();
  const pairs = new Map();
  let records = 0;
  let noItemRecords = 0;
  let singleItemRecords = 0;
  let pairedRecords = 0;
  let truncatedRecords = 0;
  let maxItems = 0;
  let overflowed = false;

  for (let i = 0; i < srcRows.length; i += 1) {
    const row = srcRows[i];
    if (!Array.isArray(row)) continue;
    records += 1;

    let items = itemsOfRow(row, config, plan);
    if (items.length > maxItems) maxItems = items.length;
    if (items.length > MAX_ITEMS_PER_RECORD) {
      // Truncating is a lie of omission, so it is counted and reported rather
      // than silently capping the table at a plausible-looking size.
      items = items.slice(0, MAX_ITEMS_PER_RECORD);
      truncatedRecords += 1;
    }
    if (!items.length) { noItemRecords += 1; continue; }

    for (let a = 0; a < items.length; a += 1) {
      const m = marginal.get(items[a].key);
      if (m) m.records += 1;
      else marginal.set(items[a].key, { label: items[a].label, records: 1 });
    }
    if (items.length < 2) { singleItemRecords += 1; continue; }
    pairedRecords += 1;

    items.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    for (let a = 0; a < items.length && !overflowed; a += 1) {
      for (let b = a + 1; b < items.length; b += 1) {
        const key = items[a].key + '\u0000' + items[b].key;
        const p = pairs.get(key);
        if (p) { p.records += 1; continue; }
        if (pairs.size >= MAX_PAIRS) { overflowed = true; break; }
        pairs.set(key, {
          labelA: items[a].label,
          labelB: items[b].label,
          keyA: items[a].key,
          keyB: items[b].key,
          records: 1,
        });
      }
    }
  }

  const outColumns = [
    column('item_a', TYPE_STR),
    column('item_b', TYPE_STR),
    column('records', TYPE_INT),
    column('count_a', TYPE_INT),
    column('count_b', TYPE_INT),
    column('pct_of_records', TYPE_FLOAT),
    column('lift', TYPE_FLOAT),
  ];

  const all = Array.from(pairs.values());
  for (let i = 0; i < all.length; i += 1) {
    const p = all[i];
    p.countA = (marginal.get(p.keyA) || { records: 0 }).records;
    p.countB = (marginal.get(p.keyB) || { records: 0 }).records;
    // expected = records * P(a) * P(b), which reduces to countA*countB/records.
    const expected = records ? (p.countA * p.countB) / records : 0;
    p.lift = expected > 0 ? p.records / expected : null;
  }
  all.sort((a, b) => (b.records - a.records)
    || a.labelA.localeCompare(b.labelA) || a.labelB.localeCompare(b.labelB));

  let hidden = 0;
  let thin = 0;
  const rowsOut = [];
  for (let i = 0; i < all.length; i += 1) {
    const p = all[i];
    if (p.records < min) { hidden += 1; continue; }
    if (top && rowsOut.length >= top) { hidden += 1; continue; }
    if (p.records < THIN_SUPPORT) thin += 1;
    rowsOut.push([
      p.labelA,
      p.labelB,
      p.records,
      p.countA,
      p.countB,
      records ? Math.round((1000 * p.records) / records) / 10 : 0,
      p.lift == null ? null : Math.round(p.lift * 100) / 100,
    ]);
  }

  const built = buildCombinationsSQL(config, dataset.name);
  const notes = [];

  if (!records) {
    notes.push('The table has no rows, so there is nothing to combine.');
  } else if (!all.length) {
    notes.push('No record holds two values at once, so there are no combinations to count. '
      + (source === 'multivalue'
        ? 'Every cell in that column held a single value, which makes this a plain value count.'
        : 'Check that the chosen columns are filled in on the same rows.'));
  }

  notes.push('records counts records holding both values. count_a and count_b are how common '
    + 'each value is on its own, and they are shown next to every pair because a large pair '
    + 'count is usually two common values rather than a real association. lift divides the '
    + 'first by what the other two predict: 1.0 means exactly as often as chance, 2.0 means '
    + 'twice as often, and below 1 means the two values avoid each other.');

  if (records && pairedRecords) {
    notes.push(pairedRecords + ' of ' + records + ' record'
      + (records === 1 ? '' : 's') + ' hold at least two values and so can form a combination, '
      + 'at most ' + maxItems + ' values in one record. The other '
      + (records - pairedRecords) + ' stay in the denominator of every percentage here, '
      + 'because a record that combined nothing is still a record.');
  }
  if (singleItemRecords > 0) {
    notes.push(singleItemRecords + ' record' + (singleItemRecords === 1 ? ' holds' : 's hold')
      + ' exactly one value and contribute to count_a and count_b but to no pair. That is why '
      + 'the marginal counts are larger than any pair count they sit beside.');
  }
  if (noItemRecords > 0) {
    notes.push(noItemRecords + ' record' + (noItemRecords === 1 ? ' has' : 's have')
      + ' no usable value at all. They are counted in the denominator and in nothing else, so '
      + 'every percentage here is a share of all records rather than of the ones that had data.');
  }
  if (thin > 0) {
    notes.push(thin + ' of the combination' + (thin === 1 ? '' : 's') + ' shown rest'
      + (thin === 1 ? 's' : '') + ' on fewer than ' + THIN_SUPPORT + ' records. A lift computed '
      + 'from a handful of records moves wildly on one more record, so treat those numbers as a '
      + 'hint to go and look rather than as a measurement.');
  }
  if (truncatedRecords > 0) {
    notes.push(truncatedRecords + ' record' + (truncatedRecords === 1 ? '' : 's') + ' held more '
      + 'than ' + MAX_ITEMS_PER_RECORD + ' values and only the first ' + MAX_ITEMS_PER_RECORD
      + ' were paired. Counts involving those records are therefore low, not exact.');
  }
  if (overflowed) {
    notes.push('There were more than ' + MAX_PAIRS.toLocaleString() + ' distinct combinations and '
      + 'counting stopped there, so this table is incomplete. Pairs grow as the square of the '
      + 'distinct values, so narrowing the values first is the only way to get a complete answer.');
  }
  if (hidden > 0) {
    notes.push(hidden + ' combination' + (hidden === 1 ? ' is' : 's are') + ' not shown, because of '
      + 'the ' + (top && rowsOut.length >= top ? 'top ' + top + ' limit' : 'minimum of ' + min
        + ' record' + (min === 1 ? '' : 's'))
      + '. They still count towards the marginal counts, so the visible rows do not add up to '
      + 'anything in particular.');
  }

  return transformResult({
    columns: outColumns,
    rows: rowsOut,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: srcRows.length,
      rowsOut: rowsOut.length,
      records: records,
      distinctItems: marginal.size,
      combinations: all.length,
      pairedRecords: pairedRecords,
      singleItemRecords: singleItemRecords,
      noItemRecords: noItemRecords,
      maxItemsPerRecord: maxItems,
      truncatedRecords: truncatedRecords,
      thinSupport: thin,
      hidden: hidden,
      overflowed: overflowed,
      topRecords: rowsOut.length ? rowsOut[0][2] : 0,
    },
    notes: notes,
  });
}

/** One plain sentence for the panel header. */
export function describeFrequentCombinations(result) {
  if (!result || !result.ok) return 'This did not run.';
  const s = result.stats || {};
  if (!s.records) return 'The table has no rows, so there is nothing to combine.';
  if (!s.combinations) return 'No record holds two values at once, so there are no combinations.';
  return s.combinations.toLocaleString() + ' combination'
    + (s.combinations === 1 ? '' : 's') + ' across ' + s.distinctItems.toLocaleString()
    + ' value' + (s.distinctItems === 1 ? '' : 's') + ', from the '
    + s.pairedRecords.toLocaleString() + ' of ' + s.records.toLocaleString()
    + ' records that hold at least two. The most common appears in '
    + s.topRecords.toLocaleString() + ' record' + (s.topRecords === 1 ? '' : 's') + '.';
}

export const DataGlowFrequentCombinations = {
  FREQUENT_COMBINATIONS_VERSION,
  COMBO_SOURCES,
  COMBO_SOURCE_LABELS,
  THIN_SUPPORT,
  MAX_ITEMS_PER_RECORD,
  MAX_PAIRS,
  createEmptyCombinationsConfig,
  suggestCombinationsConfig,
  validateCombinationsConfig,
  itemsOfRow,
  buildCombinationsSQL,
  frequentCombinationsTransform,
  describeFrequentCombinations,
};
