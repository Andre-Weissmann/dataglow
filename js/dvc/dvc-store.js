// ============================================================
// DataGlow Phase 10 — Data Version Control: Snapshot Store
// ============================================================
// In-memory snapshot registry for datasets. Each snapshot captures:
//   - The dataset's column schema (names + types)
//   - Per-column summary statistics (min, max, mean, nullCount, distinctCount)
//   - Row count and a lightweight content fingerprint (hash of stats)
//
// PRIVACY: Row data is NEVER stored in snapshots. Only schema + statistics.
// This keeps the store lightweight and safe to export without exposing PHI.
//
// Usage:
//   import { DVCStore } from './dvc-store.js';
//   const store = new DVCStore();
//   const id = store.snapshot(dataset, { label: 'Before dedup' });
//   store.list();             // all snapshots for a dataset
//   store.get(id);            // single snapshot
//   store.rollbackMeta(id);   // returns the schema/stats to restore from
//   store.exportJSON();       // portable JSON blob (no row data)
//   DVCStore.fromJSON(blob);  // restore a previously exported store
// ============================================================

export const DVC_VERSION = '1.0.0';

// ---- Types (JSDoc — no TypeScript in DataGlow) ----
/**
 * @typedef {Object} ColStats
 * @property {string} name
 * @property {string} type        - normalized type group (number|text|date|boolean|other)
 * @property {string} rawType     - original DuckDB type string
 * @property {number} nullCount
 * @property {number} distinctCount
 * @property {number|null} min    - numeric/date cols only (stored as number for dates)
 * @property {number|null} max
 * @property {number|null} mean   - numeric only
 * @property {number|null} stddev - numeric only
 */

/**
 * @typedef {Object} Snapshot
 * @property {string} id          - UUID-style unique id
 * @property {string} datasetName
 * @property {string} label       - user-provided label (e.g. "Before dedup")
 * @property {string} createdAt   - ISO timestamp
 * @property {number} rowCount
 * @property {string} fingerprint - short hash of stats for quick equality checks
 * @property {ColStats[]} cols
 * @property {Object} meta        - free-form user metadata
 */

// ============================================================
// Fingerprint — cheap content hash (no crypto API needed)
// ============================================================
function simpleHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function fingerprintSnapshot(rowCount, cols) {
  const sig = rowCount + '|' + cols.map(c =>
    [c.name, c.type, c.nullCount, c.distinctCount, c.min, c.max, c.mean].join(':')
  ).join('|');
  return simpleHash(sig);
}

// ============================================================
// ID generator
// ============================================================
function genId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return 'snap_' + ts + '_' + rand;
}

// ============================================================
// Statistics extractor
// Accepts either:
//   - An array of row objects: [{ col1: val, col2: val, ... }, ...]
//   - A DataGlow dataset object with .columns and .rows/.data
// ============================================================

/**
 * Normalize a type string to a type group.
 * Mirrors schema-context.js typeGroup for consistency.
 * @param {string} rawType
 * @returns {'number'|'text'|'date'|'boolean'|'other'}
 */
export function typeGroup(rawType) {
  if (!rawType) return 'other';
  const t = rawType.toUpperCase();
  if (/^(INT|TINYINT|SMALLINT|BIGINT|HUGEINT|UBIGINT|INTEGER|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)/.test(t)) return 'number';
  if (/^(VARCHAR|TEXT|STRING|CHAR|BPCHAR|BLOB|CATEGORY)/.test(t)) return 'text';
  if (/^(DATE|TIMESTAMP|TIME|INTERVAL)/.test(t)) return 'date';
  if (/^(BOOL|BOOLEAN)/.test(t)) return 'boolean';
  return 'other';
}

/**
 * Extract column statistics from a rows array.
 * @param {string} colName
 * @param {string} rawType
 * @param {Array} rows - array of row objects
 * @returns {ColStats}
 */
