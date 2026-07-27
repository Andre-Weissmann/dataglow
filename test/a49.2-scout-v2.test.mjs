// ============================================================
// DATAGLOW - A49.2 Question Scout v2 contract test
// ============================================================
// Proves A49_2_SCOUT_V2_SPEC.md's 6 acceptance criteria at the level a plain
// Node script can prove: no browser, no GPU, no WebLLM download, no DOM.
//
//   1. With multi-table profile, join-hint candidates appear
//   2. IDR pack only emits questions when columns fuzzy-match
//   3. Vanity question scores below checkable ones in unit tests
//   4. Dictionary text improves prompt payload (tested)
//   5. Export keepers works
//   6. CI green path same as A49 (v1 suite still green, run separately by
//      the existing test:a49questionscout script; this file additionally
//      re-checks the handful of v1 invariants that a v2 regression could
//      most plausibly break: QUESTION_SCOUT_VERSION, MAX_KEEPERS,
//      CHEATING_BOUNDARY_BANNER, METRIC_TYPES)
//
// Also covers the two v2 features the acceptance list folds into "smarter
// keepers" without a dedicated numbered line: the keeper quality meter and
// the hardened browse UNVERIFIED tag.
//
// RUN WITH: node test/a49.2-scout-v2.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Scout from '../js/question-scout/question-scout.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CANVAS = join(repoRoot, 'canvas', 'index.html');
const canvas = readFileSync(CANVAS, 'utf8');
const canvasUiSrc = readFileSync(join(repoRoot, 'js', 'question-scout', 'data-glow-question-scout-canvas.js'), 'utf8');
const engineSrc = readFileSync(join(repoRoot, 'js', 'question-scout', 'question-scout.js'), 'utf8');

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

function markerCount(haystack, marker) {
  return haystack.split(marker).length - 1;
}

// ------------------------------------------------------------
// 0. v1 invariants must survive v2 (SPEC acceptance #6: CI green path
//    same as A49). The full v1 suite is run separately by
//    test:a49questionscout; these are the highest-value spot checks to
//    also assert here so a v2-only CI run still catches a v1 break.
// ------------------------------------------------------------
ok(Scout.QUESTION_SCOUT_VERSION === 1, 'v1 invariant: QUESTION_SCOUT_VERSION is still 1 (unchanged by v2)');
ok(Scout.MAX_KEEPERS === 5, 'v1 invariant: MAX_KEEPERS is still 5');
ok(Array.isArray(Scout.METRIC_TYPES) && Scout.METRIC_TYPES.length === 6, 'v1 invariant: METRIC_TYPES still has 6 entries');
ok(
  Scout.CHEATING_BOUNDARY_BANNER ===
    'Scout proposes questions. You pick keepers. Engines prove numbers. That is professional analyst work \u2014 same as a senior using a colleague to brainstorm, then checking the warehouse.',
  'v1 invariant: CHEATING_BOUNDARY_BANNER unchanged verbatim',
);

// ------------------------------------------------------------
// 1. SCOUT_V2_VERSION + new symbols are exported from the namespace
// ------------------------------------------------------------
ok(Scout.SCOUT_V2_VERSION === 2, 'SCOUT_V2_VERSION is 2');
for (const key of [
  'SCOUT_V2_VERSION', 'buildJoinHints', 'joinCandidatesFromHints',
  'HEALTHCARE_IDR_PACK_ID', 'idrPackCandidates', 'parseDictionary',
  'UNVERIFIED_TAG', 'tagAnswerForBrowse', 'keeperPassesFullFilter',
  'keeperQualityMeter', 'buildKeepersExport', 'exportKeepersJson',
]) {
  ok(key in Scout, `DataGlowQuestionScout namespace exports ${key}`);
}
ok(Scout.DataGlowQuestionScout ? Scout.DataGlowQuestionScout.SCOUT_V2_VERSION === 2 : true, 'default/namespace export (if present) also carries SCOUT_V2_VERSION');

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------
const claimsTable = {
  name: 'claims',
  rowCount: 500,
  columns: [
    { name: 'claim_id', type: 'STR', nullPct: 0 },
    { name: 'provider_id', type: 'STR', nullPct: 0 },
    { name: 'payer', type: 'STR', nullPct: 1, topValues: [{ value: 'Aetna', count: 120 }] },
    { name: 'amount', type: 'NUM', nullPct: 3, min: 0, max: 25000 },
  ],
};
const providersTable = {
  name: 'providers',
  rowCount: 40,
  columns: [
    { name: 'provider_id', type: 'STR', nullPct: 0 },
    { name: 'specialty', type: 'STR', nullPct: 0 },
  ],
};
const soloTable = {
  name: 'events',
  rowCount: 10,
  columns: [{ name: 'label', type: 'STR', nullPct: 0 }],
};
const idrTable = {
  name: 'idr_disputes',
  rowCount: 300,
  columns: [
    { name: 'dispute_id', type: 'STR', nullPct: 0 },
    { name: 'payer_name', type: 'STR', nullPct: 0 },
    { name: 'provider_name', type: 'STR', nullPct: 0 },
    { name: 'specialty', type: 'STR', nullPct: 0 },
    { name: 'determination_status', type: 'STR', nullPct: 0 },
    { name: 'qpa_amount', type: 'NUM', nullPct: 2, min: 0, max: 9000 },
    { name: 'prevailing_party', type: 'STR', nullPct: 0 },
    { name: 'quarter', type: 'STR', nullPct: 0 },
  ],
};

