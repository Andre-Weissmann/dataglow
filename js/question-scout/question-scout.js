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

// SCOUT_V2_VERSION: A49.2 (SCOUT V2) extension marker per
// A49_2_SCOUT_V2_SPEC.md. QUESTION_SCOUT_VERSION itself stays 1 -- the A49
// v1 test suite asserts that constant verbatim, and the SPEC's acceptance
// #6 requires "CI green path same as A49", so v1's contract (including this
// constant) must not change. All v2 additions below are new exported
// functions/constants only; nothing in the v1 surface above this line was
// modified except where explicitly called out (scoreCandidate's anti-vanity
// hardening, kept backward compatible -- see note at that function).
// New v2 surface, in SPEC order:
//   1. Dictionary-aware prompts   -> parseDictionary(), buildScoutPrompt(strip, opts)
//   2. Join hints (multi-table)   -> buildJoinHints()
//   3. Anti-vanity v2             -> scoreCandidate() hardened in place
//   4. healthcare-idr domain pack -> HEALTHCARE_IDR_PACK, idrPackCandidates()
//   5. Browse UNVERIFIED tag      -> annotateUnverifiedNumbers() hardened,
//                                    UNVERIFIED_TAG for the browse-tag UI
//   6. Keeper quality meter       -> keeperQualityMeter()
//   7. Export keepers JSON        -> exportKeepersJson()
export const SCOUT_V2_VERSION = 2;

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
// 1b. Join hints (A49.2 SCOUT_V2_SPEC #2, multi-table)
// ------------------------------------------------------------
// When 2+ tables are present in the profile, propose join-key candidates by
// name similarity (id, *_id, code) so both the model prompt and the deter-
// ministic templates can propose questions that actually need a join.
// Deterministic, no LLM. Returns [] for 0 or 1 table (nothing to join).

const JOIN_KEY_RE = /(_id$|^id$|identifier|_key$|^key$|_code$|^code$|uuid|guid)/i;

