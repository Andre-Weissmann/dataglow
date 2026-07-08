// ============================================================
// DATAGLOW — Databricks Direct-Connect test suite
// ============================================================
// A live Databricks workspace + token can't exist in CI, so this suite drives
// the connector against a MOCK fetch, exactly the way watch-folder.test.mjs
// drives its controller against a mock directory handle. It covers the four
// testable seams of js/databricks-connect.js:
//   1. Pure request construction (URLs, method, auth header, JSON body).
//   2. Response parsing (manifest schema -> columns, data_array -> row objects).
//   3. The submit -> poll -> succeed happy path, proving it reuses the injected
//      loadRows ingest step (the same seam the file/CSV path uses).
//   4. Error handling: bad HTTP status, network/CORS rejection, malformed
//      payload, failed/canceled statements, and timeout.
//
// RUN WITH:  node test/databricks-connect.test.mjs      (no DuckDB, no network)

import {
  DatabricksConnector, TRUST_NOTICE, DEFAULT_QUERY, STATES, ERRORS,
  isTerminalState, normalizeHost, statementsUrl, statementUrl,
  buildExecuteRequest, buildPollRequest, describeHttpError,
  stateFailureMessage, parseResultSet,
} from '../js/databricks-connect.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function expectReject(promise, matcher, msg) {
  try {
    await promise;
    ok(false, `${msg} (expected a rejection, got success)`);
  } catch (e) {
    ok(matcher(e), `${msg}${matcher(e) ? '' : ` (got: ${e.message})`}`);
  }
}

// A mock Response with just the surface the connector reads.
function mockResponse(body, { ok: okFlag = true, status = 200, json = true } = {}) {
  return {
    ok: okFlag,
    status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    async json() {
      if (!json) throw new Error('not json');
      return typeof body === 'string' ? JSON.parse(body) : body;
    },
  };
}

// A fetch spy that returns a queued sequence of responses (one per call) and
// records every (url, init) it was called with.
function makeFetchSequence(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (typeof next === 'function') return next();
    if (next === undefined) throw new Error('fetch called more times than the test queued');
    return next;
  };
  return { fetch, calls };
}

const succeededPayload = {
  statement_id: 'stmt-123',
  status: { state: 'SUCCEEDED' },
  manifest: {
    schema: {
      column_count: 2,
      columns: [
        { name: 'id', type_text: 'INT', type_name: 'INT', position: 0 },
        { name: 'label', type_text: 'STRING', type_name: 'STRING', position: 1 },
      ],
    },
  },
  result: { data_array: [['1', 'alpha'], ['2', 'beta'], ['3', null]] },
};

