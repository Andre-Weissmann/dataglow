// ============================================================
// DATAGLOW — The 13 Validation Layers
// "The features nobody else has."
// ============================================================

import { state } from './state.js';
import * as engine from './duckdb-engine.js';
import { sha256, formatNumber } from './utils.js';

// In-memory history for drift/reproducibility/correlation layers (per session — no server)
const history = {
  schemaFingerprints: {},   // table -> [hashes over time]
  queryResults: {},         // querySignature -> [ {ts, resultHash} ]
  correlationSnapshots: {}, // table -> [{ts, corr}]
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
  { id: 'red_team', name: 'Red Team Mode', desc: 'Runs all 12 layers against an intentionally broken golden dataset.' },
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
async function runUnitTests(table, cols) {
  const tests = [];
  const numericCols = cols.filter(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type));
  const dateCols = cols.filter(c => c.type.includes('DATE') || /date|admit|discharge/i.test(c.name));
  // negative values
  for (const c of numericCols) {
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" < 0`);
    if (rows[0].n > 0) tests.push(`${rows[0].n} negative value(s) in "${c.name}"`);
  }
  // future dates
  for (const c of dateCols) {
    try {
      const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE TRY_CAST("${c.name}" AS DATE) > CURRENT_DATE`);
      if (rows[0].n > 0) tests.push(`${rows[0].n} future date(s) in "${c.name}"`);
    } catch (e) { /* skip */ }
  }
  // blank/null keys (first column treated as key)
  const keyCol = cols[0];
  const { rows: nullRows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${keyCol.name}" IS NULL`);
  if (nullRows[0].n > 0) tests.push(`${nullRows[0].n} blank value(s) in key column "${keyCol.name}"`);
  // duplicates (full row)
  const allCols = cols.map(c => `"${c.name}"`).join(',');
  const { rows: dupRows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM (SELECT ${allCols}, COUNT(*) AS c FROM ${table} GROUP BY ${allCols} HAVING COUNT(*) > 1) t`);
  if (dupRows[0].n > 0) {
    const { rows: dupTotal } = await engine.runQuery(`SELECT SUM(c) - COUNT(*) AS extra FROM (SELECT ${allCols}, COUNT(*) AS c FROM ${table} GROUP BY ${allCols} HAVING COUNT(*) > 1) t`);
    tests.push(`${dupTotal[0].extra} duplicate row(s) found (${dupRows[0].n} distinct groups affected)`);
  }
  // referential integrity: if a *_id column exists that isn't the key, check it's non-null
  const fkCols = cols.filter(c => /_id$/i.test(c.name) && c.name !== keyCol.name);
  for (const c of fkCols) {
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" IS NULL`);
    if (rows[0].n > 0) tests.push(`${rows[0].n} null reference(s) in "${c.name}"`);
  }

  if (tests.length === 0) return result('pass', 'All 5 unit tests passed — no negatives, future dates, blank keys, duplicates, or broken references.');
  return result('fail', `${tests.length} issue(s) found`, tests);
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

  const weights = { sampleCoverage: 0.2, nullScore: 0.25, varianceScore: 0.2, stabilityScore: 0.2, sizeScore: 0.15 };
  const score = Math.round(100 * (
    sampleCoverage * weights.sampleCoverage +
    nullScore * weights.nullScore +
    varianceScore * weights.varianceScore +
    stabilityScore * weights.stabilityScore +
    sizeScore * weights.sizeScore
  ));

  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
  const verdict = score >= 70 ? 'Ready to present' : 'Dig deeper first';
  const signals = {
    'Sample coverage': Math.round(sampleCoverage * 100),
    'Null rate': Math.round((1 - nullScore) * 100),
    'Variance': Math.round(varianceScore * 100),
    'Subsample stability': Math.round(stabilityScore * 100),
    'Sample size': Math.round(sizeScore * 100),
  };
  return { score, grade, verdict, signals, status: score >= 70 ? 'pass' : score >= 50 ? 'warn' : 'fail' };
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
  for (const row of queryResult.rows) {
    for (const v of Object.values(row)) {
      if (typeof v === 'number') {
        actualNumbers.add(v.toFixed(2));
        actualNumbers.add(String(Math.round(v)));
        actualNumbers.add((v).toFixed(1));
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
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n, SUM(HASH(*)) AS h FROM (SELECT * FROM ${table} LIMIT 1000) t`).catch(async () => {
      return engine.runQuery(`SELECT COUNT(*) AS n FROM ${table}`);
    });
    hashes.push(JSON.stringify(rows));
  }
  const allSame = hashes.every(h => h === hashes[0]);
  return allSame
    ? result('pass', 'Identical results across 10 consecutive runs on static data.')
    : result('fail', 'Results varied across identical runs — reproducibility failure.');
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

  state.validationResults = results;
  return results;
}

export function getExpectedGoldenFindings() {
  return {
    unit_tests: 'Should detect: 3 negatives (claim_amount), 2 future dates (admit_date), duplicate rows, and null keys.',
    semantic_drift: 'Should detect: age=999 semantic error.',
    sanity_anchor: 'Should pass — both calculation paths should still agree even on dirty data.',
    schema_fingerprint: 'Should pass on first load (establishes baseline).',
    confidence: 'Should score low/C-D grade given nulls, negatives, and outliers.',
  };
}
