# DataGlow Rooms

`js/rooms/rooms-builder.js`

## 1. What Rooms are, and the zero-raw-data principle

DataGlow Rooms implement **Feature 11** of the Canvas spec: async
collaboration between analysts via signed findings JSON. A Room is a small,
static JSON file an analyst exports from the Canvas and hands to a
collaborator through any channel — Slack, email, a shared drive, a git
repo, a USB stick. No server, no account, no upload.

The core guarantee, and the reason Rooms exist at all: **a Room never
contains the underlying data.** Not a single row, not a single cell value,
not the source file's content. What it contains instead is everything a
collaborator needs to *understand and verify* what was found, without ever
receiving the file itself:

- the **findings** from the validation rail — descriptions of what was
  wrong (severity, column, message, rows affected), never the actual
  offending values,
- the **institutional memory timeline** — a plain-language "who did what
  when" record (see
  [`docs/institutional-memory.md`](./institutional-memory.md)),
- the full **memory NDJSON audit trail**, optionally,
- the **Story View's key-finding sentence**, if a story was generated,
- the **Proof Export package hash**, if a `.proof` file was generated (see
  [`docs/proof-export.md`](./proof-export.md)).

This is the same discipline every other DataGlow feature already follows —
"your data never leaves your machine" — carried to its logical conclusion
for collaboration: two analysts can fully discuss, cross-check, and combine
their findings about a dataset while neither one ever transmits the dataset.

If you need the recipient to be able to *cryptographically* re-derive that
the findings match the source data, pair a Room with a `.proof` file (see
Section 7).

## 2. The Room schema

```jsonc
{
  "version": 1,
  "format": "dataglow-room",
  "roomId": "djb2:9f3a1c02",

  "roomName": "Claims Q2 Review",
  "createdBy": "Andre W.",
  "createdAt": "2026-07-19T15:00:00.000Z",

  "dataset": {
    "name": "claims_Q2_2026.csv",
    "sourceFileHash": "djb2:abc12345",
    "rowCount": 14203,
    "columnCount": 18
  },

  "findings": [
    {
      "severity": "error",
      "column": "claim_amount",
      "message": "Negative values found",
      "rowsAffected": 5,
      "suggestedFix": "Take absolute value",
      "status": "open"
    }
  ],

  "summary": {
    "totalFindings": 2,
    "errorCount": 1,
    "warningCount": 1,
    "storySummary": "Claims data is largely clean, with 5 negative claim amounts needing review."
  },

  "timeline": [
    "File loaded: claims_Q2_2026.csv (2026-07-10 10:00)",
    "Agent fixed 5 values in claim_amount — accepted by analyst (2026-07-10 10:05)"
  ],

  "memoryNDJSON": "{\"id\":\"r1\",\"type\":\"file_loaded\",...}\n{\"id\":\"r2\",...}",

  "proofHash": "djb2:c001d00d",

  "signature": "djb2:7be21a90"
}
```

Field notes:

- **`roomId`** — a djb2 hash of `roomName + sourceFileHash + createdAt`,
  computed deterministically so re-building the identical Room from the
  identical session always yields the identical id.
- **`dataset.sourceFileHash`** — the same djb2-of-filename+size hash used
  elsewhere in DataGlow (see `js/memory/institutional-memory.js` /
  `js/proof/proof-builder.js`). This is the field `mergeRooms()` and
  `isSameDataset()` use to confirm two Rooms are about the same file — it is
  never derived from file content, only filename + size, so it never
  requires reading the data.
- **`findings`** — always the sanitized `{severity, column, message,
  rowsAffected, suggestedFix, status}` shape. Any other field on an input
  Finding object (e.g. an accidentally-attached raw value) is dropped by
  `createRoom()`, not carried through.
- **`timeline`** and **`memoryNDJSON`** are each independently optional —
  `null` when not included (see `options.includeTimeline` /
  `options.includeMemoryNDJSON` in Section 3).
- **`signature`** — see Section 6.

## 3. Creating and exporting a Room

From the Canvas, after validating (and optionally generating a Story or a
`.proof` file for) a dataset:

1. Open the **Rooms** panel and choose **Create Room**.
2. Give the Room a human name (e.g. "Claims Q2 Review") — this is just a
   label for you and your collaborator, not an identifier.
3. Choose what to include: the memory timeline (on by default), the full
   memory NDJSON audit trail (on by default — larger file, but lets the
   recipient run their own timeline/summary queries), the Story's
   key-finding sentence (if a Story was generated), and the Proof Export
   hash (if a `.proof` was generated).
4. DataGlow calls `createRoom(session, options)`, which returns a Room
   object built entirely from findings/memory/story/proof metadata already
   in memory — it never re-reads the source file.