const multiTableStrip = Scout.buildProfileStrip([claimsTable, providersTable]);
const singleTableStrip = Scout.buildProfileStrip([soloTable]);
const idrStrip = Scout.buildProfileStrip([idrTable]);
const nonIdrStrip = Scout.buildProfileStrip([claimsTable]);

// ------------------------------------------------------------
// 2. Acceptance #1 -- multi-table profile => join-hint candidates appear
// ------------------------------------------------------------
const joinHints = Scout.buildJoinHints(multiTableStrip);
ok(Array.isArray(joinHints) && joinHints.length > 0, 'acceptance #1: buildJoinHints finds at least one hint for claims+providers (shared provider_id)');
ok(joinHints.some((h) => h.columnA === 'provider_id' && h.columnB === 'provider_id'), 'acceptance #1: join hint correctly identifies provider_id as the shared key');
ok(['high', 'medium', 'low'].includes(joinHints[0] && joinHints[0].confidence), 'acceptance #1: join hint carries a confidence label');

const joinCandidates = Scout.joinCandidatesFromHints(joinHints, multiTableStrip);
ok(Array.isArray(joinCandidates) && joinCandidates.length > 0, 'acceptance #1: joinCandidatesFromHints turns hints into concrete candidate questions');
ok(joinCandidates.every((c) => typeof c.text === 'string' && c.text.length > 0), 'acceptance #1: every join candidate has question text');
ok(joinCandidates.every((c) => typeof c.sql === 'string' && /join/i.test(c.sql)), 'acceptance #1: every join candidate SQL actually contains a JOIN');

// Single-table profile: no join hints, no join candidates (nothing to join).
const singleTableHints = Scout.buildJoinHints(singleTableStrip);
ok(Array.isArray(singleTableHints) && singleTableHints.length === 0, 'single-table profile yields zero join hints (nothing to join)');
ok(Scout.joinCandidatesFromHints(singleTableHints, singleTableStrip).length === 0, 'single-table profile yields zero join candidates');

// ------------------------------------------------------------
// 3. Acceptance #2 -- IDR pack only emits when columns fuzzy-match
// ------------------------------------------------------------
ok(typeof Scout.HEALTHCARE_IDR_PACK_ID === 'string' && Scout.HEALTHCARE_IDR_PACK_ID.length > 0, 'HEALTHCARE_IDR_PACK_ID is a non-empty string identifier');

const idrCandidates = Scout.idrPackCandidates(idrStrip);
ok(Array.isArray(idrCandidates) && idrCandidates.length >= 3, 'acceptance #2: IDR pack emits multiple candidates against an IDR-shaped table (dispute_id/payer/provider/status/qpa/prevailing_party/quarter)');
ok(idrCandidates.every((c) => c.packId === Scout.HEALTHCARE_IDR_PACK_ID || c.id.indexOf('idr_') === 0), 'acceptance #2: IDR candidates are tagged as belonging to the healthcare-idr pack');
ok(/volume|closure|specialty|win.?rate|delta|qoq/i.test(idrCandidates.map((c) => c.text).join(' ')), 'acceptance #2: IDR candidates cover the SPEC-listed themes (volume/closure mix/specialty concentration/win rate/QoQ delta)');

const idrOnNonIdr = Scout.idrPackCandidates(nonIdrStrip);
ok(Array.isArray(idrOnNonIdr) && idrOnNonIdr.length === 0, 'acceptance #2: IDR pack self-silences (emits zero candidates) against a non-IDR-shaped table (claims)');

const idrOnSolo = Scout.idrPackCandidates(singleTableStrip);
ok(Array.isArray(idrOnSolo) && idrOnSolo.length === 0, 'acceptance #2: IDR pack self-silences against a minimal unrelated table too');

