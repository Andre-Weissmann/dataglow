// ============================================================
// DATAGLOW - A27 Bin a numeric column, with the edges shown
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. Age becomes age bands, spend becomes spend bands, response
// time becomes fast/slow. Every grouped chart and every crosstab of a continuous
// number needs this, and the edges are the whole argument: 0 to 17, 18 to 64,
// 65 and over says one thing about a population, and 0 to 29, 30 to 59, 60 and
// over says another about the same people.
//
// THE HISTOGRAM IS NOT DECORATION.
// Equal-width bins on a skewed column are the classic quiet mistake: ten bins
// across a spend column with one outlier at a million puts 99% of the rows in
// the first bin and produces a chart that looks fine and says nothing. So
// binCounts() returns the count in every bin as part of the engine, not as a
// drawing step, which means the UI can show the shape before the person commits
// and a test can assert that shape without a canvas.
//
// EDGES ARE HALF-OPEN, AND THAT IS SAID EVERYWHERE.
// A bin is [low, high): the low edge belongs to it, the high edge belongs to the
// next one. The last bin is closed at the top so the maximum value has somewhere
// to go. Without stating this, a value exactly on an edge lands in whichever bin
// the reader assumed, and two people counting "under 18" get different answers.
// The rule is in the labels, in the SQL comment, and in the notes.
//
// A VALUE OUTSIDE THE EDGES IS NOT FORCED INTO THE NEAREST BIN.
// With custom edges someone will type a range that does not cover the data.
// Widening the end bins to swallow the strays would hide exactly the values
// worth seeing, so they get a blank label and a count in the notes.
//
// THIS IS NOT THE CHART HISTOGRAM.
// js/chart/chart-engine.js draws a histogram for display and throws its buckets
// away. This produces a real column that persists into the table, joins, and
// exports. They answer different questions and neither should call the other.

import {
  quoteIdent,
  quoteLiteral,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  isNumericType,
  toNumber,
  isPlainObject,
  column,
  typeOfColumn,
  TYPE_INT,
  TYPE_STR,
  transformResult,
  transformError,
} from './transform-core.js';

export const BIN_EDITOR_VERSION = 1;

export const BIN_MODES = Object.freeze(['equalWidth', 'custom']);

export const BIN_MODE_LABELS = Object.freeze({
  equalWidth: 'Same-width bins',
  custom: 'Edges I choose',
});

export const MIN_BINS = 2;

// Past this the bands stop being a summary. Forty bins on a bar chart is a
// histogram with extra steps, and the point of binning was to reduce.
export const MAX_BINS = 100;

export const DEFAULT_BINS = 10;

export function createEmptyBinConfig() {
  return {
    column: '',
    mode: 'equalWidth',
    binCount: DEFAULT_BINS,
    edges: [],
    labelColumn: '',
    includeBinIndex: true,
    keepOriginal: true,
    decimals: null, // null means work it out from the width of a bin
  };
}

export function suggestBinConfig(dataset) {
  const cfg = createEmptyBinConfig();
  const cols = (dataset && dataset.columns) || [];
  const rows = rowsOf(dataset);
  const names = columnNamesOf(dataset);

  // A numeric column with many distinct values is the one worth binning. An
  // integer flag column is numeric and binning it is meaningless, so distinctness
  // is the test rather than the declared type alone.
  let best = null;
  for (let i = 0; i < cols.length; i += 1) {
    if (!cols[i] || !isNumericType(cols[i].type)) continue;
    const seen = new Set();
    let looked = 0;
    for (let r = 0; r < rows.length && looked < 200; r += 1) {
      if (!Array.isArray(rows[r])) continue;
      looked += 1;
      const n = toNumber(rows[r][i]);
      if (n !== null) seen.add(n);
    }
    if (seen.size < 4) continue;
    if (!best || seen.size > best.distinct) best = { name: cols[i].name, distinct: seen.size };
  }
  cfg.column = best ? best.name : (names[0] || '');
  if (cfg.column) cfg.labelColumn = cfg.column + '_bin';
  return cfg;
}

