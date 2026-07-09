// ============================================================
// DATAGLOW — Expected Value Ranges (informational trend context)
// ------------------------------------------------------------
// The SECOND item in the Trend/Drift-Forecasting capability set. The first,
// Forecast-Based Drift Alerting (js/drift-forecast.js, PR#29), asks a yes/no
// ALERT question: "is this upload outside the range we'd have expected?" and, if
// so, escalates the Distributional Fingerprint Drift layer to `warn`.
//
// This module answers a gentler, purely INFORMATIONAL question about the same
// numbers: "for a numeric column with enough upload history, what has its recent
// trend been, and does today's file sit inside that trend's expected range?" It
// changes no status and raises no alert — it only narrates context next to the
// existing anomaly/drift flags, e.g.
//
//   "Over the last 5 uploads, the mean of \"revenue\" has been trending up
//    ~3.1% per upload. Today's file (140) is within the expected range
//    (135–145). Informational context only — not a prediction."
//
// It deliberately does NOT re-fit anything. It consumes the `projections` array
// the forecast report already produced (each carries expected/low/high/actual/
// trend for a tracked stat), keeping the Holt's linear exponential smoothing
// math (Holt 1957) in ONE place. Scope is numeric-column means (kind==='mean'),
// matching the task's "numeric columns … today's number" framing; missingness
// and category-share series are left to the alerting layer.
//
// Pure + dependency-free (no DOM, no IndexedDB) so the text is unit-testable in
// Node exactly like drift-forecast.js. Gating mirrors the alerting layer: it is
// only ever populated when the forecast report itself is `active`, which in turn
// requires the opt-in cross-session history store and ≥ MIN_FORECAST_HISTORY
// prior uploads of the same schema — legacy/first-time users get an empty report
// (no bands), never an error.
// ============================================================

import { formatStatValue, MIN_FORECAST_HISTORY } from '../drift/drift-forecast.js';

// Reuse the alerting layer's history threshold verbatim — the same ≥4 prior
// uploads that unlock a trend-aware forecast are exactly what we need to describe
// a trend honestly. No reason to diverge.
export const MIN_RANGE_HISTORY = MIN_FORECAST_HISTORY;

// Below this per-upload magnitude we call a series "holding roughly steady"
// rather than rising/falling — avoids narrating trend noise as a real trend.
export const FLAT_PCT_EPSILON = 0.5;

// Per-upload trend as a percentage of the prior level. Holt's `trend` is the
// absolute level increment per period; the level BEFORE this step is
// (expected − trend), so the fractional change is trend / |priorLevel|. Returns
// null when the base is zero/non-finite (percentage is meaningless there and the
// caller falls back to an absolute-change phrasing).
export function trendPerUploadPct(expected, trend) {
  if (!Number.isFinite(expected) || !Number.isFinite(trend)) return null;
  const priorLevel = expected - trend;
  if (!Number.isFinite(priorLevel) || priorLevel === 0) return null;
  return (trend / Math.abs(priorLevel)) * 100;
}

// One human-readable trend clause, e.g. "trending up ~3.1% per upload",
// "trending down ~2.0 per upload" (absolute fallback), or "holding roughly
// steady". `pct` may be null (use absolute change instead).
export function describeTrend(trend, pct) {
  const rising = trend > 0;
  if (pct != null) {
    if (Math.abs(pct) < FLAT_PCT_EPSILON) return 'holding roughly steady';
    return `trending ${rising ? 'up' : 'down'} ~${Math.abs(pct).toFixed(1)}% per upload`;
  }
  if (trend === 0) return 'holding roughly steady';
  const absTxt = formatStatValue('mean', Math.abs(trend));
  return `trending ${rising ? 'up' : 'down'} ~${absTxt} per upload`;
}

// Full plain-language, informational sentence for one numeric column's band.
// Always ends with the explicit "not a prediction" disclaimer so the framing is
// unmistakable wherever the text is shown.
export function describeExpectedRange(band) {
  const trendClause = describeTrend(band.trend, band.trendPct);
  const act = formatStatValue('mean', band.actual);
  const lo = formatStatValue('mean', band.low);
  const hi = formatStatValue('mean', band.high);
  const fit = band.within
    ? `Today's file (${act}) is within the expected range (${lo}–${hi})`
    : `Today's file (${act}) is outside the expected range (${lo}–${hi})`;
  return `Over the last ${band.historyLen} uploads, the mean of "${band.column}" has been ${trendClause}. ${fit}. Informational context only — not a prediction.`;
}

// Turn a forecast report (from forecastDriftReport) into an informational
// expected-range report over its NUMERIC-MEAN projections. Returns
// { active:false, bands:[] } whenever the forecast is missing/inactive or has no
// numeric means — the graceful, error-free fallback for too-little-history and
// legacy stores.
export function expectedRangeReport(forecast) {
  if (!forecast || !forecast.active || !Array.isArray(forecast.projections)) {
    return { active: false, historyLen: forecast ? forecast.historyLen || 0 : 0, bands: [] };
  }
  const historyLen = forecast.historyLen;
  const bands = [];
  for (const p of forecast.projections) {
    if (p.kind !== 'mean') continue;
    if (!Number.isFinite(p.expected) || !Number.isFinite(p.actual)) continue;
    const trendPct = trendPerUploadPct(p.expected, p.trend);
    const band = {
      column: p.column,
      historyLen,
      expected: p.expected,
      low: p.low,
      high: p.high,
      actual: p.actual,
      trend: p.trend,
      trendPct,
      within: !p.outside,
      direction: p.trend > 0 ? 'up' : p.trend < 0 ? 'down' : 'flat',
    };
    band.message = describeExpectedRange(band);
    bands.push(band);
  }
  return { active: bands.length > 0, historyLen, bands };
}
