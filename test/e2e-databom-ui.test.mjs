// ============================================================
// DATAGLOW — "Verify Data BOM" button e2e (real Chromium)
// ============================================================
// verifyPersonalDataBom() in js/provenance/data-bom.js was fully built and
// unit-tested but wired to no UI — a user who built a Personal Data BOM had no
// in-app way to re-verify it. This test drives the real button (index.html
// #btn-databom-verify, wired in main.js initProvenance()) end-to-end:
//
//   • the button is visible (personalDataBom flag is ON);
//   • clicking it with no BOM built yet shows a graceful "export one first"
//     message and never throws;
//   • after a Data BOM is generated, clicking it renders the plain-language
//     "✓ Verified — this Data BOM has not been tampered with." success state,
//     proving the button verifies the real, most-recent in-memory BOM.
//
// The tampered → red "which part failed" rendering and the null-result guard
// are covered as pure unit tests in test/data-bom.test.mjs (describeBomVerification),
// because the button verifies a closure-held BOM object that cannot be tampered
// with from outside the page without an artificial prod-only test hook.
//
// A dataset is registered directly through the shared state module rather than
// through the file loader: the loader path defers on cross-origin isolation,
// which the plain static server here can't satisfy (same headless caveat as
// e2e-smoke.test.mjs), and the BOM builder only needs a registered dataset —
// it degrades gracefully when the DuckDB table/provenance chain are absent.
//
// RUN WITH:  node test/e2e-databom-ui.test.mjs

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

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
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
  const page = await browser.newPage({ acceptDownloads: true });

  const consoleLines = [];
  page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));

  try {
    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
    console.log('▶ page loaded, waiting for DuckDB-WASM engine to signal ready…');
    await page.waitForFunction(
      () => window.__dataglowReady === true || typeof window.__dataglowInitError === 'string',
      { timeout: READY_TIMEOUT_MS, polling: 1000 }
    );
    const initError = await page.evaluate(() => window.__dataglowInitError || null);
    if (initError) throw new Error('DuckDB-WASM engine failed to initialize: ' + initError);
    console.log('✓ engine ready');

    // The Export/Verify card lives inside the Validate tab's #provenance-wrap,
    // which the app reveals when a dataset's provenance trail renders. In this
    // headless sandbox the file loader can't run (cross-origin isolation), so
    // switch to the Validate tab and reveal that card directly — this is test
    // setup for the button's own behavior, not a claim about how the card is
    // normally unhidden.
    await page.click('[data-testid="tab-validate"]');
    await page.evaluate(() => {
      const wrap = document.getElementById('provenance-wrap');
      if (wrap) wrap.style.display = '';
    });

    // ---------- 1. The button is present and visible (flag ON) ----------
    const visible = await page.isVisible('[data-testid="button-databom-verify"]');
    ok(visible, 'Verify Data BOM button is visible when the personalDataBom flag is on');

    // ---------- 2. No BOM yet → graceful "export one first" message ----------
    await page.click('[data-testid="button-databom-verify"]');
    await page.waitForFunction(
      () => {
        const out = document.querySelector('[data-testid="databom-verify-result"]');
        return out && out.textContent.trim().length > 0;
      },
      { timeout: 10000, polling: 200 }
    );
    const noBomText = await page.evaluate(
      () => document.querySelector('[data-testid="databom-verify-result"]').textContent
    );
    ok(/first/i.test(noBomText) && !/✓|✗/.test(noBomText),
      'clicking Verify with no BOM shows a graceful "export one first" message (no verdict, no throw)');

    // ---------- 3. Build a BOM, then verify it → success state ----------
    // Register a dataset directly through the shared state singleton (same
    // module instance main.js imported), so getActiveDataset() returns it and
    // the Export Data BOM button can build a real BOM without the file loader.
    await page.evaluate(async () => {
      const state = await import('/js/app-shell/state.js');
      state.addDataset({
        name: 'dg_databom_e2e.csv',
        table: 'dg_databom_e2e',
        rowCount: 3,
        cols: [{ name: 'amount', type: 'DOUBLE' }, { name: 'status', type: 'VARCHAR' }],
        loadedAt: Date.now(),
      });
    });

    await page.click('[data-testid="button-databom-export"]');
    // The export handler is async (builds the BOM via crypto); wait for its
    // success toast, which fires only after lastBom has been set.
    await page.waitForFunction(
      () => /Personal Data BOM exported/i.test(document.querySelector('#toast-container')?.textContent || ''),
      { timeout: 20000, polling: 200 }
    );

    await page.click('[data-testid="button-databom-verify"]');
    await page.waitForFunction(
      () => /✓|✗/.test(document.querySelector('[data-testid="databom-verify-result"]')?.textContent || ''),
      { timeout: 15000, polling: 200 }
    );
    const verifiedText = await page.evaluate(
      () => document.querySelector('[data-testid="databom-verify-result"]').textContent
    );
    ok(/✓/.test(verifiedText) && /not been tampered with/i.test(verifiedText),
      'after exporting a Data BOM, Verify shows the plain-language "✓ Verified — not tampered with" success state');
    ok(!/✗/.test(verifiedText),
      'a freshly built BOM is not falsely reported as failing verification');
  } catch (err) {
    failed++;
    console.log('\n✗ FAILED: ' + (err && err.message ? err.message : err));
    console.log('  --- browser console (last 40) ---');
    for (const line of consoleLines.slice(-40)) console.log('  ' + line);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed ? 'E2E DATABOM-UI: FAILED' : 'E2E DATABOM-UI: PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — e2e run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
