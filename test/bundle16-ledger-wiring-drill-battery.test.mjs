// ============================================================
// DATAGLOW - Bundle 16: Repair Ledger wiring residuals + the original
// RECEIPT drill battery.
// ============================================================
//
// Pure Node, no DOM, no browser. Two things are exercised here:
//
//   A. js/spine/repair-ledger.js: the nine REPAIR_LEDGER_KINDS this bundle
//      finished wiring against (load, quarantine_decision, excel_hell_apply,
//      python_recipe, r_recipe, export, plus the pre-existing type_guard,
//      sql_recipe_run, summarize_tiles), and that WIRING_REPORT_KNOWN_SOURCES
//      / wiringReport() now agree with that same list instead of a
//      hand-maintained second list that could drift from it.
//
//   B. js/drill-floor/drill-floor.js: the four-drill battery's goldenAnswers
//      and the pure scoreDrillAnswer(drillId, engine, result) checker, plus
//      the deterministic generators in drill-floor-data.js that those golden
//      answers are computed against (so a change to the seeded PRNG output
//      would fail this suite before it ever reached a demo).
//
// The DOM-coupled `ledgerAppendFromSurface` wrapper itself
// (js/spine/data-glow-repair-ledger-canvas.js) is a thin, best-effort,
// never-throwing shim over exactly the appendStep()/wiringReport() calls
// this file exercises directly; it has no js/ module of its own to import
// (canvas-only IIFE, per CODEMAP), so its logic is proven here at the engine
// level it delegates to, the same split Bundle 14/15 used between a pure
// engine test and a canvas-UI test.
//
// RUN WITH:  node --test test/bundle16-ledger-wiring-drill-battery.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  REPAIR_LEDGER_KIND,
  REPAIR_LEDGER_KINDS,
  REPAIR_LEDGER_ENGINES,
  REPAIR_LEDGER_STATUSES,
  WIRING_REPORT_KNOWN_SOURCES,
  buildStep,
  appendStep,
  listSteps,
  wiringReport,
  ledgerSummary,
  exportLedgerJson,
  exportLedgerMarkdown,
} from '../js/spine/repair-ledger.js';

import {
  DRILL_ORDERS_TABLE,
  DRILL_PROMOS_TABLE,
  generateOrders,
  generatePromos,
} from '../js/drill-floor/drill-floor-data.js';

import {
  DRILLS,
  DRILL_BATTERY_HONESTY_NOTE,
  getDrill,
  extractRowCount,
  runDrillSql,
  runDrillPython,
  runDrillR,
  scoreDrillAnswer,
} from '../js/drill-floor/drill-floor.js';

