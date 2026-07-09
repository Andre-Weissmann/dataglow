// ============================================================
// DATAGLOW — Adaptive Layer Prioritization
// A small, transparent, on-device learner that reorders / highlights the
// existing validation layers by how often each one has historically caught a
// REAL issue for THIS user/dataset. Runs entirely in the browser. Uploads
// nothing. It is a UI/prioritization aid on top of the fixed 20 layers — it
// never changes what is validated, never hides a layer, and never disables one.
// ============================================================
//
// TECHNIQUE: Beta-Binomial Bayesian confidence with exponential recency
// weighting (a decaying moving average). For each layer we keep a decayed count
// of times the user ACTED on its flags (accept / apply / merge / edit / fix) vs
// DISMISSED them as noise (reject / dismiss / ignore / skip). The layer's
// priority score is the posterior mean of a Beta(accepts+α, dismisses+β)
// distribution — i.e. the estimated probability that a flag from this layer is a
// real issue. With the uniform prior α=β=1 this reduces to Laplace's Rule of
// Succession (Laplace 1814): (accepts+1)/(accepts+dismisses+2), which is 0.5
// with no evidence, so a layer we know nothing about stays neutral and keeps its
// original position. Recent behavior is weighted more heavily via an EWMA-style
// decay (exponentially weighted moving average, Roberts 1959): before each new
// event a layer's decayed counts are multiplied by DECAY (<1), so a check that
// used to be noise but is now catching real issues (or vice-versa) is followed.
//
// This is deliberately NOT a black-box / deep model: the score is a single ratio
// of two decayed counts, so every ranking decomposes into a plain sentence
// ("you acted on 7 of 8 flags from this check"), matching DATAGLOW's
// explainability ethos and the Self-Learning Validation Rules feature (PR #25).
//
// It reuses PR #25's interaction-tracking signal stream: the same accept/dismiss
// actions that train the logistic-regression ranker (via actionToLabel) also
// update these per-layer counts, so there is ONE tracking pathway, not two.
// This module is intentionally DOM-free and store-free so it is unit-testable in
// Node; the browser wires persistence in via an injected store (same pattern as
// the Self-Learning Rules and Distribution Fingerprint Drift layers), and
// toJSON/fromJSON make the learned counts portable to IndexedDB when the user
// opts in.

import { actionToLabel } from './self-learning-rules.js';

// Beta prior. α = β = 1 → uniform prior → Laplace's Rule of Succession, so a
// layer with no feedback scores exactly 0.5 (neutral, keeps original order).
const PRIOR_A = 1;
const PRIOR_B = 1;

// Exponential recency weighting. Each existing decayed count for a layer is
// multiplied by DECAY before a new event is added, so recent feedback dominates.
// 0.97 gives a soft half-life of ~23 events — enough memory to be stable, little
// enough to follow a genuine change in a layer's usefulness.
const DECAY = 0.97;

// Minimum total accept/dismiss actions (across all layers) before reordering is
// allowed to kick in. Below this the model stays silent and preserves the
// registry's original order — it genuinely knows nothing yet. Surfaced in the UI.
export const MIN_ACTIONS = 5;

// Score thresholds for the coarse, human-facing tier shown as a badge. A layer
// must also have at least one action to leave the neutral tier.
const PROMOTE_AT = 0.6;   // acted on more often than dismissed → surface it
const DEPRIORITIZE_AT = 0.4; // dismissed more often than acted on → sink it

// Beta posterior mean of the accept-rate given decayed accept/dismiss counts.
function betaMean(acc, dis) {
  return (acc + PRIOR_A) / (acc + dis + PRIOR_A + PRIOR_B);
}

// Per-layer learned prioritization from the user's own accept/dismiss history.
// Explainable by construction: the score is one ratio of two decayed counts.
export class LayerPriorityModel {
  constructor(options = {}) {
    this.decay = options.decay ?? DECAY;
    // layerId -> { fires, accepts, dismisses, dAccepts, dDismisses, at }
    // Raw counts (fires/accepts/dismisses) are kept for transparent display;
    // the d* counts are the decayed values that actually drive the score.
    this.layers = new Map();
  }

  _entry(layerId) {
    let e = this.layers.get(layerId);
    if (!e) {
      e = { fires: 0, accepts: 0, dismisses: 0, dAccepts: 0, dDismisses: 0, at: 0 };
      this.layers.set(layerId, e);
    }
    return e;
  }

  // Total accept/dismiss actions recorded across all layers. Drives the ready
  // gate — this is the evidence the reordering is allowed to act on.
  get totalActions() {
    let n = 0;
    for (const e of this.layers.values()) n += e.accepts + e.dismisses;
    return n;
  }

  // True once enough feedback exists to responsibly reorder/highlight.
  isReady() {
    return this.totalActions >= MIN_ACTIONS;
  }

  actionsUntilReady() {
    return Math.max(0, MIN_ACTIONS - this.totalActions);
  }

  // Record that a layer produced flags (it "fired") during a validation run.
  // Firing alone carries no accept/dismiss signal, so it does not move the
  // score — it is tracked for transparency ("fired N times") and to explain why
  // a layer with no feedback is still neutral.
  recordFire(layerId, count = 1) {
    if (!layerId) return;
    const e = this._entry(layerId);
    e.fires += Math.max(0, count | 0);
    e.at = Date.now();
  }

