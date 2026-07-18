# Capability detail — Narrative & language models

Companion to the **Narrative & language models** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the Story Engine or the on-device model; the index alone is enough for most
tasks.

## What this area is

Two modules that turn structured DataGlow output into plain-English prose. The
**Story Engine** (`js/narrative/story.js`) narrates a SQL **query result**; the
**On-Device Model** (`js/narrative/ondevice-llm.js`) is an opt-in, in-browser
small LLM that both (a) synthesizes the 20-layer validation suite and (b) powers
the Story tab's model narrative — all inference running 100% on-device via WebGPU
after a one-time weight download, with **no row-level data ever leaving the
browser**. Both are model-agnostic and defensive: the Story Engine always
degrades to a deterministic offline template, and the on-device path always
degrades to that same template when WebGPU is unavailable. The pure/prompt code
is DOM- and network-free and Node-testable; `main.js` owns all browser wiring and
dependency injection.

## `story.js` — the Story Engine

Model-agnostic narrative over `state.lastQueryResult`. `MODEL_PROVIDERS` lists
six entries, each `{id, name, endpoint, model, default, requiresKey, inBrowser?}`:
- `ondevice` — **the default** (`default: true`, `inBrowser: true`, no key, no
  network at inference); the private-by-construction core promise.
- `perplexity` (`sonar`), `anthropic` (`claude-sonnet-4-5`), `google`
  (`gemini-2.0-flash`), `openai` (`gpt-4o`) — external, `requiresKey: true`.
- `local` — the rule-based offline engine (no key, no network).

Exports:
- `buildStoryClaims(queryResult)` — pure, Node-testable. Extracts up to three
  quantitative claims (`rowcount`, `numeric_mean` on the first numeric column,
  `category_share` on the first categorical column), each scored **per-claim** by
  `scoreClaimConfidence` (imported from `validation/validation.js`) rather than one
  global score. Returns `[]` on empty rows.
- `generateLocalStory(queryResult, tableName)` — deterministic, offline,
  no-LLM narrative. Every quantitative claim carries an inline confidence badge
  (`confidenceBadgeHTML`, colored by grade A–D to match the Confidence Layer
  ring), and any grade C/D claim gets a visible "treat cautiously" caveat. Data
  values are `escapeHtml`'d.
- `generateStory(queryResult, tableName, provider, apiKey, opts)` → async
  `{text, source, error?}`. Delegates to `produceStory`, then logs via
  `logStoryTouch`, then runs a dev-only `devAssertConformance('story-output', …)`
  (from `protocol/protocol-conformance.js`) against
  `schema/story-output.schema.json`.
- `produceStory` (internal) — provider router. `ondevice` calls the injected
  `opts.ondeviceGenerate(queryResult, tableName)`; external providers `fetch`
  their own wire format (OpenAI/Perplexity chat, Anthropic messages with
  `anthropic-dangerous-direct-browser-access`, Google `?key=` generateContent).
  **Any** failure or missing key/endpoint returns the local story, with `source`
  distinguishing `'ondevice'` / `'local'` / `'local-fallback'`.

### AI Touch Ledger honesty (`logStoryTouch`)

`opts.touchLedger` is an **optional injected** object exposing `logTouch(touch)`
(kept as DI so `story.js` never imports `ai-touch-ledger.js` and stays
Node-testable). The subtle contract is that a touch is logged **exactly once,
after the real outcome is known**, so it reflects what actually happened:
- `source: 'ondevice'` → logged `location: 'ondevice'`.
- `source: 'local-fallback'` from an **external** provider → logged
  `location: 'external'` with the endpoint, because that provider's `fetch` body
  **already sent** the columns over the wire before it threw.
- `source: 'local-fallback'` from `ondevice` (failed **before** any network) →
  **not** logged — nothing left the browser, so it was not an AI touch.
- `source: 'local'` → never logged (no AI call attempted).

A defensive `try/catch` means even a broken injected ledger can never break story
generation. `fieldsTouched` is the result's column names (schema-shaped, not row
data).

## `ondevice-llm.js` — the on-device small language model

An opt-in, in-browser LLM. **Privacy posture is non-negotiable:** the model runs
100% on-device via WebGPU (WebLLM/MLC); after the one-time weight download
(generic model files, never user data) inference is fully offline. It is framed
throughout as a *data-quality reasoning assistant*, **never** a medical/clinical
AI.

- `MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'`,
  `MODEL_LABEL = 'Qwen2.5 1.5B Instruct (4-bit, ~1.1 GB)'` — Apache-2.0 weights +
  Apache-2.0 WebLLM runtime (open-weights guardrail; nothing proprietary).
