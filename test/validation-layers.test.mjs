// ============================================================
// DATAGLOW — 20-layer validation + Assumption Ledger test suite
// ============================================================
// Loads the extended golden dataset and confirms every validation layer —
// including the three new ones (Categorical Consistency Engine #16,
// Cross-Column Logical Consistency #17, Distributional Fingerprint Drift #18),
// the Benford Statistical Test Eligibility Gate, and the Assumption Ledger —
// catches the issues seeded into the fixture.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/validation-layers.test.mjs
//
// The production modules import '../js/duckdb-engine.js'; the loader hook
// transparently redirects that to the native node-duckdb-engine.mjs.

import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';

import { LAYER_DEFS, runAllLayers, isBenfordBoundedName, splitColumnNameWords, BENFORD_TEACHINGS, benfordSkipCause, benfordTeachingGroups, detectBusinessKeyColumns, EXTENDED_COVERAGE_FLAG } from '../js/validation/validation.js';
import { buildGoldenDataset } from '../js/app-shell/loaders.js';
import { clusterValues, withCanonical } from '../js/validation/categorical-consistency.js';
import { getLedgerEntries, clearLedger } from '../js/provenance/assumption-ledger.js';
import { configureFlags, resetFlags } from '../js/build/build-flags.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

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

function detailStr(r) {
  return JSON.stringify(r && (r.detail || r.summary) || '');
}

