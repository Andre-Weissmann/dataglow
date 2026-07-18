// ============================================================
// DATAGLOW — The 20 Validation Layers (+ Red Team self-test)
// "The features nobody else has."
// ============================================================

import { state } from '../app-shell/state.js';
import * as engine from '../app-shell/duckdb-engine.js';
import { sha256, formatNumber } from '../app-shell/utils.js';
import { detectColumnClusters, describeCluster } from './categorical-consistency.js';
import { runCrossColumnChecks } from './cross-column-consistency.js';
import { runDrgIcdValidation } from './drg-icd-validator.js';
import { logAssumption } from '../provenance/assumption-ledger.js';
import { applyDomainPack, summarizeUnitTests } from './domain-physics.js';
import { runPhysiologicalChecks, PHYSIO_DISCLAIMER } from './physiological-plausibility.js';
import { runUpperBoundChecks, UPPER_BOUND_NOTE } from './upper-bound-sanity.js';
import { runMissingnessDetective, MISSINGNESS_NOTE } from './missingness-detective.js';
import { computeCalibratedGrades } from '../grades/calibrated-grades.js';
import { devAssertConformance, toValidationRun, toDataset } from '../protocol/protocol-conformance.js';
import { forecastDriftReport } from '../drift/drift-forecast.js';
import { isEnabled } from '../build/build-flags.js';
import { checkForeignKey, checkAllForeignKeys } from '../relational/foreign-key-checker.js';
import { checkTemporalOrder } from '../relational/temporal-order-checker.js';
import { checkFlagConsistency } from '../relational/flag-consistency-checker.js';
import { checkJoinCoverage, checkAllJoinCoverage } from '../relational/join-coverage-checker.js';
import { detectEquityColumns } from '../equity/equity-detector.js';
import { stratifyEquity } from '../equity/equity-stratifier.js';
import { buildEquityAttestation } from '../equity/equity-attestation.js';

// Feature flag gating the extended-coverage validation checks (semantic
// magnitude ordering in Cross-Column Logic + business-key duplicate detection
// in the Unit Test Layer). Ships OFF by default per the repo's
// "flag-if-visible-behavior-change" convention: both add new findings the
// Validate tab surfaces to users. Flip on in flags.manifest.json to activate.
export const EXTENDED_COVERAGE_FLAG = 'validationExtendedCoverage';
// Cross-table referential integrity (P0, NORTH_STAR 2026-07-15 finding 0b): the
// Unit Test Layer's own LAYER_DEFS description has always claimed 'referential
// integrity' as one of its 5 silent tests, but the check below (see fkCols loop
// in runUnitTests) only ever verified a foreign-key-shaped column is non-NULL
// WITHIN the same table — it never checked whether that value actually exists
// as a key in another loaded table, so a syntactically-valid but nonexistent
// FK (e.g. a claim referencing patient_id "PT9999" when no such patient was
// ever loaded) was invisible to it. This flag gates a genuinely new, separate
// cross-table check (detectCrossTableOrphans / the orphan-FK query in
// runUnitTests) that is intentionally its OWN flag rather than piggybacking on
// EXTENDED_COVERAGE_FLAG: that flag is already enabled:true in production, and
// silently attaching new user-visible findings to an already-live flag would
// bypass the standing rule that every new detection surfacing to users ships
// dark and gets its own explicit enable decision.
export const CROSS_TABLE_REFERENTIAL_FLAG = 'crossTableReferentialIntegrity';

// In-memory history for drift/reproducibility/correlation layers (per session — no server)
const history = {
  schemaFingerprints: {},        // table -> [hashes over time]
  queryResults: {},              // querySignature -> [ {ts, resultHash} ]
  correlationSnapshots: {},      // table -> [{ts, corr}]
  distributionFingerprints: {},  // table -> [{ts, hash, stats}] (sibling of schemaFingerprints)
};

export const LAYER_DEFS = [
  { id: 'sanity_anchor', name: 'Sanity Anchor', desc: 'Runs the same GROUP BY two independent ways and compares.' },
  { id: 'historical_drift', name: 'Historical Drift Detector', desc: 'Flags when results change between runs on the same query.' },
  { id: 'unit_tests', name: 'Unit Test Layer', desc: '5 silent tests: negatives, future dates, blank keys, duplicates, in-table reference nullness. Cross-table referential integrity (does a foreign key actually exist in another loaded table) is a separate, flag-gated check — see crossTableReferentialIntegrity.' },
  { id: 'confidence', name: 'Confidence Layer', desc: '0–100 score across 5 signals with a color-coded grade.' },
  { id: 'denial_radar', name: 'Denial Radar', desc: 'Healthcare claim denial pattern detection (requires EDI 835/837 columns).' },
  { id: 'schema_fingerprint', name: 'Schema Fingerprint', desc: 'Cryptographic hash of the schema — flags renamed/removed/retyped columns.' },
  { id: 'semantic_drift', name: 'Semantic Drift Detector', desc: 'Checks if column names match their actual values.' },
  { id: 'correlation_watchdog', name: 'Correlation Watchdog', desc: 'Tracks key metric correlations over time, flags decorrelation.' },
  { id: 'narrative_consistency', name: 'Narrative Consistency Checker', desc: 'Cross-checks numbers in a written story against query results.' },
  { id: 'freshness', name: 'Freshness Meter', desc: 'Timestamps every dataset load; visible staleness badge.' },
  { id: 'blind_spot', name: 'Blind Spot Scanner', desc: 'Prompts about missing data that would change the conclusion.' },
  { id: 'reproducibility', name: 'Reproducibility Badge', desc: 'Runs the same query 10x, confirms identical results.' },
  { id: 'outlier_detection', name: 'Outlier Detection (MAD + IQR)', desc: 'Flags high AND low outliers via modified z-score and IQR fences — catches large positives, not just negatives.' },
  { id: 'benford', name: "Benford's Law Check", desc: 'Compares leading-digit distribution to the Newcomb-Benford expectation; gated to columns where the law actually applies.' },
  { id: 'categorical_consistency', name: 'Categorical Consistency Engine', desc: 'Clusters near-identical spellings (Levenshtein / Jaro-Winkler + ISO abbreviations) and proposes a canonical merge.' },
  { id: 'cross_column_logic', name: 'Cross-Column Logical Consistency', desc: 'Detects impossible combinations across columns — end-before-start ranges, discharge-before-admit, adult-only status on minors, LOS field vs date arithmetic mismatch.' },
  { id: 'drg_icd_validation', name: 'DRG / ICD-10 Coding Validation', desc: 'Healthcare coding cross-check: flags MS-DRG codes whose principal ICD-10-CM diagnosis is incompatible under CMS MS-DRG grouper rules (FY2024). Catches claim-denial risk and case-mix index errors.' },
  { id: 'distribution_drift', name: 'Distributional Fingerprint Drift', desc: 'Stores each column\'s distribution shape and flags drift on a later load of the same schema.' },
  { id: 'physiological_plausibility', name: 'Physiological Plausibility', desc: 'Healthcare-aware check: flags vital-sign values (heart rate, temperature, blood pressure, respiratory rate, SpO₂) outside general human physiological limits. A data-plausibility check, not medical advice.' },
  { id: 'upper_bound_sanity', name: 'Upper-Bound Sanity Anchor', desc: 'Flags values outside a column\'s definitional bounds — percentages above 100 or below 0, proportions/probabilities outside 0–1. Anchored on logical/mathematical limits, not this dataset\'s statistics. Conservative: skips ambiguous unbounded rates/ratios.' },
  { id: 'missingness_detective', name: 'Missingness Detective', desc: 'Classifies each column\'s missingness with Rubin\'s MCAR/MAR/MNAR taxonomy: finds an observed column that explains the missingness (MAR), defaults to "no driver found" (MCAR), and raises a conservative MNAR hypothesis for heavily-missing core fields.' },
  { id: 'red_team', name: 'Red Team Mode', desc: 'Runs all 20 layers against an intentionally broken golden dataset.' },
];

function result(status, summary, detail = null) {
  return { status, summary, detail, ts: Date.now() };
}

// ---------- 1. Sanity Anchor ----------
async function runSanityAnchor(table, cols) {
  const numericCol = cols.find(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type));
  const catCol = cols.find(c => c.type === 'VARCHAR');
  if (!numericCol || !catCol) return result('warn', 'No suitable numeric + categorical column pair found to cross-check.');
  const q1 = await engine.runQuery(`SELECT "${catCol.name}" AS grp, SUM("${numericCol.name}") AS total FROM ${table} GROUP BY 1 ORDER BY 1`);
  const q2 = await engine.runQuery(`SELECT "${catCol.name}" AS grp, SUM(v) AS total FROM (SELECT "${catCol.name}", "${numericCol.name}" AS v FROM ${table}) sub GROUP BY 1 ORDER BY 1`);
  const map1 = new Map(q1.rows.map(r => [String(r.grp), r.total]));
  const map2 = new Map(q2.rows.map(r => [String(r.grp), r.total]));
  let mismatches = 0;
  for (const [k, v] of map1) {
    const v2 = map2.get(k);
    if (Math.abs((v || 0) - (v2 || 0)) > 1e-6) mismatches++;
  }
  if (mismatches > 0) return result('fail', `${mismatches} group(s) disagree between the two independent calculation paths.`);
  return result('pass', `Both independent paths agree across ${map1.size} groups (${catCol.name} × sum of ${numericCol.name}).`);
}

// ---------- 2. Historical Drift Detector ----------
async function runHistoricalDrift(table) {
  const q = `SELECT COUNT(*) AS n FROM ${table}`;
  const { rows } = await engine.runQuery(q);
  const hash = await sha256(JSON.stringify(rows));
  const key = `${table}::${q}`;
  const prior = history.queryResults[key] || [];
  prior.push({ ts: Date.now(), hash });
  history.queryResults[key] = prior;
  if (prior.length < 2) return result('warn', 'First run recorded — no prior result to compare yet. Re-run later to check for drift.');
  const drifted = prior[prior.length - 1].hash !== prior[prior.length - 2].hash;
  return drifted
    ? result('fail', 'Row count changed since the last run on this table.')
    : result('pass', `No drift detected across ${prior.length} recorded runs.`);
}

// ---------- 3. Unit Test Layer ----------
// Emits a structured, domain-agnostic `findings` array (every issue a hard
// fail). Domain reinterpretation — e.g. downgrading systematic de-identification
// date-shifting from fail → warn — is applied afterwards by the Domain Physics
// Engine (see js/domain-physics.js), so this layer stays a pure defect detector
// and the healthcare-specific judgement lives in a swappable pack.
// A "business key" is the subset of columns that identify a logical record
// (claim id, member id, encounter code, …) as opposed to the full row. We
// recognize it purely from naming convention — the same identifier heuristic
// the referential-integrity check below already uses (`*_id`), widened to the
// common key suffixes (`_key`, `_code`, `_no`, `_num`, `_number`) and the bare
// `id`/`key`/`code` names. Deliberately conservative: only these identifier-like
// names qualify, so free-text/measure/timestamp columns are never mistaken for
// a key. Returned columns preserve input order.
const BUSINESS_KEY_RE = /^(id|key|code)$|(_id|_key|_code|_no|_num|_number)$/i;
export function detectBusinessKeyColumns(cols) {
  return cols.filter(c => BUSINESS_KEY_RE.test(c.name));
}

