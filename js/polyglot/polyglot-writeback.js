// ============================================================
// DATAGLOW — Polyglot Write-back (Roadmap Step 8, polyglotWriteback flag)
// ============================================================
// Python and R can already READ DuckDB tables (dataglow.get_df / dataglow_get_df).
// This module is the missing return trip: a pandas DataFrame or R data.frame a
// user's script produced is saved BACK as a real, queryable DuckDB table, so SQL,
// Glow Canvas, Visualize, Validate and Export all see it like any loaded dataset.
//
//   Python:  dataglow.save_df('cohort', df)
//   R:       dataglow_save_df('cohort', df)
//
// DESIGN
//   * Pure + dependency-injected. This file imports NOTHING (no DOM, no DuckDB
//     engine, no Pyodide/WebR, no network). The runtimes hand it `deps`, and the
//     tests hand it a real native DuckDB — so the exact production code is
//     exercised under Node.
//   * Never silently lossy. Too many rows is a loud error (never a truncation);
//     NaN/Infinity become honest NULLs; a bad table or column name is rejected.
//   * Never string-concatenates untrusted SQL. Table names must match a strict
//     identifier regex and avoid SQL keywords/reserved prefixes; column names are
//     double-quote escaped; values are typed literals (numbers via Number(),
//     strings single-quote escaped, NUL bytes stripped).
//   * Atomic replace. Rows are staged into a scratch table and only swapped over
//     the target with CREATE OR REPLACE once every INSERT has succeeded, so a
//     failure part-way can never leave the user's existing table half-written.
//
// Ships DARK behind the `polyglotWriteback` flag; the runtimes decide whether to
// call any of this. Nothing here reads the flag.

// Matches the Python/R bridge row caps' order of magnitude, but deliberately a
// round, documented number of its own: write-back is a ONE-WAY JSON hop into
// DuckDB and is bounded to keep the browser tab responsive.
export const WRITEBACK_ROW_LIMIT = 500_000;

// Rows per multi-row INSERT. Small enough to keep any single statement modest.
export const WRITEBACK_INSERT_BATCH = 500;

export const WRITEBACK_LANGUAGES = ['python', 'r'];

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const RESERVED_PREFIXES = ['sqlite_', 'duckdb_', 'pg_', '__'];

// DuckDB reserved / SQL keywords that cannot be used as an UNQUOTED table name
// (the rest of the app interpolates `ds.table` unquoted, so they must be refused).
const SQL_KEYWORDS = new Set([
  'all', 'alter', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'attach', 'between',
  'both', 'by', 'case', 'cast', 'check', 'collate', 'column', 'constraint', 'create', 'cross',
  'current_date', 'current_time', 'current_timestamp', 'default', 'delete', 'desc', 'describe',
  'detach', 'distinct', 'do', 'drop', 'else', 'end', 'except', 'exists', 'false', 'fetch', 'for',
  'foreign', 'from', 'full', 'group', 'having', 'in', 'index', 'inner', 'insert', 'intersect',
  'into', 'is', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'natural', 'not', 'null',
  'offset', 'on', 'only', 'or', 'order', 'outer', 'pivot', 'primary', 'references', 'returning',
  'right', 'select', 'set', 'show', 'some', 'summarize', 'table', 'then', 'to', 'trailing', 'true',
  'union', 'unique', 'unpivot', 'update', 'using', 'values', 'view', 'when', 'where', 'window',
  'with',
]);

// ------------------------------------------------------------
// Names
// ------------------------------------------------------------

/**
 * Validate (never silently rewrite) a table name a script asked to save.
 * @param {unknown} rawName
 * @returns {string} the trimmed, validated name
 * @throws {Error} with a user-facing message when the name is unsafe
 */
