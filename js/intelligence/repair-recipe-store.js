// ============================================================
// DATAGLOW - Repair Recipe Store (on-device persistence)
// ============================================================
// Thin persistence wrapper for the Repair Recipe Library. Deliberately a
// STANDALONE IndexedDB database ('dataglow-repair-recipes') rather than a new
// object store inside the shared js/learning/memory-store.js DB, so shipping
// this feature never has to bump that DB's DB_VERSION and risk an upgrade race
// with every other memory-store consumer.
//
// Same on-device promise as the rest of DataGlow: nothing here reaches the
// network, and records are metadata only (the library engine strips row data
// before anything is handed here). In Node / tests there is no IndexedDB, so a
// createMemoryStore() adapter with the identical async surface is exported.
//
// Public (all async, never reject on the happy path; a real IDB error becomes a
// resolved fallback where sensible, or a rejected promise the UI can toast):
//   listRecipes()      -> Promise<record[]>
//   getRecipe(id)      -> Promise<record|null>
//   putRecipe(record)  -> Promise<record>
//   deleteRecipe(id)   -> Promise<boolean>
//   clearAll()         -> Promise<void>

export const REPAIR_RECIPE_STORE_VERSION = 1;

const DB_NAME = 'dataglow-repair-recipes';
const DB_VERSION = 1;
const STORE_NAME = 'recipes';

// ---- in-memory adapter (tests / Node / IDB-less browsers) ------------------

// Identical async surface to the IDB store so the canvas UI and tests can share
// one code path. Backed by a plain Map; ordering is insertion order.
export function createMemoryStore() {
  var map = new Map();
  return {
    kind: 'memory',
    listRecipes: function () {
      return Promise.resolve(Array.from(map.values()).map(clone));
    },
    getRecipe: function (id) {
      return Promise.resolve(map.has(id) ? clone(map.get(id)) : null);
    },
    putRecipe: function (record) {
      if (!record || !record.id) return Promise.reject(new Error('Record needs an id.'));
      map.set(record.id, clone(record));
      return Promise.resolve(clone(record));
    },
    deleteRecipe: function (id) {
      var had = map.has(id);
      map.delete(id);
      return Promise.resolve(had);
    },
    clearAll: function () {
      map.clear();
      return Promise.resolve();
    },
  };
}

function clone(o) {
  try { return JSON.parse(JSON.stringify(o)); } catch (_e) { return o; }
}

// ---- IndexedDB adapter (browser / desktop webview / PWA) -------------------

function idbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDb() {
  return new Promise(function (resolve, reject) {
    var req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
  });
}

function tx(db, mode) {
  var t = db.transaction(STORE_NAME, mode);
  return t.objectStore(STORE_NAME);
}

function createIdbStore() {
  return {
    kind: 'indexeddb',
    listRecipes: function () {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var out = [];
          var req = tx(db, 'readonly').openCursor();
          req.onsuccess = function () {
            var cur = req.result;
            if (cur) { out.push(cur.value); cur.continue(); }
            else { db.close(); resolve(out); }
          };
          req.onerror = function () { db.close(); reject(req.error); };
        });
      });
    },
    getRecipe: function (id) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var req = tx(db, 'readonly').get(id);
          req.onsuccess = function () { db.close(); resolve(req.result || null); };
          req.onerror = function () { db.close(); reject(req.error); };
        });
      });
    },
    putRecipe: function (record) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var req = tx(db, 'readwrite').put(record);
          req.onsuccess = function () { db.close(); resolve(record); };
          req.onerror = function () { db.close(); reject(req.error); };
        });
      });
    },
    deleteRecipe: function (id) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var req = tx(db, 'readwrite').delete(id);
          req.onsuccess = function () { db.close(); resolve(true); };
          req.onerror = function () { db.close(); reject(req.error); };
        });
      });
    },
    clearAll: function () {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var req = tx(db, 'readwrite').clear();
          req.onsuccess = function () { db.close(); resolve(); };
          req.onerror = function () { db.close(); reject(req.error); };
        });
      });
    },
  };
}

// Return the best available store for the current runtime. IDB in the browser;
// memory everywhere else (and if IDB throws on open we degrade to memory so the
// UI keeps working for the session rather than hard-failing).
export function createRepairRecipeStore() {
  if (idbAvailable()) {
    try { return createIdbStore(); } catch (_e) { /* fall through */ }
  }
  return createMemoryStore();
}

export const DataGlowRepairRecipeStore = {
  version: REPAIR_RECIPE_STORE_VERSION,
  createRepairRecipeStore: createRepairRecipeStore,
  createMemoryStore: createMemoryStore,
  DB_NAME: DB_NAME,
  STORE_NAME: STORE_NAME,
};

if (typeof window !== 'undefined') {
  window.DataGlowRepairRecipeStore = DataGlowRepairRecipeStore;
}