export function extractColStats(colName, rawType, rows) {
  const tg = typeGroup(rawType);
  let nullCount = 0;
  const seen = new Set();
  const numVals = [];

  for (const row of rows) {
    const v = row[colName];
    if (v === null || v === undefined || v === '') {
      nullCount++;
    } else {
      seen.add(String(v));
      if (tg === 'number') {
        const n = Number(v);
        if (!Number.isNaN(n)) numVals.push(n);
      }
    }
  }

  let min = null, max = null, mean = null, stddev = null;
  if (numVals.length > 0) {
    min = Math.min(...numVals);
    max = Math.max(...numVals);
    mean = numVals.reduce((a, b) => a + b, 0) / numVals.length;
    const variance = numVals.reduce((a, b) => a + (b - mean) ** 2, 0) / numVals.length;
    stddev = Math.sqrt(variance);
    // Round to 4 decimals to keep fingerprints stable
    mean = Math.round(mean * 10000) / 10000;
    stddev = Math.round(stddev * 10000) / 10000;
  }

  return {
    name: colName,
    type: tg,
    rawType: rawType || 'VARCHAR',
    nullCount,
    distinctCount: seen.size,
    min,
    max,
    mean,
    stddev,
  };
}

/**
 * Build a ColStats array from a DataGlow dataset object.
 * Handles multiple dataset shapes:
 *   { columns: [{name, type}], rows: [{...}], rowCount }
 *   { name, columns: ['col1', 'col2'], data: [[...], [...]] }
 * @param {Object} dataset
 * @returns {{ rowCount: number, cols: ColStats[] }}
 */
export function statsFromDataset(dataset) {
  if (!dataset) return { rowCount: 0, cols: [] };

  // Normalise rows to array-of-objects form
  let rows = [];
  let colDefs = [];

  if (Array.isArray(dataset.rows)) {
    rows = dataset.rows;
  } else if (Array.isArray(dataset.data)) {
    // Column-major or row-major arrays
    if (Array.isArray(dataset.columns) && dataset.data.length > 0 && !Array.isArray(dataset.data[0])) {
      // data is flat array treated as rows? unlikely — skip
    } else if (Array.isArray(dataset.data[0])) {
      // row-major: data[i] = row array
      const cols = (dataset.columns || []).map(c => (typeof c === 'string' ? c : c.name || c.col || String(c)));
      rows = dataset.data.map(row => {
        const obj = {};
        cols.forEach((c, i) => { obj[c] = row[i]; });
        return obj;
      });
    }
  } else if (Array.isArray(dataset) && dataset.length > 0 && typeof dataset[0] === 'object') {
    // dataset is already a rows array
    rows = dataset;
  }

  // Normalise column definitions
  const rawCols = dataset.columns || dataset.cols || [];
  colDefs = rawCols.map(c => {
    if (typeof c === 'string') return { name: c, rawType: 'VARCHAR' };
    return { name: c.name || c.col || String(c), rawType: c.type || c.column_type || c.rawType || 'VARCHAR' };
  });

  // If no colDefs but we have rows, derive from first row keys
  if (colDefs.length === 0 && rows.length > 0) {
    colDefs = Object.keys(rows[0]).map(k => ({ name: k, rawType: 'VARCHAR' }));
  }

  const rowCount = dataset.rowCount || rows.length;
  const cols = colDefs.map(def => extractColStats(def.name, def.rawType, rows));

  return { rowCount, cols };
}

// ============================================================
// DVCStore — the main store class
// ============================================================
export class DVCStore {
  constructor() {
    /** @type {Map<string, Snapshot>} */
    this._snapshots = new Map();
    /** @type {string} */
    this._version = DVC_VERSION;
  }

  // ------ Core API ------

  /**
   * Create a snapshot of a dataset. Stores schema + stats only — no row data.
   * @param {Object} dataset - DataGlow dataset object
   * @param {Object} opts
   * @param {string} [opts.label] - human label for this snapshot
   * @param {Object} [opts.meta] - free-form metadata
   * @returns {string} snapshot id
   */
  snapshot(dataset, opts = {}) {
    const name = (dataset && (dataset.name || dataset.tableName)) || 'unknown';
    const { rowCount, cols } = statsFromDataset(dataset);
    const fingerprint = fingerprintSnapshot(rowCount, cols);
    const id = genId();
    /** @type {Snapshot} */
    const snap = {
      id,
      datasetName: name,
      label: opts.label || ('Snapshot ' + new Date().toLocaleTimeString()),
      createdAt: new Date().toISOString(),
      rowCount,
      fingerprint,
      cols,
      meta: opts.meta || {},
    };
    this._snapshots.set(id, snap);
    return id;
  }