// Pure matcher for the cross-table referential-integrity check: given a
// foreign-key-shaped column name (e.g. "patient_id") from the CURRENT table
// and the list of OTHER currently-loaded datasets (state.datasets entries,
// excluding the current table), find the best candidate reference table that
// column is likely pointing at, plus which of ITS columns is the matching key.
// Deliberately conservative — returns null rather than guessing when nothing
// lines up, so this never invents a false orphan finding against an unrelated
// table that merely happens to share a generic column name.
//
// Matching rules (checked in order, first match wins):
//   1. Exact column-name match: the other dataset has a column with the exact
//      same name (e.g. both tables have "patient_id") — use that as the key.
//   2. Base-name-to-bare-"id" match: the FK column strips to a base noun (e.g.
//      "patient_id" -> "patient") that is a singular/plural form of the other
//      dataset's name (e.g. dataset named "patients"), AND that dataset has a
//      bare "id" column (or a column literally named the same as the FK) as
//      its first column (the existing key-column convention used elsewhere in
//      this file, see keyCol in runUnitTests) — use that first column as the key.
// Never matches the current table against itself.
export function findReferenceCandidate(fkColumnName, currentTableName, otherDatasets) {
  const base = fkColumnName.replace(/_id$/i, '').toLowerCase();
  for (const other of otherDatasets) {
    if (!other || other.table === currentTableName || !Array.isArray(other.cols) || other.cols.length === 0) continue;
    // Rule 1: exact column-name match, but only when that column is ALSO the
    // other table's own first column (its established key-column convention)
    // — this avoids matching two unrelated tables that merely happen to share
    // a same-named FK column for their own separate reasons (e.g. two claims-
    // shaped tables both carrying an incidental "patient_id" column, neither
    // of which is actually the patients master table).
    const exact = other.cols.find(c => c.name.toLowerCase() === fkColumnName.toLowerCase());
    if (exact && other.cols[0].name.toLowerCase() === fkColumnName.toLowerCase()) {
      return { table: other.table, name: other.name, keyColumn: exact.name };
    }
    // Rule 2: base-name-to-dataset-name match, keyed on the other table's own
    // first column (its established key-column convention).
    const dsName = (other.name || '').toLowerCase();
    const singular = base.endsWith('s') ? base.slice(0, -1) : base;
    const plural = base.endsWith('s') ? base : `${base}s`;
    if (dsName === base || dsName === singular || dsName === plural || dsName.includes(base)) {
      return { table: other.table, name: other.name, keyColumn: other.cols[0].name };
    }
  }
  return null;
}

async function runUnitTests(table, cols) {
  const findings = [];
  const numericCols = cols.filter(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type));
  const dateCols = cols.filter(c => c.type.includes('DATE') || /date|admit|discharge/i.test(c.name));
  // negative values
  for (const c of numericCols) {
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" < 0`);
    if (rows[0].n > 0) findings.push({ kind: 'negative', column: c.name, severity: 'fail', text: `${rows[0].n} negative value(s) in "${c.name}"` });
  }
  // future dates — the far-future share is recorded on the finding so a domain
  // pack can decide whether it is a defect or a de-identification artifact.
  for (const c of dateCols) {
    try {
      const { rows } = await engine.runQuery(`
        SELECT
          COUNT(*) FILTER (WHERE TRY_CAST("${c.name}" AS DATE) IS NOT NULL) AS nonnull,
          COUNT(*) FILTER (WHERE TRY_CAST("${c.name}" AS DATE) > CURRENT_DATE) AS future,
          COUNT(*) FILTER (WHERE TRY_CAST("${c.name}" AS DATE) > CURRENT_DATE + INTERVAL 20 YEAR) AS farFuture
        FROM ${table}`);
      const nonnull = Number(rows[0].nonnull) || 0;
      const future = Number(rows[0].future) || 0;
      const farFuture = Number(rows[0].farFuture) || 0;
      if (future === 0) continue;
      const farFutureShare = nonnull > 0 ? farFuture / nonnull : 0;
      findings.push({ kind: 'future_date', column: c.name, severity: 'fail', text: `${future} future date(s) in "${c.name}"`, meta: { future, farFuture, nonnull, farFutureShare } });
    } catch (e) { /* skip */ }
  }
  // blank/null keys (first column treated as key)
  const keyCol = cols[0];
  const { rows: nullRows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${keyCol.name}" IS NULL`);
  if (nullRows[0].n > 0) findings.push({ kind: 'blank_key', column: keyCol.name, severity: 'fail', text: `${nullRows[0].n} blank value(s) in key column "${keyCol.name}"` });
  // duplicates (full row)
  const allCols = cols.map(c => `"${c.name}"`).join(',');
  const { rows: dupRows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM (SELECT ${allCols}, COUNT(*) AS c FROM ${table} GROUP BY ${allCols} HAVING COUNT(*) > 1) t`);
  if (dupRows[0].n > 0) {
    const { rows: dupTotal } = await engine.runQuery(`SELECT SUM(c) - COUNT(*) AS extra FROM (SELECT ${allCols}, COUNT(*) AS c FROM ${table} GROUP BY ${allCols} HAVING COUNT(*) > 1) t`);
    findings.push({ kind: 'duplicate', severity: 'fail', text: `${dupTotal[0].extra} duplicate row(s) found (${dupRows[0].n} distinct groups affected)` });
  }
  // business-key duplicates (flag-gated): the byte-identical check above misses
  // rows that repeat a logical record but differ in an incidental column (a
  // load timestamp, an ingest batch id, …). Group by the business-key subset
  // and count only the groups that are NOT already fully byte-identical, so this
  // never double-reports the duplicates the check above already caught. Skips
  // cleanly when the key would be every column (no added signal) or none exists.
  if (isEnabled(EXTENDED_COVERAGE_FLAG)) {
    const bkCols = detectBusinessKeyColumns(cols);
    if (bkCols.length > 0 && bkCols.length < cols.length) {
      const bkList = bkCols.map(c => `"${c.name}"`).join(',');
      const rowSig = cols.map(c => `COALESCE(CAST("${c.name}" AS VARCHAR), CHR(0))`).join(` || CHR(31) || `);
      try {
        const { rows: bkRows } = await engine.runQuery(`
          SELECT COUNT(*) AS groups, COALESCE(SUM(c - 1), 0) AS extra FROM (
            SELECT ${bkList}, COUNT(*) AS c, COUNT(DISTINCT ${rowSig}) AS distinctRows
            FROM ${table} GROUP BY ${bkList}
            HAVING COUNT(*) > 1 AND COUNT(DISTINCT ${rowSig}) > 1) t`);
        const groups = Number(bkRows[0].groups) || 0;
        const extra = Number(bkRows[0].extra) || 0;
        if (groups > 0) {
          const keyNames = bkCols.map(c => `"${c.name}"`).join(', ');
          findings.push({ kind: 'business_key_duplicate', severity: 'fail', text: `${extra} business-key duplicate row(s) found on ${keyNames} (${groups} key group(s) with rows that repeat the key but differ elsewhere — e.g. an incidental timestamp)` });
        }
      } catch (e) { /* incompatible columns — skip */ }
    }
  }
  // referential integrity: if a *_id column exists that isn't the key, check it's non-null
  const fkCols = cols.filter(c => /_id$/i.test(c.name) && c.name !== keyCol.name);
  for (const c of fkCols) {
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" IS NULL`);
    if (rows[0].n > 0) findings.push({ kind: 'null_ref', column: c.name, severity: 'fail', text: `${rows[0].n} null reference(s) in "${c.name}"` });
  }

  // Cross-table referential integrity (flag-gated, P0 NORTH_STAR 2026-07-15
  // finding 0b): the null-check loop above only verifies a FK-shaped column
  // is non-NULL WITHIN this table. A syntactically-valid but nonexistent FK
  // (e.g. a claim's patient_id = "PT9999" when no such patient was ever
  // loaded) is invisible to that check. This block adds a genuine anti-join
  // against any OTHER currently-loaded dataset that findReferenceCandidate()
  // conservatively identifies as the likely reference table for that FK
  // column, and reports non-null values that don't exist in that table's key
  // column. Deliberately separate from EXTENDED_COVERAGE_FLAG (see that
  // flag's own comment above) since this is new user-visible behavior that
  // needs its own explicit enable decision. Fails open (never throws) if the
  // other dataset can't be queried for any reason (removed mid-run, type
  // mismatch on the join, etc.) — the rest of the Unit Test Layer's findings
  // must never be lost because of a cross-table check's failure.
  if (isEnabled(CROSS_TABLE_REFERENTIAL_FLAG)) {
    const otherDatasets = (state.datasets || []).filter(d => d && d.table !== table);
    if (otherDatasets.length > 0) {
      for (const c of fkCols) {
        const candidate = findReferenceCandidate(c.name, table, otherDatasets);
        if (!candidate) continue;
        try {
          const { rows: orphanRows } = await engine.runQuery(`
            SELECT COUNT(*) AS n FROM ${table} t
            WHERE t."${c.name}" IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${candidate.table} r
                WHERE CAST(r."${candidate.keyColumn}" AS VARCHAR) = CAST(t."${c.name}" AS VARCHAR)
              )`);
          const orphanCount = Number(orphanRows[0].n) || 0;
          if (orphanCount > 0) {
            const refLabel = candidate.name || candidate.table;
            findings.push({
              kind: 'orphan_reference',
              column: c.name,
              severity: 'fail',
              text: `${orphanCount} value(s) in "${c.name}" don't exist in "${candidate.keyColumn}" of the loaded "${refLabel}" dataset (orphan reference)`,
              meta: { referenceTable: candidate.table, referenceDataset: refLabel, referenceKeyColumn: candidate.keyColumn, orphanCount },
            });
          }
        } catch (e) { /* incompatible join (type mismatch, dropped table, ...) — skip, fail open */ }
      }
    }
  }

  const r = summarizeUnitTests(findings);
  r.findings = findings;
  return r;
}

