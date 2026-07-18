// ============================================================
// DATAGLOW — Polyglot Error Advisor (Polyglot Workbench, Batch E)
// ============================================================
// Cross-language "Suggested fix" for SQL, Python, and R errors that reference
// names the Object Space already knows about. Extends formatSqlError's pattern
// (js/app-shell/sql-highlight.js) to Python tracebacks and R conditions, and
// adds a second layer of cross-registry advice when the error message mentions
// a name that resolves — or almost resolves — in the live Object Space.
//
// WHAT IT DOES
//   1. Parses a raw error string from any of the three runtimes into a
//      structured shape: { language, kind, detail, hint, suggestedFix, raw }.
//
//   2. If the parsed error message references an identifier (column/table/
//      variable name), looks it up in the Object Space registry:
//        a. Exact match in the wrong language → suggests the right call form
//           (e.g. "FROM py.claims" if you typed "FROM claims" and claims is
//           registered as a Python object, or
//           "dataglow.get_df('patients')" if you typed "patients" in Python
//           and patients is a SQL-origin table).
//        b. Near-match (case-insensitive) → suggests the correct spelling.
//
//   3. Never invents a fix it cannot ground in the live registry or a
//      well-known language-specific pattern — mirrors the existing
//      formatSqlError discipline of returning an empty hint rather than
//      fabricating advice.
//
// SAFETY
//   Pure: no DOM, no DuckDB, no network, no eval. Inputs are opaque strings.
//   Fully unit-testable in Node with zero setup.

export const POLYGLOT_ERROR_ADVISOR_VERSION = 1;

// ============================================================
// Shared helpers
// ============================================================

