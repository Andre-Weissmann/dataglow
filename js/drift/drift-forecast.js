// ============================================================
// DATAGLOW — Forecast-Based Drift Alerting
// An EXTENSION of the Distributional Fingerprint Drift layer (js/validation.js,
// layer 18). The base layer answers "did this upload move away from a stored
// baseline?". This module answers a strictly harder question: "given the recent
// *trajectory* of this schema's uploads, is this upload outside the range we
// would have EXPECTED the next upload to fall in?".
//
// It reuses the exact summary numbers the base drift fingerprint already
// computes (per-column mean, null/missingness rate, and — added alongside the
// existing categorical `top` list — the modal-category share) and projects each
// one forward with a transparent, textbook forecasting method:
//
//   Holt's linear (double) exponential smoothing — Holt 1957
//   ("Forecasting seasonals and trends by exponentially weighted moving
//    averages", ONR memo; reprinted Int. J. Forecasting 20(1), 2004).
//
// Two smoothing recursions, level and trend:
//   ℓ_t = α·y_t + (1−α)·(ℓ_{t−1} + b_{t−1})
//   b_t = β·(ℓ_t − ℓ_{t−1}) + (1−β)·b_{t−1}
//   one-step forecast  ŷ_{t} = ℓ_{t−1} + b_{t−1}
//   next-upload forecast ŷ_{n+1} = ℓ_n + b_n
//
// The confidence band is sized by the method's OWN one-step-ahead in-sample
// residuals (root-mean-square error), NOT a hardcoded threshold: a series the
// model tracks well gets a tight band; a noisy one gets a wide, forgiving band.
//
// Pure + dependency-free by design (no DuckDB, no IndexedDB, no DOM) so the math
// is unit-testable in Node exactly like the sibling detection modules
// (missingness-detective.js, upper-bound-sanity.js). Persistence is handled by
// the caller via the injected fingerprint store, mirroring the base layer.
// ============================================================

// Minimum number of PRIOR uploads required before a forecast is even attempted.
// With fewer, callers fall back to the base (static) drift behaviour — we never
// claim a trend-aware flag on a trajectory we haven't actually observed. Chosen
// at the top of the task's 3–5 range so Holt's level+trend has genuine history
// to smooth over rather than being dominated by its two-point initialisation.
export const MIN_FORECAST_HISTORY = 4;

// Hard cap on how many historical fingerprints we retain per schema. Bounded so
// the on-device store can never grow without limit (same anti-degradation stance
// as the LRU column-profile cap in memory-store.js).
export const FORECAST_HISTORY_CAP = 24;

// Band half-width in residual standard deviations. z = 2 ≈ a 95% interval under
// an approximately-normal one-step error, the textbook default.
export const FORECAST_Z = 2;

// Holt smoothing constants. Moderate, explainable defaults: α weights how fast
// the level tracks new observations, β how fast the trend adapts. Deliberately
// fixed (not fitted) so the method stays transparent and every run is
// reproducible — consistent with the "no black-box model" stance of the
// adaptive-priority and self-learning features.
export const HOLT_ALPHA = 0.5;
export const HOLT_BETA = 0.3;

// ---------------------------------------------------------------
// Stat extraction — pull the handful of forecastable SCALAR series out of one
// distribution fingerprint (the object returned by computeDistributionFingerprint).
// Reuses the fingerprint's existing fields; computes nothing from raw rows.
//   • missingness rate  — every column        (fp[col].nullRate)
//   • mean              — numeric columns      (fp[col].mean)
//   • top-category share— categorical columns  (fp[col].topProp)
// Each entry: { key, column, kind, label, value, detail? }.
// ---------------------------------------------------------------
export function extractTrackedStats(fingerprint) {
  const out = [];
  if (!fingerprint || typeof fingerprint !== 'object') return out;
  for (const [column, s] of Object.entries(fingerprint)) {
    if (!s || typeof s !== 'object') continue;
    if (s.nullRate != null && Number.isFinite(s.nullRate)) {
      out.push({ key: `missing::${column}`, column, kind: 'missing', label: `missingness in "${column}"`, value: s.nullRate });
    }
    if (s.kind === 'numeric' && s.mean != null && Number.isFinite(s.mean)) {
      out.push({ key: `mean::${column}`, column, kind: 'mean', label: `mean of "${column}"`, value: s.mean });
    }
    if (s.kind === 'categorical' && s.topProp != null && Number.isFinite(s.topProp)) {
      out.push({ key: `topprop::${column}`, column, kind: 'topprop', label: `top-category share in "${column}"`, value: s.topProp, detail: s.topLabel });
    }
  }
  return out;
}

