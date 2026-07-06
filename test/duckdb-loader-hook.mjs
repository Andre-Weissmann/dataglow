// ============================================================
// DATAGLOW — Test-only module loader hook
// ============================================================
// The production feature modules (js/imputation.js, js/format-fingerprint.js,
// js/validation.js) import '../js/duckdb-engine.js' by relative path — that
// file is browser-only (creates a Worker, fetches a WASM binary from a CDN)
// and cannot run under plain Node.
//
// Rather than fork or edit those production files for testing, this hook
// intercepts ONLY the resolution of 'duckdb-engine.js' during `node --import`
// and transparently redirects it to node-duckdb-engine.mjs (backed by the
// real, native DuckDB engine). Every other import resolves normally.
// This means the exact production code under test is byte-for-byte what
// ships to users — only its DB backend is swapped for the test run.
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';

// Self-register so `node --import ./test/duckdb-loader-hook.mjs …` actually
// activates the resolve hook below. Under `--import`, merely exporting
// `resolve` does nothing — Node only invokes module-customization hooks that
// have been handed to register(). We register this very file (import.meta.url)
// as the hooks module. A guard env var prevents the loader thread (which
// re-executes this module's top level to read its `resolve` export) from
// recursively registering itself.
if (!process.env.__DUCKDB_LOADER_HOOK_ACTIVE) {
  process.env.__DUCKDB_LOADER_HOOK_ACTIVE = '1';
  register(import.meta.url);
}

const REDIRECT_TARGET = pathToFileURL(
  new URL('./node-duckdb-engine.mjs', import.meta.url).pathname
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('duckdb-engine.js')) {
    return { url: REDIRECT_TARGET, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
