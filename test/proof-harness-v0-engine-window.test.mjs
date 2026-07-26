// ============================================================
// DATAGLOW - Proof Harness v0 (VERDICT): engine-window hotfix test
// ============================================================
// Regression test for the hotfix on branch
// feat/proof-harness-v0-engine-window (main was at 803f416).
//
// The live prove bug: window.resolveDrillSqlRunQuery was never assigned in
// canvas/index.html -- it existed only as a canvas-scope function -- so the
// Proof Harness canvas UI's resolveRunQuery() (which looks for
// window.resolveDrillSqlRunQuery first, before window.engine) could never
// find it, and Prove could not reach the live DuckDB engine until something
// else happened to warm window.engine some other way.
//
// This file is deliberately static-source + pure-engine checks (no jsdom/
// browser dependency, matching test/proof-harness-v0.test.mjs's Node-only
// discipline):
//   1. canvas/index.html now assigns window.resolveDrillSqlRunQuery right
//      after the function it names is defined.
//   2. js/proof-harness/data-glow-proof-harness-canvas.js still resolves
//      window.resolveDrillSqlRunQuery first (unchanged contract), and now
//      tracks an engine-missing note so a no-engine Prove is visibly
//      GRAY-friendly, not just silently thrown away.
//   3. The pure engine (already covered end-to-end in proof-harness-v0.test.
//      mjs) really does complete a full cycle -- never throws -- when handed
//      a throwing runQuery, which is exactly what onProve() falls back to
//      when resolveRunQuery() returns null. Re-asserted here, scoped to this
//      hotfix, so this file stands on its own as the hotfix's regression
//      test.
//
// RUN WITH: node --test test/proof-harness-v0-engine-window.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runProofCycle, resetReceipts, getReceipts } from '../js/proof-harness/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

// ---------- canvas/index.html: window.resolveDrillSqlRunQuery is assigned ----------
{
  const canvas = readFileSync(join(repoRoot, 'canvas', 'index.html'), 'utf8');

  const fnIdx = canvas.indexOf('function resolveDrillSqlRunQuery()');
  ok(fnIdx !== -1, 'canvas/index.html still defines function resolveDrillSqlRunQuery()');

  const assignIdx = canvas.indexOf('window.resolveDrillSqlRunQuery = resolveDrillSqlRunQuery;');
  ok(assignIdx !== -1, 'canvas/index.html assigns window.resolveDrillSqlRunQuery = resolveDrillSqlRunQuery');
  ok(assignIdx > fnIdx, 'the window assignment comes after the function definition, so it is not a forward reference');

  // The function body itself ends with "return null;\n}" right before the
  // ensureDrillTablesLoaded comment block; the assignment must land between
  // the function's closing brace and the next function definition, not
  // buried inside another function.
  const nextFnIdx = canvas.indexOf('function ensureDrillTablesLoaded(');
  ok(assignIdx < nextFnIdx, 'the window assignment for resolveDrillSqlRunQuery lands before ensureDrillTablesLoaded is defined');

  const ensureAssignIdx = canvas.indexOf('window.ensureDrillTablesLoaded = ensureDrillTablesLoaded;');
  ok(ensureAssignIdx !== -1, 'canvas/index.html also assigns window.ensureDrillTablesLoaded = ensureDrillTablesLoaded (same peer pattern)');
  ok(ensureAssignIdx > nextFnIdx, 'the ensureDrillTablesLoaded window assignment comes after its function definition');
}

// ---------- js/proof-harness canvas UI source: resolution order + GRAY note ----------
{
  const uiSrc = readFileSync(join(repoRoot, 'js', 'proof-harness', 'data-glow-proof-harness-canvas.js'), 'utf8');

  const resolveIdx = uiSrc.indexOf("typeof window.resolveDrillSqlRunQuery === 'function'");
  ok(resolveIdx !== -1, 'the canvas UI still checks window.resolveDrillSqlRunQuery first, matching Drill Floor\u2019s SQL Run/Check resolver order');

  const engineFallbackIdx = uiSrc.indexOf('window.engine && typeof window.engine.runQuery');
  ok(engineFallbackIdx > resolveIdx, 'window.engine is only tried as a fallback, after window.resolveDrillSqlRunQuery');

  ok(uiSrc.includes('_lastEngineMissing'), 'the canvas UI now tracks an engine-missing flag for the last Prove click');
  ok(uiSrc.includes("toast('SQL engine not ready in this canvas.'"), 'the toast on a missing engine is preserved (existing behavior kept)');
  ok(uiSrc.includes('dg-ph-engine-missing'), 'a dedicated GRAY-styled note class is rendered when the engine was missing for the last Prove');
  ok(uiSrc.includes('if (_lastEngineMissing)'), 'the GRAY note is conditional on the engine having actually been missing, not always shown');

  // The onProve function must still fall back to a throwing runQuery so
  // runProofCycle completes a cycle instead of onProve bailing out early.
  const onProveIdx = uiSrc.indexOf('async function onProve(');
  const onProveBody = uiSrc.slice(onProveIdx, uiSrc.indexOf('async function onConfirm('));
  ok(onProveBody.includes("runQuery || function () { throw new Error('SQL engine not ready in this canvas.'); }"),
    'onProve still hands runProofCycle a throwing stand-in when no engine is reachable, so the cycle completes instead of bailing out early');
}

// ---------- pure engine: a missing-engine cycle really completes (never throws) ----------
{
  resetReceipts();
  const noEngineRunQuery = function () { throw new Error('SQL engine not ready in this canvas.'); };
  const cycle = await runProofCycle({
    claimText: 'revenue is 100',
    statement: 'select 100 as revenue',
    engine: 'duckdb',
    expected: { rowCount: 1 },
    runQuery: noEngineRunQuery,
  });
  ok(cycle.ok === true, 'runProofCycle completes a full cycle even when runQuery always throws (engine not warmed yet)');
  ok(cycle.verdict !== null && ['GREEN', 'RED', 'GRAY'].includes(cycle.verdict.state),
    'the cycle reaches a real verdict state, never an unhandled exception');
  ok(cycle.verdict.state !== 'GREEN', 'a cycle that could not run the statement is never reported GREEN');
  ok(cycle.receipt && typeof cycle.receipt.hash === 'string', 'a receipt is still appended for the missing-engine cycle, so it is auditable like any other Prove click');
  ok(getReceipts().length === 1, 'the missing-engine cycle is recorded in the session receipt ledger');
  resetReceipts();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
