// ============================================================
// DATAGLOW — cross-origin isolation (COOP + COEP) runtime tests
// ============================================================
// DuckDB-WASM's worker uses SharedArrayBuffer, which the browser only permits
// when the page is cross-origin isolated — i.e. the top-level document carries
// BOTH `Cross-Origin-Opener-Policy: same-origin` and
// `Cross-Origin-Embedder-Policy: require-corp`. The static host sets COOP but
// NOT COEP, so `sw.js` stamps both onto every navigation response. This suite
// actually EXECUTES the service worker's fetch handler (in a mocked SW global
// scope) and asserts:
//   1. navigation responses gain both isolation headers (online path),
//   2. the offline fallback response gains them too,
//   3. cross-origin requests are still left to the network (not intercepted),
//   4. same-origin subresources are not needlessly rewritten.
//
// RUN WITH:  node test/coop-coep-isolation.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}

const ORIGIN = 'https://dataglow.pplx.app';

// Load sw.js into a sandbox that mocks the ServiceWorkerGlobalScope, capturing
// the event listeners it registers. `fetch`/`caches` are injected per-scenario.
function loadServiceWorker({ fetchImpl, cachesImpl }) {
  const handlers = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  const context = {
    self,
    caches: cachesImpl,
    fetch: fetchImpl,
    Response, Headers, Request, URL, Blob,
    console: { log() {}, warn() {}, error() {} },
  };
  const code = readFileSync(join(root, 'sw.js'), 'utf8');
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'sw.js' });
  return { handlers };
}

// Drive a single fetch event through the captured handler and return whatever
// the worker passed to respondWith (or undefined if it declined to handle it).
async function dispatchFetch(handler, request) {
  let responded; let handled = false;
  const event = { request, respondWith(p) { handled = true; responded = p; } };
  handler(event);
  const value = handled ? await responded : undefined;
  return { handled, value };
}

// ============================================================
console.log('\nNavigation — online (network succeeds)');
{
  const netRes = new Response('<!doctype html><title>DATAGLOW</title>', {
    status: 200,
    headers: { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin' },
  });
  const put = [];
  const { handlers } = loadServiceWorker({
    fetchImpl: async () => netRes,
    cachesImpl: { open: async () => ({ put: async (req, res) => put.push({ req, res }), match: async () => undefined }) },
  });
  const { handled, value } = await dispatchFetch(handlers.fetch, {
    method: 'GET', mode: 'navigate', url: `${ORIGIN}/`,
  });
  ok('navigation is handled by the SW', handled);
  ok('navigation response sets COOP: same-origin',
    value && value.headers.get('cross-origin-opener-policy') === 'same-origin',
    value && value.headers.get('cross-origin-opener-policy'));
  ok('navigation response sets COEP: require-corp',
    value && value.headers.get('cross-origin-embedder-policy') === 'require-corp',
    value && value.headers.get('cross-origin-embedder-policy'));
  ok('original body is preserved (status 200)', value && value.status === 200);
  ok('a copy is written to the cache', put.length === 1);
  ok('the CACHED copy also carries COEP',
    put[0] && put[0].res.headers.get('cross-origin-embedder-policy') === 'require-corp');
}

// ============================================================
console.log('\nNavigation — offline (network fails, cache fallback)');
{
  const cached = new Response('<!doctype html><title>offline shell</title>', {
    status: 200, headers: { 'content-type': 'text/html' },
  });
  const { handlers } = loadServiceWorker({
    fetchImpl: async () => { throw new Error('offline'); },
    cachesImpl: { open: async () => ({ put: async () => {}, match: async () => undefined }), match: async () => cached },
  });
  const { handled, value } = await dispatchFetch(handlers.fetch, {
    method: 'GET', mode: 'navigate', url: `${ORIGIN}/`,
  });
  ok('offline navigation is still handled', handled);
  ok('offline fallback sets COEP: require-corp',
    value && value.headers.get('cross-origin-embedder-policy') === 'require-corp',
    value && value.headers.get('cross-origin-embedder-policy'));
  ok('offline fallback sets COOP: same-origin',
    value && value.headers.get('cross-origin-opener-policy') === 'same-origin');
}

// ============================================================
console.log('\nCross-origin request — left to the network');
{
  let fetchCalled = false;
  const { handlers } = loadServiceWorker({
    fetchImpl: async () => { fetchCalled = true; return new Response('x'); },
    cachesImpl: { open: async () => ({ put: async () => {}, match: async () => undefined }) },
  });
  const { handled } = await dispatchFetch(handlers.fetch, {
    method: 'GET', mode: 'no-cors', url: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js',
  });
  ok('cross-origin request is NOT intercepted (falls through to network)', handled === false);
  ok('SW did not proactively fetch the cross-origin resource', fetchCalled === false);
}

// ============================================================
console.log('\nSame-origin subresource — cached, not header-rewritten');
{
  const netRes = new Response('export const x = 1;', {
    status: 200, headers: { 'content-type': 'text/javascript' },
  });
  Object.defineProperty(netRes, 'type', { value: 'basic' });
  const { handlers } = loadServiceWorker({
    fetchImpl: async () => netRes,
    cachesImpl: { open: async () => ({ put: async () => {}, match: async () => undefined }) },
  });
  const { handled, value } = await dispatchFetch(handlers.fetch, {
    method: 'GET', mode: 'cors', url: `${ORIGIN}/js/app-shell/main.js`,
  });
  ok('same-origin subresource is handled (stale-while-revalidate)', handled);
  // Same-origin subresources are allowed under require-corp without CORP, so the
  // SW must not waste work stamping isolation headers on them.
  ok('same-origin subresource is NOT given COEP (unnecessary)',
    value && value.headers.get('cross-origin-embedder-policy') === null);
}

// ============================================================
console.log(`\n${failed === 0 ? '✓ ALL PASSED' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
