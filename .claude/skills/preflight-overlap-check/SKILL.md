---
name: preflight-overlap-check
description: Run BEFORE starting any new DataGlow feature or fix. Searches open PRs, the capability map, and the codebase together to catch duplicate/overlapping work before any code is written, then routes to either an existing PR to extend or a short frozen mini-spec to build against. Use this whenever a coding-agent session is about to begin new work on this repo, especially when multiple sessions may be running in parallel.
---

# Pre-flight overlap check

DATAGLOW gets built by many separate coding-agent sessions, often running in
parallel, each ending in its own PR. Nothing today stops two sessions from
independently building the same capability — this already happened once
(PR #108 and #114 both built an "Agent Action Firewall," and reconciling them
in #133 required a manual, careful merge that still nearly lost a real
capability, undo/reversibility, that #108 had and #114 didn't). This skill is
the fix: a short, structured pre-flight step that runs *before* Stage 1
("Isolate," see [`docs/build-nervous-system.md`](../../../docs/build-nervous-system.md))
of a new coding-agent session.

This is dev-tooling only. It has no UI, no feature flag, and ships nothing to
end users of DataGlow the app — it's a workflow discipline for whoever (human
or agent) is about to write DataGlow code.

## When to run this

Any time you (a human or an agent) are about to start new DataGlow work —
before creating a worktree, before writing a spec, before touching any file.
Skip only for genuinely trivial one-line fixes (a typo, a broken link) where
the "state a short plan first" rule in `AGENTS.md` already covers it.

## The five steps

### 1. State the ask in one or two sentences

Write down, in your own words, what you're about to build or fix. This is the
query for every search below — vague asks produce vague search results.

### 2. Search three sources as one motion, not three afterthoughts

Do all three searches before reading any of the results, so you see the full
picture at once instead of anchoring on whichever source you checked first.

**a. Open AND recently-closed PRs** (the most likely place duplicate work is
hiding *right now*, plus recent history — a capability can be closed as
"resolved" without ever reaching the capability map if the resolving PR is
still open itself):

```sh
gh pr list --repo <owner>/dataglow --state open --limit 50 \
  --json number,title,body,isDraft,createdAt \
  --jq '.[] | "\(.number) [\(.isDraft | if . then "draft" else "ready" end)] \(.title)"'
```

`gh search prs` requires separate calls for `--state open` and `--state
closed` (it has no `all` option), so run both:

```sh
gh search prs --repo <owner>/dataglow --state open   "<keywords from step 1>"
gh search prs --repo <owner>/dataglow --state closed "<keywords from step 1>"
```

Skim the `body` field of any title that sounds close — titles alone hide
overlap (e.g. "Agent Action Firewall" vs. "Firewall-gated Sandbox Twin" look
unrelated by title but shared real logic). The closed-PR pass matters even
though those PRs are done: it's how you'd discover, for example, that #108
and #114 were ever a duplicate pair in the first place — that fact is only
visible in PR history, not in the current capability map or codebase.

**b. The capability map** (what's already shipped and documented):

```sh
grep -i "<keyword>" docs/capability-map.md capability-map.manifest.json
```

If a capability with overlapping scope already exists, read its full entry —
the map entries are written to be self-contained, so this is usually enough to
tell whether you'd be duplicating logic, not just a similar-sounding feature.

**c. The codebase itself** (catches work that shipped but was never PR'd, or
whose capability-map entry undersells its actual scope):

```sh
grep -rn "<keyword>" js/ --include="*.js" -l
```

Read any hits, not just the file list — a match can be a coincidental word or
a real prior implementation. Note that this layer only sees code already
merged to `main` — it will not catch overlap with a still-open PR whose
branch hasn't landed yet. That's what search (a) is for. In a repo with a
fast-moving `main` and several sessions in flight, (a) is usually the layer
that matters most; don't skip it just because (c) comes back empty.

### 3. Judge overlap honestly, don't just pattern-match on titles

Ask directly: does anything found in step 2 already do most of what step 1
describes? Three honest answers, not a sliding scale:

- **Yes, clearly** — same capability, same or adjacent files.
- **Partially** — shares a mechanism (e.g. both use the chain-of-custody
  trail, or both need a confirm-gate) but the end capability differs.
- **No** — nothing found addresses this ask.

Bias toward "partially" over "no" — the firewall duplication happened because
two sessions each concluded "no" when a careful read would have found
"clearly yes."

### 4. Branch on the judgment

- **Clearly overlapping, open PR exists** → don't start new work. Report the
  PR number and ask whether to extend that PR's branch instead of opening a
  new one. If the existing PR is stale/abandoned-looking, say so and ask
  whether to revive it or supersede it explicitly (never silently duplicate
  and let a human discover the overlap later at merge time).
- **Partially overlapping** → name the shared mechanism explicitly in the plan
  from `AGENTS.md`'s "state a short plan first" step, so a reviewer can see
  you deliberately reused it rather than reinventing it. Proceed to Stage 1.
- **No overlap found** → proceed to Stage 1 as normal. Note in the PR
  description (or the `intent:`/`gen:`/`integrate:` lines) that a pre-flight
  overlap check was run and found nothing, so a reviewer doesn't have to
  wonder whether one happened.

### 5. Report anything else notable, even if unrelated

While reading through search results in step 2, you'll sometimes see things
unrelated to the ask — a stale flag past its promote-or-delete clock (see
`docs/build-nervous-system.md` Stage 4), a doc that references a deleted file,
an obviously broken assumption. Note these in your final report even though
they're out of scope for the current task. Don't fix them without being asked
— just surface them, the same way this skill itself was built after noticing
(during an unrelated PR review) that a rebase had reintroduced a stale
`js/runtimes-viz/swift-preview.js` reference into `README.md` after the file
had already been removed on `main`.

## Why this is structured retrieval + judgment, not embeddings

This intentionally does NOT propose building a vector index or embedding
search across PRs/code/specs. Sourcegraph's own enterprise product moved
*away* from embeddings toward lexical/structured search for cost and
freshness reasons, and Linear's production duplicate-detector for issues uses
the same pattern this skill uses: cheap structured search first, then a human
or LLM judges the actual candidates. A repo this size doesn't need more
infrastructure than `grep` and `gh` plus honest reading.

## What this does not do

- It does not auto-close, auto-comment on, or modify any existing PR — it
  only informs the decision of whether to start new work.
- It does not replace code review. Finding "no overlap" here doesn't mean the
  new PR is good; it only means it isn't a duplicate.
- It does not guarantee zero duplication — a keyword search can miss a
  differently-named implementation of the same idea. Treat "no overlap found"
  as "no overlap found by this check," not as a certainty.
