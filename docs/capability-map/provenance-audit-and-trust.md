# Capability detail — Provenance, audit & trust

Companion to the **Provenance, audit & trust** area in [`../capability-map.md`](../capability-map.md). Load this only when you need the per-module detail for how DATAGLOW records what happened to data, proves properties about it, and guards it against unattended mutation.

## How the area is shaped

This is the largest capability area in the codebase — 28 modules under `js/provenance/` plus two agent-guardrail modules under `js/agents/`. Almost everything here is **pure, Node-testable logic** split cleanly from any DOM: the pattern throughout is a `buildX()` / `computeX()` model builder that never touches the browser, and a separate `renderX()` / `mountX()` presenter (or, more often, wiring inside `js/app-shell/main.js`) that draws it.

Three disciplines run through the whole area:

1. **One hashing primitive.** Every hash, digest, fingerprint and signature ultimately routes through `sha256Hex` exported from `js/provenance/provenance.js` (Web Crypto SHA-256). No module introduces a second hashing approach.
2. **Honest labelling.** Modules explicitly disclaim what they are *not*. A sealed check is "not a certification, not blockchain, not a zero-knowledge proof"; a "notarization" digest is only "ready-for-notarization", never notarized. The single exception is `zk-threshold-proof.js`, which *is* a genuine zero-knowledge proof and says so.
3. **Fail closed / propose-only.** The mutation guardrails default to refusal, and the revert/postmortem builders emit inert *proposals* — descriptions of an intent — never executable SQL and never an apply path.

The sub-groups below organize the modules by what they contribute.

Two shared files are referenced but documented elsewhere:

- `js/app-shell/main.js` — the wiring host for almost every surface below; covered in [`app-shell-and-data-engine.md`](app-shell-and-data-engine.md).
- `js/narrative/story.js` — supplies the grade vocabulary Guarded Copilot borrows; covered in [`narrative-and-language-models.md`](narrative-and-language-models.md).

---

## Ledgers & audit trails

**`js/provenance/provenance.js`** — The foundational chain of custody. Each step is a SHA-256 hash linked to its parent (`GENESIS_PARENT`), so the trail is tamper-evident. Exports `sha256Hex`, `hashBytes`, `verifyChainArray`, `createProvenanceChain()` (`append`/`verify`/`getTrail`/`exportTrail`/`attest`), plus attestation helpers `computeAttestationDigest`, `buildAttestation`, `verifyAttestation`, `renderAttestationHTML`, and module-level `startProvenance`/`getProvenance`/`recordStep`. **No flag — foundational and always live.** Wired at `main.js:58` (`import * as provenance`).

**`js/provenance/assumption-ledger.js`** — A single in-memory, per-session log of analyst assumptions. Exports `logAssumption`, `getLedgerEntries`, `clearLedger`, and `exportLedger(format)` (text / markdown / json). **No flag — always live.** Wired at `main.js:56` and rendered around `main.js:4284–4326` (`#assumption-ledger-wrap`, export buttons).

**`js/provenance/ai-touch-ledger.js`** — A hash-chained log of every AI model touch on a dataset: which model, on-device vs external (`TOUCH_LOCATIONS = ['ondevice','external']`), and which fields. Exports `validateTouch`, `createTouchLedger()` (`logTouch`/`getEntries`/`clear`), `verifyTouchLedger`, `summarizeTouchLedger`, `exportTouchLedger`, plus `TOUCH_LEDGER_DISCLAIMER`. Reuses `sha256Hex`. **Flag `aiTouchLedger`: enabled = true.** Wired at `main.js:57`.

**`js/provenance/query-memory.js`** — Fingerprints each SQL / Python / R / Metric run (hash of normalized text + tables/columns touched) and logs who/when so it can later answer "seen this before?". Exports `QUERY_KINDS`, `normalizeQueryText`, `buildQuerySignaturePayload`, `computeQueryFingerprint`, `buildQueryMemoryEntry`, `summarizeEntries`, `summarizeQueryMemory`, and `createQueryMemoryLog({store,now})` (`record`/`lookup`/`history`) over an injected store adapter. Batch 1 matching is exact-only. **Flag `queryMemory`: enabled = true.** Wired at `main.js:81`.

