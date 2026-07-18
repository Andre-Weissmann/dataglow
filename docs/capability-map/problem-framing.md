# Capability detail — Problem framing

Companion to the **Problem framing** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the Problem Framer; the index alone is enough for most tasks.

## What this area is

A single pure module, `js/problem-framing/problem-framer.js`: a pre-analysis
wizard that turns a vague business question ("sales feel off this quarter") into a
specific, measurable analytical question **before** any querying begins.
Everything is deterministic and offline — the reframing prompts are a fixed,
hand-authored SMART-style set (no model call), the restatement is a plain
template, and column suggestions are simple keyword/substring matching against the
loaded dataset's column names. No network, no data leaves the browser. The module
is DOM-free and Node-testable; `main.js` owns the panel wiring.

## Exported API

- `REFRAMING_QUESTIONS` — the fixed four-question set, each pinning one SMART axis:
  `decision` (Relevant), `timeWindow` (Time-bound), `audience`, and `done`
  (Specific + Measurable). Each is `{id, label, hint, placeholder}`.
- `normalizeAnswers(answers)` — coerces a raw answers object into the fixed shape,
  trims whitespace, drops unknown keys, and always returns every question id
  (missing → `''`).
- `buildAnalyticalQuestion(intake, answers)` → a single restated question string
  from a deterministic template (`Originally asked as "…", the analytical
  question is: For <audience>, quantify <done> over <timeWindow>, so we can decide
  <decision>.`). Same inputs always yield the same output.
- `suggestColumns(intake, answers, columns)` → `[{term, columns:[names…]}]` — pure
  keyword matching. Tokenizes the intake + four answers (dropping `STOPWORDS` and
  short/numeric tokens), splits each column name on snake/kebab/space/camelCase
  boundaries, and returns one entry per keyword with ≥1 column match. Order
  follows first appearance of the term. Accepts either name strings or `{name}`
  objects; returns `[]` when no columns are loaded.
- `orderLayersByContext(context, layerDefs)` → a reordered **copy** of the layer
  defs (see below).
- `buildExportMarkdown({intake, answers, columns, generatedAt})` → a one-page
  Markdown recap (original question, the four reframing answers, the restated
  question, and suggested columns). Deterministic aside from the timestamp, which
  the caller may override for tests.

## Context Card → validation-layer re-weighting

The optional Context Card ("What is this data for?") feeds `orderLayersByContext`,
which **only changes the ORDER** in which the 20 validation layers surface — every
layer still runs and reports exactly what it always did. A hand-authored
`LAYER_TOPICS` vocabulary maps each layer id (e.g. `benford`, `outlier_detection`,
`missingness_detective`) to the plain-language concerns it speaks to;
`scoreLayerAgainstContext` scores each layer against the tokenized context (a
curated-topic hit counts double, a name/description hit counts single). Ties keep
the original registry order (stable sort); an empty, whitespace, or fully-unmatched
context returns the input order unchanged, so **skipping the Context Card leaves
today's ordering exactly as it is**. It is pure and never mutates its input.

## UI surface & flag

Wired into `js/app-shell/main.js` via a **lazy module registry**, not a static
import: `problemFramer = registry.get('problem-framer')` (`main.js:9414`); the
module handle is declared at `main.js:135`. The Problem Framer panel renders the
four prompts (`renderFramerQuestions`, ~`main.js:9166`, iterating
`REFRAMING_QUESTIONS`), builds the restated question and column suggestions
(`buildAnalyticalQuestion`/`suggestColumns`, ~`main.js:9198`), and offers a
Markdown download (`buildExportMarkdown` → `dataglow-problem-framer.md`,
~`main.js:9245`). The Context Card input (`#context-card-input`, ~`main.js:5041`)
re-renders validation results on input, and the validation run applies
`problemFramer.orderLayersByContext(getDataContext(), validation.LAYER_DEFS)` when
the module is present (`main.js:7161`).

**No feature flag gates this area.** There is no `problemFramer`/`problemFraming`
entry in `flags.manifest.json`; the capability is loaded unconditionally through
the registry and is **live**. (The layer re-ordering guards only on
`problemFramer` being resolved, and `getDataContext()` being empty is itself the
no-op path.)

Note: the header comment in `main.js` refers to the module as
`js/problem-framer.js`, but the actual file lives at
`js/problem-framing/problem-framer.js` — the registry id is `problem-framer`.

## Tests

`test/problem-framer.test.mjs` covers this module. (Not executed here.)
