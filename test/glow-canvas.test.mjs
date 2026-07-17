// ============================================================
// DATAGLOW — Glow Canvas test suite (multi-chart dashboard, Batch 1)
// ============================================================
// Proves the PURE layout algebra in js/runtimes-viz/glow-canvas.js:
//   - createCanvasLayout starts empty
//   - addCard appends, auto-assigns an incrementing id + a next-available-slot
//     gridPos, and is PURE (never mutates its input)
//   - removeCard / updateCardPosition are pure and id-targeted
//   - serialize/deserialize round-trip, incl. empty layout and the critical
//     edge case: malformed JSON -> safe empty layout, NEVER throws
//
// Only the pure functions are exercised here (renderCanvas is DOM-only and left
// to the browser/e2e path, exactly like room-ui.js's renderRoomUi).
//
// RUN WITH: node test/glow-canvas.test.mjs (pure logic, no DuckDB/DOM/Plotly)

import {
  CANVAS_CHART_TYPES,
  createCanvasLayout,
  addCard,
  removeCard,
  updateCardPosition,
  serializeLayout,
  deserializeLayout,
  setActiveFilter,
  clearActiveFilter,
  toggleFilter,
  filterWhereClause,
  renderCanvas,
} from '../js/runtimes-viz/glow-canvas.js';
import { combineWhere } from '../js/runtimes-viz/visualize.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- createCanvasLayout ----------
{
  const layout = createCanvasLayout();
  ok(Array.isArray(layout.cards) && layout.cards.length === 0, 'createCanvasLayout starts with an empty cards array');
  ok(layout.nextId === 1, 'createCanvasLayout starts nextId at 1');
}

// ---------- exported vocab ----------
ok(JSON.stringify(CANVAS_CHART_TYPES) === JSON.stringify(['bar', 'line', 'scatter', 'pie', 'histogram', 'box']),
  'CANVAS_CHART_TYPES is exactly the six Visualize chart types');

// ---------- addCard: append + auto id ----------
{
  const l0 = createCanvasLayout();
  const l1 = addCard(l0, { table: 'sales', chartType: 'bar', xCol: 'region', yCol: 'amount', title: 'Sales' });
  ok(l1.cards.length === 1, 'addCard appends one card');
  ok(l1.cards[0].id === 1, 'first card gets id 1');
  ok(l1.cards[0].table === 'sales' && l1.cards[0].chartType === 'bar', 'addCard carries the supplied fields');
  ok(l1.cards[0].xCol === 'region' && l1.cards[0].yCol === 'amount' && l1.cards[0].title === 'Sales', 'addCard carries x/y/title');
  ok(l1.nextId === 2, 'nextId advances after an add');

  // PURITY: the original layout must be untouched.
  ok(l0.cards.length === 0, 'addCard is pure — original layout is not mutated');
}

// ---------- addCard: auto gridPos across multiple cards (2-col grid packer) ----------
{
  let l = createCanvasLayout();
  l = addCard(l, { table: 'a' });
  l = addCard(l, { table: 'b' });
  l = addCard(l, { table: 'c' });
  ok(l.cards.length === 3, 'three cards added');
  ok(l.cards[0].id === 1 && l.cards[1].id === 2 && l.cards[2].id === 3, 'ids increment 1,2,3');
  const p = l.cards.map(c => c.gridPos);
  ok(p[0].row === 0 && p[0].col === 0, 'card 1 lands at row 0 col 0');
  ok(p[1].row === 0 && p[1].col === 1, 'card 2 lands at row 0 col 1 (fills the 2-wide row)');
  ok(p[2].row === 1 && p[2].col === 0, 'card 3 wraps to row 1 col 0');
  ok(p.every(g => g.w === 1 && g.h === 1), 'each auto card is 1x1 by default');
}

// ---------- addCard: an explicit gridPos is respected ----------
{
  const l = addCard(createCanvasLayout(), { table: 'x', gridPos: { row: 3, col: 1, w: 2, h: 2 } });
  ok(l.cards[0].gridPos.row === 3 && l.cards[0].gridPos.col === 1, 'explicit gridPos row/col honored');
  ok(l.cards[0].gridPos.w === 2 && l.cards[0].gridPos.h === 2, 'explicit gridPos w/h honored');
}

// ---------- addCard: safe defaults for a garbage/empty spec ----------
{
  const l = addCard(createCanvasLayout(), {});
  ok(l.cards[0].chartType === 'bar' && l.cards[0].table === '', 'empty spec gets safe defaults (bar / empty table)');
  const l2 = addCard(createCanvasLayout(), null);
  ok(l2.cards.length === 1, 'addCard with a null spec still appends a defaulted card, never throws');
}

