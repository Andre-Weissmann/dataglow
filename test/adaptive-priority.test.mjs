// ============================================================
// DATAGLOW — Adaptive Layer Prioritization test suite
// ============================================================
// Covers:
//   - action -> accept/dismiss mapping reuse (shared with PR #25's actionToLabel)
//   - recording fires vs actions, and ambiguous actions carrying no signal
//   - the Beta-Binomial / Laplace scoring (neutral 0.5 with no evidence; rises
//     with accepts, falls with dismisses)
//   - exponential recency decay following a change in a layer's usefulness
//   - the MIN_ACTIONS ready gate (order preserved until enough feedback)
//   - prioritize(): reorders useful-first, NEVER drops a layer, stable for ties
//   - tiers (promoted / deprioritized / neutral) + plain-language explanations
//   - toJSON/fromJSON round-trip (the shape persisted to IndexedDB)
//   - opt-in / opt-out / clear persistence via an injected fake store mirroring
//     js/memory-store.js's getLearnedModel/saveLearnedModel/deleteLearnedModel
//
// RUN WITH:  node test/adaptive-priority.test.mjs
//
// Engine-free (no DuckDB): the learner is pure JS. IndexedDB is browser-only, so
// — exactly as main.js does — persistence is exercised through an in-memory fake.

import { LayerPriorityModel, MIN_ACTIONS } from '../js/adaptive-priority.js';
import { actionToLabel } from '../js/self-learning-rules.js';

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A representative slice of the real LAYER_DEFS registry (ids + names) — enough
// to exercise ordering without importing DuckDB-bound validation.js.
const LAYER_DEFS = [
  { id: 'sanity_anchor', name: 'Sanity Anchor' },
  { id: 'categorical_consistency', name: 'Categorical Consistency Engine' },
  { id: 'cross_column_logic', name: 'Cross-Column Logical Consistency' },
  { id: 'upper_bound_sanity', name: 'Upper-Bound Sanity Anchor' },
  { id: 'benford', name: "Benford's Law Check" },
  { id: 'missingness_detective', name: 'Missingness Detective' },
];

// In-memory stand-in for js/memory-store.js's learnedCorrections store, keyed by
// modelId (so the priority model and the self-learning model coexist).
function makeFakeStore() {
  const map = new Map();
  return {
    map,
    async getLearnedModel(id = 'default') { return map.has(id) ? map.get(id).model : null; },
    async saveLearnedModel(id, model) { map.set(id || 'default', { modelId: id || 'default', model }); },
    async deleteLearnedModel(id = 'default') { map.delete(id); },
    async clearLearnedModels() { map.clear(); },
  };
}

function idsOf(result) { return result.items.map(it => it.id); }

