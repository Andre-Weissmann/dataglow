/* DataGlow — js/memory/institutional-memory.js */
/* Part of structured refactor — see src/ directory */

var InstitutionalMemory = (function () {
    var RECORD_TYPES = Object.freeze({
      AGENT_FIX_ACCEPTED: 'agent_fix_accepted',
      AGENT_FIX_DISMISSED: 'agent_fix_dismissed',
      MANUAL_EDIT: 'manual_edit',
      VALIDATION_RESOLVED: 'validation_resolved',
      VALIDATION_DISMISSED: 'validation_dismissed',
      SQL_QUERY: 'sql_query',
      STORY_EXPORTED: 'story_exported',
      FILE_LOADED: 'file_loaded',
      JOIN_CREATED: 'join_created',
      COLUMN_RENAMED: 'column_renamed',
      TYPE_OVERRIDDEN: 'type_overridden'
    });
    var VALID_RECORD_TYPES = {};
    Object.keys(RECORD_TYPES).forEach(function (k) { VALID_RECORD_TYPES[RECORD_TYPES[k]] = true; });
    var VALID_ACTORS = { agent: true, human: true };
    var MEMORY_STORE_VERSION = 1;

    function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

    function generateId() {
      var rand = Math.random().toString(36).slice(2, 10);
      return Date.now().toString(36) + '-' + rand;
    }
    function generateSessionId() {
      var rand = Math.random().toString(36).slice(2, 10);
      return 'session-' + Date.now().toString(36) + '-' + rand;
    }
    function nowIso() { return new Date().toISOString(); }

    function canonicalRecordPayload(record) {
      var safe = {
        id: record.id == null ? null : record.id,
        type: record.type == null ? null : record.type,
        actor: record.actor == null ? null : record.actor,
        datasetId: record.datasetId == null ? null : record.datasetId,
        column: record.column == null ? null : record.column,
        row: record.row == null ? null : record.row,
        before: record.before === undefined ? null : record.before,
        after: record.after === undefined ? null : record.after,
        reason: record.reason == null ? null : record.reason,
        sql: record.sql == null ? null : record.sql,
        metadata: record.metadata == null ? null : record.metadata,
        timestamp: record.timestamp == null ? null : record.timestamp,
        sessionId: record.sessionId == null ? null : record.sessionId
      };
      return JSON.stringify(safe, Object.keys(safe).sort());
    }

    function djb2(str) {
      var hash = 5381;
      for (var i = 0; i < str.length; i++) {
        hash = (hash * 33) ^ str.charCodeAt(i);
      }
      return (hash >>> 0).toString(16).padStart ? (hash >>> 0).toString(16).padStart(8, '0') : (hash >>> 0).toString(16);
    }

    function createMemoryStore(options) {
      options = options || {};
      return {
        records: [],
        version: MEMORY_STORE_VERSION,
        createdAt: nowIso(),
        sessionId: options.sessionId || generateSessionId()
      };
    }

    function appendRecord(store, record) {
      if (!isPlainObject(store)) throw new TypeError('appendRecord: store must be a plain object (use createMemoryStore())');
      if (!isPlainObject(record)) throw new TypeError('appendRecord: record must be a plain object');
      if (!VALID_RECORD_TYPES[record.type]) throw new TypeError('appendRecord: record.type must be a valid RECORD_TYPES value');
      if (!VALID_ACTORS[record.actor]) throw new TypeError('appendRecord: record.actor must be "agent" or "human"');

      var fullRecord = Object.assign({}, record, {
        id: generateId(),
        timestamp: nowIso(),
        sessionId: record.sessionId || store.sessionId || generateSessionId()
      });

      return Object.assign({}, store, { records: store.records.concat([fullRecord]) });
    }

    function queryRecords(store, filter) {
      filter = filter || {};
      if (!isPlainObject(store) || !Array.isArray(store.records)) return [];

      var type = filter.type, actor = filter.actor, datasetId = filter.datasetId, column = filter.column,
          fromTimestamp = filter.fromTimestamp, toTimestamp = filter.toTimestamp, limit = filter.limit;

      var results = store.records.filter(function (r) {
        if (type !== undefined && r.type !== type) return false;
        if (actor !== undefined && r.actor !== actor) return false;
        if (datasetId !== undefined && r.datasetId !== datasetId) return false;
        if (column !== undefined && r.column !== column) return false;
        if (fromTimestamp !== undefined && !(r.timestamp >= fromTimestamp)) return false;
        if (toTimestamp !== undefined && !(r.timestamp <= toTimestamp)) return false;
        return true;
      });

      results = results.slice().sort(function (a, b) { return a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0; });

      if (typeof limit === 'number' && limit >= 0) results = results.slice(0, limit);
      return results;
    }

    function summarizeMemory(store, datasetId) {
      var records = (isPlainObject(store) && Array.isArray(store.records))
        ? store.records.filter(function (r) { return datasetId === undefined || r.datasetId === datasetId; })
        : [];

      var agentFixes = 0, humanEdits = 0, dismissals = 0, validationsResolved = 0, lastActivity = null;
      var columnCounts = {};

      records.forEach(function (r) {
        if (r.type === RECORD_TYPES.AGENT_FIX_ACCEPTED) agentFixes++;
        if (r.type === RECORD_TYPES.MANUAL_EDIT) humanEdits++;
        if (r.type === RECORD_TYPES.AGENT_FIX_DISMISSED || r.type === RECORD_TYPES.VALIDATION_DISMISSED) dismissals++;
        if (r.type === RECORD_TYPES.VALIDATION_RESOLVED) validationsResolved++;
        if (r.column) columnCounts[r.column] = (columnCounts[r.column] || 0) + 1;
        if (!lastActivity || r.timestamp > lastActivity) lastActivity = r.timestamp;
      });

      var topColumns = Object.keys(columnCounts)
        .map(function (column) { return { column: column, decisionCount: columnCounts[column] }; })
        .sort(function (a, b) { return b.decisionCount - a.decisionCount || a.column.localeCompare(b.column); });

      return {
        totalDecisions: records.length,
        agentFixes: agentFixes,
        humanEdits: humanEdits,
        dismissals: dismissals,
        validationsResolved: validationsResolved,
        lastActivity: lastActivity,
        topColumns: topColumns
      };
    }

    function formatDisplayTimestamp(iso) {
      if (!iso) return '';
      return iso.replace('T', ' ').slice(0, 16);
    }

    function describeRecord(r) {
      var ts = formatDisplayTimestamp(r.timestamp);
      var who = r.actor === 'agent' ? 'Agent' : 'Analyst';

      switch (r.type) {
        case RECORD_TYPES.AGENT_FIX_ACCEPTED: {
          var count = r.metadata && r.metadata.count !== undefined ? r.metadata.count : null;
          var col = r.column ? (' in ' + r.column) : '';
          var countStr = count !== null ? (count + ' ') : '';
          var reason = r.reason ? ('  -  ' + r.reason) : '';
          return 'Agent fixed ' + countStr + 'values' + col + '  -  accepted by analyst (' + ts + ')' + reason;
        }
        case RECORD_TYPES.AGENT_FIX_DISMISSED: {
          var col2 = r.column ? (' in ' + r.column) : '';
          var reason2 = r.reason ? ('  -  ' + r.reason) : '';
          return 'Agent fix' + col2 + ' dismissed by analyst (' + ts + ')' + reason2;
        }
        case RECORD_TYPES.MANUAL_EDIT: {
          var col3 = r.column ? (' ' + r.column) : ' a value';
          var rowStr = (r.row !== undefined && r.row !== null) ? (' (row ' + r.row + ')') : '';
          return who + ' manually edited' + col3 + rowStr + ' (' + ts + ')';
        }
        case RECORD_TYPES.VALIDATION_RESOLVED: {
          var col4 = r.column ? (' on ' + r.column) : '';
          var reason4 = r.reason ? ('  -  ' + r.reason) : '';
          return 'Validation issue' + col4 + ' resolved by ' + who.toLowerCase() + ' (' + ts + ')' + reason4;
        }
        case RECORD_TYPES.VALIDATION_DISMISSED: {
          var col5 = r.column ? (' on ' + r.column) : '';
          var reason5 = r.reason ? ('  -  ' + r.reason) : '';
          return 'Validation issue' + col5 + ' dismissed by ' + who.toLowerCase() + ' (' + ts + ')' + reason5;
        }
        case RECORD_TYPES.SQL_QUERY: {
          var sql = r.sql ? r.sql : '(no SQL captured)';
          var rows = (r.metadata && r.metadata.rowCount !== undefined) ? (' (returned ' + r.metadata.rowCount + ' rows)') : '';
          return 'SQL query run: ' + sql + rows + ' (' + ts + ')';
        }
        case RECORD_TYPES.STORY_EXPORTED: {
          var title = (r.metadata && r.metadata.title) ? (' "' + r.metadata.title + '"') : '';
          return 'Story' + title + ' exported by ' + who.toLowerCase() + ' (' + ts + ')';
        }
        case RECORD_TYPES.FILE_LOADED: {
          var name = (r.metadata && r.metadata.fileName) ? r.metadata.fileName : (r.datasetId || 'file');
          return 'File loaded: ' + name + ' (' + ts + ')';
        }
        case RECORD_TYPES.JOIN_CREATED: {
          var desc = (r.metadata && r.metadata.description) ? r.metadata.description : 'join created';
          return 'Join created: ' + desc + ' (' + ts + ')';
        }
        case RECORD_TYPES.COLUMN_RENAMED: {
          var before = (r.before !== undefined && r.before !== null) ? r.before : '?';
          var after = (r.after !== undefined && r.after !== null) ? r.after : '?';
          return 'Column renamed: ' + before + ' → ' + after + ' by ' + who.toLowerCase() + ' (' + ts + ')';
        }
        case RECORD_TYPES.TYPE_OVERRIDDEN: {
          var col6 = r.column ? r.column : 'column';
          var before2 = (r.before !== undefined && r.before !== null) ? r.before : '?';
          var after2 = (r.after !== undefined && r.after !== null) ? r.after : '?';
          return 'Type override: ' + col6 + ' changed from ' + before2 + ' to ' + after2 + ' by ' + who.toLowerCase() + ' (' + ts + ')';
        }
        default:
          return who + ' action (' + r.type + ') recorded (' + ts + ')';
      }
    }

    function generateTimeline(store, datasetId, options) {
      options = options || {};
      var maxEntries = options.maxEntries, includeTypes = options.includeTypes, actorFilter = options.actorFilter;

      var records = queryRecords(store, { datasetId: datasetId, type: undefined });

      if (Array.isArray(includeTypes) && includeTypes.length > 0) {
        var allow = {};
        includeTypes.forEach(function (t) { allow[t] = true; });
        records = records.filter(function (r) { return allow[r.type]; });
      }
      if (actorFilter) records = records.filter(function (r) { return r.actor === actorFilter; });
      if (typeof maxEntries === 'number' && maxEntries >= 0) records = records.slice(0, maxEntries);

      return records.map(describeRecord);
    }

    function computeProvenanceHash(store, datasetId) {
      var records = (isPlainObject(store) && Array.isArray(store.records))
        ? store.records.filter(function (r) { return datasetId === undefined || r.datasetId === datasetId; })
        : [];

      var sorted = records.slice()
        .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; })
        .map(canonicalRecordPayload);

      var serialized = JSON.stringify(sorted);
      return 'djb2:' + djb2(serialized);
    }

    return {
      RECORD_TYPES: RECORD_TYPES,
      createMemoryStore: createMemoryStore,
      appendRecord: appendRecord,
      queryRecords: queryRecords,
      summarizeMemory: summarizeMemory,
      generateTimeline: generateTimeline,
      computeProvenanceHash: computeProvenanceHash
    };