const EM_DASH = '\u2014';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function read(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

// ------------------------------------------------------------
// A - Repair Ledger wiring residuals: kinds, wiringReport alignment, and a
//     simulated multi-surface session using the same appendStep() the
//     canvas's ledgerAppendFromSurface() delegates to.
// ------------------------------------------------------------

describe('repair-ledger: REPAIR_LEDGER_KINDS carries every Bundle 16 surface', () => {
  const expectedKinds = [
    'load', 'quarantine_decision', 'type_guard', 'excel_hell_apply',
    'sql_recipe_run', 'python_recipe', 'r_recipe', 'summarize_tiles', 'export',
  ];

  it('has exactly the nine known kinds, in order', () => {
    assert.deepEqual(REPAIR_LEDGER_KINDS.slice(), expectedKinds);
  });

  it('is frozen so a caller cannot mutate the shared list', () => {
    assert.ok(Object.isFrozen(REPAIR_LEDGER_KINDS));
  });

  it('the Bundle 16 residual kinds are all present: load, quarantine_decision, excel_hell_apply, python_recipe, r_recipe, export', () => {
    for (const kind of ['load', 'quarantine_decision', 'excel_hell_apply', 'python_recipe', 'r_recipe', 'export']) {
      assert.ok(REPAIR_LEDGER_KINDS.includes(kind), `missing kind: ${kind}`);
    }
  });

  it('WIRING_REPORT_KNOWN_SOURCES IS REPAIR_LEDGER_KINDS (same array, not a second hand-maintained list)', () => {
    assert.strictEqual(WIRING_REPORT_KNOWN_SOURCES, REPAIR_LEDGER_KINDS);
  });
});

describe('repair-ledger: buildStep()/appendStep() normalize every Bundle 16 kind correctly', () => {
  it('buildStep accepts every known kind unchanged and falls back to sql_recipe_run for an unknown one', () => {
    for (const kind of REPAIR_LEDGER_KINDS) {
      const step = buildStep({ kind, title: 't' });
      assert.equal(step.kind, kind);
    }
    const bogus = buildStep({ kind: 'csv_quarantine', title: 'legacy alias name' });
    assert.equal(bogus.kind, 'sql_recipe_run', 'an old alias name that is not a real kind must fall back, not silently pass through');
  });

  it('a load step from a sample-dataset drop looks like main.js ledgerAppendLoad() would build it', () => {
    const ledger = [];
    const step = appendStep(ledger, {
      kind: 'load',
      engine: 'system',
      title: 'Dataset loaded: drill_orders',
      outputTable: 'drill_orders',
      summary: 'Loaded drill_orders (300 rows)',
      status: 'applied',
    });
    assert.equal(step.kind, 'load');
    assert.equal(step.status, 'applied');
    assert.equal(listSteps(ledger).length, 1);
  });

  it('a quarantine_decision step records accept/reject the same way for either outcome', () => {
    const ledger = [];
    appendStep(ledger, { kind: 'quarantine_decision', engine: 'system', title: 'Quarantine: accepted', status: 'applied' });
    appendStep(ledger, { kind: 'quarantine_decision', engine: 'system', title: 'Quarantine: rejected', status: 'skipped' });
    const rows = listSteps(ledger);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.status), ['applied', 'skipped']);
  });

  it('an excel_hell_apply step is engine excel and status applied when a repair actually runs', () => {
    const ledger = [];
    const step = appendStep(ledger, { kind: 'excel_hell_apply', engine: 'excel', title: 'Fixed merged headers', status: 'applied' });
    assert.equal(step.kind, 'excel_hell_apply');
    assert.equal(step.engine, 'excel');
  });

  it('python_recipe and r_recipe steps both append distinctly by kind', () => {
    const ledger = [];
    appendStep(ledger, { kind: 'python_recipe', engine: 'python', title: 'Ran pack recipe', status: 'applied' });
    appendStep(ledger, { kind: 'r_recipe', engine: 'r', title: 'Ran pack recipe', status: 'applied' });
    const rows = listSteps(ledger);
    assert.deepEqual(rows.map((r) => r.kind), ['python_recipe', 'r_recipe']);
  });

  it('an export step is status applied for a download/copy, never a rerunnable step', () => {
    const ledger = [];
    const step = appendStep(ledger, { kind: 'export', engine: 'system', title: 'Ledger exported (JSON)', status: 'applied' });
    assert.equal(step.kind, 'export');
    assert.equal(step.rerunnable, false, 'export is not in RERUNNABLE_KINDS, so it must never claim rerunnable');
  });

  it('every REPAIR_LEDGER_ENGINES and REPAIR_LEDGER_STATUSES value round-trips through buildStep unchanged', () => {
    for (const engine of REPAIR_LEDGER_ENGINES) {
      for (const status of REPAIR_LEDGER_STATUSES) {
        const step = buildStep({ engine, status, title: 'x' });
        assert.equal(step.engine, engine);
        assert.equal(step.status, status);
      }
    }
  });
});

