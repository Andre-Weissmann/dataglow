// ============================================================
// DATAGLOW - A49 Question Scout contract test
// ============================================================
// Proves A49_QUESTION_SCOUT_SPEC.md's acceptance criteria at the level a
// plain Node script can prove: no browser, no GPU, no WebLLM download, no
// DOM. Two kinds of checks:
//
//   1. Direct import of the pure engine (js/question-scout/question-scout.js)
//      to exercise buildProfileStrip(), the deterministic keeper filter
//      (scoreCandidate/rankCandidates), the five model-free fallback
//      templates, the Prove-prefill mapper, the locked banner text, prompt
//      construction, tolerant model-output parsing, and the max-5 keepers
//      tray -- all pure/deterministic, so this never needs a model.
//   2. String/regex checks against canvas/index.html (AUTHORITATIVE) to
//      confirm the canvas UI module is actually inlined, wired to the
//      existing local AI bridge (window.OnDeviceLLM) rather than a second
//      model path, gated behind the questionScout flag, and never silently
//      claims a number is proven.
//
// RUN WITH: node test/a49-question-scout.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Scout from '../js/question-scout/question-scout.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CANVAS = join(repoRoot, 'canvas', 'index.html');
const canvas = readFileSync(CANVAS, 'utf8');
const canvasUiSrc = readFileSync(join(repoRoot, 'js', 'question-scout', 'data-glow-question-scout-canvas.js'), 'utf8');
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
// 1. Constants / locked copy
// ------------------------------------------------------------
ok(Scout.QUESTION_SCOUT_VERSION === 1, 'QUESTION_SCOUT_VERSION is 1');
ok(Scout.MAX_CANDIDATES === 15, 'MAX_CANDIDATES is 15 (SPEC: 10-15 candidates)');
ok(Scout.MIN_CANDIDATES_TARGET === 10, 'MIN_CANDIDATES_TARGET is 10');
ok(Scout.MAX_KEEPERS === 5, 'MAX_KEEPERS is 5 (SPEC: keepers tray caps at 5)');
ok(Array.isArray(Scout.METRIC_TYPES) && Scout.METRIC_TYPES.length === 6, 'METRIC_TYPES has 6 checkable metric types');
for (const m of ['count', 'rate', 'share', 'delta', 'sum', 'avg']) {
  ok(Scout.METRIC_TYPES.includes(m), `METRIC_TYPES includes ${m}`);
}
ok(
  Scout.CHEATING_BOUNDARY_BANNER ===
    'Scout proposes questions. You pick keepers. Engines prove numbers. That is professional analyst work \u2014 same as a senior using a colleague to brainstorm, then checking the warehouse.',
  'CHEATING_BOUNDARY_BANNER matches the SPEC-locked copy verbatim',
);

// ------------------------------------------------------------
// 2. buildProfileStrip() - deterministic, no LLM
// ------------------------------------------------------------
const emptyStrip = Scout.buildProfileStrip([]);
ok(emptyStrip.isEmpty === true, 'buildProfileStrip([]): empty input yields isEmpty=true, never throws');
ok(emptyStrip.tableCount === 0, 'buildProfileStrip([]): tableCount is 0 for empty input');

const mockClaims = {
  name: 'claims',
  rowCount: 5000,
  columns: [
    { name: 'claim_id', type: 'STR', nullPct: 0, cardinality: 5000 },
    { name: 'payer', type: 'STR', nullPct: 1, topValues: [{ value: 'Aetna', count: 2000 }, { value: 'Cigna', count: 1500 }] },
    { name: 'amount', type: 'NUM', nullPct: 40, min: 0, max: 98765 },
    { name: 'status', type: 'STR', nullPct: 0, topValues: [{ value: 'paid', count: 4000 }] },
  ],
};
const strip = Scout.buildProfileStrip([mockClaims]);
ok(strip.kind === 'dataglow-question-scout-profile-strip', 'buildProfileStrip: kind tag present for downstream consumers');
ok(strip.isEmpty === false, 'buildProfileStrip: populated input is not empty');
ok(strip.tableCount === 1, 'buildProfileStrip: tableCount reflects one input table');
ok(strip.totalColumns === 4, 'buildProfileStrip: totalColumns counts all columns across tables');
ok(strip.highNullColumns.some(h => h.table === 'claims' && h.column === 'amount'), 'buildProfileStrip: flags amount (40% null) as a high-null column (>=10%)');
ok(!strip.highNullColumns.some(h => h.column === 'claim_id'), 'buildProfileStrip: does not flag claim_id (0% null) as high-null');
ok(!!strip.topCategoricalByTable.claims, 'buildProfileStrip: records a top categorical column for claims');
ok(strip.numericColumns.some(n => n.column === 'amount'), 'buildProfileStrip: records amount as a numeric column (has min/max)');
ok(strip.idLikeColumns.some(i => i.column === 'claim_id'), 'buildProfileStrip: recognizes claim_id as id-like');

