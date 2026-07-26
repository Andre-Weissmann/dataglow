// ============================================================
// DATAGLOW - Hotfix: Proof Harness primary run scalars + BigInt coercion
// ============================================================
// Live-proven bug (after #622): window.runProofSecondEngine(
// 'SELECT COUNT(*) AS n FROM claims_example') correctly returns engine
// pyodide-pandas, n=10, tablesRegistered claims_example. But
// runProofCycle({..., expected:{rowCount:1, scalars:{n:10}}}) returned RED:
//   - primary run.scalars was ALWAYS {} (index.js's runProofCycle built
//     `run = {..., scalars: {}, ...}` and never read the first result row
//     at all -- see the module's HOTFIX header comment for the full trace)
//   - the second engine's n:10 had nothing on primary.scalars to compare
//     against, so corroborateRun's `details` only ever carried the SECOND
//     engine's value for field "n", never the primary's, and agrees:false
//   - DuckDB-WASM returns BigInt (e.g. 10n) for COUNT(*)-style aggregates;
//     an uncoerced BigInt fails every `typeof x === 'number'` check in
//     scalarMatches/valuesAgree and falls through to strict `===`, where
//     10n !== 10, which independently breaks the comparison even once
//     scalars are actually being extracted.
//
// This file proves:
//   1. runProofCycle's primary run.scalars is populated from the first
//      result row (object-row shape: {columns:['n'], rows:[{n:10n}]}) with
//      BigInt coerced to Number, and the whole cycle reaches GREEN with a
//      second engine agreeing n:10.
//   2. Same, for the array-row + columns shape: rows:[[10n]].
//   3. corroborateRun's defense-in-depth fallback: even if primaryRun.scalars
//      is (still) empty, it recovers the scalar from primaryRun.result and
//      agrees correctly with a BigInt-bearing second engine.
//   4. score-claim.js's extractScalar/scalarMatches/extractRowCount coerce
//      BigInt directly (unit-level, pure-module regression guard).
//   5. cartridge.js's importCartridgeCore also extracts+coerces scalars on
//      its own re-run path (same pattern bug, same fix).
//
// RUN WITH: node test/hotfix-ph-primary-scalars-bigint.test.mjs

import {
  runProofCycle,
  resetReceipts,
  resetVault,
  extractRunScalars,
  coerceBigInt,
} from '../js/proof-harness/index.js';
import { corroborateRun } from '../js/proof-harness/second-engine.js';
import { scalarMatches, extractScalar, extractRowCount, compareClaimToRun } from '../js/proof-harness/score-claim.js';
import { exportCartridgeCore, importCartridgeCore } from '../js/proof-harness/cartridge.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

// ---------------------------------------------------------------
// 0. Pure helper unit checks: coerceBigInt / extractRunScalars (index.js)
// ---------------------------------------------------------------
ok(coerceBigInt(10n) === 10, 'coerceBigInt turns a BigInt into an equal-valued Number');
ok(coerceBigInt(10) === 10, 'coerceBigInt passes a plain Number through unchanged');
ok(coerceBigInt('10') === '10', 'coerceBigInt passes a non-BigInt (string) through unchanged');
ok(typeof coerceBigInt(10n) === 'number', 'coerceBigInt output is typeof number, not bigint');

{
  const { rowCount, scalars } = extractRunScalars({ columns: ['n'], rows: [{ n: 10n }] });
  ok(rowCount === 1, 'extractRunScalars: object-row shape infers rowCount 1 from rows.length');
  ok(scalars.n === 10 && typeof scalars.n === 'number', 'extractRunScalars: object-row shape extracts n=10 (Number) from a BigInt cell');
}
{
  const { rowCount, scalars } = extractRunScalars({ columns: ['n'], rows: [[10n]] });
  ok(rowCount === 1, 'extractRunScalars: array-row shape infers rowCount 1 from rows.length');
  ok(scalars.n === 10 && typeof scalars.n === 'number', 'extractRunScalars: array-row + columns shape maps position 0 to column "n" and coerces BigInt');
}
{
  // Explicit rowCount always wins over rows.length (matches
  // normalizeSecondRun's existing precedence in second-engine.js).
  const { rowCount } = extractRunScalars({ rowCount: 50n, rows: [{ n: 1 }] });
  ok(rowCount === 50, 'extractRunScalars: an explicit BigInt result.rowCount wins over rows.length, and is coerced to Number');
}
{
  const { rowCount, scalars } = extractRunScalars(null);
  ok(rowCount === null && Object.keys(scalars).length === 0, 'extractRunScalars never throws on a null result, returns null rowCount and empty scalars');
}