describe('repair-ledger: wiringReport() is truthful against the real known-kinds list', () => {
  it('reports zero fired / all unwired for a session with no appends', () => {
    const report = wiringReport({ firedSources: [] });
    assert.equal(report.fired.length, 0);
    assert.equal(report.unwired.length, REPAIR_LEDGER_KINDS.length);
    assert.deepEqual(report.known, REPAIR_LEDGER_KINDS);
  });

  it('a simulated full-battery session (all nine surfaces fire once) reports zero unwired', () => {
    const ledger = [];
    const fired = [];
    for (const kind of REPAIR_LEDGER_KINDS) {
      const step = appendStep(ledger, { kind, title: 'exercise ' + kind, status: 'applied' });
      if (fired.indexOf(step.kind) < 0) fired.push(step.kind);
    }
    assert.equal(listSteps(ledger).length, REPAIR_LEDGER_KINDS.length, 'every surface append increases listSteps, per the Bundle 16 spec');
    const report = wiringReport({ firedSources: fired });
    assert.deepEqual(report.unwired, []);
    assert.match(report.headline, /Every known surface has appended/);
  });

  it('a partial session (only load + export fired) names exactly the remaining unwired surfaces', () => {
    const report = wiringReport({ firedSources: ['load', 'export'] });
    assert.ok(!report.unwired.includes('load'));
    assert.ok(!report.unwired.includes('export'));
    assert.ok(report.unwired.includes('quarantine_decision'));
    assert.ok(report.unwired.includes('python_recipe'));
    assert.ok(report.unwired.includes('r_recipe'));
    assert.ok(report.unwired.includes('excel_hell_apply'));
  });

  it('never throws on garbage input (mirrors the never-throw discipline ledgerAppendFromSurface relies on)', () => {
    assert.doesNotThrow(() => wiringReport(undefined));
    assert.doesNotThrow(() => wiringReport({ firedSources: 'not-an-array' }));
    assert.doesNotThrow(() => wiringReport({ firedSources: [123, null, {}, 'load'] }));
    const report = wiringReport({ firedSources: [123, null, {}, 'load'] });
    assert.deepEqual(report.fired, ['load']);
  });

  it('ledgerSummary and both exporters never throw on an empty or a populated ledger', () => {
    assert.doesNotThrow(() => ledgerSummary([]));
    assert.doesNotThrow(() => exportLedgerJson([]));
    assert.doesNotThrow(() => exportLedgerMarkdown([]));
    const ledger = [];
    appendStep(ledger, { kind: 'load', title: 'Loaded sample', status: 'applied' });
    appendStep(ledger, { kind: 'export', title: 'Exported ledger', status: 'applied' });
    const summary = ledgerSummary(ledger);
    assert.equal(summary.total, 2);
    assert.equal(summary.byStatus.applied, 2);
    const json = JSON.parse(exportLedgerJson(ledger));
    assert.equal(json.kind, REPAIR_LEDGER_KIND);
    assert.equal(json.steps.length, 2);
    const md = exportLedgerMarkdown(ledger);
    assert.match(md, /\| 1 \|/);
    assert.match(md, /\| 2 \|/);
  });
});

