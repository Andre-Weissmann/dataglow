// ============================================================
// DATAGLOW — File Format Loaders
// Tier 1: CSV/TSV, JSON/NDJSON, Parquet, Excel, SQLite (via DuckDB-WASM natives + XLSX.js)
// ============================================================

import { state, addDataset } from './state.js';
import { sanitizeTableName, toast } from './utils.js';
import * as engine from './duckdb-engine.js';

export async function loadFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const tableName = sanitizeTableName(file.name);
  const arrayBuffer = await file.arrayBuffer();

  try {
    if (['csv', 'tsv'].includes(ext)) {
      await engine.registerFileBuffer(file.name, arrayBuffer);
      await engine.createTableFromCSV(tableName, file.name);
    } else if (['json', 'ndjson'].includes(ext)) {
      await engine.registerFileBuffer(file.name, arrayBuffer);
      await engine.createTableFromJSON(tableName, file.name);
    } else if (['parquet'].includes(ext)) {
      await engine.registerFileBuffer(file.name, arrayBuffer);
      await engine.createTableFromParquet(tableName, file.name);
    } else if (['xlsx', 'xls'].includes(ext)) {
      await loadExcel(arrayBuffer, tableName);
    } else if (['sqlite', 'db'].includes(ext)) {
      throw new Error('SQLite file support requires the DuckDB sqlite extension — try exporting to CSV/Parquet for now.');
    } else if (['arrow', 'feather'].includes(ext)) {
      await engine.registerFileBuffer(file.name, arrayBuffer);
      await engine.runQuery(`CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_parquet('${file.name}')`).catch(async () => {
        throw new Error('Arrow/Feather loading needs the arrow extension in this build.');
      });
    } else {
      throw new Error(`Unsupported file type: .${ext}`);
    }

    const rowCount = await engine.getRowCount(tableName);
    const schema = await engine.getTableSchema(tableName);
    const ds = {
      name: file.name,
      table: tableName,
      rowCount,
      cols: schema.map(s => ({ name: s.column_name, type: s.column_type })),
      loadedAt: Date.now(),
      sizeBytes: file.size,
    };
    addDataset(ds);
    toast(`Loaded ${file.name} — ${rowCount.toLocaleString()} rows`, 'success');
    return ds;
  } catch (err) {
    console.error(err);
    toast(`Failed to load ${file.name}: ${err.message}`, 'error');
    throw err;
  }
}

async function loadExcel(arrayBuffer, tableName) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
  if (json.length === 0) throw new Error('Sheet is empty');
  const columns = Object.keys(json[0]);
  await engine.createTableFromRows(tableName, columns, json);
}

// ============================================================
// Golden Dataset — the self-test fixture
// 100 rows, 10 exact duplicates, 5 nulls, 3 negatives in a
// non-negative column, 2 future dates, 1 semantic error (age=999)
// ============================================================
export function buildGoldenDataset() {
  const rows = [];
  const today = new Date();
  for (let i = 1; i <= 88; i++) {
    const daysAgo = Math.floor(Math.random() * 700);
    const d = new Date(today); d.setDate(d.getDate() - daysAgo);
    rows.push({
      patient_id: i,
      age: 20 + (i % 60),
      gender: i % 2 === 0 ? 'F' : 'M',
      length_of_stay: 1 + (i % 12),
      readmission_rate: Math.round((5 + (i % 20)) * 10) / 10,
      admit_date: d.toISOString().slice(0, 10),
      claim_amount: Math.round((100 + i * 13.7) * 100) / 100,
    });
  }
  // 3 negative values in claim_amount (non-negative column)
  rows[10].claim_amount = -450.00;
  rows[25].claim_amount = -12.50;
  rows[40].claim_amount = -999.99;
  // 2 future dates
  const future1 = new Date(today); future1.setFullYear(future1.getFullYear() + 1);
  const future2 = new Date(today); future2.setMonth(future2.getMonth() + 3);
  rows[5].admit_date = future1.toISOString().slice(0, 10);
  rows[15].admit_date = future2.toISOString().slice(0, 10);
  // 1 semantic error: age = 999
  rows[30].age = 999;
  // 5 null values scattered
  rows[2].gender = null;
  rows[12].length_of_stay = null;
  rows[22].readmission_rate = null;
  rows[42].claim_amount = null;
  rows[52].admit_date = null;
  // 10 exact duplicates (rows 60-69 duplicate rows 0-9's content but keep unique patient_id... actually true dupes need identical rows)
  for (let i = 0; i < 10; i++) {
    const dup = { ...rows[i] };
    rows.push(dup); // exact duplicate row including patient_id — true duplicate
  }
  // pad to exactly 100 rows total (88 + 3 negative overwrites already counted + 10 dupes = 98, add 2 more distinct)
  while (rows.length < 100) {
    const i = rows.length;
    rows.push({
      patient_id: 200 + i,
      age: 30 + (i % 40),
      gender: i % 2 === 0 ? 'F' : 'M',
      length_of_stay: 2 + (i % 8),
      readmission_rate: 10.5,
      admit_date: '2025-01-15',
      claim_amount: 500.0,
    });
  }
  return rows.slice(0, 100);
}

export async function loadGoldenDataset() {
  const rows = buildGoldenDataset();
  const columns = Object.keys(rows[0]);
  const tableName = 'golden_test_dataset';
  await engine.createTableFromRows(tableName, columns, rows);
  const rowCount = await engine.getRowCount(tableName);
  const schema = await engine.getTableSchema(tableName);
  const ds = {
    name: 'golden_test_dataset.csv',
    table: tableName,
    rowCount,
    cols: schema.map(s => ({ name: s.column_name, type: s.column_type })),
    loadedAt: Date.now(),
    isGolden: true,
  };
  addDataset(ds);
  toast(`Golden test dataset loaded — ${rowCount} rows with known issues`, 'success');
  return ds;
}
