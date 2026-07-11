// ============================================================
// DATAGLOW — Metric Studio test suite (OneCanvas Phase 1, Part 5)
// ============================================================
// Proves the metric registry + its honesty guards behave as specified:
//   - a metric formula is validated against the REAL dataset schema and columns
//     that don't exist are rejected with a clear error,
//   - the formula is actually COMPUTED against a real DuckDB table (native test
//     engine) and the stored value is that computed number, not a placeholder,
//   - a failing formula records the error, never a fake value,
//   - duplicate detection fires on same-formula and on >90% similar text,
//   - plain-English → formula suggestion maps to real columns,
//   - the registry's status counts + JSON export/import round-trip.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/metric-studio.test.mjs
// The compute section touches DuckDB; the rest is pure.

import { createTableFromObjects, closeConnection, runQuery } from './node-duckdb-engine.mjs';
import {
  MetricRegistry, validateMetricDefinition, referencedIdentifiers,
  suggestExpression, computeMetricValue, findDuplicates, textSimilarity,
  METRIC_STATUSES,
} from '../js/metrics/metric-studio.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const SCHEMA = [
  { name: 'readmissions', type: 'DOUBLE' },
  { name: 'total_discharges', type: 'DOUBLE' },
  { name: 'hospital', type: 'VARCHAR' },
];

async function main() {
  // ---------- 1. Column-reference extraction ----------
  const refs = referencedIdentifiers('SUM(readmissions) / NULLIF(SUM(total_discharges), 0)');
  ok(refs.includes('readmissions') && refs.includes('total_discharges'), 'refs: real columns extracted');
  ok(!refs.includes('sum') && !refs.includes('nullif'), 'refs: SQL functions are not treated as columns');

  // ---------- 2. Validation against the real schema ----------
  const good = validateMetricDefinition(
    { name: 'Readmission Rate', expression: 'SUM(readmissions) / NULLIF(SUM(total_discharges), 0)' }, SCHEMA);
  ok(good.valid && good.columns.includes('readmissions') && good.columns.includes('total_discharges'),
    'validate: a formula over real columns passes and records source columns');

  const bad = validateMetricDefinition({ name: 'Bogus', expression: 'SUM(nonexistent_col)' }, SCHEMA);
  ok(!bad.valid && bad.errors.some(e => /not in the dataset/.test(e)),
    'validate: an undefined column is rejected with a clear error (no silent garbage)');

  ok(!validateMetricDefinition({ name: '', expression: 'SUM(readmissions)' }, SCHEMA).valid,
    'validate: an empty name is rejected');
  ok(!validateMetricDefinition({ name: 'X', expression: 'SUM(readmissions); DROP TABLE t' }, SCHEMA).valid,
    'validate: a chained statement (";") is rejected');

  // ---------- 3. Real DuckDB compute ----------
  await createTableFromObjects('encounters', [
    { readmissions: 2, total_discharges: 10, hospital: 'A' },
    { readmissions: 3, total_discharges: 10, hospital: 'B' },
    { readmissions: 0, total_discharges: 20, hospital: 'A' },
  ]);
  const engine = { runQuery };
  const computed = await computeMetricValue({
    table: 'encounters', expression: 'SUM(readmissions) / NULLIF(SUM(total_discharges), 0)', engine,
  });
  // (2+3+0) / (10+10+20) = 5/40 = 0.125
  ok(computed.ok && Math.abs(computed.value - 0.125) < 1e-9, 'compute: real DuckDB value is stored (0.125), not a placeholder');
  ok(typeof computed.computedAt === 'number', 'compute: a real timestamp is recorded');

  const failComp = await computeMetricValue({ table: 'encounters', expression: 'SUM(nope_col)', engine });
  ok(!failComp.ok && failComp.value === null && failComp.error, 'compute: a failing formula records an error, not a fake value');

  // ---------- 4. Registry add + compute-value storage ----------
  const reg = new MetricRegistry();
  const m1 = reg.add({
    name: 'Readmission Rate', plainEnglish: 'readmission rate = readmissions / total_discharges',
    expression: 'SUM(readmissions) / NULLIF(SUM(total_discharges), 0)', columns: ['readmissions', 'total_discharges'],
    computedValue: computed.value, computedAt: computed.computedAt, status: 'reviewed',
  });
  ok(reg.size === 1 && m1.status === 'reviewed' && m1.computedValue === 0.125, 'registry: metric stored with its computed value');
  ok(METRIC_STATUSES.includes(reg.get(m1.id).status), 'registry: status is one of the allowed set');

  // ---------- 5. Duplicate detection ----------
  const sameFormula = findDuplicates(reg.list(), {
    plainEnglish: 'totally different words here about widgets',
    expression: 'SUM(readmissions)/NULLIF(SUM(total_discharges),0)', // same formula, whitespace-different
  });
  ok(sameFormula.length === 1 && sameFormula[0].reason === 'same-formula', 'dup: identical formula (whitespace aside) is caught');

  const similarText = findDuplicates(reg.list(), {
    plainEnglish: 'readmission rate = readmissions / total_discharges',
    expression: 'AVG(readmissions)',
  });
  ok(similarText.length === 1 && similarText[0].reason === 'similar-text' && similarText[0].similarity >= 0.9,
    'dup: >90% similar plain-English text is caught');

  const noDup = findDuplicates(reg.list(), { plainEnglish: 'average length of stay per ward', expression: 'AVG(hospital)' });
  ok(noDup.length === 0, 'dup: an unrelated metric is not flagged');
  ok(textSimilarity('abc', 'abc') === 1 && textSimilarity('abc', 'xyz') < 0.5, 'dup: textSimilarity sanity');

  // ---------- 6. Suggestion ----------
  ok(suggestExpression('readmission rate = readmissions / total_discharges', SCHEMA) === 'readmissions / total_discharges',
    'suggest: explicit "= rhs" with real columns is returned verbatim');
  ok(/SUM\("readmissions"\)\s*\/\s*NULLIF\(SUM\("total_discharges"\)/.test(
    suggestExpression('readmissions per total_discharges', SCHEMA)),
    'suggest: "A per B" becomes a SUM ratio over real columns');
  ok(suggestExpression('some words with no known columns', SCHEMA) === '', 'suggest: nothing confident → empty string');

  // ---------- 7. Status counts + JSON round-trip ----------
  reg.add({ name: 'Certified One', expression: 'COUNT(hospital)', columns: ['hospital'], status: 'certified' });
  reg.add({ name: 'Exploratory One', expression: 'AVG(readmissions)', columns: ['readmissions'] }); // defaults exploratory
  const counts = reg.statusCounts();
  ok(counts.certified === 1 && counts.reviewed === 1 && counts.exploratory === 1 && counts.total === 3,
    'counts: certified/reviewed/exploratory tally is correct');

  const json = reg.toJSON();
  const round = MetricRegistry.fromJSON(json);
  ok(round.size === 3 && round.statusCounts().certified === 1, 'json: export/import round-trips the registry');

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
