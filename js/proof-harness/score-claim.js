// ============================================================
// DATAGLOW - Proof Harness v0 (VERDICT): claim scoring
// ============================================================
// WHY THIS EXISTS
// Reuses the exact comparison discipline js/drill-floor/drill-floor.js already
// shipped and tested for scoreDrillAnswer/scoreDrillExtras/scalarMatches:
// numbers compare with an absolute epsilon, strings compare trimmed/exact,
// everything else strict-equals. That pattern is restated here (not imported)
// for the same reason js/provenance/trust-ledger.js restates sha256Hex: this
// module is also inlined into canvas/index.html's single inline <script>,
// where cross-module ESM imports do not resolve. test/proof-harness-v0.test.mjs
// pins this copy's behavior directly rather than re-deriving drill-floor's.
//
// PURITY: no DOM, no network, no engine. Pure function of its inputs, never
// throws -- an unreadable run or a malformed expectation comes back as a
// failed comparison with a field-level explanation, not an exception.

const NUMERIC_EPSILON = 1e-6;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Compare one expected scalar to an observed value. Numbers use an absolute
 * epsilon; strings compare exact, case-sensitive, after trim; everything else
 * is strict equality. Never throws. Mirrors drill-floor.js's scalarMatches.
 * @param {*} expected
 * @param {*} observed
 * @returns {boolean}
 */
export function scalarMatches(expected, observed) {
  if (typeof expected === 'number' && typeof observed === 'number') {
    if (!Number.isFinite(expected) || !Number.isFinite(observed)) return expected === observed;
    return Math.abs(expected - observed) <= NUMERIC_EPSILON;
  }
  if (typeof expected === 'string' && typeof observed === 'string') {
    return expected.trim() === observed.trim();
  }
  return expected === observed;
}

/**
 * Extract a row count from a DuckDB-shaped run result. Accepts either the
 * canvas SQL runner's { columns, rows } shape or a bare array of rows. Never
 * throws; returns null when nothing readable is present.
 * @param {*} result
 */
export function extractRowCount(result) {
  if (Array.isArray(result)) return result.length;
  if (isPlainObject(result)) {
    if (Array.isArray(result.rows)) return result.rows.length;
    if (typeof result.rowCount === 'number') return result.rowCount;
  }
  return null;
}

/**
 * Pull a named scalar out of the first row of a DuckDB-shaped run result.
 * Never throws; returns undefined when the column or the row is missing.
 * @param {*} result
 * @param {string} column
 */
export function extractScalar(result, column) {
  if (!isPlainObject(result) || !Array.isArray(result.rows) || result.rows.length === 0) return undefined;
  const row = result.rows[0];
  if (Array.isArray(row)) {
    if (!Array.isArray(result.columns)) return undefined;
    const idx = result.columns.findIndex((c) => (typeof c === 'string' ? c : c && c.name) === column);
    return idx === -1 ? undefined : row[idx];
  }
  if (isPlainObject(row)) return row[column];
  return undefined;
}

/**
 * Compare a claim's expected scalars/rowCount to an engine run, reusing the
 * scoreDrillAnswer/scoreDrillExtras pattern: rowCount is the one scalar
 * comparable across every shape, and any additional named scalars in
 * `expected.scalars` are checked against either the run's own `run.scalars`
 * map (already-computed, e.g. supplied by a caller) or extracted from
 * `run.result` by column name.
 *
 * NEVER throws. Always returns a definite pass/fail per field rather than
 * silently skipping an unreadable one, because a false GREEN is a release
 * blocker (MASTER PROMPT doctrine #7) and a silently-skipped mismatch would
 * be exactly that.
 *
 * @param {{rowCount?:number, rowcountBand?:[number,number], scalars?:object}} expected
 * @param {{rowCount?:number|null, scalars?:object, result?:*}} run
 * @returns {{pass:boolean, mismatches: Array<{field:string, expected:*, got:*}>}}
 */
export function compareClaimToRun(expected, run) {
  const mismatches = [];
  const exp = isPlainObject(expected) ? expected : {};
  const r = isPlainObject(run) ? run : {};

  const observedRowCount = typeof r.rowCount === 'number' ? r.rowCount : extractRowCount(r.result);

  if (typeof exp.rowCount === 'number') {
    if (observedRowCount === null || observedRowCount === undefined || !scalarMatches(exp.rowCount, observedRowCount)) {
      mismatches.push({ field: 'rowCount', expected: exp.rowCount, got: observedRowCount ?? null });
    }
  } else if (Array.isArray(exp.rowcountBand) && exp.rowcountBand.length === 2) {
    const [lo, hi] = exp.rowcountBand;
    if (observedRowCount === null || observedRowCount === undefined || observedRowCount < lo || observedRowCount > hi) {
      mismatches.push({ field: 'rowCount', expected: `[${lo}, ${hi}]`, got: observedRowCount ?? null });
    }
  }

  const expectedScalars = isPlainObject(exp.scalars) ? exp.scalars : {};
  const observedScalars = isPlainObject(r.scalars) ? r.scalars : {};
  for (const key of Object.keys(expectedScalars)) {
    const expectedVal = expectedScalars[key];
    const observedVal = Object.prototype.hasOwnProperty.call(observedScalars, key)
      ? observedScalars[key]
      : extractScalar(r.result, key);
    if (!scalarMatches(expectedVal, observedVal)) {
      mismatches.push({ field: key, expected: expectedVal, got: observedVal === undefined ? null : observedVal });
    }
  }

  return { pass: mismatches.length === 0, mismatches };
}
