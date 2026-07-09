# The Build Nervous System (BNS)

DATAGLOW gains features fast, usually one coding-agent session at a time, each
ending in a pull request a human verifies and merges. The **Build Nervous
System** is a single, coherent build-safety spine for that flow. It replaces
ad-hoc safety habits with four connected stages, each a concrete, buildable
artifact:

1. **Isolate** — every session works in its own git worktree.
2. **Author** — every commit/PR carries a three-layer intent/gen/integrate record.
3. **Gate** — a merge-tree pre-flight simulates the merge before it happens, and a
   golden regression suite proves existing outputs did not silently move.
4. **Land dark** — new behavior can ship behind a client-side feature flag, then be
   promoted or deleted on a fixed schedule.

The stages depend on each other: you isolate so parallel work does not collide,
author so the record explains what changed and why, gate so a change cannot land
if it breaks a merge or moves a known-good output, and land dark so risky
behavior can be shipped disabled and turned on deliberately.

Everything here is docs, CI, and a tiny build-time manifest system. None of it
touches DATAGLOW's core validation logic, and none of it adds a runtime network
dependency or a browser-only API — the flag helper runs identically in the
browser bundle and inside the Tauri desktop webview.

---

## Stage 1 — Isolate: one git worktree per agent session

A git worktree is a second working directory backed by the same `.git` object
store. Two worktrees can have two different branches checked out at once without
re-cloning and without stepping on each other's files. That is exactly the
isolation a coding-agent session wants: its own directory, its own branch, no
risk of a half-finished edit from another session leaking in.

**Convention.** Every future coding-agent session for this repo should be given
its own worktree rather than reusing a shared clone. Builds today are already
sequential and provisioned per-subagent by infrastructure, so in practice this
stage is a documented convention plus a small helper — it does not change how the
existing infra hands a repo to a subagent.

**Helper.** [`scripts/new-agent-worktree.sh`](../scripts/new-agent-worktree.sh)
creates the worktree:

```sh
scripts/new-agent-worktree.sh <branch-name>
# creates ../dataglow-worktrees/<branch-name> on a new branch <branch-name>
```

It refuses to clobber an existing path or branch, and cleans up with
`git worktree remove <path>`. It is additive: it only calls `git worktree add`.

---

## Stage 2 — Author: the three-layer commit convention

Every PR should make three things legible, so a reviewer (human or agent) can see
what was asked, what the machine produced, and what a person changed before merge.
Use these three one-line layers in the PR description (see the template at
[`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md)) and,
where practical, in the commit body:

- **`intent:`** — what was asked / the ticket summary, in one line.
- **`gen:`** — what the agent generated, one factual line, no marketing language.
- **`integrate:`** — what a human or agent adjusted before merge, one line, or
  `none` if no manual adjustment was needed.

The value is separation: `intent` is the goal, `gen` is the raw machine output,
and `integrate` is the human judgment layered on top. When something later looks
wrong, that split tells you whether the ask, the generation, or the hand-editing
introduced it. This convention is also recorded in
[`AGENTS.md`](../AGENTS.md) so every session reads it at the start of a task.

---

## Stage 3 — Gate: merge-tree pre-flight + golden regression

### Merge-tree pre-flight

[`.github/workflows/merge-tree-preflight.yml`](../.github/workflows/merge-tree-preflight.yml)
runs on every PR. It performs a **pure simulation** of merging the PR branch into
the current `main` using `git merge-tree --write-tree`, which computes the merge
in memory and reports textual conflicts *without* creating a merge commit,
touching the working tree, or pushing anything. If a real conflict would occur,
the check fails and lists the conflicted paths, so the conflict surfaces as a red
check instead of a surprise at merge time.

This is added as a **regular, non-required** check. Marking it required in branch
protection is a separate, deliberate decision for a human to make later, after
watching it run cleanly a few times.

### Golden regression coverage (Titanic)

The existing
[Golden regression suite](../.github/workflows/job-golden-regression.yml)
(`npm run test:golden`) re-runs DATAGLOW's core deterministic operations and diffs
their output against versioned fixtures in `test/golden/fixtures/`. The suite runs
*every* case in `test/golden/cases.mjs`, so extending coverage means adding a case
and its fixture — the workflow itself needs no change.

BNS adds a **Titanic** golden case: the passenger-manifest shape (sex / age /
passenger class / survived / fare) is a widely known public dataset shape and a
good exercise of the cross-column, bounded-quantity, and full-orchestrator paths
on a different-looking dataset than the clinical one already covered. The case
pins a fixed, in-repo sample (no download) as a golden input; its fixture lives at
`test/golden/fixtures/`. Regenerate intentionally-changed fixtures with
`npm run test:golden:update` and review the diff in the PR.

---

## Stage 4 — Land dark: the client-side feature-flag manifest

New behavior can ship disabled, then be turned on deliberately once it is trusted.
BNS provides the minimal machinery for that, mirroring the location and spirit of
[`capability-map.manifest.json`](../capability-map.manifest.json) (a root-level,
hand-authored JSON manifest read at init time).

- **Manifest:** [`flags.manifest.json`](../flags.manifest.json) at the project
  root. Schema — an object mapping flag name to
  `{ enabled: boolean, addedInPR: string, description: string }`.
- **Helper:** [`js/build/build-flags.js`](../js/build/build-flags.js) exports `isEnabled(flagName)`
  (plus small helpers to load/reset the in-memory manifest). It reads a plain
  in-memory object populated once at startup from the bundled JSON — **no
  `localStorage`, no cookies, no network, no server**. It therefore behaves
  identically in the browser bundle, inside the Tauri desktop webview, and in any
  future Tauri mobile build.

This ticket ships only the manifest, the helper, and one trivial example flag
(`exampleFlag`, disabled) so future PRs have a working pattern to copy. It does
**not** wire the helper into any existing module's behavior.

### The promote-or-delete rule (flag hygiene)

A feature flag is temporary scaffolding, not a permanent config knob. Left alone,
flags accumulate into dead branches nobody dares remove. So each flag is on a
clock:

- **Promote** — the behavior is trusted: remove the flag from the manifest and
  keep the code path permanently.
- **Revert** — the behavior is abandoned: remove the flag from the manifest and
  delete the code path.

**Rule:** any flag left in `flags.manifest.json` for **more than 3 merged PRs**
without being promoted or reverted should be called out in the PR description of
the **4th** PR that touches the manifest, with an explicit promote-or-delete
decision. The `addedInPR` field records where a flag's clock started, so the age
is auditable from the manifest alone.
