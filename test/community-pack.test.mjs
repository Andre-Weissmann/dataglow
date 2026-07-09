// ============================================================
// DATAGLOW — Community Pack Sharing test suite (Stage D)
// ============================================================
// Covers the pure export / strict-validate / import logic:
//   - a built-in Retail/Finance pack round-trips: export → import → same rules,
//   - the hand-written healthcare pack and the empty `none` pack are NOT portable,
//   - a valid hand-authored envelope imports and compiles,
//   - malformed / malicious-shaped envelopes are REJECTED with clear errors,
//   - an imported pack is confined to the annotate-only sandbox: its rule layers
//     are DERIVED from `kind`, so it can never target a core layer (unit_tests),
//   - an imported pack actually runs through applyDomainPack without hard-failing.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/community-pack.test.mjs

import {
  PACK_KIND,
  PACK_SCHEMA_VERSION,
  ALLOWED_RULE_KINDS,
  validateImportedPack,
  importPack,
  exportPack,
  serializePack,
  exportablePackNames,
} from '../js/teaching/community-pack.js';
import { DOMAIN_PACKS, PACK_RULE_LAYERS, applyDomainPack } from '../js/validation/domain-physics.js';

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A minimal, valid hand-authored envelope (one rule of each kind).
function validEnvelope() {
  return {
    kind: PACK_KIND,
    schemaVersion: PACK_SCHEMA_VERSION,
    pack: {
      name: 'logistics',
      label: 'Logistics / Shipping',
      description: 'Merge guards for tracking numbers and outlier context for transit times.',
      rules: [
        {
          kind: 'no-merge',
          id: 'logistics-tracking-no-merge',
          description: 'Tracking-number columns are not auto-merged.',
          match: { pattern: 'tracking|awb|waybill', flags: 'i' },
          note: 'Similar tracking numbers are distinct shipments.',
        },
        {
          kind: 'outlier-context',
          id: 'logistics-transit-outlier',
          description: 'Transit-time outliers are expected around peak season.',
          match: { pattern: 'transit|delivery[_\\s-]?days|lead[_\\s-]?time', flags: 'i', numericOnly: true },
          packLabel: 'logistics',
          reason: 'peak-season backlogs stretch delivery times.',
        },
      ],
    },
  };
}

