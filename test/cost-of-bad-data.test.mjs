// ============================================================
// DATAGLOW — Cost-of-bad-data quantifier test suite
// ============================================================
// The quantifier is a pure, offline multiplication (flaggedCount × per-error
// cost) with clearly-hedged labelling. No DuckDB, no browser, no network.
//
// RUN WITH:  node test/cost-of-bad-data.test.mjs

import {
  DEFAULT_PER_ERROR_COST,
  COST_SOURCE_NOTE,
  formatMoney,
  estimateCostOfBadData,
} from '../js/provenance/cost-of-bad-data.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- default + basic multiplication ----------
ok(DEFAULT_PER_ERROR_COST === 118, 'DEFAULT_PER_ERROR_COST is the documented $118 placeholder');
ok(typeof COST_SOURCE_NOTE === 'string' && /editable|assumption|control|research/i.test(COST_SOURCE_NOTE),
  'COST_SOURCE_NOTE frames the default as an editable, researched assumption');

const base = estimateCostOfBadData({ flaggedCount: 10 });
ok(base.estimatedRiskAmount === 10 * 118, 'estimate: 10 rows × default $118 = $1180');
ok(base.perErrorCost === 118 && base.isDefaultCost === true, 'estimate: reports the default per-error cost and flags it as default');
ok(base.flaggedCount === 10, 'estimate: echoes the flagged count');

// ---------- editable per-error cost ----------
const custom = estimateCostOfBadData({ flaggedCount: 4, perErrorCost: 25 });
ok(custom.estimatedRiskAmount === 100, 'estimate: honours an editable per-error cost (4 × $25 = $100)');
ok(custom.isDefaultCost === false, 'estimate: a non-default cost is not marked as default');

// ---------- labelling and honesty ----------
ok(/estimated at risk/i.test(base.label), 'estimate: label says "estimated at risk"');
ok(/flagged/i.test(base.label) && base.label.includes('$118') && base.label.includes('$1,180'),
  'estimate: label shows the flagged-rows × per-error-cost multiplication');
ok(/estimated risk only/i.test(base.disclaimer) && /not a (prediction|guarantee)/i.test(base.disclaimer),
  'estimate: disclaimer hedges as estimated risk, not a prediction/guarantee');
ok(base.editable === true, 'estimate: marked editable');
ok(base.sourceNote === COST_SOURCE_NOTE, 'estimate: carries the source note');

// ---------- formatting ----------
ok(formatMoney(1180) === '$1,180', `formatMoney: USD whole-dollar formatting (${formatMoney(1180)})`);
ok(typeof formatMoney(500, 'ZZZ') === 'string', 'formatMoney: unknown currency falls back to a plain labelled number');

// ---------- guards ----------
ok(estimateCostOfBadData({ flaggedCount: 0 }).estimatedRiskAmount === 0, 'estimate: zero rows → $0');
ok(estimateCostOfBadData({ flaggedCount: -5 }).flaggedCount === 0, 'estimate: negative count is clamped to 0');
ok(estimateCostOfBadData({ flaggedCount: 3.9 }).flaggedCount === 3, 'estimate: fractional count is truncated to whole rows');
ok(estimateCostOfBadData({ flaggedCount: 5, perErrorCost: -1 }).perErrorCost === DEFAULT_PER_ERROR_COST,
  'estimate: an invalid negative per-error cost falls back to the default');
ok(estimateCostOfBadData().estimatedRiskAmount === 0, 'estimate: no args → safe zero estimate');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
