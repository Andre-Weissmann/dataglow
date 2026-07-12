// ============================================================
// DATAGLOW — Source Convergence (Batch 2 of 3): ingestion adapters
// ============================================================
// Batch 1 (js/validation/source-convergence.js) shipped the PURE convergence
// engine: buildConvergenceGraph(sources) and friends all expect each source to
// already be shaped as { id, rows, possibleKeys }. Batch 2 is the layer that
// turns the messy, real-world things an analyst actually loads — an Excel
// workbook with several tabs, a live JSON API pull, a table exported/scraped
// from a site — INTO those source objects, inferring join keys and assigning a
// sensible default trust weight so the engine can converge them.
//
// This file adds NO new convergence logic and does NOT touch source-convergence.js's
// public contract: it treats that module as a stable, already-tested dependency
// and only produces well-formed input for it. It is pure and Node-testable — it
// takes ALREADY-PARSED data (rows/sheets/JSON) rather than raw files, so it needs
// no XLSX/DOM/network of its own. The browser wiring that reads a File with the
// app's existing SheetJS reader (js/app-shell/loaders.js: XLSX.read +
// XLSX.utils.sheet_to_json) and the user-initiated client-side fetch() both live
// in the UI batch (Batch 3); this layer is the seam between them and the engine.
//
// DISCIPLINE (matches source-convergence.js):
//   - pure functions, no side effects, no DOM, no async, no network;
//   - NEVER throws — malformed/empty input returns a safe, error-flagged result
//     ({ ok:false } for a single adapter, [] for the workbook fan-out);
//   - zero-upload/local-first: every adapter consumes data the caller already has
//     in memory client-side; nothing here sends data anywhere.
//
// Each adapter returns a SOURCE object shaped for buildConvergenceGraph /
// resolveClusterWithTrust:
//   { id, rows, possibleKeys, trust, meta }
// where `trust` (0..1) is what resolveClusterWithTrust's sourceTrust map wants
// and `meta` carries provenance (origin kind, fileName/url, fetchedAt, and the
// needsManualKeySelection flag when key inference found nothing).
// ============================================================

// ---------- small, total helpers (never throw) ----------

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isArrayOfRows(v) {
  return Array.isArray(v) && v.length > 0 && v.every(isPlainObject);
}

// The known single-column key patterns an identifier column tends to match.
// Modeled on the healthcare-anchored examples in the Source Convergence mockup
// (claim_id / patient_id / member_id / npi) plus the generic *_id/_key/_code
// convention the Unit Test Layer's business-key check already uses.
const KEY_SUFFIXES = ['_id', '_key', '_code', '_no', '_num', '_number', '_npi'];
const BARE_KEY_NAMES = new Set(['id', 'key', 'code', 'npi', 'mrn', 'ssn', 'ein', 'isbn', 'uuid', 'guid']);

// Composite keys worth trying when both member columns are present. These mirror
// the mockup's transitive (patient_id + date_of_service) join between the
// adjudication feed and the eligibility extract.
const COMPOSITE_KEY_CANDIDATES = [
  ['patient_id', 'date_of_service'],
  ['member_id', 'date_of_service'],
  ['patient_id', 'dos'],
  ['claim_id', 'line_number'],
  ['claim_id', 'line_no'],
];

function looksLikeKeyColumn(col) {
  if (typeof col !== 'string') return false;
  const c = col.trim().toLowerCase();
  if (c === '') return false;
  if (BARE_KEY_NAMES.has(c)) return true;
  return KEY_SUFFIXES.some(sfx => c.endsWith(sfx));
}

// The set of column names present across a sample of rows (union, so a column
// that is null in the first row but present later still counts).
function columnUnion(rows) {
  const cols = new Set();
  const sample = rows.slice(0, 50);
  for (const r of sample) {
    if (!isPlainObject(r)) continue;
    for (const c of Object.keys(r)) cols.add(c);
  }
  return cols;
}

// ============================================================
// inferJoinKeys(rows) — the shared heuristic used by every adapter.
// Pure: reads only column NAMES (and their presence), never values, so it is
// cheap and deterministic. Returns an array of possibleKeys in the exact shape
// buildConvergenceGraph accepts: single-column keys as bare strings and composite
// keys as arrays, e.g. ['claim_id', ['patient_id','date_of_service']].
// Returns [] (never throws) when nothing looks like a key — the caller then flags
// needsManualKeySelection so a human can pick the join column in the UI (Batch 3).
// ============================================================
export function inferJoinKeys(rows) {
  try {
    if (!isArrayOfRows(rows)) return [];
    const cols = columnUnion(rows);
    if (cols.size === 0) return [];

    const lowerToActual = new Map();
    for (const c of cols) lowerToActual.set(c.trim().toLowerCase(), c);

    const keys = [];
    const seen = new Set();

    // 1) Single-column identifier keys, preserving the source's original casing.
    for (const c of cols) {
      if (looksLikeKeyColumn(c) && !seen.has(c)) { keys.push(c); seen.add(c); }
    }

    // 2) Composite candidates where BOTH member columns exist (case-insensitive
    //    match, but emitted with the source's real column names).
    for (const candidate of COMPOSITE_KEY_CANDIDATES) {
      const actual = candidate.map(c => lowerToActual.get(c));
      if (actual.every(a => a != null)) {
        const sig = actual.map(a => a.toLowerCase()).sort().join('+');
        if (!seen.has(sig)) { keys.push(actual); seen.add(sig); }
      }
    }

    return keys;
  } catch {
    return [];
  }
}

