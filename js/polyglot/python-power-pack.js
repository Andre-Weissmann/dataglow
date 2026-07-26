// ============================================================
// DATAGLOW - Python power pack: starter cells that already work
// ============================================================
//
// The Python notebook here starts empty, and an empty cell is the hardest thing
// in the product to face. It is not that people cannot write pandas. It is that
// the first cell has to know what the dataframe is called, how it got there, and
// what this particular Pyodide build actually has installed, and none of that is
// written anywhere near the cursor.
//
// So this is a small set of cells that run as written against the bridged
// dataframe, chosen for the first twenty minutes rather than for breadth.
//
// WHY THE ROW LIMIT IS ATTACHED TO THE RECIPES AND NOT TO A SETTINGS PAGE.
// The bridge that moves a table from DuckDB into pandas has a ceiling, and a
// person who does not know that will compute a mean over a truncated frame and
// get a number that is wrong in a way nothing looks wrong about. So the pack
// takes the real row count, compares it to the real limit, and returns a warning
// the surface can put next to the cells rather than three panels away.
//
// WHY NO PROFILING LIBRARY.
// The obvious move for a starter pack is to reach for one of the automatic
// dataframe-profiling packages. They are not in this Pyodide build, installing
// one is a multi-megabyte network fetch, and the output is a wall nobody reads.
// Four small cells that each answer one question beat one cell that answers
// forty.
//
// Pure data plus pure helpers. No DOM, no Pyodide, no network. Nothing here runs
// Python; it produces the text of cells.

export const PY_PACK_KIND = 'dataglow-python-power-pack';
export const PY_PACK_VERSION = 1;

/**
 * The default is the real bridge limit, kept as a parameter rather than a copy
 * so a test can pin it to the runtime that owns it.
 */
export const DEFAULT_PY_ROW_LIMIT = 200000;

export const PY_RUNTIME_LABEL = 'Pyodide 0.26.2, with pandas, numpy and matplotlib';

export const PY_HONESTY_NOTE =
  'This is CPython compiled to WebAssembly. Pure Python packages generally work; anything needing a compiled wheel that is not already in this build does not, and nothing here installs one for you.';

export const PY_NOT_AVAILABLE = Object.freeze([
  'Packages that are not already in this build. There is no pip install path that reaches the network here.',
  'Threads and subprocesses. It is one interpreter in one browser tab.',
  'Reading files from your disk directly. Data arrives through the bridge from a table you already loaded.',
  'Anything that needs a GPU. The model uses WebGPU; Python does not.',
]);

export const BRIDGE_VARIABLE = 'df';

/**
 * Starter cells.
 *
 * `answers` is the question the cell exists for, which is the thing a person is
 * actually scanning the list for. The code is second.
 */
