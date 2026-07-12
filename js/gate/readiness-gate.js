// ============================================================
// DATAGLOW — AI Readiness Gate (pure scoring, batch 1 of 4)
// ============================================================
// WHY THIS EXISTS (the North Star concept, batch 1):
// A dataset, metric, or query result should not be handed to an AI AGENT until
// it has automatically earned a pass from DATAGLOW's existing validation. The
// research this project ran found that 60-84% of AI initiatives fail because
// ungoverned/unready data is handed to AI before it's fixed, and agents pointed
// at ungoverned data got answers wrong 65%+ of the time. This gate is the
// hard-stop-for-agents (never for humans) that answers that finding.
//
// WHAT THIS MODULE IS: a PURE aggregator. It does NOT re-run validation and it
// invents NO new checks or severity levels — it composes the OUTPUT that
// js/validation/validation.js's `runAllLayers()` already produced (each layer a
// `{ status, summary, ... }` record whose status vocabulary is
// pass / warn / fail / idle) plus an optional metric-contract status object,
// into a single agent-consumability verdict with an honest reasons list.
//
// WHAT IT DELIBERATELY DOES NOT DO YET (deferred to later batches; see
// NORTH_STAR.md "Build batches"):
//   - Batch 2: a UI badge (pass/fail + reasons) near query/metric results.
//   - Batch 3: wiring this verdict into js/agents/* as a hard block.
//   - Batch 4: exposing it via any future MCP interface.
// This batch is pure logic + tests ONLY. Nothing in the app calls it yet.
//
// Identity split (same convention as metric-studio.js / metric-contracts.js):
// this file is pure, Node-testable, no DOM / no network / no engine.

// The layer-status vocabulary is OWNED by js/validation/validation.js's
// `result(status, ...)` helper — we reuse it verbatim, never extend it.
//   'fail' — a hard failure: the layer found something disqualifying.
//   'warn' — a soft concern: worth surfacing, not by itself disqualifying.
//   'pass' — the layer ran and was satisfied.
//   'idle' — the layer was not activated this run (e.g. no story written yet);
//            it carries no evidence either way, so it is excluded from scoring.
const HARD_FAIL_STATUS = 'fail';
const WARN_STATUS = 'warn';
const PASS_STATUS = 'pass';

const DEFAULT_THRESHOLD = 70;

// A layer contributes to the score with this weight; a warn is a half-credit
// signal (present but not disqualifying), a fail earns nothing.
const STATUS_WEIGHT = { [PASS_STATUS]: 1, [WARN_STATUS]: 0.5, [HARD_FAIL_STATUS]: 0 };

// Normalize whatever `runAllLayers()` handed us into a flat list of
// { layer, status, summary } entries. Accepts either the keyed results OBJECT
// that `runAllLayers()` returns (layerId -> result) or an already-flat ARRAY of
// result-shaped entries. Non-layer aggregate keys the orchestrator mixes into
// its results object (e.g. `domainPack`, `calibratedGrades`) carry no string
// `status` and are skipped honestly rather than mis-scored.
function normalizeLayerResults(layerResults) {
  if (!layerResults || typeof layerResults !== 'object') return [];
  const entries = Array.isArray(layerResults)
    ? layerResults.map((r) => [r && r.layer != null ? r.layer : (r && r.id), r])
    : Object.entries(layerResults);
  const out = [];
  for (const [key, r] of entries) {
    if (!r || typeof r !== 'object' || typeof r.status !== 'string') continue;
    out.push({
      layer: (r.layer || r.name || key || 'unknown'),
      status: r.status,
      summary: typeof r.summary === 'string' ? r.summary : '',
    });
  }
  return out;
}

// Decide whether an OPTIONAL metric-contract status object signals a broken or
// invalid contract. Tolerant by design: it recognizes the honest "broken"
// shapes already used across the codebase — a computeMetricValue()-style
// `{ ok: false }`, an explicit `{ valid: false }` / `{ broken: true }`, or a
// textual `status`/`state` of invalid/broken/error/failed. Anything else
// (including undefined/null — no contract supplied) is treated as "not broken".
function isMetricContractBroken(metricContractStatus) {
  const s = metricContractStatus;
  if (!s || typeof s !== 'object') return false;
  if (s.ok === false) return true;
  if (s.valid === false) return true;
  if (s.broken === true) return true;
  const label = String(s.status || s.state || '').toLowerCase();
  return ['invalid', 'broken', 'error', 'failed', 'fail'].includes(label);
}

