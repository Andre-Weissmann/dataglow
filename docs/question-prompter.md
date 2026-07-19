# Question Prompter

`js/questions/question-prompter.js`

## 1. What it is, and why it exists

Every analytics tool eventually hands the analyst a clean grid and a
validation report and says, in effect, "now what?" The gap between *data
loaded* and *analyst knows what to look at* is where most analysis stalls —
not because the analyst lacks skill, but because staring at forty columns and
a wall of findings is not the same as knowing where the interesting story is.

The Question Prompter closes that gap. It reads the signals DataGlow already
has — a file name, inferred column names, computed column statistics, and
validation findings — and turns them into a small, ranked set of concrete
business questions: not "column X is 14% null" (a fact) but "is that
missingness random, or does it correlate with discharge status?" (a
question an analyst can go answer). Every question ships with a starter SQL
query or a concrete next action, so the gap between *question* and *first
move* is zero.

This is **question-first analysis**: DataGlow does not wait for the analyst
to know what to ask. It reads the data's signals and surfaces the most
valuable starting points, before the analyst has typed a single query.

The module is pure logic — no browser APIs, no network calls, no LLM calls.
It is rule-based and template-driven, which means it is deterministic (the
same inputs always produce the same questions in the same order), testable
under plain Node, and works fully offline. See §7 for why that is a
deliberate design choice, not a limitation.

## 2. The three modes

### Pre-upload mode — `generatePreUploadQuestions(fileName, columnNames, options)`

Nothing has loaded yet. All that exists is a file name and the column names
DataGlow's schema inference detected. This mode asks the questions a sharp
analyst would ask before opening the file at all:

- *"This looks like a transaction/event table. What is the grain — one row
  per patient encounter?"*
- *"`admit_date` appears to be a date column. What time period does this
  data cover, and what is the reporting cadence?"*
- *"`total_charge_amount` looks like an amount/value column. What currency
  and what aggregation level?"*

It infers the domain from the file name and column names (§3), scans column
names for date-like, amount-like, and id-like patterns, and returns **3–5**
questions — enough to orient the analyst, not so many it overwhelms them
before they have even seen a row of data.

### Post-validation mode — `generateQuestions(findings, columnStats, options)`

Validation has run. This is the mode that targets what was **actually
found**: null rates, skewness, outliers, low cardinality, date gaps, join
fanout, schema drift. Every question carries a `triggeredBy` field that
names the exact finding or statistic that raised it, so a question is never
a generic prompt — it is always traceable back to a real signal in this
dataset.

```js
import { generateQuestions } from './js/questions/question-prompter.js';

const questions = generateQuestions(findings, columnStats, {
  domain: 'healthcare',   // optional — see inferDomain() to compute this
  maxQuestions: 5,
  includeSQL: true,
  tableName: 'claims',
});
```

### Streaming mode — `updateStreamingQuestions(existingQuestions, newBatchFindings, batchNumber)`

As NATS batches arrive (see [`docs/nats-bridge.md`](nats-bridge.md)), the
question set should evolve with the stream, not stay frozen at the first
snapshot. `updateStreamingQuestions` diffs each new batch's findings against
the current question set:

