---
name: debug-log-tree
description: Run when you (human or agent) hit a bug, error, or a fork-in-the-road design decision while working on DataGlow. Searches git/PR history, the tech-debt tracker, and past Perplexity Computer sessions together to check whether this exact problem was already hit and solved, before re-solving it from scratch. Logs the outcome afterward so the next session is faster. Complements preflight-overlap-check (which runs BEFORE new work to catch duplicate features) by running DURING work, when something breaks or a real decision needs to be made.
---

# Debug log tree

DataGlow is built across many short, mostly-independent coding-agent sessions.
Without a shared memory, the same bug gets re-diagnosed from scratch, the same
"is this a real fix or a workaround" decision gets re-litigated, and a fix
that was already tried and rejected quietly gets tried again. This skill is
that shared memory: a short branching workflow you run the moment you hit a
bug/error/decision, before spending real effort solving it.

This is dev-tooling only, same as `preflight-overlap-check` — no UI, no
feature flag, ships nothing to end users. Think of the two skills as a pair:

| | Runs when | Catches |
|---|---|---|
| `preflight-overlap-check` | **Before** starting new work | Duplicate/overlapping features being built twice |
| `debug-log-tree` (this skill) | **During** work, when something breaks or forks | The same bug/error/decision being re-solved from scratch |

## When to run this

- You hit an error, a failing test, a stack trace, or unexpected behavior.
- You're about to make a real design decision with more than one reasonable
  answer (not "which variable name" — "should this be a new flag or extend
  an existing mechanism," "is this a real bug or expected behavior," "should
  this fail open or fail closed").
- In a Computer session: just ask directly, e.g. "run debug log tree on this
  error" or describe the bug and ask "check the debug log tree first." There
  is no slash command — reference this skill by name or by its path
  (`.claude/skills/debug-log-tree/SKILL.md`) and the workflow below runs the
  same way regardless of which surface invoked it.
- In Claude Code: auto-discovered like any other skill in `.claude/skills/`.

Skip only for genuinely trivial one-line issues (a typo, an obviously-missing
import) where searching would take longer than just fixing it.

## The four steps

### 1. State the problem in one or two sentences

Write down the error message (verbatim, not paraphrased — exact strings match
better than summaries), the file/function involved, or the decision you're
facing. This is the query for every search below.

### 2. Search three sources as one motion

Do all three before reading results, so you see the full picture before
anchoring on whichever source you checked first.

**a. The tech-debt tracker** (the most likely place a *known, already-diagnosed*
issue lives — this is DataGlow's existing living bug/decision log, don't fork
a second one):

```sh
grep -i -B2 -A15 "<keyword>" docs/tech-debt-tracker.md
```

Read the full entry, not just the title line — entries include `Status`
(`open`/`fixed`/`wontfix`) and, when fixed, a `Resolution:` with the actual
fix and the PR it landed in. A `wontfix` entry is just as valuable as a
`fixed` one: it tells you the "obvious" fix was already considered and
rejected, and why — re-proposing it wastes a review cycle.

**b. Git and PR history** (catches bugs fixed before they ever got a
tech-debt-tracker entry, or fixed inside a PR whose description has the real
diagnosis):

```sh
git log --all --oneline -i --grep="<keyword>"
gh search prs --repo <owner>/dataglow --state open   "<keyword>"
gh search prs --repo <owner>/dataglow --state closed "<keyword>"
```

For a specific error message, search the exact string, not a paraphrase —
`git log --all -S"<exact string from the error>"` (pickaxe search) finds the
commit that introduced OR removed that literal text, which is often the
commit that fixed it.

**c. Past Perplexity Computer sessions** (catches reasoning/decisions that
never made it into a commit message or tracker entry at all — a session that
debugged something live, decided against a fix, or explained a tradeoff in
conversation only):

- If you're running as a Computer session yourself: use `memory_search` with
  the same keywords/error string. This is agent-backed and searches across
  past sessions directly.
- If you're running inside Claude Code (no direct access to Computer memory):
  ask the user directly — "has this come up in a Computer session before?" —
  or, if the user has a Computer session open, ask them to run this same
  query there and paste back anything relevant. Don't skip this source just
  because Claude Code can't reach it directly; surface the gap instead of
  silently searching only (a) and (b).

### 3. Judge honestly: has this exact thing (or something adjacent) already been solved?

Three honest answers:

- **Yes, exact or near-exact match** — same error string, same root cause, or
  the tracker/a PR already names this precise decision and its answer.
- **Adjacent** — a related bug/decision exists (same file, same subsystem, same
  failure mode) but not this exact case.
- **No** — nothing found addresses this.

Bias toward "adjacent" over "no," same discipline as `preflight-overlap-check`
— a keyword miss doesn't mean a prior session never touched this.

### 4. Branch on the judgment, then log the outcome

- **Exact match found** → don't re-diagnose. Apply the known fix (if `fixed`)
  or state the known `wontfix` reasoning and stop (don't re-propose it without
  new information that would change the original reasoning). Cite the tracker
  entry date or PR number in your own commit/PR description so the next
  session sees this was reused, not rediscovered.
- **Adjacent found** → read it fully before diagnosing further; it often
  narrows the search space a lot (e.g. "every dataset-load path routes through
  `runDatasetLoad()`," from the golden-dataset race entry, tells you where to
  look for a *different* race in the same function). Proceed to diagnose the
  actual difference, and name the adjacent entry in your fix's own log entry.
- **No match found** → diagnose and fix normally. This is genuinely new
  information — which is exactly why step 5 matters.

**Always log the outcome, win or lose, in `docs/tech-debt-tracker.md`**,
using its existing entry format (Description / Severity / Area / Status,
plus Resolution once fixed). This applies even when you conclude "not a bug,
expected behavior" — log it as `wontfix` with the reasoning, so the next
session that hits the same confusing-but-correct behavior finds your
reasoning instead of re-deriving it. A decision (not just a bug) belongs here
too: use `Area` for the subsystem and write the decision + reasoning in
`Description`, `Status: fixed` with the resulting choice in `Resolution`.

## Why one shared log instead of a new one

`docs/tech-debt-tracker.md` already exists, is agent-readable/writable, and
the weekly entropy-reduction scan (`docs/entropy-reduction-scan.md`) already
reads it. Building a second, parallel "debug log" file would fragment the
one place sessions already know to check — split memory is worse than no
memory, because a future session might check only one of the two and
conclude falsely that nothing prior exists. This skill's only job is to make
sure that tracker gets *searched* before a bug is re-diagnosed, and gets
*written to* after — not to replace it.

## What this does not do

- It does not auto-fix anything. Finding a known fix still requires a human
  or agent to apply it deliberately — this skill only prevents the wasted
  re-diagnosis step.
- It does not guarantee the tracker is complete. A session that fixed a bug
  without logging it (before this skill existed) is invisible to step 2a;
  that's exactly the gap step 2b/2c exist to partially cover.
- It does not replace `preflight-overlap-check`. That skill runs before new
  work starts to catch duplicate *features*; this one runs when something
  *breaks* or a real *decision* needs an answer. Run both where they apply —
  they aren't mutually exclusive within a single session.
