// ============================================================
// DATAGLOW — Join Coverage Checker (Phase 2)
// ============================================================
// Measures what fraction of rows in a child (detail) table have at least one
// matching row in a parent (reference) table. This is the complement of the
// foreign key orphan check:
//
//   FK orphan check:     child rows that have NO parent match   (bad child rows)
//   Join coverage check: parent rows that have NO child match   (uncovered parents)
//                        AND child-side join rate across the join (coverage %)
//
// WHY THIS MATTERS IN HEALTHCARE:
// "My encounters table joins to labs at 61% coverage" means 39% of encounters
// have zero lab records attached. That could be real (not every patient gets
// labs) or it could be a data drop (your ETL truncated the labs load). You
// cannot distinguish these cases without measuring -- and you cannot measure
// without this check.
//
// Specific healthcare scenarios:
//   encounters -> labs:       low coverage may mean truncated lab load
//   patients -> encounters:   patients with no encounter history (may be valid)
//   claims -> claim_lines:    claims with no line items (always invalid)
//   encounters -> diagnoses:  encounters with no ICD codes (always suspect)
//
// METRICS:
//   childCoverageRate    = rows in child that join to at least one parent row
//                          / total rows in child
//                          (close to 1.0 = good; low = orphan-heavy child)
//   parentCoverageRate   = rows in parent that have at least one child row
//                          / total rows in parent
//                          (low = parent rows with no detail -- may be valid)
//
// THRESHOLDS (child-side, because that is the actionable direction):
//   >= 99%: pass (noise)
//   95-99%: warn
//   < 95%:  fail

export const JOIN_WARN_RATE = 0.95; // below this child coverage rate -> warn
export const JOIN_FAIL_RATE = 0.90; // below this -> fail

/**
 * Measure the join coverage between two DuckDB tables.
 *
 * @param {object} opts
 * @param {string} opts.childTable  - detail table (e.g. "encounters")
 * @param {string} opts.childCol    - join key in child table
 * @param {string} opts.parentTable - reference table (e.g. "patients")
 * @param {string} opts.parentCol   - join key in parent table
 * @param {object} opts.engine      - { runQuery }
 * @param {string} [opts.label]     - human-readable label
 * @returns {Promise<object>} coverage result
 */
export async function checkJoinCoverage({
  childTable, childCol, parentTable, parentCol, engine, label = null,
}) {
  const rel = label || (childTable + ' -> ' + parentTable + ' via ' + childCol);
  const cT  = q(childTable), cC = q(childCol);
  const pT  = q(parentTable), pC = q(parentCol);

  let childTotal = 0, childMatched = 0, parentTotal = 0, parentMatched = 0;

  try {
    // Total child rows (non-null key only -- nulls cannot join)
    const cTotRes = await engine.runQuery(
      'SELECT COUNT(*) AS n FROM ' + cT + ' WHERE ' + cC + ' IS NOT NULL'
    );
    childTotal = safeNum(cTotRes.rows[0], 'n');

    // Total parent rows
    const pTotRes = await engine.runQuery('SELECT COUNT(*) AS n FROM ' + pT);
    parentTotal = safeNum(pTotRes.rows[0], 'n');

    if (childTotal === 0 && parentTotal === 0) {
      return makeCovResult({ rel, childTotal: 0, childMatched: 0, parentTotal: 0, parentMatched: 0,
        childCoverageRate: null, parentCoverageRate: null, status: 'idle', level: 'none',
        rationale: 'Both tables are empty -- join coverage check skipped.' });
    }

    if (childTotal > 0) {
      // Child rows that have at least one match in the parent.
      const cMatchRes = await engine.runQuery(
        'SELECT COUNT(*) AS n FROM ' + cT +
        ' WHERE ' + cC + ' IS NOT NULL' +
        ' AND ' + cC + ' IN (SELECT DISTINCT ' + pC + ' FROM ' + pT + ' WHERE ' + pC + ' IS NOT NULL)'
      );
      childMatched = safeNum(cMatchRes.rows[0], 'n');
    }

    if (parentTotal > 0) {
      // Parent rows that appear in at least one child row.
      const pMatchRes = await engine.runQuery(
        'SELECT COUNT(DISTINCT ' + cC + ') AS n FROM ' + cT +
        ' WHERE ' + cC + ' IS NOT NULL' +
        ' AND ' + cC + ' IN (SELECT DISTINCT ' + pC + ' FROM ' + pT + ' WHERE ' + pC + ' IS NOT NULL)'
      );
      parentMatched = safeNum(pMatchRes.rows[0], 'n');
    }

    const childCoverageRate  = childTotal  > 0 ? childMatched  / childTotal  : null;
    const parentCoverageRate = parentTotal > 0 ? parentMatched / parentTotal : null;

    const { status, level } = coverageLevel(childCoverageRate);
    const rationale = buildCoverageRationale({ rel, childTotal, childMatched, childCoverageRate,
      parentTotal, parentMatched, parentCoverageRate });

    return makeCovResult({ rel, childTotal, childMatched, parentTotal, parentMatched,
      childCoverageRate, parentCoverageRate, status, level, rationale });

  } catch (err) {
    return makeCovResult({ rel, childTotal, childMatched, parentTotal, parentMatched,
      childCoverageRate: null, parentCoverageRate: null, status: 'idle', level: 'none',
      rationale: 'Join coverage check could not run for ' + rel + ': ' + String(err && err.message ? err.message : err),
      error: String(err) });
  }
}