5. Click **Export**. DataGlow calls `serializeRoom(room)` and saves the
   result as a `.room.json` file (or whatever extension your workflow
   prefers — the content is plain JSON either way).
6. Share that file with your collaborator through any channel you like.

```js
import { createRoom, serializeRoom } from './js/rooms/rooms-builder.js';

const room = createRoom({
  roomName: 'Claims Q2 Review',
  datasetName: 'claims_Q2_2026.csv',
  sourceFileHash: sourceFileHash,       // djb2 of filename+size
  rowCount: 14203,
  columnCount: 18,
  findings: validationFindings,          // from the validation rail
  memoryTimeline: generateTimeline(memoryStore, datasetId),
  memoryNDJSON: exportNDJSON(memoryStore, datasetId),
  storySummary: storyDoc ? storyDoc.keyFinding : null,
  proofHash: proofPackage ? proofPackage.integrity.packageHash : null,
  createdBy: 'Andre W.',
  createdAt: new Date().toISOString(),
});

const fileContent = serializeRoom(room);
// hand fileContent to the Canvas's file-save dialog
```

## 4. Importing and verifying a Room

The receiving analyst never needs the original file or a live DataGlow
session to make sense of a Room:

1. In the Canvas's **Rooms** panel, choose **Import Room** and pick the
   `.room.json` file.
2. DataGlow calls `deserializeRoom(json)`, which parses the file and checks
   its structure (required fields present, `version`/`format` correct).
   This step does **not** check the signature — it is purely "is this a
   well-formed Room file at all."
3. DataGlow calls `verifyRoom(room)` to check the signature. This is the
   tamper-evidence check: if the file was hand-edited or corrupted in
   transit after being signed, this fails.
4. DataGlow calls `describeRoom(room)` and shows the result:

   ```
   Room: "Claims Q2 Review"
   Dataset: claims_Q2_2026.csv (14203 rows, 18 cols)
   Created by: Andre W. on July 19, 2026
   Findings: 1 errors, 1 warnings
   Story: Claims data is largely clean, with 5 negative claim amounts needing review.
   Proof hash: djb2:c001d0
   Signature: VALID
   ```

5. The recipient can now read every finding, the full decision timeline,
   and the story summary — everything needed to understand what was found
   — without ever touching `claims_Q2_2026.csv`. If they also have their
   own copy of the same file loaded locally, they can independently
   validate it and see whether their own findings match; if they receive a
   paired `.proof` file (Section 7), they can cryptographically confirm the
   findings match a specific version of the file.

If `verifyRoom` reports `INVALID`, DataGlow surfaces that plainly — an
invalid signature does not mean the findings are wrong, only that the file
was modified after it was signed, so it should be treated with suspicion
(re-request a fresh export from the source analyst).

## 5. Merging Rooms

**When to use it:** two analysts independently review the same dataset —
maybe one focuses on referential integrity while the other checks
distributions — and want to combine their findings into a single Room
before sharing with a third party or filing it as the definitive review.

`mergeRooms(roomA, roomB, { mergedBy })` first checks that both Rooms are
about the *same* dataset via `dataset.sourceFileHash`. If the hashes don't
match, nothing is merged:

```js
{
  merged: null,
  conflicts: [{
    field: 'sourceFileHash',
    roomAValue: 'djb2:aaaa1111',
    roomBValue: 'djb2:bbbb2222',
    description: 'Rooms are about different source files and cannot be merged',
  }],
}
```

When the hashes match, each section merges independently:

| Field | Merge rule |
|---|---|
| `findings` | Union, deduplicated by `(column, message)`. If the same `(column, message)` pair has a different `severity` in each Room, that's a **conflict** — both severities are recorded, and the merged list keeps the more severe of the two. |
| `timeline` | Interleaved by the timestamp embedded in each entry (when present), else concatenated Room A then Room B. Exact-duplicate strings are removed. |
| `memoryNDJSON` | Lines from both Rooms are combined and deduplicated by the record's `id` field. |
| `storySummary` | If both Rooms have one and they differ, that's a **conflict** — Room A's summary is kept in the merged Room, and the conflict records both. |
| `proofHash` | If both Rooms have one and they differ, that's a **conflict** — both are kept, in `merged.proofHashes[]`. |

A conflict looks like:

```jsonc
{
  "field": "findings.severity",
  "roomAValue": "warning",
  "roomBValue": "error",
  "description": "Column \"patient_id\" / \"Duplicate IDs detected\" has severity \"warning\" in Room A but \"error\" in Room B"
}
```

