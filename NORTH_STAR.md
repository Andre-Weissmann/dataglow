# DataGlow North Star

Read this file first, every session, before running a full brainstorm/research ritual again.
If nothing material has changed in the data industry since the last research pass (see date below),
skip straight to "Current concept" and continue building. Only re-trigger deep research if the user
explicitly asks, or on a scheduled cadence.

Last deep research pass: 2026-07-11 (`data_industry_research_2026.md`, 68 inline citations, 12 signals).

---

## Current concept: AI Readiness Gate

**One sentence:** A dataset, metric, or query result cannot be handed to an AI agent (or exported to a
dashboard/API) until it automatically earns a pass from DataGlow's existing validation — instantly,
invisibly, with zero new approval friction for humans, and a hard stop only for agents.

**Why this concept won round 2 (over Query Memory, the round 1 pick):**
- Directly answers the single most-repeated, highest-magnitude finding in the research: 60-84% of AI
  initiatives fail because ungoverned/unready data is handed to AI before it's fixed, and agents pointed
  at ungoverned data got answers wrong 65%+ of the time (Miro/DataHub case).
- Adds zero governance friction for humans — directly answers the top Reddit complaint ("ten layers of
  approval") by only gating *agents*, never people.
- Reuses 100% of existing infrastructure (20-layer validation suite in `js/validation/validation.js`,
  Metric Contracts in `js/metrics/metric-contracts.js`) — no new validation logic invented, pure
  composition/aggregation on top.
- Prevents the failure before it ships, rather than just documenting it after (Query Memory's weakness).

**How it works:**
1. Pure aggregator over `runAllLayers()` output + Metric Contracts status → single boolean
   `agentConsumable: true/false` + a reasons list citing which layer(s) failed.
2. Humans always see full results and can override; DataGlow's own agent modules (`js/agents/*`) and any
   future MCP-exposed interface are hard-blocked below threshold.
3. When blocked, shows the exact failing layer(s) with a one-click fix path (honest diagnostics, not
   "bad data ruined my AI" hand-waving — a direct wish-list item from the research).

**Build batches (in order, each its own PR):**
1. **Pure scoring/gate module + tests only.** No UI, no agent wiring. (DONE — `js/gate/readiness-gate.js`)
2. **UI badge (pass/fail + reasons) surfaced near query/metric results.** (DONE — `js/gate/readiness-gate-ui.js`,
   wired into the SQL tab behind the `aiReadinessGateBadge` flag; purely informational, no blocking.
   Python/R/Metric Studio wiring + a real per-query metric-contract status are a follow-up.)
3. Wire the gate into `js/agents/*` modules as a hard block. (NEXT)
4. (Stretch) Expose the gate via any future MCP interface so external agents respect it too.

---

## Backlog (ranked, queued — not abandoned)

These lost the "combine into one" round but remain valid; pull the next one when Readiness Gate ships.

1. **Query Memory** (round 1 pick) — fingerprint every SQL/Python/R/Metric Studio run, log author +
   timestamp, surface a "seen before" badge grounding trust in validated usage history instead of static
   docs (DataHub's finding). Complementary to the Gate — could become the audit trail *behind* the
   Gate's decisions in a later phase.
2. Machine-readable Metric Contracts extended with agent-access rules (who/what is authorized to query
   a given metric) — partially exists, could be deepened.
3. Git-for-data version control (branch/commit/diff/rollback for datasets) — not present in DataGlow.
4. Agent audit-trail standard (IETF draft) — structured, SOC2/EU-AI-Act-ready logging of agent actions.
5. Cross-org clean-room-style privacy-preserving joins, generalized beyond the federated-learning module
   already in `js/federated/`.
6. Healthcare interoperability (FHIR/OMOP/TEFCA) used explicitly as a cross-org trust *protocol*
   template, not just a domain pack.
7. Governance-as-living-layer: one queryable interface for humans and agents (Gartner's "context as
   infrastructure" framing) — partially achieved once the Gate ships.

## Efficiency note for future sessions

The user has explicitly said repeating the full ritual "round after round" without shipping/testing
anything is unproductive. Default behavior going forward:
- Read this file first.
- If the user says "brainstorm" / "what's next" without new context, propose the next backlog item
  or a genuine improvement to it — do not restart from zero research.
- Only run a full new deep-research pass if the user explicitly asks, or it's been a long time
  (e.g. 1+ months) since the last pass.