**`js/provenance/query-memory-ui.js`** — The Batch 2 presenter for the above: a "seen before" badge on each run panel. Exports `buildQueryMemoryBadgeModel` (pure) and `renderQueryMemoryBadge` (DOM). **Covered by the same `queryMemory` flag (enabled = true).** Wired at `main.js:82`, mounted into `#sql-query-memory-host` / `#py-query-memory-host` / `#r-query-memory-host` (around `main.js:1636`, `2718`, `2785`).

**`js/provenance/ownership-ledger.js`** — Infers *who* owns a dataset by reading existing audit trails, rather than adding a second log. Exports `deriveOwnershipEvents`, `summarizeCurrentOwnership`, `claimOwnership` (the only, append-only write path), and `buildOwnershipTimelineContent`. **Flag `ownershipLedger`: enabled = true.** Wired at `main.js:64`. **Notable:** its header records that the Agent Action Firewall that would attach real identities "is not merged to main", so most historical events legitimately carry `identity: null`.

---

## Cryptographic / verifiable proofs

**`js/provenance/selective-disclosure-proof.js`** — A Merkle-tree commitment with selective disclosure: commit to a set of claims, then reveal only some while proving they belong to the committed root (domain-separated leaves `L:` / nodes `N:`). Exports `hashLeaf`, `buildMerkleTree`, `merkleProof`, `rootFromProof`, `buildClaims`, `generateProof`, `verifyProof`, plus `SD_PROOF_DISCLAIMER` (explicitly **not** zero-knowledge). Its Merkle helpers are reused by the check seal and the portable receipt. **No dedicated flag — always live.** Wired at `main.js:59`.

**`js/provenance/verifiable-check-seal.js`** — The "Proof-of-Clean" seal: binds a check result, its parameters, and a data fingerprint into a Merkle (SHA-256) commitment re-verifiable from the artifact alone. Imports `sha256Hex` and the selective-disclosure Merkle helpers. Exports `canonicalJSON`, `fingerprintData`, `sealCheckResult`, `verifySeal`, `attachSealToLabel`, `renderSealSummaryLines`, `exportSealAsJSON`, plus `CHECK_SEAL_*` constants and disclaimer. **Not** zero-knowledge. **Flag `verifiableCheckSeal`: enabled = true.** Wired at `main.js:23`.

**`js/provenance/trust-beam.js`** — Serializes a seal into a self-contained shareable link whose entire payload lives in the URL fragment, so nothing is ever uploaded; a recipient re-verifies in `verify-beam.html` with zero install. Exports `encodeBeam`, `decodeBeam`, `buildBeamUrl`, `readBeamPayloadFromFragment`, plus `BEAM_*` constants and disclaimer. Transport wrapper only. **Flag `trustBeam`: enabled = true.** Wired at `main.js:25` (`buildBeamUrl`).

**`js/provenance/zk-threshold-proof.js`** — The **only genuine zero-knowledge proof** in the repo: a non-interactive Schnorr Sigma protocol (Fiat–Shamir) over a Pedersen commitment in a 512-bit safe-prime group, all in BigInt `modpow` with no external crypto library. Proves "the committed value equals 0" — used to prove zero critical issues without revealing the underlying counts. Exports `modpow`, `getGroup`, `selfCheckGroup`, `commit`, `proveZero`, `verifyZeroProof`, `countCriticalIssues`, `countCriticalContractFlags`, `proveZeroCriticalIssues`, plus `ZK_PROOF_DISCLAIMER`. **Flag `zkThresholdProof`: enabled = true.** Wired at `main.js:24`.

**`js/provenance/analysis-fingerprint.js`** — A content fingerprint for a single analysis result, so an identical result can be recognized later. Imports `sha256Hex`. Exports `canonicalFingerprintPayload`, `computeFingerprintDigest`, `computeAnalysisFingerprint`, `verifyAnalysisFingerprint`, plus `FINGERPRINT_*` constants and a disclaimer that it is **not** a signature and **not** notarized. **No dedicated flag — always live** (used inside the nutrition-badge path). Wired via dynamic import at `main.js:5871`.

---

## Portable packets & selective disclosure

