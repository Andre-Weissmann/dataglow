// ============================================================
// DATAGLOW — NCCI Procedure-to-Procedure (PTP) Same-Day Edit Layer
// ============================================================
// Detects claim lines that bill two CPT/HCPCS procedure codes for the SAME
// patient on the SAME date of service where CMS's National Correct Coding
// Initiative (NCCI) Procedure-to-Procedure edits say that pair should not be
// reported together. This is the single most common Medicare claim-denial
// trigger in outpatient/professional billing, and it is purely mechanical
// (same patient + same date + a known-conflicting code pair) — a natural fit
// for an automated data-quality check, not a clinical judgment call.
//
// IMPORTANT — scope & intent (same posture as drg-icd-validator.js):
//   * This is a DATA-QUALITY check, NOT a compliance tool and NOT a substitute
//     for CMS's own quarterly NCCI PTP edit files (which run ~400,000+ code
//     pairs and are licensed/redistributed by CMS itself, updated quarterly).
//     Replicating that full table is out of scope for a client-side, no-
//     paid-API-key tool — and would go stale every quarter without a live
//     CMS feed we don't have permission to bundle.
//   * Coverage is intentionally narrow: a small, curated set of NCCI PTP
//     pairs that are well-documented, long-standing, and modifier-indicator-0
//     ("misuse of column two code" / mutually exclusive — never separately
//     payable, no modifier override) in CMS's own public NCCI Policy Manual
//     and FAQ materials. These are the safest possible flags: no "maybe with
//     modifier 59" ambiguity, because a 0-indicator pair is never separately
//     billable regardless of modifier.
//     Sources (public, non-proprietary):
//       - CMS NCCI Policy Manual for Medicare Services, Chapter I
//         https://www.cms.gov/files/document/ncci-policy-manual-medicare-services-effective-october-1-2005.pdf
//       - Medicaid NCCI 2021 Coding Policy Manual, Chapter I
//         https://www.medicaid.gov/medicaid/program-integrity/downloads/nccimanual2021-chapterone.pdf
//       - CMS Medicare NCCI PTP Edits overview
//         https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-procedure-procedure-ptp-edits
//   * Unrecognised code pairs are silently skipped (no false positives) —
//     the same fail-open posture as every other layer in this file.
//
// Column detection reuses the same robust word-splitting tokenizer as the
// Cross-Column and DRG/ICD layers, so "procedure_code", "cpt_code", "hcpcs",
// "patient_id", "date_of_service", "service_date" etc. all match without
// brittle regex.
// ============================================================

import { nameTokens, hasAnyKeyword, isNumeric } from './cross-column-consistency.js';

// ---------------------------------------------------------------------------
// Curated NCCI PTP edit pairs — Column One / Column Two, modifier indicator 0
// (never separately payable together, no modifier override permitted).
// codeA/codeB are stored as an unordered pair since a same-day conflict is
// symmetric for data-quality purposes (which column appears in the claims
// export varies by payer/clearinghouse) — the check flags either order.
// ---------------------------------------------------------------------------
// Sources: CMS NCCI Policy Manual (Ch. I); Medicaid NCCI 2021 Coding Policy
// Manual (Ch. I); CMS Medicare NCCI PTP Edits public documentation.
// ---------------------------------------------------------------------------
export const NCCI_PTP_PAIRS = [
  {
    codeA: '58260', codeB: '58720',
    rationale: 'Vaginal hysterectomy (58260) and salpingo-oophorectomy (58720) — CMS NCCI Policy Manual names this exact pair as mutually exclusive: the salpingo-oophorectomy is a "separate procedure" already inherent to the hysterectomy approach and is not separately reportable on the same date.',
  },
  {
    codeA: '58260', codeB: '58150',
    rationale: 'Vaginal hysterectomy (58260) and total abdominal hysterectomy (58150) are two different surgical approaches to the same procedure — CMS NCCI policy explicitly bars reporting both approaches together for the same operative episode.',
  },
  {
    codeA: '77066', codeB: '77065',
    rationale: 'Bilateral diagnostic mammography (77066) and unilateral diagnostic mammography (77065) — CMS NCCI policy explicitly prohibits "unbundling" a bilateral procedure into a bilateral code plus a unilateral code (or two laterality-modified unilateral codes) on the same date.',
  },
  {
    codeA: '49000', codeB: '44005',
    rationale: 'Exploratory laparotomy (49000) and enterolysis / lysis of intestinal adhesions (44005) — CMS NCCI policy treats an exploratory laparotomy as inherently included in a subsequent intra-abdominal procedure on the same date; it is not separately reportable as its own line.',
  },
  {
    codeA: '93451', codeB: '93318',
    rationale: 'Right heart catheterization (93451) and echocardiography for monitoring purposes (93318) — a commonly-cited CMS NCCI PTP edit; per NCCI PTP-associated modifier tables this pair carries a "no modifier override" designation for same-session reporting.',
  },
];

// Build a fast O(1) lookup: for each code, the set of codes it conflicts with,
// plus the rationale for that specific pair. Symmetric (order-independent).
const CONFLICT_MAP = new Map();
for (const pair of NCCI_PTP_PAIRS) {
  if (!CONFLICT_MAP.has(pair.codeA)) CONFLICT_MAP.set(pair.codeA, new Map());
  if (!CONFLICT_MAP.has(pair.codeB)) CONFLICT_MAP.set(pair.codeB, new Map());
  CONFLICT_MAP.get(pair.codeA).set(pair.codeB, pair.rationale);
  CONFLICT_MAP.get(pair.codeB).set(pair.codeA, pair.rationale);
}

