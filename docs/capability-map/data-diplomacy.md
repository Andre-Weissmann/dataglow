# Capability detail — Data Diplomacy

Companion to the **Data Diplomacy** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on Data Diplomacy; the index alone is enough for most tasks.

## What this area is

Every other DataGlow trust surface reasons about **one** dataset. Data Diplomacy
is the first capability built around **disagreement between two parties** who each
hold a claim about the same real-world thing (e.g. Riverside says a customer's
region is "West"; Lakeside says "Pacific"). It seals each claim so it is
tamper-evident, reconciles them with a deterministic referee that **honestly
refuses to guess** when it has no basis, and only *applies* a verdict after a
mandatory **two-key** human sign-off. It shipped as four batches (engine → UI →
loader → P2P transport), each its own PR.

The pure engine (`diplomacy-claim.js`, `reconciliation-engine.js`,
`diplomacy-approval-gate.js`) is DOM/network-free and reuses the existing
provenance crypto — it invents no new hashing. The UI/loader/transport are the
thin presenter/wiring layers.

## `diplomacy-claim.js` — claim seal builder (Batch 1)

- `CLAIM_KIND = 'dataglow-diplomacy-claim'`.
- `sealClaim({entityId, field, value, confidence?, source, sealedBy?, sealedAt?})`
  → `Promise<claim>`. Turns a raw assertion into an inert, fingerprinted claim.
  Throws on a missing required field (`entityId`/`field`/`value`/`source`);
  `null`/`undefined` values are "missing" but `0`/`false`/`''` are valid.
  `confidence` is optional (defaults `null`); a present-but-invalid confidence
  (non-numeric or outside `[0,1]`) throws.
- `fingerprintClaimContent(content)` → `Promise<string>` — SHA-256 hex over the
  claim's canonical JSON. Reuses `sha256Hex` from `js/provenance/provenance.js`
  and `canonicalJSON` from `js/provenance/verifiable-check-seal.js`; exported so
  the approval gate seals with the identical primitive.
- `verifyClaimSeal(claim)` → `Promise<{valid, reason?}>` — recomputes the
  fingerprint; any edit to a sealed field fails. Genuine tamper detection, not a
  "trusted" label.

## `reconciliation-engine.js` — deterministic referee (Batch 1)

`reconcileClaims(claimA, claimB, options?)` → a well-formed result object
`{resolved, reason, winningClaim, losingClaim, rationale, marginOfConfidence}`.
**Pure and never throws** — returns a well-formed object even for garbage input.
The heuristic, in order:
1. Both claims must share `entityId` **and** `field`, else refuse
   (`'entity/field mismatch'`).
2. If both carry a confidence differing by more than `options.tieThreshold`
   (default `0.05`, exported as `DEFAULT_TIE_THRESHOLD`), the higher-confidence
   claim wins; the rationale cites the actual numbers.
3. Otherwise, if `options.sourceTrust` (an array, most-trusted first, or a
   `source→rank` map) separates the two sources, the higher-trust source wins.
