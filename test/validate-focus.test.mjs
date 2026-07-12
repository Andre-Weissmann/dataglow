import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldExpandAdvanced, createValidateFocusStore } from '../js/app-shell/validate-focus.js';

test('shouldExpandAdvanced: closed by default (neither run nor manually expanded)', () => {
  assert.equal(shouldExpandAdvanced({ hasRunOnce: false, wasManuallyExpanded: false }), false);
});

test('shouldExpandAdvanced: open once the user has run validation once', () => {
  assert.equal(shouldExpandAdvanced({ hasRunOnce: true, wasManuallyExpanded: false }), true);
});

test('shouldExpandAdvanced: open if the user manually expanded it, even with no run yet', () => {
  assert.equal(shouldExpandAdvanced({ hasRunOnce: false, wasManuallyExpanded: true }), true);
});

test('shouldExpandAdvanced: open when both are true', () => {
  assert.equal(shouldExpandAdvanced({ hasRunOnce: true, wasManuallyExpanded: true }), true);
});

test('shouldExpandAdvanced: tolerates missing/undefined fields without throwing, treats as false', () => {
  assert.equal(shouldExpandAdvanced({}), false);
  assert.equal(shouldExpandAdvanced({ hasRunOnce: undefined, wasManuallyExpanded: undefined }), false);
});

test('createValidateFocusStore: starts every dataset collapsed', () => {
  const store = createValidateFocusStore();
  assert.equal(store.isExpanded('golden_test_dataset'), false);
});

test('createValidateFocusStore: markRunOnce expands only that dataset, not others', () => {
  const store = createValidateFocusStore();
  store.markRunOnce('golden_test_dataset');
  assert.equal(store.isExpanded('golden_test_dataset'), true);
  assert.equal(store.isExpanded('other_dataset'), false);
});

test('createValidateFocusStore: markManuallyExpanded expands without a run', () => {
  const store = createValidateFocusStore();
  store.markManuallyExpanded('golden_test_dataset');
  assert.equal(store.isExpanded('golden_test_dataset'), true);
});

test('createValidateFocusStore: markCollapsed only reverses a manual expand, not an earned run', () => {
  const store = createValidateFocusStore();
  store.markRunOnce('golden_test_dataset');
  store.markCollapsed('golden_test_dataset');
  // still expanded — a real completed run is never taken away
  assert.equal(store.isExpanded('golden_test_dataset'), true);
});

test('createValidateFocusStore: markCollapsed reverses a manual-only expand', () => {
  const store = createValidateFocusStore();
  store.markManuallyExpanded('golden_test_dataset');
  store.markCollapsed('golden_test_dataset');
  assert.equal(store.isExpanded('golden_test_dataset'), false);
});

test('createValidateFocusStore: isExpanded is false and never throws for a falsy/undefined key', () => {
  const store = createValidateFocusStore();
  assert.equal(store.isExpanded(null), false);
  assert.equal(store.isExpanded(undefined), false);
  assert.equal(store.isExpanded(''), false);
});

test('createValidateFocusStore: markRunOnce/markManuallyExpanded tolerate a falsy key without throwing', () => {
  const store = createValidateFocusStore();
  assert.doesNotThrow(() => store.markRunOnce(null));
  assert.doesNotThrow(() => store.markManuallyExpanded(undefined));
});