- `WEBLLM_ESM_URL` — pinned `esm.run/@mlc-ai/web-llm@0.2.79`, lazy-imported only
  on opt-in (it is code, not user data, so fetching it is fine).
- `isWebGPUAvailable()` — `!!navigator.gpu`, never throws (enables graceful
  degradation).

**Pure prompt builders (Node-testable, deterministic):**
- `summarizeLayerResults` / `summarizeLedger` / `summarizePhysics` — collapse the
  20-layer results (handles both the generic `{status,summary,detail}` and the
  Confidence layer's `{score,grade,verdict}` shapes), the Assumption Ledger, and
  the optional Domain Physics output into compact bullet text. `LAYER_NAME` is a
  local id→label map kept local so this module has no hard dependency on
  `validation.js`'s export shape.
- `buildSynthesisPrompt({ledgerEntries, layerResults, physicsOutput})` →
  `{system, user, messages}` for the **validation-suite** synthesis
  (`SYSTEM_PROMPT` = data-quality-only, explicitly non-clinical).
- `buildStoryModelPrompt({tableName, queryResult, claims})` → the **Story-tab**
  prompt (`STORY_SYSTEM_PROMPT`), describing the result shape plus the per-claim
  confidence grades from `buildStoryClaims`, asking for 3–5 sentences of flowing
  prose using only supplied numbers.

**Browser-only inference (WebGPU):**
- `loadModel(onProgress)` — throws a `code: 'NO_WEBGPU'` error when unsupported;
  otherwise lazy-imports WebLLM, `CreateMLCEngine(MODEL_ID, …)`, memoized in
  `enginePromise` (cleared on failure to allow retry). Weights cache in the
  browser (Cache API/IndexedDB) for offline reuse.
- `isModelLoaded()` — whether `enginePromise` is set.
- `synthesizeFindings(context, onToken)` — streams the validation synthesis
  (temp 0.4, max_tokens 700).
- `generateStoryNarrative(context, onToken)` — streams the Story-tab narrative
  (temp 0.4, max_tokens 400).
- `clearModelCache()` — drops the engine and deletes WebLLM's `caches` entries
  (matches `/webllm|mlc|model/i`); safe no-op in Node, returns count removed.

## UI surface & flags

Wired into `js/app-shell/main.js`: `import * as story from '../narrative/story.js'`
(`main.js:33`) and `import * as ondeviceLLM from '../narrative/ondevice-llm.js'`
(`main.js:132`).

- Validation-suite synthesis: `ondeviceLLM.isWebGPUAvailable()` gate + progress
  `loadModel` (~`main.js:2610`–`2623`) then
  `ondeviceLLM.synthesizeFindings(context, …)` (~`main.js:2654`).
- Story tab: `ondeviceGenerateStory` wraps `ondeviceLLM.generateStoryNarrative(
  {queryResult, tableName, claims}, …)` (~`main.js:8491`) and is **injected** into
  `story.generateStory(state.lastQueryResult, activeDataset.table, provider,
  apiKey, { ondeviceGenerate, touchLedger })` (~`main.js:8537`) so `story.js`
  stays WebLLM-free. The WebGPU/loaded state drives the tab's badge and info copy
  (~`main.js:8412`, `8448`–`8457`) and a "clear cached model" action calls
  `clearModelCache()` (~`main.js:8508`).

**No feature flag gates this area.** There is no `story`/`narrative`/`ondevice`
entry in `flags.manifest.json`; both modules are imported unconditionally and are
**live**. The on-device model is gated only by **user opt-in + WebGPU
availability**, not by a flag. The one related flag is `aiTouchLedger`
(**`enabled: true`**): when on, `main.js` injects `aiTouchLedger` as
`opts.touchLedger` and re-renders the ledger panel (~`main.js:8545`–`8548`); when
off, `story.generateStory` receives no ledger and `logStoryTouch` early-returns,
so nothing else changes. That flag belongs to the AI Touch Ledger capability, not
to this area.

Note: the header comments in both files refer to the on-device module as
`js/ondevice-llm.js`, but the file actually lives at
`js/narrative/ondevice-llm.js`.

## Tests

`test/story-model.test.mjs` (Story Engine + `buildStoryModelPrompt`),
`test/story-xss.test.mjs` (escaping/injection safety), and
`test/ai-touch-ledger-story-wiring.test.mjs` (the `logStoryTouch` honesty
contract) cover this area. (Not executed here.) The broader
`test/ai-touch-ledger.test.mjs` covers the ledger itself, which is a separate
capability.
