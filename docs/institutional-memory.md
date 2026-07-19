# Institutional Memory Layer

`js/memory/institutional-memory.js`

## 1. What it is, and why it exists

DataGlow sessions are full of small decisions: an agent proposes a fix and an
analyst accepts or dismisses it, a validation issue gets resolved, a value
gets manually edited, a SQL query gets run against the dataset, a story gets
exported. Today, most of that history evaporates the moment the tab closes.
Six months later, when the analyst who cleaned a dataset has moved teams, the
person who inherits it has no way to answer the most basic question: **what
happened to this data, and why?**

The Institutional Memory Layer is DataGlow's answer — a persistent, queryable
decision log that survives analyst turnover. Every decision made in a
session (agent or human) is recorded as an immutable entry. A new analyst
opening an old dataset can:

- See a plain-language timeline of everything that was found and fixed
- Distinguish agent actions from human actions, and see when a human
  overrode or dismissed an agent suggestion
- Query the log by column, decision type, actor, or time range
- Verify the log hasn't been silently altered, via a provenance hash
- Feed the log into Proof Export as durable evidence of how a dataset
  reached its current state

The module is pure logic: no DOM, no OPFS, no localStorage, no network, no
crypto library. It takes a plain JS object (the "store") and plain JS
objects (records) in, and returns plain JS objects out. This mirrors the
purity discipline already used across `js/provenance/` and `js/trust/` —
identical behavior in the browser, the Tauri desktop shell, and headless
Node tests. **The caller owns persistence**: serialize the store to OPFS in
the browser, or to the file system under the Tauri desktop shell, and
reload it before the next session.

## 2. The record schema

### Store shape

```js
{
  records: [],          // array of Record (see below)
  version: 1,            // MEMORY_STORE_VERSION
  createdAt: '2026-07-19T15:00:00.000Z',  // ISO timestamp, store creation time
  sessionId: 'session-...',                // auto-generated or caller-supplied
}
```

### Record shape

Every record passed to `appendRecord` has this shape. Fields marked
"auto" are filled in by `appendRecord` itself — callers never set them.

| Field       | Required | Description |
|-------------|----------|--------------|
| `type`      | yes      | One of `RECORD_TYPES` (below) |
| `actor`     | yes      | `'agent'` or `'human'` |
| `datasetId` | no       | Identifies which dataset the decision applies to |
| `column`    | no       | Column name, if the decision is column-scoped |
| `row`       | no       | Row index, if the decision is row-scoped |
| `before`    | no       | Prior value/state (for edits, renames, type overrides) |
| `after`     | no       | New value/state |
| `reason`    | no       | Free-text explanation ("why") |
| `sql`       | no       | SQL text, for `sql_query` records |
| `metadata`  | no       | Free-form object for type-specific extra detail (e.g. `{ count, rowCount, fileName, title, description }`) |
| `id`        | auto     | `timestamp-base36 + random suffix`, unique per record |
| `timestamp` | auto     | ISO 8601 string, set at append time |
| `sessionId` | auto     | Inherited from the record, then the store, then freshly generated |

### `RECORD_TYPES`

```js
RECORD_TYPES = {
  AGENT_FIX_ACCEPTED:   'agent_fix_accepted',
  AGENT_FIX_DISMISSED:  'agent_fix_dismissed',
  MANUAL_EDIT:          'manual_edit',
  VALIDATION_RESOLVED:  'validation_resolved',
  VALIDATION_DISMISSED: 'validation_dismissed',
  SQL_QUERY:            'sql_query',
  STORY_EXPORTED:       'story_exported',
  FILE_LOADED:          'file_loaded',
  JOIN_CREATED:         'join_created',
  COLUMN_RENAMED:       'column_renamed',
  TYPE_OVERRIDDEN:      'type_overridden',
}
```

`appendRecord` validates `type` against this set and `actor` against
`{'agent', 'human'}`, throwing a `TypeError` on anything else — it is a
programmer error to call it with a malformed record, not a runtime condition
callers need to branch on.

## 3. How to integrate

**On every Canvas action that represents a decision**, call `appendRecord`
and store the returned (new) store back into your app state:

```js
import { appendRecord, RECORD_TYPES } from './js/memory/institutional-memory.js';

// e.g. analyst accepts an agent-proposed null-fill fix
state.memoryStore = appendRecord(state.memoryStore, {
  type: RECORD_TYPES.AGENT_FIX_ACCEPTED,
  actor: 'human', // the *acceptance* is a human decision, even though the fix itself was agent-authored
  datasetId: state.activeDatasetId,
  column: 'claim_amount',
  reason: 'Agent proposed replacing 847 nulls with column median',
  metadata: { count: 847 },
});
```

Because `appendRecord` never mutates its input, this is safe to use directly
as a React (or any reactive framework) state update — the old store remains
a valid snapshot for undo/redo, diffing, or time-travel debugging.

**Persist the store to OPFS** (browser) or the file system (Tauri) after each
append, or on a debounced interval — the module has no opinion on cadence,
only on shape. A simple pattern:

```js
async function persist(store) {
  const handle = await getOpfsFileHandle('memory-store.json');
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(store));
  await writable.close();
}
```

**Load on dataset open**, before any new decisions are recorded, so the
store's history is contiguous:

