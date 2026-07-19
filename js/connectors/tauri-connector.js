// ============================================================
// DATAGLOW — Tauri Live Connector Layer: JS bridge
// ============================================================
// This module is the JS-side interface contract between DataGlow's browser
// Canvas and the Tauri desktop shell's native database connectors
// (Postgres, MySQL, SQLite, and local DuckDB files). It is PURE LOGIC: there
// is no `import { invoke } from '@tauri-apps/api/tauri'` anywhere in this
// file. Every function that needs to actually call into the Rust backend
// takes an injected `invoke` function via a `deps` argument, the same
// dependency-injection pattern used by js/nats/nats-bridge.js for the
// streaming validator. That is what makes this file trivially testable in
// plain Node (see test/connectors/tauri-connector.test.js) with zero Tauri
// runtime, zero native drivers, and zero real database.
//
// Why this needs Tauri at all (and can't just run in the browser):
//   • Native DB drivers (libpq, mysqlclient, SQLite's C library) are not
//     available to browser JS. There is no way to open a raw TCP socket to
//     a Postgres server from a <script> tag.
//   • Even if a WASM Postgres client existed, corporate/DBA firewalls and
//     CORS policies block browser-origin connections to internal database
//     hosts by design — a desktop process with a native TCP stack does not
//     hit either wall.
//   • Credentials for a live production database must never sit in a
//     browser tab's memory or localStorage. Tauri's secure OS-level
//     credential store (see docs/tauri-connector.md §4) keeps passwords out
//     of JS entirely; this file is written so a password is never even
//     constructed as a JS value about to be sent to invoke() (see
//     buildConnectCall below).
//
// Architecture at a glance (see docs/tauri-connector.md for the full spec):
//
//   [Canvas UI] --config--> [tauri-connector.js] --invoke(command, args)-->
//     [Tauri IPC bridge] --> [src-tauri/src/commands/connector.rs] --sqlx-->
//     [Postgres / MySQL / SQLite]
//   results flow back: QueryResult --> queryResultToGridDataset() -->
//     [grid-bridge.js GridDataset] --> Univer grid tab
//
// Nothing in this file imports js/grid/grid-bridge.js — queryResultToGridDataset
// returns a plain object shaped to match GridDataset's rows/headers contract
// so the UI layer can hand it straight to the grid without another adapter.
// ============================================================

// ------------------------------------------------------------
// Supported database types
// ------------------------------------------------------------

const DB_TYPES = {
  POSTGRES: 'postgres',
  MYSQL: 'mysql',
  SQLITE: 'sqlite',
  DUCKDB_NATIVE: 'duckdb_native', // local DuckDB file, not WASM
};

const VALID_DB_TYPES = new Set(Object.values(DB_TYPES));

// Database types that require a network host (as opposed to a local file path).
const HOST_REQUIRED_TYPES = new Set([DB_TYPES.POSTGRES, DB_TYPES.MYSQL]);

const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_QUERY_TIMEOUT_MS = 30000;
const DEFAULT_STREAM_BATCH_SIZE = 1000;
const DEFAULT_STREAM_POLL_INTERVAL_MS = 5000;

// ------------------------------------------------------------
// List of Tauri commands this bridge expects the Rust backend to implement.
// See docs/tauri-connector.md §2-3 for the full request/response contract
// and the Rust implementation spec for each command.
// ------------------------------------------------------------

const TAURI_COMMANDS = [
  'dataglow_connect',
  'dataglow_query',
  'dataglow_stream',
  'dataglow_disconnect',
  'dataglow_list_tables',
  'dataglow_describe_table',
];

// ------------------------------------------------------------
// validateConnectorConfig
// ------------------------------------------------------------

