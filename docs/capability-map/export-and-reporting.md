# Capability detail — Export & reporting

Companion to the **Export & reporting** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on dataset/report export; the index alone is enough for most tasks.

## Shape of the area — the Universal Export Contract

Two modules under `js/export/`, split along one deliberate seam: **build the
bytes** vs. **deliver the bytes**. A format builder returns a raw blob descriptor
`{ data: Uint8Array, filename, mimeType }`; a per-platform adapter takes that
descriptor and writes it to disk. Adding a runtime (a future mobile share sheet)
is a new ~20-line adapter, never a change to a format builder. Everything is
100% local — **no module here performs a network request** (the zero-upload
invariant).

## Flag / registry state

**No feature flag.** This area is not in `flags.manifest.json`; it is gated by the
**platform-aware capability registry** (`js/app-shell/capability-registry.js`)
instead. `capability-map.manifest.json` declares capability id `export-reporting`
with `platforms: ["browser","desktop"]`. At runtime `main.js` does
`exportReport = registry.get('export-report')` (line ~9415) — the registry key is
the module filename stem (`moduleKey('js/export/export-report.js')` →
`export-report`), which is why the runtime key differs from the capability-map id
`export-reporting`; that is expected, not a bug. On an unsupported runtime
`registry.get` returns undefined and `main.js` shows "Export module unavailable
on this runtime" rather than throwing.

## `js/export/export-report.js` — format byte-builders + orchestrator

Pure, injectable, testable without a browser.
- `buildDatasetView(opts)` → a normalized, format-agnostic snapshot both builders
  read: title/datasetName/tableName/generatedAt, columns, rows, rowCount (prefers
  the dataset's authoritative count), columnCount, validation, grades, loadedAt,
  and opt-in `nutritionLabelLines` (appended already-rendered, staying decoupled
  from `js/provenance/data-nutrition-label.js`). `safeStem` strips trailing
  data-file extensions to avoid the double-extension bug (`claims.csv` →
  `dataglow-claims.xlsx`, not `...claims.csv.xlsx`).
- `buildWorkbookBlob(view, { xlsx })` → `.xlsx`, reusing the already-vendored
  SheetJS global (`resolveXLSX` is injectable). Emits a **Data** sheet (native
  date serials via `coerceForExcel`, auto column widths via `computeColWidths`
  clamped 8–60, a frozen header row, and bold header styling that Pro honors and
  CE ignores cleanly), a **Summary** sheet (facts + grades + a PASS/WARN/FAIL
  validation overview), a **Validation Detail** sheet when validation exists, and
  a **Data Nutrition Label** sheet when opted in. `safeSheetName` enforces Excel's
  31-char / forbidden-char limits.
- `buildReportPdfBlob(view)` → `.pdf` via a tiny **first-party, dependency-free**
  text-PDF writer (PDF 1.4, Helvetica). `buildReportLines(view)` assembles the
  summary text; `asciiSafe`/`UNICODE_TO_ASCII` transliterate typographic Unicode
  (em dash, curly quotes, ≤/≥, etc.) to ASCII so serialized byte length equals
  character count and the xref offset table stays valid; `paginate` splits to
  US-Letter pages.
- `FORMAT_XLSX`/`FORMAT_PDF`, `buildBlobFor(format, view, opts)` (throws on
  unknown format), and `exportDataset(opts)` — the single high-level call the UI
  makes: build view → build bytes → `deliverBlob(blob, { platform, win })`.

## `js/export/export-delivery.js` — platform delivery adapters

`DELIVERY_BROWSER`/`DELIVERY_DESKTOP`/`DELIVERY_MOBILE`. Each adapter is a pure
function of its blob + an injected `win` (defaults to the real window).
- `deliverViaBrowser(blob, { win })` — the standard Blob + object-URL +
  synthetic `<a download>` click; also the desktop fallback inside the Tauri
  webview.
- `deliverViaDesktop(blob, { win })` — native Tauri "Save As" dialog +
  `fs.writeBinaryFile` **only when** the shell opts into those APIs
  (`tauriFileApi` probes `window.__TAURI__`); today the shell ships deny-by-
  default so this transparently falls back to the browser download. A cancelled
  dialog resolves `{ delivered:false, cancelled:true }` rather than throwing.
- `deliverViaMobile()` — **intentionally not implemented** (no mobile app yet);
  throws a descriptive error documenting the planned share-sheet approach.
- `selectAdapter(platform)` maps a platform token to an adapter (unknown →
  browser); `deliverBlob(blob, { platform, win })` is the thin dispatcher
  `export-report.js` calls.

## UI wiring

`main.js` resolves the module at startup (`registry.get('export-report')`) and
calls `exportReport.exportDataset({ format, dataset, columns, rows, validation,
grades, platform, win, nutritionLabelLines })` (line ~6982), honoring
`delivery.cancelled` and optionally delivering a separate machine-readable
nutrition-label `.json` alongside the primary file (also a client-side Blob, no
network).

## Tests

- `test/export-report.test.mjs` — the export suite (view building, xlsx/pdf byte
  builders with an injected SheetJS/window, filename stemming, delivery-adapter
  selection and fallback).

## Note on stale path comments

The header comments in both files refer to `js/export-report.js` /
`js/export-delivery.js` (no `export/` segment) and the SheetJS asset path
`assets/xlsx/`; the modules actually live under `js/export/`. Cosmetic only — the
imports resolve correctly relative to the real locations.
