// ============================================================
// DATAGLOW - Guided Unpivot / Reshape (pure engine)
// ============================================================
// Turns a wide "report style" sheet (Jan | Feb | Mar columns, or measure
// columns across) into tidy long form: id columns stay, the wide measure
// columns collapse into one name column + one value column. This is the
// inverse of js/pivot/pivot-builder.js's PIVOT. On-device. No DOM. No network.
//
// Design choice (mirrors pivot-builder.js): DataGlow already ships DuckDB-WASM
// with native UNPIVOT syntax, so buildUnpivotSQL() emits a real DuckDB UNPIVOT
// query for the glass-box SQL tab. But the PRIMARY apply path for canvas
// datasets is the pure in-memory unpivotTransform() (same as Excel Hell), so
// the reshape never depends on the source rows being registered as a DuckDB
// table. Both paths share identical semantics.
//
// Data model contract:
//   - rows are arrays: cell = row[colIdx]
//   - column types are UPPERCASE: 'INT'|'FLOAT'|'STR'|'DATE'|'BOOL'
//
// Public (never throws from a public API - returns { ok:false, error } instead):
//   createEmptyConfig(columnNames?)          -> config
//   suggestConfig(columnNames, sampleRows?)  -> config
//   validateConfig(config, columnNames)      -> { ok, errors }
//   quoteIdent(name)                         -> string
//   buildUnpivotSQL(config, sourceRelation)  -> { ok, sql?, errors? }
//   unpivotTransform(dataset, config)        -> { ok, columns, rows, error?, meta? }
//   preview(dataset, config, { maxRows })    -> { ok, columns, rows, ... error? }
//   fingerprintColumns(names)                -> string
//   serializeConfig(config) / parseConfig(json)

export const GUIDED_UNPIVOT_VERSION = 1;

const DEFAULT_NAME_COLUMN = 'attribute';
const DEFAULT_VALUE_COLUMN = 'value';
const DEFAULT_PREVIEW_ROWS = 20;
const VALID_VALUE_AS = ['STR', 'FLOAT', 'INT'];

// ---- small helpers ---------------------------------------------------------