// ---------- 4. Confidence Layer ----------
async function runConfidence(table, cols, rowCount) {
  const numericCols = cols.filter(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type));
  // Signal 1: sample coverage (row count relative to a "healthy" floor of 30)
  const sampleCoverage = Math.min(1, rowCount / 200);
  // Signal 2: null rate
  let totalCells = 0, nullCells = 0;
  for (const c of cols) {
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" IS NULL`);
    nullCells += rows[0].n;
    totalCells += rowCount;
  }
  const nullRate = totalCells > 0 ? nullCells / totalCells : 0;
  const nullScore = 1 - Math.min(1, nullRate * 4);
  // Signal 3: statistical variance (coefficient of variation, capped)
  let varianceScore = 0.7;
  if (numericCols[0]) {
    const { rows } = await engine.runQuery(`SELECT AVG("${numericCols[0].name}") AS m, STDDEV_POP("${numericCols[0].name}") AS s FROM ${table}`);
    const m = rows[0].m, s = rows[0].s;
    if (m && s != null) {
      const cv = Math.abs(s / m);
      varianceScore = cv < 2 ? 1 - Math.min(1, cv / 2) * 0.5 : 0.4;
    }
  }
  // Signal 4: subsample stability (split-half comparison of mean)
  let stabilityScore = 0.7;
  if (numericCols[0]) {
    const { rows } = await engine.runQuery(`
      SELECT
        AVG(CASE WHEN rn % 2 = 0 THEN v END) AS a,
        AVG(CASE WHEN rn % 2 = 1 THEN v END) AS b
      FROM (SELECT "${numericCols[0].name}" AS v, ROW_NUMBER() OVER () AS rn FROM ${table})`);
    const { a, b } = rows[0];
    if (a != null && b != null && (a !== 0 || b !== 0)) {
      const diff = Math.abs(a - b) / (Math.abs(a) + Math.abs(b) + 1e-9);
      stabilityScore = 1 - Math.min(1, diff * 2);
    }
  }
  // Signal 5: sample size adequacy
  const sizeScore = rowCount >= 100 ? 1 : rowCount >= 30 ? 0.7 : 0.35;
  // Signal 6: anomaly concentration (negatives in non-negative-looking columns,
  // out-of-range values, and exact-duplicate rows all erode confidence directly —
  // this is what separates "statistically healthy" from "actually trustworthy")
  let anomalyHits = 0;
  for (const c of numericCols) {
    const name = c.name.toLowerCase();
    if (/amount|price|cost|charge|salary|revenue|count|qty|quantity/.test(name)) {
      const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" < 0`);
      anomalyHits += rows[0].n;
    }
    if (/age/.test(name)) {
      const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" > 130 OR "${c.name}" < 0`);
      anomalyHits += rows[0].n;
    }
  }
  const allColsList = cols.map(c => `"${c.name}"`).join(',');
  const { rows: dupRows } = await engine.runQuery(`SELECT COALESCE(SUM(c) - COUNT(*), 0) AS extra FROM (SELECT ${allColsList}, COUNT(*) AS c FROM ${table} GROUP BY ${allColsList} HAVING COUNT(*) > 1) t`);
  anomalyHits += dupRows[0].extra || 0;
  const anomalyRate = rowCount > 0 ? anomalyHits / rowCount : 0;
  const anomalyScore = 1 - Math.min(1, anomalyRate * 5);

  const weights = { sampleCoverage: 0.15, nullScore: 0.2, varianceScore: 0.15, stabilityScore: 0.15, sizeScore: 0.1, anomalyScore: 0.25 };
  const score = Math.round(100 * (
    sampleCoverage * weights.sampleCoverage +
    nullScore * weights.nullScore +
    varianceScore * weights.varianceScore +
    stabilityScore * weights.stabilityScore +
    sizeScore * weights.sizeScore +
    anomalyScore * weights.anomalyScore
  ));

  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
  const verdict = score >= 70 ? 'Ready to present' : 'Dig deeper first';
  const signals = {
    'Sample coverage': Math.round(sampleCoverage * 100),
    'Null rate': Math.round((1 - nullScore) * 100),
    'Variance': Math.round(varianceScore * 100),
    'Subsample stability': Math.round(stabilityScore * 100),
    'Sample size': Math.round(sizeScore * 100),
    'Anomaly concentration': Math.round((1 - anomalyScore) * 100),
  };
  return { score, grade, verdict, signals, status: score >= 70 ? 'pass' : score >= 50 ? 'warn' : 'fail' };
}

// Shared A/B/C/D banding used by the Confidence Layer — factored out so the
// per-claim scorer below grades on exactly the same scale as the table-level
// Confidence Layer rather than inventing a parallel one.
export function gradeConfidence(score) {
  return score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
}

// Per-claim confidence. The table-level runConfidence() above blends six
// signals; a single quantitative claim in a story is backed by a specific
// slice of the data, so we reuse the same three signals that apply at the
// claim level — sample coverage, sample-size adequacy, and null rate — with
// the identical formulas and A/B/C/D thresholds. This lets the Story tab badge
// every number with the SAME Confidence Layer logic instead of one global
// score for the whole narrative.
export function scoreClaimConfidence({ n = 0, missingRate = 0 } = {}) {
  const sampleCoverage = Math.min(1, n / 200);                 // matches runConfidence signal 1
  const nullScore = 1 - Math.min(1, missingRate * 4);          // matches runConfidence signal 2
  const sizeScore = n >= 100 ? 1 : n >= 30 ? 0.7 : 0.35;       // matches runConfidence signal 5
  const weights = { sampleCoverage: 0.3, nullScore: 0.3, sizeScore: 0.4 };
  const score = Math.round(100 * (
    sampleCoverage * weights.sampleCoverage +
    nullScore * weights.nullScore +
    sizeScore * weights.sizeScore
  ));
  const grade = gradeConfidence(score);
  return { score, grade, n, missingRate };
}

// ---------- 5. Denial Radar ----------
async function runDenialRadar(table, cols) {
  const denialCol = cols.find(c => /denial|denied|claim_status|status/i.test(c.name));
  const claimCol = cols.find(c => /claim/i.test(c.name));
  if (!denialCol && !claimCol) return result('idle', 'No claim/denial columns detected (requires EDI 835/837-style fields). Skipped.');
  if (!denialCol) return result('warn', 'Claim column found but no denial/status column — cannot assess denial patterns.');
  const { rows } = await engine.runQuery(`SELECT "${denialCol.name}" AS status, COUNT(*) AS n FROM ${table} GROUP BY 1 ORDER BY 2 DESC`);
  const total = rows.reduce((a, r) => a + r.n, 0);
  const denied = rows.filter(r => /den/i.test(String(r.status))).reduce((a, r) => a + r.n, 0);
  const rate = total > 0 ? denied / total : 0;
  if (denied === 0) return result('pass', 'No denial patterns detected in available claim status data.');
  return result(rate > 0.15 ? 'warn' : 'pass', `Denial rate: ${(rate * 100).toFixed(1)}% (${denied} of ${total} claims).`);
}

// ---------- 6. Schema Fingerprint ----------
async function runSchemaFingerprint(table, cols) {
  const schemaStr = JSON.stringify(cols.map(c => [c.name, c.type]).sort());
  const hash = await sha256(schemaStr);
  const prior = history.schemaFingerprints[table] || [];
  prior.push({ ts: Date.now(), hash });
  history.schemaFingerprints[table] = prior;
  if (prior.length < 2) return result('pass', `Schema fingerprint recorded: ${hash.slice(0, 12)}…`);
  const changed = prior[prior.length - 1].hash !== prior[prior.length - 2].hash;
  return changed
    ? result('fail', 'Schema changed since the last load — a column was renamed, removed, or retyped.')
    : result('pass', `Schema unchanged across ${prior.length} loads. Fingerprint: ${hash.slice(0, 12)}…`);
}

// ---------- 7. Semantic Drift Detector ----------
async function runSemanticDrift(table, cols) {
  const flags = [];
  for (const c of cols) {
    const name = c.name.toLowerCase();
    if (/age/.test(name) && ['DOUBLE', 'BIGINT', 'INTEGER', 'FLOAT'].includes(c.type)) {
      const { rows } = await engine.runQuery(`SELECT MAX("${c.name}") AS mx, MIN("${c.name}") AS mn FROM ${table}`);
      if (rows[0].mx > 130) flags.push(`"${c.name}" labeled as age but contains a value of ${rows[0].mx} (>130)`);
      if (rows[0].mn < 0) flags.push(`"${c.name}" labeled as age but contains negative value ${rows[0].mn}`);
    }
    if (/gender|sex/.test(name)) {
      const { rows } = await engine.runQuery(`SELECT COUNT(DISTINCT "${c.name}") AS n FROM ${table}`);
      if (rows[0].n > 6) flags.push(`"${c.name}" labeled as gender/sex but has ${rows[0].n} distinct values`);
    }
    if (/rate|percent|pct/.test(name) && ['DOUBLE', 'FLOAT'].includes(c.type)) {
      const { rows } = await engine.runQuery(`SELECT MAX("${c.name}") AS mx FROM ${table}`);
      if (rows[0].mx > 100) flags.push(`"${c.name}" looks like a percentage but exceeds 100 (max ${rows[0].mx})`);
    }
  }
  if (flags.length === 0) return result('pass', 'Column names match their actual value ranges.');
  return result('fail', `${flags.length} semantic mismatch(es) found`, flags);
}

// ---------- 8. Correlation Watchdog ----------
async function runCorrelationWatchdog(table, cols) {
  const numericCols = cols.filter(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type));
  if (numericCols.length < 2) return result('idle', 'Fewer than 2 numeric columns — nothing to correlate. Skipped.');
  const [a, b] = numericCols;
  const { rows } = await engine.runQuery(`SELECT CORR("${a.name}", "${b.name}") AS c FROM ${table}`);
  const corr = rows[0].c;
  const key = `${table}::${a.name}::${b.name}`;
  const prior = history.correlationSnapshots[key] || [];
  prior.push({ ts: Date.now(), corr });
  history.correlationSnapshots[key] = prior;
  const label = `${a.name} × ${b.name}`;
  if (corr == null || Number.isNaN(corr)) return result('warn', `Could not compute correlation for ${label}.`);
  if (prior.length < 2) return result('pass', `Baseline correlation recorded for ${label}: r = ${corr.toFixed(2)}.`);
  const prev = prior[prior.length - 2].corr;
  const delta = Math.abs(corr - prev);
  return delta > 0.3
    ? result('fail', `${label} correlation shifted from r=${prev.toFixed(2)} to r=${corr.toFixed(2)} — real relationships don't break randomly.`)
    : result('pass', `${label} correlation stable: r = ${corr.toFixed(2)}.`);
}

