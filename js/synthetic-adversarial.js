// ============================================================
// DATAGLOW — Synthetic Adversarial Test Generator ("Red Team Mode v2")
// ============================================================
// Given any real dataset's schema (column names + inferred types), synthesize
// a fresh, schema-matched test file seeded with the same categories of issues
// DATAGLOW's validation layers are built to catch. Every new dataset can then
// be self-tested against a custom adversarial fixture before the real analysis
// runs — the golden dataset generalized to arbitrary schemas.
//
// This is deterministic (seeded PRNG) so a schema always yields the same test
// file, and it returns a machine-readable manifest of exactly what issue was
// planted where, so a caller can assert the layers caught each one.
//
// Pure JS, no DOM/engine — unit-testable in Node. Reuses the same issue
// taxonomy as buildGoldenDataset() in loaders.js rather than inventing a new
// one; it just projects that taxonomy onto whatever columns exist.

const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT', 'DECIMAL', 'REAL'];

const START_KW = ['start', 'begin', 'admit', 'admission', 'open', 'onset', 'hire', 'issue', 'effective'];
const END_KW = ['end', 'finish', 'discharge', 'close', 'stop', 'exit', 'termination', 'expiry', 'expire', 'completion', 'return'];
const DATE_KW = /date|admit|discharge|_at$|_on$|time|dob|birth/i;
const AGE_KW = /\bage\b/i;
const ADULT_ONLY_KW = /retire|retirement|pension|401k|is_?adult|has_?mortgage|has_?license|is_?senior|medicare/i;
const AMOUNT_KW = /amount|revenue|sales|price|cost|charge|balance|income|salary|payment|total|value|spend|budget|claim/i;
const COUNTRY_KW = /country|nation|geo|geography|region|state|province/i;

// Deterministic PRNG (mulberry32, public domain) so output is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tokens(name) {
  return String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function hasKw(name, kws) {
  const t = tokens(name);
  return kws.some(k => t.some(tok => tok.startsWith(k)));
}
function isNumeric(type) { return NUMERIC_TYPES.includes(String(type || '').toUpperCase()); }
function isDateLike(col) { return /DATE|TIMESTAMP/i.test(col.type) || DATE_KW.test(col.name); }

const COUNTRY_CANON = ['United States', 'France', 'Germany', 'Canada'];
const GENERIC_CATS = ['Alpha', 'Beta', 'Gamma', 'Delta'];

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function baseNumeric(col, i, rand) {
  const name = col.name;
  if (AGE_KW.test(name)) return 20 + Math.floor(rand() * 60);          // bounded human range
  if (AMOUNT_KW.test(name)) return Math.round((100 + rand() * 9900) * 100) / 100; // multiplicative magnitude
  return Math.round((1 + rand() * 99) * 100) / 100;
}

function baseCategorical(col, i) {
  const pool = hasKw(col.name, ['country', 'nation', 'geo', 'geography', 'region', 'state', 'province'])
    ? COUNTRY_CANON : GENERIC_CATS;
  return pool[i % pool.length];
}

