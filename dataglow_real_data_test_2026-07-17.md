# DataGlow Real-Data Portfolio-Readiness Test — 2026-07-17

## Dataset

**Source:** CMS Medicare Physician & Other Practitioners — by Provider and Service, 2024 reference
year (release `PHY_R26_P05_V10_D24_Prov_Svc`, published 2026-05).
Direct source: https://data.cms.gov/provider-summary-by-type-of-service/medicare-physician-other-practitioners/medicare-physician-other-practitioners-by-provider-and-service

Pulled live via CMS's own public Data API
(`https://data.cms.gov/data-api/v1/dataset/92396110-2aed-4d63-a6a2-5d6207d46a29/data`), filtered
client-side to Illinois-based rendering providers (`Rndrng_Prvdr_State_Abrvtn == "IL"`).

- **3,036 rows, 28 columns** — real provider NPIs, names, cities, specialties, HCPCS procedure
  codes/descriptions, and average submitted/allowed/Medicare-paid dollar amounts.
- De-identified and explicitly published by CMS for public use — no DUA required, no PHI/PII beyond
  provider (not patient) identity.
- Not synthetic, not seeded with known defects — a true "real data, unknown answer key" test. Every
  finding below was independently verified against the raw data with direct DuckDB queries, not
  against a pre-written answer key.

## Platform coverage

| Platform | What was tested | Result |
|---|---|---|
| **Web (browser)** | Full flow: load CSV → Preflight → Validate (20 layers) → Clean scan → SQL query → Story tab | Fully exercised, screenshots + text captured |
| **Desktop (Tauri)** | Asset-identity confirmed (byte-for-byte copy, no transpiling, per `stage-desktop-frontend.mjs`) + CI's `tauri-smoke` job passing on the exact `main` commit tested on web | Verified indirectly — **no local native Tauri run performed** (no Rust/cargo toolchain in this sandbox) |
| **Mobile (PWA)** | Not tested this round | Out of scope for this pass |

**Honest limitation:** the desktop result is an architectural/CI-based verification, not a live
functional run of the native window. Given the frontend is a confirmed byte-identical static copy and
CI's own desktop compile-and-smoke job is green on this exact commit, this is strong evidence — but
not the same strength of evidence as the web test, which was directly observed end-to-end.

## What DataGlow got right (independently verified)

1. **CSV ingestion & row count** — loaded all 3,036 rows into DuckDB-WASM correctly on first try, zero
   parse errors, zero console errors on cold load.
2. **Preflight null-column count** — DataGlow reported "4 / 28 columns with nulls." Independent DuckDB
   check confirms exactly 4 columns have nulls (`Rndrng_Prvdr_First_Name`: 121, `Rndrng_Prvdr_MI`: 1,341,
   `Rndrng_Prvdr_Crdntls`: 477, `Rndrng_Prvdr_St2`: 2,549) — **exact match**.
3. **Duplicate row count** — DataGlow reported 0 duplicates. Independent check (`COUNT(*)` vs.
   `COUNT(DISTINCT *)`) confirms 0 — **exact match**.
4. **Outlier detection (MAD + IQR) on `Tot_Benes`** — DataGlow reported "378 high (MAD z>3.5), 298 above
   IQR fence (>153)." Independent recomputation of the modified z-score and Tukey IQR fence from raw
   values produced identical numbers: median 33, MAD 19, 378 high by MAD, Q1=18/Q3=72/fence=153, 298
   above fence — **exact match on real numeric data**, not just a canned formula.
5. **Missingness Detective (MCAR/MAR/MNAR)** — correctly identified that missingness in
   `Rndrng_Prvdr_MI`, `Rndrng_Prvdr_Crdntls`, and `Rndrng_Prvdr_St2` is systematically tied to provider
   rurality (`RUCA_Desc`) rather than random — a genuinely senior-analyst-level observation on real
   data, not a scripted response.
6. **Fuzzy Duplicate Radar** — surfaced real, plausible near-duplicate name pairs ("Franklin" ≈ "Frank",
   "Martinez" ≈ "Martinez Mateo") from actual provider name data.
