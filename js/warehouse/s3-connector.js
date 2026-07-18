// ============================================================
// DATAGLOW — S3 / Parquet Warehouse Connector (Phase 5)
// ============================================================
// Lets a user query S3 Parquet (or CSV/JSON) files directly from
// DuckDB-WASM in the browser. Two credential paths:
//
//   1. Pre-signed URL  — safest, no credentials in the browser at all.
//      The URL already contains a time-limited signature. Just pass it
//      straight to DuckDB and read_parquet() does the rest.
//
//   2. Manual IAM credentials — for buckets where the user controls the
//      key. Calls CREATE SECRET in DuckDB-WASM so the credentials live
//      only in the in-memory DuckDB instance for this session. The aws
//      extension's automatic credential-chain discovery does NOT work in
//      WASM (no OS-level access); this path requires explicit key + secret.
//
// CORS REQUIREMENT: The S3 bucket must have a CORS policy that permits
// the DataGlow origin (or * for public buckets). This is the #1 failure
// mode. We detect and explain CORS errors rather than surfacing a raw
// network error.
//
// This module is DOM-free and engine-free. All network calls, DuckDB
// queries, and sleep are injected — exactly like databricks-connect.js.
// This makes the connector unit-testable with no browser and no live S3.
//
// SECURITY NOTE: We never store credentials in localStorage, sessionStorage,
// or any persistent browser store. Credentials exist only in memory for the
// duration of the session and are cleared when the tab is closed.

// ---- Public trust statement (shown in the UI) --------------------------------
export const TRUST_NOTICE =
  'Your S3 credentials stay in this browser tab in memory only. DataGlow ' +
  'never stores them, never writes them to disk, and never sends them anywhere ' +
  'except directly to AWS S3. Nothing is proxied through a DataGlow server.';

export const CORS_HELP =
  'CORS error: your S3 bucket must allow requests from this origin. ' +
  'Add a CORS rule in the S3 console: AllowedOrigin=* (or this page origin), ' +
  'AllowedMethod=GET, AllowedHeader=*. Pre-signed URLs are the easiest workaround ' +
  'for buckets you cannot reconfigure.';

// ---- Connector modes ---------------------------------------------------------
export const MODES = Object.freeze({
  PRESIGNED: 'presigned',   // Pre-signed URL — no credentials needed
  IAM:       'iam',         // Explicit AWS key_id + secret
});

// ---- Error messages (single source so UI + tests agree) ----------------------
export const ERRORS = Object.freeze({
  MISSING_URL:    'Enter an S3 URL or pre-signed URL to query.',
  MISSING_KEY_ID: 'Enter your AWS Access Key ID.',
  MISSING_SECRET: 'Enter your AWS Secret Access Key.',
  MISSING_REGION: 'Enter your AWS region (e.g. us-east-1).',
  INVALID_URL:    'URL must start with s3://, https://, or be a pre-signed URL.',
  CORS_BLOCKED:   CORS_HELP,
  NETWORK:        'Network error reaching S3. Check your URL and bucket CORS policy.',
  QUERY_FAILED:   'DuckDB could not read this file. Check the URL, file format, and credentials.',
  UNSUPPORTED_FORMAT: 'Only Parquet, CSV, JSON, and NDJSON files are supported via S3.',
});

// ---- Supported file extensions -----------------------------------------------
const SUPPORTED_EXTS = new Set(['parquet', 'csv', 'tsv', 'json', 'ndjson', 'gz']);

// ---- Main connector ----------------------------------------------------------

/**
 * S3Connector — orchestrates credential setup + DuckDB query for S3 sources.
 *
 * @param {object} opts
 * @param {function} opts.runQuery  - (sql: string) => Promise<{rows, schema}> — injected DuckDB runner
 * @param {function} opts.loadRows  - ({ rows, cols, name }) => Promise<ds>    — injected ingestor
 * @param {function} [opts.sleep]   - (ms: number) => Promise<void>             — injected sleep (for tests)
 * @param {function} [opts.fetch]   - injected fetch (for tests)
 */
