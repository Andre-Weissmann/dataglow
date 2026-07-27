// ============================================================
// DATAGLOW — Question Scout (A49): pure engine
// ============================================================
// Implements A49_QUESTION_SCOUT_SPEC.md's doctrine in a browser-free, model-
// free module: AI PROPOSES, human CHOOSES, engines PROVE, human CONFIRMS.
// This file only ever proposes and scores. It never runs a query, never
// marks anything proven, and never mutates data. Every function here is
// pure — same input, same output, testable from plain Node with no GPU,
// no WebLLM download, and no DOM.
//
// Three jobs, matching the SPEC:
//   1. buildProfileStrip(tables)         — deterministic profile summary
//   2. deterministic keeper filter        — scoreCandidate() / rankCandidates()
//   3. templateCandidatesFromProfile()    — model-free fallback proposals
//
// A fourth job (buildScoutPrompt) exists only to hand the local WebLLM bridge
// (js/narrative/ondevice-llm.js's sibling pattern) a grounded prompt when the
// model IS available; this module never calls the model itself, so it stays
// testable without a browser.
// ============================================================

export const QUESTION_SCOUT_VERSION = 1;

// Cap enforced everywhere the SPEC calls for "10-15 candidates" / "max 5
// keepers", so a caller cannot accidentally blow past the UX contract.
export const MAX_CANDIDATES = 15;
export const MIN_CANDIDATES_TARGET = 10;
export const MAX_KEEPERS = 5;

export const METRIC_TYPES = Object.freeze(['count', 'rate', 'share', 'delta', 'sum', 'avg']);

// The honest banner text the SPEC requires verbatim (product copy, locked).
export const CHEATING_BOUNDARY_BANNER =
  'Scout proposes questions. You pick keepers. Engines prove numbers. That is professional analyst work — same as a senior using a colleague to brainstorm, then checking the warehouse.';

// ------------------------------------------------------------
// 1. Profile strip (deterministic, no LLM required)
// ------------------------------------------------------------
// `tables` accepts either DataGlow's { columns, rows } dataset shape, or an
// already-computed profile shape ({ name, rowCount, columns: [{name,type,
// nullPct, topValues}] }), so this can sit on top of column-profiler-local.js
// output OR a lightweight mock (tests, cold app state before any engine has
// profiled anything).
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeColumn(col, idx) {
  if (col == null) return { name: `col${idx}`, type: 'STR', nullPct: null, topValues: [] };
  if (typeof col === 'string') return { name: col, type: 'STR', nullPct: null, topValues: [] };
  const nullPct = typeof col.nullPct === 'number'
    ? col.nullPct
    : (typeof col.nullRate === 'number' ? Math.round(col.nullRate * 1000) / 10 : null);
  return {
    name: col.name || col.field || `col${idx}`,
    type: col.type || 'STR',
    nullPct,
    cardinality: typeof col.cardinality === 'number' ? col.cardinality : null,
    topValues: Array.isArray(col.topValues) ? col.topValues.slice(0, 5) : [],
    min: col.min ?? null,
    max: col.max ?? null,
  };
}

// Normalize one table-ish input into { name, rowCount, columns[] }.
function normalizeTable(t, idx) {
  if (!isPlainObject(t)) return { name: `table${idx}`, rowCount: null, columns: [] };
  const name = t.name || t.tableName || `table${idx}`;
  const rowCount = typeof t.rowCount === 'number'
    ? t.rowCount
    : (Array.isArray(t.rows) ? t.rows.length : null);
  let columns = [];
  if (Array.isArray(t.columns) && t.columns.length && isPlainObject(t.columns[0]) && (t.columns[0].name || t.columns[0].type)) {
    columns = t.columns.map(normalizeColumn);
  } else if (Array.isArray(t.columns)) {
    columns = t.columns.map(normalizeColumn);
  } else if (Array.isArray(t.profiles)) {
    // column-profiler-local.js's profileAllLocal() output shape.
    columns = t.profiles.map((p, i) => normalizeColumn({
      name: p.name, type: p.type, nullPct: (p.nullRate || 0) * 100,
      cardinality: p.cardinality, topValues: p.topValues, min: p.min, max: p.max,
    }, i));
  }
  return { name, rowCount, columns };
}

