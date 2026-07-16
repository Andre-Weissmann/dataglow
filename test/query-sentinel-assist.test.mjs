// ============================================================
// DATAGLOW — Query Sentinel Assist test suite (Batch 2 of 3)
// ============================================================
// Covers: Tier 1 deterministic fix-sketch templates composed from a real
// Query Sentinel report, graceful Tier 2 fallback with no WebGPU, Tier 2
// with an injected (mocked) on-device model exercising every fallback edge
// case, and — the RED-TEAM part — a structural proof that this module has
// no write/apply/execute path of any kind. Mirrors the exact discipline of
// test/guarded-copilot.test.mjs (Batch 1's Tier 1/Tier 2 pattern) and
// test/query-sentinel.test.mjs (this feature's own Batch 1).
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/query-sentinel-assist.test.mjs

import {
  PUBLIC_API_SURFACE,
  buildFixSuggestion,
  assistDeterministic,
  assistWithOnDeviceModel,
} from '../js/validation/query-sentinel-assist.js';
import { runQuerySentinel } from '../js/validation/query-sentinel.js';
import fs from 'node:fs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- buildFixSuggestion (Tier 1 template lookup) ----------
ok(buildFixSuggestion({ kind: 'FANOUT' }).sketch.includes('subquery'), 'FANOUT gets a pre-aggregation subquery sketch');
ok(buildFixSuggestion({ kind: 'JOIN_KEY' }).sketch.includes('JOIN ON'), 'JOIN_KEY gets a join-condition sketch');
ok(buildFixSuggestion({ kind: 'ADDITIVITY' }).sketch.includes('grain'), 'ADDITIVITY gets a grain/pre-aggregate sketch');
ok(buildFixSuggestion({ kind: 'SENSITIVE_COLUMN' }).sketch.includes('sensitive'), 'SENSITIVE_COLUMN gets a bucketing/omission sketch');
ok(buildFixSuggestion({ kind: 'NOT_A_REAL_KIND' }) === null, 'returns null (never guesses) for an unrecognized kind');
ok(buildFixSuggestion(null) === null, 'returns null for null input, never throws');
ok(buildFixSuggestion({}) === null, 'returns null for a flag with no kind, never throws');

// ---------- assistDeterministic composed over a REAL Query Sentinel report ----------
{
  // A genuine FANOUT-triggering query/schema pair, same shape query-sentinel.test.mjs uses.
  const sql = 'SELECT p.name, SUM(c.amount_billed) FROM patients p JOIN claims c ON p.patient_id = c.patient_id GROUP BY p.name';
  const schema = {
    tables: {
      patients: { columns: { patient_id: 'INTEGER', name: 'VARCHAR' }, rowCount: 100, approxDistinct: { patient_id: 100 } },
      claims: { columns: { patient_id: 'INTEGER', amount_billed: 'DOUBLE' }, rowCount: 500, approxDistinct: { patient_id: 100 } },
    },
  };
  const report = runQuerySentinel(sql, schema);
  ok(report.flagCount > 0, 'sanity: the real Query Sentinel actually flags this fan-out-shaped query');
  const assist = assistDeterministic(report);
  ok(assist.answered === true, 'assistDeterministic answers for a flagged report');
  ok(assist.citedFrom.includes('js/validation/query-sentinel.js:runQuerySentinel'), 'cites the real Query Sentinel module, never a fabricated source');
  ok(assist.suggestions.length > 0, 'produces at least one fix suggestion for a flagged report');
  ok(assist.suggestions.every((s) => Object.prototype.hasOwnProperty.call(FIX_KINDS(report), s.kind)), 'every suggestion kind traces back to a kind Query Sentinel actually flagged — never invents a new finding');
}
function FIX_KINDS(report) {
  return report.flags.reduce((acc, f) => { acc[f.kind] = true; return acc; }, {});
}
{
  const cleanReport = { status: 'pass', flagCount: 0, flags: [] };
  const assist = assistDeterministic(cleanReport);
  ok(assist.answered === true && assist.suggestions.length === 0, 'a clean report (no flags) gets an honest "nothing to fix" answer with zero fabricated suggestions');
  ok(/nothing to fix/i.test(assist.text), 'clean-report text is honest, not a generic filler');
}
{
  // Duplicate flags of the same kind must collapse to ONE sketch, not one per instance.
  const dupReport = {
    status: 'warn',
    flagCount: 2,
    flags: [
      { kind: 'FANOUT', severity: 'warn', message: 'first' },
      { kind: 'FANOUT', severity: 'warn', message: 'second' },
    ],
  };
  const assist = assistDeterministic(dupReport);
  ok(assist.suggestions.length === 1, 'de-duplicates repeated flags of the same kind into exactly one fix sketch');
}
{
  const malformed = assistDeterministic(null);
  ok(malformed.answered === true, 'assistDeterministic never throws on null input');
  const malformed2 = assistDeterministic({ flags: 'not-an-array' });
  ok(malformed2.answered === true, 'assistDeterministic never throws on a malformed report shape');
}

