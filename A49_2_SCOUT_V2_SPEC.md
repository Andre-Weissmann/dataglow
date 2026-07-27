# A49.2 Question Scout v2 — smarter keepers

## Depends on
A49 Question Scout merged on main (questionScout flag + modules).

## Goal
Make Scout feel career-grade for real projects (starting with healthcare public data / IDR-shaped tables) without becoming autopilot cheating.

## Additions over v1
1. **Dictionary-aware prompts** — if user pastes or loads a column dictionary (JSON/CSV/text), Scout grounds proposals in field definitions
2. **Join hints** — when 2+ tables in profile, propose join keys by name similarity (id, *_id, code) and questions that need joins
3. **Anti-vanity rank v2** — stronger penalties for chart-only / “interesting” with no metric; boost count/rate/share/delta/win-rate/backlog language
4. **Domain packs (templates)** — `healthcare-idr` starter pack: dispute volume, closure mix, specialty concentration, win rate, QoQ delta (only if columns match; else skip)
5. **Browse mode harden** — any numeric assertion tagged UNVERIFIED until Prove
6. **Keeper quality meter** — show how many of 5 keepers pass full filter (business owner + answerable + checkable + not vanity)
7. **Export keepers JSON** — portable list for portfolio method section

## Non-goals
- Cloud LLM default
- Auto-prove
- Full CMS dictionary scrape network
- Replacing dual-engine

## Model
Keep Qwen2.5-1.5B bridge; improve prompts. Optional note in UI: larger local model later. Deterministic path must still work cold.

## Deliverables
- Extend js/question-scout/*
- tests a49.2
- RESULT + PR feature/a49-2-scout-v2 — do not merge until confirm
- capability-map registration if new symbols/files

## Acceptance
1. With multi-table profile, join-hint candidates appear
2. IDR pack only emits questions when columns fuzzy-match
3. Vanity question scores below checkable ones in unit tests
4. Dictionary text improves prompt payload (tested)
5. Export keepers works
6. CI green path same as A49
