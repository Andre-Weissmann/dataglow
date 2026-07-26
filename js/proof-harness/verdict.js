// ============================================================
// DATAGLOW - Proof Harness verdict engine (v0 GREEN/RED/GRAY + v1 AMBER)
// ============================================================
// WHY THIS EXISTS
// Doctrine invariant #6: "There are exactly four verdicts: GREEN (proven),
// RED (refuted), GRAY (not provable, blocker named), AMBER (stale, re-prove
// required). No fifth state." v0 shipped three of the four -- AMBER staleness
// was explicitly deferred to v1 (PROOF_HARNESS_V0_SPEC.md: "AMBER staleness
// graph (v1)"). PROOF_HARNESS_V1_SPEC.md ships the minimal slice of AMBER:
// staleness only, when a receipt exists but the proposal's current digest no
// longer matches the digest that receipt was bound to (the statement or
// expectation changed after the receipt was written). This is NOT a fifth
// mystery state layered on top -- it is the fourth state the doctrine always
// named, added by the one new input (`staleness`) callers can now supply.
//
// This module is the pure decision function: given a claim, an engine run
// result, and (optionally) what was expected, it returns exactly one of
// GREEN / RED / GRAY / AMBER plus a machine-checkable reason code and a
// one-line human reason. It NEVER returns a confidence percentage on the
// verdict itself (doctrine #6: "No confidence percentages on verdicts").
//
// A false GREEN is a release blocker (doctrine #7), so this function is
// deliberately conservative: any ambiguity about whether the run actually
// answers the claim resolves to GRAY, never to a guessed GREEN. Likewise v1's
// Second Engine Rule (second-engine.js) can only ever pull a candidate GREEN
// DOWN to RED on disagreement -- it is checked here as `a.corroboration`,
// and disagreement blocks GREEN unconditionally, before staleness is even
// considered, because a run that disagrees with a second engine is refuted
// regardless of whether its receipt is fresh or stale.
//
// PURITY: no DOM, no network, no engine call. Pure function of its inputs.

export const VERDICT_STATES = Object.freeze(['GREEN', 'RED', 'GRAY', 'AMBER']);

