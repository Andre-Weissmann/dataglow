// ============================================================
// DVC Tab (Phase 10 -- ships dark behind the dataVersionControl flag)
// ============================================================
// Data Version Control: snapshot datasets before transforms, diff snapshots,
// rollback (advisory -- shows what data looked like, not the raw rows).
// PRIVACY: only schema + stats stored in snapshots, never row data.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, 2026-09-25) — byte-for-byte identical
// behavior, only the file location changed.

import { state } from '../state.js';
import { toast } from '../utils.js';
import { isEnabled } from '../../build/build-flags.js';
import { mountDVCUI } from '../../dvc/dvc-ui.js';

export function renderDVCTab() {
  const host = document.getElementById('dvc-body');
  if (!host) return;
  if (!isEnabled('dataVersionControl')) { host.innerHTML = ''; return; }

  mountDVCUI({
    host,
    datasets: state.datasets || [],
    getActiveDataset: () => {
      const name = state.activeDataset;
      if (!name) return null;
      return (state.datasets || []).find(d => (d.name || d.tableName) === name) || null;
    },
    onSnapshot: (id) => {
      toast('Snapshot ' + id.slice(0, 12) + ' created', 'success');
    },
    onRollback: (meta) => {
      // Advisory rollback: show the user what the snapshot looked like.
      // DataGlow doesn't store row data, so actual data restore requires
      // the user to reload from the original file.
      const msg = 'Rollback info: "' + meta.label + '" had ' +
        meta.rowCount.toLocaleString() + ' rows, ' +
        meta.cols.length + ' cols. Reload the original file to restore.';
      toast(msg, 'info');
    },
    onToast: toast,
  });
}