export class S3Connector {
  constructor({ runQuery, loadRows, sleep, fetch: fetchFn } = {}) {
    if (!runQuery) throw new Error('S3Connector: runQuery is required');
    if (!loadRows) throw new Error('S3Connector: loadRows is required');
    this._runQuery = runQuery;
    this._loadRows = loadRows;
    this._sleep = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    this._fetch = fetchFn || ((...args) => globalThis.fetch(...args));
  }

  /**
   * Validate inputs before running.
   * @param {object} params
   * @returns {string|null} error message or null if valid
   */
  validate({ mode, url, keyId, secret, region }) {
    if (!url || !url.trim()) return ERRORS.MISSING_URL;
    const trimmed = url.trim();
    if (mode === MODES.PRESIGNED) {
      // Pre-signed URLs can be https:// (AWS standard) or s3:// (less common)
      if (!trimmed.startsWith('https://') && !trimmed.startsWith('s3://') && !trimmed.startsWith('http://')) {
        return ERRORS.INVALID_URL;
      }
    } else {
      // IAM mode
      if (!trimmed.startsWith('s3://')) return ERRORS.INVALID_URL;
      if (!keyId || !keyId.trim()) return ERRORS.MISSING_KEY_ID;
      if (!secret || !secret.trim()) return ERRORS.MISSING_SECRET;
      if (!region || !region.trim()) return ERRORS.MISSING_REGION;
    }
    return null;
  }

  /**
   * Detect file format from the URL for the correct DuckDB reader.
   * Strips query strings (pre-signed URLs) before checking the extension.
   * @param {string} url
   * @returns {'parquet'|'csv'|'json'|'ndjson'|null}
   */
  detectFormat(url) {
    const base = url.split('?')[0].split('#')[0];
    const parts = base.split('.');
    const ext = parts[parts.length - 1].toLowerCase();
    const ext2 = parts.length > 2 ? parts[parts.length - 2].toLowerCase() : '';
    // Handle .json.gz, .csv.gz etc
    if (ext === 'gz') {
      if (ext2 === 'parquet') return 'parquet';
      if (ext2 === 'csv' || ext2 === 'tsv') return 'csv';
      if (ext2 === 'json' || ext2 === 'ndjson') return 'json';
    }
    if (ext === 'parquet') return 'parquet';
    if (ext === 'csv' || ext === 'tsv') return 'csv';
    if (ext === 'json') return 'json';
    if (ext === 'ndjson') return 'ndjson';
    return null;
  }