// ---------- Tier 2 graceful fallback (no WebGPU in Node) ----------
{
  const report = { status: 'warn', flagCount: 1, flags: [{ kind: 'FANOUT', severity: 'warn', message: 'x' }] };
  const tier1 = assistDeterministic(report);
  const refined = await assistWithOnDeviceModel(report, tier1);
  ok(refined.usedOnDeviceModel === false, 'Tier 2 correctly reports no on-device model used in a non-WebGPU (Node) environment');
  ok(refined.text === tier1.text, 'Tier 2 falls back to the exact Tier 1 text unmodified — never a silent failure or blank answer');
}

// ---------- Tier 2 with an injected (mocked) on-device model ----------
function makeFakeEngine(chunks) {
  return {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            for (const c of chunks) yield { choices: [{ delta: { content: c } }] };
          },
        }),
      },
    },
  };
}
{
  const report = { status: 'fail', flagCount: 1, flags: [{ kind: 'ADDITIVITY', severity: 'fail', message: 'x' }] };
  const tier1 = assistDeterministic(report);
  const engine = makeFakeEngine(['This total ', 'won\u2019t add up ', 'across groups because of the join grain.']);
  const deps = {
    isWebGPUAvailable: () => true,
    isModelLoaded: () => true,
    loadModel: async () => engine,
  };
  const refined = await assistWithOnDeviceModel(report, tier1, deps);
  ok(refined.usedOnDeviceModel === true, 'Tier 2 uses the on-device model when WebGPU is available AND the model is loaded');
  ok(refined.text === 'This total won\u2019t add up across groups because of the join grain.', 'Tier 2 returns the streamed, rephrased text — not the Tier 1 text verbatim');
}
{
  // WebGPU present but model NOT loaded → must NOT trigger a load, must fall back.
  const report = { status: 'warn', flagCount: 1, flags: [{ kind: 'JOIN_KEY', severity: 'warn', message: 'x' }] };
  const tier1 = assistDeterministic(report);
  let loadCalled = false;
  const deps = {
    isWebGPUAvailable: () => true,
    isModelLoaded: () => false,
    loadModel: async () => { loadCalled = true; return makeFakeEngine(['x']); },
  };
  const refined = await assistWithOnDeviceModel(report, tier1, deps);
  ok(refined.usedOnDeviceModel === false && refined.text === tier1.text, 'Tier 2 falls back to Tier 1 text when the model is not yet loaded');
  ok(loadCalled === false, 'Tier 2 never triggers a model download on its own when the model is unloaded');
}
{
  // Model loaded but produces empty output → fall back rather than show blank.
  const report = { status: 'info', flagCount: 1, flags: [{ kind: 'SENSITIVE_COLUMN', severity: 'info', message: 'x' }] };
  const tier1 = assistDeterministic(report);
  const deps = {
    isWebGPUAvailable: () => true,
    isModelLoaded: () => true,
    loadModel: async () => makeFakeEngine(['', '  ', '']),
  };
  const refined = await assistWithOnDeviceModel(report, tier1, deps);
  ok(refined.usedOnDeviceModel === false && refined.text === tier1.text, 'Tier 2 falls back to Tier 1 text if the model yields empty output — never a blank answer');
}
{
  // A throwing engine must never propagate — always degrade to Tier 1 text.
  const report = { status: 'fail', flagCount: 1, flags: [{ kind: 'FANOUT', severity: 'fail', message: 'x' }] };
  const tier1 = assistDeterministic(report);
  const deps = {
    isWebGPUAvailable: () => true,
    isModelLoaded: () => true,
    loadModel: async () => { throw new Error('boom'); },
  };
  const refined = await assistWithOnDeviceModel(report, tier1, deps);
  ok(refined.usedOnDeviceModel === false && refined.text === tier1.text, 'Tier 2 swallows model errors and returns the exact Tier 1 text');
}

// ---------- RED-TEAM: structural proof of the read-only, suggestion-only guarantee ----------
{
  const src = fs.readFileSync(new URL('../js/validation/query-sentinel-assist.js', import.meta.url), 'utf8');
  // Strip comment lines before checking — the module's own comments EXPLAIN why
  // it never calls these paths (naming them for documentation), so a raw
  // string search over the whole file would false-positive on its own safety
  // commentary. The real guarantee is checked in the CODE, not prose.
  const codeOnly = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  ok(!/confirmAndApply\s*\(|import\s*\{[^}]*confirmAndApply/.test(codeOnly), 'query-sentinel-assist.js never calls or imports confirmAndApply — cannot invoke the firewall\u2019s apply path');
  ok(!/proposeAction\s*\(|import\s*\{[^}]*proposeAction/.test(codeOnly), 'query-sentinel-assist.js never calls or imports proposeAction — cannot even initiate a mutation proposal');
  ok(!/\.write\(|\.insert\(|\.delete\(|\.update\(|\.mutate\(|\.execute\(/.test(src), 'query-sentinel-assist.js contains no write/insert/delete/update/mutate/execute call of any kind');
  ok(!/createTableFromRows|duckdb-engine\.js/.test(src), 'query-sentinel-assist.js never imports the DuckDB engine — it cannot run SQL of its own');
  ok(
    JSON.stringify(PUBLIC_API_SURFACE) === JSON.stringify(['buildFixSuggestion', 'assistDeterministic', 'assistWithOnDeviceModel']),
    'the declared public API surface is exactly the three read-only/suggestion-only functions — any future addition must consciously update this list',
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
