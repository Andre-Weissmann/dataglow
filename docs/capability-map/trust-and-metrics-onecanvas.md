# Capability detail — Trust & metrics (OneCanvas Phase 1)

Companion to the **Trust & metrics (OneCanvas Phase 1)** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
inside Metric Studio, the Trust Strip / Proof Drawer, the Metric Contract history,
or the AI Readiness Gate; the index alone is enough for most tasks.

## How the area is shaped

Nine modules across three folders, all following the same identity split the
codebase uses everywhere: a **pure, Node-testable logic half** (no DOM, no
network, no engine) and a **DOM presenter** the caller mounts behind a flag.
`js/app-shell/main.js` is the only wiring point — it imports and mounts each
surface, and every value shown traces to real computed data (dataset load time,
real validation results, provenance chain, the local Metric Studio registry),
never a hardcoded placeholder.

The whole area is currently **live**, not dark: every gating flag below reads
`"enabled": true` in `flags.manifest.json`. The in-code comments still describe
each surface as "ships dark behind …" / "off by default" — that documents the
original shipping state, not the current flag value.

## Metric Studio & contracts

### `js/metrics/metric-studio.js` — the metric registry

A local-only registry of user-defined metrics: a named business metric in plain
English, tied to REAL columns of the loaded dataset, with a formula computed
against the in-browser DuckDB engine (the engine is injected via `runQuery`, the
same seam the anomaly modules use). Honesty rule: a metric is only ever stored
with a value Metric Studio actually computed; a failing formula records the
error, not a placeholder number.

Pure exports:
- `referencedIdentifiers(expression) → string[]` — extracts candidate column
  refs (barewords + double-quoted identifiers), minus the `SQL_TOKENS` allowlist,
  de-duped and lowercased.
- `validateMetricDefinition(def, schemaCols) → {valid, errors, columns}` —
  rejects empty name/expression, statement chaining (`;`), and — the key honesty
  guard — any referenced column not in the schema.
- `suggestExpression(plainEnglish, schemaCols) → string` — best-effort heuristic
  (not ML): trusts an explicit `= <rhs>` when every ref resolves; maps
  "A per/over/divided by B" to `SUM("A") / NULLIF(SUM("B"), 0)`; and applies
  avg/total/count hints to a single mentioned column. Returns `''` when nothing
  confident can be suggested.
- `computeMetricValue({table, expression, engine}) → Promise<{ok, value, computedAt, error?, sql?}>`
  — runs `SELECT (${expression}) AS value FROM ${table}`; coerces `bigint` to
  `Number`; never returns a placeholder on failure.
- `textSimilarity(a, b) → number` — Dice coefficient over character bigrams,
  `[0,1]`, dependency-free.
- `findDuplicates(existing, candidate) → [{metric, reason, similarity}]` — flags an
  exact normalised-formula match (`reason: 'same-formula'`, similarity `1`) or
  plain-English text similarity `>= DUPLICATE_TEXT_THRESHOLD` (`0.9`,
  `reason: 'similar-text'`).

Data model: `class MetricRegistry` is an in-memory `Map` (id → record) with
`add/update/remove/get/list/has`, `setStatus`, `statusCounts()` (feeds the Trust
Strip certification field), and `toJSON()`/`static fromJSON()` for user-driven
export/import. `METRIC_STATUSES = ['exploratory','reviewed','certified']`
(default `exploratory`). `update()` replaces a definition **in place** — the
prior definition is gone, which is the exact honesty gap Metric Contracts closes.

Presenter: `renderMetricStudio(opts)` builds the create form (plain-English input
with an auto-suggested formula and a "Show the math" raw-expression toggle), the
saved-metric list with status badges, and the duplicate-detection prompt
(Merge-into-existing vs Keep-both). It computes the value on save, then fires the
`onDefinitionSaved(metric, {source, reason, changedBy})` callback — defaulting to
a no-op, so with it unset the save is byte-for-byte unchanged. That callback is
the single seam the contract history hangs off.

### `js/metrics/metric-contracts.js` — append-only version history (data model)

Closes the `MetricRegistry.update()` gap without touching metric-studio.js: an
append-only audit trail sitting ALONGSIDE a metric record. `CONTRACT_FIELDS =
['name','plainEnglish','expression','owner','tag']` — runtime fields
(computedValue/computedAt/status) are deliberately NOT part of a contract, since
recomputing or recertifying is not a definition change.

- `snapshotDefinition(metric) → {…contract fields}` — immutable snapshot of just
  those five fields.
- `class MetricContractHistory` — a plain array of version entries `{version,
  snapshot, changedAt, changedBy, reason, source}`. `recordVersion(metric, meta)`
  is the ONLY writer (no update/remove exists); `version` is 1-based and
  monotonic; `source` normalises to `'agent-proposed'` or `'human'`; empty
  `reason` is recorded empty, never invented. `list()/latest()/get(n)` return
  deep copies so history cannot be mutated through them.