**Resolving conflicts** is a human decision — `mergeRooms()` never silently
drops information to resolve a disagreement. Look at each conflict, decide
which value is correct (or whether both analysts are right about different
aspects of the same issue), and edit the merged Room's `findings` /
`summary.storySummary` / `proofHashes` by hand if the automatic resolution
isn't what you want. The merged Room returned by `mergeRooms()` is a
starting point, not a forced final answer.

The merged Room itself gets a new `roomId`, a `roomName` of `"Merged: {A's
name} + {B's name}"`, `createdBy` set to whoever ran the merge, and is
fully re-signed — `verifyRoom()` passes on it exactly like any other Room.

## 6. The signature — what it proves, and what it doesn't

Every Room's `signature` field is a **djb2 hash** (the same dependency-free
algorithm used throughout DataGlow — see
`js/memory/institutional-memory.js`, `js/story/story-builder.js`,
`js/proof/proof-builder.js`) computed over every other field in the Room,
last, once everything else is final. `verifyRoom()` re-derives it and
compares.

**What this proves:** the Room you're looking at is byte-for-byte identical
to the Room that was signed. If anyone — accidentally or on purpose — edits
a finding's message, adds a row to the timeline, or changes the
`createdBy` field after the fact without recomputing the signature, `verifyRoom`
will report `INVALID`.

**What this does not prove:** djb2 is a fast, simple checksum, not a
cryptographic message authentication code. There is no secret key involved
— the algorithm is public (it's right there in `rooms-builder.js`), so
someone who wants to *forge* a Room and produce a matching signature can do
so; djb2 only guards against **accidental corruption and casual, unnoticed
tampering**, not a determined adversary. Treat a Room's signature the way
you'd treat a checksum on a downloaded file: it tells you "this hasn't
silently changed since it was created," not "this was cryptographically
attested by a trusted key."

If you need a stronger guarantee — genuine cryptographic proof that
findings match a specific source file — pair the Room with a `.proof` file
(Section 7), which is where DataGlow's cryptographic-grade verification
lives.

## 7. Forward compatibility: Rooms + Proof Export

Rooms and Proof Export ([`docs/proof-export.md`](./proof-export.md)) are
complementary, not competing:

- A **Room** is optimized for *human* collaboration — readable findings, a
  plain-language timeline, a story summary, small enough to paste into a
  Slack message or a ticket.
- A **`.proof` file** is optimized for *independent verification* — a
  four-hash integrity chain (`validationHash` / `provenanceHash` /
  `storyHash` / `packageHash`) that a recipient re-derives entirely from
  data embedded in the file itself, with no dependency on DataGlow or a
  live session.

A Room's `proofHash` field is designed to hold a `.proof` package's
`integrity.packageHash` — so sharing **a Room together with its paired
`.proof` file** gives a collaborator both halves of the picture: the
human-readable "here's what we found and decided" narrative (the Room) and
the cryptographic "here's proof it matches the source data" attestation
(the `.proof` file). `mergeRooms()`'s `proofHashes[]` conflict field exists
for exactly this reason: if two analysts each generated their own `.proof`
file for the same dataset, the merged Room keeps both hashes so a
downstream reviewer can request and check either one.

Neither file ever contains the dataset. Sharing both together is still
zero-raw-data collaboration — just with two complementary, verifiable
layers instead of one.

## 8. Privacy guarantee: what is, and isn't, in a Room

**In a Room:**

- Finding *descriptions* — severity, column name, a human-readable message,
  a count of rows affected, a suggested fix description, a status. Never
  the actual value that triggered the finding.
- The institutional memory timeline — plain-language sentences describing
  decisions ("Agent fixed 5 values in claim_amount — accepted by analyst").
  Never the values themselves.
- The raw NDJSON audit trail, if included — this carries the same
  structured decision records as the timeline (type, actor, column,
  timestamp, reason), never a `before`/`after` cell value pulled from the
  actual dataset content (institutional memory's own records may carry
  `before`/`after` for a manual edit — when building a Room, only include a
  memory export you're comfortable sharing, the same judgment call you'd
  make sharing any audit log).
- A one-sentence story summary, if a Story was generated.
- A `.proof` package hash, if one was generated — a hash, never the
  package contents.
- Dataset *metadata* — a display name, a row count, a column count, a
  filename+size hash. Never the file's bytes.

**Never in a Room:**

- Row data, in any form.
- Cell values, in any form — including inside a finding's message (Rooms
  can only ever contain the sanitized finding shape `createRoom()`
  produces, which drops any field beyond `severity`/`column`/`message`/
  `rowsAffected`/`suggestedFix`/`status`).
- The source file's bytes or content, in any form.
- Anything resembling an array-of-arrays or a row-shaped object —
  `createRoom()` only ever reads the specific documented fields off the
  input session object, so even if a raw dataset were accidentally attached
  to a session object under some other key, it is never copied into the
  Room.
