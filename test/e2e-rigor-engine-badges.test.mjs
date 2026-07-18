// ============================================================
// DATAGLOW — Rigor Engine Batch 2 e2e (SQL/Visualize confidence badges +
// the SQL→Visualize gap fix)
// ============================================================
// Drives the real SQL and Visualize tabs with the rigorEngineBadges flag
// forced on (via a Playwright route intercept on flags.manifest.json — the
// flag ships `enabled: false`, so this is the only way to exercise it in a
// default build without touching the shipped manifest). Proves three things
// end-to-end, which none of the pure unit tests in
// test/statistical-rigor.test.mjs can prove on their own since they never
// touch the DOM or DuckDB:
//
//   1. A GROUP-BY-shaped SQL result renders the confidence badge, with the
//      correct worst-group verdict surfaced.
//   2. A non-grouped SQL result (e.g. a plain SELECT * with no categorical+
//      numeric pair) renders NO badge — the heuristic must not force a badge
//      onto every result.
//   3. "Send to Visualize" registers the SQL result as a real chartable
//      dataset and the Visualize tab's own badge renders for the same data.
//
// Also proves the flag-off default (no route intercept) leaves the SQL tab
// byte-for-byte unchanged — no badge host, no Send-to-Visualize button.
//
// Same real-browser rationale + headless setup as e2e-analysis-contract.test.mjs.
// RUN WITH:  node test/e2e-rigor-engine-badges.test.mjs

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

