// ============================================================
// DATAGLOW — Golden Regression Suite (runner)
// ============================================================
// A golden-file / snapshot regression harness for DATAGLOW's core deterministic
// operations. For each case in cases.mjs it:
//   1. runs the operation and canonicalises the output (stable key order,
//      rounded floats, volatile fields like timestamps stripped),
//   2. compares it to the versioned fixture in ./fixtures/<name>.json,
//   3. on any difference, prints a readable line-diff and fails the run.
//
// WHY this exists: DATAGLOW gains features fast (often via AI coding agents).
// Per-feature unit tests prove a feature works the day it lands; a golden suite
// proves that adding feature N+1 did not silently move the output of features
// 1..N. It is a safety net, not a spec.
//
// RUN:                node --import ./test/duckdb-loader-hook.mjs test/golden/index.test.mjs
// UPDATE fixtures:    UPDATE_GOLDEN=1 node --import ./test/duckdb-loader-hook.mjs test/golden/index.test.mjs
//   (Only run the update mode when a behaviour change is INTENDED — review the
//    resulting fixture diff in the PR exactly as you would review code.)
//
// The DuckDB-backed cases run against the native node engine via the shared
// loader hook, identical to the existing SQL logic suite. No browser, no server.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCases } from './cases.mjs';
import { closeConnection } from '../node-duckdb-engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures');
const UPDATE = process.env.UPDATE_GOLDEN === '1' || process.env.UPDATE_GOLDEN === 'true';

// Fields that legitimately vary run-to-run and must never enter a fixture.
const VOLATILE_KEYS = new Set(['ts', 'elapsedMs', 'loadedAt']);
// Round floats to this many decimals so tiny FP jitter across platforms/engine
// versions doesn't cause false failures. Integers are left exact.
const FLOAT_DIGITS = 6;

// ------------------------------------------------------------
// Canonicalise a value into a stable, comparable form: sorted object keys,
// volatile keys dropped, non-integer numbers rounded, BigInt → Number.
// ------------------------------------------------------------
function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return Number.isInteger(value) ? value : Number(value.toFixed(FLOAT_DIGITS));
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return String(value);
}

const stable = (v) => JSON.stringify(canonicalize(v), null, 2);

// ------------------------------------------------------------
// A compact, readable line-diff between two pretty-printed JSON blobs. Shows up
// to `maxLines` differing lines with their line numbers so a reviewer can see
// exactly what moved without scrolling a full object dump.
// ------------------------------------------------------------
function lineDiff(expected, actual, maxLines = 40) {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const n = Math.max(e.length, a.length);
  const out = [];
  let shown = 0;
  for (let i = 0; i < n; i++) {
    if (e[i] !== a[i]) {
      if (shown < maxLines) {
        if (e[i] !== undefined) out.push(`  L${i + 1} - expected: ${e[i].trim()}`);
        if (a[i] !== undefined) out.push(`  L${i + 1} + actual:   ${a[i].trim()}`);
      }
      shown++;
    }
  }
  if (shown > maxLines) out.push(`  … and ${shown - maxLines} more differing line(s)`);
  return out.join('\n');
}

async function main() {
  if (UPDATE && !existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });

  const cases = buildCases();
  let passed = 0, failed = 0, wrote = 0;

  for (const c of cases) {
    const fixturePath = join(FIXTURE_DIR, `${c.name}.json`);
    let actual;
    try {
      actual = stable(await c.run());
    } catch (err) {
      failed++;
      console.log(`✗ FAILED: ${c.name} — case threw`);
      console.log(`    ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err}`);
      continue;
    }

    if (UPDATE) {
      writeFileSync(fixturePath, actual + '\n');
      wrote++;
      console.log(`✎ wrote fixture: ${c.name}.json`);
      continue;
    }

    if (!existsSync(fixturePath)) {
      failed++;
      console.log(`✗ FAILED: ${c.name} — no fixture at fixtures/${c.name}.json`);
      console.log('    Run once with UPDATE_GOLDEN=1 to capture it, then review the fixture before committing.');
      continue;
    }

    const expected = readFileSync(fixturePath, 'utf8').replace(/\n$/, '');
    if (expected === actual) {
      passed++;
      console.log(`✓ ${c.name}`);
    } else {
      failed++;
      console.log(`✗ FAILED: ${c.name} — output differs from golden fixture`);
      console.log(lineDiff(expected, actual));
      console.log('    If this change is INTENTIONAL, re-run with UPDATE_GOLDEN=1 and review the fixture diff in your PR.');
    }
  }

  await closeConnection().catch(() => {});

  if (UPDATE) {
    console.log(`\n${wrote} fixture(s) written. Review the diff before committing.`);
    process.exit(0);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — golden run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
