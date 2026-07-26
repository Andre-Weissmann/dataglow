// ============================================================
// DATAGLOW - Drill Floor: drill registry + orchestration (Batch 1, Bundle 16)
// ============================================================
// WHAT THIS IS: the definition of the Drill Floor practice problems and the thin
// orchestration layer that runs a drill's code in each language. The SAME problem
// is stated once and solved side-by-side in SQL, Python, and R against the drill's
// bundled tables (js/drill-floor/drill-floor-data.js -> drill_orders/drill_promos).
//
// Batch 1 shipped exactly ONE drill, "Spot the Sale" (BETWEEN join of orders to an
// active promo period). Bundle 16 (behind the `receiptDrillBattery` flag) adds
// THREE more drills against the SAME original, deterministic synthetic tables,
// a window/rank-within-group drill, a group-by + HAVING drill, and a running-total
// drill, plus a `goldenAnswers` block on every drill and a pure `scoreDrillAnswer`
// checker so a run can be marked pass/fail against a KNOWN scalar instead of just
// being cross-language-compared (that comparison, drill-diff.js, still exists and
// is unaffected). Every row of every table here is DataGlow's own generated data
// (js/drill-floor/drill-floor-data.js, seeded PRNG), never a redistributed or
// cloned third-party dataset, and no question text is copied from any external
// practice-drill product.
//
// The run* functions DELEGATE to the existing runtime bridges (engine.runQuery /
// runPython / runR); they reimplement no runtime.
//
// NEVER-THROW-OUT discipline: each run* catches at THIS orchestration layer and
// returns a normalized { error } field instead of throwing, so the UI has a
// single shape to render (the underlying runtime promises may still reject; we
// convert that rejection into a returned error). Everything except the run*
// delegators (which have I/O side effects) is pure and Node-testable.
//
// Drill Floor ships fully dark behind the `drillFloor` flag; the battery below is
// additionally gated by `receiptDrillBattery` (both flags are checked by the
// CALLER in main.js / the canvas UI, never inside this module).

import { DRILL_ORDERS_TABLE, DRILL_PROMOS_TABLE } from './drill-floor-data.js';

// Bundle 16: the one honesty line every Drill Floor surface (main.js tab,
// canvas UI) should show once, verbatim, next to the battery. It exists so
// nobody mistakes original DataGlow practice drills for a specific external
// analytics-drill product's dataset or answer key.
export const DRILL_BATTERY_HONESTY_NOTE =
  'Practice drills use original DataGlow data and golden answers. They are not ' +
  'Maven Analytics Data Drills and do not score against Maven answer keys. ' +
  'The practice PATTERNS below (first/last-per-group, between-date joins, ' +
  'top-n, running totals) are common shapes drawn from public data-analytics ' +
  'education content generally, not from any one vendor\'s proprietary file; ' +
  'every dataset, question, and golden answer here is DataGlow\'s own.';

