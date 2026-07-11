// ============================================================
// DATAGLOW — DuckDB-WASM Engine
// Runs entirely in-browser. Zero server, zero uploads.
// ============================================================

import { state } from './state.js';
import { toast } from './utils.js';

// Self-hosted DuckDB-WASM assets (vendored under assets/duckdb/). Resolved
// relative to this module so it works no matter what path the app is served
// from. Previously these came from the jsdelivr CDN; self-hosting removes the
// runtime network dependency (see assets/duckdb/DUCKDB-WASM-LICENSE, MIT).
// The bundle's bare `apache-arrow` import is satisfied by the import map in
// index.html, which also points at vendored, self-hosted copies.
const asset = (f) => new URL('../../assets/duckdb/' + f, import.meta.url).href;

let initPromise = null;

export function initDuckDB() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const duckdb = await import(asset('duckdb-browser.mjs'));
    if (!duckdb) throw new Error('DuckDB-WASM failed to load from vendored assets.');

    const bundles = {
      mvp: {
        mainModule: asset('duckdb-mvp.wasm'),
        mainWorker: asset('duckdb-browser-mvp.worker.js'),
      },
      eh: {
        mainModule: asset('duckdb-eh.wasm'),
        mainWorker: asset('duckdb-browser-eh.worker.js'),
      },
    };

    const bundle = await duckdb.selectBundle(bundles);
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    const conn = await db.connect();
    state.duckdb.db = db;
    state.duckdb.conn = conn;
    state.duckdb.ready = true;
    return { db, conn };
  })().catch(err => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

function isArrowDateField(field) {
  // Arrow DATE/TIMESTAMP typeIds: 8 = Date, 10 = Timestamp (see apache-arrow TypeId enum)
  const typeId = field?.type?.typeId;
  return typeId === 8 || typeId === 10;
}

export async function runQuery(sql) {
  if (!state.duckdb.ready) await initDuckDB();
  const conn = state.duckdb.conn;
  const t0 = performance.now();
  const result = await conn.query(sql);
  const elapsedMs = performance.now() - t0;
  const columns = result.schema.fields.map(f => f.name);
  const dateCols = new Set(result.schema.fields.filter(isArrowDateField).map(f => f.name));
  const rows = result.toArray().map(row => {
    const obj = {};
    for (const c of columns) {
      let v = row[c];
      if (typeof v === 'bigint') v = Number(v);
      if (dateCols.has(c) && typeof v === 'number') {
        v = new Date(v).toISOString().slice(0, 10);
      }
      obj[c] = v;
    }
    return obj;
  });
  return { columns, rows, elapsedMs, rowCount: rows.length, dateColumns: [...dateCols] };
}

// Build the Uint8Array handed to DuckDB-WASM from an INDEPENDENT copy of the
// caller's bytes. db.registerFileBuffer() transfers the array's underlying
// buffer to the DuckDB worker, which DETACHES it — so if we passed a view over
// the caller's ArrayBuffer, that original buffer would be silently invalidated
// the moment we register it. The file-load path also hashes those same raw
// bytes for the provenance chain of custody; a detached buffer there means the
// audit trail silently records nothing. Copying decouples the two: the engine
// gets its own transferable buffer and the caller's bytes stay valid for
// hashing (and any retry/re-read) no matter the call order.
export function duckdbBytes(source) {
  const view = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
  return view.slice(); // fresh Uint8Array backed by its own buffer
}

export async function registerFileBuffer(fileName, arrayBuffer) {
  const db = state.duckdb.db;
  await db.registerFileBuffer(fileName, duckdbBytes(arrayBuffer));
}

export async function listTables() {
  const { rows } = await runQuery(`SELECT table_name FROM information_schema.tables WHERE table_schema='main'`);
  return rows.map(r => r.table_name);
}

export async function getTableSchema(tableName) {
  const { rows } = await runQuery(`DESCRIBE ${tableName}`);
  return rows; // [{column_name, column_type, null, key, default, extra}]
}

export async function getRowCount(tableName) {
  const { rows } = await runQuery(`SELECT COUNT(*) AS n FROM ${tableName}`);
  return rows[0].n;
}

// SQL builders for the CSV ingest path, kept as pure string builders so both
// the browser engine (below) and the Node test engine drive byte-identical SQL.
// We still IGNORE_ERRORS so a few malformed rows don't abort the whole load, but
// STORE_REJECTS captures every skipped row in a rejects table so the count can
// be surfaced instead of silently swallowed.
export function buildCsvLoadSQL(tableName, fileName, rejectsTable, rejectsScan) {
  return `CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_csv_auto('${fileName}', `
    + `SAMPLE_SIZE=-1, ALL_VARCHAR=FALSE, ignore_errors=true, store_rejects=true, `
    + `rejects_table='${rejectsTable}', rejects_scan='${rejectsScan}')`;
}
export function buildCsvRejectCountSQL(rejectsTable) {
  // One rejected input line can raise several column errors; count distinct
  // source lines so the number matches "rows the user would have expected".
  return `SELECT COUNT(DISTINCT line) AS dropped FROM ${rejectsTable}`;
}

export async function createTableFromCSV(tableName, fileName) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const rejectsTable = `_dg_csv_rejects_${suffix}`;
  const rejectsScan = `_dg_csv_scans_${suffix}`;
  await runQuery(buildCsvLoadSQL(tableName, fileName, rejectsTable, rejectsScan));
  let droppedRows = 0;
  try {
    const { rows } = await runQuery(buildCsvRejectCountSQL(rejectsTable));
    droppedRows = Number(rows[0]?.dropped ?? 0);
  } catch { /* no rejects table means nothing was skipped */ }
  await runQuery(`DROP TABLE IF EXISTS ${rejectsTable}`).catch(() => {});
  await runQuery(`DROP TABLE IF EXISTS ${rejectsScan}`).catch(() => {});
  return { droppedRows };
}

