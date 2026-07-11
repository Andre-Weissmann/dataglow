// ============================================================
// DATAGLOW — Main Application Controller
// ============================================================

import { state, getActiveDataset, addDataset, setActiveDataset, getActiveMetricsRegistry } from './state.js';
import { expandMetricReferences, MetricError } from './metrics-registry.js';
import { $, $$, el, toast, formatNumber, escapeHtml, timeAgo, debounce } from './utils.js';
import { loadRegistry } from './capability-registry.js';
import { buildSidebarContent } from './command-deck-nav.js';
import { buildCommandList, filterCommands } from './command-palette.js';
import { configureFlags, isEnabled } from '../build/build-flags.js';
import { loadBuiltInPacks } from '../packs/pack-registry.js';
import * as engine from './duckdb-engine.js';
import * as loaders from './loaders.js';
import { highlightSql, renderSqlErrorHtml } from './sql-highlight.js';
import { translateDialectSql, SUPPORTED_DIALECTS } from './sql-dialect-adapter.js';
import * as validation from '../validation/validation.js';
import { runAnalysisContract, summarizeAnalysisContract } from '../validation/analysis-contract.js';
import { getRegisteredMetrics } from '../validation/semantic-layer.js';
import { shouldOfferMetricDefiner, mountMetricDefiner } from '../validation/semantic-layer-ui.js';
import { sealCheckResult, verifySeal, renderSealSummaryLines, exportSealAsJSON } from '../provenance/verifiable-check-seal.js';
import { buildBeamUrl } from '../provenance/trust-beam.js';
import * as viz from '../runtimes-viz/visualize.js';
import * as story from '../narrative/story.js';
import * as clean from '../cleaning/clean.js';
import * as formatFingerprint from '../cleaning/format-fingerprint.js';
import * as missingness from '../validation/missingness.js';
import * as imputation from '../cleaning/imputation.js';
import * as fuzzyDedup from '../cleaning/fuzzy-dedup.js';
import * as ruleSuggestions from '../learning/rule-suggestions.js';
import * as fixConfidence from '../cleaning/fix-confidence.js';
import * as activeLearning from '../anomaly/active-learning.js';
import * as ondeviceML from '../anomaly/ondevice-ml.js';
import { scoreIsolationForest } from '../anomaly/isolation-forest.js';
import { scorePredictiveAnomalies, suppressAnomaliesWithVerdicts } from '../anomaly/predictive-anomaly.js';
import { SignalStore, SIGNAL_TYPES, VERDICTS } from '../learning/signal-store.js';
import * as spc from '../anomaly/spc-control.js';
import * as catScorecard from '../grades/cat-scorecard.js';
import * as materiality from '../cleaning/materiality.js';
import * as goldenSignals from '../grades/golden-signals.js';
import * as entityBaseline from '../anomaly/entity-baseline.js';
import * as privacyBudget from '../privacy/privacy-budget.js';
import * as memoryStore from '../learning/memory-store.js';
import * as driftForecast from '../drift/drift-forecast.js';
import { DriftWatchdog, formatWatchdogAlert } from '../ambient/drift-watchdog.js';
import * as expectedRange from '../validation/expected-range.js';
import * as ledger from '../provenance/assumption-ledger.js';
import { createTouchLedger, summarizeTouchLedger, exportTouchLedger } from '../provenance/ai-touch-ledger.js';
import * as provenance from '../provenance/provenance.js';
import * as sdProof from '../provenance/selective-disclosure-proof.js';
import * as dataBlame from '../provenance/data-blame.js';
import * as deidVerifier from '../provenance/deidentification-verifier.js';
import * as dataBom from '../provenance/data-bom.js';
import { buildDataNutritionLabel, renderLabelSummaryLines, exportLabelAsJSON } from '../provenance/data-nutrition-label.js';
import { buildSyntheticDataPassport, sealSyntheticPassport, renderPassportSummaryLines, exportPassportAsJSON } from '../privacy/synthetic-data-passport.js';
import * as denialProfiler from '../provenance/denial-root-cause.js';
import * as costOfBadData from '../provenance/cost-of-bad-data.js';
import { generateQuestions } from '../agents/question-generator-agent.js';
import { shouldOfferPackBuilder, mountConversationalPackBuilder } from '../agents/conversational-pack-ui.js';
import { MetricRegistry, renderMetricStudio } from '../metrics/metric-studio.js';
import { MetricContractRegistry } from '../metrics/metric-contracts.js';
import { buildHistoryListContent, renderDiffView } from '../metrics/metric-contract-diff-view.js';
import { renderConfirmGate } from '../metrics/metric-contract-confirm-gate.js';
import { collectTrustSignals, renderTrustStrip } from '../trust/trust-strip.js';
import { openProofDrawer } from '../trust/proof-drawer.js';
import { buildProofRoomPlan, renderProofRoom } from '../provenance/proof-room.js';
import { computeReadinessGate } from '../gate/readiness-gate.js';
import { renderReadinessBadge } from '../gate/readiness-gate-ui.js';
import { createQueryMemoryLog, QUERY_KINDS } from '../provenance/query-memory.js';
import { renderQueryMemoryBadge } from '../provenance/query-memory-ui.js';
import { registerObject, listObjectSpace } from './object-space.js';
import { computeGlowPathState } from './glow-path.js';
import { renderGlowPath, createGlowPathDismissalStore } from './glow-path-ui.js';
import { computeGlowSignal } from '../glow/glow-signal.js';
import { renderGlowOrb } from '../glow/glow-orb-ui.js';
import { generateRoomCode, isRoomsSupported, RoomSignalingCoordinator } from '../rooms/room-signaling.js';
import { RoomBroadcastCoordinator } from '../rooms/room-broadcast.js';
import { createGithubRoomSignaling, createRoomWebRTCTransport } from '../rooms/room-transport-adapter.js';
import { buildRoomPillModel, buildPresenceModel, renderRoomUi, notifyRemoteEntry } from '../rooms/room-ui.js';
import { createProficiencyTracker } from '../learning/proficiency-signal.js';
import { shouldOfferMeetingScribe, mountMeetingScribe } from '../agents/meeting-scribe-ui.js';
import { sealClaim } from '../diplomacy/diplomacy-claim.js';
import { reconcileClaims } from '../diplomacy/reconciliation-engine.js';
import { createApprovalRequest, approve as approveDiplomacy, reject as rejectDiplomacy } from '../diplomacy/diplomacy-approval-gate.js';
import { renderDiplomacyPanel } from '../diplomacy/diplomacy-ui.js';
import { shouldOfferConvergence, mountConvergence } from '../validation/source-convergence-ui.js';
import { shouldOfferDecisionLedger, mountDecisionLedger } from '../agents/meeting-decision-ledger-ui.js';
import * as firewall from '../agents/agent-action-firewall.js';
// Capability modules loaded lazily through the platform-aware registry (see
// bootstrapCapabilities below). They are `let` bindings, assigned once the
// registry has dynamically imported the modules appropriate for this runtime;
// every consumer runs inside an init*/event handler that fires only after
// bootstrap, so the bindings are always populated before use. The rest of the
// ~55 capability modules remain static imports for now — see the follow-up
// issue tracked in the PR that introduced this registry.
let domainPhysics;
// Populated in bootstrapCapabilities when the `pluginPacks` flag is on: the
// loaded domain-pack plugin registry, used to install the active pack source and
// to surface loaded-pack provenance on the trust/audit page.
let packRegistry;
let devilsAdvocate;
let robustnessVerdictMod;
let syntheticAdversarial;
import * as pyRuntime from '../runtimes-viz/python-runtime.js';
import * as rRuntime from '../runtimes-viz/r-runtime.js';
let receipt;
let peerReview;
let timeTravel;
let syntheticTwin;
let timeMachine;
import * as fingerprint from '../federated/federated-fingerprint.js';
let irbMode;
import * as ondeviceLLM from '../narrative/ondevice-llm.js';
let digitalTwin;
let watchFolder;
let problemFramer;
let exportReport;
let microLessons;
let communityPack;
import { DatabricksConnector, DEFAULT_QUERY, TRUST_NOTICE } from './databricks-connect.js';
import { withCanonical } from '../validation/categorical-consistency.js';
import { SelfLearningModel, MIN_EXAMPLES, actionToLabel } from '../learning/self-learning-rules.js';
import { LayerPriorityModel, MIN_ACTIONS } from '../learning/adaptive-priority.js';
import { LocalFingerprintModel, MIN_COHORT, DEFAULT_EPSILON } from '../federated/federated-learning.js';
import { FederatedCoordinator, createGithubSignaling, createWebRTCMesh } from '../federated/federated-transport.js';
import { buildTabGroups, groupForTab } from './tab-groups.js';
import { createValidateFocusStore } from './validate-focus.js';

// ============================================================
// Tab Definitions
// ============================================================
const TAB_META = {
  framer: { label: 'Problem Framer', icon: 'compass' },
  preflight: { label: 'Preflight', icon: 'check-circle' },
  sql: { label: 'SQL', icon: 'database' },
  python: { label: 'Python', icon: 'code' },
  r: { label: 'R', icon: 'bar-chart-2' },
  clean: { label: 'Clean', icon: 'sparkles' },
  validate: { label: 'Validate', icon: 'shield' },
  diff: { label: 'Diff', icon: 'git-compare' },
  visualize: { label: 'Visualize', icon: 'pie-chart' },
  story: { label: 'Story', icon: 'book-open' },
  twin: { label: 'Digital Twin', icon: 'sliders' },
  watch: { label: 'Watch Folder', icon: 'folder' },
  meeting: { label: 'Meeting', icon: 'message-circle' },
  diplomacy: { label: 'Diplomacy', icon: 'handshake' },
  proofroom: { label: 'Proof Room', icon: 'shield' },
  convergence: { label: 'Convergence', icon: 'git-merge' },
};

const ICONS = {
  'check-circle': '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  'bar-chart-2': '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  sparkles: '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M5 3v4M3 5h4M19 17v4M17 19h4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  'pie-chart': '<path d="M21.21 15.89A10 10 0 118 2.83"/><path d="M22 12A10 10 0 0012 2v10z"/>',
  'book-open': '<path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>',
  smartphone: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/>',
  'git-compare': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><path d="M11 18H8a2 2 0 01-2-2V9"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  folder: '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  'message-circle': '<path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/>',
  handshake: '<path d="M11 12l2 2 3-3 4 4"/><path d="M13 14l-2 2-2-2-3 3-2-2"/><path d="M3 10l4-4 4 3"/><path d="M21 10l-4-4-3 2"/>',
  'git-merge': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 009 9"/>',
};

function iconSvg(name, size = 15) {
  return `<svg class="tab-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ICONS[name] || ''}</svg>`;
}

// ============================================================
// Theme
// ============================================================
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('#btn-theme-toggle');
  btn.innerHTML = theme === 'dark'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  $('#theme-chip-light').classList.toggle('active', theme === 'light');
  $('#theme-chip-dark').classList.toggle('active', theme === 'dark');
}

function initTheme() {
  const preferred = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(preferred);
  $('#btn-theme-toggle').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
  $('#theme-chip-light').addEventListener('click', () => applyTheme('light'));
  $('#theme-chip-dark').addEventListener('click', () => applyTheme('dark'));
}

// ============================================================
// Tab Bar (draggable + reorderable)
// ============================================================
let activeTab = 'preflight';

function renderTabBar() {
  const bar = $('#tabbar');
  bar.innerHTML = '';
  bar.classList.toggle('tabbar-grouped', isEnabled('groupedNavigation'));
  // The 'meeting' tab is the meetingScribe flag's dark-by-default gate: with
  // the flag off (its shipped default) it is simply never added to the bar,
  // never a dead click target, and #panel-meeting stays empty and hidden
  // (see renderMeetingScribeTab). No other tab is filtered.
  // The 'diplomacy' tab follows the exact same dark-by-default gate as
  // 'meeting': with the dataDiplomacy flag off (its shipped default) it is
  // never added to the bar, never a dead click target, and #panel-diplomacy
  // stays empty (see renderDiplomacyTab). No other tab is filtered.
  // The 'proofroom' tab follows the same dark-by-default gate as 'meeting'
  // and 'diplomacy': with the proofRoom flag off (its shipped default) it is
  // never added to the bar, never a dead click target, and #panel-proofroom
  // stays empty (see renderProofRoomTab). It gates ONLY this composed tab's
  // visibility — never any of the five underlying trust-surface flags.
  // The 'convergence' tab follows the same dark-by-default gate as 'meeting',
  // 'diplomacy', and 'proofroom': with the sourceConvergenceUI flag off (its
  // shipped default) it is never added to the bar, never a dead click target,
  // and #panel-convergence stays empty (see renderConvergenceTab). It gates ONLY
  // this UI tab — never the Batch 1/2 engine flags it builds on.
  const visibleTabOrder = state.tabOrder.filter((tabId) =>
    (tabId !== 'meeting' || isEnabled('meetingScribe'))
    && (tabId !== 'diplomacy' || isEnabled('dataDiplomacy'))
    && (tabId !== 'proofroom' || isEnabled('proofRoom'))
    && (tabId !== 'convergence' || isEnabled('sourceConvergenceUI')));

  // Shared per-tab element builder — IDENTICAL markup/handlers whether the
  // flat or grouped renderer is active, so every existing test/selector
  // (data-testid, draggable, switchTab wiring) keeps working unchanged.
  function buildTabEl(tabId, idx) {
    const meta = TAB_META[tabId];
    const tabEl = el('div', {
      class: `tab ${tabId === activeTab ? 'active' : ''}`,
      draggable: 'true',
      'data-tab': tabId,
      'data-testid': `tab-${tabId}`,
      onclick: () => switchTab(tabId),
    }, [
      el('span', { html: iconSvg(meta.icon) }),
      el('span', {}, meta.label),
    ]);
    tabEl.addEventListener('dragstart', (e) => { tabEl.classList.add('dragging'); e.dataTransfer.setData('text/plain', idx); });
    tabEl.addEventListener('dragend', () => tabEl.classList.remove('dragging'));
    tabEl.addEventListener('dragover', (e) => e.preventDefault());
    tabEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const toIdx = idx;
      if (fromIdx === toIdx) return;
      const arr = [...state.tabOrder];
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      state.tabOrder = arr;
      renderTabBar();
    });
    return tabEl;
  }

  if (!isEnabled('groupedNavigation')) {
    // Original flat single-row bar — byte-for-byte the same behavior as
    // before this PR when the flag is off.
    visibleTabOrder.forEach((tabId, idx) => bar.appendChild(buildTabEl(tabId, idx)));
    return;
  }

  // Grouped bar: same tab ids, same click/drag behavior, presented under
  // named mode headers instead of one flat row. idx passed to each tab is
  // still its index within the FULL visibleTabOrder (not the sub-group), so
  // drag-reorder math (which operates on state.tabOrder as a whole) is
  // unaffected by which group a tab visually sits in.
  const idxByTabId = new Map(visibleTabOrder.map((tabId, idx) => [tabId, idx]));
  const groups = buildTabGroups(visibleTabOrder);
  const activeGroupId = groupForTab(activeTab);
  groups.forEach((group) => {
    const groupEl = el('div', { class: `tab-group ${group.id === activeGroupId ? 'tab-group-active' : ''}` }, [
      el('div', { class: 'tab-group-label' }, group.label),
      el('div', { class: 'tab-group-tabs' }, group.tabIds.map((tabId) => buildTabEl(tabId, idxByTabId.get(tabId)))),
    ]);
    bar.appendChild(groupEl);
  });
}

function switchTab(tabId) {
  const previousTab = activeTab;
  activeTab = tabId;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tabId));
  // Grouped nav highlights the whole mode header the active tab lives in;
  // a full re-render is the simplest correct way to move that highlight
  // when the new active tab is in a different group than the old one.
  if (isEnabled('groupedNavigation') && groupForTab(previousTab) !== groupForTab(tabId)) renderTabBar();
  // Leaving the SQL tab: terminate the ambient-validation worker so it never
  // lingers in the background (recreated lazily on the next keystroke).
  if (previousTab === 'sql' && tabId !== 'sql') teardownAmbientWorker();
  if (tabId === 'sql') renderSavedMetrics();
  if (tabId === 'python') ensurePythonRuntime();
  if (tabId === 'r') ensureRRuntime();
  if (tabId === 'validate') renderOneCanvasPhase1();
  if (tabId === 'twin') buildTwinControls();
  if (tabId === 'meeting') renderMeetingScribeTab();
  if (tabId === 'diplomacy') renderDiplomacyTab();
  if (tabId === 'proofroom') renderProofRoomTab();
  if (tabId === 'convergence') renderConvergenceTab();
  renderCommandDeckSidebar();
  // Glow Path (Batch A): keep the next-action rail in sync as the user moves
  // between tools. No-op when the glowPathRail flag is off.
  renderGlowPathRail();
  // The Glow (Batch 2): refresh the topbar orb verdict. No-op when glowOrb off.
  renderGlowOrbWidget();
  // DataGlow Rooms (Batch 3): keep the topbar Room pill/presence in sync. No-op
  // when the roomsUi flag is off.
  renderRoomUiWidget();
}

// ============================================================
// Command Deck sidebar (Gen 44, Part 1 -- ships dark)
// ============================================================
// Alternate nav sitting alongside the existing top tab bar. The top tab bar
// stays the default/fallback; this only appears when dataglowSidebarNav is
// enabled (off by default). Pure reorganization of the existing tabs --
// zero new logic, zero new panels. See js/app-shell/command-deck-nav.js for
// the pure stage-grouping model and docs/capability-map.md for the decision
// record (direction / scope / naming), all resolved by the agent per the
// user's "build all, safely and smartly" instruction.
const collapsedStages = new Set();

function renderCommandDeckSidebar() {
  const host = document.getElementById('command-deck-sidebar');
  if (!host) return;
  if (!isEnabled('dataglowSidebarNav')) { host.style.display = 'none'; host.innerHTML = ''; return; }
  host.style.display = '';
  host.innerHTML = '';

  const { stages } = buildSidebarContent({ tabMeta: TAB_META, activeTab });

  stages.forEach((stage) => {
    const collapsed = collapsedStages.has(stage.id);
    const stageEl = el('div', { class: `cd-stage ${collapsed ? 'collapsed' : ''}`, 'data-testid': `cd-stage-${stage.id}` });

    const header = el('div', {
      class: `cd-stage-header ${stage.containsActive ? 'contains-active' : ''}`,
      title: stage.description,
      onclick: () => {
        if (collapsedStages.has(stage.id)) collapsedStages.delete(stage.id);
        else collapsedStages.add(stage.id);
        renderCommandDeckSidebar();
      },
    }, [
      el('span', {}, stage.label),
      el('svg', { class: 'cd-stage-chevron', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', html: '<polyline points="6 9 12 15 18 9"/>' }),
    ]);
    stageEl.appendChild(header);

    const tabsWrap = el('div', { class: 'cd-stage-tabs' });
    stage.tabs.forEach((t) => {
      const tabEl = el('div', {
        class: `cd-tab ${t.active ? 'active' : ''}`,
        'data-testid': `cd-tab-${t.id}`,
        onclick: () => switchTab(t.id),
      }, [
        el('span', { html: iconSvg(t.icon) }),
        el('span', {}, t.label),
      ]);
      tabsWrap.appendChild(tabEl);
    });
    stageEl.appendChild(tabsWrap);

    host.appendChild(stageEl);
  });
}

// ============================================================
// Command palette (Gen 44, Part 2 -- ships dark)
// ============================================================
// Global Ctrl/Cmd+K palette: jump to any real tab, or run a small static
// registry of common in-tool actions. Pure ranking/matching logic lives in
// js/app-shell/command-palette.js; everything below is DOM presentation and
// the action-id -> real-function dispatch table. Independent of the Part 1
// sidebar -- this reads TAB_META/state.tabOrder directly, same drift-proof
// pattern, but does not depend on the sidebar being enabled or rendered.
let paletteSelectedIndex = 0;
let paletteVisibleCommands = [];

// Maps each COMMAND_ACTIONS `run` id to the real function it triggers.
// Kept as one small table so a reviewer can see every palette side effect
// in one place; command-palette.js itself never calls these directly.
function runPaletteAction(runId) {
  if (runId === 'runSqlQuery') { runSqlQuery(); return; }
  if (runId === 'runValidation') { runValidation(); return; }
  if (runId === 'scanClean') { scanClean(); return; }
  if (runId === 'runPreflight') { runPreflight(); return; }
  if (runId === 'runDiagnostics') { runDiagnostics(); return; }
  if (runId === 'exportXlsx') { runExport('xlsx', $('#export-note')); return; }
}

function isCommandPaletteOpen() {
  const overlay = document.getElementById('command-palette-overlay');
  return !!overlay && overlay.classList.contains('open');
}

function openCommandPalette() {
  if (!isEnabled('dataglowCommandPalette')) return;
  const overlay = document.getElementById('command-palette-overlay');
  const input = document.getElementById('command-palette-input');
  if (!overlay || !input) return;
  overlay.classList.add('open');
  input.value = '';
  paletteSelectedIndex = 0;
  renderCommandPaletteResults('');
  input.focus();
}

function closeCommandPalette() {
  const overlay = document.getElementById('command-palette-overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
}

function chooseCommand(cmd) {
  if (!cmd) return;
  closeCommandPalette();
  if (cmd.type === 'tab') switchTab(cmd.tabId);
  else if (cmd.type === 'action') runPaletteAction(cmd.run);
}

function renderCommandPaletteResults(query) {
  const resultsEl = document.getElementById('command-palette-results');
  if (!resultsEl) return;
  resultsEl.innerHTML = '';

  const all = buildCommandList({ tabMeta: TAB_META, tabOrder: state.tabOrder, activeTab });
  paletteVisibleCommands = filterCommands(all, query, 30);
  if (paletteSelectedIndex >= paletteVisibleCommands.length) paletteSelectedIndex = 0;

  if (paletteVisibleCommands.length === 0) {
    resultsEl.appendChild(el('div', { class: 'command-palette-empty' }, 'No matching commands'));
    return;
  }

  paletteVisibleCommands.forEach((cmd, idx) => {
    const item = el('div', {
      class: `command-palette-item ${idx === paletteSelectedIndex ? 'selected' : ''}`,
      'data-testid': `command-palette-item-${cmd.id}`,
      onclick: () => chooseCommand(cmd),
    }, [
      el('span', { html: cmd.icon ? iconSvg(cmd.icon) : '' }),
      el('span', {}, cmd.label),
      el('span', { class: 'command-palette-item-type' }, cmd.type === 'tab' ? 'Go to' : 'Action'),
    ]);
    resultsEl.appendChild(item);
  });
}

function initCommandPalette() {
  const overlay = document.getElementById('command-palette-overlay');
  const input = document.getElementById('command-palette-input');
  if (!overlay || !input) return;

  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (isCommandPaletteOpen()) closeCommandPalette();
      else openCommandPalette();
      return;
    }
    if (!isCommandPaletteOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteSelectedIndex = Math.min(paletteSelectedIndex + 1, paletteVisibleCommands.length - 1);
      renderCommandPaletteResults(input.value);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteSelectedIndex = Math.max(paletteSelectedIndex - 1, 0);
      renderCommandPaletteResults(input.value);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      chooseCommand(paletteVisibleCommands[paletteSelectedIndex]);
    }
  });

  input.addEventListener('input', () => {
    paletteSelectedIndex = 0;
    renderCommandPaletteResults(input.value);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCommandPalette();
  });
}


// ============================================================
// Dataset Sidebar
// ============================================================
function renderSidebar() {
  const list = $('#dataset-list');
  const tableList = $('#table-list');
  if (state.datasets.length === 0) {
    list.innerHTML = '<div style="font-size:var(--text-xs); color:var(--color-text-faint);">No datasets loaded yet</div>';
    tableList.innerHTML = 'No tables yet';
  } else {
    list.innerHTML = '';
    state.datasets.forEach(ds => {
      const item = el('div', { class: `dataset-item ${ds.name === state.activeDataset ? 'active' : ''}`, onclick: () => { state.activeDataset = ds.name; renderSidebar(); refreshFreshnessBadge(); renderOneCanvasPhase1(); renderSavedMetrics(); } }, [
        el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', html: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>' }),
        el('span', { style: 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;' }, ds.name),
      ]);
      list.appendChild(item);
    });
    tableList.innerHTML = state.datasets.map(ds => {
      const dropped = Number(ds.droppedRows || 0);
      const warn = dropped > 0
        ? ` <span data-testid="dataset-dropped-badge" title="${dropped.toLocaleString()} row(s) were skipped due to CSV parsing errors when this file loaded" style="color:var(--color-warn, #C9A227); cursor:help;">⚠ ${dropped.toLocaleString()} skipped</span>`
        : '';
      return `<div class="mono" style="padding:4px 0;">${escapeHtml(ds.table)} <span style="color:var(--color-text-faint);">(${ds.rowCount.toLocaleString()})</span>${warn}</div>`;
    }).join('');
  }
  refreshFreshnessBadge();
  renderObjectSpacePanel();
}

function refreshFreshnessBadge() {
  const ds = getActiveDataset();
  const badge = $('#freshness-badge');
  const text = $('#freshness-text');
  if (!ds) { text.textContent = 'No dataset loaded'; badge.className = 'freshness-badge'; return; }
  const ageHours = (Date.now() - ds.loadedAt) / 3600000;
  const threshold = state.settings.freshnessThresholdHours;
  text.textContent = `${ds.table} — loaded ${timeAgo(ds.loadedAt)}`;
  badge.className = 'freshness-badge' + (ageHours > threshold * 3 ? ' very-stale' : ageHours > threshold ? ' stale' : '');
}
setInterval(refreshFreshnessBadge, 30000);

// ============================================================
// File Loading
// ============================================================
function initFileLoading() {
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault(); dropzone.classList.remove('dragover');
    await handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', async (e) => { await handleFiles(e.target.files); fileInput.value = ''; });

  $('#btn-load-golden').addEventListener('click', () => requestDatasetLoad('golden'));

  const omopBtn = $('#btn-load-omop-sample');
  if (omopBtn) omopBtn.addEventListener('click', () => requestDatasetLoad('omop'));

  const fhirBtn = $('#btn-load-fhir-sample');
  if (fhirBtn) fhirBtn.addEventListener('click', () => requestDatasetLoad('fhir'));

  // If a sample-dataset load was requested during the pre-isolation window on a
  // previous page view (before the service worker reloaded the page into a
  // cross-origin isolated context), replay it now that the engine can actually
  // start. This closes the race where a fast click on first load — before the
  // one-time reload — would otherwise be silently dropped by that reload.
  replayPendingDatasetLoad();
}

// Keyed sample-dataset load actions. Keyed (rather than inline closures) so a
// request made before cross-origin isolation is established can be persisted by
// id and replayed after the one-time service-worker reload — see
// requestDatasetLoad / replayPendingDatasetLoad and the isolation notes in
// index.html.
const DATASET_ACTIONS = {
  golden: async () => {
    await ensureDuckDB();
    await loaders.loadGoldenDataset();
    renderSidebar();
    resetPanelStates();
  },
  omop: async () => {
    await ensureDuckDB();
    await loaders.loadOmopSampleDataset();
    selectDomainPack('omop');
    renderSidebar();
    resetPanelStates();
  },
  fhir: async () => {
    await ensureDuckDB();
    await loaders.loadFhirSampleDataset();
    selectDomainPack('fhir');
    renderSidebar();
    resetPanelStates();
  },
};

const PENDING_LOAD_KEY = 'dataglow-pending-load';

// True while the page is not yet cross-origin isolated but the service worker is
// expected to reload it into an isolated context (window.__dataglowIsolation is
// set in index.html). Starting a DuckDB load in this window is both pointless
// (no SharedArrayBuffer) and unsafe (the imminent reload tears the handler down
// mid-flight, which was the original silent-failure symptom).
function isolationPending() {
  return typeof window !== 'undefined' && window.__dataglowIsolation === 'pending';
}

// Entry point for the sample-dataset buttons. Runs the load immediately when the
// engine can start; otherwise queues it (persisted across the reload) and shows
// a non-error "starting…" state instead of silently dropping the click.
function requestDatasetLoad(id) {
  if (isolationPending()) {
    try { sessionStorage.setItem(PENDING_LOAD_KEY, id); } catch (e) { /* private mode */ }
    showEngineInitializing();
    return;
  }
  runDatasetLoad(DATASET_ACTIONS[id]);
}

function replayPendingDatasetLoad() {
  let id = null;
  try { id = sessionStorage.getItem(PENDING_LOAD_KEY); } catch (e) { return; }
  // Only replay once we've left the pending window (isolated, or failed/
  // unsupported where the loud-failure UX will surface the real reason). Never
  // replay while still pending, or the same reload race would recur.
  if (!id || !DATASET_ACTIONS[id] || isolationPending()) return;
  try { sessionStorage.removeItem(PENDING_LOAD_KEY); } catch (e) {}
  runDatasetLoad(DATASET_ACTIONS[id]);
}

// Pre-select a domain pack in the dropdown (used when loading a standards sample
// so the matching pack — and its medical disclaimer — is active straight away).
function selectDomainPack(name) {
  const sel = $('#domain-pack-select');
  if (sel && [...sel.options].some(o => o.value === name)) sel.value = name;
}

async function handleFiles(files) {
  // A File can't be persisted across the one-time isolation reload, so during
  // the pending window we don't start (and silently lose) the load — we show the
  // "starting…" state; the reload lands on an isolated page moments later and the
  // user can re-add the file, which then loads normally.
  if (isolationPending()) { showEngineInitializing(); return; }
  await runDatasetLoad(async () => {
    await ensureDuckDB();
    for (const file of files) {
      try {
        await loaders.loadFile(file);
      } catch (e) { /* toast already shown */ }
    }
    renderSidebar();
    resetPanelStates();
  });
}

// ============================================================
// Databricks Direct-Connect (proof of concept)
// ============================================================
// Optional: pull a read-only SQL result from the user's OWN Databricks
// workspace into the SAME local DuckDB path a file upload uses
// (loaders.loadRowsAsDataset). The token lives only in the in-memory input for
// the duration of the call — never stored, never persisted, never proxied.
function initDatabricksConnect() {
  const runBtn = $('#btn-databricks-run');
  if (!runBtn) return;
  const hostEl = $('#databricks-host');
  const tokenEl = $('#databricks-token');
  const warehouseEl = $('#databricks-warehouse');
  const sqlEl = $('#databricks-sql');
  const statusEl = $('#databricks-status');
  const trustEl = $('#databricks-trust-note');
  if (trustEl) trustEl.textContent = TRUST_NOTICE;
  if (sqlEl && !sqlEl.value.trim()) sqlEl.value = DEFAULT_QUERY;

  const setStatus = (msg, type = 'muted') => {
    if (!statusEl) return;
    const color = type === 'error' ? 'var(--color-danger, #c0392b)'
      : type === 'success' ? 'var(--color-success, #2e7d32)'
      : 'var(--color-text-muted)';
    statusEl.style.color = color;
    statusEl.textContent = msg;
  };

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    setStatus('Submitting query to your workspace…');
    try {
      await ensureDuckDB();
      const connector = new DatabricksConnector({
        fetch: (url, init) => window.fetch(url, init),
        loadRows: (args) => loaders.loadRowsAsDataset(args),
      });
      const result = await connector.run({
        host: hostEl.value,
        token: tokenEl.value,
        warehouseId: warehouseEl.value,
        statement: sqlEl.value,
        name: 'databricks_query',
        onState: (s) => setStatus(`Query ${s.toLowerCase()}…`),
      });
      // Never keep the token around after the call returns.
      tokenEl.value = '';
      renderSidebar();
      resetPanelStates();
      const note = result.truncated ? ' (first chunk only — see connector docs)' : '';
      setStatus(`Imported ${result.rowCount.toLocaleString()} rows${note}.`, 'success');
    } catch (err) {
      setStatus(err.message || 'Databricks connection failed.', 'error');
    } finally {
      runBtn.disabled = false;
    }
  });
}

function resetPanelStates() {
  const hasData = state.datasets.length > 0;
  $('#preflight-empty').style.display = hasData ? 'none' : '';
  $('#clean-empty').style.display = hasData ? 'none' : '';
  $('#validate-empty').style.display = hasData ? 'none' : '';
  $('#visualize-empty').style.display = hasData ? 'none' : '';
  const twinEmpty = $('#twin-empty');
  if (twinEmpty) { twinEmpty.style.display = hasData ? 'none' : ''; $('#twin-body').style.display = hasData ? '' : 'none'; }
  if (activeTab === 'twin') buildTwinControls();
  if (hasData) {
    $('#sql-input').value = $('#sql-input').value || `SELECT * FROM ${getActiveDataset().table} LIMIT 100;`;
    populateVisualizeBuilder();
  }
}

async function ensureDuckDB() {
  if (state.duckdb.ready) return;
  toast('Starting DuckDB-WASM engine…', 'warn');
  try {
    await engine.initDuckDB();
  } catch (err) {
    toast('Data engine failed to start: ' + (err && err.message || err), 'error');
    throw err;
  }
  toast('DuckDB-WASM engine ready', 'success');
}

// Render a visible, actionable failure banner in the Load Data sidebar. This is
// the defense-in-depth against silent failures: if the DuckDB-WASM engine can't
// start (or a dataset can't load), the user sees the real reason and a Retry
// button instead of the UI quietly reverting to "No dataset loaded".
function showEngineError(err, onRetry) {
  const box = $('#engine-error');
  if (!box) return;
  const reason = (err && err.message) ? err.message : String(err || 'Unknown error');
  const notIsolated = typeof window !== 'undefined' && window.crossOriginIsolated === false;
  box.innerHTML = '';
  box.appendChild(el('div', { class: 'engine-error-title' }, 'Couldn’t start the data engine'));
  box.appendChild(el('div', { class: 'engine-error-detail', 'data-testid': 'engine-error-detail' }, reason));
  if (notIsolated) {
    box.appendChild(el('div', { class: 'engine-error-hint' },
      'This page is not cross-origin isolated (the COOP/COEP headers are missing), so the in-browser SQL engine can’t start. A reload often fixes it once the service worker is active; if it persists, the site needs to send Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers.'));
  }
  const retry = el('button', { class: 'btn btn-primary', 'data-testid': 'button-engine-retry' }, 'Retry');
  retry.addEventListener('click', async () => {
    clearEngineError();
    if (typeof onRetry === 'function') {
      try { await onRetry(); }
      catch (e) { showEngineError(e, onRetry); }
    }
  });
  box.appendChild(retry);
  box.style.display = '';
}

function clearEngineError() {
  const box = $('#engine-error');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
}

// Non-error "one moment" state shown when a load is requested before the page is
// cross-origin isolated. The service worker is about to reload the page into an
// isolated context, after which any queued sample-dataset load replays
// automatically (see requestDatasetLoad / replayPendingDatasetLoad).
function showEngineInitializing() {
  const box = $('#engine-error');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(el('div', { class: 'engine-error-title' }, 'Starting the data engine…'));
  box.appendChild(el('div', { class: 'engine-error-detail', 'data-testid': 'engine-initializing' },
    'Preparing a secure in-browser environment. Your dataset will load automatically in a moment.'));
  box.style.display = '';
}

// Run a dataset-loading action, surfacing any engine/load failure as a visible,
// retryable banner instead of letting the click handler's promise reject
// silently. The Retry button re-runs the exact same action.
//
// A fast double-click (or any concurrent trigger) would otherwise fire two
// loads that race through ensureDuckDB() -> loaders.load*() -> createTableFromRows(),
// whose DROP TABLE IF EXISTS + CREATE TABLE pair can interleave and throw
// "Catalog Error: Table ... already exists". datasetLoadInFlight makes a second
// call a safe no-op while one load is still running; the finally resets it so
// the Retry button (a fresh call after this one settles) still works.
let datasetLoadInFlight = false;
async function runDatasetLoad(action) {
  if (datasetLoadInFlight) return;
  datasetLoadInFlight = true;
  clearEngineError();
  try {
    await action();
  } catch (err) {
    console.error('DATAGLOW dataset load failed:', err);
    showEngineError(err, () => runDatasetLoad(action));
  } finally {
    datasetLoadInFlight = false;
  }
}

// ============================================================
// Preflight Tab
// ============================================================
async function runPreflight() {
  const ds = getActiveDataset();
  if (!ds) { toast('Load a dataset first', 'error'); return; }
  $('#preflight-empty').style.display = 'none';
  const resultsEl = $('#preflight-results');
  resultsEl.style.display = '';
  resultsEl.innerHTML = '<div class="skeleton" style="height:120px; border-radius:var(--radius-lg);"></div>';

  const checks = [];
  checks.push({ label: 'Rows loaded', value: ds.rowCount.toLocaleString(), status: ds.rowCount > 0 ? 'pass' : 'fail' });
  checks.push({ label: 'Columns', value: ds.cols.length, status: ds.cols.length > 0 ? 'pass' : 'fail' });

  let nullCols = 0;
  for (const c of ds.cols) {
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${ds.table} WHERE "${c.name}" IS NULL`);
    if (rows[0].n > 0) nullCols++;
  }
  checks.push({ label: 'Columns with nulls', value: `${nullCols} / ${ds.cols.length}`, status: nullCols === 0 ? 'pass' : nullCols < ds.cols.length / 2 ? 'warn' : 'fail' });

  const allCols = ds.cols.map(c => `"${c.name}"`).join(',');
  const { rows: dupRows } = await engine.runQuery(`SELECT SUM(c) - COUNT(*) AS extra FROM (SELECT ${allCols}, COUNT(*) AS c FROM ${ds.table} GROUP BY ${allCols} HAVING COUNT(*) > 1) t`);
  checks.push({ label: 'Duplicate rows', value: dupRows[0].extra || 0, status: !dupRows[0].extra ? 'pass' : 'warn' });

  const ageHours = (Date.now() - ds.loadedAt) / 3600000;
  checks.push({ label: 'Freshness', value: timeAgo(ds.loadedAt), status: ageHours < state.settings.freshnessThresholdHours ? 'pass' : 'warn' });

  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const overall = failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass';

  resultsEl.innerHTML = '';
  const summary = el('div', { class: 'card', style: 'padding:var(--space-5); margin-bottom:var(--space-4); display:flex; align-items:center; gap:var(--space-3);' }, [
    el('span', { class: `status-dot ${overall}`, style: 'width:14px;height:14px;' }),
    el('div', {}, [
      el('div', { style: 'font-weight:600; font-size:var(--text-lg);' }, overall === 'pass' ? 'Ready for analysis' : overall === 'warn' ? 'Usable, with caveats' : 'Needs attention before analysis'),
      el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted);' }, `Dataset: ${ds.table} · ${ds.cols.length} columns · ${ds.rowCount.toLocaleString()} rows`),
    ]),
  ]);
  resultsEl.appendChild(summary);

  const grid = el('div', { class: 'validation-grid' });
  for (const c of checks) {
    grid.appendChild(el('div', { class: 'card validation-card' }, [
      el('div', { class: 'validation-card-head' }, [
        el('span', { class: 'validation-card-name' }, c.label),
        el('span', { class: `validation-status ${c.status}` }, [el('span', { class: `status-dot ${c.status}` }), c.status.toUpperCase()]),
      ]),
      el('div', { style: 'font-size:var(--text-lg); font-weight:600;' }, String(c.value)),
    ]));
  }
  resultsEl.appendChild(grid);

  const colsCard = el('div', { class: 'card', style: 'padding:var(--space-4); margin-top:var(--space-4);' }, [
    el('div', { class: 'sidebar-heading' }, 'Column Schema'),
    el('div', { class: 'result-table-wrap' }, [
      el('table', { class: 'result-table', html: `<thead><tr><th>Column</th><th>Type</th></tr></thead><tbody>${ds.cols.map(c => `<tr><td>${escapeHtml(c.name)}</td><td class="mono">${escapeHtml(c.type)}</td></tr>`).join('')}</tbody>` }),
    ]),
  ]);
  resultsEl.appendChild(colsCard);
}

// ============================================================
// SQL Tab
// ============================================================

// ------------------------------------------------------------
// Local Analysis Contract wiring (feature-flagged: localAnalysisContract)
// ------------------------------------------------------------
// Builds the { tables: { [name]: { columns, rowCount, approxDistinct } } }
// shape buildSchemaIndex()/runAnalysisContract() expect, from every loaded
// dataset (not just the active one), so cross-table JOINs are checkable.
// approxDistinct is populated lazily and only for columns actually named in
// this query's JOIN ON / GROUP BY clauses — running approx_count_distinct
// over every column of every loaded table on every Run would be wasteful.
async function buildLiveSchemaForContract(sql) {
  const tables = {};
  for (const ds of state.datasets || []) {
    tables[ds.table] = { columns: ds.cols, rowCount: ds.rowCount, approxDistinct: {} };
  }

  // Also fold in tables that exist in the live DuckDB catalog but never went
  // through the file loader — a table made with CREATE TABLE ... AS, or one
  // materialized from the Python/R bridges (more common now objectSpaceRegistry
  // is live). Without these, the hallucination check compares every identifier
  // in such a query against a column list that omits the very table being
  // queried, and false-flags real columns as "hallucinated". Best-effort: a
  // catalog lookup failure just leaves the file-loaded tables in place rather
  // than breaking the contract, and file-loaded tables already present win.
  try {
    for (const tableName of await engine.listTables()) {
      if (tables[tableName]) continue;
      try {
        tables[tableName] = {
          columns: (await engine.getTableSchema(tableName)).map(s => ({ name: s.column_name, type: s.column_type })),
          rowCount: null,
          approxDistinct: {},
        };
      } catch { /* a table we can't introspect is simply skipped */ }
    }
  } catch { /* no live catalog available — fall back to state.datasets only */ }

  // Columns worth spending an approx_count_distinct query on: anything named
  // in a JOIN ON clause or a GROUP BY — exactly what the fan-out/guard checks
  // in analysis-contract.js and the ambient sanity anchor actually consult.
  const onClauses = [...sql.matchAll(/\bjoin\b[\s\S]*?\bon\s+([\s\S]*?)(?=\bjoin\b|\bwhere\b|\bgroup\b|\border\b|\bhaving\b|\blimit\b|$)/gi)].map(m => m[1]);
  const groupByMatch = /group\s+by\s+([\s\S]*?)(?=\border\b|\bhaving\b|\blimit\b|$)/i.exec(sql);
  const relevantText = [...onClauses, groupByMatch ? groupByMatch[1] : ''].join(' ');
  const relevantCols = new Set((relevantText.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).map(c => c.toLowerCase()));

  const jobs = [];
  for (const [tableName, t] of Object.entries(tables)) {
    for (const col of t.columns || []) {
      if (!relevantCols.has(col.name.toLowerCase())) continue;
      jobs.push((async () => {
        try {
          const { rows } = await engine.runQuery(`SELECT approx_count_distinct(${JSON.stringify(col.name)}) AS n FROM ${tableName}`);
          t.approxDistinct[col.name] = Number(rows[0]?.n);
        } catch {
          // A column that can't be distinct-counted (exotic type, etc.) just
          // stays unmeasured — the checks degrade gracefully without it.
        }
      })());
    }
  }
  await Promise.all(jobs);
  return { tables };
}

// Renders the Analysis Contract report as a dismissible card above the SQL
// result table. Flags-only: this never blocks, rewrites, or auto-runs
// anything — it is purely informational, matching the empowerment
// constraint every agent-shaped module in DATAGLOW holds itself to. Follows
// the same status-dot + tone pattern as renderAmbientWarnings() above: only
// pass/fail/warn exist as real CSS tones (see css/app.css), so an 'info'
// severity flag maps to the 'warn' dot/tone, same as the ambient warnings do.
function renderAnalysisContractCard(container, report) {
  if (!report || report.flagCount === 0) return;
  const toneFor = (sev) => (sev === 'fail' ? 'fail' : 'warn');
  const outerTone = report.status === 'fail' ? 'fail' : report.status === 'pass' ? 'pass' : 'warn';
  const card = el('div', {
    class: 'card',
    'data-testid': 'analysis-contract-card',
    style: 'margin-top:var(--space-3); padding:var(--space-3); display:flex; flex-direction:column; gap:var(--space-2);',
  }, [
    el('div', { style: 'display:flex; align-items:center; justify-content:space-between; gap:var(--space-2);' }, [
      el('span', { class: `validation-status ${outerTone}` }, [
        el('span', { class: `status-dot ${outerTone}` }),
        el('span', {}, 'Local Analysis Contract'),
      ]),
      el('button', {
        class: 'btn btn-secondary',
        style: 'font-size:var(--text-xs); padding:2px 8px;',
        'data-testid': 'analysis-contract-dismiss',
        onclick: () => card.remove(),
      }, 'Dismiss'),
    ]),
    el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, summarizeAnalysisContract(report)),
    el('ul', { style: 'margin:0; padding-left:0; list-style:none; display:flex; flex-direction:column; gap:6px;' },
      report.flags.map(f => el('li', {
        style: 'display:flex; align-items:flex-start; gap:var(--space-2); font-size:var(--text-xs);',
      }, [
        el('span', { class: `status-dot ${toneFor(f.severity)}`, style: 'margin-top:3px; flex:none;' }),
        el('span', { style: 'flex:1;' }, f.message),
      ]))
    ),
  ]);
  container.prepend(card);
}

// Verifiable Check Seal opt-in affordance (feature-flagged: verifiableCheckSeal).
// ------------------------------------------------------------
// Renders a small card offering to SEAL the Analysis Contract result for this
// query. Sealing is ALWAYS an explicit human action (the button click) — nothing
// here seals automatically, matching the empowerment constraint. The seal binds
// the check parameters (the SQL text) and the query RESULT's SHA-256 fingerprint
// to the produced status; verifySeal re-checks it on the spot and offers the
// portable .json artifact as a client-side download (no network). Honest naming:
// the copy never claims certification, zero-knowledge, or blockchain.
function renderCheckSealAffordance(container, report, sql, result) {
  if (!isEnabled('verifiableCheckSeal')) return;
  const ds = getActiveDataset();
  const card = el('div', {
    class: 'card',
    'data-testid': 'check-seal-card',
    style: 'margin-top:var(--space-3); padding:var(--space-3); display:flex; flex-direction:column; gap:var(--space-2);',
  });
  const header = el('div', { style: 'display:flex; align-items:center; justify-content:space-between; gap:var(--space-2);' }, [
    el('span', { class: 'validation-status pass' }, [
      el('span', { class: 'status-dot pass' }),
      el('span', {}, 'Verifiable Check Seal'),
    ]),
    el('button', {
      class: 'btn btn-primary',
      style: 'font-size:var(--text-xs); padding:2px 8px;',
      'data-testid': 'check-seal-create',
      onclick: async () => {
        try {
          const seal = await sealCheckResult(report, {
            check: { name: 'Local Analysis Contract', kind: 'local-analysis-contract' },
            params: sql,
            dataset: {
              name: ds ? ds.name : 'query result',
              rowCount: result ? result.rowCount : null,
              columnNames: result ? result.columns : [],
            },
            // Fingerprint the query RESULT rows — the concrete data in hand. The
            // seal therefore binds to this query's output, not the whole source
            // table (stated in the seal's own disclaimer + the tech-debt note).
            data: result ? result.rows : null,
            dataglow: { version: (window.__dataglowVersion || null), build: null },
          });
          const check = await verifySeal(seal, result ? result.rows : undefined);
          detail.innerHTML = '';
          for (const line of renderSealSummaryLines(seal)) {
            detail.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); white-space:pre;' }, line));
          }
          detail.appendChild(el('div', {
            style: `font-size:var(--text-xs); margin-top:6px; color:var(--color-${check.valid ? 'success' : 'error'});`,
          }, check.valid ? '✓ Re-verified locally: ' + check.reason : '✗ ' + check.reason));
          const dl = el('button', {
            class: 'btn btn-secondary',
            style: 'font-size:var(--text-xs); padding:2px 8px; align-self:flex-start; margin-top:6px;',
            'data-testid': 'check-seal-download',
            onclick: () => downloadText('dataglow-check-seal.json', exportSealAsJSON(seal), 'application/json'),
          }, 'Download seal (.json)');
          detail.appendChild(dl);
          // Trust Beam opt-in affordance (feature-flagged: trustBeam). Turns this
          // just-created seal into a self-contained shareable link whose payload
          // lives in the URL fragment (after '#') so nothing is ever uploaded —
          // a recipient with zero DataGlow install opens verify-beam.html and it
          // re-verifies the seal client-side. No-op when the flag is off. QR image
          // generation is a documented follow-up (no QR library is vendored yet);
          // the copyable link IS the beam artifact for this batch.
          renderBeamAffordance(detail, seal);
          toast('Check result sealed and re-verified locally', 'success');
        } catch (e) {
          toast('Could not seal this result: ' + e.message, 'error');
        }
      },
    }, 'Seal this result'),
  ]);
  const detail = el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' },
    'Optionally seal this check result into a portable proof that it ran against '
    + 'data matching a fingerprint and produced this status — verifiable by anyone '
    + 'with only the artifact, no data. Not a certification and not zero-knowledge.');
  card.appendChild(header);
  card.appendChild(detail);
  container.prepend(card);
}

// Trust Beam opt-in affordance (feature-flagged: trustBeam).
// ------------------------------------------------------------
// Given an already-created Verifiable Check Seal, renders a "Beam it" button that
// composes a self-contained shareable link (js/provenance/trust-beam.js's
// buildBeamUrl) carrying the whole seal in the URL FRAGMENT — never sent to any
// server — plus a copy-to-clipboard action. A recipient opens the link in any
// browser (verify-beam.html) and the seal is re-verified client-side with zero
// DataGlow install and nothing uploaded. When the flag is off, nothing renders.
// QR-image generation is a documented follow-up: no QR library is vendored yet,
// so the copyable link is the beam artifact for this batch.
function renderBeamAffordance(detail, seal) {
  if (!isEnabled('trustBeam')) return;
  const beamBtn = el('button', {
    class: 'btn btn-secondary',
    style: 'font-size:var(--text-xs); padding:2px 8px; align-self:flex-start; margin-top:6px;',
    'data-testid': 'trust-beam-create',
    onclick: async () => {
      try {
        // verify-beam.html sits at the app root alongside index.html; derive its
        // URL from the current location so a beam works from any deployment host.
        const baseUrl = new URL('verify-beam.html', window.location.href).href;
        const url = buildBeamUrl(seal, baseUrl);
        let field = detail.querySelector('[data-testid="trust-beam-link"]');
        if (!field) {
          field = el('input', {
            type: 'text',
            readonly: 'readonly',
            'data-testid': 'trust-beam-link',
            style: 'width:100%; margin-top:6px; font-family:var(--font-mono); font-size:var(--text-xs); '
              + 'padding:4px 6px; border:1px solid var(--color-border); border-radius:var(--radius-sm); '
              + 'background:var(--color-surface-2); color:var(--color-text);',
            onclick: (e) => e.target.select(),
          });
          detail.appendChild(field);
          const copyBtn = el('button', {
            class: 'btn btn-secondary',
            style: 'font-size:var(--text-xs); padding:2px 8px; align-self:flex-start; margin-top:6px;',
            'data-testid': 'trust-beam-copy',
            onclick: async () => {
              try { await navigator.clipboard.writeText(field.value); toast('Trust Beam link copied', 'success'); }
              catch { field.select(); toast('Select the link and copy it', 'info'); }
            },
          }, 'Copy link');
          detail.appendChild(copyBtn);
        }
        field.value = url;
        toast('Trust Beam link ready — share it to re-verify anywhere, no upload', 'success');
      } catch (e) {
        toast('Could not build a Trust Beam link: ' + e.message, 'error');
      }
    },
  }, 'Beam it');
  detail.appendChild(beamBtn);
}

// Polyglot Workbench (Batch A) — selected source dialect for the SQL tab. Kept
// in memory only (no persistence). Default 'duckdb' is a no-op passthrough, so
// with the multiDialectSql flag off this variable is never consulted and the SQL
// tab behaves exactly as before this PR.
let sqlDialect = 'duckdb';

async function runSqlQuery() {
  const rawSql = $('#sql-input').value.trim();
  if (!rawSql) return;
  // When the multi-dialect flag is on, transpile the user's source-dialect SQL
  // to DuckDB SQL before anything runs. When off (or dialect === 'duckdb') this
  // is a byte-for-byte no-op, so the rest of the flow is unchanged.
  const sql = isEnabled('multiDialectSql') ? translateDialectSql(rawSql, sqlDialect) : rawSql;
  await ensureDuckDB();
  const statusEl = $('#sql-status');
  const resultWrap = $('#sql-result-wrap');
  statusEl.textContent = 'Running…';
  resultWrap.innerHTML = '<div class="skeleton" style="height:200px; border-radius:var(--radius-md); margin-top:var(--space-3);"></div>';
  try {
    // Expand any @metric references against this dataset's shared registry so a
    // business term defined once resolves the same way here as on every other
    // surface. No @metric in the query → runs byte-identical to before.
    const { sql: execSql } = expandMetricReferences(sql, getActiveMetricsRegistry());
    const result = await engine.runQuery(execSql);
    state.lastQuery = sql;
    state.lastQueryResult = result;
    statusEl.textContent = `${result.rowCount.toLocaleString()} row(s) in ${result.elapsedMs.toFixed(0)}ms`;
    renderResultTable(resultWrap, result);
    $('#story-empty').style.display = 'none';
    // AI Readiness Gate (batch 2): an informational badge near the result that
    // composes the LAST real validation run for the active dataset into a single
    // agent-consumability verdict. It never re-runs validation, never blocks the
    // query, and shows an honest "not evaluated" state until validation has run.
    renderReadinessGateBadge(resultWrap);
    // Query Memory (batch 2): fingerprints this SQL run against the tables/
    // columns it touched and renders a "seen before?" badge. No-op when the
    // queryMemory flag is off. Never blocks or delays the query.
    recordAndRenderQueryMemory(
      resultWrap,
      { kind: QUERY_KINDS.SQL, text: sql, context: { tables: loadedTableNames(), columns: result.columns } },
      sql.slice(0, 80),
    );
    // Object Space (Polyglot Workbench, Batch B): passively register the loaded
    // DuckDB tables as SQL-origin objects in the shared registry so the live
    // cross-language strip stays in sync. Flag-gated — no-op when off.
    registerSqlObjects();
    // Glow Path (Batch C): a real SQL run raises the session proficiency signal.
    proficiencyTracker.recordAction('sql');
    // Glow Path (Batch A): refresh the next-action rail from the new state.
    // No-op when the glowPathRail flag is off.
    renderGlowPathRail();
    // The Glow (Batch 2): refresh the topbar orb verdict. No-op when glowOrb off.
    renderGlowOrbWidget();
    if (isEnabled('localAnalysisContract')) {
      // Runs after the result is already shown — the contract check never
      // gates or delays the query itself, only annotates the result with
      // flags for the analyst to read before trusting it.
      // The metric-definition check (4th finding class) runs only when the
      // semanticMetricsLayer flag is on AND at least one metric is defined —
      // otherwise no metrics option is passed and the Contract runs exactly its
      // original three checks (byte-for-byte unchanged).
      const contractOptions = isEnabled('semanticMetricsLayer')
        ? { metrics: getRegisteredMetrics() }
        : {};
      buildLiveSchemaForContract(sql).then(schema => {
        const report = runAnalysisContract(sql, schema, contractOptions);
        renderAnalysisContractCard(resultWrap, report);
        // Opt-in seal affordance (no-op unless verifiableCheckSeal is on). Never
        // seals automatically — it only renders a button the analyst may click.
        renderCheckSealAffordance(resultWrap, report, sql, result);
      }).catch(() => { /* contract check is best-effort; never break the SQL tab */ });
    }
  } catch (err) {
    statusEl.textContent = '';
    resultWrap.innerHTML = `<div class="card" data-testid="sql-error" style="padding:var(--space-4); border-color:var(--color-error);">${renderSqlErrorHtml(err)}</div>`;
  }
}

// Repaint the highlight overlay from the textarea's current value and keep its
// scroll position locked to the textarea so glyphs stay aligned while typing.
function syncSqlHighlight() {
  const input = $('#sql-input');
  const overlay = $('#sql-highlight');
  if (!input || !overlay) return;
  overlay.innerHTML = highlightSql(input.value);
  overlay.scrollTop = input.scrollTop;
  overlay.scrollLeft = input.scrollLeft;
}

function renderResultTable(container, result) {
  if (result.rows.length === 0) {
    container.innerHTML = '<div style="padding:var(--space-6); text-align:center; color:var(--color-text-muted); font-size:var(--text-sm);">Query returned no rows.</div>';
    return;
  }
  const head = `<thead><tr>${result.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${result.rows.slice(0, 500).map(r => `<tr>${result.columns.map(c => `<td>${escapeHtml(formatNumber(r[c]))}</td>`).join('')}</tr>`).join('')}</tbody>`;
  container.innerHTML = `<div class="result-table-wrap" style="margin-top:var(--space-3);"><table class="result-table">${head}${body}</table></div>`;
}

// AI Readiness Gate (batch 2) — SQL-tab badge presenter.
// Ships dark behind `aiReadinessGateBadge`. Purely informational: it composes
// the last real validation run (state.validationResults) for the active dataset
// via the pure computeReadinessGate() and renders the batch-2 badge into a host
// appended below the result. It NEVER re-runs validation and NEVER blocks the
// query — agent hard-blocking is batch 3 (js/agents/*), not wired here.
function renderReadinessGateBadge(resultWrap) {
  if (!resultWrap || !isEnabled('aiReadinessGateBadge')) return;
  let host = resultWrap.querySelector('#readiness-gate-host');
  if (!host) {
    host = el('div', { id: 'readiness-gate-host' });
    resultWrap.appendChild(host);
  }
  // Metric-contract status is not established in the SQL-query context yet, so it
  // is left undefined here (does not block) — Python/R/Metric Studio wiring and a
  // real per-query contract status are a documented batch-2 follow-up.
  const gateResult = computeReadinessGate(state.validationResults);
  renderReadinessBadge({ host, gateResult });
}

// ============================================================
// Glow Path rail (Batch A — adaptive next-action rail, ships dark)
// ============================================================
// A single honest "what should I do next?" suggestion rendered into
// #glow-path-host. ALL wiring below is gated behind the glowPathRail flag — with
// the flag off, renderGlowPathRail() returns immediately, the host stays empty,
// and behavior is byte-for-byte unchanged. The rail is purely a suggestion: it
// never blocks or delays anything for a human.
//
// It COMPOSES state DATAGLOW already has — it never re-runs validation. The
// readiness gate result it consults is a pure aggregation over the ALREADY-computed
// state.validationResults (the same cheap computeReadinessGate() the badge uses),
// not a fresh validation run. densityLevel comes from the session proficiency
// signal (Batch B/C): one shared in-memory tracker below, fed by real per-tab
// run events, classified into 'low'/'mid'/'high'. It is session-scoped only —
// never persisted (cross-session persistence is out of scope, see Batch B).
const glowPathDismissalStore = createGlowPathDismissalStore();

// One shared session proficiency tracker (Batch C). Fed by real per-tab run
// events (SQL/Python/R/Validate) and read by renderGlowPathRail() for density.
const proficiencyTracker = createProficiencyTracker();

// ============================================================
// Query Memory (batch 2 — UI wiring)
// ============================================================
// One shared log instance backed by the REAL IndexedDB store
// (js/learning/memory-store.js), mirroring memoryStore's own
// appendQueryMemory/getQueryMemory/getQueryMemoryByFingerprint contract exactly
// — createQueryMemoryLog never talks to storage directly, only through this
// injected adapter, same DI discipline as every other store-backed module here.
// Entirely gated by the `queryMemory` flag: every call site below is a no-op
// when the flag is off, so behavior is byte-for-byte unchanged in that state.
const queryMemoryLog = createQueryMemoryLog({
  store: {
    appendQueryMemory: (entries) => memoryStore.appendQueryMemory(entries),
    getQueryMemory: () => memoryStore.getQueryMemory(),
    getQueryMemoryByFingerprint: (fp) => memoryStore.getQueryMemoryByFingerprint(fp),
  },
});

// DataGlow has no login/author system; this single-user local app just labels
// every run 'you' rather than inventing an identity layer. Kept as one constant
// so a future multi-user surface only has to change this one spot.
const QUERY_MEMORY_AUTHOR = 'you';

// Currently-loaded dataset table names, used as the SQL run's `context.tables`.
// Mirrors the same state.datasets source registerRuntimeObjects() already reads
// — no new dataset-tracking concept introduced.
function loadedTableNames() {
  return (state.datasets || []).map(ds => ds.table).filter(Boolean);
}

// Record a run in Query Memory and render the "seen before?" badge into `host`.
// No-op (and never throws into the caller) when the flag is off or IndexedDB is
// unavailable — Query Memory is informational only and must never break a run.
async function recordAndRenderQueryMemory(host, run, label) {
  if (!host || !isEnabled('queryMemory')) return;
  try {
    await memoryStore.initMemoryStore();
    const { priorLookup } = await queryMemoryLog.record(run, QUERY_MEMORY_AUTHOR, { label });
    renderQueryMemoryBadge({ host, lookupResult: priorLookup });
  } catch (e) { /* Query Memory is best-effort; never break the run it sits beside */ }
}

// Count pass/warn/fail across the last validation run. Mirrors the gate's own
// tolerance: only entries carrying a string `status` are layers; aggregate keys
// the orchestrator mixes in (domainPack, calibratedGrades…) are skipped.
function summarizeValidationForGlowPath(results) {
  const summary = { pass: 0, warn: 0, fail: 0 };
  if (!results || typeof results !== 'object') return summary;
  for (const r of Object.values(results)) {
    if (!r || typeof r.status !== 'string') continue;
    if (r.status === 'pass') summary.pass++;
    else if (r.status === 'warn') summary.warn++;
    else if (r.status === 'fail') summary.fail++;
  }
  return summary;
}

// Assemble the pure decision ctx from real state, ask glow-path.js what to
// suggest, and present it. Per-dataset dismissal is honored in memory only.
function renderGlowPathRail() {
  const host = document.getElementById('glow-path-host');
  if (!host) return;
  if (!isEnabled('glowPathRail')) { host.innerHTML = ''; return; }

  const ds = getActiveDataset();
  const dismissKey = ds && ds.name ? ds.name : '__no-dataset__';
  if (glowPathDismissalStore.isDismissed(dismissKey)) { host.innerHTML = ''; return; }

  const hasValidated = Object.keys(state.validationResults || {}).length > 0;
  const ctx = {
    datasetLoaded: !!ds,
    datasetLoadedAt: ds ? ds.loadedAt : undefined,
    hasValidated,
    validationSummary: summarizeValidationForGlowPath(state.validationResults),
    // Reuse the pure gate aggregation over already-computed results (no re-run of
    // validation); only meaningful once validation has produced evidence.
    readinessGateResult: hasValidated ? computeReadinessGate(state.validationResults) : undefined,
    // densityLevel from the real session proficiency signal (Batch C); starts
    // 'low' and steps up to 'mid'/'high' as run events accrue. lastQueryRepeatCount
    // omitted (not derivable — queryHistory is not populated), so the save-query
    // nudge stays off.
    densityLevel: proficiencyTracker.getDensityLevel(),
  };

  renderGlowPath({
    host,
    glowPathState: computeGlowPathState(ctx),
    onCtaClick: onGlowPathCta,
    onDismiss: () => { glowPathDismissalStore.markDismissed(dismissKey); host.innerHTML = ''; },
  });
}

// ============================================================
// The Glow — topbar orb widget (Batch 2, ships dark)
// ============================================================
// Renders the single at-a-glance Glow orb into #glow-orb-host. Gated behind the
// glowOrb flag — with the flag off, renderGlowOrbWidget() empties the host and
// returns, so behavior is byte-for-byte unchanged. It COMPOSES the real
// already-computed state (the same cheap computeReadinessGate() over
// state.validationResults the badge/rail use, plus the same collectTrustSignals()
// the Trust Strip assembles) via the pure Batch-1 aggregator — it re-runs NO
// validation. goldenSignals/catScorecard are computed async inside renderDataHealth
// via the DuckDB engine and are NOT persisted to `state`, so they are left
// undefined here rather than re-run synchronously on every topbar refresh
// (wiring those two in is a documented Batch-2 follow-up).
function renderGlowOrbWidget() {
  const host = document.getElementById('glow-orb-host');
  if (!host) return;
  if (!isEnabled('glowOrb')) { host.innerHTML = ''; return; }

  const ds = getActiveDataset();
  const hasValidated = Object.keys(state.validationResults || {}).length > 0;
  const chain = ds ? provenance.getProvenance(ds.table) : null;
  const glowResult = computeGlowSignal({
    readinessGateResult: hasValidated ? computeReadinessGate(state.validationResults) : undefined,
    trustSignals: collectTrustSignals({
      dataset: ds,
      validationResults: state.validationResults,
      metricCounts: metricRegistry.statusCounts(),
      provenanceChain: chain,
      anomalyResult: null,
    }),
    // goldenSignals / catScorecard: async + not on state — see header note.
  });
  renderGlowOrb({ host, glowResult });
}

// ============================================================
// DataGlow Rooms (Batch 3 of 4): topbar Room pill + presence + live-update toasts
// ============================================================
// The thin UI surface for the Batch-1 signaling coordinator and Batch-2 broadcast
// coordinator. main.js owns the Room lifecycle here (start/leave, the coordinator
// objects, the cached peer list); js/rooms/room-ui.js only PRESENTS the state it
// is handed. Ships dark behind the `roomsUi` flag: with the flag off,
// renderRoomUiWidget() hides #room-ui-host, tears down any coordinator, and the
// topbar is byte-for-byte unchanged. No real signaling/data-channel adapter is
// injected yet (Batches 1 & 2 shipped only the pure modules + NULL no-op
// adapters), so a started Room stays local-only and no remote peers/entries
// arrive until a real adapter is wired — an honest, never-thrown dark state, not
// a broken feature. Everything below only ever runs once the flag is flipped on.
let roomSignaling = null;   // RoomSignalingCoordinator | null — non-null once a Room is open
let roomBroadcast = null;   // RoomBroadcastCoordinator | null — composes roomSignaling
let roomPeers = [];         // cached listPeers() result (the read-only presence list)

function renderRoomUiWidget() {
  const host = document.getElementById('room-ui-host');
  if (!host) return;
  if (!isEnabled('roomsUi')) {
    host.style.display = 'none';
    host.innerHTML = '';
    roomSignaling = null;
    roomBroadcast = null;
    roomPeers = [];
    return;
  }
  host.style.display = '';
  const supported = isRoomsSupported();
  const pillModel = buildRoomPillModel({
    roomCode: roomSignaling ? roomSignaling.roomCode : null,
    joined: !!roomSignaling, // a Room is "open" from the moment the human starts it
    supported,
  });
  const presenceModel = buildPresenceModel({
    peers: roomPeers,
    viewingSnapshot: roomBroadcast ? roomBroadcast.viewingSnapshot() : {},
  });
  renderRoomUi({
    host,
    pillModel,
    presenceModel,
    onStart: startRoom,
    onLeave: leaveRoom,
    onCopy: copyRoomCode,
  });
}

// Open a fresh Room: generate a shareable code, stand up the Batch-1 signaling
// coordinator (with its default NULL no-op adapter until a real one is injected)
// and the Batch-2 broadcast coordinator composed on top of it, wiring a remote
// Object Space entry to a live-update toast and a viewing change to a re-render.
// Best-effort: join() is attempted but never blocks the UI from showing the code.
async function startRoom() {
  try {
    const roomCode = generateRoomCode();
    const selfId = `peer-${Math.floor(Math.random() * 1e9)}`;
    // Batch 4: a real signaling adapter, bridging the same GitHub coordination-
    // branch pattern already proven in production by Federated Learning
    // (createGithubSignaling in federated-transport.js) but partitioned per
    // room code instead of one global phone book. No write token is
    // configured here (same as Federated Learning's own default) so presence
    // announces degrade to read-only best-effort — a Room still opens and
    // shows its code, peers just won't see each other until a token is wired
    // into a future settings surface. Never throws: any failure here falls
    // back to the RoomSignalingCoordinator's own NULL_ROOM_SIGNALING default.
    let signaling;
    try {
      signaling = createGithubRoomSignaling({ owner: 'Andre-Weissmann', repo: 'dataglow' });
    } catch (e) { signaling = undefined; }
    roomSignaling = new RoomSignalingCoordinator(signaling ? { roomCode, selfId, signaling } : { roomCode, selfId });
    let transport;
    try {
      transport = createRoomWebRTCTransport({ roomCode: roomSignaling.roomCode, selfId, signaling });
    } catch (e) { transport = undefined; }
    roomBroadcast = new RoomBroadcastCoordinator({
      room: roomSignaling,
      transport,
      onRemoteEntry: (entry, m) => notifyRemoteEntry({ entry, from: m && m.from, peers: roomPeers, toast }),
      onViewersChanged: () => renderRoomUiWidget(),
    });
    renderRoomUiWidget();
    try { await roomSignaling.join(); } catch (e) { /* unreachable signaling is a first-class state */ }
    await refreshRoomPeers();
  } catch (e) {
    // A Room failing to open must never break the topbar.
    roomSignaling = null;
    roomBroadcast = null;
    renderRoomUiWidget();
  }
}

// Leave the current Room (best-effort) and return the pill to its idle state.
async function leaveRoom() {
  const coord = roomSignaling;
  const broadcast = roomBroadcast;
  roomSignaling = null;
  roomBroadcast = null;
  roomPeers = [];
  renderRoomUiWidget();
  // Tear down any open peer connections before leaving so a left Room never
  // keeps a dangling RTCPeerConnection running in the background.
  try { broadcast && broadcast.transport && broadcast.transport.closeAll && broadcast.transport.closeAll(); } catch (e) { /* never throws */ }
  if (coord) { try { await coord.leave(); } catch (e) { /* never throws */ } }
}

// Copy the current room code to the clipboard so the human can share it.
function copyRoomCode(code) {
  const value = code || (roomSignaling ? roomSignaling.roomCode : null);
  if (!value) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(
        () => toast(`Room code ${value} copied`, 'success'),
        () => toast('Could not copy the room code', 'warn'),
      );
    }
  } catch (e) { /* clipboard unavailable — non-fatal */ }
}

// Refresh the cached presence list from the signaling coordinator and re-render.
// Never throws; unreachable signaling yields an empty peer list.
async function refreshRoomPeers() {
  if (!roomSignaling) { roomPeers = []; return; }
  try { roomPeers = await roomSignaling.listPeers(); } catch (e) { roomPeers = []; }
  renderRoomUiWidget();
}

// Map a symbolic Glow Path CTA action to a real, human-initiated navigation. Each
// action only ever moves the analyst toward the suggested step — it never runs an
// agent path or blocks anything.
function onGlowPathCta(action) {
  if (action === 'load-data') { const fi = $('#file-input'); if (fi) fi.click(); return; }
  if (action === 'run-validate') { switchTab('validate'); runValidation(); return; }
  if (action === 'review-warnings' || action === 'see-failing-layers') { switchTab('validate'); return; }
  // 'save-query'/'none' carry no live navigation in Batch A.
}

// ============================================================
// Object Space registry (Polyglot Workbench, Batch B)
// ============================================================
// A passive read model of the named objects live across the SQL/Python/R
// runtimes. All wiring below is gated behind the objectSpaceRegistry flag — with
// the flag off, nothing here registers anything or renders, so behavior is
// byte-for-byte unchanged. This batch does NOT resolve cross-language references
// at query time (no working `FROM py.name`); it only tracks + displays.

// The current runtime origins are the same loaded DuckDB tables copied into each
// language's bridge; we register them under an origin-qualified handle so the
// shared namespace shows a table's availability per runtime without one origin
// overwriting another. SQL is the canonical/home runtime, so it keeps the bare
// table name.
function objectSpaceName(originLanguage, table) {
  if (originLanguage === 'python') return `py:${table}`;
  if (originLanguage === 'r') return `r:${table}`;
  return table;
}

function registerRuntimeObjects(originLanguage) {
  if (!isEnabled('objectSpaceRegistry')) return;
  for (const ds of state.datasets) {
    registerObject({
      name: objectSpaceName(originLanguage, ds.table),
      originLanguage,
      kind: 'dataframe',
      schema: (ds.cols || []).map(c => ({ name: c.name, type: c.type })),
      rowCount: ds.rowCount,
      provenance: ds.table,
    });
  }
  renderObjectSpacePanel();
}

function registerSqlObjects() { registerRuntimeObjects('sql'); }

const ORIGIN_BADGE = { sql: 'SQL', python: 'Py', r: 'R' };

// Read-only strip in the data sidebar listing the live cross-language objects.
// Hidden entirely when the flag is off or nothing has registered yet.
function renderObjectSpacePanel() {
  const section = $('#object-space-section');
  const body = $('#object-space-list');
  if (!section || !body) return;
  if (!isEnabled('objectSpaceRegistry')) { section.style.display = 'none'; return; }
  const objects = listObjectSpace();
  section.style.display = '';
  if (!objects.length) {
    body.innerHTML = '<div style="font-size:var(--text-xs); color:var(--color-text-faint);">No cross-language objects yet</div>';
    return;
  }
  body.innerHTML = objects.map(o => {
    const badge = ORIGIN_BADGE[o.originLanguage] || o.originLanguage;
    const meta = o.kind === 'dataframe' && o.rowCount != null
      ? `${o.rowCount.toLocaleString()} rows`
      : escapeHtml(o.kind);
    return `<div class="mono" style="padding:4px 0; display:flex; gap:6px; align-items:baseline;">`
      + `<span class="badge" style="font-size:10px;">${escapeHtml(badge)}</span>`
      + `<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(o.name)}</span>`
      + `<span style="color:var(--color-text-faint);">(${meta})</span>`
      + `</div>`;
  }).join('');
}

// ---- Saved Metrics (shared metrics registry, SQL-tab surface) ----
// Render the active dataset's defined metrics with an explicit Insert action.
// Inserting is always a user click — nothing propagates a metric silently.
function renderSavedMetrics() {
  const listEl = $('#sql-metrics-list');
  if (!listEl) return;
  const registry = getActiveMetricsRegistry();
  const metrics = registry ? registry.listMetrics() : [];
  if (!registry) {
    listEl.innerHTML = '<div style="font-size:var(--text-xs); color:var(--color-text-faint);">Load a dataset to define metrics for it.</div>';
    return;
  }
  if (metrics.length === 0) {
    listEl.innerHTML = '<div style="font-size:var(--text-xs); color:var(--color-text-faint);">No metrics defined yet for this dataset.</div>';
    return;
  }
  listEl.innerHTML = '';
  for (const m of metrics) {
    const row = el('div', { class: 'card', style: 'display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) var(--space-3); margin-bottom:var(--space-2);' }, [
      el('div', { style: 'flex:1 1 auto; min-width:0;' }, [
        el('div', { style: 'font-weight:600;' }, [
          el('span', {}, m.name),
          m.unit ? el('span', { style: 'font-weight:400; color:var(--color-text-faint); margin-left:var(--space-2);' }, `(${m.unit})`) : '',
        ]),
        el('div', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;' }, m.sqlExpression),
        m.description ? el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint);' }, m.description) : '',
      ]),
      el('button', { class: 'btn btn-secondary', 'data-testid': `button-insert-metric-${m.name}`, onclick: () => insertMetricIntoEditor(m.name) }, 'Insert'),
    ]);
    listEl.appendChild(row);
  }
}

// Splice a metric's compiled SQL (aliased to its name) into the SQL editor at
// the caret. Explicit, user-initiated — this is the "adopt this metric" click.
function insertMetricIntoEditor(name) {
  const registry = getActiveMetricsRegistry();
  const input = $('#sql-input');
  if (!registry || !input) return;
  let fragment;
  try {
    fragment = registry.resolveMetricSql(name, { alias: true });
  } catch { return; }
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + fragment + input.value.slice(end);
  const caret = start + fragment.length;
  input.selectionStart = input.selectionEnd = caret;
  input.focus();
  syncSqlHighlight();
}

function defineMetricFromForm() {
  const statusEl = $('#metric-define-status');
  const registry = getActiveMetricsRegistry();
  if (!registry) {
    if (statusEl) statusEl.textContent = 'Load a dataset first — metrics are scoped to the active dataset.';
    return;
  }
  const name = $('#metric-name').value.trim();
  const sqlExpression = $('#metric-expr').value.trim();
  const unit = $('#metric-unit').value.trim() || null;
  const description = $('#metric-desc').value.trim() || null;
  try {
    // Overwrite when the name already exists: redefining is an explicit user act
    // (they re-typed the name), and the registry bumps the metric's version.
    const overwrite = registry.hasMetric(name);
    const m = registry.defineMetric({ name, sqlExpression, unit, description }, { overwrite });
    if (statusEl) statusEl.textContent = `Saved metric "${m.name}"${m.version > 1 ? ` (v${m.version})` : ''}. Reference it as @${m.name} in a query.`;
    $('#metric-name').value = '';
    $('#metric-expr').value = '';
    $('#metric-unit').value = '';
    $('#metric-desc').value = '';
    renderSavedMetrics();
  } catch (err) {
    if (statusEl) statusEl.textContent = err instanceof MetricError ? err.message : `Could not define metric: ${err.message}`;
  }
}

function initSqlTab() {
  $('#btn-sql-run').addEventListener('click', runSqlQuery);
  const defineBtn = $('#btn-save-metric');
  if (defineBtn) defineBtn.addEventListener('click', defineMetricFromForm);
  renderSavedMetrics();
  $('#btn-sql-format').addEventListener('click', () => {
    const el = $('#sql-input');
    el.value = el.value.replace(/\s+/g, ' ').replace(/\bSELECT\b/gi, '\nSELECT').replace(/\bFROM\b/gi, '\nFROM').replace(/\bWHERE\b/gi, '\nWHERE').replace(/\bGROUP BY\b/gi, '\nGROUP BY').replace(/\bORDER BY\b/gi, '\nORDER BY').trim();
    syncSqlHighlight();
    scheduleAmbientCheck();
  });
  const input = $('#sql-input');
  input.addEventListener('input', syncSqlHighlight);
  input.addEventListener('scroll', () => {
    const overlay = $('#sql-highlight');
    if (overlay) { overlay.scrollTop = input.scrollTop; overlay.scrollLeft = input.scrollLeft; }
  });
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runSqlQuery(); }
  });
  syncSqlHighlight();
  initAmbientValidation();
  initMetricDefiner();
  renderSqlDialectPicker();
}

// Polyglot Workbench (Batch A) — dialect-picker chip row for the SQL tab.
// Ships dark behind `multiDialectSql`. With the flag off the picker host stays
// hidden and empty and `sqlDialect` remains 'duckdb', so the SQL tab is
// byte-for-byte unchanged. With the flag on it renders one chip per
// SUPPORTED_DIALECTS entry; clicking one sets the source dialect that
// runSqlQuery() transpiles from before running. Reuses the existing `.chip`
// component so no bespoke control is introduced.
function renderSqlDialectPicker() {
  const host = $('#sql-dialect-picker');
  if (!host) return;
  if (!isEnabled('multiDialectSql')) {
    host.style.display = 'none';
    host.innerHTML = '';
    return;
  }
  host.style.display = 'flex';
  host.innerHTML = '';
  host.appendChild(el('span', { class: 'sql-dialect-label' }, 'Dialect'));
  for (const d of SUPPORTED_DIALECTS) {
    const chip = el('button', {
      type: 'button',
      class: `chip${d.id === sqlDialect ? ' active' : ''}`,
      title: d.description,
      'data-dialect': d.id,
      'data-testid': `sql-dialect-${d.id}`,
    }, d.label);
    chip.addEventListener('click', () => {
      sqlDialect = d.id;
      host.querySelectorAll('.chip').forEach((c) => {
        c.classList.toggle('active', c.getAttribute('data-dialect') === sqlDialect);
      });
    });
    host.appendChild(chip);
  }
}

// "Define a metric" affordance (semanticMetricsLayer flag, off by default).
// When the flag is off the trigger button stays hidden and the host stays
// empty, so the feature ships dark — the SQL tab is unchanged. When on, the
// button toggles a small human-authored metric-definition form.
function initMetricDefiner() {
  const btn = $('#btn-define-metric');
  const host = $('#metric-definer-wrap');
  if (!btn || !host) return;
  if (!shouldOfferMetricDefiner({ enabled: isEnabled('semanticMetricsLayer') })) {
    btn.style.display = 'none';
    host.innerHTML = '';
    return;
  }
  btn.style.display = '';
  btn.addEventListener('click', () => {
    if (host.childElementCount > 0) { host.innerHTML = ''; return; } // toggle off
    mountMetricDefiner({ host, onToast: toast });
  });
}

// ============================================================
// Ambient Validation (Feature 5) — live, incremental checks as you type,
// run in a Web Worker so the SQL editor never blocks.
// ============================================================
let ambientWorker = null;
let ambientReqId = 0;
// Warnings the user explicitly dismissed this session — keyed so an identical
// warning doesn't nag again until the query text changes it away and back.
const dismissedAmbient = new Set();

function ensureAmbientWorker() {
  if (ambientWorker) return ambientWorker;
  try {
    ambientWorker = new Worker(new URL('../ambient/ambient-validation.worker.js', import.meta.url), { type: 'module' });
    ambientWorker.onmessage = (e) => {
      const { requestId, warnings } = e.data || {};
      if (requestId !== ambientReqId) return; // stale result from an earlier keystroke
      renderAmbientWarnings(warnings || []);
    };
    ambientWorker.onerror = () => { /* never let a worker error break typing */ };
  } catch {
    ambientWorker = null; // Worker unsupported — feature silently unavailable
  }
  return ambientWorker;
}

function teardownAmbientWorker() {
  if (ambientWorker) { ambientWorker.terminate(); ambientWorker = null; }
}

const scheduleAmbientCheck = debounce(() => {
  const input = $('#sql-input');
  if (!input) return;
  const sql = input.value || '';
  const worker = ensureAmbientWorker();
  if (!worker) return;
  const ds = getActiveDataset();
  const columns = ds && Array.isArray(ds.cols) ? ds.cols.map(c => c.name) : [];
  ambientReqId += 1;
  worker.postMessage({ requestId: ambientReqId, sql, columns });
}, 800);

function renderAmbientWarnings(warnings) {
  const wrap = $('#ambient-warnings');
  if (!wrap) return;
  const visible = warnings.filter(w => !dismissedAmbient.has(ambientKey(w)));
  wrap.innerHTML = '';
  if (visible.length === 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  for (const w of visible) {
    const tone = w.severity === 'info' ? 'warn' : 'fail';
    const row = el('div', {
      class: `validation-status ${tone}`,
      'data-testid': `ambient-warning-${w.id}`,
      style: 'display:flex; align-items:flex-start; gap:var(--space-2); padding:var(--space-2) var(--space-3); border-radius:var(--radius-md); font-size:var(--text-xs);',
    }, [
      el('span', { class: `status-dot ${tone}`, style: 'margin-top:3px; flex:none;' }),
      el('span', { style: 'flex:1;' }, w.message),
    ]);
    const dismiss = el('button', {
      class: 'btn btn-secondary',
      style: 'font-size:var(--text-xs); padding:2px 8px; flex:none;',
      'data-testid': `ambient-dismiss-${w.id}`,
      onclick: () => { dismissedAmbient.add(ambientKey(w)); recordLearningSignal({ source: 'ambient', column: w.column }, 'dismiss'); renderAmbientWarnings(warnings); },
    }, 'Dismiss');
    row.appendChild(dismiss);
    wrap.appendChild(row);
  }
}

function ambientKey(w) {
  return `${w.id}|${w.column || ''}|${w.message}`;
}

function initAmbientValidation() {
  const input = $('#sql-input');
  if (!input) return;
  input.addEventListener('input', scheduleAmbientCheck);
  // No orphaned workers: tear the worker down when the page goes away.
  window.addEventListener('pagehide', teardownAmbientWorker);
  window.addEventListener('beforeunload', teardownAmbientWorker);
}

// ============================================================
// On-Device SLM Interpreter (Feature 4) — opt-in, in-browser LLM synthesis
// of the validation findings. No data ever leaves the browser.
// ============================================================
function initAISynthesis() {
  const downloadBtn = $('#btn-slm-download');
  const synthBtn = $('#btn-slm-synthesize');
  const statusEl = $('#slm-status');
  const progressWrap = $('#slm-progress-wrap');
  const progressBar = $('#slm-progress-bar');
  const outputEl = $('#slm-output');
  if (!downloadBtn) return;

  if (!ondeviceLLM.isWebGPUAvailable()) {
    downloadBtn.disabled = true;
    statusEl.innerHTML = 'This feature needs a <strong>WebGPU-capable browser</strong> (recent Chrome, Edge, or Chrome on Android; Safari 18+). On-device AI synthesis is unavailable here — every other DATAGLOW feature works as normal.';
    statusEl.setAttribute('data-slm-state', 'no-webgpu');
    return;
  }
  statusEl.textContent = `Ready to download ${ondeviceLLM.MODEL_LABEL}. Runs entirely on your device; nothing is uploaded.`;

  downloadBtn.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    progressWrap.style.display = '';
    statusEl.setAttribute('data-slm-state', 'loading');
    try {
      await ondeviceLLM.loadModel(({ progress, text }) => {
        progressBar.style.width = `${Math.round((progress || 0) * 100)}%`;
        statusEl.textContent = text || `Downloading model… ${Math.round((progress || 0) * 100)}%`;
      });
      progressWrap.style.display = 'none';
      statusEl.textContent = 'Model loaded — running fully offline on your device.';
      statusEl.setAttribute('data-slm-state', 'ready');
      downloadBtn.style.display = 'none';
      synthBtn.style.display = '';
    } catch (err) {
      progressWrap.style.display = 'none';
      downloadBtn.disabled = false;
      statusEl.setAttribute('data-slm-state', err.code === 'NO_WEBGPU' ? 'no-webgpu' : 'error');
      statusEl.textContent = err.message || 'Model failed to load.';
    }
  });

  synthBtn.addEventListener('click', async () => {
    const results = window.__dataglowLastValidation;
    if (!results) { toast('Run the validation suite first', 'error'); return; }
    synthBtn.disabled = true;
    const original = synthBtn.textContent;
    synthBtn.textContent = 'Synthesizing…';
    outputEl.style.display = '';
    outputEl.textContent = '';
    try {
      const context = {
        ledgerEntries: ledger.getLedgerEntries(),
        layerResults: results,
        physicsOutput: window.__dataglowPhysicsOutput || null,
      };
      await ondeviceLLM.synthesizeFindings(context, (partial) => {
        outputEl.textContent = partial;
      });
    } catch (err) {
      outputEl.textContent = 'Synthesis failed: ' + (err.message || err);
    } finally {
      synthBtn.disabled = false;
      synthBtn.textContent = original;
    }
  });
}

// ============================================================
// Python Tab
// ============================================================
let pythonInitStarted = false;
function ensurePythonRuntime() {
  if (pythonInitStarted) return;
  pythonInitStarted = true;
  const statusBadge = $('#py-status');
  pyRuntime.initPyodideRuntime((status) => {
    if (status === 'ready') {
      statusBadge.textContent = 'Ready';
      statusBadge.className = 'badge badge-a';
      $('#btn-py-run').disabled = false;
    } else {
      statusBadge.textContent = status;
    }
  }).catch(err => { statusBadge.textContent = 'Failed to load'; statusBadge.className = 'badge badge-d'; toast('Python runtime failed to load: ' + err.message, 'error'); });
}

function initPythonTab() {
  $('#btn-py-run').addEventListener('click', async () => {
    const code = $('#py-input').value;
    const outWrap = $('#py-output-wrap');
    outWrap.innerHTML = '<div class="skeleton" style="height:100px; border-radius:var(--radius-md); margin-top:var(--space-3);"></div>';
    try {
      const { stdout, result, error, truncated, images } = await pyRuntime.runPython(code, getActiveDataset()?.table);
      // Object Space (Batch B): the datasets pushed into the pandas bridge are
      // now live Python objects — register them (flag-gated, no-op when off).
      registerRuntimeObjects('python');
      // Glow Path (Batch C): a real Python run raises the session proficiency signal.
      proficiencyTracker.recordAction('python');
      let html = '';
      if (truncated && truncated.length) {
        const items = truncated
          .map(t => `<strong>${escapeHtml(t.name)}</strong> (${t.rowCount.toLocaleString()} rows → ${t.limit.toLocaleString()})`)
          .join(', ');
        html += `<div class="py-truncation-warning" data-testid="py-truncation-warning" role="alert" style="margin-top:var(--space-3); padding:var(--space-3); border:1px solid var(--color-warn, #C9A227); border-radius:var(--radius-md); background:rgba(201,162,39,0.08); display:flex; gap:var(--space-2); align-items:flex-start;">`
          + `<span style="flex:1; font-size:var(--text-sm);">⚠️ Python sees a <strong>truncated</strong> view of your data: ${items} row(s). `
          + `Only the first ${truncated[0].limit.toLocaleString()} rows of each large table are passed to Python to keep the tab responsive. `
          + `SQL, Clean and Validate still operate on the full dataset.</span>`
          + `<button type="button" class="btn btn-ghost" data-testid="py-truncation-dismiss" style="padding:2px 8px; font-size:var(--text-xs);" onclick="this.parentElement.remove()">Dismiss</button>`
          + `</div>`;
      }
      html += '<div class="console-log" style="margin-top:var(--space-3);">';
      if (stdout) html += escapeHtml(stdout);
      if (result) html += (stdout ? '\n' : '') + `<span class="ok">${escapeHtml(result)}</span>`;
      if (error) html += `<span class="err">${escapeHtml(error)}</span>`;
      if (!stdout && !result && !error) html += '<span style="color:var(--color-text-faint);">(no output)</span>';
      html += '</div>';
      for (const src of pyRuntime.extractImageDataUrls(images)) {
        html += `<img class="runtime-chart" alt="Python chart output" src="${escapeHtml(src)}" />`;
      }
      html += '<div id="py-query-memory-host"></div>';
      outWrap.innerHTML = html;
      // Query Memory (batch 2): no-op when the queryMemory flag is off.
      recordAndRenderQueryMemory(
        $('#py-query-memory-host'),
        { kind: QUERY_KINDS.PYTHON, text: code, context: { tables: loadedTableNames() } },
        code.slice(0, 80),
      );
    } catch (err) {
      outWrap.innerHTML = `<div class="console-log" style="margin-top:var(--space-3);"><span class="err">${escapeHtml(err.message)}</span></div>`;
    }
  });
  $('#py-input').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !$('#btn-py-run').disabled) { e.preventDefault(); $('#btn-py-run').click(); }
  });
}

// ============================================================
// R Tab
// ============================================================
let rInitStarted = false;
function ensureRRuntime() {
  if (rInitStarted) return;
  rInitStarted = true;
  const statusBadge = $('#r-status');
  rRuntime.initWebRRuntime((status) => {
    if (status === 'ready') {
      statusBadge.textContent = 'Ready';
      statusBadge.className = 'badge badge-a';
      $('#btn-r-run').disabled = false;
    } else {
      statusBadge.textContent = status;
    }
  }).catch(err => { statusBadge.textContent = 'Failed to load'; statusBadge.className = 'badge badge-d'; toast('R runtime failed to load: ' + err.message, 'error'); });
}

function initRTab() {
  $('#btn-r-run').addEventListener('click', async () => {
    const code = $('#r-input').value;
    const outWrap = $('#r-output-wrap');
    outWrap.innerHTML = '<div class="skeleton" style="height:100px; border-radius:var(--radius-md); margin-top:var(--space-3);"></div>';
    try {
      const { stdout, error, images, graphicsAvailable, hasJsonlite } = await rRuntime.runR(code);
      // Object Space (Batch B): the datasets bridged into R are now live R
      // data.frames — register them (flag-gated, no-op when off).
      registerRuntimeObjects('r');
      // Glow Path (Batch C): a real R run raises the session proficiency signal.
      proficiencyTracker.recordAction('r');
      let html = '';
      for (const notice of rRuntime.buildRBridgeNotices({ graphicsAvailable, hasJsonlite })) {
        html += `<div class="runtime-notice" role="note" style="margin-top:var(--space-3); padding:var(--space-2) var(--space-3); border:1px solid var(--color-warn, #C9A227); border-radius:var(--radius-md); background:rgba(201,162,39,0.08); font-size:var(--text-sm);">${escapeHtml(notice)}</div>`;
      }
      html += '<div class="console-log" style="margin-top:var(--space-3);">';
      html += stdout ? escapeHtml(stdout) : '<span style="color:var(--color-text-faint);">(no output)</span>';
      if (error) html += `\n<span class="err">${escapeHtml(error)}</span>`;
      html += '</div>';
      for (const src of rRuntime.extractImageDataUrls(images)) {
        html += `<img class="runtime-chart" alt="R chart output" src="${escapeHtml(src)}" />`;
      }
      html += '<div id="r-query-memory-host"></div>';
      outWrap.innerHTML = html;
      // Query Memory (batch 2): no-op when the queryMemory flag is off.
      recordAndRenderQueryMemory(
        $('#r-query-memory-host'),
        { kind: QUERY_KINDS.R, text: code, context: { tables: loadedTableNames() } },
        code.slice(0, 80),
      );
    } catch (err) {
      outWrap.innerHTML = `<div class="console-log" style="margin-top:var(--space-3);"><span class="err">${escapeHtml(err.message)}</span></div>`;
    }
  });
}

// ============================================================
// Clean Tab
// ============================================================

// Agent Action Firewall (agentActionFirewall flag) — map a Clean-tab fix to the
// firewall's action taxonomy so a confirmed fix is classified/recorded honestly.
const FIREWALL_FIX_KIND = {
  drop_rows: 'delete-rows',
  dedupe: 'dedupe',
  fill_zero: 'impute',
  fill_mean: 'impute',
  fill_mode: 'impute',
  trim: 'transform-column',
  abs_value: 'transform-column',
  null_out: 'update-values',
};

// The authenticated LOCAL human identity captured at confirm time (the firewall
// audit rider). Minimal + local-first: a locally-set analyst display name if the
// person set one, plus a per-tab session id — never a network account, never
// uploaded. Falls back to the session id alone so a confirmation always carries
// at least one real local identifier.
let _dataglowSessionId = null;
function getLocalHumanIdentity() {
  if (!_dataglowSessionId) {
    _dataglowSessionId = `session-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
  let displayName = null;
  try { displayName = localStorage.getItem('dataglow-analyst-name'); } catch { /* storage may be unavailable */ }
  return { displayName: displayName || null, sessionId: _dataglowSessionId, source: 'local-device' };
}

async function scanClean() {
  const ds = getActiveDataset();
  if (!ds) { toast('Load a dataset first', 'error'); return; }
  $('#clean-empty').style.display = 'none';
  const resultsEl = $('#clean-results');
  resultsEl.style.display = '';
  resultsEl.innerHTML = '<div class="skeleton" style="height:160px; border-radius:var(--radius-lg);"></div>';

  const issues = await clean.scanForIssues(ds.table, ds.cols);
  const auditLog = [];
  window.__dataglowAuditLog = auditLog;

  if (issues.length === 0) {
    resultsEl.innerHTML = '<div class="card" style="padding:var(--space-6); text-align:center;"><div style="font-size:var(--text-lg); font-weight:600; color:var(--color-grade-a); margin-bottom:4px;">No issues found</div><div style="color:var(--color-text-muted); font-size:var(--text-sm);">This dataset looks clean.</div></div>';
    return;
  }

  resultsEl.innerHTML = '';
  const grid = el('div', { class: 'validation-grid' });
  for (const issue of issues) {
    const card = el('div', { class: 'card validation-card' });
    card.appendChild(el('div', { class: 'validation-card-head' }, [
      el('span', { class: 'validation-card-name' }, issue.label),
    ]));
    const fixRow = el('div', { style: 'display:flex; gap:var(--space-2); flex-wrap:wrap; margin-top:var(--space-2); align-items:center;' });
    for (const fixType of issue.fixes) {
      const conf = fixConfidence.scoreFixConfidence(issue, fixType);
      const confColor = conf.score >= 75 ? 'var(--color-grade-a)' : conf.score >= 50 ? 'var(--color-grade-c)' : 'var(--color-grade-d)';
      const wrap = el('div', { style: 'display:flex; flex-direction:column; gap:2px;' });
      const btn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:6px 10px;', 'data-testid': `button-fix-${issue.id}-${fixType}` }, clean.FIX_LABELS[fixType]);
      btn.appendChild(el('span', { style: `margin-left:6px; font-size:10px; padding:1px 5px; border-radius:8px; background:${confColor}; color:#fff;`, title: conf.label }, `${conf.score}`));
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        // The apply + audit-write path, shared by both branches so the on/off
        // flag paths stay behaviour-identical apart from the gate itself.
        const applyAndRecord = async (identity) => {
          await clean.applyFix(ds.table, issue, fixType, auditLog);
          // The identity rider: when the firewall gated this mutation, the human
          // authorizer is folded into BOTH audit trails — the assumption ledger
          // line and the hash-chained provenance step description — so the record
          // names who authorized it, not just that it happened.
          const who = identity ? ` [authorized by ${identity.label}]` : '';
          ledger.logAssumption('Data Cleaning', `${clean.FIX_LABELS[fixType]} — ${issue.label}.${who}`);
          await provenance.recordStep(ds.table, 'clean', `${clean.FIX_LABELS[fixType]} — ${issue.label}.${who}`,
            dataBlame.buildBlameDetail({ rule: fixType, column: issue.column, affectedCount: issue.count }));
        };
        try {
          if (isEnabled('agentActionFirewall')) {
            // A human just clicked this specific fix button: that click IS the
            // per-action confirmation. Route it through the central gate, which
            // fails closed without a valid confirmation + local identity and
            // records who authorized the mutation into the chain of custody.
            await firewall.guardMutation(
              {
                kind: FIREWALL_FIX_KIND[fixType] || fixType,
                table: ds.table,
                column: issue.column,
                description: `${clean.FIX_LABELS[fixType]} — ${issue.label}.`,
                affectedCount: issue.count,
              },
              { confirmed: true, identity: getLocalHumanIdentity() },
              () => applyAndRecord(firewall.normalizeIdentity(getLocalHumanIdentity())),
            );
          } else {
            await applyAndRecord(null);
          }
        } catch (err) {
          btn.disabled = false;
          toast(err && err.blockedByFirewall ? `Blocked: ${err.message}` : `Fix failed: ${err.message}`, 'error');
          return;
        }
        renderAuditLog(auditLog);
        renderProvenanceTrail();
        toast(`Applied: ${clean.FIX_LABELS[fixType]}`, 'success');
        card.style.opacity = '0.4';
        card.style.pointerEvents = 'none';
        ds.rowCount = await engine.getRowCount(ds.table);
        renderSidebar();
      });
      wrap.appendChild(btn);
      wrap.appendChild(el('span', { style: `font-size:10px; color:${confColor};` }, conf.label));
      fixRow.appendChild(wrap);
    }
    card.appendChild(fixRow);
    grid.appendChild(card);
  }
  resultsEl.appendChild(grid);
  $('#clean-audit-wrap').style.display = '';
  renderAuditLog(auditLog);
  await renderFormatIssues(ds, auditLog);
  await renderActiveLearning(ds);
  await renderMissingness(ds, auditLog);
  await renderFuzzyDedup(ds, auditLog);
}

// Active-learning: highlight the most uncertain imputation targets first.
async function renderActiveLearning(ds) {
  const ranked = await activeLearning.rankUncertainCells(ds.table, ds.cols, engine).catch(() => []);
  if (!ranked.length) return;
  const note = el('div', { class: 'card', style: 'padding:var(--space-3); margin-top:var(--space-4);' }, [
    el('div', { class: 'sidebar-heading', style: 'margin-bottom:var(--space-2);' }, 'Review First — Most Uncertain Fills (active learning)'),
    el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-bottom:var(--space-2);' }, 'Uncertainty sampling (Settles 2009) — columns whose fill value is least reliable are listed first.'),
  ]);
  ranked.slice(0, 8).forEach((r, i) => {
    const pct = Math.round(r.uncertaintyScore * 100);
    const color = pct >= 66 ? 'var(--color-grade-d)' : pct >= 33 ? 'var(--color-grade-c)' : 'var(--color-grade-a)';
    note.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); padding:4px 0; font-size:var(--text-sm); border-top:1px solid var(--color-divider);' }, [
      el('span', { style: `font-size:10px; padding:1px 6px; border-radius:8px; background:${color}; color:#fff;` }, `${pct}%`),
      el('span', {}, r.reason),
    ]));
  });
  $('#clean-results').appendChild(note);
}

// Missingness Detective + Grouped Imputation Wizard.
async function renderMissingness(ds, auditLog) {
  const wrap = $('#missingness-wrap');
  const list = $('#missingness-list');
  const results = await missingness.analyzeMissingness(ds.table, ds.cols).catch(() => []);
  if (!results.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';
  const grid = el('div', { class: 'validation-grid' });
  const catCols = ds.cols.filter(c => c.type === 'VARCHAR').map(c => c.name);
  for (const m of results) {
    const card = el('div', { class: 'card validation-card', 'data-testid': `card-missingness-${m.column}` });
    card.appendChild(el('div', { class: 'validation-card-head' }, [
      el('span', { class: 'validation-card-name' }, `"${m.column}"`),
      el('span', { class: `validation-status ${m.likelyMCAR ? 'pass' : 'warn'}` }, [el('span', { class: `status-dot ${m.likelyMCAR ? 'pass' : 'warn'}` }), m.likelyMCAR ? 'MCAR' : 'MAR/MNAR']),
    ]));
    card.appendChild(el('div', { class: 'validation-card-desc' }, m.narrative));
    // Offer the imputation wizard for numeric columns (always available on request).
    if (m.isNumeric && catCols.length) {
      const wizWrap = el('div', { style: 'margin-top:var(--space-2);' });
      const label = el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:4px;' }, 'Grouped Imputation Wizard — group by:');
      const sel = el('select', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:4px 8px;' },
        catCols.map(c => el('option', { value: c }, c)));
      const genBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:6px 10px; margin-left:var(--space-2);', 'data-testid': `button-impute-preview-${m.column}` }, 'Preview Imputation');
      const out = el('div', { style: 'margin-top:var(--space-2);' });
      genBtn.addEventListener('click', async () => {
        genBtn.disabled = true;
        try {
          const preview = await imputation.previewGroupedImputation(ds.table, m.column, [sel.value]);
          out.innerHTML = '';
          out.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:4px;' },
            `Would fill ${preview.wouldFill} of ${preview.nullCount} null(s); ${preview.remainingNulls} remain unfilled.`));
          out.appendChild(el('pre', { class: 'mono', style: 'font-size:var(--text-xs); background:var(--color-surface-offset); padding:var(--space-2); border-radius:var(--radius-sm); overflow-x:auto; white-space:pre-wrap;' }, preview.sql));
          const btnRow = el('div', { style: 'display:flex; gap:var(--space-2); margin-top:var(--space-2);' });
          const copyBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:6px 10px;' }, 'Copy SQL');
          copyBtn.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(preview.sql); toast('SQL copied', 'success'); }
            catch (e) { toast('Copy failed: ' + e.message, 'error'); }
          });
          btnRow.appendChild(copyBtn);
          out.appendChild(btnRow);
          out.appendChild(el('div', { style: 'font-size:10px; color:var(--color-text-faint); margin-top:4px;' }, 'Preview only — nothing is written to your data. Copy the SQL to apply it yourself.'));
        } catch (e) {
          out.innerHTML = '';
          out.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-error);' }, 'Preview failed: ' + e.message));
        } finally {
          genBtn.disabled = false;
        }
      });
      wizWrap.appendChild(label);
      const ctrlRow = el('div', { style: 'display:flex; align-items:center; flex-wrap:wrap;' }, [sel, genBtn]);
      wizWrap.appendChild(ctrlRow);
      wizWrap.appendChild(out);
      card.appendChild(wizWrap);
    }
    grid.appendChild(card);
  }
  list.appendChild(grid);
}

// Fuzzy Duplicate Radar — Merge / Ignore per candidate pair.
async function renderFuzzyDedup(ds, auditLog) {
  const wrap = $('#fuzzy-dedup-wrap');
  const list = $('#fuzzy-dedup-list');
  const res = await fuzzyDedup.findFuzzyDuplicates(ds.table, ds.cols).catch(() => null);
  if (!res || !res.pairs || !res.pairs.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';
  if (res.warning) {
    list.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-bottom:var(--space-2);' }, res.warning));
  }
  for (const pair of res.pairs.slice(0, 50)) {
    const row = el('div', { class: 'card', style: 'padding:var(--space-3); margin-bottom:var(--space-2); display:flex; align-items:center; gap:var(--space-3); flex-wrap:wrap;', 'data-testid': `pair-fuzzy-${pair.rowA}-${pair.rowB}` });
    row.appendChild(el('span', { style: 'font-size:11px; padding:1px 6px; border-radius:8px; background:var(--color-grade-c); color:#fff;' }, `${(pair.similarity * 100).toFixed(0)}%`));
    row.appendChild(el('span', { class: 'mono', style: 'font-size:var(--text-sm);' }, `"${pair.valueA}"`));
    row.appendChild(el('span', { style: 'color:var(--color-text-faint);' }, '≈'));
    row.appendChild(el('span', { class: 'mono', style: 'font-size:var(--text-sm);' }, `"${pair.valueB}"`));
    const mergeBtn = el('button', { class: 'btn btn-primary', style: 'font-size:var(--text-xs); padding:6px 10px; margin-left:auto;', 'data-testid': `button-merge-${pair.rowA}-${pair.rowB}` }, 'Merge →');
    const ignoreBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:6px 10px;' }, 'Ignore');
    mergeBtn.addEventListener('click', async () => {
      mergeBtn.disabled = true; ignoreBtn.disabled = true;
      try {
        const col = `"${pair.column}"`;
        const from = String(pair.valueB).replace(/'/g, "''");
        const to = String(pair.valueA).replace(/'/g, "''");
        await engine.runQuery(`UPDATE ${ds.table} SET ${col} = '${to}' WHERE ${col} = '${from}'`);
        auditLog.push(`[${new Date().toLocaleTimeString()}] Merged "${pair.valueB}" → "${pair.valueA}" in "${pair.column}".`);
        ledger.logAssumption('Fuzzy Duplicate Radar', `Merged "${pair.valueB}" → "${pair.valueA}" in "${pair.column}".`);
        await provenance.recordStep(ds.table, 'merge', `Merged "${pair.valueB}" → "${pair.valueA}" in "${pair.column}".`,
          dataBlame.buildBlameDetail({ rule: 'merge', column: pair.column, before: pair.valueB, after: pair.valueA }));
        renderAuditLog(auditLog);
        renderProvenanceTrail();
        // Record as a manual correction; may trigger a reusable-rule suggestion.
        ruleSuggestions.recordCorrection(pair.valueB, pair.valueA, pair.column);
        await recordLearningSignal({ source: 'fuzzy_dedup', column: pair.column, categorical: true, severity: pair.similarity }, 'accept');
        await maybeShowRuleSuggestion(ds);
        row.style.opacity = '0.4'; row.style.pointerEvents = 'none';
        toast('Merged', 'success');
      } catch (e) {
        mergeBtn.disabled = false; ignoreBtn.disabled = false;
        toast('Merge failed: ' + e.message, 'error');
      }
    });
    ignoreBtn.addEventListener('click', () => {
      recordLearningSignal({ source: 'fuzzy_dedup', column: pair.column, categorical: true, severity: pair.similarity }, 'dismiss');
      row.style.opacity = '0.4'; row.style.pointerEvents = 'none';
    });
    row.appendChild(mergeBtn);
    row.appendChild(ignoreBtn);
    list.appendChild(row);
  }
}

// Rule-suggestion banner: appears only after 2+ identical manual corrections.
// The Approve button is the ONLY path that persists a rule.
async function maybeShowRuleSuggestion(ds) {
  const banner = $('#rule-suggestion-banner');
  const suggestions = ruleSuggestions.getSuggestedRules(2);
  if (!suggestions.length) { banner.style.display = 'none'; return; }
  const s = suggestions[0];
  banner.style.display = '';
  banner.innerHTML = '';
  const card = el('div', { class: 'card', style: 'padding:var(--space-3); border-color:var(--color-grade-b);' }, [
    el('div', { style: 'font-weight:600; margin-bottom:4px;' }, 'Reusable rule suggestion'),
    el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-bottom:var(--space-2);' },
      `You corrected "${s.originalValue}" → "${s.correctedValue}" in "${s.column}" ${s.occurrences} times. Save this as a reusable rule?`),
  ]);
  const approveBtn = el('button', { class: 'btn btn-primary', style: 'font-size:var(--text-xs); padding:6px 10px; margin-right:var(--space-2);', 'data-testid': 'button-approve-rule' }, 'Approve & Save Rule');
  const dismissBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:6px 10px;' }, 'Dismiss');
  approveBtn.addEventListener('click', async () => {
    const name = prompt('Name this rule:', `${s.column}: ${s.originalValue}→${s.correctedValue}`);
    if (!name) return; // no name → no persistence (human approval gate)
    try {
      await ruleSuggestions.approveRule(s, name);
      toast('Rule approved and saved to local memory', 'success');
      banner.style.display = 'none';
      await refreshMemoryPanel();
    } catch (e) {
      toast('Could not save rule: ' + e.message, 'error');
    }
  });
  dismissBtn.addEventListener('click', () => { banner.style.display = 'none'; });
  card.appendChild(approveBtn);
  card.appendChild(dismissBtn);
  banner.appendChild(card);
}

async function renderFormatIssues(ds, auditLog) {
  const wrap = $('#format-issues-wrap');
  const list = $('#format-issues-list');
  const issues = await formatFingerprint.scanFormatIssues(ds.table, ds.cols).catch(() => []);
  if (!issues.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  list.innerHTML = '';
  const grid = el('div', { class: 'validation-grid' });
  for (const issue of issues) {
    const card = el('div', { class: 'card validation-card', 'data-testid': `card-format-${issue.column}-${issue.issueType}` });
    card.appendChild(el('div', { class: 'validation-card-head' }, [
      el('span', { class: 'validation-card-name' }, `"${issue.column}" — ${issue.issueType.replace(/_/g, ' ')}`),
    ]));
    card.appendChild(el('div', { class: 'validation-card-desc' }, issue.detail));
    card.appendChild(el('pre', { class: 'mono', style: 'font-size:var(--text-xs); background:var(--color-surface-offset); padding:var(--space-2); border-radius:var(--radius-sm); overflow-x:auto; margin-top:var(--space-2); white-space:pre-wrap;' }, issue.suggestedFixSQL));
    const btnRow = el('div', { style: 'display:flex; gap:var(--space-2); flex-wrap:wrap; margin-top:var(--space-2);' });
    const copyBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:6px 10px;' }, 'Copy SQL');
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(issue.suggestedFixSQL); toast('SQL copied to clipboard', 'success'); }
      catch (e) { toast('Copy failed: ' + e.message, 'error'); }
    });
    const applyBtn = el('button', { class: 'btn btn-primary', style: 'font-size:var(--text-xs); padding:6px 10px;', 'data-testid': `button-format-apply-${issue.column}-${issue.issueType}` }, 'Apply');
    applyBtn.addEventListener('click', async () => {
      applyBtn.disabled = true;
      try {
        for (const stmt of issue.suggestedFixSQL.split(';')) {
          const s = stmt.replace(/--.*$/gm, '').trim();
          if (s) await engine.runQuery(s);
        }
        auditLog.push(`[${new Date().toLocaleTimeString()}] Applied format fix on "${issue.column}" (${issue.issueType}).`);
        renderAuditLog(auditLog);
        toast(`Applied format fix on "${issue.column}"`, 'success');
        card.style.opacity = '0.4';
        card.style.pointerEvents = 'none';
      } catch (e) {
        applyBtn.disabled = false;
        toast('Apply failed: ' + e.message, 'error');
      }
    });
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(applyBtn);
    card.appendChild(btnRow);
    grid.appendChild(card);
  }
  list.appendChild(grid);
}

function renderAuditLog(auditLog) {
  const logEl = $('#clean-audit-log');
  logEl.innerHTML = auditLog.length ? auditLog.map(l => `<div>${escapeHtml(l)}</div>`).join('') : '<span style="color:var(--color-text-faint);">No fixes applied yet.</span>';
  logEl.scrollTop = logEl.scrollHeight;
}

// ============================================================
// Validate Tab (20 layers)
// ============================================================
function statusIcon(status) {
  const icons = { pass: '✓', fail: '✕', warn: '!', idle: '—' };
  return icons[status] || '—';
}

async function runValidation() {
  const ds = getActiveDataset();
  if (!ds) { toast('Load a dataset first', 'error'); return; }
  $('#validate-empty').style.display = 'none';
  const grid = $('#validation-grid');
  grid.style.display = '';
  grid.innerHTML = validation.LAYER_DEFS.map(() => '<div class="skeleton" style="height:110px; border-radius:var(--radius-lg);"></div>').join('');

  const packSel = $('#domain-pack-select');
  const pack = packSel && packSel.value ? packSel.value : 'healthcare';
  // Cross-session fingerprint drift is opt-in: only hand the IndexedDB store to
  // the drift layer when the user has enabled persistence. Off by default.
  const fingerprintStore = state.settings.persistFingerprints ? memoryStore : null;
  const results = await validation.runAllLayers(ds, { freshnessThresholdHours: state.settings.freshnessThresholdHours, pack, fingerprintStore });
  recordLayerFires(results);
  // Validate Focus Mode: a completed run earns the Advanced options open for
  // this dataset going forward this session (no-op while the flag is off).
  if (ds.name) validateFocusStore.markRunOnce(ds.name);
  applyValidateFocusMode();
  // Unified Signal Layer: publish the ranker's learned per-column verdicts into
  // the shared store BEFORE any flag/badge renders, so the drift alerter (in the
  // grid below) and the anomaly scorer can read them and coordinate.
  publishRankerVerdicts(ds.cols);
  renderValidationResults(results);
  // Surface the active domain pack's medical disclaimer (OMOP/FHIR packs) so it
  // appears wherever their findings are shown; hidden for packs without one.
  const discEl = $('#domain-pack-disclaimer');
  if (discEl) {
    const disc = results.domainPack && results.domainPack.disclaimer;
    discEl.textContent = disc || '';
    discEl.style.display = disc ? '' : 'none';
  }
  window.__dataglowLastValidation = results;
  await renderTopProblems(ds, results);
  await renderDataHealth(ds, results);
  await renderMultivariate(ds);
  await renderPredictiveAnomaly(ds);
  await renderSPC(ds);
  await persistColumnProfiles(ds, results);
  renderAssumptionLedger();
  renderProvenanceTrail();
  await renderConversationalPackBuilder(ds, results);
  // OneCanvas Phase 1: refresh the Trust Strip (now with real validation
  // results) and the Metric Studio panel. Both no-op when their flags are off.
  renderOneCanvasPhase1();
  // Glow Path (Batch C): a real Validate run raises the session proficiency signal.
  proficiencyTracker.recordAction('validate');
  // Glow Path (Batch A): validation just changed what the best next action is
  // (warnings to review, an agent-readiness block, or a clean pass). No-op when
  // the glowPathRail flag is off.
  renderGlowPathRail();
  // The Glow (Batch 2): validation just changed the composed verdict — refresh
  // the topbar orb. No-op when glowOrb off.
  renderGlowOrbWidget();
}

// ============================================================
// Guided Conversational Pack Builder (Gen 42) — Validate-tab wiring
// ============================================================
// Turns the validation findings just produced into data-grounded questions and,
// ONLY when the `conversationalPackBuilder` flag is on, mounts the in-page
// one-question-at-a-time flow into the Validate header area. Ships dark: with the
// flag off (its default) the host is emptied and hidden, so nothing renders.

// Assemble the question-generator context from pipeline output already computed:
// per-column stats (impossible values + outliers) from the distribution
// fingerprint, plus the Missingness Detective's classified clusters.
async function buildConversationalContext(ds, results) {
  let columnStats = [];
  try {
    const fp = await validation.computeDistributionFingerprint(ds.table, ds.cols);
    columnStats = Object.entries(fp).map(([column, s]) => ({ column, ...s }));
  } catch { /* degrade gracefully to no stats — generator still runs on missingness */ }
  const missingness = (results && results.missingness_detective && Array.isArray(results.missingness_detective.findings))
    ? results.missingness_detective.findings
    : [];
  return { columnStats, missingness };
}

async function renderConversationalPackBuilder(ds, results) {
  const wrap = $('#pack-builder-wrap');
  const host = $('#pack-builder-body');
  if (!wrap || !host) return;

  // Flag off (default) → render nothing and leave no stale DOM behind.
  if (!isEnabled('conversationalPackBuilder')) {
    host.innerHTML = '';
    wrap.style.display = 'none';
    return;
  }

  // AI Readiness Gate (batch 3) enforcement — ships dark behind its own flag. When
  // ON, the agent-facing pack-authoring flow (question generator + uncertainty
  // resolver) is hard-blocked from consuming a dataset the gate marks not
  // agent-consumable; we thread the ALREADY-COMPUTED validation `results` as
  // layerResults (never re-running validation). This changes ONLY this agent flow —
  // the human-facing SQL/Python/R/Metric Studio workflows are untouched. When OFF
  // (default) no readiness context is threaded and the agents behave exactly as before.
  const readiness = isEnabled('aiReadinessGateEnforcement') ? { layerResults: results } : undefined;

  let questions = [];
  try {
    const ctx = await buildConversationalContext(ds, results);
    questions = generateQuestions(ctx, { max: 5, readiness });
  } catch (e) {
    console.warn('[conversationalPackBuilder] question generation failed:', e);
  }

  // Gate refusal → the agent declined to author from ungoverned data. Offer nothing
  // (humans keep full validation results elsewhere, unaffected).
  if (questions && questions.blocked === true) {
    console.info('[aiReadinessGateEnforcement] pack builder blocked:', questions.reasons);
    host.innerHTML = '';
    wrap.style.display = 'none';
    return;
  }

  if (!shouldOfferPackBuilder({ enabled: true, questions })) {
    host.innerHTML = '';
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = '';
  mountConversationalPackBuilder({
    host,
    questions,
    readiness,
    domain: (results && results.domainPack && results.domainPack.name) || '',
    voiceEnabled: isEnabled('conversationalPackBuilderVoice'),
    onDownload: downloadText,
    onSaveLocal: (pack) => {
      // Reuse the exact import/register path the Import Pack button uses: register
      // the compiled runtime pack for this session and surface it in the selector.
      domainPhysics.registerRuntimePack(pack);
      const sel = $('#domain-pack-select');
      if (sel && !Array.from(sel.options).some(o => o.value === pack.name)) {
        sel.appendChild(el('option', { value: pack.name, title: pack.description }, `${pack.label} (yours)`));
      }
      if (sel) sel.value = pack.name;
    },
    onToast: toast,
  });
}

// ============================================================
// OneCanvas Phase 1 — Trust Strip + Proof Drawer + Metric Studio (Validate tab)
// ============================================================
// All three ship dark behind their flags: with metricStudio and
// trustStripProofDrawer both OFF (their defaults), nothing here renders. Every
// value shown traces to real computed data — the loaded dataset's load time, the
// real validation results, the provenance chain, and the local Metric Studio
// registry — never a hardcoded placeholder.

// Local-only metric registry (in-memory; export/import JSON is user-driven).
const metricRegistry = new MetricRegistry();

// Append-only Metric Contract version history, sitting ALONGSIDE metricRegistry
// (Metric Contracts, Gen 44). It is written to only through recordMetricDefinitionVersion
// below, which fires from the existing Metric Studio human save path — there is
// no other writer. `metricContractProposals` holds AI-agent-proposed changes
// awaiting a human decision at the confirm gate; nothing in the running app
// produces one today (no metric-touching AI proposer exists — confirmed by grep),
// so it stays empty and the gate never surfaces. It exists as the single, honest
// seam a future proposer would push into, so the gate is wired, not faked.
const metricContractRegistry = new MetricContractRegistry();
const metricContractProposals = [];

// The one writer into the contract history: called by renderMetricStudio's
// onDefinitionSaved hook every time a human creates or merges a metric. Gated
// on the flag so, with metricContracts OFF, saving records nothing (unchanged).
function recordMetricDefinitionVersion(metric, meta = {}) {
  if (!isEnabled('metricContracts') || !metric || !metric.id) return;
  metricContractRegistry.recordVersion(metric.id, metric, {
    changedBy: meta.changedBy || metric.owner || 'you',
    reason: meta.reason || '',
    source: 'human',
  });
  renderMetricContractHistoryPanel();
}

// Open the Proof Drawer scoped to a Metric Studio metric.
function openMetricProof(metric) {
  openProofDrawer({ trigger: { type: 'metric', metric } });
}

// Open the Proof Drawer scoped to a clicked Trust Strip field, handing it the
// real underlying data for that field.
function openTrustFieldProof(field) {
  const ds = getActiveDataset();
  const chain = ds ? provenance.getProvenance(ds.table) : null;
  const trigger = {
    type: 'trust-field',
    field,
    validationResults: state.validationResults,
    metrics: metricRegistry.list(),
  };
  // Lineage fields render the existing attestation view; build it from the chain.
  if (field.key === 'lineage' && chain && chain.length > 0) {
    trigger.attestation = null; // async build below
    provenance.buildAttestation(chain.getTrail(), {
      table: ds.table, rowCount: ds.rowCount, colCount: ds.cols ? ds.cols.length : null,
      loadedAt: ds.loadedAt ? new Date(ds.loadedAt).toISOString() : null,
    }).then(att => openProofDrawer({ trigger: { ...trigger, attestation: att } }))
      .catch(() => openProofDrawer({ trigger }));
    return;
  }
  openProofDrawer({ trigger });
}

// Render the Trust Strip from real signals (or a clean empty state).
function renderTrustStripPanel() {
  const host = $('#trust-strip-host');
  if (!host) return;
  if (!isEnabled('trustStripProofDrawer')) { host.innerHTML = ''; return; }
  const ds = getActiveDataset();
  const chain = ds ? provenance.getProvenance(ds.table) : null;
  const signals = collectTrustSignals({
    dataset: ds,
    validationResults: state.validationResults,
    metricCounts: metricRegistry.statusCounts(),
    provenanceChain: chain,
    anomalyResult: null, // honest "not checked" until anomaly detection runs
  });
  renderTrustStrip({ host, signals, onFieldClick: openTrustFieldProof });
}

// Render the Metric Studio panel (create form + saved list + duplicate prompt).
function renderMetricStudioPanel() {
  const wrap = $('#metric-studio-wrap');
  const host = $('#metric-studio-body');
  if (!wrap || !host) return;
  if (!isEnabled('metricStudio')) { host.innerHTML = ''; wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const ds = getActiveDataset();
  renderMetricStudio({
    host,
    registry: metricRegistry,
    schemaCols: ds ? ds.cols : [],
    table: ds ? ds.table : null,
    engine,
    onOpenProof: openMetricProof,
    onToast: toast,
    onChange: renderTrustStripPanel, // certification counts feed the Trust Strip
    onDefinitionSaved: recordMetricDefinitionVersion, // Metric Contracts version trail
  });
}

// Render the read-only Metric Contract history: per metric, an oldest-first
// timeline of its recorded definition versions (Batch 2's buildHistoryListContent
// + renderDiffView), plus any pending AI-agent proposal at its confirm gate
// (Batch 3's renderConfirmGate). Read-only for the human's own past edits; the
// only mutating control it can ever show is a confirm-gate Approve button, which
// requires one explicit human click and never auto-applies.
function renderMetricContractHistoryPanel() {
  const wrap = $('#metric-contract-wrap');
  const host = $('#metric-contract-body');
  if (!wrap || !host) return;
  if (!isEnabled('metricContracts')) { host.innerHTML = ''; wrap.style.display = 'none'; return; }

  host.innerHTML = '';
  const pending = metricContractProposals.filter((p) => p && p.status === 'pending');
  const hasHistory = metricContractRegistry.size > 0;

  if (!hasHistory && pending.length === 0) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';

  // Each metric that has at least one recorded version gets its own timeline.
  for (const m of metricRegistry.list()) {
    if (!metricContractRegistry.has(m.id)) continue;
    const versions = metricContractRegistry.historyFor(m.id).list();
    const section = el('div', { style: 'margin-bottom:var(--space-3);', 'data-testid': 'metric-contract-section', 'data-metric-id': m.id });
    renderDiffView({ host: section, content: buildHistoryListContent({ metricName: m.name, versions }) });
    host.appendChild(section);
  }

  // Any pending proposal renders its confirm gate — never present in-app today
  // (nothing calls proposeContractChange), so this loop is a no-op in practice.
  for (const proposal of pending) {
    const metric = metricRegistry.get(proposal.metricId);
    const gateHost = el('div', { style: 'margin-top:var(--space-3);', 'data-testid': 'metric-contract-gate' });
    host.appendChild(gateHost);
    renderConfirmGate({
      host: gateHost,
      proposal,
      metricName: metric ? metric.name : proposal.metricId,
      contractRegistry: metricContractRegistry,
      metricRegistry,
      onDecision: () => renderMetricContractHistoryPanel(),
    });
  }
}

// Single entry point: refresh both flag-gated surfaces. Safe to call with no
// dataset loaded and before any validation run.
function renderOneCanvasPhase1() {
  renderTrustStripPanel();
  renderMetricStudioPanel();
  renderMetricContractHistoryPanel();
  applyValidateFocusMode();
}

// ============================================================
// Validate Focus Mode (Steve Jobs UX pass) — pure disclosure-state logic
// lives in validate-focus.js; this is just the DOM wiring, gated by the
// validateFocusMode flag. Flag OFF (shipped default): every <details> below
// is forced open every render, so nothing changes from pre-PR behavior —
// no removed control, no re-labeled control, no new default-collapsed state.
// ============================================================
const validateFocusStore = createValidateFocusStore();
let validateFocusListenersBound = false;
function applyValidateFocusMode() {
  const details = [$('#validate-advanced-options'), $('#validate-advanced-ai-synthesis'), $('#validate-advanced-peer-review')].filter(Boolean);
  if (!details.length) return;
  if (!isEnabled('validateFocusMode')) {
    details.forEach((d) => { d.open = true; });
    return;
  }
  const ds = getActiveDataset();
  const datasetKey = ds && ds.name;
  const expanded = validateFocusStore.isExpanded(datasetKey);
  details.forEach((d) => { d.open = expanded; });
  if (!validateFocusListenersBound) {
    // A manual toggle on ANY of the three disclosures counts as "the analyst
    // chose to look" — remembered per-dataset, and it opens the other two to
    // match (all three represent one conceptual "Advanced options" surface
    // split across the DOM only because the underlying cards are far apart).
    details.forEach((d) => {
      d.addEventListener('toggle', () => {
        if (!isEnabled('validateFocusMode')) return;
        const key = (getActiveDataset() || {}).name;
        if (!key) return;
        if (d.open) validateFocusStore.markManuallyExpanded(key);
        else validateFocusStore.markCollapsed(key);
        applyValidateFocusMode();
      });
    });
    validateFocusListenersBound = true;
  }
}

// ============================================================
// Meeting Scribe (Gen 43, Part 2) — Meeting tab wiring
// ============================================================
// Mounts the paste/type transcript screen (js/agents/meeting-scribe-ui.js)
// into the Meeting tab. The tab itself only exists in the bar when the
// meetingScribe flag is on (see renderTabBar); this function is the second,
// inner gate matching the conversationalPackBuilder precedent exactly, and
// also guards against a stale mount if the panel is ever revisited.
let meetingScribeMounted = false;
let meetingScribeHandle = null;
function renderMeetingScribeTab() {
  const host = $('#meeting-scribe-body');
  if (!host) return;
  if (!isEnabled('meetingScribe')) { host.innerHTML = ''; meetingScribeMounted = false; meetingScribeHandle = null; return; }
  if (!shouldOfferMeetingScribe({ enabled: true })) { host.innerHTML = ''; meetingScribeMounted = false; meetingScribeHandle = null; return; }
  if (!meetingScribeMounted) {
    meetingScribeHandle = mountMeetingScribe({ host, onToast: toast, liveCapture: isEnabled('meetingScribeLiveCapture') });
    meetingScribeMounted = true;
  }
  renderDecisionLedgerSection();
}

// ============================================================
// Meeting Decision Ledger (Gen 43, Part 3) — separate flag, separate host
// ============================================================
// Mounted underneath the Meeting Scribe screen inside the same panel, but
// gated by its OWN flag (meetingDecisionLedger) so it can ship dark
// independently of meetingScribe's flag state. Reads the in-progress
// meeting from meetingScribeHandle.getState() only when the analyst clicks
// Save — nothing here auto-saves anything.
let decisionLedgerMounted = false;
function renderDecisionLedgerSection() {
  const host = $('#meeting-decision-ledger-body');
  if (!host) return;
  if (!isEnabled('meetingDecisionLedger')) { host.innerHTML = ''; decisionLedgerMounted = false; return; }
  if (!shouldOfferDecisionLedger({ enabled: true })) { host.innerHTML = ''; decisionLedgerMounted = false; return; }
  if (decisionLedgerMounted) return; // already mounted this session
  mountDecisionLedger({
    host,
    store: memoryStore,
    getCurrentMeeting: () => (meetingScribeHandle && meetingScribeHandle.getState ? meetingScribeHandle.getState() : null),
    onToast: toast,
  });
  decisionLedgerMounted = true;
}

// ============================================================
// Data Diplomacy (Batch 2) — Diplomacy tab wiring
// ============================================================
// Mounts the two-key reconciliation panel (js/diplomacy/diplomacy-ui.js) over
// the pure Batch-1 engine (js/diplomacy/*). The tab only exists in the bar
// when the dataDiplomacy flag is on (see renderTabBar); this function is the
// second, inner gate matching the meetingScribe precedent exactly.
//
// HONESTY NOTE: the two claims below are a hardcoded DEMO scenario, built with
// the real sealClaim()/reconcileClaims()/createApprovalRequest() — NOT a
// data-loading feature. Wiring this to columns of the actually-loaded dataset
// (and to a real cross-device transport so the two keys are held by two
// different people) is deliberate future work, not this batch.
let diplomacyMounted = false;
async function renderDiplomacyTab() {
  const host = $('#diplomacy-body');
  if (!host) return;
  if (!isEnabled('dataDiplomacy')) { host.innerHTML = ''; diplomacyMounted = false; return; }
  if (diplomacyMounted) return; // already mounted this session
  diplomacyMounted = true;

  const partyAId = 'analyst';
  const partyBId = 'reviewer';
  // Two sources disagree on Q3 net revenue for the same account; the warehouse
  // export is more confident than the hand-maintained spreadsheet, so the
  // engine resolves it — but nothing applies until BOTH parties sign off.
  const claimA = await sealClaim({
    entityId: 'account-4821', field: 'q3_net_revenue', value: 128400,
    confidence: 0.92, source: 'warehouse-export', sealedBy: partyAId,
  });
  const claimB = await sealClaim({
    entityId: 'account-4821', field: 'q3_net_revenue', value: 131750,
    confidence: 0.6, source: 'finance-spreadsheet', sealedBy: partyBId,
  });
  const reconciliationResult = reconcileClaims(claimA, claimB);
  const approvalRequest = reconciliationResult.resolved
    ? createApprovalRequest({ reconciliationResult, partyAId, partyBId })
    : null;

  const paint = () => renderDiplomacyPanel({
    host, claimA, claimB, partyAId, partyBId, reconciliationResult, approvalRequest,
    onApprove: async (partyId) => {
      const res = await approveDiplomacy(approvalRequest, partyId);
      if (!res.ok && res.error) toast(res.error, 'error');
      else if (res.bothApproved) toast('Both keys turned — resolution applied and sealed.', 'success');
      paint();
    },
    onReject: (partyId) => {
      const res = rejectDiplomacy(approvalRequest, partyId);
      if (!res.ok && res.error) toast(res.error, 'error');
      paint();
    },
  });
  paint();
}

// ============================================================
// Source Convergence (Truth Network, Batch 3 of 3) — Convergence tab wiring
// ============================================================
// Mounts the Convergence surface (js/validation/source-convergence-ui.js) which
// wires the already-merged Batch 1 engine + Batch 2 adapters into a real tab.
// Gated by ONE flag, sourceConvergenceUI (off by default): with it off the tab
// is never in the bar (see renderTabBar) and this function clears/resets the
// panel — the engine/adapter flags it builds on are never touched here. Mounts
// once per session; the module owns its own load controls and empty state.
let convergenceMounted = false;
let convergenceHandle = null;
function renderConvergenceTab() {
  const host = $('#convergence-body');
  if (!host) return;
  if (!isEnabled('sourceConvergenceUI') || !shouldOfferConvergence({ enabled: true })) {
    host.innerHTML = '';
    if (convergenceHandle) { convergenceHandle.destroy(); }
    convergenceMounted = false;
    convergenceHandle = null;
    return;
  }
  if (!convergenceMounted) {
    convergenceHandle = mountConvergence({ host, onToast: toast });
    convergenceMounted = true;
  }
}

// ============================================================
// Proof Room (Trust Passport, composition batch 1) — Proof Room tab wiring
// ============================================================
// A single "assembled proof" screen that COMPOSES five already-shipped,
// already-tested trust surfaces top-to-bottom in a fixed product order:
// Metric Studio → Trust Strip → Data Nutrition Label → Verifiable Check Seal
// → Trust Beam. The composer/plan builder + presenter live in
// js/provenance/proof-room.js; this function is only the thin caller that
// supplies each step's REAL render function as a closure (mirroring how the
// SQL/Validate tabs already wire the same surfaces), so nothing here
// re-implements or forks a module.
//
// FLAG HANDLING: this tab is gated by ONE umbrella flag, proofRoom (off by
// default). The five underlying surfaces have NO internal flag check of their
// own, so the Proof Room calls each render function DIRECTLY regardless of its
// own trustStripProofDrawer/metricStudio/dataNutritionLabel/verifiableCheckSeal/
// trustBeam flag — this composed view is where they become visible together.
// The tab only exists in the bar when proofRoom is on (see renderTabBar); this
// function is the second, inner gate matching the meeting/diplomacy precedent,
// and it renders nothing until a dataset is loaded.
let proofRoomSeal = null;
// Build (or reuse) a seal over the latest validation summary for the composed
// seal + beam steps. Reuses the EXISTING sealCheckResult() verbatim — no new
// crypto. The "result" is a display roll-up of the real per-layer statuses
// (worst-wins), and the data bound to the seal is that same summary.
async function buildProofRoomSeal(ds) {
  if (proofRoomSeal) return proofRoomSeal;
  const { validation: valSummary } = collectValidationSummary();
  const rank = { fail: 3, warn: 2, pass: 1, idle: 0 };
  let status = 'pass';
  let flagCount = 0;
  for (const row of valSummary) {
    if (row.status !== 'pass' && row.status !== 'idle') flagCount += 1;
    if ((rank[row.status] || 0) > (rank[status] || 0)) status = row.status;
  }
  proofRoomSeal = await sealCheckResult({ status, flagCount }, {
    check: { name: 'DATAGLOW validation summary', kind: 'validation-summary' },
    params: JSON.stringify(valSummary.map((r) => r.layer)),
    dataset: {
      name: ds ? ds.name : 'active dataset',
      rowCount: ds ? (ds.rowCount ?? null) : null,
      columnNames: ds ? (ds.cols || []) : [],
    },
    data: valSummary,
    dataglow: { version: (window.__dataglowVersion || null), build: null },
  });
  return proofRoomSeal;
}
function renderProofRoomTab() {
  const host = $('#proof-room-body');
  if (!host) return;
  // Double-gate: the flag and (like every data-driven surface) a loaded dataset.
  if (!isEnabled('proofRoom')) { host.innerHTML = ''; return; }
  const ds = getActiveDataset();
  if (!ds) {
    host.innerHTML = '';
    host.appendChild(el('div', {
      class: 'card',
      style: 'padding:var(--space-4); font-size:var(--text-sm); color:var(--color-text-muted);',
    }, 'Load a dataset to assemble its Proof Room — the five trust surfaces compose here in order once there is data to describe.'));
    return;
  }
  // A fresh seal per (re)render of this tab — the composed steps reflect the
  // current dataset + validation state, not a stale artifact.
  proofRoomSeal = null;

  const chain = provenance.getProvenance(ds.table);
  const plan = buildProofRoomPlan({
    datasetLoaded: true,
    hasValidationResults: !!state.validationResults,
    aiTouchLedgerEnabled: isEnabled('aiTouchLedger'),
  });

  renderProofRoom({
    host,
    plan,
    renderers: {
      metricStudio: (body) => renderMetricStudio({
        host: body,
        registry: metricRegistry,
        schemaCols: ds.cols || [],
        table: ds.table,
        engine,
        onOpenProof: openMetricProof,
        onToast: toast,
        onChange: () => renderProofRoomTab(),
        onDefinitionSaved: recordMetricDefinitionVersion, // Metric Contracts version trail
      }),
      trustStrip: (body) => renderTrustStrip({
        host: body,
        signals: collectTrustSignals({
          dataset: ds,
          validationResults: state.validationResults,
          metricCounts: metricRegistry.statusCounts(),
          provenanceChain: chain,
          anomalyResult: null,
        }),
        onFieldClick: openTrustFieldProof,
      }),
      dataNutritionLabel: (body) => {
        const { validation: valSummary } = collectValidationSummary();
        const label = buildDataNutritionLabel({
          dataset: ds,
          custody: chain,
          assumptions: ledger.getLedgerEntries(),
          checks: valSummary,
        });
        for (const line of renderLabelSummaryLines(label)) {
          body.appendChild(el('div', {
            style: 'font-size:var(--text-xs); color:var(--color-text-muted); white-space:pre;',
          }, line));
        }
      },
      verifiableCheckSeal: (body) => {
        const note = el('div', {
          style: 'font-size:var(--text-xs); color:var(--color-text-faint);',
        }, 'Sealing the latest validation summary…');
        body.appendChild(note);
        (async () => {
          try {
            const seal = await buildProofRoomSeal(ds);
            const check = await verifySeal(seal, undefined);
            note.remove();
            for (const line of renderSealSummaryLines(seal)) {
              body.appendChild(el('div', {
                style: 'font-size:var(--text-xs); color:var(--color-text-muted); white-space:pre;',
              }, line));
            }
            body.appendChild(el('div', {
              style: `font-size:var(--text-xs); margin-top:6px; color:var(--color-${check.commitmentValid ? 'success' : 'error'});`,
            }, check.commitmentValid ? '✓ Commitment re-verified locally' : '✗ Commitment failed to verify'));
            body.appendChild(el('button', {
              class: 'btn btn-secondary',
              style: 'font-size:var(--text-xs); padding:2px 8px; align-self:flex-start; margin-top:6px;',
              'data-testid': 'proof-room-seal-download',
              onclick: () => downloadText('dataglow-check-seal.json', exportSealAsJSON(seal), 'application/json'),
            }, 'Download seal (.json)'));
          } catch (e) {
            note.textContent = 'Could not seal this result: ' + (e && e.message ? e.message : String(e));
          }
        })();
      },
      trustBeam: (body) => {
        const detail = el('div', {
          style: 'font-size:var(--text-xs); color:var(--color-text-muted);',
        }, 'Turn the seal above into a self-contained link whose whole payload lives in the URL fragment — nothing is uploaded. A recipient re-verifies it in verify-beam.html with zero install.');
        body.appendChild(detail);
        body.appendChild(el('button', {
          class: 'btn btn-primary',
          style: 'font-size:var(--text-xs); padding:2px 8px; align-self:flex-start; margin-top:6px;',
          'data-testid': 'proof-room-beam-create',
          onclick: async () => {
            try {
              const seal = await buildProofRoomSeal(ds);
              const baseUrl = new URL('verify-beam.html', window.location.href).href;
              const url = buildBeamUrl(seal, baseUrl);
              let field = body.querySelector('[data-testid="proof-room-beam-link"]');
              if (!field) {
                field = el('input', {
                  type: 'text', readonly: 'readonly',
                  'data-testid': 'proof-room-beam-link',
                  style: 'width:100%; margin-top:6px; font-family:var(--font-mono); font-size:var(--text-xs); '
                    + 'padding:4px 6px; border:1px solid var(--color-border); border-radius:var(--radius-sm); '
                    + 'background:var(--color-surface-2); color:var(--color-text);',
                  onclick: (e) => e.target.select(),
                });
                body.appendChild(field);
              }
              field.value = url;
              field.select && field.select();
              toast('Beam link ready — copy it to share', 'success');
            } catch (e) {
              toast('Could not build a beam link: ' + (e && e.message ? e.message : String(e)), 'error');
            }
          },
        }, 'Beam it'));
      },
      aiTouchLedger: (body) => {
        const entries = aiTouchLedger.getEntries();
        if (!entries.length) {
          body.appendChild(el('div', {
            style: 'font-size:var(--text-xs); color:var(--color-text-faint); font-style:italic;',
          }, 'No AI touches recorded yet this session — generate a story with an on-device or external model in the Story tab to see entries here.'));
          return;
        }
        body.appendChild(el('div', {
          style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:6px;',
        }, summarizeTouchLedger(entries)));
        body.appendChild(el('button', {
          class: 'btn btn-secondary',
          style: 'font-size:var(--text-xs); padding:2px 8px; align-self:flex-start;',
          'data-testid': 'proof-room-ai-touch-ledger-export',
          onclick: () => downloadText('dataglow-ai-touch-ledger.json', exportTouchLedger(entries, 'json'), 'application/json'),
        }, 'Download AI Touch Ledger (.json)'));
      },
    },
  });
}

// The Assumption Ledger — a running, exportable log of every judgment call.
function renderAssumptionLedger() {
  const wrap = $('#assumption-ledger-wrap');
  const list = $('#assumption-ledger-list');
  const entries = ledger.getLedgerEntries();
  wrap.style.display = '';
  if (!entries.length) {
    list.innerHTML = '<span style="color:var(--color-text-faint);">No assumptions recorded yet — run validation or apply a cleaning fix.</span>';
    return;
  }
  list.innerHTML = '';
  for (const e of entries) {
    const time = new Date(e.ts).toLocaleTimeString();
    list.appendChild(el('div', { style: 'padding:4px 0; border-top:1px solid var(--color-divider);' }, [
      el('span', { style: 'color:var(--color-text-faint);' }, `[${time}] `),
      el('span', { style: 'font-weight:600; color:var(--color-text-muted);' }, `${e.source}: `),
      el('span', {}, e.action),
    ]));
  }
  list.scrollTop = list.scrollHeight;
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function initLedger() {
  $('#btn-ledger-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ledger.exportLedger('text')); toast('Ledger copied', 'success'); }
    catch (e) { toast('Copy failed: ' + e.message, 'error'); }
  });
  $('#btn-ledger-export-txt').addEventListener('click', () => downloadText('dataglow-assumption-ledger.txt', ledger.exportLedger('text'), 'text/plain'));
  $('#btn-ledger-export-md').addEventListener('click', () => downloadText('dataglow-assumption-ledger.md', ledger.exportLedger('markdown'), 'text/markdown'));
  $('#btn-ledger-export-json').addEventListener('click', () => downloadText('dataglow-assumption-ledger.json', ledger.exportLedger('json'), 'application/json'));
  $('#btn-ledger-clear').addEventListener('click', () => { ledger.clearLedger(); renderAssumptionLedger(); toast('Ledger cleared', 'success'); });
}

// AI Touch Ledger (Batch 2) — UI panel modeled directly on the Assumption
// Ledger above (#assumption-ledger-wrap / renderAssumptionLedger / initLedger).
// Entirely gated by the aiTouchLedger flag: renderAiTouchLedgerPanel() is only
// ever called from the flag-gated call site in the Story tab handler above, and
// initAiTouchLedgerPanel()'s button wiring is itself flag-gated (see initApp).
function renderAiTouchLedgerPanel() {
  const wrap = $('#ai-touch-ledger-wrap');
  const list = $('#ai-touch-ledger-list');
  if (!wrap || !list) return;
  const entries = aiTouchLedger.getEntries();
  wrap.style.display = '';
  if (!entries.length) {
    list.innerHTML = '<span style="color:var(--color-text-faint);">No AI touches recorded yet — generate a story with an on-device or external model to see entries here.</span>';
    return;
  }
  list.innerHTML = '';
  for (const e of entries) {
    const time = new Date(e.ts).toLocaleTimeString();
    const locLabel = e.location === 'external' ? `external → ${e.sentTo || 'unknown endpoint'}` : 'on-device (private)';
    const rejected = e.rejected ? ' [rejected: malformed entry]' : '';
    const fieldsSuffix = Array.isArray(e.fieldsTouched) && e.fieldsTouched.length ? ` (fields: ${e.fieldsTouched.join(', ')})` : '';
    list.appendChild(el('div', { style: 'padding:4px 0; border-top:1px solid var(--color-divider);' }, [
      el('span', { style: 'color:var(--color-text-faint);' }, `[${time}] `),
      el('span', { style: 'font-weight:600; color:var(--color-text-muted);' }, `${e.model || 'unknown model'} — `),
      el('span', {}, `${locLabel}: ${e.action || ''}${fieldsSuffix}${rejected}`),
    ]));
  }
  list.scrollTop = list.scrollHeight;
}

function initAiTouchLedgerPanel() {
  const copyBtn = $('#btn-ai-touch-ledger-copy');
  const txtBtn = $('#btn-ai-touch-ledger-export-txt');
  const mdBtn = $('#btn-ai-touch-ledger-export-md');
  const jsonBtn = $('#btn-ai-touch-ledger-export-json');
  const clearBtn = $('#btn-ai-touch-ledger-clear');
  if (!copyBtn || !txtBtn || !mdBtn || !jsonBtn || !clearBtn) return;
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(exportTouchLedger(aiTouchLedger.getEntries(), 'text')); toast('AI Touch Ledger copied', 'success'); }
    catch (e) { toast('Copy failed: ' + e.message, 'error'); }
  });
  txtBtn.addEventListener('click', () => downloadText('dataglow-ai-touch-ledger.txt', exportTouchLedger(aiTouchLedger.getEntries(), 'text'), 'text/plain'));
  mdBtn.addEventListener('click', () => downloadText('dataglow-ai-touch-ledger.md', exportTouchLedger(aiTouchLedger.getEntries(), 'markdown'), 'text/markdown'));
  jsonBtn.addEventListener('click', () => downloadText('dataglow-ai-touch-ledger.json', exportTouchLedger(aiTouchLedger.getEntries(), 'json'), 'application/json'));
  clearBtn.addEventListener('click', () => { aiTouchLedger.clear(); renderAiTouchLedgerPanel(); toast('AI Touch Ledger cleared', 'success'); });
}

// Data Provenance Trail — the tamper-evident cryptographic sibling of the
// Assumption Ledger. Renders the hash-chained transformation timeline for the
// active dataset and lets the analyst verify + export it for audit.
function renderProvenanceTrail() {
  const wrap = $('#provenance-wrap');
  const list = $('#provenance-list');
  if (!wrap || !list) return;
  const ds = getActiveDataset();
  const chain = ds ? provenance.getProvenance(ds.table) : null;
  wrap.style.display = '';
  const deidWrap = $('#deid-verifier-wrap');
  if (deidWrap) deidWrap.style.display = ds ? '' : 'none';
  const denialWrap = $('#denial-profiler-wrap');
  if (denialWrap) denialWrap.style.display = ds ? '' : 'none';
  const trail = chain ? chain.getTrail() : [];
  if (!trail.length) {
    list.innerHTML = '<span style="color:var(--color-text-faint);">No provenance recorded yet — load a dataset to anchor the chain of custody.</span>';
    return;
  }
  list.innerHTML = '';
  for (const e of trail) {
    list.appendChild(el('div', { style: 'padding:5px 0; border-top:1px solid var(--color-divider);' }, [
      el('span', { style: 'color:var(--color-text-faint);' }, `#${e.index} `),
      el('span', { style: 'font-weight:600; color:var(--color-text-muted);' }, `${e.op}: `),
      el('span', {}, e.description),
      el('div', { class: 'mono', style: 'font-size:0.9em; color:var(--color-text-faint);' }, `hash ${e.hash.slice(0, 16)}… ← parent ${e.parentHash.slice(0, 16)}…`),
    ]));
  }
  renderBlameColumns(trail);
}

// Cell-level Data Blame — a reader over the same provenance trail. Populate the
// column picker with the columns some transform actually touched, then render
// the ordered per-column history for whichever is selected.
function renderBlameColumns(trail) {
  const sel = $('#blame-column');
  const history = $('#blame-history');
  if (!sel || !history) return;
  const idx = dataBlame.buildBlameIndex(trail || []);
  const columns = Object.keys(idx.byColumn).sort();
  const prev = sel.value;
  sel.innerHTML = '';
  if (!columns.length) {
    sel.appendChild(el('option', { value: '' }, 'No columns changed yet'));
    sel.disabled = true;
    history.innerHTML = '<span style="color:var(--color-text-faint);">Apply a cleaning fix or merge to build a change history.</span>';
    return;
  }
  sel.disabled = false;
  for (const c of columns) sel.appendChild(el('option', { value: c }, `"${c}" (${idx.byColumn[c].length})`));
  sel.value = columns.includes(prev) ? prev : columns[0];
  renderBlameHistory(trail, sel.value);
}

function renderBlameHistory(trail, column) {
  const history = $('#blame-history');
  if (!history) return;
  const entries = dataBlame.blameForColumn(trail || [], column);
  history.innerHTML = '';
  history.appendChild(el('div', { style: 'color:var(--color-text-muted); margin-bottom:var(--space-1);' }, dataBlame.summarizeColumnBlame(trail || [], column)));
  for (const e of entries) {
    const when = e.ts ? new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19) : '';
    const affected = typeof e.affectedCount === 'number' ? ` · ${e.affectedCount} cell(s)` : '';
    const change = (e.before !== undefined || e.after !== undefined) ? ` · "${e.before ?? ''}" → "${e.after ?? ''}"` : '';
    history.appendChild(el('div', { style: 'padding:4px 0; border-top:1px solid var(--color-divider);' }, [
      el('span', { style: 'color:var(--color-text-faint);' }, `#${e.index} `),
      el('span', { style: 'font-weight:600; color:var(--color-text-muted);' }, `${e.rule || e.op}`),
      el('span', {}, `${affected}${change}`),
      el('div', { style: 'color:var(--color-text-faint);' }, `${when} — ${e.description}`),
    ]));
  }
}

function initDataBlame() {
  const sel = $('#blame-column');
  if (!sel) return;
  sel.addEventListener('change', () => {
    const ds = getActiveDataset();
    const chain = ds ? provenance.getProvenance(ds.table) : null;
    renderBlameHistory(chain ? chain.getTrail() : [], sel.value);
  });
}

function initProvenance() {
  $('#btn-provenance-verify').addEventListener('click', async () => {
    const ds = getActiveDataset();
    const chain = ds ? provenance.getProvenance(ds.table) : null;
    const statusEl = $('#provenance-verify-status');
    if (!chain || !chain.length) { statusEl.textContent = 'Nothing to verify yet.'; statusEl.style.color = 'var(--color-text-faint)'; return; }
    const res = await chain.verify();
    statusEl.textContent = res.reason;
    statusEl.style.color = res.valid ? 'var(--color-grade-a)' : 'var(--color-grade-d)';
    toast(res.valid ? 'Provenance chain intact' : 'Provenance chain broken', res.valid ? 'success' : 'error');
  });
  $('#btn-provenance-export').addEventListener('click', () => {
    const ds = getActiveDataset();
    const chain = ds ? provenance.getProvenance(ds.table) : null;
    if (!chain || !chain.length) { toast('No provenance to export', 'error'); return; }
    downloadText(`dataglow-provenance-${ds.table}.json`, chain.exportTrail('json'), 'application/json');
  });
  const attMeta = (ds) => ({
    table: ds.table,
    rowCount: ds.rowCount,
    colCount: Array.isArray(ds.cols) ? ds.cols.length : null,
    columns: Array.isArray(ds.cols) ? ds.cols.map(c => ({ name: c.name, type: c.type })) : null,
    loadedAt: ds.loadedAt,
  });
  const attBtn = $('#btn-attestation-export');
  if (attBtn) attBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    const chain = ds ? provenance.getProvenance(ds.table) : null;
    if (!chain || !chain.length) { toast('No provenance to attest', 'error'); return; }
    const att = await chain.attest(attMeta(ds));
    downloadText(`dataglow-attestation-${ds.table}.json`, JSON.stringify(att, null, 2), 'application/json');
    toast('Attestation exported — digest ready for third-party notarization', 'success');
  });
  const attHtmlBtn = $('#btn-attestation-html');
  if (attHtmlBtn) attHtmlBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    const chain = ds ? provenance.getProvenance(ds.table) : null;
    if (!chain || !chain.length) { toast('No provenance to attest', 'error'); return; }
    const att = await chain.attest(attMeta(ds));
    downloadText(`dataglow-attestation-${ds.table}.html`, provenance.renderAttestationHTML(att), 'text/html');
    toast('Attestation HTML exported (printable / PDF-friendly)', 'success');
  });
  // Selective-disclosure provenance proof — a Merkle (SHA-256) commitment over
  // the validation claims, shareable to a third party who can verify specific
  // claims without ever receiving the dataset. Honest labelling: this is
  // selective disclosure with hash-verified membership, NOT a zero-knowledge proof.
  const sdBtn = $('#btn-sd-proof-export');
  if (sdBtn) sdBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    const results = state.validationResults || window.__dataglowLastValidation;
    if (!results) { toast('Run validation first to produce claims to prove', 'error'); return; }
    let attestationRef = null;
    const chain = provenance.getProvenance(ds.table);
    if (chain && chain.length) {
      const att = await chain.attest(attMeta(ds));
      attestationRef = { digest: att.digest && att.digest.value, finalHash: att.chain && att.chain.finalHash };
    }
    const artifact = await sdProof.generateProof({
      recordCount: ds.rowCount,
      grades: results.calibratedGrades,
      results,
      dataglow: { version: '1.0.0', build: 'gen10-batch3' },
      attestationRef,
    });
    downloadText(`dataglow-sd-proof-${ds.table}.json`, JSON.stringify(artifact, null, 2), 'application/json');
    toast('Verifiable proof exported — share the root/claims; the dataset stays private', 'success');
  });

  // Personal Data Bill of Materials — one-click, fully offline "ingredient
  // label" export. Land-dark behind the personalDataBom flag: with it off
  // (the default) the buttons stay hidden and every other export is unaffected.
  // Only ever READS what the user already has loaded (dataset, provenance
  // chain, whether they chose to load the on-device model) and hands them a
  // file to review — no data leaves the browser, nothing is auto-applied.
  const bomBtn = $('#btn-databom-export');
  const bomHtmlBtn = $('#btn-databom-html');
  const bomVerifyBtn = $('#btn-databom-verify');
  if (isEnabled('personalDataBom') && bomBtn) bomBtn.style.display = '';
  if (isEnabled('personalDataBom') && bomHtmlBtn) bomHtmlBtn.style.display = '';
  if (isEnabled('personalDataBom') && bomVerifyBtn) bomVerifyBtn.style.display = '';
  // The most recently generated BOM this session — the Verify button re-checks
  // THIS object rather than rebuilding, so the user verifies exactly what they
  // just exported. Null until an export happens; the Verify button handles that
  // state gracefully instead of throwing.
  let lastBom = null;
  const buildBomForActiveDataset = async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return null; }
    const chain = provenance.getProvenance(ds.table);
    const trail = chain ? chain.getTrail() : [];
    // Best-effort distribution snapshot: reuses the exact same function the
    // Validate tab's drift/conversational-builder paths already call. If the
    // engine can't compute it (e.g. an odd column type), degrade gracefully
    // to "not computed" rather than failing the whole export — the BOM module
    // itself already handles distribution:null cleanly.
    let distribution = null;
    try { distribution = await validation.computeDistributionFingerprint(ds.table, ds.cols); } catch { /* leave null */ }
    // Only ever claim the local model was "used" if the user actually loaded
    // it this session (ondeviceLLM.isModelLoaded()) — never assume.
    const localModel = {
      modelId: ondeviceLLM.MODEL_ID,
      modelLabel: ondeviceLLM.MODEL_LABEL,
      used: ondeviceLLM.isModelLoaded(),
    };
    return dataBom.buildPersonalDataBom({
      dataset: ds, trail, distribution, localModel,
      sourceDescription: `Uploaded file: ${ds.name || ds.table}`,
    });
  };
  if (bomBtn) bomBtn.addEventListener('click', async () => {
    const bom = await buildBomForActiveDataset();
    if (!bom) return;
    lastBom = bom;
    downloadText(`dataglow-personal-data-bom-${bom.source.table}.json`, JSON.stringify(bom, null, 2), 'application/json');
    toast('Personal Data BOM exported — digest ready for optional third-party notarization', 'success');
  });
  if (bomHtmlBtn) bomHtmlBtn.addEventListener('click', async () => {
    const bom = await buildBomForActiveDataset();
    if (!bom) return;
    lastBom = bom;
    downloadText(`dataglow-personal-data-bom-${bom.source.table}.html`, dataBom.renderPersonalDataBomHTML(bom), 'text/html');
    toast('Personal Data BOM HTML exported (printable / PDF-friendly)', 'success');
  });
  // Verify the most recently generated Data BOM: recompute its SHA-256 digest
  // and re-check the nested provenance attestation, fully offline. Renders a
  // plain-language result for the (non-engineer) analyst. All DOM built with
  // el()/createTextNode — no innerHTML with interpolated data — so a hostile
  // column name or source string can never inject markup.
  if (bomVerifyBtn) bomVerifyBtn.addEventListener('click', async () => {
    const out = $('#databom-verify-result');
    if (out) out.replaceChildren();
    if (!lastBom) {
      if (out) out.appendChild(el('div', { style: 'color:var(--color-text-faint);' },
        'No Data BOM to verify yet — click "Export Data BOM" (or "Data BOM HTML") first, then verify it.'));
      toast('Build a Data BOM first, then verify it', 'warn');
      return;
    }
    let res;
    try {
      res = await dataBom.verifyPersonalDataBom(lastBom);
    } catch {
      res = null;
    }
    if (!out) return;
    const desc = dataBom.describeBomVerification(res);
    out.appendChild(el('div', {
      style: `font-weight:600; color:${desc.ok ? 'var(--color-grade-a)' : 'var(--color-grade-d)'};`,
    }, desc.headline));
    if (desc.details.length) {
      out.appendChild(el('ul',
        { style: 'margin:4px 0 0 16px; color:var(--color-text-faint);' },
        desc.details.map((d) => el('li', {}, d))));
    }
    toast(
      desc.ok ? 'Data BOM verified — nothing tampered with' : 'Data BOM verification failed — see details',
      desc.ok ? 'success' : 'error',
    );
  });
}

// De-identification Verifier — one-click HIPAA Safe Harbor check + re-id risk
// score + signed attestation. Runs entirely against the in-browser DuckDB-WASM
// data; nothing is uploaded. Holds the last attestation so Export can sign it.
let lastDeidAttestation = null;

function renderDeidReport(report) {
  const out = $('#deid-report');
  if (!out) return;
  out.innerHTML = '';
  const verdictColor = report.verdict === 'pass' ? 'var(--color-grade-a)'
    : report.verdict === 'review' ? 'var(--color-grade-c)' : 'var(--color-grade-d)';
  const riskColor = report.reidentification.level === 'low' ? 'var(--color-grade-a)'
    : report.reidentification.level === 'moderate' ? 'var(--color-grade-c)' : 'var(--color-grade-d)';
  out.appendChild(el('div', { style: 'display:flex; gap:var(--space-2); flex-wrap:wrap; align-items:center; margin-bottom:var(--space-3);' }, [
    el('span', { style: `font-size:var(--text-xs); font-weight:600; padding:2px 10px; border-radius:8px; color:#fff; background:${verdictColor};` }, `Verdict: ${report.verdict.toUpperCase()}`),
    el('span', { style: `font-size:var(--text-xs); font-weight:600; padding:2px 10px; border-radius:8px; color:#fff; background:${riskColor};` }, `Re-identification risk: ${report.reidentification.level} (${report.reidentification.score}/100)`),
    el('span', { style: 'font-size:var(--text-xs); color:var(--color-text-faint);' }, `${report.safeHarbor.flaggedCount} of 18 categories flagged`),
  ]));
  out.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:var(--space-2);' }, report.reidentification.rationale));
  const grid = el('div', { class: 'validation-grid' });
  for (const cat of report.safeHarbor.categories) {
    const card = el('div', { class: 'card validation-card', 'data-testid': `deid-cat-${cat.id}` });
    card.appendChild(el('div', { class: 'validation-card-head' }, [
      el('span', { class: 'validation-card-name' }, `${cat.n}. ${cat.label}`),
      el('span', { class: `validation-status ${cat.status === 'flag' ? 'warn' : 'pass'}` }, [
        el('span', { class: `status-dot ${cat.status === 'flag' ? 'warn' : 'pass'}` }),
        cat.status === 'flag' ? 'FLAG' : 'clear',
      ]),
    ]));
    if (cat.matchedColumns.length) {
      card.appendChild(el('div', { class: 'validation-card-desc' },
        cat.matchedColumns.map(m => `"${m.column}": ${m.reason}`).join(' · ')));
    }
    grid.appendChild(card);
  }
  out.appendChild(grid);
}

function initDeidVerifier() {
  const runBtn = $('#btn-deid-run');
  if (!runBtn) return;
  runBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    runBtn.disabled = true;
    try {
      const { report, attestation } = await deidVerifier.runDeidentificationCheck(ds.table, ds.cols, engine);
      lastDeidAttestation = attestation;
      renderDeidReport(report);
      toast(`De-identification check complete — verdict: ${report.verdict}`, report.verdict === 'pass' ? 'success' : 'warn');
    } catch (e) {
      toast('De-identification check failed: ' + (e && e.message || e), 'error');
    } finally {
      runBtn.disabled = false;
    }
  });
  const exportBtn = $('#btn-deid-export');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    if (!lastDeidAttestation) { toast('Run the de-identification check first', 'error'); return; }
    const ds = getActiveDataset();
    downloadText(`dataglow-deid-attestation-${ds ? ds.table : 'dataset'}.json`, JSON.stringify(lastDeidAttestation, null, 2), 'application/json');
    toast('Signed de-identification attestation exported', 'success');
  });
}

// Denial Root-Cause Profiler — schema-tolerant claims-denial risk buckets + a
// live "$ estimated at risk" quantifier + a signed attestation. Runs entirely
// against the in-browser DuckDB-WASM data; nothing is uploaded. Holds the last
// attestation so Export can save it.
let lastDenialAttestation = null;

function renderCostEstimate(cost) {
  const out = $('#denial-cost-estimate');
  if (!out) return;
  out.innerHTML = '';
  if (!cost) return;
  out.appendChild(el('div', { class: 'card', style: 'padding:var(--space-3); background:var(--color-surface-alt, var(--color-surface));', 'data-testid': 'denial-cost-estimate' }, [
    el('div', { style: 'font-size:var(--text-sm); font-weight:600; color:var(--color-text);' }, cost.label),
    el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-top:var(--space-1);' }, cost.disclaimer),
    el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-top:2px;' }, cost.sourceNote),
  ]));
}

function renderDenialReport(report) {
  const out = $('#denial-report');
  if (!out) return;
  out.innerHTML = '';
  out.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-bottom:var(--space-3);' },
    `${report.totalFlaggedRows.toLocaleString()} of ${report.dataset.rowCount.toLocaleString()} row(s) flagged across all buckets (${report.totalFlaggedPct}%). Scanned ${report.dataset.scannedRows.toLocaleString()} row(s)${report.dataset.truncated ? ' (truncated)' : ''}.`));
  const grid = el('div', { class: 'validation-grid' });
  for (const cat of report.categories) {
    const status = !cat.applicable ? 'idle' : cat.flaggedCount > 0 ? 'warn' : 'pass';
    const statusLabel = !cat.applicable ? 'n/a' : cat.flaggedCount > 0 ? 'FLAG' : 'clear';
    const card = el('div', { class: 'card validation-card', 'data-testid': `denial-cat-${cat.id}` }, [
      el('div', { class: 'validation-card-head' }, [
        el('span', { class: 'validation-card-name' }, cat.label),
        el('span', { class: `validation-status ${status}` }, [el('span', { class: `status-dot ${status}` }), statusLabel]),
      ]),
    ]);
    if (cat.applicable) {
      card.appendChild(el('div', { class: 'validation-card-desc' }, `${cat.flaggedCount.toLocaleString()} row(s) flagged (${cat.pct}%)`));
      for (const ex of cat.examples) {
        card.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:2px;' }, `${ex.claim}: ${ex.reason}`));
      }
    } else {
      card.appendChild(el('div', { class: 'validation-card-desc', style: 'color:var(--color-text-faint);' }, `Not checked — ${cat.notes[0] || 'required column absent'}`));
    }
    for (const note of cat.notes.slice(cat.applicable ? 0 : 1)) {
      card.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-top:2px;' }, note));
    }
    grid.appendChild(card);
  }
  out.appendChild(grid);
  out.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-top:var(--space-3);' }, report.disclaimer));
}

function initDenialProfiler() {
  const runBtn = $('#btn-denial-run');
  if (!runBtn) return;
  const costInput = $('#denial-cost-input');
  runBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    runBtn.disabled = true;
    try {
      const perErrorCost = costInput ? Number(costInput.value) : costOfBadData.DEFAULT_PER_ERROR_COST;
      const { report, attestation } = await denialProfiler.runDenialProfile(ds.table, ds.cols, engine, { perErrorCost });
      lastDenialAttestation = attestation;
      renderCostEstimate(report.cost);
      renderDenialReport(report);
      toast(`Denial profiler complete — ${report.totalFlaggedRows} row(s) flagged`, report.totalFlaggedRows ? 'warn' : 'success');
    } catch (e) {
      toast('Denial profiler failed: ' + (e && e.message || e), 'error');
    } finally {
      runBtn.disabled = false;
    }
  });
  // Re-price the last run instantly when the editable per-error cost changes.
  if (costInput) costInput.addEventListener('change', () => {
    if (!lastDenialAttestation) return;
    const perErrorCost = Number(costInput.value);
    renderCostEstimate(costOfBadData.estimateCostOfBadData({ flaggedCount: lastDenialAttestation.totalFlaggedRows, perErrorCost }));
  });
  const exportBtn = $('#btn-denial-export');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    if (!lastDenialAttestation) { toast('Run the denial profiler first', 'error'); return; }
    const ds = getActiveDataset();
    downloadText(`dataglow-denial-attestation-${ds ? ds.table : 'dataset'}.json`, JSON.stringify(lastDenialAttestation, null, 2), 'application/json');
    toast('Signed denial-profile attestation exported', 'success');
  });
}

// Populate the Domain Physics pack selector and re-run validation on change so
// switching packs (or turning reinterpretation off with "None") updates results.
// Also wires the optional Context Card: typing what the data is for re-orders
// the already-computed layer grid (no re-run needed) so the most relevant
// findings surface first; clearing it restores the default order.
function initDomainPack() {
  const sel = $('#domain-pack-select');
  if (!sel) return;
  const packs = domainPhysics.listPacks();
  sel.innerHTML = '';
  for (const p of packs) {
    const opt = el('option', { value: p.name, title: p.description }, p.label);
    if (p.name === 'healthcare') opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    if (getActiveDataset()) runValidation();
  });

  renderLoadedPacksAudit();

  const context = $('#context-card-input');
  if (context) {
    context.addEventListener('input', () => {
      if (window.__dataglowLastValidation) renderValidationResults(window.__dataglowLastValidation);
    });
  }

  // Teach-As-You-Clean controls: the toggle and the verbosity slider only affect
  // how results are rendered, so re-render the current results in place (no
  // re-validation) when either changes. State is read from the DOM each render.
  const rerender = () => {
    if (window.__dataglowLastValidation) renderValidationResults(window.__dataglowLastValidation);
  };
  const lessonToggle = $('#micro-lesson-toggle');
  if (lessonToggle) lessonToggle.addEventListener('change', rerender);
  const lessonLevel = $('#micro-lesson-level');
  if (lessonLevel) lessonLevel.addEventListener('change', rerender);
}

// Trust/audit surface for the Gen 40 plugin architecture: when domain packs are
// loaded through the plugin registry (the `pluginPacks` flag), list each loaded
// pack's id, version, industry, filled extension points, and the license /
// provenance of any sample data it ships. Purely informational and read-only; if
// the registry is absent (flag off / legacy path) the panel stays hidden so the
// UI is unchanged.
function renderLoadedPacksAudit() {
  const wrap = $('#loaded-packs-audit');
  const list = $('#loaded-packs-list');
  if (!wrap || !list) return;
  const described = packRegistry && typeof packRegistry.describeLoadedPacks === 'function'
    ? packRegistry.describeLoadedPacks() : [];
  if (!described.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';
  for (const p of described) {
    const points = (p.extensionPoints || []).join(', ') || 'none';
    const prov = p.provenance || {};
    const provBits = [];
    if (prov.sampleData) provBits.push(`sample data: ${prov.sampleData}`);
    if (prov.license) provBits.push(`license: ${prov.license}`);
    if (prov.disclaimer) provBits.push(prov.disclaimer);
    const row = el('div', { style: 'margin-bottom:var(--space-2);' });
    row.appendChild(el('div', {}, `${p.industry} — ${p.id} v${p.version}`));
    row.appendChild(el('div', { style: 'color:var(--color-text-faint);' }, `extension points: ${points}`));
    if (provBits.length) row.appendChild(el('div', { style: 'color:var(--color-text-faint);' }, provBits.join(' · ')));
    list.appendChild(row);
  }
}

// The Context Card free text ("What is this data for?"), session-only and never
// persisted or uploaded — read straight from the input each render.
function getDataContext() {
  const input = $('#context-card-input');
  return input ? input.value : '';
}

// ---- Teach-As-You-Clean (Stage C) --------------------------------------
// The "Learn while you clean" toggle and the Beginner/Practitioner/Expert
// verbosity slider are session-only UI state, read straight from the DOM each
// render (mirroring the Context Card) — never persisted to storage. When the
// toggle is off, or the module failed to load, no lesson is shown.
function microLessonsEnabled() {
  const t = $('#micro-lesson-toggle');
  return !!t && t.checked;
}
function microLessonLevel() {
  const s = $('#micro-lesson-level');
  const lvl = s ? s.value : undefined;
  return microLessons ? microLessons.normalizeLevel(lvl) : (lvl || 'practitioner');
}
// Build the one-line explanation element for a finding type, or null when the
// toggle is off, the module is unavailable, or there is no lesson for the type.
function microLessonNote(findingType) {
  if (!microLessons || !microLessonsEnabled()) return null;
  const text = microLessons.getMicroLesson(findingType, microLessonLevel());
  if (!text) return null;
  return el('div', {
    class: 'micro-lesson',
    'data-testid': `micro-lesson-${findingType}`,
    style: 'margin-top:var(--space-2); padding:var(--space-2); border-left:3px solid var(--color-accent, #3b82f6); background:rgba(59,130,246,0.06); font-size:var(--text-xs); color:var(--color-text-muted); border-radius:6px;',
  }, [
    el('span', { style: 'font-weight:600; margin-right:var(--space-1);' }, 'Why this matters:'),
    text,
  ]);
}

// Devil's Advocate Mode — stress-tests the current SQL result and renders a
// robust/sensitive verdict. Logs the attack into the Assumption Ledger.
function initDevilsAdvocate() {
  const btn = $('#btn-attack-analysis');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const out = $('#attack-results');
    if (!state.lastQueryResult || !state.lastQueryResult.rows.length) {
      out.innerHTML = '';
      toast('Run a SQL query with results first', 'error');
      return;
    }
    const report = devilsAdvocate.attackAnalysis(state.lastQueryResult);
    out.innerHTML = '';
    const color = report.robust ? 'var(--color-grade-a)' : 'var(--color-grade-d)';
    out.appendChild(el('div', { class: 'card', style: `padding:var(--space-4); margin-top:var(--space-3); border-color:${color};`, 'data-testid': 'attack-verdict' }, [
      el('div', { style: `font-weight:600; color:${color}; margin-bottom:var(--space-2);` }, report.verdict),
      report.headline ? el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-bottom:var(--space-2);' },
        `Headline tested: mean of "${report.headline.column}" = ${report.headline.value.toFixed(2)} (n=${report.headline.n}).`) : null,
      ...report.checks.map(c => el('div', { style: 'display:flex; gap:var(--space-2); align-items:flex-start; padding:var(--space-2) 0; border-top:1px solid var(--color-divider); font-size:var(--text-sm);' }, [
        el('span', { class: `status-dot ${c.robust ? 'pass' : 'fail'}`, style: 'margin-top:4px; flex:none;' }),
        el('div', {}, [
          el('div', { style: 'font-weight:600;' }, c.name),
          el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, c.detail),
        ]),
      ])),
    ]));

    // Analysis-robustness thickening (ships dark behind `robustnessVerdict`):
    // append the plain-language verdict + the driving-segment sensitivity
    // summary beneath the existing checks. Purely additive — with the flag off
    // (its shipped default) nothing below runs and the card is unchanged.
    if (isEnabled('robustnessVerdict') && robustnessVerdictMod) {
      try {
        const sensitivity = robustnessVerdictMod.mapAssumptionSensitivity(state.lastQueryResult, { log: false });
        const verdict = robustnessVerdictMod.robustnessVerdict(report, sensitivity);
        const vColor = verdict.verdict === 'robust' ? 'var(--color-grade-a)'
          : verdict.verdict === 'fragile' ? 'var(--color-grade-d)' : 'var(--color-text-muted)';
        out.querySelector('[data-testid="attack-verdict"]').appendChild(
          el('div', { style: 'margin-top:var(--space-3); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': 'robustness-verdict' }, [
            el('div', { style: `font-weight:600; color:${vColor}; text-transform:capitalize; margin-bottom:var(--space-1);` }, verdict.verdict),
            el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted);' }, verdict.reason),
            verdict.drivingFactor ? el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-top:var(--space-1);' }, `Driving factor: ${verdict.drivingFactor}`) : null,
          ]));
      } catch (rvErr) {
        console.warn('[robustnessVerdict] sensitivity/verdict skipped:', rvErr);
      }
    }

    renderAssumptionLedger();
  });
}

// Community Pack Sharing (Stage D) — export the currently-selected domain pack
// as a portable JSON file and import a shared pack back in. File-based only: no
// server, marketplace, or backend. An imported pack is validated against the
// strict community-pack schema and compiled through the SAME annotate-only rule
// path the built-in packs use, so it runs inside the exact same sandbox (it can
// only annotate/reinterpret findings — never hard-fail data or target a core
// layer). Only the descriptor-based packs (Retail, Finance, or a previously
// imported pack) are exportable; the hand-written healthcare pack is not.
function initCommunityPack() {
  const exportBtn = $('#btn-pack-export');
  const importInput = $('#pack-import-input');
  const note = $('#community-pack-note');
  if (!exportBtn || !communityPack) return;

  exportBtn.addEventListener('click', () => {
    const sel = $('#domain-pack-select');
    const name = sel ? sel.value : null;
    const pack = name && domainPhysics.getPackByName(name);
    if (!pack) { toast('Select a domain pack first', 'error'); return; }
    const { ok, json, reason } = communityPack.serializePack(pack);
    if (!ok) {
      if (note) note.textContent = reason;
      toast(reason, 'error');
      return;
    }
    downloadText(`dataglow-pack-${name}.json`, json, 'application/json');
    toast(`Exported the "${pack.label}" pack`, 'success');
  });

  if (importInput) {
    importInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        let parsed;
        try { parsed = JSON.parse(await file.text()); }
        catch { throw new Error('file is not valid JSON'); }
        const { ok, errors, pack } = communityPack.importPack(parsed);
        if (!ok) {
          const msg = `Import rejected: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''}`;
          if (note) note.textContent = msg;
          toast(msg, 'error');
          return;
        }
        // Register the validated, compiled pack for this session (in-memory only)
        // and surface it in the pack selector so it can be applied like a built-in.
        domainPhysics.registerRuntimePack(pack);
        const sel = $('#domain-pack-select');
        if (sel && !Array.from(sel.options).some(o => o.value === pack.name)) {
          sel.appendChild(el('option', { value: pack.name, title: pack.description }, `${pack.label} (imported)`));
        }
        if (sel) sel.value = pack.name;
        if (note) note.textContent = `Imported "${pack.label}" — ${pack.rules.length} rule(s). Applied to the current dataset.`;
        toast(`Imported the "${pack.label}" pack`, 'success');
        if (getActiveDataset()) runValidation();
      } catch (err) {
        const msg = 'Import failed: ' + err.message;
        if (note) note.textContent = msg;
        toast(msg, 'error');
      } finally {
        importInput.value = '';
      }
    });
  }
}

// Shareable Validation Receipts — package the current analysis (Confidence
// grade, all 20 layer statuses, key ledger entries, and the Story narrative)
// into one self-contained HTML file a stakeholder can open without DATAGLOW.
function initReceipts() {
  const btn = $('#btn-export-receipt');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const ds = getActiveDataset();
    const results = window.__dataglowLastValidation;
    if (!ds || !results) { toast('Run all 20 layers first', 'error'); return; }
    const model = receipt.buildValidationReceipt({
      datasetName: ds.name || ds.table,
      results,
      ledgerEntries: ledger.getLedgerEntries(),
      storyText: state.lastStory || null,
    });
    downloadText(`dataglow-receipt-${ds.table}.html`, receipt.renderReceiptHTML(model), 'text/html');
    toast('Validation Receipt exported', 'success');
  });
}

// Async Peer Review Mode — export a structured review packet from the current
// analysis for a second person, and re-import their completed review to display
// it alongside the analysis. File-based; no backend.
function initPeerReview() {
  const exportJson = $('#btn-review-export-json');
  const exportMd = $('#btn-review-export-md');
  const importInput = $('#review-import-input');
  if (!exportJson) return;

  const buildPacket = () => {
    const ds = getActiveDataset();
    const results = window.__dataglowLastValidation;
    if (!ds || !results) { toast('Run all 20 layers first', 'error'); return null; }
    return peerReview.buildReviewPacket({
      datasetName: ds.name || ds.table,
      query: state.lastQuery || null,
      results,
      ledgerEntries: ledger.getLedgerEntries(),
    });
  };

  exportJson.addEventListener('click', () => {
    const packet = buildPacket();
    if (!packet) return;
    downloadText(`dataglow-review-packet-${getActiveDataset().table}.json`, peerReview.exportPacket(packet, 'json'), 'application/json');
    toast('Review packet exported (.json)', 'success');
  });
  exportMd.addEventListener('click', () => {
    const packet = buildPacket();
    if (!packet) return;
    downloadText(`dataglow-review-packet-${getActiveDataset().table}.md`, peerReview.exportPacket(packet, 'markdown'), 'text/markdown');
    toast('Review packet exported (.md)', 'success');
  });
  importInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = peerReview.importReview(text);
      const wrap = $('#review-display-wrap');
      wrap.style.display = '';
      $('#review-display').innerHTML = peerReview.renderReviewHTML(imported);
      toast('Peer review imported', 'success');
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
    } finally {
      importInput.value = '';
    }
  });
}

// Time-Travel Diff Mode — load a second version of a dataset and compare it to
// the active one: row-level add/remove/change (keyed on a detected/picked PK),
// distributional drift (layer-18 logic), and which validation layers flip.
function initTimeTravelDiff() {
  const fileInput = $('#diff-file-input');
  const runBtn = $('#btn-diff-run');
  if (!fileInput || !runBtn) return;
  let otherDs = null;

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const base = getActiveDataset();
    if (!base) { toast('Load a primary dataset first', 'error'); fileInput.value = ''; return; }
    try {
      await ensureDuckDB();
      otherDs = await loaders.loadFile(file);
      // loadFile makes the new file active; restore the original as the base.
      setActiveDataset(base.name);
      renderSidebar();
      $('#diff-loaded-note').textContent = `Comparison dataset: ${otherDs.name} (${otherDs.rowCount.toLocaleString()} rows). Base: ${base.name}.`;

      // Populate the key-column picker from columns common to both datasets.
      const shared = base.cols.map(c => c.name).filter(n => otherDs.cols.some(c => c.name === n));
      const picker = $('#diff-key-select');
      picker.innerHTML = '<option value="__auto">Auto-detect key</option>' + shared.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
      runBtn.disabled = false;
    } catch (err) {
      toast('Could not load comparison dataset: ' + err.message, 'error');
    } finally {
      fileInput.value = '';
    }
  });

  runBtn.addEventListener('click', async () => {
    const base = getActiveDataset();
    if (!base || !otherDs) { toast('Load both datasets first', 'error'); return; }
    const out = $('#diff-results');
    out.innerHTML = '<div class="skeleton" style="height:120px; border-radius:var(--radius-md);"></div>';
    try {
      const [aRes, bRes] = [
        await engine.runQuery(`SELECT * FROM ${base.table}`),
        await engine.runQuery(`SELECT * FROM ${otherDs.table}`),
      ];
      const shared = base.cols.map(c => c.name).filter(n => otherDs.cols.some(c => c.name === n));
      const picked = $('#diff-key-select').value;
      const keyCol = picked && picked !== '__auto' ? picked : timeTravel.detectKeyColumn(shared, aRes.rows);

      let rowDiff = null;
      if (keyCol) rowDiff = timeTravel.diffRows(aRes.rows, bRes.rows, keyCol);

      // Aggregate/distributional diff over shared numeric+categorical columns.
      const sharedCols = base.cols.filter(c => otherDs.cols.some(o => o.name === c.name));
      const distDiff = await timeTravel.diffDistributions(base.table, otherDs.table, sharedCols);

      // Which of the 20 layers flip between the two versions.
      const layersA = await validation.runAllLayers(base, { freshnessThresholdHours: state.settings.freshnessThresholdHours });
      const layersB = await validation.runAllLayers(otherDs, { freshnessThresholdHours: state.settings.freshnessThresholdHours });
      setActiveDataset(base.name);
      const flips = timeTravel.diffLayerStatuses(layersA, layersB);

      renderDiffResults(out, { keyCol, rowDiff, distDiff, flips });
    } catch (err) {
      out.innerHTML = '';
      toast('Diff failed: ' + err.message, 'error');
    }
  });
}

function renderDiffResults(out, { keyCol, rowDiff, distDiff, flips }) {
  out.innerHTML = '';
  const section = (title) => el('div', { class: 'sidebar-heading', style: 'margin:var(--space-4) 0 var(--space-2);' }, title);

  // Row-level.
  out.appendChild(section('Row-Level Changes'));
  if (!rowDiff) {
    out.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-faint);' }, 'No unique key column found — pick one above to enable row-level diffing.'));
  } else {
    out.appendChild(el('div', { style: 'font-size:var(--text-sm); margin-bottom:var(--space-2);' }, `Keyed on "${keyCol}". ${rowDiff.added.length} added · ${rowDiff.removed.length} removed · ${rowDiff.changed.length} changed · ${rowDiff.unchanged} unchanged.`));
    for (const ch of rowDiff.changed.slice(0, 10)) {
      out.appendChild(el('div', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted); padding:2px 0;' },
        `#${ch.key}: ` + ch.fields.map(f => `${f.column}: ${f.from} → ${f.to}`).join(', ')));
    }
  }

  // Distributional.
  out.appendChild(section('Distributional Drift (Layer 18 logic)'));
  if (!distDiff.drifts.length) {
    out.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-grade-a);' }, '✓ No column distributions shifted meaningfully between the two versions.'));
  } else {
    distDiff.drifts.forEach(d => out.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-grade-c); padding:2px 0;' }, d)));
  }

  // Layer flips.
  out.appendChild(section('Validation Layer Flips'));
  const flipped = flips.filter(f => f.passFailFlip);
  if (!flipped.length) {
    out.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-faint);' }, 'No layers flipped between PASS and FAIL.'));
  } else {
    flipped.forEach(f => {
      const def = validation.LAYER_DEFS.find(l => l.id === f.layer);
      const color = f.to === 'fail' ? 'var(--color-grade-d)' : 'var(--color-grade-a)';
      out.appendChild(el('div', { style: `font-size:var(--text-sm); color:${color}; padding:2px 0;`, 'data-testid': `diff-flip-${f.layer}` },
        `${def ? def.name : f.layer}: ${f.from.toUpperCase()} → ${f.to.toUpperCase()}`));
    });
  }
}

// ============================================================
// Feature 6 — Synthetic Adversarial Twin (DP synthetic dataset)
// ============================================================
// Build a Governed Synthetic Data Passport (Trust Passport Batch 4) for a
// freshly-generated Synthetic Twin. Composes batch 2 (Data Nutrition Label) and,
// on demand, batch 3 (Verifiable Check Seal). The custody/assumptions/source
// checks describe the SOURCE dataset (the batch-1 Semantic/Metrics Layer results
// travel here via collectValidationSummary); the `generation` block honestly
// reflects the twin's real Laplace-DP mechanism and ε. Never built silently —
// only when the flag is on AND the human ticked the checkbox (see genBtn below).
function buildTwinPassport(ds, twin) {
  const chain = ds ? provenance.getProvenance(ds.table) : null;
  const { validation: valSummary } = collectValidationSummary();
  return buildSyntheticDataPassport({
    generation: twin,
    dataset: {
      name: `${ds ? ds.name : 'dataset'} (synthetic)`,
      table: ds ? ds.table : null,
      rowCount: twin.rows.length,
      columnNames: twin.columns,
      columnCount: twin.columns.length,
    },
    custody: chain,
    assumptions: ledger.getLedgerEntries(),
    checks: valSummary,
  });
}

function initSyntheticTwin() {
  const slider = $('#twin-epsilon-slider');
  const genBtn = $('#btn-twin-generate');
  const dlBtn = $('#btn-twin-download');
  if (!slider || !genBtn) return;
  let lastTwin = null;

  // Reveal the opt-in Governance Passport controls only when the flag is on;
  // otherwise they stay hidden and the twin flow is byte-for-byte unchanged.
  const passportOptin = $('#twin-passport-optin');
  const passportBox = $('#twin-include-passport');
  const passportActions = $('#twin-passport-actions');
  const passportEnabled = isEnabled('syntheticDataPassport');
  if (passportOptin && passportEnabled) passportOptin.style.display = '';

  // Render the passport affordance for the current twin: a summary plus explicit
  // Download / Seal+download buttons. Nothing here runs without a click.
  const renderPassportActions = () => {
    if (!passportActions) return;
    passportActions.innerHTML = '';
    if (!passportEnabled || !passportBox || !passportBox.checked || !lastTwin) {
      passportActions.style.display = 'none';
      return;
    }
    const ds = getActiveDataset();
    passportActions.style.display = 'flex';
    const dlPassport = el('button', {
      class: 'btn btn-secondary',
      style: 'font-size:var(--text-xs); padding:2px 8px;',
      'data-testid': 'button-twin-passport-download',
      onclick: () => {
        const passport = buildTwinPassport(ds, lastTwin);
        downloadText(`dataglow-synthetic-${ds ? ds.table : 'twin'}-passport.json`,
          exportPassportAsJSON(passport), 'application/json');
        toast('Governance passport downloaded', 'success');
      },
    }, 'Download Passport (.json)');
    const sealPassport = el('button', {
      class: 'btn btn-secondary',
      style: 'font-size:var(--text-xs); padding:2px 8px;',
      'data-testid': 'button-twin-passport-seal',
      onclick: async () => {
        try {
          const passport = buildTwinPassport(ds, lastTwin);
          // Seal binds the exact generation parameters to a fingerprint of the
          // synthetic OUTPUT actually being shipped (the twin's CSV).
          const csv = syntheticTwin.toCSV(lastTwin.columns, lastTwin.rows);
          const sealed = await sealSyntheticPassport(passport, {
            data: csv,
            dataglow: { version: (window.__dataglowVersion || null), build: null },
          });
          downloadText(`dataglow-synthetic-${ds ? ds.table : 'twin'}-passport-sealed.json`,
            exportPassportAsJSON(sealed), 'application/json');
          toast('Passport sealed and downloaded', 'success');
        } catch (e) {
          toast('Could not seal passport: ' + e.message, 'error');
        }
      },
    }, 'Seal + download');
    passportActions.appendChild(dlPassport);
    passportActions.appendChild(sealPassport);
  };
  if (passportBox) passportBox.addEventListener('change', renderPassportActions);

  const refreshNote = () => {
    const eps = parseFloat(slider.value);
    $('#twin-epsilon-value').textContent = eps;
    $('#twin-epsilon-note').textContent = syntheticTwin.epsilonExplanation(eps);
  };
  slider.addEventListener('input', refreshNote);
  refreshNote();

  genBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    const out = $('#twin-results');
    out.innerHTML = '<div class="skeleton" style="height:100px; border-radius:var(--radius-md);"></div>';
    try {
      const { rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT 100000`);
      const twin = syntheticTwin.generateSyntheticTwin({ columns: ds.cols, rows, epsilon: parseFloat(slider.value) });
      lastTwin = twin;
      dlBtn.disabled = false;
      const disc = $('#twin-disclaimer');
      disc.style.display = 'block';
      disc.textContent = twin.disclaimer;
      out.innerHTML = '';
      out.appendChild(el('div', { style: 'font-size:var(--text-sm); margin-bottom:var(--space-2);', 'data-testid': 'twin-summary' },
        `Generated ${twin.rows.length} synthetic rows (ε=${twin.epsilon}, ${twin.mechanism}).`));
      twin.comparison.forEach(c => {
        let line;
        if (c.type === 'numeric') {
          line = `${c.column} (numeric): real mean ${c.real.mean} / synth ${c.synthetic.mean} · real std ${c.real.std} / synth ${c.synthetic.std}`;
        } else {
          const rt = c.real.top[0] ? c.real.top[0].value : '—';
          const st = c.synthetic.top[0] ? c.synthetic.top[0].value : '—';
          line = `${c.column} (categorical): real top "${rt}" / synth top "${st}"`;
        }
        out.appendChild(el('div', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted); padding:2px 0;', 'data-testid': `twin-cmp-${c.column}` }, line));
      });
      renderPassportActions();
      toast('Synthetic twin generated', 'success');
    } catch (err) {
      out.innerHTML = '';
      toast('Twin generation failed: ' + err.message, 'error');
    }
  });

  dlBtn.addEventListener('click', () => {
    if (!lastTwin) return;
    const ds = getActiveDataset();
    downloadText(`dataglow-synthetic-${ds ? ds.table : 'twin'}.csv`, syntheticTwin.toCSV(lastTwin.columns, lastTwin.rows), 'text/csv');
    toast('Synthetic CSV downloaded', 'success');
  });
}

// ============================================================
// Feature 7 — Data Time Machine (explicit snapshot ledger)
// ============================================================
function initTimeMachine() {
  const saveBtn = $('#btn-tm-save');
  const exportBtn = $('#btn-tm-export');
  if (!saveBtn) return;

  const render = async () => {
    const ds = getActiveDataset();
    const listEl = $('#tm-list');
    if (!ds) { listEl.innerHTML = '<span style="color:var(--color-text-faint);">Load a dataset to save snapshots.</span>'; return; }
    let snaps = [];
    try { snaps = await timeMachine.listSnapshots(ds.name || ds.table); } catch { /* IndexedDB unavailable */ }
    if (!snaps.length) { listEl.innerHTML = '<span style="color:var(--color-text-faint);">No snapshots yet for this dataset.</span>'; return; }
    listEl.innerHTML = '';
    snaps.forEach(s => {
      const row = el('div', { style: 'display:flex; align-items:center; justify-content:space-between; gap:var(--space-2); padding:var(--space-2) 0; border-bottom:1px solid var(--color-divider);', 'data-testid': `tm-snap-${s.hash}` }, [
        el('div', {}, [
          el('div', { style: 'font-size:var(--text-sm);' }, `${new Date(s.timestamp).toLocaleString()} — ${s.rowCount} rows`),
          el('div', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-faint);' }, `${s.hash} · ${s.diffSummary.text}`),
        ]),
        el('button', { class: 'btn btn-secondary', 'data-testid': `tm-load-${s.hash}`, onclick: () => loadSnapshot(s) }, 'Load into Diff'),
      ]);
      listEl.appendChild(row);
    });
  };

  const loadSnapshot = async (snap) => {
    if (!snap.rows) { toast('This snapshot did not embed its rows and cannot be reloaded.', 'error'); return; }
    const base = getActiveDataset();
    if (!base) return;
    const out = $('#diff-results');
    out.innerHTML = '<div class="skeleton" style="height:120px; border-radius:var(--radius-md);"></div>';
    try {
      const snapTable = `tm_snap_${snap.hash}`.slice(0, 60);
      await engine.createTableFromRows(snapTable, snap.columns, snap.rows);
      const aRes = await engine.runQuery(`SELECT * FROM ${base.table}`);
      const shared = base.cols.map(c => c.name).filter(n => snap.columns.includes(n));
      const keyCol = timeTravel.detectKeyColumn(shared, aRes.rows);
      const rowDiff = keyCol ? timeTravel.diffRows(snap.rows, aRes.rows, keyCol) : null;
      const sharedCols = base.cols.filter(c => snap.columns.includes(c.name));
      const distDiff = await timeTravel.diffDistributions(snapTable, base.table, sharedCols);
      renderDiffResults(out, { keyCol, rowDiff, distDiff, flips: [] });
      switchTab('diff');
      toast('Snapshot loaded into Diff view', 'success');
    } catch (err) {
      out.innerHTML = '';
      toast('Could not load snapshot: ' + err.message, 'error');
    }
  };

  saveBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    try {
      const quota = await timeMachine.checkStorageQuota();
      const noteEl = $('#tm-quota-note');
      if (quota.supported && quota.nearLimit) {
        noteEl.textContent = `Browser storage is ${(quota.ratio * 100).toFixed(0)}% full — export and prune older snapshots to an archive file to avoid losing data.`;
      } else {
        noteEl.textContent = '';
      }
      const { columns, rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT 100000`);
      const previous = await timeMachine.latestSnapshot(ds.name || ds.table);
      const snap = timeMachine.buildSnapshot({ datasetName: ds.name || ds.table, columns, rows, previous });
      await timeMachine.saveSnapshot(snap);
      await render();
      toast('Snapshot saved', 'success');
    } catch (err) {
      toast('Could not save snapshot: ' + err.message, 'error');
    }
  });

  if (exportBtn) exportBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    try {
      const snaps = await timeMachine.listSnapshots(ds.name || ds.table);
      if (!snaps.length) { toast('No snapshots to export', 'error'); return; }
      downloadText(`dataglow-timemachine-${ds.table}.json`, timeMachine.exportArchive(snaps), 'application/json');
      toast('Snapshot archive exported', 'success');
    } catch (err) {
      toast('Export failed: ' + err.message, 'error');
    }
  });

  render();
}

// ============================================================
// Feature 8 — Federated Fingerprinting (Experimental)
// ============================================================
function initFederatedFingerprint() {
  const exportBtn = $('#btn-fp-export');
  const fileA = $('#fp-file-a');
  const fileB = $('#fp-file-b');
  const compareBtn = $('#btn-fp-compare');
  if (!exportBtn) return;
  $('#fp-disclaimer').textContent = fingerprint.FINGERPRINT_DISCLAIMER;
  let fpA = null, fpB = null;

  exportBtn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    try {
      const { rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT 100000`);
      const fp = fingerprint.buildFingerprint({ datasetName: ds.name || ds.table, columns: ds.cols, rows });
      downloadText(`dataglow-fingerprint-${ds.table}.json`, JSON.stringify(fp, null, 2), 'application/json');
      toast('Fingerprint exported', 'success');
    } catch (err) {
      toast('Fingerprint export failed: ' + err.message, 'error');
    }
  });

  const readFp = (file, which) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const fp = fingerprint.parseFingerprint(reader.result);
        if (which === 'a') fpA = fp; else fpB = fp;
        $('#fp-loaded-note').textContent = `${fpA ? 'A: ' + fpA.datasetName : 'A: —'} · ${fpB ? 'B: ' + fpB.datasetName : 'B: —'}`;
        compareBtn.disabled = !(fpA && fpB);
      } catch (err) {
        toast('Not a valid fingerprint file: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  };
  fileA.addEventListener('change', e => { if (e.target.files[0]) readFp(e.target.files[0], 'a'); e.target.value = ''; });
  fileB.addEventListener('change', e => { if (e.target.files[0]) readFp(e.target.files[0], 'b'); e.target.value = ''; });

  compareBtn.addEventListener('click', () => {
    if (!fpA || !fpB) return;
    const out = $('#fp-results');
    out.innerHTML = '';
    try {
      const cmp = fingerprint.compareFingerprints(fpA, fpB);
      out.appendChild(el('div', { style: 'font-size:var(--text-sm); margin-bottom:var(--space-2);', 'data-testid': 'fp-compare-summary' },
        `${cmp.summary.meaningfullyDifferent} of ${cmp.summary.sharedColumns} shared column(s) differ meaningfully (JSD > ${cmp.threshold}).`));
      cmp.columns.forEach(c => {
        const color = c.meaningful ? 'var(--color-grade-c)' : 'var(--color-text-muted)';
        const jsdTxt = c.jsd != null ? `JSD ${c.jsd}` : (c.note || '—');
        out.appendChild(el('div', { style: `font-size:var(--text-xs); color:${color}; padding:2px 0;`, 'data-testid': `fp-col-${c.column}` },
          `${c.column} [${c.present}]: ${jsdTxt}${c.meaningful ? ' — meaningfully different' : ''}`));
      });
    } catch (err) {
      toast('Comparison failed: ' + err.message, 'error');
    }
  });
}

// ============================================================
// Feature 9 — IRB / Regulatory Language Auto-Translation Mode
// ============================================================
function initIRBMode() {
  const btn = $('#btn-export-irb');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const ds = getActiveDataset();
    const results = window.__dataglowLastValidation;
    if (!ds || !results) { toast('Run all 20 layers first', 'error'); return; }
    try {
      const chain = provenance.getProvenance(ds.table);
      const provenanceTrail = chain ? chain.getTrail() : [];
      const provenanceVerification = chain && chain.length ? await chain.verify() : null;
      const model = irbMode.buildIRBDocument({
        datasetName: ds.name || ds.table,
        results,
        ledgerEntries: ledger.getLedgerEntries(),
        provenanceTrail,
        provenanceVerification,
        storyText: state.lastStory || null,
      });
      downloadText(`dataglow-irb-${ds.table}.html`, irbMode.renderIRBHTML(model), 'text/html');
      toast('IRB / compliance document exported', 'success');
    } catch (err) {
      toast('IRB export failed: ' + err.message, 'error');
    }
  });
}

// Top 5 Problems — a scannable pre-analysis checklist (checklist methodology
// popularized by Atul Gawande, "The Checklist Manifesto"). Surfaces the
// highest-severity findings across all layers with jump-links.
async function renderTopProblems(ds, results) {
  const wrap = $('#top-problems-wrap');
  const list = $('#top-problems-list');
  const sevRank = { fail: 3, warn: 2, pass: 0, idle: 0 };
  const problems = [];
  for (const layer of validation.LAYER_DEFS) {
    if (layer.id === 'confidence' || layer.id === 'red_team') continue;
    const r = results[layer.id];
    if (!r || !sevRank[r.status]) continue;
    problems.push({ id: layer.id, name: layer.name, status: r.status, summary: r.summary || layer.desc, sev: sevRank[r.status] });
  }
  problems.sort((a, b) => b.sev - a.sev);
  const top = problems.slice(0, 5);
  if (!top.length) {
    wrap.style.display = '';
    list.innerHTML = '<div style="font-size:var(--text-sm); color:var(--color-grade-a);">✓ No significant problems found across the validation layers.</div>';
    return;
  }
  wrap.style.display = '';
  list.innerHTML = '';
  top.forEach((p, i) => {
    const color = p.status === 'fail' ? 'var(--color-grade-d)' : 'var(--color-grade-c)';
    const row = el('div', { style: 'display:flex; align-items:flex-start; gap:var(--space-2); padding:6px 0; border-top:1px solid var(--color-divider); cursor:pointer;', 'data-testid': `top-problem-${p.id}` }, [
      el('span', { style: `margin-top:2px; width:12px; height:12px; border-radius:3px; flex:0 0 auto; background:${color};` }),
      el('div', {}, [
        el('div', { style: 'font-weight:600; font-size:var(--text-sm);' }, `${i + 1}. ${p.name}`),
        el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, p.summary),
      ]),
    ]);
    row.addEventListener('click', () => {
      const card = document.querySelector(`[data-testid="card-validation-${p.id}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    list.appendChild(row);
  });
}

// Data Health Dashboard: CAT scorecard + Golden Signals + materiality slider
// + optional per-entity baselines.
let __materialityIssues = null;
async function renderDataHealth(ds, results) {
  const wrap = $('#data-health-wrap');
  wrap.style.display = '';

  // CAT scorecard (CDC Data Quality Framework) — now under Advanced/Legacy.
  // Computed and populated BEFORE the calibrated grades below so that the two
  // async steps complete in a deterministic order: renderCalibratedGrades is the
  // signal consumers (and the e2e smoke test) synchronize on, and it must not
  // appear until the awaited CAT queries have finished filling #cat-scorecard —
  // otherwise the scorecard reads as empty in the brief window between them.
  const cat = await catScorecard.computeCATScore(ds, results).catch(() => null);
  const catEl = $('#cat-scorecard');
  catEl.innerHTML = '';
  if (cat) {
    const gradeColor = g => ({ A: 'var(--color-grade-a)', B: 'var(--color-grade-b)', C: 'var(--color-grade-c)', D: 'var(--color-grade-d)', F: 'var(--color-grade-d)' }[g] || 'var(--color-text-muted)');
    const cell = (name, g) => el('div', { style: 'text-align:center; min-width:80px;' }, [
      el('div', { style: `font-size:var(--text-2xl,28px); font-weight:700; color:${gradeColor(g.grade)};` }, g.grade),
      el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, name),
    ]);
    catEl.appendChild(cell('Overall', cat.overall));
    catEl.appendChild(cell('Completeness', cat.completeness));
    catEl.appendChild(cell('Accuracy', cat.accuracy));
    catEl.appendChild(cell('Timeliness', cat.timeliness));
  }

  // Confidence-Calibrated Grades (two honest, heuristic axes). The combined
  // Overall grade is the headline signal; the Integrity/Domain breakdown sits
  // one tap away. The legacy CAT scorecard + confidence ring are de-prioritised
  // under the Advanced/Legacy disclosure (see index.html). Hover each card for
  // the plain-English reason.
  renderCalibratedGrades(results && results.calibratedGrades);

  // Dataset Nutrition Label — scannable provenance/quality badges, each backed
  // by a REAL signal from the validation run. We also fingerprint this run (a
  // fast, tamper-evident SHA-256 content hash, NOT a signature/notarization) and
  // surface a "Fingerprinted" badge, tying the visual label to the crypto record.
  await renderNutritionLabel(ds, results).catch(() => {});

  // Golden Signals (Google SRE-inspired, mapped to data quality).
  const gs = await goldenSignals.computeGoldenSignals(ds, results).catch(() => null);
  const gsEl = $('#golden-signals');
  gsEl.innerHTML = '';
  if (gs) {
    const sig = (label, val) => el('div', { style: 'text-align:center; min-width:90px;' }, [
      el('div', { style: 'font-size:var(--text-lg); font-weight:600;' }, val),
      el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, label),
    ]);
    gsEl.appendChild(sig('Missingness', `${(gs.missingnessRate * 100).toFixed(1)}%`));
    gsEl.appendChild(sig('Out-of-range', `${(gs.outOfRangeRate * 100).toFixed(1)}%`));
    gsEl.appendChild(sig('Duplicates', `${(gs.duplicateRate * 100).toFixed(1)}%`));
    gsEl.appendChild(sig('Freshness', `${gs.freshnessHours.toFixed(1)}h`));
  }

  // Materiality slider — filters clean-issues by % of rows affected.
  __materialityIssues = await clean.scanForIssues(ds.table, ds.cols).catch(() => []);
  const slider = $('#materiality-slider');
  const updateMateriality = () => {
    const thr = parseFloat(slider.value);
    $('#materiality-value').textContent = thr.toFixed(1);
    const material = materiality.filterByMateriality(__materialityIssues, thr, ds.rowCount);
    $('#materiality-note').textContent =
      `${material.length} of ${__materialityIssues.length} detected issue(s) affect at least ${thr.toFixed(1)}% of rows (material). Issues below this threshold are treated as noise (PCAOB AS 2305).`;
  };
  slider.oninput = updateMateriality;
  updateMateriality();

  // Per-entity baselines (UEBA) if an ID-like + numeric column pair exists.
  await renderEntityBaselines(ds);
}

// Dataset Nutrition Label + Analysis Fingerprint for the current validation run.
// Lazy-imports the two pure provenance modules (no top-level cost when the tab is
// never opened) and renders a small, idempotent badge strip above the calibrated
// grades. Every badge here is earned from a real signal; the fingerprint commits
// to the validation result plus the inputs that produced it.
async function renderNutritionLabel(ds, results) {
  const [{ computeAnalysisFingerprint }, { computeBadges }] = await Promise.all([
    import('../provenance/analysis-fingerprint.js'),
    import('../provenance/nutrition-badges.js'),
  ]);

  // Canonical, stable representation of the validation result the fingerprint
  // commits to: row count, the calibrated grades, and each layer's status.
  const layerStatuses = {};
  if (results) {
    for (const id of Object.keys(results).sort()) {
      const r = results[id];
      if (r && typeof r === 'object' && typeof r.status === 'string') layerStatuses[id] = r.status;
    }
  }
  const grades = results && results.calibratedGrades
    ? {
        integrity: results.calibratedGrades.integrity && results.calibratedGrades.integrity.grade,
        plausibility: results.calibratedGrades.plausibility && results.calibratedGrades.plausibility.grade,
        overall: results.calibratedGrades.overall && results.calibratedGrades.overall.grade,
      }
    : null;

  const chain = ds ? provenance.getProvenance(ds.table) : null;
  const trail = chain ? chain.getTrail() : [];
  const datasetProvenanceHash = trail.length ? trail[trail.length - 1].hash : null;
  // Commit to how many metrics the session has defined (a real, reproducible
  // marker of registry state) so the fingerprint moves if the semantic layer did.
  const registry = getActiveMetricsRegistry();
  const metricsRegistryVersion = registry ? registry.listMetrics().length : null;

  let fingerprint = null;
  try {
    fingerprint = await computeAnalysisFingerprint(
      {
        resultData: { rowCount: ds ? ds.rowCount : null, grades, layerStatuses },
        sqlOrPipelineDescription: 'DATAGLOW validation run (all layers)',
        parameters: { table: ds ? ds.table : null },
        metricsRegistryVersion,
        datasetProvenanceHash,
      },
      { label: 'validation-run' }
    );
  } catch { fingerprint = null; }

  const badges = computeBadges({
    results,
    rowCount: ds ? ds.rowCount : undefined,
    fingerprint,
  });

  // Idempotent container, inserted once directly above the calibrated grades.
  let host = $('#nutrition-label');
  if (!host) {
    host = el('div', { id: 'nutrition-label', 'data-testid': 'nutrition-label', style: 'margin:var(--space-3) 0;' });
    const gradesBox = $('#calibrated-grades');
    const headline = $('#overall-headline');
    const anchor = headline || gradesBox;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor);
    else $('#data-health-wrap').appendChild(host);
  }
  host.innerHTML = '';
  if (!badges.length) { host.style.display = 'none'; return; }
  host.style.display = '';

  host.appendChild(el('div', {
    style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:var(--space-1); font-weight:600;',
  }, 'Dataset nutrition label'));
  const strip = el('div', { style: 'display:flex; flex-wrap:wrap; gap:var(--space-2);' });
  for (const b of badges) {
    strip.appendChild(el('span', {
      'data-testid': `nutrition-badge-${b.id}`,
      title: b.meaning,
      style: 'display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border:1px solid var(--color-divider); border-radius:999px; font-size:var(--text-xs); background:var(--color-surface-offset,transparent); cursor:help;',
    }, [
      el('span', { 'aria-hidden': 'true', style: 'font-size:var(--text-sm);' }, b.glyph),
      el('span', {}, b.label),
    ]));
  }
  host.appendChild(strip);
}

// Render the two-axis Confidence-Calibrated Grades with an explicit visual
// hierarchy so the three coexisting quality surfaces stop competing:
//   1. the combined "Overall" grade is the headline, single-glance signal;
//   2. the Data Integrity (mechanical well-formedness) and Domain Confidence
//      (real-world plausibility) breakdown sits one tap away, explaining the why.
// The legacy confidence ring and CAT scorecard live under the Advanced/Legacy
// disclosure in index.html. All axes are explicitly heuristics (labelled), not
// legal/clinical determinations.
function renderCalibratedGrades(cg) {
  const box = $('#calibrated-grades');
  const headline = $('#overall-headline');
  if (!box) return;
  if (!cg) {
    box.style.display = 'none'; box.innerHTML = '';
    if (headline) { headline.style.display = 'none'; headline.innerHTML = ''; }
    return;
  }
  const gradeColor = g => ({ A: 'var(--color-grade-a)', B: 'var(--color-grade-b)', C: 'var(--color-grade-c)', D: 'var(--color-grade-d)', F: 'var(--color-grade-d)' }[g] || 'var(--color-text-muted)');

  // PRIMARY: the Overall combined grade, rendered large as THE headline number.
  if (headline) {
    headline.innerHTML = '';
    if (cg.overall) {
      headline.appendChild(el('div', {
        style: 'display:flex; align-items:center; gap:var(--space-4); padding:var(--space-4) var(--space-5); border:1px solid var(--color-divider); border-radius:var(--radius-lg); background:var(--color-surface-offset,transparent); cursor:help;',
        title: cg.overall.explanation,
        'data-testid': 'grade-overall',
      }, [
        el('div', { style: `font-size:var(--text-4xl,56px); line-height:1; font-weight:800; color:${gradeColor(cg.overall.grade)};`, 'data-testid': 'grade-overall-grade' }, cg.overall.grade),
        el('div', {}, [
          el('div', { style: 'font-size:var(--text-lg); font-weight:700;' }, 'Overall Data Quality'),
          el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-top:2px;' }, cg.overall.explanation || 'Combined Integrity & Domain Confidence grade.'),
        ]),
      ]));
      headline.style.display = '';
    } else {
      headline.style.display = 'none';
    }
  }

  // SECONDARY: the two-axis breakdown behind the Overall grade.
  const card = (title, subtitle, axis, testid) => el('div', {
    style: 'flex:1; min-width:240px; padding:var(--space-4); border:1px solid var(--color-divider); border-radius:var(--radius-lg); cursor:help;',
    title: axis.explanation,
    'data-testid': testid,
  }, [
    el('div', { style: 'display:flex; align-items:baseline; gap:var(--space-3);' }, [
      el('div', { style: `font-size:var(--text-2xl,28px); font-weight:700; color:${gradeColor(axis.grade)};`, 'data-testid': `${testid}-grade` }, axis.grade),
      el('div', { style: 'font-weight:600;' }, title),
    ]),
    el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-top:var(--space-1); font-weight:500;' }, subtitle),
    el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint,var(--color-text-muted)); margin-top:var(--space-2);' }, axis.explanation),
  ]);
  box.innerHTML = '';
  box.appendChild(card(
    'Data Integrity',
    'How internally consistent and well-formed this data is.',
    cg.integrity, 'grade-integrity'));
  box.appendChild(card(
    'Domain Confidence',
    'How plausible this data is given real-world domain knowledge.',
    cg.plausibility, 'grade-plausibility'));
  box.style.display = 'flex';
}

async function renderEntityBaselines(ds) {
  const wrap = $('#entity-baseline-wrap');
  const list = $('#entity-baseline-list');
  const entityCol = ds.cols.find(c => c.type === 'VARCHAR' && /vendor|customer|account|entity|user|company|supplier|merchant|id|name/i.test(c.name));
  const valueCol = ds.cols.find(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type) && /amount|value|price|cost|total|revenue|salary|invoice|balance/i.test(c.name));
  if (!entityCol || !valueCol) { wrap.style.display = 'none'; return; }
  const baselines = await entityBaseline.computeEntityBaselines(ds.table, entityCol.name, valueCol.name, engine).catch(() => null);
  if (!baselines) { wrap.style.display = 'none'; return; }
  const flags = await entityBaseline.flagEntityDeviations(ds.table, entityCol.name, valueCol.name, baselines, engine).catch(() => []);
  if (!flags.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';
  list.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-bottom:var(--space-2);' },
    `Comparing "${valueCol.name}" against each "${entityCol.name}"'s own baseline.`));
  flags.slice(0, 15).forEach(f => {
    list.appendChild(el('div', { style: 'font-size:var(--text-sm); padding:4px 0; border-top:1px solid var(--color-divider);' }, [
      el('span', { style: 'font-weight:600;' }, `${f.entity}: `),
      el('span', {}, f.reason),
    ]));
  });
}

// Multivariate Outliers: diagonal-Mahalanobis (ondevice-ml) + Isolation Forest.
async function renderMultivariate(ds) {
  const wrap = $('#multivariate-wrap');
  const list = $('#multivariate-list');
  const numericCols = ds.cols.filter(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type));
  if (numericCols.length < 2) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';

  const maha = await ondeviceML.scoreMultivariateAnomalies(ds.table, numericCols, engine).catch(() => null);
  const iforest = await scoreIsolationForest(ds.table, numericCols, engine).catch(() => null);

  // Peer-group column for the on-device Anomaly Explainer: first low-cardinality
  // categorical (VARCHAR) column, so contributions read relative to a real peer
  // set (e.g. Geography) rather than the whole table.
  const groupColumn = await ondeviceML.pickPeerGroupColumn(ds.table, ds.cols, engine, { rowCount: ds.rowCount });

  const section = (title, cite, res) => {
    const block = el('div', { style: 'margin-bottom:var(--space-4);' });
    block.appendChild(el('div', { style: 'font-weight:600; font-size:var(--text-sm); margin-bottom:2px;' }, title));
    block.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-bottom:var(--space-2);' }, cite));
    if (!res || !res.rows || !res.rows.length) {
      block.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted);' }, 'No rows scored.'));
      return block;
    }
    const anomalies = res.rows.filter(r => r.isAnomaly);
    block.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-bottom:var(--space-2);' },
      `${anomalies.length} row(s) flagged as anomalous (top ${Math.min(5, res.rows.length)} shown by score).`));
    res.rows.slice(0, 5).forEach(r => {
      const color = r.isAnomaly ? 'var(--color-grade-d)' : 'var(--color-text-muted)';
      const rowEl = el('div', { style: 'font-size:var(--text-xs); padding:3px 0; border-top:1px solid var(--color-divider); display:flex; gap:var(--space-2); align-items:center;' }, [
        el('span', { style: `font-weight:600; color:${color};` }, `#${r.rowIndex} · ${r.anomalyScore}`),
        el('span', { class: 'mono', style: 'color:var(--color-text-muted); overflow:hidden; text-overflow:ellipsis; flex:1;' }, Object.entries(r.values).map(([k, v]) => `${k}=${v}`).join(', ')),
      ]);
      // On-Device Anomaly Explainer (Feature 4): explain WHY this row is flagged.
      const explainBtn = el('button', { class: 'btn', style: 'font-size:11px; padding:2px 8px; flex:none;', 'data-testid': `explain-anomaly-${r.rowIndex}` }, 'Explain');
      const reasonEl = el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin:2px 0 4px var(--space-3);' });
      explainBtn.addEventListener('click', async () => {
        explainBtn.disabled = true;
        try {
          const ex = await ondeviceML.explainAnomaly(ds.table, numericCols, r.rowIndex, engine, groupColumn ? { groupColumn } : {});
          reasonEl.setAttribute('data-testid', `anomaly-reason-${r.rowIndex}`);
          reasonEl.textContent = ex.reason;
        } catch (e) {
          reasonEl.textContent = 'Could not explain: ' + e.message;
        }
      });
      rowEl.appendChild(explainBtn);
      block.appendChild(rowEl);
      block.appendChild(reasonEl);
    });
    return block;
  };

  list.appendChild(section('Mahalanobis (diagonal approximation)', 'Mahalanobis (1936) — standardized distance from the centroid.', maha));
  list.appendChild(section('Isolation Forest', 'Liu, Ting & Zhou (2008) — anomalies isolate in shorter tree paths.', iforest));
}

// Predictive Anomaly Scoring: holistic kNN/Gower outlier score over mixed
// numeric + categorical features. Distinct from the numeric-only Multivariate
// Outliers panel and deliberately NOT one of the 20 layers.
async function renderPredictiveAnomaly(ds) {
  const wrap = $('#predictive-anomaly-wrap');
  const list = $('#predictive-anomaly-list');
  if (!wrap || !list) return;
  const usableCols = ds.cols.filter(c =>
    ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type) ||
    !/\b(TIMESTAMP|DATE|TIME)\b/i.test(c.type)
  );
  if (usableCols.length < 2) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';

  const res = await scorePredictiveAnomalies(ds.table, ds.cols, engine, { rowCount: ds.rowCount }).catch(() => null);
  if (!res || !res.rows || !res.rows.length) {
    list.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted);' },
      (res && res.note) ? res.note : 'Not enough usable features or rows to score holistic anomalies.'));
    return;
  }

  // Unified Signal Layer: ensure the ranker's learned verdicts are published, then
  // let the scorer read them and suppress rows whose dominant column the user has
  // repeatedly dismissed as a false positive — instead of showing a contradictory
  // duplicate warning. Purely additive: with no matching verdict, rows are unchanged.
  publishRankerVerdicts(ds.cols);
  suppressAnomaliesWithVerdicts(res, signalStore);

  const feats = [...res.features.numeric, ...res.features.categorical];
  list.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-bottom:var(--space-2);' },
    `Scored on ${feats.length} feature(s): ${feats.join(', ')}. k=${res.k} nearest neighbours.`));

  if (res.sampling && res.sampling.sampled) {
    list.appendChild(el('div', { 'data-testid': 'predictive-anomaly-sampling', style: 'font-size:var(--text-xs); color:var(--color-grade-c); margin-bottom:var(--space-2);' },
      `Dataset has ${res.sampling.totalRows.toLocaleString()} rows; scoring a uniform random sample of ${res.sampling.usedRows.toLocaleString()} for performance. Unsampled rows are not scored.`));
  }

  const anomalies = res.rows.filter(r => r.isAnomaly);
  const suppressed = res.rows.filter(r => r.suppressed);
  const suppressNote = suppressed.length
    ? ` ${suppressed.length} flag(s) suppressed by the self-learning ranker (shown de-ranked below).`
    : '';
  list.appendChild(el('div', { 'data-testid': 'predictive-anomaly-summary', style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-bottom:var(--space-3);' },
    `${anomalies.length} row(s) flagged as holistically anomalous (mean+3σ of the kNN distance).${suppressNote} Top ${Math.min(5, res.rows.length)} by score shown.`));

  // De-rank suppressed rows so genuine flags surface first, then by raw score.
  const display = [...res.rows].sort((a, b) =>
    (a.suppressed ? 1 : 0) - (b.suppressed ? 1 : 0) || b.rawScore - a.rawScore);

  display.slice(0, 5).forEach(r => {
    const color = r.suppressed ? 'var(--color-text-faint)' : r.isAnomaly ? 'var(--color-grade-d)' : 'var(--color-text-muted)';
    const card = el('div', { 'data-testid': `predictive-anomaly-row-${r.rowIndex}`, style: `padding:var(--space-2) 0; border-top:1px solid var(--color-divider);${r.suppressed ? ' opacity:0.7;' : ''}` });
    const head = el('div', { style: 'display:flex; gap:var(--space-2); align-items:center;' }, [
      el('span', { style: `font-weight:600; color:${color};${r.suppressed ? ' text-decoration:line-through;' : ''}` }, `#${r.rowIndex} · score ${r.score}`),
      el('span', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted); overflow:hidden; text-overflow:ellipsis; flex:1;' },
        Object.entries(r.values).map(([k, v]) => `${k}=${v}`).join(', ')),
    ]);
    if (r.suppressed) head.appendChild(el('span', {
      'data-testid': `predictive-anomaly-suppressed-${r.rowIndex}`,
      style: 'font-size:11px; font-weight:600; padding:2px 8px; border-radius:8px; color:#fff; background:var(--color-text-faint);',
    }, 'SUPPRESSED'));
    card.appendChild(head);
    card.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:2px;' }, r.reason));
    list.appendChild(card);
  });
}

// SPC control charts + Cpk badge per numeric column, rendered as inline SVG.
async function renderSPC(ds) {
  const wrap = $('#spc-wrap');
  const list = $('#spc-list');
  const analyses = await spc.analyzeAllNumericSPC(ds.table, ds.cols, engine).catch(() => []);
  if (!analyses.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';
  for (const a of analyses) {
    const card = el('div', { class: 'card', style: 'padding:var(--space-3); margin-bottom:var(--space-3);', 'data-testid': `spc-${a.column}` });
    const cpkText = a.cpk.cpk == null ? 'n/a' : a.cpk.cpk.toString();
    const cpkColor = a.cpk.cpk == null ? 'var(--color-text-muted)' : a.cpk.cpk >= 1.33 ? 'var(--color-grade-a)' : a.cpk.cpk >= 1.0 ? 'var(--color-grade-c)' : 'var(--color-grade-d)';
    card.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); margin-bottom:var(--space-2);' }, [
      el('span', { style: 'font-weight:600;' }, `"${a.column}"`),
      el('span', { style: `font-size:11px; padding:1px 6px; border-radius:8px; background:${cpkColor}; color:#fff;`, title: a.cpk.inferredSpec ? 'Spec limits inferred from data spread' : 'From supplied spec limits' }, `Cpk ${cpkText}`),
      el('span', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, `${a.outOfControl} point(s) out of control · n=${a.limits.n}`),
    ]));
    card.appendChild(el('div', { html: spcSvg(a) }));
    list.appendChild(card);
  }
}

// Minimal inline SVG control chart (no chart dependency).
function spcSvg(a) {
  const w = 640, h = 140, pad = 4;
  const vals = a.values;
  const { mean, ucl, lcl } = a.limits;
  const lo = Math.min(lcl, ...vals), hi = Math.max(ucl, ...vals);
  const span = (hi - lo) || 1;
  const x = i => pad + (i / Math.max(1, vals.length - 1)) * (w - 2 * pad);
  const y = v => h - pad - ((v - lo) / span) * (h - 2 * pad);
  const line = (yv, color, dash) => `<line x1="${pad}" y1="${y(yv).toFixed(1)}" x2="${w - pad}" y2="${y(yv).toFixed(1)}" stroke="${color}" stroke-width="1" ${dash ? 'stroke-dasharray="4 3"' : ''}/>`;
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const dots = vals.map((v, i) => {
    const out = v > ucl || v < lcl;
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${out ? 3 : 1.8}" fill="${out ? 'var(--color-grade-d)' : 'var(--color-accent, #FF6B6B)'}"/>`;
  }).join('');
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="background:var(--color-surface-offset); border-radius:var(--radius-sm);">
    ${line(ucl, 'var(--color-grade-d)', true)}
    ${line(mean, 'var(--color-text-muted)', false)}
    ${line(lcl, 'var(--color-grade-d)', true)}
    <polyline points="${pts}" fill="none" stroke="var(--color-accent, #FF6B6B)" stroke-width="1.2"/>
    ${dots}
  </svg>`;
}

// Persist a small column profile per validation run (local memory only).
async function persistColumnProfiles(ds, results) {
  try {
    await memoryStore.initMemoryStore();
    for (const c of ds.cols) {
      await memoryStore.saveColumnProfile({
        columnNameHash: `${ds.table}::${c.name}`,
        table: ds.table,
        column: c.name,
        type: c.type,
        rowCount: ds.rowCount,
      });
    }
    await refreshMemoryPanel();
  } catch (e) { /* IndexedDB unavailable — non-fatal */ }
}

// ============================================================
// Local Memory Panel (Settings)
// ============================================================
async function refreshMemoryPanel() {
  const statsEl = $('#memory-stats');
  if (!statsEl) return;
  try {
    await memoryStore.initMemoryStore();
    const rules = await memoryStore.getApprovedRules();
    statsEl.textContent = `${rules.length} approved rule(s) stored locally.`;
  } catch (e) {
    statsEl.textContent = 'Local memory unavailable in this browser.';
  }
}

// Consent for cross-session fingerprint persistence is a single boolean UI
// preference (not user data), so it lives in localStorage; the fingerprints
// themselves stay in IndexedDB (js/memory-store.js).
const FP_CONSENT_KEY = 'dataglow_persist_fingerprints';

async function refreshFingerprintStats() {
  const el = $('#fingerprint-stats');
  if (el) {
    if (!state.settings.persistFingerprints) {
      el.textContent = 'Persistence off — fingerprints are compared only within the current session.';
    } else {
      try {
        const n = await memoryStore.countBaselines();
        el.textContent = `${n} schema fingerprint(s) stored locally on this device.`;
      } catch (e) {
        el.textContent = 'Local storage unavailable in this browser.';
      }
    }
  }
  await refreshDriftForecastStats();
}

// Trend-history summary for the Forecast-Based Drift Alerting control.
async function refreshDriftForecastStats() {
  const el = $('#drift-forecast-stats');
  if (!el) return;
  if (!state.settings.persistFingerprints) {
    el.textContent = `Trend history off — enable persistence to build the ${driftForecast.MIN_FORECAST_HISTORY}-upload history that unlocks trend-aware alerts.`;
    return;
  }
  try {
    const { schemas, points } = await memoryStore.fingerprintHistoryStats();
    el.textContent = schemas
      ? `${points} fingerprint(s) tracked across ${schemas} schema(s) for trend forecasting (need ${driftForecast.MIN_FORECAST_HISTORY} per schema to activate).`
      : `No trend history yet — re-upload the same schema ${driftForecast.MIN_FORECAST_HISTORY}+ times to activate forecast alerts.`;
  } catch (e) {
    el.textContent = 'Local storage unavailable in this browser.';
  }
}

function initMemory() {
  memoryStore.initMemoryStore().then(refreshMemoryPanel).catch(() => {
    const el0 = $('#memory-stats');
    if (el0) el0.textContent = 'Local memory unavailable in this browser.';
  });
  $('#btn-memory-clear').addEventListener('click', async () => {
    if (!confirm('Clear all locally stored column profiles, baselines, and approved rules? This cannot be undone.')) return;
    try {
      const rules = await memoryStore.getApprovedRules();
      for (const r of rules) await memoryStore.deleteApprovedRule(r.ruleName);
      // Column profiles/baselines: drop the whole database for a clean slate.
      if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase('dataglow_memory');
      toast('Local memory cleared', 'success');
      $('#memory-stats').textContent = '0 approved rule(s) stored locally.';
      refreshFingerprintStats();
    } catch (e) {
      toast('Clear failed: ' + e.message, 'error');
    }
  });

  // ---- Distribution Fingerprint Drift: opt-in persistence ----
  const toggle = $('#toggle-persist-fingerprints');
  if (toggle) {
    state.settings.persistFingerprints = localStorage.getItem(FP_CONSENT_KEY) === '1';
    toggle.checked = state.settings.persistFingerprints;
    toggle.addEventListener('change', () => {
      state.settings.persistFingerprints = toggle.checked;
      localStorage.setItem(FP_CONSENT_KEY, toggle.checked ? '1' : '0');
      toast(toggle.checked
        ? 'Fingerprint persistence enabled — only summary stats are stored locally.'
        : 'Fingerprint persistence disabled.', 'success');
      refreshFingerprintStats();
    });
  }
  $('#btn-clear-fingerprints').addEventListener('click', async () => {
    if (!confirm('Clear all stored distribution fingerprints from this device? This cannot be undone.')) return;
    try {
      await memoryStore.clearBaselines();
      toast('Stored fingerprints cleared', 'success');
    } catch (e) {
      toast('Clear failed: ' + e.message, 'error');
    }
    refreshFingerprintStats();
  });
  const clearHistoryBtn = $('#btn-clear-drift-history');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', async () => {
      if (!confirm('Clear the tracked drift history used for trend-aware forecast alerts? This cannot be undone.')) return;
      try {
        await memoryStore.clearFingerprintHistory();
        toast('Drift history cleared', 'success');
      } catch (e) {
        toast('Clear failed: ' + e.message, 'error');
      }
      refreshDriftForecastStats();
    });
  }
  refreshFingerprintStats();
}

// ============================================================
// Self-Learning Validation Rules
// A single on-device logistic-regression model that personalizes flag ranking
// to THIS user's own correction patterns. Per-session learning is always on
// (RAM only, wiped on reload); cross-session persistence to IndexedDB is a
// separate opt-in. See js/self-learning-rules.js for the model + technique.
// ============================================================
const SL_CONSENT_KEY = 'dataglow_persist_learned_corrections';
const SL_MODEL_ID = 'default';
let selfLearner = new SelfLearningModel();

// Adaptive Layer Prioritization — learns which layers catch real issues for this
// user and reorders/highlights the Validate grid accordingly. Shares PR #25's
// accept/dismiss signal stream (recordLearningSignal below feeds both models).
const LP_CONSENT_KEY = 'dataglow_persist_layer_priority';
const LP_MODEL_ID = 'layer_priority';
let layerPriority = new LayerPriorityModel();

// Unified Signal Layer — a synchronous, in-memory scratch pad the on-device
// modules read/write BEFORE anything is rendered, so they can suppress duplicate
// warnings and enrich each other's output instead of operating in silos. It
// holds no user data of its own and never persists; it is repopulated per run.
// See js/signal-store.js. Exposed on window for e2e inspection.
const signalStore = new SignalStore();
if (typeof window !== 'undefined') window.__dataglowSignalStore = signalStore;

// Recompute and (re)publish the self-learning ranker's per-column verdicts into
// the shared store. Called before the anomaly scorer and drift alerter render,
// so those modules can see "the user has repeatedly dismissed flags on column X".
// Idempotent: it first drops the ranker's previous verdicts, then republishes —
// leaving other producers' signals (e.g. rule changes) intact.
function publishRankerVerdicts(cols) {
  signalStore.clear(s => s.module === 'self_learning' && s.type === SIGNAL_TYPES.LEARNED_VERDICT);
  if (!state.settings.selfLearningEnabled || !Array.isArray(cols)) return;
  for (const c of cols) {
    const column = c && (c.name != null ? c.name : c);
    if (column == null) continue;
    let v;
    try { v = selfLearner.columnVerdict(column); } catch { v = null; }
    if (!v || !v.verdict) continue;
    signalStore.register({
      module: 'self_learning',
      type: SIGNAL_TYPES.LEARNED_VERDICT,
      column,
      verdict: v.verdict === 'dismiss' ? VERDICTS.DISMISS : VERDICTS.ACCEPT,
      confidence: v.confidence,
      meta: { dismiss: v.dismiss, accept: v.accept, total: v.total },
    });
  }
}

// Record a user correction as a labeled training example, then (if opted in)
// persist the updated model. Never blocks the correction it is observing —
// any failure is swallowed so learning can't break a real edit/merge/dismiss.
async function recordLearningSignal(snapshot, action) {
  // One accept/dismiss interaction feeds BOTH on-device learners: the
  // Self-Learning per-flag ranker (PR #25) and the Adaptive Layer Prioritizer.
  // A single tracking pathway, two lightweight consumers.
  await recordSelfLearningSignal(snapshot, action);
  await recordLayerPrioritySignal(snapshot, action);
  await recordFederatedSignal(snapshot, action);
  publishRuleChangeSignal(snapshot, action);
}

// When the user dismisses/rejects a validation flag on a column, record it in the
// Unified Signal Layer as a "rule change" so the drift alerter can later connect
// an otherwise-unexplained drift warning on that same column to this action.
function publishRuleChangeSignal(snapshot, action) {
  try {
    if (actionToLabel(action) !== 0) return; // only dismissals signal a rule change
    const column = snapshot && snapshot.column;
    if (column == null) return;
    signalStore.register({
      module: 'self_learning',
      type: SIGNAL_TYPES.RULE_CHANGE,
      column,
      meta: { source: snapshot.source || null, action: String(action) },
    });
  } catch (e) { /* coordination is best-effort; never disrupt the user's action */ }
}

async function recordSelfLearningSignal(snapshot, action) {
  if (!state.settings.selfLearningEnabled) return;
  try {
    const ex = selfLearner.record(snapshot, action);
    if (!ex) return; // ambiguous action — no signal
    if (state.settings.persistLearnedCorrections) {
      await memoryStore.saveLearnedModel(SL_MODEL_ID, selfLearner.toJSON());
    }
    refreshSelfLearningStats();
    // Re-highlight the currently shown validation results with the new knowledge.
    if (window.__dataglowLastValidation) applySelfLearningHighlights();
  } catch (e) { /* learning is best-effort; never disrupt the user's action */ }
}

// The interactive flag sources map 1:1 onto validation layer ids, so snapshot.source
// IS the layer id for prioritization purposes.
async function recordLayerPrioritySignal(snapshot, action) {
  if (!state.settings.adaptivePriorityEnabled) return;
  try {
    const layerId = snapshot && snapshot.source;
    const rec = layerPriority.recordAction(layerId, action);
    if (!rec) return; // ambiguous action or no layer id — no signal
    if (state.settings.persistLayerPriority) {
      await memoryStore.saveLearnedModel(LP_MODEL_ID, layerPriority.toJSON());
    }
    refreshLayerPriorityStats();
    // Re-render so the new ordering/badges take effect immediately.
    if (window.__dataglowLastValidation) applySelfLearningHighlights();
  } catch (e) { /* prioritization is best-effort; never disrupt the user's action */ }
}

// Add a small "likely relevant / likely dismiss" badge + plain-language reason
// to an actionable flag row, IF the model is ready. Pure ranking aid — it never
// changes data or auto-applies anything. `snapshot` describes the flag.
function annotateWithPrediction(rowEl, snapshot) {
  if (!state.settings.selfLearningEnabled || !selfLearner.isReady()) return;
  try {
    const ex = selfLearner.explain(snapshot);
    const relevant = ex.prediction === 'likely-relevant';
    const badge = el('span', {
      class: 'self-learning-badge',
      'data-testid': `self-learning-badge-${snapshot.source}-${snapshot.column || 'na'}`,
      title: ex.reason,
      style: `font-size:11px; font-weight:600; padding:2px 8px; border-radius:8px; color:#fff; background:${relevant ? 'var(--color-grade-d)' : 'var(--color-text-faint)'};`,
    }, relevant ? `★ Likely relevant (${Math.round(ex.probability * 100)}%)` : `Likely dismiss (${Math.round(ex.probability * 100)}%)`);
    const note = el('div', {
      style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-top:2px; font-style:italic;',
    }, `Personalized: ${ex.reason}`);
    rowEl.appendChild(badge);
    rowEl.appendChild(note);
  } catch (e) { /* non-fatal */ }
}

// Re-render highlights over the last validation results by re-running the
// validate render (cheap; results are cached). Kept indirect so both the toggle
// and each new correction can refresh the view.
function applySelfLearningHighlights() {
  if (window.__dataglowLastValidation) renderValidationResults(window.__dataglowLastValidation);
}

function refreshSelfLearningStats() {
  const statsEl = $('#self-learning-stats');
  if (!statsEl) return;
  if (!state.settings.selfLearningEnabled) {
    statsEl.textContent = 'Self-learning is off — no corrections are being recorded.';
    return;
  }
  const n = selfLearner.count;
  if (selfLearner.isReady()) {
    statsEl.textContent = `Learning from ${n} of your correction${n === 1 ? '' : 's'} this ${state.settings.persistLearnedCorrections ? 'device' : 'session'} — personalized ranking is active.`;
  } else {
    statsEl.textContent = `Learning from ${n} correction${n === 1 ? '' : 's'} so far. ${selfLearner.examplesUntilReady()} more needed before personalized ranking turns on (minimum ${MIN_EXAMPLES}).`;
  }
}

function initSelfLearning() {
  const enableToggle = $('#toggle-self-learning');
  if (enableToggle) {
    enableToggle.checked = state.settings.selfLearningEnabled;
    enableToggle.addEventListener('change', () => {
      state.settings.selfLearningEnabled = enableToggle.checked;
      toast(enableToggle.checked ? 'Self-learning enabled for this session.' : 'Self-learning turned off.', 'success');
      refreshSelfLearningStats();
      applySelfLearningHighlights();
    });
  }

  const persistToggle = $('#toggle-persist-learning');
  if (persistToggle) {
    state.settings.persistLearnedCorrections = localStorage.getItem(SL_CONSENT_KEY) === '1';
    persistToggle.checked = state.settings.persistLearnedCorrections;
    persistToggle.addEventListener('change', async () => {
      state.settings.persistLearnedCorrections = persistToggle.checked;
      localStorage.setItem(SL_CONSENT_KEY, persistToggle.checked ? '1' : '0');
      try {
        if (persistToggle.checked) {
          // Turning persistence ON: save whatever we've learned this session so
          // far, so nothing is silently lost, and merge in any prior device model.
          const prior = await memoryStore.getLearnedModel(SL_MODEL_ID);
          if (prior && selfLearner.count === 0) selfLearner = SelfLearningModel.fromJSON(prior);
          await memoryStore.saveLearnedModel(SL_MODEL_ID, selfLearner.toJSON());
        }
      } catch (e) { /* IndexedDB unavailable — non-fatal */ }
      toast(persistToggle.checked
        ? 'Learned corrections will be remembered on this device (stored locally only).'
        : 'Cross-session learning disabled — corrections stay in this session only.', 'success');
      refreshSelfLearningStats();
    });
  }

  const clearBtn = $('#btn-clear-learning');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Clear all learned corrections from this browser? DATAGLOW will forget your personalization and start from zero.')) return;
      selfLearner = new SelfLearningModel();
      try { await memoryStore.clearLearnedModels(); } catch (e) { /* non-fatal */ }
      toast('Learned corrections cleared', 'success');
      refreshSelfLearningStats();
      applySelfLearningHighlights();
    });
  }

  // Load a persisted model if the user has previously opted in.
  (async () => {
    try {
      if (state.settings.persistLearnedCorrections) {
        const prior = await memoryStore.getLearnedModel(SL_MODEL_ID);
        if (prior) selfLearner = SelfLearningModel.fromJSON(prior);
      }
    } catch (e) { /* non-fatal */ }
    refreshSelfLearningStats();
  })();
}

// ============================================================
// Adaptive Layer Prioritization
// Reorders/highlights the Validate grid by how often each layer has caught a
// real issue for THIS user. Learns from the SAME accept/dismiss stream as the
// Self-Learning Rules feature. See js/adaptive-priority.js for the model +
// technique (Beta-Binomial confidence with exponential recency decay).
// ============================================================

// A layer counts as having "fired" when its result flagged something (warn/fail
// status, or it produced findings/clusters). Recorded once per validation run.
function recordLayerFires(results) {
  if (!state.settings.adaptivePriorityEnabled || !results) return;
  try {
    for (const layer of validation.LAYER_DEFS) {
      if (layer.id === 'confidence' || layer.id === 'red_team') continue;
      const r = results[layer.id];
      if (!r) continue;
      const fired = r.status === 'warn' || r.status === 'fail'
        || (Array.isArray(r.findings) && r.findings.length)
        || (Array.isArray(r.clusters) && r.clusters.length);
      if (fired) layerPriority.recordFire(layer.id);
    }
  } catch (e) { /* non-fatal */ }
}

// The prioritized ordering for the grid, or null when prioritization is off
// (renderValidationResults then falls back to the fixed registry order).
function getLayerPriorityView() {
  if (!state.settings.adaptivePriorityEnabled) return null;
  return layerPriority.prioritize(validation.LAYER_DEFS);
}

// A compact ▲/▼ badge for a layer's card head. Only shown once the model is
// ready and only for layers that have actually moved off neutral, to avoid noise.
function priorityBadgeFor(layerId) {
  if (!state.settings.adaptivePriorityEnabled || !layerPriority.isReady()) return null;
  const ex = layerPriority.explain(layerId);
  if (ex.tier === 'neutral') return null;
  const promoted = ex.tier === 'promoted';
  return el('span', {
    class: 'layer-priority-badge',
    'data-testid': `layer-priority-badge-${layerId}`,
    title: ex.reason,
    style: `font-size:11px; font-weight:600; padding:2px 8px; border-radius:8px; margin-left:auto; color:#fff; background:${promoted ? 'var(--color-grade-a)' : 'var(--color-text-faint)'};`,
  }, promoted ? `▲ Prioritized (${Math.round(ex.score * 100)}%)` : `▼ Deprioritized (${Math.round(ex.score * 100)}%)`);
}

// A one-line plain-language note under a moved layer explaining WHY it moved.
function priorityNoteFor(layerId) {
  if (!state.settings.adaptivePriorityEnabled || !layerPriority.isReady()) return null;
  const ex = layerPriority.explain(layerId);
  if (ex.tier === 'neutral') return null;
  return el('div', {
    'data-testid': `layer-priority-note-${layerId}`,
    style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-top:2px; font-style:italic;',
  }, `Learned ordering: ${ex.reason}`);
}

function refreshLayerPriorityStats() {
  const statsEl = $('#layer-priority-stats');
  if (!statsEl) return;
  if (!state.settings.adaptivePriorityEnabled) {
    statsEl.textContent = 'Adaptive prioritization is off — layers stay in their default order.';
    return;
  }
  const n = layerPriority.totalActions;
  if (layerPriority.isReady()) {
    statsEl.textContent = `Prioritizing from ${n} of your accept/dismiss action${n === 1 ? '' : 's'} this ${state.settings.persistLayerPriority ? 'device' : 'session'} — the most useful layers are surfaced first.`;
  } else {
    statsEl.textContent = `Watching ${n} action${n === 1 ? '' : 's'} so far. ${layerPriority.actionsUntilReady()} more needed before layers are reordered (minimum ${MIN_ACTIONS}). All layers stay in their default order until then.`;
  }
}

function initLayerPriority() {
  const enableToggle = $('#toggle-adaptive-priority');
  if (enableToggle) {
    enableToggle.checked = state.settings.adaptivePriorityEnabled;
    enableToggle.addEventListener('change', () => {
      state.settings.adaptivePriorityEnabled = enableToggle.checked;
      toast(enableToggle.checked ? 'Adaptive layer prioritization enabled for this session.' : 'Adaptive prioritization turned off — layers stay in default order.', 'success');
      refreshLayerPriorityStats();
      applySelfLearningHighlights();
    });
  }

  const persistToggle = $('#toggle-persist-priority');
  if (persistToggle) {
    state.settings.persistLayerPriority = localStorage.getItem(LP_CONSENT_KEY) === '1';
    persistToggle.checked = state.settings.persistLayerPriority;
    persistToggle.addEventListener('change', async () => {
      state.settings.persistLayerPriority = persistToggle.checked;
      localStorage.setItem(LP_CONSENT_KEY, persistToggle.checked ? '1' : '0');
      try {
        if (persistToggle.checked) {
          const prior = await memoryStore.getLearnedModel(LP_MODEL_ID);
          if (prior && layerPriority.totalActions === 0) layerPriority = LayerPriorityModel.fromJSON(prior);
          await memoryStore.saveLearnedModel(LP_MODEL_ID, layerPriority.toJSON());
        }
      } catch (e) { /* IndexedDB unavailable — non-fatal */ }
      toast(persistToggle.checked
        ? 'Learned prioritization will be remembered on this device (stored locally only).'
        : 'Cross-session prioritization disabled — it stays in this session only.', 'success');
      refreshLayerPriorityStats();
    });
  }

  const clearBtn = $('#btn-clear-priority');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Clear the learned layer prioritization from this browser? The Validate tab will go back to the default layer order.')) return;
      layerPriority = new LayerPriorityModel();
      try { await memoryStore.deleteLearnedModel(LP_MODEL_ID); } catch (e) { /* non-fatal */ }
      toast('Learned prioritization cleared', 'success');
      refreshLayerPriorityStats();
      applySelfLearningHighlights();
    });
  }

  (async () => {
    try {
      if (state.settings.persistLayerPriority) {
        const prior = await memoryStore.getLearnedModel(LP_MODEL_ID);
        if (prior) layerPriority = LayerPriorityModel.fromJSON(prior);
      }
    } catch (e) { /* non-fatal */ }
    refreshLayerPriorityStats();
  })();
}

// ============================================================
// Federated Fingerprint Learning (Phase 1, opt-in / OFF by default)
// A tiny on-device model, trained on the SAME accept/dismiss signal stream as the
// features above, whose privacy-protected weight updates can be averaged with
// other opted-in users over WebRTC (GitHub used only as an ephemeral peer phone
// book). Raw data never leaves the browser. See js/federated-learning.js and
// js/federated-transport.js for the model, privacy math, and transport.
// ============================================================
const FED_CONSENT_KEY = 'dataglow_persist_federated_model';
const FED_EPSILON_KEY = 'dataglow_federated_epsilon';
const FED_MODEL_ID = 'federated_fingerprint';
let federatedModel = new LocalFingerprintModel();
let federatedCoordinator = null;
const federatedReceipts = [];

// Feed one accept/dismiss interaction into the local federated model. Best-effort
// and gated on opt-in; never disrupts the user's actual correction.
async function recordFederatedSignal(snapshot, action) {
  if (!state.settings.federatedLearningEnabled) return;
  try {
    const label = actionToLabel(action);
    if (label == null) return; // ambiguous action — no signal
    federatedModel.recordSignal(snapshot && snapshot.source, label);
    if (state.settings.persistFederatedModel) {
      await memoryStore.saveLearnedModel(FED_MODEL_ID, federatedModel.toJSON());
    }
    refreshFederatedStats();
  } catch (e) { /* federated learning is best-effort; never disrupt the user */ }
}

// Lazily build the coordinator with real (best-effort) browser adapters. The
// GitHub signaling adapter reads the public coordination branch; WebRTC is used
// for the actual exchange. Both degrade to local-only behavior on any failure.
function ensureFederatedCoordinator() {
  if (federatedCoordinator) return federatedCoordinator;
  let signaling; let rtc;
  try {
    signaling = createGithubSignaling({ owner: 'Andre-Weissmann', repo: 'dataglow' });
    rtc = createWebRTCMesh({ signaling });
  } catch (e) { signaling = undefined; rtc = undefined; }
  federatedCoordinator = new FederatedCoordinator({
    model: federatedModel,
    signaling,
    rtc,
    minCohort: MIN_COHORT,
    epsilon: state.settings.federatedEpsilon || DEFAULT_EPSILON,
    onReceipt: (r) => { federatedReceipts.push(r); refreshFederatedStats(); },
  });
  return federatedCoordinator;
}

function refreshFederatedStats() {
  const statsEl = $('#federated-stats');
  if (!statsEl) return;
  if (!state.settings.federatedLearningEnabled) {
    statsEl.textContent = 'Federated learning is off — nothing is shared and no updates leave this browser.';
    return;
  }
  const n = federatedModel.totalSignals;
  const rounds = federatedModel.round;
  statsEl.textContent = `Learning locally from ${n} of your accept/dismiss signal${n === 1 ? '' : 's'} this ${state.settings.persistFederatedModel ? 'device' : 'session'}. `
    + `${rounds} federated round${rounds === 1 ? '' : 's'} applied (min cohort ${MIN_COHORT}, ε=${(state.settings.federatedEpsilon || DEFAULT_EPSILON).toFixed(1)}). `
    + 'Only masked, DP-noised weight updates are ever shared.';
}

function initFederatedLearning() {
  const enableToggle = $('#toggle-federated');
  if (enableToggle) {
    enableToggle.checked = state.settings.federatedLearningEnabled;
    enableToggle.addEventListener('change', () => {
      state.settings.federatedLearningEnabled = enableToggle.checked;
      if (enableToggle.checked) {
        ensureFederatedCoordinator().enable();
        toast('Federated learning enabled. Only masked, noised weight updates are shared — never your raw data.', 'success');
      } else {
        if (federatedCoordinator) federatedCoordinator.disable();
        toast('Federated learning turned off — back to purely local behavior.', 'success');
      }
      refreshFederatedStats();
    });
  }

  const persistToggle = $('#toggle-persist-federated');
  if (persistToggle) {
    state.settings.persistFederatedModel = localStorage.getItem(FED_CONSENT_KEY) === '1';
    persistToggle.checked = state.settings.persistFederatedModel;
    persistToggle.addEventListener('change', async () => {
      state.settings.persistFederatedModel = persistToggle.checked;
      localStorage.setItem(FED_CONSENT_KEY, persistToggle.checked ? '1' : '0');
      try {
        if (persistToggle.checked) {
          const prior = await memoryStore.getLearnedModel(FED_MODEL_ID);
          if (prior && federatedModel.totalSignals === 0) {
            federatedModel = LocalFingerprintModel.fromJSON(prior);
            if (federatedCoordinator) federatedCoordinator.model = federatedModel;
          }
          await memoryStore.saveLearnedModel(FED_MODEL_ID, federatedModel.toJSON());
        }
      } catch (e) { /* IndexedDB unavailable — non-fatal */ }
      toast(persistToggle.checked
        ? 'The shared model will be remembered on this device (stored locally only).'
        : 'Cross-session federated model disabled — it stays in this session only.', 'success');
      refreshFederatedStats();
    });
  }

  const slider = $('#federated-epsilon-slider');
  const valueEl = $('#federated-epsilon-value');
  if (slider) {
    const saved = parseFloat(localStorage.getItem(FED_EPSILON_KEY));
    if (Number.isFinite(saved)) { state.settings.federatedEpsilon = saved; slider.value = String(saved); }
    if (valueEl) valueEl.textContent = parseFloat(slider.value).toFixed(1);
    slider.addEventListener('input', () => {
      const eps = parseFloat(slider.value);
      state.settings.federatedEpsilon = eps;
      localStorage.setItem(FED_EPSILON_KEY, String(eps));
      if (valueEl) valueEl.textContent = eps.toFixed(1);
      if (federatedCoordinator) federatedCoordinator.setEpsilon(eps);
      refreshFederatedStats();
    });
  }

  const clearBtn = $('#btn-clear-federated');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Clear the locally cached federated model from this browser? DATAGLOW will start contributing from a fresh, neutral model.')) return;
      federatedModel = new LocalFingerprintModel();
      if (federatedCoordinator) federatedCoordinator.model = federatedModel;
      federatedReceipts.length = 0;
      try { await memoryStore.deleteLearnedModel(FED_MODEL_ID); } catch (e) { /* non-fatal */ }
      toast('Local federated model cleared', 'success');
      refreshFederatedStats();
    });
  }

  // Load a persisted model if the user previously opted in, and arm the
  // coordinator if the feature is enabled.
  (async () => {
    try {
      if (state.settings.persistFederatedModel) {
        const prior = await memoryStore.getLearnedModel(FED_MODEL_ID);
        if (prior) federatedModel = LocalFingerprintModel.fromJSON(prior);
      }
    } catch (e) { /* non-fatal */ }
    if (state.settings.federatedLearningEnabled) ensureFederatedCoordinator().enable();
    refreshFederatedStats();
  })();
}

// ============================================================
// Anonymized Export (Differential Privacy)
// ============================================================
function initAnonExport() {
  const slider = $('#anon-epsilon-slider');
  slider.addEventListener('input', () => { $('#anon-epsilon-value').textContent = parseFloat(slider.value).toFixed(1); });
  $('#btn-anon-export').addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    const epsilon = parseFloat(slider.value);
    const addNoise = $('#anon-noise-toggle').checked;
    const noteEl = $('#anon-note');
    try {
      const { columns, rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT 100000`);
      const numericCols = ds.cols.filter(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type)).map(c => c.name);
      const esc = v => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [columns.join(',')];
      for (const r of rows) {
        lines.push(columns.map(c => {
          let v = r[c];
          if (addNoise && numericCols.includes(c) && typeof v === 'number' && Number.isFinite(v)) {
            v = privacyBudget.addPrivacyBudgetNoise(v, 1, epsilon);
            v = Number(v.toFixed(4));
          }
          return esc(v);
        }).join(','));
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dataglow-${ds.table}-${addNoise ? `anon-eps${epsilon}` : 'export'}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      noteEl.textContent = addNoise
        ? `Exported ${rows.length} rows with Laplace noise (ε=${epsilon}) added to ${numericCols.length} numeric column(s).`
        : `Exported ${rows.length} rows (no noise — enable the toggle for differential privacy).`;
      toast('Export ready', 'success');
    } catch (e) {
      toast('Export failed: ' + e.message, 'error');
    }
  });
}

// ============================================================
// Export / Reporting (Excel + PDF via the Universal Export Contract)
// ============================================================
// Collects what app state already holds — the active dataset, its rows as
// currently displayed, and the last validation run — into a format-agnostic
// view, then asks the registry-loaded export module to build the bytes and hand
// them to the platform's delivery adapter (browser download or, on the desktop
// shell with the native APIs enabled, a Tauri Save-As). All client-side.
function collectValidationSummary() {
  const results = window.__dataglowLastValidation;
  if (!results) return { validation: [], grades: null };
  const summary = [];
  for (const layer of validation.LAYER_DEFS) {
    const r = results[layer.id];
    if (!r || !r.status) continue;
    summary.push({ layer: layer.id, name: layer.name, status: r.status, summary: r.summary || '' });
  }
  let grades = null;
  const cg = results.calibratedGrades;
  if (cg) {
    grades = {
      overall: cg.overall && cg.overall.grade,
      integrity: cg.integrity && cg.integrity.grade,
      plausibility: cg.plausibility && cg.plausibility.grade,
    };
  }
  return { validation: summary, grades };
}

// Build the opt-in Data Nutrition Label for the active dataset from what app
// state already holds — the chain-of-custody trail, the Assumption Ledger, and
// the last validation run. Returns null if the manifest module or dataset is
// unavailable. Pure aggregation; no network. Gated by both the flag and the
// human ticking the checkbox (see runExport) — never built silently.
function buildActiveNutritionLabel(ds, valSummary) {
  const chain = ds ? provenance.getProvenance(ds.table) : null;
  return buildDataNutritionLabel({
    dataset: ds,
    custody: chain,
    assumptions: ledger.getLedgerEntries(),
    checks: valSummary,
  });
}

async function runExport(format, noteEl) {
  if (!exportReport) { toast('Export module unavailable on this runtime', 'error'); return; }
  const ds = getActiveDataset();
  if (!ds) { toast('Load a dataset first', 'error'); return; }
  try {
    const { columns, rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT 100000`);
    const { validation: valSummary, grades } = collectValidationSummary();
    const platform = (window.__dataglowRegistry && window.__dataglowRegistry.platform) || 'browser';

    // Opt-in Data Nutrition Label: only when the flag is on AND the human ticked
    // the checkbox. Never auto-attached (empowerment constraint).
    const labelBox = $('#export-include-label');
    const includeLabel = isEnabled('dataNutritionLabel') && labelBox && labelBox.checked;
    let label = null;
    let nutritionLabelLines = null;
    if (includeLabel) {
      label = buildActiveNutritionLabel(ds, valSummary);
      nutritionLabelLines = renderLabelSummaryLines(label);
    }

    const { delivery } = await exportReport.exportDataset({
      format, dataset: ds, columns, rows,
      validation: valSummary, grades, platform, win: window,
      nutritionLabelLines,
    });
    if (delivery && delivery.cancelled) {
      if (noteEl) noteEl.textContent = 'Export cancelled.';
      return;
    }

    // When opted in, also deliver the machine-readable manifest as a separate
    // .json file alongside the primary export (client-side Blob download, no
    // network) so a recipient can inspect/re-verify it without DATAGLOW.
    if (label) {
      const json = exportLabelAsJSON(label);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dataglow-${ds.table}-nutrition-label.json`;
      a.click();
      URL.revokeObjectURL(url);
    }

    if (noteEl) {
      noteEl.textContent = `Exported ${rows.length} row(s) to ${format.toUpperCase()}`
        + (valSummary.length ? ` with a ${valSummary.length}-layer validation summary` : '')
        + (label ? ', plus a Data Nutrition Label (summary + .json manifest).' : '.');
    }
    toast(`${format.toUpperCase()} export ready`, 'success');
  } catch (e) {
    toast('Export failed: ' + e.message, 'error');
  }
}

function initExportReport() {
  const noteEl = $('#export-note');
  const xlsxBtn = $('#btn-export-xlsx');
  const pdfBtn = $('#btn-export-pdf');
  if (xlsxBtn) xlsxBtn.addEventListener('click', () => runExport('xlsx', noteEl));
  if (pdfBtn) pdfBtn.addEventListener('click', () => runExport('pdf', noteEl));
  // Reveal the opt-in Data Nutrition Label checkbox only when the flag is on;
  // otherwise it stays hidden and the export flow is unchanged.
  const labelWrap = $('#export-label-optin');
  if (labelWrap && isEnabled('dataNutritionLabel')) labelWrap.style.display = '';
}

// Render the Forecast-Based Drift Alerting block shown inside the Distributional
// Fingerprint Drift card. Styled distinctly from the static drift lines so a
// trend-aware alert reads as "outside the projected trajectory", not just
// "outside a static threshold".
function renderForecastDrift(forecast) {
  const wrap = el('div', { style: 'margin-top:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': 'forecast-drift' });
  // Persistence off, or store without history contract → nothing accumulated.
  if (!state.settings.persistFingerprints) {
    wrap.appendChild(el('div', {
      style: 'font-size:var(--text-xs); color:var(--color-text-faint);',
      'data-testid': 'forecast-drift-locked',
    }, '↗ Enable drift history tracking in Settings to unlock trend-aware alerts (forecasts this upload against the expected trajectory of recent uploads, not just a static baseline).'));
    return wrap;
  }
  // Unified Signal Layer: connect any trend-aware flag to a validation rule the
  // user recently disabled/changed on the same column, rather than showing an
  // unexplained drift warning. Additive — leaves flags without a related change
  // untouched.
  driftForecast.enrichForecastWithSignals(forecast, signalStore);
  if (!forecast || !forecast.active) {
    const have = forecast ? forecast.historyLen : 0;
    const need = forecast ? forecast.minHistory : driftForecast.MIN_FORECAST_HISTORY;
    wrap.appendChild(el('div', {
      style: 'font-size:var(--text-xs); color:var(--color-text-faint);',
      'data-testid': 'forecast-drift-warmup',
    }, `↗ Trend-aware forecasting warms up after ${need} prior uploads of this schema (have ${have}). Until then, only static drift above applies.`));
    return wrap;
  }
  const header = el('div', {
    style: 'display:flex; align-items:center; gap:var(--space-2); margin-bottom:var(--space-1);',
  }, [
    el('span', {
      style: 'font-size:var(--text-xs); font-weight:700; padding:2px 8px; border-radius:6px; color:#fff; background:var(--color-accent, #6d28d9);',
      'data-testid': 'forecast-drift-badge',
    }, 'TREND-AWARE FORECAST'),
    el('span', { style: 'font-size:var(--text-xs); color:var(--color-text-faint);' },
      `${forecast.method} · ${forecast.historyLen} prior upload(s)`),
  ]);
  wrap.appendChild(header);
  if (forecast.flags.length === 0) {
    wrap.appendChild(el('div', {
      style: 'font-size:var(--text-xs); color:var(--color-text-muted);',
      'data-testid': 'forecast-drift-ok',
    }, '✓ Every tracked stat is within the range forecast from its recent trend.'));
    return wrap;
  }
  const list = el('ul', {
    style: 'font-size:var(--text-xs); color:var(--color-text); padding-left:var(--space-4); margin:0;',
    'data-testid': 'forecast-drift-flags',
  });
  forecast.flags.slice(0, 6).forEach(f => list.appendChild(el('li', { style: 'margin-bottom:2px;' }, f.message)));
  wrap.appendChild(list);
  return wrap;
}

// Render the Expected Value Ranges block: a purely INFORMATIONAL trend band for
// numeric columns with enough upload history, shown beneath the forecast/static
// drift lines in the Distributional Fingerprint Drift card. Unlike the alerting
// block above it never changes status — it narrates "here's the recent trend and
// whether today fits it", with an explicit non-prediction disclaimer. Returns
// null (renders nothing) whenever there aren't enough numeric-mean bands to
// describe, so legacy/first-time/opt-out users simply see no band.
function renderExpectedRanges(forecast) {
  if (!state.settings.persistFingerprints) return null;
  const report = expectedRange.expectedRangeReport(forecast);
  if (!report.active || !report.bands.length) return null;
  const wrap = el('div', { style: 'margin-top:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': 'expected-range' });
  const header = el('div', {
    style: 'display:flex; align-items:center; gap:var(--space-2); margin-bottom:var(--space-1);',
  }, [
    el('span', {
      style: 'font-size:var(--text-xs); font-weight:700; padding:2px 8px; border-radius:6px; color:#fff; background:var(--color-info, #0369a1);',
      'data-testid': 'expected-range-badge',
    }, 'EXPECTED VALUE RANGES'),
    el('span', { style: 'font-size:var(--text-xs); color:var(--color-text-faint);' },
      `${report.bands.length} numeric column(s) · ${report.historyLen} prior upload(s)`),
  ]);
  wrap.appendChild(header);
  const list = el('ul', {
    style: 'font-size:var(--text-xs); color:var(--color-text); padding-left:var(--space-4); margin:0;',
    'data-testid': 'expected-range-bands',
  });
  report.bands.slice(0, 8).forEach(b => list.appendChild(el('li', {
    style: `margin-bottom:2px; ${b.within ? '' : 'color:var(--color-warn, #b45309);'}`,
  }, b.message)));
  wrap.appendChild(list);
  wrap.appendChild(el('div', {
    style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-top:var(--space-1);',
    'data-testid': 'expected-range-disclaimer',
  }, 'This is informational context about the recent trend, not a forecast of future values.'));
  return wrap;
}

function renderValidationResults(results) {
  const grid = $('#validation-grid');
  grid.innerHTML = '';
  // Adaptive Layer Prioritization: reorder the grid so the layers that have
  // historically caught real issues for this user surface first. Falls back to
  // the fixed registry order when learning is off or not yet ready. This only
  // changes card ORDER and adds an explanatory badge — every layer is still
  // rendered, and what each layer validates is unchanged.
  const priorityView = getLayerPriorityView();
  // Ordering precedence: an explicitly-enabled adaptive priority model wins;
  // otherwise the optional Context Card re-weights layer order; otherwise the
  // fixed registry order. With adaptive priority off and no context typed, the
  // order is identical to before this feature existed.
  let orderedLayers;
  if (priorityView) {
    orderedLayers = priorityView.items.map(it => it.def);
  } else {
    orderedLayers = problemFramer
      ? problemFramer.orderLayersByContext(getDataContext(), validation.LAYER_DEFS)
      : validation.LAYER_DEFS;
  }
  refreshLayerPriorityStats();
  for (const layer of orderedLayers) {
    if (layer.id === 'confidence') {
      renderConfidenceSummary(results.confidence);
      continue;
    }
    if (layer.id === 'red_team') continue; // rendered via modal
    const r = results[layer.id] || { status: 'idle', summary: 'Not run' };
    const head = el('div', { class: 'validation-card-head' }, [
      el('span', { class: 'validation-card-name' }, layer.name),
      el('span', { class: `validation-status ${r.status}` }, [el('span', { class: `status-dot ${r.status}` }), r.status.toUpperCase()]),
    ]);
    const priorityBadge = priorityBadgeFor(layer.id);
    if (priorityBadge) head.appendChild(priorityBadge);
    const card = el('div', { class: 'card validation-card', 'data-testid': `card-validation-${layer.id}` }, [
      head,
      el('div', { class: 'validation-card-desc' }, layer.desc),
      el('div', { style: 'font-size:var(--text-sm); margin-top:var(--space-1);' }, r.summary),
    ]);
    const priorityNote = priorityNoteFor(layer.id);
    if (priorityNote) card.appendChild(priorityNote);
    if (r.detail && Array.isArray(r.detail)) {
      const detailList = el('ul', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); padding-left:var(--space-4); margin-top:var(--space-1);' });
      r.detail.slice(0, 5).forEach(d => detailList.appendChild(el('li', {}, d)));
      card.appendChild(detailList);
    }
    // Explainable Benford Gate (Feature 6): when the eligibility gate skips a
    // column, show a plain-language "why" note so the skip teaches rather than
    // silently passing. Skipped columns are grouped by their cause (bounded
    // range, too few rows, too narrow a range, binary flag) and each group is
    // shown under the teaching paragraph that explains THAT specific reason.
    if (layer.id === 'benford' && Array.isArray(r.skips) && r.skips.length) {
      const details = el('details', { style: 'margin-top:var(--space-2); font-size:var(--text-xs);', 'data-testid': 'benford-teaching' });
      details.appendChild(el('summary', { style: 'cursor:pointer; color:var(--color-text-muted);' }, `Why ${r.skips.length} column(s) were skipped`));
      for (const group of validation.benfordTeachingGroups(r.skips)) {
        if (group.teaching) details.appendChild(el('div', { style: 'color:var(--color-text-muted); margin:var(--space-2) 0;', 'data-testid': `benford-teaching-${group.cause}` }, group.teaching));
        const ul = el('ul', { style: 'color:var(--color-text-muted); padding-left:var(--space-4); margin:0;' });
        group.skips.slice(0, 8).forEach(s => ul.appendChild(el('li', {}, s)));
        details.appendChild(ul);
      }
      card.appendChild(details);
    }
    // Forecast-Based Drift Alerting: the trend-aware extension of the static
    // Distributional Fingerprint Drift check. Rendered as a visually distinct
    // block so users can tell these apart from the plain historical-drift lines
    // above — these are projected-trajectory alerts, not static thresholds.
    if (layer.id === 'distribution_drift') {
      card.appendChild(renderForecastDrift(r.forecast));
      // Expected Value Ranges: informational numeric-column trend bands derived
      // from the same forecast projections (no status change, adds context).
      const ranges = renderExpectedRanges(r.forecast);
      if (ranges) card.appendChild(ranges);
    }
    // Categorical Consistency Engine: offer a one-click canonical merge per
    // cluster, reusing the same UPDATE mechanism as the Clean tab's fuzzy dedup.
    if (layer.id === 'categorical_consistency' && Array.isArray(r.clusters) && r.clusters.length) {
      const ds = getActiveDataset();
      for (const cl of r.clusters.slice(0, 10)) {
        const clRow = el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap; margin-top:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': `cat-cluster-${layer.id}-${cl.column}` }, [
          el('span', { class: 'mono', style: 'font-size:var(--text-xs);' }, `${cl.merges.map(m => `"${m.from}"`).join(', ')} → "${cl.canonical}"`),
        ]);
        // Sensitive demographic/payer columns: never offer an auto-merge —
        // textually similar values may be legally/clinically distinct.
        if (cl.sensitive) {
          clRow.appendChild(el('span', {
            style: 'font-size:var(--text-xs); font-weight:600; padding:3px 8px; border-radius:6px; color:#fff; background:var(--color-grade-c); margin-left:auto;',
            'data-testid': `cat-sensitive-badge-${cl.column}`,
            title: 'These values may be legally/clinically distinct even if textually similar.',
          }, 'Sensitive category — merges disabled'));
          card.appendChild(clRow);
          continue;
        }
        // The suggested canonical is editable: the analyst can accept it as-is,
        // type a different spelling (even one not among the variants), or reject
        // the whole cluster. Nothing is applied until "Apply Merge" is clicked.
        const canonInput = el('input', {
          type: 'text', value: cl.canonical, class: 'mono',
          style: 'font-size:var(--text-xs); padding:4px 8px; border:1px solid var(--color-divider); border-radius:6px; background:var(--color-surface); color:var(--color-text); min-width:140px; margin-left:auto;',
          'data-testid': `input-cat-canonical-${cl.column}`,
          title: 'Edit the canonical value all variants will be merged into.',
        });
        const mergeBtn = el('button', { class: 'btn btn-primary', style: 'font-size:var(--text-xs); padding:5px 10px;', 'data-testid': `button-cat-merge-${cl.column}` }, 'Apply Merge');
        const rejectBtn = el('button', { class: 'btn btn-ghost', style: 'font-size:var(--text-xs); padding:5px 10px;', 'data-testid': `button-cat-reject-${cl.column}` }, 'Reject');
        mergeBtn.addEventListener('click', async () => {
          const chosen = String(canonInput.value).trim();
          if (!chosen) { toast('Canonical value cannot be empty', 'error'); return; }
          // Recompute the merge mapping against the (possibly edited) canonical.
          const applied = withCanonical(cl, chosen);
          if (!applied.merges.length) { toast('Nothing to merge into that value', 'error'); return; }
          mergeBtn.disabled = true; rejectBtn.disabled = true;
          try {
            const col = `"${cl.column}"`;
            const to = String(applied.canonical).replace(/'/g, "''");
            for (const m of applied.merges) {
              const from = String(m.from).replace(/'/g, "''");
              await engine.runQuery(`UPDATE ${ds.table} SET ${col} = '${to}' WHERE ${col} = '${from}'`);
            }
            const edited = applied.canonical !== cl.canonical ? ' (canonical edited by user)' : '';
            ledger.logAssumption('Categorical Consistency Engine',
              `Applied merge: ${applied.merges.map(m => `"${m.from}"`).join(', ')} → "${applied.canonical}" in "${cl.column}"${edited}.`);
            await provenance.recordStep(ds.table, 'merge',
              `Categorical merge: ${applied.merges.map(m => `"${m.from}"`).join(', ')} → "${applied.canonical}" in "${cl.column}"${edited}.`,
              dataBlame.buildBlameDetail({ rule: 'categorical_merge', column: cl.column, affectedCount: applied.merges.length, after: applied.canonical, note: edited ? 'canonical edited by user' : undefined }));
            renderAssumptionLedger();
            renderProvenanceTrail();
            // Treat an edited canonical as a stronger accept signal (the user
            // engaged with, rather than rubber-stamped, the flag).
            await recordLearningSignal({ source: 'categorical_consistency', column: cl.column, sensitive: cl.sensitive, categorical: true, severity: Math.min(1, cl.variants.length / 5) }, applied.canonical !== cl.canonical ? 'edit' : 'accept');
            clRow.style.opacity = '0.4'; clRow.style.pointerEvents = 'none';
            toast(`Merged into "${applied.canonical}"`, 'success');
          } catch (e) {
            mergeBtn.disabled = false; rejectBtn.disabled = false;
            toast('Merge failed: ' + e.message, 'error');
          }
        });
        rejectBtn.addEventListener('click', () => {
          // Explicit rejection is a decision too — record it in the audit trail
          // so a skipped merge is visible rather than silently forgotten.
          ledger.logAssumption('Categorical Consistency Engine',
            `Rejected suggested merge for "${cl.column}" (${cl.variants.map(v => `"${v.value}"`).join(', ')}) — values kept distinct.`,
            { column: cl.column, rejected: true, variants: cl.variants });
          recordLearningSignal({ source: 'categorical_consistency', column: cl.column, sensitive: cl.sensitive, categorical: true, severity: Math.min(1, cl.variants.length / 5) }, 'reject');
          renderAssumptionLedger();
          clRow.style.opacity = '0.4'; clRow.style.pointerEvents = 'none';
          toast('Suggestion rejected', 'success');
        });
        clRow.appendChild(canonInput);
        clRow.appendChild(mergeBtn);
        clRow.appendChild(rejectBtn);
        annotateWithPrediction(clRow, { source: 'categorical_consistency', column: cl.column, sensitive: cl.sensitive, categorical: true, severity: Math.min(1, cl.variants.length / 5) });
        card.appendChild(clRow);
      }
    }
    // Cross-Column Logical Consistency: show each contradiction with the exact
    // rule, the columns involved, and a plain-language reason. The analyst can
    // dismiss a flag they judge acceptable — the dismissal is written to the
    // Assumption Ledger and Provenance Trail, same as a categorical reject.
    if (layer.id === 'cross_column_logic' && Array.isArray(r.findings) && r.findings.length) {
      const ds = getActiveDataset();
      for (const f of r.findings) {
        const fRow = el('div', { style: 'margin-top:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': `xcol-finding-${f.rule}` }, [
          el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap;' }, [
            el('span', { style: 'font-size:var(--text-xs); font-weight:600; padding:2px 8px; border-radius:6px; color:#fff; background:var(--color-grade-d);' }, f.ruleLabel),
            el('span', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, f.columns.map(c => `"${c}"`).join(' × ')),
            el('button', { class: 'btn btn-ghost', style: 'font-size:var(--text-xs); padding:4px 9px; margin-left:auto;', 'data-testid': `button-xcol-dismiss-${f.rule}` }, 'Dismiss'),
          ]),
          el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1);' }, f.explanation),
        ]);
        const dismissBtn = fRow.querySelector('button');
        dismissBtn.addEventListener('click', async () => {
          ledger.logAssumption('Cross-Column Logical Consistency',
            `Analyst dismissed ${f.count} flagged row(s) for "${f.ruleLabel}" on ${f.columns.map(c => `"${c}"`).join(', ')} — accepted as valid.`,
            { rule: f.rule, columns: f.columns, count: f.count, dismissed: true });
          if (ds) await provenance.recordStep(ds.table, 'validate',
            `Dismissed cross-column flag: ${f.ruleLabel} on ${f.columns.map(c => `"${c}"`).join(', ')}.`, { rule: f.rule, columns: f.columns, dismissed: true });
          await recordLearningSignal({ source: 'cross_column_logic', column: f.columns && f.columns[0], severity: 0.6 }, 'dismiss');
          renderAssumptionLedger();
          renderProvenanceTrail();
          fRow.style.opacity = '0.4'; fRow.style.pointerEvents = 'none';
          toast('Flag dismissed and recorded in the audit trail', 'success');
        });
        annotateWithPrediction(fRow, { source: 'cross_column_logic', column: f.columns && f.columns[0], severity: 0.6 });
        card.appendChild(fRow);
      }
    }
    // Physiological Plausibility: show the per-finding "why it's implausible"
    // explanation and ALWAYS surface the visible, non-clinical disclaimer so it
    // travels with the results wherever this card is shown.
    if (layer.id === 'physiological_plausibility') {
      if (r.checkedLabel) {
        card.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1);', 'data-testid': 'physio-checked' }, `Columns checked: ${r.checkedLabel}`));
      }
      if (Array.isArray(r.findings) && r.findings.length) {
        for (const f of r.findings) {
          card.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': `physio-finding-${f.vital}` }, [
            el('div', { style: 'font-weight:600;' }, f.columns ? f.columns.map(c => `"${c}"`).join(' × ') : `"${f.column}"`),
            el('div', {}, f.explanation),
          ]));
        }
      }
      if (r.disclaimer) {
        card.appendChild(el('div', {
          'data-testid': 'physio-disclaimer',
          style: 'margin-top:var(--space-2); padding:var(--space-2); border-left:3px solid var(--color-grade-c); background:rgba(255,180,0,0.08); font-size:var(--text-xs); color:var(--color-text-muted); border-radius:6px;',
        }, r.disclaimer));
      }
    }
    // Upper-Bound Sanity Anchor: show which bounded columns were checked, a
    // per-column plain-language "why it's impossible by definition" explanation,
    // and the conservative-scope note. Each flag can be dismissed — the
    // dismissal is written to the Assumption Ledger and Provenance Trail, exactly
    // like a Cross-Column flag.
    if (layer.id === 'upper_bound_sanity') {
      if (r.checkedLabel) {
        card.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1);', 'data-testid': 'upperbound-checked' }, `Columns checked: ${r.checkedLabel}`));
      }
      if (Array.isArray(r.findings) && r.findings.length) {
        const ds = getActiveDataset();
        for (const f of r.findings) {
          const fRow = el('div', { style: 'margin-top:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': `upperbound-finding-${f.column}` }, [
            el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap;' }, [
              el('span', { style: 'font-size:var(--text-xs); font-weight:600; padding:2px 8px; border-radius:6px; color:#fff; background:var(--color-grade-c);' }, `${f.category} ${f.low}–${f.high}`),
              el('span', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, `"${f.column}"`),
              // "This finding was wrong" — draft a blameless postmortem from the
              // recorded provenance trail. Rendering only; nothing is applied here.
              el('button', { class: 'btn btn-ghost', style: 'font-size:var(--text-xs); padding:4px 9px; margin-left:auto;', 'data-testid': `button-upperbound-incident-${f.column}` }, 'Report incident'),
              el('button', { class: 'btn btn-ghost', style: 'font-size:var(--text-xs); padding:4px 9px;', 'data-testid': `button-upperbound-dismiss-${f.column}` }, 'Dismiss'),
            ]),
            el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1);' }, f.explanation),
          ]);
          const dismissBtn = fRow.querySelector(`[data-testid="button-upperbound-dismiss-${f.column}"]`);
          const incidentBtn = fRow.querySelector(`[data-testid="button-upperbound-incident-${f.column}"]`);
          incidentBtn.addEventListener('click', () => openIncidentPostmortem(fRow, {
            label: `${f.category} ${f.low}–${f.high}`, column: f.column, layer: 'upper_bound_sanity', kind: 'false-positive',
          }, `A value in "${f.column}" was flagged out of bounds (${f.category} ${f.low}–${f.high}) but is legitimate.`));
          dismissBtn.addEventListener('click', async () => {
            ledger.logAssumption('Upper-Bound Sanity Anchor',
              `Analyst dismissed ${f.count} out-of-bound value(s) in "${f.column}" (${f.category} ${f.low}–${f.high}) — accepted as valid.`,
              { column: f.column, category: f.category, count: f.count, dismissed: true });
            if (ds) await provenance.recordStep(ds.table, 'validate',
              `Dismissed upper-bound flag on "${f.column}" (${f.category} ${f.low}–${f.high}).`, { column: f.column, dismissed: true });
            await recordLearningSignal({ source: 'upper_bound_sanity', column: f.column, numeric: true, severity: 0.7 }, 'dismiss');
            renderAssumptionLedger();
            renderProvenanceTrail();
            fRow.style.opacity = '0.4'; fRow.style.pointerEvents = 'none';
            toast('Flag dismissed and recorded in the audit trail', 'success');
          });
          annotateWithPrediction(fRow, { source: 'upper_bound_sanity', column: f.column, numeric: true, severity: 0.7 });
          card.appendChild(fRow);
        }
      }
      if (r.note) {
        card.appendChild(el('div', {
          'data-testid': 'upperbound-note',
          style: 'margin-top:var(--space-2); padding:var(--space-2); border-left:3px solid var(--color-grade-c); background:rgba(255,180,0,0.08); font-size:var(--text-xs); color:var(--color-text-muted); border-radius:6px;',
        }, r.note));
      }
    }
    // Missingness Detective: for each analysed column show its MCAR/MAR/MNAR
    // classification badge, the plain-language narrative (with the driver column
    // named + effect size for MAR), the "why it matters for analysis" note, and
    // any conservative — clearly labelled — MNAR hypothesis. Closes with the
    // taxonomy note explaining what the classifications do and don't prove.
    if (layer.id === 'missingness_detective') {
      if (r.checkedLabel) {
        card.appendChild(el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1);', 'data-testid': 'missingness-checked' }, `Columns analysed: ${r.checkedLabel}`));
      }
      if (Array.isArray(r.findings) && r.findings.length) {
        const badgeColor = (f) => f.classification === 'MAR' ? 'var(--color-grade-c)' : 'var(--color-grade-a)';
        for (const f of r.findings) {
          const fRow = el('div', { style: 'margin-top:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--color-divider);', 'data-testid': `missingness-finding-${f.column}` }, [
            el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap;' }, [
              el('span', { style: `font-size:var(--text-xs); font-weight:600; padding:2px 8px; border-radius:6px; color:#fff; background:${badgeColor(f)};` }, f.classification === 'MAR' ? 'Likely MAR' : 'MCAR (no driver)'),
              el('span', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, `"${f.column}" — ${f.missingRate}% missing`),
              ...(f.mnarCaution ? [el('span', { style: 'font-size:var(--text-xs); font-weight:600; padding:2px 8px; border-radius:6px; color:#fff; background:var(--color-grade-d);', 'data-testid': `missingness-mnar-${f.column}` }, 'MNAR risk?')] : []),
            ]),
            el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1);' }, f.narrative),
            el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-top:var(--space-1); font-style:italic;' }, f.why),
          ]);
          if (f.mnarNote) {
            fRow.appendChild(el('div', {
              style: 'margin-top:var(--space-2); padding:var(--space-2); border-left:3px solid var(--color-grade-d); background:rgba(220,80,80,0.08); font-size:var(--text-xs); color:var(--color-text-muted); border-radius:6px;',
            }, f.mnarNote));
          }
          card.appendChild(fRow);
        }
      }
      if (r.note) {
        card.appendChild(el('div', {
          'data-testid': 'missingness-note',
          style: 'margin-top:var(--space-2); padding:var(--space-2); border-left:3px solid var(--color-grade-c); background:rgba(255,180,0,0.08); font-size:var(--text-xs); color:var(--color-text-muted); border-radius:6px;',
        }, r.note));
      }
    }
    // Teach-As-You-Clean: an optional one-line "why this matters" note keyed on
    // the layer id. Shown only when the "Learn while you clean" toggle is on;
    // the verbosity slider swaps the wording register, never the presence.
    const lesson = microLessonNote(layer.id);
    if (lesson) card.appendChild(lesson);
    grid.appendChild(card);
  }
}

// Blameless Incident Postmortem (Batch 4). From a validation finding the analyst
// reports was WRONG, draft — from the SUPPLIED provenance trail only — a
// timeline + root-cause narrative + a PROPOSED corrective rule. This function
// only renders the draft; the pure module (js/provenance/incident-postmortem.js)
// applies nothing. Accept routes the correction through the SAME confirm-gated
// community-pack import path a hand-authored domain-pack rule uses (mirrors
// initCommunityPack: importPack → registerRuntimePack), behind an explicit
// per-action confirm(). Dismiss discards the draft with zero side effects.
async function openIncidentPostmortem(mountAfter, finding, description) {
  const ds = getActiveDataset();
  const prev = mountAfter.nextElementSibling;
  if (prev && prev.getAttribute && prev.getAttribute('data-postmortem') === '1') prev.remove();

  let postmortem;
  try { postmortem = await import('../provenance/incident-postmortem.js'); }
  catch { toast('Postmortem module unavailable on this runtime', 'error'); return; }

  const chain = ds && provenance.getProvenance(ds.table);
  const provenanceTrail = chain ? chain.getTrail() : [];
  const draft = postmortem.draftPostmortem({
    incident: { description, discoveredAt: Date.now(), affectedFinding: finding },
    provenanceTrail,
    assumptionLedger: ledger.getLedgerEntries ? ledger.getLedgerEntries() : undefined,
  });
  const corr = draft.proposedCorrection;

  const timelineItems = draft.timeline.map(e => el('li', {
    style: `font-size:var(--text-xs); color:var(--color-text-muted); margin:2px 0;${e.source === 'incident' ? 'font-weight:600;color:var(--color-text);' : ''}`,
  }, `${e.iso ? e.iso.replace('T', ' ').slice(0, 19) + ' — ' : ''}${e.source === 'incident' ? 'Incident discovered' : `${e.op || 'step'}: ${e.description || ''}`}`));

  const acceptBtn = el('button', { class: 'btn btn-primary', style: 'font-size:var(--text-xs); padding:4px 12px;', 'data-testid': `button-postmortem-accept-${finding.column}` }, 'Accept correction');
  const dismissBtn = el('button', { class: 'btn btn-ghost', style: 'font-size:var(--text-xs); padding:4px 12px;', 'data-testid': `button-postmortem-dismiss-${finding.column}` }, 'Dismiss');

  const panel = el('div', {
    'data-postmortem': '1', 'data-testid': `postmortem-${finding.column}`,
    style: 'margin-top:var(--space-2); padding:var(--space-3); border:1px solid var(--color-divider); border-left:3px solid var(--color-grade-b); border-radius:8px; background:rgba(80,140,220,0.05);',
  }, [
    el('div', { style: 'font-weight:600; font-size:var(--text-sm); margin-bottom:var(--space-1);' }, 'Blameless postmortem (DRAFT — proposal only)'),
    el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:var(--space-2);' }, draft.rootCause.narrative),
    el('div', { style: 'font-size:var(--text-xs); font-weight:600; margin-bottom:2px;' }, `Timeline (${draft.timeline.length} event${draft.timeline.length === 1 ? '' : 's'}, from the recorded provenance trail)`),
    el('ul', { style: 'margin:0 0 var(--space-2); padding-left:18px;' }, timelineItems.length ? timelineItems : [el('li', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, 'No provenance steps were recorded for this dataset.')]),
    el('div', { style: 'font-size:var(--text-xs); margin-bottom:var(--space-2);' }, [
      el('span', { style: 'font-weight:600;' }, 'Proposed correction: '),
      el('span', {}, corr.summary + ' '),
      el('span', { style: 'font-weight:600; padding:1px 6px; border-radius:5px; background:var(--color-surface-2); color:var(--color-text-muted);', 'data-testid': `postmortem-confidence-${finding.column}` }, `${corr.confidence.label} (${corr.confidence.score})`),
    ]),
    el('div', { style: 'font-size:11px; color:var(--color-text-muted); margin-bottom:var(--space-2); font-style:italic;' }, draft.disclaimer),
    el('div', { style: 'display:flex; gap:var(--space-2);' }, [acceptBtn, dismissBtn]),
  ]);
  mountAfter.insertAdjacentElement('afterend', panel);

  // Dismiss: discard the draft with ZERO side effects.
  dismissBtn.addEventListener('click', () => { panel.remove(); });

  // Accept: stage the correction through the EXISTING confirm-gated apply path.
  acceptBtn.addEventListener('click', async () => {
    if (!communityPack || !domainPhysics) { toast('The domain-pack apply path is unavailable on this runtime', 'error'); return; }
    // Only the annotate-only outlier-context correction maps onto an existing
    // portable rule kind. Anything else is recorded for manual follow-up rather
    // than applied — the module never invents a new apply path.
    if (corr.applyVia !== 'domain-pack-rule' || corr.kind !== 'add-outlier-context') {
      ledger.logAssumption('Incident Postmortem',
        `Accepted a PROPOSED correction for "${finding.column}" (${corr.kind}) — recorded for manual review; nothing was applied automatically.`,
        { column: finding.column, kind: corr.kind, staged: true });
      renderAssumptionLedger();
      acceptBtn.disabled = true; acceptBtn.textContent = 'Recorded for review';
      toast('This correction type needs manual review — recorded in the audit trail, not auto-applied', 'success');
      return;
    }
    // Explicit, per-action human confirmation BEFORE anything is applied.
    const confirmed = window.confirm(
      `Add an annotate-only context rule for "${finding.column}" so legitimate values like this are no longer flagged?\n\n`
      + 'This routes through the same domain-pack import path as a hand-authored rule. It never hard-fails or edits your data.');
    if (!confirmed) return;

    const fullCol = String(finding.column || '');
    const shortCol = fullCol.slice(0, 24).replace(/[^a-z0-9_-]/gi, '-') || 'column';
    const pattern = `^${fullCol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    const envelope = {
      kind: communityPack.PACK_KIND,
      schemaVersion: communityPack.PACK_SCHEMA_VERSION,
      pack: {
        name: `postmortem-${shortCol}`.slice(0, 60),
        label: `Postmortem: ${shortCol}`.slice(0, 60),
        description: `Annotate-only outlier context proposed by a blameless incident postmortem for "${fullCol}".`,
        rules: [{
          kind: 'outlier-context',
          id: `pm-ctx-${shortCol}`.slice(0, 60),
          description: corr.summary,
          match: { pattern },
          packLabel: 'Postmortem',
          reason: description,
        }],
      },
    };
    const res = communityPack.importPack(envelope);
    if (!res.ok) { toast('Could not stage the correction: ' + res.errors.slice(0, 2).join('; '), 'error'); return; }
    domainPhysics.registerRuntimePack(res.pack);
    const sel = $('#domain-pack-select');
    if (sel && !Array.from(sel.options).some(o => o.value === res.pack.name)) {
      sel.appendChild(el('option', { value: res.pack.name, title: res.pack.description }, `${res.pack.label} (postmortem)`));
    }
    ledger.logAssumption('Incident Postmortem',
      `Applied a PROPOSED annotate-only context rule for "${fullCol}" via the domain-pack import path, after explicit confirmation.`,
      { column: fullCol, packName: res.pack.name });
    if (ds) await provenance.recordStep(ds.table, 'validate',
      `Accepted postmortem correction: annotate-only context for "${fullCol}".`, { column: fullCol, packName: res.pack.name });
    renderAssumptionLedger(); renderProvenanceTrail();
    acceptBtn.disabled = true; acceptBtn.textContent = 'Applied'; dismissBtn.textContent = 'Close';
    toast('Correction staged and applied through the domain-pack path', 'success');
    if (ds) runValidation();
  });
}

function renderConfidenceSummary(c) {
  if (!c) return;
  $('#confidence-summary').style.display = '';
  $('#confidence-score').textContent = c.score;
  $('#confidence-grade-label').textContent = `Grade ${c.grade}`;
  const gradeColors = { A: 'var(--color-grade-a)', B: 'var(--color-grade-b)', C: 'var(--color-grade-c)', D: 'var(--color-grade-d)' };
  $('#confidence-ring-arc').setAttribute('stroke', gradeColors[c.grade]);
  $('#confidence-grade-label').style.color = gradeColors[c.grade];
  const circumference = 264;
  $('#confidence-ring-arc').setAttribute('stroke-dashoffset', String(circumference * (1 - c.score / 100)));
  $('#confidence-verdict').textContent = c.verdict;
  $('#confidence-verdict').style.color = c.status === 'pass' ? 'var(--color-grade-a)' : c.status === 'warn' ? 'var(--color-grade-c)' : 'var(--color-grade-d)';
  $('#confidence-detail').textContent = `Score computed from 6 signals: sample coverage, null rate, variance, subsample stability, sample size, and anomaly concentration.`;
  const signalsEl = $('#confidence-signals');
  signalsEl.innerHTML = '';
  for (const [label, val] of Object.entries(c.signals)) {
    signalsEl.appendChild(el('div', { style: 'text-align:center;' }, [
      el('div', { style: 'font-size:var(--text-lg); font-weight:600;' }, `${val}`),
      el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); max-width:80px;' }, label),
    ]));
  }
}

// ============================================================
// Red Team Mode
// ============================================================
function initRedTeam() {
  $('#btn-red-team').addEventListener('click', () => $('#redteam-modal').classList.add('open'));
  $('#btn-redteam-close').addEventListener('click', () => $('#redteam-modal').classList.remove('open'));
  $('#btn-redteam-run').addEventListener('click', async () => {
    const resultsEl = $('#redteam-results');
    resultsEl.innerHTML = '<div class="skeleton" style="height:100px; border-radius:var(--radius-md);"></div>';
    let ds;
    try {
      await ensureDuckDB();
      ds = await loaders.loadGoldenDataset();
    } catch (err) {
      resultsEl.innerHTML = '';
      showEngineError(err);
      return;
    }
    renderSidebar();
    resetPanelStates();
    const results = await validation.runAllLayers(ds, { freshnessThresholdHours: state.settings.freshnessThresholdHours });
    const expected = validation.getExpectedGoldenFindings();

    const checks = [
      { layer: 'unit_tests', label: 'Unit Test Layer', pass: results.unit_tests.status === 'fail' },
      { layer: 'semantic_drift', label: 'Semantic Drift Detector', pass: results.semantic_drift.status === 'fail' },
      { layer: 'sanity_anchor', label: 'Sanity Anchor', pass: results.sanity_anchor.status === 'pass' },
      { layer: 'schema_fingerprint', label: 'Schema Fingerprint', pass: results.schema_fingerprint.status === 'pass' },
      { layer: 'confidence', label: 'Confidence Layer', pass: results.confidence.score < 80 },
    ];
    const allPassed = checks.every(c => c.pass);

    resultsEl.innerHTML = '';
    resultsEl.appendChild(el('div', { class: 'card', style: `padding:var(--space-4); margin-bottom:var(--space-3); border-color:${allPassed ? 'var(--color-grade-a)' : 'var(--color-grade-d)'};` }, [
      el('div', { style: `font-weight:600; color:${allPassed ? 'var(--color-grade-a)' : 'var(--color-grade-d)'};` }, allPassed ? 'Self-attack test PASSED — validation layers are catching real issues.' : 'Self-attack test FAILED — one or more layers missed a known issue.'),
    ]));
    for (const c of checks) {
      resultsEl.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) 0; border-bottom:1px solid var(--color-divider); font-size:var(--text-sm);' }, [
        el('span', { class: `status-dot ${c.pass ? 'pass' : 'fail'}` }),
        el('span', {}, c.label),
        el('span', { style: 'margin-left:auto; color:var(--color-text-faint); font-size:var(--text-xs);' }, c.pass ? 'caught it' : 'missed it'),
      ]));
    }
    switchTab('validate');
    renderValidationResults(results);
    $('#redteam-modal').classList.remove('open');
    toast(allPassed ? 'Red Team self-test passed' : 'Red Team self-test found a gap', allPassed ? 'success' : 'error');
  });

  // Red Team Mode v2 (Feature 5): synthesize a fresh adversarial dataset that
  // matches the ACTIVE dataset's schema, load it, run all layers, and report
  // which seeded issue categories the validation stack caught.
  const v2Btn = $('#btn-redteam-v2');
  if (v2Btn) v2Btn.addEventListener('click', async () => {
    const resultsEl = $('#redteam-results');
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first to model its schema', 'error'); return; }
    resultsEl.innerHTML = '<div class="skeleton" style="height:100px; border-radius:var(--radius-md);"></div>';
    await ensureDuckDB();
    const gen = syntheticAdversarial.generateAdversarialDataset(ds.cols);
    const tableName = `redteam_v2_${ds.table}`.slice(0, 60);
    await engine.createTableFromRows(tableName, gen.columns, gen.rows);
    const synthDs = {
      name: `${tableName}.synthetic`, table: tableName, rowCount: gen.rows.length,
      cols: (await engine.getTableSchema(tableName)).map(s => ({ name: s.column_name, type: s.column_type })),
      loadedAt: Date.now(), isSynthetic: true,
    };
    addDataset(synthDs);
    renderSidebar();
    const results = await validation.runAllLayers(synthDs, { freshnessThresholdHours: state.settings.freshnessThresholdHours });

    // Map each seeded issue category to the layer(s) expected to catch it.
    const CATEGORY_LAYERS = {
      categorical_variants: ['categorical_consistency'],
      cross_column_dates: ['cross_column_logic'],
      cross_column_age: ['cross_column_logic'],
      cross_column_numeric: ['cross_column_logic'],
      duplicates: ['unit_tests'],
      nulls: ['unit_tests'],
      semantic_outlier: ['semantic_drift', 'outlier_detection', 'sanity_anchor', 'unit_tests'],
      future_date: ['freshness', 'unit_tests'],
      negative_magnitude: ['outlier_detection', 'unit_tests'],
    };
    const seededKeys = Object.keys(gen.seeded || {});
    const checks = seededKeys.map(cat => {
      const layers = CATEGORY_LAYERS[cat] || [];
      const caught = layers.some(lid => results[lid] && (results[lid].status === 'fail' || results[lid].status === 'warn'));
      return { cat, caught, layers };
    });
    const caughtCount = checks.filter(c => c.caught).length;

    resultsEl.innerHTML = '';
    resultsEl.appendChild(el('div', { class: 'card', style: `padding:var(--space-4); margin-bottom:var(--space-3); border-color:${caughtCount === checks.length ? 'var(--color-grade-a)' : 'var(--color-grade-c)'};`, 'data-testid': 'redteam-v2-verdict' }, [
      el('div', { style: 'font-weight:600;' }, `Red Team v2 — synthesized ${gen.rows.length} rows matching "${ds.name}" schema; caught ${caughtCount}/${checks.length} seeded issue categories.`),
    ]));
    for (const c of checks) {
      resultsEl.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) 0; border-bottom:1px solid var(--color-divider); font-size:var(--text-sm);', 'data-testid': `redteam-v2-cat-${c.cat}` }, [
        el('span', { class: `status-dot ${c.caught ? 'pass' : 'fail'}` }),
        el('span', {}, c.cat.replace(/_/g, ' ')),
        el('span', { style: 'margin-left:auto; color:var(--color-text-faint); font-size:var(--text-xs);' }, c.caught ? 'caught it' : 'missed it'),
      ]));
    }
    switchTab('validate');
    renderValidationResults(results);
    $('#redteam-modal').classList.remove('open');
    toast(`Red Team v2 caught ${caughtCount}/${checks.length} categories`, caughtCount === checks.length ? 'success' : 'error');
  });
}

// ============================================================
// Visualize Tab
// ============================================================
function populateVisualizeBuilder() {
  const ds = getActiveDataset();
  if (!ds) return;
  $('#visualize-builder').style.display = '';
  const xSel = $('#viz-x'), ySel = $('#viz-y');
  xSel.innerHTML = ds.cols.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  ySel.innerHTML = ds.cols.filter(c => ['DOUBLE','BIGINT','INTEGER','HUGEINT','FLOAT'].includes(c.type)).map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
}

function initVisualizeTab() {
  $('#viz-chart-type').addEventListener('change', () => {
    const type = $('#viz-chart-type').value;
    $('#viz-y-wrap').style.display = ['pie', 'histogram', 'box'].includes(type) ? 'none' : '';
  });
  $('#btn-viz-generate').addEventListener('click', async () => {
    const ds = getActiveDataset();
    if (!ds) { toast('Load a dataset first', 'error'); return; }
    const type = $('#viz-chart-type').value;
    const x = $('#viz-x').value;
    const y = $('#viz-y').value;
    try {
      await viz.renderChart('viz-chart', ds.table, type, x, y);
    } catch (err) {
      toast('Chart error: ' + err.message, 'error');
    }
  });
  $('#btn-viz-export').addEventListener('click', () => viz.exportChartPNG('viz-chart', `dataglow-${getActiveDataset()?.table || 'chart'}`));
}

// ============================================================
// Story Tab
// ============================================================
function updateStoryBadgePreview() {
  const badge = $('#story-model-badge');
  if (!badge) return;
  const provider = state.settings.modelProvider;
  const providerDef = story.MODEL_PROVIDERS.find(p => p.id === provider);
  const hasKey = providerDef && providerDef.requiresKey && !!state.settings.apiKeys[provider];
  if (!providerDef || providerDef.id === 'local') {
    badge.textContent = 'Rule-based (offline)';
  } else if (providerDef.inBrowser) {
    badge.textContent = ondeviceLLM.isWebGPUAvailable() ? 'In-browser AI (private)' : 'Rule-based (no WebGPU)';
  } else if (!providerDef.requiresKey) {
    badge.textContent = providerDef.name;
  } else if (hasKey) {
    badge.textContent = providerDef.name;
  } else {
    badge.textContent = 'Rule-based (no API key set)';
  }
  updateStoryModelPanel();
}

// Cancellation flag for an in-flight model download (set by the Cancel button and
// checked inside WebLLM's progress callback to abort the load).
let storyModelCancelled = false;

// AI Touch Ledger (Batch 2) — a single session-scoped hash chain, mirroring how
// the Assumption Ledger (js/provenance/assumption-ledger.js) is a single running
// log for this session. Gated entirely by the aiTouchLedger flag: when off, this
// object still exists (cheap, pure, no timers/network) but story.generateStory()
// is never given it (see the btn-story-generate handler below), so logTouch() is
// never called and the ledger stays permanently empty — byte-for-byte the same
// as if this line did not exist.
const aiTouchLedger = createTouchLedger();

// Show/refresh the in-browser-model panel in the Story tab. Visible only when the
// on-device provider is selected; adapts its copy to WebGPU availability and
// whether the model is already cached/loaded in this session.
function updateStoryModelPanel() {
  const panel = $('#story-model-panel');
  if (!panel) return;
  const provider = state.settings.modelProvider;
  const providerDef = story.MODEL_PROVIDERS.find(p => p.id === provider);
  const info = $('#story-model-info');
  const clearBtn = $('#btn-story-model-clear');
  if (!providerDef || !providerDef.inBrowser) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  if (!ondeviceLLM.isWebGPUAvailable()) {
    info.innerHTML = 'Your browser doesn\'t support <strong>WebGPU</strong>, so the in-browser AI model can\'t run here. Generating a story will use DATAGLOW\'s offline rule-based summary instead. For the in-browser model, try a recent Chrome, Edge, or Chrome on Android (or Safari 18+). You can also switch to an API key in Settings.';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }
  if (ondeviceLLM.isModelLoaded()) {
    info.innerHTML = `<strong>${escapeHtml(ondeviceLLM.MODEL_LABEL)}</strong> is loaded and running fully on your device — nothing you generate is uploaded.`;
    if (clearBtn) clearBtn.style.display = '';
  } else {
    info.innerHTML = `The first time you generate a story, DATAGLOW downloads <strong>${escapeHtml(ondeviceLLM.MODEL_LABEL)}</strong> once (a few hundred MB) and caches it in your browser for offline reuse. After that it runs entirely on your device — your data never leaves it.`;
    if (clearBtn) clearBtn.style.display = 'none';
  }
}

// Lazy-load the on-device model (with progress + cancel UI) then stream the
// narrative. Injected into story.generateStory so story.js stays WebLLM-free.
async function ondeviceGenerateStory(queryResult, tableName) {
  const claims = story.buildStoryClaims(queryResult);
  const progressWrap = $('#story-model-progress-wrap');
  const progressBar = $('#story-model-progress-bar');
  const progressText = $('#story-model-progress-text');
  const cancelBtn = $('#btn-story-model-cancel');

  if (!ondeviceLLM.isModelLoaded()) {
    storyModelCancelled = false;
    progressWrap.style.display = '';
    cancelBtn.style.display = '';
    progressBar.style.width = '0%';
    progressText.textContent = 'Preparing download…';
    try {
      await ondeviceLLM.loadModel(({ progress, text }) => {
        if (storyModelCancelled) { const e = new Error('Model download cancelled.'); e.code = 'CANCELLED'; throw e; }
        progressBar.style.width = `${Math.round((progress || 0) * 100)}%`;
        progressText.textContent = text || `Downloading model… ${Math.round((progress || 0) * 100)}%`;
      });
    } finally {
      progressWrap.style.display = 'none';
      cancelBtn.style.display = 'none';
    }
  }

  updateStoryModelPanel();
  // Stream tokens live into the story pane (escaped — this is free-form model text).
  return ondeviceLLM.generateStoryNarrative({ queryResult, tableName, claims }, (partial) => {
    $('#story-empty').style.display = 'none';
    $('#story-content-wrap').style.display = '';
    $('#story-text').innerHTML = `<p>${escapeHtml(partial)}</p>`;
  });
}

function initStoryTab() {
  updateStoryBadgePreview();

  const cancelBtn = $('#btn-story-model-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { storyModelCancelled = true; toast('Cancelling model download…', 'info'); });

  const clearBtn = $('#btn-story-model-clear');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      const n = await ondeviceLLM.clearModelCache();
      toast(n ? 'Cached model cleared — storage freed.' : 'No cached model found.', 'success');
    } catch (err) {
      toast('Could not clear cached model: ' + err.message, 'error');
    } finally {
      clearBtn.disabled = false;
      updateStoryModelPanel();
    }
  });

  $('#btn-story-generate').addEventListener('click', async () => {
    if (!state.lastQueryResult) { toast('Run a SQL query first', 'error'); return; }
    const btn = $('#btn-story-generate');
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      const provider = state.settings.modelProvider;
      const apiKey = state.settings.apiKeys[provider];
      const { text, source } = await story.generateStory(
        state.lastQueryResult, getActiveDataset().table, provider, apiKey,
        {
          ondeviceGenerate: ondeviceGenerateStory,
          // AI Touch Ledger (Batch 2): only handed to the Story Engine when the
          // flag is on, per the promote-or-delete flag convention — with it off,
          // story.generateStory() never receives a touchLedger and its own
          // logStoryTouch() early-returns, so nothing changes with the flag off.
          touchLedger: isEnabled('aiTouchLedger') ? aiTouchLedger : undefined,
        },
      );
      if (isEnabled('aiTouchLedger')) renderAiTouchLedgerPanel();
      state.lastStory = text.replace(/<[^>]+>/g, ''); // plain text kept for consistency checker
      $('#story-empty').style.display = 'none';
      $('#story-content-wrap').style.display = '';
      // Local stories are built from hardcoded-safe markup wrapping escapeHtml()'d
      // data values, so they render as-is. Any other source is free-form text from
      // a model (on-device or a third-party API; a crafted dataset could prompt-inject
      // it into emitting raw HTML), so it is escaped before hitting innerHTML.
      const storyHtml = (source === 'local' || source === 'local-fallback') ? text : escapeHtml(text);
      $('#story-text').innerHTML = `<p>${storyHtml}</p>`;
      const consistency = await validation.checkNarrativeConsistency(state.lastStory, state.lastQueryResult);
      const consistEl = $('#story-consistency');
      if (consistency.status === 'pass') {
        consistEl.innerHTML = `<div class="validation-status pass"><span class="status-dot pass"></span> All numbers in this story match the underlying query result.</div>`;
      } else {
        consistEl.innerHTML = `<div class="validation-status fail"><span class="status-dot fail"></span> ${consistency.mismatches.length} number(s) don't clearly match the query result: ${consistency.mismatches.slice(0,5).map(escapeHtml).join(', ')}</div>`;
      }
      const badge = $('#story-model-badge');
      badge.textContent =
        source === 'ondevice' ? 'In-browser AI (private)' :
        source === 'local' ? 'Rule-based (offline)' :
        source === 'local-fallback' ? 'Rule-based (fallback)' :
        story.MODEL_PROVIDERS.find(p => p.id === provider)?.name || provider;
      renderStoryClaims(state.lastQueryResult);
    } catch (err) {
      toast('Story generation failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Generate Story';
    }
  });
}

// Confidence-Aware Narration (Feature 3): render each quantitative claim from
// the story with its per-claim confidence badge, scored by the Confidence Layer.
function renderStoryClaims(queryResult) {
  const wrap = $('#story-claims');
  if (!wrap) return;
  const claims = story.buildStoryClaims(queryResult);
  wrap.innerHTML = '';
  if (!claims.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const gradeClass = { A: 'badge-a', B: 'badge-b', C: 'badge-c', D: 'badge-d' };
  wrap.appendChild(el('div', { style: 'font-weight:600; font-size:var(--text-sm); margin-bottom:var(--space-2);' }, 'Claim-level confidence'));
  for (const c of claims) {
    const conf = c.confidence;
    const pctMissing = (conf.missingRate * 100).toFixed(conf.missingRate ? 1 : 0);
    wrap.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) 0; border-top:1px solid var(--color-divider); font-size:var(--text-sm);', 'data-testid': `story-claim-${c.kind}` }, [
      el('span', { style: 'flex:1;' }, c.text),
      el('span', { class: `badge ${gradeClass[conf.grade] || ''}`, style: 'flex:none;', 'data-testid': `claim-badge-${c.kind}` }, `${conf.grade} · n=${conf.n} · ${pctMissing}% missing`),
    ]));
  }
}

// ============================================================
// Settings Modal
// ============================================================
function initSettings() {
  const providerList = $('#model-provider-list');
  const webgpuOK = ondeviceLLM.isWebGPUAvailable();
  const webgpuNote = $('#model-webgpu-note');
  if (webgpuNote && !webgpuOK) {
    webgpuNote.style.display = '';
    webgpuNote.innerHTML = 'Heads up: this browser doesn\'t support <strong>WebGPU</strong>, so the in-browser AI model is unavailable here. It runs in recent Chrome, Edge, or Chrome on Android (Safari 18+). The rule-based and API-key options work everywhere.';
  }
  story.MODEL_PROVIDERS.forEach(p => {
    const disabled = p.inBrowser && !webgpuOK;
    const badgeEl = p.inBrowser
      ? el('span', { class: `badge ${disabled ? 'badge-c' : 'badge-a'}`, style: 'margin-left:auto;' }, disabled ? 'Needs WebGPU' : 'On-device · no key')
      : (p.requiresKey
        ? el('span', { class: 'badge badge-b', style: 'margin-left:auto;' }, 'Requires API key')
        : el('span', { class: 'badge badge-a', style: 'margin-left:auto;' }, 'No key needed'));
    const chip = el('div', {
      class: `chip ${state.settings.modelProvider === p.id ? 'active' : ''}`,
      style: `width:100%; justify-content:flex-start; padding:var(--space-3);${disabled ? ' opacity:0.55; cursor:not-allowed;' : ''}`,
      'data-testid': `chip-provider-${p.id}`,
      onclick: () => {
        if (disabled) { toast('The in-browser AI model needs a WebGPU-capable browser.', 'error'); return; }
        state.settings.modelProvider = p.id;
        $$('.chip[data-provider]').forEach(c => c.classList.remove('active'));
        $$('#model-provider-list .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        $('#api-key-section').style.display = (p.requiresKey) ? '' : 'none';
        $('#model-api-key').value = state.settings.apiKeys[p.id] || '';
        updateStoryBadgePreview();
      },
    }, [
      el('span', {}, p.name),
      badgeEl,
    ]);
    chip.setAttribute('data-provider', p.id);
    providerList.appendChild(chip);
  });

  // Reflect the initial provider: the API-key field only makes sense for key-based
  // providers (the default in-browser and rule-based modes need no key).
  const initialDef = story.MODEL_PROVIDERS.find(p => p.id === state.settings.modelProvider);
  $('#api-key-section').style.display = (initialDef && initialDef.requiresKey) ? '' : 'none';

  $('#btn-settings').addEventListener('click', () => $('#settings-modal').classList.add('open'));
  $('#btn-settings-close').addEventListener('click', () => $('#settings-modal').classList.remove('open'));
  $('#freshness-threshold').addEventListener('change', (e) => { state.settings.freshnessThresholdHours = parseInt(e.target.value, 10); });
  $('#btn-settings-save').addEventListener('click', () => {
    const provider = state.settings.modelProvider;
    const key = $('#model-api-key').value.trim();
    if (key) state.settings.apiKeys[provider] = key;
    $('#settings-modal').classList.remove('open');
    refreshFreshnessBadge();
    updateStoryBadgePreview();
    toast('Settings saved', 'success');
  });
}

// ============================================================
// In-app Diagnostics (?diag=1)
// ============================================================
// Visible on-page self-check: boots the engine, times it, and runs a trivial
// sanity query. Only activates when the URL carries ?diag=1 — the normal app
// is completely unaffected otherwise. Reuses the existing card / status-dot /
// mono CSS so it needs no new styles.
async function runDiagnostics() {
  const panel = el('div', { id: 'diag-panel', style: 'position:fixed; right:16px; bottom:16px; z-index:9999; max-width:440px; width:calc(100% - 32px);' });
  const card = el('div', { class: 'card', style: 'padding:var(--space-4);' });
  const head = el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); margin-bottom:var(--space-2);' }, [
    el('span', { style: 'font-weight:600; font-size:var(--text-lg); flex:1;' }, 'DATAGLOW Diagnostics'),
  ]);
  const closeBtn = el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs); padding:4px 8px;' }, 'Close');
  closeBtn.addEventListener('click', () => panel.remove());
  head.appendChild(closeBtn);
  card.appendChild(head);
  const rows = el('div', {});
  card.appendChild(rows);
  panel.appendChild(card);
  document.body.appendChild(panel);

  const addRow = (label, status, detail) => {
    rows.appendChild(el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) 0; border-top:1px solid var(--color-divider);', 'data-testid': `diag-${status}` }, [
      el('span', { class: `validation-status ${status}` }, [el('span', { class: `status-dot ${status}` }), status.toUpperCase()]),
      el('span', { style: 'flex:1; font-size:var(--text-sm);' }, label),
      el('span', { class: 'mono', style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, detail || ''),
    ]));
  };

  addRow('Page & modules loaded', 'pass', 'ok');

  let t0 = performance.now();
  try {
    await engine.initDuckDB();
    addRow('DuckDB-WASM engine init', 'pass', `${(performance.now() - t0).toFixed(0)} ms`);
  } catch (e) {
    addRow('DuckDB-WASM engine init', 'fail', e.message);
    return;
  }

  t0 = performance.now();
  try {
    const res = await engine.runQuery('SELECT 1 AS ok');
    const ok = res.rows.length === 1 && Number(res.rows[0].ok) === 1;
    addRow('Sanity query (SELECT 1)', ok ? 'pass' : 'fail', `${res.elapsedMs.toFixed(1)} ms`);
  } catch (e) {
    addRow('Sanity query (SELECT 1)', 'fail', e.message);
  }
}

// ============================================================
// Digital Twin — What-If Simulator (Gen 10 Batch 2, Feature 1)
// ============================================================
// Perturbs an in-memory SAMPLE of the active dataset and re-runs the exact same
// runAllLayers + Confidence-Calibrated Grades pipeline against a throwaway copy
// table (__twin_sim), never touching the real dataset. See js/digital-twin.js
// for the pure perturbation engine + isolation guarantee.
const TWIN_SAMPLE_CAP = 5000;      // rows pulled into the sandbox for live speed
const TWIN_TABLE = '__twin_sim';   // throwaway table, dropped/rebuilt each sim
let twinState = null;              // { table, cols, rows, sampled, total, knobs, baseline }
let twinSimSeq = 0;                // guards against out-of-order async renders

// A compact "concerns" summary of a results map: how many layers fail/warn.
function twinConcernSummary(results) {
  let fail = 0, warn = 0;
  for (const [k, v] of Object.entries(results)) {
    if (k === 'domainPack' || k === 'calibratedGrades' || k === 'confidence') continue;
    if (v && v.status === 'fail') fail++;
    else if (v && v.status === 'warn') warn++;
  }
  return { fail, warn };
}

function selectedPack() {
  const sel = $('#domain-pack-select');
  return sel && sel.value ? sel.value : 'healthcare';
}

// Run one what-if simulation: perturb the sampled rows, load them into the
// throwaway table, and run the full validation + grading pipeline on that copy.
// Simulations are serialized through twinChain because they share a single
// throwaway table (__twin_sim); overlapping runs would DROP it mid-query.
let twinChain = Promise.resolve();
function runTwinSimulation(knobs) {
  const run = () => runTwinSimulationInner(knobs);
  twinChain = twinChain.then(run, run);
  return twinChain;
}

async function runTwinSimulationInner(knobs) {
  const t = twinState;
  const { rows: pRows, columns: pCols } = digitalTwin.perturbRows(t.rows, t.cols, knobs);
  await ensureDuckDB();
  await engine.createTableFromRows(TWIN_TABLE, pCols, pRows);
  const schema = await engine.getTableSchema(TWIN_TABLE);
  const twinDs = {
    name: `${t.table}.__twin`, table: TWIN_TABLE, rowCount: pRows.length,
    cols: schema.map(s => ({ name: s.column_name, type: s.column_type })),
    loadedAt: Date.now(), isSynthetic: true,
  };
  // runAllLayers writes state.validationResults as a side effect; snapshot and
  // restore it so a what-if never clobbers the real Validate tab's state.
  const savedResults = state.validationResults;
  let results;
  try {
    results = await validation.runAllLayers(twinDs, {
      freshnessThresholdHours: state.settings.freshnessThresholdHours, pack: selectedPack(),
    });
  } finally {
    state.validationResults = savedResults;
  }
  return results;
}

function renderTwinComparison(baseline, sim) {
  const wrap = $('#twin-comparison');
  if (!wrap) return;
  const gradeColor = g => ({ A: 'var(--color-grade-a)', B: 'var(--color-grade-b)', C: 'var(--color-grade-c)', D: 'var(--color-grade-d)', F: 'var(--color-grade-d)' }[g] || 'var(--color-text-muted)');
  const axisRow = (label, baseAxis, simAxis, testid) => {
    const delta = digitalTwin.gradeDelta(baseAxis.grade, simAxis.grade);
    const arrow = delta < 0 ? '▼' : delta > 0 ? '▲' : '=';
    const arrowColor = delta < 0 ? 'var(--color-grade-d)' : delta > 0 ? 'var(--color-grade-a)' : 'var(--color-text-faint)';
    return el('div', { style: 'display:flex; align-items:center; gap:var(--space-3); padding:var(--space-2) 0; border-bottom:1px solid var(--color-divider);', 'data-testid': testid }, [
      el('div', { style: 'flex:1; font-size:var(--text-sm);' }, label),
      el('div', { style: `font-weight:700; font-size:var(--text-lg); color:${gradeColor(baseAxis.grade)};`, 'data-testid': `${testid}-baseline` }, baseAxis.grade),
      el('div', { style: `color:${arrowColor}; font-weight:700;` }, arrow),
      el('div', { style: `font-weight:700; font-size:var(--text-lg); color:${gradeColor(simAxis.grade)};`, 'data-testid': `${testid}-sim` }, simAxis.grade),
    ]);
  };
  const bc = twinConcernSummary(baseline);
  const sc = twinConcernSummary(sim);
  wrap.innerHTML = '';
  wrap.appendChild(el('div', { style: 'display:flex; gap:var(--space-3); font-size:var(--text-xs); color:var(--color-text-faint); padding-bottom:var(--space-2);' }, [
    el('div', { style: 'flex:1;' }, ''), el('div', {}, 'Baseline'), el('div', {}, '→'), el('div', {}, 'Simulated'),
  ]));
  wrap.appendChild(axisRow('Data Integrity', baseline.calibratedGrades.integrity, sim.calibratedGrades.integrity, 'twin-grade-integrity'));
  wrap.appendChild(axisRow('Domain Confidence', baseline.calibratedGrades.plausibility, sim.calibratedGrades.plausibility, 'twin-grade-plausibility'));
  wrap.appendChild(el('div', { style: 'padding:var(--space-2) 0; font-size:var(--text-sm);', 'data-testid': 'twin-flag-summary' }, [
    el('span', { style: 'flex:1;' }, 'Layers flagged (fail / warn): '),
    el('span', { style: 'color:var(--color-text-muted);' }, `${bc.fail}/${bc.warn}`),
    el('span', { style: 'color:var(--color-text-faint);' }, '  →  '),
    el('span', { style: 'font-weight:600;' }, `${sc.fail}/${sc.warn}`),
  ]));
}

const runTwinDebounced = debounce(async () => {
  if (!twinState) return;
  const seq = ++twinSimSeq;
  try {
    const sim = await runTwinSimulation(twinState.knobs);
    if (seq !== twinSimSeq) return; // a newer drag superseded this one
    renderTwinComparison(twinState.baseline, sim);
  } catch (err) {
    toast('Twin simulation failed: ' + (err && err.message || err), 'error');
  }
}, 220);

function renderTwinControls() {
  const host = $('#twin-controls');
  if (!host) return;
  host.innerHTML = '';
  const sliders = digitalTwin.inferPerturbations(twinState.cols);
  for (const s of sliders) {
    const valSpan = el('span', { style: 'min-width:38px; text-align:right; font-variant-numeric:tabular-nums; color:var(--color-text-muted);' }, `${twinState.knobs[s.key] || 0}%`);
    const input = el('input', {
      type: 'range', min: String(s.min), max: String(s.max), step: String(s.step),
      value: String(twinState.knobs[s.key] || 0), 'data-testid': `twin-slider-${s.key}`,
      style: 'flex:1;',
    });
    input.addEventListener('input', () => {
      twinState.knobs[s.key] = Number(input.value);
      valSpan.textContent = `${input.value}%`;
      runTwinDebounced();
    });
    host.appendChild(el('div', { style: 'margin-bottom:var(--space-3);' }, [
      el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:4px;' }, s.label),
      el('div', { style: 'display:flex; align-items:center; gap:var(--space-2);' }, [input, valSpan]),
    ]));
  }
}

// Build (or rebuild) the twin sandbox for the active dataset: sample its rows,
// compute the baseline grades on that same sample, and render controls.
let twinBuilding = false;
async function buildTwinControls() {
  const ds = getActiveDataset();
  const empty = $('#twin-empty');
  const body = $('#twin-body');
  if (!empty || !body) return;
  if (!ds) { empty.style.display = ''; body.style.display = 'none'; return; }
  empty.style.display = 'none'; body.style.display = '';
  // Reuse an existing sandbox if it's already built for this table.
  if (twinState && twinState.table === ds.table) { renderTwinControls(); return; }
  if (twinBuilding) return;
  twinBuilding = true;
  try {
    await ensureDuckDB();
    const { rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT ${TWIN_SAMPLE_CAP}`);
    twinState = {
      table: ds.table, cols: ds.cols.map(c => ({ name: c.name, type: c.type })),
      rows, sampled: ds.rowCount > TWIN_SAMPLE_CAP, total: ds.rowCount, knobs: {}, baseline: null,
    };
    const note = $('#twin-sample-note');
    if (twinState.sampled) {
      note.style.display = '';
      note.textContent = `For responsiveness, this what-if simulator runs on a sample of ${rows.length.toLocaleString()} rows out of ${ds.rowCount.toLocaleString()} total. Grades are indicative of the sample.`;
    } else {
      note.style.display = 'none';
    }
    renderTwinControls();
    // Baseline = the same sample with zero perturbation, so before/after is
    // an apples-to-apples comparison on identical rows.
    twinState.baseline = await runTwinSimulation({});
    renderTwinComparison(twinState.baseline, twinState.baseline);
  } catch (err) {
    toast('Could not build digital twin: ' + (err && err.message || err), 'error');
  } finally {
    twinBuilding = false;
  }
}

function initDigitalTwin() {
  const resetBtn = $('#btn-twin-reset');
  if (!resetBtn) return;
  resetBtn.addEventListener('click', () => {
    if (!twinState) return;
    twinState.knobs = {};
    renderTwinControls();
    if (twinState.baseline) renderTwinComparison(twinState.baseline, twinState.baseline);
  });
}

// ============================================================
// Ambient Watch Folder Mode (Gen 10 Batch 2, Feature 2)
// ============================================================
// Points DATAGLOW at a local folder via the File System Access API and polls it
// for new/changed files, running each through the SAME loaders.loadFile +
// runAllLayers path as a manual upload. Zero network I/O. See js/watch-folder.js.
let watchController = null;
const watchStatuses = new Map(); // name -> { name, ok, grade, detail, ts, driftAlert? }

// Semantic Drift Watchdog (feature-flagged: semanticDriftWatchdog). Computes no
// new statistics of its own — it de-duplicates alerts built from the
// distribution_drift layer runAllLayers() already returns on every re-check, so
// the Watch Folder poll loop (which re-validates a changed file automatically,
// with no manual click) doesn't re-show the SAME drift finding on every poll.
// One watchdog instance per session, matching watchStatuses' lifetime — both
// reset together whenever the user connects a (possibly different) folder.
let driftWatchdog = new DriftWatchdog();

function gradeFromResults(results) {
  if (results && results.calibratedGrades && results.calibratedGrades.integrity) {
    return results.calibratedGrades.integrity.grade;
  }
  if (results && results.confidence && results.confidence.grade) return results.confidence.grade;
  return '?';
}

function renderWatchStatus(headline) {
  const host = $('#watch-status');
  if (!host) return;
  host.innerHTML = '';
  if (headline) {
    host.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-bottom:var(--space-3);', 'data-testid': 'watch-headline' }, headline));
  }
  const items = [...watchStatuses.values()].sort((a, b) => b.ts - a.ts);
  if (!items.length) {
    host.appendChild(el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-faint);' }, 'No files validated yet.'));
    return;
  }
  for (const s of items) {
    host.appendChild(el('div', { style: 'display:flex; flex-direction:column; gap:4px; padding:var(--space-2) 0; border-bottom:1px solid var(--color-divider);', 'data-testid': `watch-file-${s.name}` }, [
      el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); font-size:var(--text-sm);' }, [
        el('span', { class: `status-dot ${s.ok ? 'pass' : 'fail'}` }),
        el('span', { class: 'mono', style: 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;' }, s.name),
        el('span', { style: 'font-weight:700;' }, s.ok ? `Grade ${s.grade}` : 'Error'),
        el('span', { style: 'color:var(--color-text-faint); font-size:var(--text-xs);' }, new Date(s.ts).toLocaleTimeString()),
      ]),
      s.driftAlert ? el('div', {
        class: `validation-status ${s.driftAlert.severity}`,
        style: 'font-size:var(--text-xs); padding-left:16px;',
        'data-testid': `watch-drift-${s.name}`,
      }, [
        el('span', { class: `status-dot ${s.driftAlert.severity}` }),
        el('span', {}, s.driftAlert.headline),
      ]) : null,
    ]));
  }
}

// The shared ingest path — deliberately the SAME functions the manual upload
// button uses (loaders.loadFile + validation.runAllLayers), not a copy.
async function watchIngestAndValidate(file, entry) {
  await ensureDuckDB();
  const ds = await loaders.loadFile(file);
  renderSidebar();
  resetPanelStates();
  const results = await validation.runAllLayers(ds, {
    freshnessThresholdHours: state.settings.freshnessThresholdHours, pack: selectedPack(),
  });
  let driftAlert = null;
  if (isEnabled('semanticDriftWatchdog')) {
    // Never let the watchdog's own de-duplication logic be the reason an
    // automatic re-check fails — same defensive stance as every other
    // ambient module here (e.g. the Analysis Contract card, ambient warnings).
    try {
      const fileName = (entry && entry.name) || file.name;
      const decision = driftWatchdog.observe(fileName, results.distribution_drift);
      if (decision.shouldNotify) {
        driftAlert = decision.summary;
        console.info('[semantic-drift-watchdog]', formatWatchdogAlert(fileName, decision));
      }
    } catch (e) { /* watchdog is informational only; never blocks ingest */ }
  }
  return { ds, results, grade: gradeFromResults(results), driftAlert };
}

function initWatchFolder() {
  const connectBtn = $('#btn-watch-connect');
  const stopBtn = $('#btn-watch-stop');
  if (!connectBtn) return;

  // Watch Folder is a browser-only capability (File System Access API). On the
  // Tauri desktop shell the registry doesn't load it, so degrade gracefully:
  // disable the control with a note instead of dereferencing an absent module.
  if (!watchFolder) {
    console.warn('[capability-registry] Watch Folder is browser-only and is not loaded on this runtime; skipping its wiring.');
    const msg = $('#watch-unsupported');
    if (msg) {
      msg.style.display = '';
      msg.textContent = 'Watch Folder is available in the browser build only.';
    }
    connectBtn.disabled = true;
    connectBtn.title = 'Not available in the desktop app';
    return;
  }

  $('#watch-privacy').textContent = watchFolder.PRIVACY_NOTICE;

  if (!watchFolder.directoryPickerSupported(window)) {
    const msg = $('#watch-unsupported');
    msg.style.display = '';
    msg.textContent = watchFolder.UNSUPPORTED_MESSAGE;
    connectBtn.disabled = true;
    connectBtn.title = 'Not supported in this browser';
    return;
  }

  watchController = new watchFolder.WatchFolderController({
    ingestAndValidate: watchIngestAndValidate,
    intervalMs: 4000,
  });
  watchController.onUpdate = ({ name, ok, result, error, ts }) => {
    watchStatuses.set(name, {
      name, ok, ts,
      grade: ok && result ? result.grade : null,
      detail: ok ? '' : (error && error.message || String(error)),
      driftAlert: ok && result ? result.driftAlert : null,
    });
    renderWatchStatus('Watching folder — files auto-validate on drop or change.');
  };
  watchController.onError = (err) => {
    stopBtn.style.display = 'none';
    connectBtn.style.display = '';
    renderWatchStatus('Permission lost or folder unavailable — please reconnect. (' + (err && err.message || err) + ')');
  };

  connectBtn.addEventListener('click', async () => {
    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker();
    } catch (err) {
      return; // user dismissed the native picker — not an error
    }
    await ensureDuckDB();
    watchStatuses.clear();
    driftWatchdog.clearAll(); // fresh folder — start the watchdog's memory clean
    await watchController.start(dirHandle);
    connectBtn.style.display = 'none';
    stopBtn.style.display = '';
    renderWatchStatus('Watching folder — files auto-validate on drop or change.');
    toast('Watching folder for changes', 'success');
  });

  stopBtn.addEventListener('click', () => {
    watchController.stop();
    stopBtn.style.display = 'none';
    connectBtn.style.display = '';
    renderWatchStatus('Stopped watching. Reconnect a folder to resume.');
    toast('Stopped watching folder', 'success');
  });

  // Don't leave a poll loop dangling if the user navigates away.
  window.addEventListener('beforeunload', () => { if (watchController) watchController.stop(); });

  // Test/automation hook: drive the controller with a mock directory handle so
  // the poll + ingest path can be exercised without the native picker (which
  // needs a user gesture and can't run headless). Not used in normal operation.
  window.__dataglowStartWatch = async (mockHandle) => {
    watchStatuses.clear();
    driftWatchdog.clearAll();
    await watchController.start(mockHandle);
    connectBtn.style.display = 'none';
    stopBtn.style.display = '';
    renderWatchStatus('Watching folder — files auto-validate on drop or change.');
    return watchController;
  };
  window.__dataglowWatchController = watchController;
}

// ============================================================
// Problem Framer
// ============================================================
// A pre-analysis wizard: intake → four fixed SMART-style prompts → restated
// analytical question → (if a dataset is loaded) keyword-matched column
// suggestions → one-page Markdown recap. All deterministic and offline; the
// pure logic lives in js/problem-framer.js and is exercised by test/.
function renderFramerQuestions() {
  const wrap = $('#framer-questions');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const q of problemFramer.REFRAMING_QUESTIONS) {
    wrap.appendChild(el('div', { class: 'framer-question' }, [
      el('label', { class: 'framer-q-label', for: `framer-q-${q.id}` }, q.label),
      el('input', {
        type: 'text',
        class: 'framer-input',
        id: `framer-q-${q.id}`,
        'data-framer-q': q.id,
        'data-testid': `input-framer-${q.id}`,
        placeholder: q.placeholder,
      }),
      el('div', { class: 'framer-q-hint' }, q.hint),
    ]));
  }
}

function collectFramerAnswers() {
  const answers = {};
  $$('[data-framer-q]').forEach((input) => { answers[input.dataset.framerQ] = input.value; });
  return answers;
}

function renderFramerOutput() {
  const out = $('#framer-output');
  const intake = $('#framer-intake').value;
  const answers = collectFramerAnswers();
  const ds = getActiveDataset();
  const columns = ds ? ds.cols.map((c) => c.name) : [];
  const analytical = problemFramer.buildAnalyticalQuestion(intake, answers);
  const suggestions = problemFramer.suggestColumns(intake, answers, columns);

  out.innerHTML = '';
  out.style.display = 'block';

  const card = el('div', { class: 'card framer-step' }, [
    el('div', { class: 'framer-step-title' }, '3 · Your restated analytical question'),
    el('div', { class: 'framer-restated', 'data-testid': 'framer-restated' }, analytical),
  ]);
  out.appendChild(card);

  // Step 4 — column mapping suggestion (only when a dataset is loaded).
  const colCard = el('div', { class: 'card framer-step' });
  colCard.appendChild(el('div', { class: 'framer-step-title' }, '4 · Suggested columns'));
  if (!ds) {
    colCard.appendChild(el('div', { class: 'framer-step-help', 'data-testid': 'framer-no-dataset' },
      'No dataset is loaded yet. Load a file from the sidebar to get column suggestions matched to your answers.'));
  } else if (suggestions.length === 0) {
    colCard.appendChild(el('div', { class: 'framer-step-help' },
      `Scanned ${columns.length} column${columns.length === 1 ? '' : 's'} in "${escapeHtml(ds.table)}" — nothing matched your wording yet. Try naming the metric or entity more directly above.`));
  } else {
    colCard.appendChild(el('div', { class: 'framer-step-help' },
      `Matched against the ${columns.length} columns in "${escapeHtml(ds.table)}":`));
    const list = el('div', { class: 'framer-col-suggestions', 'data-testid': 'framer-col-suggestions' });
    for (const s of suggestions) {
      list.appendChild(el('div', { class: 'framer-col-row' }, [
        el('span', {}, 'You mentioned '),
        el('span', { class: 'story-highlight' }, s.term),
        el('span', {}, ' — matching columns: '),
        el('span', { class: 'mono', html: s.columns.map((c) => escapeHtml(c)).join(', ') }),
      ]));
    }
    colCard.appendChild(list);
  }
  out.appendChild(colCard);

  // Step 5 — export.
  const exportCard = el('div', { class: 'card framer-step' }, [
    el('div', { class: 'framer-step-title' }, '5 · Share it'),
    el('div', { class: 'framer-step-help' }, 'Export a one-page Markdown recap to paste into a meeting note or ticket.'),
    el('div', { style: 'display:flex; gap:var(--space-2); flex-wrap:wrap;' }, [
      el('button', {
        class: 'btn btn-primary',
        id: 'btn-framer-export',
        'data-testid': 'button-framer-export',
        onclick: () => {
          const md = problemFramer.buildExportMarkdown({ intake, answers, columns });
          downloadText('dataglow-problem-framer.md', md, 'text/markdown');
          toast('Problem Framer recap downloaded', 'success');
        },
      }, 'Download Markdown'),
      el('button', {
        class: 'btn btn-secondary',
        id: 'btn-framer-copy',
        'data-testid': 'button-framer-copy',
        onclick: async () => {
          const md = problemFramer.buildExportMarkdown({ intake, answers, columns });
          try { await navigator.clipboard.writeText(md); toast('Recap copied to clipboard', 'success'); }
          catch (e) { toast('Copy failed: ' + e.message, 'error'); }
        },
      }, 'Copy Markdown'),
    ]),
  ]);
  out.appendChild(exportCard);
}

function initProblemFramer() {
  renderFramerQuestions();
  $('#btn-framer-build').addEventListener('click', renderFramerOutput);
  $('#btn-framer-reset').addEventListener('click', () => {
    $('#framer-intake').value = '';
    $$('[data-framer-q]').forEach((input) => { input.value = ''; });
    const out = $('#framer-output');
    out.style.display = 'none';
    out.innerHTML = '';
  });
}

// ============================================================
// Init
// ============================================================
function init() {
  renderTabBar();
  renderCommandDeckSidebar();
  renderRoomUiWidget();
  switchTab('preflight');
  initTheme();
  initFileLoading();
  initDatabricksConnect();
  initSqlTab();
  initPythonTab();
  initRTab();
  initVisualizeTab();
  initStoryTab();
  initSettings();
  initRedTeam();
  initMemory();
  initSelfLearning();
  initLayerPriority();
  initFederatedLearning();
  initAnonExport();
  initExportReport();
  initLedger();
  if (isEnabled('aiTouchLedger')) initAiTouchLedgerPanel();
  initProvenance();
  initDataBlame();
  initDeidVerifier();
  initDenialProfiler();
  initDomainPack();
  initDevilsAdvocate();
  initReceipts();
  initPeerReview();
  initTimeTravelDiff();
  initSyntheticTwin();
  initTimeMachine();
  initFederatedFingerprint();
  initIRBMode();
  initAISynthesis();
  initDigitalTwin();
  initWatchFolder();
  initProblemFramer();
  initCommunityPack();
  initCommandPalette();

  $('#btn-run-preflight').addEventListener('click', runPreflight);
  $('#btn-clean-scan').addEventListener('click', scanClean);
  $('#btn-validate-run').addEventListener('click', runValidation);

  renderSidebar();

  // Signal that the synchronous app init (DOM wiring, tabs, feature panels) is
  // done — independent of the async DuckDB-WASM warm-up below. The ambient
  // validation and SLM-degradation e2e paths key off this since they don't need
  // the SQL engine to be live.
  window.__dataglowInit = true;

  // Pre-warm the query engine in the background so it's live as soon as a
  // dataset is loaded. Sets window.__dataglowReady once the engine responds
  // (used by the Playwright e2e smoke test as its "app is live" signal). The
  // page stays fully interactive while this runs; a failure is recorded but
  // never blocks the UI.
  engine.initDuckDB()
    .then(() => { window.__dataglowReady = true; clearEngineError(); })
    .catch(err => {
      window.__dataglowInitError = String(err && err.message || err);
      // On the pre-isolation page the engine can't start (no SharedArrayBuffer),
      // but the service worker is about to reload us into an isolated context.
      // Show the transient "starting…" state instead of flashing a scary error
      // that the imminent reload would clear anyway.
      if (isolationPending()) { showEngineInitializing(); return; }
      // A failed pre-warm means nothing downstream will work — surface it now
      // rather than waiting for the user to click Load and get a silent no-op.
      showEngineError(err, async () => {
        await engine.initDuckDB();
        window.__dataglowReady = true;
        window.__dataglowInitError = undefined;
      });
    });

  if (new URLSearchParams(location.search).get('diag') === '1') {
    runDiagnostics();
  }
}

// Bootstrap: build the platform-aware capability registry, wire the migrated
// capability modules to their `let` bindings, then run the synchronous init.
// A registry failure is logged but never blocks the app shell coming up — the
// migrated feature panels guard for a missing module and degrade gracefully.
async function bootstrapCapabilities() {
  try {
    const registry = await loadRegistry();
    window.__dataglowRegistry = registry;

    // Universal (browser + desktop) modules migrated to the registry.
    domainPhysics = registry.get('domain-physics');

    // Gen 40 domain-pack plugin architecture (behind the `pluginPacks` flag).
    // Load the bundled flag manifest the same same-origin way the capability
    // manifest is loaded, then — if enabled — assemble the active pack source
    // from the self-contained plugin modules and install it into the engine.
    // Behaviour-identical to the legacy inline DOMAIN_PACKS map (the plugins
    // reference the same runtime pack objects); flipping the flag off falls back
    // to the inline map. Any failure here degrades to the legacy path.
    try {
      const flagsUrl = new URL('../../flags.manifest.json', import.meta.url);
      const flagsRes = await fetch(flagsUrl);
      if (flagsRes && flagsRes.ok) configureFlags(await flagsRes.json());
    } catch (flagErr) {
      console.warn('[pluginPacks] flag manifest unavailable; using legacy pack map:', flagErr);
    }
    if (isEnabled('pluginPacks') && domainPhysics && typeof domainPhysics.setPackSource === 'function') {
      try {
        packRegistry = loadBuiltInPacks();
        domainPhysics.setPackSource(packRegistry.toPackMap());
        window.__dataglowPackRegistry = packRegistry;
      } catch (packErr) {
        console.error('[pluginPacks] pack registry load failed; using legacy pack map:', packErr);
        packRegistry = undefined;
      }
    }
    devilsAdvocate = registry.get('devils-advocate');
    robustnessVerdictMod = registry.get('robustness-verdict');
    syntheticAdversarial = registry.get('synthetic-adversarial');
    receipt = registry.get('validation-receipt');
    peerReview = registry.get('peer-review');
    timeTravel = registry.get('time-travel-diff');
    syntheticTwin = registry.get('synthetic-twin');
    timeMachine = registry.get('time-machine');
    irbMode = registry.get('irb-mode');
    digitalTwin = registry.get('digital-twin');
    problemFramer = registry.get('problem-framer');
    exportReport = registry.get('export-report');
    microLessons = registry.get('micro-lessons');
    communityPack = registry.get('community-pack');

    // Browser-only: the Watch Folder relies on the File System Access API, which
    // the Tauri desktop shell deliberately excludes. On desktop, registry.get
    // returns undefined (with a warning) and initWatchFolder guards for it.
    watchFolder = registry.get('watch-folder');
  } catch (err) {
    console.error('[capability-registry] bootstrap failed; feature panels may be unavailable:', err);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await bootstrapCapabilities();
  init();
});
