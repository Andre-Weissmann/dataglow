// Command Deck, Part 1 — pure sidebar-regroup logic. No DOM/browser needed
// (matches this repo's convention for ships-dark logic with no wiring yet
// as the DEFAULT nav — Part 1 ships as an alternate sidebar behind the
// `dataglowSidebarNav` flag; the top tab bar stays default until reviewed).
//
// The coverage tests below read main.js's REAL TAB_META/state.js's REAL
// tabOrder directly off disk (regex-extracted, not hand-copied) so this
// suite can never silently drift out of sync with the actual 13 tabs the
// way a hand-maintained duplicate list could.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  COMMAND_DECK_STAGES,
  buildSidebarContent,
  validateStageCoverage,
  stageForTab,
} from '../js/app-shell/command-deck-nav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function readRealTabIds() {
  const mainSrc = readFileSync(join(repoRoot, 'js/app-shell/main.js'), 'utf8');
  const block = mainSrc.match(/const TAB_META = \{([\s\S]*?)\};/);
  assert.ok(block, 'could not locate TAB_META block in main.js — has it moved or been renamed?');
  const ids = [...block[1].matchAll(/^\s*([a-zA-Z0-9_]+):\s*\{/gm)].map(m => m[1]);
  assert.ok(ids.length > 0, 'TAB_META regex matched zero tab ids — check the regex against the real file');
  return ids;
}

function readRealTabMeta() {
  const mainSrc = readFileSync(join(repoRoot, 'js/app-shell/main.js'), 'utf8');
  const block = mainSrc.match(/const TAB_META = \{([\s\S]*?)\};/)[1];
  const meta = {};
  for (const m of block.matchAll(/^\s*([a-zA-Z0-9_]+):\s*\{\s*label:\s*'([^']*)',\s*icon:\s*'([^']*)'\s*\}/gm)) {
    meta[m[1]] = { label: m[2], icon: m[3] };
  }
  return meta;
}

// ---------- Coverage against the REAL app (the drift-proofing) ----------

