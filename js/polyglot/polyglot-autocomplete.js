// ============================================================
// DATAGLOW — Polyglot Autocomplete (Polyglot Workbench, Batch D)
// ============================================================
// Schema-aware inline suggestions for the SQL, Python, and R editors,
// sourced entirely from the live Object Space registry so every named object
// a user has already created (loaded dataset, Python-computed frame,
// R-registered result) is immediately suggest-able without re-typing.
//
// SCOPE
//   Suggestion pools are built from the Object Space list — no DuckDB schema
//   query, no parser, no network. Each editor gets the appropriate vocabulary:
//
//   SQL   — table names (all origins), column names for every registered
//           schema, common DuckDB keywords and functions, py./r. prefixes for
//           cross-runtime FROM references (only when the bridge flag is on).
//
//   Python — registered object names (usable in `dataglow.get_df('name')`),
//            column names quoted for bracket access (df['col']), pandas method
//            fragments, and the `dataglow.get_df(` call stem itself.
//
//   R      — registered object names (usable in `dataglow_get_df('name')`),
//            column names quoted for $ access (df$col), dplyr verb fragments,
//            and the `dataglow_get_df(` call stem itself.
//
// COMPLETION CONTRACT
//   getSuggestions(typed, language, objectSpaceEntries) → Array<Suggestion>
//   Each Suggestion: { text, insertText, kind, origin, score }
//     text        — the full token to display in the popup
//     insertText  — the suffix only (what gets inserted after the cursor)
//     kind        — 'table'|'column'|'keyword'|'function'|'snippet'
//     origin      — 'object-space'|'schema'|'builtin'
//     score       — numeric relevance (higher = ranks earlier in the list)
//
//   topSuggestion(typed, language, objectSpaceEntries) → Suggestion|null
//   — The single highest-scored match, for ghost-text inline rendering
//     (like question-generator-agent.js's ghostCompletion, but cross-language).
//
// SAFETY
//   Pure: no DOM, no DuckDB, no network, no eval. All inputs treated as opaque
//   strings — no code execution of user input. Capable of running in Node for
//   unit tests with zero setup.

export const POLYGLOT_AUTOCOMPLETE_VERSION = 1;

// ============================================================
// SQL vocabulary — keywords and common DuckDB functions
// ============================================================

const SQL_KEYWORDS = Object.freeze([
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL OUTER JOIN', 'CROSS JOIN',
  'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'DISTINCT', 'WITH', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'CREATE TABLE', 'DROP TABLE', 'ALTER TABLE',
]);

const SQL_FUNCTIONS = Object.freeze([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ROUND', 'FLOOR', 'CEIL',
  'COALESCE', 'NULLIF', 'IFNULL', 'IIF', 'TRY_CAST',
  'STRFTIME', 'DATE_TRUNC', 'DATE_DIFF', 'DATE_ADD', 'NOW', 'CURRENT_DATE',
  'LENGTH', 'LOWER', 'UPPER', 'TRIM', 'LTRIM', 'RTRIM', 'SUBSTR', 'REPLACE',
  'SPLIT_PART', 'REGEXP_MATCHES', 'REGEXP_REPLACE',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
  'STDDEV', 'VARIANCE', 'PERCENTILE_CONT', 'PERCENTILE_DISC', 'MEDIAN',
  'LIST_AGG', 'STRING_AGG', 'ARRAY_AGG',
  'JSON_EXTRACT', 'JSON_EXTRACT_STRING',
  'CAST', 'TRY_CAST',
  'EPOCH', 'EPOCH_MS', 'TO_TIMESTAMP',
]);

// ============================================================
// Python vocabulary — pandas / dataglow bridge fragments
// ============================================================

const PYTHON_SNIPPETS = Object.freeze([
  { text: 'dataglow.get_df(', kind: 'snippet' },
  { text: 'import pandas as pd', kind: 'snippet' },
  { text: 'import matplotlib.pyplot as plt', kind: 'snippet' },
  { text: 'df.head()', kind: 'snippet' },
  { text: 'df.describe()', kind: 'snippet' },
  { text: 'df.dtypes', kind: 'snippet' },
  { text: 'df.shape', kind: 'snippet' },
  { text: 'df.columns', kind: 'snippet' },
  { text: 'df.value_counts()', kind: 'snippet' },
  { text: 'df.groupby()', kind: 'snippet' },
  { text: 'df.merge()', kind: 'snippet' },
  { text: 'df.dropna()', kind: 'snippet' },
  { text: 'df.fillna()', kind: 'snippet' },
  { text: 'df.sort_values()', kind: 'snippet' },
  { text: 'df.rename(columns={})', kind: 'snippet' },
  { text: 'plt.show()', kind: 'snippet' },
  { text: 'plt.title()', kind: 'snippet' },
]);

