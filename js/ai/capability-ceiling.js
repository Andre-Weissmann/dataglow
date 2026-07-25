// ============================================================
// DATAGLOW - Honest capability ceiling
// ============================================================
//
// Every tool that runs SQL says it runs SQL, and every one of them means a
// different SQL. Every tool that reads spreadsheets implies it reads yours.
// The gap between what a person hears and what the software does is where
// trust goes, and it goes quietly: nobody files a bug saying "your claim was
// broader than your product", they just stop believing the next claim too.
//
// This module is the ceiling written down. For each runtime it states what
// actually ships, and then, in a separate field that cannot be skimmed past,
// what it does not do. The `notThis` line is the load-bearing one. A features
// list with no ceiling is a marketing page; the ceiling is what makes the
// features believable.
//
// WHY THE NUMBERS ARE PASSED IN AND NOT WRITTEN HERE.
// The Python bridge truncates at PY_BRIDGE_ROW_LIMIT, which lives in
// js/runtimes-viz/python-runtime.js. Copying 200000 into this file would create
// a second place for it to be true, and the copy would go stale the first time
// someone tuned the real one, at which point this module would be confidently
// telling users a limit the product no longer has. So the limit is a parameter
// with a documented default, and a test reads the real constant and asserts the
// default still matches it.
//
// WHY "MESSY DATA" IS SPLIT IN TWO.
// DataGlow is good at a messy file: merged cells, a title row above the header,
// numbers stored as text, three date formats in one column. It is not a tool
// for a messy data estate: forty spreadsheets that disagree about what a
// customer is. Those are different problems and only one of them is solved
// here. Blurring them is the single easiest way for this product to overpromise,
// because both get called "messy data" in the same sentence by the same person.
//
// Pure. No DOM, no network, no runtime probing.

export const CAPABILITY_CEILING_KIND = 'dataglow-capability-ceiling';
export const CAPABILITY_CEILING_VERSION = 1;

/** Matches PY_BRIDGE_ROW_LIMIT in js/runtimes-viz/python-runtime.js. A test
 *  pins the two together so this cannot quietly go stale. */
export const DEFAULT_PY_BRIDGE_ROW_LIMIT = 200000;

/** The R tab bridges rows through the same kind of LIMIT clause. */
export const DEFAULT_R_BRIDGE_ROW_LIMIT = 200000;

export const CEILING_PREAMBLE =
  'This is what this machine can actually do today. It is written down so a claim in a portfolio or a meeting can be checked against it rather than guessed at.';

export const CEILING_CLOSING =
  'Where a limit here is inconvenient, it is still the limit. A tool that quietly does less than it says is worse than one that says less.';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v, fallback) {
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : fallback;
}

/** Verbatim from POWER_QUERY_NOTE in js/polyglot/power-query-note.js. */
export const POWER_QUERY_CEILING_NOTE =
  'Power Query M is not embedded. DataGlow covers reshape and clean via Excel Hell plus DuckDB SQL plus Python and R. For M-only enterprise workbooks, export remains the hand-off.';

function group(id, title, does, notThis, detail) {
  return { id, title, does, notThis, detail };
}

/**
 * The ceiling, as data.
 *
 * @param {{pyBridgeRowLimit?:number, rBridgeRowLimit?:number, platform?:string}} [opts]
 */
