// Bundle 10: prove gate, Proof to Post, BI hand-off, de-id receipt.
//
// Pure Node. No DOM, no network, no test runner. The real engines are imported
// rather than stubbed, including the Proof Board and the Safe Harbor verifier,
// because the thing worth testing is the composition and a stub would test the
// stub.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PROVE_GATE_KIND, PROVABLE_BADGES, UNPROVABLE_BADGES, BADGE_BINDING_NOTES,
  maskNonClaimNumbers, extractNumbers, isRoundingOf, provableValues,
  engineValues, assertClaimAllowed, describeGateResult, DataGlowProveGate,
} from '../js/ai/prove-gate.js';

import {
  NEVER_AUTO_POST, MAX_BULLETS, METHOD_LINE, TRANSPARENCY_CHECKED,
  TRANSPARENCY_PARTIAL, POST_DISCLAIMER, EMPTY_POST_HEADLINE, EMPTY_POST_CTA,
  tilesOf, postableTiles, excludedTiles, bulletForTile, buildLinkedInDraft,
  validateLinkedInDraft, buildPortfolioMarkdown, proofToPostSteps,
  buildProofToPostPack, POST_COACH_STEPS, postCoachModel, DataGlowProofToPost,
} from '../js/proofpost/proof-to-post.js';

import {
  BI_HANDOFF_KIND, HANDOFF_DISCLAIMER, VALIDATION_HEADER_NOTE, NO_DATASET_NOTE,
  csvEscape, cellAt, toCSV, columnStats, buildDictionary, buildQueriesSQL,
  buildValidationSummary, buildHandoffReadme, buildHandoffPack, DataGlowBIHandoff,
} from '../js/export/bi-handoff.js';

import {
  DEID_RECEIPT_KIND, DEID_NOT_CERTIFICATION, DEID_WHAT_IT_CANNOT_SEE,
  DEID_NO_REPORT, VERDICT_LABELS, escapeHtml, buildDeidReceipt,
  renderDeidReceiptMarkdown, renderDeidReceiptHTML, DataGlowDeidReceipt,
} from '../js/privacy/deid-receipt.js';

import { buildProofBoard, normalizeTile } from '../js/proofboard/proof-board.js';
import { buildDeidReport } from '../js/provenance/deidentification-verifier.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error('FAIL ' + name);
  console.log('  ✓ ' + name);
  passed++;
}
function section(name) {
  console.log('\n' + name);
}

// ---------------------------------------------------------------- fixtures

function tile(over) {
  return normalizeTile(Object.assign({
    id: 'rows',
    title: 'Rows loaded',
    value: 1200,
    sqlOrCode: 'SELECT count(*) FROM your_table;',
    language: 'sql',
    engine: 'duckdb-wasm',
    gateBadge: 'clear',
    checksSummary: 'Counted every row.',
  }, over || {}), 0);
}

const CLEAR_TILE = tile({});
const CAUTION_TILE = tile({ id: 'complete', title: 'Complete rows', value: 1150, gateBadge: 'caution' });
const UNKNOWN_TILE = tile({ id: 'distinct', title: 'Distinct customers', value: 431, gateBadge: 'unknown' });
const BLOCKED_TILE = tile({ id: 'score', title: 'Health score', value: 42, gateBadge: 'blocked' });
const NOVALUE_TILE = tile({ id: 'pending', title: 'Median basket', value: null, gateBadge: 'unknown' });

// ---------------------------------------------------------------- prove gate

section('Prove gate: pulling numbers out of prose');

ok('the kind is stable', PROVE_GATE_KIND === 'dataglow-prove-gate');
ok('clear, caution and unknown can back a claim', PROVABLE_BADGES.length === 3);
ok('blocked is the only badge that cannot', UNPROVABLE_BADGES.length === 1 && UNPROVABLE_BADGES[0] === 'blocked');
ok('every badge has a binding note', ['clear', 'caution', 'unknown', 'blocked'].every(b => typeof BADGE_BINDING_NOTES[b] === 'string' && BADGE_BINDING_NOTES[b].length > 20));
ok('the unknown note refuses to read as a pass', /absence of evidence/i.test(BADGE_BINDING_NOTES.unknown));

ok('a plain integer is found', extractNumbers('we loaded 1200 rows')[0].value === 1200);
ok('a decimal is found with its precision', extractNumbers('rate was 94.7 percent')[0].decimals === 1);
ok('an integer reports zero decimals', extractNumbers('1200 rows')[0].decimals === 0);
ok('thousands separators are parsed', extractNumbers('1,200 rows')[0].value === 1200);
ok('a negative number is found', extractNumbers('down -14 points')[0].value === -14);
ok('several numbers are found in order', extractNumbers('12 then 34').map(n => n.value).join(',') === '12,34');
ok('prose with no numbers yields none', extractNumbers('no digits at all here').length === 0);
ok('a non-string is tolerated', extractNumbers(null).length === 0);

ok('an ISO date is not a claim', extractNumbers('generated 2026-07-25').length === 0);
ok('an ISO timestamp is not a claim', extractNumbers('at 2026-07-25T11:22:33Z').length === 0);
ok('a clock time is not a claim', extractNumbers('ran at 14:05').length === 0);
ok('a dotted version is not a claim', extractNumbers('DuckDB v1.2.3').length === 0);
ok('masking preserves offsets', maskNonClaimNumbers('x 2026-07-25 y').length === 'x 2026-07-25 y'.length);
ok('a real number beside a date still counts', extractNumbers('on 2026-07-25 we loaded 1200 rows').map(n => n.value).join(',') === '1200');

