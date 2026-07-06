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
