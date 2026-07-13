// ============================================================
// DATAGLOW — The Crucible Batch 3: revert-eligibility unit tests
// ============================================================
// Exercises the PURE, DOM-free, never-throwing classifier + proposal builder in
// js/provenance/revert-eligibility.js:
//   classifyRevertEligibility / buildRevertProposal / summarizeRevertProposals.
// Fixtures are built with the REAL buildBlameDetail + normalizeBlameEntry from
// js/provenance/data-blame.js (never a hand-rolled shape), using the EXACT
// rule/fixType strings js/cleaning/clean.js applyFix() records, so the classifier
// is verified against the objects it will actually receive.
//
// RUN WITH:  node test/revert-eligibility.test.mjs   (no DuckDB, no network, no DOM)

import {
  classifyRevertEligibility,
  buildRevertProposal,
  summarizeRevertProposals,
} from '../js/provenance/revert-eligibility.js';
import { buildBlameDetail, normalizeBlameEntry } from '../js/provenance/data-blame.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Build a realistic provenance step the way recordStep would: an op/description
// plus a `detail` produced by the real buildBlameDetail. Returns the normalized
// blame entry (the shape the classifier consumes in the app).
let idx = 0;
function entry({ rule, column, affectedCount = null, predicate = null, before, after, hash }) {
  const detailArgs = { rule, column, affectedCount, predicate };
  if (before !== undefined) detailArgs.before = before;
  if (after !== undefined) detailArgs.after = after;
  const step = {
    index: idx++,
    op: 'clean',
    description: `${rule} on ${column}`,
    ts: Date.now(),
    hash: hash != null ? hash : `hash-${idx}`,
    detail: buildBlameDetail(detailArgs),
  };
  return normalizeBlameEntry(step);
}