function isBlank(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

function asName(col, i) {
  if (col == null) return 'col' + (i + 1);
  if (typeof col === 'string') return col;
  return col.name || col.field || ('col' + (i + 1));
}

function columnNamesOf(input) {
  if (!input) return [];
  // Accept either a plain array of names or a dataset-shaped { columns }.
  var cols = Array.isArray(input) ? input : (input.columns || []);
  return cols.map(asName);
}

function typeOfColumn(dataset, name) {
  var cols = (dataset && dataset.columns) || [];
  for (var i = 0; i < cols.length; i++) {
    if (asName(cols[i], i) === name) {
      var t = (cols[i] && cols[i].type) ? String(cols[i].type).toUpperCase() : 'STR';
      return t;
    }
  }
  return 'STR';
}

function indexOfColumn(names, name) {
  for (var i = 0; i < names.length; i++) if (names[i] === name) return i;
  return -1;
}

// ---- identifier quoting (same rules as pivot-builder.js) -------------------

// Double-quote a DuckDB identifier with internal double-quotes escaped, so a
// column named e.g. "patient id" or one that collides with a SQL keyword is
// always safe to interpolate. Never trust column names as pre-sanitized.
export function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// ---- config ----------------------------------------------------------------

export function createEmptyConfig(columnNames) {
  return {
    sourceTable: undefined,
    keepColumns: [],
    unpivotColumns: [],
    nameColumn: DEFAULT_NAME_COLUMN,
    valueColumn: DEFAULT_VALUE_COLUMN,
    valueAs: undefined,
    // remembered so the UI picker can render even before a pick is made
    allColumns: columnNamesOf(columnNames),
  };
}

// Heuristic suggestion (pure, never throws): columns whose header looks like a
// month / quarter / year, OR whose sampled values are mostly numeric, are the
// wide measure columns to unpivot; the first non-numeric-looking columns are
// the id columns to keep. Deliberately conservative so a wrong guess is easy
// to correct in the UI rather than surprising on apply.
var MONTHISH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*'?\d{0,4}$/i;
var QUARTERISH_RE = /^q[1-4]\b|\bq[1-4]$/i;
var YEARISH_RE = /^(19|20)\d{2}$/;
var NUM_RE = /^-?\$?\s*[\d,]*\.?\d+%?$/;

function headerLooksWide(name) {
  var s = String(name == null ? '' : name).trim();
  if (!s) return false;
  if (MONTHISH_RE.test(s)) return true;
  if (QUARTERISH_RE.test(s)) return true;
  if (YEARISH_RE.test(s)) return true;
  return false;
}

function columnMostlyNumeric(sampleRows, colIdx) {
  if (!Array.isArray(sampleRows) || sampleRows.length === 0) return false;
  var seen = 0, num = 0;
  for (var i = 0; i < sampleRows.length && seen < 50; i++) {
    var row = sampleRows[i];
    var v = row ? row[colIdx] : null;
    if (isBlank(v)) continue;
    seen++;
    if (typeof v === 'number' || NUM_RE.test(String(v).trim())) num++;
  }
  return seen > 0 && (num / seen) >= 0.8;
}

export function suggestConfig(columnNames, sampleRows) {
  var names = columnNamesOf(columnNames);
  var cfg = createEmptyConfig(names);
  if (names.length === 0) return cfg;

  var wide = [];
  var narrow = [];
  for (var i = 0; i < names.length; i++) {
    var isWide = headerLooksWide(names[i]) || columnMostlyNumeric(sampleRows, i);
    if (isWide) wide.push(names[i]);
    else narrow.push(names[i]);
  }

  // Need at least 2 wide columns for an unpivot to be meaningful; otherwise
  // fall back to "keep the first column, unpivot the rest" as a gentle default.
  if (wide.length >= 2) {
    cfg.keepColumns = narrow.slice(0, 3);
    cfg.unpivotColumns = wide.slice();
    // If every column looked wide, keep the first as an id so we don't melt
    // the whole table into a single ungrouped column pair.
    if (cfg.keepColumns.length === 0 && cfg.unpivotColumns.length > 1) {
      cfg.keepColumns = [cfg.unpivotColumns.shift()];
    }
  } else if (names.length >= 2) {
    cfg.keepColumns = [names[0]];
    cfg.unpivotColumns = names.slice(1);
  }
  return cfg;
}

// Validate a config against the current schema before SQL / transform. Surface
// every problem, not just the first, so the UI can show them all at once.
export function validateConfig(config, columnNames) {
  var errors = [];
  var names = columnNamesOf(columnNames);
  var known = Object.create(null);
  for (var i = 0; i < names.length; i++) known[names[i]] = 1;

  if (!config || typeof config !== 'object') {
    return { ok: false, errors: ['No unpivot configuration.'] };
  }
  var keep = Array.isArray(config.keepColumns) ? config.keepColumns : [];
  var unpiv = Array.isArray(config.unpivotColumns) ? config.unpivotColumns : [];

  if (unpiv.length === 0) errors.push('Pick at least one column to unpivot.');

  var keepSet = Object.create(null);
  for (var k = 0; k < keep.length; k++) {
    if (names.length && !known[keep[k]]) errors.push('Keep column "' + keep[k] + '" is not in the dataset.');
    keepSet[keep[k]] = 1;
  }
  for (var u = 0; u < unpiv.length; u++) {
    if (names.length && !known[unpiv[u]]) errors.push('Unpivot column "' + unpiv[u] + '" is not in the dataset.');
    if (keepSet[unpiv[u]]) errors.push('Column "' + unpiv[u] + '" cannot be both kept and unpivoted.');
  }
  var nameCol = config.nameColumn || DEFAULT_NAME_COLUMN;
  var valueCol = config.valueColumn || DEFAULT_VALUE_COLUMN;
  if (String(nameCol).trim() === '') errors.push('Name column cannot be empty.');
  if (String(valueCol).trim() === '') errors.push('Value column cannot be empty.');
  if (String(nameCol) === String(valueCol)) errors.push('Name column and value column must differ.');
  if (config.valueAs && VALID_VALUE_AS.indexOf(String(config.valueAs).toUpperCase()) === -1) {
    errors.push('Unknown valueAs hint "' + config.valueAs + '".');
  }

  return { ok: errors.length === 0, errors: errors };
}

// ---- DuckDB UNPIVOT SQL (glass-box) ----------------------------------------

// DuckDB native UNPIVOT (recognized by the SQL tab's highlighter, same engine
// pivot-builder.js targets):
//   UNPIVOT <relation> ON c1, c2, c3 INTO NAME <nameCol> VALUE <valueCol>
// The id (keep) columns are carried through automatically by UNPIVOT - every
// column not named in ON stays as-is. When keepColumns is an explicit subset
// we SELECT keep + name + value from the UNPIVOT so the output is exactly the
// tidy shape, never stray extra columns.
export function buildUnpivotSQL(config, sourceRelation) {
  var v = validateConfig(config, config && config.allColumns ? config.allColumns : []);
  // allColumns is optional here; only hard structural errors block SQL.
  var hardErrors = [];
  if (!config || !Array.isArray(config.unpivotColumns) || config.unpivotColumns.length === 0) {
    hardErrors.push('Pick at least one column to unpivot.');
  }
  if (hardErrors.length) return { ok: false, errors: hardErrors };

  var rel = sourceRelation && String(sourceRelation).trim()
    ? String(sourceRelation).trim()
    : quoteIdent(config.sourceTable || 'dataset');

  var nameCol = config.nameColumn || DEFAULT_NAME_COLUMN;
  var valueCol = config.valueColumn || DEFAULT_VALUE_COLUMN;
  var onList = config.unpivotColumns.map(quoteIdent).join(', ');

  var unpivotExpr =
    'UNPIVOT ' + rel + '\n' +
    'ON ' + onList + '\n' +
    'INTO NAME ' + quoteIdent(nameCol) + ' VALUE ' + quoteIdent(valueCol);

  var keep = Array.isArray(config.keepColumns) ? config.keepColumns : [];
  var sql;
  if (keep.length > 0) {
    var selectCols = keep.map(quoteIdent)
      .concat([quoteIdent(nameCol), quoteIdent(valueCol)])
      .join(', ');
    sql = 'SELECT ' + selectCols + '\nFROM (\n  ' +
      unpivotExpr.replace(/\n/g, '\n  ') + '\n)';
  } else {
    sql = unpivotExpr;
  }
  return { ok: true, sql: sql, errors: (v.errors || []) };
}

// ---- pure in-memory transform (PRIMARY apply path) -------------------------

function coerceValue(v, valueAs) {
  if (isBlank(v)) return null;
  if (!valueAs) return v;
  var s = String(v).trim();
  switch (String(valueAs).toUpperCase()) {
    case 'INT': {
      var n = parseInt(s.replace(/[,$%\s]/g, ''), 10);
      return isNaN(n) ? v : n;
    }
    case 'FLOAT': {
      var f = parseFloat(s.replace(/[,$%\s]/g, ''));
      return isNaN(f) ? v : f;
    }
    case 'STR':
      return s;
    default:
      return v;
  }
}

// Infer the output value column type from the source unpivot columns' declared
// types: if every unpivoted column shares one numeric type, keep it; if they
// mix numeric kinds use FLOAT; otherwise STR. An explicit valueAs hint wins.
function inferValueType(dataset, config) {
  if (config.valueAs) return String(config.valueAs).toUpperCase();
  var types = config.unpivotColumns.map(function (c) { return typeOfColumn(dataset, c); });
  if (types.length === 0) return 'STR';
  var uniq = {};
  types.forEach(function (t) { uniq[t] = 1; });
  var keys = Object.keys(uniq);
  if (keys.length === 1) return keys[0];
  var allNumeric = keys.every(function (t) { return t === 'INT' || t === 'FLOAT'; });
  if (allNumeric) return 'FLOAT';
  return 'STR';
}

export function unpivotTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') {
    return { ok: false, error: 'No dataset to reshape.' };
  }
  var names = columnNamesOf(dataset);
  var v = validateConfig(config, names);
  if (!v.ok) return { ok: false, error: v.errors.join(' ') };

  var srcRows = Array.isArray(dataset.rows) ? dataset.rows : [];
  var keep = config.keepColumns.slice();
  var unpiv = config.unpivotColumns.slice();
  var nameCol = config.nameColumn || DEFAULT_NAME_COLUMN;
  var valueCol = config.valueColumn || DEFAULT_VALUE_COLUMN;

  var keepIdx = keep.map(function (n) { return indexOfColumn(names, n); });
  var unpivIdx = unpiv.map(function (n) { return indexOfColumn(names, n); });

  var valueType = inferValueType(dataset, config);

  var outColumns = keep.map(function (n) {
    return { name: n, type: typeOfColumn(dataset, n) };
  });
  outColumns.push({ name: nameCol, type: 'STR' });
  outColumns.push({ name: valueCol, type: valueType });

  var dropNull = !!config.dropNullValues;
  var outRows = [];
  // Preserve row order: for each input row, emit one output row per unpivot col.
  for (var r = 0; r < srcRows.length; r++) {
    var row = srcRows[r] || [];
    var kept = [];
    for (var ki = 0; ki < keepIdx.length; ki++) {
      kept.push(keepIdx[ki] >= 0 ? row[keepIdx[ki]] : null);
    }
    for (var ui = 0; ui < unpivIdx.length; ui++) {
      var raw = unpivIdx[ui] >= 0 ? row[unpivIdx[ui]] : null;
      if (dropNull && isBlank(raw)) continue;
      var out = kept.slice();
      out.push(unpiv[ui]);
      out.push(coerceValue(raw, valueType === 'STR' && !config.valueAs ? null : valueType));
      outRows.push(out);
    }
  }

  return {
    ok: true,
    columns: outColumns,
    rows: outRows,
    meta: {
      inputRows: srcRows.length,
      keepColumns: keep.length,
      unpivotColumns: unpiv.length,
      valueType: valueType,
    },
  };
}

