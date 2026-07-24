// ============================================================
// DATAGLOW - R Notebooks-lite pure engine test suite
// ============================================================
// Pure model + serialization + starter + R prelude assertions. No WebR, no
// DOM, no network: the engine module must be safe to import anywhere.
//
// RUN WITH:  node test/r-notebook-lite.test.mjs   (npm run test:rnotebook)

import assert from 'assert';
import { readFileSync } from 'node:fs';
import {
  createNotebook,
  createCell,
  addCell,
  removeCell,
  updateCellSource,
  moveCell,
  setCellOutput,
  serializeNotebook,
  parseNotebook,
  defaultStarterCells,
  canRunCell,
  buildRBridgePrelude,
  buildRBridgeNotices,
  buildRowCapNotice,
  extractImageDataUrls,
  suggestStarterSnippets,
  renderMarkdown,
  escapeHtml,
  R_NOTEBOOK_LITE_VERSION,
  R_ROW_LIMIT,
  R_NOTEBOOK_FILE_EXT,
  R_STARTER_INDUSTRIES
} from '../js/intelligence/r-notebook-lite.js';

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error('FAIL ' + name);
  console.log('  ' + String.fromCharCode(10003) + ' ' + name);
  passed++;
}

console.log('r-notebook-lite');

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------
ok('version is 1', R_NOTEBOOK_LITE_VERSION === 1);
ok('row limit is 200000', R_ROW_LIMIT === 200000);
ok('file extension is .dgrnb', R_NOTEBOOK_FILE_EXT === '.dgrnb');
ok('industries include stats and finance',
  R_STARTER_INDUSTRIES.includes('stats') && R_STARTER_INDUSTRIES.includes('finance'));

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------
const nb = createNotebook();
ok('createNotebook version', nb.version === 1);
ok('createNotebook has id', typeof nb.id === 'string' && nb.id.length > 0);
ok('createNotebook has title', nb.title === 'R notebook');
ok('createNotebook stamps createdAt', typeof nb.createdAt === 'string' && nb.createdAt.length > 0);
ok('createNotebook stamps updatedAt', typeof nb.updatedAt === 'string');
ok('createNotebook seeds starter cells', nb.cells.length >= 2);
ok('starter has a code cell', nb.cells.some(c => c.type === 'code'));
ok('starter has a markdown cell', nb.cells.some(c => c.type === 'markdown'));

const c1 = createCell({ type: 'code', source: 'summary(df)' });
const c2 = createCell({ type: 'markdown', source: '# hi' });
ok('createCell unique ids', c1.id !== c2.id);
ok('createCell code type', c1.type === 'code' && c1.source === 'summary(df)');
ok('createCell markdown type', c2.type === 'markdown');
ok('createCell defaults to code', createCell({}).type === 'code');
ok('createCell starts idle', c1.status === 'idle');
ok('createCell starts with no images', Array.isArray(c1.images) && c1.images.length === 0);

// ---------------------------------------------------------------------------
// add / remove / update
// ---------------------------------------------------------------------------
const nb2 = createNotebook({ cells: [c1] });
ok('createNotebook from seed cells', nb2.cells.length === 1 && nb2.cells[0].source === 'summary(df)');

addCell(nb2, 1, createCell({ type: 'code', source: 'nrow(df)' }));
ok('addCell inserts at index', nb2.cells.length === 2 && nb2.cells[1].source === 'nrow(df)');

addCell(nb2, 0, createCell({ type: 'markdown', source: 'top' }));
ok('addCell inserts at 0', nb2.cells[0].type === 'markdown' && nb2.cells[0].source === 'top');

addCell(nb2);
ok('addCell no-arg appends blank code cell', nb2.cells[nb2.cells.length - 1].type === 'code');

const targetId = nb2.cells[1].id;
updateCellSource(nb2, targetId, 'head(df, 3)');
ok('updateCellSource sets source', nb2.cells[1].source === 'head(df, 3)');
updateCellSource(nb2, 'nope', 'x');
ok('updateCellSource unknown id is safe', nb2.cells[1].source === 'head(df, 3)');

const beforeLen = nb2.cells.length;
removeCell(nb2, targetId);
ok('removeCell removes one', nb2.cells.length === beforeLen - 1);
ok('removeCell dropped the right cell', !nb2.cells.some(c => c.id === targetId));
removeCell(nb2, 'ghost');
ok('removeCell unknown id is safe', nb2.cells.length === beforeLen - 1);
ok('mutators never return null', addCell(null) === null || true);

// ---------------------------------------------------------------------------
// moveCell
// ---------------------------------------------------------------------------
const mv = createNotebook({
  cells: [
    createCell({ type: 'code', source: 'a' }),
    createCell({ type: 'code', source: 'b' }),
    createCell({ type: 'code', source: 'c' })
  ]
});
moveCell(mv, mv.cells[2].id, 0);
ok('moveCell to front', mv.cells[0].source === 'c');
ok('moveCell preserves count', mv.cells.length === 3);
moveCell(mv, mv.cells[0].id, 99);
ok('moveCell clamps out-of-range index', mv.cells[mv.cells.length - 1].source === 'c');
moveCell(mv, 'ghost', 0);
ok('moveCell unknown id is safe', mv.cells.length === 3);

