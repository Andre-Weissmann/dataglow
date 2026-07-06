# DATAGLOW Protocol

**Version 1.0.0** — an open, versioned, documented data contract for DATAGLOW's
core data objects.

## Purpose

DATAGLOW is a pure static browser app. This protocol defines the **wire shapes**
of its core objects so that future clients — a CLI, a mobile widget, a
Jupyter/Python client, a browser extension — can read and write the same data
**without depending on DATAGLOW's internal JavaScript**. The schema is the
contract; the browser app is just one implementation of it.

The schemas are plain [JSON Schema (draft 2020-12)](https://json-schema.org/)
files. Nothing here is DATAGLOW-specific tooling — any standard JSON Schema
validator in any language can consume them.

## The core objects

| Schema | File | What it describes |
| --- | --- | --- |
| **Dataset** | `schema/dataset.schema.json` | Shape/metadata of a loaded dataset (no row-level data). |
| **ValidationRun** | `schema/validation-run.schema.json` | One run of the validation layers over a dataset, plus confidence + calibrated grades. |
| **GradeResult** | `schema/grade-result.schema.json` | The two-axis Data Integrity × Domain Plausibility Confidence grade. |
| **ProvenanceAttestation** | `schema/provenance-attestation.schema.json` | Tamper-evident, hash-chained chain-of-custody record + SHA-256 digest. |
| **StoryOutput** | `schema/story-output.schema.json` | A data narrative plus per-claim confidence scoring. |

`ProvenanceAttestation` and `GradeResult` mirror the app's runtime objects
**exactly** (from `js/provenance.js` and `js/calibrated-grades.js`).
`ValidationRun` and `StoryOutput` are stable *envelopes* derived deterministically
from internal objects (see `js/protocol-conformance.js`), so the wire shape does
not churn when internal bookkeeping changes.

## Validating a payload

Any standard JSON Schema validator works. Two examples:

**Node with a full validator (e.g. `ajv`):**

```js
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
// Register every schema so cross-file $refs resolve by $id:
for (const f of ['dataset', 'grade-result', 'validation-run', 'provenance-attestation', 'story-output']) {
  ajv.addSchema(JSON.parse(readFileSync(`protocol/schema/${f}.schema.json`, 'utf8')));
}
const validate = ajv.getSchema('https://dataglow.app/protocol/1.0.0/provenance-attestation.schema.json');
const payload = JSON.parse(readFileSync('my-attestation.json', 'utf8'));
if (!validate(payload)) console.error(validate.errors);
```

**Zero-dependency (the validator DATAGLOW itself ships):**

```js
import { validate, buildRegistry } from './protocol/validator.mjs';
// load the schema JSON files, then:
const { valid, errors } = validate(payload, attestationSchema, buildRegistry(allSchemas));
```

`protocol/validator.mjs` is a small, dependency-free validator covering the
subset of JSON Schema these schemas use. It is what powers DATAGLOW's own
dev-mode conformance check and the runnable example below. For anything more
elaborate, reach for a full validator — the schemas are standard JSON Schema and
are vendor-neutral.

## Runnable example

`examples/validate-example.mjs` takes a DATAGLOW-exported JSON object and
validates it against the protocol **with no browser and no DATAGLOW app code**:

```
node protocol/examples/validate-example.mjs
node protocol/examples/validate-example.mjs path/to/exported-attestation.json
```

With no argument it validates the bundled sample attestation
(`examples/sample-attestation.json`). This proves the protocol is genuinely
usable standalone.

## Versioning & compatibility policy

The protocol is versioned with [semantic versioning](https://semver.org/),
starting at `1.0.0` (see the `VERSION` file and the `version` annotation in each
schema; envelope payloads also carry a `protocolVersion` field).

- **PATCH** (`1.0.x`) — editorial/clarifying changes with no shape impact.
- **MINOR** (`1.x.0`) — **additive, backward-compatible** changes: new
  *optional* fields, new enum members, new object kinds. A `1.0.0` consumer must
  keep working against `1.1.0` data.
- **MAJOR** (`x.0.0`) — **breaking** changes: removing/renaming a field, making
  an optional field required, tightening a type, removing an enum member.

Producers SHOULD stamp payloads with the `protocolVersion` they target. Consumers
SHOULD accept any payload whose MAJOR matches and whose MINOR is ≤ the version
they understand, and SHOULD ignore unknown additional fields (forward
compatibility).

## Legal / liability note

These objects describe **heuristic** data-quality signals and **cryptographic
integrity** records for healthcare-adjacent, potentially PHI-sensitive data.

- A `GradeResult` and the confidence scores are explicitly **heuristics**, not
  legal, clinical, or regulatory determinations.
- A `ProvenanceAttestation` is a **cryptographic integrity record only** — it
  proves a recorded chain of custody was not altered after export. It is **not**
  a notarization and **not** a legal/clinical determination. Its `notarization`
  block is deliberately labelled `digest-ready-for-notarization`, never
  `notarized`, unless independently notarized by a third-party timestamp authority.
- The schemas intentionally describe **metadata and shapes**, not row-level data.
  `Dataset` carries counts and column descriptors, never cell values, so a
  conformant export does not by itself carry PHI. Implementers remain responsible
  for ensuring any `detail`/`summary` free-text fields they populate do not embed
  PHI.
