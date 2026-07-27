# A49 Question Scout — local AI keepers + browse help

## Goal
Ship a **career-grade but honest** local helper that:
1. Proposes candidate questions from loaded table profile (schema + sample stats).
2. Scores/filters toward **keepers** (business owner, answerable, checkable number, not vanity).
3. Lets the human **browse, edit, accept, reject** keepers.
4. Hands accepted keepers into Prove / SQL path (statement draft only — engines still prove).
5. Optional: draft narrative **outline** with placeholders for engine-verified numbers only (no invented KPIs).

## Doctrine (locked)
- AI **proposes**. Human **chooses**. Engines **prove**. Human **confirms** before portfolio/post.
- Never auto-mutate data.
- Never mark a claim GREEN without engine prove.
- Never invent numeric findings in narrative.
- Local-first: profile + prompts stay in browser; no default upload of table rows to cloud.

## Cheating boundary (product copy)
Show a short honest banner:
> "Scout proposes questions. You pick keepers. Engines prove numbers. That is professional analyst work — same as a senior using a colleague to brainstorm, then checking the warehouse."

## UX
### Entry
- After data load (or from Analyze / Ask bar): button **Question Scout**
- Also surface from empty ask bar when tables exist: "Propose keepers from this data"

### Scout panel
1. **Profile strip** (deterministic, no LLM required):
   - table names, row counts if known, column names/types, null% if available, top categories sample if cheap
2. **Propose** button → local AI (or deterministic fallback if model cold)
3. **Candidate list** (10–15):
   - question text
   - why it matters (1 line: payer/provider/policy)
   - checkable metric type: count | rate | share | delta
   - draft SQL (editable)
   - keeper score 0–100 from rule filter (not only LLM)
4. Actions per row: **Keep** / **Edit** / **Reject**
5. **Keepers tray** (max 5 highlighted): accepted questions
6. **Send to Prove** on a keeper → prefill Proof Harness statement + claim label
7. **Browse mode**: free-ask chat grounded on profile summary only (not full raw dump if huge); answers that assert numbers must say "unverified — run Prove"

### Deterministic keeper filter (must run even if LLM fails)
Score +1 each:
- mentions a business actor or decision (payer, provider, plan, dispute, quality, cost, backlog, win rate, etc.) OR generic ops language for non-healthcare tables
- references real column/table names from profile
- metric type is count/rate/share/delta/sum/avg
- draft SQL is SELECT (not DDL/DML)
Penalties:
- pure viz vanity ("make a pretty chart") without metric
- questions that need columns not in profile

Top scored become suggested keepers; human still chooses.

### Deterministic fallback proposals (no model)
If WebLLM unavailable, generate template questions from profile:
- COUNT(*) grain check
- null rate on each high-null column
- top-N frequency on top categorical column
- min/max/avg on first numeric column
- distinct count on id-like column
Label these "template (no model)" so honesty stays.

## Local model guidance (product + docs, not forced download in this PR unless already wired)
Current stack uses on-device WebLLM when available.
**Recommendation for variety of tasks (browser-first):**
1. **Default chat/scout (ship/keep):** Qwen2.5-1.5B or 3B Instruct q4 — fast cold start, enough for question rewrite + SQL draft
2. **Better SQL/reason (optional larger):** Qwen2.5-7B Instruct q4 if device RAM allows — slower download
3. **Do not block Scout on big models** — deterministic path must work offline of model download
4. External cloud AI remains OK for public CMS brainstorm; Scout is the **local** path

This PR does **not** require swapping the default model unless trivial. Prefer wiring Scout to existing local AI bridge; document model ladder in RESULT.

## Non-goals
- Auto-prove without human
- Auto-post LinkedIn
- Cloud LLM proxy as default
- Full DE/agent autonomy
- Career Lane C
- Maven clone contests

## Files (expected)
- canvas/index.html (+ integrity)
- css as needed
- small module if pattern exists for panels
- test/a49-question-scout.test.mjs
- A49_QUESTION_SCOUT_RESULT.md
- package.json test script + CI batch job if pattern matches jobs-polish

## Acceptance
1. With sample claims loaded (or profile mock in tests), Scout opens and shows candidates.
2. Deterministic filter ranks checkable questions above vanity.
3. Keep → Keepers tray (≤5 emphasis).
4. Send to Prove prefills SQL/claim when Prove API exists; else copies statement to a visible field / dispatches existing event.
5. Banner states professional vs cheating boundary.
6. Works with model offline via templates.
7. Tests cover filter scoring + panel markers without requiring GPU model download in CI.
8. PR open, not merged.

## Workspace
`/home/user/workspace/dataglow-f2133f3e-e20d9956` — existing only. Pull main first. Branch `feature/a49-question-scout`.
