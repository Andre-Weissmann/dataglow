// ============================================================
// DATAGLOW — Drill Floor cross-language diff engine test suite (Batch 2)
// ============================================================
// Proves the PURE comparison layer in js/drill-floor/drill-diff.js:
//   - parseMatchedRows extracts the count from the EXACT "matched rows: N" text
//     Batch 1's Python/R starters print (and returns null, never throws, when
//     the pattern is absent)
//   - compareDrillResults reports match / mismatch / incomplete GROUNDED IN THE
//     ACTUAL numbers, computes correct pairwise deltas, and calls out every
//     errored / unknown / not-run language explicitly (NEVER as a silent 0)
//   - suggestLikelyCause returns a CAVEAT-FLAGGED boundary-mismatch hint for the
//     "one language low by a small margin" pattern and null when nothing fits
//
// Assertions are on EXACT strings/fields (no fuzzy substrings). No runtime is
// touched — every input is a fixture shaped like Batch 1's run* return values.
//
// RUN WITH: node test/drill-diff.test.mjs

import {
  LANG_LABELS,
  parseMatchedRows,
  compareDrillResults,
  suggestLikelyCause,
} from '../js/drill-floor/drill-diff.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg}${actual === expected ? '' : ` (got: ${JSON.stringify(actual)})`}`);
}

// ---------- parseMatchedRows ----------
{
  eq(parseMatchedRows('matched rows: 133'), 133, 'parses a bare "matched rows: N" line');
  // Batch 1 Python starter: print(f"matched rows: {len(result)}")
  eq(parseMatchedRows('matched rows: 4812\n'), 4812, 'parses the exact Python print format (trailing newline)');
  // Batch 1 R starter: cat('matched rows:', nrow(result), '\n') -> space before newline
  eq(parseMatchedRows('matched rows: 4795 \n'), 4795, 'parses the exact R cat format (space before newline)');
  eq(parseMatchedRows('preamble\nmatched rows: 42\nmore output'), 42, 'finds the count amid surrounding stdout');
  eq(parseMatchedRows('matched rows: 5\nmatched rows: 12'), 12, 'uses the LAST match when several are present');
  eq(parseMatchedRows('no count printed here'), null, 'returns null when the pattern is absent (user edited out the print)');
  eq(parseMatchedRows(''), null, 'returns null for empty stdout');
  eq(parseMatchedRows(undefined), null, 'returns null for undefined (never throws)');
  eq(parseMatchedRows(null), null, 'returns null for null (never throws)');
}

// ---------- compareDrillResults: all three agree ----------
{
  const d = compareDrillResults({
    sql: { rowCount: 133, result: {} },
    python: { stdout: 'matched rows: 133\n' },
    r: { stdout: 'matched rows: 133 \n' },
  });
  eq(d.status, 'match', 'three equal counts => match');
  eq(d.message, 'SQL, Python and R all returned 133 rows.', 'match message names all three with the shared count');
  eq(d.deltas, undefined, 'a match carries no deltas');
  eq(d.languages.sql.state, 'ok', 'sql language state is ok');
  eq(d.languages.sql.count, 133, 'sql count read from rowCount');
  eq(d.languages.python.count, 133, 'python count parsed from stdout');
  eq(d.languages.r.count, 133, 'r count parsed from stdout');
}

// ---------- compareDrillResults: two agree, third not run (still a match) ----------
{
  const d = compareDrillResults({
    sql: { rowCount: 133 },
    python: { stdout: 'matched rows: 133' },
    r: null,
  });
  eq(d.status, 'match', 'two equal counts (third not run) => match');
  eq(d.message, 'SQL and Python both returned 133 rows. R has not been run yet.', 'match uses "both" for two and calls out the not-run language');
  eq(d.languages.r.state, 'not-run', 'the un-run language is flagged not-run');
}

