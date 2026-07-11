// ============================================================
// DATAGLOW — De-identification Verifier + signed attestation
// ============================================================
// A one-click checker that runs the 18 HIPAA Safe Harbor identifier categories
// (§164.514(b)(2)) against a loaded dataset's columns and sampled values, scores
// a basic re-identification risk from the indirect ("quasi") identifiers present
// and their combination, and produces a SIGNED attestation of the result.
//
// It runs entirely client-side against the in-browser DuckDB-WASM data — no
// upload, no external API. The signature is a SHA-256 digest over the dataset's
// STRUCTURE + the check results + a timestamp, computed with the SAME Web-Crypto
// primitive the CI provenance ledger and the chain-of-custody attestation use
// (`sha256Hex` from js/provenance/provenance.js) — no new crypto is introduced.
//
// HONEST LABELLING (legal-risk constraint, mirrored from provenance.js): this is
// an automated screening aid, NOT a certification that a dataset is HIPAA
// de-identified. Safe Harbor de-identification is a determination a qualified
// person makes; a column-name/value heuristic can miss identifiers and can
// over-flag. The report says "flag for review", never "safe to release".

import { sha256Hex } from './provenance.js';

// ---- helpers ---------------------------------------------------------------

function nonNull(values) {
  return (Array.isArray(values) ? values : []).filter(v => v !== null && v !== undefined && v !== '');
}

// Fraction of sampled values matching a pattern. A category's value-detector
// fires when the fraction clears a threshold, so one stray match doesn't flag
// and a column that is mostly identifiers does.
function valueMatchFraction(values, pattern) {
  const vals = nonNull(values);
  if (!vals.length || !pattern) return { count: 0, frac: 0, total: vals.length };
  let count = 0;
  for (const v of vals) { if (pattern.test(String(v))) count++; }
  return { count, frac: count / vals.length, total: vals.length };
}

// ---- the 18 Safe Harbor categories -----------------------------------------
// Each: id, n (1..18), label, optional namePattern (regex on the column name)
// and valuePattern (regex on sampled values). The generic "other unique id"
// category (n=18) is detected specially in checkSafeHarbor (leftover columns).

const VALUE_THRESHOLD = 0.5;

