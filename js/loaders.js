// ============================================================
// DATAGLOW — File Format Loaders
// Tier 1: CSV/TSV, JSON/NDJSON, Parquet, Excel, SQLite (via DuckDB-WASM natives + XLSX.js)
// ============================================================

import { state, addDataset } from './state.js';
import { sanitizeTableName, toast } from './utils.js';
import * as engine from './duckdb-engine.js';
import { startProvenance, hashBytes } from './provenance.js';
import { buildOmopSample, buildFhirSample, flattenFhirBundle } from './health-standards.js';

function uniqueTableName(baseName) {
  const existingTables = new Set(state.datasets.map(d => d.table));
  if (!existingTables.has(baseName)) return baseName;
  let i = 2;
  while (existingTables.has(`${baseName}_${i}`)) i++;
  return `${baseName}_${i}`;
}

export async function loadFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  // Two uploads with the same filename stem but different extensions (e.g. sales.csv
  // and sales.json) would otherwise collide on the same DuckDB table name and silently
  // overwrite each other's data via CREATE OR REPLACE TABLE. Disambiguate up front.
  const tableName = uniqueTableName(sanitizeTableName(file.name));
  const arrayBuffer = await file.arrayBuffer();
  // Hash the raw bytes NOW, before handing the buffer to the DuckDB engine.
  // db.registerFileBuffer() transfers/detaches the underlying ArrayBuffer as an
  // optimization, so any later read (e.g. hashBytes) would throw on a detached
  // buffer and provenance would silently never be recorded.
  const rawHash = await hashBytes(arrayBuffer);

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
    // Anchor the Chain of Custody to the raw bytes the analyst started from
    // (hashed above, before the engine detached the buffer).
    const chain = startProvenance(tableName);
    await chain.append('load', `Loaded raw file "${file.name}" (${rowCount.toLocaleString()} rows, ${ext.toUpperCase()})`, { file: file.name, rows: rowCount, sizeBytes: file.size }, rawHash);
    toast(`Loaded ${file.name} — ${rowCount.toLocaleString()} rows`, 'success');
    return ds;
  } catch (err) {
    console.error(err);
    toast(`Failed to load ${file.name}: ${err.message}`, 'error');
    throw err;
  }
}

// Ingest an already-parsed, in-memory result set (array of row objects) as a
// local dataset, following the exact same path a file upload takes: build a
// DuckDB table, register it in app state, and anchor the Chain of Custody to the
// rows the analyst started from. Used by the Databricks Direct-Connect connector
// so a warehouse query result becomes a local table just like an imported CSV.
export async function loadRowsAsDataset({ name, columns, rows, source = 'rows', meta = {} }) {
  const tableName = uniqueTableName(sanitizeTableName(name));
  try {
    await engine.createTableFromRows(tableName, columns, rows);
    const rowCount = await engine.getRowCount(tableName);
    const schema = await engine.getTableSchema(tableName);
    const ds = {
      name,
      table: tableName,
      rowCount,
      cols: schema.map(s => ({ name: s.column_name, type: s.column_type })),
      loadedAt: Date.now(),
    };
    addDataset(ds);
    const rawHash = await hashBytes(new TextEncoder().encode(JSON.stringify(rows)));
    const chain = startProvenance(tableName);
    await chain.append('load', `Loaded "${name}" (${rowCount.toLocaleString()} rows) from ${source}`, { source, rows: rowCount, ...meta }, rawHash);
    toast(`Loaded ${name} — ${rowCount.toLocaleString()} rows`, 'success');
    return ds;
  } catch (err) {
    console.error(err);
    toast(`Failed to load ${name}: ${err.message}`, 'error');
    throw err;
  }
}

