# Tauri Live Connector Layer

## 1. What it is, and why it requires Tauri

The Tauri Live Connector Layer is the JS-side interface contract that lets
the DataGlow Canvas open **live, native connections** to Postgres, MySQL,
SQLite, and local DuckDB files — the databases people actually run in
production, as opposed to a CSV/Parquet snapshot dropped into the browser.

This is deliberately **not** something the browser build can do on its own,
for three separate reasons:

- **No native drivers in a webview.** `libpq` (Postgres), `mysqlclient`, and
  SQLite's C library are native code. There is no way to open a raw TCP
  socket to `db.internal:5432` from a `<script>` tag — browsers do not expose
  that primitive, and no WASM build of these drivers changes the fact that a
  browser's networking stack cannot make an arbitrary outbound TCP
  connection the way a desktop process can.
- **No CORS.** Even if a WASM Postgres client existed, most production
  databases sit behind a firewall or a VPC that only routes internal
  traffic — and a browser tab is, by definition, external. The [existing
  desktop shell](desktop-shell.md) already establishes that a Tauri window
  is a native OS process with a native network stack, so it does not hit
  either wall.
- **No cloud relay.** DataGlow's entire trust model (see
  [`TRUST.md`](../TRUST.md) and the [NATS bridge](nats-bridge.md)'s
  "local-first" posture) is that raw data never leaves the user's machine
  through a third-party server. A hosted proxy that terminates the DB
  connection on DataGlow's behalf would violate that model outright. Native
  Tauri connections keep the whole path — Canvas → Tauri IPC → sqlx →
  database — inside the user's own machine and network.

This PR ships the **JS contract only**: a pure-logic bridge
(`js/connectors/tauri-connector.js`) and a multi-connection manager
(`js/connectors/connector-manager.js`), both fully tested in plain Node with
a mocked `invoke`. The Rust side (`src-tauri/src/commands/connector.rs`) does
not exist yet — §3 below is a complete implementation spec for it, written so
a developer can build it without needing to ask any follow-up questions.

## 2. The JS/Rust contract

