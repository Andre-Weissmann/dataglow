# Working on DATAGLOW

Guidance for any coding agent (or human) making changes here. It is short on
purpose. Read it once at the start of a task, then get to work.

## What DATAGLOW is (and the one hard constraint)

DATAGLOW is a zero-server, zero-upload static site. Everything runs in the
browser: `index.html` loads vanilla ES modules from `js/`, there is no backend,
and **your data never leaves your machine** — nothing you load is ever uploaded.

The app's own code and the libraries needed on every page load are self-hosted
under `assets/`: DuckDB-WASM (SQL engine), Plotly.js (charts), and SheetJS/xlsx
(Excel parsing) are all vendored, so a normal page load fetches nothing from a
third party. The three *large* runtimes behind optional tabs — Pyodide (Python),
WebR (R), and WebLLM (the on-device Story model) — are the exception: they are
fetched from public CDNs on demand, the first time you open those tabs, because
vendoring multi-hundred-megabyte runtimes into every page load isn't practical.

**The hard constraint:** never add a runtime network dependency for the *core*
app or a build step, and never route user data off the machine. `index.html` and
the deployed site must cold-start and do their core work (load, SQL, clean,
validate, visualize) offline with no server; only the opt-in Python/R/Story tabs
may reach a CDN, and only to pull their own runtime. Tooling, tests, and docs may
use dev dependencies freely.

## Orient yourself before writing code

Before editing for a new feature or a fix, spend a moment getting the lay of the
land — it consistently saves more time than it costs:

1. **Find the right files.** Start from [`docs/capability-map.md`](./docs/capability-map.md).
   It maps every `js/` module to a feature area, so you can jump straight to the
   two or three files that matter instead of scanning all ~60. Open the area's
   detail file under `docs/capability-map/` only if you need it.
2. **Read them.** Read the modules you're about to touch, plus their direct
   collaborators, before changing anything.
3. **State a short plan first.** In your own words, write down what you intend to
   do *before* you edit: what will change, what will deliberately stay the same,
   and which files you expect to touch. A few lines is enough. This is a
   checkpoint against scope creep and accidental behavior changes — if the plan
   and the diff diverge, one of them is wrong.

Keep the plan proportionate: a one-line typo fix does not need a paragraph.

## Finish the paper trail in the same PR

A change isn't done when the code works — it's done when the record matches the
code. As part of the *same* PR (not a follow-up):

- **Add a changelog entry.** One line in [`docs/CHANGELOG.md`](./docs/CHANGELOG.md)
  describing the user-visible or structural change. Do this as you wrap up, not
  later.
- **Record a new foundation.** If you shipped a new CI/infra foundation or a
  reusable capability (the kind of one-paragraph blurb that belongs next to the
  supply-chain and context-rot entries), add it to the *Foundations &
  capabilities* section below.
- **Keep the capability map current.** If you added, removed, or repurposed a
  `js/` module, update its area in `docs/capability-map.md` so the map never
  points at something that isn't there (and vice versa).
- **Note drift you're not fixing.** If you spot debt you're deliberately leaving
  alone, record it in [`docs/tech-debt-tracker.md`](./docs/tech-debt-tracker.md)
  so the next session doesn't re-discover it.

**Append-only zones — do not edit around them.** Three files used to collide on
every parallel PR because each new foundation had to edit surrounding prose in
all of them. They now carry explicit append-only markers; adding an entry is a
single-line insert at one fixed point, so two PRs adding different entries land
on different lines and never textually conflict. When you add an entry, insert it
*directly below* the marker and leave the existing entries above it untouched:

- `docs/CHANGELOG.md` — one-line changelog bullets go under the
  `NEW-ENTRIES-BELOW` marker in the `## Unreleased` section.
- `AGENTS.md` — foundation/capability blurbs go under the
  `NEW-FOUNDATION-ENTRIES-BELOW` marker in *Foundations & capabilities* below.
- `.github/workflows/test.yml` — new CI jobs go under the `NEW-JOB-ENTRIES-BELOW`
  marker as a new `uses:` block (see *CI is a thin orchestrator* below).

The weekly read-only [entropy-reduction scan](./docs/entropy-reduction-scan.md)
flags dangling doc references and untracked TODOs; keeping the paper trail current
in-PR is what keeps that scan quiet.

## Tests

Tests live in `test/` and run through npm scripts named `test:*` (see
`package.json`). Run the scripts relevant to what you changed before opening a
PR; CI runs the suite too. Documentation-only changes don't need new unit tests,
but do confirm every file path and link you write actually resolves.

## CI is a thin orchestrator

CI lives in `.github/workflows/test.yml`, but that file is now only a thin
orchestrator: it triggers on `push`, `pull_request`, and `merge_group`, and each
job is a one-line `uses:` call into a standalone reusable workflow named
`.github/workflows/job-<name>.yml`. Each foundation owns its own job file (one
job per file, triggered via `on: workflow_call`), so adding or changing a job
touches that job's file rather than a shared 8-job YAML. The job files sit at the
top level of `.github/workflows/` — not a subdirectory — because GitHub only
resolves reusable workflows referenced from the top level of that directory; the
`job-` prefix keeps them grouped. To add a new CI job: create
`.github/workflows/job-<name>.yml` as a `workflow_call` reusable workflow, then
append a `uses:` block for it under the `NEW-JOB-ENTRIES-BELOW` marker in
`.github/workflows/test.yml`.

