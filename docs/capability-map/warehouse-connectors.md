# Capability detail — Warehouse connectors

Companion to the **Warehouse connectors** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're
working on a direct-to-warehouse ingestion path; the index alone is enough for
most tasks.

## What this area is

Two browser-native connectors that pull rows from an external warehouse straight
into DuckDB-WASM with **no DataGlow server in the middle** — the zero-upload
promise holds because every network call goes directly from the tab to the
vendor (Google / AWS). Both are "Phase 5" additions and both are **live, not
flag-gated**: `init()` in `js/app-shell/main.js` calls `initS3Connect()` and
`initBigQueryConnect()` unconditionally (alongside the older
`initDatabricksConnect()`), so the Warehouse Lane UI renders for every user.

## `js/warehouse/bigquery-connector.js` — BigQuery

Connects via OAuth 2.0 **implicit/token flow** (no auth code, no server-side
exchange) against `bigquery.googleapis.com`, which is CORS-friendly by design.

- `requestOAuthToken({ clientId, redirectUri, openWindow })` → `Promise<token>`.
  Opens a popup to `accounts.google.com/o/oauth2/v2/auth` with
  `response_type=token` and the `bigquery.readonly` scope, polls the popup for a
  URL fragment carrying `access_token=` or `error=`. `openWindow` is injectable
  for tests. Rejects with `ERRORS.AUTH_CANCELLED` on popup-block/close.
- `class BigQueryConnector({ loadRows, fetch, openWindow })` — `loadRows` is
  required. `validate()` returns an error string or `null`; `connect()`
  orchestrates: reuse cached in-memory token → `_runQuerySync()` (Jobs: query
  REST endpoint, `useLegacySql:false`) → if `jobComplete` page through
  `_fetchAllPages()` (50k-row pages), else `_pollJob()` (2s interval, 60 attempts
  = 120s cap, then throws a timeout error suggesting `LIMIT`).
- Token is **in-memory only** (`this._token`), cleared on 401/403 so the next
  call re-auths; `setToken`/`clearToken`/`token` exist for tests. `TRUST_NOTICE`
  is the user-facing "token stays in this tab" statement.
- `BQ_TO_DUCK_TYPE` maps BigQuery scalar types to DuckDB types (STRING→VARCHAR,
  INT64→BIGINT, FLOAT64→DOUBLE, etc.); `convertRows`/`convertCell` unwrap the
  `{ f: [{ v }] }` BigQuery row shape into plain JS objects. Ingest happens via
  the injected `loadRows({ rows, cols, name:'bigquery_query (BigQuery)', source:'bigquery' })`.
- Security stance encoded in comments + `ERRORS`: OAuth only, never service-
  account JSON keys; the Client ID is not a secret.

Wired in `main.js` at `initBigQueryConnect()` (reads `#bigquery-client-id`,
`#bigquery-project`, `#bigquery-sql`, writes `#bigquery-status`,
`#bigquery-trust-note`; run button `#btn-bigquery-run`, sign-out
`#btn-bigquery-signout`).

## `js/warehouse/s3-connector.js` — S3 / Parquet

Lets DuckDB-WASM read S3 objects directly. **DOM-free and engine-free** — all of
`runQuery`, `loadRows`, `sleep`, and `fetch` are injected, exactly like
`databricks-connect.js`, so it unit-tests with no browser and no live S3.

- Two credential modes via `MODES`: `PRESIGNED` (URL already carries a
  signature — no credentials in the browser at all) and `IAM` (explicit
  `keyId`/`secret`/`region`, registered through DuckDB's `CREATE OR REPLACE
  SECRET` so creds live only in the in-memory engine). The comment notes the aws
  extension's automatic credential-chain discovery does **not** work in WASM.
- `class S3Connector({ runQuery, loadRows, sleep, fetch })` — `runQuery` and
  `loadRows` are required. Key pure helpers:
  - `validate({ mode, url, keyId, secret, region })` → error string or `null`
    (PRESIGNED accepts `https://`/`http://`/`s3://`; IAM requires `s3://` + all
    three creds).
  - `detectFormat(url)` strips query string/fragment, then resolves the
    extension to `parquet|csv|json|ndjson`, handling `.json.gz`/`.csv.gz` style
    double extensions. `SUPPORTED_EXTS` is the allow-set.
  - `buildReadSQL(url, format, limit)` emits `read_parquet` /
    `read_csv_auto(..., ignore_errors=true)` / `read_json_auto`, single-quote-
    escaping the URL.
  - `buildCreateSecretSQL({ keyId, secret, region, sessionToken })` builds a
    `CREATE OR REPLACE SECRET s3_cred_<random> (TYPE S3, …)` with a randomized
    per-session name and quote-escaped values.
  - `connect()` validates → (IAM) registers the secret → runs the read SQL →
    maps CORS/network/fetch error substrings to `ERRORS.CORS_BLOCKED` (the
    documented #1 failure mode) → ingests via `loadRows({ …, source:'s3' })`.
    Default `rowLimit` is 500,000. `deriveName()` turns the URL tail into a
    friendly table name.
- `TRUST_NOTICE` and `CORS_HELP` are the user-facing strings; `ERRORS` is the
  single source of truth shared by UI and tests.

Wired in `main.js` at `initS3Connect()` (run button `#btn-s3-run`, status
`#s3-status`; imports `MODES as S3_MODES`, `TRUST_NOTICE as S3_TRUST_NOTICE`).

## Flag state

**None.** Neither connector is listed in `flags.manifest.json`; both ship live.
(The only `flags.manifest.json` hit for "bigquery" is inside the unrelated
`polyglotDialectAdapter` description, which lists BigQuery as one of its
transpile source dialects — that is the SQL-dialect adapter, not this connector.)

## Tests

- `test/warehouse-lane-phase5.test.mjs` — the Phase 5 warehouse-lane suite
  covering these connectors (validation, format detection, SQL building, row
  conversion, error mapping via injected `runQuery`/`fetch`).
- `test/databricks-connect.test.mjs` — the sibling Databricks connector's suite
  (same injected-dependency pattern), listed here for context.

## Related but not in scope

- `js/app-shell/main.js` `initDatabricksConnect()` and its backing
  `databricks-connect.js` — the third Warehouse Lane connector, same
  inject-everything shape.
- `js/app-shell/sql-dialect-adapter.js` — the Polyglot Workbench dialect
  transpiler (flag `polyglotDialectAdapter`); unrelated despite mentioning
  "BigQuery" as a source dialect.
- The injected `loadRows` / `runQuery` come from the app's DuckDB ingestion
  layer; these connectors never import the engine directly.