// ---------- 9. Narrative Consistency Checker ----------
export async function checkNarrativeConsistency(storyText, queryResult) {
  if (!queryResult) return { status: 'idle', mismatches: [] };
  // Grouping-aware: the Story tab formats figures with toLocaleString (e.g.
  // "1,000,062.09"), so match runs of digits-and-commas and strip separators
  // before comparison — otherwise "1,000,062.09" splits into 1 / 000 / 062.09
  // and each fragment is a false mismatch.
  const numbersInText = [...storyText.matchAll(/-?\d[\d,]*(?:\.\d+)?%?/g)].map(m => m[0].replace(/,/g, ''));
  const actualNumbers = new Set();
  const addNumber = (v) => {
    if (typeof v !== 'number' || Number.isNaN(v)) return;
    actualNumbers.add(v.toFixed(2));
    actualNumbers.add(String(Math.round(v)));
    actualNumbers.add(v.toFixed(1));
  };
  // Meta-numbers describing the result set (row count, column count) are
  // legitimate things a narrative can state even though they aren't cell
  // values themselves — include them so they aren't flagged as mismatches.
  addNumber(queryResult.rowCount);
  addNumber(queryResult.rows.length);
  if (Array.isArray(queryResult.columns)) addNumber(queryResult.columns.length);
  for (const row of queryResult.rows) {
    for (const v of Object.values(row)) {
      addNumber(v);
    }
  }

  // DERIVED statistics: the Story tab narrates aggregates computed FROM the
  // result set (a column's average/min/max, or "X% of rows are the most common
  // category") — these never appear as raw literal cell values, so without
  // recomputing them here every correct computed figure would be flagged as a
  // false mismatch. Mirror the Story Engine's math (see buildStoryClaims /
  // generateLocalStory in story.js) so the two agree.
  const rows = queryResult.rows || [];
  const columns = Array.isArray(queryResult.columns)
    ? queryResult.columns
    : (rows.length ? Object.keys(rows[0]) : []);
  if (rows.length) {
    for (const c of columns) {
      // Each Story claim carries a confidence badge reading
      // "n=<non-null count> · <missing%> missing" (confidenceBadgeHTML in
      // story.js). That text survives tag-stripping into lastStory, so register
      // the per-column non-null count and missing-rate percentage or every
      // badge is flagged as a false mismatch.
      const colNonNull = rows.reduce((k, r) => k + (r[c] != null ? 1 : 0), 0);
      addNumber(colNonNull);
      addNumber(((rows.length - colNonNull) / rows.length) * 100);

      const nums = rows.map(r => r[c]).filter(v => typeof v === 'number' && !Number.isNaN(v));
      if (nums.length) {
        // Column average, min, max — as stated by the numeric_mean claim.
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        addNumber(mean);
        addNumber(Math.min(...nums));
        addNumber(Math.max(...nums));
        // Proportion columns (every value in [0,1] — the shape of a 0/1 flag
        // like has_diabetes, or an already-normalised rate) are narrated as a
        // PERCENTAGE, e.g. "30% of patients have diabetes" for a mean of 0.30.
        // Without also offering mean*100 the correctly-rounded percentage never
        // matches the raw mean and every such claim is a false mismatch.
        if (nums.every(v => v >= 0 && v <= 1)) {
          addNumber(mean * 100);
          addNumber(Math.min(...nums) * 100);
          addNumber(Math.max(...nums) * 100);
        }
      } else {
        // Categorical: percentage of rows equal to the modal value, matching
        // category_share's ((topCount / rows.length) * 100) computation.
        const counts = {};
        let nonNull = 0;
        for (const r of rows) {
          const v = r[c];
          if (v != null) { counts[v] = (counts[v] || 0) + 1; nonNull++; }
        }
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        if (top) {
          addNumber((top[1] / rows.length) * 100);
          // Also allow the share expressed against the non-null denominator.
          if (nonNull) addNumber((top[1] / nonNull) * 100);
        }
      }
    }
  }
  const mismatches = [];
  for (const n of numbersInText) {
    const clean = n.replace('%', '');
    const asNum = parseFloat(clean);
    if (Number.isNaN(asNum)) continue;
    const rounded = String(Math.round(asNum));
    const found = actualNumbers.has(clean) || actualNumbers.has(rounded) || actualNumbers.has(asNum.toFixed(1)) || actualNumbers.has(asNum.toFixed(2));
    if (!found && Math.abs(asNum) > 0) mismatches.push(n);
  }
  return { status: mismatches.length ? 'fail' : 'pass', mismatches };
}

// ---------- 10. Freshness Meter ----------
function runFreshness(ds, thresholdHours) {
  const ageHours = (Date.now() - ds.loadedAt) / 3600000;
  const status = ageHours > thresholdHours * 3 ? 'fail' : ageHours > thresholdHours ? 'warn' : 'pass';
  return result(status, `Loaded ${ageHours < 1 ? 'less than an hour' : ageHours.toFixed(1) + ' hours'} ago. Threshold: ${thresholdHours}h.`);
}

// ---------- 11. Blind Spot Scanner ----------
function runBlindSpotScanner(cols) {
  const names = cols.map(c => c.name.toLowerCase());
  const missing = [];
  if (!names.some(n => /race|ethnic/.test(n))) missing.push('race/ethnicity');
  if (!names.some(n => /insurance|payer/.test(n))) missing.push('insurance/payer type');
  if (!names.some(n => /age/.test(n))) missing.push('age');
  if (!names.some(n => /gender|sex/.test(n))) missing.push('gender');
  if (!names.some(n => /location|region|zip|state/.test(n))) missing.push('geography');
  if (missing.length === 0) return result('pass', 'Common demographic dimensions are present — equity lens has coverage.');
  return result('warn', `Consider what conclusions might change with data on: ${missing.join(', ')}.`, missing);
}

// ---------- 12. Reproducibility Badge ----------
async function runReproducibility(table) {
  const hashes = [];
  for (let i = 0; i < 10; i++) {
    let rows;
    try {
      const res = await engine.runQuery(`SELECT COUNT(*) AS n, SUM(HASH(t)) AS h FROM (SELECT * FROM ${table} LIMIT 1000) t`);
      rows = res.rows;
    } catch (e) {
      const res = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table}`);
      rows = res.rows;
    }
    hashes.push(JSON.stringify(rows));
  }
  const allSame = hashes.every(h => h === hashes[0]);
  return allSame
    ? result('pass', 'Identical results across 10 consecutive runs on static data.')
    : result('fail', 'Results varied across identical runs — reproducibility failure.');
}

// ---------- 13. Outlier Detection (MAD + IQR) ----------
// MAD-based modified z-score outlier detection, Iglewicz & Hoaglin 1993
// (threshold |Mi| > 3.5); Tukey's IQR fences, Tukey 1977 (Q1-1.5*IQR, Q3+1.5*IQR).
async function runOutlierDetection(table, cols) {
  const numericCols = cols.filter(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type));
  if (numericCols.length === 0) return result('idle', 'No numeric columns to scan for outliers. Skipped.');
  const findings = [];
  for (const c of numericCols) {
    const col = `"${c.name}"`;
    const { rows } = await engine.runQuery(`
      SELECT
        median(${col}) AS med,
        mad(${col}) AS mad_val,
        quantile_cont(${col}, 0.25) AS q1,
        quantile_cont(${col}, 0.75) AS q3
      FROM ${table} WHERE ${col} IS NOT NULL`);
    const { med, mad_val, q1, q3 } = rows[0];
    if (med == null || q1 == null || q3 == null) continue;
    const iqr = q3 - q1;
    const lowerFence = q1 - 1.5 * iqr;
    const upperFence = q3 + 1.5 * iqr;
    // Modified z-score = 0.6745 * (x - median) / MAD. |Mi| > 3.5 flags an outlier.
    // When MAD is 0 the modified z-score is undefined, so rely on IQR fences alone.
    const madClause = (mad_val && mad_val > 0)
      ? `ABS(0.6745 * (${col} - ${med}) / ${mad_val}) > 3.5`
      : 'FALSE';
    const { rows: viol } = await engine.runQuery(`
      SELECT
        COUNT(*) FILTER (WHERE ${col} < ${lowerFence}) AS iqr_low,
        COUNT(*) FILTER (WHERE ${col} > ${upperFence}) AS iqr_high,
        COUNT(*) FILTER (WHERE ${madClause} AND ${col} < ${med}) AS mad_low,
        COUNT(*) FILTER (WHERE ${madClause} AND ${col} > ${med}) AS mad_high
      FROM ${table} WHERE ${col} IS NOT NULL`);
    const v = viol[0];
    const total = (v.iqr_low || 0) + (v.iqr_high || 0) + (v.mad_low || 0) + (v.mad_high || 0);
    if (total > 0) {
      const parts = [];
      if (v.mad_high > 0) parts.push(`${v.mad_high} high (MAD z>3.5)`);
      if (v.mad_low > 0) parts.push(`${v.mad_low} low (MAD z<-3.5)`);
      if (v.iqr_high > 0) parts.push(`${v.iqr_high} above IQR fence (>${formatNumber(upperFence)})`);
      if (v.iqr_low > 0) parts.push(`${v.iqr_low} below IQR fence (<${formatNumber(lowerFence)})`);
      findings.push(`"${c.name}": ${parts.join(', ')}`);
    }
  }
  if (findings.length === 0) return result('pass', 'No outliers detected via modified z-score or IQR fences.');
  return result('warn', `${findings.length} column(s) contain outliers (both high and low bounds checked).`, findings);
}

// ---------- 14. Benford's Law Check ----------
// Newcomb-Benford Law (Newcomb 1881; Benford 1938, public statistics):
// in many natural datasets the leading digit d occurs with probability
// log10(1 + 1/d). Large deviations (measured here by a chi-square-style
// statistic) can indicate fabricated, capped, or otherwise anomalous data.
const BENFORD_EXPECTED = [null, 0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046];

// Keywords that denote a bounded, non-magnitude quantity — Benford's Law does
// not apply to these no matter how they're distributed.
const BENFORD_BOUNDED_KEYWORDS = new Set([
  'age', 'rating', 'score', 'star', 'stars', 'grade', 'level', 'rank', 'year',
  'quarter', 'month', 'week', 'day', 'hour', 'minute', 'percent', 'pct', 'rate',
  'ratio', 'likert',
]);
// Column names that denote a naturally-scaled magnitude Benford's Law suits.
const BENFORD_MAGNITUDE_NAME = /amount|revenue|sales|price|cost|charge|population|transaction|balance|income|expense|salary|payment|volume|total|value|spend|budget/i;

// Plain-language teaching notes surfaced in the Validate tab whenever a column
// is skipped — one per eligibility-gate cause, so the explanation always matches
// the REASON a column was skipped rather than defaulting to the bounded-range
// rationale. Each reads as a short lesson on WHY Benford's Law does or doesn't
// apply, turning the skip from a silent pass/fail into an explanation.
export const BENFORD_TEACHINGS = {
  bounded_name: "Benford's Law describes naturally-scaled, multiplicative quantities that span several orders of magnitude — revenue, populations, transaction amounts. Bounded, human-assigned ranges like Age, ratings, or credit scores don't follow it, so applying the test there would produce meaningless \"violations.\" Columns below are skipped for that reason, not because anything is wrong with them.",
  small_sample: "Benford's Law is a statistical pattern that only emerges reliably once there are enough data points to observe it. With just a handful of rows the leading-digit distribution is dominated by chance, so the test would report a statistically meaningless result — a false pass or a false \"violation\" — in either direction. Columns below are skipped because there isn't enough data to draw a conclusion, not because the data is bad.",
  narrow_range: "Benford's Law relies on values spanning several orders of magnitude — from tens to hundreds to thousands and beyond — for the leading-digit distribution to take its expected shape. When every value sits at roughly the same scale (say, all in the hundreds), only one or two leading digits ever appear, so the pattern can't emerge even for a column that would otherwise be a good Benford candidate. Columns below are skipped for that reason.",
  binary_flag: "Binary flag columns (0/1, true/false) have only one or two possible leading digits by definition, so a leading-digit distribution test has nothing to measure. This isn't about a value range being \"bounded\" — it's a more basic reason the test doesn't apply at all: there is simply no distribution of leading digits to compare against Benford's expectation. Columns below are skipped for that reason.",
};

// Classify a skip-reason string into its teaching cause. The reason strings are
// produced by benfordEligibility() (bounded_name/small_sample/narrow_range) and,
// once a domain pack runs, by the binary-flag exemption rule — so classification
// is done on the final string and works no matter which layer produced the skip.
// Order matters: the more specific phrasings are matched before the generic
// "bounded" fallback, because the narrow-range reason also contains "(bounded)".
export function benfordSkipCause(reason) {
  const s = String(reason);
  if (/binary 0\/1 flag column/i.test(s)) return 'binary_flag';
  if (/orders of magnitude/i.test(s)) return 'narrow_range';
  if (/too few for a meaningful Benford test|usable value/i.test(s)) return 'small_sample';
  return 'bounded_name';
}

// Group skip-reason strings by teaching cause, preserving order of first
// appearance, so the UI (and tests) can render each distinct reason with the
// matching teaching paragraph. Returns [{ cause, teaching, skips: [reason...] }].
export function benfordTeachingGroups(skips) {
  const groups = [];
  const byCause = new Map();
  for (const reason of skips || []) {
    const cause = benfordSkipCause(reason);
    let g = byCause.get(cause);
    if (!g) {
      g = { cause, teaching: BENFORD_TEACHINGS[cause], skips: [] };
      byCause.set(cause, g);
      groups.push(g);
    }
    g.skips.push(reason);
  }
  return groups;
}

// Split a column name into lowercased constituent words, breaking on snake_case
// (_), kebab-case (-), whitespace, and camelCase/PascalCase transitions. A raw
// \b word-boundary regex misses keywords inside compound names because \b treats
// "_" as a word char, so "patient_age" never yields an "age" boundary.
export function splitColumnNameWords(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map(w => w.toLowerCase())
    .filter(Boolean);
}

// True when any constituent word of the column name is a bounded-quantity keyword.
export function isBenfordBoundedName(name) {
  return splitColumnNameWords(name).some(w => BENFORD_BOUNDED_KEYWORDS.has(w));
}

// Statistical Test Eligibility Gate. Decides whether Benford's Law is
// appropriate for a column and, when not, returns a human-readable reason.
// Benford applies to organically-scaled magnitudes that span multiple orders
// of magnitude; it does NOT apply to bounded ranges (Age, ratings 1–5, etc.).
async function benfordEligibility(table, c) {
  const col = `"${c.name}"`;
  if (isBenfordBoundedName(c.name)) {
    return { eligible: false, reason: `"${c.name}" skipped — bounded range, not a naturally-scaled magnitude Benford's Law applies to.` };
  }
  // Guard LOG10 inside a CASE so it is NEVER evaluated on a value < 1 (e.g. a
  // literal 0, extremely common in healthcare flag columns). DuckDB may evaluate
  // the LOG10 argument for every row before applying a FILTER clause, so relying
  // on FILTER alone throws "cannot take logarithm of zero" and aborts the whole
  // Benford layer. The CASE returns NULL for excluded rows; COUNT(DISTINCT ...)
  // ignores NULLs, so the order-of-magnitude count stays correct.
  const { rows } = await engine.runQuery(`
    SELECT COUNT(*) FILTER (WHERE ${col} IS NOT NULL AND ABS(${col}) >= 1) AS n,
           COUNT(DISTINCT CASE WHEN ${col} IS NOT NULL AND ABS(${col}) >= 1
                               THEN FLOOR(LOG10(ABS(${col}))) END) AS orders,
           COUNT(*) FILTER (WHERE ${col} IS NOT NULL) AS nonnull,
           COUNT(*) FILTER (WHERE ${col} IS NOT NULL AND ${col} <> 0 AND ${col} <> 1) AS non_binary
    FROM ${table}`);
  const n = Number(rows[0].n) || 0;
  const orders = Number(rows[0].orders) || 0;
  const nonnull = Number(rows[0].nonnull) || 0;
  const nonBinary = Number(rows[0].non_binary) || 0;
  // Binary 0/1 flag columns (common healthcare booleans like has_diabetes,
  // mortality_flag) have at most two leading digits by definition, so a
  // leading-digit distribution test has nothing to measure — and any value of
  // 0 makes Benford mathematically undefined (log10(0)). Recognise them in the
  // CORE eligibility gate itself, not only when a domain pack happens to be
  // active, so the skip is labelled as the deliberate binary-flag exemption
  // (benfordSkipCause -> 'binary_flag') no matter which pack (or none) is loaded.
  if (nonnull > 0 && nonBinary === 0) {
    return { eligible: false, reason: `"${c.name}" skipped — binary 0/1 flag column, exempt from Benford's Law (which applies only to multi-order-of-magnitude quantities).` };
  }
  if (n < 50) {
    return { eligible: false, reason: `"${c.name}" skipped — only ${n} usable value(s); too few for a meaningful Benford test.` };
  }
  // Naturally-scaled magnitudes span ≥2 orders of magnitude. Allow a name-based
  // override for known magnitude quantities that happen to be narrowly ranged.
  if (orders < 2 && !BENFORD_MAGNITUDE_NAME.test(c.name)) {
    return { eligible: false, reason: `"${c.name}" skipped — values span <2 orders of magnitude (bounded), so Benford's Law is not applicable.` };
  }
  return { eligible: true };
}

