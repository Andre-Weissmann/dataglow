// ============================================================
// DATAGLOW — Query Memory Metric Studio wiring test (Batch 2, final quartet leg)
// ============================================================
// A real-browser DOM/integration test for the last unwired leg of Query
// Memory's own flag description ("fingerprint every SQL/Python/R/Metric
// Studio run"): the SQL/Python/R call sites in js/app-shell/main.js were
// already wired (see recordAndRenderQueryMemory's call sites); this test
// proves the NEW Metric Studio leg — js/metrics/metric-studio.js's
// onMetricComputed hook — fires on a real "Create metric" save that actually
// computes against a loaded table, exactly the way main.js wires it
// (recordMetricComputeInQueryMemory), and that a second identical save is
// recognized as "seen before".
//
// WHY a real browser: js/provenance/query-memory.js's computeQueryFingerprint
// uses Web Crypto SHA-256 (sha256Hex in js/provenance/provenance.js), which
// needs a real crypto.subtle — not stubbed here, exercised for real. No
// DuckDB/WASM is needed for the metric compute itself since a fake `engine`
// (duck-typed runQuery) is enough to prove the wiring; a real engine is
// covered by test:metricstudio's existing "compute: real DuckDB value" case.
// Modeled directly on test/metric-contracts-ui.test.mjs's structure.
//
// RUN WITH:  node test/query-memory-metric-studio-ui.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const TEST_PAGE = '/__querymemory_metricstudio_test__.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
function contentType(path) {
  const dot = path.lastIndexOf('.');
  return MIME[path.slice(dot)] || 'application/octet-stream';
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === TEST_PAGE) {
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
          return;
        }
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

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function main() {
  const { server, baseUrl } = await startServer();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({
    headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));

  try {
    await page.goto(baseUrl + TEST_PAGE, { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(async () => {
      const studio = await import('/js/metrics/metric-studio.js');
      const qm = await import('/js/provenance/query-memory.js');
      const qmUi = await import('/js/provenance/query-memory-ui.js');

      // A tiny in-memory store adapter, exactly the contract
      // js/learning/memory-store.js implements, mirroring how main.js wires
      // createQueryMemoryLog — no IndexedDB needed to prove the wiring.
      const log = [];
      const store = {
        appendQueryMemory: async (entries) => { log.push(...entries); return entries.length; },
        getQueryMemory: async () => log,
        getQueryMemoryByFingerprint: async (fp) => log.filter(e => e.fingerprint === fp),
      };
      const queryMemoryLog = qm.createQueryMemoryLog({ store });

      // The EXACT wiring main.js uses (recordMetricComputeInQueryMemory),
      // inlined against a detached host div instead of the real #metric-
      // query-memory-host id, since main.js's global $() isn't loaded here.
      const qmHost = document.createElement('div');
      document.body.appendChild(qmHost);
      async function recordMetricComputeInQueryMemory(run) {
        const { priorLookup } = await queryMemoryLog.record(
          { kind: qm.QUERY_KINDS.METRIC, text: run.expression, context: { tables: [run.table] } },
          'you',
          { label: run.expression.slice(0, 80) },
        );
        qmUi.renderQueryMemoryBadge({ host: qmHost, lookupResult: priorLookup });
      }

      // A fake engine — duck-typed runQuery, no real DuckDB needed to prove
      // the onMetricComputed hook fires and carries the real table+expression.
      const engine = { runQuery: async (sql) => ({ columns: ['value'], rows: [[42]] }) };
      const registry = new studio.MetricRegistry();
      const host = document.createElement('div');
      document.body.appendChild(host);

      studio.renderMetricStudio({
        host, registry, schemaCols: [{ name: 'a', type: 'DOUBLE' }, { name: 'b', type: 'DOUBLE' }],
        table: 'claims', engine,
        onToast: () => {},
        onMetricComputed: recordMetricComputeInQueryMemory,
      });

      async function saveOnce(name) {
        host.querySelector('[data-testid="metric-name"]').value = name;
        const expr = host.querySelector('[data-testid="metric-expr"]');
        expr.value = 'SUM(a) / NULLIF(SUM(b), 0)';
        expr.dispatchEvent(new Event('input', { bubbles: true }));
        host.querySelector('[data-testid="metric-save"]').click();
        await new Promise(r => setTimeout(r, 80));
        // metric-studio.js's own findDuplicates() correctly flags a second save
        // of the identical formula and shows a Merge/Keep-both prompt instead of
        // silently computing again -- real, existing, on-purpose behavior. This
        // test's whole point is a genuine SECOND RUN of the same formula, so it
        // takes the real "Keep both" path a user would click, exactly like
        // production; it does not bypass or disable that duplicate check.
        const keepBoth = host.querySelector('[data-testid="metric-dup-keepboth"]');
        if (keepBoth) { keepBoth.click(); await new Promise(r => setTimeout(r, 80)); }
      }

      await saveOnce('First Rate');
      const afterFirst = {
        logLen: log.length,
        firstKind: log[0] ? log[0].kind : null,
        firstAuthor: log[0] ? log[0].author : null,
        badgeSeenAfterFirst: (qmHost.querySelector('[data-testid="query-memory-badge"]') || {}).getAttribute
          ? qmHost.querySelector('[data-testid="query-memory-badge"]').getAttribute('data-seen') : null,
        badgeLabelAfterFirst: (qmHost.querySelector('[data-testid="query-memory-badge"] span:last-child') || {}).textContent || '',
      };

      // A second metric with a DIFFERENT name but the SAME formula against
      // the SAME table — Query Memory's fingerprint is over (kind, text,
      // tables/columns), not the human-facing metric name, so this must be
      // recognized as "seen before" exactly once.
      await saveOnce('Second Rate (same formula)');
      const afterSecond = {
        logLen: log.length,
        badgeSeenAfterSecond: qmHost.querySelector('[data-testid="query-memory-badge"]').getAttribute('data-seen'),
        badgeLabelAfterSecond: qmHost.querySelector('[data-testid="query-memory-badge"] span:last-child').textContent,
        metricCount: registry.size,
      };

      return { afterFirst, afterSecond };
    });

    ok(result.afterFirst.logLen === 1, 'first save: exactly one Query Memory entry recorded');
    ok(result.afterFirst.firstKind === 'metric', 'first save: the entry is labeled kind "metric"');
    ok(result.afterFirst.firstAuthor === 'you', 'first save: the entry carries the real author');
    ok(result.afterFirst.badgeSeenAfterFirst === 'false', 'first save: badge honestly reports "new query" (never seen before)');
    ok(/New query/.test(result.afterFirst.badgeLabelAfterFirst), 'first save: badge label reads "New query"');

    ok(result.afterSecond.logLen === 2, 'second save (same formula, different name): a second entry is appended, not merged away');
    ok(result.afterSecond.badgeSeenAfterSecond === 'true', 'second save: badge now reports seen:true — same expression/table fingerprint recognized');
    ok(/Seen before · once/.test(result.afterSecond.badgeLabelAfterSecond), 'second save: badge reads "Seen before · once" (this is the 2nd run, so PRIOR count was 1)');
    ok(result.afterSecond.metricCount === 2, 'second save: both metrics are still stored under their own distinct human names');
  } catch (err) {
    failed++;
    console.log('\n✗ FAILED: ' + (err && err.message ? err.message : err));
    console.log('  --- browser console ---');
    for (const line of consoleLines.slice(-30)) console.log('  ' + line);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed === 0 ? 'E2E QUERY-MEMORY-METRIC-STUDIO-UI: PASSED' : 'E2E QUERY-MEMORY-METRIC-STUDIO-UI: FAILED');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
