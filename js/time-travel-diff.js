// ============================================================
// DATAGLOW — Time-Travel Diff Mode
// ============================================================
// Loads a second dataset alongside the current one and auto-diffs at two levels:
//   (a) row-level    — keyed on an auto-detected (or user-picked) primary key:
//                      which rows were added, removed, or changed (field-level).
//   (b) aggregate    — reuses layer 18's Distributional Fingerprint Drift logic
//                      to show which columns' distributions shifted, plus which
//                      of the 18 validation layers flip PASS↔FAIL between the two
//                      dataset versions.
//
// Row/layer diffing is pure and Node-testable. The distributional diff reuses
// the exported computeDistributionFingerprint / compareDistributions from
// validation.js so there is a single source of truth for "drift".
// ============================================================

import { computeDistributionFingerprint, compareDistributions } from './validation.js';

// Pick the most likely primary key: prefer a column named like an id whose
// values are fully unique; otherwise the first fully-unique column. Returns
// null when no column uniquely identifies a row.
export function detectKeyColumn(columns, rows) {
  if (!rows || !rows.length) return null;
  const isUnique = (col) => {
    const seen = new Set();
    for (const r of rows) {
      const v = r[col];
      if (v == null) return false;
      const k = String(v);
      if (seen.has(k)) return false;
      seen.add(k);
    }
    return true;
  };
  const idLike = columns.filter(c => /(^|_)(id|key|code|number|no)$/i.test(c) || /^id$/i.test(c));
  for (const c of idLike) if (isUnique(c)) return c;
  for (const c of columns) if (isUnique(c)) return c;
  return null;
}

function indexByKey(rows, keyCol) {
  const m = new Map();
  for (const r of rows) m.set(String(r[keyCol]), r);
  return m;
}

function valuesEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

// Row-level diff keyed on keyCol. Returns keys added / removed and, for keys in
// both, the specific fields whose values changed. Pure.
export function diffRows(rowsA, rowsB, keyCol) {
  const a = indexByKey(rowsA, keyCol);
  const b = indexByKey(rowsB, keyCol);
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;

  for (const k of b.keys()) if (!a.has(k)) added.push(k);
  for (const k of a.keys()) if (!b.has(k)) removed.push(k);

  for (const [k, ra] of a) {
    if (!b.has(k)) continue;
    const rb = b.get(k);
    const cols = new Set([...Object.keys(ra), ...Object.keys(rb)]);
    const fields = [];
    for (const col of cols) {
      if (col === keyCol) continue;
      if (!valuesEqual(ra[col], rb[col])) fields.push({ column: col, from: ra[col] ?? null, to: rb[col] ?? null });
    }
    if (fields.length) changed.push({ key: k, fields });
    else unchanged++;
  }

  return { keyColumn: keyCol, added, removed, changed, unchanged, countA: rowsA.length, countB: rowsB.length };
}

// Compare which validation layers flip PASS↔FAIL between the two runs. Pure.
// Confidence is compared on its status field like the other layers.
export function diffLayerStatuses(resultsA, resultsB) {
  const flips = [];
  const statusOf = (res, id) => {
    const r = res[id];
    if (!r) return 'idle';
    return r.status || 'idle';
  };
  const ids = new Set([...Object.keys(resultsA || {}), ...Object.keys(resultsB || {})]);
  for (const id of ids) {
    const from = statusOf(resultsA, id);
    const to = statusOf(resultsB, id);
    if (from === to) continue;
    const isFlip = (from === 'pass' && to === 'fail') || (from === 'fail' && to === 'pass');
    flips.push({ layer: id, from, to, passFailFlip: isFlip });
  }
  return flips;
}

// Distributional diff: fingerprint both tables over their shared numeric /
// categorical columns and report the drift strings from layer 18's comparator.
// Engine-backed — reuses the exact same logic the Distribution Drift layer runs.
// Both tables live in the shared DuckDB connection, so no engine plumbing is
// needed here beyond the columns list.
export async function diffDistributions(tableA, tableB, cols) {
  const fpA = await computeDistributionFingerprint(tableA, cols);
  const fpB = await computeDistributionFingerprint(tableB, cols);
  return { drifts: compareDistributions(fpA, fpB), fingerprintA: fpA, fingerprintB: fpB };
}
