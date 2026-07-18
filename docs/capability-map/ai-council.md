# Capability detail — AI Council

Companion to the **AI Council** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the multi-model Council; the index alone is enough for most tasks.

## What this area is

Phase 11's **Multi-Model AI Council**: the user asks one analytical question and
gets answers from up to three LLM providers (OpenAI, Anthropic, Google) called in
parallel, then the Council synthesizes them into CONSENSUS / MAJORITY / CONTESTED
verdicts plus an overall agreement rating. It is aimed at *data* questions ("which
metric best explains readmission risk", "what SQL computes denial rate"), not
general chat. **Privacy: schema only (column names + types) is ever sent** — the
same guarantee as NL→SQL — never row data. Keys are BYO, per-session, held in page
memory only.

The area splits into a **pure engine** (`council-engine.js`, Node-testable, all
network injected) and a **browser-only UI** (`council-ui.js`).

## `council-engine.js` — pure engine

Providers: `COUNCIL_PROVIDERS` is three entries — OpenAI (`gpt-5.6-sol`),
Anthropic (`claude-fable-5`), Google (`gemini-3.5-flash`), each
`requiresKey: true`. Google endpoint is assembled from `GOOGLE_ENDPOINT_BASE` +
model + `GOOGLE_ENDPOINT_SUFFIX` via `resolveGoogleEndpoint(modelName)`.

- `detectQuestionMode(question)` → `{mode,label}` — regex-classifies the ask into
  `sql`, `causal`, `statistical`, `metric`, `prediction`, `comparison`, else
  `general`.
- `detectDomain(schemaContext, question)` → `string|null` — scores signal words
  for healthcare/finance/retail/hr/marketing/operations; returns a domain only
  when its score ≥ 2, else `null`.
- `buildCouncilPrompt(question, schemaContext, modeHint, domain)` — assembles the
  shared system prompt (schema-only context, mode/domain hints, the required
  FINDING/EVIDENCE/SQL/CONFIDENCE/CAVEATS answer format).
- `callProvider(provider, apiKey, systemPrompt, question)` — routes to
  `callOpenAICompat` / `callAnthropic` / `callGoogle` for the provider's wire
  format.
- `parseAnswerSections(answer)` → `{finding,evidence,confidence,caveats,raw}`;
  `extractConfidenceLevel(text)` → `'HIGH'|'MEDIUM'|'LOW'|'UNKNOWN'`.
- `scoreAlignment(a,b)` → `1|0|-1` from positive/negative signal-word overlap.
- `synthesizeCouncil(responses)` → `{consensus, majority, contested,
  overallAgreement, sections, confidenceLevels, narrative}` — computes where all
  three agree (consensus), two of three (majority), or all differ (contested).
- `runCouncil(opts)` → `{responses, synthesis, detectedMode, detectedDomain}` —
  fans out to providers in parallel via `Promise.allSettled`; `callLLM` is
  injectable so tests run with zero network. Synthesis only runs when at least
  two providers respond successfully.

The engine never reads row data and makes no network call of its own in Node
(everything is injected).

## `council-ui.js` — browser UI

`mountCouncilUI({host, getSchemaContext, onToast})` renders: the question box;
three provider config rows (name + BYO-key password input + on/off toggle + model
override input); a schema-disclosure `<details>` showing exactly what will be
sent; a live progress strip; a synthesis panel (consensus / majority / contested
+ agreement badge + narrative); side-by-side answer cards that parse the
FINDING/EVIDENCE/SQL/CONFIDENCE/CAVEATS sections; and copy-all + export-JSON
actions. API keys live in page memory only — never localStorage, cookies, or
sessionStorage. It ships a local `esc()` sanitizer and an `h()` DOM helper,
Ctrl/Cmd+Enter to ask, and many `data-testid="council-*"` hooks.

## UI surface & flag — "merged into AI tab"

**The Council UI is still used — but it is NOT a standalone tab.** It is mounted
lazily *inside* the AI (`nlsql`) tab via a Query ↔ Council mode switcher:

- `mountCouncilUI` is imported at `main.js:154`.
- `TAB_META` has **no** council entry — only the comment "council merged into AI
  tab -- no standalone tab" (`main.js:188`), and `renderTabBar` explicitly
  filters out `tabId !== 'council'` (`main.js:265`). There is no standalone
  trigger (`main.js:392`).
- Inside the AI tab, a mode switcher (`ai-mode-council` button, `ai-mode-council-body`)
  toggles Query vs Council. `activateMode('council')` calls `renderCouncilTab()`
  when `isEnabled('aiCouncil')` (`main.js:8070`).
- `renderCouncilTab()` (`main.js:8127`) mounts into `#council-body`, which "now
  lives inside the AI tab panel, not a standalone panel" (`main.js:8128`). It is
  gated by `isEnabled('aiCouncil')` (returns early otherwise) and guarded by a
  mount-once `_councilMounted` flag (`main.js:8126`); switching modes re-shows the
  already-mounted UI rather than remounting.

The header comment at `main.js:8117` still reads "AI Council Tab (Phase 11 --
ships dark behind the aiCouncil flag)", but the manifest is authoritative: flag
`aiCouncil` in `flags.manifest.json` is **`enabled: true`** — the feature is
**live** (added in `feature/phase11-ai-council`). Treat the flag state as
current, not the "ships dark" phrasing in the code comment.

## Tests

`test/phase11-ai-council.test.mjs` covers this area. (Not executed here.)
