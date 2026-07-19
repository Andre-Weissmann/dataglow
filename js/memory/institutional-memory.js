// ============================================================
// DATAGLOW — Institutional Memory Layer
// ============================================================
// Records every decision made in a DataGlow session — agent suggestions
// accepted/dismissed, validation resolutions, manual edits, SQL queries run,
// story exports, file loads, joins, renames, type overrides — in a flat,
// append-only, queryable log. This is the "survives analyst turnover"
// feature: a new analyst opening an old dataset should see exactly what was
// found, what was fixed, why, by whom (agent vs. human), and when.
//
// PURITY: pure logic — no DOM, no browser APIs (no OPFS, no localStorage),
// no file I/O, no network, no crypto library. The caller owns persistence:
// serialize the returned store to OPFS (browser) or the file system (Tauri
// desktop shell), and reload it into memory before calling into this module
// again. This mirrors the purity discipline used across js/provenance/ and
// js/trust/ — identical behavior in the browser, the Tauri webview, and
// headless Node tests.
//
// IMMUTABLE APPEND PATTERN: appendRecord never mutates the store passed in —
// it returns a brand-new store object with a brand-new records array. This
// is safe to drop straight into React (or any reactive framework) state, and
// makes it trivial to reason about "what did the store look like before this
// decision was recorded" for undo/redo or audit purposes.
//
// PROVENANCE HASH: computeProvenanceHash is a simple djb2 hash over the
// deterministically-sorted JSON of a dataset's records. It is NOT
// cryptographic — it is a cheap, dependency-free tamper-evidence signal
// suitable for Proof Export today. A caller that needs real cryptographic
// guarantees can wrap the same canonical serialization with SubtleCrypto
// (see js/provenance/provenance.js's sha256Hex for the pattern this codebase
// already uses elsewhere) without changing this module's contract.
//
// FORWARD COMPATIBILITY: mergeStores exists for DataGlow Rooms (Feature 11,
// future PR) — two peers each holding their own memory store need a
// deterministic way to reconcile histories without losing either side's
// decisions. It deduplicates by record id and sorts by timestamp.

// ---- Record types -------------------------------------------------------

export const RECORD_TYPES = Object.freeze({
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
  TYPE_OVERRIDDEN: 'type_overridden',
});

const VALID_RECORD_TYPES = new Set(Object.values(RECORD_TYPES));
const VALID_ACTORS = new Set(['agent', 'human']);

export const MEMORY_STORE_VERSION = 1;

// ---- Small internal helpers ----------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deterministic-ish unique id: millis timestamp + random suffix. Not a real
// UUID (no external dependency needed for this pure-logic module) but unique
// enough for a single-session, single-browser append-only log, and stable in
// sort order by creation time as a nice side effect.
function generateId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

function generateSessionId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `session-${Date.now().toString(36)}-${rand}`;
}

function nowIso() {
  return new Date().toISOString();
}

// Canonical, order-independent JSON serialization of a record for hashing —
// mirrors the canonicalJSON discipline used in js/provenance/*.js so the same
// logical record always serializes identically regardless of key insertion
// order or undefined-vs-missing key quirks.
function canonicalRecordPayload(record) {
  const safe = {
    id: record.id ?? null,
    type: record.type ?? null,
    actor: record.actor ?? null,
    datasetId: record.datasetId ?? null,
    column: record.column ?? null,
    row: record.row ?? null,
    before: record.before === undefined ? null : record.before,
    after: record.after === undefined ? null : record.after,
    reason: record.reason ?? null,
    sql: record.sql ?? null,
    metadata: record.metadata ?? null,
    timestamp: record.timestamp ?? null,
    sessionId: record.sessionId ?? null,
  };
  return JSON.stringify(safe, Object.keys(safe).sort());
}

// djb2 string hash — simple, fast, dependency-free, deterministic. No crypto
// dependency; a caller needing cryptographic tamper-evidence can wrap the
// same canonical serialization with SubtleCrypto. Returned as an unsigned
// 32-bit hex string prefixed with the algorithm name so it's self-describing
// in exported provenance artifacts.
function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  // Force unsigned 32-bit representation.
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ---- createMemoryStore ----------------------------------------------------

