// ============================================================
// DATAGLOW — IndexedDB Local Memory Store
// Anti-degradation architecture: bounded, versioned, LRU-evicted.
// Runs entirely in-browser via the native indexedDB API — no library.
// ============================================================

const DB_NAME = 'dataglow_memory';
const DB_VERSION = 6;
const STORE_PROFILES = 'columnProfiles';
const STORE_RULES = 'approvedRules';
const STORE_BASELINES = 'datasetBaselines';
const STORE_LEARNED = 'learnedCorrections';
const STORE_FP_HISTORY = 'fingerprintHistory';
const STORE_LEDGER = 'meetingDecisionLedger';
const STORE_QUERY_MEMORY = 'queryMemoryLog';
const STORE_CANVAS_LAYOUTS = 'canvasLayouts';

// Ledger entries are append-only and can accumulate across many meetings;
// cap so an unbounded history can't grow the local database without limit.
// Oldest entries (by recordedAt) are evicted first once over the cap.
const LEDGER_CAP = 5000;

// Query Memory entries are append-only (one per run) and could accumulate over a
// long working session; cap so the local log can't grow unbounded. Oldest
// entries (by ts) are evicted first once over the cap — same discipline as the
// ledger above. Keyed by the run fingerprint, not unique: the SAME query run
// again appends a NEW entry so the count/history is preserved.
const QUERY_MEMORY_CAP = 10000;

const PROFILE_CAP = 200; // hard cap; evict least-recently-used beyond this
// Bounded per-schema history depth for Forecast-Based Drift Alerting — mirrors
// FORECAST_HISTORY_CAP in js/drift-forecast.js (kept in sync; not imported here
// to keep this browser-only store dependency-free).
const FP_HISTORY_CAP = 24;

let dbPromise = null;

// Wrap an IDBRequest in a Promise.
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Wrap a transaction's completion in a Promise.
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function initMemoryStore() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB is not available in this environment.'));
      return;
    }
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE_PROFILES)) {
        db.createObjectStore(STORE_PROFILES, { keyPath: 'columnNameHash' });
      }
      if (!db.objectStoreNames.contains(STORE_RULES)) {
        db.createObjectStore(STORE_RULES, { keyPath: 'ruleName' });
      }
      if (!db.objectStoreNames.contains(STORE_BASELINES)) {
        db.createObjectStore(STORE_BASELINES, { keyPath: 'fingerprintHash' });
      }
      if (!db.objectStoreNames.contains(STORE_LEARNED)) {
        db.createObjectStore(STORE_LEARNED, { keyPath: 'modelId' });
      }
      if (!db.objectStoreNames.contains(STORE_FP_HISTORY)) {
        db.createObjectStore(STORE_FP_HISTORY, { keyPath: 'fingerprintHash' });
      }
      if (!db.objectStoreNames.contains(STORE_LEDGER)) {
        // sourceKey is stable per spoken moment / action item (see
        // js/agents/meeting-decision-ledger.js), but is NOT declared unique
        // here — resolving an action item later appends a new entry with the
        // same sourceKey rather than overwriting, so history is never lost.
        // autoIncrement keyPath keeps every append distinct.
        const ledgerStore = db.createObjectStore(STORE_LEDGER, { keyPath: '_id', autoIncrement: true });
        ledgerStore.createIndex('sourceKey', 'sourceKey', { unique: false });
        ledgerStore.createIndex('meetingId', 'meetingId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_QUERY_MEMORY)) {
        // Query Memory log (js/provenance/query-memory.js supplies the pure
        // fingerprint + entry-building logic; this file only stores/retrieves the
        // resulting plain objects). autoIncrement keyPath keeps every append
        // distinct; the `fingerprint` index is NON-unique so the same query run
        // again appends a new entry (preserving count/history) rather than
        // overwriting — the read path filters by fingerprint for a fast lookup.
        const queryMemoryStore = db.createObjectStore(STORE_QUERY_MEMORY, { keyPath: '_id', autoIncrement: true });
        queryMemoryStore.createIndex('fingerprint', 'fingerprint', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CANVAS_LAYOUTS)) {
        // Saved Glow Canvas dashboard layouts (js/runtimes-viz/glow-canvas.js
        // supplies the pure layout algebra + JSON serialization; this file only
        // stores/retrieves the resulting plain objects). Keyed by a
        // caller-supplied layout name so saving under the same name overwrites
        // that named dashboard rather than duplicating it — the same
        // save-by-key discipline as columnProfiles/approvedRules above, not the
        // append-only pattern of the ledgers.
        db.createObjectStore(STORE_CANVAS_LAYOUTS, { keyPath: 'name' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

// ---------- columnProfiles (LRU-capped at 200) ----------

export async function getColumnProfile(nameHash) {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_PROFILES, 'readonly');
  return req(tx.objectStore(STORE_PROFILES).get(nameHash));
}

export async function saveColumnProfile(profile) {
  if (!profile || !profile.columnNameHash) {
    throw new Error('saveColumnProfile requires a profile with a columnNameHash.');
  }
  const db = await initMemoryStore();
  const record = { lastSeen: Date.now(), timesConfirmed: 0, ...profile };
  record.lastSeen = Date.now(); // always stamp on write for LRU
  const tx = db.transaction(STORE_PROFILES, 'readwrite');
  const store = tx.objectStore(STORE_PROFILES);
  store.put(record);
  // LRU eviction: if over cap, remove the oldest lastSeen records.
  const all = await req(store.getAll());
  if (all.length > PROFILE_CAP) {
    all.sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
    const toEvict = all.slice(0, all.length - PROFILE_CAP);
    for (const rec of toEvict) store.delete(rec.columnNameHash);
  }
  await txDone(tx);
  return record;
}

// ---------- approvedRules (human-approval-only, no cap) ----------

export async function getApprovedRules() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_RULES, 'readonly');
  return req(tx.objectStore(STORE_RULES).getAll());
}

export async function saveApprovedRule(rule) {
  // Human-in-the-loop enforcement: a rule cannot be persisted unless it was
  // explicitly approved by a user. This blocks silent auto-generation.
  if (!rule || rule.approved !== true) {
    throw new Error('saveApprovedRule requires an explicit approved:true flag (human approval).');
  }
  if (!rule.ruleName) throw new Error('saveApprovedRule requires a ruleName.');
  const db = await initMemoryStore();
  const record = {
    createdAt: Date.now(),
    timesApplied: 0,
    approvedByUser: true,
    ...rule,
  };
  delete record.approved; // normalize: stored form uses approvedByUser
  record.approvedByUser = true;
  const tx = db.transaction(STORE_RULES, 'readwrite');
  tx.objectStore(STORE_RULES).put(record);
  await txDone(tx);
  return record;
}

export async function deleteApprovedRule(ruleName) {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_RULES, 'readwrite');
  tx.objectStore(STORE_RULES).delete(ruleName);
  await txDone(tx);
}

