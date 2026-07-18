// ============================================================
// DATAGLOW — Flag Consistency Checker (Phase 2)
// ============================================================
// Detects logical contradictions between binary flag columns. These are errors
// that are invisible to single-column profilers because each column looks valid
// (it contains only 0 or 1) -- the problem only emerges when you compare two
// flags within the same row.
//
// WHY THIS MATTERS IN HEALTHCARE:
// The canonical example is the readmission window contradiction:
//   readmit_30d = 1  AND  readmit_90d = 0
// A 30-day readmission is definitionally a 90-day readmission. A row that
// claims the 30-day window fired but the 90-day window did not is logically
// impossible. Any readmission rate or CMS quality metric computed against such
// data is wrong.
//
// Other healthcare flag contradictions:
//   deceased = 1  AND  discharge_disposition != 'expired'
//   inpatient = 1  AND  outpatient = 1           (mutually exclusive)
//   emergency_admit = 1  AND  elective_admit = 1 (mutually exclusive)
//   readmit_30d = 1  AND  readmit_7d = 0         (7-day is a subset of 30-day)
//
// DESIGN:
// Each rule is a declarative constraint: { id, label, condition (SQL WHERE),
// severity }. The checker runs each condition as a COUNT(*) against the live
// DuckDB table. The SQL condition identifies the VIOLATING rows -- rows that
// SHOULD NOT EXIST if the flags are consistent.
//
// Built-in rules are auto-filtered by whether the relevant columns exist.
// Custom rules can be added via the rules parameter.

export const FLAG_RULES = [
  {
    id: 'readmit_30d_implies_90d',
    label: 'readmit_30d=1 but readmit_90d=0',
    // A 30-day readmit is always also a 90-day readmit.
    // violating condition: readmit_30d=1 AND readmit_90d=0
    requiredCols: ['readmit_30d', 'readmit_90d'],
    condition: (t) => q(t) + '.readmit_30d = 1 AND ' + q(t) + '.readmit_90d = 0',
    severity: 'hard',
    rationale: 'readmit_30d=1 implies readmit_90d must also be 1 -- a 30-day readmission is a strict subset of the 90-day readmission window. This combination is logically impossible.',
  },
  {
    id: 'readmit_7d_implies_30d',
    label: 'readmit_7d=1 but readmit_30d=0',
    requiredCols: ['readmit_7d', 'readmit_30d'],
    condition: (t) => q(t) + '.readmit_7d = 1 AND ' + q(t) + '.readmit_30d = 0',
    severity: 'hard',
    rationale: 'readmit_7d=1 implies readmit_30d must also be 1 -- a 7-day readmission is a strict subset of the 30-day window.',
  },
  {
    id: 'readmit_7d_implies_90d',
    label: 'readmit_7d=1 but readmit_90d=0',
    requiredCols: ['readmit_7d', 'readmit_90d'],
    condition: (t) => q(t) + '.readmit_7d = 1 AND ' + q(t) + '.readmit_90d = 0',
    severity: 'hard',
    rationale: 'readmit_7d=1 implies readmit_90d must also be 1 -- a 7-day readmission is a subset of both the 30-day and 90-day windows.',
  },
  {
    id: 'inpatient_outpatient_exclusive',
    label: 'inpatient=1 and outpatient=1 simultaneously',
    requiredCols: ['inpatient', 'outpatient'],
    condition: (t) => q(t) + '.inpatient = 1 AND ' + q(t) + '.outpatient = 1',
    severity: 'hard',
    rationale: 'inpatient and outpatient are mutually exclusive visit types. A record cannot be both simultaneously.',
  },
  {
    id: 'emergency_elective_exclusive',
    label: 'emergency_admit=1 and elective_admit=1 simultaneously',
    requiredCols: ['emergency_admit', 'elective_admit'],
    condition: (t) => q(t) + '.emergency_admit = 1 AND ' + q(t) + '.elective_admit = 1',
    severity: 'hard',
    rationale: 'emergency_admit and elective_admit are mutually exclusive admission types.',
  },
  {
    id: 'deceased_live_discharge',
    label: 'deceased=1 but discharge_disposition not expired',
    requiredCols: ['deceased', 'discharge_disposition'],
    // Soft: discharge codes vary by system; "20" and "40" and "41" can all mean expired.
    condition: (t) => q(t) + '.deceased = 1 AND LOWER(CAST(' + q(t) + '.discharge_disposition AS VARCHAR)) NOT IN (\'20\',\'expired\',\'dead\',\'deceased\',\'40\',\'41\',\'42\')',
    severity: 'soft',
    rationale: 'deceased=1 but the discharge disposition does not indicate an expiration -- may indicate a coding mismatch between the deceased flag and the UB-04 discharge status code.',
  },
];

// Violation rate thresholds.
// Hard rule violations are fail regardless of rate (any impossible row is a fail).
// Soft rules use rate thresholds.
export const FLAG_WARN_RATE = 0.001; // 0.1%
export const FLAG_FAIL_RATE = 0.01;  // 1%

/**
 * Run flag consistency checks against a single DuckDB table.
 *
 * @param {object} opts
 * @param {string} opts.table - DuckDB table name
 * @param {Array<{name:string}>} opts.cols - column descriptors
 * @param {object} opts.engine - { runQuery }
 * @param {Array<object>} [opts.extraRules] - additional rules (merged with built-ins)
 * @returns {Promise<object>} { rules: results[], summary, status, level, rationale }
 */