// ---------- compareDrillResults: mismatch, odd-one-out (the spec example) ----------
{
  const d = compareDrillResults({
    sql: { rowCount: 4812 },
    python: { stdout: 'matched rows: 4812' },
    r: { stdout: 'matched rows: 4795' },
  });
  eq(d.status, 'mismatch', 'differing counts => mismatch');
  eq(d.message, 'R returned 4,795 rows, 17 fewer than SQL and Python (4,812 each).', 'mismatch message is grounded in the actual observed numbers');
  eq(JSON.stringify(d.deltas), JSON.stringify([
    { pair: ['sql', 'python'], diff: 0 },
    { pair: ['sql', 'r'], diff: 17 },
    { pair: ['python', 'r'], diff: 17 },
  ]), 'deltas list every comparable pair with absolute differences');
}

// ---------- compareDrillResults: mismatch, "more" direction ----------
{
  const d = compareDrillResults({
    sql: { rowCount: 300 },
    python: { stdout: 'matched rows: 90000' },
    r: { stdout: 'matched rows: 300' },
  });
  eq(d.status, 'mismatch', 'a blown-up count is a mismatch');
  eq(d.message, 'Python returned 90,000 rows, 89,700 more than SQL and R (300 each).', 'odd-one-out uses "more" when the loner is higher, with thousands separators');
}

// ---------- compareDrillResults: mismatch between exactly two languages ----------
{
  const d = compareDrillResults({
    sql: { rowCount: 100 },
    python: { stdout: 'matched rows: 90' },
    r: null,
  });
  eq(d.status, 'mismatch', 'two differing counts => mismatch');
  eq(d.message, 'SQL returned 100 rows but Python returned 90 rows (a difference of 10). R has not been run yet.', 'two-language mismatch states both counts, the difference, and the not-run language');
  eq(JSON.stringify(d.deltas), JSON.stringify([{ pair: ['sql', 'python'], diff: 10 }]), 'only the comparable pair appears in deltas');
}

// ---------- compareDrillResults: an errored language is called out, never treated as 0 ----------
{
  const d = compareDrillResults({
    sql: { rowCount: 133 },
    python: { error: 'NameError: pandas' },
    r: { stdout: 'matched rows: 133' },
  });
  eq(d.status, 'match', 'the two languages that produced counts agree (error is not counted as 0)');
  eq(d.message, 'SQL and R both returned 133 rows. Python errored (NameError: pandas).', 'the errored language is surfaced explicitly with its message');
  eq(d.languages.python.state, 'error', 'errored language state is error');
  eq(d.languages.python.count, null, 'errored language has a null count, not 0');
}

// ---------- compareDrillResults: a language that ran but printed no count is "unknown" ----------
{
  const d = compareDrillResults({
    sql: { rowCount: 133 },
    python: { stdout: 'did some work but forgot to print the count' },
    r: { stdout: 'matched rows: 133' },
  });
  eq(d.status, 'match', 'the two comparable languages agree; the uncountable one is excluded, not zeroed');
  eq(d.message, 'SQL and R both returned 133 rows. Python ran but no row count could be read from its output.', 'the uncountable language is called out as unknown');
  eq(d.languages.python.state, 'unknown', 'uncountable language state is unknown');
}

// ---------- compareDrillResults: SQL with no rowCount is unknown (not 0) ----------
{
  const d = compareDrillResults({
    sql: { result: {} },
    python: { stdout: 'matched rows: 5' },
    r: { stdout: 'matched rows: 5' },
  });
  eq(d.status, 'match', 'python and r agree; sql without a rowCount is excluded');
  eq(d.message, 'Python and R both returned 5 rows. SQL ran but no row count could be read from its output.', 'sql without rowCount is reported as unknown');
  eq(d.languages.sql.state, 'unknown', 'sql without rowCount is unknown');
}

