// ============================================================
// DATAGLOW — Gen 8 Trust & Adversarial Suite test file
// ============================================================
// Verifies the six Gen 8 features end-to-end against real logic:
//   1. Devil's Advocate Mode      — robust vs. sensitive verdict
//   2. Data Provenance Trail      — hash-chains, and tamper is detected
//   3. Confidence-Aware Narration — per-claim confidence badges/tiers
//   4. On-Device Anomaly Explainer— feature-attribution reason on a golden outlier
//   5. Synthetic Adversarial Gen  — schema-matched file with seeded issue categories
//   6. (Benford teaching passthrough is covered in validation-layers.test.mjs)
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/trust-adversarial-suite.test.mjs
//
// The production modules import '../js/duckdb-engine.js'; the loader hook
// transparently redirects that to the native node-duckdb-engine.mjs.

import { createTableFromObjects, getTableSchema, runQuery, closeConnection } from './node-duckdb-engine.mjs';

import { createProvenanceChain, hashBytes } from '../js/provenance.js';
import { attackAnalysis } from '../js/devils-advocate.js';
import { buildStoryClaims } from '../js/story.js';
import { scoreClaimConfidence } from '../js/validation.js';
import { explainAnomaly, scoreMultivariateAnomalies } from '../js/ondevice-ml.js';
import { generateAdversarialDataset } from '../js/synthetic-adversarial.js';
import { buildGoldenDataset } from '../js/loaders.js';
import { runAllLayers } from '../js/validation.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];

async function makeDataset(table, rows) {
  await createTableFromObjects(table, rows);
  const schema = await getTableSchema(table);
  return {
    table,
    cols: schema.map(s => ({ name: s.column_name, type: s.column_type })),
    rowCount: rows.length,
    loadedAt: Date.now(),
  };
}

