/**
 * Proof Board, Glowbook, coach moments and session tiles.
 *
 * Pure Node: no DuckDB, no DOM, no network, so this suite runs identically with
 * Air-Gap Mode on. The GlassBox engine is imported directly rather than stubbed,
 * because the point of composing it is that proof on this board is the same
 * object other surfaces produce, and a stub would let the two drift apart.
 */
import {
  PROOF_BOARD_KIND,
  PROOF_BOARD_VERSION,
  TILE_GATE_BADGES,
  BADGE_LABELS,
  BADGE_WHY,
  PROOF_BOARD_DISCLAIMER,
  EMPTY_BOARD_HEADLINE,
  hasValue,
  formatTileValue,
  normalizeTile,
  buildTileGlassBox,
  buildProofBoard,
  summarizeBoard,
  verifyBoard,
  tileReceiptClaim,
  DataGlowProofBoard,
} from '../js/proofboard/proof-board.js';

import {
  GLOWBOOK_KIND,
  GLOWBOOK_DISCLAIMER,
  GLOWBOOK_NOT_ZK,
  escapeHtml,
  buildGlowbook,
  renderGlowbookHTML,
  glowbookBlob,
  DataGlowGlowbook,
} from '../js/proofboard/glowbook.js';

import {
  COACH_STEPS,
  COACH_SEEN_KEY,
  stepsForDom,
  clampStep,
  coachStripModel,
  shouldShowCoach,
  DataGlowProofBoardCoach,
} from '../js/proofboard/coach-moments.js';

import {
  SQL_RELATION,
  isBlank,
  quoteIdent,
  countCompleteRows,
  blanksByColumn,
  countDistinct,
  tilesFromDataset,
  DataGlowProofBoardTiles,
} from '../js/proofboard/session-tiles.js';

import { buildGlassBox, GLASS_BOX_KIND } from '../js/glassbox/glass-box.js';

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error('FAIL ' + name);
  console.log('  ✓ ' + name);
  passed += 1;
}

function tile(over) {
  return Object.assign({
    id: 't1',
    title: 'Rows loaded',
    value: 120,
    unit: 'rows',
    sqlOrCode: 'SELECT COUNT(*) FROM t;',
    language: 'sql',
    engine: 'this device',
    gateBadge: 'clear',
    checksSummary: 'Counted on this device.',
  }, over || {});
}

// ---------------------------------------------------------------- value honesty

console.log('\nvalue honesty');
ok('a finite number is a value', hasValue(0) === true);
ok('zero is a real value when it was computed', hasValue(0) === true);
ok('null is not a value', hasValue(null) === false);
ok('undefined is not a value', hasValue(undefined) === false);
ok('NaN is not a value', hasValue(NaN) === false);
ok('Infinity is not a value', hasValue(Infinity) === false);
ok('the empty string is not a value', hasValue('') === false);
ok('whitespace only is not a value', hasValue('   ') === false);
ok('a non-empty string is a value', hasValue('n/a') === true);
ok('false is a value', hasValue(false) === true);
ok('an object is not a value', hasValue({}) === false);

ok('an integer formats without decimals', formatTileValue(120, 'rows') === '120 rows');
ok('a float is trimmed rather than rounded to nothing', formatTileValue(1.23456, '') === '1.2346');
ok('no unit means no trailing space', formatTileValue(7, '') === '7');
ok('an absent value formats as empty, never as zero', formatTileValue(null, 'rows') === '');
ok('an absent value never yields the string zero', formatTileValue(undefined, '') !== '0');

// ---------------------------------------------------------------- tile model

console.log('\ntile model');
const t1 = normalizeTile(tile(), 0);
ok('a good tile is complete', t1.complete === true);
ok('a good tile lists no problems', t1.problems.length === 0);
ok('the value text carries the unit', t1.valueText === '120 rows');
ok('the badge survives', t1.gateBadge === 'clear');
ok('the badge gets its label', t1.badgeLabel === BADGE_LABELS.clear);
ok('the badge gets its reason', t1.badgeWhy === BADGE_WHY.clear);

const bad = normalizeTile(null, 3);
ok('a null tile does not throw', !!bad);
ok('a null tile is incomplete', bad.complete === false);
ok('a null tile still gets an id from its position', bad.id === 'tile-4');
ok('a null tile reports several problems', bad.problems.length >= 3);
ok('a null tile has a null value, not a zero', bad.value === null);
ok('a null tile renders an empty value', bad.valueText === '');

