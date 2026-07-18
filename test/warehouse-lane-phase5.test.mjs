// ============================================================
// DATAGLOW — Phase 5 Warehouse Lane Tests
// ============================================================
// Tests for:
//   js/warehouse/s3-connector.js   -- S3/Parquet connector
//   js/warehouse/bigquery-connector.js -- BigQuery connector
//
// No DuckDB needed — all network/engine calls are injected.
// Run: node test/warehouse-lane-phase5.test.mjs

import {
  S3Connector, MODES, ERRORS as S3_ERRORS, TRUST_NOTICE as S3_TRUST,
} from '../js/warehouse/s3-connector.js';
import {
  BigQueryConnector, requestOAuthToken,
  ERRORS as BQ_ERRORS, TRUST_NOTICE as BQ_TRUST,
} from '../js/warehouse/bigquery-connector.js';

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) { passed++; console.log('  ok ' + label); }
  else { failed++; console.log('FAIL ' + label); }
}

// ---- helpers -----------------------------------------------------------------
function makeEngine(rows = [], schema = []) {
  return {
    calls: [],
    runQuery(sql) {
      this.calls.push(sql);
      return Promise.resolve({ rows, schema });
    },
  };
}
function makeLoader() {
  return {
    calls: [],
    loadRowsAsDataset(args) {
      this.calls.push(args);
      return Promise.resolve({ table: 't', rowCount: args.rows.length, cols: args.cols || [] });
    },
  };
}

// ============================================================
// S3 Connector — construction
// ============================================================
console.log('\n-- S3Connector construction --');
{
  ok(typeof S3_TRUST === 'string' && S3_TRUST.length > 10, 'TRUST_NOTICE is a non-empty string');
  ok(MODES.PRESIGNED === 'presigned', 'MODES.PRESIGNED correct');
  ok(MODES.IAM === 'iam', 'MODES.IAM correct');

  let threw = false;
  try { new S3Connector({}); } catch (_) { threw = true; }
  ok(threw, 'throws without runQuery');

  let threw2 = false;
  try { new S3Connector({ runQuery: () => {} }); } catch (_) { threw2 = true; }
  ok(threw2, 'throws without loadRows');

  const c = new S3Connector({ runQuery: () => {}, loadRows: () => {} });
  ok(c instanceof S3Connector, 'constructs with required args');
}

// ============================================================
// S3 Connector — validate()
// ============================================================
console.log('\n-- S3Connector.validate() --');
{
  const c = new S3Connector({ runQuery: () => {}, loadRows: () => {} });

  // Presigned mode
  ok(c.validate({ mode: MODES.PRESIGNED, url: '' }) === S3_ERRORS.MISSING_URL, 'empty url: MISSING_URL');
  ok(c.validate({ mode: MODES.PRESIGNED, url: '   ' }) === S3_ERRORS.MISSING_URL, 'whitespace url: MISSING_URL');
  ok(c.validate({ mode: MODES.PRESIGNED, url: 'ftp://bad' }) === S3_ERRORS.INVALID_URL, 'ftp url: INVALID_URL');
  ok(c.validate({ mode: MODES.PRESIGNED, url: 'https://bucket.s3.amazonaws.com/file.parquet?X-Amz-Signature=abc' }) === null, 'valid presigned https: null');
  ok(c.validate({ mode: MODES.PRESIGNED, url: 's3://bucket/file.parquet' }) === null, 'valid s3:// presigned: null');

  // IAM mode
  ok(c.validate({ mode: MODES.IAM, url: 'https://bad.com' }) === S3_ERRORS.INVALID_URL, 'IAM mode non-s3 url: INVALID_URL');
  ok(c.validate({ mode: MODES.IAM, url: 's3://b/f.parquet', keyId: '', secret: '', region: '' }) === S3_ERRORS.MISSING_KEY_ID, 'IAM: missing keyId');
  ok(c.validate({ mode: MODES.IAM, url: 's3://b/f.parquet', keyId: 'K', secret: '', region: '' }) === S3_ERRORS.MISSING_SECRET, 'IAM: missing secret');
  ok(c.validate({ mode: MODES.IAM, url: 's3://b/f.parquet', keyId: 'K', secret: 'S', region: '' }) === S3_ERRORS.MISSING_REGION, 'IAM: missing region');
  ok(c.validate({ mode: MODES.IAM, url: 's3://b/f.parquet', keyId: 'K', secret: 'S', region: 'us-east-1' }) === null, 'IAM: valid = null');
}

