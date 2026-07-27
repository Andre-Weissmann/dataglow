# A50 Jobs Calm Polish RESULT

Implements `A50_JOBS_CALM_POLISH_SPEC.md` on branch `feature/a50-jobs-calm-polish`.

## Summary

DataGlow's calm customer journey (Drop or sample -> Purpose -> See health ->
Ask (Scout) -> Prove (VERDICT) -> Export receipt) was mostly built already,
but three things worked against the "calm product, not toolkit chrome" goal:

1. The post-load spotlight offered 4 generic shortcuts (Visualize / SQL /
   Findings / Statistics) instead of the SPEC's 3-action journey shape.
2. **The post-load spotlight never actually appeared.** A leftover Mission
   Brief `init()` unconditionally overwrote `window._dgSpotlight` with a
   no-op on every load -- a pre-existing dead-code bug, not something this
   slice introduced. Mission Brief itself had already been disabled
   ("QW1: Mission Brief removed -- fold into drop zone per UX audit"), but
   the no-op override was left behind and silently killed the very feature
   meant to replace it.
3. The purpose contract panel asked users to pick cold from 5 options with
   a two-sentence legal-sounding intro, instead of offering one obvious
   default.

All three are fixed below, plus the toolbar-overflow guardrail, Scout
cold-start UI, and 16px-min mobile body text the SPEC also asked for.

## Before / after

### Post-load spotlight (SPEC #3)
- **Before:** 4 buttons (Visualize -> charts-view, Query with SQL -> sql-view,
  See Findings -> dashboard-view, Run Statistics -> stats-view), and it never
  rendered in practice because of the `_dgSpotlight` no-op bug above.
- **After:** 3 buttons -- Clean & Validate (`review-view`), Ask (Scout)
  (`data-action="open-scout"`, clicks the existing floating
  `#dg-question-scout-btn`), Prove (VERDICT) (`data-action="open-verdict"`,
  clicks the existing floating `#dg-proof-harness-btn`). Reuses the existing
  panels, no new UI surfaces. The `_dgSpotlight` clobbering bug is fixed so
  this now actually renders after data loads -- confirmed live via the
  screenshots below (both desktop and mobile).

### Home hero (SPEC #1)
- **Before:** the advanced-tools floating row (Trust Ledger, Air-Gap, Shield
  Packs, Proof Harness, Question Scout buttons) rendered at full opacity even
  before any data was loaded, competing with the single "Drop your data here"
  CTA for attention.
- **After:** `body:not(.has-data)` fades that row to `opacity: 0.35` with
  `pointer-events: none` (not `display: none`, so there is no focus trap and
  no layout shift when data loads); `body.has-data` restores full opacity and
  interactivity. `prefers-reduced-motion` is honored (no transition).

### Toolbar overflow (SPEC #2)
- Audited the whole file for the letter-clipping pattern
  (`overflow:hidden` + `white-space:nowrap` without `text-overflow`) -- found
  zero existing instances, so there was no active bug here. Added an explicit
  guardrail rule (`overflow:visible`, `text-overflow:clip`,
  `min-width:max-content`) on `.nav-btn`, `#publish-btn`, `#export-btn`,
  `#nav-overflow-btn` as insurance against a future regression, and the new
  A50 contract test asserts the letter-clip pattern never reappears anywhere
  in the file.

### Scout cold-start (SPEC #4)
- **Before:** `propose()` already degraded gracefully to template questions
  when the on-device model was cold or absent (no forced download, no blank
  hang) -- but there was no visible indicator of that *before* a user clicked
  Propose; the only signal was a toast shown *after* the click.
- **After:** a calm status row (`renderModelStatus()` in
  `js/question-scout/data-glow-question-scout-canvas.js`, re-injected into
  `canvas/index.html`) shows "On-device model is not loaded yet. You can
  start now with template questions, no waiting." with a "Use templates now"
  button, before Propose is clicked. It self-silences once a proposal has run
  or the model warms up, and its button is wired to the exact same
  `propose()` fallback path -- no second engine, no new cold-start logic.

### Purpose contract (SPEC #5)
- **Before:** "Declare why you are using this dataset. Your declaration
  becomes a signed contract that governs how the data may be used and for
  how long." (two sentences), and no purpose was pre-selected -- users chose
  cold from 5 equally-weighted options.