section('Prove gate: what counts as a rounding');

ok('an exact match binds', isRoundingOf(1200, 1200, 0));
ok('rounding up to a whole number binds', isRoundingOf(95, 94.7312, 0));
ok('rounding to one place binds', isRoundingOf(94.7, 94.7312, 1));
ok('rounding to two places binds', isRoundingOf(94.73, 94.7312, 2));
ok('a different number does not bind', !isRoundingOf(96, 94.7312, 0));
ok('a wrong rounding does not bind', !isRoundingOf(94.8, 94.7312, 1));
ok('claiming more precision than is true does not bind', !isRoundingOf(94.7400, 94.7312, 4));
ok('NaN never binds', !isRoundingOf(NaN, 1, 0));
ok('Infinity never binds', !isRoundingOf(Infinity, Infinity, 0));

section('Prove gate: binding numbers to tiles');

ok('a tile with a numeric value is a candidate', provableValues([CLEAR_TILE]).length === 1);
ok('a tile with no value is not a candidate', provableValues([NOVALUE_TILE]).length === 0);
ok('a blocked tile is a candidate but not provable', provableValues([BLOCKED_TILE])[0].provable === false);
ok('a clear tile is provable', provableValues([CLEAR_TILE])[0].provable === true);
ok('an unknown tile is provable', provableValues([UNKNOWN_TILE])[0].provable === true);
ok('candidates carry the tile id', provableValues([CLEAR_TILE])[0].id === 'rows');
ok('candidates note whether code travelled with the number', provableValues([CLEAR_TILE])[0].hasCode === true);
ok('a non-object in the tile list is skipped', provableValues([null, 'x', CLEAR_TILE]).length === 1);
ok('a non-array is tolerated', provableValues(null).length === 0);

ok('an engine result is a candidate', engineValues([{ label: 'ad hoc', value: 7 }]).length === 1);
ok('an engine result is marked unchecked', engineValues([{ label: 'ad hoc', value: 7 }])[0].gateBadge === 'unknown');
ok('an engine result records its source', engineValues([{ label: 'ad hoc', value: 7 }])[0].source === 'engine-result');
ok('an engine result with no number is skipped', engineValues([{ label: 'x', value: 'abc' }]).length === 0);

section('Prove gate: the refusal that is the point of this bundle');

const bound = assertClaimAllowed('We loaded 1200 rows.', [CLEAR_TILE]);
ok('a number on the board is allowed', bound.allowed === true);
ok('the binding names the tile', bound.bindings[0].tileId === 'rows');
ok('nothing is left unbound', bound.unbound.length === 0);
ok('a checked binding is counted as checked', bound.checkedCount === 1);
ok('the result carries the claim text', bound.claim === 'We loaded 1200 rows.');

const invented = assertClaimAllowed('We cut processing time by 40%.', [CLEAR_TILE]);
ok('an invented number is refused', invented.allowed === false);
ok('the invented number is named', invented.unbound[0].number === '40');
ok('the refusal explains itself', invented.reasons.some(r => r.indexOf('40') >= 0 && /not on the Proof Board/.test(r)));
ok('no false binding is recorded', invented.bindings.length === 0);

const mixed = assertClaimAllowed('We loaded 1200 rows and saved 40 hours.', [CLEAR_TILE]);
ok('one good number does not rescue a bad one', mixed.allowed === false);
ok('the good number still binds', mixed.bindings.length === 1);
ok('only the bad number is listed', mixed.unbound.length === 1 && mixed.unbound[0].value === 40);

const noTiles = assertClaimAllowed('We loaded 1200 rows.', []);
ok('an empty board proves nothing', noTiles.allowed === false);
ok('an empty board says why', noTiles.reasons.some(r => /nothing on the Proof Board/i.test(r)));

const noNumbers = assertClaimAllowed('We looked at the data carefully.', []);
ok('prose with no numbers is allowed', noNumbers.allowed === true);
ok('prose with no numbers binds nothing', noNumbers.bindings.length === 0);

const fromBlocked = assertClaimAllowed('The health score is 42.', [BLOCKED_TILE]);
ok('a blocked tile cannot back a claim', fromBlocked.allowed === false);
ok('a blocked number is refused, not merely unbound', fromBlocked.refused.length === 1 && fromBlocked.unbound.length === 0);
ok('the refusal names the blocking tile', fromBlocked.refused[0].tileTitle === 'Health score');
ok('the refusal explains that a check blocked it', fromBlocked.reasons.some(r => /blocked/.test(r)));

const fromUnknown = assertClaimAllowed('There are 431 distinct customers.', [UNKNOWN_TILE]);
ok('an unknown tile can back the number', fromUnknown.allowed === true);
ok('an unknown binding raises a caution', fromUnknown.cautions.length === 1);
ok('the caution says no check reported', /no check has reported/i.test(fromUnknown.cautions[0]));
ok('an unknown binding is counted as unchecked', fromUnknown.uncheckedCount === 1 && fromUnknown.checkedCount === 0);

const rounded = assertClaimAllowed('Completeness was 96%.', [tile({ id: 'c', value: 95.83, gateBadge: 'clear' })]);
ok('an honest rounding binds', rounded.allowed === true);
const misrounded = assertClaimAllowed('Completeness was 98%.', [tile({ id: 'c', value: 95.83, gateBadge: 'clear' })]);
ok('a dishonest rounding does not bind', misrounded.allowed === false);

