// ============================================================
// DATAGLOW — Cross-Table Relational Rules (codename: Truth Network) — Batch 1/3
// ============================================================
// Every validation layer DataGlow ships today looks INSIDE a single table.
// Cross-Column Logical Consistency (js/validation/cross-column-consistency.js)
// is the closest analog — it catches contradictions across columns of the SAME
// row (an end date before its start, a male patient flagged pregnant). But it
// is confined to one table, so a whole class of real errors slips past
// untouched: a claim dated after the patient's recorded death date, or a
// claims total that disagrees between two loaded datasets. NORTH_STAR.md's
// 2026-07-12 run-4 P1 finding documents exactly this gap ("No cross-table
// temporal/relational plausibility checking exists at all... a new Cross-Table
// Relational Rules layer... starting with the death-date washout case").
//
// This module is the cross-table generalization of that idea: it joins two
// arrays-of-row-objects on a caller-supplied key and evaluates a small, fixed
// vocabulary of comparison rules against the joined pairs. It is pure, DOM-free
// and dependency-free — no DuckDB, no async, no network — so it is directly
// unit-testable under plain `node`, exactly like js/rooms/room-signaling.js
// (DataGlow Rooms Batch 1) shipped as pure logic + tests with zero UI/wiring.
//
// DISCIPLINE (matches the existing validation modules):
//   - pure functions, no side effects, no DOM;
//   - NEVER throws — bad/missing/malformed input returns a safe, idle result
//     `{ violations: [], evaluated: false, reason: '...' }` (the same "make the
//     unusable state a first-class, never-thrown value" discipline the Rooms
//     NULL_ROOM_SIGNALING adapter uses);
//   - findings carry the specific rows/columns/values + a plain-language reason
//     so an analyst can judge each one, never an opaque score.
//
// Batch 1 (this file) is PURE LOGIC ONLY. It ships dark behind the
// `crossTableRules` flag (default false in flags.manifest.json) and is wired
// into no UI and imported by no shipping path yet — that is Batch 2/3.
// ============================================================

// Supported rule kinds. Kept as a small closed vocabulary (like the
// DATE_ORDER_GROUPS / MAGNITUDE_ORDER_GROUPS configs in cross-column) rather
// than an open expression language, so every rule is auditable and safe.
export const RULE_KINDS = ['date_after', 'set_difference'];

// ---------- helpers (all total / never-throwing) ----------