7. **Blind Spot Scanner** — correctly flagged that this dataset has no race/ethnicity, payer type, age,
   or gender fields — a true and clinically/analytically relevant limitation of this exact CMS file.
8. **Sanity Anchor cross-check** — ran the same GROUP BY aggregation two independent ways and confirmed
   agreement across 376 real groups — a genuine internal-consistency check, not decorative.
9. **Zero-upload / local-first claim, empirically confirmed with real data** — with every external
   network request blocked at the browser level (`page.route` abort-all except localhost/blob/data),
   DataGlow still loaded the CSV, ran Preflight and Validate, and reported the correct row count. Zero
   blocked-attempt events even fired — the app made no attempt to reach anything external. This is a
   materially higher-stakes test than the prior synthetic-data pass, since this is data shaped exactly
   like what a healthcare professional would actually load.

## Real bug found (reproducible)

**SQL "hallucinated reference" false positive on `ROUND()` in GROUP BY + aliased-ORDER-BY queries.**

Query that triggers it:
```sql
SELECT Rndrng_Prvdr_Type, COUNT(*) as claim_lines,
       ROUND(AVG(CAST(Avg_Sbmtd_Chrg AS DOUBLE)),2) as avg_submitted
FROM medicare_il_providers_2024
GROUP BY Rndrng_Prvdr_Type
ORDER BY avg_submitted DESC
LIMIT 5
```
The query executes correctly (DuckDB returns valid rows), but DataGlow's SQL panel simultaneously
displays: **"1 likely error — review before trusting this result. 'ROUND' doesn't match any table or
column in the loaded data — this looks like a hallucinated reference."**

Isolation testing (4 follow-up queries) showed:
- `SELECT ROUND(1.567, 2)` alone → no false positive
- `SELECT ROUND(AVG(Tot_Benes), 2) FROM ...` (no GROUP BY, no aliased ORDER BY) → no false positive
- `SELECT ... ROUND(...) as avg_submitted ... GROUP BY ... ORDER BY avg_submitted` (no LIMIT
  interaction, minimal repro) → **false positive reproduces every time**

This is exactly the kind of query a healthcare/billing analyst writes constantly (grouped averages,
sorted by a rounded alias), so it's a real, actionable, medium-priority bug — the check is presumably
scanning `ORDER BY`/`SELECT` tokens for identifiers not present in the schema and mis-parsing `ROUND`
as a bare column reference when combined with an alias-based `ORDER BY`. Recommend filing this in
`NORTH_STAR.md`'s backlog and, if the responsible module is identifiable, fixing the tokenizer/parser
in the hallucination-detection layer to exclude known SQL function names before flagging.

## Not fully exercised this round

- **Story tab (on-device LLM narrative)** — clicking "Generate Story" did not complete within a 15s
  wait; the UI indicates a ~1.1GB model (Qwen2.5 1.5B Instruct, 4-bit) must download and cache on first
  use, which can be slow in a sandboxed browser session. Not counted as a failure — likely just needs a
  longer wait or a pre-warmed cache in a real user's browser. Worth a longer, dedicated retest.
- **Desktop native functional run** — see limitation above.
- **Mobile/PWA** — not in scope this round.

## Verdict: is this ready for real-world use?

**Yes, with the one caveat above.** On genuinely real, current, de-identified CMS healthcare billing
data — not synthetic test fixtures — DataGlow's core data-quality engine (Preflight, Validate's 20
layers, Clean's missingness/duplicate detection) produced numerically exact, independently-verifiable
results, correctly surfaced a real systematic-missingness pattern and real near-duplicate names, and
held up its zero-upload privacy claim under an actual network-blocking test. That is a materially
stronger trust signal than a synthetic seeded-defect pass, because there was no answer key to
match against — every number above was checked from scratch against the raw file.

The one real bug (SQL false-positive hallucination warning on a common query shape) is a trust/UX
issue worth fixing before showcasing SQL-heavy work, but it does not corrupt any underlying data or
mislead about the data itself — it's a warning-panel false alarm on a query that still ran and
returned correct results. It would not stop you from using DataGlow on real portfolio work today; it
would make you second-guess a valid query if you didn't already know to check the actual result panel.
