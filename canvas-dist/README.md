# DataGlow Canvas — UI Shell

## What this is

This is the **DataGlow Canvas** — the single-surface interface described in the design spec ([`dataglow_canvas_spec.md`](/home/user/workspace/dataglow_canvas_spec.md)). As of this PR, the shell is wired end-to-end to the real pure-logic modules from main: drop a CSV, watch the ceremony, see real validation findings in the ambient rail, act on them through the agent bar, generate a real narrative in Story View, and query the loaded dataset through a Cmd+`/Ctrl+` SQL panel. It covers:

- The **first-use ceremony** — an empty drop zone that, on file drop, runs a sequenced reveal (file name → progress bar → row count count-up → column count → health dots appearing left-to-right → key finding sentence → grid reveal).
- The **Grid View shell** — tab strip for multi-file workflows, compound column headers (name + type chip + health dot), row tinting for warning/error rows, a formula bar (now wired to real edits), and a status bar.
- The **Ambient Validation Rail** — an 8px collapsed strip (colored by overall dataset health) that expands to a 320px panel with severity-leveled findings backed by the real streaming validator, per-finding expand detail, and a dismiss action.
- The **Agent presence line** — a bottom status strip with a hover popover on health dots, "Fix this" / "Tell me more" wired to institutional memory.
- **Story View** — a real, generated narrative (summary, findings, timeline, SQL audit trail, provenance) rendered from `story-builder.js`, with Markdown and PDF export.
- **Institutional Memory** — every meaningful user/agent action (file load, fix accepted/dismissed, manual edit, finding dismissed, SQL query run) is appended to an in-memory, provenance-hashed log for the session.
- **Return-use greeting** — dropping a file that matches one already seen this session (by name+size hash) shows a "we've seen this file before" banner summarizing what memory recalls, then still runs the full ceremony.
- **SQL Mode (Tier 3)** — Cmd+`/Ctrl+` opens a dimmed overlay with a query textarea and a mock query engine (`SELECT` + naive `WHERE` column matching, first 10 rows).
- **Top nav** — Grid / Story / Join view switcher.
- **Dark mode** — full light/dark theme toggle.

## How to open it

No build step, no server, no dependencies to install. Just open the file directly:

```
canvas/index.html
```

in any modern browser (Chrome, Firefox, Safari, Edge). Everything is a single self-contained HTML file with inline CSS and vanilla JavaScript — including this PR's newly wired modules, which are inlined directly into the page's `<script>` block (no `<script src="...">` references to repo files).

To try it without your own file, click **"Try an example"** below the drop zone — it loads a small mock claims dataset with a few intentional data-quality issues (a negative claim amount, missing values, a malformed zip code) so you can see the validation rail, row tinting, and health dots in action immediately.

## What is real vs. placeholder

**Fully real and working in this PR:**
- Drag-and-drop and click-to-browse file input, with real format detection (`detectFileFormat` / `buildDropManifest` from `drop-zone-router.js`, magic-byte + MIME + extension based) instead of a raw extension check
- Inline CSV parser (handles quoted fields with embedded commas, empty cells, numeric/date/bool type auto-detection)
- Inline JSON parser (array-of-objects or `{ data: [...] }` shapes)
- The full sequenced reveal choreography, including `requestAnimationFrame`-driven row count-up and staggered `setTimeout` health-dot sequencing
- Grid rendering: compound headers, row tinting, empty-cell styling
- **Real validation**: `runStreamingValidation()` from `streaming-validator.js` runs against every loaded dataset (schema drift / value drift / arrival anomaly pillars), layered with empty-cell and negative-value heuristics for first-load richness since there is no cross-session baseline yet
- **Institutional memory**: `createMemoryStore()` on page load; `appendRecord()` on file drop (`FILE_LOADED`), "Fix this" (`AGENT_FIX_ACCEPTED`), "Tell me more" (`AGENT_FIX_DISMISSED`), formula-bar cell edits (`MANUAL_EDIT`), rail finding dismiss (`VALIDATION_DISMISSED`), SQL Mode queries (`SQL_QUERY`), and Story exports (`STORY_EXPORTED`)
- **Story View**: real narrative built with `buildStory()` / `renderHTML()` from `story-builder.js`, including a real key finding, a real methodology/timeline section (via `generateTimeline()`), and a provenance section showing both `computeProvenanceHash()` (institutional memory) and `computeStoryHash()` (story builder) side by side; "Export Markdown" downloads a real `.md` file via `renderMarkdown()`; "Export PDF" triggers the browser print dialog
- **Return-use greeting**: a djb2 hash of filename + size recognizes a file dropped earlier in the same session and shows a "we've seen this file before" banner with a `summarizeMemory()` recap before running the full ceremony again
- **SQL Mode (Tier 3)**: Cmd+`/Ctrl+` opens a dimmed overlay over the grid; running a query containing `SELECT` filters the active dataset's rows by naive `WHERE`-clause column-name matching and shows the first 10 rows; Escape closes the overlay; every run is logged to institutional memory
- Ambient Validation Rail: collapse/expand, severity coloring, per-finding expand chevron with real rule name + SQL, and a dismiss (`×`) action per finding
- Tab strip: multiple datasets, switching, health dot per tab, `+` to load another file, multi-file drop opens one tab per file in sequence
- Agent presence line: status text updates, hover popover on health dots, "Fix this" / "Tell me more" wired to institutional memory instead of stub-only status text
- View switcher (Grid / Story / Join) and dark mode toggle

