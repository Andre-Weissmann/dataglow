// ============================================================
// DATAGLOW — Missingness Detective (causal missingness pattern report)
// ============================================================
// A validation layer that goes beyond "column X is 12% missing" by asking the
// SMARTER question every analyst eventually hits: *is that missingness random,
// or is it hiding a systematic pattern that will bias whatever you compute next?*
//
// It applies Rubin's classic missing-data taxonomy — MCAR / MAR / MNAR (Rubin,
// 1976; decades-old, public academic statistics, implemented here from first
// principles). For every column whose missingness is high enough to matter it
// tries to EXPLAIN the missingness using the other observed columns:
//
//   • MAR (Missing At Random)  — the missingness is systematic but EXPLAINABLE
//       by another observed column. We detect this two ways:
//         · categorical driver — the target's missing-rate varies a lot ACROSS
//           the groups of another column (e.g. "insurance_type" is missing far
//           more often when "visit_type = ER" than when "visit_type = Scheduled").
//         · numeric driver — the mean of another numeric column separates
//           clearly between the rows where the target is missing vs present
//           (e.g. income is missing far more for older respondents).
//   • MCAR (Missing Completely At Random) — the DEFAULT when no observed column
//       explains the missingness. We are careful NOT to claim this proves true
//       MCAR; it only means "no systematic driver was found in the data".
//   • MNAR (Missing Not At Random) — missingness depends on the UNOBSERVED value
//       itself. This cannot be proven from the data alone, so it is emitted only
//       as a conservative, clearly-labelled HEURISTIC CAUTION (a hypothesis to
//       investigate), never as a confirmed finding — see mnarCaution().
//
// COMPUTATIONAL SCOPING (see runMissingnessDetective): missingness is only
// investigated for columns above a noise threshold; candidate driver columns are
// capped and prioritised (low-cardinality categoricals first, extreme-cardinality
// columns skipped) so this never degenerates into an O(n²) all-pairs scan. All
// work is GROUP BY / aggregate SQL against the already-loaded DuckDB-WASM table.
//
// Column-name tokenisation reuses the robust word-splitter from the Cross-Column
// layer so compound names (snake_case / camelCase / kebab-case) all match.
// ============================================================

import { nameTokens } from './cross-column-consistency.js';

const NUMERIC_T = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];

// ------------------------------------------------------------
// Tunables — kept conservative so the layer teaches rather than cries wolf.
// ------------------------------------------------------------
// Only investigate columns whose missingness is above this fraction; below it,
// missingness is treated as trivial noise not worth a causal report.
export const MIN_MISSING_RATE = 0.03;          // 3%
// A candidate categorical driver must have between 2 and this many distinct
// values — high-cardinality columns (IDs, free text) make per-group missing-rate
// comparisons meaningless and are skipped.
export const MAX_DRIVER_CARDINALITY = 30;
// Ignore groups smaller than this when comparing per-group missing-rates — a
// wild rate over a handful of rows is spurious, not a real MAR pattern.
export const MIN_GROUP_N = 20;
// A categorical driver fires when, across its adequately-sized groups, the
// spread in the target's missing-rate is at least this many percentage points…
export const MAR_RATE_DIFF = 0.15;             // 15 percentage points
// …OR the highest group's rate is at least this many times the lowest's (a small
// floor stops a 0% baseline producing an infinite ratio).
export const MAR_RATE_RATIO = 2.0;
const RATE_RATIO_FLOOR = 0.02;
// A numeric driver fires when the standardised separation (|Δmean| / pooled SD,
// i.e. Cohen's d) between missing-vs-present rows is at least this — a "medium"
// effect. Both sides must have at least MIN_GROUP_N rows.
export const NUMERIC_SEP_MIN = 0.5;
// Cap on how many candidate driver columns we actually test per target, after
// prioritisation, to bound the work on very wide tables.
export const MAX_CANDIDATE_DRIVERS = 25;
// MNAR caution heuristic: only raised when a column that "should" almost always
// be recorded is missing at least this often. Deliberately high — MNAR cannot be
// proven, so we only whisper a hypothesis when the omission is glaring.
export const MNAR_MIN_RATE = 0.30;             // 30%