const viaEngine = assertClaimAllowed('The query returned 7.', [], { engineResults: [{ label: 'ad hoc', value: 7 }] });
ok('a supplied engine result can back a claim', viaEngine.allowed === true);
ok('an engine-backed claim is still flagged unchecked', viaEngine.uncheckedCount === 1);

ok('the gate never throws on rubbish input', (() => { try { assertClaimAllowed(undefined, undefined); return true; } catch (_e) { return false; } })());
ok('the gate handles a tile list full of nulls', assertClaimAllowed('1200 rows', [null, undefined]).allowed === false);

ok('describe reports a clean pass', /trace to a Proof Board tile/.test(describeGateResult(bound)));
ok('describe reports a refusal', /^Refused:/.test(describeGateResult(invented)));
ok('describe counts unchecked bindings', /no check reported on it/.test(describeGateResult(fromUnknown)));
ok('describe tolerates nonsense', typeof describeGateResult(null) === 'string');

// ---------------------------------------------------------------- proof to post

section('Proof to Post: never auto post');

ok('the constant is true', NEVER_AUTO_POST === true);
ok('the namespace publishes it', DataGlowProofToPost.NEVER_AUTO_POST === true);
ok('a built draft carries it', buildLinkedInDraft([CLEAR_TILE]).neverAutoPost === true);
ok('a built pack carries it', buildProofToPostPack({ tiles: [CLEAR_TILE] }).neverAutoPost === true);
ok('the disclaimer says DataGlow does not post', /does not post it/.test(POST_DISCLAIMER));
ok('the disclaimer says nothing is sent', /does not send it anywhere/.test(POST_DISCLAIMER));
ok('no module here exposes a post function', Object.keys(DataGlowProofToPost).every(k => !/^post[A-Z]|publish|send|share|upload/.test(k) || k === 'postableTiles' || k === 'postCoachModel' || k === 'proofToPostSteps'));

section('Proof to Post: which tiles may carry a number');

ok('a tile array is accepted', tilesOf([CLEAR_TILE]).length === 1);
ok('a board object is accepted', tilesOf(buildProofBoard([CLEAR_TILE], {})).length === 1);
ok('nonsense yields no tiles', tilesOf(42).length === 0);
ok('a tile with a value is postable', postableTiles([CLEAR_TILE]).length === 1);
ok('a tile with no value is not postable', postableTiles([NOVALUE_TILE]).length === 0);
ok('a blocked tile is not postable', postableTiles([BLOCKED_TILE]).length === 0);
ok('an unknown tile is postable', postableTiles([UNKNOWN_TILE]).length === 1);
ok('the excluded list explains a missing value', excludedTiles([NOVALUE_TILE])[0].why.indexOf('no value') >= 0);
ok('the excluded list explains a block', /known problem/.test(excludedTiles([BLOCKED_TILE])[0].why));
ok('nothing is excluded without a reason', excludedTiles([NOVALUE_TILE, BLOCKED_TILE]).every(e => e.why.length > 10));

ok('a bullet reads title then value', bulletForTile(CLEAR_TILE) === 'Rows loaded: 1200');
ok('a unit is carried into the bullet', bulletForTile(tile({ value: 95, unit: '%' })) === 'Rows loaded: 95 %');
ok('a valueless tile yields no bullet', bulletForTile(NOVALUE_TILE) === '');
ok('a nonsense tile yields no bullet', bulletForTile(null) === '');

section('Proof to Post: the LinkedIn draft');

const draft = buildLinkedInDraft([CLEAR_TILE, CAUTION_TILE]);
ok('the draft has a title', draft.title.length > 0);
ok('the draft has one bullet per tile', draft.bullets.length === 2);
ok('the draft text contains the tile numbers', draft.text.indexOf('1200') >= 0 && draft.text.indexOf('1150') >= 0);
ok('the draft carries the method line', draft.text.indexOf(METHOD_LINE) >= 0);
ok('the method line contains no digits', !/\d/.test(METHOD_LINE));
ok('the draft records which tiles it used', draft.tileIds.join(',') === 'rows,complete');
ok('a caller title is honoured', buildLinkedInDraft([CLEAR_TILE], { title: 'My study' }).title === 'My study');
ok('a closing line is appended', buildLinkedInDraft([CLEAR_TILE], { closing: 'Happy to share more.' }).text.indexOf('Happy to share more.') >= 0);
ok('bullets are capped', buildLinkedInDraft(Array.from({ length: 9 }, (_v, i) => tile({ id: 't' + i, value: 100 + i }))).bullets.length === MAX_BULLETS);
ok('the cap is five', MAX_BULLETS === 5);
ok('the draft never exceeds the cap in tileIds', buildLinkedInDraft(Array.from({ length: 9 }, (_v, i) => tile({ id: 't' + i, value: 100 + i }))).tileIds.length === MAX_BULLETS);

ok('all-checked tiles get the confident transparency line', buildLinkedInDraft([CLEAR_TILE, CAUTION_TILE]).transparencyLine === TRANSPARENCY_CHECKED);
ok('one unknown tile weakens the transparency line', buildLinkedInDraft([CLEAR_TILE, UNKNOWN_TILE]).transparencyLine === TRANSPARENCY_PARTIAL);
ok('the weaker line admits not everything was checked', /Not every number has had a separate check/.test(TRANSPARENCY_PARTIAL));
ok('the confident line is not used when a check is missing', buildLinkedInDraft([UNKNOWN_TILE]).text.indexOf(TRANSPARENCY_CHECKED) < 0);
ok('the transparency line can be turned off', buildLinkedInDraft([CLEAR_TILE], { includeTransparency: false }).transparencyLine === '');
ok('turning it off does not turn off the method line', buildLinkedInDraft([CLEAR_TILE], { includeTransparency: false }).text.indexOf(METHOD_LINE) >= 0);

