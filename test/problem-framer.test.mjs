// ============================================================
// DATAGLOW — Problem Framer test suite
// ============================================================
// Covers the pure, offline logic behind the Problem Framer wizard:
//   - the fixed reframing question set (shape + count)
//   - normalizeAnswers (whitespace trim, unknown-key drop, always-4-keys)
//   - buildAnalyticalQuestion (deterministic template, graceful blanks)
//   - suggestColumns (keyword/substring matching, snake/camel/space splitting,
//     stopword filtering, empty-dataset short-circuit)
//   - buildExportMarkdown (one-page recap contents + no-dataset phrasing)
//
// RUN WITH:  node test/problem-framer.test.mjs
//
// Engine-free (no DuckDB, no browser): every unit under test is pure JS,
// mirroring the self-learning-rules / signal-store suites.

import {
  REFRAMING_QUESTIONS,
  normalizeAnswers,
  buildAnalyticalQuestion,
  suggestColumns,
  buildExportMarkdown,
  orderLayersByContext,
} from '../js/problem-framing/problem-framer.js';

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const SAMPLE_ANSWERS = {
  decision: 'whether to shift ad budget away from the checkout funnel',
  timeWindow: 'this quarter vs. the same quarter last year',
  audience: 'the VP of Sales',
  done: 'a signed-off revenue change % by region',
};

