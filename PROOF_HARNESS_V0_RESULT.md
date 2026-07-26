# Proof Harness v0 (VERDICT) — RESULT

**Date:** 2026-07-26
**Branch:** `feat/proof-harness-v0-verdict` (from `main` @ `9b749cd`)
**Spec:** `PROOF_HARNESS_V0_SPEC.md`
**Doctrine brief:** `MASTER_PROMPT_DataGlow_VERDICT_Proof_Harness_July_2026.md`

## What shipped

A real, live-wireable v0 slice of VERDICT: paste a claim, edit the SQL
statement it proposes, run it against the same live DuckDB engine the SQL tab
and Drill Floor already use, and get back one of three verdicts plus an
append-only receipt.

### 1. `js/proof-harness/` pure modules

- **`proposal.js`** — `createTypedProposal({statement, engine, expected, tables, author, claimText})` is the *only* legal door into execution. It validates the shape, rejects malformed/free-form input with `{rejected:true, reason}`, and returns a frozen proposal carrying a `sha256:`-prefixed digest over its executable content (`statement`/`engine`/`expected`/`tables`; `author` is deliberately excluded from the digest). `digestProposal()` and `proposalMatchesDigest()` support the digest-bound confirm gate.
- **`verdict.js`** — `decideVerdict({claim, run, expected, proposal, comparison})` returns exactly one of `GREEN` / `RED` / `GRAY` plus a `reasonCode` and a one-line `reason`/`blocker`. No `AMBER` in v0 (that is v1 scope per the spec). Never attaches a confidence value to the verdict itself.
- **`receipt.js`** — `createReceiptLedger()` is an append-only, SHA-256 hash-chained ledger of records shaped like the MASTER PROMPT's in-toto/SLSA-flavored predicate (`_type: "dataglow/receipt/v1"`, `subject`, `predicate.{claim,proposal,inputs,run,corroboration,invariants,adversarial,environment,verdict,confirm}`). `append()` is the only mutator; there is no update/delete. `verifyReceiptChain()` re-derives every hash and reports the first broken link.
- **`score-claim.js`** — restates (does not duplicate-by-reference, since canvas inlines everything into one script) the exact `scoreDrillAnswer`/`scoreDrillExtras`/`scalarMatches` comparison discipline already shipped in `js/drill-floor/drill-floor.js`: numeric epsilon compare, trimmed string compare, strict-equal fallback. `compareClaimToRun()` checks `rowCount`/`rowcountBand`/named `scalars`.
- **`index.js`** — wires all four into `runProofCycle()` (proposal → injected `runQuery` → verdict → receipt) and `confirmProposal()` (digest-bound), and publishes `window.DataGlowProofHarness`.

### 2. `flags.manifest.json`

Added `proofHarness: { enabled: true, addedInPR, description, flagOffBehavior }`. With the flag off (via the same optional `window.DataGlowFlags.isEnabled()` provider pattern Trust Ledger/Air-Gap use, or the explicit `window.DATAGLOW_PROOF_HARNESS` override), the VERDICT button/panel are never mounted and `window.DataGlowProofHarness` is not published; the SQL tab and Drill Floor are completely unaffected.

### 3. `canvas/index.html` (AUTHORITATIVE)

Mounted a self-contained VERDICT panel (`js/proof-harness/data-glow-proof-harness-canvas.js`, inlined verbatim) plus the combined pure-engine IIFE (`js/proof-harness/index.js` section, produced by concatenating all five pure modules — see `inject_proof_harness.py`), following the exact injection convention `data-glow-trust-ledger-canvas.js` and `air-gap-mode.js` already use:

- **Claim bar** — a textarea for the claim sentence/number, plus a **"Use last SQL result"** button that appears whenever the SQL tab's `#sql-input` has content, and copies it into the statement field.
- **Proposal preview** — a human-editable SQL statement textarea and an optional expected-row-count field.
- **Prove button** — resolves the SQL engine the exact same way Drill Floor's Run/Check does: `resolveDrillSqlRunQuery()` first (Bundle 18 hotfix 5, #613), then `window.engine.runQuery`, then `window.DuckDBEngine`, then the shared singleton, then `SQLEngine.init()`. No second wasm load path.
- **Verdict chip** — `GREEN` / `RED` / `GRAY` with a one-line reason and named blocker.
- **Receipt details** — row count, duration, engine, statement, proposal digest, and receipt hash.
- **Confirm button** — digest-bound; recomputes the current statement's digest against the proposal's recorded digest and refuses (with a stated reason) if the statement changed since Prove was last run.
- **Trust Ledger wiring** — records a `gate-verdict` row via `window.DataGlowTrustLedger.record()` when present, falling back to `window.ledgerAppendFromSurface()` if that is what a given canvas build exposes.
- No chat panel — one claim bar, one card. No em dash (U+2014) anywhere in visible panel text (grep-verified against the inlined canvas section and the flag description).

Placement: the `VERDICT` button is inserted next to the Trust Ledger button (falling back to Air-Gap / Shield Packs / the top toolbar / a fixed corner), mirroring Trust Ledger's own anchor-fallback chain exactly.

### 4. Tests — `test/proof-harness-v0.test.mjs`