// ---------- datasetBaselines (keep current + 1 prior version only) ----------

export async function getBaseline(fingerprintHash) {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_BASELINES, 'readonly');
  return req(tx.objectStore(STORE_BASELINES).get(fingerprintHash));
}

export async function saveBaseline(fingerprintHash, stats) {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_BASELINES, 'readwrite');
  const store = tx.objectStore(STORE_BASELINES);
  const existing = await req(store.get(fingerprintHash));
  let version = 1;
  let previousVersion = null;
  if (existing) {
    version = (existing.version || 1) + 1;
    // Retain only the immediately prior version — never a deeper history.
    previousVersion = {
      version: existing.version || 1,
      columnStats: existing.columnStats,
      savedAt: existing.savedAt,
    };
  }
  const record = {
    fingerprintHash,
    columnStats: stats,
    version,
    previousVersion,
    savedAt: Date.now(),
  };
  store.put(record);
  await txDone(tx);
  return record;
}

export async function countBaselines() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_BASELINES, 'readonly');
  return req(tx.objectStore(STORE_BASELINES).count());
}

// Clear ONLY the stored distribution fingerprints, leaving column profiles and
// approved rules intact. Backs the "clear stored fingerprints" consent control.
export async function clearBaselines() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_BASELINES, 'readwrite');
  tx.objectStore(STORE_BASELINES).clear();
  await txDone(tx);
}

// ---------- fingerprintHistory (Forecast-Based Drift Alerting, opt-in) ----------
// A short, bounded, time-ordered sequence of distribution fingerprints per
// schema signature. The single-slot datasetBaselines store above deliberately
// keeps only current + 1 prior version; forecasting needs a genuine SEQUENCE to
// project a trend, so it lives in its own store. Like every other summary here
// it holds ONLY the derived stat numbers (mean / null rate / modal share),
// never raw rows, and is written only when the user has opted into persistence.
// Injected into the drift layer via the same fingerprintStore contract.

