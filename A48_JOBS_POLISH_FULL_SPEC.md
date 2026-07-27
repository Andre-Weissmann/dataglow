# A48 Full Jobs Polish SPEC (slice 1+)

## Goal

Steve Jobs-style GUI/UI/UX polish on the live canvas after A48 typography slice 0 (rem/16px floor). Not Career Lane C. Engines and Proof Harness stay untouched in behavior.

## Non-goals

- Career / job-application features
- Full BI suite clone
- Breaking density-critical data grids into sparse marketing layout
- Em dashes (U+2014) in visible product text
- HIPAA claims

## Design pillars (Jobs)

1. **Calm hierarchy** — one primary action per surface; secondary actions quieter
2. **Breathing room** — consistent spacing scale (4/8/12/16/24/32 rem-based tokens)
3. **Readable chrome** — nav, tabs, buttons, toasts, modals meet rem floors from slice 0
4. **Focus and feedback** — visible focus rings, 44px min hit targets on primary controls where feasible
5. **Light/dark craft** — semantic surfaces, not inverted-dark hacks
6. **Motion restraint** — short functional transitions; honor prefers-reduced-motion
7. **Cross-platform** — web + desktop + mobile PWA readable; no 9–10px chrome relapse

## Concrete ship items (this PR)

### Tokens (`canvas/index.html` authoritative + `css/base.css` / `css/app.css` as needed)

- Spacing tokens: `--dg-space-1` … `--dg-space-8` in rem
- Radius tokens: `--dg-radius-sm/md/lg`
- Shadow tokens: soft elevation only
- Control height tokens: `--dg-control-h` (~2.75rem / 44px target for primary buttons)

### Surfaces

- Header/nav: clearer separation, less visual noise
- Tab bar: active state stronger, inactive quieter; labels never clip on mobile
- Panels/cards: consistent padding using space tokens
- Modals/drawers: max-width readable, backdrop calm
- Toasts: readable, non-blocking, good contrast

### Controls

- Primary buttons: solid accent, min height token
- Secondary/ghost: quieter border
- Inputs/textareas: 1rem text, comfortable padding
- Focus-visible rings on interactive elements

### Density exceptions (allowed)

- Data tables / result grids may stay denser (0.8125–0.875rem) but never below 0.75rem
- Monospace SQL editor may keep compact line-height

### Proof of work

- `A48_JOBS_POLISH_FULL_RESULT.md`
- Test: token presence + no 9/10px font-size relapse on chrome selectors (extend typography test)
- Integrity if canvas JS modules touched
- PR `feature/a48-jobs-polish` — do NOT merge until confirm

## Out of scope for this PR (later slices)

- Full icon system redesign
- Brand-new IA / nav rename
- Marketing landing rewrite
- Animation library overhaul
