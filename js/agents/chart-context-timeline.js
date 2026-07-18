// ============================================================
// DATAGLOW — Chart Context Timeline (Live Rooms Batch 3)
// ============================================================
// WHAT THIS IS: a tiny, pure, in-memory recorder of which chart/query the
// analyst was viewing at each moment during a meeting. The Meeting Scribe feeds
// the recorded timeline to tagSegmentsWithContext (js/agents/meeting-scribe-agent.js)
// so each spoken line gets a REAL context tag (the chart/query active when it was
// said) instead of today's null.
//
// WHY IT EXISTS: tagSegmentsWithContext already accepts a contextTimeline array
// of { ts, chart, queryLabel } entries and honestly tags a segment with null
// when no context event preceded it. Until now main.js passed it an empty array,
// so every tag was null. This module is the missing producer: every time a SQL
// query result is rendered, main.js calls recordChartView(); when the meeting
// note is assembled, main.js passes getTimeline() instead of [].
//
// SCOPE (Batch 3): pure, Node-testable DATA-LAYER module. No DOM, no DuckDB,
// no imports. Never throws on bad input — a bad recordChartView() call is a
// silent no-op, never an exception that could interrupt the SQL run path.
// ============================================================

/**
 * Build one chart-context timeline entry.
 * Pure function, no side effects. Never throws.
 *
 * @param {object} opts
 * @param {string} opts.chart  the chart/query label active at this moment (required, non-empty)
 * @param {string|null} [opts.queryLabel]  a human-readable query label (defaults to null)
 * @param {number} [opts.ts]  timestamp in ms (defaults to Date.now())
 * @returns {{ chart: string, queryLabel: string|null, ts: number }|null}
 *   Returns null when chart is not a non-empty string (nothing to record).
 */
export function buildChartContextEntry({ chart, queryLabel, ts } = {}) {
  if (typeof chart !== 'string' || chart === '') return null;
  return {
    chart: chart,
    queryLabel: (typeof queryLabel === 'string' && queryLabel !== '') ? queryLabel : null,
    ts: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
  };
}

/**
 * Create a chart-context timeline recorder.
 *
 * @returns {{
 *   recordChartView: (opts: {chart: string, queryLabel?: string, ts?: number}) => boolean,
 *   getTimeline: () => ReadonlyArray<{chart: string, queryLabel: string|null, ts: number}>,
 *   clear: () => void
 * }}
 */
export function createChartContextTimeline() {
  var entries = [];

  return {
    /**
     * Record that a chart/query was being viewed. A bad call (missing/empty
     * chart) is a silent no-op — this runs inside the SQL result render path
     * and must never throw. Returns true when an entry was recorded.
     *
     * @param {{chart: string, queryLabel?: string, ts?: number}} opts
     * @returns {boolean}
     */
    recordChartView: function(opts) {
      var entry = buildChartContextEntry(opts || {});
      if (!entry) return false;
      entries.push(entry);
      return true;
    },

    /**
     * Return a frozen, safe copy of the recorded entries — safe to pass
     * directly to tagSegmentsWithContext. Mutating the returned array (or its
     * entry objects) does not change the internal state.
     *
     * @returns {ReadonlyArray<{chart: string, queryLabel: string|null, ts: number}>}
     */
    getTimeline: function() {
      var copy = entries.map(function(e) {
        return Object.freeze({ chart: e.chart, queryLabel: e.queryLabel, ts: e.ts });
      });
      return Object.freeze(copy);
    },

    /**
     * Reset the timeline (e.g. when a new meeting starts).
     */
    clear: function() {
      entries = [];
    },
  };
}