export const VERDICT_REASON_CODES = Object.freeze({
  RUN_ERROR: 'run-error',
  NO_PROPOSAL: 'no-proposal',
  NO_RUN: 'no-run',
  EMPTY_STATEMENT: 'empty-statement',
  NO_EXPECTATION: 'no-expectation',
  SCALAR_MISMATCH: 'scalar-mismatch',
  ROWCOUNT_MISMATCH: 'rowcount-mismatch',
  ROWCOUNT_BAND_MISS: 'rowcount-band-miss',
  MATCH: 'match',
  CORROBORATION_DISAGREE: 'corroboration-disagree',
  STALE_DIGEST: 'stale-digest',
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Decide the verdict for a claim given the engine run that was produced to
 * prove or refute it, and (optionally) what was expected.
 *
 * Decision order (first match wins), each aimed at "refuse to guess":
 *   1. No proposal / no statement           -> GRAY, blocker named
 *   2. Stale digest (v1 AMBER)               -> AMBER, re-prove required (a
 *      receipt exists but the proposal's current content no longer matches
 *      the digest that receipt was bound to; checked early because a stale
 *      proposal's old run/comparison describe a DIFFERENT statement and must
 *      not be read as if they still prove the current one)
 *   3. No run at all (never executed)       -> GRAY, blocker named
 *   4. Run errored                          -> RED (the run itself refutes
 *      execution: doctrine treats a run that could not complete as refuted,
 *      not as unprovable, because the claim WAS attempted and failed)
 *   5. No expectation to compare against    -> GRAY, blocker named (a run
 *      with nothing to check it against is not proof of anything)
 *   6. Expected scalars/rowCount compared to the run's scalars/rowCount via
 *      score-claim.js's compareClaimToRun -- match => candidate GREEN,
 *      mismatch => RED
 *   7. Second Engine Rule (v1): a candidate GREEN is only FINAL once any
 *      supplied `corroboration` result is checked -- corroboration.agrees
 *      === false blocks GREEN and forces RED, never silently passing through
 *
 * @param {{claim?: {text?:string, scalars?:object, rowCount?:number}|null,
 *          run?: {status?:'ok'|'error', rowCount?:number|null, scalars?:object,
 *                 error?:string|null, durationMs?:number}|null,
 *          expected?: {scalars?:object, rowCount?:number, rowcountBand?:[number,number]}|null,
 *          proposal?: object|null,
 *          comparison?: {pass:boolean, mismatches?: Array<object>}|null,
 *          corroboration?: {engine?:string, agrees?:boolean, tolerance?:number,
 *                 divergence_class?:string|null, ran?:boolean}|null,
 *          staleness?: {stale:boolean, reason?:string}|null}} args
 * @returns {{state:'GREEN'|'RED'|'GRAY'|'AMBER', reasonCode:string, reason:string, blocker:string|null}}
 */
export function decideVerdict(args) {
  const a = isPlainObject(args) ? args : {};
  const proposal = a.proposal;
  const run = a.run;
  const expected = isPlainObject(a.expected) ? a.expected : null;

  if (!isPlainObject(proposal) || typeof proposal.statement !== 'string' || !proposal.statement.trim()) {
    return {
      state: 'GRAY',
      reasonCode: VERDICT_REASON_CODES.NO_PROPOSAL,
      reason: 'There is no typed proposal to run yet.',
      blocker: 'A proposal with a SQL statement is required before anything can be proven.',
    };
  }

  const staleness = isPlainObject(a.staleness) ? a.staleness : null;
  if (staleness && staleness.stale === true) {
    return {
      state: 'AMBER',
      reasonCode: VERDICT_REASON_CODES.STALE_DIGEST,
      reason: 'The proposal changed since its receipt was written, so that receipt no longer proves the current statement.',
      blocker: typeof staleness.reason === 'string' && staleness.reason.trim()
        ? staleness.reason.trim()
        : 'Press Prove again to bind a fresh receipt to the current statement.',
    };
  }

  if (!isPlainObject(run)) {
    return {
      state: 'GRAY',
      reasonCode: VERDICT_REASON_CODES.NO_RUN,
      reason: 'This proposal has not been run yet.',
      blocker: 'Press Prove to run the statement against the live engine before a verdict can be reached.',
    };
  }

  if (run.status === 'error' || (typeof run.error === 'string' && run.error.trim())) {
    return {
      state: 'RED',
      reasonCode: VERDICT_REASON_CODES.RUN_ERROR,
      reason: 'The engine could not execute this statement.',
      blocker: typeof run.error === 'string' && run.error.trim() ? run.error.trim() : 'The engine returned an error.',
    };
  }

  if (!expected || (expected.scalars === undefined && expected.rowCount === undefined && expected.rowcountBand === undefined)) {
    return {
      state: 'GRAY',
      reasonCode: VERDICT_REASON_CODES.NO_EXPECTATION,
      reason: 'The run succeeded but nothing was specified to check it against.',
      blocker: 'Add an expected row count or scalar value to the proposal so the result can be judged.',
    };
  }

  const corroboration = isPlainObject(a.corroboration) ? a.corroboration : null;

  // Second Engine Rule (v1): wraps every candidate-GREEN return below. A
  // supplied corroboration result with agrees === false blocks GREEN
  // unconditionally and forces RED instead -- disagreement between two
  // independent engines refutes the claim, it does not merely make it
  // unprovable (GRAY), because both engines DID run and they disagree, which
  // is itself a definite, checkable fact. agrees === true or no corroboration
  // supplied at all (single-engine, v0 strength) both let the candidate
  // GREEN stand unchanged.
  function gateGreen(candidate) {
    if (corroboration && corroboration.agrees === false) {
      const divergence = typeof corroboration.divergence_class === 'string' && corroboration.divergence_class.trim()
        ? corroboration.divergence_class.trim()
        : 'result-mismatch';
      const engineName = typeof corroboration.engine === 'string' && corroboration.engine.trim() ? corroboration.engine.trim() : 'the second engine';
      return {
        state: 'RED',
        reasonCode: VERDICT_REASON_CODES.CORROBORATION_DISAGREE,
        reason: `The primary engine and ${engineName} do not agree on this result.`,
        blocker: `Corroboration disagreement (${divergence}): the second engine did not reproduce the primary engine's result within tolerance.`,
      };
    }
    return candidate;
  }

  const comparison = isPlainObject(a.comparison) ? a.comparison : null;
  if (comparison) {
    if (comparison.pass) {
      return gateGreen({
        state: 'GREEN',
        reasonCode: VERDICT_REASON_CODES.MATCH,
        reason: 'The engine result matches what was expected.',
        blocker: null,
      });
    }
    const mismatches = Array.isArray(comparison.mismatches) ? comparison.mismatches : [];
    const first = mismatches[0];
    const label = first && first.field ? String(first.field) : 'result';
    return {
      state: 'RED',
      reasonCode: mismatches.some((m) => m.field === 'rowCount') ? VERDICT_REASON_CODES.ROWCOUNT_MISMATCH : VERDICT_REASON_CODES.SCALAR_MISMATCH,
      reason: `The engine result does not match the expected ${label}.`,
      blocker: mismatches.map((m) => `${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.got)}`).join('; ') || 'The result did not match the expectation.',
    };
  }

  // No comparison object supplied: fall back to a direct rowCount check when
  // both sides have one, since that is the one scalar comparable everywhere
  // (mirrors scoreDrillAnswer's rowCount-first discipline in drill-floor.js).
  if (typeof expected.rowCount === 'number' && typeof run.rowCount === 'number') {
    if (run.rowCount === expected.rowCount) {
      return gateGreen({
        state: 'GREEN',
        reasonCode: VERDICT_REASON_CODES.MATCH,
        reason: `The row count matches the expected ${expected.rowCount}.`,
        blocker: null,
      });
    }
    return {
      state: 'RED',
      reasonCode: VERDICT_REASON_CODES.ROWCOUNT_MISMATCH,
      reason: 'The row count does not match what was expected.',
      blocker: `Expected rowCount ${expected.rowCount}, got ${run.rowCount}.`,
    };
  }

  if (Array.isArray(expected.rowcountBand) && expected.rowcountBand.length === 2 && typeof run.rowCount === 'number') {
    const [lo, hi] = expected.rowcountBand;
    if (run.rowCount >= lo && run.rowCount <= hi) {
      return gateGreen({
        state: 'GREEN',
        reasonCode: VERDICT_REASON_CODES.MATCH,
        reason: `The row count ${run.rowCount} falls within the expected band.`,
        blocker: null,
      });
    }
    return {
      state: 'RED',
      reasonCode: VERDICT_REASON_CODES.ROWCOUNT_BAND_MISS,
      reason: 'The row count falls outside the expected band.',
      blocker: `Expected rowCount in [${lo}, ${hi}], got ${run.rowCount}.`,
    };
  }

  return {
    state: 'GRAY',
    reasonCode: VERDICT_REASON_CODES.NO_EXPECTATION,
    reason: 'Nothing comparable was found between the expectation and the run.',
    blocker: 'Provide an expected rowCount, rowcountBand, or scalar map that matches a value the run produced.',
  };
}
