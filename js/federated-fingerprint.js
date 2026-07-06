// ============================================================
// DATAGLOW — Federated Fingerprinting  (EXPERIMENTAL / RESEARCH PREVIEW)
// ============================================================
// Computes a NON-REVERSIBLE statistical summary ("fingerprint") of a dataset's
// SHAPE — per-column distributions, cardinality, and missingness — with
// differentially-private noise injected into every distribution count. The
// fingerprint contains NO raw values and is exportable as a small JSON file, so
// two sites running DATAGLOW can compare their datasets' shape WITHOUT either
// site ever sharing row-level data.
//
// Privacy / safety guarantees (mandatory, per the roadmap's highest-risk item):
//   • Minimum-n floor: a column with fewer than MIN_N (50) non-null rows is
//     SUPPRESSED — no distribution/cardinality is computed or exported for it.
//   • DP noise: Laplace noise (sensitivity = 1) is added to every histogram /
//     frequency COUNT before it is normalized to a probability distribution
//     (Dwork & Roth, "Algorithmic Foundations of Differential Privacy", 2014,
//     §3.3 Laplace mechanism, §3.5 histograms).
//   • This is a Research Preview — see FINGERPRINT_DISCLAIMER; the UI MUST show
//     it prominently.
//
// Comparison uses Jensen–Shannon divergence (a symmetric, bounded [0, ln2]
// smoothing of KL divergence — Lin, 1991) over the noised distributions to flag
// columns whose shape differs meaningfully between two fingerprints.
//
// Pure JS — no DOM, no engine. Laplace sampler injectable for reproducible tests.
// ============================================================

import { laplaceNoise } from './privacy-budget.js';

export const MIN_N = 50;
export const DEFAULT_EPSILON = 1.0;
export const DEFAULT_BINS = 16;
// Categories observed fewer than this many times are folded into "(rare)"
// before noising, so a singleton/near-singleton label (which can itself
// identify an individual, e.g. a rare diagnosis) is never published.
export const RARE_CATEGORY_FLOOR = 5;
// Above this JS-divergence the two distributions are called "meaningfully
// different". 0.1 (well below the ln2≈0.693 ceiling) is a deliberately
// conservative research-preview heuristic, not a validated threshold.
export const MEANINGFUL_JSD = 0.1;

export const FINGERPRINT_DISCLAIMER =
  'This feature adds statistical noise for privacy but has not been independently ' +
  'audited for re-identification risk. Do not rely on this as a HIPAA Safe Harbor ' +
  'or Expert Determination method. Consult a qualified statistician before sharing ' +
  'outputs externally.';

const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT', 'DECIMAL', 'REAL'];
function isNumericType(type) { return NUMERIC_TYPES.includes(String(type || '').toUpperCase()); }
function looksNumeric(col, values) {
  if (isNumericType(col.type)) return true;
  if (col.type) return false;
  const nn = values.filter(v => v != null && v !== '');
  return nn.length > 0 && nn.every(v => Number.isFinite(Number(v)));
}

function noiseCounts(counts, epsilon, rng) {
  if (epsilon <= 0) throw new Error('epsilon (ε) must be greater than 0.');
  const scale = 1 / epsilon;
  return counts.map(c => Math.max(0, c + laplaceNoise(scale, rng)));
}

function normalize(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return counts.map(() => 0);
  return counts.map(c => c / total);
}

// Coarsen a numeric bound to ~2 significant figures so the EXACT extreme
// observation is never published in the fingerprint (exact min/max are real
// individual data points — a classic re-identification leak). We round the
// lower bound DOWN and the upper bound UP so the coarsened range still fully
// contains the data. These rounded bounds are what the histogram is built over.
export function coarsenBound(v, dir) {
  if (!Number.isFinite(v) || v === 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - 1);
  return dir === 'down' ? Math.floor(v / mag) * mag : Math.ceil(v / mag) * mag;
}

// Report cardinality as an order-of-magnitude bucket rather than an exact
// distinct count (an exact count can be identifying for a small column).
export function cardinalityBucket(k) {
  if (k <= 1) return '1';
  if (k <= 10) return '2-10';
  if (k <= 100) return '11-100';
  if (k <= 1000) return '101-1000';
  return '1000+';
}

// ---------- per-column fingerprint ----------

