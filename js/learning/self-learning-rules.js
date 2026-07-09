// ============================================================
// DATAGLOW — Self-Learning Validation Rules
// A small, transparent, on-device statistical learner that personalizes
// which flags to surface first based on the user's OWN past corrections.
// Runs entirely in the browser. Never uploads anything.
// ============================================================
//
// TECHNIQUE: textbook binary logistic regression (Cox 1958, public method),
// trained online with stochastic gradient descent (SGD). This is a linear
// model — deliberately NOT a neural network / deep learning / black box — so
// every prediction decomposes into a plain, per-feature sum (logit = Σ wᵢxᵢ),
// which is what lets us show WHY an item was ranked the way it was. This matches
// DATAGLOW's explainability ethos (Assumption Ledger, explainable Benford gate).
//
// It learns from actions the app ALREADY supports — applying/rejecting a
// categorical merge, dismissing a cross-column or upper-bound flag, ignoring a
// fuzzy-duplicate, etc. Each such action becomes ONE labeled example:
//   label 1 = the user treated the flag as a REAL issue (merged / edited / applied)
//   label 0 = the user DISMISSED the flag (rejected / ignored / dismissed)
//
// This module is intentionally DOM-free and store-free so it is unit-testable
// in Node; the browser wires persistence in via an injected store (same pattern
// as the Distributional Fingerprint Drift layer), and toJSON/fromJSON make the
// learned weights portable to IndexedDB when the user opts in.

// DuckDB numeric type names — used only to bucket a column as numeric vs
// categorical for the feature vector.
const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT', 'DECIMAL', 'REAL', 'SMALLINT', 'TINYINT', 'UINTEGER', 'UBIGINT'];

// The fixed, ordered set of flag sources the model knows about. A stable order
// keeps the weight vector meaningful across sessions (index i always means the
// same thing). Unknown sources fall into 'src:other'.
export const KNOWN_SOURCES = [
  'categorical_consistency',
  'fuzzy_dedup',
  'cross_column_logic',
  'upper_bound_sanity',
  'physiological_plausibility',
  'missingness',
  'distribution_drift',
  'benford',
  'ambient',
  'other',
];

// Actions that mean "yes, this was a real issue" (positive label) vs "no, leave
// it alone" (negative label). Editing a flagged value counts as accepting the
// flag: the user agreed something was wrong and fixed it.
const ACCEPT_ACTIONS = new Set(['accept', 'apply', 'merge', 'edit', 'fix', 'confirm']);
const DISMISS_ACTIONS = new Set(['reject', 'dismiss', 'ignore', 'skip']);

// Minimum labeled examples before the model is allowed to rank/highlight. Below
// this it stays silent — it genuinely knows nothing yet. Displayed in the UI.
export const MIN_EXAMPLES = 10;

// Minimum decisive corrections on ONE column before the model will publish a
// per-column verdict into the Unified Signal Layer (see columnVerdict). This is
// a local, per-column count — independent of MIN_EXAMPLES — so a focused pattern
// ("the user has dismissed flags on this column 4 times") can coordinate with
// other modules even before the global ranker is ready.
export const MIN_COLUMN_VERDICT = 3;

// Hard cap on retained examples (bounded memory, LRU by insertion order). Keeps
// IndexedDB payloads and per-record training cost small.
const MAX_EXAMPLES = 2000;

// Map an action string to a binary label (1 = real issue, 0 = dismissed).
// Returns null for actions that carry no clear signal.
export function actionToLabel(action) {
  const a = String(action || '').toLowerCase();
  if (ACCEPT_ACTIONS.has(a)) return 1;
  if (DISMISS_ACTIONS.has(a)) return 0;
  return null;
}

function isNumericType(type) {
  if (!type) return false;
  const t = String(type).toUpperCase();
  return NUMERIC_TYPES.some(n => t.includes(n));
}

