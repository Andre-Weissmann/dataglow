// ============================================================
// DATAGLOW — Lightweight SQL Syntax Highlighter
// ============================================================
// Zero-dependency, zero-network, no-build SQL tokenizer. It powers a
// highlighted <pre> overlay rendered directly behind the plain #sql-input
// textarea (the textarea's own text is made transparent, its caret kept
// visible). We deliberately avoid CodeMirror/Monaco here: both would mean
// either a CDN runtime dependency (forbidden for the core app — DATAGLOW is
// zero-upload / local-first) or vendoring a bundle that expects a build step
// this project intentionally does not have. A hand-rolled tokenizer keeps the
// feature honest to those constraints and stays trivially unit-testable in
// Node (highlightSql is a pure string->string function).

// DuckDB / ANSI SQL keyword set (upper-cased for case-insensitive matching).
const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'USING',
  'AS', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'ALL', 'UNION', 'EXCEPT',
  'INTERSECT', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE',
  'TABLE', 'VIEW', 'DROP', 'ALTER', 'ADD', 'COLUMN', 'REPLACE', 'IF', 'EXISTS',
  'WITH', 'RECURSIVE', 'OVER', 'PARTITION', 'WINDOW', 'ASC', 'DESC', 'NULLS',
  'FIRST', 'LAST', 'CAST', 'TRY_CAST', 'FILTER', 'QUALIFY', 'USING', 'PIVOT',
  'UNPIVOT', 'SAMPLE', 'DESCRIBE', 'EXPLAIN', 'PRAGMA', 'SUMMARIZE', 'COLUMNS',
  'EXCLUDE', 'TRUE', 'FALSE', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
  'DEFAULT', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'RETURNING', 'COLLATE', 'DATA',
  'TYPE', 'TO',
]);

// Common built-in functions get their own class so they read distinctly from
// bare column identifiers, but are not treated as reserved keywords.
const SQL_FUNCTIONS = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ABS', 'ROUND', 'FLOOR', 'CEIL',
  'CEILING', 'LOG', 'LOG10', 'LN', 'EXP', 'SQRT', 'POWER', 'MOD', 'COALESCE',
  'NULLIF', 'GREATEST', 'LEAST', 'LENGTH', 'LOWER', 'UPPER', 'TRIM', 'LTRIM',
  'RTRIM', 'SUBSTRING', 'SUBSTR', 'REPLACE', 'CONCAT', 'SPLIT', 'REGEXP_MATCHES',
  'REGEXP_REPLACE', 'STRFTIME', 'STRPTIME', 'DATE_TRUNC', 'DATE_PART', 'EXTRACT',
  'NOW', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'ROW_NUMBER', 'RANK', 'DENSE_RANK',
  'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTILE', 'STDDEV', 'VARIANCE',
  'MEDIAN', 'QUANTILE', 'MODE', 'STRING_AGG', 'ARRAY_AGG', 'LIST',
  'READ_CSV_AUTO', 'READ_JSON_AUTO', 'READ_PARQUET',
]);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Tokenize SQL into a flat list of { type, value } tokens. Pure function; the
// concatenation of every token.value exactly reconstructs the input (so the
// overlay stays glyph-for-glyph aligned with the textarea behind it).
export function tokenizeSql(sql) {
  const src = String(sql == null ? '' : sql);
  const tokens = [];
  let i = 0;
  const n = src.length;

  const isIdentStart = (ch) => /[A-Za-z_]/.test(ch);
  const isIdentPart = (ch) => /[A-Za-z0-9_$]/.test(ch);

  while (i < n) {
    const ch = src[i];

    // Whitespace
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      tokens.push({ type: 'plain', value: src.slice(i, j) });
      i = j;
      continue;
    }

    // Line comment  -- ...
    if (ch === '-' && src[i + 1] === '-') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      tokens.push({ type: 'comment', value: src.slice(i, j) });
      i = j;
      continue;
    }

    // Block comment /* ... */
    if (ch === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      tokens.push({ type: 'comment', value: src.slice(i, j) });
      i = j;
      continue;
    }

    // Single-quoted string literal (with '' escape)
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") { j++; break; }
        j++;
      }
      tokens.push({ type: 'string', value: src.slice(i, j) });
      i = j;
      continue;
    }

    // Double-quoted identifier (with "" escape)
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '"' && src[j + 1] === '"') { j += 2; continue; }
        if (src[j] === '"') { j++; break; }
        j++;
      }
      tokens.push({ type: 'identifier', value: src.slice(i, j) });
      i = j;
      continue;
    }

    // Number literal (int / decimal / scientific)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[0-9.eE+\-]/.test(src[j])) {
        // stop a trailing +/- that isn't part of an exponent
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1])) break;
        j++;
      }
      tokens.push({ type: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }

    // Identifier / keyword / function
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      const upper = word.toUpperCase();
      let type = 'identifier';
      if (SQL_KEYWORDS.has(upper)) type = 'keyword';
      else if (SQL_FUNCTIONS.has(upper) && src[j] === '(') type = 'function';
      else if (SQL_FUNCTIONS.has(upper)) type = 'function';
      tokens.push({ type, value: word });
      i = j;
      continue;
    }

    // Operators / punctuation — group a run of operator chars together
    if (/[-+*/%<>=!&|^~]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[-+*/%<>=!&|^~]/.test(src[j])) {
        // don't swallow the start of a comment
        if (src[j] === '-' && src[j + 1] === '-') break;
        if (src[j] === '/' && src[j + 1] === '*') break;
        j++;
      }
      tokens.push({ type: 'operator', value: src.slice(i, j) });
      i = j;
      continue;
    }

    // Anything else (parens, commas, dots, semicolons…)
    tokens.push({ type: 'punct', value: ch });
    i++;
  }

  return tokens;
}