function main() {
  // ============================================================
  // 1) Constants / wiring
  // ============================================================
  ok(PACK_KIND === 'dataglow-domain-pack', 'const: envelope kind tag is stable');
  ok(typeof PACK_SCHEMA_VERSION === 'number', 'const: schema version is a number');
  ok(ALLOWED_RULE_KINDS.every(k => k in PACK_RULE_LAYERS),
    'const: allowed rule kinds are exactly the compiler-known kinds');

  // ============================================================
  // 2) Export portability
  // ============================================================
  ok(exportPack(DOMAIN_PACKS.retail).ok === true, 'export: retail (descriptor-based) is portable');
  ok(exportPack(DOMAIN_PACKS.finance).ok === true, 'export: finance (descriptor-based) is portable');
  ok(exportPack(DOMAIN_PACKS.healthcare).ok === false, 'export: healthcare (hand-written) is NOT portable');
  ok(exportPack(DOMAIN_PACKS.none).ok === false, 'export: the empty none pack is NOT portable');
  ok(exportPack(DOMAIN_PACKS.healthcare).reason.length > 0, 'export: a non-portable pack explains why');
  const names = exportablePackNames();
  ok(names.includes('retail') && names.includes('finance') && !names.includes('healthcare'),
    'export: exportablePackNames lists exactly the descriptor-based packs');

  // ============================================================
  // 3) Round-trip: export a built-in pack, re-import it, rules match
  // ============================================================
  const { json } = serializePack(DOMAIN_PACKS.retail);
  ok(typeof json === 'string' && json.includes('retail-sku-no-merge'), 'roundtrip: serialize produces JSON text');
  const reparsed = JSON.parse(json);
  const back = importPack(reparsed);
  ok(back.ok === true, 'roundtrip: the exported retail pack re-imports cleanly');
  ok(back.pack.rules.length === DOMAIN_PACKS.retail.rules.length,
    'roundtrip: rule count is preserved');
  ok(back.pack.rules.map(r => r.id).join(',') === DOMAIN_PACKS.retail.rules.map(r => r.id).join(','),
    'roundtrip: rule ids are preserved in order');
  ok(back.pack.rules.every(r => Object.values(PACK_RULE_LAYERS).includes(r.appliesToLayer)),
    'roundtrip: imported rules keep an annotate-only target layer');

  // ============================================================
  // 4) A valid hand-authored envelope validates + imports
  // ============================================================
  const v = validateImportedPack(validEnvelope());
  ok(v.valid === true, 'validate: a well-formed hand-authored pack passes');
  ok(v.errors.length === 0, 'validate: no errors on a valid pack');
  const imp = importPack(validEnvelope());
  ok(imp.ok === true && imp.pack.rules.length === 2, 'import: a valid pack compiles to runtime rules');

  // ============================================================
  // 5) Rejections — malformed / hostile shapes
  // ============================================================
  const bad = (mutate, label) => {
    const env = validEnvelope();
    mutate(env);
    const r = validateImportedPack(env);
    ok(r.valid === false && r.errors.length > 0, `reject: ${label}`);
  };
  ok(validateImportedPack(null).valid === false, 'reject: null input');
  ok(validateImportedPack('a string').valid === false, 'reject: non-object input');
  ok(validateImportedPack([]).valid === false, 'reject: array input');
  bad(e => { e.kind = 'something-else'; }, 'wrong envelope kind tag');
  bad(e => { e.schemaVersion = 99; }, 'unknown schema version');
  bad(e => { e.extra = 1; }, 'unknown envelope key');
  bad(e => { delete e.pack; }, 'missing pack');
  bad(e => { e.pack.name = 'healthcare'; }, 'reserved pack name (healthcare)');
  bad(e => { e.pack.name = 'none'; }, 'reserved pack name (none)');
  bad(e => { e.pack.injected = true; }, 'unknown pack key');
  bad(e => { e.pack.rules = []; }, 'empty rules array');
  bad(e => { e.pack.rules = 'nope'; }, 'rules not an array');
  bad(e => { e.pack.rules[0].kind = 'core-hijack'; }, 'unknown rule kind');
  bad(e => { e.pack.rules[0].appliesToLayer = 'unit_tests'; }, 'rule tries to declare its own target layer');
  bad(e => { e.pack.rules[0].match = { pattern: 'x', flags: 'g' }; }, 'disallowed stateful regex flag (g)');
  bad(e => { e.pack.rules[0].match = { pattern: '(' }; }, 'uncompilable regex pattern');
  bad(e => { e.pack.rules[0].match = { pattern: 'x'.repeat(10000) }; }, 'oversized regex pattern');
  bad(e => { delete e.pack.rules[0].match; }, 'rule missing match');
  bad(e => { e.pack.rules[0].id = ''; }, 'blank rule id');
  bad(e => { e.pack.rules.push({ ...e.pack.rules[0] }); }, 'duplicate rule id');
  bad(e => { for (let i = 0; i < 100; i++) e.pack.rules.push({ ...e.pack.rules[0], id: `r${i}` }); }, 'too many rules');
  bad(e => { delete e.pack.rules[0].note; }, 'no-merge rule missing required note');

  // ============================================================
  // 6) Sandbox: an imported rule's layer is DERIVED, never taken from input
  // ============================================================
  // Even if the input tries to smuggle a core-layer target, it's rejected (unknown
  // key) — and the compiled rule's appliesToLayer always comes from PACK_RULE_LAYERS.
  const imp2 = importPack(validEnvelope());
  ok(imp2.pack.rules.every(r => Object.values(PACK_RULE_LAYERS).includes(r.appliesToLayer)),
    'sandbox: every imported rule targets an annotate-only layer from PACK_RULE_LAYERS');
  ok(imp2.pack.rules.every(r => r.appliesToLayer !== 'unit_tests'),
    'sandbox: no imported rule can target the unit_tests core layer');

  // ============================================================
  // 7) An imported pack runs through the engine without hard-failing
  // ============================================================
  const layerResults = {
    categorical_consistency: { status: 'warn', summary: 'clusters', clusters: [{ column: 'tracking_id', sensitive: false, members: ['A', 'B'] }], detail: [] },
    outlier_detection: { status: 'warn', summary: 'outliers', detail: ['"transit_days": 3 high outliers'] },
  };
  DOMAIN_PACKS.__test_logistics = imp2.pack;
  let threw = false;
  let summary;
  try {
    summary = applyDomainPack(layerResults, '__test_logistics');
  } catch (e) { threw = true; }
  delete DOMAIN_PACKS.__test_logistics;
  ok(!threw, 'engine: applying an imported pack never throws');
  ok(summary && Array.isArray(summary.annotations), 'engine: imported pack produces an annotations summary');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
