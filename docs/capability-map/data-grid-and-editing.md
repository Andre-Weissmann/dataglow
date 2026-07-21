# Capability detail — Data grid & editing

Companion to the **Data grid & editing** area in
[`../capability-map.md`](../capability-map.md).

## What this area is

The interactive surface for viewing, filtering, sorting, and editing loaded data
before analysis. Backing modules: `js/columns/column-editor.js` and
`js/join/join-builder.js`.

## Column editor (`column-editor.js`)

- Rename, retype, and reorder columns without reloading the dataset.
- Format fingerprinting detects format anomalies (mixed date formats, numeric
  strings, currency symbols) and suggests normalisation.
- Imputation UI exposes mean / median / mode / constant fill strategies for
  missing values, with a materiality gate that suppresses suggestions when the
  missing rate is below the threshold (default 1%).
- All edits are recorded in the provenance chain so the validation receipt reflects
  the cleaned state.

## Join builder (`join-builder.js`)

- Drag-and-drop join construction across any two loaded datasets.
- Automatic join-key cardinality detection: warns on many-to-many joins before
  they execute.
- Join coverage checker runs post-join and reports the fraction of left-table rows
  that matched, flagging orphan rates above the rulepack threshold.
- Supports INNER, LEFT, RIGHT, FULL OUTER, and CROSS joins; CROSS is gated behind
  an explicit confirmation because of fanout risk.

## Identifier-column guard

Columns detected as unique identifiers (`patient_id`, `claim_id`, etc.) are
excluded from fuzzy-dedup merge suggestions to prevent destructive false-positive
merges on primary keys.
