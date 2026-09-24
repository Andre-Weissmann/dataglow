// ============================================================
// DATAGLOW — The Bench shell test suite (Batch 1: lineage algebra)
// ============================================================
// Proves the PURE lineage algebra in js/app-shell/bench-shell.js:
//   - createLineage starts empty
//   - addStep appends, auto-assigns an incrementing id + timestamp, and is
//     PURE (never mutates its input)
//   - a lineage caps at MAX_STEPS (12) by dropping the oldest, never grows
//     unbounded (a story strip, not a log)
//   - serialize/deserialize round-trip, incl. empty lineage and the critical
//     edge case: malformed JSON -> safe empty lineage, NEVER throws
//   - renderStoryStrip (DOM) renders steps in order, marks the last as
//     "current", and degrades gracefully to an empty-state message
//
// RUN WITH: node test/bench-shell.test.mjs (pure logic + jsdom-free basic DOM)

import assert from 'node:assert/strict';
import {
  LINEAGE_STEP_KINDS,
  createLineage,
  addStep,
  clearLineage,
  serializeLineage,
  deserializeLineage,
  renderStoryStrip,
} from '../js/app-shell/bench-shell.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- createLineage ----------
{
  const l = createLineage();
  ok(Array.isArray(l.steps) && l.steps.length === 0, 'createLineage starts with an empty steps array');
  ok(l.nextId === 1, 'createLineage starts nextId at 1');
}

// ---------- exported vocab ----------
ok(JSON.stringify(LINEAGE_STEP_KINDS) === JSON.stringify(['upload', 'clean', 'sql', 'python', 'r', 'formula']),
  'LINEAGE_STEP_KINDS is the six known instrument kinds');

// ---------- addStep: append + auto id, PURE ----------
{
  const l0 = createLineage();
  const l1 = addStep(l0, { kind: 'upload', label: 'Uploaded (66,774 rows)', ts: 1000 });
  ok(l1.steps.length === 1, 'addStep appends one step');
  ok(l1.steps[0].id === 1, 'first step gets id 1');
  ok(l1.steps[0].kind === 'upload' && l1.steps[0].label === 'Uploaded (66,774 rows)', 'addStep carries the supplied fields');
  ok(l1.nextId === 2, 'nextId advances after an add');
  ok(l0.steps.length === 0, 'addStep never mutates the input lineage (still empty)');

  const l2 = addStep(l1, { kind: 'sql', label: 'Grouped by provider (SQL)', ts: 2000 });
  ok(l2.steps.length === 2 && l2.steps[1].id === 2, 'a second addStep appends after the first, with the next id');
  ok(l1.steps.length === 1, 'addStep on l1 never mutated l1 itself');
}

// ---------- addStep: trims/validates label, accepts unknown kind ----------
{
  const l0 = createLineage();
  assert.throws(() => addStep(l0, { kind: 'sql', label: '' }), /non-empty label/, 'addStep rejects an empty label');
  assert.throws(() => addStep(l0, { kind: 'sql', label: '   ' }), /non-empty label/, 'addStep rejects a whitespace-only label');
  const l1 = addStep(l0, { kind: 'totally-new-instrument', label: 'Ran a future instrument' });
  ok(l1.steps[0].kind === 'totally-new-instrument', 'addStep accepts an unknown kind rather than throwing');
  const l2 = addStep(l0, { label: '  trims me  ' });
  ok(l2.steps[0].label === 'trims me', 'addStep trims whitespace from the label');
  ok(l2.steps[0].kind === 'other', 'addStep defaults kind to "other" when omitted');
}

// ---------- MAX_STEPS cap: a story, not a log ----------
{
  let l = createLineage();
  for (let i = 0; i < 20; i++) {
    l = addStep(l, { kind: 'sql', label: `step ${i}`, ts: i });
  }
  ok(l.steps.length === 12, 'lineage caps at 12 steps even after 20 adds');
  ok(l.steps[0].label === 'step 8', 'capping drops the OLDEST steps, keeping the most recent 12');
  ok(l.steps[11].label === 'step 19', 'the most recent add is always the last step');
  ok(l.nextId === 21, 'nextId keeps counting up even while steps are capped/dropped');
}

