// ============================================================
// DATAGLOW — Formula Bridge test suite
// ============================================================
// Covers js/grid/formula-bridge.js:
//   • FORMULA_SQL_MAP        — 15+ formula entries
//   • isFormulaSupported     — case-insensitivity, bad input handling
//   • getFormulaSQL          — column substitution, conditional aggregates
//   • buildFormulaAudit      — column-level formula summary
//   • validateFormulaResult  — health-score cross-check heuristics
//
// No Univer import, no DOM — plain Node.
//
// RUN WITH:  node test/grid/formula-bridge.test.js

import {
  FORMULA_SQL_MAP,
  isFormulaSupported,
  getFormulaSQL,
  buildFormulaAudit,
  validateFormulaResult,
} from '../../js/grid/formula-bridge.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ============================================================
// FORMULA_SQL_MAP
// ============================================================
(function testFormulaSqlMap() {
  const keys = Object.keys(FORMULA_SQL_MAP);
  ok(keys.length >= 15, `FORMULA_SQL_MAP: has at least 15 entries (found ${keys.length})`);
  ok(FORMULA_SQL_MAP.SUM === 'SUM({col})', 'FORMULA_SQL_MAP: SUM maps to SUM({col})');
  ok(FORMULA_SQL_MAP.AVERAGE === 'AVG({col})', 'FORMULA_SQL_MAP: AVERAGE maps to AVG({col})');
  ok(FORMULA_SQL_MAP.COUNTIF.includes('FILTER'), 'FORMULA_SQL_MAP: COUNTIF uses a FILTER clause');
  ok(FORMULA_SQL_MAP.MEDIAN.includes('PERCENTILE_CONT'), 'FORMULA_SQL_MAP: MEDIAN maps to PERCENTILE_CONT');
  ok(Object.isFrozen(FORMULA_SQL_MAP), 'FORMULA_SQL_MAP: is frozen (immutable contract)');
})();

// ============================================================
// isFormulaSupported
// ============================================================
(function testIsFormulaSupported() {
  ok(isFormulaSupported('SUM') === true, 'isFormulaSupported: SUM is supported');
  ok(isFormulaSupported('sum') === true, 'isFormulaSupported: lowercase "sum" is supported (case-insensitive)');
  ok(isFormulaSupported('  AVERAGE  ') === true, 'isFormulaSupported: whitespace is trimmed');
  ok(isFormulaSupported('VLOOKUP') === false, 'isFormulaSupported: VLOOKUP is not in the SQL map, returns false');
  ok(isFormulaSupported('') === false, 'isFormulaSupported: empty string returns false without throwing');
  ok(isFormulaSupported(null) === false, 'isFormulaSupported: null returns false without throwing');
  ok(isFormulaSupported(undefined) === false, 'isFormulaSupported: undefined returns false without throwing');
  ok(isFormulaSupported(42) === false, 'isFormulaSupported: non-string input returns false without throwing');
})();

// ============================================================
// getFormulaSQL
// ============================================================
(function testGetFormulaSQL() {
  ok(getFormulaSQL('SUM', 'amount') === 'SUM("amount")', 'getFormulaSQL: SUM substitutes quoted column name');
  ok(getFormulaSQL('AVERAGE', 'score') === 'AVG("score")', 'getFormulaSQL: AVERAGE substitutes quoted column name');
  ok(getFormulaSQL('sum', 'amount') === 'SUM("amount")', 'getFormulaSQL: case-insensitive formula name lookup');
  ok(getFormulaSQL('VLOOKUP', 'amount') === null, 'getFormulaSQL: unsupported formula returns null');
  ok(getFormulaSQL('SUM', '') === null, 'getFormulaSQL: empty column name returns null');
  ok(getFormulaSQL('SUM', null) === null, 'getFormulaSQL: null column name returns null');

  const countif = getFormulaSQL('COUNTIF', 'status', { op: '=', val: 'denied' });
  ok(countif === `COUNT(*) FILTER (WHERE "status" = 'denied')`, 'getFormulaSQL: COUNTIF fills op and quoted string val');

  const countifNum = getFormulaSQL('COUNTIF', 'amount', { op: '>', val: 100 });
  ok(countifNum === 'COUNT(*) FILTER (WHERE "amount" > 100)', 'getFormulaSQL: COUNTIF with numeric val is not quoted');

  const countifDefault = getFormulaSQL('COUNTIF', 'amount');
  ok(countifDefault === `COUNT(*) FILTER (WHERE "amount" = NULL)`, 'getFormulaSQL: COUNTIF defaults op to "=" and val to NULL when options omitted');

  const identWithQuote = getFormulaSQL('SUM', 'weird"col');
  ok(identWithQuote === 'SUM("weird""col")', 'getFormulaSQL: column names with embedded quotes are escaped per DuckDB convention');

  const sumif = getFormulaSQL('SUMIF', 'amount', { op: '>', val: 0 });
  ok(sumif === 'SUM("amount") FILTER (WHERE "amount" > 0)', 'getFormulaSQL: SUMIF fills op/val correctly');

  ok(getFormulaSQL('MAX', 'amount') === 'MAX("amount")', 'getFormulaSQL: MAX substitutes quoted column name');
  ok(getFormulaSQL('MIN', 'amount') === 'MIN("amount")', 'getFormulaSQL: MIN substitutes quoted column name');
  ok(getFormulaSQL('STDEV', 'amount') === 'STDDEV("amount")', 'getFormulaSQL: STDEV substitutes quoted column name');
})();