/**
 * Run multiple join coverage checks and return a combined summary.
 *
 * @param {Array<object>} pairs - checkJoinCoverage option objects (without engine)
 * @param {object} engine
 * @returns {Promise<object>}
 */
export async function checkAllJoinCoverage(pairs, engine) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return {
      pairs: [], status: 'idle', level: 'none',
      summary: { total: 0, pass: 0, warn: 0, fail: 0, idle: 0 },
      rationale: 'No join coverage pairs provided.',
    };
  }

  const results = [];
  for (const p of pairs) {
    results.push(await checkJoinCoverage({ ...p, engine }));
  }

  const summary = { total: results.length, pass: 0, warn: 0, fail: 0, idle: 0 };
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
  }

  const worstStatus = results.some(r => r.status === 'fail') ? 'fail'
    : results.some(r => r.status === 'warn') ? 'warn'
    : results.every(r => r.status === 'idle') ? 'idle' : 'pass';
  const worstLevel = results.some(r => r.level === 'high') ? 'high'
    : results.some(r => r.level === 'medium') ? 'medium'
    : results.some(r => r.level === 'low') ? 'low' : 'none';

  const failing = results.filter(r => r.status === 'fail' || r.status === 'warn');
  const rationale = failing.length === 0
    ? 'All ' + summary.total + ' join coverage check(s) pass.'
    : failing.length + '/' + summary.total + ' join relationship(s) have low child coverage: ' +
      failing.map(r => r.relationship + ' (' + (r.childCoverageRate != null ? (r.childCoverageRate * 100).toFixed(1) + '%' : 'N/A') + ')').join('; ') + '.';

  return { pairs: results, summary, status: worstStatus, level: worstLevel, rationale };
}

// ---- helpers ---------------------------------------------------------------

function q(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

function safeNum(row, key) {
  if (!row) return 0;
  const v = row[key];
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' ? v : parseInt(String(v), 10) || 0;
}

function coverageLevel(rate) {
  if (rate === null || rate === undefined) return { status: 'idle', level: 'none' };
  if (rate >= JOIN_WARN_RATE)  return { status: 'pass', level: 'none' };
  if (rate >= JOIN_FAIL_RATE)  return { status: 'warn', level: 'low' };
  if (rate >= 0.75)            return { status: 'fail', level: 'medium' };
  return                              { status: 'fail', level: 'high' };
}

function buildCoverageRationale({ rel, childTotal, childMatched, childCoverageRate,
  parentTotal, parentMatched, parentCoverageRate }) {
  const childPct = childCoverageRate != null ? (childCoverageRate * 100).toFixed(1) + '%' : 'N/A';
  const parentPct = parentCoverageRate != null ? (parentCoverageRate * 100).toFixed(1) + '%' : 'N/A';

  if (childCoverageRate === null && parentCoverageRate === null) {
    return 'Join coverage check skipped for ' + rel + ' (empty tables).';
  }

  const parts = [
    'Join coverage for ' + rel + ':',
    'Child-side: ' + childMatched.toLocaleString() + '/' + childTotal.toLocaleString() + ' (' + childPct + ') rows match a parent key.',
    'Parent-side: ' + parentMatched.toLocaleString() + '/' + parentTotal.toLocaleString() + ' (' + parentPct + ') parent keys have at least one child row.',
  ];

  if (childCoverageRate !== null && childCoverageRate < JOIN_WARN_RATE) {
    parts.push((100 - childCoverageRate * 100).toFixed(1) + '% of child rows cannot join to the parent. This may indicate a truncated or partial data load, or an ETL key mismatch.');
  }
  return parts.join(' ');
}

function makeCovResult({ rel, childTotal, childMatched, parentTotal, parentMatched,
  childCoverageRate, parentCoverageRate, status, level, rationale, error = null }) {
  return {
    layer: 'join_coverage',
    relationship: rel,
    childTotal,
    childMatched,
    parentTotal,
    parentMatched,
    childCoverageRate,
    parentCoverageRate,
    status,
    level,
    summary: rationale,
    rationale,
    ...(error ? { error } : {}),
  };
}
