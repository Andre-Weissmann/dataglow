// ============================================================
// DATAGLOW — Foreign Key / Orphan Checker (Phase 2)
// ============================================================
// Detects rows in a child table whose foreign key value has no matching
// primary key in the parent table. These "orphan" rows silently break every
// downstream JOIN, inflate or deflate aggregate metrics, and are invisible to
// any single-table column profiler.
//
// WHY THIS MATTERS IN HEALTHCARE:
// A claim with no matching patient, an encounter with no matching provider,
// or a lab result with no matching encounter are not just data quality issues
// -- they are HIPAA accounting-of-disclosures risks (who does this record
// belong to?) and billing audit failures (you cannot adjudicate a claim that
// references a non-existent patient).
//
// DESIGN:
// Pure and DuckDB-WASM-aware. The engine parameter is a duckdb-engine.js
// compatible object with runQuery(sql) -> {rows}. No DOM, no network.
//
// USAGE (two tables already loaded into DuckDB as "encounters" and "patients"):
//   const result = await checkForeignKey({
//     childTable: 'encounters', childCol: 'patient_id',
//     parentTable: 'patients', parentCol: 'patient_id',
//     engine,
//   });
//   // result.orphanCount, result.orphanRate, result.flagged, result.level
//
// For batch mode (many FK relationships at once):
//   const results = await checkAllForeignKeys(pairs, engine);

// Thresholds -- aligned with healthcare data quality standards.
// < 0.1% orphans: clean (noise level, likely late-arriving rows)
// 0.1% – 1%:     warn (systematic but small gap)
// > 1%:          fail (meaningful referential break)
export const FK_WARN_RATE  = 0.001; // 0.1%
export const FK_FAIL_RATE  = 0.01;  // 1%

/**
 * Run a single foreign key orphan check between two DuckDB tables.
 *
 * @param {object} opts
 * @param {string} opts.childTable  - table that holds the FK column
 * @param {string} opts.childCol    - FK column in child table
 * @param {string} opts.parentTable - table that holds the PK column
 * @param {string} opts.parentCol   - PK column in parent table
 * @param {object} opts.engine      - duckdb-engine { runQuery }
 * @param {string} [opts.label]     - human-readable relationship label
 * @returns {Promise<object>} FK check result
 */
export async function checkForeignKey({
  childTable, childCol, parentTable, parentCol, engine, label = null,
}) {
  const rel = label || (childTable + '.' + childCol + ' -> ' + parentTable + '.' + parentCol);
  const cT  = q(childTable), cC = q(childCol);
  const pT  = q(parentTable), pC = q(parentCol);

  let totalRows = 0, orphanCount = 0;

  try {
    const totalRes = await engine.runQuery(
      'SELECT COUNT(*) AS n FROM ' + cT + ' WHERE ' + cC + ' IS NOT NULL'
    );
    totalRows = safeNum(totalRes.rows[0], 'n');

    if (totalRows === 0) {
      return makeResult({ rel, totalRows: 0, orphanCount: 0, nullCount: 0,
        status: 'pass', level: 'none',
        rationale: 'No non-null FK values in ' + childTable + '.' + childCol + ' -- check skipped.' });
    }

    // Count nulls separately (nulls in FK columns are their own quality signal
    // but are not "orphans" in the relational sense -- they may be intentional).
    const nullRes = await engine.runQuery(
      'SELECT COUNT(*) AS n FROM ' + cT + ' WHERE ' + cC + ' IS NULL'
    );
    const nullCount = safeNum(nullRes.rows[0], 'n');

    // Orphan = child FK value not present in parent PK column at all.
    const orphanRes = await engine.runQuery(
      'SELECT COUNT(*) AS n FROM ' + cT +
      ' WHERE ' + cC + ' IS NOT NULL' +
      ' AND ' + cC + ' NOT IN (SELECT DISTINCT ' + pC + ' FROM ' + pT + ' WHERE ' + pC + ' IS NOT NULL)'
    );
    orphanCount = safeNum(orphanRes.rows[0], 'n');

    // Sample up to 5 distinct orphan values for the rationale message.
    let orphanSample = [];
    if (orphanCount > 0) {
      try {
        const sampleRes = await engine.runQuery(
          'SELECT DISTINCT ' + cC + ' AS v FROM ' + cT +
          ' WHERE ' + cC + ' IS NOT NULL' +
          ' AND ' + cC + ' NOT IN (SELECT DISTINCT ' + pC + ' FROM ' + pT + ' WHERE ' + pC + ' IS NOT NULL)' +
          ' LIMIT 5'
        );
        orphanSample = (sampleRes.rows || []).map(r => String(r.v));
      } catch { orphanSample = []; }
    }

    const orphanRate = totalRows > 0 ? orphanCount / totalRows : 0;
    const { status, level } = rateLevel(orphanRate);

    const rationale = buildFKRationale({ rel, totalRows, orphanCount, orphanRate, nullCount, orphanSample, status });

    return makeResult({ rel, totalRows, orphanCount, orphanRate, nullCount, orphanSample, status, level, rationale });

  } catch (err) {
    return makeResult({
      rel, totalRows, orphanCount, nullCount: 0, status: 'idle', level: 'none',
      rationale: 'Foreign key check could not run for ' + rel + ': ' + String(err && err.message ? err.message : err),
      error: String(err),
    });
  }
}