test('coverage: every real tab in main.js TAB_META is assigned to exactly one Command Deck stage', () => {
  const realIds = readRealTabIds();
  const { ok, missing, stale } = validateStageCoverage(realIds);
  assert.deepEqual(missing, [], `real tabs not covered by any stage: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `stage lists tabs that no longer exist in main.js: ${stale.join(', ')}`);
  assert.equal(ok, true);
});

test('coverage: no tab id appears in more than one stage', () => {
  const seen = new Set();
  const dupes = [];
  for (const stage of COMMAND_DECK_STAGES) {
    for (const tabId of stage.tabs) {
      if (seen.has(tabId)) dupes.push(tabId);
      seen.add(tabId);
    }
  }
  assert.deepEqual(dupes, []);
});

test('coverage: exactly 5 stages, matching the report\u2019s Frame/Work/Trust/Generate/Tell naming decision', () => {
  assert.equal(COMMAND_DECK_STAGES.length, 5);
  assert.deepEqual(COMMAND_DECK_STAGES.map(s => s.id), ['frame', 'work', 'trust', 'generate', 'tell']);
  assert.deepEqual(COMMAND_DECK_STAGES.map(s => s.label), ['Frame', 'Work', 'Trust', 'Generate', 'Tell']);
});

// ---------- buildSidebarContent: pure content model ----------

test('buildSidebarContent: resolves real label/icon for every tab from the given tabMeta', () => {
  const tabMeta = readRealTabMeta();
  const { stages } = buildSidebarContent({ tabMeta, activeTab: 'sql' });
  const workStage = stages.find(s => s.id === 'work');
  const sqlTab = workStage.tabs.find(t => t.id === 'sql');
  assert.equal(sqlTab.label, 'SQL');
  assert.equal(sqlTab.icon, 'database');
});

test('buildSidebarContent: marks only the active tab as active, and flags its stage as containing the active tab', () => {
  const tabMeta = readRealTabMeta();
  const { stages } = buildSidebarContent({ tabMeta, activeTab: 'validate' });
  const trustStage = stages.find(s => s.id === 'trust');
  const otherStages = stages.filter(s => s.id !== 'trust');

  assert.equal(trustStage.containsActive, true);
  assert.ok(trustStage.tabs.find(t => t.id === 'validate').active);
  for (const s of otherStages) assert.equal(s.containsActive, false);

  // Exactly one active tab across the whole sidebar.
  const activeCount = stages.flatMap(s => s.tabs).filter(t => t.active).length;
  assert.equal(activeCount, 1);
});

test('buildSidebarContent: no active tab given \u2192 no stage claims to contain the active tab', () => {
  const tabMeta = readRealTabMeta();
  const { stages } = buildSidebarContent({ tabMeta });
  assert.ok(stages.every(s => s.containsActive === false));
});

test('buildSidebarContent: only lists tabs that actually exist in the given tabMeta \u2014 never invents one', () => {
  const partialMeta = { sql: { label: 'SQL', icon: 'database' } }; // deliberately incomplete
  const { stages } = buildSidebarContent({ tabMeta: partialMeta, activeTab: 'sql' });
  const allListed = stages.flatMap(s => s.tabs).map(t => t.id);
  assert.deepEqual(allListed, ['sql']);
});

test('buildSidebarContent: surfaces any real tab not covered by a stage as unassignedTabs, never silently drops it', () => {
  const tabMeta = { sql: { label: 'SQL', icon: 'database' }, mystery: { label: 'Mystery Tool', icon: 'compass' } };
  const { unassignedTabs } = buildSidebarContent({ tabMeta });
  assert.deepEqual(unassignedTabs, ['mystery']);
});

test('buildSidebarContent: handles zero tabMeta given (still returns 5 empty stages, no crash)', () => {
  const { stages, unassignedTabs } = buildSidebarContent({});
  assert.equal(stages.length, 5);
  assert.ok(stages.every(s => s.tabs.length === 0));
  assert.deepEqual(unassignedTabs, []);
});

// ---------- stageForTab ----------

test('stageForTab: returns the correct stage id for a real tab', () => {
  assert.equal(stageForTab('validate'), 'trust');
  assert.equal(stageForTab('diff'), 'trust');
  assert.equal(stageForTab('sql'), 'work');
  assert.equal(stageForTab('story'), 'tell');
});

test('stageForTab: returns null for an unmapped/unknown tab id', () => {
  assert.equal(stageForTab('not-a-real-tab'), null);
});

// ---------- validateStageCoverage: direct unit tests (beyond the real-app check above) ----------

test('validateStageCoverage: reports a missing tab explicitly', () => {
  const result = validateStageCoverage(['sql', 'a-new-tab-not-yet-mapped']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['a-new-tab-not-yet-mapped']);
});

test('validateStageCoverage: reports a stale mapped tab that no longer exists', () => {
  // Every real COMMAND_DECK_STAGES tab except 'sql' will show up as stale
  // when the "real" list is just ['sql'].
  const result = validateStageCoverage(['sql']);
  assert.equal(result.ok, false);
  assert.ok(result.stale.length > 0);
  assert.ok(!result.stale.includes('sql'));
});

test('validateStageCoverage: ok true when the real list exactly matches the mapped tabs', () => {
  const allMapped = COMMAND_DECK_STAGES.flatMap(s => s.tabs);
  const result = validateStageCoverage(allMapped);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.stale, []);
});

// ---------- Sidebar flag-awareness (regression guard) ----------
//
// Found during drillFloor's pre-flight (2026-07-18): buildSidebarContent()
// itself is deliberately flag-unaware (pure grouping over whatever tabMeta it
// is given -- see the file header). That is correct in isolation, but it means
// the CALLER in main.js (renderCommandDeckSidebar) is solely responsible for
// filtering TAB_META down to only flag-enabled tabs before calling it. That
// filtering was missing entirely when the Command Deck sidebar first shipped,
// so any dark-flagged tab with a real TAB_META entry (drillFloor, at the time)
// was visible in the sidebar even while its flag was false -- even though the
// SAME tab was correctly hidden from the top tab bar. Fixed by extracting the
// tab bar's gate into a shared getVisibleTabIds() and having the sidebar
// filter TAB_META through it before calling buildSidebarContent(). This test
// regex-reads main.js so that gate can never silently regress again.
test('regression guard: renderCommandDeckSidebar filters TAB_META by the shared visible-tab gate before building sidebar content, never the raw TAB_META', () => {
  const mainSrc = readFileSync(join(repoRoot, 'js/app-shell/main.js'), 'utf8');
  const fnMatch = mainSrc.match(/function renderCommandDeckSidebar\(\) \{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, 'could not locate renderCommandDeckSidebar() in main.js — has it moved or been renamed?');
  const fnBody = fnMatch[1];

  assert.doesNotMatch(
    fnBody,
    /buildSidebarContent\(\{\s*tabMeta:\s*TAB_META\s*,/,
    'renderCommandDeckSidebar must NOT pass the raw, unfiltered TAB_META into buildSidebarContent — that is exactly how a dark-flagged tab (e.g. drillFloor) leaked into the sidebar while its flag was off',
  );
  assert.match(
    fnBody,
    /getVisibleTabIds\(\)/,
    'renderCommandDeckSidebar must call the shared getVisibleTabIds() gate (the same one renderTabBar uses) before building sidebar content',
  );
});
