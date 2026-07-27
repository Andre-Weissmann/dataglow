# A50.1 Toolbar overflow + full 16px type scale SPEC

## Problem (live inspect)
- ~636px horizontal overflow at 1440px; VERDICT and Question Scout off-screen
- ~90% leaf text under 16px (W3Schools readability baseline)

## Requirements
1. Toolbar: primary cluster (Data/Analyze/Output) + utility; advanced tools in "More" menu/drawer that always includes VERDICT and Question Scout reachable without horizontal scroll at 1280 and 1440
2. No letter-clipping; no scrollWidth > clientWidth on documentElement at 1280/1440 after load
3. Type scale: body, buttons, nav labels, primary helpers >= 16px (1rem). Captions only at 14px min with strong contrast. Kill 11-13px chrome.
4. Primary CTA >= 16px desktop and mobile
5. canvas/index.html authoritative; no U+2014 em dash in visible strings
6. Tests: overflow assertion + font-size floor samples; canvas-integrity
7. Branch feature/a50-1-overflow-16px; PR DO NOT MERGE; result A50_1_OVERFLOW_16PX_RESULT.md
