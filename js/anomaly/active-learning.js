// ============================================================
// DATAGLOW — Active-Learning Uncertainty Flags
// Surfaces the cells DATAGLOW is least sure about, first.
// ============================================================

// Uncertainty sampling for active learning, Settles 2009 (public survey),
// with error-detection framing from the ED2 system (Neutatz et al.,
// SIGMOD 2019, public research). Both are academic, non-proprietary.

const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];

function isNumeric(col) {
  return NUMERIC_TYPES.includes(col.type);
}

// Score how ambiguous a categorical mode-fill would be: two close top
// candidates (e.g. 52% vs 48%) => high uncertainty (near 1); a dominant
// mode (e.g. 95%) => low uncertainty (near 0).
async function scoreCategoricalUncertainty(table, col, engine) {
  const { rows } = await engine.runQuery(
    `SELECT "${col.name}" AS v, COUNT(*) AS n FROM ${table} WHERE "${col.name}" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 2`
  );
  if (rows.length === 0) return null;
  const top = rows[0].n;
  const second = rows[1] ? rows[1].n : 0;
  const total = top + second;
  if (total === 0) return null;
  // margin small => uncertain. uncertainty = 1 - normalized margin.
  const margin = (top - second) / total;
  const uncertaintyScore = 1 - margin;
  return {
    uncertaintyScore,
    reason: `Mode-fill candidate for "${col.name}" is ambiguous: top two values split ${top} vs ${second}.`,
  };
}

// Score numeric fill uncertainty via coefficient of variation: a
// high-variance column makes any single fill value (mean) unreliable.
async function scoreNumericUncertainty(table, col, engine) {
  const { rows } = await engine.runQuery(
    `SELECT AVG("${col.name}") AS m, STDDEV_POP("${col.name}") AS s FROM ${table} WHERE "${col.name}" IS NOT NULL`
  );
  const m = rows[0].m, s = rows[0].s;
  if (m == null || s == null || m === 0) return null;
  const cv = Math.abs(s / m);
  const uncertaintyScore = Math.min(1, cv / 2); // cv>=2 => max uncertainty
  return {
    uncertaintyScore,
    reason: `Mean-fill for "${col.name}" is uncertain: high spread (coefficient of variation ≈ ${cv.toFixed(2)}).`,
  };
}

export async function rankUncertainCells(table, cols, engine) {
  const ranked = [];
  for (const col of cols) {
    const { rows: nullRows } = await engine.runQuery(
      `SELECT COUNT(*) AS n FROM ${table} WHERE "${col.name}" IS NULL`
    );
    const nullCount = nullRows[0].n;
    if (nullCount === 0) continue; // only columns being considered for imputation

    const scored = isNumeric(col)
      ? await scoreNumericUncertainty(table, col, engine)
      : await scoreCategoricalUncertainty(table, col, engine);
    if (!scored) continue;

    ranked.push({
      column: col.name,
      rowIdentifier: `${nullCount} null cell(s) in "${col.name}"`,
      uncertaintyScore: Number(scored.uncertaintyScore.toFixed(4)),
      reason: scored.reason,
    });
  }
  ranked.sort((a, b) => b.uncertaintyScore - a.uncertaintyScore);
  return ranked;
}