const emptyDraft = buildLinkedInDraft([]);
ok('an empty board yields no bullets', emptyDraft.bullets.length === 0);
ok('an empty board is reported as a problem', emptyDraft.problems.length === 1);
ok('the empty problem is the honest headline', emptyDraft.problems[0] === EMPTY_POST_HEADLINE);
ok('the empty headline does not pretend', /nothing has been proved yet/.test(EMPTY_POST_HEADLINE));
ok('the empty CTA says what to do', /Load a file/.test(EMPTY_POST_CTA));
ok('an empty draft still carries no invented number', !/\d/.test(emptyDraft.bullets.join('')));

section('Proof to Post: validating the draft');

const goodV = validateLinkedInDraft(buildLinkedInDraft([CLEAR_TILE]), [CLEAR_TILE]);
ok('an assembled draft passes its own gate', goodV.ok === true);
ok('validation carries the gate result', goodV.gate.kind === PROVE_GATE_KIND);
ok('validation summarises in one line', typeof goodV.summary === 'string' && goodV.summary.length > 0);

const tamper = validateLinkedInDraft({ text: 'We saved 40 hours.', problems: [] }, [CLEAR_TILE]);
ok('a hand-edited number is caught', tamper.ok === false);
ok('the tampered number is named in the problems', tamper.problems.some(p => p.indexOf('40') >= 0));

const unknownV = validateLinkedInDraft(buildLinkedInDraft([UNKNOWN_TILE]), [UNKNOWN_TILE]);
ok('an unchecked number still validates', unknownV.ok === true);
ok('an unchecked number raises a caution', unknownV.cautions.length === 1);

const emptyV = validateLinkedInDraft(emptyDraft, []);
ok('an empty draft does not validate', emptyV.ok === false);
ok('a raw string can be validated', validateLinkedInDraft('1200 rows', [CLEAR_TILE]).ok === true);
ok('validation tolerates nonsense', typeof validateLinkedInDraft(null, null).ok === 'boolean');

section('Proof to Post: the portfolio markdown');

const md = buildPortfolioMarkdown([CLEAR_TILE, UNKNOWN_TILE], { recommendation: 'Fix the source system.' });
ok('the doc has a heading', md.indexOf('# ') === 0);
ok('the doc tabulates the numbers', md.indexOf('| Finding | Value | Check |') >= 0);
ok('the doc shows each value', md.indexOf('1200') >= 0 && md.indexOf('431') >= 0);
ok('the doc shows the code that produced a number', md.indexOf('SELECT count(*) FROM your_table;') >= 0);
ok('the doc fences the code with its language', md.indexOf('```sql') >= 0);
ok('the doc carries the recommendation', md.indexOf('Fix the source system.') >= 0);
ok('the doc carries the disclaimer', md.indexOf(POST_DISCLAIMER) >= 0);
ok('a tile with no code says so rather than inventing one', buildPortfolioMarkdown([tile({ sqlOrCode: '' })]).indexOf('No code was recorded') >= 0);
ok('a pipe in a title cannot break the table', buildPortfolioMarkdown([tile({ title: 'a|b' })]).indexOf('a\\|b') >= 0);
ok('an empty board yields the empty headline', buildPortfolioMarkdown([]).indexOf(EMPTY_POST_HEADLINE) >= 0);
ok('an empty board yields no invented table row', buildPortfolioMarkdown([]).indexOf('| Finding |') < 0);

section('Proof to Post: the three-step checklist');

const packEmpty = buildProofToPostPack({ tiles: [] });
ok('an empty pack is marked empty', packEmpty.empty === true);
ok('an empty pack has three steps', packEmpty.steps.length === 3);
ok('prove is not ready with no tiles', packEmpty.steps[0].ready === false);
ok('prove states its blocker', packEmpty.steps[0].blocker.length > 0);
ok('publish is not ready with no tiles', packEmpty.steps[1].ready === false);
ok('post is not ready with no tiles', packEmpty.steps[2].ready === false);

const packFull = buildProofToPostPack({ tiles: [CLEAR_TILE, CAUTION_TILE] });
ok('a real pack is not empty', packFull.empty === false);
ok('prove is ready with tiles', packFull.steps[0].ready === true);
ok('publish still needs a download', packFull.steps[1].ready === false);
ok('publish names the missing download', /No file has been downloaded/.test(packFull.steps[1].blocker));
ok('post still needs the review tick', packFull.steps[2].ready === false);
ok('post names the review tick', /Tick the review box/.test(packFull.steps[2].blocker));

const stepsDone = proofToPostSteps(packFull, { published: true, reviewed: true });
ok('publish becomes ready once something was downloaded', stepsDone[1].ready === true);
ok('post becomes ready once reviewed', stepsDone[2].ready === true);
ok('a ready step has no blocker', stepsDone[2].blocker === '');
ok('steps tolerate no state', proofToPostSteps(packFull).length === 3);
ok('steps tolerate nonsense', proofToPostSteps(null, null).length === 3);

section('Proof to Post: the whole pack');

