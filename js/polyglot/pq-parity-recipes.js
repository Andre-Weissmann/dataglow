// ============================================================
// DATAGLOW - PQ-parity recipes: the Power Query transforms, in DuckDB SQL
// ============================================================
//
// Power Query's step list covers a small, well-known set of shapes: promote
// headers, change type, fill down, split a column, merge two queries, append
// queries, group and aggregate, unpivot, pivot, remove duplicates, replace
// values. Almost none of it is special to M; it is SQL wearing a different
// syntax. This module writes the DuckDB SQL for each shape as an insertable
// template, so the honest answer to "does this have Power Query" is a
// concrete list of what runs today, in a language DataGlow actually embeds.
//
// WHY THIS IS TEMPLATES, NOT A TRANSPILER.
// A transpiler that reads M and emits SQL has to track M's evaluation
// semantics, which are lazy, and it would be maintaining a second SQL engine
// in disguise. A template only has to be a correct answer to one named
// question, with the placeholders that need substituting called out next to
// it, which is the same shape the SQL power pack already uses and the same
// honest limit: copied, never run for you, except where a card says
// otherwise.
//
// WHY THE FUZZY JOIN IS A SKETCH.
// jaro_winkler and levenshtein exist in DuckDB and a similarity join over an
// unindexed cross product is O(n*m); it is fine at the row counts this
// product already caps Python transfers to, and it is the wrong default for
// anything bigger. The card says both things instead of pretending fuzzy
// matching at scale is free.
//
// Reuses `powerQueryHonestNote` from js/polyglot/power-query-note.js and adds
// nothing to what that module already says about M not being embedded; this
// module is the concrete SQL that note points at.
//
// Pure data plus pure selectors. No DOM, no engine, no network. Nothing here
// runs a query.

export const PQ_PARITY_KIND = 'dataglow-pq-parity-recipes';
export const PQ_PARITY_VERSION = 1;

export const PQ_PARITY_HONESTY =
  'These are DuckDB SQL templates that do what a named Power Query step does. Power Query M is not embedded in DataGlow and never will be here; every card below is a real query you copy and run, and the Repair Ledger keeps the order they ran in the way Power Query keeps Applied Steps.';

/**
 * The trademark / no-interpreter disclaimer, kept as its own constant rather
 * than folded into PQ_PARITY_HONESTY so a caller can show it once near the
 * feature (per the "Section D" honesty line requirement) without repeating
 * the whole honesty paragraph on every card.
 *
 * Power Query and Power BI are Microsoft trademarks used here only in the
 * descriptive, comparative sense (naming which product's step a template
 * substitutes for) -- not as a DataGlow feature name, and not implying any
 * affiliation with or endorsement by Microsoft. There is no M interpreter,
 * M parser, or Power Query engine of any kind anywhere in this codebase.
 */
export const PQ_TRADEMARK_DISCLAIMER =
  'Power Query and M are Microsoft product and language names, used here only to say which step a template stands in for. DataGlow does not embed Power Query, does not interpret or parse M, and is not affiliated with or endorsed by Microsoft.';

export const APPLIED_STEPS_BLURB =
  'Power Query keeps every transform in an Applied Steps list you can click back through. Running a recipe below and logging it is the DataGlow equivalent: open the Repair Ledger to see the same list for this session.';

/**
 * Each recipe is a whole runnable statement once placeholders are
 * substituted. `guided` names an existing DataGlow surface that already does
 * the step interactively, when one exists, so a person is pointed at the
 * friendlier path first.
 *
 * Bundle 17 (pqParityHonesty follow-on, no new flag of its own -- this list
 * always renders when the PQ-parity panel is mounted) added the recipes
 * below the fuzzy-join sketch: Group By + All Rows (Power Query's "keep the
 * detail rows next to the aggregate" pattern), Table.First / Table.Last
 * equivalents as SQL, and expand-nested-column-to-join (Power Query's
 * "Expand" button on a column of nested records/tables). One additional
 * Excel Hell-adjacent repair (unmerge simulated merged cells) is included
 * too, since Power Query's fill-down step is the same shape analysts reach
 * for after Excel Hell flags a merged-cell block.
 */
