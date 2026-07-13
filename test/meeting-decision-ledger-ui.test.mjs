// ============================================================
// DATAGLOW — Meeting Decision Ledger UI wiring test (Gen 43, Part 3)
// ============================================================
// A real-browser DOM/integration test for the ledger presenter
// (js/agents/meeting-decision-ledger-ui.js). Mirrors
// test/meeting-scribe-ui.test.mjs exactly: same detached-host approach, same
// shouldOffer*() gate pattern, same same-origin static file server so
// ES-module imports resolve. Uses an in-memory fake store (not real
// IndexedDB) so this test never depends on a browser storage engine being
// available in the headless runner — exactly like test/meeting-decision-
// ledger.test.mjs's fake for the pure-logic layer.
//
// Asserts:
//   GATE: shouldOfferDecisionLedger() is false with the flag off, true with
//     it on.
//   SAVE FLOW: analyzing a transcript in the sibling Meeting Scribe screen,
//     then clicking [Save this meeting to ledger] in the Decision Ledger
//     section, persists exactly the noteworthy entries via the injected
//     store and they show up in the browse list.
//   EMPTY SAVE: clicking Save before anything has been analyzed is a
//     no-op — no entries written, a toast warning fires, no crash.
//   FILTERS: the chart filter narrows the visible list correctly.
//   CLEAR: clicking Clear (with the confirm dialog auto-accepted) empties
//     the store and the list goes back to the empty state.
//
// RUN WITH:  node test/meeting-decision-ledger-ui.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const TEST_PAGE = '/__decisionledger_test__.html';

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
  // Auto-accept any window.confirm() dialog (used by the Clear button).
  page.on('dialog', (d) => d.accept());
  const consoleLines = [];
  page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));

  try {
    await page.goto(baseUrl + TEST_PAGE, { waitUntil: 'domcontentloaded' });

    // ---------- 1. Pure gate ----------
    const gate = await page.evaluate(async () => {
      const m = await import('/js/agents/meeting-decision-ledger-ui.js');
      return {
        off: m.shouldOfferDecisionLedger({ enabled: false }),
        on: m.shouldOfferDecisionLedger({ enabled: true }),
      };
    });
    ok(gate.off === false, 'gate: flag OFF → do not offer');
    ok(gate.on === true, 'gate: flag ON → offer');

    // ---------- 2. Save flow: analyze a transcript, then save to ledger ----------
    const saveFlow = await page.evaluate(async () => {
      const scribeUi = await import('/js/agents/meeting-scribe-ui.js');
      const ledgerUi = await import('/js/agents/meeting-decision-ledger-ui.js');

      // Tiny in-memory fake store — mirrors js/learning/memory-store.js's
      // appendLedgerEntries/getLedgerEntries/clearLedgerEntries contract.
      window.__fakeEntries = [];
      const store = {
        async appendLedgerEntries(list) { window.__fakeEntries = window.__fakeEntries.concat(list); return list.length; },
        async getLedgerEntries() { return window.__fakeEntries.slice(); },
        async clearLedgerEntries() { window.__fakeEntries = []; },
      };

      const scribeHost = document.createElement('div');
      document.body.appendChild(scribeHost);
      const scribeHandle = scribeUi.mountMeetingScribe({ host: scribeHost, onToast: () => {} });

      const textarea = scribeHost.querySelector('[data-testid="meeting-scribe-transcript"]');
      textarea.value = 'Why did this drop in March?\nCan you also pull the regional breakdown?\nEverything else looked fine.';
      scribeHost.querySelector('[data-testid="meeting-scribe-btn-analyze"]').click();

      const toasts = [];
      const ledgerHost = document.createElement('div');
      document.body.appendChild(ledgerHost);
      ledgerUi.mountDecisionLedger({
        host: ledgerHost,
        store,
        getCurrentMeeting: () => scribeHandle.getState(),
        onToast: (msg) => toasts.push(msg),
      });

      ledgerHost.querySelector('[data-testid="decision-ledger-btn-save"]').click();
      // Allow the async save + refresh to settle.
      await new Promise((r) => setTimeout(r, 50));

      const listText = ledgerHost.querySelector('[data-testid="decision-ledger-list"]').textContent;
      return {
        storedCount: window.__fakeEntries.length,
        toasts,
        listText,
        entryLis: ledgerHost.querySelectorAll('[data-testid="decision-ledger-entries"] li').length,
      };
    });
    ok(saveFlow.storedCount === 2, 'save: exactly the pushback + data-request entries are written (the plain line is excluded)');
    ok(saveFlow.toasts.some((t) => /Saved 2/.test(t)), 'save: a confirmation toast reports the count saved');
    ok(saveFlow.entryLis === 2, 'save: the browse list shows exactly the 2 saved entries');
    ok(/drop in March/.test(saveFlow.listText), 'save: the pushback entry\'s original text appears in the list');
    ok(/regional breakdown/.test(saveFlow.listText), 'save: the data-request entry\'s original text appears in the list');

    // ---------- 3. Empty save is a no-op ----------
    const emptySave = await page.evaluate(async () => {
      const scribeUi = await import('/js/agents/meeting-scribe-ui.js');
      const ledgerUi = await import('/js/agents/meeting-decision-ledger-ui.js');
      window.__fakeEntries2 = [];
      const store = {
        async appendLedgerEntries(list) { window.__fakeEntries2 = window.__fakeEntries2.concat(list); return list.length; },
        async getLedgerEntries() { return window.__fakeEntries2.slice(); },
        async clearLedgerEntries() { window.__fakeEntries2 = []; },
      };
      const scribeHost = document.createElement('div');
      document.body.appendChild(scribeHost);
      const scribeHandle = scribeUi.mountMeetingScribe({ host: scribeHost, onToast: () => {} }); // nothing analyzed

      const toasts = [];
      const ledgerHost = document.createElement('div');
      document.body.appendChild(ledgerHost);
      ledgerUi.mountDecisionLedger({
        host: ledgerHost, store, getCurrentMeeting: () => scribeHandle.getState(), onToast: (m) => toasts.push(m),
      });
      ledgerHost.querySelector('[data-testid="decision-ledger-btn-save"]').click();
      await new Promise((r) => setTimeout(r, 30));
      return { storedCount: window.__fakeEntries2.length, toasts };
    });
    ok(emptySave.storedCount === 0, 'empty save: nothing is written when no transcript has been analyzed');
    ok(emptySave.toasts.some((t) => /Nothing analyzed/.test(t)), 'empty save: a warning toast explains why nothing was saved (no crash)');

    // ---------- 4. Filter by chart narrows the list ----------
    const filterFlow = await page.evaluate(async () => {
      const ledgerUi = await import('/js/agents/meeting-decision-ledger-ui.js');
      const preSeeded = [
        { sourceKey: 'a', kind: 'pushback', meetingId: 'm1', text: 'Why did X drop?', ts: 10, context: { chart: 'chart-a', queryLabel: null }, matched: 'why did', status: null, actionFields: null, recordedAt: 1 },
        { sourceKey: 'b', kind: 'dataRequest', meetingId: 'm1', text: 'Pull the other breakdown', ts: 20, context: { chart: 'chart-b', queryLabel: null }, matched: 'pull', status: null, actionFields: null, recordedAt: 2 },
      ];
      const store = {
        async appendLedgerEntries() { return 0; },
        async getLedgerEntries() { return preSeeded.slice(); },
        async clearLedgerEntries() {},
      };
      const host = document.createElement('div');
      document.body.appendChild(host);
      ledgerUi.mountDecisionLedger({ host, store, getCurrentMeeting: () => null, onToast: () => {} });
      await new Promise((r) => setTimeout(r, 30));
      const before = host.querySelectorAll('[data-testid="decision-ledger-entries"] li').length;
      const select = host.querySelector('[data-testid="decision-ledger-filter-chart"]');
      select.value = 'chart-a';
      select.dispatchEvent(new Event('change'));
      const after = host.querySelectorAll('[data-testid="decision-ledger-entries"] li').length;
      return { before, after };
    });
    ok(filterFlow.before === 2, 'filter: both seeded entries show with no filter applied');
    ok(filterFlow.after === 1, 'filter: selecting a specific chart narrows the list to just that chart\'s entry');

    // ---------- 5. Clear empties the store and the list ----------
    const clearFlow = await page.evaluate(async () => {
      const ledgerUi = await import('/js/agents/meeting-decision-ledger-ui.js');
      let backing = [
        { sourceKey: 'a', kind: 'note', meetingId: 'm1', text: 'Something', ts: 1, context: null, matched: null, status: null, actionFields: null, recordedAt: 1 },
      ];
      const store = {
        async appendLedgerEntries(list) { backing = backing.concat(list); return list.length; },
        async getLedgerEntries() { return backing.slice(); },
        async clearLedgerEntries() { backing = []; },
      };
      const host = document.createElement('div');
      document.body.appendChild(host);
      ledgerUi.mountDecisionLedger({ host, store, getCurrentMeeting: () => null, onToast: () => {} });
      await new Promise((r) => setTimeout(r, 30));
      const beforeEmpty = !!host.querySelector('[data-testid="decision-ledger-empty"]');
      host.querySelector('[data-testid="decision-ledger-btn-clear"]').click();
      await new Promise((r) => setTimeout(r, 30));
      const afterEmpty = !!host.querySelector('[data-testid="decision-ledger-empty"]');
      return { beforeEmpty, afterEmpty, backingLength: backing.length };
    });
    ok(clearFlow.beforeEmpty === false, 'clear: the list shows entries before clearing');
    ok(clearFlow.afterEmpty === true, 'clear: the empty state returns after clearing');
    ok(clearFlow.backingLength === 0, 'clear: the injected store itself is emptied');

    // ---------- 6. Re-check → save → browse: the resolution rides into the ledger ----------
    // Analyze a transcript with a pushback line, click its on-device "Re-check
    // this number" button, wait for the deterministic Step-C resolver to
    // finish, THEN save to the ledger and confirm the browsed pushback entry
    // shows the re-check outcome (Part D rendering) — proving the resolution
    // flowed segment → getState() → buildLedgerEntriesFromMeeting → entry → UI.
    const recheckFlow = await page.evaluate(async () => {
      const scribeUi = await import('/js/agents/meeting-scribe-ui.js');
      const ledgerUi = await import('/js/agents/meeting-decision-ledger-ui.js');
      window.__recheckEntries = [];
      const store = {
        async appendLedgerEntries(list) { window.__recheckEntries = window.__recheckEntries.concat(list); return list.length; },
        async getLedgerEntries() { return window.__recheckEntries.slice(); },
        async clearLedgerEntries() { window.__recheckEntries = []; },
      };

      const scribeHost = document.createElement('div');
      document.body.appendChild(scribeHost);
      const scribeHandle = scribeUi.mountMeetingScribe({ host: scribeHost, onToast: () => {} });
      const textarea = scribeHost.querySelector('[data-testid="meeting-scribe-transcript"]');
      textarea.value = 'Why did this drop in March?';
      scribeHost.querySelector('[data-testid="meeting-scribe-btn-analyze"]').click();

      // Click the first pushback's re-check button and wait for the suggestion
      // to render (the resolution is attached to the segment before render).
      scribeHost.querySelector('[data-testid="meeting-scribe-recheck-0"]').click();
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline
        && !scribeHost.querySelector('[data-testid="meeting-scribe-recheck-suggestion"]')) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const stateHasRecheck = !!(scribeHandle.getState().taggedSegments
        .find((s) => s.pushback && s.pushback.isPushback && s.recheckResolution));

      const ledgerHost = document.createElement('div');
      document.body.appendChild(ledgerHost);
      ledgerUi.mountDecisionLedger({
        host: ledgerHost, store, getCurrentMeeting: () => scribeHandle.getState(), onToast: () => {},
      });
      ledgerHost.querySelector('[data-testid="decision-ledger-btn-save"]').click();
      await new Promise((r) => setTimeout(r, 60));

      const stored = window.__recheckEntries.find((e) => e.kind === 'pushback');
      return {
        stateHasRecheck,
        storedHasRecheck: !!(stored && stored.recheckResolution && stored.recheckResolution.suggestion),
        recheckLineText: ledgerHost.querySelector('[data-testid="decision-ledger-recheck"]')?.textContent || '',
      };
    });
    ok(recheckFlow.stateHasRecheck === true, 're-check: getState() exposes the resolution attached to the real tagged segment');
    ok(recheckFlow.storedHasRecheck === true, 're-check: the saved pushback ledger entry carries the sanitized recheckResolution');
    ok(/Re-checked:/.test(recheckFlow.recheckLineText), 're-check: the browse list renders the re-check outcome line (Part D)');
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
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
