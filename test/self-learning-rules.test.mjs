// ============================================================
// DATAGLOW — Self-Learning Validation Rules test suite
// ============================================================
// Covers:
//   - recording labeled examples correctly (action -> label mapping, feature
//     extraction, ambiguous actions ignored)
//   - incremental training logic (the model actually learns the user's pattern)
//   - the minimum-examples threshold gating ranking/highlighting
//   - the ranking/highlighting behavior + plain-language explanation
//   - toJSON/fromJSON round-trip (the shape persisted to IndexedDB)
//   - the opt-in / opt-out / "clear" persistence path via an injected fake store
//     that mirrors js/memory-store.js's getLearnedModel/saveLearnedModel contract
//
// RUN WITH:  node test/self-learning-rules.test.mjs
//
// This suite is engine-free (no DuckDB): the learner is pure JS. The IndexedDB
// layer is browser-only, so — exactly as main.js does — persistence is exercised
// through a tiny in-memory fake store.

import {
  SelfLearningModel,
  extractFeatures,
  actionToLabel,
  MIN_EXAMPLES,
  KNOWN_SOURCES,
} from '../js/self-learning-rules.js';

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// In-memory stand-in for js/memory-store.js's learnedCorrections store.
function makeFakeStore() {
  const map = new Map();
  return {
    map,
    async getLearnedModel(id = 'default') { const r = map.get(id); return r ? r.model : null; },
    async saveLearnedModel(id, model) { map.set(id || 'default', { modelId: id || 'default', model }); },
    async countLearnedExamples(id = 'default') { const r = map.get(id); return r && r.model.examples ? r.model.examples.length : 0; },
    async clearLearnedModels() { map.clear(); },
  };
}

function main() {
  // ---- action -> label mapping ----
  ok(actionToLabel('merge') === 1 && actionToLabel('apply') === 1 && actionToLabel('edit') === 1,
    'actionToLabel: merge/apply/edit map to positive (real issue)');
  ok(actionToLabel('dismiss') === 0 && actionToLabel('reject') === 0 && actionToLabel('ignore') === 0,
    'actionToLabel: dismiss/reject/ignore map to negative (dismissed)');
  ok(actionToLabel('shrug') === null && actionToLabel(undefined) === null,
    'actionToLabel: unknown/absent action carries no label (null)');

  // ---- feature extraction: fixed length, type + source encoding, [0,1] range ----
  const f = extractFeatures({ source: 'cross_column_logic', columnType: 'INTEGER', severity: 0.5 });
  ok(f.values.length === f.names.length && f.values.length === 4 + KNOWN_SOURCES.length,
    `extractFeatures: fixed-length vector (${f.values.length}) = 4 base + ${KNOWN_SOURCES.length} sources`);
  ok(f.values[f.names.indexOf('numeric')] === 1 && f.values[f.names.indexOf('categorical')] === 0,
    'extractFeatures: INTEGER column encodes numeric=1, categorical=0');
  ok(f.values[f.names.indexOf('src:cross_column_logic')] === 1,
    'extractFeatures: the flag source is one-hot encoded');
  ok(f.values.every(v => v >= 0 && v <= 1), 'extractFeatures: all features are in [0,1]');
  const fOut = extractFeatures({ source: 'cross_column_logic', severity: 9 });
  ok(fOut.values[fOut.names.indexOf('severity')] === 1, 'extractFeatures: out-of-range severity is clamped to 1');
  const fUnknown = extractFeatures({ source: 'made_up_source', columnType: 'VARCHAR' });
  ok(fUnknown.values[fUnknown.names.indexOf('src:other')] === 1,
    'extractFeatures: an unknown source falls into src:other');

  // ---- recording labeled examples ----
  const m = new SelfLearningModel();
  ok(m.count === 0 && !m.isReady(), 'new model: zero examples, not ready');
  const rec = m.record({ source: 'categorical_consistency', columnType: 'VARCHAR' }, 'reject');
  ok(rec && rec.label === 0 && m.count === 1, 'record: a reject is stored as one labeled (0) example');
  const recNull = m.record({ source: 'categorical_consistency' }, 'hover');
  ok(recNull === null && m.count === 1, 'record: an ambiguous action is ignored (no example added)');

  // ---- minimum-examples threshold gates ranking ----
  const gate = new SelfLearningModel();
  for (let i = 0; i < MIN_EXAMPLES - 1; i++) gate.record({ source: 'fuzzy_dedup', columnType: 'VARCHAR' }, 'merge');
  ok(!gate.isReady() && gate.examplesUntilReady() === 1,
    `threshold: ${MIN_EXAMPLES - 1} examples is below MIN_EXAMPLES (${MIN_EXAMPLES}); 1 more needed`);
  const gatedRank = gate.rank([{ source: 'fuzzy_dedup', columnType: 'VARCHAR' }]);
  ok(gatedRank.ranked === false && gatedRank.items[0].probability === null,
    'threshold: rank() refuses to score (ranked:false) until MIN_EXAMPLES is reached');
  gate.record({ source: 'fuzzy_dedup', columnType: 'VARCHAR' }, 'merge');
  ok(gate.isReady(), 'threshold: model becomes ready exactly at MIN_EXAMPLES');

  // ---- incremental training actually learns a pattern ----
  // Teach: the user ALWAYS acts on cross-column flags but ALWAYS dismisses
  // categorical-consistency flags. The model should separate the two.
  const learn = new SelfLearningModel();
  for (let i = 0; i < 15; i++) {
    learn.record({ source: 'cross_column_logic', columnType: 'INTEGER', severity: 0.8 }, 'accept');
    learn.record({ source: 'categorical_consistency', columnType: 'VARCHAR', severity: 0.2 }, 'dismiss');
  }
  const pAccept = learn.predictProba({ source: 'cross_column_logic', columnType: 'INTEGER', severity: 0.8 });
  const pDismiss = learn.predictProba({ source: 'categorical_consistency', columnType: 'VARCHAR', severity: 0.2 });
  ok(pAccept > 0.7, `training: learned that cross-column flags are acted on (p=${pAccept.toFixed(2)} > 0.7)`);
  ok(pDismiss < 0.3, `training: learned that categorical flags are dismissed (p=${pDismiss.toFixed(2)} < 0.3)`);
  ok(pAccept > pDismiss, 'training: model separates the two flag types');

  // A full retrain from the same examples should reach the same conclusion.
  learn.trainEpochs(10);
  ok(learn.predictProba({ source: 'cross_column_logic', columnType: 'INTEGER', severity: 0.8 }) > 0.7,
    'training: full trainEpochs() refit preserves the learned separation');

  // ---- ranking orders likely-relevant first + explains why ----
  const ranked = learn.rank([
    { source: 'categorical_consistency', columnType: 'VARCHAR', severity: 0.2 }, // should sink
    { source: 'cross_column_logic', columnType: 'INTEGER', severity: 0.8 },      // should rise
  ]);
  ok(ranked.ranked === true, 'rank: a ready model ranks');
  ok(ranked.items[0].snapshot.source === 'cross_column_logic',
    'rank: the likely-relevant flag is ordered first');
  ok(ranked.items[0].probability > ranked.items[1].probability,
    'rank: probabilities are descending');
  ok(ranked.items[0].explanation && /before|tend to be/.test(ranked.items[0].explanation.reason),
    `rank: top item carries a plain-language explanation ("${ranked.items[0].explanation.reason}")`);
  ok(ranked.items[0].explanation.prediction === 'likely-relevant' &&
     ranked.items[1].explanation.prediction === 'likely-dismiss',
    'rank: predictions are labeled likely-relevant vs likely-dismiss');

  // ---- explanation references the count of prior similar corrections ----
  const expl = learn.explain({ source: 'categorical_consistency', columnType: 'VARCHAR', severity: 0.2 });
  ok(/\d+ similar flag/.test(expl.reason),
    `explain: dismissed item cites the number of prior similar dismissals ("${expl.reason}")`);

  // ---- toJSON / fromJSON round-trip ----
  const json = learn.toJSON();
  ok(json.weights.length === learn.dim && json.examples.length === learn.count,
    'serialize: toJSON captures weights and all examples');
  const restored = SelfLearningModel.fromJSON(json);
  ok(restored.count === learn.count, 'serialize: fromJSON restores the example count');
  const currentP = learn.predictProba({ source: 'cross_column_logic', columnType: 'INTEGER', severity: 0.8 });
  ok(Math.abs(restored.predictProba({ source: 'cross_column_logic', columnType: 'INTEGER', severity: 0.8 }) - currentP) < 1e-6,
    'serialize: restored model reproduces the same prediction');
  const restoredBlank = SelfLearningModel.fromJSON(null);
  ok(restoredBlank.count === 0, 'serialize: fromJSON(null) yields a fresh empty model (no throw)');
  // Dimension-mismatch tolerance (a future feature added a column).
  const legacy = { weights: [1, 2, 3], bias: 0.5, examples: [{ values: [1, 0], label: 1 }] };
  const restoredLegacy = SelfLearningModel.fromJSON(legacy);
  ok(restoredLegacy.dim === learn.dim && restoredLegacy.count === 0,
    'serialize: mismatched saved weights/examples are dropped, not corrupting the schema');

  return persistence();
}

