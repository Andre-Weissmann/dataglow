// ============================================================
// DATAGLOW — The Glow (signal aggregator, Batch 1 of 2)
// ============================================================
// WHY THIS EXISTS (the concept, batch 1):
// DATAGLOW already computes four separate real trust/health numbers for the
// loaded dataset — the AI Readiness Gate verdict, the Trust Strip field states,
// the Golden Signals data-quality rates, and the CAT Scorecard letter grades.
// Each lives in its own corner of the UI. "The Glow" is one at-a-glance verdict
// (destined for a single glowing topbar orb in Batch 2) that answers "how is
// this dataset doing, right now, in one glance?" without making the analyst hunt
// across four surfaces.
//
// WHAT THIS MODULE IS: a PURE aggregator, in the exact spirit of
// js/gate/readiness-gate.js and js/app-shell/glow-path.js. It re-runs NOTHING
// and invents NO new validation, scoring formula, or severity vocabulary — it
// COMPOSES the OUTPUT the four existing modules already produced into one
// well-formed verdict object. "Compose, don't recompute": when a real readiness
// gate result is present, its score/agentConsumable is the authoritative number
// (it is the most-considered agent-readiness figure the app already has), and we
// never derive a competing score of our own on top of it. Every signal[] entry
// traces to a real field — nothing is fabricated. It never throws and returns a
// well-formed object even for empty/absent input.
//
// WHAT IT DELIBERATELY DOES NOT DO YET (deferred to Batch 2; nothing calls it):
//   - Batch 2: the UI — a single glowing orb in the topbar (color/pulse from
//     `status`, tooltip/panel from `signals`/`summary`/`nextAction`, wired into
//     main.js behind the `glowOrb` flag). No DOM is built here.
// This batch is pure logic + tests ONLY. Nothing in the app calls it yet.
//
// Identity split (same convention as readiness-gate.js / glow-path.js): this
// file is pure, Node-testable, no DOM / no network / no engine.

// The status vocabulary is REUSED verbatim from the Trust Strip field states
// (js/trust/trust-strip.js) — we never extend it. 'idle' means "no evidence
// either way, nothing loaded"; it is not a failure.
const STATUS = { OK: 'ok', WARN: 'warn', BAD: 'bad', IDLE: 'idle' };

// Trust Strip field state -> the ordinal severity we compare on. Higher wins
// when we fold many field states into one overall status.
const STATE_SEVERITY = { idle: 0, ok: 1, warn: 2, bad: 3 };

// Fold a list of Trust Strip field states into a single overall status by the
// worst-wins rule the strip's own dot colors already imply: any 'bad' -> bad;
// else any 'warn' -> warn; else 'ok' if anything real loaded; else 'idle'.
function foldFieldStates(fields) {
  let worst = STATUS.IDLE;
  let sawReal = false;
  for (const f of fields) {
    const state = f && typeof f.state === 'string' ? f.state : 'idle';
    if (state !== 'idle') sawReal = true;
    if ((STATE_SEVERITY[state] || 0) > (STATE_SEVERITY[worst] || 0)) worst = state;
  }
  if (worst === STATUS.IDLE && sawReal) return STATUS.OK;
  return worst;
}

// Map the readiness gate's boolean/score verdict onto our shared status
// vocabulary. agentConsumable === true is unambiguously 'ok'. When not
// consumable, a hard-failed layer or broken contract is 'bad'; a below-threshold
// score with no hard failures is a softer 'warn' (mirrors the gate's own
// distinction between failingLayers and a mere score gap). A gate that evaluated
// nothing is 'idle'.
function statusFromGate(gate) {
  if (gate.agentConsumable === true) return STATUS.OK;
  const failing = Array.isArray(gate.failingLayers) ? gate.failingLayers : [];
  if (gate.blockedByContract === true || failing.length > 0) return STATUS.BAD;
  if ((gate.evaluatedLayerCount || 0) === 0) return STATUS.IDLE;
  return STATUS.WARN;
}