```js
async function loadMemoryStore() {
  try {
    const handle = await getOpfsFileHandle('memory-store.json');
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch {
    return createMemoryStore(); // first time this dataset has been opened
  }
}
```

**Tier 2 summary display** (Canvas sidebar, dataset header) should call
`summarizeMemory(store, datasetId)` to render decision counts and the
most-active columns without re-deriving that logic in UI code.

**Long-running sessions** should periodically call `pruneStore` to keep the
store from growing unbounded — see Section 5 below for defaults.

## 4. The provenance hash and its role in Proof Export

`computeProvenanceHash(store, datasetId)` returns a deterministic string like
`djb2:3a1f9c02` summarizing every record for a dataset. It:

- Canonicalizes each record (stable key order, `undefined` normalized to
  `null`) so the hash does not depend on how the record's fields happened to
  be inserted
- Sorts records by `id` before hashing, so the hash is **insertion-order
  independent** — the same set of decisions hashes the same way whether they
  were replayed from NDJSON, merged from two peers, or recorded live
- Uses djb2, a simple non-cryptographic string hash — **not** a security
  primitive. It is tamper-evidence, not tamper-proofing: if a single field of
  a single record changes, the hash changes, so Proof Export can include the
  hash as a checksum a reviewer can recompute independently. A caller that
  needs cryptographic guarantees can feed the same canonical serialization
  through `SubtleCrypto.digest` (the same upgrade path already used in
  `js/provenance/provenance.js`'s `sha256Hex`) without changing this module's
  contract.

In Proof Export, the hash is embedded alongside the human-readable timeline
(`generateTimeline`) and the raw NDJSON (`exportNDJSON`) so a downstream
reviewer — or a future version of DataGlow itself — can re-verify that the
exported story matches the memory log it claims to summarize.

## 5. DataGlow Rooms forward compatibility

DataGlow Rooms (Feature 11, future PR) let two analysts collaborate on the
same dataset from separate browser sessions. Each peer accumulates its own
memory store locally; `mergeStores(storeA, storeB)` is the reconciliation
primitive:

- Records are deduplicated by `id` — a record created by peer A and later
  synced to peer B is not double-counted
- The merged store's records are sorted by `timestamp`, so the reconciled
  history reads as one coherent timeline regardless of which peer authored
  which entry
- The merge is symmetric and non-destructive: nothing from either peer's
  history is dropped, only duplicated ids are collapsed

This makes `mergeStores` the single hook Rooms needs to wire in — no schema
changes required when that feature lands.

## 6. Pruning

`pruneStore(store, { maxRecords = 1000, keepTypes = ['file_loaded', 'story_exported'] })`
keeps a long-running session's store bounded:

- Records whose `type` is in `keepTypes` are always kept, regardless of age
  — these are the log's "anchors" (when was this file loaded, when was a
  story last exported), and pruning them away would make the timeline
  unreadable even if raw decision volume is high
- The remaining budget (`maxRecords` minus anchors already kept) is filled
  with the most recent records of any type
- The pruned store's records are returned sorted oldest-to-newest, matching
  the store's natural invariant

## 7. Example code snippets

**Append a record:**

```js
import { appendRecord, RECORD_TYPES } from './js/memory/institutional-memory.js';

store = appendRecord(store, {
  type: RECORD_TYPES.SQL_QUERY,
  actor: 'human',
  datasetId: 'claims-2026',
  sql: 'SELECT COUNT(*) FROM claims WHERE claim_amount < 0',
  metadata: { rowCount: 12 },
});
```

**Query the store:**

```js
import { queryRecords } from './js/memory/institutional-memory.js';

const agentFixesOnClaimAmount = queryRecords(store, {
  type: 'agent_fix_accepted',
  column: 'claim_amount',
  datasetId: 'claims-2026',
  limit: 10,
});
```

**Generate a timeline for Story View / Proof Export:**

```js
import { generateTimeline } from './js/memory/institutional-memory.js';

const lines = generateTimeline(store, 'claims-2026', { maxEntries: 20 });
// [
//   "SQL query run: SELECT COUNT(*) FROM claims WHERE claim_amount < 0 (returned 12 rows) (2026-07-19 10:20)",
//   "Agent fixed 847 values in claim_amount — accepted by analyst (2026-07-19 10:14)",
//   ...
// ]
```

**Summarize for the Canvas Tier 2 panel:**

```js
import { summarizeMemory } from './js/memory/institutional-memory.js';

const summary = summarizeMemory(store, 'claims-2026');
// { totalDecisions: 42, agentFixes: 12, humanEdits: 8, dismissals: 3,
//   validationsResolved: 9, lastActivity: '2026-07-19T15:22:01.000Z',
//   topColumns: [{ column: 'claim_amount', decisionCount: 7 }, ...] }
```

**Export / re-import for Proof Export:**

```js
import { exportNDJSON, importNDJSON, computeProvenanceHash } from './js/memory/institutional-memory.js';

const ndjson = exportNDJSON(store, 'claims-2026');
const hash = computeProvenanceHash(store, 'claims-2026'); // 'djb2:3a1f9c02'

// Later, or in a different session:
const restored = importNDJSON(ndjson);
```
