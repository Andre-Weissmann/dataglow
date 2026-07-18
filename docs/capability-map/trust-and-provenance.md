# Capability detail — Trust & provenance

Companion to the **Trust & provenance** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the Trust Certificate; the index alone is enough for most tasks.

## What this area is

A single file: `js/trust/trust-certificate.js`. It assembles one signed,
downloadable **Trust Certificate** that bundles the full validation run, the AI
Readiness Gate verdict, the k-anonymity check, and (when present) the equity
attestation into one SHA-256-signed `.dataglow-cert.json` document a stakeholder
or downstream AI agent can verify offline without re-running the analysis or
contacting DataGlow.

The module is **pure** (no DOM, no network). It is composition over
already-shipped modules — it imports `sha256Hex` from
`js/provenance/provenance.js`, `buildPacket`/`serializePacket` from
`js/provenance/provenance-packet.js`, and `computeReadinessGate`/
`explainGateReasons` from `js/gate/readiness-gate.js`. It invents no new
validation or signing machinery of its own.

## Exported API

- `buildTrustCertificate({ dataset, layerResults, kAnonymityResult, blame,
  deidentification, denial, metricContractStatus, equityAttestation, producer,
  generatedAt })` → `Promise<cert>`. Runs the gate over `layerResults`,
  summarizes the layers, compacts the k-anonymity section, embeds a full
  provenance packet (signed separately via `buildPacket`), then signs the outer
  envelope.
- `verifyTrustCertificate(cert)` → `Promise<{valid, reason, signature:{stored,
  recomputed}}>`. Recomputes the outer signature over `certCore(cert)` and
  compares it to the stored value; also rejects a wrong `kind` or an unsupported
  `formatVersion`.
- `serializeCertificate(cert)` / `parseCertificate(text)` — JSON round-trip;
  `parseCertificate` throws a friendly error on invalid JSON or wrong `kind`.
- `certificateFilename(cert)` → `dataglow-trust-cert-<table>.dataglow-cert.json`
  (table name sanitized to `[A-Za-z0-9_-]`).
- `summarizeCertificate(cert)` → one-line UI/toast summary
  (`Gate: PASS | Score: 92 | 18/20 layers pass | k-floor: 7`).
- Constants: `CERT_KIND = 'dataglow-trust-certificate'`,
  `CERT_FORMAT_VERSION = 1`, `CERT_FILE_EXTENSION = '.dataglow-cert.json'`.

## Certificate shape and what the signature covers

The outer document carries `kind`, `formatVersion`, `generatedAt`, `producer`,
`dataset` ({table, rowCount, columns, sourceHash}), `gate`, `validationSummary`,
`kAnonymity`, optional `equity`, the embedded `packet`, `signature`, and a
`disclaimer`.

The outer signature (`certCore`) deliberately does **not** commit to the entire
embedded packet payload — it commits to the packet's own inner signature value
(`packetSignature`) plus the equity `status`/`signature`. Any tampering with the
packet changes its own stored signature, which is embedded here, so the outer
signature still catches it while staying small. The `covers` string on the
signature block spells this out: `kind, formatVersion, generatedAt, producer,
dataset, gate, validationSummary, kAnonymity, equityStatus, equitySignature,
packetSignature`.

`summarizeValidationLayers` accepts either an array or an object of layer
results, counts `pass`/`warn`/`fail`/`idle`, and silently skips any entry whose
`status` isn't one of those four — so a malformed layer result never throws or
inflates the totals.

The k-anonymity section is compacted (the full per-group array is stripped from
the envelope; the fuller result lives in the embedded packet's de-id section)
and defaults `smallCellThreshold` to 5 and `sampledRows`/`kFloor` sensibly when
the check wasn't run.

## UI surface & flag

Wired into `js/app-shell/main.js` via `initTrustCertificate()` (around
`main.js:4980`), which backs the **"Download Trust Certificate"** button
(`#btn-trust-certificate`) in the Preflight Trust tab; it calls
`buildTrustCertificate(...)` with the live validation/gate/k-anon state and
downloads the serialized cert. Initialization is gated:
`if (isEnabled('trustCertificate')) initTrustCertificate();`.

Flag `trustCertificate` in `flags.manifest.json` is **`enabled: true`** — this
area ships **live**, not dark (added in
`feat/rigor-engine-batch4-trust-certificate`, described as pure composition over
already-shipped modules).

## Tests

`test/trust-certificate-phase1.test.mjs` covers this module. (Run separately;
not executed here.)

## Related but not in scope

- `js/provenance/provenance-packet.js` and `js/provenance/provenance.js` — the
  signed packet and the `sha256Hex` primitive this module wraps.
- `js/gate/readiness-gate.js` — the gate whose verdict is embedded.
- `js/equity/equity-attestation.js` — produces the signed equity attestation
  optionally embedded as the `equity` section.

## Caveat — a separate, larger provenance area exists

This page documents only the **Trust & provenance** area's single file. A
separate, much larger area named **"Provenance, audit & trust"** (roughly 30
files) exists in `capability-map.manifest.json` and is **not** covered by this
page. The two are distinct entries; don't conflate them. If you need the broader
audit/trust machinery (the full provenance packet suite, audit ledgers, etc.),
look up that area's own entry rather than this file.
