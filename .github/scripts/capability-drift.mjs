// ============================================================
// DATAGLOW — Capability-Map Drift Detector (GATING)
// ============================================================
// Keeps the capability-map documentation honest against the code that actually
// ships. Unlike the read-only entropy-reduction scan, this one is a MERGE GATE:
// the CLI exits non-zero when it finds drift, so CI blocks a PR that lets the
// docs and the code fall out of sync.
//
// It reads a hand-authored manifest (capability-map.manifest.json) that pairs
// each documented capability with the file(s) — and, for the identity-defining
// modules, the exported symbol — that must exist for the claim to be real. From
// that manifest plus the docs it flags four kinds of drift:
//
//   OVERCLAIM_FILE     — a manifest capability points at a js/ file that is gone.
//   OVERCLAIM_SYMBOL   — the file exists but no longer exports the named symbol.
//   DANGLING_DOC_REF   — docs/*.md (or README) reference a js/ file that is gone.
//   UNDOCUMENTED_MODULE — a shipped top-level js/ module no capability maps
//                         (best-effort underclaim heuristic: new feature, no doc).
//   MANIFEST_DOC_MISMATCH — a manifest capability whose files the docs never
//                         mention, i.e. the manifest itself has drifted.
//
// The check logic is a pure function (`runCheck`) so it is unit-testable in CI
// (see test/capability-drift.test.mjs) and can be run locally with
// `npm run test:capdrift` or `node .github/scripts/capability-drift.mjs`.
//
// This module NEVER modifies the repository. It only READS files and returns a
// findings object; fixing drift (updating the map or the manifest) is a human
// decision made in the offending PR.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_EXT = /\.(m?js)$/;
const MANIFEST_NAME = 'capability-map.manifest.json';

// Top-level (non-recursive) source modules directly under js/. These are the
// units the underclaim heuristic expects the manifest to account for.
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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A symbol counts as "still exported" if it is exported by declaration
// (`export function foo`, `export const foo`, `export class foo`, ...) or named
// in an export list (`export { foo, bar }`). Deliberately conservative: it looks
// for an export, not merely a mention, so a deleted export is caught.
function symbolExported(source, name) {
  const n = escapeRegExp(name);
  const decl = new RegExp(`export\\s+(async\\s+)?(function|const|let|var|class)\\s+${n}\\b`);
  const list = new RegExp(`export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`);
  return decl.test(source) || list.test(source);
}

// All js/<file> path references made anywhere in the given doc files.
function collectDocRefs(root, docPaths) {
  const refs = new Map(); // js/<name> -> [doc, doc, ...]
  for (const rel of docPaths) {
    const full = join(root, rel);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    for (const m of text.matchAll(/js\/([A-Za-z0-9_.-]+\.m?js)/g)) {
      const ref = `js/${m[1]}`;
      if (!refs.has(ref)) refs.set(ref, []);
      if (!refs.get(ref).includes(rel)) refs.get(ref).push(rel);
    }
  }
  return refs;
}

/**
 * Run the capability-map drift check against a repo root. Pure & read-only.
 * @param {{root?: string}} [opts]
 * @returns {{root:string, generatedAt:string, manifestPresent:boolean,
 *   capabilityCount:number, jsModuleCount:number,
 *   findings:{overclaimFiles:any[], overclaimSymbols:any[], danglingDocRefs:any[],
 *     undocumentedModules:any[], manifestDocMismatch:any[]},
 *   totalDrift:number, error?:string}}
 */