// ============================================================
// R vocabulary — dplyr / dataglow bridge fragments
// ============================================================

const R_SNIPPETS = Object.freeze([
  { text: 'dataglow_get_df(', kind: 'snippet' },
  { text: 'library(dplyr)', kind: 'snippet' },
  { text: 'library(ggplot2)', kind: 'snippet' },
  { text: 'df %>% filter()', kind: 'snippet' },
  { text: 'df %>% select()', kind: 'snippet' },
  { text: 'df %>% mutate()', kind: 'snippet' },
  { text: 'df %>% group_by()', kind: 'snippet' },
  { text: 'df %>% summarise()', kind: 'snippet' },
  { text: 'df %>% arrange()', kind: 'snippet' },
  { text: 'df %>% rename()', kind: 'snippet' },
  { text: 'head(df)', kind: 'snippet' },
  { text: 'str(df)', kind: 'snippet' },
  { text: 'summary(df)', kind: 'snippet' },
  { text: 'colnames(df)', kind: 'snippet' },
  { text: 'nrow(df)', kind: 'snippet' },
  { text: 'ggplot(df, aes()) + geom_point()', kind: 'snippet' },
]);

// ============================================================
// Score helpers
// ============================================================

// How closely does `candidate` match `typed` (both lowercased by caller)?
// Returns 0..1. Prefix match scores highest; contains-match scores lower.
function matchScore(candidate, typed) {
  if (!typed) return 0.1;
  if (candidate === typed) return 1.0;
  if (candidate.startsWith(typed)) return 0.8 + (typed.length / candidate.length) * 0.2;
  if (candidate.includes(typed)) return 0.3 + (typed.length / candidate.length) * 0.2;
  return 0;
}

// Normalize a raw string token so lookups are case-insensitive.
function lc(s) { return (s == null ? '' : String(s)).toLowerCase(); }

// ============================================================
// Object Space → suggestion builders
// ============================================================

// Build table-name suggestions from every object in the registry.
// For SQL: bare table name AND optional py./r. prefixed version.
function tableNamesFromRegistry(entries, language, includeBridgePrefixes) {
  const results = [];
  for (const e of entries) {
    if (!e || typeof e.name !== 'string') continue;
    const name = e.name;
    // Registry keys: bare SQL names (no prefix) or 'py:name' / 'r:name'
    const isPrefixed = name.startsWith('py:') || name.startsWith('r:');
    if (language === 'sql') {
      if (!isPrefixed) {
        results.push({ text: name, insertText: name, kind: 'table', origin: 'object-space', score: 0.7 });
      }
      if (includeBridgePrefixes && isPrefixed) {
        // Offer the `py.name` / `r.name` form the bridge resolves
        const dotForm = name.replace(':', '.');
        results.push({ text: dotForm, insertText: dotForm, kind: 'table', origin: 'object-space', score: 0.65 });
      }
    } else if (language === 'python' || language === 'r') {
      // The plain name (without prefix) is what dataglow.get_df/dataglow_get_df takes
      const plainName = isPrefixed ? name.slice(name.indexOf(':') + 1) : name;
      results.push({
        text: plainName,
        insertText: plainName,
        kind: 'table',
        origin: 'object-space',
        score: e.originLanguage === language ? 0.75 : 0.6,
      });
    }
  }
  return results;
}

// Build column suggestions from schemas in the registry, for a given language.
function columnsFromRegistry(entries, language) {
  const seen = new Set();
  const results = [];
  for (const e of entries) {
    if (!Array.isArray(e.schema)) continue;
    for (const col of e.schema) {
      if (!col || typeof col.name !== 'string') continue;
      if (seen.has(col.name)) continue;
      seen.add(col.name);
      if (language === 'sql') {
        results.push({ text: col.name, insertText: col.name, kind: 'column', origin: 'schema', score: 0.6 });
      } else if (language === 'python') {
        // Bracket notation for Python column access
        const bracketForm = "['" + col.name + "']";
        results.push({ text: bracketForm, insertText: bracketForm, kind: 'column', origin: 'schema', score: 0.55 });
      } else if (language === 'r') {
        // $ notation for R column access
        const dollarForm = '$' + col.name;
        results.push({ text: dollarForm, insertText: dollarForm, kind: 'column', origin: 'schema', score: 0.55 });
      }
    }
  }
  return results;
}

