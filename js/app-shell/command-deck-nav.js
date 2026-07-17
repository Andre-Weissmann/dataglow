// ============================================================
// DATAGLOW — Command Deck, Part 1: 5-stage sidebar regroup (pure logic)
// ============================================================
// Decision recorded here (Command Deck decision, resolved by the agent per
// the user's "build all, safely and smartly" instruction, stated rationale
// preserved in docs/capability-map.md and AGENTS.md):
//   - Direction: Command Deck (5 Trust-Tier stages + palette + next-step
//     rail), not one of the bolder deferred ideas (Conversational Front
//     Door, Lifecycle Canvas) — the report's own comparison is
//     evidence-based (measured 13-tab problem vs. studied real products)
//     and lower-risk; the bolder ideas are explicitly better tackled AFTER
//     this foundational regroup is proven, per the report's own risk
//     ordering.
//   - Scope for THIS batch: Part 1 (sidebar regroup) only. "Build all" was
//     answered for the three top-level candidate directions (Metric
//     Contracts, PR #93 review, Command Deck) — not license to skip this
//     report's own staged internal risk ordering. Parts 2 (command
//     palette) and 3 (adaptive next-step rail) are follow-on batches once
//     Part 1 is live and reviewed, honoring "build piece by piece."
//   - Naming: kept exactly as proposed — "Command Deck", stages named
//     Frame / Work / Trust / Generate / Tell. This is the strongest part
//     of the concept: it turns navigation itself into a demonstration of
//     DATAGLOW's actual differentiator (trust/provenance).
//
// WHAT THIS BATCH IS: a pure reorganization of the EXISTING 13 tabs into 5
// named stages. Zero new logic, zero new panels, zero new tools — every tab
// id here must already exist in main.js's TAB_META/state.tabOrder, and this
// module is checked against that at test time so it can never silently list
// a tab that doesn't exist (or omit one that does).
//
// WHAT THIS BATCH DELIBERATELY DOES NOT DO YET:
//   - No command palette (Part 2).
//   - No adaptive next-step rail (Part 3).
//   - No new DOM presenter wired as the default nav — Part 1 ships as an
//     ALTERNATE sidebar, dark behind the `dataglowSidebarNav` flag, sitting
//     alongside the existing top tab bar which remains the default/fallback
//     until the user reviews it live and explicitly approves the switch.
//
// POST-REBASE ADDENDUM: the `meeting` tab (Meeting Scribe) landed on main
// after this batch's original 12-tab mapping was authored, so the coverage
// test (`test/command-deck-nav.test.mjs`) caught it as unassigned during the
// merge-time rebase. Placed under Trust: its core job — surfacing stakeholder
// pushback moments and enforcing an owner+dueDate+outcome rule on action
// items — is a verification/accountability function, the same job Trust's
// other tabs (Validate, Diff) perform, rather than a Frame (define-the-
// question) or Tell (audience-facing output) fit.

/**
 * The 5 Trust-Tier Lifecycle Stages, in display order, each listing the
 * existing tab ids it groups (order within a stage matches state.tabOrder's
 * original relative order for those ids). This is metadata only — it grabs
 * no live tab list itself, so a caller (or a test) must supply the real
 * tab-id set to validate against.
 */
export const COMMAND_DECK_STAGES = [
  { id: 'frame', label: 'Frame', description: 'Define the question, load the data', tabs: ['framer', 'preflight', 'watch'] },
  { id: 'work', label: 'Work', description: 'Raw analysis and prep', tabs: ['sql', 'python', 'r', 'clean', 'drillfloor'] },
  { id: 'trust', label: 'Trust', description: 'DATAGLOW\u2019s actual differentiator \u2014 verify before you share', tabs: ['validate', 'diff', 'meeting', 'diplomacy', 'proofroom', 'convergence', 'crucible', 'copilot'] },
  { id: 'generate', label: 'Generate', description: 'Synthetic and advanced generation', tabs: ['twin'] },
  { id: 'tell', label: 'Tell', description: 'Audience-facing, shareable output', tabs: ['visualize', 'glowcanvas', 'story'] },
];

/**
 * Build the sidebar's content model: one entry per stage, each carrying its
 * resolved tab metadata (label/icon) pulled from the real tabMeta map given
 * by the caller, plus which tab (if any) is currently active so the caller
 * can auto-expand the right stage. Pure — no DOM, no globals.
 *
 * @param {object} opts
 * @param {Record<string,{label:string, icon:string}>} opts.tabMeta the real TAB_META from main.js
 * @param {string} [opts.activeTab] the currently active tab id
 * @returns {{stages: Array<{id:string,label:string,description:string,tabs:Array<{id:string,label:string,icon:string,active:boolean}>,containsActive:boolean}>, unassignedTabs: string[]}}
 */
export function buildSidebarContent({ tabMeta, activeTab } = {}) {
  const meta = tabMeta || {};
  const assigned = new Set();

  const stages = COMMAND_DECK_STAGES.map(stage => {
    const tabs = stage.tabs
      .filter(tabId => meta[tabId]) // only ever list tabs that actually exist
      .map(tabId => {
        assigned.add(tabId);
        return {
          id: tabId,
          label: meta[tabId].label,
          icon: meta[tabId].icon,
          active: tabId === activeTab,
        };
      });
    return {
      id: stage.id,
      label: stage.label,
      description: stage.description,
      tabs,
      containsActive: tabs.some(t => t.active),
    };
  });

  // Honest reporting: any real tab NOT covered by a stage (e.g. a future tab
  // added to main.js before this map is updated) is surfaced, never
  // silently dropped from the app's only nav.
  const unassignedTabs = Object.keys(meta).filter(tabId => !assigned.has(tabId));

  return { stages, unassignedTabs };
}

/**
 * Validate that the stage map exactly covers a given set of real tab ids —
 * no tab missing, no stale tab id left over from a removed tool. Used both
 * by tests (against main.js's real TAB_META) and safe to call at runtime if
 * a caller wants an explicit health check.
 * @param {string[]} realTabIds
 * @returns {{ok:boolean, missing:string[], stale:string[]}}
 */
export function validateStageCoverage(realTabIds) {
  const real = new Set(realTabIds || []);
  const mapped = new Set(COMMAND_DECK_STAGES.flatMap(s => s.tabs));
  const missing = [...real].filter(id => !mapped.has(id)); // real tab not in any stage
  const stale = [...mapped].filter(id => !real.has(id)); // stage lists a tab that no longer exists
  return { ok: missing.length === 0 && stale.length === 0, missing, stale };
}

/**
 * Find which stage a given tab id belongs to (or null). Pure lookup, no DOM.
 * @param {string} tabId
 * @returns {string|null} the stage id, or null if the tab isn't mapped
 */
export function stageForTab(tabId) {
  const stage = COMMAND_DECK_STAGES.find(s => s.tabs.includes(tabId));
  return stage ? stage.id : null;
}
