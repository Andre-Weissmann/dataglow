// ============================================================
// DATAGLOW — Missingness Classifier (MCAR / MAR / MNAR-aware)
// ============================================================
// Heuristic inspired by Rubin 1976's MCAR/MAR/MNAR framework
// (a public academic concept). If a column's null-rate varies
// strongly across the groups of another categorical column, the
// missingness is unlikely to be completely at random (not MCAR).

import * as engine from './duckdb-engine.js';

const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];
// Groups whose null-rate differs by more than this factor between
// the highest and lowest group are flagged as "not random" (MAR/MNAR).
const VARIATION_FACTOR = 2;
const MAX_GROUP_CARDINALITY = 30;

// Simple, defensible "not MCAR" heuristic: compare the null-rate of the
// target column across the groups of each candidate categorical column.
async function nullRateByGroup(table, targetCol, groupCol) {
  const { rows } = await engine.runQuery(`
    SELECT "${groupCol}" AS grp,
           COUNT(*) AS n,
           COUNT(*) FILTER (WHERE "${targetCol}" IS NULL)::FLOAT / COUNT(*) AS null_rate
    FROM ${table}
    WHERE "${groupCol}" IS NOT NULL
    GROUP BY 1
    ORDER BY null_rate DESC`);
  return rows;
}

export async function analyzeMissingness(table, cols) {
  const rowCountRes = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table}`);
  const rowCount = rowCountRes.rows[0].n || 0;
  const categoricalCols = cols.filter(c => c.type === 'VARCHAR');
  const results = [];

  for (const target of cols) {
    const { rows: nullRows } = await engine.runQuery(
      `SELECT COUNT(*) FILTER (WHERE "${target.name}" IS NULL) AS nulls FROM ${table}`
    );
    const nullCount = nullRows[0].nulls || 0;
    if (nullCount === 0) continue;
    const nullPct = rowCount > 0 ? (nullCount / rowCount) * 100 : 0;

    let strongest = null; // { groupCol, ratio, high, low, breakdown }
    for (const g of categoricalCols) {
      if (g.name === target.name) continue;
      const { rows: distinctRows } = await engine.runQuery(
        `SELECT COUNT(DISTINCT "${g.name}") AS n FROM ${table} WHERE "${g.name}" IS NOT NULL`
      );
      const cardinality = distinctRows[0].n || 0;
      if (cardinality < 2 || cardinality > MAX_GROUP_CARDINALITY) continue;

      const breakdown = await nullRateByGroup(table, target.name, g.name);
      const rates = breakdown.map(r => r.null_rate).filter(r => r != null);
      if (rates.length < 2) continue;
      const high = Math.max(...rates);
      const low = Math.min(...rates);
      // Use a small floor so a 0% baseline doesn't produce an infinite ratio.
      const ratio = high / Math.max(low, 0.01);
      if (ratio >= VARIATION_FACTOR && (!strongest || ratio > strongest.ratio)) {
        strongest = { groupCol: g.name, ratio, high, low, breakdown };
      }
    }

    const likelyMCAR = strongest === null;
    let narrative;
    if (likelyMCAR) {
      narrative = `${nullPct.toFixed(0)}% of ${target.name} values are missing, and the missing rate does not vary strongly across other columns — consistent with missing completely at random (MCAR). Standard imputation (mean/mode) is defensible.`;
    } else {
      const topGroup = strongest.breakdown[0];
      narrative = `${nullPct.toFixed(0)}% of ${target.name} values are missing, and missingness is ${strongest.ratio.toFixed(1)}x more common in "${strongest.groupCol}"=${topGroup.grp} (${(strongest.high * 100).toFixed(0)}% vs ${(strongest.low * 100).toFixed(0)}%) — this is likely not random (MAR/MNAR). Consider treating 'missing' as its own category instead of imputing.`;
    }

    results.push({
      column: target.name,
      type: target.type,
      isNumeric: NUMERIC_TYPES.includes(target.type),
      nullPct: Number(nullPct.toFixed(1)),
      nullCount,
      likelyMCAR,
      narrative,
      correlatedWith: strongest ? strongest.groupCol : null,
      groupBreakdown: strongest
        ? strongest.breakdown.map(r => ({ group: r.grp, n: r.n, nullRate: Number((r.null_rate * 100).toFixed(1)) }))
        : [],
    });
  }

  return results;
}
