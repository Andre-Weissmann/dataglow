// ============================================================
// DATAGLOW - Repair Recipe Library (pure engine)
// ============================================================
// Analysts repair messy files with Excel Hell (and Guided Unpivot). Today the
// recipe dies with the session. This engine turns a repair recipe into a small,
// named, JSON-safe RECORD that can be saved on-device and reapplied to a new
// file of the same shape family. No DOM. No network. Node-testable.
//
// Hard privacy rule: a record is METADATA ONLY. It carries the recipe steps (or
// unpivot config) and the column NAMES seen at save time - never raw rows, never
// cell values. createRecipeRecord() and validateRecord() both actively strip /
// reject row-bearing fields so a caller cannot accidentally persist PHI.
//
// Data model contract (shared with excel-hell-repair.js / guided-unpivot.js):
//   - rows are arrays: cell = row[colIdx]
//   - column types are UPPERCASE: 'INT'|'FLOAT'|'STR'|'DATE'|'BOOL'
//
// Public (never throws from a public API - returns { ok:false, error } or a
// safe empty value instead):
//   createRecipeRecord({ name, kind, payload, columnNames, sourceName, fingerprint, notes }) -> record
//   validateRecord(record)                 -> { ok, errors }
//   serializeLibrary(records)              -> string
//   parseLibrary(json)                     -> { ok, records?, error? }
//   scoreRecipeMatch(record, columnNames)  -> { score, matched, missing, extra, canApply, warning? }
//   getApplyPayload(record)                -> { ok, kind, payload, error? }
//   sortRecipes(records, by)               -> records (new array)
//   filterRecipes(records, { kind, query })-> records (new array)

export const REPAIR_RECIPE_LIBRARY_VERSION = 1;

export const RECIPE_KINDS = ['excelHell', 'guidedUnpivot'];

// Below this overlap score (percent) we still allow a preview but warn loudly
// that the columns have drifted from what the recipe was built against.
const MATCH_WARN_THRESHOLD = 50;

// Fields that would smuggle raw row data into a record. Stripped on create,
// rejected on validate. This is the privacy backstop for the whole feature.
const ROW_BEARING_FIELDS = ['rows', 'data', 'values', 'cells', 'sampleRows', 'records'];

// ---- small helpers ---------------------------------------------------------

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function asName(col, i) {
  if (col == null) return 'col' + (i + 1);
  if (typeof col === 'string') return col;
  return col.name || col.field || ('col' + (i + 1));
}

// Accept either a plain array of names or a dataset-shaped { columns }.
export function normalizeColumnNames(input) {
  if (!input) return [];
  var cols = Array.isArray(input) ? input : (input.columns || []);
  if (!Array.isArray(cols)) return [];
  return cols.map(asName).filter(isNonEmptyString);
}

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  // Time-ordered, collision-resistant enough for on-device use; no crypto dep.
  return 'recipe-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

// Deep-ish clone that drops row-bearing keys anywhere in the payload object so
// a recipe config carrying a stray sample can never persist row data. Pure JSON
// round-trip (recipes are JSON-safe by contract) then prune known keys.
function sanitizePayload(payload) {
  var stripped = 0;
  function prune(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(prune);
    var out = {};
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      if (ROW_BEARING_FIELDS.indexOf(k) !== -1) { stripped++; continue; }
      out[k] = prune(node[k]);
    }
    return out;
  }
  var clean;
  try {
    clean = prune(JSON.parse(JSON.stringify(payload == null ? {} : payload)));
  } catch (_e) {
    clean = {};
  }
  return { payload: clean, stripped: stripped };
}

// ---- create / validate ------------------------------------------------------

