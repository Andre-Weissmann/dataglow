# Capability detail — Rule packs

Companion to the **Rule packs** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on domain thresholds or the rulepack registry; the index alone is enough for most
tasks.

## What this area is

Phase 4 **versioned rulepacks**. A rulepack is a plain JS object that carries all
domain-specific thresholds, labels, decay parameters, and methodology attribution
for a dataset type. Before Phase 4, healthcare CMS thresholds were hardcoded in
the equity scorer; the registry lets the equity scorer, drift/freshness tracker,
and Trust Certificate pull thresholds from the **active** pack instead — so a
non-healthcare dataset gets "general" defaults and an honest "statistical
disparity analysis" attribution rather than "CMS DIS." Pure, synchronous, no
DuckDB/DOM/network.

**Flag:** `rulepacks` — **`enabled: true`** in `flags.manifest.json` (added in
`feature/temporal-drift-rulepacks-phase4`).

**Tests:** `test/temporal-drift-rulepacks-phase4.test.mjs` (shared with the
`temporalDrift` layer; no separate rulepack-only test file).

## `js/rulepacks/rulepack-registry.js`

Loads, validates, and version-pins packs. Statically imports the two built-in
packs and calls `registerBuiltIn` on each at module load (which throws if a
built-in fails validation). Exports:

- **`getRulepack(id)`** → the pack, **falling back to `'general'`** when `id` is
  missing/unknown.
- **`listRulepacks()`** → `[{id, version, label, domain, description, publishedAt}]`.
- **`registerPack(pack)`** → `{ ok, errors }`; validates shape before storing,
  enabling runtime custom packs.
- **`validatePack(pack)`** → array of error strings (empty = valid). Checks
  `REQUIRED_FIELDS` (`id, version, label, description, domain, freshness, equity`),
  the required `freshness`/`equity`/`binary`/`continuous` sub-fields,
  `decayShape ∈ {linear, exponential}`, and `decayFloor ∈ [0,1]`.
- **`buildVersionPin(packId, validatedAt = now)`** → `{ packId, packVersion,
  packLabel, domain, validatedAt, publishedAt, changelog }` for embedding in a
  Trust Certificate ("validated against healthcare@1.0.0 on …").
- **`diffVersionPins(oldPin, newPin)`** → detects pack/version changes, collects
  `changelogSinceLastRun` (via internal `compareVersions` semver compare), and a
  `thresholdDiff` (via `buildThresholdDiff`, comparing `equity.binary.*`,
  `equity.continuous.*`, and `freshness.*`) with a plain-language `summary`.

## `js/rulepacks/packs/healthcare.js` — `healthcare@1.0.0`

Label "Healthcare (CMS / NCHS)". All thresholds carry a regulatory/clinical
source. Key values: freshness `staleAfterDays: 90`, `expiredAfterDays: 365`,
`decayFloor: 0.50`, linear decay; equity binary `rateRatioWarn 1.25` /
`rateRatioFail 1.50` (CMS DIS) / `absDiffWarn 0.03` / `absDiffFail 0.05`,
continuous `smdWarn 0.10` / `smdFail 0.20`, `minCellSize 5` (NCHS), methodology
attribution citing CMS DIS 2023 / HEDIS / NCHS. Also carries healthcare-only
enrichments: `foreignKey`, `temporalOrder` (hard rules incl.
`admit_before_discharge`), `joinCoverage`, `kAnonymity` (`kFloor 5`), and
`domainPhysics` bounds (`ageBounds 0–130`, `losBounds 0–730`, `claimAmountMin 0`).

## `js/rulepacks/packs/general.js` — `general@1.0.0`

Label "General (Domain-Agnostic)". The fallback pack for non-healthcare data
(finance, retail, Lego, etc.). Deliberately **looser** thresholds and, crucially,
`methodologyAttribution: 'Statistical disparity analysis (domain-agnostic
defaults). No regulatory standard applies.'` Key values: freshness
`staleAfterDays: 180`, `expiredAfterDays: 730`, `decayFloor: 0.60`; equity binary
`rateRatioWarn 1.50` / `rateRatioFail 2.00` / `absDiffWarn 0.05` /
`absDiffFail 0.10`, continuous `smdWarn 0.15` / `smdFail 0.30`. `domainPhysics` is
empty, so the Domain Physics Engine runs in domain-agnostic mode.

## Wiring status

No direct `main.js` reference. The registry is consumed by
`js/validation/validation.js` (the validation orchestrator) and
`js/drift/freshness-decay.js`, which pull thresholds from the active pack — so the
UI surface is the existing validation suite / Trust Certificate, not a dedicated
rulepack tab.

## Related but not in scope

- `js/drift/freshness-decay.js` — the `temporalDrift` (enabled) freshness-decay
  consumer that uses each pack's `freshness` block.
- `js/validation/validation.js` — the orchestrator that reads pack thresholds for
  equity/FK/temporal/join layers.
- **Equity & fairness** area — the disparity scorer that formerly hardcoded the
  CMS thresholds now sourced from these packs (see `equity-and-fairness.md`).
