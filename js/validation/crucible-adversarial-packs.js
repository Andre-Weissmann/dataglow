// ============================================================
// DATAGLOW — The Crucible: adversarial test pack library (Batch 1 of 3)
// ============================================================
// A pack is a self-contained adversarial probe aimed at ONE known failure mode.
// Each exposes:
//   { id, label, category, generateCases(), evaluate(agentUnderTest, cases) }
// where generateCases() DETERMINISTICALLY returns a fixed array of adversarial
// records (no Math.random — fixed literal fixtures, so a run is reproducible and
// a regression is unambiguous), and evaluate() runs those cases through a supplied
// "agent under test" function and returns { passed:boolean, failures:[...] }.
//
// The packs are the "prosecution": they are written to expose whitespace, not to
// flatter the agent. The nameOrderSwapPack and ssnTranspositionPack encode two
// AHIMA patient-matching failure patterns that NORTH_STAR's 2026-07-12 test
// findings already confirmed the shipped fuzzy-dedup (js/cleaning/fuzzy-dedup.js)
// misses; they are EXPECTED to fail against it — that failure is the honest,
// empirical proof the gap is real. Do not tune a pack to make a broken agent pass.
//
// Pure, Node-testable, DOM/DuckDB/network-free, and never throws: a broken
// agent-under-test that throws is caught and recorded as a failure, not a crash.

const AGENT_THREW = 'agent-under-test threw';