- `class MetricContractRegistry` — `Map` of `metricId → MetricContractHistory`,
  with `historyFor(id)` (creates on demand), `recordVersion(id, metric, meta)`,
  and `toJSON()`/`fromJSON()`.
- `diffVersions(before, after) → {changed, fields:[{field, before, after}]}` —
  the one place "what changed" is computed; compares snapshots field-by-field via
  string equality. `summarizeDiff(diff)` → e.g. `"expression changed"` /
  `"name, owner changed"` / `"no changes"`.

### `js/metrics/metric-contract-diff-view.js` — diff view (read-only)

Turns diff/history data into something a person reads. Pure builders return a
normalised block model (`kind: 'kv'|'text'|'list'|'field-diff'`), following the
exact split proof-drawer.js established:
- `buildDiffViewContent({metricName, before, after})` — accepts version entries or
  bare snapshots; emits Comparing/Changed-by/Changed-at/Source/Reason blocks plus
  a `field-diff` block. `source: 'agent-proposed'` renders as "AI-agent proposed",
  otherwise "Human edit".
- `buildHistoryListContent({metricName, versions})` — an oldest-first timeline
  (`vN — <iso> — <who>[ (AI-agent proposed)][: reason]`).
- `renderDiffView({host, content})` — DOM presenter reusing proof-drawer's block
  kinds (kv/text/list) plus one new `field-diff` kind rendered here (red before /
  green after columns), so an AI-proposed change looks visually IDENTICAL to a
  past human change.

### `js/metrics/metric-contract-confirm-gate.js` — the confirm gate (safety-critical)

Enforces the rule an AI agent may PROPOSE a contract change but never APPLY one.
The only write path is `approve()`, which only runs from a human clicking the one
Approve button the presenter renders. No auto-approve/auto-apply timer, config,
or "trusted agent" bypass exists (the file cites the April 2026 incident where an
AI agent deleted a production DB in 9 seconds with no confirmation).

- `proposeContractChange({metricId, currentMetric, candidate, proposedBy, reason})`
  → an inert data object `{metricId, before, candidate, proposedBy, reason,
  status:'pending', createdAt, decidedAt}`. Pure construction; writes nothing.
- `buildProposalDiffContent({metricName, proposal})` — reuses
  `buildDiffViewContent` unmodified (before = `current`, after = `proposed`,
  `source: 'agent-proposed'`).
- `approve({proposal, contractRegistry, metricRegistry}) → {ok, version?, error?}`
  — THE ONLY WRITE PATH. Records a version (`source: 'agent-proposed'`) AND
  updates the live metric via `metricRegistry.update()` so the two stay in sync.
  Idempotent: re-approving an `applied` proposal returns the original result
  (never a double-apply); an already-`rejected` proposal errors.
- `reject({proposal, note}) → {ok, error?}` — writes nothing; sets
  `status:'rejected'`; refuses to reject an already-`applied` proposal.
- The three-state machine is `pending → applied | rejected`.
- `renderConfirmGate(opts)` — the diff view + one Approve + one Reject button of
  EQUAL visual weight (never nudge toward accept); each fires once, then
  re-renders to a static "✅ Applied" / "✋ Rejected" state with buttons removed.

## Trust strip & proof drawer

### `js/trust/trust-strip.js`

A compact horizontal bar of trust signals for the loaded dataset. Every field is
sourced from real computed data.

- `collectTrustSignals(arg) → {loaded, fields:[{key, label, value, state, detail}]}`
  — PURE and synchronous; renders sensibly with zero data. Six fields:
  **freshness** (dataset `loadedAt` via `timeAgo`), **certification** (certified /
  reviewed / exploratory from `metricCounts`), **validation** (pass/warn/fail
  tally over per-layer results, skipping non-layer keys — matches the layer-status
  vocabulary `pass/warn/fail/idle`), **anomaly** (`summarizeAnomaly` tolerates
  array / `.anomalies` / `.count` / `.anomalyCount` shapes; "not checked" when
  null), **lineage** (whether the provenance chain is non-empty), and
  **lastUpdate** (same load-time source as freshness). `state` is one of
  `ok/warn/bad/idle`.
- `renderTrustStrip({host, signals, onFieldClick})` — each field is a button
  (colored status dot from `STATE_DOT`); clicking invokes `onFieldClick(field)`
  so the caller opens the Proof Drawer scoped to that field.

### `js/trust/proof-drawer.js`

A slide-out panel explaining WHY a number can be trusted, opened from a metric, a
Trust Strip field, or a provenance/lineage view.