const noCode = normalizeTile(tile({ sqlOrCode: '   ' }), 0);
ok('a tile with blank code is incomplete', noCode.complete === false);
ok('a tile with blank code says so', noCode.problems.join(' ').indexOf('did not hand over') >= 0);

const noValue = normalizeTile(tile({ value: null }), 0);
ok('a tile with no value is incomplete', noValue.complete === false);
ok('a missing value is explained as not-a-zero',
  noValue.problems.join(' ').indexOf('zero') >= 0);

ok('an unknown language falls back to text', normalizeTile(tile({ language: 'brainfuck' }), 0).language === 'text');
ok('a known language survives', normalizeTile(tile({ language: 'python' }), 0).language === 'python');
ok('an unknown badge falls back to unknown',
  normalizeTile(tile({ gateBadge: 'green' }), 0).gateBadge === 'unknown');
ok('a missing badge falls back to unknown',
  normalizeTile(tile({ gateBadge: undefined }), 0).gateBadge === 'unknown');
ok('unknown is one of the legal badges', TILE_GATE_BADGES.indexOf('unknown') >= 0);
ok('there are exactly four badges', TILE_GATE_BADGES.length === 4);
ok('unknown never reads as passed', BADGE_LABELS.unknown.toLowerCase().indexOf('passed') < 0);
ok('unknown says no check reported', BADGE_WHY.unknown.indexOf('No check') >= 0);
ok('unknown states absence of evidence', BADGE_WHY.unknown.indexOf('absence of evidence') >= 0);

// A caller cannot label a tile clear while handing over a blocked gate result.
const lying = normalizeTile(tile({
  gateBadge: 'clear',
  gates: { publishSafe: { level: 'blocked' } },
}), 0);
ok('a real gate result beats the caller label', lying.gateBadge === 'blocked');
ok('the disagreement is reported', lying.problems.join(' ').indexOf('but the gate result') >= 0);
ok('the disagreement makes the tile incomplete', lying.complete === false);

const agreeing = normalizeTile(tile({
  gateBadge: 'caution',
  gates: { publishSafe: { level: 'caution' } },
}), 0);
ok('agreement raises no problem', agreeing.problems.length === 0);
ok('agreement keeps the badge', agreeing.gateBadge === 'caution');

ok('source columns are cleaned', normalizeTile(tile({ sourceCols: ['a', '', '  b  ', null] }), 0)
  .sourceCols.join(',') === 'a,b');
ok('a non-array sourceCols is ignored',
  normalizeTile(tile({ sourceCols: 'a,b' }), 0).sourceCols.length === 0);

// ---------------------------------------------------------------- glass box composition

console.log('\nglass box composition');
const gb = buildTileGlassBox(tile());
ok('the tile proof is a real GlassBox model', gb.kind === GLASS_BOX_KIND);
ok('the headline names the tile and its number', gb.finding.headline === 'Rows loaded: 120 rows');
ok('the code is carried through', gb.math.source.indexOf('SELECT COUNT(*)') >= 0);
ok('the language is carried through', gb.math.language === 'sql');
ok('the engine is carried through', gb.math.engine === 'this device');
ok('the proof is marked available', gb.math.available === true);

const gbKeys = Object.keys(gb);
ok('finding comes before math', gbKeys.indexOf('finding') < gbKeys.indexOf('math'));
ok('math comes before badges', gbKeys.indexOf('math') < gbKeys.indexOf('badges'));
ok('badges come before missing', gbKeys.indexOf('badges') < gbKeys.indexOf('missing'));

const gbNoGate = buildTileGlassBox(tile({ gateBadge: 'clear' }));
ok('a badge alone is never forged into a gate chip', gbNoGate.badges.length === 0);
ok('the absent gate is reported as missing',
  gbNoGate.missing.some((m) => m.what === 'the gates'));
ok('a board with no gate result is level unknown, not good', gbNoGate.level === 'unknown');

const gbRealGate = buildTileGlassBox(tile({ gates: { publishSafe: { level: 'clear' } } }));
ok('a real gate result does produce a chip', gbRealGate.badges.length === 1);
ok('the chip comes from publish-safe', gbRealGate.badges[0].id === 'publish-safe');
ok('a real clear gate reads as good', gbRealGate.level === 'good');

const gbNoValue = buildTileGlassBox(tile({ value: null }));
ok('a valueless tile says so in the headline',
  gbNoValue.finding.headline.indexOf('no value arrived') >= 0);
ok('a valueless tile never shows a zero', gbNoValue.finding.headline.indexOf(': 0') < 0);

const gbNoCode = buildTileGlassBox(tile({ sqlOrCode: '' }));
ok('a codeless tile has no math', gbNoCode.math.available === false);
ok('a codeless tile reports the code as missing',
  gbNoCode.missing.some((m) => m.what === 'the code'));
