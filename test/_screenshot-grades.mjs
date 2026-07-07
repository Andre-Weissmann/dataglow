import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8', '.map': 'application/json; charset=utf-8' };
function ct(p) { return MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream'; }

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let u = decodeURIComponent(req.url.split('?')[0]);
        if (u === '/') u = '/index.html';
        const fp = normalize(join(REPO_ROOT, u));
        if (!fp.startsWith(REPO_ROOT)) { res.writeHead(403); res.end(); return; }
        const body = await readFile(fp);
        res.writeHead(200, { 'Content-Type': ct(fp) });
        res.end(body);
      } catch (e) { res.writeHead(e.code === 'ENOENT' ? 404 : 500); res.end(String(e.message || e)); }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

const { server, baseUrl } = await startServer();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-gl=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
try {
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__dataglowReady === true || typeof window.__dataglowInitError === 'string', { timeout: 120000, polling: 1000 });
  await page.click('#btn-load-golden');
  await page.waitForFunction(() => document.querySelectorAll('#dataset-list .dataset-item').length > 0, { timeout: 60000, polling: 500 });
  await page.click('[data-testid="tab-validate"]');
  await page.click('#btn-validate-run');
  await page.waitForFunction(() => {
    const i = document.querySelector('[data-testid="grade-integrity-grade"]');
    const p = document.querySelector('[data-testid="grade-plausibility-grade"]');
    const o = document.querySelector('[data-testid="grade-overall-grade"]');
    return i && p && o && /[A-F]/.test(i.textContent) && /[A-F]/.test(p.textContent) && /[A-F]/.test(o.textContent);
  }, { timeout: 20000, polling: 500 });
  // Capture the whole Data Health Dashboard so the screenshot shows the full
  // visual hierarchy: the Overall headline (primary), the Integrity/Domain
  // breakdown (expanded), and the collapsed Advanced/Legacy disclosure.
  const wrap = await page.$('#data-health-wrap');
  await wrap.screenshot({ path: join(REPO_ROOT, 'docs/calibrated-grades.png') });

  // A second capture with the Advanced/Legacy disclosure expanded, showing the
  // de-prioritised legacy confidence ring + CAT scorecard are still reachable.
  await page.click('[data-testid="advanced-legacy"] > summary');
  await page.waitForFunction(() => {
    const r = document.querySelector('#confidence-summary');
    return r && r.getBoundingClientRect().height > 0;
  }, { timeout: 5000, polling: 200 });
  const adv = await page.$('[data-testid="advanced-legacy"]');
  await adv.scrollIntoViewIfNeeded();
  await adv.screenshot({ path: join(REPO_ROOT, 'docs/calibrated-grades-advanced-expanded.png') });

  const grades = await page.evaluate(() => ({
    integrity: document.querySelector('[data-testid="grade-integrity-grade"]').textContent.trim(),
    domain: document.querySelector('[data-testid="grade-plausibility-grade"]').textContent.trim(),
    overall: document.querySelector('[data-testid="grade-overall-grade"]').textContent.trim(),
  }));
  console.log('SCREENSHOT OK', JSON.stringify(grades));
} catch (e) {
  console.error('SCREENSHOT FAILED', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
