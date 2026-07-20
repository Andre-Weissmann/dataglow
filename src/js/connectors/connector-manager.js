/* DataGlow — js/connectors/connector-manager.js */
/* Part of structured refactor — see src/ directory */

var ConnectorManager = (function () {
    function createConnectorManager() {
      return {
        connections: {},
        activeConnectionId: null
      };
    }

    function sanitizeConfigForStorage(config) {
      var cfg = config && typeof config === 'object' ? config : {};
      var out = {};
      Object.keys(cfg).forEach(function (k) {
        if (k === 'password') return;
        var v = cfg[k];
        if (k === 'username' && typeof v === 'string' && v.length > 0) {
          out[k] = v.length <= 2 ? '***' : (v[0] + '***' + v[v.length - 1]);
          return;
        }
        out[k] = v;
      });
      if (cfg.password !== undefined) out.password = '***';
      return out;
    }

    function registerConnection(manager, connectionId, config, schema) {
      var current = manager || createConnectorManager();
      var sanitized = sanitizeConfigForStorage(config);

      var newConnections = Object.assign({}, current.connections);
      newConnections[connectionId] = {
        config: sanitized,
        schema: Array.isArray(schema) ? schema : [],
        status: 'connected'
      };

      return {
        connections: newConnections,
        activeConnectionId: current.activeConnectionId || connectionId
      };
    }

    function getActiveConnection(manager) {
      var current = manager || createConnectorManager();
      if (!current.activeConnectionId) return null;
      var entry = current.connections[current.activeConnectionId];
      if (!entry) return null;
      return { connectionId: current.activeConnectionId, config: entry.config, schema: entry.schema };
    }

    function setActiveConnection(manager, connectionId) {
      var current = manager || createConnectorManager();
      if (!current.connections[connectionId]) {
        return { connections: Object.assign({}, current.connections), activeConnectionId: current.activeConnectionId };
      }
      return { connections: Object.assign({}, current.connections), activeConnectionId: connectionId };
    }

    function removeConnection(manager, connectionId) {
      var current = manager || createConnectorManager();
      var newConnections = Object.assign({}, current.connections);
      delete newConnections[connectionId];

      var newActive = current.activeConnectionId;
      if (newActive === connectionId) {
        var remainingIds = Object.keys(newConnections);
        newActive = remainingIds.length > 0 ? remainingIds[0] : null;
      }

      return { connections: newConnections, activeConnectionId: newActive };
    }

    function listConnections(manager) {
      var current = manager || createConnectorManager();
      return Object.keys(current.connections).map(function (connectionId) {
        var entry = current.connections[connectionId];
        return {
          connectionId: connectionId,
          config: entry.config,
          tableCount: Array.isArray(entry.schema) ? entry.schema.length : 0,
          status: entry.status || 'connected'
        };
      });
    }

    function hasActiveConnection(manager) {
      var current = manager || createConnectorManager();
      return Boolean(current.activeConnectionId && current.connections[current.activeConnectionId]);
    }

    return {
      createConnectorManager: createConnectorManager,
      registerConnection: registerConnection,
      getActiveConnection: getActiveConnection,
      setActiveConnection: setActiveConnection,
      removeConnection: removeConnection,
      listConnections: listConnections,
      hasActiveConnection: hasActiveConnection
    };
  })();

  /* ============================================================
     FEATURE FLAGS
     ------------------------------------------------------------
     All default false. Flip to true to enable a wired-in module.
     See <!-- FEATURE: name --> comments in the markup above and
     the event-listener sections below for each feature's wiring.
     ============================================================ */