export const PQ_PARITY_RECIPES = Object.freeze([
  Object.freeze({
    id: 'promote-headers',
    pqStep: 'Use First Row as Headers',
    topic: 'Shape',
    title: 'Promote the first row to column headers',
    why: 'A file loaded with a generic header row (column0, column1...) because the real header was one row down.',
    substitute: ['your_table'],
    sql: "-- Assumes column0..columnN were auto-named on load. Adjust the names to match.\nCREATE OR REPLACE TABLE your_table AS\nSELECT * FROM (\n  SELECT * FROM your_table OFFSET 1\n) t;\n-- Then rename columns to the values that were in row 1, by hand or with\n-- ALTER TABLE your_table RENAME COLUMN column0 TO \"<value from row 1>\";",
  }),
  Object.freeze({
    id: 'change-type',
    pqStep: 'Change Type',
    topic: 'Types',
    title: 'Cast a column to a type, locale-honest',
    why: 'A number or date read as text needs an explicit cast, and a cast that silently returns NULL on a bad row hides the row that failed.',
    substitute: ['your_table', 'amount_text', 'amount'],
    sql: "SELECT amount_text,\n       TRY_CAST(amount_text AS DOUBLE) AS amount,\n       (amount_text IS NOT NULL AND TRY_CAST(amount_text AS DOUBLE) IS NULL) AS cast_failed\nFROM your_table;\n-- TRY_CAST never throws; cast_failed flags the rows a plain CAST would have\n-- aborted on, so a locale mismatch (comma decimal, currency symbol) is seen\n-- rather than silently turned into every row failing.",
  }),
  Object.freeze({
    id: 'fill-down',
    pqStep: 'Fill Down',
    topic: 'Shape',
    title: 'Fill down: carry the last non-null value forward',
    why: 'A spreadsheet with a merged-looking category column that is blank on every row but the first of each group.',
    substitute: ['your_table', 'category', 'sort_col'],
    sql: 'SELECT *,\n       last_value(category IGNORE NULLS) OVER (\n         ORDER BY sort_col\n         ROWS UNBOUNDED PRECEDING\n       ) AS category_filled\nFROM your_table\nORDER BY sort_col;',
  }),
  Object.freeze({
    id: 'fill-up',
    pqStep: 'Fill Up',
    topic: 'Shape',
    title: 'Fill up: carry the next non-null value backward',
    why: 'The mirror of fill down, for a total row that labels the block above it rather than below.',
    substitute: ['your_table', 'category', 'sort_col'],
    sql: 'SELECT *,\n       first_value(category IGNORE NULLS) OVER (\n         ORDER BY sort_col\n         ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING\n       ) AS category_filled\nFROM your_table\nORDER BY sort_col;',
  }),
  Object.freeze({
    id: 'split-column',
    pqStep: 'Split Column by Delimiter',
    topic: 'Shape',
    title: 'Split a column by delimiter',
    why: 'A "City, State" column that should be two columns, without losing rows that have no delimiter at all.',
    substitute: ['your_table', 'full_name', ','],
    sql: "SELECT full_name,\n       split_part(full_name, ',', 1) AS part_1,\n       split_part(full_name, ',', 2) AS part_2\nFROM your_table;\n-- split_part returns an empty string, not NULL, when the delimiter is absent,\n-- so check for '' rather than assuming every row split cleanly.",
  }),
  Object.freeze({
    id: 'merge-queries-left',
    pqStep: 'Merge Queries (left outer)',
    topic: 'Joins',
    title: 'Merge queries: left outer join template',
    why: 'Keep every row on the left whether or not the right side matched.',
    substitute: ['left_table', 'right_table', 'key'],
    sql: 'SELECT l.*, r.* EXCLUDE (key)\nFROM left_table l\nLEFT JOIN right_table r ON l.key = r.key;',
  }),
  Object.freeze({
    id: 'merge-queries-inner',
    pqStep: 'Merge Queries (inner)',
    topic: 'Joins',
    title: 'Merge queries: inner join template',
    why: 'Keep only rows that matched on both sides, which is Power Query\'s default merge kind.',
    substitute: ['left_table', 'right_table', 'key'],
    sql: 'SELECT l.*, r.* EXCLUDE (key)\nFROM left_table l\nINNER JOIN right_table r ON l.key = r.key;',
  }),
  Object.freeze({
    id: 'merge-queries-full',
    pqStep: 'Merge Queries (full outer)',
    topic: 'Joins',
    title: 'Merge queries: full outer join template',
    why: 'Keep every row from both sides, matched or not, so nothing on either side is silently dropped.',
    substitute: ['left_table', 'right_table', 'key'],
    sql: 'SELECT *\nFROM left_table l\nFULL OUTER JOIN right_table r ON l.key = r.key;',
  }),
  Object.freeze({
    id: 'append-queries',
    pqStep: 'Append Queries',
    topic: 'Combine',
    title: 'Append queries: stack tables by column name, not position',
    why: 'Power Query appends by name; UNION ALL by position silently mismatches columns that are in a different order between files. UNION BY NAME is the honest equivalent.',
    substitute: ['table_a', 'table_b'],
    sql: 'SELECT * FROM table_a\nUNION ALL BY NAME\nSELECT * FROM table_b;',
  }),
  Object.freeze({
    id: 'group-by-aggregate',
    pqStep: 'Group By',
    topic: 'Aggregate',
    title: 'Group by and aggregate',
    why: 'The step almost every workbook needs eventually: one row per group with the sums and counts Power Query\'s Group By dialog builds one click at a time.',
    substitute: ['your_table', 'region', 'amount'],
    sql: 'SELECT region,\n       count(*) AS rows,\n       sum(amount) AS total_amount,\n       avg(amount) AS avg_amount\nFROM your_table\nGROUP BY ALL\nORDER BY region;',
  }),
  Object.freeze({
    id: 'unpivot-dynamic',
    pqStep: 'Unpivot Columns (dynamic)',
    topic: 'Reshape',
    title: 'Unpivot: dynamic EXCLUDE form',
    why: 'Twelve month columns that should be one column and a date, without naming every month column by hand. The guided unpivot panel does this interactively if it is mounted in this build; this is the raw statement it runs.',
    substitute: ['your_table', 'region'],
    sql: 'UNPIVOT your_table\nON COLUMNS(* EXCLUDE (region))\nINTO NAME period VALUE amount;',
    guided: 'guided-unpivot',
  }),
  Object.freeze({
    id: 'pivot',
    pqStep: 'Pivot Column',
    topic: 'Reshape',
    title: 'Pivot: one column of values becomes many columns',
    why: 'The inverse of unpivot, and the shape a stakeholder usually asks for by name.',
    substitute: ['your_table', 'month', 'amount', 'region'],
    sql: 'PIVOT your_table\n  ON month\n  USING sum(amount)\n  GROUP BY region;',
  }),
  Object.freeze({
    id: 'remove-duplicates',
    pqStep: 'Remove Duplicates',
    topic: 'Data quality',
    title: 'Remove duplicate rows',
    why: 'Exact full-row duplicates, kept as one. For duplicates on a key with differing other columns, see the duplicate-keys SQL snippet instead, which finds them without deciding which to keep.',
    substitute: ['your_table'],
    sql: 'CREATE OR REPLACE TABLE your_table AS\nSELECT DISTINCT * FROM your_table;',
  }),
  Object.freeze({
    id: 'replace-trim-clean',
    pqStep: 'Replace Values / Trim / Clean',
    topic: 'Data quality',
    title: 'Replace values, trim, and strip non-printable characters',
    why: 'The three small text repairs that come up on almost every imported column, done in one pass rather than three.',
    substitute: ['your_table', 'name', 'old_value', 'new_value'],
    sql: "SELECT name,\n       trim(regexp_replace(\n         replace(name, 'old_value', 'new_value'),\n         '[\\x00-\\x1F]', '', 'g'\n       )) AS name_clean\nFROM your_table;",
  }),
  Object.freeze({
    id: 'fuzzy-join-sketch',
    pqStep: '(no direct M equivalent, common follow-on need)',
    topic: 'Joins',
    title: 'Fuzzy join sketch: jaro_winkler / levenshtein',
    why: 'When a key does not match exactly (typos, abbreviations) a similarity score finds candidate matches. This is a sketch, not a default: an unindexed similarity join is a cross product, which is fine at the row counts the Python bridge already caps this product to and the wrong tool at warehouse scale.',
    substitute: ['left_table', 'right_table', 'name'],
    sql: '-- O(n*m): fine for a few thousand rows on each side, not for a big warehouse table.\n-- jaro_winkler returns 0..1 (1 = identical); levenshtein returns an edit distance (0 = identical).\nSELECT l.name AS left_name, r.name AS right_name,\n       jaro_winkler_similarity(l.name, r.name) AS similarity\nFROM left_table l, right_table r\nWHERE jaro_winkler_similarity(l.name, r.name) > 0.85\nORDER BY similarity DESC;',
  }),
  Object.freeze({
    id: 'group-by-keep-all-rows',
    pqStep: 'Group By (with "All Rows" aggregation)',
    topic: 'Aggregate',
    title: 'Group by, but keep every detail row next to the aggregate',
    why: 'Power Query\'s Group By dialog has an "All Rows" option that nests the original rows into the summary instead of collapsing them away. The SQL equivalent is a window aggregate: every detail row survives, with the group total attached to each one.',
    substitute: ['your_table', 'region', 'amount'],
    sql: 'SELECT *,\n       count(*) OVER (PARTITION BY region) AS rows_in_region,\n       sum(amount) OVER (PARTITION BY region) AS total_in_region\nFROM your_table\nORDER BY region;',
  }),
  Object.freeze({
    id: 'table-first-per-group',
    pqStep: 'Table.First (per group)',
    topic: 'Aggregate',
    title: 'Table.First equivalent: the first row of each group',
    why: 'Table.First in a grouped Power Query step returns one record per group. The SQL equivalent is a row_number window filtered to 1, which is explicit about which row counts as "first" instead of relying on whatever order the rows happened to arrive in.',
    substitute: ['your_table', 'region', 'sort_col'],
    sql: 'SELECT *\nFROM your_table\nQUALIFY row_number() OVER (PARTITION BY region ORDER BY sort_col ASC) = 1;',
  }),
  Object.freeze({
    id: 'table-last-per-group',
    pqStep: 'Table.Last (per group)',
    topic: 'Aggregate',
    title: 'Table.Last equivalent: the last row of each group',
    why: 'The mirror of Table.First: the same window, ordered the other way, so "last" is the row with the greatest sort key rather than an assumption about file order.',
    substitute: ['your_table', 'region', 'sort_col'],
    sql: 'SELECT *\nFROM your_table\nQUALIFY row_number() OVER (PARTITION BY region ORDER BY sort_col DESC) = 1;',
  }),
  Object.freeze({
    id: 'expand-nested-to-join',
    pqStep: 'Expand (nested table/record column)',
    topic: 'Joins',
    title: 'Expand a nested column: turn it into a join',
    why: 'Power Query\'s Expand button flattens a column that holds a nested table or record into sibling columns on the parent row. When the nested value is itself a foreign key (an id, or a list of ids), the honest SQL equivalent is a join or an UNNEST rather than a flatten, because the nested value usually still needs to be looked up somewhere.',
    substitute: ['orders', 'promo_ids', 'promos', 'promo_id'],
    sql: '-- promo_ids is a LIST column (Power Query would show it as a nested table).\n-- UNNEST turns each list into one row per element, then the join looks each one up.\nSELECT o.*, p.*\nFROM orders o, UNNEST(o.promo_ids) AS u(promo_id)\nLEFT JOIN promos p ON p.promo_id = u.promo_id;',
  }),
  Object.freeze({
    id: 'unmerge-simulated-merged-cells',
    pqStep: 'Fill Down (after Excel merged-cell import)',
    topic: 'Data quality',
    title: 'Unmerge simulated merged cells from an Excel import',
    why: 'Excel Hell flags a block where a merged cell became one value on the first row and blank on every row it visually spanned. Power Query\'s fix is the same Fill Down step already in this list; this card names the Excel-specific symptom so the connection is not left implicit.',
    substitute: ['your_table', 'category', 'sort_col'],
    sql: '-- Same statement as the Fill Down recipe above, named for the specific\n-- Excel Hell symptom: a merged cell that only shows a value on its first row.\nSELECT *,\n       last_value(category IGNORE NULLS) OVER (\n         ORDER BY sort_col\n         ROWS UNBOUNDED PRECEDING\n       ) AS category_unmerged\nFROM your_table\nORDER BY sort_col;',
  }),
]);

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** Distinct recipe topics, in first-seen order. */
export function pqParityTopics() {
  const out = [];
  for (const r of PQ_PARITY_RECIPES) {
    if (out.indexOf(r.topic) < 0) out.push(r.topic);
  }
  return out;
}

