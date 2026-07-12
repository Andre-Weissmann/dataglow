// ============================================================
// DATAGLOW — Session Proficiency Signal (Glow Path, Batch B)
// ============================================================
// A pure, in-memory tally of per-tab actions (SQL runs, Python runs, R runs,
// Validate runs — whatever tabs the caller chooses to track) that classifies the
// current session into an honest, conservative density/proficiency level:
// 'low' | 'mid' | 'high'.
//
// It follows the SAME discipline as js/learning/signal-store.js:
//   • synchronous + in-memory — a scratch pad for ONE session, not a store;
//   • dependency-free and framework-free, so it unit-tests in plain Node;
//   • no IndexedDB, no DOM, no async, no network; it does NOT touch
//     memory-store.js and it persists NOTHING.
//
// PURE LOGIC ONLY — there is NO wiring into main.js or any UI in this batch, and
// there is zero caller yet, exactly like Metric Contracts Batch 1 shipped as
// pure logic first (see docs/capability-map.md "Trust & metrics"). The intended
// first consumer is Glow Path (js/app-shell/glow-path.js), a separate, parallel
// batch — this module deliberately knows nothing about it.
//
// OUT OF SCOPE (future follow-up, do NOT build here): cross-session persistence.
// Today the tally resets whenever the session/tab reloads; a later batch could
// hydrate it from memory-store.js if the user opts in. That is intentionally not
// part of this batch.

// Density thresholds, expressed on TOTAL actions across all tabs. These are a
// reasonable STARTING heuristic, not a scientifically derived cutoff — they are
// exported as named constants precisely so tests and any future caller reference
// the same numbers (and so they can be tuned later in one place):
//   totalActions < 5            => 'low'   (barely warmed up)
//   5 <= totalActions < 25      => 'mid'   (actively working)
//   totalActions >= 25          => 'high'  (dense, sustained session)
export const DENSITY_MID_THRESHOLD = 5;
export const DENSITY_HIGH_THRESHOLD = 25;

// Pure classification of a session's density from its total action count.
//
// `distinctTabsUsed` is accepted because the caller is asked to pass it and a
// future refinement may reward breadth of tool use — but it is CURRENTLY UNUSED
// and deliberately does NOT change the threshold math: the level is a function of
// totalActions alone. This keeps the logic simple and honest, and in particular
// guarantees that using more than one tab never LOWERS the level below what
// totalActions alone would give. (Documented rather than silently ignored.)
export function classifyDensity(totalActions, distinctTabsUsed) {
  void distinctTabsUsed; // reserved for a future refinement; intentionally unused today
  const total = Number.isFinite(Number(totalActions)) ? Number(totalActions) : 0;
  if (total >= DENSITY_HIGH_THRESHOLD) return 'high';
  if (total >= DENSITY_MID_THRESHOLD) return 'mid';
  return 'low';
}

// A session-scoped per-tab action tally + classifier. Create one per session.
export function createProficiencyTracker() {
  // tabId -> count. A plain object keyed by caller-chosen tab id (e.g. 'sql').
  const counts = new Map();

  // Increment the counter for one tab. An empty/absent tabId is ignored rather
  // than throwing, so a wiring slip never breaks the caller's action path.
  function recordAction(tabId) {
    if (tabId == null || tabId === '') return;
    const key = String(tabId);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  // A plain {tabId: count} snapshot. Cloned so mutating the result can never
  // corrupt the tracker's internal state.
  function getActionCounts() {
    const out = {};
    for (const [k, v] of counts) out[k] = v;
    return out;
  }

  // Total actions across every tab.
  function getTotalActions() {
    let n = 0;
    for (const v of counts.values()) n += v;
    return n;
  }

  // Current density level, using the pure classifier above.
  function getDensityLevel() {
    return classifyDensity(getTotalActions(), counts.size);
  }

  // Clear all counters — useful for tests and for an explicit "start fresh"
  // control later.
  function reset() {
    counts.clear();
  }

  return {
    recordAction,
    getActionCounts,
    getTotalActions,
    getDensityLevel,
    reset,
  };
}