ok('the pack carries the portfolio doc', packFull.portfolioMarkdown.indexOf('1200') >= 0);
ok('the pack carries the draft', packFull.linkedInDraft.bullets.length === 2);
ok('the pack carries the validation', packFull.validation.ok === true);
ok('the pack lists what it excluded', buildProofToPostPack({ tiles: [CLEAR_TILE, BLOCKED_TILE] }).excluded.length === 1);
ok('a blocked tile never reaches the draft text', buildProofToPostPack({ tiles: [CLEAR_TILE, BLOCKED_TILE] }).linkedInDraft.text.indexOf('42') < 0);
ok('a de-id receipt rides along when supplied', buildProofToPostPack({ tiles: [CLEAR_TILE], deidReceipt: { available: true } }).deidReceipt.available === true);
ok('no receipt is invented when none is supplied', packFull.deidReceipt === null);
ok('the pack tolerates no input', buildProofToPostPack().steps.length === 3);

section('Proof to Post: the coach strip');

ok('there are four coach steps', POST_COACH_STEPS.length === 4);
ok('four is the documented maximum', POST_COACH_STEPS.length <= 4);
ok('every step names a target', POST_COACH_STEPS.every(s => typeof s.target === 'string' && s.target.length > 0));
ok('every step has a title and body', POST_COACH_STEPS.every(s => s.title.length > 0 && s.body.length > 0));
ok('the steps are frozen', Object.isFrozen(POST_COACH_STEPS) && Object.isFrozen(POST_COACH_STEPS[0]));
ok('step ids are unique', new Set(POST_COACH_STEPS.map(s => s.id)).size === 4);
ok('the model reports progress', postCoachModel(0).progress === '1 of 4');
ok('the model clamps below zero', postCoachModel(-5).index === 0);
ok('the model clamps above the end', postCoachModel(99).index === 3);
ok('the last step says Done', postCoachModel(3).nextLabel === 'Done');
ok('a middle step says Next', postCoachModel(1).nextLabel === 'Next');
ok('the coach mentions copy is the last action', POST_COACH_STEPS.some(s => /Copy/.test(s.title)));

// ---------------------------------------------------------------- bi handoff

section('BI hand-off: CSV that cannot be misread');

ok('a plain value passes through', csvEscape('abc') === 'abc');
ok('a comma is quoted', csvEscape('a,b') === '"a,b"');
ok('a quote is doubled', csvEscape('a"b') === '"a""b"');
ok('a newline is quoted', csvEscape('a\nb') === '"a\nb"');
ok('null becomes empty', csvEscape(null) === '');
ok('undefined becomes empty', csvEscape(undefined) === '');
ok('a number is stringified', csvEscape(12) === '12');
ok('a formula is neutralised', csvEscape('=SUM(A1)').indexOf("'=") === 0);
ok('a leading plus is neutralised', csvEscape('+1').indexOf("'+") === 0);
ok('a leading at is neutralised', csvEscape('@x').indexOf("'@") === 0);

const COLS = [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'VARCHAR' }];
const ROWS = [[1, 'Ada'], [2, ''], [3, 'Grace']];
const csv = toCSV(COLS, ROWS);
ok('the header is the column names', csv.split('\n')[0] === 'id,name');
ok('every row is written', csv.trim().split('\n').length === 4);
ok('a value lands in its column', csv.indexOf('1,Ada') >= 0);
ok('object rows are accepted too', toCSV(COLS, [{ id: 9, name: 'Zed' }]).indexOf('9,Zed') >= 0);
ok('a row cap is honoured', toCSV(COLS, ROWS, { maxRows: 1 }).trim().split('\n').length === 2);
ok('no columns yields just a blank header', toCSV([], []).trim() === '');
ok('cellAt reads a positional row', cellAt([1, 'Ada'], 'name', 1) === 'Ada');
ok('cellAt reads an object row', cellAt({ name: 'Ada' }, 'name', 1) === 'Ada');
ok('cellAt tolerates nonsense', cellAt(null, 'name', 0) === undefined);

section('BI hand-off: the dictionary never estimates');

const stats = columnStats(COLS, ROWS);
ok('every column is described', stats.length === 2);
ok('a blank is counted', stats[1].blankCount === 1);
ok('the blank rate is a real fraction', Math.abs(stats[1].nullRate - 1 / 3) < 1e-9);
ok('the rate is rendered as a percentage', stats[1].nullRateText.indexOf('%') > 0);
ok('a column with no blanks reports zero', stats[0].blankCount === 0);
ok('with no rows the rate is not known', columnStats(COLS, [])[0].nullRate === null);
ok('with no rows the text says so rather than showing zero', /not known/.test(columnStats(COLS, [])[0].nullRateText));

const dict = buildDictionary({ name: 'orders', columns: COLS, rows: ROWS });
ok('the dictionary names the dataset', dict.indexOf('orders') >= 0);
ok('the dictionary tabulates the columns', dict.indexOf('| Column | Type | Blank rate | Rows counted |') >= 0);
ok('the dictionary shows a type', dict.indexOf('INTEGER') >= 0);
ok('a column with no type says so', buildDictionary({ columns: [{ name: 'x' }], rows: ROWS }).indexOf('not recorded') >= 0);
ok('no dataset yields the honest note', buildDictionary(null).indexOf(NO_DATASET_NOTE) >= 0);

section('BI hand-off: the queries file');