4. Otherwise it **refuses** (`resolved:false`, "insufficient signal to
   auto-reconcile — needs human debate"). It never silently defaults to a side.

`explainReconciliation(result)` → multi-line human-readable string (mirrors
`explainGateReasons` in `js/gate/readiness-gate.js`).

## `diplomacy-approval-gate.js` — two-key gate (Batch 1)

Enforces: a verdict may be *proposed*, but only becomes *applied* once **both**
parties independently approve. Unlike the single-approver Metric Contract gate,
one approval is never enough.

- `createApprovalRequest({reconciliationResult, partyAId, partyBId})` → inert
  `pending` request. Throws on a missing party id, or on two identical ids ("one
  party cannot hold both keys").
- `approve(request, partyId)` → `Promise<{ok, request?, bothApproved?, error?}>`.
  Idempotent per party; flips to `applied` and seals a tamper-evident
  `sealedRecord` (via `fingerprintClaimContent`) **only** once both distinct
  parties approve. Async because sealing awaits the SHA-256 primitive.
- `reject(request, partyId, note?)` → either party may reject unilaterally;
  nothing is sealed; rejecting an already-applied request fails cleanly.
- `verifyApprovalRecord(record)` → `Promise<{valid, reason?}>` — the
  `verifyClaimSeal`-style tamper check for the sealed two-key record.
- Constants `APPROVAL_REQUEST_KIND`, `APPROVAL_RECORD_KIND`. States are only
  `pending` / `applied` / `rejected`.

## `diplomacy-ui.js` — the two-key panel (Batch 2)

Pure model builders `buildClaimCardModel(claim)` and
`buildReconciliationPanelModel(reconciliationResult)` (both never throw; a
malformed input yields an honest placeholder), split from the DOM renderer
`renderDiplomacyPanel({host, claimA, claimB, partyAId, partyBId,
reconciliationResult, approvalRequest?, onApprove, onReject})`. It runs **no**
reconciliation of its own — it presents the engine's verdict verbatim. When the
engine refused (`resolved:false`), `showApproval` is false and **no** approval UI
renders. Each party's Approve button calls `onApprove(partyId)` and nothing else,
so one party can never turn the other's key; the panel re-renders after each
decision (like `renderConfirmGate`). Resolved → green badge, unresolved → amber
("needs a human", not a red failure).

## `diplomacy-loader.js` — real dataset claim builder (Batch 3)

Replaces Batch 2's hardcoded demo scenario. `buildDiplomacyFormModel({partyId,
datasets, currentValues})` (pure) derives dataset/column options and an
`isComplete` flag; `renderDiplomacyForm` and `renderDiplomacyLoader` render two
claim-builder forms side by side plus a "Reconcile" button (enabled only when both
forms are complete). It never calls `sealClaim`/`reconcileClaims`/
`createApprovalRequest` itself — those stay in `main.js` (same separation as all
batches).

## `diplomacy-p2p-transport.js` — sealed-claim P2P exchange (Batch 4)

A thin adapter adding a `'diplomacy-claim'` message kind
(`DIPLOMACY_CLAIM_MESSAGE_KIND`) to the existing Rooms data channel so two
analysts in two browsers exchange sealed claims with no server. `buildClaimMessage`
/ `isValidClaimMessage` are pure wire-format helpers;
`createDiplomacyP2PTransport({transport, selfId})` **composes** an injected
broadcast transport (typically a `RoomBroadcastCoordinator`) and exposes
`sendClaim(claim)→Promise<boolean>`, `onReceiveClaim(fn)→unsubscribe`, and
`destroy()`. `NULL_DIPLOMACY_TRANSPORT` is the no-op fallback when no Rooms
session is live. Unknown message kinds are silently ignored; handler errors never
abort other handlers. It calls no engine function.

## UI surface & flags

Wired into `js/app-shell/main.js`: engine/UI/loader/transport imports at
`main.js:95-100`; `TAB_META.diplomacy` label "Diplomacy" (`main.js:180`);
`renderTabBar` shows the tab only when `isEnabled('dataDiplomacy')`
(`main.js:256`); `switchTab` routes `diplomacy` → `renderDiplomacyTab()`
(`main.js:383`). `renderDiplomacyTab()` (from ~`main.js:3667`) owns all engine
calls, holds `diplomacyFormState`/`diplomacyReconcileState` module state, and
constructs the P2P transport (adding a "Share claim with peer" button) only when
**both** `dataDiplomacy` and `dataDiplomacyP2P` are on; otherwise it stays
`NULL_DIPLOMACY_TRANSPORT`.

- Flag `dataDiplomacy` in `flags.manifest.json` is **`enabled: true`** — the
  Diplomacy tab is **live and visible** (Batches 1–2 in PRs #146/#148, Batch 3
  loader added later).
- Flag `dataDiplomacyP2P` is **`enabled: true`** — the peer-to-peer share adapter
  is live (added in `feat/data-diplomacy-batch4-p2p-transport`). Note the
  manifest description still calls it "ships DARK" and calls Batch 3 "NOT
  STARTED", but the manifest `enabled` values (both true) and the shipped loader
  are authoritative — treat the flags as **on**.

## Tests

`test/diplomacy-claim.test.mjs`, `test/diplomacy-approval-gate.test.mjs`,
`test/diplomacy-ui.test.mjs`, `test/diplomacy-loader.test.mjs`,
`test/diplomacy-p2p-transport.test.mjs`, and `test/diplomacy-tab-gating.test.mjs`
cover this area. (Not executed here.)
