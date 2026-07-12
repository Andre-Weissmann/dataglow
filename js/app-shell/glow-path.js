// ============================================================
// DATAGLOW — Glow Path (adaptive next-action rail, Batch A: pure decision)
// ============================================================
// WHAT THIS IS: a PURE decision function that answers one question — "given
// what DATAGLOW already knows about the current session, what is the single
// most useful next action to surface to the analyst right now?". It mirrors the
// discipline of js/gate/readiness-gate.js: no DOM, no network, no engine, never
// throws, and it INVENTS nothing — it only composes fields the caller passed in
// (which the caller assembles from real `state`) into one honest suggestion.
//
// It re-uses the AI Readiness Gate's OUTPUT (an optional real computeReadinessGate()
// result the caller already computed) rather than re-running validation or the
// gate itself — same "compose, don't recompute" rule the gate module follows.
//
// The rail is purely a suggestion: it never blocks, delays, or gates anything for
// a human. The presenter (js/app-shell/glow-path-ui.js) turns this verdict into a
// dismissible rail; this file is the auditable logic, unit-testable in plain Node.
//
// densityLevel is accepted as a plain string from an optional future caller (see
// js/learning/proficiency-signal.js, a parallel batch) — this module has no
// dependency on it and defaults to 'low' if not supplied.

// The three density levels a caller may pass. Kept as a small closed set so the
// presenter and the (future) proficiency-signal caller agree on one vocabulary.
export const DENSITY_LEVELS = ['low', 'mid', 'high'];

// Symbolic CTA action ids. NEVER a DOM reference — the presenter maps these to a
// real click handler. 'none' means the rail (if shown at all) carries no button.
export const CTA_ACTIONS = {
  LOAD_DATA: 'load-data',
  RUN_VALIDATE: 'run-validate',
  REVIEW_WARNINGS: 'review-warnings',
  SEE_FAILING_LAYERS: 'see-failing-layers',
  SAVE_QUERY: 'save-query',
  NONE: 'none',
};

function normalizeDensity(level) {
  return DENSITY_LEVELS.includes(level) ? level : 'low';
}

// Coerce a possibly-missing summary into safe numeric counts. A missing field is
// treated as 0 (the most conservative reading — no warnings/failures asserted).
function safeCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Build the honest "not agent-ready" sub-message from the REAL failing layers the
// gate reported. Never fabricates a layer name — if the gate gave us no named
// failing layers (e.g. blocked purely on score/contract), we say so generically.
function describeGateBlock(gateResult) {
  const failing = Array.isArray(gateResult && gateResult.failingLayers)
    ? gateResult.failingLayers.filter(f => f && f.layer)
    : [];
  if (gateResult && gateResult.blockedByContract && failing.length === 0) {
    return 'A metric contract is invalid or broken. Humans can still see everything here — only the AI-agent path is paused.';
  }
  if (failing.length === 0) {
    return 'The validation score is below the agent-readiness threshold. Humans can still see everything here — only the AI-agent path is paused.';
  }
  const names = failing.map(f => f.layer);
  const shown = names.slice(0, 2).join(' and ');
  const rest = names.length > 2 ? ` (+${names.length - 2} more)` : '';
  const verb = failing.length === 1 ? 'is' : 'are';
  return `${shown}${rest} ${verb} failing. Humans can still see everything here — only the AI-agent path is paused.`;
}

/**
 * Decide the single most useful next action for the current session. PURE: no
 * side effects, never throws, always returns a well-formed object even for an
 * empty/malformed ctx (which reads as "no dataset loaded").
 *
 * @param {object} ctx - assembled by the caller from real app state. Fields:
 *   @param {boolean} [ctx.datasetLoaded]      - is any dataset loaded?
 *   @param {number}  [ctx.datasetLoadedAt]    - epoch ms the dataset was loaded.
 *   @param {boolean} [ctx.hasValidated]       - has validation run this session?
 *   @param {{pass?:number,warn?:number,fail?:number}} [ctx.validationSummary]
 *   @param {object}  [ctx.readinessGateResult] - REAL computeReadinessGate() output
 *     (never re-run here); only consulted when present.
 *   @param {number}  [ctx.lastQueryRepeatCount] - times the last query pattern repeated.
 *   @param {string}  [ctx.densityLevel]       - 'low'|'mid'|'high' (default 'low').
 * @returns {{
 *   message: (string|null),
 *   subMessage: (string|null),
 *   ctaLabel: (string|null),
 *   ctaAction: string,
 *   densityLevel: string,
 *   dismissed: boolean
 * }}
 */