// ---------------------------------------------------------------
// 1. runProofCycle end to end: object-row {columns:['n'], rows:[{n:10n}]}
//    primary result, mock second engine agreeing n:10 -> GREEN
// ---------------------------------------------------------------
async function runLiveProveRecipe(primaryResult, label) {
  resetReceipts();
  resetVault();
  const cycle = await runProofCycle({
    statement: 'SELECT COUNT(*) AS n FROM claims_example',
    engine: 'duckdb',
    expected: { rowCount: 1, scalars: { n: 10 } },
    tables: ['claims_example'],
    claimText: 'claims_example has exactly 10 rows',
    runQuery: async () => primaryResult,
    runSecondEngine: async () => ({
      rowCount: 1,
      rows: [{ n: 10 }],
      scalars: { n: 10 },
      engine: 'pyodide-pandas',
      tablesRegistered: ['claims_example'],
    }),
    secondEngineName: 'pyodide-pandas',
  });

  ok(cycle.run && cycle.run.status === 'ok', `[${label}] the primary run completed ok`);
  ok(cycle.run && cycle.run.rowCount === 1, `[${label}] the primary run.rowCount is 1 (coerced to Number)`);
  ok(cycle.run && cycle.run.scalars && cycle.run.scalars.n === 10, `[${label}] the primary run.scalars.n is 10 -- NOT the always-{} bug`);
  ok(typeof (cycle.run && cycle.run.scalars && cycle.run.scalars.n) === 'number', `[${label}] the primary run.scalars.n is typeof number, not bigint`);
  ok(cycle.comparison && cycle.comparison.pass === true, `[${label}] compareClaimToRun passes against the primary run's extracted scalars`);
  ok(cycle.corroboration && cycle.corroboration.ran === true, `[${label}] the second engine actually ran`);
  ok(cycle.corroboration && cycle.corroboration.agrees === true, `[${label}] corroboration agrees (both engines report n:10)`);
  const nField = cycle.corroboration && cycle.corroboration.details.find((d) => d.field === 'n');
  ok(nField && nField.primary === 10, `[${label}] corroboration details field "n" now carries the PRIMARY's value too (10), not just the second engine's`);
  ok(nField && nField.second === 10, `[${label}] corroboration details field "n" second value is 10`);
  ok(cycle.verdict && cycle.verdict.state === 'GREEN', `[${label}] the full cycle reaches GREEN (this was RED before the fix)`);
  return cycle;
}

await runLiveProveRecipe({ columns: ['n'], rows: [{ n: 10n }] }, 'object-row BigInt');
await runLiveProveRecipe({ columns: ['n'], rows: [[10n]] }, 'array-row + columns BigInt');

// ---------------------------------------------------------------
// 2. corroborateRun defense-in-depth: primary.scalars empty, but
//    primary.result carries the row -> corroborateRun still recovers it.
// ---------------------------------------------------------------
{
  const primaryRun = {
    rowCount: 1,
    scalars: {}, // deliberately empty, simulating an uninstrumented/older primary path
    result: { columns: ['n'], rows: [{ n: 10n }] },
  };
  const corroboration = corroborateRun({
    primaryRun,
    secondRun: { rowCount: 1, scalars: { n: 10 }, engine: 'pyodide-pandas' },
    secondEngineName: 'pyodide-pandas',
    expected: { scalars: { n: 10 } },
  });
  ok(corroboration.ran === true, 'corroborateRun defense-in-depth: second engine ran');
  ok(corroboration.agrees === true, 'corroborateRun defense-in-depth: recovers n from primary.result when primary.scalars is empty, and agrees with the second engine');
  const nField = corroboration.details.find((d) => d.field === 'n');
  ok(nField && nField.primary === 10, 'corroborateRun defense-in-depth: the recovered primary value is 10 (Number, coerced)');
}

