// ============================================================
// DATAGLOW — Join Builder: Pure Data Model
// ============================================================
// Manages the state of a visual join graph: which tables are on the canvas,
// where their schema cards are positioned, and which columns are connected
// by join edges. Everything here is pure (no DOM, no DuckDB, no globals) so
// it can be fully tested in Node.
//
// Core vocabulary:
//   Card     — a schema card for one table: { id, table, cols, pos:{x,y} }
//   Edge     — a join link between two columns: { id, from, to, type }
//              from/to are { cardId, col } references
//   JoinGraph — { cards: Card[], edges: Edge[] }
//
// All mutators return a NEW JoinGraph — they never mutate their input.
// This matches the pure-core discipline used in glow-canvas.js and room-ui.js.
// ============================================================

// ---------------------------------------------------------------
// Types (JSDoc only — no runtime overhead)
// ---------------------------------------------------------------
/**
 * @typedef {{ x: number, y: number }} Pos
 * @typedef {{ name: string, type: string }} ColDef
 * @typedef {{ id: string, table: string, cols: ColDef[], pos: Pos }} Card
 * @typedef {{ cardId: string, col: string }} EdgeEndpoint
 * @typedef {{ id: string, from: EdgeEndpoint, to: EdgeEndpoint, type: JoinType }} Edge
 * @typedef {{ cards: Card[], edges: Edge[] }} JoinGraph
 * @typedef {'INNER'|'LEFT'|'RIGHT'|'FULL'} JoinType
 */

export const JOIN_TYPES = /** @type {const} */ (['INNER', 'LEFT', 'RIGHT', 'FULL']);

/** Default grid slot size for auto-positioning new cards. */
const CARD_SLOT_W = 240;
const CARD_SLOT_H = 280;
const CARD_MARGIN = 32;

// ---------------------------------------------------------------
// Factory
// ---------------------------------------------------------------

/** Create an empty join graph. */
export function createJoinGraph() {
  return { cards: [], edges: [] };
}

// ---------------------------------------------------------------
// ID generation (deterministic in tests via optional seed)
// ---------------------------------------------------------------

let _idCounter = 0;
/** Reset the counter — tests only. */
export function _resetIdCounter() { _idCounter = 0; }

function nextId(prefix) {
  return `${prefix}_${(++_idCounter).toString(36)}`;
}

// ---------------------------------------------------------------
// Card operations
// ---------------------------------------------------------------

/**
 * Compute an auto-layout position for the nth card in a horizontal row.
 * Cards tile left-to-right; when the row exceeds 4 cards, wrap to the next row.
 */
export function autoCardPos(existingCount) {
  const col = existingCount % 4;
  const row = Math.floor(existingCount / 4);
  return {
    x: CARD_MARGIN + col * (CARD_SLOT_W + CARD_MARGIN),
    y: CARD_MARGIN + row * (CARD_SLOT_H + CARD_MARGIN),
  };
}

/**
 * Add a schema card for a loaded table. Returns a new graph.
 * @param {JoinGraph} graph
 * @param {{ table: string, cols: ColDef[], pos?: Pos }} opts
 * @returns {JoinGraph}
 */
export function addCard(graph, { table, cols, pos } = {}) {
  if (!table) throw new Error('addCard: table name is required');
  // Prevent duplicate table cards on the canvas.
  if (graph.cards.some(c => c.table === table)) {
    throw new Error(`addCard: table "${table}" is already on the canvas`);
  }
  const id = nextId('card');
  const position = pos || autoCardPos(graph.cards.length);
  const card = { id, table, cols: Array.isArray(cols) ? cols.slice() : [], pos: { ...position } };
  return { ...graph, cards: [...graph.cards, card] };
}

/**
 * Remove a card and all edges that reference it. Returns a new graph.
 * @param {JoinGraph} graph
 * @param {string} cardId
 * @returns {JoinGraph}
 */
export function removeCard(graph, cardId) {
  const cards = graph.cards.filter(c => c.id !== cardId);
  const edges = graph.edges.filter(e => e.from.cardId !== cardId && e.to.cardId !== cardId);
  return { ...graph, cards, edges };
}

/**
 * Move a card to a new position. Returns a new graph.
 * @param {JoinGraph} graph
 * @param {string} cardId
 * @param {Pos} pos
 * @returns {JoinGraph}
 */
export function moveCard(graph, cardId, pos) {
  const cards = graph.cards.map(c =>
    c.id === cardId ? { ...c, pos: { x: Number(pos.x), y: Number(pos.y) } } : c
  );
  return { ...graph, cards };
}

/**
 * Return the card for a given id, or null.
 * @param {JoinGraph} graph
 * @param {string} cardId
 * @returns {Card|null}
 */
export function getCard(graph, cardId) {
  return graph.cards.find(c => c.id === cardId) || null;
}

/**
 * Return the card for a given table name, or null.
 * @param {JoinGraph} graph
 * @param {string} table
 * @returns {Card|null}
 */
export function getCardByTable(graph, table) {
  return graph.cards.find(c => c.table === table) || null;
}

// ---------------------------------------------------------------
// Edge operations
// ---------------------------------------------------------------

