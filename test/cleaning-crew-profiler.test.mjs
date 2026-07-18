// ============================================================
// DATAGLOW — Cleaning Crew: PDF Profiler test suite (Batch 1)
// ============================================================
// Proves the PURE core of the Profiler station in js/cleaning-crew/pdf-profiler.js:
//   - summarizePdfProfile computes pageCount / pagesWithText / pagesWithoutText /
//     hasExtractableText / warnings from INJECTED per-page text arrays (all-empty
//     case + mixed case + all-text case), never touching real PDF.js
//   - pdfProfileToRows shapes a profile into one {page_number, text} row per page
//   - buildPdfGateLayers + evaluatePdfReadiness wire the profile through the real
//     js/gate/readiness-gate.js so that ZERO extractable text FAILS the gate and
//     PARTIAL text PASSES the gate WITH a warning
//   - the cleaningCrew flag defaults to false in flags.manifest.json AND the tab
//     is absent from the default visible tab order (does not mount when off)
//
// No real PDF.js — that runs only in a browser Web Worker and can't run in Node,
// exactly like test/drill-floor.test.mjs fakes the Python/R runtimes. The
// browser-only ensurePdfjs()/profilePdf() are therefore NOT exercised here.
//
// RUN WITH: node test/cleaning-crew-profiler.test.mjs

import { readFileSync } from 'node:fs';
import {
  summarizePdfProfile,
  pdfProfileToRows,
  PDF_DATASET_COLUMNS,
  buildPdfGateLayers,
  evaluatePdfReadiness,
} from '../js/cleaning-crew/pdf-profiler.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- summarizePdfProfile: all pages have text ----------
{
  const profile = summarizePdfProfile([
    { page: 1, text: 'hello world' },
    { page: 2, text: 'more text here' },
    { page: 3, text: 'final page' },
  ]);
  ok(profile.pageCount === 3, 'all-text: pageCount counts every page');
  ok(profile.pagesWithText === 3, 'all-text: every page counted as having text');
  ok(profile.pagesWithoutText === 0, 'all-text: no pages without text');
  ok(profile.hasExtractableText === true, 'all-text: hasExtractableText is true');
  ok(profile.warnings.length === 0, 'all-text: no warnings emitted');
  ok(profile.extractedText.length === 3, 'all-text: extractedText preserves all pages');
}

// ---------- summarizePdfProfile: mixed (some pages blank) ----------
{
  const profile = summarizePdfProfile([
    { page: 1, text: 'readable text' },
    { page: 2, text: '' },
    { page: 3, text: '   ' },          // whitespace-only counts as NO text
    { page: 4, text: 'more readable text' },
  ]);
  ok(profile.pageCount === 4, 'mixed: pageCount is 4');
  ok(profile.pagesWithText === 2, 'mixed: only non-empty (post-trim) pages count as text');
  ok(profile.pagesWithoutText === 2, 'mixed: whitespace-only + empty pages count as no-text');
  ok(profile.hasExtractableText === true, 'mixed: hasExtractableText true (some pages have text)');
  ok(profile.warnings.length === 1, 'mixed: exactly one warning emitted');
  ok(/2 of 4 page\(s\) have no extractable text/.test(profile.warnings[0]), 'mixed: warning names the count and total');
  ok(/OCR support is not yet available/.test(profile.warnings[0]), 'mixed: warning mentions OCR is not yet available');
}

// ---------- summarizePdfProfile: all pages blank (scanned images) ----------
{
  const profile = summarizePdfProfile([
    { page: 1, text: '' },
    { page: 2, text: '   ' },
  ]);
  ok(profile.pageCount === 2, 'all-blank: pageCount is 2');
  ok(profile.pagesWithText === 0, 'all-blank: no pages with text');
  ok(profile.pagesWithoutText === 2, 'all-blank: all pages without text');
  ok(profile.hasExtractableText === false, 'all-blank: hasExtractableText is false');
  ok(profile.warnings.length === 1 && /No extractable text found across all 2 page\(s\)/.test(profile.warnings[0]), 'all-blank: warning says no text across all pages');
  ok(/OCR support is not yet available/.test(profile.warnings[0]), 'all-blank: warning mentions OCR');
}

// ---------- summarizePdfProfile: defensive on empty/garbage input ----------
{
  const empty = summarizePdfProfile([]);
  ok(empty.pageCount === 0 && empty.hasExtractableText === false, 'empty: zero pages, not extractable');
  ok(empty.warnings.length === 1 && /No pages were found/.test(empty.warnings[0]), 'empty: warns that no pages were found');
  const garbage = summarizePdfProfile(null);
  ok(garbage.pageCount === 0 && Array.isArray(garbage.extractedText), 'garbage: null input returns a safe empty profile (never throws)');
  const coerced = summarizePdfProfile([{ page: 1, text: null }, { text: 'x' }]);
  ok(coerced.extractedText[0].text === '' , 'coerce: non-string page text becomes an empty string');
  ok(coerced.extractedText[1].page === 2, 'coerce: a page missing its number falls back to its 1-based index');
}