// BigInt on the SECOND engine's side too (e.g. its own duckdb-in-pyodide path).
{
  const primaryRun = { rowCount: 1, scalars: { n: 10 } };
  const corroboration = corroborateRun({
    primaryRun,
    secondRun: { rowCount: 1n, scalars: { n: 10n }, engine: 'pyodide-duckdb' },
    secondEngineName: 'pyodide-duckdb',
    expected: { scalars: { n: 10 } },
  });
  ok(corroboration.agrees === true, 'corroborateRun: a BigInt rowCount/scalar on the SECOND engine side still agrees with the primary Number');
}

// Regression guard: a genuine disagreement is still RED, not masked by coercion.
{
  const primaryRun = { rowCount: 1, scalars: { n: 10 } };
  const corroboration = corroborateRun({
    primaryRun,
    secondRun: { rowCount: 1, scalars: { n: 999n }, engine: 'pyodide-pandas' },
    secondEngineName: 'pyodide-pandas',
    expected: { scalars: { n: 10 } },
  });
  ok(corroboration.agrees === false, 'corroborateRun: a genuine BigInt-vs-Number VALUE mismatch (10 vs 999n) still disagrees -- coercion never masks a real disagreement');
}

// ---------------------------------------------------------------
// 3. score-claim.js pure-module regression guards
// ---------------------------------------------------------------
ok(scalarMatches(10, 10n) === true, 'scalarMatches: expected Number 10 matches observed BigInt 10n');
ok(scalarMatches(10n, 10) === true, 'scalarMatches: expected BigInt 10n matches observed Number 10');
ok(scalarMatches(10, 11n) === false, 'scalarMatches: a genuine mismatch (10 vs 11n) is still false');

ok(extractRowCount({ rowCount: 7n }) === 7, 'extractRowCount coerces a BigInt result.rowCount to Number 7');
ok(extractScalar({ columns: ['n'], rows: [{ n: 10n }] }, 'n') === 10, 'extractScalar coerces a BigInt object-row cell to Number');
ok(extractScalar({ columns: ['n'], rows: [[10n]] }, 'n') === 10, 'extractScalar coerces a BigInt array-row cell to Number');

{
  const comparison = compareClaimToRun({ rowCount: 1, scalars: { n: 10 } }, { rowCount: 1n, scalars: { n: 10n } });
  ok(comparison.pass === true, 'compareClaimToRun: an all-BigInt observed run still passes against Number-typed expectations');
}

// ---------------------------------------------------------------
// 4. cartridge.js importCartridgeCore: same extraction+coercion on its own
//    independent re-run path.
// ---------------------------------------------------------------
{
  const proposal = {
    statement: 'SELECT COUNT(*) AS n FROM claims_example',
    engine: 'duckdb',
    expected: { rowCount: 1, scalars: { n: 10 } },
    tables: ['claims_example'],
    claimText: 'claims_example has exactly 10 rows',
    digest: 'test-digest-bigint-cartridge',
  };
  const verdict = { state: 'GREEN', reasonCode: 'match' };
  const exported = await exportCartridgeCore({ proposal, verdict, run: { rowCount: 1 } });
  ok(exported.rejected === false, 'exportCartridgeCore succeeds for a GREEN result (setup for the cartridge re-run test)');

  const imported = await importCartridgeCore({
    cartridgeText: exported,
    runQuery: async () => ({ columns: ['n'], rows: [{ n: 10n }] }),
    compareClaimToRun,
  });
  ok(imported.ok === true && imported.state === 'GREEN', 'importCartridgeCore: re-running the cartridge against a BigInt-bearing result still reaches GREEN');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
