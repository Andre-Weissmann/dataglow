# Capability detail — Protocol & interoperability

Companion to the **Protocol & interoperability** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the external data contract or its runtime conformance check; the index alone is
enough for most tasks.

## What this area is

A single module, `js/protocol/protocol-conformance.js`, bridges DataGlow's
internal runtime objects to the versioned, external-facing **data contract**
defined under the repo-root `protocol/` directory. The `protocol/` tree is the
stable wire format an external client can rely on; this module is the app-side
adapter layer plus a non-fatal, dev-only drift check that keeps the runtime
honest against those schemas.

**Flag:** none — this module is not gated by `flags.manifest.json` (the only
`protocol` hits there are coincidental wording in unrelated flags: `zkThresholdProof`'s
"Sigma protocol" and `mcpInterface`'s "Model Context Protocol"). It is a pure
adapter + dev aid, so there is nothing to gate.

**Tests:** `test/protocol-schema.test.mjs` — imports `toValidationRun`,
`toStoryOutput`, `toDataset` and validates their output against the real schemas
under `protocol/schema/` via the dependency-free `protocol/validator.mjs`. It also
carries a source-level regression asserting the module fetches schemas from the
correct path.

**Wiring status:** **not currently invoked from `js/app-shell/main.js`** (no import
or call). The adapters and `devAssertConformance` are exercised by the protocol
test and are safe to call from production paths, but `main.js` does not yet route
runtime objects through them. The module is live and tested but effectively dark
until wired in.

## `js/protocol/protocol-conformance.js`

`PROTOCOL_VERSION = '1.0.0'`. Statically imports `validate` and `buildRegistry`
from `../../protocol/validator.mjs` (the standalone validator, not a third-party
library — same zero-dependency, no-build constraint as the rest of DataGlow).

### Adapters (pure, sync, deterministic)

Each `to*` function maps an internal object to a stable protocol wire shape.
`ProvenanceAttestation` and `GradeResult` already **are** the protocol shape and
pass through elsewhere unchanged; the two derived envelopes below exist so the wire
shape stays stable even if internal bookkeeping changes.

- **`toDataset(ds)`** → `{ table, rowCount, colCount, columns, loadedAt }`.
  Accepts `cols` or `columns`; normalizes each column to a string or
  `{ name, type }`; derives `colCount` when absent; coerces `loadedAt` to an ISO
  string. All fields default to `null` rather than throwing on a missing input.
- **`toValidationRun(results, dataset = null)`** → `{ protocolVersion,
  generatedAt, layers, dataset?, confidence?, grades? }`. Walks the internal
  validation `results` map, skipping the three `NON_LAYER_KEYS`
  (`confidence`, `domainPack`, `calibratedGrades`) and any entry without a string
  `status`, emitting one `{ status, summary, detail, ts }` per real layer. Attaches
  the `dataset` envelope when passed, promotes `results.confidence` to a compact
  `{ score, grade, verdict, status, signals }` block, and surfaces
  `results.calibratedGrades` as `grades`.
- **`toStoryOutput(storyResult, claims = [])`** → `{ protocolVersion, text,
  source, generatedAt, claims, error? }`. Defaults `source` to `'local'`, coerces
  `claims` to an array, and only includes `error` when the story result carried one.

### Dev-mode runtime conformance check

- **`devAssertConformance(kind, obj)`** — validates a runtime object against its
  schema and `console.warn`s on any drift. It is **non-fatal, fire-and-forget**:
  never throws, never rejects, never blocks, and returns immediately outside a dev
  context — so it can sit in a production code path or a Node test without changing
  behavior. This is what makes conformance a live guarantee rather than just
  documentation.
- **`isDevContext()`** gates it: false in Node (no `window`) and on production
  origins; true only when `window.DATAGLOW_DEV === true`, on `localhost`/
  `127.0.0.1`/`[::1]`/`*.local`, or when the URL query contains `protocolCheck`.
- **`SCHEMA_FILES`** maps six short kind labels (`dataset`, `grade-result`,
  `validation-run`, `provenance-attestation`, `story-output`, `personal-data-bom`)
  to their `.schema.json` filenames. `loadRegistry()` lazily `fetch`es all six
  (relative to `import.meta.url`), builds a `$id`-keyed registry via
  `buildRegistry`, and caches the promise (`_registryPromise`). A schema fetch
  failure (e.g. offline) is caught and the check is silently skipped.

## Related but not in scope

- `protocol/` (repo root) — the external contract itself: `validator.mjs` (the
  dependency-free draft-2020-12 subset validator), `schema/*.schema.json` (the six
  schemas), `VERSION`, `README.md`, and `examples/`.
- `js/validation/validation.js` — produces the internal `results` map that
  `toValidationRun` adapts.
- `js/narrative/story.js` — produces the story result and claims that
  `toStoryOutput` adapts.
- `js/provenance/provenance.js` / `js/grades/calibrated-grades.js` — the
  provenance-attestation and grade-result producers whose output already matches
  the protocol shape directly.