async function runBenford(table, cols) {
  const numericCols = cols.filter(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type));
  if (numericCols.length === 0) return result('idle', 'No numeric columns to test against Benford\'s Law. Skipped.');
  const flags = [];
  const skips = [];
  let tested = 0;
  for (const c of numericCols) {
    const gate = await benfordEligibility(table, c);
    if (!gate.eligible) {
      skips.push(gate.reason);
      logAssumption('Statistical Test Eligibility Gate', `Skipped Benford's Law on "${c.name}" — ${gate.reason.replace(/^"[^"]+" skipped — /, '')}`);
      continue;
    }
    tested++;
    const col = `"${c.name}"`;
    // Leading digit of the absolute value.
    const { rows } = await engine.runQuery(`
      SELECT CAST(SUBSTR(REPLACE(CAST(ABS(${col}) AS VARCHAR), '.', ''), 1, 1) AS INTEGER) AS d, COUNT(*) AS n
      FROM ${table}
      WHERE ${col} IS NOT NULL AND ABS(${col}) >= 1
      GROUP BY 1`);
    const counts = new Array(10).fill(0);
    let total = 0;
    for (const r of rows) {
      const d = r.d;
      if (d >= 1 && d <= 9) { counts[d] = r.n; total += r.n; }
    }
    let chiSq = 0;
    for (let d = 1; d <= 9; d++) {
      const expected = BENFORD_EXPECTED[d] * total;
      chiSq += ((counts[d] - expected) ** 2) / expected;
    }
    // Chi-square critical value for 8 dof at p=0.05 is 15.51; above => deviates.
    if (chiSq > 15.51) {
      flags.push(`"${c.name}": leading-digit distribution deviates from Benford (χ² = ${chiSq.toFixed(1)} > 15.51).`);
    }
  }
  const detail = [...flags, ...skips];
  let r;
  if (flags.length > 0) {
    r = result('warn', `${flags.length} column(s) deviate from Benford's Law — worth a closer look.`, detail);
  } else if (tested === 0) {
    r = result('idle', `No columns eligible for Benford's Law — ${skips.length} skipped (see why below).`, skips);
  } else {
    r = result('pass', `${tested} eligible column(s) consistent with Benford's Law${skips.length ? `; ${skips.length} skipped as ineligible` : ''}.`, detail);
  }
  r.skips = skips;
  r.flags = flags;
  return r;
}

// ---------- 16. Categorical Consistency Engine ----------
// Clusters near-identical spellings of the same category (Levenshtein 1965 /
// Jaro-Winkler 1990 similarity plus a small ISO-3166 abbreviation lookup) and
// proposes the most frequent variant as the canonical merge target.
// This layer is domain-agnostic: it clusters near-identical spellings and, by
// default, proposes the most frequent variant as a canonical merge for EVERY
// cluster. Whether a given column is a protected/sensitive category (where an
// auto-merge could corrupt legally/clinically distinct values) is NOT decided
// here — it is a domain judgement applied afterwards by the Domain Physics
// Engine's protected-category rule (see js/domain-physics.js), which flips
// `cl.sensitive` to true. `describeCluster` renders either form identically
// wherever it is called. Assumption-ledger entries are emitted after the pack
// has run (see logCategoricalAssumptions) so they reflect the final state.
async function runCategoricalConsistency(table, cols) {
  const catCols = cols.filter(c => c.type === 'VARCHAR');
  if (catCols.length === 0) return result('idle', 'No categorical (text) columns to check for spelling variants. Skipped.');
  const clusters = []; // machine-readable, for one-click merge in the UI
  for (const c of catCols) {
    const cols16 = await detectColumnClusters(table, c.name, engine).catch(() => []);
    for (const cl of cols16) {
      clusters.push({ column: c.name, sensitive: false, ...cl });
    }
  }
  if (clusters.length === 0) return result('pass', 'No near-duplicate category spellings detected.');
  const r = result('warn', `${clusters.length} inconsistent category cluster(s) found — review suggested merges.`, clusters.map(describeCluster));
  r.clusters = clusters;
  return r;
}

// Emit assumption-ledger entries for the categorical clusters AFTER the domain
// pack has (potentially) flipped some to sensitive. Kept separate from the
// layer run so the ledger reflects the final, pack-reinterpreted state while
// preserving the historical 'Categorical Consistency Engine' source.
function logCategoricalAssumptions(catResult) {
  if (!catResult || !Array.isArray(catResult.clusters)) return;
  for (const cl of catResult.clusters) {
    if (cl.sensitive) {
      logAssumption(
        'Categorical Consistency Engine',
        `Flagged near-identical values in sensitive column "${cl.column}" (${cl.variants.map(v => `"${v.value}"`).join(', ')}) but disabled auto-merge — these may be legally/clinically distinct.`,
        { column: cl.column, sensitive: true, variants: cl.variants }
      );
    } else {
      logAssumption(
        'Categorical Consistency Engine',
        `Proposed merging ${cl.merges.map(m => `"${m.from}"`).join(', ')} → "${cl.canonical}" in "${cl.column}" (canonical = most frequent variant).`,
        { column: cl.column, canonical: cl.canonical, merges: cl.merges }
      );
    }
  }
}

// ---------- 17. Cross-Column Logical Consistency ----------
// Detects impossible/contradictory combinations across columns in the same row
// (end-before-start dates, inverted numeric ranges, male-and-pregnant,
// infant-with-adult-marital-status, minor-with-adult-only-status, an abnormal
// status flag with no measurement behind it). The rule engine + heuristic,
// name-pattern column pairing live in js/cross-column-consistency.js so the
// detection/firing logic is unit-testable in isolation; this layer wraps it in
// the standard result shape and, like the Categorical Consistency Engine,
// records each finding in the Assumption Ledger for the audit trail.
const NUMERIC_T = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];

async function runCrossColumnLogic(table, cols) {
  const findings = await runCrossColumnChecks(table, cols, engine, { magnitude: isEnabled(EXTENDED_COVERAGE_FLAG) });
  for (const f of findings) {
    logAssumption('Cross-Column Logical Consistency', `Flagged ${f.text}`, { rule: f.rule, columns: f.columns, count: f.count });
  }
  if (findings.length === 0) return result('pass', 'No impossible cross-column combinations detected.');
  const r = result('fail', `${findings.length} logical inconsistency type(s) found across columns.`, findings.map(f => f.text));
  r.findings = findings;
  return r;
}

