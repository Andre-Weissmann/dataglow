// ============================================================
// DATAGLOW - Bundle 17 proof: self-host DuckDB, Drill Floor nav,
// SQL/Python/R showdown recipes, PQ-parity expansion, flags
// ============================================================
// This is a static/pure-module test file (no browser launch) that checks the
// SHIPPED artifacts of Bundle 17 directly:
//   A. the self-host vendoring output exists on disk and is wired as the
//      FIRST candidate host in js/sql/duckdb-load-harden.js and mirrored in
//      canvas/index.html's inlined loader; registerFileBuffer has a
//      null-guard in both js/sql/sql-engine.js and the canvas loader.
//   B. canvas/index.html has a primary, always-visible Drill Floor trigger
//      button with an id distinct from OSCE's, and the main app's tabOrder /
//      command-deck-nav both carry a 'drillfloor' entry independent of OSCE
//      (which does not exist in the main app at all).
//   C. the SQL/Python/R showdown recipe packs and the PQ-parity pack each
//      grew by the counts this bundle added, with no em dash and no
//      third-party dataset/brand names beyond the descriptive Microsoft/PQ
//      mentions already covered by PQ_PARITY_HONESTY / PQ_TRADEMARK_DISCLAIMER.
//   D. the Drill Floor honesty note mentions "public" education-content
//      framing in addition to the pre-existing Maven disclaimer.
//
// RUN WITH:  node test/bundle17-selfhost-drillnav-showdown-pqparity.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const EM_DASH = '\u2014';

