# DataGlow Development — Decision & Outcome Log

This is the permanent, version-controlled record of every `dataglow development` run: what was asked,
what live repo state was found, what was decided, what was built, and one concrete lesson for next time.
It lives in the repo (not a sandbox-local cache, not a 28-day rolling memory) so it is genuinely durable
and inspectable — the user can read it and diff it like any other file. Newest entry at the top.

---

## [2026-07-15 07:51 CT] Shipped Guarded Copilot Batch 1 dark; caught and fixed a repo-wide CI ceiling + a manifest-drift gap before merge

**Trigger:** "Build it all... Also, keep working" — user approved Guarded Copilot (full scope: deterministic
tier + optional in-browser small-model tier) plus 3 other Mission Center items, then explicitly asked to
continue autonomously through build/test/PR/CI rather than pausing after each step.

**Step 1 findings:** main was clean going in (0 open PRs, CI green, 5 dark flags already known/documented).

**Decision:** Build Guarded Copilot Batch 1 (deterministic core only — Tier 2 on-device-model refinement
stubbed but gracefully no-ops without WebGPU) as a read-only chat-answer engine composing the EXISTING
AI Readiness Gate, AI Touch Ledger, and Story grade vocabulary. Deliberately excludes any import of or
call to the Agent Action Firewall's proposeAction/confirmAndApply, so it cannot mutate data by
construction — verified with a structural red-team test, not just asserted in a comment.

**Built:** `js/agents/guarded-copilot.js` (262 lines) + `test/guarded-copilot.test.mjs` (138 lines, 34/34
passing). Also updated `flags.manifest.json` (new `guardedCopilot` flag, default false), `NORTH_STAR.md`,
`docs/capability-map.md`, `capability-map.manifest.json`, `package.json` (new test script), and
`.github/workflows/job-agent-action-firewall.yml` (added Guarded Copilot's test as a second job in this
already-counted file instead of a new top-level file — see Safety notes).

**Outcome:** shipped-dark (merged to main, flag `guardedCopilot: false`)

