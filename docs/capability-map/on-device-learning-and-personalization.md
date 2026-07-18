# Capability detail — On-device learning & personalization

Companion to the **On-device learning & personalization** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
inside the learning modules under `js/learning/`; the index alone is enough for
most tasks.

## What this area is

A cluster of small, transparent, on-device learners that personalize the app to
the user's OWN past behavior. Everything runs in the browser, uploads nothing,
and is deliberately linear/count-based (not a black box) so every decision
decomposes into a plain sentence — matching DATAGLOW's explainability ethos. The
backing modules are DOM-free and store-free so they unit-test in plain Node; the
browser wires persistence in via an injected store adapter (the same pattern as
the Distributional Fingerprint Drift layer). One accept/dismiss action feeds BOTH
learners through the shared `actionToLabel` — one tracking pathway, not two.

## The modules

- **`js/learning/self-learning-rules.js`** — the per-flag ranker. A textbook
  binary **logistic regression** (`SelfLearningModel`) trained online with SGD.
  Each user correction becomes one labeled example via `actionToLabel(action)`:
  `ACCEPT_ACTIONS` (`accept/apply/merge/edit/fix/confirm`) → label 1, `DISMISS_ACTIONS`
  (`reject/dismiss/ignore/skip`) → label 0, anything else → `null` (no signal).
  `extractFeatures(snapshot)` builds a fixed-length `{names, values, labels}`
  vector — categorical/numeric/sensitive/severity plus a one-hot over the ten
  `KNOWN_SOURCES` (`categorical_consistency`, `fuzzy_dedup`, `cross_column_logic`,
  `upper_bound_sanity`, `physiological_plausibility`, `missingness`,
  `distribution_drift`, `benford`, `ambient`, `other`) — all already in [0,1].
  `record(snapshot, action)` appends an example (LRU-capped at `MAX_EXAMPLES`=2000)
  and takes one incremental `_step`; `trainEpochs(8)` does a full deterministic
  refit. `predictProba`, `explain` (per-feature `wᵢxᵢ` attribution + "you've acted
  on/dismissed N similar flags" reason) and `rank(snapshots)` stay silent until
  `MIN_EXAMPLES`=10 examples exist (`isReady`). `columnVerdict(column)` tallies raw
  accept/dismiss counts per column and only returns a decisive `'dismiss'`/`'accept'`
  once one side reaches `MIN_COLUMN_VERDICT`=3 AND strictly outnumbers the other —
  this is the payload published to the Unified Signal Layer. `toJSON`/`fromJSON`
  make weights + examples portable to IndexedDB; `fromJSON` is dimension-tolerant
  (mismatched saved vectors are dropped, then refit from surviving examples).
  Exports `KNOWN_SOURCES`, which the federated learning area consumes — see
  [`federated-learning.md`](federated-learning.md); do not duplicate it here.

- **`js/learning/adaptive-priority.js`** — the per-layer reorderer
  (`LayerPriorityModel`). A **Beta-Binomial** posterior with exponential recency
  weighting: `scoreFor(layerId)` is `betaMean(dAccepts, dDismisses)` with the
  uniform prior `PRIOR_A=PRIOR_B=1` (Laplace's Rule of Succession), so a layer with
  no feedback scores exactly 0.5 — the **neutral prior** that keeps it in registry
  order. Before each event a layer's decayed counts are multiplied by `DECAY`=0.97
  (~23-event soft half-life). `recordFire` tracks firings (no score effect);
  `recordAction(layerId, action)` reuses `actionToLabel` from self-learning-rules.
  `tierFor` returns `promoted`/`deprioritized`/`neutral` against `PROMOTE_AT`=0.6 /
  `DEPRIORITIZE_AT`=0.4. `prioritize(layerDefs)` stable-sorts most-useful-first but
  stays silent (original order, `reordered:false`) below `MIN_ACTIONS`=5 total
  actions, and NEVER drops, hides, or disables a layer. `toJSON`/`fromJSON` persist
  decayed + raw counts.

- **`js/learning/rule-suggestions.js`** — correction-history rule induction
  (RIPPER-style frequency variant). `recordCorrection(original, corrected, column)`
  aggregates identical `original→corrected` pairs into a single counted entry (a
  bounded `occurrences` counter, not raw logs). `getSuggestedRules(minOccurrences=3)`
  returns pairs at/above the threshold, most-frequent-first. `approveRule(suggestion,
  userGivenName)` is the ONLY path that persists a rule — it requires a user name
  and calls `memory.saveApprovedRule({approved:true, ...})`, which itself rejects any
  unapproved rule (human-in-the-loop). `applyApprovedRules(table, column, engine)`
  returns SQL `UPDATE` strings for human review — it executes nothing.

- **`js/learning/signal-store.js`** — the **Unified Signal Layer** (`SignalStore`):
  a synchronous, in-memory scratch pad for ONE analysis pass (no IndexedDB, no DOM,
  no async) that lets sibling modules read each other's conclusions before render.
  Producers `register(signal)` (keyed by `row` and/or `column`, stamped with a
  monotonic `seq`); consumers `query(filter)` (newest-first) or the convenience
  `dismissalVerdict(column)` and `recentRuleChange(column)`. Vocabulary is fixed in
  `SIGNAL_TYPES` (`LEARNED_VERDICT`, `RULE_CHANGE`) and `VERDICTS` (`DISMISS`,
  `ACCEPT`). Purely additive — it never runs a model or changes any module's stats;
  a module that ignores it behaves exactly as before. `clear(predicate)` allows
  re-publishing a freshly recomputed set without discarding session-lived signals.
  This is where self-learning-rules' `columnVerdict` lands for the anomaly scorer.

- **`js/learning/memory-store.js`** — the browser-only **IndexedDB** persistence
  adapter (`dataglow_memory`, DB_VERSION 7), anti-degradation by design: bounded,
  versioned, LRU-evicted, native `indexedDB` (no library), stores only derived
  summaries — never raw rows. Relevant here: the `learnedCorrections` store
  (`getLearnedModel`/`saveLearnedModel`/`countLearnedExamples`/`deleteLearnedModel`/
  `clearLearnedModels`, keyed by `modelId`, default `'default'`) persists serialized
  `SelfLearningModel`/`LayerPriorityModel` JSON, and `approvedRules` (`saveApprovedRule`
  enforcing `approved:true`, `getApprovedRules`, `deleteApprovedRule`) backs
  rule-suggestions. It is an INJECTED store adapter shared by several other areas
  (e.g. the meeting decision ledger, fingerprint history, query memory, Glow Canvas
  layouts, semantic metrics) — noted for context; those stores are out of scope.

- **`js/learning/proficiency-signal.js`** — the **Session Proficiency Signal**
  (Glow Path, Batch B): a pure, in-memory per-tab action tally. `createProficiencyTracker()`
  exposes `recordAction(tabId)`, `getActionCounts`, `getTotalActions`, `getDensityLevel`,
  `reset`. `classifyDensity(totalActions, distinctTabsUsed)` returns `'low'`/`'mid'`/
  `'high'` on `DENSITY_MID_THRESHOLD`=5 / `DENSITY_HIGH_THRESHOLD`=25; `distinctTabsUsed`
  is accepted but CURRENTLY UNUSED (reserved). Persists nothing — resets on reload.

## Flag state

None of these modules is gated by a `flags.manifest.json` flag — a grep for
`selfLearning`, `adaptivePriority`, `ruleSuggestions`, `proficiency`, and `learning`
returns no entry in the manifest. Instead:

- **Self-Learning Rules** and **Adaptive Priority** are gated by user **Settings
  toggles**, both defaulting **ON** per session (RAM only, wiped on reload):
  `state.settings.selfLearningEnabled = true` and `adaptivePriorityEnabled = true`
  (`js/app-shell/state.js:39,46`). Cross-session IndexedDB persistence is a
  SEPARATE explicit opt-in, default OFF (`persistLearnedCorrections`,
  `persistLayerPriority`).
- **`signal-store.js`**, **`memory-store.js`**, and **`proficiency-signal.js`** are
  pure infrastructure (a scratch pad, a store adapter, a tally) with no flag of
  their own. `proficiency-signal.js` additionally has zero live caller in this batch
  beyond the `proficiencyTracker` recordAction hooks; its intended consumer is Glow
  Path.

## UI wiring (`js/app-shell/main.js`)

Imports live at lines 39/45/52/92/143/144. Self-learning: `selfLearner` (~6360)
drives accept/dismiss recording, IndexedDB save, the per-flag `self-learning-badge`,
the `#self-learning-stats` panel, and the `#toggle-self-learning` Settings toggle
(~6433–6559). Adaptive priority: `layerPriority` (~6367) with prioritize/explain and
the `#toggle-adaptive-priority` toggle (~6577–6688). Signal store: `signalStore`
(~6374), exposed as `window.__dataglowSignalStore` for e2e, ranker verdicts
re-published each run (~6377). Rule suggestions: the `#rule-suggestion-banner` via
`maybeShowRuleSuggestion` (~3080) appears after 2+ identical corrections, Approve the
only persist path. Proficiency: `proficiencyTracker` (~1950) records sql/python/r/
validate actions (~1652, 2696, 2773, 3222), read via `getDensityLevel()` (~2040).

## Tests

`test/self-learning-rules.test.mjs`, `test/adaptive-priority.test.mjs`,
`test/signal-store.test.mjs`, `test/proficiency-signal.test.mjs`. (Rule suggestions
and the memory store are exercised through the above and integration suites.)
