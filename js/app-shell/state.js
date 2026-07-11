// ============================================================
// DATAGLOW — Central App State
// ============================================================

export const state = {
  theme: 'light',
  datasets: [],           // [{ name, table, rowCount, cols, loadedAt }]
  activeDataset: null,
  duckdb: { db: null, conn: null, ready: false },
  pyodide: null,
  webR: null,
  lastQuery: null,
  lastQueryResult: null,   // { columns, rows }
  queryHistory: [],        // for Historical Drift Detector
  validationResults: {},   // layerId -> result
  settings: {
    // Default to the private, in-browser small model (no API key, no upload).
    // If the browser lacks WebGPU, the Story tab transparently uses the offline
    // rule-based engine instead — see js/main.js updateStoryModelPanel().
    modelProvider: 'ondevice',
    apiKeys: {},
    freshnessThresholdHours: 24,
    // Opt-in (default OFF): persist small per-column distribution fingerprints
    // across sessions in local IndexedDB so drift can be detected between a
    // file loaded today and a same-schema file loaded on a future visit.
    // Only summary numbers are stored, never raw rows. See js/memory-store.js.
    persistFingerprints: false,
    // Self-Learning Validation Rules. Per-session learning is ON by default —
    // it lives only in RAM and is wiped on reload, never leaving this session.
    // Cross-session persistence (saving the learned model to IndexedDB) is a
    // separate, explicit opt-in, default OFF. See js/self-learning-rules.js.
    selfLearningEnabled: true,
    persistLearnedCorrections: false,
    // Adaptive Layer Prioritization. Reorders/highlights the Validate tab's 20
    // layers by how often each has historically caught a real issue for this
    // user. Per-session learning is ON by default (RAM only, wiped on reload);
    // cross-session persistence to IndexedDB is a separate opt-in, default OFF.
    // See js/adaptive-priority.js. Never hides or disables any layer.
    adaptivePriorityEnabled: true,
    persistLayerPriority: false,
    // Federated Fingerprint Learning (Phase 1). Collaboratively improves the
    // shared fingerprint/pattern model by exchanging ONLY privacy-protected
    // weight updates (pairwise-masked + DP-noised) with other opted-in users
    // over WebRTC, using a GitHub coordination branch only as an ephemeral peer
    // "phone book". OFF by default — fully opt-in. Raw data never leaves the
    // browser. See js/federated-learning.js / js/federated-transport.js.
    federatedLearningEnabled: false,
    persistFederatedModel: false,
    federatedEpsilon: 1.0,
  },
  // 'meeting' is only ever shown when the meetingScribe flag is on (see
  // main.js renderTabBar, which filters it out by default) — listed here so
  // drag-to-reorder has a stable slot for it once visible.
  tabOrder: ['framer', 'preflight', 'sql', 'python', 'r', 'clean', 'validate', 'diff', 'visualize', 'story', 'swift', 'twin', 'watch', 'meeting'],
};

export function setActiveDataset(name) {
  state.activeDataset = name;
}

export function getActiveDataset() {
  return state.datasets.find(d => d.name === state.activeDataset) || state.datasets[0] || null;
}

export function addDataset(ds) {
  state.datasets = state.datasets.filter(d => d.name !== ds.name);
  state.datasets.push(ds);
  state.activeDataset = ds.name;
}
