// ============================================================
// DATAGLOW — Polyglot Autocomplete (Batch D) tests
// ============================================================
// RUN: node test/polyglot-autocomplete.test.mjs

import { getSuggestions, topSuggestion } from '../js/polyglot/polyglot-autocomplete.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 FAILED: ' + msg); }
}
function eq(a, b, msg) {
  ok(a === b, (msg || '') + ' (expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a) + ')');
}

// Shared test registry
const entries = [
  {
    name: 'patients',
    originLanguage: 'sql',
    kind: 'dataframe',
    schema: [
      { name: 'patient_id', type: 'INTEGER' },
      { name: 'date_of_birth', type: 'DATE' },
      { name: 'admission_date', type: 'DATE' },
      { name: 'los_days', type: 'INTEGER' },
    ],
    rowCount: 500,
    provenance: 'patients',
  },
  {
    name: 'py:claims',
    originLanguage: 'python',
    kind: 'dataframe',
    schema: [
      { name: 'claim_id', type: 'VARCHAR' },
      { name: 'amount', type: 'DOUBLE' },
    ],
    rowCount: 1200,
    provenance: 'claims',
  },
  {
    name: 'r:vitals',
    originLanguage: 'r',
    kind: 'dataframe',
    schema: [
      { name: 'patient_id', type: 'INTEGER' },
      { name: 'bp_systolic', type: 'INTEGER' },
    ],
    rowCount: 800,
    provenance: 'vitals',
  },
];

// ============================================================
// getSuggestions — SQL language
// ============================================================
console.log('\ngetSuggestions — SQL');

const sqlPatients = getSuggestions('pat', 'sql', entries);
ok(sqlPatients.length > 0, 'SQL: "pat" returns suggestions');
ok(sqlPatients.some(function(s) { return s.text === 'patients'; }), 'SQL: "pat" suggests "patients" table');
ok(sqlPatients.every(function(s) { return typeof s.text === 'string'; }), 'SQL: all suggestions have text');
ok(sqlPatients.every(function(s) { return typeof s.score === 'number'; }), 'SQL: all suggestions have score');
ok(sqlPatients.every(function(s) { return ['table','column','keyword','function','snippet'].includes(s.kind); }), 'SQL: all have valid kind');
// Sorted descending by score
ok(sqlPatients[0].score >= sqlPatients[sqlPatients.length - 1].score, 'SQL: sorted descending by score');

// Bridge prefix suggestions (py.claims, r.vitals)
const sqlBridge = getSuggestions('py', 'sql', entries, { includeBridgePrefixes: true });
ok(sqlBridge.some(function(s) { return s.text === 'py.claims'; }), 'SQL: bridge prefix py.claims suggested');

const sqlBridgeOff = getSuggestions('py', 'sql', entries, { includeBridgePrefixes: false });
ok(!sqlBridgeOff.some(function(s) { return s.text === 'py.claims'; }), 'SQL: bridge prefix off hides py.claims');

// Column suggestions
const sqlCol = getSuggestions('patient', 'sql', entries);
ok(sqlCol.some(function(s) { return s.text === 'patient_id'; }), 'SQL: "patient" suggests patient_id column');

// Keyword suggestions
const sqlSel = getSuggestions('SEL', 'sql', entries);
ok(sqlSel.some(function(s) { return s.text === 'SELECT'; }), 'SQL: "SEL" suggests SELECT keyword');

// Function suggestions
const sqlCnt = getSuggestions('cou', 'sql', entries);
ok(sqlCnt.some(function(s) { return s.text === 'COUNT'; }), 'SQL: "cou" suggests COUNT function');

// Empty typed — returns nothing (no prefix match)
const sqlEmpty = getSuggestions('', 'sql', entries);
ok(sqlEmpty.length === 0, 'SQL: empty typed returns no suggestions');

// maxResults respected
const sqlMax = getSuggestions('a', 'sql', entries, { maxResults: 3 });
ok(sqlMax.length <= 3, 'SQL: maxResults=3 honored');

// No registry — still returns builtins
const sqlNoReg = getSuggestions('SEL', 'sql', []);
ok(sqlNoReg.some(function(s) { return s.text === 'SELECT'; }), 'SQL: no registry still returns keyword builtins');

// ============================================================
// getSuggestions — Python language
// ============================================================
console.log('\ngetSuggestions — Python');

