// ============================================================
// DATAGLOW — The 18 Validation Layers
// "The features nobody else has."
// ============================================================

import { state } from './state.js';
import * as engine from './duckdb-engine.js';
import { sha256, formatNumber } from './utils.js';
import { detectColumnClusters, describeCluster } from './categorical-consistency.js';
import { runCrossColumnChecks } from './cross-column-consistency.js';
import { logAssumption } from './assumption-ledger.js';
import { applyDomainPack, summarizeUnitTests } from './domain-physics.js';
import { computeCalibratedGrades } from './calibrated-grades.js';
import { devAssertConformance, toValidationRun, toDataset } from './protocol-conformance.js';

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
  { id: 'unit_tests', name: 'Unit Test Layer', desc: '5 silent tests: negatives, future dates, blank keys, duplicates, referential integrity.' },
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
  { id: 'cross_column_logic', name: 'Cross-Column Logical Consistency', desc: 'Detects impossible combinations across columns — end-before-start ranges, discharge-before-admit, adult-only status on minors.' },
  { id: 'distribution_drift', name: 'Distributional Fingerprint Drift', desc: 'Stores each column\'s distribution shape and flags drift on a later load of the same schema.' },
  { id: 'red_team', name: 'Red Team Mode', desc: 'Runs all 17 layers against an intentionally broken golden dataset.' },
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
  // referential integrity: if a *_id column exists that isn't the key, check it's non-null
  const fkCols = cols.filter(c => /_id$/i.test(c.name) && c.name !== keyCol.name);
  for (const c of fkCols) {
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" IS NULL`);
    if (rows[0].n > 0) findings.push({ kind: 'null_ref', column: c.name, severity: 'fail', text: `${rows[0].n} null reference(s) in "${c.name}"` });
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
  const numbersInText = [...storyText.matchAll(/-?\d+(?:\.\d+)?%?/g)].map(m => m[0]);
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
      const nums = rows.map(r => r[c]).filter(v => typeof v === 'number' && !Number.isNaN(v));
      if (nums.length) {
        // Column average, min, max — as stated by the numeric_mean claim.
        addNumber(nums.reduce((a, b) => a + b, 0) / nums.length);
        addNumber(Math.min(...nums));
        addNumber(Math.max(...nums));
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
                               THEN FLOOR(LOG10(ABS(${col}))) END) AS orders
    FROM ${table}`);
  const n = Number(rows[0].n) || 0;
  const orders = Number(rows[0].orders) || 0;
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
  // Plain-language teaching note surfaced in the Validate tab whenever a column
  // is skipped — turns the eligibility gate from a silent pass/fail into a
  // short lesson on WHY the test does or doesn't apply.
  const teaching = "Benford's Law describes naturally-scaled, multiplicative quantities that span several orders of magnitude — revenue, populations, transaction amounts. Bounded, human-assigned ranges like Age, ratings, or credit scores don't follow it, so applying the test there would produce meaningless \"violations.\" Columns below are skipped for that reason, not because anything is wrong with them.";
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
  if (skips.length) r.teaching = teaching;
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
  const findings = await runCrossColumnChecks(table, cols, engine);
  for (const f of findings) {
    logAssumption('Cross-Column Logical Consistency', `Flagged ${f.text}`, { rule: f.rule, columns: f.columns, count: f.count });
  }
  if (findings.length === 0) return result('pass', 'No impossible cross-column combinations detected.');
  const r = result('fail', `${findings.length} logical inconsistency type(s) found across columns.`, findings.map(f => f.text));
  r.findings = findings;
  return r;
}

// ---------- 18. Distributional Fingerprint Drift ----------
// Sibling of the Schema Fingerprint layer: even when the schema is unchanged,
// the DATA can silently shift. On each load we record a per-column
// distribution fingerprint (mean/std/skewness for numeric; top-5 value
// frequencies for categorical) keyed by the schema hash, then compare a later
// load of the same schema against the stored baseline.
export async function computeDistributionFingerprint(table, cols) {
  const stats = {};
  for (const c of cols) {
    const col = `"${c.name}"`;
    if (NUMERIC_T.includes(c.type)) {
      const { rows } = await engine.runQuery(`
        SELECT AVG(${col}) AS mean, STDDEV_POP(${col}) AS std, skewness(${col}) AS skew
        FROM ${table} WHERE ${col} IS NOT NULL`);
      stats[c.name] = {
        kind: 'numeric',
        mean: rows[0].mean != null ? Number(rows[0].mean) : null,
        std: rows[0].std != null ? Number(rows[0].std) : null,
        skew: rows[0].skew != null ? Number(rows[0].skew) : null,
      };
    } else if (c.type === 'VARCHAR') {
      const { rows } = await engine.runQuery(`
        SELECT ${col} AS v, COUNT(*) AS n FROM ${table}
        WHERE ${col} IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 5`);
      stats[c.name] = { kind: 'categorical', top: rows.map(r => String(r.v)) };
    }
  }
  return stats;
}

export function compareDistributions(prev, curr) {
  const drifts = [];
  for (const [name, cs] of Object.entries(curr)) {
    const ps = prev[name];
    if (!ps || ps.kind !== cs.kind) continue;
    if (cs.kind === 'numeric') {
      if (ps.mean != null && cs.mean != null && ps.std != null && ps.std > 0) {
        const shift = Math.abs(cs.mean - ps.mean) / ps.std;
        if (shift > 2) {
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

async function runDistributionDrift(table, cols) {
  const schemaStr = JSON.stringify(cols.map(c => [c.name, c.type]).sort());
  const hash = await sha256(schemaStr);
  const stats = await computeDistributionFingerprint(table, cols);
  const prior = history.distributionFingerprints[table] || [];
  const lastSameSchema = [...prior].reverse().find(p => p.hash === hash);
  prior.push({ ts: Date.now(), hash, stats });
  history.distributionFingerprints[table] = prior;
  if (!lastSameSchema) {
    return result('pass', `Distribution fingerprint recorded for ${Object.keys(stats).length} column(s) — baseline established.`);
  }
  const drifts = compareDistributions(lastSameSchema.stats, stats);
  if (drifts.length === 0) {
    return result('pass', 'Column distributions are stable versus the stored fingerprint — no drift.');
  }
  for (const d of drifts) {
    logAssumption('Distributional Fingerprint Drift', `Detected drift on same-schema reload: ${d}`);
  }
  return result('fail', `${drifts.length} column(s) drifted despite an unchanged schema — the data moved even though the shape didn't.`, drifts);
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
  results.distribution_drift = await runDistributionDrift(table, cols).catch(e => result('warn', `Could not run: ${e.message}`));

  // ---- Domain Physics Engine ----
  // Sits ABOVE the 18 layers: it reinterprets/annotates their raw output using a
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