/**
 * Compose validation output + an optional metric-contract status into a single
 * agent-readiness verdict. PURE: no side effects, never throws, always returns
 * a well-formed object even for empty/missing input.
 *
 * @param {object|Array} layerResults - the OUTPUT of `runAllLayers()` (keyed
 *   results object) or a flat array of result-shaped entries. Not re-run here.
 * @param {object} [metricContractStatus] - optional; a broken/invalid contract
 *   fails the gate on its own regardless of layer results.
 * @param {{threshold?:number}} [options] - `threshold` (default 70) is the
 *   minimum score, 0-100, at or above which layers are considered gate-passing.
 * @returns {{
 *   agentConsumable: boolean,
 *   score: number,
 *   threshold: number,
 *   failingLayers: Array<{layer:string, severity:string, reason:string}>,
 *   passingSummary: string,
 *   blockedByContract: boolean,
 *   evaluatedLayerCount: number
 * }}
 */
export function computeReadinessGate(layerResults, metricContractStatus, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD;
  const layers = normalizeLayerResults(layerResults);

  // Only layers that actually carry evidence (pass/warn/fail) count toward the
  // score; 'idle' (not activated) layers are excluded from the denominator.
  const scored = layers.filter((l) => l.status in STATUS_WEIGHT);
  const failingLayers = layers
    .filter((l) => l.status === HARD_FAIL_STATUS)
    .map((l) => ({
      layer: l.layer,
      severity: HARD_FAIL_STATUS,
      reason: l.summary || 'Layer reported a hard failure.',
    }));
  const warnCount = layers.filter((l) => l.status === WARN_STATUS).length;
  const passCount = layers.filter((l) => l.status === PASS_STATUS).length;

  const score = scored.length === 0
    ? 0
    : Math.round((scored.reduce((sum, l) => sum + STATUS_WEIGHT[l.status], 0) / scored.length) * 100);

  const blockedByContract = isMetricContractBroken(metricContractStatus);

  const agentConsumable = !blockedByContract
    && failingLayers.length === 0
    && scored.length > 0
    && score >= threshold;

  const passingSummary = buildPassingSummary({
    agentConsumable, score, threshold, evaluated: scored.length,
    passCount, warnCount, failCount: failingLayers.length, blockedByContract,
  });

  return {
    agentConsumable,
    score,
    threshold,
    failingLayers,
    passingSummary,
    blockedByContract,
    evaluatedLayerCount: scored.length,
  };
}

function buildPassingSummary({ agentConsumable, score, threshold, evaluated, passCount, warnCount, failCount, blockedByContract }) {
  if (evaluated === 0 && !blockedByContract) {
    return 'No validation evidence available — not consumable by agents until validation runs.';
  }
  const tally = `${passCount} passed, ${warnCount} warning(s), ${failCount} failed across ${evaluated} evaluated layer(s)`;
  if (agentConsumable) {
    return `Ready for agent use — score ${score}/100 (≥ ${threshold}); ${tally}.`;
  }
  const blockers = [];
  if (blockedByContract) blockers.push('metric contract is invalid/broken');
  if (failCount > 0) blockers.push(`${failCount} layer(s) hard-failed`);
  if (evaluated > 0 && score < threshold) blockers.push(`score ${score}/100 is below the ${threshold} threshold`);
  return `Blocked from agent use — ${blockers.join('; ')}. (${tally}.)`;
}

/**
 * Human-readable, multi-line explanation of a gate verdict: exactly which
 * layers failed and why, plus the contract block if present. Pure string
 * builder for future UI use in batch 2 — builds NO DOM here.
 * @param {ReturnType<typeof computeReadinessGate>} gateResult
 * @returns {string}
 */
export function explainGateReasons(gateResult) {
  if (!gateResult || typeof gateResult !== 'object') {
    return 'No gate result to explain.';
  }
  const { agentConsumable, score, threshold, failingLayers = [], blockedByContract } = gateResult;
  const lines = [];
  lines.push(agentConsumable
    ? `PASS — agent-consumable (score ${score}/100, threshold ${threshold}).`
    : `BLOCKED — not agent-consumable (score ${score}/100, threshold ${threshold}).`);

  if (blockedByContract) {
    lines.push('- Metric contract: invalid/broken — this alone blocks agent use.');
  }
  if (failingLayers.length > 0) {
    lines.push(`Failing layer(s) (${failingLayers.length}):`);
    for (const f of failingLayers) {
      lines.push(`- ${f.layer} [${f.severity}]: ${f.reason}`);
    }
  } else if (!blockedByContract && !agentConsumable) {
    lines.push('- No layer hard-failed, but the score is below threshold (unresolved warnings or too little evidence).');
  } else if (!blockedByContract) {
    lines.push('- No failing layers.');
  }
  return lines.join('\n');
}

export { DEFAULT_THRESHOLD };