function isPlainRow(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isArrayOfRows(v) {
  return Array.isArray(v) && v.every(isPlainRow);
}

// Idle result for any input we refuse to evaluate. `evaluated:false` is the
// signal to callers that no check ran (as opposed to "ran and found nothing").
function idle(reason) {
  return { evaluated: false, violations: [], reason };
}

// Normalize a join-key value so that 42 and "42" join, and surrounding
// whitespace / case never splits an otherwise-equal key. Nullish keys are
// deliberately un-joinable (returned as null) so blank keys never match.
export function normalizeKey(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.toLowerCase();
}

// Parse a value to epoch-ms, or null if it is not a usable date. Accepts Date
// objects, ISO-ish strings, and epoch numbers. Never throws.
export function toEpochMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

const MS_PER_DAY = 86400000;

// Build a lookup from a table keyed by one column's normalized value. Later
// rows with the same key overwrite earlier ones (a dimension table is expected
// to be one row per key; if it isn't, last-write-wins is a defensible default
// and never throws).
function indexBy(rows, keyCol) {
  const map = new Map();
  for (const row of rows) {
    const k = normalizeKey(row[keyCol]);
    if (k != null) map.set(k, row);
  }
  return map;
}

// ---------- rule: date_after ----------
// Flags joined pairs where columnA (from tableA) falls MORE than `maxDaysAfter`
// days after columnB (from tableB). The death-date washout case:
//   { kind:'date_after', columnA:'claim_date', columnB:'death_date', maxDaysAfter:60 }
// A claim within the 60-day grace window is tolerated (legitimate trailing
// claims); anything beyond it is implausible and surfaces as a violation.
function checkDateAfter(pairs, rule) {
  const { columnA, columnB } = rule;
  if (typeof columnA !== 'string' || typeof columnB !== 'string') {
    return idle('date_after rule requires string columnA and columnB');
  }
  const maxDaysAfter = rule.maxDaysAfter == null ? 0 : rule.maxDaysAfter;
  if (typeof maxDaysAfter !== 'number' || !Number.isFinite(maxDaysAfter) || maxDaysAfter < 0) {
    return idle('date_after rule maxDaysAfter must be a finite number >= 0');
  }

  const violations = [];
  let comparablePairs = 0;
  for (const { a, b, key } of pairs) {
    const ta = toEpochMs(a[columnA]);
    const tb = toEpochMs(b[columnB]);
    if (ta == null || tb == null) continue; // unparseable on either side — skip, never a violation
    comparablePairs++;
    const daysAfter = (ta - tb) / MS_PER_DAY;
    if (daysAfter > maxDaysAfter) {
      violations.push({
        key,
        columnA,
        columnB,
        valueA: a[columnA],
        valueB: b[columnB],
        daysAfter: Math.round(daysAfter * 100) / 100,
        reason: `${columnA} (${a[columnA]}) is ${Math.round(daysAfter)} day(s) after ${columnB} (${b[columnB]}), beyond the ${maxDaysAfter}-day grace window.`,
      });
    }
  }
  return {
    evaluated: true,
    kind: 'date_after',
    columnA,
    columnB,
    maxDaysAfter,
    comparablePairs,
    violationCount: violations.length,
    violations,
    reason: null,
  };
}

// ---------- rule: set_difference ----------
// Flags values present in tableA.columnA that have NO match in tableB.columnB —
// the claims-total-mismatch case (rows in one dataset missing from the other).
// Optional `amountColumnA` totals a monetary column across the unmatched rows
// so a caller can report e.g. "16 rows / $8,562.25 present in A but not B".
// This is a whole-column set operation, so it uses tableA/tableB directly
// rather than the join.
function checkSetDifference(tableA, tableB, rule) {
  const { columnA, columnB } = rule;
  if (typeof columnA !== 'string' || typeof columnB !== 'string') {
    return idle('set_difference rule requires string columnA and columnB');
  }
  const amountColumnA = rule.amountColumnA;
  if (amountColumnA != null && typeof amountColumnA !== 'string') {
    return idle('set_difference rule amountColumnA must be a string when provided');
  }

  const bValues = new Set();
  for (const row of tableB) {
    const k = normalizeKey(row[columnB]);
    if (k != null) bValues.add(k);
  }

  const violations = [];
  let amountTotal = 0;
  let amountCounted = false;
  for (const row of tableA) {
    const raw = row[columnA];
    const k = normalizeKey(raw);
    if (k == null) continue; // blank keys aren't "missing from B", they're absent
    if (!bValues.has(k)) {
      const v = { columnA, columnB, valueA: raw };
      if (amountColumnA != null) {
        const n = Number(row[amountColumnA]);
        if (Number.isFinite(n)) { v.amount = n; amountTotal += n; amountCounted = true; }
      }
      v.reason = `${columnA}=${JSON.stringify(raw)} is present in table A but has no matching ${columnB} in table B.`;
      violations.push(v);
    }
  }

  const result = {
    evaluated: true,
    kind: 'set_difference',
    columnA,
    columnB,
    violationCount: violations.length,
    violations,
    reason: null,
  };
  if (amountColumnA != null) {
    result.amountColumn = amountColumnA;
    // round to cents to avoid float dust (e.g. 8562.249999999)
    result.amountTotal = amountCounted ? Math.round(amountTotal * 100) / 100 : 0;
  }
  return result;
}

// ============================================================
// Public entry point.
//
// checkCrossTableRule({ tableA, tableB, joinKeyA, joinKeyB, rule })
//   - tableA, tableB : arrays of row objects.
//   - joinKeyA, joinKeyB : column names to join on (join-based rules only).
//   - rule : { kind, ... } — see RULE_KINDS.
// OR, for join-based rules, pre-joined pairs may be supplied directly:
//   checkCrossTableRule({ pairs: [{ a: rowA, b: rowB }, ...], rule })
//
// Returns, on refusal (bad input): { evaluated:false, violations:[], reason }.
// Returns, on success: a rule-specific shape that always includes
//   { evaluated:true, kind, violations:[...], violationCount }.
// NEVER throws.
// ============================================================
export function checkCrossTableRule(input) {
  try {
    if (!isPlainRow(input)) return idle('input must be an object');
    const { rule } = input;
    if (!isPlainRow(rule)) return idle('missing or malformed rule object');
    if (!RULE_KINDS.includes(rule.kind)) {
      return idle(`unsupported rule kind: ${JSON.stringify(rule.kind)}`);
    }

    // set_difference operates on whole columns, not a join.
    if (rule.kind === 'set_difference') {
      const { tableA, tableB } = input;
      if (!isArrayOfRows(tableA) || !isArrayOfRows(tableB)) {
        return idle('set_difference requires tableA and tableB arrays of row objects');
      }
      return checkSetDifference(tableA, tableB, rule);
    }

    // date_after is join-based: accept pre-joined pairs, or join here.
    if (rule.kind === 'date_after') {
      const pairs = buildPairs(input);
      if (!pairs.ok) return idle(pairs.reason);
      return checkDateAfter(pairs.value, rule);
    }

    return idle(`unsupported rule kind: ${JSON.stringify(rule.kind)}`);
  } catch (e) {
    // Belt-and-suspenders: the contract is "never throws". Any unforeseen
    // input shape degrades to an idle result rather than propagating.
    return idle(`unevaluable input: ${e && e.message ? e.message : 'unknown error'}`);
  }
}

// Resolve the { a, b, key } pairs for a join-based rule, either from a
// caller-supplied `pairs` array or by joining tableA/tableB on the keys.
// Returns { ok:true, value } or { ok:false, reason }.
function buildPairs(input) {
  if (Array.isArray(input.pairs)) {
    const value = [];
    for (const p of input.pairs) {
      if (isPlainRow(p) && isPlainRow(p.a) && isPlainRow(p.b)) {
        value.push({ a: p.a, b: p.b, key: p.key ?? null });
      }
    }
    return { ok: true, value };
  }

  const { tableA, tableB, joinKeyA, joinKeyB } = input;
  if (!isArrayOfRows(tableA) || !isArrayOfRows(tableB)) {
    return { ok: false, reason: 'join-based rule requires tableA and tableB arrays of row objects (or a pairs array)' };
  }
  if (typeof joinKeyA !== 'string' || typeof joinKeyB !== 'string') {
    return { ok: false, reason: 'join-based rule requires string joinKeyA and joinKeyB' };
  }
  const bIndex = indexBy(tableB, joinKeyB);
  const value = [];
  for (const a of tableA) {
    const k = normalizeKey(a[joinKeyA]);
    if (k == null) continue;
    const b = bIndex.get(k);
    if (b) value.push({ a, b, key: k });
  }
  return { ok: true, value };
}

// ============================================================
// summarizeCrossTableCheck(result) — one-line, human-readable verdict, mirroring
// how explainReconciliation()/explainGateReasons() render other modules' results
// in plain language. Pure string builder; safe on any input.
// ============================================================
export function summarizeCrossTableCheck(result) {
  if (!isPlainRow(result)) return 'No cross-table check result to summarize.';
  if (!result.evaluated) {
    return `NOT EVALUATED — ${result.reason || 'no reason given'}.`;
  }
  const n = result.violationCount || 0;
  if (result.kind === 'date_after') {
    if (n === 0) {
      return `OK — no "${result.columnA}" falls more than ${result.maxDaysAfter} day(s) after "${result.columnB}" across ${result.comparablePairs} joined row(s).`;
    }
    return `${n} VIOLATION(S) — "${result.columnA}" occurs more than ${result.maxDaysAfter} day(s) after "${result.columnB}" (e.g. a claim after a patient's death date beyond the washout window).`;
  }
  if (result.kind === 'set_difference') {
    const money = result.amountColumn != null ? `, totalling ${result.amountTotal} in "${result.amountColumn}"` : '';
    if (n === 0) {
      return `OK — every "${result.columnA}" value in table A has a matching "${result.columnB}" in table B.`;
    }
    return `${n} VIOLATION(S) — ${n} "${result.columnA}" value(s) present in table A are missing from table B's "${result.columnB}"${money}.`;
  }
  return `${n} violation(s) found.`;
}