// Column-name stems that read like a CORE / EXPECTED field — one a well-run
// dataset would populate for essentially every row (identifiers, the primary
// outcome/measurement, key demographics). Heavy missingness in one of THESE is
// the classic MNAR smell (e.g. income refused by high earners, a lab result
// omitted precisely when it was abnormal). Kept short and conservative.
const CORE_FIELD_STEMS = [
  'id', 'age', 'sex', 'gender', 'dob', 'birth', 'date', 'outcome', 'result',
  'diagnosis', 'status', 'income', 'salary', 'weight', 'height', 'score',
  'label', 'target', 'response', 'total', 'amount', 'price', 'value',
];

export const MISSINGNESS_NOTE =
  'This report applies Rubin\'s classic MCAR/MAR/MNAR missing-data taxonomy ' +
  '(public academic statistics) to explain — not just count — missing values. ' +
  '"Likely MAR" means the missingness is systematic but explainable by another ' +
  'column shown here; "consistent with random (MCAR)" means no driver was found ' +
  '(it does NOT prove randomness); an MNAR caution is a conservative HYPOTHESIS ' +
  'to investigate, never a confirmed finding, because missing-not-at-random ' +
  'cannot be verified from the observed data alone.';

// ------------------------------------------------------------
// PURE detection helpers — no I/O, so the statistical decisions are unit-testable
// in isolation from DuckDB.
// ------------------------------------------------------------

// Decide whether a categorical column is a MAR driver for the target's
// missingness, given per-group stats. `groups` is [{ group, n, missingRate }]
// where missingRate is a 0–1 fraction. Returns a descriptor (with an effect
// size) or null. Only groups with n >= MIN_GROUP_N are considered so tiny groups
// can't manufacture a spurious pattern.
export function classifyCategoricalDriver(groups, opts = {}) {
  const minN = opts.minGroupN ?? MIN_GROUP_N;
  const diffMin = opts.rateDiff ?? MAR_RATE_DIFF;
  const ratioMin = opts.rateRatio ?? MAR_RATE_RATIO;
  const usable = (groups || []).filter(g => g && g.n >= minN && g.missingRate != null);
  if (usable.length < 2) return null;

  let hi = usable[0], lo = usable[0];
  for (const g of usable) {
    if (g.missingRate > hi.missingRate) hi = g;
    if (g.missingRate < lo.missingRate) lo = g;
  }
  const diff = hi.missingRate - lo.missingRate;
  const ratio = hi.missingRate / Math.max(lo.missingRate, RATE_RATIO_FLOOR);
  if (diff < diffMin && ratio < ratioMin) return null;

  return {
    kind: 'categorical',
    high: { group: hi.group, rate: hi.missingRate, n: hi.n },
    low: { group: lo.group, rate: lo.missingRate, n: lo.n },
    diff,
    ratio,
    // A single comparable "effect size" used to rank drivers: the percentage-
    // point spread, which is directly interpretable and not distorted by tiny
    // denominators the way a pure ratio can be.
    effect: diff,
  };
}

// Decide whether a numeric column is a MAR driver, given the mean/SD/count of
// that column split by whether the TARGET is missing. Returns a descriptor with
// Cohen's-d separation, or null. Requires both sides to be adequately sized.
export function classifyNumericDriver(stats, opts = {}) {
  const minN = opts.minGroupN ?? MIN_GROUP_N;
  const sepMin = opts.sepMin ?? NUMERIC_SEP_MIN;
  if (!stats) return null;
  const { missingN, presentN, missingMean, presentMean, missingStd, presentStd } = stats;
  if (missingN < minN || presentN < minN) return null;
  if (missingMean == null || presentMean == null) return null;

  // Pooled standard deviation (guard against a zero/undefined SD).
  const s1 = missingStd || 0, s2 = presentStd || 0;
  const pooledVar = ((missingN - 1) * s1 * s1 + (presentN - 1) * s2 * s2) /
    Math.max(missingN + presentN - 2, 1);
  const pooled = Math.sqrt(pooledVar);
  if (!(pooled > 0)) return null; // no spread → separation undefined; skip

  const sep = Math.abs(missingMean - presentMean) / pooled;
  if (sep < sepMin) return null;

  return {
    kind: 'numeric',
    missingMean, presentMean,
    higherWhenMissing: missingMean > presentMean,
    separation: sep,
    effect: sep,
  };
}