/**
 * Validates a connection config object with no network access — a pure
 * shape/range check so the Canvas can surface errors before ever calling
 * into Tauri.
 *
 * Checks performed:
 *   - `type` is one of DB_TYPES
 *   - `host` is required (non-empty) for postgres/mysql
 *   - `database` is required (non-empty) for all types (database name, or
 *     file path for sqlite/duckdb_native)
 *   - `port`, if provided, is an integer in [1, 65535]
 *   - the returned config never carries a `password` field, even if the
 *     input had one (stripped, not just masked, to keep this function's
 *     output safe to log)
 *
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateConnectorConfig(config) {
  const errors = [];
  const cfg = config && typeof config === 'object' ? config : {};

  if (!VALID_DB_TYPES.has(cfg.type)) {
    errors.push(`type must be one of ${Array.from(VALID_DB_TYPES).join(', ')}, got: ${JSON.stringify(cfg.type)}`);
  }

  if (HOST_REQUIRED_TYPES.has(cfg.type)) {
    if (typeof cfg.host !== 'string' || cfg.host.trim() === '') {
      errors.push(`host is required for type "${cfg.type}"`);
    }
  }

  if (typeof cfg.database !== 'string' || cfg.database.trim() === '') {
    errors.push('database is required (database name, or file path for sqlite/duckdb_native)');
  }

  if (cfg.port !== undefined && cfg.port !== null) {
    const port = Number(cfg.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`port must be an integer between 1 and 65535, got: ${JSON.stringify(cfg.port)}`);
    }
  }

  if (cfg.connectionTimeout !== undefined && (!Number.isFinite(Number(cfg.connectionTimeout)) || Number(cfg.connectionTimeout) <= 0)) {
    errors.push('connectionTimeout must be a positive number of ms if provided');
  }

  if (cfg.queryTimeout !== undefined && (!Number.isFinite(Number(cfg.queryTimeout)) || Number(cfg.queryTimeout) <= 0)) {
    errors.push('queryTimeout must be a positive number of ms if provided');
  }

  return { valid: errors.length === 0, errors };
}

// ------------------------------------------------------------
// sanitizeConfig
// ------------------------------------------------------------

/**
 * Builds a sanitized copy of a connection config safe for display, logging,
 * or storage in the connector manager. The password is never returned in
 * any form (not masked-with-length, just replaced with a fixed '***'), and
 * the username is partially masked (first char + '***' + last char, or
 * '***' outright if 2 chars or fewer) so an on-screen connection list can
 * show "which login" without fully exposing it.
 *
 * @param {object} config
 * @returns {object} sanitized config (never contains the raw password)
 */
function sanitizeConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const sanitized = {
    type: cfg.type,
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    ssl: cfg.ssl,
    connectionTimeout: cfg.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    queryTimeout: cfg.queryTimeout ?? DEFAULT_QUERY_TIMEOUT_MS,
  };

  if (typeof cfg.username === 'string' && cfg.username.length > 0) {
    sanitized.username = maskUsername(cfg.username);
  } else {
    sanitized.username = cfg.username;
  }

  // Password is NEVER copied through, in any form.
  sanitized.password = cfg.password !== undefined ? '***' : undefined;

  // Drop undefined keys for a cleaner display/log object, but keep the
  // explicit password marker if a password had been supplied.
  const out = {};
  for (const [k, v] of Object.entries(sanitized)) {
    if (v !== undefined) out[k] = v;
  }
  if (cfg.password !== undefined) out.password = '***';

  return out;
}

function maskUsername(username) {
  if (username.length <= 2) return '***';
  return `${username[0]}***${username[username.length - 1]}`;
}

// ------------------------------------------------------------
// buildConnectCall
// ------------------------------------------------------------

/**
 * Builds the Tauri invoke call descriptor for connecting. The password is
 * deliberately NOT included in the args passed to invoke() — Tauri handles
 * credential resolution on the Rust side via its secure store (see
 * docs/tauri-connector.md §4), keyed by a connection profile id the caller
 * is expected to have already persisted there. This function's contract is
 * simply: nothing that comes out of this function ever contains a password.
 *
 * @param {object} config
 * @returns {{ command: string, args: { config: object } }}
 */
function buildConnectCall(config) {
  return {
    command: 'dataglow_connect',
    args: { config: sanitizeConfig(config) },
  };
}

// ------------------------------------------------------------
// connect
// ------------------------------------------------------------

/**
 * Executes a connect via the injected invoke function.
 *
 * @param {object} config
 * @param {{ invoke?: Function }} deps
 * @returns {Promise<{ connected: boolean, connectionId: string, schema: Array, error: string|null }>}
 */
