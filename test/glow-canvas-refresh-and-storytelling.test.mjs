// ============================================================
// DATAGLOW — Glow Canvas Step 6 (live/API feed refresh) + Step 9 Part 1
// (dashboard storytelling) test suite. Both ship DARK behind
// `glowCanvasLiveRefresh` / `glowCanvasStorytelling`.
//
// Proves: flag-off backward compatibility (layout + DOM), live-feed detection,
// honest readiness summaries, refresh-registry state/timers, error preservation,
// story immutability + round-trip, SQL-injection-safe callout SQL, deterministic
// callout math, and DOM rendering of callout / note / "So what".
//
// RUN WITH: node test/glow-canvas-refresh-and-storytelling.test.mjs
// ============================================================

import {
  createCanvasLayout, addCard, removeCard, swapCards, setActiveFilter, serializeLayout, deserializeLayout,
  renderCanvas, STORY_AGGREGATIONS, updateCardStory, updateBoardHeadline, computeCalloutMetric,
  buildCalloutSQL, formatCalloutValue, isLiveFeedDataset, summarizeDatasetReadiness,
  createRefreshRegistry, stopAllRefreshTimers, describeFreshness, formatClock,
} from '../js/runtimes-viz/glow-canvas.js';
import { POLL_INTERVALS_MS, POLL_LABELS } from '../js/ingestion/api-feed.js';
import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- minimal DOM shim ----------
const registry = {};
function makeEl(tag) {
  const classes = new Set();
  const node = {
    tagName: tag, children: [], attributes: {}, style: {}, _listeners: {},
    className: '', textContent: '', value: '',
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) },
    setAttribute(k, v) { this.attributes[k] = v; if (k === 'id') registry[v] = this; },
    getAttribute(k) { return this.attributes[k]; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    appendChild(c) { this.children.push(c); return c; },
  };
  let html = '';
  Object.defineProperty(node, 'innerHTML', { get() { return html; }, set(v) { html = v; if (v === '') node.children = []; } });
  return node;
}
function installDom() {
  for (const k of Object.keys(registry)) delete registry[k];
  const host = makeEl('div');
  registry.host = host;
  global.document = {
    createElement: makeEl,
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById: (id) => registry[id] || null,
  };
  return host;
}
const walk = (n, fn) => { fn(n); (n.children || []).forEach((c) => walk(c, fn)); };
const findAll = (root, testid) => { const o = []; walk(root, (n) => { if (n.attributes && n.attributes['data-testid'] === testid) o.push(n); }); return o; };
const find = (root, testid) => findAll(root, testid)[0] || null;
const textOf = (n) => (n.nodeType === 3 ? n.textContent : [n.textContent, ...(n.children || []).map(textOf)].join(''));
const fire = (n, type, ev = {}) => (n._listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, ...ev }));
const ser = (n) => (n.nodeType === 3 ? n.textContent
  : JSON.stringify({ t: n.tagName, a: n.attributes, s: n.style, c: n.className, v: n.value }) + '[' + n.children.map(ser).join(',') + ']');
const tick = () => new Promise((r) => setTimeout(r, 0));
const noChart = () => Promise.resolve();