// Column-name test: does this read like a core/expected field (see CORE_FIELD_STEMS)?
export function looksCoreField(name) {
  const tokens = nameTokens(name);
  if (tokens.length === 0) return false;
  return tokens.some(t => CORE_FIELD_STEMS.some(s => t === s || t.startsWith(s)));
}

// Conservative MNAR caution heuristic. Returns true ONLY when a core/expected
// field is missing unusually often. This is explicitly a HYPOTHESIS, not proof —
// MNAR cannot be established from observed data. Kept independent of the MAR
// result so a column can be "likely MAR" and still carry an MNAR caution.
export function mnarCaution(name, missingRate, opts = {}) {
  const minRate = opts.minRate ?? MNAR_MIN_RATE;
  return missingRate >= minRate && looksCoreField(name);
}

// Round a 0–1 rate to a whole-percent for display.
const pct = (r) => Math.round(r * 100);
const pct1 = (r) => Number((r * 100).toFixed(1));

// Build the plain-language narrative + structured classification for one column
// from its already-computed pieces. Pure so the wording is testable.
export function buildColumnReport({ column, type, isNumeric, missingRate, missingCount, driver, mnar }) {
  const mp = pct(missingRate);
  let classification, driverColumn = null, effect = null, narrative, why;

  if (driver && driver.kind === 'categorical') {
    classification = 'MAR';
    driverColumn = driver.column;
    effect = Number(driver.diff.toFixed(3));
    narrative =
      `${mp}% of "${column}" is missing, and that missingness is not spread evenly: ` +
      `it rises to ${pct(driver.high.rate)}% when "${driver.column}" = ${fmtVal(driver.high.group)} ` +
      `(n=${driver.high.n}) versus ${pct(driver.low.rate)}% when "${driver.column}" = ${fmtVal(driver.low.group)} ` +
      `(n=${driver.low.n}) — a ${pctPoints(driver.diff)} spread. This is consistent with ` +
      `Missing At Random (MAR): the missingness is systematic but explainable by "${driver.column}".`;
    why =
      `Because whether "${column}" is recorded depends on "${driver.column}", dropping rows with ` +
      `missing "${column}" would systematically under-represent the "${fmtVal(driver.high.group)}" group, ` +
      `biasing any downstream statistic. Prefer modelling the missingness (e.g. include "${driver.column}" ` +
      `in an imputation model, or treat "missing" as its own category) over naive row-dropping or mean-fill.`;
  } else if (driver && driver.kind === 'numeric') {
    classification = 'MAR';
    driverColumn = driver.column;
    effect = Number(driver.separation.toFixed(3));
    const dir = driver.higherWhenMissing ? 'higher' : 'lower';
    narrative =
      `${mp}% of "${column}" is missing, and rows where it is missing have a clearly ${dir} ` +
      `"${driver.column}" (mean ${fmtNum(driver.missingMean)} when missing vs ${fmtNum(driver.presentMean)} ` +
      `when present; standardised separation ${driver.separation.toFixed(2)}). This is consistent with ` +
      `Missing At Random (MAR): the missingness is explainable by the observed "${driver.column}".`;
    why =
      `Since "${column}" goes missing more for records with ${dir} "${driver.column}", analysing only the ` +
      `complete rows would skew "${driver.column}" and anything correlated with it. Condition on ` +
      `"${driver.column}" when imputing rather than dropping or mean-filling.`;
  } else {
    classification = 'MCAR';
    narrative =
      `${mp}% of "${column}" is missing, and no other column in the dataset explains the pattern ` +
      `(missing-rate does not vary meaningfully across the candidate drivers checked). This is ` +
      `consistent with random missingness — note this does NOT prove true MCAR, only that no ` +
      `systematic driver was found in the observed data.`;
    why =
      `No evidence of a systematic driver was found, so standard handling (e.g. mean/mode imputation, ` +
      `or listwise deletion) is more defensible here than for a MAR column — but re-check if you later ` +
      `add columns that might explain it.`;
  }

  const report = {
    column, type, isNumeric,
    missingRate: pct1(missingRate),
    missingCount,
    classification,
    driverColumn,
    effect,
    driver: driver || null,
    mnarCaution: !!mnar,
    narrative,
    why,
  };

  if (mnar) {
    report.mnarNote =
      `HYPOTHESIS (not a confirmed finding): "${column}" reads like a core/expected field yet is missing ` +
      `${mp}% of the time. Such heavy omission of a normally-recorded field can be a sign of Missing Not ` +
      `At Random (MNAR) — where the value is withheld BECAUSE of what it would have been (e.g. a figure ` +
      `refused by those at the extremes, or a result omitted precisely when abnormal). MNAR cannot be ` +
      `proven from the data alone; treat this only as a prompt to check how "${column}" is collected.`;
  }

  // One-line summary used for the layer's `detail` list.
  const tag = classification === 'MAR'
    ? `likely MAR — driven by "${driverColumn}"`
    : 'consistent with random (MCAR — no driver found)';
  const mnarBit = mnar ? '; MNAR risk worth investigating' : '';
  report.text = `"${column}" ${pct1(missingRate)}% missing: ${tag}${mnarBit}.`;

  return report;
}