export const PYTHON_RECIPES = Object.freeze([
  Object.freeze({
    id: 'shape-and-types',
    topic: 'First look',
    title: 'Shape, columns and types',
    answers: 'What did I actually load?',
    code: 'print(df.shape)\ndf.dtypes.to_frame("dtype")',
  }),
  Object.freeze({
    id: 'missingness',
    topic: 'First look',
    title: 'Missing values per column',
    answers: 'How much of this is empty, and where?',
    code: 'miss = df.isna().sum().to_frame("missing")\nmiss["pct"] = (100 * miss["missing"] / len(df)).round(2)\nmiss.sort_values("missing", ascending=False)',
  }),
  Object.freeze({
    id: 'value-counts',
    topic: 'First look',
    title: 'What is in a categorical column',
    answers: 'Is this column five clean categories or four hundred typos?',
    code: 'col = df.columns[0]\ndf[col].value_counts(dropna=False).head(20).to_frame("n")',
  }),
  Object.freeze({
    id: 'describe',
    topic: 'First look',
    title: 'Numeric summary',
    answers: 'What is the spread, and is there an impossible value in here?',
    code: 'df.describe(include="number").T',
  }),
  Object.freeze({
    id: 'duplicates',
    topic: 'Data quality',
    title: 'Duplicate rows and duplicate keys',
    answers: 'Is my key unique, and is the whole row repeated?',
    code: 'key = df.columns[0]\nprint("whole-row duplicates:", int(df.duplicated().sum()))\nprint("duplicate " + key + " values:", int(df[key].duplicated().sum()))\ndf[df.duplicated(subset=[key], keep=False)].sort_values(key).head(20)',
  }),
  Object.freeze({
    id: 'coerce-dates',
    topic: 'Data quality',
    title: 'Parse a date column and see what failed',
    answers: 'Which rows have a date my parser could not read?',
    code: 'col = "date"\nparsed = pd.to_datetime(df[col], errors="coerce")\nprint("unparsed:", int(parsed.isna().sum() - df[col].isna().sum()))\ndf.loc[parsed.isna() & df[col].notna(), [col]].head(20)',
  }),
  Object.freeze({
    id: 'coerce-numbers',
    topic: 'Data quality',
    title: 'Find the text hiding in a numeric column',
    answers: 'Why is my sum wrong?',
    code: 'col = df.columns[-1]\nnum = pd.to_numeric(df[col], errors="coerce")\nbad = df.loc[num.isna() & df[col].notna(), [col]]\nprint("non-numeric values:", len(bad))\nbad[col].value_counts().head(20).to_frame("n")',
  }),
  Object.freeze({
    id: 'merge-indicator',
    topic: 'Joins',
    title: 'Merge and count what matched',
    answers: 'How many rows found a partner, and how many quietly did not?',
    code: 'merged = df.merge(other, on="id", how="left", indicator=True)\nmerged["_merge"].value_counts().to_frame("rows")',
  }),
  Object.freeze({
    id: 'groupby-agg',
    topic: 'Aggregation',
    title: 'Group and aggregate several ways at once',
    answers: 'Total, average and count per category, in one table.',
    code: 'out = df.groupby("category").agg(\n    rows=("amount", "size"),\n    total=("amount", "sum"),\n    mean=("amount", "mean"),\n).sort_values("total", ascending=False)\nout.round(2)',
  }),
  Object.freeze({
    id: 'plot-bar',
    topic: 'Charts',
    title: 'One bar chart',
    answers: 'What does this look like?',
    code: 'import matplotlib.pyplot as plt\nax = df.groupby("category")["amount"].sum().sort_values().plot.barh()\nax.set_xlabel("amount")\nplt.tight_layout()\nplt.show()',
  }),
  Object.freeze({
    id: 'plot-hist',
    topic: 'Charts',
    title: 'Distribution of one numeric column',
    answers: 'Is this normal-ish, or is it three things stuck together?',
    code: 'import matplotlib.pyplot as plt\nax = df["amount"].plot.hist(bins=40)\nax.set_xlabel("amount")\nplt.tight_layout()\nplt.show()',
  }),
  Object.freeze({
    id: 'outliers',
    topic: 'Data quality',
    title: 'Rows well outside the middle',
    answers: 'Which values would move a mean on their own?',
    code: 'col = "amount"\nq1, q3 = df[col].quantile([0.25, 0.75])\nspan = q3 - q1\nmask = (df[col] < q1 - 1.5 * span) | (df[col] > q3 + 1.5 * span)\nprint("rows outside 1.5x the interquartile range:", int(mask.sum()))\ndf.loc[mask].head(20)',
  }),
  // ---- pythonShowdownPatterns (Bundle 17): two more original recipes for
  // shapes that come up constantly in timed practice-problem formats.
  // Original synthetic column names (order/claim style), matching the rest
  // of this pack; no third-party dataset names or branding.
  Object.freeze({
    id: 'groupby-first-last-after-filter',
    topic: 'Aggregation',
    title: 'First and last row per group, after a filter',
    answers: 'Of the rows that qualify, which one came first and which came last for each key?',
    code: 'sub = df[df["status"] == "finished"].sort_values("order_date")\nfirsts = sub.groupby("customer_id", as_index=False).first()\nlasts = sub.groupby("customer_id", as_index=False).last()\nfirsts.merge(lasts, on="customer_id", suffixes=("_first", "_last")).head(20)',
  }),
  Object.freeze({
    id: 'merge-user-level-summary',
    topic: 'Joins',
    title: 'Merge two tables, then summarize per key',
    answers: 'After joining orders to a lookup table, what does each customer look like in one row?',
    code: 'merged = df.merge(other, on="customer_id", how="left", indicator=True)\nsummary = merged.groupby("customer_id", as_index=False).agg(\n    orders=("order_id", "count"),\n    total_amount=("amount", "sum"),\n    matched=("_merge", lambda s: (s == "both").sum()),\n)\nsummary.sort_values("total_amount", ascending=False).head(20)',
  }),
]);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function count(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Distinct recipe topics, in first-seen order. */
export function recipeTopics() {
  const out = [];
  for (const r of PYTHON_RECIPES) {
    if (out.indexOf(r.topic) < 0) out.push(r.topic);
  }
  return out;
}

export function listRecipes(topic) {
  const t = str(topic);
  if (!t) return PYTHON_RECIPES.slice();
  return PYTHON_RECIPES.filter(r => r.topic === t);
}

/**
 * The bridge warning, computed rather than worded once and hoped over.
 *
 * A frame that was cut is the dangerous case and gets a sentence saying which
 * numbers are now wrong, not a generic notice about limits.
 */
export function bridgeTruncationNotice(rowCount, rowLimit) {
  const rows = count(rowCount);
  const limit = count(rowLimit) || DEFAULT_PY_ROW_LIMIT;
  const truncated = rows > limit;
  return {
    rows,
    limit,
    truncated,
    delivered: truncated ? limit : rows,
    headline: truncated
      ? 'Only the first ' + limit.toLocaleString('en-US') + ' rows of ' + rows.toLocaleString('en-US') + ' reached Python'
      : rows > 0
        ? 'All ' + rows.toLocaleString('en-US') + ' rows reached Python'
        : 'No table is bridged yet',
    detail: truncated
      ? 'Any total, mean or count computed in a cell below is a total, mean or count of the first ' + limit.toLocaleString('en-US') + ' rows and not of the table. Aggregate in SQL first if you need the whole thing.'
      : 'The frame in Python is the whole table, so an aggregate here and an aggregate in SQL should agree.',
  };
}

/**
 * @param {{rowCount?:number, rowLimit?:number, polarsAvailable?:boolean}} [input]
 */
export function buildPythonPowerPack(input) {
  const inp = isPlainObject(input) ? input : {};
  const notice = bridgeTruncationNotice(inp.rowCount, inp.rowLimit);
  return {
    kind: PY_PACK_KIND,
    version: PY_PACK_VERSION,
    runtime: PY_RUNTIME_LABEL,
    honesty: PY_HONESTY_NOTE,
    notAvailable: PY_NOT_AVAILABLE,
    frameVariable: BRIDGE_VARIABLE,
    recipes: PYTHON_RECIPES,
    topics: recipeTopics(),
    bridge: notice,
    // Polars is reported, never assumed. The scaffold that owns this answer is
    // js/polyglot/polars-path.js; this only passes the observation through.
    polars: inp.polarsAvailable === true
      ? 'This session can import polars, so a cell can use it directly. Nothing routes through it automatically.'
      : 'Polars is not importable in this session. Every recipe here is pandas and none of them need it.',
  };
}

export const DataGlowPythonPowerPack = {
  PY_PACK_KIND,
  PY_PACK_VERSION,
  DEFAULT_PY_ROW_LIMIT,
  PY_RUNTIME_LABEL,
  PY_HONESTY_NOTE,
  PY_NOT_AVAILABLE,
  BRIDGE_VARIABLE,
  PYTHON_RECIPES,
  recipeTopics,
  listRecipes,
  bridgeTruncationNotice,
  buildPythonPowerPack,
};

try {
  if (typeof window !== 'undefined') window.DataGlowPythonPowerPack = DataGlowPythonPowerPack;
} catch (_e) {}
