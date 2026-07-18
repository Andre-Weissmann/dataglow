// ============================================================
// DATAGLOW — Cross-Column Logical Consistency Checker (validation layer #17)
// Flags impossible or contradictory combinations of values ACROSS columns in
// the SAME row — contradictions a single-column validator can never see (an
// end date before its start, a male patient flagged pregnant, an infant with a
// married status, an "abnormal" lab flag with no measured value behind it).
//
// Everything runs client-side against the already-loaded DuckDB-WASM table.
// Column pairing is heuristic (name-pattern matching), never hardcoded to one
// dataset's columns, and deliberately conservative: a rule only fires when the
// column names give reasonably high confidence, and every finding carries the
// specific columns + values + a plain-language reason so the analyst can judge
// it for themselves.
//
// This is the generic, well-known data-quality concept of cross-field /
// referential validation, implemented from first principles.
// ============================================================

const NUMERIC_T = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];

// Robust word-splitting for column names. Splits snake_case, kebab-case,
// dotted, AND camelCase / PascalCase into lowercase tokens so that
// "admit_date", "admitDate", "AdmitDate" and "admit-date" all yield
// ["admit","date"]. This intentionally avoids naive regex `\b` boundaries
// (which mis-handle compound identifiers) — the same class of bug that was
// fixed in the Benford eligibility gate's name matching.
export function nameTokens(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // camelCase -> camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // HTTPServer -> HTTP Server
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// A keyword matches a column name when a token equals or starts with it, or
// when the concatenation of tokens contains it (so multi-token forms like
// "check_in" / "checkIn" both match the stem "checkin").
export function matchesKeyword(name, keyword) {
  const tokens = nameTokens(name);
  if (tokens.some(t => t === keyword || t.startsWith(keyword))) return true;
  return tokens.join('').includes(keyword);
}

export function hasAnyKeyword(name, keywords) {
  return keywords.some(kw => matchesKeyword(name, kw));
}

// A column is "date-like" if its declared type is a date/timestamp OR its name
// reads like a date/event-time column.
// Canonical temporal-event stems: columns whose names denote a point in time
// even without an explicit "date"/"time" suffix (e.g. a hotel's "check_in").
const TEMPORAL_EVENT_KW = ['date', 'time', 'admit', 'discharge', 'dob', 'birth', 'checkin', 'checkout', 'arrival', 'departure'];
export function isDateLike(c) {
  return /DATE|TIMESTAMP/i.test(c.type || '') ||
    hasAnyKeyword(c.name, TEMPORAL_EVENT_KW) ||
    /_at$|_on$/i.test(c.name);
}

export function isNumeric(c) {
  return NUMERIC_T.includes(c.type);
}

// ---------- Rule 1: date ordering ----------
// Semantically-linked ordered keyword groups. Pairing is confined WITHIN a
// group (earlier × later) rather than a global cross-product of every
// "start-ish" against every "end-ish" column — that keeps nonsensical pairs
// (e.g. hire_date × discharge_date) from firing.
export const DATE_ORDER_GROUPS = [
  { label: 'admission → discharge', earlier: ['admit', 'admission'], later: ['discharge'] },
  { label: 'start → end', earlier: ['start', 'begin', 'from', 'onset', 'open'], later: ['end', 'finish', 'stop', 'close', 'thru'] },
  { label: 'created → updated', earlier: ['created', 'create', 'opened'], later: ['updated', 'update', 'modified', 'closed', 'edited'] },
  { label: 'check-in → check-out', earlier: ['checkin', 'arrival', 'arrive'], later: ['checkout', 'departure', 'depart'] },
  { label: 'order → ship', earlier: ['order', 'ordered', 'purchase'], later: ['ship', 'shipped', 'delivery', 'delivered', 'fulfilled'] },
  { label: 'hire → termination', earlier: ['hire', 'hired', 'joined'], later: ['termination', 'terminated', 'left', 'resigned'] },
  { label: 'birth → death', earlier: ['birth', 'dob', 'born'], later: ['death', 'died', 'deceased', 'expired'] },
  { label: 'effective → expiry', earlier: ['effective', 'issued', 'issue'], later: ['expiry', 'expire', 'expiration', 'expires'] },
];

// Detect ordered date-column pairs. Returns [{ earlier, later, label }].
export function detectDatePairs(cols) {
  const dateCols = cols.filter(isDateLike);
  const pairs = [];
  const seen = new Set();
  for (const g of DATE_ORDER_GROUPS) {
    const earlierCols = dateCols.filter(c => hasAnyKeyword(c.name, g.earlier));
    const laterCols = dateCols.filter(c => hasAnyKeyword(c.name, g.later));
    for (const e of earlierCols) {
      for (const l of laterCols) {
        if (e.name === l.name) continue;
        const key = `${e.name}|${l.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ earlier: e.name, later: l.name, label: g.label });
      }
    }
  }
  return pairs;
}

// ---------- Rule 1b: numeric min/max range ----------
const MIN_KW = ['min', 'minimum', 'low', 'lower', 'floor'];
const MAX_KW = ['max', 'maximum', 'high', 'higher', 'ceiling', 'cap', 'upper'];

// Detect min/max (low/high) numeric range pairs. Confined to columns that
// share a stem (e.g. temp_min / temp_max) so unrelated "low"/"high" columns
// aren't paired. Returns [{ min, max }].
export function detectRangePairs(cols) {
  const numeric = cols.filter(isNumeric);
  const minCols = numeric.filter(c => hasAnyKeyword(c.name, MIN_KW));
  const maxCols = numeric.filter(c => hasAnyKeyword(c.name, MAX_KW));
  const pairs = [];
  for (const lo of minCols) {
    for (const hi of maxCols) {
      if (lo.name === hi.name) continue;
      if (sharedStem(lo.name, hi.name)) pairs.push({ min: lo.name, max: hi.name });
    }
  }
  return pairs;
}

// Two columns "share a stem" when they have at least one common token that is
// not itself a min/max keyword — i.e. they describe the same measured thing.
const RANGE_WORDS = new Set([...MIN_KW, ...MAX_KW]);
function sharedStem(a, b) {
  const ta = nameTokens(a).filter(t => !RANGE_WORDS.has(t));
  const tb = new Set(nameTokens(b).filter(t => !RANGE_WORDS.has(t)));
  if (ta.length === 0) return true; // e.g. bare "min"/"max" — treat as related
  return ta.some(t => tb.has(t));
}

// ---------- Rule 1c: semantic magnitude ordering ----------
// A generalization of Rule 1b for numeric pairs that carry a "column A must not
// exceed column B" relationship encoded in DOMAIN VOCABULARY rather than a
// min/max naming convention. The motivating real-world miss: healthcare billing
// columns like `amount_allowed` vs `amount_billed` — an allowed amount can never
// exceed the billed amount, and a paid amount can never exceed the allowed
// amount, yet neither name contains a min/max keyword so Rule 1b never pairs
// them. Rather than bloat the min/max vocabulary (which would mis-pair unrelated
// "low"/"high" columns), this is an explicit, small config of known
// lesser≤greater semantics — the same "hand-written domain config" shape the
// healthcare Domain Physics pack uses for its clinical rules. Pairing stays
// conservative: a group only fires when BOTH sides are numeric AND the columns
// share a stem (e.g. amount_allowed/amount_billed share "amount"), OR the
// lesser side reduces to a bare domain keyword (e.g. "allowed"/"billed"),
// mirroring Rule 1b's sharedStem discipline.
export const MAGNITUDE_ORDER_GROUPS = [
  { label: 'allowed ≤ billed', lesser: ['allowed'], greater: ['billed', 'charged', 'charge', 'gross'] },
  { label: 'paid ≤ allowed', lesser: ['paid', 'payment', 'reimbursed', 'reimbursement'], greater: ['allowed'] },
  { label: 'paid ≤ billed', lesser: ['paid', 'payment', 'reimbursed', 'reimbursement'], greater: ['billed', 'charged', 'charge', 'gross'] },
];

const MAGNITUDE_WORDS = new Set(MAGNITUDE_ORDER_GROUPS.flatMap(g => [...g.lesser, ...g.greater]));

// Shared-stem check for magnitude pairs: strip the domain keywords and require a
// common remaining token (so amount_allowed × amount_billed pair on "amount",
// but allowed_visits × billed_amount do NOT). When the lesser side is a bare
// keyword with nothing left over ("allowed"), treat the pair as related — the
// same permissive base case Rule 1b uses for bare "min"/"max".
function sharedMagnitudeStem(lesserName, greaterName) {
  const lt = nameTokens(lesserName).filter(t => !MAGNITUDE_WORDS.has(t));
  const gt = new Set(nameTokens(greaterName).filter(t => !MAGNITUDE_WORDS.has(t)));
  if (lt.length === 0) return true;
  return lt.some(t => gt.has(t));
}

// Detect semantic magnitude pairs. Returns [{ lesser, greater, label }] meaning
// the value in `lesser` should never exceed the value in `greater`.
export function detectMagnitudePairs(cols) {
  const numeric = cols.filter(isNumeric);
  const pairs = [];
  const seen = new Set();
  for (const g of MAGNITUDE_ORDER_GROUPS) {
    const lesserCols = numeric.filter(c => hasAnyKeyword(c.name, g.lesser));
    const greaterCols = numeric.filter(c => hasAnyKeyword(c.name, g.greater));
    for (const lo of lesserCols) {
      for (const hi of greaterCols) {
        if (lo.name === hi.name) continue;
        if (!sharedMagnitudeStem(lo.name, hi.name)) continue;
        const key = `${lo.name}|${hi.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ lesser: lo.name, greater: hi.name, label: g.label });
      }
    }
  }
  return pairs;
}