export function validateWritebackTableName(rawName) {
  if (typeof rawName !== 'string') {
    throw new Error('Table name must be a string, e.g. dataglow.save_df("my_table", df).');
  }
  const name = rawName.trim();
  if (!name) throw new Error('Table name must not be empty.');
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid table name "${name.slice(0, 80)}". Use letters, digits and underscores only, `
      + 'starting with a letter or underscore, at most 63 characters (no spaces, quotes or punctuation).'
    );
  }
  const lower = name.toLowerCase();
  for (const p of RESERVED_PREFIXES) {
    if (lower.startsWith(p)) {
      throw new Error(`Table name "${name}" uses the reserved prefix "${p}". Pick another name.`);
    }
  }
  if (SQL_KEYWORDS.has(lower)) {
    throw new Error(`Table name "${name}" is a SQL keyword. Pick another name (e.g. "${name}_df").`);
  }
  return name;
}

/** Double-quote a column/table identifier, doubling embedded quotes. */
export function quoteIdent(ident) {
  return '"' + String(ident).replace(/"/g, '""').replace(/\u0000/g, '') + '"';
}

// ------------------------------------------------------------
// Value + shape normalization
// ------------------------------------------------------------

/**
 * Honestly sanitize one cell. Returns null | number | string | boolean.
 * NaN/±Infinity/undefined -> null; BigInt -> safe number else string;
 * Date -> ISO string (invalid Date -> null); objects/arrays -> JSON string.
 */
export function sanitizeWritebackValue(v) {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'number': return Number.isFinite(v) ? v : null;
    case 'bigint': {
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : v.toString();
    }
    case 'boolean': return v;
    case 'string': return v;
    case 'function':
    case 'symbol': return null;
    default: break;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  try {
    const json = JSON.stringify(v, (_k, x) => {
      if (typeof x === 'bigint') return x.toString();
      if (typeof x === 'number' && !Number.isFinite(x)) return null;
      return x;
    });
    return json === undefined ? null : json;
  } catch (_e) {
    return String(v);
  }
}

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function checkColumnNames(columns) {
  if (!columns.length) {
    throw new Error('Cannot save a table with 0 columns.');
  }
  const seen = new Set();
  for (const c of columns) {
    if (typeof c !== 'string' || c === '') {
      throw new Error('Every column needs a non-empty name.');
    }
    if (c === '__proto__') throw new Error('Column name "__proto__" is not allowed.');
    const key = c.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate column name "${c}" (column names are case-insensitive in DuckDB).`);
    }
    seen.add(key);
  }
}

function overLimit(n, maxRows) {
  return new Error(
    `Too many rows to save: ${n.toLocaleString('en-US')} exceeds the write-back limit of `
    + `${maxRows.toLocaleString('en-US')} rows. Aggregate or filter the data first `
    + '(rows are never silently dropped).'
  );
}

/**
 * Normalize any supported payload into { columns: string[], rows: object[] }.
 *
 * Accepted shapes:
 *   - array of row objects:               [{ a: 1, b: 'x' }, ...]
 *   - columnar object:                    { columns: { a: [1, 2], b: ['x', 'y'] } }
 *     (optionally with `names: ['a','b']` to pin column order, as the R bridge sends)
 *   - names + rows:                       { columns: ['a','b'], rows: [...] }  (empty-table safe)
 *
 * @param {unknown} input
 * @param {{maxRows?: number, columns?: string[]}} [opts] `columns` is an order/empty-table hint
 * @returns {{columns: string[], rows: Array<Record<string, any>>}}
 */
