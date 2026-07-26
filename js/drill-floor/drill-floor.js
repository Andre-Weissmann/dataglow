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

import {
  DRILL_ORDERS_TABLE,
  DRILL_PROMOS_TABLE,
  DRILL_PRICE_HISTORY_TABLE,
  DRILL_SALES_TABLE,
  DRILL_ACTIVITY_DAYS_TABLE,
  DRILL_BASKET_LINES_TABLE,
} from './drill-floor-data.js';

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
  {
    id: 'scd-as-of',
    title: 'Price As Of Sale Date',
    difficulty: 'Advanced',
    description:
      'Product price history is tracked SCD Type 2 style: each row is a price ' +
      'valid over an inclusive [valid_from, valid_to] date range. For each sale, ' +
      'find the price that was active on that sale\'s date (an as-of / SCD lookup ' +
      'join), then compute total revenue = SUM(units * price) across matched ' +
      'sales. A sale outside every price range for its product does not match ' +
      'and is excluded, not treated as revenue-zero.',
    ordersTable: DRILL_PRICE_HISTORY_TABLE,
    promosTable: DRILL_SALES_TABLE,
    expectedApproach:
      'Join drill_sales to drill_price_history on matching product_id where ' +
      'sale_date BETWEEN valid_from AND valid_to (inclusive both ends); sum ' +
      'units * price over the matched rows.',
    excelNote:
      'Not full Excel. Excel-outcome equivalent: a Power Query merge on ' +
      '"date within range" per product (or nested IF/AND helper columns ' +
      'against each price segment) reaches the same 314 matched rows; this ' +
      'build does not run that engine, it names the equivalent honestly ' +
      'instead of skipping it.',
    goldenAnswers: {
      sql: { rowCount: 314, totalRevenue: 101018, productCount: 6 },
      python: { rowCount: 314 },
      r: { rowCount: 314 },
    },
    starterSql:
      `SELECT s.sale_id,\n` +
      `       s.product_id,\n` +
      `       s.sale_date,\n` +
      `       s.units,\n` +
      `       h.price,\n` +
      `       s.units * h.price AS revenue\n` +
      `FROM ${DRILL_SALES_TABLE} s\n` +
      `JOIN ${DRILL_PRICE_HISTORY_TABLE} h\n` +
      `  ON s.product_id = h.product_id\n` +
      ` AND s.sale_date BETWEEN h.valid_from AND h.valid_to\n` +
      `ORDER BY s.sale_id;`,
    starterPython:
      `import pandas as pd\n` +
      `\n` +
      `sales = dataglow.get_df('${DRILL_SALES_TABLE}')\n` +
      `history = dataglow.get_df('${DRILL_PRICE_HISTORY_TABLE}')\n` +
      `\n` +
      `sales['sale_date'] = pd.to_datetime(sales['sale_date'])\n` +
      `history['valid_from'] = pd.to_datetime(history['valid_from'])\n` +
      `history['valid_to'] = pd.to_datetime(history['valid_to'])\n` +
      `\n` +
      `joined = sales.merge(history, on='product_id', how='inner')\n` +
      `matched = joined[\n` +
      `    (joined['sale_date'] >= joined['valid_from']) &\n` +
      `    (joined['sale_date'] <= joined['valid_to'])\n` +
      `]\n` +
      `result = matched[['sale_id', 'product_id', 'sale_date', 'units', 'price']].copy()\n` +
      `result['revenue'] = result['units'] * result['price']\n` +
      `result = result.sort_values('sale_id')\n` +
      `print(f"matched rows: {len(result)}")\n` +
      `result.head(20)`,
    starterR:
      `sales <- dataglow_get_df('${DRILL_SALES_TABLE}')\n` +
      `history <- dataglow_get_df('${DRILL_PRICE_HISTORY_TABLE}')\n` +
      `\n` +
      `sales$sale_date <- as.Date(sales$sale_date)\n` +
      `history$valid_from <- as.Date(history$valid_from)\n` +
      `history$valid_to   <- as.Date(history$valid_to)\n` +
      `\n` +
      `joined <- merge(sales, history, by = 'product_id')\n` +
      `matched <- joined[joined$sale_date >= joined$valid_from &\n` +
      `                  joined$sale_date <= joined$valid_to, ]\n` +
      `matched$revenue <- matched$units * matched$price\n` +
      `result <- matched[order(matched$sale_id),\n` +
      `                  c('sale_id', 'product_id', 'sale_date', 'units', 'price', 'revenue')]\n` +
      `cat('matched rows:', nrow(result), '\\n')\n` +
      `head(result, 20)`,
  },
  {
    id: 'streak-islands',
    title: 'Longest Activity Streak',
    difficulty: 'Advanced',
    description:
      'A daily activity log records one row per (user, day) they were active. ' +
      'Find the longest run of CONSECUTIVE calendar days any single user was ' +
      'active (a gaps-and-islands / island-grouping problem), and report the ' +
      'user_id holding that maximum streak. Ties break to the LOWEST user_id.',
    ordersTable: DRILL_ACTIVITY_DAYS_TABLE,
    promosTable: DRILL_ACTIVITY_DAYS_TABLE,
    expectedApproach:
      'Per user, sort distinct activity_date ascending; a new island starts ' +
      'whenever the gap to the previous date is not exactly 1 day (the ' +
      '"date minus ROW_NUMBER()" island-id trick works well in SQL); take the ' +
      'longest island length per user, then the max across users with a ' +
      'lowest-user_id tie-break.',
    excelNote:
      'Not full Excel. Excel-outcome equivalent: a helper column flagging a ' +
      'new streak whenever a sorted date is not exactly one day after the row ' +
      'above, then a PivotTable MAX of streak length per user, reaches the ' +
      'same 9-day answer; this build does not simulate dragging that formula.',
    // SQL rowCount is the starter's own RESULT SHAPE (LIMIT 1 winner row),
    // not the underlying activity table size; Python/R rowCount below is the
    // activity table size printed by their starters' "matched rows: N" line.
    goldenAnswers: {
      sql: { rowCount: 1, maxStreak: 9, userId: 1, islandCount: 106 },
      python: { rowCount: 474 },
      r: { rowCount: 474 },
    },
    starterSql:
      `WITH ranked AS (\n` +
      `  SELECT user_id, activity_date,\n` +
      `         activity_date - (ROW_NUMBER() OVER (\n` +
      `           PARTITION BY user_id ORDER BY activity_date\n` +
      `         )) * INTERVAL 1 DAY AS island_key\n` +
      `  FROM ${DRILL_ACTIVITY_DAYS_TABLE}\n` +
      `),\n` +
      `islands AS (\n` +
      `  SELECT user_id, island_key, COUNT(*) AS streak_len\n` +
      `  FROM ranked\n` +
      `  GROUP BY user_id, island_key\n` +
      `),\n` +
      `per_user_best AS (\n` +
      `  SELECT user_id, MAX(streak_len) AS best_streak\n` +
      `  FROM islands\n` +
      `  GROUP BY user_id\n` +
      `)\n` +
      `SELECT user_id, best_streak AS max_streak\n` +
      `FROM per_user_best\n` +
      `ORDER BY best_streak DESC, user_id ASC\n` +
      `LIMIT 1;`,
    starterPython:
      `import pandas as pd\n` +
      `\n` +
      `activity = dataglow.get_df('${DRILL_ACTIVITY_DAYS_TABLE}')\n` +
      `activity['activity_date'] = pd.to_datetime(activity['activity_date'])\n` +
      `\n` +
      `best_by_user = {}\n` +
      `for user_id, g in activity.groupby('user_id'):\n` +
      `    dates = sorted(g['activity_date'].unique())\n` +
      `    best = cur = 1 if dates else 0\n` +
      `    for i in range(1, len(dates)):\n` +
      `        gap = (dates[i] - dates[i - 1]).days\n` +
      `        cur = cur + 1 if gap == 1 else 1\n` +
      `        best = max(best, cur)\n` +
      `    best_by_user[user_id] = best\n` +
      `\n` +
      `max_streak = max(best_by_user.values())\n` +
      `winner = min(uid for uid, v in best_by_user.items() if v == max_streak)\n` +
      `result = pd.DataFrame([{'user_id': winner, 'max_streak': max_streak}])\n` +
      `print(f"matched rows: {len(activity)}")\n` +
      `result`,
    starterR:
      `activity <- dataglow_get_df('${DRILL_ACTIVITY_DAYS_TABLE}')\n` +
      `activity$activity_date <- as.Date(activity$activity_date)\n` +
      `\n` +
      `best_by_user <- sapply(split(activity$activity_date, activity$user_id), function(dates) {\n` +
      `  dates <- sort(unique(dates))\n` +
      `  if (length(dates) == 0) return(0L)\n` +
      `  best <- cur <- 1L\n` +
      `  for (i in seq(2, length(dates))) {\n` +
      `    gap <- as.numeric(dates[i] - dates[i - 1])\n` +
      `    cur <- if (gap == 1) cur + 1L else 1L\n` +
      `    best <- max(best, cur)\n` +
      `  }\n` +
      `  best\n` +
      `})\n` +
      `\n` +
      `max_streak <- max(best_by_user)\n` +
      `winner <- min(as.integer(names(best_by_user)[best_by_user == max_streak]))\n` +
      `result <- data.frame(user_id = winner, max_streak = max_streak)\n` +
      `cat('matched rows:', nrow(activity), '\\n')\n` +
      `result`,
  },
  {
    id: 'basket-pairs',
    title: 'Most Common SKU Pair',
    difficulty: 'Intermediate',
    description:
      'Order line items list which SKUs were in each order. Find the unordered ' +
      'pair of distinct SKUs that co-occur in the most orders (a market-basket ' +
      'co-occurrence problem), and report the pair (lexicographically ordered ' +
      'left/right) and how many orders contain both.',
    ordersTable: DRILL_BASKET_LINES_TABLE,
    promosTable: DRILL_BASKET_LINES_TABLE,
    expectedApproach:
      'Self-join drill_basket_lines to itself on order_id where the left SKU is ' +
      'lexicographically less than the right SKU (this both de-duplicates the ' +
      'pair and enforces a canonical left/right order), then GROUP BY the pair ' +
      'and take the highest COUNT(DISTINCT order_id).',
    excelNote:
      'Not full Excel. Excel-outcome equivalent: a Power Query self-merge on ' +
      'order_id (with a helper column to keep only left < right) followed by a ' +
      'PivotTable count reaches the same top pair; this build does not run ' +
      'that engine, it names the equivalent honestly instead of skipping it.',
    goldenAnswers: {
      sql: { rowCount: 1, pairLeft: 'SKU-C', pairRight: 'SKU-F', orderCount: 63 },
      python: { rowCount: 1 },
      r: { rowCount: 1 },
    },
    starterSql:
      `SELECT a.sku AS pair_left,\n` +
      `       b.sku AS pair_right,\n` +
      `       COUNT(DISTINCT a.order_id) AS order_count\n` +
      `FROM ${DRILL_BASKET_LINES_TABLE} a\n` +
      `JOIN ${DRILL_BASKET_LINES_TABLE} b\n` +
      `  ON a.order_id = b.order_id\n` +
      ` AND a.sku < b.sku\n` +
      `GROUP BY a.sku, b.sku\n` +
      `ORDER BY order_count DESC, pair_left, pair_right\n` +
      `LIMIT 1;`,
    starterPython:
      `import pandas as pd\n` +
      `from itertools import combinations\n` +
      `from collections import Counter\n` +
      `\n` +
      `lines = dataglow.get_df('${DRILL_BASKET_LINES_TABLE}')\n` +
      `\n` +
      `pair_counts = Counter()\n` +
      `for order_id, g in lines.groupby('order_id'):\n` +
      `    skus = sorted(set(g['sku']))\n` +
      `    for left, right in combinations(skus, 2):\n` +
      `        pair_counts[(left, right)] += 1\n` +
      `\n` +
      `(pair_left, pair_right), order_count = max(\n` +
      `    sorted(pair_counts.items()), key=lambda kv: kv[1]\n` +
      `)\n` +
      `result = pd.DataFrame([{'pair_left': pair_left, 'pair_right': pair_right, 'order_count': order_count}])\n` +
      `print(f"matched rows: {len(result)}")\n` +
      `result`,
    starterR:
      `lines <- dataglow_get_df('${DRILL_BASKET_LINES_TABLE}')\n` +
      `\n` +
      `pair_counts <- list()\n` +
      `for (skus in split(lines$sku, lines$order_id)) {\n` +
      `  skus <- sort(unique(skus))\n` +
      `  if (length(skus) >= 2) {\n` +
      `    combos <- combn(skus, 2, simplify = FALSE)\n` +
      `    for (pair in combos) {\n` +
      `      key <- paste(pair[1], pair[2], sep = '|')\n` +
      `      pair_counts[[key]] <- (if (is.null(pair_counts[[key]])) 0 else pair_counts[[key]]) + 1\n` +
      `    }\n` +
      `  }\n` +
      `}\n` +
      `\n` +
      `keys <- names(pair_counts)\n` +
      `counts <- unlist(pair_counts)\n` +
      `best_key <- keys[order(-counts, keys)][1]\n` +
      `parts <- strsplit(best_key, '\\\\|')[[1]]\n` +
      `result <- data.frame(pair_left = parts[1], pair_right = parts[2], order_count = pair_counts[[best_key]])\n` +
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

// ---------------------------------------------------------------
// Bundle 18 (archetypeDrillsExpand): extra-scalar golden checking.
// ---------------------------------------------------------------
// scoreDrillAnswer above (Bundle 16) scores every drill on the ONE scalar
// that is comparable across all three languages: rowCount (SQL reads it off
// the structured result; Python/R parse the "matched rows: N" line their
// starters print). The three archetype drills ALSO carry richer SQL-only
// goldens (SCD's totalRevenue/productCount, streak-islands' maxStreak/userId/
// islandCount, basket-pairs' pairLeft/pairRight/orderCount) for a caller
// (tests, or a future SQL-only detail view) that wants to check those too,
// against a caller-supplied observed value rather than by guessing a column
// name out of a raw DuckDB row shape (which is exactly what a fragile,
// column-name-guessing extractor would do). NUMERIC_EPSILON matches the
// float-compare discipline already used for the existing drills' sumAmount /
// totalOfKept / grandTotal goldens in test/bundle16-ledger-wiring-drill-battery.test.mjs.
const NUMERIC_EPSILON = 1e-6;

/**
 * Compare one golden scalar to an observed value. Numbers use an absolute
 * epsilon (matching the existing drill battery's float-compare pattern);
 * strings compare exact, case-sensitive, after trim; everything else is
 * strict equality. Never throws.
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
 * Score a SQL drill run's EXTRA golden scalars (everything in
 * goldenAnswers.sql besides rowCount) against a caller-supplied map of
 * observed values, e.g. `{ totalRevenue: 101018 }` computed by the caller
 * from its own query result. PURE, never throws. Returns pass:true with an
 * empty `fields` map for a drill/engine with no extra goldens to check
 * (nothing to fail on), and pass:false per-field for anything the caller
 * did not supply an observed value for.
 * @param {string} drillId
 * @param {{[key:string]: *}} observed
 * @returns {{pass:boolean, drillId:string, fields: {[key:string]: {expected:*, got:*, pass:boolean}}}}
 */
export function scoreDrillExtras(drillId, observed) {
  const drill = getDrill(drillId);
  const fields = {};
  if (!drill || !drill.goldenAnswers || !drill.goldenAnswers.sql) {
    return { pass: false, drillId: String(drillId), fields };
  }
  const golden = drill.goldenAnswers.sql;
  const obs = observed && typeof observed === 'object' ? observed : {};
  const extraKeys = Object.keys(golden).filter((k) => k !== 'rowCount');
  let allPass = true;
  for (const key of extraKeys) {
    const expectedVal = golden[key];
    const observedVal = obs[key];
    const fieldPass = scalarMatches(expectedVal, observedVal);
    fields[key] = { expected: expectedVal, got: observedVal, pass: fieldPass };
    if (!fieldPass) allPass = false;
  }
  return { pass: allPass, drillId, fields };
}
