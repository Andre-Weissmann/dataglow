// ============================================================
// DataGlow Phase 12 -- NL->SQL Deep Upgrade Tests
// ============================================================
// Tests the zero-cost pattern engine, auto-fix, plain-English explanations,
// and the pattern-first nlToSQL flow. No DOM, no DuckDB, no network.
//
// Run: node test/phase12-nlsql-upgrade.test.mjs
//
// Coding constraints (iOS WKWebView): no backticks, no apostrophes inside
// single-quoted strings (use double-quoted strings when text has apostrophes).
// ============================================================

import {
  detectColumns, detectIntent, buildPatternSQL, autoFixSQL, explainSQL,
} from '../js/nl-sql/nl-sql-pattern-engine.js';

import { datasetsToSchemaContext } from '../js/nl-sql/schema-context.js';
import { matchContracts } from '../js/nl-sql/metric-contracts.js';
import { nlToSQL } from '../js/nl-sql/nl-sql-engine.js';

// ---- Minimal test harness (same shape as phase9) ----
let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.error('  FAIL  ' + label); failed++; }
}

function section(title) { console.log('\n--- ' + title + ' ---'); }

// ---- Sample schema ----
const ENCOUNTERS_COLS = [
  { name: 'encounter_id', type: 'number', rawType: 'INTEGER', isPrimaryKey: true },
  { name: 'patient_id',   type: 'number', rawType: 'INTEGER' },
  { name: 'payer_name',   type: 'text',   rawType: 'VARCHAR' },
  { name: 'denial_reason', type: 'text',  rawType: 'VARCHAR' },
  { name: 'admit_date',   type: 'date',   rawType: 'DATE' },
  { name: 'discharge_date', type: 'date', rawType: 'DATE' },
  { name: 'billed_amount', type: 'number', rawType: 'DECIMAL(18,2)' },
  { name: 'payment_amount', type: 'number', rawType: 'DECIMAL(18,2)' },
  { name: 'claim_status', type: 'text',   rawType: 'VARCHAR' },
  { name: 'readmit_30d',  type: 'number', rawType: 'INTEGER' },
];

const ALL_COLS = ENCOUNTERS_COLS.map(function (c) { return c.name; });
const SCHEMA_CTX = datasetsToSchemaContext(
  [{ name: 'encounters', columns: ENCOUNTERS_COLS, rowCount: 50000 }],
  'healthcare'
);

// ============================================================
// 1. detectColumns
// ============================================================
section('1. detectColumns -- exact, fuzzy, none');

{
  const r = detectColumns('show me the payer_name', ALL_COLS);
  ok(r.exact.indexOf('payer_name') !== -1, 'exact match on payer_name');
}
{
  // "denial reason" (space) should fuzzy/exact match "denial_reason"
  const r = detectColumns('what is the top denial reason', ALL_COLS);
  const found = r.exact.indexOf('denial_reason') !== -1 || r.fuzzy.indexOf('denial_reason') !== -1;
  ok(found, 'underscore-stripping matches denial reason -> denial_reason');
}
{
  const r = detectColumns('group by payer', ALL_COLS);
  const found = r.exact.indexOf('payer_name') !== -1 || r.fuzzy.indexOf('payer_name') !== -1;
  ok(found, 'partial word payer matches payer_name (fuzzy)');
}
{
  const r = detectColumns('what is the weather today', ALL_COLS);
  ok(r.exact.length === 0 && r.fuzzy.length === 0, 'no match for unrelated question');
}

// ============================================================
// 2. detectIntent
// ============================================================
section('2. detectIntent -- each intent type');

ok(detectIntent('what is the average billed amount') === 'aggregate', 'aggregate intent');
ok(detectIntent('sum of payment amount') === 'aggregate', 'aggregate via sum');
ok(detectIntent('show only denied claims where status is denied') === 'filter', 'filter intent');
ok(detectIntent('count encounters by payer') === 'count', 'count wins over group when how-many-style');
ok(detectIntent('breakdown by payer') === 'group', 'group intent');
ok(detectIntent('top 5 payers by volume') === 'rank', 'rank intent');
ok(detectIntent('encounters over time') === 'trend', 'trend intent');
ok(detectIntent('compare payer A versus payer B') === 'compare', 'compare intent');
ok(detectIntent('how many encounters are there') === 'count', 'count intent');
ok(detectIntent('show me all encounters') === 'list', 'list intent');
ok(detectIntent('tell a story about the data') === 'general', 'general fallback');

// ============================================================
// 3. buildPatternSQL
// ============================================================
section('3. buildPatternSQL -- single table, contracts, count, group, null');

{
  // Count query (no group)
  const r = buildPatternSQL('how many encounters are there', SCHEMA_CTX, []);
  ok(r.sql !== null, 'count query builds SQL');
  ok(/COUNT\(\*\)/i.test(r.sql), 'count query uses COUNT(*)');
  ok(r.confidence === 'high', 'count query is high confidence');
  ok(Array.isArray(r.steps) && r.steps.length > 0, 'count query has reasoning steps');
}

{
  // Group-by query
  const r = buildPatternSQL('count encounters by payer_name', SCHEMA_CTX, []);
  ok(r.sql !== null, 'group query builds SQL');
  ok(/GROUP BY/i.test(r.sql), 'group query has GROUP BY');
  ok(r.sql.indexOf('payer_name') !== -1, 'group query groups by payer_name');
}

