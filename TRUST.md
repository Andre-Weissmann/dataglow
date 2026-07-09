# Trust & Transparency

This page is DATAGLOW's own, first-party answer to a simple question a recruiter,
contributor, or portfolio reviewer might ask: *can I trust what this repository
says about itself?* It is written and maintained by the project, not scored by a
third-party "repo trust" service — the whole point is that everything here is
something you can verify yourself by clicking through to the actual code and CI.

If you find a claim on this page that no longer matches reality, that is a bug —
please open an issue.

## Repo Health

Everything below is verifiable from the repository itself. No figure on this page
is asserted without a place you can go to check it.

**Continuous integration.** CI is split into one reusable workflow per job, each
living in a top-level `.github/workflows/job-<name>.yml` file and wired together
by the thin orchestrator in [`.github/workflows/test.yml`](.github/workflows/test.yml).
That split means each concern is its own independently readable check rather than
one opaque monolith. The jobs that run on every push and pull request today are:

- `sql-logic` — the DuckDB-WASM SQL logic suite
- `golden-regression` — snapshot tests pinning core deterministic output
- `capability-map-drift` — fails if the docs and the shipped `js/` code disagree
- `agents-md-drift` — fails if `AGENTS.md` references a path or script that no longer exists
- `dependency-freshness` — gates on badly outdated or vulnerable dependencies
- `supply-chain-hardening` — install-script lockdown plus SBOM generation (see below)
- `pack-architecture` — domain-pack plugin isolation, manifest validation, and the enforced no-network guard
- `living-manifest` — keeps the public-facing docs regenerated from a single source of truth
- `problem-framer`, `export-reporting`, `databricks-connect` — feature-specific logic suites
- `e2e-smoke`, `tauri-smoke` — end-to-end and desktop-shell smoke builds