// Given schema columns [{name,type}], produce { rows, columns, seeded }.
// `seeded` is a manifest of what was planted, keyed by issue category.
export function generateAdversarialDataset(cols, options = {}) {
  if (!Array.isArray(cols) || cols.length === 0) {
    throw new Error('generateAdversarialDataset needs a non-empty column schema.');
  }
  const rand = mulberry32(options.seed ?? 0x5EED);
  const n = Math.max(30, options.rows || 60);

  const numericCols = cols.filter(c => isNumeric(c.type));
  const dateCols = cols.filter(isDateLike);
  const catCols = cols.filter(c => !isNumeric(c.type) && !isDateLike(c));
  const boolCol = cols.find(c => ADULT_ONLY_KW.test(c.name));
  const ageCol = cols.find(c => AGE_KW.test(c.name) && isNumeric(c.type));

  const seeded = {};

  // ---- clean base rows ----
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = {};
    for (const c of cols) {
      if (isDateLike(c)) row[c.name] = isoDaysFromNow(-(5 + Math.floor(rand() * 700)));
      else if (isNumeric(c.type)) row[c.name] = baseNumeric(c, i, rand);
      else if (boolCol && c.name === boolCol.name) row[c.name] = i % 3 === 0 ? 'true' : 'false';
      else row[c.name] = baseCategorical(c, i);
    }
    rows.push(row);
  }

  // ---- issue 1: near-duplicate categorical spellings ----
  if (catCols.length) {
    const c = catCols[0];
    const canonical = hasKw(c.name, ['country', 'nation', 'geo', 'geography', 'region', 'state', 'province']) ? 'United States' : GENERIC_CATS[0];
    const variants = canonical === 'United States'
      ? ['United States', 'United States', 'United State', 'USA', 'US']
      : [canonical, canonical, `${canonical} `, canonical.toUpperCase(), canonical.toLowerCase()];
    const touched = [];
    for (let k = 0; k < variants.length && k < rows.length; k++) {
      rows[k][c.name] = variants[k];
      touched.push(k);
    }
    seeded.categorical_variants = { column: c.name, canonical, variants: [...new Set(variants)], rows: touched, description: `Near-duplicate spellings/abbreviations of "${canonical}" in "${c.name}".` };
  }

  // ---- issue 2: cross-column logical violation ----
  const startCol = dateCols.find(c => hasKw(c.name, START_KW));
  const endCol = dateCols.find(c => hasKw(c.name, END_KW));
  if (startCol && endCol && startCol.name !== endCol.name) {
    // end before start
    rows[6][startCol.name] = isoDaysFromNow(-100);
    rows[6][endCol.name] = isoDaysFromNow(-110);
    seeded.cross_column_dates = { columns: [startCol.name, endCol.name], rows: [6], description: `"${endCol.name}" set before "${startCol.name}".` };
  } else if (ageCol && boolCol) {
    // minor with an adult-only flag
    rows[7][ageCol.name] = 15;
    rows[7][boolCol.name] = 'true';
    seeded.cross_column_age = { columns: [ageCol.name, boolCol.name], rows: [7], description: `Minor (${ageCol.name}=15) with adult-only "${boolCol.name}"=true.` };
  } else if (numericCols.length >= 2) {
    // generic numeric impossibility: force a huge negative where a magnitude is expected
    const c = numericCols.find(col => AMOUNT_KW.test(col.name)) || numericCols[0];
    rows[7][c.name] = -Math.abs(baseNumeric(c, 7, rand)) - 1000;
    seeded.cross_column_numeric = { columns: [c.name], rows: [7], description: `Impossible negative magnitude in "${c.name}".` };
  }

  // ---- issue 3: exact duplicate rows ----
  const dupSrc = 2;
  rows.push({ ...rows[dupSrc] });
  rows.push({ ...rows[dupSrc + 1] });
  seeded.duplicates = { rows: [rows.length - 2, rows.length - 1], description: 'Two exact duplicate rows appended.' };

  // ---- issue 4: nulls ----
  const nullTargets = [];
  for (let k = 0; k < Math.min(3, cols.length); k++) {
    const c = cols[k];
    const ri = 10 + k;
    if (ri < rows.length) { rows[ri][c.name] = null; nullTargets.push({ column: c.name, row: ri }); }
  }
  seeded.nulls = { targets: nullTargets, description: `Null values injected into ${nullTargets.length} cell(s).` };

  // ---- issue 5: numeric outlier / semantic mismatch ----
  if (ageCol) {
    rows[20 % rows.length][ageCol.name] = 999; // classic semantic error
    seeded.semantic_outlier = { column: ageCol.name, rows: [20 % rows.length], value: 999, description: `Impossible ${ageCol.name}=999 (semantic mismatch + outlier).` };
  } else if (numericCols.length) {
    const c = numericCols[0];
    const ri = 20 % rows.length;
    rows[ri][c.name] = 1e9;
    seeded.semantic_outlier = { column: c.name, rows: [ri], value: 1e9, description: `Extreme outlier in "${c.name}".` };
  }

  // ---- issue 6: future date ----
  if (dateCols.length) {
    const c = dateCols[0];
    rows[3][c.name] = isoDaysFromNow(400);
    seeded.future_date = { column: c.name, rows: [3], description: `Future date in "${c.name}".` };
  }

  // ---- issue 7: negative in a non-negative magnitude column ----
  const magCol = numericCols.find(c => AMOUNT_KW.test(c.name));
  if (magCol) {
    rows[4][magCol.name] = -Math.abs(Number(rows[4][magCol.name])) - 1;
    seeded.negative_magnitude = { column: magCol.name, rows: [4], description: `Negative value in non-negative "${magCol.name}".` };
  }

  return { rows, columns: cols.map(c => c.name), seeded };
}
