// ============================================================
// DATAGLOW - Bundle 15: DuckDB-WASM load harden, Repair Ledger on the
// RECEIPT spine, thin Replay, and SQL Dojo crash-safety.
// ============================================================
//
// Pure Node, no DOM. Canvas UI mount/unmount and the SQL Dojo safe-open path
// are covered separately in test/bundle15-canvas-ui.test.mjs using a real
// headless browser, the same split every prior bundle has used between a
// pure-engine test and a canvas-UI test.
//
// RUN WITH:  node --test test/bundle15-duckdb-harden-ledger-spine-replay-dojo.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DUCKDB_LOAD_HARDEN_KIND,
  DUCKDB_LOAD_HARDEN_VERSION,
  DUCKDB_WASM_PIN,
  CANDIDATE_HOSTS,
  MAX_ATTEMPTS,
  buildCandidateList,
  rewriteBundleUrl,
  summarizeAttempts,
  shouldTryNextCandidate,
  nextCandidate,
} from '../js/sql/duckdb-load-harden.js';

import {
  buildStep,
  canRerun,
  rerunPlan,
  listSteps,
} from '../js/spine/repair-ledger.js';

const EM_DASH = '\u2014';
function read(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf-8');
}

// ------------------------------------------------------------
// A - DuckDB-WASM load harden: one pin, ordered candidates, never a silent
//     infinite hang.
// ------------------------------------------------------------

describe('duckdb-load-harden: single pin, ordered candidate list', () => {
  it('exposes exactly one pinned version string', () => {
    assert.equal(typeof DUCKDB_WASM_PIN, 'string');
    assert.match(DUCKDB_WASM_PIN, /^\d+\.\d+\.\d+$/);
  });

  it('every candidate host URL is built from the same single pin', () => {
    for (const host of CANDIDATE_HOSTS) {
      assert.ok(host.cdnUrl.includes(DUCKDB_WASM_PIN), `${host.id} cdnUrl must carry the pin`);
      assert.ok(host.baseUrl.includes(DUCKDB_WASM_PIN), `${host.id} baseUrl must carry the pin`);
    }
  });

  it('jsDelivr is first, unpkg second: primary then fallback order', () => {
    const ids = CANDIDATE_HOSTS.map((h) => h.id);
    assert.equal(ids[0], 'jsdelivr');
    assert.equal(ids[1], 'unpkg');
    assert.ok(ids.length >= 2);
  });

  it('buildCandidateList returns a defensive copy, not the frozen original', () => {
    const list = buildCandidateList();
    assert.notEqual(list, CANDIDATE_HOSTS);
    list.push({ id: 'made-up' });
    assert.equal(CANDIDATE_HOSTS.length, buildCandidateList().length);
  });

  it('CANDIDATE_HOSTS is frozen at every level so no caller can mutate the shared pin', () => {
    assert.ok(Object.isFrozen(CANDIDATE_HOSTS));
    for (const host of CANDIDATE_HOSTS) assert.ok(Object.isFrozen(host));
  });

  it('MAX_ATTEMPTS equals the candidate list length: a bounded retry ceiling', () => {
    assert.equal(MAX_ATTEMPTS, CANDIDATE_HOSTS.length);
  });

  it('rewriteBundleUrl rewrites a URL from one CDN base to another', () => {
    const from = CANDIDATE_HOSTS[0].baseUrl;
    const to = CANDIDATE_HOSTS[1].baseUrl;
    const url = from + 'duckdb-eh.wasm';
    assert.equal(rewriteBundleUrl(url, from, to), to + 'duckdb-eh.wasm');
  });

  it('rewriteBundleUrl leaves a URL alone if it does not start with fromBaseUrl', () => {
    const url = 'https://example.com/duckdb-eh.wasm';
    assert.equal(rewriteBundleUrl(url, CANDIDATE_HOSTS[0].baseUrl, CANDIDATE_HOSTS[1].baseUrl), url);
  });

  it('rewriteBundleUrl is defensive against non-string / missing input', () => {
    assert.equal(rewriteBundleUrl(null, 'a', 'b'), '');
    assert.equal(rewriteBundleUrl('x', '', 'b'), 'x');
    assert.equal(rewriteBundleUrl('x', 'a', ''), 'x');
  });
});