// Gather the chronological series of values for one stat key across a list of
// historical fingerprints (oldest → newest). Missing points (e.g. a column that
// didn't exist in an earlier upload) are skipped rather than zero-filled.
function seriesForKey(historyFingerprints, key) {
  const vals = [];
  for (const fp of historyFingerprints) {
    const entry = extractTrackedStats(fp).find(e => e.key === key);
    if (entry && entry.value != null && Number.isFinite(entry.value)) vals.push(entry.value);
  }
  return vals;
}

// ---------------------------------------------------------------
// Holt's linear exponential smoothing (Holt 1957). Returns the next-step
// forecast, the final level/trend, and the residual standard deviation used to
// size the confidence band — or null if the series is too short to smooth.
// ---------------------------------------------------------------
export function holtForecast(series, opts = {}) {
  const alpha = opts.alpha != null ? opts.alpha : HOLT_ALPHA;
  const beta = opts.beta != null ? opts.beta : HOLT_BETA;
  const y = (series || []).filter(v => v != null && Number.isFinite(v));
  const n = y.length;
  if (n < 2) return null;

  // Standard initialisation: level = first observation, trend = first difference.
  let level = y[0];
  let trend = y[1] - y[0];
  let sse = 0;
  let cnt = 0;
  for (let t = 1; t < n; t++) {
    const oneStep = level + trend;      // forecast made at t-1 for y[t]
    // Skip t=1: its residual is identically zero by construction (the trend is
    // seeded from y[1]-y[0]), which would bias the band artificially tight.
    if (t >= 2) { const err = y[t] - oneStep; sse += err * err; cnt++; }
    const newLevel = alpha * y[t] + (1 - alpha) * (level + trend);
    trend = beta * (newLevel - level) + (1 - beta) * trend;
    level = newLevel;
  }
  const residualStd = cnt > 0 ? Math.sqrt(sse / cnt) : 0;
  return { method: 'holt', forecast: level + trend, level, trend, residualStd, n, alpha, beta };
}

