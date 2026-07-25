// ============================================================
// DATAGLOW - Python deepen: probing for packages instead of assuming
// ============================================================
//
// Bundle 11 shipped a Polars scaffold whose availability answer was a hard-coded
// `false` in the panel that displayed it. That was the honest answer at the time
// and it was honest for the wrong reason: nobody had asked. A constant that
// happens to be true is indistinguishable from a constant that has gone stale,
// and the second one is how a product ends up telling people a package is
// missing while it sits in the interpreter.
//
// So this file is a probe and the recipes that the probe unlocks. The probe is
// pure: it takes the result of an import attempt and turns it into a state. The
// caller runs the import, because running Python is not this module's job.
//
// WHY THE PROBE SNIPPET IS ONE LINE PER PACKAGE AND NOT A TRY BLOCK OVER ALL OF
// THEM. A single try that imports four packages reports the first failure and
// nothing about the other three, so a session with statsmodels but not sklearn
// looks identical to a session with neither.
//
// WHY THERE IS AN "IT IS NOT HERE, AND HERE IS WHY" PATH RATHER THAN A HIDDEN
// TAB. Pyodide can install a pure-Python wheel from PyPI at runtime, which means
// the honest sentence about polars is not "no" but "not loaded, and loading it
// is a download this build does not do for you, and under Air-Gap will not do at
// all". Hiding the recipes would make that a mystery instead of a decision.
//
// Pure data plus pure functions. No Pyodide handle, no DOM, no network.

export const PY_DEEPEN_KIND = 'dataglow-python-deepen';
export const PY_DEEPEN_VERSION = 1;

/** Packages this file has recipes for, beyond the ones the base build carries. */
export const PROBED_PACKAGES = Object.freeze(['polars', 'sklearn', 'statsmodels', 'pyarrow']);

/**
 * The cell that answers the question, run once per session.
 *
 * Emits one line per package so a partial answer is still a full answer about
 * the packages it covers.
 */
export const PROBE_CELL = [
  '# Ask the interpreter what it actually has. One line per package, so a',
  '# missing one does not hide the others.',
  'import importlib.util as _u',
  'for _name in [' + PROBED_PACKAGES.map(n => '"' + n + '"').join(', ') + ']:',
  '    print(_name, _u.find_spec(_name) is not None)',
].join('\n');

export const PY_DEEPEN_HONESTY =
  'Nothing here installs a package. The recipes for a package that is not loaded are shown with the reason rather than hidden, because a hidden recipe reads as a feature the product does not have.';

const MISSING_REASON = Object.freeze({
  polars:
    'polars is not loaded in this session. Pyodide can fetch a wheel at runtime, which is a download over the network, so this build does not do it for you and Air-Gap mode blocks it outright.',
  sklearn:
    'scikit-learn is not loaded in this session. It is a large compiled package and pulling it in doubles the size of what a first query has to wait for, so it is not in the default set.',
  statsmodels:
    'statsmodels is not loaded in this session. Same reason as scikit-learn: it is not free to load and most sessions never touch it.',
  pyarrow:
    'pyarrow is not loaded in this session, so the Arrow transfer path is unavailable and the bridge falls back to its JSON form.',
});

const ENABLE_HINT = Object.freeze({
  polars: 'To try it in a session that has network access: await micropip.install("polars") in a cell, then re-run the probe.',
  sklearn: 'To try it: await micropip.install("scikit-learn") in a cell. Expect a large download.',
  statsmodels: 'To try it: await micropip.install("statsmodels") in a cell. Expect a large download.',
  pyarrow: 'To try it: await micropip.install("pyarrow") in a cell, then re-run the probe.',
});

/**
 * Recipes grouped by the package they need.
 *
 * `needs: 'pandas'` is the base build and is always available, which is why the
 * base pack does not carry a needs field at all.
 */
