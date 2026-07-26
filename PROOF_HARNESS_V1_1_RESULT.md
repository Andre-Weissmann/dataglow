# Proof Harness v1.1: Result

Implements `PROOF_HARNESS_V1_1_SPEC.md` on top of main @ `a9a68ec` ("Hotfix: Proof
Harness v1 second-engine disagree no longer silently passes GREEN (#618)").

Branch: `feat/proof-harness-v1-1-cartridge-second-engine`. **Not merged** --
left as an open PR branch per instructions.

## Ship summary

### Pillar A -- Cartridge polish

**`js/proof-harness/cartridge.js`**
- Added `normalizeImportArgs(argsOrCartridge, maybeOpts)`. Accepts three
  call shapes and normalizes them all to `{cartridgeText, runQuery,
  compareClaimToRun}`:
  1. `{ cartridgeText, runQuery, compareClaimToRun? }` (existing v1 shape)
  2. `{ cartridgeText: <exportCartridge() whole result>, runQuery, ... }`
  3. `importCartridge(cartridgeOrText, { runQuery, compareClaimToRun? })`
     (new positional convenience form)
- `importCartridge(args, opts)` now calls `normalizeImportArgs` internally
  and accepts all three shapes above. The pure module still never
  auto-injects `compareClaimToRun` -- that stays the harness's job (see
  below), so cartridge.js remains a zero-dependency pure module.

**`js/proof-harness/index.js`**
- Added `importCartridgeWrapped(args, opts)`: the harness-level import
  wrapper. Runs the args through `normalizeImportArgs`, then auto-injects
  the harness's own `compareClaimToRun` (imported from `score-claim.js`)
  whenever the caller omits it, instead of falling through to
  cartridge.js's always-fail stub. A caller that supplies its own
  `compareClaimToRun` is unaffected.
- Added `exportCartridgeWrapped(args)`: shape-compatible passthrough to
  cartridge.js's pure `exportCartridge`, giving the harness a home for any
  future export-side concern without touching the pure module.
- Added `roundTripCartridge(args)`: a single call that exports a cartridge
  from `{proposal, verdict, run, receipt, environment, schemaFingerprints}`
  and, if the export succeeds, immediately imports it back against the same
  `runQuery` (with `compareClaimToRun` auto-injected via
  `importCartridgeWrapped` unless supplied). Returns `{exported, imported}`;
  `imported` is `null` when the export itself was refused (never attempts
  an import of a rejected export).
- `DataGlowProofHarness.exportCartridge` / `.importCartridge` on the
  published window object now point at the two wrapped functions above
  (previously the pure cartridge.js functions directly); `.roundTripCartridge`
  is newly published. `DataGlowProofHarness.version` bumped `2` → `3`.

**`js/proof-harness/data-glow-proof-harness-canvas.js`** -- Cartridge tab
- Added a "Re-prove on this device" button, shown once a cartridge has been
  exported in the current session. Calls
  `e.importCartridge(_lastCartridgeExport, { runQuery })` -- the new
  positional form, with `compareClaimToRun` deliberately omitted so the
  live UI exercises the harness's auto-inject path, not just tests -- using
  the same `resolveRunQuery()` the Prove tab already uses for the live
  engine. Renders a GREEN/RED/GRAY verdict chip + reason via the existing
  `verdictChip()` helper. The reprove result is cleared whenever a fresh
  cartridge is exported, so a stale verdict is never shown next to a new
  export.
- Prove tab: added a short "Second engine (\<name\>) agreed." note when
  corroboration actually ran and agreed, distinct from (and additive to)
  the always-shown receipt detail line and the existing "second engine not
  ready" note.

### Pillar B -- Real second-engine host bridge

**`js/proof-harness/second-engine.js`** -- `resolveSecondEngine(opts)` priority
reordered (previously: `opts.runSecondEngine` → `window.runDrillPython` →
`window.runDrillR` → null, with `window.DataGlowProofHarness.runSecondEngine`
looked up in a way that self-referenced this same function in the canvas's v1
build):
1. Explicit `opts.runSecondEngine` (unchanged, wins first).
2. **`window.runProofSecondEngine`** -- new preferred host bridge, named
   `pyodide`.
3. `window.DataGlowProofHarness.runSecondEngine`, only when it is actually a
   function (defensive `typeof` check -- never throws on a missing/stale
   property, never risks self-reference).
4. `window.runDrillPython`, only when `window.runDrillPython.isProofRunner
   === true`. Without that marker the code panel's Python executor (which
   takes a Python program, not SQL) is never handed a raw SQL string.
5. `window.runDrillR`, same `isProofRunner === true` marker discipline.
6. `null` -- second engine not ready, v0 single-engine strength.

