// ============================================================
// DATAGLOW - Drill Floor: sample dataset (Batch 1 of N)
// ============================================================
// WHAT THIS IS: the deterministic, self-contained practice dataset for the
// Drill Floor module, an original DataGlow practice format where the SAME real
// problem is solved side-by-side in SQL, Python, and R. Batch 1 shipped one
// drill, "Spot the Sale", join a `promos` table to an `orders` table where an
// order's date falls BETWEEN a promo's start/end date (inclusive). Bundle 16
// adds three more drills against these SAME two tables. Every row here is
// DataGlow's own generated data (seeded PRNG below); this is not a
// redistribution of any third-party practice dataset, and none of the drill
// question text is copied from any external product.
//
// Identity split (same convention as js/runtimes-viz/glow-canvas.js): the row
// generation (generateOrders / generatePromos) and SQL builders (sqlLiteral /
// buildCreateTableSql) are PURE, deterministic (seeded PRNG), and Node-testable
// with no DB or DOM dependency. Only loadDrillTables() has a side effect: it
// runs CREATE OR REPLACE TABLE against the injected engine.runQuery, and it is
// kept deliberately thin so the interesting logic stays in the pure layer.
//
// The generated tables use dedicated names (drill_orders / drill_promos) so they
// never collide with or overwrite the user's own loaded dataset tables. Data is
// read-only practice data; nothing here persists across sessions.

// Dedicated table names, namespaced so they can never clash with a user table.
export const DRILL_ORDERS_TABLE = 'drill_orders';
export const DRILL_PROMOS_TABLE = 'drill_promos';

// Bundle 18 (archetypeDrillsExpand): three more dedicated tables for the three
// original archetype drills below (SCD/as-of, gaps-and-islands streaks, basket
// co-occurrence). Same rules as the pair above: DataGlow's own generated rows,
// namespaced names, nothing here is a redistribution of any third-party dataset.
export const DRILL_PRICE_HISTORY_TABLE = 'drill_price_history';
export const DRILL_SALES_TABLE = 'drill_sales';
export const DRILL_ACTIVITY_DAYS_TABLE = 'drill_activity_days';
export const DRILL_BASKET_LINES_TABLE = 'drill_basket_lines';

// A tiny deterministic PRNG (mulberry32) so the sample data is byte-identical on
// every run and every machine; the tests assert on exact row counts and values.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Add `days` calendar days to an ISO 'YYYY-MM-DD' date, returning ISO. Uses UTC
// throughout so results never shift with the runner's local timezone.
function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ORDER_START = '2024-01-01'; // first possible order date
const ORDER_SPAN_DAYS = 364;      // orders fall within a single calendar year
const CHANNELS = ['web', 'store', 'phone', 'partner'];
const PROMO_NAMES = [
  'New Year Kickoff', 'Winter Clearance', 'Spring Refresh', 'Easter Weekend',
  'Mother\'s Day', 'Summer Splash', 'Back to School', 'Labor Day',
  'Fall Harvest', 'Halloween Spooktacular', 'Black Friday', 'Cyber Monday',
  'Holiday Countdown', 'Year-End Blowout', 'Flash Friday', 'Loyalty Bonus',
  'Clearance Corner', 'Weekend Warrior', 'Midweek Markdown', 'Grand Reopening',
];

/**
 * Deterministic sample orders. Each order is a plain JSON-safe object:
 * { order_id, order_date (ISO), customer_id, channel, amount }.
 * Pure: same seed + count always yields the identical array.
 * @param {number} [count=300]
 * @param {number} [seed=1337]
 * @returns {Array<object>}
 */
export function generateOrders(count = 300, seed = 1337) {
  const rand = mulberry32(seed);
  const orders = [];
  for (let i = 0; i < count; i++) {
    const dayOffset = Math.floor(rand() * (ORDER_SPAN_DAYS + 1));
    const order_date = addDays(ORDER_START, dayOffset);
    const customer_id = 1000 + Math.floor(rand() * 200);
    const channel = CHANNELS[Math.floor(rand() * CHANNELS.length)];
    const amount = Math.round((5 + rand() * 495) * 100) / 100;
    orders.push({
      order_id: 1 + i,
      order_date,
      customer_id,
      channel,
      amount,
    });
  }
  return orders;
}

/**
 * Deterministic sample promos with realistic overlapping and boundary-adjacent
 * date ranges so the BETWEEN join is meaningful (some orders land exactly on a
 * start_date or end_date, some promos overlap, some gaps have no promo). Each
 * promo: { promo_id, promo_name, start_date (ISO), end_date (ISO), discount_pct }.
 * Pure: same seed + count always yields the identical array.
 * @param {number} [count=14]
 * @param {number} [seed=4242]
 * @returns {Array<object>}
 */