export async function checkFlagConsistency({ table, cols, engine, extraRules = [] }) {
  const colSet = new Set(
    (Array.isArray(cols) ? cols : []).map(c =>
      typeof c === 'string' ? c : (c && c.name ? c.name : '')
    ).filter(Boolean)
  );

  const allRules = [...FLAG_RULES, ...(Array.isArray(extraRules) ? extraRules : [])];

  // Only run rules whose required columns exist in this table.
  const applicableRules = allRules.filter(rule =>
    Array.isArray(rule.requiredCols) && rule.requiredCols.every(c => colSet.has(c))
  );

  if (applicableRules.length === 0) {
    return {
      rules: [], status: 'idle', level: 'none',
      summary: { total: 0, pass: 0, warn: 0, fail: 0, idle: 0, totalViolations: 0 },
      rationale: 'No flag consistency rules apply to table "' + table + '" -- none of the required column pairs are present.',
    };
  }

  const results = [];
  for (const rule of applicableRules) {
    results.push(await runFlagRule({ table, rule, engine }));
  }

  const summ = { total: results.length, pass: 0, warn: 0, fail: 0, idle: 0, totalViolations: 0 };
  for (const r of results) {
    summ[r.status] = (summ[r.status] || 0) + 1;
    summ.totalViolations += (r.violationCount || 0);
  }

  const worstStatus = results.some(r => r.status === 'fail') ? 'fail'
    : results.some(r => r.status === 'warn') ? 'warn'
    : results.every(r => r.status === 'idle') ? 'idle' : 'pass';
  const worstLevel = results.some(r => r.level === 'high') ? 'high'
    : results.some(r => r.level === 'medium') ? 'medium'
    : results.some(r => r.level === 'low') ? 'low' : 'none';

  const rationale = summ.totalViolations === 0
    ? 'All ' + summ.total + ' flag consistency rule(s) pass -- no logical contradictions detected in "' + table + '".'
    : summ.totalViolations.toLocaleString() + ' flag contradiction(s) detected across ' + (summ.warn + summ.fail) + '/' + summ.total + ' rule(s) in "' + table + '". These rows contain logically impossible flag combinations that will corrupt any metric computed from them.';

  return { rules: results, summary: summ, status: worstStatus, level: worstLevel, rationale };
}

// ---- rule runner -----------------------------------------------------------

async function runFlagRule({ table, rule, engine }) {
  const tQ = q(table);
  const ruleLabel = rule.label || rule.id;

  let totalRows = 0, violationCount = 0;
  try {
    const totalRes = await engine.runQuery('SELECT COUNT(*) AS n FROM ' + tQ);
    totalRows = safeNum(totalRes.rows[0], 'n');

    if (totalRows === 0) {
      return makeFlagResult({ rule, ruleLabel, totalRows: 0, violationCount: 0,
        status: 'idle', level: 'none',
        rationale: 'Table "' + table + '" is empty -- rule "' + ruleLabel + '" skipped.' });
    }

    const condSQL = typeof rule.condition === 'function' ? rule.condition(table) : rule.condition;
    const violRes = await engine.runQuery(
      'SELECT COUNT(*) AS n FROM ' + tQ + ' WHERE ' + condSQL
    );
    violationCount = safeNum(violRes.rows[0], 'n');

    const violationRate = totalRows > 0 ? violationCount / totalRows : 0;
    const { status, level } = flagLevel(violationRate, rule.severity);

    const rationale = buildFlagRationale({ ruleLabel, rule, totalRows, violationCount, violationRate });
    return makeFlagResult({ rule, ruleLabel, totalRows, violationCount, violationRate, status, level, rationale });

  } catch (err) {
    return makeFlagResult({
      rule, ruleLabel, totalRows, violationCount, status: 'idle', level: 'none',
      rationale: 'Flag rule "' + ruleLabel + '" could not run: ' + String(err && err.message ? err.message : err),
      error: String(err),
    });
  }
}

// ---- helpers ---------------------------------------------------------------

function q(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

function safeNum(row, key) {
  if (!row) return 0;
  const v = row[key];
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' ? v : parseInt(String(v), 10) || 0;
}

function flagLevel(rate, severity) {
  if (rate === 0) return { status: 'pass', level: 'none' };
  if (severity === 'hard') {
    // Any impossible row = fail. Severity scales by rate.
    if (rate < FLAG_FAIL_RATE)  return { status: 'fail', level: 'low' };
    if (rate < 0.05)            return { status: 'fail', level: 'medium' };
    return                             { status: 'fail', level: 'high' };
  }
  // Soft rules.
  if (rate < FLAG_WARN_RATE)    return { status: 'pass', level: 'none' };
  if (rate < FLAG_FAIL_RATE)    return { status: 'warn', level: 'low' };
  if (rate < 0.05)              return { status: 'fail', level: 'medium' };
  return                               { status: 'fail', level: 'high' };
}

function buildFlagRationale({ ruleLabel, rule, totalRows, violationCount, violationRate }) {
  if (violationCount === 0) {
    return 'OK: no rows violate "' + ruleLabel + '" across ' + totalRows.toLocaleString() + ' row(s).';
  }
  const pct = (violationRate * 100).toFixed(2);
  return violationCount.toLocaleString() + '/' + totalRows.toLocaleString() + ' (' + pct + '%) rows violate "' + ruleLabel + '": ' + rule.rationale;
}

function makeFlagResult({ rule, ruleLabel, totalRows, violationCount, violationRate = 0,
  status, level, rationale, error = null }) {
  return {
    layer: 'flag_consistency',
    ruleId: rule.id,
    label: ruleLabel,
    requiredCols: rule.requiredCols || [],
    severity: rule.severity || 'hard',
    totalRows,
    violationCount,
    violationRate,
    status,
    level,
    summary: rationale,
    rationale,
    ...(error ? { error } : {}),
  };
}
