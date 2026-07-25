// ============================================================
// DATAGLOW - Project lanes: "can I do a whole project here?", answered per lane
// ============================================================
//
// The polyglot surfaces (SQL, Python, R) and the Excel repair path each read
// as a competent tool in isolation, and nothing in the product ever answers
// the question someone actually has before starting: can I do the whole
// project in here, or am I going to hit a wall at step six and have to start
// over somewhere else? This module answers that question once per lane,
// honestly, instead of leaving it to be discovered.
//
// WHY EVERY CARD NAMES A HAND-OFF.
// "Yes for X, no false claim of everything" is only useful if the boundary is
// specific enough to plan around. Each lane below names the concrete point
// where DataGlow is no longer the right tool and where to go instead, because
// a limit without a next step is just a warning.
//
// WHAT THIS NEVER SAYS.
// It never says "yes, any project". A project that needs a CRAN package
// webR does not ship, a native Python wheel Pyodide cannot build, or Excel
// VBA and Power Pivot is a project this product hands off on, and the card
// for that lane says so before someone spends an afternoon finding out.
//
// Pure data plus pure selectors. No DOM, no engine, no network.

export const PROJECT_LANES_KIND = 'dataglow-project-lanes';
export const PROJECT_LANES_VERSION = 1;

export const PROJECT_LANES = Object.freeze([
  Object.freeze({
    id: 'sql',
    label: 'SQL',
    canDoWholeProject: true,
    yesFor: 'Load, profile, transform, join, aggregate, and export, end to end, for a file or a handful of files that fit in one browser tab.',
    stayWhen: 'The work is shaping and answering questions about tabular data you already have loaded: joins, group-bys, window functions, reshaping, dedup, the PQ-parity recipes.',
    handOffWhen: 'You need a warehouse-scale dataset, a dialect DuckDB does not speak (stored procedures, triggers), or a scheduled/production pipeline rather than a one-off analysis.',
    handOffTo: 'Your actual warehouse (Snowflake, Databricks, Postgres) or an orchestrator, once the shape of the query is proven here.',
    limits: Object.freeze(['DuckDB dialect, not Postgres or your warehouse\'s dialect verbatim', 'No stored procedures, triggers, or scheduled jobs', 'No CRAN-depth statistics; that is R\'s lane']),
    recipesLink: 'pq-parity-recipes',
  }),
  Object.freeze({
    id: 'python',
    label: 'Python',
    canDoWholeProject: true,
    yesFor: 'pandas/polars-style wrangling, plotting, and sklearn-lite modeling on a table that already crossed the DuckDB-to-Python bridge.',
    stayWhen: 'The work is a wrangling or lightweight modeling pass on a table this session already loaded, and the row count fits under the bridge\'s limit.',
    handOffWhen: 'The dataset is bigger than the bridge will carry, or the project needs a native wheel Pyodide cannot build (most GPU-backed and many compiled packages), or a training run that needs real hardware.',
    handOffTo: 'A real Python environment (local venv, a notebook service, a training cluster) once the approach is validated here on a sample.',
    limits: Object.freeze(['Row count capped by the DuckDB-to-Python bridge (see Arrow bridge status)', 'No native wheels Pyodide has not built; pure-Python and the pinned scientific stack only', 'No GPU, no multi-hour training run']),
    recipesLink: 'python-power-pack',
  }),
  Object.freeze({
    id: 'excel',
    label: 'Excel',
    canDoWholeProject: false,
    yesFor: 'Messy file repair (headers, types, split columns, duplicates), a working grid view, and export back to a clean file.',
    stayWhen: 'The problem is "this spreadsheet is a mess and I need clean data out of it," not "I need to keep authoring in Excel."',
    handOffWhen: 'The workbook depends on VBA macros, Power Pivot data models, or formulas that have to keep working after export.',
    handOffTo: 'Microsoft Excel itself, for anything that has to remain a living, formula-driven, macro-capable workbook.',
    limits: Object.freeze(['Not a VBA runtime; macros are never evaluated', 'Not a Power Pivot replacement; no in-workbook data model', 'Password-protected workbooks are not read']),
    recipesLink: 'pq-parity-recipes',
  }),
  Object.freeze({
    id: 'r',
    label: 'R',
    canDoWholeProject: false,
    yesFor: 'Tidy summary and plot recipes available in webR: base R, and dplyr/tidyr/ggplot2/jsonlite when the session actually has them installed.',
    stayWhen: 'The task is a summary table or a standard plot from a tidy data frame, using packages this session already probed as installed.',
    handOffWhen: 'The project needs a CRAN package outside the small pinned set, a statistical model with real depth (mixed effects, survival analysis, Bayesian fitting), or a package with compiled dependencies webR cannot build in-browser.',
    handOffTo: 'Local R or RStudio, or a hosted R environment, for full CRAN access and heavier statistical modeling.',
    limits: Object.freeze(['Not full CRAN; only the packages this session actually probed as installed', 'Air-Gap Mode or offline blocks any install attempt, honestly, rather than silently degrading', 'No heavy/compiled statistical packages beyond the pinned tidy set']),
    recipesLink: 'r-power-pack',
  }),
]);

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** One lane by id, or null. */
export function findLane(id) {
  const i = str(id);
  return PROJECT_LANES.filter((l) => l.id === i)[0] || null;
}

/** All lanes, or only the ones that can carry a whole project unaided. */
export function listLanes(onlyFullProject) {
  if (onlyFullProject === true) return PROJECT_LANES.filter((l) => l.canDoWholeProject);
  return PROJECT_LANES.slice();
}

export function buildProjectLanes() {
  return {
    kind: PROJECT_LANES_KIND,
    version: PROJECT_LANES_VERSION,
    lanes: PROJECT_LANES,
    headline: 'Four honest answers to "can I do a whole project here", not one blanket yes.',
    neverClaims: 'None of these cards says "any project". Each names the concrete point it hands off, and to what.',
  };
}

export const DataGlowProjectLanes = {
  PROJECT_LANES_KIND,
  PROJECT_LANES_VERSION,
  PROJECT_LANES,
  findLane,
  listLanes,
  buildProjectLanes,
};

try {
  if (typeof window !== 'undefined') window.DataGlowProjectLanes = DataGlowProjectLanes;
} catch (_e) {}
