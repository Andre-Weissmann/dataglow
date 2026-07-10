// ============================================================
// DATAGLOW — Cross-origin isolation headers sanity tests
// ============================================================
// DuckDB-WASM's threaded/eh build wants SharedArrayBuffer, which the browser
// only exposes to a cross-origin-isolated page. Isolation needs BOTH a
// Cross-Origin-Opener-Policy and a Cross-Origin-Embedder-Policy header on the
// top-level document, sent as REAL HTTP headers (meta tags don't work).
//
// The live app is a pure static site, so isolation is delivered two ways and
// this suite keeps both honest without a browser:
//   1. _headers  — host-level config (Netlify/Cloudflare Pages format).
//   2. sw.js     — a service-worker fallback that injects the same headers for
//                  hosts that ignore _headers, plus a one-time reload in
//                  index.html so a first visit picks isolation up.
//
// It also guards against a silent-failure regression: main.js must surface a
// visible, retryable engine-failure banner rather than reverting quietly.
//
// RUN WITH:  node test/coi-headers.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}

// ============================================================
console.log('\n_headers (host-level config)');
let headers = '';
try { headers = read('_headers'); ok('_headers file exists', true); }
catch (e) { ok('_headers file exists', false, e.message); }

// A catch-all "/*" section must carry both isolation headers.
ok('_headers has a catch-all /* section', /^\/\*\s*$/m.test(headers));
ok('_headers sets Cross-Origin-Opener-Policy: same-origin',
  /Cross-Origin-Opener-Policy:\s*same-origin/i.test(headers));
ok('_headers sets a Cross-Origin-Embedder-Policy (require-corp or credentialless)',
  /Cross-Origin-Embedder-Policy:\s*(require-corp|credentialless)/i.test(headers));
ok('_headers serves .wasm as application/wasm',
  /\/assets\/duckdb\/\*\.wasm[\s\S]*Content-Type:\s*application\/wasm/i.test(headers));

// ============================================================
console.log('\nsw.js (service-worker fallback)');
const sw = read('sw.js');

let parses = true, parseErr = '';
try { new vm.Script(sw, { filename: 'sw.js' }); } catch (e) { parses = false; parseErr = e.message; }
ok('sw.js parses without syntax error', parses, parseErr);
ok('sw.js defines COOP = same-origin', /COOP\s*=\s*['"]same-origin['"]/.test(sw));
ok('sw.js defines COEP (require-corp or credentialless)',
  /COEP\s*=\s*['"](require-corp|credentialless)['"]/.test(sw));
ok('sw.js sets Cross-Origin-Opener-Policy on responses',
  /headers\.set\(\s*['"]Cross-Origin-Opener-Policy['"]/.test(sw));
ok('sw.js sets Cross-Origin-Embedder-Policy on responses',
  /headers\.set\(\s*['"]Cross-Origin-Embedder-Policy['"]/.test(sw));
ok('sw.js applies isolation to the navigation (document) response',
  /withCrossOriginIsolation/.test(sw));
// The header injector must skip opaque/error responses (can't reconstruct them).
ok('sw.js skips opaque/status-0 responses when injecting headers',
  /status\s*===\s*0/.test(sw) && /opaque/.test(sw));

// ============================================================
console.log('\nindex.html (first-visit isolation reload)');
const html = read('index.html');
ok('index.html reloads to pick up isolation on controllerchange',
  /controllerchange/.test(html) && /location\.reload\(\)/.test(html));
ok('index.html guards the reload against a loop (one-shot sentinel)',
  /dataglow-coi-reloaded/.test(html) && /crossOriginIsolated/.test(html));

// ============================================================
console.log('\nmain.js (silent-failure UX fix)');
const mainJs = read('js/app-shell/main.js');
ok('main.js has a showEngineError helper', /function showEngineError\(/.test(mainJs));
ok('main.js renders a Retry button on engine failure',
  /data-testid':\s*'button-engine-retry'/.test(mainJs));
ok('main.js routes dataset loads through a failure-surfacing wrapper',
  /function runDatasetLoad\(/.test(mainJs) && /runDatasetLoad\(async/.test(mainJs));
ok('main.js surfaces a background pre-warm failure (no silent revert)',
  /__dataglowInitError[\s\S]{0,400}showEngineError/.test(mainJs));

// ============================================================
console.log(`\n${failed === 0 ? '✓ ALL PASSED' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
