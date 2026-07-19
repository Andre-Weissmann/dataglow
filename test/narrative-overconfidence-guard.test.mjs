// ============================================================
// DATAGLOW — Narrative Overconfidence Guard test suite
// ============================================================
// Proves the guard (js/rigor/narrative-overconfidence-guard.js):
//   - never flags a grade A/B claim regardless of wording (only weak grades
//     are in scope — confident prose backed by strong evidence is fine);
//   - flags overconfident language ("clearly", "definitely", etc.) attached
//     to a grade C/D claim;
//   - flags a grade C/D claim with NO hedge/caveat anywhere near it;
//   - passes a grade C/D claim that IS properly hedged (the honest,
//     already-correct path story.js's own generateLocalStory() produces);
//   - degrades to 'idle' on empty/malformed input rather than throwing;
//   - is pure JS with no DOM/network/model dependency.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/narrative-overconfidence-guard.test.mjs

import { readFileSync } from 'node:fs';
import {
  checkNarrativeOverconfidence,
  describeOverconfidenceFinding,
} from '../js/rigor/narrative-overconfidence-guard.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function claim(kind, column, value, grade, n = 8, missingRate = 0.4) {
  return { kind, column, value, text: `${column} is ${value}`, confidence: { grade, n, missingRate } };
}

// ---------- idle / malformed input ----------
ok(checkNarrativeOverconfidence('', []).status === 'idle', 'empty text -> idle');
ok(checkNarrativeOverconfidence(null, [claim('numeric_mean', 'los', 5, 'D')]).status === 'idle', 'null text -> idle (never throws)');
ok(checkNarrativeOverconfidence('Some story text.', null).status === 'idle', 'null claims -> idle');
ok(checkNarrativeOverconfidence('Some story text.', []).status === 'idle', 'empty claims array -> idle');
ok(checkNarrativeOverconfidence(undefined, undefined).status === 'idle', 'both undefined -> idle, never throws');

// ---------- grade A/B claims are never flagged, regardless of wording ----------
{
  const claims = [claim('numeric_mean', 'los', 5.2, 'A', 250, 0.0)];
  const text = 'The average los is clearly and definitely 5.2, without a doubt the strongest pattern in this dataset.';
  const res = checkNarrativeOverconfidence(text, claims);
  ok(res.status === 'pass', 'grade A claim with maximally confident wording still passes');
  ok(res.findings.length === 0, 'grade A claim produces zero findings regardless of language');
}
{
  const claims = [claim('rowcount', null, 400, 'B', 400, 0.05)];
  const text = 'This query always returns a consistent 400 rows.';
  const res = checkNarrativeOverconfidence(text, claims);
  ok(res.status === 'pass', 'grade B claim with confident wording still passes (only C/D are in scope)');
}

// ---------- grade C/D + overconfident language -> flagged ----------
{
  const claims = [claim('numeric_mean', 'los', 5.20, 'D', 6, 0.5)];
  const text = 'The average los is clearly 5.20 across all patients.';
  const res = checkNarrativeOverconfidence(text, claims);
  ok(res.status === 'warn', 'grade D claim + "clearly" -> warn');
  ok(res.findings.some((f) => f.issue === 'overconfident_language'), 'finding tagged overconfident_language');
  ok(res.findings.some((f) => f.grade === 'D'), 'finding carries the correct grade');
  ok(res.findings.some((f) => f.column === 'los'), 'finding carries the correct column');
}
{
  const claims = [claim('category_share', 'status', 42.0, 'C', 10, 0.3)];
  const text = 'The most common status is "Denied" at 42.0% of rows — this definitely proves a systemic issue.';
  const res = checkNarrativeOverconfidence(text, claims);
  ok(res.status === 'warn', 'grade C claim + "definitely"/"proves" -> warn');
  ok(res.findings.length >= 1, 'at least one finding recorded');
}

// ---------- grade C/D + no hedge anywhere -> flagged (missing_hedge) ----------
{
  const claims = [claim('numeric_mean', 'los', 5.20, 'D', 6, 0.5)];
  const text = 'The average los is 5.20 across all patients. This is a useful figure for planning.';
  const res = checkNarrativeOverconfidence(text, claims);
  ok(res.status === 'warn', 'grade D claim with no hedge anywhere -> warn');
  ok(res.findings.some((f) => f.issue === 'missing_hedge'), 'finding tagged missing_hedge');
  ok(res.findings.some((f) => f.sentence === null), 'missing_hedge finding has no single sentence to point to (honest null)');
}

