// ============================================================
// DATAGLOW — Source Convergence (Batch 1 of 3): the convergence engine
// ============================================================
// Real analyses rarely live in one table. The same real-world entity — a claim,
// a member, an encounter — shows up in a roster export, a CMS eligibility file,
// an adjudication feed, and a finance ledger, each with its OWN version of the
// truth. DataGlow's validation layers, including Cross-Column Logical
// Consistency (js/validation/cross-column-consistency.js), only ever reason
// WITHIN one table, so when two sources disagree about the same field nothing
// notices. Source Convergence is the concept that reconciles N sources at once:
// join them on whatever keys they share (directly OR transitively through an
// intermediate source), cluster the rows that describe the same entity, surface
// where the sources agree and where they conflict, and — where a trust ordering
// gives an honest basis — auto-resolve the conflict, escalating the rest to a
// human. It supersedes the earlier two-table "Cross-Table Relational Rules"
// concept (reverted in PR #200): the real gap is N-way convergence, not a fixed
// pair. See NORTH_STAR.md, "Concept in progress: Source Convergence".
//
// This file is Batch 1: the PURE, DOM-free, dependency-free, Node-testable
// engine only. No Excel/API/site ingestion (Batch 2), no UI (Batch 3), no
// wiring into any shipping path. It ships dark behind the `sourceConvergence`
// flag (default false) — with the flag off nothing imports this module, so
// every existing path is byte-for-byte unchanged.
//
// DISCIPLINE (matches the existing validation + diplomacy modules):
//   - pure functions, no side effects, no DOM, no async, no network;
//   - NEVER throws — malformed/empty input returns a safe idle/empty result
//     (mirroring reconcileClaims()' "always return a well-formed object" and the
//     never-thrown-state discipline of js/rooms/room-signaling.js);
//   - the trust resolver REFUSES to pick a side without an honest margin,
//     escalating to a human instead of inventing a winner — the exact stance
//     js/diplomacy/reconciliation-engine.js takes for two sealed claims.
// ============================================================

export const DEFAULT_MARGIN_THRESHOLD = 0.15;

// ---------- small, total helpers (never throw) ----------

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isArrayOfRows(v) {
  return Array.isArray(v) && v.every(isPlainObject);
}

// Canonicalize one "possible key" into a sorted array of column names, so that
// a single string 'claim_id' becomes ['claim_id'] and a composite
// ['patient_id','date_of_service'] compares equal regardless of the order the
// two sources happened to list its columns. Returns null for anything unusable.
export function canonicalizeKey(key) {
  if (typeof key === 'string') {
    const s = key.trim();
    return s === '' ? null : [s];
  }
  if (Array.isArray(key)) {
    const cols = key.filter(c => typeof c === 'string' && c.trim() !== '').map(c => c.trim());
    if (cols.length === 0) return null;
    return [...cols].sort();
  }
  return null;
}

// A stable string id for a canonical key (its columns joined). Used as a Map key.
function keyId(canonKey) {
  return canonKey.join('␟'); // ␟ unit separator, unlikely in a column name
}

// Normalize a single cell value for equality comparison. Numbers compare
// numerically (so 412 and "412.00" agree); everything else is trimmed and
// lower-cased. Nullish / blank returns null (not a usable value).
export function normalizeValue(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? `n:${v}` : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Treat a purely-numeric string as a number so "412.00" === 412.
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return `n:${n}`;
  }
  return `s:${s.toLowerCase()}`;
}

// The join value a row contributes for a canonical key: the row's values for
// every column of the key, in canonical order. Returns null if ANY key column
// is missing/blank on the row (a partial composite key never joins).
function joinValueForKey(row, canonKey) {
  const parts = [];
  for (const col of canonKey) {
    const nv = normalizeValue(row[col]);
    if (nv == null) return null;
    parts.push(nv);
  }
  return parts.join('␞'); // ␞ record separator between composite columns
}

