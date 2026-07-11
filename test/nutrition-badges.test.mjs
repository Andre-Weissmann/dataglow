// ============================================================
// DATAGLOW — Dataset Nutrition Label (badge catalog) test
// ============================================================
// Verifies the pure badge engine in js/provenance/nutrition-badges.js:
//   • the catalog is well-formed and every entry documents a REAL backing
//     signal and a text/unicode glyph (never an image asset);
//   • every catalog badge fires when its backing signal is present in the
//     context, and NOT when it is absent (no decorative / unearned badges);
//   • computeBadges returns exactly the earned badges for fixture contexts,
//     is order-stable (catalog order), and never mutates its input.
//
// RUN WITH:  node test/nutrition-badges.test.mjs
//
// Pure logic — no DuckDB engine, no browser, no network.

import {
  BADGE_CATALOG,
  BADGE_BY_ID,
  SMALL_SAMPLE_THRESHOLD,
  computeBadges,
} from '../js/provenance/nutrition-badges.js';

// ---------- tiny test harness (mirrors the other test files) ----------
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
const ids = badges => badges.map(b => b.id);

function main() {
  // ---------- 1. Catalog integrity ----------
  ok(Array.isArray(BADGE_CATALOG) && BADGE_CATALOG.length >= 6, 'catalog ships at least six badges');
  ok(Object.isFrozen(BADGE_CATALOG), 'catalog is frozen (fixed, not mutable at runtime)');
  const seen = new Set();
  let wellFormed = true, hasChecks = true, glyphsOk = true, signalsOk = true;
  for (const b of BADGE_CATALOG) {
    if (!b.id || seen.has(b.id)) wellFormed = false;
    seen.add(b.id);
    if (typeof b.label !== 'string' || typeof b.meaning !== 'string') wellFormed = false;
    if (typeof b.check !== 'function') hasChecks = false;
    // glyph is a short text/unicode string, never a path/URL/image reference.
    if (typeof b.glyph !== 'string' || b.glyph.length === 0 || b.glyph.length > 4) glyphsOk = false;
    if (/\.(png|svg|jpg|jpeg|gif|webp)|https?:|\/|<svg|url\(/i.test(b.glyph)) glyphsOk = false;
    // Every badge must document a real backing signal (the "never decorative" rule).
    if (typeof b.signal !== 'string' || b.signal.trim() === '') signalsOk = false;
  }
  ok(wellFormed, 'every catalog entry has a unique id, label, and meaning');
  ok(hasChecks, 'every catalog entry has a check() gating function');
  ok(glyphsOk, 'every glyph is a short text/unicode char — no image asset or icon URL');
  ok(signalsOk, 'every badge documents a real backing signal (never decorative)');
  ok(BADGE_BY_ID.validated === BADGE_CATALOG[0] || !!BADGE_BY_ID.validated, 'BADGE_BY_ID indexes the catalog by id');
  ok(SMALL_SAMPLE_THRESHOLD === 30, 'the small-sample threshold is the documented n<30');

  // ---------- 2. No signal → no badges ----------
  ok(computeBadges({}).length === 0, 'an empty context earns no badges');
  ok(computeBadges({ results: {} }).length === 0, 'an empty results object earns no badges');

  // ---------- 3. Each badge fires only on its real backing signal ----------
  // Validated ← a completed validation run with calibrated grades.
  const validated = computeBadges({ results: { calibratedGrades: { overall: { grade: 'B' } } } });
  ok(ids(validated).includes('validated'), 'Validated fires when calibrated grades exist');
  ok(validated.find(b => b.id === 'validated').detail.overallGrade === 'B', 'Validated carries the overall grade as detail');
  ok(!ids(computeBadges({ results: { calibratedGrades: { overall: {} } } })).includes('validated'),
    'Validated does NOT fire without a real overall grade');

  // High Missingness ← Missingness Detective findings.
  const miss = computeBadges({ results: { missingness_detective: { findings: [{ column: 'notes' }], analyzed: [] } } });
  ok(ids(miss).includes('high-missingness'), 'High Missingness fires on detective findings');
  ok(miss.find(b => b.id === 'high-missingness').detail.columns.includes('notes'), 'High Missingness names the affected column');
  ok(!ids(computeBadges({ results: { missingness_detective: { findings: [], analyzed: [] } } })).includes('high-missingness'),
    'High Missingness does NOT fire with no findings');

  // Small Sample ← row count below the documented threshold.
  ok(ids(computeBadges({ rowCount: 12 })).includes('small-sample'), 'Small Sample fires below the threshold');
  ok(!ids(computeBadges({ rowCount: SMALL_SAMPLE_THRESHOLD })).includes('small-sample'), 'Small Sample does NOT fire at the threshold');
  ok(!ids(computeBadges({ rowCount: 5000 })).includes('small-sample'), 'Small Sample does NOT fire on a large dataset');
  ok(!ids(computeBadges({})).includes('small-sample'), 'Small Sample does NOT fire when the row count is unknown');

  // Contains Outliers ← outlier layer warn/fail or findings.
  ok(ids(computeBadges({ results: { outlier_detection: { status: 'warn', findings: [{}] } } })).includes('contains-outliers'),
    'Contains Outliers fires on a warn status');
  ok(!ids(computeBadges({ results: { outlier_detection: { status: 'pass', findings: [] } } })).includes('contains-outliers'),
    'Contains Outliers does NOT fire on a clean pass');

  // Fingerprinted ← an analysis-fingerprint record.
  ok(ids(computeBadges({ fingerprint: { digest: { value: 'abc123'.padEnd(64, '0') } } })).includes('fingerprinted'),
    'Fingerprinted fires when a fingerprint record with a digest is present');
  ok(!ids(computeBadges({ fingerprint: { digest: {} } })).includes('fingerprinted'),
    'Fingerprinted does NOT fire without a digest value');
  ok(!ids(computeBadges({ fingerprint: null })).includes('fingerprinted'), 'Fingerprinted does NOT fire with no record');

  // Debate-Reviewed ← a Step-C debate resolution.
  ok(ids(computeBadges({ debateResolvedBy: 'C' })).includes('debate-reviewed'), 'Debate-Reviewed fires on resolvedBy "C"');
  ok(ids(computeBadges({ resolution: { resolvedBy: 'C' } })).includes('debate-reviewed'), 'Debate-Reviewed reads resolvedBy off a resolution object');
  ok(!ids(computeBadges({ debateResolvedBy: 'A' })).includes('debate-reviewed'), 'Debate-Reviewed does NOT fire for a Step-A resolution');

  // ---------- 4. Combined context + ordering + purity ----------
  const ctx = {
    results: {
      calibratedGrades: { overall: { grade: 'C' } },
      missingness_detective: { findings: [{ column: 'x' }] },
      outlier_detection: { status: 'warn', findings: [{}] },
    },
    rowCount: 8,
    fingerprint: { digest: { value: 'd'.repeat(64) } },
    debateResolvedBy: 'C',
  };
  const snapshot = JSON.stringify(ctx);
  const all = computeBadges(ctx);
  ok(all.length === 6, 'a fully-loaded context earns all six badges');
  // Order is catalog order, deterministic.
  const catalogOrder = BADGE_CATALOG.map(b => b.id).filter(id => ids(all).includes(id));
  ok(JSON.stringify(ids(all)) === JSON.stringify(catalogOrder), 'badges are returned in stable catalog order');
  ok(JSON.stringify(ctx) === snapshot, 'computeBadges does not mutate its input context');
  ok(all.every(b => b.signal && b.glyph && b.detail != null), 'each emitted badge carries its signal, glyph, and backing detail');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
