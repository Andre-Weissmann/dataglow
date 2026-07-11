// ============================================================
// DATAGLOW — Cross-origin isolation load-race regression test (real browser)
// ============================================================
// Reproduces the exact production scenario found via independent verification:
// on a host that does NOT send COOP/COEP headers, DATAGLOW establishes cross-
// origin isolation through the service-worker fallback + a one-time page reload.
// If the user clicked "Load Golden Test Dataset" during the brief pre-isolation
// window (before that reload), the reload tore the click handler's execution
// context down mid-flight and the load vanished silently — no data, no error,
// no toast (the very symptom of the original bug).
//
// The static server below deliberately sends NO COOP/COEP headers, so the page
// MUST go through the service-worker fallback path — the only path where the
// race exists. We then click Load as soon as the app shell is interactive AND
// still reports the pending (pre-isolation) state, and assert the dataset
// ultimately loads. The fix queues the click and replays it after the reload,
// so a fast click must never be silently dropped.
//
// This timing race is invisible to the static test/coi-headers.test.mjs suite;
// only a real browser exercising the SW install → controllerchange → reload
// lifecycle can catch a regression here.
//
// RUN WITH:  node test/coi-race.e2e.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const READY_TIMEOUT_MS = 90000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentType(path) {
  const dot = path.lastIndexOf('.');
  return MIME[path.slice(dot)] || 'application/octet-stream';
}

// Minimal static server that pointedly does NOT set Cross-Origin-Opener-Policy
// or Cross-Origin-Embedder-Policy — simulating a host (like the live pplx.app
// deployment) that ignores the repo's _headers file, forcing the SW fallback.
function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === '/') urlPath = '/index.html';
        const filePath = normalize(join(REPO_ROOT, urlPath));
        if (!filePath.startsWith(REPO_ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
        const body = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': contentType(filePath) });
        res.end(body);
      } catch (e) {
        res.writeHead(e.code === 'ENOENT' ? 404 : 500);
        res.end(String(e.message || e));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function main() {
  const { server, baseUrl } = await startServer();
  console.log(`▶ static server (NO COOP/COEP headers) up at ${baseUrl}`);

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-gl=swiftshader'],
  });
  // A fresh context guarantees no pre-existing service worker / sessionStorage,
  // so the very first visit starts in the un-isolated (pending) state.
  const context = await browser.newContext();
  const page = await context.newPage();

  // Deterministically widen the pre-isolation window. In the wild the race occurs
  // when the app shell has already attached its click handlers but the one-time
  // SW reload has not yet fired — a timing gap that depends on network/SW-install
  // latency (it reproduces on the live host but not on a zero-latency localhost,
  // where the reload can beat main.js). Delaying only the sw.js fetch defers SW
  // registration → controllerchange → reload, so main.js reliably runs (handlers
  // attached, page still pending) BEFORE the reload — recreating the exact race
  // without weakening what is under test: the real click handler, queueing, the
  // genuine SW-driven reload, and the post-reload replay all still run for real.
  const SW_DELAY_MS = 2500;
  await context.route('**/sw.js', async (route) => {
    await new Promise(r => setTimeout(r, SW_DELAY_MS));
    await route.continue();
  });

  const consoleLines = [];
  page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));

  let failed = false;
  try {
    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
    console.log('▶ page loaded; confirming we are on the pre-isolation (pending) path…');

    // Sanity: on this header-less server the first document must NOT be isolated.
    const firstIsolated = await page.evaluate(() => window.crossOriginIsolated === true);
    if (firstIsolated) {
      // If somehow isolated on first paint there is no race to test — that would
      // mean the environment injected headers. Treat as an inconclusive skip.
      console.log('⚠ first document was already cross-origin isolated — no race window to exercise; skipping.');
      await browser.close(); server.close();
      console.log('\nCOI RACE E2E: SKIPPED (already isolated)');
      process.exit(0);
    }

    // Wait until the app shell has wired its click handlers (__dataglowInit) while
    // the page is STILL in the pending pre-isolation window, then click Load as
    // fast as possible — the exact fast-click-before-reload timing that used to
    // silently drop the load.
    await page.waitForFunction(
      () => window.__dataglowInit === true && window.__dataglowIsolation === 'pending',
      { timeout: 30000, polling: 25 }
    );
    console.log('▶ app shell interactive AND still pending — clicking Load Golden now (racing the reload)…');
    await page.click('#btn-load-golden', { timeout: 5000 });
    console.log('✓ Load clicked during the pre-isolation window');

    // The click must have been captured (queued) rather than started-and-dropped:
    // the queued-load marker should be set and the non-error "starting" state
    // shown, all BEFORE the reload fires.
    const queued = await page.evaluate(() => {
      let key = null;
      try { key = sessionStorage.getItem('dataglow-pending-load'); } catch (e) {}
      const box = document.querySelector('#engine-error');
      const initing = !!(box && box.querySelector('[data-testid="engine-initializing"]'));
      return { key, initing };
    });
    if (queued.key === 'golden') {
      console.log('✓ click was queued (dataglow-pending-load=golden) instead of silently dropped');
    } else {
      failed = true;
      console.log('✗ FAILED: click during pending window was not queued: ' + JSON.stringify(queued));
    }
    if (queued.initing) {
      console.log('✓ non-error "starting the data engine" state shown to the user');
    } else {
      console.log('  (note) initializing state not observed at sample time (may have already reloaded)');
    }

    // The click either (a) was queued and replays after the one-time reload, or
    // (b) landed just as the reload fired and replays on the isolated page. Either
    // way the dataset MUST end up loaded — never silently dropped. Wait across the
    // reload for the dataset to register.
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      console.log(`  … waiting for dataset to load across the reload (${((Date.now() - startedAt) / 1000).toFixed(0)}s)`);
    }, 5000);
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('#dataset-list .dataset-item').length > 0,
        { timeout: READY_TIMEOUT_MS, polling: 500 }
      );
    } finally {
      clearInterval(ticker);
    }
    console.log(`✓ golden dataset loaded despite the fast click (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);

    // Prove the fallback path was actually exercised: after the SW takes control
    // and the one-time reload lands, the page must be genuinely cross-origin
    // isolated (otherwise the load could not have used SharedArrayBuffer).
    const nowIsolated = await page.evaluate(() => window.crossOriginIsolated === true);
    if (nowIsolated) {
      console.log('✓ page is cross-origin isolated after the SW fallback + reload');
    } else {
      failed = true;
      console.log('✗ FAILED: page never became cross-origin isolated via the SW fallback');
    }

    // And no stale queued-load marker should be left behind after replay.
    const leftover = await page.evaluate(() => {
      try { return sessionStorage.getItem('dataglow-pending-load'); } catch (e) { return null; }
    });
    if (leftover) {
      failed = true;
      console.log(`✗ FAILED: a queued-load marker was left behind ("${leftover}")`);
    } else {
      console.log('✓ queued-load marker cleared after replay');
    }
  } catch (err) {
    failed = true;
    console.log('\n✗ FAILED: ' + (err && err.message ? err.message : err));
    try {
      await page.screenshot({ path: join(REPO_ROOT, 'test', 'coi-race-failure.png'), fullPage: true });
      console.log('  saved screenshot → test/coi-race-failure.png');
    } catch { /* ignore */ }
    console.log('  --- browser console ---');
    for (const line of consoleLines.slice(-40)) console.log('  ' + line);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed ? '\nCOI RACE E2E: FAILED' : '\nCOI RACE E2E: PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — coi-race run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
