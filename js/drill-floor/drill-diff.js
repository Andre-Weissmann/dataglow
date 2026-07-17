// ============================================================
// DATAGLOW — Drill Floor: cross-language result-diff engine (Batch 2 of N)
// ============================================================
// WHAT THIS IS: the comparison layer that sits ON TOP of Batch 1's run* results
// (js/drill-floor/drill-floor.js) and explains, IN PLAIN LANGUAGE AND GROUNDED IN
// THE ACTUAL OBSERVED NUMBERS, whether the same drill produced the same answer in
// SQL, Python and R — and, when it did not, by how much they diverge.
//
// PURE by construction: compareDrillResults / suggestLikelyCause / parseMatchedRows
// take ALREADY-COMPUTED result objects (or raw stdout) and never touch a runtime,
// a DB, or the DOM — so they are fully Node-testable with fixture data, exactly
// like the pure data layer in js/drill-floor/drill-floor-data.js.
//
// Two rules this module holds to:
//   1. NEVER INVENT NUMBERS. Every count in a message is read from the inputs
//      (SQL's own rowCount field; the "matched rows: N" line the Batch 1 starters
//      print for Python/R). If a count can't be read, that language is reported as
//      an explicit "unknown"/"error"/"not-run" state — never silently treated as 0.
//   2. NEVER ASSERT A CAUSE. suggestLikelyCause pattern-matches a SMALL set of
//      known cross-language join/boundary gotchas for THIS drill and returns a
//      CAVEAT-FLAGGED best guess ("a common cause is...") or null. It is a hint,
//      not a diagnosis.

// Display labels for the three languages, in canonical column order.
export const LANG_LABELS = { sql: 'SQL', python: 'Python', r: 'R' };
const LANG_ORDER = ['sql', 'python', 'r'];

// Format an integer with US thousands separators: 4812 -> "4,812", 133 -> "133".
function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

// "row" vs "rows" for a count (|1| is singular; 0 and everything else plural).
function rowWord(n) {
  return Math.abs(n) === 1 ? 'row' : 'rows';
}

