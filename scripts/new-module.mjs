// ============================================================
// DATAGLOW - New module scaffold
// ============================================================
// WHY this exists. Every module under js/ has to satisfy the same four gates
// before CI is green, and all four are easy to miss when starting a file from
// scratch:
//
//   * it parses under `node --check` (canvas inlines it into one <script>);
//   * it uses the outer-IIFE convention, so the inlined copy cannot leak names;
//   * the canvas copy is delimited by `/* ---- from <path> ---- */` markers,
//     which is how scripts/check-canvas-integrity.mjs finds and pins it;
//   * it is claimed by a capability in capability-map.manifest.json, or the
//     drift detector fails with UNDOCUMENTED_MODULE.
//
// This scaffold writes a stub that already satisfies the first three and prints
// the exact remaining steps for the fourth. It never touches canvas/index.html:
// inlining stays a deliberate act performed by an inject_*.py script, so a
// scaffolded file cannot change the shipped bundle by accident and
// `npm run check:canvas-integrity` is unaffected until you inline on purpose.
//
// USAGE:
//   npm run new-module -- js/area/my-thing.js
//   npm run new-module -- js/area/my-thing.js --namespace DataGlowMyThing
//   npm run new-module -- js/area/my-thing.js --esm       # pure engine, ESM
//   npm run new-module -- js/area/my-thing.js --dry-run   # print, write nothing
//
// Run with --help for the promote/inline path in full.

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(scriptDir);

export const HELP = `DataGlow module scaffold

  node scripts/new-module.mjs <js/path/to/module.js> [options]

Options
  --namespace <Name>  window global the IIFE attaches (default derived from the
                      file name, e.g. js/privacy/air-gap-mode.js -> DataGlowAirGapMode)
  --title <Text>      human title used in the file header (default derived)
  --esm               emit a pure ES module (named exports, no IIFE) instead of
                      the canvas-shaped IIFE. Use this for logic engines that the
                      root index.html imports and tests import directly.
  --no-markers        omit the canvas inline marker comments
  --dry-run           print the file to stdout and write nothing
  --force             overwrite an existing file
  --help              this text

After scaffolding
  1. Write the logic and a test under test/. Pure logic belongs in a module that
     does no DOM and no network, so node --test can cover it.
  2. Claim the file in capability-map.manifest.json (an existing capability's
     "files" list, or a new capability) and mention the path in the doc that
     capability points at, or npm run test:capdrift fails with UNDOCUMENTED_MODULE
     and MANIFEST_DOC_MISMATCH.
  3. If the module ships behind a flag, add it to flags.manifest.json and run
     npm run check:capability-map -- --update so the registry status stays honest.

Promote to the canvas surface (only when the module has UI or must run on web)
  4. Write inject_<feature>.py next to the existing ones (inject_shield_packs.py
     and inject_air_gap_mode.py are the two closest models). It inserts the file
     before window.addEventListener('appinstalled' and any CSS after the previous
     feature's CSS block. An ESM engine gets its export keywords stripped and is
     wrapped in an IIFE that attaches the window namespace; a file scaffolded
     without --esm is inlined verbatim, markers and all.
  5. python3 inject_<feature>.py   (canvas/index.html is authoritative; the
     script refuses to run twice so it cannot duplicate a block)
  6. Add the module to canvas/integrity.manifest.json under "tracked", then
     npm run check:canvas-integrity -- --update to record the two hashes.
  7. npm run check:canvas-integrity to confirm the gate is green.
`;

/** js/privacy/air-gap-mode.js -> DataGlowAirGapMode */
export function namespaceFor(modulePath) {
  const base = String(modulePath).split('/').pop().replace(/\.m?js$/, '');
  const pascal = base
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return 'DataGlow' + (pascal || 'Module');
}

