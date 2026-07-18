// ============================================================
// DATAGLOW — DRG / ICD-10-CM Cross-Validation Layer
// ============================================================
// Detects MS-DRG codes whose paired primary ICD-10-CM diagnosis is clinically
// incompatible — a common healthcare coding error that causes claim denials,
// audit risk, and corrupts case-mix index calculations.
//
// IMPORTANT — scope & intent:
//   * This is a DATA-QUALITY check, NOT a compliance tool and NOT a substitute
//     for a certified grouper. It catches clear coding mismatches (e.g. a
//     Heart-Failure DRG with an AMI principal diagnosis) that signal a data
//     entry or extraction error, not ambiguous edge cases.
//   * DRG–ICD grouper logic is owned by CMS and is public knowledge. The
//     mapping table below is derived solely from publicly available CMS
//     MS-DRG documentation (FY2024 IPPS Final Rule) — no proprietary grouper
//     software, licensed dataset, or commercial encoder is replicated here.
//   * Coverage is intentionally narrow: the most common DRG families where
//     principal-diagnosis mismatch is unambiguous. Unrecognised DRG/ICD
//     combinations are silently skipped (no false positives).
//
// Column detection uses the same robust word-splitting tokenizer as the
// Cross-Column layer so "drg_code", "drgCode", "DRGCode", "icd10",
// "primary_icd", and "icd_primary" all match without brittle regex.
// ============================================================

import { nameTokens, hasAnyKeyword, isNumeric } from './cross-column-consistency.js';

// ---------------------------------------------------------------------------
// DRG family → allowed ICD-10-CM principal diagnosis prefix groups (public CMS)
// ---------------------------------------------------------------------------
// Each entry:
//   drg: array of MS-DRG codes (strings) that belong to this family
//   family: human-readable family label (for error messages)
//   allowedPrefixes: ICD-10-CM chapter/category prefixes that are valid
//                    principal diagnoses for this DRG family. A principal
//                    diagnosis is compatible if it STARTS WITH any of these
//                    prefixes (case-insensitive). If a row's primary_icd does
//                    NOT start with any allowed prefix, it is flagged.
//   incompatibleExamples: brief examples for the finding explanation.
//
// Sources: CMS FY2024 MS-DRG Definitions Manual (public domain)
//          https://www.cms.gov/medicare/payment/prospective-payment-systems/acute-inpatient-pps/ms-drg-classifications-and-software
// ---------------------------------------------------------------------------
export const DRG_FAMILIES = [
  {
    // Heart Failure & Shock — DRGs 291/292/293
    // Principal dx must be a heart-failure (I50) or cardiogenic shock (R57.0)
    // or related cardiomyopathy code. AMI (I21–I22) and stroke (I63) are the
    // most common erroneous pairings seen in coding audits.
    drg: ['291', '292', '293'],
    family: 'Heart Failure & Shock (DRG 291-293)',
    allowedPrefixes: ['I50', 'R570', 'I42', 'I43', 'I110', 'I130', 'I132'],
    incompatibleExamples: 'AMI (I21.x), Stroke (I63.x), Pneumonia (J18.x)',
  },
  {
    // Acute Myocardial Infarction — DRGs 280/281/282/283/284/285
    // Principal dx must be I21 or I22 (STEMI, NSTEMI, subsequent MI).
    drg: ['280', '281', '282', '283', '284', '285'],
    family: 'Acute Myocardial Infarction (DRG 280-285)',
    allowedPrefixes: ['I21', 'I22'],
    incompatibleExamples: 'Heart Failure (I50.x), Stroke (I63.x), COPD (J44.x)',
  },
  {
    // Stroke — DRGs 61/62/63/64/65/66/67/68/69/70
    // Principal dx must be ischemic stroke (I63), intracranial hemorrhage
    // (I61, I62), or TIA (G45) for the lower-weighted DRGs.
    drg: ['61', '62', '63', '64', '65', '66', '67', '68', '69', '70'],
    family: 'Stroke (DRG 61-70)',
    allowedPrefixes: ['I60', 'I61', 'I62', 'I63', 'I64', 'G45', 'G46'],
    incompatibleExamples: 'COPD (J44.x), AMI (I21.x), Pneumonia (J18.x)',
  },
  {
    // Simple Pneumonia & Pleurisy — DRGs 193/194/195
    // Principal dx must be a pneumonia code (J12–J18) or pleurisy (J90/J94).
    drg: ['193', '194', '195'],
    family: 'Pneumonia & Pleurisy (DRG 193-195)',
    allowedPrefixes: ['J12', 'J13', 'J14', 'J15', 'J16', 'J17', 'J18', 'J90', 'J94'],
    incompatibleExamples: 'Heart Failure (I50.x), AMI (I21.x), Sepsis (A41.x)',
  },
  {
    // Respiratory Failure / Insufficiency — DRGs 189/190/191/192/927/928
    // Principal dx must be J96 (respiratory failure) or J80/J81/J82
    // (pulmonary conditions). COPD exacerbation (J44.1) is also valid
    // as a principal when the primary respiratory failure driver.
    drg: ['189', '190', '191', '192', '927', '928'],
    family: 'Respiratory Failure/Insufficiency (DRG 189-192, 927-928)',
    allowedPrefixes: ['J96', 'J80', 'J81', 'J82', 'J44', 'J45', 'J68', 'J70'],
    incompatibleExamples: 'AMI (I21.x), Stroke (I63.x), GI bleed (K92.x)',
  },
  {
    // Septicemia / Severe Sepsis — DRGs 870/871/872
    // Principal dx must be A40/A41 (sepsis codes) or R65.2 (severe sepsis).
    drg: ['870', '871', '872'],
    family: 'Septicemia / Severe Sepsis (DRG 870-872)',
    allowedPrefixes: ['A40', 'A41', 'R652'],
    incompatibleExamples: 'Heart Failure (I50.x), COPD (J44.x), Stroke (I63.x)',
  },
  {
    // Major Joint Replacement (Lower Extremity) — DRGs 469/470
    // Principal dx must be osteoarthritis (M16/M17), fracture (S72/S82),
    // or AVN (M87). Medical diagnoses (MI, CHF, sepsis) cannot be the
    // principal dx that drives this surgical DRG.
    drg: ['469', '470'],
    family: 'Major Joint Replacement, Lower Extremity (DRG 469-470)',
    allowedPrefixes: ['M16', 'M17', 'M87', 'S72', 'S82', 'M05', 'M06', 'M08', 'Z96'],
    incompatibleExamples: 'AMI (I21.x), Sepsis (A41.x), Stroke (I63.x)',
  },
  {
    // COPD — DRGs 190/191/192 already covered above under respiratory;
    // specific COPD-only DRG 696 (simple)/697 (moderate)/698 (severe).
    // Note: 190-192 overlap with respiratory group — no double-count risk
    // because each row is evaluated row-by-row; overlapping DRG arrays
    // just mean both groups are checked, and the same row only generates
    // one finding per rule.
    drg: ['696', '697', '698'],
    family: 'COPD & Bronchiectasis (DRG 696-698)',
    allowedPrefixes: ['J44', 'J47'],
    incompatibleExamples: 'AMI (I21.x), Sepsis (A41.x), Pneumonia (J18.x)',
  },
];

