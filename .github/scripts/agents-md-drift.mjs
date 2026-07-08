// ============================================================
// DATAGLOW — AGENTS.md Context-Rot Detector (GATING)
// ============================================================
// Every coding subagent reads AGENTS.md before touching this repo, and it trusts
// that file confidently — far more readily than a human, who would sanity-check a
// suspicious instruction against reality. Over many successive, stateless agent
// generations that trust is a liability: once AGENTS.md names a file, an npm
// script, or a path that has since been renamed or deleted, every later agent
// inherits the stale claim and can be silently misled by it.
//
// This checker is the merge gate that keeps AGENTS.md honest. It is PURE static
// analysis — regex/string extraction plus filesystem and package.json lookups.
// No LLM, no network, deterministic and fast, safe to run on every PR.
//
// It extracts two tightly-scoped kinds of "referenceable identifier" from the
// backtick-quoted spans in AGENTS.md and verifies each against the live tree:
//
//   MISSING_FILE   — a backticked token that looks like a repo path (it contains
//                    a "/" or ends in a known source/doc extension) but does not
//                    exist on disk relative to the repo root.
//   MISSING_SCRIPT — a backticked token that names an npm script (either the
//                    `npm run <name>` / `npm <name>` invocation form or a bare
//                    `test:*` / `screenshot:*` script token) that is not a key
//                    under "scripts" in package.json.
//
// Wildcard/glob tokens (anything containing `*`, e.g. the `test:*` family
// shorthand AGENTS.md uses to describe the whole suite) are deliberately treated
// as descriptive, not literal, and are never failed on.
//
// The extraction/verification logic is a pure function (`runCheck`) so it is
// unit-testable in CI (see test/agents-md-drift.test.mjs) and can be run locally
// with `npm run test:agentsdrift` or `node .github/scripts/agents-md-drift.mjs`.
// This module NEVER modifies the repository — it only READS and reports; fixing
// drift (correct the code reference, or correct the AGENTS.md text) is a human
// decision made in the offending PR.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS_NAME = 'AGENTS.md';
const PKG_NAME = 'package.json';

// File-path-like tokens must end in one of these to count on extension alone
// (a token containing "/" also counts, regardless of extension).
const PATH_EXT = /\.(m?js|json|md|ya?ml|html|css|webmanifest)$/;

// Bare npm-script tokens use these prefixes in this repo's package.json.
const SCRIPT_PREFIX = /^(test|screenshot|build|lint|start|dev):/;

// A plausible path token: only path-safe characters, no whitespace. Keeps the
// heuristic from firing on arbitrary prose that merely happens to be backticked.
const PATH_TOKEN = /^[.\w][\w./-]*\/?$/;

/**
 * Pull every backtick-quoted span out of the markdown source. Handles both
 * single-backtick inline code (`foo`) and multi-backtick spans (``foo``); fenced
 * code blocks are skipped so their contents are not mistaken for references.
 * @param {string} md
 * @returns {string[]} raw span contents, in document order
 */
export function extractBacktickSpans(md) {
  const spans = [];
  const lines = md.split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // Match runs of backticks so ``a`b`` is one span; standard CommonMark rule.
    for (const m of line.matchAll(/(`+)([^`]+?)\1/g)) {
      spans.push(m[2].trim());
    }
  }
  return spans;
}