/** The name of the generated label column. */
export function binLabelColumn(config) {
  const explicit = String((config && config.labelColumn) || '').trim();
  if (explicit) return explicit;
  return String((config && config.column) || 'value') + '_bin';
}

/** Edges given by the person: numeric, sorted, de-duplicated. Sorting rather
    than rejecting an unsorted list is safe because the set of edges means the
    same thing in any order, unlike a list of bin labels. */
export function normalizeEdges(edges) {
  const list = Array.isArray(edges) ? edges : String(edges || '').split(',');
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const n = toNumber(list[i]);
    if (n === null) continue;
    if (out.indexOf(n) === -1) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

export function validateBinConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  if (!config.column) errors.push('Pick the number column to put into bands.');
  else if (!names.includes(config.column)) {
    errors.push('The column ' + config.column + ' is not in this table.');
  }

  const label = binLabelColumn(config);
  if (names.includes(label)) {
    errors.push('This table already has a column called ' + label
      + '. Choose another name for the band column.');
  }
  if (config.includeBinIndex !== false && names.includes(label + '_index')) {
    errors.push('This table already has a column called ' + label + '_index.');
  }

  const mode = config.mode || 'equalWidth';
  if (BIN_MODES.indexOf(mode) === -1) {
    errors.push('Choose whether the bands are the same width or set by hand.');
    return { ok: false, errors: errors };
  }

  if (mode === 'equalWidth') {
    const n = Number(config.binCount);
    if (!Number.isFinite(n) || Math.floor(n) !== n) {
      errors.push('Give the number of bands as a whole number.');
    } else if (n < MIN_BINS || n > MAX_BINS) {
      errors.push('The number of bands has to be between ' + MIN_BINS + ' and ' + MAX_BINS + '.');
    }
  } else {
    const edges = normalizeEdges(config.edges);
    if (edges.length < 2) {
      errors.push('Give at least two edges, such as 0, 18, 65. '
        + 'Two edges make one band, three make two, and so on.');
    } else if (edges.length - 1 > MAX_BINS) {
      errors.push('That is more than ' + MAX_BINS + ' bands.');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

/** The smallest and largest readable value, plus how many rows could not be
    read. Returns nulls rather than Infinity for an empty column, so a caller
    cannot accidentally build a bin from
    Infinity to -Infinity. */
export function numericExtent(dataset, columnName) {
  const names = columnNamesOf(dataset);
  const idx = indexOfColumn(names, columnName);
  const rows = rowsOf(dataset);
  let min = null;
  let max = null;
  let readable = 0;
  let unreadable = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const v = row[idx];
    if (v == null || v === '') { unreadable += 1; continue; }
    const n = toNumber(v);
    if (n === null) { unreadable += 1; continue; }
    readable += 1;
    if (min === null || n < min) min = n;
    if (max === null || n > max) max = n;
  }
  return { min: min, max: max, readable: readable, unreadable: unreadable };
}

function roundTo(value, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

/** How many decimals a label needs, from how wide a bin is. Ten bins over 0 to 1
    labelled as whole numbers would read "0 to 0" ten times, which is not a
    labelling problem, it is an unreadable result. */
function decimalsFor(width, configured) {
  if (configured != null && configured !== '' && Number.isFinite(Number(configured))) {
    return Math.max(0, Math.min(10, Math.floor(Number(configured))));
  }
  if (!Number.isFinite(width) || width <= 0) return 0;
  if (width >= 10) return 0;
  if (width >= 1) return 1;
  return Math.min(10, Math.ceil(-Math.log10(width)) + 1);
}

/**
 * The edges this configuration produces against this table.
 *
 * Equal-width edges depend on the data, so they cannot be computed from the
 * config alone. One function owns that so the label text, the counts, the rows
 * and the SQL all come from the same list and cannot drift apart.
 */
export function resolveBins(dataset, config) {
  const mode = config.mode || 'equalWidth';
  if (mode === 'custom') {
    const edges = normalizeEdges(config.edges);
    return { ok: edges.length >= 2, edges: edges, extent: numericExtent(dataset, config.column) };
  }

  const extent = numericExtent(dataset, config.column);
  if (extent.min === null) return { ok: false, edges: [], extent: extent };

  const count = Math.max(MIN_BINS, Math.min(MAX_BINS, Math.floor(Number(config.binCount) || DEFAULT_BINS)));
  if (extent.max === extent.min) {
    // Every value is the same. One bin wide enough to hold it is the honest
    // answer; splitting a zero-width range into ten bands would invent nine
    // empty ones and imply a spread that is not there.
    return { ok: true, edges: [extent.min, extent.min + 1], extent: extent, degenerate: true };
  }

  const width = (extent.max - extent.min) / count;
  const edges = [];
  for (let i = 0; i <= count; i += 1) edges.push(extent.min + width * i);
  // The top edge is set exactly rather than accumulated, so floating point drift
  // cannot leave the maximum value a hair outside the last bin.
  edges[count] = extent.max;
  return { ok: true, edges: edges, extent: extent };
}

/** The label for bin i, in the half-open convention. The last bin says "or more"
    only when it is genuinely the top of the data. */
export function binLabels(edges, decimals) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const lo = roundTo(edges[i], decimals);
    const hi = roundTo(edges[i + 1], decimals);
    out.push(String(lo) + ' to ' + String(hi));
  }
  return out;
}

/** Which bin a value falls in, or -1 if it is outside every bin. Half-open on
    the low edge, with the top bin closed so the maximum has a home. */
export function binIndexOf(value, edges) {
  const n = toNumber(value);
  if (n === null) return -1;
  if (n < edges[0]) return -1;
  const last = edges.length - 1;
  if (n > edges[last]) return -1;
  if (n === edges[last]) return last - 1;
  for (let i = 0; i < last; i += 1) {
    if (n >= edges[i] && n < edges[i + 1]) return i;
  }
  return -1;
}

/**
 * The count in every bin, for the live histogram.
 *
 * Part of the engine rather than the drawing code because the shape is the
 * argument for or against the edges, and a shape a test cannot see is a shape
 * nobody checked.
 */
export function binCounts(dataset, config) {
  if (!dataset || typeof dataset !== 'object') {
    return { ok: false, error: 'There is no table loaded.' };
  }
  const names = columnNamesOf(dataset);
  const v = validateBinConfig(config, names);
  if (!v.ok) return { ok: false, error: v.errors.join(' ') };

  const resolved = resolveBins(dataset, config);
  if (!resolved.ok) {
    return { ok: false, error: 'No readable number was found in ' + config.column + '.' };
  }
  const edges = resolved.edges;
  const width = edges.length > 1 ? (edges[1] - edges[0]) : 0;
  const decimals = decimalsFor(width, config.decimals);
  const labels = binLabels(edges, decimals);

  const idx = indexOfColumn(names, config.column);
  const rows = rowsOf(dataset);
  const counts = labels.map(() => 0);
  let below = 0;
  let above = 0;
  let unreadable = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const n = toNumber(row[idx]);
    if (n === null) { unreadable += 1; continue; }
    if (n < edges[0]) { below += 1; continue; }
    if (n > edges[edges.length - 1]) { above += 1; continue; }
    counts[binIndexOf(n, edges)] += 1;
  }

  const inRange = counts.reduce((a, b) => a + b, 0);
  const biggest = counts.reduce((a, b) => (b > a ? b : a), 0);
  const warnings = [];

  // The skew check that makes equal-width binning honest. One bin holding almost
  // everything means the edges are describing an outlier, not the data.
  if (inRange > 0 && counts.length > 2 && biggest / inRange >= 0.9) {
    warnings.push('One band holds ' + Math.round((biggest / inRange) * 100) + '% of the rows. '
      + 'Same-width bands do that on a skewed column: one very large value stretches the range and '
      + 'everything else lands in the first band. Custom edges usually read better here.');
  }
  const empties = counts.filter((c) => c === 0).length;
  if (empties > 0 && counts.length > 2) {
    warnings.push(empties + ' band' + (empties === 1 ? ' is' : 's are') + ' empty.');
  }
  if (below > 0 || above > 0) {
    warnings.push((below + above) + ' value' + (below + above === 1 ? ' falls' : 's fall')
      + ' outside the edges and will get a blank band. Widening the end bands to swallow them '
      + 'would hide the values most worth looking at.');
  }

  return {
    ok: true,
    edges: edges.slice(),
    labels: labels,
    counts: counts,
    decimals: decimals,
    below: below,
    above: above,
    unreadable: unreadable,
    inRange: inRange,
    largestBin: biggest,
    extent: resolved.extent,
    warnings: warnings,
  };
}

