import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTabGroups, groupForTab, TAB_GROUP_ORDER } from '../js/app-shell/tab-groups.js';

// Core 6 + power-user tabs (no council -- merged into nlsql AI tab)
const FULL_ORDER = ['preflight', 'sql', 'clean', 'validate', 'nlsql', 'dvc', 'framer', 'python', 'r', 'diff', 'visualize', 'story', 'twin', 'watch', 'meeting'];

test('buildTabGroups: every input tab id appears exactly once across all groups', () => {
  const groups = buildTabGroups(FULL_ORDER);
  const seen = groups.flatMap((g) => g.tabIds);
  assert.deepEqual([...seen].sort(), [...FULL_ORDER].sort());
  // no duplicates
  assert.equal(new Set(seen).size, seen.length);
});

test('buildTabGroups: groups render in TAB_GROUP_ORDER, skipping empty groups', () => {
  const groups = buildTabGroups(FULL_ORDER);
  const ids = groups.map((g) => g.id);
  // every id present must be in the canonical order, in the same relative sequence
  const filteredCanonical = TAB_GROUP_ORDER.filter((g) => ids.includes(g));
  assert.deepEqual(ids, filteredCanonical);
});

test('buildTabGroups: core group contains exactly the 6 core tabs', () => {
  const groups = buildTabGroups(FULL_ORDER);
  const core = groups.find((g) => g.id === 'core');
  assert.ok(core, 'core group present');
  assert.deepEqual(core.tabIds.sort(), ['clean', 'dvc', 'nlsql', 'preflight', 'sql', 'validate'].sort());
});

test('buildTabGroups: power-user tabs land in the more group', () => {
  const groups = buildTabGroups(FULL_ORDER);
  const more = groups.find((g) => g.id === 'more');
  assert.ok(more, 'more group present');
  assert.ok(more.tabIds.includes('framer'));
  assert.ok(more.tabIds.includes('python'));
  assert.ok(more.tabIds.includes('visualize'));
});

test('buildTabGroups: an unknown tab id lands in the trailing "more" group rather than being dropped', () => {
  const withUnknown = ['preflight', 'some-future-tab', 'sql'];
  const groups = buildTabGroups(withUnknown);
  const seen = groups.flatMap((g) => g.tabIds);
  assert.ok(seen.includes('some-future-tab'));
  const moreGroup = groups.find((g) => g.id === 'more');
  assert.ok(moreGroup);
  assert.ok(moreGroup.tabIds.includes('some-future-tab'));
});

test('buildTabGroups: empty input returns an empty array, never throws', () => {
  assert.deepEqual(buildTabGroups([]), []);
});

test('buildTabGroups: every group entry has an id, label, and non-empty tabIds', () => {
  const groups = buildTabGroups(FULL_ORDER);
  groups.forEach((g) => {
    assert.equal(typeof g.id, 'string');
    assert.equal(typeof g.label, 'string');
    assert.ok(g.label.length > 0);
    assert.ok(Array.isArray(g.tabIds));
    assert.ok(g.tabIds.length > 0);
  });
});

test('groupForTab: core tabs return core group id', () => {
  assert.equal(groupForTab('preflight'), 'core');
  assert.equal(groupForTab('sql'), 'core');
  assert.equal(groupForTab('clean'), 'core');
  assert.equal(groupForTab('validate'), 'core');
  assert.equal(groupForTab('nlsql'), 'core');
  assert.equal(groupForTab('dvc'), 'core');
});

test('groupForTab: non-core tabs return more', () => {
  assert.equal(groupForTab('framer'), 'more');
  assert.equal(groupForTab('python'), 'more');
  assert.equal(groupForTab('r'), 'more');
  assert.equal(groupForTab('visualize'), 'more');
  assert.equal(groupForTab('story'), 'more');
  assert.equal(groupForTab('twin'), 'more');
  assert.equal(groupForTab('watch'), 'more');
  assert.equal(groupForTab('meeting'), 'more');
});

test('groupForTab: an unknown tab id returns "more" rather than throwing or returning undefined', () => {
  assert.equal(groupForTab('totally-unknown-tab-id'), 'more');
});
