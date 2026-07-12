import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTabGroups, groupForTab, TAB_GROUP_ORDER } from '../js/app-shell/tab-groups.js';

const FULL_ORDER = ['framer', 'preflight', 'sql', 'python', 'r', 'clean', 'validate', 'diff', 'visualize', 'story', 'twin', 'watch', 'meeting'];

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

test('buildTabGroups: a subset (meeting flag off) omits automate members cleanly, no crash', () => {
  const withoutMeeting = FULL_ORDER.filter((t) => t !== 'meeting');
  const groups = buildTabGroups(withoutMeeting);
  const automate = groups.find((g) => g.id === 'automate');
  assert.ok(automate);
  assert.deepEqual(automate.tabIds, ['twin', 'watch']);
});

test('buildTabGroups: preserves the caller-supplied relative order within each group (drag-reorder respected)', () => {
  // user dragged 'diff' before 'clean' within the validate cluster
  const reordered = ['framer', 'preflight', 'sql', 'python', 'r', 'diff', 'clean', 'validate', 'visualize', 'story', 'twin', 'watch'];
  const groups = buildTabGroups(reordered);
  const validateGroup = groups.find((g) => g.id === 'validate');
  assert.deepEqual(validateGroup.tabIds, ['diff', 'clean', 'validate']);
});

test('buildTabGroups: an unknown tab id lands in the trailing "more" group rather than being dropped', () => {
  const withUnknown = ['framer', 'some-future-tab', 'preflight'];
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

test('groupForTab: returns the correct group id for every known tab', () => {
  assert.equal(groupForTab('framer'), 'explore');
  assert.equal(groupForTab('preflight'), 'explore');
  assert.equal(groupForTab('validate'), 'validate');
  assert.equal(groupForTab('clean'), 'validate');
  assert.equal(groupForTab('diff'), 'validate');
  assert.equal(groupForTab('sql'), 'analyze');
  assert.equal(groupForTab('python'), 'analyze');
  assert.equal(groupForTab('r'), 'analyze');
  assert.equal(groupForTab('visualize'), 'share');
  assert.equal(groupForTab('story'), 'share');
  assert.equal(groupForTab('twin'), 'automate');
  assert.equal(groupForTab('watch'), 'automate');
  assert.equal(groupForTab('meeting'), 'automate');
});

test('groupForTab: an unknown tab id returns "more" rather than throwing or returning undefined', () => {
  assert.equal(groupForTab('totally-unknown-tab-id'), 'more');
});
