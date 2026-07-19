/**
 * insight-engine.js — DataGlow Instant Insight
 * PR AF: Statistical profiling engine that surfaces the single most
 * interesting finding in a dataset as one plain-English sentence.
 *
 * Runs entirely in the browser on in-memory data — no LLM, no server,
 * no user data ever transmitted. Pure heuristics + DuckDB-style statistics
 * computed over the parsed dataset rows.
 *
 * Public API:
 *   InstantInsight.analyze(dataset) → { sentence, type, confidence, detail }
 */

export var InstantInsight = (function () {
  'use strict';

  // ── helpers ───────────────────────────────────────────────────────────────

  function isNumeric(val) {
    if (val === null || val === undefined || val === '') return false;
    return !isNaN(parseFloat(val)) && isFinite(val);
  }

  function isDateLike(val) {
    if (typeof val !== 'string') return false;
    return /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?/.test(val) ||
           /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(val);
  }

  function parseNum(val) { return parseFloat(val); }

  function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce(function (s, v) { return s + v; }, 0) / arr.length;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function stddev(arr) {
    if (arr.length < 2) return 0;
    var m = mean(arr);
    var variance = arr.reduce(function (s, v) { return s + Math.pow(v - m, 2); }, 0) / arr.length;
    return Math.sqrt(variance);
  }

  function percentile(arr, p) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var idx = Math.floor(p / 100 * (s.length - 1));
    return s[idx];
  }

  function formatNum(n) {
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    if (Math.abs(n) === Math.floor(Math.abs(n))) return n.toFixed(0);
    return n.toFixed(2);
  }

  function pct(part, whole) {
    if (!whole) return '0%';
    return Math.round(part / whole * 100) + '%';
  }

  function titleCase(str) {
    return str.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // ── column profilers ──────────────────────────────────────────────────────

  function profileNumeric(colName, values) {
    var nums = values.filter(isNumeric).map(parseNum);
    if (nums.length < 3) return null;

    var mn = mean(nums);
    var sd = stddev(nums);
    var med = median(nums);
    var minV = Math.min.apply(null, nums);
    var maxV = Math.max.apply(null, nums);
    var p95 = percentile(nums, 95);
    var p05 = percentile(nums, 5);

    // Outlier detection: values > mean + 3*sd
    var outliers = nums.filter(function (v) { return Math.abs(v - mn) > 3 * sd; });
    var outlierPct = nums.length ? outliers.length / nums.length : 0;

    // Skew: if max is dramatically larger than p95
    var topSkew = p95 > 0 ? maxV / p95 : 1;

    // Zero-heavy: majority of values are 0
    var zeros = nums.filter(function (v) { return v === 0; });
    var zeroPct = zeros.length / nums.length;

    // Negative presence
    var negatives = nums.filter(function (v) { return v < 0; });
    var negPct = negatives.length / nums.length;

    // Constant check
    var isConstant = sd === 0;

    return {
      type: 'numeric',
      col: colName,
      count: nums.length,
      mean: mn,
      median: med,
      stddev: sd,
      min: minV,
      max: maxV,
      p05: p05,
      p95: p95,
      outlierCount: outliers.length,
      outlierPct: outlierPct,
      topSkew: topSkew,
      zeroPct: zeroPct,
      negPct: negPct,
      isConstant: isConstant,
      range: maxV - minV
    };
  }

  function profileCategorical(colName, values) {
    var nonNull = values.filter(function (v) { return v !== null && v !== undefined && v !== ''; });
    if (!nonNull.length) return null;

    var freq = {};
    nonNull.forEach(function (v) {
      var k = String(v).trim();
      freq[k] = (freq[k] || 0) + 1;
    });

    var entries = Object.keys(freq).map(function (k) { return { val: k, count: freq[k] }; });
    entries.sort(function (a, b) { return b.count - a.count; });

    var total = nonNull.length;
    var topVal = entries[0];
    var topPct = topVal ? topVal.count / total : 0;
    var uniqueCount = entries.length;
    var uniqueRatio = uniqueCount / total;

    // Dominant category: one value covers >60% of rows
    var isDominant = topPct >= 0.60 && uniqueCount > 1;

    // Near-unique: almost every value is different (likely ID column)
    var isLikelyId = uniqueRatio > 0.95;

    // Concentration: top 2 values cover >80%
    var top2pct = entries.slice(0, 2).reduce(function (s, e) { return s + e.count; }, 0) / total;

    return {
      type: 'categorical',
      col: colName,
      count: total,
      uniqueCount: uniqueCount,
      uniqueRatio: uniqueRatio,
      topVal: topVal ? topVal.val : null,
      topCount: topVal ? topVal.count : 0,
      topPct: topPct,
      secondVal: entries[1] ? entries[1].val : null,
      secondCount: entries[1] ? entries[1].count : 0,
      top2pct: top2pct,
      isDominant: isDominant,
      isLikelyId: isLikelyId,
      entries: entries.slice(0, 10)
    };
  }

  function detectTimeSeries(colName, values) {
    var dateLike = values.filter(isDateLike);
    if (dateLike.length < values.length * 0.7) return null;
    return { type: 'datetime', col: colName, count: dateLike.length };
  }

  // ── cross-column insights ─────────────────────────────────────────────────

  function detectCorrelation(profiles, rows) {
    var numCols = profiles.filter(function (p) { return p && p.type === 'numeric'; });
    if (numCols.length < 2) return null;

    // Check first two numeric columns for correlation
    var colA = numCols[0].col;
    var colB = numCols[1].col;
    var pairs = rows.filter(function (r) {
      return isNumeric(r[colA]) && isNumeric(r[colB]);
    });
    if (pairs.length < 10) return null;

    var aVals = pairs.map(function (r) { return parseNum(r[colA]); });
    var bVals = pairs.map(function (r) { return parseNum(r[colB]); });
    var mA = mean(aVals), mB = mean(bVals);
    var sdA = stddev(aVals), sdB = stddev(bVals);
    if (!sdA || !sdB) return null;

    var cov = 0;
    for (var i = 0; i < pairs.length; i++) {
      cov += (aVals[i] - mA) * (bVals[i] - mB);
    }
    cov /= pairs.length;
    var r = cov / (sdA * sdB);

    if (Math.abs(r) >= 0.75) {
      return {
        type: 'correlation',
        colA: colA,
        colB: colB,
        r: r,
        direction: r > 0 ? 'rises' : 'falls',
        score: Math.abs(r) * 80
      };
    }
    return null;
  }

  function detectGroupConcentration(catProfile, numProfile, rows) {
    if (!catProfile || !numProfile) return null;
    if (catProfile.uniqueCount < 2 || catProfile.uniqueCount > 20) return null;

    // Sum numeric col by categorical col, find most concentrated group
    var groupSums = {};
    var totalSum = 0;
    rows.forEach(function (r) {
      var k = String(r[catProfile.col] || '').trim();
      var v = parseNum(r[numProfile.col]);
      if (!isNaN(v)) {
        groupSums[k] = (groupSums[k] || 0) + v;
        totalSum += v;
      }
    });
    if (!totalSum) return null;

    var groups = Object.keys(groupSums).map(function (k) {
      return { key: k, sum: groupSums[k], pct: groupSums[k] / totalSum };
    }).sort(function (a, b) { return b.sum - a.sum; });

    if (!groups.length) return null;
    var top = groups[0];

    // Interesting if top group accounts for >50% of total
    if (top.pct >= 0.50 && groups.length >= 3) {
      return {
        type: 'group_concentration',
        catCol: catProfile.col,
        numCol: numProfile.col,
        topGroup: top.key,
        topPct: top.pct,
        topSum: top.sum,
        totalSum: totalSum,
        score: top.pct * 90
      };
    }
    return null;
  }

  // ── insight scoring + sentence generation ─────────────────────────────────

  function scoreCandidates(profiles, crossInsights, dataset) {
    var candidates = [];
    var rows = dataset.rows;
    var totalRows = rows.length;

    // Per-column insights
    profiles.forEach(function (p) {
      if (!p) return;

      if (p.type === 'numeric') {
        // Extreme outliers
        if (p.outlierPct > 0.02 && p.outlierCount >= 3) {
          candidates.push({
            score: 70 + Math.min(p.outlierPct * 200, 20),
            type: 'outliers',
            profile: p,
            sentence: pct(p.outlierCount, p.count) + ' of ' + titleCase(p.col) +
              ' values are extreme outliers — the highest reaches ' + formatNum(p.max) +
              ' against a typical value of ' + formatNum(p.median) + '.'
          });
        }

        // Heavily skewed distribution
        if (p.topSkew > 5 && p.count > 20) {
          candidates.push({
            score: 60 + Math.min(p.topSkew * 2, 20),
            type: 'skew',
            profile: p,
            sentence: titleCase(p.col) + ' is heavily skewed — the top value (' +
              formatNum(p.max) + ') is ' + Math.round(p.topSkew) +
              'x higher than the 95th percentile (' + formatNum(p.p95) + ').'
          });
        }

        // Zero-heavy
        if (p.zeroPct > 0.5 && p.count > 10) {
          candidates.push({
            score: 55,
            type: 'zero_heavy',
            profile: p,
            sentence: pct(Math.round(p.zeroPct * p.count), p.count) +
              ' of ' + titleCase(p.col) + ' entries are zero — only ' +
              pct(Math.round((1 - p.zeroPct) * p.count), p.count) + ' have an actual value.'
          });
        }

        // Unexpected negatives (likely amounts/quantities)
        if (p.negPct > 0.05 && p.negPct < 0.5 &&
            /amount|price|cost|revenue|total|qty|quantity|count|sales|pay/i.test(p.col)) {
          candidates.push({
            score: 72,
            type: 'negatives',
            profile: p,
            sentence: pct(Math.round(p.negPct * p.count), p.count) +
              ' of ' + titleCase(p.col) + ' values are negative — ' +
              'this may indicate refunds, adjustments, or data errors worth investigating.'
          });
        }

        // Huge range
        if (p.range > 0 && p.max / (p.median || 1) > 100 && p.count > 10) {
          candidates.push({
            score: 58,
            type: 'range',
            profile: p,
            sentence: titleCase(p.col) + ' spans from ' + formatNum(p.min) +
              ' to ' + formatNum(p.max) + ' — a ' + formatNum(p.range) +
              ' range with a median of ' + formatNum(p.median) + '.'
          });
        }
      }

      if (p.type === 'categorical') {
        // Single dominant category
        if (p.isDominant) {
          candidates.push({
            score: 65 + p.topPct * 20,
            type: 'dominant_category',
            profile: p,
            sentence: pct(p.topCount, p.count) + ' of rows in ' + titleCase(p.col) +
              ' are "' + p.topVal + '" — one value dominates the entire dataset.'
          });
        }

        // Very few unique values across many rows (low cardinality signal)
        if (p.uniqueCount === 2 && p.count > 50) {
          candidates.push({
            score: 52,
            type: 'binary',
            profile: p,
            sentence: titleCase(p.col) + ' is binary — "' + p.topVal + '" (' +
              pct(p.topCount, p.count) + ') vs "' + p.secondVal + '" (' +
              pct(p.secondCount, p.count) + ').'
          });
        }
      }
    });

    // Cross-column insights
    crossInsights.forEach(function (ci) {
      if (!ci) return;

      if (ci.type === 'correlation') {
        candidates.push({
          score: ci.score,
          type: 'correlation',
          sentence: 'When ' + titleCase(ci.colA) + ' increases, ' +
            titleCase(ci.colB) + ' ' + ci.direction + ' with it — ' +
            'a strong correlation (r = ' + ci.r.toFixed(2) + ').'
        });
      }

      if (ci.type === 'group_concentration') {
        candidates.push({
          score: ci.score,
          type: 'group_concentration',
          sentence: '"' + ci.topGroup + '" accounts for ' +
            pct(Math.round(ci.topPct * 100) / 100 * (rows.length), rows.length) +
            ' — ' + pct(ci.topPct, 1) + ' of total ' + titleCase(ci.numCol) +
            ' across all ' + titleCase(ci.catCol) + ' groups.'
        });
      }
    });

    // Row-level signals
    // High null rate across whole dataset
    var nullCols = profiles.filter(function (p) {
      if (!p) return false;
      var colVals = rows.map(function (r) { return r[p.col]; });
      var nulls = colVals.filter(function (v) { return v === null || v === undefined || v === ''; });
      return nulls.length / rows.length > 0.3;
    });
    if (nullCols.length >= 2) {
      candidates.push({
        score: 60,
        type: 'null_heavy',
        sentence: nullCols.length + ' columns have more than 30% missing values — ' +
          'including ' + titleCase(nullCols[0].col) + ' and ' + titleCase(nullCols[1].col) + '.'
      });
    }

    // Duplicate rows
    var rowHashes = {};
    var dupCount = 0;
    rows.forEach(function (r) {
      var h = JSON.stringify(r);
      if (rowHashes[h]) dupCount++;
      rowHashes[h] = true;
    });
    if (dupCount > 0 && dupCount / totalRows > 0.02) {
      candidates.push({
        score: 68,
        type: 'duplicates',
        sentence: dupCount + ' duplicate row' + (dupCount === 1 ? '' : 's') +
          ' found (' + pct(dupCount, totalRows) + ' of the dataset) — ' +
          'these may skew your analysis.'
      });
    }

    // Sort by score descending, return top candidate
    candidates.sort(function (a, b) { return b.score - a.score; });
    return candidates;
  }

  // ── fallback sentences ────────────────────────────────────────────────────

  function fallbackSentence(dataset) {
    var rows = dataset.rows;
    var cols = dataset.columns;
    if (!rows.length) return 'This dataset is empty.';

    // Try to say something about scale
    var numCols = cols.filter(function (c) {
      return rows.slice(0, 5).some(function (r) { return isNumeric(r[c]); });
    });

    if (numCols.length) {
      var vals = rows.map(function (r) { return parseNum(r[numCols[0]]); }).filter(function (v) { return !isNaN(v); });
      if (vals.length) {
        return rows.length.toLocaleString() + ' rows loaded across ' + cols.length +
          ' columns. ' + titleCase(numCols[0]) + ' ranges from ' +
          formatNum(Math.min.apply(null, vals)) + ' to ' + formatNum(Math.max.apply(null, vals)) + '.';
      }
    }

    return rows.length.toLocaleString() + ' rows loaded across ' + cols.length + ' columns. Ready to explore.';
  }

  // ── main entry point ──────────────────────────────────────────────────────

  function analyze(dataset) {
    if (!dataset || !dataset.rows || !dataset.columns) {
      return { sentence: 'Dataset loaded. Ready to explore.', type: 'default', confidence: 0 };
    }

    var rows = dataset.rows;
    var cols = dataset.columns;

    if (rows.length === 0) {
      return { sentence: 'This dataset appears to be empty.', type: 'empty', confidence: 1 };
    }

    // Profile each column
    var profiles = cols.map(function (col) {
      var values = rows.map(function (r) { return r[col]; });

      // Try datetime first
      var dtProfile = detectTimeSeries(col, values);
      if (dtProfile) return dtProfile;

      // Numeric?
      var numericValues = values.filter(function (v) { return v !== null && v !== '' && v !== undefined; });
      var numericCount = numericValues.filter(isNumeric).length;
      if (numericCount / Math.max(numericValues.length, 1) > 0.8) {
        return profileNumeric(col, values);
      }

      // Categorical
      return profileCategorical(col, values);
    });

    // Cross-column insights
    var catProfiles = profiles.filter(function (p) { return p && p.type === 'categorical'; });
    var numProfiles = profiles.filter(function (p) { return p && p.type === 'numeric'; });

    var crossInsights = [
      detectCorrelation(profiles, rows),
      detectGroupConcentration(catProfiles[0] || null, numProfiles[0] || null, rows)
    ];

    // Score all candidates and pick the winner
    var candidates = scoreCandidates(profiles, crossInsights, dataset);

    if (!candidates.length) {
      return { sentence: fallbackSentence(dataset), type: 'fallback', confidence: 0.3 };
    }

    var winner = candidates[0];
    return {
      sentence: winner.sentence,
      type: winner.type,
      confidence: Math.min(winner.score / 100, 1),
      allCandidates: candidates.slice(0, 5)
    };
  }

  return { analyze: analyze };
})();