export function preview(dataset, config, opts) {
  opts = opts || {};
  var maxRows = typeof opts.maxRows === 'number' ? opts.maxRows : DEFAULT_PREVIEW_ROWS;
  var t = unpivotTransform(dataset, config);
  if (!t.ok) {
    return { ok: false, columns: [], rows: [], inputRow: 0, outputRowEstimate: 0, error: t.error };
  }
  var inputRows = (dataset && Array.isArray(dataset.rows)) ? dataset.rows.length : 0;
  var estimate = config.dropNullValues
    ? t.rows.length
    : inputRows * config.unpivotColumns.length;
  return {
    ok: true,
    columns: t.columns,
    rows: t.rows.slice(0, maxRows),
    inputRow: inputRows,
    outputRowEstimate: estimate,
    totalRows: t.rows.length,
    meta: t.meta,
  };
}

// ---- fingerprint + (de)serialize -------------------------------------------

// Simple stable join hash of column names for later recipe-staleness checks.
export function fingerprintColumns(names) {
  var list = columnNamesOf(names);
  var s = list.join('|').toLowerCase();
  var h = 0;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

export function serializeConfig(config) {
  try {
    return JSON.stringify({
      v: GUIDED_UNPIVOT_VERSION,
      sourceTable: config.sourceTable,
      keepColumns: config.keepColumns || [],
      unpivotColumns: config.unpivotColumns || [],
      nameColumn: config.nameColumn || DEFAULT_NAME_COLUMN,
      valueColumn: config.valueColumn || DEFAULT_VALUE_COLUMN,
      valueAs: config.valueAs,
    });
  } catch (_e) {
    return '{}';
  }
}

export function parseConfig(json) {
  try {
    var o = JSON.parse(json);
    var cfg = createEmptyConfig(o.allColumns || []);
    cfg.sourceTable = o.sourceTable;
    cfg.keepColumns = Array.isArray(o.keepColumns) ? o.keepColumns : [];
    cfg.unpivotColumns = Array.isArray(o.unpivotColumns) ? o.unpivotColumns : [];
    cfg.nameColumn = o.nameColumn || DEFAULT_NAME_COLUMN;
    cfg.valueColumn = o.valueColumn || DEFAULT_VALUE_COLUMN;
    cfg.valueAs = o.valueAs;
    return { ok: true, config: cfg };
  } catch (e) {
    return { ok: false, error: 'Could not parse config: ' + e.message };
  }
}

export const DataGlowGuidedUnpivot = {
  version: GUIDED_UNPIVOT_VERSION,
  createEmptyConfig: createEmptyConfig,
  suggestConfig: suggestConfig,
  validateConfig: validateConfig,
  quoteIdent: quoteIdent,
  buildUnpivotSQL: buildUnpivotSQL,
  unpivotTransform: unpivotTransform,
  preview: preview,
  fingerprintColumns: fingerprintColumns,
  serializeConfig: serializeConfig,
  parseConfig: parseConfig,
};

if (typeof window !== 'undefined') {
  window.DataGlowGuidedUnpivot = DataGlowGuidedUnpivot;
}