export function createMemoryStore(options = {}) {
  return {
    records: [],
    version: MEMORY_STORE_VERSION,
    createdAt: nowIso(),
    sessionId: options.sessionId || generateSessionId(),
  };
}

// ---- appendRecord ----------------------------------------------------------

export function appendRecord(store, record) {
  if (!isPlainObject(store)) {
    throw new TypeError('appendRecord: store must be a plain object (use createMemoryStore())');
  }
  if (!isPlainObject(record)) {
    throw new TypeError('appendRecord: record must be a plain object');
  }
  if (!VALID_RECORD_TYPES.has(record.type)) {
    throw new TypeError(`appendRecord: record.type must be one of ${[...VALID_RECORD_TYPES].join(', ')}`);
  }
  if (!VALID_ACTORS.has(record.actor)) {
    throw new TypeError('appendRecord: record.actor must be "agent" or "human"');
  }

  const fullRecord = {
    ...record,
    id: generateId(),
    timestamp: nowIso(),
    sessionId: record.sessionId || store.sessionId || generateSessionId(),
  };

  return {
    ...store,
    records: [...store.records, fullRecord],
  };
}

// ---- queryRecords ----------------------------------------------------------

export function queryRecords(store, filter = {}) {
  if (!isPlainObject(store) || !Array.isArray(store.records)) return [];

  const {
    type,
    actor,
    datasetId,
    column,
    fromTimestamp,
    toTimestamp,
    limit,
  } = filter;

  let results = store.records.filter((r) => {
    if (type !== undefined && r.type !== type) return false;
    if (actor !== undefined && r.actor !== actor) return false;
    if (datasetId !== undefined && r.datasetId !== datasetId) return false;
    if (column !== undefined && r.column !== column) return false;
    if (fromTimestamp !== undefined && !(r.timestamp >= fromTimestamp)) return false;
    if (toTimestamp !== undefined && !(r.timestamp <= toTimestamp)) return false;
    return true;
  });

  // Newest first.
  results = results.slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  if (typeof limit === 'number' && limit >= 0) {
    results = results.slice(0, limit);
  }

  return results;
}

// ---- summarizeMemory ---------------------------------------------------

export function summarizeMemory(store, datasetId) {
  const records = isPlainObject(store) && Array.isArray(store.records)
    ? store.records.filter((r) => datasetId === undefined || r.datasetId === datasetId)
    : [];

  let agentFixes = 0;
  let humanEdits = 0;
  let dismissals = 0;
  let validationsResolved = 0;
  let lastActivity = null;
  const columnCounts = new Map();

  for (const r of records) {
    if (r.type === RECORD_TYPES.AGENT_FIX_ACCEPTED) agentFixes++;
    if (r.type === RECORD_TYPES.MANUAL_EDIT) humanEdits++;
    if (r.type === RECORD_TYPES.AGENT_FIX_DISMISSED || r.type === RECORD_TYPES.VALIDATION_DISMISSED) dismissals++;
    if (r.type === RECORD_TYPES.VALIDATION_RESOLVED) validationsResolved++;

    if (r.column) {
      columnCounts.set(r.column, (columnCounts.get(r.column) || 0) + 1);
    }

    if (!lastActivity || r.timestamp > lastActivity) {
      lastActivity = r.timestamp;
    }
  }

  const topColumns = [...columnCounts.entries()]
    .map(([column, decisionCount]) => ({ column, decisionCount }))
    .sort((a, b) => b.decisionCount - a.decisionCount || a.column.localeCompare(b.column));

  return {
    totalDecisions: records.length,
    agentFixes,
    humanEdits,
    dismissals,
    validationsResolved,
    lastActivity,
    topColumns,
  };
}

// ---- generateTimeline ----------------------------------------------------

function formatDisplayTimestamp(iso) {
  if (!iso) return '';
  // "2026-07-19 10:14" style — deterministic, no locale dependency.
  return iso.replace('T', ' ').slice(0, 16);
}