export function computeGlowPathState(ctx) {
  const c = (ctx && typeof ctx === 'object') ? ctx : {};
  const densityLevel = normalizeDensity(c.densityLevel);

  // A neutral, honest "nothing to suggest" result — the base every branch clones.
  const neutral = {
    message: null,
    subMessage: null,
    ctaLabel: null,
    ctaAction: CTA_ACTIONS.NONE,
    densityLevel,
    // A pure function never dismisses — dismissal is session/UI state tracked by
    // the presenter's store, layered on top of this verdict.
    dismissed: false,
  };

  // Decision priority — FIRST MATCHING CONDITION WINS. Documented here so the
  // ordering is auditable; higher-priority (more fundamental / more blocking)
  // states always take precedence over lower-priority suggestions.
  //
  // (1) No dataset loaded → nothing can be built yet; prompt to load one.
  // (2) Loaded but never validated → prompt to run Validate before trusting it.
  // (3) A real readiness gate result says NOT agent-consumable → honest,
  //     human-still-sees-everything "agent path paused" message from real reasons.
  // (4) Validation produced warnings → prompt to review them.
  // (5) Everything clean AND the last query pattern repeated ≥3× → offer to save
  //     it — ONLY at 'mid'/'high' density; at 'low' we stay quiet (no message).
  // (6) Nothing actionable → neutral honest empty state.

  // (1) No dataset loaded.
  if (!c.datasetLoaded) {
    return {
      ...neutral,
      message: 'Load a file to get started — DATAGLOW checks it before you build anything on top of it.',
      subMessage: 'Drop a CSV, JSON, Excel, or Parquet file into the sidebar to begin.',
      ctaLabel: 'Load data',
      ctaAction: CTA_ACTIONS.LOAD_DATA,
    };
  }

  // (2) Dataset loaded but never validated.
  if (!c.hasValidated) {
    return {
      ...neutral,
      message: 'Run Validate to check this file before you build anything on top of it.',
      subMessage: 'This dataset is loaded but hasn’t been checked yet — validation runs entirely on your device.',
      ctaLabel: 'Run Validate',
      ctaAction: CTA_ACTIONS.RUN_VALIDATE,
    };
  }

  // (3) A real readiness gate result present AND not agent-consumable. We consult
  // the gate's OWN output (failingLayers / blockedByContract) — never fabricating
  // a failing layer name — and honor the "humans always see everything" rule.
  const gate = c.readinessGateResult;
  if (gate && typeof gate === 'object' && gate.agentConsumable === false) {
    return {
      ...neutral,
      message: 'This result can’t go to an AI agent yet — validation is flagging it.',
      subMessage: describeGateBlock(gate),
      ctaLabel: 'See failing layers',
      ctaAction: CTA_ACTIONS.SEE_FAILING_LAYERS,
    };
  }

  // (4) Validation ran and produced warnings worth a look.
  const warn = safeCount(c.validationSummary && c.validationSummary.warn);
  if (warn > 0) {
    const noun = warn === 1 ? 'warning' : 'warnings';
    return {
      ...neutral,
      message: `Validation passed with ${warn} ${noun} — worth a look before you chart this.`,
      subMessage: 'Nothing hard-failed, but these are worth reviewing before you trust the numbers.',
      ctaLabel: 'Review warnings',
      ctaAction: CTA_ACTIONS.REVIEW_WARNINGS,
    };
  }

  // (5) Everything clean AND the last query pattern has repeated ≥3×. This is a
  // convenience nudge, not a correctness issue, so it is gated on density: only
  // shown to a 'mid'/'high'-proficiency session; at 'low' we prefer to stay quiet
  // rather than nag a newer user with a power-user shortcut.
  const repeat = safeCount(c.lastQueryRepeatCount);
  if (repeat >= 3 && (densityLevel === 'mid' || densityLevel === 'high')) {
    return {
      ...neutral,
      message: 'Same query pattern as your last few runs — want to save it?',
      subMessage: `You’ve run this pattern ${repeat} times — saving it makes it one click next time.`,
      ctaLabel: 'Save query',
      ctaAction: CTA_ACTIONS.SAVE_QUERY,
    };
  }

  // (6) Nothing actionable — honest empty state (presenter renders nothing).
  return neutral;
}