ok('nothing is reconstructed for a codeless tile', gbNoCode.math.source === '');

let injected = 0;
buildTileGlassBox(tile(), function (input) { injected += 1; return buildGlassBox(input); });
ok('an injected glass box implementation is used', injected === 1);

ok('the detail carries the checks summary',
  buildTileGlassBox(tile()).finding.detail.indexOf('Counted on this device.') >= 0);
ok('the detail carries the columns used',
  buildTileGlassBox(tile({ sourceCols: ['a', 'b'] })).finding.detail.indexOf('Columns used: a, b') >= 0);
ok('the detail carries the problems of a broken tile',
  buildTileGlassBox(tile({ value: null })).finding.detail.indexOf('zero') >= 0);

// ---------------------------------------------------------------- board

console.log('\nboard');
const board = buildProofBoard([tile(), tile({ id: 't2', title: 'Columns', value: 8, unit: '' })], {
  datasetName: 'sales.csv', rowCount: 120, columnCount: 8, generatedAt: 1700000000000,
});
ok('the board is the right kind', board.kind === PROOF_BOARD_KIND);
ok('the board carries a version', board.version === PROOF_BOARD_VERSION);
ok('both tiles are kept', board.tiles.length === 2);
ok('the board is not empty', board.empty === false);
ok('an occupied board has no empty state', board.emptyState === null);
ok('the dataset name is carried', board.datasetName === 'sales.csv');
ok('the row count is carried', board.rowCount === 120);
ok('the stats count the tiles', board.stats.total === 2);
ok('the stats count the complete ones', board.stats.complete === 2);
ok('the board carries the disclaimer', board.disclaimer === PROOF_BOARD_DISCLAIMER);
ok('the disclaimer refuses the word certification',
  PROOF_BOARD_DISCLAIMER.indexOf('not a certification') >= 0);

const emptyBoard = buildProofBoard([], {});
ok('an empty board is marked empty', emptyBoard.empty === true);
ok('an empty board offers an empty state', !!emptyBoard.emptyState);
ok('the empty state names the reason', emptyBoard.emptyState.headline === EMPTY_BOARD_HEADLINE);
ok('the empty state offers one action', emptyBoard.emptyState.cta.indexOf('Load a file') >= 0);
ok('an empty board has no tiles', emptyBoard.tiles.length === 0);
ok('an empty board reports zero, not a fake tile', emptyBoard.stats.total === 0);

ok('a non-array tile list does not throw', buildProofBoard(null, null).tiles.length === 0);
ok('a board from garbage is empty', buildProofBoard('nope', null).empty === true);
ok('garbage session meta does not throw', buildProofBoard([tile()], 'nope').tiles.length === 1);
ok('a missing generatedAt is zero, not now', buildProofBoard([tile()], {}).generatedAt === 0);

const badTileBoard = buildProofBoard([tile(), null, tile({ id: 't3', sqlOrCode: '' })], {});
ok('a bad tile is kept rather than dropped', badTileBoard.tiles.length === 3);
ok('the bad tiles are counted as incomplete', badTileBoard.stats.incomplete === 2);
ok('the good tile is still complete', badTileBoard.tiles[0].complete === true);

const dupes = buildProofBoard([tile({ id: 'same' }), tile({ id: 'same' })], {});
ok('a duplicate id is renamed rather than overwritten', dupes.tiles[1].id !== dupes.tiles[0].id);
ok('the rename is reported', dupes.tiles[1].problems.join(' ').indexOf('already used this id') >= 0);
ok('the renamed tile is marked incomplete', dupes.tiles[1].complete === false);

const uncheckedBoard = buildProofBoard([tile({ gateBadge: 'unknown' }), tile({ id: 'b', gateBadge: 'blocked' })], {});
ok('unchecked tiles are counted', uncheckedBoard.stats.unchecked === 1);
ok('blocked tiles are counted', uncheckedBoard.stats.blocked === 1);

ok('the summary leads with the tile count', summarizeBoard(board).indexOf('2 tiles') === 0);
ok('the summary names unchecked tiles',
  summarizeBoard(uncheckedBoard).indexOf('no check reported') >= 0);
ok('the summary names blocked tiles', summarizeBoard(uncheckedBoard).indexOf('blocked') >= 0);
ok('an empty board summarizes as empty', summarizeBoard(emptyBoard) === EMPTY_BOARD_HEADLINE);
ok('garbage summarizes without throwing', summarizeBoard(null) === 'No board to describe.');
ok('one tile is singular', summarizeBoard(buildProofBoard([tile()], {})).indexOf('1 tile,') === 0);

