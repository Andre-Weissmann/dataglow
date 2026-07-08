// ============================================================
// DATAGLOW — Dependency Freshness Ledger (CI gate)
// ============================================================
// A small, deterministic staleness/vulnerability check for DATAGLOW's npm
// dependencies. It answers one question on every push/PR: "how far behind are
// our dependencies, and is anything dangerously stale or known-vulnerable?"
//
// WHY this exists: DATAGLOW is a long-running, agent-authored side project. That
// kind of repo silently accumulates outdated dependencies — which is both a
// security risk and a "looks unmaintained" signal for a portfolio project. This
// check makes that drift visible (a versioned ledger in docs/) and turns the
// worst cases into a hard CI failure instead of something nobody notices.
//
// The scoring logic is a pure function (`buildLedger`) so it is unit-testable
// with no network (see test/dependency-freshness.test.mjs). Only the CLI section
// at the bottom touches the network — it shells out to `npm outdated --json` and
// `npm audit --json` and hands their parsed output to `buildLedger`.
//
// RUN LOCALLY:  node .github/scripts/dependency-freshness.mjs
//   (writes/refreshes docs/dependency-freshness-ledger.md and exits non-zero if
//    any dependency trips a FAIL threshold — see DEFAULT_THRESHOLDS below).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// ------------------------------------------------------------
// Tiered thresholds. Each is overridable via an env var so the gate can be tuned
// without editing code. Defaults are deliberately lenient enough not to fail on
// routine minor/patch drift, but strict on the things that actually matter:
// falling multiple majors behind, or shipping a known-vulnerable version.
// ------------------------------------------------------------
export const DEFAULT_THRESHOLDS = {
  // FAIL the build if a dependency is MORE THAN this many majors behind latest.
  // Default 2 → 0/1/2 majors behind warns; 3+ fails. (env: DEPS_MAX_MAJORS_BEHIND)
  maxMajorsBehind: 2,
  // WARN (never fail) once a dependency is this many minors behind within the
  // same major. (env: DEPS_MINOR_WARN)
  minorWarn: 5,
  // WARN once this many patches behind within the same major.minor.
  // (env: DEPS_PATCH_WARN)
  patchWarn: 25,
  // npm audit severities that FAIL the build.
  failSeverities: ['high', 'critical'],
  // npm audit severities that only WARN.
  warnSeverities: ['moderate', 'low'],
};

function readThresholds(env = process.env) {
  const num = (v, fallback) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    ...DEFAULT_THRESHOLDS,
    maxMajorsBehind: num(env.DEPS_MAX_MAJORS_BEHIND, DEFAULT_THRESHOLDS.maxMajorsBehind),
    minorWarn: num(env.DEPS_MINOR_WARN, DEFAULT_THRESHOLDS.minorWarn),
    patchWarn: num(env.DEPS_PATCH_WARN, DEFAULT_THRESHOLDS.patchWarn),
  };
}

// Parse the leading numeric major.minor.patch out of a version or range string.
// Tolerates range operators (^ ~ >= etc.), build tags, and prerelease suffixes
// like "1.5.4-r.1" or "1.33.1-dev57.0". Returns null when no version is found.
export function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: /\d+\.\d+\.\d+-/.test(raw),
    raw,
  };
}

// The version actually pinned in the lockfile (i.e. what `npm ci` installs).
// lockfileVersion 2/3 keys packages by "node_modules/<name>".
function lockedVersion(lock, name) {
  if (!lock || !lock.packages) return null;
  const entry = lock.packages[`node_modules/${name}`];
  return entry && typeof entry.version === 'string' ? entry.version : null;
}