// Render SQL as an HTML string of <span class="tok-*"> nodes. Safe to inject:
// every token value is HTML-escaped. Pure string -> string.
export function highlightSql(sql) {
  return tokenizeSql(sql)
    .map((t) => {
      const safe = escapeHtml(t.value);
      if (t.type === 'plain') return safe;
      return `<span class="tok-${t.type}">${safe}</span>`;
    })
    .join('');
}

// Turn a raw DuckDB-WASM error into a cleaner, structured shape for display.
// DuckDB messages look like:  "Binder Error: Referenced column \"foo\" not
// found...\nLINE 1: SELECT foo FROM t\n               ^". We split the leading
// "<Kind> Error:" prefix out as a heading and keep the rest as detail, and
// surface a short hint for the most common mistakes. Pure function.
export function formatSqlError(err) {
  const raw = (err && err.message ? err.message : String(err || 'Unknown error')).trim();
  let kind = 'Query Error';
  let detail = raw;

  const m = raw.match(/^([A-Za-z][A-Za-z ]*?Error)\s*:\s*([\s\S]*)$/);
  if (m) {
    kind = m[1];
    detail = m[2].trim();
  }

  let hint = '';
  const lower = raw.toLowerCase();
  if (/referenced column .* not found|column .* does not exist/.test(lower)) {
    hint = 'Check the column name and spelling — column names are case-sensitive when quoted.';
  } else if (/table with name .* does not exist|catalog error/.test(lower)) {
    hint = 'Load a dataset first, or check the table name in the sidebar.';
  } else if (/syntax error/.test(lower)) {
    hint = 'Check for a missing comma, keyword, or unclosed quote near the caret (^).';
  } else if (/logarithm of zero|out of range/.test(lower)) {
    hint = 'A value went out of the function’s valid domain (e.g. LOG of 0 or a negative).';
  }

  return { kind, detail, hint, raw };
}

// Build the inner HTML for the error card (escaped). Kept here so both the app
// and tests exercise the same rendering. Returns an HTML string.
export function renderSqlErrorHtml(err) {
  const { kind, detail, hint } = formatSqlError(err);
  const hintHtml = hint
    ? `<div class="sql-error-hint">${escapeHtml(hint)}</div>`
    : '';
  return `<div class="sql-error-kind">${escapeHtml(kind)}</div>` +
    `<pre class="sql-error-detail">${escapeHtml(detail)}</pre>` +
    hintHtml;
}