/**
 * Build the deterministic profile strip shown at the top of the Scout panel.
 * Never touches an LLM. Safe to call with zero tables (returns an empty
 * strip, not an error) so a cold app state renders instead of throwing.
 */
export function buildProfileStrip(tables) {
  const list = Array.isArray(tables) ? tables : (tables ? [tables] : []);
  const normalized = list.map(normalizeTable);
  const totalColumns = normalized.reduce((sum, t) => sum + t.columns.length, 0);
  const highNullColumns = [];
  const topCategoricalByTable = {};
  const numericColumns = [];
  const idLikeColumns = [];

  for (const t of normalized) {
    for (const c of t.columns) {
      if (typeof c.nullPct === 'number' && c.nullPct >= 10) {
        highNullColumns.push({ table: t.name, column: c.name, nullPct: c.nullPct });
      }
      if (/(_id$|^id$|identifier|key$|uuid|guid)/i.test(c.name)) {
        idLikeColumns.push({ table: t.name, column: c.name });
      }
      if (c.topValues && c.topValues.length && !topCategoricalByTable[t.name]) {
        topCategoricalByTable[t.name] = { column: c.name, topValues: c.topValues };
      }
      if (typeof c.min === 'number' && typeof c.max === 'number') {
        numericColumns.push({ table: t.name, column: c.name, min: c.min, max: c.max });
      }
    }
  }

  return {
    kind: 'dataglow-question-scout-profile-strip',
    version: QUESTION_SCOUT_VERSION,
    tableCount: normalized.length,
    tables: normalized.map(t => ({
      name: t.name,
      rowCount: t.rowCount,
      columnCount: t.columns.length,
      columns: t.columns.map(c => ({ name: c.name, type: c.type, nullPct: c.nullPct })),
    })),
    totalColumns,
    highNullColumns,
    topCategoricalByTable,
    numericColumns,
    idLikeColumns,
    isEmpty: normalized.length === 0 || totalColumns === 0,
  };
}

// ------------------------------------------------------------
// 2. Deterministic keeper filter (must run even if the LLM fails)
// ------------------------------------------------------------
// Score +1 each (per SPEC):
//   - mentions a business actor/decision OR generic ops language
//   - references real column/table names from profile
//   - metric type is count/rate/share/delta/sum/avg
//   - draft SQL is SELECT (not DDL/DML)
// Penalties:
//   - pure viz vanity ("make a pretty chart") without metric
//   - questions that need columns not in profile
//
// Score is then rescaled to 0-100 so the UI can show "keeper score 0-100"
// per the SPEC, while the underlying rule hits stay individually inspectable
// for tests (`scoreCandidate(...).hits`).

const BUSINESS_ACTOR_RE = /(payer|provider|plan|dispute|quality|cost|backlog|win rate|revenue|customer|patient|claim|denial|margin|churn|conversion|sla|utilization|throughput|budget|vendor|supplier|risk|compliance|fraud|readmission)/i;
const GENERIC_OPS_RE = /(count|total|average|trend|growth|rate|share|volume|efficiency|performance|capacity|delay|turnaround|error rate|defect|uptime|downtime)/i;
const VIZ_VANITY_RE = /(pretty|make a chart|nice graph|cool visualization|fancy dashboard|make it colorful)/i;
const DDL_DML_RE = /^\s*(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke)\b/i;
const SELECT_RE = /^\s*(with\b[\s\S]*?)?select\b/i;

function extractIdentifiers(str) {
  if (!str) return [];
  return String(str).match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
}

function knownIdentifiers(profileStrip) {
  const known = new Set();
  if (!profileStrip) return known;
  for (const t of profileStrip.tables || []) {
    known.add(String(t.name).toLowerCase());
    for (const c of t.columns || []) known.add(String(c.name).toLowerCase());
  }
  return known;
}

