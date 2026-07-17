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
} from '../js/runtimes-viz/glow-canvas.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