// ---------------------------------------------------------------- verify

console.log('\nverify');
const goodVerify = verifyBoard(buildProofBoard([
  tile({ gates: { publishSafe: { level: 'clear' } }, datasetFingerprint: 'abc' }),
  tile({ id: 't2', gates: { publishSafe: { level: 'clear' } }, datasetFingerprint: 'abc' }),
], {}));
ok('a well formed board passes', goodVerify.ok === true);
ok('the pass is not overclaimed', goodVerify.headline.indexOf('not that the numbers are right') >= 0);
ok('five things are checked', goodVerify.checked.length === 5);
ok('every check reports a note', goodVerify.checked.every((c) => typeof c.note === 'string' && c.note));

const gapVerify = verifyBoard(buildProofBoard([tile({ sqlOrCode: '' })], {}));
ok('a board missing code does not pass', gapVerify.ok === false);
ok('the failing check is named', gapVerify.checked.some((c) => !c.pass && c.what.indexOf('code') >= 0));
ok('the headline counts the failures', gapVerify.headline.indexOf('of 5 board checks') >= 0);

ok('verify never claims to have re-run the queries',
  goodVerify.cannotCheck.join(' ').indexOf('re-running here') >= 0);
ok('verify admits it cannot judge the choice of numbers',
  goodVerify.cannotCheck.join(' ').indexOf('right numbers') >= 0);
ok('verify lists what it cannot check', goodVerify.cannotCheck.length === 2);
ok('verifying nothing does not throw', verifyBoard(null).ok === false);
ok('verifying nothing says so', verifyBoard(null).headline === 'There is no board to verify.');

const mixed = verifyBoard(buildProofBoard([
  tile({ datasetFingerprint: 'aaa' }),
  tile({ id: 't2', datasetFingerprint: 'bbb' }),
], {}));
ok('two datasets on one board is caught',
  mixed.checked.some((c) => !c.pass && c.what.indexOf('one dataset') >= 0));
ok('the mixed dataset note says the numbers are not comparable',
  mixed.checked.filter((c) => c.what.indexOf('one dataset') >= 0)[0].note.indexOf('not comparable') >= 0);

const uncheckedVerify = verifyBoard(buildProofBoard([tile({ gateBadge: 'unknown' })], {}));
ok('a board with no gate results does not pass', uncheckedVerify.ok === false);
ok('the unchecked note refuses the word passed',
  uncheckedVerify.checked.filter((c) => c.what.indexOf('gate result') >= 0)[0]
    .note.indexOf('not passed') >= 0);

// ---------------------------------------------------------------- receipt claim

console.log('\nreceipt claim');
const claim = tileReceiptClaim(tile(), board);
ok('the claim carries a label', claim.claim.label === 'Rows loaded');
ok('the claim carries the value as shown', claim.claim.value === '120 rows');
ok('the claim reads as a sentence', claim.claim.statement === 'Rows loaded is 120 rows');
ok('the claim carries the query chain', claim.queryOrTransformChain.length === 1);
ok('the chain carries the source', claim.queryOrTransformChain[0].source.indexOf('SELECT') >= 0);
ok('the claim carries the validation state', claim.validationStateAtCompute.grade === 'clear');
ok('a valueless tile states that plainly',
  tileReceiptClaim(tile({ value: null }), board).claim.statement.indexOf('no value recorded') >= 0);
ok('a codeless tile has an empty chain',
  tileReceiptClaim(tile({ sqlOrCode: '' }), board).queryOrTransformChain.length === 0);
ok('no hash is computed in this module', claim.commitment === undefined);

// ---------------------------------------------------------------- glowbook

console.log('\nglowbook');
ok('ampersand is escaped', escapeHtml('a & b') === 'a &amp; b');
ok('angle brackets are escaped', escapeHtml('<b>') === '&lt;b&gt;');
ok('quotes are escaped', escapeHtml('"x"') === '&quot;x&quot;');
ok('apostrophes are escaped', escapeHtml("it's") === 'it&#39;s');
ok('null escapes to empty', escapeHtml(null) === '');
ok('a script tag cannot survive escaping',
  escapeHtml('</script><script>alert(1)</script>').indexOf('<script') < 0);

