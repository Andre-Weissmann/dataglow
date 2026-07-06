// ============================================================
// DATAGLOW — Node-side DuckDB test engine
// ============================================================
// Mirrors the public interface of js/duckdb-engine.js (runQuery,
// getTableSchema, getRowCount, createTableFromRows) but is backed by
// @duckdb/node-api — the native DuckDB engine, no Worker/WASM layer.
//
// Why this exists: js/duckdb-engine.js can only run inside a real browser
// (it creates a Worker and fetches a WASM binary from a CDN). That makes it
// unusable for fast, headless logic testing. Every DATAGLOW feature module
// that generates SQL (imputation.js, format-fingerprint.js, the outlier and
// Benford queries in validation.js, etc.) calls the SAME `runQuery(sql)`
// shape, so this file lets us test that generated SQL against a real
// DuckDB instance in ~200ms instead of waiting on a browser Worker.
//
// This is a TEST-ONLY file. It is never imported by the shipped app.
import { DuckDBInstance } from '@duckdb/node-api';

let instance = null;
let connection = null;

async function ensureConnection() {
  if (connection) return connection;
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  return connection;
}

// Matches js/duckdb-engine.js's runQuery return shape:
// { columns, rows, elapsedMs, rowCount, dateColumns }
export async function runQuery(sql) {
  const conn = await ensureConnection();
  const t0 = performance.now();
  const reader = await conn.runAndReadAll(sql);
  const elapsedMs = performance.now() - t0;
  const rows = reader.getRowObjects();
  // Normalize BigInt (DuckDB BIGINT/COUNT results) to Number, same as the
  // browser engine does, so test assertions can use plain === comparisons.
  const normalized = rows.map(row => {
    const obj = {};
    for (const [k, v] of Object.entries(row)) {
      obj[k] = typeof v === 'bigint' ? Number(v) : v;
    }
    return obj;
  });
  const columns = reader.columnNames();
  return { columns, rows: normalized, elapsedMs, rowCount: normalized.length, dateColumns: [] };
}

export async function getTableSchema(tableName) {
  const { rows } = await runQuery(`DESCRIBE ${tableName}`);
  return rows;
}

export async function getRowCount(tableName) {
  const { rows } = await runQuery(`SELECT COUNT(*) AS n FROM ${tableName}`);
  return rows[0].n;
}

// Simple helper for tests: create a table directly from an array of JS
// objects, inferring types the same permissive way DuckDB's VALUES clause
// does. Not a feature of the production app — just test setup.
export async function createTableFromObjects(tableName, rows) {
  const conn = await ensureConnection();
  if (rows.length === 0) throw new Error('createTableFromObjects needs at least one row to infer columns.');
  const columns = Object.keys(rows[0]);
  await conn.run(`DROP TABLE IF EXISTS ${tableName}`);
  const colDefs = columns.map(c => `"${c}" VARCHAR`).join(', ');
  await conn.run(`CREATE TABLE ${tableName} (${colDefs})`);
  for (const row of rows) {
    const vals = columns.map(c => {
      const v = row[c];
      if (v === null || v === undefined) return 'NULL';
      return `'${String(v).replace(/'/g, "''")}'`;
    }).join(', ');
    await conn.run(`INSERT INTO ${tableName} VALUES (${vals})`);
  }
  // Coerce numeric-looking columns to DOUBLE so downstream SQL (AVG, etc.)
  // works the same way the browser engine's auto-coercion does.
  for (const c of columns) {
    const safeCol = `"${c}"`;
    const { rows: checkRows } = await runQuery(
      `SELECT COUNT(*) FILTER (WHERE ${safeCol} IS NOT NULL) AS total,
              COUNT(*) FILTER (WHERE ${safeCol} IS NOT NULL AND TRY_CAST(${safeCol} AS DOUBLE) IS NULL) AS bad_double
       FROM ${tableName}`
    );
    const { total, bad_double } = checkRows[0];
    if (total > 0 && bad_double === 0) {
      await conn.run(`ALTER TABLE ${tableName} ALTER COLUMN ${safeCol} SET DATA TYPE DOUBLE USING TRY_CAST(${safeCol} AS DOUBLE)`);
    }
  }
}

export async function closeConnection() {
  if (connection) { connection.closeSync?.(); connection = null; }
  if (instance) { instance.closeSync?.(); instance = null; }
}