export function normalizeWritebackRows(input, opts = {}) {
  const maxRows = Number.isFinite(opts.maxRows) ? opts.maxRows : WRITEBACK_ROW_LIMIT;
  const hint = Array.isArray(opts.columns) ? opts.columns.map(String) : null;
  let columns;
  let rawRows;

  if (Array.isArray(input)) {
    rawRows = input;
    if (rawRows.length > maxRows) throw overLimit(rawRows.length, maxRows);
    const order = [];
    const seen = new Set();
    for (const r of rawRows) {
      if (!isPlainObject(r)) throw new Error('Row-oriented input must be an array of row objects.');
      for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); order.push(k); }
    }
    columns = order.length ? order : (hint || []);
    if (hint && order.length) {
      // Honor an explicit order hint, keeping any extra keys at the end.
      const inHint = hint.filter(h => seen.has(h));
      columns = [...inHint, ...order.filter(k => !inHint.includes(k))];
    }
  } else if (isPlainObject(input) && isPlainObject(input.columns)) {
    const names = Array.isArray(input.names) ? input.names.map(String) : Object.keys(input.columns);
    const missing = names.filter(n => !Object.prototype.hasOwnProperty.call(input.columns, n));
    if (missing.length) throw new Error(`Columnar input is missing data for column "${missing[0]}".`);
    columns = names;
    // A scalar column is a 1-row column (R/jsonlite collapse length-1 vectors).
    const cols = {};
    let n = 0;
    for (const name of columns) {
      const col = input.columns[name];
      cols[name] = Array.isArray(col) ? col : [col];
      n = Math.max(n, cols[name].length);
    }
    for (const name of columns) {
      if (cols[name].length !== n) {
        throw new Error(`Column "${name}" has ${cols[name].length} values but other columns have ${n}.`);
      }
    }
    if (n > maxRows) throw overLimit(n, maxRows);
    rawRows = new Array(n);
    for (let i = 0; i < n; i++) {
      const row = {};
      for (const name of columns) row[name] = cols[name][i];
      rawRows[i] = row;
    }
  } else if (isPlainObject(input) && Array.isArray(input.columns) && Array.isArray(input.rows)) {
    columns = input.columns.map(String);
    rawRows = input.rows;
    if (rawRows.length > maxRows) throw overLimit(rawRows.length, maxRows);
    for (const r of rawRows) {
      if (!isPlainObject(r)) throw new Error('Row-oriented input must be an array of row objects.');
    }
  } else {
    throw new Error('Unsupported table payload: expected an array of row objects or { columns: { name: [values] } }.');
  }

  checkColumnNames(columns);
  const rows = rawRows.map(r => {
    const out = {};
    for (const c of columns) out[c] = sanitizeWritebackValue(r[c]);
    return out;
  });
  return { columns, rows };
}

// ------------------------------------------------------------
// Typing + SQL building
// ------------------------------------------------------------

/**
 * Infer a DuckDB column type from sanitized values.
 * all-boolean -> BOOLEAN; all safe integers -> BIGINT; all numbers -> DOUBLE;
 * anything else (incl. mixed) -> VARCHAR. All-null columns are VARCHAR.
 */
export function inferColumnType(values) {
  let sawBool = false, sawInt = false, sawFloat = false, sawOther = false;
  for (const v of values) {
    if (v === null) continue;
    if (typeof v === 'boolean') sawBool = true;
    else if (typeof v === 'number') { if (Number.isInteger(v) && Number.isSafeInteger(v)) sawInt = true; else sawFloat = true; }
    else sawOther = true;
  }
  if (sawOther) return 'VARCHAR';
  if (sawBool && (sawInt || sawFloat)) return 'VARCHAR';
  if (sawBool) return 'BOOLEAN';
  if (sawFloat) return 'DOUBLE';
  if (sawInt) return 'BIGINT';
  return 'VARCHAR';
}

/** Render one sanitized value as a SQL literal of the given column type. */
export function sqlLiteral(v, type) {
  if (v === null || v === undefined) return 'NULL';
  if (type === 'VARCHAR') {
    const s = typeof v === 'string' ? v : String(v);
    return "'" + s.replace(/\u0000/g, '').replace(/'/g, "''") + "'";
  }
  if (type === 'BOOLEAN') return v ? 'TRUE' : 'FALSE';
  // BIGINT / DOUBLE — only finite numbers reach here (sanitized + typed above).
  const n = Number(v);
  if (!Number.isFinite(n)) return 'NULL';
  return String(n);
}

/**
 * Build the typed column plan + statements for a staged, atomic table write.
 * Pure; exported so tests can inspect the SQL.
 */
export function buildWritebackPlan(tableName, columns, rows, { batchSize = WRITEBACK_INSERT_BATCH } = {}) {
  const name = validateWritebackTableName(tableName);
  checkColumnNames(columns);
  const types = columns.map(c => inferColumnType(rows.map(r => r[c])));
  const stage = `__dataglow_wb_stage_${name}`;
  const colDefs = columns.map((c, i) => `${quoteIdent(c)} ${types[i]}`).join(', ');
  const collist = columns.map(quoteIdent).join(', ');
  const inserts = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const tuples = slice
      .map(r => '(' + columns.map((c, j) => sqlLiteral(r[c], types[j])).join(', ') + ')')
      .join(', ');
    inserts.push(`INSERT INTO ${quoteIdent(stage)} (${collist}) VALUES ${tuples}`);
  }
  return {
    name,
    stage,
    columns,
    types,
    createStage: `CREATE OR REPLACE TABLE ${quoteIdent(stage)} (${colDefs})`,
    inserts,
    swap: `CREATE OR REPLACE TABLE ${quoteIdent(name)} AS SELECT * FROM ${quoteIdent(stage)}`,
    dropStage: `DROP TABLE IF EXISTS ${quoteIdent(stage)}`,
  };
}

