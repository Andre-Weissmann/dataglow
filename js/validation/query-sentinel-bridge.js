// ============================================================
// DATAGLOW — Query Sentinel Bridge (Batch 3 of 3: cross-runtime FROM resolver)
// ============================================================
// WHY THIS EXISTS
// The Polyglot Workbench's Object Space registry (js/app-shell/object-space.js,
// Batch B) already tracks every loaded dataset under a per-origin-language key
// (`py:<table>`, `r:<table>`, or the bare SQL table name) every time the SQL,
// Python, or R tab runs. What it explicitly does NOT do yet (its own header
// says so) is resolve a cross-language reference AT QUERY TIME — there is no
// working `FROM py.<name>` / `FROM r.<name>` in the SQL tab. This module is
// that missing resolver, batch 3 of the Query Sentinel concept (batch 1:
// js/validation/query-sentinel.js, batch 2: js/validation/query-sentinel-assist.js).
//
// REALISTIC v1 SCOPE (confirmed by direct code inspection, not assumed):
//   `registerRuntimeObjects()` in js/app-shell/main.js only re-registers
//   ALREADY-LOADED SQL datasets under `py:`/`r:` prefixes after a Python or R
//   run — it does not capture a NEW variable a Python/R script creates midrun
//   (e.g. a `pandas.DataFrame` built inline, never loaded via the file/dataset
//   flow). Both js/runtimes-viz/python-runtime.js's `dataglow.get_df(name)` and
//   r-runtime.js's `dataglow_get_df(name)` bridges expose the SAME already-
//   loaded dataset table, not an arbitrary in-runtime object. So `py.<name>` /
//   `r.<name>` in SQL can ONLY ever mean "the dataset already loaded and
//   registered under that name from that runtime's last run" — genuine
//   arbitrary-variable capture (e.g. reaching into a one-off Python-computed
//   DataFrame that was never one of the app's loaded datasets) is explicitly
//   OUT of scope for this batch. This must be stated honestly wherever this
//   module's capability is described — it is a real, useful bridge for the
//   common case, not a general cross-runtime variable importer.
//
// WHAT THIS MODULE ACTUALLY DOES (composition, not new invention):
//   Given the current SQL text and the live Object Space list (already
//   collected by js/app-shell/object-space.js — this module invents no new
//   collection/tracking logic), rewrite every `py.<name>` / `r.<name>` table
//   reference in a FROM/JOIN clause to the underlying registered SQL table
//   name, but ONLY when that exact `py:<name>` / `r:<name>` entry is actually
//   present in the Object Space list right now. If it is not present — never
//   registered, or the analyst mistyped a name — this module makes NO
//   substitution and instead returns an explicit, listed "unresolved
//   reference" so the caller can show a clear error rather than silently
//   letting DuckDB fail on a raw, meaningless `py.something` identifier or
//   (far worse) silently resolving to the wrong table.
//
// SAFETY
//   Pure text transformation over a SQL string plus an already-provided
//   object list — no DOM, no DuckDB import, no network, no eval. Never
//   creates a table, never runs a query, never writes anything: the caller
//   (js/app-shell/main.js) still owns handing the rewritten SQL to the exact
//   same engine.runQuery() path every other query already goes through, so
//   the query still runs under whatever the app's own DuckDB permissions/
//   read-only posture already is — this module does not widen or narrow that
//   in any way. See PUBLIC_API_SURFACE at the bottom — same red-team-testable
//   pattern query-sentinel.js and query-sentinel-assist.js already use.

export const QUERY_SENTINEL_BRIDGE_KIND = 'dataglow-query-sentinel-bridge';
export const QUERY_SENTINEL_BRIDGE_VERSION = 1;

// The two resolvable cross-runtime prefixes. Kept as a small closed set —
// matches js/app-shell/object-space.js's own ORIGIN_LANGUAGES (minus 'sql',
// since a bare, unprefixed table reference already works with no resolver).
export const BRIDGE_PREFIXES = Object.freeze(['py', 'r']);

// Matches `py.<identifier>` or `r.<identifier>` immediately after FROM/JOIN
// (case-insensitive), the same narrow, deliberately-not-a-full-parser style
// query-sentinel.js's own extractJoins() already uses. Captures the prefix
// and the referenced name separately so each match can be resolved on its own.
const BRIDGE_REF_RE = /\b(from|join)\s+(py|r)\.([A-Za-z_][A-Za-z0-9_]*)/gi;

/**
 * Find every `py.<name>` / `r.<name>` reference in a FROM/JOIN clause of the
 * given SQL text. Pure regex scan — never touches the database. Returns one
 * entry per match (duplicates included, since a caller may want to report
 * every occurrence, not just distinct names).
 * @param {string} sql
 * @returns {Array<{prefix:'py'|'r', name:string, matchText:string, index:number}>}
 */
