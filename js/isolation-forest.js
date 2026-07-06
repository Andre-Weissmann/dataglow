// ============================================================
// DATAGLOW — Isolation Forest (multivariate outlier detection)
// ============================================================
// Isolation Forest, Liu, Ting & Zhou 2008 ("Isolation Forest", ICDM 2008,
// public academic algorithm). Anomalies are few and different, so random
// axis-parallel splits isolate them in shorter tree paths. The anomaly
// score is s(x,n) = 2^(-E(h(x)) / c(n)), where c(n) is the average path
// length of an unsuccessful BST search. Pure JS, no ML dependency.

const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];

const N_TREES = 64;
const SUBSAMPLE = 256;
const SCORE_THRESHOLD = 0.6; // > 0.5 leans anomalous; 0.6 keeps it conservative

// Average path length of an unsuccessful search in a BST of n nodes.
function cFactor(n) {
  if (n <= 1) return 0;
  return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1) / n);
}

function buildTree(points, cols, depth, maxDepth) {
  const n = points.length;
  if (depth >= maxDepth || n <= 1) {
    return { type: 'leaf', size: n };
  }
  // Pick a random feature and a random split value within its observed range.
  const col = cols[Math.floor(Math.random() * cols.length)];
  let min = Infinity, max = -Infinity;
  for (const p of points) {
    const v = p[col];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return { type: 'leaf', size: n };
  const splitValue = min + Math.random() * (max - min);
  const left = [], right = [];
  for (const p of points) {
    (p[col] < splitValue ? left : right).push(p);
  }
  return {
    type: 'node',
    col,
    splitValue,
    left: buildTree(left, cols, depth + 1, maxDepth),
    right: buildTree(right, cols, depth + 1, maxDepth),
  };
}

function pathLength(point, node, depth) {
  if (node.type === 'leaf') {
    return depth + cFactor(node.size);
  }
  return point[node.col] < node.splitValue
    ? pathLength(point, node.left, depth + 1)
    : pathLength(point, node.right, depth + 1);
}

function sample(arr, k) {
  if (arr.length <= k) return arr.slice();
  const copy = arr.slice();
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, k);
}

export async function scoreIsolationForest(table, numericCols, engine, options = {}) {
  const names = (numericCols || [])
    .map(c => (typeof c === 'string' ? c : c.name))
    .filter(Boolean);
  if (names.length === 0) return { rows: [], columns: [] };

  const selectList = names.map(n => `"${n}"`).join(', ');
  const { rows } = await engine.runQuery(`SELECT ${selectList} FROM ${table}`);
  // Keep only fully-numeric rows for the forest.
  const points = [];
  const originalIndex = [];
  rows.forEach((r, idx) => {
    const p = {};
    let ok = true;
    for (const n of names) {
      const v = Number(r[n]);
      if (!Number.isFinite(v)) { ok = false; break; }
      p[n] = v;
    }
    if (ok) { points.push(p); originalIndex.push(idx); }
  });
  if (points.length < 4) return { rows: [], columns: names };

  const subN = Math.min(SUBSAMPLE, points.length);
  const maxDepth = Math.ceil(Math.log2(subN));
  const trees = [];
  for (let t = 0; t < N_TREES; t++) {
    trees.push(buildTree(sample(points, subN), names, 0, maxDepth));
  }

  const c = cFactor(subN);
  const scored = points.map((p, i) => {
    let sum = 0;
    for (const tree of trees) sum += pathLength(p, tree, 0);
    const avgPath = sum / trees.length;
    const score = c > 0 ? Math.pow(2, -avgPath / c) : 0;
    return {
      rowIndex: originalIndex[i],
      anomalyScore: Number(score.toFixed(4)),
      isAnomaly: score > (options.threshold || SCORE_THRESHOLD),
      values: Object.fromEntries(names.map(n => [n, p[n]])),
    };
  });
  scored.sort((a, b) => b.anomalyScore - a.anomalyScore);
  return { rows: scored, columns: names };
}
