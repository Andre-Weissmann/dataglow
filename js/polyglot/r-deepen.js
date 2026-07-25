// ============================================================
// DATAGLOW - R deepen: dplyr and ggplot, and what happens when they are not here
// ============================================================
//
// The R session in this page is WebR. Base R is complete. Everything past base R
// is a package that has to be fetched from the WebR binary repository at
// startup, over the network, which means three things that the existing pack
// only says one of.
//
// The first: a session with no network has base R and nothing else, and every
// dplyr recipe in a list is a recipe that errors. The pack already handles this
// by splitting available from unavailable.
//
// The second, and the one this file is really about: **Air-Gap mode did not stop
// the fetch.** The R runtime called installPackages at startup with no check
// against the air-gap flag anywhere in it. A mode whose entire promise is that
// nothing leaves the machine was making two package requests on the way up. The
// guard for that is in this module as a pure decision function, and the runtime
// asks it before it calls.
//
// The third: dplyr is not in the two packages the runtime tries. It is a much
// larger dependency tree and this build does not pull it. So the dplyr recipes
// here are honest about being for a session that installed it deliberately, and
// every one of them is paired with the base R form that always works. A recipe
// list that only works if you already solved the hard part is decoration.
//
// WHY NO CRAN CLAIM.
// WebR serves a subset of CRAN compiled to WebAssembly. It is a large subset and
// it is not CRAN, and a package that is not in it cannot be installed at all,
// not slowly. Saying "install any package" would be false in a way someone finds
// out ten minutes in.
//
// Pure. No WebR handle, no DOM, no network.

export const R_DEEPEN_KIND = 'dataglow-r-deepen';
export const R_DEEPEN_VERSION = 1;

/** Packages the runtime attempts at startup, plus the ones a person might add. */
export const R_STARTUP_PACKAGES = Object.freeze(['jsonlite', 'ggplot2']);
export const R_OPTIONAL_PACKAGES = Object.freeze(['dplyr', 'tidyr']);

export const R_DEEPEN_HONESTY =
  'WebR serves a subset of CRAN compiled to WebAssembly. It is a large subset and it is not CRAN. A package outside it cannot be installed here at all, and every install is a network request.';

export const AIR_GAP_BLOCK_REASON =
  'Air-Gap mode is on. Installing an R package is a network request to the WebR repository, so it is blocked. Base R is complete and the base R recipes below all run.';

/**
 * The one decision the R runtime has to make before it calls installPackages.
 *
 * Pure so it can be asserted without a browser, and separate from the runtime so
 * the runtime's job stays "run R" rather than "know about product modes".
 *
 * @param {{airGap?:boolean, offline?:boolean, packages?:Array<string>}} [input]
 */
export function packageInstallDecision(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const packages = Array.isArray(inp.packages) ? inp.packages.slice() : R_STARTUP_PACKAGES.slice();

  if (inp.airGap === true) {
    return {
      kind: R_DEEPEN_KIND,
      allowed: false,
      blockedBy: 'air_gap',
      packages,
      reason: AIR_GAP_BLOCK_REASON,
      // Not an error. The session still starts and base R is fully there.
      degradesTo: 'Base R only. The dataframe bridge uses its base R form and plotting uses the base graphics device.',
    };
  }
  if (inp.offline === true) {
    return {
      kind: R_DEEPEN_KIND,
      allowed: false,
      blockedBy: 'offline',
      packages,
      reason: 'This page reports no network connection, so a package fetch would fail rather than hang. Base R is complete and starts either way.',
      degradesTo: 'Base R only, until the connection returns and the session is restarted.',
    };
  }
  return {
    kind: R_DEEPEN_KIND,
    allowed: true,
    blockedBy: '',
    packages,
    reason: 'Fetching ' + packages.join(' and ') + ' from the WebR repository. This is a network request and it is the only one the R session makes.',
    degradesTo: 'If the fetch fails the session still starts with base R, and the recipes needing a missing package are listed as unavailable rather than hidden.',
  };
}

/**
 * Recipes.
 *
 * `needs` is a package name or 'base'. `baseAlternative` is the id of the base R
 * recipe that answers the same question, so a session without the package is
 * pointed somewhere rather than told no.
 */