  /**
   * Build the DuckDB SQL to read from S3.
   * @param {string} url - the S3 URL (s3:// or https:// pre-signed)
   * @param {string} format - 'parquet' | 'csv' | 'json' | 'ndjson'
   * @param {number} [limit] - optional row limit for preview
   * @returns {string} SQL
   */
  buildReadSQL(url, format, limit = null) {
    const escaped = url.replace(/'/g, "''");
    let reader;
    if (format === 'parquet') {
      reader = 'read_parquet(\'' + escaped + '\')';
    } else if (format === 'csv') {
      reader = 'read_csv_auto(\'' + escaped + '\', ignore_errors=true)';
    } else if (format === 'json' || format === 'ndjson') {
      reader = 'read_json_auto(\'' + escaped + '\')';
    } else {
      // Fall back to parquet — DuckDB will error with a useful message
      reader = 'read_parquet(\'' + escaped + '\')';
    }
    const limitClause = limit ? ' LIMIT ' + limit : '';
    return 'SELECT * FROM ' + reader + limitClause;
  }

  /**
   * Build the CREATE SECRET SQL for IAM credentials.
   * The secret name is randomized per-session to avoid conflicts.
   * @param {object} creds
   * @returns {string} SQL
   */
  buildCreateSecretSQL({ keyId, secret, region, sessionToken }) {
    const name = 's3_cred_' + Math.random().toString(36).slice(2, 10);
    let sql = 'CREATE OR REPLACE SECRET ' + name + ' (' +
      'TYPE S3, ' +
      'KEY_ID \'' + keyId.replace(/'/g, "''") + '\', ' +
      'SECRET \'' + secret.replace(/'/g, "''") + '\', ' +
      'REGION \'' + region.replace(/'/g, "''") + '\'';
    if (sessionToken) {
      sql += ', SESSION_TOKEN \'' + sessionToken.replace(/'/g, "''") + '\'';
    }
    sql += ')';
    return sql;
  }

  /**
   * Main entry point. Sets up credentials (if IAM), then queries S3,
   * and ingests the result via loadRows.
   *
   * @param {object} params
   * @param {string} params.mode        - MODES.PRESIGNED or MODES.IAM
   * @param {string} params.url         - S3 URL or pre-signed URL
   * @param {string} [params.keyId]     - AWS Key ID (IAM mode only)
   * @param {string} [params.secret]    - AWS Secret (IAM mode only)
   * @param {string} [params.region]    - AWS region (IAM mode only)
   * @param {string} [params.sessionToken] - STS session token (optional)
   * @param {string} [params.tableName] - override auto-detected table name
   * @param {number} [params.rowLimit]  - max rows to import (default 500k)
   * @param {function} [params.onStatus] - (msg: string) => void
   * @returns {Promise<object>} dataset
   */
  async connect({ mode, url, keyId, secret, region, sessionToken, tableName, rowLimit = 500000, onStatus = () => {} }) {
    const validationError = this.validate({ mode, url, keyId, secret, region });
    if (validationError) throw new Error(validationError);

    const trimmedUrl = url.trim();
    const format = this.detectFormat(trimmedUrl);
    if (!format) throw new Error(ERRORS.UNSUPPORTED_FORMAT);

    onStatus('Connecting to S3...');

    // IAM mode: register credentials with DuckDB-WASM first.
    if (mode === MODES.IAM) {
      onStatus('Setting up S3 credentials...');
      const secretSQL = this.buildCreateSecretSQL({ keyId: keyId.trim(), secret: secret.trim(), region: region.trim(), sessionToken });
      try {
        await this._runQuery(secretSQL);
      } catch (e) {
        throw new Error('Failed to set S3 credentials: ' + (e && e.message ? e.message : String(e)));
      }
    }

    // Build + run the read query.
    onStatus('Reading ' + format + ' from S3...');
    const sql = this.buildReadSQL(trimmedUrl, format, rowLimit);

    let result;
    try {
      result = await this._runQuery(sql);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (msg.toLowerCase().includes('cors') || msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch')) {
        throw new Error(ERRORS.CORS_BLOCKED);
      }
      throw new Error(ERRORS.QUERY_FAILED + ' Detail: ' + msg);
    }

    if (!result || !result.rows || result.rows.length === 0) {
      throw new Error('S3 file returned 0 rows. Check the URL and file contents.');
    }

    // Derive a friendly table name from the URL.
    const name = tableName || deriveName(trimmedUrl);
    onStatus('Importing ' + result.rows.length.toLocaleString() + ' rows...');

    const ds = await this._loadRows({
      rows: result.rows,
      cols: result.schema || [],
      name: name + ' (S3)',
      source: 's3',
      sourceUrl: trimmedUrl,
    });

    onStatus('');
    return ds;
  }
}

// ---- helpers -----------------------------------------------------------------

/**
 * Derive a friendly dataset name from an S3 URL.
 * s3://my-bucket/data/claims_2026.parquet -> claims_2026
 * https://bucket.s3.amazonaws.com/data/file.parquet?... -> file
 */
function deriveName(url) {
  const base = url.split('?')[0].split('#')[0];
  const last = base.split('/').filter(Boolean).pop() || 's3_dataset';
  return last.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
}