// ------------------------------------------------------------
// 3. Deterministic keeper filter must rank checkable above vanity/DML
// ------------------------------------------------------------
const goodCandidate = {
  text: 'What is the denial rate by payer for claims, and which payer should ops review first?',
  why: 'Denial rate by payer directly affects revenue and payer negotiations.',
  metricType: 'rate',
  sql: "SELECT payer, COUNT(*) FROM claims WHERE status = 'denied' GROUP BY payer;",
};
const dmlCandidate = {
  text: 'Delete all rows in claims where amount is missing.',
  why: 'cleanup',
  metricType: 'count',
  sql: 'DELETE FROM claims WHERE amount IS NULL;',
};
const vanityCandidate = {
  text: 'Make a pretty chart and a cool visualization of the data.',
  why: 'looks nice',
  metricType: '',
  sql: '',
};

const goodScore = Scout.scoreCandidate(goodCandidate, strip);
const dmlScore = Scout.scoreCandidate(dmlCandidate, strip);
const vanityScore = Scout.scoreCandidate(vanityCandidate, strip);

ok(goodScore.score > dmlScore.score, 'deterministic filter: a checkable business question outscores a DML statement');
ok(dmlScore.score > vanityScore.score || dmlScore.score >= vanityScore.score, 'deterministic filter: a DML statement is not ranked below pure vanity by more than expected');
ok(goodScore.score > vanityScore.score, 'deterministic filter: a checkable business question outscores pure viz vanity');
ok(vanityScore.penalties.includes('viz_vanity_without_metric'), 'deterministic filter: vanity-without-metric candidate is penalized');
ok(dmlScore.penalties.includes('sql_is_not_select'), 'deterministic filter: DML statement is penalized for not being SELECT-only');
ok(goodScore.hits.includes('checkable_metric_type'), 'deterministic filter: rate/count/etc metric types register as a hit');
ok(goodScore.hits.includes('sql_is_select'), 'deterministic filter: a SELECT-only draft statement registers as a hit');

const ranked = Scout.rankCandidates([vanityCandidate, dmlCandidate, goodCandidate], strip);
ok(ranked.length === 3, 'rankCandidates: returns all input candidates');
ok(ranked[0].text === goodCandidate.text, 'rankCandidates: the checkable business question ranks first');
ok(ranked.every((c, i) => i === 0 || ranked[i - 1].score >= c.score), 'rankCandidates: output is sorted by score descending');

