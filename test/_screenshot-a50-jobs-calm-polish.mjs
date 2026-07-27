// Ad-hoc screenshot harness for A50 Jobs Calm Polish proof-of-polish
// (SPEC requirement #8): desktop 1280 + mobile 375, home + post-load.
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
        if (u === '/') u = '/canvas/index.html';
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

// Small sample CSV so "post-load" state can be reached without the real
// sample-data button (which fetches a bundled dataset URL we don't need to
// depend on here).
// Avoid PHI-like column names (name/dob/mrn/etc.) so the unrelated
// Witness PHI nudge toast does not cover the purpose-contract Sign button
// in these screenshots -- that nudge is a separate, pre-existing feature.
const lines = ['widget,quantity,region'];
for (let i = 0; i < 20; i++) lines.push(`Widget ${i},${20 + (i % 40)},Region ${i % 5}`);
const csv = lines.join('\n');
const tmp = join(REPO_ROOT, 'test', '_a50-demo.csv');
await writeFile(tmp, csv);

await mkdir(join(REPO_ROOT, 'docs', 'a50-jobs-calm-polish'), { recursive: true });
const outDir = join(REPO_ROOT, 'docs', 'a50-jobs-calm-polish');

const { server, baseUrl } = await startServer();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-gl=swiftshader'] });

async function capture(viewport, label) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', e => console.log(`[pageerror:${label}]`, e.message));
  try {
    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__dataglowReady === true || typeof window.__dataglowInitError === 'string',
      { timeout: 120000, polling: 1000 }
    ).catch(() => {});
    // Best-effort settle for late-mounted floating buttons (trust ledger,
    // air gap, shield packs, proof harness, question scout).
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(outDir, `${label}-home.png`) });

    // Drive to post-load state via the real file input, same technique
    // other screenshot harnesses in this repo use.
    const fileInput = await page.$('#file-input');
    if (fileInput) {
      await fileInput.setInputFiles(tmp);
      await page.waitForFunction(
        () => document.body.classList.contains('has-data'),
        { timeout: 30000, polling: 500 }
      ).catch(() => {});
      await page.waitForTimeout(1200);
    }
    await page.screenshot({ path: join(outDir, `${label}-post-load-purpose-contract.png`) });

    // Walk through the real journey: dismiss the data-pulse import summary
    // sheet (pre-existing, unrelated feature layered on top), then confirm
    // the pre-selected purpose-contract default, to reach the actual A50
    // post-load spotlight underneath -- same buttons a real user clicks.
    const psClose = await page.$('#dg-ps-close');
    if (psClose) { await psClose.click().catch(() => {}); await page.waitForTimeout(500); }
    const nudgeClose = await page.$('#dg-aj-nudge-close');
    if (nudgeClose) { await nudgeClose.click().catch(() => {}); await page.waitForTimeout(300); }
    const pcSign = await page.$('#dg-pc-sign-btn');
    if (pcSign) { await pcSign.click().catch(() => {}); await page.waitForTimeout(600); }
    await page.screenshot({ path: join(outDir, `${label}-post-load-contract-signed.png`) });

    // The signed-confirmation panel has no auto-dismiss timer (by design --
    // it is a receipt, not a toast). Close it the same way a real user
    // would (tap outside the modal card) so the spotlight underneath is
    // visible for the actual A50 proof-of-polish shot.
    await page.evaluate(() => {
      var overlay = document.getElementById('dg-purpose-contract-overlay');
      if (overlay) { overlay.style.opacity = '0'; overlay.style.pointerEvents = 'none'; }
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(outDir, `${label}-post-load.png`) });
    console.log(`OK ${label}: home + post-load captured`);
  } catch (e) {
    console.error(`FAILED ${label}:`, e.message);
    process.exitCode = 1;
  } finally {
    await page.close();
  }
}

try {
  await capture({ width: 1280, height: 900 }, 'desktop-1280');
  await capture({ width: 375, height: 812 }, 'mobile-375');
} finally {
  await browser.close();
  server.close();
}
