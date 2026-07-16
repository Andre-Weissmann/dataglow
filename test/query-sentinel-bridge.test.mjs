// ============================================================
// DATAGLOW — Query Sentinel Bridge test suite (Batch 3 of 3)
// ============================================================
// Covers: reference extraction, exact-match-only resolution against a live
// Object Space list, honest unresolved reporting (never a fuzzy fallback),
// summary text, and — the RED-TEAM part — a structural proof that this module
// has no DuckDB import and no write/execute path of any kind. Mirrors the
// exact discipline of test/query-sentinel.test.mjs and
// test/query-sentinel-assist.test.mjs (this feature's own Batches 1 and 2).
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/query-sentinel-bridge.test.mjs

import {
  PUBLIC_API_SURFACE,
  BRIDGE_PREFIXES,
  extractBridgeReferences,
  resolveBridgeReferences,
  summarizeBridgeResolution,
} from '../js/validation/query-sentinel-bridge.js';
import fs from 'node:fs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- BRIDGE_PREFIXES ----------
ok(JSON.stringify(BRIDGE_PREFIXES) === JSON.stringify(['py', 'r']), 'BRIDGE_PREFIXES is exactly the two resolvable cross-runtime prefixes');

// ---------- extractBridgeReferences ----------
{
  const refs = extractBridgeReferences('SELECT * FROM py.claims_clean');
  ok(refs.length === 1 && refs[0].prefix === 'py' && refs[0].name === 'claims_clean', 'extracts a single FROM py.<name> reference');
}
{
  const refs = extractBridgeReferences('SELECT * FROM patients p JOIN r.risk_scores s ON p.id = s.id');
  ok(refs.length === 1 && refs[0].prefix === 'r' && refs[0].name === 'risk_scores', 'extracts a JOIN r.<name> reference, ignores the unrelated bare SQL table');
}
{
  const refs = extractBridgeReferences('SELECT * FROM py.a JOIN r.b ON py.a.id = r.b.id');
  ok(refs.length === 2, 'extracts multiple distinct FROM/JOIN references in one query');
}
ok(extractBridgeReferences('SELECT * FROM claims').length === 0, 'a query with no cross-runtime reference extracts nothing');
ok(extractBridgeReferences('').length === 0, 'empty string extracts nothing, never throws');
ok(extractBridgeReferences(null).length === 0, 'null input extracts nothing, never throws');
ok(extractBridgeReferences(undefined).length === 0, 'undefined input extracts nothing, never throws');

// ---------- resolveBridgeReferences: exact-match resolution ----------
{
  const objectSpace = [
    { name: 'py:claims_clean', originLanguage: 'python', provenance: 'claims_2026_07' },
    { name: 'sql:claims_2026_07', originLanguage: 'sql', provenance: 'claims_2026_07' },
  ];
  const result = resolveBridgeReferences('SELECT COUNT(*) FROM py.claims_clean', objectSpace);
  ok(result.sql === 'SELECT COUNT(*) FROM claims_2026_07', 'rewrites FROM py.<name> to the real underlying registered table');
  ok(result.resolved.length === 1 && result.resolved[0].resolvedTable === 'claims_2026_07', 'reports the resolution with the real table name');
  ok(result.unresolved.length === 0, 'no unresolved entries when the reference is registered');
}
{
  const objectSpace = [{ name: 'r:risk_scores', originLanguage: 'r', provenance: 'risk_scores_table' }];
  const result = resolveBridgeReferences('SELECT * FROM patients p JOIN r.risk_scores s ON p.id = s.id', objectSpace);
  ok(result.sql === 'SELECT * FROM patients p JOIN risk_scores_table s ON p.id = s.id', 'rewrites a JOIN r.<name> reference, leaves the rest of the query byte-for-byte unchanged');
}