function describeRecord(r) {
  const ts = formatDisplayTimestamp(r.timestamp);
  const who = r.actor === 'agent' ? 'Agent' : 'Analyst';

  switch (r.type) {
    case RECORD_TYPES.AGENT_FIX_ACCEPTED: {
      const count = r.metadata && r.metadata.count !== undefined ? r.metadata.count : null;
      const col = r.column ? ` in ${r.column}` : '';
      const countStr = count !== null ? `${count} ` : '';
      const reason = r.reason ? ` — ${r.reason}` : '';
      return `Agent fixed ${countStr}values${col}${reason ? '' : ''} — accepted by analyst (${ts})${reason}`;
    }
    case RECORD_TYPES.AGENT_FIX_DISMISSED: {
      const col = r.column ? ` in ${r.column}` : '';
      const reason = r.reason ? ` — ${r.reason}` : '';
      return `Agent fix${col} dismissed by analyst (${ts})${reason}`;
    }
    case RECORD_TYPES.MANUAL_EDIT: {
      const col = r.column ? ` in ${r.column}` : '';
      const rowStr = r.row !== undefined && r.row !== null ? ` (row ${r.row})` : '';
      return `${who} manually edited ${col ? col.trim() : 'a value'}${rowStr} (${ts})`;
    }
    case RECORD_TYPES.VALIDATION_RESOLVED: {
      const col = r.column ? ` on ${r.column}` : '';
      const reason = r.reason ? ` — ${r.reason}` : '';
      return `Validation issue${col} resolved by ${who.toLowerCase()} (${ts})${reason}`;
    }
    case RECORD_TYPES.VALIDATION_DISMISSED: {
      const col = r.column ? ` on ${r.column}` : '';
      const reason = r.reason ? ` — ${r.reason}` : '';
      return `Validation issue${col} dismissed by ${who.toLowerCase()} (${ts})${reason}`;
    }
    case RECORD_TYPES.SQL_QUERY: {
      const sql = r.sql ? r.sql : '(no SQL captured)';
      const rows = r.metadata && r.metadata.rowCount !== undefined ? ` (returned ${r.metadata.rowCount} rows)` : '';
      return `SQL query run: ${sql}${rows} (${ts})`;
    }
    case RECORD_TYPES.STORY_EXPORTED: {
      const title = r.metadata && r.metadata.title ? ` "${r.metadata.title}"` : '';
      return `Story${title} exported by ${who.toLowerCase()} (${ts})`;
    }
    case RECORD_TYPES.FILE_LOADED: {
      const name = r.metadata && r.metadata.fileName ? r.metadata.fileName : (r.datasetId || 'file');
      return `File loaded: ${name} (${ts})`;
    }
    case RECORD_TYPES.JOIN_CREATED: {
      const desc = r.metadata && r.metadata.description ? r.metadata.description : 'join created';
      return `Join created: ${desc} (${ts})`;
    }
    case RECORD_TYPES.COLUMN_RENAMED: {
      const before = r.before !== undefined && r.before !== null ? r.before : '?';
      const after = r.after !== undefined && r.after !== null ? r.after : '?';
      return `Column renamed: ${before} → ${after} by ${who.toLowerCase()} (${ts})`;
    }
    case RECORD_TYPES.TYPE_OVERRIDDEN: {
      const col = r.column ? r.column : 'column';
      const before = r.before !== undefined && r.before !== null ? r.before : '?';
      const after = r.after !== undefined && r.after !== null ? r.after : '?';
      return `Type override: ${col} changed from ${before} to ${after} by ${who.toLowerCase()} (${ts})`;
    }
    default:
      return `${who} action (${r.type}) recorded (${ts})`;
  }
}

export function generateTimeline(store, datasetId, options = {}) {
  const { maxEntries, includeTypes, actorFilter } = options;

  let records = queryRecords(store, {
    datasetId,
    type: undefined,
  });

  if (Array.isArray(includeTypes) && includeTypes.length > 0) {
    const allow = new Set(includeTypes);
    records = records.filter((r) => allow.has(r.type));
  }

  if (actorFilter) {
    records = records.filter((r) => r.actor === actorFilter);
  }

  if (typeof maxEntries === 'number' && maxEntries >= 0) {
    records = records.slice(0, maxEntries);
  }

  return records.map(describeRecord);
}