// A finite numeric trust for a source, or null when absent/unusable.
function trustOf(sourceTrust, sourceId) {
  if (!isPlainObject(sourceTrust) || sourceId == null) return null;
  const v = sourceTrust[sourceId];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

// ============================================================
// buildConvergenceGraph(sources)
// sources: [{ id, rows, possibleKeys }]
//   possibleKeys: array of column names or composite-key arrays this source can
//   join on, e.g. ['claim_id'] or [['patient_id','date_of_service']].
//
// Returns (success):
//   { evaluated:true, reason:null, sources:[id...], keys:{id:[canonKey...]},
//     edges:[{a,b,sharedKeys:[canonKey...]}], components:[[id...]...] }
// Returns (bad input): { sources:[], edges:[], evaluated:false, reason }
// NEVER throws.
// ============================================================
export function buildConvergenceGraph(sources) {
  try {
    if (!Array.isArray(sources) || sources.length === 0) {
      return idleGraph('sources must be a non-empty array of { id, rows, possibleKeys }');
    }

    const ids = [];
    const keysById = new Map();      // id -> [canonKey...]
    const keyIdsById = new Map();    // id -> Set(keyId)
    const seenIds = new Set();
    for (const s of sources) {
      if (!isPlainObject(s) || s.id == null) {
        return idleGraph('every source needs an id and must be an object');
      }
      const id = String(s.id);
      if (seenIds.has(id)) return idleGraph(`duplicate source id: ${id}`);
      seenIds.add(id);
      if (!isArrayOfRows(s.rows)) {
        return idleGraph(`source "${id}" rows must be an array of row objects`);
      }
      const canon = [];
      const canonIds = new Set();
      for (const k of Array.isArray(s.possibleKeys) ? s.possibleKeys : []) {
        const ck = canonicalizeKey(k);
        if (ck && !canonIds.has(keyId(ck))) { canon.push(ck); canonIds.add(keyId(ck)); }
      }
      ids.push(id);
      keysById.set(id, canon);
      keyIdsById.set(id, canonIds);
    }

    // Direct edges: a pair of sources shares an edge when they list ≥1 identical
    // canonical key.
    const edges = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const aKeys = keysById.get(a);
        const bIds = keyIdsById.get(b);
        const shared = aKeys.filter(ck => bIds.has(keyId(ck)));
        if (shared.length > 0) edges.push({ a, b, sharedKeys: shared });
      }
    }

    // Connected components via union-find — this is what turns direct edges into
    // TRANSITIVE joins (A↔B and B↔C put A, B, C in one component even when A and
    // C share no key directly).
    const components = connectedComponents(ids, edges);

    return {
      evaluated: true,
      reason: null,
      sources: ids,
      keys: Object.fromEntries(ids.map(id => [id, keysById.get(id)])),
      edges,
      components,
    };
  } catch (e) {
    return idleGraph(`unevaluable input: ${e && e.message ? e.message : 'unknown error'}`);
  }
}

function idleGraph(reason) {
  return { sources: [], edges: [], components: [], keys: {}, evaluated: false, reason };
}

// ---------- union-find ----------
function makeUF() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  return { find, union, parent };
}

function connectedComponents(ids, edges) {
  const uf = makeUF();
  for (const id of ids) uf.find(id);
  for (const e of edges) uf.union(e.a, e.b);
  const groups = new Map();
  for (const id of ids) {
    const r = uf.find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(id);
  }
  return [...groups.values()].map(g => g.sort());
}