**`js/proof-harness/data-glow-proof-harness-canvas.js`** -- new
`window.runProofSecondEngine` host bridge (`installSecondEngineBridge()`,
called once from `boot()` when the v1 flag is on; idempotent, only assigns a
function reference, never eagerly loads Pyodide):
- Reuses the **existing** `window.DataGlowPython.loadRuntime()` /
  `.buildHelper(py)` public API -- the same Pyodide kernel and dataset-sync
  path the Python notebook tab already uses. `window.DataGlowPython.run()`
  (the code-panel executor) is untouched; the bridge only calls the two
  public methods it already exposed, never reimplementing or intercepting
  `.run()`.
- Preferred path: install `duckdb` inside that same Pyodide (plain `import
  duckdb` first -- cheap, no network -- then `micropip.install("duckdb")` with
  a 12s timeout if the plain import fails), then run the statement via
  `duckdb.sql(statement).fetchdf()`, returning `{rowCount, rows, scalars,
  engine:'pyodide-duckdb'}`.
- Fallback A: if duckdb cannot be installed (or a specific statement fails
  even with duckdb installed -- e.g. an unresolvable table name in Pyodide's
  own separate in-memory catalog), evaluate a trivial literal probe
  (`SELECT 1` / `SELECT 42 AS n`, no `FROM`, no function calls, single
  literal) in pure JS/regex (`evalTrivialLiteralSelect`), returning
  `{rowCount:1, scalars, engine:'pyodide-literal'}`.
- Fallback B: anything else (`window.DataGlowPython` missing, duckdb
  unavailable, statement not a trivial literal) returns
  `{error:'pyodide-sql-unavailable'}` -- the honest "did not run" signal.
  **Never fabricates a rowCount for a statement it did not actually run.**

## Tests

Five suites, run individually with `node <file>`:

| Suite | Result |
|---|---|
| `test/proof-harness-v0.test.mjs` | 73 passed, 0 failed |
| `test/proof-harness-v0-engine-window.test.mjs` | 18 passed, 0 failed |
| `test/proof-harness-v1.test.mjs` | 129 passed, 0 failed (unchanged from baseline) |
| `test/proof-harness-v1-1.test.mjs` (new) | 46 passed, 0 failed |
| `test/proof-harness-v1-1-bridge.test.mjs` (new) | 28 passed, 0 failed |
| **Total** | **294 passed, 0 failed** |

`test/proof-harness-v1-1.test.mjs` covers the spec's six required cases:
1. Flexible `importCartridge` forms (object-args, whole-export-result,
   positional `(cartridgeOrText, opts)`, positional with a bare string) →
   GREEN round-trip.
2. `compareClaimToRun` omitted on the harness wrapper still reaches GREEN
   (auto-injected scorer), and still correctly refuses a genuine mismatch
   (not a rubber stamp) -- plus `roundTripCartridge`'s equivalent path.
3. `resolveSecondEngine` finds `window.runProofSecondEngine` first among the
   window-resolved rungs, defers to an explicit `opts.runSecondEngine`,
   correctly gates `window.DataGlowProofHarness.runSecondEngine` /
   `window.runDrillPython` / `window.runDrillR` behind their respective
   type/marker checks, and returns `null` (never throws) when nothing
   resolves.
4. A fake disagreeing second engine resolved via `window.runProofSecondEngine`
   (not an injected `opts.runSecondEngine`) still downgrades a candidate
   GREEN to RED end-to-end through `runProofCycle` -- confirms the v1.1
   priority reorder does not regress the `#618` hotfix.
5. The `pyodide-sql-unavailable` contract: `corroborateRun` itself still
   treats a raw `{error}` payload as a disagreement (unchanged), while the
   caller-side contract (not presenting an unavailable signal to
   `corroborateRun` at all, same as no second engine being resolvable)
   preserves `ran:false`/`agrees:null` and GREEN end-to-end.
6. A trivial `SELECT 1` mock second-engine runner corroborates and agrees,
   both via `corroborateRun` directly and end-to-end through
   `runProofCycle`; the same mock honestly refuses a non-trivial statement.

`test/proof-harness-v1-1-bridge.test.mjs` extracts `evalTrivialLiteralSelect`
and `runProofSecondEngineBridge` **verbatim** out of the shipped
`js/proof-harness/data-glow-proof-harness-canvas.js` source (brace-depth
walk from the real function declaration, evaluated via `Function(...)`) so
the trivial-literal-probe regex logic is tested as shipped, not
reimplemented. Also confirms by source inspection that the bridge has an
honest not-available fallback on every branch, never returns a hardcoded
rowCount literal, publishes itself as `window.runProofSecondEngine`, and
installs idempotently.

## Canvas re-injection

