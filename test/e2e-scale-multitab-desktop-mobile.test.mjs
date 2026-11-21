// ============================================================
// DATAGLOW — Playwright e2e: scale flags across staged desktop bundle,
// multi-tab OPFS, and a phone-sized viewport
// ============================================================
// Serves the STAGED Tauri desktop frontend (src-tauri/dist/, produced by
// scripts/stage-desktop-frontend.mjs) over localhost with the real
// COOP/COEP headers and drives it in a real Chromium.
//
// IMPORTANT — flags stay OFF on disk. `flags.manifest.json` ships with
// opfsPersistence=false and streamingIngestion=false. This test turns them on
// ONLY inside the test HTTP server (a second server instance rewrites the two
// booleans in the served JSON response); the file on disk is never touched and
// the test asserts that.
//
//   Test A  staged-bundle flag parity: flags.manifest.json is fetched (200) from
//           the staged bundle, every flag loads, live Glow Canvas tab mounts.
//   Test B  multi-tab OPFS: Tab 1 holds the exclusive OPFS lock; Tab 2 on the
//           same origin must degrade to in-memory (and say why via
//           getOPFSFallbackReason()) without crashing or corrupting Tab 1; after
//           both close, Tab 3 sees the 3 rows; deferred clear works across reload.
//   Test C  390x844 mobile viewport: no horizontal overflow, Settings OPFS
//           consent toggle reachable, >100MB CSV streams through DuckDB.
//
// RUN WITH:  node test/e2e-scale-multitab-desktop-mobile.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const DIST_ROOT = join(REPO_ROOT, 'src-tauri', 'dist');
const READY_TIMEOUT_MS = 90000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
};
const contentType = (p) => MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}${extra ? `\n      ${extra}` : ''}`); }
}

// COOP/COEP static server rooted at the staged desktop bundle. `scale` rewrites
// ONLY the served flags.manifest.json response (never the file on disk).
function startServer({ scale }) {
  const stats = { flagsRequests: 0 };
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === '/') urlPath = '/index.html';
        const filePath = normalize(join(DIST_ROOT, urlPath));
        if (!filePath.startsWith(DIST_ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
        let body = await readFile(filePath);
        const headers = {
          'Content-Type': contentType(filePath),
          'Cache-Control': 'no-store',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Resource-Policy': 'same-origin',
        };
        if (urlPath === '/flags.manifest.json') {
          stats.flagsRequests++;
          if (scale) {
            const m = JSON.parse(body.toString('utf8'));
            m.flags.opfsPersistence.enabled = true;
            m.flags.streamingIngestion.enabled = true;
            body = Buffer.from(JSON.stringify(m));
          }
        }
        res.writeHead(200, headers);
        res.end(body);
      } catch (e) {
        res.writeHead(e.code === 'ENOENT' ? 404 : 500);
        res.end(String(e.message || e));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, stats, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function waitReady(page) {
  await page.waitForFunction(
    () => window.__dataglowReady === true || typeof window.__dataglowInitError === 'string',
    { timeout: READY_TIMEOUT_MS, polling: 500 });
  const err = await page.evaluate(() => window.__dataglowInitError || null);
  if (err) throw new Error('DuckDB-WASM engine failed to initialize: ' + err);
}

// Open a tab, track its console, wait for the real engine.
async function openTab(context, baseUrl, label, logs) {
  const page = await context.newPage();
  page.on('console', (m) => logs.push(`[${label}:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[${label}:pageerror] ${e.message}`));
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await waitReady(page);
  return page;
}

// Module-singleton access: dynamic import of the SAME URL the app already
// loaded resolves to the app's own live module instance.
const engineState = (page) => page.evaluate(async () => {
  const eng = await import('/js/app-shell/duckdb-engine.js');
  return { active: eng.isOPFSPersistenceActive(), reason: eng.getOPFSFallbackReason() };
});
const sql = (page, q) => page.evaluate(async (query) => {
  const eng = await import('/js/app-shell/duckdb-engine.js');
  const r = await eng.runQuery(query);
  return JSON.parse(JSON.stringify(r.rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}, q);

async function main() {
  // Stage the desktop frontend fresh so the test always runs against the
  // current repo contents, exactly as `tauri dev/build` would.
  execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'stage-desktop-frontend.mjs')], { stdio: 'pipe' });
  const diskManifestBefore = readFileSync(join(REPO_ROOT, 'flags.manifest.json'), 'utf8');
  const diskFlags = JSON.parse(diskManifestBefore).flags;
  const diskFlagCount = Object.keys(diskFlags).length;
  ok('flags.manifest.json on disk ships opfsPersistence=true', diskFlags.opfsPersistence.enabled === true);
  ok('flags.manifest.json on disk ships streamingIngestion=true', diskFlags.streamingIngestion.enabled === true);

  const plain = await startServer({ scale: false });
  const scaled = await startServer({ scale: true });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({
    headless: true, executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const logs = [];
  const ctxOpts = { serviceWorkers: 'block' }; // deterministic: no SW cache between runs
  try {
    // ---------------- Test A ----------------
    console.log('\nTest A — staged desktop bundle flag parity');
    {
      const context = await browser.newContext(ctxOpts);
      const page = await context.newPage();
      page.on('pageerror', (e) => logs.push(`[A:pageerror] ${e.message}`));
      const flagResponses = [];
      page.on('response', (r) => { if (r.url().endsWith('/flags.manifest.json')) flagResponses.push(r.status()); });
      await page.goto(plain.baseUrl + '/', { waitUntil: 'domcontentloaded' });
      await waitReady(page);
      ok('staged bundle fetched flags.manifest.json with HTTP 200', flagResponses.includes(200), `statuses=${flagResponses}`);
      ok('page is crossOriginIsolated under COOP/COEP', await page.evaluate(() => window.crossOriginIsolated === true));
      const live = await page.evaluate(async () => {
        const f = await import('/js/build/build-flags.js');
        return { count: f.listFlags().length, glow: f.isEnabled('glowCanvas'), audio: f.isEnabled('audioTranscription'),
          video: f.isEnabled('videoTranscription'), opfs: f.isEnabled('opfsPersistence'), stream: f.isEnabled('streamingIngestion') };
      });
      ok(`all ${diskFlagCount} flags from the manifest loaded live in the staged bundle`, live.count === diskFlagCount, `live=${live.count} disk=${diskFlagCount}`);
      ok('glowCanvas + audioTranscription enabled, videoTranscription disabled', live.glow && live.audio && !live.video);
      ok('opfsPersistence + streamingIngestion load ON with the unmodified manifest', live.opfs && live.stream);
      ok('Glow Canvas tab mounts in the staged desktop frontend',
        (await page.locator('#tabbar .tab[data-tab="glowcanvas"]').count()) === 1);
      const eng = await engineState(page);
      ok('OPFS persistence stays inactive with no fallback reason until Settings consent is enabled', eng.active === false && eng.reason === null);
      await context.close();
    }

    // ---------------- Test B ----------------
    console.log('\nTest B — multi-tab OPFS lock and fallback');
    {
      const context = await browser.newContext(ctxOpts);
      await context.addInitScript(() => {
        try { localStorage.setItem('dataglow_persist_opfs_database', '1'); } catch (_) { /* opaque */ }
      });
      const tab1 = await openTab(context, scaled.baseUrl, 'T1', logs);
      const e1 = await engineState(tab1);
      ok('Tab 1: isOPFSPersistenceActive() === true', e1.active === true, JSON.stringify(e1));
      ok('Tab 1: no fallback reason', e1.reason === null);
      await sql(tab1, 'CREATE TABLE multitab_proof (id INT, note VARCHAR)');
      await sql(tab1, "INSERT INTO multitab_proof VALUES (1,'one'),(2,'two'),(3,'three')");
      ok('Tab 1: 3 rows written', (await sql(tab1, 'SELECT COUNT(*) AS n FROM multitab_proof'))[0].n === 3);

      // Tab 1 stays OPEN, holding the exclusive OPFS sync-access-handle lock.
      const tab2 = await openTab(context, scaled.baseUrl, 'T2', logs);
      const e2 = await engineState(tab2);
      ok('Tab 2: DuckDB initialised (did not crash) while Tab 1 holds the lock', true);
      console.log(`    Tab 2 state: ${JSON.stringify(e2)}`);
      ok('Tab 2: fell back to in-memory (isOPFSPersistenceActive() === false)', e2.active === false);
      ok("Tab 2: getOPFSFallbackReason() reports 'locked-or-unavailable'",
        typeof e2.reason === 'string' && e2.reason.startsWith('locked-or-unavailable'), String(e2.reason));
      ok('Tab 2: in-memory fallback answers queries', (await sql(tab2, 'SELECT 21*2 AS x'))[0].x === 42);
      await sql(tab2, 'CREATE TABLE tab2_scratch AS SELECT 1 AS a');
      ok('Tab 2: sees none of Tab 1\u2019s OPFS tables (isolated in-memory DB)',
        (await sql(tab2, "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name='multitab_proof'"))[0].n === 0);
      ok('Tab 1 uncorrupted: still has 3 rows after Tab 2 ran',
        (await sql(tab1, 'SELECT COUNT(*) AS n FROM multitab_proof'))[0].n === 3);
      ok('Tab 1 unaffected by Tab 2 scratch table',
        (await sql(tab1, "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name='tab2_scratch'"))[0].n === 0);
      ok('Tab 1 still reports OPFS active', (await engineState(tab1)).active === true);

      await tab2.close();
      await tab1.close();
      await new Promise((r) => setTimeout(r, 1500)); // let workers release sync-access handles

      const tab3 = await openTab(context, scaled.baseUrl, 'T3', logs);
      const e3 = await engineState(tab3);
      ok('Tab 3: OPFS persistence active after the others closed', e3.active === true, JSON.stringify(e3));
      const rows = await sql(tab3, 'SELECT id, note FROM multitab_proof ORDER BY id');
      ok('Tab 3: multitab_proof\u2019s 3 rows survived in OPFS',
        rows.length === 3 && rows.map((r) => r.note).join() === 'one,two,three', JSON.stringify(rows));
      const stats = await tab3.evaluate(async () => (await import('/js/app-shell/duckdb-engine.js')).getOPFSDatabaseStats());
      ok('Tab 3: OPFS database file exists and is non-empty', stats.exists === true && stats.sizeBytes > 0, JSON.stringify(stats));

      const clearRes = await tab3.evaluate(async () => (await import('/js/app-shell/duckdb-engine.js')).clearOPFSDatabase());
      ok('Tab 3: clearOPFSDatabase() while holding the lock returns deferred:true', clearRes.deferred === true && clearRes.deleted === false, JSON.stringify(clearRes));
      ok('Tab 3: pending-clear marker recorded',
        (await tab3.evaluate(() => localStorage.getItem('dataglow_persist_opfs_pending_clear'))) !== null);
      await tab3.reload({ waitUntil: 'domcontentloaded' });
      await waitReady(tab3);
      const gone = await sql(tab3, "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name='multitab_proof'");
      ok('Tab 3 after reload: deferred clear wiped the persisted table', gone[0].n === 0, JSON.stringify(gone));
      ok('Tab 3 after reload: pending-clear marker consumed',
        (await tab3.evaluate(() => localStorage.getItem('dataglow_persist_opfs_pending_clear'))) === null);
      ok('Tab 3 after reload: engine healthy and OPFS re-opened fresh', (await engineState(tab3)).active === true);
      await context.close();
    }

    // ---------------- Test C ----------------
    console.log('\nTest C — mobile viewport 390x844');
    {
      const context = await browser.newContext({ ...ctxOpts, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const page = await openTab(context, scaled.baseUrl, 'M', logs);
      const dims = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      ok('no horizontal overflow at 390px (scrollWidth <= 390)', dims.sw <= 390, JSON.stringify(dims));
      await page.click('#btn-settings');
      const section = page.locator('#opfs-persistence-section');
      await section.scrollIntoViewIfNeeded();
      ok('Settings OPFS consent section is visible on mobile (flag on)', await section.isVisible());
      const toggle = page.locator('#toggle-persist-opfs-database');
      await toggle.scrollIntoViewIfNeeded();
      const box = await toggle.boundingBox();
      ok('OPFS consent toggle is within the 390px viewport width', !!box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
      await toggle.click();
      ok('tapping the toggle records consent', (await page.evaluate(() => localStorage.getItem('dataglow_persist_opfs_database'))) === '1');
      await toggle.click();
      ok('tapping again withdraws consent', (await page.evaluate(() => localStorage.getItem('dataglow_persist_opfs_database'))) === '0');
      ok('Settings panel adds no horizontal overflow', (await page.evaluate(() => document.documentElement.scrollWidth)) <= 390);
      await page.click('#btn-settings-close').catch(() => {});

      // Streaming ingestion: below the 100MB threshold the flag alone must NOT
      // engage streaming; above it (built in-page from a Blob, no disk I/O) it must.
      const small = await page.evaluate(async () => {
        const loaders = await import('/js/app-shell/loaders.js');
        const flags = await import('/js/build/build-flags.js');
        return loaders.shouldStreamIngest('csv', 5 * 1024 * 1024, flags.isEnabled('streamingIngestion'));
      });
      ok('shouldStreamIngest() stays false for a 5MB CSV even with the flag on', small === false);
      const big = await page.evaluate(async () => {
        const loaders = await import('/js/app-shell/loaders.js');
        const flags = await import('/js/build/build-flags.js');
        const row = (i) => `${i},customer_${i % 977},${(i * 7919) % 100003}.25,${'x'.repeat(88)}\n`;
        let chunk = '';
        for (let i = 0; i < 10000; i++) chunk += row(i);
        const parts = ['id,customer,amount,pad\n'];
        const copies = Math.ceil((101 * 1024 * 1024) / chunk.length);
        for (let r = 0; r < copies; r++) parts.push(chunk);
        const file = new File(parts, 'mobile_big_stream.csv', { type: 'text/csv' });
        const decision = loaders.shouldStreamIngest('csv', file.size, flags.isEnabled('streamingIngestion'));
        const t0 = performance.now();
        const ds = await loaders.loadFile(file);
        const eng = await import('/js/app-shell/duckdb-engine.js');
        const agg = await eng.runQuery(`SELECT COUNT(*) AS n, COUNT(DISTINCT customer) AS c, SUM(CAST(id AS BIGINT)) AS s FROM ${ds.table}`);
        const r0 = agg.rows[0];
        return { size: file.size, decision, streamed: ds.streamed, rowCount: Number(ds.rowCount), expect: copies * 10000,
          n: Number(r0.n), c: Number(r0.c), s: Number(r0.s), expectSum: copies * (9999 * 10000 / 2), ms: Math.round(performance.now() - t0) };
      });
      console.log(`    ${(big.size / 1048576).toFixed(1)} MB CSV -> ${big.rowCount} rows in ${big.ms} ms`);
      ok('shouldStreamIngest() is true for >100MB CSV with the flag on', big.decision === true);
      ok('loadFile() took the streaming path (ds.streamed === true)', big.streamed === true);
      ok('streamed CSV row count matches the generated rows exactly', big.n === big.expect && big.rowCount === big.expect, JSON.stringify(big));
      ok('streamed CSV aggregates are correct (distinct customers, id sum)', big.c === 977 && big.s === big.expectSum, JSON.stringify(big));
      ok('mobile page still has no horizontal overflow after ingestion', (await page.evaluate(() => document.documentElement.scrollWidth)) <= 390);
      await context.close();
    }

    ok('flags.manifest.json on disk is byte-for-byte unchanged by the test',
      readFileSync(join(REPO_ROOT, 'flags.manifest.json'), 'utf8') === diskManifestBefore);
    ok('plain staged server served the real manifest request(s)', plain.stats.flagsRequests >= 1);
  } catch (e) {
    failed++;
    console.log(`  \u2717 test aborted: ${e.stack || e.message}`);
    console.log('--- last console lines ---\n' + logs.slice(-40).join('\n'));
  } finally {
    await browser.close();
    plain.server.close();
    scaled.server.close();
  }
  console.log(`\n${failed === 0 ? '\u2713 PASSED' : '\u2717 FAILED'} \u2014 ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
