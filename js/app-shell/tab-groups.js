// ============================================================
// Tab Groups — pure grouping logic for the top-level tab bar
// ============================================================
//
// This module has ZERO DOM code and ZERO dependency on main.js. It only
// answers one question: given the current tabOrder (the same array
// state.tabOrder already holds, in whatever order the user has dragged it
// to) and which tab ids currently exist in the bar, which named MODE does
// each tab id belong to, and in what order should the modes render?
//
// It never invents, drops, renames, or re-gates a tab: every id that was
// passed in comes back out exactly once. A tab id this module has never
// heard of is placed into a trailing 'More' group rather than being
// silently discarded — so a future new tab id is never lost, even if
// nobody remembers to add it to TAB_GROUP_META first.

// Which named mode each known tab id belongs to, and the display order of
// the modes themselves. Order here is also the render order.
export const TAB_GROUP_ORDER = ['explore', 'validate', 'analyze', 'share', 'automate', 'more'];

export const TAB_GROUP_META = {
  explore: { label: 'Explore' },
  validate: { label: 'Validate & Trust' },
  analyze: { label: 'Analyze' },
  share: { label: 'Visualize & Share' },
  automate: { label: 'Automate' },
  more: { label: 'More' },
};

// tabId -> groupId. Every tab id currently in TAB_META (main.js) must be
// listed here; a new tab id added to TAB_META that is NOT added here still
// renders correctly (it lands in 'more'), just not in its ideal group.
const TAB_TO_GROUP = {
  framer: 'explore',
  preflight: 'explore',
  validate: 'validate',
  clean: 'validate',
  diff: 'validate',
  sql: 'analyze',
  python: 'analyze',
  r: 'analyze',
  visualize: 'share',
  story: 'share',
  swift: 'share',
  twin: 'automate',
  watch: 'automate',
  meeting: 'automate',
};

/**
 * Groups a flat, ordered list of tab ids into named modes.
 *
 * @param {string[]} tabOrder - the tab ids currently visible, in the
 *   user's current drag-order (same shape as state.tabOrder, already
 *   filtered for any flag-gated ids like 'meeting').
 * @returns {Array<{id: string, label: string, tabIds: string[]}>} one
 *   entry per non-empty group, in TAB_GROUP_ORDER, each carrying only the
 *   tab ids that are actually present in tabOrder — and preserving each
 *   tab's relative order from tabOrder within its group.
 */
export function buildTabGroups(tabOrder) {
  const buckets = {};
  TAB_GROUP_ORDER.forEach((g) => { buckets[g] = []; });
  tabOrder.forEach((tabId) => {
    const groupId = TAB_TO_GROUP[tabId] || 'more';
    if (!buckets[groupId]) buckets[groupId] = [];
    buckets[groupId].push(tabId);
  });
  return TAB_GROUP_ORDER
    .filter((groupId) => buckets[groupId].length > 0)
    .map((groupId) => ({
      id: groupId,
      label: TAB_GROUP_META[groupId].label,
      tabIds: buckets[groupId],
    }));
}

/**
 * Which group a given tab id lives in — used so the bar can highlight the
 * active mode header even when the active tab is inside a collapsed group.
 */
export function groupForTab(tabId) {
  return TAB_TO_GROUP[tabId] || 'more';
}
