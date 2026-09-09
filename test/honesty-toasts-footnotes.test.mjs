// ============================================================
// DATAGLOW - three honest numbers: row count, issue count, load state
// ============================================================
// Loading the real CMS Federal IDR workbook (Initiations by State, 2025 Q2)
// produced three statements on screen at once, all of them wrong:
//
//   1. ROWS 59. The sheet holds 56 states and territories. The extra three
//      were a "2025 Q2" sub-label under the header and two footnote lines
//      ("Source: ..." and "Notes: + State has specified state law ...").
//      They were counted as records, and because one of them was text sitting
//      above numeric columns, all four columns typed as STR.
//   2. A card reading "100/100. This data has been cleaned, sourced, and
//      reviewed" on the same screen as a panel reading 4 ISSUES. The score
//      only ever measured row-level flags, and nothing in this build cleans,
//      sources or reviews anything.
//   3. A bottom rail reading "Next: Drop. Put a file in. Nothing is uploaded."
//      with a workbook open, because the rail asked three globals that do not
//      exist in this build and got false every time.
//
// This suite runs the shipped code, not a copy of it: the importer is imported
// from js/, and the two recommendation functions are extracted out of
// canvas/index.html and executed. Every assertion is about what a person would
// read.
//
// RUN WITH: node test/honesty-toasts-footnotes.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aoaToDataset, classifyNonDataRows, summarizeSheets } from '../js/shared/excel-import.js';
import { buildReceiptSpine } from '../js/spine/receipt-spine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const canvas = readFileSync(join(repoRoot, 'canvas', 'index.html'), 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond) {
  if (cond) { passed++; console.log('\u2713 ' + label); }
  else { failed++; console.log('\u2717 FAILED: ' + label); }
}
function eq(label, actual, expected) {
  ok(`${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
    JSON.stringify(actual) === JSON.stringify(expected));
}

function extractFunctionSource(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) return null;
  let depth = 0;
  for (let i = startIdx + startMarker.length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(startIdx, i + 1); }
  }
  return null;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ============================================================
console.log('\n1. The row count is a count of data rows');
// ============================================================

// The shape of the real sheet, trimmed to a handful of states. Row numbers in
// the comments are the numbers Excel shows.
const IDR_SHEET = [
  ['Notices of IDR Initiation by State or Territory'],                  // 1 merged title
  ['State or Territory', 'OON Emergency and Non-Emergency Items or Services', 'OON Air Ambulance Services', 'Total'], // 2 header
  [],                                                                   // 3 blank
  [],                                                                   // 4 blank
  [null, '2025 Q2', '2025 Q2', '2025 Q2'],                              // 5 sub-label
  ['Texas+', 246807, 2270, 249077],                                     // 6
  ['Florida', 92046, 1092, 93138],                                      // 7
  ['Georgia', 47325, 613, 47938],                                       // 8
  ['Guam', 1, 0, 1],                                                    // 9
  ['Source: Notices of IDR Initiation submitted through the Federal IDR portal.'], // 10 footnote
  ['Notes: + State has specified state law or All-Payer Model Agreement.'],        // 11 footnote
];

const idr = aoaToDataset(IDR_SHEET, 'federal-idr-supplemental-tables-2025-q2.xlsx', {
  sheetName: 'Initiations by State',
});

eq('the four real data rows are the only rows loaded', idr.rows.length, 4);
eq('the first data row is the first state, not a label', idr.rows[0][0], 'Texas+');
eq('the last data row is the last territory, not a footnote', idr.rows[3][0], 'Guam');
eq('three rows were identified as notes or labels', idr.nonDataRows.count, 3);
eq('the sub-label is reported by its sheet row number',
  idr.nonDataRows.labels.map((r) => r.sheetRow), [5]);
eq('both footnotes are reported by their sheet row numbers',
  idr.nonDataRows.footnotes.map((r) => r.sheetRow), [10, 11]);

const asideNote = idr.notes.filter((n) => /notes or labels/.test(n))[0] || '';
ok('a note tells the reader how many rows were set aside', /3 rows look like notes or labels/.test(asideNote));
ok('the note names the sub-label row', /row 5/.test(asideNote));
ok('the note names both footnote rows', /rows 10 and 11/.test(asideNote));
ok('the note says the row count is the count of real data rows',
  /count of real data rows/.test(asideNote));
ok('the note promises the file itself is untouched', /file is unchanged/.test(asideNote));
ok('the note is plain language with no em dash', !/\u2014/.test(asideNote));

// Removing the text sub-label is what lets the numeric columns type as numbers.
eq('the numeric columns type as INT once the label row is out',
  idr.columns.map((c) => c.type), ['STR', 'INT', 'INT', 'INT']);

// ============================================================
console.log('\n2. Detection does not eat real data');
// ============================================================

const dataThatLooksChatty = [
  ['Region', 'Cases', 'Total'],
  ['Notes: field office', 12, 12],      // starts with "Notes:" but carries numbers
  ['Source system A', 8, 8],
  [null, 4, 4],                         // blank label cell, real numbers
  ['South', 3, 3],
];
const chatty = aoaToDataset(dataThatLooksChatty, 'chatty.xlsx', {});
eq('a row starting with Notes: is kept when it carries real values', chatty.rows.length, 4);
eq('nothing was set aside from a sheet with no notes or labels', chatty.nonDataRows.count, 0);

const footnoteInTheMiddle = [
  ['State', 'Cases'],
  ['Texas', 10],
  ['Source: this is a note but it is not at the bottom'],
  ['Florida', 4],
];
const middle = aoaToDataset(footnoteInTheMiddle, 'middle.xlsx', {});
ok('a note-looking row with data below it is left alone, because guessing there is worse than counting it',
  middle.rows.length === 3 && middle.nonDataRows.count === 0);

const noBody = aoaToDataset([['A', 'B'], ['Source: only a footnote']], 'empty.xlsx', {});
ok('a sheet whose only body row is a footnote reports no rows rather than one fake one',
  noBody.rows.length === 0 || noBody.nonDataRows.count === 1);

eq('classifyNonDataRows on an empty body reports nothing',
  classifyNonDataRows([], 3).count, 0);

// The sheet picker must promise the number the load will deliver.
const summary = summarizeSheets(['Initiations by State'], () => IDR_SHEET)[0];
eq('the sheet picker counts the same rows the loader will load', summary.rowCount, idr.rows.length);
eq('the sheet picker reports how many rows it discounted', summary.nonDataRowCount, 3);

// ============================================================
console.log('\n3. The canvas carries the same importer');
// ============================================================
ok('the inlined canvas copy has the detector', canvas.includes('function classifyNonDataRows(bodyRows, width)'));
ok('the inlined canvas copy exposes it on DGExcel', canvas.includes('classifyNonDataRows: classifyNonDataRows,'));
ok('the Excel loader carries the detail onto the dataset', canvas.includes('dataset.nonDataRows = result.nonDataRows'));
ok('the Pulse sheet discloses what was set aside',
  canvas.includes('looked like notes or labels, not data'));
ok('that disclosure does not inflate the issue counter',
  (() => {
    const runPulse = extractFunctionSource(canvas, 'function runPulse(dataset) {');
    if (!runPulse) return false;
    const idx = runPulse.indexOf('var aside = dataset.nonDataRows;');
    if (idx === -1) return false;
    const block = runPulse.slice(idx, runPulse.indexOf('Phase 7', idx));
    return !block.includes('issueCount++');
  })());

// ============================================================
console.log('\n4. The recommendation card cannot claim a clean bill with issues open');
// ============================================================

const recSrc = extractFunctionSource(canvas, 'function getFirstRecommendation(score, issues, rows, cols, columns) {');
ok('getFirstRecommendation is present verbatim', recSrc !== null);
const getFirstRecommendation = new Function('return ' + recSrc)();

const perfectWithIssues = getFirstRecommendation(100, 4, 56, 4, [
  { name: 'State or Territory' }, { name: 'Total' },
]);
ok('with 4 issues open the card names the count', /4 issue/.test(perfectWithIssues.body));
ok('with 4 issues open the card never prints a perfect score claim',
  !/100\/100/.test(perfectWithIssues.body));
ok('with issues open the card explains that the score covers row checks only',
  /row check/i.test(perfectWithIssues.body));
ok('with issues open the primary action goes to the issues',
  perfectWithIssues.actions[0].action === 'review');
ok('the card never says cleaned, sourced and reviewed',
  !/cleaned, sourced, and reviewed/.test(perfectWithIssues.body));

const trulyClean = getFirstRecommendation(100, 0, 56, 4, [{ name: 'State or Territory' }]);
ok('with nothing flagged the card says the checks found nothing',
  /No issues found/.test(trulyClean.body));
ok('with nothing flagged the card still does not claim a human reviewed it',
  /not a review by a person/.test(trulyClean.body));
ok('the clean card does not resurrect the old phrase',
  !/cleaned, sourced/.test(trulyClean.body) && !/earned the right/.test(trulyClean.body));

const bigClean = getFirstRecommendation(100, 0, 2000000, 12, [{ name: 'claim_id' }]);
ok('the large-dataset clean card makes no trust claim either',
  !/Data is trusted/.test(bigClean.body) && /No issues found/.test(bigClean.body));

const broken = getFirstRecommendation(20, 7, 56, 4, [{ name: 'State' }]);
ok('a low score still routes to cleaning first', broken.actions[0].action === 'sql');

const phi = getFirstRecommendation(100, 0, 56, 4, [{ name: 'MRN' }, { name: 'Total' }]);
ok('the PHI warning still outranks everything, including a clean score',
  phi.actions[0].action === 'witness');

// ============================================================
console.log('\n4b. The card and the Pulse panel count issues from one place');
// ============================================================
// The first cut of this fix gated the card on dataset.findings alone, so the
// card said "No issues found in 56 rows" while the Pulse panel behind it
// rendered 1. Two counters, one screen. The count is now shared, and the card
// is rewritten if the panel finishes counting after the card is already up.

const countSrc = extractFunctionSource(canvas, 'function nudgeIssueCount(dataset) {');
ok('nudgeIssueCount is present verbatim', countSrc !== null);
const nudgeIssueCount = new Function('return ' + countSrc)();

ok('with nothing counted anywhere the count is 0',
  nudgeIssueCount({ findings: [], rows: [] }) === 0);
ok('a Pulse count is honoured when the load checks found nothing',
  nudgeIssueCount({ findings: [], pulseIssueCount: 4 }) === 4);
ok('a load-check count is honoured when Pulse has not run',
  nudgeIssueCount({ findings: [{}, {}] }) === 2);
ok('when the two disagree the higher, visible number wins',
  nudgeIssueCount({ findings: [{}], pulseIssueCount: 4 }) === 4);
ok('a missing dataset does not throw and reads as 0', nudgeIssueCount(null) === 0);

ok('the card asks nudgeIssueCount rather than counting findings itself',
  /var issues  = nudgeIssueCount\(dataset\);/.test(canvas));
ok('the Pulse sheet records the count it rendered on the dataset',
  canvas.includes('dataset.pulseIssueCount = issueCount'));
ok('the Pulse sheet announces the count it rendered',
  canvas.includes("'dataglow:pulse-issues'"));
['canvas/index.html', 'src/js/flow/analyst-journey.js'].forEach((rel) => {
  const src = readFileSync(join(repoRoot, rel), 'utf8');
  ok(`${rel}: a late Pulse count rewrites the card in place`,
    src.includes('function watchLateIssueCount()') &&
    src.includes('renderNudge(el, _nudgeDataset)'));
  ok(`${rel}: the watcher is wired at startup`, src.includes('watchLateIssueCount();'));
  ok(`${rel}: rendering is separate from showing so it can run twice`,
    src.includes('function renderNudge(el, dataset) {') &&
    src.includes('renderNudge(el, dataset);'));
});

// ============================================================
console.log('\n5. The Pulse sheet recommendation agrees with its own issue counter');
// ============================================================

const pulseRecSrc = extractFunctionSource(canvas, 'function getPulseRec(score, issues) {');
ok('getPulseRec now takes the issue count as well as the score', pulseRecSrc !== null);
const getPulseRec = new Function('return ' + pulseRecSrc)();

const pulseContradiction = getPulseRec(100, 4);
ok('a 100 score with 4 issues reads as 4 issues', /4 issue/.test(pulseContradiction.text));
ok('and sends the reader to read them', pulseContradiction.action === 'review');
ok('and does not say cleaned, traced and reviewed',
  !/cleaned, traced/.test(pulseContradiction.text));

const pulseClean = getPulseRec(100, 0);
ok('with nothing flagged the Pulse line says exactly that',
  /found nothing to flag/.test(pulseClean.text));
ok('the Pulse line does not claim a review happened',
  /not a review by a person/.test(pulseClean.text));

ok('the recommendation waits for the issue count before it renders',
  canvas.includes("var issuesEl = document.getElementById('dg-ps-issues-val');")
  && canvas.includes('injectPulseRec(sheet, healthEl.textContent, issuesEl.textContent);'));

// ============================================================
console.log('\n6. No quality claim survives anywhere in visible copy');
// ============================================================

const FORBIDDEN = [
  'cleaned, sourced, and reviewed',
  'cleaned, traced, and reviewed',
  'Data is trusted',
  'earned the right to be visualized',
  'earned the right to visualize',
];
['canvas/index.html', 'src/js/flow/analyst-journey.js'].forEach((rel) => {
  const src = stripComments(readFileSync(join(repoRoot, rel), 'utf8'));
  FORBIDDEN.forEach((phrase) => {
    ok(`${rel}: "${phrase}" appears in no live string`, !src.includes(phrase));
  });
});

// ============================================================
console.log('\n7. The status rail reports the load state it actually observed');
// ============================================================

const empty = buildReceiptSpine({});
eq('with nothing loaded the rail still asks for a file', empty.currentId, 'drop');
ok('with nothing loaded it is honest that nothing is loaded',
  /No file is loaded yet/.test(empty.loadedLine));
ok('with nothing loaded the privacy promise is still on screen',
  /Nothing is uploaded/.test(empty.headline));

const loaded = buildReceiptSpine({ hasTable: true, tableName: 'Initiations by State' });
ok('with a table loaded the rail names what is loaded',
  /Loaded: Initiations by State/.test(loaded.loadedLine));
ok('with a table loaded the rail no longer says nothing is uploaded',
  !/Nothing is uploaded/.test(loaded.headline) && !/Nothing is uploaded/.test(loaded.loadedLine));
ok('with a table loaded the privacy fact is still stated, in the present tense',
  /not uploaded/.test(loaded.loadedLine));
ok('the Drop step reads as done rather than as an instruction',
  loaded.steps[0].state === 'done' && /A file is loaded/.test(loaded.steps[0].oneLine));
ok('the instruction wording is still available for anything that wants it',
  loaded.steps[0].todoLine === 'Put a file in. Nothing is uploaded.');

const loadedUnnamed = buildReceiptSpine({ hasTable: true });
ok('a loaded table with no name still reads honestly',
  /A table is loaded/.test(loadedUnnamed.loadedLine));

['js/spine/data-glow-receipt-spine-canvas.js', 'canvas/index.html'].forEach((rel) => {
  const src = readFileSync(join(repoRoot, rel), 'utf8');
  ok(`${rel}: the rail asks the dataset registry whether a table is loaded`,
    src.includes('typeof window.getActiveDataset === \'function\' && window.getActiveDataset()'));
  ok(`${rel}: the rail re-reads when a dataset is announced`,
    src.includes("'dataglow:dataset-loaded', 'dataglow:dataset-updated'"));
  ok(`${rel}: the rail prints the load line the model computed`,
    src.includes('model.loadedLine'));
});

// ============================================================
console.log('\n8. Plain language, no em dashes in what was added');
// ============================================================
[
  asideNote,
  perfectWithIssues.body,
  trulyClean.body,
  bigClean.body,
  pulseContradiction.text,
  pulseClean.text,
  loaded.loadedLine,
  loaded.steps[0].oneLine,
  empty.loadedLine,
].forEach((line, i) => {
  ok(`added line ${i + 1} has no em dash`, !/\u2014/.test(line));
});

console.log(`\nhonesty-toasts-footnotes: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