/**
 * Score one candidate question against the deterministic filter. Returns
 * { score (0-100), hits[], penalties[], metricTypeOk, isSelect } so tests and
 * the UI can both inspect exactly why a candidate ranked where it did.
 *
 * `candidate` shape: { text, why, metricType, sql }
 * `profileStrip` is the output of buildProfileStrip() (used to check real
 * column/table references and to penalize columns that don't exist).
 */
export function scoreCandidate(candidate, profileStrip) {
  const hits = [];
  const penalties = [];
  const text = String((candidate && candidate.text) || '');
  const why = String((candidate && candidate.why) || '');
  const metricType = String((candidate && candidate.metricType) || '').toLowerCase();
  const sql = String((candidate && candidate.sql) || '');
  const known = knownIdentifiers(profileStrip);

  const combinedProse = `${text} ${why}`;
  if (BUSINESS_ACTOR_RE.test(combinedProse) || GENERIC_OPS_RE.test(combinedProse)) {
    hits.push('business_actor_or_ops_language');
  }

  const idsMentioned = new Set([...extractIdentifiers(text), ...extractIdentifiers(sql)].map(s => s.toLowerCase()));
  let referencesRealColumn = false;
  let referencesUnknownColumn = false;
  if (known.size > 0) {
    for (const id of idsMentioned) {
      if (SELECT_RE.test(id) || /^(select|from|where|group|order|by|as|and|or|on|join|left|right|inner|outer|count|sum|avg|min|max|distinct|the|a|an|is|are|of|to|for|in)$/i.test(id)) continue;
      if (known.has(id)) referencesRealColumn = true;
    }
  }
  if (referencesRealColumn) hits.push('references_real_column_or_table');

  const metricTypeOk = METRIC_TYPES.includes(metricType);
  if (metricTypeOk) hits.push('checkable_metric_type');

  const isSelect = SELECT_RE.test(sql) && !DDL_DML_RE.test(sql);
  const hasSql = sql.trim().length > 0;
  if (hasSql && isSelect) hits.push('sql_is_select');
  if (hasSql && !isSelect) penalties.push('sql_is_not_select');

  if (VIZ_VANITY_RE.test(combinedProse) && !metricTypeOk) {
    penalties.push('viz_vanity_without_metric');
  }

  // Needs-columns-not-in-profile penalty: only meaningful once we actually
  // know the profile's identifiers; an empty profile (cold state / mock)
  // never triggers this penalty, since there's nothing to check against.
  if (known.size > 0 && sql.trim()) {
    const sqlIds = extractIdentifiers(sql).map(s => s.toLowerCase());
    const sqlKeyword = /^(select|from|where|group|by|order|as|and|or|on|join|left|right|inner|outer|count|sum|avg|min|max|distinct|having|limit|desc|asc|null|is|not|like|between|case|when|then|else|end)$/i;
    const candidateCols = sqlIds.filter(id => !sqlKeyword.test(id) && !/^\d+$/.test(id));
    if (candidateCols.length > 0 && candidateCols.every(id => !known.has(id))) {
      referencesUnknownColumn = true;
      penalties.push('needs_columns_not_in_profile');
    }
  }

  // Raw rule score: +1 per hit, -1 per penalty, floor at 0.
  const raw = Math.max(0, hits.length - penalties.length);
  const maxRaw = 4; // four possible +1 hits per the SPEC
  const score = Math.round((raw / maxRaw) * 100);

  return {
    score,
    hits,
    penalties,
    metricTypeOk,
    isSelect: hasSql ? isSelect : null,
    referencesRealColumn,
    referencesUnknownColumn,
  };
}

/**
 * Rank a list of candidates by deterministic score (desc), stable tie-break
 * by original index so output is reproducible. Attaches `.score`/`.scoreDetail`
 * to each returned candidate without mutating the input array's objects.
 */
export function rankCandidates(candidates, profileStrip) {
  const list = Array.isArray(candidates) ? candidates : [];
  const scored = list.map((c, i) => {
    const detail = scoreCandidate(c, profileStrip);
    return { ...c, score: detail.score, scoreDetail: detail, _origIndex: i };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a._origIndex - b._origIndex;
  });
  return scored.map(({ _origIndex, ...rest }) => rest);
}