async function main() {
  // ============================================================
  // Feature 2 — Data Provenance Trail (Chain of Custody)
  // ============================================================
  const h1 = await hashBytes(new TextEncoder().encode('hello'));
  const h2 = await hashBytes(new TextEncoder().encode('hello'));
  const h3 = await hashBytes(new TextEncoder().encode('world'));
  ok(/^[0-9a-f]{64}$/.test(h1), 'provenance: hashBytes returns a 64-char SHA-256 hex digest');
  ok(h1 === h2, 'provenance: hashBytes is deterministic for identical bytes');
  ok(h1 !== h3, 'provenance: hashBytes differs for different bytes');

  const chain = createProvenanceChain();
  const g = await chain.append('load', 'Loaded raw file (100 rows)', { rows: 100 }, h1);
  const c = await chain.append('clean', 'Dropped 5 null rows', { removed: 5 });
  const m = await chain.append('merge', 'Merged "FRA" → "France"', { column: 'country' });
  ok(chain.length === 3, 'provenance: three steps recorded');
  ok(g.parentHash === '0'.repeat(64), 'provenance: genesis step links to the zero parent hash');
  ok(c.parentHash === g.hash && m.parentHash === c.hash, 'provenance: each step links to its parent hash (Merkle-style)');

  const okRes = await chain.verify();
  ok(okRes.valid && okRes.brokenAt === -1, 'provenance: an untouched chain verifies as intact');

  // Tamper: mutate a recorded step's description in place. append() returns the
  // internal entry, so mutating it simulates an after-the-fact edit.
  c.description = 'Dropped 0 null rows (tampered)';
  const tampered = await chain.verify();
  ok(!tampered.valid, 'provenance: tampering with a step is detected (chain no longer verifies)');
  ok(tampered.brokenAt === 1, `provenance: tamper is localized to the modified step (brokenAt=${tampered.brokenAt})`);

  // Export round-trips as JSON.
  const exported = JSON.parse(chain.exportTrail('json'));
  ok(Array.isArray(exported.steps) && exported.steps.length === 3, 'provenance: exportTrail(json) emits all steps');

  // ============================================================
  // Feature 1 — Devil's Advocate Mode
  // ============================================================
  // A tight, uniform metric across two balanced groups → should be robust.
  const robustRows = [];
  for (let i = 0; i < 200; i++) {
    robustRows.push({ value: 100 + (i % 5), region: i % 2 === 0 ? 'A' : 'B' });
  }
  const robustReport = attackAnalysis({ columns: ['value', 'region'], rows: robustRows }, { log: false });
  ok(robustReport.robust === true, `devils-advocate: tight balanced data yields a robust verdict ("${robustReport.verdict}")`);
  ok(robustReport.checks.length >= 3, 'devils-advocate: ran bootstrap + trim + subgroup checks');
  ok(robustReport.headline && robustReport.headline.column === 'value', 'devils-advocate: identified the numeric metric column');

  // A metric dominated by a few extreme values → should be sensitive.
  const sensitiveRows = [];
  for (let i = 0; i < 200; i++) sensitiveRows.push({ value: 1, region: i < 195 ? 'A' : 'B' });
  sensitiveRows[0].value = 100000; sensitiveRows[1].value = 90000; sensitiveRows[2].value = 80000;
  const sensitiveReport = attackAnalysis({ columns: ['value', 'region'], rows: sensitiveRows }, { log: false });
  ok(sensitiveReport.robust === false, `devils-advocate: outlier-driven data yields a sensitive verdict ("${sensitiveReport.verdict}")`);
  ok(/sensitive to/i.test(sensitiveReport.verdict), 'devils-advocate: sensitive verdict names the failing check(s)');

  // ============================================================
  // Feature 3 — Confidence-Aware Auto-Narration (per-claim scoring)
  // ============================================================
  ok(scoreClaimConfidence({ n: 100, missingRate: 0 }).grade === 'A', 'narration: a large, complete claim scores grade A');
  const smallClaim = scoreClaimConfidence({ n: 8, missingRate: 0 });
  ok(['C', 'D'].includes(smallClaim.grade), `narration: a tiny-n claim scores grade C/D (got ${smallClaim.grade})`);
  const highMissing = scoreClaimConfidence({ n: 100, missingRate: 0.5 });
  ok(highMissing.score < scoreClaimConfidence({ n: 100, missingRate: 0 }).score, 'narration: higher missing rate lowers the confidence score');

  const goldenRows = buildGoldenDataset();
  const goldenCols = Object.keys(goldenRows[0]);
  const claims = buildStoryClaims({ columns: goldenCols, rows: goldenRows, rowCount: goldenRows.length });
  ok(claims.length >= 2, `narration: buildStoryClaims produced ${claims.length} scored claims`);
  ok(claims.every(cl => cl.confidence && ['A', 'B', 'C', 'D'].includes(cl.confidence.grade)), 'narration: every claim carries an A/B/C/D confidence badge');
  const rowCountClaim = claims.find(cl => cl.kind === 'rowcount');
  ok(rowCountClaim && rowCountClaim.confidence.grade === 'A' && rowCountClaim.confidence.n === 100, 'narration: the 100-row rowcount claim is grade A with n=100');

  // ============================================================
  // Load the golden dataset for engine-backed feature tests
  // ============================================================
  const ds = await makeDataset('golden_gen8', goldenRows);
  const numericCols = ds.cols.filter(col => NUMERIC_TYPES.includes(col.type)).map(col => col.name);
  const engineLike = { runQuery };

  // ============================================================
  // Feature 4 — On-Device Anomaly Explainer
  // ============================================================
  const scored = await scoreMultivariateAnomalies('golden_gen8', numericCols, engineLike);
  ok(scored.rows.length === goldenRows.length, 'anomaly-explainer: multivariate scorer scored every row');
  const topAnomaly = scored.rows[0]; // sorted by descending anomaly score
  ok(topAnomaly.isAnomaly, 'anomaly-explainer: the top-scored golden row is flagged as anomalous');

  const explanation = await explainAnomaly('golden_gen8', numericCols, topAnomaly.rowIndex, engineLike, { groupColumn: 'gender' });
  ok(typeof explanation.reason === 'string' && explanation.reason.length > 0, 'anomaly-explainer: produced a plain-language reason for the flagged row');
  ok(Array.isArray(explanation.contributions) && explanation.contributions.length === numericCols.length, 'anomaly-explainer: attributed a contribution to each numeric feature');
  ok(/std dev/i.test(explanation.reason), 'anomaly-explainer: the reason is expressed in standard deviations from the peer group');

  // Directly explain the seeded age=999 semantic outlier and confirm "age"
  // is the dominant contributor to its anomaly.
  const ageRows = (await runQuery('SELECT age FROM golden_gen8')).rows.map(r => Number(r.age));
  const outlierIdx = ageRows.indexOf(999);
  ok(outlierIdx >= 0, 'anomaly-explainer: located the seeded age=999 outlier row');
  const ageExplain = await explainAnomaly('golden_gen8', numericCols, outlierIdx, engineLike);
  ok(ageExplain.contributions[0].feature === 'age', `anomaly-explainer: "age" is the top contributor for the age=999 row (got "${ageExplain.contributions[0].feature}")`);

  // ============================================================
  // Feature 5 — Synthetic Adversarial Test Generator (Red Team v2)
  // ============================================================
  const gen = generateAdversarialDataset(ds.cols);
  ok(JSON.stringify(gen.columns) === JSON.stringify(ds.cols.map(col => col.name)), 'synthetic: generated columns match the source schema exactly');
  ok(gen.rows.length >= 30, `synthetic: generated a usable number of rows (${gen.rows.length})`);
  const seededKeys = Object.keys(gen.seeded);
  ok(seededKeys.includes('categorical_variants'), 'synthetic: seeded near-duplicate categorical spellings');
  ok(seededKeys.some(k => k.startsWith('cross_column')), 'synthetic: seeded a cross-column logic violation');
  ok(seededKeys.includes('duplicates'), 'synthetic: seeded exact duplicate rows');
  ok(seededKeys.includes('nulls'), 'synthetic: seeded null values');
  ok(seededKeys.includes('semantic_outlier'), 'synthetic: seeded a semantic/outlier value');
  ok(seededKeys.includes('future_date'), 'synthetic: seeded a future date');

  // Every generated row exposes exactly the schema columns.
  const schemaNames = ds.cols.map(col => col.name).sort();
  ok(gen.rows.every(r => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(schemaNames)), 'synthetic: every generated row carries exactly the schema columns');

  // Load the synthetic table and confirm the validation stack catches the
  // seeded categorical-spelling and cross-column issues.
  const synthDs = await makeDataset('redteam_v2_gen8', gen.rows);
  const synthResults = await runAllLayers(synthDs);
  ok(['fail', 'warn'].includes(synthResults.categorical_consistency.status), `synthetic: categorical consistency layer catches seeded spelling variants (status=${synthResults.categorical_consistency.status})`);
  ok(['fail', 'warn'].includes(synthResults.cross_column_logic.status), `synthetic: cross-column logic layer catches seeded violation (status=${synthResults.cross_column_logic.status})`);

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
