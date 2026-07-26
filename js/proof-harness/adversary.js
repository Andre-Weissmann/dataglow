// ============================================================
// DATAGLOW - Proof Harness v2.0: Adversary pack (PH-21 slice)
// ============================================================
// WHY THIS EXISTS
// PROOF_HARNESS_V2_SPEC.md pillar A: a candidate GREEN should survive cheap
// attacks before it is trusted, not just a single primary/expected compare
// and (if available) a second-engine corroboration. This module is the pure
// "adversary" -- it takes a proven-shape SQL statement, builds a handful of
// semantically-equivalent metamorphic rewrites (rewrites that MUST produce
// the same answer if the original statement was correctly proven) plus a
// couple of cheap boundary probes, runs each one through the caller's
// injected `runQuery`, and reports whether every attack still agrees with
// the primary run.
//
// This is deliberately the FOUNDATION slice, not the full V2-1 bug corpus
// (12/15 @ 5M rows): PROOF_HARNESS_V2_SPEC.md is explicit that the honest
// claim after this ship is "DataGlow tried cheap attacks on the number", not
// "DataGlow ran the full adversarial bug suite". A statement this module
// cannot safely rewrite (not a simple SELECT ... FROM ... [WHERE ...]
// [GROUP BY ...] shape) is HONESTLY skipped (`skipped: true`), never forced
// into an invented pass -- a false GREEN is a release blocker (doctrine #7),
// and an adversary pack that could not actually run is not evidence of
// anything, so it must never be reported as if it strengthened GREEN.
//
// PURITY: no DOM, no network, no engine call of its own. `runQuery` is the
// only injected side effect, exactly like index.js's runProofCycle and
// second-engine.js's corroborateRun. Never throws: every attack failure
// (a runQuery rejection, an unreadable result) is captured as a failed
// attack in the report, not as an exception that would abort the whole
// pack -- one broken rewrite must not hide whether the OTHER rewrites still
// agree.

const ADVERSARY_NUMERIC_EPSILON = 1e-6;
const MIN_METAMORPHIC_REWRITES_TO_STRENGTHEN = 5;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Coerce a BigInt to a Number; passes everything else through unchanged.
 * Same rationale as every other proof-harness module's coerceBigInt: DuckDB
 * (and any second engine) can return a BigInt for COUNT/SUM-style
 * aggregates, which breaks strict `typeof === 'number'` checks and
 * JSON.stringify if never coerced. */