// ============================================================
// S3 Connector — detectFormat()
// ============================================================
console.log('\n-- S3Connector.detectFormat() --');
{
  const c = new S3Connector({ runQuery: () => {}, loadRows: () => {} });
  ok(c.detectFormat('s3://bucket/data.parquet') === 'parquet', 'detects parquet');
  ok(c.detectFormat('s3://bucket/data.csv') === 'csv', 'detects csv');
  ok(c.detectFormat('s3://bucket/data.tsv') === 'csv', 'detects tsv as csv');
  ok(c.detectFormat('s3://bucket/data.json') === 'json', 'detects json');
  ok(c.detectFormat('s3://bucket/data.ndjson') === 'ndjson', 'detects ndjson');
  ok(c.detectFormat('https://bucket.s3.amazonaws.com/file.parquet?X-Amz-Signature=abc123') === 'parquet', 'strips query string before detecting format');
  ok(c.detectFormat('s3://bucket/data.csv.gz') === 'csv', 'detects csv.gz');
  ok(c.detectFormat('s3://bucket/data.parquet.gz') === 'parquet', 'detects parquet.gz');
  ok(c.detectFormat('s3://bucket/file') === null, 'no extension: null');
  ok(c.detectFormat('s3://bucket/file.xlsx') === null, 'unsupported extension: null');
}

// ============================================================
// S3 Connector — buildReadSQL()
// ============================================================
console.log('\n-- S3Connector.buildReadSQL() --');
{
  const c = new S3Connector({ runQuery: () => {}, loadRows: () => {} });
  const pq = c.buildReadSQL('s3://b/f.parquet', 'parquet');
  ok(pq.includes('read_parquet'), 'parquet uses read_parquet');
  ok(pq.startsWith('SELECT * FROM'), 'starts with SELECT * FROM');

  const csv = c.buildReadSQL('s3://b/f.csv', 'csv');
  ok(csv.includes('read_csv_auto'), 'csv uses read_csv_auto');

  const json = c.buildReadSQL('s3://b/f.json', 'json');
  ok(json.includes('read_json_auto'), 'json uses read_json_auto');

  const limited = c.buildReadSQL('s3://b/f.parquet', 'parquet', 1000);
  ok(limited.includes('LIMIT 1000'), 'limit clause injected');

  // SQL injection: quotes in URL are escaped (single quote becomes '')
  const evil = c.buildReadSQL("s3://b/f'; DROP TABLE foo; --", 'parquet');
  ok(evil.includes("''"), 'single quotes in URL are doubled (escaped)');
  ok(!evil.includes("f'; DROP"), 'raw unescaped single quote not present');
}

// ============================================================
// S3 Connector — buildCreateSecretSQL()
// ============================================================
console.log('\n-- S3Connector.buildCreateSecretSQL() --');
{
  const c = new S3Connector({ runQuery: () => {}, loadRows: () => {} });
  const sql = c.buildCreateSecretSQL({ keyId: 'AKID', secret: 'SEC', region: 'us-east-1' });
  ok(sql.includes('CREATE OR REPLACE SECRET'), 'includes CREATE OR REPLACE SECRET');
  ok(sql.includes('TYPE S3'), 'includes TYPE S3');
  ok(sql.includes('KEY_ID'), 'includes KEY_ID');
  ok(sql.includes("'AKID'"), 'keyId inserted');
  ok(sql.includes("'us-east-1'"), 'region inserted');
  ok(!sql.includes('SESSION_TOKEN'), 'no session token when not provided');

  const sqlST = c.buildCreateSecretSQL({ keyId: 'K', secret: 'S', region: 'eu-west-1', sessionToken: 'TOK' });
  ok(sqlST.includes('SESSION_TOKEN'), 'session token included when provided');
}

