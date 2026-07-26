# Proof Harness v0 (VERDICT) — SPEC

**Date:** 2026-07-26  
**Main baseline:** `9b749cd` (after #614)  
**Flag to add:** `proofHarness` (default ON when shipped)  
**Live target:** https://dataglow-platform.pplx.app  
**Doctrine:** AI proposes · engines prove · human confirms. Draft elsewhere. Prove here.

## GitHub safety check (pre-build)

- HEAD `9b749cd`, clean main, **0 open PRs**
- Flags: **173 ON / 0 OFF**
- No existing `proofHarness` flag
- SQL + Drill Floor archetype Checks already LIVE PASS (SCD/streaks/baskets + Spot the Sale)
- Compose existing primitives; do not invent a parallel ledger

## What v0 is (and is not)

**Claimable only when all V0 criteria pass live:**

> DataGlow can prove a number locally and hand you a receipt you can re-run.

| v0 IS | v0 is NOT |
|---|---|
| One claim bar | Chatbot panel |
| Typed Proposal → DuckDB run | Multi-engine Second Engine Rule (v1) |
| Immutable receipt + confirm | Proof Cartridge portability (v1) |
| GREEN / RED / GRAY verdicts | AMBER staleness graph (v1) |
| Wire existing Trust Ledger / RECEIPT / Drill score patterns | A48 redesign |
| false-GREEN = 0 | Excel parity, Proof Mesh (v2) |

## Compose first (shipped hooks)

Prefer wiring over rewrite:

1. **Drill Floor** `scoreDrillAnswer` / `scoreDrillExtras` — goldens as invariant prototype  
2. **Query Sentinel** — post-query claim/narrative check pattern  
3. **Trust Ledger** `window.DataGlowTrustLedger` + `ledgerAppendFromSurface`  
4. **RECEIPT spine** Prove step as mount point (canvas)  
5. **Proof Room** composition precedent (main app tab)  
6. **Publish-Safe** module (dark → light for confirm gate)  
7. **AI Touch Ledger** — AI touched? data egress?  
8. **Readiness Gate** clear/caution/blocked vocabulary  

See `/home/user/workspace/research_ph_shipped_primitives_inventory.md`.

## v0 user surface (Jobs-simple)

1. **Claim bar** — paste a number/sentence OR pick last SQL result as the claim  
2. **Proposal card** — statement + expected row band + tables (human-editable)  
3. **Run prove** — DuckDB only in v0  
4. **Verdict chip** — GREEN / RED / GRAY with one-line reason  
5. **Receipt** — expandable: SQL, rowCount, scalars, duration, digests  
6. **Confirm** — digest-bound; required before "copy as proven" / export path  

No free-form chat. Errors = remediation text for the next draft.

## Acceptance criteria (must all pass)

Copy from vision bar V0-1..V0-10 (see research). Minimum ship gate:

1. Typed Proposal only (lint: no raw model string → executor)  
2. DuckDB run returns status/rowCount/scalars/duration/error  
3. Receipt appends to ledger (hash-chained; never rewrite)  
4. Confirm bound to proposal digest; byte-change invalidates  
5. GRAY for unprovable claims with named blocker  
6. false-GREEN = 0 on a small seeded pack (10 true / 10 wrong / 10 gray)  
7. Live Playwright: 20 prove cycles, ≥19 pass; SQL warm path intact  
8. Flag `proofHarness`; OFF hides surface without breaking SQL/Drill Floor  
9. No em dash in visible product text  
10. Tests + canvas integrity if canvas changed  

## Files expected (illustrative)

- `js/proof-harness/` — proposal, verdict, receipt writer, claim parse (minimal)  
- `flags.manifest.json` — `proofHarness`  
- `canvas/index.html` — AUTHORITATIVE mount if live surface  
- `test/proof-harness-v0.test.mjs`  
- `PROOF_HARNESS_V0_RESULT.md`  

## Branch

`feat/proof-harness-v0-verdict`

Worktree: `/home/user/workspace/dataglow-f2133f3e-e20d9956` only.  
No managed clone. PR only; parent merges after confirm_action.

## Out of scope

A48, Career Lane C, multi-engine, cartridges, ambient inbox, Excel, Maven clones, HIPAA claims, auto-post LinkedIn.
