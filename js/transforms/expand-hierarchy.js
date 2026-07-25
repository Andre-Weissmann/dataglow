// ============================================================
// DATAGLOW - A16 Expand hierarchy (who reports to whom, and how far down)
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. "How deep is this org?", "which accounts roll up to that
// one?", "what is the full path from the root to this category?" A parent/child
// table holds the answer but does not show it: every row knows its own parent
// and nothing else. This walks the edges and gives each node its depth, its
// root, and its full path.
//
// TWO INPUT SHAPES, ONE OUTPUT.
// Edge form is two columns, node and parent, one row per node. Path form is one
// column holding an already-joined string, "Food/Produce/Apples". Both are
// common and neither is more correct, so both are read. Path form is also the
// output of A16 on edge form, which means a table can be exported, reloaded and
// re-expanded without changing meaning.
//
// CYCLES ARE THE REASON THIS IS NOT A ONE-LINER.
// A recursive CTE over a cyclic edge list does not return a wrong answer, it
// runs until the engine gives up. Real parent/child data has cycles more often
// than anyone expects: a self-referencing row from a bad merge, two managers who
// each report to the other after a reorg, a category that was re-parented into
// its own subtree. So the walk carries the set of nodes already visited on the
// current path and stops when it meets one again. Those nodes are not dropped
// and not guessed at: they are emitted with the depth reached, marked, counted,
// and named in the notes. A hierarchy tool that hangs tells you nothing; one
// that says "these three rows form a loop" tells you where the data is broken.
//
// AN ORPHAN IS NOT A ROOT.
// A node whose parent id is not in the table is not the top of the tree, it is a
// row whose parent is missing. Calling it a root would silently repair the data
// and hide the gap. It is given depth 0 so the output is still usable, and then
// counted and reported separately from the genuine roots.

import {
  quoteIdent,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  isPlainObject,
  column,
  typeOfColumn,
  TYPE_INT,
  TYPE_STR,
  TYPE_BOOL,
  transformResult,
  transformError,
} from './transform-core.js';

export const EXPAND_HIERARCHY_VERSION = 1;

// Edge form is two columns (node, parent). Path form is one column holding a
// delimited string. Kept to these two because a third shape (adjacency plus a
// separate closure table) needs a second table and belongs with the joins.
export const HIERARCHY_SOURCES = Object.freeze(['edges', 'path']);

export const HIERARCHY_SOURCE_LABELS = Object.freeze({
  edges: 'Parent and child columns',
  path: 'One column holding a full path',
});

// A hierarchy deeper than this in real business data is nearly always a cycle
// the visited-set did not catch because the ids differ by whitespace or case.
// The walk stops and says so rather than building a million-row path string.
export const MAX_DEPTH = 256;

export function createEmptyHierarchyConfig() {
  return {
    source: 'edges',
    nodeColumn: '',
    parentColumn: '',
    pathColumn: '',
    pathDelimiter: '/',
    includePath: true,
    includeIsLeaf: true,
    includeRoot: true,
  };
}

export function suggestHierarchyConfig(dataset) {
  const cfg = createEmptyHierarchyConfig();
  const names = columnNamesOf(dataset);

  const pathCol = pickByHint(names, ['path', 'hierarchy', 'breadcrumb', 'lineage']);
  const parentCol = pickByHint(names, ['parent', 'manager', 'reports_to', 'reportsto', 'parent_id']);
  const nodeCol = pickByHint(names, ['id', 'node', 'employee', 'code', 'name']);

  // A parent column is the stronger signal: a column called "path" is sometimes
  // a file path, but a column called "parent_id" beside an id column is almost
  // always an edge list.
  if (parentCol) {
    cfg.source = 'edges';
    cfg.parentColumn = parentCol;
    cfg.nodeColumn = (nodeCol && nodeCol !== parentCol) ? nodeCol : (names.filter((n) => n !== parentCol)[0] || '');
  } else if (pathCol) {
    cfg.source = 'path';
    cfg.pathColumn = pathCol;
  } else {
    cfg.source = 'edges';
    cfg.nodeColumn = names[0] || '';
    cfg.parentColumn = names[1] || '';
  }
  return cfg;
}