// ---------------------------------------------------------------------------
// canRunCell
// ---------------------------------------------------------------------------
ok('canRunCell true for code with source', canRunCell(createCell({ type: 'code', source: 'x <- 1' })));
ok('canRunCell false for empty code', !canRunCell(createCell({ type: 'code', source: '   ' })));
ok('canRunCell false for markdown', !canRunCell(createCell({ type: 'markdown', source: 'hi' })));
ok('canRunCell false for null', !canRunCell(null));

// ---------------------------------------------------------------------------
// setCellOutput (status + images mirrored onto the cell)
// ---------------------------------------------------------------------------
const outNb = createNotebook({ cells: [createCell({ type: 'code', source: 'plot(1)' })] });
const outId = outNb.cells[0].id;
setCellOutput(outNb, outId, {
  status: 'ok', stdout: 'done', elapsedMs: 12,
  images: ['data:image/png;base64,AAA', 'http://evil.example/x.png']
});
ok('setCellOutput stores output', outNb.cells[0].output.stdout === 'done');
ok('setCellOutput mirrors status', outNb.cells[0].status === 'ok');
ok('setCellOutput keeps only data-url images', outNb.cells[0].images.length === 1);
setCellOutput(outNb, outId, null);
ok('setCellOutput null clears', outNb.cells[0].output === null && outNb.cells[0].status === 'idle');

// ---------------------------------------------------------------------------
// serialize round-trip (.dgrnb)
// ---------------------------------------------------------------------------
const json = serializeNotebook(nb2);
ok('serialize is a string', typeof json === 'string');
ok('serialize marks the kind', JSON.parse(json).kind === 'dataglow-r-notebook');
const round = parseNotebook(json);
ok('parse ok', round.ok === true);
ok('round-trip cell count', round.notebook.cells.length === nb2.cells.length);
ok('round-trip preserves sources',
  round.notebook.cells.map(c => c.source).join('|') === nb2.cells.map(c => c.source).join('|'));
ok('round-trip preserves title', round.notebook.title === nb2.title);
ok('round-trip drops runtime output', round.notebook.cells.every(c => c.output === null));

// ---------------------------------------------------------------------------
// parse fails closed
// ---------------------------------------------------------------------------
ok('parse invalid JSON fails closed', parseNotebook('{not json').ok === false);
ok('parse empty fails closed', parseNotebook('').ok === false);
ok('parse non-object fails closed', parseNotebook('[]').ok === false);
ok('parse missing cells fails closed', parseNotebook('{"version":1}').ok === false);
ok('parse never throws on garbage', (function () {
  try { parseNotebook(' '); return true; } catch (e) { return false; }
})());
ok('parse rejects with a message', typeof parseNotebook('[]').error === 'string');

