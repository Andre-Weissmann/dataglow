// ============================================================
// DATAGLOW — Expected Value Ranges test suite
// ============================================================
// The informational sibling of Forecast-Based Drift Alerting (PR#29). It reuses
// that layer's forecast `projections` (Holt 1957 smoothing) and narrates, for
// numeric columns with enough history, the recent trend plus whether today's
// file fits the expected range — with an explicit "not a prediction" framing.
//
// Covers:
//   • per-upload trend-percentage math + edge cases (zero/non-finite base)
//   • the plain-language trend + range message and its disclaimer
//   • within-band vs outside-band phrasing
//   • numeric-only scope (missingness / category-share are NOT turned into bands)
//   • the inactive/graceful-fallback paths (no forecast, inactive, no numerics)
//   • end-to-end through runAllLayers with an injected trend-history store, and
//     NO regression when the store lacks the history contract
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/expected-range.test.mjs
// The math is pure and DB-free; only the end-to-end section touches DuckDB.

import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';
import {
  expectedRangeReport,
  describeExpectedRange,
  describeTrend,
  trendPerUploadPct,
  MIN_RANGE_HISTORY,
  FLAT_PCT_EPSILON,
} from '../js/expected-range.js';
import { forecastDriftReport, MIN_FORECAST_HISTORY } from '../js/drift-forecast.js';
import { runAllLayers } from '../js/validation.js';
import { clearLedger } from '../js/assumption-ledger.js';

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

async function makeDataset(table, rows) {
  await createTableFromObjects(table, rows);
  const schema = await getTableSchema(table);
  return {
    table,
    cols: schema.map(s => ({ name: s.column_name, type: s.column_type })),
    rowCount: rows.length,
    loadedAt: Date.now(),
  };
}

// Same full injected store shape as the drift-forecast suite: baseline contract
// PLUS the trend-history contract the forecast layer probes for.
function makeForecastStore(cap = 24) {
  const baselines = new Map();
  const history = new Map();
  return {
    baselines, history,
    async getBaseline(hash) { return baselines.get(hash); },
    async saveBaseline(hash, stats) {
      const existing = baselines.get(hash);
      const version = existing ? (existing.version || 1) + 1 : 1;
      const rec = { fingerprintHash: hash, columnStats: stats, version };
      baselines.set(hash, rec);
      return rec;
    },
    async getFingerprintHistory(hash) {
      const rec = history.get(hash);
      return rec ? rec.slice() : [];
    },
    async appendFingerprintHistory(hash, stats) {
      const series = history.get(hash) || [];
      series.push({ ts: Date.now(), stats });
      while (series.length > cap) series.shift();
      history.set(hash, series);
      return series.length;
    },
  };
}

// Synthetic fingerprint matching computeDistributionFingerprint's shape.
function fp({ mean = null, nullRate = 0, topProp = null, topLabel = 'A' } = {}) {
  const cols = { amount: { kind: 'numeric', nullRate, mean, std: 0, min: mean, max: mean } };
  if (topProp != null) cols.category = { kind: 'categorical', nullRate, top: [topLabel], topLabel, topProp };
  return cols;
}

