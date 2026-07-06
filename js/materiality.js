// ============================================================
// DATAGLOW — Materiality Threshold Filter
// Hide trivial issues so small datasets aren't flooded with flags.
// ============================================================

// Materiality concept per PCAOB AS 2305 (public auditing standard): only
// surface issues large enough to plausibly affect a conclusion. Here that
// means filtering out issues affecting fewer than a threshold % of rows.

export const DEFAULT_MATERIALITY_THRESHOLD = 1.0; // percent of rows

// issues: array shaped like clean.js's scanForIssues output. Each may carry
// a `pct` (string/number percent) and/or `count`. `rowCount` lets us derive
// a percentage from `count` when `pct` is absent.
export function filterByMateriality(issues, thresholdPct = DEFAULT_MATERIALITY_THRESHOLD, rowCount = null) {
  if (!Array.isArray(issues)) return [];
  return issues.filter(issue => {
    let pct = issue.pct != null ? parseFloat(issue.pct) : null;
    if (pct == null && issue.count != null && rowCount) {
      pct = (issue.count / rowCount) * 100;
    }
    // If we cannot determine a percentage, keep the issue (fail-open).
    if (pct == null || Number.isNaN(pct)) return true;
    return pct >= thresholdPct;
  });
}
