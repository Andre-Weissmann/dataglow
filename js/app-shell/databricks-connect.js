// ============================================================
// DATAGLOW — Databricks Direct-Connect (proof of concept)
// ============================================================
// Lets a user pull a read-only SQL result from THEIR OWN Databricks workspace
// into DATAGLOW's local DuckDB-WASM engine, using THEIR OWN personal access
// token. The whole flow is browser -> Databricks directly (fetch); there is no
// DATAGLOW server in the middle, and the token lives only in memory for the
// current call — it is never persisted, logged, or sent anywhere but the user's
// own workspace host.
//
// This module is deliberately DOM-free and engine-free. The network client
// (`fetch`), the ingest step (`loadRows`), and the poll delay (`sleep`) are all
// injected, exactly like js/watch-folder.js injects its collaborators — so the
// request-construction, polling, parsing, and error-handling logic can be unit
// tested against mocked fetch responses with no browser and no live account.
//
// Databricks' public Statement Execution API:
//   POST {host}/api/2.0/sql/statements        -> submit a statement
//   GET  {host}/api/2.0/sql/statements/{id}   -> poll until terminal
// Response carries status.state, a manifest (column schema) and, for inline
// JSON results, result.data_array (array-of-arrays of stringified cells).

// User-facing trust statement. Kept here so the UI panel and the docs quote the
// exact same wording and can't drift apart.
export const TRUST_NOTICE =
  'Read-only, bring-your-own-credential connection. Your personal access token ' +
  'stays in this browser tab in memory only for this query — DATAGLOW never ' +
  'stores it, never writes it to disk, and never sends it anywhere except ' +
  'directly to your own Databricks workspace. Nothing is proxied through a ' +
  'DATAGLOW server, because there isn\'t one.';

export const DEFAULT_QUERY = 'SELECT * FROM samples.tpch.lineitem LIMIT 100';

// Statement lifecycle states as documented by Databricks.
export const STATES = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
  CLOSED: 'CLOSED',
});

const TERMINAL_STATES = new Set([STATES.SUCCEEDED, STATES.FAILED, STATES.CANCELED, STATES.CLOSED]);

export function isTerminalState(s) {
  return TERMINAL_STATES.has(s);
}

// ---------- error messages (single source so UI + tests agree) ----------
export const ERRORS = Object.freeze({
  MISSING_HOST: 'Enter your Databricks workspace host (e.g. https://dbc-xxxx.cloud.databricks.com).',
  MISSING_TOKEN: 'Enter a personal access token. It is used only for this query and never stored.',
  MISSING_WAREHOUSE: 'Enter the SQL warehouse ID to run the query against.',
  MISSING_STATEMENT: 'Enter a SQL query to run.',
  TIMEOUT: 'The query did not finish in time. Try a smaller query (add a LIMIT) or a warmer warehouse, then retry.',
  MALFORMED: 'Databricks returned a response DATAGLOW could not parse. The workspace may have returned an unexpected format.',
  NETWORK: 'Could not reach Databricks from the browser. This is usually a CORS restriction on your workspace, a wrong host URL, or no network. See the connector docs — cross-origin access is a Databricks-side workspace setting.',
});

// Normalize a user-typed host into a bare origin (scheme + host, no trailing
// slash, no path). Defaults to https:// when the user omits the scheme.
export function normalizeHost(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw new Error(ERRORS.MISSING_HOST);
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(ERRORS.MISSING_HOST);
  }
  if (!url.hostname) throw new Error(ERRORS.MISSING_HOST);
  return `${url.protocol}//${url.host}`;
}

export function statementsUrl(host) {
  return `${normalizeHost(host)}/api/2.0/sql/statements`;
}

export function statementUrl(host, statementId) {
  return `${normalizeHost(host)}/api/2.0/sql/statements/${encodeURIComponent(statementId)}`;
}

function authHeaders(token) {
  const t = String(token || '').trim();
  if (!t) throw new Error(ERRORS.MISSING_TOKEN);
  return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' };
}

// Build the POST that submits the statement. Requests inline JSON so the result
// comes back as result.data_array in the same payload (no external file links).
// wait_timeout + on_wait_timeout=CONTINUE means Databricks may return a finished
// result synchronously for fast queries, otherwise a PENDING/RUNNING handle we
// then poll.
export function buildExecuteRequest({ host, token, warehouseId, statement, waitTimeout = '30s' }) {
  const wh = String(warehouseId || '').trim();
  if (!wh) throw new Error(ERRORS.MISSING_WAREHOUSE);
  const sql = String(statement || '').trim();
  if (!sql) throw new Error(ERRORS.MISSING_STATEMENT);
  return {
    url: statementsUrl(host),
    init: {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        warehouse_id: wh,
        statement: sql,
        wait_timeout: waitTimeout,
        on_wait_timeout: 'CONTINUE',
        disposition: 'INLINE',
        format: 'JSON_ARRAY',
      }),
    },
  };
}

export function buildPollRequest({ host, token, statementId }) {
  if (!statementId) throw new Error(ERRORS.MALFORMED);
  return {
    url: statementUrl(host, statementId),
    init: { method: 'GET', headers: authHeaders(token) },
  };
}

