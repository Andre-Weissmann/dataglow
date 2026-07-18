// ============================================================
// DATAGLOW — Join Builder: SVG Canvas Renderer
// ============================================================
// Browser-only. Renders the visual join graph as an interactive SVG canvas:
//
//   - Schema cards (table name + column list) rendered as foreignObject HTML
//     inside an SVG viewport so we get CSS styling for free.
//   - Bezier curve edges connecting columns, colour-coded by join type.
//   - Drag-to-move cards (pointer events on the card header).
//   - Click-to-connect columns: click a column on card A, then a column on
//     card B to create an edge. ESC cancels pending connection.
//   - Edge type picker (INNER / LEFT / RIGHT / FULL) shown on edge click.
//   - Remove card / remove edge buttons.
//   - "Detect join" button on each card pair auto-suggests columns via
//     suggestJoinColumns().
//
// State ownership: the JoinGraph lives in main.js; this module only renders
// it and calls back via onGraphChange(newGraph). It never mutates the graph
// directly. This keeps the UI stateless — re-render from graph at any time.
// ============================================================

import {
  addCard, removeCard, moveCard,
  addEdge, removeEdge, setEdgeType,
  getCard, edgesForCard,
} from './join-model.js';
import { generatePreviewSQL, generateJoinSQL, suggestJoinColumns } from './join-sql.js';

// ---- Constants ----
const CARD_W = 220;
const COL_ROW_H = 28;
const CARD_HEADER_H = 40;
const CONNECTOR_R = 7;   // radius of the column connector dot

const JOIN_COLORS = {
  INNER: '#20808D',
  LEFT:  '#A84B2F',
  RIGHT: '#7A39BB',
  FULL:  '#D19900',
};

// ---- SVG helpers ----
function svgEl(tag, attrs = {}, children = []) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const child of children) if (child) el.appendChild(child);
  return el;
}

function htmlEl(tag, attrs = {}, innerHTML = '') {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, String(v));
  }
  if (innerHTML) el.innerHTML = innerHTML;
  return el;
}

// Cubic bezier path between two points. The curve handles pull horizontally
// (left/right) so edges look natural even between nearby cards.
function curvePath(x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1) * 0.55 + 60;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

// Column connector port position relative to SVG origin.
// The port sits on the right edge for columns whose card is to the left,
// and on the left edge for the other side. For simplicity we always emit
// right-side ports — the caller decides which side based on edge direction.
function portPos(card, colName, side = 'right') {
  const colIdx = card.cols.findIndex(c => c.name === colName);
  if (colIdx < 0) return { x: card.pos.x, y: card.pos.y };
  const y = card.pos.y + CARD_HEADER_H + colIdx * COL_ROW_H + COL_ROW_H / 2;
  const x = side === 'right' ? card.pos.x + CARD_W : card.pos.x;
  return { x, y };
}

// ============================================================
// Public API
// ============================================================

/**
 * Render the join canvas into a host element.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host         Container element (must have a fixed height).
 * @param {import('./join-model.js').JoinGraph} opts.graph  Current join graph.
 * @param {function} opts.onGraphChange   Callback(newGraph) when graph mutates.
 * @param {function} opts.onSQLChange     Callback({ sql, warnings }) on any change.
 * @param {function} [opts.onRunSQL]      Optional callback(sql) when user clicks Run.
 */