{
  // Metric contract injection: denial rate
  const contracts = matchContracts('what is the claim denial rate', ALL_COLS);
  ok(contracts.length > 0, 'denial rate contract matched');
  const r = buildPatternSQL('what is the claim denial rate', SCHEMA_CTX, contracts);
  ok(r.sql !== null, 'contract query builds SQL');
  ok(r.sql.indexOf('claim_status') !== -1, 'contract expression injected verbatim');
  ok(r.confidence === 'high', 'contract query is high confidence');
}

{
  // Aggregate: average of a numeric column
  const r = buildPatternSQL('what is the average billed_amount', SCHEMA_CTX, []);
  ok(r.sql !== null, 'aggregate query builds SQL');
  ok(/AVG\(/i.test(r.sql), 'aggregate query uses AVG');
  ok(r.sql.indexOf('billed_amount') !== -1, 'aggregate targets billed_amount');
}

{
  // Unclear question -> null (falls through to LLM)
  const r = buildPatternSQL('xyzzy foo bar', SCHEMA_CTX, []);
  ok(r.sql === null, 'unclear question returns null');
  ok(r.confidence === 'low', 'unclear question is low confidence');
}

// ============================================================
// 4. autoFixSQL
// ============================================================
section('4. autoFixSQL -- column fix, table fix, unfixable');

{
  // Column not found -> substitute similar column
  const bad = 'SELECT "payer_naem" FROM "encounters" LIMIT 10';
  const r = autoFixSQL(bad, 'Binder Error: column "payer_naem" not found', SCHEMA_CTX);
  ok(r.sql !== null, 'column-not-found produces a fix');
  ok(r.sql.indexOf('payer_name') !== -1, 'unknown column replaced with payer_name');
  ok(typeof r.fix === 'string' && r.fix.length > 0, 'fix note describes the change');
}

{
  // Table not found -> substitute similar table
  const bad = 'SELECT * FROM "encounter" LIMIT 10';
  const r = autoFixSQL(bad, 'Catalog Error: table "encounter" does not exist', SCHEMA_CTX);
  ok(r.sql !== null, 'table-not-found produces a fix');
  ok(r.sql.indexOf('encounters') !== -1, 'unknown table replaced with encounters');
}

{
  // Unfixable error -> null
  const bad = 'SELECT * FROM "encounters"';
  const r = autoFixSQL(bad, 'Out of memory while executing query', SCHEMA_CTX);
  ok(r.sql === null, 'unfixable error returns null sql');
  ok(typeof r.fix === 'string', 'unfixable error still returns a fix note');
}

// ============================================================
// 5. explainSQL
// ============================================================
section('5. explainSQL -- plain English, no SQL keywords');

{
  const sql = 'SELECT "payer_name", COUNT(*) AS "row_count" FROM "encounters" GROUP BY "payer_name" ORDER BY "row_count" DESC LIMIT 1000';
  const e = explainSQL(sql, SCHEMA_CTX);
  ok(typeof e === 'string' && e.length > 0, 'explanation is a non-empty string');
  const upper = e.toUpperCase();
  const jargon = ['SELECT', 'GROUP BY', 'ORDER BY', 'WHERE', 'JOIN', 'LIMIT'];
  let hasJargon = false;
  for (let i = 0; i < jargon.length; i++) {
    if (upper.indexOf(jargon[i]) !== -1) hasJargon = true;
  }
  ok(!hasJargon, 'explanation contains no raw SQL keywords');
}

{
  const e = explainSQL('SELECT COUNT(*) FROM "encounters"', SCHEMA_CTX);
  ok(e.toLowerCase().indexOf('count') !== -1, 'count explanation mentions counting');
}

// ============================================================
// 6. nlToSQL integration -- pattern-first, no API key
// ============================================================
section('6. nlToSQL integration -- pattern engine, source, explanation');

{
  // A group-by question that matches no metric contract -> source=pattern.
  const result = await nlToSQL({
    question: 'breakdown by payer_name',
    datasets: [{ name: 'encounters', columns: ENCOUNTERS_COLS, rowCount: 50000 }],
    domainContext: 'healthcare',
    // no callLLM, no provider, no apiKey -> pattern engine must answer
  });
  ok(result.sql && result.sql.length > 0, 'pattern engine produced SQL with no API key');
  ok(result.source === 'pattern', 'source is pattern for a keyless pattern query');
  ok(result.explanation && result.explanation.length > 0, 'explanation is present on the result');
  ok(Array.isArray(result.steps) && result.steps.length > 0, 'steps are present on the result');
}

{
  // Metric contract path reports source=contract
  const result = await nlToSQL({
    question: 'what is the claim denial rate',
    datasets: [{ name: 'encounters', columns: ENCOUNTERS_COLS }],
    domainContext: 'healthcare',
  });
  ok(result.source === 'contract', 'source is contract when a metric contract matched');
  ok(result.contractsUsed.length > 0, 'contractsUsed populated');
  ok(result.explanation.length > 0, 'contract result has an explanation');
}

{
  // preferPattern still lets the pattern engine answer even with callLLM present
  let llmCalled = false;
  const result = await nlToSQL({
    question: 'breakdown by payer_name',
    datasets: [{ name: 'encounters', columns: ENCOUNTERS_COLS }],
    preferPattern: true,
    callLLM: async function () { llmCalled = true; return 'SELECT 1'; },
  });
  ok(result.source === 'pattern', 'preferPattern uses the pattern engine');
  ok(llmCalled === false, 'LLM not called when pattern engine answers');
}

// ============================================================
// Summary
// ============================================================
console.log('\n' + (passed + failed) + ' assertions: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
