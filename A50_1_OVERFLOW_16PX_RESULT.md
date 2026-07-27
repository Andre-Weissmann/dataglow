# A50.1 Toolbar overflow + full 16px type scale -- RESULT

Implements `A50_1_OVERFLOW_16PX_SPEC.md` on branch `feature/a50-1-overflow-16px`.

## Root cause

`#nav-right` (inside `#top-nav`) accumulates 17 buttons injected by ~16-19
independent "mount a floating tool button" functions scattered through
`canvas/index.html`, each appending an `inline-flex` button with no wrap.
Measured via a headless Chromium load of `canvas/index.html` before any fix:
`#nav-right` rendered at 1481px wide inside a 1440px-constrained `#top-nav`,
pushing `document.documentElement.scrollWidth` to 1774px at both 1280 and
1440 viewport widths (494px and 334px of horizontal overflow respectively --
in the same ballpark as the SPEC's live-inspect number). VERDICT and
Question Scout, the last two buttons in that row, were pushed off-screen at
both widths.

## Fix: requirement 1 + 2 (toolbar overflow, no letter-clipping)

Reused the existing "More tools" grid popover (`#dg-overflow-popover` /
`#dg-overflow-grid`, already shipped for the mobile agent-bar's
`#agent-bar-more-btn`) instead of inventing a new pattern:

- Added a second, **desktop-visible** trigger, `#nav-tools-btn`, inside
  `#nav-right` (a "Tools" button with a 4-square icon), wired to open the
  exact same popover as `#agent-bar-more-btn`. Both buttons now share one
  `toggleOverflowFrom()` handler and one `setOverflowTriggersExpanded()`
  helper (`canvas/index.html`, the `js/nav/bottom-nav.js`-marked block).
- Added `VERDICT` (`data-target="dg-proof-harness-btn"`) and
  `Question Scout` (`data-target="dg-question-scout-btn"`) as the **first
  two entries** in `#dg-overflow-grid`, so they can never be scrolled or
  pushed out of the grid.
- Added the rest of the overflow-causing cluster (Trust Ledger, Air-Gap
  Mode, Shield Packs, PHI Shield, Explain, Proof Board, Transforms, Excel
  Hell Repair, Guided Unpivot, Semantic Layer, Stayed Local) as further grid
  entries with the same `data-target` -> real-button click-forwarding
  pattern the grid already used for Live Wire/Receipt/Notes/etc. Every real
  button stays in the DOM and keyboard-reachable; nothing is reimplemented,
  only relocated in the visible layout.
- Added `@media (min-width: 701px) { #nav-right #dg-trust-ledger-btn, ... {
  display: none !important; } }` to remove those 11 buttons from
  `#nav-right`'s visible flex flow at desktop widths, which is what actually
  stops `#nav-right` from growing past its container. This is a **separate**
  rule from the pre-existing A50 Jobs-calm-polish pre-load opacity-demotion
  block (`body:not(.has-data) #dg-trust-ledger-btn, ...`), which is left
  completely untouched -- its `opacity`/`pointer-events` contract for
  `body.has-data` still applies exactly as before, verified by the existing
  `test/a50-jobs-calm-polish.test.mjs` suite (56/56 still pass).

Verified via a headless Chromium load of the patched `canvas/index.html`:

| viewport | scrollWidth before | scrollWidth after | clientWidth |
|---|---|---|---|
| 1280 | 1774 | 1280 | 1280 |
| 1440 | 1774 | 1440 | 1440 |

No overflow with the "More tools" grid open either (it is `position: fixed`,
so it never contributes to `document.documentElement.scrollWidth`). No
button anywhere on the toolbar has `scrollWidth > clientWidth` while
`overflow: hidden` (the letter-clipping pattern), checked both statically
(no CSS rule combines `overflow:hidden` + `white-space:nowrap` without
`text-overflow`) and live in the browser.

## Fix: requirement 3 (16px type scale) + requirement 4 (primary CTA)

Reused the `--dg-text-md` (1rem/16px) and `--dg-text-sm` (0.875rem/14px)
rem tokens already established in `canvas/index.html`'s `:root` by the prior
A48 typography PR. Raised to `var(--dg-text-md, 1rem)` (16px):

- Top-nav chrome: `.nav-btn` (Data/Analyze/Output tabs), `#nav-tools-btn`,
  `#publish-btn` (Share), `#export-btn`, `.privacy-badge` (both of its two
  cascading definitions), `#nav-overflow-btn`'s menu (`.nav-overflow-item`),
  `#agent-bar-more-btn`.
- The new `.dg-ov-btn` More-tools grid labels (VERDICT/Question Scout's own
  new reachability path, so this counts as nav labels under the SPEC).
- Primary CTA `.dg-cta-primary` ("Load sample data") on **desktop** -- it
  was already 16px on mobile via an existing `@media (max-width: 700px)`
  rule, now 16px on both, satisfying requirement 4 directly. Verified live:
  16px at both 1440px and a 390px mobile viewport.
- Secondary CTA `.dg-cta-ghost` ("Drop my own file").
- The post-load 3-action spotlight (`.spotlight-btn-label`, `.spotlight-skip`)
  -- the primary helper path a person sees immediately after loading data.
- The PHI first-run strip's title and primary button
  (`js/intelligence/data-glow-mobile-phi-firstrun-canvas.js`, tracked module
  -- edited in `js/` and re-injected, see Canvas integrity below).
- The RECEIPT spine's permanent bottom rail base text, step buttons, ledger
  button, and chip (`js/spine/data-glow-receipt-spine-canvas.js`, tracked
  module -- same treatment).

Raised to `var(--dg-text-sm, 0.875rem)` (the 14px caption floor, "strong
contrast" per the SPEC, unchanged colors which were already `var(--text-muted)`
against the app's existing contrast-checked surfaces):

- `.spotlight-sub`, `.spotlight-btn-desc` (spotlight helper copy).
- Landing/ceremony copy: `#ceremony-tagline`, `#ceremony-privacy`,
  `.dg-flow-text`, `.dg-flow-num`, `#drop-formats`, `.proof-badge`,
  `#browse-link`, `#try-example-link` -- consolidated into one override
  block placed last in the main stylesheet (so it wins the cascade over
  several earlier, lower-priority definitions of the same selectors
  accreted across prior PRs, without deleting any of those earlier rules).
- The PHI first-run strip's body copy and the RECEIPT spine's note/detail
  text (same two tracked modules as above).

**Deliberately out of scope**, consistent with the prior A48 typography
PR's stated exception: dense data-grid/table cells (e.g. `.dvc-col-table`),
chart-layout font-size math, and a long tail of deep secondary-feature
chrome not implicated by the SPEC's overflow/CTA problem statement (Meeting
bar chip, Notes panel label, Publish panel title/buttons, MCP status pill,
formula cell reference, Semantic Search toggle, Drillfloor trigger label,
and a couple of modal headers). These remain at 11-13px; a full sweep of
every leaf string in the app is a materially larger, separate effort the
SPEC's own "~90% of leaf text" framing does not require to be finished in
one PR to fix the reported toolbar-overflow and primary-flow readability
bug.

## Requirement 5 (canvas authoritative, no em dash)

All edits were made directly in `canvas/index.html`. No U+2014 em dash was
introduced in any new visible string or in any new A50.1-tagged comment
block (checked both by static scan and by the new test file below); this
codebase already uses ASCII `--` in comments for the same reason, which is
the convention followed here too.

## Requirement 6 (tests)

New file `test/a50-1-overflow-16px.test.mjs` (run via
`npm run test:a50-1overflow16px`), 47 assertions:

- Static: `#nav-tools-btn` markup present; VERDICT/Question Scout present as
  grid targets; shared toggle handler wired; the desktop-hide rule for the
  advanced cluster exists; the pre-existing A50 Jobs-calm-polish opacity
  block is untouched; no em dash in any new visible string or new
  A50.1-tagged comment block.
- Live (Playwright/Chromium) at 1280 and 1440: no document-level horizontal
  overflow, `#nav-tools-btn` itself on-screen, VERDICT and Question Scout
  reachable in the opened grid, no new overflow while the grid is open, no
  letter-clipping on any visible button.
- Font-size floor sample: body, `.nav-btn`, `#nav-tools-btn`, `#publish-btn`,
  `#export-btn`, `.privacy-badge`, `.dg-ov-btn`, `.dg-cta-primary`,
  `.dg-cta-ghost`, `.spotlight-btn-label` all >=16px; `.spotlight-btn-desc`
  >=14px.

All pass: `47 passed, 0 failed`.

Existing suites re-run for regressions, all still pass:
- `npm run test:a50jobscalmpolish` -> `56 passed, 0 failed`
- `npm run test:typographyreadability` -> `41 passed, 0 failed`

## Canvas integrity

Two tracked modules were edited as part of the type-scale sweep
(`js/intelligence/data-glow-mobile-phi-firstrun-canvas.js` and
`js/spine/data-glow-receipt-spine-canvas.js`). The identical edit was
ported to both the `js/` source file and its inlined `canvas/index.html`
section (verified byte-identical after stripping the from/end markers),
then `npm run check:canvas-integrity -- --update` re-recorded the
`sourceSha256`/`canvasSectionSha256`/`canvasSectionBytes` entries and the
whole-file `canvasBytes` size. `js/nav/bottom-nav.js`'s inlined block (the
new `#nav-tools-btn` wiring) is not a tracked module in
`canvas/integrity.manifest.json`, so it required no source-file mirror, only
the `canvasBytes` size update.

Final state: `npm run check:canvas-integrity` -> `canvas bundle integrity
OK` (all checks pass, including the whole-file byte-size check).

## Files changed

- `canvas/index.html` -- all of the above.
- `js/intelligence/data-glow-mobile-phi-firstrun-canvas.js` -- type-scale
  sweep, kept in sync with its canvas-inlined copy.
- `js/spine/data-glow-receipt-spine-canvas.js` -- type-scale sweep, kept in
  sync with its canvas-inlined copy.
- `canvas/integrity.manifest.json` -- re-recorded hashes/size after the
  intentional edits above.
- `test/a50-1-overflow-16px.test.mjs` -- new test file (see above).
- `package.json` -- added the `test:a50-1overflow16px` script entry.
- `A50_1_OVERFLOW_16PX_RESULT.md` -- this file.

## Spec reference

`A50_1_OVERFLOW_16PX_SPEC.md` (repository root of this workspace).