export const PY_DEEPEN_RECIPES = Object.freeze([
  Object.freeze({
    id: 'polars-filter-group',
    needs: 'polars',
    topic: 'Polars',
    title: 'Filter, group and aggregate',
    answers: 'The group-by, in polars expressions rather than pandas indexing.',
    code: 'import polars as pl\n'
      + 'lf = pl.from_pandas(df).lazy()\n'
      + 'out = (\n'
      + '    lf.filter(pl.col("amount") > 0)\n'
      + '      .group_by("category")\n'
      + '      .agg([\n'
      + '          pl.len().alias("rows"),\n'
      + '          pl.col("amount").sum().alias("total"),\n'
      + '          pl.col("amount").mean().alias("mean"),\n'
      + '      ])\n'
      + '      .sort("total", descending=True)\n'
      + ')\n'
      + 'out.collect()',
  }),
  Object.freeze({
    id: 'polars-join',
    needs: 'polars',
    topic: 'Polars',
    title: 'Join and see what did not match',
    answers: 'How many rows found a partner, without a merge indicator column.',
    code: 'import polars as pl\n'
      + 'left = pl.from_pandas(df)\n'
      + 'right = pl.from_pandas(other)\n'
      + 'joined = left.join(right, on="id", how="left")\n'
      + 'print("left rows:", left.height, "joined rows:", joined.height)\n'
      + 'unmatched = left.join(right, on="id", how="anti")\n'
      + 'print("no match on the right:", unmatched.height)\n'
      + 'unmatched.head(10)',
  }),
  Object.freeze({
    id: 'polars-with-columns',
    needs: 'polars',
    topic: 'Polars',
    title: 'Derive several columns in one pass',
    answers: 'Chained transforms that read as steps instead of as nested assignments.',
    code: 'import polars as pl\n'
      + 'out = (\n'
      + '    pl.from_pandas(df)\n'
      + '      .with_columns([\n'
      + '          pl.col("amount").cast(pl.Float64).alias("amount"),\n'
      + '          (pl.col("amount") / pl.col("amount").sum().over("category")).alias("share_of_category"),\n'
      + '          pl.col("name").str.strip_chars().str.to_lowercase().alias("name_key"),\n'
      + '      ])\n'
      + ')\n'
      + 'out.head(10)',
  }),
  Object.freeze({
    id: 'polars-to-pandas',
    needs: 'polars',
    topic: 'Polars',
    title: 'Hand the result back to pandas',
    answers: 'Everything downstream in this page speaks pandas, so this is the exit door.',
    code: 'result = out.collect() if hasattr(out, "collect") else out\n'
      + 'df2 = result.to_pandas()\n'
      + 'df2.head()',
  }),
  Object.freeze({
    id: 'sklearn-baseline',
    needs: 'sklearn',
    topic: 'Models',
    title: 'A baseline before anything clever',
    answers: 'What score does predicting the mean get? Anything that does not beat this is not a model.',
    code: 'from sklearn.dummy import DummyRegressor\n'
      + 'from sklearn.model_selection import train_test_split\n'
      + 'from sklearn.metrics import mean_absolute_error\n'
      + 'X = df[["x1", "x2"]].fillna(0)\n'
      + 'y = df["target"]\n'
      + 'Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.25, random_state=0)\n'
      + 'base = DummyRegressor(strategy="mean").fit(Xtr, ytr)\n'
      + 'print("baseline MAE:", round(mean_absolute_error(yte, base.predict(Xte)), 4))',
  }),
  Object.freeze({
    id: 'sklearn-linear',
    needs: 'sklearn',
    topic: 'Models',
    title: 'Linear regression with a held-out score',
    answers: 'Fit on one part, score on another, so the number means something.',
    code: 'from sklearn.linear_model import LinearRegression\n'
      + 'from sklearn.metrics import mean_absolute_error, r2_score\n'
      + 'model = LinearRegression().fit(Xtr, ytr)\n'
      + 'pred = model.predict(Xte)\n'
      + 'print("MAE:", round(mean_absolute_error(yte, pred), 4))\n'
      + 'print("R2 :", round(r2_score(yte, pred), 4))\n'
      + 'dict(zip(X.columns, model.coef_.round(4)))',
  }),
  Object.freeze({
    id: 'statsmodels-ols',
    needs: 'statsmodels',
    topic: 'Models',
    title: 'OLS with confidence intervals',
    answers: 'The coefficients with an interval around them, which is the part a regression in a spreadsheet leaves out.',
    code: 'import statsmodels.formula.api as smf\n'
      + 'fit = smf.ols("target ~ x1 + x2", data=df).fit()\n'
      + 'print(fit.summary())\n'
      + 'fit.conf_int().rename(columns={0: "lo", 1: "hi"})',
  }),
  Object.freeze({
    id: 'statsmodels-seasonal',
    needs: 'statsmodels',
    topic: 'Models',
    title: 'Split a series into trend and season',
    answers: 'Is the rise real, or is it the same December it is every year?',
    code: 'from statsmodels.tsa.seasonal import STL\n'
      + 'series = df.set_index("date")["amount"].asfreq("MS").interpolate()\n'
      + 'res = STL(series, period=12).fit()\n'
      + 'res.plot()',
  }),
]);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Read a probe result into a fixed shape.
 *
 * Accepts an object of booleans, which is what the caller builds from the probe
 * cell's output. An absent key is `false`, not `unknown`, because a probe that
 * ran and did not mention a package did not find it.
 */