// Build the honest one-line nextAction from the gate's OWN failing layers —
// never fabricating a layer name, mirroring describeGateBlock() in glow-path.js.
function nextActionFromGate(gate) {
  const failing = (Array.isArray(gate.failingLayers) ? gate.failingLayers : [])
    .filter((f) => f && f.layer);
  if (gate.blockedByContract === true && failing.length === 0) {
    return {
      label: 'Fix the metric contract',
      detail: 'A metric contract is invalid or broken — resolve it before this can go to an agent.',
    };
  }
  if (failing.length === 0) {
    return {
      label: 'Raise the readiness score',
      detail: typeof gate.passingSummary === 'string' && gate.passingSummary
        ? gate.passingSummary
        : 'The readiness score is below the agent-consumable threshold.',
    };
  }
  const names = failing.map((f) => f.layer);
  const shown = names.slice(0, 2).join(' and ');
  const rest = names.length > 2 ? ` (+${names.length - 2} more)` : '';
  const verb = failing.length === 1 ? 'is' : 'are';
  return {
    label: 'See failing layers',
    detail: `${shown}${rest} ${verb} failing — resolve before this is agent-consumable.`,
  };
}

// Flatten trust-strip fields into signal[] entries, tagged with their source.
function signalsFromTrust(trustSignals) {
  const fields = Array.isArray(trustSignals && trustSignals.fields) ? trustSignals.fields : [];
  const out = [];
  for (const f of fields) {
    if (!f || typeof f !== 'object') continue;
    out.push({
      source: 'trustStrip',
      label: typeof f.label === 'string' ? f.label : String(f.key || 'field'),
      value: typeof f.value === 'string' ? f.value : '',
      state: typeof f.state === 'string' ? f.state : 'idle',
      detail: typeof f.detail === 'string' ? f.detail : '',
    });
  }
  return out;
}

// Synthesize one signal[] entry from the CAT scorecard's overall grade. Traces
// to the real `overall` object; never invents a grade.
function signalFromCatScorecard(catScorecard) {
  const overall = catScorecard && catScorecard.overall;
  if (!overall || typeof overall !== 'object') return null;
  const grade = typeof overall.grade === 'string' ? overall.grade : '?';
  const score = Number.isFinite(overall.score) ? overall.score : null;
  // Map the letter grade onto the shared state vocabulary without inventing a
  // new scale: A/B are ok, C/D are a warn, F is bad.
  const state = grade === 'A' || grade === 'B' ? 'ok'
    : grade === 'F' ? 'bad'
    : (grade === 'C' || grade === 'D') ? 'warn' : 'idle';
  return {
    source: 'catScorecard',
    label: 'CAT overall',
    value: score != null ? `${grade} (${score})` : grade,
    state,
    detail: 'Completeness / Accuracy / Timeliness overall grade (CDC Data Quality Framework).',
  };
}

// Synthesize one signal[] entry recording that Golden Signals were computed,
// carrying the real rates verbatim. Presence-only: we do not judge the rates
// against thresholds here (that is the grades module's job, not ours), so the
// state stays 'ok' meaning "measured", never a fabricated pass/fail.
function signalFromGoldenSignals(goldenSignals) {
  if (!goldenSignals || typeof goldenSignals !== 'object') return null;
  const parts = [];
  if (Number.isFinite(goldenSignals.missingnessRate)) parts.push(`missing ${goldenSignals.missingnessRate}`);
  if (Number.isFinite(goldenSignals.outOfRangeRate)) parts.push(`out-of-range ${goldenSignals.outOfRangeRate}`);
  if (Number.isFinite(goldenSignals.duplicateRate)) parts.push(`dupes ${goldenSignals.duplicateRate}`);
  if (Number.isFinite(goldenSignals.freshnessHours)) parts.push(`${goldenSignals.freshnessHours}h old`);
  return {
    source: 'goldenSignals',
    label: 'Golden signals',
    value: parts.length ? parts.join(' · ') : 'measured',
    state: 'ok',
    detail: 'Missingness / out-of-range / duplicate rates + freshness (SRE Golden Signals, mapped to data quality).',
  };
}

/**
 * Compose the four existing real outputs into one Glow verdict. PURE: no side
 * effects, never throws, always returns a well-formed object even for empty or
 * missing input (which reads as status 'idle', score 0, no signals).
 *
 * @param {object} [input]
 * @param {object} [input.readinessGateResult] OUTPUT of computeReadinessGate()
 *   (agentConsumable/score/threshold/failingLayers/passingSummary/
 *   blockedByContract/evaluatedLayerCount). Authoritative when present — its
 *   score/consumability dominate; we never recompute a competing score.
 * @param {{loaded:boolean, fields:Array}} [input.trustSignals] OUTPUT of collectTrustSignals().
 * @param {object} [input.goldenSignals] OUTPUT of computeGoldenSignals().
 * @param {object} [input.catScorecard] OUTPUT of computeCATScore().
 * @returns {{
 *   status: ('ok'|'warn'|'bad'|'idle'),
 *   score: number,
 *   signals: Array<{source:string,label:string,value:string,state:string,detail:string}>,
 *   nextAction: ({label:string, detail:string}|null),
 *   summary: string
 * }}
 */