export function createRecipeRecord(opts) {
  opts = opts || {};
  var kind = RECIPE_KINDS.indexOf(opts.kind) !== -1 ? opts.kind : 'excelHell';
  var sanitized = sanitizePayload(opts.payload);
  var columnNames = normalizeColumnNames(opts.columnNames);
  var ts = nowIso();
  var record = {
    id: isNonEmptyString(opts.id) ? opts.id : makeId(),
    name: isNonEmptyString(opts.name) ? String(opts.name).trim() : 'Untitled recipe',
    kind: kind,
    createdAt: isNonEmptyString(opts.createdAt) ? opts.createdAt : ts,
    updatedAt: ts,
    columnNames: columnNames,
    payload: sanitized.payload,
    version: REPAIR_RECIPE_LIBRARY_VERSION,
  };
  if (isNonEmptyString(opts.sourceName)) record.sourceName = String(opts.sourceName).trim();
  if (opts.fingerprint != null) record.fingerprint = opts.fingerprint;
  if (isNonEmptyString(opts.notes)) record.notes = String(opts.notes).trim();
  return record;
}

// Validate a record before persisting. Surfaces every problem, not just the
// first, and hard-rejects any row-bearing field as a privacy violation.
export function validateRecord(record) {
  var errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, errors: ['Not a recipe record.'] };
  }
  if (!isNonEmptyString(record.id)) errors.push('Recipe id is required.');
  if (!isNonEmptyString(record.name)) errors.push('Recipe name is required.');
  if (RECIPE_KINDS.indexOf(record.kind) === -1) {
    errors.push('Unknown recipe kind "' + record.kind + '".');
  }
  if (!record.payload || typeof record.payload !== 'object') {
    errors.push('Recipe payload is missing.');
  }
  if (!Array.isArray(record.columnNames)) {
    errors.push('Recipe columnNames must be an array.');
  }
  // Privacy backstop: no row data anywhere in the record or its payload.
  var offenders = findRowBearingKeys(record);
  if (offenders.length) {
    errors.push('Recipe must not contain row data (found: ' + offenders.join(', ') + ').');
  }
  return { ok: errors.length === 0, errors: errors };
}

function findRowBearingKeys(node, acc, depth) {
  acc = acc || [];
  depth = depth || 0;
  if (!node || typeof node !== 'object' || depth > 12) return acc;
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) findRowBearingKeys(node[i], acc, depth + 1);
    return acc;
  }
  for (var k in node) {
    if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
    if (ROW_BEARING_FIELDS.indexOf(k) !== -1 && acc.indexOf(k) === -1) acc.push(k);
    findRowBearingKeys(node[k], acc, depth + 1);
  }
  return acc;
}

// ---- (de)serialize a whole library -----------------------------------------

export function serializeLibrary(records) {
  var list = Array.isArray(records) ? records : [];
  try {
    return JSON.stringify({
      v: REPAIR_RECIPE_LIBRARY_VERSION,
      exportedAt: nowIso(),
      records: list,
    }, null, 2);
  } catch (_e) {
    return JSON.stringify({ v: REPAIR_RECIPE_LIBRARY_VERSION, records: [] });
  }
}