// ------------------------------------------------------------
// 4. Template fallback works fully offline (no model, no GPU)
// ------------------------------------------------------------
const templates = Scout.templateCandidatesFromProfile(strip);
ok(templates.length >= 4, 'templateCandidatesFromProfile: produces multiple candidates from one profiled table with no model');
ok(templates.every(t => t.source === 'template' && t.modelUsed === false), 'templateCandidatesFromProfile: every template is honestly labeled source=template, modelUsed=false');
ok(templates.some(t => /COUNT\(\*\)/.test(t.sql) && /grain/.test(t.id)), 'templateCandidatesFromProfile: includes a COUNT(*) grain-check template');
ok(templates.some(t => /null_rate/.test(t.sql)), 'templateCandidatesFromProfile: includes a null-rate template for the high-null amount column');
ok(templates.some(t => /GROUP BY/.test(t.sql) && /ORDER BY n DESC/.test(t.sql)), 'templateCandidatesFromProfile: includes a top-N frequency template');
ok(templates.some(t => /MIN\(/.test(t.sql) && /MAX\(/.test(t.sql) && /AVG\(/.test(t.sql)), 'templateCandidatesFromProfile: includes a min/max/avg template on the numeric column');
ok(templates.some(t => /COUNT\(DISTINCT/.test(t.sql)), 'templateCandidatesFromProfile: includes a distinct-count template on the id-like column');
ok(Scout.templateCandidatesFromProfile(Scout.buildProfileStrip([])).length === 0, 'templateCandidatesFromProfile: an empty profile yields zero templates, never throws');
const rankedTemplates = Scout.rankCandidates(templates, strip);
ok(rankedTemplates.every(t => t.score >= 50), 'deterministic filter: every honest template scores reasonably well (checkable + real columns + SELECT-only)');

// ------------------------------------------------------------
// 5. Prompt construction + tolerant model-output parsing (pure strings)
// ------------------------------------------------------------
const prompt = Scout.buildScoutPrompt(strip);
ok(typeof prompt.system === 'string' && prompt.system.length > 0, 'buildScoutPrompt: builds a non-empty system prompt');
ok(prompt.user.includes('claims'), 'buildScoutPrompt: user prompt references the profiled table by name');
ok(prompt.user.includes('amount'), 'buildScoutPrompt: user prompt lists profiled column names');
ok(Array.isArray(prompt.messages) && prompt.messages.length === 2, 'buildScoutPrompt: returns a ready-to-send messages[] for a chat.completions-style call');

const fencedModelOutput = '```json\n[{"text":"What is total denied claims by payer?","why":"payer decision","metricType":"count","sql":"SELECT payer, COUNT(*) FROM claims WHERE status = \'denied\' GROUP BY payer;"}]\n```';
const parsed = Scout.parseModelCandidates(fencedModelOutput);
ok(parsed.length === 1, 'parseModelCandidates: parses a fenced ```json block into one candidate');
ok(parsed[0].source === 'model' && parsed[0].modelUsed === true, 'parseModelCandidates: parsed candidates are honestly labeled source=model, modelUsed=true');
ok(typeof parsed[0].id === 'string' && parsed[0].id.startsWith('model_'), 'parseModelCandidates: assigns a stable model_ prefixed id');
ok(Scout.parseModelCandidates('not json at all').length === 0, 'parseModelCandidates: malformed text returns [] instead of throwing');
ok(Scout.parseModelCandidates('').length === 0, 'parseModelCandidates: empty string returns [] instead of throwing');
ok(Scout.parseModelCandidates(undefined).length === 0, 'parseModelCandidates: undefined input returns [] instead of throwing');

// ------------------------------------------------------------
// 6. Send to Prove prefill maps 1:1 to the Proof Harness fields, never runs SQL
// ------------------------------------------------------------
const keeper = { id: 'tmpl_grain_claims', text: 'How many rows are in claims, and is that the expected grain?', sql: 'SELECT COUNT(*) AS row_count FROM claims;', metricType: 'count' };
const prefill = Scout.buildProvePrefill(keeper);
ok(prefill.kind === 'dataglow-question-scout-prove-prefill', 'buildProvePrefill: tags the prefill payload with a stable kind');
ok(prefill.claimText === keeper.text, 'buildProvePrefill: claimText maps from the keeper text (targets #dg-ph-claim)');
ok(prefill.statement === 'SELECT COUNT(*) AS row_count FROM claims', 'buildProvePrefill: statement maps from keeper sql with trailing semicolon stripped (targets #dg-ph-statement)');
ok(prefill.sourceCandidateId === 'tmpl_grain_claims', 'buildProvePrefill: retains the source candidate id for traceability');
ok(Scout.buildProvePrefill(null) === null, 'buildProvePrefill: non-object input returns null instead of throwing');

// ------------------------------------------------------------
// 7. Browse-mode grounding never leaks raw rows, flags unverified numbers
// ------------------------------------------------------------
const grounding = Scout.buildBrowseGrounding(strip);
ok(grounding.includes('claims'), 'buildBrowseGrounding: mentions the table name');
ok(!grounding.includes('98765'), 'buildBrowseGrounding: never includes raw cell values, only profile-level shape');
ok(Scout.annotateUnverifiedNumbers('There are 42 rows.').includes(Scout.ANSWER_UNVERIFIED_NOTE), 'annotateUnverifiedNumbers: flags a bare numeric assertion as unverified');
ok(Scout.annotateUnverifiedNumbers('There are 42 rows (unverified \u2014 run Prove)').match(/unverified/gi).length === 1, 'annotateUnverifiedNumbers: does not double-flag an already-flagged answer');
ok(Scout.annotateUnverifiedNumbers('No numeric claim here.') === 'No numeric claim here.', 'annotateUnverifiedNumbers: leaves a non-numeric answer untouched');

// ------------------------------------------------------------
// 8. Keepers tray caps at MAX_KEEPERS (5), no duplicates
// ------------------------------------------------------------
let keepers = [];
for (let i = 0; i < 7; i++) {
  keepers = Scout.addKeeper(keepers, { id: `c${i}`, text: `q${i}` });
}
ok(keepers.length === Scout.MAX_KEEPERS, 'addKeeper: tray never exceeds MAX_KEEPERS (5) even when more are proposed');
const beforeDup = keepers.length;
keepers = Scout.addKeeper(keepers, { id: 'c0', text: 'q0' });
ok(keepers.length === beforeDup, 'addKeeper: adding a duplicate id is a no-op');
keepers = Scout.removeKeeper(keepers, 'c0');
ok(!keepers.some(k => k.id === 'c0'), 'removeKeeper: removes the specified candidate by id');
ok(keepers.length === beforeDup - 1, 'removeKeeper: tray shrinks by exactly one');

// ------------------------------------------------------------
// 9. Canvas wiring: inlined once, flag-gated, wired to the EXISTING local AI
//    bridge (window.OnDeviceLLM) rather than a second/duplicate model path.
// ------------------------------------------------------------
function markerCount(html, marker) {
  return html.split(marker).length - 1;
}
ok(markerCount(canvas, '/* ---- from js/question-scout/question-scout.js ---- */') === 1, 'canvas/index.html: question-scout.js engine is inlined exactly once');
ok(markerCount(canvas, '/* ---- end js/question-scout/question-scout.js ---- */') === 1, 'canvas/index.html: question-scout.js has exactly one closing marker');
ok(markerCount(canvas, '/* ---- from js/question-scout/data-glow-question-scout-canvas.js ---- */') === 1, 'canvas/index.html: data-glow-question-scout-canvas.js is inlined exactly once');
ok(canvas.includes('window.DataGlowQuestionScout'), 'canvas/index.html: pure engine is published on window.DataGlowQuestionScout');
ok(canvas.includes('window.DataGlowQuestionScoutCanvas'), 'canvas/index.html: canvas UI module publishes window.DataGlowQuestionScoutCanvas');

ok(canvasUiSrc.includes('window.OnDeviceLLM'), 'canvas UI module: reads the EXISTING local AI bridge (window.OnDeviceLLM), not a second model path');
ok(!canvasUiSrc.includes('DataGlowOnDeviceLLM'), 'canvas UI module: does not reference the stale/incorrect bridge name from an earlier draft');
ok(!canvasUiSrc.includes('bridge.chatOnce'), 'canvas UI module: does not call a non-existent chatOnce() method on the bridge');
ok(canvasUiSrc.includes('loadModel'), 'canvas UI module: reuses the bridge\'s existing loadModel() rather than triggering a separate download path');
ok(canvasUiSrc.includes('chat.completions.create'), 'canvas UI module: calls the MLC engine handle\'s chat.completions.create(...) exactly like ondevice-llm.js\'s own prompts do');
ok(canvasUiSrc.includes('isModelLoaded'), 'canvas UI module: checks isModelLoaded() before assuming the model is warm (honest cold-state fallback)');
ok(canvasUiSrc.includes('templateCandidatesFromProfile') || canvasUiSrc.includes('e.templateCandidatesFromProfile'), 'canvas UI module: falls back to deterministic templates when the model is cold');
ok(canvasUiSrc.includes('questionScout'), 'canvas UI module: gates its own boot behind the questionScout flag');
ok(canvasUiSrc.includes('dg-question-scout-btn'), 'canvas UI module: defines a distinct button id, does not collide with Proof Harness');
ok(canvasUiSrc.includes('dg-proof-harness-btn') || canvasUiSrc.includes('dg-ph-claim'), 'canvas UI module: integrates with the existing Proof Harness surface for Send to Prove');
ok(canvasUiSrc.includes('dataglow:proof-harness-prefill'), 'canvas UI module: dispatches a CustomEvent fallback so Send to Prove never silently fails');
ok(canvasUiSrc.includes(Scout.CHEATING_BOUNDARY_BANNER) || canvasUiSrc.includes('CHEATING_BOUNDARY_BANNER'), 'canvas UI module: surfaces the honest professional banner (via the engine constant or inline)');

// ------------------------------------------------------------
// 10. Flag registered, off-by-default-safe description present
// ------------------------------------------------------------
ok(!!flagsManifest.flags && !!flagsManifest.flags.questionScout, 'flags.manifest.json: questionScout flag is registered');
ok(typeof flagsManifest.flags.questionScout.description === 'string' && flagsManifest.flags.questionScout.description.length > 40, 'flags.manifest.json: questionScout has a real description');
ok(typeof flagsManifest.flags.questionScout.flagOffBehavior === 'string', 'flags.manifest.json: questionScout documents flag-off behavior');

// ------------------------------------------------------------
// 11. Proof Harness / other engines are not disturbed by this addition
// ------------------------------------------------------------
ok(markerCount(canvas, '/* ---- from js/proof-harness/data-glow-proof-harness-canvas.js ---- */') === 1, 'canvas/index.html: Proof Harness canvas module is still inlined exactly once (untouched by this PR)');
ok(canvas.includes('window.DataGlowProofHarness'), 'canvas/index.html: Proof Harness engine namespace is still published (untouched by this PR)');
ok(canvas.includes('window.OnDeviceLLM'), 'canvas/index.html: the shared local AI bridge namespace is still published (untouched by this PR)');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