const sql = buildQueriesSQL([CLEAR_TILE, UNKNOWN_TILE]);
ok('each number gets a comment header', sql.indexOf('-- Rows loaded') >= 0);
ok('the query is written out', sql.indexOf('SELECT count(*) FROM your_table;') >= 0);
ok('a session query is appended when supplied', buildQueriesSQL([], { sessionSQL: 'SELECT 1' }).indexOf('SELECT 1;') >= 0);
ok('a missing semicolon is added', buildQueriesSQL([tile({ sqlOrCode: 'SELECT 2' })]).indexOf('SELECT 2;') >= 0);
ok('a non-SQL block is commented out rather than run', buildQueriesSQL([tile({ sqlOrCode: 'df.count()', language: 'python' })]).indexOf('-- df.count()') >= 0);
ok('a non-SQL block is labelled', buildQueriesSQL([tile({ sqlOrCode: 'df.count()', language: 'python' })]).indexOf('is python, not SQL') >= 0);
ok('no queries yields an honest empty file', buildQueriesSQL([]).indexOf('Nothing is invented here') >= 0);
ok('a tile with no code contributes nothing', buildQueriesSQL([tile({ sqlOrCode: '' })]).indexOf('Nothing is invented here') >= 0);

section('BI hand-off: the validation summary refuses to grade what it did not see');

const vs = buildValidationSummary([CLEAR_TILE, UNKNOWN_TILE, BLOCKED_TILE]);
ok('the header warns before the table', vs.indexOf(VALIDATION_HEADER_NOTE) < vs.indexOf('| Number |'));
ok('the header says unknown is not a pass', /absence of evidence/.test(VALIDATION_HEADER_NOTE));
ok('the header says this is not an audit', /not.*an audit/i.test(VALIDATION_HEADER_NOTE));
ok('an unknown tile prints as not checked', vs.indexOf('not checked') >= 0);
ok('an unknown tile never prints as passed', vs.indexOf('| Distinct customers | 431 | Checks passed |') < 0);
ok('a clear tile prints its real label', vs.indexOf('Checks passed') >= 0);
ok('unchecked numbers are counted in the limits', /1 number\(s\) have had no check reported/.test(vs));
ok('blocked numbers are counted in the limits', /1 number\(s\) were blocked/.test(vs));
ok('the summary admits it cannot re-run the queries', /re-running here would report a fresh number/.test(vs));
ok('the summary admits it cannot judge relevance', /right numbers to be looking at/.test(vs));
ok('a readiness gate is reported when supplied', buildValidationSummary([CLEAR_TILE], { gate: { agentConsumable: true, score: 88, threshold: 70 } }).indexOf('Score: 88') >= 0);
ok('a missing gate is not invented', vs.indexOf('Readiness gate') < 0);
ok('no tiles yields an honest note', buildValidationSummary([]).indexOf('nothing here has been checked') >= 0);

section('BI hand-off: the pack');

const pack = buildHandoffPack({ dataset: { name: 'orders', columns: COLS, rows: ROWS }, tiles: [CLEAR_TILE], gate: null });
ok('the kind is stable', pack.kind === BI_HANDOFF_KIND);
ok('the pack has five files', pack.files.length === 5);
const names = pack.files.map(f => f.name);
ok('data.csv is present', names.indexOf('data.csv') >= 0);
ok('dictionary.md is present', names.indexOf('dictionary.md') >= 0);
ok('queries.sql is present', names.indexOf('queries.sql') >= 0);
ok('validation-summary.md is present', names.indexOf('validation-summary.md') >= 0);
ok('README-handoff.md is present', names.indexOf('README-handoff.md') >= 0);
ok('every file carries a mime type', pack.files.every(f => typeof f.mimeType === 'string' && f.mimeType.length > 0));
ok('every file carries its byte count', pack.files.every(f => f.bytes === f.text.length));
ok('every file carries a note for the README', pack.files.every(f => f.note.length > 10));
ok('the manifest matches the file list', pack.manifest.length === pack.files.length);
ok('the pack counts the rows', pack.rowCount === 3);
ok('the pack counts the columns', pack.columnCount === 2);
ok('the pack counts the tiles', pack.tileCount === 1);
ok('the pack carries the disclaimer', pack.disclaimer === HANDOFF_DISCLAIMER);
ok('the disclaimer refuses a certification claim', /not a certified deliverable/.test(HANDOFF_DISCLAIMER));
ok('the disclaimer refuses a tool endorsement', /not endorsed by or certified with either tool/.test(HANDOFF_DISCLAIMER));
ok('the disclaimer says it is not a dashboard', /does not reproduce a dashboard/.test(HANDOFF_DISCLAIMER));

const readme = pack.files.find(f => f.name === 'README-handoff.md').text;
ok('the README explains Power BI', readme.indexOf('Text/CSV') >= 0);
ok('the README explains Tableau', readme.indexOf('Tableau') >= 0);
ok('the README lists the files', readme.indexOf('data.csv') >= 0 && readme.indexOf('queries.sql') >= 0);
ok('the README points at the validation summary', readme.indexOf('validation-summary.md') >= 0);
ok('the README warns before publishing', /has not failed anything, but nothing has passed it either/.test(readme));
ok('the README carries the disclaimer', readme.indexOf(HANDOFF_DISCLAIMER) >= 0);

const emptyPack = buildHandoffPack({});
ok('an empty pack still has five files', emptyPack.files.length === 5);
ok('an empty pack reports the missing dataset', emptyPack.problems.some(p => p === NO_DATASET_NOTE));
ok('an empty pack reports the missing tiles', emptyPack.problems.some(p => /no tiles/.test(p)));
ok('an empty pack invents no rows', emptyPack.rowCount === 0);
ok('the pack tolerates no input at all', buildHandoffPack().files.length === 5);

// ---------------------------------------------------------------- deid receipt

