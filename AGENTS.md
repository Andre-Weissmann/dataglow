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

0. **Check for overlap first.** Before anything else, run the
   [`preflight-overlap-check`](./.claude/skills/preflight-overlap-check/SKILL.md)
   skill — it searches open PRs, the capability map, and the codebase together
   for existing or in-flight work on the same thing, and routes you to extend
   an existing PR instead of silently duplicating it. This repo has already
   shipped two independent implementations of the same capability once (PR
   #108 and #114, both an "Agent Action Firewall"); this step exists so that
   doesn't happen again. Skip only for genuinely trivial one-line fixes.
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
4. **If you hit a bug, error, or a real fork-in-the-road decision, check the
   [`debug-log-tree`](./.claude/skills/debug-log-tree/SKILL.md) skill before
   re-diagnosing from scratch.** It searches `docs/tech-debt-tracker.md`, git/PR
   history, and past Perplexity Computer sessions for whether this exact problem
   (or something adjacent) was already hit, fixed, or deliberately rejected —
   then has you log the outcome so the next session doesn't repeat the work.
   This is separate from step 1's overlap check: that one is about *duplicate
   features* before you start; this one is about *repeated debugging* once
   something breaks mid-session.

Keep the plan proportionate: a one-line typo fix does not need a paragraph.

## Finish the paper trail in the same PR

A change isn't done when the code works — it's done when the record matches the
code. As part of the *same* PR (not a follow-up):

- **Add a changelog entry.** One line in [`docs/CHANGELOG.md`](./docs/CHANGELOG.md)
  describing the user-visible or structural change. Do this as you wrap up, not
  later.
- **Record a new foundation.** If you shipped a new CI/infra foundation or a
  reusable capability (the kind of one-paragraph blurb that belongs next to the
  supply-chain and context-rot entries), add it to [`docs/foundations.md`](./docs/foundations.md).
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

Self-contained, one-per-foundation notes live in
[`docs/foundations.md`](./docs/foundations.md). Read that file when you need the
history of a CI gate, a reusable capability, or a past infra decision.

When you ship a new foundation or reusable capability, add a one-paragraph entry
there in the same PR. Keep this section of `AGENTS.md` as a pointer only — do not
grow a second copy of the log here. Session scratch notes belong in a local NOTES file
(gitignored as NOTES.md), not in either file.

## PRs

Open PRs as drafts with a clear summary and test plan. Don't merge your own PR.