// ---- opt-in / opt-out / clear via injected fake store ----
async function persistence() {
  const store = makeFakeStore();

  // OPT-OUT: with persistence off, main.js simply never calls saveLearnedModel.
  // Simulate a session's worth of learning that is NOT saved.
  const ephemeral = new SelfLearningModel();
  for (let i = 0; i < 12; i++) ephemeral.record({ source: 'upper_bound_sanity', columnType: 'INTEGER' }, 'dismiss');
  ok(store.map.size === 0, 'opt-out: nothing is written to the store when the user has not opted in');

  // OPT-IN: persist the learned model, then reload it in a "new session".
  await store.saveLearnedModel('default', ephemeral.toJSON());
  ok(store.map.size === 1 && (await store.countLearnedExamples('default')) === 12,
    'opt-in: the learned model + its 12 examples are saved to the store');

  const reloadedJSON = await store.getLearnedModel('default');
  const reloaded = SelfLearningModel.fromJSON(reloadedJSON);
  ok(reloaded.count === 12 && reloaded.isReady(),
    'opt-in: a fresh session reloads the persisted model (learning carried across sessions)');
  ok(reloaded.predictProba({ source: 'upper_bound_sanity', columnType: 'INTEGER' }) < 0.5,
    'opt-in: the reloaded model retains the learned "dismiss" tendency');

  // Continue learning in the new session and re-persist (incremental across sessions).
  reloaded.record({ source: 'upper_bound_sanity', columnType: 'INTEGER' }, 'dismiss');
  await store.saveLearnedModel('default', reloaded.toJSON());
  ok((await store.countLearnedExamples('default')) === 13,
    'opt-in: further corrections accumulate onto the persisted model');

  // CLEAR: "Clear my learned corrections" wipes the store.
  await store.clearLearnedModels();
  ok(store.map.size === 0 && (await store.getLearnedModel('default')) === null,
    'clear: clearLearnedModels() removes the persisted model');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