- `buildProofContent(trigger) → {title, subtitle?, blocks}` — PURE; switches on
  `trigger.type` (`'metric' | 'provenance' | 'trust-field'`). For a metric it
  emits plain-English definition, certification status, computed value + time,
  source columns, and two collapsible "Show the math" code blocks (the raw DuckDB
  expression and the `SELECT (...) AS value FROM <table>` query). For a trust
  field it dispatches on `field.key` (`validation`, `certification`, `lineage`,
  else a generic value/detail view).
- For provenance/lineage it does NOT re-implement rendering — it calls the
  existing `renderAttestationHTML()` (`js/provenance/provenance.js`) /
  `renderReceiptHTML()` (`js/provenance/validation-receipt.js`) and embeds the
  output in an `iframe` (`kind: 'html'`).
- `openProofDrawer({trigger, mount})` — idempotent slide-out + backdrop; removes
  any existing drawer first so re-triggering scopes cleanly; returns `{close}`.

## Readiness gate & agent gate

### `js/gate/readiness-gate.js` — pure scoring (batch 1)

A pure aggregator that composes the OUTPUT of `runAllLayers()`
(`js/validation/validation.js`) into a single agent-consumability verdict — it
does not re-run validation and invents no new checks or severities.

- `computeReadinessGate(layerResults, metricContractStatus?, {threshold?}) →
  {agentConsumable, score, threshold, failingLayers, passingSummary,
  blockedByContract, evaluatedLayerCount}`.
  - `STATUS_WEIGHT`: pass = `1`, warn = `0.5` (half-credit), fail = `0`; `idle`
    layers carry no evidence and are excluded from the denominator.
  - `score` = round(mean weight × 100) over scored layers; `DEFAULT_THRESHOLD =
    70`.
  - `agentConsumable` is true only when NOT blocked by contract AND zero hard
    failures AND at least one scored layer AND `score >= threshold`.
  - `isMetricContractBroken()` treats `{ok:false}` / `{valid:false}` /
    `{broken:true}` / a textual status of invalid/broken/error/failed/fail as a
    contract break — which fails the gate on its own.
- `explainGateReasons(gateResult) → string` — multi-line PASS/BLOCKED explanation
  citing exact failing layers and any contract block. Pure string, no DOM.

### `js/gate/readiness-gate-ui.js` — informational badge (batch 2)

- `buildReadinessBadgeModel(gateResult) → {status, tone, badgeClass, label,
  score, scoreText, title, reasons, consumable}` — pure; maps the verdict to
  tones `ready` (green `badge-a`), `blocked-hard` (red `badge-d`, a hard fail or
  broken contract), `blocked-soft` (amber `badge-c`, below threshold with nothing
  hard-failed), and `idle` (neutral — no evidence yet, an honest "unknown", NOT a
  red failure).
- `renderReadinessBadge({host, gateResult})` — a click-to-expand button showing
  `explainGateReasons()` inline. Purely informational: it NEVER blocks or alters
  the result it sits beside (blocking is batch 3).

### `js/gate/agent-gate.js` — agent hard-block (batch 3)

Turns the batch-1 verdict into an actual refusal for DATAGLOW's own data-consuming
agents (`js/agents/*`) — never for a human, and opt-in per call site.

- `evaluateAgentReadiness(readiness) → {blocked, gate, message?}` —
  backward-compatible: with no `readiness` context supplied (the default for
  every pre-existing caller/test) the agent is ALLOWED, so wiring never breaks an
  existing path. Statistical confidence is checked FIRST via
  `evaluateStatisticalConfidence(rigorResult)`: `STAT_BLOCK_VERDICTS =
  {'insufficient'}` (n<10) is a hard block with reason code
  `statisticalConfidence`; `'low'` is a non-blocking advisory. Otherwise it calls
  `computeReadinessGate()` and blocks when the result is not agent-consumable.
- `buildAgentRefusal(agent, evaluation)` / `buildStatConfidenceRefusal(agent,
  statEval)` — uniform refusal objects (`{blocked:true, agent, reasons, gate?,
  message, reasonCode?}`) whose `reasons` come from `explainGateReasons()`, so a
  refusal cites the exact failing layer(s) — honest diagnostics, not "bad data
  ruined my AI."

## UI wiring (all in `js/app-shell/main.js`)

Imports at lines 72-80. The OneCanvas Phase 1 block (from ~line 3321) holds the
shared state: `metricRegistry` (`MetricRegistry`), `metricContractRegistry`
(`MetricContractRegistry`), and `metricContractProposals` (an empty array — no
in-app AI proposer exists today, confirmed by grep, so the confirm gate is wired
but never surfaces).