// Classify the gap between current and latest as major/minor/patch/current.
function classify(cur, latest) {
  if (!cur || !latest) return { level: 'unknown', majorsBehind: 0, minorsBehind: 0, patchesBehind: 0 };
  if (latest.major > cur.major) {
    return { level: 'major', majorsBehind: latest.major - cur.major, minorsBehind: 0, patchesBehind: 0 };
  }
  if (latest.major === cur.major && latest.minor > cur.minor) {
    return { level: 'minor', majorsBehind: 0, minorsBehind: latest.minor - cur.minor, patchesBehind: 0 };
  }
  if (latest.major === cur.major && latest.minor === cur.minor && latest.patch > cur.patch) {
    return { level: 'patch', majorsBehind: 0, minorsBehind: 0, patchesBehind: latest.patch - cur.patch };
  }
  return { level: 'current', majorsBehind: 0, minorsBehind: 0, patchesBehind: 0 };
}

// Extract FAIL/WARN-worthy advisories from `npm audit --json` output. Supports
// the npm v7+ report shape (`vulnerabilities` keyed by package name).
function collectVulnerabilities(audit, thresholds) {
  const out = [];
  const vulns = audit && audit.vulnerabilities;
  if (!vulns || typeof vulns !== 'object') return out;
  for (const [name, info] of Object.entries(vulns)) {
    const severity = (info && info.severity) || 'unknown';
    const gates = thresholds.failSeverities.includes(severity)
      ? 'fail'
      : thresholds.warnSeverities.includes(severity)
      ? 'warn'
      : 'info';
    out.push({
      name,
      severity,
      gates,
      range: info && info.range ? info.range : '',
      fixAvailable: info ? Boolean(info.fixAvailable) : false,
    });
  }
  // Worst severity first for a readable report.
  const rank = { critical: 0, high: 1, moderate: 2, low: 3, info: 4, unknown: 5 };
  out.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  return out;
}

/**
 * Build the freshness ledger. PURE: no I/O, no network — all inputs are injected
 * so this is deterministic and unit-testable.
 *
 * @param {object}  args
 * @param {object}  args.pkg        parsed package.json
 * @param {object} [args.lock]      parsed package-lock.json (for pinned versions)
 * @param {object} [args.outdated]  parsed `npm outdated --json` (name → {wanted,latest,current})
 * @param {object} [args.audit]     parsed `npm audit --json`
 * @param {object} [args.thresholds] override DEFAULT_THRESHOLDS
 * @param {boolean}[args.registryAvailable] false if the npm registry couldn't be reached
 * @returns {{generatedAt:string, deps:object[], vulnerabilities:object[],
 *   summary:object, thresholds:object, registryAvailable:boolean, exitCode:number}}
 */