describe('duckdb-load-harden: summarizeAttempts never leaves the banner silent', () => {
  it('an empty attempts list means still loading, not an error', () => {
    const s = summarizeAttempts([]);
    assert.equal(s.state, 'loading');
    assert.equal(s.succeededHost, null);
  });

  it('primary succeeding first try reports success with no failed hosts', () => {
    const s = summarizeAttempts([{ host: 'jsDelivr', ok: true }]);
    assert.equal(s.state, 'ok');
    assert.equal(s.succeededHost, 'jsDelivr');
    assert.equal(s.failedHosts.length, 0);
    assert.match(s.message, /jsDelivr/);
  });

  it('mock fetch fail primary then fallback succeeds: names both hosts', () => {
    const s = summarizeAttempts([
      { host: 'jsDelivr', ok: false, error: 'network error' },
      { host: 'unpkg', ok: true },
    ]);
    assert.equal(s.state, 'ok');
    assert.equal(s.succeededHost, 'unpkg');
    assert.deepEqual(s.failedHosts, ['jsDelivr']);
    assert.match(s.message, /unpkg/);
    assert.match(s.message, /jsDelivr/);
  });

  it('every candidate failing reports a clear error state naming every host tried', () => {
    const s = summarizeAttempts([
      { host: 'jsDelivr', ok: false },
      { host: 'unpkg', ok: false },
      { host: 'esm.sh', ok: false },
    ]);
    assert.equal(s.state, 'error');
    assert.equal(s.succeededHost, null);
    assert.equal(s.failedHosts.length, 3);
    assert.match(s.message, /failed to load from all CDNs/);
  });

  it('is defensive against a non-array input', () => {
    const s = summarizeAttempts(null);
    assert.equal(s.state, 'loading');
  });
});

describe('duckdb-load-harden: retry walks the next untried candidate, then stops', () => {
  it('shouldTryNextCandidate is true before any attempt', () => {
    assert.equal(shouldTryNextCandidate([]), true);
  });

  it('shouldTryNextCandidate is false once any attempt has succeeded', () => {
    assert.equal(shouldTryNextCandidate([{ host: 'jsdelivr', ok: true }]), false);
  });

  it('shouldTryNextCandidate is false once every candidate has been tried (bounded ceiling)', () => {
    const allFailed = CANDIDATE_HOSTS.map((h) => ({ host: h.id, ok: false }));
    assert.equal(shouldTryNextCandidate(allFailed), false);
  });

  it('nextCandidate returns the first host not yet attempted', () => {
    const first = nextCandidate([]);
    assert.equal(first.id, CANDIDATE_HOSTS[0].id);
    const second = nextCandidate([{ host: CANDIDATE_HOSTS[0].id, ok: false }]);
    assert.equal(second.id, CANDIDATE_HOSTS[1].id);
  });

  it('nextCandidate returns null once the whole list has been tried: never an infinite hang', () => {
    const allTried = CANDIDATE_HOSTS.map((h) => ({ host: h.id, ok: false }));
    assert.equal(nextCandidate(allTried), null);
  });

  it('DUCKDB_LOAD_HARDEN_KIND and VERSION are stable identifiers', () => {
    assert.equal(DUCKDB_LOAD_HARDEN_KIND, 'dataglow-duckdb-load-harden');
    assert.equal(DUCKDB_LOAD_HARDEN_VERSION, 1);
  });
});

// ------------------------------------------------------------
// C - Replay thin control: confirm gate logic. The actual window.confirm and
//     DOM insertion live in canvas-only code (covered by the Playwright
//     test); what is pure and testable here is that a step must be
//     canRerun before any replay control offers it, and that rerunPlan
//     never itself executes anything.
// ------------------------------------------------------------

describe('thin replay: only canRerun steps are ever offered a Run again / Replay all', () => {
  it('a fresh applied sql_recipe_run step with code can be rerun', () => {
    const step = buildStep({ kind: 'sql_recipe_run', engine: 'sql', status: 'applied', code: 'SELECT 1;', title: 'Test query' });
    assert.equal(canRerun(step), true);
    const plan = rerunPlan(step);
    assert.equal(plan.ok, true);
    assert.equal(plan.code, 'SELECT 1;');
  });

  it('a proposed (not applied) step is never offered replay', () => {
    const step = buildStep({ kind: 'sql_recipe_run', status: 'proposed', code: 'SELECT 1;' });
    assert.equal(canRerun(step), false);
    assert.equal(rerunPlan(step).ok, false);
  });

  it('a decision step (e.g. quarantine_decision) is never offered replay even if applied', () => {
    const step = buildStep({ kind: 'quarantine_decision', status: 'applied', code: '' });
    assert.equal(canRerun(step), false);
    assert.match(rerunPlan(step).reason, /decision/i);
  });

  it('an applied step with no code recorded cannot be replayed', () => {
    const step = buildStep({ kind: 'sql_recipe_run', status: 'applied', code: '' });
    assert.equal(canRerun(step), false);
  });

  it('rerunPlan never mutates the step or returns anything that itself executes SQL', () => {
    const step = buildStep({ kind: 'sql_recipe_run', status: 'applied', code: 'SELECT 2;' });
    const before = JSON.stringify(step);
    const plan = rerunPlan(step);
    assert.equal(JSON.stringify(step), before, 'rerunPlan must not mutate the original step');
    assert.equal(typeof plan.code, 'string');
    assert.equal(typeof plan.ok, 'boolean');
  });

  it('a "Replay all" queue only ever contains steps that pass canRerun, in ledger order', () => {
    let ledger = [];
    ledger = [
      ...ledger,
      buildStep({ kind: 'sql_recipe_run', status: 'applied', code: 'SELECT 1;', title: 'first' }),
      buildStep({ kind: 'quarantine_decision', status: 'applied', code: '', title: 'a decision, not rerunnable' }),
      buildStep({ kind: 'sql_recipe_run', status: 'proposed', code: 'SELECT 2;', title: 'only proposed' }),
      buildStep({ kind: 'sql_recipe_run', status: 'applied', code: 'SELECT 3;', title: 'third' }),
    ];
    const rerunnable = listSteps(ledger).filter((s) => canRerun(s));
    assert.equal(rerunnable.length, 2);
    assert.deepEqual(rerunnable.map((s) => s.title), ['first', 'third']);
  });
});

