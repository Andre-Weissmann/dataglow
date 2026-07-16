// ============================================================
// DATAGLOW — Shared identifier-column guard
// ============================================================
// A single, dependency-free source of truth for "is this column a
// unique-identifier column, and therefore off-limits for fuzzy/similarity-
// based merge suggestions." Three independent modules each need this exact
// judgment call — validation.js's BUSINESS_KEY_RE (business-key detection
// for validation rules), categorical-consistency.js's identifier guard (P0
// fix, 2026-07-12, PR #198), and now fuzzy-dedup.js (P0 fix, this run) — and
// until now the regex/ratio logic was hand-duplicated in each, which is
// exactly how the second P0 gap (this run's finding) went unnoticed: the
// guard existed in one sibling module but was never ported to this one.
//
// This file has ZERO imports and ZERO app-specific dependencies on purpose,
// so any validation/cleaning module can import it with no circular-import
// risk (categorical-consistency.js already imports `similarity` FROM
// fuzzy-dedup.js, so fuzzy-dedup.js importing back from
// categorical-consistency.js would create a cycle — this new shared file
// sits below both and is imported BY both instead).

// Name pattern: bare id/key/code, or a _id/_key/_code/_no/_num/_number
// suffix. Mirrors validation.js's BUSINESS_KEY_RE exactly.
const IDENTIFIER_COLUMN_NAME = /^(id|key|code)$|(_id|_key|_code|_no|_num|_number)$/i;

export function isLikelyIdentifierColumn(columnName) {
  return IDENTIFIER_COLUMN_NAME.test(String(columnName ?? ''));
}

// distinctCount / nonNullCount close to 1 means "almost every row has its
// own value" — the signature of a unique key, not a bounded category
// vocabulary. 0.9 is deliberately conservative: a real categorical column
// with genuine spelling variants will have nowhere near this ratio; a
// unique-ID column with a handful of accidental exact duplicates still
// clears it easily.
export const IDENTIFIER_UNIQUE_RATIO = 0.9;

export function isNearUniqueColumn(distinctCount, nonNullCount, ratio = IDENTIFIER_UNIQUE_RATIO) {
  if (!nonNullCount || nonNullCount <= 0) return false;
  return (distinctCount / nonNullCount) >= ratio;
}
