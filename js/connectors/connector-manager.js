// ============================================================
// DATAGLOW — Tauri Live Connector Layer: connector manager
// ============================================================
// Manages multiple simultaneous Tauri database connections — a user may be
// connected to a live Postgres warehouse AND a local SQLite file at the
// same time, with one of them marked "active" for SQL Mode queries. This
// module is PURE LOGIC and immutable: every function takes a manager and
// returns a NEW manager rather than mutating the one it was given, the same
// pattern the rest of DataGlow's session/state objects use (see
// js/nats/nats-bridge.js's session object). That makes it trivial to test
// (test/connectors/connector-manager.test.js) and safe to use from a
// framework-driven UI layer that expects immutable state updates (React,
// Svelte stores, etc.) without adapting.
//
// This module never imports js/connectors/tauri-connector.js and never
// calls invoke() itself — the caller is responsible for actually connecting
// via tauri-connector.js's connect()/disconnect() and then recording the
// outcome here with registerConnection()/removeConnection(). The manager's
// only job is bookkeeping across connections.
// ============================================================

/**
 * Creates a new, empty connector manager.
 * @returns {{ connections: Object<string, {config: object, schema: Array}>, activeConnectionId: string|null }}
 */
function createConnectorManager() {
  return {
    connections: {},
    activeConnectionId: null,
  };
}

/**
 * Registers a successful connection. The config is sanitized before being
 * stored, using the same sanitization rule as tauri-connector.js's
 * sanitizeConfig — but this module doesn't import that function; instead it
 * performs the same strip/mask inline so this module has zero dependency on
 * tauri-connector.js and can be tested/used completely standalone. If this
 * is the first connection registered, it also becomes the active one.
 *
 * @param {object} manager
 * @param {string} connectionId
 * @param {object} config
 * @param {Array} schema
 * @returns {object} a NEW manager (the input manager is left unmodified)
 */
function registerConnection(manager, connectionId, config, schema) {
  const current = manager || createConnectorManager();
  const sanitized = sanitizeConfigForStorage(config);

  const newConnections = {
    ...current.connections,
    [connectionId]: {
      config: sanitized,
      schema: Array.isArray(schema) ? schema : [],
      status: 'connected',
    },
  };

  return {
    connections: newConnections,
    activeConnectionId: current.activeConnectionId || connectionId,
  };
}

function sanitizeConfigForStorage(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'password') continue; // never stored, in any form
    if (k === 'username' && typeof v === 'string' && v.length > 0) {
      out[k] = v.length <= 2 ? '***' : `${v[0]}***${v[v.length - 1]}`;
      continue;
    }
    out[k] = v;
  }
  if (cfg.password !== undefined) out.password = '***';
  return out;
}

/**
 * Gets the currently active connection.
 * @param {object} manager
 * @returns {{ connectionId: string, config: object, schema: Array } | null}
 */
function getActiveConnection(manager) {
  const current = manager || createConnectorManager();
  if (!current.activeConnectionId) return null;
  const entry = current.connections[current.activeConnectionId];
  if (!entry) return null;
  return { connectionId: current.activeConnectionId, config: entry.config, schema: entry.schema };
}

/**
 * Sets the active connection. No-op (returns an equivalent manager) if the
 * requested connectionId is not currently registered.
 *
 * @param {object} manager
 * @param {string} connectionId
 * @returns {object} a NEW manager
 */
function setActiveConnection(manager, connectionId) {
  const current = manager || createConnectorManager();
  if (!current.connections[connectionId]) {
    return { connections: { ...current.connections }, activeConnectionId: current.activeConnectionId };
  }
  return { connections: { ...current.connections }, activeConnectionId: connectionId };
}

/**
 * Removes a connection. If the removed connection was active, the active
 * connection becomes the first remaining connection (by insertion order),
 * or null if none remain.
 *
 * @param {object} manager
 * @param {string} connectionId
 * @returns {object} a NEW manager
 */
function removeConnection(manager, connectionId) {
  const current = manager || createConnectorManager();
  const newConnections = { ...current.connections };
  delete newConnections[connectionId];

  let newActive = current.activeConnectionId;
  if (newActive === connectionId) {
    const remainingIds = Object.keys(newConnections);
    newActive = remainingIds.length > 0 ? remainingIds[0] : null;
  }

  return { connections: newConnections, activeConnectionId: newActive };
}

/**
 * Lists all registered connections.
 * @param {object} manager
 * @returns {Array<{ connectionId: string, config: object, tableCount: number, status: 'connected'|'disconnected' }>}
 */
function listConnections(manager) {
  const current = manager || createConnectorManager();
  return Object.entries(current.connections).map(([connectionId, entry]) => ({
    connectionId,
    config: entry.config,
    tableCount: Array.isArray(entry.schema) ? entry.schema.length : 0,
    status: entry.status || 'connected',
  }));
}

/**
 * Checks if any connection is available for SQL queries.
 * @param {object} manager
 * @returns {boolean}
 */
function hasActiveConnection(manager) {
  const current = manager || createConnectorManager();
  return Boolean(current.activeConnectionId && current.connections[current.activeConnectionId]);
}

export {
  createConnectorManager,
  registerConnection,
  getActiveConnection,
  setActiveConnection,
  removeConnection,
  listConnections,
  hasActiveConnection,
};