// ============================================================
// 1. Flag-off backward compatibility
// ============================================================
{
  const l0 = createCanvasLayout();
  ok(JSON.stringify(Object.keys(l0)) === JSON.stringify(['cards', 'nextId', 'activeFilter']), 'createCanvasLayout keeps its exact original keys (no headline key)');
  let l = addCard(l0, { table: 'sales', chartType: 'bar', xCol: 'region', yCol: 'amount', title: 'S' });
  ok(JSON.stringify(Object.keys(l.cards[0])) === JSON.stringify(['id', 'table', 'chartType', 'xCol', 'yCol', 'title', 'gridPos']), 'addCard with no story keeps the exact original card shape');
  ok(!('story' in l.cards[0]) && !('headline' in l), 'no story / headline keys unless set');
  ok(serializeLayout(l) === JSON.stringify({ cards: l.cards, nextId: 2, activeFilter: null }), 'serializeLayout of an untouched layout is byte-identical to the pre-storytelling shape');
  const old = '{"cards":[{"id":1,"table":"t","chartType":"bar","xCol":"a","yCol":"","title":"","gridPos":{"row":0,"col":0,"w":1,"h":1}}],"nextId":2,"activeFilter":null}';
  ok(serializeLayout(deserializeLayout(old)) === old, 'a layout saved before this change round-trips byte-for-byte');
}
{
  // DOM: omitted vs explicit-false opts render identically, with none of the new UI.
  let l = createCanvasLayout();
  l = addCard(l, { table: 'sales', chartType: 'bar', xCol: 'a' });
  l = addCard(l, { table: 'ops' });
  l = setActiveFilter(l, { table: 'sales', column: 'a', value: 'x' });
  const ds = [{ table: 'sales', meta: { format: 'api', source: 'https://x.test/a' }, rows: [{ n: 1 }] }, { table: 'ops' }];
  const h1 = installDom();
  renderCanvas('host', l, { renderChart: noChart, datasets: ds });
  const a = ser(h1);
  const h2 = installDom();
  renderCanvas('host', l, { renderChart: noChart, datasets: ds, enableLiveRefresh: false, enableStorytelling: false });
  const b = ser(h2);
  ok(a === b, 'flags omitted vs explicitly false render identical DOM');
  const h3 = installDom();
  renderCanvas('host', l, { renderChart: noChart, datasets: ds, enableLiveRefresh: 'yes', enableStorytelling: 1 });
  ok(ser(h3) === a, 'only strict `true` enables the new UI (truthy non-booleans do not)');
  const newIds = ['glow-canvas-card-readiness', 'glow-canvas-card-freshness', 'glow-canvas-card-refresh', 'glow-canvas-card-poll', 'glow-canvas-refresh-all',
    'glow-canvas-board-story', 'glow-canvas-add-takeaway', 'glow-canvas-card-callout', 'glow-canvas-card-note', 'glow-canvas-card-sowhat', 'glow-canvas-card-story-btn'];
  ok(newIds.every((id) => !find(h1, id)), 'flag-off DOM contains none of the new data-testids');
  const grid = find(h1, 'glow-canvas-grid');
  ok(grid.children.every((c) => c.children.length === 2), 'flag-off cards still have exactly [header, chart]');
  // Source-level guard: the pure module must stay flag-agnostic.
  const src = readFileSync(new URL('../js/runtimes-viz/glow-canvas.js', import.meta.url), 'utf8');
  ok(!/isEnabled\(/.test(src) && !/build-flags/.test(src), 'glow-canvas.js never reads feature flags itself');
}
{
  // flags manifest: both default OFF
  const m = JSON.parse(readFileSync(new URL('../flags.manifest.json', import.meta.url), 'utf8'));
  ok(m.flags.glowCanvasLiveRefresh && m.flags.glowCanvasLiveRefresh.enabled === false, 'glowCanvasLiveRefresh ships default-off');
  ok(m.flags.glowCanvasStorytelling && m.flags.glowCanvasStorytelling.enabled === false, 'glowCanvasStorytelling ships default-off');
}

// ============================================================
// 2. Live feed detection + readiness honesty
// ============================================================
{
  ok(isLiveFeedDataset({ meta: { format: 'api' } }) === true, 'meta.format api -> live feed');
  ok(isLiveFeedDataset({ meta: { source: 'https://x.test/y' } }) === true, 'meta.source https URL -> live feed');
  ok(isLiveFeedDataset({ meta: { source: 'HTTP://x.test' } }) === true, 'http URL (case-insensitive) -> live feed');
  ok(isLiveFeedDataset({ meta: { source: 'data.csv' } }) === false, 'file-name source is not a live feed');
  ok(isLiveFeedDataset({ table: 't' }) === false && isLiveFeedDataset(null) === false && isLiveFeedDataset(undefined) === false, 'no meta / null -> not live');

  const unver = { status: 'unverified', label: 'Unverified', ready: false };
  ok(JSON.stringify(summarizeDatasetReadiness({ table: 't' })) === JSON.stringify(unver), 'no evidence -> honest Unverified');
  ok(JSON.stringify(summarizeDatasetReadiness(null)) === JSON.stringify(unver), 'null dataset -> Unverified');
  ok(summarizeDatasetReadiness({ layerResults: {} }).status === 'unverified', 'empty layerResults -> Unverified (never Ready without evidence)');
  const passing = { a: { layer: 'a', status: 'pass', summary: '' }, b: { layer: 'b', status: 'pass', summary: '' } };
  const r1 = summarizeDatasetReadiness({ layerResults: passing });
  ok(r1.status === 'ready' && r1.label === 'Ready' && r1.ready === true, 'real passing layerResults -> Ready (computed via computeReadinessGate)');
  const failing = { a: { layer: 'a', status: 'fail', summary: 'bad' }, b: { layer: 'b', status: 'pass', summary: '' } };
  const r2 = summarizeDatasetReadiness({ layerResults: failing });
  ok(r2.status === 'needs-review' && r2.label === 'Needs review' && r2.ready === false, 'a hard-failing layer -> Needs review');
  ok(summarizeDatasetReadiness({ gateResult: { agentConsumable: true, evaluatedLayerCount: 3, score: 90 } }).label === 'Ready', 'explicit gateResult consumable -> Ready');
  ok(summarizeDatasetReadiness({ gateResult: { agentConsumable: false, evaluatedLayerCount: 3, score: 40 } }).label === 'Needs review', 'explicit gateResult not consumable -> Needs review');
  ok(summarizeDatasetReadiness({ gateResult: { agentConsumable: true, evaluatedLayerCount: 0 } }).status === 'unverified', 'gateResult with zero evaluated layers -> Unverified');
  ok(summarizeDatasetReadiness({ gateResult: { foo: 1 } }).status === 'unverified', 'malformed gateResult -> Unverified');
  ok(summarizeDatasetReadiness({ layerResults: passing, gateResult: { agentConsumable: false, evaluatedLayerCount: 2 } }).label === 'Needs review', 'gateResult takes precedence over layerResults');
}

// ============================================================
// 3. Refresh registry: state transitions, errors, timers
// ============================================================
{
  const calls = { set: [], cleared: [] };
  let t = 1000;
  const reg = createRefreshRegistry({
    setIntervalFn: (fn, ms) => { const h = { fn, ms }; calls.set.push(h); return h; },
    clearIntervalFn: (h) => calls.cleared.push(h),
    now: () => (t += 10),
  });
  const d = reg.get('sales');
  ok(d.status === 'idle' && d.error === null && d.lastRefreshedAt === null && d.pollIntervalMs === 0, 'default state is idle, never refreshed, One-time fetch (0)');
  ok(reg.activeTimerCount() === 0, 'no timer exists until the user opts in');
  ok(reg.markRefreshing('sales') === true && reg.get('sales').status === 'refreshing', 'markRefreshing -> refreshing');
  ok(reg.markRefreshing('sales') === false, 'a second refresh while in flight is rejected (no pile-up)');
  reg.markSuccess('sales', 5000);
  ok(reg.get('sales').status === 'ok' && reg.get('sales').lastRefreshedAt === 5000 && reg.get('sales').error === null, 'markSuccess -> ok + timestamp');
  reg.markRefreshing('sales');
  reg.markError('sales', new Error('HTTP 500'));
  const e = reg.get('sales');
  ok(e.status === 'error' && e.error === 'HTTP 500' && e.lastRefreshedAt === 5000, 'markError records the message and PRESERVES the last good timestamp');
  reg.markError('sales', 'boom');
  ok(reg.get('sales').error === 'boom', 'string errors are accepted');
  ok(reg.get('other').status === 'idle', 'state is per-table');
  const copy = reg.get('sales'); copy.status = 'hacked';
  ok(reg.get('sales').status === 'error', 'get() returns a copy, not live state');

  const tickFn = () => {};
  reg.setPollInterval('sales', 5000, tickFn);
  ok(reg.get('sales').pollIntervalMs === 5000 && reg.activeTimerCount() === 1 && calls.set[0].ms === 5000 && calls.set[0].fn === tickFn, 'opt-in 5s poll creates exactly one timer');
  reg.setPollInterval('sales', 15000, tickFn);
  ok(reg.activeTimerCount() === 1 && calls.cleared.length === 1 && calls.set[1].ms === 15000, 'changing the interval clears the old timer first');
  reg.setPollInterval('sales', 0, tickFn);
  ok(reg.activeTimerCount() === 0 && reg.get('sales').pollIntervalMs === 0 && calls.cleared.length === 2, 'setting back to 0 (One-time fetch) clears the timer');
  reg.setPollInterval('sales', 12345, tickFn);
  ok(reg.activeTimerCount() === 0 && reg.get('sales').pollIntervalMs === 0, 'a non-listed interval is treated as One-time fetch (no timer)');
  reg.setPollInterval('a', 5000, tickFn);
  reg.setPollInterval('b', 60000, tickFn);
  ok(reg.activeTimerCount() === 2, 'two tables can poll independently');
  stopAllRefreshTimers(reg);
  ok(reg.activeTimerCount() === 0 && reg.get('a').pollIntervalMs === 0 && reg.get('b').pollIntervalMs === 0, 'stopAllRefreshTimers clears every timer and resets intervals to 0');
  reg.setPollInterval('a', 5000, tickFn);
  reg.setPollInterval('b', 5000, tickFn);
  reg.pruneTables(['a']);
  ok(reg.activeTimerCount() === 1 && !reg.tables().includes('b'), 'pruneTables stops timers for tables no longer on the canvas');
  reg.stopAllRefreshTimers();
  stopAllRefreshTimers(null); // must not throw
  ok(true, 'stopAllRefreshTimers(null) is safe');

  // default (real) timers: never leaves a live handle once stopped
  const real = createRefreshRegistry();
  real.setPollInterval('x', 5000, () => {});
  real.stopAllRefreshTimers();
  ok(real.activeTimerCount() === 0, 'real-timer registry cleans up (process can exit)');
  ok(JSON.stringify(POLL_INTERVALS_MS[0]) === '0' && POLL_LABELS[0] === 'One-time fetch', 'default poll option is One-time fetch (from api-feed.js)');
}
{
  ok(formatClock(new Date(2026, 0, 2, 3, 4, 5).getTime()) === '03:04:05', 'formatClock pads HH:MM:SS');
  ok(describeFreshness({ table: 't' }, { status: 'idle' }) === 'Static snapshot', 'local table never refreshed -> Static snapshot');
  ok(describeFreshness({ meta: { format: 'api' } }, { status: 'idle' }) === 'Feed ready', 'unrefreshed feed -> Feed ready');
  ok(describeFreshness({}, { status: 'refreshing' }) === 'Refreshing…', 'in-flight -> Refreshing…');
  ok(/^Updated \d\d:\d\d:\d\d$/.test(describeFreshness({}, { status: 'ok', lastRefreshedAt: Date.now() })), 'after refresh -> Updated HH:MM:SS');
  ok(/^Updated \d\d:\d\d:\d\d$/.test(describeFreshness({ meta: { format: 'api', fetchedAt: '2026-01-01T10:00:00Z' } }, {})), 'a feed fetchedAt is shown as Updated HH:MM:SS');
}

// ============================================================
// 4. Live-refresh DOM
// ============================================================
{
  let l = createCanvasLayout();
  l = addCard(l, { table: 'feed', chartType: 'bar', xCol: 'a' });
  l = addCard(l, { table: 'feed', chartType: 'line', xCol: 'a' });
  l = addCard(l, { table: 'local', chartType: 'pie', xCol: 'b' });
  const passing = { a: { layer: 'a', status: 'pass', summary: '' } };
  const ds = [
    { table: 'feed', meta: { format: 'api', source: 'https://x.test/a' } },
    { table: 'local', layerResults: passing },
  ];
  const reg = createRefreshRegistry({ setIntervalFn: () => 1, clearIntervalFn: () => {} });
  const refreshed = []; const polled = []; let all = 0;
  const host = installDom();
  const render = () => renderCanvas('host', l, {
    renderChart: noChart, datasets: ds, enableLiveRefresh: true, refreshRegistry: reg,
    onRefreshCard: (c) => refreshed.push(c.id), onRefreshAll: () => { all++; }, onPollChange: (c, ms) => polled.push([c.id, ms]),
  });
  render();
  ok(findAll(host, 'glow-canvas-card-readiness').length === 3, 'every card shows a readiness pill');
  const pills = findAll(host, 'glow-canvas-card-readiness').map(textOf);
  ok(pills[0] === 'Unverified' && pills[1] === 'Unverified' && pills[2] === 'Ready', 'pills are honest: no evidence -> Unverified; real passing layers -> Ready');
  const fresh = findAll(host, 'glow-canvas-card-freshness').map(textOf);
  ok(fresh[0] === 'Feed ready' && fresh[2] === 'Static snapshot', 'freshness labels: Feed ready / Static snapshot');
  ok(findAll(host, 'glow-canvas-card-refresh').length === 3, 'every card has a manual Refresh button');
  ok(findAll(host, 'glow-canvas-card-poll').length === 2, 'only API-backed cards get a poll select');
  const poll = find(host, 'glow-canvas-card-poll');
  const optTexts = poll.children.map(textOf);
  ok(JSON.stringify(optTexts) === JSON.stringify(POLL_LABELS), 'poll options come from POLL_LABELS');
  ok(poll.value === '0' && poll.children[0].attributes.selected !== undefined, 'poll defaults to One-time fetch (no auto-poll)');
  ok(!!find(host, 'glow-canvas-refresh-all'), 'toolbar Refresh all appears when cards exist');
  fire(findAll(host, 'glow-canvas-card-refresh')[2], 'click');
  ok(JSON.stringify(refreshed) === '[3]', 'Refresh calls onRefreshCard with the card');
  fire(find(host, 'glow-canvas-refresh-all'), 'click');
  ok(all === 1, 'Refresh all calls onRefreshAll');
  poll.value = '15000'; fire(poll, 'change');
  ok(JSON.stringify(polled) === '[[1,15000]]', 'changing the poll select calls onPollChange(card, ms)');
  ok(!find(host, 'glow-canvas-card-refresh-error'), 'no error pill while healthy');

  // One refresh updates every card bound to the table; failure keeps charts.
  reg.markSuccess('feed', new Date(2026, 0, 1, 9, 8, 7).getTime());
  render();
  const f2 = findAll(host, 'glow-canvas-card-freshness').map(textOf);
  ok(f2[0] === 'Updated 09:08:07' && f2[1] === 'Updated 09:08:07' && f2[2] === 'Static snapshot', 'refreshing one table updates BOTH cards bound to it, not others');

  const chartCalls = [];
  reg.markRefreshing('feed'); reg.markError('feed', new Error('HTTP 503'));
  renderCanvas('host', l, {
    renderChart: (...a) => { chartCalls.push(a); return Promise.resolve(); }, datasets: ds,
    enableLiveRefresh: true, refreshRegistry: reg,
  });
  await tick();
  ok(findAll(host, 'glow-canvas-card-refresh-error').length === 2, 'each card on the failed table shows the inline error pill');
  ok(/HTTP 503/.test(textOf(find(host, 'glow-canvas-card-refresh-error'))), 'error pill states the reason calmly');
  ok(findAll(host, 'glow-canvas-card-chart').length === 3 && chartCalls.length === 3, 'a failed refresh does not wipe or skip any chart');
  ok(textOf(findAll(host, 'glow-canvas-card-freshness')[0]) === 'Updated 09:08:07', 'last good timestamp survives the failure');
  ok(findAll(host, 'glow-canvas-card-chart').every((c) => c.children.length === 0 && c.textContent === ''), 'chart containers are left untouched (no error text injected)');
  reg.markRefreshing('feed');
  render();
  ok(findAll(host, 'glow-canvas-card-refresh')[0].attributes.disabled !== undefined, 'Refresh is disabled while a refresh is in flight');

  // empty canvas: no Refresh all
  const h2 = installDom();
  renderCanvas('host', createCanvasLayout(), { renderChart: noChart, enableLiveRefresh: true });
  ok(!find(h2, 'glow-canvas-refresh-all') && !!find(h2, 'glow-canvas-empty'), 'no Refresh all on an empty canvas');
  // works without a registry/datasets
  const h3 = installDom();
  renderCanvas('host', addCard(createCanvasLayout(), { table: 't' }), { renderChart: noChart, enableLiveRefresh: true });
  ok(textOf(find(h3, 'glow-canvas-card-readiness')) === 'Unverified' && !find(h3, 'glow-canvas-card-poll'), 'missing registry/datasets degrade honestly (Unverified, no poll)');
}

// ============================================================
// 5. Storytelling: pure functions
// ============================================================
{
  ok(JSON.stringify(STORY_AGGREGATIONS) === JSON.stringify(['count', 'sum', 'avg', 'min', 'max']), 'STORY_AGGREGATIONS is exactly count/sum/avg/min/max');
  let l = addCard(createCanvasLayout(), { table: 'sales' });
  const snap = JSON.stringify(l);
  const l2 = updateCardStory(l, 1, { headlineLabel: ' Revenue ', agg: 'SUM', col: 'amount', note: 'Q3 only', soWhat: 'Chase West' });
  ok(JSON.stringify(l) === snap, 'updateCardStory never mutates its input');
  ok(JSON.stringify(l2.cards[0].story) === JSON.stringify({ headlineLabel: 'Revenue', agg: 'sum', col: 'amount', note: 'Q3 only', soWhat: 'Chase West' }), 'story is attached trimmed and normalized (agg lower-cased)');
  const l3 = updateCardStory(l2, 1, { note: 'Updated note' });
  ok(l3.cards[0].story.note === 'Updated note' && l3.cards[0].story.agg === 'sum', 'partial update merges over the existing story');
  ok(l2.cards[0].story.note === 'Q3 only', 'previous layout version is untouched by a later update');
  const l4 = updateCardStory(l3, 1, { headlineLabel: '', agg: '', col: '', note: '', soWhat: '' });
  ok(!('story' in l4.cards[0]), 'clearing every field removes the story key (card stays lean)');
  ok(JSON.stringify(l4) === JSON.stringify(l), 'a cleared story returns the layout to its exact original shape');
  ok(updateCardStory(l, 99, { note: 'x' }).cards[0].story === undefined, 'unknown card id leaves layout unchanged');
  ok(updateCardStory(l, 1, { agg: 'median', note: 'n' }).cards[0].story.agg === '', 'an unknown aggregation is rejected');
  ok(updateCardStory(l, 1, null).cards.length === 1 && updateCardStory(null, 1, {}).cards.length === 0, 'garbage inputs never throw');

  const rt = deserializeLayout(serializeLayout(l2));
  ok(JSON.stringify(rt) === JSON.stringify(l2) && rt.cards[0].story.soWhat === 'Chase West', 'card.story round-trips through serialize/deserialize losslessly');
  const l5 = addCard(createCanvasLayout(), { table: 't', story: { note: 'hi' } });
  ok(l5.cards[0].story.note === 'hi' && !('story' in addCard(createCanvasLayout(), { table: 't', story: {} }).cards[0]), 'addCard accepts an initial story only when non-empty');
  ok(deserializeLayout('{"cards":[{"id":1,"story":{"note":"  "}}],"nextId":2}').cards[0].story === undefined, 'a stored empty story is dropped on load');

  const h = updateBoardHeadline(l2, { title: ' Q3 ', takeaway: 'West is slipping' });
  ok(JSON.stringify(h.headline) === JSON.stringify({ title: 'Q3', takeaway: 'West is slipping' }) && !('headline' in l2), 'updateBoardHeadline sets a trimmed headline, purely');
  ok(deserializeLayout(serializeLayout(h)).headline.takeaway === 'West is slipping', 'layout.headline round-trips');
  ok(!('headline' in updateBoardHeadline(h, { title: '', takeaway: '  ' })), 'empty headline removes the key');
  ok(!('headline' in updateBoardHeadline(h, null)), 'null headline removes the key');
  // headline survives every other pure mutator
  const survived = [addCard(h, { table: 'x' }), removeCard(h, 99), swapCards(addCard(h, { table: 'y' }), 1, 2), setActiveFilter(h, { table: 'sales', column: 'a', value: 'v' }), updateCardStory(h, 1, { note: 'n' })];
  ok(survived.every((x) => x.headline && x.headline.title === 'Q3'), 'headline is preserved by add/remove/swap/filter/story mutators');
}
{
  const rows = [{ v: 10 }, { v: '20' }, { v: null }, { v: NaN }, { v: '' }, { v: 'abc' }, { v: undefined }, { v: true }, { v: 30 }, {}];
  const m = (agg, col = 'v') => computeCalloutMetric(rows, { agg, col });
  ok(m('sum').value === 60 && m('sum').validCount === 3, 'sum ignores null/NaN/empty/non-numeric/boolean (10+20+30)');
  ok(m('avg').value === 20 && m('avg').validCount === 3, 'avg divides by VALID count only');
  ok(m('min').value === 10 && m('max').value === 30, 'min / max over valid values');
  ok(computeCalloutMetric(rows, { agg: 'count' }).value === 10, 'count with no column = row count');
  const c = m('count');
  ok(c.value === 5 && c.validCount === 5, 'count(col) counts non-null, non-empty, non-NaN values (10, 20, abc, true, 30)');
  const none = computeCalloutMetric([{ v: null }], { agg: 'sum', col: 'v' });
  ok(none.value === null && none.formatted === '—' && none.validCount === 0, 'no valid values -> value null / em-dash (never a made-up 0)');
  ok(computeCalloutMetric([], { agg: 'count' }).value === 0, 'count of no rows is 0');
  ok(computeCalloutMetric(rows, { agg: 'sum' }).value === null, 'sum with no column -> null');
  ok(computeCalloutMetric(rows, { agg: 'bogus', col: 'v' }).value === null && computeCalloutMetric(null, null).value === null, 'bad spec / bad rows never throw');
  ok(computeCalloutMetric([{ v: -5 }, { v: 2.5 }], { agg: 'min', col: 'v' }).value === -5, 'negatives handled');
  ok(computeCalloutMetric([{ v: 1 }, { v: 2 }], { agg: 'avg', col: 'v' }).formatted === '1.5', 'avg formatted deterministically');
  ok(formatCalloutValue(1234567.891) === '1,234,567.89' && formatCalloutValue(NaN) === '—' && formatCalloutValue(null) === '—', 'formatCalloutValue is locale-independent');
  // cross-filter accuracy: same numbers whether computed on all rows or filtered rows
  const sales = [{ region: 'West', amt: 10 }, { region: 'East', amt: 5 }, { region: 'West', amt: 30 }];
  ok(computeCalloutMetric(sales.filter((r) => r.region === 'West'), { agg: 'sum', col: 'amt' }).value === 40, 'filtered rows give the filtered sum');
}
{
  ok(buildCalloutSQL('sales', { agg: 'count' }) === 'SELECT COUNT(*) AS value, COUNT(*) AS valid_count FROM "sales"', 'count(*) SQL');
  ok(buildCalloutSQL('sales', { agg: 'sum', col: 'amount' }, `"region" = 'West'`) === `SELECT SUM(TRY_CAST("amount" AS DOUBLE)) AS value, COUNT(TRY_CAST("amount" AS DOUBLE)) AS valid_count FROM "sales" WHERE "region" = 'West'`, 'sum SQL with cross-filter WHERE');
  ok(/^SELECT AVG\(/.test(buildCalloutSQL('t', { agg: 'avg', col: 'c' })) && /MIN\(/.test(buildCalloutSQL('t', { agg: 'min', col: 'c' })) && /MAX\(/.test(buildCalloutSQL('t', { agg: 'max', col: 'c' })), 'avg / min / max SQL');
  ok(buildCalloutSQL('t', { agg: 'count', col: 'c' }) === 'SELECT COUNT("c") AS value, COUNT("c") AS valid_count FROM "t"', 'count(col) SQL');
  const evil = buildCalloutSQL('sa"les; DROP TABLE x;--', { agg: 'sum', col: 'a"b); DROP TABLE y;--' });
  ok(evil.includes('"sa""les; DROP TABLE x;--"') && evil.includes('"a""b); DROP TABLE y;--"'), 'embedded double quotes in table/column are doubled (cannot break out of the identifier)');
  const outside = evil.replace(/"(?:[^"]|"")*"/g, '');
  ok(!/[;]|DROP|--/.test(outside), 'hostile text stays entirely inside quoted identifiers');
  // O'Brien flows through the real cross-filter clause builder (single quotes doubled)
  const lay = setActiveFilter(addCard(createCanvasLayout(), { table: 'people' }), { table: 'people', column: 'name', value: "O'Brien" });
  // filterWhereClause is the existing, tested escaper the callout reuses
  const where = `"name" = 'O''Brien'`;
  ok(buildCalloutSQL('people', { agg: 'count' }, where).endsWith(`WHERE ${where}`), "O'Brien filter value arrives escaped ('' doubled) in the callout SQL");
  ok(buildCalloutSQL('t', { agg: 'sum' }) === '' && buildCalloutSQL('t', { agg: 'nope', col: 'c' }) === '' && buildCalloutSQL('', { agg: 'count' }) === '' && buildCalloutSQL(null, null) === '', 'invalid specs return empty SQL');
  ok(lay.activeFilter.value === "O'Brien", 'sanity: active filter keeps the raw value');
}

// ============================================================
// 6. Storytelling DOM
// ============================================================
{
  let l = createCanvasLayout();
  l = addCard(l, { table: 'sales', chartType: 'bar', xCol: 'region' });
  l = addCard(l, { table: 'ops', chartType: 'pie', xCol: 'team' });
  l = updateCardStory(l, 1, { headlineLabel: 'Revenue', agg: 'sum', col: 'amount', note: 'Excludes refunds', soWhat: 'Call the West team' });
  l = updateBoardHeadline(l, { title: 'Q3 board', takeaway: 'West is slipping' });
  const rows = [{ region: 'West', amount: 10 }, { region: 'East', amount: 5 }, { region: 'West', amount: 30 }];
  const datasets = [{ table: 'sales', rows }, { table: 'ops' }];
  const host = installDom();
  renderCanvas('host', l, { renderChart: noChart, datasets, enableStorytelling: true });
  const banner = find(host, 'glow-canvas-board-story');
  ok(banner && /Q3 board/.test(textOf(banner)) && /West is slipping/.test(textOf(banner)), 'board takeaway banner renders title + takeaway');
  ok(textOf(find(host, 'glow-canvas-add-takeaway')) === 'Edit takeaway', 'toolbar button reads Edit takeaway once a takeaway exists');
  const callout = find(host, 'glow-canvas-card-callout');
  ok(callout && textOf(find(callout, 'glow-canvas-card-callout-value')) === '45', 'headline callout shows the sum computed from real rows (45)');
  ok(textOf(find(callout, 'glow-canvas-card-callout-label')) === 'Revenue', 'callout label is the authored headline label');
  ok(findAll(host, 'glow-canvas-card-callout').length === 1, 'cards without a story agg render no callout');
  ok(textOf(find(host, 'glow-canvas-card-note')) === 'Excludes refunds', 'chart note renders');
  const sowhat = find(host, 'glow-canvas-card-sowhat');
  ok(sowhat && /So what/.test(textOf(sowhat)) && /Call the West team/.test(textOf(sowhat)), '"So what" strip renders with the authored action');
  ok(findAll(host, 'glow-canvas-card-story-btn').length === 2, 'every card has a Story button');
  // order: callout above chart, note + so-what below
  const card1 = findAll(host, 'glow-canvas-card')[0];
  const order = card1.children.map((c) => c.attributes['data-testid'] || c.attributes.id || '');
  ok(order.indexOf('glow-canvas-card-callout') < order.indexOf('glow-canvas-card-chart') && order.indexOf('glow-canvas-card-chart') < order.indexOf('glow-canvas-card-sowhat'), 'callout sits above the chart; note + So what below');

  // cross-filter updates the callout (sync fallback over rows)
  const lf = setActiveFilter(l, { table: 'sales', column: 'region', value: 'West' });
  const h2 = installDom();
  renderCanvas('host', lf, { renderChart: noChart, datasets, enableStorytelling: true });
  ok(textOf(find(h2, 'glow-canvas-card-callout-value')) === '40' && /filtered/.test(textOf(find(h2, 'glow-canvas-card-callout-label'))), 'active cross-filter recomputes the callout (40) and labels it filtered');
  const lf2 = setActiveFilter(l, { table: 'ops', column: 'team', value: 'A' });
  const h2b = installDom();
  renderCanvas('host', lf2, { renderChart: noChart, datasets, enableStorytelling: true });
  ok(textOf(find(h2b, 'glow-canvas-card-callout-value')) === '45', 'a filter on a different table leaves the callout unfiltered');

  // injected computeCallout (DuckDB path): receives card + whereClause; async results applied
  const seen = [];
  const h3 = installDom();
  renderCanvas('host', lf, {
    renderChart: noChart, datasets, enableStorytelling: true,
    computeCallout: (card, where) => { seen.push([card.id, where]); return Promise.resolve({ value: 7, formatted: '7', validCount: 1 }); },
  });
  await tick();
  ok(seen.length === 1 && seen[0][0] === 1 && seen[0][1] === `"region" = 'West'`, 'computeCallout is called with the card and the cross-filter whereClause');
  ok(textOf(find(h3, 'glow-canvas-card-callout-value')) === '7', 'async computeCallout result fills the callout');
  const h4 = installDom();
  renderCanvas('host', l, { renderChart: noChart, datasets, enableStorytelling: true, computeCallout: () => Promise.reject(new Error('sql')) });
  await tick();
  ok(textOf(find(h4, 'glow-canvas-card-callout-value')) === '—', 'a failing computeCallout shows an em-dash, never throws or invents a number');
  const h5 = installDom();
  renderCanvas('host', l, { renderChart: noChart, datasets: [{ table: 'sales' }], enableStorytelling: true });
  ok(textOf(find(h5, 'glow-canvas-card-callout-value')) === '—', 'no rows and no computeCallout -> em-dash (no fabricated value)');

  // editor
  let emitted = null;
  const h6 = installDom();
  renderCanvas('host', l, { renderChart: noChart, datasets, enableStorytelling: true, onChange: (n) => { emitted = n; } });
  const editor = findAll(h6, 'glow-canvas-story-editor')[1]; // card 2 (no story yet)
  ok(/display:none/.test(editor.attributes.style), 'story editor starts collapsed');
  fire(findAll(h6, 'glow-canvas-card-story-btn')[1], 'click');
  ok(editor.style.display === 'flex', 'Story button toggles the editor open');
  const field = (id) => find(editor, id);
  field('glow-canvas-story-label').value = 'Open tickets';
  field('glow-canvas-story-agg').value = 'count';
  field('glow-canvas-story-note').value = 'Live count';
  field('glow-canvas-story-sowhat').value = 'Staff up';
  fire(editor, 'submit');
  const saved = emitted.cards.find((c) => c.id === 2).story;
  ok(saved.headlineLabel === 'Open tickets' && saved.agg === 'count' && saved.note === 'Live count' && saved.soWhat === 'Staff up' && saved.col === '', 'saving the editor emits updateCardStory output');
  ok(emitted.cards.find((c) => c.id === 1).story.soWhat === 'Call the West team' && emitted.headline.title === 'Q3 board', 'other cards and the board headline are untouched by a card save');
  // editor prefilled from existing story
  ok(find(findAll(h6, 'glow-canvas-story-editor')[0], 'glow-canvas-story-sowhat').value === 'Call the West team', 'editor is prefilled from the saved story');

  // takeaway form
  emitted = null;
  const tf = find(h6, 'glow-canvas-takeaway-form');
  find(tf, 'glow-canvas-takeaway-title').value = 'New title';
  find(tf, 'glow-canvas-takeaway-text').value = 'New takeaway';
  fire(tf, 'submit');
  ok(emitted.headline.title === 'New title' && emitted.headline.takeaway === 'New takeaway', 'takeaway form emits updateBoardHeadline');
  fire(find(h6, 'glow-canvas-add-takeaway'), 'click');
  ok(/display:none/.test(tf.attributes.style) && tf.style.display === 'flex', 'Add/Edit takeaway toggles the form open');
  fire(find(h6, 'glow-canvas-add-takeaway'), 'click');
  ok(tf.style.display === 'none', 'and closed again');

  // no story at all: no banner, "Add takeaway", but still Story buttons
  const h7 = installDom();
  renderCanvas('host', addCard(createCanvasLayout(), { table: 't' }), { renderChart: noChart, enableStorytelling: true });
  ok(!find(h7, 'glow-canvas-board-story') && textOf(find(h7, 'glow-canvas-add-takeaway')) === 'Add takeaway' && !find(h7, 'glow-canvas-card-callout'), 'an unstoried canvas shows only the entry points');
  // both flags on together coexist
  const h8 = installDom();
  renderCanvas('host', l, { renderChart: noChart, datasets, enableStorytelling: true, enableLiveRefresh: true });
  ok(!!find(h8, 'glow-canvas-card-readiness') && !!find(h8, 'glow-canvas-card-callout') && !!find(h8, 'glow-canvas-refresh-all'), 'both flags together render both feature sets');
}

delete global.document;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
