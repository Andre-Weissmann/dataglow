// Data Diplomacy, Batch 2 — Diplomacy tab flag-gating.
//
// Proves the SAME property the Meeting tab's gate guarantees (see
// test/meeting-scribe-ui.test.mjs): with the flag OFF, the tab id is not merely
// hidden but genuinely absent from the tab list main.js renders, so it is never
// a dead click target. meetingScribe's gate is a pure predicate exercised in a
// booted page; DATAGLOW's tab bar instead gates inline in renderTabBar() via
// `isEnabled(...)` over state.tabOrder, so this mirrors that gate at its real
// inputs — the REAL flags.manifest.json + the REAL build-flags isEnabled + the
// REAL state.tabOrder — without booting the whole DuckDB/Plotly app, and also
// regex-reads main.js so the gate can't be silently deleted (the drift-proofing
// approach test/command-deck-nav.test.mjs already uses against main.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { configureFlags, isEnabled, resetFlags } from '../js/build/build-flags.js';
import { state } from '../js/app-shell/state.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'flags.manifest.json'), 'utf8'));
const mainSrc = readFileSync(join(ROOT, 'js/app-shell/main.js'), 'utf8');

// The exact predicate renderTabBar() uses to decide the rendered tab list.
// Kept in lockstep with main.js — the source assertion below fails loudly if
// main.js's real filter ever stops gating 'diplomacy' on 'dataDiplomacy'.
const visibleTabOrder = () => state.tabOrder.filter((tabId) =>
  (tabId !== 'meeting' || isEnabled('meetingScribe'))
  && (tabId !== 'diplomacy' || isEnabled('dataDiplomacy')));

test('the diplomacy tab id exists in the app\'s real tab order', () => {
  assert.ok(state.tabOrder.includes('diplomacy'), 'diplomacy must be a slot in state.tabOrder');
});

test('shipped default: dataDiplomacy is ON, so the diplomacy tab is present in the rendered bar', () => {
  configureFlags(manifest); // load the REAL manifest as shipped
  assert.equal(isEnabled('dataDiplomacy'), true, 'dataDiplomacy now ships ON (Diplomacy tab live)');
  const visible = visibleTabOrder();
  assert.ok(visible.includes('diplomacy'), 'flag ON → diplomacy must be in the rendered tab list');
  // The gate must not disturb any other tab: everything is still there.
  for (const tabId of state.tabOrder) {
    if (tabId === 'meeting') continue;
    assert.ok(visible.includes(tabId), `unrelated tab "${tabId}" must be unaffected by the diplomacy gate`);
  }
});

test('gate mechanics: forcing dataDiplomacy OFF still removes the diplomacy tab', () => {
  configureFlags({ flags: { dataDiplomacy: { enabled: false } } });
  assert.equal(isEnabled('dataDiplomacy'), false);
  assert.ok(!visibleTabOrder().includes('diplomacy'), 'flag OFF → diplomacy must NOT be in the rendered tab list');
  resetFlags();
});

test('flag ON: the diplomacy tab appears in the rendered bar', () => {
  configureFlags({ flags: { dataDiplomacy: { enabled: true } } });
  assert.equal(isEnabled('dataDiplomacy'), true);
  assert.ok(visibleTabOrder().includes('diplomacy'), 'flag ON → diplomacy must be in the rendered tab list');
  resetFlags();
});

test('drift guard: main.js really gates the diplomacy tab on isEnabled(\'dataDiplomacy\')', () => {
  // Locate the shared tab-visibility filter (getVisibleTabIds, extracted from
  // renderTabBar so both the top tab bar and the Command Deck sidebar reuse the
  // SAME gate -- see the drillFloor sidebar-leak fix) and assert the diplomacy
  // gate is present inside it, so a refactor can't silently drop the flag check.
  assert.match(mainSrc, /state\.tabOrder\.filter/, 'could not find the shared tab-visibility filter (getVisibleTabIds) in main.js');
  assert.match(mainSrc, /tabId\s*!==\s*'diplomacy'\s*\|\|\s*isEnabled\('dataDiplomacy'\)/,
    'main.js\'s shared tab-visibility filter must gate the diplomacy tab on isEnabled(\'dataDiplomacy\')');
});

test('drift guard: switchTab dispatches to renderDiplomacyTab', () => {
  assert.match(mainSrc, /tabId === 'diplomacy'\s*\)\s*renderDiplomacyTab\(\)/,
    'switchTab must call renderDiplomacyTab() for the diplomacy tab');
});