export const R_DEEPEN_RECIPES = Object.freeze([
  Object.freeze({
    id: 'dplyr-verbs',
    needs: 'dplyr',
    topic: 'Aggregation',
    title: 'filter, group_by, summarise, arrange',
    answers: 'The four verbs, in the order they are almost always written.',
    baseAlternative: 'base-aggregate',
    code: 'library(dplyr)\n'
      + 'df %>%\n'
      + '  filter(!is.na(amount), amount > 0) %>%\n'
      + '  group_by(category) %>%\n'
      + '  summarise(rows = n(), total = sum(amount), mean = mean(amount), .groups = "drop") %>%\n'
      + '  arrange(desc(total))',
  }),
  Object.freeze({
    id: 'dplyr-mutate',
    needs: 'dplyr',
    topic: 'Aggregation',
    title: 'mutate with a window over the group',
    answers: 'Each row as a share of its group, without a second pass.',
    baseAlternative: 'base-share',
    code: 'library(dplyr)\n'
      + 'df %>%\n'
      + '  group_by(category) %>%\n'
      + '  mutate(share = round(100 * amount / sum(amount, na.rm = TRUE), 2)) %>%\n'
      + '  ungroup() %>%\n'
      + '  arrange(category, desc(share))',
  }),
  Object.freeze({
    id: 'dplyr-join',
    needs: 'dplyr',
    topic: 'Joins',
    title: 'left_join and count what did not match',
    answers: 'How many rows found a partner and how many quietly did not.',
    baseAlternative: 'base-merge',
    code: 'library(dplyr)\n'
      + 'joined <- left_join(df, other, by = "id")\n'
      + 'cat("left rows:", nrow(df), " joined rows:", nrow(joined), "\\n")\n'
      + 'anti_join(df, other, by = "id")',
  }),
  Object.freeze({
    id: 'base-aggregate',
    needs: 'base',
    topic: 'Aggregation',
    title: 'The same group-by, in base R',
    answers: 'Total, mean and count per category with no package at all.',
    code: 'agg <- aggregate(amount ~ category, data = df,\n'
      + '                 FUN = function(x) c(rows = length(x), total = sum(x), mean = mean(x)))\n'
      + 'out <- do.call(data.frame, agg)\n'
      + 'out[order(-out$amount.total), ]',
  }),
  Object.freeze({
    id: 'base-share',
    needs: 'base',
    topic: 'Aggregation',
    title: 'Share of group, in base R',
    answers: 'The same percentage column, using ave().',
    code: 'df$share <- round(100 * df$amount / ave(df$amount, df$category, FUN = function(x) sum(x, na.rm = TRUE)), 2)\n'
      + 'head(df[order(df$category, -df$share), ], 20)',
  }),
  Object.freeze({
    id: 'base-merge',
    needs: 'base',
    topic: 'Joins',
    title: 'The same join, in base R',
    answers: 'merge() with all.x, and the unmatched rows counted.',
    code: 'joined <- merge(df, other, by = "id", all.x = TRUE)\n'
      + 'cat("left rows:", nrow(df), " joined rows:", nrow(joined), "\\n")\n'
      + 'df[!(df$id %in% other$id), ]',
  }),
  Object.freeze({
    id: 'base-summary-table',
    needs: 'base',
    topic: 'First look',
    title: 'A summary table you can read',
    answers: 'summary() is wide and hard to scan. This is the same content as a data frame.',
    code: 'num <- df[sapply(df, is.numeric)]\n'
      + 'data.frame(\n'
      + '  column = names(num),\n'
      + '  missing = sapply(num, function(x) sum(is.na(x))),\n'
      + '  min = sapply(num, function(x) min(x, na.rm = TRUE)),\n'
      + '  median = sapply(num, function(x) median(x, na.rm = TRUE)),\n'
      + '  mean = round(sapply(num, function(x) mean(x, na.rm = TRUE)), 3),\n'
      + '  max = sapply(num, function(x) max(x, na.rm = TRUE)),\n'
      + '  row.names = NULL\n'
      + ')',
  }),
  Object.freeze({
    id: 'base-crosstab',
    needs: 'base',
    topic: 'First look',
    title: 'Cross-tabulate two columns',
    answers: 'The contingency table, with margins, in one call.',
    code: 'tab <- table(df$category, df$region, useNA = "ifany")\n'
      + 'addmargins(tab)',
  }),
  Object.freeze({
    id: 'ggplot-skeleton',
    needs: 'ggplot2',
    topic: 'Charts',
    title: 'The ggplot skeleton, with every slot named',
    answers: 'The grammar written out once, so the next chart is an edit rather than a search.',
    baseAlternative: 'base-summary-table',
    code: 'library(ggplot2)\n'
      + 'ggplot(df, aes(x = category, y = amount)) +   # data and the mapping\n'
      + '  geom_col() +                                # the layer\n'
      + '  facet_wrap(~ region) +                      # small multiples, optional\n'
      + '  scale_y_continuous(labels = scales::comma) +\n'
      + '  coord_flip() +\n'
      + '  labs(title = "amount by category", x = NULL, y = "amount") +\n'
      + '  theme_minimal()',
  }),
  Object.freeze({
    id: 'ggplot-timeseries',
    needs: 'ggplot2',
    topic: 'Charts',
    title: 'A line over time with the gaps visible',
    answers: 'A line chart that does not join across a month with no data.',
    code: 'library(ggplot2)\n'
      + 'ggplot(df, aes(x = as.Date(date), y = amount)) +\n'
      + '  geom_line() +\n'
      + '  geom_point(size = 0.8) +\n'
      + '  labs(x = NULL, y = "amount") +\n'
      + '  theme_minimal()',
  }),
]);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function recipeById(id) {
  for (const r of R_DEEPEN_RECIPES) if (r.id === id) return r;
  return null;
}