// ============================================================
// Healthcare standards sample datasets (Gen 33 — The Standards Bridge)
// ============================================================
// Load the synthetic, clearly-labelled OMOP / FHIR sample fixtures through the
// SAME in-memory ingestion path a file upload uses (loadRowsAsDataset), so the
// standard tables/resources become ordinary local tables the existing 20 layers
// and the OMOP/FHIR Domain Packs run against. All data is fabricated — never
// real PHI — and carries a couple of planted data-quality issues to demonstrate
// the packs' findings. See js/health-standards.js.

// Load the five in-scope OMOP CDM tables as separate local datasets.
export async function loadOmopSampleDataset() {
  const tables = buildOmopSample();
  const loaded = [];
  for (const [table, rows] of Object.entries(tables)) {
    if (!rows.length) continue;
    const ds = await loadRowsAsDataset({
      name: `omop_sample_${table}.csv`,
      columns: Object.keys(rows[0]),
      rows,
      source: 'omop-sample',
      meta: { standard: 'OMOP CDM', table, synthetic: true },
    });
    loaded.push(ds);
  }
  toast(`OMOP CDM sample loaded — ${loaded.length} tables (synthetic, with planted issues)`, 'success');
  return loaded;
}

// Flatten the synthetic FHIR Bundle and load each resource type as a dataset.
export async function loadFhirSampleDataset() {
  const flat = flattenFhirBundle(buildFhirSample());
  const loaded = [];
  for (const [resource, rows] of Object.entries(flat)) {
    if (!rows.length) continue;
    const ds = await loadRowsAsDataset({
      name: `fhir_sample_${resource}.csv`,
      columns: Object.keys(rows[0]),
      rows,
      source: 'fhir-sample',
      meta: { standard: 'HL7 FHIR', resource, synthetic: true },
    });
    loaded.push(ds);
  }
  toast(`FHIR sample loaded — ${loaded.length} resource tables (synthetic, with planted issues)`, 'success');
  return loaded;
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
  // Country column seeded with near-duplicate spellings + abbreviations so the
  // Categorical Consistency Engine (layer 16) has a real cluster to find:
  // "United States" (canonical, most frequent) alongside the typo
  // "United State" and the codes "USA"/"US", plus a France/FRA pair.
  const countryVariants = ['United States', 'United States', 'United States', 'United State', 'USA', 'US', 'France', 'FRA'];
  for (let i = 1; i <= 88; i++) {
    const daysAgo = Math.floor(Math.random() * 700);
    const d = new Date(today); d.setDate(d.getDate() - daysAgo);
    const los = 1 + (i % 12);
    const discharge = new Date(d); discharge.setDate(discharge.getDate() + los);
    rows.push({
      patient_id: i,
      age: 20 + (i % 60),
      gender: i % 2 === 0 ? 'F' : 'M',
      length_of_stay: los,
      readmission_rate: Math.round((5 + (i % 20)) * 10) / 10,
      admit_date: d.toISOString().slice(0, 10),
      discharge_date: discharge.toISOString().slice(0, 10),
      country: countryVariants[i % countryVariants.length],
      has_retirement_account: i % 3 === 0 ? 'true' : 'false',
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
  // Cross-column logical inconsistency (layer 17): discharge before admit.
  const backdate = (isoAdmit, daysBefore) => {
    const dd = new Date(isoAdmit); dd.setDate(dd.getDate() - daysBefore);
    return dd.toISOString().slice(0, 10);
  };
  rows[7].discharge_date = backdate(rows[7].admit_date, 5);
  rows[17].discharge_date = backdate(rows[17].admit_date, 3);
  // Cross-column impossible combo (layer 17): a minor with an adult-only status.
  rows[8].age = 15;
  rows[8].has_retirement_account = 'true';
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
  const rawHash = await hashBytes(new TextEncoder().encode(JSON.stringify(rows)));
  const chain = startProvenance(tableName);
  await chain.append('load', `Loaded built-in golden test dataset (${rowCount} rows with seeded issues)`, { rows: rowCount, source: 'golden' }, rawHash);
  toast(`Golden test dataset loaded — ${rowCount} rows with known issues`, 'success');
  return ds;
}
