// ============================================================
// DATAGLOW — Crucible Orchestrator (glue layer)
// ============================================================
// PURE, DOM-free, NEVER-throwing orchestration that connects three
// already-built, already-tested Crucible modules into a single call the app can
// make right after a cleaning fix is recorded:
//
//   1. crucible-contract.js  — buildCleaningResult / buildValidationVerdict
//   2. crucible-adversarial-packs.js — runAdversarialSuite(CRUCIBLE_PACKS, agent)
//   3. revert-eligibility.js — classifyRevertEligibility / buildRevertProposal
//
// It invents NO new validation logic. The adversarial suite runs in a "standing
// suite" mode: the SAME reference agent — assembled only from primitives that
// already ship in the app (fuzzy-dedup character similarity, a Date.UTC calendar
// round-trip, and the physiological-plausibility vital bounds) — is probed by
// every pack. The suite therefore reflects the honest, documented capability of
// those shipped primitives, not something tuned per fix. Two gaps are surfaced
// on purpose: a pure character matcher cannot reunite name-order swaps (the
// AHIMA gap the name-order-swap pack exists to catch), and `age` is not a vital
// so an impossible age passes the bounds check untouched. When any pack fails
// the verdict is `escalate`, never `reject` — this glue layer has no authority
// to reject a fix a human already applied.
//
// ADDITIVE ONLY: every public entry point is wrapped so it can never throw. On
// any internal failure it returns a safe, well-shaped partial (nulls) so the
// caller (main.js, guarded further by its own try/catch and a default-off flag)
// can never be blocked, delayed, or altered by anything in here.

import { buildCleaningResult, buildValidationVerdict } from './crucible-contract.js';
import { CRUCIBLE_PACKS, runAdversarialSuite } from './crucible-adversarial-packs.js';
import { classifyRevertEligibility, buildRevertProposal } from '../provenance/revert-eligibility.js';
import { scoreFixConfidence } from '../cleaning/fix-confidence.js';
import { similarity } from '../cleaning/fuzzy-dedup.js';
import { matchVital, detectTempUnit, TEMP_BOUNDS } from './physiological-plausibility.js';

// A same-entity key is the record's name plus any SSN, joined — a pure
// character-similarity comparison of these keys is exactly the naive matcher the
// entity packs are built to stress. It reunites SSN transpositions (one changed
// digit barely moves the score) but NOT name-order swaps (reordered tokens score
// far below threshold) — the honest, documented behaviour.
const ENTITY_MATCH_THRESHOLD = 0.9;
function entityKey(record) {
  if (!record || typeof record !== 'object') return '';
  return [record.name, record.ssn].filter(v => v != null && v !== '').join(' ');
}

// Objective calendar validity via a Date.UTC round-trip: build the date, then
// confirm the engine did not roll any component over (Feb 29 in a non-leap year
// becomes Mar 1, day 32 becomes the next month, etc.). Returns the input string
// when it is a real calendar date, else null ("rejected").
function normalizeCalendarDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) {
    return value;
  }
  return null;
}

// Flag a field/value as physiologically impossible using only the shipped vital
// bounds. A field that is not a recognized vital (e.g. `age`) cannot be judged,
// so it is honestly NOT flagged — a real, surfaced coverage gap.
function flagsImpossibleValue(field, value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return false;
  const vital = matchVital(field);
  if (!vital) return false;
  if (vital.temperature) {
    const bounds = TEMP_BOUNDS[detectTempUnit(field, num)] || TEMP_BOUNDS.C;
    return num < bounds.low || num > bounds.high;
  }
  return num < vital.low || num > vital.high;
}

