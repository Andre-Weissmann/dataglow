// ============================================================
// DATAGLOW — Protocol schema conformance tests
// ============================================================
// Proves the protocol schemas have teeth:
//   1. Every schema file is well-formed JSON Schema with the expected metadata.
//   2. REAL runtime objects produced by the app's own code validate cleanly:
//        - ProvenanceAttestation from js/provenance.js (buildAttestation)
//        - GradeResult from js/calibrated-grades.js (computeCalibratedGrades)
//        - StoryOutput from js/story.js (buildStoryClaims) via the adapter
//        - ValidationRun from a realistic results fixture via the adapter
//   3. Intentionally MALFORMED objects are REJECTED (not just accepted blindly).
//   4. The bundled reference example validates.
//
// RUN WITH:  node test/protocol-schema.test.mjs
// No DuckDB / browser needed — pure Node.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validate, buildRegistry } from '../protocol/validator.mjs';
import { createProvenanceChain } from '../js/provenance.js';
import { computeCalibratedGrades } from '../js/calibrated-grades.js';
import { buildStoryClaims } from '../js/story.js';
import { toValidationRun, toStoryOutput, toDataset } from '../js/protocol-conformance.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '..', 'protocol', 'schema');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}

// ---- Load schemas + registry ----
const schemaFiles = readdirSync(schemaDir).filter(f => f.endsWith('.schema.json'));
const schemas = schemaFiles.map(f => JSON.parse(readFileSync(join(schemaDir, f), 'utf8')));
const registry = buildRegistry(schemas);
const byName = Object.fromEntries(schemas.map(s => [s.$id.split('/').pop(), s]));

console.log('\nSchema metadata');
ok('exactly the 5 core schemas are present', schemaFiles.length === 5, `found ${schemaFiles.length}: ${schemaFiles.join(', ')}`);
for (const s of schemas) {
  ok(`${s.title}: has $id, title, version 1.0.0`,
    !!s.$id && !!s.title && s.version === '1.0.0',
    `$id=${s.$id} title=${s.title} version=${s.version}`);
}
// Protocol VERSION file matches.
const versionFile = readFileSync(join(here, '..', 'protocol', 'VERSION'), 'utf8').trim();
ok('protocol/VERSION is 1.0.0', versionFile === '1.0.0', `got "${versionFile}"`);

// ---- Helper ----
function expectValid(label, obj, schema) {
  const { valid, errors } = validate(obj, schema, registry);
  ok(label, valid, errors.join('; '));
}
function expectInvalid(label, obj, schema) {
  const { valid } = validate(obj, schema, registry);
  ok(label, !valid, 'expected validation to FAIL but it passed');
}

// ============================================================
// ProvenanceAttestation — real object from the app
// ============================================================
console.log('\nProvenanceAttestation (real runtime object)');
const chain = createProvenanceChain();
await chain.append('load', 'Loaded dataset', { source: 'x.csv' }, 'ab'.repeat(32));
await chain.append('query', 'SELECT * ...', { rows: 10 });
const att = await chain.attest({ table: 't', rowCount: 100, columns: [{ name: 'a', type: 'INTEGER' }], loadedAt: Date.now() });
expectValid('real attestation validates', att, byName['provenance-attestation.schema.json']);

// Tamper: break the "kind" discriminator → must fail.
expectInvalid('attestation with wrong kind is rejected',
  { ...att, kind: 'not-a-dataglow-attestation' }, byName['provenance-attestation.schema.json']);
// Tamper: a non-hex hash → must fail (pattern has teeth).
const badHash = JSON.parse(JSON.stringify(att));
badHash.chain.steps[0].hash = 'NOT_A_HEX_HASH';
expectInvalid('attestation with malformed hash is rejected', badHash, byName['provenance-attestation.schema.json']);
// Tamper: drop a required field.
const missingDigest = JSON.parse(JSON.stringify(att));
delete missingDigest.digest;
expectInvalid('attestation missing digest is rejected', missingDigest, byName['provenance-attestation.schema.json']);