export function renderJoinCanvas({ host, graph, onGraphChange, onSQLChange, onRunSQL }) {
  host.innerHTML = '';
  host.style.position = 'relative';
  host.style.overflow = 'auto';
  host.style.userSelect = 'none';

  // Pending connection state (column click-to-connect)
  let pendingFrom = null; // { cardId, col }

  // Compute canvas size — large enough to fit all cards with some margin.
  const canvasW = Math.max(
    900,
    ...graph.cards.map(c => c.pos.x + CARD_W + 60)
  );
  const canvasH = Math.max(
    600,
    ...graph.cards.map(c => c.pos.y + CARD_HEADER_H + c.cols.length * COL_ROW_H + 60)
  );

  const svg = svgEl('svg', {
    width: canvasW,
    height: canvasH,
    style: 'display:block; cursor:default;',
  });

  // ---- Definitions (arrowhead marker) ----
  const defs = svgEl('defs');
  for (const [type, color] of Object.entries(JOIN_COLORS)) {
    const marker = svgEl('marker', {
      id: `arrow-${type}`,
      markerWidth: 8, markerHeight: 8,
      refX: 6, refY: 3,
      orient: 'auto',
    });
    marker.appendChild(svgEl('path', { d: 'M0,0 L0,6 L8,3 z', fill: color }));
    defs.appendChild(marker);
  }
  svg.appendChild(defs);

  // ---- Edge group (drawn first so cards appear on top) ----
  const edgeGroup = svgEl('g', { class: 'join-edges' });
  svg.appendChild(edgeGroup);

  // ---- Card group ----
  const cardGroup = svgEl('g', { class: 'join-cards' });
  svg.appendChild(cardGroup);

  // ---- Edge type select overlay ----
  let edgeSelectEl = null;

  function dismissEdgeSelect() {
    if (edgeSelectEl) { edgeSelectEl.remove(); edgeSelectEl = null; }
  }

  function showEdgeTypeSelect(edgeId, screenX, screenY, currentType, updateFn) {
    dismissEdgeSelect();
    const wrap = htmlEl('div', {
      style: {
        position: 'absolute',
        left: (screenX + 8) + 'px',
        top:  (screenY - 8) + 'px',
        background: 'var(--color-surface, #fff)',
        border: '1px solid var(--color-border, #ccc)',
        borderRadius: '6px',
        boxShadow: '0 4px 12px rgba(0,0,0,.15)',
        zIndex: 100,
        padding: '8px',
        fontSize: '13px',
        minWidth: '140px',
      },
    });
    const title = htmlEl('div', { style: { fontWeight: 'bold', marginBottom: '6px', color: 'var(--color-text)' } });
    title.textContent = 'Join type';
    wrap.appendChild(title);
    for (const jt of ['INNER', 'LEFT', 'RIGHT', 'FULL']) {
      const opt = htmlEl('div', {
        style: {
          padding: '4px 8px',
          cursor: 'pointer',
          borderRadius: '4px',
          background: jt === currentType ? 'var(--color-primary, #20808D)' : 'transparent',
          color: jt === currentType ? '#fff' : 'var(--color-text)',
        },
      });
      opt.textContent = jt + ' JOIN';
      opt.addEventListener('click', (ev) => {
        ev.stopPropagation();
        updateFn(jt);
        dismissEdgeSelect();
      });
      wrap.appendChild(opt);
    }
    const removeBtn = htmlEl('div', {
      style: {
        padding: '4px 8px',
        cursor: 'pointer',
        borderRadius: '4px',
        color: 'var(--color-error, #A13544)',
        marginTop: '4px',
        borderTop: '1px solid var(--color-border, #eee)',
      },
    });
    removeBtn.textContent = 'Remove edge';
    removeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      dismissEdgeSelect();
      onGraphChange(removeEdge(graph, edgeId));
    });
    wrap.appendChild(removeBtn);
    host.style.position = 'relative';
    host.appendChild(wrap);
    edgeSelectEl = wrap;
  }

  // ---- Draw edges ----
  function drawEdges() {
    edgeGroup.innerHTML = '';
    for (const edge of graph.edges) {
      const fromCard = getCard(graph, edge.from.cardId);
      const toCard   = getCard(graph, edge.to.cardId);
      if (!fromCard || !toCard) continue;

      // Pick ports: the connector exits right from the card whose x is smaller,
      // and enters left of the card whose x is larger.
      const fromRight = fromCard.pos.x <= toCard.pos.x;
      const p1 = portPos(fromCard, edge.from.col, fromRight ? 'right' : 'left');
      const p2 = portPos(toCard,   edge.to.col,   fromRight ? 'left'  : 'right');

      const color = JOIN_COLORS[edge.type] || JOIN_COLORS.INNER;
      const path = svgEl('path', {
        d: curvePath(p1.x, p1.y, p2.x, p2.y),
        fill: 'none',
        stroke: color,
        'stroke-width': 2.5,
        'stroke-dasharray': edge.type === 'FULL' ? '6 3' : 'none',
        'marker-end': `url(#arrow-${edge.type})`,
        style: 'cursor:pointer;',
        'data-edge-id': edge.id,
      });

      // Edge type label at midpoint
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2 - 10;
      const label = svgEl('text', {
        x: mx, y: my,
        'text-anchor': 'middle',
        'font-size': 10,
        fill: color,
        style: 'pointer-events:none; font-family:monospace; font-weight:bold;',
      });
      label.textContent = edge.type;

      // Wider invisible hit area for easier clicking
      const hitArea = svgEl('path', {
        d: curvePath(p1.x, p1.y, p2.x, p2.y),
        fill: 'none',
        stroke: 'transparent',
        'stroke-width': 14,
        style: 'cursor:pointer;',
      });
      hitArea.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const rect = host.getBoundingClientRect();
        const sx = ev.clientX - rect.left + host.scrollLeft;
        const sy = ev.clientY - rect.top  + host.scrollTop;
        showEdgeTypeSelect(edge.id, sx, sy, edge.type, (newType) => {
          onGraphChange(setEdgeType(graph, edge.id, newType));
        });
      });

      edgeGroup.appendChild(hitArea);
      edgeGroup.appendChild(path);
      edgeGroup.appendChild(label);
    }
  }

  // ---- Draw cards ----
  function drawCards() {
    cardGroup.innerHTML = '';
    for (const card of graph.cards) {
      const cardH = CARD_HEADER_H + card.cols.length * COL_ROW_H + 8;
      const g = svgEl('g', { 'data-card-id': card.id, style: 'cursor:default;' });

      // Card shadow
      g.appendChild(svgEl('rect', {
        x: card.pos.x + 3, y: card.pos.y + 3,
        width: CARD_W, height: cardH,
        rx: 8, fill: 'rgba(0,0,0,.10)',
      }));

      // Card body
      g.appendChild(svgEl('rect', {
        x: card.pos.x, y: card.pos.y,
        width: CARD_W, height: cardH,
        rx: 8,
        fill: 'var(--color-surface, #fff)',
        stroke: pendingFrom ? '#20808D' : 'var(--color-border, #D4D1CA)',
        'stroke-width': pendingFrom ? 2 : 1,
      }));

      // Header background
      g.appendChild(svgEl('rect', {
        x: card.pos.x, y: card.pos.y,
        width: CARD_W, height: CARD_HEADER_H,
        rx: 8, fill: '#1A3A4A',
        // Square off bottom corners of header
        style: 'clip-path: inset(0 0 8px 0)',
      }));
      g.appendChild(svgEl('rect', {
        x: card.pos.x, y: card.pos.y + CARD_HEADER_H - 8,
        width: CARD_W, height: 8, fill: '#1A3A4A',
      }));

      // Table name
      const tableLabel = svgEl('text', {
        x: card.pos.x + 12, y: card.pos.y + 25,
        fill: '#fff',
        'font-size': 13,
        'font-weight': 'bold',
        style: 'font-family:system-ui,sans-serif;',
      });
      tableLabel.textContent = card.table.length > 22
        ? card.table.slice(0, 20) + '\u2026'
        : card.table;
      g.appendChild(tableLabel);

      // Remove card button (×)
      const removeBtn = svgEl('text', {
        x: card.pos.x + CARD_W - 14, y: card.pos.y + 26,
        fill: 'rgba(255,255,255,.7)',
        'font-size': 14,
        'text-anchor': 'middle',
        style: 'cursor:pointer; font-family:system-ui,sans-serif;',
        'data-testid': `join-remove-card-${card.id}`,
      });
      removeBtn.textContent = '\u00D7';
      removeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onGraphChange(removeCard(graph, card.id));
      });
      g.appendChild(removeBtn);

      // Column rows
      card.cols.forEach((col, i) => {
        const rowY = card.pos.y + CARD_HEADER_H + i * COL_ROW_H;
        const isPending = pendingFrom && pendingFrom.cardId === card.id && pendingFrom.col === col.name;
        const isEndpoint = graph.edges.some(e =>
          (e.from.cardId === card.id && e.from.col === col.name) ||
          (e.to.cardId   === card.id && e.to.col   === col.name)
        );

        // Row hover highlight
        const rowBg = svgEl('rect', {
          x: card.pos.x + 1, y: rowY,
          width: CARD_W - 2, height: COL_ROW_H,
          fill: isPending ? 'rgba(32,128,141,.15)' : 'transparent',
          style: 'cursor:pointer;',
        });

        // Column name
        const colText = svgEl('text', {
          x: card.pos.x + 16, y: rowY + 18,
          'font-size': 11.5,
          fill: isPending ? '#20808D' : 'var(--color-text, #28251D)',
          'font-weight': isEndpoint ? 'bold' : 'normal',
          style: 'font-family:monospace; pointer-events:none;',
        });
        colText.textContent = col.name.length > 18 ? col.name.slice(0, 16) + '\u2026' : col.name;

        // Type badge
        const typeText = svgEl('text', {
          x: card.pos.x + CARD_W - 10, y: rowY + 18,
          'font-size': 10,
          fill: 'var(--color-text-muted, #7A7974)',
          'text-anchor': 'end',
          style: 'font-family:monospace; pointer-events:none;',
        });
        typeText.textContent = (col.type || '').split('(')[0].slice(0, 8);

        // Connector dot (port)
        const dot = svgEl('circle', {
          cx: card.pos.x + CARD_W - 1, cy: rowY + COL_ROW_H / 2,
          r: CONNECTOR_R,
          fill: isPending ? '#20808D' : (isEndpoint ? '#20808D' : 'var(--color-border, #D4D1CA)'),
          stroke: '#fff', 'stroke-width': 1.5,
          style: 'cursor:crosshair;',
          'data-testid': `join-port-${card.id}-${col.name}`,
        });

        // Left dot for "to" connections
        const dotLeft = svgEl('circle', {
          cx: card.pos.x + 1, cy: rowY + COL_ROW_H / 2,
          r: CONNECTOR_R,
          fill: isEndpoint ? '#20808D' : 'var(--color-border, #D4D1CA)',
          stroke: '#fff', 'stroke-width': 1.5,
          style: 'cursor:crosshair;',
        });

        // Click anywhere on the row to toggle connection
        const handleColClick = (ev) => {
          ev.stopPropagation();
          dismissEdgeSelect();

          if (!pendingFrom) {
            // Start a new connection from this column
            pendingFrom = { cardId: card.id, col: col.name };
            drawCards();
            return;
          }

          if (pendingFrom.cardId === card.id) {
            // Same card — cancel
            pendingFrom = null;
            drawCards();
            return;
          }

          // Try to create the edge
          try {
            const newGraph = addEdge(graph, { from: pendingFrom, to: { cardId: card.id, col: col.name } });
            pendingFrom = null;
            onGraphChange(newGraph);
          } catch (err) {
            pendingFrom = null;
            drawCards();
            // Surface the error briefly via a transient SVG label
            const errLabel = svgEl('text', {
              x: card.pos.x + CARD_W / 2, y: card.pos.y - 10,
              'text-anchor': 'middle', 'font-size': 11,
              fill: 'var(--color-error, #A13544)',
              style: 'font-family:system-ui;',
            });
            errLabel.textContent = err.message;
            cardGroup.appendChild(errLabel);
            setTimeout(() => errLabel.remove(), 2500);
          }
        };

        rowBg.addEventListener('click', handleColClick);
        dot.addEventListener('click', handleColClick);
        dotLeft.addEventListener('click', handleColClick);

        g.appendChild(rowBg);
        g.appendChild(dotLeft);
        g.appendChild(colText);
        g.appendChild(typeText);
        g.appendChild(dot);
      });

      // ---- Card drag (pointer events on header) ----
      let dragging = false;
      let dragOffX = 0, dragOffY = 0;

      const headerHitArea = svgEl('rect', {
        x: card.pos.x, y: card.pos.y,
        width: CARD_W - 20, height: CARD_HEADER_H,
        fill: 'transparent',
        style: 'cursor:move;',
      });

      headerHitArea.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        dragging = true;
        const svgRect = svg.getBoundingClientRect();
        dragOffX = ev.clientX - svgRect.left + host.scrollLeft - card.pos.x;
        dragOffY = ev.clientY - svgRect.top  + host.scrollTop  - card.pos.y;
        headerHitArea.setPointerCapture(ev.pointerId);
      });

      headerHitArea.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        const svgRect = svg.getBoundingClientRect();
        const nx = Math.max(0, ev.clientX - svgRect.left + host.scrollLeft - dragOffX);
        const ny = Math.max(0, ev.clientY - svgRect.top  + host.scrollTop  - dragOffY);
        // Live-move: update position on the existing card element for smoothness,
        // commit to the model on pointerup.
        g.setAttribute('transform', `translate(${nx - card.pos.x}, ${ny - card.pos.y})`);
        // Redraw edges live
        const tempGraph = { ...graph, cards: graph.cards.map(c => c.id === card.id ? { ...c, pos: { x: nx, y: ny } } : c) };
        edgeGroup.innerHTML = '';
        drawEdgesFromGraph(tempGraph);
      });

      headerHitArea.addEventListener('pointerup', (ev) => {
        if (!dragging) return;
        dragging = false;
        const svgRect = svg.getBoundingClientRect();
        const nx = Math.max(0, ev.clientX - svgRect.left + host.scrollLeft - dragOffX);
        const ny = Math.max(0, ev.clientY - svgRect.top  + host.scrollTop  - dragOffY);
        onGraphChange(moveCard(graph, card.id, { x: nx, y: ny }));
      });

      g.appendChild(headerHitArea);
      cardGroup.appendChild(g);
    }
  }

  // Helper: draw edges from an arbitrary graph snapshot (used during live drag).
  function drawEdgesFromGraph(g) {
    for (const edge of g.edges) {
      const fromCard = getCard(g, edge.from.cardId);
      const toCard   = getCard(g, edge.to.cardId);
      if (!fromCard || !toCard) continue;
      const fromRight = fromCard.pos.x <= toCard.pos.x;
      const p1 = portPos(fromCard, edge.from.col, fromRight ? 'right' : 'left');
      const p2 = portPos(toCard,   edge.to.col,   fromRight ? 'left'  : 'right');
      const color = JOIN_COLORS[edge.type] || JOIN_COLORS.INNER;
      edgeGroup.appendChild(svgEl('path', {
        d: curvePath(p1.x, p1.y, p2.x, p2.y),
        fill: 'none', stroke: color, 'stroke-width': 2.5,
        'stroke-dasharray': edge.type === 'FULL' ? '6 3' : 'none',
      }));
    }
  }

  // Cancel pending connection on ESC or canvas click
  svg.addEventListener('click', () => {
    if (pendingFrom) { pendingFrom = null; drawCards(); }
    dismissEdgeSelect();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && pendingFrom) { pendingFrom = null; drawCards(); }
  }, { once: true }); // once so we don't pile up listeners across re-renders

  // Initial render
  drawEdges();
  drawCards();
  host.appendChild(svg);

  // Emit SQL immediately
  const { sql, warnings } = generateJoinSQL(graph);
  onSQLChange({ sql, warnings });
}