// Normalizes a column name into a "join stem" so e.g. `provider_id` (table A)
// and `id` on a table literally named `provider` (table B), or `providerid`
// vs `provider_id`, are recognized as the same join concept.
function joinStem(colName, tableName) {
  let s = String(colName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  s = s.replace(/^id$/, String(tableName || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  s = s.replace(/id$/, '').replace(/key$/, '').replace(/code$/, '');
  return s;
}

/**
 * Build join-hint candidates across all table pairs in a profile strip.
 * Returns an array of
 *   { tableA, columnA, tableB, columnB, stem, confidence: 'high'|'medium' }
 * sorted by confidence (high first) then table/column name for a stable,
 * reproducible order. `confidence` is 'high' when both column names match
 * exactly (case-insensitive) or share a non-empty stem after normalizing
 * `_id`/`id`/`_key`/`_code` suffixes/prefixes; 'medium' when only the
 * stem matches loosely (e.g. one side is a bare `id`).
 */
export function buildJoinHints(profileStrip) {
  const strip = profileStrip || buildProfileStrip([]);
  const tables = strip.tables || [];
  const hints = [];
  if (tables.length < 2) return hints;

  const idLikeByTable = tables.map(t => ({
    table: t.name,
    cols: (t.columns || []).filter(c => JOIN_KEY_RE.test(c.name)),
  }));

  for (let i = 0; i < idLikeByTable.length; i++) {
    for (let j = i + 1; j < idLikeByTable.length; j++) {
      const a = idLikeByTable[i];
      const b = idLikeByTable[j];
      for (const ca of a.cols) {
        for (const cb of b.cols) {
          const nameExact = String(ca.name).toLowerCase() === String(cb.name).toLowerCase();
          const stemA = joinStem(ca.name, a.table);
          const stemB = joinStem(cb.name, b.table);
          const stemMatch = !!stemA && !!stemB && stemA === stemB;
          if (!nameExact && !stemMatch) continue;
          hints.push({
            tableA: a.table,
            columnA: ca.name,
            tableB: b.table,
            columnB: cb.name,
            stem: stemA || stemB,
            confidence: nameExact ? 'high' : (stemMatch ? 'high' : 'medium'),
          });
        }
      }
    }
  }

  hints.sort((x, y) => {
    if (x.confidence !== y.confidence) return x.confidence === 'high' ? -1 : 1;
    const ta = x.tableA.localeCompare(y.tableA);
    if (ta !== 0) return ta;
    return x.columnA.localeCompare(y.columnA);
  });
  return hints;
}

/**
 * Turn join hints into candidate questions that explicitly require the join
 * (so scoreCandidate's real-column check sees identifiers from BOTH tables).
 * Model-free, deterministic; labeled source: 'join-template' so the UI/tests
 * can tell these apart from the five single-table templates.
 */
export function joinCandidatesFromHints(hints, profileStrip) {
  const list = Array.isArray(hints) ? hints : buildJoinHints(profileStrip);
  return list.map(h => {
    const qa = quoteIdent(h.tableA);
    const qb = quoteIdent(h.tableB);
    const qca = quoteIdent(h.columnA);
    const qcb = quoteIdent(h.columnB);
    return {
      id: `tmpl_join_${h.tableA}_${h.columnA}__${h.tableB}_${h.columnB}`,
      text: `How many ${h.tableA} rows have a matching ${h.tableB} row via ${h.columnA} = ${h.columnB}, and how many do not (join coverage)?`,
      why: 'Join coverage/orphan-row counts are a business-critical check before any cross-table metric (e.g. revenue by provider) can be trusted.',
      metricType: 'count',
      sql: `SELECT COUNT(*) AS matched, (SELECT COUNT(*) FROM ${qa} WHERE ${qca} NOT IN (SELECT ${qcb} FROM ${qb})) AS unmatched_${h.tableA} FROM ${qa} JOIN ${qb} ON ${qa}.${qca} = ${qb}.${qcb};`,
      source: 'join-template',
      modelUsed: false,
      joinHint: h,
    };
  });
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
const VIZ_VANITY_RE = /(pretty|make a chart|nice graph|cool visualization|fancy dashboard|make it colorful|make it look|just for looks|looks cool|good for a screenshot|interesting visualization|interesting chart)/i;
const DDL_DML_RE = /^\s*(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke)\b/i;
const SELECT_RE = /^\s*(with\b[\s\S]*?)?select\b/i;

// ---- Anti-vanity v2 (A49.2 SCOUT_V2_SPEC #3) -------------------------------
// v1 only penalized a short list of "pretty/cool" phrases. v2 widens the net
// ("interesting" used as the ONLY justification, with no metric behind it,
// is just as much vanity as "make it pretty") and adds a positive boost for
// the specific checkable-language the SPEC calls out by name: count, rate,
// share, delta, win rate, backlog. Both additions are purely additive to the
// v1 hits/penalties arrays (new hit/penalty ids only), so v1's own assertions
// (which check score ORDERING and specific existing ids, never an exact raw
// score) keep passing unchanged.
const VAGUE_INTEREST_RE = /\b(interesting|neat|nifty|cool)\b/i;
const STRONG_CHECKABLE_LANGUAGE_RE = /(count|rate|share|delta|win rate|backlog)/i;

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

  // Anti-vanity v2: "interesting"/"cool"/"neat" used as the ONLY stated
  // reason, with no checkable metric type behind it, is vanity language
  // wearing a different hat. This is a SEPARATE (stronger) penalty id from
  // v1's viz_vanity_without_metric so it stacks when both are present, and
  // fires standalone for text like "that would be an interesting chart"
  // that v1's narrower VIZ_VANITY_RE never caught.
  if (VAGUE_INTEREST_RE.test(combinedProse) && !metricTypeOk) {
    penalties.push('vague_interest_without_metric');
  }

  // Anti-vanity v2 boost: the SPEC names count/rate/share/delta/win-rate/
  // backlog language explicitly as what should rank ABOVE vanity. This is
  // additive to (not a replacement for) checkable_metric_type, so a
  // candidate that both declares metricType AND uses this language in its
  // own prose scores strictly higher than one that only sets metricType.
  if (STRONG_CHECKABLE_LANGUAGE_RE.test(combinedProse)) {
    hits.push('strong_checkable_language');
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

  // Raw rule score: +1 per hit, -1 per penalty (vanity penalties count
  // double under anti-vanity v2, so a vanity candidate can't coast to a
  // mid-pack score just by also having a plausible-looking SQL string),
  // floor at 0. maxRaw widened from 4 to 5 to fit the new
  // strong_checkable_language hit while keeping the same 0-100 scale.
  const vanityPenaltyCount =
    (penalties.includes('viz_vanity_without_metric') ? 1 : 0) +
    (penalties.includes('vague_interest_without_metric') ? 1 : 0);
  const otherPenaltyCount = penalties.length - vanityPenaltyCount;
  const raw = Math.max(0, hits.length - otherPenaltyCount - (vanityPenaltyCount * 2));
  const maxRaw = 5; // four v1 hits + strong_checkable_language
  const score = Math.max(0, Math.min(100, Math.round((raw / maxRaw) * 100)));

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
// 3b. healthcare-idr domain pack (A49.2 SCOUT_V2_SPEC #4)
// ------------------------------------------------------------
// A named, opt-in template pack for healthcare Independent Dispute
// Resolution (IDR)-shaped public data (the No Surprises Act IDR determinations
// datasets and similar payer/provider dispute tables). Per SPEC: "only emits
// questions when columns fuzzy-match" -- every template below is guarded by
// a fuzzy column-name match against the profile, so a non-healthcare/non-IDR
// dataset silently gets zero pack candidates instead of nonsense questions
// about columns that do not exist. Deterministic, no LLM, no network.

export const HEALTHCARE_IDR_PACK_ID = 'healthcare-idr';

// Each entry: { need: [regex,...] } fuzzy-matched (case-insensitive, substring
// on the *snake/space-insensitive* column name) against every column in a
// table; the entry only fires for a table where ALL its `need` patterns match
// at least one column in that table.
const IDR_COLUMN_PATTERNS = {
  disputeId: /(dispute.*id|case.*id|idr.*id)/i,
  payer: /(payer|health.*plan|plan.*name|issuer)/i,
  provider: /(provider|practitioner|facility|physician)/i,
  specialty: /(specialty|service.*type|qpa.*service|practice.*type)/i,
  status: /(status|outcome|determination|decision)/i,
  amount: /(offer.*amount|billed.*amount|qpa|payment.*amount|award.*amount)/i,
  date: /(date|_dt$|determination.*date|initiation.*date)/i,
  quarter: /(quarter|qtr|period)/i,
  prevailingParty: /(prevail|winner|initiating.*party|non.*initiating)/i,
};

function findColumnByPattern(table, re) {
  return (table.columns || []).find(c => re.test(String(c.name || '')));
}

function idrColumnsForTable(table) {
  const found = {};
  for (const key of Object.keys(IDR_COLUMN_PATTERNS)) {
    const col = findColumnByPattern(table, IDR_COLUMN_PATTERNS[key]);
    if (col) found[key] = col.name;
  }
  return found;
}

/**
 * Build the healthcare-idr domain pack's candidate questions for a profile
 * strip. Fuzzy-matches column names per table; a table that does not look
 * IDR-shaped (missing the minimum column set) contributes zero candidates,
 * so this pack is silent (not wrong) on non-healthcare data. Returns
 * candidates tagged `domainPack: 'healthcare-idr'` and `source: 'domain-pack'`
 * so the UI/tests can show provenance distinct from the generic templates.
 */
export function idrPackCandidates(profileStrip) {
  const strip = profileStrip || buildProfileStrip([]);
  const out = [];
  if (strip.isEmpty) return out;

  for (const t of strip.tables) {
    const cols = idrColumnsForTable(t);
    const table = quoteIdent(t.name);
    // Minimum bar: needs at least a dispute id AND (payer or provider) AND
    // (status or amount) to be worth proposing anything -- otherwise this is
    // very likely not an IDR-shaped table and the pack stays silent.
    const hasCore = cols.disputeId && (cols.payer || cols.provider) && (cols.status || cols.amount);
    if (!hasCore) continue;

    // 1. Dispute volume (grain + count).
    out.push({
      id: `idr_volume_${t.name}`,
      text: `How many disputes are in ${t.name} (${cols.disputeId}), and what is the dispute volume trend?`,
      why: 'Dispute volume is the headline operational metric a payer/provider ops lead checks first.',
      metricType: 'count',
      sql: `SELECT COUNT(DISTINCT ${quoteIdent(cols.disputeId)}) AS dispute_count FROM ${table};`,
      source: 'domain-pack',
      domainPack: HEALTHCARE_IDR_PACK_ID,
      modelUsed: false,
    });

    // 2. Closure/outcome mix.
    if (cols.status) {
      out.push({
        id: `idr_closuremix_${t.name}`,
        text: `What is the closure/outcome mix (${cols.status}) across disputes in ${t.name}?`,
        why: 'Closure mix (e.g. settled vs. IDR-decided vs. withdrawn) tells ops where the backlog risk sits.',
        metricType: 'share',
        sql: `SELECT ${quoteIdent(cols.status)}, COUNT(*) AS n FROM ${table} GROUP BY ${quoteIdent(cols.status)} ORDER BY n DESC;`,
        source: 'domain-pack',
        domainPack: HEALTHCARE_IDR_PACK_ID,
        modelUsed: false,
      });
    }

    // 3. Specialty concentration.
    if (cols.specialty) {
      out.push({
        id: `idr_specialtyconc_${t.name}`,
        text: `Which specialties (${cols.specialty}) concentrate the most disputes in ${t.name}?`,
        why: 'Specialty concentration flags where payer-provider contract disputes are most costly to resolve.',
        metricType: 'share',
        sql: `SELECT ${quoteIdent(cols.specialty)}, COUNT(*) AS n FROM ${table} GROUP BY ${quoteIdent(cols.specialty)} ORDER BY n DESC LIMIT 10;`,
        source: 'domain-pack',
        domainPack: HEALTHCARE_IDR_PACK_ID,
        modelUsed: false,
      });
    }

    // 4. Win rate (prevailing party), when the column exists.
    if (cols.prevailingParty) {
      out.push({
        id: `idr_winrate_${t.name}`,
        text: `What is the win rate (${cols.prevailingParty}) for payers vs. providers in ${t.name}?`,
        why: 'Win rate by party is the single most quoted IDR metric in payer/provider negotiations.',
        metricType: 'rate',
        sql: `SELECT ${quoteIdent(cols.prevailingParty)}, COUNT(*) * 1.0 / SUM(COUNT(*)) OVER () AS win_rate FROM ${table} GROUP BY ${quoteIdent(cols.prevailingParty)};`,
        source: 'domain-pack',
        domainPack: HEALTHCARE_IDR_PACK_ID,
        modelUsed: false,
      });
    }

    // 5. QoQ delta, when a date/quarter column exists.
    const timeCol = cols.quarter || cols.date;
    if (timeCol) {
      out.push({
        id: `idr_qoqdelta_${t.name}`,
        text: `What is the quarter-over-quarter (QoQ) delta in dispute volume in ${t.name}, based on ${timeCol}?`,
        why: 'QoQ delta is what turns a static dispute count into a trend an ops leader can act on.',
        metricType: 'delta',
        sql: `SELECT ${quoteIdent(timeCol)}, COUNT(*) AS n FROM ${table} GROUP BY ${quoteIdent(timeCol)} ORDER BY ${quoteIdent(timeCol)};`,
        source: 'domain-pack',
        domainPack: HEALTHCARE_IDR_PACK_ID,
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

// ---- Dictionary-aware prompts (A49.2 SCOUT_V2_SPEC #1) ---------------------
// If the user pastes/loads a column dictionary (JSON, CSV, or free text),
// Scout should ground proposals in the real field definitions instead of
// guessing meaning purely from a column name. parseDictionary() is a small,
// tolerant, format-sniffing parser: it never throws, and degrades to an
// empty map ("no dictionary") on anything it cannot confidently parse, so a
// malformed paste never blocks Propose.

/**
 * Parse a pasted/loaded data dictionary into a flat map of
 * { columnName: definitionText }. Accepts three shapes:
 *   1. JSON: either `{ "col": "definition", ... }` or an array of
 *      `{name|column|field, description|definition|meaning}` objects.
 *   2. CSV: two columns, header row optional; first column = name, second
 *      (or last) = definition. Delimiter-tolerant (comma or tab).
 *   3. Free text: lines shaped `column - definition`, `column: definition`,
 *      or `column = definition`.
 * Never throws. Returns {} for empty/unparseable input.
 */
export function parseDictionary(raw) {
  const text = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
  const out = {};
  if (!text.trim()) return out;

  // 1. JSON.
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isPlainObject(parsed)) {
        for (const k of Object.keys(parsed)) {
          if (typeof parsed[k] === 'string' && parsed[k].trim()) out[k] = parsed[k].trim();
        }
        return out;
      }
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (!isPlainObject(row)) continue;
          const name = row.name || row.column || row.field || row.col;
          const def = row.description || row.definition || row.meaning || row.desc;
          if (name && def) out[String(name).trim()] = String(def).trim();
        }
        return out;
      }
    } catch (_e) { /* fall through to CSV/text parsing below */ }
  }

  // 2/3. Line-oriented: CSV (comma/tab) or `name - def` / `name: def` / `name = def`.
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    let m = line.match(/^([^,\t]+)[,\t]\s*(.+)$/);
    if (!m) m = line.match(/^([A-Za-z_][\w]*)\s*[-:=]\s*(.+)$/);
    if (!m) continue;
    const name = m[1].trim().replace(/^"|"$/g, '');
    const def = m[2].trim().replace(/^"|"$/g, '');
    // Skip an obvious CSV header row ("column,description" naming itself).
    if (/^(column|name|field|col)$/i.test(name) && /^(description|definition|meaning|desc)$/i.test(def)) continue;
    if (name && def) out[name] = def;
  }
  return out;
}

/**
 * Build the { system, user, messages } prompt for the local model to propose
 * candidates from a profile strip. Pure/deterministic string construction —
 * no network, no model call. Caller passes `messages` to the bridge's
 * chat.completions.create() exactly like ondevice-llm.js's other prompts do.
 *
 * `opts.dictionary` (A49.2): either a pre-parsed { columnName: definition }
 * map, or a raw dictionary string (run through parseDictionary() here). When
 * present, definitions for any column that appears in the profile are
 * appended as a grounding section so proposals reflect real field meaning
 * instead of a guess from the column name alone. Absent/empty dictionary is
 * a fully backward-compatible no-op -- the prompt is byte-identical to v1's
 * output in that case.
 */
export function buildScoutPrompt(profileStrip, opts) {
  const strip = profileStrip || buildProfileStrip([]);
  const options = isPlainObject(opts) ? opts : {};
  const dictionary = isPlainObject(options.dictionary)
    ? options.dictionary
    : (typeof options.dictionary === 'string' ? parseDictionary(options.dictionary) : {});

  const lines = [];
  lines.push('## Data profile (this is ALL the data you may reference — never invent a column or table not listed here)');
  for (const t of strip.tables) {
    lines.push(`- Table ${t.name} (${t.rowCount == null ? 'row count unknown' : `${t.rowCount} rows`}):`);
    for (const c of t.columns) {
      const nullNote = typeof c.nullPct === 'number' ? `, ${c.nullPct}% null` : '';
      lines.push(`  - ${c.name} (${c.type}${nullNote})`);
    }
  }

  const dictKeys = Object.keys(dictionary);
  const knownNames = new Set();
  for (const t of strip.tables) for (const c of t.columns) knownNames.add(String(c.name).toLowerCase());
  const matchedDictKeys = dictKeys.filter(k => knownNames.has(String(k).toLowerCase()));
  if (matchedDictKeys.length > 0) {
    lines.push('');
    lines.push('## Column dictionary (authoritative field definitions supplied by the user -- ground your "why" in these, do not contradict them)');
    for (const k of matchedDictKeys) {
      lines.push(`  - ${k}: ${dictionary[k]}`);
    }
  }

  lines.push('');
  lines.push('## Task');
  lines.push(`Propose ${MIN_CANDIDATES_TARGET}-${MAX_CANDIDATES} candidate analysis questions as a JSON array. Each item: {"text","why","metricType","sql"}.`);
  lines.push('metricType must be one of: count, rate, share, delta, sum, avg. sql must be a SELECT-only statement using only the columns/tables above.');
  if (matchedDictKeys.length > 0) {
    lines.push('Use the column dictionary above to write more precise "why" explanations grounded in the real field definitions.');
  }

  const user = lines.join('\n');
  return {
    system: SCOUT_SYSTEM_PROMPT,
    user,
    dictionaryApplied: matchedDictKeys.length > 0,
    matchedDictionaryKeys: matchedDictKeys,
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

// A49.2 Browse UNVERIFIED tag hardening (SPEC #5): a short, stable tag for
// the browse-mode UI to render as a visible badge next to any answer that
// asserts a number, separate from the longer inline parenthetical note
// above (which stays for backward compatibility with v1's exact string).
export const UNVERIFIED_TAG = 'UNVERIFIED';

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

/**
 * A49.2 hardened browse-mode tagging (SPEC #5: "any numeric assertion tagged
 * UNVERIFIED until Prove"). Returns a structured
 *   { text, isUnverified, tag, displayText }
 * so the canvas UI can render a visible UNVERIFIED badge (via `tag`/
 * `isUnverified`) in addition to (not instead of) the inline parenthetical
 * note from annotateUnverifiedNumbers() (kept for v1 backward compatibility
 * and reused here so both stay in sync). Detects bare digits, percentages
 * ("42%"), and currency-prefixed numbers ("$42", "$1,200.50") alike, since
 * all three are numeric assertions that Browse mode itself never proved.
 */
export function tagAnswerForBrowse(answerText) {
  const raw = String(answerText || '');
  const displayText = annotateUnverifiedNumbers(raw);
  const isUnverified = /\d/.test(raw);
  return {
    text: raw,
    isUnverified,
    tag: isUnverified ? UNVERIFIED_TAG : null,
    displayText,
  };
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
// 7b. Keeper quality meter (A49.2 SCOUT_V2_SPEC #6)
// ------------------------------------------------------------
// "Show how many of 5 keepers pass full filter (business owner + answerable
// + checkable + not vanity)." This is a STRICTER pass/fail read of the same
// scoreCandidate() hits/penalties used for ranking -- a keeper can have a
// decent 0-100 score yet still miss one of the four named criteria, so the
// meter re-checks each criterion explicitly rather than thresholding the
// aggregate score.

/**
 * Evaluate one keeper against the SPEC's four named quality criteria.
 * Returns { businessOwner, answerable, checkable, notVanity, passesAll }.
 *   - businessOwner: hits includes business_actor_or_ops_language
 *   - answerable:    hits includes references_real_column_or_table (or the
 *                    profile is empty/unknown, in which case we do not
 *                    penalize a keeper for a profile we cannot check against)
 *   - checkable:     metricTypeOk (count/rate/share/delta/sum/avg)
 *   - notVanity:     neither viz_vanity_without_metric nor
 *                    vague_interest_without_metric penalties fired
 */
export function keeperPassesFullFilter(keeper, profileStrip) {
  const detail = scoreCandidate(keeper, profileStrip);
  const known = knownIdentifiers(profileStrip);
  const businessOwner = detail.hits.includes('business_actor_or_ops_language');
  const answerable = known.size === 0 ? true : detail.hits.includes('references_real_column_or_table');
  const checkable = !!detail.metricTypeOk;
  const notVanity = !detail.penalties.includes('viz_vanity_without_metric') && !detail.penalties.includes('vague_interest_without_metric');
  return {
    businessOwner,
    answerable,
    checkable,
    notVanity,
    passesAll: businessOwner && answerable && checkable && notVanity,
    scoreDetail: detail,
  };
}

/**
 * Build the keeper quality meter shown above the keepers tray: how many of
 * the (up to MAX_KEEPERS) current keepers pass the full four-part filter.
 * Returns { total, passing, passingIds, failingIds, perKeeper[], label }
 * where `label` is a short human string like "3/5 keepers pass full filter"
 * ready to render directly. Never throws on an empty/missing keepers list.
 */
export function keeperQualityMeter(keepers, profileStrip) {
  const list = Array.isArray(keepers) ? keepers : [];
  const perKeeper = list.map(k => ({ id: k.id, text: k.text, ...keeperPassesFullFilter(k, profileStrip) }));
  const passingIds = perKeeper.filter(p => p.passesAll).map(p => p.id);
  const failingIds = perKeeper.filter(p => !p.passesAll).map(p => p.id);
  return {
    total: list.length,
    passing: passingIds.length,
    passingIds,
    failingIds,
    perKeeper,
    label: `${passingIds.length}/${list.length} keeper${list.length === 1 ? '' : 's'} pass full filter (business owner + answerable + checkable + not vanity)`,
  };
}

// ------------------------------------------------------------
// 7c. Export keepers JSON (A49.2 SCOUT_V2_SPEC #7)
// ------------------------------------------------------------
// "Portable list for portfolio method section." Pure string/object builder;
// never touches the filesystem or network itself -- the canvas UI module is
// responsible for turning the returned string into a download (e.g. a Blob +
// anchor click), matching every other export path in this codebase that
// keeps engines DOM-free.

/**
 * Build the portable export payload for the current keepers list. Returns a
 * plain object (JSON-serializable); pairs with exportKeepersJson() below
 * for callers that want the string form directly. Includes the keeper
 * quality meter so the exported method-section artifact is self-documenting
 * about which keepers passed the full filter, not just their raw text/SQL.
 */
export function buildKeepersExport(keepers, profileStrip) {
  const list = Array.isArray(keepers) ? keepers : [];
  const meter = keeperQualityMeter(list, profileStrip);
  return {
    kind: 'dataglow-question-scout-keepers-export',
    version: QUESTION_SCOUT_VERSION,
    scoutV2Version: SCOUT_V2_VERSION,
    exportedAt: new Date().toISOString(),
    qualityMeter: { total: meter.total, passing: meter.passing, label: meter.label },
    keepers: list.map(k => ({
      id: k.id,
      text: k.text,
      why: k.why || null,
      metricType: k.metricType || null,
      sql: k.sql || null,
      source: k.source || null,
      domainPack: k.domainPack || null,
      score: typeof k.score === 'number' ? k.score : null,
      edited: !!k.edited,
      passesFullFilter: (meter.perKeeper.find(p => p.id === k.id) || {}).passesAll || false,
    })),
  };
}

/**
 * String form of buildKeepersExport(), pretty-printed so it is directly
 * usable as a downloadable `.json` file or pasted into a portfolio method
 * section. Never throws (JSON.stringify on a plain object built entirely
 * from string/number/boolean fields above cannot fail).
 */
export function exportKeepersJson(keepers, profileStrip) {
  return JSON.stringify(buildKeepersExport(keepers, profileStrip), null, 2);
}

// ------------------------------------------------------------
// Public namespace export (mirrors js/ai/local-ai-status.js's window.* pattern)
// ------------------------------------------------------------
export const DataGlowQuestionScout = {
  QUESTION_SCOUT_VERSION,
  SCOUT_V2_VERSION,
  MAX_CANDIDATES,
  MIN_CANDIDATES_TARGET,
  MAX_KEEPERS,
  METRIC_TYPES,
  CHEATING_BOUNDARY_BANNER,
  ANSWER_UNVERIFIED_NOTE,
  UNVERIFIED_TAG,
  HEALTHCARE_IDR_PACK_ID,
  buildProfileStrip,
  buildJoinHints,
  joinCandidatesFromHints,
  scoreCandidate,
  rankCandidates,
  templateCandidatesFromProfile,
  idrPackCandidates,
  parseDictionary,
  buildScoutPrompt,
  parseModelCandidates,
  buildProvePrefill,
  buildBrowseGrounding,
  annotateUnverifiedNumbers,
  tagAnswerForBrowse,
  addKeeper,
  removeKeeper,
  keeperPassesFullFilter,
  keeperQualityMeter,
  buildKeepersExport,
  exportKeepersJson,
};

try {
  if (typeof window !== 'undefined') window.DataGlowQuestionScout = DataGlowQuestionScout;
} catch (_e) {}
