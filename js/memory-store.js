// ============================================================
// DATAGLOW — IndexedDB Local Memory Store
// Anti-degradation architecture: bounded, versioned, LRU-evicted.
// Runs entirely in-browser via the native indexedDB API — no library.
// ============================================================

const DB_NAME = 'dataglow_memory';
const DB_VERSION = 2;
const STORE_PROFILES = 'columnProfiles';
const STORE_RULES = 'approvedRules';
const STORE_BASELINES = 'datasetBaselines';
const STORE_LEARNED = 'learnedCorrections';

const PROFILE_CAP = 200; // hard cap; evict least-recently-used beyond this

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

// Clear ONLY the learned corrections, leaving fingerprints/profiles/rules intact.
// Backs the "Clear my learned corrections" consent control.
export async function clearLearnedModels() {
  const db = await initMemoryStore();
  const tx = db.transaction(STORE_LEARNED, 'readwrite');
  tx.objectStore(STORE_LEARNED).clear();
  await txDone(tx);
}
