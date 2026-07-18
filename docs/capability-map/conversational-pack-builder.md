# Capability detail — Conversational pack builder

Companion to the **Conversational pack builder** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the guided pack-authoring flow (Gen 42); the index alone is enough for most
tasks.

## What this area is

The cold-start fix for domain-pack authoring. Instead of a blank text box, this
flow reads the findings the existing 20-layer validation pipeline already
produced, turns the most "askable" anomalies into plain-English, **data-grounded**
questions, resolves "I don't know" answers **entirely on-device**, and
incrementally assembles a valid, portable domain pack — every rule confirmed by
the user first. It reuses the existing community-pack schema and the pack
no-network guard rather than inventing new machinery. The agent modules are pure
and Node-testable; a single thin UI presenter drives them in the Validate tab.

## `question-generator-agent.js` — data-grounded questions (Part 1)

Askability priority (highest first): impossible values → extreme outliers →
missingness clusters → format inconsistencies (`CATEGORY_WEIGHT`
impossible 4 / outlier 3 / missingness 2 / format 1; `CATEGORY_ORDER`).

- `isGroundedCandidate(c)` requires the real observed `value` to actually appear
  in the observation text — the guarantee that a question can never be generic.
- `scanForAskableAnomalies(candidates, {max=5})` filters to grounded candidates
  and ranks by `priorityScore` (category base + severity, stable input order).
- `buildQuestion(candidate)` → `{column, category, observation, ruleGuess, value,
  text}` (throws on a non-grounded candidate); `renderQuestionText` fixes the
  template verbatim. `buildQuestionView` adds the two equal-weight
  `PRIMARY_RESPONSES` (`accept`/`skip`) plus a low-emphasis free-text fallback
  and ghost-text; `confirmRestatement` gives the single "✅ Got it" line.
- `ghostCompletion(typed, {peerSuggestions})` returns the inline suffix (peer
  suggestions rank ahead of `COMMON_PATTERN_SUGGESTIONS`).
- Extractors read real pipeline output defensively:
  `heuristicCandidatesFromStats` (also the low-end no-LLM fallback: percentage >
  100, negative counts, max > 3 SD), `candidatesFromMissingness` (Missingness
  Detective findings), `candidatesFromFormatDrift`. `generateQuestions(ctx, opts)`
  is the one-call extractor+ranker.
- Generation is **fully deterministic** (no LLM required); `buildQuestionPrompt`
  is an optional LLM-polish prompt that pins the real value verbatim.
- **AI Readiness Gate hook:** only when a caller threads `opts.readiness` does it
  call `evaluateAgentReadiness`/`buildAgentRefusal` (from `js/gate/agent-gate.js`)
  and return a refusal instead of questions. Default callers/tests are unaffected;
  this gates the agent only, never a human.

## `uncertainty-resolver-agent.js` — the "I don't know" engine (Part 2)

Resolves uncertainty on-device in a fixed, observable order (`stepsAttempted`):
- **A** Statistical Confidence Check — a hard-constraint violation that is >3 SD
  out and rare resolves at confidence 0.95, no debate.
- **B** Local peer-sourced pack index (`opts.index.findOne`) — offers to *borrow*
  a peer rule (confidence 0.7), never auto-applies.
- **C** Three-agent debate (`DEBATE_ROLES` conservative / industry-norm /
  statistical) run **sequentially** against one on-device LLM context, combined by
  `reconcile()` (confidence-weighted vote, not blind majority). A 2-second budget
  (`DEFAULT_TIME_BUDGET_MS`) caps it; blowing it → safe fallback (confidence 0.4).
  `defaultAgentProposal` is the deterministic no-LLM fallback per role.
- **D** `buildResolutionView` surfaces ONE unified suggestion — never the debate.
- **E** `ResolverSession` parks a finding on the *second* uncertainty
  (`registerUncertainty` returns `'resolve'` then `'park'`) and
  `revisitable(minGap)` / `buildParkedRevisit` re-offer it later with new
  cross-column evidence.

`detectUncertainty(text, opts)` matches `UNCERTAINTY_PHRASES` (empty answer counts
only when `opts.flaggedUncertain`). Same optional `opts.readiness` gate as Part 1.
Every output is only ever a **suggestion** — nothing writes a rule here.

## `local-pack-index.js` — read-only peer index (Part 3)

