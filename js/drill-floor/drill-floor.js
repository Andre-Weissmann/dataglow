// ============================================================
// DATAGLOW — Drill Floor: drill registry + orchestration (Batch 1 of N)
// ============================================================
// WHAT THIS IS: the definition of the Drill Floor practice problems and the thin
// orchestration layer that runs a drill's code in each language. The SAME problem
// is stated once and solved side-by-side in SQL, Python, and R against the drill's
// bundled tables (js/drill-floor/drill-floor-data.js -> drill_orders/drill_promos).
//
// Batch 1 ships exactly ONE drill, "Spot the Sale" (BETWEEN join of orders to an
// active promo period). The run* functions DELEGATE to the existing runtime
// bridges (engine.runQuery / runPython / runR) — they reimplement no runtime.
//
// NEVER-THROW-OUT discipline: each run* catches at THIS orchestration layer and
// returns a normalized { error } field instead of throwing, so the UI has a
// single shape to render (the underlying runtime promises may still reject; we
// convert that rejection into a returned error). Everything except the run*
// delegators (which have I/O side effects) is pure and Node-testable.
//
// WHAT BATCH 1 DELIBERATELY DOES NOT DO: no cross-language result diffing /
// comparison engine (that is Batch 2), no additional drills, and no persistence
// of attempts or progress (a future batch). It ships fully dark behind the
// `drillFloor` flag (enabled:false); the flag is checked by the CALLER in
// main.js, never inside this module.

import { DRILL_ORDERS_TABLE, DRILL_PROMOS_TABLE } from './drill-floor-data.js';

// The drill registry. Batch 1 has a single entry; the registry shape is ready to
// grow. starter* fields are the pre-filled editor content for each language; each
// starter is a correct-shaped solution so a user can Run immediately and then
// tinker. expectedApproach documents the intended join for reviewers/future diff.
export const DRILLS = [
  {
    id: 'spot-the-sale',
    title: 'Spot the Sale',
    difficulty: 'Beginner',
    description:
      'Which orders happened during an active promo period? Join the promos ' +
      'table to the orders table where an order\'s date falls BETWEEN a promo\'s ' +
      'start_date and end_date (inclusive on both ends), and return each matching ' +
      'order alongside the promo that was running.',
    ordersTable: DRILL_ORDERS_TABLE,
    promosTable: DRILL_PROMOS_TABLE,
    expectedApproach:
      'Inner join drill_orders to drill_promos on ' +
      'order_date BETWEEN start_date AND end_date; one order may match more than ' +
      'one overlapping promo.',
    starterSql:
      `SELECT o.order_id,\n` +
      `       o.order_date,\n` +
      `       o.amount,\n` +
      `       p.promo_id,\n` +
      `       p.promo_name,\n` +
      `       p.discount_pct\n` +
      `FROM ${DRILL_ORDERS_TABLE} o\n` +
      `JOIN ${DRILL_PROMOS_TABLE} p\n` +
      `  ON o.order_date BETWEEN p.start_date AND p.end_date\n` +
      `ORDER BY o.order_date, o.order_id;`,
    starterPython:
      `import pandas as pd\n` +
      `\n` +
      `orders = dataglow.get_df('${DRILL_ORDERS_TABLE}')\n` +
      `promos = dataglow.get_df('${DRILL_PROMOS_TABLE}')\n` +
      `\n` +
      `orders['order_date'] = pd.to_datetime(orders['order_date'])\n` +
      `promos['start_date'] = pd.to_datetime(promos['start_date'])\n` +
      `promos['end_date'] = pd.to_datetime(promos['end_date'])\n` +
      `\n` +
      `joined = orders.merge(promos, how='cross')\n` +
      `active = joined[\n` +
      `    (joined['order_date'] >= joined['start_date']) &\n` +
      `    (joined['order_date'] <= joined['end_date'])\n` +
      `]\n` +
      `result = active[['order_id', 'order_date', 'amount',\n` +
      `                 'promo_id', 'promo_name', 'discount_pct']]\n` +
      `result = result.sort_values(['order_date', 'order_id'])\n` +
      `print(f"matched rows: {len(result)}")\n` +
      `result.head(20)`,
    starterR:
      `orders <- dataglow_get_df('${DRILL_ORDERS_TABLE}')\n` +
      `promos <- dataglow_get_df('${DRILL_PROMOS_TABLE}')\n` +
      `\n` +
      `orders$order_date <- as.Date(orders$order_date)\n` +
      `promos$start_date <- as.Date(promos$start_date)\n` +
      `promos$end_date   <- as.Date(promos$end_date)\n` +
      `\n` +
      `joined <- merge(orders, promos, by = character(0))\n` +
      `active <- joined[joined$order_date >= joined$start_date &\n` +
      `                 joined$order_date <= joined$end_date, ]\n` +
      `result <- active[order(active$order_date, active$order_id),\n` +
      `                 c('order_id', 'order_date', 'amount',\n` +
      `                   'promo_id', 'promo_name', 'discount_pct')]\n` +
      `cat('matched rows:', nrow(result), '\\n')\n` +
      `head(result, 20)`,
  },
];

/**
 * Look up a drill by id. Pure; returns the drill object or null (never throws).
 * @param {string} id
 * @returns {object|null}
 */
export function getDrill(id) {
  if (typeof id !== 'string') return null;
  return DRILLS.find((d) => d.id === id) || null;
}

// Best-effort row count from a DuckDB engine.runQuery result. Prefers the
// explicit rowCount field, falls back to rows.length, else null. Pure.
export function extractRowCount(queryResult) {
  if (!queryResult || typeof queryResult !== 'object') return null;
  if (typeof queryResult.rowCount === 'number') return queryResult.rowCount;
  if (Array.isArray(queryResult.rows)) return queryResult.rows.length;
  return null;
}

// Normalize any thrown/rejected value into a plain error string.
function errText(err) {
  if (err && typeof err.message === 'string') return err.message;
  return String(err);
}

/**
 * Run SQL against the drill tables, delegating to the injected engine.runQuery.
 * Returns { result, rowCount } on success or { error } on failure — never throws.
 * @param {string} sql
 * @param {{runQuery: (sql:string)=>Promise<any>}} deps
 * @returns {Promise<{result?:any, rowCount?:number|null, error?:string}>}
 */
export async function runDrillSql(sql, { runQuery }) {
  try {
    const result = await runQuery(sql);
    return { result, rowCount: extractRowCount(result) };
  } catch (err) {
    return { error: errText(err) };
  }
}

/**
 * Run Python for the drill, delegating to the injected runPython bridge. The
 * bridge already exposes the drill tables via dataglow.get_df once they are
 * registered as datasets. Returns the runtime's result object, or, if the bridge
 * itself reported an error field, that is preserved. Never throws.
 * @param {string} code
 * @param {{runPython: (code:string)=>Promise<any>}} deps
 * @returns {Promise<{stdout?:string, result?:any, error?:string}>}
 */
export async function runDrillPython(code, { runPython }) {
  try {
    const out = await runPython(code);
    return out || {};
  } catch (err) {
    return { error: errText(err) };
  }
}

/**
 * Run R for the drill, delegating to the injected runR bridge (drill tables are
 * reachable via dataglow_get_df once registered). Never throws.
 * @param {string} code
 * @param {{runR: (code:string)=>Promise<any>}} deps
 * @returns {Promise<{stdout?:string, error?:string}>}
 */
export async function runDrillR(code, { runR }) {
  try {
    const out = await runR(code);
    return out || {};
  } catch (err) {
    return { error: errText(err) };
  }
}
