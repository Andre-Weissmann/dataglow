// ============================================================
// DATAGLOW — Metric Contracts UI wiring test (Gen 44, activation)
// ============================================================
// A real-browser DOM/integration test for the wiring that activates Metric
// Contracts. Batches 1-3 unit-tested the pure logic (test:metriccontracts /
// test:metriccontractdiffview / test:metriccontractconfirmgate); their DOM
// presenters (renderDiffView / renderConfirmGate) and the Metric Studio
// onDefinitionSaved save-hook had no live caller until now. This test exercises
// exactly that newly-wired surface in a real DOM:
//
//   1. SAVE HOOK: renderMetricStudio's new onDefinitionSaved callback fires on a
//      real human "Create metric" click and — wired the exact way main.js wires
//      it — records a version in a MetricContractRegistry (source: 'human'). This
//      is the "recordVersion actually called on a real save, not just isolation"
//      proof.
//   2. HISTORY VIEW: renderDiffView(buildHistoryListContent(...)) renders the
//      real saved versions as an oldest-first timeline in the DOM.
//   3. DIFF VIEW: renderDiffView(buildDiffViewContent(...)) renders a real
//      before/after pair as a side-by-side field diff.
//   4. CONFIRM GATE (end-to-end, manual proposal): since NO AI proposer exists in
//      the app, a proposal is constructed here by hand via proposeContractChange
//      to prove the gate renders equal-weight Approve/Reject buttons and that
//      Approve (the sole write path) applies + records history + updates the live
//      metric, while Reject writes nothing. This does NOT fabricate a live "AI
//      proposes changes" feature — it only proves the gate the app wires works.
//
// WHY a real browser: the presenters build DOM via document.createElement (the
// shared `el` helper). No DuckDB/WASM is needed — with no engine/table passed,
// Metric Studio skips compute and still stores + fires the save hook — so this is
// robust headless. Modeled on test/pack-builder-ui.test.mjs: repo served on an
// origin, presenters driven on a DETACHED host div, the full app never boots.
//
// RUN WITH:  node test/metric-contracts-ui.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const TEST_PAGE = '/__metriccontracts_test__.html';

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

    // ---------- 1. Save hook records a version on a real Metric Studio create ----------
    const save = await page.evaluate(async () => {
      const studio = await import('/js/metrics/metric-studio.js');
      const contracts = await import('/js/metrics/metric-contracts.js');
      const registry = new studio.MetricRegistry();
      const contractRegistry = new contracts.MetricContractRegistry();
      const host = document.createElement('div');
      document.body.appendChild(host);

      const schemaCols = [{ name: 'readmissions', type: 'DOUBLE' }, { name: 'total_discharges', type: 'DOUBLE' }];
      studio.renderMetricStudio({
        host, registry, schemaCols, table: null, engine: null,
        onToast: () => {},
        // The EXACT wiring main.js uses (recordMetricDefinitionVersion), inlined.
        onDefinitionSaved: (metric, meta) => {
          contractRegistry.recordVersion(metric.id, metric, {
            changedBy: meta.changedBy || metric.owner || 'you',
            reason: meta.reason || '', source: 'human',
          });
        },
      });

      host.querySelector('[data-testid="metric-name"]').value = 'Readmission Rate';
      host.querySelector('[data-testid="metric-owner"]').value = 'andre';
      const expr = host.querySelector('[data-testid="metric-expr"]');
      expr.value = 'SUM(readmissions) / NULLIF(SUM(total_discharges), 0)';
      expr.dispatchEvent(new Event('input', { bubbles: true }));
      host.querySelector('[data-testid="metric-save"]').click();
      await new Promise(r => setTimeout(r, 60));

      const stored = registry.list()[0];
      const versions = stored ? contractRegistry.historyFor(stored.id).list() : [];
      return {
        metricCount: registry.size,
        contractSize: contractRegistry.size,
        versionCount: versions.length,
        firstSource: versions[0] ? versions[0].source : null,
        firstChangedBy: versions[0] ? versions[0].changedBy : null,
        firstExpr: versions[0] ? versions[0].snapshot.expression : null,
      };
    });
    ok(save.metricCount === 1, 'save: the metric is created in the Metric Studio registry');
    ok(save.versionCount === 1, 'save: creating a metric records exactly one contract version (recordVersion actually fired)');
    ok(save.firstSource === 'human', 'save: the recorded version is honestly labelled a human edit');
    ok(save.firstChangedBy === 'andre', 'save: the version carries the real owner as changedBy');
    ok(/total_discharges/.test(save.firstExpr || ''), 'save: the snapshot captures the real saved formula');

    // ---------- 2 & 3. History timeline + before/after diff render in the DOM ----------
    const render = await page.evaluate(async () => {
      const contracts = await import('/js/metrics/metric-contracts.js');
      const diffView = await import('/js/metrics/metric-contract-diff-view.js');
      const hist = new contracts.MetricContractHistory('readmission-rate');
      hist.recordVersion(
        { name: 'Readmission Rate', expression: 'SUM(readmissions) / NULLIF(SUM(discharges), 0)', owner: 'andre', tag: 'quality', plainEnglish: 'x' },
        { changedBy: 'andre', reason: 'initial definition', source: 'human' });
      hist.recordVersion(
        { name: 'Readmission Rate', expression: 'SUM(readmissions) / NULLIF(SUM(total_discharges), 0)', owner: 'andre', tag: 'quality', plainEnglish: 'x' },
        { changedBy: 'andre', reason: 'fixed column name', source: 'human' });

      const histHost = document.createElement('div');
      document.body.appendChild(histHost);
      diffView.renderDiffView({ host: histHost, content: diffView.buildHistoryListContent({ metricName: 'Readmission Rate', versions: hist.list() }) });

      const diffHost = document.createElement('div');
      document.body.appendChild(diffHost);
      diffView.renderDiffView({ host: diffHost, content: diffView.buildDiffViewContent({ metricName: 'Readmission Rate', before: hist.get(1), after: hist.get(2) }) });

      return {
        histSubtitle: histHost.querySelector('[data-testid="diff-subtitle"]').textContent,
        histItems: histHost.querySelectorAll('li').length,
        histFirst: (histHost.querySelector('li') || {}).textContent || '',
        diffTitle: diffHost.querySelector('[data-testid="diff-title"]').textContent,
        fieldRows: diffHost.querySelectorAll('[data-testid="diff-field-row"]').length,
        changedField: (diffHost.querySelector('[data-testid="diff-field-row"]') || {}).getAttribute ? diffHost.querySelector('[data-testid="diff-field-row"]').getAttribute('data-field') : null,
        beforeText: (diffHost.querySelector('[data-testid="diff-before"]') || {}).textContent || '',
        afterText: (diffHost.querySelector('[data-testid="diff-after"]') || {}).textContent || '',
      };
    });
    ok(render.histSubtitle === '2 versions recorded', 'history: the DOM timeline reports the real recorded version count');
    ok(render.histItems === 2, 'history: one list row per recorded version renders');
    ok(/^v1 —/.test(render.histFirst) && /andre/.test(render.histFirst), 'history: oldest version first, with its real author');
    ok(render.diffTitle === 'Readmission Rate', 'diff: the DOM diff view titles with the real metric name');
    ok(render.fieldRows === 1 && render.changedField === 'expression', 'diff: exactly the changed field (expression) renders as a diff row');
    ok(/discharges/.test(render.beforeText) && /total_discharges/.test(render.afterText), 'diff: before/after cells show the real old/new formula');

    // ---------- 4. Confirm gate end-to-end (manual proposal, no AI proposer) ----------
    const gate = await page.evaluate(async () => {
      const contracts = await import('/js/metrics/metric-contracts.js');
      const cg = await import('/js/metrics/metric-contract-confirm-gate.js');
      const contractRegistry = new contracts.MetricContractRegistry();
      // A minimal live metric registry (duck-typed: approve() needs update(id, patch)).
      const store = new Map([['m1', { id: 'm1', name: 'Churn', expression: 'a/b', owner: 'alice', tag: 'growth', plainEnglish: 'churn rate' }]]);
      const metricRegistry = { update(id, patch) { const n = { ...store.get(id), ...patch, id }; store.set(id, n); return n; }, get: id => store.get(id) };

      // APPROVE path.
      const proposal = cg.proposeContractChange({
        metricId: 'm1', currentMetric: store.get('m1'),
        candidate: { name: 'Churn', expression: 'a/b*100', owner: 'alice', tag: 'growth', plainEnglish: 'churn rate as a percent' },
        proposedBy: 'metric-copilot', reason: 'Normalize to a percentage.',
      });
      const host = document.createElement('div');
      document.body.appendChild(host);
      let decisions = 0;
      cg.renderConfirmGate({ host, proposal, metricName: 'Churn', contractRegistry, metricRegistry, onDecision: () => { decisions++; } });

      const approveBtn = host.querySelector('[data-testid="confirm-gate-approve"]');
      const rejectBtn = host.querySelector('[data-testid="confirm-gate-reject"]');
      const equalWeight = !!(approveBtn && rejectBtn) && approveBtn.className === rejectBtn.className;
      const hasDiff = !!host.querySelector('[data-testid="confirm-gate-diff"]');
      approveBtn.click();
      const statusAfterApprove = (host.querySelector('[data-testid="confirm-gate-status"]') || {}).textContent || '';
      const historyAfterApprove = contractRegistry.historyFor('m1').list();

      // REJECT path (a fresh proposal — reading/rendering never mutates).
      const proposal2 = cg.proposeContractChange({
        metricId: 'm1', currentMetric: store.get('m1'),
        candidate: { name: 'Churn', expression: 'a/b/2', owner: 'alice', tag: 'growth', plainEnglish: 'halved' },
        proposedBy: 'metric-copilot', reason: 'test reject',
      });
      const host2 = document.createElement('div');
      document.body.appendChild(host2);
      cg.renderConfirmGate({ host: host2, proposal: proposal2, metricName: 'Churn', contractRegistry, metricRegistry, onDecision: () => {} });
      host2.querySelector('[data-testid="confirm-gate-reject"]').click();
      const statusAfterReject = (host2.querySelector('[data-testid="confirm-gate-status"]') || {}).textContent || '';

      return {
        equalWeight, hasDiff, decisions,
        statusAfterApprove,
        appliedStatus: proposal.status,
        historyLen: historyAfterApprove.length,
        historySource: historyAfterApprove[0] ? historyAfterApprove[0].source : null,
        liveExpr: store.get('m1').expression,
        statusAfterReject,
        rejectHistoryLen: contractRegistry.historyFor('m1').list().length, // still 1 — reject writes nothing
      };
    });
    ok(gate.hasDiff, 'gate: the pending proposal renders the Batch 2 diff view');
    ok(gate.equalWeight, 'gate: Approve and Reject are equal-weight (identical class — never nudge toward accept)');
    ok(/Applied/.test(gate.statusAfterApprove) && gate.appliedStatus === 'applied', 'gate: clicking Approve moves the proposal to applied');
    ok(gate.historyLen === 1 && gate.historySource === 'agent-proposed', 'gate: Approve records exactly one agent-proposed contract version');
    ok(gate.liveExpr === 'a/b*100', 'gate: Approve applies the candidate to the live metric definition');
    ok(gate.decisions === 1, 'gate: the onDecision callback fires exactly once per decision');
    ok(/Rejected/.test(gate.statusAfterReject), 'gate: clicking Reject moves the proposal to rejected');
    ok(gate.rejectHistoryLen === 1, 'gate: Reject writes nothing (history still holds only the earlier approved version)');
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
  console.log(failed === 0 ? 'E2E METRIC-CONTRACTS-UI: PASSED' : 'E2E METRIC-CONTRACTS-UI: FAILED');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