// ============================================================
async function main() {
  clearLedger();

  // ---- Layer registry ----
  ok(LAYER_DEFS.length === 21, `registry: 21 validation layers defined (got ${LAYER_DEFS.length})`);
  const ids = new Set(LAYER_DEFS.map(l => l.id));
  ok(ids.has('categorical_consistency'), 'registry: layer 16 (categorical_consistency) present');
  ok(ids.has('cross_column_logic'), 'registry: layer 17 (cross_column_logic) present');
  ok(ids.has('distribution_drift'), 'registry: layer 18 (distribution_drift) present');
  ok(ids.has('upper_bound_sanity'), 'registry: layer 20 (upper_bound_sanity) present');
  ok(ids.has('physiological_plausibility'), 'registry: layer 19 (physiological_plausibility) present');
  ok(ids.has('missingness_detective'), 'registry: layer 21 (missingness_detective) present');

  // ---- Pure clustering algorithm (dependency-free) ----
  const clusters = clusterValues([
    { value: 'United States', n: 30 },
    { value: 'United State', n: 4 },
    { value: 'USA', n: 5 },
    { value: 'US', n: 5 },
    { value: 'France', n: 8 },
    { value: 'FRA', n: 3 },
  ]);
  const usCluster = clusters.find(c => c.canonical === 'United States');
  ok(usCluster && usCluster.variants.length >= 3, 'cluster: near-duplicate + abbreviation spellings of "United States" grouped');
  const frCluster = clusters.find(c => c.variants.some(v => v.value === 'France') && c.variants.some(v => v.value === 'FRA'));
  ok(!!frCluster, 'cluster: "France" and abbreviation "FRA" grouped via ISO lookup');

  // ---- User-editable canonical (accept / reject / edit per cluster) ----
  const editCluster = usCluster;
  // Accept-as-is: withCanonical with the proposal is a no-op on the mapping.
  const asIs = withCanonical(editCluster, editCluster.canonical);
  ok(asIs.canonical === editCluster.canonical && asIs.merges.length === editCluster.merges.length,
    'withCanonical: accepting the proposal preserves the suggested mapping');
  // Edit to an existing variant: that variant becomes the untouched target.
  const toUSA = withCanonical(editCluster, 'USA');
  ok(toUSA.canonical === 'USA' && toUSA.merges.every(m => m.from !== 'USA') && toUSA.merges.some(m => m.from === 'United States'),
    'withCanonical: editing to an existing variant remaps every other variant to it');
  // Edit to a brand-new spelling not among the variants: all variants merge in.
  const custom = withCanonical(editCluster, 'U.S.A.');
  ok(custom.canonical === 'U.S.A.' && custom.merges.length === editCluster.variants.length,
    'withCanonical: a custom canonical merges every observed variant into it');
  // Empty / whitespace override is ignored (keeps the original proposal).
  const empty = withCanonical(editCluster, '   ');
  ok(empty.canonical === editCluster.canonical, 'withCanonical: blank override falls back to the proposal');
  // Purity: the source cluster is never mutated.
  ok(editCluster.canonical === 'United States', 'withCanonical: does not mutate the input cluster');

  // ---- Full 20-layer run on the extended golden dataset ----
  const goldenRows = buildGoldenDataset();
  const ds = await makeDataset('golden_test_dataset', goldenRows);
  const results = await runAllLayers(ds);

  // Layer 16 — Categorical Consistency Engine
  const cc = results.categorical_consistency;
  ok(cc && cc.status === 'warn', `layer16: flagged inconsistent categories (status=${cc && cc.status})`);
  ok(cc && Array.isArray(cc.clusters) && cc.clusters.some(c => c.canonical === 'United States'),
    'layer16: proposed "United States" as canonical merge target');
  ok(/country/.test(detailStr(cc)), 'layer16: reported the "country" column');

  // Layer 17 — Cross-Column Logical Consistency
  const cx = results.cross_column_logic;
  ok(cx && cx.status === 'fail', `layer17: flagged logical inconsistencies (status=${cx && cx.status})`);
  ok(/discharge_date.*admit_date|admit_date.*discharge_date/.test(detailStr(cx)),
    'layer17: detected discharge_date before admit_date');
  ok(/has_retirement_account/.test(detailStr(cx)),
    'layer17: detected minor (age<18) with adult-only status');

  // Benford Statistical Test Eligibility Gate
  const bf = results.benford;
  ok(/age.*skipped|skipped.*age/i.test(detailStr(bf)),
    'benford-gate: "age" skipped as a bounded range with an explanation');
  ok(!/"claim_amount" skipped/.test(detailStr(bf)),
    'benford-gate: "claim_amount" (naturally scaled) was NOT skipped');

  // Benford bounded-name matching across naming conventions (regression for the
  // \b word-boundary bug that let compound names like "patient_age" slip through
  // and get falsely tested — a common healthcare/MIMIC column name).
  for (const name of [
    'age', 'exam_grade', 'patient_age', 'test_score', 'percentage_score',
    'age_years', 'ageYears', 'AgeYears', 'patient-age', 'patient age',
    'RatingStars', 'likert_response',
  ]) {
    ok(isBenfordBoundedName(name), `benford-name: "${name}" recognised as a bounded quantity`);
  }
  for (const name of [
    'transaction_amount', 'claim_amount', 'revenue', 'total_charge',
    'account_balance', 'reading', 'pageviews',
  ]) {
    ok(!isBenfordBoundedName(name), `benford-name: "${name}" NOT treated as bounded`);
  }
  ok(JSON.stringify(splitColumnNameWords('patient_ageYears-final')) ===
     JSON.stringify(['patient', 'age', 'years', 'final']),
    'benford-name: splits snake_case, camelCase, and kebab-case into words');

  // End-to-end: a snake_case "patient_age" column (0-99, spans 2 orders of
  // magnitude) must be SKIPPED, not falsely flagged as a Benford anomaly.
  const ageRows = Array.from({ length: 120 }, (_, i) => ({ patient_age: i % 100 }));
  const ageDs = await makeDataset('benford_patient_age', ageRows);
  const ageResults = await runAllLayers(ageDs);
  ok(/patient_age.*skipped|skipped.*patient_age/i.test(detailStr(ageResults.benford)),
    'benford-gate: "patient_age" (snake_case bounded) skipped instead of falsely flagged');

  // Explainable Benford Gate — each of the FOUR skip reasons must map to its own
  // distinct teaching paragraph, so a column skipped for (e.g.) too few rows no
  // longer gets the generic "bounded range" explanation. Reason strings below
  // are the verbatim ones produced by benfordEligibility() and the healthcare
  // binary-flag exemption rule (js/domain-physics.js).
  const boundedReason  = '"age" skipped — bounded range, not a naturally-scaled magnitude Benford\'s Law applies to.';
  const sampleReason   = '"reading" skipped — only 12 usable value(s); too few for a meaningful Benford test.';
  const rangeReason    = '"reading" skipped — values span <2 orders of magnitude (bounded), so Benford\'s Law is not applicable.';
  const binaryReason   = '"mortality_flag" skipped — binary 0/1 flag column, exempt from Benford\'s Law (which applies only to multi-order-of-magnitude quantities). [Domain Physics: healthcare pack]';

  ok(benfordSkipCause(boundedReason) === 'bounded_name', 'benford-teaching: bounded-range reason classified as bounded_name');
  ok(benfordSkipCause(sampleReason) === 'small_sample', 'benford-teaching: too-few-rows reason classified as small_sample');
  ok(benfordSkipCause(rangeReason) === 'narrow_range', 'benford-teaching: narrow-range reason classified as narrow_range (not bounded_name)');
  ok(benfordSkipCause(binaryReason) === 'binary_flag', 'benford-teaching: binary-flag reason classified as binary_flag');

  // All four teaching paragraphs exist and are distinct (no reason falls back to
  // the one-size-fits-all bounded-range text).
  const teachingTexts = ['bounded_name', 'small_sample', 'narrow_range', 'binary_flag'].map(c => BENFORD_TEACHINGS[c]);
  ok(teachingTexts.every(t => typeof t === 'string' && t.length > 60), 'benford-teaching: all four causes have a substantial teaching paragraph');
  ok(new Set(teachingTexts).size === 4, 'benford-teaching: the four teaching paragraphs are all distinct');
  ok(BENFORD_TEACHINGS.bounded_name.startsWith("Benford's Law describes naturally-scaled, multiplicative quantities"),
    'benford-teaching: bounded-range paragraph preserved verbatim');
  ok(/only reliably|dominated by chance|enough data|handful of rows|statistically meaningless/i.test(BENFORD_TEACHINGS.small_sample),
    'benford-teaching: small-sample paragraph explains the too-few-rows rationale');
  ok(/orders of magnitude|same scale|one or two leading digits/i.test(BENFORD_TEACHINGS.narrow_range),
    'benford-teaching: narrow-range paragraph explains the magnitude-span rationale');
  ok(/binary|0\/1|true\/false|one or two possible leading digits/i.test(BENFORD_TEACHINGS.binary_flag),
    'benford-teaching: binary-flag paragraph explains the flag-column rationale');

  // Grouping: a mixed skip list yields one group per cause, each carrying the
  // matching teaching paragraph and only the reasons for that cause.
  const groups = benfordTeachingGroups([boundedReason, sampleReason, rangeReason, binaryReason]);
  ok(groups.length === 4, 'benford-teaching: four distinct skip reasons produce four teaching groups');
  for (const g of groups) {
    ok(g.teaching === BENFORD_TEACHINGS[g.cause], `benford-teaching: group "${g.cause}" carries its matching paragraph`);
  }
  ok(new Set(groups.map(g => g.teaching)).size === 4, 'benford-teaching: rendered paragraphs are distinct per cause');
  // Two columns skipped for the SAME cause collapse into one group (one paragraph).
  const merged = benfordTeachingGroups([sampleReason, '"foo" skipped — only 3 usable value(s); too few for a meaningful Benford test.']);
  ok(merged.length === 1 && merged[0].cause === 'small_sample' && merged[0].skips.length === 2,
    'benford-teaching: same-cause skips share a single teaching group');

  // The real golden run: "age" is skipped and surfaces the bounded-range lesson.
  const bfGroups = benfordTeachingGroups(bf.skips);
  ok(bfGroups.some(g => g.cause === 'bounded_name' && g.skips.some(s => /"age"/.test(s))),
    'benford-teaching: golden run maps skipped "age" to the bounded-range paragraph');

  // Existing layers still catch their seeded issues
  ok(results.unit_tests.status === 'fail', `unit_tests: still fails on seeded issues (status=${results.unit_tests.status})`);
  ok(results.semantic_drift.status === 'fail', `semantic_drift: still catches age=999 (status=${results.semantic_drift.status})`);

  // ---------------------------------------------------------------
  // Unit Test Layer — PER-FINDING assertions (silent-regression guard)
  // ---------------------------------------------------------------
  // The coarse `status === 'fail'` check above passes as long as ANY of the
  // several independently-seeded issues (negatives, future dates, duplicates)
  // still fires — so the duplicate detector or the referential-integrity check
  // could be silently removed and that assertion would stay green. These checks
  // inspect the structured `findings` array by `kind` so each detector is
  // individually pinned. The finding kinds are produced by runUnitTests() in
  // js/validation/validation.js: 'negative' | 'future_date' | 'blank_key' |
  // 'duplicate' | 'null_ref'.
  const unitFindings = res => (res && Array.isArray(res.findings)) ? res.findings : [];
  const ofKind = (res, kind) => unitFindings(res).filter(f => f.kind === kind);

  const gf = unitFindings(results.unit_tests);
  ok(gf.length > 0, `unit_tests: exposes a structured findings array (got ${gf.length})`);
  // Each seeded issue must surface as its OWN finding kind — not just "some fail".
  ok(ofKind(results.unit_tests, 'negative').length >= 1,
    `unit_tests: seeded negative value(s) surface a 'negative' finding (got ${ofKind(results.unit_tests, 'negative').length})`);
  ok(ofKind(results.unit_tests, 'future_date').length >= 1,
    `unit_tests: seeded future date(s) surface a 'future_date' finding (got ${ofKind(results.unit_tests, 'future_date').length})`);
  // Duplicate detector pinned SPECIFICALLY: exactly one duplicate finding, and it
  // reports the 10 seeded exact-duplicate rows. If the duplicate GROUP BY were
  // removed, this fails even though other seeded issues keep overall status=fail.
  const goldenDup = ofKind(results.unit_tests, 'duplicate');
  ok(goldenDup.length === 1,
    `unit_tests: duplicate detector fires exactly once on the golden fixture (got ${goldenDup.length})`);
  ok(goldenDup[0] && /10 duplicate row\(s\)/.test(goldenDup[0].text || ''),
    `unit_tests: duplicate finding counts the 10 seeded exact duplicates (text="${goldenDup[0] && goldenDup[0].text}")`);
  // The golden fixture has NO non-key *_id column, so it never exercises the
  // referential-integrity check at all — asserting zero here documents that the
  // golden run alone gives that detector no coverage (see dedicated fixtures below).
  ok(ofKind(results.unit_tests, 'null_ref').length === 0,
    `unit_tests: golden fixture contains no FK column, so no 'null_ref' finding is expected (got ${ofKind(results.unit_tests, 'null_ref').length})`);

  // ---------------------------------------------------------------
  // Referential integrity — TRUE ORPHAN FK (non-null, non-existent parent)
  // ---------------------------------------------------------------
  // GAP UNDER TEST: runUnitTests()'s referential-integrity check only asserts a
  // *_id foreign-key column is non-NULL; it never verifies the referenced value
  // exists in a parent table. So a non-null-but-nonexistent (orphan) FK is NOT
  // caught. `hospital_id` below is fully populated but points at hospitals that
  // exist in no parent table. This asserts the CURRENT (buggy) behavior — the
  // orphan is missed — so the gap is visible and a future detection-logic fix
  // will have to flip this assertion intentionally. (Tracked in
  // docs/tech-debt-tracker.md.)
  const orphanRows = Array.from({ length: 6 }, (_, i) => ({
    patient_id: i + 1,          // key column (cols[0]) — always present
    hospital_id: 900 + i,       // FK: non-null everywhere, but no parent row exists
    age: 30 + i,
  }));
  const orphanDs = await makeDataset('orphan_fk_dataset', orphanRows);
  const orphanRes = await runAllLayers(orphanDs);
  ok(ofKind(orphanRes.unit_tests, 'null_ref').length === 0,
    `unit_tests: KNOWN GAP — orphan FK (non-null, non-existent parent) is currently NOT caught (null_ref count=${ofKind(orphanRes.unit_tests, 'null_ref').length})`);

  // Positive control: a *_id FK column that IS null must still trip 'null_ref',
  // proving the detector genuinely fires on what it does check (null FKs) and the
  // orphan miss above is a real coverage gap, not a broken harness.
  const nullFkRows = Array.from({ length: 6 }, (_, i) => ({
    patient_id: i + 1,
    hospital_id: i < 3 ? null : 100 + i, // 3 null FKs
    age: 30 + i,
  }));
  const nullFkDs = await makeDataset('null_fk_dataset', nullFkRows);
  const nullFkRes = await runAllLayers(nullFkDs);
  const nullRef = ofKind(nullFkRes.unit_tests, 'null_ref');
  ok(nullRef.length === 1 && /3 null reference\(s\)/.test(nullRef[0].text || ''),
    `unit_tests: control — null FK values DO surface a 'null_ref' finding (count=${nullRef.length}, text="${nullRef[0] && nullRef[0].text}")`);

  // ---------------------------------------------------------------
  // Duplicate detection — BUSINESS-KEY duplicate (byte-identical-only gap)
  // ---------------------------------------------------------------
  // GAP UNDER TEST: the duplicate check is `GROUP BY <every column>`, so it only
  // catches byte-identical rows. Two rows sharing the same real-world business
  // key (patient_id) but differing in one incidental column (an event timestamp)
  // are a logical duplicate the check misses. This asserts the CURRENT behavior
  // (missed) so the gap is visible. (Tracked in docs/tech-debt-tracker.md.)
  const bizKeyRows = [
    { patient_id: 1, amount: 100, event_ts: '2026-01-01T00:00:00' },
    { patient_id: 1, amount: 100, event_ts: '2026-01-01T00:05:00' }, // same key, differs only in timestamp
    { patient_id: 2, amount: 200, event_ts: '2026-01-02T00:00:00' },
  ];
  const bizKeyDs = await makeDataset('bizkey_dup_dataset', bizKeyRows);
  const bizKeyRes = await runAllLayers(bizKeyDs);
  ok(ofKind(bizKeyRes.unit_tests, 'duplicate').length === 0,
    `unit_tests: KNOWN GAP — business-key duplicate differing only by timestamp is NOT caught by the byte-identical check (duplicate count=${ofKind(bizKeyRes.unit_tests, 'duplicate').length})`);

  // Positive control: two genuinely byte-identical rows MUST trip 'duplicate',
  // proving the detector fires on exact dupes and the business-key miss above is
  // a real scope gap, not a broken harness.
  const identRows = [
    { patient_id: 1, amount: 100 },
    { patient_id: 1, amount: 100 }, // byte-identical
    { patient_id: 2, amount: 200 },
  ];
  const identDs = await makeDataset('identical_dup_dataset', identRows);
  const identRes = await runAllLayers(identDs);
  ok(ofKind(identRes.unit_tests, 'duplicate').length === 1,
    `unit_tests: control — byte-identical rows DO surface a 'duplicate' finding (count=${ofKind(identRes.unit_tests, 'duplicate').length})`);

  // Layer 18 — Distributional Fingerprint Drift: baseline on first load
  const dd1 = results.distribution_drift;
  ok(dd1 && dd1.status === 'pass' && /baseline/i.test(dd1.summary),
    `layer18: baseline fingerprint recorded on first load (status=${dd1 && dd1.status})`);

  // Second load of the SAME schema with drifted data -> drift flagged
  const drifted = buildGoldenDataset().map(r => ({
    ...r,
    claim_amount: (r.claim_amount == null ? null : Number(r.claim_amount) * 6 + 5000),
    country: 'Germany',
  }));
  const ds2 = await makeDataset('golden_test_dataset', drifted);
  const results2 = await runAllLayers(ds2);
  const dd2 = results2.distribution_drift;
  ok(dd2 && dd2.status === 'fail', `layer18: drift flagged on same-schema reload (status=${dd2 && dd2.status})`);
  ok(/claim_amount|country/.test(detailStr(dd2)), 'layer18: named the drifted column(s)');

  // ---- Assumption Ledger ----
  const entries = getLedgerEntries();
  ok(entries.length > 0, `ledger: recorded entries during validation (got ${entries.length})`);
  const sources = new Set(entries.map(e => e.source));
  ok(sources.has('Categorical Consistency Engine'), 'ledger: Categorical Consistency Engine logged a decision');
  ok(sources.has('Statistical Test Eligibility Gate'), 'ledger: Benford eligibility gate logged a skip decision');
  ok(sources.has('Cross-Column Logical Consistency'), 'ledger: Cross-Column checker logged a finding');
  ok(sources.has('Distributional Fingerprint Drift'), 'ledger: drift detector logged a drift entry');

  // ============================================================
  // Extended-coverage: business-key duplicate detection (flag-gated)
  // ============================================================
  // Pure detector: identifier-like names qualify; measures/timestamps do not.
  {
    const cols = [
      { name: 'claim_id', type: 'BIGINT' }, { name: 'member_no', type: 'VARCHAR' },
      { name: 'procedure_code', type: 'VARCHAR' }, { name: 'amount_billed', type: 'DOUBLE' },
      { name: 'ingested_at', type: 'TIMESTAMP' }, { name: 'notes', type: 'VARCHAR' },
    ];
    const keys = detectBusinessKeyColumns(cols).map(c => c.name);
    ok(keys.includes('claim_id') && keys.includes('member_no') && keys.includes('procedure_code'), 'bizkey: id/_no/_code columns identified as business key');
    ok(!keys.includes('amount_billed') && !keys.includes('ingested_at') && !keys.includes('notes'), 'bizkey: measure/timestamp/text NOT treated as key');
  }

  // A realistic claims table: claim_id 9001 repeats with a different ingest
  // timestamp (a true business-key duplicate the byte-identical check misses);
  // claim_id 9003 repeats BYTE-IDENTICALLY (caught by the existing check, must
  // NOT be double-counted by the business-key check).
  const dupRows = [
    { claim_id: 9001, amount_billed: 500, ingested_at: '2025-01-01T08:00:00' },
    { claim_id: 9001, amount_billed: 500, ingested_at: '2025-01-02T09:30:00' }, // biz-key dup, differs on timestamp
    { claim_id: 9002, amount_billed: 300, ingested_at: '2025-01-01T08:00:00' },
    { claim_id: 9003, amount_billed: 250, ingested_at: '2025-01-01T08:00:00' },
    { claim_id: 9003, amount_billed: 250, ingested_at: '2025-01-01T08:00:00' }, // byte-identical dup
  ];
  const dupDs = await makeDataset('bizkey_dup_test', dupRows);

  // Flag OFF (shipped default): the business-key check is dark — only the
  // pre-existing byte-identical duplicate is reported (no regression, no new finding).
  resetFlags();
  const offRes = await runAllLayers(dupDs, { pack: 'none' });
  const offFindings = (offRes.unit_tests.findings || []);
  ok(offFindings.some(f => f.kind === 'duplicate'), 'bizkey OFF: existing byte-identical duplicate still reported');
  ok(!offFindings.some(f => f.kind === 'business_key_duplicate'), 'bizkey OFF: no business_key_duplicate finding (flag dark)');

  // Flag ON: the business-key duplicate (claim_id 9001) is now caught, and it
  // does NOT swallow or double-count the byte-identical one (9003).
  configureFlags({ [EXTENDED_COVERAGE_FLAG]: { enabled: true } });
  const onRes = await runAllLayers(dupDs, { pack: 'none' });
  const onFindings = (onRes.unit_tests.findings || []);
  const bk = onFindings.find(f => f.kind === 'business_key_duplicate');
  ok(!!bk, 'bizkey ON: business_key_duplicate finding present');
  ok(bk && /1 business-key duplicate/.test(bk.text), `bizkey ON: reports exactly the 1 non-identical dup row (text="${bk && bk.text}")`);
  ok(onFindings.some(f => f.kind === 'duplicate'), 'bizkey ON: byte-identical duplicate still independently reported (not double-counted)');
  resetFlags();

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
