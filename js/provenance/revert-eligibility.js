// ============================================================
// DATAGLOW — The Crucible (Batch 3 of 3): revert PROPOSALS (proposal-only)
// ============================================================
// WHAT THIS IS: a pure, DOM-free, never-throwing classifier + proposal builder
// layered on top of the existing provenance blame trail
// (js/provenance/data-blame.js). It answers one narrow, honest question for a
// recorded cleaning transform: "could this change be reverted in principle, and
// if so, what would that revert DESCRIBE doing?" — and it answers it
// CONSERVATIVELY, never guessing.
//
// DELIBERATELY OUT OF SCOPE (not a gap — a safety choice):
//   - This module NEVER mutates data and emits NO executable SQL. A revert
//     proposal is inert, inspectable DATA describing an intent, nothing more.
//     Actually running a revert against live DuckDB would be brand-new, separate
//     future work needing its own safety review; it is NOT an already-planned
//     "Batch 4".
//   - DELETE-style fixes (drop_rows, dedupe) are PERMANENTLY not revert-eligible:
//     the rows are gone; the provenance trail records that they were removed, not
//     their full contents, so there is nothing to restore from.
//   - Aggregate-derived fills (fill_mean, fill_mode) are PERMANENTLY not
//     revert-eligible: the written value was computed from the data as it stood
//     at fix time; a naive "undo" cannot faithfully reconstruct the pre-fix state
//     and would risk silently diverging.
//   - Anything ambiguous (an UPDATE-style rule whose before/after detail was
//     never captured, or an unrecognized rule) is treated as NOT eligible. We
//     never fabricate a before-value we don't actually have on the trail.
//
// It reuses normalizeBlameEntry() from data-blame.js as the single source of the
// blame-entry shape — it invents no parallel shape.
// ============================================================

import { normalizeBlameEntry } from './data-blame.js';

// The cleaning fix taxonomy, using the EXACT rule/fixType strings that
// js/cleaning/clean.js applyFix() records (via buildBlameDetail's `rule`, with
// legacy `fixType` also understood by normalizeBlameEntry).
//   DELETE-style: rows removed — irreversible from the trail alone.
const DELETE_RULES = new Set(['drop_rows', 'dedupe']);
//   AGGREGATE-derived: value computed from the dataset — naive undo may diverge.
const AGGREGATE_RULES = new Set(['fill_mean', 'fill_mode']);
//   UPDATE-style: a per-cell overwrite that is restorable IN PRINCIPLE, but only
//   when the trail actually captured the before/after values.
const UPDATE_RULES = new Set(['fill_zero', 'abs_value', 'null_out', 'trim']);

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Coalesce whatever the caller hands us into the normalized blame-entry shape.
// Accepts a raw provenance step (has a `.detail` object -> run it through
// normalizeBlameEntry) OR an already-normalized blame entry (pass through).
// Never throws; anything unusable -> null.
function asBlameEntry(input) {
  if (!isPlainObject(input)) return null;
  if (isPlainObject(input.detail)) {
    try { return normalizeBlameEntry(input); } catch { return null; }
  }
  return input;
}

// "Usable before/after detail" means BOTH were actually recorded on the trail.
// `before`/`after` are only present on a blame entry when buildBlameDetail was
// called with them; a recorded `before: null` (e.g. fill_zero's NULL->0) IS
// usable, so we test presence (!== undefined), never truthiness.
function hasBeforeAfter(entry) {
  return entry.before !== undefined && entry.after !== undefined;
}