async function connect(config, deps = {}) {
  const { invoke } = deps;
  const validation = validateConnectorConfig(config);
  if (!validation.valid) {
    return {
      connected: false,
      connectionId: null,
      schema: [],
      error: `Invalid connector config: ${validation.errors.join('; ')}`,
    };
  }

  if (typeof invoke !== 'function') {
    return {
      connected: false,
      connectionId: null,
      schema: [],
      error: 'No invoke function provided (deps.invoke is required to reach the Tauri backend)',
    };
  }

  const call = buildConnectCall(config);
  try {
    const result = await invoke(call.command, call.args);
    return {
      connected: Boolean(result && result.connected),
      connectionId: (result && result.connectionId) || null,
      schema: Array.isArray(result && result.schema) ? result.schema : [],
      error: (result && result.error) || null,
    };
  } catch (err) {
    return {
      connected: false,
      connectionId: null,
      schema: [],
      error: err && err.message ? err.message : String(err),
    };
  }
}

// ------------------------------------------------------------
// buildQueryCall
// ------------------------------------------------------------

/**
 * Builds the Tauri invoke call descriptor for a query.
 *
 * @param {string} connectionId
 * @param {string} sql
 * @param {Array} [params]
 * @returns {{ command: string, args: { connectionId: string, sql: string, params: Array } }}
 */
function buildQueryCall(connectionId, sql, params = []) {
  return {
    command: 'dataglow_query',
    args: { connectionId, sql, params: Array.isArray(params) ? params : [] },
  };
}

// ------------------------------------------------------------
// query
// ------------------------------------------------------------

/**
 * Executes a query via the injected invoke function.
 *
 * @param {string} connectionId
 * @param {string} sql
 * @param {Array} [params]
 * @param {{ invoke?: Function }} deps
 * @returns {Promise<{ rows: object[], columns: string[], rowCount: number, durationMs: number, error: string|null }>}
 */
async function query(connectionId, sql, params = [], deps = {}) {
  const { invoke } = deps;

  if (typeof invoke !== 'function') {
    return { rows: [], columns: [], rowCount: 0, durationMs: 0, error: 'No invoke function provided (deps.invoke is required to reach the Tauri backend)' };
  }

  const call = buildQueryCall(connectionId, sql, params);
  const startedAt = Date.now();
  try {
    const result = await invoke(call.command, call.args);
    const rows = Array.isArray(result && result.rows) ? result.rows : [];
    const columns = Array.isArray(result && result.columns)
      ? result.columns
      : (rows.length > 0 ? Object.keys(rows[0]) : []);
    return {
      rows,
      columns,
      rowCount: typeof (result && result.rowCount) === 'number' ? result.rowCount : rows.length,
      durationMs: typeof (result && result.durationMs) === 'number' ? result.durationMs : (Date.now() - startedAt),
      error: (result && result.error) || null,
    };
  } catch (err) {
    return {
      rows: [],
      columns: [],
      rowCount: 0,
      durationMs: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err),
    };
  }
}

// ------------------------------------------------------------
// buildStreamCall
// ------------------------------------------------------------

/**
 * Builds the Tauri invoke call descriptor for a streaming query (live data
 * feed). The Rust side is expected to emit Tauri events per batch rather
 * than resolving the invoke promise with data — see
 * docs/tauri-connector.md §7 for how those events reach the NATS bridge.
 *
 * @param {string} connectionId
 * @param {string} sql
 * @param {{ batchSize?: number, pollIntervalMs?: number }} [options]
 * @returns {{ command: string, args: { connectionId: string, sql: string, batchSize: number, pollIntervalMs: number } }}
 */
function buildStreamCall(connectionId, sql, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  return {
    command: 'dataglow_stream',
    args: {
      connectionId,
      sql,
      batchSize: opts.batchSize ?? DEFAULT_STREAM_BATCH_SIZE,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_STREAM_POLL_INTERVAL_MS,
    },
  };
}

// ------------------------------------------------------------
// disconnect
// ------------------------------------------------------------

/**
 * Disconnects a connection via the injected invoke function.
 *
 * @param {string} connectionId
 * @param {{ invoke?: Function }} deps
 * @returns {Promise<{ disconnected: boolean, error: string|null }>}
 */
