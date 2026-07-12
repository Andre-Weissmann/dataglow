// ============================================================
// DATAGLOW — Object Space Registry (Polyglot Workbench, Batch B)
// ============================================================
// A shared, in-memory read model of the named objects that live across
// DataGlow's three runtimes — SQL (DuckDB), Python (Pyodide/pandas), and R
// (WebR) — so a single source of truth can answer "what named objects exist
// right now, where did each come from, and what shape is it?" without each tab
// re-deriving that on its own.
//
// SCOPE (Batch B): this is a passive REGISTRY only. It sits ALONGSIDE the
// existing per-language JSON round-trip bridges (dataglow.get_df in
// python-runtime.js, dataglow_get_df in r-runtime.js, plain FROM <table> in
// duckdb-engine.js) — it does NOT replace their transfer mechanics, and it does
// NOT resolve cross-language references at query time (no working `FROM
// py.name` yet — that is a deliberate future batch). The wiring layer simply
// calls register() at the natural points where each runtime already knows an
// object's name/schema, so the registry stays in sync as things run.
//
// Pure: no DOM, no engine/pyodide/WebR import, no network. Fully unit-testable
// in Node.

// The origin languages an object can come from. Kept as a small closed set so
// a typo (e.g. 'py') is caught rather than silently accepted.
export const ORIGIN_LANGUAGES = ['sql', 'python', 'r'];

// The kinds of object we track. Non-tabular objects (an R `lm` model, a scalar)
// are recorded by kind only — we deliberately do NOT model their internals here.
export const OBJECT_KINDS = ['dataframe', 'model', 'scalar'];

// Normalize a caller-supplied schema into a stable array of {name, type}
// descriptors. Tolerant of missing/partial input (a model or scalar has none).
function normalizeSchema(schema) {
  if (!Array.isArray(schema)) return [];
  return schema
    .filter((c) => c && (c.name != null))
    .map((c) => ({ name: String(c.name), type: c.type != null ? String(c.type) : 'unknown' }));
}

// Build a clean, validated registry entry from a loose caller descriptor.
// Unknown originLanguage/kind fall back to safe defaults rather than throwing,
// so a wiring bug never breaks the runtime that called register().
function toEntry(descriptor) {
  const d = descriptor || {};
  const name = d.name != null ? String(d.name) : '';
  const originLanguage = ORIGIN_LANGUAGES.includes(d.originLanguage) ? d.originLanguage : 'sql';
  const schema = normalizeSchema(d.schema);
  const kind = OBJECT_KINDS.includes(d.kind)
    ? d.kind
    : (schema.length ? 'dataframe' : 'scalar');
  const rowCount = (d.rowCount != null && Number.isFinite(Number(d.rowCount))) ? Number(d.rowCount) : null;
  return {
    name,
    originLanguage,
    kind,
    schema,
    rowCount,
    // A plain pointer/id into the existing provenance chain-of-custody registry
    // (js/provenance/provenance.js keys chains by name). We store the id only —
    // we do NOT duplicate that module's hashing/chain logic here.
    provenance: d.provenance != null ? String(d.provenance) : name,
    createdAt: Number.isFinite(Number(d.createdAt)) ? Number(d.createdAt) : Date.now(),
  };
}

// A registry of named cross-language objects. Names are unique: re-registering
// an existing name UPDATES that entry in place rather than creating a duplicate.
export function createObjectSpace() {
  const objects = new Map();

  function register(descriptor) {
    const entry = toEntry(descriptor);
    if (!entry.name) throw new Error('Object Space: register() requires a non-empty object name.');
    // Preserve the original createdAt on update so an object's first-seen time is
    // stable across re-runs; only refresh it the first time we see the name.
    const existing = objects.get(entry.name);
    if (existing) entry.createdAt = existing.createdAt;
    objects.set(entry.name, entry);
    return { ...entry };
  }

  function get(name) {
    const entry = objects.get(String(name));
    return entry ? { ...entry } : null;
  }

  function getSchema(name) {
    const entry = objects.get(String(name));
    return entry ? entry.schema.map((c) => ({ ...c })) : null;
  }

  function list() {
    return [...objects.values()].map((e) => ({ ...e }));
  }

  function unregister(name) {
    return objects.delete(String(name));
  }

  function clear() {
    objects.clear();
  }

  return {
    register,
    get,
    getSchema,
    list,
    unregister,
    clear,
    get size() { return objects.size; },
  };
}

// ------------------------------------------------------------
// App-level singleton the wiring layer + UI share. Tests create their own
// isolated spaces via createObjectSpace(); the app uses this one so SQL, Python
// and R all read/write the same registry.
// ------------------------------------------------------------
const appObjectSpace = createObjectSpace();

// Register an object into the shared app registry. Thin convenience wrapper the
// runtime wiring calls (always behind the objectSpaceRegistry flag).
export function registerObject(descriptor) {
  return appObjectSpace.register(descriptor);
}

// Read the shared registry — used by UI code to render the live strip of
// cross-language objects. Returns a defensive copy.
export function listObjectSpace() {
  return appObjectSpace.list();
}

// Escape hatch for the wiring layer / tests that need the shared instance.
export function getAppObjectSpace() {
  return appObjectSpace;
}
