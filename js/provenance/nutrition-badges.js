// ============================================================
// DATAGLOW — Dataset Nutrition Label (scannable provenance/quality badges)
// ============================================================
// A modest, fixed catalog of standardized "nutrition label" badges that
// disclose a dataset/result's provenance and quality AT A GLANCE — the visual,
// human-scannable companion to the cryptographic Analysis Fingerprint
// (js/provenance/analysis-fingerprint.js) and the provenance/attestation modules
// alongside it.
//
// HARD RULE — no decorative badges. Every badge in the catalog is backed by a
// REAL computed signal produced elsewhere in DATAGLOW (a validation run, the
// missingness detective, the outlier layer, a fingerprint record, a debate
// resolution). Each catalog entry carries a `check(context)` that returns the
// backing detail when the signal is genuinely present and `null` otherwise, so a
// badge CANNOT be emitted without its evidence. A candidate badge that cannot be
// honestly computed from existing DATAGLOW data is NOT added here — it is
// recorded as future work in docs/tech-debt-tracker.md instead (see the
// "Truncated Axis" badge note there).
//
// PURE + DEPENDENCY-FREE: this module reads a plain `context` object and returns
// plain data. It runs no SQL, touches no network, imports no rendering code, and
// uses ONLY text/unicode glyphs (no image assets, no external icon library) so
// the same catalog renders identically in browser, desktop, and tests.

// Documented threshold for the "Small Sample" badge. n < 30 is the conventional
// rule-of-thumb boundary below which many summary statistics and the normal
// approximation become unreliable; we surface it as a plain caution, not a hard
// rule. Exported so callers and tests share the one definition.
export const SMALL_SAMPLE_THRESHOLD = 30;

// The fixed, documented badge catalog. Each entry:
//   id      stable identifier
//   label   short scannable text shown on the badge
//   meaning one-line plain-English description of what it asserts
//   glyph   a single text/unicode character (NO image asset / icon font)
//   signal  the DATAGLOW data source that backs it (documentation for auditors)
//   check   (context) => detail-object | null. Non-null ⇒ the badge fires, and
//           the returned object is merged into the emitted badge as `detail`.
export const BADGE_CATALOG = Object.freeze([
  {
    id: 'validated',
    label: 'Validated',
    meaning: 'Completed DATAGLOW’s validation layers.',
    glyph: '✓', // ✓
    signal: 'A completed validation run (js/validation/validation.js) with calibrated grades.',
    check(ctx) {
      const grades = ctx.grades || (ctx.results && ctx.results.calibratedGrades) || null;
      const overall = grades && grades.overall && grades.overall.grade;
      if (!overall) return null;
      return { overallGrade: overall };
    },
  },
  {
    id: 'high-missingness',
    label: 'High Missingness',
    meaning: 'One or more columns exceed the missing-data threshold.',
    glyph: '∅', // ∅
    signal: 'Missingness Detective findings (js/validation/missingness-detective.js).',
    check(ctx) {
      const md = ctx.results && ctx.results.missingness_detective;
      const findings = md && Array.isArray(md.findings) ? md.findings : [];
      const analyzed = md && Array.isArray(md.analyzed) ? md.analyzed : [];
      if (findings.length === 0 && analyzed.length === 0) return null;
      const columns = (findings.length ? findings : analyzed)
        .map(f => f && f.column).filter(Boolean);
      if (!columns.length) return null;
      return { columns };
    },
  },
  {
    id: 'small-sample',
    label: 'Small Sample',
    meaning: `Fewer than ${SMALL_SAMPLE_THRESHOLD} rows — summary statistics may be unreliable.`,
    glyph: '△', // △
    signal: 'The active dataset’s row count below SMALL_SAMPLE_THRESHOLD.',
    check(ctx) {
      const n = ctx.rowCount;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
      if (n >= SMALL_SAMPLE_THRESHOLD) return null;
      return { rowCount: n, threshold: SMALL_SAMPLE_THRESHOLD };
    },
  },
  {
    id: 'contains-outliers',
    label: 'Contains Outliers',
    meaning: 'The outlier layer flagged at least one anomalous value.',
    glyph: '⚠', // ⚠
    signal: 'Outlier-detection layer status/findings (js/validation/validation.js).',
    check(ctx) {
      const od = ctx.results && ctx.results.outlier_detection;
      if (!od) return null;
      const findings = Array.isArray(od.findings) ? od.findings : [];
      if (od.status !== 'warn' && od.status !== 'fail' && findings.length === 0) return null;
      return { status: od.status || null, findingCount: findings.length };
    },
  },
  {
    id: 'fingerprinted',
    label: 'Fingerprinted',
    meaning: 'A tamper-evident content fingerprint was recorded for this result.',
    glyph: '#',
    signal: 'An Analysis Fingerprint record (js/provenance/analysis-fingerprint.js).',
    check(ctx) {
      const fp = ctx.fingerprint;
      const value = fp && fp.digest && typeof fp.digest.value === 'string' ? fp.digest.value : null;
      if (!value) return null;
      return { digest: value.slice(0, 16) };
    },
  },
  {
    id: 'debate-reviewed',
    label: 'Debate-Reviewed',
    meaning: 'An uncertain answer was resolved by the on-device three-agent debate.',
    glyph: '⚖', // ⚖
    signal: 'A Step-C debate resolution (resolvedBy === "C"); see js/agents/debate-diagnostics.js.',
    check(ctx) {
      const resolvedBy = ctx.debateResolvedBy
        || (ctx.resolution && ctx.resolution.resolvedBy)
        || null;
      if (resolvedBy !== 'C') return null;
      return { resolvedBy };
    },
  },
]);

// Fast lookup by id (for renderers/tests that want a single catalog entry).
export const BADGE_BY_ID = Object.freeze(
  BADGE_CATALOG.reduce((acc, b) => { acc[b.id] = b; return acc; }, {})
);

/**
 * Compute the set of active badges for a result/dataset context. Pure: returns a
 * new array, never mutates the input. A badge appears ONLY when its catalog
 * `check` finds real backing evidence in the context, so the output can never
 * contain a badge that isn't earned.
 *
 * @param {object} context
 * @param {object} [context.results]          validation results (runAllLayers output)
 * @param {object} [context.grades]           calibrated grades (defaults to results.calibratedGrades)
 * @param {number} [context.rowCount]         active dataset row count
 * @param {object} [context.fingerprint]      an analysis-fingerprint record
 * @param {string} [context.debateResolvedBy] resolver step that answered (e.g. "C")
 * @param {object} [context.resolution]       a resolve() return value (alt. source of resolvedBy)
 * @returns {Array<{id,label,meaning,glyph,signal,detail}>}
 */
export function computeBadges(context = {}) {
  const badges = [];
  for (const entry of BADGE_CATALOG) {
    const detail = entry.check(context);
    if (detail == null) continue;
    badges.push({
      id: entry.id,
      label: entry.label,
      meaning: entry.meaning,
      glyph: entry.glyph,
      signal: entry.signal,
      detail,
    });
  }
  return badges;
}