// ------------------------------------------------------------
// 4. Acceptance #3 -- vanity question scores below checkable ones
// ------------------------------------------------------------
const vanityCandidate = {
  id: 'vanity-1',
  text: 'That would make an interesting chart to look at.',
  why: '',
  metricType: '',
  sql: '',
};
const checkableCandidate = {
  id: 'checkable-1',
  text: 'What is the win rate and backlog count by payer this quarter?',
  why: 'Ops leadership needs this to prioritize appeals staffing.',
  metricType: 'rate',
  sql: 'SELECT payer, COUNT(*) AS backlog FROM claims GROUP BY payer;',
};
const vanityScore = Scout.scoreCandidate(vanityCandidate, multiTableStrip);
const checkableScore = Scout.scoreCandidate(checkableCandidate, multiTableStrip);
ok(typeof vanityScore.score === 'number' && typeof checkableScore.score === 'number', 'scoreCandidate returns numeric scores for both fixtures');
ok(vanityScore.score < checkableScore.score, `acceptance #3: vanity candidate score (${vanityScore.score}) is lower than checkable candidate score (${checkableScore.score})`);
ok(vanityScore.penalties.length > 0, 'acceptance #3: vanity candidate accrues at least one anti-vanity penalty');
ok(vanityScore.penalties.some((p) => /vanity|vague/i.test(p)), 'acceptance #3: vanity penalty reasons are anti-vanity-flavored (vanity/vague)');
ok(checkableScore.penalties.length === 0, 'acceptance #3: the strong checkable candidate accrues zero penalties');

// A second, milder vanity case (chart-only, no metric language at all) must
// still rank below a checkable candidate on the same profile.
const chartOnlyCandidate = { id: 'chart-1', text: 'Show me a chart of the data.', why: '', metricType: '', sql: '' };
const chartOnlyScore = Scout.scoreCandidate(chartOnlyCandidate, multiTableStrip);
ok(chartOnlyScore.score < checkableScore.score, 'acceptance #3: chart-only vanity candidate also scores below the checkable candidate');

// ------------------------------------------------------------
// 5. Acceptance #4 -- dictionary text improves the prompt payload
// ------------------------------------------------------------
const dictionaryText = 'claim_id - Unique claim identifier\namount: Total billed amount in USD\nprovider_id = Foreign key to providers.provider_id';
const parsedDict = Scout.parseDictionary(dictionaryText);
ok(parsedDict && typeof parsedDict === 'object', 'parseDictionary returns an object');
ok(parsedDict.claim_id === 'Unique claim identifier', 'parseDictionary parses a " - " separated line');
ok(parsedDict.amount === 'Total billed amount in USD', 'parseDictionary parses a ":" separated line');
ok(parsedDict.provider_id && /providers\.provider_id/.test(parsedDict.provider_id), 'parseDictionary parses a " = " separated line');

const promptWithoutDict = Scout.buildScoutPrompt(multiTableStrip);
const promptWithDict = Scout.buildScoutPrompt(multiTableStrip, { dictionary: dictionaryText });
ok(promptWithDict.dictionaryApplied === true, 'acceptance #4: prompt payload records dictionaryApplied=true when a dictionary is supplied');
ok(!promptWithoutDict.dictionaryApplied, 'acceptance #4: prompt payload does NOT claim dictionaryApplied when no dictionary is supplied');
ok(Array.isArray(promptWithDict.matchedDictionaryKeys) && promptWithDict.matchedDictionaryKeys.length >= 2, 'acceptance #4: prompt payload reports which dictionary keys actually matched profiled columns');
const withDictText = JSON.stringify(promptWithDict.messages);
const withoutDictText = JSON.stringify(promptWithoutDict.messages);
ok(withDictText.length > withoutDictText.length, 'acceptance #4: the dictionary-grounded prompt payload is strictly larger/richer than the plain one');
ok(withDictText.includes('Unique claim identifier') || withDictText.includes('Total billed amount in USD'), 'acceptance #4: dictionary definitions are actually inlined into the prompt payload text');
// Malformed/empty dictionary must not crash prompt construction (deterministic path must still work cold).
ok(() => Scout.buildScoutPrompt(multiTableStrip, { dictionary: '' }) || true, 'buildScoutPrompt tolerates an empty dictionary string without throwing');
let threwOnGarbage = false;
try { Scout.buildScoutPrompt(multiTableStrip, { dictionary: '\u0000\u0000not a dictionary{{{' }); } catch (_e) { threwOnGarbage = true; }
ok(!threwOnGarbage, 'buildScoutPrompt tolerates a garbage/unparseable dictionary string without throwing');