section('De-id receipt: composed on the real Safe Harbor verifier');

const cleanReport = buildDeidReport({
  columns: [{ name: 'widget_count', type: 'INTEGER' }, { name: 'colour', type: 'VARCHAR' }],
  samples: { widget_count: [1, 2, 3], colour: ['red', 'blue'] },
  rowCount: 500,
});
const phiReport = buildDeidReport({
  columns: [{ name: 'patient_name', type: 'VARCHAR' }, { name: 'ssn', type: 'VARCHAR' }, { name: 'zip', type: 'VARCHAR' }],
  samples: { patient_name: ['Ada Lovelace'], ssn: ['123-45-6789'], zip: ['02139'] },
  rowCount: 40,
});

ok('the verifier clears a boring dataset', cleanReport.verdict === 'pass');
ok('the verifier flags an obvious one', phiReport.verdict === 'fail');

const cleanReceipt = buildDeidReceipt(cleanReport);
const phiReceipt = buildDeidReceipt(phiReport);

ok('the kind is stable', cleanReceipt.kind === DEID_RECEIPT_KIND);
ok('a clean receipt is available', cleanReceipt.available === true);
ok('pass is never printed as the word pass', cleanReceipt.verdictLabel.toLowerCase().indexOf('pass') < 0);
ok('pass is printed as nothing flagged by this screen', cleanReceipt.verdictLabel === VERDICT_LABELS.pass);
ok('the meaning refuses to read as clearance', /not clearance to release/.test(cleanReceipt.verdictMeaning));
ok('a flagged receipt says it was flagged', phiReceipt.verdictLabel === VERDICT_LABELS.fail);
ok('a flagged receipt names the categories', phiReceipt.flagged.length > 0);
ok('a flagged receipt names the columns', phiReceipt.flagged.some(f => f.columns.some(c => c.column === 'ssn')));
ok('a flagged receipt gives a reason per column', phiReceipt.flagged.every(f => f.columns.every(c => c.reason.length > 0)));
ok('the clean receipt flags nothing', cleanReceipt.flaggedCount === 0);
ok('the clean receipt counts the clear categories', cleanReceipt.clearCount > 0);
ok('risk is carried through', typeof phiReceipt.risk.score === 'number');
ok('risk has a plain meaning', phiReceipt.risk.levelMeaning.length > 20);
ok('the column count is recorded', phiReceipt.dataset.columnCount === 3);
ok('the row count is recorded', phiReceipt.dataset.rowCount === 40);
ok('a fingerprint is carried when supplied', buildDeidReceipt(cleanReport, { datasetFingerprint: 'abc123' }).datasetFingerprint === 'abc123');
ok('no fingerprint is invented', cleanReceipt.datasetFingerprint === '');

const noReceipt = buildDeidReceipt(null);
ok('a missing report yields an unavailable receipt', noReceipt.available === false);
ok('a missing report says so', noReceipt.problem === DEID_NO_REPORT);
ok('a missing report is never a pass', noReceipt.verdict === null);
ok('a missing report flags nothing', noReceipt.flagged.length === 0);
ok('the receipt tolerates a malformed report', buildDeidReceipt({ verdict: 'weird' }).verdictLabel === 'Not reported');
ok('an unrecognised verdict claims nothing', /nothing is claimed about it/.test(buildDeidReceipt({ verdict: 'weird' }).verdictMeaning));

section('De-id receipt: the disclaimer a caller cannot remove');

ok('the receipt carries the non-certification line', cleanReceipt.notCertification === DEID_NOT_CERTIFICATION);
ok('it says it is not a HIPAA certification', /not a HIPAA certification/.test(DEID_NOT_CERTIFICATION));
ok('it says it does not certify de-identification', /does not certify/.test(DEID_NOT_CERTIFICATION));
ok('it says it is not safe-to-release', /does not make it safe to release/.test(DEID_NOT_CERTIFICATION));
ok('it says it is not legal advice', /not legal or clinical advice/.test(DEID_NOT_CERTIFICATION));
ok('it names free text as a blind spot', /free text/.test(DEID_WHAT_IT_CANNOT_SEE));
ok('it says clear is not safe', /absence of a match, not the presence of safety/.test(DEID_WHAT_IT_CANNOT_SEE));

const rmd = renderDeidReceiptMarkdown(cleanReceipt);
ok('the markdown leads with the disclaimer', rmd.indexOf(DEID_NOT_CERTIFICATION) < rmd.indexOf('## Result'));
ok('the markdown repeats it at the end', rmd.lastIndexOf(DEID_NOT_CERTIFICATION) > rmd.indexOf('## Result'));
ok('the markdown carries the blind spots', rmd.indexOf(DEID_WHAT_IT_CANNOT_SEE) >= 0);
ok('the markdown never prints the bare word PASS', rmd.indexOf('PASS') < 0);
ok('a clean markdown says the screen did not recognise one', /did not recognise one/.test(rmd));
ok('a flagged markdown tabulates the flags', renderDeidReceiptMarkdown(phiReceipt).indexOf('| Category | Column | Why it was flagged |') >= 0);
ok('an unavailable markdown still carries the disclaimer', renderDeidReceiptMarkdown(buildDeidReceipt(null)).indexOf(DEID_NOT_CERTIFICATION) >= 0);
ok('markdown tolerates no argument', typeof renderDeidReceiptMarkdown() === 'string');

