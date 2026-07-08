// ============================================================
// DATAGLOW — Unified Signal Layer test suite
// ============================================================
// Covers the shared coordination layer that lets the on-device modules read
// each other's conclusions before rendering:
//   - SignalStore core read/write/query behaviour (row/column keying, filtered
//     query newest-first, convenience lookups, typed/predicate clear)
//   - the ranker's per-column verdict tally (columnVerdict + MIN_COLUMN_VERDICT)
//   - anomaly-scorer-suppresses-when-ranker-has-learned-dismissal
//     (suppressAnomaliesWithVerdicts) + the additive/no-op guarantee
//   - drift-forecaster-surfaces-rule-change-context
//     (enrichForecastWithSignals) + the additive/no-op guarantee
//
// RUN WITH:  node test/signal-store.test.mjs
//
// Engine-free (no DuckDB): every unit under test is pure JS. This mirrors the
// self-learning-rules / adaptive-priority suites.

import { SignalStore, SIGNAL_TYPES, VERDICTS } from '../js/signal-store.js';
import { SelfLearningModel, MIN_COLUMN_VERDICT } from '../js/self-learning-rules.js';
import { suppressAnomaliesWithVerdicts, describeSuppression } from '../js/predictive-anomaly.js';
import { enrichForecastWithSignals } from '../js/drift-forecast.js';

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Build a fake predictive-anomaly result row (only the fields the suppressor reads).
function anomalyRow(rowIndex, topColumn, isAnomaly = true) {
  return {
    rowIndex,
    isAnomaly,
    rawScore: 1 - rowIndex / 100,
    score: 1 - rowIndex / 100,
    reason: `Row #${rowIndex}'s combination of values is unusual.`,
    contributions: [
      { feature: topColumn, kind: 'numeric', contribution: 0.7 },
      { feature: 'other_col', kind: 'categorical', contribution: 0.3 },
    ],
    values: { [topColumn]: 42, other_col: 'x' },
  };
}