function main() {
  // ============================================================
  // 1) Fixed question set
  // ============================================================
  ok(Array.isArray(REFRAMING_QUESTIONS) && REFRAMING_QUESTIONS.length === 4,
    'question set: exactly four fixed reframing questions');
  ok(REFRAMING_QUESTIONS.every(q => q.id && q.label && q.hint && q.placeholder),
    'question set: every question has id/label/hint/placeholder');
  const ids = REFRAMING_QUESTIONS.map(q => q.id);
  ok(['decision', 'timeWindow', 'audience', 'done'].every(id => ids.includes(id)),
    'question set: covers decision, time window, audience, and definition of done');

  // ============================================================
  // 2) normalizeAnswers
  // ============================================================
  const norm = normalizeAnswers({ decision: '  a  b  ', bogus: 'x' });
  ok(Object.keys(norm).length === 4, 'normalizeAnswers: always returns exactly the four keys');
  ok(norm.decision === 'a b', 'normalizeAnswers: collapses/trims whitespace');
  ok(!('bogus' in norm), 'normalizeAnswers: drops unknown keys');
  ok(norm.done === '', 'normalizeAnswers: missing answers become empty strings');
  ok(normalizeAnswers().decision === '', 'normalizeAnswers: no-arg call does not throw');

  // ============================================================
  // 3) buildAnalyticalQuestion
  // ============================================================
  const q = buildAnalyticalQuestion('sales feel off this quarter', SAMPLE_ANSWERS);
  ok(q.includes('sales feel off this quarter'), 'buildAnalyticalQuestion: echoes the original intake');
  ok(q.includes('the VP of Sales'), 'buildAnalyticalQuestion: incorporates the audience');
  ok(q.includes('this quarter vs. the same quarter last year'), 'buildAnalyticalQuestion: incorporates the time window');
  ok(q.includes('shift ad budget'), 'buildAnalyticalQuestion: incorporates the decision');
  ok(buildAnalyticalQuestion('x', SAMPLE_ANSWERS) === buildAnalyticalQuestion('x', SAMPLE_ANSWERS),
    'buildAnalyticalQuestion: deterministic (same inputs → same output)');
  const blank = buildAnalyticalQuestion('', {});
  ok(blank.includes('the situation described') && blank.includes('the intended audience'),
    'buildAnalyticalQuestion: degrades gracefully with sensible placeholders when blank');

  // ============================================================
  // 4) suggestColumns
  // ============================================================
  const cols = ['order_id', 'checkout_step', 'CheckoutTotal', 'region', 'revenue', 'signup_date'];
  const answers = {
    decision: 'improve the checkout funnel',
    timeWindow: 'this quarter',
    audience: 'sales team',
    done: 'revenue by region',
  };
  const sugg = suggestColumns('checkout conversion', answers, cols);
  const flat = Object.fromEntries(sugg.map(s => [s.term, s.columns]));
  ok(flat.checkout && flat.checkout.includes('checkout_step') && flat.checkout.includes('CheckoutTotal'),
    'suggestColumns: matches "checkout" across snake_case and camelCase columns');
  ok(flat.revenue && flat.revenue.includes('revenue'), 'suggestColumns: exact keyword matches its column');
  ok(flat.region && flat.region.includes('region'), 'suggestColumns: matches a keyword from an answer field');
  ok(!sugg.some(s => s.term === 'this' || s.term === 'the'), 'suggestColumns: stopwords are filtered out');
  ok(suggestColumns('anything', answers, []).length === 0, 'suggestColumns: empty column list returns no suggestions');
  ok(suggestColumns('zzz nomatch', { decision: 'qqq' }, cols).length === 0,
    'suggestColumns: no matching keywords returns empty array');
  // accepts objects with a .name property (mirrors ds.cols)
  const objCols = suggestColumns('revenue', {}, [{ name: 'revenue' }, { name: 'x' }]);
  ok(objCols.length === 1 && objCols[0].columns.includes('revenue'),
    'suggestColumns: accepts {name} column objects, not just strings');

  // ============================================================
  // 5) buildExportMarkdown
  // ============================================================
  const md = buildExportMarkdown({
    intake: 'sales feel off this quarter',
    answers: SAMPLE_ANSWERS,
    columns: cols,
    generatedAt: '2026-07-08T00:00:00.000Z',
  });
  ok(md.startsWith('# DATAGLOW — Problem Framer Recap'), 'export: has the recap title');
  ok(md.includes('_Generated 2026-07-08T00:00:00.000Z_'), 'export: honors a caller-supplied timestamp');
  ok(md.includes('## Original question') && md.includes('> sales feel off this quarter'),
    'export: quotes the original question');
  ok(md.includes('## Reframing') && md.includes('the VP of Sales'), 'export: lists the reframing answers');
  ok(md.includes('## Restated analytical question'), 'export: includes the restated question section');
  ok(md.includes('## Suggested columns') && md.includes('You mentioned **checkout**'),
    'export: includes suggested-column lines when a dataset is present');

  const mdNoData = buildExportMarkdown({ intake: 'x', answers: {}, columns: [] });
  ok(mdNoData.includes('_No dataset loaded, or no column names matched the answers._'),
    'export: graceful no-dataset phrasing when no columns');

  // ============================================================
  // 6) orderLayersByContext — Context Card re-weighting
  // ============================================================
  const LAYERS = [
    { id: 'schema_fingerprint', name: 'Schema Fingerprint', desc: 'Hash of the schema.' },
    { id: 'categorical_consistency', name: 'Categorical Consistency Engine', desc: 'Clusters near-identical spellings and whitespace.' },
    { id: 'outlier_detection', name: 'Outlier Detection', desc: 'Flags high and low numeric outliers.' },
    { id: 'benford', name: "Benford's Law Check", desc: 'Leading-digit distribution for numeric amounts.' },
    { id: 'unit_tests', name: 'Unit Test Layer', desc: 'Negatives, future dates, blank keys, duplicates.' },
  ];
  const layerIds = (defs) => defs.map(d => d.id);

  // No context → order and identity are unchanged.
  const unchanged = orderLayersByContext('', LAYERS);
  ok(JSON.stringify(layerIds(unchanged)) === JSON.stringify(layerIds(LAYERS)),
    'orderLayers: empty context leaves order unchanged');
  ok(orderLayersByContext('   ', LAYERS).length === LAYERS.length,
    'orderLayers: whitespace-only context is treated as no context');
  ok(orderLayersByContext('billing', LAYERS) !== LAYERS,
    'orderLayers: returns a new array, never mutating the input');
  ok(JSON.stringify(layerIds(LAYERS)) === JSON.stringify(['schema_fingerprint', 'categorical_consistency', 'outlier_detection', 'benford', 'unit_tests']),
    'orderLayers: the caller\'s input array is left untouched');

  // "for billing accuracy" → numeric/financial layers surface before formatting ones.
  const billing = layerIds(orderLayersByContext('for billing accuracy', LAYERS));
  const idxBenford = billing.indexOf('benford');
  const idxOutlier = billing.indexOf('outlier_detection');
  const idxCat = billing.indexOf('categorical_consistency');
  const idxSchema = billing.indexOf('schema_fingerprint');
  ok(idxBenford < idxCat && idxBenford < idxSchema,
    'orderLayers: a billing/financial context surfaces Benford ahead of formatting layers');
  ok(idxOutlier < idxCat && idxOutlier < idxSchema,
    'orderLayers: a billing/financial context surfaces outlier detection ahead of formatting layers');

  // An unmatched context falls back to the original order (never all-zero shuffled).
  ok(JSON.stringify(layerIds(orderLayersByContext('zzz qqq nomatch', LAYERS))) === JSON.stringify(layerIds(LAYERS)),
    'orderLayers: a context matching nothing leaves order unchanged');

  // Degenerate inputs never throw.
  ok(orderLayersByContext('anything', []).length === 0, 'orderLayers: empty layer list returns empty');
  ok(Array.isArray(orderLayersByContext(null, LAYERS)), 'orderLayers: null context does not throw');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
