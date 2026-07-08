# DATAGLOW — Tech-Debt Tracker

A living, agent-readable-and-writable audit log of known drift, deprecated
patterns, small inconsistencies, and doc/code mismatches in DATAGLOW's codebase
(currently ~60 flat JS modules in `js/` plus the `test/` suites).

Its whole purpose is memory across sessions. DATAGLOW is built and maintained in
short, mostly-autonomous coding-agent sessions. Without a shared record, each new
session re-discovers — and re-raises — the same small issues, or "fixes" one that
was already consciously accepted as a wontfix. This file is that shared record:
before proposing cleanup, a session should read it; after finding something worth
remembering, a session (or the weekly read-only scan — see
[`entropy-reduction-scan.md`](./entropy-reduction-scan.md)) should add it here.

This tracker is **not** an issue tracker for user-facing bugs and it does **not**
gate any release. It is deliberately low-ceremony: a plain markdown log anyone —
human or agent — can append to in one edit.

> **On provenance:** the practice of keeping a written, agent-maintained debt log
> and running a scheduled low-priority scan for accumulated drift is a general,
> publicly-documented engineering pattern (variously called tech-debt logs,
> entropy-reduction, or scheduled upkeep scans by multiple independent authors).
> Everything here is DATAGLOW's own wording and findings about DATAGLOW's own code.

## How to use this file

Each entry is one `###` block under **Entries** with these fields:

- **Date** — `YYYY-MM-DD` the entry was added.
- **Description** — one or two sentences: what the drift/inconsistency is.
- **Severity** — `low` / `medium` / `high`.
  - `low` — cosmetic or organizational; no behavioral impact.
  - `medium` — real inconsistency that *could* cause divergent behavior or confusion.
  - `high` — active correctness/security risk. (There should rarely be any of these
    sitting `open`; a `high` open item is a call to action.)
- **Area** — the affected file(s) or subsystem.
- **Status** — `open` / `fixed` / `wontfix`.
  - When resolving, change the status in place (don't delete the entry) and add a
    short `Resolution:` line, so future sessions see it was considered.
  - `wontfix` means a deliberate decision to accept it — record *why*, so it isn't
    re-raised.

Keep entries short. Link related modules with backtick paths (e.g. `js/utils.js`).
Newest entries go at the bottom of **Entries**.

## Entries

### 2026-07-08 — Tauri desktop shell stages web assets via a hand-maintained allowlist

- **Description:** Tauri v1 refuses a `distDir` that contains `node_modules` or
  `src-tauri`, so the shell cannot point `distDir` at the repo root where the
  static site lives. Instead `scripts/stage-desktop-frontend.mjs` copies an
  explicit allowlist of runtime entries (`index.html`, `manifest.webmanifest`,
  `sw.js`, `assets/`, `css/`, `js/`, `protocol/`) into `src-tauri/dist/` before
  each build. The allowlist is maintained by hand: if the site adds a new
  top-level runtime asset (a new directory, or a new root file the app loads) and
  nobody updates the script, the desktop window will 404 on it while the browser
  build works. There is no automated check tying the two together. Cleaner
  options if next touched: derive the list from what `index.html`/the module
  graph actually reference, or add a smoke assertion that every root asset the
  site loads is present under the staged dir.
- **Date:** 2026-07-08
- **Severity:** low
- **Area:** `scripts/stage-desktop-frontend.mjs`, `src-tauri/tauri.conf.json`
- **Status:** open

### 2026-07-08 — Divergent `NUMERIC_TYPES` constant duplicated across 12 modules

- **Date:** 2026-07-08
- **Description:** The numeric-type allow-list `NUMERIC_TYPES` is re-declared as a
  local `const` in 12 separate `js/` modules, in **three divergent variants**:
  the short set `['DOUBLE','BIGINT','INTEGER','HUGEINT','FLOAT']` (7 files), a
  medium set adding `'DECIMAL','REAL'` (4 files), and one extended set in
  `js/synthetic-twin.js` also adding `SMALLINT/TINYINT/UINTEGER/UBIGINT`. Because
  the variants disagree, the same DuckDB column type (e.g. `DECIMAL`, `SMALLINT`)
  is treated as numeric by some validation layers and non-numeric by others. A
  single shared constant (e.g. exported from `js/utils.js`) would remove the drift.
- **Severity:** medium
- **Area:** `js/active-learning.js`, `js/missingness.js`, `js/predictive-anomaly.js`,
  `js/digital-twin.js`, `js/synthetic-adversarial.js`, `js/isolation-forest.js`,
  `js/spc-control.js`, `js/golden-signals.js`, `js/federated-fingerprint.js`,
  `js/ondevice-ml.js`, `js/synthetic-twin.js`, `js/self-learning-rules.js`
- **Status:** open

### 2026-07-08 — Two overlapping missingness modules classify MCAR/MAR/MNAR

- **Description:** Both `js/missingness.js` (`analyzeMissingness`, wired into the
  summary/Golden-Signals path in `js/main.js`) and `js/missingness-detective.js`
  (the standalone validation layer) independently implement Rubin's
  MCAR/MAR/MNAR missingness taxonomy with their own thresholds and group-variation
  heuristics. The concepts and cut-offs are maintained twice; they can drift apart
  and give a user two different characterizations of the same column's missingness.
  Not urgent — they serve different surfaces today — but worth consolidating the
  shared heuristic if either is next touched.
- **Date:** 2026-07-08
- **Severity:** low
- **Area:** `js/missingness.js`, `js/missingness-detective.js`
- **Status:** open

### 2026-07-08 — Flat `js/` directory has grown to ~60 top-level modules

- **Description:** All application modules live directly under `js/` with no
  sub-grouping (validation layers, engine/runtime, federated, on-device ML, UI all
  intermixed). This is intentional for the zero-build static-site setup (flat ES
  module imports, no bundler), but at ~60 files it makes ownership and relatedness
  hard to see at a glance. Tracked here as the baseline so the weekly scan can flag
  *further* growth and prompt a grouping decision — not an urgent change.
- **Date:** 2026-07-08
- **Severity:** low
- **Area:** `js/` (directory structure)
- **Status:** open