**`js/provenance/provenance-packet.js`** — A single-file, signed, portable `.dataglow.json` "passport for a dataset" that bundles other modules' outputs (data-blame history, de-identification attestation, denial-risk profile, cost estimate) into one document re-checkable on a machine that never loaded the source rows. Pure and dependency-light — it embeds section *output shapes* verbatim rather than importing their producers. Exports `packetCore`, `computePacketSignature`, `buildPacket`, `verifyPacket`, `serializePacket`, `parsePacket`, `packetFilename`, `summarizePacket`, plus `PACKET_*` constants. The SHA-256 signature covers the whole core, so any post-export edit is caught. **Flag `provenancePacket`: enabled = true.** Wired at `main.js:69`.

**`js/provenance/portable-receipt.js`** — Stamps lineage onto ONE artifact (a chart, a number) so it carries its own proof. Imports `sha256Hex` plus the selective-disclosure `hashLeaf`/`buildMerkleTree`. Exports `buildClaimReceipt`, `verifyClaimReceipt`, `attachPortableReceiptIfRequested`, `receiptBlob`, and `renderReceiptVerifierHTML` (a self-contained offline HTML verifier), plus `PORTABLE_RECEIPT_*` constants and disclaimer. "DataGlow Passport, Batch B". **Flag `portableReceipts`: enabled = true.** Wired at `main.js:60`.

**`js/provenance/validation-receipt.js`** — A shareable, self-contained HTML receipt of a validation run. Imports `LAYER_DEFS` from `validation.js`. Exports `buildValidationReceipt` and `renderReceiptHTML`. **No manifest flag — loaded as a plugin via the pack registry** (`registry.get('validation-receipt')`, `main.js:9407`), so it is effectively always available when its pack is present.

**`js/provenance/peer-review.js`** — File-based asynchronous peer review: export a packet, have a colleague decide offline, re-import the verdict. Exports `buildReviewPacket`, `exportPacket`, `importReview`, `summarizeReview`, `renderReviewHTML`, plus `PACKET_*` constants and `DECISIONS`. **No manifest flag — plugin via the pack registry** (`registry.get('peer-review')`, `main.js:9408`).

---

## Data documentation & labels

**`js/provenance/data-nutrition-label.js`** — A portable, human-readable manifest of what was checked, what passed/failed, what was transformed, and the chain of custody. Pure — it reads existing module outputs and invents no crypto of its own. Exports `buildDataNutritionLabel`, `renderLabelSummaryLines`, `renderLabelSummary`, `exportLabelAsJSON`, plus `LABEL_*` constants and `LABEL_DISCLAIMER` ("a summary, not a certification"). **Flag `dataNutritionLabel`: enabled = true.** Wired at `main.js:65`.

**`js/provenance/nutrition-badges.js`** — Scannable, single-signal quality badges — every badge is backed by a real computed signal, none are decorative. Exports `computeBadges`, `BADGE_CATALOG`, `BADGE_BY_ID`, and `SMALL_SAMPLE_THRESHOLD` (30). Catalog ids: `validated`, `high-missingness`, `small-sample`, `contains-outliers`, `fingerprinted`, `debate-reviewed`. **No dedicated flag — the badge strip is gated by `rigorEngineBadges` (enabled = true) at its call site.** Wired via dynamic import at `main.js:5872`.

**`js/provenance/data-bom.js`** — A personal Data Bill-of-Materials: schema signature + version hash + local-model record, attested. Imports `hashBytes`, `buildAttestation`, `computeAttestationDigest`. Exports `schemaSignature`, `schemaVersionHash`, `buildLocalModelRecord`, `buildPersonalDataBom`, `verifyPersonalDataBom`, `describeBomVerification`, `renderPersonalDataBomHTML`, plus `BOM_*` constants. **Flag `personalDataBom`: enabled = true.** Wired at `main.js:63`.

**`js/provenance/data-blame.js`** — Cell-level "who changed this value and why" read *over* the existing provenance chain — a pure reader, no second log. Exports `buildBlameDetail`, `normalizeBlameEntry`, `buildBlameIndex`, `blameForColumn`, `blameForCell`, `replayLog`, `summarizeColumnBlame`. `normalizeBlameEntry` is the single source of the blame-entry shape reused by `revert-eligibility.js`. **No dedicated flag — always live.** Wired at `main.js:61` and via dynamic import at `main.js:4849`.

---

## Compliance & risk screening