const rhtml = renderDeidReceiptHTML(phiReceipt);
ok('the HTML is a whole document', rhtml.indexOf('<!DOCTYPE html>') === 0 && rhtml.indexOf('</html>') > 0);
ok('the HTML carries the disclaimer', rhtml.indexOf(escapeHtml(DEID_NOT_CERTIFICATION)) >= 0);
ok('the HTML carries the blind spots', rhtml.indexOf(escapeHtml(DEID_WHAT_IT_CANNOT_SEE)) >= 0);
ok('the HTML has no script tag', rhtml.indexOf('<script') < 0);
ok('the HTML has no stylesheet link', rhtml.indexOf('<link') < 0);
ok('the HTML has no iframe', rhtml.indexOf('<iframe') < 0);
ok('the HTML makes no network call', rhtml.indexOf('fetch(') < 0 && rhtml.indexOf('http://') < 0 && rhtml.indexOf('https://') < 0);
ok('the HTML inlines its own style', rhtml.indexOf('<style>') > 0);
ok('an unavailable HTML receipt still carries the disclaimer', renderDeidReceiptHTML(buildDeidReceipt(null)).indexOf(escapeHtml(DEID_NOT_CERTIFICATION)) >= 0);

section('De-id receipt: escaping');

ok('an ampersand is escaped', escapeHtml('a&b') === 'a&amp;b');
ok('a tag is escaped', escapeHtml('<b>') === '&lt;b&gt;');
ok('a quote is escaped', escapeHtml('"x"') === '&quot;x&quot;');
ok('an apostrophe is escaped', escapeHtml("it's") === 'it&#39;s');
ok('null escapes to empty', escapeHtml(null) === '');

const xssReport = buildDeidReport({
  columns: [{ name: '<script>alert(1)</script>_name', type: 'VARCHAR' }],
  samples: { '<script>alert(1)</script>_name': ['Ada'] },
  rowCount: 10,
});
const xssHtml = renderDeidReceiptHTML(buildDeidReceipt(xssReport));
ok('a hostile column name cannot inject a script', xssHtml.indexOf('<script>alert(1)</script>') < 0);
ok('a hostile column name is still shown, escaped', xssHtml.indexOf('&lt;script&gt;') >= 0);

// ---------------------------------------------------------------- doctrine

section('Guarded Copilot has no write path');

// The module documents its own read-only design at length, so the prose says
// "no import of confirmAndApply" and a naive grep matches its own denial.
// Comments are stripped first: the claim under test is about the code.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

const copilotSrc = readFileSync(join(ROOT, 'js/agents/guarded-copilot.js'), 'utf8');
const copilotCode = stripComments(copilotSrc);
ok('the copilot module exists', copilotSrc.length > 500);
ok('stripping comments leaves real code behind', /export\s+function/.test(copilotCode));
ok('the copilot exports nothing that applies a change', !/export\s+(async\s+)?function\s+(apply|write|mutate|commit|save|delete|drop)/i.test(copilotCode));
ok('the copilot does not call a confirm-and-apply helper', !/confirmAndApply/.test(copilotCode));
ok('the copilot issues no fetch', !/\bfetch\s*\(/.test(copilotCode));
ok('the copilot opens no websocket', !/new\s+WebSocket/.test(copilotCode));
ok('the copilot runs no INSERT', !/\bINSERT\s+INTO\b/i.test(copilotCode));
ok('the copilot runs no UPDATE statement', !/\bUPDATE\s+\w+\s+SET\b/i.test(copilotCode));
ok('the copilot runs no DELETE statement', !/\bDELETE\s+FROM\b/i.test(copilotCode));
ok('the copilot does not reach localStorage to persist', !/localStorage\.setItem/.test(copilotCode));

section('House shape');

const NS = [
  ['DataGlowProveGate', DataGlowProveGate],
  ['DataGlowProofToPost', DataGlowProofToPost],
  ['DataGlowBIHandoff', DataGlowBIHandoff],
  ['DataGlowDeidReceipt', DataGlowDeidReceipt],
];
for (const [name, ns] of NS) {
  ok(name + ' is an object', ns && typeof ns === 'object');
  ok(name + ' publishes a kind', typeof ns[Object.keys(ns).find(k => /_KIND$/.test(k))] === 'string');
  ok(name + ' exposes only functions and data', Object.keys(ns).every(k => typeof ns[k] !== 'undefined'));
}
ok('the prove gate namespace exposes the binder', typeof DataGlowProveGate.assertClaimAllowed === 'function');
ok('the post namespace exposes the validator', typeof DataGlowProofToPost.validateLinkedInDraft === 'function');
ok('the hand-off namespace exposes the pack builder', typeof DataGlowBIHandoff.buildHandoffPack === 'function');
ok('the receipt namespace exposes both renderings', typeof DataGlowDeidReceipt.renderDeidReceiptMarkdown === 'function' && typeof DataGlowDeidReceipt.renderDeidReceiptHTML === 'function');

section('No em dashes in product text');

const PRODUCT_FILES = [
  'js/ai/prove-gate.js',
  'js/proofpost/proof-to-post.js',
  'js/export/bi-handoff.js',
  'js/privacy/deid-receipt.js',
  'js/proofpost/data-glow-proof-to-post-canvas.js',
];
for (const rel of PRODUCT_FILES) {
  let src = '';
  try { src = readFileSync(join(ROOT, rel), 'utf8'); } catch (_e) { src = ''; }
  ok('no U+2014 in ' + rel, src.indexOf('—') < 0);
}

console.log('\n' + passed + ' assertions pass');
if (passed < 200) throw new Error('Expected at least 200 assertions, got ' + passed);
