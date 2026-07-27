// ============================================================
// DATAGLOW - R3/R4 Capture + Ship pack contract test
// ============================================================
// Proves R3_R4_CAPTURE_SHIP_SPEC.md's acceptance the way a plain Node script
// can: no browser, no DOM, no IndexedDB, no GPU. Two kinds of checks:
//
//   1. Direct import of the two pure engines
//      (js/capture/capture.js, js/ship-pack/ship-pack.js) to exercise the
//      fixed step list, filename building, capture record shape, and the
//      keepers/claims/validation-summary/honest-claims builders -- all
//      pure/deterministic.
//   2. String/regex checks against canvas/index.html (AUTHORITATIVE) to
//      confirm both canvas UI modules are actually inlined, gated behind the
//      captureShipPack flag, never make a network call, and never emit an
//      em dash in visible UI strings.
//
// RUN WITH: node test/r3-r4-capture-ship-pack.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Capture from '../js/capture/capture.js';
import * as ShipPack from '../js/ship-pack/ship-pack.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CANVAS = join(repoRoot, 'canvas', 'index.html');
const canvas = readFileSync(CANVAS, 'utf8');
const captureCanvasSrc = readFileSync(join(repoRoot, 'js', 'capture', 'data-glow-capture-canvas.js'), 'utf8');
const shipPackCanvasSrc = readFileSync(join(repoRoot, 'js', 'ship-pack', 'data-glow-ship-pack-canvas.js'), 'utf8');
const flagsManifest = JSON.parse(readFileSync(join(repoRoot, 'flags.manifest.json'), 'utf8'));

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL  ${msg}`);
  }
}

// ------------------------------------------------------------
// 1. R3 capture.js - fixed step list + filenames
// ------------------------------------------------------------
ok(Capture.CAPTURE_STEPS.length === 7, 'CAPTURE_STEPS has exactly 7 steps (SPEC order)');
ok(
  Capture.CAPTURE_STEPS.join(',') === 'home,loaded,validate,scout,prove,narrative,export',
  'CAPTURE_STEPS matches the SPEC order verbatim: home, loaded, validate, scout, prove, narrative, export',
);

const fixedDate = new Date(2026, 6, 27, 5, 38, 9); // 2026-07-27 05:38:09 local
ok(Capture.timestampStamp(fixedDate) === '20260727-053809', 'timestampStamp() formats YYYYMMDD-HHMMSS deterministically');

ok(Capture.normalizeStep('validate').step === 'validate', 'normalizeStep() recognizes a fixed step');
ok(Capture.normalizeStep('VALIDATE').step === 'validate', 'normalizeStep() is case-insensitive');
ok(Capture.normalizeStep('something-else').step === Capture.CUSTOM_STEP, 'normalizeStep() falls back to custom for unknown labels');
ok(Capture.normalizeStep('something-else').customLabel === 'something-else', 'normalizeStep() preserves the raw custom label');
ok(Capture.normalizeStep(null).step === Capture.CUSTOM_STEP, 'normalizeStep() never throws on null, falls back to custom');
ok(Capture.normalizeStep(undefined).step === Capture.CUSTOM_STEP, 'normalizeStep() never throws on undefined');

const fname = Capture.buildCaptureFilename('scout', fixedDate);
ok(fname === 'dataglow-capture_scout_20260727-053809.png', `buildCaptureFilename() builds "<step>_<stamp>.png": got ${fname}`);
const customFname = Capture.buildCaptureFilename('My Weird Label!! /path', fixedDate);
ok(!customFname.includes('/'), 'buildCaptureFilename() sanitizes a custom label: no path separators survive');
ok(customFname.startsWith('dataglow-capture_custom-'), 'buildCaptureFilename() prefixes an unrecognized step as custom-');

// ------------------------------------------------------------
// 2. R3 capture.js - record shape + list model
// ------------------------------------------------------------
const rec = Capture.buildCaptureRecord({ step: 'prove', method: 'html2canvas', width: 800, height: 600, byteSize: 12345, date: fixedDate });
ok(rec.kind === 'dataglow-capture-record', 'buildCaptureRecord() tags kind for downstream consumers');
ok(rec.step === 'prove', 'buildCaptureRecord() normalizes the step');
ok(rec.mimeType === 'image/png', 'buildCaptureRecord() always records PNG mime type (SPEC: "Saves PNG blob")');
ok(rec.method === 'html2canvas', 'buildCaptureRecord() records the capture method used');
ok(typeof rec.id === 'string' && rec.id.length > 0, 'buildCaptureRecord() assigns a unique id');
ok(!('blob' in rec), 'buildCaptureRecord() never embeds a Blob in the plain metadata record (kept serializable)');

let list = [];
list = Capture.addCapture(list, rec);
ok(list.length === 1, 'addCapture() appends to the in-memory list');
const rec2 = Capture.buildCaptureRecord({ step: 'export', method: 'canvas-fallback', date: fixedDate });
list = Capture.addCapture(list, rec2);
ok(list.length === 2, 'addCapture() appends a second capture');
const badList = Capture.addCapture(list, { not: 'a capture record' });
ok(badList.length === 2, 'addCapture() ignores a malformed record rather than corrupting the list');

const afterRemove = Capture.removeCapture(list, rec.id);
ok(afterRemove.length === 1 && afterRemove[0].id === rec2.id, 'removeCapture() removes exactly the targeted capture');
ok(Capture.removeCapture(list, 'not-a-real-id').length === 2, 'removeCapture() is a no-op for an unknown id, never throws');

const coverage = Capture.captureStepCoverage(list);
ok(coverage.steps.find((s) => s.step === 'prove').captured === true, 'captureStepCoverage() marks a captured step true');
ok(coverage.steps.find((s) => s.step === 'home').captured === false, 'captureStepCoverage() marks an uncaptured step false');
ok(coverage.coveredCount === 2, 'captureStepCoverage() counts covered steps (prove + export)');
ok(coverage.totalSteps === 7, 'captureStepCoverage() always reports 7 total fixed steps');

const manifest = Capture.buildScreenshotManifest(list);
ok(manifest.length === 2, 'buildScreenshotManifest() returns one row per capture');
ok(!('blob' in manifest[0]), 'buildScreenshotManifest() never carries blob bytes, only metadata');
ok(manifest.every((m) => typeof m.filename === 'string'), 'buildScreenshotManifest() rows carry a filename');

// ------------------------------------------------------------
// 3. R4 ship-pack.js - keepers.json passthrough + honest empty state
// ------------------------------------------------------------
const keepersFileEmpty = ShipPack.buildKeepersFile(null);
ok(keepersFileEmpty.keepers.length === 0, 'buildKeepersFile(null) is an honest empty keepers list, not a fabricated example');
ok(typeof keepersFileEmpty.note === 'string' && keepersFileEmpty.note.length > 0, 'buildKeepersFile(null) explains why keepers is empty');

const mockKeepersExport = {
  kind: 'dataglow-question-scout-keepers-export',
  version: 2,
  exportedAt: new Date().toISOString(),
  qualityMeter: { total: 2, passing: 2, label: '2/2' },
  keepers: [
    { id: 'k1', text: 'What is the denial rate by payer?', why: 'ops', metricType: 'rate', sql: 'SELECT 1;', source: 'template', domainPack: null, score: 90, edited: false, passesFullFilter: true },
    { id: 'k2', text: 'What is the average claim amount?', why: 'finance', metricType: 'avg', sql: 'SELECT 2;', source: 'template', domainPack: null, score: 80, edited: false, passesFullFilter: true },
  ],
};
const keepersFile = ShipPack.buildKeepersFile(mockKeepersExport);
ok(keepersFile === mockKeepersExport, 'buildKeepersFile() passes a well-shaped Scout export through unchanged');

// ------------------------------------------------------------
// 4. R4 ship-pack.js - claims.json from receipt ledger entries
// ------------------------------------------------------------
const mockReceiptEntry = {
  index: 0,
  hash: 'abc123',
  ts: Date.parse('2026-07-27T05:00:00Z'),
  record: {
    predicate: {
      claim: { text: 'What is the denial rate by payer?', predicate_ast: null },
      run: { statement: "SELECT payer, COUNT(*) FROM claims GROUP BY payer;", engine: 'duckdb-wasm', rowcount: 5, scalars: {} },
      corroboration: { engine: 'pyodide-sqlite' },
      verdict: { state: 'GREEN', reason_code: 'corroborated' },
    },
  },
};
const claim = ShipPack.claimFromReceiptEntry(mockReceiptEntry);
ok(claim.claimText === 'What is the denial rate by payer?', 'claimFromReceiptEntry() extracts claim text');
ok(claim.sql.includes('SELECT payer'), 'claimFromReceiptEntry() extracts the SQL actually run');
ok(claim.engineIds.includes('duckdb-wasm') && claim.engineIds.includes('pyodide-sqlite'), 'claimFromReceiptEntry() collects primary + corroborating engine ids');
ok(claim.verdictState === 'GREEN', 'claimFromReceiptEntry() extracts the verdict state');
ok(claim.corroborated === true, 'claimFromReceiptEntry() flags corroborated claims');

const claimsFileEmpty = ShipPack.buildClaimsFile(null);
ok(claimsFileEmpty.totalClaims === 0, 'buildClaimsFile(null) is an honest empty claims file, not a fabricated example');

const claimsFile = ShipPack.buildClaimsFile([mockReceiptEntry]);
ok(claimsFile.totalClaims === 1, 'buildClaimsFile() counts claims from receipt entries');
ok(claimsFile.verdictCounts.GREEN === 1, 'buildClaimsFile() tallies verdict counts by state');

// A RED-verdict receipt must never be miscounted as GREEN.
const redEntry = JSON.parse(JSON.stringify(mockReceiptEntry));
redEntry.record.predicate.verdict.state = 'RED';
redEntry.record.predicate.claim.text = 'A claim that failed';
const claimsFileMixed = ShipPack.buildClaimsFile([mockReceiptEntry, redEntry]);
ok(claimsFileMixed.verdictCounts.GREEN === 1 && claimsFileMixed.verdictCounts.RED === 1, 'buildClaimsFile() correctly separates GREEN and RED claims');

// ------------------------------------------------------------
// 5. R4 ship-pack.js - validation_summary.json
// ------------------------------------------------------------
const validationFileEmpty = ShipPack.buildValidationSummaryFile(null);
ok(validationFileEmpty.available === false, 'buildValidationSummaryFile(null) honestly reports validation as unavailable');

const validationLayers = [
  { layer: 'domain-physics', status: 'PASS', summary: 'All checks passed' },
  { layer: 'missingness', status: 'WARN', summary: '3 columns with elevated nulls' },
  { layer: 'upper-bound-sanity', status: 'FAIL', summary: '1 out-of-range value' },
];
const validationFile = ShipPack.buildValidationSummaryFile(validationLayers);
ok(validationFile.available === true, 'buildValidationSummaryFile() reports available when layers are supplied');
ok(validationFile.counts.pass === 1 && validationFile.counts.warn === 1 && validationFile.counts.fail === 1, 'buildValidationSummaryFile() tallies pass/warn/fail correctly');

// ------------------------------------------------------------
// 6. R4 ship-pack.js - honest_claims.md: no pure-local overclaim
// ------------------------------------------------------------
const honestMdWithProof = ShipPack.buildHonestClaimsMarkdown({ claimsFile, keepersFile: mockKeepersExport, validationFile });
ok(honestMdWithProof.includes('## PROVEN'), 'honest_claims.md has a PROVEN section');
ok(honestMdWithProof.includes('## UNVERIFIED'), 'honest_claims.md has a separate UNVERIFIED section');
ok(honestMdWithProof.includes('What is the denial rate by payer?'), 'honest_claims.md lists the GREEN-receipt claim under PROVEN');
ok(honestMdWithProof.includes('average claim amount'), 'honest_claims.md lists the un-proven keeper under UNVERIFIED');
ok(!honestMdWithProof.includes('\u2014'), 'honest_claims.md never contains an em dash (No em dash in visible UI)');

// The critical honesty guarantee: zero GREEN receipts must produce an
// explicit "nothing proven yet" statement, never silence or invented scale.
const honestMdNoProof = ShipPack.buildHonestClaimsMarkdown({
  claimsFile: ShipPack.buildClaimsFile(null),
  keepersFile: ShipPack.buildKeepersFile(null),
  validationFile: ShipPack.buildValidationSummaryFile(null),
});
ok(honestMdNoProof.toLowerCase().includes('nothing in this pack is proven yet'), 'honest_claims.md states plainly when nothing is proven yet (no pure-local overclaim)');
ok(!honestMdNoProof.includes('\u2014'), 'honest_claims.md (empty state) never contains an em dash');

// ------------------------------------------------------------
// 7. R4 ship-pack.js - full pack assembly + serialization
// ------------------------------------------------------------
const pack = ShipPack.buildShipPack({
  keepersExport: mockKeepersExport,
  receiptEntries: [mockReceiptEntry],
  validationLayers,
  screenshotManifest: manifest,
  datasetName: 'claims_2026',
});
ok(pack.kind === 'dataglow-ship-pack', 'buildShipPack() tags the pack kind');
ok(pack.fileNames.includes('keepers.json'), 'buildShipPack() includes keepers.json');
ok(pack.fileNames.includes('claims.json'), 'buildShipPack() includes claims.json');
ok(pack.fileNames.includes('validation_summary.json'), 'buildShipPack() includes validation_summary.json');
ok(pack.fileNames.includes('honest_claims.md'), 'buildShipPack() includes honest_claims.md');
ok(pack.fileNames.includes('screenshots/manifest.json'), 'buildShipPack() includes a screenshots manifest when captures are present');

const packNoScreens = ShipPack.buildShipPack({});
ok(!packNoScreens.fileNames.includes('screenshots/manifest.json'), 'buildShipPack() omits the screenshots manifest when there are no captures');
ok(packNoScreens.fileNames.includes('keepers.json'), 'buildShipPack() still produces the four core files with zero inputs');

const serialized = ShipPack.serializeShipPackFiles(pack);
ok(serialized.length === pack.fileNames.length, 'serializeShipPackFiles() emits one entry per file');
const mdEntry = serialized.find((f) => f.path === 'honest_claims.md');
ok(mdEntry.mimeType === 'text/markdown', 'serializeShipPackFiles() tags honest_claims.md as text/markdown');
const jsonEntry = serialized.find((f) => f.path === 'claims.json');
ok(jsonEntry.mimeType === 'application/json', 'serializeShipPackFiles() tags claims.json as application/json');
ok(() => { JSON.parse(jsonEntry.contents); return true; }, 'serializeShipPackFiles() produces valid parseable JSON for claims.json');
JSON.parse(jsonEntry.contents); // throws test-fatally if invalid, extra safety beyond the ok() line above

// ------------------------------------------------------------
// 8. Canvas (AUTHORITATIVE) - both modules actually inlined
// ------------------------------------------------------------
ok(canvas.includes('/* ---- from js/capture/capture.js ---- */'), 'canvas/index.html has the capture engine inlined');
ok(canvas.includes('/* ---- from js/ship-pack/ship-pack.js ---- */'), 'canvas/index.html has the ship-pack engine inlined');
ok(canvas.includes('/* ---- from js/capture/data-glow-capture-canvas.js ---- */'), 'canvas/index.html has the capture canvas UI inlined');
ok(canvas.includes('/* ---- from js/ship-pack/data-glow-ship-pack-canvas.js ---- */'), 'canvas/index.html has the ship-pack canvas UI inlined');
ok(canvas.includes('window.DataGlowCapture'), 'canvas/index.html publishes window.DataGlowCapture');
ok(canvas.includes('window.DataGlowShipPackEngine'), 'canvas/index.html publishes window.DataGlowShipPackEngine');
ok(canvas.includes('window.DataGlowShipPack'), 'canvas/index.html publishes window.DataGlowShipPack (SPEC: window.DataGlowShipPack.export())');
ok(/window\.DataGlowShipPack\s*=\s*\{[\s\S]{0,200}export:\s*runExport/.test(canvas), 'canvas/index.html wires window.DataGlowShipPack.export()');

// ------------------------------------------------------------
// 9. Flag gating
// ------------------------------------------------------------
ok(!!flagsManifest.flags.captureShipPack, 'flags.manifest.json declares the captureShipPack flag');
ok(flagsManifest.flags.captureShipPack.enabled === true, 'captureShipPack flag ships enabled');
ok(canvas.includes("isEnabled('captureShipPack')"), "canvas checks the captureShipPack flag via DataGlowFlags.isEnabled");

// ------------------------------------------------------------
// 10. No network upload anywhere in either canvas UI module (R3 SPEC: "No
//     network upload"; R4 pure engine has no network calls by construction).
// ------------------------------------------------------------
for (const [name, src] of [['capture canvas UI', captureCanvasSrc], ['ship-pack canvas UI', shipPackCanvasSrc]]) {
  ok(!/\bfetch\s*\(/.test(src), `${name} never calls fetch()`);
  ok(!/new\s+XMLHttpRequest/.test(src), `${name} never constructs XMLHttpRequest`);
  ok(!/new\s+WebSocket/.test(src), `${name} never opens a WebSocket`);
  ok(!/navigator\.sendBeacon\s*\(/.test(src), `${name} never calls navigator.sendBeacon()`);
}

// ------------------------------------------------------------
// 11. No em dash (U+2014) anywhere in either canvas UI source file's visible
//     strings, matching the SPEC's "No em dash visible" ship requirement.
// ------------------------------------------------------------
ok(!captureCanvasSrc.includes('\u2014'), 'capture canvas UI source contains no em dash');
ok(!shipPackCanvasSrc.includes('\u2014'), 'ship-pack canvas UI source contains no em dash');

// ------------------------------------------------------------
// Report
// ------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