/**
 * The glass-box SQL. A plain CASE ladder rather than DuckDB's width_bucket,
 * because the reader has to be able to check the edges against their own
 * definition, and a bucket number does not show them.
 */
export function buildBinSQL(config, sourceRelation, edges, decimals) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const t = relationName(sourceRelation, 'source');
  const c = quoteIdent(config.column);
  const label = quoteIdent(binLabelColumn(config));
  const list = Array.isArray(edges) && edges.length >= 2 ? edges : normalizeEdges(config.edges);
  if (list.length < 2) {
    return { ok: false, errors: ['There are no edges to write a CASE over yet.'] };
  }
  const dp = Number.isFinite(Number(decimals)) ? Number(decimals) : 0;
  const labels = binLabels(list, dp);
  const keep = config.keepOriginal !== false;

  const caseLines = ['  CASE'];
  for (let i = 0; i < labels.length; i += 1) {
    const lo = roundTo(list[i], dp);
    const hi = roundTo(list[i + 1], dp);
    const isLast = i === labels.length - 1;
    caseLines.push('    WHEN ' + c + ' >= ' + lo + ' AND ' + c
      + (isLast ? ' <= ' : ' < ') + hi + ' THEN ' + quoteLiteral(labels[i]));
  }
  // No ELSE branch that invents a catch-all band. A value outside every edge is
  // NULL here for the same reason it is blank in the computed result.
  caseLines.push('    ELSE NULL');
  caseLines.push('  END AS ' + label);

  const idxLines = [];
  if (config.includeBinIndex !== false) {
    idxLines.push('  CASE');
    for (let i = 0; i < labels.length; i += 1) {
      const lo = roundTo(list[i], dp);
      const hi = roundTo(list[i + 1], dp);
      const isLast = i === labels.length - 1;
      idxLines.push('    WHEN ' + c + ' >= ' + lo + ' AND ' + c
        + (isLast ? ' <= ' : ' < ') + hi + ' THEN ' + (i + 1));
    }
    idxLines.push('    ELSE NULL');
    idxLines.push('  END AS ' + quoteIdent(binLabelColumn(config) + '_index'));
  }

  const lines = [
    '-- Put ' + c + ' into ' + labels.length + ' band'
      + (labels.length === 1 ? '' : 's') + '.',
    '-- Bands are half-open: a value on an edge belongs to the band above it, so',
    '-- 18 is in "18 to 65" and not in "0 to 18". The top band is closed at the',
    '-- top so the largest value has somewhere to go.',
    '-- A value outside every band is NULL rather than being pulled into the',
    '-- nearest one, because a value out of range is worth seeing.',
    'SELECT',
    keep ? '  *,' : '  * EXCLUDE (' + c + '),',
  ];
  lines.push(caseLines.join('\n') + (idxLines.length ? ',' : ''));
  if (idxLines.length) lines.push(idxLines.join('\n'));
  lines.push('FROM ' + t);

  if (!keep) {
    lines.push('');
    lines.push('-- The original ' + c + ' is dropped, as configured. Once it is gone the exact');
    lines.push('-- value cannot be recovered from the band, so keeping it is the safer default.');
  }

  return { ok: true, sql: lines.join('\n') };
}