// Clamp a value into [0, 1]; non-finite -> 0.
function unit(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Turn a flagged-item snapshot into a fixed-length numeric feature vector.
// Every feature is already in [0, 1] (or {0, 1}), so no scaling is needed and
// the weights stay directly interpretable. Returns parallel {names, values}
// arrays plus a human-readable label per feature for explanations.
export function extractFeatures(snapshot = {}) {
  const numeric = snapshot.columnType != null
    ? isNumericType(snapshot.columnType)
    : !!snapshot.numeric;
  const categorical = snapshot.columnType != null ? !numeric : !!snapshot.categorical || !numeric;
  const sensitive = snapshot.sensitive ? 1 : 0;
  const severity = unit(snapshot.severity);

  const src = KNOWN_SOURCES.includes(snapshot.source) ? snapshot.source : 'other';

  const names = ['categorical', 'numeric', 'sensitive', 'severity'];
  const values = [categorical ? 1 : 0, numeric ? 1 : 0, sensitive, severity];
  const labels = [
    'the column is categorical',
    'the column is numeric',
    'the column is a sensitive category',
    'the flag is high-severity',
  ];
  for (const s of KNOWN_SOURCES) {
    names.push(`src:${s}`);
    values.push(src === s ? 1 : 0);
    labels.push(`it comes from the ${s.replace(/_/g, ' ')} check`);
  }
  return { names, values, labels };
}

function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

// A tiny logistic-regression model with online SGD training.
export class SelfLearningModel {
  constructor(options = {}) {
    const probe = extractFeatures({});
    this.dim = probe.values.length;
    this.featureNames = probe.names;
    this.featureLabels = probe.labels;
    this.weights = new Array(this.dim).fill(0);
    this.bias = 0;
    this.learningRate = options.learningRate ?? 0.1;
    this.l2 = options.l2 ?? 0.0001; // mild regularization to avoid overconfidence
    this.examples = []; // { values, label, source, meta, at }
  }

  get count() {
    return this.examples.length;
  }

  // True once enough examples exist to rank/highlight responsibly.
  isReady() {
    return this.examples.length >= MIN_EXAMPLES;
  }

  examplesUntilReady() {
    return Math.max(0, MIN_EXAMPLES - this.examples.length);
  }

  // Raw logit (Σ wᵢxᵢ + b) for a feature-value vector.
  _logit(values) {
    let z = this.bias;
    for (let i = 0; i < this.dim; i++) z += this.weights[i] * values[i];
    return z;
  }

  // One SGD step on a single (values, label) pair.
  _step(values, label) {
    const p = sigmoid(this._logit(values));
    const err = p - label; // dLoss/dz for log-loss
    for (let i = 0; i < this.dim; i++) {
      const grad = err * values[i] + this.l2 * this.weights[i];
      this.weights[i] -= this.learningRate * grad;
    }
    this.bias -= this.learningRate * err;
  }

  // Record a user correction as a labeled example and take an incremental
  // training step. `action` is mapped to a label; snapshots with an ambiguous
  // action are ignored (returns null). Returns the stored example on success.
  record(snapshot, action) {
    const label = actionToLabel(action);
    if (label == null) return null;
    const { values } = extractFeatures(snapshot);
    const example = {
      values,
      label,
      source: KNOWN_SOURCES.includes(snapshot.source) ? snapshot.source : 'other',
      column: snapshot.column ?? null,
      at: Date.now(),
    };
    this.examples.push(example);
    if (this.examples.length > MAX_EXAMPLES) this.examples.shift();
    this._step(values, label); // incremental online update
    return example;
  }

  // Full retrain over all accumulated examples (shuffled epochs). Used for a
  // stable refit; the online steps in record() keep predictions fresh between
  // full retrains. Safe to call anytime.
  trainEpochs(epochs = 8) {
    this.weights = new Array(this.dim).fill(0);
    this.bias = 0;
    const n = this.examples.length;
    if (n === 0) return;
    const order = this.examples.map((_, i) => i);
    for (let e = 0; e < epochs; e++) {
      // Deterministic shuffle (no external RNG dependency needed for tests).
      for (let i = order.length - 1; i > 0; i--) {
        const j = (i * 1103515245 + 12345 + e * 7) % (i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (const idx of order) {
        const ex = this.examples[idx];
        this._step(ex.values, ex.label);
      }
    }
  }

  // Probability in [0, 1] that the user would treat this flag as a real issue.
  predictProba(snapshot) {
    const { values } = extractFeatures(snapshot);
    return sigmoid(this._logit(values));
  }

  // Explain a prediction in plain language. Decomposes the logit into per-feature
  // contributions (wᵢxᵢ) — for a linear model this IS the exact attribution — and
  // reports the dominant one, plus how many past examples support it.
  explain(snapshot) {
    const { values, labels } = extractFeatures(snapshot);
    const probability = sigmoid(this._logit(values));
    const contributions = [];
    for (let i = 0; i < this.dim; i++) {
      const c = this.weights[i] * values[i];
      if (values[i] !== 0 && Math.abs(c) > 1e-9) {
        contributions.push({ index: i, name: this.featureNames[i], label: labels[i], contribution: c });
      }
    }
    contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    const leansAccept = probability >= 0.5;

    const top = contributions[0];
    let reason;
    if (!top) {
      reason = 'No learned pattern applies yet — this is a neutral starting guess.';
    } else {
      // Count supporting past examples that share the dominant active feature
      // and landed on the side the model is now predicting.
      let sharing = 0;
      let agreeing = 0;
      for (const ex of this.examples) {
        if (ex.values[top.index] !== 0) {
          sharing++;
          if ((ex.label === 1) === leansAccept) agreeing++;
        }
      }
      const verb = leansAccept ? 'acted on' : 'dismissed';
      reason = agreeing > 0
        ? `You've ${verb} ${agreeing} similar flag${agreeing === 1 ? '' : 's'} before (${top.label}).`
        : `Based on your corrections so far, flags where ${top.label} tend to be ${leansAccept ? 'real issues' : 'dismissed'}.`;
    }

    return {
      probability: Number(probability.toFixed(4)),
      prediction: leansAccept ? 'likely-relevant' : 'likely-dismiss',
      topFeature: top ? top.name : null,
      contributions: contributions.map(c => ({ name: c.name, label: c.label, contribution: Number(c.contribution.toFixed(4)) })),
      reason,
    };
  }

  // Rank an array of flag snapshots most-likely-relevant first. Each entry is
  // annotated with the probability and a plain-language explanation. When the
  // model is not yet ready, order is preserved and `ranked` is false.
  rank(snapshots) {
    const items = (snapshots || []).map((s, originalIndex) => ({ snapshot: s, originalIndex }));
    if (!this.isReady()) {
      return {
        ranked: false,
        examplesUntilReady: this.examplesUntilReady(),
        items: items.map(it => ({ ...it, probability: null, explanation: null })),
      };
    }
    const scored = items.map(it => {
      const explanation = this.explain(it.snapshot);
      return { ...it, probability: explanation.probability, explanation };
    });
    scored.sort((a, b) => b.probability - a.probability || a.originalIndex - b.originalIndex);
    return { ranked: true, examplesUntilReady: 0, items: scored };
  }

  // The user's decisive, learned verdict for a single COLUMN, tallied directly
  // from the stored labeled examples (not the logistic weights) so it reads as a
  // plain, auditable count: "you dismissed N flags on this column and acted on M".
  // Returns null when the column has no examples. `verdict` is only set to
  // 'dismiss'/'accept' once one side reaches MIN_COLUMN_VERDICT and strictly
  // outnumbers the other; otherwise it stays null (a genuinely mixed history).
  //
  // This is the payload the Unified Signal Layer publishes so the anomaly scorer
  // can suppress a row whose dominant column the user has repeatedly dismissed.
  // It reports learned counts — it does NOT change the model's statistics.
  columnVerdict(column) {
    if (column == null) return null;
    const col = String(column);
    let dismiss = 0, accept = 0;
    for (const ex of this.examples) {
      if (ex.column == null || String(ex.column) !== col) continue;
      if (ex.label === 0) dismiss++; else accept++;
    }
    const total = dismiss + accept;
    if (total === 0) return null;
    let verdict = null;
    if (dismiss >= MIN_COLUMN_VERDICT && dismiss > accept) verdict = 'dismiss';
    else if (accept >= MIN_COLUMN_VERDICT && accept > dismiss) verdict = 'accept';
    const confidence = Math.max(dismiss, accept) / total;
    return { column: col, dismiss, accept, total, verdict, confidence: Number(confidence.toFixed(4)) };
  }

  // Serialize the learned state for IndexedDB persistence (opt-in).
  toJSON() {
    return {
      version: 1,
      dim: this.dim,
      weights: this.weights.slice(),
      bias: this.bias,
      learningRate: this.learningRate,
      l2: this.l2,
      examples: this.examples.map(e => ({
        values: e.values.slice(),
        label: e.label,
        source: e.source,
        column: e.column,
        at: e.at,
      })),
    };
  }

  // Restore a model from serialized state. Tolerant of a dimension change
  // (e.g. a future version added a feature): mismatched saved weights/examples
  // are dropped rather than corrupting the current schema.
  static fromJSON(data) {
    const model = new SelfLearningModel({
      learningRate: data?.learningRate,
      l2: data?.l2,
    });
    if (!data || typeof data !== 'object') return model;
    if (Array.isArray(data.weights) && data.weights.length === model.dim) {
      model.weights = data.weights.slice();
      model.bias = Number(data.bias) || 0;
    }
    if (Array.isArray(data.examples)) {
      model.examples = data.examples
        .filter(e => Array.isArray(e.values) && e.values.length === model.dim)
        .map(e => ({
          values: e.values.slice(),
          label: e.label === 1 ? 1 : 0,
          source: e.source ?? 'other',
          column: e.column ?? null,
          at: e.at ?? Date.now(),
        }));
      // If we dropped the saved weights but kept examples, refit from them.
      if (!(Array.isArray(data.weights) && data.weights.length === model.dim)) {
        model.trainEpochs();
      }
    }
    return model;
  }
}