export async function getFingerprintHistory(fingerprintHash) {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_FP_HISTORY, 'readonly');
  const rec = await req(tx.objectStore(STORE_FP_HISTORY).get(fingerprintHash));
  return rec && Array.isArray(rec.series) ? rec.series : [];
}

export async function appendFingerprintHistory(fingerprintHash, stats, cap = FP_HISTORY_CAP) {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_FP_HISTORY, 'readwrite');
  const store = tx.objectStore(STORE_FP_HISTORY);
  const existing = await req(store.get(fingerprintHash));
  const series = existing && Array.isArray(existing.series) ? existing.series : [];
  series.push({ ts: Date.now(), stats });
  while (series.length > cap) series.shift(); // keep only the most recent `cap`
  store.put({ fingerprintHash, series });
  await txDone(tx);
  return series.length;
}

// Summary for the Settings panel: how many schemas are tracked and the total
// number of stored fingerprints across them.
export async function fingerprintHistoryStats() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_FP_HISTORY, 'readonly');
  const all = await req(tx.objectStore(STORE_FP_HISTORY).getAll());
  const schemas = all.length;
  const points = all.reduce((a, r) => a + (Array.isArray(r.series) ? r.series.length : 0), 0);
  return { schemas, points };
}

// Clear ONLY the trend history, leaving single-slot baselines/profiles/rules
// intact. Backs the "Clear drift history" control.
export async function clearFingerprintHistory() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_FP_HISTORY, 'readwrite');
  tx.objectStore(STORE_FP_HISTORY).clear();
  await txDone(tx);
}

// ---------- meetingDecisionLedger (Chart-Anchored Decision Ledger, Gen 43 Part 3) ----------
// Append-only log of pushback moments, data requests, and action items from
// the Meeting tab (js/agents/meeting-decision-ledger.js supplies the pure
// entry-building logic; this file only knows how to store/retrieve/clear the
// resulting plain objects). Nothing here decides WHAT gets logged or WHEN —
// that stays the analyst's action via the UI, matching the same
// human-in-the-loop principle as saveApprovedRule above.

export async function appendLedgerEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return 0;
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_LEDGER, 'readwrite');
  const store = tx.objectStore(STORE_LEDGER);
  for (const entry of list) store.put(entry);
  // Cap: if over the limit, evict the oldest-recorded entries first.
  const all = await req(store.getAll());
  if (all.length > LEDGER_CAP) {
    all.sort((a, b) => (a.recordedAt || 0) - (b.recordedAt || 0));
    const toEvict = all.slice(0, all.length - LEDGER_CAP);
    for (const rec of toEvict) store.delete(rec._id);
  }
  await txDone(tx);
  return list.length;
}

export async function getLedgerEntries() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_LEDGER, 'readonly');
  return req(tx.objectStore(STORE_LEDGER).getAll());
}

export async function countLedgerEntries() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_LEDGER, 'readonly');
  return req(tx.objectStore(STORE_LEDGER).count());
}

// Clear ONLY the decision ledger, leaving every other store intact. Backs a
// "Clear meeting ledger" consent control, same pattern as clearBaselines().
export async function clearLedgerEntries() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_LEDGER, 'readwrite');
  tx.objectStore(STORE_LEDGER).clear();
  await txDone(tx);
}

// ---------- learnedCorrections (Self-Learning Validation Rules, opt-in) ----------
// Stores the serialized on-device logistic-regression model (learned weights +
// the labeled examples of the user's own corrections). Persisted ONLY when the
// user opts in to cross-session learning. Keyed by a caller-supplied modelId so
// a future per-dataset split is possible; today a single 'default' model is used.

export async function getLearnedModel(modelId = 'default') {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_LEARNED, 'readonly');
  const rec = await req(tx.objectStore(STORE_LEARNED).get(modelId));
  return rec ? rec.model : null;
}

export async function saveLearnedModel(modelId, model) {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_LEARNED, 'readwrite');
  tx.objectStore(STORE_LEARNED).put({ modelId: modelId || 'default', model, savedAt: Date.now() });
  await txDone(tx);
}

export async function countLearnedExamples(modelId = 'default') {
  const m = await getLearnedModel(modelId);
  return m && Array.isArray(m.examples) ? m.examples.length : 0;
}

// Delete ONE learned model by id, leaving every other model intact. Backs the
// "Clear my learned prioritization" control, which must not wipe the separate
// Self-Learning corrections model stored under a different modelId.
export async function deleteLearnedModel(modelId = 'default') {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_LEARNED, 'readwrite');
  tx.objectStore(STORE_LEARNED).delete(modelId);
  await txDone(tx);
}