**`js/provenance/deidentification-verifier.js`** — HIPAA Safe Harbor screening (18 identifiers, §164.514) plus k-anonymity small-cell analysis and re-identification quasi-identifier scoring. Exports `HIPAA_SAFE_HARBOR`, `checkSafeHarbor`, `scoreReidentificationRisk`, `buildDeidReport`, `computeDeidDigest`, `buildDeidAttestation`, `verifyDeidAttestation`, `runDeidentificationCheck`, plus `computeKAnonymityFromRows`, `runKAnonymityCheck`, `KANON_THRESHOLD`, `KANON_SAMPLE_LIMIT`. A screening aid, explicitly **not** a certification. **No dedicated flag — always live.** Wired at `main.js:62` and dynamic import at `main.js:4854`.

**`js/provenance/denial-root-cause.js`** — A healthcare claim-denial risk profiler: schema-tolerant column detection, five risk buckets, heuristic triage. Imports `sha256Hex` and `estimateCostOfBadData`. Exports `detectClaimColumns`, `isValidNpi`, `buildDenialReport`, `computeDenialDigest`, `buildDenialAttestation`, `verifyDenialAttestation`, `runDenialProfile`. Heuristic aid, not a determination. **No dedicated flag — always live.** Wired at `main.js:67` and dynamic import at `main.js:4859`.

**`js/provenance/cost-of-bad-data.js`** — Quantifies flagged errors into a dollar figure via transparent, editable multiplication. Exports `estimateCostOfBadData`, `formatMoney`, `DEFAULT_PER_ERROR_COST` (118), and `COST_SOURCE_NOTE` documenting the assumption. **No dedicated flag — always live** (consumed by the denial profiler and packet). Wired at `main.js:68`.

**`js/provenance/irb-mode.js`** — Generates IRB / regulatory-review documentation from a validation run — template-based, no LLM. Imports `buildValidationReceipt`. Exports `buildIRBDocument`, `renderIRBHTML`, plus `IRB_DISCLAIMER`. **No manifest flag — plugin via the pack registry** (`registry.get('irb-mode')`, `main.js:9412`).

---

## Trust scoring, composition & impact

**`js/provenance/proof-room.js`** — A pure-UI composition that stacks six already-shipped trust surfaces (Metric Studio, Trust Strip, Data Nutrition Label, Verifiable Check Seal, Trust Beam, AI Touch Ledger) into one top-to-bottom "assembled proof". Invents no crypto or logic of its own. Exports `buildProofRoomPlan(ctx)` (pure readiness aggregator, unit-tested), `renderProofRoom(opts)` (thin presenter), plus `PROOF_ROOM_STEP_KEYS`, `PROOF_ROOM_STEPS`, `PROOF_ROOM_DISCLAIMER`. Step 6 (AI Touch Ledger) is gated by the `aiTouchLedger` flag passed through `ctx`. **Flag `proofRoom`: enabled = true.** Wired at `main.js:78`, rendered around `main.js:4090`.

**`js/provenance/incident-postmortem.js`** — Drafts a blameless postmortem from the audit trail. Deliberately *applies nothing*: outputs carry `isProposal:true`, `applied:false`, and the module imports nothing so there is provably no apply path. Exports `reconstructTimeline`, `proposeCorrection`, `draftPostmortem`, plus `POSTMORTEM_*` constants, `FINDING_ERROR_KINDS`, and disclaimer. **No dedicated flag — always live**, loaded lazily. Wired via dynamic import at `main.js:7462`.

**`js/provenance/revert-eligibility.js`** — "The Crucible, Batch 3 of 3": a conservative, proposal-only classifier over the blame trail answering "could this cleaning transform be reverted, and if so what would that describe doing?". Never mutates data, never emits SQL. Imports `normalizeBlameEntry` from data-blame. Exports `classifyRevertEligibility`, `buildRevertProposal`, `summarizeRevertProposals`. DELETE-style fixes (`drop_rows`, `dedupe`) and aggregate fills (`fill_mean`, `fill_mode`) are permanently ineligible; UPDATE-style fixes are eligible only when before/after were captured. **Flag `crucibleRevertProposals`: enabled = true.**

---

## Agent guardrails

