// ============================================================
// DATAGLOW - Proof Harness v1: Second Engine Rule (corroboration)
// ============================================================
// WHY THIS EXISTS
// PROOF_HARNESS_V1_SPEC.md, pillar 1: after the primary engine (DuckDB) yields
// a candidate GREEN, an independent second runner (Pyodide preferred, webR
// optional) is asked to reproduce the same result. Disagreement BLOCKS GREEN
// -- doctrine treats two engines disagreeing as a definite, checkable fact
// (RED), not an absence of proof (GRAY). This module is the pure comparison:
// it takes whatever the primary run already produced and whatever the
// injected second runner returned, and decides whether they agree, using the
// exact same epsilon-and-trim discipline score-claim.js already established
// (restated here, not imported, for the same inlining reason every other
// proof-harness module restates its primitives -- see score-claim.js's
// header).
//
// This module NEVER calls a runtime itself. `runProofCycle` (index.js) is the
// only place that decides WHETHER to run a second engine and WHICH one;
// corroborateRun() only ever receives already-produced run results (or a
// rejection) and returns a verdict-ready corroboration record.
//
// PURITY: no DOM, no network, no engine call, never throws.

const SECOND_ENGINE_NUMERIC_EPSILON = 1e-6;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Coerce a BigInt to a Number; passes everything else through unchanged.
 * DuckDB-WASM returns BigInt for COUNT/SUM-style aggregates on EITHER side
 * of a corroboration compare (primary or second engine), which fails the
 * `typeof a === 'number'` check below outright and falls through to `a ===
 * b` strict equality -- where a BigInt 10n !== Number 10, producing a false
 * disagree even when the two engines actually agree. See index.js's HOTFIX
 * comment (post-#622) for the full root cause. */
function coerceBigInt(v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Same scalar comparison discipline as score-claim.js's scalarMatches,
 * with BigInt coerced on both sides first. */
function valuesAgree(rawA, rawB) {
  const a = coerceBigInt(rawA);
  const b = coerceBigInt(rawB);
  if (typeof a === 'number' && typeof b === 'number') {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
    return Math.abs(a - b) <= SECOND_ENGINE_NUMERIC_EPSILON;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim() === b.trim();
  }
  return a === b;
}

/**
 * Read a named scalar out of the first row of a raw run `result`, the same
 * object/array-row discipline index.js's extractRunScalars and
 * score-claim.js's extractScalar both use, coercing BigInt on the way out.
 * This is the defense-in-depth fallback corroborateRun() uses when
 * `primaryRun.scalars` came back empty (e.g. an older/uninstrumented
 * primary run, or a host that still hands back only `{result}`) so a
 * genuinely-registered scalar in the raw result is never treated as
 * "missing" just because nothing upstream extracted it first.
 * @param {*} result
 * @param {string} column
 */
function extractScalarFromResult(result, column) {
  if (!isPlainObject(result) || !Array.isArray(result.rows) || result.rows.length === 0) return undefined;
  const row = result.rows[0];
  if (Array.isArray(row)) {
    if (!Array.isArray(result.columns)) return undefined;
    const idx = result.columns.findIndex((c) => (typeof c === 'string' ? c : c && c.name) === column);
    return idx === -1 ? undefined : coerceBigInt(row[idx]);
  }
  if (isPlainObject(row) && Object.prototype.hasOwnProperty.call(row, column)) {
    return coerceBigInt(row[column]);
  }
  return undefined;
}

/**
 * Resolve a callable second-engine runner from whatever the canvas/host has
 * available, mirroring the graduated-fallback style resolveRunQuery() uses
 * for the primary DuckDB engine. Returns { name, run } or null when nothing
 * usable is present -- never throws, and the caller (index.js/canvas) is
 * expected to treat null as "second engine not ready" (v0 single-engine
 * strength), never as a corroboration failure.
 *
 * PROOF_HARNESS_V1_1_SPEC.md pillar B1 priority order (updated from v1,
 * which only looked for window.runDrillPython/window.runDrillR directly):
 *   1. An explicitly injected opts.runSecondEngine always wins.
 *   2. window.runProofSecondEngine -- the NEW preferred host bridge the
 *      canvas installs (Pyodide+duckdb preferred, honest not-ready shape
 *      when unavailable; see the canvas module's installSecondEngineBridge()).
 *   3. window.DataGlowProofHarness.runSecondEngine, only if it is actually a
 *      function (a prior harness build may not define one at all; checked
 *      defensively so a missing method never throws here).
 *   4. window.runDrillPython, but ONLY if it looks like a proof-shaped
 *      runner (accepts a SQL string and returns a promise) rather than the
 *      code-panel's python executor, which takes a Python program, not SQL
 *      -- calling that blindly with a raw SQL string would throw nonsense
 *      into a code cell instead of running a query. Since a code-panel
 *      runner and a proof-shaped runner cannot be told apart just by arity,
 *      this level is opt-in: only honored when the host has ALSO set the
 *      `window.runDrillPython.isProofRunner = true` marker, which only the
 *      canvas's own SQL-shaped installer sets, never the generic code-panel
 *      Python runner.
 *   5. window.runDrillR, same caution/marker (`isProofRunner`) as #4.
 *   6. null -- second engine not ready, v0 single-engine strength.
 * @param {{runSecondEngine?: Function, secondEngineName?: string}} [opts]
 */
export function resolveSecondEngine(opts) {
  const o = isPlainObject(opts) ? opts : {};
  if (typeof o.runSecondEngine === 'function') {
    return { name: typeof o.secondEngineName === 'string' && o.secondEngineName.trim() ? o.secondEngineName.trim() : 'second-engine', run: o.runSecondEngine };
  }
  try {
    if (typeof window !== 'undefined') {
      if (typeof window.runProofSecondEngine === 'function') {
        return { name: 'pyodide', run: window.runProofSecondEngine };
      }
      if (window.DataGlowProofHarness && typeof window.DataGlowProofHarness.runSecondEngine === 'function') {
        return { name: 'second-engine', run: window.DataGlowProofHarness.runSecondEngine };
      }
      if (typeof window.runDrillPython === 'function' && window.runDrillPython.isProofRunner === true) {
        return { name: 'pyodide', run: window.runDrillPython };
      }
      if (typeof window.runDrillR === 'function' && window.runDrillR.isProofRunner === true) {
        return { name: 'webr', run: window.runDrillR };
      }
    }
  } catch (_e) { /* never throw resolving an optional runtime */ }
  return null;
}

/**
 * Extract a comparable {rowCount, scalars} shape from a second-engine run
 * result. Second engines (Pyodide/webR) commonly return {stdout, result,
 * error} rather than DuckDB's {columns, rows}; this reads a `result` object
 * or array the same way score-claim.js's extractRowCount does, and any
 * caller-supplied `scalars` map is passed through unchanged.
 * @param {*} secondRun
 */
export function normalizeSecondRun(secondRun) {
  if (!isPlainObject(secondRun)) return { rowCount: null, scalars: {}, error: null };
  const payload = secondRun.result !== undefined ? secondRun.result : secondRun;
  // Precedence (explicit numeric rowCount always wins over inferring length
  // from an array, on either the outer secondRun or the inner payload):
  //   1. secondRun.rowCount if number
  //   2. payload.rowCount if number
  //   3. payload.rows.length if array
  //   4. payload.length if array
  // A fake/second engine that returns BOTH {rows:[...]} and an explicit
  // rowCount (e.g. {rows:[{n:1}], rowCount:50}) must resolve to the explicit
  // rowCount, not the array length, so a genuine disagreement with the
  // primary engine is never masked into a false agree.
  let rowCount = null;
  if (typeof secondRun.rowCount === 'number' || typeof secondRun.rowCount === 'bigint') {
    rowCount = Number(coerceBigInt(secondRun.rowCount));
  } else if (isPlainObject(payload) && (typeof payload.rowCount === 'number' || typeof payload.rowCount === 'bigint')) {
    rowCount = Number(coerceBigInt(payload.rowCount));
  } else if (isPlainObject(payload) && Array.isArray(payload.rows)) {
    rowCount = payload.rows.length;
  } else if (Array.isArray(payload)) {
    rowCount = payload.length;
  }
  // Coerce BigInt in every reported scalar too -- a second engine (e.g. the
  // canvas's pyodide-duckdb bridge) can hand back a BigInt COUNT the exact
  // same way the primary DuckDB-WASM engine does.
  const rawScalars = isPlainObject(secondRun.scalars) ? secondRun.scalars : {};
  const scalars = {};
  for (const key of Object.keys(rawScalars)) {
    scalars[key] = coerceBigInt(rawScalars[key]);
  }
  const error = typeof secondRun.error === 'string' && secondRun.error.trim() ? secondRun.error.trim() : null;
  return { rowCount, scalars, error };
}

/**
 * Compare the primary engine's run to a second engine's run for corroboration.
 * Agreement requires: the second engine did not error, its rowCount matches
 * the primary's rowCount (when both are known), and every named scalar in
 * `expected.scalars` that the second engine reports agrees with the primary's
 * value for that same scalar. An unreadable/unavailable second run resolves
 * to `ran: false, agrees: null` (v0 single-engine strength, NOT a disagree),
 * so callers can distinguish "no second engine ran" from "second engine ran
 * and disagreed".
 *
 * NEVER throws.
 * @param {{primaryRun: {rowCount?:number|null, scalars?:object}, secondRun?: *,
 *          secondEngineName?: string, expected?: {scalars?:object}}} args
 * @returns {{ran:boolean, engine:string|null, agrees:boolean|null, tolerance:number,
 *   divergence_class:string|null, details: Array<{field:string, primary:*, second:*}>}}
 */
export function corroborateRun(args) {
  const a = isPlainObject(args) ? args : {};
  const engineName = typeof a.secondEngineName === 'string' && a.secondEngineName.trim() ? a.secondEngineName.trim() : null;

  if (a.secondRun === undefined || a.secondRun === null) {
    return { ran: false, engine: engineName, agrees: null, tolerance: SECOND_ENGINE_NUMERIC_EPSILON, divergence_class: null, details: [] };
  }

  const primary = isPlainObject(a.primaryRun) ? a.primaryRun : {};
  const second = normalizeSecondRun(a.secondRun);

  if (second.error) {
    return {
      ran: true,
      engine: engineName,
      agrees: false,
      tolerance: SECOND_ENGINE_NUMERIC_EPSILON,
      divergence_class: 'second-engine-error',
      details: [{ field: 'error', primary: null, second: second.error }],
    };
  }

  const details = [];
  let agrees = true;

  const primaryRowCount = (typeof primary.rowCount === 'number' || typeof primary.rowCount === 'bigint')
    ? Number(coerceBigInt(primary.rowCount)) : null;
  if (primaryRowCount !== null && second.rowCount !== null) {
    const rowsAgree = valuesAgree(primaryRowCount, second.rowCount);
    details.push({ field: 'rowCount', primary: primaryRowCount, second: second.rowCount });
    if (!rowsAgree) agrees = false;
  }

  const expectedScalars = isPlainObject(a.expected) && isPlainObject(a.expected.scalars) ? a.expected.scalars : {};
  const primaryScalars = isPlainObject(primary.scalars) ? primary.scalars : {};
  for (const key of Object.keys(expectedScalars)) {
    if (!Object.prototype.hasOwnProperty.call(second.scalars, key)) continue; // second engine did not report this scalar; nothing to compare
    // Defense in depth: if the primary run's own `scalars` map came back
    // empty (e.g. an older/uninstrumented primary path never populated it --
    // this is exactly the bug this hotfix fixes upstream in index.js), fall
    // back to reading the same named column straight out of the primary's
    // raw `result` before concluding the primary never reported this scalar
    // at all. A key that legitimately IS present on primaryScalars always
    // wins over this fallback.
    const primaryVal = Object.prototype.hasOwnProperty.call(primaryScalars, key)
      ? coerceBigInt(primaryScalars[key])
      : extractScalarFromResult(primary.result, key);
    const secondVal = second.scalars[key];
    details.push({ field: key, primary: primaryVal, second: secondVal });
    if (!valuesAgree(primaryVal, secondVal)) agrees = false;
  }

  return {
    ran: true,
    engine: engineName,
    agrees,
    tolerance: SECOND_ENGINE_NUMERIC_EPSILON,
    divergence_class: agrees ? null : 'result-mismatch',
    details,
  };
}

/**
 * Build the `corroboration` field the receipt predicate expects
 * (buildReceiptPredicate's `predicate.corroboration`), from a
 * corroborateRun() result. Returns null when no second engine ran at all
 * (v0 single-engine strength is not itself a corroboration event worth
 * recording as a distinct predicate field).
 * @param {ReturnType<typeof corroborateRun>} corroboration
 */
export function buildCorroborationField(corroboration) {
  if (!isPlainObject(corroboration) || corroboration.ran !== true) return null;
  return {
    engine: corroboration.engine,
    agrees: corroboration.agrees,
    tolerance: corroboration.tolerance,
    divergence_class: corroboration.divergence_class,
  };
}