// ============================================================
// assignDefaultTrust(sourceMeta) — a sane default trust score (0..1) by origin
// kind, NOT a hard rule: a caller may always pass an explicit trust and it wins.
// Directly-uploaded files (Excel/CSV a human curated) are trusted a little higher
// than a live API pull or a scraped site export, matching the mockup's 0.65–0.92
// spread. Always returns a finite number in [0,1]; never throws.
// ============================================================
const DEFAULT_TRUST_BY_KIND = {
  excel: 0.9,
  csv: 0.9,
  upload: 0.85,
  api: 0.75,
  site: 0.65,
};
const FALLBACK_TRUST = 0.7;

export function assignDefaultTrust(sourceMeta) {
  try {
    if (isPlainObject(sourceMeta)) {
      // An explicit caller-supplied trust always wins.
      if (typeof sourceMeta.trust === 'number' && Number.isFinite(sourceMeta.trust)) {
        return clamp01(sourceMeta.trust);
      }
      const kind = typeof sourceMeta.kind === 'string' ? sourceMeta.kind.toLowerCase() : null;
      if (kind && Object.prototype.hasOwnProperty.call(DEFAULT_TRUST_BY_KIND, kind)) {
        return DEFAULT_TRUST_BY_KIND[kind];
      }
    }
    return FALLBACK_TRUST;
  } catch {
    return FALLBACK_TRUST;
  }
}

function clamp01(n) {
  if (!Number.isFinite(n)) return FALLBACK_TRUST;
  return Math.max(0, Math.min(1, n));
}

// Defensively pull an array-of-rows out of whatever a JSON pull handed us: either
// a bare array, or an object wrapping the rows under a `data`/`rows`/`results`/
// `items`/`records` key (the shapes real APIs use). Returns [] if none found.
function extractRows(payload) {
  if (Array.isArray(payload)) return payload.filter(isPlainObject);
  if (isPlainObject(payload)) {
    for (const key of ['data', 'rows', 'results', 'items', 'records']) {
      if (Array.isArray(payload[key])) return payload[key].filter(isPlainObject);
    }
  }
  return [];
}

// Shared builder for the API / site adapters: both take an already-parsed JSON
// payload and differ only in origin `kind` and default trust. Keeps the defensive
// parsing in one place so the two public adapters don't duplicate it.
function adaptJsonPayload(payload, { sourceId, url, kind } = {}) {
  const id = sourceId != null ? String(sourceId) : defaultIdForUrl(url, kind);
  const base = {
    id,
    kind,
    url: url != null ? String(url) : null,
    fetchedAt: new Date().toISOString(),
  };

  const rows = extractRows(payload);
  if (rows.length === 0) {
    return errorSource(id, kind, `${kind} payload had no usable array of row objects`, base);
  }

  const possibleKeys = inferJoinKeys(rows);
  const trust = assignDefaultTrust(base);
  return {
    id,
    rows,
    possibleKeys,
    trust,
    meta: {
      ok: true,
      kind,
      url: base.url,
      fetchedAt: base.fetchedAt,
      rowCount: rows.length,
      needsManualKeySelection: possibleKeys.length === 0,
    },
  };
}

function defaultIdForUrl(url, kind) {
  if (typeof url === 'string' && url.trim() !== '') {
    try {
      const u = new URL(url);
      return `${kind}:${u.hostname}${u.pathname}`.replace(/\/+$/, '');
    } catch {
      return `${kind}:${url.trim()}`;
    }
  }
  return `${kind}-source`;
}

// A safe, error-flagged source result. It is still shaped like a source object
// (empty rows/keys) so a caller can uniformly inspect meta.ok without a try/catch.
function errorSource(id, kind, reason, base = {}) {
  return {
    id: id != null ? String(id) : `${kind || 'unknown'}-source`,
    rows: [],
    possibleKeys: [],
    trust: assignDefaultTrust({ kind }),
    meta: {
      ok: false,
      kind: kind || null,
      url: base.url ?? null,
      fetchedAt: base.fetchedAt ?? null,
      rowCount: 0,
      needsManualKeySelection: true,
      reason,
    },
  };
}