export const HIPAA_SAFE_HARBOR = [
  { id: 'names', n: 1, label: 'Names',
    namePattern: /(^|_)(name|surname|first_?name|last_?name|full_?name|middle_?name|maiden|given|patient|provider_name)($|_)/i },
  { id: 'geo', n: 2, label: 'Geographic subdivisions smaller than a state',
    namePattern: /(^|_)(address|street|city|county|precinct|zip|zipcode|postal|postcode|geo|location|region|district|neighbou?rhood)($|_)/i,
    valuePattern: /^\d{5}(-\d{4})?$/ },
  { id: 'dates', n: 3, label: 'Dates (except year) and all ages over 89',
    namePattern: /(^|_)(dob|birth|birth_?date|date_of_birth|admission|admit|discharge|death|deceased|expire|dod|date|_dt|visit_date|service_date|encounter_date)($|_)/i,
    valuePattern: /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/ },
  { id: 'telephone', n: 4, label: 'Telephone numbers',
    namePattern: /(^|_)(phone|tel|telephone|mobile|cell|contact_?number)($|_)/i,
    valuePattern: /^\+?[\d][\d\-().\s]{7,}\d$/ },
  { id: 'fax', n: 5, label: 'Fax numbers',
    namePattern: /(^|_)fax($|_)/i },
  { id: 'email', n: 6, label: 'Email addresses',
    namePattern: /(^|_)(email|e_?mail)($|_)/i,
    valuePattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ },
  { id: 'ssn', n: 7, label: 'Social Security numbers',
    namePattern: /(^|_)(ssn|social_?security|social)($|_)/i,
    valuePattern: /^\d{3}-?\d{2}-?\d{4}$/ },
  { id: 'mrn', n: 8, label: 'Medical record numbers',
    namePattern: /(^|_)(mrn|medical_?record|med_?rec|record_?number|chart_?number)($|_)/i },
  { id: 'beneficiary', n: 9, label: 'Health plan beneficiary numbers',
    namePattern: /(^|_)(beneficiary|health_?plan|member_?id|subscriber|insurance_?id|policy_?number|plan_?id)($|_)/i },
  { id: 'account', n: 10, label: 'Account numbers',
    namePattern: /(^|_)(account|acct|acct_?no|account_?number|iban)($|_)/i },
  { id: 'license', n: 11, label: 'Certificate / license numbers',
    namePattern: /(^|_)(license|licence|certificate|cert_?no|npi|dea|permit)($|_)/i },
  { id: 'vehicle', n: 12, label: 'Vehicle identifiers and serial numbers',
    namePattern: /(^|_)(vehicle|vin|license_?plate|plate|vehicle_?id)($|_)/i,
    valuePattern: /^[A-HJ-NPR-Z0-9]{17}$/ },
  { id: 'device', n: 13, label: 'Device identifiers and serial numbers',
    namePattern: /(^|_)(device|serial|serial_?no|device_?id|imei|udi)($|_)/i },
  { id: 'url', n: 14, label: 'Web URLs',
    namePattern: /(^|_)(url|website|link|homepage|uri)($|_)/i,
    valuePattern: /^https?:\/\/\S+$/i },
  { id: 'ip', n: 15, label: 'IP addresses',
    namePattern: /(^|_)(ip|ip_?address|ipaddr|ipv4|ipv6)($|_)/i,
    valuePattern: /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,}:[0-9a-f:]+$/i },
  { id: 'biometric', n: 16, label: 'Biometric identifiers',
    namePattern: /(^|_)(biometric|finger_?print|voice_?print|retina|iris|dna|face_?scan)($|_)/i },
  { id: 'photo', n: 17, label: 'Full-face photographs and comparable images',
    namePattern: /(^|_)(photo|photograph|image|face|picture|headshot|selfie|img|avatar)($|_)/i },
  { id: 'other', n: 18, label: 'Any other unique identifying number, characteristic, or code',
    namePattern: /(^|_)(id|uuid|guid|identifier|code|token|api_?key|apikey|ref|reference)($|_)/i },
];

// A column matches the special "age over 89" clause of category 3.
function ageOver89(colName, values) {
  if (!/(^|_)age($|_)/i.test(colName)) return false;
  return nonNull(values).some(v => {
    const num = Number(v);
    return Number.isFinite(num) && num > 89;
  });
}

// ---- Safe Harbor check ------------------------------------------------------

// Run all 18 categories against a { columns, samples } snapshot. `columns` is
// [{ name, type }, ...]; `samples` is { columnName: [sampledValues] }.
export function checkSafeHarbor({ columns = [], samples = {} } = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const matchedAnyCategory = new Set(); // column names claimed by categories 1..17

  const categories = HIPAA_SAFE_HARBOR.map(cat => {
    const matchedColumns = [];
    if (cat.id === 'other') return { ...catResult(cat, matchedColumns) }; // filled in a second pass

    for (const c of cols) {
      const name = c.name;
      const values = samples[name];
      const reasons = [];
      if (cat.namePattern && cat.namePattern.test(name)) reasons.push(`column name matches ${cat.label.toLowerCase()}`);
      if (cat.valuePattern) {
        const { count, frac } = valueMatchFraction(values, cat.valuePattern);
        if (count > 0 && frac >= VALUE_THRESHOLD) reasons.push(`sampled values look like ${cat.label.toLowerCase()}`);
      }
      if (cat.id === 'dates' && ageOver89(name, values)) reasons.push('contains an age value over 89');
      if (reasons.length) {
        matchedColumns.push({ column: name, reason: reasons.join('; ') });
        matchedAnyCategory.add(name);
      }
    }
    return catResult(cat, matchedColumns);
  });

  // Second pass — category 18: any remaining column whose name looks like a
  // generic unique identifier and wasn't already claimed by a specific category.
  const other = categories.find(c => c.id === 'other');
  const otherCat = HIPAA_SAFE_HARBOR.find(c => c.id === 'other');
  for (const c of cols) {
    if (matchedAnyCategory.has(c.name)) continue;
    if (otherCat.namePattern.test(c.name)) {
      other.matchedColumns.push({ column: c.name, reason: 'column name looks like a unique identifier/code' });
    }
  }
  other.status = other.matchedColumns.length ? 'flag' : 'clear';

  const flaggedCount = categories.filter(c => c.status === 'flag').length;
  return { categories, flaggedCount, clearCount: categories.length - flaggedCount };
}