/**
 * Default createTable implementation over any `runQuery(sql)` function (the
 * browser engine's and the Node test engine's share this shape).
 * @returns {(name: string, columns: string[], rows: object[]) => Promise<void>}
 */
export function makeSqlTableCreator(runQuery) {
  if (typeof runQuery !== 'function') throw new Error('makeSqlTableCreator requires a runQuery function.');
  return async function createTable(name, columns, rows) {
    const plan = buildWritebackPlan(name, columns, rows);
    try {
      await runQuery(plan.createStage);
      for (const sql of plan.inserts) await runQuery(sql);
      await runQuery(plan.swap);
    } finally {
      try { await runQuery(plan.dropStage); } catch (_e) { /* best effort cleanup */ }
    }
  };
}

// ------------------------------------------------------------
// Materializer
// ------------------------------------------------------------

function sourceLabel(language) {
  return language === 'python' ? 'Python runtime (dataglow.save_df)' : 'R runtime (dataglow_save_df)';
}

/** One-line user-facing confirmation for a saved table. */
export function formatSavedLine(saved) {
  const rc = Number(saved.rowCount).toLocaleString('en-US');
  return `Saved table "${saved.name}" (${rc} rows \u00d7 ${saved.columns.length} cols) to DuckDB \u2014 ready in SQL, Glow Canvas & Export`;
}

/**
 * Create/replace each pending table in DuckDB and register it everywhere.
 *
 * @param {Array<{name: string, rows: any, language: 'python'|'r', columns?: string[]}>} pendingSaves
 *   `rows` may be anything normalizeWritebackRows accepts.
 * @param {object} deps
 * @param {(name:string, columns:string[], rows:object[])=>Promise<void>} deps.createTable
 * @param {(table:string)=>Promise<Array<{column_name:string, column_type:string}>>} deps.getTableSchema
 * @param {(table:string)=>Promise<number>} [deps.getRowCount] defaults to schema-independent rows.length
 * @param {object[]} deps.datasets  live array (state.datasets); mutated in place
 * @param {(descriptor:object)=>any} [deps.registerObject] Object Space registry
 * @param {(info:object)=>Promise<any>|any} [deps.recordProvenance]
 * @param {(saved:object)=>any} [deps.onTableSaved]
 * @param {number} [deps.maxRows]
 * @returns {Promise<{saved: object[], failed: Array<{name:string, language:string, error:string}>}>}
 */
