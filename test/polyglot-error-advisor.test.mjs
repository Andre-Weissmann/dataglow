// ============================================================
// DATAGLOW — Polyglot Error Advisor (Batch E) tests
// ============================================================
// RUN: node test/polyglot-error-advisor.test.mjs

import { adviseError, renderAdvisedErrorHtml } from '../js/polyglot/polyglot-error-advisor.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 FAILED: ' + msg); }
}
function eq(a, b, msg) {
  ok(a === b, (msg || '') + ' (expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a) + ')');
}
function contains(str, sub, msg) {
  ok(typeof str === 'string' && str.includes(sub), (msg || '') + ' (expected to contain "' + sub + '", got "' + str + '")');
}

// Shared registry
const entries = [
  { name: 'patients', originLanguage: 'sql', kind: 'dataframe',
    schema: [{ name: 'patient_id', type: 'INTEGER' }], rowCount: 500, provenance: 'patients' },
  { name: 'py:claims', originLanguage: 'python', kind: 'dataframe',
    schema: [{ name: 'claim_id', type: 'VARCHAR' }], rowCount: 1200, provenance: 'claims' },
  { name: 'r:vitals', originLanguage: 'r', kind: 'dataframe',
    schema: [{ name: 'bp_systolic', type: 'INTEGER' }], rowCount: 800, provenance: 'vitals' },
];

// ============================================================
// adviseError — SQL
// ============================================================
console.log('\nadviseError — SQL');

// Basic error parsing (matches formatSqlError behaviour)
const sqlColErr = adviseError('Binder Error: Referenced column "los_days" not found in FROM clause.', 'sql', entries);
eq(sqlColErr.language, 'sql', 'SQL: language field correct');
eq(sqlColErr.kind, 'Binder Error', 'SQL: kind extracted');
ok(sqlColErr.hint.length > 0, 'SQL: hint present for column-not-found');
ok(typeof sqlColErr.raw === 'string', 'SQL: raw preserved');

const sqlSyntaxErr = adviseError('Parser Error: syntax error at or near "FORM"', 'sql', entries);
ok(sqlSyntaxErr.hint.includes('comma') || sqlSyntaxErr.hint.includes('keyword'), 'SQL: syntax error gets keyword hint');

const sqlTableErr = adviseError('Catalog Error: Table with name "Patientz" does not exist!', 'sql', entries);
ok(sqlTableErr.hint.length > 0, 'SQL: table-not-found hint present');

// Cross-registry: SQL references a Python-origin object by bare name
const sqlCrossErr = adviseError('Catalog Error: Table with name "claims" does not exist!', 'sql', entries);
ok(sqlCrossErr.suggestedFix.length > 0, 'SQL cross: suggestedFix non-empty for py-origin "claims"');
contains(sqlCrossErr.suggestedFix, 'py.claims', 'SQL cross: fix suggests FROM py.claims');

// Cross-registry: SQL references an R-origin object
const sqlCrossR = adviseError('Catalog Error: Table with name "vitals" does not exist!', 'sql', entries);
contains(sqlCrossR.suggestedFix, 'r.vitals', 'SQL cross: fix suggests FROM r.vitals');

// SQL references SQL-origin object — case mismatch
const sqlCase = adviseError('Catalog Error: Table with name "Patients" does not exist!', 'sql', entries);
ok(sqlCase.suggestedFix.includes('patients') || sqlCase.suggestedFix.includes('"patients"'), 'SQL case mismatch: suggests correct spelling');

// No registry hit — suggestedFix is empty
const sqlNoHit = adviseError('Catalog Error: Table with name "unregisteredXYZ" does not exist!', 'sql', entries);
eq(sqlNoHit.suggestedFix, '', 'SQL: no registry match → empty suggestedFix');

// ============================================================
// adviseError — Python
// ============================================================
console.log('\nadviseError — Python');

const pyName = adviseError("NameError: name 'patients' is not defined", 'python', entries);
eq(pyName.language, 'python', 'Python: language field correct');
eq(pyName.kind, 'NameError', 'Python: kind = NameError');
ok(pyName.hint.length > 0, 'Python: NameError gets hint');
// Cross: patients is SQL-origin → suggest dataglow.get_df
contains(pyName.suggestedFix, 'dataglow.get_df', 'Python cross: suggests dataglow.get_df for SQL table');
contains(pyName.suggestedFix, 'patients', 'Python cross: mentions the table name');

// Python KeyError for a column that exists in registry schema
const pyKey = adviseError("KeyError: 'claim_id'", 'python', entries);
eq(pyKey.kind, 'KeyError', 'Python: KeyError kind');
ok(pyKey.hint.length > 0, 'Python: KeyError hint present');

// Python cross: R-origin object referenced in Python
const pyCrossR = adviseError("NameError: name 'vitals' is not defined", 'python', entries);
contains(pyCrossR.suggestedFix, 'R', 'Python cross R: fix mentions R tab');