export async function createTableFromJSON(tableName, fileName) {
  await runQuery(`CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_json_auto('${fileName}')`);
}

export async function createTableFromParquet(tableName, fileName) {
  await runQuery(`CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_parquet('${fileName}')`);
}

export async function createTableFromRows(tableName, columns, rows) {
  // Fallback path: build table from JS objects (used for Excel/SQLite parsed data & golden dataset)
  const conn = state.duckdb.conn;
  const colDefs = columns.map(c => `"${c}" VARCHAR`).join(', ');
  await runQuery(`DROP TABLE IF EXISTS ${tableName}`);
  await runQuery(`CREATE TABLE ${tableName} (${colDefs})`);
  if (rows.length === 0) return;
  const placeholders = columns.map(() => '?').join(',');
  const stmt = await conn.prepare(`INSERT INTO ${tableName} VALUES (${placeholders})`);
  for (const row of rows) {
    await stmt.query(...columns.map(c => (row[c] == null ? null : String(row[c]))));
  }
  await stmt.close();
  // Try to coerce columns to proper types for downstream analysis.
  // Only coerce when ALL non-null values in the column successfully cast —
  // otherwise leave as VARCHAR (prevents silently nulling out text/date columns).
  for (const c of columns) {
    const safeCol = `"${c}"`;
    try {
      const { rows: checkRows } = await runQuery(
        `SELECT COUNT(*) FILTER (WHERE ${safeCol} IS NOT NULL) AS total,
                COUNT(*) FILTER (WHERE ${safeCol} IS NOT NULL AND TRY_CAST(${safeCol} AS DOUBLE) IS NULL) AS bad_double,
                COUNT(*) FILTER (WHERE ${safeCol} IS NOT NULL AND TRY_CAST(${safeCol} AS DATE) IS NULL) AS bad_date
         FROM ${tableName}`
      );
      const { total, bad_double, bad_date } = checkRows[0];
      if (total > 0 && bad_double === 0) {
        await runQuery(`ALTER TABLE ${tableName} ALTER COLUMN ${safeCol} SET DATA TYPE DOUBLE USING TRY_CAST(${safeCol} AS DOUBLE)`);
      } else if (total > 0 && bad_date === 0) {
        await runQuery(`ALTER TABLE ${tableName} ALTER COLUMN ${safeCol} SET DATA TYPE DATE USING TRY_CAST(${safeCol} AS DATE)`);
      }
      // else: leave as VARCHAR (text column)
    } catch (e) { /* leave as varchar */ }
  }
}