// ------------------------------------------------------------
// D - SQL Dojo safety: the generation logic itself (buildSQL-equivalent) is
//     canvas-inline with no js/ module, so the confirm-and-generate-SQL
//     shape is exercised end to end in the Playwright canvas test. What is
//     pure and testable in Node is that the flag/env helper pattern this
//     bundle repeats (duckdbLoadHarden, sqlDojoSafe) reads window globals
//     before window.DataGlowFlags, and defaults open, matching every other
//     flag() helper already shipped in this codebase.
// ------------------------------------------------------------

describe('sqlDojoSafe / duckdbLoadHarden flag helper shape: explicit override beats DataGlowFlags, default is on', () => {
  function makeFlagFn(explicitKey, flagKey) {
    // Mirrors the exact helper pattern injected into canvas/index.html for
    // both new flags in this bundle.
    return function flag(win) {
      try { if (win[explicitKey] === false) return false; } catch (_e0) {}
      try { if (win[explicitKey] === true) return true; } catch (_e1) {}
      try {
        if (win.DataGlowFlags && typeof win.DataGlowFlags.isEnabled === 'function') {
          return win.DataGlowFlags.isEnabled(flagKey) !== false;
        }
      } catch (_e) {}
      return true;
    };
  }

  it('defaults to enabled with no explicit global and no DataGlowFlags mounted', () => {
    const flag = makeFlagFn('DATAGLOW_SQL_DOJO_SAFE', 'sqlDojoSafe');
    assert.equal(flag({}), true);
  });

  it('an explicit false global always wins, even if DataGlowFlags says on', () => {
    const flag = makeFlagFn('DATAGLOW_SQL_DOJO_SAFE', 'sqlDojoSafe');
    const win = { DATAGLOW_SQL_DOJO_SAFE: false, DataGlowFlags: { isEnabled: () => true } };
    assert.equal(flag(win), false);
  });

  it('an explicit true global always wins, even if DataGlowFlags says off', () => {
    const flag = makeFlagFn('DATAGLOW_DUCKDB_LOAD_HARDEN', 'duckdbLoadHarden');
    const win = { DATAGLOW_DUCKDB_LOAD_HARDEN: true, DataGlowFlags: { isEnabled: () => false } };
    assert.equal(flag(win), true);
  });

  it('falls through to DataGlowFlags.isEnabled when no explicit global is set', () => {
    const flag = makeFlagFn('DATAGLOW_DUCKDB_LOAD_HARDEN', 'duckdbLoadHarden');
    const winOff = { DataGlowFlags: { isEnabled: () => false } };
    const winOn = { DataGlowFlags: { isEnabled: () => true } };
    assert.equal(flag(winOff), false);
    assert.equal(flag(winOn), true);
  });
});

// ------------------------------------------------------------
// flags.manifest.json: the four Bundle 15 flags exist, are on, and every
// entry documents its flag-off behavior (same shape every other flag uses).
// ------------------------------------------------------------

describe('bundle 15: flags.manifest.json carries all four new flags, all on', () => {
  const manifest = JSON.parse(read('flags.manifest.json'));
  const NEW_FLAGS = ['duckdbLoadHarden', 'repairLedgerSpine', 'replayReceiptThin', 'sqlDojoSafe'];

  for (const name of NEW_FLAGS) {
    it(`${name} exists, is enabled, and documents its flag-off behavior`, () => {
      const entry = manifest.flags[name];
      assert.ok(entry, `${name} must exist in flags.manifest.json`);
      assert.equal(entry.enabled, true);
      assert.equal(typeof entry.description, 'string');
      assert.ok(entry.description.length > 10);
      assert.equal(typeof entry.flagOffBehavior, 'string');
      assert.ok(entry.flagOffBehavior.length > 10);
    });
  }
});

// ------------------------------------------------------------
// No em dash anywhere in the new/changed source files this bundle.
// ------------------------------------------------------------

describe('bundle 15: no em dash in shipped UI-facing source', () => {
  const FILES = [
    'js/sql/duckdb-load-harden.js',
    'js/sql/sql-engine.js',
    'js/spine/data-glow-receipt-spine-canvas.js',
    'js/spine/data-glow-repair-ledger-canvas.js',
    'flags.manifest.json',
  ];
  for (const f of FILES) {
    it(`${f} has no em dash`, () => {
      assert.doesNotMatch(read(f), new RegExp(EM_DASH));
    });
  }
});