// ---------- 18b. DRG / ICD-10 Coding Validation ----------
// Healthcare coding cross-check: detects MS-DRG codes whose principal
// ICD-10-CM diagnosis is incompatible under public CMS MS-DRG grouper rules
// (FY2024 IPPS). Fires only when the dataset has both a DRG column and a
// primary ICD column; silently skipped otherwise (no false positives on
// non-claims datasets). Each finding carries the DRG family, the affected
// count, and a plain-language explanation for a coder to act on.
// Detection + DRG family table live in js/validation/drg-icd-validator.js.
async function runDrgIcdValidationLayer(table, cols) {
  const findings = await runDrgIcdValidation(table, cols, engine);
  if (findings.length === 0) {
    // Determine whether DRG/ICD columns were even present.
    const { detectDrgColumn, detectPrimaryIcdColumn } = await import('./drg-icd-validator.js');
    const hasDrg = !!detectDrgColumn(cols);
    const hasIcd = !!detectPrimaryIcdColumn(cols);
    if (!hasDrg || !hasIcd) {
      return result('idle', 'No DRG and ICD-10 column pair detected. Skipped (non-claims dataset).');
    }
    return result('pass', 'No DRG / ICD-10 coding mismatches detected.');
  }
  for (const f of findings) {
    logAssumption('DRG / ICD-10 Coding Validation', `Flagged ${f.text}`, { rule: f.rule, columns: f.columns, count: f.count });
  }
  const r = result('fail', `${findings.length} DRG / ICD-10 coding mismatch type(s) detected — audit and reimbursement risk.`, findings.map(f => f.text));
  r.findings = findings;
  return r;
}

// ---------- 18. Distributional Fingerprint Drift ----------
// Sibling of the Schema Fingerprint layer: even when the schema is unchanged,
// the DATA can silently shift. On each load we record a per-column
// distribution fingerprint keyed by the schema signature, then compare a later
// load of the same schema against a stored baseline.
//
// The fingerprint is a handful of cheap-to-derive summary numbers per
// column — for every column: null rate and cardinality ratio; additionally for
// numeric columns mean/std/skew/min/max, and for categorical columns the five
// most frequent labels. It contains NO raw rows and is not reversible back to
// the data; that is what makes it safe to cache locally (see runDistributionDrift
// and js/memory-store.js) without violating the zero-upload trust story.
export async function computeDistributionFingerprint(table, cols) {
  const stats = {};
  for (const c of cols) {
    const col = `"${c.name}"`;
    // Common shape stats for every column: null rate + cardinality ratio.
    const { rows: shapeRows } = await engine.runQuery(`
      SELECT COUNT(*) AS total,
             COUNT(${col}) AS nonnull,
             COUNT(DISTINCT ${col}) AS ndistinct
      FROM ${table}`);
    const total = Number(shapeRows[0].total) || 0;
    const nonnull = Number(shapeRows[0].nonnull) || 0;
    const ndistinct = Number(shapeRows[0].ndistinct) || 0;
    const nullRate = total > 0 ? (total - nonnull) / total : null;
    // Cardinality as a ratio of distinct non-null values to non-null rows,
    // so it is comparable across files of different sizes (1.0 = all unique).
    const cardinality = nonnull > 0 ? ndistinct / nonnull : null;

    if (NUMERIC_T.includes(c.type)) {
      const { rows } = await engine.runQuery(`
        SELECT AVG(${col}) AS mean, STDDEV_POP(${col}) AS std, skewness(${col}) AS skew,
               MIN(${col}) AS mn, MAX(${col}) AS mx
        FROM ${table} WHERE ${col} IS NOT NULL`);
      stats[c.name] = {
        kind: 'numeric',
        nullRate, cardinality,
        mean: rows[0].mean != null ? Number(rows[0].mean) : null,
        std: rows[0].std != null ? Number(rows[0].std) : null,
        skew: rows[0].skew != null ? Number(rows[0].skew) : null,
        min: rows[0].mn != null ? Number(rows[0].mn) : null,
        max: rows[0].mx != null ? Number(rows[0].mx) : null,
      };
    } else if (c.type === 'VARCHAR') {
      const { rows } = await engine.runQuery(`
        SELECT ${col} AS v, COUNT(*) AS n FROM ${table}
        WHERE ${col} IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 5`);
      // Modal-category share: proportion of non-null rows equal to the single
      // most-frequent label. Added alongside the existing `top` list (additive,
      // so older baselines missing it still compare fine) to give the
      // Forecast-Based Drift Alerting extension a forecastable scalar series for
      // categorical columns — reusing this GROUP BY rather than a new scan.
      const topCount = rows.length ? Number(rows[0].n) : 0;
      const topProp = nonnull > 0 ? topCount / nonnull : null;
      stats[c.name] = {
        kind: 'categorical',
        nullRate, cardinality,
        top: rows.map(r => String(r.v)),
        topLabel: rows.length ? String(rows[0].v) : null,
        topProp,
      };
    }
  }
  return stats;
}

// A stable schema signature: sorted [name, type] pairs. Files with matching
// schemas produce the same signature even if their filenames (or the DuckDB
// table name) differ — so "this month's export" can be compared against "last
// month's export". Exported so the persistence layer and tests share one
// definition of "same schema".
export function schemaSignature(cols) {
  return JSON.stringify(cols.map(c => [c.name, c.type]).sort());
}

// Drift thresholds. Deliberately conservative, first-principles heuristics —
// not tuned to mimic any specific commercial data-observability tool.
const DRIFT_MEAN_SIGMA = 2;      // mean shift, in prior standard deviations
const DRIFT_NULLRATE_JUMP = 0.2; // absolute change in null rate (20 pts)
const DRIFT_CARDINALITY_JUMP = 0.3; // absolute change in cardinality ratio

export function compareDistributions(prev, curr) {
  const drifts = [];
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  for (const [name, cs] of Object.entries(curr)) {
    const ps = prev[name];
    if (!ps || ps.kind !== cs.kind) continue;

    // Null-rate jump — applies to every column kind. Older baselines may lack
    // nullRate, so both sides are guarded.
    if (ps.nullRate != null && cs.nullRate != null &&
        Math.abs(cs.nullRate - ps.nullRate) >= DRIFT_NULLRATE_JUMP) {
      drifts.push(`"${name}": null rate jumped from ${pct(ps.nullRate)} to ${pct(cs.nullRate)}.`);
    }
    // Cardinality change — a column going from mostly-unique to mostly-repeated
    // (or vice-versa) often signals a schema/meaning change even if the schema
    // string is unchanged.
    if (ps.cardinality != null && cs.cardinality != null &&
        Math.abs(cs.cardinality - ps.cardinality) >= DRIFT_CARDINALITY_JUMP) {
      drifts.push(`"${name}": distinct-value ratio changed from ${pct(ps.cardinality)} to ${pct(cs.cardinality)}.`);
    }

    if (cs.kind === 'numeric') {
      if (ps.mean != null && cs.mean != null && ps.std != null && ps.std > 0) {
        const shift = Math.abs(cs.mean - ps.mean) / ps.std;
        if (shift > DRIFT_MEAN_SIGMA) {
          drifts.push(`"${name}": mean shifted ${shift.toFixed(1)}σ (was ${ps.mean.toFixed(2)}, now ${cs.mean.toFixed(2)}).`);
        }
      }
    } else if (cs.kind === 'categorical') {
      const prevSet = new Set(ps.top);
      const changed = cs.top.filter(v => !prevSet.has(v));
      if (changed.length > 0 && ps.top.length > 0) {
        drifts.push(`"${name}": top-5 category composition changed — new entrants: ${changed.map(v => `"${v}"`).join(', ')}.`);
      }
    }
  }
  return drifts;
}

// Persistence is INJECTED, never imported: validation.js stays pure and
// Node-testable, and the browser-only IndexedDB store (js/memory-store.js) is
// passed in via opts only when the user has opted in. opts.fingerprintStore, if
// present, must expose async getBaseline(hash) -> { columnStats } | undefined
// and async saveBaseline(hash, stats). Without it the layer falls back to the
// in-session (RAM-only) baseline, exactly as before — no consent required for
// same-session comparison because nothing is persisted.
async function runDistributionDrift(table, cols, opts = {}) {
  const hash = await sha256(schemaSignature(cols));
  const stats = await computeDistributionFingerprint(table, cols);

  // In-session baseline (RAM only): drift between two loads within one session.
  const prior = history.distributionFingerprints[table] || [];
  const lastSameSchema = [...prior].reverse().find(p => p.hash === hash);
  prior.push({ ts: Date.now(), hash, stats });
  history.distributionFingerprints[table] = prior;

  // Cross-session baseline (opt-in): compare against a fingerprint persisted on
  // a PRIOR session for the SAME schema — e.g. last month's export vs this
  // month's, even under a different filename. Only stores the small numeric
  // summary above, never raw rows.
  let baselineStats = null;
  let source = null;
  if (opts.fingerprintStore) {
    try {
      const stored = await opts.fingerprintStore.getBaseline(hash);
      if (stored && stored.columnStats) {
        baselineStats = stored.columnStats;
        source = stored.version > 1
          ? `the stored fingerprint from a previous session (v${stored.version})`
          : 'the stored fingerprint from a previous session';
      }
      await opts.fingerprintStore.saveBaseline(hash, stats);
    } catch (e) { /* IndexedDB unavailable/blocked — fall back to in-session */ }
  }
  if (!baselineStats && lastSameSchema) {
    baselineStats = lastSameSchema.stats;
    source = 'the fingerprint recorded earlier this session';
  }

  // Static (baseline) drift — the original PR#15 behaviour, unchanged.
  let r;
  if (!baselineStats) {
    r = result('pass', `Distribution fingerprint recorded for ${Object.keys(stats).length} column(s) — baseline established.`);
  } else {
    const drifts = compareDistributions(baselineStats, stats);
    if (drifts.length === 0) {
      r = result('pass', `Column distributions are stable versus ${source} — no drift.`);
    } else {
      for (const d of drifts) {
        logAssumption('Distributional Fingerprint Drift', `Detected drift vs ${source}: ${d}`);
      }
      r = result('fail', `${drifts.length} column(s) drifted versus ${source} despite an unchanged schema — the data moved even though its shape didn't.`, drifts);
    }
  }

  // Forecast-Based Drift Alerting (extends the static check above). Only runs
  // when the injected store exposes the trend-history contract — i.e. the user
  // opted into cross-session persistence. It projects each tracked stat forward
  // from the stored sequence of prior uploads and flags this upload if it falls
  // outside the forecast's confidence band. With too little history it stays
  // inactive and we silently keep the static behaviour above (never a
  // forecast claim on a trajectory we haven't observed).
  r.forecast = await runForecastAlerting(hash, stats, opts).catch(() => null);
  if (r.forecast && r.forecast.active && r.forecast.flags.length) {
    for (const f of r.forecast.flags) {
      logAssumption('Forecast-Based Drift Alerting', f.message);
    }
    // Surface trend-aware alerts even when the static check passed, but never
    // downgrade a hard static drift failure.
    if (r.status === 'pass') {
      r.status = 'warn';
      r.summary = `${r.forecast.flags.length} trend-aware drift alert(s): this upload is outside the forecasted trajectory from ${r.forecast.historyLen} prior upload(s), even though static drift did not fire.`;
    }
  }
  return r;
}

