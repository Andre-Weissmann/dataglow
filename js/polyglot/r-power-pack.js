// ============================================================
// DATAGLOW - R power pack: starter cells for R lite
// ============================================================
//
// The R here is WebR: real R, compiled to WebAssembly, with base R always
// present and two packages installed best-effort at startup. jsonlite carries
// the dataframe across the bridge and ggplot2 draws the nicer charts. Either can
// fail to install, and when one does, R keeps working with less.
//
// WHY EVERY RECIPE DECLARES WHAT IT NEEDS.
// A starter pack that hands someone a ggplot call on a session where ggplot2
// failed to install has produced an error message instead of a first result, and
// the person reasonably concludes R is broken here. Each recipe carries a
// `needs` field, the pack is filtered against what actually installed, and the
// ones that cannot run are listed separately with the reason rather than hidden.
// Hiding them would be its own lie: it would suggest base R is all there is.
//
// WHY THERE IS NO DPLYR.
// dplyr is not installed in this build and installing it in WebR pulls a large
// dependency tree over the network on a page whose whole claim is that it does
// not need one. So the recipes are base R, which is less pleasant to read and
// always available. That trade is stated rather than papered over.
//
// Pure data plus pure helpers. No DOM, no WebR, no network.

export const R_PACK_KIND = 'dataglow-r-power-pack';
export const R_PACK_VERSION = 1;

export const R_RUNTIME_LABEL = 'WebR, with base R always and jsonlite and ggplot2 installed best-effort';

export const R_HONESTY_NOTE =
  'This is R lite. Base R is fully here. Two packages are installed at startup if the network allows, and a session where one of them failed still runs R, with fewer recipes available.';

export const R_NOT_AVAILABLE = Object.freeze([
  'CRAN in general. Two packages are attempted at startup and nothing else is installed on demand.',
  'The tidyverse. dplyr and its dependencies are not in this build, so the recipes here are base R.',
  'Anything reading from your disk. Data arrives through the bridge from a table you already loaded.',
  'Long-running or parallel work. It is one R session in a browser tab.',
]);

export const R_BRIDGE_CALL = 'dataglow_get_df("your_table")';

export const R_CAPABILITIES = Object.freeze(['base', 'jsonlite', 'ggplot2']);

/**
 * Starter cells.
 *
 * `needs` is one of the capability ids above. Base means it runs on any session
 * that started at all.
 */
export const R_RECIPES = Object.freeze([
  Object.freeze({
    id: 'load-frame',
    topic: 'First look',
    title: 'Bring the table into R',
    answers: 'How do I get at the data at all?',
    needs: 'jsonlite',
    code: 'df <- dataglow_get_df("your_table")\ndim(df)',
  }),
  Object.freeze({
    id: 'structure',
    topic: 'First look',
    title: 'Structure and types',
    answers: 'What are the columns and what did R decide they are?',
    needs: 'base',
    code: 'str(df)',
  }),
  Object.freeze({
    id: 'summary',
    topic: 'First look',
    title: 'Summary of every column',
    answers: 'Range, median and how many are missing, in one call.',
    needs: 'base',
    code: 'summary(df)',
  }),
  Object.freeze({
    id: 'missingness',
    topic: 'Data quality',
    title: 'Missing values per column',
    answers: 'How much of this is empty, and where?',
    needs: 'base',
    code: 'na <- colSums(is.na(df))\ndata.frame(missing = na, pct = round(100 * na / nrow(df), 2))[order(-na), ]',
  }),
  Object.freeze({
    id: 'counts',
    topic: 'First look',
    title: 'Counts for a categorical column',
    answers: 'Is this five clean categories or four hundred typos?',
    needs: 'base',
    code: 'sort(table(df[[1]], useNA = "ifany"), decreasing = TRUE)[1:20]',
  }),
  Object.freeze({
    id: 'duplicates',
    topic: 'Data quality',
    title: 'Duplicate rows and duplicate keys',
    answers: 'Is my key unique?',
    needs: 'base',
    code: 'key <- names(df)[1]\ncat("whole-row duplicates:", sum(duplicated(df)), "\\n")\ncat("duplicate", key, "values:", sum(duplicated(df[[key]])), "\\n")',
  }),
  Object.freeze({
    id: 'aggregate',
    topic: 'Aggregation',
    title: 'Total and mean per group',
    answers: 'The group-by, in base R.',
    needs: 'base',
    code: 'agg <- aggregate(amount ~ category, data = df, FUN = function(x) c(n = length(x), total = sum(x), mean = mean(x)))\ndo.call(data.frame, agg)',
  }),
  Object.freeze({
    id: 'coerce-numbers',
    topic: 'Data quality',
    title: 'Find the text hiding in a numeric column',
    answers: 'Why is my sum wrong?',
    needs: 'base',
    code: 'raw <- df[["amount"]]\nnum <- suppressWarnings(as.numeric(as.character(raw)))\nbad <- unique(as.character(raw[is.na(num) & !is.na(raw)]))\ncat("non-numeric values:", length(bad), "\\n")\nhead(bad, 20)',
  }),
  Object.freeze({
    id: 'base-hist',
    topic: 'Charts',
    title: 'Distribution, in base R',
    answers: 'What does this column look like, without any package at all?',
    needs: 'base',
    code: 'hist(df$amount, breaks = 40, main = "amount", xlab = "amount")',
  }),
  Object.freeze({
    id: 'base-boxplot',
    topic: 'Charts',
    title: 'Spread per group, in base R',
    answers: 'Which category is the noisy one?',
    needs: 'base',
    code: 'boxplot(amount ~ category, data = df, las = 2, main = "amount by category")',
  }),
  Object.freeze({
    id: 'ggplot-bar',
    topic: 'Charts',
    title: 'Bar chart with ggplot2',
    answers: 'The chart you would put in front of someone.',
    needs: 'ggplot2',
    code: 'library(ggplot2)\nggplot(df, aes(x = reorder(category, amount), y = amount)) +\n  geom_col() +\n  coord_flip() +\n  labs(x = NULL, y = "amount")',
  }),
  Object.freeze({
    id: 'ggplot-scatter',
    topic: 'Charts',
    title: 'Two numeric columns against each other',
    answers: 'Is there a relationship, or is it a cloud?',
    needs: 'ggplot2',
    code: 'library(ggplot2)\nggplot(df, aes(x = x, y = y)) +\n  geom_point(alpha = 0.4) +\n  geom_smooth(method = "lm")',
  }),
]);

