# Proof Harness v1 (VERDICT Harness) — RESULT

**Date:** 2026-07-26
**Branch:** `feat/proof-harness-v1-harness` (from `main` @ `b5afb12`)
**Spec:** `PROOF_HARNESS_V1_SPEC.md`
**Prior slice:** `PROOF_HARNESS_V0_RESULT.md` / `PROOF_HARNESS_V0_SPEC.md`

## What shipped

The second slice of VERDICT: a claim proven by one engine can now be
corroborated by a second, a wrong answer is remembered so it cannot silently
come back, a proven claim can travel as a small verifiable file instead of a
copy of the data, and the panel gained an actual review queue instead of a
single card. All four pillars compose v0 rather than replace it; `window.
DataGlowProofHarness` keeps its full v0 method surface and behavior for any
caller that never passes the new optional arguments.

### 1. Second Engine Rule — `js/proof-harness/second-engine.js`

- `corroborateRun({ primaryRun, secondRun, expected })` compares rowCount and
  named scalars between two independently produced runs using the same
  epsilon-and-trim discipline `score-claim.js` already established (constant
  renamed `SECOND_ENGINE_NUMERIC_EPSILON` to avoid colliding with `score-
  claim.js`'s own `NUMERIC_EPSILON` once both are concatenated into one inline
  script scope).
- `resolveSecondEngine(opts)` looks for `window.runDrillPython`, a pyodide
  runner, or an explicitly injected `runSecondEngine`, and returns a null
  resolution rather than a fake one when nothing is available.
- `runProofCycle({ runQuery, runSecondEngine?, secondEngineName? })` in
  `index.js` now runs the corroboration automatically whenever a second
  runner is supplied. `verdict.js`'s `decideVerdict()` gates on it: a
  disagreement blocks `GREEN` outright and forces `RED` with reason code
  `corroboration-disagree`, never a silently unconfirmed `GREEN`.
- The receipt predicate's `corroboration` field (already present in the v0
  shape but always `null`) is the first thing that actually gets populated:
  `{ engine, agrees, tolerance, divergence_class }`.
- Canvas: the Prove tab auto-corroborates when a second engine is available;
  otherwise it shows the note "Second engine not ready. GREEN is single
  engine, same strength as v0." (no em dash).

### 2. Regression Vault — `js/proof-harness/vault.js`

- `createVault(opts)` is an in-memory store synced to `localStorage` under
  the constant `VAULT_STORAGE_KEY = 'dataglow.proofHarness.vault.v1'` when
  storage is available, and degrades to memory-only without throwing when it
  is not (private browsing, storage disabled).
- Every `RED` verdict out of `runProofCycle()` and every `rejectProposal()`
  call auto-appends a frozen vault test: `{ id, claimText, statement,
  expected, createdAt, source: 'red' | 'reject' }`.
- `runVault({ runQuery })` replays every stored test against a caller-
  supplied engine and returns a pass/fail per test, so a claim that was once
  wrong and later fixed cannot quietly regress back to the same wrong number
  without a test catching it on the next run.
- Canvas: a Vault tab lists every stored test with its source and a
  "Re-run vault" button that reports pass/fail per row.

### 3. Proof Cartridge — `js/proof-harness/cartridge.js`

- `exportCartridge(args)` serializes a proposal, its verdict, and its receipt
  chain into one `dataglow/proof-cartridge/v1` document (constant
  `PROOF_CARTRIDGE_TYPE`). The payload always sets `rows: []`: a cartridge is
  proof that a claim was checked, never a copy of the underlying data.
- The payload is hashed as `sha256:<64-char-hex>` over its canonicalized
  (deep-sorted-keys) form; `serializeCartridge()`/`parseCartridge()` round-
  trip it to and from text for a file download or a paste box.
- `importCartridge(args)` re-executes the statement via a caller-supplied
  `runQuery`, and `verifyCartridgeHash()` re-derives the hash before trusting
  anything in the cartridge; a tampered file, a schema mismatch, or a result
  mismatch all refuse to report `GREEN` and instead return a precise
  divergence description.
- Canvas: a Cartridge tab with Export (copy or download the JSON) and Import
  (paste or pick a file) actions.

### 4. Proof Inbox — `js/proof-harness/inbox.js`

- `createInbox()` returns `{ enqueue, recordCycleResult, confirm, reject,
  list, pendingReview, get, size, clear }` over the closed status vocabulary
  `INBOX_ITEM_STATUSES`: `pending-prove`, `awaiting-confirm`, `red`, `gray`,
  `amber`, `confirmed`, `rejected`.
- `itemFromCycleResult(cycleResult, existingItem)` derives the right status
  straight from a `runProofCycle()` result, so the canvas UI never hand-
  computes a status from the verdict shape itself.