// ---------- removeCard ----------
{
  let l = createCanvasLayout();
  l = addCard(l, { table: 'a' });
  l = addCard(l, { table: 'b' });
  const before = l;
  const l2 = removeCard(l, 1);
  ok(l2.cards.length === 1 && l2.cards[0].id === 2, 'removeCard removes exactly the targeted id');
  ok(before.cards.length === 2, 'removeCard is pure — original layout not mutated');
  const l3 = removeCard(l2, 999);
  ok(l3.cards.length === 1, 'removeCard of an unknown id leaves the cards unchanged');
  ok(l3.nextId === l2.nextId, 'removeCard preserves nextId so ids are never reused');
}

// ---------- updateCardPosition ----------
{
  let l = createCanvasLayout();
  l = addCard(l, { table: 'a' });
  l = addCard(l, { table: 'b' });
  const l2 = updateCardPosition(l, 2, { row: 5, col: 0, w: 2, h: 1 });
  const moved = l2.cards.find(c => c.id === 2);
  const untouched = l2.cards.find(c => c.id === 1);
  ok(moved.gridPos.row === 5 && moved.gridPos.col === 0 && moved.gridPos.w === 2, 'updateCardPosition replaces the targeted card gridPos');
  ok(untouched.gridPos.row === 0 && untouched.gridPos.col === 0, 'updateCardPosition leaves other cards untouched');
  ok(l.cards.find(c => c.id === 2).gridPos.row === 0, 'updateCardPosition is pure — original layout not mutated');

  // partial update falls back to the card's current values
  const l3 = updateCardPosition(l2, 2, { row: 9 });
  const m3 = l3.cards.find(c => c.id === 2);
  ok(m3.gridPos.row === 9 && m3.gridPos.col === 0 && m3.gridPos.w === 2, 'partial gridPos update keeps prior col/w');

  const l4 = updateCardPosition(l2, 12345, { row: 1 });
  ok(JSON.stringify(l4.cards) === JSON.stringify(l2.cards), 'updateCardPosition of an unknown id changes nothing');
}

// ---------- serialize / deserialize round-trip ----------
{
  let l = createCanvasLayout();
  l = addCard(l, { table: 'sales', chartType: 'line', xCol: 'month', yCol: 'total', title: 'Trend' });
  l = addCard(l, { table: 'ops', chartType: 'pie', xCol: 'team' });
  const json = serializeLayout(l);
  ok(typeof json === 'string', 'serializeLayout returns a string');
  const round = deserializeLayout(json);
  ok(JSON.stringify(round) === JSON.stringify(l), 'serialize -> deserialize round-trips the whole layout');
  ok(round.cards.length === 2 && round.nextId === 3, 'round-tripped layout keeps cards and nextId');
}

// ---------- empty-layout round-trip ----------
{
  const empty = createCanvasLayout();
  const round = deserializeLayout(serializeLayout(empty));
  ok(round.cards.length === 0 && round.nextId === 1, 'empty layout round-trips to an empty layout');
}

// ---------- EDGE CASE: malformed / hostile input -> safe empty layout, never throws ----------
{
  const cases = ['{not json', '', 'null', '[]', '"a string"', '42', '{"cards":"nope"}', undefined, 12345];
  let allSafe = true;
  for (const c of cases) {
    let r;
    try { r = deserializeLayout(c); } catch (_e) { allSafe = false; }
    if (!r || !Array.isArray(r.cards) || r.cards.length !== 0 || r.nextId !== 1) allSafe = false;
  }
  ok(allSafe, 'deserializeLayout returns a safe empty layout for every malformed input and NEVER throws');
}

// ---------- deserialize recovers nextId from cards if it is missing/stale ----------
{
  // A hand-crafted blob whose nextId is behind its card ids must be corrected so
  // a subsequent addCard can never collide with an existing id.
  const blob = JSON.stringify({ cards: [{ id: 7, table: 'x', chartType: 'bar', gridPos: { row: 0, col: 0, w: 1, h: 1 } }], nextId: 2 });
  const l = deserializeLayout(blob);
  ok(l.nextId === 8, 'deserialize repairs nextId to be greater than the max existing card id');
  const l2 = addCard(l, { table: 'y' });
  ok(l2.cards[1].id === 8, 'the next added card gets a non-colliding id after repair');
}

// ============================================================
// BATCH 2 — cross-filtering
// ============================================================

// ---------- createCanvasLayout carries a null activeFilter ----------
{
  const l = createCanvasLayout();
  ok(l.activeFilter === null, 'a fresh layout has activeFilter === null');
}