// Object names are the bare name (without py: prefix) for get_df calls
const pyObj = getSuggestions('claim', 'python', entries);
ok(pyObj.some(function(s) { return s.text === 'claims'; }), 'Python: "claim" suggests "claims" (stripped from py:claims)');
ok(pyObj.some(function(s) { return s.origin === 'object-space'; }), 'Python: object-space origin present');

// Column bracket notation
const pyCol = getSuggestions("['amount", 'python', entries);
ok(pyCol.some(function(s) { return s.text === "['amount']"; }), 'Python: suggests [\'amount\'] bracket notation');

// Snippet suggestions
const pySnip = getSuggestions('dataglow', 'python', entries);
ok(pySnip.some(function(s) { return s.text === 'dataglow.get_df('; }), 'Python: "dataglow" suggests dataglow.get_df( snippet');

const pyImport = getSuggestions('import', 'python', entries);
ok(pyImport.some(function(s) { return s.text === 'import pandas as pd'; }), 'Python: "import" suggests pandas snippet');

// Not a SQL result
const pyNoSql = getSuggestions('SEL', 'python', entries);
ok(!pyNoSql.some(function(s) { return s.text === 'SELECT'; }), 'Python: SQL keywords not offered in python mode');

// ============================================================
// getSuggestions — R language
// ============================================================
console.log('\ngetSuggestions — R');

const rObj = getSuggestions('vital', 'r', entries);
ok(rObj.some(function(s) { return s.text === 'vitals'; }), 'R: "vital" suggests "vitals" (stripped from r:vitals)');
ok(rObj.some(function(s) { return s.origin === 'object-space'; }), 'R: object-space origin present');

// $ column notation
const rCol = getSuggestions('$bp', 'r', entries);
ok(rCol.some(function(s) { return s.text === '$bp_systolic'; }), 'R: "$bp" suggests $bp_systolic');

// Snippet suggestions
const rSnip = getSuggestions('dataglow', 'r', entries);
ok(rSnip.some(function(s) { return s.text === 'dataglow_get_df('; }), 'R: "dataglow" suggests dataglow_get_df( snippet');

const rLib = getSuggestions('library', 'r', entries);
ok(rLib.some(function(s) { return s.text === 'library(dplyr)'; }), 'R: "library" suggests library(dplyr)');

// SQL keywords not in R
const rNoSql = getSuggestions('SEL', 'r', entries);
ok(!rNoSql.some(function(s) { return s.text === 'SELECT'; }), 'R: SQL keywords not offered in r mode');

// ============================================================
// topSuggestion
// ============================================================
console.log('\ntopSuggestion');

const top = topSuggestion('pat', 'sql', entries);
ok(top !== null, 'topSuggestion: returns a result for "pat"');
ok(top.text === 'patients' || top.text.startsWith('pat'), 'topSuggestion: best match for "pat" is a patients-related token');
ok(typeof top.insertText === 'string', 'topSuggestion: insertText is string');

const topEmpty = topSuggestion('', 'sql', entries);
ok(topEmpty === null, 'topSuggestion: empty typed returns null');

const topNone = topSuggestion('zzzzzzzzz', 'sql', entries);
ok(topNone === null, 'topSuggestion: unmatched typed returns null');

// Python top suggestion
const topPy = topSuggestion('dataglow', 'python', entries);
ok(topPy !== null, 'topSuggestion Python: dataglow returns a result');
ok(topPy.text.includes('dataglow'), 'topSuggestion Python: result is dataglow-related');

// R top suggestion
const topR = topSuggestion('dataglow', 'r', entries);
ok(topR !== null, 'topSuggestion R: dataglow returns a result');

// ============================================================
// Edge cases
// ============================================================
console.log('\nEdge cases');

ok(getSuggestions(null, 'sql', entries).length === 0, 'null typed: no suggestions');
ok(getSuggestions('pat', null, entries).length >= 0, 'null language: does not throw');
ok(getSuggestions('pat', 'sql', null).length >= 0, 'null entries: does not throw');
ok(getSuggestions('pat', 'sql', []).length >= 0, 'empty entries: does not throw');

// Unknown language falls back gracefully
const unkLang = getSuggestions('pat', 'cobol', entries);
ok(Array.isArray(unkLang), 'unknown language: returns array');

// Deduplication — patient_id appears in both sql-origin patients AND r-origin vitals schemas
const dedup = getSuggestions('patient_id', 'sql', entries);
const count = dedup.filter(function(s) { return s.text === 'patient_id'; }).length;
eq(count, 1, 'deduplication: patient_id appears exactly once despite multiple schema sources');

// ============================================================
// Summary
// ============================================================
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