const gbook = buildGlowbook(board, { title: 'Q3 board', generatedAt: 1700000000000 });
ok('the glowbook is the right kind', gbook.kind === GLOWBOOK_KIND);
ok('the title is carried', gbook.title === 'Q3 board');
ok('a missing title falls back', buildGlowbook(board, {}).title === 'Proof Board');
ok('the tiles are carried', gbook.tiles.length === 2);
ok('the summary is carried', gbook.summary.indexOf('2 tiles') === 0);
ok('the verification is carried', !!gbook.verification && Array.isArray(gbook.verification.checked));
ok('the disclaimer is carried', gbook.disclaimer === GLOWBOOK_DISCLAIMER);
ok('the not-a-proof note is carried', gbook.notZeroKnowledge === GLOWBOOK_NOT_ZK);
ok('a null board does not throw', buildGlowbook(null, null).empty === true);

const html = renderGlowbookHTML(gbook);
ok('the document is html', html.indexOf('<!DOCTYPE html>') === 0);
ok('the document closes', html.trim().slice(-7) === '</html>');
ok('the document carries the title', html.indexOf('<title>Q3 board</title>') >= 0);
ok('every tile title appears', html.indexOf('Rows loaded') >= 0 && html.indexOf('Columns') >= 0);
ok('the value appears', html.indexOf('120 rows') >= 0);
ok('the code appears under the number', html.indexOf('SELECT COUNT(*) FROM t;') >= 0);
ok('the code is inside a pre block', html.indexOf('<pre class="gb-code">') >= 0);

const iValue = html.indexOf('class="gb-value"');
const iCode = html.indexOf('<pre class="gb-code">');
ok('the finding is rendered above the proof', iValue >= 0 && iCode > iValue);

ok('the disclaimer is in the document', html.indexOf('not a certification') >= 0);
ok('the document refuses the word audit', html.indexOf('not an audit') >= 0);
ok('the document refuses compliance claims', html.indexOf('not a compliance claim') >= 0);
ok('the document refuses legal advice', html.indexOf('not legal or clinical advice') >= 0);
ok('the document states unchecked is not passed',
  html.indexOf('has not passed anything') >= 0);
ok('the document states it is not a cryptographic proof',
  html.indexOf('not a cryptographic proof') >= 0);

ok('the document contains no script tag', html.toLowerCase().indexOf('<script') < 0);
ok('the document contains no iframe', html.toLowerCase().indexOf('<iframe') < 0);
ok('the document has no inline event handler', /\son[a-z]+\s*=/i.test(html) === false);
ok('the document fetches nothing', html.indexOf('http://') < 0 && html.indexOf('https://') < 0);
ok('the document has no external stylesheet', html.indexOf('<link') < 0);

const nastyHtml = renderGlowbookHTML(buildGlowbook(buildProofBoard([
  tile({ title: '<img src=x onerror=alert(1)>', sqlOrCode: '</style></head><script>bad()</script>' }),
], {}), {}));
ok('a hostile tile title cannot inject markup', nastyHtml.indexOf('<img src=x') < 0);
ok('a hostile query cannot inject a script', nastyHtml.toLowerCase().indexOf('<script>bad') < 0);
ok('a hostile query cannot close the style block', nastyHtml.indexOf('</style></head>') < 0);
ok('the hostile text is still shown, escaped', nastyHtml.indexOf('&lt;img src=x') >= 0);

const emptyHtml = renderGlowbookHTML(buildGlowbook(emptyBoard, {}));
ok('an empty board exports a document', emptyHtml.indexOf('<!DOCTYPE html>') === 0);
ok('an empty export says it is empty', emptyHtml.indexOf('Nothing to show') >= 0);
ok('an empty export contains no zeroes standing in for numbers',
  emptyHtml.indexOf('page of zeroes') >= 0);
ok('an empty export still carries the disclaimer', emptyHtml.indexOf('not a certification') >= 0);

const unknownHtml = renderGlowbookHTML(buildGlowbook(
  buildProofBoard([tile({ gateBadge: 'unknown' })], {}), {}));
ok('an unchecked tile exports as not checked', unknownHtml.indexOf('Not checked') >= 0);
// The stylesheet always defines all four badge classes, so this looks for the
// badge element itself rather than the bare class name.
ok('an unchecked tile does not export as passed',
  unknownHtml.indexOf('"gb-badge gb-badge-clear"') < 0);
ok('an unchecked tile carries the unknown badge element',
  unknownHtml.indexOf('"gb-badge gb-badge-unknown"') >= 0);

const ledgerHtml = renderGlowbookHTML(buildGlowbook(board, {
  trustLedgerSummary: '3 rows recorded this session',
  trustLedgerEntries: ['export-attempt: clear', 'gate-verdict: caution'],
}));
ok('a supplied ledger summary is exported', ledgerHtml.indexOf('3 rows recorded this session') >= 0);
ok('ledger entries are exported', ledgerHtml.indexOf('export-attempt: clear') >= 0);
ok('no ledger means no ledger section', html.indexOf('Trust Ledger</h2>') < 0);

