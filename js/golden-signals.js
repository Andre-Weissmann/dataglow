// ============================================================
// DATAGLOW — Golden Signals Health Data Layer
// Four top-line data-quality numbers for a health dashboard.
// ============================================================

import * as engine from './duckdb-engine.js';

// Adapted from the "Golden Signals" concept in the Google SRE Book
// (sre.google, public engineering practice). The SRE originals are
// latency/traffic/errors/saturation; we map the idea onto data quality:
// missingness, out-of-range values, duplicates, and freshness.

const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];

export async function computeGoldenSignals(ds, validationResults) {
  const table = ds.table;
  const cols = ds.cols || [];
  const rowCount = ds.rowCount || 0;

  // 1. Missingness rate — null cells / total cells.
  let nullCells = 0;
  const totalCells = rowCount * (cols.length || 1);
  for (const c of cols) {
    const { rows } = await engine.runQuery(
      `SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" IS NULL`
    );
    nullCells += rows[0].n;
  }
  const missingnessRate = totalCells > 0 ? nullCells / totalCells : 0;

  // 2. Out-of-range rate — negative values in amount/count-like numeric cols.
  const numericCols = cols.filter(c => NUMERIC_TYPES.includes(c.type));
  let oorHits = 0;
  for (const c of numericCols) {
    if (/amount|count|qty|quantity|price|cost|rate|age|salary|revenue/i.test(c.name)) {
      const { rows } = await engine.runQuery(
        `SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" < 0`
      );
      oorHits += rows[0].n;
    }
  }
  const outOfRangeRate = rowCount > 0 ? oorHits / rowCount : 0;

  // 3. Duplicate rate — extra rows beyond distinct.
  let duplicateRate = 0;
  if (cols.length > 0 && rowCount > 0) {
    const allCols = cols.map(c => `"${c.name}"`).join(',');
    const { rows } = await engine.runQuery(
      `SELECT COALESCE(SUM(c) - COUNT(*), 0) AS extra FROM (SELECT ${allCols}, COUNT(*) AS c FROM ${table} GROUP BY ${allCols} HAVING COUNT(*) > 1) t`
    );
    duplicateRate = (rows[0].extra || 0) / rowCount;
  }

  // 4. Freshness — hours since load.
  const freshnessHours = (Date.now() - (ds.loadedAt || Date.now())) / 3600000;

  return {
    missingnessRate: Number(missingnessRate.toFixed(4)),
    outOfRangeRate: Number(outOfRangeRate.toFixed(4)),
    duplicateRate: Number(duplicateRate.toFixed(4)),
    freshnessHours: Number(freshnessHours.toFixed(2)),
  };
}