## Foundations & capabilities

Self-contained, one-per-foundation notes for the CI/infra foundations and
reusable capabilities that shape how work is done here. Newest first.

<!-- NEW-FOUNDATION-ENTRIES-BELOW: append new entries directly under this line, do not edit existing entries above -->

### Optional Tauri v1 desktop shell

An optional native desktop wrapper lives under `src-tauri/`. It is the stock
Tauri "vanilla" template (`src-tauri/src/main.rs` registers no commands) that
loads the existing static site unchanged. Tauri v1 refuses a `distDir` that
contains `node_modules` or `src-tauri`, so `distDir` cannot be the repo root;
instead a tiny copy step (`scripts/stage-desktop-frontend.mjs`, wired via
`beforeBuildCommand`/`beforeDevCommand`) stages the site's runtime assets into a
gitignored dist folder under `src-tauri/` that `distDir` points at. It is a plain
file copy — no bundler, transpiler, or minifier — so the bytes served in the
window are identical to the browser; if the site gains a new top-level runtime
asset, add it to that script's allowlist. The v1 allowlist is deny-by-default
(`tauri.allowlist.all = false`), so the window has only what a browser tab has;
the site's opt-in CDN/Databricks fetches are ordinary webview requests and are
untouched by it. Build via `npm run tauri:dev` / `npm run tauri:build` (Tauri CLI
invoked through `npx`, so nothing is added to `package-lock.json`); a debug build
is smoke-tested in CI by `.github/workflows/job-tauri-smoke.yml` on `ubuntu-22.04`
(Tauri v1 needs webkit2gtk-4.0, absent from 24.04). The produced installers are
**not** signed or notarized — see `docs/desktop-shell.md` for the signing/legal
notes (macOS notarization needs the ~US$99/yr Apple Developer Program; unsigned
Windows binaries trip SmartScreen). Do not describe the artifacts as signed.

### Vendored page-load libraries (Plotly + SheetJS)

Everything the app needs on a normal page load is now self-hosted under `assets/`,
so a cold load fetches nothing from a third party. Alongside the pre-existing
DuckDB-WASM bundle, Plotly.js (`assets/plotly/`, MIT) and SheetJS/xlsx
(`assets/xlsx/`, Apache-2.0) are vendored and referenced by local path in
`index.html`; their upstream licenses ship next to them. The only remaining
third-party fetches are the three large opt-in runtimes — Pyodide, WebR and
WebLLM — which load from public CDNs on demand when their tabs are first opened
(`js/python-runtime.js` injects the Pyodide loader lazily; `js/r-runtime.js` and
`js/ondevice-llm.js` dynamically `import()` theirs). When you touch prose about
what loads from where, keep this vendored-vs-on-demand split accurate — the
AGENTS.md context-rot detector only checks that paths resolve, not that claims
are true, so the honesty here is on you.

### Append-only zones + per-job reusable CI workflows

Three files (`docs/CHANGELOG.md`, `AGENTS.md`, `.github/workflows/test.yml`) used
to collide on every parallel PR, because nearly every new foundation had to edit
surrounding prose in all three. Each now carries an explicit append-only marker
(`NEW-ENTRIES-BELOW`, `NEW-FOUNDATION-ENTRIES-BELOW`, `NEW-JOB-ENTRIES-BELOW`), so
a new entry is a one-line insert at a fixed point rather than an edit to shared
text — see *Append-only zones* under *Finish the paper trail in the same PR*. CI
was also split: `.github/workflows/test.yml` is now a thin orchestrator that
`uses:` one reusable workflow per job, each a top-level
`.github/workflows/job-<name>.yml` file (each with `on: workflow_call`), so a job
change touches its own file instead of the shared YAML — see *CI is a thin
orchestrator*.

### Supply-chain install hardening

Dependency installs are locked down against the most common supply-chain
attack — malicious install-time scripts. The root `.npmrc` sets
`ignore-scripts=true`, so no package's preinstall/install/postinstall runs on
an npm install / npm ci. The `supply-chain-hardening` CI job then enforces this:
`.github/scripts/check-lifecycle-scripts.mjs` scans `package-lock.json` (and the
installed tree) and fails the build if any dependency declares a lifecycle
script that is not on the allowlist defined at the top of that script. It also
emits a CycloneDX SBOM as a build artifact. To add a dependency that genuinely
needs an install script, add its bare package name to that `ALLOWLIST` array
(with a one-line reason) and add a matching `npm rebuild <pkg>` step to the CI
job so the build still runs; note both in your PR.

### AGENTS.md context-rot detector

Because you (and every agent before and after you) read and trust this file
without sanity-checking it, a stale reference here quietly misleads the whole
chain of sessions. The **AGENTS.md context-rot detector**
(`.github/scripts/agents-md-drift.mjs`, run via `npm run test:agentsdrift`, gated
in CI) guards against that: it extracts the backtick-quoted file paths and npm
script names mentioned in this file and fails the build if any of them no longer
exists on disk or in `package.json`. It is pure static analysis — no network, no
model calls. If it fails, the fix is one of two things: either the code moved and
this file is now wrong (correct the reference here), or this file is right and the
code regressed (restore or rename the code). Do whichever is actually true, in the
same PR — never silence the check by deleting a reference that should still
resolve.

## PRs

Open PRs as drafts with a clear summary and test plan. Don't merge your own PR.
