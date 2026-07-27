# A49.2 Question Scout v2 — Result

Branch: `feature/a49-2-scout-v2` (PR open, **not merged**, per SPEC).
Depends on and extends A49 Question Scout, merged on `main` as
[PR #632](https://github.com/Andre-Weissmann/dataglow/pull/632).

## What was built

Implements `A49_2_SCOUT_V2_SPEC.md`'s 7 additions on top of the existing
`js/question-scout/*` modules from A49, without touching v1's public
contract: `QUESTION_SCOUT_VERSION` stays `1`, `MAX_KEEPERS` stays `5`,
`METRIC_TYPES` is unchanged, and `CHEATING_BOUNDARY_BANNER` is byte-identical.
Every v2 feature is additive, opt-in, or self-silencing on non-matching
data, so a v1-shaped session (single table, no dictionary pasted, IDR pack
toggle off) behaves exactly as it did before this PR.

### Engine additions (`js/question-scout/question-scout.js`)

- **`SCOUT_V2_VERSION = 2`** — new constant, separate from and additive to
  the untouched `QUESTION_SCOUT_VERSION = 1`.
- **Dictionary-aware prompts** — `parseDictionary(raw)` accepts JSON
  (object or `[{name/column/field, description/definition/meaning}]` array),
  CSV, or free text lines (`name - def`, `name: def`, `name = def`) and
  tolerates malformed/empty input by returning `{}` rather than throwing.
  `buildScoutPrompt(profileStrip, opts)` gained an optional second argument;
  when `opts.dictionary` is supplied and matches profiled columns, the prompt
  payload reports `dictionaryApplied: true` and `matchedDictionaryKeys[]`,
  and the field definitions are inlined into the prompt text sent to the
  on-device model. With no `opts` argument, `buildScoutPrompt` is
  byte-for-byte the v1 call.
- **Join hints (multi-table)** — `buildJoinHints(profileStrip)` compares
  column names across every pair of profiled tables for `id`/`*_id`/`code`-
  style stems and returns `{tableA, columnA, tableB, columnB, stem,
  confidence}` hints (empty array on a single-table profile).
  `joinCandidatesFromHints(hints, profileStrip)` turns high-confidence hints
  into concrete join-shaped candidate questions with real `JOIN ... ON`
  SQL, fed into the same `rankCandidates()` deterministic filter as every
  other candidate — a join candidate cannot bypass scoring.
- **Anti-vanity rank v2** — `scoreCandidate()` was hardened: `VIZ_VANITY_RE`
  was widened, a new `VAGUE_INTEREST_RE` penalty
  (`vague_interest_without_metric`) catches "interesting"/"cool"/"neat"
  framing with no metric, a new `STRONG_CHECKABLE_LANGUAGE_RE` hit
  (`strong_checkable_language`) rewards win-rate/backlog/count/rate/share/
  delta business language, and the vanity penalty weight was doubled so a
  vanity candidate scores strictly below a checkable one on the same
  profile, not just marginally lower.
- **Healthcare-idr domain pack** — `HEALTHCARE_IDR_PACK_ID` names the pack;
  `idrPackCandidates(profileStrip)` fuzzy-matches column patterns for
  dispute id, payer, provider, specialty, determination status, QPA/billed
  amount, prevailing party, and quarter/period, then emits the SPEC-named
  templates (dispute volume, closure mix, specialty concentration, win rate,
  QoQ delta) **only** when enough of those patterns are present on a table;
  it returns an empty array on any table that doesn't fuzzy-match IDR shape
  (verified against a `claims` table and a minimal unrelated table, both of
  which correctly yield zero pack candidates).
- **Browse mode hardening** — `UNVERIFIED_TAG` is a new exported constant;
  `tagAnswerForBrowse(text)` returns `{text, isUnverified, tag, displayText}`,
  a structured result the canvas UI can render as a visible badge, rather
  than v1's inline-note-only `annotateUnverifiedNumbers()` (which is kept,
  unchanged, for backward compatibility and as a fallback if an older
  engine build is ever loaded against the new canvas UI).
- **Keeper quality meter** — `keeperPassesFullFilter(keeper, profileStrip)`
  returns `{businessOwner, answerable, checkable, notVanity, passesAll,
  scoreDetail}`; `keeperQualityMeter(keepers, profileStrip)` rolls that up
  across the current keepers tray into `{total, passing, passingIds,
  failingIds, perKeeper[], label}` for direct display above the tray.
- **Export keepers JSON** — `buildKeepersExport(keepers, profileStrip)`
  builds a plain object (`kind`, `version`, `scoutV2Version`, `exportedAt`,
  `qualityMeter`, `keepers[]`); `exportKeepersJson(keepers, profileStrip)`
  serializes it to a JSON string. Both tolerate an empty keepers array
  without throwing.
- **Namespace export** — `DataGlowQuestionScout` (both the module's named
  export and `window.DataGlowQuestionScout`) now also carries
  `SCOUT_V2_VERSION`, `buildJoinHints`, `joinCandidatesFromHints`,
  `HEALTHCARE_IDR_PACK_ID`, `idrPackCandidates`, `parseDictionary`,
  `UNVERIFIED_TAG`, `tagAnswerForBrowse`, `keeperPassesFullFilter`,
  `keeperQualityMeter`, `buildKeepersExport`, `exportKeepersJson`, in
  addition to every v1 key (unchanged).