  /**
   * Get a single snapshot by id.
   * @param {string} id
   * @returns {Snapshot|null}
   */
  get(id) {
    return this._snapshots.get(id) || null;
  }

  /**
   * List all snapshots, optionally filtered by dataset name.
   * Returns newest-first.
   * @param {string} [datasetName]
   * @returns {Snapshot[]}
   */
  list(datasetName) {
    const all = Array.from(this._snapshots.values());
    const filtered = datasetName ? all.filter(s => s.datasetName === datasetName) : all;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Delete a snapshot.
   * @param {string} id
   * @returns {boolean}
   */
  remove(id) {
    return this._snapshots.delete(id);
  }

  /**
   * Update the label of a snapshot.
   * @param {string} id
   * @param {string} label
   */
  relabel(id, label) {
    const snap = this._snapshots.get(id);
    if (snap) snap.label = label;
  }

  /**
   * How many snapshots are stored (total or per dataset).
   * @param {string} [datasetName]
   * @returns {number}
   */
  count(datasetName) {
    return this.list(datasetName).length;
  }

  /**
   * Find snapshots with an identical fingerprint to the given snapshot.
   * Useful to detect "nothing changed" before snapshotting.
   * @param {string} id
   * @returns {Snapshot[]}
   */
  findDuplicates(id) {
    const snap = this.get(id);
    if (!snap) return [];
    return this.list(snap.datasetName).filter(s => s.id !== id && s.fingerprint === snap.fingerprint);
  }

  /**
   * Returns the schema + stats of a snapshot so the caller can decide
   * what a rollback means (DataGlow reloads the matching file / redo pipeline).
   * This store does NOT store row data, so rollback is advisory:
   * it tells you WHAT the data looked like, not the raw rows themselves.
   * @param {string} id
   * @returns {{ id, datasetName, label, createdAt, rowCount, cols, fingerprint }|null}
   */
  rollbackMeta(id) {
    const snap = this.get(id);
    if (!snap) return null;
    return {
      id: snap.id,
      datasetName: snap.datasetName,
      label: snap.label,
      createdAt: snap.createdAt,
      rowCount: snap.rowCount,
      cols: snap.cols,
      fingerprint: snap.fingerprint,
    };
  }

  // ------ Export / Import ------

  /**
   * Export all snapshots as a portable JSON blob (no row data — safe to save/share).
   * @returns {string}
   */
  exportJSON() {
    return JSON.stringify({
      _dvcVersion: this._version,
      _exportedAt: new Date().toISOString(),
      snapshots: Array.from(this._snapshots.values()),
    }, null, 2);
  }

  /**
   * Restore a store from a previously exported JSON blob.
   * @param {string|Object} json
   * @returns {DVCStore}
   */
  static fromJSON(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const store = new DVCStore();
    for (const snap of (data.snapshots || [])) {
      store._snapshots.set(snap.id, snap);
    }
    return store;
  }

  /**
   * Merge snapshots from another store into this one (union by id).
   * @param {DVCStore} other
   */
  merge(other) {
    for (const [id, snap] of other._snapshots) {
      if (!this._snapshots.has(id)) this._snapshots.set(id, snap);
    }
  }

  // ------ Convenience ------

  /**
   * Snapshot a dataset only if its fingerprint differs from the most recent snapshot.
   * Returns the id of the new snapshot, or null if nothing changed.
   * @param {Object} dataset
   * @param {Object} opts
   * @returns {string|null}
   */
  snapshotIfChanged(dataset, opts = {}) {
    const name = (dataset && (dataset.name || dataset.tableName)) || 'unknown';
    const existing = this.list(name);
    const { rowCount, cols } = statsFromDataset(dataset);
    const fp = fingerprintSnapshot(rowCount, cols);
    if (existing.length > 0 && existing[0].fingerprint === fp) return null;
    return this.snapshot(dataset, opts);
  }

  /**
   * Return a chronological timeline for a dataset (oldest first).
   * @param {string} datasetName
   * @returns {Snapshot[]}
   */
  timeline(datasetName) {
    return this.list(datasetName).reverse();
  }
}

// Singleton for use across DataGlow modules
export const dvcStore = new DVCStore();
