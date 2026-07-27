# A48 full Jobs polish (RESULT)

Implements `A48_JOBS_POLISH_FULL_SPEC.md` — the full Jobs-style GUI polish slice on top of A48 slice 0 (typography/readability, `37da994`). Branched from `main` at `37da994` (the required post-typography-merge HEAD).

Branch: `feature/a48-jobs-polish` (not merged — PR opened for review).

## Scope discipline

This repo already carries a substantial prior "HIG / Jobs polish" CSS block in `canvas/index.html` (chrome-defers-to-content, one primary action, secondary/ghost quieter, table hierarchy, theme toggle, reduced-motion). This slice **extends that existing work with the SPEC's specific rem-token ladder and applies it to buttons/tabs/panels/modals/toasts/focus**, rather than re-deriving a parallel system. Per the task's "not a total rewrite" instruction, out of scope for this PR:

- The ~450 remaining `font-size: 11px/11.5px` occurrences scattered across dozens of unrelated feature modules (recipe library, DVC fingerprint chips, Shield Packs, etc.). These sit **above** slice 0's 9-10px kill floor and are pre-existing density choices in feature-specific UI, not the shared chrome surfaces (nav/tabs/buttons/panels/modals/toasts) this SPEC calls out. Touching all ~450 would be a different, much larger PR.
- Full icon system redesign, IA/nav rename, marketing landing rewrite, animation library overhaul (explicitly out of scope per the SPEC).
- Career Lane C — not touched.
- HIPAA claims — not touched, not introduced.

## What changed

### 1. Token ladder (`canvas/index.html` — AUTHORITATIVE, `:root`)

Added the SPEC's rem-based spacing/radius/control-height/shadow tokens, theme-independent (defined once, not re-declared under `[data-theme="dark"]`, mirroring how slice 0 handled `--dg-text-*`):

```css
--dg-space-1: 0.25rem;   /* 4px */
--dg-space-2: 0.5rem;    /* 8px */
--dg-space-3: 0.75rem;   /* 12px */
--dg-space-4: 1rem;      /* 16px */
--dg-space-5: 1.25rem;   /* 20px */
--dg-space-6: 1.5rem;    /* 24px */
--dg-space-7: 2rem;      /* 32px */
--dg-space-8: 3rem;      /* 48px */
--dg-radius-sm: 0.375rem; /* 6px */
--dg-radius-md: 0.75rem;  /* 12px */
--dg-radius-lg: 1.25rem;  /* 20px */
--dg-control-h: 2.75rem;  /* ~44px primary-control hit target */
--dg-shadow-soft-sm / --dg-shadow-soft-md / --dg-shadow-soft-lg;
```

`--dg-shadow-soft-*` is re-tuned darker/more-opaque under `[data-theme="dark"]` (semantic surfaces, not an inverted light-mode hack) — same pattern the existing `--shadow-sm/--shadow-md` tokens already used.

### 2. Shared token (`css/base.css` — root `index.html` / Tauri desktop shell)

Added `--control-h: 2.75rem` alongside the existing `--space-*`/`--radius-*` scale so the desktop shell's `.btn-primary` gets the same ~44px hit-target contract as canvas, without duplicating the whole ladder (the shell already had a complete rem space/radius scale from before this slice; only the missing control-height token was added).

### 3. Buttons

- Canvas primary-button group (`.pivot-run-btn`, `button.primary`, `.btn-primary`, `#run-sql-btn`, `.run-btn`): `min-height: 44px` (literal) → `min-height: var(--dg-control-h)`; added `border-radius: var(--dg-radius-md)` and horizontal padding on the `--dg-space-4` token; shadow moved from the sharper `--shadow-sm` to the new `--dg-shadow-soft-sm`.
- `css/base.css` `.btn-primary`: added `min-height: var(--control-h)` (previously no explicit height at all — relied on padding alone). Secondary/ghost variants deliberately left without a forced min-height so they stay visually and structurally quieter, per the "calm hierarchy, one primary action" pillar.
- Secondary/ghost buttons in canvas now get an explicit quiet treatment (`background: transparent`, `border: 1px solid var(--border)`, hover raises to `--surface-2`) instead of relying only on color, so the primary/secondary contrast is visible in both themes.

### 4. Tabs

- Canvas `.tab-btn` (base rule): height was implicit (0 vertical padding, whatever line-height gave it) — now `min-height: var(--dg-control-h)`, horizontal padding and gap moved to `--dg-space-3`/`--dg-space-2` tokens, font-size moved to `--dg-text-sm`. Labels already had `overflow:hidden`/`text-overflow:ellipsis` so they never hard-clip on mobile; that behavior is preserved.
- Canvas `.tab-btn` (later cascade override, "Buttons: global style upgrade" block): literal `border-radius:6px` / `font-size:12px` / `padding:4px 12px` → `var(--dg-radius-sm, 6px)` / `var(--dg-text-sm, 0.875rem)` / `var(--dg-space-2, 4px) var(--dg-space-3, 12px)` (px fallbacks kept for defensive parsing). `.tab-btn.active`'s filled state (`background: var(--primary); color: #fff`) kept as-is — already reads as clearly "stronger."
- `css/app.css` `.tab.active` gained `font-weight: 600` (was color + underline only) so the active tab is unambiguously the strongest element in the bar, plus a new `.tab:focus-visible` rule (previously tabs had no visible keyboard-focus state of their own).

