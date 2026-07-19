// ============================================================
// DATAGLOW — Tauri Live Connector Layer: connector-manager test suite
// ============================================================
// Pure Node tests, no Tauri/network required.
//
// RUN WITH:  node test/connectors/connector-manager.test.js

import {
  createConnectorManager,
  registerConnection,
  getActiveConnection,
  setActiveConnection,
  removeConnection,
  listConnections,
  hasActiveConnection,
} from '../../js/connectors/connector-manager.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

function main() {
  // ---------- createConnectorManager ----------
  {
    const manager = createConnectorManager();
    ok(Object.keys(manager.connections).length === 0, 'createConnectorManager: returns empty connections');
    ok(manager.activeConnectionId === null, 'createConnectorManager: returns null activeConnectionId');
  }

  // ---------- registerConnection ----------
  {
    const manager = createConnectorManager();
    const config = { type: 'postgres', host: 'db.internal', database: 'analytics', username: 'administrator', password: 'sup3rsecret' };
    const schema = [{ tableName: 'users', columns: [] }, { tableName: 'orders', columns: [] }];
    const updated = registerConnection(manager, 'conn-1', config, schema);

    ok(updated.connections['conn-1'] !== undefined, 'registerConnection: adds connection');
    ok(updated.connections['conn-1'].config.password === '***', 'registerConnection: sanitizes password');
    ok(!JSON.stringify(updated.connections['conn-1'].config).includes('sup3rsecret'), 'registerConnection: raw password never stored');
    ok(updated.connections['conn-1'].schema.length === 2, 'registerConnection: stores schema');
    ok(updated.activeConnectionId === 'conn-1', 'registerConnection: first connection becomes active');

    // ---------- immutability ----------
    ok(Object.keys(manager.connections).length === 0, 'registerConnection: original manager unchanged (immutable)');
    ok(manager.activeConnectionId === null, 'registerConnection: original manager activeConnectionId unchanged');
  }

  // ---------- getActiveConnection ----------
  {
    const manager = createConnectorManager();
    ok(getActiveConnection(manager) === null, 'getActiveConnection: returns null on empty manager');
  }
  {
    let manager = createConnectorManager();
    manager = registerConnection(manager, 'conn-1', { type: 'sqlite', database: 'x.db' }, [{ tableName: 't' }]);
    const active = getActiveConnection(manager);
    ok(active !== null && active.connectionId === 'conn-1', 'getActiveConnection: returns active connection after registration');
  }

  // ---------- setActiveConnection ----------
  {
    let manager = createConnectorManager();
    manager = registerConnection(manager, 'conn-1', { type: 'sqlite', database: 'a.db' }, []);
    manager = registerConnection(manager, 'conn-2', { type: 'postgres', host: 'h', database: 'b' }, []);
    ok(manager.activeConnectionId === 'conn-1', 'setActiveConnection: sanity check before switching (conn-1 active)');

    const switched = setActiveConnection(manager, 'conn-2');
    ok(switched.activeConnectionId === 'conn-2', 'setActiveConnection: updates activeConnectionId');
    ok(manager.activeConnectionId === 'conn-1', 'setActiveConnection: does not mutate original manager');
  }
  {
    let manager = createConnectorManager();
    manager = registerConnection(manager, 'conn-1', { type: 'sqlite', database: 'a.db' }, []);
    const noop = setActiveConnection(manager, 'nonexistent');
    ok(noop.activeConnectionId === 'conn-1', 'setActiveConnection: no-op when connectionId not registered');
  }

  // ---------- removeConnection ----------
  {
    let manager = createConnectorManager();
    manager = registerConnection(manager, 'conn-1', { type: 'sqlite', database: 'a.db' }, []);
    manager = registerConnection(manager, 'conn-2', { type: 'postgres', host: 'h', database: 'b' }, []);
    const removed = removeConnection(manager, 'conn-1');
    ok(removed.connections['conn-1'] === undefined, 'removeConnection: removes the connection');
    ok(removed.activeConnectionId === 'conn-2', 'removeConnection: promotes remaining connection to active when active one removed');
    ok(manager.connections['conn-1'] !== undefined, 'removeConnection: does not mutate original manager');
  }
  {
    let manager = createConnectorManager();
    manager = registerConnection(manager, 'conn-1', { type: 'sqlite', database: 'a.db' }, []);
    const removed = removeConnection(manager, 'conn-1');
    ok(removed.activeConnectionId === null, 'removeConnection: activeConnectionId becomes null when last connection removed');
  }

  // ---------- listConnections ----------
  {
    let manager = createConnectorManager();
    manager = registerConnection(manager, 'conn-1', { type: 'sqlite', database: 'a.db' }, [{ tableName: 't1' }]);
    manager = registerConnection(manager, 'conn-2', { type: 'postgres', host: 'h', database: 'b', password: 'x' }, [{ tableName: 't1' }, { tableName: 't2' }]);
    const list = listConnections(manager);
    ok(list.length === 2, 'listConnections: returns all registered connections');
    const conn2 = list.find((c) => c.connectionId === 'conn-2');
    ok(conn2.tableCount === 2, 'listConnections: reports correct tableCount');
    ok(conn2.status === 'connected', 'listConnections: reports connected status');
    ok(conn2.config.password === '***', 'listConnections: sanitized config in listing');
  }

  // ---------- hasActiveConnection ----------
  {
    const manager = createConnectorManager();
    ok(hasActiveConnection(manager) === false, 'hasActiveConnection: returns false when empty');
  }
  {
    let manager = createConnectorManager();
    manager = registerConnection(manager, 'conn-1', { type: 'sqlite', database: 'a.db' }, []);
    ok(hasActiveConnection(manager) === true, 'hasActiveConnection: returns true when connection exists');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
