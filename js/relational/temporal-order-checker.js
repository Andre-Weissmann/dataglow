// ============================================================
// DATAGLOW — Temporal Order Checker (Phase 2)
// ============================================================
// Detects physically impossible or clinically implausible event orderings
// within a single table. These are the "time travel" bugs that corrupt every
// length-of-stay calculation, readmission window, and billing period report.
//
// WHY THIS MATTERS IN HEALTHCARE:
// - A discharge before an admit makes LOS negative or undefined.
// - A lab result before its order date creates phantom turnaround times.
// - A payment date before a claim date means you paid before you submitted.
// - A death date before a birth date is biologically impossible.
// These errors are invisible to column-level profilers because each column
// looks fine individually -- the problem is only visible when you compare
// two date columns within the same row.
//
// DESIGN:
// Rule-based. Each rule is an { id, label, table, earlierCol, laterCol, severity }
// descriptor. The checker runs each rule as a COUNT query against the live
// DuckDB table and reports violations. No DOM, no network.
//
// BUILT-IN RULES (healthcare-standard):
//   admit_before_discharge   -- discharge_date < admit_date (or equivalent)
//   order_before_result      -- result_date < order_date
//   claim_before_payment     -- payment_date < claim_date
//   birth_before_death       -- death_date < birth_date  (or dod < dob)
//   service_before_auth      -- auth_date < service_date (prior auth issued after service)
//
// Column detection is heuristic -- the checker auto-detects column pairs by
// name pattern when no explicit rule is provided, so it works on any table
// without configuration.

// Severity → status mapping
// 'hard': impossible -- fail always
// 'soft': implausible but occasionally legitimate -- warn
export const TEMPORAL_RULES = [
  {
    id: 'admit_before_discharge',
    label: 'Discharge before admit',
    earlierPattern: /^(admit|admission|admit_date|admitdt|admission_date|admit_dt|encounter_start|start_date|from_date)$/i,
    laterPattern:   /^(discharge|discharge_date|dischargedt|disch_date|disch_dt|encounter_end|end_date|to_date|thru_date)$/i,
    severity: 'hard',
    rationale: 'A discharge date that precedes the admit date produces a negative or undefined length-of-stay and is physically impossible.',
  },
  {
    id: 'order_before_result',
    label: 'Lab result before order',
    earlierPattern: /^(order_date|ordered_date|order_dt|lab_order_date|test_order_date)$/i,
    laterPattern:   /^(result_date|resulted_date|result_dt|lab_result_date|report_date)$/i,
    severity: 'hard',
    rationale: 'A lab result that predates its order date creates phantom turnaround times and breaks clinical timeline analysis.',
  },
  {
    id: 'claim_before_payment',
    label: 'Payment before claim',
    earlierPattern: /^(claim_date|clm_date|service_date|dos|date_of_service|from_date|billed_date)$/i,
    laterPattern:   /^(payment_date|paid_date|remit_date|eob_date|adjudication_date)$/i,
    severity: 'hard',
    rationale: 'A payment date before the claim date means the payer paid before the claim was submitted -- a billing system integrity failure.',
  },
  {
    id: 'birth_before_death',
    label: 'Death before birth',
    earlierPattern: /^(dob|date_of_birth|birth_date|birthdt|birth_dt|patient_dob)$/i,
    laterPattern:   /^(dod|date_of_death|death_date|deathdt|death_dt|patient_dod)$/i,
    severity: 'hard',
    rationale: 'A death date that precedes the date of birth is biologically impossible.',
  },
  {
    id: 'service_before_auth',
    label: 'Prior auth after service',
    earlierPattern: /^(auth_date|authorization_date|prior_auth_date|preauth_date)$/i,
    laterPattern:   /^(service_date|dos|date_of_service|procedure_date|surgery_date)$/i,
    severity: 'soft',
    rationale: 'A prior authorization date after the service date means auth was issued retrospectively -- common in retro-auth workflows but a billing audit flag.',
  },
];

// Violation rate thresholds (same structure as FK checker).
export const TEMPORAL_WARN_RATE = 0.001; // 0.1%
export const TEMPORAL_FAIL_RATE = 0.01;  // 1%

/**
 * Run temporal order checks against a single DuckDB table.
 *
 * Auto-detects date column pairs by name heuristic. You can also pass
 * explicit pairs to override auto-detection.
 *
 * @param {object} opts
 * @param {string} opts.table - DuckDB table name
 * @param {Array<{name:string,type:string}>} opts.cols - column descriptors
 * @param {object} opts.engine - duckdb-engine { runQuery }
 * @param {Array<object>} [opts.explicitRules] - override auto-detected rules
 * @returns {Promise<object>} { rules: results[], summary, status, level, rationale }
 */
