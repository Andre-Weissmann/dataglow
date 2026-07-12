// ============================================================
// DATAGLOW — Fuzzy Duplicate Radar: patients catch-rate benchmark
// ============================================================
// The Fuzzy Duplicate Radar (js/cleaning/fuzzy-dedup.js) surfaces near-duplicate
// text values for human review. This suite benchmarks it against a synthetic
// PATIENTS dataset — the healthcare shape DataGlow targets — instead of the
// generic claims fixtures the pure-similarity checks already cover.
//
// The dataset seeds 12 KNOWN near-duplicate patient records: for each, one
// canonical spelling plus one lightly-corrupted variant (typo, transposition,
// dropped letter, spacing/punctuation, common name-spelling drift). Every
// variant stays above the module's default 0.85 similarity gate, so a healthy
// detector should recover all 12. A block of clearly-distinct filler patients
// guards against a detector that "catches" everything by flagging noise.
//
// catch-rate = (seeded duplicate pairs the radar surfaces) / 12.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/fuzzy-dedup-patients.test.mjs
//
// The loader hook redirects the module's '../app-shell/duckdb-engine.js' import
// to the native node-duckdb-engine.mjs, so the exact production code under test
// runs byte-for-byte — only its DB backend is swapped for the run.

import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';
import { findFuzzyDuplicates } from '../js/cleaning/fuzzy-dedup.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// 12 seeded near-duplicate pairs: [canonical, near-duplicate variant].
const SEEDED_PAIRS = [
  ['Jonathan Meyer', 'Jonathan Meyar'],       // trailing-vowel typo
  ['Sarah Connor', 'Sarha Connor'],           // adjacent transposition
  ['Elizabeth Warren', 'Elizabeth Waren'],    // dropped double letter
  ['Mary-Jane Watson', 'Mary Jane Watson'],   // punctuation vs. space
  ['Michael Thompson', 'Micheal Thompson'],   // ae/ea drift
  ['Katherine Johnson', 'Katharine Johnson'], // e/a spelling variant
  ['Robert McDonald', 'Robert Macdonald'],    // Mc/Mac + case drift
  ['Priya Krishnan', 'Priya Krishnann'],      // doubled trailing letter
  ['Wei Zhang', 'Wei Zhamg'],                 // n/m OCR-style slip
  ['Olusegun Adebayo', 'Olusegun Adebayoo'],  // doubled trailing vowel
  ['Christopher Lee', 'Christoper Lee'],       // dropped internal letter
  ['Isabella Rossi', 'Isabela Rossi'],        // dropped double letter
];

// Clearly-distinct patients that must NOT be mistaken for one another.
const FILLER_NAMES = [
  'Amara Okonkwo', 'David Goldberg', 'Fatima Al-Sayed', 'Hiroshi Tanaka',
  'Lucia Fernandez', 'Marcus Webb', 'Nadia Petrova', 'Samuel Brooks',
  'Yuki Nakamura', 'Grace Mensah', 'Ethan Caldwell', 'Aisha Rahman',
];

function buildPatients() {
  const rows = [];
  let id = 1;
  SEEDED_PAIRS.forEach(([canonical, variant], groupIdx) => {
    rows.push({ patient_id: `P${String(id++).padStart(4, '0')}`, patient_name: canonical, dup_group: `dup-${groupIdx + 1}`, city: 'Springfield' });
    rows.push({ patient_id: `P${String(id++).padStart(4, '0')}`, patient_name: variant,   dup_group: `dup-${groupIdx + 1}`, city: 'Springfield' });
  });
  FILLER_NAMES.forEach((name) => {
    rows.push({ patient_id: `P${String(id++).padStart(4, '0')}`, patient_name: name, dup_group: '', city: 'Springfield' });
  });
  return rows;
}

// A radar pair "covers" a seeded group when both of its rows carry that group id.
function coveredGroups(radarPairs, rowsByRn) {
  const covered = new Set();
  for (const p of radarPairs) {
    const ga = rowsByRn.get(p.rowA);
    const gb = rowsByRn.get(p.rowB);
    if (ga && ga === gb && ga.startsWith('dup-')) covered.add(ga);
  }
  return covered;
}

async function main() {
  const rows = buildPatients();
  await createTableFromObjects('patients', rows);
  const cols = (await getTableSchema('patients')).map(s => ({ name: s.column_name, type: s.column_type }));

  // The radar assigns ROW_NUMBER() over the same NOT-NULL/LIMIT ordering we
  // inserted, so row N (1-based) maps to rows[N-1]; recover each row's group.
  const rowsByRn = new Map(rows.map((r, i) => [i + 1, r.dup_group]));

  const result = await findFuzzyDuplicates('patients', cols, { column: 'patient_name' });
  ok(result.column === 'patient_name', `radar targets the patient_name column (got '${result.column}')`);
  ok(Array.isArray(result.pairs), 'radar returns a pairs array');

  const covered = coveredGroups(result.pairs, rowsByRn);
  const caught = covered.size;
  const total = SEEDED_PAIRS.length;
  const catchRate = caught / total;

  console.log(`\n--- Fuzzy Duplicate Radar catch-rate (patients dataset) ---`);
  console.log(`seeded near-duplicate pairs: ${total}`);
  console.log(`pairs surfaced by radar (total): ${result.pairs.length}`);
  console.log(`seeded pairs caught: ${caught}`);
  console.log(`catch-rate: ${(catchRate * 100).toFixed(1)}%`);
  const missed = SEEDED_PAIRS.map((_, i) => `dup-${i + 1}`).filter(g => !covered.has(g));
  if (missed.length) console.log(`missed groups: ${missed.join(', ')}`);
  console.log(`-----------------------------------------------------------\n`);

  // The 12 variants all sit comfortably above the 0.85 gate (min observed
  // similarity ≈ 0.92), so a correct detector recovers every one.
  ok(caught === total, `catch-rate is 100% — all ${total} seeded near-duplicates surfaced (caught ${caught}/${total})`);
  ok(catchRate >= 0.9, `catch-rate meets the >=90% bar (got ${(catchRate * 100).toFixed(1)}%)`);

  // Guard against a trivially-permissive detector: the 12 distinct filler
  // patients must not be paired with anything.
  const fillerFalsePositives = result.pairs.filter(p => {
    const ga = rowsByRn.get(p.rowA);
    const gb = rowsByRn.get(p.rowB);
    return ga === '' || gb === '';
  });
  ok(fillerFalsePositives.length === 0, `no false positives among distinct filler patients (got ${fillerFalsePositives.length})`);

  await closeConnection();
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
