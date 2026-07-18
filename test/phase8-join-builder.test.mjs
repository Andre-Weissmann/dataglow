// ============================================================
// DataGlow Phase 8 — Join Builder Tests
// ============================================================
// Tests for join-model.js (pure graph mutations) and join-sql.js
// (SQL generation). No DOM, no DuckDB — fully runnable in Node.
//
// Run: node test/phase8-join-builder.test.mjs
// ============================================================

import {
  createJoinGraph,
  addCard, removeCard, moveCard, getCard, getCardByTable,
  addEdge, removeEdge, setEdgeType, edgesForCard,
  validateGraph, serializeGraph, deserializeGraph,
  autoCardPos, JOIN_TYPES, _resetIdCounter,
} from '../js/join-builder/join-model.js';

import {
  generateJoinSQL, generatePreviewSQL, suggestJoinColumns,
} from '../js/join-builder/join-sql.js';

// ---- Minimal test harness ----
let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) {
    console.log(`  ok  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function throws(fn, label) {
  try { fn(); console.error(`  FAIL  ${label} (expected throw, got none)`); failed++; }
  catch (_) { console.log(`  ok  ${label}`); passed++; }
}

function section(title) { console.log(`\n--- ${title} ---`); }

// ---- Helpers ----
const COLS_ENC = [
  { name: 'encounter_id', type: 'INTEGER' },
  { name: 'patient_id', type: 'INTEGER' },
  { name: 'admit_date', type: 'DATE' },
  { name: 'discharge_date', type: 'DATE' },
];
const COLS_PAT = [
  { name: 'patient_id', type: 'INTEGER' },
  { name: 'first_name', type: 'VARCHAR' },
  { name: 'last_name', type: 'VARCHAR' },
  { name: 'dob', type: 'DATE' },
];
const COLS_LAB = [
  { name: 'lab_id', type: 'INTEGER' },
  { name: 'encounter_id', type: 'INTEGER' },
  { name: 'test_code', type: 'VARCHAR' },
  { name: 'result', type: 'DECIMAL(18,3)' },
];

function freshGraph() {
  _resetIdCounter();
  return createJoinGraph();
}

// ============================================================
// 1. Join Model — card operations
// ============================================================
section('1. Card operations');

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  ok(g.cards.length === 1, 'addCard creates one card');
  ok(g.cards[0].table === 'encounters', 'card has correct table name');
  ok(g.cards[0].cols.length === 4, 'card has correct column count');
  ok(g.cards[0].id.startsWith('card_'), 'card id has card_ prefix');
  ok(typeof g.cards[0].pos.x === 'number', 'card has numeric x position');
  ok(typeof g.cards[0].pos.y === 'number', 'card has numeric y position');
}

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  throws(() => addCard(g, { table: 'encounters', cols: COLS_ENC }), 'duplicate table throws');
}

{
  throws(() => addCard(freshGraph(), {}), 'missing table name throws');
}

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  g = addCard(g, { table: 'patients', cols: COLS_PAT });
  const card2 = g.cards[1];
  g = removeCard(g, card2.id);
  ok(g.cards.length === 1, 'removeCard reduces card count');
  ok(g.cards[0].table === 'encounters', 'correct card remains after removal');
}

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  g = addCard(g, { table: 'patients', cols: COLS_PAT });
  const c1 = g.cards[0];
  const c2 = g.cards[1];
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });
  ok(g.edges.length === 1, 'edge created before card removal');
  g = removeCard(g, c1.id);
  ok(g.edges.length === 0, 'edges to removed card are also removed');
}

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  const cardId = g.cards[0].id;
  g = moveCard(g, cardId, { x: 200, y: 350 });
  ok(g.cards[0].pos.x === 200, 'moveCard updates x');
  ok(g.cards[0].pos.y === 350, 'moveCard updates y');
}

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  const found = getCard(g, g.cards[0].id);
  ok(found !== null && found.table === 'encounters', 'getCard returns correct card');
  ok(getCard(g, 'nonexistent') === null, 'getCard returns null for missing id');
}

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  const found = getCardByTable(g, 'encounters');
  ok(found !== null, 'getCardByTable finds existing table');
  ok(getCardByTable(g, 'patients') === null, 'getCardByTable returns null for missing table');
}

// ============================================================
// 2. Join Model — edge operations
// ============================================================
section('2. Edge operations');

function graphWithTwoCards() {
  let g = createJoinGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  g = addCard(g, { table: 'patients', cols: COLS_PAT });
  return g;
}

{
  let g = graphWithTwoCards();
  const [c1, c2] = g.cards;
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });
  ok(g.edges.length === 1, 'addEdge creates one edge');
  ok(g.edges[0].type === 'INNER', 'default join type is INNER');
  ok(g.edges[0].id.startsWith('edge_'), 'edge id has edge_ prefix');
}

{
  let g = graphWithTwoCards();
  const [c1, c2] = g.cards;
  throws(
    () => addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c1.id, col: 'encounter_id' } }),
    'self-join throws'
  );
}

{
  let g = graphWithTwoCards();
  const [c1, c2] = g.cards;
  throws(
    () => addEdge(g, { from: { cardId: c1.id, col: 'nonexistent' }, to: { cardId: c2.id, col: 'patient_id' } }),
    'unknown from column throws'
  );
}

{
  let g = graphWithTwoCards();
  const [c1, c2] = g.cards;
  throws(
    () => addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'nonexistent' } }),
    'unknown to column throws'
  );
}

{
  let g = graphWithTwoCards();
  const [c1, c2] = g.cards;
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });
  throws(
    () => addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } }),
    'duplicate edge throws'
  );
  // Reversed direction also duplicate
  throws(
    () => addEdge(g, { from: { cardId: c2.id, col: 'patient_id' }, to: { cardId: c1.id, col: 'patient_id' } }),
    'reversed duplicate edge throws'
  );
}

{
  let g = graphWithTwoCards();
  const [c1, c2] = g.cards;
  throws(
    () => addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' }, type: 'CROSS' }),
    'invalid join type throws'
  );
}

{
  let g = graphWithTwoCards();
  const [c1, c2] = g.cards;
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' }, type: 'LEFT' });
  ok(g.edges[0].type === 'LEFT', 'explicit join type is respected');
}

{
  let g = graphWithTwoCards();
  const [c1, c2] = g.cards;
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });
  const edgeId = g.edges[0].id;
  g = setEdgeType(g, edgeId, 'RIGHT');
  ok(g.edges[0].type === 'RIGHT', 'setEdgeType updates join type');
}

{
  throws(
    () => {
      let g = graphWithTwoCards();
      const [c1, c2] = g.cards;
      g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });
      setEdgeType(g, g.edges[0].id, 'INVALID');
    },
    'setEdgeType with invalid type throws'
  );
}

{
  let g = graphWithTwoCards();
  const [c1, c2] = g.cards;
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });
  const edgeId = g.edges[0].id;
  g = removeEdge(g, edgeId);
  ok(g.edges.length === 0, 'removeEdge deletes the edge');
}

{
  let g = graphWithTwoCards();
  const [c1, c2] = g.cards;
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });
  const edges = edgesForCard(g, c1.id);
  ok(edges.length === 1, 'edgesForCard returns edges involving the card');
  ok(edgesForCard(g, 'unknown').length === 0, 'edgesForCard returns empty for unknown card');
}

// ============================================================
// 3. Join Model — graph validation
// ============================================================
section('3. Graph validation');

{
  const g = freshGraph();
  const problems = validateGraph(g);
  ok(problems.length > 0, 'empty graph has problems');
}

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  const problems = validateGraph(g);
  ok(problems.length === 0, 'single card with no edges is valid (simple SELECT)');
}

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  g = addCard(g, { table: 'patients', cols: COLS_PAT });
  const problems = validateGraph(g);
  ok(problems.some(p => p.includes('Connect')), 'two cards with no edges reports connection problem');
}

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  g = addCard(g, { table: 'patients', cols: COLS_PAT });
  const [c1, c2] = g.cards;
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });
  const problems = validateGraph(g);
  ok(problems.length === 0, 'fully connected graph validates cleanly');
}

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  g = addCard(g, { table: 'patients', cols: COLS_PAT });
  g = addCard(g, { table: 'labs', cols: COLS_LAB });
  const [c1, c2] = g.cards;
  // Only connect encounters <-> patients; labs is disconnected
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });
  const problems = validateGraph(g);
  ok(problems.some(p => p.includes('labs')), 'disconnected card reports isolation problem');
}

// ============================================================
// 4. Join Model — auto-positioning
// ============================================================
section('4. Auto-positioning');

{
  const p0 = autoCardPos(0);
  const p1 = autoCardPos(1);
  const p4 = autoCardPos(4);
  ok(p0.x < p1.x, 'second card is to the right of first');
  ok(p4.y > p0.y, 'fifth card wraps to a new row');
}

// ============================================================
// 5. Join Model — serialization
// ============================================================
section('5. Serialization');

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  g = addCard(g, { table: 'patients', cols: COLS_PAT });
  const [c1, c2] = g.cards;
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });

  const serialized = serializeGraph(g);
  ok(typeof serialized === 'object', 'serializeGraph returns an object');

  const roundTripped = deserializeGraph(serialized);
  ok(roundTripped.cards.length === 2, 'round-trip preserves card count');
  ok(roundTripped.edges.length === 1, 'round-trip preserves edge count');
}

{
  const g = deserializeGraph(null);
  ok(g.cards.length === 0, 'deserializeGraph handles null gracefully');
  const g2 = deserializeGraph('bad');
  ok(g2.cards.length === 0, 'deserializeGraph handles bad string gracefully');
}

// ============================================================
// 6. SQL Generation — single table
// ============================================================
section('6. SQL Generation — single table');

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  const { sql, warnings } = generateJoinSQL(g);
  ok(sql.includes('SELECT'), 'single table generates SELECT');
  ok(sql.includes('"encounters"'), 'single table appears in SQL');
  ok(warnings.length === 0, 'no warnings for valid single-table graph');
}

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  const { sql } = generateJoinSQL(g, { limit: 100 });
  ok(sql.includes('100'), 'LIMIT clause included when requested');
}

{
  const { sql } = generateJoinSQL(freshGraph());
  ok(!sql || sql === '', 'empty graph returns empty SQL');
}

// ============================================================
// 7. SQL Generation — two-table INNER JOIN
// ============================================================
section('7. SQL Generation — two-table INNER JOIN');

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  g = addCard(g, { table: 'patients', cols: COLS_PAT });
  const [c1, c2] = g.cards;
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });
  const { sql, warnings } = generateJoinSQL(g);
  ok(sql.includes('INNER JOIN'), 'INNER JOIN clause present');
  ok(sql.includes('"encounters"'), 'encounters table in SQL');
  ok(sql.includes('"patients"'), 'patients table in SQL');
  ok(sql.includes('"patient_id"'), 'join column in ON clause');
  ok(warnings.some(w => w.includes('collision')), 'collision warning when shared column names exist');
}

// ============================================================
// 8. SQL Generation — three-table join chain
// ============================================================
section('8. SQL Generation — three-table join chain');

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  g = addCard(g, { table: 'patients', cols: COLS_PAT });
  g = addCard(g, { table: 'labs', cols: COLS_LAB });
  const [c1, c2, c3] = g.cards;
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });
  g = addEdge(g, { from: { cardId: c1.id, col: 'encounter_id' }, to: { cardId: c3.id, col: 'encounter_id' }, type: 'LEFT' });
  const { sql } = generateJoinSQL(g);
  ok(sql.includes('LEFT JOIN'), 'LEFT JOIN clause present for labs');
  ok(sql.includes('"labs"'), 'labs table in three-way SQL');
}

// ============================================================
// 9. SQL Generation — join type variations
// ============================================================
section('9. SQL Generation — join type variations');

for (const jt of JOIN_TYPES) {
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  g = addCard(g, { table: 'patients', cols: COLS_PAT });
  const [c1, c2] = g.cards;
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' }, type: jt });
  const { sql } = generateJoinSQL(g);
  ok(sql.includes(jt + ' JOIN'), `${jt} JOIN appears in SQL`);
}

// ============================================================
// 10. SQL Generation — WHERE and LIMIT options
// ============================================================
section('10. SQL Generation — WHERE and LIMIT options');

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  g = addCard(g, { table: 'patients', cols: COLS_PAT });
  const [c1, c2] = g.cards;
  g = addEdge(g, { from: { cardId: c1.id, col: 'patient_id' }, to: { cardId: c2.id, col: 'patient_id' } });
  const { sql } = generateJoinSQL(g, { where: 't1.admit_date >= \'2024-01-01\'', limit: 500 });
  ok(sql.includes('WHERE'), 'WHERE clause injected');
  ok(sql.includes('500'), 'LIMIT injected');
}

// ============================================================
// 11. SQL Generation — preview shortcut
// ============================================================
section('11. SQL Generation — preview shortcut');

{
  let g = freshGraph();
  g = addCard(g, { table: 'encounters', cols: COLS_ENC });
  const { sql } = generatePreviewSQL(g);
  ok(sql.includes('500'), 'preview SQL includes LIMIT 500');
}

// ============================================================
// 12. suggestJoinColumns — heuristics
// ============================================================
section('12. suggestJoinColumns heuristics');

{
  const fromCard = { id: 'c1', table: 'encounters', cols: COLS_ENC, pos: { x: 0, y: 0 } };
  const toCard   = { id: 'c2', table: 'patients', cols: COLS_PAT, pos: { x: 300, y: 0 } };
  const suggestion = suggestJoinColumns(fromCard, toCard);
  ok(suggestion !== null, 'suggestion found for patient_id match');
  ok(suggestion.fromCol === 'patient_id', 'fromCol is patient_id');
  ok(suggestion.toCol === 'patient_id', 'toCol is patient_id');
}

{
  const labCard = { id: 'c3', table: 'labs', cols: COLS_LAB, pos: { x: 0, y: 0 } };
  const encCard = { id: 'c1', table: 'encounters', cols: COLS_ENC, pos: { x: 300, y: 0 } };
  const suggestion = suggestJoinColumns(labCard, encCard);
  ok(suggestion !== null, 'suggestion found for encounter_id match');
  ok(suggestion.fromCol === 'encounter_id' || suggestion.toCol === 'encounter_id',
    'encounter_id selected as join key');
}

{
  const noOverlap = [{ name: 'alpha', type: 'INTEGER' }];
  const noOverlapCard2 = [{ name: 'beta', type: 'VARCHAR' }];
  const c1 = { id: 'x', table: 'a', cols: noOverlap, pos: { x: 0, y: 0 } };
  const c2 = { id: 'y', table: 'b', cols: noOverlapCard2, pos: { x: 0, y: 0 } };
  ok(suggestJoinColumns(c1, c2) === null, 'returns null when no heuristic fires');
}

{
  // Cross-table FK: "patient" column on one side, "patient_id" on the other
  const c1 = { id: 'x', table: 'a', cols: [{ name: 'patient', type: 'INTEGER' }], pos: { x: 0, y: 0 } };
  const c2 = { id: 'y', table: 'b', cols: [{ name: 'patient_id', type: 'INTEGER' }], pos: { x: 0, y: 0 } };
  const suggestion = suggestJoinColumns(c1, c2);
  ok(suggestion !== null, 'cross-table FK heuristic fires');
}

// ============================================================
// Summary
// ============================================================
console.log(`\n${passed + failed} assertions: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