export function computeGlowSignal(input) {
  const i = (input && typeof input === 'object') ? input : {};
  const gate = (i.readinessGateResult && typeof i.readinessGateResult === 'object')
    ? i.readinessGateResult : null;

  // Assemble signals[] first — every entry traces to a real field, never faked.
  const signals = signalsFromTrust(i.trustSignals);
  const catSignal = signalFromCatScorecard(i.catScorecard);
  if (catSignal) signals.push(catSignal);
  const goldenSignal = signalFromGoldenSignals(i.goldenSignals);
  if (goldenSignal) signals.push(goldenSignal);

  // status/score: the readiness gate is the authoritative agent-readiness number
  // the app already computed — compose it, don't recompute. Fall back to folding
  // the trust-strip field states only when no gate result was supplied.
  let status;
  let score;
  let nextAction = null;
  if (gate) {
    status = statusFromGate(gate);
    score = Number.isFinite(gate.score) ? gate.score : 0;
    if (gate.agentConsumable === false) nextAction = nextActionFromGate(gate);
  } else {
    status = foldFieldStates(signalsFromTrust(i.trustSignals));
    // With no gate result there is no authoritative 0-100 number to compose, and
    // this module never invents one from scratch — so score stays 0 and status
    // carries the verdict. (Batch 2's orb reads status for color regardless.)
    score = 0;
  }

  const summary = buildGlowSummary({ status, score, hasGate: !!gate, signals, nextAction });

  return { status, score, signals, nextAction, summary };
}

// One honest human-readable sentence, in the tone of readiness-gate.js's
// buildPassingSummary(). Says plainly what the verdict is and why.
function buildGlowSummary({ status, score, hasGate, signals, nextAction }) {
  if (status === STATUS.IDLE) {
    return 'Nothing to glow about yet — no dataset signals available.';
  }
  const measured = `${signals.length} signal(s) composed`;
  if (hasGate) {
    if (status === STATUS.OK) {
      return `Glowing green — agent-ready at score ${score}/100; ${measured}.`;
    }
    const why = nextAction && nextAction.detail ? ` ${nextAction.detail}` : '';
    const color = status === STATUS.BAD ? 'red' : 'amber';
    return `Glowing ${color} — not agent-ready (score ${score}/100).${why} (${measured}.)`;
  }
  // No gate result: the verdict comes from the trust-strip field states.
  if (status === STATUS.OK) return `Looking healthy — trust signals are clear; ${measured}.`;
  if (status === STATUS.WARN) return `Worth a look — trust signals show warnings; ${measured}.`;
  return `Needs attention — trust signals show a problem; ${measured}.`;
}

/**
 * Human-readable, multi-line explanation of a Glow verdict, mirroring
 * explainGateReasons()'s format. Pure string builder for Batch 2 UI use —
 * builds NO DOM here.
 * @param {ReturnType<typeof computeGlowSignal>} glowResult
 * @returns {string}
 */
export function explainGlowSignal(glowResult) {
  if (!glowResult || typeof glowResult !== 'object') {
    return 'No glow result to explain.';
  }
  const { status, score, signals = [], nextAction, summary } = glowResult;
  const lines = [];
  const head = status === 'ok' ? 'GLOWING'
    : status === 'idle' ? 'IDLE'
    : status === 'bad' ? 'ALERT'
    : 'CAUTION';
  lines.push(`${head} — status ${status} (score ${score}/100).`);
  if (typeof summary === 'string' && summary) lines.push(summary);

  if (signals.length > 0) {
    lines.push(`Signals (${signals.length}):`);
    for (const s of signals) {
      lines.push(`- [${s.source}] ${s.label} [${s.state}]: ${s.value}`);
    }
  } else {
    lines.push('- No signals composed.');
  }

  if (nextAction && nextAction.label) {
    lines.push(`Next action: ${nextAction.label} — ${nextAction.detail}`);
  }
  return lines.join('\n');
}

export { STATUS as GLOW_STATUS };