export function buildLedger({
  pkg,
  lock = null,
  outdated = {},
  audit = {},
  thresholds = DEFAULT_THRESHOLDS,
  registryAvailable = true,
} = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const specs = [
    ...Object.entries(pkg.dependencies || {}).map(([name, spec]) => ({ name, spec, type: 'prod' })),
    ...Object.entries(pkg.devDependencies || {}).map(([name, spec]) => ({ name, spec, type: 'dev' })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const deps = specs.map(({ name, spec, type }) => {
    const od = outdated[name];
    const currentRaw = (od && od.current) || lockedVersion(lock, name) || spec;
    const latestRaw = (od && od.latest) || currentRaw;
    const wantedRaw = (od && od.wanted) || currentRaw;
    const cur = parseVersion(currentRaw);
    const latest = parseVersion(latestRaw);
    const gap = classify(cur, latest);

    const reasons = [];
    let status = 'ok';
    if (gap.majorsBehind > t.maxMajorsBehind) {
      status = 'fail';
      reasons.push(`${gap.majorsBehind} majors behind (limit ${t.maxMajorsBehind})`);
    } else if (gap.majorsBehind >= 1) {
      status = 'warn';
      reasons.push(`${gap.majorsBehind} major${gap.majorsBehind > 1 ? 's' : ''} behind`);
    } else if (gap.minorsBehind >= t.minorWarn) {
      status = 'warn';
      reasons.push(`${gap.minorsBehind} minors behind (warn at ${t.minorWarn})`);
    } else if (gap.patchesBehind >= t.patchWarn) {
      status = 'warn';
      reasons.push(`${gap.patchesBehind} patches behind (warn at ${t.patchWarn})`);
    }

    return {
      name,
      type,
      spec,
      current: currentRaw,
      wanted: wantedRaw,
      latest: latestRaw,
      level: gap.level,
      majorsBehind: gap.majorsBehind,
      minorsBehind: gap.minorsBehind,
      patchesBehind: gap.patchesBehind,
      prerelease: latest ? latest.prerelease : false,
      status,
      reasons,
    };
  });

  const vulnerabilities = collectVulnerabilities(audit, t);

  const failingDeps = deps.filter((d) => d.status === 'fail');
  const warningDeps = deps.filter((d) => d.status === 'warn');
  const failingVulns = vulnerabilities.filter((v) => v.gates === 'fail');
  const warningVulns = vulnerabilities.filter((v) => v.gates === 'warn');

  const summary = {
    total: deps.length,
    ok: deps.filter((d) => d.status === 'ok').length,
    warn: warningDeps.length,
    fail: failingDeps.length,
    major: deps.filter((d) => d.level === 'major').length,
    minor: deps.filter((d) => d.level === 'minor').length,
    patch: deps.filter((d) => d.level === 'patch').length,
    current: deps.filter((d) => d.level === 'current').length,
    vulnerabilities: vulnerabilities.length,
    vulnFail: failingVulns.length,
    vulnWarn: warningVulns.length,
  };

  const exitCode = failingDeps.length > 0 || failingVulns.length > 0 ? 1 : 0;

  return {
    generatedAt: new Date().toISOString(),
    registryAvailable,
    thresholds: t,
    deps,
    vulnerabilities,
    summary,
    exitCode,
  };
}

const BADGE = { ok: '🟢 ok', warn: '🟡 warn', fail: '🔴 FAIL' };
const VULN_BADGE = { fail: '🔴 FAIL', warn: '🟡 warn', info: 'ℹ️ info' };

/** Render the ledger as a human-readable Markdown report (doc + job summary). */
export function renderMarkdown(ledger) {
  const { summary: s, thresholds: t } = ledger;
  const lines = [];
  lines.push('# DATAGLOW — Dependency Freshness Ledger');
  lines.push('');
  lines.push('<!-- GENERATED FILE — do not edit by hand.');
  lines.push('     Regenerate with: npm run test:deps-freshness -->');
  lines.push('');
  lines.push(`- Generated: \`${ledger.generatedAt}\``);
  lines.push(`- Registry reachable: ${ledger.registryAvailable ? 'yes' : 'NO — versions may be stale'}`);
  lines.push(
    `- Dependencies tracked: **${s.total}** ` +
      `(🟢 ${s.ok} ok · 🟡 ${s.warn} warn · 🔴 ${s.fail} fail)`,
  );
  lines.push(
    `- Staleness: ${s.current} current · ${s.patch} patch · ${s.minor} minor · ${s.major} major behind`,
  );
  lines.push(
    `- Security advisories (npm audit): **${s.vulnerabilities}** ` +
      `(🔴 ${s.vulnFail} fail-level · 🟡 ${s.vulnWarn} warn-level)`,
  );
  lines.push('');
  lines.push(
    `> Gate: **FAIL** if any dependency is more than ${t.maxMajorsBehind} majors behind, ` +
      `or if \`npm audit\` reports a ${t.failSeverities.join('/')} advisory. ` +
      `**WARN** at ≥1 major, ≥${t.minorWarn} minors, or ≥${t.patchWarn} patches behind.`,
  );
  lines.push('');

  lines.push('## Dependencies');
  lines.push('');
  lines.push('| Status | Package | Type | Current | Latest | Behind | Notes |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const d of ledger.deps) {
    const behind =
      d.level === 'current'
        ? '—'
        : d.level === 'major'
        ? `${d.majorsBehind} major`
        : d.level === 'minor'
        ? `${d.minorsBehind} minor`
        : d.level === 'patch'
        ? `${d.patchesBehind} patch`
        : '?';
    const notes = [];
    if (d.reasons.length) notes.push(d.reasons.join('; '));
    if (d.prerelease && d.level !== 'current') notes.push('latest is a prerelease');
    lines.push(
      `| ${BADGE[d.status]} | \`${d.name}\` | ${d.type} | ${d.current} | ${d.latest} | ${behind} | ${notes.join('; ') || '—'} |`,
    );
  }
  lines.push('');

  lines.push('## Security advisories');
  lines.push('');
  if (ledger.vulnerabilities.length === 0) {
    lines.push('_None reported by `npm audit`._');
  } else {
    lines.push('| Gate | Package | Severity | Vulnerable range | Fix available |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const v of ledger.vulnerabilities) {
      lines.push(
        `| ${VULN_BADGE[v.gates] || v.gates} | \`${v.name}\` | ${v.severity} | ${v.range || '—'} | ${v.fixAvailable ? 'yes' : 'no'} |`,
      );
    }
  }
  lines.push('');
  lines.push('---');
  lines.push(
    '_Automated by `.github/scripts/dependency-freshness.mjs` (the `dependency-freshness` CI job). ' +
      'This file is regenerated on every run; edit the script, not the report._',
  );
  lines.push('');
  return lines.join('\n');
}

// --- CLI: gather npm data, build the ledger, write the report, set exit code --
function runNpmJson(args, cwd) {
  // npm outdated exits 1 when anything is outdated and npm audit exits non-zero
  // when advisories are found — both still print valid JSON to stdout. We read
  // stdout regardless of exit code and only treat a *missing/invalid* payload as
  // a real failure (e.g. no network).
  try {
    const stdout = execFileSync('npm', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120000,
    });
    return { ok: true, data: stdout ? JSON.parse(stdout) : {} };
  } catch (err) {
    const stdout = err && err.stdout ? err.stdout.toString() : '';
    if (stdout.trim()) {
      try {
        return { ok: true, data: JSON.parse(stdout) };
      } catch {
        /* fall through to failure */
      }
    }
    return { ok: false, data: {}, error: err && err.message ? err.message : String(err) };
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { writeFileSync, mkdirSync, appendFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');

  const root = process.env.DEPS_ROOT || process.cwd();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lockPath = join(root, 'package-lock.json');
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null;

  const outdatedRes = runNpmJson(['outdated', '--json'], root);
  const auditRes = runNpmJson(['audit', '--json'], root);
  const registryAvailable = outdatedRes.ok && auditRes.ok;

  const ledger = buildLedger({
    pkg,
    lock,
    outdated: outdatedRes.data || {},
    audit: auditRes.data || {},
    thresholds: readThresholds(),
    registryAvailable,
  });

  const md = renderMarkdown(ledger);

  // Regenerate the versioned, human-readable ledger artifact.
  const reportPath = join(root, 'docs', 'dependency-freshness-ledger.md');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, md);

  process.stdout.write(md + '\n');

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
    } catch {
      /* best-effort summary only */
    }
  }
  if (process.env.DEPS_OUTPUT) {
    mkdirSync(dirname(process.env.DEPS_OUTPUT), { recursive: true });
    writeFileSync(process.env.DEPS_OUTPUT, JSON.stringify({ ledger, markdown: md }, null, 2));
  }

  // If the registry was unreachable we can't trust staleness/vuln data — surface
  // it loudly but don't fail the build on a network blip (avoids flaky CI).
  if (!registryAvailable) {
    console.error(
      '\n[dependency-freshness] WARNING: npm registry unreachable — ' +
        'freshness/vulnerability data may be incomplete. Not failing on this alone.',
    );
    process.exit(0);
  }

  if (ledger.exitCode !== 0) {
    console.error(
      `\n[dependency-freshness] FAIL: ${ledger.summary.fail} dependency(ies) too far behind, ` +
        `${ledger.summary.vulnFail} ${ledger.thresholds.failSeverities.join('/')} advisory(ies). ` +
        'See docs/dependency-freshness-ledger.md.',
    );
  }
  process.exit(ledger.exitCode);
}
