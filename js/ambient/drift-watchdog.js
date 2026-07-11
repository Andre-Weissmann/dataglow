// ============================================================
// DATAGLOW — Semantic Drift Watchdog
// ============================================================
// DATAGLOW already detects distributional drift on every upload
// (js/validation/validation.js's `distribution_drift` layer, which itself wraps
// js/drift/drift-forecast.js's trend-aware alerting) — but only when a human
// re-opens or re-uploads a file. This module is the missing piece BETWEEN "a
// file changed on disk" (already solved for the browser build by
// js/ambient/watch-folder.js's poll loop) and "the user actually notices" — it
// turns the existing `distribution_drift` layer result into a small set of
// STABLE, human-readable alert lines, and decides whether re-showing one on the
// next automatic re-check is worth the user's attention or would just be noise
// repeating what they already saw and dismissed.
//
// This module computes and detects NOTHING new statistically. It is a pure
// presentation + de-duplication layer over results DATAGLOW's existing
// validation pipeline already produced. It never touches raw data, calls no
// network primitive, and (per the EMPOWERMENT CONSTRAINT every ambient/agent
// module here follows) never modifies, blocks, or "fixes" anything — it only
// decides what to say and how loudly, once, per genuinely new finding.
//
// Pure + dependency-free (no DOM, no DuckDB, no IndexedDB) so it is fully
// Node-testable, matching every sibling detection/orchestration module in
// js/ambient/ and js/drift/. See test/drift-watchdog.test.mjs.
//
// NOTE on scope (read before extending): a NATIVE (Tauri/Rust, OS-level
// filesystem-event) trigger for the desktop shell — as opposed to the existing
// browser-only polling watcher — is a documented, deliberate follow-up, not
// part of this module. See docs/tech-debt-tracker.md's entry on why it was
// scoped out of this PR (no Rust toolchain available to verify it locally).
// This module is trigger-agnostic: whatever eventually calls it (the browser
// poll loop today, a native watcher tomorrow) just needs to hand it the same
// `distribution_drift` result shape validation.js already produces.
// ============================================================

// -----------------------------------------------------------------
// summarizeDriftEvent — turn one `distribution_drift` layer result (the object
// already returned by js/validation/validation.js's runAllLayers, at
// `results.distribution_drift`) into a flat list of alert-worthy lines.
// Returns { severity: 'pass'|'warn'|'fail', headline, lines: string[] }.
//
// `drift` shape (from validation.js):
//   { status: 'pass'|'warn'|'fail', summary: string, drifts?: string[],
//     forecast?: { active, historyLen, flags: [{message}] } | null }
// A missing/malformed drift object degrades to a silent pass rather than
// throwing — the watchdog must never be the reason an automatic re-check fails.
// -----------------------------------------------------------------
export function summarizeDriftEvent(drift) {
  if (!drift || typeof drift !== 'object') {
    return { severity: 'pass', headline: 'No drift information available.', lines: [] };
  }
  const severity = drift.status === 'fail' ? 'fail' : drift.status === 'warn' ? 'warn' : 'pass';
  const lines = [];
  if (Array.isArray(drift.drifts)) {
    for (const d of drift.drifts) {
      if (typeof d === 'string' && d.trim()) lines.push(d.trim());
    }
  }
  if (drift.forecast && drift.forecast.active && Array.isArray(drift.forecast.flags)) {
    for (const f of drift.forecast.flags) {
      if (f && typeof f.message === 'string' && f.message.trim()) lines.push(f.message.trim());
    }
  }
  const headline = typeof drift.summary === 'string' && drift.summary.trim()
    ? drift.summary.trim()
    : (severity === 'pass' ? 'No drift detected.' : `${lines.length} drift signal(s) detected.`);
  return { severity, headline, lines };
}

// -----------------------------------------------------------------
// A stable fingerprint of an alert's CONTENT (not its timestamp), so the same
// underlying drift re-surfacing on the next poll — because the file hasn't
// changed again, or the same anomaly is still present — hashes identically and
// can be recognised as "already told them this" rather than nagging again.
// Deliberately simple (sorted, joined lines) — this only needs to be stable and
// collision-resistant for a handful of short strings per session, not
// cryptographically strong.
// -----------------------------------------------------------------
export function alertFingerprint(summary) {
  if (!summary || !Array.isArray(summary.lines)) return `${summary && summary.severity || 'pass'}::`;
  const body = [...summary.lines].sort().join('|');
  return `${summary.severity}::${body}`;
}

// -----------------------------------------------------------------
// DriftWatchdog — owns the "have I already surfaced this exact alert for this
// file" de-duplication across repeated automatic checks (e.g. the Watch Folder
// poll loop re-validating a file, or a future native watcher doing the same).
// Contains NO detection logic of its own — see module header. Every method is
// synchronous and side-effect-free besides updating its own in-memory map, so
// it is trivial to unit test and safe to instantiate per-session with no
// persistence (drift alerts are inherently session-scoped: "did THIS run
// change since I last looked" is what matters, not a permanent log).
// -----------------------------------------------------------------
export class DriftWatchdog {
  constructor() {
    this.lastFingerprint = new Map(); // fileName -> alertFingerprint string
  }

  // Feed one file's latest `distribution_drift` result. Returns:
  //   { summary, isNew, shouldNotify }
  // shouldNotify is true only when there's something worth surfacing (severity
  // is warn/fail with at least one line) AND it differs from the last thing
  // this exact file already reported — so an unchanged repeat poll, or a file
  // that has always passed, produces shouldNotify:false and the UI can stay
  // silent instead of re-rendering/re-alerting every poll interval.
  observe(fileName, drift) {
    const summary = summarizeDriftEvent(drift);
    const fp = alertFingerprint(summary);
    const prevFp = this.lastFingerprint.get(fileName);
    const isNew = prevFp !== fp;
    this.lastFingerprint.set(fileName, fp);
    const hasSignal = summary.severity !== 'pass' && summary.lines.length > 0;
    return { summary, isNew, shouldNotify: isNew && hasSignal };
  }

  // Explicit reset for one file (e.g. the user dismissed the alert card and
  // wants to be told again if the SAME drift is still present next poll — a
  // deliberate re-arm, not automatic re-nagging).
  clear(fileName) {
    this.lastFingerprint.delete(fileName);
  }

  clearAll() {
    this.lastFingerprint.clear();
  }
}

// -----------------------------------------------------------------
// formatWatchdogAlert — one-line, human-readable render of a watchdog
// decision, for surfaces that just want a string (e.g. a toast or a log line)
// rather than building their own card. UI code that wants a richer card (with
// per-line detail) should use `summary.lines` directly instead.
// -----------------------------------------------------------------
export function formatWatchdogAlert(fileName, decision) {
  if (!decision || !decision.summary) return `"${fileName}": no drift information.`;
  const { severity, headline, lines } = decision.summary;
  const tag = severity === 'fail' ? 'DRIFT' : severity === 'warn' ? 'drift warning' : 'stable';
  if (severity === 'pass' || lines.length === 0) {
    return `"${fileName}": ${tag} — ${headline}`;
  }
  return `"${fileName}": ${tag} — ${headline} (${lines.length} signal${lines.length === 1 ? '' : 's'})`;
}
