# Capability detail — Narrative & storytelling

Companion to the **Narrative & storytelling** area in
[`../capability-map.md`](../capability-map.md).

## What this area is

The layer that turns validated query results into human-readable narrative and
verifiable written findings. Backing modules: `js/portfolio/narrative-assembler.js`
and `js/portfolio/portfolio-ui.js`.

## Narrative assembler (`narrative-assembler.js`)

- Assembles findings from validation results, query outputs, and insight-engine
  discoveries into a structured written narrative.
- Each numeric claim in the narrative is cross-checked against the query result
  that produced it. A mismatch (AI hallucination or rounding error) flags the
  claim with a warning badge.
- Supports three output modes: executive summary, technical detail, and portfolio
  brief.

## On-device story generation (`story.js`, `ondevice-llm.js`)

- Qwen2.5-1.5B-Instruct runs via WebLLM/WebGPU in the browser for fully private
  narrative generation — no API key, no network, no data egress.
- Falls back to rule-based summarisation when WebGPU is unavailable.
- API-key path (OpenAI / Anthropic) available for higher-quality output when the
  analyst opts in. Schema-only context is sent — never row data.

## Claim verification

The AI Touch Ledger records every narrative claim that an LLM touched. The
provenance receipt shows: model name, timestamp, whether data left the browser,
and whether the numeric claims were verified against source query results.

## Portfolio UI (`portfolio-ui.js`)

Renders the assembled narrative as a shareable portfolio artefact: project title,
dataset provenance, key findings, validation summary, and charts. Exported as a
self-contained HTML snapshot.

## Voice policy

Voice is an accessibility and output layer only — text-to-speech for reading
findings aloud. It is not a primary input interface.
