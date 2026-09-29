// ============================================================
// DATAGLOW — Cleaning Crew "Add to Glow Canvas" bridge test suite (Batch 4)
// ============================================================
// js/app-shell/tabs/cleaning-crew-tab.js renders its panel via raw innerHTML
// template strings (not the el() helper), so faking a real browser's HTML
// parser just to assert on a parsed button would require pulling in jsdom --
// which every other DOM-adjacent test file in this repo explicitly avoids
// (test/bench-shell.test.mjs, test/glow-canvas.test.mjs, test/e2e-smoke.test.mjs
// all say so directly). Runtime DOM behavior (does the button actually appear
// / actually call requestGlowCanvasPrefill + switchTab in a real browser) is
// covered by the Playwright/e2e path per the established convention, exactly
// like cleaning-crew-profiler.test.mjs's own "flag ships dark" block already
// does source-level assertions rather than DOM ones for the same file.
//
// This file proves, by reading the real shipped source:
//   - the bridge button is wired to BOTH requestGlowCanvasPrefill(ds.table)
//     AND switchTab('glowcanvas') on click (not just one or the other)
//   - the bridge is gated on isEnabled('glowCanvas'), not on the PDF gate
//     verdict (a human can chart page-count/page-length data regardless of
//     whether the AI-agent-trust gate passed)
//   - the bridge requires an actual ds.table before rendering the button
//     (no dead button pointing at an undefined table)
//   - cleaning-crew-tab.js imports requestGlowCanvasPrefill from
//     glow-canvas-tab.js (the real module, not a duplicate/parallel state path)
//   - main.js threads the real switchTab dispatcher into renderCleaningCrewTab,
//     the same pattern already used for join-builder-tab.js / nl-sql-tab.js
//
// RUN WITH: node test/cleaning-crew-glow-canvas-bridge.test.mjs

import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const crewSrc = readFileSync(new URL('../js/app-shell/tabs/cleaning-crew-tab.js', import.meta.url), 'utf8');
const mainSrc = readFileSync(new URL('../js/app-shell/main.js', import.meta.url), 'utf8');

// ---------- cleaning-crew-tab.js wiring ----------
{
  ok(crewSrc.includes("import { requestGlowCanvasPrefill } from './glow-canvas-tab.js';"),
    'cleaning-crew-tab.js imports the real requestGlowCanvasPrefill from glow-canvas-tab.js (no parallel/duplicate state)');

  ok(/export async function renderCleaningCrewTab\(\{[^}]*switchTab[^}]*\}\)/.test(crewSrc),
    'renderCleaningCrewTab accepts a switchTab callback (same pattern as join-builder-tab.js / nl-sql-tab.js)');

  ok(/renderCleaningCrewProfile\(profile,\s*ds,\s*switchTab\)/.test(crewSrc),
    'the upload handler forwards both the loaded dataset and switchTab into renderCleaningCrewProfile');

  // The bridge condition: an actual table to hand off AND the destination tab
  // being reachable. Must NOT be gated on gate.agentConsumable.
  ok(/const showBridge = !!\(ds && ds\.table\) && isEnabled\('glowCanvas'\)/.test(crewSrc),
    'the bridge button only renders when ds.table exists AND the glowCanvas flag is on');
  ok(!/showBridge[\s\S]{0,80}gate\.agentConsumable/.test(crewSrc),
    'the bridge is NOT additionally gated on gate.agentConsumable (a human can chart page metadata regardless of AI-agent trust verdict)');

  // The click handler must call BOTH halves of the handoff, not just one.
  const clickHandlerMatch = crewSrc.match(/addEventListener\('click', \(\) => \{([\s\S]*?)\}\);\s*\}\s*\}/);
  ok(!!clickHandlerMatch, 'the bridge button has a click handler');
  const handlerBody = clickHandlerMatch ? clickHandlerMatch[1] : '';
  ok(handlerBody.includes('requestGlowCanvasPrefill(ds.table)'),
    'the click handler calls requestGlowCanvasPrefill with the loaded dataset\'s table');
  ok(handlerBody.includes("switchTab('glowcanvas')"),
    'the click handler calls switchTab to actually navigate to Glow Canvas');
  // Order matters: the prefill must be requested BEFORE switching tabs, since
  // renderGlowCanvasTab() (triggered by the switch) is what consumes it.
  ok(
    handlerBody.indexOf('requestGlowCanvasPrefill') < handlerBody.indexOf("switchTab('glowcanvas')"),
    'requestGlowCanvasPrefill is called BEFORE switchTab, so the pending prefill exists when Glow Canvas renders'
  );

  ok(crewSrc.includes('data-testid="crew-to-glow-canvas"'),
    'the bridge button carries a stable data-testid for e2e/Playwright targeting');
}

// ---------- main.js wiring: the real switchTab dispatcher is threaded in ----------
{
  ok(mainSrc.includes("renderCleaningCrewTab({ ensureDuckDB, renderSidebar, iconSvg, switchTab });"),
    'main.js passes the real switchTab dispatcher into renderCleaningCrewTab (not a stub)');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