// ============================================================
// S3 Connector — connect() presigned (happy path)
// ============================================================
console.log('\n-- S3Connector.connect() presigned --');
{
  const rows = [{ id: 1, val: 'a' }, { id: 2, val: 'b' }];
  const schema = [{ name: 'id', type: 'INTEGER' }, { name: 'val', type: 'VARCHAR' }];
  const eng = makeEngine(rows, schema);
  const ldr = makeLoader();

  const c = new S3Connector({ runQuery: (sql) => eng.runQuery(sql), loadRows: (a) => ldr.loadRowsAsDataset(a) });
  const statuses = [];
  const ds = await c.connect({
    mode: MODES.PRESIGNED,
    url: 'https://bucket.s3.amazonaws.com/claims.parquet?X-Amz-Signature=abc',
    onStatus: (m) => statuses.push(m),
  });

  ok(eng.calls.length === 1, 'presigned: only 1 DuckDB call (no CREATE SECRET)');
  ok(eng.calls[0].includes('read_parquet'), 'presigned: uses read_parquet');
  ok(ldr.calls.length === 1, 'presigned: loadRows called once');
  ok(ldr.calls[0].rows.length === 2, 'presigned: 2 rows ingested');
  ok(ldr.calls[0].source === 's3', 'presigned: source=s3');
  ok(ldr.calls[0].name.includes('S3'), 'presigned: name includes S3');
  ok(statuses.length > 0, 'presigned: status callbacks fired');
  ok(statuses[statuses.length - 1] === '', 'presigned: final status cleared');
}

// ============================================================
// S3 Connector — connect() IAM mode
// ============================================================
console.log('\n-- S3Connector.connect() IAM --');
{
  const rows = [{ patient_id: 'P1', los: 3 }];
  const schema = [{ name: 'patient_id', type: 'VARCHAR' }, { name: 'los', type: 'INTEGER' }];
  const eng = makeEngine(rows, schema);
  const ldr = makeLoader();

  const c = new S3Connector({ runQuery: (sql) => eng.runQuery(sql), loadRows: (a) => ldr.loadRowsAsDataset(a) });
  await c.connect({
    mode: MODES.IAM,
    url: 's3://my-bucket/encounters.parquet',
    keyId: 'AKID', secret: 'SEC', region: 'us-east-1',
  });

  ok(eng.calls.length === 2, 'IAM: 2 DuckDB calls (CREATE SECRET + SELECT)');
  ok(eng.calls[0].includes('CREATE OR REPLACE SECRET'), 'IAM: first call is CREATE SECRET');
  ok(eng.calls[1].includes('read_parquet'), 'IAM: second call is SELECT');
  ok(ldr.calls[0].rows.length === 1, 'IAM: 1 row ingested');
}

// ============================================================
// S3 Connector — connect() validation error
// ============================================================
console.log('\n-- S3Connector.connect() errors --');
{
  const c = new S3Connector({ runQuery: () => {}, loadRows: () => {} });

  let err = null;
  try { await c.connect({ mode: MODES.PRESIGNED, url: '' }); } catch (e) { err = e; }
  ok(err && err.message === S3_ERRORS.MISSING_URL, 'connect: propagates validation error');

  let err2 = null;
  try { await c.connect({ mode: MODES.PRESIGNED, url: 's3://b/f.xlsx' }); } catch (e) { err2 = e; }
  ok(err2 && err2.message === S3_ERRORS.UNSUPPORTED_FORMAT, 'connect: unsupported format error');

  // DuckDB error propagated with detail
  const badEng = { runQuery: () => Promise.reject(new Error('File not found')) };
  const c2 = new S3Connector({ runQuery: (sql) => badEng.runQuery(sql), loadRows: () => {} });
  let err3 = null;
  try { await c2.connect({ mode: MODES.PRESIGNED, url: 'https://bucket.s3.amazonaws.com/f.parquet?X-Amz-Signature=x' }); } catch (e) { err3 = e; }
  ok(err3 && err3.message.includes(S3_ERRORS.QUERY_FAILED.split('.')[0]), 'connect: DuckDB error includes QUERY_FAILED prefix');

  // CORS error detection
  const corsEng = { runQuery: () => Promise.reject(new Error('CORS error: cross-origin blocked')) };
  const c3 = new S3Connector({ runQuery: (sql) => corsEng.runQuery(sql), loadRows: () => {} });
  let err4 = null;
  try { await c3.connect({ mode: MODES.PRESIGNED, url: 'https://bucket.s3.amazonaws.com/f.parquet?X-Amz-Signature=x' }); } catch (e) { err4 = e; }
  ok(err4 && err4.message.includes('CORS'), 'connect: CORS error detected and explained');
}

