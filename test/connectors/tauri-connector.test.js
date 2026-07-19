// ============================================================
// DATAGLOW — Tauri Live Connector Layer: tauri-connector test suite
// ============================================================
// Pure Node tests. No Tauri runtime, no native DB drivers — invoke() is
// always a mock function supplied via deps, matching the dependency
// injection contract described at the top of js/connectors/tauri-connector.js.
//
// RUN WITH:  node test/connectors/tauri-connector.test.js

import {
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
} from '../../js/connectors/tauri-connector.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

async function main() {
  // ---------- validateConnectorConfig ----------
  {
    const r = validateConnectorConfig({ type: DB_TYPES.POSTGRES, host: 'localhost', port: 5432, database: 'analytics' });
    ok(r.valid === true, 'validateConnectorConfig: passes valid postgres config');
    ok(r.errors.length === 0, 'validateConnectorConfig: valid postgres config has no errors');
  }
  {
    const r = validateConnectorConfig({ type: DB_TYPES.SQLITE, database: '/tmp/local.db' });
    ok(r.valid === true, 'validateConnectorConfig: passes valid sqlite config (no host required)');
  }
  {
    const r = validateConnectorConfig({ type: 'oracle', database: 'x' });
    ok(r.valid === false, 'validateConnectorConfig: rejects invalid DB_TYPE');
    ok(r.errors.some((e) => e.includes('type must be one of')), 'validateConnectorConfig: invalid DB_TYPE error message present');
  }
  {
    const r = validateConnectorConfig({ type: DB_TYPES.MYSQL, database: 'shop' });
    ok(r.valid === false, 'validateConnectorConfig: rejects mysql with no host');
    ok(r.errors.some((e) => e.includes('host is required')), 'validateConnectorConfig: mysql missing-host error message present');
  }
  {
    const r = validateConnectorConfig({ type: DB_TYPES.POSTGRES, host: 'db.internal', database: 'x', port: 99999 });
    ok(r.valid === false, 'validateConnectorConfig: rejects port out of range');
  }
  {
    const r = validateConnectorConfig({ type: DB_TYPES.POSTGRES, host: 'db.internal', database: '' });
    ok(r.valid === false, 'validateConnectorConfig: rejects empty database name');
  }
  {
    const r = validateConnectorConfig({ type: DB_TYPES.DUCKDB_NATIVE, database: './local.duckdb' });
    ok(r.valid === true, 'validateConnectorConfig: passes valid duckdb_native config');
  }

  // ---------- sanitizeConfig ----------
  {
    const s = sanitizeConfig({ type: DB_TYPES.POSTGRES, host: 'h', database: 'd', username: 'administrator', password: 'super-secret' });
    ok(s.password === '***', 'sanitizeConfig: masks password');
    ok(s.username === 'a***r', 'sanitizeConfig: masks username');
    ok(!JSON.stringify(s).includes('super-secret'), 'sanitizeConfig: never returns raw password');
  }
  {
    const s = sanitizeConfig({ type: DB_TYPES.SQLITE, database: 'x.db', username: 'ab', password: 'p' });
    ok(s.username === '***', 'sanitizeConfig: masks very short username fully');
  }
  {
    const s = sanitizeConfig({ type: DB_TYPES.SQLITE, database: 'x.db' });
    ok(s.password === undefined, 'sanitizeConfig: no password field when input had none');
  }

  // ---------- buildConnectCall ----------
  {
    const call = buildConnectCall({ type: DB_TYPES.POSTGRES, host: 'h', database: 'd', username: 'u', password: 'topsecret' });
    ok(call.command === 'dataglow_connect', 'buildConnectCall: command is dataglow_connect');
    ok(!JSON.stringify(call.args).includes('topsecret'), 'buildConnectCall: does not include password in args');
    ok(call.args.config.password === '***', 'buildConnectCall: password field is masked marker, not omitted-and-forgotten');
  }

  // ---------- buildQueryCall ----------
  {
    const call = buildQueryCall('conn-1', 'SELECT * FROM users', [1, 2]);
    ok(call.command === 'dataglow_query', 'buildQueryCall: command is dataglow_query');
    ok(call.args.connectionId === 'conn-1', 'buildQueryCall: includes connectionId');
    ok(call.args.sql === 'SELECT * FROM users', 'buildQueryCall: includes sql');
    ok(Array.isArray(call.args.params) && call.args.params.length === 2, 'buildQueryCall: includes params');
  }

  // ---------- buildStreamCall ----------
  {
    const call = buildStreamCall('conn-1', 'SELECT * FROM events');
    ok(call.command === 'dataglow_stream', 'buildStreamCall: command is dataglow_stream');
    ok(call.args.batchSize === 1000, 'buildStreamCall: default batchSize is 1000');
    ok(call.args.pollIntervalMs === 5000, 'buildStreamCall: default pollIntervalMs is 5000');
  }
  {
    const call = buildStreamCall('conn-1', 'SELECT * FROM events', { batchSize: 50, pollIntervalMs: 250 });
    ok(call.args.batchSize === 50, 'buildStreamCall: honors custom batchSize');
    ok(call.args.pollIntervalMs === 250, 'buildStreamCall: honors custom pollIntervalMs');
  }

  // ---------- connect ----------
  {
    const mockInvoke = async (command, args) => {
      ok(command === 'dataglow_connect', 'connect: invoke called with dataglow_connect');
      return { connected: true, connectionId: 'conn-abc', schema: [{ tableName: 'users', columns: [] }], error: null };
    };
    const result = await connect({ type: DB_TYPES.POSTGRES, host: 'h', database: 'd' }, { invoke: mockInvoke });
    ok(result.connected === true, 'connect: returns connected=true on mock success');
    ok(result.connectionId === 'conn-abc', 'connect: returns connectionId from mock');
    ok(result.schema.length === 1, 'connect: returns schema from mock');
  }
  {
    const mockInvoke = async () => { throw new Error('connection refused'); };
    const result = await connect({ type: DB_TYPES.POSTGRES, host: 'h', database: 'd' }, { invoke: mockInvoke });
    ok(result.connected === false, 'connect: returns connected=false on mock failure');
    ok(result.error === 'connection refused', 'connect: returns error message on mock failure');
  }
  {
    const result = await connect({ type: DB_TYPES.POSTGRES, database: 'd' }, { invoke: async () => ({}) });
    ok(result.connected === false && result.error.includes('Invalid connector config'), 'connect: rejects invalid config before calling invoke');
  }

  // ---------- query ----------
  {
    const mockInvoke = async (command) => {
      ok(command === 'dataglow_query', 'query: invoke called with dataglow_query');
      return { rows: [{ id: 1, name: 'a' }], columns: ['id', 'name'], rowCount: 1, durationMs: 12, error: null };
    };
    const result = await query('conn-1', 'SELECT * FROM t', [], { invoke: mockInvoke });
    ok(Array.isArray(result.rows) && result.rows.length === 1, 'query: returns rows on mock success');
    ok(Array.isArray(result.columns) && result.columns.includes('name'), 'query: returns columns on mock success');
    ok(result.rowCount === 1, 'query: returns rowCount on mock success');
  }
  {
    const mockInvoke = async () => { throw new Error('syntax error'); };
    const result = await query('conn-1', 'SELECT bad', [], { invoke: mockInvoke });
    ok(result.error === 'syntax error', 'query: returns error message on mock failure');
    ok(result.rows.length === 0, 'query: returns empty rows on mock failure');
  }

  // ---------- disconnect ----------
  {
    const mockInvoke = async (command, args) => {
      ok(command === 'dataglow_disconnect', 'disconnect: invoke called with dataglow_disconnect');
      ok(args.connectionId === 'conn-1', 'disconnect: passes connectionId to invoke');
      return { disconnected: true, error: null };
    };
    const result = await disconnect('conn-1', { invoke: mockInvoke });
    ok(result.disconnected === true, 'disconnect: returns disconnected=true on mock success');
  }

  // ---------- queryResultToGridDataset ----------
  {
    const gridDataset = queryResultToGridDataset(
      { rows: [{ id: 1, name: 'alice', active: true }, { id: 2, name: 'bob', active: false }], columns: ['id', 'name', 'active'] },
      'my_dataset'
    );
    ok(gridDataset.datasetName === 'my_dataset', 'queryResultToGridDataset: sets datasetName');
    ok(Array.isArray(gridDataset.headers) && gridDataset.headers.length === 3, 'queryResultToGridDataset: returns GridDataset shape with headers');
    ok(Array.isArray(gridDataset.rows) && gridDataset.rows.length === 2, 'queryResultToGridDataset: returns GridDataset shape with rows');
    ok(gridDataset.rows[0].cells.id.value === 1, 'queryResultToGridDataset: cell values preserved');
    const idHeader = gridDataset.headers.find((h) => h.name === 'id');
    ok(idHeader.type === 'numeric', 'queryResultToGridDataset: detects numeric columns');
    const activeHeader = gridDataset.headers.find((h) => h.name === 'active');
    ok(activeHeader.type === 'boolean', 'queryResultToGridDataset: detects boolean columns');
  }
  {
    const gridDataset = queryResultToGridDataset(
      { rows: [{ created_at: '2026-01-01' }, { created_at: '2026-02-15' }], columns: ['created_at'] },
      'dates'
    );
    ok(gridDataset.headers[0].type === 'date', 'queryResultToGridDataset: detects date columns');
  }

  // ---------- detectColumnType ----------
  ok(detectColumnType(['1', '2', '3']) === 'numeric', 'detectColumnType: numeric strings detected');
  ok(detectColumnType(['a', 'b']) === 'text', 'detectColumnType: non-numeric strings fall back to text');

  // ---------- describeConnection ----------
  {
    const desc = describeConnection('conn-1', [{ tableName: 't1' }, { tableName: 't2' }], { database: 'analytics', type: 'postgres' });
    ok(desc.includes('analytics'), 'describeConnection: string includes database name');
    ok(desc.includes('2 table'), 'describeConnection: string includes table count');
  }

  // ---------- TAURI_COMMANDS ----------
  ok(Array.isArray(TAURI_COMMANDS), 'TAURI_COMMANDS is an array');
  ok(TAURI_COMMANDS.length >= 4, 'TAURI_COMMANDS has at least 4 entries');
  ok(TAURI_COMMANDS.includes('dataglow_connect'), 'TAURI_COMMANDS includes dataglow_connect');
  ok(TAURI_COMMANDS.includes('dataglow_query'), 'TAURI_COMMANDS includes dataglow_query');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