// ---------------------------------------------------------------------------
// Column detection helpers
// ---------------------------------------------------------------------------
const PROC_KW = ['procedure', 'cpt', 'hcpcs', 'proc'];
const PATIENT_KW = ['patient', 'member', 'beneficiary', 'mrn'];
const DATE_KW = ['date', 'dos', 'service'];

export function detectProcedureColumn(cols) {
  return cols.find(c => hasAnyKeyword(c.name, PROC_KW)) || null;
}

export function detectPatientColumn(cols) {
  // Prefer a compound "patient_id"/"member_id" style column over a bare
  // "patient_name" text field — an _id-suffixed or id-keyword column is a
  // more reliable same-patient join key than a free-text name.
  const idLike = cols.find(c =>
    hasAnyKeyword(c.name, PATIENT_KW) && hasAnyKeyword(c.name, ['id', 'number', 'num'])
  );
  if (idLike) return idLike;
  return cols.find(c => hasAnyKeyword(c.name, PATIENT_KW)) || null;
}

export function detectServiceDateColumn(cols) {
  // Prefer a compound "service_date"/"date_of_service" over a bare "date"
  // column that might mean something else (e.g. paid_date, created_date).
  const compound = cols.find(c =>
    hasAnyKeyword(c.name, ['service']) && hasAnyKeyword(c.name, ['date'])
  );
  if (compound) return compound;
  const dosAbbrev = cols.find(c => nameTokens(c.name).includes('dos'));
  if (dosAbbrev) return dosAbbrev;
  return cols.find(c => hasAnyKeyword(c.name, DATE_KW)) || null;
}

// ---------------------------------------------------------------------------
// Runner — for every claim (patient_id, service_date) group with 2+ rows,
// checks in SQL whether any two of that group's procedure codes are a known
// NCCI conflict pair. Uses a self-join scoped to the same patient+date so the
// combinatorics stay small (most claims have a handful of lines, not
// thousands), then filters the resulting code pairs against CONFLICT_MAP in
// JS (cheaper than encoding a 5-pair lookup as SQL CASE/IN logic, and easy to
// extend without touching SQL).
// ---------------------------------------------------------------------------
export async function runNcciPtpValidation(table, cols, engine) {
  const findings = [];
  const procCol = detectProcedureColumn(cols);
  const patientCol = detectPatientColumn(cols);
  const dateCol = detectServiceDateColumn(cols);

  if (!procCol || !patientCol || !dateCol) return findings; // columns not present — silent skip

  // Self-join: pairs of rows sharing the same patient + service date but a
  // different row (a != b avoids self-pairing; a < b on rowid-equivalent
  // avoids double-counting each pair in both directions).
  const sql = `
    SELECT
      a."${patientCol.name}" AS patient_key,
      a."${dateCol.name}" AS svc_date,
      TRIM(CAST(a."${procCol.name}" AS VARCHAR)) AS code_a,
      TRIM(CAST(b."${procCol.name}" AS VARCHAR)) AS code_b,
      COUNT(*) AS n
    FROM ${table} a
    JOIN ${table} b
      ON a."${patientCol.name}" = b."${patientCol.name}"
     AND a."${dateCol.name}" = b."${dateCol.name}"
     AND TRIM(CAST(a."${procCol.name}" AS VARCHAR)) < TRIM(CAST(b."${procCol.name}" AS VARCHAR))
    WHERE a."${patientCol.name}" IS NOT NULL
      AND a."${dateCol.name}" IS NOT NULL
      AND a."${procCol.name}" IS NOT NULL
      AND b."${procCol.name}" IS NOT NULL
    GROUP BY 1, 2, 3, 4`;

  let rows;
  try {
    ({ rows } = await engine.runQuery(sql));
  } catch {
    return findings; // column type incompatible with the join — skip silently, fail open
  }

  // Aggregate matches per conflicting pair (not per patient/date) so the
  // finding reads like the DRG/ICD layer's "N row(s) with this issue" shape
  // rather than one finding per claim.
  const perPair = new Map(); // key: "codeA|codeB" (sorted) -> { count, rationale, examples: Set }
  for (const row of rows) {
    const a = String(row.code_a);
    const b = String(row.code_b);
    const conflictMapForA = CONFLICT_MAP.get(a);
    const rationale = conflictMapForA ? conflictMapForA.get(b) : undefined;
    if (!rationale) continue; // not a known pair — skip
    const key = [a, b].sort().join('|');
    if (!perPair.has(key)) perPair.set(key, { codeA: a, codeB: b, rationale, count: 0 });
    perPair.get(key).count += 1;
  }

  for (const { codeA, codeB, rationale, count } of perPair.values()) {
    findings.push({
      rule: 'ncci_ptp_same_day_conflict',
      ruleLabel: `NCCI same-day conflicting procedures — ${codeA}/${codeB}`,
      columns: [patientCol.name, dateCol.name, procCol.name],
      count,
      text: `${count} claim(s) bill CPT/HCPCS ${codeA} and ${codeB} for the same patient on the same date of service — a known NCCI Procedure-to-Procedure conflict pair.`,
      explanation: `${rationale} Per CMS NCCI policy this pair carries no modifier override for same-session billing, so ${count} claim(s) with both codes on one date of service are at high risk of a Column Two denial (or, if paid, an audit finding) — worth a coder review before this data is used for revenue or quality reporting.`,
    });
  }

  return findings;
}