/**
 * Add a join edge between two column endpoints. Returns a new graph.
 * Validates that both cards exist and both columns exist on their cards.
 * @param {JoinGraph} graph
 * @param {{ from: EdgeEndpoint, to: EdgeEndpoint, type?: JoinType }} opts
 * @returns {JoinGraph}
 */
export function addEdge(graph, { from, to, type = 'INNER' } = {}) {
  if (!from || !to) throw new Error('addEdge: from and to are required');
  if (!from.cardId || !from.col) throw new Error('addEdge: from must have cardId and col');
  if (!to.cardId || !to.col) throw new Error('addEdge: to must have cardId and col');
  if (from.cardId === to.cardId) throw new Error('addEdge: cannot join a table to itself');

  const fromCard = getCard(graph, from.cardId);
  if (!fromCard) throw new Error(`addEdge: card "${from.cardId}" not found`);
  const toCard = getCard(graph, to.cardId);
  if (!toCard) throw new Error(`addEdge: card "${to.cardId}" not found`);

  if (!fromCard.cols.some(c => c.name === from.col)) {
    throw new Error(`addEdge: column "${from.col}" not found on table "${fromCard.table}"`);
  }
  if (!toCard.cols.some(c => c.name === to.col)) {
    throw new Error(`addEdge: column "${to.col}" not found on table "${toCard.table}"`);
  }

  // Reject duplicate edges (same pair of endpoints regardless of direction).
  const duplicate = graph.edges.some(e =>
    (e.from.cardId === from.cardId && e.from.col === from.col &&
     e.to.cardId === to.cardId && e.to.col === to.col) ||
    (e.from.cardId === to.cardId && e.from.col === to.col &&
     e.to.cardId === from.cardId && e.to.col === from.col)
  );
  if (duplicate) throw new Error('addEdge: this join edge already exists');

  if (!JOIN_TYPES.includes(type)) throw new Error(`addEdge: unknown join type "${type}"`);

  const id = nextId('edge');
  const edge = { id, from: { ...from }, to: { ...to }, type };
  return { ...graph, edges: [...graph.edges, edge] };
}

/**
 * Remove a join edge by id. Returns a new graph.
 * @param {JoinGraph} graph
 * @param {string} edgeId
 * @returns {JoinGraph}
 */
export function removeEdge(graph, edgeId) {
  return { ...graph, edges: graph.edges.filter(e => e.id !== edgeId) };
}

/**
 * Change the join type on an existing edge. Returns a new graph.
 * @param {JoinGraph} graph
 * @param {string} edgeId
 * @param {JoinType} type
 * @returns {JoinGraph}
 */
export function setEdgeType(graph, edgeId, type) {
  if (!JOIN_TYPES.includes(type)) throw new Error(`setEdgeType: unknown join type "${type}"`);
  const edges = graph.edges.map(e => e.id === edgeId ? { ...e, type } : e);
  return { ...graph, edges };
}

/**
 * Return all edges that involve a given card (by cardId).
 * @param {JoinGraph} graph
 * @param {string} cardId
 * @returns {Edge[]}
 */
export function edgesForCard(graph, cardId) {
  return graph.edges.filter(e => e.from.cardId === cardId || e.to.cardId === cardId);
}

// ---------------------------------------------------------------
// Validation
// ---------------------------------------------------------------

/**
 * Validate the graph and return an array of human-readable problems.
 * An empty array means the graph is ready to generate SQL.
 * @param {JoinGraph} graph
 * @returns {string[]}
 */
export function validateGraph(graph) {
  const problems = [];
  if (graph.cards.length === 0) {
    problems.push('Add at least one table to the canvas.');
    return problems;
  }
  if (graph.cards.length === 1 && graph.edges.length === 0) {
    // Single table — valid, generates a simple SELECT.
    return problems;
  }
  if (graph.cards.length > 1 && graph.edges.length === 0) {
    problems.push('Connect tables with join lines to define how they relate.');
  }
  // Check for disconnected cards (not reachable from the first card through edges).
  const connected = new Set([graph.cards[0].id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of graph.edges) {
      const hadFrom = connected.has(e.from.cardId);
      const hadTo = connected.has(e.to.cardId);
      if (hadFrom && !hadTo) { connected.add(e.to.cardId); changed = true; }
      if (hadTo && !hadFrom) { connected.add(e.from.cardId); changed = true; }
    }
  }
  for (const card of graph.cards) {
    if (!connected.has(card.id)) {
      problems.push(`Table "${card.table}" is not connected to any other table.`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------

/**
 * Serialize a join graph to a plain JSON-safe object.
 * @param {JoinGraph} graph
 * @returns {object}
 */
export function serializeGraph(graph) {
  return JSON.parse(JSON.stringify(graph));
}

/**
 * Deserialize a join graph from a plain object. Returns an empty graph on error.
 * @param {unknown} raw
 * @returns {JoinGraph}
 */
export function deserializeGraph(raw) {
  try {
    if (!raw || typeof raw !== 'object') return createJoinGraph();
    const cards = Array.isArray(raw.cards) ? raw.cards : [];
    const edges = Array.isArray(raw.edges) ? raw.edges : [];
    return { cards, edges };
  } catch (_) {
    return createJoinGraph();
  }
}