- **`newQuestions`** — questions raised for the first time by this batch
  (e.g. batch 4 introduces a fanout finding that batches 1–3 didn't have).
- **`resolvedQuestions`** — questions whose triggering condition no longer
  appears in the latest batch (e.g. the outlier rate that triggered a
  question in batch 1 has vanished by batch 3 — worth telling the analyst
  the concern may have resolved itself, not just silently dropping it).

```js
const { questions, newQuestions, resolvedQuestions } =
  updateStreamingQuestions(previousQuestions, batchFindings, batchNumber);
```

Streaming mode reuses the same template library and question shape as
post-validation mode — it is the same engine, running incrementally.

## 3. How domain inference works, and how to override it

`inferDomain(fileName, columnNames)` scores a dataset against five domain
signal lists by combining the file name and every column name into one
lowercase token string, then counting keyword hits per domain:

| Domain | Signals |
|---|---|
| `healthcare` | patient, claim, diagnosis, icd, drg, los, length_of_stay, discharge, admit, admission, npi, provider, readmission, insurance, encounter, procedure, cpt |
| `finance` | revenue, amount, balance, account, transaction, invoice, payment, ledger, debit, credit, currency, gl_code, cost, price |
| `retail` | product, sku, order, customer, cart, inventory, store, basket, checkout, shipment, warehouse, quantity |
| `hr` | employee, salary, department, hire, termination, performance, headcount, compensation, manager_id, tenure |
| `operations` | shift, downtime, throughput, utilization, maintenance, equipment, sensor, batch_id, yield |

The domain with the highest signal count wins; a dataset with no signal hits
at all is `'general'`. Matching is left-word-bounded but tolerant of simple
suffixes, so `"claims_q2.csv"` matches the `claim` signal and infers
`healthcare`, and a `revenue` column matches even as `revenues`.

**Overriding inference:** every function that uses domain internally accepts
an explicit `domain` in its `options` (`generateQuestions(findings, stats, {
domain: 'finance' })`, `generatePreUploadQuestions(fileName, columnNames, {
domain: 'retail' })`). When `domain` is supplied it is used as-is and
`inferDomain` is never called — this lets a caller who already knows the
dataset's domain (e.g. from a saved project setting) skip inference
entirely and guarantees a human's explicit choice always wins over a
heuristic guess.

## 4. The question template library

Every question comes from `QUESTION_TEMPLATES`, a flat map of template key →
`{{token}}`-interpolated string. Templates are grouped by what they respond
to:

**Statistical patterns** (fire from column statistics)
- `right_skew` — skewness beyond a threshold; asks about power-law shape and
  segmentation.
- `high_nulls` — null rate beyond a threshold; asks MCAR vs. correlated
  missingness.
- `outliers` — outlier rows found beyond a bound; asks data-entry-error vs.
  genuine edge case.
- `low_cardinality` — very few distinct values in what may be a text column;
  asks whether it's really a category.
- `date_gap` — a gap in date coverage; asks about a collection pause.

**Join / schema issues** (fire from validation findings)
- `fanout` — a join produced more rows than expected; asks about duplicate
  keys.
- `schema_drift` — a column's inferred type changed partway through the
  data; asks whether that was intentional.

**Business domain patterns** (fire from column name + domain + stats)
- `revenue_skew` — revenue-shaped column with heavy concentration; asks what
  drives it.
- `healthcare_los` — a length-of-stay-shaped column (`los`,
  `length_of_stay`, or a `discharge`-pattern column when the healthcare
  domain is active); asks whether extremes are readmissions or errors.
- `healthcare_readmission` — a readmission-flavored finding; asks whether
  it's a real flag or a join artifact.

**Exploratory** (fire from cross-column relationships)
- `correlation_hint` — two numeric columns with matching null patterns; asks
  whether to run a correlation analysis.
- `time_trend` — a date-like column with a wide observed range; asks about
  seasonality.

**Pre-upload (schema-only)** (fire from column names alone, no data loaded)
- `schema_only_id` — an id-shaped column name; asks about table grain.
- `schema_only_date` — a date-shaped column name; asks about coverage
  period and cadence.
- `schema_only_amount` — an amount-shaped column name; asks about currency
  and aggregation level.

Every template also has a default `category` (`quality` | `exploration` |
`business` | `validation`) and `priority` (`high` | `medium` | `low`) baked
in, defined alongside the templates so the priority ordering a caller sees
via `rankQuestions` is consistent no matter which function produced the
question.

## 5. How questions connect to starter SQL and suggested actions

Every `Question` carries a `suggestedAction` — a short, human-readable next
step (e.g. `"Run distribution analysis and segment by category"`) — and,
when requested, a `suggestedSQL` starter query:

```js
generateStarterSQL(question, tableName, columnStats)
```

`generateStarterSQL` maps the question's originating template to a query
shape appropriate for that class of problem — a `COUNT(*) - COUNT(col)` null
count for `high_nulls`, a `PERCENTILE_CONT` / `AVG` / `MAX` distribution
check for `right_skew`, a `GROUP BY ... HAVING cnt > 1` duplicate-key scan
for `fanout`, and so on for every template. The column name is recovered
from the question's `triggeredBy` field (or falls back to the first
provided column stat), and the table name is supplied by the caller —
DataGlow does not assume a table name, since the same dataset may be loaded
under different aliases in different contexts (a raw upload table vs. a
DuckDB view vs. a NATS stream table).