### Canvas UI additions (`js/question-scout/data-glow-question-scout-canvas.js`)

- New panel state: `_dictionaryText`, `_idrPackOn`, `_joinHints`.
- **Dictionary box** (`renderDictionaryBox()`) — a textarea for pasting/
  loading a column dictionary, read into `_dictionaryText` on
  change/blur and passed to `buildScoutPrompt(strip, {dictionary:
  _dictionaryText})` on the next Propose; and an explicit **healthcare-idr
  pack** opt-in checkbox (`_idrPackOn`) next to it, since the SPEC frames
  the pack as a "starter pack" the user turns on, not an always-on
  behavior, even though the pack self-silences on non-matching data either
  way.
- **Join hints strip** (`renderJoinHints()`) — computed on every Propose via
  `buildJoinHints()`, rendered above the propose button only when 2+ tables
  produce at least one hint; each row shows `tableA.colA ↔ tableB.colB` and
  a confidence badge.
- **Propose flow** — now also folds `joinCandidatesFromHints()` output and
  (if the toggle is on) `idrPackCandidates()` output into the candidate pool
  before ranking, and the post-propose toast reports how many join-hint and
  IDR-pack candidates were added.
- **Keeper quality meter** (`renderQualityMeter()`) — rendered directly
  above the keepers tray, showing `keeperQualityMeter()`'s label whenever
  there is at least one keeper.
- **Export keepers JSON button** (`renderExportButton()` /
  `exportKeepersDownload()`) — appears once there is at least one keeper;
  calls `exportKeepersJson()` and triggers a client-side `Blob` + temporary
  `<a download>` file save (`dataglow-question-scout-keepers.json`) — no
  server round trip, consistent with DataGlow's local-first posture.
- **Browse mode badge** — `browseAsk()`'s response handler now calls
  `tagAnswerForBrowse()` (falling back to v1's `annotateUnverifiedNumbers()`
  if an older engine build lacks the new helper) and `renderBrowse()`
  prepends a visible `UNVERIFIED` badge to any flagged assistant message, in
  addition to the inline note already baked into the display text.
- New CSS rules for `.dg-qs-dict`, `.dg-qs-idr-toggle`, `.dg-qs-join-hints`,
  `.dg-qs-join-row`, `.dg-qs-quality-meter`, `.dg-qs-export-btn`.

### Wiring changes

- **`inject_a49_question_scout.py`** — reused unmodified. The script rebuilds
  both inlined blocks directly from the current source files on every run,
  so re-running it against the v2 engine/canvas sources re-synced
  `canvas/index.html` in place with no script changes needed.
- **`canvas/integrity.manifest.json`** — hashes for both tracked
  `js/question-scout/*` entries and the overall `canvas/index.html` byte
  count re-recorded via `npm run check:canvas-integrity -- --update` after
  re-injection. Tracked module count unchanged at 70 (no new files were
  spliced into the canvas — only the two existing tracked files grew).
- **`test/a49.2-scout-v2.test.mjs`** — new pure Node test, 91 assertions, no
  browser/GPU/model download.
- **`capability-map.manifest.json`** — the existing `id: "question-scout"`
  entry was extended in place (not duplicated into a new id) since v2 ships
  behind the same `questionScout` flag and is additive to the same two
  files: `files[]` gained `test/a49.2-scout-v2.test.mjs`, `symbols[]` gained
  the 9 new exported v2 functions, and `notes` documents the v2 additions.
  `relatedFlags` is unchanged (`["questionScout"]`); `status` re-derives to
  `"shipped"` since that flag ships enabled.
- **`flags.manifest.json`** — the existing `questionScout` flag's
  `description` was extended with a short paragraph on the v2 additions;
  `enabled`, `addedInPR`, and `flagOffBehavior` are unchanged. No new flag
  was added: the SPEC's v2 additions are all reached through the same
  Question Scout panel the v1 flag already gates, and every new feature is
  independently opt-in/self-silencing rather than needing its own kill
  switch.
- **`package.json`** — new script `test:a492scoutv2`.
- **`.github/workflows/job-ci-batch-03.yml`** — new job `a49-2-scout-v2`
  (checkout → setup-node@v4 → `npm ci` → `npm run test:a492scoutv2` →
  `npm run check:canvas-integrity`), mirroring the `a49-question-scout` job
  shape exactly. The v1 job is untouched and still runs
  `test:a49questionscout` + `check:canvas-integrity` on every push.

## Acceptance criteria (SPEC §Acceptance) — status

1. **With multi-table profile, join-hint candidates appear.** ✅
   `test/a49.2-scout-v2.test.mjs` builds a `claims` + `providers` profile
   sharing `provider_id`, asserts `buildJoinHints()` finds the shared key
   with a confidence label, and `joinCandidatesFromHints()` turns it into
   candidates whose SQL actually contains a `JOIN`. A single-table profile
   is separately asserted to yield zero hints and zero join candidates.