- Canvas: Inbox is the new default tab. Each row shows the claim, its status
  label (via `statusLabel()`), and Prove / Confirm / Reject / Open actions,
  each reachable in one click from the row (two total to approve or reject:
  Open, then Confirm or Reject).

### 5. AMBER for a stale digest — `js/proof-harness/verdict.js`, `index.js`

- `VERDICT_STATES` is now `['GREEN', 'RED', 'GRAY', 'AMBER']`; a new reason
  code `stale-digest` sits alongside the new `corroboration-disagree` code.
- `computeStaleness(proposal, priorReceiptDigest)` in `index.js` compares a
  proposal's live digest against the digest an earlier receipt was bound to.
  A mismatch reports `{ stale: true, reason }` and `decideVerdict()` surfaces
  `AMBER` instead of treating an old receipt as still current. No stale
  receipt is ever presented as `GREEN`.
- This is staleness only, exactly as scoped: `AMBER` is not a general fifth
  outcome and is never returned unless a prior digest was supplied and no
  longer matches.

### 6. Tabbed canvas panel — `js/proof-harness/data-glow-proof-harness-canvas.js`

- Added a tab bar (`Inbox` default, `Prove`, `Vault`, `Cartridge`) gated by
  `v1FlagOn()`, which checks `window.DATAGLOW_PROOF_HARNESS_V1` first, then
  `window.DataGlowFlags.isEnabled('proofHarnessV1')`.
- With the v1 flag off, `renderBody()` falls back to exactly the v0 single
  Prove-tab body, byte-for-byte, so `proofHarnessV1` can be rolled back alone
  while `proofHarness` stays on and v0 behavior is fully restored.
- No em dash (U+2014) anywhere in visible panel text across any of the four
  tabs (grep-verified against the source module, 0 occurrences).

### 7. `flags.manifest.json`

Added `proofHarnessV1: { enabled: true, addedInPR, description,
flagOffBehavior }` immediately after the existing `proofHarness` entry.
`proofHarness` itself is untouched and stays enabled. Edited with a single
surgical string replacement (not a JSON re-serialize) to avoid disturbing the
file's existing unicode escapes elsewhere; confirmed a clean 6-line diff.

### 8. `canvas/index.html` (AUTHORITATIVE) + `inject_proof_harness_v1.py`

New injector script, same shape as v0's `inject_proof_harness.py`, extended
to concatenate all nine pure modules (`proposal.js`, `verdict.js`, `score-
claim.js`, `receipt.js`, `second-engine.js`, `vault.js`, `cartridge.js`,
`inbox.js`, `index.js`, in that dependency order) into one combined IIFE
publishing `window.DataGlowProofHarness` at `version: 2` with the full v0 +
v1 method set, then inlines the rewritten tabbed canvas UI module verbatim
right after it.

Rather than inserting a second competing block, the v1 injector detects the
existing v0-injected markers and replaces that block in place, so `canvas/
index.html` never carries two publishers of `window.DataGlowProofHarness`.
Fixed one real collision surfaced by this step: `score-claim.js` and
`second-engine.js` each declared a top-level `const NUMERIC_EPSILON`, which
throws once both land in the same inline script scope; renamed the second-
engine copy to `SECOND_ENGINE_NUMERIC_EPSILON`.

### 9. `canvas/integrity.manifest.json`

Updated the notes on both existing tracked entries (`js/proof-harness/
index.js`, now describing the nine-module v1 concatenation; `js/proof-
harness/data-glow-proof-harness-canvas.js`, now describing the tabbed panel)
and re-recorded both hashes plus `canvasBytes` via `node scripts/check-
canvas-integrity.mjs --update`.

`node scripts/check-canvas-integrity.mjs` output:
```
ok  syntax: 3 inline <script> block(s) parsed
ok  markers: 336 inlined module path(s) in canvas/index.html, 307 closing marker(s); tracked modules correctly paired
ok  tracked: 68 module(s) verified against canvas/integrity.manifest.json
ok  ship path: desktop stage script still stages index.html + js/
ok  ship path: build.sh still guards canvas/index.html against a stale src/ rebuild
ok  publish: canvas/index.html is the recorded 6232104 bytes

check-canvas-integrity: canvas bundle integrity OK
```

### 10. Capability map — `capability-map.manifest.json` + `docs/capability-map.md`

Added a new capability `proof-harness-v1-harness` (files, symbols,
`relatedFlags: [proofHarness, proofHarnessV1]`, `status: shipped`) right
after the existing `proof-harness-v0-verdict` entry, and a matching `###
Proof Harness v1` section in `docs/capability-map.md` immediately after the
v0 section. `node scripts/check-capability-map.mjs`, `node .github/scripts/
capability-drift.mjs`, and `node test/capability-map.test.mjs` (15 passed,
0 failed) all confirm the map stays honest against the shipped code.

