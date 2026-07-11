// ============================================================
// DATAGLOW — Semantic Drift Watchdog test suite
// ============================================================
// Pure Node tests, no DuckDB/browser needed — this module computes nothing
// statistical of its own, so these tests are about the de-duplication and
// formatting contract, not drift math (that's covered by
// distribution-fingerprint-drift.test.mjs and drift-forecast.test.mjs).
//
// RUN WITH:  node test/drift-watchdog.test.mjs

import {
  summarizeDriftEvent, alertFingerprint, DriftWatchdog, formatWatchdogAlert,
} from '../js/ambient/drift-watchdog.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- fixtures mirroring validation.js's real distribution_drift shape ----------
const passDrift = { status: 'pass', summary: 'Column distributions are stable versus baseline — no drift.' };
const failDrift = {
  status: 'fail',
  summary: '2 column(s) drifted versus baseline despite an unchanged schema.',
  drifts: [
    '"amount": mean shifted 3.1σ (was 42.10, now 98.40).',
    '"status": top-5 category composition changed — new entrants: "refunded".',
  ],
};
const warnForecastDrift = {
  status: 'warn',
  summary: '1 trend-aware drift alert(s): this upload is outside the forecasted trajectory.',
  forecast: { active: true, historyLen: 6, flags: [{ message: 'mean of "amount" forecast 55.00±4.00, actual 98.40.' }] },
};
const inactiveForecastDrift = { status: 'pass', summary: 'stable', forecast: { active: false, historyLen: 2, flags: [] } };

