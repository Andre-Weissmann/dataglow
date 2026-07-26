// ============================================================
// DATAGLOW - Proof Harness v1.1 second-engine bridge unit tests
// ============================================================
// js/proof-harness/data-glow-proof-harness-canvas.js is a plain browser
// script (DOM + window.DataGlowPython + Pyodide), not an ES module, so it
// cannot be imported directly in a Node test the way the pure proof-harness
// modules are. Rather than reimplementing evalTrivialLiteralSelect()'s
// regex logic here (which would test a copy, not the shipped code), this
// file extracts the ACTUAL function source out of the real file with a
// narrow, well-anchored regex and evaluates it in an isolated Function
// scope. If the source function's name, signature, or body markers ever
// drift, extraction fails loudly (via the assertion below) rather than
// silently testing stale logic.
//
// Covers PROOF_HARNESS_V1_1_SPEC.md pillar B2/B3's Fallback A contract:
// trivial literal SELECT probes are evaluated honestly, and anything else
// is refused (returns null) rather than guessed at.
//
// RUN WITH: node test/proof-harness-v1-1-bridge.test.mjs

import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

const canvasModuleSrc = readFileSync(new URL('../js/proof-harness/data-glow-proof-harness-canvas.js', import.meta.url), 'utf8');

// Extract the evalTrivialLiteralSelect function body verbatim by matching
// from its declaration to the closing brace of the function (the function
// is short and flat, so a brace-depth walk from the opening `{` is exact).
const startMarker = 'function evalTrivialLiteralSelect(statement) {';
const startIdx = canvasModuleSrc.indexOf(startMarker);
ok(startIdx !== -1, 'evalTrivialLiteralSelect(statement) is present verbatim in the shipped canvas module source');

let fnSrc = null;
if (startIdx !== -1) {
  let depth = 0;
  let i = startIdx + startMarker.length - 1; // at the opening brace
  let endIdx = -1;
  for (; i < canvasModuleSrc.length; i++) {
    if (canvasModuleSrc[i] === '{') depth++;
    else if (canvasModuleSrc[i] === '}') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }
  ok(endIdx !== -1, 'the extracted function body has a matching closing brace (brace-depth walk terminated cleanly)');
  fnSrc = canvasModuleSrc.slice(startIdx, endIdx);
}

// Build a real, callable function from the extracted source (not a
// reimplementation) via the Function constructor, matching how the source
// itself declares it (a plain `function name(args) { ... }` statement, so
// wrapping it in `return evalTrivialLiteralSelect;` after evaluating it
// hands back a callable reference to the exact shipped logic).
let evalTrivialLiteralSelect = null;
if (fnSrc) {
  // eslint-disable-next-line no-new-func
  evalTrivialLiteralSelect = new Function(`${fnSrc}\nreturn evalTrivialLiteralSelect;`)();
  ok(typeof evalTrivialLiteralSelect === 'function', 'the extracted source evaluates to a callable function');
}