Every call from the Canvas to the Tauri backend goes through Tauri's
[`invoke`](https://v1.tauri.app/v1/guides/features/command) IPC bridge:
`invoke(command, args)`. `js/connectors/tauri-connector.js` never imports
`@tauri-apps/api/tauri` itself — it takes `invoke` as an injected dependency
(`deps.invoke`) so the whole module runs in plain Node under test, and the
real `@tauri-apps/api/tauri` import happens exactly once, in the browser
wiring layer that is out of scope for this PR (it will live alongside the
Canvas's other Tauri glue once `src-tauri/` grows commands).

`TAURI_COMMANDS` (exported from `tauri-connector.js`) is the authoritative
list of command names the Rust side must register:

```js
const TAURI_COMMANDS = [
  'dataglow_connect',
  'dataglow_query',
  'dataglow_stream',
  'dataglow_disconnect',
  'dataglow_list_tables',
  'dataglow_describe_table',
];
```

### 2.1 `dataglow_connect`

| | Shape |
| --- | --- |
| Request args | `{ config: ConnectionConfig }` (password stripped — see §4) |
| Response | `ConnectResult` |

```ts
type ConnectionConfig = {
  type: 'postgres' | 'mysql' | 'sqlite' | 'duckdb_native';
  host?: string;             // required for postgres/mysql
  port?: number;             // 1-65535
  database: string;          // db name, or file path for sqlite/duckdb_native
  username?: string;
  ssl?: boolean;
  connectionTimeout?: number; // ms, default 5000
  queryTimeout?: number;      // ms, default 30000
  // password is intentionally absent — see §4
};

type ConnectResult = {
  connected: boolean;
  connectionId: string;      // opaque handle for all subsequent calls
  schema: TableSchema[];
  error: string | null;
};

type TableSchema = {
  tableName: string;
  columns: Array<{ name: string; type: string; nullable: boolean; isPrimaryKey: boolean }>;
};
```

### 2.2 `dataglow_query`

| | Shape |
| --- | --- |
| Request args | `{ connectionId: string, sql: string, params: unknown[] }` |
| Response | `QueryResult` |

```ts
type QueryResult = {
  rows: Record<string, unknown>[];
  columns: string[];
  rowCount: number;
  durationMs: number;
  error: string | null;
};
```

### 2.3 `dataglow_stream`

| | Shape |
| --- | --- |
| Request args | `{ connectionId: string, sql: string, batchSize: number, pollIntervalMs: number }` |
| Response | `void` — data arrives via Tauri **events**, not the invoke return value (see §7) |

Defaults (applied by `buildStreamCall` on the JS side if omitted):
`batchSize = 1000`, `pollIntervalMs = 5000`.

### 2.4 `dataglow_disconnect`

| | Shape |
| --- | --- |
| Request args | `{ connectionId: string }` |
| Response | `{ disconnected: boolean, error: string \| null }` |

### 2.5 `dataglow_list_tables`

| | Shape |
| --- | --- |
| Request args | `{ connectionId: string }` |
| Response | `TableSchema[]` |

### 2.6 `dataglow_describe_table`

| | Shape |
| --- | --- |
| Request args | `{ connectionId: string, tableName: string }` |
| Response | `TableSchema` |

## 3. Rust backend spec (`src-tauri/src/commands/connector.rs`)

This section is the implementation spec for the Rust side. None of this code
ships in this PR — `src-tauri/` today registers zero commands (see
[desktop-shell.md](desktop-shell.md)) — but everything below is specific
enough to implement directly against.

### 3.1 Crate dependencies to add to `src-tauri/Cargo.toml`

```toml
[dependencies]
sqlx = { version = "0.7", features = [
    "runtime-tokio-rustls", "postgres", "mysql", "sqlite", "json", "chrono",
] }
tokio = { version = "1", features = ["full"] }
uuid = { version = "1", features = ["v4"] }
keyring = "2"          # OS-level secure credential store (see §4)
```

`sqlx` was picked (over `diesel`/`tokio-postgres` directly) because a single
crate covers all three target databases with one async connection-pool API,
which keeps `connector.rs` free of per-driver branching except at the
`AnyPool`/enum-dispatch boundary described below.

### 3.2 Shared state

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use sqlx::{AnyPool, Pool, Any};
use uuid::Uuid;

pub struct ConnectionRegistry {
    pub pools: Mutex<HashMap<String, AnyPool>>,
}
```

Registered once via `.manage(ConnectionRegistry { pools: Mutex::new(HashMap::new()) })`
in `main.rs`'s `tauri::Builder`. `sqlx::any::AnyPool` is used so one
`HashMap<String, AnyPool>` can hold Postgres, MySQL, or SQLite pools
interchangeably, keyed by `connectionId` (a `Uuid::new_v4().to_string()`
minted on connect).

### 3.3 `dataglow_connect`

```rust
#[tauri::command]
async fn dataglow_connect(
    config: ConnectionConfig,
    registry: tauri::State<'_, ConnectionRegistry>,
) -> Result<ConnectResult, String> {
    // 1. Look up the password from the OS secure store (see §4), keyed by
    //    a profile id derived from (type, host, port, database, username) —
    //    the JS side never sends a password in `config`.
    // 2. Build the sqlx connection string for `config.type`:
    //      postgres -> postgres://user:pass@host:port/database?sslmode=...
    //      mysql    -> mysql://user:pass@host:port/database
    //      sqlite   -> sqlite://<database path>
    //      duckdb_native -> not an sqlx driver; shell out to the existing
    //                       DuckDB integration (js/warehouse) via a
    //                       dedicated branch, or open with the `duckdb-rs`
    //                       crate if native DuckDB access from Rust is
    //                       preferred over the existing WASM path.
    // 3. sqlx::any::AnyPoolOptions::new()
    //        .acquire_timeout(Duration::from_millis(config.connection_timeout.unwrap_or(5000)))
    //        .connect(&conn_string).await
    // 4. On success: mint connectionId = Uuid::new_v4().to_string(), insert
    //    into registry.pools, run introspection queries per db type to
    //    build Vec<TableSchema> (information_schema for postgres/mysql,
    //    sqlite_master + PRAGMA table_info for sqlite), return ConnectResult.
    // 5. On failure: return { connected: false, connectionId: "", schema: [],
    //    error: Some(err.to_string()) } — never panic; a bad host/credential
    //    is an expected, recoverable outcome, not a crash.
}
```

### 3.4 `dataglow_query`

```rust
#[tauri::command]
async fn dataglow_query(
    connection_id: String,
    sql: String,
    params: Vec<serde_json::Value>,
    registry: tauri::State<'_, ConnectionRegistry>,
) -> Result<QueryResult, String> {
    // 1. Look up the pool by connection_id; error "connection not found" if absent.
    // 2. Bind `params` positionally via sqlx::query(&sql).bind(..) for each
    //    param (params must be positional, not named, to stay driver-agnostic
    //    across postgres $1/mysql ?/sqlite ? placeholder styles — the JS
    //    caller is responsible for writing SQL with the right placeholder
    //    syntax for the connection's db type).
    // 3. Apply config.query_timeout via tokio::time::timeout wrapping the
    //    query future; on timeout, return a QueryResult with `error` set
    //    rather than hanging the invoke call indefinitely.
    // 4. Convert each returned sqlx::any::AnyRow to a
    //    serde_json::Map<String, Value> using column metadata
    //    (row.columns()) to decide the try_get::<T> type per column —
    //    this is the "rows as Vec<serde_json::Value>" the spec calls for.
    // 5. Measure duration with std::time::Instant, return QueryResult with
    //    rows/columns/rowCount/durationMs/error(None).
}
```

### 3.5 `dataglow_stream`

```rust
#[tauri::command]
async fn dataglow_stream(
    connection_id: String,
    sql: String,
    batch_size: u32,
    poll_interval_ms: u64,
    app_handle: tauri::AppHandle,
    registry: tauri::State<'_, ConnectionRegistry>,
) -> Result<(), String> {
    // Spawns a tokio task (tokio::spawn) that loops:
    //   loop {
    //     let batch = run the sql with LIMIT batch_size OFFSET <cursor>  // or
    //                  a caller-supplied incrementing predicate, e.g. a
    //                  `WHERE id > :last_seen_id` pattern the Canvas's SQL
    //                  already encodes — this command does not rewrite SQL,
    //                  it just re-runs what it is given on each tick;
    //     app_handle.emit_all("dataglow://stream-batch", StreamBatchPayload {
    //         connection_id: connection_id.clone(),
    //         rows: batch.rows,
    //         columns: batch.columns,
    //         batch_number,
    //         emitted_at: Utc::now().to_rfc3339(),
    //     })?;
    //     tokio::time::sleep(Duration::from_millis(poll_interval_ms)).await;
    //   }
    // The loop exits when dataglow_disconnect is called for this
    // connection_id (checked via a cancellation flag stored alongside the
    // pool in ConnectionRegistry) or the app_handle's window closes.
    // Errors mid-stream are emitted as "dataglow://stream-error" events
    // rather than failing the original invoke call, since that call already
    // returned Ok(()) once the loop was spawned.
}
```

### 3.6 `dataglow_disconnect`

```rust
#[tauri::command]
async fn dataglow_disconnect(
    connection_id: String,
    registry: tauri::State<'_, ConnectionRegistry>,
) -> Result<DisconnectResult, String> {
    // Removes and closes the pool (pool.close().await), signals any running
    // dataglow_stream loop for this connection_id to exit, removes the
    // credential lookup cache entry (not the OS keychain entry itself —
    // that persists across sessions by design, see §4).
    // Returns { disconnected: true, error: None } even if the connectionId
    // was already gone (idempotent disconnect), to keep the JS-side
    // disconnect() simple to call defensively.
}
```

### 3.7 `dataglow_list_tables` / `dataglow_describe_table`

```rust
#[tauri::command]
async fn dataglow_list_tables(
    connection_id: String,
    registry: tauri::State<'_, ConnectionRegistry>,
) -> Result<Vec<TableSchema>, String> {
    // Re-runs the same introspection queries used at connect-time (§3.3
    // step 4), so a table added after connect is picked up on demand
    // without requiring a reconnect.
}

#[tauri::command]
async fn dataglow_describe_table(
    connection_id: String,
    table_name: String,
    registry: tauri::State<'_, ConnectionRegistry>,
) -> Result<TableSchema, String> {
    // Same introspection, filtered to one table_name. Used by the Canvas
    // to lazily expand a single table's column list in the schema browser
    // rather than eagerly describing every table at connect-time.
}
```

### 3.8 Wiring into `main.rs`

```rust
tauri::Builder::default()
    .manage(ConnectionRegistry { pools: Mutex::new(HashMap::new()) })
    .invoke_handler(tauri::generate_handler![
        commands::connector::dataglow_connect,
        commands::connector::dataglow_query,
        commands::connector::dataglow_stream,
        commands::connector::dataglow_disconnect,
        commands::connector::dataglow_list_tables,
        commands::connector::dataglow_describe_table,
    ])
    .run(tauri::generate_context!())
    .expect("error while running DATAGLOW desktop shell");
```

This is the first PR to give `src-tauri/` any registered commands at all —
today it is the "stock vanilla template" described in
[desktop-shell.md](desktop-shell.md). The `tauri.conf.json` allowlist stays
`allowlist.all = false`; registering a custom command via
`invoke_handler`/`generate_handler!` does not require enabling any allowlist
API, since custom commands are a separate mechanism from the built-in
fs/shell/http allowlist entries.

## 4. Security model

- **Passwords never reach JS state.** `validateConnectorConfig` and
  `sanitizeConfig` in `tauri-connector.js` both actively strip the password
  field rather than merely omitting it from logs, and `buildConnectCall`
  never places a raw password into the object handed to `invoke()`. Even in
  a test with a malicious/buggy caller, the string sent over the Tauri IPC
  bridge for `dataglow_connect` cannot contain a password field with real
  content.
- **The Rust side resolves credentials itself.** On the initial connect, the
  Canvas prompts the user for a password once via a native dialog (or a form
  the Rust side reads directly, never round-tripping through JS), and the
  Rust command stores it in the OS-level secure credential store via the
  `keyring` crate — Keychain on macOS, Credential Manager on Windows, the
  Secret Service / libsecret on Linux. Subsequent connects for the same
  profile fetch the password from `keyring`, keyed off a profile id derived
  from `(type, host, port, database, username)`, so the user is not
  re-prompted every session.
- **Never logged.** No password value, in any form (masked or raw), is ever
  passed to `println!`/`log::info!`/`tracing` on the Rust side, nor to
  `console.log` on the JS side — `sanitizeConfig`'s `'***'` marker exists so
  a *sanitized* config is safe to log or display, but the raw value itself
  never exists as a JS variable outside the initial one-time credential
  prompt.
- **Connection strings are assembled Rust-side only**, immediately before
  the `sqlx::connect` call, and are not retained as a string anywhere after
  the pool is established (the pool object, not the DSN string, is what
  lives in `ConnectionRegistry`).

## 5. How the Canvas uses the connector

1. User opens a "Connect to database" panel and fills in a `ConnectionConfig`
   (no password typed into a JS-controlled field beyond the initial native
   credential prompt described in §4).
2. Canvas calls `connect(config, { invoke })` → on success, receives a
   `connectionId` and initial `schema: TableSchema[]`.
3. Canvas registers the connection with `registerConnection(manager,
   connectionId, config, schema)` from `connector-manager.js`, and calls
   `describeConnection(connectionId, schema, config)` to render a status
   line in the agent bar, e.g. *"Connected to analytics (postgres). 12
   tables available. Use SQL Mode (Cmd+`) to query."*
4. User opens **SQL Mode** (`Cmd+\``) and writes a query against the listed
   tables (the schema browser is populated straight from `schema`, refreshed
   on demand via `dataglow_list_tables`/`dataglow_describe_table`).
5. Canvas calls `query(connectionId, sql, params, { invoke })`, then pipes
   the result through `queryResultToGridDataset(result, datasetName)` to
   open the results as a **new grid tab** — the returned shape's
   `headers`/`rows` match what [`grid-bridge.js`](../js/grid/grid-bridge.js)'s
   `formatRowsForGrid` already produces, so the grid UI layer needs no new
   adapter code to render a live query result next to an uploaded-file tab.
6. If the user connects to a second database (e.g. a local SQLite export
   alongside the live Postgres warehouse), `connector-manager.js` tracks
   both under distinct `connectionId`s; `setActiveConnection` switches which
   one SQL Mode targets, and `listConnections`/`hasActiveConnection` drive
   the connection-picker UI.

## 6. Supported databases and sqlx versions

| Database | Driver | sqlx feature flag | Notes |
| --- | --- | --- | --- |
| PostgreSQL | native (via sqlx) | `postgres` | Any version supported by `sqlx` 0.7's Postgres driver (9.5+). |
| MySQL | native (via sqlx) | `mysql` | MySQL 5.7+ / MariaDB 10.3+. |
| SQLite | native (via sqlx) | `sqlite` | Any SQLite 3.x file; also used for read-only inspection of exported DBs. |
| DuckDB (native file) | out-of-band, not sqlx | n/a | Local `.duckdb` file, opened via the `duckdb-rs` crate or DataGlow's existing DuckDB integration — **not** the browser WASM DuckDB already used elsewhere in the app, and not an `sqlx` driver (sqlx has no DuckDB backend as of 0.7). |

Target: `sqlx = "0.7"` with `features = ["runtime-tokio-rustls", "postgres", "mysql", "sqlite", "json", "chrono"]`,
matching the dependency block in §3.1.

## 7. How live streaming works

`buildStreamCall(connectionId, sql, options)` builds the descriptor for
`dataglow_stream`, but — unlike `dataglow_query` — the `invoke()` promise for
a stream call resolves immediately once the Rust side has *spawned* the
polling loop (see §3.5); it does not carry query results back as its return
value. Results arrive as **Tauri events**:

```
[Canvas] --invoke('dataglow_stream', {...})--> [Rust: spawns tokio loop]
                                                      |
                                     every pollIntervalMs, re-runs `sql`
                                                      |
                                                      v
                              emit_all("dataglow://stream-batch", batch)
                                                      |
                                                      v
                        [Canvas: window.__TAURI__.event.listen(...)]
                                                      |
                                                      v
                    [same shape as a NATS bridge batch: rows + columns]
                                                      |
                                                      v
       hand rows to the SAME processing path js/nats/nats-bridge.js uses
       (parseNATSBatch-equivalent step is skipped since rows are already
        structured JSON) --> streaming-validator.js --> Ambient Validation Rail
```

This deliberately reuses the [NATS WebSocket Bridge](nats-bridge.md)'s
downstream shape: a `dataglow://stream-batch` event's `rows`/`columns` payload
is handed to the same `runStreamingValidation`-driven pipeline that
`nats-bridge.js`'s `processBatch` already exercises, so a live Postgres feed
and a live NATS feed end up validated by identical logic, just with two
different transports feeding it. The event-listener wiring itself (calling
`window.__TAURI__.event.listen('dataglow://stream-batch', ...)` and adapting
each payload into a `processBatch`-compatible call) is browser/Tauri glue
code that belongs to the Canvas UI layer, not to this PR's pure-logic
modules — the same split `tauri-connector.js` already draws between "build
the call descriptor" (testable, in this PR) and "actually invoke Tauri"
(browser-only, injected as a dependency).

## 8. Files in this PR

- [`js/connectors/tauri-connector.js`](../js/connectors/tauri-connector.js) — JS bridge (validate, sanitize, connect, query, stream descriptor, disconnect, grid conversion, status text)
- [`js/connectors/connector-manager.js`](../js/connectors/connector-manager.js) — multi-connection bookkeeping
- [`test/connectors/tauri-connector.test.js`](../test/connectors/tauri-connector.test.js) — bridge test suite
- [`test/connectors/connector-manager.test.js`](../test/connectors/connector-manager.test.js) — manager test suite
- `src-tauri/src/commands/connector.rs` — **not created in this PR**; §3 above is its complete spec