function main() {
  // ---------- summarizeDriftEvent ----------
  {
    const s = summarizeDriftEvent(passDrift);
    ok(s.severity === 'pass', 'summarizeDriftEvent: pass status maps to pass severity');
    ok(s.lines.length === 0, 'summarizeDriftEvent: pass drift has no lines');
    ok(s.headline.includes('stable'), 'summarizeDriftEvent: headline reuses the layer summary verbatim');
  }
  {
    const s = summarizeDriftEvent(failDrift);
    ok(s.severity === 'fail', 'summarizeDriftEvent: fail status maps to fail severity');
    ok(s.lines.length === 2, 'summarizeDriftEvent: extracts both drift lines');
    ok(s.lines[0].includes('amount'), 'summarizeDriftEvent: first line names the actual drifted column');
  }
  {
    const s = summarizeDriftEvent(warnForecastDrift);
    ok(s.severity === 'warn', 'summarizeDriftEvent: warn status maps to warn severity');
    ok(s.lines.length === 1 && s.lines[0].includes('forecast'), 'summarizeDriftEvent: pulls active forecast flag messages');
  }
  {
    const s = summarizeDriftEvent(inactiveForecastDrift);
    ok(s.severity === 'pass' && s.lines.length === 0, 'summarizeDriftEvent: inactive forecast contributes no lines even if present');
  }
  {
    const s = summarizeDriftEvent(null);
    ok(s.severity === 'pass' && s.lines.length === 0, 'summarizeDriftEvent: null input degrades to silent pass, never throws');
  }
  {
    const s = summarizeDriftEvent({ status: 'fail' }); // no summary, no drifts array
    ok(s.severity === 'fail', 'summarizeDriftEvent: malformed-but-fail-status object still reports fail severity');
    ok(typeof s.headline === 'string' && s.headline.length > 0, 'summarizeDriftEvent: synthesizes a headline when summary is missing');
  }

  // ---------- alertFingerprint ----------
  {
    const a = alertFingerprint(summarizeDriftEvent(failDrift));
    const b = alertFingerprint(summarizeDriftEvent(failDrift));
    ok(a === b, 'alertFingerprint: identical drift produces identical fingerprint');
  }
  {
    const a = alertFingerprint(summarizeDriftEvent(failDrift));
    const b = alertFingerprint(summarizeDriftEvent(passDrift));
    ok(a !== b, 'alertFingerprint: different severities produce different fingerprints');
  }
  {
    // Same lines, different array order — should still fingerprint identically
    // (order in the underlying layer's output is not semantically meaningful).
    const reordered = { ...failDrift, drifts: [...failDrift.drifts].reverse() };
    const a = alertFingerprint(summarizeDriftEvent(failDrift));
    const b = alertFingerprint(summarizeDriftEvent(reordered));
    ok(a === b, 'alertFingerprint: line order does not change the fingerprint');
  }

  // ---------- DriftWatchdog de-duplication ----------
  {
    const wd = new DriftWatchdog();
    const d1 = wd.observe('sales.csv', failDrift);
    ok(d1.isNew === true, 'DriftWatchdog: first observation of a file is always new');
    ok(d1.shouldNotify === true, 'DriftWatchdog: a fail-severity first observation should notify');

    const d2 = wd.observe('sales.csv', failDrift);
    ok(d2.isNew === false, 'DriftWatchdog: identical repeat observation is not new');
    ok(d2.shouldNotify === false, 'DriftWatchdog: identical repeat observation does not re-notify (no spam)');
  }
  {
    const wd = new DriftWatchdog();
    wd.observe('sales.csv', passDrift);
    const afterPass = wd.observe('sales.csv', passDrift);
    ok(afterPass.shouldNotify === false, 'DriftWatchdog: repeated pass never notifies');
  }
  {
    const wd = new DriftWatchdog();
    wd.observe('sales.csv', passDrift);
    const onDriftStart = wd.observe('sales.csv', failDrift);
    ok(onDriftStart.isNew === true && onDriftStart.shouldNotify === true,
      'DriftWatchdog: transitioning from pass to fail on the same file notifies once');
  }
  {
    const wd = new DriftWatchdog();
    wd.observe('sales.csv', failDrift);
    // A DIFFERENT drift on the same file (new column drifted) must still count
    // as new, even though the file was already in a "fail" state.
    const differentFail = {
      status: 'fail',
      summary: 'drifted again',
      drifts: ['"discount": mean shifted 4.0σ (was 0.05, now 0.30).'],
    };
    const d = wd.observe('sales.csv', differentFail);
    ok(d.isNew === true && d.shouldNotify === true,
      'DriftWatchdog: a DIFFERENT drift signal on an already-failing file still notifies');
  }
  {
    const wd = new DriftWatchdog();
    wd.observe('a.csv', failDrift);
    const b = wd.observe('b.csv', failDrift);
    ok(b.isNew === true && b.shouldNotify === true,
      'DriftWatchdog: per-file tracking — the same drift content on a DIFFERENT file still notifies');
  }
  {
    const wd = new DriftWatchdog();
    wd.observe('sales.csv', failDrift);
    wd.clear('sales.csv');
    const after = wd.observe('sales.csv', failDrift);
    ok(after.isNew === true && after.shouldNotify === true,
      'DriftWatchdog.clear: re-arms a single file so the same drift notifies again');
  }
  {
    const wd = new DriftWatchdog();
    wd.observe('a.csv', failDrift);
    wd.observe('b.csv', failDrift);
    wd.clearAll();
    const a = wd.observe('a.csv', failDrift);
    const b = wd.observe('b.csv', failDrift);
    ok(a.shouldNotify === true && b.shouldNotify === true, 'DriftWatchdog.clearAll: re-arms every tracked file');
  }
  {
    const wd = new DriftWatchdog();
    // Malformed/missing drift input must never throw from observe().
    let threw = false;
    let d;
    try { d = wd.observe('weird.csv', undefined); } catch (e) { threw = true; }
    ok(threw === false, 'DriftWatchdog.observe: never throws on malformed input');
    ok(d.shouldNotify === false, 'DriftWatchdog.observe: malformed/absent drift never notifies');
  }

  // ---------- formatWatchdogAlert ----------
  {
    const wd = new DriftWatchdog();
    const d = wd.observe('sales.csv', failDrift);
    const line = formatWatchdogAlert('sales.csv', d);
    ok(line.includes('sales.csv'), 'formatWatchdogAlert: includes the file name');
    ok(line.includes('DRIFT'), 'formatWatchdogAlert: fail severity is tagged DRIFT');
    ok(line.includes('2 signals'), 'formatWatchdogAlert: includes the signal count');
  }
  {
    const wd = new DriftWatchdog();
    const d = wd.observe('sales.csv', passDrift);
    const line = formatWatchdogAlert('sales.csv', d);
    ok(line.includes('stable'), 'formatWatchdogAlert: pass severity reads as stable, not an alert');
  }
  {
    const line = formatWatchdogAlert('sales.csv', null);
    ok(line.includes('no drift information'), 'formatWatchdogAlert: handles a missing decision object gracefully');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