const blob = glowbookBlob(gbook, 'Q3 board!!');
ok('the blob carries the html', blob.data.indexOf('<!DOCTYPE html>') === 0);
ok('the filename is cleaned', blob.filename === 'Q3-board.html');
ok('the mime type is html', blob.mimeType.indexOf('text/html') === 0);
ok('a missing stem falls back', glowbookBlob(gbook, '').filename === 'glowbook.html');
ok('a hostile stem cannot escape the filename',
  glowbookBlob(gbook, '../../etc/passwd').filename.indexOf('/') < 0);

// ---------------------------------------------------------------- coach

console.log('\ncoach');
ok('there are five coach steps', COACH_STEPS.length === 5);
ok('the spec asks for four to six', COACH_STEPS.length >= 4 && COACH_STEPS.length <= 6);
ok('every step has an id', COACH_STEPS.every((s) => typeof s.id === 'string' && s.id));
ok('every step has a title', COACH_STEPS.every((s) => typeof s.title === 'string' && s.title));
ok('every step has a body', COACH_STEPS.every((s) => typeof s.body === 'string' && s.body));
ok('every step has a target', COACH_STEPS.every((s) => typeof s.target === 'string' && s.target));
ok('step ids are unique', new Set(COACH_STEPS.map((s) => s.id)).size === COACH_STEPS.length);
ok('every body is short enough to read in place',
  COACH_STEPS.every((s) => s.body.length <= 220));
ok('the steps are frozen', Object.isFrozen(COACH_STEPS));
ok('a step names the honesty rule',
  COACH_STEPS.some((s) => s.body.indexOf('never turns green') >= 0));
ok('a step says the export asks first',
  COACH_STEPS.some((s) => s.body.indexOf('asks first') >= 0));
ok('a step says verify does not re-run',
  COACH_STEPS.some((s) => s.body.indexOf('does not re-run') >= 0));

ok('all steps survive when every target exists', stepsForDom(() => true).length === 5);
ok('no steps survive when no target exists', stepsForDom(() => false).length === 0);
ok('only steps with a live target survive',
  stepsForDom((id) => id === 'dg-pb-verify').length === 1);
ok('a throwing lookup drops the step', stepsForDom(() => { throw new Error('x'); }).length === 0);
ok('a missing lookup returns everything', stepsForDom(null).length === 5);

ok('a step index below zero clamps up', clampStep(-4, 5) === 0);
ok('a step index past the end clamps down', clampStep(99, 5) === 4);
ok('a fractional index floors', clampStep(2.9, 5) === 2);
ok('a garbage index becomes zero', clampStep('x', 5) === 0);
ok('an empty list clamps to zero', clampStep(3, 0) === 0);

const m0 = coachStripModel(COACH_STEPS, 0);
ok('the first step knows it is first', m0.isFirst === true);
ok('the first step is not last', m0.isLast === false);
ok('the progress reads one of five', m0.progress === '1 of 5');
ok('the next label is Next', m0.nextLabel === 'Next');
const mLast = coachStripModel(COACH_STEPS, 4);
ok('the last step knows it is last', mLast.isLast === true);
ok('the last step offers Done', mLast.nextLabel === 'Done');
ok('an out of range index still returns a step', coachStripModel(COACH_STEPS, 99).index === 4);
ok('an empty list returns nothing to show', coachStripModel([], 0) !== null);

ok('the coach shows when never dismissed', shouldShowCoach(() => null, true) === true);
ok('the coach stays away once dismissed', shouldShowCoach(() => '1', true) === false);
ok('a flag that is off wins', shouldShowCoach(() => null, false) === false);
ok('unreadable storage does not hide the coach',
  shouldShowCoach(() => { throw new Error('denied'); }, true) === true);
ok('no reader means show', shouldShowCoach(null, true) === true);
ok('the dismissal key is namespaced', COACH_SEEN_KEY.indexOf('dataglow.') === 0);

// ---------------------------------------------------------------- session tiles

console.log('\nsession tiles');
const ds = {
  name: 'sales.csv',
  columns: [{ name: 'id', type: 'STR' }, { name: 'region', type: 'STR' }, { name: 'amount', type: 'FLOAT' }],
  rows: [
    ['a1', 'North', 10],
    ['a2', 'South', null],
    ['a3', 'North', 30],
    ['a4', '', 40],
  ],
};

