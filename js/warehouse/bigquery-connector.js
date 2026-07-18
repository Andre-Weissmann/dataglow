// ============================================================
// DATAGLOW — BigQuery Warehouse Connector (Phase 5)
// ============================================================
// Connects directly from the browser to BigQuery via OAuth 2.0
// (PKCE / implicit flow) and the BigQuery REST API.
//
// WHY THIS WORKS WITHOUT A PROXY:
// Google APIs (bigquery.googleapis.com) are CORS-friendly by design.
// We never need a server in the middle — just an OAuth access token
// and a direct fetch to the BigQuery Jobs API.
//
// AUTH FLOW:
//   1. User provides their Google Cloud OAuth Client ID (registered in
//      Google Cloud Console, with this page's origin as an allowed JS origin).
//   2. DataGlow opens a small OAuth popup (implicit/token flow — no auth code,
//      no server-side exchange needed).
//   3. The popup returns an access token via postMessage / URL fragment.
//   4. We use that token to call the BigQuery Jobs: query endpoint.
//   5. Token lives in memory only — never stored to localStorage/disk.
//
// QUERY EXECUTION:
//   Uses the BigQuery Jobs: query REST endpoint (synchronous, for queries
//   that complete within the timeout) and falls back to async job polling
//   for larger queries. Results are fetched in pages and ingested into
//   DuckDB-WASM via loadRows.
//
// SECURITY NOTE:
//   - Never ask users to paste service account JSON keys. OAuth only.
//   - Access tokens are short-lived (1 hour) and in-memory only.
//   - The OAuth Client ID is not a secret and is safe to embed in client JS.

// ---- Public trust statement --------------------------------------------------
export const TRUST_NOTICE =
  'DataGlow connects directly to BigQuery using your Google account. ' +
  'Your access token stays in this browser tab in memory only — never ' +
  'stored to disk. DataGlow never sees your Google password. Nothing is ' +
  'proxied through a DataGlow server.';

// ---- BigQuery API constants --------------------------------------------------
const BQ_API_BASE    = 'https://bigquery.googleapis.com/bigquery/v2';
const BQ_SCOPE       = 'https://www.googleapis.com/auth/bigquery.readonly';
const OAUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

// ---- Error messages ----------------------------------------------------------
export const ERRORS = Object.freeze({
  MISSING_CLIENT_ID: 'Enter your Google Cloud OAuth Client ID.',
  MISSING_PROJECT:   'Enter your Google Cloud project ID.',
  MISSING_QUERY:     'Enter a BigQuery SQL query to run.',
  AUTH_CANCELLED:    'Google sign-in was cancelled or the popup was blocked. Allow popups for this page.',
  AUTH_FAILED:       'Google OAuth failed. Check your Client ID and that this page origin is listed as an allowed JavaScript origin in Google Cloud Console.',
  QUERY_FAILED:      'BigQuery query failed.',
  NETWORK:           'Network error reaching BigQuery. Check your internet connection.',
  NO_ROWS:           'Query returned 0 rows.',
  QUOTA_EXCEEDED:    'BigQuery quota exceeded. Try a smaller query (add a LIMIT).',
  PERMISSION_DENIED: 'Permission denied. Make sure your Google account has BigQuery Data Viewer access to this project.',
  NOT_FOUND:         'Table or dataset not found. Check your project ID and query.',
});

// ---- BigQuery type -> DuckDB type map ----------------------------------------
const BQ_TO_DUCK_TYPE = {
  STRING:    'VARCHAR',
  BYTES:     'VARCHAR',
  INTEGER:   'BIGINT',
  INT64:     'BIGINT',
  FLOAT:     'DOUBLE',
  FLOAT64:   'DOUBLE',
  NUMERIC:   'DOUBLE',
  BIGNUMERIC:'VARCHAR',
  BOOLEAN:   'BOOLEAN',
  BOOL:      'BOOLEAN',
  TIMESTAMP: 'TIMESTAMP',
  DATE:      'DATE',
  TIME:      'VARCHAR',
  DATETIME:  'TIMESTAMP',
  GEOGRAPHY: 'VARCHAR',
  JSON:      'VARCHAR',
  RECORD:    'VARCHAR',
  STRUCT:    'VARCHAR',
};

function bqToDuckType(bqType) {
  return BQ_TO_DUCK_TYPE[(bqType || '').toUpperCase()] || 'VARCHAR';
}

// ---- OAuth helpers -----------------------------------------------------------

/**
 * Open a Google OAuth popup (implicit/token flow) and return the access token.
 * Rejects if the user cancels, the popup is blocked, or auth fails.
 *
 * @param {object} opts
 * @param {string} opts.clientId      - OAuth Client ID
 * @param {string} opts.redirectUri   - must match a registered JS origin
 * @param {function} [opts.openWindow] - injected for tests
 * @returns {Promise<string>} access token
 */