export function parseLibrary(json) {
  var o;
  try {
    o = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (e) {
    return { ok: false, error: 'Could not parse library: ' + e.message };
  }
  if (!o || typeof o !== 'object') return { ok: false, error: 'Library is not an object.' };
  var raw = Array.isArray(o) ? o : (Array.isArray(o.records) ? o.records : null);
  if (!raw) return { ok: false, error: 'Library has no records array.' };
  var records = [];
  for (var i = 0; i < raw.length; i++) {
    var v = validateRecord(raw[i]);
    if (v.ok) records.push(raw[i]);
  }
  return { ok: true, records: records };
}

// ---- match scoring ----------------------------------------------------------

// Case-insensitive set overlap between the columns a recipe was built against
// and the columns of a new dataset. score is the Jaccard-like overlap of the
// recipe's own columns that are still present (recall of recipe columns), 0-100.
export function scoreRecipeMatch(record, columnNames) {
  var recipeCols = (record && Array.isArray(record.columnNames)) ? record.columnNames : [];
  var newCols = normalizeColumnNames(columnNames);

  var recipeSet = Object.create(null);
  recipeCols.forEach(function (c) { recipeSet[String(c).toLowerCase()] = c; });
  var newSet = Object.create(null);
  newCols.forEach(function (c) { newSet[String(c).toLowerCase()] = c; });

  var matched = [];
  var missing = [];
  var extra = [];
  Object.keys(recipeSet).forEach(function (lc) {
    if (newSet[lc] != null) matched.push(recipeSet[lc]);
    else missing.push(recipeSet[lc]);
  });
  Object.keys(newSet).forEach(function (lc) {
    if (recipeSet[lc] == null) extra.push(newSet[lc]);
  });

  var denom = recipeCols.length;
  var score = denom === 0 ? 0 : Math.round((matched.length / denom) * 100);
  // With no recorded columns to compare against we cannot judge fit; treat as a
  // soft unknown that still previews (excelHell recipes work off raw rows).
  if (denom === 0) score = 0;

  var canApply = score >= MATCH_WARN_THRESHOLD || denom === 0;
  var warning;
  if (denom === 0) {
    warning = 'No columns were recorded with this recipe. Preview carefully.';
  } else if (missing.length) {
    warning = 'Columns changed - preview carefully. Missing: ' + missing.slice(0, 6).join(', ') +
      (missing.length > 6 ? ' and ' + (missing.length - 6) + ' more' : '') + '.';
  }

  return {
    score: score,
    matched: matched,
    missing: missing,
    extra: extra,
    canApply: canApply,
    warning: warning,
  };
}

// ---- apply helpers ----------------------------------------------------------

// Return the payload in the shape the relevant engine expects. Pure: the caller
// (canvas UI) hands the payload to DataGlowExcelHellRepair.preview/apply or to
// DataGlowGuidedUnpivot. We do not import those engines here.
export function getApplyPayload(record) {
  var v = validateRecord(record);
  if (!v.ok) return { ok: false, error: v.errors.join(' ') };
  return { ok: true, kind: record.kind, payload: record.payload };
}

// ---- list helpers -----------------------------------------------------------

export function sortRecipes(records, by) {
  var list = Array.isArray(records) ? records.slice() : [];
  var key = by || 'updatedAt';
  list.sort(function (a, b) {
    if (key === 'name') {
      return String(a && a.name || '').localeCompare(String(b && b.name || ''));
    }
    // Default: most-recently-updated first.
    var av = String((a && a[key]) || '');
    var bv = String((b && b[key]) || '');
    if (av < bv) return 1;
    if (av > bv) return -1;
    return 0;
  });
  return list;
}

export function filterRecipes(records, opts) {
  opts = opts || {};
  var list = Array.isArray(records) ? records.slice() : [];
  if (opts.kind && RECIPE_KINDS.indexOf(opts.kind) !== -1) {
    list = list.filter(function (r) { return r && r.kind === opts.kind; });
  }
  if (isNonEmptyString(opts.query)) {
    var q = opts.query.trim().toLowerCase();
    list = list.filter(function (r) {
      if (!r) return false;
      var hay = [r.name, r.sourceName, r.notes]
        .concat(Array.isArray(r.columnNames) ? r.columnNames : [])
        .join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }
  return list;
}

export const DataGlowRepairRecipeLibrary = {
  version: REPAIR_RECIPE_LIBRARY_VERSION,
  RECIPE_KINDS: RECIPE_KINDS,
  createRecipeRecord: createRecipeRecord,
  validateRecord: validateRecord,
  serializeLibrary: serializeLibrary,
  parseLibrary: parseLibrary,
  scoreRecipeMatch: scoreRecipeMatch,
  getApplyPayload: getApplyPayload,
  sortRecipes: sortRecipes,
  filterRecipes: filterRecipes,
  normalizeColumnNames: normalizeColumnNames,
};

if (typeof window !== 'undefined') {
  window.DataGlowRepairRecipeLibrary = DataGlowRepairRecipeLibrary;
}
