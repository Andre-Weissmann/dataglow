/* DataGlow — js/insight/insight-engine.js */
/* Part of structured refactor — see src/ directory */

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

var InstantInsight = (function () {
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
              ' values are extreme outliers  -  the highest reaches ' + formatNum(p.max) +
              ' against a typical value of ' + formatNum(p.median) + '.'
          });
        }

        // Heavily skewed distribution
        if (p.topSkew > 5 && p.count > 20) {
          candidates.push({
            score: 60 + Math.min(p.topSkew * 2, 20),
            type: 'skew',
            profile: p,
            sentence: titleCase(p.col) + ' is heavily skewed  -  the top value (' +
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
              ' of ' + titleCase(p.col) + ' entries are zero  -  only ' +
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
              ' of ' + titleCase(p.col) + ' values are negative  -  ' +
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
              ' to ' + formatNum(p.max) + '  -  a ' + formatNum(p.range) +
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
              ' are "' + p.topVal + '"  -  one value dominates the entire dataset.'
          });
        }

        // Very few unique values across many rows (low cardinality signal)
        if (p.uniqueCount === 2 && p.count > 50) {
          candidates.push({
            score: 52,
            type: 'binary',
            profile: p,
            sentence: titleCase(p.col) + ' is binary  -  "' + p.topVal + '" (' +
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
            titleCase(ci.colB) + ' ' + ci.direction + ' with it  -  ' +
            'a strong correlation (r = ' + ci.r.toFixed(2) + ').'
        });
      }

      if (ci.type === 'group_concentration') {
        candidates.push({
          score: ci.score,
          type: 'group_concentration',
          sentence: '"' + ci.topGroup + '" accounts for ' +
            pct(Math.round(ci.topPct * 100) / 100 * (rows.length), rows.length) +
            '  -  ' + pct(ci.topPct, 1) + ' of total ' + titleCase(ci.numCol) +
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
        sentence: nullCols.length + ' columns have more than 30% missing values  -  ' +
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
          ' found (' + pct(dupCount, totalRows) + ' of the dataset)  -  ' +
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


  var FEATURE_FLAGS = {
    proofExport: true,
    dataglowRooms: true,
    natsConnector: true,
    tauriConnector: true,
    questionPrompter: true,
    portfolioNarrativeAssembler: true
  };

  /* Restore any previous-session overrides (sessionStorage ONLY -- never
     localStorage/cookies) BEFORE any feature is wired below, so the very
     first render already reflects the user's last toggle choices. See the
     FEATURE SETTINGS PANEL section further down for the write side
     (saveFeatureFlagsToSession) and the in-app toggle UI. */
  var FEATURE_SETTINGS_STORAGE_KEY = 'dataglow.featureFlags';
  (function restoreFeatureFlagsFromSessionEarly() {
    try {
      var raw = window.sessionStorage.getItem(FEATURE_SETTINGS_STORAGE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      Object.keys(FEATURE_FLAGS).forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(saved, key) && typeof saved[key] === 'boolean') {
          FEATURE_FLAGS[key] = saved[key];
        }
      });
    } catch (err) {
      // Sandbox may block storage entirely -- fail open with the defaults above.
    }
  })();



  /* ============================================================
     STATE
     ============================================================ */
  var state = {
    datasets: [],        // { id, name, columns:[{name,type}], rows:[[...]], findings:[], columnStats:[], score }
    activeDatasetId: null,
    railOpen: false,
    activeFindingRowIndex: null,
    memoryStore: InstitutionalMemory.createMemoryStore(),
    currentStoryDoc: null
  };
  var datasetCounter = 0;

  /* ============================================================
     RETURN-USE FILE RECOGNITION (Section 10.2)
     ------------------------------------------------------------
     djb2 hash of file name + size — NOT cryptographic, just enough to
     recognize "we've seen a file that looks like this before" without
     pulling in a crypto dependency in the canvas shell.
     ============================================================ */
  var seenFiles = {};

  function djb2HashString(str) {
    var hash = 5381;
    var s = String(str == null ? '' : str);
    for (var i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
    }
    var h = (hash >>> 0).toString(16);
    return h.length >= 8 ? h : new Array(8 - h.length + 1).join('0') + h;
  }

  function fileSeenHash(name, size) {
    return djb2HashString((name || '') + '::' + (size || 0));
  }

  /* ============================================================
     DOM SHORTCUTS
     ============================================================ */
  var $ = function (id) { return document.getElementById(id); };

  var ceremonyScreen = $('ceremony-screen');
  var dropZone = $('drop-zone');
  var fileInput = $('file-input');
  var canvas = $('canvas');

  var revealFileName = $('reveal-file-name');
  var revealProgressBar = $('reveal-progress-bar');
  var progressFill = $('progress-fill');
  var revealCounts = $('reveal-counts');
  var rowCountDisplay = $('row-count-display');
  var colCountDisplay = $('col-count-display');
  var revealHealthDots = $('reveal-health-dots');
  var revealFinding = $('reveal-finding');
  var findingText = $('finding-text');
  var findingExpand = $('finding-expand');
  var tryExampleLink = $('try-example-link');

  var tabStrip = $('tab-strip');
  var tabAdd = $('tab-add');

  // ── Canvas-first: paint ghost grid so the platform looks alive before data ──
  (function paintGhostGrid() {
    var colWidths = [120, 90, 160, 80, 110, 95, 140, 75];
    var thead = $('grid-thead');
    var tbody = $('grid-tbody');
    if (!thead || !tbody) return;

    // Ghost header
    var hRow = document.createElement('tr');
    colWidths.forEach(function (w) {
      var th = document.createElement('th');
      th.style.width = w + 'px';
      th.style.padding = '10px 12px';
      var ghost = document.createElement('div');
      ghost.className = 'ghost-header';
      ghost.style.width = Math.floor(w * 0.6) + 'px';
      th.appendChild(ghost);
      hRow.appendChild(th);
    });
    thead.appendChild(hRow);

    // Ghost rows
    for (var r = 0; r < 14; r++) {
      var row = document.createElement('tr');
      row.className = 'ghost-row';
      colWidths.forEach(function (w) {
        var td = document.createElement('td');
        var cell = document.createElement('div');
        cell.className = 'ghost-cell';
        var cellW = Math.floor(w * (0.4 + Math.random() * 0.45));
        cell.style.width = cellW + 'px';
        cell.style.animationDelay = (Math.random() * 0.8).toFixed(2) + 's';
        td.appendChild(cell);
        row.appendChild(td);
      });
      tbody.appendChild(row);
    }
  })();

  var gridThead = $('grid-thead');
  var gridTbody = $('grid-tbody');
  var statusRows = $('status-rows');
  var statusCols = $('status-cols');
  var statusValidation = $('status-validation');
  var statusFilename = $('status-filename');

  var validationRail = $('validation-rail');
  var railStrip = $('rail-strip');
  var railPanel = $('rail-panel');
  var railFindings = $('rail-findings');
  var railClose = $('rail-close');

  var agentStatus = $('agent-status');
  var agentPopover = $('agent-popover');
  var agentPopoverText = $('agent-popover-text');
  var agentFixBtn = $('agent-fix');
  var agentExplainBtn = $('agent-explain');

  var themeToggle = $('theme-toggle');
  var returnUseBanner = $('return-use-banner');

  var storyEmpty = $('story-empty');
  var storyFrame = $('story-frame');
  var storyExportMdBtn = $('story-export-md');
  var storyExportPdfBtn = $('story-export-pdf');

  /* FEATURE: proofExport */
  var proofExportWrapper = $('proof-export-wrapper');
  var proofExportBtn = $('proof-export-btn');

  /* FEATURE: dataglowRooms */
  var storyShareSection = $('story-share-section');
  var roomCreateBtn = $('room-create-btn');
  var roomImportBtn = $('room-import-btn');
  var roomImportFileInput = $('room-import-file-input');
  var roomCreateForm = $('room-create-form');
  var roomNameInput = $('room-name-input');
  var roomCreatedByInput = $('room-created-by-input');
  var roomCreateConfirmBtn = $('room-create-confirm-btn');
  var roomCreateCancelBtn = $('room-create-cancel-btn');
  var roomImportPanel = $('room-import-panel');
  var roomDescribeOutput = $('room-describe-output');
  var roomImportCloseBtn = $('room-import-close-btn');

  /* FEATURE: natsConnector */
  var natsSourceWrapper = $('nats-source-wrapper');
  var natsSourceOption = $('nats-source-option');
  var natsConfigForm = $('nats-config-form');
  var natsUrlInput = $('nats-url-input');
  var natsSubjectInput = $('nats-subject-input');
  var natsBatchSizeInput = $('nats-batchsize-input');
  var natsConnectionGuide = $('nats-connection-guide');
  var natsConnectBtn = $('nats-connect-btn');
  var natsConnectStatus = $('nats-connect-status');

  /* FEATURE: tauriConnector */
  var tauriDbChip = $('tauri-db-chip');
  var tauriConnectionsPanel = $('tauri-connections-panel');

  /* FEATURE SETTINGS DRAWER (always available; not itself feature-flagged) */
  var featureSettingsBtn = $('feature-settings-btn');
  var featureSettingsOverlay = $('feature-settings-overlay');
  var featureSettingsDrawer = $('feature-settings-drawer');
  var featureSettingsClose = $('feature-settings-close');
  var featureSettingsList = $('feature-settings-list');

  /* LIVE API FEED DRAWER (always available; not itself feature-flagged) */
  var liveFeedBtn = $('live-feed-btn');
  var liveFeedOverlay = $('live-feed-overlay');
  var liveFeedDrawer = $('live-feed-drawer');
  var liveFeedClose = $('live-feed-close');
  var liveFeedUrlInput = $('live-feed-url-input');
  var liveFeedMethodSelect = $('live-feed-method-select');
  var liveFeedPollSelect = $('live-feed-poll-select');
  var liveFeedHeadersToggle = $('live-feed-headers-toggle');
  var liveFeedHeadersWrapper = $('live-feed-headers-wrapper');
  var liveFeedHeadersInput = $('live-feed-headers-input');
  var liveFeedBodyField = $('live-feed-body-field');
  var liveFeedBodyInput = $('live-feed-body-input');
  var liveFeedModeWrapper = $('live-feed-mode-wrapper');
  var liveFeedError = $('live-feed-error');
  var liveFeedFetchBtn = $('live-feed-fetch-btn');
  var liveFeedStatus = $('live-feed-status');

  var sqlOverlay = $('sql-overlay');
  var sqlInput = $('sql-input');
  var sqlRunBtn = $('sql-run');
  var sqlCloseBtn = $('sql-close');
  var sqlStatus = $('sql-status');
  var sqlResultsThead = $('sql-results-thead');
  var sqlResultsTbody = $('sql-results-tbody');

  /* ============================================================
     CSV PARSER (inline, minimal, handles quoted fields)
     ============================================================ */
  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i = 0;
    var len = text.length;

    // Normalize line endings
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    len = text.length;

    while (i < len) {
      var ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          } else {
            inQuotes = false;
            i++;
            continue;
          }
        } else {
          field += ch;
          i++;
          continue;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
          i++;
          continue;
        } else if (ch === ',') {
          row.push(field);
          field = '';
          i++;
          continue;
        } else if (ch === '\n') {
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
          i++;
          continue;
        } else {
          field += ch;
          i++;
          continue;
        }
      }
    }
    // Push last field/row if any content remains
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    // Drop trailing empty rows (from trailing newline)
    while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
      rows.pop();
    }
    return rows;
  }

  function detectType(values) {
    // values: array of raw strings for a column, excluding header
    var allNumeric = true;
    var allInt = true;
    var allBool = true;
    var allDate = true;
    var nonEmptyCount = 0;

    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v === '' || v === null || v === undefined) continue;
      nonEmptyCount++;
      if (allNumeric && isNaN(Number(v))) allNumeric = false;
      if (allInt && (isNaN(Number(v)) || v.indexOf('.') !== -1)) allInt = false;
      if (allBool && !/^(true|false)$/i.test(v)) allBool = false;
      if (allDate && isNaN(Date.parse(v))) allDate = false;
    }

    if (nonEmptyCount === 0) return 'STR';
    if (allBool) return 'BOOL';
    if (allInt) return 'INT';
    if (allNumeric) return 'FLOAT';
    if (allDate) return 'DATE';
    return 'STR';
  }

  function buildDatasetFromRows(rawRows, filename) {
    if (!rawRows.length) {
      return { columns: [], rows: [] };
    }
    var header = rawRows[0];
    var dataRows = rawRows.slice(1);

    var columns = header.map(function (name, idx) {
      var colValues = dataRows.map(function (r) { return r[idx] !== undefined ? r[idx] : ''; });
      return { name: name || ('Column' + (idx + 1)), type: detectType(colValues) };
    });

    // Normalize row lengths
    var rows = dataRows.map(function (r) {
      var out = [];
      for (var i = 0; i < columns.length; i++) {
        out.push(r[i] !== undefined ? r[i] : '');
      }
      return out;
    });

    return { columns: columns, rows: rows };
  }

  /* ============================================================
     MOCK VALIDATION
     ============================================================ */
  function runMockValidation(dataset) {
    var columns = dataset.columns;
    var rows = dataset.rows;
    var findings = [];
    var rowFlags = rows.map(function () { return { warning: false, error: false }; });
    var columnHealth = columns.map(function () { return 'green'; });

    columns.forEach(function (col, colIdx) {
      var emptyCount = 0;
      rows.forEach(function (r) {
        var v = r[colIdx];
        if (v === '' || v === null || v === undefined) emptyCount++;
      });
      var emptyPct = rows.length ? (emptyCount / rows.length) * 100 : 0;

      if (emptyPct > 20) {
        columnHealth[colIdx] = 'red';
        findings.push({
          severity: 'error',
          column: col.name,
          rowCount: emptyCount,
          message: '`' + col.name + '` has ' + emptyCount + ' null values (' + emptyPct.toFixed(0) + '%).',
          rule: 'null_threshold_v2',
          sql: 'SELECT * FROM dataset WHERE ' + col.name + ' IS NULL OR ' + col.name + ' = \'\';',
          citation: null
        });
        rows.forEach(function (r, ri) {
          if (r[colIdx] === '' || r[colIdx] === null || r[colIdx] === undefined) rowFlags[ri].error = true;
        });
      } else if (emptyPct > 5) {
        if (columnHealth[colIdx] === 'green') columnHealth[colIdx] = 'amber';
        findings.push({
          severity: 'warning',
          column: col.name,
          rowCount: emptyCount,
          message: emptyCount + ' rows in `' + col.name + '` are missing a value (' + emptyPct.toFixed(0) + '%).',
          rule: 'null_threshold_v2',
          sql: 'SELECT * FROM dataset WHERE ' + col.name + ' IS NULL OR ' + col.name + ' = \'\';',
          citation: null
        });
        rows.forEach(function (r, ri) {
          if (r[colIdx] === '' || r[colIdx] === null || r[colIdx] === undefined) rowFlags[ri].warning = true;
        });
      }

      // Numeric negative-value check
      if (col.type === 'INT' || col.type === 'FLOAT') {
        var negRows = [];
        rows.forEach(function (r, ri) {
          var raw = r[colIdx];
          if (raw !== '' && !isNaN(Number(raw)) && Number(raw) < 0) {
            negRows.push(ri);
          }
        });
        if (negRows.length) {
          if (columnHealth[colIdx] === 'green') columnHealth[colIdx] = 'amber';
          var firstNeg = negRows[0];
          findings.push({
            severity: 'warning',
            column: col.name,
            rowCount: negRows.length,
            message: '`' + col.name + '` at row ' + (firstNeg + 1) + ' is negative (' + rows[firstNeg][colIdx] + '). ' + negRows.length + ' row(s) affected. Suggested fix: take absolute value.',
            rule: 'no_negative_currency_v2',
            sql: 'SELECT * FROM dataset WHERE ' + col.name + ' < 0;',
            citation: null
          });
          negRows.forEach(function (ri) { rowFlags[ri].warning = true; });
        }
      }
    });

    return { findings: findings, rowFlags: rowFlags, columnHealth: columnHealth };
  }

  /* ============================================================
     REAL VALIDATION (streaming-validator.js, four-pillar)
     ------------------------------------------------------------
     Runs the real runStreamingValidation() against a snapshot built from
     the parsed dataset, then maps its pillar results into the rail's
     finding format. There is no persisted baseline across page loads in
     this shell pass (baseline is null on every file drop), so schemaDrift
     and arrivalAnomaly always come back null on first run \u2014 exactly the
     "first run degrades gracefully" behavior the module documents. The
     empty-cell / negative-value heuristics from the mock validator are
     layered in underneath the real four-pillar findings so the rail still
     reads richly for a single-batch demo dataset.
     ============================================================ */
  function rowsToRecordArray(dataset) {
    // Streaming validator expects rows shaped as plain objects keyed by
    // column name (mirrors what a DuckDB-WASM query result row looks like).
    return dataset.rows.map(function (row) {
      var obj = {};
      dataset.columns.forEach(function (col, idx) {
        var v = row[idx];
        obj[col.name] = (v === '' || v === undefined) ? null : v;
      });
      return obj;
    });
  }

  function runRealValidation(dataset) {
    var mock = runMockValidation(dataset);

    var snapshot = {
      rows: rowsToRecordArray(dataset),
      columns: dataset.columns.map(function (c) { return { name: c.name, type: c.type }; }),
      timestamp: Date.now()
    };

    var columnsToWatch = dataset.columns
      .filter(function (c) { return c.type === 'INT' || c.type === 'FLOAT'; })
      .map(function (c) { return c.name; });

    var streamingResult;
    try {
      streamingResult = StreamingValidator.runStreamingValidation(
        { columns: snapshot.columns, rows: snapshot.rows, arrivedAt: new Date(snapshot.timestamp).toISOString() },
        null, // no persisted baseline across page loads in this shell pass
        { columnsToWatch: columnsToWatch }
      );
    } catch (_e) {
      streamingResult = null;
    }

    var findings = mock.findings.slice();
    var rowFlags = mock.rowFlags;
    var columnHealth = mock.columnHealth;

    if (streamingResult) {
      if (streamingResult.schemaDrift && streamingResult.schemaDrift.drifted) {
        findings.push({
          severity: 'error',
          column: 'dataset',
          rowCount: dataset.rows.length,
          message: 'Schema drift detected: the column set changed from the prior baseline.',
          rule: 'streaming_schema_drift',
          sql: 'SELECT * FROM dataset; -- schema fingerprint changed',
          citation: null
        });
      }
      if (streamingResult.arrivalAnomaly && streamingResult.arrivalAnomaly.anomaly) {
        findings.push({
          severity: 'warning',
          column: 'dataset',
          rowCount: dataset.rows.length,
          message: 'Arrival anomaly: this batch has ' + streamingResult.arrivalAnomaly.actual + ' rows, outside the expected cadence of ' + streamingResult.arrivalAnomaly.expected + '.',
          rule: 'streaming_arrival_anomaly',
          sql: 'SELECT COUNT(*) FROM dataset;',
          citation: null
        });
      }
      Object.keys(streamingResult.valueDrift || {}).forEach(function (colName) {
        var vd = streamingResult.valueDrift[colName];
        if (vd.meanShift) {
          if (findings.every(function (f) { return f.column !== colName || f.rule !== 'streaming_value_drift'; })) {
            findings.push({
              severity: 'error',
              column: colName,
              rowCount: dataset.rows.length,
              message: '`' + colName + '` shows a statistically significant mean shift versus its prior baseline.',
              rule: 'streaming_value_drift',
              sql: 'SELECT AVG(' + colName + ') FROM dataset;',
              citation: null
            });
          }
        }
      });
    }

    // Sort findings: error/critical first, then warning
    findings.sort(function (a, b) {
      var order = { critical: 0, error: 1, warning: 2 };
      return (order[a.severity] != null ? order[a.severity] : 3) - (order[b.severity] != null ? order[b.severity] : 3);
    });

    var cleanRows = rowFlags.filter(function (f) { return !f.warning && !f.error; }).length;
    var score = rowFlags.length ? Math.round((cleanRows / rowFlags.length) * 100) : 100;

    return { findings: findings, rowFlags: rowFlags, columnHealth: columnHealth, score: score, streamingResult: streamingResult };
  }


  /* ============================================================
     SEQUENCED REVEAL
     ============================================================ */
  function resetRevealUI() {
    revealFileName.classList.add('hidden');
    revealFileName.classList.remove('show');
    revealFileName.textContent = '';

    revealProgressBar.classList.add('hidden');
    revealProgressBar.classList.remove('show');
    progressFill.style.width = '0%';

    revealCounts.classList.add('hidden');
    revealCounts.classList.remove('show');
    rowCountDisplay.textContent = '0 rows';
    colCountDisplay.textContent = '';
    colCountDisplay.classList.remove('show');

    revealHealthDots.innerHTML = '';

    revealFinding.classList.add('hidden');
    revealFinding.classList.remove('show');
    findingText.textContent = '';

    dropZone.classList.remove('fade-out', 'pulse', 'drag-over');
  }

  function animateCountUp(el, target, duration) {
    var startTime = null;
    function step(timestamp) {
      if (startTime === null) startTime = timestamp;
      var elapsed = timestamp - startTime;
      var progress = Math.min(elapsed / duration, 1);
      var current = Math.floor(progress * target);
      el.textContent = current.toLocaleString() + ' row' + (current === 1 ? '' : 's');
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        el.textContent = target.toLocaleString() + ' row' + (target === 1 ? '' : 's');
      }
    }
    requestAnimationFrame(step);
  }

  function runSequencedReveal(dataset, filename, seenBefore) {
    resetRevealUI();

    var validation = runRealValidation(dataset);
    dataset.findings = validation.findings;
    dataset.rowFlags = validation.rowFlags;
    dataset.columnHealth = validation.columnHealth;
    dataset.score = validation.score;
    dataset.streamingResult = validation.streamingResult;

    // Section 10.2: return-use greeting. If we recognize this exact file
    // (by djb2 hash of name+size) from a prior session, show what memory
    // recalls about it before running the (still full) ceremony below.
    if (seenBefore && seenBefore.datasetId) {
      var priorSummary = InstitutionalMemory.summarizeMemory(state.memoryStore, seenBefore.datasetId);
      returnUseBanner.innerHTML = '<strong>We\u2019ve seen this file before.</strong> Here is what was decided last time: ' +
        escapeHtmlText(describeSummaryForBanner(priorSummary));
      returnUseBanner.classList.remove('hidden');
      requestAnimationFrame(function () { returnUseBanner.classList.add('show'); });
    } else {
      returnUseBanner.classList.add('hidden');
      returnUseBanner.classList.remove('show');
      returnUseBanner.innerHTML = '';
    }

    // STEP 1 (0ms): pulse drop zone border teal for 300ms
    dropZone.classList.add('pulse');
    setTimeout(function () {
      dropZone.classList.remove('pulse');
    }, 300);

    // STEP 2 (300ms): show filename, start progress bar fill
    setTimeout(function () {
      revealFileName.textContent = filename;
      revealFileName.classList.remove('hidden');
      requestAnimationFrame(function () { revealFileName.classList.add('show'); });

      revealProgressBar.classList.remove('hidden');
      requestAnimationFrame(function () { revealProgressBar.classList.add('show'); });
      // trigger width transition
      setTimeout(function () { progressFill.style.width = '100%'; }, 30);
    }, 300);

    // STEP 3 (900ms): animate row count up
    setTimeout(function () {
      revealCounts.classList.remove('hidden');
      requestAnimationFrame(function () { revealCounts.classList.add('show'); });
      animateCountUp(rowCountDisplay, dataset.rows.length, 650);
    }, 900);

    // STEP 4 (1100ms): fade in column count
    setTimeout(function () {
      colCountDisplay.textContent = '\u00D7 ' + dataset.columns.length + ' columns';
      colCountDisplay.classList.add('show');
    }, 1100);

    // STEP 5 removed  -  health dots cut (Jobs edit: insight sentence is the reveal)

    // STEP 6: Instant Insight  -  surface the single most interesting finding
    // Delay is now fixed: 1400ms after row count appears, giving a beat of silence
    var findingDelay = 1400;
    setTimeout(function () {
      var insight = InstantInsight.analyze(dataset);
      var sentence = insight.sentence;

      // Style the sentence based on insight type
      revealFinding.removeAttribute('data-insight-type');
      if (insight.type) revealFinding.setAttribute('data-insight-type', insight.type);

      findingText.textContent = sentence;
      revealFinding.classList.remove('hidden');
      requestAnimationFrame(function () { revealFinding.classList.add('show'); });
    }, findingDelay);

    // STEP 7: dissolve ceremony overlay, reveal grid  -  600ms after insight appears
    var finalDelay = findingDelay + 600;
    setTimeout(function () {
      completeCeremony(dataset, filename);
    }, finalDelay);
  }

  // buildFindingSentence retained as fallback; primary path now uses InstantInsight.analyze()
  function buildFindingSentence(dataset) {
    var result = InstantInsight.analyze(dataset);
    return result.sentence;
  }

  function completeCeremony(dataset, filename) {
    // Canvas-first: canvas is already visible  -  dissolve the overlay
    ceremonyScreen.classList.add('dissolve-out');
    setTimeout(function () {
      ceremonyScreen.classList.add('hidden');
      ceremonyScreen.classList.remove('dissolve-out');
    }, 420);

    datasetCounter++;
    var id = 'ds-' + datasetCounter;
    dataset.id = id;
    dataset.name = filename;
    state.datasets.push(dataset);
    // Memory guard check after large file loaded
    if (window.MemoryGuard) setTimeout(function(){ MemoryGuard.checkNow(); }, 1500);
    state.activeDatasetId = id;

    // Remember this file (by content-agnostic name+size hash) so a future
    // drop of "the same" file can trigger the return-use greeting.
    seenFiles[dataset.fileHash] = { datasetId: id, name: filename };

    state.memoryStore = InstitutionalMemory.appendRecord(state.memoryStore, {
      type: InstitutionalMemory.RECORD_TYPES.FILE_LOADED,
      actor: 'human',
      datasetId: id,
      column: null,
      reason: 'File "' + filename + '" loaded (' + dataset.rows.length + ' rows x ' + dataset.columns.length + ' cols).',
      metadata: { filename: filename, rowCount: dataset.rows.length, colCount: dataset.columns.length, fileHash: dataset.fileHash }
    });

    addTab(filename, id, dataset.format);
    renderGrid(dataset);
    enablePublishBtn();
    if (publishPanelOpen) {
      if (publishTitleInput) publishTitleInput.value = filename;
      generatePublishUrl();
    }
    // Enable NL query bar now that we have data
    nlEnableQueryBar(dataset);
    // Pre-render charts so Charts tab is instant
    var cg = $('chart-grid');
    if (cg && typeof ChartEngine !== 'undefined') ChartEngine.renderAll(dataset, cg);
    // Refresh join builder if open (new dataset arrived)
    var jc = $('join-view-inner');
    if (jc && jc._joinInstance) jc._joinInstance.refresh();
    // Run anomaly detection and populate rail
    if (typeof AnomalyTimeline !== 'undefined') {
      var anomReport = AnomalyTimeline.detect(dataset);
      var anomContainer = $('anomaly-container');
      var anomSection = $('anomaly-section');
      if (anomContainer && anomSection) {
        AnomalyTimeline.render(anomReport, anomContainer);
        anomSection.classList.remove('hidden');
        // Click anomaly items to highlight the row
        anomContainer.querySelectorAll('.anom-item').forEach(function (item) {
          item.addEventListener('click', function () {
            var rowIdx = parseInt(item.dataset.rowIndex, 10);
            if (isNaN(rowIdx)) return;
            // Switch to grid view
            document.querySelectorAll('.nav-btn').forEach(function (b) { b.classList.remove('active'); });
            var gb = document.querySelector('[data-view="data"]');
            if (gb) gb.classList.add('active');
            document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); v.classList.remove('active'); });
            var gv = $('grid-view');
            if (gv) { gv.classList.remove('hidden'); gv.classList.add('active'); }
            // Scroll to the row
            var rows = document.querySelectorAll('#grid-tbody tr');
            if (rows[rowIdx]) {
              rows[rowIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
              rows[rowIdx].classList.add('anom-highlight');
              setTimeout(function () { rows[rowIdx].classList.remove('anom-highlight'); }, 2000);
            }
          });
        });
      }

    // FIX: Dispatch dataglow:dataset-loaded so ALL features fire (Skills, Arena, etc.)
    var _evt = new CustomEvent('dataglow:dataset-loaded', { detail: { dataset: dataset } });
    document.dispatchEvent(_evt);
    // FIX: Show the "What do you want to do?" spotlight
    setTimeout(function() {
      if (typeof window._dgSpotlight === 'function') window._dgSpotlight(dataset, filename);
    }, 400);
    }

  }

  function escapeHtmlText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function describeSummaryForBanner(summary) {
    if (!summary || !summary.totalDecisions) return 'No prior activity recorded for this file.';
    var parts = [];
    parts.push(summary.totalDecisions + ' decision(s) logged');
    if (summary.agentFixes) parts.push(summary.agentFixes + ' agent fix(es) accepted');
    if (summary.humanEdits) parts.push(summary.humanEdits + ' manual edit(s)');
    if (summary.dismissals) parts.push(summary.dismissals + ' dismissal(s)');
    if (summary.validationsResolved) parts.push(summary.validationsResolved + ' validation(s) resolved');
    if (summary.topColumns && summary.topColumns.length) {
      parts.push('most-touched column(s): ' + summary.topColumns.join(', '));
    }
    return parts.join(', ') + '.';
  }

  /* ============================================================
     GRID RENDERING
     ============================================================ */
  window.getActiveDataset = function getActiveDataset() {
    return state.datasets.find(function (d) { return d.id === state.activeDatasetId; });
  }

  // ── Canvas Grid instance (PR AO) ─────────────────────────────────────────
  var _canvasGridInstance = null;

  function renderGrid(dataset) {
    // Clear ghost rows / headers from the old DOM table (still in HTML for
    // fallback compatibility  -  hidden by the canvas mount but kept so that
    // any code referencing gridThead/gridTbody never throws)
    if (gridTbody) {
      gridTbody.querySelectorAll('.ghost-row').forEach(function (r) { r.remove(); });
    }
    if (gridThead) {
      gridThead.querySelectorAll('tr').forEach(function (r) {
        if (r.querySelector('.ghost-header')) r.remove();
      });
    }
    setAgentStatus('Analyzing your data...');

    // Mount or update the canvas grid into #grid-container
    var gridContainer = $('grid-container');
    if (!gridContainer) { updateStatusBar(dataset); populateRail(dataset.findings, dataset); return; }

    if (typeof CanvasGrid === 'undefined') {
      // Fallback: DOM table (should never happen after PR AO, but safe)
      updateStatusBar(dataset); populateRail(dataset.findings, dataset); return;
    }

    if (_canvasGridInstance) {
      // Dataset swap  -  keep existing canvas, just update data
      _canvasGridInstance.update(dataset);
    } else {
      // First mount
      _canvasGridInstance = CanvasGrid.mount(gridContainer, dataset, {
        onRowClick: function (ds, rowIdx) {
          var flag = ds.rowFlags ? ds.rowFlags[rowIdx] : {};
          if (flag.warning || flag.error) openRailForRow(ds, rowIdx);
        },
        onColDblClick: function (colIdx) {
          // Trigger ColumnEditor rename via synthetic dblclick on the
          // th element if ColumnEditor is wired; otherwise no-op.
          if (typeof ColumnEditor !== 'undefined' && gridThead) {
            var ths = gridThead.querySelectorAll('th');
            var th = ths[colIdx];
            if (th) {
              var evt = new MouseEvent('dblclick', { bubbles: true });
              th.dispatchEvent(evt);
            }
          }
        },
        onCellFocus: function (cell) {
          // Wire formula bar
          var cellRef = $('formula-cell-ref');
          var cellInput = $('formula-input');
          if (cellRef) {
            var colLetter = String.fromCharCode(65 + Math.min(cell.col, 25));
            cellRef.textContent = colLetter + (cell.row + 1);
          }
          if (cellInput) {
            cellInput.value = (cell.value === null || cell.value === undefined) ? '' : String(cell.value);
          }
        }
      });
    }

    // Keep ColumnEditor attached to DOM thead for rename/type/add-col UI
    // (the editor's UI is triggered from the canvas grid's dblclick → th dispatch)
    if (typeof ColumnEditor !== 'undefined' && gridThead) {
      // Ensure at least one header row exists in the DOM thead for ColumnEditor
      if (!gridThead.querySelector('tr')) {
        var headRow = document.createElement('tr');
        dataset.columns.forEach(function (col) {
          var th = document.createElement('th');
          th.style.display = 'none'; // invisible  -  canvas draws the real header
          headRow.appendChild(th);
        });
        gridThead.appendChild(headRow);
      }
      ColumnEditor.attachToGrid(dataset, gridThead, function (updatedDataset) {
        renderGrid(updatedDataset);
        var cg = $('chart-grid');
        if (cg && typeof ChartEngine !== 'undefined') ChartEngine.renderAll(updatedDataset, cg);
      });
    }

    updateStatusBar(dataset);
    populateRail(dataset.findings, dataset);

    setTimeout(function () {
      var issueCount = dataset.findings.length;
      if (issueCount > 0) {
        setAgentStatus('Ready. ' + issueCount + ' issue' + (issueCount === 1 ? '' : 's') + ' found.');
      } else {
        setAgentStatus('Ready. No issues found.');
      }
    }, 800);
  }

  function updateStatusBar(dataset) {
    statusRows.textContent = dataset.rows.length.toLocaleString() + ' rows';
    statusCols.textContent = dataset.columns.length + ' columns';
    statusValidation.textContent = 'Validation: ' + dataset.score + '%';
    statusFilename.textContent = dataset.name;
  }

  /* ============================================================
     VALIDATION RAIL
     ============================================================ */
  function railColorForDataset(dataset) {
    var hasError = dataset.findings.some(function (f) { return f.severity === 'error' || f.severity === 'critical'; });
    var hasWarning = dataset.findings.some(function (f) { return f.severity === 'warning'; });
    if (hasError) return 'red';
    if (hasWarning) return 'amber';
    return 'green';
  }

  function populateRail(findings, dataset) {
    railFindings.innerHTML = '';

    var color = railColorForDataset(dataset);
    railStrip.className = '';
    if (color === 'amber') railStrip.classList.add('strip-amber');
    if (color === 'red') railStrip.classList.add('strip-red');

    if (!findings.length) {
      var empty = document.createElement('div');
      empty.className = 'finding-item';
      empty.innerHTML = '<span class="finding-severity-label" style="color:var(--success)">Clean</span><div class="finding-sentence"><span class="finding-text">No validation issues found in this dataset.</span></div>';
      railFindings.appendChild(empty);
      return;
    }

    findings.forEach(function (finding, idx) {
      var item = document.createElement('div');
      item.className = 'finding-item severity-' + finding.severity;
      item.dataset.findingIndex = idx;

      var sentenceWrap = document.createElement('div');
      sentenceWrap.className = 'finding-sentence';

      var textWrap = document.createElement('div');
      textWrap.style.flex = '1';

      var label = document.createElement('span');
      label.className = 'finding-severity-label';
      label.textContent = finding.severity;
      textWrap.appendChild(label);

      var textSpan = document.createElement('span');
      textSpan.className = 'finding-text';
      textSpan.textContent = finding.message;
      textWrap.appendChild(textSpan);

      var chevron = document.createElement('button');
      chevron.className = 'finding-chevron';
      chevron.textContent = '\u203A';
      chevron.title = 'Expand detail';

      var dismissBtn = document.createElement('button');
      dismissBtn.className = 'finding-chevron';
      dismissBtn.textContent = '\u00D7';
      dismissBtn.title = 'Dismiss this finding';
      dismissBtn.style.marginLeft = '4px';
      dismissBtn.addEventListener('click', function (evt) {
        evt.stopPropagation();
        item.classList.add('hidden');
        var activeDs = getActiveDataset();
        state.memoryStore = InstitutionalMemory.appendRecord(state.memoryStore, {
          type: InstitutionalMemory.RECORD_TYPES.VALIDATION_DISMISSED,
          actor: 'human',
          datasetId: activeDs ? activeDs.id : null,
          column: finding.column,
          reason: 'Dismissed finding: ' + finding.message,
          metadata: { rule: finding.rule, severity: finding.severity }
        });
      });

      sentenceWrap.appendChild(textWrap);
      sentenceWrap.appendChild(chevron);
      sentenceWrap.appendChild(dismissBtn);

      var detail = document.createElement('div');
      detail.className = 'finding-detail';
      var ruleLine = document.createElement('div');
      ruleLine.className = 'rule-name';
      ruleLine.textContent = 'Rule: ' + finding.rule;
      var sqlPre = document.createElement('pre');
      sqlPre.textContent = finding.sql;
      detail.appendChild(ruleLine);
      detail.appendChild(sqlPre);
      if (finding.citation) {
        var citeP = document.createElement('p');
        citeP.textContent = finding.citation;
        detail.appendChild(citeP);
      } else {
        var noCite = document.createElement('p');
        noCite.style.fontStyle = 'italic';
        noCite.textContent = 'No knowledge-base citation available yet.';
        detail.appendChild(noCite);
      }

      chevron.addEventListener('click', function () {
        detail.classList.toggle('show');
        chevron.classList.toggle('expanded');
      });

      item.appendChild(sentenceWrap);
      item.appendChild(detail);
      railFindings.appendChild(item);
    });
  }

  function openRail() {
    validationRail.classList.remove('rail-collapsed');
    validationRail.classList.add('rail-expanded');
    state.railOpen = true;
  }

  function closeRail() {
    validationRail.classList.remove('rail-expanded');
    validationRail.classList.add('rail-collapsed');
    state.railOpen = false;
    clearActiveRowHighlight();
  }

  function toggleRail() {
    if (state.railOpen) closeRail();
    else openRail();
  }

  function clearActiveRowHighlight() {
    var active = gridTbody.querySelector('tr.row-active');
    if (active) active.classList.remove('row-active');
    state.activeFindingRowIndex = null;
  }

  function openRailForRow(dataset, rowIdx) {
    clearActiveRowHighlight();
    var rows = gridTbody.querySelectorAll('tr');
    var tr = rows[rowIdx];
    if (tr) {
      tr.classList.add('row-active');
      state.activeFindingRowIndex = rowIdx;
    }
    openRail();
    // scroll rail findings to top (mock  -  since findings aren't strictly row-indexed in this demo)
    railFindings.scrollTop = 0;
    if (tr) {
      tr.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ============================================================
     TAB STRIP
     ============================================================ */
  function addTab(name, datasetId, format, opts) {
    opts = opts || {};
    var btn = document.createElement('button');
    btn.className = 'tab-btn active';
    btn.dataset.datasetId = datasetId;

    var dataset = state.datasets.find(function (d) { return d.id === datasetId; });
    var color = dataset ? railColorForDataset(dataset) : 'green';

    var dot = document.createElement('span');
    dot.className = 'tab-health-dot dot-' + color;
    dot.style.background = color === 'green' ? 'var(--success)' : color === 'amber' ? 'var(--warning)' : 'var(--error)';

    var labelWrap = document.createElement('span');
    labelWrap.className = 'tab-label-wrap';

    var label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = name;
    labelWrap.appendChild(label);

    if (opts.subtitle) {
      var subtitle = document.createElement('span');
      subtitle.className = 'tab-subtitle';
      subtitle.textContent = opts.subtitle;
      labelWrap.appendChild(subtitle);
    }

    btn.appendChild(dot);
    if (opts.live) {
      var liveDot = document.createElement('span');
      liveDot.className = 'tab-live-dot';
      liveDot.title = 'Polling for live updates';
      btn.appendChild(liveDot);
    }
    btn.appendChild(labelWrap);

    var fmt = format || (dataset && dataset.format);
    if (fmt) {
      var badge = document.createElement('span');
      badge.className = 'format-badge format-badge--' + fmt;
      badge.textContent = fmt;
      btn.appendChild(badge);
    }

    // Image OCR tabs show a subtle confidence-grade indicator in the same
    // position as the format badge (right after it).
    if (dataset && dataset.ocrConfidence && dataset.ocrConfidence.grade) {
      var confBadge = document.createElement('span');
      confBadge.className = 'ocr-confidence-badge ocr-confidence-badge--' + dataset.ocrConfidence.grade;
      confBadge.textContent = dataset.ocrConfidence.grade;
      confBadge.title = 'OCR confidence: ' + dataset.ocrConfidence.mean + '% mean (Tesseract.js)';
      btn.appendChild(confBadge);
    }

    // Deactivate other tabs
    var existingTabs = tabStrip.querySelectorAll('.tab-btn');
    existingTabs.forEach(function (t) { t.classList.remove('active'); });

    tabStrip.insertBefore(btn, tabAdd);

    btn.addEventListener('click', function () {
      switchToTab(datasetId);
    });

    return btn;
  }

  function switchToTab(datasetId) {
    state.activeDatasetId = datasetId;
    var tabs = tabStrip.querySelectorAll('.tab-btn');
    tabs.forEach(function (t) {
      t.classList.toggle('active', t.dataset.datasetId === datasetId);
    });
    var dataset = getActiveDataset();
    if (dataset) {
      closeRail();
      renderGrid(dataset);
    }
  }

  tabAdd.addEventListener('click', function () {
    // Canvas-first: show ceremony overlay again for next file
    ceremonyScreen.classList.remove('hidden', 'dissolve-out');
    resetRevealUI();
    setAgentStatus('Ready.');
  });

  /* ============================================================
     VIEW SWITCHING
     ============================================================ */
  /* ── Export panel wiring ── */
  var exportBtn   = $('export-btn');
  var exportPanel = $('export-panel');
  var exportClose = $('export-panel-close');
  var exportPanelOpen = false;

  function toggleExportPanel() {
    exportPanelOpen = !exportPanelOpen;
    if (exportPanelOpen) {
      exportPanel.classList.remove('hidden');
    } else {
      exportPanel.classList.add('hidden');
    }
  }
  if (exportBtn)   exportBtn.addEventListener('click',  function (e) { e.stopPropagation(); toggleExportPanel(); });
  if (exportClose) exportClose.addEventListener('click', function ()  { exportPanelOpen = false; exportPanel.classList.add('hidden'); });

  document.addEventListener('click', function (e) {
    if (exportPanelOpen && exportPanel && !exportPanel.contains(e.target) && e.target !== exportBtn) {
      exportPanelOpen = false;
      exportPanel.classList.add('hidden');
    }
  });

  var exportCsvBtn = $('export-csv-btn');
  var exportPngBtn = $('export-png-btn');
  var exportPdfBtn = $('export-pdf-btn');

  if (exportCsvBtn) exportCsvBtn.addEventListener('click', function () {
    var ds = typeof getActiveDataset === 'function' ? getActiveDataset() : null;
    if (ds) ExportEngine.exportCSV(ds, ds.filename ? ds.filename.replace(/\.[^.]+$/, '') : 'dataglow-export');
    exportPanelOpen = false; exportPanel.classList.add('hidden');
  });
  if (exportPngBtn) exportPngBtn.addEventListener('click', function () {
    var cg = $('chart-grid');
    if (cg) ExportEngine.exportChartPNG(cg, 'dataglow-charts');
    exportPanelOpen = false; exportPanel.classList.add('hidden');
  });
  if (exportPdfBtn) exportPdfBtn.addEventListener('click', function () {
    var ds = typeof getActiveDataset === 'function' ? getActiveDataset() : null;
    if (ds) ExportEngine.exportPDF(ds, ds.filename ? ds.filename.replace(/\.[^.]+$/, '') : 'dataglow-report');
    exportPanelOpen = false; exportPanel.classList.add('hidden');
  });

    // ── 3-Tab Nav Switcher ───────────────────────────────────────────────────
  var navBtns = document.querySelectorAll('.nav-btn');

  function activateAnalyzePanel(panelId) {
    document.querySelectorAll('.analyze-panel').forEach(function (p) {
      p.classList.remove('active'); p.classList.add('hidden');
    });
    document.querySelectorAll('.analyze-pill').forEach(function (p) { p.classList.remove('active'); });
    var panel = $(panelId);
    if (panel) { panel.classList.remove('hidden'); panel.classList.add('active'); }
    var pill = document.querySelector('[data-panel="' + panelId + '"]');
    if (pill) pill.classList.add('active');

    if (panelId === 'charts-view') {
      var cg = $('chart-grid');
      if (cg && typeof ChartEngine !== 'undefined') {
        ChartEngine.renderAll(typeof getActiveDataset === 'function' ? getActiveDataset() : null, cg);
      }
    }
    if (panelId === 'dashboard-view') {
      var dv = $('dashboard-view-inner');
      if (dv && typeof DashboardEngine !== 'undefined') {
        DashboardEngine.render(typeof getActiveDataset === 'function' ? getActiveDataset() : null, dv);
      }
    }
    if (panelId === 'sql-view') {
      if (typeof window._svRefresh === 'function') window._svRefresh();
    }
    if (panelId === 'python-view') {
      if (typeof window._pyRefresh === 'function') window._pyRefresh();
    }
    if (panelId === 'review-view') {
      if (window.PeerReview && typeof window.PeerReview.run === 'function') window.PeerReview.run();
    }
    // Force display for panels that use CSS display:none/flex instead of hidden/active classes
    if (panel) { panel.style.display = ''; }
    // Stats: trigger correlation render when switching to stats tab
    if (panelId === 'stats-view') {
      setTimeout(function() {
        var corrBtn = document.querySelector('#stats-seg .stats-seg-btn.active');
        if (corrBtn) corrBtn.click();
        else {
          var firstBtn = document.querySelector('#stats-seg .stats-seg-btn');
          if (firstBtn) firstBtn.click();
        }
      }, 50);
    }
  }

  // Wire analyze pills
  document.querySelectorAll('.analyze-pill').forEach(function (pill) {
    pill.addEventListener('click', function () {
      activateAnalyzePanel(pill.dataset.panel);
    });
  });

  // Wire top-level 3 tabs
  navBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      navBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var view = btn.dataset.view;
      document.querySelectorAll('.view').forEach(function (v) {
        v.classList.add('hidden'); v.classList.remove('active');
      });
      var target = $(view + '-view');
      if (target) { target.classList.remove('hidden'); target.classList.add('active'); }

      // Analyze tab: activate the last-active or default Charts pill
      if (view === 'analyze') {
        var activePill = document.querySelector('.analyze-pill.active');
        var panelId = activePill ? activePill.dataset.panel : 'charts-view';
        activateAnalyzePanel(panelId);
      }

      // Data tab: show merge button if >1 dataset loaded
      if (view === 'data') {
        var mergeBar = $('data-merge-bar');
        if (mergeBar) mergeBar.classList.toggle('hidden', state.datasets.length < 2);
      }
    });
  });

  // Merge datasets button triggers join builder inside Data tab
  var dataMergeBtn = $('data-merge-btn');
  if (dataMergeBtn) {
    dataMergeBtn.addEventListener('click', function () {
      var joinPanel = $('join-view');
      var gridPanel = $('grid-view');
      if (joinPanel && gridPanel) {
        var isOpen = !joinPanel.classList.contains('hidden');
        joinPanel.classList.toggle('hidden', isOpen);
        gridPanel.classList.toggle('hidden', !isOpen);
        dataMergeBtn.textContent = isOpen ? '+ Merge datasets' : '✕ Close merge';
        if (!isOpen) {
          var jc = $('join-view-inner');
          if (jc && typeof JoinBuilder !== 'undefined') {
            if (!jc._joinInstance) {
              jc._joinInstance = JoinBuilder.render(jc, function () { return state.datasets; }, function (result) {
                result.id = 'ds-join-' + Date.now();
                result.fileHash = result.id;
                result.columnHealth = null;
                result.rowFlags = result.rows.map(function () { return { warning: false, error: false }; });
                state.datasets.push(result);
                state.activeDatasetId = result.id;
                renderGrid(result);
                // Go back to grid
                joinPanel.classList.add('hidden');
                gridPanel.classList.remove('hidden');
                dataMergeBtn.textContent = '+ Merge datasets';
              });
            } else {
              jc._joinInstance.refresh();
            }
          }
        }
      }
    });
  }


  /* ============================================================
     SQL VIEW TAB (PR AQ) — full first-class SQL editor tab
     ============================================================ */
  (function () {
    var svInput     = $('sql-view-input');
    var svRun       = $('sql-view-run');
    var svStatus    = $('sql-view-status');
    var svThead     = $('sql-view-results-thead');
    var svTbody     = $('sql-view-results-tbody');
    var svExport    = $('sql-view-export-btn');
    var svSchema    = $('sql-view-schema-list');
    var svSuggBar   = $('sql-view-suggestions-bar');
    var svHistBtn   = $('sql-view-history-btn');
    var svHistPanel = $('sql-view-history-panel');
    var svHistList  = $('sql-view-history-list');
    var svHistClose = $('sql-view-history-close');
    var _lastResult = null;
    var _historyArr = [];
    var _histIdx    = -1;
    var _sqlEng     = null;

    function getSVEngine() {
      if (_sqlEng) return Promise.resolve(_sqlEng);
      return getSQLEngine().then(function (e) { _sqlEng = e; return e; });
    }

    function svRefreshSchema() {
      if (!svSchema) return;
      svSchema.innerHTML = '';
      state.datasets.forEach(function (ds) {
        var tbl = SQLEngine.safeTableName(ds.name);
        var block = document.createElement('div');
        block.className = 'sv-schema-table';
        var tblLabel = document.createElement('div');
        tblLabel.className = 'sv-schema-tbl-name';
        tblLabel.textContent = tbl;
        tblLabel.title = 'Click to insert table name';
        tblLabel.addEventListener('click', function () {
          if (svInput) { svInput.value += '"' + tbl + '"'; svInput.focus(); }
        });
        block.appendChild(tblLabel);
        ds.columns.forEach(function (col) {
          var row = document.createElement('div');
          row.className = 'sv-schema-col';
          row.innerHTML = '<span>' + col.name + '</span><span class="sv-schema-col-type">' + (col.type || '') + '</span>';
          row.title = 'Click to insert column name';
          row.addEventListener('click', function () {
            if (svInput) { svInput.value += '"' + col.name + '"'; svInput.focus(); }
          });
          block.appendChild(row);
        });
        svSchema.appendChild(block);
      });
    }

    function svRefreshSuggestions() {
      if (!svSuggBar) return;
      svSuggBar.innerHTML = '';
      var ds = getActiveDataset();
      if (!ds || typeof SQLEngine.buildSmartSuggestions !== 'function') return;
      var sugs = SQLEngine.buildSmartSuggestions(ds);
      sugs.forEach(function (s) {
        var chip = document.createElement('button');
        chip.className = 'sv-suggestion-chip';
        chip.textContent = s.label;
        chip.title = s.sql;
        chip.addEventListener('click', function () {
          if (svInput) { svInput.value = s.sql; svInput.focus(); }
        });
        svSuggBar.appendChild(chip);
      });
    }

    function svRenderResult(result) {
      if (!svThead || !svTbody || !svStatus) return;
      _lastResult = result;
      svThead.innerHTML = '';
      svTbody.innerHTML = '';
      var headRow = document.createElement('tr');
      result.columns.forEach(function (col) {
        var th = document.createElement('th');
        th.textContent = col.name;
        headRow.appendChild(th);
      });
      svThead.appendChild(headRow);
      result.rows.forEach(function (row) {
        var tr = document.createElement('tr');
        result.columns.forEach(function (col) {
          var td = document.createElement('td');
          var v = row[col.name];
          td.textContent = (v === null || v === undefined || v === '') ? ' - ' : String(v);
          tr.appendChild(td);
        });
        svTbody.appendChild(tr);
      });
      svStatus.className = 'success';
      svStatus.textContent = result.rows.length.toLocaleString() + ' row' +
        (result.rows.length === 1 ? '' : 's') + ' · ' + result.durationMs + 'ms · DuckDB-WASM';
      if (svExport) svExport.classList.toggle('hidden', result.rows.length === 0);
      if (result.rows.length === 0) {
        svStatus.className = '';
        var ds = getActiveDataset();
        var hint = 'Query returned 0 rows.';
        if (ds && /WHERE/i.test(svInput ? svInput.value : '')) hint += ' Try relaxing the WHERE clause.';
        svStatus.textContent = hint;
      }
    }

    function svRenderError(msg) {
      if (!svStatus) return;
      svStatus.className = 'error';
      svStatus.textContent = msg;
      if (svThead) svThead.innerHTML = '';
      if (svTbody) svTbody.innerHTML = '';
      if (svExport) svExport.classList.add('hidden');
    }

    async function svRunQuery() {
      var sql = svInput && svInput.value.trim();
      if (!sql) { if (svStatus) { svStatus.className = ''; svStatus.textContent = 'Enter a query.'; } return; }
      if (!state.datasets.length) { if (svStatus) { svStatus.className = 'error'; svStatus.textContent = 'No dataset loaded. Drop a file first.'; } return; }
      if (svStatus) { svStatus.className = ''; svStatus.textContent = 'Running…'; }
      try {
        var engine = await getSVEngine();
        var result = await engine.runQuery(sql, state.datasets);
        // runQuery fires onResultReady which calls renderSQLResult on the OLD overlay
        // We need to intercept. Patch temporarily:
        if (result && result.columns) {
          svRenderResult(result);
        } else {
          // engine calls onResultReady internally  -  re-read from engine
          var res = engine.getLastResult ? engine.getLastResult() : null;
          if (res) svRenderResult(res);
        }
        // Push to history
        _historyArr.unshift(sql);
        if (_historyArr.length > 50) _historyArr.length = 50;
        _histIdx = -1;
        svRefreshHistory();
      } catch (e) {
        svRenderError(String(e));
      }
    }

    function svRefreshHistory() {
      if (!svHistList) return;
      svHistList.innerHTML = '';
      _historyArr.forEach(function (q) {
        var item = document.createElement('div');
        item.className = 'sv-history-item';
        item.textContent = q;
        item.addEventListener('click', function () {
          if (svInput) { svInput.value = q; svInput.focus(); }
          if (svHistPanel) svHistPanel.classList.add('hidden');
        });
        svHistList.appendChild(item);
      });
    }

    // Wire run button
    if (svRun) svRun.addEventListener('click', svRunQuery);

    // Ctrl+Enter
    if (svInput) {
      svInput.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); svRunQuery(); }
        // Up/Down for history nav
        if (e.key === 'ArrowUp' && _historyArr.length) {
          e.preventDefault();
          _histIdx = Math.min(_histIdx + 1, _historyArr.length - 1);
          svInput.value = _historyArr[_histIdx] || '';
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          _histIdx = Math.max(_histIdx - 1, -1);
          svInput.value = _histIdx >= 0 ? (_historyArr[_histIdx] || '') : '';
        }
        // Tab inserts 2 spaces
        if (e.key === 'Tab') {
          e.preventDefault();
          var start = svInput.selectionStart; var end = svInput.selectionEnd;
          svInput.value = svInput.value.substring(0, start) + '  ' + svInput.value.substring(end);
          svInput.selectionStart = svInput.selectionEnd = start + 2;
        }
      });
    }

    // Export CSV
    if (svExport) {
      svExport.addEventListener('click', function () {
        if (!_lastResult) return;
        SQLEngine.exportResultsCSV(_lastResult.columns, _lastResult.rows);
      });
    }

    // History toggle
    if (svHistBtn && svHistPanel) {
      svHistBtn.addEventListener('click', function () {
        svHistPanel.classList.toggle('hidden');
        svRefreshHistory();
      });
    }
    if (svHistClose && svHistPanel) {
      svHistClose.addEventListener('click', function () { svHistPanel.classList.add('hidden'); });
    }

    // Expose refresh for nav activation
    window._svRefresh = function () {
      svRefreshSchema();
      svRefreshSuggestions();
      getSVEngine().then(function (engine) {
        state.datasets.forEach(function (ds) { engine.loadDataset(ds); });
      });
    };
  })();

  /* ============================================================
     PYTHON VIEW TAB (PR AR) — Pyodide REPL
     ============================================================ */
  (function () {
    var pyInput    = $('py-view-input');
    var pyRun      = $('py-view-run');
    var pyStatus   = $('py-view-status');
    var pyOutput   = $('py-output');
    var pyThead    = $('py-result-thead');
    var pyTbody    = $('py-result-tbody');
    var pyResultW  = $('py-result-wrap');
    var pyExport   = $('py-view-export-btn');
    var pyLoadStat = $('py-view-load-status');
    var pySchList  = $('py-view-schema-list');
    var pySuggBar  = $('py-view-suggestions-bar');
    var _pyodide   = null;
    var _pyLoading = false;
    var _lastDf    = null;

    // Python quick-start snippets
    var PY_STARTERS = [
      { label: 'Load dataset',     code: '# All your datasets are pre-loaded as DataFrames\nimport pandas as pd\ndf = dg.df()  # active dataset\nprint(df.head())\nprint(df.dtypes)' },
      { label: 'Describe',         code: 'df = dg.df()\nprint(df.describe())' },
      { label: 'Group + average',  code: 'df = dg.df()\n# Replace col names with your columns\nresult = df.groupby(df.columns[0])[df.columns[1]].mean().reset_index()\ndg.show(result)' },
      { label: 'Null count',       code: 'df = dg.df()\nprint(df.isnull().sum())' },
      { label: 'Sort top 10',      code: 'df = dg.df()\nresult = df.sort_values(df.columns[-1], ascending=False).head(10)\ndg.show(result)' },
      { label: 'Correlation',      code: 'df = dg.df()\nprint(df.select_dtypes(include=\"number\").corr().round(3))' }
    ];

    function pyRefreshSchema() {
      if (!pySchList) return;
      pySchList.innerHTML = '';
      state.datasets.forEach(function (ds) {
        var badge = document.createElement('div');
        badge.className = 'sv-schema-ds-badge';
        badge.textContent = ds.name.replace(/\.[^.]+$/, '');
        badge.title = ds.rows.length + ' rows, ' + ds.columns.length + ' cols. Click to insert load code.';
        var safeName = 'df_' + SQLEngine.safeTableName(ds.name);
        badge.addEventListener('click', function () {
          if (pyInput) {
            pyInput.value = 'df = dg.df("' + ds.name + '"\nprint(df.head())';
            pyInput.focus();
          }
        });
        pySchList.appendChild(badge);
        ds.columns.forEach(function (col) {
          var row = document.createElement('div');
          row.className = 'sv-schema-col';
          row.innerHTML = '<span>' + col.name + '</span><span class="sv-schema-col-type">' + (col.type || '') + '</span>';
          pySchList.appendChild(row);
        });
      });
    }

    function pyRefreshStarters() {
      if (!pySuggBar) return;
      pySuggBar.innerHTML = '';
      PY_STARTERS.forEach(function (s) {
        var chip = document.createElement('button');
        chip.className = 'sv-suggestion-chip';
        chip.textContent = s.label;
        chip.addEventListener('click', function () {
          if (pyInput) { pyInput.value = s.code; pyInput.focus(); }
        });
        pySuggBar.appendChild(chip);
      });
    }

    function pyShowResult(dfData) {
      // dfData: { columns: [...], rows: [[...], ...] }
      if (!pyThead || !pyTbody || !pyResultW) return;
      _lastDf = dfData;
      pyThead.innerHTML = '';
      pyTbody.innerHTML = '';
      var headRow = document.createElement('tr');
      dfData.columns.forEach(function (c) {
        var th = document.createElement('th'); th.textContent = c; headRow.appendChild(th);
      });
      pyThead.appendChild(headRow);
      dfData.rows.slice(0, 500).forEach(function (row) {
        var tr = document.createElement('tr');
        row.forEach(function (v) {
          var td = document.createElement('td');
          td.textContent = (v === null || v === undefined) ? ' - ' : String(v);
          tr.appendChild(td);
        });
        pyTbody.appendChild(tr);
      });
      pyResultW.classList.remove('hidden');
      if (pyExport) pyExport.classList.remove('hidden');
    }

    function loadPyodide() {
      if (_pyodide) return Promise.resolve(_pyodide);
      if (_pyLoading) return new Promise(function (resolve) {
        var iv = setInterval(function () { if (_pyodide) { clearInterval(iv); resolve(_pyodide); } }, 200);
      });
      _pyLoading = true;
      if (pyLoadStat) pyLoadStat.textContent = 'Loading Python runtime… (~10 MB, first run only)';

      return new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.0/full/pyodide.js';
        script.onload = function () {
          window.loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.0/full/' }).then(function (py) {
            // Load pandas + numpy
            py.loadPackage(['pandas', 'numpy']).then(function () {
              _pyodide = py;
              if (pyLoadStat) pyLoadStat.textContent = 'Python ready';
              resolve(py);
            }).catch(reject);
          }).catch(reject);
        };
        script.onerror = function () { reject(new Error('Failed to load Pyodide CDN.')); };
        document.head.appendChild(script);
      });
    }

    function buildDGHelper(py) {
      // Inject DataGlow helper object into Pyodide so user can do dg.df() / dg.show()
      var datasets = state.datasets;
      var active = getActiveDataset();

      // Build CSV strings for each dataset
      datasets.forEach(function (ds) {
        var safeName = 'dg_csv_' + SQLEngine.safeTableName(ds.name);
        var header = ds.columns.map(function (c) { return JSON.stringify(c.name); }).join(',');
        var rows = ds.rows.map(function (r) {
          return ds.columns.map(function (col, ci) {
            var v = r[ci];
            if (v === null || v === undefined) return '';
            return JSON.stringify(String(v));
          }).join(',');
        });
        var csv = header + '\n' + rows.join('\n');
        py.globals.set(safeName, csv);
      });

      var activeKey = active ? 'dg_csv_' + SQLEngine.safeTableName(active.name) : null;

      // Define dg helper in Python
      var helperCode = [
        'import pandas as pd, io, json',
        'class _DG:',
        '    def df(self, name=None):',
        '        import js',
        '        if name is None:',
        '            key = "' + (activeKey || '') + '"',
        '        else:',
        '            key = "dg_csv_" + "".join(c if c.isalnum() or c == "_" else "_" for c in name.rsplit(".", 1)[0])',
        '        csv_str = js.globals[key] if hasattr(js, "globals") else getattr(js, key, None)',
        '        if csv_str is None: raise ValueError("Dataset not found: " + str(name))',
        '        return pd.read_csv(io.StringIO(str(csv_str)))',
        '    def show(self, df):',
        '        global _dg_show_result',
        '        _dg_show_result = {',
        '            "columns": list(df.columns),',
        '            "rows": df.values.tolist()',
        '        }',
        'dg = _DG()',
        '_dg_show_result = None',
      ].join('\n');
      py.runPython(helperCode);
    }

    async function pyRunCode() {
      var code = pyInput && pyInput.value.trim();
      if (!code) return;
      if (pyStatus && window.LoadingStates) LoadingStates.setLoading(pyStatus, 'Running Python…');
      else if (pyStatus) { pyStatus.className = ''; pyStatus.textContent = 'Running…'; }
      if (pyOutput) pyOutput.textContent = '';
      if (pyResultW) pyResultW.classList.add('hidden');

      try {
        var py = await loadPyodide();
        buildDGHelper(py);

        // Capture stdout
        py.runPython('import sys, io\n_stdout_buf = io.StringIO()\nsys.stdout = _stdout_buf');

        var t0 = Date.now();
        py.runPython(code);
        var elapsed = Date.now() - t0;

        // Get stdout
        var out = py.runPython('_stdout_buf.getvalue()');
        py.runPython('sys.stdout = sys.__stdout__');

        if (pyOutput) pyOutput.textContent = out || '(No output)';
        if (pyStatus) { pyStatus.className = 'success'; pyStatus.textContent = 'Done · ' + elapsed + 'ms'; }

        // Check for dg.show() result
        var showResult = py.runPython('_dg_show_result');
        if (showResult) {
          var dfData = showResult.toJs({ dict_converter: Object.fromEntries });
          if (dfData && dfData.columns) pyShowResult(dfData);
        }
        if (pyLoadStat) pyLoadStat.textContent = 'Python ready';
      } catch (e) {
        var _rawErr = String(e);
        if (window.PythonErrorTranslator && pyStatus) {
          var _active = getActiveDataset();
          var _cols = _active ? _active.columns.map(function(c){return c.name;}) : [];
          var _t = PythonErrorTranslator.translate(_rawErr, _cols);
          if (_t) {
            pyStatus.className = 'error';
            pyStatus.innerHTML = '';
            var _wrap = document.createElement('div');
            _wrap.className = 'dg-error-translated';
            var _title = document.createElement('strong');
            _title.textContent = _t.title;
            _wrap.appendChild(_title);
            var _plain = document.createElement('p');
            _plain.style.cssText = 'margin:4px 0;font-size:12px;';
            _plain.textContent = _t.plain;
            _wrap.appendChild(_plain);
            if (_t.suggestion) {
              var _sug = document.createElement('div');
              _sug.style.cssText = 'color:var(--primary);font-size:11px;font-weight:600;margin-top:4px;';
              _sug.textContent = '→ ' + _t.suggestion;
              _wrap.appendChild(_sug);
            }
            var _raw = document.createElement('span');
            _raw.className = 'dg-error-raw';
            _raw.textContent = _rawErr.split('\n').slice(-3).join(' | ');
            _wrap.appendChild(_raw);
            pyStatus.appendChild(_wrap);
          } else {
            pyStatus.className = 'error';
            pyStatus.textContent = _rawErr;
          }
        } else if (pyStatus) {
          pyStatus.className = 'error';
          pyStatus.textContent = _rawErr;
        }
        if (pyLoadStat) pyLoadStat.textContent = 'Python ready';
      }
    }

    if (pyRun) pyRun.addEventListener('click', pyRunCode);
    if (pyInput) {
      pyInput.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); pyRunCode(); }
        if (e.key === 'Tab') {
          e.preventDefault();
          var s = pyInput.selectionStart, end = pyInput.selectionEnd;
          pyInput.value = pyInput.value.substring(0, s) + '  ' + pyInput.value.substring(end);
          pyInput.selectionStart = pyInput.selectionEnd = s + 2;
        }
      });
    }

    if (pyExport) {
      pyExport.addEventListener('click', function () {
        if (!_lastDf) return;
        var lines = [_lastDf.columns.map(function (c) { return JSON.stringify(c); }).join(',')];
        _lastDf.rows.forEach(function (r) {
          lines.push(r.map(function (v) { return v === null ? '' : JSON.stringify(String(v)); }).join(','));
        });
        var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = 'python_result.csv'; a.click();
      });
    }

    // Expose refresh for nav activation
    window._pyRefresh = function () {
      pyRefreshSchema();
      pyRefreshStarters();
    };

    // Init starters on load
    pyRefreshStarters();
  })();

  /* ============================================================
     AGENT BAR
     ============================================================ */
  function setAgentStatus(text) {
    agentStatus.textContent = text;
  }

  var popoverHideTimer = null;

  function showAgentPopoverForColumn(dataset, col, colIdx, healthClass) {
    if (popoverHideTimer) {
      clearTimeout(popoverHideTimer);
      popoverHideTimer = null;
    }
    var related = dataset.findings.filter(function (f) { return f.column === col.name; });
    var msg;
    if (related.length) {
      msg = related[0].message + (related.length > 1 ? ' (' + (related.length - 1) + ' more issue' + (related.length - 1 === 1 ? '' : 's') + ' in this column.)' : '');
    } else {
      msg = '`' + col.name + '` looks healthy \u2014 no validation issues detected in this column.';
    }
    agentPopoverText.textContent = msg;
    agentPopover.classList.remove('hidden');
    requestAnimationFrame(function () { agentPopover.classList.add('visible'); });

    agentFixBtn.onclick = function () {
      setAgentStatus('Applied suggested fix for `' + col.name + '`.');
      state.memoryStore = InstitutionalMemory.appendRecord(state.memoryStore, {
        type: InstitutionalMemory.RECORD_TYPES.AGENT_FIX_ACCEPTED,
        actor: 'human',
        datasetId: dataset.id,
        column: col.name,
        reason: msg,
        metadata: { colIdx: colIdx, healthClass: healthClass }
      });
      hideAgentPopoverNow();
    };
    agentExplainBtn.onclick = function () {
      openRail();
      state.memoryStore = InstitutionalMemory.appendRecord(state.memoryStore, {
        type: InstitutionalMemory.RECORD_TYPES.AGENT_FIX_DISMISSED,
        actor: 'human',
        datasetId: dataset.id,
        column: col.name,
        reason: 'User asked to see more detail instead of accepting the fix; opened the rail. ' + msg,
        metadata: { colIdx: colIdx, healthClass: healthClass }
      });
      hideAgentPopoverNow();
    };
  }

  function hideAgentPopoverSoon() {
    popoverHideTimer = setTimeout(hideAgentPopoverNow, 200);
  }

  function hideAgentPopoverNow() {
    agentPopover.classList.remove('visible');
    setTimeout(function () { agentPopover.classList.add('hidden'); }, 150);
  }

  agentPopover.addEventListener('mouseenter', function () {
    if (popoverHideTimer) {
      clearTimeout(popoverHideTimer);
      popoverHideTimer = null;
    }
  });
  agentPopover.addEventListener('mouseleave', function () {
    hideAgentPopoverSoon();
  });

  /* ============================================================
     RAIL EVENT WIRING
     ============================================================ */
  railStrip.addEventListener('click', toggleRail);
  railClose.addEventListener('click', closeRail);
  statusValidation.addEventListener('click', toggleRail);

  /* ============================================================
     DARK MODE TOGGLE
     ============================================================ */
  // Ceremony screen theme toggle (mirrors the in-canvas toggle)
  var ceremonyThemeBtn = $('ceremony-theme-btn');
  if (ceremonyThemeBtn) {
    ceremonyThemeBtn.addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
    });
  }

  // Browse-link (ceremony screen "browse files" text)
  var browseLink = $('browse-link');
  if (browseLink) {
    browseLink.addEventListener('click', function () {
      var fi = $('file-input');
      if (fi) fi.click();
    });
  }

  themeToggle.addEventListener('click', function () {
    var current = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = current === 'dark' ? 'light' : 'dark';
  });

  /* ============================================================
     PUBLISH BUTTON (PR AG)
     ============================================================ */
  var publishBtn = $('publish-btn');
  var publishPanel = $('publish-panel');
  var publishPanelClose = $('publish-panel-close');
  var publishTitleInput = $('publish-title-input');
  var publishUrlDisplay = $('publish-url-display');
  var publishCopyBtn = $('publish-copy-btn');
  var publishMetaText = $('publish-meta-text');
  var publishPanelOpen = false;
  var publishUrlCurrent = '';
  var publishDebounceTimer = null;

  function enablePublishBtn() {
    if (publishBtn) publishBtn.disabled = false;
    var eb = $('export-btn');
    if (eb) eb.disabled = false;
  }

  function generatePublishUrl() {
    var dataset = getActiveDataset();
    if (!dataset || !PublishEngine.canPublish(dataset)) return;
    var title = (publishTitleInput && publishTitleInput.value.trim()) || dataset.name || 'DataGlow Snapshot';
    publishUrlDisplay.value = 'Generating...';
    publishCopyBtn.disabled = true;
    PublishEngine.buildSnapshot(dataset, { title: title }).then(function (result) {
      publishUrlCurrent = result.url;
      publishUrlDisplay.value = result.url;
      publishCopyBtn.disabled = false;
      var snappedRows = result.rowCount !== undefined ? result.rowCount : 0;
      var totalRows = result.totalRows !== undefined ? result.totalRows : snappedRows;
      var rowNote = snappedRows < totalRows
        ? snappedRows.toLocaleString() + ' of ' + totalRows.toLocaleString() + ' rows'
        : (snappedRows || totalRows).toLocaleString() + ' rows';
      publishMetaText.textContent = rowNote + ' · ' + result.colCount + ' columns · ' + result.sizeKb + ' KB link';
    }).catch(function () {
      publishUrlDisplay.value = 'Error generating link';
    });
  }

  function openPublishPanel() {
    if (!publishPanel) return;
    publishPanelOpen = true;
    publishPanel.classList.remove('hidden');
    publishBtn.classList.add('active');
    var dataset = getActiveDataset();
    if (dataset && publishTitleInput && !publishTitleInput.value) {
      publishTitleInput.value = dataset.name || '';
    }
    generatePublishUrl();
  }

  function closePublishPanel() {
    publishPanelOpen = false;
    if (publishPanel) publishPanel.classList.add('hidden');
    if (publishBtn) publishBtn.classList.remove('active');
  }

  if (publishBtn) {
    publishBtn.addEventListener('click', function () {
      if (publishPanelOpen) closePublishPanel();
      else openPublishPanel();
    });
  }

  if (publishPanelClose) {
    publishPanelClose.addEventListener('click', closePublishPanel);
  }

  if (publishTitleInput) {
    publishTitleInput.addEventListener('input', function () {
      clearTimeout(publishDebounceTimer);
      publishDebounceTimer = setTimeout(generatePublishUrl, 400);
    });
  }

  if (publishCopyBtn) {
    publishCopyBtn.addEventListener('click', function () {
      if (!publishUrlCurrent) return;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(publishUrlCurrent).then(function () {
          publishCopyBtn.textContent = 'Copied!';
          publishCopyBtn.classList.add('copied');
          setTimeout(function () {
            publishCopyBtn.textContent = 'Copy Link';
            publishCopyBtn.classList.remove('copied');
          }, 2000);
        });
      } else {
        publishUrlDisplay.select();
        document.execCommand('copy');
        publishCopyBtn.textContent = 'Copied!';
        setTimeout(function () { publishCopyBtn.textContent = 'Copy Link'; }, 2000);
      }
    });
  }

  /* ============================================================
     NATURAL LANGUAGE QUERY BAR (PR AH)
     ============================================================ */
  var nlQueryInput = $('nl-query-input');
  var nlThinking = $('nl-thinking');
  var nlAnswerBar = $('nl-answer-bar');
  var nlAnswerText = $('nl-answer-text');
  var nlAnswerIcon = $('nl-answer-icon');
  var nlAnswerClear = $('nl-answer-clear');
  var nlSuggestions = $('nl-suggestions');
  var nlBusy = false;
  var nlLastQuestion = '';

  function nlShowAnswer(result, question) {
    // stop thinking
    if (nlThinking) nlThinking.classList.add('hidden');
    nlBusy = false;
    if (nlQueryInput) { nlQueryInput.disabled = false; nlQueryInput.value = ''; }

    if (!result || !result.answer) return;

    var icon = result.type === 'top' ? '\u2605' :
               result.type === 'count' || result.type === 'rowcount' ? '#' :
               result.type === 'sum' ? '\u03A3' :
               result.type === 'avg' ? '\u00D8' :
               result.type === 'distribution' ? '\u25A6' :
               result.type === 'unique' ? '\u25C6' :
               result.type === 'missing' ? '\u26A0' :
               result.type === 'trend' ? '\u2191' :
               result.type === 'nodata' ? '\u26AA' : '\u25BA';

    if (nlAnswerIcon) nlAnswerIcon.textContent = icon;
    if (nlAnswerText) {
      nlAnswerText.textContent = result.answer;
      nlAnswerText.classList.remove('thinking');
    }
    if (nlAnswerBar) nlAnswerBar.classList.remove('hidden');
  }

  function nlClearAnswer() {
    if (nlAnswerBar) nlAnswerBar.classList.add('hidden');
    if (nlAnswerText) { nlAnswerText.textContent = ''; nlAnswerText.classList.remove('thinking'); }
    if (nlSuggestions) nlSuggestions.classList.add('hidden');
  }

  function nlAsk(question) {
    if (!question || !question.trim() || nlBusy) return;
    var dataset = getActiveDataset();
    nlBusy = true;
    nlLastQuestion = question;
    if (nlQueryInput) nlQueryInput.disabled = true;
    // Show thinking state
    if (nlAnswerText) nlAnswerText.textContent = '';
    if (nlAnswerIcon) nlAnswerIcon.textContent = '';
    if (nlAnswerBar) nlAnswerBar.classList.remove('hidden');
    if (nlThinking) nlThinking.classList.remove('hidden');
    if (nlSuggestions) nlSuggestions.classList.add('hidden');

    NLEngine.ask(question, dataset).then(function (result) {
      nlShowAnswer(result, question);
    }).catch(function () {
      nlBusy = false;
      if (nlQueryInput) nlQueryInput.disabled = false;
      if (nlThinking) nlThinking.classList.add('hidden');
    });
  }

  function nlPopulateSuggestions(dataset) {
    if (!nlSuggestions) return;
    var suggestions = NLEngine.getSuggestions(dataset);
    nlSuggestions.innerHTML = '';
    suggestions.forEach(function (s) {
      var chip = document.createElement('button');
      chip.className = 'nl-suggestion-chip';
      chip.textContent = s;
      chip.addEventListener('click', function () {
        nlClearAnswer();
        nlAsk(s);
      });
      nlSuggestions.appendChild(chip);
    });
    nlSuggestions.classList.remove('hidden');
  }

  function nlEnableQueryBar(dataset) {
    if (nlQueryInput) {
      nlQueryInput.disabled = false;
      nlQueryInput.placeholder = 'Ask a question about your data...';
    }
    // Show suggestions when input is focused for the first time
    if (nlAnswerBar && nlAnswerBar.classList.contains('hidden')) {
      nlAnswerBar.classList.remove('hidden');
      if (nlAnswerText) nlAnswerText.textContent = '';
      if (nlAnswerIcon) nlAnswerIcon.textContent = '';
      nlPopulateSuggestions(dataset);
    }
  }

  if (nlQueryInput) {
    nlQueryInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var q = nlQueryInput.value.trim();
        if (!q) return;
        nlClearAnswer();
        nlAsk(q);
      }
      if (e.key === 'Escape') {
        nlClearAnswer();
        nlQueryInput.blur();
      }
    });

    // Show suggestions on focus when no answer visible
    nlQueryInput.addEventListener('focus', function () {
      var dataset = getActiveDataset();
      if (!dataset) return;
      if (nlAnswerBar && nlAnswerBar.classList.contains('hidden')) {
        nlAnswerBar.classList.remove('hidden');
        nlPopulateSuggestions(dataset);
      }
    });
  }

  if (nlAnswerClear) {
    nlAnswerClear.addEventListener('click', function () {
      nlClearAnswer();
      if (nlQueryInput) { nlQueryInput.value = ''; nlQueryInput.focus(); }
    });
  }

  /* ============================================================
     FILE DROP HANDLING
     ============================================================ */
  ['dragover', 'dragenter'].forEach(function (evt) {
    dropZone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'dragend'].forEach(function (evt) {
    dropZone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {
      handleFileDrop(files);
    }
  });

  dropZone.addEventListener('click', function () {
    fileInput.click();
  });

  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files.length) {
      handleFileDrop(fileInput.files);
    }
  });

  tryExampleLink.addEventListener('click', function (e) {
    e.stopPropagation();
    loadExampleDataset();
  });

  function handleFileDrop(files) {
    // Support multi-file drop by giving each file its own ceremony + tab,
    // sequenced one after another (Test Step 10: multi-file drop -> tab strip).
    var fileList = Array.prototype.slice.call(files);
    processNextDroppedFile(fileList, 0);
  }

  function processNextDroppedFile(fileList, idx) {
    if (idx >= fileList.length) return;
    var file = fileList[idx];
    var name = file.name;
    var fileHash = fileSeenHash(name, file.size);
    var seenBefore = seenFiles[fileHash] || null;

    var advance = function () {
      if (idx + 1 < fileList.length) {
        // Slight stagger so each ceremony is visually distinct.
        setTimeout(function () { processNextDroppedFile(fileList, idx + 1); }, 400);
      }
    };

    // Read first bytes for magic-byte based format detection (drop-zone-router.js).
    var headerReader = new FileReader();
    headerReader.onload = function (headerEvt) {
      var firstBytes = new Uint8Array(headerEvt.target.result);
      var format = DropZoneRouter.detectFileFormat(name, file.type, firstBytes);
      routeDroppedFile(file, name, format, fileHash, seenBefore, advance);
    };
    headerReader.onerror = function () {
      // Fall back to extension-only detection if the header read fails.
      var format = DropZoneRouter.detectFileFormat(name, file.type, null);
      routeDroppedFile(file, name, format, fileHash, seenBefore, advance);
    };
    headerReader.readAsArrayBuffer(file.slice(0, 16));
  }

  function routeDroppedFile(file, name, format, fileHash, seenBefore, advance) {
    var fmt = (format && format.format) || 'unknown';

    if (fmt === 'csv' || fmt === 'tsv' || fmt === 'text' || fmt === 'txt' || fmt === 'log') {
      var reader = new FileReader();
      reader.onload = function (e) {
        var text = e.target.result;
        var dataset;
        if (fmt === 'txt' || fmt === 'log') {
          var parsedText = TextLineParser.parseTextLines(text);
          var kind = TextLineParser.inferTextKind(text.split('\n').slice(0, 20));
          var textDs = TextLineParser.buildTextDataset(parsedText, name, kind);
          dataset = buildDatasetFromRows([textDs.columns].concat(textDs.rows.map(function (r) { return [String(r.line_number), r.content]; })), name);
        } else {
          var rawRows = parseCSV(text);
          dataset = buildDatasetFromRows(rawRows, name);
        }
        dataset.fileHash = fileHash;
        dataset.format = fmt;
        runSequencedReveal(dataset, name, seenBefore);
        advance();
      };
      reader.readAsText(file);
    } else if (fmt === 'json' || fmt === 'ndjson') {
      var jreader = new FileReader();
      jreader.onload = function (e) {
        try {
          var parsedJson = JsonFlattener.parseJsonOrNdjson(e.target.result);
          var json = parsedJson.parsed !== null ? parsedJson.parsed : JSON.parse(e.target.result);
          var dataset = buildDatasetFromJSON(json);
          dataset.fileHash = fileHash;
          dataset.format = parsedJson.isNdjson ? 'ndjson' : 'json';
          runSequencedReveal(dataset, name, seenBefore);
        } catch (err) {
          alert('Could not parse JSON file: ' + err.message);
        }
        advance();
      };
      jreader.readAsText(file);
    } else if (fmt === 'image') {
      // Image OCR (Tesseract.js, client-side, zero upload). The image bytes
      // never leave the browser  -  Tesseract.js runs as a Web Worker. Show a
      // "transcribing" status while OCR runs, then reveal the resulting
      // {line_number, content} dataset exactly like text-line-parser output.
      setAgentStatus('Transcribing image with Tesseract.js (on-device OCR)\u2026');
      var pendingTabId = 'ocr-pending-' + fileHash;
      addPendingTab(pendingTabId, name);

      ImageOcr.runOcr(file).then(function (ocrResult) {
        var parsedOcr = ImageOcr.parseOcrText(ocrResult.text);
        var kind = ImageOcr.inferOcrKind(parsedOcr.rows);
        var confidence = ImageOcr.scoreOcrConfidence(ocrResult.confidences);
        var ocrDs = ImageOcr.buildOcrDataset(parsedOcr, name, kind, confidence);
        var dataset = buildDatasetFromRows([ocrDs.columns].concat(ocrDs.rows.map(function (r) { return [String(r.line_number), r.content]; })), name);
        dataset.fileHash = fileHash;
        dataset.format = fmt;
        dataset.ocrConfidence = confidence;
        dataset.ocrKind = kind;
        dataset.ocrNote = ocrDs.meta.note;
        removePendingTab(pendingTabId);
        setAgentStatus('OCR complete \u2014 confidence: ' + confidence.grade + '.');
        runSequencedReveal(dataset, name, seenBefore);
        advance();
      }).catch(function (err) {
        removePendingTab(pendingTabId);
        setAgentStatus('OCR failed: ' + err.message);
        alert('Could not OCR image: ' + err.message);
        advance();
      });
    } else {
      // Binary formats (XLSX / Parquet / PDF / Arrow / Feather / etc.)  -  routed
      // & labeled via drop-zone-router.js's format detection, but not parsed in
      // this shell pass. Real binary parsing (Univer/DuckDB-WASM) is out of
      // scope for PR S / PR AC.
      var dataset = {
        columns: [
          { name: 'file', type: 'STR' },
          { name: 'status', type: 'STR' }
        ],
        rows: [
          [name, (fmt || 'binary') + ' format detected \u2014 full parsing pending future integration.']
        ],
        fileHash: fileHash,
        format: fmt
      };
      runSequencedReveal(dataset, name, seenBefore);
      advance();
    }
  }

  // A lightweight "transcribing" placeholder tab shown in the tab strip while
  // an async ingestion (OCR, and in the future Whisper transcription) is in
  // flight. Reuses the same tab-strip markup as a real tab so the visual
  // language stays consistent; removed once the real tab is added by
  // completeCeremony() → addTab().
  function addPendingTab(pendingId, displayName) {
    if (!tabStrip || !tabAdd) return;
    var btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.pendingId = pendingId;
    btn.disabled = true;

    var dot = document.createElement('span');
    dot.className = 'tab-health-dot dot-amber';
    dot.style.background = 'var(--warning)';

    var label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = displayName;

    var status = document.createElement('span');
    status.className = 'tab-status-transcribing';
    status.textContent = 'transcribing\u2026';

    btn.appendChild(dot);
    btn.appendChild(label);
    btn.appendChild(status);

    tabStrip.insertBefore(btn, tabAdd);
  }

  function removePendingTab(pendingId) {
    if (!tabStrip) return;
    var btn = tabStrip.querySelector('[data-pending-id="' + pendingId + '"]');
    if (btn) btn.remove();
  }


  function buildDatasetFromJSON(json) {
    var arr = Array.isArray(json) ? json : (json.data && Array.isArray(json.data) ? json.data : [json]);
    if (!arr.length) return { columns: [], rows: [] };

    var colNames = [];
    arr.forEach(function (obj) {
      if (obj && typeof obj === 'object') {
        Object.keys(obj).forEach(function (k) {
          if (colNames.indexOf(k) === -1) colNames.push(k);
        });
      }
    });

    var columns = colNames.map(function (name) {
      var vals = arr.map(function (obj) {
        var v = obj && obj[name] !== undefined ? obj[name] : '';
        return v === null ? '' : String(v);
      });
      return { name: name, type: detectType(vals) };
    });

    var rows = arr.map(function (obj) {
      return colNames.map(function (name) {
        var v = obj && obj[name] !== undefined ? obj[name] : '';
        return v === null ? '' : String(v);
      });
    });

    return { columns: columns, rows: rows };
  }

  function loadExampleDataset() {
    // Show sample picker  -  includes built-in claims demo + SynPUF Medicare datasets
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--surface,#1C1B19);border:1px solid var(--border,#393836);border-radius:12px;padding:24px;max-width:500px;width:90%;color:var(--text,#CDCCCA);font-family:inherit;max-height:80vh;overflow-y:auto;';
    var SAMPLES = [
      { label: 'Claims Demo (10 rows)', desc: 'Small billing claims dataset with intentional data quality issues - great for learning validation.', load: function() {
        var csv = 'claim_id,patient_id,claim_amount,zip_code,status\n1001,P-2001,340.50,60614,paid\n1002,P-2002,-120.00,60615,paid\n1003,P-2003,89.99,6061,paid\n1004,,215.00,60614,pending\n1005,P-2005,410.25,60622,paid\n1006,P-2006,,60622,denied\n1007,P-2007,75.00,60608,paid\n1008,P-2008,60.10,60608,paid\n1009,P-2009,-15.75,60609,paid\n1010,P-2010,120.00,60610,paid\n';
        var rawRows = parseCSV(csv);
        var dataset = buildDatasetFromRows(rawRows, 'claims_example.csv');
        dataset.fileHash = fileSeenHash('claims_example.csv', csv.length);
        var seenBefore = seenFiles[dataset.fileHash] || null;
        runSequencedReveal(dataset, 'claims_example.csv', seenBefore);
      }},
    ];
    // Add SynPUF datasets if available
    if (window.SYNPUF_DATASETS) {
      window.SYNPUF_DATASETS.forEach(function(ds, i) {
        SAMPLES.push({ label: ds.label, desc: ds.description, load: function() {
          var dataset = { columns: ds.columns, rows: ds.rows };
          dataset.fileHash = fileSeenHash(ds.name, ds.rows.length);
          var seenBefore = seenFiles[dataset.fileHash] || null;
          runSequencedReveal(dataset, ds.name + '.csv', seenBefore);
        }});
      });
    }
    box.innerHTML = '<h2 style="margin:0 0 16px;font-size:17px;">Load Sample Dataset</h2>';
    SAMPLES.forEach(function(s) {
      var btn = document.createElement('div');
      btn.style.cssText = 'padding:12px;margin-bottom:8px;background:var(--surface-alt,#201F1D);border:1px solid var(--border,#393836);border-radius:8px;cursor:pointer;transition:border-color 0.15s;';
      btn.innerHTML = '<div style="font-weight:600;font-size:13px;margin-bottom:3px;color:var(--text,#CDCCCA);">' + s.label + '</div><div style="font-size:12px;color:var(--text-muted,#797876);">' + s.desc + '</div>';
      btn.addEventListener('mouseenter', function(){ btn.style.borderColor='var(--primary,#4F98A3)'; });
      btn.addEventListener('mouseleave', function(){ btn.style.borderColor='var(--border,#393836)'; });
      btn.addEventListener('click', function() { overlay.remove(); s.load(); });
      box.appendChild(btn);
    });
    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'background:transparent;border:1px solid var(--border,#393836);border-radius:6px;color:var(--text-muted,#797876);padding:7px 16px;font-size:12px;cursor:pointer;margin-top:4px;';
    cancelBtn.addEventListener('click', function(){ overlay.remove(); });
    box.appendChild(cancelBtn);
    overlay.appendChild(box);
    overlay.addEventListener('click', function(e){ if(e.target===overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  /* ============================================================
     FORMULA BAR (scaffold — cell selection wiring pending Univer)
     ============================================================ */

  /* ============================================================
     FORMULA ENGINE — Excel-style =SUM(), =AVG(), etc. in Grid
     Runs when user types = in formula bar and presses Enter
     ============================================================ */
  var FormulaEngine = (function () {
    'use strict';

    // Parse A1-style range like B2:B100 or B:B
    function parseRange(ref, dataset) {
      // Single cell: A1
      var singleCell = ref.match(/^([A-Z]+)([0-9]+)$/i);
      if (singleCell) {
        var ci = colLetterToIdx(singleCell[1]);
        var ri = parseInt(singleCell[2], 10) - 2; // row 1 = header
        if (ri < 0 || ri >= dataset.rows.length) return [];
        var v = dataset.rows[ri][ci];
        return v !== undefined ? [v] : [];
      }
      // Column range: B2:B100 or B:B
      var colRange = ref.match(/^([A-Z]+)([0-9]*):([A-Z]+)([0-9]*)$/i);
      if (colRange) {
        var c1 = colLetterToIdx(colRange[1]);
        var r1 = colRange[2] ? parseInt(colRange[2], 10) - 2 : 0;
        var c2 = colLetterToIdx(colRange[3]);
        var r2 = colRange[4] ? parseInt(colRange[4], 10) - 2 : dataset.rows.length - 1;
        if (c1 === c2) {
          // Same column range
          var vals = [];
          for (var i = Math.max(0, r1); i <= Math.min(r2, dataset.rows.length - 1); i++) {
            vals.push(dataset.rows[i][c1]);
          }
          return vals;
        }
        // Multi-column range  -  flatten
        var vals2 = [];
        for (var row = Math.max(0, r1); row <= Math.min(r2, dataset.rows.length - 1); row++) {
          for (var col = c1; col <= c2; col++) {
            vals2.push(dataset.rows[row][col]);
          }
        }
        return vals2;
      }
      return [];
    }

    function colLetterToIdx(letter) {
      letter = letter.toUpperCase();
      var idx = 0;
      for (var i = 0; i < letter.length; i++) {
        idx = idx * 26 + (letter.charCodeAt(i) - 64);
      }
      return idx - 1;
    }

    function toNums(vals) {
      return vals.map(function (v) { return parseFloat(v); }).filter(function (n) { return !isNaN(n); });
    }

    function fmt(n) {
      if (n === Math.floor(n)) return n.toLocaleString();
      return parseFloat(n.toFixed(6)).toLocaleString();
    }

    // Evaluate a single function call: FN(range)
    function evalFn(name, args, dataset) {
      name = name.toUpperCase();
      var vals = parseRange(args.trim(), dataset);
      var nums = toNums(vals);

      switch (name) {
        case 'SUM':    return nums.length ? fmt(nums.reduce(function (a, b) { return a + b; }, 0)) : '0';
        case 'AVERAGE':
        case 'AVG':    return nums.length ? fmt(nums.reduce(function (a, b) { return a + b; }, 0) / nums.length) : '#DIV/0!';
        case 'COUNT':  return nums.length.toString();
        case 'COUNTA': return vals.filter(function (v) { return v !== null && v !== undefined && v !== ''; }).length.toString();
        case 'MAX':    return nums.length ? fmt(Math.max.apply(null, nums)) : '#N/A';
        case 'MIN':    return nums.length ? fmt(Math.min.apply(null, nums)) : '#N/A';
        case 'STDEV':
        case 'STDEVP': {
          if (nums.length < 2) return '#N/A';
          var mean = nums.reduce(function (a, b) { return a + b; }, 0) / nums.length;
          var variance = nums.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / nums.length;
          return fmt(Math.sqrt(variance));
        }
        case 'MEDIAN': {
          if (!nums.length) return '#N/A';
          var sorted = nums.slice().sort(function (a, b) { return a - b; });
          var mid = Math.floor(sorted.length / 2);
          return fmt(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
        }
        case 'VAR':
        case 'VARP': {
          if (nums.length < 2) return '#N/A';
          var m2 = nums.reduce(function (a, b) { return a + b; }, 0) / nums.length;
          return fmt(nums.reduce(function (a, b) { return a + Math.pow(b - m2, 2); }, 0) / nums.length);
        }
        case 'ROUND': {
          // ROUND(range, digits)  -  range is single cell
          var parts = args.split(',');
          if (parts.length < 2) return '#ARG!';
          var v = parseRange(parts[0].trim(), dataset);
          var d = parseInt(parts[1].trim(), 10);
          var n = parseFloat(v[0]);
          return isNaN(n) ? '#VALUE!' : fmt(parseFloat(n.toFixed(d)));
        }
        case 'COUNTIF': {
          var cParts = args.split(',');
          if (cParts.length < 2) return '#ARG!';
          var cVals = parseRange(cParts[0].trim(), dataset);
          var crit = cParts[1].trim().replace(/^["']|["']$/g, '');
          var matches = cVals.filter(function (v) { return String(v) === crit; });
          return matches.length.toString();
        }
        case 'SUMIF': {
          var sParts = args.split(',');
          if (sParts.length < 3) return '#ARG!';
          var sRange = parseRange(sParts[0].trim(), dataset);
          var sCrit  = sParts[1].trim().replace(/^["']|["']$/g, '');
          var sSumR  = parseRange(sParts[2].trim(), dataset);
          var sTotal = 0;
          sRange.forEach(function (v, i) {
            if (String(v) === sCrit && i < sSumR.length) {
              var n3 = parseFloat(sSumR[i]);
              if (!isNaN(n3)) sTotal += n3;
            }
          });
          return fmt(sTotal);
        }
        case 'IF': {
          // IF(condition, true_val, false_val)  -  basic: IF(A1>0, "yes", "no")
          return '#IF not supported in bar  -  use SQL for conditional logic';
        }
        default: return '#NAME?  -  unknown function: ' + name;
      }
    }

    // Main evaluate: handles =SUM(B2:B100), =AVG(C:C), arithmetic
    function evaluate(formula, dataset) {
      if (!formula || formula[0] !== '=') return null; // not a formula
      var expr = formula.slice(1).trim();

      // Function call pattern: FNNAME(args)
      var fnMatch = expr.match(/^([A-Z]+)\s*\((.+)\)$/i);
      if (fnMatch) {
        try {
          return evalFn(fnMatch[1], fnMatch[2], dataset);
        } catch (e) {
          return '#ERROR: ' + e.message;
        }
      }

      // Simple arithmetic on cell refs: =A1+B1, =A1*2
      var cellArith = expr.replace(/([A-Z]+[0-9]+)/gi, function (ref) {
        var vals = parseRange(ref, dataset);
        return vals.length ? (parseFloat(vals[0]) || 0) : 0;
      });
      try {
        // eslint-disable-next-line no-eval
        var result = Function('"use strict"; return (' + cellArith + ')')();
        if (typeof result === 'number' && !isNaN(result)) return fmt(result);
        return String(result);
      } catch (e) {
        return '#EXPR?';
      }
    }

    return { evaluate: evaluate };
  })();
  window.FormulaEngine = FormulaEngine;

  var formulaInput = $('formula-input');
  var formulaActiveRef = { rowIdx: null, colIdx: null, originalValue: '' };

  gridTbody.addEventListener('click', function (e) {
    var td = e.target.closest('td');
    if (!td) return;
    var tr = td.parentElement;
    var rowIdx = Array.prototype.indexOf.call(gridTbody.children, tr);
    var colIdx = Array.prototype.indexOf.call(tr.children, td);
    var colLetter = String.fromCharCode(65 + (colIdx % 26));
    $('formula-cell-ref').textContent = colLetter + (rowIdx + 2); // +2: header is row 1
    var originalValue = td.textContent === '\u2014' ? '' : td.textContent;
    formulaInput.value = originalValue;
    formulaActiveRef = { rowIdx: rowIdx, colIdx: colIdx, originalValue: originalValue };
  });

  function commitFormulaEdit() {
    if (formulaActiveRef.rowIdx === null) return;
    var dataset = getActiveDataset();
    if (!dataset) return;
    var newValue = formulaInput.value;
    if (newValue === formulaActiveRef.originalValue) return;

    // Excel-style formula evaluation
    if (newValue && newValue[0] === '=') {
      var computed = FormulaEngine.evaluate(newValue, dataset);
      if (computed !== null) {
        // Show result in formula bar, store formula as cell value display
        formulaInput.value = computed;
        newValue = computed;
      }
    }

    var col = dataset.columns[formulaActiveRef.colIdx];
    dataset.rows[formulaActiveRef.rowIdx][formulaActiveRef.colIdx] = newValue;

    state.memoryStore = InstitutionalMemory.appendRecord(state.memoryStore, {
      type: InstitutionalMemory.RECORD_TYPES.MANUAL_EDIT,
      actor: 'human',
      datasetId: dataset.id,
      column: col ? col.name : null,
      reason: 'Cell edited via formula bar: "' + formulaActiveRef.originalValue + '" \u2192 "' + newValue + '".',
      metadata: { rowIdx: formulaActiveRef.rowIdx, colIdx: formulaActiveRef.colIdx, oldValue: formulaActiveRef.originalValue, newValue: newValue }
    });

    formulaActiveRef.originalValue = newValue;
    renderGrid(dataset);
  }

  formulaInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitFormulaEdit();
    }
    if (e.key === 'Escape') {
      formulaInput.value = formulaActiveRef.originalValue || '';
      formulaInput.blur();
    }
  });
  // Live preview: show formula result in tooltip as user types
  formulaInput.addEventListener('input', function () {
    var val = formulaInput.value;
    var hint = $('formula-fn-hint');
    if (val && val[0] === '=') {
      var ds = getActiveDataset();
      if (ds) {
        var preview = FormulaEngine.evaluate(val, ds);
        if (hint && preview !== null) {
          hint.textContent = '= ' + preview;
          hint.style.opacity = '1';
          hint.style.color = preview.startsWith('#') ? '#DC2626' : 'var(--primary)';
        }
      }
    } else {
      if (hint) { hint.textContent = 'fx'; hint.style.opacity = '0.7'; hint.style.color = 'var(--primary)'; }
    }
  });
  formulaInput.addEventListener('blur', commitFormulaEdit);

  /* ============================================================
     STORY VIEW (story-builder.js real rendering)
     ============================================================ */
  function refreshStoryView() {
    var dataset = getActiveDataset();
    if (!dataset) {
      storyEmpty.classList.remove('hidden');
      storyFrame.classList.add('hidden');
      state.currentStoryDoc = null;
      if (FEATURE_FLAGS.proofExport) updateProofExportButtonState();
      return;
    }

    var titleDateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    var storyDoc = StoryBuilder.buildStory(dataset, dataset.findings || [], state.memoryStore, {
      generateTimeline: InstitutionalMemory.generateTimeline,
      computeProvenanceHash: InstitutionalMemory.computeProvenanceHash,
      datasetId: dataset.id,
      title: dataset.name + ' \u2014 Data Story (' + titleDateStr + ')'
    });

    var validation = StoryBuilder.validateStory(storyDoc);
    if (validation && validation.valid === false) {
      setAgentStatus('Story validation warning: ' + (validation.errors || []).join('; '));
    }

    state.currentStoryDoc = storyDoc;

    var html = StoryBuilder.renderHTML(storyDoc);
    storyEmpty.classList.add('hidden');
    storyFrame.classList.remove('hidden');
    storyFrame.srcdoc = html;

    if (FEATURE_FLAGS.proofExport) updateProofExportButtonState();
  }

  navBtns.forEach(function (btn) {
    if (btn.dataset.view === 'story') {
      btn.addEventListener('click', refreshStoryView);
    }
  });

  storyExportMdBtn.addEventListener('click', function () {
    if (!state.currentStoryDoc) return;
    var md = StoryBuilder.renderMarkdown(state.currentStoryDoc);
    var blob = new Blob([md], { type: 'text/markdown' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var dataset = getActiveDataset();
    a.href = url;
    a.download = (dataset ? dataset.name.replace(/\.[^.]+$/, '') : 'story') + '-story.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (dataset) {
      state.memoryStore = InstitutionalMemory.appendRecord(state.memoryStore, {
        type: InstitutionalMemory.RECORD_TYPES.STORY_EXPORTED,
        actor: 'human',
        datasetId: dataset.id,
        column: null,
        reason: 'Exported Story View as Markdown.',
        metadata: { format: 'markdown' }
      });
    }
  });

  storyExportPdfBtn.addEventListener('click', function () {
    if (storyFrame.contentWindow) {
      storyFrame.contentWindow.focus();
      storyFrame.contentWindow.print();
    } else {
      window.print();
    }
    var dataset = getActiveDataset();
    if (dataset) {
      state.memoryStore = InstitutionalMemory.appendRecord(state.memoryStore, {
        type: InstitutionalMemory.RECORD_TYPES.STORY_EXPORTED,
        actor: 'human',
        datasetId: dataset.id,
        column: null,
        reason: 'Exported Story View as PDF (browser print).',
        metadata: { format: 'pdf' }
      });
    }
  });

  /* ============================================================
     FEATURE: proofExport
     ------------------------------------------------------------
     "Export Proof" button in Story View. Disabled until a story
     has been generated and no unresolved Critical findings remain.
     ============================================================ */
  function updateProofExportButtonState() {
    if (!FEATURE_FLAGS.proofExport) return;
    var dataset = getActiveDataset();

    if (!state.currentStoryDoc) {
      proofExportBtn.disabled = true;
      proofExportBtn.title = 'Generate a story first';
      return;
    }

    var findings = dataset ? (dataset.findings || []) : [];
    var check = ProofBuilder.canExportProof(findings);
    if (!check.allowed) {
      proofExportBtn.disabled = true;
      proofExportBtn.title = 'Resolve all Critical findings to unlock proof export';
      return;
    }

    proofExportBtn.disabled = false;
    proofExportBtn.title = 'Export Proof';
  }

  function applyProofExportVisibility() {
    if (FEATURE_FLAGS.proofExport) {
      proofExportWrapper.classList.remove('hidden');
      updateProofExportButtonState();
    } else {
      proofExportWrapper.classList.add('hidden');
    }
  }

  (function bindProofExportFeature() {
    applyProofExportVisibility();

    proofExportBtn.addEventListener('click', function () {
      if (!FEATURE_FLAGS.proofExport) return;
      var dataset = getActiveDataset();
      if (!dataset || !state.currentStoryDoc) return;

      var findings = dataset.findings || [];
      var check = ProofBuilder.canExportProof(findings);
      if (!check.allowed) return;

      var proofPackage = ProofBuilder.buildProof({
        validationFindings: findings,
        memoryStore: state.memoryStore,
        storyDoc: state.currentStoryDoc,
        datasetName: dataset.name,
        rowCount: dataset.rows.length,
        columnCount: dataset.columns.length,
        sourceFileHash: dataset.fileHash,
        generatedAt: new Date().toISOString(),
        toolVersion: 'dataglow-canvas'
      }, {
        summarizeMemory: InstitutionalMemory.summarizeMemory,
        generateTimeline: InstitutionalMemory.generateTimeline,
        computeProvenanceHash: InstitutionalMemory.computeProvenanceHash,
        computeStoryHash: StoryBuilder.computeStoryHash,
        renderMarkdown: StoryBuilder.renderMarkdown
      });

      var serialized = ProofBuilder.serializeProof(proofPackage);
      var blob = new Blob([serialized], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var timestamp = Date.now();
      var safeName = dataset.name.replace(/\.[^.]+$/, '');
      a.href = url;
      a.download = 'dataglow-' + safeName + '-' + timestamp + '.proof';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      state.memoryStore = InstitutionalMemory.appendRecord(state.memoryStore, {
        type: InstitutionalMemory.RECORD_TYPES.STORY_EXPORTED,
        actor: 'human',
        datasetId: dataset.id,
        column: null,
        reason: 'Exported Proof Package.',
        metadata: { format: 'proof' }
      });
    });
  })();

  /* ============================================================
     FEATURE: dataglowRooms
     ------------------------------------------------------------
     "Create Room" / "Import Room" buttons in Story View.
     ============================================================ */
  function applyDataglowRoomsVisibility() {
    if (FEATURE_FLAGS.dataglowRooms) {
      storyShareSection.classList.remove('hidden');
    } else {
      storyShareSection.classList.add('hidden');
      roomCreateForm.classList.add('hidden');
      roomImportPanel.classList.add('hidden');
    }
  }

  (function bindDataglowRoomsFeature() {
    applyDataglowRoomsVisibility();

    roomCreateBtn.addEventListener('click', function () {
      roomImportPanel.classList.add('hidden');
      roomCreateForm.classList.remove('hidden');
      roomNameInput.value = '';
      roomCreatedByInput.value = '';
      roomNameInput.focus();
    });

    roomCreateCancelBtn.addEventListener('click', function () {
      roomCreateForm.classList.add('hidden');
    });

    roomCreateConfirmBtn.addEventListener('click', function () {
      var dataset = getActiveDataset();
      if (!dataset) return;

      var roomName = (roomNameInput.value || '').trim() || 'Untitled Room';
      var createdBy = (roomCreatedByInput.value || '').trim() || 'Unknown';

      var storySummary = state.currentStoryDoc ? StoryBuilder.renderMarkdown(state.currentStoryDoc) : null;
      var memoryTimeline = InstitutionalMemory.generateTimeline(state.memoryStore);
      var proofHash = state.currentStoryDoc ? StoryBuilder.computeStoryHash(state.currentStoryDoc) : null;

      var room = RoomsBuilder.createRoom({
        findings: dataset.findings || [],
        roomName: roomName,
        createdBy: createdBy,
        createdAt: new Date().toISOString(),
        sourceFileHash: dataset.fileHash,
        datasetName: dataset.name,
        rowCount: dataset.rows.length,
        columnCount: dataset.columns.length,
        memoryTimeline: memoryTimeline,
        storySummary: storySummary,
        proofHash: proofHash
      });

      var serialized = RoomsBuilder.serializeRoom(room);
      var blob = new Blob([serialized], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var safeRoomName = roomName.replace(/[^a-z0-9_-]+/gi, '_');
      a.href = url;
      a.download = safeRoomName + '.room.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      roomCreateForm.classList.add('hidden');

      state.memoryStore = InstitutionalMemory.appendRecord(state.memoryStore, {
        type: InstitutionalMemory.RECORD_TYPES.STORY_EXPORTED,
        actor: 'human',
        datasetId: dataset.id,
        column: null,
        reason: 'Created DataGlow Room "' + roomName + '".',
        metadata: { format: 'room' }
      });
    });

    roomImportBtn.addEventListener('click', function () {
      roomCreateForm.classList.add('hidden');
      roomImportFileInput.click();
    });

    roomImportFileInput.addEventListener('change', function () {
      var file = roomImportFileInput.files && roomImportFileInput.files[0];
      if (!file) return;

      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || '');
        var result = RoomsBuilder.deserializeRoom(text);

        roomImportPanel.classList.remove('hidden');

        if (!result.valid) {
          roomDescribeOutput.textContent = 'Failed to import room: ' + result.errors.join('; ');
          return;
        }

        var verification = RoomsBuilder.verifyRoom(result.room);
        if (!verification.valid) {
          roomDescribeOutput.textContent = 'Room signature invalid: ' + (verification.reason || 'unknown reason');
          return;
        }

        roomDescribeOutput.textContent = RoomsBuilder.describeRoom(result.room);
      };
      reader.readAsText(file);
      roomImportFileInput.value = '';
    });

    roomImportCloseBtn.addEventListener('click', function () {
      roomImportPanel.classList.add('hidden');
    });
  })();

  /* ============================================================
     FEATURE: natsConnector
     ------------------------------------------------------------
     "Live Stream (NATS)" option alongside the file drop zone.
     ============================================================ */
  function applyNatsConnectorVisibility() {
    if (FEATURE_FLAGS.natsConnector) {
      natsSourceWrapper.classList.remove('hidden');
    } else {
      natsSourceWrapper.classList.add('hidden');
      natsConfigForm.classList.add('hidden');
    }
  }

  (function bindNatsConnectorFeature() {
    applyNatsConnectorVisibility();

    function renderNATSConnectionGuide() {
      var config = {
        url: natsUrlInput.value || 'ws://localhost:4221',
        subject: natsSubjectInput.value || 'metrics.>'
      };
      natsConnectionGuide.textContent = NATSBridge.generateConnectionGuide(config);
    }

    natsSourceOption.addEventListener('click', function () {
      var isHidden = natsConfigForm.classList.contains('hidden');
      if (isHidden) {
        natsConfigForm.classList.remove('hidden');
        renderNATSConnectionGuide();
      } else {
        natsConfigForm.classList.add('hidden');
      }
    });

    natsUrlInput.addEventListener('input', renderNATSConnectionGuide);
    natsSubjectInput.addEventListener('input', renderNATSConnectionGuide);

    natsConnectBtn.addEventListener('click', function () {
      var config = {
        url: natsUrlInput.value || '',
        subject: natsSubjectInput.value || '',
        batchSize: Number(natsBatchSizeInput.value) || 100
      };

      var result = NATSMessageParser.validateNATSConfig(config);
      natsConnectStatus.classList.remove('error', 'ready');

      if (!result.valid) {
        natsConnectStatus.classList.add('error');
        natsConnectStatus.textContent = result.errors.join(' ');
        return;
      }

      natsConnectStatus.classList.add('ready');
      natsConnectStatus.textContent = 'Ready to receive';
    });
  })();

  /* ============================================================
     FEATURE: tauriConnector
     ------------------------------------------------------------
     "Native DB" status chip in the agent bar. Hidden entirely in
     a standard browser; only shown when window.__TAURI__ exists.
     ============================================================ */
  var tauriIsRuntimeAvailable = typeof window !== 'undefined' && !!window.__TAURI__;

  function applyTauriConnectorVisibility() {
    if (FEATURE_FLAGS.tauriConnector && tauriIsRuntimeAvailable) {
      tauriDbChip.classList.remove('hidden');
      tauriDbChip.textContent = 'Native DB';
    } else {
      tauriDbChip.classList.add('hidden');
      tauriConnectionsPanel.classList.add('hidden');
    }
  }

  (function bindTauriConnectorFeature() {
    applyTauriConnectorVisibility();
    if (!tauriIsRuntimeAvailable) return;

    var tauriConnectorManagerState = ConnectorManager.createConnectorManager();

    function renderTauriConnectionsPanel() {
      var connections = ConnectorManager.listConnections(tauriConnectorManagerState);
      if (connections.length === 0) {
        tauriConnectionsPanel.innerHTML = '<p>No active native database connections.</p>';
        return;
      }
      var html = connections.map(function (c) {
        return '<p><strong>' + (c.config && c.config.database ? c.config.database : c.connectionId) +
          '</strong> \u2014 ' + c.status + ' (' + c.tableCount + ' tables)</p>';
      }).join('');
      tauriConnectionsPanel.innerHTML = html;
    }

    tauriDbChip.addEventListener('click', function () {
      if (!FEATURE_FLAGS.tauriConnector) return;
      var isHidden = tauriConnectionsPanel.classList.contains('hidden');
      if (isHidden) {
        renderTauriConnectionsPanel();
        tauriConnectionsPanel.classList.remove('hidden');
      } else {
        tauriConnectionsPanel.classList.add('hidden');
      }
    });
  })();



  /* ============================================================
     FEATURE SETTINGS PANEL
     ------------------------------------------------------------
     In-app drawer that lets the user flip FEATURE_FLAGS without
     editing code. Always available regardless of any flag's own
     state. Persists to sessionStorage ONLY (never localStorage --
     it is blocked in the sandbox). Toggling re-runs the same
     apply*Visibility() functions the boot sequence already uses,
     so a change takes effect immediately with no page reload.
     ============================================================ */
  var FEATURE_META = [
    {
      key: 'proofExport',
      name: 'Proof Export',
      description: 'Export a cryptographically verifiable .proof bundle from any validated dataset. Share findings with full integrity chain.',
      badges: [],
      apply: function () { applyProofExportVisibility(); }
    },
    {
      key: 'dataglowRooms',
      name: 'DataGlow Rooms',
      description: 'Create and import signed findings JSON. Share what you found \u2014 without sharing the raw data.',
      badges: [],
      apply: function () { applyDataglowRoomsVisibility(); }
    },
    {
      key: 'natsConnector',
      name: 'Live Stream (NATS)',
      description: 'Connect to a local NATS server via WebSocket to validate live event streams in real time.',
      badges: [],
      apply: function () { applyNatsConnectorVisibility(); }
    },
    {
      key: 'tauriConnector',
      name: 'Native Database',
      description: 'Connect directly to Postgres, MySQL, or SQLite from the desktop app without any cloud intermediary.',
      badges: ['tauri'],
      apply: function () { applyTauriConnectorVisibility(); }
    },
    {
      key: 'questionPrompter',
      name: 'Question Prompter',
      description: 'Surface business questions from your data automatically. Includes pre-upload, post-validation, and streaming modes.',
      badges: ['beta'],
      apply: function () { /* no canvas UI wired yet -- flag state only */ }
    },
    {
      key: 'portfolioNarrativeAssembler',
      name: 'Portfolio Narrative',
      description: 'Automatically assemble a portfolio-ready narrative from your validation findings and story.',
      badges: ['beta'],
      apply: function () { /* no canvas UI wired yet -- flag state only */ }
    }
  ];

  /* ------------------------------------------------------------
     sessionStorage persistence
     ------------------------------------------------------------
     The READ side (restoreFeatureFlagsFromSessionEarly) already ran once,
     right after FEATURE_FLAGS was declared, so first render is correct.
     This is the WRITE side, called whenever a toggle changes.
     ------------------------------------------------------------ */
  function saveFeatureFlagsToSession() {
    try {
      var toSave = {};
      FEATURE_META.forEach(function (meta) {
        toSave[meta.key] = !!FEATURE_FLAGS[meta.key];
      });
      window.sessionStorage.setItem(FEATURE_SETTINGS_STORAGE_KEY, JSON.stringify(toSave));
    } catch (err) {
      // sessionStorage unavailable -- toggles still work for this page life,
      // they simply won't persist across reloads. Never throw.
    }
  }

  /* ------------------------------------------------------------
     Panel rendering
     ------------------------------------------------------------ */
  function featureBadgeHTML(badge) {
    if (badge === 'tauri') return '<span class="feature-badge feature-badge-tauri">Requires Tauri</span>';
    if (badge === 'beta') return '<span class="feature-badge feature-badge-beta">Beta</span>';
    return '';
  }

  function escapeFeatureHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderFeatureSettingsList() {
    var html = FEATURE_META.map(function (meta) {
      var checked = FEATURE_FLAGS[meta.key] ? ' checked' : '';
      var badgesHTML = meta.badges.map(featureBadgeHTML).join('');
      var inputId = 'feature-toggle-' + meta.key;
      return (
        '<div class="feature-row" data-feature-key="' + meta.key + '">' +
          '<div class="feature-row-copy">' +
            '<div class="feature-row-name-line">' +
              '<span class="feature-row-name">' + escapeFeatureHTML(meta.name) + '</span>' +
              badgesHTML +
            '</div>' +
            '<p class="feature-row-desc">' + escapeFeatureHTML(meta.description) + '</p>' +
          '</div>' +
          '<label class="feature-toggle" for="' + inputId + '">' +
            '<input type="checkbox" class="feature-toggle-input" id="' + inputId + '" data-feature-key="' + meta.key + '"' + checked + ' aria-label="' + escapeFeatureHTML(meta.name) + '">' +
            '<span class="feature-toggle-track" aria-hidden="true"></span>' +
          '</label>' +
        '</div>'
      );
    }).join('');
    featureSettingsList.innerHTML = html;

    FEATURE_META.forEach(function (meta) {
      var input = $('feature-toggle-' + meta.key);
      if (!input) return;
      input.addEventListener('change', function () {
        FEATURE_FLAGS[meta.key] = input.checked;
        saveFeatureFlagsToSession();
        meta.apply();
        setAgentStatus((meta.name) + (input.checked ? ' enabled.' : ' disabled.'));
      });
    });
  }

  /* ------------------------------------------------------------
     Open / close + keyboard accessibility
     ------------------------------------------------------------ */
  var featureSettingsLastFocusedEl = null;

  function getFeatureDrawerFocusable() {
    return Array.prototype.slice.call(
      featureSettingsDrawer.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')
    ).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
  }

  function openFeatureSettingsDrawer() {
    featureSettingsLastFocusedEl = document.activeElement;
    renderFeatureSettingsList();
    featureSettingsOverlay.classList.remove('hidden');
    featureSettingsDrawer.classList.remove('hidden');
    featureSettingsBtn.setAttribute('aria-expanded', 'true');
    /* Force reflow so the transform transition plays on open. */
    void featureSettingsDrawer.offsetWidth;
    featureSettingsDrawer.classList.add('drawer-open');
    setTimeout(function () {
      var focusables = getFeatureDrawerFocusable();
      if (focusables.length) focusables[0].focus();
      else featureSettingsClose.focus();
    }, 0);
  }

  function closeFeatureSettingsDrawer() {
    featureSettingsDrawer.classList.remove('drawer-open');
    featureSettingsBtn.setAttribute('aria-expanded', 'false');
    setTimeout(function () {
      featureSettingsOverlay.classList.add('hidden');
      featureSettingsDrawer.classList.add('hidden');
    }, 220);
    if (featureSettingsLastFocusedEl && typeof featureSettingsLastFocusedEl.focus === 'function') {
      featureSettingsLastFocusedEl.focus();
    } else {
      featureSettingsBtn.focus();
    }
  }

  function isFeatureDrawerOpen() {
    return featureSettingsDrawer.classList.contains('drawer-open');
  }

  featureSettingsBtn.addEventListener('click', function () {
    if (isFeatureDrawerOpen()) closeFeatureSettingsDrawer();
    else openFeatureSettingsDrawer();
  });
  featureSettingsClose.addEventListener('click', closeFeatureSettingsDrawer);
  featureSettingsOverlay.addEventListener('click', closeFeatureSettingsDrawer);

  document.addEventListener('keydown', function (e) {
    if (!isFeatureDrawerOpen()) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      closeFeatureSettingsDrawer();
      return;
    }

    if (e.key === 'Tab') {
      var focusables = getFeatureDrawerFocusable();
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });


  /* ============================================================
     LIVE API FEED DRAWER (lightning bolt icon in agent bar)
     ------------------------------------------------------------
     Connects to any REST endpoint or webhook. The fetch() call is
     made directly from the browser (zero-upload guarantee — no
     DataGlow server ever proxies or stores the response). The
     parsed JSON/text is handed to js/ingestion/api-feed.js's pure
     logic (validateFeedUrl / normalizeApiResponse / buildPollSchedule
     / buildFeedDataset, mirrored above as ApiFeed) and the resulting
     rows flow through buildDatasetFromJSON + runRealValidation —
     the exact same pipeline a dropped file uses.
     ============================================================ */
  var liveFeedLastFocusedEl = null;
  var liveFeedPollTimers = {}; // datasetId -> interval handle
  var liveFeedTabMeta = {};    // datasetId -> { url, mode, subtitleEl }

  function getLiveFeedDrawerFocusable() {
    return Array.prototype.slice.call(
      liveFeedDrawer.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
  }

  function openLiveFeedDrawer() {
    liveFeedLastFocusedEl = document.activeElement;
    liveFeedError.classList.add('hidden');
    liveFeedError.textContent = '';
    liveFeedStatus.textContent = '';
    liveFeedOverlay.classList.remove('hidden');
    liveFeedDrawer.classList.remove('hidden');
    liveFeedBtn.setAttribute('aria-expanded', 'true');
    void liveFeedDrawer.offsetWidth;
    liveFeedDrawer.classList.add('drawer-open');
    setTimeout(function () {
      if (liveFeedUrlInput) liveFeedUrlInput.focus();
    }, 0);
  }

  function closeLiveFeedDrawer() {
    liveFeedDrawer.classList.remove('drawer-open');
    liveFeedBtn.setAttribute('aria-expanded', 'false');
    setTimeout(function () {
      liveFeedOverlay.classList.add('hidden');
      liveFeedDrawer.classList.add('hidden');
    }, 220);
    if (liveFeedLastFocusedEl && typeof liveFeedLastFocusedEl.focus === 'function') {
      liveFeedLastFocusedEl.focus();
    } else {
      liveFeedBtn.focus();
    }
  }

  function isLiveFeedDrawerOpen() {
    return liveFeedDrawer.classList.contains('drawer-open');
  }

  liveFeedBtn.addEventListener('click', function () {
    if (isLiveFeedDrawerOpen()) closeLiveFeedDrawer();
    else openLiveFeedDrawer();
  });
  liveFeedClose.addEventListener('click', closeLiveFeedDrawer);
  liveFeedOverlay.addEventListener('click', closeLiveFeedDrawer);

  document.addEventListener('keydown', function (e) {
    if (!isLiveFeedDrawerOpen()) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      closeLiveFeedDrawer();
      return;
    }

    if (e.key === 'Tab') {
      var focusables = getLiveFeedDrawerFocusable();
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  /* Headers textarea is collapsible. */
  liveFeedHeadersToggle.addEventListener('click', function () {
    var collapsed = liveFeedHeadersWrapper.classList.toggle('collapsed');
    liveFeedHeadersToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });

  /* Body textarea + append/replace toggle only make sense for POST / polling. */
  function refreshLiveFeedFormVisibility() {
    var isPost = liveFeedMethodSelect.value === 'POST';
    liveFeedBodyField.classList.toggle('hidden', !isPost);

    var pollMs = parseInt(liveFeedPollSelect.value, 10) || 0;
    liveFeedModeWrapper.classList.toggle('hidden', pollMs === 0);
  }
  liveFeedMethodSelect.addEventListener('change', refreshLiveFeedFormVisibility);
  liveFeedPollSelect.addEventListener('change', refreshLiveFeedFormVisibility);
  refreshLiveFeedFormVisibility();

  function showLiveFeedError(msg) {
    liveFeedError.textContent = msg;
    liveFeedError.classList.remove('hidden');
  }
  function clearLiveFeedError() {
    liveFeedError.textContent = '';
    liveFeedError.classList.add('hidden');
  }

  function currentLiveFeedMode() {
    var checked = liveFeedDrawer.querySelector('input[name="live-feed-mode"]:checked');
    return checked ? checked.value : 'replace';
  }

  /* Ingest a live-feed API response through the exact same pipeline a
     dropped file uses: buildDatasetFromJSON -> runRealValidation ->
     addTab/renderGrid (see routeDroppedFile's 'json'/'ndjson' branch). */
  function ingestLiveFeedRows(rows, url, pollSchedule, datasetId) {
    var jsonShapedRows = rows; // already flat objects from ApiFeed.normalizeApiResponse
    var dataset = buildDatasetFromJSON(jsonShapedRows);
    var validation = runRealValidation(dataset);
    dataset.findings = validation.findings;
    dataset.rowFlags = validation.rowFlags;
    dataset.columnHealth = validation.columnHealth;
    dataset.score = validation.score;
    dataset.streamingResult = validation.streamingResult;
    dataset.format = 'api';
    dataset.fileHash = fileSeenHash(url, jsonShapedRows.length);

    var hostname;
    try { hostname = new URL(url).hostname; } catch (e) { hostname = url; }

    if (datasetId) {
      // Existing tab being refreshed by polling  -  replace or append rows.
      var existing = state.datasets.find(function (d) { return d.id === datasetId; });
      if (existing) {
        if (currentLiveFeedMode() === 'append') {
          dataset.rows = existing.rows.concat(dataset.rows);
          var revalidated = runRealValidation(dataset);
          dataset.findings = revalidated.findings;
          dataset.rowFlags = revalidated.rowFlags;
          dataset.columnHealth = revalidated.columnHealth;
          dataset.score = revalidated.score;
        }
        dataset.id = datasetId;
        dataset.name = existing.name;
        var idx = state.datasets.indexOf(existing);
        state.datasets[idx] = dataset;

        var tabBtn = tabStrip.querySelector('.tab-btn[data-dataset-id="' + datasetId + '"]');
        if (tabBtn) {
          var subtitleEl = tabBtn.querySelector('.tab-subtitle');
          if (subtitleEl) subtitleEl.textContent = 'Fetched ' + new Date().toLocaleTimeString();
        }
        if (state.activeDatasetId === datasetId) renderGrid(dataset);
        return datasetId;
      }
    }

    datasetCounter++;
    var id = 'ds-' + datasetCounter;
    dataset.id = id;
    dataset.name = hostname;
    state.datasets.push(dataset);
    state.activeDatasetId = id;

    state.memoryStore = InstitutionalMemory.appendRecord(state.memoryStore, {
      type: InstitutionalMemory.RECORD_TYPES.FILE_LOADED,
      actor: 'human',
      datasetId: id,
      column: null,
      reason: 'Live API feed "' + url + '" loaded (' + dataset.rows.length + ' rows x ' + dataset.columns.length + ' cols).',
      metadata: { url: url, rowCount: dataset.rows.length, colCount: dataset.columns.length }
    });

    if (canvas.classList.contains('hidden')) {
      ceremonyScreen.classList.add('hidden');
      canvas.classList.remove('hidden');
    }

    addTab(hostname, id, 'api', {
      live: !pollSchedule.isOneShot,
      subtitle: 'Fetched ' + new Date().toLocaleTimeString()
    });
    switchToTab(id);
    setAgentStatus('Live feed loaded from ' + hostname + ' (' + dataset.rows.length + ' rows).');
    return id;
  }

  function startLiveFeedPolling(datasetId, pollSchedule, headers, method, body) {
    if (pollSchedule.isOneShot) return;
    if (liveFeedPollTimers[datasetId]) clearInterval(liveFeedPollTimers[datasetId]);
    liveFeedPollTimers[datasetId] = setInterval(function () {
      performLiveFetch(pollSchedule.url, method, headers, body, pollSchedule, datasetId);
    }, pollSchedule.intervalMs);
  }

  function performLiveFetch(url, method, headers, body, pollSchedule, existingDatasetId) {
    var fetchOpts = { method: method, headers: headers };
    if (method === 'POST' && body) fetchOpts.body = body;

    return fetch(url, fetchOpts)
      .then(function (resp) {
        return resp.text().then(function (text) {
          var parsed;
          try { parsed = JSON.parse(text); }
          catch (e) { parsed = text; }
          var norm = ApiFeed.normalizeApiResponse(parsed);
          if (!norm.rows.length) {
            liveFeedStatus.textContent = norm.warning || 'No rows found in response.';
            return null;
          }
          var newId = ingestLiveFeedRows(norm.rows, url, pollSchedule, existingDatasetId);
          liveFeedStatus.textContent = 'Fetched ' + norm.rows.length + ' row(s) from ' + url + ' at ' + new Date().toLocaleTimeString() + '.';
          return newId;
        });
      })
      .catch(function (err) {
        liveFeedStatus.textContent = 'Fetch failed: ' + err.message;
        return null;
      });
  }

  liveFeedFetchBtn.addEventListener('click', function () {
    clearLiveFeedError();
    var check = ApiFeed.validateFeedUrl(liveFeedUrlInput.value);
    if (!check.valid) {
      showLiveFeedError(check.error);
      return;
    }
    var url = check.normalized;
    var method = liveFeedMethodSelect.value;
    var headers = ApiFeed.parseHeadersString(liveFeedHeadersInput.value);
    var body = liveFeedBodyInput.value.trim() || null;
    var pollMs = parseInt(liveFeedPollSelect.value, 10) || 0;
    var pollSchedule = ApiFeed.buildPollSchedule(pollMs, method, url, headers);

    liveFeedFetchBtn.disabled = true;
    liveFeedStatus.textContent = 'Fetching ' + url + ' ...';

    performLiveFetch(url, method, headers, body, pollSchedule, null).then(function (newDatasetId) {
      liveFeedFetchBtn.disabled = false;
      if (newDatasetId && !pollSchedule.isOneShot) {
        startLiveFeedPolling(newDatasetId, pollSchedule, headers, method, body);
      }
      if (newDatasetId) closeLiveFeedDrawer();
    });
  });


  /* Apply any session-restored flag state to the DOM at boot, after all
     apply*Visibility() functions above have been defined. */
  FEATURE_META.forEach(function (meta) { meta.apply(); });


  /* ============================================================
     SQL MODE (Tier 3 overlay — Cmd+`/Ctrl+`)
     ============================================================ */
  function openSqlOverlay() {
    sqlOverlay.classList.remove('hidden');
    sqlStatus.textContent = '';
    sqlResultsThead.innerHTML = '';
    sqlResultsTbody.innerHTML = '';
    setTimeout(function () { sqlInput.focus(); }, 0);
  }

  function closeSqlOverlay() {
    sqlOverlay.classList.add('hidden');
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === '`') {
      e.preventDefault();
      if (sqlOverlay.classList.contains('hidden')) openSqlOverlay();
      else closeSqlOverlay();
    } else if (e.key === 'Escape' && !sqlOverlay.classList.contains('hidden')) {
      closeSqlOverlay();
    }
  });

  sqlCloseBtn.addEventListener('click', closeSqlOverlay);

  function runMockSqlQuery(sql) {
    var dataset = getActiveDataset();
    if (!dataset) return { columns: [], rows: [] };

    var upper = sql.toUpperCase();
    if (upper.indexOf('SELECT') === -1) {
      return { columns: [], rows: [] };
    }

    var whereIdx = upper.indexOf('WHERE');
    var matchingRows = dataset.rows;

    if (whereIdx !== -1) {
      var whereText = sql.slice(whereIdx + 5).toLowerCase();
      var matchedColIdxs = [];
      dataset.columns.forEach(function (col, idx) {
        if (whereText.indexOf(col.name.toLowerCase()) !== -1) matchedColIdxs.push(idx);
      });
      if (matchedColIdxs.length) {
        // Very small mock: filter to rows where at least one matched column
        // has a non-empty value, to visibly narrow the result set.
        matchingRows = dataset.rows.filter(function (row) {
          return matchedColIdxs.some(function (idx) {
            var v = row[idx];
            return v !== '' && v !== null && v !== undefined;
          });
        });
      }
    }

    return { columns: dataset.columns, rows: matchingRows.slice(0, 10) };
  }

  // ── Real DuckDB-WASM SQL Engine init ──────────────────────────────────────
  var sqlEngineInstance = null;
  var sqlEngineLoading = false;

  function getSQLEngine() {
    if (sqlEngineInstance) return Promise.resolve(sqlEngineInstance);
    if (sqlEngineLoading) return new Promise(function (resolve) {
      var iv = setInterval(function () { if (sqlEngineInstance) { clearInterval(iv); resolve(sqlEngineInstance); } }, 100);
    });
    sqlEngineLoading = true;
    sqlEngineInstance = SQLEngine.init({
      onResultReady: renderSQLResult,
      onError: function (msg) { renderSQLError(msg); }
    });
    return Promise.resolve(sqlEngineInstance);
  }

  function renderSQLResult(result, sql) {
    var thead = $('sql-results-thead');
    var tbody = $('sql-results-tbody');
    var status = $('sql-status');
    var exportBtn = $('sql-export-btn');
    if (!thead || !tbody || !status) return;

    thead.innerHTML = '';
    tbody.innerHTML = '';

    var headRow = document.createElement('tr');
    result.columns.forEach(function (col) {
      var th = document.createElement('th');
      th.textContent = col.name;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    result.rows.forEach(function (row) {
      var tr = document.createElement('tr');
      result.columns.forEach(function (col) {
        var td = document.createElement('td');
        var v = row[col.name];
        td.textContent = (v === null || v === undefined || v === '') ? ' - ' : String(v);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    status.className = 'success';
    status.textContent = result.rows.length.toLocaleString() + ' row' + (result.rows.length === 1 ? '' : 's') +
      ' · ' + result.durationMs + 'ms · DuckDB-WASM';
    if (exportBtn) exportBtn.classList.toggle('hidden', result.rows.length === 0);

    // Zero-rows hint
    if (result.rows.length === 0) {
      var ds = getActiveDataset();
      var hint = SQLEngine.init.prototype ? null : null; // instance-based
      status.className = '';
      var suggestion = 'Query returned 0 rows.';
      if (ds && /WHERE/i.test(sql)) suggestion += ' Try relaxing the WHERE clause.';
      if (ds) suggestion += ' Table "' + SQLEngine.safeTableName(ds.name) + '" has ' + ds.rows.length.toLocaleString() + ' rows.';
      status.textContent = suggestion;
    }
  }

  function renderSQLError(msg) {
    var status = $('sql-status');
    if (!status) return;
    $('sql-results-thead').innerHTML = '';
    $('sql-results-tbody').innerHTML = '';
    if ($('sql-export-btn')) $('sql-export-btn').classList.add('hidden');

    // Try translated error first
    if (window.SQLErrorTranslator) {
      var t = SQLErrorTranslator.translate(msg, state.datasets);
      if (t) {
        status.className = 'error';
        status.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'dg-error-translated';
        var title = document.createElement('strong');
        title.textContent = t.title;
        wrap.appendChild(title);
        var plain = document.createElement('p');
        plain.style.cssText = 'margin:4px 0;font-size:12px;';
        plain.textContent = t.plain;
        wrap.appendChild(plain);
        if (t.suggestion) {
          var sug = document.createElement('div');
          sug.className = 'dg-error-suggestion';
          sug.textContent = t.fix ? '→ ' + t.suggestion + ' (click to fix)' : '→ ' + t.suggestion;
          if (t.fix) {
            sug.addEventListener('click', function() {
              var inp = $('sql-input');
              if (inp) {
                inp.value = inp.value.replace(new RegExp('"?' + t.fix.replace(/[.*+?^${}()|[\]\\]/g,'\$&').replace(/^"|"$/g,'') + '"?', 'g'), t.fix);
                inp.focus();
              }
            });
          }
          wrap.appendChild(sug);
        }
        var raw = document.createElement('span');
        raw.className = 'dg-error-raw';
        raw.textContent = t.raw;
        wrap.appendChild(raw);
        status.appendChild(wrap);
        return;
      }
    }
    // Fallback: plain text
    status.className = 'error';
    status.textContent = msg;
  }

  function refreshSQLSchema() {
    var schemaList = $('sql-schema-list');
    if (!schemaList) return;
    schemaList.innerHTML = '';
    state.datasets.forEach(function (ds) {
      var tblName = SQLEngine.safeTableName(ds.name);
      var block = document.createElement('div');
      block.className = 'sql-schema-table';
      var tblLabel = document.createElement('div');
      tblLabel.className = 'sql-schema-tbl-name';
      tblLabel.textContent = tblName;
      tblLabel.title = 'Click to insert table name';
      tblLabel.addEventListener('click', function () {
        var inp = $('sql-input');
        if (inp) { inp.value += '"' + tblName + '"'; inp.focus(); }
      });
      block.appendChild(tblLabel);
      ds.columns.forEach(function (col) {
        var row = document.createElement('div');
        row.className = 'sql-schema-col';
        row.innerHTML = '<span>' + col.name + '</span><span class="sql-schema-col-type">' + (col.type || '') + '</span>';
        row.title = 'Click to insert column name';
        row.addEventListener('click', function () {
          var inp = $('sql-input');
          if (inp) { inp.value += '"' + col.name + '"'; inp.focus(); }
        });
        block.appendChild(row);
      });
      schemaList.appendChild(block);
    });
  }

  function refreshSQLSuggestions() {
    var bar = $('sql-suggestions-bar');
    if (!bar) return;
    bar.innerHTML = '';
    var ds = getActiveDataset();
    if (!ds) return;
    var suggestions = SQLEngine.init({ getDatasets: function(){return state.datasets;} }).buildSmartSuggestions
      ? null : null;
    // Use the module's static function
    var sugs = typeof SQLEngine.buildSmartSuggestions === 'function'
      ? SQLEngine.buildSmartSuggestions(ds)
      : [];
    sugs.forEach(function (s) {
      var chip = document.createElement('button');
      chip.className = 'sql-suggestion-chip';
      chip.textContent = s.label;
      chip.title = s.sql;
      chip.addEventListener('click', function () {
        var inp = $('sql-input');
        if (inp) { inp.value = s.sql; inp.focus(); }
      });
      bar.appendChild(chip);
    });
  }

  // Expose buildSmartSuggestions at module level for refreshSQLSuggestions
  SQLEngine.buildSmartSuggestions = (function () {
    // Replicate the function inline so it works without an instance
    var safeN = SQLEngine.safeTableName;
    return function (dataset) {
      if (!dataset || !dataset.columns) return [];
      var tbl = '"' + safeN(dataset.name) + '"';
      var cols = dataset.columns;
      var numCols = cols.filter(function (c) { return c.type === 'number' || c.type === 'integer' || c.type === 'double' || c.type === 'float'; });
      var catCols = cols.filter(function (c) { return c.type === 'text' || c.type === 'varchar' || c.type === 'string'; });
      var dateCols = cols.filter(function (c) { return c.type === 'date' || c.type === 'timestamp' || /date/i.test(c.name); });
      var s = [];
      s.push({ label: 'Count all rows', sql: 'SELECT COUNT(*) AS total_rows\nFROM ' + tbl });
      if (cols.length) {
        s.push({ label: 'Null check', sql: 'SELECT\n' + cols.slice(0, 5).map(function (c) { return '  COUNT(*) - COUNT("' + c.name + '") AS "' + c.name + '_nulls"'; }).join(',\n') + '\nFROM ' + tbl });
      }
      if (catCols.length && numCols.length) {
        s.push({ label: 'Group by ' + catCols[0].name, sql: 'SELECT\n  "' + catCols[0].name + '",\n  COUNT(*) AS count,\n  ROUND(AVG("' + numCols[0].name + '"), 2) AS avg_' + numCols[0].name.replace(/[^a-z0-9]/gi, '_') + '\nFROM ' + tbl + '\nGROUP BY "' + catCols[0].name + '"\nORDER BY count DESC\nLIMIT 10' });
      }
      if (numCols.length) {
        s.push({ label: 'Top 10 by ' + numCols[0].name, sql: 'SELECT *\nFROM ' + tbl + '\nORDER BY "' + numCols[0].name + '" DESC\nLIMIT 10' });
      }
      if (dateCols.length && numCols.length) {
        s.push({ label: 'Monthly trend', sql: 'SELECT\n  DATE_TRUNC(\'month\', "' + dateCols[0].name + '") AS month,\n  COUNT(*) AS count,\n  ROUND(SUM("' + numCols[0].name + '"), 2) AS total\nFROM ' + tbl + '\nGROUP BY month\nORDER BY month' });
      }
      s.push({ label: 'Find duplicates', sql: 'SELECT\n  ' + cols.slice(0, 3).map(function (c) { return '"' + c.name + '"'; }).join(', ') + ',\n  COUNT(*) AS occurrences\nFROM ' + tbl + '\nGROUP BY ' + cols.slice(0, 3).map(function (c) { return '"' + c.name + '"'; }).join(', ') + '\nHAVING COUNT(*) > 1\nORDER BY occurrences DESC' });
      return s;
    };
  })();

  // Wire up SQL run
  async function runSQL() {
    var sql = $('sql-input') && $('sql-input').value.trim();
    var status = $('sql-status');
    if (!sql) { if (status) status.textContent = 'Enter a query.'; return; }
    if (!state.datasets.length) { if (status) status.textContent = 'No dataset loaded. Drop a file first.'; return; }
    if (status && window.LoadingStates) LoadingStates.setLoading(status, 'Running query…');
    else if (status) { status.className = ''; status.textContent = 'Running…'; }
    try {
      var engine = await getSQLEngine();
      await engine.runQuery(sql, state.datasets);
      engine.history.push(sql);
      state.memoryStore = InstitutionalMemory.appendRecord(state.memoryStore, {
        type: InstitutionalMemory.RECORD_TYPES.SQL_QUERY,
        actor: 'human', datasetId: state.activeDatasetId, column: null,
        reason: 'SQL query executed via DuckDB-WASM.',
        metadata: { sql: sql }
      });
    } catch (e) { /* error already rendered by onError */ }
  }

  sqlRunBtn.addEventListener('click', runSQL);

  // Ctrl+Enter shortcut
  $('sql-input') && $('sql-input').addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSQL(); }
  });

  // Export button
  var sqlExportBtn = $('sql-export-btn');
  if (sqlExportBtn) {
    sqlExportBtn.addEventListener('click', async function () {
      var engine = await getSQLEngine();
      var res = engine.getLastResult();
      if (res) SQLEngine.exportResultsCSV(res.columns, res.rows);
    });
  }

  // History panel
  var sqlHistoryBtn = $('sql-history-btn');
  var sqlHistoryPanel = $('sql-history-panel');
  var sqlHistoryClose = $('sql-history-close');
  if (sqlHistoryBtn && sqlHistoryPanel) {
    sqlHistoryBtn.addEventListener('click', async function () {
      sqlHistoryPanel.classList.toggle('hidden');
      if (!sqlHistoryPanel.classList.contains('hidden')) {
        var engine = await getSQLEngine();
        var list = $('sql-history-list');
        if (list) {
          list.innerHTML = '';
          engine.history.all().forEach(function (q) {
            var item = document.createElement('div');
            item.className = 'sql-history-item';
            item.textContent = q;
            item.title = q;
            item.addEventListener('click', function () {
              var inp = $('sql-input');
              if (inp) { inp.value = q; inp.focus(); }
              sqlHistoryPanel.classList.add('hidden');
            });
            list.appendChild(item);
          });
          if (!engine.history.all().length) list.innerHTML = '<div style="font-size:12px;color:var(--text-faint);padding:8px">No queries yet.</div>';
        }
      }
    });
    if (sqlHistoryClose) sqlHistoryClose.addEventListener('click', function () { sqlHistoryPanel.classList.add('hidden'); });
  }

  // When SQL overlay opens, refresh schema + suggestions
  var origSqlOpen = $('sql-overlay');
  if (origSqlOpen) {
    var sqlOpenObserver = new MutationObserver(function () {
      if (!origSqlOpen.classList.contains('hidden')) {
        refreshSQLSchema();
        refreshSQLSuggestions();
        // Pre-register all current datasets
        getSQLEngine().then(function (engine) {
          state.datasets.forEach(function (ds) { engine.loadDataset(ds); });
        });
      }
    });
    sqlOpenObserver.observe(origSqlOpen, { attributes: true, attributeFilter: ['class'] });
  }


  /* showToast global shim for cross-module calls */
  if (!window.showToast) {
    window.showToast = function(msg, type) {
      var el = document.createElement('div');
      var colors = { success: '#16a34a', error: '#dc2626', warn: '#d97706', info: '#0891b2' };
      el.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:10px 18px;border-radius:8px;font-size:13px;color:#fff;background:' + (colors[type] || colors.info) + ';box-shadow:0 4px 16px rgba(0,0,0,.18);pointer-events:none;transition:opacity .3s;max-width:320px;';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(function(){ el.style.opacity='0'; setTimeout(function(){ el.remove(); }, 300); }, 3200);
    };
  }

  /* ============================================================
     BULK BUILD — #11, #13, #16, #21, #22, #23, #10
     SQL Autocomplete · Smart Scaffolding · Python Progress
     Excel Formula Suggestions · Tooltips · Errors · Vault Rename
     ============================================================ */

  /* ---- #11 SQL Column Autocomplete ---------------------------------- */
  (function () {
    'use strict';
    var SQL_KEYWORDS = [
      'SELECT','FROM','WHERE','GROUP BY','ORDER BY','HAVING','LIMIT','JOIN',
      'LEFT JOIN','INNER JOIN','ON','AS','DISTINCT','COUNT','SUM','AVG','MAX','MIN',
      'CASE','WHEN','THEN','ELSE','END','AND','OR','NOT','IN','IS NULL','IS NOT NULL',
      'BETWEEN','LIKE','UNION','WITH','OVER','PARTITION BY','ROW_NUMBER','RANK',
      'LAG','LEAD','NTILE','COALESCE','NULLIF','CAST','DATE_TRUNC','STRFTIME'
    ];

    function getDatasetTokens() {
      var tokens = [];
      if (window.state && window.state.datasets) {
        window.state.datasets.forEach(function (ds) {
          tokens.push({ name: ds.name || 'dataset', type: 'tbl' });
          (ds.columns || []).forEach(function (col) {
            tokens.push({ name: '"' + col.name + '"', type: 'col', raw: col.name });
          });
        });
      }
      SQL_KEYWORDS.forEach(function (kw) { tokens.push({ name: kw, type: 'kw' }); });
      return tokens;
    }

    function getWordBefore(ta) {
      var pos = ta.selectionStart;
      var text = ta.value.slice(0, pos);
      var m = /[\w"]+$/.exec(text);
      return m ? m[0] : '';
    }

    function shouldTrigger(ta) {
      var pos = ta.selectionStart;
      var text = ta.value.slice(0, pos);
      // Trigger after FROM  for table names
      if (/\bFROM\s+$/i.test(text)) return { filter: '', tableOnly: true };
      // Trigger on any word ≥1 char or after open-quote
      var m = /([\w"]+)$/.exec(text);
      if (m && m[0].length >= 1) return { filter: m[0].replace(/"/g, ''), tableOnly: false };
      return null;
    }

    var acEl = document.getElementById('sql-autocomplete');
    var sqlInp = document.getElementById('sql-input');
    if (!acEl || !sqlInp) return;

    var activeIdx = -1;
    var currentItems = [];

    function renderItems(items) {
      currentItems = items;
      activeIdx = -1;
      acEl.innerHTML = '';
      items.slice(0, 18).forEach(function (item, i) {
        var div = document.createElement('div');
        div.className = 'sql-ac-item';
        div.innerHTML =
          '<span class="sql-ac-badge ' + item.type + '">' + item.type + '</span>' +
          '<span class="sql-ac-name">' + item.name + '</span>';
        div.addEventListener('mousedown', function (e) {
          e.preventDefault();
          insertItem(item);
        });
        acEl.appendChild(div);
      });
      positionDropdown();
      acEl.style.display = items.length ? 'block' : 'none';
    }

    function positionDropdown() {
      var wrap = sqlInp.parentElement;
      var rect = sqlInp.getBoundingClientRect();
      var wrapRect = wrap.getBoundingClientRect();
      // Approximate caret position using lineHeight and value up to cursor
      var lines = sqlInp.value.slice(0, sqlInp.selectionStart).split('\n');
      var lineH = 20;
      var top = (lines.length * lineH) + 4;
      acEl.style.top = top + 'px';
      acEl.style.left = '8px';
    }

    function insertItem(item) {
      var pos = sqlInp.selectionStart;
      var text = sqlInp.value;
      var before = text.slice(0, pos);
      var after = text.slice(pos);
      // Remove partial word before cursor
      var wordMatch = /[\w"]*$/.exec(before);
      var wordStart = wordMatch ? pos - wordMatch[0].length : pos;
      // For keywords keep as-is, for cols insert quoted name
      var insert = item.name;
      sqlInp.value = text.slice(0, wordStart) + insert + after;
      var newPos = wordStart + insert.length;
      sqlInp.setSelectionRange(newPos, newPos);
      sqlInp.focus();
      hide();
    }

    function hide() {
      acEl.style.display = 'none';
      currentItems = [];
      activeIdx = -1;
    }

    sqlInp.addEventListener('input', function () {
      var trigger = shouldTrigger(sqlInp);
      if (!trigger) { hide(); return; }
      var tokens = getDatasetTokens();
      var fl = trigger.filter.toLowerCase();
      var matches = tokens.filter(function (t) {
        if (trigger.tableOnly) return t.type === 'tbl';
        if (!fl) return false;
        return t.name.toLowerCase().replace(/"/g,'').startsWith(fl) ||
               (t.raw && t.raw.toLowerCase().startsWith(fl));
      });
      // Deduplicate
      var seen = {};
      matches = matches.filter(function (t) {
        var k = t.name; if (seen[k]) return false; seen[k] = true; return true;
      });
      // Sort: cols first, then tables, then keywords
      matches.sort(function (a, b) {
        var order = { col: 0, tbl: 1, kw: 2 };
        return (order[a.type] || 9) - (order[b.type] || 9);
      });
      renderItems(matches);
    });

    sqlInp.addEventListener('keydown', function (e) {
      if (acEl.style.display === 'none') return;
      var items = acEl.querySelectorAll('.sql-ac-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, items.length - 1);
        items.forEach(function (el, i) { el.classList.toggle('active', i === activeIdx); });
        if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        items.forEach(function (el, i) { el.classList.toggle('active', i === activeIdx); });
        if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        if (activeIdx >= 0 && currentItems[activeIdx]) {
          e.preventDefault();
          insertItem(currentItems[activeIdx]);
        } else if (e.key === 'Tab' && currentItems.length === 1) {
          e.preventDefault();
          insertItem(currentItems[0]);
        } else {
          hide();
        }
      } else if (e.key === 'Escape') {
        hide();
      }
    });

    document.addEventListener('click', function (e) {
      if (!acEl.contains(e.target) && e.target !== sqlInp) hide();
    });
  })();

  /* ---- #13 Smart Query Scaffolding --------------------------------- */
  (function () {
    'use strict';

    var SEED_TEMPLATES = [
      { pattern: /total|sum|revenue|amount/i, label: 'Total by group',
        sql: function (ds, col) {
          var numCol = ds.columns.find(function(c){ return c.type==='FLOAT'||c.type==='INT'; });
          var grpCol = ds.columns.find(function(c){ return c.type==='STR'; });
          if (!numCol || !grpCol) return null;
          return 'SELECT "' + grpCol.name + '",\n       SUM("' + numCol.name + '") AS total\nFROM ' + ds.name + '\nGROUP BY 1\nORDER BY total DESC\nLIMIT 20';
        }},
      { pattern: /average|avg|mean/i, label: 'Average by group',
        sql: function (ds) {
          var numCol = ds.columns.find(function(c){ return c.type==='FLOAT'||c.type==='INT'; });
          var grpCol = ds.columns.find(function(c){ return c.type==='STR'; });
          if (!numCol || !grpCol) return null;
          return 'SELECT "' + grpCol.name + '",\n       ROUND(AVG("' + numCol.name + '"), 2) AS avg_value\nFROM ' + ds.name + '\nGROUP BY 1\nORDER BY avg_value DESC';
        }},
      { pattern: /count|how many|frequency/i, label: 'Count by group',
        sql: function (ds) {
          var grpCol = ds.columns.find(function(c){ return c.type==='STR'; });
          if (!grpCol) grpCol = ds.columns[0];
          return 'SELECT "' + grpCol.name + '",\n       COUNT(*) AS count\nFROM ' + ds.name + '\nGROUP BY 1\nORDER BY count DESC';
        }},
      { pattern: /top|rank|best|worst/i, label: 'Top N rows',
        sql: function (ds) {
          var numCol = ds.columns.find(function(c){ return c.type==='FLOAT'||c.type==='INT'; });
          if (!numCol) return 'SELECT * FROM ' + ds.name + ' LIMIT 10';
          return 'SELECT *\nFROM ' + ds.name + '\nORDER BY "' + numCol.name + '" DESC\nLIMIT 10';
        }},
      { pattern: /trend|over time|by month|by date/i, label: 'Trend over time',
        sql: function (ds) {
          var dateCol = ds.columns.find(function(c){ return c.type==='DATE'; });
          var numCol = ds.columns.find(function(c){ return c.type==='FLOAT'||c.type==='INT'; });
          if (!dateCol || !numCol) return null;
          return 'SELECT DATE_TRUNC(\'month\', "' + dateCol.name + '") AS month,\n       SUM("' + numCol.name + '") AS total\nFROM ' + ds.name + '\nGROUP BY 1\nORDER BY 1';
        }},
      { pattern: /duplicate|dupe|unique/i, label: 'Find duplicates',
        sql: function (ds) {
          var idCol = ds.columns[0];
          return 'SELECT "' + idCol.name + '", COUNT(*) AS occurrences\nFROM ' + ds.name + '\nGROUP BY 1\nHAVING COUNT(*) > 1\nORDER BY occurrences DESC';
        }},
      { pattern: /null|missing|blank/i, label: 'Missing values',
        sql: function (ds) {
          var checks = ds.columns.slice(0, 6).map(function(c) {
            return 'SUM(CASE WHEN "' + c.name + '" IS NULL THEN 1 ELSE 0 END) AS missing_' + c.name.replace(/\W/g,'_');
          });
          return 'SELECT ' + checks.join(',\n       ') + '\nFROM ' + ds.name;
        }},
      { pattern: /window|rank|row_number|running/i, label: 'Window function',
        sql: function (ds) {
          var numCol = ds.columns.find(function(c){ return c.type==='FLOAT'||c.type==='INT'; });
          var grpCol = ds.columns.find(function(c){ return c.type==='STR'; });
          if (!numCol) return null;
          var part = grpCol ? ('PARTITION BY "' + grpCol.name + '" ') : '';
          return 'SELECT *,\n       ROW_NUMBER() OVER (' + part + 'ORDER BY "' + numCol.name + '" DESC) AS rank\nFROM ' + ds.name + '\nORDER BY rank\nLIMIT 20';
        }}
    ];

    // Seed chips rendered in sql-suggestions-bar
    function refreshSeedChips() {
      var bar = document.getElementById('sql-suggestions-bar');
      if (!bar) return;
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds) { bar.innerHTML = ''; return; }

      bar.innerHTML = '';
      var label = document.createElement('span');
      label.style.cssText = 'font-size:11px;color:var(--text-faint);margin-right:6px;';
      label.textContent = 'Try:';
      bar.appendChild(label);

      SEED_TEMPLATES.forEach(function (tmpl) {
        var chip = document.createElement('button');
        chip.className = 'suggestion-chip';
        chip.textContent = tmpl.label;
        chip.addEventListener('click', function () {
          var inp = document.getElementById('sql-input');
          if (!inp) return;
          var generated = tmpl.sql(ds);
          if (!generated) {
            window.showToast && window.showToast('Not enough column variety to scaffold this query.', 'warn');
            return;
          }
          inp.value = generated;
          inp.focus();
          inp.dispatchEvent(new Event('input'));
        });
        bar.appendChild(chip);
      });
    }

    // Expose for SQL overlay open observer
    window._refreshSeedChips = refreshSeedChips;

    // Hook into dataset load events
    document.addEventListener('dataglow:dataset-loaded', refreshSeedChips);
    document.addEventListener('dataglow:dataset-switched', refreshSeedChips);

    // Also refresh when SQL overlay becomes visible
    var sqlOverlay = document.getElementById('sql-overlay');
    if (sqlOverlay) {
      var obs = new MutationObserver(function () {
        if (!sqlOverlay.classList.contains('hidden')) refreshSeedChips();
      });
      obs.observe(sqlOverlay, { attributes: true, attributeFilter: ['class'] });
    }
  })();

  /* ---- #16 Python Loading Progress --------------------------------- */
  (function () {
    'use strict';
    var STAGES = [
      { pct: 10, msg: 'Downloading Python runtime (~10 MB, one-time setup)...' },
      { pct: 35, msg: 'Initializing Pyodide engine...' },
      { pct: 60, msg: 'Loading pandas, numpy, standard library...' },
      { pct: 85, msg: 'Mounting your datasets as DataFrames...' },
      { pct: 100, msg: 'Python ready.' }
    ];

    var msgEl  = document.getElementById('py-progress-msg');
    var barWrap = document.getElementById('py-progress-bar-wrap');
    var barEl  = document.getElementById('py-progress-bar');
    var statEl = document.getElementById('py-view-load-status');

    function setStage(idx) {
      if (!msgEl || !barEl || !barWrap) return;
      var s = STAGES[Math.min(idx, STAGES.length - 1)];
      msgEl.style.display = 'block';
      msgEl.textContent = s.msg;
      barWrap.classList.remove('hidden');
      barEl.style.width = s.pct + '%';
      if (s.pct === 100) {
        setTimeout(function () {
          msgEl.style.display = 'none';
          barWrap.classList.add('hidden');
          if (statEl) statEl.textContent = 'Python ready';
        }, 1200);
      }
    }

    // Patch existing pyLoadStat assignments to drive progress bar
    var origRun = document.getElementById('py-view-run');
    if (origRun) {
      origRun.addEventListener('click', function () {
        // If Pyodide not yet loaded, drive stages
        if (!window._pyodide && !window._pyLoading) return;
        if (window._pyLoading) {
          var stage = 0;
          setStage(stage++);
          var timer = setInterval(function () {
            if (!window._pyLoading) {
              setStage(4);
              clearInterval(timer);
              return;
            }
            if (stage < 4) setStage(stage++);
          }, 1800);
        }
      });
    }

    // Expose for external trigger
    window._pyProgressStage = setStage;
  })();

  /* ---- #21-22-23 Excel Formula Suggestions + Tooltip + Errors ------- */
  (function () {
    'use strict';

    var FORMULA_CATALOG = [
      { name: 'SUM',     sig: 'SUM(B2:B100)',           desc: 'Adds all numbers in a range.' },
      { name: 'AVG',     sig: 'AVG(B2:B100)',           desc: 'Returns the arithmetic mean.' },
      { name: 'COUNT',   sig: 'COUNT(A2:A100)',         desc: 'Counts numeric cells.' },
      { name: 'COUNTA',  sig: 'COUNTA(A2:A100)',        desc: 'Counts non-empty cells.' },
      { name: 'MAX',     sig: 'MAX(B2:B100)',           desc: 'Returns the largest value.' },
      { name: 'MIN',     sig: 'MIN(B2:B100)',           desc: 'Returns the smallest value.' },
      { name: 'MEDIAN',  sig: 'MEDIAN(B2:B100)',        desc: 'Returns the middle value.' },
      { name: 'STDEV',   sig: 'STDEV(B2:B100)',         desc: 'Standard deviation of a range.' },
      { name: 'ROUND',   sig: 'ROUND(A1, 2)',           desc: 'Rounds to N decimal places.' },
      { name: 'COUNTIF', sig: 'COUNTIF(A2:A100, "x")', desc: 'Counts cells matching a value.' },
      { name: 'SUMIF',   sig: 'SUMIF(A2:A100, "x", B2:B100)', desc: 'Sums B where A matches value.' }
    ];

    var ERROR_MESSAGES = {
      '#ERROR:': 'Formula could not be evaluated  -  check your function name and range.',
      '#EXPR?':  'Expression syntax error  -  check parentheses and operators.',
      '#DIV/0':  'Division by zero  -  the denominator resolved to 0.',
      '#VALUE':  'Wrong value type  -  a text cell was used where a number is expected.',
      '#REF':    'Cell reference is out of range  -  check your row/column letters.'
    };

    function plainError(raw) {
      for (var key in ERROR_MESSAGES) {
        if (raw && raw.startsWith(key)) return ERROR_MESSAGES[key];
      }
      return null;
    }

    var formulaInput = document.getElementById('formula-input');
    var sugEl  = document.getElementById('formula-suggestions');
    var errBar = document.getElementById('formula-error-bar');
    var hintEl = document.getElementById('formula-fn-hint');
    if (!formulaInput || !sugEl) return;

    var acActiveIdx = -1;
    var acItems = [];

    function renderSuggestions(matches) {
      acItems = matches;
      acActiveIdx = -1;
      sugEl.innerHTML = '';
      matches.forEach(function (fn, i) {
        var div = document.createElement('div');
        div.className = 'formula-sug-item';
        div.innerHTML =
          '<div><span class="formula-sug-name">' + fn.name + '</span>' +
          ' <span class="formula-sug-sig">' + fn.sig + '</span></div>' +
          '<div class="formula-sug-desc">' + fn.desc + '</div>';
        div.addEventListener('mousedown', function (e) {
          e.preventDefault();
          insertFormula(fn);
        });
        sugEl.appendChild(div);
      });
      sugEl.style.display = matches.length ? 'block' : 'none';
    }

    function hideSuggestions() {
      sugEl.style.display = 'none';
      acItems = [];
      acActiveIdx = -1;
    }

    function insertFormula(fn) {
      formulaInput.value = '=' + fn.name + '()';
      // Position cursor inside parentheses
      var pos = formulaInput.value.length - 1;
      formulaInput.setSelectionRange(pos, pos);
      formulaInput.focus();
      hideSuggestions();
    }

    function showError(msg) {
      if (!errBar) return;
      errBar.textContent = msg;
      errBar.style.display = 'block';
    }

    function hideError() {
      if (!errBar) return;
      errBar.style.display = 'none';
    }

    formulaInput.addEventListener('input', function () {
      var val = formulaInput.value;
      hideError();

      // Trigger suggestions on "=" or "=F", "=SU" etc
      if (val === '=') {
        renderSuggestions(FORMULA_CATALOG);
        return;
      }
      if (val.startsWith('=')) {
        var typed = val.slice(1).toUpperCase();
        var matches = FORMULA_CATALOG.filter(function (fn) { return fn.name.startsWith(typed); });
        if (matches.length && !typed.includes('(')) {
          renderSuggestions(matches);
          return;
        }
      }
      hideSuggestions();

      // Live error detection
      if (val && val[0] === '=') {
        var ds = window.getActiveDataset && window.getActiveDataset();
        if (ds && window.FormulaEngine) {
          var result = window.FormulaEngine.evaluate(val, ds);
          if (result !== null) {
            var errMsg = plainError(String(result));
            if (errMsg) showError(errMsg);
          }
        }
      }
    });

    formulaInput.addEventListener('keydown', function (e) {
      if (sugEl.style.display === 'none') return;
      var rows = sugEl.querySelectorAll('.formula-sug-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        acActiveIdx = Math.min(acActiveIdx + 1, rows.length - 1);
        rows.forEach(function (r, i) { r.classList.toggle('active', i === acActiveIdx); });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        acActiveIdx = Math.max(acActiveIdx - 1, 0);
        rows.forEach(function (r, i) { r.classList.toggle('active', i === acActiveIdx); });
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        if (acActiveIdx >= 0 && acItems[acActiveIdx]) {
          e.preventDefault();
          insertFormula(acItems[acActiveIdx]);
        } else if (acItems.length === 1) {
          e.preventDefault();
          insertFormula(acItems[0]);
        }
      } else if (e.key === 'Escape') {
        hideSuggestions();
      }
    });

    document.addEventListener('click', function (e) {
      if (!sugEl.contains(e.target) && e.target !== formulaInput) hideSuggestions();
    });