## Composition, not reinvention

- **Second Engine Rule** reuses `score-claim.js`'s epsilon-and-trim scalar
  comparison rather than a new comparator.
- **Regression Vault** reuses the same `localStorage`-with-memory-fallback
  pattern already established elsewhere in the repo, and reuses `runQuery`
  injection rather than opening a second execution path.
- **Proof Cartridge** reuses the receipt chain's canonical-JSON-then-sha256
  hashing convention (`receipt.js`'s `sortDeep`) instead of a new crypto
  scheme.
- **Proof Inbox** is a thin state derivation over `runProofCycle()` results,
  not a second source of truth for verdict state.
- **AMBER** is computed inside the existing `runProofCycle()`/`decideVerdict()`
  path, not a parallel staleness checker.
- No changes to `js/drill-floor/*`, `js/provenance/trust-ledger.js`, or the
  SQL engine resolution path.

## Verdicts vocabulary (v1)

`GREEN` (proven, single-engine or corroborated), `RED` (refuted, or
corroboration disagreement), `GRAY` (not provable, blocker named), `AMBER`
(stale digest, re-prove required). Exactly these four; `AMBER` is staleness
only and is never returned for any other reason.

## Known limitations / v1 boundaries (by design)

- Second engine corroboration only runs when a second runner is actually
  injected or resolvable (`window.runDrillPython` / pyodide / an explicit
  `runSecondEngine`); with none available, a Prove cycle stays single-engine
  `GREEN`, matching v0 strength, and the panel says so in plain text.
- The vault and inbox are client-local (`localStorage` plus in-memory);
  nothing here uploads a vault test or an inbox item anywhere.
- The "Live: SQL warm + Prove GREEN single-engine still works; corroboration
  field populated when a second engine is available; Vault add on RED;
  Export cartridge JSON downloads/copies" acceptance gate (spec item 5)
  requires the live deployed surface and a post-merge check; this PR ships
  the code path plus the full offline test and canvas-integrity coverage
  that make that live check meaningful, but the live pass itself was not run
  from this environment, and no merge or publish was performed.
- Full metric registry UI, column lineage graph, Excel parity, Proof Mesh,
  an adversarial prover, and cloud upload remain out of scope, per the
  spec's non-goals.

## Files changed

```
 canvas/index.html                                  | ~1600 (reinjected v1 block)
 canvas/integrity.manifest.json                     | +18/-1
 capability-map.manifest.json                       | +76/-1
 docs/capability-map.md                             | +18
 flags.manifest.json                                | +6
 inject_proof_harness_v1.py                         | new, 155 lines
 js/proof-harness/cartridge.js                      | new, 212 lines
 js/proof-harness/data-glow-proof-harness-canvas.js | rewritten, 873 lines
 js/proof-harness/inbox.js                          | new, 180 lines
 js/proof-harness/index.js                          | rewritten, 372 lines
 js/proof-harness/second-engine.js                  | new, 183 lines
 js/proof-harness/vault.js                          | new, 189 lines
 js/proof-harness/verdict.js                        | +106/-? (AMBER + gating)
 test/proof-harness-v0.test.mjs                     | +8/-? (AMBER now included)
 test/proof-harness-v1.test.mjs                     | new, 379 lines
 PROOF_HARNESS_V1_SPEC.md                           | new, 82 lines (spec, tracked)
```

## Test summary

- `node test/proof-harness-v1.test.mjs` — **112 passed, 0 failed**. Covers
  all five acceptance gates: second engine agree keeps `GREEN`, disagree
  blocks it; vault catches a seeded `RED` on repeat; cartridge export has
  zero rows and import refuses `GREEN` on hash tamper or result mismatch;
  inbox queue transitions across the full status vocabulary; `AMBER` fires
  only on an actual digest mismatch. Also re-verifies every v0 method and
  outcome is unchanged when the new optional arguments are omitted.
- `node test/proof-harness-v0.test.mjs` — **73 passed, 0 failed** (one
  assertion updated to expect `AMBER` present in `VERDICT_STATES`, since v1
  adds it to the shared module; every other v0 assertion is unchanged).
- `node test/drill-floor.test.mjs` — **60 passed, 0 failed** (unbroken).
- `node test/bundle18-hotfix5-drill-shared-engine.test.mjs` — **32 passed,
  0 failed** (unbroken).
- `node test/capability-map.test.mjs` — **15 passed, 0 failed**.
- `node scripts/check-canvas-integrity.mjs` — **OK**, 68 tracked modules
  verified, canvas bytes pinned at 6,232,104.
- `node scripts/check-capability-map.mjs` — **OK**, 268 capabilities, 0
  behind-flag.
- `node .github/scripts/capability-drift.mjs` — **OK**, no drift.