ok('null is blank', isBlank(null) === true);
ok('empty string is blank', isBlank('') === true);
ok('whitespace is blank', isBlank('  ') === true);
ok('zero is not blank', isBlank(0) === false);
ok('false is not blank', isBlank(false) === false);

ok('an identifier is quoted', quoteIdent('region') === '"region"');
ok('an embedded quote is doubled', quoteIdent('we"ird') === '"we""ird"');
ok('an injection attempt stays inside the quotes',
  quoteIdent('a"; DROP TABLE t; --').indexOf('"a""; DROP TABLE t; --"') === 0);

ok('complete rows are counted', countCompleteRows(ds.rows, 3) === 2);
ok('a non-array row list is zero', countCompleteRows(null, 3) === 0);
ok('blanks are counted per column', blanksByColumn(ds.rows, 3).join(',') === '0,1,1');
ok('distinct values skip blanks', countDistinct(ds.rows, 1) === 2);
ok('distinct counts every unique key', countDistinct(ds.rows, 0) === 4);

const tiles = tilesFromDataset(ds, { fingerprint: 'fp1' });
ok('a real dataset produces tiles', tiles.length >= 4);
ok('every tile is normalized', tiles.every((t) => t.complete !== undefined));
ok('every tile carries code', tiles.every((t) => t.sqlOrCode.trim().length > 0));
ok('every tile carries a value', tiles.every((t) => hasValue(t.value)));
ok('every tile carries the fingerprint', tiles.every((t) => t.datasetFingerprint === 'fp1'));
ok('no tile is incomplete', tiles.every((t) => t.complete === true));

function tileById(id) { return tiles.filter((t) => t.id === id)[0]; }
ok('the row count tile is the real row count', tileById('rows').value === 4);
ok('the row count tile shows real SQL',
  tileById('rows').sqlOrCode.indexOf('SELECT COUNT(*)') >= 0);
ok('the complete rows tile agrees with the JS count', tileById('complete-rows').value === 2);
ok('the complete rows SQL tests every column',
  tileById('complete-rows').sqlOrCode.split('IS NOT NULL').length - 1 === 3);
ok('the emptiest column tile names a real column',
  tileById('emptiest-column').title.indexOf('region') >= 0
  || tileById('emptiest-column').title.indexOf('amount') >= 0);
ok('the emptiest column tile counts one blank', tileById('emptiest-column').value === 1);
ok('the distinct tile agrees with the JS count', tileById('distinct-first-column').value === 4);
ok('the distinct SQL uses COUNT DISTINCT',
  tileById('distinct-first-column').sqlOrCode.indexOf('COUNT(DISTINCT') >= 0);
ok('tiles without a gate result are marked not checked',
  tileById('rows').gateBadge === 'unknown');
ok('the relation name is used in the SQL',
  tileById('rows').sqlOrCode.indexOf(SQL_RELATION) >= 0);

ok('no dataset means no tiles', tilesFromDataset(null, {}).length === 0);
ok('no rows means no tiles', tilesFromDataset({ columns: ds.columns, rows: [] }, {}).length === 0);
ok('no columns means no tiles', tilesFromDataset({ columns: [], rows: ds.rows }, {}).length === 0);
ok('garbage does not throw', tilesFromDataset('nope', null).length === 0);
ok('a dataset with no blanks skips the blanks tile',
  tilesFromDataset({ columns: ds.columns, rows: [['a', 'b', 1]] }, {})
    .filter((t) => t.id === 'emptiest-column').length === 0);

const scored = tilesFromDataset(Object.assign({}, ds, { score: 91 }), {});
ok('a real validation score becomes a tile',
  scored.filter((t) => t.id === 'health-score').length === 1);
ok('a high score reads as clear',
  scored.filter((t) => t.id === 'health-score')[0].gateBadge === 'clear');
ok('the score tile explains the banding',
  scored.filter((t) => t.id === 'health-score')[0].checksSummary.indexOf('bands that score') >= 0);
ok('the score tile admits there is no SQL for it',
  scored.filter((t) => t.id === 'health-score')[0].sqlOrCode.indexOf('no SQL') >= 0);
ok('a low score reads as blocked',
  tilesFromDataset(Object.assign({}, ds, { score: 20 }), {})
    .filter((t) => t.id === 'health-score')[0].gateBadge === 'blocked');
ok('a middling score reads as caution',
  tilesFromDataset(Object.assign({}, ds, { score: 60 }), {})
    .filter((t) => t.id === 'health-score')[0].gateBadge === 'caution');
ok('no score means no score tile',
  tilesFromDataset(ds, {}).filter((t) => t.id === 'health-score').length === 0);
