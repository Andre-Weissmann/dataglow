// ============================================================
// DATAGLOW — Entropy-Reduction Scan (v1, READ-ONLY)
// ============================================================
// A small, deterministic "golden principles" scanner for DATAGLOW's codebase.
// It is run weekly (and on-demand) by the `entropy-reduction-scan` GitHub Action
// to catch slow structural drift that no single feature PR would notice.
//
// IMPORTANT — this module NEVER modifies the repository. It only READS files and
// RETURNS a findings object. Reporting (job summary, artifact, GitHub issue) is
// the caller's job, and even that is limited to discovery output — no commits,
// no pull requests, no auto-fixes. Any actual cleanup is a human decision.
//
// The scan logic is intentionally kept as a pure function (`runScan`) so it is
// unit-testable in CI (see test/entropy-scan.test.mjs) and can be dry-run locally
// with `npm run test:entropy` or `node .github/scripts/entropy-scan.mjs`.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------
// Golden principles (v1). Keep this list short and each check cheap and
// deterministic. To extend, add a principle id + a check below; document it in
// docs/entropy-reduction-scan.md. See that file for the read-only guarantee.
// ------------------------------------------------------------
export const GOLDEN_PRINCIPLES = {
  STALE_TODO:
    'Source TODO/FIXME/HACK/XXX markers should have a corresponding entry in docs/tech-debt-tracker.md.',
  DANGLING_DOC_REF:
    'docs/*.md must not reference js/ files or fenced `func()` names that no longer exist in js/.',
  JS_DIR_GROWTH:
    'The flat js/ directory should not grow unbounded; growth past the tracked baseline should be noted in the tracker.',
};

// The baseline count of top-level js/ modules recorded in the tracker on
// 2026-07-08. The scan only *reports* growth beyond this; it never edits code.
export const JS_DIR_BASELINE = 60;

const TODO_MARKER = /\b(TODO|FIXME|HACK|XXX)\b/;
const SOURCE_EXT = /\.(m?js)$/;

function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

// Top-level (non-recursive) source modules directly under js/.
function listTopLevelJs(jsDir) {
  if (!existsSync(jsDir)) return [];
  return readdirSync(jsDir)
    .filter((n) => SOURCE_EXT.test(n))
    .filter((n) => {
      try { return statSync(join(jsDir, n)).isFile(); }
      catch { return false; }
    })
    .sort();
}

// --- Principle 1: stale TODO/FIXME markers not tracked ------------------------
function checkStaleTodos(jsDir, trackerText) {
  const findings = [];
  for (const file of listFiles(jsDir)) {
    if (!SOURCE_EXT.test(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!TODO_MARKER.test(line)) return;
      const base = basename(file);
      const tracked = trackerText.includes(base);
      findings.push({
        principle: 'STALE_TODO',
        file,
        line: i + 1,
        text: line.trim().slice(0, 160),
        tracked,
      });
    });
  }
  // Only surface markers that are NOT already acknowledged in the tracker.
  return findings.filter((f) => !f.tracked);
}