A flat, content-addressed index of community packs — no server, no account, no
live query. `LocalPackIndex` validates every entry (`validateIndexEntry`,
`REQUIRED_STRING_FIELDS`, `content_hash` shape `sha256:<64 hex>`), **drops**
malformed entries into `.rejected` rather than throwing, and freezes each stored
entry. `lookup`/`findOne` key on normalized `domain`+`columnPattern`
(`normDomain`, `normColumnPattern`); `patternsForDomain` feeds ghost-text.
`buildIndex(payload)` accepts a bare array or `{entries}`; `loadIndex(fetcher,
url, opts)` uses an **injected** fetcher (so the file names no network primitive)
and degrades to an empty index on any failure. It is the Step-B reference source
and never auto-applies.

## `pack-builder-agent.js` — guided pack builder (Part 4)

Consumes **confirmed** answers (button / typed / voice / resolver) and assembles a
portable pack. `interpretAnswer(answer)` → `{restatement, learnedRule}`;
`classifyRuleKind(text)` routes deterministically to one of the annotate-only
portable kinds: `no-merge`, `benford-exempt`, else `outlier-context`.
`PackBuilderSession.addRule`/`addConfirmedAnswer` accumulate (idempotent per
column+kind, `MAX_RULES` 32); `buildRunningSummaryView` renders the running
summary. `finalize(meta)` compiles each rule against `community-pack.js`'s strict
schema (`PACK_KIND`, `PACK_SCHEMA_VERSION`, `validateImportedPack`, `importPack`),
runs `assertNoNetwork` and the whole build inside `runWithNetworkDenied` (from
`js/packs/pack-network-guard.js`), and rejects reserved names (`none`,
`healthcare`). **Scope note (flagged in the PR):** a learned numeric bound
("discounts never exceed 100%") is captured as the closest existing annotate-only
kind (`outlier-context`), because the portable vocabulary is annotate-only — a new
hard-fail rule kind would require extending `domain-physics.js` and is out of
scope.

## `debate-diagnostics.js` — opt-in transparency (Part 6)

A pure presentation layer, not new debate logic. `buildDebateDiagnostics(resolution)`
derives an opt-in "why did you suggest this?" model from data the debate **already
computed** (carried on `resolution.debate`), re-grouping proposals the same way
`reconcile` did without re-running it. `available:false` for A/B resolutions (no
debate to reveal). Shows confidence **per persona** (`PERSONA_LABELS`), the
reconciliation math, and the winner's margin — deliberately **no** opaque single
aggregate score. States explicitly when the 2-second budget was exceeded.

## UI surface & flags

`js/agents/conversational-pack-ui.js` (Part 5) is the thin Validate-tab presenter.
`shouldOfferPackBuilder({enabled, questions})` is the single pure predicate — true
only when the flag is on AND there is at least one grounded question; the module
never reads the flag itself. `mountConversationalPackBuilder({host, questions,
domain, index, voiceEnabled, onDownload, onSaveLocal, onToast})` mounts the
one-question-at-a-time card in the Validate tab **header area** (never a modal),
delegating wording to Part 1, resolution to Part 2, accumulation/finalize to
Part 4, and optional diagnostics to Part 6.

Wired into `js/app-shell/main.js`: import at `main.js:71`; `renderConversationalPackBuilder(ds,
results)` (~`main.js:3255`) is called from the Validate render (~`main.js:3217`),
gated by `if (!isEnabled('conversationalPackBuilder')) { … return; }`
(~`main.js:3261`), building context via `buildConversationalContext` and mounting
at ~`main.js:3300`.

- Flag `conversationalPackBuilder` in `flags.manifest.json` is **`enabled: true`**
  — **live** in the Validate tab (backend #89 + UI #91, flipped on 2026-07-11).
- Flag `conversationalPackBuilderVoice` is **`enabled: false`** — the mic **ships
  dark**: the typed free-text path is fully implemented and identical to voice
  (voice is just transcribed text), but no permissively-licensed on-device WASM
  STT model is vendored yet, so `buildQuestionView` hides the mic when off.

## Tests

`test/question-generator.test.mjs`, `test/uncertainty-resolver.test.mjs`,
`test/local-pack-index.test.mjs`, `test/pack-builder-agent.test.mjs`, and
`test/pack-builder-ui.test.mjs` cover this area. (Not executed here.) Note:
`debate-diagnostics.js` (Part 6) has no dedicated `test/*.test.mjs` file of its
own by that name.