// ---------------------------------------------------------------
// Formatting helpers — kept here (not in the UI) so the plain-language flag text
// is itself unit-testable and identical wherever it is shown.
// ---------------------------------------------------------------
export function formatStatValue(kind, v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (kind === 'missing' || kind === 'topprop') return `${(v * 100).toFixed(1)}%`;
  // mean: compact, human-readable number.
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return v.toExponential(2);
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function statNoun(p) {
  if (p.kind === 'missing') return `missingness in "${p.column}"`;
  if (p.kind === 'mean') return `mean of "${p.column}"`;
  if (p.kind === 'topprop') {
    const lbl = p.detail != null ? `"${p.detail}" share` : 'top-category share';
    return `${lbl} in "${p.column}"`;
  }
  return `"${p.column}"`;
}

// Plain-language, trend-aware explanation. Rates are clamped to ≥0 for display
// (a band can extend below zero mathematically, but a negative missingness rate
// is meaningless to a reader).
export function describeForecastFlag(p) {
  const clampLow = (p.kind === 'missing' || p.kind === 'topprop') ? Math.max(0, p.low) : p.low;
  const exp = formatStatValue(p.kind, p.expected);
  const act = formatStatValue(p.kind, p.actual);
  const lo = formatStatValue(p.kind, clampLow);
  const hi = formatStatValue(p.kind, p.high);
  const trendWord = p.trend > 0 ? 'rising' : p.trend < 0 ? 'falling' : 'flat';
  return `Expected ${statNoun(p)} ~${exp} based on the recent ${trendWord} trend; this upload has ${act} — outside the expected range (${lo}–${hi}).`;
}

// ---------------------------------------------------------------
// Unified Signal Layer integration (purely additive enrichment).
//
// A trend-aware drift flag on column X is far more useful to the user if we can
// connect it to something they just did. This step lets the alerter READ the
// shared store: if the user recently disabled/changed a validation rule on the
// SAME column (e.g. dismissed its flag), we append that context to the flag's
// message instead of presenting an unexplained drift warning in isolation.
//
// `lookup` is a tiny injected contract — `recentRuleChange(column) -> change |
// null` — keeping this pure and Node-testable. With no lookup, or no related
// change, the report is returned untouched (identical to before). Mutates and
// returns the same report; enriched flags gain a `relatedRuleChange` field and a
// clause appended to `message`.
// ---------------------------------------------------------------
export function enrichForecastWithSignals(report, lookup) {
  if (!report || !report.active || !Array.isArray(report.flags) || !lookup || typeof lookup.recentRuleChange !== 'function') {
    return report;
  }
  for (const f of report.flags) {
    const change = lookup.recentRuleChange(f.column);
    if (!change) continue;
    f.relatedRuleChange = change;
    f.message = `${f.message} ${describeRelatedRuleChange(change, f.column)}`;
  }
  return report;
}

// Plain-language clause connecting a drift flag to a recent user rule change.
export function describeRelatedRuleChange(change, column) {
  const rule = (change.meta && (change.meta.ruleName || change.meta.source)) || 'a validation rule';
  const pretty = String(rule).replace(/_/g, ' ');
  return `This may be related to a recently disabled/changed validation rule (${pretty}) on "${column}".`;
}

// ---------------------------------------------------------------
// The report. Given the PRIOR fingerprints (chronological, excluding the current
// upload) and the CURRENT fingerprint, forecast each tracked stat and flag the
// ones whose actual value falls outside the forecast's confidence band.
//
// Returns { active:false, historyLen, minHistory } when there isn't enough
// history — the signal for callers to fall back to static drift. Otherwise
// { active:true, historyLen, minHistory, method, z, flags[], projections[] }.
// `projections` holds every evaluated series (in- and out-of-band) for
// transparency; `flags` is the out-of-band subset with plain-language messages.
// ---------------------------------------------------------------
export function forecastDriftReport(historyFingerprints, currentFingerprint, opts = {}) {
  const minHistory = opts.minHistory != null ? opts.minHistory : MIN_FORECAST_HISTORY;
  const z = opts.z != null ? opts.z : FORECAST_Z;
  const history = Array.isArray(historyFingerprints) ? historyFingerprints : [];
  const historyLen = history.length;
  if (historyLen < minHistory) return { active: false, historyLen, minHistory };

  const flags = [];
  const projections = [];
  for (const cur of extractTrackedStats(currentFingerprint)) {
    if (cur.value == null || !Number.isFinite(cur.value)) continue;
    const series = seriesForKey(history, cur.key);
    // Require a full min-history run of THIS specific stat — a column added only
    // recently must not be forecast off two data points.
    if (series.length < minHistory) continue;
    const fc = holtForecast(series, opts);
    if (!fc) continue;
    const band = z * fc.residualStd;
    const low = fc.forecast - band;
    const high = fc.forecast + band;
    const outside = cur.value < low || cur.value > high;
    const proj = {
      key: cur.key, column: cur.column, kind: cur.kind, label: cur.label, detail: cur.detail,
      expected: fc.forecast, low, high, band, actual: cur.value,
      residualStd: fc.residualStd, trend: fc.trend, seriesLen: series.length, outside,
    };
    if (outside) {
      proj.direction = cur.value > high ? 'above' : 'below';
      proj.message = describeForecastFlag(proj);
      flags.push(proj);
    }
    projections.push(proj);
  }
  return {
    active: true,
    historyLen,
    minHistory,
    method: "Holt's linear exponential smoothing (Holt 1957)",
    z,
    flags,
    projections,
  };
}