/**
 * Build the toolbar HTML (add-table selector, preview button, run button)
 * that sits above the canvas. Returns an HTMLElement.
 *
 * @param {object} opts
 * @param {import('./join-model.js').JoinGraph} opts.graph
 * @param {string[]} opts.availableTables  All table names from loaded datasets.
 * @param {import('./join-model.js').ColDef[][]} opts.tableColsMap  Map table->ColDef[].
 * @param {function} opts.onGraphChange
 * @param {function} opts.onRunSQL
 */
export function buildJoinToolbar({ graph, availableTables, tableColsMap, onGraphChange, onRunSQL }) {
  const toolbar = htmlEl('div', {
    style: {
      display: 'flex',
      gap: '8px',
      alignItems: 'center',
      padding: '8px 0 10px',
      flexWrap: 'wrap',
    },
  });

  // --- Add table selector ---
  const onCanvas = new Set(graph.cards.map(c => c.table));
  const remaining = availableTables.filter(t => !onCanvas.has(t));

  if (remaining.length > 0) {
    const sel = htmlEl('select', {
      style: { fontSize: '13px', padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--color-border)' },
      'data-testid': 'join-add-table-select',
    });
    const placeholder = htmlEl('option', { value: '' });
    placeholder.textContent = '+ Add table\u2026';
    sel.appendChild(placeholder);
    for (const t of remaining) {
      const opt = htmlEl('option', { value: t });
      opt.textContent = t;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      const table = sel.value;
      if (!table) return;
      const cols = tableColsMap[table] || [];
      try {
        onGraphChange(addCard(graph, { table, cols }));
      } catch (_) { /* table already on canvas */ }
      sel.value = '';
    });
    toolbar.appendChild(sel);
  } else if (availableTables.length === 0) {
    const note = htmlEl('span', { style: { fontSize: '13px', color: 'var(--color-text-muted)' } });
    note.textContent = 'Load datasets first to add tables.';
    toolbar.appendChild(note);
  } else {
    const note = htmlEl('span', { style: { fontSize: '13px', color: 'var(--color-text-muted)' } });
    note.textContent = 'All loaded tables are on the canvas.';
    toolbar.appendChild(note);
  }

  // --- Clear canvas button ---
  if (graph.cards.length > 0) {
    const clearBtn = htmlEl('button', {
      style: { fontSize: '13px', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer' },
      'data-testid': 'join-clear-btn',
      class: 'btn btn-secondary',
    });
    clearBtn.textContent = 'Clear canvas';
    clearBtn.addEventListener('click', () => {
      onGraphChange({ cards: [], edges: [] });
    });
    toolbar.appendChild(clearBtn);
  }

  // --- Run / Preview button ---
  if (graph.cards.length > 0) {
    const runBtn = htmlEl('button', {
      style: { fontSize: '13px', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer' },
      'data-testid': 'join-run-btn',
      class: 'btn btn-primary',
    });
    runBtn.textContent = 'Run query';
    runBtn.addEventListener('click', () => {
      const { sql } = generateJoinSQL(graph);
      if (sql && onRunSQL) onRunSQL(sql);
    });
    toolbar.appendChild(runBtn);
  }

  return toolbar;
}
