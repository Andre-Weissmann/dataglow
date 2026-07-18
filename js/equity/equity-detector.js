// ============================================================
// DATAGLOW — Equity Column Detector (Phase 3)
// ============================================================
// Auto-detects which columns in a dataset are equity-relevant stratifiers
// (race/ethnicity, sex/gender, zip/geography, payer class) and which columns
// are outcome metrics worth stratifying (LOS, readmit flags, denial flags,
// claim amounts, mortality flags).
//
// WHY THIS EXISTS:
// Post-2023 CMS health equity mandates and the CMS Disparities Impact Statement
// requirement mean that any dataset used for quality reporting MUST be analyzed
// for equity. Doing it manually is slow and inconsistently applied. DataGlow
// detects the relevant columns automatically so the equity layer runs without
// any configuration -- it just works on whatever you load.
//
// DOMAIN-AGNOSTIC:
// The detector uses name heuristics, so it works on any domain. A Lego dataset
// with a "country" column and a "price" outcome gets the same treatment as a
// claims dataset with "race_cd" and "readmit_30d". The column name patterns are
// intentionally broad.
//
// DESIGN:
// Pure and synchronous. Takes an array of {name, type} column descriptors and
// returns classified lists. No DuckDB, no DOM, no network.

// ---- Stratifier patterns ---------------------------------------------------
// These columns are the "by what" axis of an equity analysis.

const RACE_ETHNICITY_PATTERN = /^(race|ethnicity|ethnic|race_cd|race_code|race_category|eth|eth_cd|ethni|race_eth|racial|hispanic|latinx|nhopi|aian|black|white|asian)($|_)/i;

const SEX_GENDER_PATTERN = /^(sex|gender|sex_cd|gender_cd|biological_sex|patient_sex|member_gender|gender_identity|sex_at_birth)($|_)/i;

const ZIP_GEO_PATTERN = /^(zip|zip_code|zipcode|postal|postal_code|zip5|zip3|county|county_cd|fips|state|region|city|metro|cbsa|hrr|hsa|zcta|geoid|census_tract)($|_)/i;

const PAYER_PATTERN = /^(payer|payer_cd|payer_type|payer_class|insurance|ins_type|plan_type|coverage_type|financial_class|fin_class|primary_payer|sec_payer|mco|medicaid|medicare|commercial|self_pay|uninsured|charity)($|_)/i;

const AGE_GROUP_PATTERN = /^(age_group|age_band|age_cat|age_category|age_range|age_bucket|pediatric|geriatric|adult)($|_)/i;

const DISABILITY_PATTERN = /^(disability|disabled|duals|dual_eligible|ltss|snp|chronic)($|_)/i;

// ---- Outcome metric patterns -----------------------------------------------
// These columns are the "measure what" axis.

const LOS_PATTERN = /^(los|length_of_stay|los_days|alos|days|inpatient_days|icu_days|vent_days)($|_)/i;

const READMIT_PATTERN = /^(readmit|readmission|re_admit|readmitted|readmit_30d|readmit_90d|readmit_7d|hospital_readmission|unplanned_readmit)($|_)/i;

const DENIAL_PATTERN = /^(denied|denial|denied_flag|claim_denied|initial_denial|pended|rejected|denial_reason)($|_)/i;

const MORTALITY_PATTERN = /^(mortality|died|deceased|death|expired|death_flag|inpatient_death|mortality_flag|dod|date_of_death)($|_)/i;

const CLAIM_AMOUNT_PATTERN = /^(claim_amount|billed|billed_amount|allowed|allowed_amount|paid|paid_amount|charge|charges|total_charge|reimbursement|cost|total_cost|price|revenue|amount)($|_)/i;

const ED_PATTERN = /^(ed_visit|er_visit|emergency|ed_flag|emergent|ed_admit|er_admit)($|_)/i;

const QUALITY_PATTERN = /^(quality|hcahps|star|score|rating|satisfaction|composite|measure)($|_)/i;

// ---- Numeric type check ----------------------------------------------------
const NUMERIC_TYPES = new Set(['INTEGER', 'BIGINT', 'DOUBLE', 'FLOAT', 'DECIMAL', 'NUMERIC', 'REAL', 'SMALLINT', 'TINYINT', 'HUGEINT', 'INT', 'INT4', 'INT8', 'FLOAT4', 'FLOAT8']);

function isNumericType(type) {
  if (!type) return false;
  return NUMERIC_TYPES.has(type.toUpperCase().split('(')[0].trim());
}

function isBinaryLike(type) {
  // BIT, BOOLEAN, or INTEGER (0/1 flags)
  const t = (type || '').toUpperCase().split('(')[0].trim();
  return t === 'BOOLEAN' || t === 'BIT';
}