export function buildCapabilityCeiling(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const pyLimit = num(o.pyBridgeRowLimit, DEFAULT_PY_BRIDGE_ROW_LIMIT);
  const rLimit = num(o.rBridgeRowLimit, DEFAULT_R_BRIDGE_ROW_LIMIT);
  const platform = typeof o.platform === 'string' && o.platform ? o.platform : 'web';
  const desktop = platform === 'desktop';

  const groups = [
    group(
      'sql',
      'SQL',
      'Real DuckDB running as WebAssembly in this tab. Joins, window functions, CTEs, aggregates and the rest of the DuckDB dialect, over the data you loaded, with the query text always visible before it runs.',
      'It is not every warehouse dialect. A query written for BigQuery, Snowflake, Redshift or T-SQL may use functions DuckDB does not have, and it will fail rather than silently do something close to it.',
      'DuckDB was chosen because it is the only serious analytical engine that runs entirely in a browser tab with no server. That choice is also the limit: the dialect is the DuckDB one. Generated SQL is shown before it runs precisely so a dialect mismatch is something you see rather than something you discover from a wrong number.',
    ),
    group(
      'python',
      'Python',
      'Real CPython through Pyodide, in the browser, with pandas and numpy available. Multi-cell notebooks, charts, and a bridge that hands your loaded tables to Python as dataframes.',
      'It is not an unbounded Python environment. The bridge passes at most ' + pyLimit.toLocaleString('en-US') + ' rows per table, and any package that needs to compile native code outside what Pyodide already ships is not installable here.',
      'The row limit is real and it truncates rather than fails, which is the dangerous kind of limit, so the truncation is reported rather than left for you to notice in a total that looks slightly wrong. Anything above that ceiling should be aggregated in SQL first and handed to Python already small.',
    ),
    group(
      'r',
      'R',
      'Real R through WebR, in the browser, with base R and a small set of installed packages. Enough for a summary, a model fit and base or ggplot2 graphics.',
      'It is not CRAN. WebR ships base R and packages must be installed explicitly into the session, so most of CRAN is simply not reachable. The same ' + rLimit.toLocaleString('en-US') + ' row bridge limit applies.',
      'This is the lightest of the three runtimes and it is described as notebooks-lite rather than as an R environment on purpose. If an analysis needs a specific CRAN package, this is not where it runs.',
    ),
    group(
      'excel',
      'Excel and messy files',
      'Excel Hell Repair detects the specific ways a spreadsheet is broken: merged cells, a title above the real header, numbers stored as text, several date formats in one column, totals rows mixed in with data. It previews the repair, applies it only when you confirm, and it can be undone.',
      'It is not a spreadsheet application and it does not read VBA, macros, pivot caches or cell formulas. It repairs the data in the file, not the workbook as a program.',
      'Every repair is a recipe you can inspect, save and reapply to the file you get next month, which is the part that actually saves time. Nothing is repaired silently: the preview names what changes and what it destroys before you agree to it.',
    ),
    group(
      'size',
      'How much data',
      desktop
        ? 'The desktop build has the whole machine to work with, so the practical ceiling is disk and RAM rather than a browser tab.'
        : 'Comfortable through the low millions of rows in a browser tab, depending on column count, types and how much memory the browser will give this page.',
      'There is no "any size". A browser tab has a memory ceiling, WebAssembly has its own, and a file large enough to cross either will fail or crawl. Nothing here streams from a warehouse you have not loaded.',
      'The honest number is not a number, because it depends on the shape of the data and the machine. What can be promised is that it fails visibly rather than producing a partial answer that looks whole.',
    ),
    group(
      'messy',
      'Messy data, in the sense that is actually meant',
      'A messy file is solved here: detect, preview, confirm, repair, save the recipe, reapply it next month, and keep a record of what was changed.',
      'A messy data estate is not solved here. Forty files that disagree about what a customer is, no shared key, and no owner is an organisational problem, and no local tool fixes it.',
      'Both get called messy data in the same breath, and conflating them is the fastest way for this product to promise something it cannot do. The relational checks can tell you two tables disagree; they cannot tell you which one the business meant.',
    ),
    group(
      'privacy',
      'Privacy and compliance',
      'Nothing is uploaded. Analysis, the model, the exports and the receipts all run on this machine, and Air-Gap Mode can hard-block network paths for a session.',
      'It is not a certification of anything. The Safe Harbor screen is an automated screening aid, not a HIPAA certification and not a safe-to-release judgement, and no output here is audited or endorsed by anyone.',
      'Local execution is a strong privacy property and a weak compliance one. It removes an entire class of risk, which is worth saying plainly, and it substitutes for no review that your organisation requires.',
    ),
  ];

  // The Power Query gap, named before someone finds it.
  //
  // The sentence is duplicated from js/polyglot/power-query-note.js rather than
  // imported, because this module is inlined into the canvas by a script that
  // does not rewrite imports for it. A test asserts the two strings are
  // identical, so the copy cannot drift from the original.
  if (o.powerQueryNote !== false) {
    groups.splice(4, 0, group(
      'power-query',
      'Power Query',
      'Reshape and clean the same data through Excel Hell Repair, DuckDB SQL, Python and R.',
      'Run your Power Query M steps. The M runtime is not embedded and there is no plan for it to be.',
      POWER_QUERY_CEILING_NOTE + ' M is a language with its own runtime and a connector library that reaches databases and services. None of that is here, and building a partial copy of it would produce something that runs some steps and silently skips others, which is worse than not having it.',
    ));
  }

  return {
    kind: CAPABILITY_CEILING_KIND,
    version: CAPABILITY_CEILING_VERSION,
    platform,
    preamble: CEILING_PREAMBLE,
    groups,
    closing: CEILING_CLOSING,
    limits: { pyBridgeRowLimit: pyLimit, rBridgeRowLimit: rLimit },
  };
}

/** Markdown, for a person who wants to paste the ceiling into a portfolio page
 *  rather than screenshot a panel. */
export function renderCeilingMarkdown(ceiling) {
  const c = isPlainObject(ceiling) ? ceiling : buildCapabilityCeiling();
  const out = ['## What this machine can do', '', c.preamble, ''];
  for (const g of c.groups) {
    out.push('### ' + g.title, '');
    out.push('**It does:** ' + g.does, '');
    out.push('**It does not:** ' + g.notThis, '');
    if (g.detail) out.push(g.detail, '');
  }
  out.push('---', '', c.closing, '');
  return out.join('\n');
}

export const DataGlowCapabilityCeiling = {
  CAPABILITY_CEILING_KIND,
  CAPABILITY_CEILING_VERSION,
  DEFAULT_PY_BRIDGE_ROW_LIMIT,
  DEFAULT_R_BRIDGE_ROW_LIMIT,
  CEILING_PREAMBLE,
  CEILING_CLOSING,
  POWER_QUERY_CEILING_NOTE,
  buildCapabilityCeiling,
  renderCeilingMarkdown,
};

try {
  if (typeof window !== 'undefined') window.DataGlowCapabilityCeiling = DataGlowCapabilityCeiling;
} catch (_e) {}