// ---- computeProvenanceHash ------------------------------------------------

export function computeProvenanceHash(store, datasetId) {
  const records = isPlainObject(store) && Array.isArray(store.records)
    ? store.records.filter((r) => datasetId === undefined || r.datasetId === datasetId)
    : [];

  // Sort deterministically by id (unique + monotonic-ish by creation) so hash
  // does not depend on original insertion order (relevant post-merge/prune).
  const sorted = records
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(canonicalRecordPayload);

  const serialized = JSON.stringify(sorted);
  return `djb2:${djb2(serialized)}`;
}

// ---- pruneStore -----------------------------------------------------------

export function pruneStore(store, options = {}) {
  const { maxRecords = 1000, keepTypes = ['file_loaded', 'story_exported'] } = options;

  if (!isPlainObject(store) || !Array.isArray(store.records)) {
    return { ...createMemoryStore(), ...(isPlainObject(store) ? store : {}), records: [] };
  }

  const keepSet = new Set(keepTypes);

  const sortedByTimeDesc = store.records
    .slice()
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  const kept = new Map(); // id -> record, preserves uniqueness

  // Always keep anchor types, regardless of age.
  for (const r of store.records) {
    if (keepSet.has(r.type)) {
      kept.set(r.id, r);
    }
  }

  // Fill remaining budget with the most recent records (of any type),
  // without exceeding maxRecords total.
  for (const r of sortedByTimeDesc) {
    if (kept.size >= maxRecords) break;
    if (!kept.has(r.id)) {
      kept.set(r.id, r);
    }
  }

  const prunedRecords = [...kept.values()].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  return {
    ...store,
    records: prunedRecords,
  };
}

// ---- mergeStores ----------------------------------------------------------

export function mergeStores(storeA, storeB) {
  const recordsA = isPlainObject(storeA) && Array.isArray(storeA.records) ? storeA.records : [];
  const recordsB = isPlainObject(storeB) && Array.isArray(storeB.records) ? storeB.records : [];

  const byId = new Map();
  for (const r of recordsA) byId.set(r.id, r);
  for (const r of recordsB) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }

  const merged = [...byId.values()].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  const createdAtA = isPlainObject(storeA) ? storeA.createdAt : undefined;
  const createdAtB = isPlainObject(storeB) ? storeB.createdAt : undefined;
  const earliestCreatedAt = [createdAtA, createdAtB].filter(Boolean).sort()[0] || nowIso();

  return {
    version: MEMORY_STORE_VERSION,
    createdAt: earliestCreatedAt,
    sessionId: `merged-${(isPlainObject(storeA) && storeA.sessionId) || 'a'}-${(isPlainObject(storeB) && storeB.sessionId) || 'b'}`,
    records: merged,
  };
}

// ---- exportNDJSON / importNDJSON -------------------------------------------

export function exportNDJSON(store, datasetId) {
  const records = isPlainObject(store) && Array.isArray(store.records)
    ? store.records.filter((r) => datasetId === undefined || r.datasetId === datasetId)
    : [];

  return records.map((r) => JSON.stringify(r)).join('\n');
}

const REQUIRED_IMPORT_FIELDS = ['id', 'type', 'actor', 'timestamp'];

export function importNDJSON(ndjson) {
  const store = createMemoryStore();
  const records = [];

  if (typeof ndjson !== 'string' || ndjson.trim() === '') {
    return { ...store, records };
  }

  const lines = ndjson.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed JSON line
    }

    if (!isPlainObject(parsed)) continue;
    if (!REQUIRED_IMPORT_FIELDS.every((f) => parsed[f] !== undefined && parsed[f] !== null)) continue;
    if (!VALID_RECORD_TYPES.has(parsed.type)) continue;
    if (!VALID_ACTORS.has(parsed.actor)) continue;

    records.push(parsed);
  }

  records.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  return {
    ...store,
    records,
  };
}