// ============================================================
// buildFormulaAudit
// ============================================================
(function testBuildFormulaAudit() {
  const formulaCells = [
    { cellRef: 'B1', formulaName: 'SUM', columnName: 'amount', result: 450 },
    { cellRef: 'B2', formulaName: 'AVERAGE', columnName: 'amount', result: 90 },
    { cellRef: 'B3', formulaName: 'VLOOKUP', columnName: 'amount', result: 'x' },
    { cellRef: 'B4', formulaName: 'sum', columnName: 'quantity', result: 10 },
  ];
  const audit = buildFormulaAudit(formulaCells);

  ok(audit.supportedCount === 3, 'buildFormulaAudit: counts SUM, AVERAGE, sum(lowercase) as supported = 3');
  ok(audit.unsupportedCount === 1, 'buildFormulaAudit: counts VLOOKUP as unsupported = 1');
  ok(audit.formulasByType.SUM === 2, 'buildFormulaAudit: formulasByType groups case-insensitively (SUM + sum = 2)');
  ok(audit.formulasByType.AVERAGE === 1, 'buildFormulaAudit: formulasByType.AVERAGE = 1');
  ok(audit.formulasByType.VLOOKUP === 1, 'buildFormulaAudit: formulasByType.VLOOKUP = 1 even though unsupported');
  ok(audit.sqlEquivalents.length === 3, 'buildFormulaAudit: sqlEquivalents only includes supported formulas');
  ok(audit.sqlEquivalents.includes('SUM("amount")'), 'buildFormulaAudit: sqlEquivalents contains SUM("amount")');

  const emptyAudit = buildFormulaAudit([]);
  ok(emptyAudit.supportedCount === 0 && emptyAudit.unsupportedCount === 0, 'buildFormulaAudit: empty input produces zero counts');

  const undefinedAudit = buildFormulaAudit(undefined);
  ok(undefinedAudit.supportedCount === 0, 'buildFormulaAudit: undefined input does not throw');
})();

// ============================================================
// validateFormulaResult
// ============================================================
(function testValidateFormulaResult() {
  const r1 = validateFormulaResult('SUM', 450, 0.95);
  ok(r1.consistent === true, 'validateFormulaResult: healthy column (>= 0.8) is always consistent');
  ok(r1.warning === null, 'validateFormulaResult: healthy column has no warning');

  const r2 = validateFormulaResult('SUM', 0, 0.3);
  ok(r2.consistent === false, 'validateFormulaResult: SUM=0 on a low-health column is flagged inconsistent');
  ok(typeof r2.warning === 'string' && r2.warning.length > 0, 'validateFormulaResult: inconsistent result carries a warning string');

  const r3 = validateFormulaResult('SUM', 450, 0.3);
  ok(r3.consistent === true, 'validateFormulaResult: non-zero SUM on low-health column is still consistent');

  const r4 = validateFormulaResult('COUNT', 5, 0.3);
  ok(r4.consistent === false, 'validateFormulaResult: COUNT on a very low-health column (<0.5) is flagged');

  const r5 = validateFormulaResult('COUNT', 5, 0.7);
  ok(r5.consistent === true, 'validateFormulaResult: COUNT on a moderately healthy column (0.5-0.8) is not flagged by the count heuristic');

  const r6 = validateFormulaResult('AVERAGE', null, 0.2);
  ok(r6.consistent === false, 'validateFormulaResult: null AVERAGE result on low-health column is flagged');

  const r7 = validateFormulaResult('MAX', 100, 1.0);
  ok(r7.consistent === true, 'validateFormulaResult: perfect health column is always consistent regardless of result');
})();

// ============================================================
// summary
// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
