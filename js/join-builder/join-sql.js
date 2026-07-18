// ============================================================
// DATAGLOW — Join Builder: SQL Generator
// ============================================================
// Converts a JoinGraph into a ready-to-run DuckDB SQL SELECT statement.
// Pure function — no DOM, no globals. Fully testable in Node.
//
// Strategy:
//   1. Validate the graph has at least one card and all cards are connected.
//   2. Choose a "root" card (the first card on the canvas).
//   3. Topologically order the remaining cards by BFS from the root, following
//      the edges to decide which side of each JOIN clause each table goes on.
//   4. Build column aliases to avoid collisions when two tables share a name.
//   5. Emit: SELECT <cols> FROM <root> [JOIN <table> ON <cond>]* [WHERE 1=1]
//
// The emitted SQL is intentionally easy to read and edit — indented, one JOIN
// per line, SELECT * aliases expanded with table prefixes.
// ============================================================

import { validateGraph, getCard, JOIN_TYPES } from './join-model.js';

// Quote an identifier safely for DuckDB.
function q(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Generate a SQL SELECT statement from a join graph.
 *
 * @param {import('./join-model.js').JoinGraph} graph
 * @param {object} [opts]
 * @param {boolean} [opts.selectAll=true]   When true, emit SELECT * (or prefixed cols for collision avoidance).
 * @param {string[]} [opts.selectCols]      Explicit column list overrides selectAll.
 * @param {string} [opts.where]             Optional WHERE clause body (injected verbatim after WHERE).
 * @param {number} [opts.limit]             Optional LIMIT n.
 * @returns {{ sql: string, warnings: string[] }}
 */
export function generateJoinSQL(graph, opts = {}) {
  const warnings = [];

  // ---- Validation ----
  const problems = validateGraph(graph);
  if (problems.length) {
    return { sql: '', warnings: problems };
  }

  // ---- Single-table shortcut ----
  if (graph.cards.length === 1 && graph.edges.length === 0) {
    const card = graph.cards[0];
    const limitClause = opts.limit ? `\nLIMIT ${Number(opts.limit)}` : '';
    const sql = `SELECT *\nFROM ${q(card.table)}${limitClause}`;
    return { sql, warnings };
  }

  // ---- BFS from root to build join order ----
  const root = graph.cards[0];
  const visited = new Set([root.id]);
  // joinSteps: array of { card, edge, sideIsFrom }
  // sideIsFrom=true  means this card is edge.from, root side is edge.to
  // sideIsFrom=false means this card is edge.to,   root side is edge.from
  const joinSteps = [];
  const queue = [root.id];

  while (queue.length) {
    const currentId = queue.shift();
    for (const edge of graph.edges) {
      const isFrom = edge.from.cardId === currentId;
      const isTo   = edge.to.cardId   === currentId;
      if (!isFrom && !isTo) continue;

      const neighborId = isFrom ? edge.to.cardId : edge.from.cardId;
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      queue.push(neighborId);

      const neighborCard = getCard(graph, neighborId);
      // Determine which endpoint belongs to the neighbor vs the current node.
      // The JOIN reads: "<currentTable> JOIN <neighborTable> ON <currentCol> = <neighborCol>"
      const currentEndpoint = isFrom ? edge.from : edge.to;
      const neighborEndpoint = isFrom ? edge.to   : edge.from;

      joinSteps.push({
        card:             neighborCard,
        currentCardId:    currentId,
        edge,
        currentEndpoint,  // column on the already-joined side
        neighborEndpoint, // column on the card being joined
      });
    }
  }

  // ---- Alias map: table -> alias (t1, t2, …) ----
  const allCards = [root, ...joinSteps.map(s => s.card)];
  const aliasMap = new Map(); // cardId -> alias string
  allCards.forEach((card, i) => {
    aliasMap.set(card.id, `t${i + 1}`);
  });

  function tableAlias(cardId) { return aliasMap.get(cardId) || 't'; }

  // ---- Column projection ----
  let selectExpr;
  if (Array.isArray(opts.selectCols) && opts.selectCols.length) {
    selectExpr = opts.selectCols.join(', ');
  } else {
    // Detect name collisions across tables to decide whether to prefix.
    const allColNames = allCards.flatMap(card => card.cols.map(c => c.name));
    const colCounts = {};
    for (const n of allColNames) colCounts[n] = (colCounts[n] || 0) + 1;
    const hasCollision = Object.values(colCounts).some(v => v > 1);

    if (!hasCollision) {
      selectExpr = '*';
    } else {
      // Prefix each column with its table alias and alias the output name to
      // table_column so downstream SQL can reference it unambiguously.
      const colExprs = allCards.flatMap(card => {
        const alias = tableAlias(card.id);
        return card.cols.map(col => {
          const outName = colCounts[col.name] > 1
            ? `${card.table}_${col.name}`
            : col.name;
          return `${alias}.${q(col.name)} AS ${q(outName)}`;
        });
      });
      selectExpr = colExprs.join(',\n       ');
      warnings.push(
        'Column name collision detected across joined tables — output columns have been prefixed with their table name.'
      );
    }
  }

  // ---- FROM clause ----
  const rootAlias = tableAlias(root.id);
  let sql = `SELECT ${selectExpr}\nFROM   ${q(root.table)} AS ${rootAlias}`;

  // ---- JOIN clauses ----
  for (const step of joinSteps) {
    const neighborAlias = tableAlias(step.card.id);
    const currentAlias  = tableAlias(step.currentCardId);
    const joinKeyword   = `${step.edge.type} JOIN`;
    const onClause      = `${currentAlias}.${q(step.currentEndpoint.col)} = ${neighborAlias}.${q(step.neighborEndpoint.col)}`;
    sql += `\n${joinKeyword.padEnd(10)} ${q(step.card.table)} AS ${neighborAlias} ON ${onClause}`;
  }

  // ---- Optional WHERE ----
  if (opts.where && String(opts.where).trim()) {
    sql += `\nWHERE  ${String(opts.where).trim()}`;
  }

  // ---- Optional LIMIT ----
  if (opts.limit != null && Number.isFinite(Number(opts.limit))) {
    sql += `\nLIMIT  ${Number(opts.limit)}`;
  }

  return { sql, warnings };
}

/**
 * Build a preview SQL limited to 500 rows — suitable for the "Preview" button
 * in the Join Builder UI.
 * @param {import('./join-model.js').JoinGraph} graph
 * @returns {{ sql: string, warnings: string[] }}
 */
export function generatePreviewSQL(graph) {
  return generateJoinSQL(graph, { limit: 500 });
}

/**
 * Suggest likely join columns between two tables based on column name and type
 * heuristics — a convenience for the auto-detect feature in the UI.
 *
 * Heuristics (in priority order):
 *   1. Exact name match on both sides (case-insensitive).
 *   2. One column name ends with "_id" / "id" / "_key" and the other matches
 *      the prefix (e.g. "patient_id" ↔ "patient_id").
 *   3. One side has a primary-key-shaped name that matches the other's name
 *      when "id" / "_id" is appended.
 *
 * Returns the best candidate pair { fromCol, toCol } or null if no heuristic
 * fires. Never throws.
 *
 * @param {import('./join-model.js').Card} fromCard
 * @param {import('./join-model.js').Card} toCard
 * @returns {{ fromCol: string, toCol: string }|null}
 */
export function suggestJoinColumns(fromCard, toCard) {
  try {
    const fromCols = fromCard.cols.map(c => c.name);
    const toCols   = toCard.cols.map(c => c.name);

    // 1. Exact match (case-insensitive)
    for (const fc of fromCols) {
      const match = toCols.find(tc => tc.toLowerCase() === fc.toLowerCase());
      if (match) return { fromCol: fc, toCol: match };
    }

    // 2. ID-suffix match: "patient_id" on one side matches "patient_id" on the other
    const idSuffix = /(_id|_key|id|key)$/i;
    for (const fc of fromCols.filter(c => idSuffix.test(c))) {
      const match = toCols.find(tc => tc.toLowerCase() === fc.toLowerCase());
      if (match) return { fromCol: fc, toCol: match };
    }
    for (const tc of toCols.filter(c => idSuffix.test(c))) {
      const match = fromCols.find(fc => fc.toLowerCase() === tc.toLowerCase());
      if (match) return { fromCol: match, toCol: tc };
    }

    // 3. Cross-table foreign key: "patient" on one side, "patient_id" on the other
    for (const fc of fromCols) {
      const match = toCols.find(tc =>
        tc.toLowerCase() === fc.toLowerCase() + '_id' ||
        tc.toLowerCase() === fc.toLowerCase() + 'id'
      );
      if (match) return { fromCol: fc, toCol: match };
    }
    for (const tc of toCols) {
      const match = fromCols.find(fc =>
        fc.toLowerCase() === tc.toLowerCase() + '_id' ||
        fc.toLowerCase() === tc.toLowerCase() + 'id'
      );
      if (match) return { fromCol: match, toCol: tc };
    }

    return null;
  } catch (_) {
    return null;
  }
}