const fmtVal = (v) => (v == null ? '(null)' : `"${String(v)}"`);
const fmtNum = (v) => (v == null || Number.isNaN(v) ? String(v) : (Number.isInteger(v) ? String(v) : String(Number(Number(v).toFixed(3)))));
const pctPoints = (r) => `${Math.round(r * 100)}-percentage-point`;

// ------------------------------------------------------------
// Prioritise candidate driver columns so wide tables stay cheap: prefer
// low-cardinality categoricals (most interpretable), then numerics, and drop
// the target itself. `cardinalityHint` (name -> distinct count) lets categorical
// candidates be ordered/culled; unknown cardinalities sort last.
// ------------------------------------------------------------
export function prioritiseDrivers(targetName, cols, cardinalityHint = {}, cap = MAX_CANDIDATE_DRIVERS) {
  const cats = [];
  const nums = [];
  for (const c of cols) {
    if (c.name === targetName) continue;
    if (NUMERIC_T.includes(c.type)) {
      nums.push(c);
    } else if (c.type === 'VARCHAR' || c.type === 'BOOLEAN') {
      cats.push(c);
    }
  }
  // Low-cardinality categoricals first (more meaningful groupings), unknowns last.
  cats.sort((a, b) => {
    const ca = cardinalityHint[a.name] ?? Infinity;
    const cb = cardinalityHint[b.name] ?? Infinity;
    return ca - cb;
  });
  return [...cats, ...nums].slice(0, cap);
}

