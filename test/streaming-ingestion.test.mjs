// ============================================================
// DATAGLOW — Streaming ingestion decision logic (Structural Readiness
// Phase item 2, first half: ingestion streaming)
// ============================================================
// Unit-tests the PURE decision function shouldStreamIngest() exported from
// js/app-shell/loaders.js. This is deliberately scoped to logic only: the
// real DuckDB-WASM registerFileHandle(..., BROWSER_FILEREADER, true) read
// path (js/app-shell/duckdb-engine.js registerFileHandleStreaming) needs a
// real browser Worker + WASM binary and cannot run under plain Node — that
// half is proven separately by a Playwright-driven browser test against a
// live-served build (see dev-log/journal.md / NORTH_STAR.md for the run that
// covers it). This file's job is narrower and unconditionally runnable in CI:
// prove the flag-off default, the size threshold, and the per-format branch
// are each correct in isolation, with no DuckDB/browser dependency at all.
//
// RUN WITH:  node test/streaming-ingestion.test.mjs

import assert from 'node:assert/strict';
import { shouldStreamIngest } from '../js/app-shell/loaders.js';
import { FSAA_THRESHOLD_BYTES } from '../js/app-shell/duckdb-config.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}${extra ? `\n      ${extra}` : ''}`); }
}

const BIG = FSAA_THRESHOLD_BYTES + 1024;
const SMALL = 1024;

// --- Flag-off default: byte-for-byte the old behavior regardless of size/format ---
ok('flag OFF + big csv -> no streaming (default-off safety)',
  shouldStreamIngest('csv', BIG, false) === false);
ok('flag OFF + big parquet -> no streaming',
  shouldStreamIngest('parquet', BIG, false) === false);
ok('flag undefined (falsy, e.g. isEnabled() before init) -> no streaming',
  shouldStreamIngest('csv', BIG, undefined) === false);

// --- Flag on, but file under threshold -> still no streaming ---
ok('flag ON + small csv -> no streaming (under FSAA threshold)',
  shouldStreamIngest('csv', SMALL, true) === false);
ok('flag ON + file exactly at threshold -> no streaming (shouldUseFSAA is strictly-greater)',
  shouldStreamIngest('csv', FSAA_THRESHOLD_BYTES, true) === false);

// --- Flag on + big file + streamable format -> streaming engages ---
for (const ext of ['csv', 'tsv', 'json', 'ndjson', 'parquet', 'arrow', 'feather']) {
  ok(`flag ON + big .${ext} -> streaming engages`,
    shouldStreamIngest(ext, BIG, true) === true);
}

// --- xlsx/xls always excluded, even flag on + big file: needs a full buffer
//     for SheetJS / DuckDB's read_xlsx no matter what. ---
ok('flag ON + big xlsx -> NOT streamed (SheetJS needs the full buffer)',
  shouldStreamIngest('xlsx', BIG, true) === false);
ok('flag ON + big xls -> NOT streamed',
  shouldStreamIngest('xls', BIG, true) === false);

// --- Unknown/unsupported extension -> never streamed, regardless of flag/size ---
ok('flag ON + big unknown extension -> not streamed',
  shouldStreamIngest('sqlite', BIG, true) === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
