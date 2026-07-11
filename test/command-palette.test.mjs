// Command Deck, Part 2 -- pure command-palette logic. No DOM/browser needed
// (matches this repo's convention for ships-dark logic with no wiring yet
// as the visible UI -- Part 2 ships behind the `dataglowCommandPalette`
// flag; opening the palette is the only way to reach it).
//
// buildCommandList's tab commands are exercised against the REAL TAB_META/
// tabOrder read directly off disk (regex-extracted, not hand-copied) so this
// suite can never silently drift out of sync with the app's actual tabs the
// way a hand-maintained duplicate list could -- same discipline as
// command-deck-nav.test.mjs in Part 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  COMMAND_ACTIONS,
  buildCommandList,
  scoreCommand,
  filterCommands,
} from '../js/app-shell/command-palette.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainJsPath = join(__dirname, '..', 'js', 'app-shell', 'main.js');
const stateJsPath = join(__dirname, '..', 'js', 'app-shell', 'state.js');

function readRealTabMeta() {
  const src = readFileSync(mainJsPath, 'utf8');
  const match = src.match(/const TAB_META = \{([\s\S]*?)\n\};/);
  assert.ok(match, 'could not find TAB_META block in main.js -- has it moved or been renamed?');
  const body = match[1];
  const tabMeta = {};
  const entryRe = /(\w+):\s*\{\s*label:\s*'([^']*)',\s*icon:\s*'([^']*)'\s*\}/g;
  let m;
  while ((m = entryRe.exec(body))) {
    tabMeta[m[1]] = { label: m[2], icon: m[3] };
  }
  assert.ok(Object.keys(tabMeta).length > 0, 'parsed zero tabs out of TAB_META -- regex likely stale');
  return tabMeta;
}