// ------------------------------------------------------------
// Runner — executes the analysis against the loaded table. Returns
// { findings, analyzed } where `analyzed` lists every column that cleared the
// missingness threshold (whether or not a driver was found). Pure of side
// effects (no ledger writes) — the caller decides how to log, mirroring the
// Cross-Column and Upper-Bound layers.
// ------------------------------------------------------------
export async function runMissingnessDetective(table, cols, engine) {
  const findings = [];
  const analyzed = [];

  const one = async (sql) => {
    const { rows } = await engine.runQuery(sql);
    return rows[0] || {};
  };

  const totalRow = await one(`SELECT COUNT(*) AS n FROM ${table}`);
  const rowCount = Number(totalRow.n) || 0;
  if (rowCount === 0) return { findings, analyzed };

  // Distinct-count cache so a candidate column is only probed once per run.
  const cardCache = {};
  const cardinality = async (name) => {
    if (name in cardCache) return cardCache[name];
    const r = await one(`SELECT COUNT(DISTINCT "${name}") AS n FROM ${table} WHERE "${name}" IS NOT NULL`);
    return (cardCache[name] = Number(r.n) || 0);
  };

  for (const target of cols) {
    const nr = await one(`SELECT COUNT(*) FILTER (WHERE "${target.name}" IS NULL) AS nulls FROM ${table}`);
    const missingCount = Number(nr.nulls) || 0;
    const missingRate = missingCount / rowCount;
    if (missingRate < MIN_MISSING_RATE) continue; // trivial missingness — skip
    // A fully-missing column has no present rows to compare against; nothing to explain.
    if (missingCount >= rowCount) continue;

    const isNumericTarget = NUMERIC_T.includes(target.type);
    analyzed.push({ column: target.name, missingRate: pct1(missingRate), missingCount });

    // Pre-compute categorical cardinalities to prioritise/cull candidates.
    const cardHint = {};
    for (const c of cols) {
      if (c.name === target.name) continue;
      if (c.type === 'VARCHAR' || c.type === 'BOOLEAN') cardHint[c.name] = await cardinality(c.name);
    }
    const candidates = prioritiseDrivers(target.name, cols, cardHint);

    let best = null; // strongest driver descriptor across candidates
    for (const cand of candidates) {
      const col = `"${cand.name}"`;
      if (cand.type === 'VARCHAR' || cand.type === 'BOOLEAN') {
        const card = cardHint[cand.name] ?? await cardinality(cand.name);
        if (card < 2 || card > MAX_DRIVER_CARDINALITY) continue;
        const { rows } = await engine.runQuery(`
          SELECT ${col} AS grp,
                 COUNT(*) AS n,
                 COUNT(*) FILTER (WHERE "${target.name}" IS NULL)::DOUBLE / COUNT(*) AS mr
          FROM ${table}
          WHERE ${col} IS NOT NULL
          GROUP BY 1`);
        const groups = rows.map(r => ({ group: r.grp, n: Number(r.n) || 0, missingRate: r.mr == null ? null : Number(r.mr) }));
        const d = classifyCategoricalDriver(groups);
        if (d && (!best || d.effect > best.effect)) best = { ...d, column: cand.name };
      } else {
        // Numeric candidate: compare its mean/SD between target-missing and
        // target-present rows in a single aggregate pass.
        const r = await one(`
          SELECT
            COUNT(${col}) FILTER (WHERE "${target.name}" IS NULL)     AS mn,
            COUNT(${col}) FILTER (WHERE "${target.name}" IS NOT NULL) AS pn,
            AVG(${col})   FILTER (WHERE "${target.name}" IS NULL)     AS mmean,
            AVG(${col})   FILTER (WHERE "${target.name}" IS NOT NULL) AS pmean,
            STDDEV_SAMP(${col}) FILTER (WHERE "${target.name}" IS NULL)     AS mstd,
            STDDEV_SAMP(${col}) FILTER (WHERE "${target.name}" IS NOT NULL) AS pstd
          FROM ${table}`);
        const stats = {
          missingN: Number(r.mn) || 0,
          presentN: Number(r.pn) || 0,
          missingMean: r.mmean == null ? null : Number(r.mmean),
          presentMean: r.pmean == null ? null : Number(r.pmean),
          missingStd: r.mstd == null ? null : Number(r.mstd),
          presentStd: r.pstd == null ? null : Number(r.pstd),
        };
        const d = classifyNumericDriver(stats);
        // Prefer the categorical framing when effects tie/beat: categorical
        // drivers name a concrete group, which is more actionable. We still let a
        // stronger numeric separation win.
        if (d && (!best || d.effect > best.effect)) best = { ...d, column: cand.name };
      }
    }

    const mnar = mnarCaution(target.name, missingRate);
    findings.push(buildColumnReport({
      column: target.name,
      type: target.type,
      isNumeric: isNumericTarget,
      missingRate,
      missingCount,
      driver: best,
      mnar,
    }));
  }

  return { findings, analyzed };
}