// The drill registry. starter* fields are the pre-filled editor content for each
// language; each starter is a correct-shaped solution so a user can Run
// immediately and then tinker. expectedApproach documents the intended
// query shape for reviewers/future diff. goldenAnswers holds the KNOWN scalar(s)
// each language's starter produces against the deterministic sample data, so a
// run can be scored pass/fail rather than only cross-language-compared.
//
// excelNote is Bundle 16's honest Excel path: none of these drills claim a full
// Excel engine walkthrough. Each names either a SQL "Excel-outcome equivalent"
// reshape (what a person would build with Power Query / PivotTables to reach the
// same numbers) or explicitly says there is no Excel engine in this build and
// that is not being papered over.
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
    excelNote:
      'Not full Excel. Excel-outcome equivalent: a Power Query merge on ' +
      '"date within range" (or a helper column with nested IF/AND against each ' +
      'promo\'s start/end) reaches the same 133 matched rows; this build does not ' +
      'run that engine, it names the equivalent honestly instead of skipping it.',
    goldenAnswers: {
      sql: { rowCount: 133, sumAmount: 36381.6, orderIdChecksum: 20208 },
      python: { rowCount: 133 },
      r: { rowCount: 133 },
    },
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
  {
    id: 'top-order-per-channel',
    title: 'Top Order Per Channel',
    difficulty: 'Intermediate',
    description:
      'For each sales channel (web, store, phone, partner), find the single ' +
      'highest-amount order. Return one row per channel: the channel, the ' +
      'winning order_id, and its amount: a window/rank-within-group problem.',
    ordersTable: DRILL_ORDERS_TABLE,
    promosTable: DRILL_PROMOS_TABLE,
    expectedApproach:
      'Rank orders within each channel by amount descending (ROW_NUMBER/RANK ' +
      'partitioned by channel, or an equivalent groupby-idxmax/which.max), then ' +
      'keep only rank 1 per channel. Four channels in the sample data, so the ' +
      'answer is exactly four rows.',
    excelNote:
      'Not full Excel. Excel-outcome equivalent: a PivotTable with channel as ' +
      'rows and MAX(amount) as the value reaches the same four amounts; finding ' +
      'the matching order_id per channel needs an extra INDEX/MATCH or a helper ' +
      'column, which this build does not attempt to simulate.',
    goldenAnswers: {
      sql: { rowCount: 4, sumOfTopAmounts: 1994.93 },
      python: { rowCount: 4 },
      r: { rowCount: 4 },
    },
    starterSql:
      `SELECT channel, order_id, amount\n` +
      `FROM (\n` +
      `  SELECT channel, order_id, amount,\n` +
      `         ROW_NUMBER() OVER (PARTITION BY channel ORDER BY amount DESC, order_id) AS rnk\n` +
      `  FROM ${DRILL_ORDERS_TABLE}\n` +
      `) ranked\n` +
      `WHERE rnk = 1\n` +
      `ORDER BY channel;`,
    starterPython:
      `import pandas as pd\n` +
      `\n` +
      `orders = dataglow.get_df('${DRILL_ORDERS_TABLE}')\n` +
      `\n` +
      `idx = orders.groupby('channel')['amount'].idxmax()\n` +
      `result = orders.loc[idx, ['channel', 'order_id', 'amount']].sort_values('channel')\n` +
      `print(f"matched rows: {len(result)}")\n` +
      `result`,
    starterR:
      `orders <- dataglow_get_df('${DRILL_ORDERS_TABLE}')\n` +
      `\n` +
      `top_by_channel <- do.call(rbind, lapply(split(orders, orders$channel), function(g) {\n` +
      `  g[which.max(g$amount), c('channel', 'order_id', 'amount')]\n` +
      `}))\n` +
      `result <- top_by_channel[order(top_by_channel$channel), ]\n` +
      `cat('matched rows:', nrow(result), '\\n')\n` +
      `result`,
  },
  {
    id: 'channels-over-threshold',
    title: 'Channels Over Threshold',
    difficulty: 'Intermediate',
    description:
      'Total order amount by channel, then keep only the channels whose total ' +
      'exceeds $19,000: a group-by-then-filter-the-groups (HAVING) problem, ' +
      'not a row-level WHERE filter.',
    ordersTable: DRILL_ORDERS_TABLE,
    promosTable: DRILL_PROMOS_TABLE,
    expectedApproach:
      'GROUP BY channel, SUM(amount), then HAVING SUM(amount) > 19000 (or the ' +
      'equivalent groupby+filter in Python/R). Against the sample data exactly ' +
      'one channel (store) clears the bar.',
    excelNote:
      'Not full Excel. Excel-outcome equivalent: a PivotTable summed by channel, ' +
      'then manually reading off which subtotal exceeds $19,000; Excel has no ' +
      'native HAVING; this build does not simulate that manual read.',
    goldenAnswers: {
      sql: { rowCount: 1, channels: ['store'], totalOfKept: 20545.33 },
      python: { rowCount: 1 },
      r: { rowCount: 1 },
    },
    starterSql:
      `SELECT channel, ROUND(SUM(amount), 2) AS total_amount\n` +
      `FROM ${DRILL_ORDERS_TABLE}\n` +
      `GROUP BY channel\n` +
      `HAVING SUM(amount) > 19000\n` +
      `ORDER BY channel;`,
    starterPython:
      `import pandas as pd\n` +
      `\n` +
      `orders = dataglow.get_df('${DRILL_ORDERS_TABLE}')\n` +
      `\n` +
      `totals = orders.groupby('channel')['amount'].sum().round(2)\n` +
      `result = totals[totals > 19000].reset_index(name='total_amount')\n` +
      `print(f"matched rows: {len(result)}")\n` +
      `result`,
    starterR:
      `orders <- dataglow_get_df('${DRILL_ORDERS_TABLE}')\n` +
      `\n` +
      `totals <- aggregate(amount ~ channel, data = orders, FUN = sum)\n` +
      `totals$amount <- round(totals$amount, 2)\n` +
      `result <- totals[totals$amount > 19000, ]\n` +
      `cat('matched rows:', nrow(result), '\\n')\n` +
      `result`,
  },
  {
    id: 'running-total-by-day',
    title: 'Running Total By Day',
    difficulty: 'Advanced',
    description:
      'Total order amount per calendar day, then a running (cumulative) total ' +
      'across days in date order. Report the number of distinct order dates and ' +
      'the final running-total value (the grand total across the whole year).',
    ordersTable: DRILL_ORDERS_TABLE,
    promosTable: DRILL_PROMOS_TABLE,
    expectedApproach:
      'GROUP BY order_date, SUM(amount), then a window SUM(...) OVER (ORDER BY ' +
      'order_date) (or an equivalent cumsum in Python/R) to get the running ' +
      'total; the last row\'s running total equals the grand total of all orders.',
    excelNote:
      'Not full Excel. Excel-outcome equivalent: a helper column with a growing ' +
      'SUM($B$2:B2) formula copied down a date-sorted PivotTable reaches the same ' +
      'running totals; this build does not simulate dragging that formula.',
    goldenAnswers: {
      sql: { rowCount: 205, grandTotal: 76527.14 },
      python: { rowCount: 205 },
      r: { rowCount: 205 },
    },
    starterSql:
      `SELECT order_date,\n` +
      `       ROUND(SUM(amount), 2) AS day_total,\n` +
      `       ROUND(SUM(SUM(amount)) OVER (ORDER BY order_date), 2) AS running_total\n` +
      `FROM ${DRILL_ORDERS_TABLE}\n` +
      `GROUP BY order_date\n` +
      `ORDER BY order_date;`,
    starterPython:
      `import pandas as pd\n` +
      `\n` +
      `orders = dataglow.get_df('${DRILL_ORDERS_TABLE}')\n` +
      `\n` +
      `by_day = orders.groupby('order_date')['amount'].sum().round(2).reset_index(name='day_total')\n` +
      `by_day = by_day.sort_values('order_date')\n` +
      `by_day['running_total'] = by_day['day_total'].cumsum().round(2)\n` +
      `result = by_day\n` +
      `print(f"matched rows: {len(result)}")\n` +
      `result`,
    starterR:
      `orders <- dataglow_get_df('${DRILL_ORDERS_TABLE}')\n` +
      `\n` +
      `by_day <- aggregate(amount ~ order_date, data = orders, FUN = sum)\n` +
      `by_day <- by_day[order(by_day$order_date), ]\n` +
      `by_day$amount <- round(by_day$amount, 2)\n` +
      `by_day$running_total <- round(cumsum(by_day$amount), 2)\n` +
      `result <- by_day\n` +
      `cat('matched rows:', nrow(result), '\\n')\n` +
      `result`,
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
 * Returns { result, rowCount } on success or { error } on failure; never throws.
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

// ---------------------------------------------------------------
// Bundle 16: golden-answer scoring.
// ---------------------------------------------------------------
// Best-effort row-count parser shared with drill-diff.js's convention: a
// Python/R starter prints a line like `matched rows: 133`; SQL's own result
// carries an explicit rowCount. Kept local (rather than importing drill-diff.js)
// so this module has zero dependency on the comparison layer.
function parseMatchedRowsLocal(stdout) {
  if (typeof stdout !== 'string') return null;
  const re = /matched rows:\s*(\d+)/gi;
  let match;
  let last = null;
  while ((match = re.exec(stdout)) !== null) last = match[1];
  return last === null ? null : Number(last);
}

// Read the one scalar every drill/engine combination in this battery scores
// on: rowCount. SQL reads it from the structured result; Python/R parse it
// from the "matched rows: N" line the starters print. Never throws.
function observedRowCount(engine, result) {
  if (!result || typeof result !== 'object') return null;
  if (engine === 'sql') return extractRowCount(result.result !== undefined ? result.result : result);
  return parseMatchedRowsLocal(result.stdout);
}

/**
 * Score a drill run against its goldenAnswers. PURE: reads only from its
 * inputs, touches no runtime, and NEVER throws; an unknown drill/engine or a
 * result with nothing readable in it comes back as { pass:false, got:null }
 * rather than an exception the caller would have to guard against.
 *
 * @param {string} drillId          one of DRILLS[].id
 * @param {'sql'|'python'|'r'} engineName
 * @param {object} result           that engine's own run* return value
 *   (runDrillSql -> {result,rowCount,error?}; runDrillPython/runDrillR ->
 *   {stdout,result,error?})
 * @returns {{pass:boolean, expected:number|null, got:number|null, drillId:string, engine:string, error?:string}}
 */
export function scoreDrillAnswer(drillId, engineName, result) {
  const drill = getDrill(drillId);
  if (!drill || !drill.goldenAnswers || !drill.goldenAnswers[engineName]) {
    return { pass: false, expected: null, got: null, drillId: String(drillId), engine: String(engineName), error: 'no golden answer for this drill/engine' };
  }
  if (result && typeof result === 'object' && result.error) {
    return { pass: false, expected: drill.goldenAnswers[engineName].rowCount ?? null, got: null, drillId, engine: engineName, error: String(result.error) };
  }
  const expected = typeof drill.goldenAnswers[engineName].rowCount === 'number' ? drill.goldenAnswers[engineName].rowCount : null;
  const got = observedRowCount(engineName, result);
  if (expected === null || got === null) {
    return { pass: false, expected, got, drillId, engine: engineName, error: got === null ? 'no row count could be read from the result' : undefined };
  }
  return { pass: got === expected, expected, got, drillId, engine: engineName };
}
