# Proof Export

`js/proof/proof-builder.js`

## 1. What it is, and who it's for

The Proof Export module implements **Feature 12** of the DataGlow Canvas
spec (Section 6.4): the `.proof` button. When an analyst finishes cleaning
and validating a dataset, they can export a single `.proof` file — a
self-contained, JSON-formatted bundle that packages:

- the raw source file's hash,
- the validation run's hash (and the full findings list itself),
- the complete institutional memory audit trail for the dataset
  (see [`docs/institutional-memory.md`](./institutional-memory.md)), and
- the rendered Story content (if a story was generated for this dataset).

The `.proof` file is built **for the third party who receives it** — a
client, an auditor, a regulator, a co-author, a downstream analyst — anyone
who needs to independently confirm that the findings reported to them
actually match the underlying data and the validation/decision history,
**without needing DataGlow itself, the original data file, or a live
session**. Everything the recipient needs to check is embedded in the file.
They open it in a text editor, or paste it into a small verification
script (Section 5), and get a pass/fail report.

This is deliberately the opposite of a black-box "trust me" export: the
whole point is that the recipient does **not** have to trust DataGlow or
the analyst — they can re-derive every hash themselves from data that ships
inside the same file.

## 2. The `.proof` file format

A `.proof` file is plain JSON with a `.proof` extension. It is **not** a
binary or proprietary format — it's designed to be opened in any text
editor, diffed, version-controlled, or emailed as an attachment.

```jsonc
{
  "_comment": "DataGlow Proof Package — verify with verifyProof()",
  "version": 1,
  "format": "dataglow-proof",
  "generatedAt": "2026-07-19T15:00:00.000Z",
  "toolVersion": "DataGlow Canvas v1",

  "dataset": {
    "name": "claims_Q2_2026.csv",
    "rowCount": 14203,
    "columnCount": 18,
    "sourceFileHash": "djb2:abc12345"
  },

  "validation": {
    "totalFindings": 4,
    "errorCount": 2,
    "warningCount": 1,
    "criticalCount": 0,
    "passRate": 0.5,
    "findings": [ /* full Finding[] list, unmodified */ ],
    "validationHash": "djb2:9f3a1c02"
  },

  "memory": {
    "totalRecords": 12,
    "summary": { /* summarizeMemory() output */ },
    "timeline": [ "Agent fixed 3 values in claim_amount — accepted by analyst (2026-07-11 09:00)", "..." ],
    "provenanceHash": "djb2:7be21a90",
    "ndjson": "{\"id\":\"...\",\"type\":\"file_loaded\",...}\n{\"id\":\"...\",\"type\":\"validation_resolved\",...}\n..."
  },

  "story": {
    "included": true,
    "storyHash": "djb2:44d8ef01",
    "markdownPreview": "# Analysis of claims_Q2_2026.csv\n\n*14,203 rows..."
  },

  "integrity": {
    "packageHash": "djb2:c001d00d",
    "algorithm": "djb2",
    "note": "For production use, upgrade to SHA-256 via SubtleCrypto"
  }
}
```

If no story was generated for the dataset, `story.included` is `false` and
both `story.storyHash` and `story.markdownPreview` are `null` — the section
is still present (so the schema is stable), it's just empty.

### Field reference

| Section       | Field             | Meaning |
|----------------|-------------------|---------|
| (root)         | `version`         | Proof schema version, currently `1` |
| (root)         | `format`          | Always `'dataglow-proof'` — lets a generic file-type sniffer identify it |
| (root)         | `generatedAt`     | ISO timestamp of when the proof was assembled |
| (root)         | `toolVersion`     | e.g. `'DataGlow Canvas v1'` |
| `dataset`      | `name`            | Original file name |
| `dataset`      | `rowCount` / `columnCount` | Dimensions of the validated dataset |
| `dataset`      | `sourceFileHash`  | djb2 hash of file name + size, computed by the caller before calling `buildProof` |
| `validation`   | `totalFindings` / `errorCount` / `warningCount` / `criticalCount` | Aggregate counts over the findings list |
| `validation`   | `passRate`        | `(totalFindings - errors - criticals) / totalFindings`, `1` if there are no findings |
| `validation`   | `findings`        | The full, unmodified findings array from the validation rail |
| `validation`   | `validationHash`  | See Section 3 |
| `memory`       | `totalRecords`    | Count of institutional memory records for this dataset |
| `memory`       | `summary`         | Output of `summarizeMemory()` |
| `memory`       | `timeline`        | Output of `generateTimeline()` — plain-language decision history |
| `memory`       | `provenanceHash`  | See Section 3 |
| `memory`       | `ndjson`          | Output of `exportNDJSON()` — the full raw audit trail, one JSON record per line |
| `story`        | `included`        | Whether a story was generated for this export |
| `story`        | `storyHash`       | See Section 3 (`null` if `included` is `false`) |
| `story`        | `markdownPreview` | First 500 characters of the rendered story markdown (`null` if no story) |
| `integrity`    | `packageHash`     | See Section 3 |
| `integrity`    | `algorithm`       | Always `'djb2'` today |
| `integrity`    | `note`            | Points at the SHA-256 upgrade path (Section 6) |