**Safety notes:** Two real problems found and fixed during this run, neither swept aside:
1. **CI ceiling.** `main`'s `test.yml` was already at GitHub's hard cap of 50 unique reusable workflows
   callable from one file (raised from 20 in Nov 2025). My original PR added a 51st file
   (`job-guarded-copilot.yml`), which made the entire `tests` orchestrator fail to parse — a 0-job,
   0-second failure, confirmed via `gh api .../jobs` returning `total_count: 0`. Fixed by running the new
   test as a second job inside the already-counted `job-agent-action-firewall.yml` instead of adding a
   52nd top-level entry. `test.yml` itself ended up byte-identical to `main` — zero diff there. Documented
   the constraint in `NORTH_STAR.md` as a real, now-verified repo-wide limitation for the next PR that
   wants a genuinely new standalone CI job (real fix: one more level of workflow nesting, not attempted
   here to keep this PR's diff scoped).
2. **Capability-map drift.** The repo's own drift-detector gate (`capability-map-drift`, 24 tests) failed
   because I'd documented Guarded Copilot in `docs/capability-map.md` but not in the machine-readable
   `capability-map.manifest.json`. Added the matching manifest entry (id, area, platforms, files,
   exported symbols); drift detector then reported 0 findings.
Independently re-verified before merge (not just trusting green CI): grepped the actual diff for any
firewall import/call (none — only comments) and any write/insert/delete/update/drop/mutate verb or SQL
DML (none). Confirmed the new module is not referenced anywhere in `js/app-shell/` — genuinely
unreachable/inert until Batch 2 wires it in.

**Flag:** `guardedCopilot` — `enabled: false` (dark; awaiting a separate One Confirm decision to go live)

**Blast radius:** small — 8 files, purely additive (1 new module, 1 new test file, CI/docs/manifest
updates); zero existing production code path's logic was modified.

**Hygiene debt:** 0 open PRs, 29 open issues, 5 dark flags (`conversationalPackBuilderVoice`,
`meetingScribeLiveCapture`, `provenancePacket`, `openFloorSandboxTwin`, `guardedCopilot` — the last just
added this run), ~31 remote branches (feature/guarded-copilot itself among them, not yet deleted post-
merge). Direction vs. prior entries: open-PR count flat at 0 (healthy); dark-flag count rose by 1 this run
(expected — every new dark-shipped feature adds one until its own future enable-confirm).

**Process learning:** When a PR adds a new standalone `job-*.yml` CI file, check the total `uses:` count
in `test.yml` against `main` FIRST (`grep -c 'uses: ./.github/workflows/job-' test.yml`) before writing
any CI config — this run discovered the cap only after a live 0-job CI failure, which cost a full
pause-and-diagnose cycle that a one-line pre-check would have avoided. Also: run the capability-map drift
check locally (`npm run test:capdrift`) as part of Step 4.4's own safety verification, not just as an
incidental CI job — it would have caught the manifest gap before ever pushing.

**PR(s):** [PR #243](https://github.com/Andre-Weissmann/dataglow/pull/243) — merged as `79469b6`

**Portfolio note:** Built a read-only "Guarded Copilot" answer engine for DataGlow that explains its own
trust/readiness/lineage decisions in plain language — composing existing gate, ledger, and grading modules
rather than adding a new source of truth, and structurally prevented from ever mutating data (verified
with a dedicated red-team test, not just a design intent). Shipped dark behind a feature flag. Along the
way, the CI pipeline surfaced a real, previously-invisible constraint — the repo had quietly hit GitHub's
hard limit on reusable workflow files — which I diagnosed from first principles (workflow-run job counts,
GitHub's own changelog) and fixed without needing to touch any unrelated CI job.

---

## [2026-07-14 13:15 CT] Launched Checkpoints (before/after proof) system + cleared the PR/branch backlog

**Trigger:** Session pivot: "dataglow development is Perplexity AI chat in Perplexity but the GUI for
dataglow development will show me before and after running." Question-tree answers: focus = before/after
proof view; trigger = automatic (run-start/run-end) plus a manual "log this" command; ambition = super
huge swing. User then explicitly approved (1) building the real Checkpoints system and (2) including
backlog cleanup (stale PRs + orphaned branches) in the same run.

**Step 1 findings:** 3 open PRs (#241 new checkpoints work, plus two long-stale docs-only drafts #222 and
#191 both about PR #121's now-resolved dependency chain, both draft/never-merged "per standing rule"), 29
open issues (mostly wiki stub issues, pre-existing, not touched), 48 branches with commits but no open PR
and no longer tracked by any PR, 4 dark flags (unchanged), CI green on main.

**Decision:** Build `dev-log/checkpoints.json` as a structured, dashboard-renderable before/after data
layer (companion to journal.md's prose log), wire the `dataglow-development` skill file with automatic
run-start/run-end checkpoint writes plus a manual "log this" trigger, then use the same run to clear the
backlog Step 1 surfaced: rebase and merge #222/#191 (both were genuinely stale only because of appended
sibling entries in the same doc section — trivial, safe append-only conflicts once inspected), and delete
the subset of orphaned branches independently confirmed (via `git merge-base --is-ancestor`) to be fully
merged into main already, so nothing unique was at risk.

**Built:** `dev-log/checkpoints.json` (schema: id, startedAt/endedAt, trigger, title, before/after repo-
state snapshot, diffstat, commits, prUrl, verification, outcome). `dataglow-development/SKILL.md` updated
with the checkpoint-logging steps and the new "log this" manual trigger; `checkpoints_schema.md` added as
a reference doc. Rebased and merged PR #191 and #222 (docs-only, tech-debt-tracker.md entries about PR
#121's resolved dependency chain). Deleted 16 of the 48 orphaned branches after confirming each one's tip
commit was already an ancestor of `main` (fully shipped elsewhere via squash/cherry-pick) — left the other
32, which carry real unmerged/unique commits, untouched for a dedicated future review.

**Outcome:** shipped-dark (checkpoints.json itself has no `enabled` flag — it's a data file, not a human-
facing feature — but the dashboard's read of it is additive/non-breaking) + backlog cleanup fully executed
(open PRs 3 → 0, orphan branches 48 → 32).

**Safety notes:** Both #191 and #222 showed `CONFLICTING`/`DIRTY` merge state before rebase — inspected
with `git merge-tree` first and confirmed both were pure trailing-append conflicts (another doc entry had
been appended at the same insertion point since the drafts were opened), not real semantic conflicts, so
rebasing and keeping both sides was safe. Branch deletion was NOT inferred from the general "triage"
authorization — the platform's own safety classifier correctly flagged that destructive git action and it
was re-confirmed explicitly with the user, naming all 16 branches before any deletion executed.

**Flag:** n/a — no feature flag attached to this run's changes (data file + docs only).

**Process learning:** When rebasing multiple stale PRs that touch the same appended doc section, expect a
second round of conflicts after the first PR of the batch merges (main moves again) — budget for it rather
than assuming one rebase per PR is enough. Also: `git merge-base --is-ancestor <branch> main` is a cheap,
reliable, mechanical litmus test for "is this orphaned branch's content already shipped" — use it as the
first pass on any future branch-triage run before spending time reading diffs by hand.

**PR(s):** https://github.com/Andre-Weissmann/dataglow/pull/241, https://github.com/Andre-Weissmann/dataglow/pull/191, https://github.com/Andre-Weissmann/dataglow/pull/222

---

## [2026-07-14 08:35 CT] Made the live companion dashboard genuinely interactive — real polling, real GitHub Events feed, live per-job CI status

**Trigger:** Repeated, most-emphasized standing ask across sessions: "I need dataglow development to run
with a GUI to show me things are getting done" — the dashboard at dataglow-development.pplx.app had been
a static one-shot snapshot (fetch once on load, render once) rather than something that visibly proved
work was happening. No AI API keys to be purchased — must stay pure client-side GitHub REST/Events API.

**Step 1 findings:** Dashboard source (`/home/user/workspace/dataglow-development-live/`) had a single
`init()` that fetched PRs/issues/CI runs once and wrote one static summary line into the activity log —
no polling loop, no real per-event feed, no live CI job visibility. This was the literal gap behind the
user's repeated complaint.

**Decision:** Rebuild `script.js` to poll GitHub's public REST + Events API on an interval (~30s normal,
~12s while a CI run is actively in progress) with a visible countdown + pulse indicator, add a real
chronological activity feed sourced from `GET /repos/{repo}/events` (pushes, PR opens/merges, issue
activity — timestamped, newest appended live, not a scripted blob), and add a "Happening right now" strip
that renders each job of an in-progress CI run and updates its status (queued → in_progress → success/
failure) on every poll tick. Kept all existing panels (PRs, issues, orphan branches, flags, health grade,
Curiosity Thread, backlog, cost/time trend) intact and unchanged in logic.

**Built:** `dataglow-development-live/index.html` (new `.mc-feed-header` polling indicator + `#rightnow-panel`
CI-job strip), `script.js` (rewritten: `pollActivityFeed`, `appendFeedItem`, `describeEvent`, `pollRightNow`,
`startPollLoop`/`pollOnce` interval logic — full rewrite, ~530 lines), `style.css` (new feed-header,
refresh-dot pulse, rightnow-panel, job-pill, and feed-item styles). This is personal dev tooling, not a
DataGlow product feature — no PR against `github.com/Andre-Weissmann/dataglow` was needed or opened.

**Outcome:** shipped-live (published directly — this is a standalone tool with no feature-flag gate; no
`main`-branch merge or user-facing risk gate applies the way it does for actual DataGlow product code)

**Safety notes:** Automated visual QA (via the platform's own pre-publish validator) caught three real
bugs before anything went live: (1) a CSS flexbox `min-height:0` bug causing the "Happening right now"
panel to visually overlap the first activity-feed row, (2) a data bug where `PushEvent` payloads with
`distinct_size: 0` rendered a nonsensical "pushed 0 commits" line, (3) a data bug where some
`PullRequestEvent` payloads carry a generic placeholder title identical to `PR #<n>`, producing duplicated
text like "opened PR #239 PR #239". All three were fixed and re-verified via a second validator pass plus
a manual mobile-viewport Playwright QA pass (tab switching, text wrapping, no overlap) before publishing.

**Flag:** n/a — this tool has no feature flags; it is a standalone read-only dashboard, not gated DataGlow
product behavior.

**Process learning:** The platform's own pre-publish visual validator is a genuinely useful independent
safety net for this kind of UI work — it caught real functional/data bugs (not just cosmetic ones) that
would have shipped unnoticed on a single self-review pass. For any future dashboard-source changes, budget
for at least one validator-driven fix-and-redeploy cycle rather than assuming the first deploy attempt will
pass; also: GitHub's Events/Actions API payloads are less clean than they look (zero-commit pushes,
generic/duplicate titles) — always defensively branch on payload shape rather than trusting fields exist.

**PR(s):** n/a — no DataGlow repo PR; published directly to https://dataglow-development.pplx.app
(asset_id `18a83d56-b32d-40b0-acd8-d4c5c2896c50`, site_id `360634e0-1328-46ea-b05a-9d1b1251076a`).

---

## [2026-07-14 08:07 CT] Land PR #106 + #121; CI job-count ceiling hit twice; real root cause of #121's failure was a pre-existing YAML bug, not job count

**Trigger:** Continue and complete the batch of finishing PR #106 (Provenance Packet Batch 3) and PR #121
(Open Floor Batch B: Sandbox Twin) — both open, both needing CI fixes before they could merge.

**Step 1 findings:** Both PRs had passing local tests but failing CI. #106's `room-signaling-and-broadcast`
job and #121's `provenance-packet`/`open-floor-sandbox-twin` jobs pushed `test.yml`'s reusable-workflow
count to 51 — one over GitHub's documented 50-unique-reusable-workflow-per-file ceiling (confirmed via
official GitHub Docs: "You can call a maximum of 50 unique reusable workflows from a single workflow
file... includes any trees of nested reusable workflows"). This ceiling had already been hit once this
session (see tech-debt-tracker) and is a recurring structural risk as the repo's job count grows.

**Decision:** Fix #106 by consolidating `room-signaling` + `room-broadcast` into one job file. Fix #121
the same way, consolidating `provenance-packet` (Batch 1) + `provenance-packet-batch-2` into one job. Both
verified locally (job count back to 50, zero test coverage lost — all suites still run as separate steps
within the merged job). #106 then passed CI cleanly and merged. #121, however, KEPT FAILING with the exact
same "workflow file issue, zero jobs run" signature even after the job-count fix — and historical `gh run
list` data showed this same failure on #121's branch predating this session's changes entirely (2026-07-11,
2026-07-13 x2). This was the critical signal that the job-count theory, while a real and necessary fix, was
NOT the actual cause of #121's specific failure. Rather than keep guessing or re-pushing blindly, stopped
and fetched GitHub's own error annotation directly from the PR checks UI (API didn't surface it) — which
stated plainly: "error parsing called workflow ... job-open-floor-sandbox-twin.yml : yaml syntax error on
line 27." Root cause: an unquoted colon inside a job `name:` field (`name: Open Floor Sandbox Twin
(red-team: firewall-gated twin + promote)`), which YAML parses as an invalid nested mapping. This was a
genuine pre-existing bug in the PR's own new file, unrelated to and predating any of this session's job-
count work. Fixed by quoting the string.

**Built:** Nothing product-facing beyond what #106 and #121 already contained (portable signed .dataglow
packet export/import; a firewall-gated, forkable in-memory dataset "sandbox twin" with inert-until-
confirmed promotes). This run's own contribution was purely CI-infrastructure fixes: two job-file
consolidations (`job-provenance-packet.yml` batch-1+2 merge for #121, plus the earlier #106 fix) and one
YAML syntax fix (`job-open-floor-sandbox-twin.yml`).

**Outcome:** shipped-dark (both PRs merged to `main`; `provenancePacket` and `openFloorSandboxTwin` flags
both confirmed `enabled: false` with no unguarded call site outside their own module/tests — zero live
user-facing behavior change from either merge)

**Safety notes:** Independent diff review on both PRs found no eval/exec/secret-exposure/destructive-op
patterns. The two `trusted: true, force: true, confirmed: false` constructs found in #121's diff are inside
the red-team test file itself — deliberately constructed adversarial bypass attempts that the tests assert
get rejected (`AgentActionBlocked`), not real vulnerabilities. Both flags confirmed dark before merge.

**Flag:** `provenancePacket`: `false` (dark, unchanged). `openFloorSandboxTwin`: `false` (dark, newly
added this PR, `addedInPR: gen45-open-floor-sandbox-twin`). Both awaiting a future explicit enable decision.

**Process learning:** An identical CI failure signature ("workflow file issue, zero jobs run") can have
MULTIPLE distinct root causes — don't assume a fix that worked for one PR (#106's job-count consolidation)
automatically explains an ostensibly-identical failure on a different PR. The decisive diagnostic step was
checking whether the SAME failure pre-dated the fix being applied (via `gh run list` history on the
branch) — that single check correctly triggered a pivot away from a plausible-but-wrong theory. Also: the
GitHub REST/gh-cli API does not surface the actual human-readable parse-error annotation text for a failed
workflow-file run (`jobs` endpoint just returns `total_count: 0`) — when a workflow fails at parse time
with no jobs, go straight to the PR's Checks UI in a browser for the real annotation text instead of
guessing from API fields alone; this would have saved significant investigation time this run.

**PR(s):** [#106](https://github.com/Andre-Weissmann/dataglow/pull/106) (merged),
[#121](https://github.com/Andre-Weissmann/dataglow/pull/121) (merged)

---

## [2026-07-14 06:09 CT] First run: live GitHub-data dashboard replaces chat-only status checks

**Trigger:** User wanted "dataglow development" to be one all-in-one place for building, fixing bugs,
and managing backlog — streamlined, no context-switching — and asked to review everything discussed
across the whole ideation history before proceeding, after several turns of scope drift (mockup → live
GUI → AI chat → LLM-attachment requirement).

**Step 1 findings:** Live repo check found the situation had changed significantly since the last known
state: 5 open draft PRs (#222, #191, #179, #121, #106, all with passing CI), 29 open issues (27 of them
"Wiki page needed" documentation backlog items, plus #224 "Entropy-Reduction Scan" and #225 "Wiki page
needed: Open Floor" as new items), and — the most significant finding this run — **48 branches with real
commits and no open PR**, not the 3 an earlier stale local clone suggested. A fresh clone confirmed 55
total remote branches vs. 5 open-PR branches. This is a materially larger hygiene gap than previously
tracked and should be treated as a standing backlog item, not a one-off note. Flags manifest: 47 total,
2 dark (`conversationalPackBuilderVoice`, `meetingScribeLiveCapture`), both intentionally dark per their
own documented reasoning. CI on `main` passing.

**Decision:** Drop the AI-chat-in-a-published-website idea entirely (published sites cannot call LLM APIs
or external tool connectors — confirmed hard platform limit, and Perplexity's Sonar API has no free tier
in 2026). Instead, build a fully static, zero-cost, zero-API-key dashboard that reads live public GitHub
REST API data directly in the browser (the repo is public, so unauthenticated reads work with no secrets
anywhere). Real build/fix/plan work stays in chat via the `dataglow development` trigger phrase — the
dashboard is a companion visual status view, not a replacement for the agentic workflow.

**Built:** `dataglow-development-live/` — a static site (index.html/style.css/script.js) that fetches live
PRs, issues, branches, and flags.manifest.json directly from `api.github.com` and `raw.githubusercontent.com`
with no auth. Computes a transparent, rule-based health score (documented formula, not a black box).
Surfaces real "Curiosity Thread" findings (stale PRs, orphaned branches, dark flags) via rule-based checks
against the live data, not scripted/fake content. Cost/time trend badge reads this same `dev-log/journal.md`
file once entries accumulate. Reused the "Option B" visual shell (health rail / activity log / backlog +
curiosity rail) the user had already approved earlier in ideation.

**Outcome:** shipped-live (published as a static site — no flag needed since it changes no existing
DataGlow product behavior; this is personal dev tooling, not a DataGlow product feature, so it does not
go through the same flag-gated enable process as in-product features)

**Safety notes:** Confirmed no secrets, tokens, or credentials anywhere in the code — only unauthenticated
public GitHub REST API calls. Ran the required pre-publish security review subagent before publishing.
No backend, no database, no user data collected.

**Flag:** n/a — this is personal dev tooling, not a DataGlow product feature; it does not touch
`flags.manifest.json`.

**Process learning:** When "make it real/live" requests keep escalating turn-by-turn (mockup → live data →
AI chat → backend dependency), stop and ask what specific capability is actually being asked for before
adding the next layer — in this case, the real need ("see live status without needing an AI conversation")
was fully satisfiable without any AI/backend at all, and adding one would have introduced cost and
complexity that solved nothing. Also: always do a fresh `git clone` (not reuse a possibly-stale local
clone) before reporting repo-wide branch/PR counts — this run's local clone was stale enough to undercount
orphaned branches by 45.

**PR(s):** (this entry — doc-only journal creation, committed directly per the schema's first-run
bootstrapping note)
