// ============================================================
// DATAGLOW — Dependency Freshness Ledger test suite
// ============================================================
// Unit-tests the pure scoring core in .github/scripts/dependency-freshness.mjs.
// Every input (package.json, lockfile, `npm outdated --json`, `npm audit --json`)
// is injected as a plain object, so the assertions are deterministic and never
// touch the network. Also does one smoke run against the REAL package.json to
// prove the builder executes cleanly on the actual manifest.
//
// RUN WITH:  node test/dependency-freshness.test.mjs
// Engine-free (no DuckDB, no network): the builder is pure data-in/data-out.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  buildLedger,
  parseVersion,
  renderMarkdown,
  DEFAULT_THRESHOLDS,
} from '../.github/scripts/dependency-freshness.mjs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const byName = (ledger, name) => ledger.deps.find((d) => d.name === name);

function main() {
  // --- parseVersion tolerates ranges, prereleases, and junk. -----------------
  {
    ok(parseVersion('1.29.0').minor === 29, 'parseVersion: plain version');
    ok(parseVersion('^1.47.0').major === 1, 'parseVersion: strips ^ range operator');
    const pre = parseVersion('1.5.4-r.1');
    ok(pre.patch === 4 && pre.prerelease === true, 'parseVersion: flags prerelease suffix');
    ok(parseVersion('1.33.1-dev57.0').prerelease === true, 'parseVersion: dev prerelease flagged');
    ok(parseVersion('not-a-version') === null, 'parseVersion: junk returns null');
  }

  // --- Major-behind tiers: warn at 1..limit, FAIL beyond the limit. ----------
  {
    const pkg = { dependencies: { alpha: '^1.0.0', beta: '^1.0.0' } };
    const outdated = {
      alpha: { current: '1.0.0', wanted: '1.0.0', latest: '2.0.0' }, // 1 major → warn
      beta: { current: '1.0.0', wanted: '1.0.0', latest: '4.0.0' }, // 3 majors → fail (limit 2)
    };
    const ledger = buildLedger({ pkg, outdated });
    ok(byName(ledger, 'alpha').status === 'warn', 'majors: 1 major behind → warn (no fail)');
    ok(byName(ledger, 'beta').status === 'fail', 'majors: 3 majors behind → FAIL (limit 2)');
    ok(ledger.exitCode === 1, 'majors: a failing dep sets non-zero exit code');
    ok(ledger.summary.fail === 1 && ledger.summary.warn === 1, 'majors: summary tallies fail/warn');
  }

  // --- maxMajorsBehind threshold is configurable. ----------------------------
  {
    const pkg = { dependencies: { alpha: '^1.0.0' } };
    const outdated = { alpha: { current: '1.0.0', wanted: '1.0.0', latest: '2.0.0' } };
    const strict = buildLedger({ pkg, outdated, thresholds: { maxMajorsBehind: 0 } });
    ok(strict.deps[0].status === 'fail', 'threshold: maxMajorsBehind=0 → 1 major behind FAILS');
    ok(strict.exitCode === 1, 'threshold: strict config flips the exit code');
  }

  // --- Minor / patch staleness only warns, never fails. ----------------------
  {
    const pkg = { dependencies: { m: '^1.0.0', p: '^1.0.0', fresh: '^1.0.0' } };
    const outdated = {
      m: { current: '1.0.0', wanted: '1.9.0', latest: '1.9.0' }, // 9 minors → warn
      p: { current: '1.0.0', wanted: '1.0.5', latest: '1.0.5' }, // 5 patches → ok (< 25)
    };
    const ledger = buildLedger({ pkg, outdated });
    ok(byName(ledger, 'm').status === 'warn' && byName(ledger, 'm').level === 'minor', 'minor: 9 minors behind → warn');
    ok(byName(ledger, 'p').status === 'ok' && byName(ledger, 'p').level === 'patch', 'patch: 5 patches behind stays ok');
    ok(byName(ledger, 'fresh').level === 'current', 'fresh: dep not in outdated → current');
    ok(ledger.exitCode === 0, 'minor/patch: staleness alone never fails the build');
  }

  // --- Current version falls back to the lockfile when outdated omits it. ----
  {
    const pkg = { devDependencies: { locked: '^1.0.0' } };
    const lock = { packages: { 'node_modules/locked': { version: '1.4.2' } } };
    const ledger = buildLedger({ pkg, lock, outdated: {} });
    ok(byName(ledger, 'locked').current === '1.4.2', 'lockfile: pinned version used as current');
    ok(byName(ledger, 'locked').type === 'dev', 'lockfile: devDependency typed as dev');
  }

  // --- npm audit: high/critical FAIL, moderate/low WARN. ---------------------
  {
    const pkg = { dependencies: { safe: '^1.0.0' } };
    const audit = {
      vulnerabilities: {
        badpkg: { severity: 'critical', range: '<1.2.3', fixAvailable: true },
        okpkg: { severity: 'moderate', range: '>=1.0.0 <1.1.0', fixAvailable: false },
      },
    };
    const ledger = buildLedger({ pkg, audit });
    const crit = ledger.vulnerabilities.find((v) => v.name === 'badpkg');
    const mod = ledger.vulnerabilities.find((v) => v.name === 'okpkg');
    ok(crit.gates === 'fail', 'audit: critical advisory gates as fail');
    ok(mod.gates === 'warn', 'audit: moderate advisory gates as warn');
    ok(ledger.vulnerabilities[0].severity === 'critical', 'audit: sorted worst-severity first');
    ok(ledger.exitCode === 1, 'audit: a fail-level advisory sets non-zero exit');
    ok(ledger.summary.vulnFail === 1 && ledger.summary.vulnWarn === 1, 'audit: summary tallies vuln gates');
  }

  // --- Clean manifest: everything current, exit 0. ---------------------------
  {
    const pkg = { dependencies: { a: '1.0.0' }, devDependencies: { b: '2.0.0' } };
    const lock = {
      packages: {
        'node_modules/a': { version: '1.0.0' },
        'node_modules/b': { version: '2.0.0' },
      },
    };
    const ledger = buildLedger({ pkg, lock, outdated: {}, audit: { vulnerabilities: {} } });
    ok(ledger.exitCode === 0 && ledger.summary.fail === 0, 'clean: up-to-date manifest exits 0');
    ok(ledger.summary.current === 2, 'clean: both deps classified current');
  }

  // --- renderMarkdown is stable and states the gate policy. ------------------
  {
    const pkg = { dependencies: { a: '^1.0.0' } };
    const md = renderMarkdown(buildLedger({ pkg, outdated: {} }));
    ok(md.includes('Dependency Freshness Ledger'), 'render: has a title');
    ok(/if any dependency is more than \d+ majors behind/i.test(md), 'render: states the gate policy');
    ok(md.includes('| Status | Package |'), 'render: emits the dependency table header');
  }

  // --- Registry-unavailable flag surfaces in the report. ---------------------
  {
    const pkg = { dependencies: { a: '^1.0.0' } };
    const md = renderMarkdown(buildLedger({ pkg, outdated: {}, registryAvailable: false }));
    ok(/Registry reachable: NO/.test(md), 'render: unreachable registry is flagged');
  }

  // --- Smoke run against the REAL package.json: must build without throwing. --
  {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
    const ledger = buildLedger({ pkg, lock, outdated: {}, audit: { vulnerabilities: {} } });
    ok(ledger.summary.total >= 3, 'smoke: real manifest yields the tracked dependency set');
    ok(typeof ledger.exitCode === 'number', 'smoke: real manifest produces a numeric exit code');
    ok(DEFAULT_THRESHOLDS.maxMajorsBehind === 2, 'smoke: default major-behind limit is 2');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