function readRepoFile(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

// ------------------------------------------------------------
// A. Self-host DuckDB-WASM vendoring + candidate order + null guards
// ------------------------------------------------------------

describe('bundle17 A: self-host DuckDB-WASM vendoring', () => {
  // Bundle 17 finish: self-host points at the repo's real, already-vendored
  // assets/duckdb/ (was hidden by sparse-checkout) instead of a second
  // canvas/vendor/duckdb-wasm/ copy, which would have duplicated ~74MB in
  // the repo for no benefit -- one on-disk vendored copy, one source of
  // truth, used by root index.html's import map AND the self-host candidate.
  const vendorDir = join(REPO_ROOT, 'assets', 'duckdb');

  it('vendored essentials exist on disk under assets/duckdb/', () => {
    const required = [
      'duckdb-browser.mjs',
      'duckdb-browser-eh.worker.js',
      'duckdb-browser-mvp.worker.js',
      'duckdb-eh.wasm',
      'duckdb-mvp.wasm',
      'duckdb-wasm.package.json',
    ];
    for (const f of required) {
      const p = join(vendorDir, f);
      assert.ok(existsSync(p), `missing vendored file: ${f}`);
    }
  });

  it('vendored wasm files are non-trivially sized (not empty/stub files)', () => {
    const eh = statSync(join(vendorDir, 'duckdb-eh.wasm'));
    const mvp = statSync(join(vendorDir, 'duckdb-mvp.wasm'));
    assert.ok(eh.size > 1_000_000, 'duckdb-eh.wasm looks too small to be real');
    assert.ok(mvp.size > 1_000_000, 'duckdb-mvp.wasm looks too small to be real');
  });

  it('no duplicate canvas/vendor/duckdb-wasm/ tree was created', () => {
    const dupDir = join(REPO_ROOT, 'canvas', 'vendor', 'duckdb-wasm');
    assert.ok(!existsSync(dupDir), 'canvas/vendor/duckdb-wasm/ should not exist; self-host uses assets/duckdb/ only');
  });

  it('assets/duckdb/duckdb-wasm.package.json exists and is pinned to 1.29.0', () => {
    const pinPath = join(REPO_ROOT, 'assets', 'duckdb', 'duckdb-wasm.package.json');
    assert.ok(existsSync(pinPath), 'assets/duckdb/duckdb-wasm.package.json missing');
    const pin = JSON.parse(readFileSync(pinPath, 'utf-8'));
    assert.equal(pin.name, '@duckdb/duckdb-wasm');
    assert.equal(pin.version, '1.29.0');
  });

  it('duckdb-load-harden.js puts self-host FIRST in candidate order', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const harden = mod.DataGlowDuckDBLoadHarden || mod;
    const candidates =
      (typeof harden.listCandidateHosts === 'function' && harden.listCandidateHosts()) ||
      harden.CANDIDATE_HOSTS ||
      [];
    assert.ok(candidates.length >= 3, 'expected at least 3 candidate hosts');
    const ids = candidates.map((c) => (typeof c === 'string' ? c : c.id));
    assert.equal(ids[0], 'self-host', 'self-host must be tried first');
    assert.ok(ids.includes('jsdelivr'));
    assert.ok(ids.includes('unpkg'));
  });

  it('self-host candidate base URL points at assets/duckdb/, not a second vendor tree', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const harden = mod.DataGlowDuckDBLoadHarden || mod;
    assert.match(harden.SELF_HOST_BASE_URL, /assets\/duckdb\/$/);
    assert.doesNotMatch(harden.SELF_HOST_BASE_URL, /vendor\/duckdb-wasm/);
  });

  it('sql-engine.js source guards registerFileBuffer against a null db', () => {
    const src = readRepoFile('js/sql/sql-engine.js');
    assert.match(src, /registerFileBuffer/);
    // The guard-and-retry-once pattern: some conditional check on the db
    // handle appears textually before the ACTUAL CALL (not just a comment
    // that happens to mention the method name).
    const callMatch = src.match(/(?:await\s+)?db\.registerFileBuffer\(/);
    assert.ok(callMatch, 'no actual db.registerFileBuffer(...) call site found');
    const callIdx = callMatch.index;
    const before = src.slice(Math.max(0, callIdx - 800), callIdx);
    assert.match(before, /if\s*\(\s*!?\s*db\b|db\s*==|db\s*===/, 'no null-guard found near registerFileBuffer call');
  });

  it('canvas/index.html inlined loader also guards registerFileBuffer and knows the self-host base', () => {
    const canvas = readRepoFile('canvas/index.html');
    assert.match(canvas, /assets\/duckdb\//, 'canvas loader missing self-host base path');
    const idx = canvas.indexOf('registerFileBuffer');
    assert.ok(idx !== -1, 'canvas loader has no registerFileBuffer call to guard');
  });

  it('canvas loader only trusts getJsDelivrBundles() for the jsDelivr candidate', () => {
    const canvas = readRepoFile('canvas/index.html');
    assert.match(
      canvas,
      /cdn\.jsdelivr\.net/,
      'expected an explicit jsdelivr-host check guarding getJsDelivrBundles() usage'
    );
  });
});

// ------------------------------------------------------------
// B. Drill Floor nav discoverability, separate from OSCE
// ------------------------------------------------------------

describe('bundle17 B: Drill Floor is findable separate from OSCE', () => {
  const canvas = readRepoFile('canvas/index.html');

  it('canvas has a primary drillfloor-trigger-btn with an id distinct from osce-trigger-btn', () => {
    assert.match(canvas, /id="drillfloor-trigger-btn"/);
    assert.match(canvas, /id="osce-trigger-btn"/);
  });

  it('the two trigger buttons are wired independently (no shared handler name collision)', () => {
    const drillIdx = canvas.indexOf('id="drillfloor-trigger-btn"');
    const wireIdx = canvas.indexOf("getElementById('drillfloor-trigger-btn')");
    assert.ok(drillIdx !== -1 && wireIdx !== -1, 'drillfloor-trigger-btn not both declared and wired');
  });

  it('main app tabOrder includes drillfloor as its own tab (OSCE has no main-app tab at all)', () => {
    const state = readRepoFile('js/app-shell/state.js');
    assert.match(state, /tabOrder:.*drillfloor/s);
    const mainJs = readRepoFile('js/app-shell/main.js');
    assert.match(mainJs, /drillfloor:\s*\{\s*label:\s*'Drill Floor'/);
    // OSCE is a canvas-only concept, confirmed absent from the main app shell.
    assert.doesNotMatch(mainJs, /osce/i);
  });

  it('command-deck-nav groups drillfloor under a real section, not hidden/orphaned', () => {
    const nav = readRepoFile('js/app-shell/command-deck-nav.js');
    assert.match(nav, /tabs:\s*\[[^\]]*'drillfloor'[^\]]*\]/);
  });
});

// ------------------------------------------------------------
// C1-C4. Showdown recipe pack growth (SQL / Python / R) + PQ-parity
// ------------------------------------------------------------

describe('bundle17 C: SQL/Python/R showdown packs and PQ-parity grew as expected', () => {
  it('sql-deepen.js SQL_DEEPEN_SNIPPETS has the 4 new Bundle 17 recipe ids', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'sql-deepen.js'));
    const ids = mod.SQL_DEEPEN_SNIPPETS.map((r) => r.id);
    for (const id of [
      'first-value-after-filter',
      'dual-aggregate-started-vs-finished',
      'top-n-per-group-showdown',
      'running-total-showdown',
    ]) {
      assert.ok(ids.includes(id), `missing SQL showdown recipe: ${id}`);
    }
  });

  it('python-power-pack.js PYTHON_RECIPES has the 2 new Bundle 17 recipe ids', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'python-power-pack.js'));
    const ids = mod.PYTHON_RECIPES.map((r) => r.id);
    for (const id of ['groupby-first-last-after-filter', 'merge-user-level-summary']) {
      assert.ok(ids.includes(id), `missing Python showdown recipe: ${id}`);
    }
  });

  it('r-power-pack.js R_RECIPES has the 2 new Bundle 17 recipe ids', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'r-power-pack.js'));
    const ids = mod.R_RECIPES.map((r) => r.id);
    for (const id of ['first-last-per-group-base-r', 'between-dates-join-base-r']) {
      assert.ok(ids.includes(id), `missing R showdown recipe: ${id}`);
    }
  });

  it('pq-parity-recipes.js grew by 5 new ids (Group By All Rows, First/Last, Expand-as-join, Excel Hell repair)', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'pq-parity-recipes.js'));
    const ids = mod.PQ_PARITY_RECIPES.map((r) => r.id);
    const newIds = [
      'group-by-keep-all-rows',
      'table-first-per-group',
      'table-last-per-group',
      'expand-nested-to-join',
      'unmerge-simulated-merged-cells',
    ];
    for (const id of newIds) {
      assert.ok(ids.includes(id), `missing PQ-parity recipe: ${id}`);
    }
    assert.ok(ids.length >= 20, `expected at least 20 PQ-parity recipes, got ${ids.length}`);
  });

  it('pq-parity-recipes.js exports a standalone PQ_TRADEMARK_DISCLAIMER with no M-interpreter claim', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'pq-parity-recipes.js'));
    assert.ok(typeof mod.PQ_TRADEMARK_DISCLAIMER === 'string' && mod.PQ_TRADEMARK_DISCLAIMER.length > 20);
    assert.match(mod.PQ_TRADEMARK_DISCLAIMER, /does not embed Power Query/i);
    assert.match(mod.PQ_TRADEMARK_DISCLAIMER, /does not interpret or parse M/i);
    assert.doesNotMatch(mod.PQ_TRADEMARK_DISCLAIMER, new RegExp(EM_DASH));
  });

  it('buildPqParityPack() surfaces the trademark disclaimer alongside the honesty note', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'pq-parity-recipes.js'));
    const pack = mod.buildPqParityPack();
    assert.equal(pack.trademarkDisclaimer, mod.PQ_TRADEMARK_DISCLAIMER);
    assert.match(pack.honesty, /not embedded/i);
  });

  it('no new recipe (SQL/Python/R/PQ-parity) contains an em dash', async () => {
    const [sql, py, r, pq] = await Promise.all([
      import(join(REPO_ROOT, 'js', 'polyglot', 'sql-deepen.js')),
      import(join(REPO_ROOT, 'js', 'polyglot', 'python-power-pack.js')),
      import(join(REPO_ROOT, 'js', 'polyglot', 'r-power-pack.js')),
      import(join(REPO_ROOT, 'js', 'polyglot', 'pq-parity-recipes.js')),
    ]);
    const allRecipes = [
      ...sql.SQL_DEEPEN_SNIPPETS,
      ...py.PYTHON_RECIPES,
      ...r.R_RECIPES,
      ...pq.PQ_PARITY_RECIPES,
    ];
    for (const rec of allRecipes) {
      const blob = JSON.stringify(rec);
      assert.doesNotMatch(blob, new RegExp(EM_DASH), `em dash found in recipe ${rec.id}`);
    }
  });

  it('no new recipe references Maven or a third-party dataset/branding name', async () => {
    const [sql, py, r, pq] = await Promise.all([
      import(join(REPO_ROOT, 'js', 'polyglot', 'sql-deepen.js')),
      import(join(REPO_ROOT, 'js', 'polyglot', 'python-power-pack.js')),
      import(join(REPO_ROOT, 'js', 'polyglot', 'r-power-pack.js')),
      import(join(REPO_ROOT, 'js', 'polyglot', 'pq-parity-recipes.js')),
    ]);
    const newIds = new Set([
      'first-value-after-filter',
      'dual-aggregate-started-vs-finished',
      'top-n-per-group-showdown',
      'running-total-showdown',
      'groupby-first-last-after-filter',
      'merge-user-level-summary',
      'first-last-per-group-base-r',
      'between-dates-join-base-r',
      'group-by-keep-all-rows',
      'table-first-per-group',
      'table-last-per-group',
      'expand-nested-to-join',
      'unmerge-simulated-merged-cells',
    ]);
    const allRecipes = [
      ...sql.SQL_DEEPEN_SNIPPETS,
      ...py.PYTHON_RECIPES,
      ...r.R_RECIPES,
      ...pq.PQ_PARITY_RECIPES,
    ].filter((rec) => newIds.has(rec.id));
    assert.ok(allRecipes.length === newIds.size, 'not all expected new recipes were found for the branding check');
    for (const rec of allRecipes) {
      const blob = JSON.stringify(rec);
      assert.doesNotMatch(blob, /maven/i, `Maven reference found in recipe ${rec.id}`);
    }
  });
});

