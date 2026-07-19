# Prompt Eval → Verifiable Build Log

This document explains how DataGlow's prompt evaluation harness connects to
the Verifiable Build Log (`dev-log/checkpoints.json`), and why that
connection matters.

## The pieces involved

- **`test/prompt-eval/runner.js`** — the prompt evaluation harness. It runs
  every case in `test/prompt-eval/cases.json` against a mock evaluator that
  stands in for Guarded Copilot / Query Sentinel, checks each case's
  expected behavior, and writes a structured report to
  `test/prompt-eval/last-run.json`. That report includes the run timestamp,
  total/passed/failed case counts, a pass rate, and a `runHash` (a SHA-256
  digest of `cases.json`'s exact contents at run time).
- **`dev-log/checkpoints.json`** — DataGlow's Verifiable Build Log: an
  append-only JSON array of timestamped checkpoint entries documenting
  build/test milestones across the project's history.
- **`scripts/append-eval-to-build-log.js`** (this PR) — the bridge between
  the two. It reads `test/prompt-eval/last-run.json`, reads
  `dev-log/checkpoints.json`, appends a new entry summarizing the eval run,
  and writes the updated checkpoints file back to disk.

## How to run it

Run the eval harness first, so `last-run.json` reflects the current state
of `cases.json`, then run the append script:

```bash
node test/prompt-eval/runner.js
node scripts/append-eval-to-build-log.js
```

The append script prints a one-line summary on success, for example:

```
Appended eval run 9f3a1c2b7e4d to dev-log/checkpoints.json — 20/20 passed
```

If `test/prompt-eval/last-run.json` doesn't exist yet (the runner hasn't
been executed), or `dev-log/checkpoints.json` is missing or not a JSON
array, the script exits with a non-zero status and an explanatory message
instead of silently corrupting either file.

## What gets appended

Each run appends one entry shaped like this:

```json
{
  "timestamp": "2026-07-19T14:00:00.000Z",
  "type": "prompt-eval",
  "passRate": 1,
  "totalCases": 20,
  "passed": 20,
  "failed": 0,
  "runHash": "9f3a1c2b7e4d...",
  "note": "Automated prompt evaluation run — Guarded Copilot + Query Sentinel"
}
```

Every field is sourced directly from `test/prompt-eval/last-run.json` — the
script does not compute or infer any of these values itself, it only
reshapes and appends them.

## Why this matters

Without this connection, `test/prompt-eval/last-run.json` is an ephemeral
local file: it gets overwritten by the next run, isn't committed, and
carries no independent record of when a given pass/fail result actually
occurred. That makes it easy for a regression to go unnoticed between runs,
and impossible to later prove that a particular commit had a passing eval
suite at the time it was merged.

By appending each run into `dev-log/checkpoints.json`, every prompt
evaluation becomes a permanent, timestamped, hash-identified record in the
same audit trail that already tracks the rest of DataGlow's build and test
history. The `runHash` ties each checkpoint entry back to the exact version
of `test/prompt-eval/cases.json` that produced it, so a reviewer can
independently confirm which test cases were in effect for any historical
pass rate — turning the eval harness's output from a disposable console log
into part of DataGlow's Verifiable Build Log.

## Related

- Prompt eval harness: `test/prompt-eval/runner.js`, `test/prompt-eval/README.md`
- CI wiring for the harness: see the `feat/prompt-eval-ci` PR
- Connect script: `scripts/append-eval-to-build-log.js` (this PR)