// Clear ONLY the learned corrections, leaving fingerprints/profiles/rules intact.
// Backs the "Clear my learned corrections" consent control.
export async function clearLearnedModels() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_LEARNED, 'readwrite');
  tx.objectStore(STORE_LEARNED).clear();
  await txDone(tx);
}

// ---------- queryMemoryLog (Query Memory, opt-in, capped append-only) ----------
// Append-only fingerprint log of SQL/Python/R/Metric runs. The pure logic (how a
// run is fingerprinted and what an entry looks like) lives in
// js/provenance/query-memory.js; this file only knows how to store/retrieve/clear
// the resulting plain objects, exactly like the meeting decision ledger above.
// Written only when the user has opted into Query Memory (the OFF-by-default
// `queryMemory` flag gates the future caller — nothing writes here today).

export async function appendQueryMemory(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return 0;
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_QUERY_MEMORY, 'readwrite');
  const store = tx.objectStore(STORE_QUERY_MEMORY);
  for (const entry of list) store.put(entry);
  // Cap: if over the limit, evict the oldest-recorded entries (by ts) first.
  const all = await req(store.getAll());
  if (all.length > QUERY_MEMORY_CAP) {
    all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const toEvict = all.slice(0, all.length - QUERY_MEMORY_CAP);
    for (const rec of toEvict) store.delete(rec._id);
  }
  await txDone(tx);
  return list.length;
}

export async function getQueryMemory() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_QUERY_MEMORY, 'readonly');
  return req(tx.objectStore(STORE_QUERY_MEMORY).getAll());
}

// Fast lookup of all log entries for a single run fingerprint, via the
// non-unique `fingerprint` index — backs Query Memory's "seen before?" check.
export async function getQueryMemoryByFingerprint(fingerprint) {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_QUERY_MEMORY, 'readonly');
  const index = tx.objectStore(STORE_QUERY_MEMORY).index('fingerprint');
  return req(index.getAll(fingerprint));
}

export async function countQueryMemory() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_QUERY_MEMORY, 'readonly');
  return req(tx.objectStore(STORE_QUERY_MEMORY).count());
}

// Clear ONLY the Query Memory log, leaving every other store intact. Backs a
// "Clear query memory" consent control, same pattern as clearLedgerEntries().
export async function clearQueryMemory() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_QUERY_MEMORY, 'readwrite');
  tx.objectStore(STORE_QUERY_MEMORY).clear();
  await txDone(tx);
}

// ---------- canvasLayouts (Glow Canvas saved dashboards, keyed by name) ----------
// Persists whole Glow Canvas layouts (the JSON produced by
// js/runtimes-viz/glow-canvas.js's serializeLayout) so a dashboard survives a
// reload. Save-by-name: re-saving the same name overwrites that dashboard.
// Only the derived layout description is stored — never a byte of the user's
// data — matching the store-only-summaries discipline of every store above.

export async function saveCanvasLayout(name, layoutJson) {
  if (typeof name !== 'string' || !name) {
    throw new Error('saveCanvasLayout requires a non-empty name.');
  }
  const db = await initMemoryStore();
  const record = { name, layoutJson: typeof layoutJson === 'string' ? layoutJson : String(layoutJson), savedAt: Date.now() };
  const tx = db.transaction(STORE_CANVAS_LAYOUTS, 'readwrite');
  tx.objectStore(STORE_CANVAS_LAYOUTS).put(record);
  await txDone(tx);
  return record;
}

export async function getCanvasLayout(name) {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_CANVAS_LAYOUTS, 'readonly');
  return req(tx.objectStore(STORE_CANVAS_LAYOUTS).get(name));
}

export async function listCanvasLayouts() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_CANVAS_LAYOUTS, 'readonly');
  return req(tx.objectStore(STORE_CANVAS_LAYOUTS).getAll());
}

export async function deleteCanvasLayout(name) {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_CANVAS_LAYOUTS, 'readwrite');
  tx.objectStore(STORE_CANVAS_LAYOUTS).delete(name);
  await txDone(tx);
}

// Clear ONLY the saved Glow Canvas layouts, leaving every other store intact.
// Backs a "Clear saved dashboards" consent control, same pattern as the other
// clear* helpers above.
export async function clearCanvasLayouts() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_CANVAS_LAYOUTS, 'readwrite');
  tx.objectStore(STORE_CANVAS_LAYOUTS).clear();
  await txDone(tx);
}