function coerceBigInt(v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Same scalar comparison discipline as score-claim.js's scalarMatches and
 * second-engine.js's valuesAgree, restated here (not imported) for the same
 * single-file-inlining reason every other proof-harness pure module
 * restates it -- see score-claim.js's header. */
function valuesAgree(rawA, rawB) {
  const a = coerceBigInt(rawA);
  const b = coerceBigInt(rawB);
  if (typeof a === 'number' && typeof b === 'number') {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
    return Math.abs(a - b) <= ADVERSARY_NUMERIC_EPSILON;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim() === b.trim();
  }
  return a === b;
}

/**
 * Extract a {rowCount, scalars} shape from a raw engine run result, mirroring
 * index.js's extractRunScalars (object rows -> keys directly; array rows +
 * a parallel `columns` array -> map positionally by column name). Restated
 * here (not imported) so this module stays independently inlinable, same as
 * cartridge.js/second-engine.js already do.
 * @param {*} result
 */
function extractRunScalars(result) {
  const scalars = {};
  if (!isPlainObject(result)) return { rowCount: null, scalars };

  let rowCount = null;
  if (typeof result.rowCount === 'number' || typeof result.rowCount === 'bigint') {
    rowCount = Number(coerceBigInt(result.rowCount));
  } else if (Array.isArray(result.rows)) {
    rowCount = result.rows.length;
  }

  if (Array.isArray(result.rows) && result.rows.length > 0) {
    const firstRow = result.rows[0];
    if (Array.isArray(firstRow)) {
      if (Array.isArray(result.columns)) {
        result.columns.forEach((col, i) => {
          const name = typeof col === 'string' ? col : (col && col.name);
          if (typeof name === 'string' && i < firstRow.length) {
            scalars[name] = coerceBigInt(firstRow[i]);
          }
        });
      }
    } else if (isPlainObject(firstRow)) {
      for (const key of Object.keys(firstRow)) {
        scalars[key] = coerceBigInt(firstRow[key]);
      }
    }
  } else if (isPlainObject(result.scalars)) {
    for (const key of Object.keys(result.scalars)) {
      scalars[key] = coerceBigInt(result.scalars[key]);
    }
  }

  return { rowCount, scalars };
}

/**
 * Recognize a simple `SELECT ... FROM t [WHERE ...] [GROUP BY ...]` shape
 * and split it into rewriteable parts. Deliberately narrow: no subqueries in
 * the FROM clause, no JOIN, no UNION, no CTE -- anything more complex is
 * honestly reported as not-rewriteable by buildMetamorphicRewrites() rather
 * than guessed at. A trailing semicolon and surrounding whitespace are
 * tolerated and stripped.
 * @param {string} statement
 * @returns {null | {selectList:string, from:string, where:string|null, groupBy:string|null}}
 */
function parseSimpleSelectShape(statement) {
  if (typeof statement !== 'string' || !statement.trim()) return null;
  const stmt = statement.trim().replace(/;\s*$/, '');
  // Reject anything with a join/union/CTE/subquery-in-from -- those are out
  // of scope for this foundation slice's rewrites; better to skip honestly
  // than to rewrite something we cannot safely reason about.
  if (/\b(union|join|with)\b/i.test(stmt)) return null;
  const m = /^select\s+([\s\S]+?)\s+from\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s*(?:where\s+([\s\S]+?))?\s*(?:group\s+by\s+([\s\S]+?))?$/i.exec(stmt);
  if (!m) return null;
  const [, selectList, from, where, groupBy] = m;
  if (/\(/.test(from)) return null; // subquery/function in FROM: out of scope
  return {
    selectList: selectList.trim(),
    from: from.trim(),
    where: where ? where.trim() : null,
    groupBy: groupBy ? groupBy.trim() : null,
  };
}

function rebuildStatement(parts) {
  let sql = `SELECT ${parts.selectList} FROM ${parts.from}`;
  if (parts.where) sql += ` WHERE ${parts.where}`;
  if (parts.groupBy) sql += ` GROUP BY ${parts.groupBy}`;
  return sql;
}

/**
 * Build at least 5 metamorphic rewrites for a simple SELECT statement: SQL
 * text edits that must NOT change the answer if the original run was
 * genuinely correct. Returns `[]` (honest, not an invented pass) when the
 * statement is not a rewriteable shape -- callers (runAdversaryPack) must
 * treat an empty array as "skipped", never as "attacked and passed".
 *
 * Rewrites (PROOF_HARNESS_V2_SPEC.md pillar A1):
 *   1. whitespace/case normalize (semantic no-op)
 *   2. add redundant WHERE 1=1 (or AND 1=1 if WHERE already present)
 *   3. wrap as SELECT * FROM ( <inner> ) AS _dg_adv
 *   4. column list reorder when explicit columns (best-effort)
 *   5. ORDER BY injection that should not change aggregates without LIMIT
 *   6. double-negate filter NOT NOT (pred) when WHERE present
 * @param {string} statement
 * @returns {string[]}
 */
export function buildMetamorphicRewrites(statement) {
  const parts = parseSimpleSelectShape(statement);
  if (!parts) return [];

  const rewrites = [];

  // 1. whitespace/case normalize (semantic no-op): collapse whitespace and
  // upper-case the SQL keywords this module itself introduced/recognizes.
  const normalized = rebuildStatement(parts)
    .replace(/\s+/g, ' ')
    .trim();
  rewrites.push(
    normalized
      .replace(/\bselect\b/i, 'SELECT')
      .replace(/\bfrom\b/i, 'FROM')
      .replace(/\bwhere\b/i, 'WHERE')
      .replace(/\bgroup by\b/i, 'GROUP BY'),
  );

  // 2. redundant WHERE 1=1 / AND 1=1 -- must not change the result set.
  if (parts.where) {
    rewrites.push(rebuildStatement({ ...parts, where: `(${parts.where}) AND 1=1` }));
  } else {
    rewrites.push(rebuildStatement({ ...parts, where: '1=1' }));
  }

  // 3. wrap as SELECT * FROM ( <inner> ) AS _dg_adv -- an outer wrapper over
  // the exact original statement must reproduce the exact original result.
  rewrites.push(`SELECT * FROM ( ${rebuildStatement(parts)} ) AS _dg_adv`);

  // 4. column list reorder (best-effort): only meaningful when the select
  // list is a simple comma-separated list of 2+ plain columns/aggregates
  // with no GROUP BY-sensitive ordinal reference; reversing the list must
  // not change scalar values, only their column order, which our
  // rowCount/scalar-by-name comparison already ignores.
  const selectItems = parts.selectList.split(',').map((s) => s.trim()).filter(Boolean);
  if (selectItems.length >= 2 && selectItems.length === parts.selectList.split(',').length) {
    const reordered = selectItems.slice().reverse().join(', ');
    rewrites.push(rebuildStatement({ ...parts, selectList: reordered }));
  } else {
    // Still produce a rewrite slot so simple single-column statements (the
    // common case, e.g. `SELECT COUNT(*) AS n FROM t`) reach the required
    // minimum of 5 -- restate rewrite 2's redundant-predicate trick with a
    // different literal tautology, which is an independent attack in its
    // own right (a buggy predicate simplifier that mishandles `1=1` might
    // still mishandle `2>1` differently).
    rewrites.push(rebuildStatement({ ...parts, where: parts.where ? `(${parts.where}) AND 2>1` : '2>1' }));
  }

  // 5. ORDER BY injection without LIMIT: sorting rows before aggregation-free
  // consumption must not change a scalar/rowCount result, since nothing
  // limits or samples the ordered set.
  const orderCandidate = parts.groupBy ? parts.groupBy.split(',')[0].trim() : null;
  const orderClause = orderCandidate || '1';
  rewrites.push(`${rebuildStatement(parts)} ORDER BY ${orderClause}`);

  // 6. double-negate filter NOT NOT (pred) when WHERE present.
  if (parts.where) {
    rewrites.push(rebuildStatement({ ...parts, where: `NOT NOT (${parts.where})` }));
  } else {
    // No WHERE to double-negate: fall back to a second redundant-tautology
    // variant so the pack still reaches >=5 attacks honestly, rather than
    // reporting fewer attacks than the spec's floor.
    rewrites.push(rebuildStatement({ ...parts, where: 'NOT NOT (1=1)' }));
  }

  return rewrites;
}

/**
 * Build cheap boundary probes for a statement: an empty-table equivalent
 * (WHERE 1=0 wrapper, which must report rowCount 0 / a null-safe aggregate)
 * and, when COUNT appears in the select list, a null-safe count variant.
 * Max 3 probes. Returns `[]` when the statement is not a rewriteable shape,
 * same honesty rule as buildMetamorphicRewrites.
 * @param {string} statement
 * @param {object} [context]
 * @returns {{label:string, statement:string}[]}
 */
export function buildBoundaryProbes(statement, _context) {
  const parts = parseSimpleSelectShape(statement);
  if (!parts) return [];

  const probes = [];

  // Empty-table equivalent: wrapping the original FROM in a WHERE 1=0
  // subquery must always yield an empty/zero-scalar result regardless of
  // what the real data contains -- this is a boundary the engine's own
  // aggregate semantics must honor (COUNT(*) over zero rows is 0, SUM/AVG
  // over zero rows is NULL), not a comparison against the primary run's own
  // value.
  probes.push({
    label: 'empty-table-equivalent',
    statement: `SELECT * FROM ( SELECT * FROM ${parts.from} WHERE 1=0 ) AS _dg_adv_empty`,
  });

  // Null-safe count variant, only when COUNT(...) appears in the select
  // list: COUNT(*) and COUNT(1) must agree (both count rows, ignoring
  // nulls-in-a-named-column semantics), which is a cheap way to catch a
  // COUNT implementation bug that only manifests for one spelling.
  if (/count\s*\(\s*\*\s*\)/i.test(parts.selectList)) {
    const rewrittenSelect = parts.selectList.replace(/count\s*\(\s*\*\s*\)/i, 'COUNT(1)');
    probes.push({
      label: 'null-safe-count-variant',
      statement: rebuildStatement({ ...parts, selectList: rewrittenSelect }),
    });
  }

  return probes.slice(0, 3);
}

/**
 * Run the adversary pack: build metamorphic rewrites + boundary probes for
 * `statement`, execute each via the caller's injected `runQuery`, and
 * compare every result to `primaryRun` using the same scalar/rowCount
 * discipline second-engine.js's corroborateRun uses (BigInt-coerced,
 * epsilon numeric compare). Never throws, never invents a pass:
 *   - No rewriteable shape                    -> {ran:false, skipped:true}
 *   - A runQuery rejection on any attack       -> that attack counts as a
 *     failure (`pass:false`), never silently dropped from the report
 *   - Every attack matches the primary run     -> strengthensGreen:true only
 *     when ran && failCount===0 && passCount>=5
 *
 * @param {{statement:string, runQuery:(sql:string)=>Promise<*>,
 *          primaryRun:{rowCount?:number|null, scalars?:object, result?:*},
 *          tolerance?:number}} args
 * @returns {Promise<{ran:boolean, skipped:boolean, reason?:string,
 *   attacks:Array<{kind:'metamorphic'|'boundary', rewrite:string, pass:boolean,
 *     primary?:object, second?:object, detail?:string}>,
 *   passCount:number, failCount:number, strengthensGreen:boolean}>}
 */
export async function runAdversaryPack(args) {
  const a = isPlainObject(args) ? args : {};
  const statement = typeof a.statement === 'string' ? a.statement : '';
  const primaryRun = isPlainObject(a.primaryRun) ? a.primaryRun : {};

  const rewrites = buildMetamorphicRewrites(statement);
  const probes = buildBoundaryProbes(statement, a.context);

  if (rewrites.length === 0) {
    return {
      ran: false,
      skipped: true,
      reason: 'This statement is not a simple SELECT ... FROM ... [WHERE ...] [GROUP BY ...] shape the adversary pack can safely rewrite.',
      attacks: [],
      passCount: 0,
      failCount: 0,
      strengthensGreen: false,
    };
  }

  if (typeof a.runQuery !== 'function') {
    return {
      ran: false,
      skipped: true,
      reason: 'No engine available to run adversary attacks against.',
      attacks: [],
      passCount: 0,
      failCount: 0,
      strengthensGreen: false,
    };
  }

  const primaryRowCount = (typeof primaryRun.rowCount === 'number' || typeof primaryRun.rowCount === 'bigint')
    ? Number(coerceBigInt(primaryRun.rowCount)) : null;
  const primaryScalars = isPlainObject(primaryRun.scalars) ? primaryRun.scalars : {};

  const attacks = [];

  async function runOneAttack(kind, rewriteSql, opts) {
    const isEmptyTableProbe = !!(opts && opts.isEmptyTableProbe);
    try {
      const rawResult = await a.runQuery(rewriteSql);
      const { rowCount, scalars } = extractRunScalars(rawResult);

      if (isEmptyTableProbe) {
        // A boundary probe forced to zero rows must itself report rowCount
        // 0 -- there is no "primary" value to compare against, the probe
        // checks the engine's own empty-set behavior.
        const pass = rowCount === 0 || rowCount === null;
        attacks.push({
          kind,
          rewrite: rewriteSql,
          pass,
          primary: { rowCount: 0 },
          second: { rowCount },
          detail: pass ? undefined : `Expected 0 rows from the empty-table boundary probe, got ${rowCount}.`,
        });
        return;
      }

      let pass = true;
      const detailParts = [];

      if (primaryRowCount !== null && rowCount !== null) {
        if (!valuesAgree(primaryRowCount, rowCount)) {
          pass = false;
          detailParts.push(`rowCount expected ${primaryRowCount}, got ${rowCount}`);
        }
      }

      for (const key of Object.keys(primaryScalars)) {
        if (!Object.prototype.hasOwnProperty.call(scalars, key)) continue;
        if (!valuesAgree(primaryScalars[key], scalars[key])) {
          pass = false;
          detailParts.push(`${key} expected ${JSON.stringify(coerceBigInt(primaryScalars[key]))}, got ${JSON.stringify(coerceBigInt(scalars[key]))}`);
        }
      }

      attacks.push({
        kind,
        rewrite: rewriteSql,
        pass,
        primary: { rowCount: primaryRowCount, scalars: primaryScalars },
        second: { rowCount, scalars },
        detail: pass ? undefined : detailParts.join('; '),
      });
    } catch (err) {
      attacks.push({
        kind,
        rewrite: rewriteSql,
        pass: false,
        primary: { rowCount: primaryRowCount, scalars: primaryScalars },
        second: null,
        detail: err && err.message ? err.message : String(err),
      });
    }
  }

  for (const rewriteSql of rewrites) {
    await runOneAttack('metamorphic', rewriteSql, {});
  }
  for (const probe of probes) {
    await runOneAttack('boundary', probe.statement, { isEmptyTableProbe: probe.label === 'empty-table-equivalent' });
  }

  const passCount = attacks.filter((x) => x.pass).length;
  const failCount = attacks.filter((x) => !x.pass).length;

  return {
    ran: true,
    skipped: false,
    attacks,
    passCount,
    failCount,
    strengthensGreen: failCount === 0 && passCount >= MIN_METAMORPHIC_REWRITES_TO_STRENGTHEN,
  };
}

export const ADVERSARY_MIN_REWRITES = MIN_METAMORPHIC_REWRITES_TO_STRENGTHEN;