export function readProbe(observed) {
  const o = isPlainObject(observed) ? observed : {};
  const out = {};
  for (const name of PROBED_PACKAGES) out[name] = o[name] === true;
  return out;
}

/**
 * The honest availability answer for one package.
 *
 * @param {string} name
 * @param {{probed?:boolean, present?:boolean, airGap?:boolean}} [input]
 */
export function packageAvailability(name, input) {
  const inp = isPlainObject(input) ? input : {};
  const probed = inp.probed === true;
  const present = inp.present === true;
  const airGap = inp.airGap === true;

  // Unprobed is its own answer and is not the same as absent. Saying "missing"
  // about something nobody asked about is the bug this file was written to fix.
  const state = !probed ? 'unknown' : present ? 'available' : 'not_loaded';

  return {
    name,
    state,
    usable: state === 'available',
    reason: state === 'available'
      ? ''
      : state === 'unknown'
        ? 'Nobody has asked this session whether ' + name + ' is importable yet. Run the probe cell and the answer replaces this sentence.'
        : MISSING_REASON[name] || (name + ' is not loaded in this session.'),
    howToEnable: state === 'available'
      ? ''
      : airGap
        ? 'Air-Gap mode is on, so nothing can be fetched. Turn it off deliberately if you want to try installing this, and understand that installing is a network request.'
        : (ENABLE_HINT[name] || ''),
  };
}

/**
 * @param {{probed?:boolean, packages?:object, airGap?:boolean}} [input]
 */
export function buildPythonDeepen(input) {
  const inp = isPlainObject(input) ? input : {};
  const probed = inp.probed === true;
  const found = readProbe(inp.packages);
  const airGap = inp.airGap === true;

  const availability = {};
  for (const name of PROBED_PACKAGES) {
    availability[name] = packageAvailability(name, { probed, present: found[name], airGap });
  }

  const runnable = [];
  const blocked = [];
  for (const r of PY_DEEPEN_RECIPES) {
    const a = availability[r.needs];
    if (a && a.usable) runnable.push(r);
    else {
      blocked.push({
        id: r.id,
        title: r.title,
        needs: r.needs,
        reason: a ? a.reason : (r.needs + ' is not available in this session.'),
        howToEnable: a ? a.howToEnable : '',
      });
    }
  }

  const usableNames = PROBED_PACKAGES.filter(n => availability[n].usable);

  return {
    kind: PY_DEEPEN_KIND,
    version: PY_DEEPEN_VERSION,
    probed,
    airGap,
    probeCell: PROBE_CELL,
    honesty: PY_DEEPEN_HONESTY,
    availability,
    recipes: runnable,
    blocked,
    headline: !probed
      ? 'This session has not been probed. Run the probe cell once and every recipe below moves from "unknown" to either runnable or refused with a reason.'
      : usableNames.length
        ? 'Available beyond the base build: ' + usableNames.join(', ') + '.'
        : 'Nothing beyond pandas, numpy and matplotlib is loaded in this session, so every recipe below is listed with the reason it cannot run.',
  };
}

export const DataGlowPythonDeepen = {
  PY_DEEPEN_KIND,
  PY_DEEPEN_VERSION,
  PROBED_PACKAGES,
  PROBE_CELL,
  PY_DEEPEN_HONESTY,
  PY_DEEPEN_RECIPES,
  readProbe,
  packageAvailability,
  buildPythonDeepen,
};

try {
  if (typeof window !== 'undefined') window.DataGlowPythonDeepen = DataGlowPythonDeepen;
} catch (_e) {}
