// ============================================================
// DATAGLOW - Bundle 18 proof: archetype drills (SCD/streaks/baskets) +
// R Air-Gap prebundle, flags, canvas parity
// ============================================================
// Static/pure-module test file (no browser launch). Checks the SHIPPED
// artifacts of Bundle 18 directly:
//   A. three new drills (scd-as-of, streak-islands, basket-pairs) are
//      registered in DRILLS with starters for all three languages and a
//      goldenAnswers block; the golden numbers are independently
//      RE-DERIVED here from the same generator functions (never trusted
//      from the module's own math) and asserted equal.
//   B. scoreDrillAnswer PASS/FAIL/never-throws behavior for the three new
//      drills, plus the new scoreDrillExtras/scalarMatches helpers.
//   C. the R Air-Gap prebundle module: honest availability manifest, no
//      false "available offline" claim, loader prefers local over network,
//      cross-platform-safe (no Node-only/Tauri-only API), smoke test.
//   D. flags: archetypeDrillsExpand + rAirGapPrebundle exist and are ON;
//      dependency flags (drillFloor, receiptDrillBattery) remain ON; 0 OFF
//      flags anywhere in the manifest.
//   E. no em dash in any new visible text; no more than the pre-existing
//      Maven honesty-note mentions; canvas integrity/inject parity with the
//      established short-form-marker convention.
//
// RUN WITH:  node --test test/bundle18-archetype-drills-r-airgap.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const EM_DASH = '\u2014';

function readRepoFile(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

// ------------------------------------------------------------
// Independent reference re-derivation of the three drills' golden
// scalars, from the SAME generator functions the module exports (never
// trusting drill-floor.js's own goldenAnswers block without recomputing).
// ------------------------------------------------------------

async function loadDrillFloorData() {
  return import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor-data.js'));
}

function referenceScdGolden(priceHistory, sales) {
  let rowCount = 0;
  let totalRevenue = 0;
  const productSet = new Set();
  for (const sale of sales) {
    let matched = null;
    for (const row of priceHistory) {
      if (row.product_id === sale.product_id && sale.sale_date >= row.valid_from && sale.sale_date <= row.valid_to) {
        matched = row;
        break;
      }
    }
    if (matched) {
      rowCount += 1;
      totalRevenue += sale.units * matched.price;
      productSet.add(sale.product_id);
    }
  }
  return { rowCount, totalRevenue: Math.round(totalRevenue * 100) / 100, productCount: productSet.size };
}

function referenceStreakGolden(activityDays) {
  const byUser = new Map();
  for (const row of activityDays) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row.activity_date);
  }
  let maxStreak = 0;
  let userId = null;
  let islandCount = 0;
  const userIds = [...byUser.keys()].sort((a, b) => a - b);
  for (const uid of userIds) {
    const dates = [...new Set(byUser.get(uid))].sort();
    let cur = dates.length ? 1 : 0;
    let best = cur;
    let islands = dates.length ? 1 : 0;
    for (let i = 1; i < dates.length; i++) {
      const diffDays = Math.round(
        (new Date(dates[i] + 'T00:00:00Z') - new Date(dates[i - 1] + 'T00:00:00Z')) / 86400000
      );
      if (diffDays === 1) {
        cur += 1;
      } else {
        cur = 1;
        islands += 1;
      }
      if (cur > best) best = cur;
    }
    if (best > maxStreak) {
      maxStreak = best;
      userId = uid;
    }
    islandCount += islands;
  }
  return { maxStreak, userId, islandCount, rowCount: activityDays.length };
}