function safeCall(fn, arg) {
  try {
    return { ok: true, value: fn(arg) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// ------------------------------------------------------------------
// Matching packs — the agent under test is a same-entity matcher:
//   agentUnderTest(record) -> truthy when it flags left & right as the SAME entity.
// A same-entity case fails when the matcher does NOT flag it; a distinct control
// case fails when the matcher DOES (guards against a trivially-permissive matcher
// that "catches" everything).
// ------------------------------------------------------------------
function evaluateMatching(agentUnderTest, cases) {
  const failures = [];
  if (typeof agentUnderTest !== 'function') {
    return { passed: false, failures: [{ reason: 'agentUnderTest is not a function' }] };
  }
  for (const c of cases) {
    const called = safeCall(agentUnderTest, c);
    if (!called.ok) {
      failures.push({ id: c.id, reason: AGENT_THREW, detail: called.error });
      continue;
    }
    const flagged = !!called.value;
    if (c.sameEntity && !flagged) {
      failures.push({ id: c.id, reason: 'same-entity pair NOT flagged as a match', left: c.left, right: c.right, note: c.note });
    } else if (!c.sameEntity && flagged) {
      failures.push({ id: c.id, reason: 'distinct pair wrongly flagged as a match', left: c.left, right: c.right, note: c.note });
    }
  }
  return { passed: failures.length === 0, failures };
}

export const nameOrderSwapPack = Object.freeze({
  id: 'name-order-swap',
  label: 'Name-order swap',
  category: 'entity-matching',
  generateCases() {
    // Same patient, name written first-last vs last-first (and "Last, First"
    // comma form). A pure character-similarity matcher scores these near zero.
    const swaps = [
      { first: 'Maria Garcia Lopez', swapped: 'Lopez, Maria Garcia' },
      { first: 'John Michael Smith', swapped: 'Smith, John Michael' },
      { first: 'Wei Chen', swapped: 'Chen Wei' },
      { first: 'Aisha Mohammed', swapped: 'Mohammed, Aisha' },
      { first: 'Robert James Brown', swapped: 'Brown Robert James' },
      { first: 'Priya Kumar', swapped: 'Kumar, Priya' },
    ];
    const cases = swaps.map((s, i) => ({
      id: `name-swap-${i + 1}`,
      category: 'entity-matching',
      sameEntity: true,
      left: { name: s.first },
      right: { name: s.swapped },
      note: 'first-last vs last-first ordering of the same name',
    }));
    // Distinct control: two genuinely different people must NOT match.
    cases.push({
      id: 'name-swap-control',
      category: 'entity-matching',
      sameEntity: false,
      left: { name: 'Maria Garcia Lopez' },
      right: { name: 'Daniel Okafor' },
      note: 'unrelated names — must not be flagged as the same entity',
    });
    return cases;
  },
  evaluate: evaluateMatching,
});

export const ssnTranspositionPack = Object.freeze({
  id: 'ssn-transposition',
  label: 'SSN transposition',
  category: 'entity-matching',
  generateCases() {
    // Same patient, identical name, SSN last-4 with one adjacent-digit
    // transposition — the classic keying slip. Matching on the name string alone
    // treats these as the same string (so a name-only matcher "passes" them),
    // therefore the adversarial signal lives in the SSN field: a correct matcher
    // must treat a transposed-last4 SSN as still the SAME entity, not a new one.
    const rows = [
      { name: 'Nadia Petrova', ssn: '123-45-6789', swappedSsn: '123-45-6798' },
      { name: 'Marcus Webb', ssn: '987-65-4321', swappedSsn: '987-65-4312' },
      { name: 'Yuki Nakamura', ssn: '555-11-2468', swappedSsn: '555-11-2486' },
      { name: 'Grace Mensah', ssn: '444-22-1357', swappedSsn: '444-22-1375' },
      { name: 'Ethan Caldwell', ssn: '222-33-8642', swappedSsn: '222-33-8624' },
      { name: 'Fatima Al-Sayed', ssn: '333-44-9753', swappedSsn: '333-44-9735' },
    ];
    const cases = rows.map((r, i) => ({
      id: `ssn-transpose-${i + 1}`,
      category: 'entity-matching',
      sameEntity: true,
      left: { name: r.name, ssn: r.ssn },
      right: { name: r.name, ssn: r.swappedSsn },
      note: 'same patient, last-4 SSN digits transposed',
    }));
    cases.push({
      id: 'ssn-transpose-control',
      category: 'entity-matching',
      sameEntity: false,
      left: { name: 'Nadia Petrova', ssn: '123-45-6789' },
      right: { name: 'Nadia Petrova', ssn: '900-00-0000' },
      note: 'same name but an entirely different SSN — likely two different people',
    });
    return cases;
  },
  evaluate: evaluateMatching,
});

// ------------------------------------------------------------------
// boundaryDatePack — the agent under test is a date normalizer:
//   agentUnderTest(record) -> a normalized value (truthy) OR a falsy/`{ok:false}`
//   marker when the input is not a real calendar date.
// An impossible date fails when the normalizer SILENTLY returns a plausible-
// looking date (the dangerous case: garbage in, confident-wrong out). A genuinely
// valid date fails when the normalizer rejects it.
// ------------------------------------------------------------------
function normalizerAccepted(value) {
  // Treat null/undefined/false/'' and an explicit { ok:false } / { valid:false }
  // as "rejected"; anything else counts as the normalizer having produced a date.
  if (value == null || value === false || value === '') return false;
  if (typeof value === 'object') {
    if (value.ok === false || value.valid === false) return false;
    return true;
  }
  return true;
}

export const boundaryDatePack = Object.freeze({
  id: 'boundary-date',
  label: 'Boundary dates',
  category: 'value-normalization',
  generateCases() {
    return [
      { id: 'date-feb29-nonleap', input: '2023-02-29', valid: false, note: 'Feb 29 in a non-leap year' },
      { id: 'date-feb29-leap', input: '2024-02-29', valid: true, note: 'Feb 29 in a leap year (legitimate)' },
      { id: 'date-day00', input: '2023-06-00', valid: false, note: 'day 0 does not exist' },
      { id: 'date-day32', input: '2023-01-32', valid: false, note: 'day 32 does not exist' },
      { id: 'date-month13', input: '2023-13-01', valid: false, note: 'month 13 does not exist' },
      { id: 'date-month00', input: '2023-00-15', valid: false, note: 'month 0 does not exist' },
      { id: 'date-apr31', input: '2023-04-31', valid: false, note: 'April has 30 days' },
      { id: 'date-valid', input: '2023-07-15', valid: true, note: 'ordinary valid date' },
    ];
  },
  evaluate(agentUnderTest, cases) {
    const failures = [];
    if (typeof agentUnderTest !== 'function') {
      return { passed: false, failures: [{ reason: 'agentUnderTest is not a function' }] };
    }
    for (const c of cases) {
      const called = safeCall(agentUnderTest, c);
      if (!called.ok) {
        failures.push({ id: c.id, reason: AGENT_THREW, detail: called.error });
        continue;
      }
      const accepted = normalizerAccepted(called.value);
      if (!c.valid && accepted) {
        failures.push({ id: c.id, reason: 'impossible date silently normalized to a plausible value', input: c.input, produced: called.value, note: c.note });
      } else if (c.valid && !accepted) {
        failures.push({ id: c.id, reason: 'valid date wrongly rejected', input: c.input, note: c.note });
      }
    }
    return { passed: failures.length === 0, failures };
  },
});

// ------------------------------------------------------------------
// impossibleValuePack — the agent under test is a value validator:
//   agentUnderTest(record) -> truthy when it FLAGS the value as implausible.
// A biologically-impossible value fails when the validator does NOT flag it
// (silent pass-through); a plausible value fails when the validator flags it.
// ------------------------------------------------------------------
export const impossibleValuePack = Object.freeze({
  id: 'impossible-value',
  label: 'Impossible values',
  category: 'value-plausibility',
  generateCases() {
    return [
      { id: 'age-negative', field: 'age', value: -5, impossible: true, note: 'negative age' },
      { id: 'age-super', field: 'age', value: 240, impossible: true, note: 'age far beyond any human lifespan' },
      { id: 'age-ok', field: 'age', value: 47, impossible: false, note: 'ordinary adult age' },
      { id: 'hr-too-high', field: 'heart_rate', value: 450, impossible: true, note: 'heart rate > 400 bpm is not survivable' },
      { id: 'hr-negative', field: 'heart_rate', value: -10, impossible: true, note: 'negative heart rate' },
      { id: 'hr-ok', field: 'heart_rate', value: 72, impossible: false, note: 'resting heart rate' },
      { id: 'temp-impossible', field: 'body_temp_c', value: 250, impossible: true, note: 'body temperature of 250°C' },
      { id: 'temp-ok', field: 'body_temp_c', value: 37, impossible: false, note: 'normal body temperature' },
    ];
  },
  evaluate(agentUnderTest, cases) {
    const failures = [];
    if (typeof agentUnderTest !== 'function') {
      return { passed: false, failures: [{ reason: 'agentUnderTest is not a function' }] };
    }
    for (const c of cases) {
      const called = safeCall(agentUnderTest, c);
      if (!called.ok) {
        failures.push({ id: c.id, reason: AGENT_THREW, detail: called.error });
        continue;
      }
      const flagged = !!called.value;
      if (c.impossible && !flagged) {
        failures.push({ id: c.id, reason: 'impossible value silently passed through', field: c.field, value: c.value, note: c.note });
      } else if (!c.impossible && flagged) {
        failures.push({ id: c.id, reason: 'plausible value wrongly flagged', field: c.field, value: c.value, note: c.note });
      }
    }
    return { passed: failures.length === 0, failures };
  },
});

export const CRUCIBLE_PACKS = Object.freeze([
  nameOrderSwapPack,
  ssnTranspositionPack,
  boundaryDatePack,
  impossibleValuePack,
]);

/**
 * Run an array of packs against ONE agent-under-test function. Returns a summary
 * whose `packResults` is shaped for buildValidationVerdict()'s packResults input.
 * Never throws — a pack that is malformed or whose evaluate() throws is recorded
 * as a failed pack rather than aborting the suite.
 *
 * @param {Array<object>} packs
 * @param {Function} agentUnderTest
 * @returns {{ok:boolean, allPassed:boolean, passedCount:number, failedCount:number,
 *            packResults:Array<{id:string, label:string, category:string,
 *              passed:boolean, failures:any[]}>}}
 */
export function runAdversarialSuite(packs, agentUnderTest) {
  if (!Array.isArray(packs)) {
    return { ok: false, allPassed: false, passedCount: 0, failedCount: 0, packResults: [] };
  }
  const packResults = packs.map((pack) => {
    if (!pack || typeof pack.evaluate !== 'function' || typeof pack.generateCases !== 'function') {
      return { id: (pack && pack.id) || 'unknown', label: (pack && pack.label) || 'unknown', category: (pack && pack.category) || 'unknown', passed: false, failures: [{ reason: 'malformed pack' }] };
    }
    let outcome;
    try {
      outcome = pack.evaluate(agentUnderTest, pack.generateCases());
    } catch (err) {
      outcome = { passed: false, failures: [{ reason: 'pack.evaluate threw', detail: err && err.message ? err.message : String(err) }] };
    }
    const failures = Array.isArray(outcome && outcome.failures) ? outcome.failures : [];
    return { id: pack.id, label: pack.label, category: pack.category, passed: !!(outcome && outcome.passed), failures };
  });
  const passedCount = packResults.filter((p) => p.passed).length;
  const failedCount = packResults.length - passedCount;
  return { ok: true, allPassed: failedCount === 0, passedCount, failedCount, packResults };
}