async function disconnect(connectionId, deps = {}) {
  const { invoke } = deps;

  if (typeof invoke !== 'function') {
    return { disconnected: false, error: 'No invoke function provided (deps.invoke is required to reach the Tauri backend)' };
  }

  try {
    const result = await invoke('dataglow_disconnect', { connectionId });
    return {
      disconnected: Boolean(result && result.disconnected),
      error: (result && result.error) || null,
    };
  } catch (err) {
    return { disconnected: false, error: err && err.message ? err.message : String(err) };
  }
}

// ------------------------------------------------------------
// queryResultToGridDataset
// ------------------------------------------------------------

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const BOOLEAN_VALUES = new Set([true, false]);

/**
 * Detects a simple display type for a column from sampled cell values.
 * @param {Array} values - sample values from the column (may include null/undefined)
 * @returns {'numeric'|'date'|'boolean'|'text'}
 */
function detectColumnType(values) {
  const sample = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (sample.length === 0) return 'text';

  if (sample.every((v) => typeof v === 'boolean' || BOOLEAN_VALUES.has(v))) return 'boolean';
  if (sample.every((v) => typeof v === 'number' || (typeof v === 'string' && NUMERIC_RE.test(v.trim())))) return 'numeric';
  if (sample.every((v) => (v instanceof Date) || (typeof v === 'string' && DATE_RE.test(v.trim())))) return 'date';
  return 'text';
}

/**
 * Converts a Tauri query result into a GridDataset compatible with the shape
 * produced by js/grid/grid-bridge.js's formatRowsForGrid (headers/rows with
 * per-cell value + displayValue), so the UI layer can pipe live query
 * results straight into a new grid tab.
 *
 * @param {{ rows: object[], columns: string[] }} queryResult
 * @param {string} datasetName
 * @returns {{ datasetName: string, headers: Array, rows: Array, totalRows: number, totalColumns: number }}
 */
function queryResultToGridDataset(queryResult, datasetName) {
  const rows = Array.isArray(queryResult && queryResult.rows) ? queryResult.rows : [];
  const columns = Array.isArray(queryResult && queryResult.columns)
    ? queryResult.columns
    : (rows.length > 0 ? Object.keys(rows[0]) : []);

  const headers = columns.map((name) => {
    const values = rows.map((r) => (r ? r[name] : undefined));
    return { name, type: detectColumnType(values) };
  });

  const outRows = rows.map((row, index) => {
    const cells = {};
    for (const col of columns) {
      const value = row == null ? undefined : row[col];
      cells[col] = { value, displayValue: value == null ? '' : String(value) };
    }
    return { index, cells };
  });

  return {
    datasetName: datasetName || 'live_query_result',
    headers,
    rows: outRows,
    totalRows: outRows.length,
    totalColumns: headers.length,
  };
}

// ------------------------------------------------------------
// describeConnection
// ------------------------------------------------------------

/**
 * Builds a plain-text connection status summary for the agent bar.
 *
 * Accepts an optional third `config` argument (sanitized or raw — password
 * is never read) so the message can name the database and driver type, e.g.
 * "Connected to analytics (postgres). 12 tables available. Use SQL Mode
 * (Cmd+`) to query." When no config is supplied (or it lacks a `database`),
 * falls back to a generic message keyed only off connectionId, so callers
 * that only have a bare connectionId + schema still get a usable string.
 *
 * @param {string} connectionId
 * @param {Array<{tableName:string}>} schema
 * @param {{ database?: string, type?: string }} [config]
 * @returns {string}
 */
function describeConnection(connectionId, schema, config) {
  const tables = Array.isArray(schema) ? schema : [];
  const tableClause = `${tables.length} table${tables.length === 1 ? '' : 's'} available. Use SQL Mode (Cmd+\`) to query.`;

  if (config && typeof config === 'object' && config.database) {
    const typeLabel = config.type ? ` (${config.type})` : '';
    return `Connected to ${config.database}${typeLabel}. ${tableClause}`;
  }

  return `Connected (${connectionId || 'unknown connection'}). ${tableClause}`;
}

export {
  DB_TYPES,
  TAURI_COMMANDS,
  validateConnectorConfig,
  sanitizeConfig,
  buildConnectCall,
  connect,
  buildQueryCall,
  query,
  buildStreamCall,
  disconnect,
  queryResultToGridDataset,
  describeConnection,
  detectColumnType,
};