function lc(s) { return (s == null ? '' : String(s)).toLowerCase(); }
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Extract the first plausible identifier from an error string.
// Looks for tokens in quotes (double, single, backtick) first, then bare
// CamelCase/snake_case identifiers that look like names rather than keywords.
const QUOTED_IDENT_RE = /["'`]([A-Za-z_][A-Za-z0-9_.]*?)["'`]/;
const BARE_IDENT_RE = /\b([A-Za-z_][A-Za-z0-9_]{2,})\b/;

function extractIdentifier(message) {
  const qm = QUOTED_IDENT_RE.exec(message);
  if (qm) return qm[1];
  const bm = BARE_IDENT_RE.exec(message);
  if (bm) return bm[1];
  return null;
}

// Find the best Object Space match for an identifier:
//   - exact name match (bare or prefixed)
//   - case-insensitive match
//   - prefix match (3+ chars)
// Returns null when nothing is close enough to avoid fabricated suggestions.
function findRegistryMatch(ident, entries) {
  if (!ident || !entries || !entries.length) return null;
  const identLower = lc(ident);

  // 1. Exact match (bare name, ignoring py:/r: prefix)
  for (const e of entries) {
    if (typeof e.name !== 'string') continue;
    const bare = e.name.replace(/^(py:|r:)/, '');
    if (bare === ident || e.name === ident) return e;
  }

  // 2. Case-insensitive match
  for (const e of entries) {
    if (typeof e.name !== 'string') continue;
    const bare = e.name.replace(/^(py:|r:)/, '');
    if (lc(bare) === identLower) return e;
  }

  // 3. Prefix match (>= 3 chars)
  if (identLower.length >= 3) {
    for (const e of entries) {
      if (typeof e.name !== 'string') continue;
      const bare = e.name.replace(/^(py:|r:)/, '');
      if (lc(bare).startsWith(identLower) || identLower.startsWith(lc(bare).slice(0, identLower.length))) {
        return e;
      }
    }
  }

  return null;
}

// Build a cross-registry suggested fix when the named identifier is found in
// the Object Space but its origin language is different from the caller's.
function crossLanguageFix(ident, match, callerLanguage) {
  if (!match) return '';
  const bare = match.name.replace(/^(py:|r:)/, '');
  const origin = match.originLanguage;
  const same = origin === callerLanguage;

  if (callerLanguage === 'sql') {
    if (origin === 'python') {
      return '"' + bare + '" was created in Python — use FROM py.' + bare + ' to access it here.';
    }
    if (origin === 'r') {
      return '"' + bare + '" was created in R — use FROM r.' + bare + ' to access it here.';
    }
    // Same language (SQL): suggest correct spelling whenever ident and bare differ in any way
    if (same && ident !== bare) {
      return 'Did you mean "' + bare + '"?';
    }
  }

  if (callerLanguage === 'python') {
    if (origin === 'sql') {
      if (lc(ident) !== lc(bare)) {
        return '"' + bare + '" is a SQL table — try: df = dataglow.get_df(\'' + bare + '\')';
      }
      return '"' + ident + '" is a SQL table. Load it with: df = dataglow.get_df(\'' + bare + '\')';
    }
    if (origin === 'r') {
      return '"' + bare + '" was computed in R — run the R tab first, then use dataglow.get_df(\'' + bare + '\') in Python.';
    }
    if (same && lc(ident) !== lc(bare)) {
      return 'Did you mean "' + bare + '"?';
    }
  }

  if (callerLanguage === 'r') {
    if (origin === 'sql') {
      if (lc(ident) !== lc(bare)) {
        return '"' + bare + '" is a SQL table — try: df <- dataglow_get_df(\'' + bare + '\')';
      }
      return '"' + ident + '" is a SQL table. Load it with: df <- dataglow_get_df(\'' + bare + '\')';
    }
    if (origin === 'python') {
      return '"' + bare + '" was computed in Python — run the Python tab first, then use dataglow_get_df(\'' + bare + '\') in R.';
    }
    if (same && lc(ident) !== lc(bare)) {
      return 'Did you mean "' + bare + '"?';
    }
  }

  return '';
}

// ============================================================
// Language-specific parsers
// ============================================================

function parseSqlError(raw) {
  let kind = 'SQL Error';
  let detail = raw;
  const m = raw.match(/^([A-Za-z][A-Za-z ]*?Error)\s*:\s*([\s\S]*)$/);
  if (m) { kind = m[1]; detail = m[2].trim(); }

  let hint = '';
  const lower = raw.toLowerCase();
  if (/referenced column .* not found|column .* does not exist/.test(lower)) {
    hint = 'Check the column name — column names are case-sensitive when quoted.';
  } else if (/table with name .* does not exist|catalog error/.test(lower)) {
    hint = 'Check the table name or load the dataset first.';
  } else if (/syntax error/.test(lower)) {
    hint = 'Check for a missing comma, keyword, or unclosed quote near the caret (^).';
  } else if (/logarithm of zero|out of range/.test(lower)) {
    hint = 'A value exceeded the function domain (e.g. LOG of 0 or a negative).';
  } else if (/could not convert|invalid input syntax/.test(lower)) {
    hint = 'A CAST or implicit coercion failed — check the data type of the column.';
  }
  return { kind, detail, hint };
}

// Python traceback: last line of the traceback is the most useful message.
// "NameError: name 'xyz' is not defined" / "KeyError: 'col'" / "AttributeError: ..."
function parsePythonError(raw) {
  const lines = raw.trim().split('\n');
  const lastLine = lines[lines.length - 1].trim();
  let kind = 'Python Error';
  let detail = lastLine;

  const km = lastLine.match(/^([A-Za-z][A-Za-z]*Error)\s*:\s*(.*)/);
  if (km) { kind = km[1]; detail = km[2].trim(); }

  let hint = '';
  const lower = lastLine.toLowerCase();
  if (/name .* is not defined/.test(lower)) {
    hint = 'The variable or function name is not yet in scope — define it or import it first.';
  } else if (/keyerror/.test(lower)) {
    hint = 'The column key does not exist in the DataFrame — check spelling and use df.columns to list available names.';
  } else if (/attributeerror/.test(lower)) {
    hint = 'The method or property does not exist on this object — check the pandas documentation.';
  } else if (/typeerror/.test(lower)) {
    hint = 'A value has an unexpected type — check the column dtype with df.dtypes.';
  } else if (/valueerror/.test(lower)) {
    hint = 'A value is in an unexpected format — check for NaN, empty strings, or mixed types.';
  } else if (/importerror|modulenotfounderror/.test(lower)) {
    hint = 'The library is not available in this sandbox — use only pre-installed packages.';
  }
  return { kind, detail, hint };
}

// R error/warning: "Error in f(x) : message" or "Error: message"
function parseRError(raw) {
  const lines = raw.trim().split('\n');
  // R errors often start with "Error in ..." or "Error:"
  const errLine = lines.find(function(l) { return /^Error/.test(l.trim()); }) || lines[0];
  const warnLine = lines.find(function(l) { return /^Warning/.test(l.trim()); });

  let kind = warnLine && !errLine ? 'R Warning' : 'R Error';
  const targetLine = errLine || warnLine || lines[0];
  let detail = targetLine.trim();

  const em = targetLine.match(/^(?:Error(?: in [^\s:]+)?)\s*:\s*(.*)/);
  if (em) { detail = em[1].trim(); }
  const wm = targetLine.match(/^(?:Warning(?: message)?:?\s*(?:In [^\s:]+\s*:)?\s*)(.*)/);
  if (wm && kind === 'R Warning') { detail = wm[1].trim(); }

  let hint = '';
  const lower = raw.toLowerCase();
  if (/could not find function/.test(lower)) {
    hint = 'The function is not in scope — load the library with library() first.';
  } else if (/object .* not found/.test(lower)) {
    hint = 'The variable is not defined — create it or load the dataset first.';
  } else if (/undefined columns selected/.test(lower)) {
    hint = 'The column name does not exist — use colnames(df) to list available columns.';
  } else if (/incorrect number of dimensions/.test(lower)) {
    hint = 'Check index/subset notation — use [[ ]] or $ for single columns in a data.frame.';
  } else if (/subscript out of bounds/.test(lower)) {
    hint = 'The index exceeds the length of the vector or list.';
  }
  return { kind, detail, hint };
}

// ============================================================
// Public API
// ============================================================

/**
 * Parse a raw runtime error and enrich it with a registry-grounded suggested fix.
 *
 * @param {string} rawError - the raw error string from the runtime
 * @param {'sql'|'python'|'r'} language
 * @param {Array} objectSpaceEntries - as returned by listObjectSpace()
 * @returns {{language:string, kind:string, detail:string, hint:string, suggestedFix:string, raw:string}}
 */
export function adviseError(rawError, language, objectSpaceEntries) {
  const raw = (rawError == null ? '' : String(rawError)).trim();
  const lang = typeof language === 'string' ? language.toLowerCase() : 'sql';
  const entries = Array.isArray(objectSpaceEntries) ? objectSpaceEntries : [];

  let parsed;
  if (lang === 'python') {
    parsed = parsePythonError(raw || 'Unknown Python error');
  } else if (lang === 'r') {
    parsed = parseRError(raw || 'Unknown R error');
  } else {
    parsed = parseSqlError(raw || 'Unknown SQL error');
  }

  // Extract a candidate identifier from the error message and look it up
  const ident = extractIdentifier(raw);
  const match = findRegistryMatch(ident, entries);
  const suggestedFix = ident ? crossLanguageFix(ident, match, lang) : '';

  return {
    language: lang,
    kind: parsed.kind,
    detail: parsed.detail,
    hint: parsed.hint,
    suggestedFix,
    raw,
  };
}

/**
 * Build an HTML snippet for the error card, matching the shape of renderSqlErrorHtml
 * in js/app-shell/sql-highlight.js so it can slot into existing UI patterns.
 *
 * @param {ReturnType<typeof adviseError>} advised
 * @returns {string} HTML string (not a DOM node)
 */
export function renderAdvisedErrorHtml(advised) {
  const d = advised || {};
  const hintHtml = d.hint
    ? '<div class="sql-error-hint">' + escapeHtml(d.hint) + '</div>'
    : '';
  const fixHtml = d.suggestedFix
    ? '<div class="sql-error-hint" style="margin-top:4px; color:var(--color-primary);">Suggested fix: ' + escapeHtml(d.suggestedFix) + '</div>'
    : '';
  return '<div class="sql-error-kind">' + escapeHtml(d.kind || 'Error') + '</div>' +
    '<pre class="sql-error-detail">' + escapeHtml(d.detail || '') + '</pre>' +
    hintHtml + fixHtml;
}

export const PUBLIC_API_SURFACE = Object.freeze([
  'adviseError',
  'renderAdvisedErrorHtml',
]);