// ============================================================
// BigQuery Connector — construction + validate()
// ============================================================
console.log('\n-- BigQueryConnector construction + validate() --');
{
  ok(typeof BQ_TRUST === 'string' && BQ_TRUST.length > 10, 'BQ TRUST_NOTICE is a non-empty string');

  let threw = false;
  try { new BigQueryConnector({}); } catch (_) { threw = true; }
  ok(threw, 'throws without loadRows');

  const c = new BigQueryConnector({ loadRows: () => {} });
  ok(c instanceof BigQueryConnector, 'constructs with loadRows');

  ok(c.validate({ clientId: '', projectId: 'p', query: 'SELECT 1' }) === BQ_ERRORS.MISSING_CLIENT_ID, 'missing clientId');
  ok(c.validate({ clientId: 'c', projectId: '', query: 'SELECT 1' }) === BQ_ERRORS.MISSING_PROJECT, 'missing projectId');
  ok(c.validate({ clientId: 'c', projectId: 'p', query: '' }) === BQ_ERRORS.MISSING_QUERY, 'missing query');
  ok(c.validate({ clientId: 'c', projectId: 'p', query: 'SELECT 1' }) === null, 'all valid: null');
}

// ============================================================
// BigQuery Connector — token management
// ============================================================
console.log('\n-- BigQueryConnector token management --');
{
  const c = new BigQueryConnector({ loadRows: () => {} });
  ok(c.token === null, 'initial token is null');
  c.setToken('tok123');
  ok(c.token === 'tok123', 'setToken sets token');
  c.clearToken();
  ok(c.token === null, 'clearToken clears token');
}

// ============================================================
// BigQuery Connector — connect() with injected token (skips OAuth)
// ============================================================
console.log('\n-- BigQueryConnector.connect() happy path --');
{
  const bqRows = [
    { f: [{ v: 'P001' }, { v: '3' }, { v: 'false' }] }, // BigQuery returns 'false' string
    { f: [{ v: 'P002' }, { v: '7' }, { v: '1' }] },     // BigQuery also returns '1' for true
  ];
  const bqSchema = {
    fields: [
      { name: 'patient_id', type: 'STRING' },
      { name: 'los',        type: 'INTEGER' },
      { name: 'readmit',    type: 'BOOLEAN' },
    ],
  };
  const mockFetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ jobComplete: true, schema: bqSchema, rows: bqRows }),
  });

  const ldr = makeLoader();
  const c = new BigQueryConnector({ loadRows: (a) => ldr.loadRowsAsDataset(a), fetch: mockFetch });
  c.setToken('fake-token'); // skip OAuth

  const statuses = [];
  const ds = await c.connect({
    clientId: 'client.apps.googleusercontent.com',
    projectId: 'my-project',
    query: 'SELECT * FROM `my-project.dataset.table` LIMIT 100',
    onStatus: (m) => statuses.push(m),
  });

  ok(ldr.calls.length === 1, 'BQ: loadRows called once');
  ok(ldr.calls[0].rows.length === 2, 'BQ: 2 rows ingested');
  ok(ldr.calls[0].source === 'bigquery', 'BQ: source=bigquery');
  // Type conversion
  const row0 = ldr.calls[0].rows[0];
  ok(row0.patient_id === 'P001', 'BQ: STRING value correct');
  ok(row0.los === 3, 'BQ: INTEGER value converted to number');
  ok(row0.readmit === false, 'BQ: BOOLEAN value converted');
  const row1 = ldr.calls[0].rows[1];
  ok(row1.readmit === true, 'BQ: BOOLEAN true converted');
  ok(ldr.calls[0].cols.some(c => c.name === 'patient_id' && c.type === 'VARCHAR'), 'BQ: STRING -> VARCHAR in cols');
  ok(ldr.calls[0].cols.some(c => c.name === 'los' && c.type === 'BIGINT'), 'BQ: INTEGER -> BIGINT in cols');
  ok(statuses.length > 0, 'BQ: status callbacks fired');
  ok(statuses[statuses.length - 1] === '', 'BQ: final status cleared');
}