function catResult(cat, matchedColumns) {
  return {
    id: cat.id, n: cat.n, label: cat.label,
    status: matchedColumns.length ? 'flag' : 'clear',
    matchedColumns,
  };
}

// ---- re-identification risk -------------------------------------------------

// Indirect / quasi-identifiers: not directly identifying on their own, but in
// combination can single out an individual (Sweeney's classic {DOB, sex, ZIP}
// result). Detected by column name.
const QUASI = [
  { id: 'age', pattern: /(^|_)age($|_)/i },
  { id: 'dob', pattern: /(^|_)(dob|birth|date_of_birth)($|_)/i },
  { id: 'sex', pattern: /(^|_)(sex|gender)($|_)/i },
  { id: 'zip', pattern: /(^|_)(zip|zipcode|postal|postcode)($|_)/i },
  { id: 'race', pattern: /(^|_)(race|ethnic|ethnicity)($|_)/i },
  { id: 'marital', pattern: /(^|_)(marital|marriage)($|_)/i },
];

export function scoreReidentificationRisk({ columns = [], samples = {}, rowCount = null } = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const present = [];
  for (const q of QUASI) {
    if (cols.some(c => q.pattern.test(c.name)) && !present.includes(q.id)) present.push(q.id);
  }

  let score = Math.min(present.length * 18, 90);
  // The well-known {date-of-birth or age, sex, ZIP} combination is the canonical
  // high-risk quasi-identifier trio.
  const hasDate = present.includes('dob') || present.includes('age');
  const trio = hasDate && present.includes('sex') && present.includes('zip');
  if (trio) score = Math.min(score + 30, 100);
  // A very small dataset makes any quasi-identifier combination more re-identifying.
  if (present.length >= 2 && typeof rowCount === 'number' && rowCount > 0 && rowCount < 50) {
    score = Math.min(score + 10, 100);
  }

  const level = score >= 67 ? 'high' : score >= 34 ? 'moderate' : 'low';
  const rationale = present.length === 0
    ? 'No indirect identifiers detected among the columns.'
    : `${present.length} indirect identifier(s) present (${present.join(', ')})${trio ? '; the {date/age, sex, ZIP} combination is a known high-risk quasi-identifier set' : ''}.`;
  return { score, level, present, quasiIdentifierCount: present.length, rationale };
}

// ---- combined report --------------------------------------------------------

export function buildDeidReport({ columns = [], samples = {}, table = null, rowCount = null } = {}) {
  const safeHarbor = checkSafeHarbor({ columns, samples });
  const reidentification = scoreReidentificationRisk({ columns, samples, rowCount });
  let verdict;
  if (safeHarbor.flaggedCount > 0) verdict = 'fail';
  else if (reidentification.level === 'high') verdict = 'fail';
  else if (reidentification.level === 'moderate') verdict = 'review';
  else verdict = 'pass';
  return {
    generatedAt: new Date().toISOString(),
    dataset: {
      table: table ?? null,
      rowCount: rowCount ?? null,
      columns: (Array.isArray(columns) ? columns : []).map(c => ({ name: c.name, type: c.type ?? null })),
    },
    safeHarbor,
    reidentification,
    verdict,
  };
}

// ---- signed attestation -----------------------------------------------------

const DEID_ATTESTATION_KIND = 'dataglow-deidentification-attestation';
const DEID_ATTESTATION_VERSION = 1;

