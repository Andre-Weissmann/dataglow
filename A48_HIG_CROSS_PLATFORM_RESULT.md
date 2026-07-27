# A48 HIG cross-platform (RESULT)

Implements `A48_APPLE_HIG_CROSS_PLATFORM_SPEC.md` — Apple HIG as the craft bar on **every** platform DataGlow ships to (web, Tauri desktop on Windows/macOS/Linux, Android/iOS PWA/responsive), on top of the #630 Jobs-polish token ladder (`547e168`).

Branched from `main` at `547e168` (the required post-Jobs-polish HEAD).

Branch: `feature/a48-hig-cross-platform` (not merged — PR opened for review).

## Scope discipline

This repo already had substantial HIG groundwork before this slice:

- The #630 Jobs-polish rem token ladder (`--dg-space-*`, `--dg-radius-*`, `--dg-control-h`, `--dg-shadow-soft-*`) and its button/tab/panel/modal/toast/focus-visible polish.
- A pre-existing "PR #557 — UX Hardening Pass" block in `canvas/index.html` that already covers: `--safe-top/bottom/left/right` (`env(safe-area-inset-*)`) applied to `#top-nav`/`body`/`#status-bar`/`.autopilot-panel`; a `@media (pointer: coarse)` 44px hit-target bump on a broad selector list; the mobile bottom nav (`#dg-bottom-nav` / `.dg-tab`, already 56px tall with its own `env(safe-area-inset-bottom)` padding); an iPadOS/wide-screen layout query; and colorblind-safe proof indicators.
- 147 existing `aria-label` occurrences across canvas.
- A cross-platform font stack (`'Geist', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, ...`) already in place from the A48 typography/readability slice.

Given the SPEC's own "no engine changes" / "not a total rewrite" framing, this slice is **additive**, not a re-derivation:

- It does **not** duplicate the PR #557 safe-area rules on `#top-nav`/`body`/`#status-bar`/`#dg-bottom-nav` — those already work correctly. Instead it introduces the SPEC's specifically-named `--dg-safe-*` rem-ladder-consistent tokens as the contract any *new* chrome should use, and applies them to a genuinely new surface class (`#dg-command-bar` / `.dg-command-surface`) so a future feature doesn't have to hand-roll `env()` calls again.
- It does **not** re-target `#dg-bottom-nav .dg-tab`'s existing 56px hit target down to the new 44px `--dg-touch-min` floor — doing so via a higher-specificity selector would have been a regression (documented inline in the CSS as the reason it was deliberately excluded).
- It does **not** attempt a full hex-color sweep of every feature module (Recipe Library, DVC, Shield Packs, etc.) — the #630 RESULT already documented that as an explicit, larger, out-of-scope residual; a spot search for hardcoded chrome-level hex outside what #630 already fixed (toasts, buttons, modals, panels) found none.
- No Career Lane C, no engine behavior changes, no native SwiftUI/Fluent/Material You forks.

## What changed

### 1. Tokens (`canvas/index.html` :root — AUTHORITATIVE)

Added alongside the existing #630 ladder, theme-independent (defined once, not re-declared under `[data-theme="dark"]`):

```css
--dg-safe-top: env(safe-area-inset-top, 0px);
--dg-safe-bottom: env(safe-area-inset-bottom, 0px);
--dg-safe-left: env(safe-area-inset-left, 0px);
--dg-safe-right: env(safe-area-inset-right, 0px);
--dg-touch-min: 2.75rem;   /* WCAG 2.5.5 / HIG hit-target floor, distinct from --dg-control-h */
--dg-hairline: 1px;        /* crisper 0.5px on >=2dppx displays via a resolution query */
```

`env(safe-area-inset-*)` resolves to `0px` on any platform without a notch/home-indicator (Windows, Android, most desktop browsers), so defining and consuming these tokens is free everywhere outside a real device notch — this is the literal mechanism behind "Apple HIG craft bar on all platforms, not iOS-only cosplay."

### 2. Shared tokens (`css/base.css` — root `index.html` / Tauri desktop shell)

Mirrors the canvas tokens under the shell's existing (unprefixed) naming convention, the same pattern `--control-h` already used to mirror `--dg-control-h`:

```css
--safe-top / --safe-bottom / --safe-left / --safe-right: env(safe-area-inset-*, 0px);
--touch-min: 2.75rem;
--hairline: 1px;   /* + a min-resolution: 2dppx override to 0.5px */
```

### 3. Safe-area application

- Canvas: new `#dg-command-bar` / `.dg-command-surface` selector group consumes `--dg-safe-*` via `max(--dg-space-2, --dg-safe-*)` on all four sides, as the contract for any new chrome surface. Existing `#top-nav`/`body`/`#status-bar`/`#dg-bottom-nav` safe-area handling from PR #557 is untouched.
- `css/app.css` `.topbar`: added `padding-top: var(--safe-top, 0px)` and `height: calc(56px + var(--safe-top, 0px))` so the desktop-shell topbar also clears a notch when installed as a PWA (no-op elsewhere).
- `css/app.css` `.toast-container`: bottom/right offsets now add `var(--safe-bottom, 0px)` / `var(--safe-right, 0px)` so a toast never sits under a home-indicator or rounded corner.