describe('repair-ledger: appendFromSurface call sites in the canvas are wired to real kinds (static check)', () => {
  const canvasSurfaceFiles = [
    'js/app-shell/main.js',
    'js/spine/data-glow-repair-ledger-canvas.js',
    'js/dataquality/data-glow-csv-quarantine-canvas.js',
    'js/intelligence/data-glow-excel-hell-canvas.js',
    'js/polyglot/data-glow-power-packs-canvas.js',
  ];

  it('every appendFromSurface(...) call site names a string literal kind that is one of REPAIR_LEDGER_KINDS, or a computed kind variable', () => {
    const literalKindRe = /appendFromSurface\(\s*'([^']+)'/g;
    let foundAtLeastOneLiteral = false;
    for (const file of canvasSurfaceFiles) {
      const src = read(file);
      let m;
      while ((m = literalKindRe.exec(src)) !== null) {
        foundAtLeastOneLiteral = true;
        assert.ok(
          REPAIR_LEDGER_KINDS.includes(m[1]),
          `${file}: appendFromSurface('${m[1]}', ...) uses a kind that is not in REPAIR_LEDGER_KINDS`,
        );
      }
    }
    assert.ok(foundAtLeastOneLiteral, 'expected at least one literal-kind appendFromSurface call site across the wired surfaces');
  });

  it('main.js wires load (ledgerAppendLoad) and the drill battery (python_recipe/r_recipe/sql_recipe_run) kinds', () => {
    const src = read('js/app-shell/main.js');
    assert.match(src, /appendFromSurface\('load'/);
    assert.match(src, /python_recipe/);
    assert.match(src, /r_recipe/);
    assert.match(src, /sql_recipe_run/);
  });

  it('csv quarantine canvas wires quarantine_decision; Excel Hell canvas wires excel_hell_apply', () => {
    assert.match(read('js/dataquality/data-glow-csv-quarantine-canvas.js'), /appendFromSurface\('quarantine_decision'/);
    assert.match(read('js/intelligence/data-glow-excel-hell-canvas.js'), /appendFromSurface\('excel_hell_apply'/);
  });

  it('the shared ledgerAppendFromSurface helper never throws by construction (wrapped in try/catch, returns null on failure)', () => {
    const src = read('js/spine/data-glow-repair-ledger-canvas.js');
    const fnMatch = src.match(/function ledgerAppendFromSurface\([^)]*\)\s*\{([\s\S]*?)\n  \}/);
    assert.ok(fnMatch, 'expected to find the ledgerAppendFromSurface function body');
    assert.match(fnMatch[1], /try\s*\{/);
    assert.match(fnMatch[1], /catch\s*\(_e\)\s*\{\s*return null;/);
  });
});

// ------------------------------------------------------------
// B - The original RECEIPT drill battery: registry shape, deterministic data,
//     and scoreDrillAnswer.
// ------------------------------------------------------------

describe('drill-floor-data: deterministic, original, DataGlow-owned sample tables', () => {
  it('generateOrders/generatePromos are pure and deterministic (same seed -> identical output every call)', () => {
    const a = generateOrders();
    const b = generateOrders();
    assert.deepEqual(a, b);
    const pa = generatePromos();
    const pb = generatePromos();
    assert.deepEqual(pa, pb);
  });

  it('ships exactly 300 orders and 14 promos by default, namespaced table names', () => {
    assert.equal(generateOrders().length, 300);
    assert.equal(generatePromos().length, 14);
    assert.equal(DRILL_ORDERS_TABLE, 'drill_orders');
    assert.equal(DRILL_PROMOS_TABLE, 'drill_promos');
  });

  it('never carries any Maven-branded field or text', () => {
    const src = read('js/drill-floor/drill-floor-data.js');
    assert.doesNotMatch(src, /maven/i);
    assert.ok(!src.includes(EM_DASH), 'no em dash per house style');
  });
});

describe('drill-floor: DRILLS registry shape (four drills, each fully specified)', () => {
  it('has exactly four drills with the expected ids', () => {
    assert.equal(DRILLS.length, 4);
    assert.deepEqual(DRILLS.map((d) => d.id), [
      'spot-the-sale', 'top-order-per-channel', 'channels-over-threshold', 'running-total-by-day',
    ]);
  });

  it('every drill has starterSql/starterPython/starterR, an excelNote, and a goldenAnswers block for all three engines', () => {
    for (const drill of DRILLS) {
      assert.equal(typeof drill.starterSql, 'string');
      assert.ok(drill.starterSql.length > 0);
      assert.equal(typeof drill.starterPython, 'string');
      assert.ok(drill.starterPython.length > 0);
      assert.equal(typeof drill.starterR, 'string');
      assert.ok(drill.starterR.length > 0);
      assert.equal(typeof drill.excelNote, 'string');
      assert.match(drill.excelNote, /Not full Excel/, `${drill.id}: excelNote must be honest about not running a real Excel engine`);
      assert.ok(drill.goldenAnswers && drill.goldenAnswers.sql && drill.goldenAnswers.python && drill.goldenAnswers.r, `${drill.id}: missing a goldenAnswers engine block`);
      for (const engineName of ['sql', 'python', 'r']) {
        assert.equal(typeof drill.goldenAnswers[engineName].rowCount, 'number', `${drill.id}.${engineName}: rowCount must be a known number`);
      }
    }
  });

  it('getDrill() finds a real drill by id and returns null for anything else, never throws', () => {
    assert.equal(getDrill('spot-the-sale').title, 'Spot the Sale');
    assert.equal(getDrill('does-not-exist'), null);
    assert.equal(getDrill(undefined), null);
    assert.equal(getDrill(123), null);
  });

  it('carries the required honesty line verbatim, and no drill claims a Maven answer key', () => {
    assert.match(DRILL_BATTERY_HONESTY_NOTE, /original DataGlow data and golden answers/);
    assert.match(DRILL_BATTERY_HONESTY_NOTE, /not Maven Analytics Data Drills/);
    const src = read('js/drill-floor/drill-floor.js');
    const maven = src.match(/maven/gi) || [];
    // The honesty note itself is allowed to name Maven (to disclaim it); nothing else should.
    assert.ok(maven.length <= 2, 'Maven should appear at most in the honesty note, not describing real drill content');
  });
});

describe('drill-floor: golden answers are independently reproducible from the deterministic generators', () => {
  const orders = generateOrders();
  const promos = generatePromos();

  it('spot-the-sale: BETWEEN join golden rowCount/sumAmount/orderIdChecksum are exactly reproducible', () => {
    let rowCount = 0;
    let sumAmount = 0;
    let orderIdChecksum = 0;
    for (const o of orders) {
      for (const p of promos) {
        if (o.order_date >= p.start_date && o.order_date <= p.end_date) {
          rowCount += 1;
          sumAmount += o.amount;
          orderIdChecksum += o.order_id;
        }
      }
    }
    sumAmount = Math.round(sumAmount * 100) / 100;
    const golden = getDrill('spot-the-sale').goldenAnswers.sql;
    assert.equal(rowCount, golden.rowCount);
    assert.equal(sumAmount, golden.sumAmount);
    assert.equal(orderIdChecksum, golden.orderIdChecksum);
  });

  it('top-order-per-channel: window/rank-within-group golden rowCount/sumOfTopAmounts are exactly reproducible', () => {
    const byChannel = {};
    for (const o of orders) {
      if (!byChannel[o.channel] || o.amount > byChannel[o.channel].amount) byChannel[o.channel] = o;
    }
    const channels = Object.keys(byChannel);
    const sumOfTopAmounts = Math.round(channels.reduce((s, c) => s + byChannel[c].amount, 0) * 100) / 100;
    const golden = getDrill('top-order-per-channel').goldenAnswers.sql;
    assert.equal(channels.length, golden.rowCount);
    assert.equal(sumOfTopAmounts, golden.sumOfTopAmounts);
  });

  it('channels-over-threshold: GROUP BY + HAVING golden rowCount/channels/totalOfKept are exactly reproducible', () => {
    const totals = {};
    for (const o of orders) totals[o.channel] = (totals[o.channel] || 0) + o.amount;
    for (const c in totals) totals[c] = Math.round(totals[c] * 100) / 100;
    const kept = Object.keys(totals).filter((c) => totals[c] > 19000);
    const totalOfKept = Math.round(kept.reduce((s, c) => s + totals[c], 0) * 100) / 100;
    const golden = getDrill('channels-over-threshold').goldenAnswers.sql;
    assert.equal(kept.length, golden.rowCount);
    assert.deepEqual(kept.sort(), golden.channels.slice().sort());
    assert.equal(totalOfKept, golden.totalOfKept);
  });

  it('running-total-by-day: cumulative window sum golden rowCount/grandTotal are exactly reproducible', () => {
    const byDay = {};
    for (const o of orders) byDay[o.order_date] = (byDay[o.order_date] || 0) + o.amount;
    const days = Object.keys(byDay);
    let running = 0;
    for (const d of days) running += Math.round(byDay[d] * 100) / 100;
    running = Math.round(running * 100) / 100;
    const golden = getDrill('running-total-by-day').goldenAnswers.sql;
    assert.equal(days.length, golden.rowCount);
    assert.equal(running, golden.grandTotal);
  });
});

describe('drill-floor: extractRowCount is a tolerant best-effort reader', () => {
  it('prefers an explicit rowCount field', () => {
    assert.equal(extractRowCount({ rowCount: 5, rows: [1, 2, 3] }), 5);
  });
  it('falls back to rows.length when rowCount is absent', () => {
    assert.equal(extractRowCount({ rows: [1, 2, 3] }), 3);
  });
  it('returns null for anything unreadable, never throws', () => {
    assert.equal(extractRowCount(null), null);
    assert.equal(extractRowCount(undefined), null);
    assert.equal(extractRowCount('a string'), null);
    assert.equal(extractRowCount({}), null);
  });
});

describe('drill-floor: run* delegators never throw and normalize a rejection into {error}', () => {
  it('runDrillSql returns {result, rowCount} on success', async () => {
    const out = await runDrillSql('SELECT 1', { runQuery: async () => ({ rowCount: 1, rows: [{ x: 1 }] }) });
    assert.equal(out.rowCount, 1);
  });
  it('runDrillSql normalizes a thrown error into {error}, never rejects', async () => {
    const out = await runDrillSql('SELECT 1', { runQuery: async () => { throw new Error('boom'); } });
    assert.equal(out.error, 'boom');
  });
  it('runDrillPython/runDrillR likewise normalize a rejection into {error}', async () => {
    const py = await runDrillPython('1/0', { runPython: async () => { throw new Error('py boom'); } });
    assert.equal(py.error, 'py boom');
    const r = await runDrillR('stop("x")', { runR: async () => { throw new Error('r boom'); } });
    assert.equal(r.error, 'r boom');
  });
});

describe('scoreDrillAnswer: pure golden-answer checker, never throws', () => {
  it('passes a SQL result whose rowCount matches the golden rowCount', () => {
    const score = scoreDrillAnswer('spot-the-sale', 'sql', { result: { rowCount: 133, rows: new Array(133) } });
    assert.equal(score.pass, true);
    assert.equal(score.expected, 133);
    assert.equal(score.got, 133);
  });

  it('fails a SQL result whose rowCount does not match', () => {
    const score = scoreDrillAnswer('spot-the-sale', 'sql', { result: { rowCount: 100 } });
    assert.equal(score.pass, false);
    assert.equal(score.expected, 133);
    assert.equal(score.got, 100);
  });

  it('reads a Python/R result from its "matched rows: N" stdout line', () => {
    const pyScore = scoreDrillAnswer('spot-the-sale', 'python', { stdout: 'matched rows: 133\n' });
    assert.equal(pyScore.pass, true);
    const rScore = scoreDrillAnswer('spot-the-sale', 'r', { stdout: 'matched rows: 133 \n' });
    assert.equal(rScore.pass, true);
  });

  it('uses the LAST "matched rows" line when several are printed', () => {
    const score = scoreDrillAnswer('spot-the-sale', 'python', { stdout: 'matched rows: 999\nmatched rows: 133\n' });
    assert.equal(score.got, 133);
    assert.equal(score.pass, true);
  });

  it('fails closed (pass:false, got:null) when nothing readable is in the result', () => {
    const score = scoreDrillAnswer('spot-the-sale', 'python', { stdout: 'no numbers here' });
    assert.equal(score.pass, false);
    assert.equal(score.got, null);
    assert.equal(typeof score.error, 'string');
  });

  it('carries the upstream error through instead of a false pass/fail when the run itself errored', () => {
    const score = scoreDrillAnswer('spot-the-sale', 'sql', { error: 'engine not ready' });
    assert.equal(score.pass, false);
    assert.equal(score.error, 'engine not ready');
    assert.equal(score.expected, 133);
  });

  it('never throws for an unknown drill id or engine name', () => {
    assert.doesNotThrow(() => scoreDrillAnswer('does-not-exist', 'sql', { result: { rowCount: 1 } }));
    const score1 = scoreDrillAnswer('does-not-exist', 'sql', { result: { rowCount: 1 } });
    assert.equal(score1.pass, false);

    assert.doesNotThrow(() => scoreDrillAnswer('spot-the-sale', 'cobol', { result: { rowCount: 1 } }));
    const score2 = scoreDrillAnswer('spot-the-sale', 'cobol', { result: { rowCount: 1 } });
    assert.equal(score2.pass, false);

    assert.doesNotThrow(() => scoreDrillAnswer(undefined, undefined, undefined));
    assert.doesNotThrow(() => scoreDrillAnswer(null, null, null));
  });

  it('scores every drill in the registry correctly against its own golden rowCount, for all three engines', () => {
    for (const drill of DRILLS) {
      for (const engineName of ['sql', 'python', 'r']) {
        const golden = drill.goldenAnswers[engineName].rowCount;
        const result = engineName === 'sql'
          ? { result: { rowCount: golden } }
          : { stdout: 'matched rows: ' + golden + '\n' };
        const score = scoreDrillAnswer(drill.id, engineName, result);
        assert.equal(score.pass, true, `${drill.id}/${engineName} should pass against its own golden rowCount`);
        assert.equal(score.got, golden);
      }
    }
  });

  it('the returned score object always carries drillId and engine as given, for a RECEIPT line', () => {
    const score = scoreDrillAnswer('channels-over-threshold', 'r', { stdout: 'matched rows: 1\n' });
    assert.equal(score.drillId, 'channels-over-threshold');
    assert.equal(score.engine, 'r');
  });
});

describe('drill-floor: end-to-end run + score pipeline, per engine', () => {
  it('SQL: runDrillSql -> scoreDrillAnswer passes for the running-total-by-day drill golden rowCount', async () => {
    const drill = getDrill('running-total-by-day');
    const out = await runDrillSql(drill.starterSql, {
      runQuery: async () => ({ rowCount: drill.goldenAnswers.sql.rowCount, rows: [] }),
    });
    const score = scoreDrillAnswer('running-total-by-day', 'sql', out);
    assert.equal(score.pass, true);
  });

  it('Python: runDrillPython -> scoreDrillAnswer passes for the channels-over-threshold drill golden rowCount', async () => {
    const drill = getDrill('channels-over-threshold');
    const out = await runDrillPython(drill.starterPython, {
      runPython: async () => ({ stdout: 'matched rows: ' + drill.goldenAnswers.python.rowCount + '\n' }),
    });
    const score = scoreDrillAnswer('channels-over-threshold', 'python', out);
    assert.equal(score.pass, true);
  });

  it('R: runDrillR -> scoreDrillAnswer passes for the top-order-per-channel drill golden rowCount', async () => {
    const drill = getDrill('top-order-per-channel');
    const out = await runDrillR(drill.starterR, {
      runR: async () => ({ stdout: 'matched rows: ' + drill.goldenAnswers.r.rowCount + '\n' }),
    });
    const score = scoreDrillAnswer('top-order-per-channel', 'r', out);
    assert.equal(score.pass, true);
  });

  it('a failed run (engine error) scores as a clean fail, and the failure can still be appended to the Repair Ledger as status "failed"', async () => {
    const out = await runDrillSql('SELECT 1', { runQuery: async () => { throw new Error('DuckDB not ready'); } });
    const score = scoreDrillAnswer('spot-the-sale', 'sql', out);
    assert.equal(score.pass, false);
    assert.equal(score.error, 'DuckDB not ready');

    const ledger = [];
    const step = appendStep(ledger, {
      kind: 'sql_recipe_run',
      engine: 'sql',
      title: 'Drill check: spot-the-sale',
      summary: 'Drill "spot-the-sale" (SQL): FAIL - DuckDB not ready',
      status: score.pass ? 'applied' : 'failed',
    });
    assert.equal(step.status, 'failed');
  });
});