// ------------------------------------------------------------
// 3. Deterministic fallback templates (no model required)
// ------------------------------------------------------------
// SPEC: COUNT(*) grain check; null rate on each high-null column; top-N
// frequency on top categorical column; min/max/avg on first numeric column;
// distinct count on id-like column. Every one is labeled "template (no
// model)" so the honesty rule holds even when nothing generative ran.

function quoteIdent(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name : `"${String(name).replace(/"/g, '""')}"`;
}

export function templateCandidatesFromProfile(profileStrip) {
  const out = [];
  const strip = profileStrip || buildProfileStrip([]);
  if (strip.isEmpty) return out;

  for (const t of strip.tables) {
    const table = quoteIdent(t.name);

    // 1. Grain check.
    out.push({
      id: `tmpl_grain_${t.name}`,
      text: `How many rows are in ${t.name}, and is that the expected grain?`,
      why: 'Grain checks are the first thing a business owner should confirm before trusting any other number.',
      metricType: 'count',
      sql: `SELECT COUNT(*) AS row_count FROM ${table};`,
      source: 'template',
      modelUsed: false,
    });

    // 2. Null rate on each high-null column (scoped to this table).
    for (const hn of strip.highNullColumns.filter(h => h.table === t.name)) {
      out.push({
        id: `tmpl_nullrate_${t.name}_${hn.column}`,
        text: `What share of ${hn.column} in ${t.name} is missing, and does that affect downstream decisions?`,
        why: 'High null rates on a decision-relevant column are a data-quality risk before they are anything else.',
        metricType: 'rate',
        sql: `SELECT SUM(CASE WHEN ${quoteIdent(hn.column)} IS NULL THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS null_rate FROM ${table};`,
        source: 'template',
        modelUsed: false,
      });
    }

    // 3. Top-N frequency on the top categorical column.
    const topCat = strip.topCategoricalByTable[t.name];
    if (topCat) {
      out.push({
        id: `tmpl_topn_${t.name}_${topCat.column}`,
        text: `What are the most common values of ${topCat.column} in ${t.name}, and does that distribution match business expectations?`,
        why: 'Category concentration often reveals where volume or risk is concentrated for the business owner.',
        metricType: 'share',
        sql: `SELECT ${quoteIdent(topCat.column)}, COUNT(*) AS n FROM ${table} GROUP BY ${quoteIdent(topCat.column)} ORDER BY n DESC LIMIT 10;`,
        source: 'template',
        modelUsed: false,
      });
    }

    // 4. Min/max/avg on the first numeric column.
    const firstNumeric = strip.numericColumns.find(n => n.table === t.name);
    if (firstNumeric) {
      out.push({
        id: `tmpl_minmaxavg_${t.name}_${firstNumeric.column}`,
        text: `What is the range and average of ${firstNumeric.column} in ${t.name}?`,
        why: 'Range/average is the cheapest sanity check on a numeric column before it enters any report.',
        metricType: 'avg',
        sql: `SELECT MIN(${quoteIdent(firstNumeric.column)}) AS min_v, MAX(${quoteIdent(firstNumeric.column)}) AS max_v, AVG(${quoteIdent(firstNumeric.column)}) AS avg_v FROM ${table};`,
        source: 'template',
        modelUsed: false,
      });
    }

    // 5. Distinct count on an id-like column.
    const idCol = strip.idLikeColumns.find(i => i.table === t.name);
    if (idCol) {
      out.push({
        id: `tmpl_distinct_${t.name}_${idCol.column}`,
        text: `How many distinct ${idCol.column} values are in ${t.name}, and does that match the expected entity count?`,
        why: 'A distinct-count mismatch against the expected entity count is often the first sign of a join or dedup problem.',
        metricType: 'count',
        sql: `SELECT COUNT(DISTINCT ${quoteIdent(idCol.column)}) AS distinct_n FROM ${table};`,
        source: 'template',
        modelUsed: false,
      });
    }
  }

  return out.slice(0, MAX_CANDIDATES);
}