// Fetch the stored per-schema history, forecast the next upload, and append the
// current fingerprint for future runs. Kept separate so runDistributionDrift's
// static path is untouched when no trend-history store is injected.
async function runForecastAlerting(hash, stats, opts) {
  const store = opts.fingerprintStore;
  if (!store || typeof store.getFingerprintHistory !== 'function') return null;
  const history = await store.getFingerprintHistory(hash);        // [{ ts, stats }]
  const priorStats = (history || []).map(h => h.stats).filter(Boolean);
  const report = forecastDriftReport(priorStats, stats, {});
  if (typeof store.appendFingerprintHistory === 'function') {
    await store.appendFingerprintHistory(hash, stats);
  }
  return report;
}

// Build per-column metadata the Domain Physics Engine's rules match on. Kept
// domain-agnostic: { name, type, numeric, isBinary01 }. isBinary01 is queried
// only for numeric columns (a column whose non-null values are all 0 or 1).
async function computeColumnMeta(table, cols) {
  const NUM = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];
  const meta = [];
  for (const c of cols) {
    const numeric = NUM.includes(c.type);
    let isBinary01 = false;
    if (numeric) {
      try {
        const { rows } = await engine.runQuery(`
          SELECT COUNT(*) FILTER (WHERE "${c.name}" IS NOT NULL) AS nonnull,
                 COUNT(*) FILTER (WHERE "${c.name}" NOT IN (0, 1) AND "${c.name}" IS NOT NULL) AS outside
          FROM ${table}`);
        const nonnull = Number(rows[0].nonnull) || 0;
        const outside = Number(rows[0].outside) || 0;
        isBinary01 = nonnull > 0 && outside === 0;
      } catch (e) { /* leave isBinary01 false on any query error */ }
    }
    meta.push({ name: c.name, type: c.type, numeric, isBinary01 });
  }
  return meta;
}

// ---------- 19. Physiological Plausibility (healthcare-aware) ----------
// A healthcare-aware validation layer above the generic statistical validators.
// It encodes hard human-biology plausibility bounds for five well-established
// vital signs and flags values that are physiologically impossible (data errors
// such as unit slips or typos) rather than merely statistically unusual. The
// detection/bounds logic lives in js/physiological-plausibility.js so it is
// unit-testable in isolation; this wrapper adds the standard result shape,
// records each finding in the Assumption Ledger (as the other layers do), and
// always carries the plain-language, non-clinical disclaimer.
async function runPhysiologicalPlausibility(table, cols) {
  const { findings, matched } = await runPhysiologicalChecks(table, cols, engine);
  if (matched.length === 0) {
    const r = result('idle', 'No recognizable vital-sign columns (heart rate, temperature, blood pressure, respiratory rate, SpO₂) detected. Skipped.');
    r.disclaimer = PHYSIO_DISCLAIMER;
    r.findings = [];
    r.matched = [];
    return r;
  }
  for (const f of findings) {
    logAssumption('Physiological Plausibility', `Flagged ${f.text}`, { vital: f.vital, columns: f.columns || [f.column], count: f.count });
  }
  const checkedLabel = matched.map(m => `${m.column}${m.unit ? ` (${m.unit})` : ''}`).join(', ');
  let r;
  if (findings.length === 0) {
    r = result('pass', `Checked ${matched.length} vital-sign column(s) — all values within general human physiological plausibility limits.`);
  } else {
    r = result('warn', `${findings.length} vital-sign issue(s) with physiologically implausible values — likely data errors to review.`, findings.map(f => f.text));
  }
  r.disclaimer = PHYSIO_DISCLAIMER;
  r.findings = findings;
  r.matched = matched;
  r.checkedLabel = checkedLabel;
  return r;
}

// ---------- 20. Upper-Bound Sanity Anchor (logical/definitional bounds) ----------
// A sibling of the Physiological Plausibility layer that anchors on LOGICAL
// rather than biological limits: percentages are 0–100 and proportions/
// probabilities are 0–1 by definition, so a value outside those bounds is
// impossible regardless of the column's own statistics (a percentage of 500 is
// a typo/decimal slip, not merely an outlier). The detection + conservative
// bound-selection logic lives in js/upper-bound-sanity.js so it is unit-testable
// in isolation; this wrapper adds the standard result shape and records each
// finding in the Assumption Ledger, as the other layers do.
async function runUpperBoundSanity(table, cols) {
  const { findings, matched } = await runUpperBoundChecks(table, cols, engine);
  if (matched.length === 0) {
    const r = result('idle', 'No definitionally-bounded columns (percentages, proportions/probabilities) detected. Skipped.');
    r.findings = [];
    r.matched = [];
    r.note = UPPER_BOUND_NOTE;
    return r;
  }
  for (const f of findings) {
    logAssumption('Upper-Bound Sanity Anchor', `Flagged ${f.text}`, { column: f.column, category: f.category, count: f.count });
  }
  const checkedLabel = matched.map(m => `${m.column} (${m.category} ${m.low}–${m.high})`).join(', ');
  let r;
  if (findings.length === 0) {
    r = result('pass', `Checked ${matched.length} definitionally-bounded column(s) — all values within their logical bounds.`);
  } else {
    r = result('warn', `${findings.length} column(s) contain values outside their logical bounds — impossible by definition, likely data-entry or unit errors.`, findings.map(f => f.text));
  }
  r.findings = findings;
  r.matched = matched;
  r.checkedLabel = checkedLabel;
  r.note = UPPER_BOUND_NOTE;
  return r;
}

// ---------- 21. Missingness Detective (causal missingness report) ----------
// Goes beyond "% missing" by classifying each meaningfully-missing column with
// Rubin's MCAR/MAR/MNAR taxonomy: it searches the other observed columns for one
// that explains the missingness (MAR), defaults to "no driver found" (MCAR when
// nothing explains it — not a proof of randomness), and raises a conservative,
// clearly-labelled MNAR hypothesis for heavily-missing core fields. The
// detection statistics live in js/missingness-detective.js so they are
// unit-testable without a database; this wrapper adds the standard result shape
// and records each finding in the Assumption Ledger, as the other layers do.
async function runMissingnessDetectiveLayer(table, cols) {
  const { findings, analyzed } = await runMissingnessDetective(table, cols, engine);
  if (analyzed.length === 0) {
    const r = result('pass', 'No column has missingness above the reporting threshold — nothing to explain.');
    r.findings = [];
    r.analyzed = [];
    r.note = MISSINGNESS_NOTE;
    return r;
  }
  for (const f of findings) {
    logAssumption('Missingness Detective', `Classified ${f.text}`, {
      column: f.column,
      classification: f.classification,
      driverColumn: f.driverColumn,
      missingRate: f.missingRate,
      mnarCaution: f.mnarCaution,
    });
  }
  const mar = findings.filter(f => f.classification === 'MAR');
  const mnar = findings.filter(f => f.mnarCaution);
  const checkedLabel = analyzed.map(a => `${a.column} (${a.missingRate}% missing)`).join(', ');
  let r;
  if (mar.length > 0 || mnar.length > 0) {
    const bits = [];
    if (mar.length) bits.push(`${mar.length} column(s) show non-random (MAR) missingness with an identifiable driver`);
    if (mnar.length) bits.push(`${mnar.length} flagged for MNAR-risk investigation`);
    r = result('warn', `${bits.join('; ')} — dropping or naively imputing these could bias results.`, findings.map(f => f.text));
  } else {
    r = result('pass', `Checked ${analyzed.length} column(s) with meaningful missingness — all consistent with random missingness (no systematic driver found).`, findings.map(f => f.text));
  }
  r.findings = findings;
  r.analyzed = analyzed;
  r.checkedLabel = checkedLabel;
  r.note = MISSINGNESS_NOTE;
  return r;
}

// ---------- Equity Stratification Orchestrator (Phase 3) ----------
// Detects equity-relevant columns (race, sex, zip, payer, age group, disability),
// stratifies outcome metrics (readmit, denial, mortality, LOS, cost, ED, quality)
// by those columns using DuckDB GROUP BY queries, and scores disparities against
// CMS Disparities Impact Statement thresholds. Builds a signed equity attestation
// block that is embedded in the Trust Certificate.
// Gated by the 'equityStratification' feature flag.
async function runEquityLayer(ds, cols, options = {}) {
  const flagKey = 'equityStratification';
  const flagEnabled = isFeatureFlagEnabled(flagKey);
  if (!flagEnabled) {
    return {
      status: 'idle', level: 'none', layer: 'equity',
      detectionResult: null, stratificationResult: null, attestation: null,
      rationale: 'Equity stratification is disabled (flag ' + flagKey + ' = false).',
    };
  }

  const table = ds && ds.table ? ds.table : null;
  if (!table) {
    return {
      status: 'idle', level: 'none', layer: 'equity',
      detectionResult: null, stratificationResult: null, attestation: null,
      rationale: 'Equity layer skipped -- no table available.',
    };
  }

  const engineAdapter = { runQuery: (sql) => engine.runQuery(sql) };

  try {
    // 1. Detect equity-relevant columns.
    const detectionResult = detectEquityColumns(cols);

    // 2. Stratify and score disparities.
    const stratificationResult = detectionResult.hasEquityData
      ? await stratifyEquity({
          table,
          stratifiers: detectionResult.stratifiers,
          metrics: detectionResult.metrics,
          engine: engineAdapter,
        })
      : {
          analyses: [], status: 'idle', level: 'none',
          summary: { total: 0, pass: 0, warn: 0, fail: 0, idle: 0, flaggedPairs: 0 },
          rationale: detectionResult.summary,
        };

    // 3. Build the signed equity attestation block.
    const runId = (options && options.runId) ? options.runId : null;
    const attestation = await buildEquityAttestation({
      tableName: table,
      runId,
      detectionResult,
      stratificationResult,
    });

    // Emit an assumption-ledger entry so the equity finding is auditable.
    if (stratificationResult.status === 'fail' || stratificationResult.status === 'warn') {
      logAssumption(
        'Equity Stratification',
        stratificationResult.rationale,
        {
          status: stratificationResult.status,
          level: stratificationResult.level,
          flaggedPairs: stratificationResult.summary.flaggedPairs,
          totalPairs: stratificationResult.summary.total,
        }
      );
    }

    return {
      status: stratificationResult.status,
      level: stratificationResult.level,
      layer: 'equity',
      detectionResult,
      stratificationResult,
      attestation,
      rationale: stratificationResult.rationale,
    };
  } catch (err) {
    return {
      status: 'idle', level: 'none', layer: 'equity',
      detectionResult: null, stratificationResult: null, attestation: null,
      rationale: 'Equity layer error (non-fatal): ' + String(err && err.message ? err.message : err),
    };
  }
}

