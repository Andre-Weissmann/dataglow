# A48 slice 0 — Typography & readability (cross-platform)

**Trigger:** User unblocked A48 direction with W3Schools readability guidance: browser default body text is 16px for a reason; readable text is critical. DataGlow is web + Tauri desktop + mobile PWA.

**Doctrine:** Steve Jobs GUI polish = clarity, density with dignity, not sparse marketing landing. Density remains a product value; **body and claim text must stay legible**. No em dash in UI strings.

## Current baseline (main canvas, measured)

| Finding | Evidence |
|---|---|
| `body { font-size: 14px }` | Below browser default 16px |
| Dominant UI sizes | ~435× `11px`, ~429× `12px`, ~290× `13px`, ~178× `10px` |
| `16px` uses | Only ~58 occurrences (rare) |
| Font stack | `'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` |
| Platforms | Web browser, Tauri desktop, mobile PWA/responsive |

[W3Schools CSS Font Size](https://www.w3schools.com/css/css_font_size.asp): default html font-size is 16px in most browsers; rem scales from root; px locks users out of browser text-size prefs more than rem/em (zoom still works).

## Goals (slice 0 — shippable)

1. **Root readability contract**
   - `html { font-size: 100%; }` (honor user/browser default, typically 16px)
   - `body { font-size: 1rem; line-height: 1.5; }` (not 14px)
   - Keep dense chrome, but never set **primary reading text** below `0.875rem` (14px at default root)
2. **Token ladder (rem)** — single source CSS variables on `:root`:
   - `--dg-text-xs: 0.75rem` (12px) — badges, meta only
   - `--dg-text-sm: 0.875rem` (14px) — secondary UI labels
   - `--dg-text-md: 1rem` (16px) — body, claim bar, prove copy, SQL/result primary
   - `--dg-text-lg: 1.125rem` (18px) — section titles
   - `--dg-text-xl: 1.25rem` (20px) — panel headers
   - `--dg-text-2xl: 1.5rem` (24px) — rare page titles
3. **Cross-platform font stack** (system-first, Geist optional enhancement):
   ```css
   --dg-font-sans: "Geist", system-ui, -apple-system, BlinkMacSystemFont,
     "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif,
     "Apple Color Emoji", "Segoe UI Emoji";
   --dg-font-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
   ```
   - Desktop Tauri: same stack (native OS fonts fill gaps)
   - Mobile: system-ui / -apple-system first for performance; avoid shipping heavy webfonts as the only body face
   - If Geist fails to load, stack must still look intentional
4. **Surfaces that MUST move to ≥1rem (16px default)**
   - VERDICT claim bar, Prove notes, Inbox rows primary text
   - SQL editor chrome labels (editor code may stay mono 14px/0.875rem minimum)
   - Excel Hell / Repair primary instructions
   - Empty states and error remediation sentences
5. **Surfaces allowed smaller (with floor)**
   - Tab chips, badges, timestamps, column type tags: min `0.75rem` (12px)
   - Never `9px`/`10px` for any text a human must read to act
6. **Accessibility**
   - Prefer `rem` over bare `px` for text
   - Do not disable user zoom
   - Contrast: body text on `--bg` must remain WCAG AA for normal text at 1rem
7. **Flag**
   - `a48Typography` default **on** (or ship as unconditional base CSS if safer). Prefer flag only if rollback needed; typography is foundational so default on is correct.

## Non-goals this slice

- Full visual redesign of every panel (later A48 slices)
- New illustration system, motion overhaul
- Career Lane C
- Changing density doctrine into sparse “big whitespace SaaS”

## Implementation plan

1. Add `:root` tokens + html/body contract near top of canvas CSS (authoritative `canvas/index.html`)
2. Map highest-traffic reading surfaces (PH panel, SQL view, Excel Hell, Drill Floor labels) from hard-coded 11–14px → tokens
3. Global replace **only** where safe: body-level and shared class utilities first; avoid breaking canvas charts that use font-size for layout math without audit
4. Smoke: desktop 1280, mobile 375 width — claim bar + SQL + Prove still usable
5. Tests: pure snapshot or string checks that `body` font-size is `1rem` or `100%` chain; no `body { font-size: 14px }`
6. PR `feat/a48-typography-readability` — do NOT merge without confirm

## Acceptance

- [ ] body/html default reading size honors ~16px (1rem at default root)
- [ ] Claim/Prove/Inbox primary text ≥ 1rem
- [ ] No actionable UI text at 9–10px
- [ ] Font stack works offline if Geist CDN blocked (system fallback)
- [ ] Web + desktop shell + narrow mobile layout checked
- [ ] Canvas integrity clean
- [ ] PR open

## Residuals

- Full A48 Jobs polish pass (spacing, hierarchy, chrome)
- Optional user preference “Comfortable / Dense” toggling root to 100% vs 93.75%