export function generatePromos(count = 14, seed = 4242) {
  const rand = mulberry32(seed);
  const promos = [];
  // Walk forward through the year, placing each promo after the previous one
  // with an occasional backward nudge so ranges overlap sometimes.
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const overlapNudge = rand() < 0.35 ? -Math.floor(rand() * 6) : Math.floor(rand() * 20);
    cursor = Math.max(0, cursor + overlapNudge);
    const start_date = addDays(ORDER_START, cursor);
    const length = 3 + Math.floor(rand() * 12); // 3–14 day promos
    const end_date = addDays(start_date, length);
    const discount_pct = 5 + Math.floor(rand() * 6) * 5; // 5..30 in steps of 5
    promos.push({
      promo_id: 1 + i,
      promo_name: PROMO_NAMES[i % PROMO_NAMES.length],
      start_date,
      end_date,
      discount_pct,
    });
    cursor += length + 1; // advance past this promo before the next placement
  }
  return promos;
}

// Render a JS value as a SQL literal. Strings are single-quoted with embedded
// single quotes doubled (SQL-standard escaping); numbers pass through; null/undef
// become NULL. Mirrors the escaping discipline in glow-canvas.js filterWhereClause.
export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Build a single atomic CREATE OR REPLACE TABLE statement for a set of rows.
 * Columns are taken from `columnDefs` (ordered [{name, type}]) and every row is
 * emitted as a VALUES tuple in that column order. Pure; returns SQL text only.
 * @param {string} tableName
 * @param {Array<{name:string,type:string}>} columnDefs
 * @param {Array<object>} rows
 * @returns {string}
 */
export function buildCreateTableSql(tableName, columnDefs, rows) {
  const cols = columnDefs.map((c) => `"${c.name.replace(/"/g, '""')}" ${c.type}`).join(', ');
  const tuples = rows
    .map((row) => '(' + columnDefs.map((c) => sqlLiteral(row[c.name])).join(', ') + ')')
    .join(',\n  ');
  const colNames = columnDefs.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(', ');
  return (
    `CREATE OR REPLACE TABLE "${tableName}" (${cols});\n` +
    `INSERT INTO "${tableName}" (${colNames}) VALUES\n  ${tuples};`
  );
}

// ------------------------------------------------------------------
// Bundle 18 (archetypeDrillsExpand): three original archetype drills.
// ------------------------------------------------------------------
// Same identity split as above: every generator below is PURE and
// deterministic (seeded mulberry32), Node-testable with no DB/DOM. Only the
// loadDrillTables() extension at the bottom has a side effect.

// ---- Drill 1 data: scd-as-of (price history + sales) ----------------------
const PRICE_HISTORY_START = '2024-01-01';

/**
 * Deterministic SCD Type-2-style price history: several non-overlapping
 * [valid_from, valid_to] segments per product, prices stepping up or down
 * between segments. Pure: same seed + productCount always yields the
 * identical array.
 * @param {number} [productCount=6]
 * @param {number} [seed=5151]
 * @returns {Array<object>} { history_id, product_id, price, valid_from, valid_to }
 */
export function generatePriceHistory(productCount = 6, seed = 5151) {
  const rand = mulberry32(seed);
  const rows = [];
  let historyId = 1;
  for (let p = 1; p <= productCount; p++) {
    let cursor = 0;
    const segments = 3 + Math.floor(rand() * 3); // 3..5 segments per product
    let price = 10 + Math.floor(rand() * 40); // starting price 10..49
    for (let s = 0; s < segments; s++) {
      const length = 20 + Math.floor(rand() * 60); // 20..79 day validity window
      const valid_from = addDays(PRICE_HISTORY_START, cursor);
      const valid_to = addDays(PRICE_HISTORY_START, cursor + length - 1);
      rows.push({ history_id: historyId++, product_id: p, price, valid_from, valid_to });
      const delta = (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 8));
      price = Math.max(1, price + delta);
      cursor += length;
    }
  }
  return rows;
}

/**
 * Deterministic sample sales, some of which deliberately fall a little
 * before the first price segment or after the last (so the as-of join has
 * genuine unmatched rows rather than a trivially-total match). Pure: same
 * priceHistory + seed + count always yields the identical array.
 * @param {Array<object>} priceHistory from generatePriceHistory()
 * @param {number} [count=400]
 * @param {number} [seed=9191]
 * @returns {Array<object>} { sale_id, product_id, sale_date, units }
 */
