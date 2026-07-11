// ============================================================
// Validate Focus Mode — pure disclosure-state logic for the Validate tab
// ============================================================
//
// This module decides exactly one thing: should the Validate tab's
// "Advanced options" block (the data-for/domain-pack/level/export-pack
// controls, the AI Synthesis panel, and the Peer Review Mode panel) start
// OPEN or CLOSED. It never touches what's inside that block, never removes
// or relabels a control, and never gates any OTHER existing flag
// (metricStudio, trustStripProofDrawer, conversationalPackBuilder, etc.) —
// those keep rendering exactly as they do today once the block is open.
//
// The rule is deliberately simple and honest: closed until the user has
// either (a) already run the full validation once on the active dataset
// this session, or (b) explicitly opened it themselves. Once open for a
// dataset, it stays open for that dataset — clicking Run never re-collapses
// something the user chose to look at.

/**
 * @param {{hasRunOnce: boolean, wasManuallyExpanded: boolean}} state
 * @returns {boolean} true if the Advanced options disclosure should render
 *   expanded/open; false if it should render collapsed/closed.
 */
export function shouldExpandAdvanced({ hasRunOnce, wasManuallyExpanded }) {
  return Boolean(hasRunOnce) || Boolean(wasManuallyExpanded);
}

/**
 * Per-dataset disclosure memory. A tiny, in-memory (never persisted, never
 * network, never IndexedDB) map so switching datasets within a session
 * starts each one collapsed again — advanced options earned on one dataset
 * don't leak an unrelated dataset's state.
 */
export function createValidateFocusStore() {
  const runOnce = new Set();
  const manuallyExpanded = new Set();
  return {
    markRunOnce(datasetKey) { if (datasetKey) runOnce.add(datasetKey); },
    markManuallyExpanded(datasetKey) { if (datasetKey) manuallyExpanded.add(datasetKey); },
    markCollapsed(datasetKey) { if (datasetKey) manuallyExpanded.delete(datasetKey); },
    isExpanded(datasetKey) {
      if (!datasetKey) return false;
      return shouldExpandAdvanced({
        hasRunOnce: runOnce.has(datasetKey),
        wasManuallyExpanded: manuallyExpanded.has(datasetKey),
      });
    },
  };
}