export function requestOAuthToken({ clientId, redirectUri, openWindow }) {
  return new Promise((resolve, reject) => {
    const state = Math.random().toString(36).slice(2);
    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  redirectUri,
      response_type: 'token',
      scope:         BQ_SCOPE,
      state,
      prompt:        'consent',
    });
    const authUrl = OAUTH_ENDPOINT + '?' + params.toString();

    const opener = openWindow || ((url) => window.open(url, 'gauth', 'width=520,height=600,left=200,top=100'));
    const popup = opener(authUrl);

    if (!popup) {
      reject(new Error(ERRORS.AUTH_CANCELLED));
      return;
    }

    // Poll for the popup to close or return token via URL fragment.
    let done = false;
    const interval = setInterval(() => {
      try {
        if (!popup || popup.closed) {
          clearInterval(interval);
          if (!done) reject(new Error(ERRORS.AUTH_CANCELLED));
          return;
        }
        const href = popup.location.href;
        if (href && (href.includes('access_token=') || href.includes('error='))) {
          clearInterval(interval);
          done = true;
          popup.close();
          const fragment = href.split('#')[1] || href.split('?')[1] || '';
          const p = new URLSearchParams(fragment);
          if (p.get('error')) {
            reject(new Error(ERRORS.AUTH_FAILED + ' (' + p.get('error') + ')'));
          } else {
            const token = p.get('access_token');
            if (token) resolve(token);
            else reject(new Error(ERRORS.AUTH_FAILED));
          }
        }
      } catch (_) {
        // Cross-origin access to popup.location throws until it redirects back.
      }
    }, 300);
  });
}

// ---- Main connector ----------------------------------------------------------

/**
 * BigQueryConnector — orchestrates OAuth + BigQuery Jobs API + row ingestion.
 *
 * @param {object} opts
 * @param {function} opts.loadRows     - ({ rows, cols, name }) => Promise<ds>
 * @param {function} [opts.fetch]      - injected fetch
 * @param {function} [opts.openWindow] - injected OAuth popup opener
 */
export class BigQueryConnector {
  constructor({ loadRows, fetch: fetchFn, openWindow } = {}) {
    if (!loadRows) throw new Error('BigQueryConnector: loadRows is required');
    this._loadRows  = loadRows;
    this._fetch     = fetchFn || ((...args) => globalThis.fetch(...args));
    this._openWindow = openWindow || null;
    this._token     = null; // cached in-memory for session
  }

  /** Validate inputs before connecting. Returns error string or null. */
  validate({ clientId, projectId, query }) {
    if (!clientId || !clientId.trim()) return ERRORS.MISSING_CLIENT_ID;
    if (!projectId || !projectId.trim()) return ERRORS.MISSING_PROJECT;
    if (!query || !query.trim()) return ERRORS.MISSING_QUERY;
    return null;
  }

  /** Return the current cached token (for tests). */
  get token() { return this._token; }

  /** Set a token directly (for tests that skip OAuth). */
  setToken(t) { this._token = t; }

  /** Clear the cached token (sign out). */
  clearToken() { this._token = null; }

  /**
   * Run a BigQuery query and ingest results into DataGlow.
   *
   * @param {object} params
   * @param {string} params.clientId       - OAuth Client ID
   * @param {string} params.projectId      - GCP project ID
   * @param {string} params.query          - BigQuery SQL
   * @param {string} [params.location]     - BQ dataset location (e.g. US, EU)
   * @param {number} [params.maxResults]   - max rows (default 100000)
   * @param {number} [params.timeoutMs]    - sync query timeout ms (default 30000)
   * @param {function} [params.onStatus]   - (msg: string) => void
   * @returns {Promise<object>} dataset
   */
  async connect({ clientId, projectId, query, location = 'US', maxResults = 100000, timeoutMs = 30000, onStatus = () => {} }) {
    const err = this.validate({ clientId, projectId, query });
    if (err) throw new Error(err);

    // Step 1: Get access token (reuse cached if present).
    if (!this._token) {
      onStatus('Opening Google sign-in...');
      const redirectUri = typeof window !== 'undefined'
        ? window.location.origin + window.location.pathname
        : 'http://localhost';
      this._token = await requestOAuthToken({
        clientId: clientId.trim(),
        redirectUri,
        openWindow: this._openWindow,
      });
    }

    onStatus('Running BigQuery query...');

    // Step 2: Try synchronous query first (Jobs: query endpoint).
    const queryResult = await this._runQuerySync({
      projectId: projectId.trim(),
      query: query.trim(),
      location,
      maxResults,
      timeoutMs,
    });

    // Step 3: If the job didn't complete synchronously, poll for results.
    let schema, rows;
    if (queryResult.jobComplete) {
      schema = queryResult.schema;
      rows   = queryResult.rows || [];
      // Page through remaining rows if needed.
      if (queryResult.pageToken) {
        onStatus('Fetching additional rows...');
        const more = await this._fetchAllPages(projectId.trim(), queryResult.jobReference.jobId, queryResult.pageToken, maxResults - rows.length);
        rows = rows.concat(more);
      }
    } else {
      onStatus('Waiting for BigQuery job to complete...');
      const jobResult = await this._pollJob(projectId.trim(), queryResult.jobReference.jobId, maxResults, onStatus);
      schema = jobResult.schema;
      rows   = jobResult.rows;
    }

    if (!schema || !schema.fields) throw new Error(ERRORS.QUERY_FAILED + ' No schema returned.');
    if (!rows || rows.length === 0) throw new Error(ERRORS.NO_ROWS);

    // Step 4: Convert BigQuery row format to plain JS objects.
    onStatus('Converting ' + rows.length.toLocaleString() + ' rows...');
    const cols = schema.fields.map(f => ({ name: f.name, type: bqToDuckType(f.type) }));
    const plainRows = convertRows(rows, schema.fields);

    // Step 5: Ingest into DataGlow.
    onStatus('Importing into DataGlow...');
    const ds = await this._loadRows({
      rows: plainRows,
      cols,
      name: 'bigquery_query (BigQuery)',
      source: 'bigquery',
      sourceProject: projectId.trim(),
    });

    onStatus('');
    return ds;
  }