### 5. Panels / cards

`canvas/index.html` `.panel`, `.analyze-panel`, `.content-panel`, `#pivot-view`, `#sql-view`, `#excel-view`: shadow moved to `--dg-shadow-soft-sm`, added `border-radius: var(--dg-radius-md)` for a consistent card language across content surfaces (previously no radius was set on this shared rule at all).

### 6. Modals / drawers

New rule targeting the repo's actual modal implementations (there is no single shared `.modal` class in canvas — each feature ships its own: `.dg-sl-modal`, `.narrative-modal`, `.osce-modal`, `.pex-modal`, `.replay-modal-inner`, `.takehome-modal`, `.vault-modal-inner`, `.witness-modal`). All now share: `border-radius: var(--dg-radius-lg)`, `padding: var(--dg-space-6)`, `box-shadow: var(--dg-shadow-soft-lg)`, `max-width: min(90vw, 640px)` — readable width, consistent padding, calm elevation, without touching each modal's feature-specific internals.

### 7. Toasts

`window.showToast` (the global cross-module shim used by ~30+ call sites) was hardcoded: `font-size:13px`, opaque brand-color hex fills (`#16a34a`/`#dc2626`/`#d97706`/`#0891b2`) that ignored the active theme, and a raw shadow literal. Rewritten to:
- `font-size: var(--dg-text-sm, 0.875rem)` (rem, above the 0.75rem floor)
- `background: var(--surface-2)`, `color: var(--text)`, `border: 1px solid var(--border)` — theme-aware surface instead of an opaque colored box
- A thin `border-left` accent (using `--success`/`--error`/`--warning`/`--primary` role tokens, still distinguishes severity) instead of filling the whole toast with a hardcoded hex
- `box-shadow: var(--dg-shadow-soft-md)`, `border-radius: var(--dg-radius-md)`, spacing on `--dg-space-3`/`--dg-space-4`
- `max-width: min(90vw, 320px)` so it stays non-blocking on narrow viewports

This is plain inline glue code between injected modules (verified via `scripts/check-canvas-integrity.mjs` marker scan — it sits outside every tracked `from`/`end` span), so no `js/` source file needed a matching edit.

### 8. Focus-visible

Canvas's existing single-selector `:focus-visible` rule (`.pivot-run-btn`, `button.primary`, `.btn-primary`, `#theme-toggle`, `button`) was widened to also cover `.tab-btn`, `.analyze-pill`, `a`, `input`, `textarea`, `select` — so keyboard focus is visible on tabs, links, and form controls, not just buttons. `css/base.css` gained `.btn:focus-visible` (the generic `:focus-visible` rule already existed repo-wide; this adds an explicit one scoped to `.btn` for clarity/redundancy). `css/app.css` gained `.tab:focus-visible`.

### 9. Reduced motion

Both `css/base.css` and `canvas/index.html` already had a `@media (prefers-reduced-motion: reduce)` block from before this slice (global `*`/`*::before`/`*::after` animation/transition-duration override). Verified it still applies to every new/changed rule in this slice (buttons, tabs, panels, modals, toasts) since none of them define their own unguarded long-running animation — the toast's one keyframe animation (`toast-in`, `css/app.css`) is covered by the existing global override. No change needed here beyond verification; documented in the new test (see below).

### 10. Density exception respected

`.result-table` (`css/app.css`) stays on `var(--text-sm)` (clamps 0.8125rem-0.9375rem) — untouched, already comfortably above the 0.75rem floor. Verified by the new test that no literal sub-0.75rem/12px value exists on this selector.

## inject/integrity

The only canvas edit touching JS (not CSS) was the `showToast` shim rewrite. Confirmed via `npm run check:canvas-integrity` marker scan that this code sits **outside** every tracked `/* ---- from <path> ---- */ ... /* ---- end <path> ---- */` span (it is glue code between injected modules, not a mirrored `js/` module), so no `js/` source file required a matching edit. Re-ran `npm run check:canvas-integrity -- --update` to re-record `canvasBytes` (6,367,239 → 6,372,616, +5,377 bytes) after manually reviewing the diff (this RESULT doc *is* that review). All 68 tracked module hashes are byte-identical before and after — only the whole-file size changed, exactly as expected. `npm run check:canvas-integrity` now passes clean.

## Tests

New `test/jobs-polish-a48.test.mjs` (pure Node, no browser/DOM), wired as `npm run test:jobspolisha48` and into a new `jobs-polish-a48` CI job in `.github/workflows/job-ci-batch-03.yml` (also runs `npm run check:canvas-integrity`, same pattern as the `typography-readability` job). 46 assertions, all passing:

- All `--dg-space-1..8` / `--dg-radius-sm/md/lg` / `--dg-control-h` / `--dg-shadow-soft-*` tokens are defined in `canvas/index.html`.
- `--control-h` is defined in `css/base.css`.
- Control-height tokens resolve to rem, never a bare px literal.
- `.btn-primary` (both surfaces) and canvas's primary-button group consume the control-height token rather than a hardcoded `44px`.
- No `font-size: 9px/9.5px/10px/10.5px` relapse in `canvas/index.html`, `css/base.css`, or `css/app.css` (re-asserts slice 0's floor).
- `.result-table` never drops below the 0.75rem/12px density floor.
- `:focus-visible` coverage exists on buttons, tabs, and form controls in both `css/base.css`/`css/app.css` and canvas (not just one selector).
- `prefers-reduced-motion` is honored in both `css/base.css` and `canvas/index.html`.
- Tab active/inactive visual distinction exists in both `css/app.css` and canvas.
- No em dash was introduced in this slice's new token block or the `showToast` doc comment.

Also re-ran the pre-existing suites that exercise touched/adjacent surfaces to confirm no regressions:
- `npm run test:typographyreadability` — 41/41 passed (slice 0 contract still holds).
- `npm run test:glassbox` — 32/32 passed (includes its own "no em dash in visible product text" check).
- `npm run test:proofboard` — 286/286 passed (includes its own em-dash check).
- `npm run test:mobilesmoke` — 39/39 passed across android-360/iphone-390/breakpoint-700 (44px targets, no horizontal trap, core chrome mounted).
- `npm run test:e2e` — full engine-ready → golden-dataset-load → validation-run → export flow passed (DuckDB-WASM engine, Proof Harness exports, Time Machine, Synthetic Twin all functional — confirms engines/proof-harness/SQL path untouched in behavior).
- `npm run check:canvas-integrity` — clean.

## Files changed

- `canvas/index.html` — new rem token ladder in `:root` (light + dark shadow variants), primary/secondary button polish, tab-bar polish (both the base rule and the later cascade override), panel/card radius+shadow, new modal selector group, rewritten `showToast` shim, widened `focus-visible` selector group.
- `canvas/integrity.manifest.json` — `canvasBytes` re-recorded after the reviewed edit (tracked module hashes unchanged).
- `css/base.css` — new `--control-h` token, `.btn-primary` min-height, `.btn:focus-visible`.
- `css/app.css` — `.tab.active` font-weight, `.tab:focus-visible`.
- `package.json` — new `test:jobspolisha48` script.
- `.github/workflows/job-ci-batch-03.yml` — new `jobs-polish-a48` CI job.
- `test/jobs-polish-a48.test.mjs` — new pure Node test (46 assertions).

## Acceptance checklist (from SPEC)

- [x] Spacing tokens `--dg-space-1..8` in rem
- [x] Radius tokens `--dg-radius-sm/md/lg`
- [x] Shadow tokens (soft elevation only) — `--dg-shadow-soft-sm/md/lg`
- [x] Control height token `--dg-control-h` (~2.75rem / 44px target for primary buttons)
- [x] Header/nav: pre-existing chrome-defers treatment kept; not regressed
- [x] Tab bar: active state stronger, inactive quieter; labels never clip on mobile
- [x] Panels/cards: consistent padding/radius using space/radius tokens
- [x] Modals/drawers: max-width readable (`min(90vw, 640px)`), backdrop calm (pre-existing `rgba(13,27,42,0.55)` kept)
- [x] Toasts: readable, non-blocking, good contrast in both themes
- [x] Primary buttons: solid accent, min-height token
- [x] Secondary/ghost: quieter border
- [x] Focus-visible rings widened to tabs/inputs/links, not just buttons
- [x] prefers-reduced-motion verified honored (pre-existing global rule, confirmed to cover all new/changed rules)
- [x] Data tables never below 0.75rem (verified, unchanged)
- [x] No em dash (U+2014) introduced in visible product text
- [x] Engines / Proof Harness / SQL path behavior unchanged (verified via `test:e2e` full flow)
- [x] Career Lane C not touched
- [x] Canvas integrity clean (`npm run check:canvas-integrity` passes)
- [x] PR open (not merged)

## Residuals (deferred, next slice)

- The ~450 remaining `font-size: 11px/11.5px` occurrences in feature-specific modules (Recipe Library, DVC, Shield Packs, meeting scribe, etc.) — pre-existing, above the 9-10px kill floor, out of scope for a focused chrome-polish slice.
- Per-modal-family CSS consolidation (8 different modal class families currently share only the new SPEC rule, not a unified base class) — would require touching each feature's markup, out of scope for a CSS-only polish pass.
- Full icon system redesign, IA/nav rename, marketing landing rewrite, animation library overhaul (explicitly out of scope per the SPEC's own "later slices" list).
