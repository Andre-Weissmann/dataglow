# DataGlow Development — Decision & Outcome Log

This is the permanent, version-controlled record of every `dataglow development` run: what was asked,
what live repo state was found, what was decided, what was built, and one concrete lesson for next time.
It lives in the repo (not a sandbox-local cache, not a 28-day rolling memory) so it is genuinely durable
and inspectable — the user can read it and diff it like any other file. Newest entry at the top.

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