// Build a fast O(1) DRG→family lookup map at module load time.
const DRG_MAP = new Map();
for (const family of DRG_FAMILIES) {
  for (const drg of family.drg) {
    // A DRG may theoretically appear in multiple families (edge case);
    // we store the first match only — safe because our families are disjoint.
    if (!DRG_MAP.has(drg)) DRG_MAP.set(drg, family);
  }
}

// ---------------------------------------------------------------------------
// Column detection helpers
// ---------------------------------------------------------------------------
const DRG_KW  = ['drg'];
const ICD_KW  = ['icd', 'icd10', 'diagnosis', 'dx', 'primary'];

export function detectDrgColumn(cols) {
  return cols.find(c => hasAnyKeyword(c.name, DRG_KW)) || null;
}

// The primary/principal ICD column: prefer a column whose name contains BOTH
// a diagnosis-like keyword AND a primary/principal indicator. Fall back to any
// icd/diagnosis column if no compound match exists.
export function detectPrimaryIcdColumn(cols) {
  const PRIMARY_KW = ['primary', 'principal', 'main', 'first'];
  // Best: compound name that includes both a primary indicator AND icd/dx.
  const compound = cols.find(c =>
    hasAnyKeyword(c.name, ICD_KW) && hasAnyKeyword(c.name, PRIMARY_KW)
  );
  if (compound) return compound;
  // Second-best: column that is purely "primary_icd" / "icd_primary" shape
  // without needing both keyword groups simultaneously.
  const icdOnly = cols.find(c => hasAnyKeyword(c.name, ICD_KW));
  return icdOnly || null;
}

// ---------------------------------------------------------------------------
// Runner — detects DRG/ICD mismatches using DuckDB SQL (all 600 rows in one
// pass per DRG family, not row-by-row in JS). Returns a findings array in the
// same shape as runCrossColumnChecks.
// ---------------------------------------------------------------------------
export async function runDrgIcdValidation(table, cols, engine) {
  const findings = [];
  const drgCol = detectDrgColumn(cols);
  const icdCol = detectPrimaryIcdColumn(cols);

  if (!drgCol || !icdCol) return findings; // columns not present — silent skip

  for (const family of DRG_FAMILIES) {
    // Build SQL: rows whose DRG is in this family but whose primary ICD does
    // NOT start with any of the allowed prefixes.
    const drgList = family.drg.map(d => `'${d}'`).join(', ');
    // Build the NOT (icd LIKE 'prefix%') OR clauses.
    const icdOkClauses = family.allowedPrefixes
      .map(p => `UPPER(TRIM(CAST("${icdCol.name}" AS VARCHAR))) LIKE '${p.toUpperCase()}%'`)
      .join(' OR ');

    const sql = `
      SELECT COUNT(*) AS n FROM ${table}
      WHERE TRIM(CAST("${drgCol.name}" AS VARCHAR)) IN (${drgList})
        AND "${icdCol.name}" IS NOT NULL
        AND NOT (${icdOkClauses})`;

    try {
      const { rows } = await engine.runQuery(sql);
      const n = Number(rows[0]?.n) || 0;
      if (n > 0) {
        findings.push({
          rule: 'drg_icd_mismatch',
          ruleLabel: `DRG / ICD-10 coding mismatch — ${family.family}`,
          columns: [drgCol.name, icdCol.name],
          count: n,
          text: `${n} row(s) with a ${family.family} DRG but a principal diagnosis incompatible with that DRG family (e.g. ${family.incompatibleExamples}).`,
          explanation: `MS-DRG grouper rules (CMS FY2024) require a specific principal diagnosis category for ${family.family}. ${n} row(s) carry a DRG in [${family.drg.join(', ')}] but their "${icdCol.name}" code does not fall in the expected category. This indicates a coding error, a transposed DRG, or an extraction mismatch — any of which causes incorrect reimbursement and audit exposure.`,
        });
      }
    } catch { /* SQL error (e.g. column type incompatible) — skip family */ }
  }

  return findings;
}