- **Trust Strip** — `renderTrustStripPanel()` (~3387) mounts into
  `#trust-strip-host` when `trustStripProofDrawer` is on, feeding
  `collectTrustSignals` the active dataset, `state.validationResults`,
  `metricRegistry.statusCounts()`, and the provenance chain (`anomalyResult: null`
  → honest "not checked"). Field clicks route to `openTrustFieldProof()`
  (~3364), which opens the Proof Drawer and, for `lineage`, first builds a real
  attestation from the provenance trail.
- **Metric Studio** — `renderMetricStudioPanel()` (~3404) mounts into
  `#metric-studio-body` / `#metric-studio-wrap` when `metricStudio` is on, wiring
  `onOpenProof: openMetricProof`, `onChange: renderTrustStripPanel` (so
  certification counts refresh the strip), and `onDefinitionSaved:
  recordMetricDefinitionVersion`.
- **Metric Contracts** — `recordMetricDefinitionVersion()` (~3347) is the single
  writer into the contract history and no-ops unless `metricContracts` is on.
  `renderMetricContractHistoryPanel()` (~3430) renders per-metric timelines
  (`buildHistoryListContent` + `renderDiffView`) and any pending proposal's
  `renderConfirmGate` into `#metric-contract-body`.
- `renderOneCanvasPhase1()` (~3474) refreshes all three surfaces together.
- **Proof Room** — a composed tab (`renderProofRoomTab`, ~4131) gated by the
  umbrella `proofRoom` flag re-mounts `renderMetricStudio` and `renderTrustStrip`
  DIRECTLY (bypassing their own flags) so the trust surfaces appear together.
- **Readiness Gate badge** — `renderReadinessGateBadge(resultWrap)` (~1916)
  appends the badge below a SQL result when `aiReadinessGateBadge` is on, using
  `computeReadinessGate(state.validationResults)`. It never re-runs validation or
  blocks the query.
- **Readiness enforcement** — at ~3274 the pack-builder call threads a
  `readiness` context into the agent ONLY when `aiReadinessGateEnforcement` is on;
  the agents themselves (`js/agents/question-generator-agent.js`,
  `uncertainty-resolver-agent.js`) call `evaluateAgentReadiness` /
  `buildAgentRefusal`, and `js/mcp/dataglow-mcp-server.mjs` consults the same
  gate.

## Gating flags (all currently `enabled: true`)

From `flags.manifest.json` — every one of these is **live**, not dark:

| Flag | `enabled` | Governs |
|------|-----------|---------|
| `metricStudio` | `true` | Metric Studio panel |
| `trustStripProofDrawer` | `true` | Trust Strip + Proof Drawer |
| `metricContracts` | `true` | Contract history record + panel + confirm gate |
| `aiReadinessGateBadge` | `true` | SQL-tab readiness badge (batch 2) |
| `aiReadinessGateEnforcement` | `true` | Agent hard-block context threading (batch 3) |

Note: the confirm-gate write path stays inert in practice even with the flag on,
because nothing in the running app calls `proposeContractChange()` yet
(`metricContractProposals` is always empty). The Proof Room composition is
additionally gated by the separate `proofRoom` flag.

## Matching test files

Under `test/` (existence only; not run here):
`metric-studio.test.mjs`, `metric-contracts.test.mjs`,
`metric-contract-diff-view.test.mjs`, `metric-contract-confirm-gate.test.mjs`,
`trust-strip-proof-drawer.test.mjs`, `readiness-gate.test.mjs`,
`readiness-gate-ui.test.mjs`, `agent-gate.test.mjs`.

## Cross-references (files not in this area's scope)

- `js/packs/pack-registry.js` — the local-only named-thing registry pattern
  `MetricRegistry` mirrors.
- `js/validation/validation.js` — `runAllLayers()` produces the per-layer results
  the readiness gate scores and the Trust Strip summarizes.
- `js/provenance/provenance.js` (`renderAttestationHTML`, `getProvenance`,
  `buildAttestation`) and `js/provenance/validation-receipt.js`
  (`renderReceiptHTML`) — reused by the Proof Drawer for lineage.
- `js/rigor/statistical-rigor.js` — `classifyConfidence()` /
  `summarizeGroupedConfidence()` output feeds `evaluateStatisticalConfidence`.
- `js/agents/question-generator-agent.js`,
  `js/agents/uncertainty-resolver-agent.js`, `js/agents/guarded-copilot.js`,
  `js/mcp/dataglow-mcp-server.mjs` — consumers of the agent gate.
- `js/app-shell/utils.js` — the shared `el`/`escapeHtml`/`formatNumber`/`timeAgo`
  DOM helpers every presenter here builds on.
- `docs/capability-map/validation-layers.md` — the validation suite whose output
  the readiness gate depends on.