// ------------------------------------------------------------
// 4. Prompt construction for the local WebLLM bridge (browser-free, pure)
// ------------------------------------------------------------
// This module never loads or calls the model. It only builds the prompt so
// a caller (canvas UI module) can hand it to the existing local AI bridge
// (js/narrative/ondevice-llm.js pattern: loadModel()/engine.chat.completions)
// when that model is warm. Kept here so the prompt text itself is unit-
// testable without any browser/WebGPU dependency.

const SCOUT_SYSTEM_PROMPT = [
  'You are DATAGLOW\'s Question Scout, an on-device analyst assistant that runs entirely in the user\'s browser.',
  'You PROPOSE candidate analysis questions from a data profile. You never claim a number is true — engines prove numbers, not you.',
  'Every question must be answerable from the columns/tables listed in the profile, must name a business owner or decision it serves',
  '(payer, provider, plan, cost, quality, backlog, win rate, or the equivalent operational language for non-healthcare data),',
  'and must map to a checkable metric type: count, rate, share, delta, sum, or avg.',
  'For each question, also propose a short SELECT-only draft SQL statement (never INSERT/UPDATE/DELETE/DROP/ALTER).',
  'Never propose a purely cosmetic/visualization request with no metric behind it. Output structured candidates only, no prose commentary.',
].join(' ');

/**
 * Build the { system, user, messages } prompt for the local model to propose
 * candidates from a profile strip. Pure/deterministic string construction —
 * no network, no model call. Caller passes `messages` to the bridge's
 * chat.completions.create() exactly like ondevice-llm.js's other prompts do.
 */
export function buildScoutPrompt(profileStrip) {
  const strip = profileStrip || buildProfileStrip([]);
  const lines = [];
  lines.push('## Data profile (this is ALL the data you may reference — never invent a column or table not listed here)');
  for (const t of strip.tables) {
    lines.push(`- Table ${t.name} (${t.rowCount == null ? 'row count unknown' : `${t.rowCount} rows`}):`);
    for (const c of t.columns) {
      const nullNote = typeof c.nullPct === 'number' ? `, ${c.nullPct}% null` : '';
      lines.push(`  - ${c.name} (${c.type}${nullNote})`);
    }
  }
  lines.push('');
  lines.push('## Task');
  lines.push(`Propose ${MIN_CANDIDATES_TARGET}-${MAX_CANDIDATES} candidate analysis questions as a JSON array. Each item: {"text","why","metricType","sql"}.`);
  lines.push('metricType must be one of: count, rate, share, delta, sum, avg. sql must be a SELECT-only statement using only the columns/tables above.');

  const user = lines.join('\n');
  return {
    system: SCOUT_SYSTEM_PROMPT,
    user,
    messages: [
      { role: 'system', content: SCOUT_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
  };
}

/**
 * Parse a model's raw text response into candidate objects. Tolerant of a
 * fenced ```json block or bare JSON array; never throws — returns [] on any
 * parse failure so a malformed/truncated generation degrades to "no model
 * candidates" rather than crashing the panel (the deterministic templates
 * still cover the user in that case).
 */
export function parseModelCandidates(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return [];
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced ? fenced[1] : rawText;
  const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
  const candidate = arrayMatch ? arrayMatch[0] : jsonText;
  try {
    const parsed = JSON.parse(candidate);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isPlainObject)
      .map((c, i) => ({
        id: `model_${i}_${hashText(String(c.text || i))}`,
        text: String(c.text || '').trim(),
        why: String(c.why || '').trim(),
        metricType: String(c.metricType || '').trim().toLowerCase(),
        sql: String(c.sql || '').trim(),
        source: 'model',
        modelUsed: true,
      }))
      .filter(c => c.text.length > 0)
      .slice(0, MAX_CANDIDATES);
  } catch (_e) {
    return [];
  }
}

function hashText(str) {
  let h = 5381;
  const s = String(str);
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36).padStart(6, '0');
}