export function computeColumnFingerprint(col, values, { epsilon = DEFAULT_EPSILON, bins = DEFAULT_BINS, rng = Math.random } = {}) {
  const total = values.length;
  const nonNull = values.filter(v => v != null && v !== '');
  const missingness = total > 0 ? Number(((total - nonNull.length) / total).toFixed(4)) : 0;

  // Minimum-n floor: refuse to fingerprint sparse columns.
  if (nonNull.length < MIN_N) {
    return { name: col.name, suppressed: true, reason: `Fewer than ${MIN_N} non-null rows (n=${nonNull.length}); suppressed to prevent re-identification.`, n: nonNull.length, missingness };
  }

  if (looksNumeric(col, nonNull)) {
    const nums = nonNull.map(Number).filter(Number.isFinite);
    const rawMin = Math.min(...nums), rawMax = Math.max(...nums);
    // Publish only coarsened bounds, never the exact observed extremes.
    let min = coarsenBound(rawMin, 'down');
    let max = coarsenBound(rawMax, 'up');
    if (min === max) max = min + 1;
    const width = (max - min) / bins;
    const counts = new Array(bins).fill(0);
    for (const v of nums) {
      let idx = Math.floor((v - min) / width);
      if (idx < 0) idx = 0; if (idx >= bins) idx = bins - 1;
      counts[idx]++;
    }
    const noised = noiseCounts(counts, epsilon, rng);
    return {
      name: col.name, kind: 'numeric', n: nums.length, missingness,
      // cardinality is bucketed to a coarse magnitude so an exact distinct-count
      // (which can itself be identifying for small columns) is not published.
      cardinalityBucket: cardinalityBucket(new Set(nums).size),
      min, max, boundsNote: 'min/max are rounded bounds, not exact observed values', bins,
      distribution: normalize(noised).map(p => Number(p.toFixed(6))),
    };
  }

  // categorical
  const map = new Map();
  for (const v of nonNull) { const k = String(v); map.set(k, (map.get(k) || 0) + 1); }
  // Fold rare labels into "(rare)" so no near-singleton category is published.
  const kept = []; let rareCount = 0;
  for (const [cat, c] of map) { if (c >= RARE_CATEGORY_FLOOR) kept.push([cat, c]); else rareCount += c; }
  if (rareCount > 0) kept.push(['(rare)', rareCount]);
  const sorted = kept.sort((a, b) => b[1] - a[1]);
  const categories = sorted.map(e => e[0]);
  const noised = noiseCounts(sorted.map(e => e[1]), epsilon, rng);
  const probs = normalize(noised);
  return {
    name: col.name, kind: 'categorical', n: nonNull.length, missingness,
    cardinalityBucket: cardinalityBucket(map.size),
    categories,
    distribution: probs.map(p => Number(p.toFixed(6))),
  };
}

export function buildFingerprint({ datasetName, columns, rows, epsilon = DEFAULT_EPSILON, bins = DEFAULT_BINS, rng = Math.random } = {}) {
  if (!Array.isArray(columns) || !columns.length) throw new Error('buildFingerprint needs a non-empty column list.');
  if (!Array.isArray(rows)) throw new Error('buildFingerprint needs a rows array.');
  const cols = columns.map(col => computeColumnFingerprint(col, rows.map(r => r[col.name]), { epsilon, bins, rng }));
  return {
    kind: 'dataglow-fingerprint',
    version: 1,
    generatedAt: Date.now(),
    datasetName: datasetName || 'Untitled dataset',
    rowCount: rows.length,
    epsilon,
    minN: MIN_N,
    mechanism: 'Laplace (DP histogram counts; Dwork & Roth 2014)',
    note: 'Contains only noised, aggregated distribution shape — NO raw values, keys, or row-level data.',
    experimental: true,
    disclaimer: FINGERPRINT_DISCLAIMER,
    columns: cols,
  };
}

// ---------- Jensen–Shannon divergence ----------

function klDivergence(p, q) {
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 0 && q[i] > 0) sum += p[i] * Math.log(p[i] / q[i]);
  }
  return sum;
}

// JSD in nats, range [0, ln2]. Symmetric; 0 iff distributions are identical.
export function jensenShannonDivergence(p, q) {
  if (p.length !== q.length) throw new Error('JSD requires equal-length distributions.');
  const m = p.map((pi, i) => (pi + q[i]) / 2);
  return 0.5 * klDivergence(p, m) + 0.5 * klDivergence(q, m);
}

