// ============================================================
// DATAGLOW — Adaptive Next-Step Rail (Gen 44, Part 3 -- ships dark)
// ============================================================
// Rules-based (no AI required) suggestion strip that reads real app progress
// signals -- has a dataset been loaded? has it been through preflight? has it
// been validated? has a chart been built? -- and highlights the 1-2 tools
// most relevant to do next. Answers the user's own stated worry ("I don't
// know what the true workflow is like") by having the app teach the workflow
// proactively, without separate documentation.
//
// This file is PURE LOGIC: no DOM, no state.js import, no side effects. The
// caller (js/app-shell/main.js) is responsible for building the real
// `progress` snapshot from actual app state/action completions and handing
// it to `computeNextSteps`. This module never invents a signal it wasn't
// given -- if a caller doesn't tell it a dataset is loaded, it will not
// pretend one is.
//
// Direction, scope (Part 3 only -- the last of the three-part Command Deck
// plan), and rule ordering were decided against the UI/UX brainstorm report
// per the user's "build all, safely and smartly" instruction.

// Ordered rulebook. Each rule is checked in order; the first rules whose
// `when(progress)` returns true contribute a suggestion, until `limit` is
// reached (default 2, per the brainstorm spec: "highlight the next 1-2
// relevant tools"). Rules are intentionally simple boolean checks over real
// progress fields -- no ML, no scoring, no ambiguity about why a suggestion
// appeared, which matters for a tool whose whole differentiator is trust.
export const NEXT_STEP_RULES = [
  {
    id: 'load-dataset',
    when: (p) => !p.hasDataset,
    tabId: 'framer',
    reason: 'Start by loading a dataset or framing the question you\u2019re trying to answer.',
  },
  {
    id: 'run-preflight',
    when: (p) => p.hasDataset && !p.preflightRun,
    tabId: 'preflight',
    reason: 'Run preflight to check the dataset is ready for analysis before you dig in.',
  },
  {
    id: 'clean-issues',
    when: (p) => p.hasDataset && p.preflightRun && p.cleanIssuesFound && !p.cleanResolved,
    tabId: 'clean',
    reason: 'Preflight or scanning found cleaning issues -- resolve them before they skew your analysis.',
  },
  {
    id: 'run-sql-or-analysis',
    when: (p) => p.hasDataset && p.preflightRun && !p.queryRun,
    tabId: 'sql',
    reason: 'Preflight looks good -- run a query to start exploring the data.',
  },
  {
    id: 'validate',
    when: (p) => p.hasDataset && p.queryRun && !p.validationRun,
    tabId: 'validate',
    reason: 'You\u2019ve run a query -- validate it against the 20 trust layers before you rely on the result.',
  },
  {
    id: 'visualize',
    when: (p) => p.hasDataset && p.validationRun && !p.chartBuilt,
    tabId: 'visualize',
    reason: 'Your analysis is validated -- turn it into a chart to see the story in the data.',
  },
  {
    id: 'tell-story',
    when: (p) => p.hasDataset && p.chartBuilt && !p.storyBuilt,
    tabId: 'story',
    reason: 'You have a validated chart -- generate a narrative summary to share it with stakeholders.',
  },
  {
    id: 'all-done',
    when: (p) => p.hasDataset && p.preflightRun && p.queryRun && p.validationRun && p.chartBuilt && p.storyBuilt,
    tabId: null,
    reason: 'You\u2019ve completed the full Frame \u2192 Work \u2192 Trust \u2192 Tell workflow for this dataset. Explore Digital Twin or Swift for deeper generation, or load a new dataset to start again.',
  },
];

// Pure function: given a progress snapshot and the real tabMeta (for
// resolving each suggestion's real label/icon), return up to `limit`
// suggestions in rule order. Never mutates `progress`. Rules whose `tabId`
// doesn't resolve to a real, known tab in `tabMeta` are silently skipped --
// this is the same "honest, never invent" posture as Part 1's
// `buildSidebarContent`'s `unassignedTabs` reporting, just inverted (skip
// rather than report, since this is a suggestion strip, not a coverage map).
export function computeNextSteps({ progress, tabMeta, limit = 2 }) {
  const suggestions = [];
  for (const rule of NEXT_STEP_RULES) {
    if (suggestions.length >= limit) break;
    if (!rule.when(progress)) continue;
    if (rule.tabId === null) {
      suggestions.push({ id: rule.id, tabId: null, label: null, icon: null, reason: rule.reason });
      continue;
    }
    const meta = tabMeta && tabMeta[rule.tabId];
    if (!meta) continue; // unknown/renamed tab -- skip rather than guess
    suggestions.push({ id: rule.id, tabId: rule.tabId, label: meta.label, icon: meta.icon || null, reason: rule.reason });
  }
  return suggestions;
}

// Pure helper: build a fresh, all-false progress snapshot. Callers overlay
// real signals on top of this rather than hand-rolling the shape each time,
// so a new progress field added later has one place with a documented
// default.
export function emptyProgress() {
  return {
    hasDataset: false,
    preflightRun: false,
    cleanIssuesFound: false,
    cleanResolved: false,
    queryRun: false,
    validationRun: false,
    chartBuilt: false,
    storyBuilt: false,
  };
}