function readRealTabOrder() {
  const src = readFileSync(stateJsPath, 'utf8');
  const match = src.match(/tabOrder:\s*\[([^\]]*)\]/);
  assert.ok(match, 'could not find tabOrder in state.js -- has it moved or been renamed?');
  return match[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

const REAL_TAB_META = readRealTabMeta();
const REAL_TAB_ORDER = readRealTabOrder();

test('buildCommandList: emits one tab command per real tab, in real tabOrder order', () => {
  const commands = buildCommandList({ tabMeta: REAL_TAB_META, tabOrder: REAL_TAB_ORDER });
  const tabCommands = commands.filter(c => c.type === 'tab');
  assert.equal(tabCommands.length, REAL_TAB_ORDER.length);
  assert.deepEqual(tabCommands.map(c => c.tabId), REAL_TAB_ORDER);
});

test('buildCommandList: tab command label and icon are resolved from the real tabMeta', () => {
  const commands = buildCommandList({ tabMeta: REAL_TAB_META, tabOrder: REAL_TAB_ORDER });
  const sqlCmd = commands.find(c => c.tabId === 'sql');
  assert.ok(sqlCmd, 'expected a tab command for sql');
  assert.equal(sqlCmd.label, `Go to ${REAL_TAB_META.sql.label}`);
  assert.equal(sqlCmd.icon, REAL_TAB_META.sql.icon);
});

test('buildCommandList: never lists a tab command for a tab that does not exist in tabMeta', () => {
  const commands = buildCommandList({ tabMeta: { sql: REAL_TAB_META.sql }, tabOrder: ['sql', 'ghost-tab'] });
  const tabCommands = commands.filter(c => c.type === 'tab');
  assert.deepEqual(tabCommands.map(c => c.tabId), ['sql']);
});

test('buildCommandList: with no args, returns no tab commands and no whenTab-restricted actions', () => {
  const commands = buildCommandList({});
  assert.equal(commands.filter(c => c.type === 'tab').length, 0);
  const restrictedStillShown = commands.filter(c => c.type === 'action' && COMMAND_ACTIONS.find(a => a.id === c.id)?.whenTab);
  assert.equal(restrictedStillShown.length, 0);
});

test('buildCommandList: action with a whenTab is only offered when that tab is active', () => {
  const onSql = buildCommandList({ tabMeta: REAL_TAB_META, tabOrder: REAL_TAB_ORDER, activeTab: 'sql' });
  assert.ok(onSql.some(c => c.id === 'action-run-sql'));
  assert.ok(!onSql.some(c => c.id === 'action-run-validation'));

  const onValidate = buildCommandList({ tabMeta: REAL_TAB_META, tabOrder: REAL_TAB_ORDER, activeTab: 'validate' });
  assert.ok(onValidate.some(c => c.id === 'action-run-validation'));
  assert.ok(!onValidate.some(c => c.id === 'action-run-sql'));
});

test('buildCommandList: action with no whenTab is offered regardless of active tab', () => {
  const onSql = buildCommandList({ tabMeta: REAL_TAB_META, tabOrder: REAL_TAB_ORDER, activeTab: 'sql' });
  const onStory = buildCommandList({ tabMeta: REAL_TAB_META, tabOrder: REAL_TAB_ORDER, activeTab: 'story' });
  assert.ok(onSql.some(c => c.id === 'action-run-diagnostics'));
  assert.ok(onStory.some(c => c.id === 'action-run-diagnostics'));
  assert.ok(onSql.some(c => c.id === 'action-export-xlsx'));
  assert.ok(onStory.some(c => c.id === 'action-export-xlsx'));
});

test('buildCommandList: every COMMAND_ACTIONS entry has a stable, non-empty `run` id', () => {
  for (const action of COMMAND_ACTIONS) {
    assert.ok(typeof action.run === 'string' && action.run.length > 0, `action ${action.id} is missing a run id`);
    assert.ok(typeof action.id === 'string' && action.id.length > 0);
    assert.ok(typeof action.label === 'string' && action.label.length > 0);
  }
});

test('scoreCommand: empty query matches everything with a weak positive score', () => {
  assert.ok(scoreCommand({ label: 'Go to SQL' }, '') > 0);
  assert.ok(scoreCommand({ label: 'Go to SQL' }, '   ') > 0);
});

test('scoreCommand: exact match scores highest, then prefix, then substring, then keyword, then fuzzy', () => {
  const exact = scoreCommand({ label: 'sql' }, 'sql');
  const prefix = scoreCommand({ label: 'sql tab' }, 'sql');
  const substring = scoreCommand({ label: 'go to sql' }, 'sql');
  const keyword = scoreCommand({ label: 'run query', keywords: ['execute', 'query'] }, 'exec');
  const fuzzy = scoreCommand({ label: 'go to sql' }, 'gts');

  assert.ok(exact > prefix);
  assert.ok(prefix > substring);
  assert.ok(substring > keyword);
  assert.ok(keyword > fuzzy);
  assert.ok(fuzzy > 0);
});

test('scoreCommand: returns 0 for a query with no match at all (not a subsequence, no keyword hit)', () => {
  assert.equal(scoreCommand({ label: 'go to sql' }, 'zzz'), 0);
  assert.equal(scoreCommand({ label: 'run query' }, 'xyz123'), 0);
});

test('scoreCommand: is case-insensitive', () => {
  assert.equal(scoreCommand({ label: 'Go to SQL' }, 'go to sql'), 100);
  assert.equal(scoreCommand({ label: 'go to sql' }, 'GO TO SQL'), 100);
});

test('filterCommands: excludes zero-score commands and ranks the rest best-first', () => {
  const commands = [
    { label: 'Go to Story' },
    { label: 'Go to SQL' },
    { label: 'SQL tab' },
    { label: 'Go to Python' },
  ];
  const result = filterCommands(commands, 'sql');
  // 'SQL tab' starts with the query (prefix match, higher score) while
  // 'Go to SQL' only contains it as a substring -- prefix ranks first.
  assert.deepEqual(result.map(c => c.label), ['SQL tab', 'Go to SQL']);
});

test('filterCommands: preserves original relative order for equal scores (stable sort)', () => {
  const commands = [
    { label: 'Alpha SQL' },
    { label: 'Beta SQL' },
    { label: 'Gamma SQL' },
  ];
  const result = filterCommands(commands, 'sql');
  assert.deepEqual(result.map(c => c.label), ['Alpha SQL', 'Beta SQL', 'Gamma SQL']);
});

test('filterCommands: respects an optional result limit', () => {
  const commands = [
    { label: 'Go to Story' },
    { label: 'Go to SQL' },
    { label: 'Go to Python' },
    { label: 'Go to R' },
  ];
  const result = filterCommands(commands, '', 2);
  assert.equal(result.length, 2);
});

test('filterCommands: empty query with no limit returns every command, unfiltered', () => {
  const commands = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];
  const result = filterCommands(commands, '');
  assert.equal(result.length, 3);
});

test('filterCommands: never mutates the input array', () => {
  const commands = [{ label: 'Go to SQL' }, { label: 'Go to Python' }];
  const snapshot = JSON.stringify(commands);
  filterCommands(commands, 'py');
  assert.equal(JSON.stringify(commands), snapshot);
});

test('end-to-end: typing a loose query against the real tab list finds the right tab command', () => {
  const commands = buildCommandList({ tabMeta: REAL_TAB_META, tabOrder: REAL_TAB_ORDER });
  const results = filterCommands(commands, 'valid');
  assert.ok(results.some(c => c.tabId === 'validate'), 'expected "valid" to find the Validate tab command');
});
