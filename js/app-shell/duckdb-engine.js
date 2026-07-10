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

// If the page is cross-origin isolated, DuckDB-WASM may select a threaded bundle
// that uses SharedArrayBuffer; if not, it falls back to a single-threaded bundle
// that works fine. Isolation is therefore *not* required for the engine to run —
// but when isolation is missing AND init fails, that missing COEP header is the
// most likely culprit, so we add it as a hint to the surfaced error rather than
// pre-emptively refusing to start. (`crossOriginIsolated` is undefined in Node
// and older browsers; treat only an explicit `false` as "not isolated".)
function isNotCrossOriginIsolated() {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === false;
}

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
    if (isNotCrossOriginIsolated()) {
      err.message = `${err.message} (the page is not cross-origin isolated — ` +
        'if this is a SharedArrayBuffer/Worker failure, the server is likely ' +
        'missing the Cross-Origin-Embedder-Policy: require-corp header)';
    }
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

export async function registerFileBuffer(fileName, arrayBuffer) {
  const db = state.duckdb.db;
  await db.registerFileBuffer(fileName, new Uint8Array(arrayBuffer));
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

export async function createTableFromCSV(tableName, fileName) {
  await runQuery(`CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_csv_auto('${fileName}', SAMPLE_SIZE=-1, ALL_VARCHAR=FALSE, IGNORE_ERRORS=TRUE)`);
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
