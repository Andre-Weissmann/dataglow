# Capability detail — Teaching & context

Companion to the **Teaching & context** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on micro-lessons or community pack sharing; the index alone is enough for most
tasks.

## What this area is

Two independent pure-logic modules that make DataGlow's findings more teachable and
its domain packs shareable. Both are DOM/global-free (identical behavior in
headless Node), and `main.js` owns all wiring. Neither is gated by a
`flags.manifest.json` feature flag — both are loaded through the app's module
registry (`registry.get('micro-lessons')` / `registry.get('community-pack')` at
`main.js` ~lines 9416–9417) and controlled by in-app UI (a toggle; an
import/export panel).

## `js/teaching/micro-lessons.js` — Teach-As-You-Clean

A catalog of one-line "why this matters" explanations for every kind of validation
finding, in three verbosity registers. Exports:

- **`VERBOSITY_LEVELS = ['beginner', 'practitioner', 'expert']`** and
  **`DEFAULT_VERBOSITY = 'practitioner'`** (the neutral middle register / fallback).
- **`MICRO_LESSONS`** — the catalog, keyed by finding-type id, each with a
  `{ beginner, practitioner, expert }` triple. Keys come from three enumerable
  sources so the coverage test can assert completeness: every `validation.js`
  `LAYER_DEFS` layer id, every `domain-physics.js` `DOMAIN_PACKS` rule id, and the
  finer sub-findings the Unit Test layer (`negative`, `future_date`, `blank_key`,
  `duplicate`, `null_ref`) and Benford layer (`bounded_name`, `small_sample`,
  `narrow_range`, `binary_flag`) render individually. All copy is original wording.
- **`normalizeLevel(level)`** — coerces any input to a known level (default
  fallback) so a stray UI value can't blank a lesson.
- **`hasMicroLesson(findingType)`**, **`getMicroLesson(findingType, level)`**
  (returns `null` for unknown types; falls back to the default register if an
  entry lacks the requested one), **`listFindingTypes()`**, and
  **`coverageFor(requiredTypes)`** → `{ covered, missing }` (lets the test assert
  full coverage against the live layer/pack ids without hard-coding the list).

**Control model:** two in-memory-only controls (no localStorage/sessionStorage —
those are blocked in the sandboxed iframe and would break the zero-persistence
contract). `main.js` reads a "Learn while you clean" checkbox
(`microLessonsEnabled()` → `#micro-lesson-toggle`) and a Beginner/Practitioner/
Expert level (`#micro-lesson-level`), and renders a per-finding note via
`microLessonNote(findingType)` (~line 5113) during layer render (~line 7442). The
verbosity slider changes only wording — never which findings appear, their
severity, or any validation logic.

**Tests:** `test/micro-lessons.test.mjs`.

## `js/teaching/community-pack.js` — Community Pack Sharing (Stage D)

File-based sharing of domain packs — export a pack to portable JSON and import one
back into a runtime pack the Domain Physics engine can apply. **No server,
marketplace, or backend**; a pack is just a downloaded JSON file. Imports
`PACK_RULE_LAYERS`, `compilePackRule`, `packFromDescriptor`, `DOMAIN_PACKS` from
`../validation/domain-physics.js`. Exports:

- **`PACK_KIND = 'dataglow-domain-pack'`**, **`PACK_SCHEMA_VERSION = 1`**,
  **`ALLOWED_RULE_KINDS`** (= `Object.keys(PACK_RULE_LAYERS)`, kept in lockstep
  with the compiler).
- **`validateImportedPack(obj)`** → `{ valid, errors, descriptor }`. This strict,
  closed schema **is the safety rail**: it rejects unknown keys, bad shapes,
  disallowed regex flags (only `ims`), reserved pack names (`none`, `healthcare`),
  and oversized inputs (`LIMITS`: maxRules 32, maxPatternLength 512,
  maxStringLength 2000, maxNameLength 64), and compiles each `match.pattern`
  once to reject an uncompilable regex up front. Rule kinds are `no-merge`,
  `benford-exempt`, `outlier-context` — each rule's target layer is **derived**
  from its `kind` via `PACK_RULE_LAYERS`, never read from input, so an imported
  pack physically cannot hard-fail data, auto-merge protected categories, or
  target a core layer.
- **`importPack(obj)`** → `{ ok, errors, pack }` — validates then compiles via
  `packFromDescriptor`; a compile-time throw is caught and surfaced as an error so
  import can never crash the app.
- **`exportPack(pack)`** / **`serializePack(pack)`** — build/serialize the portable
  envelope. Only descriptor-backed packs (Retail, Finance, or any imported pack)
  are portable; the hand-written `healthcare` and empty `none` packs have no
  descriptor and return a clear refusal. `cloneRule` copies only schema-allowed
  keys so an export can't leak internal fields.
- **`exportablePackNames()`** — the built-in packs that carry a descriptor.

**Wiring:** `main.js` `initCommunityPack()` (~line 5188, called at ~9325) wires the
export button (`serializePack` → download) and import (`importPack` →
`registerRuntimePack`), with the imported pack going through the same annotate-only
rule path as built-ins.

**Tests:** `test/community-pack.test.mjs`.

## Related but not in scope

- `js/validation/domain-physics.js` — supplies `PACK_RULE_LAYERS`,
  `compilePackRule`, `packFromDescriptor`, and the built-in `DOMAIN_PACKS` that
  community-pack validates against and extends.
- `js/validation/validation.js` `LAYER_DEFS` — the layer-id source micro-lessons
  covers (see [`validation-layers.md`](validation-layers.md)).