// ---------- Relational Integrity Orchestrator ----------
// Runs the three Phase 2 relational sub-checks, each gated by its own flag.
// Returns a unified relational result that rolls up to the worst sub-check status.
// options.relationalPairs: Array<{childTable,childCol,parentTable,parentCol,label}>
//   -- explicit FK/join pairs for multi-table checks. Derived from state.datasets
//   when not provided.
async function runRelationalLayer(ds, cols, options = {}) {
  const table = ds.table;
  const engineAdapter = { runQuery: (sql) => engine.runQuery(sql) };

  // Sub-results -- each defaults to idle if its flag is off.
  let temporal = { status: 'idle', level: 'none', summary: 'Temporal order checks not enabled.', rules: [] };
  let flagConsistency = { status: 'idle', level: 'none', summary: 'Flag consistency checks not enabled.', rules: [] };
  let fkCheck = { status: 'idle', level: 'none', summary: 'FK / orphan checks not enabled.', pairs: [] };
  let joinCoverage = { status: 'idle', level: 'none', summary: 'Join coverage checks not enabled.', pairs: [] };

  // 1. Temporal order checks (single-table, intra-row date comparisons)
  if (isEnabled('temporalOrderChecks')) {
    temporal = await checkTemporalOrder({ table, cols, engine: engineAdapter })
      .catch(e => ({ status: 'idle', level: 'none', rules: [],
        summary: 'Temporal order check error: ' + (e && e.message ? e.message : String(e)) }));
  }

  // 2. Flag consistency checks (single-table, intra-row flag logic)
  if (isEnabled('flagConsistencyChecks')) {
    flagConsistency = await checkFlagConsistency({ table, cols, engine: engineAdapter })
      .catch(e => ({ status: 'idle', level: 'none', rules: [],
        summary: 'Flag consistency check error: ' + (e && e.message ? e.message : String(e)) }));
  }

  // 3. Cross-table FK + join coverage (requires relationalPairs or auto-detection
  //    via state.datasets -- only runs when a second table is loaded).
  const pairs = options.relationalPairs || autoDetectPairs(ds, cols);
  if (pairs.length > 0) {
    if (isEnabled('crossTableReferentialIntegrity')) {
      fkCheck = await checkAllForeignKeys(pairs, engineAdapter)
        .catch(e => ({ status: 'idle', level: 'none', pairs: [],
          summary: 'FK check error: ' + (e && e.message ? e.message : String(e)) }));
    }
    if (isEnabled('joinCoverageChecks')) {
      joinCoverage = await checkAllJoinCoverage(pairs, engineAdapter)
        .catch(e => ({ status: 'idle', level: 'none', pairs: [],
          summary: 'Join coverage check error: ' + (e && e.message ? e.message : String(e)) }));
    }
  }

  // Roll up to worst status across all sub-checks.
  const subStatuses = [temporal.status, flagConsistency.status, fkCheck.status, joinCoverage.status];
  const overallStatus = subStatuses.includes('fail') ? 'fail'
    : subStatuses.includes('warn') ? 'warn'
    : subStatuses.every(s => s === 'idle') ? 'idle' : 'pass';
  const subLevels = [temporal.level, flagConsistency.level, fkCheck.level, joinCoverage.level];
  const overallLevel = subLevels.includes('high') ? 'high'
    : subLevels.includes('medium') ? 'medium'
    : subLevels.includes('low') ? 'low' : 'none';

  const parts = [];
  if (temporal.status !== 'idle') parts.push('Temporal: ' + temporal.status);
  if (flagConsistency.status !== 'idle') parts.push('Flags: ' + flagConsistency.status);
  if (fkCheck.status !== 'idle') parts.push('FK: ' + fkCheck.status);
  if (joinCoverage.status !== 'idle') parts.push('Coverage: ' + joinCoverage.status);

  const summary = parts.length > 0
    ? 'Relational integrity — ' + parts.join(' | ')
    : 'Relational integrity checks idle (no applicable rules detected).';

  return { status: overallStatus, level: overallLevel, summary, layer: 'relational',
    temporal, flagConsistency, fkCheck, joinCoverage };
}

// Auto-detect cross-table pairs from other loaded datasets in state.
// Matches FK-shaped column names against other loaded table names/columns.
function autoDetectPairs(ds, cols) {
  const pairs = [];
  try {
    const otherDatasets = (state.datasets || []).filter(d => d.table !== ds.table);
    if (otherDatasets.length === 0) return pairs;
    for (const col of (cols || [])) {
      const colName = typeof col === 'string' ? col : col.name;
      if (!colName) continue;
      // Heuristic: column name ends with _id or matches another table name.
      const candidate = otherDatasets.find(d => {
        const tName = d.table.toLowerCase();
        const cLower = colName.toLowerCase();
        // e.g. patient_id -> patients table, encounter_id -> encounters table
        return cLower === tName + '_id' || cLower.startsWith(tName + '_') ||
          (d.cols && d.cols.length > 0 && (d.cols[0].name || d.cols[0]) === colName);
      });
      if (candidate && candidate.cols && candidate.cols.length > 0) {
        const parentCol = candidate.cols[0].name || candidate.cols[0];
        pairs.push({
          childTable: ds.table, childCol: colName,
          parentTable: candidate.table, parentCol,
          label: ds.table + '.' + colName + ' -> ' + candidate.table + '.' + parentCol,
        });
      }
    }
  } catch { /* fail open */ }
  return pairs;
}

// ---------- Orchestrator ----------
export async function runAllLayers(ds, options = {}) {
  const table = ds.table;
  const cols = ds.cols;
  const rowCount = ds.rowCount;
  const results = {};

  results.sanity_anchor = await runSanityAnchor(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));
  results.historical_drift = await runHistoricalDrift(table).catch(e => result('warn', `Could not run: ${e.message}`));
  results.unit_tests = await runUnitTests(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));

  const confidence = await runConfidence(table, cols, rowCount).catch(e => ({ score: 0, grade: 'D', verdict: 'Error', signals: {}, status: 'fail' }));
  results.confidence = confidence;

  results.denial_radar = await runDenialRadar(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));
  results.schema_fingerprint = await runSchemaFingerprint(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));
  results.semantic_drift = await runSemanticDrift(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));
  results.correlation_watchdog = await runCorrelationWatchdog(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));
  results.narrative_consistency = state.lastStory
    ? await checkNarrativeConsistency(state.lastStory, state.lastQueryResult)
    : result('idle', 'Write a story in the Story tab first to activate this layer.');
  results.freshness = runFreshness(ds, options.freshnessThresholdHours || 24);
  results.blind_spot = runBlindSpotScanner(cols);
  results.reproducibility = await runReproducibility(table).catch(e => result('warn', `Could not run: ${e.message}`));
  results.outlier_detection = await runOutlierDetection(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));
  results.benford = await runBenford(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));
  results.categorical_consistency = await runCategoricalConsistency(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));
  results.cross_column_logic = await runCrossColumnLogic(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));
  results.drg_icd_validation = await runDrgIcdValidationLayer(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));
  results.distribution_drift = await runDistributionDrift(table, cols, { fingerprintStore: options.fingerprintStore }).catch(e => result('warn', `Could not run: ${e.message}`));
  results.physiological_plausibility = await runPhysiologicalPlausibility(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));
  results.upper_bound_sanity = await runUpperBoundSanity(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));
  results.missingness_detective = await runMissingnessDetectiveLayer(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));

  // ---- Relational Integrity Layer (Phase 2) ----
  // Three new sub-checks that operate across column pairs and (optionally) across
  // table pairs. Each is gated by its own feature flag and fails open: an error
  // in any sub-check produces an 'idle' result and never kills the run.
  results.relational = await runRelationalLayer(ds, cols, options).catch(e => ({
    status: 'idle', summary: 'Relational layer could not run: ' + (e && e.message ? e.message : String(e)),
    temporal: null, flagConsistency: null, joinCoverage: null,
  }));

  // ---- Equity Stratification Layer (Phase 3) ----
  // Detects race/sex/zip/payer columns, stratifies outcome metrics by group,
  // and scores disparities against CMS thresholds. Builds a signed equity
  // attestation block. Fails open: any error produces idle, never kills the run.
  results.equity = await runEquityLayer(ds, cols, options).catch(e => ({
    status: 'idle', level: 'none', layer: 'equity',
    detectionResult: null, stratificationResult: null, attestation: null,
    rationale: 'Equity layer could not run: ' + (e && e.message ? e.message : String(e)),
  }));

  // ---- Domain Physics Engine ----
  // Sits ABOVE the 20 layers: it reinterprets/annotates their raw output using a
  // swappable domain pack (default "healthcare"). It never re-runs a layer.
  // Selecting "none" restores the raw, domain-agnostic output.
  const packName = options.pack || 'healthcare';
  const columnMeta = await computeColumnMeta(table, cols).catch(() => cols.map(c => ({ name: c.name, type: c.type, numeric: false, isBinary01: false })));
  const domainPack = applyDomainPack(results, packName, { columns: columnMeta, dataset: ds });
  results.domainPack = domainPack;

  // Assumption-ledger entries for categorical clusters are emitted here — after
  // the pack has (potentially) flipped columns to sensitive — so the ledger
  // reflects the final, pack-reinterpreted state.
  logCategoricalAssumptions(results.categorical_consistency);

  // ---- Confidence-Calibrated Grades (two-axis, heuristic) ----
  results.calibratedGrades = computeCalibratedGrades({
    results,
    packName: domainPack.packName,
    packLabel: domainPack.packLabel,
    annotations: domainPack.annotations,
  });
  // Record the two-axis grade in the Assumption Ledger so the scoring is
  // auditable alongside every other assumption the run made.
  const cg = results.calibratedGrades;
  logAssumption(
    'Confidence-Calibrated Grades',
    `Data Integrity ${cg.integrity.grade} (mechanical well-formedness) · Domain Confidence ${cg.plausibility.grade} (real-world plausibility) · Overall ${cg.overall.grade}`,
    {
      integrityScore: cg.integrity.score,
      domainConfidenceScore: cg.plausibility.score,
      overallScore: cg.overall.score,
      domainConcerns: cg.plausibility.concerns,
      domainConcernsReinterpreted: cg.plausibility.interpreted,
    },
  );

  state.validationResults = results;
  // Dev-mode, non-fatal: confirm the run + its two-axis grade conform to the
  // published protocol schemas (validation-run + grade-result).
  devAssertConformance('validation-run', toValidationRun(results, toDataset(ds)));
  if (results.calibratedGrades) devAssertConformance('grade-result', results.calibratedGrades);
  return results;
}

export function getExpectedGoldenFindings() {
  return {
    unit_tests: 'Should detect: 3 negatives (claim_amount), 2 future dates (admit_date), duplicate rows, and null keys.',
    semantic_drift: 'Should detect: age=999 semantic error.',
    sanity_anchor: 'Should pass — both calculation paths should still agree even on dirty data.',
    schema_fingerprint: 'Should pass on first load (establishes baseline).',
    confidence: 'Should score low/C-D grade given nulls, negatives, duplicates, and the age=999 outlier.',
    benford: "Should skip 'age' (bounded range) with an explanation and test 'claim_amount' (naturally scaled).",
    categorical_consistency: 'Should cluster near-duplicate country spellings ("France"/"FRA"/"French") and propose a canonical merge.',
    cross_column_logic: 'Should detect discharge_date < admit_date and a minor (age<18) flagged has_retirement_account = true.',
    distribution_drift: 'Should record a baseline fingerprint on first load; flags drift on a later same-schema load.',
  };
}
