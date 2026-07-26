# Proof Harness v1 (VERDICT Harness) — SPEC

**Date:** 2026-07-26  
**Baseline main:** `b5afb12` (PH v0 + engine window hotfix)  
**Branch:** `feat/proof-harness-v1-harness`  
**Flag:** keep `proofHarness` ON; add `proofHarnessV1` ON (umbrella for v1 surfaces; off hides v1-only UI, pure APIs may still export)  
**Doctrine:** AI proposes · engines prove · human confirms. Draft elsewhere. Prove here.  
**No em dashes (U+2014) in any user-visible product text.**

## Claimable only when live gates pass

> DataGlow catches the wrong number, remembers the mistake, and lets the proof travel.

## Scope (this PR) — four pillars

### 1. Second Engine Rule
- After primary DuckDB prove yields candidate GREEN (or always when a second runner is injected), run an independent corroboration via injected `runSecondEngine` (Pyodide preferred; webR optional).
- Compare rowCount + named scalars with same epsilon discipline as `score-claim.js`.
- Disagreement **blocks GREEN** → verdict becomes RED (or GRAY if second engine unavailable and policy is require-second=false; default: if second runner provided and fails/disagrees → cannot stay GREEN).
- Receipt predicate gains `corroboration: { engine, agrees, tolerance, divergence_class }`.
- Pure API: `corroborateRun({ primaryRun, secondRun, expected })` + integrate into `runProofCycle({ runQuery, runSecondEngine?, secondEngineName? })`.
- Canvas: when `window.runDrillPython` / pyodide runner / `window.DataGlowProofHarness.resolveSecondEngine` available, auto-corroborate; else show note "Second engine not ready; GREEN is single-engine (v0 strength)".

### 2. Regression Vault
- Every RED verdict and every human rejection (`confirm` refused or explicit Reject) appends a durable local vault test: `{ id, claimText, statement, expected, createdAt, source: 'red'|'reject' }`.
- `runVault({ runQuery })` re-runs all tests; returns pass/fail per test; seeded repeat of a prior RED must fail again (caught).
- Storage: in-memory + `localStorage` key `dataglow.proofHarness.vault.v1` when available (never uploads).
- Pure module `js/proof-harness/vault.js`; canvas shows Vault list + "Re-run vault" button.

### 3. Proof Cartridge
- Export a portable JSON cartridge from a confirmed GREEN receipt:
  - proposal digest, statement, expected, verdict, environment, input schema fingerprints if present
  - **0 rows of source data by default**
  - signature-like hash over payload (`sha256`)
- Import cartridge: re-execute statement via `runQuery`; if data digest/schema mismatch or result mismatch → precise divergence report, refuse GREEN.
- Module `js/proof-harness/cartridge.js`; canvas Export / Import file or paste JSON.

### 4. Proof Inbox
- Primary review queue surface inside VERDICT panel (not a chat panel):
  - list of proposals/results awaiting review: pending prove, proven GREEN awaiting confirm, RED, GRAY
  - actions: Prove / Confirm / Reject / Open (≤2 interactions to approve/reject)
- Module helpers in `js/proof-harness/inbox.js` (queue state); canvas renders as default tab of the panel: **Inbox | Prove | Vault | Cartridge**.

### 5. AMBER (minimal v1)
- If a receipt exists and proposal statement/expected digest no longer matches stored receipt bound digest → surface AMBER "stale, re-prove required".
- Extend `verdict.js` with AMBER state for staleness only (not a fifth mystery state).

## Non-goals
- Full metric registry UI, column lineage graph, Excel parity, Proof Mesh, adversarial prover, A48 redesign, Career Lane C, chatbot, cloud upload.

## Files
```
js/proof-harness/second-engine.js
js/proof-harness/vault.js
js/proof-harness/cartridge.js
js/proof-harness/inbox.js
js/proof-harness/verdict.js          # AMBER
js/proof-harness/index.js            # wire exports + runProofCycle corroboration
js/proof-harness/data-glow-proof-harness-canvas.js  # tabs UI
js/proof-harness/proposal.js         # no break
js/proof-harness/receipt.js          # corroboration field on predicate
flags.manifest.json                  # proofHarnessV1
canvas/index.html                    # reinject
canvas/integrity.manifest.json
test/proof-harness-v1.test.mjs
capability-map.manifest.json + docs/capability-map.md
PROOF_HARNESS_V1_RESULT.md
inject/resync scripts as needed
```

## Acceptance gates
1. Unit tests: second engine agree → GREEN stays; disagree → not GREEN; vault catches seeded RED 3/3; cartridge export has 0 rows; import mismatch refuses GREEN; inbox queue transitions; AMBER on digest drift.
2. v0 tests still pass (73+).
3. canvas integrity OK; no em dash in visible PH UI strings.
4. Flag off: v1 tabs hidden; v0 prove path still works if proofHarness on.
5. Live (post-merge): SQL warm + Prove GREEN single-engine still works; if second engine available, corroboration field on receipt; Vault add on RED; Export cartridge JSON downloads/copies.

## Compose first
Reuse score-claim, receipt ledger, Trust Ledger record hooks, Drill Floor python/r runners if on window.

## Ship process
Worktree only. PR. Parent merges after confirm_action. Publish live site_id `de9dce04-e555-4b78-979f-9a036db4599a`.