// ---------- resolveBridgeReferences: honest unresolved reporting (never a fuzzy fallback) ----------
{
  const objectSpace = [{ name: 'py:claims_clean', originLanguage: 'python', provenance: 'claims_2026_07' }];
  const result = resolveBridgeReferences('SELECT * FROM py.claims_cleaned', objectSpace); // note: typo'd name, close but not exact
  ok(result.sql === 'SELECT * FROM py.claims_cleaned', 'a near-miss/typo\u2019d name is left COMPLETELY UNTOUCHED — never a fuzzy/partial-match substitution');
  ok(result.unresolved.length === 1 && result.unresolved[0].name === 'claims_cleaned', 'the near-miss is reported as unresolved, not silently dropped');
  ok(result.resolved.length === 0, 'no resolution is claimed for a name that is not an exact match');
}
{
  const result = resolveBridgeReferences('SELECT * FROM py.never_loaded', []);
  ok(result.unresolved.length === 1, 'a reference with an empty Object Space list is reported unresolved, never throws');
  ok(result.sql === 'SELECT * FROM py.never_loaded', 'SQL is left untouched when the Object Space list is empty');
}
{
  // Mixed: one resolves, one does not, in the same query.
  const objectSpace = [{ name: 'py:a', originLanguage: 'python', provenance: 'table_a' }];
  const result = resolveBridgeReferences('SELECT * FROM py.a JOIN r.b ON py.a.id = r.b.id', objectSpace);
  ok(result.resolved.length === 1 && result.resolved[0].name === 'a', 'resolves the one reference that IS registered');
  ok(result.unresolved.length === 1 && result.unresolved[0].name === 'b', 'reports the other, unregistered reference as unresolved in the same pass');
  ok(result.sql.includes('table_a') && result.sql.includes('r.b'), 'rewrites only the resolved reference, leaves the unresolved one exactly as typed');
}

// ---------- resolveBridgeReferences: malformed input never throws ----------
{
  const r1 = resolveBridgeReferences(null, []);
  ok(r1.sql === '' && r1.resolved.length === 0 && r1.unresolved.length === 0, 'null SQL input returns a safe empty result, never throws');
  const r2 = resolveBridgeReferences('SELECT * FROM py.x', null);
  ok(r2.unresolved.length === 1, 'null objectSpaceEntries is treated as an empty registry, never throws');
  const r3 = resolveBridgeReferences('SELECT * FROM py.x', 'not-an-array');
  ok(r3.unresolved.length === 1, 'a non-array objectSpaceEntries is treated as an empty registry, never throws');
}

// ---------- summarizeBridgeResolution ----------
{
  ok(summarizeBridgeResolution({ resolved: [], unresolved: [] }) === null, 'returns null when there is nothing to report (no bridge references at all)');
  ok(summarizeBridgeResolution(null) === null, 'returns null for null input, never throws');
}
{
  const result = { resolved: [{ prefix: 'py', name: 'a', resolvedTable: 'table_a' }], unresolved: [] };
  const summary = summarizeBridgeResolution(result);
  ok(/resolved py\.a → table_a/.test(summary), 'summarizes a fully-resolved reference by name and real table');
}
{
  const result = { resolved: [], unresolved: [{ prefix: 'r', name: 'missing_thing' }] };
  const summary = summarizeBridgeResolution(result);
  ok(/could not find r\.missing_thing/.test(summary) && /run that tab first/.test(summary), 'summarizes an unresolved reference with an honest, actionable message — never claims success');
}

// ---------- RED-TEAM: structural proof of the read-only, exact-match-only guarantee ----------
{
  const src = fs.readFileSync(new URL('../js/validation/query-sentinel-bridge.js', import.meta.url), 'utf8');
  const codeOnly = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  ok(!/duckdb-engine\.js|createTableFromRows|runQuery\s*\(/.test(codeOnly), 'query-sentinel-bridge.js never imports the DuckDB engine and never runs a query itself — the caller always owns execution');
  ok(!/\.write\(|\.insert\(|\.delete\(|\.update\(|\.mutate\(|\.execute\(/.test(src), 'query-sentinel-bridge.js contains no write/insert/delete/update/mutate/execute call of any kind');
  ok(!/confirmAndApply\s*\(|import\s*\{[^}]*confirmAndApply/.test(codeOnly), 'query-sentinel-bridge.js never calls or imports confirmAndApply');
  ok(
    JSON.stringify(PUBLIC_API_SURFACE) === JSON.stringify(['extractBridgeReferences', 'resolveBridgeReferences', 'summarizeBridgeResolution']),
    'the declared public API surface is exactly the three read-only/text-transform functions — any future addition must consciously update this list',
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
