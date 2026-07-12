// ============================================================
// DATAGLOW — Data Diplomacy, Batch 1: reconciliation engine
// ============================================================
// The deterministic referee between two SEALED claims (js/diplomacy/diplomacy-claim.js)
// about the SAME entity+field. It does NOT call an LLM, hit a network, or guess.
// It applies one honest, explainable heuristic and — crucially — REFUSES to pick
// a side when it has no basis to, returning `resolved:false` rather than
// inventing a winner. That refusal is the whole point: this project's "precise
// AI-validation claim" philosophy (see NORTH_STAR.md / docs/capability-map.md)
// values an honest "I cannot tell" over false confidence.
//
// THE HEURISTIC (deterministic, in order):
//   1. Both claims must be about the same entityId AND field, or the engine
//      refuses ('entity/field mismatch') — it never reconciles apples to oranges.
//   2. If BOTH claims carry a confidence and they differ by MORE than
//      options.tieThreshold (default 0.05), the higher-confidence claim wins and
//      the rationale cites the actual numbers used.
//   3. Otherwise (confidences tied within the threshold, or either missing), if
//      the caller supplied an options.sourceTrust ranking AND it separates the
//      two sources, the higher-trust source wins and the rationale cites the
//      actual trust ranks used.
//   4. Otherwise the engine refuses: 'insufficient signal to auto-reconcile —
//      needs human debate'. It NEVER silently defaults to a side.
//
// PURITY (mirrors js/gate/readiness-gate.js's discipline): reconcileClaims is
// PURE and NEVER THROWS — it always returns a single well-formed result object,
// even for garbage/empty input. No DOM, no engine, no network.

const DEFAULT_TIE_THRESHOLD = 0.05;

// A well-formed result is ALWAYS this shape, resolved or not, so callers never
// branch on missing keys. On an unresolved result winningClaim/losingClaim are
// null and marginOfConfidence is null.
function makeResult({
  resolved,
  reason = null,
  winningClaim = null,
  losingClaim = null,
  rationale = '',
  marginOfConfidence = null,
}) {
  return { resolved, reason, winningClaim, losingClaim, rationale, marginOfConfidence };
}

function isClaimLike(c) {
  return !!c && typeof c === 'object' && typeof c.entityId !== 'undefined' && typeof c.field !== 'undefined';
}