// ============================================================
// computeConvergenceClusters(graph, sources)
// Groups rows across all reachable sources into clusters — each cluster is one
// real-world entity, formed by chaining rows that share a join value on any
// shared key (directly or transitively). For each cluster it reports the
// coverage pattern (which sources contain it) and, for every column present in
// 2+ sources, whether the sources agree or conflict.
//
// Returns an ARRAY of cluster objects (empty array on bad input; never throws):
//   {
//     id, joinKeys:[{key,value}], sourceIds:[...], coverageCount, rowCount,
//     rows:[{sourceId, row}], fields:[{column,status,contributions,distinctValues}],
//     conflicts:[...fields with status 'conflict'], hasConflict
//   }
// ============================================================
export function computeConvergenceClusters(graph, sources) {
  try {
    if (!isPlainObject(graph) || graph.evaluated !== true) return [];
    if (!Array.isArray(sources) || sources.length === 0) return [];

    // Re-derive the source lookup + canonical keys defensively from `sources`,
    // trusting `graph` only for the edge/key topology it already validated.
    const byId = new Map();
    for (const s of sources) {
      if (!isPlainObject(s) || s.id == null || !isArrayOfRows(s.rows)) return [];
      byId.set(String(s.id), s.rows);
    }

    // Every row is a node: `${sourceId} ${index}`.
    const nodeKey = (sid, idx) => `${sid} ${idx}`;
    const uf = makeUF();
    for (const [sid, rows] of byId) rows.forEach((_, idx) => uf.find(nodeKey(sid, idx)));

    // Track, per (source, key), the row indices at each join value, and link
    // rows across every edge that shares that key + value.
    const canonKeysById = graph.keys || {};
    const indexFor = (sid, canonKey) => {
      const rows = byId.get(sid) || [];
      const m = new Map();
      const kid = keyId(canonKey);
      rows.forEach((row, idx) => {
        const jv = joinValueForKey(row, canonKey);
        if (jv == null) return;
        const bucket = `${kid} ${jv}`;
        if (!m.has(bucket)) m.set(bucket, []);
        m.get(bucket).push({ idx, value: jv });
      });
      return m;
    };

    // Record the join key+value that linked each node, for cluster provenance.
    const nodeJoinInfo = new Map(); // node -> Set("keyColsJoined␟value")

    for (const e of Array.isArray(graph.edges) ? graph.edges : []) {
      for (const canonKey of e.sharedKeys || []) {
        const ai = indexFor(e.a, canonKey);
        const bi = indexFor(e.b, canonKey);
        for (const [bucket, aRows] of ai) {
          const bRows = bi.get(bucket);
          if (!bRows) continue;
          for (const ar of aRows) {
            const an = nodeKey(e.a, ar.idx);
            recordJoin(nodeJoinInfo, an, canonKey, ar.value);
            for (const br of bRows) {
              const bn = nodeKey(e.b, br.idx);
              recordJoin(nodeJoinInfo, bn, canonKey, br.value);
              uf.union(an, bn);
            }
          }
        }
      }
    }

    // Collect members per cluster root.
    const clustersByRoot = new Map();
    for (const [sid, rows] of byId) {
      rows.forEach((row, idx) => {
        const node = nodeKey(sid, idx);
        const root = uf.find(node);
        if (!clustersByRoot.has(root)) clustersByRoot.set(root, []);
        clustersByRoot.get(root).push({ sourceId: sid, row, node });
      });
    }

    const clusters = [];
    let n = 0;
    for (const members of clustersByRoot.values()) {
      const sourceIds = [...new Set(members.map(m => m.sourceId))].sort();
      const joinKeys = collectJoinKeys(members, nodeJoinInfo, canonKeysById);
      const fields = compareFields(members);
      const conflicts = fields.filter(f => f.status === 'conflict');
      clusters.push({
        id: `cluster-${n++}`,
        joinKeys,
        sourceIds,
        coverageCount: sourceIds.length,
        rowCount: members.length,
        rows: members.map(m => ({ sourceId: m.sourceId, row: m.row })),
        fields,
        conflicts,
        hasConflict: conflicts.length > 0,
      });
    }
    return clusters;
  } catch {
    return [];
  }
}

function recordJoin(map, node, canonKey, value) {
  if (!map.has(node)) map.set(node, new Set());
  map.get(node).add(`${keyId(canonKey)}␟${value}`);
}

// A cluster's identifying join keys: distinct {key, value} pairs across members.
function collectJoinKeys(members, nodeJoinInfo, canonKeysById) {
  const seen = new Set();
  const out = [];
  for (const m of members) {
    const info = nodeJoinInfo.get(m.node);
    if (!info) continue;
    for (const entry of info) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      const sep = entry.indexOf('␟');
      const kid = entry.slice(0, sep);
      const value = entry.slice(sep + 1);
      out.push({ key: kid.split('␟').join('+'), value: stripValueTag(value) });
    }
  }
  return out;
}

