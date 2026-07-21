# Capability detail — Insight & discovery

Companion to the **Insight & discovery** area in
[`../capability-map.md`](../capability-map.md).

## What this area is

Proactive finding surfaces that go beyond what the analyst explicitly queries.
Backing module: `js/insight/insight-engine.js`.

## Insight engine (`insight-engine.js`)

- Runs after data loads and after each validation cycle to surface findings the
  analyst may not have thought to look for.
- Categories: distribution surprises (unexpected skew, long tail), correlation
  candidates (two columns that move together), outlier clusters, and missing-data
  patterns.
- Each insight is a typed object with a severity level, plain-language headline,
  and a suggested follow-up query the analyst can accept with one click.
- Insight generation is entirely local — no LLM call, no network, no data egress.

## Glow Path integration

The adaptive next-action rail (Glow Path) reads insight engine output to suggest
"what should I do next?" recommendations. High-severity insights rank above routine
workflow steps in the rail.

## Devil's Advocate mode

After the insight engine runs, Devil's Advocate (`devils-advocate.js`) challenges
each finding by generating counter-arguments: alternative explanations, confounders,
sample-size concerns, and Simpson's-paradox checks. This prevents premature
conclusions from a single pass.

## Smart question seeds

The Analyze tab surfaces question prompts derived from the loaded dataset's schema
and insight-engine output. Analysts can click a seed to run the corresponding NL
or SQL query immediately.