// Python AttributeError
const pyAttr = adviseError("AttributeError: 'DataFrame' object has no attribute 'groupBy'", 'python', entries);
ok(pyAttr.hint.includes('pandas') || pyAttr.hint.includes('method'), 'Python: AttributeError hint mentions pandas');

// Python import error
const pyImport = adviseError("ModuleNotFoundError: No module named 'tensorflow'", 'python', entries);
ok(pyImport.hint.includes('sandbox') || pyImport.hint.includes('pre-installed'), 'Python: import error hint');

// Multi-line traceback — last line wins
const pyMultiLine = 'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nNameError: name \'patients\' is not defined';
const pyMulti = adviseError(pyMultiLine, 'python', entries);
eq(pyMulti.kind, 'NameError', 'Python: multi-line traceback last line parsed');

// ============================================================
// adviseError — R
// ============================================================
console.log('\nadviseError — R');

const rErr = adviseError("Error in eval(substitute(expr), envir, enclos) : \n  object 'patients' not found", 'r', entries);
eq(rErr.language, 'r', 'R: language field correct');
ok(rErr.kind.includes('R'), 'R: kind starts with R');
ok(rErr.hint.length > 0, 'R: object-not-found hint present');
// Cross: patients is SQL-origin → suggest dataglow_get_df
contains(rErr.suggestedFix, 'dataglow_get_df', 'R cross: suggests dataglow_get_df for SQL table');
contains(rErr.suggestedFix, 'patients', 'R cross: mentions the table name');

// R function not found
const rFn = adviseError("Error in group_by(df) : could not find function \"group_by\"", 'r', entries);
ok(rFn.hint.includes('library'), 'R: function-not-found hint mentions library()');

// R cross: Python-origin referenced in R
const rCrossPy = adviseError("Error: object 'claims' not found", 'r', entries);
contains(rCrossPy.suggestedFix, 'Python', 'R cross py: fix mentions Python tab');

// R undefined columns
const rCol = adviseError("Error in `[.data.frame`(df, , 'bp') : undefined columns selected", 'r', entries);
ok(rCol.hint.includes('colnames') || rCol.hint.includes('column'), 'R: undefined column hint mentions colnames');

// R warning (non-fatal)
const rWarn = adviseError("Warning message:\nIn mean(x) : argument is not numeric or logical: returning NA", 'r', entries);
ok(rWarn.kind.includes('R'), 'R warning: kind set correctly');

// ============================================================
// renderAdvisedErrorHtml
// ============================================================
console.log('\nrenderAdvisedErrorHtml');

const html = renderAdvisedErrorHtml(sqlCrossErr);
ok(typeof html === 'string' && html.length > 0, 'renderAdvisedErrorHtml: returns non-empty string');
ok(html.includes('sql-error-kind'), 'renderAdvisedErrorHtml: contains kind element');
ok(html.includes('sql-error-detail'), 'renderAdvisedErrorHtml: contains detail element');
ok(html.includes('py.claims'), 'renderAdvisedErrorHtml: suggestedFix appears in HTML');
ok(html.includes('Suggested fix'), 'renderAdvisedErrorHtml: "Suggested fix" label present');
// XSS safety — < > & are escaped
const xssAdv = adviseError('Error: <script>alert("xss")</script>', 'sql', []);
const xssHtml = renderAdvisedErrorHtml(xssAdv);
ok(!xssHtml.includes('<script>'), 'renderAdvisedErrorHtml: script tag escaped (XSS safe)');
ok(xssHtml.includes('&lt;script&gt;'), 'renderAdvisedErrorHtml: & and < are HTML-escaped');

// No suggestedFix → no "Suggested fix" section
const htmlNoFix = renderAdvisedErrorHtml(sqlNoHit);
ok(!htmlNoFix.includes('Suggested fix'), 'renderAdvisedErrorHtml: no fix section when suggestedFix is empty');

// ============================================================
// Edge cases
// ============================================================
console.log('\nEdge cases');

const nullErr = adviseError(null, 'sql', entries);
ok(typeof nullErr.kind === 'string', 'null error: does not throw');

const emptyErr = adviseError('', 'python', entries);
ok(typeof emptyErr.kind === 'string', 'empty error: does not throw');

const noEntries = adviseError('NameError: name \'patients\' is not defined', 'python', null);
ok(noEntries.suggestedFix === '', 'null entries: suggestedFix is empty (no fabrication)');

const emptyEntries = adviseError('NameError: name \'patients\' is not defined', 'python', []);
ok(emptyEntries.suggestedFix === '', 'empty entries: suggestedFix is empty');

const unknownLang = adviseError('Some Error: xyz not found', 'cobol', entries);
ok(typeof unknownLang.kind === 'string', 'unknown language: does not throw');

// ============================================================
// Summary
// ============================================================
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