function pickByHint(names, hints) {
  for (let h = 0; h < hints.length; h += 1) {
    for (let i = 0; i < names.length; i += 1) {
      if (String(names[i] || '').toLowerCase() === hints[h]) return names[i];
    }
  }
  for (let h = 0; h < hints.length; h += 1) {
    for (let i = 0; i < names.length; i += 1) {
      if (String(names[i] || '').toLowerCase().includes(hints[h])) return names[i];
    }
  }
  return null;
}

export function validateHierarchyConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  if (HIERARCHY_SOURCES.indexOf(config.source) === -1) {
    errors.push('Choose whether the hierarchy is in parent and child columns or in one path column.');
    return { ok: false, errors: errors };
  }

  if (config.source === 'path') {
    if (!config.pathColumn) errors.push('Pick the column that holds the path.');
    else if (!names.includes(config.pathColumn)) {
      errors.push('The path column ' + config.pathColumn + ' is not in this table.');
    }
    if (!String(config.pathDelimiter || '')) {
      errors.push('Give the character that separates the levels, such as / or >.');
    }
  } else {
    if (!config.nodeColumn) errors.push('Pick the column that identifies each row.');
    else if (!names.includes(config.nodeColumn)) {
      errors.push('The column ' + config.nodeColumn + ' is not in this table.');
    }
    if (!config.parentColumn) errors.push('Pick the column that holds the parent.');
    else if (!names.includes(config.parentColumn)) {
      errors.push('The parent column ' + config.parentColumn + ' is not in this table.');
    }
    if (config.nodeColumn && config.nodeColumn === config.parentColumn) {
      errors.push('The row column and the parent column have to be different columns.');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

/** The columns A16 appends, in order. Named here so the SQL, the transform and
    a test cannot drift apart about what comes out. */
export function hierarchyOutputColumns(config) {
  const out = [column('depth', TYPE_INT)];
  if (!config || config.source !== 'path') out.push(column('parent_node', TYPE_STR));
  if (!config || config.includeRoot !== false) out.push(column('root_node', TYPE_STR));
  if (!config || config.includePath !== false) out.push(column('node_path', TYPE_STR));
  if (!config || config.includeIsLeaf !== false) out.push(column('is_leaf', TYPE_BOOL));
  out.push(column('in_cycle', TYPE_BOOL));
  return out;
}

/**
 * The glass-box SQL. A recursive CTE for the edge form, because that is what a
 * person checking this would write, with the cycle guard shown rather than
 * assumed: the `NOT list_contains` line is the whole reason this terminates.
 */
export function buildHierarchySQL(config, sourceRelation) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const t = relationName(sourceRelation, 'source');

  if (config.source === 'path') {
    const p = quoteIdent(config.pathColumn);
    const d = String(config.pathDelimiter || '/');
    const lit = "'" + d.replace(/'/g, "''") + "'";
    const lines = [
      '-- Expand a path column into node, parent and depth.',
      '-- str_split turns the path into a list, so depth is just its length and the',
      '-- parent is the path with the last element removed.',
      'SELECT',
      '  *,',
      '  len(str_split(' + p + ', ' + lit + ')) - 1 AS depth,',
      '  str_split(' + p + ', ' + lit + ')[1] AS root_node,',
      '  ' + p + ' AS node_path,',
      '  list_aggregate(',
      '    str_split(' + p + ', ' + lit + ')[1:-2], ' + "'string_agg', " + lit,
      '  ) AS parent_path',
      'FROM ' + t,
    ];
    return { ok: true, sql: lines.join('\n') };
  }

  const n = quoteIdent(config.nodeColumn);
  const pa = quoteIdent(config.parentColumn);
  const dl = "'" + String(config.pathDelimiter || '/').replace(/'/g, "''") + "'";
  const lines = [
    '-- Expand a parent/child edge list into depth, root and full path.',
    '-- The seed is every row whose parent is null or names a row that is not in',
    '-- this table. An orphan is seeded here too, and is NOT the same thing as a',
    '-- root: see the "orphan" note on the result.',
    'WITH RECURSIVE tree AS (',
    '  SELECT',
    '    c.*,',
    '    0 AS depth,',
    '    CAST(c.' + n + ' AS VARCHAR) AS root_node,',
    '    CAST(c.' + n + ' AS VARCHAR) AS node_path,',
    '    [CAST(c.' + n + ' AS VARCHAR)] AS seen',
    '  FROM ' + t + ' AS c',
    '  WHERE c.' + pa + ' IS NULL',
    '     OR NOT EXISTS (SELECT 1 FROM ' + t + ' AS p WHERE p.' + n + ' = c.' + pa + ')',
    '',
    '  UNION ALL',
    '',
    '  SELECT',
    '    c.*,',
    '    t.depth + 1,',
    '    t.root_node,',
    '    t.node_path || ' + dl + ' || CAST(c.' + n + ' AS VARCHAR),',
    '    list_append(t.seen, CAST(c.' + n + ' AS VARCHAR))',
    '  FROM ' + t + ' AS c',
    '  JOIN tree AS t ON c.' + pa + ' = t.' + n,
    '  -- The cycle guard. Without this line a self-referencing row or a',
    '  -- reorg loop does not give a wrong answer, it never finishes.',
    '  WHERE NOT list_contains(t.seen, CAST(c.' + n + ' AS VARCHAR))',
    '    AND t.depth < ' + MAX_DEPTH,
    ')',
    'SELECT',
    '  * EXCLUDE (seen),',
    '  NOT EXISTS (SELECT 1 FROM ' + t + ' AS k WHERE k.' + pa + ' = tree.' + n + ') AS is_leaf',
    'FROM tree',
    'ORDER BY node_path',
  ];
  return { ok: true, sql: lines.join('\n') };
}

export function expandHierarchyTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateHierarchyConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const rows = rowsOf(dataset);
  const built = buildHierarchySQL(config, dataset.name);
  const sql = built.ok ? built.sql : '';

  const computed = config.source === 'path'
    ? walkPaths(rows, names, config)
    : walkEdges(rows, names, config);

  const baseColumns = names.map((n) => column(n, typeOfColumn(dataset, n)));
  const outColumns = baseColumns.concat(hierarchyOutputColumns(config));

  return transformResult({
    columns: outColumns,
    rows: computed.rows,
    sql: sql,
    stats: computed.stats,
    notes: computed.notes,
  });
}

/* ------------------------------ edge form -------------------------------- */

function walkEdges(rows, names, config) {
  const nodeIdx = indexOfColumn(names, config.nodeColumn);
  const parentIdx = indexOfColumn(names, config.parentColumn);
  const delim = String(config.pathDelimiter || '/');

  // Index by node id. A duplicate id is a genuine defect: the tree it describes
  // is ambiguous, so the first row wins and the rest are counted and reported
  // rather than silently producing two subtrees under one name.
  const byNode = new Map();
  const childrenOf = new Map();
  let duplicateNodes = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const id = idOf(row[nodeIdx]);
    if (id === null) continue;
    if (byNode.has(id)) { duplicateNodes += 1; continue; }
    byNode.set(id, { row: row, index: i });
  }

  for (const entry of byNode.values()) {
    const parent = idOf(entry.row[parentIdx]);
    const key = parent !== null && byNode.has(parent) ? parent : null;
    let list = childrenOf.get(key);
    if (!list) { list = []; childrenOf.set(key, list); }
    list.push(entry);
  }

  let roots = 0;
  let orphans = 0;
  const seeds = childrenOf.get(null) || [];
  for (let i = 0; i < seeds.length; i += 1) {
    const parent = idOf(seeds[i].row[parentIdx]);
    if (parent === null) roots += 1; else orphans += 1;
  }

  const out = [];
  let maxDepth = 0;
  let leaves = 0;
  let cycleNodes = 0;
  let depthCapped = 0;
  const cycleNames = [];
  const emitted = new Set();

  // Iterative rather than recursive: a 20,000-row org chart is not deep, but a
  // pathological chain is, and blowing the JS stack in the browser would take
  // the whole page down rather than just this transform.
  const stack = [];
  for (let i = seeds.length - 1; i >= 0; i -= 1) {
    stack.push({ entry: seeds[i], depth: 0, path: [], ancestors: null });
  }

  while (stack.length) {
    const frame = stack.pop();
    const entry = frame.entry;
    const id = idOf(entry.row[nodeIdx]);
    const path = frame.path.concat([id === null ? '' : String(id)]);
    const ancestors = frame.ancestors ? new Set(frame.ancestors) : new Set();

    const looped = ancestors.has(id);
    if (looped) {
      cycleNodes += 1;
      if (cycleNames.length < 3 && id !== null) cycleNames.push(String(id));
    }
    ancestors.add(id);

    // is_leaf is read from the edge list, not from whether the walk descended.
    // A node the walk stopped at because it closed a loop still has children,
    // and calling it a leaf would turn a defect into a tidy-looking fact.
    const kids = childrenOf.get(id) || [];
    const atCap = frame.depth >= MAX_DEPTH;
    if (atCap && kids.length) depthCapped += 1;

    emitted.add(id);
    if (frame.depth > maxDepth) maxDepth = frame.depth;
    if (kids.length === 0) leaves += 1;

    const parentRaw = entry.row[parentIdx];
    const extras = [frame.depth];
    extras.push(parentRaw == null ? null : String(parentRaw));
    if (config.includeRoot !== false) extras.push(path[0]);
    if (config.includePath !== false) extras.push(path.join(delim));
    if (config.includeIsLeaf !== false) extras.push(kids.length === 0);
    extras.push(looped);
    out.push(entry.row.concat(extras));

    if (!atCap && !looped) {
      for (let k = kids.length - 1; k >= 0; k -= 1) {
        stack.push({ entry: kids[k], depth: frame.depth + 1, path: path, ancestors: ancestors });
      }
    }
  }

  // Anything never reached is inside a cycle with no entry point from a root:
  // a closed loop. It has no depth that means anything, so it is emitted at the
  // end, marked, rather than being dropped from the table.
  let unreachable = 0;
  for (const [id, entry] of byNode) {
    if (emitted.has(id)) continue;
    unreachable += 1;
    if (cycleNames.length < 3 && id !== null) cycleNames.push(String(id));
    const parentRaw = entry.row[parentIdx];
    const extras = [null];
    extras.push(parentRaw == null ? null : String(parentRaw));
    if (config.includeRoot !== false) extras.push(null);
    if (config.includePath !== false) extras.push(null);
    if (config.includeIsLeaf !== false) extras.push(false);
    extras.push(true);
    out.push(entry.row.concat(extras));
  }

  const notes = [];
  if (orphans > 0) {
    notes.push(orphans + ' row' + (orphans === 1 ? '' : 's') + ' name a parent that is not in this '
      + 'table. They are shown at depth 0 so the result is still usable, but they are not roots: '
      + 'their parent is missing, which is a gap in the data rather than the top of the tree.');
  }
  if (cycleNodes > 0 || unreachable > 0) {
    const total = cycleNodes + unreachable;
    notes.push(total + ' row' + (total === 1 ? '' : 's') + ' are part of a loop, where a node ends '
      + 'up under itself'
      + (cycleNames.length ? ' (' + cycleNames.join(', ') + ')' : '')
      + '. The walk stopped at the repeat instead of running forever, and those rows are marked '
      + 'in the in_cycle column. A loop is a defect in the parent column, not a deep hierarchy.');
  }
  if (duplicateNodes > 0) {
    notes.push(duplicateNodes + ' row' + (duplicateNodes === 1 ? '' : 's') + ' repeat an id that '
      + 'another row already used. The first was kept. Two rows with one id describe two different '
      + 'trees and this table cannot say which is meant.');
  }
  if (depthCapped > 0) {
    notes.push('The walk stopped at ' + MAX_DEPTH + ' levels deep in ' + depthCapped + ' place'
      + (depthCapped === 1 ? '' : 's') + '. Anything genuinely that deep is worth checking for '
      + 'ids that differ only by spacing or capitalisation.');
  }

  return {
    rows: out,
    notes: notes,
    stats: {
      rowsIn: rows.length,
      rowsOut: out.length,
      nodes: byNode.size,
      roots: roots,
      orphans: orphans,
      maxDepth: maxDepth,
      leaves: leaves,
      cycleNodes: cycleNodes + unreachable,
      duplicateNodes: duplicateNodes,
    },
  };
}

function idOf(value) {
  if (value == null || value === '') return null;
  return String(value);
}

/* ------------------------------ path form -------------------------------- */

function walkPaths(rows, names, config) {
  const pathIdx = indexOfColumn(names, config.pathColumn);
  const delim = String(config.pathDelimiter || '/');

  const out = [];
  let maxDepth = 0;
  let unreadable = 0;
  const parents = new Set();
  const seenPaths = new Set();

  const parsed = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const raw = row[pathIdx];
    const text = raw == null ? '' : String(raw);
    // Empty segments are dropped rather than counted as levels: "a//b" and
    // "a/b" describe the same place, and a trailing slash is a formatting habit,
    // not an extra level of hierarchy.
    const parts = text.split(delim).map((s) => s.trim()).filter((s) => s !== '');
    if (!parts.length) { unreadable += 1; }
    parsed.push({ row: row, parts: parts });
    if (parts.length > 1) parents.add(parts.slice(0, -1).join(delim));
    seenPaths.add(parts.join(delim));
  }

  for (let i = 0; i < parsed.length; i += 1) {
    const parts = parsed[i].parts;
    const depth = parts.length ? parts.length - 1 : null;
    if (depth !== null && depth > maxDepth) maxDepth = depth;
    const full = parts.join(delim);
    const extras = [depth];
    if (config.includeRoot !== false) extras.push(parts.length ? parts[0] : null);
    if (config.includePath !== false) extras.push(parts.length ? full : null);
    if (config.includeIsLeaf !== false) extras.push(parts.length ? !parents.has(full) : null);
    extras.push(false);
    out.push(parsed[i].row.concat(extras));
  }

  const notes = [];
  if (unreadable > 0) {
    notes.push(unreadable + ' row' + (unreadable === 1 ? '' : 's') + ' have a blank path, so they '
      + 'have no depth. They are kept with blank hierarchy columns rather than being dropped or '
      + 'placed at the root.');
  }
  // Depth is derived from the string alone, so a level that no row names
  // directly is invisible here in a way it would not be in edge form.
  const implied = [];
  for (const p of parents) {
    if (!seenPaths.has(p) && implied.length < 3) implied.push(p);
  }
  if (implied.length) {
    notes.push('Some levels appear only inside other rows\' paths and have no row of their own ('
      + implied.join(', ') + '). Depth here counts the separators in each path, so those levels '
      + 'are counted but you cannot select them as rows.');
  }

  return {
    rows: out,
    notes: notes,
    stats: {
      rowsIn: rows.length,
      rowsOut: out.length,
      nodes: out.length,
      roots: 0,
      orphans: 0,
      maxDepth: maxDepth,
      leaves: out.length - parents.size,
      cycleNodes: 0,
      duplicateNodes: 0,
    },
  };
}