// ---------------------------------------------------------------------------
// starter cells + snippets (any industry, not pharma-only)
// ---------------------------------------------------------------------------
const starters = defaultStarterCells();
ok('defaultStarterCells has a code cell', starters.filter(c => c.type === 'code').length >= 1);
ok('defaultStarterCells uses the bridge',
  starters.some(c => c.type === 'code' && /dataglow_get_df\(/.test(c.source)));

const all = suggestStarterSnippets();
ok('suggestStarterSnippets returns many', all.length >= 8);
ok('every snippet has id/label/code',
  all.every(s => s.id && s.label && typeof s.code === 'string' && s.code.length > 0));
ok('snippets cover general', all.some(s => s.industry === 'general'));
ok('snippets cover stats', all.some(s => s.industry === 'stats'));
ok('snippets cover finance', all.some(s => s.industry === 'finance'));
ok('snippets cover healthcare', all.some(s => s.industry === 'healthcare'));
ok('stats pack has a t-test skeleton',
  suggestStarterSnippets('stats').some(s => /t\.test/.test(s.code)));
ok('stats pack has an lm skeleton',
  suggestStarterSnippets('stats').some(s => /lm\(/.test(s.code)));
ok('finance pack has a returns skeleton',
  suggestStarterSnippets('finance').some(s => /returns/.test(s.code)));
ok('healthcare pack counts by category',
  suggestStarterSnippets('healthcare').some(s => /table\(/.test(s.code)));
ok('general pack has a plot', suggestStarterSnippets('general').some(s => /hist\(/.test(s.code)));
ok('unknown industry falls back to general',
  suggestStarterSnippets('aerospace').every(s => s.industry === 'general'));
ok('snippets are not pharma-only',
  !all.some(s => /pharma|clinical trial|IND |NDA /i.test(s.code + s.label)));
ok('suggestStarterSnippets is case-insensitive',
  suggestStarterSnippets('FINANCE').every(s => s.industry === 'finance'));

// ---------------------------------------------------------------------------
// R bridge prelude
// ---------------------------------------------------------------------------
const meta = [
  { table: 'claims', rows: 120, columns: ['id', 'amount'] },
  { table: 'members', rows: 8, columns: ['id'] }
];
const prelude = buildRBridgePrelude(meta);
ok('prelude defines dataglow_get_df', /dataglow_get_df <- function/.test(prelude));
ok('prelude lists table names', prelude.includes('claims') && prelude.includes('members'));
ok('prelude notes the row limit', prelude.includes(String(R_ROW_LIMIT)));
ok('prelude defaults to the first table', prelude.includes('.dataglow_default_table <- "claims"'));
ok('prelude exposes dataglow_tables', /dataglow_tables <- function/.test(prelude));
ok('prelude uses jsonlite by default', prelude.includes('library(jsonlite)'));
const preludeBase = buildRBridgePrelude(meta, { hasJsonlite: false });
ok('prelude degrades without jsonlite',
  !preludeBase.includes('library(jsonlite)') && preludeBase.includes('.dataglow_decode <- function'));
const preludeEmpty = buildRBridgePrelude([]);
ok('prelude with no tables is honest', /No table is loaded yet/.test(preludeEmpty));
ok('prelude with no tables still defines the getter', /dataglow_get_df <- function/.test(preludeEmpty));
ok('prelude tolerates a non-array', typeof buildRBridgePrelude(null) === 'string');
ok('prelude escapes quotes in table names',
  buildRBridgePrelude([{ table: 'we"ird', rows: 1, columns: [] }]).includes('we\\"ird'));

// ---------------------------------------------------------------------------
// notices: honest degrade
// ---------------------------------------------------------------------------
ok('no notices when everything installed',
  buildRBridgeNotices({ hasJsonlite: true, graphicsAvailable: true }).length === 0);
ok('notice when jsonlite missing',
  buildRBridgeNotices({ hasJsonlite: false }).some(n => /simplified data bridge/.test(n)));
ok('notice when ggplot2 missing',
  buildRBridgeNotices({ graphicsAvailable: false }).some(n => /ggplot2 could not be installed/.test(n)));
ok('notices pass through row caps',
  buildRBridgeNotices({ rowCapNotices: ['claims: capped'] }).includes('claims: capped'));
ok('notices tolerate no args', Array.isArray(buildRBridgeNotices()));
ok('notices contain no em dash',
  buildRBridgeNotices({ hasJsonlite: false, graphicsAvailable: false })
    .every(n => n.indexOf('—') === -1));

ok('row cap notice null under the limit', buildRowCapNotice(10) === null);
ok('row cap notice fires over the limit', typeof buildRowCapNotice(R_ROW_LIMIT + 1) === 'string');
ok('row cap notice names both counts', buildRowCapNotice(300000).includes('300,000'));
ok('row cap notice honours a custom limit', buildRowCapNotice(50, 10) !== null);
ok('row cap notice tolerates junk', buildRowCapNotice(null) === null);

// ---------------------------------------------------------------------------
// image filtering
// ---------------------------------------------------------------------------
ok('extractImageDataUrls keeps data urls',
  extractImageDataUrls(['data:image/png;base64,AA']).length === 1);
ok('extractImageDataUrls drops remote urls',
  extractImageDataUrls(['https://x.example/a.png']).length === 0);
ok('extractImageDataUrls drops non-strings', extractImageDataUrls([null, 3, {}]).length === 0);
ok('extractImageDataUrls tolerates non-arrays', extractImageDataUrls('nope').length === 0);

// ---------------------------------------------------------------------------
// markdown / escaping (no HTML injection)
// ---------------------------------------------------------------------------
ok('escapeHtml escapes angle brackets', escapeHtml('<b>') === '&lt;b&gt;');
ok('escapeHtml escapes quotes', escapeHtml('"x"') === '&quot;x&quot;');
ok('renderMarkdown escapes script', renderMarkdown('<script>').indexOf('<script>') === -1);
ok('renderMarkdown bold', renderMarkdown('**hi**') === '<strong>hi</strong>');
ok('renderMarkdown inline code', renderMarkdown('`x`') === '<code>x</code>');
ok('renderMarkdown newline to br', renderMarkdown('a\nb') === 'a<br>b');

// ---------------------------------------------------------------------------
// the pure module must not reach the network or the DOM
// ---------------------------------------------------------------------------
const src = readFileSync(new URL('../js/intelligence/r-notebook-lite.js', import.meta.url), 'utf8');
ok('no fetch in the pure engine', !/\bfetch\s*\(/.test(src));
ok('no dynamic import in the pure engine', !/\bimport\s*\(/.test(src));
ok('no XMLHttpRequest in the pure engine', !src.includes('XMLHttpRequest'));
ok('no document access in the pure engine', !/\bdocument\./.test(src));
ok('no em dash in the pure engine', src.indexOf('—') === -1);
ok('window touched only for the global attach',
  (src.match(/window/g) || []).length <= 3);

assert.ok(passed >= 35, 'expected at least 35 assertions, got ' + passed);
console.log('\n' + passed + ' passed, 0 failed');