// Turn an HTTP failure into a message a non-Databricks-expert can act on.
export function describeHttpError(status, bodyText = '') {
  let apiMessage = '';
  try {
    const parsed = JSON.parse(bodyText);
    apiMessage = parsed?.message || parsed?.error_code || '';
  } catch { /* body was not JSON */ }
  const suffix = apiMessage ? ` — ${apiMessage}` : '';
  if (status === 401 || status === 403) {
    return `Databricks rejected the token (HTTP ${status}). Check the personal access token and that it can reach this warehouse${suffix}.`;
  }
  if (status === 404) {
    return `Not found (HTTP 404). Check the workspace host URL and warehouse ID${suffix}.`;
  }
  if (status === 429) {
    return `Databricks is rate-limiting this token (HTTP 429). Wait a moment and retry${suffix}.`;
  }
  return `Databricks returned HTTP ${status}${suffix}.`;
}

// Message for a statement that reached a terminal state other than SUCCEEDED.
export function stateFailureMessage(state, error) {
  const detail = error?.message ? ` — ${error.message}` : '';
  if (state === STATES.FAILED) return `The query failed on Databricks${detail}.`;
  if (state === STATES.CANCELED) return `The query was canceled on Databricks${detail}.`;
  if (state === STATES.CLOSED) return `The statement was closed by Databricks before results could be read${detail}.`;
  return `The query ended in state ${state}${detail}.`;
}

// Parse a SUCCEEDED payload into { columns, rows, truncated }.
// - columns: column names from manifest.schema.columns (in position order).
// - rows: array of plain objects keyed by column name. Databricks returns cells
//   as strings (or null) in result.data_array; we pass them through and let the
//   DuckDB ingest step infer types, exactly as CSV import does.
// - truncated: true when the result spans more chunks than this POC reads (it
//   only reads the first inline chunk). Surfaced so the UI can warn the user.
export function parseResultSet(payload) {
  const columnsMeta = payload?.manifest?.schema?.columns;
  if (!Array.isArray(columnsMeta)) throw new Error(ERRORS.MALFORMED);
  const columns = columnsMeta
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map(c => c.name);

  const dataArray = payload?.result?.data_array;
  const rows = Array.isArray(dataArray)
    ? dataArray.map(cells => {
        const obj = {};
        columns.forEach((name, i) => { obj[name] = cells?.[i] ?? null; });
        return obj;
      })
    : [];

  const truncated = Boolean(payload?.result?.next_chunk_internal_link);
  return { columns, rows, truncated };
}

// Orchestrates submit -> poll -> parse -> ingest. All collaborators injected.
export class DatabricksConnector {
  constructor({ fetch, loadRows, sleep, maxPolls = 60, pollIntervalMs = 1000 } = {}) {
    if (typeof fetch !== 'function') throw new Error('DatabricksConnector requires a fetch implementation');
    if (typeof loadRows !== 'function') throw new Error('DatabricksConnector requires a loadRows callback');
    this.fetch = fetch;
    this.loadRows = loadRows;
    this.sleep = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    this.maxPolls = maxPolls;
    this.pollIntervalMs = pollIntervalMs;
  }

  async _fetchJson(url, init) {
    let res;
    try {
      res = await this.fetch(url, init);
    } catch (e) {
      // fetch() rejects on network failure AND on CORS blocks (opaque error).
      throw new Error(ERRORS.NETWORK);
    }
    if (!res.ok) {
      let bodyText = '';
      try { bodyText = await res.text(); } catch { /* ignore */ }
      throw new Error(describeHttpError(res.status, bodyText));
    }
    try {
      return await res.json();
    } catch {
      throw new Error(ERRORS.MALFORMED);
    }
  }

  // Submit and drive the statement to a terminal state. onState (optional) is
  // called with each observed lifecycle state so the UI can show progress.
  async run({ host, token, warehouseId, statement, name, onState } = {}) {
    const normHost = normalizeHost(host);
    const exec = buildExecuteRequest({ host: normHost, token, warehouseId, statement });
    let payload = await this._fetchJson(exec.url, exec.init);

    let currentState = payload?.status?.state;
    const statementId = payload?.statement_id;
    if (!currentState || (!isTerminalState(currentState) && !statementId)) {
      throw new Error(ERRORS.MALFORMED);
    }
    if (onState) onState(currentState);

    let attempts = 0;
    while (!isTerminalState(currentState)) {
      if (attempts >= this.maxPolls) throw new Error(ERRORS.TIMEOUT);
      attempts++;
      await this.sleep(this.pollIntervalMs);
      const poll = buildPollRequest({ host: normHost, token, statementId });
      payload = await this._fetchJson(poll.url, poll.init);
      currentState = payload?.status?.state;
      if (!currentState) throw new Error(ERRORS.MALFORMED);
      if (onState) onState(currentState);
    }

    if (currentState !== STATES.SUCCEEDED) {
      throw new Error(stateFailureMessage(currentState, payload?.status?.error));
    }

    const { columns, rows, truncated } = parseResultSet(payload);
    if (columns.length === 0) throw new Error(ERRORS.MALFORMED);

    const dataset = await this.loadRows({
      name: name || 'databricks_query',
      columns,
      rows,
      source: 'Databricks',
      meta: { statementId, truncated },
    });

    return { dataset, columns, rowCount: rows.length, truncated, statementId };
  }
}