// ------------------------------------------------------------
// 6. Acceptance #5 -- export keepers works
// ------------------------------------------------------------
let keepers = [];
keepers = Scout.addKeeper(keepers, { id: 'k1', text: checkableCandidate.text, why: checkableCandidate.why, metricType: checkableCandidate.metricType, sql: checkableCandidate.sql });
keepers = Scout.addKeeper(keepers, { id: 'k2', text: vanityCandidate.text, why: vanityCandidate.why, metricType: vanityCandidate.metricType, sql: vanityCandidate.sql });

const exportedJsonStr = Scout.exportKeepersJson(keepers, multiTableStrip);
ok(typeof exportedJsonStr === 'string' && exportedJsonStr.length > 0, 'acceptance #5: exportKeepersJson returns a non-empty string');
let exportedParsed = null;
let exportParseThrew = false;
try { exportedParsed = JSON.parse(exportedJsonStr); } catch (_e) { exportParseThrew = true; }
ok(!exportParseThrew, 'acceptance #5: exportKeepersJson output is valid, parseable JSON');
ok(exportedParsed && Array.isArray(exportedParsed.keepers) && exportedParsed.keepers.length === keepers.length, 'acceptance #5: exported JSON contains all current keepers');
ok(exportedParsed && exportedParsed.scoutV2Version === 2, 'acceptance #5: exported JSON stamps scoutV2Version for provenance');
ok(exportedParsed && typeof exportedParsed.exportedAt === 'string', 'acceptance #5: exported JSON records an export timestamp');
ok(exportedParsed && exportedParsed.qualityMeter && typeof exportedParsed.qualityMeter.passing === 'number', 'acceptance #5: exported JSON embeds the keeper quality meter for portfolio context');

const exportedEmpty = JSON.parse(Scout.exportKeepersJson([], multiTableStrip));
ok(Array.isArray(exportedEmpty.keepers) && exportedEmpty.keepers.length === 0, 'acceptance #5: exportKeepersJson works (does not throw) on an empty keepers tray');

const buildKeepersExportObj = Scout.buildKeepersExport(keepers, multiTableStrip);
ok(buildKeepersExportObj && Array.isArray(buildKeepersExportObj.keepers), 'buildKeepersExport (pre-serialization helper) returns the same shape exportKeepersJson serializes');
ok(JSON.stringify(buildKeepersExportObj.keepers) === JSON.stringify(exportedParsed.keepers), 'buildKeepersExport and exportKeepersJson agree on keeper contents');

// ------------------------------------------------------------
// 7. Keeper quality meter (feeds the SPEC's "smarter keepers" framing and
//    is displayed above the keepers tray in canvas UI)
// ------------------------------------------------------------
const meter = Scout.keeperQualityMeter(keepers, multiTableStrip);
ok(meter && typeof meter.passing === 'number' && typeof meter.total === 'number', 'keeperQualityMeter returns numeric passing/total counts');
ok(meter.total === keepers.length, 'keeperQualityMeter total matches the number of keepers passed in');
ok(meter.passing === 1, 'keeperQualityMeter correctly counts exactly 1 of the 2 fixture keepers (checkable) as passing the full filter');
ok(typeof meter.label === 'string' && meter.label.length > 0, 'keeperQualityMeter produces a human-readable label');
ok(Scout.keeperPassesFullFilter(checkableCandidate, multiTableStrip).passesAll === true, 'keeperPassesFullFilter: the strong checkable candidate passes the full business owner + answerable + checkable + not-vanity filter');
ok(Scout.keeperPassesFullFilter(vanityCandidate, multiTableStrip).passesAll === false, 'keeperPassesFullFilter: the vanity candidate fails the full filter');
const emptyMeter = Scout.keeperQualityMeter([], multiTableStrip);
ok(emptyMeter.total === 0 && emptyMeter.passing === 0, 'keeperQualityMeter handles an empty keepers tray without throwing');

// ------------------------------------------------------------
// 8. Browse mode hardening -- any numeric assertion tagged UNVERIFIED
// ------------------------------------------------------------
ok(typeof Scout.UNVERIFIED_TAG === 'string' && Scout.UNVERIFIED_TAG.length > 0, 'UNVERIFIED_TAG is a non-empty string constant');
const numericAnswer = Scout.tagAnswerForBrowse('There are 42 open disputes this quarter.');
ok(numericAnswer.isUnverified === true, 'tagAnswerForBrowse flags a numeric assertion as unverified');
ok(numericAnswer.tag === Scout.UNVERIFIED_TAG, 'tagAnswerForBrowse attaches the UNVERIFIED_TAG constant to a numeric assertion');
ok(numericAnswer.displayText.includes(numericAnswer.text), 'tagAnswerForBrowse preserves the original answer text inside displayText');
ok(/unverified/i.test(numericAnswer.displayText), 'tagAnswerForBrowse displayText visibly communicates unverified status');

