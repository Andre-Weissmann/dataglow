# DataGlow enterprise-readiness scoping (2026-09-23)

Refresh of the 2026-07-19 "easy transition later" audit, against the real repo at `aa935b8`
(post The Bench, all 4 batches merged and live). No source code changed in this pass — scoping
only, per the standing rule that a licensing decision belongs to the user, not a default.

## What changed since the last audit (2026-07-19)

The prior audit's own findings 1 and 2 are still accurate in direction, but two things were
missed at the time and are corrected here:

1. **A real enterprise policy engine already exists and was missed.** `js/build/enterprise-policy.js`
   (landed in PR #307, before the 2026-07-19 audit, so this was a gap in that audit's coverage, not
   new drift) is a working, tested (`test/enterprise-policy.test.mjs`), "shipped" (not behind a flag)
   IT-admin control plane: an administrator drops a `dataglow-policy.json` file next to `index.html`
   to disable BYOK/external-LLM Story, WebRTC Rooms, CDN fetches, and federated learning, and to
   require session audit logging — all evaluated before any feature flag, default-open with no
   policy file present. This is a materially bigger real foundation for "a hospital IT department
   can already lock this down" than the prior audit credited it with.
2. **The module-level-singleton finding was incomplete, not just aging.** The 2026-07-19 audit
   found exactly one runtime-mutated singleton registry (`js/validation/semantic-layer.js`) and
   framed it as "the one piece of core logic that would need an actual code change." A fresh,
   repo-wide grep for `new Map()` at module scope found **four more that already existed on
   2026-07-19 and were missed by that pass's search**, plus confirmed several genuinely benign
   ones that don't carry the same risk. See Finding 2 (revised) below.

## Finding 1 (reconfirmed) — core logic is still server-portable

Re-ran the same `window.`/`document.`/`localStorage`/`indexedDB`/`navigator.` grep across `js/*`.
The conclusion holds: the large majority of modules remain browser-global-free, browser-API usage
is still concentrated in `js/app-shell/` and `js/runtimes-viz/` (exactly where UI rendering
belongs), and the same three narrow, already-understood exceptions from 2026-07-19
(`semantic-layer.js`'s comment-only reference, `portable-receipt.js`'s intentional standalone
export snippet, `pdf-profiler.js`'s CDN PDF.js load) are still the only real ones. **No new
architectural lock-in has appeared since July.** A future server tier could still wrap the
existing validation/cleaning/story/rigor modules with close to zero rewrite.

## Finding 2 (revised) — the real singleton-registry list, corrected and completed

Runtime-mutated module-level `Map`s that are NOT scoped to a user/session (the real multi-user
collision risk class), found by inspecting every `new Map()` at module scope and checking whether
it is later `.set()`/`.delete()`'d at runtime (a real risk) versus built once from static reference
data and only ever read (no risk):

| File | Registry | Risk | Notes |
|---|---|---|---|
| `js/validation/semantic-layer.js` | `registry` | **Real** | Already flagged 2026-07-19. Metrics registered by name; two concurrent users on a shared server would collide. |
| `js/provenance/provenance.js` | `chains` | **Real (missed 2026-07-19)** | Keyed by `tableName` only — two sessions loading a table with the same name would share/overwrite each other's provenance chain on a shared server. Existed since 2026-07-09, predates the last audit. |
| `js/nl-sql/metric-contracts.js` | `contractRegistry` | **Real (missed 2026-07-19)** | Keyed by contract id only. Landed 2026-07-18, one day before the last audit — genuinely should have been caught. |
| `js/rulepacks/rulepack-registry.js` | `registry` | **Real (missed 2026-07-19)** | Keyed by pack id only. Also landed 2026-07-18. |
| `js/learning/rule-suggestions.js` | `corrections` | **Real (missed 2026-07-19)** | Keyed by a column/value composite key. Existed since 2026-07-09. |
| `js/validation/ncci-ptp-validator.js`, `js/validation/drg-icd-validator.js` | `CONFLICT_MAP`, `DRG_MAP` | **Benign** | Built once from static CMS reference data (NCCI edit pairs, DRG-ICD families) at module load, never mutated per-session. Same category as a lookup table, not app state. |
| `js/build/build-flags.js` | `flagStore` | **Benign** | Deployment-wide config (which features are on), not per-user data — correct to be a shared singleton. |

**Revised conclusion:** the real multi-user retrofit list is five files, not one — `semantic-layer.js`
plus `provenance.js`, `metric-contracts.js`, `rulepack-registry.js`, and `rule-suggestions.js`. All
five share the exact same fix already named in the 2026-07-19 audit and already proven out in
`js/memory/institutional-memory.js`'s `createMemoryStore(options)` factory pattern: wrap the
module-level `Map` in a factory function, thread a `sessionId`/`userId` through `options`, keep the
existing module-level instance as the default export for today's single-user behavior (so nothing
breaks now), and let a future server tier instantiate one store per session. This is still additive,
not a rewrite, for all five — the fix is mechanical and roughly the same shape five times over, not
five different problems. Rough sizing: ~1,300 combined lines across the five files, and the actual
diff per file is small (wrap the top-level `const x = new Map()` in a factory, thread one parameter
through the existing exported functions) — a half-day to a day of focused work per file including
tests, once actually scheduled; call it 3-5 days total for all five, not a rewrite-scale item.

