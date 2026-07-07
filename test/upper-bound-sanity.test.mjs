// ============================================================
// DATAGLOW — Upper-Bound Sanity Anchor test suite
// ============================================================
// Three halves:
//   1. Pure name classification — matchBoundedType across snake_case, camelCase,
//      PascalCase, kebab-case and compound names (proving robust word-splitting,
//      not naive `\b` boundaries), plus the deliberate exclusions (vital signs,
//      legitimately-unbounded growth/ROI/margin names).
//   2. Pure bound decision — decideBound's conservative framing selection and
//      skip logic, driven purely by a synthetic distribution summary (no DB).
//   3. The async runner against a REAL (native) DuckDB table: correct flagging
//      of out-of-bound percentages/proportions, correct NON-flagging of values
//      within bounds, and correct conservative SKIPPING of an ambiguous
//      "flow_rate" column whose values are genuinely unbounded.
//
// RUN WITH:
//   node --import ./test/duckdb-loader-hook.mjs test/upper-bound-sanity.test.mjs

import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';
import * as engine from './node-duckdb-engine.mjs';

import {
  matchBoundedType, decideBound, runUpperBoundChecks, UPPER_BOUND_NOTE,
} from '../js/upper-bound-sanity.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const cat = (name) => { const d = matchBoundedType(name); return d ? d.category : null; };

async function makeDataset(table, rows) {
  await createTableFromObjects(table, rows);
  const schema = await getTableSchema(table);
  return schema.map(s => ({ name: s.column_name, type: s.column_type }));
}
const findByColumn = (fs, col) => fs.find(f => f.column === col);

// Distribution summary helper for decideBound tests. Given a plain value array,
// build the { n, in01, in0100, min, max } shape the runner would produce.
function distOf(values) {
  const n = values.length;
  const in01 = values.filter(v => v >= 0 && v <= 1).length;
  const in0100 = values.filter(v => v >= 0 && v <= 100).length;
  return { n, in01, in0100, min: Math.min(...values), max: Math.max(...values) };
}