ok('a non-numeric score is not a tile',
  tilesFromDataset(Object.assign({}, ds, { score: 'good' }), {})
    .filter((t) => t.id === 'health-score').length === 0);

// The board built from a real dataset must survive its own verifier.
const realBoard = buildProofBoard(tiles, { datasetName: ds.name, datasetFingerprint: 'fp1' });
ok('a board from real tiles is not empty', realBoard.empty === false);
ok('a board from real tiles has unique ids',
  new Set(realBoard.tiles.map((t) => t.id)).size === realBoard.tiles.length);
const realVerify = verifyBoard(realBoard);
ok('real tiles pass the code check',
  realVerify.checked.filter((c) => c.what.indexOf('code') >= 0)[0].pass === true);
ok('real tiles pass the value check',
  realVerify.checked.filter((c) => c.what.indexOf('value') >= 0)[0].pass === true);
ok('real tiles pass the one-dataset check',
  realVerify.checked.filter((c) => c.what.indexOf('one dataset') >= 0)[0].pass === true);
ok('real tiles do not pass the gate check, because no gate ran',
  realVerify.checked.filter((c) => c.what.indexOf('gate result') >= 0)[0].pass === false);

// ---------------------------------------------------------------- house shape

console.log('\nhouse shape');
const namespaces = [
  ['DataGlowProofBoard', DataGlowProofBoard],
  ['DataGlowGlowbook', DataGlowGlowbook],
  ['DataGlowProofBoardCoach', DataGlowProofBoardCoach],
  ['DataGlowProofBoardTiles', DataGlowProofBoardTiles],
];
for (const [name, ns] of namespaces) {
  ok(name + ' is published', !!ns && typeof ns === 'object');
  ok(name + ' publishes only defined members',
    Object.keys(ns).every((k) => ns[k] !== undefined));
}
ok('the board namespace exposes its builder', typeof DataGlowProofBoard.buildProofBoard === 'function');
ok('the glowbook namespace exposes its renderer', typeof DataGlowGlowbook.renderGlowbookHTML === 'function');
ok('the coach namespace exposes its steps', Array.isArray(DataGlowProofBoardCoach.COACH_STEPS));
ok('the tiles namespace exposes its builder', typeof DataGlowProofBoardTiles.tilesFromDataset === 'function');

// An em dash in product text is a hard rule violation in this repo, and this is
// the gate that catches it before it reaches the canvas.
const productText = []
  .concat(COACH_STEPS.map((s) => s.title + ' ' + s.body))
  .concat(Object.keys(BADGE_LABELS).map((k) => BADGE_LABELS[k] + ' ' + BADGE_WHY[k]))
  .concat([PROOF_BOARD_DISCLAIMER, GLOWBOOK_DISCLAIMER, GLOWBOOK_NOT_ZK, EMPTY_BOARD_HEADLINE])
  .concat(tiles.map((t) => t.title + ' ' + t.checksSummary + ' ' + t.sqlOrCode))
  .concat(goodVerify.checked.map((c) => c.what + ' ' + c.note))
  .concat(goodVerify.cannotCheck)
  .concat([html]);
for (let i = 0; i < productText.length; i += 1) {
  if (productText[i].indexOf('—') >= 0) {
    throw new Error('FAIL em dash in product text: ' + productText[i].slice(0, 90));
  }
}
ok('no em dash appears in any product string', true);
ok('no product string carries a closing script tag',
  productText.every((s) => s.toLowerCase().indexOf('</script>') < 0));

// Nothing may mutate what the caller handed over.
const frozenRows = ds.rows.map((r) => r.slice());
tilesFromDataset(ds, {});
ok('building tiles does not mutate the rows',
  JSON.stringify(ds.rows) === JSON.stringify(frozenRows));
const tileInput = tile();
const tileInputCopy = JSON.parse(JSON.stringify(tileInput));
normalizeTile(tileInput, 0);
buildTileGlassBox(tileInput);
ok('normalizing does not mutate the tile',
  JSON.stringify(tileInput) === JSON.stringify(tileInputCopy));
const boardInput = [tile(), tile({ id: 'x' })];
const boardInputCopy = JSON.parse(JSON.stringify(boardInput));
buildProofBoard(boardInput, {});
ok('building a board does not mutate the tiles',
  JSON.stringify(boardInput) === JSON.stringify(boardInputCopy));

console.log('\n' + passed + ' passed');
if (passed < 200) throw new Error('expected at least 200 assertions, ran ' + passed);
console.log('proof-board: all ' + passed + ' assertions passed');