/** Recipes for one topic, or all of them. */
export function listPqParityRecipes(topic) {
  const t = str(topic);
  if (!t) return PQ_PARITY_RECIPES.slice();
  return PQ_PARITY_RECIPES.filter((r) => r.topic === t);
}

/** One recipe by id, or null. */
export function findPqParityRecipe(id) {
  const i = str(id);
  return PQ_PARITY_RECIPES.filter((r) => r.id === i)[0] || null;
}

export function buildPqParityPack() {
  return {
    kind: PQ_PARITY_KIND,
    version: PQ_PARITY_VERSION,
    honesty: PQ_PARITY_HONESTY,
    trademarkDisclaimer: PQ_TRADEMARK_DISCLAIMER,
    appliedStepsBlurb: APPLIED_STEPS_BLURB,
    recipes: PQ_PARITY_RECIPES,
    topics: pqParityTopics(),
    count: PQ_PARITY_RECIPES.length,
  };
}

export const DataGlowPqParityRecipes = {
  PQ_PARITY_KIND,
  PQ_PARITY_VERSION,
  PQ_PARITY_HONESTY,
  PQ_TRADEMARK_DISCLAIMER,
  APPLIED_STEPS_BLURB,
  PQ_PARITY_RECIPES,
  pqParityTopics,
  listPqParityRecipes,
  findPqParityRecipe,
  buildPqParityPack,
};

try {
  if (typeof window !== 'undefined') window.DataGlowPqParityRecipes = DataGlowPqParityRecipes;
} catch (_e) {}