**`js/agents/agent-action-firewall.js`** — "DataGlow Passport, Batch 1": the single central checkpoint every mutating code path must pass through. A two-phase handshake — `proposeAction()` classifies + freezes a proposal and mints a single-use nonce (never executes); `confirmAndApply()` runs the caller's executor only after verifying `confirmed === true`, the exact nonce (replay-proof), an authenticated local identity, and a supplied executor. Fails closed with `AgentActionBlocked`; there is deliberately no `trusted`/`force`/`auto` bypass. Exports `classifyAction`, `proposeAction`, `confirmAndApply`, `guardMutation`, `normalizeIdentity`, `AgentActionBlocked`, `ActionRisk`, `_resetFirewallForTests`. Coded lesson of the April 2026 AI-agent-deletes-prod incident. **Flag `agentActionFirewall`: enabled = true.** Wired at `main.js:107`. **Notable:** the ownership ledger notes this firewall "is not merged to main" — so despite an enabled flag, its identity rider is not yet universally attached, hence ownership events with `identity: null`.

**`js/agents/guarded-copilot.js`** — A read-and-explain conversational layer that is *architecturally* incapable of writing data: it holds no executor reference and never calls `confirmAndApply`. Imports `computeReadinessGate`/`explainGateReasons` and `createTouchLedger`. Two tiers — Tier 1 deterministic templates (no model), Tier 2 optional on-device rephrase reusing Story's WebLLM loader (dynamically imported, rephrase-only, forbidden from adding facts). Exports `classifyIntent`, `answerDeterministic`, `askGuardedCopilot`, `refineWithOnDeviceModel`, `SUPPORTED_INTENTS`, and a frozen `PUBLIC_API_SURFACE` a red-team test pins so no write path can be added silently. **Flag `guardedCopilot`: enabled = true.** Wired at `main.js:94`.

---

## Tests

Every module in this area has a dedicated Node test under `test/` except the four always-live registry/foundation modules (`provenance.js`, `assumption-ledger.js`, `irb-mode.js`, `peer-review.js`), which are exercised indirectly. Standalone verifier scripts (`verify-attestation.mjs`, `verify-proof.mjs`) back the offline re-verification claims.

| Module | Test file |
| --- | --- |
| provenance.js | (indirect; `verify-attestation.mjs`) |
| assumption-ledger.js | (indirect) |
| ai-touch-ledger.js | `ai-touch-ledger.test.mjs`, `ai-touch-ledger-story-wiring.test.mjs` |
| query-memory.js | `query-memory.test.mjs` |
| query-memory-ui.js | `query-memory-ui.test.mjs` |
| ownership-ledger.js | `ownership-ledger.test.mjs` |
| selective-disclosure-proof.js | `selective-disclosure-proof.test.mjs` |
| verifiable-check-seal.js | `verifiable-check-seal.test.mjs` |
| trust-beam.js | `trust-beam.test.mjs`, `trust-beam-batch2-data-match.test.mjs` |
| zk-threshold-proof.js | `zk-threshold-proof.test.mjs` |
| analysis-fingerprint.js | `analysis-fingerprint.test.mjs` |
| provenance-packet.js | `provenance-packet.test.mjs` |
| portable-receipt.js | `portable-receipt.test.mjs` |
| validation-receipt.js | (indirect; registry plugin) |
| peer-review.js | (indirect; registry plugin) |
| data-nutrition-label.js | `data-nutrition-label.test.mjs` |
| nutrition-badges.js | `nutrition-badges.test.mjs`, `e2e-rigor-engine-badges.test.mjs` |
| data-bom.js | `data-bom.test.mjs`, `e2e-databom-ui.test.mjs` |
| data-blame.js | `data-blame.test.mjs` |
| deidentification-verifier.js | `deidentification-verifier.test.mjs` |
| denial-root-cause.js | `denial-root-cause.test.mjs` |
| cost-of-bad-data.js | `cost-of-bad-data.test.mjs` |
| irb-mode.js | (indirect; registry plugin) |
| proof-room.js | `proof-room.test.mjs` |
| incident-postmortem.js | `incident-postmortem.test.mjs` |
| revert-eligibility.js | `revert-eligibility.test.mjs` |
| agent-action-firewall.js | `agent-action-firewall.test.mjs` (red-team suite) |
| guarded-copilot.js | `guarded-copilot.test.mjs` (red-team API-surface pin) |