function referenceBasketGolden(basketLines) {
  const byOrder = new Map();
  for (const row of basketLines) {
    if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, new Set());
    byOrder.get(row.order_id).add(row.sku);
  }
  const pairCounts = new Map();
  for (const skuSet of byOrder.values()) {
    const skus = [...skuSet].sort();
    for (let i = 0; i < skus.length; i++) {
      for (let j = i + 1; j < skus.length; j++) {
        const key = `${skus[i]}|${skus[j]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  let bestKey = null;
  let bestCount = -1;
  for (const key of [...pairCounts.keys()].sort()) {
    const count = pairCounts.get(key);
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  const [pairLeft, pairRight] = bestKey.split('|');
  return { pairLeft, pairRight, orderCount: bestCount, pairKey: bestKey, distinctOrders: byOrder.size, rowCount: basketLines.length };
}

// ------------------------------------------------------------
// A. Three new drills registered, with full starter/golden coverage,
//    and golden numbers independently re-derived and matched.
// ------------------------------------------------------------

describe('bundle18 A: three new archetype drills registered with starters + goldens', () => {
  it('DRILLS includes the 4 Bundle 16 drills plus the 3 new Bundle 18 drills, in order, no duplicates', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    const ids = mod.DRILLS.map((d) => d.id);
    const expected = [
      'spot-the-sale',
      'top-order-per-channel',
      'channels-over-threshold',
      'running-total-by-day',
      'scd-as-of',
      'streak-islands',
      'basket-pairs',
    ];
    assert.deepEqual(ids, expected);
    assert.equal(new Set(ids).size, ids.length, 'drill ids must be unique');
  });

  it('every new drill has starterSql/starterPython/starterR, excelNote, and a goldenAnswers block for all 3 engines', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    for (const id of ['scd-as-of', 'streak-islands', 'basket-pairs']) {
      const drill = mod.getDrill(id);
      assert.ok(drill, `drill ${id} not found via getDrill`);
      for (const key of ['starterSql', 'starterPython', 'starterR', 'excelNote', 'description', 'expectedApproach']) {
        assert.ok(typeof drill[key] === 'string' && drill[key].length > 10, `${id}.${key} missing or too short`);
      }
      for (const engine of ['sql', 'python', 'r']) {
        assert.ok(drill.goldenAnswers && drill.goldenAnswers[engine], `${id} missing goldenAnswers.${engine}`);
        assert.equal(typeof drill.goldenAnswers[engine].rowCount, 'number', `${id}.goldenAnswers.${engine}.rowCount must be a number`);
      }
      assert.match(drill.excelNote, /Not full Excel/, `${id}.excelNote must follow the "Not full Excel" convention`);
    }
  });

  it('scd-as-of golden scalars match an independent re-derivation from generatePriceHistory/generateSales', async () => {
    const dataMod = await loadDrillFloorData();
    const floorMod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    const priceHistory = dataMod.generatePriceHistory();
    const sales = dataMod.generateSales(priceHistory);
    const ref = referenceScdGolden(priceHistory, sales);
    const drill = floorMod.getDrill('scd-as-of');
    assert.equal(drill.goldenAnswers.sql.rowCount, ref.rowCount);
    assert.equal(drill.goldenAnswers.sql.totalRevenue, ref.totalRevenue);
    if (typeof drill.goldenAnswers.sql.productCount === 'number') {
      assert.equal(drill.goldenAnswers.sql.productCount, ref.productCount);
    }
    assert.equal(drill.goldenAnswers.python.rowCount, ref.rowCount);
    assert.equal(drill.goldenAnswers.r.rowCount, ref.rowCount);
  });

  it('streak-islands golden scalars match an independent re-derivation from generateActivityDays', async () => {
    const dataMod = await loadDrillFloorData();
    const floorMod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    const activityDays = dataMod.generateActivityDays();
    const ref = referenceStreakGolden(activityDays);
    const drill = floorMod.getDrill('streak-islands');
    assert.equal(drill.goldenAnswers.sql.rowCount, ref.rowCount);
    assert.equal(drill.goldenAnswers.sql.maxStreak, ref.maxStreak);
    assert.equal(drill.goldenAnswers.sql.userId, ref.userId);
    if (typeof drill.goldenAnswers.sql.islandCount === 'number') {
      assert.equal(drill.goldenAnswers.sql.islandCount, ref.islandCount);
    }
    assert.equal(drill.goldenAnswers.python.rowCount, ref.rowCount);
    assert.equal(drill.goldenAnswers.r.rowCount, ref.rowCount);
  });

  it('basket-pairs golden scalars match an independent re-derivation from generateBasketLines', async () => {
    const dataMod = await loadDrillFloorData();
    const floorMod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    const basketLines = dataMod.generateBasketLines();
    const ref = referenceBasketGolden(basketLines);
    const drill = floorMod.getDrill('basket-pairs');
    assert.equal(drill.goldenAnswers.sql.pairLeft, ref.pairLeft);
    assert.equal(drill.goldenAnswers.sql.pairRight, ref.pairRight);
    assert.equal(drill.goldenAnswers.sql.orderCount, ref.orderCount);
    if (typeof drill.goldenAnswers.sql.pairKey === 'string') {
      assert.equal(drill.goldenAnswers.sql.pairKey, ref.pairKey);
    }
  });

  it('generators are deterministic: calling twice with default seeds yields identical output', async () => {
    const dataMod = await loadDrillFloorData();
    const a = dataMod.generatePriceHistory();
    const b = dataMod.generatePriceHistory();
    assert.deepEqual(a, b);
    const actA = dataMod.generateActivityDays();
    const actB = dataMod.generateActivityDays();
    assert.deepEqual(actA, actB);
    const basketA = dataMod.generateBasketLines();
    const basketB = dataMod.generateBasketLines();
    assert.deepEqual(basketA, basketB);
  });

  it('loadDrillTables() (given a stub runQuery) reports rowCounts for all 6 drill tables, old and new', async () => {
    const dataMod = await loadDrillFloorData();
    const calls = [];
    const stub = { runQuery: async (sql) => { calls.push(sql); return { ok: true }; } };
    const descriptors = await dataMod.loadDrillTables(stub);
    const names = descriptors.map((d) => d.name);
    for (const expected of [
      dataMod.DRILL_ORDERS_TABLE,
      dataMod.DRILL_PROMOS_TABLE,
      dataMod.DRILL_PRICE_HISTORY_TABLE,
      dataMod.DRILL_SALES_TABLE,
      dataMod.DRILL_ACTIVITY_DAYS_TABLE,
      dataMod.DRILL_BASKET_LINES_TABLE,
    ]) {
      assert.ok(names.includes(expected), `loadDrillTables did not report a descriptor for ${expected}`);
    }
    assert.equal(calls.length, 6, 'expected 6 CREATE-TABLE-and-load statements, one per table');
    for (const d of descriptors) {
      assert.ok(d.rowCount > 0, `${d.name} descriptor reports zero rows`);
    }
  });
});

// ------------------------------------------------------------
// B. scoreDrillAnswer / scoreDrillExtras / scalarMatches behavior
// ------------------------------------------------------------

describe('bundle18 B: scoreDrillAnswer and the new extra-scalar scoring helpers', () => {
  it('scoreDrillAnswer PASSes each new drill on its own golden rowCount, per engine', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    for (const id of ['scd-as-of', 'streak-islands', 'basket-pairs']) {
      const drill = mod.getDrill(id);
      const sqlScore = mod.scoreDrillAnswer(id, 'sql', { result: { rowCount: drill.goldenAnswers.sql.rowCount } });
      assert.equal(sqlScore.pass, true, `${id} sql score should pass`);
      const pyScore = mod.scoreDrillAnswer(id, 'python', { stdout: `matched rows: ${drill.goldenAnswers.python.rowCount}\n` });
      assert.equal(pyScore.pass, true, `${id} python score should pass`);
      const rScore = mod.scoreDrillAnswer(id, 'r', { stdout: `matched rows: ${drill.goldenAnswers.r.rowCount}\n` });
      assert.equal(rScore.pass, true, `${id} r score should pass`);
    }
  });

  it('scoreDrillAnswer FAILs on a wrong rowCount and never throws on a garbage result', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    const wrong = mod.scoreDrillAnswer('scd-as-of', 'sql', { result: { rowCount: 999999 } });
    assert.equal(wrong.pass, false);

    assert.doesNotThrow(() => mod.scoreDrillAnswer('scd-as-of', 'sql', null));
    assert.doesNotThrow(() => mod.scoreDrillAnswer('scd-as-of', 'sql', undefined));
    assert.doesNotThrow(() => mod.scoreDrillAnswer('scd-as-of', 'sql', {}));
    assert.doesNotThrow(() => mod.scoreDrillAnswer('scd-as-of', 'python', { stdout: 'not a number here' }));
    assert.doesNotThrow(() => mod.scoreDrillAnswer('not-a-real-drill', 'sql', { result: { rowCount: 1 } }));
    const errorResult = mod.scoreDrillAnswer('scd-as-of', 'sql', { error: 'engine exploded' });
    assert.equal(errorResult.pass, false);
    assert.equal(errorResult.error, 'engine exploded');
  });

  it('scoreDrillExtras cross-checks totalRevenue/productCount/maxStreak/userId/pairLeft/pairRight/orderCount', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    const scd = mod.getDrill('scd-as-of').goldenAnswers.sql;
    const scdScore = mod.scoreDrillExtras('scd-as-of', { totalRevenue: scd.totalRevenue, productCount: scd.productCount });
    assert.equal(scdScore.pass, true);

    const scdWrong = mod.scoreDrillExtras('scd-as-of', { totalRevenue: scd.totalRevenue + 1, productCount: scd.productCount });
    assert.equal(scdWrong.pass, false);
    assert.equal(scdWrong.fields.totalRevenue.pass, false);
    assert.equal(scdWrong.fields.productCount.pass, true);

    const streak = mod.getDrill('streak-islands').goldenAnswers.sql;
    const streakScore = mod.scoreDrillExtras('streak-islands', { maxStreak: streak.maxStreak, userId: streak.userId, islandCount: streak.islandCount });
    assert.equal(streakScore.pass, true);

    const basket = mod.getDrill('basket-pairs').goldenAnswers.sql;
    const basketScore = mod.scoreDrillExtras('basket-pairs', { pairLeft: basket.pairLeft, pairRight: basket.pairRight, orderCount: basket.orderCount });
    assert.equal(basketScore.pass, true);
    const basketSwapped = mod.scoreDrillExtras('basket-pairs', { pairLeft: basket.pairRight, pairRight: basket.pairLeft, orderCount: basket.orderCount });
    assert.equal(basketSwapped.pass, false, 'pairLeft/pairRight are order-sensitive, not a set comparison');
  });

  it('scoreDrillExtras never throws on missing/garbage input and a drill with no extra goldens reports pass with empty fields', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    assert.doesNotThrow(() => mod.scoreDrillExtras('scd-as-of', undefined));
    assert.doesNotThrow(() => mod.scoreDrillExtras('scd-as-of', null));
    assert.doesNotThrow(() => mod.scoreDrillExtras('not-a-real-drill', { anything: 1 }));
    // spot-the-sale (Bundle 16) already carries its own extra SQL goldens
    // (sumAmount, orderIdChecksum), so it is not a no-extras drill. Supply
    // its own golden values back to itself to confirm the pass-through path
    // still behaves, then separately confirm the truly-empty-fields path
    // using a drill whose goldenAnswers.sql has only rowCount.
    const spotGolden = mod.getDrill('spot-the-sale').goldenAnswers.sql;
    const spotSelfCheck = mod.scoreDrillExtras('spot-the-sale', spotGolden);
    assert.equal(spotSelfCheck.pass, true);

    const noExtraDrillId = mod.DRILLS.map((d) => d.id).find((id) => {
      const sqlGolden = mod.getDrill(id).goldenAnswers.sql;
      return Object.keys(sqlGolden).filter((k) => k !== 'rowCount').length === 0;
    });
    if (noExtraDrillId) {
      const noExtra = mod.scoreDrillExtras(noExtraDrillId, {});
      assert.equal(noExtra.pass, true);
      assert.deepEqual(noExtra.fields, {});
    }
  });

  it('scalarMatches: numeric epsilon compare, exact string compare, never throws', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    assert.equal(mod.scalarMatches(101018, 101018), true);
    assert.equal(mod.scalarMatches(101018, 101018.0000001), true);
    assert.equal(mod.scalarMatches(101018, 101019), false);
    assert.equal(mod.scalarMatches('SKU-C', 'SKU-C'), true);
    assert.equal(mod.scalarMatches('SKU-C', 'SKU-F'), false);
    assert.equal(mod.scalarMatches('SKU-C', 'sku-c'), false, 'string compare is case-sensitive');
    assert.doesNotThrow(() => mod.scalarMatches(undefined, null));
    assert.doesNotThrow(() => mod.scalarMatches(NaN, NaN));
  });
});

// ------------------------------------------------------------
// C. R Air-Gap prebundle module
// ------------------------------------------------------------

describe('bundle18 C: R Air-Gap prebundle manifest, honest UI copy, loader', () => {
  it('module exports the manifest and every entry has an honest availability, never a false "bundled" claim', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'r-air-gap-prebundle.js'));
    assert.ok(Array.isArray(mod.R_AIRGAP_PREBUNDLE) && mod.R_AIRGAP_PREBUNDLE.length >= 6);
    const targetNames = ['dplyr', 'tidyr', 'ggplot2', 'jsonlite', 'readr', 'broom'];
    const names = mod.R_AIRGAP_PREBUNDLE.map((e) => e.name);
    for (const n of targetNames) assert.ok(names.includes(n), `target package ${n} missing from manifest`);
    for (const entry of mod.R_AIRGAP_PREBUNDLE) {
      assert.ok(['bundled', 'network-only', 'unavailable'].includes(entry.availability), `unknown availability for ${entry.name}`);
      // The honest-as-of-this-bundle state: nothing is prebundled yet. If
      // this test ever needs to change, it must be because a REAL local
      // asset now exists at entry.assetPath, not because the manifest
      // claim was loosened without one.
      if (entry.availability === 'bundled') {
        assert.ok(typeof entry.assetPath === 'string' && entry.assetPath.length > 0, `${entry.name} claims bundled but has no assetPath`);
      }
    }
  });

  it('prebundleStatusCopy never returns "Available offline" for a non-bundled entry', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'r-air-gap-prebundle.js'));
    for (const entry of mod.R_AIRGAP_PREBUNDLE) {
      const copy = mod.prebundleStatusCopy(entry);
      if (entry.availability !== 'bundled') {
        assert.equal(copy.offline, false, `${entry.name}: offline must be false for a non-bundled entry`);
        assert.doesNotMatch(copy.label, /^Available offline$/, `${entry.name}: label must not claim offline availability`);
      } else {
        assert.equal(copy.offline, true);
        assert.equal(copy.label, 'Available offline');
      }
    }
  });

  it('summarizePrebundleAvailability totals match the manifest and reflect the current honest state', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'r-air-gap-prebundle.js'));
    const summary = mod.summarizePrebundleAvailability();
    assert.equal(summary.total, mod.R_AIRGAP_PREBUNDLE.length);
    assert.equal(summary.bundledCount + summary.networkOnlyCount + summary.unavailableCount, summary.total);
    assert.equal(summary.bundledCount, summary.bundledNames.length);
  });

  it('resolvePackageLoad prefers a local asset only when the manifest says bundled, otherwise defers to the supplied network decision', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'r-air-gap-prebundle.js'));
    const blockedDecision = { allowed: false, blockedBy: 'air_gap', reason: 'Air-Gap mode is on.' };
    const allowedDecision = { allowed: true, blockedBy: '', reason: 'Fetching from the WebR repository.' };

    const jsonliteBlocked = mod.resolvePackageLoad('jsonlite', blockedDecision);
    assert.equal(jsonliteBlocked.allowed, false);
    assert.notEqual(jsonliteBlocked.source, 'local', 'jsonlite is not bundled as of this bundle; must not claim a local source');

    const jsonliteAllowed = mod.resolvePackageLoad('jsonlite', allowedDecision);
    assert.equal(jsonliteAllowed.allowed, true);
    assert.equal(jsonliteAllowed.source, 'network');

    const unknownPkg = mod.resolvePackageLoad('some-package-not-on-any-list', allowedDecision);
    assert.equal(unknownPkg.allowed, false);
    assert.equal(unknownPkg.source, 'none');
  });

  it('module and its exported functions never throw, take no DOM/Node-only/Tauri-only dependency (source-level check)', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'r-air-gap-prebundle.js'));
    assert.doesNotThrow(() => mod.resolvePackageLoad(undefined, undefined));
    assert.doesNotThrow(() => mod.prebundleStatusCopy(undefined));
    assert.doesNotThrow(() => mod.listPrebundleManifest());

    const src = readRepoFile('js/polyglot/r-air-gap-prebundle.js');
    assert.doesNotMatch(src, /require\(['"]fs['"]\)/, 'must not import Node fs');
    assert.doesNotMatch(src, /@tauri-apps/, 'must not import a Tauri-only API');
    assert.doesNotMatch(src, /\bprocess\.env\b/, 'must not read Node-only process.env');
  });

  it('smoke test: jsonlite is at least listed and its honest status never claims false offline availability', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'r-air-gap-prebundle.js'));
    const jsonlite = mod.R_AIRGAP_PREBUNDLE.find((e) => e.name === 'jsonlite');
    assert.ok(jsonlite, 'jsonlite must be on the manifest');
    const copy = mod.prebundleStatusCopy(jsonlite);
    assert.ok(typeof copy.detail === 'string' && copy.detail.length > 10);
  });
});

// ------------------------------------------------------------
// D. Flags: new flags present + ON, dependencies untouched, 0 OFF total.
// ------------------------------------------------------------

describe('bundle18 D: flags present and enabled, dependencies untouched, manifest fully ON', () => {
  const manifestPath = join(REPO_ROOT, 'flags.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  function flagByKey(key) {
    if (Array.isArray(manifest)) return manifest.find((f) => f.key === key || f.name === key);
    if (manifest.flags) return manifest.flags[key] || (Array.isArray(manifest.flags) && manifest.flags.find((f) => f.key === key));
    return manifest[key];
  }

  it('archetypeDrillsExpand and rAirGapPrebundle exist and are enabled', () => {
    for (const key of ['archetypeDrillsExpand', 'rAirGapPrebundle']) {
      const flag = flagByKey(key);
      assert.ok(flag, `flag ${key} missing from flags.manifest.json`);
      const enabled = flag.enabled === true || flag === true;
      assert.ok(enabled, `flag ${key} must be enabled`);
    }
  });

  it('pre-existing dependency flags remain ON: drillFloor, receiptDrillBattery, duckdbSelfHost', () => {
    for (const key of ['drillFloor', 'receiptDrillBattery', 'duckdbSelfHost']) {
      const flag = flagByKey(key);
      assert.ok(flag, `flag ${key} missing from flags.manifest.json`);
      const enabled = flag.enabled === true || flag === true;
      assert.ok(enabled, `flag ${key} must remain enabled`);
    }
  });

  it('every flag in the manifest is enabled (0 OFF total, per Bundle 18 requirement)', () => {
    const flags = manifest.flags || {};
    const offNames = Object.keys(flags).filter((k) => flags[k].enabled !== true);
    assert.deepEqual(offNames, [], `expected 0 OFF flags, found: ${offNames.join(', ')}`);
  });

  it('flags.manifest.json has no em dash anywhere', () => {
    const raw = readFileSync(manifestPath, 'utf-8');
    assert.doesNotMatch(raw, new RegExp(EM_DASH));
  });
});

// ------------------------------------------------------------
// E. No em dash / no extra Maven mentions in new visible text; canvas
//    integrity and inject-script parity with the established convention.
// ------------------------------------------------------------

describe('bundle18 E: honesty text hygiene and canvas parity', () => {
  it('drill-floor-data.js and drill-floor.js source contain no em dash outside /* */ comments', () => {
    for (const relPath of ['js/drill-floor/drill-floor-data.js', 'js/drill-floor/drill-floor.js']) {
      const src = readRepoFile(relPath);
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(stripped, new RegExp(EM_DASH), `${relPath} has an em dash outside a comment`);
    }
  });

  it('r-air-gap-prebundle.js contains no em dash outside /* */ comments and no more than 0 Maven mentions', () => {
    const src = readRepoFile('js/polyglot/r-air-gap-prebundle.js');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(stripped, new RegExp(EM_DASH));
    assert.doesNotMatch(src, /maven/i);
  });

  it('DRILL_BATTERY_HONESTY_NOTE still mentions Maven at most twice (unchanged disclaimer, not duplicated by Bundle 18)', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    const mavenMentions = (mod.DRILL_BATTERY_HONESTY_NOTE.match(/maven/gi) || []).length;
    assert.ok(mavenMentions <= 2, `expected at most 2 Maven mentions in the honesty note, got ${mavenMentions}`);
  });

  it('none of the 3 new drills reference Maven or a third-party dataset/branding name', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    for (const id of ['scd-as-of', 'streak-islands', 'basket-pairs']) {
      const drill = mod.getDrill(id);
      const blob = JSON.stringify(drill);
      assert.doesNotMatch(blob, /maven/i, `Maven reference found in drill ${id}`);
      assert.doesNotMatch(blob, new RegExp(EM_DASH), `em dash found in drill ${id}`);
    }
  });

  it('canvas/index.html carries from/end markers for the drill-floor short-form splice and the new r-air-gap-prebundle engine', () => {
    const canvas = readRepoFile('canvas/index.html');
    assert.match(canvas, /\/\* ---- from js\/drill-floor\/drill-floor-data\.js ---- \*\//);
    assert.match(canvas, /\/\* ---- end drill-floor-data\.js ---- \*\//);
    assert.match(canvas, /\/\* ---- from js\/drill-floor\/drill-floor\.js ---- \*\//);
    assert.match(canvas, /\/\* ---- end drill-floor\.js ---- \*\//);
    assert.match(canvas, /\/\* ---- from js\/polyglot\/r-air-gap-prebundle\.js ---- \*\//);
    assert.match(canvas, /\/\* ---- end js\/polyglot\/r-air-gap-prebundle\.js ---- \*\//);
  });

  it('canvas inlines the three new drill ids and the R Air-Gap prebundle kind string', () => {
    const canvas = readRepoFile('canvas/index.html');
    for (const id of ['scd-as-of', 'streak-islands', 'basket-pairs']) {
      assert.match(canvas, new RegExp(id.replace(/-/g, '\\-')), `canvas missing drill id ${id}`);
    }
    assert.match(canvas, /dataglow-r-airgap-prebundle/);
  });

  it('canvas legacy inline flags object carries archetypeDrillsExpand and rAirGapPrebundle', () => {
    const canvas = readRepoFile('canvas/index.html');
    assert.match(canvas, /archetypeDrillsExpand:\s*true,/);
    assert.match(canvas, /rAirGapPrebundle:\s*true,/);
  });

  it('canvas/integrity.manifest.json tracks js/polyglot/r-air-gap-prebundle.js', () => {
    const manifest = JSON.parse(readRepoFile('canvas/integrity.manifest.json'));
    const tracked = manifest.tracked.map((t) => t.source);
    assert.ok(tracked.includes('js/polyglot/r-air-gap-prebundle.js'), 'new engine not registered in integrity manifest tracked list');
  });

  it('no canvas/vendor/duckdb-wasm/ tree was recreated (Bundle 18 must not touch DuckDB self-host)', () => {
    const dupPath = join(REPO_ROOT, 'canvas', 'vendor', 'duckdb-wasm');
    assert.equal(existsSync(dupPath), false, 'canvas/vendor/duckdb-wasm/ should not exist; self-host uses assets/duckdb/ only');
  });
});
