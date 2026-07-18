# Capability detail — Build tooling & feature flags

Companion to the **Build tooling & feature flags** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're adding a
new flag, promoting/reverting one, or wiring a flag-gated feature; the index alone
is enough for most tasks.

## How the flag system is shaped

The whole runtime flag system is two files: the reader
[`js/build/build-flags.js`](../../js/build/build-flags.js) and the data it reads,
[`flags.manifest.json`](../../flags.manifest.json). The reader is deliberately
trivial — its header comment describes it as "a tiny, framework-agnostic
feature-flag reader" with **zero platform coupling**: no `localStorage`, cookies,
`sessionStorage`, no `fetch`/network, no Node `fs`, no DOM. The same module runs
identically in the browser bundle, the Tauri desktop webview, and any future Tauri
mobile build. It never decides *how* the manifest is loaded — the caller loads the
bundled JSON however its platform already loads bundled JSON and hands the parsed
object in once at startup. Keeping I/O out is what keeps the module portable.

## `build-flags.js` API

The module holds a single module-level `Map`, `flagStore` (flag name → record),
empty until configured. Exports:

- `configureFlags(manifest)` — clears `flagStore` and repopulates it from a parsed
  manifest object. Accepts either the full manifest shape (`{ flags: { ... } }`) or
  a bare `{ name: record }` map via the internal `extractFlagMap()` helper. The
  leading `_about` documentation key and any non-object record are skipped. Returns
  the number of flags loaded. Call once at startup.
- `isEnabled(flagName)` — returns `record.enabled === true`, or `false` for an
  unknown flag or any flag consulted before `configureFlags()` ran. Missing flags
  **fail safe** (disabled) rather than throwing.
- `getFlag(flagName)` — the full record (`{ enabled, addedInPR, description, ... }`)
  or `null`. The doc comment notes it is "useful for the promote-or-delete hygiene
  check."
- `listFlags()` — array of all configured flag names.
- `resetFlags()` — clears the store; mainly for tests / re-initialization.

## `flags.manifest.json` schema

The file's `_about` key documents it as the Build Nervous System (Stage 4, "Land
dark") client-side feature-flag manifest. The top level is `{ "_about": ..., "flags":
{ ... } }`. Each entry under `flags` is `flagName → record`:

- `enabled` (bool, required) — the only field `isEnabled()` reads. `true` ships live,
  `false` ships dark.
- `addedInPR` (string, required) — the branch/PR where the flag was introduced;
  records where the flag's promote-or-delete clock started, so age is auditable from
  the manifest alone.
- `description` (string) — what the feature does, what it deliberately does *not* do,
  and its shipped default. These are long and load-bearing (each batch's contract).
- `promotedInPR` (string, optional) — the PR that flipped the flag on / promoted it.
- `promotedNote` / `note` (string, optional) — free-text hygiene or promotion notes
  (e.g. a trio "intended to be promoted together").
- `enabledInPR` / `restoredInPR` (string, optional) — variants seen on a few entries
  recording the enable or a restore-after-revert.

Measured across the current manifest: **78 flags total** — **73 `enabled: true`**
(shipping live) and **5 `enabled: false`** (shipping dark, e.g.
`conversationalPackBuilderVoice`, `meetingScribeLiveCapture`, `serverOffload`,
`mcpInterface`, `openFloorSandboxTwin`).

## Flag-gating discipline

The gating rule is that **the caller checks the flag; the flagged module never
self-checks**. `build-flags.js` header states the reader "is NOT wired into any
existing module's behavior" and ships "as a pattern for future PRs to copy." In
practice the app shell owns every gate:
[`js/app-shell/main.js`](../../js/app-shell/main.js) imports
`{ configureFlags, isEnabled }` and calls `configureFlags(manifest)` once, then
guards each feature at its call site — e.g. `getVisibleTabIds()` builds the visible
tab list from clauses like `(tabId !== 'diplomacy' || isEnabled('dataDiplomacy'))`,
and run-path features check inline (`isEnabled('multiDialectSql')`,
`isEnabled('rigorEngineBadges')`, etc.). A flagged module thus stays pure and
Node-testable; turning a flag off restores byte-for-byte prior behavior because
nothing downstream is ever constructed.

## Promote-or-delete convention

Documented in [`../build-nervous-system.md`](../build-nervous-system.md) under "The
promote-or-delete rule (flag hygiene)". A flag is temporary scaffolding, not a
permanent config knob; each flag is on a clock with two exits:

- **Promote** — behavior is trusted: remove the flag from the manifest, keep the
  code path permanently.
- **Revert** — behavior is abandoned: remove the flag from the manifest and delete
  the code path.

**Rule:** any flag left in `flags.manifest.json` for **more than 3 merged PRs**
without being promoted or reverted must be called out in the PR description of the
**4th** PR that touches the manifest, with an explicit promote-or-delete decision.
The `addedInPR` field is what makes the flag's age auditable. `NORTH_STAR.md`
reinforces this per-feature with "PROMOTED to ON" batch notes citing the promoting
PR.

## Tests

There is **no dedicated `build-flags` unit test**. The real reader against the real
manifest is exercised through the gating tests it powers — most directly
[`test/diplomacy-tab-gating.test.mjs`](../../test/diplomacy-tab-gating.test.mjs),
which imports `{ configureFlags, isEnabled, resetFlags }`, loads the real
`flags.manifest.json`, and asserts both the flag-ON and flag-OFF tab-visibility
paths. [`test/command-deck-nav.test.mjs`](../../test/command-deck-nav.test.mjs)
guards the sidebar's flag-awareness (a dark-flagged tab must not leak into the
sidebar). Tests live under `test/*.test.mjs`.
