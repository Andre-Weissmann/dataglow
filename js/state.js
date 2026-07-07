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
    modelProvider: 'perplexity',
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
  },
  tabOrder: ['preflight', 'sql', 'python', 'r', 'clean', 'validate', 'diff', 'visualize', 'story', 'swift', 'twin', 'watch'],
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