// ---------- setActiveFilter: sets + is pure + normalizes ----------
{
  const l0 = createCanvasLayout();
  const l1 = setActiveFilter(l0, { table: 'sales', column: 'region', value: 'West' });
  ok(l1.activeFilter && l1.activeFilter.table === 'sales' && l1.activeFilter.column === 'region' && l1.activeFilter.value === 'West',
    'setActiveFilter stores the {table, column, value} filter');
  ok(l0.activeFilter === null, 'setActiveFilter is pure — original layout untouched');

  // value is coerced to a string (DuckDB categories can come back as numbers).
  const l2 = setActiveFilter(l0, { table: 't', column: 'yr', value: 2024 });
  ok(l2.activeFilter.value === '2024', 'setActiveFilter coerces a numeric value to a string');

  // garbage / partial filters normalize to null and never throw.
  ok(setActiveFilter(l0, null).activeFilter === null, 'setActiveFilter(null) clears to null');
  ok(setActiveFilter(l0, { column: 'x', value: 'y' }).activeFilter === null, 'a filter missing table normalizes to null');
  ok(setActiveFilter(l0, { table: 't', column: 'c' }).activeFilter === null, 'a filter missing value normalizes to null');
}

// ---------- clearActiveFilter: clears + is pure + keeps cards ----------
{
  let l = createCanvasLayout();
  l = addCard(l, { table: 'sales', chartType: 'bar', xCol: 'region' });
  const filtered = setActiveFilter(l, { table: 'sales', column: 'region', value: 'West' });
  const cleared = clearActiveFilter(filtered);
  ok(cleared.activeFilter === null, 'clearActiveFilter removes the active filter');
  ok(cleared.cards.length === 1 && cleared.cards[0].table === 'sales', 'clearActiveFilter preserves the cards');
  ok(filtered.activeFilter !== null, 'clearActiveFilter is pure — original (filtered) layout untouched');
}

// ---------- toggleFilter: sets when new, clears when identical ----------
{
  const base = createCanvasLayout();
  const f = { table: 'sales', column: 'region', value: 'West' };
  const on = toggleFilter(base, f);
  ok(on.activeFilter && on.activeFilter.value === 'West', 'toggleFilter sets the filter when none is active');

  // clicking the SAME point again toggles OFF.
  const off = toggleFilter(on, f);
  ok(off.activeFilter === null, 'toggleFilter clears when the identical filter is re-applied (click-toggle-off)');

  // a DIFFERENT value replaces (does not clear).
  const other = toggleFilter(on, { table: 'sales', column: 'region', value: 'East' });
  ok(other.activeFilter && other.activeFilter.value === 'East', 'toggleFilter replaces with a different value');

  // a different column on the same value also replaces.
  const otherCol = toggleFilter(on, { table: 'sales', column: 'city', value: 'West' });
  ok(otherCol.activeFilter && otherCol.activeFilter.column === 'city', 'toggleFilter replaces with a different column');

  ok(base.activeFilter === null && on.activeFilter.value === 'West', 'toggleFilter is pure — inputs untouched');
}

// ---------- activeFilter round-trips through serialize/deserialize ----------
{
  let l = createCanvasLayout();
  l = addCard(l, { table: 'sales', chartType: 'bar', xCol: 'region' });
  l = setActiveFilter(l, { table: 'sales', column: 'region', value: "O'Brien" });
  const round = deserializeLayout(serializeLayout(l));
  ok(round.activeFilter && round.activeFilter.value === "O'Brien", 'activeFilter (incl. a quote in the value) survives a serialize -> deserialize round-trip');
  ok(JSON.stringify(round) === JSON.stringify(l), 'a filtered layout round-trips byte-for-byte');

  // a stored blob with a garbage activeFilter deserializes to null, never throws.
  const blob = JSON.stringify({ cards: [], nextId: 1, activeFilter: { nope: true } });
  ok(deserializeLayout(blob).activeFilter === null, 'a garbage stored activeFilter normalizes to null on load');
}

// ---------- filterWhereClause: same-table filters, other-table does not ----------
{
  let l = createCanvasLayout();
  l = addCard(l, { table: 'sales', chartType: 'bar', xCol: 'region' }); // id 1
  l = addCard(l, { table: 'ops', chartType: 'pie', xCol: 'team' });     // id 2
  const salesCard = l.cards[0];
  const opsCard = l.cards[1];

  ok(filterWhereClause(l, salesCard) === '', 'no active filter -> empty whereClause');

  const lf = setActiveFilter(l, { table: 'sales', column: 'region', value: 'West' });
  ok(filterWhereClause(lf, salesCard) === `"region" = 'West'`, 'same-table card gets the constructed whereClause');
  ok(filterWhereClause(lf, opsCard) === '', 'different-table card is NOT filtered (no join-key model yet)');

  // single-quote escaping (SQL-injection-style value is neutralized).
  const linj = setActiveFilter(l, { table: 'sales', column: 'region', value: "x' OR '1'='1" });
  ok(filterWhereClause(linj, salesCard) === `"region" = 'x'' OR ''1''=''1'`, 'single quotes in the value are doubled (escaped) so the literal cannot break out');

  // double-quote in the column identifier is doubled.
  const lcol = setActiveFilter(l, { table: 'sales', column: 'we"ird', value: 'v' });
  ok(filterWhereClause(lcol, salesCard) === `"we""ird" = 'v'`, 'double quotes in the column identifier are doubled (escaped)');
}

