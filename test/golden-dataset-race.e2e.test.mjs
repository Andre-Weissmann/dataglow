// ============================================================
// DATAGLOW — Golden dataset double-click race regression test (real browser)
// ============================================================
// Reproduces a real, self-reported bug: clicking "Load Golden Test Dataset"
// a second time before the first click's async load resolves (e.g. while
// DuckDB-WASM is still finishing initialization) could fire two overlapping
// createTableFromRows('golden_test_dataset', ...) calls. That function used
// to run a separate DROP TABLE IF EXISTS followed by a separate CREATE TABLE
// — two non-atomic statements a second overlapping call could interleave
// with, throwing a DuckDB "table already exists" (or "table does not exist"
// mid-drop) catalog error instead of loading cleanly.
//
// The fix has two independent layers, both exercised here:
//   1. js/app-shell/duckdb-engine.js's createTableFromRows now issues one
//      atomic `CREATE OR REPLACE TABLE` instead of DROP + CREATE.
//   2. js/app-shell/main.js's runDatasetLoad now guards against overlapping
//      calls: while one dataset load is in flight, a second click is a
//      silent no-op rather than starting a second concurrent load.
//
// This test fires two back-to-back clicks on #btn-load-golden as fast as
// Playwright can dispatch them (no artificial delay — the real click handler,
// the real guard, and the real DuckDB-WASM engine are all exercised for
// real) and asserts: no catalog/"already exists" error reaches the console,
// exactly one golden dataset row-set ends up loaded, and the app is left in
// a normal, usable state afterward.
//
// RUN WITH:  node test/golden-dataset-race.e2e.test.mjs

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

    // The actual regression scenario: fire two clicks on the golden-dataset
    // button back-to-back, with no wait between them, so their two async
    // load actions genuinely overlap in flight.
    console.log('▶ firing two overlapping clicks on #btn-load-golden…');
    await Promise.all([
      page.click('#btn-load-golden'),
      page.click('#btn-load-golden'),
    ]);
    console.log('✓ both clicks dispatched');

    // The dataset must still end up loaded exactly once, with no unhandled
    // catalog error surfaced as a visible engine-error banner.
    await page.waitForFunction(
      () => document.querySelectorAll('#dataset-list .dataset-item').length > 0,
      { timeout: 30000, polling: 500 }
    );
    console.log('✓ golden dataset loaded despite the overlapping clicks');

    const datasetCount = await page.evaluate(
      () => document.querySelectorAll('#dataset-list .dataset-item').length
    );
    if (datasetCount === 1) {
      console.log('✓ exactly one dataset entry registered (no duplicate load)');
    } else {
      failed = true;
      console.log(`✗ FAILED: expected exactly 1 dataset entry, found ${datasetCount}`);
    }

    // No visible engine-error banner should be showing (the bug's exact
    // symptom was a "table already exists" catalog error surfacing here).
    const errorBanner = await page.evaluate(() => {
      const box = document.querySelector('#engine-error');
      if (!box || box.style.display === 'none') return null;
      const detail = box.querySelector('[data-testid="engine-error-detail"]');
      return detail ? detail.textContent : (box.textContent || '').trim() || null;
    });
    if (errorBanner) {
      failed = true;
      console.log(`✗ FAILED: an engine-error banner is showing after the overlapping clicks: "${errorBanner}"`);
    } else {
      console.log('✓ no engine-error banner showing');
    }

    // No "already exists" / "does not exist" catalog error should have hit
    // the console either, even if it didn't make it to the banner.
    const catalogErrors = consoleLines.filter(l => /already exists|catalog error/i.test(l));
    if (catalogErrors.length > 0) {
      failed = true;
      console.log('✗ FAILED: a catalog error reached the console:');
      for (const l of catalogErrors) console.log('    ' + l);
    } else {
      console.log('✓ no catalog error in the console');
    }

    // The app should still be fully usable afterward — run validation against
    // the loaded dataset as a final sanity check that the table is intact.
    await page.click('[data-testid="tab-validate"]');
    await page.click('#btn-validate-run');
    await page.waitForFunction(
      () => document.querySelectorAll('#validation-grid [data-testid^="card-validation-"]').length > 0,
      { timeout: 30000, polling: 500 }
    );
    console.log('✓ validation still runs cleanly against the table after the overlapping load');
  } catch (err) {
    failed = true;
    console.log('\n✗ FAILED: ' + (err && err.message ? err.message : err));
    try {
      await page.screenshot({ path: join(REPO_ROOT, 'test', 'golden-dataset-race-failure.png'), fullPage: true });
      console.log('  saved screenshot → test/golden-dataset-race-failure.png');
    } catch { /* ignore */ }
    console.log('  --- browser console ---');
    for (const line of consoleLines.slice(-40)) console.log('  ' + line);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed ? '\nGOLDEN DATASET RACE E2E: FAILED' : '\nGOLDEN DATASET RACE E2E: PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — golden-dataset-race run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