- **After:** "Why are you using this dataset? Your answer becomes a signed,
  time-limited contract." (one sentence, same meaning). `Analysis &
  Reporting` is marked with a quiet "RECOMMENDED" badge and is pre-selected
  on open via the exact same selection code path a real click uses (no
  duplicated logic) -- so the Sign Contract button is enabled immediately,
  but every other purpose remains one click away and nothing was removed.

### Typography / spacing (SPEC #6)
- Added a scoped `@media (max-width: 700px)` rule enforcing 16px minimum
  body text (and 1.5 line-height) on the calm-journey surfaces this slice
  touches: the purpose contract panel's paragraph/purpose descriptions/note
  textarea, the Scout cold-start status text, and the spotlight subtitle.
  Deliberately scoped, not a blanket rewrite -- dense data-grid and
  code-editor surfaces intentionally keep smaller monospace text for
  density, which is out of scope per the SPEC's "not a total rewrite" intent.

### No em dash (SPEC #7)
- All new visible strings and all A50-tagged comment blocks were scanned
  programmatically for U+2014; the automated test (`test/a50-jobs-calm-polish.test.mjs`)
  asserts zero matches. Pre-existing em dashes elsewhere in the 6.4MB canvas
  file were left alone (out of scope, matches the additive-only precedent
  from A48/A49).

### Proof of polish (SPEC #8)
Screenshots at `docs/a50-jobs-calm-polish/` (desktop 1280x900, mobile
375x812), captured with a Playwright harness
(`test/_screenshot-a50-jobs-calm-polish.mjs`) that drives the real app end to
end (load a file -> dismiss the unrelated data-pulse import summary -> sign
the pre-selected purpose contract -> see the spotlight):

- `desktop-1280-home.png` / `mobile-375-home.png` -- home hero, single CTA
  path, advanced tools demoted.
- `desktop-1280-post-load-purpose-contract.png` / `mobile-375-post-load-purpose-contract.png`
  -- purpose contract with the shortened copy and "Analysis & Reporting"
  pre-selected + RECOMMENDED badge.
- `desktop-1280-post-load-contract-signed.png` / `mobile-375-post-load-contract-signed.png`
  -- signed-contract receipt.
- `desktop-1280-post-load.png` / `mobile-375-post-load.png` -- the 3-action
  post-load spotlight (Clean & Validate / Ask (Scout) / Prove (VERDICT)).

## Files touched

- `canvas/index.html` (AUTHORITATIVE) -- spotlight markup/CSS/JS (both
  duplicate real occurrences kept in sync, matching the file's existing
  tolerated double-`</html>` structure), home-hero demotion CSS, toolbar
  guardrail CSS, purpose-contract copy + default-selection logic, 16px-min
  mobile CSS, removal of the `window._dgSpotlight` no-op override inside the
  disabled Mission Brief module's `init()`. Re-injected Question Scout
  canvas UI changes from source via `inject_a49_question_scout.py`.
- `js/question-scout/data-glow-question-scout-canvas.js` -- added
  `renderModelStatus()`, wired it into `renderBody()`, added the "Use
  templates now" click handler in `wireBodyEvents()`, added CSS for
  `.dg-qs-model-status` / `.dg-qs-model-status-dot` / `.dg-qs-use-templates-btn`
  in `ensureStyles()`.
- `canvas/integrity.manifest.json` -- re-recorded hashes/bytes via
  `npm run check:canvas-integrity -- --update` after all edits.
- `test/a50-jobs-calm-polish.test.mjs` (new) -- 56-assertion contract test
  covering all 8 SPEC requirements plus the spotlight dead-code fix.
- `test/_screenshot-a50-jobs-calm-polish.mjs` (new) -- Playwright screenshot
  harness (ad-hoc, prefixed `_` per this repo's existing convention for
  harnesses under `test/`, not registered as an `npm test:*` script).
- `docs/a50-jobs-calm-polish/*.png` (new) -- proof-of-polish screenshots.
- `package.json` -- added `test:a50jobscalmpolish` script.
- `.github/workflows/job-ci-batch-03.yml` -- added `a50-jobs-calm-polish` CI
  job (runs the new test, `check:canvas-integrity`, `check:capability-map`).
- `A50_JOBS_CALM_POLISH_SPEC.md` -- the spec this result implements.

## Tests

All green, no regressions:

- `npm run test:a50jobscalmpolish` -- 56 passed, 0 failed (new).
- `npm run check:canvas-integrity` -- ok (70 tracked modules verified,
  bundle byte count re-recorded).
- `npm run check:capability-map` -- ok (270 capabilities, 0 behind-flag).
- `npm run test:a49questionscout` -- 89 passed, 0 failed (unaffected).
- `npm run test:a492scoutv2` -- 91 passed, 0 failed (unaffected).
- `npm run test:jobspolisha48` -- 46 passed, 0 failed (unaffected).
- `npm run test:higcrossplatform` -- 63 passed, 0 failed (unaffected).

## Out of scope (per SPEC)

No new engines, no Career Lane C, no Maven clones, no full BI dashboards.
The pre-existing 1,768 em dashes already in `canvas/index.html` outside this
slice's own new strings were left alone, matching the additive-only
precedent set by A48/A49.

## Ship

- Branch: `feature/a50-jobs-calm-polish` (from `main`).
- PR: opened as `DO NOT MERGE:` -- not merged, pending parent confirmation.
