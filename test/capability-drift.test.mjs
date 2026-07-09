// ============================================================
// DATAGLOW — Capability-Map Drift Detector test suite
// ============================================================
// Unit-tests the pure, read-only checker in
// .github/scripts/capability-drift.mjs against throwaway fixture repos (each with
// its own js/, docs/ and capability-map.manifest.json) so the assertions are
// deterministic and never depend on the real tree. It then does a GATING run
// against the REAL repo root: the actual manifest must be in sync with the actual
// code, so this suite doubles as the CI merge gate (same role test:golden plays).
//
// RUN WITH:  node test/capability-drift.test.mjs      (no DuckDB, no network)

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck, renderReport } from '../.github/scripts/capability-drift.mjs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Build a fixture repo: js files, doc files (under docs/), and a manifest object.
function makeFixture({ jsFiles = {}, docFiles = {}, manifest }) {
  const root = mkdtempSync(join(tmpdir(), 'dataglow-capdrift-'));
  mkdirSync(join(root, 'js'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  for (const [name, body] of Object.entries(jsFiles)) writeFileSync(join(root, 'js', name), body);
  for (const [name, body] of Object.entries(docFiles)) writeFileSync(join(root, 'docs', name), body);
  if (manifest !== undefined) {
    writeFileSync(join(root, 'capability-map.manifest.json'), JSON.stringify(manifest, null, 2));
  }
  return root;
}

function main() {
  // --- Clean fixture: everything mapped, referenced, and exported → no drift.
  {
    const root = makeFixture({
      jsFiles: {
        'engine.js': 'export function query() { return 1; }\n',
        'clean.js': 'export const scrub = () => 2;\n',
      },
      docFiles: { 'capability-map.md': 'Engine `js/engine.js`. Cleaning `js/clean.js`.\n' },
      manifest: {
        docs: ['docs/capability-map.md'],
        capabilities: [
          { id: 'engine', name: 'Engine', platforms: ['browser', 'desktop'], files: ['js/engine.js'], symbols: [{ file: 'js/engine.js', name: 'query' }] },
          { id: 'clean', name: 'Cleaning', platforms: ['browser'], files: ['js/clean.js'] },
        ],
      },
    });
    const r = runCheck({ root });
    ok(r.totalDrift === 0, 'clean fixture: no drift');
    ok(r.capabilityCount === 2 && r.jsModuleCount === 2, 'clean fixture: counts reported');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Overclaim: a mapped backing file is gone → OVERCLAIM_FILE.
  {
    const root = makeFixture({
      jsFiles: { 'engine.js': 'export function query() {}\n' },
      docFiles: { 'capability-map.md': 'Engine `js/engine.js`. Ghost `js/ghost.js`.\n' },
      manifest: {
        docs: ['docs/capability-map.md'],
        capabilities: [
          { id: 'engine', name: 'Engine', files: ['js/engine.js'] },
          { id: 'ghost', name: 'Ghost', files: ['js/ghost.js'] },
        ],
      },
    });
    const r = runCheck({ root });
    ok(r.findings.overclaimFiles.some((f) => f.file === 'js/ghost.js'), 'overclaim: missing backing file is flagged');
    ok(r.totalDrift > 0, 'overclaim: drift is non-zero');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Overclaim: file exists but no longer exports the named symbol.
  {
    const root = makeFixture({
      jsFiles: { 'engine.js': 'export function renamedQuery() {}\n' },
      docFiles: { 'capability-map.md': 'Engine `js/engine.js`.\n' },
      manifest: {
        docs: ['docs/capability-map.md'],
        capabilities: [
          { id: 'engine', name: 'Engine', files: ['js/engine.js'], symbols: [{ file: 'js/engine.js', name: 'query' }] },
        ],
      },
    });
    const r = runCheck({ root });
    ok(r.findings.overclaimSymbols.some((f) => f.symbol === 'query'), 'overclaim: missing exported symbol is flagged');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Symbol detection: export-list form counts as exported (no false positive).
  {
    const root = makeFixture({
      jsFiles: { 'engine.js': 'function query() {}\nconst helper = 1;\nexport { query, helper };\n' },
      docFiles: { 'capability-map.md': 'Engine `js/engine.js`.\n' },
      manifest: {
        docs: ['docs/capability-map.md'],
        capabilities: [
          { id: 'engine', name: 'Engine', files: ['js/engine.js'], symbols: [{ file: 'js/engine.js', name: 'query' }] },
        ],
      },
    });
    const r = runCheck({ root });
    ok(r.findings.overclaimSymbols.length === 0, 'symbol: `export { query }` list form is recognized');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Underclaim: a shipped js/ module no capability maps → UNDOCUMENTED_MODULE.
  {
    const root = makeFixture({
      jsFiles: {
        'engine.js': 'export function query() {}\n',
        'surprise-feature.js': 'export function surprise() {}\n',
      },
      docFiles: { 'capability-map.md': 'Engine `js/engine.js`.\n' },
      manifest: {
        docs: ['docs/capability-map.md'],
        capabilities: [{ id: 'engine', name: 'Engine', files: ['js/engine.js'] }],
      },
    });
    const r = runCheck({ root });
    ok(
      r.findings.undocumentedModules.some((f) => f.file === 'js/surprise-feature.js'),
      'underclaim: undocumented shipped module is flagged',
    );
    ok(!r.findings.undocumentedModules.some((f) => f.file === 'js/engine.js'), 'underclaim: documented module is NOT flagged');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Dangling doc ref: docs cite a js/ file that does not exist.
  {
    const root = makeFixture({
      jsFiles: { 'engine.js': 'export function query() {}\n' },
      docFiles: { 'capability-map.md': 'Engine `js/engine.js`. Old `js/removed.js`.\n' },
      manifest: {
        docs: ['docs/capability-map.md'],
        // 'removed.js' is only in the prose, not the manifest → dangling, not overclaim.
        capabilities: [{ id: 'engine', name: 'Engine', files: ['js/engine.js'] }],
      },
    });
    const r = runCheck({ root });
    ok(r.findings.danglingDocRefs.some((f) => f.ref === 'js/removed.js'), 'dangling: doc-only missing js/ ref is flagged');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Manifest drift: a capability whose files the docs never mention.
  {
    const root = makeFixture({
      jsFiles: { 'engine.js': 'export function query() {}\n', 'secret.js': 'export const s = 1;\n' },
      docFiles: { 'capability-map.md': 'Engine `js/engine.js`.\n' },
      manifest: {
        docs: ['docs/capability-map.md'],
        capabilities: [
          { id: 'engine', name: 'Engine', files: ['js/engine.js'] },
          { id: 'secret', name: 'Secret', files: ['js/secret.js'] }, // exists, but undocumented in prose
        ],
      },
    });
    const r = runCheck({ root });
    ok(r.findings.manifestDocMismatch.some((f) => f.id === 'secret'), 'manifest-drift: capability absent from docs is flagged');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Platforms: a capability with no `platforms` field → INVALID_PLATFORMS.
  {
    const root = makeFixture({
      jsFiles: { 'engine.js': 'export function query() {}\n' },
      docFiles: { 'capability-map.md': 'Engine `js/engine.js`.\n' },
      manifest: {
        docs: ['docs/capability-map.md'],
        capabilities: [{ id: 'engine', name: 'Engine', files: ['js/engine.js'] }],
      },
    });
    const r = runCheck({ root });
    ok(r.findings.invalidPlatforms.some((f) => f.id === 'engine'), 'platforms: missing `platforms` is flagged');
    ok(r.totalDrift > 0, 'platforms: missing `platforms` counts as drift');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Platforms: an empty list and an unknown token are both rejected.
  {
    const root = makeFixture({
      jsFiles: { 'a.js': 'export const a = 1;\n', 'b.js': 'export const b = 2;\n' },
      docFiles: { 'capability-map.md': 'A `js/a.js`. B `js/b.js`.\n' },
      manifest: {
        docs: ['docs/capability-map.md'],
        capabilities: [
          { id: 'a', name: 'A', platforms: [], files: ['js/a.js'] },
          { id: 'b', name: 'B', platforms: ['browser', 'watch'], files: ['js/b.js'] },
        ],
      },
    });
    const r = runCheck({ root });
    ok(r.findings.invalidPlatforms.some((f) => f.id === 'a'), 'platforms: empty list is flagged');
    ok(r.findings.invalidPlatforms.some((f) => f.id === 'b' && f.reasons.some((x) => /watch/.test(x))),
      'platforms: unknown token is flagged with its value');
    rmSync(root, { recursive: true, force: true });
  }

  // --- Platforms: a valid `platformsByFile` override does not false-positive,
  //     but one pointing at an unmapped file or holding a bad token is flagged.
  {
    const root = makeFixture({
      jsFiles: { 'a.js': 'export const a = 1;\n', 'b.js': 'export const b = 2;\n' },
      docFiles: { 'capability-map.md': 'A `js/a.js`. B `js/b.js`.\n' },
      manifest: {
        docs: ['docs/capability-map.md'],
        capabilities: [
          { id: 'ok', name: 'Ok', platforms: ['browser', 'desktop'], files: ['js/a.js', 'js/b.js'],
            platformsByFile: { 'js/b.js': ['browser'] } },
        ],
      },
    });
    ok(runCheck({ root }).findings.invalidPlatforms.length === 0, 'platforms: valid platformsByFile override is accepted');
    rmSync(root, { recursive: true, force: true });

    const root2 = makeFixture({
      jsFiles: { 'a.js': 'export const a = 1;\n' },
      docFiles: { 'capability-map.md': 'A `js/a.js`.\n' },
      manifest: {
        docs: ['docs/capability-map.md'],
        capabilities: [
          { id: 'bad', name: 'Bad', platforms: ['browser'], files: ['js/a.js'],
            platformsByFile: { 'js/ghost.js': ['browser'], 'js/a.js': ['nope'] } },
        ],
      },
    });
    const r2 = runCheck({ root: root2 });
    ok(r2.findings.invalidPlatforms.some((f) => f.id === 'bad' && f.reasons.some((x) => /ghost/.test(x))),
      'platforms: platformsByFile referencing an unmapped file is flagged');
    ok(r2.findings.invalidPlatforms.some((f) => f.id === 'bad' && f.reasons.some((x) => /nope/.test(x))),
      'platforms: platformsByFile with an invalid token is flagged');
    rmSync(root2, { recursive: true, force: true });
  }

  // --- Missing manifest → treated as drift (non-zero), with an error string.
  {
    const root = makeFixture({ jsFiles: { 'engine.js': '//\n' }, docFiles: {} });
    const r = runCheck({ root });
    ok(r.manifestPresent === false && r.totalDrift > 0, 'missing manifest: reported as drift');
    ok(typeof r.error === 'string' && /Manifest not found/.test(r.error), 'missing manifest: error message set');
    rmSync(root, { recursive: true, force: true });
  }

  // --- renderReport: stable title + states the fix-in-PR guidance on drift.
  {
    const root = makeFixture({
      jsFiles: { 'engine.js': 'export function query() {}\n', 'orphan.js': '//\n' },
      docFiles: { 'capability-map.md': 'Engine `js/engine.js`.\n' },
      manifest: { docs: ['docs/capability-map.md'], capabilities: [{ id: 'engine', name: 'Engine', files: ['js/engine.js'] }] },
    });
    const md = renderReport(runCheck({ root }));
    ok(md.includes('Capability-Map Drift Detector'), 'render: has a title');
    ok(/Drift detected/.test(md) && /orphan\.js/.test(md), 'render: names the drift and the offending module');
    rmSync(root, { recursive: true, force: true });
  }

  // --- GATING run against the REAL repo: the shipped manifest must be in sync.
  {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const r = runCheck({ root: repoRoot });
    console.log(renderReport(r));
    ok(r.manifestPresent === true, 'real repo: capability-map.manifest.json is present');
    ok(r.jsModuleCount > 0 && r.capabilityCount > 0, 'real repo: manifest and js/ are non-empty');
    ok(r.totalDrift === 0, 'real repo: capability map is in sync with shipped code (GATE)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