function main() {
  // ---- UPDATE-style WITH before/after -> eligible / update ----
  {
    const e = entry({ rule: 'fill_zero', column: 'age', affectedCount: 4, before: null, after: 0 });
    const v = classifyRevertEligibility(e);
    ok(v.eligible === true && v.category === 'update', 'fill_zero with before/after -> eligible/update');

    const p = buildRevertProposal(e);
    ok(p.eligible === true && p.column === 'age', 'fill_zero proposal targets the right column');
    ok(p.restoreValue === null, 'fill_zero proposal restoreValue is the recorded NULL before-value (present, not fabricated)');
    ok(typeof p.humanDescription === 'string' && /Restore/.test(p.humanDescription) && /age/.test(p.humanDescription), 'fill_zero proposal has a plain-language humanDescription');
    ok(p.sourceStepHash != null, 'fill_zero proposal carries the source step hash when available');

    // abs_value + null_out + trim are all UPDATE-style too
    for (const rule of ['abs_value', 'null_out', 'trim']) {
      const ee = entry({ rule, column: 'score', before: -5, after: 5 });
      ok(classifyRevertEligibility(ee).eligible === true, `${rule} with before/after -> eligible/update`);
    }
  }

  // ---- DELETE-style -> not eligible / delete, with a clear reason ----
  {
    for (const rule of ['drop_rows', 'dedupe']) {
      const e = entry({ rule, column: 'age', affectedCount: 3 });
      const v = classifyRevertEligibility(e);
      ok(v.eligible === false && v.category === 'delete', `${rule} -> not eligible / delete`);
      ok(/row/i.test(v.reason) && /(gone|removed|delete|restore)/i.test(v.reason), `${rule} reason explains rows are gone / nothing to restore`);
      const p = buildRevertProposal(e);
      ok(p.eligible === false && p.category === 'delete' && typeof p.reason === 'string', `${rule} proposal mirrors the ineligible verdict`);
    }
  }

  // ---- Aggregate fills -> not eligible / aggregate, recompute-divergence reason ----
  {
    for (const rule of ['fill_mean', 'fill_mode']) {
      const e = entry({ rule, column: 'age', affectedCount: 7, before: null, after: 42 });
      const v = classifyRevertEligibility(e);
      ok(v.eligible === false && v.category === 'aggregate', `${rule} -> not eligible / aggregate (even WITH before/after present)`);
      ok(/(comput|recompute|diverg)/i.test(v.reason), `${rule} reason explains the recompute-divergence risk`);
    }
  }

  // ---- UPDATE-style rule but before/after NOT captured -> insufficient-detail ----
  // (This is the REAL app case today: main.js records buildBlameDetail with only
  //  rule/column/affectedCount, no before/after.)
  {
    const e = entry({ rule: 'fill_zero', column: 'age', affectedCount: 4 });
    ok(e.before === undefined && e.after === undefined, 'sanity: real-app-style entry has no before/after');
    const v = classifyRevertEligibility(e);
    ok(v.eligible === false && v.category === 'insufficient-detail', 'UPDATE-style rule without before/after -> insufficient-detail');
    ok(/guess|captur|detail/i.test(v.reason), 'insufficient-detail reason explains the missing before/after');
  }

  // ---- Unrecognized rule -> insufficient-detail, never eligible ----
  {
    const e = entry({ rule: 'some_future_fix', column: 'x', before: 1, after: 2 });
    const v = classifyRevertEligibility(e);
    ok(v.eligible === false && v.category === 'insufficient-detail', 'unrecognized rule -> insufficient-detail (not eligible even with before/after)');
  }

  // ---- malformed / null / empty -> never throws, safe non-eligible ----
  {
    for (const bad of [undefined, null, 42, 'x', {}, [], { detail: null }, { rule: null }]) {
      let v;
      try { v = classifyRevertEligibility(bad); } catch (err) { v = { threw: true }; }
      ok(v && v.threw !== true && v.eligible === false, `classifyRevertEligibility(${JSON.stringify(bad)}) -> safe not-eligible, never throws`);
      let p;
      try { p = buildRevertProposal(bad); } catch (err) { p = { threw: true }; }
      ok(p && p.threw !== true && p.eligible === false, `buildRevertProposal(${JSON.stringify(bad)}) -> safe non-eligible, never throws`);
    }
  }

  // ---- summarizeRevertProposals over a realistic MIX ----
  {
    const trail = [
      entry({ rule: 'fill_zero', column: 'age', before: null, after: 0 }),      // eligible/update
      entry({ rule: 'abs_value', column: 'bal', before: -3, after: 3 }),        // eligible/update
      entry({ rule: 'drop_rows', column: 'age', affectedCount: 2 }),            // delete
      entry({ rule: 'dedupe', column: null }),                                  // delete
      entry({ rule: 'fill_mean', column: 'age', before: null, after: 30 }),     // aggregate
      entry({ rule: 'fill_zero', column: 'age', affectedCount: 1 }),            // insufficient-detail (no before/after)
      entry({ rule: 'mystery', column: 'x' }),                                  // insufficient-detail (unrecognized)
    ];
    const s = summarizeRevertProposals(trail);
    ok(s.eligibleCount === 2, 'summarize: 2 eligible (the two UPDATE-style with before/after)');
    ok(s.ineligibleCount === 5, 'summarize: 5 ineligible');
    ok(s.byCategory.update === 2, 'summarize: byCategory.update === 2');
    ok(s.byCategory.delete === 2, 'summarize: byCategory.delete === 2');
    ok(s.byCategory.aggregate === 1, 'summarize: byCategory.aggregate === 1');
    ok(s.byCategory['insufficient-detail'] === 2, 'summarize: byCategory insufficient-detail === 2');
    ok(s.proposals.length === 2 && s.proposals.every(p => p.eligible === true && typeof p.humanDescription === 'string'), 'summarize: one proposal per eligible entry, each with a humanDescription');
    ok(s.eligibleCount + s.ineligibleCount === trail.length, 'summarize: eligible + ineligible reconcile to the trail length');
  }

  // ---- summarize on malformed input -> zeroed summary, never throws ----
  {
    for (const bad of [undefined, null, 42, 'x', {}]) {
      let s;
      try { s = summarizeRevertProposals(bad); } catch (err) { s = { threw: true }; }
      ok(s && s.threw !== true && s.eligibleCount === 0 && s.ineligibleCount === 0 && s.proposals.length === 0, `summarizeRevertProposals(${JSON.stringify(bad)}) -> zeroed, never throws`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
