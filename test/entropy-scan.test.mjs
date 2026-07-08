// ============================================================
// DATAGLOW — Entropy-Reduction Scan test suite
// ============================================================
// Unit-tests the pure, read-only golden-principles scanner in
// .github/scripts/entropy-scan.mjs. We build a throwaway fixture repo in a temp
// directory (its own js/ + docs/) so the assertions are deterministic and never
// depend on the real tree. Also does one smoke run against the REAL repo root to
// prove the scanner executes cleanly on the actual codebase.
//
// RUN WITH:  node test/entropy-scan.test.mjs
// Engine-free (no DuckDB): the scanner is pure file I/O + string checks.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan, renderMarkdown, JS_DIR_BASELINE } from '../.github/scripts/entropy-scan.mjs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function makeFixture({ tracker, jsFiles = {}, docFiles = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'dataglow-entropy-'));
  mkdirSync(join(root, 'js'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  if (tracker !== undefined) writeFileSync(join(root, 'docs', 'tech-debt-tracker.md'), tracker);
  for (const [name, body] of Object.entries(jsFiles)) writeFileSync(join(root, 'js', name), body);
  for (const [name, body] of Object.entries(docFiles)) writeFileSync(join(root, 'docs', name), body);
  return root;
}

function main() {
  // --- Principle 1: untracked TODO markers are surfaced; tracked ones are not.
  {
    const root = makeFixture({
      tracker: '# tracker\nknown-debt.js is acknowledged here.\n',
      jsFiles: {
        'clean.js': 'export const x = 1;\n',
        'known-debt.js': '// TODO: this marker is acknowledged in the tracker\nexport const y = 2;\n',
        'noisy.js': '// FIXME: this one is NOT in the tracker\nexport const z = 3;\n',
      },
    });
    const r = runScan({ root });
    const files = r.findings.staleTodos.map((f) => f.file);
    ok(files.some((f) => f.endsWith('noisy.js')), 'stale-todo: untracked FIXME is reported');
    ok(!files.some((f) => f.endsWith('known-debt.js')), 'stale-todo: TODO in a tracked file is suppressed');
    ok(!files.some((f) => f.endsWith('clean.js')), 'stale-todo: clean file produces no finding');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Principle 2: dangling doc references (missing file + missing function).
  {
    const root = makeFixture({
      tracker: '# tracker\n',
      jsFiles: { 'real.js': 'export function realFn() { return 1; }\n' },
      docFiles: {
        'guide.md': 'See `js/real.js` and `realFn()`. Also `js/ghost.js` and `missingFn()`.\n',
      },
    });
    const r = runScan({ root });
    const refs = r.findings.danglingDocRefs.map((f) => f.ref);
    ok(refs.includes('js/ghost.js'), 'dangling: missing js/ file reference is reported');
    ok(refs.includes('missingFn()'), 'dangling: missing function reference is reported');
    ok(!refs.includes('js/real.js'), 'dangling: an existing js/ file is NOT reported');
    ok(!refs.includes('realFn()'), 'dangling: an existing function is NOT reported');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Principle 3: js/ growth beyond baseline is reported; at/under is not.
  {
    const under = makeFixture({ tracker: '#\n', jsFiles: { 'a.js': '//\n', 'b.js': '//\n' } });
    ok(runScan({ root: under }).findings.jsDirGrowth.length === 0, 'growth: under baseline → no finding');
    rmSync(under, { recursive: true, force: true });

    const many = {};
    for (let i = 0; i < JS_DIR_BASELINE + 3; i++) many[`m${i}.js`] = '//\n';
    const over = makeFixture({ tracker: '#\n', jsFiles: many });
    const g = runScan({ root: over }).findings.jsDirGrowth;
    ok(g.length === 1 && g[0].count === JS_DIR_BASELINE + 3, 'growth: over baseline → single growth finding with count');
    rmSync(over, { recursive: true, force: true });
  }

  // --- renderMarkdown is stable and mentions the read-only guarantee.
  {
    const root = makeFixture({ tracker: '#\n', jsFiles: { 'a.js': '//\n' } });
    const md = renderMarkdown(runScan({ root }));
    ok(md.includes('Entropy-Reduction Scan'), 'render: has a title');
    ok(/discovery-only|does not commit/i.test(md), 'render: states the read-only guarantee');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Smoke run against the REAL repo root: must execute without throwing.
  {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const r = runScan({ root: repoRoot });
    ok(typeof r.totalFindings === 'number' && r.jsFileCount > 0, 'smoke: real repo scan returns a numeric summary');
    ok(r.trackerPresent === true, 'smoke: real repo has docs/tech-debt-tracker.md');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