/** One plain sentence for the panel header. */
export function describeHierarchy(result) {
  if (!result || !result.ok) return 'This expansion did not run.';
  const s = result.stats || {};
  if (!s.rowsIn) return 'The table has no rows, so there is no hierarchy to expand.';
  const depth = 'The deepest branch is ' + (s.maxDepth || 0) + ' level'
    + ((s.maxDepth || 0) === 1 ? '' : 's') + ' below the top.';
  if (s.cycleNodes > 0) {
    return depth + ' ' + s.cycleNodes + ' row' + (s.cycleNodes === 1 ? ' is' : 's are')
      + ' in a loop and could not be placed.';
  }
  if (s.orphans > 0) {
    return depth + ' ' + s.orphans + ' row' + (s.orphans === 1 ? '' : 's')
      + ' name a parent that is not in this table.';
  }
  return depth + ' ' + (s.roots || 0) + ' top-level row'
    + ((s.roots || 0) === 1 ? '' : 's') + ', ' + (s.rowsOut || 0) + ' rows out.';
}

export const DataGlowExpandHierarchy = {
  EXPAND_HIERARCHY_VERSION,
  HIERARCHY_SOURCES,
  HIERARCHY_SOURCE_LABELS,
  MAX_DEPTH,
  createEmptyHierarchyConfig,
  suggestHierarchyConfig,
  validateHierarchyConfig,
  hierarchyOutputColumns,
  buildHierarchySQL,
  expandHierarchyTransform,
  describeHierarchy,
};
