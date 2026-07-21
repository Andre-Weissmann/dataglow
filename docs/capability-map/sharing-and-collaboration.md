# Capability detail — Sharing & collaboration

Companion to the **Sharing & collaboration** area in
[`../capability-map.md`](../capability-map.md).

## What this area is

The export, publish, and real-time collaboration surface. Backing modules:
`js/publish/publish-engine.js` and `canvas/snapshot.html`.

## Publish engine (`publish-engine.js`)

- Generates a self-contained read-only snapshot of an analysis session: data
  summary, validation results, charts, and narrative in a single portable HTML file.
- The snapshot includes the provenance receipt and Trust Certificate so recipients
  can verify the validation chain without running DataGlow themselves.
- Snapshots are produced locally — no upload, no server, no account required.

## Snapshot viewer (`canvas/snapshot.html`)

- Standalone viewer for exported snapshots.
- Renders charts, validation findings, and narrative from the embedded JSON payload.
- Supports Trust Beam: a URL-fragment verifier link that re-runs seal verification
  client-side.

## DataGlow Rooms (real-time, best-effort)

Read-only collaborative presence: analysts in the same Room see each other's
cursor position, active chart, and latest finding in near-real-time via a
lightweight signaling layer. Room codes are ephemeral — no server stores session
data. Collaboration syncs only lightweight state, never row data.

## Export formats

`export-report.js` supports HTML (full fidelity), Markdown (text summary),
JSON (machine-readable findings), and CSV (results table). `export-delivery.js`
handles the blob → download flow.