### 4. Touch-min (2.75rem / ~44px hit-target floor)

Distinct token from `--dg-control-h` (which sizes a control's own box) — `--dg-touch-min`/`--touch-min` is the WCAG 2.5.5 hit-target floor this slice enforces:

- Canvas: primary buttons, `.top-nav`/`#top-nav` links and buttons, `.sidebar` links and buttons.
- `css/base.css`: `.btn-primary`, `.topbar-right .icon-btn`, `.tab`.
- Deliberately **not** applied to `#dg-bottom-nav .dg-tab` (already 56px; see Scope discipline above).

### 5. Coarse-pointer hit targets

New `@media (pointer: coarse)` blocks (additive to the pre-existing PR #557 coarse-pointer block, which already covers buttons/inputs/selects with a 44px literal) in both canvas and `css/base.css`, driving the same floor from the new token so it can be retuned in one place:

```css
@media (pointer: coarse) {
  button, [role="button"], .btn, input, select, textarea, .tab-btn, .analyze-pill, .chip, .pivot-chip {
    min-height: var(--dg-touch-min); /* or var(--touch-min) in css/base.css */
  }
}
```

### 6. Semantic label styles (HIG type roles)

New utility classes built entirely on the existing rem type ladder (`--dg-text-*` in canvas, `--text-*` in `css/base.css`) — no new hardcoded font sizes:

- Canvas: `.dg-label-title` / `.dg-label-headline` / `.dg-label-body` / `.dg-label-callout` / `.dg-label-caption` / `.dg-label-footnote`.
- `css/base.css`: `.label-title` / `.label-headline` / `.label-body` / `.label-callout` / `.label-caption` / `.label-footnote`.

### 7. Calm forms

New `.dg-field` (canvas) / `.field` (`css/base.css`) pattern: label above the field, caption-size (`--dg-text-xs`/`--text-xs`) helper text, and error copy that uses the semantic `--error`/`--color-error` role token (calm, theme-aware) rather than a hardcoded scream-red hex. Inputs get the `--dg-touch-min`/`--touch-min` floor and bump font-size to the body token under `@media (pointer: coarse)` so mobile keyboards don't auto-zoom on focus.

### 8. Calm empty / loading states

New `.dg-empty-state` / `.dg-empty-state-title` / `.dg-empty-state-body` (canvas, body copy capped at `42ch` so it stays short and scannable) and `.dg-loading-inline` / `.dg-loading-spinner` (non-blocking inline indicator, not a full-app blocker), mirrored in `css/base.css` as `.loading-inline` / `.loading-spinner`. The spinner has its own `prefers-reduced-motion` override (`animation: none; opacity: 0.6`) in addition to the existing global override, since it introduces a new named `@keyframes`. Pre-existing calm-loading/empty-state infrastructure (`.dg-skeleton`, `#sql-status.loading`, `#py-status.loading`, `.empty-state` in `css/app.css`, `.pivot-empty-state`) was left as-is — these new classes are additive reusable utilities, not a replacement.

### 9. Hairline separators

`--dg-hairline`/`--hairline` defined at `1px`, upgraded to `0.5px` under `@media (min-resolution: 2dppx)` — a resolution-based progressive enhancement, not a platform fork, so a 2x+ panel on Windows/Android/macOS/Linux all qualify equally.

### 10. Cross-platform font-stack verification (no iOS-only cosplay)

Audited every `font-family` declaration across `canvas/index.html`, `css/base.css`, and `css/app.css` referencing Apple system fonts (`-apple-system`, `BlinkMacSystemFont`, `SF Pro`). Every one already carries a Windows (`Segoe UI`) and/or Android (`Roboto`)/`system-ui` fallback — zero offenders found. No change needed; the new test (below) asserts this holds going forward.

### 11. Semantic labels via `aria-label`

Verified 147 existing `aria-label` occurrences in canvas already cover close/delete/clear actions across modals and panels — satisfies the SPEC's "semantic labels" accessibility bullet; no gap found requiring new markup in this CSS-scoped slice.

## Files changed

- `canvas/index.html` — new `--dg-safe-*`/`--dg-touch-min`/`--dg-hairline` tokens in `:root`; new "A48 HIG cross-platform" CSS block (safe-area application, hairline progressive enhancement, semantic label utilities, touch-min enforcement, coarse-pointer bump, calm-forms utilities, calm empty/loading utilities).
- `canvas/integrity.manifest.json` — `canvasBytes` re-recorded after the reviewed CSS-only edit (all 68 tracked module hashes unchanged; edit sits outside every tracked `js/` mirror span).
- `css/base.css` — matching `--safe-*`/`--touch-min`/`--hairline` tokens; matching CSS block (safe-area on `body`, semantic label utilities, touch-min on `.btn-primary`/`.icon-btn`/`.tab`, coarse-pointer bump, `.field`/`.loading-inline` utilities).
- `css/app.css` — `.topbar` safe-area top padding/height; `.toast-container` safe-area bottom/right offsets.
- `package.json` — new `test:higcrossplatform` script.
- `.github/workflows/job-ci-batch-03.yml` — new `hig-cross-platform-a48` CI job (mirrors the `jobs-polish-a48` job pattern: runs the new test + `check:canvas-integrity`).
- `test/a48-hig-cross-platform.test.mjs` — new pure-Node test (63 assertions).

## Tests

New `test/a48-hig-cross-platform.test.mjs` (pure Node, no browser/DOM), wired as `npm run test:higcrossplatform` and into a new `hig-cross-platform-a48` CI job. 63 assertions, all passing:

- Safe-area tokens (`--dg-safe-top/bottom/left/right`, `--safe-top/bottom/left/right`) are defined via `env(safe-area-inset-*)` and actually consumed somewhere, not just declared.
- `--dg-touch-min`/`--touch-min` resolve to exactly `2.75rem`, and are consumed by a real `min-height` (including `.btn-primary` specifically).
- Hairline tokens are defined with a `min-resolution: 2dppx` progressive enhancement in both surfaces.
- At least two independent `@media (pointer: coarse)` blocks exist in canvas (the pre-existing PR #557 one plus this slice's new token-driven one), and both surfaces have a coarse-pointer block driven by the new touch-min token.
- All six semantic label utility classes exist in both surfaces, built on existing rem type tokens (verified no hardcoded px font-size crept into that block).
- Calm-forms contract: label-above-field container, caption-size helper text, and error color using the semantic role token (not a hardcoded hex) in both surfaces.
- Calm empty/loading utilities exist; empty-state body copy is width-capped; the loading spinner has its own `prefers-reduced-motion` override.
- No Apple-only font stack anywhere in the three files (every `-apple-system`/`BlinkMacSystemFont`/`SF Pro` mention also carries `Segoe UI`/`Roboto`/`system-ui`).
- No Career Lane C reference introduced.
- No em dash (U+2014) introduced in this slice's new CSS.

Also re-ran the pre-existing suites that exercise touched/adjacent surfaces to confirm no regressions:

- `npm run test:typographyreadability` — 41/41 passed.
- `npm run test:jobspolisha48` — 46/46 passed.
- `npm run test:mobilesmoke` — 39/39 passed across android-360/iphone-390/breakpoint-700 (44px targets, no horizontal trap, core chrome mounted, GlassBox on 3 surfaces, no new network — this is the real browser-rendered proof that the new touch-min/coarse-pointer CSS did not shrink or break any existing control).
- `npm run test:glassbox` — 32/32 passed (includes its own no-em-dash check).
- `npm run test:proofboard` — 286/286 passed (includes its own no-em-dash check).
- `npm run check:canvas-integrity` — clean (re-recorded once for the reviewed byte-size change; all 68 tracked module hashes byte-identical before/after).

## Acceptance checklist (from SPEC)

- [x] `--dg-safe-top/bottom` (and left/right) for mobile notches via `env(safe-area-inset-*)`
- [x] `--dg-hairline` for separators (1px / 0.5px on high-density displays)
- [x] Semantic label styles: title / headline / body / callout / caption / footnote via existing rem tokens
- [x] `--dg-touch-min: 2.75rem` enforced on primary nav + primary CTAs
- [x] Navigation/chrome: safe-area respected on new chrome surfaces; existing bottom-nav/top-nav safe-area treatment verified intact
- [x] Forms: labels above fields, caption-size helper text, calm (role-token) error red
- [x] Coarse-pointer (`@media (pointer: coarse)`) hit-target bump, token-driven
- [x] Loading: subtle inline treatment available, not a forced full-app blocker
- [x] Empty states: short (width-capped), actionable utility classes
- [x] Dark/light: no new hardcoded hex chrome introduced; existing semantic CSS variables reused throughout
- [x] Full cross-platform font stack verified intact (`system-ui`, `Segoe UI`, `Roboto`, ... — no iOS-only cosplay)
- [x] `prefers-reduced-motion` honored for all new animation (loading spinner)
- [x] No Career Lane C
- [x] No engine behavior changes
- [x] Canvas integrity clean (`npm run check:canvas-integrity` passes)
- [x] PR open (not merged)

## Residuals (deferred, out of scope for this slice)

- Full hex-color sweep of every feature-specific module (Recipe Library, DVC, Shield Packs, meeting scribe, etc.) — same residual #630 already documented; still a much larger, separate PR.
- Consolidating the 8 different modal class families into one shared class — unchanged from #630's residuals list.
- Retrofitting `.dg-field`/`.dg-label-*`/`.dg-empty-state`/`.dg-loading-inline` onto every existing form/empty/loading call site across ~80 `js/` feature modules — this slice ships the token/utility contract per the SPEC; wiring every existing surface onto it is a follow-up migration, not a CSS-token slice.
