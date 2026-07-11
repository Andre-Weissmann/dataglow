// ============================================================
// DATAGLOW — Local Peer-Sourced Pack Index test suite (Gen 42, Part 3)
// ============================================================
// Proves the read-only, content-addressed peer index behaves as the spec fixes:
//   - normalisation collapses column-pattern variants to one lookup key,
//   - a malformed / bad-content-hash entry is rejected (never crashes the index),
//   - lookup/findOne are pure, synchronous, and return FROZEN entries,
//   - loadIndex uses an INJECTED fetcher (this module names no network primitive)
//     and degrades to an empty index on any fetch failure — never throws,
//   - the module source references zero network primitives (the js/packs/ scan).
//
// Pure JS — no DuckDB, DOM, or real network. RUN WITH:
//   node test/local-pack-index.test.mjs

import {
  normDomain, normColumnPattern, validateIndexEntry,
  LocalPackIndex, buildIndex, loadIndex,
} from '../js/packs/local-pack-index.js';
import { scanSourceForNetwork } from '../js/packs/pack-network-guard.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const HASH = 'sha256:' + 'a'.repeat(64);

function entry(over = {}) {
  return {
    domain: 'retail', column_pattern: 'discount_pct',
    suggested_rule: 'never above 100%', source_pack: 'retail-shared',
    content_hash: HASH, ...over,
  };
}

async function main() {
  // ---------- 1. Normalisation ----------
  ok(normDomain('  Retail ') === 'retail', 'norm: domain is trimmed + lower-cased');
  ok(normColumnPattern('Discount-PCT') === normColumnPattern('discount_pct')
    && normColumnPattern('discount pct') === normColumnPattern('discount_pct'),
    'norm: column-pattern variants collapse to one key');

  // ---------- 2. Entry validation ----------
  ok(validateIndexEntry(entry()).valid === true, 'validate: a well-formed entry passes');
  ok(validateIndexEntry(entry({ content_hash: 'sha256:xyz' })).valid === false,
    'validate: a malformed content hash is rejected');
  ok(validateIndexEntry(entry({ domain: '' })).valid === false, 'validate: an empty required field is rejected');
  ok(validateIndexEntry(null).valid === false, 'validate: a non-object is rejected');

  // ---------- 3. Index construction drops (never throws on) bad entries ----------
  const idx = new LocalPackIndex([entry(), entry({ content_hash: 'bad' }), entry({ column_pattern: 'unit_count', suggested_rule: 'never negative' })]);
  ok(idx.size === 2, 'index: valid entries indexed, malformed one dropped');
  ok(idx.rejected.length === 1, 'index: the rejected entry is recorded');

  // ---------- 4. Pure, frozen lookup ----------
  const hit = idx.findOne({ domain: 'RETAIL', columnPattern: 'Discount PCT' });
  ok(hit && hit.suggested_rule === 'never above 100%', 'lookup: findOne matches across normalised keys');
  ok(Object.isFrozen(hit), 'lookup: returned entries are frozen (the borrowed source is immutable)');
  ok(idx.findOne({ domain: 'finance', columnPattern: 'x' }) === null, 'lookup: a miss returns null');
  ok(idx.patternsForDomain('retail').length === 2, 'lookup: patternsForDomain lists distinct patterns');

  // ---------- 5. buildIndex accepts a bare array or an envelope ----------
  ok(buildIndex([entry()]).size === 1, 'build: a bare array payload');
  ok(buildIndex({ entries: [entry()] }).size === 1, 'build: an { entries } envelope payload');
  ok(buildIndex(null).size === 0, 'build: a null payload → empty index');

  // ---------- 6. loadIndex uses an INJECTED fetcher and degrades gracefully ----------
  const okFetcher = async () => ({ entries: [entry()] });
  const loaded = await loadIndex(okFetcher, 'https://example/index.json');
  ok(loaded.size === 1, 'load: an injected fetcher populates the index');

  const failFetcher = async () => { throw new Error('offline'); };
  const degraded = await loadIndex(failFetcher, 'https://example/index.json');
  ok(degraded.size === 0, 'load: a fetch failure degrades to an empty index (no throw)');
  const noFetcher = await loadIndex(null, '');
  ok(noFetcher.size === 0, 'load: a missing fetcher/url yields an empty index');

  // ---------- 7. The module names zero network primitives ----------
  const src = readFileSync(join(__dirname, '..', 'js', 'packs', 'local-pack-index.js'), 'utf8');
  ok(scanSourceForNetwork(src).length === 0,
    'network: local-pack-index names no network primitive (passes the js/packs/ scan)');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
