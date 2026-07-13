// ============================================================
// DATAGLOW — Debate transparency / diagnostics view model (Gen 42, Part 6)
// ============================================================
// The "I Don't Know" resolution engine (js/agents/uncertainty-resolver-agent.js)
// deliberately shows the user only ONE unified suggestion (Step D) — never its
// internal three-agent debate. That default is correct and unchanged.
//
// This module is a PRESENTATION/DIAGNOSTICS layer, not new debate logic. Given a
// resolution object from resolve(), it derives an OPT-IN "why did you suggest
// this?" view model from data the debate ALREADY computed (each persona's
// proposal + its own confidence, and the confidence-weighted reconciliation that
// picked the winner). It runs no LLM, touches no network, and does not re-run or
// alter the debate — it only re-groups the proposals resolve() already carries on
// `resolution.debate`.
//
// DESIGN PRINCIPLE (from prior trust research): NO opaque single aggregate "trust
// score". Confidence is shown PER PERSONA, alongside the reconciliation math
// (per-answer summed confidence + how far the winner led the runner-up), so the
// number is falsifiable and per-artefact rather than a collapsed badge pretending
// to more precision than it has.
//
// GRACEFUL DEGRADATION: the deterministic no-LLM fallback proposals share the
// same { role, answer, confidence } shape as parsed LLM replies, so the view
// model renders identically for both. When the 2-second budget was exceeded and
// the panel skipped to a safe default, that is stated explicitly.

// Human-readable persona labels. The three debate roles are internal identifiers
// (conservative / industry-norm / statistical); the user sees plain descriptions
// of the viewpoint, never the raw role token.
export const PERSONA_LABELS = Object.freeze({
  conservative: 'Strict reading',
  'industry-norm': 'What similar datasets do',
  statistical: "This data's own distribution",
});

// Group proposals by normalised answer and sum confidence per group — mirrors the
// resolver's reconcile() grouping so the diagnostics show the SAME math that
// chose the winner, without importing or re-running reconcile itself. Returns
// groups sorted by summed confidence, descending.
function groupProposals(proposals) {
  const groups = new Map(); // normalised answer -> { answer, total, count }
  for (const p of proposals) {
    if (!p || typeof p.answer !== 'string' || p.answer.trim() === '' || typeof p.confidence !== 'number') continue;
    const key = p.answer.trim().toLowerCase();
    const conf = Math.max(0, Math.min(1, p.confidence));
    if (!groups.has(key)) groups.set(key, { answer: p.answer, total: 0, count: 0 });
    const g = groups.get(key);
    g.total += conf;
    g.count += 1;
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Build the opt-in debate transparency view model from a resolution.
 *
 * @param {object} resolution  a resolve() return value.
 * @returns {{
 *   available: boolean, resolvedBy: (string|null), reason?: string,
 *   budgetExceeded?: boolean, note?: (string|null),
 *   personas?: Array<{role,label,answer,confidence,confidencePct}>,
 *   groups?: Array<{answer,totalConfidence,count,isWinner}>,
 *   winner?: ({answer,agreement,meanConfidence}|null), margin?: (number|null)
 * }}
 *
 * `available:false` (with a plain-language `reason`) for A/B resolutions and any
 * resolution that carries no debate — there was no debate to reveal, so the
 * caller should hide the disclosure rather than fabricate one.
 */
export function buildDebateDiagnostics(resolution) {
  const r = resolution || {};
  // Only Step C (or a Step-C→fallback) ran a debate. A statistical-confidence
  // check (A) and a peer-index borrow (B) resolve without one.
  if (r.resolvedBy !== 'C' && r.resolvedBy !== 'fallback') {
    return { available: false, resolvedBy: r.resolvedBy || null, reason: 'This was answered without a debate.' };
  }
  const debate = r.debate || null;
  if (!debate) {
    return { available: false, resolvedBy: r.resolvedBy || null, reason: 'No debate detail was recorded for this answer.' };
  }

  const budgetExceeded = debate.budgetExceeded === true;
  const rawProposals = Array.isArray(debate.proposals) ? debate.proposals : [];

  // Budget blown before any persona could weigh in → nothing but the budget note.
  if (rawProposals.length === 0) {
    return {
      available: true, resolvedBy: r.resolvedBy, budgetExceeded,
      personas: [], groups: [], winner: null, margin: null,
      note: budgetExceeded
        ? 'The on-device panel ran out of its 2-second budget before any viewpoint could weigh in, so I skipped to a safe default.'
        : 'No viewpoints were recorded, so I used a safe default.',
    };
  }

  const personas = rawProposals.map((p) => {
    const conf = Math.max(0, Math.min(1, typeof p.confidence === 'number' ? p.confidence : 0));
    return {
      role: p.role,
      label: PERSONA_LABELS[p.role] || String(p.role || 'viewpoint'),
      answer: p.answer,
      confidence: conf,
      confidencePct: Math.round(conf * 100),
    };
  });

  const sorted = groupProposals(rawProposals);
  // When the budget was exceeded, reconciliation was intentionally SKIPPED — so we
  // report no winner even if partial proposals were gathered, matching what the
  // resolver actually did (it fell back rather than reconcile).
  const winnerGroup = (!budgetExceeded && sorted.length > 0) ? sorted[0] : null;
  const runnerUp = sorted.length > 1 ? sorted[1] : null;
  const margin = winnerGroup ? round3(winnerGroup.total - (runnerUp ? runnerUp.total : 0)) : null;

  const groups = sorted.map((g, i) => ({
    answer: g.answer,
    totalConfidence: round3(g.total),
    count: g.count,
    isWinner: winnerGroup ? i === 0 : false,
  }));

  return {
    available: true,
    resolvedBy: r.resolvedBy,
    budgetExceeded,
    note: budgetExceeded
      ? 'The on-device panel ran out of its 2-second budget, so I skipped to a safe default instead of finishing the debate.'
      : null,
    personas,
    groups,
    winner: winnerGroup
      ? { answer: winnerGroup.answer, agreement: winnerGroup.count, meanConfidence: round3(winnerGroup.total / winnerGroup.count) }
      : null,
    margin,
  };
}