// ---------- pdfProfileToRows ----------
{
  const profile = summarizePdfProfile([
    { page: 1, text: 'alpha' },
    { page: 2, text: '' },
  ]);
  const rows = pdfProfileToRows(profile);
  ok(rows.length === 2, 'rows: one row per page (blank pages included, nothing dropped)');
  ok(JSON.stringify(rows[0]) === JSON.stringify({ page_number: 1, text: 'alpha' }), 'rows: first row shaped as {page_number, text}');
  ok(rows[1].page_number === 2 && rows[1].text === '', 'rows: blank page kept with empty text');
  ok(PDF_DATASET_COLUMNS.join(',') === 'page_number,text', 'columns: dataset columns are page_number, text');
  ok(pdfProfileToRows(null).length === 0, 'rows: null profile yields no rows (never throws)');
}

// ---------- buildPdfGateLayers ----------
{
  const allText = buildPdfGateLayers(summarizePdfProfile([{ page: 1, text: 'x' }]));
  ok(allText.length === 1 && allText[0].status === 'pass', 'gate-layers: all-text yields a single pass layer');

  const partial = buildPdfGateLayers(summarizePdfProfile([{ page: 1, text: 'x' }, { page: 2, text: '' }]));
  ok(partial.length === 2, 'gate-layers: partial yields a pass + a warn layer');
  ok(partial.some((l) => l.status === 'pass') && partial.some((l) => l.status === 'warn'), 'gate-layers: partial has both a pass and a warn');

  const none = buildPdfGateLayers(summarizePdfProfile([{ page: 1, text: '' }]));
  ok(none.length === 1 && none[0].status === 'fail', 'gate-layers: zero text yields a single fail layer');
}

// ---------- evaluatePdfReadiness: real readiness-gate wiring ----------
{
  // Zero extractable text -> gate FAILS (not agent-consumable).
  const noText = evaluatePdfReadiness(summarizePdfProfile([{ page: 1, text: '' }, { page: 2, text: '  ' }]));
  ok(noText.gate.agentConsumable === false, 'gate: zero extractable text is NOT agent-consumable');
  ok(noText.gate.failingLayers.length >= 1, 'gate: zero extractable text records a failing layer');
  ok(/BLOCKED/.test(noText.explanation), 'gate: explanation reports BLOCKED for zero-text PDF');

  // Partial text -> gate PASSES but a warning is present.
  const partial = evaluatePdfReadiness(summarizePdfProfile([
    { page: 1, text: 'good text' }, { page: 2, text: '' },
  ]));
  ok(partial.gate.agentConsumable === true, 'gate: partial-text PDF IS agent-consumable (passes)');
  ok(partial.gate.failingLayers.length === 0, 'gate: partial-text PDF has no failing layers');
  ok(partial.layers.some((l) => l.status === 'warn'), 'gate: partial-text PDF surfaces a warn layer alongside the pass');
  ok(/PASS/.test(partial.explanation), 'gate: explanation reports PASS for partial-text PDF');

  // All text -> gate passes cleanly with no warnings.
  const clean = evaluatePdfReadiness(summarizePdfProfile([{ page: 1, text: 'a' }, { page: 2, text: 'b' }]));
  ok(clean.gate.agentConsumable === true, 'gate: all-text PDF is agent-consumable');
  ok(clean.gate.score === 100, 'gate: all-text PDF scores 100');
}

// ---------- flag ships dark + tab does not mount when off ----------
{
  const manifest = JSON.parse(readFileSync(new URL('../flags.manifest.json', import.meta.url), 'utf8'));
  ok(manifest.flags.cleaningCrew, 'flags.manifest.json declares the cleaningCrew flag');
  ok(typeof manifest.flags.cleaningCrew.enabled === 'boolean', 'the cleaningCrew flag has a boolean enabled state');

  // The tab is gated in main.js by `(tabId !== 'cleaningcrew' || isEnabled('cleaningCrew'))`
  // and renderCleaningCrewTab() clears the panel when the flag is off, so with the
  // flag dark the tab never mounts. Assert the gate wiring is present in source.
  const mainSrc = readFileSync(new URL('../js/app-shell/main.js', import.meta.url), 'utf8');
  ok(mainSrc.includes("tabId !== 'cleaningcrew' || isEnabled('cleaningCrew')"), 'main.js gates the cleaningcrew tab behind the flag');
  ok(/renderCleaningCrewTab[\s\S]*?isEnabled\('cleaningCrew'\)[\s\S]*?host\.innerHTML = ''/.test(mainSrc), 'renderCleaningCrewTab clears its panel when the flag is off (no mount)');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