// ------------------------------------------------------------
// 5. Send-to-Prove prefill (statement + claim label only — never proves)
// ------------------------------------------------------------
// Turns a kept candidate into the exact shape the Proof Harness Prove tab's
// two editable fields expect: `claimText` (#dg-ph-claim) and `statement`
// (#dg-ph-statement). This function does not run SQL, does not open any
// panel, and does not mark anything proven — it only maps fields 1:1 so the
// human still edits/confirms in the Prove tab before anything runs there.
export function buildProvePrefill(keeper) {
  if (!isPlainObject(keeper)) return null;
  const claimText = String(keeper.text || '').trim();
  const statement = String(keeper.sql || '').trim().replace(/;\s*$/, '');
  return {
    kind: 'dataglow-question-scout-prove-prefill',
    version: QUESTION_SCOUT_VERSION,
    claimText,
    statement,
    sourceCandidateId: keeper.id || null,
    metricType: keeper.metricType || null,
  };
}

// ------------------------------------------------------------
// 6. Browse-mode grounding (free-ask chat, profile-only, no raw dump)
// ------------------------------------------------------------
// Builds a compact, profile-only grounding string for the "Browse mode" free
// -ask chat the SPEC calls for. Never includes raw row data (even if present
// on the input) — only the same profile-strip summary shown in the panel, so
// a huge table never gets dumped into a prompt. Any answer asserting a
// number must be flagged unverified by the caller (see ANSWER_UNVERIFIED_NOTE).
export const ANSWER_UNVERIFIED_NOTE = 'unverified — run Prove';

export function buildBrowseGrounding(profileStrip) {
  const strip = profileStrip || buildProfileStrip([]);
  const lines = [];
  lines.push('Profile summary (no raw rows included):');
  for (const t of strip.tables) {
    lines.push(`- ${t.name}: ${t.columnCount} columns${t.rowCount != null ? `, ${t.rowCount} rows` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Post-process a browse-mode answer so any sentence that asserts a number is
 * honestly flagged. Pure string heuristic: pure digits with no accompanying
 * unverified/prove marker get the note appended. Deliberately conservative
 * (over-flagging is safe; silently asserting a number is not).
 */
export function annotateUnverifiedNumbers(answerText) {
  const text = String(answerText || '');
  if (!text.trim()) return text;
  const hasNumber = /\d/.test(text);
  const alreadyFlagged = new RegExp(ANSWER_UNVERIFIED_NOTE, 'i').test(text);
  if (hasNumber && !alreadyFlagged) {
    return `${text.trim()} (${ANSWER_UNVERIFIED_NOTE})`;
  }
  return text;
}

// ------------------------------------------------------------
// 7. Keepers tray (max 5, per SPEC)
// ------------------------------------------------------------
export function addKeeper(keepers, candidate) {
  const list = Array.isArray(keepers) ? keepers.slice() : [];
  if (!candidate || !candidate.id) return list;
  if (list.some(k => k.id === candidate.id)) return list; // no dup
  if (list.length >= MAX_KEEPERS) return list; // tray full, human must remove one first
  list.push(candidate);
  return list;
}

export function removeKeeper(keepers, candidateId) {
  const list = Array.isArray(keepers) ? keepers.slice() : [];
  return list.filter(k => k.id !== candidateId);
}

// ------------------------------------------------------------
// Public namespace export (mirrors js/ai/local-ai-status.js's window.* pattern)
// ------------------------------------------------------------
export const DataGlowQuestionScout = {
  QUESTION_SCOUT_VERSION,
  MAX_CANDIDATES,
  MIN_CANDIDATES_TARGET,
  MAX_KEEPERS,
  METRIC_TYPES,
  CHEATING_BOUNDARY_BANNER,
  ANSWER_UNVERIFIED_NOTE,
  buildProfileStrip,
  scoreCandidate,
  rankCandidates,
  templateCandidatesFromProfile,
  buildScoutPrompt,
  parseModelCandidates,
  buildProvePrefill,
  buildBrowseGrounding,
  annotateUnverifiedNumbers,
  addKeeper,
  removeKeeper,
};

try {
  if (typeof window !== 'undefined') window.DataGlowQuestionScout = DataGlowQuestionScout;
} catch (_e) {}
