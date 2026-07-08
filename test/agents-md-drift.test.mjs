// ============================================================
// DATAGLOW — AGENTS.md Context-Rot Detector test suite
// ============================================================
// Unit-tests the pure, read-only checker in
// .github/scripts/agents-md-drift.mjs against throwaway fixture repos (each with
// its own AGENTS.md and package.json) so the assertions are deterministic and
// never depend on the real tree. It then does a GATING run against the REAL repo
// root: the shipped AGENTS.md must reference only files and npm scripts that
// actually exist, so this suite doubles as the CI merge gate.
//
// RUN WITH:  node test/agents-md-drift.test.mjs      (no DuckDB, no network)

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runCheck, renderReport, classifySpan, extractBacktickSpans,
} from '../.github/scripts/agents-md-drift.mjs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Build a fixture repo: an AGENTS.md body, a package.json scripts map, and any
// extra files (relative path -> contents) that should exist on disk.
function makeFixture({ agents, scripts = {}, files = {}, noPkg = false }) {
  const root = mkdtempSync(join(tmpdir(), 'dataglow-agentsdrift-'));
  if (agents !== undefined) writeFileSync(join(root, 'AGENTS.md'), agents);
  if (!noPkg) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts }, null, 2));
  }
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

function main() {
  // --- classifySpan: file-path detection --------------------------------------
  ok(classifySpan('js/story.js')?.kind === 'file', 'classify: path with slash is a file ref');
  ok(classifySpan('index.html')?.kind === 'file', 'classify: bare filename with known ext is a file ref');
  ok(classifySpan('docs/capability-map/')?.value === 'docs/capability-map', 'classify: trailing slash normalized');
  ok(classifySpan('runCheck') === null, 'classify: a bare identifier is NOT a file ref');
  ok(classifySpan('some prose here') === null, 'classify: multi-word prose is ignored');
  ok(classifySpan('https://example.com/x.js') === null, 'classify: URLs are ignored');

  // --- classifySpan: npm-script detection -------------------------------------
  ok(classifySpan('npm run test:sql')?.value === 'test:sql', 'classify: `npm run X` extracts script name');
  ok(classifySpan('test:golden')?.kind === 'script', 'classify: bare test:* token is a script ref');
  ok(classifySpan('screenshot:grades')?.kind === 'script', 'classify: bare screenshot:* token is a script ref');
  ok(classifySpan('test:*')?.wildcard === true, 'classify: wildcard token flagged as wildcard');

  // --- extractBacktickSpans: skips fenced blocks ------------------------------
  {
    const md = 'Inline `js/a.js` here.\n```\n`js/should-be-ignored.js`\n```\nAnd `test:foo`.\n';
    const spans = extractBacktickSpans(md);
    ok(spans.includes('js/a.js') && spans.includes('test:foo'), 'extract: inline spans captured');
    ok(!spans.includes('js/should-be-ignored.js'), 'extract: fenced-block contents skipped');
  }

  // --- Clean fixture: every ref resolves → no drift ---------------------------
  {
    const root = makeFixture({
      agents: 'See `js/engine.js` and run `npm run test:sql`. Suite is `test:*`.\n',
      scripts: { 'test:sql': 'node x' },
      files: { 'js/engine.js': '//\n' },
    });
    const r = runCheck({ root });
    ok(r.totalDrift === 0, 'clean fixture: no drift');
    ok(r.fileRefCount === 1 && r.scriptRefCount === 1, 'clean fixture: counts reported');
    ok(r.findings.wildcardsIgnored.length === 1, 'clean fixture: test:* ignored as wildcard');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Stale file reference → hard finding ------------------------------------
  {
    const root = makeFixture({
      agents: 'Start at `js/gone.js` for the feature.\n',
      scripts: {},
    });
    const r = runCheck({ root });
    ok(r.findings.missingFiles.some((f) => f.path === 'js/gone.js'), 'stale file: missing path flagged');
    ok(r.totalDrift === 1, 'stale file: counted as drift');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Stale npm-script reference → hard finding ------------------------------
  {
    const root = makeFixture({
      agents: 'Run `npm run test:ghost` before opening a PR.\n',
      scripts: { 'test:real': 'node x' },
    });
    const r = runCheck({ root });
    ok(r.findings.missingScripts.some((s) => s.script === 'test:ghost'), 'stale script: missing script flagged');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Wildcard is never a failure --------------------------------------------
  {
    const root = makeFixture({
      agents: 'Scripts named `test:*` live in package.json.\n',
      scripts: { 'test:real': 'node x' },
    });
    const r = runCheck({ root });
    ok(r.totalDrift === 0, 'wildcard: `test:*` does not fail the gate');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Missing package.json → script refs warn, do not hard-fail --------------
  {
    const root = makeFixture({
      agents: 'Run `npm run test:sql`.\n',
      noPkg: true,
    });
    const r = runCheck({ root });
    ok(r.findings.missingScripts.length === 0, 'no package.json: script refs not hard-failed');
    ok(typeof r.error === 'string' && /package\.json/.test(r.error), 'no package.json: warning recorded');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Missing AGENTS.md → treated as drift with an error ---------------------
  {
    const root = makeFixture({ scripts: {} });
    const r = runCheck({ root });
    ok(r.agentsPresent === false && r.totalDrift > 0, 'missing AGENTS.md: reported as drift');
    rmSync(root, { recursive: true, force: true });
  }

  // --- renderReport: itemizes the offending references ------------------------
  {
    const root = makeFixture({
      agents: 'Bad file `js/nope.js` and bad script `npm run test:nope`.\n',
      scripts: {},
    });
    const md = renderReport(runCheck({ root }));
    ok(md.includes('Context-Rot Detector'), 'render: has a title');
    ok(/js\/nope\.js/.test(md) && /test:nope/.test(md), 'render: names both offending references');
    ok(/Context rot detected/.test(md), 'render: states the fix-in-PR guidance on drift');
    rmSync(root, { recursive: true, force: true });
  }

  // --- GATING run against the REAL repo: shipped AGENTS.md must be in sync -----
  {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const r = runCheck({ root: repoRoot });
    console.log(renderReport(r));
    ok(r.agentsPresent === true, 'real repo: AGENTS.md is present');
    ok(r.fileRefCount > 0, 'real repo: AGENTS.md names at least one file path');
    ok(r.totalDrift === 0, 'real repo: AGENTS.md references only things that exist (GATE)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