export function binColumnTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateBinConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const counted = binCounts(dataset, config);
  if (!counted.ok) return transformError(counted.error);

  const edges = counted.edges;
  const labels = counted.labels;
  const idx = indexOfColumn(names, config.column);
  const rows = rowsOf(dataset);
  const keep = config.keepOriginal !== false;
  const withIndex = config.includeBinIndex !== false;
  const labelName = binLabelColumn(config);

  const outColumns = [];
  for (let i = 0; i < names.length; i += 1) {
    if (!keep && i === idx) continue;
    outColumns.push(column(names[i], typeOfColumn(dataset, names[i])));
  }
  outColumns.push(column(labelName, TYPE_STR));
  if (withIndex) outColumns.push(column(labelName + '_index', TYPE_INT));

  const out = [];
  let labelled = 0;
  let blank = 0;

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const b = binIndexOf(row[idx], edges);
    const base = keep ? row.slice() : row.slice(0, idx).concat(row.slice(idx + 1));
    if (b === -1) {
      blank += 1;
      out.push(base.concat(withIndex ? [null, null] : [null]));
    } else {
      labelled += 1;
      out.push(base.concat(withIndex ? [labels[b], b + 1] : [labels[b]]));
    }
  }

  const built = buildBinSQL(config, dataset.name, edges, counted.decimals);
  const notes = [];

  notes.push('Bands are half-open: a value sitting exactly on an edge goes into the band above it, '
    + 'so 18 is in "18 to 65" and not in "0 to 18". The top band is closed at the top so the '
    + 'largest value is not left out. Say this out loud when someone quotes a band count, because '
    + 'the other convention gives a different number over the same data.');

  if (config.mode !== 'custom') {
    notes.push('The edges come from the smallest and largest value in ' + config.column
      + ' (' + counted.extent.min + ' to ' + counted.extent.max + '), so they are a property of '
      + 'this table and not a fixed scale. Filter the table differently and the same setting gives '
      + 'different bands, which makes two runs hard to compare. Custom edges are the fix when the '
      + 'bands need to mean the same thing twice.');
  }
  if (blank > 0) {
    notes.push(blank + ' row' + (blank === 1 ? '' : 's') + ' got a blank band, either because the '
      + 'value could not be read as a number or because it falls outside the edges. Neither was '
      + 'pulled into the nearest band: an out-of-range value is usually the one worth looking at.');
  }
  if (counted.unreadable > 0) {
    notes.push('Of those, ' + counted.unreadable + ' had no readable number in ' + config.column
      + '.');
  }
  if (!keep) {
    notes.push('The original ' + config.column + ' has been dropped. The exact value cannot be '
      + 'recovered from a band, so anything downstream that needs the number needs it from before '
      + 'this step.');
  }
  for (let i = 0; i < counted.warnings.length; i += 1) notes.push(counted.warnings[i]);

  return transformResult({
    columns: outColumns,
    rows: out,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: rows.length,
      rowsOut: out.length,
      bins: labels.length,
      labelled: labelled,
      blank: blank,
      below: counted.below,
      above: counted.above,
      unreadable: counted.unreadable,
      edges: edges.slice(),
      labels: labels.slice(),
      counts: counted.counts.slice(),
      min: counted.extent.min,
      max: counted.extent.max,
    },
    notes: notes,
  });
}

/** One plain sentence for the panel header. */
export function describeBinColumn(result) {
  if (!result || !result.ok) return 'This binning did not run.';
  const s = result.stats || {};
  if (!s.rowsIn) return 'The table has no rows, so there is nothing to band.';
  const blank = s.blank
    ? ' ' + s.blank + ' row' + (s.blank === 1 ? '' : 's') + ' got a blank band.'
    : '';
  return s.labelled.toLocaleString() + ' of ' + s.rowsIn.toLocaleString() + ' rows fall into '
    + s.bins + ' band' + (s.bins === 1 ? '' : 's') + '. The row count does not change.' + blank;
}

export const DataGlowBinEditor = {
  BIN_EDITOR_VERSION,
  BIN_MODES,
  BIN_MODE_LABELS,
  MIN_BINS,
  MAX_BINS,
  DEFAULT_BINS,
  createEmptyBinConfig,
  suggestBinConfig,
  binLabelColumn,
  normalizeEdges,
  validateBinConfig,
  numericExtent,
  resolveBins,
  binLabels,
  binIndexOf,
  binCounts,
  buildBinSQL,
  binColumnTransform,
  describeBinColumn,
};
