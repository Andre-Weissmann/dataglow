# A48 typography/readability — slice 0 (RESULT)

Implements `A48_TYPOGRAPHY_READABILITY_SPEC.md`, **typography/readability slice only** — not the full Steve Jobs redesign. Branched from `main` at `d17f416` (latest at implementation time).

Branch: `feature/a48-typography-readability` (not merged — PR opened for review).

## What changed

### 1. Root readability contract (canvas/index.html — AUTHORITATIVE for the web surface)
- Added `html { font-size: 100%; }` so the root honors the browser/OS default (typically 16px) and the user's browser text-size preference and pinch/keyboard zoom keep working.
- `body` font-size changed from a hardcoded `14px` to `1rem`; `line-height` kept at `1.5`.
- `body { font-family: ... }` now points at a new `--dg-font-sans` token instead of an inline literal list.

### 2. rem token ladder (single source of truth, `canvas/index.html` `:root`)
Added exactly the ladder from the SPEC, theme-independent (defined once, not re-declared under `[data-theme="dark"]`):
```css
--dg-text-xs: 0.75rem;   /* 12px — badges, meta, timestamps only */
--dg-text-sm: 0.875rem;  /* 14px — secondary UI labels; actionable-text minimum */
--dg-text-md: 1rem;      /* 16px — body, claim bar, prove copy, SQL/result primary */
--dg-text-lg: 1.125rem;  /* 18px — section titles */
--dg-text-xl: 1.25rem;   /* 20px — panel headers */
--dg-text-2xl: 1.5rem;   /* 24px — rare page titles */
```

### 3. Cross-platform font stack
```css
--dg-font-sans: 'Geist', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
  Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif,
  'Apple Color Emoji', 'Segoe UI Emoji';
--dg-font-mono: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas,
  'Liberation Mono', monospace;
```
Geist is kept as the enhancement (loaded via Google Fonts CDN, same as before); if it fails to load (offline, CDN blocked, Tauri desktop, mobile PWA) the full system stack keeps the UI looking intentional.

