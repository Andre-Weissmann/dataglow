// ============================================================
// DATAGLOW — Grouped Imputation Wizard
// ============================================================
// Fills nulls in a numeric column with the mean of its group
// (stratified/group-mean imputation, a standard technique), falling
// back to the global mean when a group has no non-null values.
// Preview-only: never auto-applies. User reviews the generated SQL.

import * as engine from '../app-shell/duckdb-engine.js';

function qi(name) { return `"${name}"`; }

export function buildGroupedImputationSQL(table, targetCol, groupByCols) {
  const t = qi(targetCol);
  const groups = groupByCols.map(qi);
  const joinOn = groups.map(g => `t.${g} IS NOT DISTINCT FROM g.${g}`).join(' AND ');
  const groupList = groups.join(', ');
  // group_means: mean of the target per group. global_mean: overall fallback.
  return `WITH group_means AS (
  SELECT ${groupList}, AVG(${t}) AS grp_avg
  FROM ${table}
  WHERE ${t} IS NOT NULL
  GROUP BY ${groupList}
),
global_mean AS (
  SELECT AVG(${t}) AS all_avg FROM ${table} WHERE ${t} IS NOT NULL
)
SELECT
  t.*,
  COALESCE(t.${t}, g.grp_avg, (SELECT all_avg FROM global_mean)) AS ${qi(targetCol + '_imputed')}
FROM ${table} t
LEFT JOIN group_means g ON ${joinOn}`;
}

export async function previewGroupedImputation(table, targetCol, groupByCols) {
  const t = qi(targetCol);
  const sql = buildGroupedImputationSQL(table, targetCol, groupByCols);

  const { rows: countRows } = await engine.runQuery(
    `SELECT COUNT(*) FILTER (WHERE ${t} IS NULL) AS nulls, COUNT(*) AS total FROM ${table}`
  );
  const nullCount = countRows[0].nulls || 0;
  const total = countRows[0].total || 0;

  // Sample rows that would be filled: before (null) vs after (imputed value).
  const selectCols = [...groupByCols.map(qi), `${t} AS before_value`, `${qi(targetCol + '_imputed')} AS after_value`].join(', ');
  const { rows: sample } = await engine.runQuery(
    `SELECT ${selectCols} FROM (${sql}) sub WHERE before_value IS NULL LIMIT 20`
  );

  // How many nulls remain unfilled (group + global mean both null → all-null column).
  const { rows: remainRows } = await engine.runQuery(
    `SELECT COUNT(*) FILTER (WHERE ${qi(targetCol + '_imputed')} IS NULL) AS remaining FROM (${sql}) sub`
  );
  const remainingNulls = remainRows[0].remaining || 0;

  return {
    sql,
    targetCol,
    groupByCols,
    totalRows: total,
    nullCount,
    wouldFill: nullCount - remainingNulls,
    remainingNulls,
    sample,
  };
}
