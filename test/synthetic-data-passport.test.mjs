// ============================================================
// DATAGLOW — Governed Synthetic Data Passport unit tests
// (Trust Passport, Batch 4 — the finale)
// ============================================================
// Exercises js/privacy/synthetic-data-passport.js with NO browser, NO network,
// and NO DuckDB. It builds a passport from a REAL Synthetic Twin output
// (js/privacy/synthetic-twin.js, seeded RNG so it is deterministic), asserts the
// composed Data Nutrition Label carries isSynthetic:true and the source checks,
// proves the HONEST-NAMING contract in both directions (a real Laplace-DP twin
// reports formal DP with its ε; a heuristic generator reports NO formal
// guarantee and never gets upgraded), seals the passport via batch 3 and
// re-verifies it (including tamper detection), and includes a zero-upload /
// honest-naming source guard.
//
// RUN WITH:  node test/synthetic-data-passport.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSyntheticDataPassport,
  sealSyntheticPassport,
  describeSyntheticGeneration,
  renderPassportSummaryLines,
  exportPassportAsJSON,
  SYNTHETIC_PASSPORT_KIND,
  SYNTHETIC_PASSPORT_SCHEMA_VERSION,
  SYNTHETIC_PASSPORT_DISCLAIMER,
} from '../js/privacy/synthetic-data-passport.js';
import { generateSyntheticTwin } from '../js/privacy/synthetic-twin.js';
import { anonymizeAggregateExport } from '../js/privacy/privacy-budget.js';
import { verifySeal } from '../js/provenance/verifiable-check-seal.js';
import { CHECK_SEAL_KIND } from '../js/provenance/verifiable-check-seal.js';
import { createProvenanceChain } from '../js/provenance/provenance.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Deterministic PRNG so the twin output (and thus the whole test) is stable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const columns = [
  { name: 'age', type: 'INTEGER' },
  { name: 'region', type: 'VARCHAR' },
];
function sourceRows() {
  return [
    { age: 30, region: 'North' }, { age: 41, region: 'South' },
    { age: 25, region: 'North' }, { age: 52, region: 'East' },
    { age: 38, region: 'West' }, { age: 29, region: 'North' },
  ];
}

function buildTwin(epsilon = 5) {
  return generateSyntheticTwin({
    columns, rows: sourceRows(), epsilon, bins: 8, rng: mulberry32(0x1234), count: 12,
  });
}