// Turn an internal normalized value tag (n:412 / s:foo / composite with ␞) back
// into a readable representative for provenance display.
function stripValueTag(v) {
  return String(v).split('␞').map(part => {
    if (part.startsWith('n:')) return part.slice(2);
    if (part.startsWith('s:')) return part.slice(2);
    return part;
  }).join('+');
}

// For every column that appears with a usable value in 2+ DISTINCT sources
// within the cluster, report agreement vs conflict and the per-source values.
function compareFields(members) {
  const columns = new Set();
  for (const m of members) for (const c of Object.keys(m.row)) columns.add(c);

  const fields = [];
  for (const col of columns) {
    const contributions = []; // { sourceId, value }
    const sourcesWithValue = new Set();
    const distinct = new Set();
    for (const m of members) {
      const raw = m.row[col];
      const nv = normalizeValue(raw);
      if (nv == null) continue;
      contributions.push({ sourceId: m.sourceId, value: raw });
      sourcesWithValue.add(m.sourceId);
      distinct.add(nv);
    }
    if (sourcesWithValue.size < 2) continue; // only cross-source columns matter
    fields.push({
      column: col,
      status: distinct.size === 1 ? 'agree' : 'conflict',
      contributions,
      distinctValues: [...new Set(contributions.map(c => c.value).map(v => JSON.stringify(v)))].map(s => JSON.parse(s)),
    });
  }
  return fields;
}

// ============================================================
// resolveClusterWithTrust(cluster, sourceTrust, { marginThreshold })
// For each CONFLICTING field in the cluster, resolve to the value backed by the
// highest-trust source IFF the trust margin between the top two competing values
// is >= marginThreshold; otherwise escalate that field for human review. Mirrors
// reconcileClaims(): it never invents a winner without an honest margin.
//
// Returns (never throws):
//   { clusterId, resolutions:[...], escalated, resolvedCount, escalatedCount }
// where each resolution is either
//   { column, resolved:true,  value, winningSource, margin, rationale } or
//   { column, resolved:false, reason, margin, candidates:[{sourceId,value,trust}], rationale }
// ============================================================
export function resolveClusterWithTrust(cluster, sourceTrust, options = {}) {
  try {
    const marginThreshold = isPlainObject(options) && Number.isFinite(options.marginThreshold)
      ? options.marginThreshold : DEFAULT_MARGIN_THRESHOLD;
    const clusterId = isPlainObject(cluster) ? (cluster.id ?? null) : null;
    const conflicts = isPlainObject(cluster) && Array.isArray(cluster.conflicts)
      ? cluster.conflicts
      : (isPlainObject(cluster) && Array.isArray(cluster.fields) ? cluster.fields.filter(f => f && f.status === 'conflict') : []);

    const resolutions = conflicts.map(f => resolveField(f, sourceTrust, marginThreshold));
    const escalatedCount = resolutions.filter(r => !r.resolved).length;
    const resolvedCount = resolutions.length - escalatedCount;
    return {
      clusterId,
      resolutions,
      escalated: escalatedCount > 0,
      resolvedCount,
      escalatedCount,
    };
  } catch (e) {
    return {
      clusterId: isPlainObject(cluster) ? (cluster.id ?? null) : null,
      resolutions: [],
      escalated: false,
      resolvedCount: 0,
      escalatedCount: 0,
      reason: `unevaluable: ${e && e.message ? e.message : 'unknown error'}`,
    };
  }
}

