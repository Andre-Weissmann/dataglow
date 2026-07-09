# Databricks Direct-Connect (proof of concept)

A way to pull a **read-only** SQL result from *your own* Databricks workspace
straight into DATAGLOW's local DuckDB-WASM engine — then clean, validate, and
profile it exactly as if you had imported a CSV. It lives in the **Load Data**
sidebar under "Connect to Databricks".

This is a **proof of concept** shipped to gather feedback on the pattern, not a
hardened, feature-complete connector. See [Limitations](#limitations).

## What it does

1. You paste your workspace **host URL**, a **personal access token**, a **SQL
   warehouse ID**, and a **read-only SQL query** (default:
   `SELECT * FROM samples.tpch.lineitem LIMIT 100`).
2. The browser calls Databricks' public **Statement Execution API** directly:
   - `POST {host}/api/2.0/sql/statements` submits the statement (inline JSON).
   - `GET {host}/api/2.0/sql/statements/{id}` polls until the statement reaches a
     terminal state.
3. On success, the JSON result set is parsed and loaded into DuckDB-WASM as a new
   local table — the same ingest path a file upload uses.

The network + parsing logic lives in [`js/app-shell/databricks-connect.js`](../js/app-shell/databricks-connect.js)
and is deliberately DOM-free and engine-free: `fetch`, the ingest step, and the
poll delay are injected, so it is unit tested against mocked responses with no
live account (see `test/databricks-connect.test.mjs`).

## Trust model

This is a **bring-your-own-credential**, **direct browser-to-Databricks**
connection. Concretely:

- **The token is in-memory only.** It lives in the password field for the
  duration of one query and is cleared from the field as soon as the query
  returns. It is **never** written to `localStorage`, cookies, IndexedDB, or
  disk — consistent with DATAGLOW's standing no-persistence constraint — and it
  is **never logged**.
- **No DATAGLOW server is involved.** There isn't one. The `fetch` goes from your
  browser to *your* workspace host and nowhere else. DATAGLOW never sees,
  proxies, or has custody of your token or your data.
- **Read-only by intent.** The panel is designed for `SELECT` queries that pull a
  sample into DATAGLOW. DATAGLOW does not add write/DDL affordances.
- **Your data stays local.** Once rows land in DuckDB-WASM they are treated
  exactly like an imported file — everything downstream still runs in-browser
  with zero upload.

## Why this works from the browser

Databricks documents the Statement Execution API as directly callable from
browser JavaScript via `fetch()`; their own materials demonstrate the same
browser-fetch pattern powering a Google Sheets add-on. DATAGLOW implements that
public, documented REST surface in original code.

## Reusing the existing ingest path

The connector does **not** introduce a parallel data-loading path. It parses the
result set into `{ columns, rows }` and hands them to `loadRowsAsDataset()` in
[`js/app-shell/loaders.js`](../js/app-shell/loaders.js) — the same helper that registers the dataset
in app state, builds the DuckDB table, and anchors the Chain of Custody. That is
the identical machinery behind Excel/SQLite/golden-dataset ingestion, so a
Databricks table behaves like any other dataset from the moment it loads.

## Errors you might see

The panel surfaces a plain-language message for each failure mode:

- **Token rejected (HTTP 401/403)** — check the personal access token and that it
  can reach the chosen warehouse.
- **Could not reach Databricks** — almost always a **CORS restriction** on your
  workspace (see below), a wrong host URL, or no network.
- **Query failed / canceled** — the statement reached a terminal non-success
  state; the Databricks error message is shown.
- **Query did not finish in time** — the poll budget was exhausted; try a smaller
  query or a warmer warehouse.
- **Unparseable response** — Databricks returned a shape DATAGLOW didn't expect.

## Limitations

- **CORS depends on *your* workspace.** Whether a cross-origin browser request
  from DATAGLOW's origin is allowed is a **Databricks-side workspace setting**,
  not something DATAGLOW controls. If your workspace blocks cross-origin browser
  requests, this feature will not work for you — and that is a workspace
  configuration matter, **not a DATAGLOW bug**.
- **First result chunk only.** The POC reads the first inline JSON chunk of the
  result set. Large results that span multiple chunks are flagged as *truncated*
  in the status line; add a `LIMIT` for now. Multi-chunk / external-link result
  fetching is out of scope for this proof of concept.
- **No query builder.** A raw SQL box is intentional for now; there is no schema
  browser or visual builder.
- **Inline JSON only.** The connector requests `disposition: INLINE`,
  `format: JSON_ARRAY`; the Arrow/external-links dispositions are not used.