## 3. The four hashes

Every hash in a `.proof` file is a **djb2** hash — a fast, deterministic,
dependency-free string hash (see Section 6 for why this isn't
cryptographically secure and how to upgrade it). Each hash verifies a
different part of the package:

1. **`validation.validationHash`** — djb2 over the JSON of the validation
   findings list, **sorted deterministically** (by severity, then column,
   then message) before hashing so the same set of findings always
   produces the same hash regardless of the order the validation rail
   happened to report them in. Verifies: *the findings shown to the
   recipient are exactly the findings the validation run produced — no
   finding was added, removed, or edited after the fact.*

2. **`memory.provenanceHash`** — djb2 over the embedded `memory.ndjson`
   audit trail (falling back to a hash of the record count if `ndjson` is
   empty). Verifies: *the institutional memory trail shipped in this file
   is exactly the trail that was recorded during the session — no decision
   was quietly added or removed from the history.* Because the full
   `ndjson` ships inside the file, a third party can recompute this hash
   with **zero** dependency on `institutional-memory.js` or a live
   session — the raw audit trail and its hash are self-contained.

3. **`story.storyHash`** — djb2 over the story's rendered section content
   (computed by `story-builder.js`'s `computeStoryHash()`), or `null` if no
   story was generated. Verifies: *the narrative content (the human-readable
   "here's what we found" story) matches the sections it was generated
   from — the prose wasn't hand-edited after the fact to say something the
   data doesn't support.*

4. **`integrity.packageHash`** — djb2 over the **entire assembled package
   minus the `integrity` section itself**, computed **last**, after every
   other field is final. This is the outermost seal: if any byte of any
   other field in the file changes — a row count, a finding, a timeline
   entry, the story preview — `packageHash` will no longer match when
   recomputed. Verifies: *nothing in the whole package was modified after
   `buildProof` sealed it.*

The four hashes are intentionally layered: `validationHash` and
`provenanceHash` and `storyHash` each protect one section independently, and
`packageHash` protects the package as a whole (including those three hash
values themselves — tampering with a hash *and* its underlying content
together still fails `packageHash`).

## 4. The gate check — why Critical findings block export

Per the spec: *"If any Critical validation finding is unresolved, this
button is disabled."*

`canExportProof(validationFindings)` implements this rule directly:

```js
function canExportProof(validationFindings)
// Returns { allowed: boolean, blockedBy: Finding | null }
```

It scans the findings list for any finding with `severity === 'critical'`
whose `status` is **not** `'resolved'`. If one exists, `allowed` is `false`
and `blockedBy` points at the offending finding (so the Canvas UI can show
the analyst exactly what's blocking export). A Critical finding with
`status: 'resolved'` does **not** block export — resolving it (via the
validation rail, recorded as a `validation_resolved` institutional memory
record) clears the gate.

The rationale: a Proof Export exists to let a third party trust the
findings. Shipping a proof that omits or glosses over an unresolved
Critical issue would defeat that purpose — so DataGlow refuses to build the
`.proof` at all until the analyst has either fixed the issue or explicitly
marked it resolved (with the resolution itself recorded in institutional
memory, and therefore visible in `memory.timeline` inside the exported
proof).

The Canvas wires this into the `.proof` button's `disabled` attribute:

```js
const { allowed, blockedBy } = canExportProof(session.validationFindings);
proofButton.disabled = !allowed;
if (!allowed) {
  proofButton.title = `Resolve the Critical finding on ${blockedBy.column} before exporting a proof.`;
}
```

## 5. How to verify a `.proof` file

A recipient with **no DataGlow installation** can verify a `.proof` file
two ways:

### In a browser console

1. Open the `.proof` file, copy its JSON contents.
2. Open `js/proof/proof-builder.js` in a browser tab (or paste its contents
   into the console — it's plain ES module code with no external
   dependencies).
3. Run:

```js
const proofPackage = /* paste the JSON here */;
const result = verifyProof(proofPackage);
console.log(generateVerificationReport(result, proofPackage));
```

### In Node

```bash
node -e "
import('./js/proof/proof-builder.js').then(({ verifyProof, generateVerificationReport }) => {
  const fs = require('fs');
  const proofPackage = JSON.parse(fs.readFileSync('dataset.proof', 'utf8'));
  const result = verifyProof(proofPackage);
  console.log(generateVerificationReport(result, proofPackage));
});
"
```

Either way, the output looks like:

```
DataGlow Proof Verification Report
===================================
Dataset: claims_Q2_2026.csv  |  Rows: 14203  |  Generated: 2026-07-19T15:00:00.000Z

Validation Hash:   PASS  (expected: djb2:9f3a1c02 actual: djb2:9f3a1c02)
Provenance Hash:   PASS  (expected: djb2:7be21a90 actual: djb2:7be21a90)
Story Hash:        PASS  (expected: djb2:44d8ef01 actual: djb2:44d8ef01)
Package Hash:      PASS  (expected: djb2:c001d00d actual: djb2:c001d00d)

Overall: VERIFIED

If any check fails, the proof package may have been modified after generation.
```

If any single value in the file was edited by hand — a row count bumped
up, a finding deleted, a story sentence rewritten — the corresponding check
(and, because of the packageHash's outer seal, the overall result) flips to
`FAIL` / `TAMPERED`.

## 6. The djb2 → SubtleCrypto upgrade path

djb2 is used throughout DataGlow's provenance/trust layer
(`js/memory/institutional-memory.js`, `js/story/story-builder.js`, and now
`js/proof/proof-builder.js`) as a **tamper-evidence** signal, not a
cryptographic security boundary. It is:

- fast and synchronous (no `await`, works identically in Node and the
  browser with zero dependencies),
- deterministic (same input → same output, always),
- good at catching *accidental or careless* edits, and detecting whether
  content matches what was originally hashed.

It is **not** cryptographically collision-resistant, and a sufficiently
motivated attacker with knowledge of the algorithm could in principle craft
a different payload with the same djb2 hash. For most Proof Export use
cases (catching accidental edits, confirming a file wasn't casually
altered before being forwarded) this tradeoff is acceptable, and it's what
lets Proof Export work with zero build step and zero new dependencies —
consistent with the project's "everything is a plain ES module, nothing
fetched from a third party" design principle.

For production deployments that need real cryptographic integrity
guarantees, every djb2 call site in this module (`djb2()` itself) can be
swapped for `crypto.subtle.digest('SHA-256', ...)`:

```js
async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
```

The catch: `SubtleCrypto.digest` is asynchronous, so `buildProof`,
`verifyProof`, and every hash-producing helper would need to become
`async` functions returning Promises. Because this module is deliberately
synchronous today (matching the sync contract of
`js/memory/institutional-memory.js`'s `computeProvenanceHash` and
`js/story/story-builder.js`'s `computeStoryHash`), upgrading to SHA-256 is
an isolated, backward-compatible change: bump `integrity.algorithm` to
`'sha256'`, swap the hash function, and make the four public functions
`async`. The `.proof` file's schema (Section 2) does not need to change —
only the hash values' format (`sha256:...` instead of `djb2:...`).

## 7. Integration guide — wiring the Canvas `.proof` button

The Canvas has direct access to the real `summarizeMemory`,
`generateTimeline`, `computeProvenanceHash`, `exportNDJSON` (from
`js/memory/institutional-memory.js`) and `computeStoryHash`,
`renderMarkdown` (from `js/story/story-builder.js`) as live ES module
imports — this module never imports those files itself (see the
dependency-injection note in the file header of `js/proof/proof-builder.js`
and in `docs/institutional-memory.md`), so the Canvas passes them in
explicitly:

```js
import { buildProof, canExportProof, serializeProof } from './js/proof/proof-builder.js';
import { summarizeMemory, generateTimeline, computeProvenanceHash, exportNDJSON } from './js/memory/institutional-memory.js';
import { computeStoryHash, renderMarkdown } from './js/story/story-builder.js';

function onProofButtonClick(canvasState) {
  const { allowed, blockedBy } = canExportProof(canvasState.validationFindings);
  if (!allowed) {
    // Button should already be disabled per Section 4, but guard defensively.
    showToast(`Resolve the Critical finding on ${blockedBy.column} first.`);
    return;
  }

  const session = {
    datasetName: canvasState.dataset.name,
    rowCount: canvasState.dataset.rowCount,
    columnCount: canvasState.dataset.columnCount,
    sourceFileHash: computeSourceFileHash(canvasState.file), // djb2(name + size), caller-owned
    validationFindings: canvasState.validationFindings,
    memoryStore: canvasState.memoryStore,
    storyDoc: canvasState.storyDoc || null, // null if no story generated yet
    generatedAt: new Date().toISOString(),
    toolVersion: 'DataGlow Canvas v1',
  };

  const proofPackage = buildProof(session, {
    summarizeMemory,
    generateTimeline,
    computeProvenanceHash,
    exportNDJSON,
    computeStoryHash,
    renderMarkdown,
  });

  const fileContent = serializeProof(proofPackage);
  triggerDownload(`${canvasState.dataset.name}.proof`, fileContent, 'application/json');
}
```

`triggerDownload` is the caller's own small browser helper (a `Blob` +
`URL.createObjectURL` + a synthetic `<a download>` click, or the
OPFS-backed download flow already used elsewhere in the Canvas for CSV/PDF
export) — `proof-builder.js` itself never touches the DOM or triggers a
download; it only produces the string that gets written to disk.

## 8. Related modules

- [`docs/institutional-memory.md`](./institutional-memory.md) — the
  decision log this module reads from (`memory.ndjson`, `memory.summary`,
  `memory.timeline`).
- `js/story/story-builder.js` — the Story View narrative this module embeds
  a hash and preview of (`story.storyHash`, `story.markdownPreview`).
- `js/validation/validation.js` — the validation rail that produces the
  `Finding[]` list this module hashes and gates on.