export function generateSales(priceHistory, count = 400, seed = 9191) {
  const rand = mulberry32(seed);
  const productIds = [...new Set(priceHistory.map((r) => r.product_id))];
  const minDate = priceHistory.reduce((m, r) => (r.valid_from < m ? r.valid_from : m), priceHistory[0].valid_from);
  const maxDate = priceHistory.reduce((m, r) => (r.valid_to > m ? r.valid_to : m), priceHistory[0].valid_to);
  const spanDays = Math.round((new Date(maxDate + 'T00:00:00Z') - new Date(minDate + 'T00:00:00Z')) / 86400000);
  const sales = [];
  for (let i = 0; i < count; i++) {
    const product_id = productIds[Math.floor(rand() * productIds.length)];
    // +-10 day slop beyond the covered range so some sales are unmatched.
    const dayOffset = Math.floor(rand() * (spanDays + 21)) - 10;
    const sale_date = addDays(minDate, dayOffset);
    const units = 1 + Math.floor(rand() * 20);
    sales.push({ sale_id: 1 + i, product_id, sale_date, units });
  }
  return sales;
}

// ---- Drill 2 data: streak-islands (daily activity log) --------------------
const ACTIVITY_DAYS_START = '2024-01-01';
const ACTIVITY_WINDOW_DAYS = 150;
const ACTIVITY_MAX_RUN_LEN = 9;

/**
 * Deterministic daily activity log: for each user, a sequence of
 * consecutive-day "runs" separated by 1-5 day gaps across a 150-day window.
 * Pure: same seed + userCount always yields the identical array.
 * @param {number} [userCount=6]
 * @param {number} [seed=7171]
 * @returns {Array<object>} { user_id, activity_date }
 */
export function generateActivityDays(userCount = 6, seed = 7171) {
  const rand = mulberry32(seed);
  const rows = [];
  for (let u = 1; u <= userCount; u++) {
    let cursor = 0;
    while (cursor < ACTIVITY_WINDOW_DAYS) {
      const gap = 1 + Math.floor(rand() * 5);
      cursor += gap;
      if (cursor >= ACTIVITY_WINDOW_DAYS) break;
      const runLen = 1 + Math.floor(rand() * ACTIVITY_MAX_RUN_LEN);
      for (let d = 0; d < runLen && cursor < ACTIVITY_WINDOW_DAYS; d++, cursor++) {
        rows.push({ user_id: u, activity_date: addDays(ACTIVITY_DAYS_START, cursor) });
      }
      cursor += 1; // at least a 1-day gap before the next run
    }
  }
  return rows;
}

// ---- Drill 3 data: basket-pairs (order line items) -------------------------
const BASKET_SKUS = ['SKU-A', 'SKU-B', 'SKU-C', 'SKU-D', 'SKU-E', 'SKU-F', 'SKU-G', 'SKU-H'];

/**
 * Deterministic order line items: each order gets 2-5 DISTINCT SKUs (no
 * duplicate lines within an order), drawn from a fixed 8-SKU catalog so
 * co-occurrence pairs are meaningful. Pure: same seed + orderCount always
 * yields the identical array.
 * @param {number} [orderCount=250]
 * @param {number} [seed=3131]
 * @returns {Array<object>} { order_id, sku }
 */
export function generateBasketLines(orderCount = 250, seed = 3131) {
  const rand = mulberry32(seed);
  const rows = [];
  for (let o = 1; o <= orderCount; o++) {
    const lineCount = 2 + Math.floor(rand() * 4); // 2..5 distinct lines per order
    const chosen = new Set();
    while (chosen.size < lineCount) {
      chosen.add(BASKET_SKUS[Math.floor(rand() * BASKET_SKUS.length)]);
    }
    for (const sku of chosen) rows.push({ order_id: o, sku });
  }
  return rows;
}

// Column definitions for the three Bundle 18 drill tables (typed for DuckDB).
export const PRICE_HISTORY_COLUMNS = [
  { name: 'history_id', type: 'INTEGER' },
  { name: 'product_id', type: 'INTEGER' },
  { name: 'price', type: 'DOUBLE' },
  { name: 'valid_from', type: 'DATE' },
  { name: 'valid_to', type: 'DATE' },
];
export const SALES_COLUMNS = [
  { name: 'sale_id', type: 'INTEGER' },
  { name: 'product_id', type: 'INTEGER' },
  { name: 'sale_date', type: 'DATE' },
  { name: 'units', type: 'INTEGER' },
];
export const ACTIVITY_DAYS_COLUMNS = [
  { name: 'user_id', type: 'INTEGER' },
  { name: 'activity_date', type: 'DATE' },
];
export const BASKET_LINES_COLUMNS = [
  { name: 'order_id', type: 'INTEGER' },
  { name: 'sku', type: 'VARCHAR' },
];

