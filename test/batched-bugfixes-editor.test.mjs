// ============================================================
// DATAGLOW — Batched bug-fix regression suite (engine buffer + SQL editor)
// ============================================================
// Two independent, previously-confirmed bugs. Each assertion was verified to
// FAIL against the pre-fix code and PASS after:
//
//   Bug 1 — Provenance can silently record nothing because DuckDB-WASM's
//           registerFileBuffer TRANSFERS (detaches) the ArrayBuffer it is given.
//           The file-load path hashes those same raw bytes for the chain of
//           custody; if the engine detaches the caller's buffer, the later hash
//           throws and the audit trail is silently empty. The fix (duckdbBytes)
//           hands the engine an INDEPENDENT copy, so the caller's bytes stay
//           valid for hashing no matter the call order. Pre-fix there was no
//           duckdbBytes and registerFileBuffer passed a view over the caller's
//           buffer, so this suite could not even import the guarantee.
//
//   Bug 4 — The SQL editor was a plain textarea with no syntax highlighting and
//           dumped raw DuckDB errors. The fix adds a dependency-free, Node-
//           testable tokenizer/highlighter and a structured error formatter.
//
// RUN WITH:  node test/batched-bugfixes-editor.test.mjs   (NO loader hook — this
// suite imports the REAL browser duckdb-engine.js module to test duckdbBytes;
// the loader hook would redirect it to the native node engine.)

import { duckdbBytes } from '../js/app-shell/duckdb-engine.js';
import { hashBytes } from '../js/provenance/provenance.js';
import { tokenizeSql, highlightSql, formatSqlError, renderSqlErrorHtml } from '../js/app-shell/sql-highlight.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function main() {
  // ============================================================
  // Bug 1 — duckdbBytes must decouple the engine's buffer from the caller's.
  // ============================================================
  const src = new TextEncoder().encode('patient_id,age\n1,50\n2,60\n').buffer;
  const forEngine = duckdbBytes(src);
  ok(forEngine instanceof Uint8Array, 'bug1: duckdbBytes returns a Uint8Array the engine can register');
  ok(forEngine.buffer !== src, 'bug1: the returned bytes are backed by an INDEPENDENT ArrayBuffer (not a view over the caller)');
  ok(forEngine.byteLength === src.byteLength, 'bug1: the copy has the same length as the source');

  // Simulate exactly what db.registerFileBuffer() does to the bytes it is
  // handed — a structured-clone transfer detaches the underlying buffer.
  structuredClone(forEngine.buffer, { transfer: [forEngine.buffer] });
  ok(forEngine.buffer.byteLength === 0, 'bug1: registering (transfer) detaches the ENGINE copy, reproducing the detach behaviour');
  ok(src.byteLength > 0, 'bug1: the CALLER buffer survives — it was never handed to the engine');
  const h = await hashBytes(src);
  ok(/^[0-9a-f]{64}$/.test(h), 'bug1: the caller bytes remain hashable AFTER the engine copy is detached (provenance can still be recorded)');

  // ============================================================
  // Bug 4 — SQL highlighter tokens + structured error formatting.
  // ============================================================
  const sql = "SELECT id, COUNT(*) FROM t -- a comment\nWHERE name = 'ann' AND n > 10 /* blk */";
  const html = highlightSql(sql);
  ok(/<span class="tok-keyword">SELECT<\/span>/.test(html), 'bug4: keywords are wrapped in .tok-keyword spans');
  ok(/tok-string/.test(html), 'bug4: string literals are wrapped in .tok-string spans');
  ok(/tok-comment/.test(html), 'bug4: comments (line and block) are wrapped in .tok-comment spans');
  ok(/tok-number/.test(html), 'bug4: numeric literals are wrapped in .tok-number spans');
  ok(/tok-function/.test(html), 'bug4: known functions (COUNT) are wrapped in .tok-function spans');

  // The concatenation of token values must reconstruct the input exactly, so the
  // overlay stays glyph-aligned with the textarea behind it.
  ok(tokenizeSql(sql).map(t => t.value).join('') === sql, 'bug4: tokens losslessly reconstruct the source (overlay alignment invariant)');

  // Highlighting must be XSS-safe — user SQL is HTML-escaped, never injected raw.
  const evil = "SELECT '<img src=x onerror=alert(1)>'";
  const evilHtml = highlightSql(evil);
  ok(!/<img/.test(evilHtml) && /&lt;img/.test(evilHtml), 'bug4: user text in the highlighted overlay is HTML-escaped (no injection)');

  // Structured error formatting: split "<Kind> Error:" prefix + surface a hint.
  const binder = formatSqlError(new Error('Binder Error: Referenced column "foo" not found\nLINE 1: SELECT foo FROM t'));
  ok(binder.kind === 'Binder Error', `bug4: the error "Kind" is parsed out of the raw DuckDB message (got '${binder.kind}')`);
  ok(binder.detail && !/^Binder Error:/.test(binder.detail), 'bug4: the detail no longer repeats the kind prefix');
  ok(!!binder.hint, 'bug4: a helpful hint is surfaced for a referenced-column error');

  const catalog = renderSqlErrorHtml(new Error('Catalog Error: Table with name t does not exist'));
  ok(/sql-error-kind/.test(catalog) && /sql-error-detail/.test(catalog),
    'bug4: the rendered error card uses the structured .sql-error-kind / .sql-error-detail classes (not a raw dump)');

  // A message with no "<Kind> Error:" prefix degrades gracefully.
  const plain = formatSqlError(new Error('something odd happened'));
  ok(plain.kind === 'Query Error' && /something odd/.test(plain.detail), 'bug4: a prefix-less error still renders with a sensible default kind + detail');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