/** js/privacy/air-gap-mode.js -> Air Gap Mode */
export function titleFor(modulePath) {
  const base = String(modulePath).split('/').pop().replace(/\.m?js$/, '');
  return base
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function header(rel, title) {
  return (
    '// ============================================================\n' +
    `// DATAGLOW - ${title}\n` +
    '// ============================================================\n' +
    '// Say WHY this module exists: the problem it solves and the decision behind\n' +
    '// its shape. What it does is already in the code below.\n' +
    `//\n// SOURCE OF TRUTH: ${rel}\n`
  );
}

/**
 * The scaffolded file. Pure string building so a test can assert on the output
 * without writing anything to the tree.
 */
export function renderModule({ path: rel, namespace, title, esm = false, markers = true }) {
  const ns = namespace || namespaceFor(rel);
  const label = title || titleFor(rel);
  const head = header(rel, label);

  if (esm) {
    return (
      head +
      '// Pure ES module: no DOM, no network, no storage, so node --test can cover\n' +
      '// it directly and inject_*.py can strip the export keywords when inlining.\n' +
      '\n' +
      `export const ${constName(ns)} = 1;\n` +
      '\n' +
      '/** Replace with the first real entry point. */\n' +
      'export function describe() {\n' +
      `  return { module: '${rel}', version: ${constName(ns)} };\n` +
      '}\n' +
      '\n' +
      `export const ${ns} = { version: ${constName(ns)}, describe };\n` +
      '\n' +
      "if (typeof window !== 'undefined') {\n" +
      `  window.${ns} = ${ns};\n` +
      '}\n'
    );
  }

  const open = markers ? `/* ---- from ${rel} ---- */\n` : '';
  const close = markers ? `/* ---- end ${rel} ---- */\n` : '';
  return (
    open +
    head +
    '// Outer IIFE: canvas/index.html inlines this file verbatim into one shared\n' +
    '// <script>, so nothing may leak into the global scope except the namespace\n' +
    '// attached at the bottom.\n' +
    ';(function () {\n' +
    "  'use strict';\n" +
    '\n' +
    '  var VERSION = 1;\n' +
    '\n' +
    '  /** Replace with the first real entry point. */\n' +
    '  function describe() {\n' +
    `    return { module: '${rel}', version: VERSION };\n` +
    '  }\n' +
    '\n' +
    `  window.${ns} = {\n` +
    '    version: VERSION,\n' +
    '    describe: describe\n' +
    '  };\n' +
    '})();\n' +
    close
  );
}

function constName(ns) {
  return ns
    .replace(/^DataGlow/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/^_/, '') + '_VERSION';
}

export function parseArgs(argv) {
  const opts = { path: '', namespace: '', title: '', esm: false, markers: true, dryRun: false, force: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--esm') opts.esm = true;
    else if (a === '--no-markers') opts.markers = false;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--namespace') { opts.namespace = argv[++i] || ''; }
    else if (a === '--title') { opts.title = argv[++i] || ''; }
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!opts.path) opts.path = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return opts;
}

/** Keep the scaffold inside js/ and inside the repo. */
export function validatePath(rel) {
  if (!rel) return 'a module path is required, for example js/area/my-thing.js';
  if (isAbsolute(rel)) return 'give a repo-relative path, for example js/area/my-thing.js';
  const norm = rel.split(sep).join('/');
  if (!norm.startsWith('js/')) return 'modules live under js/, so the path must start with js/';
  if (norm.includes('..')) return 'the path must not climb out of the repository';
  if (!/\.m?js$/.test(norm)) return 'the file name must end in .js';
  return '';
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`new-module: ${e.message}\n`);
    console.error(HELP);
    process.exit(1);
  }
  if (opts.help || !opts.path) {
    console.log(HELP);
    process.exit(opts.path || opts.help ? 0 : 1);
  }

  const problem = validatePath(opts.path);
  if (problem) {
    console.error(`new-module: ${problem}`);
    process.exit(1);
  }

  const rel = opts.path.split(sep).join('/');
  const abs = join(REPO_ROOT, rel);
  const source = renderModule({ path: rel, namespace: opts.namespace, title: opts.title, esm: opts.esm, markers: opts.markers });

  if (opts.dryRun) {
    process.stdout.write(source);
    return;
  }
  if (existsSync(abs) && !opts.force) {
    console.error(`new-module: ${rel} already exists. Pass --force to overwrite.`);
    process.exit(1);
  }

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, source, 'utf8');

  const ns = opts.namespace || namespaceFor(rel);
  console.log(`new-module: wrote ${relative(REPO_ROOT, abs)} (${opts.esm ? 'ES module' : 'IIFE'}, window.${ns})`);
  console.log('');
  console.log('Next:');
  console.log('  1. node --check ' + rel);
  console.log('  2. add a test under test/ and wire an npm script for it');
  console.log(`  3. claim ${rel} in capability-map.manifest.json and in the doc that capability points at`);
  console.log('  4. npm run test:capdrift');
  console.log('  To put it on the canvas surface, see: node scripts/new-module.mjs --help');
}

if (process.argv[1] && process.argv[1].endsWith('new-module.mjs')) {
  main();
}