export function extractBridgeReferences(sql) {
  if (typeof sql !== 'string' || !sql) return [];
  const refs = [];
  let m;
  const re = new RegExp(BRIDGE_REF_RE);
  while ((m = re.exec(sql)) !== null) {
    refs.push({ prefix: m[2].toLowerCase(), name: m[3], matchText: m[0], index: m.index });
  }
  return refs;
}

/**
 * Resolve every `py.<name>` / `r.<name>` reference in `sql` against the
 * live Object Space list (as returned by listObjectSpace() — passed in by
 * the caller, never re-fetched here, so this module has zero coupling to how
 * the registry is stored). Returns the rewritten SQL plus an explicit
 * bookkeeping list of every reference: resolved (with the real underlying
 * table it now points at) or unresolved (left completely untouched in the
 * output SQL, so a caller can surface a clear "not found" error instead of
 * running a query against a guessed table).
 *
 * NEVER substitutes on a partial/fuzzy name match — only an EXACT
 * `<prefix>:<name>` entry already present in `objectSpaceEntries` resolves.
 * This keeps the bridge honest: a mistyped or never-loaded name always comes
 * back unresolved, never silently pointed at the wrong table.
 *
 * @param {string} sql - the raw SQL text about to be run.
 * @param {Array<{name:string, originLanguage:string, provenance:string}>} objectSpaceEntries
 *   - the exact array js/app-shell/object-space.js's listObjectSpace() already
 *     returns. Entry `name` is the registry key (`py:<table>` / `r:<table>` /
 *     bare SQL table name); `provenance` is the underlying real SQL table name
 *     (see object-space.js's toEntry() — provenance defaults to the table name
 *     passed to register(), which registerRuntimeObjects() always sets to the
 *     dataset's real DuckDB table).
 * @returns {{sql:string, resolved:Array<{prefix:string,name:string,resolvedTable:string}>, unresolved:Array<{prefix:string,name:string}>}}
 */
export function resolveBridgeReferences(sql, objectSpaceEntries) {
  if (typeof sql !== 'string' || !sql) return { sql: sql || '', resolved: [], unresolved: [] };
  const entries = Array.isArray(objectSpaceEntries) ? objectSpaceEntries : [];
  // Index by the exact registry key (`py:<name>` / `r:<name>`) for O(1) lookup —
  // never a fuzzy/partial match, per the module-level contract above.
  const byKey = new Map();
  for (const e of entries) {
    if (e && typeof e.name === 'string') byKey.set(e.name, e);
  }

  const resolved = [];
  const unresolved = [];
  const seenUnresolved = new Set();

  const rewritten = sql.replace(BRIDGE_REF_RE, (matchText, clause, prefixRaw, name) => {
    const prefix = prefixRaw.toLowerCase();
    const entry = byKey.get(`${prefix}:${name}`);
    if (!entry) {
      const key = `${prefix}.${name}`;
      if (!seenUnresolved.has(key)) { seenUnresolved.add(key); unresolved.push({ prefix, name }); }
      return matchText; // left completely untouched — never guessed at.
    }
    const resolvedTable = entry.provenance || entry.name;
    resolved.push({ prefix, name, resolvedTable });
    return `${clause} ${resolvedTable}`;
  });

  return { sql: rewritten, resolved, unresolved };
}

/**
 * Plain-language one-line summary for a compact badge, mirroring
 * summarizeQuerySentinel()'s / summarizeConvergence()'s shape elsewhere in
 * this codebase. Honest about the unresolved case — never claims success
 * when a reference was left untouched.
 * @param {{resolved:Array, unresolved:Array}} result - the object returned
 *   by resolveBridgeReferences().
 * @returns {string|null} null when there was nothing to report (no bridge
 *   references at all in the query — the common, unaffected case).
 */
export function summarizeBridgeResolution(result) {
  if (!result || (result.resolved.length === 0 && result.unresolved.length === 0)) return null;
  const parts = [];
  if (result.resolved.length > 0) {
    const names = result.resolved.map((r) => `${r.prefix}.${r.name} → ${r.resolvedTable}`);
    parts.push(`resolved ${names.join(', ')}`);
  }
  if (result.unresolved.length > 0) {
    const names = result.unresolved.map((r) => `${r.prefix}.${r.name}`);
    parts.push(`could not find ${names.join(', ')} in the currently loaded Python/R objects — run that tab first`);
  }
  return `Cross-runtime bridge: ${parts.join('; ')}.`;
}

// Explicit, testable proof this module never writes/queries/creates on its
// own: no DuckDB import, no export named apply/write/mutate/run/execute, and
// (per the honest-scope note above) no fuzzy-match fallback. Matches the same
// red-team-testable guarantee query-sentinel.js and query-sentinel-assist.js
// already document for their own modules.
export const PUBLIC_API_SURFACE = Object.freeze([
  'extractBridgeReferences',
  'resolveBridgeReferences',
  'summarizeBridgeResolution',
]);