// ============================================================
// classifyRevertEligibility(blameEntry) -> { eligible, reason, category }
// Pure, never throws. category is one of:
//   'update'              — UPDATE-style with usable before/after (eligible:true)
//   'delete'              — DELETE-style, rows gone (eligible:false)
//   'aggregate'           — aggregate-derived, recompute risk (eligible:false)
//   'insufficient-detail' — UPDATE-style missing before/after, or unrecognized
//                           rule, or malformed input (eligible:false)
// ============================================================
export function classifyRevertEligibility(blameEntry) {
  const entry = asBlameEntry(blameEntry);
  if (!entry) {
    return {
      eligible: false,
      category: 'insufficient-detail',
      reason: 'No usable blame entry: input is missing or malformed, so revert-eligibility cannot be determined. Treated conservatively as not revert-eligible.',
    };
  }

  const rule = entry.rule != null ? String(entry.rule) : null;

  if (rule && DELETE_RULES.has(rule)) {
    return {
      eligible: false,
      category: 'delete',
      reason: `The "${rule}" fix removed rows. The provenance trail records that rows were deleted, not their full contents, so there is nothing to restore from — this is permanently not revert-eligible.`,
    };
  }

  if (rule && AGGREGATE_RULES.has(rule)) {
    return {
      eligible: false,
      category: 'aggregate',
      reason: `The "${rule}" fix wrote a value computed from the data as it stood at fix time. A naive undo cannot faithfully reconstruct the pre-fix state and would risk silently diverging, so this is permanently not revert-eligible.`,
    };
  }

  if (rule && UPDATE_RULES.has(rule)) {
    if (hasBeforeAfter(entry)) {
      return {
        eligible: true,
        category: 'update',
        reason: `The "${rule}" fix is a per-cell overwrite and the trail captured both the before and after values, so a revert can be described precisely.`,
      };
    }
    return {
      eligible: false,
      category: 'insufficient-detail',
      reason: `The "${rule}" fix is restorable in principle, but the trail did not capture the before/after values for it, so a faithful revert cannot be described without guessing. Treated conservatively as not revert-eligible.`,
    };
  }

  return {
    eligible: false,
    category: 'insufficient-detail',
    reason: rule
      ? `Unrecognized fix rule "${rule}": revert-eligibility is unknown, so it is treated conservatively as not revert-eligible.`
      : 'No fix rule recorded on this blame entry, so revert-eligibility cannot be determined. Treated conservatively as not revert-eligible.',
  };
}

// Plain-language, per-rule sentence describing what the revert would restore.
function describeRevert(rule, column, before, after) {
  const col = column != null ? `"${column}"` : 'the column';
  const beforeText = before === null ? 'NULL' : JSON.stringify(before);
  const afterText = after === null ? 'NULL' : JSON.stringify(after);
  const label = {
    fill_zero: 'fill_zero',
    abs_value: 'abs_value',
    null_out: 'null_out',
    trim: 'trim',
  }[rule] || rule;
  return `Restore ${beforeText} in column ${col} where it was previously set to ${afterText} by the ${label} fix.`;
}

// ============================================================
// buildRevertProposal(blameEntry) — for an ELIGIBLE entry, an inert, inspectable
// DATA description of the revert (never executable SQL). For an ineligible entry,
// mirrors the classifier's { eligible:false, reason } (plus category). Pure,
// never throws, never fabricates a value the trail does not hold.
// ============================================================
export function buildRevertProposal(blameEntry) {
  const verdict = classifyRevertEligibility(blameEntry);
  if (!verdict.eligible) {
    return { eligible: false, category: verdict.category, reason: verdict.reason };
  }

  const entry = asBlameEntry(blameEntry);
  const column = Array.isArray(entry.columns) && entry.columns.length ? entry.columns[0] : null;
  // `table` is not part of the normalized blame-entry shape; surface it only if
  // the caller actually carried one, else null (honest "unknown"), never faked.
  const table = typeof entry.table === 'string' ? entry.table
    : (isPlainObject(blameEntry) && typeof blameEntry.table === 'string' ? blameEntry.table : null);

  return {
    eligible: true,
    category: 'update',
    table,
    column,
    predicate: entry.predicate != null ? String(entry.predicate) : null,
    restoreValue: entry.before,
    sourceStepHash: entry.hash != null ? String(entry.hash) : null,
    humanDescription: describeRevert(entry.rule, column, entry.before, entry.after),
  };
}

// ============================================================
// summarizeRevertProposals(blameEntries) -> { eligibleCount, ineligibleCount,
// byCategory, proposals }. Runs the classifier/proposal builder over a whole
// trail (array of raw steps or normalized entries). Malformed/empty -> zeroed
// summary. Pure, never throws.
// ============================================================
export function summarizeRevertProposals(blameEntries) {
  const arr = Array.isArray(blameEntries) ? blameEntries : [];
  const byCategory = { update: 0, delete: 0, aggregate: 0, 'insufficient-detail': 0 };
  const proposals = [];
  let eligibleCount = 0;
  let ineligibleCount = 0;

  for (const raw of arr) {
    const verdict = classifyRevertEligibility(raw);
    byCategory[verdict.category] = (byCategory[verdict.category] || 0) + 1;
    if (verdict.eligible) {
      eligibleCount++;
      proposals.push(buildRevertProposal(raw));
    } else {
      ineligibleCount++;
    }
  }

  return { eligibleCount, ineligibleCount, byCategory, proposals };
}
