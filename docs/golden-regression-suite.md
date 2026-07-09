# Golden Regression Suite

A snapshot-style regression safety net for DATAGLOW's core deterministic
operations. It captures the output of a handful of central, high-risk behaviours
as versioned **fixture** files and, on every run, re-executes those operations
and diffs the fresh output against the stored fixture. If anything moved, the
run fails with a readable diff.

**Why it exists.** DATAGLOW gains features fast, often added by AI coding
agents. Each feature ships with its own unit tests that prove *it* works the day
it lands. What those tests do not prove is that feature N+1 left features 1..N
untouched. The golden suite is that second guarantee: a change that silently
alters an existing output becomes a loud, reviewable failure instead of a
regression nobody noticed. It is a safety net, not a specification — the
per-feature `test:*` suites remain the source of truth for what each behaviour
*should* be.

## What it covers

The cases live in [`test/golden/cases.mjs`](../test/golden/cases.mjs); the runner
is [`test/golden/index.test.mjs`](../test/golden/index.test.mjs). They were
picked from the highest-risk deterministic surfaces in the
[capability map](./capability-map.md) — the SQL-generating cleaners, the
validation-layer orchestrator, and the cross-column / bounds / grade roll-ups:

| Fixture | Module(s) | What it pins down |
| --- | --- | --- |
| `calibrated-grades` | `js/grades/calibrated-grades.js` | Two-axis Integrity/Domain grade roll-up (clean, degraded, and pack-reinterpreted inputs) |
| `cross-column-detectors` | `js/validation/cross-column-consistency.js` | Pure name-pairing detectors + value classifiers (no DB) |
| `upper-bound-classify` | `js/validation/upper-bound-sanity.js` | Pure bounded-type name classification + bound decision (no DB) |
| `imputation-sql` | `js/cleaning/imputation.js` | The generated grouped-imputation SQL string |
| `sql-imputation-preview` | `js/cleaning/imputation.js` | Grouped-mean imputation preview run against a real DuckDB engine |
| `sql-format-issues` | `js/cleaning/format-fingerprint.js` | Format-contamination scan (currency / mixed dates / fake nulls) |
| `sql-cross-column-run` | `js/validation/cross-column-consistency.js` | Cross-column findings against a fixed messy dataset |
| `sql-upper-bound-run` | `js/validation/upper-bound-sanity.js` | Out-of-bounds percentage / proportion findings |
| `sql-validation-layers` | `js/validation/validation.js` | Every layer's pass/warn/fail/idle status + confidence + calibrated grades on a fixed dataset — the headline regression signal |

The DuckDB-backed cases run against the native node engine via the existing
[`test/duckdb-loader-hook.mjs`](../test/duckdb-loader-hook.mjs) — the same hook
the SQL logic suite uses, so the production modules run byte-for-byte unmodified
and only their DB backend is swapped. No browser, no server, no network.

Breadth is deliberately small; it can grow later. The point is a trustworthy
fixture/diff mechanism over a few central behaviours, not total coverage.

## Running it

```sh
npm run test:golden          # verify current output matches the fixtures
```

It is wired into CI as its own `golden-regression` job in
[`.github/workflows/test.yml`](../.github/workflows/test.yml), so it runs on
every pull request automatically.

## Adding a new golden fixture

1. Open [`test/golden/cases.mjs`](../test/golden/cases.mjs) and add a case to
   the array returned by `buildCases()`:

   ```js
   {
     name: 'my-behaviour',            // becomes fixtures/my-behaviour.json
     async run() {
       // Call the production function(s) and return a JSON-serialisable value.
       // For DuckDB-backed cases, build a fixed dataset with makeDataset(...).
       return await someDeterministicOperation(input);
     },
   }
   ```

   Keep the input **fixed and deterministic** — the fixture is captured against
   exactly those inputs. Avoid anything time-, random-, or environment-dependent
   in the returned value. (Timestamp-ish keys `ts`, `elapsedMs`, and `loadedAt`
   are stripped automatically, and non-integer numbers are rounded to 6 decimal
   places, but the operation itself must otherwise be reproducible.)

2. Capture the fixture, then **read it** to confirm the output is actually
   correct before committing — a golden file is only as trustworthy as the first
   capture:

   ```sh
   npm run test:golden:update
   ```

3. Commit the new `test/golden/fixtures/my-behaviour.json` alongside your case.

## Updating a fixture when a behaviour change is intended

A failing golden case means an existing output changed. That is exactly what the
suite is for — but it does **not** decide whether the change was intended. You
do.

- **If the change is a bug / accident:** fix the code so the output matches the
  fixture again. Do *not* touch the fixture.
- **If the change is intended** (you deliberately changed how a layer scores, a
  SQL template, a grade band, …): regenerate the fixtures and review the diff as
  carefully as you review code —

  ```sh
  npm run test:golden:update
  git diff test/golden/fixtures/    # <-- read every changed line
  ```

  The fixture diff belongs in your PR. A reviewer approving the PR is approving
  the behaviour change the diff represents. Never run the update blindly to make
  a red suite green — that defeats the entire purpose.