`generateQuestions(..., { includeSQL: true, tableName: 'claims' })`
populates `suggestedSQL` on every returned question automatically; calling
`generateStarterSQL` directly is for callers building their own question
flow (e.g. the streaming rail, which generates SQL lazily only for the
questions the analyst actually expands).

## 6. Integration guide — how the Canvas "Where to start" card calls `generateQuestions`

The Canvas "Where to start" card is the surface where all three modes meet:

```js
import {
  generatePreUploadQuestions,
  generateQuestions,
  updateStreamingQuestions,
  rankQuestions,
  formatQuestionsCard,
} from './js/questions/question-prompter.js';

// 1. As soon as a file is selected, before any data loads:
let questions = generatePreUploadQuestions(file.name, inferredColumnNames);
renderWhereToStartCard(formatQuestionsCard(questions));

// 2. Once validation finishes:
const domain = inferDomain(file.name, columnNames);
questions = generateQuestions(findings, columnStats, {
  domain,
  maxQuestions: 5,
  includeSQL: true,
  tableName: datasetTableName,
});
renderWhereToStartCard(formatQuestionsCard(questions));

// 3. As each NATS batch arrives:
nats.onBatch((batchFindings, batchNumber) => {
  const { questions: updated, newQuestions, resolvedQuestions } =
    updateStreamingQuestions(questions, batchFindings, batchNumber);
  questions = updated;
  renderWhereToStartCard(formatQuestionsCard(rankQuestions(questions, previouslyShownIds)));
  if (newQuestions.length) notifyNewQuestions(newQuestions);
  if (resolvedQuestions.length) notifyResolvedQuestions(resolvedQuestions);
});
```

`formatQuestionsCard(questions)` renders the plain-text block the card
displays:

```
WHERE TO START
==============
[HIGH] Quality: 14% of insurance_type values are missing. Is this missingness random (MCAR) or does it correlate with discharge_status?
  → Starter SQL: SELECT COUNT(*) - COUNT(insurance_type) as nulls, COUNT(*) as total FROM claims;
[HIGH] Exploration: Revenue is concentrated in the top 20% of records. What drives this concentration — product type, region, or customer segment?
  → Action: Run distribution analysis by category column
```

`rankQuestions(questions, previouslyShown)` sorts high-priority questions
first and filters out anything already surfaced to the analyst in this
session, so the card never repeats itself as new batches or validation
passes refresh the set.

## 7. Philosophy: DataGlow does not replace analyst judgment

Every function in this module returns **questions**, never conclusions. The
templates are deliberately phrased as questions ("Is this missingness
random...?", "What drives this concentration...?"), `suggestedAction` is a
starting point ("Run distribution analysis") not a directive, and
`suggestedSQL` is something to run and look at, not a number to trust
blindly.

This is intentional. A tool that says "insurance_type has 14% missing
values, therefore exclude ER visits from your analysis" has made a judgment
call the analyst never got to weigh in on — and if that judgment is wrong,
the analyst may never notice. A tool that says "14% of insurance_type is
missing — is that MCAR or does it correlate with discharge_status? Here's a
query to check" gives the analyst everything they need to form their own
judgment in seconds, while leaving the judgment itself where it belongs.

The rule-based design reinforces this: there is no LLM in the loop deciding
which questions matter, so there is no black box to over-trust. An LLM
*may* be layered on top by a caller — for example, to rephrase a question in
a more domain-fluent voice, or to prioritize among a large question set for
a specific analyst's stated goal — but the underlying signal-to-question
mapping in this module is fully inspectable, deterministic, and testable
without ever calling out to a model.

DataGlow does not replace analyst judgment. It gives the analyst a head
start — the same head start a sharp, experienced colleague would give you
by glancing at your data and saying, "here's where I'd look first."