**Placeholder — real wiring lands in follow-up PRs:**
- **Join View** — still a static placeholder panel with no generated content
- **Univer spreadsheet engine** — the grid still renders as a plain HTML `<table>`; `grid-bridge.js` from PR K (#388) will replace this once #388 merges and the Univer CDN bundle is wired in
- **Real binary format parsing** — only CSV and JSON are actually parsed today; XLSX and Parquet are correctly *identified* by the real `detectFileFormat()` router but still show a "format detected, parsing pending" placeholder row rather than real cell data
- **Audio/video transcription** (MP3/WAV/MP4) — listed in the supported-formats line but not implemented; depends on PR M (#390) and PR N (#389)
- **PDF RAG indexing** — not implemented; depends on PR O (#391)
- **Agent "Fix this" diff overlay** — accepting a fix now logs to institutional memory and updates the status line, but the real grid diff overlay (Section 3.5 of the spec) still depends on the Univer integration above
- **Real DuckDB-WASM** — SQL Mode uses a small mock query engine, not a real SQL execution engine

## Manual test plan

Run through these steps in order after opening `canvas/index.html` directly in a browser (no build step required):

1. Open `canvas/index.html` in a browser. Confirm the empty-state drop zone and ceremony screen render with no console errors.
2. Drag a CSV file onto the drop zone (or use "Try an example"). Confirm the full sequenced-reveal ceremony plays: file name → progress bar → row count count-up → column count → health dots left-to-right → key finding sentence → grid reveal.
3. Open the Ambient Validation Rail (click the collapsed strip or the status-bar validation indicator). Confirm real findings appear, generated from the streaming validator plus empty-cell/negative-value checks, each with a severity label, message, rule name, and SQL snippet.
4. Hover a column health dot and click **"Fix this"** in the agent popover. Confirm the status line updates and an `AGENT_FIX_ACCEPTED` record is appended to institutional memory (check via the Story View timeline in step 5, or `console.log` of the in-memory store).
5. Switch to the **Story** tab in the top nav. Confirm a real narrative renders in the Story View frame: title, summary, key finding in plain language, methodology/timeline, SQL audit section, and a provenance section showing both the memory provenance hash and the story hash.
6. Click **"Export Markdown"** in the Story View toolbar. Confirm a `.md` file downloads containing the same narrative content rendered as Markdown.
7. Press **Cmd+`** (Mac) or **Ctrl+`** (Windows/Linux) anywhere on the page. Confirm a dimmed SQL Mode overlay opens over the grid with a query textarea and Run button; type a `SELECT * FROM dataset WHERE <a column name>` query, click Run, and confirm a results table appears with up to 10 matching rows. Press **Escape** and confirm the overlay closes.
8. Drop the *same* CSV file again (same name and size). Confirm a "We've seen this file before" banner appears summarizing what institutional memory recalls, and that the full ceremony still plays afterward.
9. Click the dark-mode toggle. Confirm the entire UI (ceremony screen, grid, rail, story view, SQL overlay) switches themes without any unstyled/flashing elements.
10. Drop two or more files in a single multi-file drag-and-drop. Confirm each file gets its own ceremony (played in sequence) and its own tab in the tab strip, and that switching tabs correctly swaps the grid, rail findings, and Story View content per dataset.

## Next steps

1. Wire in `grid-bridge.js` from PR K once #388 merges — swap the fallback `<table>` for the real Univer-mounted grid inside `#grid-container`.
2. Wire in real XLSX/Parquet cell-level parsing behind the already-real `drop-zone-router.js` format detection.
3. Wire in real DuckDB-WASM for SQL Mode, replacing the current mock query engine.
4. Once the Univer integration lands, connect the Agent popover's "Fix this" button to a real grid diff overlay (Section 3.5 of the spec) instead of the current memory-logged status-line update.
5. Persist the institutional memory store and streaming-validator baseline across page reloads (currently both are in-memory only for the session) so the return-use greeting and drift detection work across browser restarts, not just within one session.
