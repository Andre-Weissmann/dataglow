// Ad-hoc screenshot harness for the Missingness Detective layer.
// Serves the app, uploads a small CSV engineered to exhibit all three regimes:
//   • insurance_type — missing far more for visit_type=ER than Scheduled  → MAR
//   • income        — a core field missing ~40% evenly across groups      → MCAR + MNAR caution
//   • notes         — missing at a low, unpatterned rate                  → MCAR
// then runs validation and captures the layer's card.
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

// Build 60 rows: 30 ER + 30 Scheduled.
const lines = ['visit_type,insurance_type,income,notes'];
for (let i = 0; i < 60; i++) {
  const er = i < 30;
  const visit = er ? 'ER' : 'Scheduled';
  // insurance_type: ER missing ~66%, Scheduled missing ~7% → strong MAR driver.
  const idxInGroup = er ? i : i - 30;
  const insMissing = er ? idxInGroup < 20 : idxInGroup < 2;
  const insurance = insMissing ? '' : (er ? 'PPO' : 'HMO');
  // income: core field, ~40% missing spread evenly across both groups → MCAR + MNAR caution.
  const income = (i % 5 < 2) ? '' : String(30000 + i * 500);
  // notes: low, unpatterned missingness → MCAR, non-core (no caution).
  const notes = (i % 7 === 0) ? '' : `note_${i}`;
  lines.push(`${visit},${insurance},${income},${notes}`);
}
const csv = lines.join('\n');

const tmp = join(REPO_ROOT, 'test', '_missingness-demo.csv');
await writeFile(tmp, csv);

const { server, baseUrl } = await startServer();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-gl=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
try {
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__dataglowReady === true || typeof window.__dataglowInitError === 'string', { timeout: 120000, polling: 1000 });

  await page.setInputFiles('#file-input', tmp);
  await page.waitForFunction(() => document.querySelectorAll('#dataset-list .dataset-item').length > 0, { timeout: 60000, polling: 500 });

  await page.click('[data-testid="tab-validate"]');
  await page.click('#btn-validate-run');
  await page.waitForSelector('[data-testid="missingness-checked"]', { timeout: 30000 });

  const card = await page.$('[data-testid="missingness-checked"]');
  const layerCard = await page.evaluateHandle(el => el.closest('.card') || el.parentElement, card);
  await layerCard.asElement().scrollIntoViewIfNeeded();
  await mkdir(join(REPO_ROOT, 'docs'), { recursive: true });
  await layerCard.asElement().screenshot({ path: join(REPO_ROOT, 'docs/missingness-detective.png') });

  const info = await page.evaluate(() => ({
    checked: document.querySelector('[data-testid="missingness-checked"]')?.textContent,
    findings: [...document.querySelectorAll('[data-testid^="missingness-finding-"]')].map(n => n.textContent.replace(/\s+/g, ' ').trim().slice(0, 220)),
  }));
  console.log('SCREENSHOT OK', JSON.stringify(info, null, 2));
} catch (e) {
  console.error('SCREENSHOT FAILED', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