// ---------- clearLineage ----------
{
  let l = addStep(createLineage(), { kind: 'upload', label: 'x' });
  l = clearLineage();
  ok(l.steps.length === 0 && l.nextId === 1, 'clearLineage resets to a fresh empty lineage');
}

// ---------- serialize / deserialize round-trip ----------
{
  const l0 = createLineage();
  ok(deserializeLineage(serializeLineage(l0)).steps.length === 0, 'empty lineage round-trips through serialize/deserialize');

  let l1 = addStep(createLineage(), { kind: 'upload', label: 'Uploaded (100 rows)', ts: 500 });
  l1 = addStep(l1, { kind: 'python', label: 'risk_score added (Python)', ts: 600 });
  const round = deserializeLineage(serializeLineage(l1));
  ok(round.steps.length === 2, 'a 2-step lineage round-trips with both steps intact');
  ok(round.steps[1].label === 'risk_score added (Python)' && round.steps[1].kind === 'python',
    'round-tripped step fields are exact (label + kind)');
  ok(round.nextId === l1.nextId, 'round-tripped nextId matches the original');
}

// ---------- deserializeLineage never throws on malformed input ----------
{
  ok(deserializeLineage('not json at all').steps.length === 0, 'garbage string -> safe empty lineage, no throw');
  ok(deserializeLineage('{}').steps.length === 0, 'empty object -> safe empty lineage, no throw');
  ok(deserializeLineage('{"steps": "not-an-array", "nextId": 1}').steps.length === 0,
    'wrong-typed steps field -> safe empty lineage, no throw');
  ok(deserializeLineage(null).steps.length === 0, 'null input -> safe empty lineage, no throw');
  ok(deserializeLineage(undefined).steps.length === 0, 'undefined input -> safe empty lineage, no throw');
}

// ---------- renderStoryStrip (minimal DOM stub, no jsdom dependency) ----------
{
  // Minimal fake DOM node sufficient for renderStoryStrip's usage of
  // innerHTML/classList/appendChild/textContent/dataset — avoids pulling in
  // a jsdom devDependency just for this one pure-logic-adjacent test.
  function makeFakeElement(tag) {
    return {
      tagName: tag,
      className: '',
      children: [],
      dataset: {},
      textContent: '',
      classList: {
        list: new Set(),
        add(c) { this.list.add(c); },
      },
      get innerHTML() { return this._html || ''; },
      set innerHTML(v) { this._html = v; this.children = []; },
      appendChild(child) { this.children.push(child); },
    };
  }
  const origCreateElement = globalThis.document?.createElement;
  const fakeDoc = {
    createElement: (tag) => makeFakeElement(tag),
  };
  globalThis.document = fakeDoc;

  const container = makeFakeElement('div');
  renderStoryStrip(container, createLineage());
  ok(container.classList.list.has('bench-story-strip'), 'renderStoryStrip tags the container with the strip class');
  ok(container.children.length === 2, 'empty lineage renders a label + an empty-state message (2 children)');
  ok(container.children[1].className === 'bench-story-empty', 'empty lineage shows the bench-story-empty message');

  let l = addStep(createLineage(), { kind: 'upload', label: 'Uploaded (10 rows)' });
  l = addStep(l, { kind: 'sql', label: 'Grouped by provider' });
  const container2 = makeFakeElement('div');
  renderStoryStrip(container2, l);
  // label + step1 + arrow + step2 = 4 children
  ok(container2.children.length === 4, 'a 2-step lineage renders label + step + arrow + step (4 children)');
  const lastChip = container2.children[3];
  ok(lastChip.className.includes('current'), 'the LAST step is marked current');
  const firstChip = container2.children[1];
  ok(!firstChip.className.includes('current'), 'earlier steps are NOT marked current');

  renderStoryStrip(null, l);
  ok(true, 'renderStoryStrip(null, ...) does not throw');

  if (origCreateElement) globalThis.document.createElement = origCreateElement;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