// ---------- combineWhere (visualize.js): backward-compatible SQL splicing ----------
{
  ok(combineWhere('', undefined) === '', 'no existing condition + no clause -> empty (5-arg callers unchanged)');
  ok(combineWhere('', '') === '', 'empty existing + empty clause -> empty');
  ok(combineWhere(`"x" IS NOT NULL`, undefined) === ` WHERE "x" IS NOT NULL`, 'existing condition alone -> " WHERE cond" (histogram/box/scatter unchanged when unfiltered)');
  ok(combineWhere('', `"region" = 'West'`) === ` WHERE "region" = 'West'`, 'clause alone (bar/line/pie) -> " WHERE clause"');
  ok(combineWhere(`"x" IS NOT NULL`, `"region" = 'West'`) === ` WHERE "x" IS NOT NULL AND "region" = 'West'`, 'existing condition AND new clause are combined');
  ok(combineWhere('   ', '   ') === '', 'whitespace-only inputs are treated as empty');
}

// ---------- renderCanvas forwards the whereClause + onPointClick to renderChart ----------
// The one DOM-touching test: a minimal document shim (no jsdom dep) lets us drive
// renderCanvas with an injected FAKE renderChart (opts.renderChart) and assert on
// the exact SQL/args each card is drawn with. Only the surface el()/renderCanvas
// actually use is stubbed.
{
  const registry = {};
  function makeEl(tag) {
    return {
      tagName: tag, children: [], attributes: {}, style: {}, _listeners: {},
      className: '', innerHTML: '', textContent: '', value: '',
      setAttribute(k, v) { this.attributes[k] = v; if (k === 'id') registry[v] = this; },
      getAttribute(k) { return this.attributes[k]; },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      appendChild(c) { this.children.push(c); return c; },
    };
  }
  const host = makeEl('div');
  registry.host = host;
  global.document = {
    createElement: makeEl,
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById: (id) => registry[id] || null,
  };

  let l = createCanvasLayout();
  l = addCard(l, { table: 'sales', chartType: 'bar', xCol: 'region', yCol: 'amount' }); // id 1
  l = addCard(l, { table: 'ops', chartType: 'pie', xCol: 'team' });                     // id 2
  l = setActiveFilter(l, { table: 'sales', column: 'region', value: 'West' });

  const calls = [];
  const fakeRenderChart = (...args) => { calls.push(args); return Promise.resolve(); };
  renderCanvas('host', l, { renderChart: fakeRenderChart, datasets: [], onChange: () => {} });

  // renderChart is invoked in a microtask (Promise.resolve().then(...)).
  await new Promise((r) => setTimeout(r, 0));

  ok(calls.length === 2, 'renderCanvas draws both cards via the injected renderChart');
  const salesCall = calls.find((a) => a[1] === 'sales');
  const opsCall = calls.find((a) => a[1] === 'ops');
  // arg order: (containerId, table, chartType, xCol, yCol, whereClause, opts)
  ok(salesCall && salesCall[5] === `"region" = 'West'`, 'the same-table (sales) card is drawn with the cross-filter whereClause');
  ok(opsCall && opsCall[5] === '', 'the different-table (ops) card is drawn with an empty whereClause');
  ok(salesCall && salesCall[6] && typeof salesCall[6].onPointClick === 'function', 'renderChart receives a generic onPointClick callback in opts');

  // the onPointClick wired in emits a toggled layout (click-to-cross-filter).
  let emitted = null;
  renderCanvas('host', l, { renderChart: fakeRenderChart, datasets: [], onChange: (next) => { emitted = next; } });
  await new Promise((r) => setTimeout(r, 0));
  const salesCall2 = calls.filter((a) => a[1] === 'sales').pop();
  // clicking the SAME active point toggles the filter OFF.
  salesCall2[6].onPointClick('sales', 'region', 'West');
  ok(emitted && emitted.activeFilter === null, 'clicking the already-active point via onPointClick toggles the filter off');

  delete global.document;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
