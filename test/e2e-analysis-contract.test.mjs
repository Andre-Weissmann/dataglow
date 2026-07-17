// ============================================================
// DATAGLOW — Analysis Contract live-catalog e2e regression (M1)
// ============================================================
// Reproduces the M1 bug in a real browser: the Local Analysis Contract used to
// build its "which columns really exist" set only from file-loaded datasets
// (state.datasets), so a query against a table created inside DuckDB (CREATE
// TABLE ... AS, or a Python/R-bridged frame) had every column false-flagged as
// a hard-fail "hallucinated reference". The fix also sources the live DuckDB
// catalog, so those columns are recognized as real.
//
// This test drives the real SQL tab: it CREATE-TABLEs a table (which never
// enters state.datasets), then runs an aggregate over that table's REAL columns
// and asserts the contract card renders a non-hallucination guard-clause note
// (proving the contract both ran AND resolved the table's real schema via the
// live catalog) with NO "hallucinated" flag. Pre-fix, that same query
// false-flagged the table and its columns as hallucinated. The
// true-positive-preserved and empty-schema-guard cases are covered as pure unit
// tests in test/analysis-contract.test.mjs (a real DuckDB query with a
// genuinely nonexistent column errors at bind time and never reaches the
// contract, so it cannot be exercised in-browser).
//
// Same real-browser rationale + headless caveat as e2e-smoke.test.mjs.
// RUN WITH:  node test/e2e-analysis-contract.test.mjs

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

// Runs one SQL statement through the real SQL tab and resolves once the result
// (or an error card) has rendered. The Analysis Contract renders afterwards in
// a fire-and-forget .then(), so callers add a short settle before inspecting it.
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

// The Analysis Contract card is rendered in a fire-and-forget .then() after the
// result table, and now performs extra live-catalog lookups, so poll for it
// rather than sleeping a fixed interval. Returns the card's text once present.
async function waitForContractCard(page) {
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="analysis-contract-card"]'),
    { timeout: 20000, polling: 250 }
  );
  return page.evaluate(() => document.querySelector('[data-testid="analysis-contract-card"]').textContent);
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

    await page.click('[data-testid="tab-sql"]');

    // Create a table entirely inside DuckDB — it never enters state.datasets.
    // The is_test_account column is a guard-hint column: an aggregate query that
    // doesn't reference it produces a (non-hallucination) guard-clause note, so
    // the contract card reliably renders and we can wait for it deterministically.
    await runSql(page, 'CREATE TABLE dg_m1_foo AS SELECT 1 AS amount, 2 AS quantity, false AS is_test_account;');
    console.log('✓ created dg_m1_foo via CREATE TABLE (not through the file loader)');

    // The contract card MUST render here: is_test_account is a guard-hint
    // column the query never references, so a (non-hallucination) guard-clause
    // note fires. That makes the two assertions below jointly decisive:
    //   • Pre-fix, this query flagged "amount"/"dg_m1_foo" as hallucinated
    //     because neither is in state.datasets — assertion 1 would fail.
    //   • The guard-clause note can only appear if the table's real schema was
    //     resolved (via the live catalog); if the fix regressed to only the
    //     empty-schema guard, the card would carry the "no schema available"
    //     note instead — assertion 2 would fail.
    await runSql(page, 'SELECT SUM(amount) AS total FROM dg_m1_foo;');
    const realText = await waitForContractCard(page);
    ok(!/hallucinat/i.test(realText),
      'real columns of a CREATE TABLE-created table are NOT flagged as hallucinated (M1 fixed)');
    ok(/never references it/i.test(realText),
      'the contract resolved the table via the live catalog (guard-clause note present, not the empty-schema fallback)');

    // Stale-generation regression (2026-07-17): a slow first query's
    // buildLiveSchemaForContract().then() callback must never fire after a
    // second query has already started and re-rendered #sql-result-wrap —
    // pre-fix, this raced intermittently (~1 in 10 real-Chrome runs) and hung
    // waiting for a contract card that got stomped by the stale callback.
    // Fire two queries back-to-back with no settle between the click calls
    // (skipping runSql's own settle-wait) to maximize the chance of
    // reproducing the race if it regresses.
    // Both queries must aggregate (checkMissingGuardClauses only fires on
    // aggregate SELECTs), so the guard-clause note reliably produces a
    // non-empty report and the card renders after each query.
    await page.fill('#sql-input', 'SELECT SUM(amount) AS a FROM dg_m1_foo;');
    await page.click('#btn-sql-run');
    await page.fill('#sql-input', 'SELECT SUM(quantity) AS q FROM dg_m1_foo;');
    await page.click('#btn-sql-run');
    const raceText = await waitForContractCard(page);
    ok(!/hallucinat/i.test(raceText),
      'rapid-fire second query still renders a clean contract card (no stale-callback corruption)');
    const statusAfterRace = await page.evaluate(() => document.querySelector('#sql-status')?.textContent || '');
    ok(/row\(s\)/i.test(statusAfterRace),
      'sql-status reflects the second (latest) query, not a stale first-query state');
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
  console.log(failed ? 'E2E ANALYSIS-CONTRACT: FAILED' : 'E2E ANALYSIS-CONTRACT: PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — e2e run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