// Redistribute a normalized histogram (over [min,max] with counts.length bins,
// uniform-within-bin assumption) onto a common linear grid [gMin,gMax] with
// `gBins` bins, so two numeric columns with different native ranges/bin counts
// can be compared on a shared support.
export function rebinDistribution(dist, min, max, gMin, gMax, gBins) {
  const out = new Array(gBins).fill(0);
  const srcBins = dist.length;
  if (srcBins === 0 || gMax <= gMin) return out;
  const srcWidth = (max - min) / srcBins;
  const gWidth = (gMax - gMin) / gBins;
  for (let i = 0; i < srcBins; i++) {
    const mass = dist[i];
    if (mass <= 0) continue;
    const lo = min + i * srcWidth;
    const hi = lo + srcWidth;
    // Spread this bin's mass uniformly across target bins it overlaps.
    let cursor = lo;
    while (cursor < hi - 1e-12) {
      const gIdx = Math.min(gBins - 1, Math.max(0, Math.floor((cursor - gMin) / gWidth)));
      const gBinHi = gMin + (gIdx + 1) * gWidth;
      const segHi = Math.min(hi, gBinHi);
      const frac = (segHi - cursor) / srcWidth;
      out[gIdx] += mass * frac;
      cursor = segHi;
    }
  }
  return out;
}

// Align two column fingerprints to comparable probability vectors, returning
// { p, q } or null when they are not comparable (different kinds / suppressed).
export function alignColumns(a, b, gBins = DEFAULT_BINS) {
  if (!a || !b || a.suppressed || b.suppressed) return null;
  if (a.kind !== b.kind) return null;
  if (a.kind === 'numeric') {
    const gMin = Math.min(a.min, b.min);
    const gMax = Math.max(a.max, b.max);
    const p = rebinDistribution(a.distribution, a.min, a.max, gMin, gMax, gBins);
    const q = rebinDistribution(b.distribution, b.min, b.max, gMin, gMax, gBins);
    return { p, q };
  }
  // categorical: align on the union of category labels.
  const keys = [...new Set([...(a.categories || []), ...(b.categories || [])])];
  const idxOf = (cats) => new Map((cats || []).map((c, i) => [c, i]));
  const ia = idxOf(a.categories), ib = idxOf(b.categories);
  const p = keys.map(k => (ia.has(k) ? a.distribution[ia.get(k)] : 0));
  const q = keys.map(k => (ib.has(k) ? b.distribution[ib.get(k)] : 0));
  return { p, q };
}

// ---------- fingerprint comparison ----------

export function compareFingerprints(fpA, fpB, { bins = DEFAULT_BINS } = {}) {
  if (!fpA || fpA.kind !== 'dataglow-fingerprint' || !fpB || fpB.kind !== 'dataglow-fingerprint') {
    throw new Error('compareFingerprints requires two DATAGLOW fingerprint objects.');
  }
  const mapA = new Map(fpA.columns.map(c => [c.name, c]));
  const mapB = new Map(fpB.columns.map(c => [c.name, c]));
  const names = [...new Set([...mapA.keys(), ...mapB.keys()])];

  const columns = [];
  for (const name of names) {
    const a = mapA.get(name), b = mapB.get(name);
    const present = a && b ? 'both' : (a ? 'a_only' : 'b_only');
    const entry = { column: name, present };
    if (present === 'both') {
      entry.missingnessDelta = Number(((b.missingness || 0) - (a.missingness || 0)).toFixed(4));
      if (a.cardinalityBucket != null && b.cardinalityBucket != null) {
        entry.cardinalityA = a.cardinalityBucket;
        entry.cardinalityB = b.cardinalityBucket;
        entry.cardinalityChanged = a.cardinalityBucket !== b.cardinalityBucket;
      }
      const aligned = alignColumns(a, b, bins);
      if (aligned) {
        entry.jsd = Number(jensenShannonDivergence(aligned.p, aligned.q).toFixed(6));
        entry.meaningful = entry.jsd > MEANINGFUL_JSD;
      } else {
        entry.jsd = null;
        entry.meaningful = (a.suppressed || b.suppressed) ? false : true; // kind mismatch = meaningful
        entry.note = (a.suppressed || b.suppressed) ? 'One side suppressed (min-n floor).' : 'Column type differs between the two datasets.';
      }
    }
    columns.push(entry);
  }

  const meaningful = columns.filter(c => c.meaningful).length;
  return {
    kind: 'dataglow-fingerprint-comparison',
    generatedAt: Date.now(),
    datasetA: fpA.datasetName, datasetB: fpB.datasetName,
    threshold: MEANINGFUL_JSD,
    summary: { totalColumns: columns.length, meaningfullyDifferent: meaningful, sharedColumns: columns.filter(c => c.present === 'both').length },
    columns: columns.sort((a, b) => (b.jsd || 0) - (a.jsd || 0)),
    disclaimer: FINGERPRINT_DISCLAIMER,
  };
}

export function parseFingerprint(text) {
  const obj = JSON.parse(text);
  if (!obj || obj.kind !== 'dataglow-fingerprint') throw new Error('Not a DATAGLOW fingerprint file.');
  return obj;
}