// Column definitions for the two drill tables (typed for DuckDB).
export const ORDERS_COLUMNS = [
  { name: 'order_id', type: 'INTEGER' },
  { name: 'order_date', type: 'DATE' },
  { name: 'customer_id', type: 'INTEGER' },
  { name: 'channel', type: 'VARCHAR' },
  { name: 'amount', type: 'DOUBLE' },
];
export const PROMOS_COLUMNS = [
  { name: 'promo_id', type: 'INTEGER' },
  { name: 'promo_name', type: 'VARCHAR' },
  { name: 'start_date', type: 'DATE' },
  { name: 'end_date', type: 'DATE' },
  { name: 'discount_pct', type: 'INTEGER' },
];

/**
 * Load the drill's sample data into DuckDB as two dedicated temp tables, reusing
 * the existing engine.runQuery bridge (this module invents no new DB path). This
 * is the ONLY function here with a side effect. It returns lightweight dataset
 * descriptors ({name, table, rowCount, cols}) so the caller can register them for
 * the Python/R bridges without disturbing the user's own datasets/active table.
 * @param {{runQuery: (sql:string)=>Promise<any>}} deps injected DB engine
 * @param {{orders?: Array<object>, promos?: Array<object>}} [data] optional
 *        pre-generated rows (defaults to the deterministic generators)
 * @returns {Promise<Array<{name:string,table:string,rowCount:number,cols:string[]}>>}
 */
export async function loadDrillTables({ runQuery }, data = {}) {
  const orders = data.orders || generateOrders();
  const promos = data.promos || generatePromos();
  await runQuery(buildCreateTableSql(DRILL_ORDERS_TABLE, ORDERS_COLUMNS, orders));
  await runQuery(buildCreateTableSql(DRILL_PROMOS_TABLE, PROMOS_COLUMNS, promos));

  // Bundle 18 (archetypeDrillsExpand): the three new archetype drill tables,
  // loaded the same way, additively. Callers that only need the original two
  // (Batch 1 / Bundle 16 drills) are unaffected: these four extra tables are
  // simply also present afterward.
  const priceHistory = data.priceHistory || generatePriceHistory();
  const sales = data.sales || generateSales(priceHistory);
  const activityDays = data.activityDays || generateActivityDays();
  const basketLines = data.basketLines || generateBasketLines();
  await runQuery(buildCreateTableSql(DRILL_PRICE_HISTORY_TABLE, PRICE_HISTORY_COLUMNS, priceHistory));
  await runQuery(buildCreateTableSql(DRILL_SALES_TABLE, SALES_COLUMNS, sales));
  await runQuery(buildCreateTableSql(DRILL_ACTIVITY_DAYS_TABLE, ACTIVITY_DAYS_COLUMNS, activityDays));
  await runQuery(buildCreateTableSql(DRILL_BASKET_LINES_TABLE, BASKET_LINES_COLUMNS, basketLines));

  return [
    {
      name: DRILL_ORDERS_TABLE,
      table: DRILL_ORDERS_TABLE,
      rowCount: orders.length,
      cols: ORDERS_COLUMNS.map((c) => c.name),
    },
    {
      name: DRILL_PROMOS_TABLE,
      table: DRILL_PROMOS_TABLE,
      rowCount: promos.length,
      cols: PROMOS_COLUMNS.map((c) => c.name),
    },
    {
      name: DRILL_PRICE_HISTORY_TABLE,
      table: DRILL_PRICE_HISTORY_TABLE,
      rowCount: priceHistory.length,
      cols: PRICE_HISTORY_COLUMNS.map((c) => c.name),
    },
    {
      name: DRILL_SALES_TABLE,
      table: DRILL_SALES_TABLE,
      rowCount: sales.length,
      cols: SALES_COLUMNS.map((c) => c.name),
    },
    {
      name: DRILL_ACTIVITY_DAYS_TABLE,
      table: DRILL_ACTIVITY_DAYS_TABLE,
      rowCount: activityDays.length,
      cols: ACTIVITY_DAYS_COLUMNS.map((c) => c.name),
    },
    {
      name: DRILL_BASKET_LINES_TABLE,
      table: DRILL_BASKET_LINES_TABLE,
      rowCount: basketLines.length,
      cols: BASKET_LINES_COLUMNS.map((c) => c.name),
    },
  ];
}
