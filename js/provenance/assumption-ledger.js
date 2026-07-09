// ============================================================
// DATAGLOW — The Assumption Ledger
// A running, exportable log of every judgment call DATAGLOW makes
// during cleaning and validation. Nothing here is hidden: each
// automated action, skip, or gating decision leaves a plain-language
// entry so the analyst can see exactly what was assumed on their behalf.
// ============================================================

// Session-scoped, in-memory log. Plain data so it works identically in the
// browser and in headless Node tests (no browser-only APIs).
const entries = [];

// Record one judgment call.
//   source: which feature made the call (e.g. 'Categorical Consistency Engine')
//   action: one-line human-readable description of the decision
//   detail: optional structured context (kept for JSON export)
export function logAssumption(source, action, detail = null) {
  const entry = { ts: Date.now(), source, action, detail };
  entries.push(entry);
  return entry;
}

export function getLedgerEntries() {
  return entries.slice();
}

export function clearLedger() {
  entries.length = 0;
}

function fmtTime(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

// Export the ledger in a human-readable format: 'text', 'markdown', or 'json'.
export function exportLedger(format = 'text') {
  if (format === 'json') {
    return JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2);
  }
  if (format === 'markdown') {
    const lines = ['# DATAGLOW Assumption Ledger', '', `_Exported ${new Date().toISOString()}_`, ''];
    if (entries.length === 0) {
      lines.push('_No assumptions recorded yet._');
    } else {
      lines.push('| Time (UTC) | Source | Assumption |', '| --- | --- | --- |');
      for (const e of entries) {
        const action = String(e.action).replace(/\|/g, '\\|');
        lines.push(`| ${fmtTime(e.ts)} | ${e.source} | ${action} |`);
      }
    }
    return lines.join('\n');
  }
  // plain text
  if (entries.length === 0) return 'DATAGLOW Assumption Ledger — no assumptions recorded yet.';
  const lines = ['DATAGLOW Assumption Ledger', `Exported ${new Date().toISOString()}`, ''];
  for (const e of entries) {
    lines.push(`[${fmtTime(e.ts)}] (${e.source}) ${e.action}`);
  }
  return lines.join('\n');
}
