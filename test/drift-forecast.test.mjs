// ============================================================
// DATAGLOW — Forecast-Based Drift Alerting test suite
// ============================================================
// Extends the Distributional Fingerprint Drift layer (PR#15). Covers:
//   • Holt's linear exponential smoothing math (forecast, level/trend, residual band)
//   • extraction of forecastable scalar series from a distribution fingerprint
//   • the min-history gate (falls back / inactive with too little history)
//   • the flagging logic + plain-language message
//   • end-to-end wiring through runAllLayers with an injected trend-history store
//   • NO regression when the injected store lacks the trend-history contract
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/drift-forecast.test.mjs
//
// The math is pure and DB-free; only the end-to-end section touches DuckDB.

import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';
import {
  holtForecast,
  extractTrackedStats,
  forecastDriftReport,
  describeForecastFlag,
  formatStatValue,
  MIN_FORECAST_HISTORY,
  FORECAST_HISTORY_CAP,
} from '../js/drift-forecast.js';
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

// Full injected store implementing BOTH the base baseline contract AND the new
// trend-history contract the forecast layer probes for — exactly the surface
// js/memory-store.js exposes to the drift layer.
function makeForecastStore(cap = FORECAST_HISTORY_CAP) {
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

// Build a synthetic fingerprint (the shape computeDistributionFingerprint emits).
function fp({ mean = null, nullRate = 0, topProp = null, topLabel = 'A' } = {}) {
  // Always emit the numeric "amount" column so its missingness (nullRate) series
  // exists even when no mean is under test; mean is only tracked when supplied.
  const cols = { amount: { kind: 'numeric', nullRate, mean, std: 0, min: mean, max: mean } };
  if (topProp != null) cols.category = { kind: 'categorical', nullRate, top: [topLabel], topLabel, topProp };
  return cols;
}

async function main() {
  clearLedger();

  // ===== Holt's linear exponential smoothing =====
  const linear = holtForecast([10, 12, 14, 16]);
  ok(linear && approx(linear.forecast, 18, 1e-9), `Holt: perfect linear series forecasts the next point (got ${linear && linear.forecast})`);
  ok(linear && approx(linear.residualStd, 0, 1e-9), 'Holt: a perfectly-tracked linear series has ~0 residual std (tight band)');
  ok(approx(linear.trend, 2, 1e-9), `Holt: recovers the underlying slope (trend=${linear.trend})`);

  ok(holtForecast([5]) === null, 'Holt: a single point is too short to smooth (returns null)');

  const noisy = holtForecast([10, 11, 9, 12, 8, 13]);
  ok(noisy && noisy.residualStd > 0, 'Holt: a noisy series yields a positive residual std (wider band)');

  const flat = holtForecast([7, 7, 7, 7]);
  ok(flat && approx(flat.forecast, 7, 1e-9) && approx(flat.trend, 0, 1e-9), 'Holt: a flat series forecasts flat with zero trend');

  // ===== extractTrackedStats =====
  const stats = extractTrackedStats(fp({ mean: 100, nullRate: 0.05, topProp: 0.6 }));
  const keys = stats.map(s => s.key).sort();
  ok(keys.includes('mean::amount'), 'extract: numeric column yields a mean series');
  ok(keys.includes('missing::amount') && keys.includes('missing::category'), 'extract: every column yields a missingness series');
  ok(keys.includes('topprop::category'), 'extract: categorical column yields a top-category-share series');
  const meanEntry = stats.find(s => s.key === 'mean::amount');
  ok(meanEntry.value === 100 && meanEntry.kind === 'mean', 'extract: mean series carries the correct value + kind');

  // ===== min-history gate =====
  const tooLittle = forecastDriftReport(
    [fp({ mean: 10 }), fp({ mean: 11 }), fp({ mean: 12 })], // only 3 < MIN(4)
    fp({ mean: 99 }),
  );
  ok(tooLittle.active === false && tooLittle.historyLen === 3 && tooLittle.minHistory === MIN_FORECAST_HISTORY,
    'gate: fewer than the minimum prior uploads → inactive (falls back to static drift)');

  // ===== flagging: within-trend passes, out-of-trend flags =====
  const risingHistory = [
    fp({ mean: 100 }), fp({ mean: 110 }), fp({ mean: 120 }), fp({ mean: 130 }),
  ];
  const inTrend = forecastDriftReport(risingHistory, fp({ mean: 140 }));
  ok(inTrend.active === true, 'flag: with enough history the forecast activates');
  ok(inTrend.flags.length === 0, 'flag: an on-trend upload (mean follows the rising line) is NOT flagged');
  const meanProj = inTrend.projections.find(p => p.key === 'mean::amount');
  ok(meanProj && approx(meanProj.expected, 140, 1e-9), `flag: forecast projects the trend forward (expected=${meanProj && meanProj.expected})`);

  const outTrend = forecastDriftReport(risingHistory, fp({ mean: 500 }));
  ok(outTrend.flags.some(f => f.key === 'mean::amount' && f.direction === 'above'),
    'flag: an upload far above the projected trajectory IS flagged (direction=above)');

  // ===== plain-language message (matches the task-spec phrasing) =====
  const missHistory = [
    fp({ nullRate: 0.040 }), fp({ nullRate: 0.042 }), fp({ nullRate: 0.041 }),
    fp({ nullRate: 0.043 }), fp({ nullRate: 0.042 }),
  ];
  const missReport = forecastDriftReport(missHistory, fp({ nullRate: 0.11 }));
  const missFlag = missReport.flags.find(f => f.key === 'missing::amount');
  ok(!!missFlag, 'message: a missingness spike well above the stable trend is flagged');
  ok(/Expected missingness in "amount"/.test(missFlag.message), 'message: names the stat in plain language ("Expected missingness in …")');
  ok(/11\.0%/.test(missFlag.message), 'message: states the actual value as a percentage (11.0%)');
  ok(/outside the expected range/.test(missFlag.message), 'message: says the upload is outside the expected range');
  ok(formatStatValue('missing', 0.042) === '4.2%', 'format: rates render as one-decimal percentages');

  // low-side flag + rate clamp: a band that dips below 0 is clamped for display.
  const lowFlag = describeForecastFlag({ kind: 'missing', column: 'x', expected: 0.02, low: -0.01, high: 0.05, actual: 0.20, trend: 0, direction: 'above' });
  ok(/\(0\.0%–/.test(lowFlag), 'format: a negative lower band is clamped to 0.0% in the message');

  // ===== END-TO-END through runAllLayers with an injected trend-history store =====
  // Four "uploads" of one schema on a clean rising mean (std 0, so static mean
  // drift never fires), then a fifth wildly off-trend. Distinct table names keep
  // the same schema signature while isolating the persistent path.
  const store = makeForecastStore();
  const means = [100, 110, 120, 130];
  const mkRows = (m) => Array.from({ length: 20 }, (_, i) => ({ id: i, amount: m, category: 'A' }));

  let lastReport = null;
  for (let k = 0; k < means.length; k++) {
    const ds = await makeDataset(`fc_upload_${k}`, mkRows(means[k]));
    const res = await runAllLayers(ds, { fingerprintStore: store });
    lastReport = res.distribution_drift.forecast;
  }
  // After 4 uploads the store holds 4 history points but each run only saw the
  // prior <4, so all were inactive.
  ok(lastReport && lastReport.active === false, 'e2e: forecast stays inactive until MIN_FORECAST_HISTORY prior uploads exist');

  const dsOff = await makeDataset('fc_upload_off', mkRows(500)); // way off the 100→130 line
  const resOff = await runAllLayers(dsOff, { fingerprintStore: store });
  const off = resOff.distribution_drift.forecast;
  ok(off && off.active === true && off.historyLen === 4, `e2e: the 5th upload activates the forecast (historyLen=${off && off.historyLen})`);
  ok(off.flags.some(f => f.column === 'amount'), 'e2e: the off-trend mean is flagged as a trend-aware alert');
  ok(resOff.distribution_drift.status === 'warn', `e2e: a trend-aware alert escalates a passing static check to warn (status=${resOff.distribution_drift.status})`);

  // ===== NO regression: a store WITHOUT the history contract leaves forecast null =====
  const legacyStore = {
    map: new Map(),
    async getBaseline(h) { return this.map.get(h); },
    async saveBaseline(h, s) { this.map.set(h, { columnStats: s, version: 1 }); },
  };
  const dsLegacy = await makeDataset('fc_legacy', mkRows(140));
  const resLegacy = await runAllLayers(dsLegacy, { fingerprintStore: legacyStore });
  ok(resLegacy.distribution_drift.forecast === null,
    'regression: a store lacking getFingerprintHistory leaves forecast null (base PR#15 behaviour untouched)');

  // ===== history cap is respected by the report input (bounded memory) =====
  ok(FORECAST_HISTORY_CAP >= MIN_FORECAST_HISTORY, 'config: history cap is at least the min-history requirement');

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