/** Strip a single leading "./" and a single trailing "/" for existence checks. */
function normalizePath(token) {
  let t = token.replace(/^\.\//, '');
  t = t.replace(/\/+$/, '');
  return t;
}

/**
 * Classify a single backtick span. Returns a candidate reference descriptor, or
 * null if the span is not a file-path-like or npm-script-like identifier.
 * @param {string} span
 * @returns {{kind:'file'|'script', raw:string, value:string, wildcard:boolean}|null}
 */
export function classifySpan(span) {
  const raw = span.trim();
  if (!raw) return null;

  // --- npm-script forms -----------------------------------------------------
  // `npm run <name>`, `npm test:<name>` (invocation spans may contain spaces).
  const inv = raw.match(/^npm\s+(?:run\s+)?([A-Za-z][\w:.-]*)$/);
  if (inv) {
    const value = inv[1];
    return { kind: 'script', raw, value, wildcard: value.includes('*') };
  }
  // Bare script token, e.g. `test:golden` or `screenshot:grades`.
  if (!/\s/.test(raw) && SCRIPT_PREFIX.test(raw)) {
    return { kind: 'script', raw, value: raw, wildcard: raw.includes('*') };
  }

  // --- file-path forms ------------------------------------------------------
  // Reject spans with whitespace, URLs, or bare-word prose early.
  if (/\s/.test(raw)) return null;
  if (/^[a-z]+:\/\//i.test(raw)) return null; // URL like http://…
  const looksLikePath = raw.includes('/') || PATH_EXT.test(raw);
  if (!looksLikePath) return null;
  if (!PATH_TOKEN.test(raw)) return null;
  return { kind: 'file', raw, value: normalizePath(raw), wildcard: raw.includes('*') };
}

/**
 * Run the AGENTS.md context-rot check against a repo root. Pure & read-only.
 * @param {{root?: string}} [opts]
 * @returns {{root:string, generatedAt:string, agentsPresent:boolean,
 *   fileRefCount:number, scriptRefCount:number,
 *   findings:{missingFiles:any[], missingScripts:any[], wildcardsIgnored:any[]},
 *   totalDrift:number, error?:string}}
 */
export function runCheck({ root = process.cwd() } = {}) {
  const generatedAt = new Date().toISOString();
  const empty = { missingFiles: [], missingScripts: [], wildcardsIgnored: [] };

  const agentsPath = join(root, AGENTS_NAME);
  if (!existsSync(agentsPath)) {
    return {
      root, generatedAt, agentsPresent: false, fileRefCount: 0, scriptRefCount: 0,
      findings: empty, totalDrift: 1, error: `${AGENTS_NAME} not found at repo root`,
    };
  }

  // Load the script names declared in package.json (missing/invalid → warn-only,
  // since it is the code side that would be broken, not AGENTS.md).
  let scriptKeys = null;
  let pkgError;
  const pkgPath = join(root, PKG_NAME);
  if (!existsSync(pkgPath)) {
    pkgError = `${PKG_NAME} not found at repo root`;
  } else {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      scriptKeys = new Set(Object.keys(pkg.scripts || {}));
    } catch (e) {
      pkgError = `${PKG_NAME} is not valid JSON: ${e.message}`;
    }
  }

  const md = readFileSync(agentsPath, 'utf8');
  const spans = extractBacktickSpans(md);

  const missingFiles = [];
  const missingScripts = [];
  const wildcardsIgnored = [];
  const seenFile = new Set();
  const seenScript = new Set();
  let fileRefCount = 0;
  let scriptRefCount = 0;

  for (const span of spans) {
    const c = classifySpan(span);
    if (!c) continue;

    if (c.wildcard) {
      wildcardsIgnored.push({ kind: c.kind, raw: c.raw });
      continue;
    }

    if (c.kind === 'file') {
      if (seenFile.has(c.value)) continue;
      seenFile.add(c.value);
      fileRefCount++;
      if (!existsSync(join(root, c.value))) {
        missingFiles.push({ raw: c.raw, path: c.value });
      }
    } else {
      if (seenScript.has(c.value)) continue;
      seenScript.add(c.value);
      scriptRefCount++;
      // Only fail on a missing script when we could actually read package.json.
      if (scriptKeys && !scriptKeys.has(c.value)) {
        missingScripts.push({ raw: c.raw, script: c.value });
      }
    }
  }

  const findings = { missingFiles, missingScripts, wildcardsIgnored };
  const totalDrift = missingFiles.length + missingScripts.length;

  return {
    root, generatedAt, agentsPresent: true,
    fileRefCount, scriptRefCount, findings, totalDrift,
    ...(pkgError ? { error: pkgError } : {}),
  };
}

/** Render a check result as a human-readable Markdown report. */
export function renderReport(result) {
  const lines = [];
  lines.push('## DATAGLOW — AGENTS.md Context-Rot Detector');
  lines.push('');
  if (result.error) {
    lines.push(`- **Warning:** ${result.error}`);
    lines.push('');
  }
  lines.push(`- Generated: \`${result.generatedAt}\``);
  lines.push(`- Source: ${result.agentsPresent ? `\`${AGENTS_NAME}\`` : `**missing (${AGENTS_NAME})**`}`);
  lines.push(`- File-path references checked: **${result.fileRefCount}**`);
  lines.push(`- npm-script references checked: **${result.scriptRefCount}**`);
  lines.push(`- Wildcard/glob spans ignored: **${result.findings.wildcardsIgnored.length}**`);
  lines.push(`- Total stale references: **${result.totalDrift}**`);
  lines.push('');

  const { missingFiles, missingScripts } = result.findings;

  lines.push('### Stale file references — path in AGENTS.md, missing on disk');
  if (missingFiles.length === 0) lines.push('_None._');
  else for (const f of missingFiles) {
    lines.push(`- \`${AGENTS_NAME}\` references file \`${f.path}\` which does not exist in the repo`);
  }
  lines.push('');

  lines.push('### Stale npm-script references — named in AGENTS.md, absent from package.json');
  if (missingScripts.length === 0) lines.push('_None._');
  else for (const s of missingScripts) {
    lines.push(`- \`${AGENTS_NAME}\` references npm script \`${s.script}\` which does not exist in ${PKG_NAME}`);
  }
  lines.push('');

  if (result.totalDrift === 0) {
    lines.push('> No context rot: every file path and npm script named in `AGENTS.md` still exists.');
  } else {
    lines.push('> Context rot detected. Fix it in this PR: either correct the reference in `AGENTS.md` to point at what exists now, or restore/rename the code so the reference resolves — whichever is actually correct.');
  }
  lines.push('');

  return lines.join('\n');
}

// --- CLI: print report; write to $GITHUB_STEP_SUMMARY if present; GATE ---------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = process.env.AGENTS_DRIFT_ROOT || process.cwd();
  const result = runCheck({ root });
  const md = renderReport(result);
  process.stdout.write(md + '\n');

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
    } catch { /* best-effort summary only */ }
  }

  if (result.totalDrift > 0) {
    process.stderr.write(`\nAGENTS.md context rot detected: ${result.totalDrift} stale reference(s). See report above.\n`);
    process.exit(1);
  }
  process.stdout.write('\nAGENTS.md is in sync with the shipped code.\n');
  process.exit(0);
}