async function main() {
  // ============================================================
  // 1 — Pure helpers: host normalization + URL construction.
  // ============================================================
  ok(normalizeHost('dbc-abc.cloud.databricks.com') === 'https://dbc-abc.cloud.databricks.com',
    'host: a bare host is upgraded to https://');
  ok(normalizeHost('https://dbc-abc.cloud.databricks.com/') === 'https://dbc-abc.cloud.databricks.com',
    'host: an existing scheme is kept and the trailing slash is trimmed');
  ok(normalizeHost('  https://x.databricks.com/sql/  ') === 'https://x.databricks.com',
    'host: surrounding whitespace and path are stripped to a bare origin');
  ok((() => { try { normalizeHost(''); return false; } catch { return true; } })(),
    'host: an empty host throws');

  ok(statementsUrl('dbc-abc.cloud.databricks.com') === 'https://dbc-abc.cloud.databricks.com/api/2.0/sql/statements',
    'url: statements endpoint is built from the normalized host');
  ok(statementUrl('https://h.databricks.com', 'a b/c') === 'https://h.databricks.com/api/2.0/sql/statements/a%20b%2Fc',
    'url: statement id is URL-encoded in the poll endpoint');

  // ============================================================
  // 2 — Request construction: method, auth header, JSON body.
  // ============================================================
  const exec = buildExecuteRequest({
    host: 'https://h.databricks.com', token: 'tok-secret', warehouseId: 'wh1', statement: 'SELECT 1',
  });
  ok(exec.url.endsWith('/api/2.0/sql/statements') && exec.init.method === 'POST',
    'exec: POSTs to the statements endpoint');
  ok(exec.init.headers.Authorization === 'Bearer tok-secret' && exec.init.headers['Content-Type'] === 'application/json',
    'exec: sends the bearer token and JSON content-type header');
  const execBody = JSON.parse(exec.init.body);
  ok(execBody.warehouse_id === 'wh1' && execBody.statement === 'SELECT 1',
    'exec: body carries the warehouse id and statement');
  ok(execBody.disposition === 'INLINE' && execBody.format === 'JSON_ARRAY' && execBody.on_wait_timeout === 'CONTINUE',
    'exec: requests inline JSON with CONTINUE-on-timeout so results come back pollable');

  const poll = buildPollRequest({ host: 'https://h.databricks.com', token: 'tok', statementId: 'stmt-9' });
  ok(poll.init.method === 'GET' && poll.url.endsWith('/statements/stmt-9') && poll.init.headers.Authorization === 'Bearer tok',
    'poll: GETs the statement-by-id endpoint with the bearer token');

  ok((() => { try { buildExecuteRequest({ host: 'h', token: '', warehouseId: 'w', statement: 's' }); return false; } catch (e) { return e.message === ERRORS.MISSING_TOKEN; } })(),
    'exec: a missing token throws the friendly MISSING_TOKEN message');
  ok((() => { try { buildExecuteRequest({ host: 'h', token: 't', warehouseId: '', statement: 's' }); return false; } catch (e) { return e.message === ERRORS.MISSING_WAREHOUSE; } })(),
    'exec: a missing warehouse id throws MISSING_WAREHOUSE');
  ok((() => { try { buildExecuteRequest({ host: 'h', token: 't', warehouseId: 'w', statement: '   ' }); return false; } catch (e) { return e.message === ERRORS.MISSING_STATEMENT; } })(),
    'exec: a blank statement throws MISSING_STATEMENT');

  // ============================================================
  // 3 — Parsing + terminal-state helpers.
  // ============================================================
  ok(isTerminalState('SUCCEEDED') && isTerminalState('FAILED') && isTerminalState('CANCELED') && isTerminalState('CLOSED'),
    'state: SUCCEEDED/FAILED/CANCELED/CLOSED are terminal');
  ok(!isTerminalState('PENDING') && !isTerminalState('RUNNING') && !isTerminalState(undefined),
    'state: PENDING/RUNNING/undefined are not terminal');

  const parsed = parseResultSet(succeededPayload);
  ok(parsed.columns.join(',') === 'id,label', 'parse: column names come from the manifest schema in position order');
  ok(parsed.rows.length === 3 && parsed.rows[0].id === '1' && parsed.rows[0].label === 'alpha',
    'parse: data_array rows become objects keyed by column name');
  ok(parsed.rows[2].label === null, 'parse: null cells are preserved as null');
  ok(parsed.truncated === false, 'parse: no next-chunk link means not truncated');

  const unordered = { manifest: { schema: { columns: [ { name: 'b', position: 1 }, { name: 'a', position: 0 } ] } }, result: { data_array: [['av', 'bv']] } };
  ok(parseResultSet(unordered).columns.join(',') === 'a,b', 'parse: columns are sorted by position, not array order');

  const zeroRows = { manifest: { schema: { columns: [ { name: 'x', position: 0 } ] } } };
  ok(parseResultSet(zeroRows).rows.length === 0, 'parse: a result with no data_array yields zero rows (not an error)');

  const chunked = { manifest: { schema: { columns: [ { name: 'x', position: 0 } ] } }, result: { data_array: [['1']], next_chunk_internal_link: '/api/.../chunks/1' } };
  ok(parseResultSet(chunked).truncated === true, 'parse: a next-chunk link flags the result as truncated');

  ok((() => { try { parseResultSet({ status: { state: 'SUCCEEDED' } }); return false; } catch (e) { return e.message === ERRORS.MALFORMED; } })(),
    'parse: a payload with no manifest schema throws MALFORMED');

  // ============================================================
  // 4 — describeHttpError / stateFailureMessage phrasing.
  // ============================================================
  ok(/token/i.test(describeHttpError(401, '{"message":"invalid"}')) && /401/.test(describeHttpError(401, '')),
    'httpErr: 401 mentions the token and the status code');
  ok(/host|warehouse/i.test(describeHttpError(404, '')), 'httpErr: 404 points at host/warehouse');
  ok(/rate/i.test(describeHttpError(429, '')), 'httpErr: 429 mentions rate limiting');
  ok(describeHttpError(500, '{"message":"boom"}').includes('boom'), 'httpErr: the API message is appended when present');
  ok(/failed/i.test(stateFailureMessage(STATES.FAILED, { message: 'syntax error' })) && stateFailureMessage(STATES.FAILED, { message: 'syntax error' }).includes('syntax error'),
    'stateErr: a FAILED statement surfaces the Databricks error message');
  ok(/cancel/i.test(stateFailureMessage(STATES.CANCELED)), 'stateErr: a CANCELED statement is described as canceled');

  // ============================================================
  // 5 — Happy path: synchronous SUCCEEDED + reuse of injected loadRows.
  // ============================================================
  {
    const { fetch, calls } = makeFetchSequence([mockResponse(succeededPayload)]);
    const ingested = [];
    const loadRows = async (args) => { ingested.push(args); return { name: args.name, table: 't', rowCount: args.rows.length }; };
    const connector = new DatabricksConnector({ fetch, loadRows, sleep: async () => {}, maxPolls: 5 });
    const states = [];
    const res = await connector.run({
      host: 'https://h.databricks.com', token: 'tok', warehouseId: 'wh', statement: 'SELECT 1',
      name: 'my_query', onState: (s) => states.push(s),
    });
    ok(calls.length === 1 && calls[0].init.method === 'POST',
      'run: a query that finishes on submit needs no poll (single POST)');
    ok(ingested.length === 1 && ingested[0].columns.join(',') === 'id,label' && ingested[0].rows.length === 3,
      'run: parsed columns + rows are handed to the SAME injected loadRows ingest step');
    ok(ingested[0].source === 'Databricks' && ingested[0].meta.statementId === 'stmt-123',
      'run: ingest is tagged as a Databricks source with the statement id for provenance');
    ok(res.rowCount === 3 && res.truncated === false && states[0] === 'SUCCEEDED',
      'run: returns the row count/truncation flag and reported the SUCCEEDED state');
  }

  // ============================================================
  // 6 — Polling: PENDING -> RUNNING -> SUCCEEDED across GET polls.
  // ============================================================
  {
    const { fetch, calls } = makeFetchSequence([
      mockResponse({ statement_id: 'stmt-p', status: { state: 'PENDING' } }),
      mockResponse({ statement_id: 'stmt-p', status: { state: 'RUNNING' } }),
      mockResponse(succeededPayload),
    ]);
    let slept = 0;
    const connector = new DatabricksConnector({ fetch, loadRows: async () => ({}), sleep: async () => { slept++; }, maxPolls: 10 });
    const states = [];
    const res = await connector.run({ host: 'h.databricks.com', token: 't', warehouseId: 'w', statement: 'SELECT 1', onState: (s) => states.push(s) });
    ok(calls.length === 3 && calls[0].init.method === 'POST' && calls[1].init.method === 'GET' && calls[2].init.method === 'GET',
      'poll: one POST followed by GET polls until the statement reaches a terminal state');
    ok(calls[1].url.endsWith('/statements/stmt-p'), 'poll: polls the statement id returned by the submit call');
    ok(slept === 2 && states.join(',') === 'PENDING,RUNNING,SUCCEEDED',
      'poll: slept between each poll and reported every observed state in order');
    ok(res.rowCount === 3, 'poll: the eventual SUCCEEDED result is parsed and returned');
  }

  // ============================================================
  // 7 — Error handling.
  // ============================================================
  {
    const { fetch } = makeFetchSequence([mockResponse('{"message":"token expired"}', { ok: false, status: 401 })]);
    const c = new DatabricksConnector({ fetch, loadRows: async () => ({}), sleep: async () => {} });
    await expectReject(
      c.run({ host: 'h.databricks.com', token: 'bad', warehouseId: 'w', statement: 'SELECT 1' }),
      (e) => /401/.test(e.message) && /token/i.test(e.message),
      'error: an HTTP 401 surfaces a token-rejected message',
    );
  }
  {
    // fetch REJECTS — this is what a CORS block / offline looks like in a browser.
    const fetch = async () => { throw new TypeError('Failed to fetch'); };
    const c = new DatabricksConnector({ fetch, loadRows: async () => ({}), sleep: async () => {} });
    await expectReject(
      c.run({ host: 'h.databricks.com', token: 't', warehouseId: 'w', statement: 'SELECT 1' }),
      (e) => e.message === ERRORS.NETWORK && /CORS/i.test(e.message),
      'error: a fetch rejection maps to the network/CORS guidance message',
    );
  }
  {
    const { fetch } = makeFetchSequence([mockResponse('not-json-at-all', { json: false })]);
    const c = new DatabricksConnector({ fetch, loadRows: async () => ({}), sleep: async () => {} });
    await expectReject(
      c.run({ host: 'h.databricks.com', token: 't', warehouseId: 'w', statement: 'SELECT 1' }),
      (e) => e.message === ERRORS.MALFORMED,
      'error: a non-JSON body maps to the MALFORMED message',
    );
  }
  {
    const { fetch } = makeFetchSequence([
      mockResponse({ statement_id: 's', status: { state: 'FAILED', error: { message: 'table not found' } } }),
    ]);
    let ingestCalled = false;
    const c = new DatabricksConnector({ fetch, loadRows: async () => { ingestCalled = true; }, sleep: async () => {} });
    await expectReject(
      c.run({ host: 'h.databricks.com', token: 't', warehouseId: 'w', statement: 'SELECT 1' }),
      (e) => /failed/i.test(e.message) && e.message.includes('table not found'),
      'error: a FAILED statement rejects with the Databricks error message',
    );
    ok(ingestCalled === false, 'error: a failed statement never reaches the ingest step');
  }
  {
    // Never reaches a terminal state -> hits the poll cap.
    const running = () => mockResponse({ statement_id: 's', status: { state: 'RUNNING' } });
    const responses = Array.from({ length: 20 }, () => running());
    const { fetch } = makeFetchSequence(responses);
    const c = new DatabricksConnector({ fetch, loadRows: async () => ({}), sleep: async () => {}, maxPolls: 3 });
    await expectReject(
      c.run({ host: 'h.databricks.com', token: 't', warehouseId: 'w', statement: 'SELECT 1' }),
      (e) => e.message === ERRORS.TIMEOUT,
      'error: a statement that never finishes hits maxPolls and throws TIMEOUT',
    );
  }

  // ============================================================
  // 8 — Constructor guards + public copy.
  // ============================================================
  ok((() => { try { new DatabricksConnector({ loadRows: () => {} }); return false; } catch { return true; } })(),
    'ctor: a missing fetch implementation throws');
  ok((() => { try { new DatabricksConnector({ fetch: () => {} }); return false; } catch { return true; } })(),
    'ctor: a missing loadRows callback throws');
  ok(/never stores/i.test(TRUST_NOTICE) && /memory only/i.test(TRUST_NOTICE) && /read-only/i.test(TRUST_NOTICE),
    'copy: TRUST_NOTICE states read-only, in-memory-only, never-stored');
  ok(/LIMIT/i.test(DEFAULT_QUERY), 'copy: the default query is a bounded LIMIT sample');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