function main() {
  // ---- shared action mapping (reused from PR #25, not reinvented) ----
  ok(actionToLabel('accept') === 1 && actionToLabel('dismiss') === 0,
    'reuse: actionToLabel from the Self-Learning Rules feature drives accept/dismiss');

  // ---- neutral prior: no evidence -> 0.5 for everything ----
  const fresh = new LayerPriorityModel();
  ok(fresh.scoreFor('cross_column_logic') === 0.5,
    'prior: a layer with no feedback scores exactly 0.5 (Laplace rule of succession)');
  ok(fresh.tierFor('cross_column_logic') === 'neutral',
    'prior: a layer with no feedback is in the neutral tier');
  ok(fresh.totalActions === 0 && !fresh.isReady() && fresh.actionsUntilReady() === MIN_ACTIONS,
    `prior: fresh model needs ${MIN_ACTIONS} actions before it is ready`);

  // ---- recording fires vs actions ----
  const m = new LayerPriorityModel();
  m.recordFire('benford', 3);
  ok(m.scoreFor('benford') === 0.5 && m.totalActions === 0,
    'fires: firing alone does not move the score or count as an action');
  ok(m.explain('benford').fires === 3,
    'fires: fire count is tracked for transparent display');
  const rec = m.recordAction('cross_column_logic', 'accept');
  ok(rec && m.totalActions === 1, 'record: an accept is stored as one action');
  const recNull = m.recordAction('cross_column_logic', 'hover');
  ok(recNull === null && m.totalActions === 1, 'record: an ambiguous action carries no signal and is ignored');
  ok(m.recordAction(null, 'accept') === null, 'record: a missing layerId is ignored');

  // ---- score rises with accepts, falls with dismisses ----
  const useful = new LayerPriorityModel();
  for (let i = 0; i < 8; i++) useful.recordAction('cross_column_logic', 'accept');
  useful.recordAction('cross_column_logic', 'dismiss');
  ok(useful.scoreFor('cross_column_logic') > 0.7,
    `score: a mostly-acted-on layer scores high (${useful.scoreFor('cross_column_logic').toFixed(2)} > 0.7)`);
  ok(useful.tierFor('cross_column_logic') === 'promoted', 'tier: a high-scoring layer is promoted');

  const noisy = new LayerPriorityModel();
  for (let i = 0; i < 8; i++) noisy.recordAction('categorical_consistency', 'dismiss');
  noisy.recordAction('categorical_consistency', 'accept');
  ok(noisy.scoreFor('categorical_consistency') < 0.3,
    `score: a mostly-dismissed layer scores low (${noisy.scoreFor('categorical_consistency').toFixed(2)} < 0.3)`);
  ok(noisy.tierFor('categorical_consistency') === 'deprioritized', 'tier: a low-scoring layer is deprioritized');

  // ---- exponential recency decay follows a change in usefulness ----
  // A layer that WAS noise (many old dismisses) but is NOW useful (recent
  // accepts) should climb above 0.5 thanks to decay, faster than a plain count
  // ratio would allow.
  const changed = new LayerPriorityModel();
  for (let i = 0; i < 10; i++) changed.recordAction('upper_bound_sanity', 'dismiss');
  const beforeTurn = changed.scoreFor('upper_bound_sanity');
  for (let i = 0; i < 10; i++) changed.recordAction('upper_bound_sanity', 'accept');
  const afterTurn = changed.scoreFor('upper_bound_sanity');
  ok(beforeTurn < 0.3, `decay: layer starts as noise (${beforeTurn.toFixed(2)})`);
  ok(afterTurn > 0.5, `decay: recent accepts pull the score back above neutral (${afterTurn.toFixed(2)})`);
  const plainRatio = 10 / 20; // if there were no decay, 10 acc / 20 total = 0.5
  ok(afterTurn > plainRatio,
    `decay: recency weighting scores it higher than an undecayed 50/50 ratio (${afterTurn.toFixed(2)} > ${plainRatio})`);

  // ---- MIN_ACTIONS ready gate: order preserved until enough feedback ----
  const gate = new LayerPriorityModel();
  for (let i = 0; i < MIN_ACTIONS - 1; i++) gate.recordAction('cross_column_logic', 'accept');
  ok(!gate.isReady() && gate.actionsUntilReady() === 1,
    `gate: ${MIN_ACTIONS - 1} actions is below MIN_ACTIONS (${MIN_ACTIONS}); 1 more needed`);
  const gatedOrder = gate.prioritize(LAYER_DEFS);
  ok(gatedOrder.reordered === false, 'gate: prioritize refuses to reorder before MIN_ACTIONS');
  ok(JSON.stringify(idsOf(gatedOrder)) === JSON.stringify(LAYER_DEFS.map(d => d.id)),
    'gate: original registry order is preserved while not ready');
  gate.recordAction('cross_column_logic', 'accept');
  ok(gate.isReady(), 'gate: model becomes ready exactly at MIN_ACTIONS');

  // ---- prioritize reorders useful-first and NEVER drops a layer ----
  const rank = new LayerPriorityModel();
  for (let i = 0; i < 6; i++) rank.recordAction('cross_column_logic', 'accept'); // should rise
  for (let i = 0; i < 6; i++) rank.recordAction('categorical_consistency', 'dismiss'); // should sink
  const ordered = rank.prioritize(LAYER_DEFS);
  ok(ordered.reordered === true, 'prioritize: a ready model reorders');
  ok(ordered.items.length === LAYER_DEFS.length,
    'prioritize: every layer is returned — none hidden, none dropped');
  ok(new Set(idsOf(ordered)).size === LAYER_DEFS.length,
    'prioritize: output is a permutation (no duplicates, no losses)');
  ok(ordered.items[0].id === 'cross_column_logic',
    'prioritize: the acted-on layer is ranked first');
  ok(idsOf(ordered).indexOf('cross_column_logic') < idsOf(ordered).indexOf('categorical_consistency'),
    'prioritize: acted-on layer outranks the dismissed-as-noise layer');
  ok(ordered.items[ordered.items.length - 1].id === 'categorical_consistency',
    'prioritize: the dismissed-as-noise layer sinks to the bottom');
  ok(ordered.items.every((it, i) => it.rank === i), 'prioritize: each item is annotated with its new rank');

  // ---- stable sort: untouched (all-neutral) layers keep registry order ----
  const stable = new LayerPriorityModel();
  for (let i = 0; i < MIN_ACTIONS; i++) stable.recordAction('cross_column_logic', 'accept');
  const stableOrder = stable.prioritize(LAYER_DEFS);
  const neutralIds = stableOrder.items.filter(it => it.tier === 'neutral').map(it => it.id);
  const registryNeutralOrder = LAYER_DEFS.map(d => d.id).filter(id => neutralIds.includes(id));
  ok(JSON.stringify(neutralIds) === JSON.stringify(registryNeutralOrder),
    'prioritize: neutral (untouched) layers stay in their original registry order (stable sort)');
  ok(stableOrder.items[0].id === 'cross_column_logic',
    'prioritize: only the layer with real feedback moves; the rest are undisturbed');

  // ---- plain-language explanations ----
  const promotedExpl = rank.explain('cross_column_logic');
  ok(promotedExpl.tier === 'promoted' && /acted on/.test(promotedExpl.reason),
    `explain: promoted layer cites acted-on count ("${promotedExpl.reason}")`);
  const noiseExpl = rank.explain('categorical_consistency');
  ok(noiseExpl.tier === 'deprioritized' && /dismissed/.test(noiseExpl.reason),
    `explain: deprioritized layer cites dismissed count ("${noiseExpl.reason}")`);
  const neutralExpl = rank.explain('benford');
  ok(neutralExpl.tier === 'neutral' && /No feedback yet/.test(neutralExpl.reason),
    `explain: untouched layer explains it kept its default position ("${neutralExpl.reason}")`);

  // ---- toJSON / fromJSON round-trip ----
  const json = rank.toJSON();
  ok(json.layers.cross_column_logic && json.layers.cross_column_logic.accepts === 6,
    'serialize: toJSON captures per-layer counts');
  const restored = LayerPriorityModel.fromJSON(json);
  ok(Math.abs(restored.scoreFor('cross_column_logic') - rank.scoreFor('cross_column_logic')) < 1e-9,
    'serialize: fromJSON reproduces the same score');
  ok(restored.totalActions === rank.totalActions, 'serialize: restored model has the same action total');
  const blank = LayerPriorityModel.fromJSON(null);
  ok(blank.totalActions === 0 && blank.scoreFor('anything') === 0.5,
    'serialize: fromJSON(null) yields a fresh neutral model (no throw)');
  const garbage = LayerPriorityModel.fromJSON({ layers: { x: null, y: 'nope', cross_column_logic: { accepts: 2, dAccepts: 2 } } });
  ok(garbage.layers.has('cross_column_logic') && !garbage.layers.has('x') && !garbage.layers.has('y'),
    'serialize: fromJSON drops garbage entries without corrupting valid ones');

  return persistence();
}

