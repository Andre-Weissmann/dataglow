// ============================================================
// DATAGLOW — Local column profiler (hover + DataLens-compatible)
// ============================================================
// Pure, on-device stats from in-memory rows. No network. No LLM.
// Rows are arrays accessed by colIdx (DataGlow contract).
//
// Public:
//   profileColumnLocal(dataset, colIdx, opts?) → Profile
//   profileAllLocal(dataset, opts?) → Profile[]
//   qualityScoreLocal(profile) → 0..100
//
// Profile shape matches DataLens cards:
//   { name, type, rowCount, nullRate, cardinality, min, max, topValues, quality, narrative }

export const COLUMN_PROFILER_LOCAL_VERSION = 1;
export const DEFAULT_SAMPLE_CAP = 8000;

export function qualityScoreLocal(profile) {
  var s = 100;
  var nullRate = Number(profile && profile.nullRate) || 0;
  s -= nullRate * 50;
  if (profile && profile.cardinality === 1) s -= 10;
  if (profile && /^col\d+$|^field\d+$|^unnamed/i.test(profile.name || '')) s -= 5;
  var rowCount = Number(profile && profile.rowCount) || 0;
  var type = String((profile && profile.type) || '').toUpperCase();
  if ((type === 'STR' || type === 'VARCHAR' || type === 'TEXT') &&
      rowCount > 0 && (Number(profile.cardinality) / rowCount) > 0.95) {
    s -= 20;
  }
  if (type === 'DATE' || type === 'TIMESTAMP' || type === 'TIMESTAMPTZ') s += 5;
  if (s < 0) s = 0;
  if (s > 100) s = 100;
  return Math.round(s);
}

export function narrativeLocal(profile) {
  if (!profile) return '';
  var nullPct = Math.round((Number(profile.nullRate) || 0) * 100);
  var parts = [];
  parts.push(profile.name + ' is ' + (profile.type || 'STR'));
  if (nullPct > 0) parts.push(nullPct + '% null');
  else parts.push('no nulls');
  parts.push(Number(profile.cardinality || 0) + ' distinct');
  if (profile.min != null && profile.max != null) {
    parts.push('range ' + profile.min + ' .. ' + profile.max);
  }
  if (profile.quality != null) parts.push('quality ' + profile.quality + '/100');
  return parts.join(' · ');
}

function colMeta(dataset, colIdx) {
  var cols = (dataset && dataset.columns) || [];
  var col = cols[colIdx];
  if (col == null) return { name: 'col' + colIdx, type: 'STR' };
  if (typeof col === 'string') return { name: col, type: 'STR' };
  return {
    name: col.name || col.field || ('col' + colIdx),
    type: col.type || 'STR'
  };
}

/**
 * @param {object} dataset { columns, rows } rows are arrays
 * @param {number} colIdx
 * @param {{ sampleCap?: number }} [opts]
 */
export function profileColumnLocal(dataset, colIdx, opts) {
  opts = opts || {};
  var sampleCap = typeof opts.sampleCap === 'number' && opts.sampleCap > 0
    ? opts.sampleCap : DEFAULT_SAMPLE_CAP;
  var meta = colMeta(dataset, colIdx);
  var rows = (dataset && Array.isArray(dataset.rows)) ? dataset.rows : [];
  var nAll = rows.length;
  var n = Math.min(nAll, sampleCap);
  var nulls = 0;
  var seen = Object.create(null);
  var card = 0;
  var min = null;
  var max = null;
  var counts = Object.create(null);
  var numericHits = 0;

  for (var r = 0; r < n; r++) {
    var row = rows[r];
    var v = Array.isArray(row) ? row[colIdx] : (row ? row[meta.name] : null);
    if (v == null || v === '') {
      nulls++;
      continue;
    }
    var key = String(v);
    if (!seen[key]) {
      seen[key] = 1;
      card++;
    }
    counts[key] = (counts[key] || 0) + 1;
    var num = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null);
    if (num != null && !isNaN(num)) {
      numericHits++;
      if (min == null || num < min) min = num;
      if (max == null || num > max) max = max == null ? num : (num > max ? num : max);
    }
  }

  var top = Object.keys(counts).map(function (k) {
    return { value: k, count: counts[k] };
  }).sort(function (a, b) {
    return b.count - a.count;
  }).slice(0, 5);

  var profile = {
    name: meta.name,
    type: meta.type,
    rowCount: nAll,
    sampledRows: n,
    sampled: nAll > n,
    nullRate: n > 0 ? nulls / n : 0,
    cardinality: card,
    min: numericHits > 0 ? min : null,
    max: numericHits > 0 ? max : null,
    topValues: top,
    colIdx: colIdx
  };
  profile.quality = qualityScoreLocal(profile);
  profile.narrative = narrativeLocal(profile);
  return profile;
}

export function profileAllLocal(dataset, opts) {
  var cols = (dataset && dataset.columns) || [];
  var out = [];
  for (var i = 0; i < cols.length; i++) {
    out.push(profileColumnLocal(dataset, i, opts));
  }
  return out;
}