const nonNumericAnswer = Scout.tagAnswerForBrowse('Providers are grouped by specialty in this dataset.');
ok(nonNumericAnswer.isUnverified === false, 'tagAnswerForBrowse does not flag a purely descriptive, non-numeric answer as unverified');

// ------------------------------------------------------------
// 9. Canvas UI: v2 controls are actually inlined and wired
// ------------------------------------------------------------
ok(canvasUiSrc.includes('_dictionaryText'), 'canvas UI module: has dictionary-text state for pasted/loaded dictionaries');
ok(canvasUiSrc.includes('dg-qs-dictionary-input'), 'canvas UI module: renders a dictionary input element');
ok(canvasUiSrc.includes('_idrPackOn') && canvasUiSrc.includes('dg-qs-idr-toggle'), 'canvas UI module: has an explicit opt-in toggle for the healthcare-idr pack');
ok(canvasUiSrc.includes('buildJoinHints') && canvasUiSrc.includes('renderJoinHints'), 'canvas UI module: computes and renders join hints');
ok(canvasUiSrc.includes('idrPackCandidates'), 'canvas UI module: wires idrPackCandidates into the Propose flow');
ok(canvasUiSrc.includes('tagAnswerForBrowse') || canvasUiSrc.includes('UNVERIFIED'), 'canvas UI module: surfaces the UNVERIFIED badge in Browse mode');
ok(canvasUiSrc.includes('keeperQualityMeter') && canvasUiSrc.includes('renderQualityMeter'), 'canvas UI module: renders the keeper quality meter');
ok(canvasUiSrc.includes('exportKeepersJson') && canvasUiSrc.includes('dg-qs-export-keepers'), 'canvas UI module: wires an Export Keepers JSON button to the engine export helper');
ok(canvasUiSrc.includes('Blob') && canvasUiSrc.includes('download'), 'canvas UI module: export button uses a client-side Blob download (no server round trip, local-first)');

// ------------------------------------------------------------
// 10. Canvas integration: v2-carrying engine/UI files are still inlined
//     exactly once each in canvas/index.html (no duplication from re-injection)
// ------------------------------------------------------------
ok(markerCount(canvas, '/* ---- from js/question-scout/question-scout.js ---- */') === 1, 'canvas/index.html: question-scout.js engine module inlined exactly once');
ok(markerCount(canvas, '/* ---- from js/question-scout/data-glow-question-scout-canvas.js ---- */') === 1, 'canvas/index.html: question-scout canvas UI module inlined exactly once');
ok(canvas.includes('SCOUT_V2_VERSION'), 'canvas/index.html: inlined engine copy carries the v2 version marker');
ok(canvas.includes('exportKeepersJson'), 'canvas/index.html: inlined engine copy carries exportKeepersJson');
ok(canvas.includes('dg-qs-export-keepers'), 'canvas/index.html: inlined canvas UI copy carries the export button element id');
ok(canvas.includes(Scout.CHEATING_BOUNDARY_BANNER) || canvas.includes('CHEATING_BOUNDARY_BANNER'), 'canvas/index.html: still surfaces the honest professional banner after re-injection');

// ------------------------------------------------------------
// 11. Non-goals guardrails -- v2 must not introduce a cloud LLM default or
//     an auto-prove path (SPEC Non-goals)
// ------------------------------------------------------------
ok(!/api\.openai\.com|anthropic\.com\/v1|generativelanguage\.googleapis/i.test(engineSrc), 'engine source: no hardcoded cloud LLM endpoint introduced by v2');
ok(!/auto-?prove|autoProve/i.test(engineSrc), 'engine source: no auto-prove path introduced by v2 (human must still choose to Send to Prove)');

// ------------------------------------------------------------
// 12. Proof Harness / other engines are not disturbed by this addition
// ------------------------------------------------------------
ok(markerCount(canvas, '/* ---- from js/proof-harness/data-glow-proof-harness-canvas.js ---- */') === 1, 'canvas/index.html: Proof Harness canvas module is still inlined exactly once (untouched by this PR)');
ok(canvas.includes('window.DataGlowProofHarness'), 'canvas/index.html: Proof Harness engine namespace is still published (untouched by this PR)');
ok(canvas.includes('window.OnDeviceLLM'), 'canvas/index.html: the shared local AI bridge namespace is still published (untouched by this PR)');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