// ---- Main detector ---------------------------------------------------------

/**
 * Classify columns into equity stratifiers and outcome metrics.
 *
 * @param {Array<{name:string, type:string}>} cols
 * @returns {{
 *   stratifiers: Array<{name, type, role, roleLabel}>,
 *   metrics: Array<{name, type, kind, kindLabel, numeric}>,
 *   hasEquityData: boolean,
 *   summary: string,
 * }}
 */
export function detectEquityColumns(cols) {
  const stratifiers = [];
  const metrics = [];
  const colArr = Array.isArray(cols) ? cols : [];

  for (const col of colArr) {
    const name = (col && col.name) ? String(col.name) : '';
    const type = (col && col.type) ? String(col.type) : 'VARCHAR';
    if (!name) continue;

    // --- Stratifier detection (order matters: more specific first) ---
    if (RACE_ETHNICITY_PATTERN.test(name)) {
      stratifiers.push({ name, type, role: 'race_ethnicity', roleLabel: 'Race / Ethnicity' });
      continue;
    }
    if (SEX_GENDER_PATTERN.test(name)) {
      stratifiers.push({ name, type, role: 'sex_gender', roleLabel: 'Sex / Gender' });
      continue;
    }
    if (ZIP_GEO_PATTERN.test(name)) {
      stratifiers.push({ name, type, role: 'geography', roleLabel: 'Geography' });
      continue;
    }
    if (PAYER_PATTERN.test(name)) {
      stratifiers.push({ name, type, role: 'payer', roleLabel: 'Payer / Coverage' });
      continue;
    }
    if (AGE_GROUP_PATTERN.test(name)) {
      stratifiers.push({ name, type, role: 'age_group', roleLabel: 'Age Group' });
      continue;
    }
    if (DISABILITY_PATTERN.test(name)) {
      stratifiers.push({ name, type, role: 'disability', roleLabel: 'Disability / Dual Status' });
      continue;
    }

    // --- Metric detection ---
    const numeric = isNumericType(type);
    if (READMIT_PATTERN.test(name)) {
      metrics.push({ name, type, kind: 'readmission', kindLabel: 'Readmission', numeric });
      continue;
    }
    if (DENIAL_PATTERN.test(name)) {
      metrics.push({ name, type, kind: 'denial', kindLabel: 'Denial', numeric });
      continue;
    }
    if (MORTALITY_PATTERN.test(name)) {
      metrics.push({ name, type, kind: 'mortality', kindLabel: 'Mortality', numeric });
      continue;
    }
    if (LOS_PATTERN.test(name)) {
      metrics.push({ name, type, kind: 'los', kindLabel: 'Length of Stay', numeric });
      continue;
    }
    if (CLAIM_AMOUNT_PATTERN.test(name) && numeric) {
      metrics.push({ name, type, kind: 'cost', kindLabel: 'Cost / Amount', numeric });
      continue;
    }
    if (ED_PATTERN.test(name)) {
      metrics.push({ name, type, kind: 'ed_utilization', kindLabel: 'ED Utilization', numeric });
      continue;
    }
    if (QUALITY_PATTERN.test(name) && numeric) {
      metrics.push({ name, type, kind: 'quality', kindLabel: 'Quality Score', numeric });
      continue;
    }
  }

  const hasEquityData = stratifiers.length > 0 && metrics.length > 0;

  const parts = [];
  if (stratifiers.length > 0) {
    parts.push(stratifiers.length + ' stratifier(s): ' + stratifiers.map(s => s.roleLabel).join(', '));
  }
  if (metrics.length > 0) {
    parts.push(metrics.length + ' metric(s): ' + metrics.map(m => m.kindLabel).join(', '));
  }
  const summary = hasEquityData
    ? 'Equity analysis possible -- ' + parts.join(' | ') + '.'
    : stratifiers.length > 0
      ? 'Stratifier columns detected but no outcome metrics found -- equity analysis skipped.'
      : metrics.length > 0
        ? 'Outcome metrics detected but no stratifier columns found -- equity analysis skipped.'
        : 'No equity-relevant columns detected.';

  return { stratifiers, metrics, hasEquityData, summary };
}

// Export patterns for tests
export {
  RACE_ETHNICITY_PATTERN, SEX_GENDER_PATTERN, ZIP_GEO_PATTERN,
  PAYER_PATTERN, AGE_GROUP_PATTERN, READMIT_PATTERN, DENIAL_PATTERN,
  MORTALITY_PATTERN, LOS_PATTERN, CLAIM_AMOUNT_PATTERN,
};
