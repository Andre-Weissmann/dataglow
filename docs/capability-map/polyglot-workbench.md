# Capability detail — Polyglot Workbench

Companion to the **Polyglot Workbench** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on cross-language editor assists; the index alone is enough for most tasks.

## What this area is

Two later batches of the Polyglot Workbench — the multi-runtime SQL/Python/R
surface — that make writing cross-language code less error-prone. Both are pure,
DOM/DuckDB/network/eval-free modules that treat all inputs as opaque strings and
run in Node with zero setup. Both read from the live **Object Space registry**
(`listObjectSpace()`), so every already-created named object (loaded dataset,
Python-computed frame, R-registered result) is known without re-typing.

## `js/polyglot/polyglot-autocomplete.js` — Batch D (schema-aware autocomplete)

`POLYGLOT_AUTOCOMPLETE_VERSION = 1`. Public API (`PUBLIC_API_SURFACE`):

- **`getSuggestions(typed, language, objectSpaceEntries, opts)`** → array of
  `{ text, insertText, kind, origin, score }`. `kind` is one of
  `table|column|keyword|function|snippet`; `origin` is
  `object-space|schema|builtin`. It builds a candidate pool per language:
  - **SQL** — Object Space table names (bare, plus `py.`/`r.` bridge-prefixed
    forms when `opts.includeBridgePrefixes !== false`), schema column names, the
    frozen `SQL_KEYWORDS` and `SQL_FUNCTIONS` lists (functions insert with a
    trailing `(`).
  - **Python** — registered object names (for `dataglow.get_df('name')`), column
    names in bracket form `['col']`, and `PYTHON_SNIPPETS` (pandas/matplotlib
    fragments).
  - **R** — registered object names (for `dataglow_get_df('name')`), column names
    in `$col` form, and `R_SNIPPETS` (dplyr/ggplot2 fragments).

  Each candidate is scored by `matchScore(candidate, typed)` (exact = 1.0,
  prefix = 0.8+, contains = 0.3+) multiplied by a per-kind base weight, then
  deduplicated by text keeping the highest score, sorted descending, and sliced
  to `opts.maxResults` (default 10). Empty/whitespace `typed` returns `[]`.
- **`topSuggestion(typed, language, objectSpaceEntries)`** → the single
  highest-scored match for ghost-text inline rendering, or `null`. When the top
  match cleanly prefixes what was typed, it returns the suffix-only `insertText`
  (like `question-generator-agent.js`'s ghost completion, but cross-language);
  otherwise it returns the full suggestion.

**Wiring status:** imported into `js/app-shell/main.js` (line 157) but **not yet
invoked** there — the ghost-text/popup UI surface is not wired in. The module is
live and tested but currently dark at the UI layer despite its flag being on.

**Flag:** `polyglotAutocomplete` — **`enabled: true`** in `flags.manifest.json`
(added in `feat/polyglot-workbench-batch-d-autocomplete`).

**Tests:** `test/polyglot-autocomplete.test.mjs`.

## `js/polyglot/polyglot-error-advisor.js` — Batch E (cross-language error advisor)

`POLYGLOT_ERROR_ADVISOR_VERSION = 1`. Public API (`PUBLIC_API_SURFACE`):

- **`adviseError(rawError, language, objectSpaceEntries)`** → structured
  `{ language, kind, detail, hint, suggestedFix, raw }`. It routes to a
  per-language parser (`parseSqlError` / `parsePythonError` / `parseRError`) that
  extracts a `kind` (e.g. `NameError`, `KeyError`, `R Error`/`R Warning`) and a
  cleaned `detail`, and attaches a canned `hint` for a small set of well-known
  message patterns (column-not-found, syntax error, `name ... is not defined`,
  `KeyError`, `could not find function`, etc.). It then pulls the first plausible
  identifier out of the raw message (`extractIdentifier` — quoted tokens first,
  then bare 3+ char identifiers) and looks it up in the Object Space via
  `findRegistryMatch` (exact → case-insensitive → 3+ char prefix, returning
  `null` when nothing is close enough).
- **`crossLanguageFix(ident, match, callerLanguage)`** (internal) builds
  `suggestedFix` only when the identifier resolves in the registry but its origin
  language differs — e.g. "created in Python — use `FROM py.claims`", or
  "`patients` is a SQL table. Load it with: `df = dataglow.get_df('patients')`",
  or a same-language "Did you mean …?" spelling nudge. It deliberately returns an
  empty string rather than fabricating advice, mirroring `formatSqlError`.
- **`renderAdvisedErrorHtml(advised)`** → HTML string (not a DOM node) matching
  `renderSqlErrorHtml` in `js/app-shell/sql-highlight.js`, with escaped kind,
  detail, hint, and an optional "Suggested fix:" line.

**Wiring status:** live. `main.js` calls `adviseError` + `renderAdvisedErrorHtml`
in all three run paths — SQL (line ~1707), Python (~2730), and R (~2797) — each
gated on `isEnabled('polyglotErrorAdvisor')`, passing the runtime error message,
the language, and `listObjectSpace()`.

**Flag:** `polyglotErrorAdvisor` — **`enabled: true`** in `flags.manifest.json`
(added in `feat/polyglot-workbench-batch-e-error-advisor`).

**Tests:** `test/polyglot-error-advisor.test.mjs`.

## Related but not in scope

- **Object Space registry** (`objectSpaceRegistry` flag, enabled) — both modules
  consume its `listObjectSpace()` output; it is the Batch B foundation.
- **`multiDialectSql`** (enabled) — the Batch A dialect adapter/picker for the SQL
  tab (`js/dialect/…`, `js/app-shell/main.js` dialect chip row).
- `js/app-shell/sql-highlight.js` — the original `formatSqlError` /
  `renderSqlErrorHtml` whose contract the error advisor extends.