// The single synchronous "reference agent" every pack is run against. It
// dispatches purely on the shape of the case object each pack hands it, so one
// function can honestly answer all four packs. Never throws — runAdversarialSuite
// also guards each call, but we stay defensive here too.
export function crucibleReferenceAgent(testCase) {
  try {
    if (!testCase || typeof testCase !== 'object') return false;
    // Entity-matching case: { left, right, ... } -> truthy when SAME entity.
    if (testCase.left && testCase.right) {
      return similarity(entityKey(testCase.left), entityKey(testCase.right)) >= ENTITY_MATCH_THRESHOLD;
    }
    // Boundary-date case: { input } -> normalized value (truthy) or null.
    if (typeof testCase.input === 'string') {
      return normalizeCalendarDate(testCase.input);
    }
    // Impossible-value case: { field, value } -> truthy when flagged.
    if ('field' in testCase && 'value' in testCase) {
      return flagsImpossibleValue(testCase.field, testCase.value);
    }
    return false;
  } catch {
    return false;
  }
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// The empty/failed shape returned whenever anything is missing or throws. Always
// the same keys, so callers can destructure without guarding each field.
function emptyResult() {
  return { cleaningResult: null, validationVerdict: null, suiteResult: null, revertProposal: null };
}

// Build the CleaningResult that represents the fix that was just applied. The
// single change summarizes the fix (its column, the rule, and the recorded
// before/after when the blame entry captured them). Confidence reuses the app's
// own scoreFixConfidence (a 0–100 score) scaled into the contract's [0,1].
function buildFixCleaningResult(fixType, issue, blameEntry) {
  const column = (issue && issue.column) || fixType;
  let score = 60;
  try {
    const scored = scoreFixConfidence(issue || {}, fixType);
    if (scored && Number.isFinite(scored.score)) score = scored.score;
  } catch { /* keep neutral default */ }
  const built = buildCleaningResult({
    agentId: 'dataglow-clean-agent',
    confidence: clamp01(Number(score) / 100),
    rulesCited: [fixType],
    changes: [{
      field: String(column),
      rule: String(fixType),
      oldValue: blameEntry && blameEntry.before !== undefined ? blameEntry.before : null,
      newValue: blameEntry && blameEntry.after !== undefined ? blameEntry.after : null,
    }],
  });
  return built && built.ok ? built.result : null;
}

// Run the full standing adversarial suite against a fix and assemble the typed
// handoff (CleaningResult in, ValidationVerdict out) plus the revert-eligibility
// classification of that fix's blame entry. Pure, synchronous, never throws.
//
//   runCrucibleForFix({ fixType, issue, blameEntry })
//     -> { cleaningResult, validationVerdict, suiteResult, revertProposal }
//
// On ANY failure it returns the same-shaped empty result. It NEVER returns a
// `reject` decision: an all-passed suite yields `accept`, any failure yields
// `escalate` (route to a human), because this layer cannot undo an applied fix.
export function runCrucibleForFix(args) {
  try {
    if (!args || typeof args !== 'object') return emptyResult();
    const { fixType, issue, blameEntry } = args;
    if (!fixType || typeof fixType !== 'string') return emptyResult();

    const cleaningResult = buildFixCleaningResult(fixType, issue, blameEntry);

    const suiteResult = runAdversarialSuite(CRUCIBLE_PACKS, crucibleReferenceAgent);

    let validationVerdict = null;
    if (cleaningResult && suiteResult && Array.isArray(suiteResult.packResults)) {
      const allPassed = suiteResult.allPassed === true;
      const packResults = suiteResult.packResults.map(p => ({ id: p.id, passed: p.passed === true }));
      const builtVerdict = buildValidationVerdict({
        subjectResult: cleaningResult,
        packResults,
        decision: allPassed ? 'accept' : 'escalate',
        escalationReason: allPassed
          ? undefined
          : `${suiteResult.failedCount} of ${packResults.length} adversarial pack(s) failed — routed for human review. This validator has no authority to reject an already-applied fix.`,
      });
      validationVerdict = builtVerdict && builtVerdict.ok ? builtVerdict.verdict : null;
    }

    let revertProposal = null;
    if (blameEntry) {
      try {
        const eligibility = classifyRevertEligibility(blameEntry);
        revertProposal = buildRevertProposal(blameEntry) || eligibility || null;
      } catch { revertProposal = null; }
    }

    return { cleaningResult, validationVerdict, suiteResult, revertProposal };
  } catch {
    return emptyResult();
  }
}
