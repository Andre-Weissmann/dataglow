// ============================================================
// DATAGLOW — Playwright end-to-end smoke test
// ============================================================
// Boots the real app in a real (headless) Chromium, waits for the DuckDB-WASM
// engine to come alive, loads the built-in golden dataset, runs the 15-layer
// validation suite, and asserts the Validate tab actually populates with
// result cards. This is the closest thing to "a human opened the page and it
// worked" that can run unattended.
//
// WHY a real browser (not jsdom / happy-dom): DATAGLOW's core is DuckDB-WASM,
// which needs a genuine Web Worker + WebAssembly + Blob URL pipeline. Only a
// real browser engine exercises that path.
//
// HEADLESS CAVEAT: some sandboxed/headless environments block the WASM+Worker
// bootstrap and the engine never signals ready — so a local timeout here is
// EXPECTED and not necessarily a product bug. GitHub Actions (real Chrome,
// see .github/workflows/test.yml) is the authoritative source of truth.
//
// RUN WITH:  node test/e2e-smoke.test.mjs

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

// Minimal, dependency-free static file server rooted at the repo. Path
// traversal is blocked by resolving against REPO_ROOT and rejecting escapes.
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
  console.log(`▶ static server up at ${baseUrl}`);

  // In CI we point Playwright at the system-installed real Chrome (see the
  // workflow). Locally, fall back to Playwright's bundled Chromium.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();

  const consoleLines = [];
  page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));

  let failed = false;
  try {
    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
    console.log('▶ page loaded, waiting for DuckDB-WASM engine to signal ready…');

    // Poll for the engine-ready flag, printing elapsed time so a slow (but not
    // hung) WASM boot is visible in CI logs rather than looking frozen.
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      console.log(`  … still waiting (${((Date.now() - startedAt) / 1000).toFixed(0)}s elapsed)`);
    }, 5000);
    try {
      await page.waitForFunction(
        () => window.__dataglowReady === true || typeof window.__dataglowInitError === 'string',
        { timeout: READY_TIMEOUT_MS, polling: 1000 }
      );
    } finally {
      clearInterval(ticker);
    }

    const initError = await page.evaluate(() => window.__dataglowInitError || null);
    if (initError) throw new Error('DuckDB-WASM engine failed to initialize: ' + initError);
    console.log(`✓ engine ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

    // Load the built-in golden dataset through the real UI path. The click
    // handler is async, so wait for the dataset to actually register in the
    // sidebar before proceeding (otherwise validation runs with no dataset).
    await page.click('#btn-load-golden');
    console.log('▶ golden dataset load triggered, waiting for it to register…');
    await page.waitForFunction(
      () => document.querySelectorAll('#dataset-list .dataset-item').length > 0,
      { timeout: 30000, polling: 500 }
    );
    console.log('✓ golden dataset loaded');

    // Move to the Validate tab and run the 15-layer suite.
    await page.click('[data-testid="tab-validate"]');
    await page.click('#btn-validate-run');
    console.log('▶ validation run triggered, waiting for result cards…');

    await page.waitForFunction(
      () => document.querySelectorAll('#validation-grid [data-testid^="card-validation-"]').length > 0,
      { timeout: 30000, polling: 500 }
    );

    const cardCount = await page.evaluate(
      () => document.querySelectorAll('#validation-grid [data-testid^="card-validation-"]').length
    );
    if (cardCount > 0) {
      console.log(`✓ Validate tab populated with ${cardCount} layer card(s)`);
    } else {
      failed = true;
      console.log('✗ FAILED: Validate tab produced no result cards');
    }
  } catch (err) {
    failed = true;
    console.log('\n✗ FAILED: ' + (err && err.message ? err.message : err));
    try {
      await page.screenshot({ path: join(REPO_ROOT, 'test', 'e2e-failure.png'), fullPage: true });
      console.log('  saved screenshot → test/e2e-failure.png');
    } catch { /* ignore screenshot errors */ }
    console.log('  --- browser console ---');
    for (const line of consoleLines.slice(-40)) console.log('  ' + line);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed ? '\nE2E SMOKE: FAILED' : '\nE2E SMOKE: PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — e2e run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
