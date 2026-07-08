# Working on DATAGLOW

Guidance for any coding agent (or human) making changes here. It is short on
purpose. Read it once at the start of a task, then get to work.

## What DATAGLOW is (and the one hard constraint)

DATAGLOW is a zero-server, zero-upload static site. Everything runs in the
browser: `index.html` loads vanilla ES modules from `js/`, and all vendored
assets are self-hosted (see `assets/`). There is no backend and nothing is
fetched from a third party at runtime.

**The hard constraint:** never introduce a runtime network dependency or a build
step into the shipped app. Tooling, tests, and docs may use dev dependencies, but
`index.html` and the deployed site must keep working offline with no server.

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
- **Keep the capability map current.** If you added, removed, or repurposed a
  `js/` module, update its area in `docs/capability-map.md` so the map never
  points at something that isn't there (and vice versa).
- **Note drift you're not fixing.** If you spot debt you're deliberately leaving
  alone, record it in [`docs/tech-debt-tracker.md`](./docs/tech-debt-tracker.md)
  so the next session doesn't re-discover it.

The weekly read-only [entropy-reduction scan](./docs/entropy-reduction-scan.md)
flags dangling doc references and untracked TODOs; keeping the paper trail current
in-PR is what keeps that scan quiet.

## Tests

Tests live in `test/` and run through npm scripts named `test:*` (see
`package.json`). Run the scripts relevant to what you changed before opening a
PR; CI runs the suite too. Documentation-only changes don't need new unit tests,
but do confirm every file path and link you write actually resolves.

## Supply-chain install hardening

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

## This file is checked against reality

Because you (and every agent before and after you) read and trust this file
without sanity-checking it, a stale reference here quietly misleads the whole
chain of sessions. The **AGENTS.md context-rot detector**
(`.github/scripts/agents-md-drift.mjs`, run via `npm run test:agentsdrift`, gated
in CI) guards against that: it extracts the backtick-quoted file paths and npm
script names mentioned above and fails the build if any of them no longer exists
on disk or in `package.json`. It is pure static analysis — no network, no model
calls. If it fails, the fix is one of two things: either the code moved and this
file is now wrong (correct the reference here), or this file is right and the code
regressed (restore or rename the code). Do whichever is actually true, in the same
PR — never silence the check by deleting a reference that should still resolve.

## PRs

Open PRs as drafts with a clear summary and test plan. Don't merge your own PR.
