# A50 Jobs Calm Polish SPEC (cross-platform)

## Goal
First impression = calm product, not toolkit chrome. Experience first, technology second.
Steve Jobs: start from the customer journey, work backward to the stack.

## Not Apple-only
- HIG-inspired clarity, hierarchy, touch targets, reduced clutter
- Cross-platform: web, desktop (Tauri later), Android/Windows/iOS browsers
- Prefer system fonts stack with readable fallbacks; no SF-only lock-in
- No Apple logos, no "Designed for Mac only" copy
- Density adapts: comfortable mobile, focused desktop

## Customer journey (must feel obvious in under 10 seconds)
1. Drop or sample
2. Purpose (one calm step)
3. See health / issues
4. Ask (Scout)
5. Prove (VERDICT)
6. Export receipt

## Required UI changes (canvas/index.html authoritative + modules)
1. **Home hero**: one primary CTA path; demote secondary tools until data loaded
2. **Toolbar overflow**: collapse advanced tools into "More" on narrow; never clip letters
3. **Post-load spotlight**: max 3 actions — Clean/Validate, Ask (Scout), Prove (VERDICT)
4. **Scout cold-start**: if model not ready, show calm progress + "Use templates now" primary; never blank hang
5. **Purpose contract**: shorter copy, single obvious default (Analysis & Reporting)
6. **Typography/spacing**: Jobs polish tokens already present — enforce consistent 8pt rhythm, 16px min body on mobile
7. **No em dash (U+2014)** in any visible product string
8. **Proof of polish**: screenshots desktop 1280 + mobile 375 home + post-load

## Out of scope
- New engines, Career Lane C, Maven clones, full BI dashboards

## Ship
- Branch feature/a50-jobs-calm-polish
- Tests if any UI contract tests exist; canvas-integrity + capmap if modules touch manifests
- PR DO NOT MERGE until parent confirm
- Short commit message

## Result file
A50_JOBS_CALM_POLISH_RESULT.md with before/after notes and files touched
