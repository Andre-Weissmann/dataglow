# DataGlow Canvas — UI Shell

## What this is

This is the first working implementation of the **DataGlow Canvas** — the new single-surface interface described in the design spec ([`dataglow_canvas_spec.md`](/home/user/workspace/dataglow_canvas_spec.md)). It covers:

- The **first-use ceremony** — an empty drop zone that, on file drop, runs a sequenced reveal (file name → progress bar → row count count-up → column count → health dots appearing left-to-right → key finding sentence → grid reveal).
- The **Grid View shell** — tab strip for multi-file workflows, compound column headers (name + type chip + health dot), row tinting for warning/error rows, a formula bar, and a status bar.
- The **Ambient Validation Rail** — an 8px collapsed strip (colored by overall dataset health) that expands to a 320px panel with severity-leveled findings and per-finding expand detail.
- The **Agent presence line** — a bottom status strip with a hover popover scaffold (`Fix this` / `Tell me more`).
- **Top nav** — Grid / Story / Join view switcher.
- **Dark mode** — full light/dark theme toggle.

## How to open it

No build step, no server, no dependencies to install. Just open the file directly:

```
canvas/index.html
```

in any modern browser (Chrome, Firefox, Safari, Edge). Everything is a single self-contained HTML file with inline CSS and vanilla JavaScript.

To try it without your own file, click **"Try an example"** below the drop zone — it loads a small mock claims dataset with a few intentional data-quality issues (a negative claim amount, missing values, a malformed zip code) so you can see the validation rail, row tinting, and health dots in action immediately.

## What is real vs. placeholder

**Fully real and working in this PR:**
- Drag-and-drop and click-to-browse file input
- Inline CSV parser (handles quoted fields with embedded commas, empty cells, numeric/date/bool type auto-detection)
- Inline JSON parser (array-of-objects or `{ data: [...] }` shapes)
- The full sequenced reveal choreography, including `requestAnimationFrame`-driven row count-up and staggered `setTimeout` health-dot sequencing
- Grid rendering: compound headers, row tinting, empty-cell styling
- Mock validation: empty-cell percentage thresholds (warning at >5%, error at >20%) and negative-value detection on numeric columns
- Ambient Validation Rail: collapse/expand, severity coloring, per-finding expand chevron with mock rule name + SQL
- Tab strip: multiple datasets, switching, health dot per tab, `+` to load another file
- Agent presence line: status text updates, hover popover on health dots
- View switcher (Grid / Story / Join) and dark mode toggle

**Placeholder — real wiring lands in follow-up PRs:**
- **Story View** and **Join View** — currently static placeholder panels with no generated content
- **Univer spreadsheet engine** — the grid currently renders as a plain HTML `<table>`; `grid-bridge.js` from PR K (#388) will replace this once #388 merges and the Univer CDN bundle is wired in
- **Real validation spine** — the validation shown here is a client-side mock (empty-cell % and negative-value checks only); `streaming-validator.js` from PR I (#385) will replace `runMockValidation()`
- **Real format routing** — only CSV and JSON are actually parsed today; XLSX and Parquet currently show a "binary format detected" placeholder row. `drop-zone-router.js` from PR L (#387) will replace `handleFileDrop()`'s binary-format branch
- **Audio/video transcription** (MP3/WAV/MP4) — listed in the supported-formats line but not implemented; depends on PR M (#390) and PR N (#389)
- **PDF RAG indexing** — not implemented; depends on PR O (#391)
- **Agent "Fix this" diff overlay** — currently just updates the status line; the real grid diff overlay (Section 3.5 of the spec) depends on the Univer integration above

## Next steps

1. Wire in `grid-bridge.js` from PR K once #388 merges — swap the fallback `<table>` for the real Univer-mounted grid inside `#grid-container`.
2. Wire in `streaming-validator.js` from PR I (#385) — replace `runMockValidation()` with real rule evaluation against the Dataset object, including live re-validation on cell edit (Section 4.5 of the spec).
3. Wire in `drop-zone-router.js` from PR L (#387) — replace the binary-format placeholder branch in `handleFileDrop()` with real XLSX/Parquet parsing.
4. Once the validation spine is real, connect the Agent popover's "Fix this" button to the actual diff-overlay mechanism (Section 3.5) instead of the current status-line stub.