// ---------- compareDrillResults: incomplete (only one ran) ----------
{
  const d = compareDrillResults({ sql: { rowCount: 133 }, python: null, r: null });
  eq(d.status, 'incomplete', 'a single run cannot be compared => incomplete');
  eq(d.message, 'Not enough results to compare yet. SQL returned 133 rows. Python has not been run yet. R has not been run yet.', 'incomplete states the one available count and the not-run languages');
  eq(d.deltas, undefined, 'incomplete carries no deltas');
}

// ---------- compareDrillResults: incomplete (nothing ran) ----------
{
  const d = compareDrillResults({});
  eq(d.status, 'incomplete', 'no runs at all => incomplete');
  eq(d.message, 'No results to compare yet. SQL has not been run yet. Python has not been run yet. R has not been run yet.', 'incomplete with zero runs lists all three as not-run');
}

// ---------- suggestLikelyCause: boundary-mismatch hint (caveated) ----------
{
  const d = compareDrillResults({
    sql: { rowCount: 4812 },
    python: { stdout: 'matched rows: 4812' },
    r: { stdout: 'matched rows: 4795' },
  });
  const s = suggestLikelyCause(d);
  ok(s !== null && s.caveat === true, 'suggestion is returned and flagged as a caveat');
  eq(
    s.text,
    'R returned 17 rows fewer than the other languages. A common cause is an exclusive boundary comparison (`>`/`<` instead of `>=`/`<=`), which drops orders whose date falls exactly on a promo\'s start_date or end_date. This is only a likely cause, not a certainty — check the boundary conditions in the R code.',
    'suggestion is grounded (17 rows, R) and uses qualifying language ("a common cause", "not a certainty")',
  );
}

// ---------- suggestLikelyCause: works for a two-language small-gap mismatch ----------
{
  const d = compareDrillResults({ sql: { rowCount: 100 }, python: { stdout: 'matched rows: 90' }, r: null });
  const s = suggestLikelyCause(d);
  ok(s !== null && s.caveat === true, 'two-language small-gap mismatch yields a caveated suggestion');
  eq(
    s.text,
    'Python returned 10 rows fewer than the other language. A common cause is an exclusive boundary comparison (`>`/`<` instead of `>=`/`<=`), which drops orders whose date falls exactly on a promo\'s start_date or end_date. This is only a likely cause, not a certainty — check the boundary conditions in the Python code.',
    'singular "language" is used when only one other language is present',
  );
}

// ---------- suggestLikelyCause: null when there is no mismatch ----------
{
  const match = compareDrillResults({ sql: { rowCount: 133 }, python: { stdout: 'matched rows: 133' }, r: { stdout: 'matched rows: 133' } });
  eq(suggestLikelyCause(match), null, 'no suggestion for a clean match');
  eq(suggestLikelyCause(compareDrillResults({ sql: { rowCount: 1 } })), null, 'no suggestion for an incomplete comparison');
  eq(suggestLikelyCause(null), null, 'no suggestion for a null summary (never throws)');
}

// ---------- suggestLikelyCause: null when the pattern does not fit ----------
{
  // Three distinct counts: no single "odd one low against a matched rest".
  const threeWay = compareDrillResults({ sql: { rowCount: 100 }, python: { stdout: 'matched rows: 80' }, r: { stdout: 'matched rows: 60' } });
  eq(threeWay.status, 'mismatch', 'three distinct counts is still a mismatch');
  eq(suggestLikelyCause(threeWay), null, 'no boundary hint when three counts all differ (pattern does not fit)');

  // One language wildly HIGH (blown-up cross join) is not the boundary pattern.
  const blownUp = compareDrillResults({ sql: { rowCount: 300 }, python: { stdout: 'matched rows: 90000' }, r: { stdout: 'matched rows: 300' } });
  eq(suggestLikelyCause(blownUp), null, 'no boundary hint for a large gap (not a handful of dropped boundary rows)');
}

// ---------- exported labels ----------
{
  eq(JSON.stringify(LANG_LABELS), JSON.stringify({ sql: 'SQL', python: 'Python', r: 'R' }), 'LANG_LABELS exposes the canonical display names');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
