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
 * @param {object} [extras] Optional, additive, top-level context that is NOT
 *   per-dataset. Both fields already exist elsewhere in DataGlow verbatim —
 *   this export just carries copies of them alongside the per-dataset gate
 *   data so the MCP layer can compose a single answer without recomputing
 *   anything. Added for the Agent Passport Bridge (batch: MCP tool
 *   get_agent_passport) — omitting `extras` entirely preserves the exact
 *   pre-existing payload shape, so this is backward compatible.
 * @param {object|null} [extras.touchLedgerSummary] Output of
 *   summarizeTouchLedger()/verifyTouchLedger() from ai-touch-ledger.js —
 *   e.g. { summary: string, entries: number, externalCalls: number,
 *   chainVerified: boolean|null }. The ledger is a single global log, not
 *   per-dataset, so it is carried once at the top level.
 * @param {object|null} [extras.proofRoomSeal] A seal object produced by
 *   sealCheckResult() in verifiable-check-seal.js (or null if none has been
 *   created yet this session), copied verbatim — no re-signing here.
 * @returns {{
 *   version: number,
 *   exportedAt: string,
 *   datasets: Array,
 *   touchLedgerSummary?: object|null,
 *   proofRoomSeal?: object|null
 * }}
 */
export function buildGateStatePayload(datasets, extras) {
  if (!Array.isArray(datasets)) {
    const empty = { version: GATE_STATE_VERSION, exportedAt: new Date().toISOString(), datasets: [] };
    return extras ? Object.assign(empty, buildExtrasFields(extras)) : empty;
  }

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

  const payload = {
    version: GATE_STATE_VERSION,
    exportedAt: new Date().toISOString(),
    datasets: cleaned,
  };

  return extras ? Object.assign(payload, buildExtrasFields(extras)) : payload;
}

// Only include the two extra keys when the caller actually passes something —
// keeps every existing test/consumer that calls buildGateStatePayload(datasets)
// with one argument working against the exact same shape as before.
function buildExtrasFields(extras) {
  const out = {};
  if (extras && Object.prototype.hasOwnProperty.call(extras, 'touchLedgerSummary')) {
    out.touchLedgerSummary = extras.touchLedgerSummary || null;
  }
  if (extras && Object.prototype.hasOwnProperty.call(extras, 'proofRoomSeal')) {
    out.proofRoomSeal = extras.proofRoomSeal || null;
  }
  return out;
}

/**
 * Serialize the gate state to a JSON string ready to write to disk.
 * @param {Array} datasets
 * @param {object} [extras] See buildGateStatePayload's extras param.
 * @returns {string}
 */
export function serializeGateState(datasets, extras) {
  return JSON.stringify(buildGateStatePayload(datasets, extras), null, 2);
}

/**
 * Filename the user should save the export as — matches what the
 * MCP server looks for by default.
 */
export const GATE_STATE_FILENAME = 'dataglow-gate-state.json';