`inject_proof_harness_v1.py` updated:
- `DataGlowProofHarness.version` in the injector's own hardcoded object
  literal bumped `2` → `3`.
- `exportCartridge`/`importCartridge` entries now point at
  `exportCartridgeWrapped`/`importCartridgeWrapped`; `roundTripCartridge`
  added.
- `js/proof-harness/index.js`'s cartridge import converted to a single-line
  `import { ... } from './cartridge.js'` statement (the injector's
  `strip_exports()` regex only strips import statements line-by-line; a
  multi-line import would have left orphaned lines in the concatenated
  IIFE).

Ran `python3 inject_proof_harness_v1.py` → replaced the existing v1 block in
`canvas/index.html` in place (143,683 chars). Verified:
- `node --check` on the extracted injected block: syntax OK.
- Loaded the extracted block in a stubbed Node `window`/`document` and
  confirmed `window.DataGlowProofHarness.version === 3` and
  `exportCartridge`/`importCartridge`/`roundTripCartridge`/
  `resolveSecondEngine` are all present as functions.
- `npm run check:canvas-integrity -- --update` → manifest hashes refreshed
  for both tracked proof-harness entries (`js/proof-harness/index.js`,
  `js/proof-harness/data-glow-proof-harness-canvas.js`) and
  `canvas/index.html`'s recorded byte count.
- `node scripts/check-canvas-integrity.mjs` (no `--update`) → clean pass
  afterward (`canvas bundle integrity OK`).
- `node scripts/check-capability-map.mjs` → clean pass, no drift (268
  shipped, 0 behind-flag; no new public capability was added, only
  existing modules edited).

## How live "Prove" should call these APIs

**Cartridge export/import (Cartridge tab or any future integration):**
```js
// Export (only offered once a claim is GREEN):
const exported = await window.DataGlowProofHarness.exportCartridge({
  proposal, verdict, run, receipt, environment, schemaFingerprints,
});
if (exported.rejected) { /* show exported.reason */ }

// Import -- any of these four shapes now work identically:
await window.DataGlowProofHarness.importCartridge({ cartridgeText: serializedJson, runQuery });
await window.DataGlowProofHarness.importCartridge({ cartridgeText: exported, runQuery }); // whole export result
await window.DataGlowProofHarness.importCartridge(exported, { runQuery });               // positional
await window.DataGlowProofHarness.importCartridge(serializedJson, { runQuery });          // positional + string
// compareClaimToRun may be omitted in all four shapes -- the harness
// auto-injects its own scorer. Pass compareClaimToRun explicitly only to
// override that default.

// Re-prove on this device in one call:
const { exported, imported } = await window.DataGlowProofHarness.roundTripCartridge({
  proposal, verdict, run, receipt, runQuery,
});
```

**Second-engine corroboration:** nothing in the Prove call site needs to
change. `runProofCycle({ statement, expected, runQuery, ... })` calls
`resolveSecondEngine({})` internally whenever no `runSecondEngine` is
injected; as long as the canvas has called `installSecondEngineBridge()`
once at boot (already wired into `boot()` behind the v1 flag),
`window.runProofSecondEngine` is present and will be found and used
automatically, with lazy Pyodide/duckdb loading only happening on the first
actual Prove click that needs corroboration. A caller that wants to force a
specific second engine (e.g. a test, or a future webR integration) still
passes `runSecondEngine`/`secondEngineName` explicitly, which continues to
win over everything else.

## Constraints honored

- `window.DataGlowPython.run` (the Python notebook/code-panel executor) was
  not modified -- the bridge only calls its existing public
  `loadRuntime`/`buildHelper` methods.
- The second-engine bridge never invents agreement: every path that cannot
  actually answer a statement returns `{error:'pyodide-sql-unavailable'}`
  (`ran:false`/`agrees:null` downstream), never a fabricated `rowCount` and
  never a false RED.
- `canvas/index.html` remains the sole authoritative, integrity-verified
  bundle; the injected block was replaced in place (no second competing
  `window.DataGlowProofHarness` publisher was introduced).
- No em dashes introduced in any new/edited file (verified by scan).
- Branch was not merged.

## Files changed

```
canvas/index.html                                  | 424 +++++++++++++++++-
canvas/integrity.manifest.json                     |  14 +-
inject_proof_harness_v1.py                         |   9 +-
js/proof-harness/cartridge.js                      |  75 +++-
js/proof-harness/data-glow-proof-harness-canvas.js | 214 +++++++++-
js/proof-harness/index.js                          | 103 ++++-
js/proof-harness/second-engine.js                  |  37 +-
test/proof-harness-v1-1.test.mjs                   | new file
test/proof-harness-v1-1-bridge.test.mjs            | new file
```