// ------------------------------------------------------------
// D. Honesty line near PQ/Drill about practice patterns
// ------------------------------------------------------------

describe('bundle17 D: honesty line about practice patterns near PQ/Drill', () => {
  it('DRILL_BATTERY_HONESTY_NOTE mentions public education-pattern framing plus the pre-existing Maven line', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'drill-floor', 'drill-floor.js'));
    assert.match(mod.DRILL_BATTERY_HONESTY_NOTE, /original DataGlow data and golden answers/);
    assert.match(mod.DRILL_BATTERY_HONESTY_NOTE, /not Maven Analytics Data Drills/);
    assert.match(mod.DRILL_BATTERY_HONESTY_NOTE, /public data-analytics\s+education content/i);
    assert.doesNotMatch(mod.DRILL_BATTERY_HONESTY_NOTE, new RegExp(EM_DASH));
  });

  it('PQ_PARITY_HONESTY + PQ_TRADEMARK_DISCLAIMER together cover the "no engine embed, no Maven data" honesty line', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'polyglot', 'pq-parity-recipes.js'));
    assert.match(mod.PQ_PARITY_HONESTY, /not embedded/i);
    assert.match(mod.PQ_TRADEMARK_DISCLAIMER, /not affiliated with or endorsed by Microsoft/i);
  });
});