### 4. Killed 9px/9.5px/10px/10.5px font-size everywhere in scope
235 occurrences of `font-size: 9px / 9.5px / 10px / 10.5px` in `canvas/index.html` were raised to `var(--dg-text-xs)` (0.75rem = 12px, the SPEC's badge/meta floor). Manual review of every occurrence (see below) confirmed all of them were badges, section labels, tags, timestamps, hashes, or status/meta text — never primary body/claim text a user must read to act, which was already covered by the `body` font-size fix above.

Also fixed the same class of issue in the shared surfaces:
- `index.html` (root shell, staged into the Tauri desktop build): 3× `font-size:9px` on "NEW"/"POC" connector badges → `var(--text-xs)`.
- `css/app.css`: `.tab-group-label` `font-size: 10px` → `var(--text-xs)`.

No data-grid/table font-size rules were touched — dense tables (11–13px in canvas) remain as-is per the SPEC's "do not break density-critical data tables" instruction. Chart-layout font-size math (used for SVG/canvas sizing, not readability) was also left alone.

### 5. Shared CSS tokens (`css/base.css`, used by `index.html` / Tauri desktop shell)
- `--font-body` fallback chain extended to the SPEC's cross-platform list: `'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`. Inter stays the enhancement (self-hosted woff2, offline-safe already); fallback chain widened.
- `--font-mono` similarly widened with `ui-monospace` and more fallbacks.
- Added an explicit `html { font-size: 100%; }` (previously implicit/unstated — now stated per the SPEC's contract).
- `body` `line-height` normalized to `1.5` (was `1.55`); `font-size` already used the rem-based `--text-base` token (`clamp(0.9375rem, 0.9rem + 0.2vw, 1rem)`), so no change needed there beyond documenting the floor in a comment.

### 6. Untouched by design
- `canvas-dist/index.html` — confirmed via `git log` and build/deploy scripts that this is a stale, unreferenced legacy artifact (last touched at Bundle 17, not part of the current ship path staged by `scripts/stage-desktop-frontend.mjs` or built by `build.sh`). Left alone.
- Career Lane C — not touched (no code path under that name exists; it's only referenced as a "do not touch" instruction in unrelated SPEC docs).
- Pre-existing em dashes (U+2014) in code **comments** inside `canvas/index.html` (1,799 occurrences, all in `/* ... */` comments, none in rendered/visible product strings) — out of scope for a focused typography slice; not introduced or added to by this change. Verified none of our own additions use U+2014 (checked via `grep` over the diff).
- Full px→rem migration of every 11–13px UI string in canvas (thousands of occurrences) — explicitly out of scope per the SPEC's own implementation plan ("avoid breaking canvas charts that use font-size for layout math without audit"; "map highest-traffic reading surfaces… avoid full redesign"). This slice targets the two things the SPEC calls non-negotiable: the html/body root contract, and killing the 9–10px floor violations.

## inject/integrity

`canvas/index.html` mirrors several `js/` modules verbatim inside tracked `/* ---- from <path> ---- */ ... /* ---- end <path> ---- */` spans (see `canvas/integrity.manifest.json`, gated by `scripts/check-canvas-integrity.mjs`). The 9px/10px sweep touched inline `<style>`/`style="…"` text inside six tracked modules' canvas UI code:

- `js/provenance/data-glow-trust-ledger-canvas.js`
- `js/glassbox/data-glow-glass-box-canvas.js`
- `js/explain/data-glow-explain-canvas.js`
- `js/transforms/data-glow-transforms-canvas.js`
- `js/proofboard/data-glow-proof-board-canvas.js`
- `js/proof-harness/data-glow-proof-harness-canvas.js`

Per the gate's own design (source is authoritative, canvas is the inlined mirror), the identical text substitution (`font-size: 9/9.5/10/10.5px` → `var(--dg-text-xs)`) was ported back into each `js/` source file so source and canvas stay in sync, then `npm run check:canvas-integrity -- --update` was run to re-record the hashes and the new `canvasBytes` (6,367,239, +4,473 bytes) after manual review of the diff (this RESULT doc documents that review). `npm run check:canvas-integrity` now passes clean.

## Tests

Added `test/typography-readability.test.mjs` (pure Node, no browser/DOM), wired as `npm run test:typographyreadability` and into CI via a new `typography-readability` job in `.github/workflows/job-ci-batch-03.yml` (also runs `npm run check:canvas-integrity` in the same job). 41 assertions, all passing:

- `html { font-size: 100%; }` present in both `canvas/index.html` and `css/base.css`.
- `body` font-size is `1rem` in canvas (not `14px`); `--text-base` token in shared CSS is rem-based with a 1rem-scale floor.
- `body` line-height is `1.5` in both places.
- No `font-size: 9px/9.5px/10px/10.5px` remains in `canvas/index.html`, `css/base.css`, or `css/app.css`.
- `--dg-font-sans` / `--font-body` include every fallback the SPEC names (Geist/Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif).
- The full `--dg-text-*` rem ladder is defined with the correct values.

Also re-ran the existing suites that exercise the six touched canvas modules to confirm no regressions:
- `npm run test:glassbox` — 32/32 passed (includes its own "no em dash in visible product text" check).
- `npm run test:proofboard` — 286/286 passed (includes its own em-dash check).
- `npm run test:trustledgerui` — 44/44 passed (Playwright).
- `npm run test:explainui` — 57/57 passed (Playwright).
- `npm run check:canvas-integrity` — clean.

## Files changed
- `canvas/index.html` — html/body contract, rem token ladder, font stack token, 9-10px sweep.
- `canvas/integrity.manifest.json` — hashes + `canvasBytes` re-recorded after the reviewed sweep.
- `css/base.css` — `html { font-size: 100%; }`, widened `--font-body`/`--font-mono` fallbacks, `body` line-height normalized to 1.5.
- `css/app.css` — `.tab-group-label` 10px → `var(--text-xs)`.
- `index.html` — 3× connector-badge 9px → `var(--text-xs)`.
- `js/provenance/data-glow-trust-ledger-canvas.js`, `js/glassbox/data-glow-glass-box-canvas.js`, `js/explain/data-glow-explain-canvas.js`, `js/transforms/data-glow-transforms-canvas.js`, `js/proofboard/data-glow-proof-board-canvas.js`, `js/proof-harness/data-glow-proof-harness-canvas.js` — same 9-10px → token sweep, ported from canvas so the integrity gate's source/canvas hashes match.
- `package.json` — new `test:typographyreadability` script.
- `.github/workflows/job-ci-batch-03.yml` — new `typography-readability` CI job (runs the new test + canvas integrity check).
- `test/typography-readability.test.mjs` — new pure Node test (41 assertions).

## Acceptance checklist (from SPEC)
- [x] body/html default reading size honors ~16px (1rem at default root)
- [x] No actionable UI text at 9-10px (raised to the 0.75rem/12px badge floor; primary reading text already covered by the body-level fix)
- [x] Font stack works offline if Geist CDN blocked (system fallback chain)
- [x] Web (canvas) + desktop shell (root index.html/css) + narrow mobile layout unaffected by structural change (no layout-breaking edits, only font-size value + font-family fallback changes)
- [x] Canvas integrity clean (`npm run check:canvas-integrity` passes)
- [x] PR open (not merged)
- [ ] Claim/Prove/Inbox primary text >= 1rem — covered structurally by the `body` 1rem default; a full surface-by-surface audit of every claim-bar/Prove/Inbox element's own explicit font-size (if any override the body default below 1rem) is left as a residual for the next A48 slice, to keep this PR small and focused per the task's "keep PR focused and small" instruction.

## Residuals (deferred, same as SPEC's "Residuals" section)
- Full A48 Jobs polish pass (spacing, hierarchy, chrome).
- Optional user preference "Comfortable / Dense" toggle (100% vs 93.75% root).
- Broader 11-13px → rem token migration across the rest of canvas's UI surfaces (thousands of occurrences; requires careful per-surface audit to avoid breaking chart layout math, explicitly deferred by the SPEC itself).
- Cleanup of the 1,799 pre-existing em dashes in `canvas/index.html` code comments (not in visible product text; unrelated to this slice).
