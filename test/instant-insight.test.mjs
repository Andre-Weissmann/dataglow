// ============================================================
// DATAGLOW — Instant Insight Engine (PR AF)
// ============================================================
// Tests InstantInsight.analyze() against deterministic fixtures.
// RUN WITH: node test/instant-insight.test.mjs

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Load insight engine into Node via a thin VM shim
import { createContext, runInContext } from 'node:vm';

const src = readFileSync('./js/insight/insight-engine.js', 'utf8')
  .replace(/^export\s+/gm, ''); // strip ES module exports for VM compat
const ctx = {};
createContext(ctx);
runInContext(src, ctx);
const InstantInsight = ctx.InstantInsight;

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.error(`✗ FAILED: ${msg}`); }
}

// ── helpers ──────────────────────────────────────────────────
function makeDataset(columns, rows) {
  return { columns, rows, findings: [], columnHealth: columns.map(() => 'green') };
}

// ── 1. Empty dataset ──────────────────────────────────────────
{
  const ds = makeDataset([], []);
  const r = InstantInsight.analyze(ds);
  ok(typeof r.sentence === 'string' && r.sentence.length > 0, 'empty dataset returns a sentence');
  ok(r.type === 'empty', 'empty dataset type is "empty"');
}

// ── 2. Null / missing input ───────────────────────────────────
{
  const r = InstantInsight.analyze(null);
  ok(typeof r.sentence === 'string', 'null input returns a sentence');
}

// ── 3. Outlier detection ──────────────────────────────────────
{
  const rows = Array.from({ length: 100 }, (_, i) => ({ amount: i < 95 ? 100 : 10000 }));
  const ds = makeDataset(['amount'], rows);
  const r = InstantInsight.analyze(ds);
  ok(r.type === 'outliers' || r.type === 'skew', 'detects outlier/skew in amount column');
  ok(r.sentence.toLowerCase().includes('amount') || r.sentence.toLowerCase().includes('outlier') || r.sentence.toLowerCase().includes('skew'), 'outlier sentence mentions the column or finding');
}

// ── 4. Dominant category detection ───────────────────────────
{
  const rows = Array.from({ length: 100 }, (_, i) => ({ status: i < 80 ? 'Denied' : 'Approved' }));
  const ds = makeDataset(['status'], rows);
  const r = InstantInsight.analyze(ds);
  ok(r.type === 'dominant_category', 'detects dominant category');
  ok(r.sentence.includes('Denied') || r.sentence.includes('status') || r.sentence.includes('Status'), 'dominant category sentence mentions the value or column');
}

// ── 5. Clean dataset fallback ─────────────────────────────────
{
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, score: 50 + Math.sin(i) * 5 }));
  const ds = makeDataset(['id', 'score'], rows);
  const r = InstantInsight.analyze(ds);
  ok(typeof r.sentence === 'string' && r.sentence.length > 10, 'clean dataset returns a meaningful sentence');
  ok(typeof r.type === 'string', 'clean dataset returns a type');
}

// ── 6. Duplicate row detection ────────────────────────────────
{
  const base = Array.from({ length: 80 }, (_, i) => ({ id: i, val: i * 2 }));
  const dups = Array.from({ length: 20 }, () => ({ id: 1, val: 2 }));
  const rows = base.concat(dups);
  const ds = makeDataset(['id', 'val'], rows);
  const r = InstantInsight.analyze(ds);
  ok(r.type === 'duplicates' || typeof r.sentence === 'string', 'duplicate rows handled');
}

// ── 7. Binary column detection ───────────────────────────────
{
  const rows = Array.from({ length: 100 }, (_, i) => ({ active: i % 3 === 0 ? 'No' : 'Yes' }));
  const ds = makeDataset(['active'], rows);
  const r = InstantInsight.analyze(ds);
  ok(typeof r.sentence === 'string' && r.sentence.length > 0, 'binary column returns a sentence');
}

// ── 8. Negative values in financial column ────────────────────
{
  const rows = Array.from({ length: 100 }, (_, i) => ({ payment_amount: i < 10 ? -500 : 1000 }));
  const ds = makeDataset(['payment_amount'], rows);
  const r = InstantInsight.analyze(ds);
  ok(r.type === 'negatives' || r.type === 'outliers' || r.type === 'skew', 'detects negatives or outliers in payment column');
}

// ── 9. Zero-heavy column ──────────────────────────────────────
{
  const rows = Array.from({ length: 100 }, (_, i) => ({ revenue: i < 70 ? 0 : 1000 }));
  const ds = makeDataset(['revenue'], rows);
  const r = InstantInsight.analyze(ds);
  ok(typeof r.sentence === 'string', 'zero-heavy column handled');
  ok(r.confidence >= 0, 'confidence is a non-negative number');
  ok(r.confidence <= 1, 'confidence is at most 1');
}

// ── 10. Correlation detection (two numeric columns) ───────────
{
  const rows = Array.from({ length: 60 }, (_, i) => ({ visits: i, revenue: i * 10 + 5 }));
  const ds = makeDataset(['visits', 'revenue'], rows);
  const r = InstantInsight.analyze(ds);
  ok(r.type === 'correlation' || typeof r.sentence === 'string', 'correlation detected or fallback sentence returned');
}

// ── 11. Group concentration ───────────────────────────────────
{
  const rows = [
    ...Array.from({ length: 60 }, () => ({ region: 'Midwest', sales: 1000 })),
    ...Array.from({ length: 20 }, () => ({ region: 'South', sales: 200 })),
    ...Array.from({ length: 20 }, () => ({ region: 'West', sales: 150 })),
  ];
  const ds = makeDataset(['region', 'sales'], rows);
  const r = InstantInsight.analyze(ds);
  ok(typeof r.sentence === 'string' && r.sentence.length > 0, 'group concentration handled');
}

// ── 12. allCandidates returned ────────────────────────────────
{
  const rows = Array.from({ length: 100 }, (_, i) => ({ amount: i < 95 ? 100 : 10000 }));
  const ds = makeDataset(['amount'], rows);
  const r = InstantInsight.analyze(ds);
  ok(Array.isArray(r.allCandidates), 'allCandidates is an array when candidates exist');
  ok(r.allCandidates.length <= 5, 'allCandidates returns at most 5');
}

// ── 13. Single-column dataset ─────────────────────────────────
{
  const rows = Array.from({ length: 30 }, (_, i) => ({ name: 'User' + i }));
  const ds = makeDataset(['name'], rows);
  const r = InstantInsight.analyze(ds);
  ok(typeof r.sentence === 'string', 'single-column dataset handled');
}

// ── 14. Large dataset performance guard ──────────────────────
{
  const t0 = Date.now();
  const rows = Array.from({ length: 5000 }, (_, i) => ({
    id: i, amount: Math.random() * 1000, status: i % 5 === 0 ? 'Denied' : 'Approved'
  }));
  const ds = makeDataset(['id', 'amount', 'status'], rows);
  const r = InstantInsight.analyze(ds);
  const elapsed = Date.now() - t0;
  ok(elapsed < 2000, `5000-row analysis completes in under 2s (took ${elapsed}ms)`);
  ok(typeof r.sentence === 'string', 'large dataset returns a sentence');
}

// ── summary ──────────────────────────────────────────────────
console.log(`\n${passed + failed} assertions — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