async function main() {
  // ============================================================
  // 1. Column → bounded-type classification (robust word-splitting)
  // ============================================================
  // Explicit percentages (0–100).
  ok(cat('percent') === 'percentage', 'detect: "percent" → percentage');
  ok(cat('completion_pct') === 'percentage', 'detect: snake_case completion_pct → percentage');
  ok(cat('completionPct') === 'percentage', 'detect: camelCase completionPct → percentage');
  ok(cat('CompletionPercentage') === 'percentage', 'detect: PascalCase CompletionPercentage → percentage');
  ok(cat('discount_percentage') === 'percentage', 'detect: compound discount_percentage → percentage');
  ok(cat('battery-pct') === 'percentage', 'detect: kebab-case battery-pct → percentage');

  // Explicit proportions / probabilities (0–1).
  ok(cat('proportion') === 'proportion', 'detect: "proportion" → proportion');
  ok(cat('sample_proportion') === 'proportion', 'detect: sample_proportion → proportion');
  ok(cat('probability') === 'proportion', 'detect: "probability" → proportion');
  ok(cat('churn_probability') === 'proportion', 'detect: churn_probability → proportion');
  ok(cat('prob_win') === 'proportion', 'detect: code "prob" (prob_win) → proportion');
  ok(matchBoundedType('churn_probability').word === 'probability', 'detect: probability keeps the "probability" wording');

  // "rate" WITH a percentage qualifier → rate_like (percentage-framed).
  ok(cat('success_rate') === 'rate_like', 'detect: success_rate → rate_like (percentage-framed)');
  ok(cat('passRate') === 'rate_like', 'detect: camelCase passRate → rate_like');
  ok(cat('conversion_rate') === 'rate_like', 'detect: conversion_rate → rate_like');

  // Bare "rate"/"ratio" → ambiguous (bound only if the values agree).
  ok(cat('flow_rate') === 'ambiguous', 'detect: flow_rate → ambiguous (no qualifier)');
  ok(cat('rate') === 'ambiguous', 'detect: bare "rate" → ambiguous');
  ok(cat('pe_ratio') === 'ambiguous', 'detect: pe_ratio → ambiguous');
  ok(cat('debt_ratio') === 'ambiguous', 'detect: debt_ratio → ambiguous');

  // Exclusions — vital signs are owned by the Physiological Plausibility layer.
  ok(cat('heart_rate') === null, 'exclude: heart_rate is a vital sign, not a percentage (owned by physiology layer)');
  ok(cat('resp_rate') === null, 'exclude: resp_rate is a vital sign, not a percentage');
  ok(cat('pulse') === null, 'exclude: pulse is a vital sign');

  // Exclusions — legitimately-unbounded quantities that can exceed 100 / go negative.
  ok(cat('growth_pct') === null, 'exclude: growth_pct can exceed 100 → not bounded');
  ok(cat('change_percentage') === null, 'exclude: change_percentage can exceed 100 → not bounded');
  ok(cat('roi_pct') === null, 'exclude: roi_pct can exceed 100 → not bounded');
  ok(cat('profit_margin') === null, 'exclude: profit_margin (margin) → not bounded');
  ok(cat('yoy_growth_rate') === null, 'exclude: yoy_growth_rate → not bounded');

  // No signal at all.
  ok(cat('country') === null, 'detect: "country" has no bounded signal');
  ok(cat('amount') === null, 'detect: "amount" has no bounded signal');
  ok(cat('temperature') === null, 'detect: "temperature" is not a bounded percentage (and is a vital)');

  ok(typeof UPPER_BOUND_NOTE === 'string' && /logical/i.test(UPPER_BOUND_NOTE) && /conservative/i.test(UPPER_BOUND_NOTE),
    'note: present and explains the logical-bounds + conservative-skip intent');

  // ============================================================
  // 2. decideBound — framing selection + conservative skip (pure, no DB)
  // ============================================================
  // Explicit percentage, values spread 0–100 → 0–100 bound.
  {
    const b = decideBound({ category: 'percentage' }, distOf([10, 45, 80, 99, 500]));
    ok(b && b.low === 0 && b.high === 100 && b.label === 'percentage', 'bound: percentage with 0–100 values → 0–100');
  }
  // Explicit percentage stored as a fraction (mostly 0–1, one stray error) → 0–1.
  {
    const b = decideBound({ category: 'percentage' }, distOf([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 5]));
    ok(b && b.low === 0 && b.high === 1, 'bound: percentage stored as fraction (mostly 0–1) → 0–1');
  }
  // Explicit proportion, values 0–1 → 0–1 bound.
  {
    const b = decideBound({ category: 'proportion', word: 'proportion' }, distOf([0.2, 0.5, 0.8, 0.99]));
    ok(b && b.high === 1, 'bound: proportion with 0–1 values → 0–1');
  }
  // Explicit proportion stored as a percentage (0–100) → tolerated as 0–100.
  {
    const b = decideBound({ category: 'proportion', word: 'probability' }, distOf([12, 40, 66, 95]));
    ok(b && b.high === 100, 'bound: probability stored as 0–100 → 0–100 (tolerated)');
  }
  // Explicit proportion whose values fit NEITHER framing → skip.
  {
    const b = decideBound({ category: 'proportion', word: 'proportion' }, distOf([5, 250, 900, 4000]));
    ok(b === null, 'bound: proportion with clearly-unbounded values → skip (conservative)');
  }
  // rate_like with percentage-consistent values → 0–100.
  {
    const b = decideBound({ category: 'rate_like' }, distOf([55, 80, 92, 99]));
    ok(b && b.high === 100, 'bound: success-style rate mostly 0–100 → 0–100');
  }
  // rate_like that is actually a per-1000 rate (values >100) → skip.
  {
    const b = decideBound({ category: 'rate_like' }, distOf([120, 340, 560, 800]));
    ok(b === null, 'bound: rate whose values exceed 100 (per-1000/per-capita) → skip (conservative)');
  }
  // ambiguous ratio, values clearly 0–1 → 0–1 bound.
  {
    const b = decideBound({ category: 'ambiguous', word: 'ratio' }, distOf([0.1, 0.3, 0.7, 0.95]));
    ok(b && b.high === 1, 'bound: ambiguous ratio mostly 0–1 → 0–1');
  }
  // ambiguous ratio that is genuinely unbounded (P/E ratio) → skip.
  {
    const b = decideBound({ category: 'ambiguous', word: 'ratio' }, distOf([8, 15, 22, 45, 130]));
    ok(b === null, 'bound: unbounded ratio (P/E-like) → skip (conservative)');
  }
  // ambiguous rate that is genuinely unbounded (flow rate) → skip.
  {
    const b = decideBound({ category: 'ambiguous', word: 'rate' }, distOf([200, 450, 900, 1500]));
    ok(b === null, 'bound: unbounded flow-rate-like values → skip (conservative)');
  }

  // ============================================================
  // 3. Runner against a real DuckDB table
  // ============================================================

  // --- Percentage column: flag 500 (typo) and a negative, keep 0–100 values. ---
  {
    const rows = [
      { id: 1, completion_pct: 50 },
      { id: 2, completion_pct: 80 },
      { id: 3, completion_pct: 100 },  // valid ceiling — must NOT flag
      { id: 4, completion_pct: 500 },  // impossible >100 (decimal slip for 50.0?)
      { id: 5, completion_pct: -5 },   // impossible negative
    ];
    const cols = await makeDataset('ub_pct', rows);
    const { findings, matched } = await runUpperBoundChecks('ub_pct', cols, engine);
    const f = findByColumn(findings, 'completion_pct');
    ok(matched.some(m => m.column === 'completion_pct' && m.high === 100), 'run(pct): completion_pct bounded to 0–100');
    ok(f && f.count === 2, 'run(pct): exactly 2 out-of-bound values flagged (500, -5)');
    ok(f && f.above === 1 && f.below === 1, 'run(pct): one above 100 + one below 0 — 50/80/100 not flagged');
    ok(f && /exceeds the logical maximum of 100%/.test(f.explanation) && /cannot be negative/.test(f.explanation),
      'run(pct): plain-language explanation names the 100% max and the non-negativity rule');
  }

  // --- Proportion column: values 0–1 with an impossible 5 and a negative. ---
  // Realistic error rate: 8 valid 0–1 values plus 2 impossible ones, so the
  // observed distribution still reads clearly as a 0–1 proportion.
  {
    const rows = [
      { id: 1, win_probability: 0.2 },
      { id: 2, win_probability: 0.75 },
      { id: 3, win_probability: 0.5 },
      { id: 4, win_probability: 0.33 },
      { id: 5, win_probability: 0.6 },
      { id: 6, win_probability: 0.8 },
      { id: 7, win_probability: 0.05 },
      { id: 8, win_probability: 1.0 },   // valid ceiling — must NOT flag
      { id: 9, win_probability: 5 },     // impossible >1
      { id: 10, win_probability: -0.3 }, // impossible negative
    ];
    const cols = await makeDataset('ub_prob', rows);
    const { findings, matched } = await runUpperBoundChecks('ub_prob', cols, engine);
    const f = findByColumn(findings, 'win_probability');
    ok(matched.some(m => m.column === 'win_probability' && m.high === 1), 'run(prob): win_probability bounded to 0–1');
    ok(f && f.count === 2 && f.above === 1 && f.below === 1, 'run(prob): 2 flagged (5 over 1, -0.3 below 0); 1.0 not flagged');
  }

  // --- Compound success_rate (percentage-framed) with a 150 typo. ---
  // A qualified "rate" is bounded only when the values actually look 0–100, so
  // most rows are valid percentages with a single impossible outlier.
  {
    const rows = [
      { id: 1, success_rate: 55 },
      { id: 2, success_rate: 90 },
      { id: 3, success_rate: 72 },
      { id: 4, success_rate: 88 },
      { id: 5, success_rate: 95 },
      { id: 6, success_rate: 60 },
      { id: 7, success_rate: 66 },
      { id: 8, success_rate: 80 },
      { id: 9, success_rate: 99 },
      { id: 10, success_rate: 150 }, // impossible >100
    ];
    const cols = await makeDataset('ub_rate', rows);
    const { findings } = await runUpperBoundChecks('ub_rate', cols, engine);
    const f = findByColumn(findings, 'success_rate');
    ok(f && f.count === 1 && f.above === 1, 'run(rate): success_rate 150 flagged as >100; 55/90 not flagged');
  }

  // --- Conservative skip: an ambiguous "flow_rate" with large unbounded values. ---
  {
    const rows = [
      { id: 1, flow_rate: 250 },
      { id: 2, flow_rate: 480 },
      { id: 3, flow_rate: 900 },
      { id: 4, flow_rate: 1500 },
    ];
    const cols = await makeDataset('ub_flow', rows);
    const { findings, matched } = await runUpperBoundChecks('ub_flow', cols, engine);
    ok(matched.length === 0 && findings.length === 0,
      'run(flow_rate): unbounded flow-rate values → column SKIPPED, no false flags');
  }

  // --- No false positives on a fully-valid percentage + proportion table. ---
  {
    const rows = [
      { id: 1, pass_pct: 88, retention_ratio: 0.9 },
      { id: 2, pass_pct: 92, retention_ratio: 0.85 },
      { id: 3, pass_pct: 100, retention_ratio: 1.0 },
    ];
    const cols = await makeDataset('ub_clean', rows);
    const { findings, matched } = await runUpperBoundChecks('ub_clean', cols, engine);
    ok(matched.length === 2, 'run(clean): both bounded columns detected');
    ok(findings.length === 0, 'run(clean): no false positives on a fully in-bounds table');
  }

  // --- No overlap with the Physiological layer: a heart_rate column is ignored. ---
  {
    const rows = [
      { id: 1, heart_rate: 320, completion_pct: 40 }, // 320 is a vital-sign issue, NOT this layer's job
      { id: 2, heart_rate: 72, completion_pct: 60 },
    ];
    const cols = await makeDataset('ub_overlap', rows);
    const { matched } = await runUpperBoundChecks('ub_overlap', cols, engine);
    ok(matched.some(m => m.column === 'completion_pct'), 'run(overlap): percentage column still checked');
    ok(!matched.some(m => m.column === 'heart_rate'), 'run(overlap): heart_rate left to the Physiological layer (no duplication)');
  }

  // --- No bounded columns → runner returns empty matched set. ---
  {
    const rows = [{ id: 1, country: 'US', amount: 12.5 }, { id: 2, country: 'FR', amount: 8.0 }];
    const cols = await makeDataset('ub_none', rows);
    const { findings, matched } = await runUpperBoundChecks('ub_none', cols, engine);
    ok(matched.length === 0 && findings.length === 0, 'run(none): no bounded columns → nothing matched or flagged');
  }

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