// ---------- Rule 2: impossible demographic combinations ----------
const SEX_TOKENS = ['sex', 'gender'];
const PREGNANCY_KW = ['pregnant', 'pregnancy', 'gestation', 'gestational', 'gravida', 'prenatal', 'antenatal', 'edd'];
const MARITAL_KW = ['marital', 'maritalstatus'];

export function detectSexColumn(cols) {
  return cols.find(c => nameTokens(c.name).some(t => SEX_TOKENS.includes(t))) || null;
}

export function detectPregnancyColumns(cols) {
  return cols.filter(c => hasAnyKeyword(c.name, PREGNANCY_KW));
}

export function detectAgeColumn(cols) {
  return cols.find(c => isNumeric(c) && nameTokens(c.name).includes('age')) || null;
}

export function detectMaritalColumn(cols) {
  return cols.find(c => hasAnyKeyword(c.name, MARITAL_KW)) || null;
}

// Value classifiers — deliberately narrow to avoid false positives on
// ambiguous encodings (we do NOT treat a numeric 0/1 sex code as male/female,
// because the mapping is unknowable from the schema alone).
const norm = v => String(v ?? '').trim().toLowerCase();

export function isMaleValue(v) {
  return ['m', 'male', 'man', 'boy'].includes(norm(v));
}

