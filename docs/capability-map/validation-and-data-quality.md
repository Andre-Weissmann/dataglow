# Capability detail — Validation & data quality

Companion to the **Validation & data quality** area in
[`../capability-map.md`](../capability-map.md).

## What this area is

The twenty-layer validation spine is DataGlow's core value proposition. It runs
before any analysis proceeds, treating data trust as a first-class workflow stage
rather than optional polish. Backing module highlighted by the capability map:
`js/anomaly/anomaly-timeline.js`.

## Validation layers (summary)

| Category | Layers |
|---|---|
| Structural | Schema conformance, null rates, type consistency |
| Statistical | Benford's Law, distribution bounds, upper-bound sanity |
| Relational | Foreign-key orphan detection, join coverage, temporal order |
| Domain | Healthcare standards (vitals, LOS, ICD/DRG), domain-physics rulepacks |
| Equity | Disparity scoring, k-anonymity, protected-category guard |
| Provenance | Missingness classification (MCAR/MAR/MNAR), data freshness decay |
| AI safety | Sensitive-column PHI guard, Query Sentinel pre-flight |

## Anomaly timeline (`anomaly-timeline.js`)

Runs after the static validation layers to surface dynamic anomalies over time:
- Spike / drop detection on numeric columns
- Gap detection in date sequences
- Duplicate burst detection
- Distribution shift alerts

Results are rendered in the validation rail as a scrollable timeline of flagged
events, each with severity (warn / fail), the affected column, and a plain-language
explanation.

## Key design decisions

- **Validation before storytelling** — the Story Engine checks that a validation
  run has passed before generating narrative. This blocks hallucinated conclusions
  on dirty data.
- **Twenty-layer count** — the verified count is 20 layers plus a Red Team
  self-test. UI copy and documentation use this number consistently.
- **Healthcare specifics** — date-shifted de-identified dates (MIMIC-IV pattern)
  produce a warning, not a hard failure. Race, insurance, and gender columns cannot
  be auto-merged.
