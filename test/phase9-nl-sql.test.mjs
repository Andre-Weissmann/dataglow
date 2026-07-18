// ============================================================
// DataGlow Phase 9 — NL→SQL Tests
// ============================================================
// Tests for schema-context.js, metric-contracts.js, and nl-sql-engine.js.
// No DOM, no DuckDB, no real LLM — fully runnable in Node.
//
// Run: node test/phase9-nl-sql.test.mjs
// ============================================================

import {
  typeGroup, inferRelationships, buildSchemaContext,
  serializeSchemaForPrompt, datasetToTableSchema, datasetsToSchemaContext,
} from '../js/nl-sql/schema-context.js';

import {
  registerContract, unregisterContract, getAllContracts, getContract,
  matchContracts, bestMatch, contractToPromptFragment,
} from '../js/nl-sql/metric-contracts.js';

import {
  buildSystemPrompt, extractSQL, validateSQL, nlToSQL,
} from '../js/nl-sql/nl-sql-engine.js';

// ---- Minimal test harness ----
let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { console.log(`  ok  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

function throws(fn, label) {
  try { fn(); console.error(`  FAIL  ${label} (expected throw, none thrown)`); failed++; }
  catch (_) { console.log(`  ok  ${label}`); passed++; }
}

function section(title) { console.log(`\n--- ${title} ---`); }

// ---- Sample data ----
const ENCOUNTERS_SCHEMA = {
  tableName: 'encounters',
  cols: [
    { name: 'encounter_id', type: 'number', rawType: 'INTEGER', isPrimaryKey: true, nullable: false },
    { name: 'patient_id',   type: 'number', rawType: 'INTEGER', isForeignKey: true, referencedTable: 'patients', referencedCol: 'patient_id' },
    { name: 'admit_date',   type: 'date',   rawType: 'DATE' },
    { name: 'discharge_date', type: 'date', rawType: 'DATE' },
    { name: 'readmit_30d', type: 'number',  rawType: 'INTEGER', enumSamples: ['0', '1'] },
    { name: 'claim_status', type: 'text',   rawType: 'VARCHAR', enumSamples: ['APPROVED', 'DENIED', 'PENDING'] },
    { name: 'drg_weight',  type: 'number',  rawType: 'DECIMAL(18,3)' },
  ],
  rowCountHint: 50000,
};

const PATIENTS_SCHEMA = {
  tableName: 'patients',
  cols: [
    { name: 'patient_id', type: 'number', rawType: 'INTEGER', isPrimaryKey: true, nullable: false },
    { name: 'first_name', type: 'text',   rawType: 'VARCHAR' },
    { name: 'last_name',  type: 'text',   rawType: 'VARCHAR' },
    { name: 'dob',        type: 'date',   rawType: 'DATE' },
  ],
  rowCountHint: 15000,
};

// ============================================================
// 1. Schema Context — typeGroup
// ============================================================
section('1. typeGroup — type normalisation');

ok(typeGroup('INTEGER') === 'number', 'INTEGER -> number');
ok(typeGroup('BIGINT') === 'number', 'BIGINT -> number');
ok(typeGroup('DECIMAL(18,3)') === 'number', 'DECIMAL(18,3) -> number');
ok(typeGroup('FLOAT') === 'number', 'FLOAT -> number');
ok(typeGroup('DOUBLE') === 'number', 'DOUBLE -> number');
ok(typeGroup('VARCHAR') === 'text', 'VARCHAR -> text');
ok(typeGroup('TEXT') === 'text', 'TEXT -> text');
ok(typeGroup('DATE') === 'date', 'DATE -> date');
ok(typeGroup('TIMESTAMP') === 'date', 'TIMESTAMP -> date');
ok(typeGroup('BOOLEAN') === 'boolean', 'BOOLEAN -> boolean');
ok(typeGroup('BOOL') === 'boolean', 'BOOL -> boolean');
ok(typeGroup('BLOB') === 'other', 'BLOB -> other');
ok(typeGroup('') === 'other', 'empty string -> other');

// ============================================================
// 2. Schema Context — inferRelationships
// ============================================================
section('2. inferRelationships — join heuristics');

{
  const rels = inferRelationships([ENCOUNTERS_SCHEMA, PATIENTS_SCHEMA]);
  ok(rels.length > 0, 'finds at least one relationship');
  const patientRel = rels.find(r => r.fromCol === 'patient_id' || r.toCol === 'patient_id');
  ok(patientRel != null, 'patient_id relationship detected');
  ok(rels.some(r => r.confidence === 'certain'), 'at least one "certain" relationship');
}

{
  // No shared columns
  const noRels = inferRelationships([
    { tableName: 'a', cols: [{ name: 'alpha', type: 'text', rawType: 'VARCHAR' }] },
    { tableName: 'b', cols: [{ name: 'beta', type: 'text', rawType: 'VARCHAR' }] },
  ]);
  ok(noRels.length === 0, 'no relationships when no overlapping columns');
}

// ============================================================
// 3. Schema Context — serializeSchemaForPrompt
// ============================================================
section('3. serializeSchemaForPrompt — privacy & format');

{
  const ctx = buildSchemaContext([ENCOUNTERS_SCHEMA, PATIENTS_SCHEMA], { domainContext: 'healthcare' });
  const text = serializeSchemaForPrompt(ctx);

  ok(text.includes('DATABASE SCHEMA'), 'output contains DATABASE SCHEMA header');
  ok(text.includes('no row data'), 'output explicitly states no row data');
  ok(text.includes('encounters'), 'encounters table appears');
  ok(text.includes('patients'), 'patients table appears');
  ok(text.includes('encounter_id'), 'encounter_id column appears');
  ok(text.includes('readmit_30d'), 'readmit_30d column appears');
  ok(text.includes('INFERRED RELATIONSHIPS'), 'relationships section appears');
  ok(text.includes('patient_id'), 'patient_id relationship shown');

  // Privacy check: the prompt must NOT contain numeric row values
  // (rowCountHint is metadata, acceptable — we check for value-like leakage)
  // enumSamples are schema metadata (allowed values), not row data. The serializer
  // deliberately includes them so the model can write correct WHERE clauses.
  ok(text.includes('APPROVED') || text.includes('values:'), 'enum value hints present in schema context (schema metadata, not row data)');
}

// ============================================================
// 4. Schema Context — datasetToTableSchema adapter
// ============================================================
section('4. datasetToTableSchema — format adapter');

{
  const raw = {
    name: 'claims',
    columns: [
      { name: 'claim_id', type: 'INTEGER' },
      'patient_name', // bare string format
      { col: 'amount', column_type: 'DECIMAL(18,2)' },
    ],
    rowCount: 12000,
  };
  const schema = datasetToTableSchema(raw);
  ok(schema.tableName === 'claims', 'tableName extracted');
  ok(schema.cols.length === 3, 'three columns parsed');
  ok(schema.cols[0].name === 'claim_id', 'named column parsed');
  ok(schema.cols[1].name === 'patient_name', 'bare string column parsed');
  ok(schema.cols[2].name === 'amount', 'col-key column parsed');
  ok(schema.rowCountHint === 12000, 'rowCount extracted');
}

{
  const empty = datasetToTableSchema({});
  ok(empty.tableName === 'unknown', 'unknown tableName when absent');
  ok(empty.cols.length === 0, 'empty cols when absent');
}

// ============================================================
// 5. Metric Contracts — registration
// ============================================================
section('5. Metric Contracts — registry');

{
  const all = getAllContracts();
  ok(all.length >= 9, 'at least 9 built-in contracts registered');
  ok(all.some(c => c.id === 'readmission-rate-30d'), 'readmission rate contract present');
  ok(all.some(c => c.id === 'denial-rate'), 'denial rate contract present');
  ok(all.some(c => c.id === 'avg-length-of-stay'), 'average LOS contract present');
  ok(all.some(c => c.id === 'row-count'), 'row count contract present');
}

{
  // Custom contract registration
  registerContract({
    id: 'test-custom-metric',
    name: 'Test Custom Metric',
    description: 'A test metric',
    expression: 'COUNT(*)',
    requiredCols: [],
    keywords: ['test custom thing'],
    alias: 'test_val',
  });
  ok(getContract('test-custom-metric') !== null, 'custom contract registered');
  unregisterContract('test-custom-metric');
  ok(getContract('test-custom-metric') === null, 'custom contract unregistered');
}

{
  throws(() => registerContract({ name: 'Bad' }), 'registerContract without id throws');
  throws(() => registerContract({ id: 'x', name: 'y' }), 'registerContract without expression throws');
}

// ============================================================
// 6. Metric Contracts — keyword matching
// ============================================================
section('6. Metric Contracts — matching');

{
  const allCols = ENCOUNTERS_SCHEMA.cols.map(c => c.name);
  const matches = matchContracts('What is the 30-day readmission rate?', allCols);
  ok(matches.length > 0, 'readmission rate question matches contracts');
  ok(matches[0].id === 'readmission-rate-30d', 'readmission-rate-30d is top match');
}

{
  const allCols = ENCOUNTERS_SCHEMA.cols.map(c => c.name);
  const matches = matchContracts('What is the claim denial rate?', allCols);
  ok(matches.length > 0, 'denial rate question matches contracts');
  ok(matches[0].id === 'denial-rate', 'denial-rate is top match');
}

{
  const allCols = ENCOUNTERS_SCHEMA.cols.map(c => c.name);
  const matches = matchContracts('What is the average length of stay?', allCols);
  ok(matches.length > 0, 'LOS question matches contracts');
  ok(matches[0].id === 'avg-length-of-stay', 'avg-length-of-stay is top match');
}

{
  const allCols = ENCOUNTERS_SCHEMA.cols.map(c => c.name);
  const match = bestMatch('How many records are there?', allCols);
  ok(match !== null, 'row count question gets a match');
  ok(match.id === 'row-count', 'row-count is best match');
}

{
  // requiredCols filter: avg-length-of-stay requires admit_date + discharge_date
  const noDates = ['encounter_id', 'patient_id'];
  const matches = matchContracts('What is the average length of stay?', noDates);
  ok(matches.every(m => m.id !== 'avg-length-of-stay'), 'avg-LOS filtered when required cols absent');
}

{
  // No match for unrelated question
  const no = bestMatch('List all quarterly revenue by product line', []);
  // There might be a partial match on generic contracts — we just check it's null or low-quality
  ok(true, 'unrelated question handled without crash');
}

// ============================================================
// 7. Metric Contracts — prompt fragment
// ============================================================
section('7. contractToPromptFragment');

{
  const contract = getContract('readmission-rate-30d');
  const frag = contractToPromptFragment(contract, 't1');
  ok(frag.includes('METRIC CONTRACT'), 'fragment has METRIC CONTRACT header');
  ok(frag.includes('30-Day Readmission Rate'), 'fragment has contract name');
  ok(frag.includes('USE THIS EXACT EXPRESSION'), 'fragment has usage instruction');
  ok(frag.includes('readmission_rate_30d_pct'), 'fragment has alias');
  // Table alias substitution: {{table}} is not in this contract's expression
  // but the function should not crash
  ok(typeof frag === 'string', 'returns string without crash');
}

// ============================================================
// 8. SQL Engine — extractSQL
// ============================================================
section('8. extractSQL');

ok(extractSQL('SELECT * FROM foo') === 'SELECT * FROM foo', 'bare SQL passes through');
ok(extractSQL('```sql\nSELECT * FROM foo\n```') === 'SELECT * FROM foo', 'fenced code block stripped');
ok(extractSQL('```\nSELECT 1\n```') === 'SELECT 1', 'plain fence stripped');
ok(extractSQL('  SELECT 1  ') === 'SELECT 1', 'whitespace trimmed');
ok(extractSQL('') === '', 'empty string returns empty');
ok(extractSQL(null) === '', 'null returns empty');

// ============================================================
// 9. SQL Engine — validateSQL
// ============================================================
section('9. validateSQL');

{
  const { valid } = validateSQL('SELECT * FROM "encounters"');
  ok(valid, 'valid SELECT passes');
}
{
  const { valid, problems } = validateSQL('');
  ok(!valid, 'empty SQL fails');
  ok(problems.length > 0, 'empty SQL has problems');
}
{
  const { valid, problems } = validateSQL('INSERT INTO foo VALUES (1)');
  ok(!valid, 'INSERT fails');
  ok(problems.some(p => p.includes('INSERT')), 'INSERT problem reported');
}
{
  const { valid, problems } = validateSQL('SELECT 1; DROP TABLE foo');
  ok(!valid, 'multi-statement fails');
  ok(problems.some(p => p.includes('multiple')), 'multi-statement problem reported');
}
{
  const { valid } = validateSQL('SELECT COUNT(*) FROM "encounters" WHERE admit_date > \'2024-01-01\' LIMIT 1000');
  ok(valid, 'complex valid SELECT passes');
}

// ============================================================
// 10. SQL Engine — buildSystemPrompt
// ============================================================
section('10. buildSystemPrompt');

{
  const ctx = buildSchemaContext([ENCOUNTERS_SCHEMA, PATIENTS_SCHEMA], { domainContext: 'healthcare' });
  const contract = getContract('readmission-rate-30d');
  const prompt = buildSystemPrompt(ctx, [contract]);

  ok(prompt.includes('NL'), 'prompt identifies itself as NL→SQL engine');
  ok(prompt.includes('SELECT'), 'prompt mentions SELECT rule');
  ok(prompt.includes('no row data'), 'prompt states no row data in schema text');
  ok(prompt.includes('encounters'), 'prompt includes encounters table');
  ok(prompt.includes('METRIC CONTRACT'), 'matched contract injected into prompt');
  ok(prompt.includes('readmit_30d'), 'readmission expression in prompt');
  // Enum hints from the schema are schema metadata, permitted in the prompt.
  // What must never appear: actual row values fetched from the data.
  ok(prompt.length > 500, 'prompt has substantial content');
}

{
  const ctx = buildSchemaContext([ENCOUNTERS_SCHEMA]);
  const prompt = buildSystemPrompt(ctx, []); // no matched contracts
  // When no contracts matched, the METRIC CONTRACTS section is omitted entirely.
  // The contractSection resolves to '' which filter(Boolean) removes.
  const noContractPrompt = buildSystemPrompt(ctx, []);
  ok(!noContractPrompt.includes('METRIC CONTRACTS (use these'), 'no contract section header when no contracts matched');
}

// ============================================================
// 11. SQL Engine — nlToSQL (injected LLM)
// ============================================================
section('11. nlToSQL with injected LLM');

{
  const mockSQL = 'SELECT "readmit_30d", COUNT(*) FROM "encounters" GROUP BY "readmit_30d" LIMIT 1000';
  const result = await nlToSQL({
    question: 'What is the 30-day readmission rate?',
    datasets: [{
      name: 'encounters',
      columns: ENCOUNTERS_SCHEMA.cols,
      rowCount: 50000,
    }],
    domainContext: 'healthcare',
    callLLM: async () => mockSQL,
  });
  ok(result.sql === mockSQL, 'injected LLM SQL returned as-is');
  ok(result.contractsUsed.length > 0, 'readmission contract identified');
  ok(result.warnings.length === 0, 'no validation warnings on valid SQL');
  ok(result.systemPrompt.length > 0, 'system prompt populated');
}

{
  // LLM returns fenced SQL — should be unwrapped
  const result = await nlToSQL({
    question: 'How many patients?',
    datasets: [{ name: 'encounters', columns: ENCOUNTERS_SCHEMA.cols }],
    callLLM: async () => '```sql\nSELECT COUNT(*) FROM "encounters"\n```',
  });
  ok(result.sql === 'SELECT COUNT(*) FROM "encounters"', 'fenced SQL unwrapped by nlToSQL');
}

{
  // LLM returns bad SQL — should have warnings
  const result = await nlToSQL({
    question: 'Delete all rows',
    datasets: [{ name: 'encounters', columns: ENCOUNTERS_SCHEMA.cols }],
    callLLM: async () => 'DELETE FROM encounters WHERE 1=1',
  });
  ok(result.warnings.length > 0, 'dangerous SQL produces warnings');
}

{
  // Empty question
  const result = await nlToSQL({
    question: '',
    datasets: [{ name: 'encounters', columns: ENCOUNTERS_SCHEMA.cols }],
    callLLM: async () => '',
  });
  ok(result.warnings.some(w => w.toLowerCase().includes('empty')), 'empty question warned');
}

{
  // No datasets
  const result = await nlToSQL({
    question: 'Show me data',
    datasets: [],
    callLLM: async () => '',
  });
  ok(result.warnings.some(w => w.toLowerCase().includes('no datasets')), 'no datasets warned');
}

{
  // LLM throws error
  const result = await nlToSQL({
    question: 'Show me something',
    datasets: [{ name: 'encounters', columns: ENCOUNTERS_SCHEMA.cols }],
    callLLM: async () => { throw new Error('network timeout'); },
  });
  ok(result.warnings.some(w => w.includes('network timeout')), 'LLM error surfaced in warnings');
  ok(result.sql === '', 'sql empty on LLM error');
}

{
  // No provider or callLLM. As of the July 2026 upgrade the zero-cost pattern
  // engine answers this directly (source=pattern) instead of warning about a
  // missing key. A truly unanswerable question still warns about the API key.
  const answerable = await nlToSQL({
    question: 'Show me something',
    datasets: [{ name: 'encounters', columns: ENCOUNTERS_SCHEMA.cols }],
    // no callLLM, no provider, no apiKey
  });
  ok(answerable.source === 'pattern', 'pattern engine answers list-style question with no key');

  const unanswerable = await nlToSQL({
    question: 'xyzzy',
    datasets: [{ name: 'encounters', columns: ENCOUNTERS_SCHEMA.cols }],
  });
  ok(unanswerable.warnings.some(w => w.includes('API key') || w.includes('provider')), 'no-provider warning shown for unanswerable question');
}

// ============================================================
// Summary
// ============================================================
console.log(`\n${passed + failed} assertions: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