// Truthy / affirmative encodings for a boolean-ish flag.
export function isAffirmative(v) {
  return ['true', 't', 'yes', 'y', '1', 'positive', 'pos', 'pregnant'].includes(norm(v));
}

// A marital value that unambiguously implies a non-single adult (married,
// divorced, widowed, separated). "single"/"never married"/blanks do NOT fire.
export function maritalImpliesAdult(v) {
  return /marri|divorc|widow|separat|civil union|domestic partner/.test(norm(v));
}

// ---------- Rule 2b: minor with an adult-only status ----------
// Retained from the original layer so datasets that encode adult-only
// entitlements (retirement/pension/Medicare/etc.) on a boolean flag still fire.
const ADULT_ONLY_KW = ['retire', 'retirement', 'pension', '401k', 'isadult', 'hasmortgage', 'haslicense', 'issenior', 'medicare'];
export function detectAdultOnlyFlags(cols) {
  return cols.filter(c => hasAnyKeyword(c.name, ADULT_ONLY_KW));
}

// ---------- Rule 3: range/status contradiction ----------
// Detect a measurement (numeric) column paired with a companion status/flag
// column that shares its stem, e.g. glucose + glucose_flag, or potassium +
// potassium_status. Conservative firing (see runner): a flag asserting an
// out-of-range / abnormal result while the measurement is NULL — a flag with
// nothing behind it. No external reference ranges are required or assumed.
const STATUS_KW = ['flag', 'status', 'result', 'interpretation', 'abnormality'];
const ABNORMAL_VALUES = /crit|abnormal|out.?of.?range|panic|high|low|elevated|alert|positive|reactive/;

