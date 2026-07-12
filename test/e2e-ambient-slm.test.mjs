// ============================================================
// DATAGLOW — Ambient Validation + On-Device SLM e2e test
// ============================================================
// Covers the two deterministic, browser-only paths added in Gen 9 Batch 2 that
// do NOT depend on the DuckDB-WASM engine booting (which can be blocked in
// stripped headless sandboxes):
//
//   (A) Ambient Validation — typing a query that groups by a protected column
//       ("race") surfaces a live, non-blocking warning within the debounce
//       window, produced by the Web Worker doing pure static SQL analysis.
//
//   (B) On-Device SLM graceful degradation — with WebGPU unavailable, the AI
//       Synthesis panel shows a clear "needs a WebGPU-capable browser" message
//       and disables the download button, without crashing. (WebGPU is forced
//       off here so the degradation path is deterministic; full model-load
//       synthesis requires manual verification in a WebGPU browser.)
//
// RUN WITH:  node test/e2e-ambient-slm.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const INIT_TIMEOUT_MS = 60000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8', '.map': 'application/json; charset=utf-8',
};
const contentType = (p) => MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream';

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
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

let passed = 0, failed = 0;
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
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));

  // Force WebGPU off so the SLM graceful-degradation path is deterministic
  // regardless of what the CI browser happens to expose.
  await page.addInitScript(() => {
    try { Object.defineProperty(navigator, 'gpu', { configurable: true, get: () => undefined }); } catch { /* ignore */ }
  });

  try {
    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
    // Wait for the synchronous app init — independent of the DuckDB engine —
    // AND for the cross-origin-isolation bootstrap to settle. On a host that
    // sends no COOP/COEP (this test's static server), sw.js injects those
    // headers and triggers a ONE-TIME window.location.reload() to become
    // isolated (see test/coi-race.e2e.test.mjs). __dataglowInit is set on BOTH
    // the pre- and post-reload pages, so gating on it alone can bind to the
    // pre-reload page, which the imminent reload tears down mid-interaction
    // (re-running init() → switchTab('preflight'), hiding panel-sql). Also
    // requiring isolation !== 'pending' waits out the transient pre-reload
    // state so we only drive the settled page.
    await page.waitForFunction(
      () => window.__dataglowInit === true && window.__dataglowIsolation !== 'pending',
      { timeout: INIT_TIMEOUT_MS, polling: 250 });
    console.log('✓ app initialized (engine-independent, isolation settled)');

    // -------- (B) SLM graceful degradation (WebGPU forced off) --------
    await page.click('[data-testid="tab-validate"]');
    // With validateFocusMode ON (its promoted default), the "Advanced options —
    // AI Synthesis" <details> starts collapsed on a fresh, not-yet-validated
    // dataset (applyValidateFocusMode force-closes it). #slm-status lives inside
    // it, so a real user expands that section to reach the SLM controls — mirror
    // that here (same summary-click expand pattern as e2e-smoke's Advanced/Legacy)
    // before waiting for slm-status to become visible.
    const aiSynthDetails = page.locator('[data-testid="validate-advanced-ai-synthesis"]');
    if ((await aiSynthDetails.getAttribute('open')) === null) {
      await page.click('[data-testid="validate-advanced-ai-synthesis"] > summary');
    }
    await page.waitForSelector('[data-testid="slm-status"]', { timeout: 10000 });
    const slmState = await page.getAttribute('[data-testid="slm-status"]', 'data-slm-state');
    ok(slmState === 'no-webgpu', `SLM: degradation state is "no-webgpu" (got "${slmState}")`);
    const slmText = (await page.textContent('[data-testid="slm-status"]')) || '';
    ok(/WebGPU/i.test(slmText), 'SLM: message clearly mentions WebGPU requirement');
    const downloadDisabled = await page.isDisabled('[data-testid="button-slm-download"]');
    ok(downloadDisabled, 'SLM: download button is disabled when WebGPU is unavailable (no crash)');

    // -------- (A) Ambient Validation warning on sensitive GROUP BY --------
    await page.click('[data-testid="tab-sql"]');
    await page.waitForSelector('[data-testid="input-sql"]', { timeout: 10000 });
    // Fill fires an 'input' event, which schedules the debounced (~800ms) check.
    await page.fill('[data-testid="input-sql"]', 'SELECT race, COUNT(*) FROM patients GROUP BY race');
    await page.waitForSelector('[data-testid="ambient-warning-sensitive_grouping"]', { timeout: 8000 });
    const warnText = (await page.textContent('[data-testid="ambient-warning-sensitive_grouping"]')) || '';
    ok(/protected column/i.test(warnText) && /race/i.test(warnText),
      'Ambient: sensitive GROUP BY surfaces a protected-column warning naming "race"');

    // The warning is dismissible and non-blocking.
    await page.click('[data-testid="ambient-dismiss-sensitive_grouping"]');
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="ambient-warning-sensitive_grouping"]'),
      { timeout: 5000 }
    );
    ok(true, 'Ambient: warning can be dismissed');

    // A benign query produces no warning.
    await page.fill('[data-testid="input-sql"]', 'SELECT admission_type, COUNT(*) FROM patients GROUP BY admission_type');
    await page.waitForTimeout(1400); // past the debounce window
    const benignVisible = await page.isVisible('#ambient-warnings').catch(() => false);
    const benignCount = await page.evaluate(
      () => document.querySelectorAll('#ambient-warnings [data-testid^="ambient-warning-"]').length
    );
    ok(benignCount === 0, `Ambient: a non-sensitive query produces no warnings (count=${benignCount}, visible=${benignVisible})`);
  } catch (err) {
    failed++;
    console.log('\n✗ FAILED: ' + (err && err.message ? err.message : err));
    try {
      await page.screenshot({ path: join(REPO_ROOT, 'test', 'e2e-failure.png'), fullPage: true });
      console.log('  saved screenshot → test/e2e-failure.png');
    } catch { /* ignore */ }
    console.log('  --- browser console ---');
    for (const line of consoleLines.slice(-40)) console.log('  ' + line);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed ? 'E2E AMBIENT+SLM: FAILED' : 'E2E AMBIENT+SLM: PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — e2e run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