function resolveField(field, sourceTrust, marginThreshold) {
  const column = field && field.column;
  const contributions = Array.isArray(field && field.contributions) ? field.contributions : [];

  // Group by normalized value; each value carries its best (max finite) trust
  // and a representative source + raw value.
  const byValue = new Map();
  for (const c of contributions) {
    const nv = normalizeValue(c.value);
    if (nv == null) continue;
    const t = trustOf(sourceTrust, c.sourceId);
    if (!byValue.has(nv)) byValue.set(nv, { value: c.value, bestTrust: null, bestSource: null, sources: [] });
    const g = byValue.get(nv);
    g.sources.push({ sourceId: c.sourceId, trust: t });
    if (t != null && (g.bestTrust == null || t > g.bestTrust)) { g.bestTrust = t; g.bestSource = c.sourceId; }
  }

  const candidates = [...byValue.values()].map(g => ({
    value: g.value,
    trust: g.bestTrust,
    sourceId: g.bestSource,
    sources: g.sources,
  }));

  if (candidates.length < 2) {
    // Not actually a conflict once nullish values are dropped — nothing to pick.
    return {
      column, resolved: false, reason: 'no competing values', margin: null,
      candidates,
      rationale: `"${column}" had no two distinct usable values to reconcile.`,
    };
  }

  // Rank by trust desc; a value with no finite trust sorts last.
  const ranked = [...candidates].sort((x, y) => {
    const tx = x.trust == null ? -Infinity : x.trust;
    const ty = y.trust == null ? -Infinity : y.trust;
    return ty - tx;
  });
  const top = ranked[0], second = ranked[1];

  // Honest basis to resolve requires BOTH top competitors to carry a real trust
  // signal — mirrors reconcileClaims() requiring both ranks non-null.
  if (top.trust == null || second.trust == null) {
    return {
      column, resolved: false, reason: 'insufficient trust signal', margin: null,
      candidates: ranked,
      rationale: `Cannot rank "${column}": at least one competing source has no usable trust score. Escalating for human review.`,
    };
  }

  const margin = Math.round((top.trust - second.trust) * 1e9) / 1e9;
  if (margin >= marginThreshold) {
    return {
      column, resolved: true, value: top.value, winningSource: top.sourceId, margin,
      rationale: `Resolved "${column}" to ${JSON.stringify(top.value)} from "${top.sourceId}" `
        + `(trust ${top.trust} vs ${second.trust}, margin ${margin.toFixed(3)} ≥ ${marginThreshold}).`,
    };
  }
  return {
    column, resolved: false, reason: 'trust margin below threshold', margin,
    candidates: ranked,
    rationale: `Trust margin for "${column}" is ${margin.toFixed(3)} (< ${marginThreshold}): `
      + `"${top.sourceId}" (${top.trust}) vs "${second.sourceId}" (${second.trust}). `
      + `No honest basis to auto-resolve — escalating for human review.`,
  };
}

// ============================================================
// summarizeConvergence(clusters) — one-line, human-readable verdict, in the
// spirit of explainReconciliation(). Counts joined (multi-source) clusters and,
// where a cluster carries an attached `resolution` (from resolveClusterWithTrust),
// how many auto-resolved vs. need a human. Safe on any input.
// ============================================================
export function summarizeConvergence(clusters) {
  if (!Array.isArray(clusters)) return 'No convergence clusters to summarize.';

  const total = clusters.length;
  const joined = clusters.filter(c => isPlainObject(c) && c.coverageCount >= 2).length;
  let needsHuman = 0;
  let autoResolved = 0;
  let conflictClusters = 0;

  for (const c of clusters) {
    if (!isPlainObject(c) || !c.hasConflict) continue;
    conflictClusters++;
    const res = c.resolution; // optional, attached by the caller after resolveClusterWithTrust
    if (isPlainObject(res)) {
      if (res.escalated) needsHuman++; else autoResolved++;
    } else {
      needsHuman++; // unresolved conflict defaults to "needs a human"
    }
  }

  return {
    totalClusters: total,
    joinedClusters: joined,
    conflictClusters,
    autoResolved,
    needsHuman,
    text: `${fmt(needsHuman)} of ${fmt(joined)} joined clusters need a human decision — `
      + `${fmt(autoResolved)} auto-resolved by trust weight.`,
  };
}
