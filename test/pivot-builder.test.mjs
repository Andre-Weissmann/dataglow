// ============================================================
// DATAGLOW — Pivot Table Builder test suite
// ============================================================
// Tests js/pivot/pivot-builder.js:
//   * classifyColumns (numeric vs. full column lists from DESCRIBE rows)
//   * validateConfig (every failure mode surfaced, not just the first)
//   * buildGroupBySQL / buildPivotSQL / buildPivotQuery — generated SQL is
//     both syntactically correct AND produces the right aggregated numbers
//     when actually run against a real in-test DuckDB table.
//   * buildCardinalityCheckSQL — the pre-flight distinct-combination guard.
//
// RUN WITH:
//   node --import ./test/duckdb-loader-hook.mjs test/pivot-builder.test.mjs

import * as engine from './node-duckdb-engine.mjs';
import {
  AGGREGATIONS,
  classifyColumns,
  createEmptyConfig,
  validateConfig,
  buildGroupBySQL,
  buildPivotSQL,
  buildPivotQuery,
  buildCardinalityCheckSQL,
  quoteIdent,
  MAX_PIVOT_CARDINALITY,
} from '../js/pivot/pivot-builder.js';

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { passed++; console.log(`✓ ${label}`); }
  else { failed++; console.error(`✗ FAILED: ${label}`); }
}