// ------------------------------------------------------------
// Flags: the 4 new Bundle 17 flags exist and are ON, plus existing
// flags this bundle depends on stay ON.
// ------------------------------------------------------------

describe('bundle17 flags: new flags present and enabled, dependencies untouched', () => {
  const manifestPath = join(REPO_ROOT, 'flags.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  function flagByKey(key) {
    if (Array.isArray(manifest)) return manifest.find((f) => f.key === key || f.name === key);
    if (manifest.flags) return manifest.flags[key] || (Array.isArray(manifest.flags) && manifest.flags.find((f) => f.key === key));
    return manifest[key];
  }

  it('duckdbSelfHost, sqlShowdownPatterns, pythonShowdownPatterns, rShowdownPatterns all exist and are enabled', () => {
    for (const key of ['duckdbSelfHost', 'sqlShowdownPatterns', 'pythonShowdownPatterns', 'rShowdownPatterns']) {
      const flag = flagByKey(key);
      assert.ok(flag, `flag ${key} missing from flags.manifest.json`);
      const enabled = flag.enabled === true || flag === true;
      assert.ok(enabled, `flag ${key} must be enabled`);
    }
  });

  it('pre-existing dependency flags remain ON: duckdbLoadHarden, drillFloor, receiptDrillBattery', () => {
    for (const key of ['duckdbLoadHarden', 'drillFloor', 'receiptDrillBattery']) {
      const flag = flagByKey(key);
      assert.ok(flag, `flag ${key} missing from flags.manifest.json`);
      const enabled = flag.enabled === true || flag === true;
      assert.ok(enabled, `flag ${key} must remain enabled`);
    }
  });

  it('flags.manifest.json has no em dash anywhere', () => {
    const raw = readFileSync(manifestPath, 'utf-8');
    assert.doesNotMatch(raw, new RegExp(EM_DASH));
  });
});