The live, authoritative status of every one of these is the repository's
[Actions tab](https://github.com/Andre-Weissmann/dataglow/actions) — that is the
source of truth, not this document. A green run there means the checks above
passed for that commit.

**Software Bill of Materials (SBOM).** The `supply-chain-hardening` job generates
a CycloneDX SBOM (`docs/sbom.json`) on *every* CI run and uploads it as a build
artifact — see [`.github/workflows/job-supply-chain-hardening.yml`](.github/workflows/job-supply-chain-hardening.yml).
The same job enforces `ignore-scripts=true` (set in the repo's `.npmrc`) and fails
the build if any dependency introduces an unreviewed install/postinstall lifecycle
script, so install-time code execution is a deliberate, versioned decision rather
than something that can creep in silently.

**Build provenance.** Beyond the per-run SBOM, DATAGLOW keeps a tamper-evident
record of its own CI history: every CI run that lands on `main` appends one
hash-linked entry — commit, timestamp, test conclusion, and the SHA-256 of that
run's SBOM — to an append-only [`docs/ci-provenance-ledger.jsonl`](docs/ci-provenance-ledger.jsonl),
each entry chaining to the previous one's hash. You don't have to take that on
faith either: clone the repo and run `npm run verify:ci-provenance` to recompute
and re-link the entire chain fully offline (no network, no GitHub API), which
reports "chain intact" or names the exact entry that broke. The README's
[Supply-chain section](README.md#supply-chain) has the fuller write-up.

**"Last verified" convention.** There is no live-updating trust badge or scoreboard
on *this page* on purpose — a number that updates itself is exactly the kind of
claim you'd have to take on faith. Treat the commit date of this file as its
"last verified" timestamp: this page was reviewed against the CI configuration as
it stood when it was last committed. To see how current that is, check this file's
history or the latest commit on the default branch. For a machine-checkable,
per-run record, use the CI provenance ledger and verifier described above.

## Domain Packs: Isolated, Auditable, Offline

DATAGLOW's industry "domain packs" (Healthcare, Retail, Finance, plus the OMOP
and FHIR healthcare profiles) reinterpret the 20 validation layers' raw output in
context — they never re-run a layer, and they can only annotate or downgrade a
finding, never hard-fail your data. As of the Gen 40 plugin architecture, each
pack is a **self-contained plugin module** under [`js/packs/`](js/packs/): a pack
is one file that *declares* which stable extension points it fills, rather than a
diff pasted into a single shared engine file. Adding, updating, or removing a pack
is a new file plus one registration line — two packs can never collide on the same
file again.

Three properties make this trustworthy rather than merely tidy:

- **Enforced no-network guarantee.** Packs preserve DATAGLOW's zero-upload
  promise: pack code may only transform data already loaded locally, and must
  never reach the network. This is no longer a convention. A static source scan
  ([`js/packs/pack-network-guard.js`](js/packs/pack-network-guard.js)) rejects any
  pack whose code so much as references `fetch`, `XMLHttpRequest`, `WebSocket`, or
  similar, and a runtime trap shadows those globals while pack code runs as
  defence in depth. The `pack-architecture` CI job scans every shipped pack file
  on every run, and includes a test-only rogue pack that tries to `fetch()` — the
  test passes only because the guard catches it.

- **Manifest validation & isolation.** Every pack ships a manifest (id, semver
  version, industry, the extension points it fills, and license/provenance for any
  synthetic sample data). The loader
  ([`js/packs/pack-registry.js`](js/packs/pack-registry.js)) rejects a malformed
  manifest, an unknown extension point, or any *inter-pack dependency* — so
  removing or updating one pack can never break another.

- **In-app provenance.** When packs load through the registry, the app's domain-pack
  panel exposes a "Loaded domain packs" disclosure listing each active pack's id,
  version, filled extension points, and the license/provenance of any sample data
  it ships — the same information surfaced here, verifiable in the running app.

The migration landed behind the existing feature-flag system (`flags.manifest.json`,
read by [`js/build/build-flags.js`](js/build/build-flags.js)): the `pluginPacks`
flag selects the plugin path and can be flipped off to fall back to the legacy
inline map. Because the plugin path reuses the *same* runtime pack objects, the
two paths are behaviour-identical — the flag is a rollback lever, not a behaviour
switch.

## How This Repo Talks to Agents

A growing share of the changes in this repository are drafted by AI coding
agents, and a recurring lesson of building software that way in 2026 is that the
bottleneck isn't the model's raw ability — it's *context*. An agent that starts
each task with no memory will happily re-derive the shape of a codebase from
scratch, guess at conventions, and reintroduce mistakes a human would only make
once. The general practice that has emerged in response is to treat the repository
itself as the agent's onboarding material: write down, inside the repo, the things
you'd otherwise have to explain out loud to every new contributor, and structure
the code and docs so an automated reader can find the two or three files that
actually matter instead of scanning everything.

DATAGLOW leans into that idea with three pieces that work together. None of them
is magic; each is just a plain file that any human can read too.

- **`AGENTS.md`** is the front door. It is deliberately short and states the things
  an agent must not get wrong — the one hard constraint (nothing you load ever
  leaves your machine), where to look before editing, and the expectation that a
  change isn't finished until its paper trail matches the code. It is written to be
  read once at the start of a task and then acted on, not skimmed.

- **The capability map** (`docs/capability-map.md`, backed by a machine-readable
  `capability-map.manifest.json`) is the index that keeps orientation cheap. It
  maps every module in `js/` to a feature area, so an agent can jump straight to
  the handful of files a task touches instead of reading dozens. Crucially, the
  map is not decorative documentation that quietly rots: a CI check compares it
  against the actual code on every run and fails the build if they disagree, so
  the map is trustworthy precisely because it is enforced.

- **The append-only changelog** (`docs/CHANGELOG.md`) is the running memory. Every
  change adds a one-line entry describing what shipped and why. Because it is
  append-only — new entries slot in at a fixed marker rather than editing existing
  prose — two changes authored in parallel don't collide, and the log stays a
  faithful, chronological record of the project's reasoning over time.

Read together, these give a fresh agent (or a fresh human) the same starting
point a long-time maintainer would have: the rules that can't be broken, a fast
route to the relevant code, and the history of decisions that got the project
here. The honesty of the whole system rests on the enforced checks — a claim that
CI actively verifies is worth more than one that merely sounds good.

For the avoidance of doubt: these files are the project's *internal* context
system for people and agents working on the code. They are separate from any
product-facing feature inside the DATAGLOW app itself.

## Start Here

If you'd like to contribute, these issues are hand-picked as good entry points.
Each one is well-scoped, ranges from small to medium in effort, and carries enough
context in its own description (plus `AGENTS.md` and the capability map) that you
can pick it up without anyone needing to re-explain the project to you first. They
are tagged with the `good-first-task` label.

- [#57 — Wiki page needed: Drift, trend & fingerprinting](https://github.com/Andre-Weissmann/dataglow/issues/57)
  — the gentlest of the documentation tasks: this area is backed by just two
  modules, so it's a small, self-contained way to learn how a capability area maps
  to code and to close the loop by updating `docs/wiki-coverage.json`.
- [#46 — Wiki page needed: App shell & data engine](https://github.com/Andre-Weissmann/dataglow/issues/46)
  — writing this page is a great orientation task, because the "App shell & data
  engine" area is the spine of the whole application (routing, state, the query
  engine, file loading); documenting it teaches you how DATAGLOW fits together.
- [#50 — Migrate remaining `js/app-shell/main.js` feature modules onto the capability registry](https://github.com/Andre-Weissmann/dataglow/issues/50)
  — a code task rather than a docs task, and explicitly incremental: unmigrated
  modules keep working, so you can migrate a single module as a first contribution.
  The issue lists exactly which modules remain and points at the pattern to follow.

The current, live list of everything so tagged is always available here:
[all `good-first-task` issues](https://github.com/Andre-Weissmann/dataglow/issues?q=is%3Aissue+is%3Aopen+label%3Agood-first-task).