function finiteConfidence(c) {
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

// Resolve a source's trust rank from the caller's optional ranking. Accepts
// either an ARRAY (most-trusted first) or an OBJECT map (source -> numeric rank,
// higher = more trusted). Returns null when the source is unranked/absent so the
// engine treats it as "no signal" rather than a silent zero.
function trustRank(sourceTrust, source) {
  if (!sourceTrust || source == null) return null;
  if (Array.isArray(sourceTrust)) {
    const idx = sourceTrust.indexOf(source);
    return idx === -1 ? null : sourceTrust.length - idx;
  }
  if (typeof sourceTrust === 'object') {
    const v = sourceTrust[source];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return null;
}

/**
 * Reconcile two sealed claims into a single verdict. PURE: no side effects,
 * never throws, always returns a well-formed result object.
 *
 * @param {object} claimA  a sealed claim (js/diplomacy/diplomacy-claim.js)
 * @param {object} claimB  the competing sealed claim
 * @param {object} [options]
 * @param {number} [options.tieThreshold=0.05]  confidences within this are a tie
 * @param {Array<string>|Object<string,number>} [options.sourceTrust]  tie-break
 *   ranking: array (most-trusted first) or map (source -> higher = more trusted)
 * @returns {{resolved:boolean, reason:(string|null), winningClaim:(object|null), losingClaim:(object|null), rationale:string, marginOfConfidence:(number|null)}}
 */
export function reconcileClaims(claimA, claimB, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const tieThreshold = Number.isFinite(opts.tieThreshold) ? opts.tieThreshold : DEFAULT_TIE_THRESHOLD;

  if (!isClaimLike(claimA) || !isClaimLike(claimB)) {
    return makeResult({
      resolved: false,
      reason: 'invalid claim input',
      rationale: 'Reconciliation needs two claim objects, each with an entityId and field.',
    });
  }

  if (claimA.entityId !== claimB.entityId || claimA.field !== claimB.field) {
    return makeResult({
      resolved: false,
      reason: 'entity/field mismatch',
      rationale:
        `Claims are not about the same thing: A is "${claimA.field}" of "${claimA.entityId}", `
        + `B is "${claimB.field}" of "${claimB.entityId}". Refusing to reconcile unrelated claims.`,
    });
  }

  const confA = finiteConfidence(claimA.confidence);
  const confB = finiteConfidence(claimB.confidence);

  // Step 2 — decide by confidence when both provide one and they differ enough.
  if (confA != null && confB != null) {
    const margin = Math.abs(confA - confB);
    if (margin > tieThreshold) {
      const aWins = confA > confB;
      const winningClaim = aWins ? claimA : claimB;
      const losingClaim = aWins ? claimB : claimA;
      const winConf = aWins ? confA : confB;
      const loseConf = aWins ? confB : confA;
      return makeResult({
        resolved: true,
        reason: 'resolved by confidence',
        winningClaim,
        losingClaim,
        marginOfConfidence: margin,
        rationale:
          `Preferred the "${winningClaim.source}" claim on confidence `
          + `${winConf} vs ${loseConf} (margin ${margin.toFixed(3)} exceeds the `
          + `${tieThreshold} tie threshold).`,
      });
    }
  }

  // Step 3 — confidence tied or missing: fall back to a caller-supplied source
  // trust ranking, if it actually separates the two sources.
  const rankA = trustRank(opts.sourceTrust, claimA.source);
  const rankB = trustRank(opts.sourceTrust, claimB.source);
  if (rankA != null && rankB != null && rankA !== rankB) {
    const aWins = rankA > rankB;
    const winningClaim = aWins ? claimA : claimB;
    const losingClaim = aWins ? claimB : claimA;
    const winRank = aWins ? rankA : rankB;
    const loseRank = aWins ? rankB : rankA;
    const confNote = (confA == null || confB == null)
      ? 'confidence was missing on at least one claim'
      : `confidence was tied within the ${tieThreshold} threshold`;
    return makeResult({
      resolved: true,
      reason: 'resolved by source trust',
      winningClaim,
      losingClaim,
      marginOfConfidence: null,
      rationale:
        `Confidence could not decide it (${confNote}); preferred the `
        + `"${winningClaim.source}" claim on higher source trust `
        + `(rank ${winRank} vs ${loseRank}).`,
    });
  }

  // Step 4 — no honest basis to pick a side. Refuse rather than guess.
  return makeResult({
    resolved: false,
    reason: 'insufficient signal to auto-reconcile — needs human debate',
    rationale:
      'Neither confidence nor source trust separates the two claims. Refusing to '
      + 'pick a side without a basis — this needs human debate.',
  });
}

/**
 * Human-readable, multi-line explanation of a reconciliation result. Pure string
 * builder in the same spirit as js/gate/readiness-gate.js's explainGateReasons().
 * @param {ReturnType<typeof reconcileClaims>} result
 * @returns {string}
 */
export function explainReconciliation(result) {
  if (!result || typeof result !== 'object') {
    return 'No reconciliation result to explain.';
  }
  const lines = [];
  if (result.resolved) {
    const w = result.winningClaim || {};
    const l = result.losingClaim || {};
    lines.push(`RESOLVED — "${w.source}" wins over "${l.source}".`);
    lines.push(`- Winning value: ${JSON.stringify(w.value)} (from "${w.source}").`);
    lines.push(`- Losing value: ${JSON.stringify(l.value)} (from "${l.source}").`);
    lines.push(`- Basis: ${result.rationale}`);
    if (result.marginOfConfidence != null) {
      lines.push(`- Confidence margin: ${result.marginOfConfidence.toFixed(3)}.`);
    }
  } else {
    lines.push(`UNRESOLVED — ${result.reason}.`);
    lines.push(`- ${result.rationale}`);
  }
  return lines.join('\n');
}

export { DEFAULT_TIE_THRESHOLD };
