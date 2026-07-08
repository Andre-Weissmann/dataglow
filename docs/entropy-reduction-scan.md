# DATAGLOW — Weekly Entropy-Reduction Scan

This document explains the scheduled **entropy-reduction scan** — a small piece of
DATAGLOW *repo tooling* (not a shipped web-app feature). It changes nothing about
the zero-server static site or `index.html`; it only helps keep the codebase tidy
across DATAGLOW's mostly-autonomous coding-agent sessions.

## What it is

- **Workflow:** [`.github/workflows/entropy-reduction-scan.yml`](../.github/workflows/entropy-reduction-scan.yml)
- **Script:** [`.github/scripts/entropy-scan.mjs`](../.github/scripts/entropy-scan.mjs)
- **Test:** [`test/entropy-scan.test.mjs`](../test/entropy-scan.test.mjs) (run via `npm run test:entropy`)
- **Reads:** [`docs/tech-debt-tracker.md`](./tech-debt-tracker.md)

Software entropy is the slow accumulation of small inconsistencies that no single
feature PR is responsible for. The scan runs **weekly** (Mondays, 06:17 UTC) and
on-demand (`workflow_dispatch`) to look for that drift and surface it for a human
to triage — deliberately as a background, low-priority upkeep task, separate from
the merge-gating test suite.

## The read-only guarantee

This is the most important property of the scan, and it is enforced, not just
promised:

- **No auto-commit** — the workflow never writes to the repository's tracked files.
- **No auto-merge / no pull requests** — the workflow has **no** `pull-requests`
  permission and **no** `contents: write` permission. Its token grants only
  `contents: read` + `issues: write`.
- **No merge gating** — it is not part of `tests.yml` and cannot block a PR. (The
  scan *script* is unit-tested in the normal CI so it doesn't rot, but the *scan
  itself* never gates a merge.)
- **Human review required for any fix** — the scan only *proposes*. Acting on a
  finding means a person adds an entry to `docs/tech-debt-tracker.md` (or fixes the
  code) via an ordinary, reviewed pull request.

Its only side effects are:

1. Reading `docs/tech-debt-tracker.md` and the codebase.
2. Writing a Markdown **job summary** and uploading a findings **artifact**
   (`entropy-scan-findings`) — a proposal, not a commit.
3. Opening or refreshing a **single GitHub issue** titled
   _"Entropy-Reduction Scan — weekly findings"_. (An issue is not a code change.)

## The golden principles (v1)

The scan is intentionally small and deterministic. Each principle is a cheap,
robust check — the aim is a working, honest signal, not a clever one:

1. **`STALE_TODO`** — `TODO` / `FIXME` / `HACK` / `XXX` markers in `js/` that are
   **not** acknowledged in `docs/tech-debt-tracker.md` (matched by filename). If a
   marker is real long-lived debt, record it in the tracker; then the scan stops
   nagging about it.
2. **`DANGLING_DOC_REF`** — references in `docs/*.md` to a `js/<file>` path or a
   fenced `` `func()` `` name that no longer exists in `js/`. Catches docs that
   drift out of sync when code is renamed or removed.
3. **`JS_DIR_GROWTH`** — the flat `js/` directory growing past its recorded
   baseline (`JS_DIR_BASELINE`, currently 60). The flat layout is intentional for
   the no-bundler static site, so this is a *prompt to record a grouping plan* in
   the tracker, not a demand to restructure.

## How to extend the golden-principles list

1. Add a new id + one-line description to `GOLDEN_PRINCIPLES` in
   `.github/scripts/entropy-scan.mjs`.
2. Implement a small pure `check…()` function (read-only file I/O + string checks)
   and include its output in `runScan()`'s `findings` object.
3. Add a case to `renderMarkdown()` so it shows up in the summary/issue.
4. Add a fixture-based assertion to `test/entropy-scan.test.mjs` and run
   `npm run test:entropy`.

Keep checks deterministic and low-noise: a principle that fires on everything is
worse than no principle, because it trains reviewers to ignore the issue. Prefer
"needs a tracker acknowledgement" over hard failure.

## Running it locally

```bash
npm run test:entropy                 # unit-test the scan logic
node .github/scripts/entropy-scan.mjs   # dry-run the scan, print the report
```

The CLI prints the same Markdown the workflow posts, and exits `0` regardless of
findings (they are informational).

## Provenance / IP note

Keeping an agent-maintained tech-debt log and running a scheduled low-priority
drift scan is a general, publicly-documented engineering practice (described
independently by multiple authors as tech-debt tracking, "entropy-reduction," and
scheduled upkeep scanning). This implementation is DATAGLOW's own — its own
wording, its own golden principles, its own code. No third-party text or code was
copied.