// ============================================================
// Public API
// ============================================================

/**
 * Build a pool of suggestions for the given editor language, scored and sorted
 * by relevance to what the user has typed so far.
 *
 * @param {string} typed - the current token being typed (e.g. 'pati' → suggests 'patients')
 * @param {'sql'|'python'|'r'} language
 * @param {Array} objectSpaceEntries - as returned by listObjectSpace()
 * @param {object} [opts]
 * @param {boolean} [opts.includeBridgePrefixes=true] - include py./r. forms in SQL suggestions
 * @param {number} [opts.maxResults=10] - max suggestions to return
 * @returns {Array<{text:string, insertText:string, kind:string, origin:string, score:number}>}
 */
export function getSuggestions(typed, language, objectSpaceEntries, opts) {
  const options = opts || {};
  const maxResults = (typeof options.maxResults === 'number' && options.maxResults > 0)
    ? options.maxResults : 10;
  const includeBridgePrefixes = options.includeBridgePrefixes !== false;

  const lang = typeof language === 'string' ? language.toLowerCase() : 'sql';
  const typedStr = typed == null ? '' : String(typed);
  if (!typedStr.trim()) return [];
  const typedLower = lc(typedStr);
  const entries = Array.isArray(objectSpaceEntries) ? objectSpaceEntries : [];

  // Collect candidates from all relevant pools for this language
  const candidates = [];

  // Object Space tables + columns (shared across all languages)
  const tables = tableNamesFromRegistry(entries, lang, includeBridgePrefixes);
  const columns = columnsFromRegistry(entries, lang);
  candidates.push(...tables, ...columns);

  if (lang === 'sql') {
    for (const kw of SQL_KEYWORDS) {
      candidates.push({ text: kw, insertText: kw, kind: 'keyword', origin: 'builtin', score: 0.4 });
    }
    for (const fn of SQL_FUNCTIONS) {
      candidates.push({ text: fn, insertText: fn + '(', kind: 'function', origin: 'builtin', score: 0.35 });
    }
  } else if (lang === 'python') {
    for (const s of PYTHON_SNIPPETS) {
      candidates.push({ text: s.text, insertText: s.text, kind: s.kind, origin: 'builtin', score: 0.4 });
    }
  } else if (lang === 'r') {
    for (const s of R_SNIPPETS) {
      candidates.push({ text: s.text, insertText: s.text, kind: s.kind, origin: 'builtin', score: 0.4 });
    }
  }

  // Score each candidate against what the user has typed
  const scored = [];
  for (const c of candidates) {
    const s = matchScore(lc(c.text), typedLower);
    if (s > 0) {
      scored.push({ ...c, score: c.score * s });
    }
  }

  // Deduplicate by text (keep highest score), then sort descending
  const best = new Map();
  for (const c of scored) {
    const existing = best.get(c.text);
    if (!existing || c.score > existing.score) best.set(c.text, c);
  }

  return [...best.values()]
    .sort(function(a, b) { return b.score - a.score; })
    .slice(0, maxResults);
}

/**
 * Return the single best ghost-text completion suffix for inline rendering
 * (i.e. the portion of the best match that follows what the user has already
 * typed). Returns empty string when nothing matches.
 *
 * @param {string} typed
 * @param {'sql'|'python'|'r'} language
 * @param {Array} objectSpaceEntries
 * @returns {string} the suffix to display as ghost text (may be empty)
 */
export function topSuggestion(typed, language, objectSpaceEntries) {
  const typedStr = typed == null ? '' : String(typed);
  if (!typedStr.trim()) return null;
  const results = getSuggestions(typedStr, language, objectSpaceEntries, { maxResults: 1 });
  if (!results.length) return null;
  const top = results[0];
  // Surface the suffix-only insertText for ghost rendering when it is a clean prefix match;
  // otherwise return the full suggestion so the caller can decide what to render.
  const topLower = lc(top.text);
  const typedLower2 = lc(typedStr);
  if (topLower.startsWith(typedLower2)) {
    return { ...top, insertText: top.text.slice(typedStr.length) };
  }
  return top;
}

export const PUBLIC_API_SURFACE = Object.freeze([
  'getSuggestions',
  'topSuggestion',
]);
