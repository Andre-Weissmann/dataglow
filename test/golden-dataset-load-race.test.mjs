// ============================================================
// DATAGLOW — Golden-dataset double-load race regression test
// ============================================================
// A fast double-click (or any concurrent trigger) on "Load Golden Test Dataset"
// fired two concurrent DATASET_ACTIONS.golden() calls that both raced through
// ensureDuckDB() -> loaders.loadGoldenDataset() -> engine.createTableFromRows(),
// whose DROP TABLE IF EXISTS + CREATE TABLE pair could interleave and throw
// "Catalog Error: Table ... already exists". The fix is a minimal module-level
// in-flight guard in runDatasetLoad() (js/app-shell/main.js): a second call
// while one load is still running is a safe no-op; a finally resets the guard so
// the Retry button (a fresh call after this one settles) still works.
//
// runDatasetLoad is a module-internal function of main.js (not exported, and
// main.js can't be imported headless — it boots DuckDB/Plotly), so this mirrors
// the drift-proofing approach test/command-deck-nav.test.mjs and
// test/diplomacy-tab-gating.test.mjs already use against main.js: regex-read the
// REAL source so the guard can't be silently deleted, AND exercise a lockstep
// re-implementation to prove the concurrency semantics the guard must have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = readFileSync(join(ROOT, 'js/app-shell/main.js'), 'utf8');

// The exact guard semantics runDatasetLoad() must have, kept in lockstep with
// main.js. If main.js's real guard is ever weakened, the source assertion below
// fails loudly; this local copy proves the behavior the guard buys us.
function makeGuardedRunner() {
  let inFlight = false;
  return async function runDatasetLoad(action) {
    if (inFlight) return;
    inFlight = true;
    try {
      await action();
    } finally {
      inFlight = false;
    }
  };
}

test('source: runDatasetLoad carries the in-flight reentrancy guard', () => {
  // The guard variable exists and is module-level (declared with the function).
  assert.match(mainSrc, /let\s+datasetLoadInFlight\s*=\s*false\s*;/,
    'a module-level datasetLoadInFlight flag must exist');
  // runDatasetLoad early-returns when a load is already running, sets the flag,
  // and resets it in a finally so it never gets stuck on.
  const fn = mainSrc.match(/async function runDatasetLoad\(action\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, 'runDatasetLoad(action) must be present');
  const body = fn[0];
  assert.match(body, /if\s*\(\s*datasetLoadInFlight\s*\)\s*return\s*;/,
    'a second concurrent call must be a no-op (early return when in flight)');
  assert.match(body, /datasetLoadInFlight\s*=\s*true\s*;/, 'the guard must be set before awaiting the action');
  assert.match(body, /finally\s*\{[\s\S]*datasetLoadInFlight\s*=\s*false\s*;[\s\S]*\}/,
    'the guard must be reset in a finally so Retry (a later call) still works');
});

test('behavior: a second call while one load is in flight is a safe no-op', async () => {
  const run = makeGuardedRunner();
  let started = 0;
  let release;
  const gate = new Promise((res) => { release = res; });
  const action = async () => { started++; await gate; };

  const first = run(action);   // starts the load, then parks on the gate
  const second = run(action);  // fires while the first is still in flight
  await second;                // must resolve immediately without starting a 2nd load

  assert.equal(started, 1, 'only the first concurrent call may run the load action');
  release();
  await first;
  assert.equal(started, 1, 'the parked second call must not have run the action after release');
});

test('behavior: a later call runs normally once the first has settled', async () => {
  const run = makeGuardedRunner();
  let started = 0;
  const action = async () => { started++; };

  await run(action);
  await run(action);

  assert.equal(started, 2, 'sequential (non-overlapping) loads must each run');
});

test('behavior: the guard is reset even when the action throws (Retry still works)', async () => {
  const run = makeGuardedRunner();
  let started = 0;
  const failing = async () => { started++; throw new Error('boom'); };

  await run(failing).catch(() => {});
  await run(failing).catch(() => {}); // a retry after failure must run again

  assert.equal(started, 2, 'a failed load must not permanently latch the guard on');
});