export function runCheck({ root = process.cwd() } = {}) {
  const generatedAt = new Date().toISOString();
  const jsDir = join(root, 'js');
  const manifestPath = join(root, MANIFEST_NAME);

  const empty = {
    overclaimFiles: [], overclaimSymbols: [], danglingDocRefs: [],
    undocumentedModules: [], manifestDocMismatch: [],
  };

  if (!existsSync(manifestPath)) {
    return {
      root, generatedAt, manifestPresent: false, capabilityCount: 0,
      jsModuleCount: listTopLevelJs(jsDir).length, findings: empty, totalDrift: 1,
      error: `Manifest not found: ${MANIFEST_NAME}`,
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return {
      root, generatedAt, manifestPresent: true, capabilityCount: 0,
      jsModuleCount: listTopLevelJs(jsDir).length, findings: empty, totalDrift: 1,
      error: `Manifest is not valid JSON: ${e.message}`,
    };
  }

  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  const docPaths = Array.isArray(manifest.docs) ? manifest.docs : [];
  const docRefs = collectDocRefs(root, docPaths);

  const overclaimFiles = [];
  const overclaimSymbols = [];
  const manifestDocMismatch = [];
  const mappedFiles = new Set();

  // Cache of file source text so we only read each backing file once.
  const sourceCache = new Map();
  const readSource = (relFile) => {
    if (!sourceCache.has(relFile)) {
      const full = join(root, relFile);
      sourceCache.set(relFile, existsSync(full) ? readFileSync(full, 'utf8') : null);
    }
    return sourceCache.get(relFile);
  };

  for (const cap of capabilities) {
    const files = Array.isArray(cap.files) ? cap.files : [];
    const label = cap.name || cap.id || '(unnamed capability)';

    for (const f of files) mappedFiles.add(f);

    // OVERCLAIM_FILE: a mapped backing file that no longer exists.
    for (const f of files) {
      if (!existsSync(join(root, f))) {
        overclaimFiles.push({ capability: label, id: cap.id, file: f });
      }
    }

    // OVERCLAIM_SYMBOL: mapped symbol no longer exported by an existing file.
    for (const sym of Array.isArray(cap.symbols) ? cap.symbols : []) {
      const src = readSource(sym.file);
      if (src == null) continue; // missing file already reported above
      if (!symbolExported(src, sym.name)) {
        overclaimSymbols.push({ capability: label, id: cap.id, file: sym.file, symbol: sym.name });
      }
    }

    // MANIFEST_DOC_MISMATCH: none of a capability's files are mentioned in the
    // docs, so the manifest is claiming something the capability map does not.
    if (files.length > 0 && !files.some((f) => docRefs.has(f))) {
      manifestDocMismatch.push({ capability: label, id: cap.id, files });
    }
  }

  // DANGLING_DOC_REF: a js/ path referenced in the docs that is gone from disk.
  const danglingDocRefs = [];
  for (const [ref, docs] of docRefs) {
    if (!existsSync(join(root, ref))) {
      danglingDocRefs.push({ ref, docs });
    }
  }

  // UNDOCUMENTED_MODULE (underclaim heuristic): a shipped top-level js/ module
  // that no capability in the manifest accounts for — likely a new feature that
  // was added to the code but never written into the capability map.
  const undocumentedModules = [];
  for (const name of listTopLevelJs(jsDir)) {
    const rel = `js/${name}`;
    if (!mappedFiles.has(rel)) {
      undocumentedModules.push({ file: rel });
    }
  }

  const findings = {
    overclaimFiles, overclaimSymbols, danglingDocRefs,
    undocumentedModules, manifestDocMismatch,
  };
  const totalDrift =
    overclaimFiles.length + overclaimSymbols.length + danglingDocRefs.length +
    undocumentedModules.length + manifestDocMismatch.length;

  return {
    root,
    generatedAt,
    manifestPresent: true,
    capabilityCount: capabilities.length,
    jsModuleCount: listTopLevelJs(jsDir).length,
    findings,
    totalDrift,
  };
}

/** Render a check result as a human-readable Markdown report. */
export function renderReport(result) {
  const lines = [];
  lines.push('## DATAGLOW — Capability-Map Drift Detector');
  lines.push('');
  if (result.error) {
    lines.push(`- **Error:** ${result.error}`);
    lines.push('');
  }
  lines.push(`- Generated: \`${result.generatedAt}\``);
  lines.push(`- Manifest: ${result.manifestPresent ? `\`${MANIFEST_NAME}\`` : `**missing (${MANIFEST_NAME})**`}`);
  lines.push(`- Documented capabilities: **${result.capabilityCount}**`);
  lines.push(`- Top-level \`js/\` modules: **${result.jsModuleCount}**`);
  lines.push(`- Total drift findings: **${result.totalDrift}**`);
  lines.push('');

  const { overclaimFiles, overclaimSymbols, danglingDocRefs, undocumentedModules, manifestDocMismatch } = result.findings;

  lines.push('### Overclaims — documented capability, missing backing file');
  if (overclaimFiles.length === 0) lines.push('_None._');
  else for (const f of overclaimFiles) lines.push(`- "${f.capability}" → \`${f.file}\` no longer exists`);
  lines.push('');

  lines.push('### Overclaims — documented capability, missing exported symbol');
  if (overclaimSymbols.length === 0) lines.push('_None._');
  else for (const f of overclaimSymbols) lines.push(`- "${f.capability}" → \`${f.file}\` no longer exports \`${f.symbol}\``);
  lines.push('');

  lines.push('### Dangling doc references — js/ file referenced in docs but gone');
  if (danglingDocRefs.length === 0) lines.push('_None._');
  else for (const f of danglingDocRefs) lines.push(`- \`${f.ref}\` (referenced in ${f.docs.map((d) => `\`${d}\``).join(', ')})`);
  lines.push('');

  lines.push('### Undocumented modules — shipped js/ module not in the capability map');
  if (undocumentedModules.length === 0) lines.push('_None._');
  else for (const f of undocumentedModules) lines.push(`- \`${f.file}\` has no capability-map entry — document it in \`docs/capability-map.md\` and \`${MANIFEST_NAME}\``);
  lines.push('');

  lines.push('### Manifest drift — capability whose files the docs never mention');
  if (manifestDocMismatch.length === 0) lines.push('_None._');
  else for (const f of manifestDocMismatch) lines.push(`- "${f.capability}" maps ${f.files.map((x) => `\`${x}\``).join(', ')} but none appear in the docs`);
  lines.push('');

  if (result.totalDrift === 0) {
    lines.push('> No drift: the capability map, the manifest, and the shipped `js/` modules all agree.');
  } else {
    lines.push('> Drift detected. Fix it in this PR: update `docs/capability-map.md` and `' + MANIFEST_NAME + '` so the map matches the code (see AGENTS.md — "Keep the capability map current").');
  }
  lines.push('');

  return lines.join('\n');
}

// --- CLI: print report; write to $GITHUB_STEP_SUMMARY if present; GATE ---------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = process.env.CAPDRIFT_ROOT || process.cwd();
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
    process.stderr.write(`\ncapability-map drift detected: ${result.totalDrift} finding(s). See report above.\n`);
    process.exit(1);
  }
  process.stdout.write('\ncapability map is in sync with the shipped code.\n');
  process.exit(0);
}