2. **IDR pack only emits questions when columns fuzzy-match.** ✅ Test
   asserts `idrPackCandidates()` returns ≥3 candidates covering the SPEC's
   named themes against a fixture table shaped like IDR data (dispute id,
   payer/provider name, specialty, determination status, QPA amount,
   prevailing party, quarter), and returns exactly zero candidates against
   both a `claims` table and an unrelated minimal table.
3. **Vanity question scores below checkable ones in unit tests.** ✅ Test
   scores a vague/chart-only candidate and a strong checkable
   (win-rate/backlog, business language, SELECT SQL) candidate on the same
   profile and asserts the vanity score is strictly lower, that it accrues
   anti-vanity penalties, and that the checkable candidate accrues zero
   penalties. A second chart-only fixture is checked the same way.
4. **Dictionary text improves prompt payload (tested).** ✅ Test parses a
   three-line dictionary (`-`, `:`, and `=` separated forms), builds a
   prompt with and without `opts.dictionary`, and asserts
   `dictionaryApplied`/`matchedDictionaryKeys` are only set when a
   dictionary is supplied, that the dictionary-grounded prompt payload is
   strictly larger, and that the actual field definitions appear inlined in
   the prompt text. Empty and garbage dictionary strings are asserted not
   to throw.
5. **Export keepers works.** ✅ Test builds a 2-keeper tray, calls
   `exportKeepersJson()`, asserts the result is valid parseable JSON
   containing all keepers, a `scoutV2Version` stamp, an export timestamp,
   and an embedded quality-meter summary; also asserts `exportKeepersJson`
   does not throw on an empty tray, and that `buildKeepersExport()` (the
   pre-serialization object) agrees with the serialized/re-parsed output.
6. **CI green path same as A49.** ✅ The v1 suite
   (`test/a49-question-scout.test.mjs`) was re-run after every engine and
   canvas UI change in this PR and stayed at 89 passed / 0 failed
   throughout; `test/a49.2-scout-v2.test.mjs` additionally re-checks the
   highest-value v1 invariants (`QUESTION_SCOUT_VERSION`, `MAX_KEEPERS`,
   `METRIC_TYPES`, the exact `CHEATING_BOUNDARY_BANNER` string) so a v2-only
   CI run would also catch a v1 regression. Both test scripts and
   `check:canvas-integrity` are wired into CI as separate jobs.

## Test results

```
$ npm run test:a49questionscout
89 passed, 0 failed

$ npm run test:a492scoutv2
91 passed, 0 failed

$ npm run test:capmap
# tests 15
# pass 15
# fail 0

$ npm run check:capability-map
  ok  registry: 270 capability(ies) normalized to { id, title, status, relatedFlags, platforms }
  ok  status: 270 shipped, 0 behind-flag
  ok  flags: 177 declared, 110 capability(ies) flag-linked
check-capability-map: capability registry is honest against flags.manifest.json

$ npm run check:canvas-integrity
  ok  syntax: 3 inline <script> block(s) parsed
  ok  markers: 338 inlined module path(s) in canvas/index.html, 309 closing marker(s); tracked modules correctly paired
  ok  tracked: 70 module(s) verified against canvas/integrity.manifest.json
  ok  ship path: desktop stage script still stages index.html + js/
  ok  ship path: build.sh still guards canvas/index.html against a stale src/ rebuild
  ok  publish: canvas/index.html is the recorded 6471206 bytes
check-canvas-integrity: canvas bundle integrity OK
```

No other engine, flag, or test suite was modified. Proof Harness, the local
AI bridge (`window.OnDeviceLLM`), and every previously-tracked canvas module
verify byte-for-byte unchanged; the only tracked-module byte deltas are the
two Question Scout files growing to carry the v2 additions.

## Non-goals honored

Per SPEC: no cloud LLM default was introduced (the same on-device
`window.OnDeviceLLM` bridge and `Qwen2.5-1.5B` model from A49 are reused,
verified by grep in the v2 test that no cloud LLM endpoint string was added
to the engine source), no auto-prove path was added (every keeper still
requires an explicit **Send to Prove** click, unchanged from v1, and the v2
test greps for the absence of an `autoProve` code path), no general CMS
dictionary network scraper was built (`parseDictionary` only parses text the
user pastes or loads locally), and the dual-engine model (Scout proposes,
Proof Harness proves) is untouched — Question Scout v2 still only proposes
and organizes; the human still chooses keepers, and the Proof Harness still
proves every number.

## Source references

- Spec: [`A49_2_SCOUT_V2_SPEC.md`](./A49_2_SCOUT_V2_SPEC.md) (repo root)
- v1 baseline: [`A49_QUESTION_SCOUT_SPEC.md`](./A49_QUESTION_SCOUT_SPEC.md),
  [`A49_QUESTION_SCOUT_RESULT.md`](./A49_QUESTION_SCOUT_RESULT.md), merged as
  [PR #632](https://github.com/Andre-Weissmann/dataglow/pull/632)