// Natural-language list join: [] -> "", [a] -> "a", [a,b] -> "a and b",
// [a,b,c] -> "a, b and c".
function joinAnd(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Pure parser for the row count a drill's Python/R starter prints. Batch 1's
 * starters emit a line like `matched rows: 133` (Python `print(f"matched rows:
 * {len(result)}")`; R `cat('matched rows:', nrow(result), '\n')`). Returns the
 * integer, or null if the pattern is absent (e.g. the user edited out the print)
 * — NEVER throws and NEVER guesses. If several such lines exist, the LAST one
 * wins (it is the most likely final answer).
 * @param {string} [stdout]
 * @returns {number|null}
 */
export function parseMatchedRows(stdout) {
  if (typeof stdout !== 'string') return null;
  const re = /matched rows:\s*(\d+)/gi;
  let match;
  let last = null;
  while ((match = re.exec(stdout)) !== null) last = match[1];
  return last === null ? null : Number(last);
}

// Normalize one language's raw result object into { state, count, error? }.
//   state: 'ok'      -> a numeric count was read (count is that number)
//          'error'   -> the run reported an error field (count null)
//          'unknown' -> it ran but no count could be read (count null)
//          'not-run' -> no result was supplied for this language (count null)
function langEntry(res, lang) {
  if (res === null || res === undefined) return { state: 'not-run', count: null };
  if (res.error !== null && res.error !== undefined && res.error !== '') {
    return { state: 'error', count: null, error: String(res.error) };
  }
  let count = null;
  if (lang === 'sql') {
    count = typeof res.rowCount === 'number' && Number.isFinite(res.rowCount) ? res.rowCount : null;
  } else {
    count = parseMatchedRows(res.stdout);
  }
  if (count === null) return { state: 'unknown', count: null };
  return { state: 'ok', count };
}

// A per-language note for any language that did NOT produce a comparable count,
// so mismatched/missing languages are called out explicitly rather than omitted.
function noteFor(lang, entry) {
  const label = LANG_LABELS[lang];
  if (entry.state === 'error') return `${label} errored (${entry.error}).`;
  if (entry.state === 'unknown') return `${label} ran but no row count could be read from its output.`;
  if (entry.state === 'not-run') return `${label} has not been run yet.`;
  return null;
}

// Build the grounded mismatch sentence from the actual observed counts.
function buildMismatchCore(languages, okLangs) {
  const byCount = new Map();
  for (const l of okLangs) {
    const c = languages[l].count;
    if (!byCount.has(c)) byCount.set(c, []);
    byCount.get(c).push(l);
  }
  const distinctCounts = [...byCount.keys()];

  // Odd-one-out: 3 languages ran, only 2 distinct counts, and exactly one
  // language sits alone against a matched majority. e.g.
  // "R returned 4,795 rows, 17 fewer than SQL and Python (4,812 each)."
  if (okLangs.length >= 3 && distinctCounts.length === 2) {
    let oddGroup = null;
    let majGroup = null;
    for (const ls of byCount.values()) {
      if (ls.length === 1) oddGroup = ls;
      else majGroup = ls;
    }
    if (oddGroup && majGroup && majGroup.length >= 2) {
      const oddLang = oddGroup[0];
      const oddCount = languages[oddLang].count;
      const majCount = languages[majGroup[0]].count;
      const diff = oddCount - majCount;
      const dir = diff < 0 ? 'fewer' : 'more';
      return `${LANG_LABELS[oddLang]} returned ${fmt(oddCount)} ${rowWord(oddCount)}, ` +
        `${fmt(Math.abs(diff))} ${dir} than ${joinAnd(majGroup.map((l) => LANG_LABELS[l]))} ` +
        `(${fmt(majCount)} each).`;
    }
  }

  // Two languages disagree.
  if (okLangs.length === 2) {
    const [a, b] = okLangs;
    const ca = languages[a].count;
    const cb = languages[b].count;
    return `${LANG_LABELS[a]} returned ${fmt(ca)} ${rowWord(ca)} but ${LANG_LABELS[b]} ` +
      `returned ${fmt(cb)} ${rowWord(cb)} (a difference of ${fmt(Math.abs(ca - cb))}).`;
  }

  // General case: three distinct counts — just state each one.
  const parts = okLangs.map((l) => `${LANG_LABELS[l]} returned ${fmt(languages[l].count)} ${rowWord(languages[l].count)}`);
  return `${joinAnd(parts)}.`;
}

/**
 * Compare the three languages' already-computed drill results. PURE: it reads
 * counts from the inputs and never runs anything.
 *
 * Each of `sql` / `python` / `r` is that language's own result object from
 * Batch 1's run* functions, or null/undefined if that language has not been run:
 *   sql:    { rowCount, result, error? }  (from runDrillSql)
 *   python: { stdout, result, error? }    (from runDrillPython)
 *   r:      { stdout, error? }            (from runDrillR)
 *
 * @param {{sql?:object, python?:object, r?:object}} results
 * @returns {{
 *   status: 'match'|'mismatch'|'incomplete',
 *   message: string,
 *   languages: {[lang:string]: {state:string, count:number|null, error?:string}},
 *   deltas?: Array<{pair:[string,string], diff:number}>
 * }}
 */
export function compareDrillResults({ sql, python, r } = {}) {
  const raw = { sql, python, r };
  const languages = {};
  for (const l of LANG_ORDER) languages[l] = langEntry(raw[l], l);

  const okLangs = LANG_ORDER.filter((l) => languages[l].state === 'ok');
  const notes = LANG_ORDER
    .filter((l) => languages[l].state !== 'ok')
    .map((l) => noteFor(l, languages[l]))
    .filter(Boolean);

  // Fewer than two comparable counts: nothing to compare yet.
  if (okLangs.length < 2) {
    const okStmts = okLangs.map(
      (l) => `${LANG_LABELS[l]} returned ${fmt(languages[l].count)} ${rowWord(languages[l].count)}.`,
    );
    const lead = okLangs.length === 0 ? 'No results to compare yet.' : 'Not enough results to compare yet.';
    const rest = [...okStmts, ...notes];
    return {
      status: 'incomplete',
      message: rest.length ? `${lead} ${rest.join(' ')}` : lead,
      languages,
    };
  }

  const counts = okLangs.map((l) => languages[l].count);
  const allEqual = counts.every((c) => c === counts[0]);

  if (allEqual) {
    const v = counts[0];
    const labels = okLangs.map((l) => LANG_LABELS[l]);
    const qualifier = labels.length === 2 ? 'both ' : 'all ';
    const core = `${joinAnd(labels)} ${qualifier}returned ${fmt(v)} ${rowWord(v)}.`;
    return {
      status: 'match',
      message: [core, ...notes].join(' '),
      languages,
    };
  }

  // Mismatch: compute pairwise deltas among the comparable languages.
  const deltas = [];
  for (const [a, b] of [['sql', 'python'], ['sql', 'r'], ['python', 'r']]) {
    if (languages[a].state === 'ok' && languages[b].state === 'ok') {
      deltas.push({ pair: [a, b], diff: Math.abs(languages[a].count - languages[b].count) });
    }
  }
  return {
    status: 'mismatch',
    message: [buildMismatchCore(languages, okLangs), ...notes].join(' '),
    languages,
    deltas,
  };
}

/**
 * Best-effort, CAVEAT-FLAGGED guess at WHY the languages diverged, matching a
 * SMALL set of known cross-language gotchas for THIS drill (the inclusive
 * BETWEEN join). Returns null when nothing in the known set fits — it NEVER
 * fabricates a cause.
 *
 * Known pattern (Batch 2): exactly one language sits BELOW a matched set of the
 * others by a SMALL margin. For a BETWEEN/date-range join the usual culprit is
 * an exclusive boundary comparison (`>`/`<` instead of `>=`/`<=`), which drops
 * the orders that land exactly on a promo's start_date or end_date.
 *
 * @param {object} diffSummary the object returned by compareDrillResults
 * @returns {{caveat:true, text:string}|null}
 */
export function suggestLikelyCause(diffSummary) {
  if (!diffSummary || diffSummary.status !== 'mismatch') return null;
  const languages = diffSummary.languages;
  if (!languages) return null;

  const ok = LANG_ORDER.filter((l) => languages[l] && languages[l].state === 'ok');
  if (ok.length < 2) return null;

  const counts = ok.map((l) => languages[l].count);
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  const diff = max - min;
  if (diff === 0) return null;

  const atMin = ok.filter((l) => languages[l].count === min);
  const atMax = ok.filter((l) => languages[l].count === max);
  // Only "one language low against a matched rest", and only when the gap is
  // small (<=10% of the larger count) — a boundary drop is a handful of rows,
  // not a blown-up cross join.
  const small = diff <= Math.max(1, Math.ceil(max * 0.1));
  if (atMin.length === 1 && atMax.length === ok.length - 1 && small) {
    const label = LANG_LABELS[atMin[0]];
    const otherWord = ok.length - 1 > 1 ? 'languages' : 'language';
    return {
      caveat: true,
      text:
        `${label} returned ${fmt(diff)} ${rowWord(diff)} fewer than the other ${otherWord}. ` +
        'A common cause is an exclusive boundary comparison (`>`/`<` instead of `>=`/`<=`), ' +
        "which drops orders whose date falls exactly on a promo's start_date or end_date. " +
        `This is only a likely cause, not a certainty — check the boundary conditions in the ${label} code.`,
    };
  }
  return null;
}
