// ============================================================
// DATAGLOW — Large CSV generator for the streaming-ingestion proof
// (Structural Readiness Phase item 2, first half)
// ============================================================
// Generates test/fixtures/large_streaming_test.csv: a deterministic,
// synthetic CSV comfortably larger than FSAA_THRESHOLD_BYTES (100MB, see
// js/app-shell/duckdb-config.js), used to prove loadFile()'s streaming path
// (engine.registerFileHandleStreaming, DuckDBDataProtocol.BROWSER_FILEREADER)
// against a real file too large to buffer comfortably in one arrayBuffer()
// read. NOT checked into git (121MB) -- generate it locally with:
//
//   node test/fixtures/generate_large_streaming_test_csv.mjs
//
// Deterministic: every run with the same TARGET_BYTES produces byte-identical
// output, so a proof run's exact row count / SUM(amount) / category count can
// be independently recomputed (see the formula below) without re-generating.
// LF-only line endings throughout (no CRLF), which matters for DuckDB's CSV
// dialect auto-sniffer -- a mixed-line-ending file (e.g. from some CSV
// writers that emit CRLF on the header row and LF thereafter) reliably fails
// DuckDB's sniffer with "It was not possible to automatically detect the CSV
// parsing dialect" (encountered and fixed during this proof run).

import { writeFileSync, openSync, writeSync, closeSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, 'large_streaming_test.csv');
const TARGET_BYTES = 120 * 1024 * 1024; // > 100MB FSAA_THRESHOLD_BYTES

const fd = openSync(outPath, 'w');
writeSync(fd, 'id,name,amount,category,flag\n');
let i = 0;
let written = statSync(outPath).size;
let buf = '';
while (written < TARGET_BYTES) {
  i += 1;
  const amt = Math.round((i % 997) * 1.37 * 100) / 100;
  const c = i % 7;
  const line = `${i},Widget-${i},${amt},cat${c},true\n`;
  buf += line;
  written += line.length;
  if (buf.length > 1024 * 1024) { // flush in 1MB chunks
    writeSync(fd, buf);
    buf = '';
  }
}
if (buf.length) writeSync(fd, buf);
closeSync(fd);

const finalSize = statSync(outPath).size;
console.log(`Wrote ${outPath}`);
console.log(`  rows: ${i}`);
console.log(`  size: ${(finalSize / 1024 / 1024).toFixed(2)} MB`);
console.log(`  expected COUNT(*): ${i}`);
console.log(`  expected COUNT(DISTINCT category): 7`);
// Independently recomputed expected SUM(amount), for cross-verifying DuckDB's
// own SQL result against this generator without trusting either one alone.
let total = 0;
for (let n = 1; n <= i; n++) {
  total += Math.round((n % 997) * 1.37 * 100) / 100;
}
console.log(`  expected SUM(amount): ${Math.round(total * 100) / 100}`);