// ---------- grade C/D properly hedged -> passes (the honest, already-correct path) ----------
{
  const claims = [claim('numeric_mean', 'los', 5.20, 'D', 6, 0.5)];
  // Mirrors story.js's own generateLocalStory() caveat wording exactly.
  const text = 'The average los is 5.20. Treat this average cautiously — it rests on limited or partly-missing data.';
  const res = checkNarrativeOverconfidence(text, claims);
  ok(res.status === 'pass', 'grade D claim WITH proper hedge language -> pass');
  ok(res.findings.length === 0, 'properly hedged claim produces zero findings');
}
{
  const claims = [claim('category_share', 'payer', 30.0, 'C', 9, 0.35)];
  const text = 'The most common payer is "Medicare" at 30.0% of rows, though this is a preliminary read given the small sample.';
  const res = checkNarrativeOverconfidence(text, claims);
  ok(res.status === 'pass', 'grade C claim hedged with "preliminary"/"small sample" -> pass');
}

// ---------- multiple claims: only the weak, unhedged one is flagged ----------
{
  const claims = [
    claim('rowcount', null, 500, 'A', 500, 0.0),
    claim('numeric_mean', 'los', 5.2, 'D', 6, 0.5),
  ];
  const text = 'The query returned 500 rows. The average los is clearly 5.2 with no exceptions.';
  const res = checkNarrativeOverconfidence(text, claims);
  ok(res.status === 'warn', 'mixed grades: overall status reflects the weak flagged claim');
  ok(res.findings.every((f) => f.claimKind === 'numeric_mean'), 'only the grade D claim is flagged, not the grade A rowcount claim');
}

// ---------- paraphrased number (not found verbatim) falls back to whole-text scan ----------
{
  const claims = [claim('numeric_mean', 'los', 5.234567, 'D', 6, 0.5)];
  // Model paraphrases "approximately five and a quarter days" instead of the exact number.
  const text = 'Patients stay approximately five and a quarter days on average, which is definitely the norm here.';
  const res = checkNarrativeOverconfidence(text, claims);
  ok(res.status === 'warn', 'paraphrased claim still checked via whole-text fallback');
  ok(res.findings.some((f) => f.sentence === null), 'fallback-scanned finding honestly reports sentence:null (could not localize)');
}

// ---------- describeOverconfidenceFinding produces readable text ----------
{
  const claims = [claim('numeric_mean', 'los', 5.2, 'D', 6, 0.5)];
  const text = 'The average los is clearly 5.2.';
  const res = checkNarrativeOverconfidence(text, claims);
  const desc = describeOverconfidenceFinding(res.findings[0]);
  ok(typeof desc === 'string' && desc.length > 0, 'describeOverconfidenceFinding returns non-empty string');
  ok(desc.includes('D'), 'description mentions the grade');
  ok(desc.includes('los'), 'description mentions the column');
}

// ---------- never mutates inputs ----------
{
  const claims = [claim('numeric_mean', 'los', 5.2, 'D', 6, 0.5)];
  const claimsCopy = JSON.parse(JSON.stringify(claims));
  checkNarrativeOverconfidence('The average los is clearly 5.2.', claims);
  ok(JSON.stringify(claims) === JSON.stringify(claimsCopy), 'checkNarrativeOverconfidence never mutates the claims array it receives');
}

// ---------- source scan: prove this module names no DOM/network/DuckDB/model primitive ----------
{
  const modulePath = new URL('../js/rigor/narrative-overconfidence-guard.js', import.meta.url);
  const source = readFileSync(modulePath, 'utf8');
  const forbidden = ['document.', 'window.', 'fetch(', 'XMLHttpRequest', 'runQuery', 'localStorage', 'indexedDB', 'WebGPU', 'webllm', 'import('];
  const found = forbidden.filter((token) => source.includes(token));
  ok(found.length === 0, `narrative-overconfidence-guard.js names no DOM/network/DuckDB/model primitive (checked: ${forbidden.join(', ')})`);
}

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