export function detectStatusPairs(cols) {
  const statusCols = cols.filter(c => hasAnyKeyword(c.name, STATUS_KW));
  const numericCols = cols.filter(isNumeric);
  const pairs = [];
  for (const s of statusCols) {
    const stem = nameTokens(s.name).filter(t => !STATUS_KW.includes(t));
    if (stem.length === 0) continue; // a bare "status" column has no measurement to bind to
    const stemSet = new Set(stem);
    for (const m of numericCols) {
      if (m.name === s.name) continue;
      const mt = nameTokens(m.name).filter(t => !STATUS_KW.includes(t));
      if (mt.length && mt.some(t => stemSet.has(t))) {
        pairs.push({ measurement: m.name, status: s.name });
      }
    }
  }
  return pairs;
}

export function isAbnormalStatus(v) {
  return ABNORMAL_VALUES.test(norm(v));
}

// ---------- SQL helpers ----------
const affirmativeSql = col =>
  `LOWER(TRIM(CAST(${col} AS VARCHAR))) IN ('true','t','yes','y','1','positive','pos','pregnant')`;

// ============================================================
// Runner — executes the detected rules against the loaded table and returns a
// structured findings array. Pure of side effects (no ledger writes): the
// caller decides how to log, mirroring the Categorical Consistency Engine.
//
// Each finding: { rule, ruleLabel, columns:[...], count, text, explanation }
//   text        — concise one-liner (used for the layer's `detail` list)
//   explanation — plain-language "why this is impossible"
// ============================================================
export async function runCrossColumnChecks(table, cols, engine, opts = {}) {
  // `magnitude` gates the Rule 1c semantic magnitude-ordering findings so the
  // caller can keep them dark behind a feature flag (default ON here so the pure
  // module stays directly unit-testable without flag plumbing).
  const { magnitude = true } = opts;
  const findings = [];
  const q = async sql => {
    const { rows } = await engine.runQuery(sql);
    return Number(rows[0]?.n) || 0;
  };

  // Rule 1 — date ordering (later date before earlier date).
  for (const p of detectDatePairs(cols)) {
    try {
      const n = await q(`
        SELECT COUNT(*) AS n FROM ${table}
        WHERE TRY_CAST("${p.earlier}" AS DATE) IS NOT NULL
          AND TRY_CAST("${p.later}" AS DATE) IS NOT NULL
          AND TRY_CAST("${p.later}" AS DATE) < TRY_CAST("${p.earlier}" AS DATE)`);
      if (n > 0) {
        findings.push({
          rule: 'date_order',
          ruleLabel: `Date ordering (${p.label})`,
          columns: [p.earlier, p.later],
          count: n,
          text: `${n} row(s) where "${p.later}" is before "${p.earlier}" — a later date cannot precede its earlier date.`,
          explanation: `"${p.later}" is expected to fall on or after "${p.earlier}" (${p.label}); ${n} row(s) violate that order.`,
        });
      }
    } catch { /* incompatible columns — skip pair */ }
  }

  // Rule 1b — numeric min/max range (max below min).
  for (const p of detectRangePairs(cols)) {
    try {
      const n = await q(`
        SELECT COUNT(*) AS n FROM ${table}
        WHERE "${p.min}" IS NOT NULL AND "${p.max}" IS NOT NULL AND "${p.max}" < "${p.min}"`);
      if (n > 0) {
        findings.push({
          rule: 'numeric_range',
          ruleLabel: 'Inverted numeric range',
          columns: [p.min, p.max],
          count: n,
          text: `${n} row(s) where "${p.max}" < "${p.min}" — a maximum cannot be below its minimum.`,
          explanation: `"${p.max}" should be ≥ "${p.min}"; ${n} row(s) have the range inverted.`,
        });
      }
    } catch { /* skip pair */ }
  }

  // Rule 1c — semantic magnitude ordering (lesser exceeds greater), e.g. a
  // healthcare claim's allowed amount exceeding the billed amount.
  if (magnitude) {
    for (const p of detectMagnitudePairs(cols)) {
      try {
        const n = await q(`
          SELECT COUNT(*) AS n FROM ${table}
          WHERE "${p.lesser}" IS NOT NULL AND "${p.greater}" IS NOT NULL AND "${p.lesser}" > "${p.greater}"`);
        if (n > 0) {
          findings.push({
            rule: 'magnitude_order',
            ruleLabel: `Magnitude ordering (${p.label})`,
            columns: [p.lesser, p.greater],
            count: n,
            text: `${n} row(s) where "${p.lesser}" > "${p.greater}" — ${p.label} should hold.`,
            explanation: `"${p.lesser}" is expected to be ≤ "${p.greater}" (${p.label}); ${n} row(s) violate that relationship.`,
          });
        }
      } catch { /* incompatible columns — skip pair */ }
    }
  }

  // Rule 2 — male patient flagged pregnant.
  const sexCol = detectSexColumn(cols);
  if (sexCol) {
    for (const preg of detectPregnancyColumns(cols)) {
      if (preg.name === sexCol.name) continue;
      try {
        const n = await q(`
          SELECT COUNT(*) AS n FROM ${table}
          WHERE LOWER(TRIM(CAST("${sexCol.name}" AS VARCHAR))) IN ('m','male','man','boy')
            AND ${affirmativeSql(`"${preg.name}"`)}`);
        if (n > 0) {
          findings.push({
            rule: 'sex_pregnancy',
            ruleLabel: 'Impossible demographic combination',
            columns: [sexCol.name, preg.name],
            count: n,
            text: `${n} row(s) where "${sexCol.name}" is male but "${preg.name}" indicates pregnancy.`,
            explanation: `A record marked male in "${sexCol.name}" cannot also be pregnant in "${preg.name}"; ${n} row(s) contradict.`,
          });
        }
      } catch { /* skip */ }
    }
  }

  // Rule 2b — infant (age < 1) with an adult marital status.
  const ageCol = detectAgeColumn(cols);
  const maritalCol = detectMaritalColumn(cols);
  if (ageCol && maritalCol) {
    try {
      const { rows } = await engine.runQuery(`
        SELECT LOWER(TRIM(CAST("${maritalCol.name}" AS VARCHAR))) AS v, COUNT(*) AS n
        FROM ${table}
        WHERE "${ageCol.name}" IS NOT NULL AND "${ageCol.name}" < 1
          AND "${maritalCol.name}" IS NOT NULL
        GROUP BY 1`);
      const n = rows.filter(r => maritalImpliesAdult(r.v)).reduce((a, r) => a + Number(r.n), 0);
      if (n > 0) {
        findings.push({
          rule: 'infant_marital',
          ruleLabel: 'Impossible demographic combination',
          columns: [ageCol.name, maritalCol.name],
          count: n,
          text: `${n} row(s) where "${ageCol.name}" < 1 but "${maritalCol.name}" is an adult status (married/divorced/widowed).`,
          explanation: `An infant (age < 1 in "${ageCol.name}") cannot have a married/divorced/widowed "${maritalCol.name}"; ${n} row(s) contradict.`,
        });
      }
    } catch { /* skip */ }
  }

  // Rule 2c — minor (age < 18) with an adult-only status flag.
  if (ageCol) {
    for (const flag of detectAdultOnlyFlags(cols)) {
      if (flag.name === ageCol.name) continue;
      try {
        const n = await q(`
          SELECT COUNT(*) AS n FROM ${table}
          WHERE "${ageCol.name}" < 18 AND ${affirmativeSql(`"${flag.name}"`)}`);
        if (n > 0) {
          findings.push({
            rule: 'minor_adult_status',
            ruleLabel: 'Impossible demographic combination',
            columns: [ageCol.name, flag.name],
            count: n,
            text: `${n} row(s) where "${ageCol.name}" < 18 but "${flag.name}" is true — an adult-only status on a minor.`,
            explanation: `"${flag.name}" is an adult-only entitlement; ${n} row(s) set it true for a minor (age < 18 in "${ageCol.name}").`,
          });
        }
      } catch { /* skip */ }
    }
  }

  // Rule 3 — status/flag says abnormal but the measurement is missing.
  for (const p of detectStatusPairs(cols)) {
    try {
      const { rows } = await engine.runQuery(`
        SELECT LOWER(TRIM(CAST("${p.status}" AS VARCHAR))) AS v, COUNT(*) AS n
        FROM ${table}
        WHERE "${p.measurement}" IS NULL AND "${p.status}" IS NOT NULL
        GROUP BY 1`);
      const n = rows.filter(r => isAbnormalStatus(r.v)).reduce((a, r) => a + Number(r.n), 0);
      if (n > 0) {
        findings.push({
          rule: 'status_without_measure',
          ruleLabel: 'Range/status contradiction',
          columns: [p.measurement, p.status],
          count: n,
          text: `${n} row(s) where "${p.status}" reports an abnormal result but "${p.measurement}" has no value.`,
          explanation: `"${p.status}" asserts an out-of-range/abnormal result, yet the measurement "${p.measurement}" is missing on ${n} row(s) — nothing substantiates the flag.`,
        });
      }
    } catch { /* skip */ }
  }

  // Rule 4 — LOS field vs date math mismatch.
  // The los_days (length-of-stay) column, when present alongside admit and
  // discharge date columns, must match the integer difference between those
  // two dates. A mismatch of ≥ 2 days (allowing ±1 rounding convention) is
  // a clear data error — either the LOS field was copied from a prior
  // encounter, manually overridden, or the dates were corrected without
  // updating the derived field.
  const losCol = cols.find(c => {
    const t = nameTokens(c.name);
    return (t.includes('los') || (t.includes('length') && t.includes('stay'))) && isNumeric(c);
  });
  if (losCol) {
    // Find an admit/discharge date pair within the already-detected date pairs,
    // or fall back to any column whose name contains both the admit and
    // discharge tokens from detectDatePairs.
    const admitCol = cols.find(c => hasAnyKeyword(c.name, ['admit', 'admission']));
    const dischargeCol = cols.find(c => hasAnyKeyword(c.name, ['discharge']));
    if (admitCol && dischargeCol && admitCol.name !== dischargeCol.name) {
      try {
        const n = await q(`
          SELECT COUNT(*) AS n FROM ${table}
          WHERE "${admitCol.name}" IS NOT NULL
            AND "${dischargeCol.name}" IS NOT NULL
            AND "${losCol.name}" IS NOT NULL
            AND ABS(
              CAST("${losCol.name}" AS INTEGER)
              - DATEDIFF('day',
                  TRY_CAST("${admitCol.name}" AS DATE),
                  TRY_CAST("${dischargeCol.name}" AS DATE)
              )
            ) >= 2`);
        if (n > 0) {
          findings.push({
            rule: 'los_date_mismatch',
            ruleLabel: 'LOS field vs date arithmetic mismatch',
            columns: [losCol.name, admitCol.name, dischargeCol.name],
            count: n,
            text: `${n} row(s) where "${losCol.name}" differs from ("${dischargeCol.name}" − "${admitCol.name}") by ≥2 days — the stored LOS does not match the actual stay duration.`,
            explanation: `"${losCol.name}" should equal the calendar-day difference between "${admitCol.name}" and "${dischargeCol.name}". ${n} row(s) have a discrepancy of 2+ days, indicating the field was not recomputed after a date correction, was copied from another record, or was manually entered incorrectly.`,
          });
        }
      } catch { /* incompatible columns or missing DATEDIFF — skip */ }
    }
  }

  return findings;
}