73 assertions, 0 failures. Covers:
- Proposal digest stability (same content → same digest, statement change → different digest, author excluded from digest), and free-form/invalid-input rejection (`createTypedProposal('select 1')` → `rejected:true`).
- Verdict `GREEN` (match), `RED` (scalar mismatch and engine error), `GRAY` (no run yet, no expectation to check), and confirmation that the closed `VERDICT_STATES` vocabulary excludes `AMBER` in v0.
- `score-claim.js` scalar/rowCount comparison helpers.
- Receipt chain: append-only growth, `GENESIS_PARENT` anchoring, hash chaining across two records, and tamper detection (`verifyReceiptChain` catches an edited record and reports its index).
- Confirm digest-binding: succeeds against an unedited proposal, fails with a stated reason after the statement is edited.
- End-to-end `runProofCycle()`: a fake injected `runQuery` proves a claim to `GREEN`; a throwing `runQuery` resolves to `RED` without throwing (never-throw-out discipline, matching `drill-floor.js`'s `runDrillSql`/`runDrillPython`/`runDrillR`).
- `flags.manifest.json` declares `proofHarness`, `enabled: true`, has a description, and the description contains no em dash.

Run: `node test/proof-harness-v0.test.mjs`

Also re-ran to confirm no regressions:
- `node test/drill-floor.test.mjs` — 60 passed, 0 failed.
- `node test/bundle18-hotfix5-drill-shared-engine.test.mjs` — 32 passed, 0 failed.

### 5. `canvas/integrity.manifest.json`

Added two tracked entries (`js/proof-harness/index.js`, tracking the combined 5-module engine section, and `js/proof-harness/data-glow-proof-harness-canvas.js`) and re-recorded `canvasBytes` after injection.

`node scripts/check-canvas-integrity.mjs` output:
```
ok  syntax: 3 inline <script> block(s) parsed
ok  markers: 336 inlined module path(s) in canvas/index.html, 307 closing marker(s); tracked modules correctly paired
ok  tracked: 68 module(s) verified against canvas/integrity.manifest.json
ok  ship path: desktop stage script still stages index.html + js/
ok  ship path: build.sh still guards canvas/index.html against a stale src/ rebuild
ok  publish: canvas/index.html is the recorded 6166860 bytes

check-canvas-integrity: canvas bundle integrity OK
```

### 6. `inject_proof_harness.py`

New injector script (same convention as `inject_air_gap_mode.py`/`inject_shield_packs.py`): strips `export` keywords from the five pure ESM modules, concatenates them into one IIFE that publishes `window.DataGlowProofHarness`, and inlines the canvas UI module verbatim immediately after, right before the `appinstalled` listener anchor.

## Composition, not reinvention

Per doctrine and the spec's "compose first" list:
- **Trust Ledger** — wired via `window.DataGlowTrustLedger.record()` (with `ledgerAppendFromSurface` as a documented fallback). The Trust Ledger engine itself was not touched.
- **Drill Floor** — `score-claim.js` restates `scoreDrillAnswer`/`scalarMatches`'s exact comparison discipline instead of inventing a new one; the Prove button reuses `resolveDrillSqlRunQuery()` byte-for-byte rather than opening a second DuckDB connection.
- **RECEIPT spine** — the receipt predicate shape matches the MASTER PROMPT's in-toto/SLSA data model directly; the hash-chain mechanics (`GENESIS_PARENT`, canonical-JSON-then-sha256, append-only) mirror `js/provenance/trust-ledger.js`'s `createTrustLedger()` rather than a new scheme.
- No changes to `js/drill-floor/*`, `js/provenance/trust-ledger.js`, or the SQL engine resolution path itself — all reused as-is.

## Verdicts vocabulary (v0)

Exactly `GREEN` (proven), `RED` (refuted), `GRAY` (not provable, blocker named). `AMBER` (stale, re-prove required) is out of scope for v0 per `PROOF_HARNESS_V0_SPEC.md` and is not implemented anywhere in `js/proof-harness/`.

## Known limitations / v0 boundaries (by design)

- Single engine only: DuckDB. No Second Engine Rule / Pyodide / webR corroboration (v1).
- No AMBER staleness graph, no Proof Cartridge export/import, no Proof Inbox (all v1/v2).
- The "Live Playwright: 20 prove cycles, ≥19 pass" acceptance criterion in the spec requires the live deployed surface (`https://dataglow-platform.pplx.app`) and a browser automation pass post-merge; this PR ships the code path and the offline test coverage (unit tests + canvas integrity) that make that live check meaningful, but the live Playwright run itself was not executed from this environment.
- Claim-text parsing to a predicate AST (S5 in the MASTER PROMPT's build order) is not implemented in v0; the claim bar is free text carried alongside the proposal for the receipt, not yet parsed into a structured predicate. This matches the spec's "GRAY for unprovable claims with named blocker" — an un-parseable claim still produces a real Prove cycle against the editable SQL statement.

## Files changed

```
 canvas/index.html                                  | +1249
 canvas/integrity.manifest.json                     | +16/-1
 flags.manifest.json                                | +6
 inject_proof_harness.py                            | new, 106 lines
 js/proof-harness/data-glow-proof-harness-canvas.js | new, 469 lines
 js/proof-harness/index.js                          | new, 182 lines
 js/proof-harness/proposal.js                       | new, 142 lines
 js/proof-harness/receipt.js                        | new, 163 lines
 js/proof-harness/score-claim.js                    | new, 124 lines
 js/proof-harness/verdict.js                        | new, 169 lines
 test/proof-harness-v0.test.mjs                     | new, 267 lines
```

## Test summary

- `node test/proof-harness-v0.test.mjs` — **73 passed, 0 failed**
- `node test/drill-floor.test.mjs` — **60 passed, 0 failed** (unbroken)
- `node test/bundle18-hotfix5-drill-shared-engine.test.mjs` — **32 passed, 0 failed** (unbroken)
- `node scripts/check-canvas-integrity.mjs` — **OK**, 68 tracked modules verified, canvas bytes pinned at 6,166,860
