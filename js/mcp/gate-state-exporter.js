// ============================================================
// DATAGLOW — Gate State Exporter (MCP bridge, browser-side)
// ============================================================
// Serializes the current in-browser gate state into a JSON
// structure that the MCP server (dataglow-mcp-server.mjs) reads
// from disk. The user triggers this once after running validation;
// the MCP server then reflects that snapshot to any connected AI
// agent.
//
// PURE: no DOM, no engine — Node-testable like all gate modules.
// The caller (main.js Settings tab) handles the actual file-save
// (Blob download to disk) so the user controls where the file lands.

// Current schema version — bump if the shape changes.
export const GATE_STATE_VERSION = 1;

/**
 * Build the gate state payload from an array of dataset descriptors.
 * Each descriptor is a state.datasets entry augmented with the
 * layerResults already produced by runAllLayers() for that dataset.
 *
 * @param {Array<{
 *   name: string,
 *   table: string,
 *   rowCount: number,
 *   cols: Array<{name:string, type:string}>,
 *   layerResults: object,
 *   metricContractStatus?: object
 * }>} datasets
 * @returns {{
 *   version: number,
 *   exportedAt: string,
 *   datasets: Array
 * }}
 */
export function buildGateStatePayload(datasets) {
  if (!Array.isArray(datasets)) return { version: GATE_STATE_VERSION, exportedAt: new Date().toISOString(), datasets: [] };

  const cleaned = datasets.map((ds) => {
    if (!ds || typeof ds !== 'object') return null;
    return {
      name: ds.name || ds.table || 'unknown',
      table: ds.table || '',
      rowCount: Number(ds.rowCount) || 0,
      cols: Array.isArray(ds.cols)
        ? ds.cols.map((c) => ({ name: String(c.name || ''), type: String(c.type || '') }))
        : [],
      layerResults: ds.layerResults && typeof ds.layerResults === 'object' ? ds.layerResults : {},
      metricContractStatus: ds.metricContractStatus || null,
    };
  }).filter(Boolean);

  return {
    version: GATE_STATE_VERSION,
    exportedAt: new Date().toISOString(),
    datasets: cleaned,
  };
}

/**
 * Serialize the gate state to a JSON string ready to write to disk.
 * @param {Array} datasets
 * @returns {string}
 */
export function serializeGateState(datasets) {
  return JSON.stringify(buildGateStatePayload(datasets), null, 2);
}

/**
 * Filename the user should save the export as — matches what the
 * MCP server looks for by default.
 */
export const GATE_STATE_FILENAME = 'dataglow-gate-state.json';
