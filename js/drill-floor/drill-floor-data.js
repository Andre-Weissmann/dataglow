// ============================================================
// DATAGLOW — Drill Floor: sample dataset (Batch 1 of N)
// ============================================================
// WHAT THIS IS: the deterministic, self-contained practice dataset for the
// Drill Floor module (Maven Analytics "Data Drill" format), where the SAME real
// problem is solved side-by-side in SQL, Python, and R. Batch 1 ships one drill,
// "Spot the Sale" — join a `promos` table to an `orders` table where an order's
// date falls BETWEEN a promo's start/end date (inclusive) — so the module needs
// its own bundled data rather than assuming the user has loaded matching tables.
//
// Identity split (same convention as js/runtimes-viz/glow-canvas.js): the row
// generation (generateOrders / generatePromos) and SQL builders (sqlLiteral /
// buildCreateTableSql) are PURE, deterministic (seeded PRNG), and Node-testable
// with no DB or DOM dependency. Only loadDrillTables() has a side effect — it
// runs CREATE OR REPLACE TABLE against the injected engine.runQuery — and it is
// kept deliberately thin so the interesting logic stays in the pure layer.
//
// The generated tables use dedicated names (drill_orders / drill_promos) so they
// never collide with or overwrite the user's own loaded dataset tables. Data is
// read-only practice data; nothing here persists across sessions.

// Dedicated table names — namespaced so they can never clash with a user table.
export const DRILL_ORDERS_TABLE = 'drill_orders';
export const DRILL_PROMOS_TABLE = 'drill_promos';

// A tiny deterministic PRNG (mulberry32) so the sample data is byte-identical on
// every run and every machine — the tests assert on exact row counts and values.
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
 * emitted as a VALUES tuple in that column order. Pure — returns SQL text only.
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
  ];
}