  // Record a user interaction with one of a layer's flags. `action` is mapped to
  // the SAME accept(1)/dismiss(0) label used by the Self-Learning Rules model
  // (PR #25) via actionToLabel, so both learners consume one signal stream.
  // Ambiguous actions carry no signal and are ignored (returns null).
  recordAction(layerId, action) {
    if (!layerId) return null;
    const label = actionToLabel(action);
    if (label == null) return null;
    const e = this._entry(layerId);
    // Apply recency decay to this layer's existing evidence, then add the event.
    e.dAccepts *= this.decay;
    e.dDismisses *= this.decay;
    if (label === 1) { e.accepts += 1; e.dAccepts += 1; }
    else { e.dismisses += 1; e.dDismisses += 1; }
    e.at = Date.now();
    return e;
  }

  // The learned priority score in [0,1] for a layer: the Beta posterior mean of
  // the probability that one of its flags is a real issue. 0.5 = neutral / no
  // evidence. Higher = the user tends to act on it; lower = tends to dismiss it.
  scoreFor(layerId) {
    const e = this.layers.get(layerId);
    if (!e) return 0.5;
    return betaMean(e.dAccepts, e.dDismisses);
  }

  // Coarse, human-facing tier for a layer's badge. Layers with no feedback stay
  // neutral regardless of the prior's 0.5 score.
  tierFor(layerId) {
    const e = this.layers.get(layerId);
    if (!e || (e.accepts + e.dismisses) === 0) return 'neutral';
    const s = betaMean(e.dAccepts, e.dDismisses);
    if (s >= PROMOTE_AT) return 'promoted';
    if (s <= DEPRIORITIZE_AT) return 'deprioritized';
    return 'neutral';
  }

  // Plain-language reason a layer sits where it does. Cites the user's own raw
  // counts (not decayed, so the sentence matches what they remember doing).
  explain(layerId) {
    const e = this.layers.get(layerId);
    const score = this.scoreFor(layerId);
    const pct = Math.round(score * 100);
    if (!e || (e.accepts + e.dismisses) === 0) {
      const fired = e && e.fires ? ` It has fired ${e.fires} time${e.fires === 1 ? '' : 's'}, but you haven't acted on or dismissed any of its flags yet.` : '';
      return {
        score: Number(score.toFixed(4)),
        tier: 'neutral',
        fires: e ? e.fires : 0,
        accepts: 0,
        dismisses: 0,
        reason: `No feedback yet — keeping this check in its default position.${fired}`,
      };
    }
    const total = e.accepts + e.dismisses;
    const tier = this.tierFor(layerId);
    let reason;
    if (tier === 'promoted') {
      reason = `You've acted on ${e.accepts} of ${total} flag${total === 1 ? '' : 's'} from this check — surfacing it higher (${pct}% acted on).`;
    } else if (tier === 'deprioritized') {
      reason = `You've dismissed ${e.dismisses} of ${total} flag${total === 1 ? '' : 's'} from this check as noise — moving it lower (${pct}% acted on).`;
    } else {
      reason = `Mixed signal so far (${e.accepts} acted on, ${e.dismisses} dismissed of ${total}) — keeping it near its default position.`;
    }
    return {
      score: Number(score.toFixed(4)),
      tier,
      fires: e.fires,
      accepts: e.accepts,
      dismisses: e.dismisses,
      reason,
    };
  }

  // Reorder a list of layer definitions most-useful-first. Each def is annotated
  // with its score, tier, rank and a plain-language explanation. NEVER drops a
  // layer — all inputs come back. When the model is not yet ready, the original
  // order is preserved and `reordered` is false. A stable sort keeps layers with
  // equal scores (e.g. all the untouched, neutral ones) in registry order, so
  // the only movement is driven by real, learned feedback.
  prioritize(layerDefs) {
    const defs = Array.isArray(layerDefs) ? layerDefs : [];
    const items = defs.map((def, originalIndex) => {
      const id = def && def.id;
      const explanation = this.explain(id);
      return { def, id, originalIndex, score: explanation.score, tier: explanation.tier, explanation };
    });
    if (!this.isReady()) {
      return {
        reordered: false,
        actionsUntilReady: this.actionsUntilReady(),
        items: items.map(it => ({ ...it, rank: it.originalIndex })),
      };
    }
    const sorted = items.slice().sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);
    sorted.forEach((it, i) => { it.rank = i; });
    return { reordered: true, actionsUntilReady: 0, items: sorted };
  }

  // Serialize learned counts for IndexedDB persistence (opt-in).
  toJSON() {
    const layers = {};
    for (const [id, e] of this.layers.entries()) {
      layers[id] = {
        fires: e.fires,
        accepts: e.accepts,
        dismisses: e.dismisses,
        dAccepts: e.dAccepts,
        dDismisses: e.dDismisses,
        at: e.at,
      };
    }
    return { version: 1, decay: this.decay, layers };
  }

  // Restore a model from serialized state. Tolerant of missing/garbage fields —
  // anything unparseable is dropped rather than corrupting the model.
  static fromJSON(data) {
    const model = new LayerPriorityModel({ decay: data && data.decay });
    if (!data || typeof data !== 'object' || !data.layers || typeof data.layers !== 'object') {
      return model;
    }
    for (const [id, raw] of Object.entries(data.layers)) {
      if (!id || !raw || typeof raw !== 'object') continue;
      const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
      model.layers.set(id, {
        fires: num(raw.fires),
        accepts: num(raw.accepts),
        dismisses: num(raw.dismisses),
        dAccepts: num(raw.dAccepts),
        dDismisses: num(raw.dDismisses),
        at: num(raw.at),
      });
    }
    return model;
  }
}