export async function materializeWritebackTables(pendingSaves, deps = {}) {
  const { createTable, getTableSchema, datasets, registerObject, recordProvenance, onTableSaved } = deps;
  if (typeof createTable !== 'function') throw new Error('materializeWritebackTables: deps.createTable is required.');
  if (typeof getTableSchema !== 'function') throw new Error('materializeWritebackTables: deps.getTableSchema is required.');
  if (!Array.isArray(datasets)) throw new Error('materializeWritebackTables: deps.datasets must be an array.');

  // Last write wins when a script saves the same table twice in one run.
  const byName = new Map();
  for (const p of pendingSaves || []) {
    const key = typeof p?.name === 'string' ? p.name.trim().toLowerCase() : `\u0000${byName.size}`;
    byName.delete(key);
    byName.set(key, p);
  }

  const saved = [];
  const failed = [];
  for (const p of byName.values()) {
    const language = p?.language;
    try {
      if (!WRITEBACK_LANGUAGES.includes(language)) throw new Error(`Unknown write-back language "${language}".`);
      const name = validateWritebackTableName(p.name);
      const { columns, rows } = normalizeWritebackRows(p.rows, { maxRows: deps.maxRows, columns: p.columns });
      await createTable(name, columns, rows);
      const schema = await getTableSchema(name);
      const cols = schema.map(s => ({ name: s.column_name, type: s.column_type }));
      const rowCount = typeof deps.getRowCount === 'function' ? Number(await deps.getRowCount(name)) : rows.length;
      const savedAt = new Date().toISOString();

      const idx = datasets.findIndex(d => String(d?.table || '').toLowerCase() === name.toLowerCase()
        || d?.name === name);
      const replaced = idx >= 0;
      const prev = replaced ? datasets[idx] : null;
      const ds = {
        name: replaced && prev.name ? prev.name : name,
        table: name,
        rowCount,
        cols,
        loadedAt: Date.now(),
        meta: {
          source: sourceLabel(language),
          format: language,
          originLanguage: language,
          savedAt,
        },
      };
      if (replaced) datasets[idx] = ds; else datasets.push(ds);

      const info = { name, table: name, language, rowCount, columns, cols, replaced, savedAt, dataset: ds };
      if (typeof registerObject === 'function') {
        try {
          // Same origin-qualified handle the runtimes' bridges use (py:<t> / r:<t>),
          // so `FROM py.<name>` (Query Sentinel Bridge) resolves to this table.
          registerObject({
            name: `${language === 'python' ? 'py' : 'r'}:${name}`,
            originLanguage: language,
            kind: 'dataframe',
            schema: cols,
            rowCount,
            provenance: name,
          });
        } catch (_e) { /* the registry is informational; never fail a save on it */ }
      }
      if (typeof recordProvenance === 'function') {
        try { await recordProvenance(info); } catch (_e) { /* ditto */ }
      }
      info.message = formatSavedLine(info);
      saved.push(info);
      if (typeof onTableSaved === 'function') {
        try { await onTableSaved(info); } catch (_e) { /* UI refresh must not undo a save */ }
      }
    } catch (err) {
      failed.push({
        name: typeof p?.name === 'string' ? p.name : String(p?.name),
        language: String(language),
        error: err && err.message ? err.message : String(err),
      });
    }
  }
  return { saved, failed };
}

/**
 * Build the standard `deps` bundle the Python and R runtimes use, from the
 * modules they already import. Keeping this here (with the modules INJECTED)
 * means the runtimes share one wiring and this file still imports nothing.
 *
 * @param {{engine: object, state: object, registerObject?: Function,
 *          provenance?: {getProvenance: Function, startProvenance: Function},
 *          onTableSaved?: Function}} mods
 */
export function buildRuntimeWritebackDeps({ engine, state, registerObject, provenance, onTableSaved } = {}) {
  if (!engine || typeof engine.runQuery !== 'function') throw new Error('buildRuntimeWritebackDeps: engine.runQuery is required.');
  if (!state) throw new Error('buildRuntimeWritebackDeps: state is required.');
  if (!Array.isArray(state.datasets)) state.datasets = [];
  return {
    createTable: makeSqlTableCreator(engine.runQuery),
    getTableSchema: engine.getTableSchema,
    getRowCount: engine.getRowCount,
    datasets: state.datasets,
    registerObject,
    onTableSaved,
    recordProvenance: provenance
      ? async (info) => {
        const detail = { source: info.dataset.meta.source, rows: info.rowCount, columns: info.columns.length, originLanguage: info.language };
        const desc = `${info.replaced ? 'Replaced' : 'Saved'} "${info.name}" (${info.rowCount.toLocaleString('en-US')} rows) from ${info.dataset.meta.source}`;
        let chain = provenance.getProvenance(info.table);
        if (!chain) chain = provenance.startProvenance(info.table);
        await chain.append(info.replaced ? 'writeback' : 'load', desc, detail);
      }
      : undefined,
  };
}