async function gotoAndInitEngine(page, baseUrl) {
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__dataglowReady === true || typeof window.__dataglowInitError === 'string',
    { timeout: READY_TIMEOUT_MS, polling: 1000 }
  );
  const initError = await page.evaluate(() => window.__dataglowInitError || null);
  if (initError) throw new Error('DuckDB-WASM engine failed to initialize: ' + initError);
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

  // ---- Page 1: flag OFF (default shipped state) — byte-for-byte unchanged ----
  {
    const page = await browser.newPage();
    const consoleLines = [];
    page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));
    try {
      await gotoAndInitEngine(page, baseUrl);
      await page.click('[data-testid="tab-sql"]');
      await runSql(page, "SELECT 'Medicare' AS payer, 400.0 AS amt UNION ALL SELECT 'Humana', 300.0;");
      const hasBadge = await page.evaluate(() => !!document.querySelector('[data-testid="rigor-confidence-badge"]'));
      const hasSendBtn = await page.evaluate(() => !!document.querySelector('[data-testid="btn-send-to-visualize"]'));
      ok(!hasBadge, 'flag OFF (shipped default): no confidence badge renders even for a grouped result');
      ok(!hasSendBtn, 'flag OFF (shipped default): no Send-to-Visualize button renders');
    } catch (err) {
      failed++;
      console.log('\n✗ FAILED (flag-off page): ' + (err && err.message ? err.message : err));
      console.log('  --- browser console (last 40) ---');
      for (const line of consoleLines.slice(-40)) console.log('  ' + line);
    } finally {
      await page.close();
    }
  }

  // ---- Page 2: flag ON via route intercept on flags.manifest.json ----
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));

  // sw.js registers a fetch handler that intercepts same-origin requests at
  // the service-worker layer, which Playwright's page.route cannot see
  // through — so the flags.manifest.json route below would silently never
  // fire with the SW active. Disabling serviceWorker entirely (not just
  // stubbing register()) makes index.html's own `'serviceWorker' in
  // navigator` guard skip registration cleanly, with no console/page error.
  await page.addInitScript(() => {
    try {
      delete Object.getPrototypeOf(navigator).serviceWorker;
      Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
      delete navigator.serviceWorker;
    } catch (e) { /* ignore on engines where this isn't deletable */ }
  });

  await page.route('**/flags.manifest.json', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (body.flags && body.flags.rigorEngineBadges) body.flags.rigorEngineBadges.enabled = true;
    await route.fulfill({ response: res, json: body });
  });

  try {
    await gotoAndInitEngine(page, baseUrl);
    await page.click('[data-testid="tab-sql"]');

    // 1. Grouped result -> badge renders with the correct worst-group verdict.
    // Medicare gets 40 rows (sufficient, n>=30), Humana gets 5 (insufficient,
    // n<10) — the worst-group rule means the badge must read insufficient.
    const groupedSql = `
      SELECT payer, amt FROM (
        SELECT 'Medicare' AS payer, (400 + i) AS amt FROM range(40) t(i)
        UNION ALL
        SELECT 'Humana' AS payer, (300 + i) AS amt FROM range(5) t(i)
      );`;
    await runSql(page, groupedSql);
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="rigor-confidence-badge"]'),
      { timeout: 15000, polling: 250 }
    );
    const badgeText = await page.evaluate(() => document.querySelector('[data-testid="rigor-confidence-badge"]').textContent);
    ok(/insufficient/i.test(badgeText), 'grouped result badge shows "insufficient" (worst-group rule: Humana n=5 outweighs Medicare n=40)');
    ok(/payer/i.test(badgeText), 'badge names the detected group column ("payer")');

    // 2. Non-grouped result (two numeric columns, no categorical column) ->
    // no badge, proving the heuristic doesn't force a verdict onto every result.
    await runSql(page, 'SELECT 1.5 AS x, 2.5 AS y UNION ALL SELECT 3.5, 4.5;');
    const noBadge = await page.evaluate(() => {
      const host = document.querySelector('#rigor-confidence-host');
      return !host || host.innerHTML.trim() === '';
    });
    ok(noBadge, 'a non-grouped (all-numeric) result renders no confidence badge');

    // 3. Send to Visualize: re-run the grouped query, click Send to Visualize,
    // and confirm the Visualize tab becomes active with the new dataset
    // charted and its own badge rendered.
    await runSql(page, groupedSql);
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="btn-send-to-visualize"]'),
      { timeout: 15000, polling: 250 }
    );
    await page.click('[data-testid="btn-send-to-visualize"]');
    await page.waitForFunction(
      () => document.querySelector('#panel-visualize')?.classList.contains('active'),
      { timeout: 15000, polling: 250 }
    );
    const vizVisible = await page.evaluate(() => {
      const panel = document.querySelector('#panel-visualize');
      return panel && getComputedStyle(panel).display !== 'none';
    });
    ok(vizVisible, 'Send to Visualize switches to the Visualize tab');
    const xSelected = await page.evaluate(() => document.querySelector('#viz-x')?.value || '');
    ok(xSelected === 'payer', 'Send to Visualize pre-selects the detected group column ("payer") as the X axis');

    // Generate the chart to trigger the Visualize-tab badge, then confirm it renders.
    await page.click('#btn-viz-generate');
    await page.waitForFunction(
      () => {
        const host = document.querySelector('#viz-rigor-badge-host');
        return host && host.querySelector('[data-testid="rigor-confidence-badge"]');
      },
      { timeout: 15000, polling: 250 }
    );
    const vizBadgeText = await page.evaluate(() => document.querySelector('#viz-rigor-badge-host [data-testid="rigor-confidence-badge"]').textContent);
    ok(/insufficient/i.test(vizBadgeText), 'Visualize-tab badge shows the same "insufficient" verdict for the sent-over data');
  } catch (err) {
    failed++;
    console.log('\n✗ FAILED (flag-on page): ' + (err && err.message ? err.message : err));
    console.log('  --- browser console (last 40) ---');
    for (const line of consoleLines.slice(-40)) console.log('  ' + line);
  } finally {
    await page.close();
    await browser.close();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed ? 'E2E RIGOR-ENGINE-BADGES: FAILED' : 'E2E RIGOR-ENGINE-BADGES: PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — e2e run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