if (evalTrivialLiteralSelect) {
  // ---------- Recognized trivial literal probes ----------
  const selectOne = evalTrivialLiteralSelect('SELECT 1');
  ok(selectOne && selectOne.rowCount === 1, 'SELECT 1 is recognized as a trivial literal probe with rowCount 1');
  ok(selectOne && selectOne.scalars && selectOne.scalars.col === 1, 'SELECT 1 reports the literal value 1 under a default alias');
  ok(selectOne && selectOne.engine === 'pyodide-literal', 'a trivial literal probe result is tagged engine: pyodide-literal');

  const selectAliased = evalTrivialLiteralSelect('select 42 as n');
  ok(selectAliased && selectAliased.scalars && selectAliased.scalars.n === 42, 'SELECT 42 AS n uses the given alias for the scalar');
  ok(selectAliased && selectAliased.rowCount === 1, 'an aliased literal probe still reports rowCount 1');

  const selectNegative = evalTrivialLiteralSelect('SELECT -7');
  ok(selectNegative && selectNegative.scalars.col === -7, 'a negative literal (SELECT -7) is evaluated correctly');

  const selectDecimal = evalTrivialLiteralSelect('SELECT 3.5 AS x');
  ok(selectDecimal && selectDecimal.scalars.x === 3.5, 'a decimal literal (SELECT 3.5 AS x) is evaluated correctly');

  const selectTrailingSemicolon = evalTrivialLiteralSelect('SELECT 1;');
  ok(selectTrailingSemicolon && selectTrailingSemicolon.rowCount === 1, 'a trailing semicolon does not prevent recognition of a trivial literal probe');

  const selectWhitespace = evalTrivialLiteralSelect('   select   1   ');
  ok(selectWhitespace && selectWhitespace.rowCount === 1, 'surrounding whitespace does not prevent recognition of a trivial literal probe');

  // ---------- Honest refusal (null) for anything non-trivial ----------
  ok(evalTrivialLiteralSelect('select count(*) from real_table') === null, 'a real table query is refused (returns null), never guessed at');
  ok(evalTrivialLiteralSelect('select * from t where x = 1') === null, 'a WHERE-clause query is refused, never guessed at');
  ok(evalTrivialLiteralSelect('select 1, 2') === null, 'a multi-value SELECT (comma present) is refused, not partially evaluated');
  ok(evalTrivialLiteralSelect('select count(1)') === null, 'a function-call expression is refused, never evaluated as a bare literal');
  ok(evalTrivialLiteralSelect('insert into t values (1)') === null, 'a non-SELECT statement is refused outright');
  ok(evalTrivialLiteralSelect('') === null, 'an empty statement is refused, never throws');
  ok(evalTrivialLiteralSelect(null) === null, 'a null statement is refused, never throws');
  ok(evalTrivialLiteralSelect(undefined) === null, 'an undefined statement is refused, never throws');
  ok(evalTrivialLiteralSelect('select true') === null, 'a non-numeric literal (SELECT true) is refused rather than guessed at');
}

// ---------- Confirm the bridge's honest not-available contract by source
// inspection: the shipped runProofSecondEngineBridge must return
// {error:'pyodide-sql-unavailable'} on every path where it cannot actually
// answer, never inventing a {rowCount} for a statement it did not run. ----
{
  ok(canvasModuleSrc.includes("{ error: 'pyodide-sql-unavailable' }"), 'the shipped bridge source contains the documented honest-refusal error shape');
  const bridgeStart = canvasModuleSrc.indexOf('async function runProofSecondEngineBridge(statement) {');
  ok(bridgeStart !== -1, 'runProofSecondEngineBridge(statement) is present verbatim in the shipped canvas module source');
  if (bridgeStart !== -1) {
    const bridgeEndMarker = 'function installSecondEngineBridge() {';
    const bridgeEndIdx = canvasModuleSrc.indexOf(bridgeEndMarker, bridgeStart);
    ok(bridgeEndIdx !== -1 && bridgeEndIdx > bridgeStart, 'installSecondEngineBridge() follows runProofSecondEngineBridge() in source order (both present)');
    const bridgeSrc = canvasModuleSrc.slice(bridgeStart, bridgeEndIdx);
    const errorOccurrences = (bridgeSrc.match(/pyodide-sql-unavailable/g) || []).length;
    ok(errorOccurrences >= 3, 'runProofSecondEngineBridge has an honest not-available fallback on every branch (no-DataGlowPython, duckdb-run-failed, duckdb-unavailable), not just a single catch-all');
    ok(!/return\s*\{\s*rowCount:\s*\d/.test(bridgeSrc), 'runProofSecondEngineBridge never returns a hardcoded/fabricated rowCount literal from its own body (all real rowCounts come from evalTrivialLiteralSelect or the live duckdb run)');
  }
  ok(canvasModuleSrc.includes('window.runProofSecondEngine = runProofSecondEngineBridge'), 'installSecondEngineBridge publishes the bridge as window.runProofSecondEngine, matching resolveSecondEngine\'s expected global');
  ok(canvasModuleSrc.includes("if (typeof window.runProofSecondEngine === 'function') return;"), 'installSecondEngineBridge is idempotent -- it never overwrites an already-installed bridge');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