## Finding 3 (reconfirmed, now with current market grounding) — the licensing gap is unchanged and still the one time-sensitive item

`LICENSE` is still plain MIT, unrestricted, including the right to sell copies — verified unchanged
byte-for-byte since 2026-07-19. This still means anyone, including a hospital or a competing
company, could legally fork the current public repo today and resell it, owing nothing back.

Current (2026) market practice reinforces rather than changes the prior finding. A fresh look at
how comparable small teams have handled this exact tension shows two real, well-established paths,
each with a concrete precedent:

- **AGPL v3** — makes the code fully open source, but forces anyone who runs it as a network
  service to publish their modifications back. Good when the goal is "if someone monetizes this as
  SaaS, their improvements come back to the community" ([dev.to license guide](https://dev.to/juanisidoro/open-source-licenses-which-one-should-you-pick-mit-gpl-apache-agpl-and-more-2026-guide-p90)). MongoDB's own history is the
  cautionary tale here: it ran AGPL plus a commercial add-on first, found AGPL alone didn't stop
  cloud providers from competing, and moved to the stricter SSPL instead.
- **BSL (Business Source License)** — not technically "open source" (source-available instead), but
  the more direct fit for DataGlow's actual stated goal ("companies wanting to use it" as a future
  revenue path, not "force contributions back"). Code stays visible/auditable for individuals and
  portfolio purposes; commercial/production use is restricted for a fixed window (most real-world
  BSL projects use 3-4 years); after that window it **automatically converts to a fully permissive
  license** (typically Apache 2.0) — so nothing is locked away forever, only reserved for a defined
  runway. Used today by MariaDB, Sentry, CockroachDB, HashiCorp (Terraform/Vault pre-2023), and
  Elastic ([same source](https://dev.to/juanisidoro/open-source-licenses-which-one-should-you-pick-mit-gpl-apache-agpl-and-more-2026-guide-p90)).

**The concrete cautionary precedent for waiting:** HashiCorp switched Terraform from a permissive
license to BSL in August 2023, *after* Terraform had a large existing user base — the community's
reaction was to fork the last permissively-licensed version into OpenTofu (now a Linux Foundation
project) rather than accept the new terms. That is the literal real-world version of the 2026-07-19
audit's warning that "a license change after the code is already public and forked by others is
much harder to walk back than choosing the right license now." DataGlow's current audience is small
enough that this fork risk is close to zero today; it is not a hypothetical that grows smaller with
time, it is one that grows larger.

**This finding's cost/value framing:**
- **Cost of deciding now:** near zero engineering cost (a `LICENSE` file swap plus, if BSL, a defined
  conversion-date commitment written into it) but a real decision cost — the user has to actually
  choose a path, which is not a code task this skill can default into.
- **Cost of deciding later:** the same engineering cost, but potentially real reputational/community
  cost if the repo has already been forked or has real outside users by then (the OpenTofu precedent).
- **Value:** unlike Findings 1 and 2 (cheap to retrofit whenever a real customer appears), this is the
  one item where "later" is strictly more expensive than "now," because the population of people who
  could object to a license change only grows over time, never shrinks.

## Licensing decision: RESOLVED (2026-09-23) — staying MIT

After reviewing all three options in plain terms, the user decided to keep DataGlow's license as
plain MIT, unchanged. No code, LICENSE file, or repo change is needed for this decision -- MIT is
the status quo. This closes the one open item this scoping pass identified as time-sensitive; the
other two license paths (BSL, AGPL) remain documented above for reference if the calculus ever
changes (e.g. if a real hospital/enterprise customer appears and commercial protection becomes
worth trading against MIT's maximum-reach openness), but are not being pursued now.

## Ranked recommendation

1. ~~Decide the licensing path~~ -- **Resolved 2026-09-23: staying MIT.** See above.
2. **Retrofit the five singleton registries into the factory pattern** (`semantic-layer.js`,
   `provenance.js`, `metric-contracts.js`, `rulepack-registry.js`, `rule-suggestions.js`) — cheap
   (~3-5 days total), mechanical, removes the full real multi-user collision-risk list (corrected and
   completed this pass, not just the one file found in July), and can be scheduled independently of
   the licensing decision.
3. **When a real server tier is eventually scoped**, `serverOffload`'s existing flag/stub
   (`js/app-shell/duckdb-config.js`) remains the correct literal starting point — reconfirmed still
   present, still documented as opt-in-only.
4. **Enterprise policy engine (`js/build/enterprise-policy.js`) needs a proper capability-map entry
   fix**, not new engineering — it already has a correct `capability-map.manifest.json` entry, but
   `docs/capability-map.md`'s own line for it is a bare "(present)" stub rather than following the
   same descriptive-table convention as every other row. Low-effort documentation correction, not
   scoped further here since it's cosmetic, not a real gap.

## What this pass deliberately did not do

- No code was changed. No license was changed. No singleton was refactored.
- No SSO/auth/billing/admin-dashboard work was scoped — still explicitly deferred until a real
  hospital/team customer exists, per the user's own prior framing.
- Did not re-verify the enterprise-policy engine's actual runtime behavior end-to-end (e.g. dropping
  a real `dataglow-policy.json` and confirming each `disable`/`require` key takes effect in the live
  app) — `test/enterprise-policy.test.mjs` passing is taken as sufficient evidence for this scoping
  pass; a hands-on verification would be appropriate before ever representing this to a real
  enterprise prospect.