const NEEDS_REASON = Object.freeze({
  jsonlite: 'jsonlite did not install in this session, so the dataframe bridge is the simplified base-R one and this recipe cannot run as written.',
  ggplot2: 'ggplot2 did not install in this session. Base R plotting still works, and the base R chart recipes above are the ones to use.',
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** Distinct recipe topics, in first-seen order. */
export function recipeTopics() {
  const out = [];
  for (const r of R_RECIPES) {
    if (out.indexOf(r.topic) < 0) out.push(r.topic);
  }
  return out;
}

export function listRecipes(topic) {
  const t = str(topic);
  if (!t) return R_RECIPES.slice();
  return R_RECIPES.filter(r => r.topic === t);
}

/**
 * Split the recipes by what this session can actually run.
 *
 * @param {{hasJsonlite?:boolean, hasGgplot2?:boolean}} [input]
 */
export function buildRPowerPack(input) {
  const inp = isPlainObject(input) ? input : {};
  const has = {
    base: true,
    jsonlite: inp.hasJsonlite === true,
    ggplot2: inp.hasGgplot2 === true,
  };

  const available = [];
  const unavailable = [];
  for (const r of R_RECIPES) {
    if (has[r.needs]) available.push(r);
    else unavailable.push({ id: r.id, title: r.title, needs: r.needs, reason: NEEDS_REASON[r.needs] || '' });
  }

  const missing = R_CAPABILITIES.filter(c => !has[c]);

  return {
    kind: R_PACK_KIND,
    version: R_PACK_VERSION,
    runtime: R_RUNTIME_LABEL,
    honesty: R_HONESTY_NOTE,
    notAvailable: R_NOT_AVAILABLE,
    bridgeCall: R_BRIDGE_CALL,
    capabilities: has,
    missingCapabilities: missing,
    recipes: available,
    unavailable,
    topics: recipeTopics(),
    headline: missing.length === 0
      ? 'Base R, jsonlite and ggplot2 are all present in this session'
      : 'Base R is present. ' + missing.join(' and ') + ' did not install, so ' + unavailable.length
        + ' recipe' + (unavailable.length === 1 ? '' : 's') + ' cannot run here.',
  };
}

export const DataGlowRPowerPack = {
  R_PACK_KIND,
  R_PACK_VERSION,
  R_RUNTIME_LABEL,
  R_HONESTY_NOTE,
  R_NOT_AVAILABLE,
  R_BRIDGE_CALL,
  R_CAPABILITIES,
  R_RECIPES,
  recipeTopics,
  listRecipes,
  buildRPowerPack,
};

try {
  if (typeof window !== 'undefined') window.DataGlowRPowerPack = DataGlowRPowerPack;
} catch (_e) {}