// ============================================================
// BigQuery Connector — 401 clears token
// ============================================================
console.log('\n-- BigQueryConnector 401 clears token --');
{
  const mockFetch = () => Promise.resolve({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: () => Promise.resolve({ error: { message: 'Token expired' } }),
  });
  const c = new BigQueryConnector({ loadRows: () => {}, fetch: mockFetch });
  c.setToken('expired-token');

  let err = null;
  try {
    await c.connect({ clientId: 'c', projectId: 'p', query: 'SELECT 1' });
  } catch (e) { err = e; }

  ok(err !== null, '401: error thrown');
  ok(c.token === null, '401: token cleared after 401');
}

// ============================================================
// BigQuery Connector — 404 error
// ============================================================
console.log('\n-- BigQueryConnector 404 --');
{
  const mockFetch = () => Promise.resolve({
    ok: false, status: 404, statusText: 'Not Found',
    json: () => Promise.resolve({ error: { message: 'Table not found' } }),
  });
  const c = new BigQueryConnector({ loadRows: () => {}, fetch: mockFetch });
  c.setToken('tok');

  let err = null;
  try { await c.connect({ clientId: 'c', projectId: 'p', query: 'SELECT 1' }); } catch (e) { err = e; }
  ok(err && err.message.includes(BQ_ERRORS.NOT_FOUND.split('.')[0]), '404: NOT_FOUND error');
}

// ============================================================
// BigQuery Connector — 429 quota error
// ============================================================
console.log('\n-- BigQueryConnector 429 --');
{
  const mockFetch = () => Promise.resolve({
    ok: false, status: 429, statusText: 'Too Many Requests',
    json: () => Promise.resolve({}),
  });
  const c = new BigQueryConnector({ loadRows: () => {}, fetch: mockFetch });
  c.setToken('tok');

  let err = null;
  try { await c.connect({ clientId: 'c', projectId: 'p', query: 'SELECT 1' }); } catch (e) { err = e; }
  ok(err && err.message === BQ_ERRORS.QUOTA_EXCEEDED, '429: QUOTA_EXCEEDED error');
}

// ============================================================
// BigQuery Connector — validation error before auth
// ============================================================
console.log('\n-- BigQueryConnector validation errors --');
{
  const c = new BigQueryConnector({ loadRows: () => {} });
  let err = null;
  try { await c.connect({ clientId: '', projectId: 'p', query: 'SELECT 1' }); } catch (e) { err = e; }
  ok(err && err.message === BQ_ERRORS.MISSING_CLIENT_ID, 'validates before touching OAuth');
  ok(c.token === null, 'token stays null after validation error');
}

// ============================================================
// BigQuery Connector — jobComplete=false triggers polling
// ============================================================
console.log('\n-- BigQueryConnector async job polling --');
{
  const bqRows = [{ f: [{ v: '42' }] }];
  const bqSchema = { fields: [{ name: 'n', type: 'INTEGER' }] };

  let callCount = 0;
  const mockFetch = () => {
    callCount++;
    // First call (sync): job not complete yet; second call (poll): complete.
    const jobComplete = callCount >= 2;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        jobComplete,
        schema: bqSchema,
        rows: jobComplete ? bqRows : [],
        jobReference: { jobId: 'job123', projectId: 'p' },
      }),
    });
  };

  const ldr = makeLoader();
  const c = new BigQueryConnector({ loadRows: (a) => ldr.loadRowsAsDataset(a), fetch: mockFetch });
  c.setToken('tok');

  await c.connect({ clientId: 'c', projectId: 'p', query: 'SELECT 1', timeoutMs: 100 });
  ok(callCount >= 2, 'async job: polling happened');
  ok(ldr.calls[0].rows[0].n === 42, 'async job: row value correct after poll');
}

// ============================================================
// Summary
// ============================================================
console.log('\n==========================================');
console.log(passed + ' passed, ' + failed + ' failed');
console.log('==========================================');
if (failed > 0) process.exit(1);