/**
 * @param {{hasJsonlite?:boolean, hasGgplot2?:boolean, hasDplyr?:boolean,
 *          hasTidyr?:boolean, airGap?:boolean, offline?:boolean}} [input]
 */
export function buildRDeepen(input) {
  const inp = isPlainObject(input) ? input : {};
  const has = {
    base: true,
    jsonlite: inp.hasJsonlite === true,
    ggplot2: inp.hasGgplot2 === true,
    dplyr: inp.hasDplyr === true,
    tidyr: inp.hasTidyr === true,
  };
  const decision = packageInstallDecision({ airGap: inp.airGap, offline: inp.offline });

  const runnable = [];
  const blocked = [];
  for (const r of R_DEEPEN_RECIPES) {
    if (has[r.needs]) { runnable.push(r); continue; }
    const alt = r.baseAlternative ? recipeById(r.baseAlternative) : null;
    blocked.push({
      id: r.id,
      title: r.title,
      needs: r.needs,
      reason: decision.allowed
        ? r.needs + ' is not loaded in this session. It is not one of the two packages the runtime installs at startup, so it would have to be installed deliberately.'
        : decision.reason,
      // Never a dead end. Every blocked recipe that has a base R equivalent
      // points at it by name.
      instead: alt ? { id: alt.id, title: alt.title } : null,
      howToEnable: decision.allowed
        ? 'In a cell: webr::install("' + r.needs + '") if the WebR repository carries it. This is a network request.'
        : '',
    });
  }

  return {
    kind: R_DEEPEN_KIND,
    version: R_DEEPEN_VERSION,
    honesty: R_DEEPEN_HONESTY,
    capabilities: has,
    install: decision,
    recipes: runnable,
    blocked,
    airGapBlocksInstall: decision.blockedBy === 'air_gap',
    headline: decision.allowed
      ? 'Base R is here. ' + (blocked.length
          ? blocked.length + ' recipe' + (blocked.length === 1 ? '' : 's') + ' need a package this session does not have, and each one names the base R form that does the same job.'
          : 'Every package these recipes need is loaded.')
      : AIR_GAP_BLOCK_REASON,
  };
}

export const DataGlowRDeepen = {
  R_DEEPEN_KIND,
  R_DEEPEN_VERSION,
  R_STARTUP_PACKAGES,
  R_OPTIONAL_PACKAGES,
  R_DEEPEN_HONESTY,
  AIR_GAP_BLOCK_REASON,
  R_DEEPEN_RECIPES,
  packageInstallDecision,
  buildRDeepen,
};

try {
  if (typeof window !== 'undefined') window.DataGlowRDeepen = DataGlowRDeepen;
} catch (_e) {}
