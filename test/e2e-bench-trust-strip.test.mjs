// ============================================================
// DATAGLOW — The Bench x Trust Strip / Proof Drawer wiring e2e (real Chromium)
// ============================================================
// Batch 3 wires the Batch 1/2 session lineage (js/app-shell/bench-shell.js,
// logged live from the SQL/Python/R tabs) into the ALREADY-LIVE Trust Strip +
// Proof Drawer (OneCanvas Phase 1, trustStripProofDrawer flag, shipped ON) on
// the Validate tab, rather than building a second, competing trust surface.
//
// This test proves the real, end-to-end path: run a SQL query with theBench
// on, switch to the Validate tab, confirm the Trust Strip's Lineage field
// mentions the session's Bench story, click it, and confirm the Proof Drawer
// shows the actual steps as their own block alongside the usual attestation.
//
// RUN WITH:  node test/e2e-bench-trust-strip.test.mjs

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
  const ext = path.slice(path.lastIndexOf('.'));
  return MIME[ext] || 'application/octet-stream';
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

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function gotoAndInitEngine(page, baseUrl) {
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__dataglowReady === true || typeof window.__dataglowInitError === 'string',
    { timeout: READY_TIMEOUT_MS, polling: 1000 }
  );
  const initError = await page.evaluate(() => window.__dataglowInitError || null);
  if (initError) throw new Error('DuckDB-WASM engine failed to initialize: ' + initError);
}

async function loadGoldenDataset(page) {
  await page.click('#btn-load-golden');
  await page.waitForFunction(
    () => document.querySelectorAll('#dataset-list .dataset-item').length > 0,
    { timeout: 30000, polling: 500 }
  );
}

async function runSql(page, sql) {
  await page.fill('#sql-input', sql);
  await page.click('#btn-sql-run');
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#sql-status');
      const wrap = document.querySelector('#sql-result-wrap');
      const errored = wrap && wrap.querySelector('[data-testid="sql-error"]');
      return errored || (status && /row\(s\)/i.test(status.textContent));
    },
    { timeout: 30000, polling: 250 }
  );
}

async function disableServiceWorker(page) {
  await page.addInitScript(() => {
    try {
      delete Object.getPrototypeOf(navigator).serviceWorker;
      Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
      delete navigator.serviceWorker;
    } catch (e) { /* ignore on engines where this isn't deletable */ }
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

  // theBench is dark by default -- force it on for this test (byte-identical
  // code path, same route-intercept pattern as the rigor-engine-badges and
  // Batch 2 story-strip e2e tests). trustStripProofDrawer already ships ON,
  // so it needs no override.
  await disableServiceWorker(page);
  await page.route('**/flags.manifest.json', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (body.flags && body.flags.theBench) body.flags.theBench.enabled = true;
    await route.fulfill({ response: res, json: body });
  });

  try {
    await gotoAndInitEngine(page, baseUrl);
    await loadGoldenDataset(page);
    await page.click('[data-testid="tab-sql"]');
    await runSql(page, 'SELECT * FROM golden_test_dataset LIMIT 5;');

    // Sanity: the story strip itself shows 2 steps (upload + sql) before we
    // even look at the Trust Strip -- same behavior Batch 2's own test proves,
    // re-confirmed here as the precondition for what follows.
    await page.waitForFunction(
      () => document.querySelectorAll('#bench-story-sql .bench-story-step').length >= 2,
      { timeout: 15000, polling: 250 }
    );

    // Switch to the Validate tab -- the Trust Strip should already reflect
    // the Bench story from having run through renderBenchStoryStrip's own
    // renderTrustStripPanel() call, without needing a manual validation run.
    await page.click('[data-testid="tab-validate"]');
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="trust-field-lineage"]');
        return !!btn && /available/i.test(btn.textContent);
      },
      { timeout: 15000, polling: 250 }
    );
    const lineageFieldTitle = await page.evaluate(() => document.querySelector('[data-testid="trust-field-lineage"]').getAttribute('title'));
    ok(/Bench story/i.test(lineageFieldTitle || ''),
      'Trust Strip Lineage field detail mentions "Bench story" after switching to Validate (live-refreshed, no manual re-render needed)');

    // Click the Lineage field -> Proof Drawer opens with a distinct Bench-story block.
    await page.click('[data-testid="trust-field-lineage"]');
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="proof-drawer"]'),
      { timeout: 10000, polling: 200 }
    );
    const drawerText = await page.evaluate(() => document.querySelector('[data-testid="proof-drawer"]').textContent);
    ok(/This session's Bench story/i.test(drawerText), 'Proof Drawer shows a distinctly-labelled "This session\'s Bench story" section');
    ok(/sql: SELECT/i.test(drawerText), 'Proof Drawer\'s Bench-story section names the real SQL step that was run');

    // Close the drawer, confirm it's gone (basic interaction sanity).
    await page.click('[data-testid="proof-drawer-close"]');
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="proof-drawer"]'),
      { timeout: 5000, polling: 200 }
    );
    ok(true, 'Proof Drawer closes cleanly via its close button');

    const pageErrors = consoleLines.filter(l => l.startsWith('[pageerror]'));
    ok(pageErrors.length === 0, `no page errors thrown (${pageErrors.length} found)`);
  } finally {
    await page.close();
  }

  await browser.close();
  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nE2E BENCH TRUST STRIP: FAILED');
    process.exit(1);
  }
  console.log('\nE2E BENCH TRUST STRIP: PASSED');
}

main().catch((err) => {
  console.error('\n✗ UNEXPECTED ERROR — e2e run aborted:');
  console.error(err);
  process.exit(1);
});