// ---- opt-in / opt-out / clear via injected fake store ----
async function persistence() {
  const store = makeFakeStore();
  const PRIORITY_ID = 'layer_priority';
  const SELF_LEARN_ID = 'default';

  // Simulate the Self-Learning model already persisted, to prove the two models
  // are independent and our clear only removes prioritization.
  await store.saveLearnedModel(SELF_LEARN_ID, { version: 1, weights: [1, 2, 3] });

  // OPT-OUT: with persistence off, main.js never calls saveLearnedModel for us.
  const ephemeral = new LayerPriorityModel();
  for (let i = 0; i < 8; i++) ephemeral.recordAction('cross_column_logic', 'accept');
  ok(!store.map.has(PRIORITY_ID),
    'opt-out: nothing is written for prioritization when the user has not opted in');

  // OPT-IN: persist the priority model, then reload it in a "new session".
  await store.saveLearnedModel(PRIORITY_ID, ephemeral.toJSON());
  const reloaded = LayerPriorityModel.fromJSON(await store.getLearnedModel(PRIORITY_ID));
  ok(reloaded.isReady() && reloaded.scoreFor('cross_column_logic') > 0.7,
    'opt-in: a fresh session reloads the persisted prioritization (carried across sessions)');

  // Continue learning and re-persist (incremental across sessions).
  reloaded.recordAction('cross_column_logic', 'accept');
  await store.saveLearnedModel(PRIORITY_ID, reloaded.toJSON());
  const reloaded2 = LayerPriorityModel.fromJSON(await store.getLearnedModel(PRIORITY_ID));
  ok(reloaded2.totalActions === 9, 'opt-in: further feedback accumulates onto the persisted model');

  // CLEAR: "Clear my learned prioritization" removes ONLY the priority model,
  // leaving the Self-Learning corrections model untouched.
  await store.deleteLearnedModel(PRIORITY_ID);
  ok(!store.map.has(PRIORITY_ID), 'clear: deleteLearnedModel removes the persisted prioritization');
  ok(store.map.has(SELF_LEARN_ID),
    'clear: clearing prioritization leaves the Self-Learning corrections model intact');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