// The canonical core the digest commits to: the dataset structure, both check
// results, the verdict, and the timestamp. The digest itself is excluded so it
// is a stable function of the content.
function deidCore(att) {
  return {
    kind: att.kind,
    version: att.version,
    generatedAt: att.generatedAt,
    algorithm: att.algorithm,
    dataset: att.dataset,
    safeHarbor: att.safeHarbor,
    reidentification: att.reidentification,
    verdict: att.verdict,
  };
}

export async function computeDeidDigest(att) {
  return sha256Hex(JSON.stringify(deidCore(att)));
}

export async function buildDeidAttestation(report, meta = {}) {
  const dataset = {
    table: meta.table ?? (report.dataset ? report.dataset.table : null),
    rowCount: meta.rowCount ?? (report.dataset ? report.dataset.rowCount : null),
    columns: report.dataset ? report.dataset.columns : [],
  };
  const att = {
    kind: DEID_ATTESTATION_KIND,
    version: DEID_ATTESTATION_VERSION,
    generatedAt: report.generatedAt || new Date().toISOString(),
    algorithm: 'SHA-256 digest over dataset structure + check results + timestamp',
    dataset,
    safeHarbor: report.safeHarbor,
    reidentification: report.reidentification,
    verdict: report.verdict,
    disclaimer: 'Automated HIPAA Safe Harbor screening aid, not a certification of de-identification. '
      + 'A heuristic over column names and sampled values can miss identifiers and can over-flag. '
      + 'Safe Harbor de-identification is a determination a qualified person must make. '
      + 'This document is a cryptographic integrity record only — not a legal, clinical, or regulatory determination.',
  };
  const digest = await computeDeidDigest(att);
  att.digest = {
    algorithm: 'SHA-256',
    value: digest,
    covers: 'kind, version, generatedAt, algorithm, dataset, safeHarbor, reidentification, verdict',
  };
  return att;
}

// Independently re-verify a de-identification attestation: recompute the digest
// over its canonical core and confirm it matches the stored value.
export async function verifyDeidAttestation(att) {
  if (!att || att.kind !== DEID_ATTESTATION_KIND) {
    return { valid: false, reason: 'Not a DATAGLOW de-identification attestation (missing/incorrect "kind").', digest: null };
  }
  const recomputed = await computeDeidDigest(att);
  const stored = att.digest && att.digest.value;
  const valid = !!stored && recomputed === stored;
  return {
    valid,
    reason: valid
      ? 'De-identification attestation verified: the document digest matches its content. (Integrity check only — not a certification of de-identification.)'
      : 'The document digest does not match its content — the attestation was modified after it was produced.',
    digest: { valid, stored: stored || null, recomputed },
  };
}

// ---- DuckDB-WASM wrapper (client-side, zero upload) -------------------------

const SAMPLE_LIMIT = 50;

// Run the full check against a loaded DuckDB table: sample a handful of values
// per column (zero network — the engine is the in-browser DuckDB-WASM), build
// the report, and sign it. `engine` is js/app-shell/duckdb-engine.js (or any
// object exposing async runQuery + getRowCount), so the app and the tests share
// one code path.
export async function runDeidentificationCheck(table, cols, engine) {
  const columns = Array.isArray(cols) ? cols : [];
  let rowCount = null;
  try { rowCount = await engine.getRowCount(table); } catch { rowCount = null; }

  const samples = {};
  for (const c of columns) {
    try {
      const { rows } = await engine.runQuery(
        `SELECT "${c.name}" FROM ${table} WHERE "${c.name}" IS NOT NULL LIMIT ${SAMPLE_LIMIT}`
      );
      samples[c.name] = (rows || []).map(r => r[c.name]);
    } catch {
      samples[c.name] = [];
    }
  }

  const report = buildDeidReport({ columns, samples, table, rowCount });
  const attestation = await buildDeidAttestation(report, { table, rowCount });
  return { report, attestation };
}
