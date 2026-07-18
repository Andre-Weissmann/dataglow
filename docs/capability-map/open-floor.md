# Capability detail — Open Floor

Companion to the **Open Floor** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
inside the Open Floor primitives (read-only rooms, the PHI prompt guard, or the
sandbox twin); the index alone is enough for most tasks.

## What the Open Floor is

A stakeholder-facing, server-less exploration surface built from three PURE
modules — no DOM, no network, no storage, no engine import. Each is fully
Node-testable with fakes/injected dependencies. As of today none of them has a
call site in `js/app-shell/main.js`: they ship as logic behind flags (see
[Gating flags](#gating-flags)).

## The read-only room kernel — `js/agents/open-floor-room.js`

A "room" is a thin, frozen wrapper around an ALREADY-LOADED dataset plus its
governed validation/metric state. It is read-only **by construction, not by
convention**: the returned object exposes only read methods and is
`Object.freeze`d, so no `.update()/.delete()/.insert()/.applyFix()/.mutate()`
exists to call and a caller cannot bolt one on.

- `createReadOnlyRoom({ dataset, read, validation = null, metrics = null })` —
  the factory. Requires a `dataset` descriptor (`{ name, table, rowCount, cols }`
  shape `state.js` already holds) and an injected `read(sql)` reader (browser:
  `duckdb-engine` `runQuery`; tests: a fake). The room **never** constructs its
  own engine. `dataset`, `validation`, and `metrics` are snapshotted (JSON
  round-trip) and deep-frozen so callers get COPIES, never live references.
- Returned surface: `isReadOnlyRoom`, `name`, `table`, `describe()` →
  `{ name, table, columns, rowCount }`, `getColumns()`, `getRowCount()`,
  `getValidationState()`, `getMetrics()`, and the single guarded exec path
  `query(sql)`.
- `classifyReadOnlySql(sql)` → `{ ok, reason? }` — pure, total, never throws.
  Fails closed: empty/blank/non-string, comment-only, multi-statement, or any
  mutating text is rejected. It strips SQL comments and string/identifier
  literals first (`stripSqlNoise`), rejects statement chaining (only a single
  trailing `;` tolerated), rejects any of `MUTATING_KEYWORDS` (insert, update,
  delete, drop, create, alter, attach, copy, set, begin, commit, …) by
  word-boundary match, then requires the leader to be in `READ_ONLY_LEADERS`
  (select, with, from, values, table, describe, show, explain, summarize,
  pragma_table_info). `query()` runs `classifyReadOnlySql` and throws
  `ReadOnlyViolation` on a bad verdict before ever calling the injected reader.
- `ReadOnlyViolation` — exported `Error` subclass (`name`, `readOnlyRoom = true`).

## The PHI prompt guard — `js/agents/phi-prompt-guard.js`

A pre-submit checkpoint that runs BEFORE any text reaches an LLM path (the WebLLM
narrative/story engines today, a future NL-to-SQL path tomorrow). It only ever
REMOVES sensitive content; it never adds, rewrites for meaning, or blocks a
legitimate prompt. Two classification layers, BOTH always run:

1. **Column-name classification** — reuses the shared domain-pack predicate
   `isSensitiveCategory` imported from `js/validation/categorical-consistency.js`
   (the same list the healthcare pack's protected-category merge guard uses;
   race/ethnicity/insurance/payer/gender/sex/religion/marital). It is a
   name-shape test, so it works with NO pack active.
2. **Always-on value-pattern scan** — `DEFAULT_SENSITIVE_PATTERNS` (frozen):
   `ssn` (3-2-4 digits), `mrn` (MRN/"medical record" label + digits), `email`,
   and `longdigits` (bare runs ≥ 9 digits, kept last/word-bounded so small counts
   like "1250 rows" are untouched). Fires with or without a pack.

Exports:
- `classifySensitiveColumns(columns)` → the subset that is sensitive.
- `redactSensitiveText(text, { patterns })` → `{ text, findings }` where each
  finding is `{ type:'pattern', pattern, count }`; redaction token is
  `[REDACTED:<LABEL>]`.
- `redactSampleRows(rows, columns, opts)` → `{ rows, droppedColumns, findings }`.
  Sensitive columns are DROPPED entirely (their presence alone can identify);
  remaining string values are pattern-redacted in place. Never mutates input.
- `guardPromptPayload({ text, rows, columns }, opts)` — the single entry point →
  `{ text, rows, droppedColumns, findings, sensitiveFound }`. Findings are tagged
  with `in: 'text' | 'rows'` and the guard sets `sensitiveFound` when any fire.

Note: there is no dedicated guard flag — the PHI guard ships as part of the
`openFloorKernel` capability (Batch A) alongside the room kernel.

## The sandbox twin — `js/simulation/sandbox-twin.js`

A forkable, disposable, in-memory deep COPY of an already-loaded dataset that an
agent (or curious stakeholder) can wreck freely, resting on two guarantees:
FORK ISOLATION (the twin is a fork-time deep copy; `reset()` restores the exact
baseline; the real dataset is never reachable by reference) and NOTHING APPLIES
WITHOUT THE FIREWALL (every mutation, and especially promotion back to real data,
routes through the Agent Action Firewall's per-action human-confirmed,
single-use-nonce handshake — no trusted/auto/force path).

- `createSandboxTwin({ realRows, columns, keyColumn = null, firewall = null })`
  — async factory (may dynamic-import the firewall). Requires a `realRows` array
  and a non-empty schema. Resolves the firewall via `resolveFirewall`: an
  injected valid module wins; `firewall === false` forces the disabled state; an
  injected-but-invalid object or a failed import → `null` and the twin comes up
  DISABLED and FAILS CLOSED (`console.warn`, applies nothing) rather than
  throwing. `enabled` reflects whether a usable firewall was found. Key column is
  auto-detected via `detectKeyColumn` when omitted.
- Returned (frozen) handle: `isSandboxTwin`, `enabled`, `keyColumn`,
  `getRows()`/`getColumns()`/`getRowCount()` (all return copies),
  `propose(action)` (pure classification + nonce, executes nothing; `null` when
  disabled), `applyToTwin({ proposal, confirmation, mutate })` (firewall-gated
  mutation of the twin's own rows; reversible via `reset()`),
  `perturbTwin({ knobs, seed, confirmation })` (propose+apply a reused
  `perturbRows` what-if in one gated step), `promoteToReal({ proposal,
  confirmation, applyToReal, recordAudit })` (the ONLY path that can touch real
  data — `applyToReal(rows)` runs only after confirmation passes; audit written
  via `recordAudit`), `diff()` (twin vs fork baseline, reusing `diffRows`),
  `reset()`, and `dispose()`.
- Reuse, not reinvention: perturbation reuses `perturbRows` from
  `js/simulation/digital-twin.js`; diffing reuses `diffRows`/`detectKeyColumn`
  from `js/simulation/time-travel-diff.js`. This module owns neither.

## UI wiring

None. `js/app-shell/main.js` imports and references none of these three modules —
confirmed by grep and by both flag descriptions ("no UI, no call site"). With the
flags off (their shipped default for the twin), runtime behaviour is unchanged.

## Gating flags

From `flags.manifest.json`:

- `openFloorKernel` — **`enabled: true`** (addedInPR `gen45-open-floor-kernel`).
  Covers BOTH `open-floor-room.js` and `phi-prompt-guard.js`. Pure logic only, so
  even enabled it changes no runtime behaviour (no call site).
- `openFloorSandboxTwin` — **`enabled: false`** (addedInPR
  `gen45-open-floor-sandbox-twin`). Ships DARK; depends on the `agentActionFirewall`
  capability and degrades to disabled/fail-closed if that module is absent.

No separate flag exists for the PHI guard, the room kernel alone, or redaction.

## Tests

Existence only (do not run here). Under `test/`:

- `open-floor-kernel.test.mjs` — the read-only room kernel + PHI guard (the
  `openFloorKernel` / open-floor-kernel CI job).
- `sandbox-twin.test.mjs` — the sandbox twin incl. the firewall-absent red-team
  fail-closed branch (the open-floor-sandbox-twin CI job); the flag description
  cites this file by name.

## Cross-references (out of scope here)

- `js/agents/agent-action-firewall.js` — the Agent Action Firewall the twin routes
  every mutation and promotion through (`proposeAction`, `confirmAndApply`);
  tested by `test/agent-action-firewall.test.mjs`.
- `js/simulation/digital-twin.js` (`perturbRows`) and
  `js/simulation/time-travel-diff.js` (`diffRows`, `detectKeyColumn`) — the reused
  perturbation and diff engines.
- `js/validation/categorical-consistency.js` (`isSensitiveCategory`) — the shared
  sensitive-category predicate the PHI guard imports for column classification.