async function main() {
  // ---------- quoteIdent ----------
  check('quoteIdent: wraps a plain name in double quotes', quoteIdent('claim_id') === '"claim_id"');
  check('quoteIdent: escapes an internal double quote', quoteIdent('weird"name') === '"weird""name"');

  // ---------- classifyColumns ----------
  const describeRows = [
    { column_name: 'claim_id', column_type: 'VARCHAR' },
    { column_name: 'region', column_type: 'VARCHAR' },
    { column_name: 'amount', column_type: 'DOUBLE' },
    { column_name: 'quantity', column_type: 'INTEGER' },
    { column_name: 'is_denied', column_type: 'BOOLEAN' },
    { column_name: 'service_date', column_type: 'DATE' },
  ];
  const { allColumns, numericColumns } = classifyColumns(describeRows);
  check('classifyColumns: allColumns includes every column', allColumns.length === 6);
  check('classifyColumns: numericColumns excludes VARCHAR/BOOLEAN/DATE', numericColumns.length === 2 && numericColumns.includes('amount') && numericColumns.includes('quantity'));
  check('classifyColumns: handles empty/undefined input without throwing', classifyColumns(undefined).allColumns.length === 0);

  // ---------- validateConfig ----------
  const cols = allColumns;
  const emptyErrors = validateConfig(createEmptyConfig('claims'), cols);
  check('validateConfig: empty config reports both missing Rows and missing Values', emptyErrors.some(e => /Rows/.test(e)) && emptyErrors.some(e => /Values/.test(e)));

  const goodConfig = { sourceTable: 'claims', rows: ['region'], columns: [], values: [{ column: 'amount', agg: 'sum' }] };
  check('validateConfig: a minimal valid config reports zero errors', validateConfig(goodConfig, cols).length === 0);

  const staleConfig = { sourceTable: 'claims', rows: ['region_old'], columns: [], values: [{ column: 'amount', agg: 'sum' }] };
  check('validateConfig: flags a Rows column no longer in the schema', validateConfig(staleConfig, cols).some(e => /region_old/.test(e)));

  const badAggConfig = { sourceTable: 'claims', rows: ['region'], columns: [], values: [{ column: 'amount', agg: 'median' }] };
  check('validateConfig: flags an unrecognized aggregation id', validateConfig(badAggConfig, cols).some(e => /Unknown aggregation/.test(e)));

  check('AGGREGATIONS: exposes exactly the 5 supported aggregations', AGGREGATIONS.length === 5 && AGGREGATIONS.map(a => a.id).join(',') === 'sum,avg,count,min,max');

  // ---------- Real DuckDB execution: seed a claims table ----------
  await engine.createTableFromObjects('claims', [
    { claim_id: 'C1', region: 'North', payer: 'Aetna', amount: 100, quantity: 1 },
    { claim_id: 'C2', region: 'North', payer: 'Aetna', amount: 200, quantity: 2 },
    { claim_id: 'C3', region: 'North', payer: 'Cigna', amount: 50, quantity: 1 },
    { claim_id: 'C4', region: 'South', payer: 'Aetna', amount: 300, quantity: 3 },
    { claim_id: 'C5', region: 'South', payer: 'Cigna', amount: 150, quantity: 1 },
  ]);
  const schema = await engine.getTableSchema('claims');
  const { allColumns: claimsCols } = classifyColumns(schema);

  // ---------- buildGroupBySQL: Rows only, no Columns well ----------
  const groupByConfig = { sourceTable: 'claims', rows: ['region'], columns: [], values: [{ column: 'amount', agg: 'sum' }] };
  const groupBySql = buildGroupBySQL(groupByConfig);
  check('buildGroupBySQL: contains GROUP BY and no PIVOT keyword', /GROUP BY/.test(groupBySql) && !/PIVOT/.test(groupBySql));
  const groupByResult = await engine.runQuery(groupBySql);
  const north = groupByResult.rows.find(r => r.region === 'North');
  const south = groupByResult.rows.find(r => r.region === 'South');
  check('buildGroupBySQL executed: North sums to 350 (100+200+50)', north && Number(north.sum_amount) === 350);
  check('buildGroupBySQL executed: South sums to 450 (300+150)', south && Number(south.sum_amount) === 450);

  // ---------- buildPivotSQL: Rows + Columns (real cross-tab) ----------
  const pivotConfig = { sourceTable: 'claims', rows: ['region'], columns: ['payer'], values: [{ column: 'amount', agg: 'sum' }] };
  const pivotSql = buildPivotSQL(pivotConfig);
  check('buildPivotSQL: uses PIVOT ... ON ... USING ... GROUP BY shape', /^PIVOT/.test(pivotSql) && /ON "payer"/.test(pivotSql) && /USING/.test(pivotSql) && /GROUP BY "region"/.test(pivotSql));
  const pivotResult = await engine.runQuery(pivotSql);
  check('buildPivotSQL executed: 2 result rows (North, South)', pivotResult.rows.length === 2);
  const northRow = pivotResult.rows.find(r => r.region === 'North');
  // DuckDB's PIVOT names each output column "<pivot-value>_<using-alias>"
  // when the USING clause carries an explicit alias (here "sum") -- e.g.
  // "Aetna_sum", not bare "Aetna". Assert against the real DuckDB-produced
  // shape rather than a guessed one.
  check('buildPivotSQL executed: North/Aetna cell = 300 (100+200)', northRow && Number(northRow.Aetna_sum) === 300);
  check('buildPivotSQL executed: North/Cigna cell = 50', northRow && Number(northRow.Cigna_sum) === 50);

  // ---------- buildPivotQuery: dispatch + throw on invalid config ----------
  check('buildPivotQuery: dispatches to buildGroupBySQL when columns is empty', buildPivotQuery(groupByConfig, claimsCols) === groupBySql);
  check('buildPivotQuery: dispatches to buildPivotSQL when columns is non-empty', buildPivotQuery(pivotConfig, claimsCols) === pivotSql);
  let threw = false;
  try { buildPivotQuery(createEmptyConfig('claims'), claimsCols); } catch (_e) { threw = true; }
  check('buildPivotQuery: throws on an invalid (empty) config instead of generating broken SQL', threw);

  // ---------- Multi-measure values well ----------
  const multiMeasureConfig = { sourceTable: 'claims', rows: ['region'], columns: [], values: [{ column: 'amount', agg: 'sum' }, { column: 'quantity', agg: 'avg' }] };
  const multiSql = buildGroupBySQL(multiMeasureConfig);
  const multiResult = await engine.runQuery(multiSql);
  const multiNorth = multiResult.rows.find(r => r.region === 'North');
  check('Multi-measure: both aliased columns present (sum_amount, avg_quantity)', multiNorth && 'sum_amount' in multiNorth && 'avg_quantity' in multiNorth);
  check('Multi-measure: avg_quantity for North is (1+2+1)/3', multiNorth && Math.abs(Number(multiNorth.avg_quantity) - (4 / 3)) < 0.001);

  // ---------- count aggregation uses COUNT(col), not COUNT(*) — respects NULLs ----------
  await engine.createTableFromObjects('claims_with_nulls', [
    { region: 'North', amount: 100 },
    { region: 'North', amount: null },
    { region: 'North', amount: 50 },
  ]);
  const countConfig = { sourceTable: 'claims_with_nulls', rows: ['region'], columns: [], values: [{ column: 'amount', agg: 'count' }] };
  const countResult = await engine.runQuery(buildGroupBySQL(countConfig));
  check('count aggregation: counts only non-null amount rows (2 of 3)', Number(countResult.rows[0].count_amount) === 2);

  // ---------- Identifier safety: a column name with a space survives round-trip ----------
  // (DuckDB/Arrow's own CREATE TABLE identifier quoting can't itself embed a
  // literal double-quote in a column name via this test harness's simple
  // object->CREATE TABLE path -- that is a test-harness limitation, not a
  // pivot-builder one. quoteIdent's escaping behavior is already unit-tested
  // directly above; this section instead proves a realistic messy name --
  // an embedded space, which real analyst datasets hit constantly -- works
  // end-to-end through buildGroupBySQL against a real DuckDB table.)
  await engine.createTableFromObjects('weird_cols', [
    { 'region name': 'East', 'total amt': 10 },
    { 'region name': 'East', 'total amt': 20 },
  ]);
  const weirdSchema = await engine.getTableSchema('weird_cols');
  const weirdConfig = { sourceTable: 'weird_cols', rows: ['region name'], columns: [], values: [{ column: 'total amt', agg: 'sum' }] };
  const weirdErrors = validateConfig(weirdConfig, classifyColumns(weirdSchema).allColumns);
  check('validateConfig: accepts space-containing real column names', weirdErrors.length === 0);
  const weirdResult = await engine.runQuery(buildGroupBySQL(weirdConfig));
  check('Identifier safety: quoted space-containing column names execute and sum correctly (30)', Number(weirdResult.rows[0][Object.keys(weirdResult.rows[0]).find(k => /amt/.test(k))]) === 30);

  // ---------- Cardinality guard ----------
  const cardSql = buildCardinalityCheckSQL('claims', ['payer']);
  const cardResult = await engine.runQuery(cardSql);
  check('buildCardinalityCheckSQL: counts distinct payer combinations (2: Aetna, Cigna)', Number(cardResult.rows[0].n) === 2);
  check('MAX_PIVOT_CARDINALITY: is a sane finite cap', MAX_PIVOT_CARDINALITY === 200);

  console.log(`\nPivot Table Builder tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  await engine.closeConnection();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
