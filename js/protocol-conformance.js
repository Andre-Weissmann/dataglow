// ============================================================
// DATAGLOW — Protocol conformance adapters + dev-mode runtime check
// ============================================================
// Bridges DATAGLOW's internal runtime objects to the versioned, external-facing
// data contract defined under protocol/. Two responsibilities:
//
//   1. Adapters (to*): deterministically map internal objects to the stable
//      protocol wire shapes. ProvenanceAttestation and GradeResult already ARE
//      the protocol shape, so those pass through unchanged; ValidationRun and
//      StoryOutput are derived envelopes so the wire shape stays stable even if
//      internal bookkeeping changes.
//
//   2. devAssertConformance(): a NON-FATAL, dev-mode-only check that validates a
//      runtime object against its schema and console.warns on drift. It never
//      throws, never blocks, and is a no-op outside a browser dev context — so
//      it can be called from production code paths and Node tests alike without
//      changing behavior. This is what makes protocol conformance a live
//      guarantee rather than just documentation.

import { validate, buildRegistry } from '../protocol/validator.mjs';

export const PROTOCOL_VERSION = '1.0.0';

// ---- Adapters ----------------------------------------------------

// App dataset ({ table, cols, rowCount, loadedAt? }) -> protocol Dataset.
export function toDataset(ds = {}) {
  const cols = Array.isArray(ds.cols) ? ds.cols : (Array.isArray(ds.columns) ? ds.columns : null);
  return {
    table: ds.table ?? null,
    rowCount: ds.rowCount ?? null,
    colCount: ds.colCount ?? (cols ? cols.length : null),
    columns: cols ? cols.map(c => (typeof c === 'string' ? c : { name: c.name, type: c.type ?? null })) : null,
    loadedAt: ds.loadedAt != null ? new Date(ds.loadedAt).toISOString() : null,
  };
}

// Internal keys in the validation `results` map that are NOT per-layer results.
const NON_LAYER_KEYS = new Set(['confidence', 'domainPack', 'calibratedGrades']);

// Internal validation `results` map -> protocol ValidationRun envelope.
export function toValidationRun(results = {}, dataset = null) {
  const layers = {};
  for (const [id, r] of Object.entries(results)) {
    if (NON_LAYER_KEYS.has(id)) continue;
    if (!r || typeof r !== 'object' || typeof r.status !== 'string') continue;
    layers[id] = { status: r.status, summary: r.summary ?? null, detail: r.detail ?? null, ts: r.ts };
  }
  const run = {
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    layers,
  };
  if (dataset) run.dataset = dataset;
  const c = results.confidence;
  if (c && typeof c === 'object' && typeof c.status === 'string') {
    run.confidence = { score: c.score, grade: c.grade, verdict: c.verdict, status: c.status, signals: c.signals || {} };
  }
  if (results.calibratedGrades) run.grades = results.calibratedGrades;
  return run;
}

// Story Engine result ({ text, source, error? }) + claims -> protocol StoryOutput.
export function toStoryOutput(storyResult = {}, claims = []) {
  const out = {
    protocolVersion: PROTOCOL_VERSION,
    text: storyResult.text ?? '',
    source: storyResult.source ?? 'local',
    generatedAt: new Date().toISOString(),
    claims: Array.isArray(claims) ? claims : [],
  };
  if (storyResult.error != null) out.error = storyResult.error;
  return out;
}

// ---- Dev-mode runtime conformance check --------------------------

// Schema filenames keyed by a short kind label. Loaded lazily and cached.
const SCHEMA_FILES = {
  'dataset': 'dataset.schema.json',
  'grade-result': 'grade-result.schema.json',
  'validation-run': 'validation-run.schema.json',
  'provenance-attestation': 'provenance-attestation.schema.json',
  'story-output': 'story-output.schema.json',
};

let _registryPromise = null;

// Only run in a browser dev context. Never in Node (no window) and never on a
// production origin — this is a developer aid, not a user-facing feature.
function isDevContext() {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return false;
  if (window.DATAGLOW_DEV === true) return true;
  const loc = window.location || {};
  const host = loc.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local')) return true;
  if (typeof loc.search === 'string' && loc.search.includes('protocolCheck')) return true;
  return false;
}

async function loadRegistry() {
  if (_registryPromise) return _registryPromise;
  _registryPromise = (async () => {
    const schemas = await Promise.all(
      Object.values(SCHEMA_FILES).map(async (file) => {
        const url = new URL(`../protocol/schema/${file}`, import.meta.url);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load schema ${file}: ${res.status}`);
        return res.json();
      })
    );
    return { schemas, registry: buildRegistry(schemas) };
  })();
  return _registryPromise;
}

// Validate `obj` against the schema for `kind` and console.warn on any drift.
// Fire-and-forget safe: returns immediately outside a dev context and never
// throws or rejects.
export function devAssertConformance(kind, obj) {
  try {
    if (!isDevContext()) return;
    const file = SCHEMA_FILES[kind];
    if (!file) return;
    loadRegistry().then(({ schemas, registry }) => {
      const schema = schemas.find(s => (s.$id || '').includes(`/${file}`));
      if (!schema) return;
      const { valid, errors } = validate(obj, schema, registry);
      if (!valid) {
        console.warn(
          `[DATAGLOW protocol] Runtime "${kind}" object does NOT conform to protocol v${PROTOCOL_VERSION}:\n` +
          errors.map(e => `  • ${e}`).join('\n') +
          `\nThis is a non-fatal dev warning — see protocol/README.md.`
        );
      }
    }).catch(() => { /* schema unavailable (e.g. offline) — silently skip */ });
  } catch { /* never let a dev check affect app behavior */ }
}