  // ---- private: BigQuery API calls ------------------------------------------

  async _runQuerySync({ projectId, query, location, maxResults, timeoutMs }) {
    const url = BQ_API_BASE + '/projects/' + encodeURIComponent(projectId) + '/queries';
    const body = JSON.stringify({
      query,
      useLegacySql: false,
      location,
      maxResults,
      timeoutMs,
    });
    const res = await this._apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return res;
  }

  async _pollJob(projectId, jobId, maxResults, onStatus) {
    const url = BQ_API_BASE + '/projects/' + encodeURIComponent(projectId) +
      '/queries/' + encodeURIComponent(jobId) + '?maxResults=' + maxResults;
    let attempts = 0;
    while (attempts < 60) {
      await new Promise(r => setTimeout(r, 2000));
      const res = await this._apiFetch(url, { method: 'GET' });
      if (res.jobComplete) {
        let rows = res.rows || [];
        if (res.pageToken) {
          const more = await this._fetchAllPages(projectId, jobId, res.pageToken, maxResults - rows.length);
          rows = rows.concat(more);
        }
        return { schema: res.schema, rows };
      }
      attempts++;
      onStatus('Waiting for BigQuery... (' + (attempts * 2) + 's)');
    }
    throw new Error('BigQuery job timed out after 120 seconds. Try adding a LIMIT to your query.');
  }

  async _fetchAllPages(projectId, jobId, pageToken, remaining) {
    const rows = [];
    let token = pageToken;
    while (token && remaining > 0) {
      const limit = Math.min(remaining, 50000);
      const url = BQ_API_BASE + '/projects/' + encodeURIComponent(projectId) +
        '/queries/' + encodeURIComponent(jobId) +
        '?pageToken=' + encodeURIComponent(token) + '&maxResults=' + limit;
      const res = await this._apiFetch(url, { method: 'GET' });
      if (res.rows) {
        rows.push(...res.rows);
        remaining -= res.rows.length;
      }
      token = res.pageToken || null;
    }
    return rows;
  }

  async _apiFetch(url, opts = {}) {
    let res;
    try {
      res = await this._fetch(url, {
        ...opts,
        headers: {
          ...(opts.headers || {}),
          'Authorization': 'Bearer ' + this._token,
        },
      });
    } catch (e) {
      throw new Error(ERRORS.NETWORK + ' ' + (e && e.message ? e.message : ''));
    }

    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      const reason = errorBody && errorBody.error && errorBody.error.message
        ? errorBody.error.message : res.statusText;
      if (res.status === 401 || res.status === 403) {
        // Token expired — clear it so next call triggers re-auth.
        this._token = null;
        if (reason.toLowerCase().includes('permission')) throw new Error(ERRORS.PERMISSION_DENIED);
        throw new Error(ERRORS.AUTH_FAILED + ': ' + reason);
      }
      if (res.status === 404) throw new Error(ERRORS.NOT_FOUND + ' ' + reason);
      if (res.status === 429) throw new Error(ERRORS.QUOTA_EXCEEDED);
      throw new Error(ERRORS.QUERY_FAILED + ': ' + reason);
    }

    return res.json();
  }
}

// ---- helpers -----------------------------------------------------------------

/**
 * Convert BigQuery's { f: [{v: ...}] } row format to plain JS objects.
 */
function convertRows(bqRows, fields) {
  return bqRows.map(row => {
    const obj = {};
    (row.f || []).forEach((cell, i) => {
      const field = fields[i];
      if (!field) return;
      obj[field.name] = convertCell(cell.v, field.type);
    });
    return obj;
  });
}

function convertCell(v, type) {
  if (v === null || v === undefined) return null;
  const t = (type || '').toUpperCase();
  if (t === 'INTEGER' || t === 'INT64') return v !== null ? parseInt(String(v), 10) : null;
  if (t === 'FLOAT' || t === 'FLOAT64' || t === 'NUMERIC') return v !== null ? parseFloat(String(v)) : null;
  if (t === 'BOOLEAN' || t === 'BOOL') {
    const s = String(v).toLowerCase();
    return s === 'true' || s === '1'; // BigQuery returns 'true'/'false' or '1'/'0'
  }
  if (t === 'RECORD' || t === 'STRUCT') return JSON.stringify(v);
  return String(v);
}