function main() {
  // ============================================================
  // 1) SignalStore core read/write/query
  // ============================================================
  const store = new SignalStore();
  ok(store.size === 0, 'new store: empty');

  const s1 = store.register({ module: 'self_learning', type: SIGNAL_TYPES.LEARNED_VERDICT, column: 'age', verdict: VERDICTS.DISMISS, confidence: 0.8, meta: { dismiss: 4, accept: 0 } });
  ok(store.size === 1 && s1.seq === 0 && Number.isFinite(s1.at), 'register: stores signal with seq + timestamp');

  store.register({ module: 'anomaly', type: 'score', row: 42, column: 'age', value: 0.9 });
  ok(store.signalsForColumn('age').length === 2, 'signalsForColumn: indexes by column name');
  ok(store.signalsForRow(42).length === 1, 'signalsForRow: indexes by row key (number coerced to string)');
  ok(store.signalsForRow('42').length === 1, 'signalsForRow: number and string row keys unify');
  ok(store.signalsForColumn('nope').length === 0 && store.signalsForRow(999).length === 0,
    'unknown row/column returns an empty array (no throw)');

  // filtered query, newest-first
  store.register({ module: 'self_learning', type: SIGNAL_TYPES.RULE_CHANGE, column: 'age', meta: { source: 'upper_bound_sanity', action: 'dismiss' }, at: 1000 });
  store.register({ module: 'self_learning', type: SIGNAL_TYPES.RULE_CHANGE, column: 'age', meta: { source: 'cross_column_logic', action: 'reject' }, at: 2000 });
  const changes = store.query({ column: 'age', type: SIGNAL_TYPES.RULE_CHANGE });
  ok(changes.length === 2 && changes[0].at === 2000, 'query: filters by column+type and returns newest-first');
  ok(store.query({ type: SIGNAL_TYPES.RULE_CHANGE }).length === 2, 'query: type-only filter scans all signals');
  ok(store.query({ module: 'anomaly' }).length === 1, 'query: module-only filter works');

  // convenience lookups
  const dv = store.dismissalVerdict('age');
  ok(dv && dv.verdict === VERDICTS.DISMISS && dv.meta.dismiss === 4, 'dismissalVerdict: returns the DISMISS learned verdict for a column');
  ok(store.dismissalVerdict('other') === null, 'dismissalVerdict: null when no dismissal verdict exists');
  // a column with only an ACCEPT verdict must NOT be treated as a dismissal
  store.register({ module: 'self_learning', type: SIGNAL_TYPES.LEARNED_VERDICT, column: 'income', verdict: VERDICTS.ACCEPT, confidence: 0.9 });
  ok(store.dismissalVerdict('income') === null, 'dismissalVerdict: an ACCEPT verdict is not a dismissal');
  const rc = store.recentRuleChange('age');
  ok(rc && rc.at === 2000, 'recentRuleChange: returns the most recent rule-change on a column');
  ok(store.recentRuleChange('income') === null, 'recentRuleChange: null when column has no rule change');

  // dismissalVerdict prefers highest confidence
  const store2 = new SignalStore();
  store2.register({ module: 'self_learning', type: SIGNAL_TYPES.LEARNED_VERDICT, column: 'c', verdict: VERDICTS.DISMISS, confidence: 0.6, at: 100 });
  store2.register({ module: 'self_learning', type: SIGNAL_TYPES.LEARNED_VERDICT, column: 'c', verdict: VERDICTS.DISMISS, confidence: 0.95, at: 50 });
  ok(store2.dismissalVerdict('c').confidence === 0.95, 'dismissalVerdict: picks highest-confidence among ties');

  // predicate + full clear
  store.clear(s => s.module === 'self_learning' && s.type === SIGNAL_TYPES.LEARNED_VERDICT);
  ok(store.dismissalVerdict('age') === null && store.query({ type: SIGNAL_TYPES.RULE_CHANGE }).length === 2,
    'clear(predicate): drops only matching signals, leaves the rest (incl. re-index)');
  // "age" retains the anomaly score signal + 2 rule changes after the verdict is dropped.
  ok(store.signalsForColumn('age').length === 3, 'clear(predicate): column index stays consistent after partial clear');
  store.clear();
  ok(store.size === 0 && store.signalsForColumn('age').length === 0, 'clear(): wipes everything and the indexes');

  // ============================================================
  // 2) Ranker per-column verdict tally (the LEARNED_VERDICT payload source)
  // ============================================================
  const model = new SelfLearningModel();
  ok(model.columnVerdict('age') === null, 'columnVerdict: null for a column with no examples');
  ok(model.columnVerdict(null) === null, 'columnVerdict: null column arg returns null');

  // The user dismisses flags on "age" MIN_COLUMN_VERDICT times as false positives.
  for (let i = 0; i < MIN_COLUMN_VERDICT; i++) {
    model.record({ source: 'upper_bound_sanity', column: 'age', numeric: true, severity: 0.7 }, 'dismiss');
  }
  const cv = model.columnVerdict('age');
  ok(cv && cv.dismiss === MIN_COLUMN_VERDICT && cv.accept === 0, `columnVerdict: tallies ${MIN_COLUMN_VERDICT} dismissals on "age"`);
  ok(cv.verdict === 'dismiss' && cv.confidence === 1, 'columnVerdict: decisive dismissal → verdict "dismiss", confidence 1');

  // Below threshold stays undecided.
  const model2 = new SelfLearningModel();
  model2.record({ source: 'upper_bound_sanity', column: 'bmi' }, 'dismiss');
  ok(model2.columnVerdict('bmi').verdict === null, 'columnVerdict: below MIN_COLUMN_VERDICT → no decisive verdict');

  // A mixed history (equal accept/dismiss) stays undecided.
  const model3 = new SelfLearningModel();
  for (let i = 0; i < 3; i++) { model3.record({ column: 'z' }, 'dismiss'); model3.record({ column: 'z' }, 'accept'); }
  ok(model3.columnVerdict('z').verdict === null, 'columnVerdict: a tied accept/dismiss history is not decisive');

  // ============================================================
  // 3) Anomaly scorer suppresses when the ranker has learned a dismissal
  //    (the end-to-end case: model → store → suppressor)
  // ============================================================
  const learned = new SelfLearningModel();
  for (let i = 0; i < 4; i++) learned.record({ source: 'upper_bound_sanity', column: 'age', numeric: true }, 'dismiss');

  const coord = new SignalStore();
  const v = learned.columnVerdict('age');
  coord.register({ module: 'self_learning', type: SIGNAL_TYPES.LEARNED_VERDICT, column: 'age', verdict: VERDICTS.DISMISS, confidence: v.confidence, meta: { dismiss: v.dismiss, accept: v.accept } });

  // Row 42's dominant column is "age" (learned dismissal); row 7's is "weight" (unseen).
  const result = { rows: [anomalyRow(42, 'age'), anomalyRow(7, 'weight')] };
  suppressAnomaliesWithVerdicts(result, coord);

  const r42 = result.rows.find(r => r.rowIndex === 42);
  const r7 = result.rows.find(r => r.rowIndex === 7);
  ok(r42.suppressed === true && r42.isAnomaly === false, 'suppress: row whose dominant column has a learned dismissal is de-flagged');
  ok(r42.suppression && r42.suppression.column === 'age' && r42.suppression.dismiss === 4,
    'suppress: records WHY (column + dismissal count) on the row');
  ok(/dismissed flags on "age" as false positives 4 times/.test(r42.reason),
    'suppress: reason explains the cross-module suppression in plain language');
  ok(r7.suppressed !== true && r7.isAnomaly === true, 'suppress: an unrelated row is untouched (still flagged)');
  ok(result.suppressedCount === 1, 'suppress: reports how many flags were suppressed');

  // Additive / no-op guarantees (requirement 4): no store, no verdict, not-a-flag.
  const untouched = { rows: [anomalyRow(1, 'age')] };
  suppressAnomaliesWithVerdicts(untouched, undefined);
  ok(untouched.rows[0].suppressed === undefined && untouched.rows[0].isAnomaly === true,
    'suppress: with NO store, rows are identical to before (pure passthrough)');

  const emptyCoord = new SignalStore();
  const noVerdict = { rows: [anomalyRow(1, 'age')] };
  suppressAnomaliesWithVerdicts(noVerdict, emptyCoord);
  ok(noVerdict.rows[0].suppressed === undefined && noVerdict.rows[0].isAnomaly === true,
    'suppress: with an empty store, nothing is suppressed');

  const nonFlag = { rows: [anomalyRow(1, 'age', /*isAnomaly*/ false)] };
  suppressAnomaliesWithVerdicts(nonFlag, coord);
  ok(nonFlag.rows[0].suppressed === undefined, 'suppress: only ever downgrades an existing flag, never a non-flag');

  ok(typeof describeSuppression(42, 'age', 4) === 'string' && describeSuppression(42, 'age', null).length > 0,
    'describeSuppression: produces text with and without a known count');

  // ============================================================
  // 4) Drift forecaster surfaces recent rule-change context
  // ============================================================
  const driftStore = new SignalStore();
  driftStore.register({ module: 'self_learning', type: SIGNAL_TYPES.RULE_CHANGE, column: 'glucose', meta: { source: 'upper_bound_sanity', action: 'dismiss' } });

  const report = {
    active: true,
    flags: [
      { column: 'glucose', message: 'Expected mean of "glucose" ~100; this upload has 180 — outside the expected range (90–110).' },
      { column: 'age', message: 'Expected mean of "age" ~50; this upload has 80 — outside the expected range (45–55).' },
    ],
  };
  enrichForecastWithSignals(report, driftStore);
  const gFlag = report.flags.find(f => f.column === 'glucose');
  const aFlag = report.flags.find(f => f.column === 'age');
  ok(gFlag.relatedRuleChange && /recently disabled\/changed validation rule/.test(gFlag.message),
    'enrich: a drift flag on a column with a recent rule change gets the connection appended');
  ok(/upper bound sanity/.test(gFlag.message), 'enrich: the related rule name is surfaced in the message');
  ok(!aFlag.relatedRuleChange && !/recently disabled/.test(aFlag.message),
    'enrich: a drift flag on an unrelated column is untouched');

  // Additive / no-op guarantees.
  const inactive = { active: false, historyLen: 1, minHistory: 4 };
  ok(enrichForecastWithSignals(inactive, driftStore) === inactive, 'enrich: an inactive report is returned untouched');
  const noStore = { active: true, flags: [{ column: 'glucose', message: 'x' }] };
  enrichForecastWithSignals(noStore, undefined);
  ok(!noStore.flags[0].relatedRuleChange && noStore.flags[0].message === 'x',
    'enrich: with NO store, flags are identical to before (pure passthrough)');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