// ============================================================
// GradeResult — real object from computeCalibratedGrades
// ============================================================
console.log('\nGradeResult (real runtime object)');
const results = {
  unit_tests: { status: 'pass', summary: 'ok', detail: null, ts: Date.now() },
  cross_column_logic: { status: 'warn', summary: 'some issues', detail: null, ts: Date.now() },
  semantic_drift: { status: 'pass', summary: 'ok', detail: null, ts: Date.now() },
  sanity_anchor: { status: 'pass', summary: 'ok', detail: null, ts: Date.now() },
  outlier_detection: { status: 'fail', summary: 'outliers', detail: null, ts: Date.now() },
  benford: { status: 'idle', summary: 'n/a', detail: null, ts: Date.now() },
};
const grades = computeCalibratedGrades({ results, packName: 'healthcare', packLabel: 'Healthcare', annotations: [{ x: 1 }] });
expectValid('real calibrated grades validate', grades, byName['grade-result.schema.json']);
expectInvalid('grade with out-of-band letter is rejected',
  { ...grades, integrity: { ...grades.integrity, grade: 'Z' } }, byName['grade-result.schema.json']);
expectInvalid('grade with score > 1 is rejected',
  { ...grades, plausibility: { ...grades.plausibility, score: 1.5 } }, byName['grade-result.schema.json']);

// ============================================================
// ValidationRun — via adapter over a realistic results fixture
// ============================================================
console.log('\nValidationRun (adapter over real results shape)');
const resultsFull = {
  ...results,
  confidence: { score: 82, grade: 'B', verdict: 'Ready to present', signals: { 'Sample size': 100 }, status: 'pass' },
  calibratedGrades: grades,
  domainPack: { packName: 'healthcare', packLabel: 'Healthcare', annotations: [] },
};
const ds = { table: 't', cols: [{ name: 'a', type: 'INTEGER' }, { name: 'b', type: 'DOUBLE' }], rowCount: 100 };
const run = toValidationRun(resultsFull, toDataset(ds));
expectValid('adapted validation run validates', run, byName['validation-run.schema.json']);
ok('validation run carries protocolVersion 1.0.0', run.protocolVersion === '1.0.0');
ok('validation run lifted confidence out of layers', !run.layers.confidence && !!run.confidence);
ok('validation run attached grades', !!run.grades);
expectInvalid('validation run with bad layer status is rejected',
  { ...run, layers: { ...run.layers, unit_tests: { status: 'bogus' } } }, byName['validation-run.schema.json']);

// Dataset schema directly.
console.log('\nDataset (adapter)');
expectValid('adapted dataset validates', toDataset(ds), byName['dataset.schema.json']);
expectInvalid('dataset with negative rowCount is rejected',
  { ...toDataset(ds), rowCount: -5 }, byName['dataset.schema.json']);

// ============================================================
// StoryOutput — via adapter over real buildStoryClaims output
// ============================================================
console.log('\nStoryOutput (real claims + adapter)');
const queryResult = {
  columns: ['payer', 'amount'],
  rows: Array.from({ length: 120 }, (_, i) => ({ payer: i % 3 === 0 ? 'Aetna' : 'Cigna', amount: 100 + i })),
  rowCount: 120,
};
const claims = buildStoryClaims(queryResult);
ok('buildStoryClaims produced claims', claims.length > 0);
const story = toStoryOutput({ text: 'A narrative about the data.', source: 'local' }, claims);
expectValid('adapted story output validates', story, byName['story-output.schema.json']);
expectInvalid('story output with unknown source is rejected',
  { ...story, source: 'telepathy' }, byName['story-output.schema.json']);
expectInvalid('story output missing text is rejected',
  (() => { const s = { ...story }; delete s.text; return s; })(), byName['story-output.schema.json']);

// ============================================================
// Bundled reference example validates
// ============================================================
console.log('\nReference example');
const sample = JSON.parse(readFileSync(join(here, '..', 'protocol', 'examples', 'sample-attestation.json'), 'utf8'));
expectValid('bundled sample-attestation.json validates', sample, byName['provenance-attestation.schema.json']);

// ---- Summary ----
console.log(`\n${failed === 0 ? '✓ ALL PASSED' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
