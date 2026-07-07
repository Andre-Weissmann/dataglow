// Ad-hoc screenshot harness for the Upper-Bound Sanity Anchor layer.
// Serves the app, uploads a small CSV containing a percentage column with an
// impossible 500 (decimal-slip typo) and a proportion column with an out-of-
// range value, runs validation, and captures the layer's card.
import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

const csv = [
  'region,completion_pct,win_probability,flow_rate',
  'r1,50,0.82,250',
  'r2,80,0.65,480',
  'r3,100,0.40,900',
  'r4,72,0.55,1500',
  'r5,64,0.90,320',
  'r6,88,0.20,760',
  'r7,95,0.33,410',
  'r8,41,0.71,1180',
  'r9,500,0.95,640',   // 500% is impossible (decimal slip); flow_rate stays unbounded (skipped)
  'r10,-5,1.30,890',   // negative % and a probability of 1.30 are both impossible
].join('\n');

const tmp = join(REPO_ROOT, 'test', '_upperbound-demo.csv');
await writeFile(tmp, csv);

const { server, baseUrl } = await startServer();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-gl=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
try {
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__dataglowReady === true || typeof window.__dataglowInitError === 'string', { timeout: 120000, polling: 1000 });

  await page.setInputFiles('#file-input', tmp);
  await page.waitForFunction(() => document.querySelectorAll('#dataset-list .dataset-item').length > 0, { timeout: 60000, polling: 500 });

  await page.click('[data-testid="tab-validate"]');
  await page.click('#btn-validate-run');
  await page.waitForSelector('[data-testid="upperbound-checked"]', { timeout: 30000 });

  const card = await page.$('[data-testid="upperbound-checked"]');
  // Walk up to the enclosing layer card for a clean capture.
  const layerCard = await page.evaluateHandle(el => el.closest('.card') || el.parentElement, card);
  await layerCard.asElement().scrollIntoViewIfNeeded();
  await mkdir(join(REPO_ROOT, 'docs'), { recursive: true });
  await layerCard.asElement().screenshot({ path: join(REPO_ROOT, 'docs/upper-bound-sanity.png') });

  const info = await page.evaluate(() => ({
    checked: document.querySelector('[data-testid="upperbound-checked"]')?.textContent,
    findings: [...document.querySelectorAll('[data-testid^="upperbound-finding-"]')].map(n => n.querySelector('div:last-child')?.textContent),
  }));
  console.log('SCREENSHOT OK', JSON.stringify(info, null, 2));
} catch (e) {
  console.error('SCREENSHOT FAILED', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
