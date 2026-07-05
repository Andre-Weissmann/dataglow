// ============================================================
// DATAGLOW — Clean Tab
// Automated data cleaning with a full audit trail.
// ============================================================

import * as engine from './duckdb-engine.js';

export async function scanForIssues(table, cols) {
  const issues = [];
  const rowCount = await engine.getRowCount(table);

  // Nulls per column
  for (const c of cols) {
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" IS NULL`);
    if (rows[0].n > 0) {
      issues.push({
        id: `null_${c.name}`,
        type: 'nulls',
        column: c.name,
        count: rows[0].n,
        pct: ((rows[0].n / rowCount) * 100).toFixed(1),
        label: `${rows[0].n} null value(s) in "${c.name}"`,
        fixes: ['drop_rows', 'fill_zero', 'fill_mean', 'fill_mode'],
      });
    }
  }

  // Exact duplicate rows
  const allCols = cols.map(c => `"${c.name}"`).join(',');
  const { rows: dupRows } = await engine.runQuery(`SELECT SUM(c) - COUNT(*) AS extra FROM (SELECT ${allCols}, COUNT(*) AS c FROM ${table} GROUP BY ${allCols} HAVING COUNT(*) > 1) t`);
  if (dupRows[0].extra > 0) {
    issues.push({ id: 'duplicates', type: 'duplicates', count: dupRows[0].extra, label: `${dupRows[0].extra} duplicate row(s)`, fixes: ['dedupe'] });
  }

  // Whitespace / casing inconsistency in text columns
  const textCols = cols.filter(c => c.type === 'VARCHAR');
  for (const c of textCols) {
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" != TRIM("${c.name}")`);
    if (rows[0].n > 0) {
      issues.push({ id: `whitespace_${c.name}`, type: 'whitespace', column: c.name, count: rows[0].n, label: `${rows[0].n} value(s) with leading/trailing whitespace in "${c.name}"`, fixes: ['trim'] });
    }
  }

  // Negative values in numeric columns that look like amounts/counts
  const numericCols = cols.filter(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type));
  for (const c of numericCols) {
    if (/amount|count|qty|quantity|price|cost|rate|los|stay/i.test(c.name)) {
      const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE "${c.name}" < 0`);
      if (rows[0].n > 0) {
        issues.push({ id: `negative_${c.name}`, type: 'negative', column: c.name, count: rows[0].n, label: `${rows[0].n} negative value(s) in "${c.name}"`, fixes: ['drop_rows', 'abs_value', 'null_out'] });
      }
    }
  }

  return issues;
}

export async function applyFix(table, issue, fixType, auditLog) {
  const log = (msg) => auditLog.push(`[${new Date().toLocaleTimeString()}] ${msg}`);

  if (issue.type === 'nulls') {
    if (fixType === 'drop_rows') {
      const { rowCount: before } = { rowCount: await engine.getRowCount(table) };
      await engine.runQuery(`DELETE FROM ${table} WHERE "${issue.column}" IS NULL`);
      log(`Dropped rows where "${issue.column}" IS NULL (${issue.count} rows removed).`);
    } else if (fixType === 'fill_zero') {
      await engine.runQuery(`UPDATE ${table} SET "${issue.column}" = 0 WHERE "${issue.column}" IS NULL`);
      log(`Filled ${issue.count} null(s) in "${issue.column}" with 0.`);
    } else if (fixType === 'fill_mean') {
      await engine.runQuery(`UPDATE ${table} SET "${issue.column}" = (SELECT AVG("${issue.column}") FROM ${table}) WHERE "${issue.column}" IS NULL`);
      log(`Filled ${issue.count} null(s) in "${issue.column}" with column mean.`);
    } else if (fixType === 'fill_mode') {
      const { rows } = await engine.runQuery(`SELECT "${issue.column}" AS v, COUNT(*) AS n FROM ${table} WHERE "${issue.column}" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
      if (rows[0]) {
        await engine.runQuery(`UPDATE ${table} SET "${issue.column}" = '${String(rows[0].v).replace(/'/g, "''")}' WHERE "${issue.column}" IS NULL`);
        log(`Filled ${issue.count} null(s) in "${issue.column}" with mode value "${rows[0].v}".`);
      }
    }
  } else if (issue.type === 'duplicates') {
    await engine.runQuery(`CREATE OR REPLACE TABLE ${table} AS SELECT DISTINCT * FROM ${table}`);
    log(`Removed ${issue.count} duplicate row(s) via DISTINCT.`);
  } else if (issue.type === 'whitespace') {
    await engine.runQuery(`UPDATE ${table} SET "${issue.column}" = TRIM("${issue.column}")`);
    log(`Trimmed whitespace in "${issue.column}" (${issue.count} value(s) affected).`);
  } else if (issue.type === 'negative') {
    if (fixType === 'drop_rows') {
      await engine.runQuery(`DELETE FROM ${table} WHERE "${issue.column}" < 0`);
      log(`Dropped ${issue.count} row(s) with negative "${issue.column}".`);
    } else if (fixType === 'abs_value') {
      await engine.runQuery(`UPDATE ${table} SET "${issue.column}" = ABS("${issue.column}") WHERE "${issue.column}" < 0`);
      log(`Converted ${issue.count} negative value(s) in "${issue.column}" to absolute value.`);
    } else if (fixType === 'null_out') {
      await engine.runQuery(`UPDATE ${table} SET "${issue.column}" = NULL WHERE "${issue.column}" < 0`);
      log(`Nulled out ${issue.count} negative value(s) in "${issue.column}".`);
    }
  }
}

export const FIX_LABELS = {
  drop_rows: 'Drop rows',
  fill_zero: 'Fill with 0',
  fill_mean: 'Fill with mean',
  fill_mode: 'Fill with mode',
  dedupe: 'Remove duplicates',
  trim: 'Trim whitespace',
  abs_value: 'Convert to absolute value',
  null_out: 'Set to NULL',
};