// --- Principle 2: dangling references in docs/ --------------------------------
function checkDanglingDocRefs(docsDir, jsDir) {
  const findings = [];
  const jsFileNames = new Set(listFiles(jsDir).map((f) => basename(f)));
  const jsSource = listFiles(jsDir)
    .filter((f) => SOURCE_EXT.test(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  for (const doc of listFiles(docsDir)) {
    if (!doc.endsWith('.md')) continue;
    const text = readFileSync(doc, 'utf8');

    // (a) js/<name> path references that don't exist on disk.
    for (const m of text.matchAll(/js\/([A-Za-z0-9_.-]+\.m?js)/g)) {
      const name = m[1];
      if (!jsFileNames.has(name)) {
        findings.push({ principle: 'DANGLING_DOC_REF', doc, kind: 'file', ref: `js/${name}` });
      }
    }

    // (b) fenced `funcName()` references not found anywhere in js/ source.
    for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)\(\)`/g)) {
      const fn = m[1];
      const defined =
        jsSource.includes(`function ${fn}`) ||
        jsSource.includes(`${fn} =`) ||
        jsSource.includes(`${fn}(`);
      if (!defined) {
        findings.push({ principle: 'DANGLING_DOC_REF', doc, kind: 'function', ref: `${fn}()` });
      }
    }
  }
  return findings;
}

// --- Principle 3: flat js/ directory growth -----------------------------------
function checkJsDirGrowth(jsDir) {
  const files = listTopLevelJs(jsDir);
  const count = files.length;
  if (count <= JS_DIR_BASELINE) return [];
  return [
    {
      principle: 'JS_DIR_GROWTH',
      count,
      baseline: JS_DIR_BASELINE,
      note: `Top-level js/ modules grew from baseline ${JS_DIR_BASELINE} to ${count}. Consider recording a grouping plan in docs/tech-debt-tracker.md.`,
    },
  ];
}

/**
 * Run all golden-principle checks against a repo root. Pure & read-only.
 * @param {{root?: string}} [opts]
 * @returns {{root:string, generatedAt:string, jsFileCount:number,
 *   principles:object, findings:{staleTodos:any[], danglingDocRefs:any[], jsDirGrowth:any[]},
 *   totalFindings:number}}
 */
export function runScan({ root = process.cwd() } = {}) {
  const jsDir = join(root, 'js');
  const docsDir = join(root, 'docs');
  const trackerPath = join(docsDir, 'tech-debt-tracker.md');
  const trackerText = existsSync(trackerPath) ? readFileSync(trackerPath, 'utf8') : '';

  const staleTodos = checkStaleTodos(jsDir, trackerText).map((f) => ({
    ...f,
    file: relative(root, f.file),
  }));
  const danglingDocRefs = checkDanglingDocRefs(docsDir, jsDir).map((f) => ({
    ...f,
    doc: relative(root, f.doc),
  }));
  const jsDirGrowth = checkJsDirGrowth(jsDir);

  const findings = { staleTodos, danglingDocRefs, jsDirGrowth };
  const totalFindings = staleTodos.length + danglingDocRefs.length + jsDirGrowth.length;

  return {
    root,
    generatedAt: new Date().toISOString(),
    jsFileCount: listTopLevelJs(jsDir).length,
    trackerPresent: trackerText.length > 0,
    principles: GOLDEN_PRINCIPLES,
    findings,
    totalFindings,
  };
}

/** Render a scan result as a Markdown report (used for the job summary + issue). */
export function renderMarkdown(result) {
  const lines = [];
  lines.push('## DATAGLOW — Entropy-Reduction Scan (read-only)');
  lines.push('');
  lines.push(`- Generated: \`${result.generatedAt}\``);
  lines.push(`- Top-level \`js/\` modules: **${result.jsFileCount}** (baseline ${JS_DIR_BASELINE})`);
  lines.push(`- Tracker present: ${result.trackerPresent ? 'yes' : 'NO — docs/tech-debt-tracker.md missing'}`);
  lines.push(`- Total findings: **${result.totalFindings}**`);
  lines.push('');
  lines.push('> This scan is discovery-only. It does not commit, open PRs, or auto-fix. Any cleanup is a human decision — file/append entries in `docs/tech-debt-tracker.md`.');
  lines.push('');

  const { staleTodos, danglingDocRefs, jsDirGrowth } = result.findings;

  lines.push('### Untracked TODO/FIXME/HACK/XXX markers');
  if (staleTodos.length === 0) lines.push('_None._');
  else for (const f of staleTodos) lines.push(`- \`${f.file}:${f.line}\` — ${f.text}`);
  lines.push('');

  lines.push('### Dangling references in docs/');
  if (danglingDocRefs.length === 0) lines.push('_None._');
  else for (const f of danglingDocRefs) lines.push(`- \`${f.doc}\` → missing ${f.kind} \`${f.ref}\``);
  lines.push('');

  lines.push('### Flat js/ directory growth');
  if (jsDirGrowth.length === 0) lines.push(`_Within baseline (${JS_DIR_BASELINE})._`);
  else for (const f of jsDirGrowth) lines.push(`- ${f.note}`);
  lines.push('');

  return lines.join('\n');
}

// --- CLI: print JSON + Markdown; write to $GITHUB_STEP_SUMMARY if present -----
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = process.env.SCAN_ROOT || process.cwd();
  const result = runScan({ root });
  const md = renderMarkdown(result);
  process.stdout.write(md + '\n');

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
    } catch { /* best-effort summary only */ }
  }
  // Write machine-readable output for the workflow to hand to actions/github-script.
  if (process.env.SCAN_OUTPUT) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(process.env.SCAN_OUTPUT), { recursive: true });
    writeFileSync(process.env.SCAN_OUTPUT, JSON.stringify({ result, markdown: md }, null, 2));
  }
  // Read-only: always exit 0. Findings are informational, never a build gate.
  process.exit(0);
}