async function main() {
  // --- 1. describeSyntheticGeneration: honest DP recognition ----------------
  {
    const twin = buildTwin(3);
    const desc = describeSyntheticGeneration(twin);
    ok(desc.formalDifferentialPrivacy === true, 'Synthetic Twin output is recognized as formal DP');
    ok(desc.epsilon === 3, 'the twin ε is carried through');
    ok(desc.privacyModel === 'differential-privacy', 'privacyModel is differential-privacy for the twin');
    ok(/differential-privacy mechanism/i.test(desc.privacyGuaranteeStatement)
      && /ε=3/.test(desc.privacyGuaranteeStatement),
      'guarantee statement names the DP mechanism and ε');
    // Honest naming: even for a real DP twin, no HIPAA / anonymized upgrade.
    ok(/NOT an audited anonymization/i.test(desc.privacyGuaranteeStatement),
      'DP guarantee statement refuses the anonymization/HIPAA upgrade');
    ok(desc.generatorDisclaimer && /not been independently audited/i.test(desc.generatorDisclaimer),
      "the twin's own disclaimer is carried verbatim");
    ok(desc.parameters.epsilon === 3,
      'recorded generation parameters (ε) are carried');
  }

  // --- 2. describeSyntheticGeneration: heuristic gets NO upgrade ------------
  {
    // A generator that declares no DP mechanism and no ε.
    const heuristic = { method: 'shuffle-and-jitter (heuristic)', kind: 'some-heuristic' };
    const desc = describeSyntheticGeneration(heuristic);
    ok(desc.formalDifferentialPrivacy === false, 'a heuristic generator is NOT formal DP');
    ok(desc.privacyModel === 'none-declared', 'privacyModel is none-declared for a heuristic');
    ok(/No formal privacy guarantee is claimed/i.test(desc.privacyGuaranteeStatement),
      'heuristic guarantee statement says plainly that no formal guarantee applies');
    ok(/potentially re-identifiable/i.test(desc.privacyGuaranteeStatement),
      'heuristic guarantee statement warns the output may be re-identifiable');

    // A caller that hands a bare ε but no mechanism and no explicit assertion
    // must NOT be upgraded to formal DP on our own.
    const bareEps = { method: 'noise?', epsilon: 2 };
    ok(describeSyntheticGeneration(bareEps).formalDifferentialPrivacy === false,
      'a bare ε with no DP mechanism/assertion is NOT upgraded to formal DP');

    // An explicit caller assertion false ALWAYS wins, even with a DP-looking mechanism.
    const overridden = { mechanism: 'Laplace', epsilon: 1, formalDifferentialPrivacy: false };
    ok(describeSyntheticGeneration(overridden).formalDifferentialPrivacy === false,
      'an explicit formalDifferentialPrivacy:false is never overridden');
  }

  // --- 3. The DP aggregate export path is also recognized -------------------
  {
    const agg = anonymizeAggregateExport({ total_claims: 1200, avg_amount: 84.2 }, 1.5);
    const desc = describeSyntheticGeneration(agg);
    ok(desc.formalDifferentialPrivacy === true && desc.epsilon === 1.5,
      'the DP aggregate export (Laplace, ε) is recognized as formal DP');
  }

  // --- 4. buildSyntheticDataPassport composes the label + synthetic block ---
  const twin = buildTwin(5);
  const chain = createProvenanceChain();
  await chain.append({ op: 'load', description: 'Loaded patients.csv' });
  await chain.append({ op: 'clean', description: 'Trimmed region whitespace' });

  const passport = buildSyntheticDataPassport({
    generation: twin,
    dataset: { name: 'Patients (synthetic)', table: 'patients', rowCount: twin.rows.length, columnNames: twin.columns },
    custody: chain,
    assumptions: [{ ts: 0, source: 'analyst', action: 'assumed North includes NW' }],
    checks: [
      { layer: 'ranges', name: 'Expected Range', status: 'pass', summary: 'age within 0-120' },
      { layer: 'semantic', name: 'Semantic Metrics Layer', status: 'warn', summary: 'region cardinality high' },
    ],
    generatedAt: '2026-07-11T00:00:00.000Z',
  });

  {
    ok(passport.kind === SYNTHETIC_PASSPORT_KIND, 'passport has the correct kind');
    ok(passport.schemaVersion === SYNTHETIC_PASSPORT_SCHEMA_VERSION, 'passport carries the schema version');
    ok(passport.generatedAt === '2026-07-11T00:00:00.000Z', 'passport honours an explicit generatedAt');
    // Container is a real Data Nutrition Label with isSynthetic forced true.
    ok(passport.label && passport.label.kind === 'dataglow-data-nutrition-label',
      'passport embeds a real Data Nutrition Label (batch 2)');
    ok(passport.label.isSynthetic === true, 'embedded label has isSynthetic:true (the whole point)');
    // Source checks (the batch-1 Semantic/Metrics Layer connection) travel through.
    ok(passport.label.checksRun.length === 2
      && passport.label.checksRun.some(c => c.name === 'Semantic Metrics Layer'),
      'source-data checks (incl. Semantic/Metrics Layer) are carried in the label');
    ok(passport.label.custodyChain.length === 2, 'the source custody chain is carried in the label');
    // Synthetic block is honest.
    ok(passport.synthetic.formalDifferentialPrivacy === true, 'synthetic block records formal DP for the twin');
    ok(passport.synthetic.epsilon === 5, 'synthetic block records ε=5');
    ok(passport.synthetic.utility && passport.synthetic.utility.columnsCompared === 2,
      'synthetic block summarizes the real-vs-synthetic utility comparison');
    ok(/not a privacy guarantee/i.test(passport.synthetic.utility.note),
      'utility note states it is not a privacy guarantee');
    ok(passport.synthetic.adversarial === null,
      'adversarial is null unless a caller supplies a real robustness summary (not auto-derived)');
    ok(/potentially re-identifiable/i.test(passport.disclaimer) || /NOT a HIPAA/i.test(passport.disclaimer),
      'passport disclaimer carries the honest-naming caveats');
    // Round-trips losslessly.
    const json = exportPassportAsJSON(passport);
    ok(JSON.parse(json).synthetic.epsilon === 5, 'passport round-trips losslessly through JSON');
  }

  // --- 5. buildSyntheticDataPassport refuses an empty generation record -----
  {
    let threw = false;
    try { buildSyntheticDataPassport({ dataset: { name: 'x' } }); }
    catch (e) { threw = /ctx.generation .* is required/i.test(e.message); }
    ok(threw, 'buildSyntheticDataPassport refuses to build with no generation record');
  }

  // --- 6. sealSyntheticPassport: opt-in seal, attached + verifiable ---------
  const csv = 'age,region\n30,North\n41,South';
  const sealed = await sealSyntheticPassport(passport, {
    data: csv,
    dataglow: { version: 'test', build: 'unit' },
    generatedAt: '2026-07-11T00:00:00.000Z',
  });
  {
    ok(sealed !== passport, 'sealSyntheticPassport returns a NEW passport (input not mutated)');
    ok(passport.label.custodyChain.seals === undefined,
      'the ORIGINAL passport label is not mutated (no seals array added)');
    ok(sealed.seal && sealed.seal.kind === CHECK_SEAL_KIND, 'sealed passport carries a batch-3 seal');
    ok(Array.isArray(sealed.label.custodyChain.seals) && sealed.label.custodyChain.seals.length === 1,
      'seal is attached additively to the label custodyChain.seals array');
    ok(sealed.label.custodyChain.finalHash === passport.label.custodyChain.finalHash,
      'attaching the seal does not change the batch-2 custodyChain.finalHash');
    ok(sealed.seal.labelAnchor === passport.label.custodyChain.finalHash,
      'seal is anchored to the label custodyChain.finalHash');
    // The seal binds the generation parameters: its result records the ε/method.
    const statusClaim = sealed.seal.disclosedClaims.find(c => c.type === 'result_status');
    ok(statusClaim && statusClaim.value === 'generated-with-dp',
      'seal result_status reflects generated-with-dp for the DP twin');
    // It genuinely verifies against the fingerprinted synthetic output.
    const v = await verifySeal(sealed.seal, csv);
    ok(v.valid === true && v.commitmentValid === true && v.dataMatch === true,
      'sealed passport verifies against the synthetic output it was sealed over');
    // And TAMPERING the synthetic output fails the data match (the key property).
    const vBad = await verifySeal(sealed.seal, csv + '\n99,Tampered');
    ok(vBad.dataMatch === false && vBad.valid === false,
      'TAMPER DETECTED: modified synthetic output does not match the sealed fingerprint');
  }

  // --- 7. sealSyntheticPassport requires a data fingerprint -----------------
  {
    let threw = false;
    try { await sealSyntheticPassport(passport, {}); }
    catch (e) { threw = /data fingerprint is required/i.test(e.message); }
    ok(threw, 'sealSyntheticPassport (via batch 3) refuses to mint a seal bound to no data');

    let threw2 = false;
    try { await sealSyntheticPassport({ kind: 'not-a-passport' }, { data: csv }); }
    catch (e) { threw2 = /must be a synthetic data passport/i.test(e.message); }
    ok(threw2, 'sealSyntheticPassport rejects a non-passport first argument');
  }

  // --- 8. Human-readable summary leads with the privacy line ----------------
  {
    const lines = renderPassportSummaryLines(passport);
    ok(lines[0] === 'Governed Synthetic Data Passport', 'summary is titled');
    ok(lines.some(l => /Privacy model: differential privacy \(ε=5\)/.test(l)),
      'summary states the privacy model and ε');
    ok(lines.some(l => /Privacy guarantee:/.test(l)), 'summary carries the honest privacy-guarantee line');
    // A heuristic passport summary must say "none declared".
    const heuristicPassport = buildSyntheticDataPassport({
      generation: { method: 'shuffle (heuristic)' },
      dataset: { name: 'H (synthetic)' },
    });
    const hl = renderPassportSummaryLines(heuristicPassport);
    ok(hl.some(l => /Privacy model: none declared/.test(l)),
      'a heuristic passport summary reports "none declared"');
  }

  // --- 9. Zero-upload + honest-naming source guard --------------------------
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'js', 'privacy', 'synthetic-data-passport.js'), 'utf8');
    const netRe = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\b/;
    ok(!netRe.test(src), 'zero-upload: the module contains no network primitive');
    // Honest naming: any line mentioning a forbidden over-claim must also negate it.
    const forbidden = ['anonymized', 'HIPAA', 'certification', 'certified'];
    const srcLines = src.split('\n');
    for (const term of forbidden) {
      const offending = srcLines.filter(l =>
        new RegExp(`\\b${term}\\b`, 'i').test(l)
        && !/\b(not|never|no|nor|isn't|without)\b/i.test(l));
      ok(offending.length === 0, `honest-naming: "${term}" only ever appears in a disclaiming line`);
    }
    ok(typeof SYNTHETIC_PASSPORT_DISCLAIMER === 'string' && /NOT a certification/i.test(SYNTHETIC_PASSPORT_DISCLAIMER),
      'the exported disclaimer refuses the certification claim');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