export async function checkTemporalOrder({ table, cols, engine, explicitRules = null }) {
  const colNames = (Array.isArray(cols) ? cols : []).map(c =>
    typeof c === 'string' ? c : (c && c.name ? c.name : '')
  ).filter(Boolean);

  // Determine which rules apply: explicit overrides, or auto-detect.
  const applicableRules = explicitRules
    ? explicitRules
    : detectApplicableRules(colNames);

  if (applicableRules.length === 0) {
    return {
      rules: [], status: 'idle', level: 'none',
      summary: { total: 0, pass: 0, warn: 0, fail: 0, idle: 0, totalViolations: 0 },
      rationale: 'No temporal ordering rules detected for table "' + table + '" -- no matching date column pairs found.',
    };
  }

  const results = [];
  for (const rule of applicableRules) {
    results.push(await runTemporalRule({ table, rule, engine }));
  }

  const summary = { total: results.length, pass: 0, warn: 0, fail: 0, idle: 0, totalViolations: 0 };
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
    summary.totalViolations += (r.violationCount || 0);
  }

  const worstStatus = results.some(r => r.status === 'fail') ? 'fail'
    : results.some(r => r.status === 'warn') ? 'warn'
    : results.every(r => r.status === 'idle') ? 'idle' : 'pass';
  const worstLevel = results.some(r => r.level === 'high') ? 'high'
    : results.some(r => r.level === 'medium') ? 'medium'
    : results.some(r => r.level === 'low') ? 'low' : 'none';

  const rationale = summary.totalViolations === 0
    ? 'All ' + summary.total + ' temporal ordering rule(s) pass -- no impossible date sequences detected in "' + table + '".'
    : summary.totalViolations.toLocaleString() + ' impossible/implausible temporal ordering violation(s) detected across ' + (summary.warn + summary.fail) + '/' + summary.total + ' rule(s) in "' + table + '". These will corrupt every LOS, turnaround-time, and readmission-window calculation downstream.';

  return { rules: results, summary, status: worstStatus, level: worstLevel, rationale };
}

// ---- rule runner -----------------------------------------------------------

async function runTemporalRule({ table, rule, engine }) {
  const tQ = q(table);
  const eC = q(rule.earlierCol);
  const lC = q(rule.laterCol);
  const ruleLabel = rule.label || rule.id;

  let totalRows = 0, violationCount = 0;
  try {
    const totalRes = await engine.runQuery(
      'SELECT COUNT(*) AS n FROM ' + tQ +
      ' WHERE ' + eC + ' IS NOT NULL AND ' + lC + ' IS NOT NULL'
    );
    totalRows = safeNum(totalRes.rows[0], 'n');

    if (totalRows === 0) {
      return makeTemporalResult({ rule, ruleLabel, totalRows: 0, violationCount: 0,
        status: 'idle', level: 'none',
        rationale: 'No rows with both "' + rule.earlierCol + '" and "' + rule.laterCol + '" populated -- rule skipped.' });
    }

    // A violation is: laterCol < earlierCol (later event happened before earlier event)
    const violRes = await engine.runQuery(
      'SELECT COUNT(*) AS n FROM ' + tQ +
      ' WHERE ' + eC + ' IS NOT NULL AND ' + lC + ' IS NOT NULL' +
      ' AND TRY_CAST(' + lC + ' AS DATE) < TRY_CAST(' + eC + ' AS DATE)'
    );
    violationCount = safeNum(violRes.rows[0], 'n');

    const violationRate = totalRows > 0 ? violationCount / totalRows : 0;
    const { status, level } = temporalLevel(violationRate, rule.severity);

    const rationale = buildTemporalRationale({ ruleLabel, rule, totalRows, violationCount, violationRate, status });
    return makeTemporalResult({ rule, ruleLabel, totalRows, violationCount, violationRate, status, level, rationale });

  } catch (err) {
    return makeTemporalResult({
      rule, ruleLabel, totalRows, violationCount, status: 'idle', level: 'none',
      rationale: 'Temporal rule "' + ruleLabel + '" could not run: ' + String(err && err.message ? err.message : err),
      error: String(err),
    });
  }
}

// ---- auto-detection --------------------------------------------------------

function detectApplicableRules(colNames) {
  const matched = [];
  for (const rule of TEMPORAL_RULES) {
    const earlierCol = colNames.find(c => rule.earlierPattern.test(c));
    const laterCol   = colNames.find(c => rule.laterPattern.test(c));
    if (earlierCol && laterCol && earlierCol !== laterCol) {
      matched.push({ ...rule, earlierCol, laterCol });
    }
  }
  return matched;
}

// ---- helpers ---------------------------------------------------------------

function q(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

function safeNum(row, key) {
  if (!row) return 0;
  const v = row[key];
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' ? v : parseInt(String(v), 10) || 0;
}

function temporalLevel(rate, severity) {
  if (rate === 0)                                 return { status: 'pass', level: 'none' };
  if (severity === 'hard') {
    // Any violation of a hard rule is a fail.
    if (rate < TEMPORAL_FAIL_RATE)                return { status: 'fail', level: 'low' };
    if (rate < 0.05)                              return { status: 'fail', level: 'medium' };
    return                                               { status: 'fail', level: 'high' };
  }
  // Soft rules: small rate = warn, large rate = fail.
  if (rate < TEMPORAL_WARN_RATE)                  return { status: 'pass', level: 'none' };
  if (rate < TEMPORAL_FAIL_RATE)                  return { status: 'warn', level: 'low' };
  if (rate < 0.05)                                return { status: 'fail', level: 'medium' };
  return                                                 { status: 'fail', level: 'high' };
}

function buildTemporalRationale({ ruleLabel, rule, totalRows, violationCount, violationRate, status }) {
  if (violationCount === 0) {
    return 'OK: all ' + totalRows.toLocaleString() + ' rows with both "' + rule.earlierCol + '" and "' + rule.laterCol + '" show correct ordering (' + ruleLabel + ').';
  }
  const pct = (violationRate * 100).toFixed(2);
  return violationCount.toLocaleString() + '/' + totalRows.toLocaleString() + ' (' + pct + '%) rows violate "' + ruleLabel + '": ' + rule.rationale;
}

function makeTemporalResult({ rule, ruleLabel, totalRows, violationCount, violationRate = 0,
  status, level, rationale, error = null }) {
  return {
    layer: 'temporal_order',
    ruleId: rule.id,
    label: ruleLabel,
    earlierCol: rule.earlierCol || null,
    laterCol: rule.laterCol || null,
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