/**
 * Run multiple FK checks in sequence and return a combined summary.
 *
 * @param {Array<object>} pairs - array of checkForeignKey option objects (without engine)
 * @param {object} engine
 * @returns {Promise<object>} { pairs: results[], summary, status, level, rationale }
 */
export async function checkAllForeignKeys(pairs, engine) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return {
      pairs: [], status: 'idle', level: 'none',
      summary: { total: 0, pass: 0, warn: 0, fail: 0, idle: 0, totalOrphans: 0 },
      rationale: 'No foreign key relationships provided.',
    };
  }

  const results = [];
  for (const p of pairs) {
    results.push(await checkForeignKey({ ...p, engine }));
  }

  const summary = { total: results.length, pass: 0, warn: 0, fail: 0, idle: 0, totalOrphans: 0 };
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
    summary.totalOrphans += (r.orphanCount || 0);
  }

  const worstStatus = results.some(r => r.status === 'fail') ? 'fail'
    : results.some(r => r.status === 'warn') ? 'warn'
    : results.every(r => r.status === 'idle') ? 'idle' : 'pass';
  const worstLevel = results.some(r => r.level === 'high') ? 'high'
    : results.some(r => r.level === 'medium') ? 'medium'
    : results.some(r => r.level === 'low') ? 'low' : 'none';

  const rationale = summary.totalOrphans === 0
    ? 'All ' + summary.total + ' FK relationship(s) are clean -- 0 orphan rows detected.'
    : summary.totalOrphans + ' orphan row(s) found across ' + (summary.warn + summary.fail) + '/' + summary.total + ' FK relationship(s). Orphan rows will silently break downstream JOINs.';

  return { pairs: results, summary, status: worstStatus, level: worstLevel, rationale };
}

// ---- internals -------------------------------------------------------------

function q(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

function safeNum(row, key) {
  if (!row) return 0;
  const v = row[key];
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' ? v : parseInt(String(v), 10) || 0;
}

function rateLevel(rate) {
  if (rate === 0)              return { status: 'pass', level: 'none' };
  if (rate < FK_WARN_RATE)     return { status: 'pass', level: 'none' }; // noise
  if (rate < FK_FAIL_RATE)     return { status: 'warn', level: 'low' };
  if (rate < 0.05)             return { status: 'fail', level: 'medium' };
  return                              { status: 'fail', level: 'high' };
}

function buildFKRationale({ rel, totalRows, orphanCount, orphanRate, nullCount, orphanSample, status }) {
  const pct = (orphanRate * 100).toFixed(2);
  const parts = [];
  if (orphanCount === 0) {
    parts.push('FK clean: all ' + totalRows.toLocaleString() + ' non-null ' + rel + ' values resolve to a parent row.');
  } else {
    parts.push(orphanCount.toLocaleString() + '/' + totalRows.toLocaleString() + ' (' + pct + '%) non-null values in ' + rel + ' have no matching parent row (orphans).');
    if (orphanSample && orphanSample.length > 0) {
      parts.push('Sample orphan keys: ' + orphanSample.join(', ') + (orphanCount > orphanSample.length ? ', ...' : '') + '.');
    }
    parts.push('These rows will return NULL or be silently dropped in any JOIN against the parent table.');
  }
  if (nullCount > 0) {
    parts.push(nullCount.toLocaleString() + ' row(s) have a NULL FK value (not counted as orphans -- may be intentional).');
  }
  return parts.join(' ');
}

function makeResult({ rel, totalRows, orphanCount, orphanRate = 0, nullCount = 0,
  orphanSample = [], status, level, rationale, error = null }) {
  return {
    layer: 'foreign_key',
    relationship: rel,
    totalRows,
    orphanCount,
    orphanRate,
    nullCount,
    orphanSample,
    status,
    level,
    summary: rationale,
    rationale,
    ...(error ? { error } : {}),
  };
}