async function main() {
  clearLedger();

  // ===== config reuse =====
  ok(MIN_RANGE_HISTORY === MIN_FORECAST_HISTORY, 'config: reuses the forecast layer\'s ≥4 history threshold (no divergence)');

  // ===== trendPerUploadPct =====
  ok(approx(trendPerUploadPct(103, 3), 3, 1e-9), 'pct: +3 on a prior level of 100 is ~3% per upload');
  ok(approx(trendPerUploadPct(95, -5), -5, 1e-9), 'pct: −5 on a prior level of 100 is ~−5% per upload');
  ok(trendPerUploadPct(3, 3) === null, 'pct: a zero prior level yields null (percentage undefined)');
  ok(trendPerUploadPct(NaN, 1) === null, 'pct: a non-finite expected yields null');

  // ===== describeTrend =====
  ok(/trending up ~3\.0% per upload/.test(describeTrend(3, 3)), 'trend text: names direction + percentage (up)');
  ok(/trending down ~2\.0% per upload/.test(describeTrend(-2, -2)), 'trend text: names direction + percentage (down)');
  ok(describeTrend(0.01, 0.1) === 'holding roughly steady', 'trend text: sub-epsilon change reads as roughly steady');
  ok(FLAT_PCT_EPSILON > 0, 'config: flat epsilon is a positive guard against narrating noise');
  ok(/trending up ~/.test(describeTrend(5, null)), 'trend text: null pct falls back to an absolute-change phrasing');

  // ===== report over a clean rising numeric mean (on-trend upload) =====
  const risingHistory = [fp({ mean: 100 }), fp({ mean: 110 }), fp({ mean: 120 }), fp({ mean: 130 })];
  const inForecast = forecastDriftReport(risingHistory, fp({ mean: 140 }));
  const inRange = expectedRangeReport(inForecast);
  ok(inRange.active === true && inRange.bands.length === 1, 'report: one numeric column yields one expected-range band');
  const band = inRange.bands[0];
  ok(band.column === 'amount' && band.within === true, 'report: an on-trend upload is reported as WITHIN the expected range');
  ok(band.direction === 'up' && band.trendPct > 0, 'report: recovers the rising direction + positive percentage');
  ok(/within the expected range/.test(band.message), 'message: within-band upload phrased as "within the expected range"');
  ok(/Informational context only — not a prediction\./.test(band.message), 'message: carries the explicit non-prediction disclaimer');
  ok(/mean of "amount"/.test(band.message), 'message: names the numeric column in plain language');

  // ===== outside-band phrasing (no status change — this is informational) =====
  const outForecast = forecastDriftReport(risingHistory, fp({ mean: 500 }));
  const outRange = expectedRangeReport(outForecast);
  ok(outRange.bands[0].within === false, 'report: a far-off upload is reported as NOT within the expected range');
  ok(/outside the expected range/.test(outRange.bands[0].message), 'message: outside-band upload phrased as "outside the expected range"');

  // ===== numeric-only scope: missingness/category-share do NOT become bands =====
  const catHistory = [
    fp({ nullRate: 0.04, topProp: 0.6 }), fp({ nullRate: 0.042, topProp: 0.61 }),
    fp({ nullRate: 0.041, topProp: 0.60 }), fp({ nullRate: 0.043, topProp: 0.62 }),
  ];
  const catForecast = forecastDriftReport(catHistory, fp({ nullRate: 0.30, topProp: 0.95 }));
  const catRange = expectedRangeReport(catForecast);
  ok(catRange.active === false && catRange.bands.length === 0,
    'scope: a fingerprint with only missingness/category series produces NO numeric bands (numeric-mean only)');

  // ===== graceful fallbacks =====
  ok(expectedRangeReport(null).active === false, 'fallback: a null forecast → inactive, no bands, no throw');
  ok(expectedRangeReport({ active: false, historyLen: 2 }).active === false, 'fallback: an inactive forecast → inactive');
  const tooLittle = forecastDriftReport([fp({ mean: 10 }), fp({ mean: 11 }), fp({ mean: 12 })], fp({ mean: 13 }));
  ok(expectedRangeReport(tooLittle).active === false, 'fallback: too little history (forecast inactive) → no bands');

  // ===== describeExpectedRange standalone (formatting) =====
  const msg = describeExpectedRange({ column: 'revenue', historyLen: 5, trend: 3, trendPct: 3, actual: 140, low: 135, high: 145, within: true });
  ok(/Over the last 5 uploads, the mean of "revenue"/.test(msg), 'format: leads with the observed-history window and column');
  ok(/\(135–145\)/.test(msg), 'format: shows the expected low–high range');

  // ===== END-TO-END through runAllLayers with an injected trend-history store =====
  const store = makeForecastStore();
  const means = [100, 110, 120, 130];
  const mkRows = (m) => Array.from({ length: 20 }, (_, i) => ({ id: i, amount: m, category: 'A' }));
  for (let k = 0; k < means.length; k++) {
    const ds = await makeDataset(`er_upload_${k}`, mkRows(means[k]));
    await runAllLayers(ds, { fingerprintStore: store });
  }
  // 5th, on-trend upload: forecast active → an informational band exists, and the
  // upload sits WITHIN it (mean follows the 100→130→140 line).
  const dsOn = await makeDataset('er_upload_on', mkRows(140));
  const resOn = await runAllLayers(dsOn, { fingerprintStore: store });
  const onReport = expectedRangeReport(resOn.distribution_drift.forecast);
  ok(onReport.active === true && onReport.bands.some(b => b.column === 'amount' && b.within),
    'e2e: the 5th on-trend upload yields a within-range informational band for the numeric mean');
  ok(resOn.distribution_drift.status === 'pass',
    `e2e: an expected-range band NEVER changes layer status (still pass, got ${resOn.distribution_drift.status})`);

  // ===== NO regression: a store WITHOUT the history contract → no forecast → no bands =====
  const legacyStore = {
    map: new Map(),
    async getBaseline(h) { return this.map.get(h); },
    async saveBaseline(h, s) { this.map.set(h, { columnStats: s, version: 1 }); },
  };
  const dsLegacy = await makeDataset('er_legacy', mkRows(140));
  const resLegacy = await runAllLayers(dsLegacy, { fingerprintStore: legacyStore });
  ok(expectedRangeReport(resLegacy.distribution_drift.forecast).active === false,
    'regression: a store lacking getFingerprintHistory leaves forecast null → no expected-range bands');

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
