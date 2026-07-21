// ============================================================
// DATAGLOW — NL Engine (PR AH) — test/nl-engine.test.mjs
// ============================================================
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const ctx = {};
createContext(ctx);
const src = readFileSync('./js/nl/nl-engine.js', 'utf8').replace(/^export\s+/gm, '');
runInContext(src, ctx);
const NL = ctx.NLEngine;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.error(`✗ FAILED: ${msg}`); }
}

// Sample dataset — healthcare-style
const DS = {
  name: 'claims.csv', format: 'csv',
  columns: ['region', 'denial_rate', 'claim_count', 'status', 'amount'],
  rows: [
    { region: 'North', denial_rate: 0.15, claim_count: 200, status: 'approved', amount: 1200 },
    { region: 'South', denial_rate: 0.32, claim_count: 150, status: 'denied',   amount: 800  },
    { region: 'East',  denial_rate: 0.08, claim_count: 300, status: 'approved', amount: 1500 },
    { region: 'West',  denial_rate: 0.24, claim_count: 180, status: 'pending',  amount: 950  },
    { region: 'North', denial_rate: 0.18, claim_count: 220, status: 'approved', amount: 1100 },
    { region: 'South', denial_rate: 0.40, claim_count: 90,  status: 'denied',   amount: 600  },
    { region: 'East',  denial_rate: 0.05, claim_count: 350, status: 'approved', amount: 2000 },
    { region: null,    denial_rate: null,  claim_count: 10,  status: '',         amount: 100  },
  ]
};

const EMPTY_DS = { name: 'empty.csv', format: 'csv', columns: ['a', 'b'], rows: [] };

// ── API surface ───────────────────────────────────────────────────────────
ok(typeof NL.ask === 'function', 'NLEngine.ask is a function');
ok(typeof NL.getSuggestions === 'function', 'NLEngine.getSuggestions is a function');

// ── No data ───────────────────────────────────────────────────────────────
const noData = await NL.ask('which region has highest denial rate?', null);
ok(noData.type === 'nodata', 'null dataset returns nodata type');

// ── Empty question ────────────────────────────────────────────────────────
const empty = await NL.ask('', DS);
ok(empty.type === 'empty', 'empty question returns empty type');

// ── Highest ───────────────────────────────────────────────────────────────
const top = await NL.ask('which region has the highest denial rate?', DS);
ok(top.answer && top.answer.length > 0, 'highest: returns an answer');
ok(top.answer.toLowerCase().includes('south'), 'highest denial_rate: South is highest');
ok(typeof top.sql === 'string' && top.sql.length > 0, 'highest: sql present');
ok(top.confidence > 0.5, 'highest: confidence > 0.5');

// ── Lowest ───────────────────────────────────────────────────────────────
const bot = await NL.ask('which region has the lowest denial rate?', DS);
ok(bot.answer.toLowerCase().includes('east'), 'lowest denial_rate: East is lowest');

// ── Count ────────────────────────────────────────────────────────────────
const count = await NL.ask('how many rows are there?', DS);
ok(count.answer.includes('8'), 'count: total row count = 8');

// ── Count by group ────────────────────────────────────────────────────────
const countGroup = await NL.ask('how many records by status?', DS);
ok(countGroup.answer && countGroup.answer.toLowerCase().includes('status'), 'count by group: mentions status');

// ── Sum ───────────────────────────────────────────────────────────────────
const sum = await NL.ask('what is the total amount?', DS);
ok(sum.answer && sum.answer.length > 0, 'sum: returns answer');
ok(sum.answer.includes('8.3K') || sum.answer.includes('8.25K') || sum.answer.includes('8,250') || sum.answer.includes('8250'), 'sum: total amount is 8250 (8.3K formatted)');

// ── Average ───────────────────────────────────────────────────────────────
const avg = await NL.ask('what is the average claim count?', DS);
ok(avg.answer && avg.answer.length > 0, 'avg: returns answer');
ok(avg.type === 'avg', 'avg: type = avg');

// ── Distribution ─────────────────────────────────────────────────────────
const dist = await NL.ask('show me the distribution of status?', DS);
ok(dist.answer && dist.answer.toLowerCase().includes('status'), 'distribution: mentions status');
ok(dist.type === 'distribution', 'distribution: type = distribution');

// ── Unique ────────────────────────────────────────────────────────────────
const uniq = await NL.ask('how many unique values are in region?', DS);
ok(uniq.answer && uniq.answer.length > 0, 'unique: returns answer');
ok(uniq.answer.includes('5') || uniq.answer.includes('4'), 'unique: 4-5 unique region values (null coerced to (blank))');

// ── Missing ──────────────────────────────────────────────────────────────
const miss = await NL.ask('are there any missing values?', DS);
ok(miss.answer && miss.answer.length > 0, 'missing: returns answer');
ok(miss.type === 'missing', 'missing: type = missing');

// ── Rowcount directly ────────────────────────────────────────────────────
const rc = await NL.ask('how many records are in this dataset?', DS);
ok(rc.answer.includes('8'), 'rowcount: 8 rows');

// ── Suggestions ──────────────────────────────────────────────────────────
const sug = NL.getSuggestions(DS);
ok(Array.isArray(sug), 'getSuggestions returns array');
ok(sug.length === 4, 'getSuggestions returns 4 suggestions');
ok(sug.every(function (s) { return typeof s === 'string' && s.length > 0; }), 'all suggestions are non-empty strings');

// ── Suggestions for empty dataset ────────────────────────────────────────
const sugEmpty = NL.getSuggestions(null);
ok(Array.isArray(sugEmpty) && sugEmpty.length === 4, 'getSuggestions(null) returns 4 fallback suggestions');

// ── Unclear question still returns an answer ──────────────────────────────
const unclear = await NL.ask('what do you think about my data?', DS);
ok(unclear.answer && unclear.answer.length > 0, 'unclear question: still returns a non-empty answer');

console.log(`\n${passed + failed} assertions — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