// ============================================================
// adaptExcelWorkbook(workbookData, { fileName }) — ONE source per sheet/tab.
// `workbookData` is the already-parsed workbook: an array of { sheetName, rows }
// (rows = array of row objects, exactly what js/app-shell/loaders.js' existing
// XLSX.utils.sheet_to_json(sheet, { defval:null, raw:true }) produces per sheet).
// Each tab becomes its OWN source — matching the mockup's "Roster.xlsx →
// Providers" / "Roster.xlsx → Adjustments" pattern (same file, different tabs are
// different sources with independently inferred keys). A blank/invalid tab is
// skipped rather than aborting the whole workbook. Returns an ARRAY of source
// objects (possibly empty); NEVER throws.
// ============================================================
export function adaptExcelWorkbook(workbookData, { fileName } = {}) {
  try {
    const sheets = Array.isArray(workbookData)
      ? workbookData
      : (isPlainObject(workbookData) && Array.isArray(workbookData.sheets) ? workbookData.sheets : null);
    if (!sheets) return [];

    const file = typeof fileName === 'string' && fileName.trim() !== '' ? fileName.trim() : null;
    const baseLabel = file ? file.replace(/\.(xlsx?|xlsm|xlsb)$/i, '') : 'workbook';

    const out = [];
    const seenIds = new Set();
    for (const sheet of sheets) {
      if (!isPlainObject(sheet)) continue;
      const sheetName = typeof sheet.sheetName === 'string' && sheet.sheetName.trim() !== ''
        ? sheet.sheetName.trim() : `sheet-${out.length + 1}`;

      // "Roster.xlsx → Adjustments"-style id; de-duplicate identical sheet names.
      let id = `${baseLabel} → ${sheetName}`;
      let n = 2;
      while (seenIds.has(id)) id = `${baseLabel} → ${sheetName} (${n++})`;
      seenIds.add(id);

      if (!isArrayOfRows(sheet.rows)) {
        // Keep an honest, skippable placeholder so a caller can see the empty tab
        // was recognized (and won't be fed to the engine — meta.ok is false).
        out.push(errorSource(id, 'excel', `sheet "${sheetName}" has no usable rows`, { fileName: file }));
        continue;
      }

      const possibleKeys = inferJoinKeys(sheet.rows);
      out.push({
        id,
        rows: sheet.rows,
        possibleKeys,
        trust: assignDefaultTrust({ kind: 'excel' }),
        meta: {
          ok: true,
          kind: 'excel',
          fileName: file,
          sheetName,
          rowCount: sheet.rows.length,
          needsManualKeySelection: possibleKeys.length === 0,
        },
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ============================================================
// adaptApiSource(apiResponseData, { sourceId, url }) — one source from a parsed
// JSON API response (a bare array of objects, or an object wrapping the rows
// under data/rows/results/items/records). meta carries url + fetchedAt for the
// mockup's "live pull" / "last synced" provenance labels. NEVER throws.
// ============================================================
export function adaptApiSource(apiResponseData, { sourceId, url } = {}) {
  return adaptJsonPayload(apiResponseData, { sourceId, url, kind: 'api' });
}

// ============================================================
// adaptSiteExport(exportData, { sourceId, url }) — same contract as the API
// adapter but for a table exported/scraped from a site and already parsed into
// rows client-side (an HTML table turned into row objects, or a downloaded
// CSV/JSON export). Shares all defensive parsing with adaptApiSource via the
// common helper; differs only in origin kind + default trust. NEVER throws.
// ============================================================
export function adaptSiteExport(exportData, { sourceId, url } = {}) {
  return adaptJsonPayload(exportData, { sourceId, url, kind: 'site' });
}

// ============================================================
// toEngineSources(adapterResults) — convenience: flatten a mix of single-source
// and per-sheet-array adapter results into the { id, rows, possibleKeys } list
// buildConvergenceGraph wants, dropping any error-flagged (meta.ok === false)
// source so the engine only ever sees usable input. Also returns the sourceTrust
// map resolveClusterWithTrust wants, keyed by the same ids. NEVER throws.
// ============================================================
export function toEngineSources(adapterResults) {
  const sources = [];
  const sourceTrust = {};
  try {
    const flat = [];
    for (const r of Array.isArray(adapterResults) ? adapterResults : [adapterResults]) {
      if (Array.isArray(r)) flat.push(...r);
      else if (isPlainObject(r)) flat.push(r);
    }
    for (const s of flat) {
      if (!isPlainObject(s) || !s.meta || s.meta.ok !== true) continue;
      if (!isArrayOfRows(s.rows)) continue;
      sources.push({ id: s.id, rows: s.rows, possibleKeys: Array.isArray(s.possibleKeys) ? s.possibleKeys : [] });
      if (typeof s.trust === 'number' && Number.isFinite(s.trust)) sourceTrust[s.id] = s.trust;
    }
  } catch {
    return { sources: [], sourceTrust: {} };
  }
  return { sources, sourceTrust };
}
