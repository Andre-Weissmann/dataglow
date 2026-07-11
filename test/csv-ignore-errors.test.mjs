// ============================================================
// DATAGLOW — CSV parse-error drop-count tests (Bug 2)
// ============================================================
// The CSV ingest path uses read_csv_auto(..., IGNORE_ERRORS=TRUE) so a handful
// of malformed rows don't abort the whole load. That used to drop those rows
// SILENTLY. These tests drive the production SQL builders from duckdb-engine.js
// against a real (native) DuckDB and prove the number of skipped rows is now
// captured and reported.
//
// RUN WITH:  node test/csv-ignore-errors.test.mjs
// (No loader hook: we import the real duckdb-engine.js SQL builders and run
//  them against @duckdb/node-api directly, reading a real temp CSV file.)

import { DuckDBInstance } from '@duckdb/node-api';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCsvLoadSQL, buildCsvRejectCountSQL } from '../js/app-shell/duckdb-engine.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}

// 10 data rows; 3 are deliberately malformed for a 3-column schema:
//   - line "4,50,Dan,extra"    → TOO MANY COLUMNS
//   - line "7,80"              → missing a column
//   - line "9,notanumber,Ivan" is fine as text, so NOT malformed here; instead
//     add another too-many-columns row to guarantee a deterministic 3 drops.
const csv = [
  'id,age,name',
  '1,30,Alice',
  '2,31,Bob',
  '3,32,Carol',
  '4,50,Dan,extracol',      // bad: too many columns
  '5,34,Eve',
  '6,35,Frank',
  '7,80',                   // bad: too few columns
  '8,37,Heidi',
  '9,38,Ivan,oops,again',   // bad: too many columns
  '10,39,Judy',
  '',
].join('\n');

const csvPath = join(tmpdir(), `dataglow-badcsv-${Date.now()}.csv`);
writeFileSync(csvPath, csv);

const inst = await DuckDBInstance.create(':memory:');
const conn = await inst.connect();
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

try {
  // ---- Baseline: the OLD silent behavior really does drop rows with no signal.
  const baseline = await conn.runAndReadAll(
    `SELECT COUNT(*) AS n FROM read_csv_auto('${csvPath}', SAMPLE_SIZE=-1, ALL_VARCHAR=FALSE, IGNORE_ERRORS=TRUE)`
  );
  const baselineKept = num(baseline.getRowObjects()[0].n);
  ok('baseline IGNORE_ERRORS load silently keeps fewer than 10 rows', baselineKept < 10,
     `kept ${baselineKept} (bug: no count of the 3 dropped rows is exposed)`);

  // ---- Fixed path: the production builders capture the drop count.
  const rejectsTable = '_dg_csv_rejects_test';
  const rejectsScan = '_dg_csv_scans_test';
  await conn.run(buildCsvLoadSQL('t', csvPath, rejectsTable, rejectsScan));

  const kept = num((await conn.runAndReadAll(`SELECT COUNT(*) AS n FROM t`)).getRowObjects()[0].n);
  const dropped = num((await conn.runAndReadAll(buildCsvRejectCountSQL(rejectsTable))).getRowObjects()[0].dropped);

  ok('drop count is captured (not zero)', dropped > 0, `dropped=${dropped}`);
  ok('exactly 3 malformed rows are reported as skipped', dropped === 3, `dropped=${dropped}`);
  ok('kept + dropped accounts for all 10 data rows', kept + dropped === 10,
     `kept=${kept}, dropped=${dropped}`);
} catch (e) {
  ok('CSV reject-count path executes without throwing', false, e.stack || e.message);
} finally {
  conn.closeSync?.();
  inst.closeSync?.();
  rmSync(csvPath, { force: true });
}

console.log(`\n${failed === 0 ? '✓ PASSED' : '✗ FAILED'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
