// ============================================================
// DATAGLOW - R4 Ship pack (pure engine)
// ============================================================
// WHY THIS EXISTS
// R3_R4_CAPTURE_SHIP_SPEC.md, "R4 Ship pack": an "Export ship pack" action
// that assembles a portable bundle for a portfolio/handoff: keepers.json
// (from Scout, if present), claims.json (proven claims + SQL + engine ids),
// validation_summary.json, an honest_claims.md template, and screenshots/
// if any were captured with R3. Everything here is pure data shaping: given
// already-computed inputs (Scout's keepers export, Proof Harness receipts,
// a validation summary array, R3's screenshot manifest), build the file set
// a canvas UI can zip or multi-download. No network, no DOM, no crypto here
// (receipts/keepers already carry their own hashes from their own modules;
// this module never re-derives or invents one).
//
// HONESTY BOUNDARY (SPEC: "no pure-local overclaim")
// honest_claims.md is a TEMPLATE, not a marketing document: every claim line
// it emits is sourced directly from a proof-harness receipt with a GREEN
// verdict, carrying that receipt's own SQL statement and engine id(s), and
// every section explicitly separates PROVEN (has a GREEN receipt) from
// UNVERIFIED (a Scout keeper with no matching receipt yet) so a reader can
// never mistake a brainstormed question for a checked number. A dataset that
// was only ever explored locally, with zero GREEN receipts, produces a
// template that says exactly that instead of inventing scale/impact language.

export const SHIP_PACK_VERSION = 1;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * keepers.json builder. Scout's own buildKeepersExport() already produces
 * the right shape (js/question-scout/question-scout.js); this just guards
 * against Scout being entirely absent (no keepers proposed this session) so
 * the ship pack never crashes when a user goes straight from Validate to
 * Export without touching Scout.
 * @param {object|null} keepersExport Result of Scout's buildKeepersExport(), or null/undefined.
 */
export function buildKeepersFile(keepersExport) {
  if (isPlainObject(keepersExport) && keepersExport.kind === 'dataglow-question-scout-keepers-export') {
    return keepersExport;
  }
  return {
    kind: 'dataglow-question-scout-keepers-export',
    version: null,
    exportedAt: new Date().toISOString(),
    keepers: [],
    note: 'No Scout keepers were proposed or kept this session.',
  };
}

/**
 * Extract a proof-harness receipt ledger entry down to the fields the SPEC
 * asks claims.json to carry: the claim text, the SQL/statement actually run,
 * the verdict, and every engine id involved (primary run plus any
 * corroborating second engine). Tolerant of a receipt missing any of these
 * sub-objects (buildReceiptPredicate() already defaults them), so a v0-only
 * receipt with no corroboration section still yields a valid, honest row.
 * @param {object} entry One entry from createReceiptLedger().getEntries().
 */
export function claimFromReceiptEntry(entry) {
  const rec = isPlainObject(entry) && isPlainObject(entry.record) ? entry.record : {};
  const predicate = isPlainObject(rec.predicate) ? rec.predicate : {};
  const claim = isPlainObject(predicate.claim) ? predicate.claim : {};
  const run = isPlainObject(predicate.run) ? predicate.run : {};
  const verdict = isPlainObject(predicate.verdict) ? predicate.verdict : {};
  const corroboration = isPlainObject(predicate.corroboration) ? predicate.corroboration : null;

  const engineIds = [];
  if (run.engine) engineIds.push(run.engine);
  if (corroboration && corroboration.engine) engineIds.push(corroboration.engine);
  if (corroboration && Array.isArray(corroboration.engines)) {
    for (const e of corroboration.engines) if (e && !engineIds.includes(e)) engineIds.push(e);
  }

  return {
    receiptIndex: typeof entry.index === 'number' ? entry.index : null,
    receiptHash: typeof entry.hash === 'string' ? entry.hash : null,
    claimText: typeof claim.text === 'string' ? claim.text : null,
    sql: typeof claim.predicate_ast === 'string' ? claim.predicate_ast : (typeof run.statement === 'string' ? run.statement : null),
    engineIds,
    verdictState: typeof verdict.state === 'string' ? verdict.state : null,
    reasonCode: typeof verdict.reason_code === 'string' ? verdict.reason_code : null,
    rowcount: run.rowcount != null ? run.rowcount : null,
    scalars: isPlainObject(run.scalars) ? run.scalars : {},
    corroborated: !!corroboration,
    capturedAt: typeof entry.ts === 'number' ? new Date(entry.ts).toISOString() : null,
  };
}

/**
 * claims.json builder: every proof-harness receipt, reduced to the SPEC's
 * "proven claims + SQL + engine ids" shape via claimFromReceiptEntry(), plus
 * a summary count split by verdict state so a reader does not have to count
 * rows by hand. An empty or missing ledger produces an honest empty file,
 * never a fabricated example claim.
 * @param {Array<object>|null} receiptEntries getReceipts()/ledger.getEntries() result, or null.
 */
export function buildClaimsFile(receiptEntries) {
  const entries = Array.isArray(receiptEntries) ? receiptEntries : [];
  const claims = entries.map(claimFromReceiptEntry);
  const greenCount = claims.filter((c) => c.verdictState === 'GREEN').length;
  const amberCount = claims.filter((c) => c.verdictState === 'AMBER').length;
  const redCount = claims.filter((c) => c.verdictState === 'RED').length;
  return {
    kind: 'dataglow-ship-pack-claims',
    version: SHIP_PACK_VERSION,
    exportedAt: new Date().toISOString(),
    totalClaims: claims.length,
    verdictCounts: { GREEN: greenCount, AMBER: amberCount, RED: redCount, other: claims.length - greenCount - amberCount - redCount },
    claims,
  };
}

/**
 * validation_summary.json builder. Accepts the same per-layer shape
 * export-report.js's buildDatasetView() already produces
 * ({layer, name, status, summary}), so no second validation-summarizing code
 * path is invented here. Missing/absent validation input yields an honest
 * "not available" file rather than a fabricated all-pass summary.
 * @param {Array<{layer?:string, name?:string, status?:string, summary?:string}>|null} validationLayers
 */
export function buildValidationSummaryFile(validationLayers) {
  const layers = Array.isArray(validationLayers) ? validationLayers : [];
  const passed = layers.filter((l) => l && String(l.status).toUpperCase() === 'PASS').length;
  const warned = layers.filter((l) => l && String(l.status).toUpperCase() === 'WARN').length;
  const failed = layers.filter((l) => l && String(l.status).toUpperCase() === 'FAIL').length;
  return {
    kind: 'dataglow-ship-pack-validation-summary',
    version: SHIP_PACK_VERSION,
    exportedAt: new Date().toISOString(),
    available: layers.length > 0,
    layerCount: layers.length,
    counts: { pass: passed, warn: warned, fail: failed, other: layers.length - passed - warned - failed },
    layers: layers.map((l) => ({
      layer: (l && (l.layer || l.name)) || 'unknown',
      status: (l && l.status) || 'UNKNOWN',
      summary: (l && l.summary) || '',
    })),
  };
}

/**
 * Render one claims.json row as a single honest_claims.md line: PROVEN rows
 * (GREEN verdict) get the claim text, the SQL, and engine ids; anything else
 * is never mentioned in the PROVEN section at all (see buildHonestClaimsMd).
 */
function renderProvenLine(c) {
  const engines = c.engineIds.length ? c.engineIds.join(', ') : 'unknown engine';
  const corro = c.corroborated ? ' (second-engine corroborated)' : '';
  return (
    `- **${c.claimText || '(untitled claim)'}**${corro}\n` +
    `  - Engine(s): ${engines}\n` +
    `  - SQL: \`${c.sql || 'n/a'}\`\n` +
    `  - Receipt: \`${c.receiptHash || 'n/a'}\`\n`
  );
}

/**
 * Render one Scout keeper as an honest_claims.md UNVERIFIED line: the
 * question text and why it matters only, explicitly labeled as not yet
 * proven, and never carrying a number as if it were checked.
 */
function renderUnverifiedLine(k) {
  return `- ${k.text || '(untitled question)'} _(not yet proven; no receipt)_\n`;
}

/**
 * honest_claims.md template builder. This is the SPEC's "no pure-local
 * overclaim" guarantee made concrete: PROVEN and UNVERIFIED are separate
 * sections, a claim only ever appears in PROVEN when a matching GREEN
 * receipt exists, and a dataset with zero GREEN receipts gets an explicit
 * "Nothing in this pack is proven yet" line instead of silence (silence
 * reads as "trust me", which is the exact overclaim this file exists to
 * prevent).
 * @param {{claimsFile:object, keepersFile:object, validationFile:object}} args
 */
export function buildHonestClaimsMarkdown(args) {
  const a = isPlainObject(args) ? args : {};
  const claimsFile = isPlainObject(a.claimsFile) ? a.claimsFile : buildClaimsFile(null);
  const keepersFile = isPlainObject(a.keepersFile) ? a.keepersFile : buildKeepersFile(null);
  const validationFile = isPlainObject(a.validationFile) ? a.validationFile : buildValidationSummaryFile(null);

  const proven = (claimsFile.claims || []).filter((c) => c.verdictState === 'GREEN');
  const provenReceiptTexts = new Set(proven.map((c) => (c.claimText || '').trim().toLowerCase()).filter(Boolean));
  const keepers = keepersFile.keepers || [];
  const unverifiedKeepers = keepers.filter((k) => !provenReceiptTexts.has((k.text || '').trim().toLowerCase()));

  const lines = [];
  lines.push('# Honest claims');
  lines.push('');
  lines.push('This file is generated by DataGlow\u2019s Ship pack (R4). It separates what was');
  lines.push('actually proven on this machine from what was only proposed. Nothing in the');
  lines.push('PROVEN section below was hand-typed after the fact; every line is sourced');
  lines.push('directly from a Proof Harness receipt with a GREEN verdict.');
  lines.push('');
  lines.push('## PROVEN (has a GREEN receipt)');
  lines.push('');
  if (proven.length === 0) {
    lines.push('Nothing in this pack is proven yet. Run Prove on a claim to add one.');
  } else {
    for (const c of proven) lines.push(renderProvenLine(c).trimEnd());
  }
  lines.push('');
  lines.push('## UNVERIFIED (proposed by Scout, not yet run through Prove)');
  lines.push('');
  if (unverifiedKeepers.length === 0) {
    lines.push('No outstanding unverified keepers.');
  } else {
    for (const k of unverifiedKeepers) lines.push(renderUnverifiedLine(k).trimEnd());
  }
  lines.push('');
  lines.push('## Validation status');
  lines.push('');
  if (!validationFile.available) {
    lines.push('Validation summary not available (run the Validate tab to include one).');
  } else {
    lines.push(`${validationFile.layerCount} layer(s) checked: ${validationFile.counts.pass} pass, ${validationFile.counts.warn} warn, ${validationFile.counts.fail} fail.`);
  }
  lines.push('');
  lines.push('---');
  lines.push('Generated locally by DataGlow. Your data never left this device.');
  lines.push('');
  return lines.join('\n');
}

/**
 * Build the full ship pack: a plain object map of relative file path to
 * either a JSON-serializable value (for the *.json files) or a string (for
 * honest_claims.md), plus a manifest for the screenshots/ folder if any
 * captures were supplied. The canvas UI turns this into an actual ZIP (or a
 * sequence of downloads if a ZIP library is unavailable) -- this function
 * never touches Blob/File/IndexedDB itself so it stays trivially testable.
 * @param {{keepersExport?:object, receiptEntries?:Array, validationLayers?:Array, screenshotManifest?:Array, datasetName?:string}} args
 */
export function buildShipPack(args) {
  const a = isPlainObject(args) ? args : {};
  const keepersFile = buildKeepersFile(a.keepersExport);
  const claimsFile = buildClaimsFile(a.receiptEntries);
  const validationFile = buildValidationSummaryFile(a.validationLayers);
  const honestClaimsMd = buildHonestClaimsMarkdown({ claimsFile, keepersFile, validationFile });
  const screenshots = Array.isArray(a.screenshotManifest) ? a.screenshotManifest : [];

  const files = {
    'keepers.json': keepersFile,
    'claims.json': claimsFile,
    'validation_summary.json': validationFile,
    'honest_claims.md': honestClaimsMd,
  };
  if (screenshots.length > 0) {
    files['screenshots/manifest.json'] = {
      kind: 'dataglow-ship-pack-screenshots-manifest',
      version: SHIP_PACK_VERSION,
      count: screenshots.length,
      screenshots,
    };
  }

  return {
    kind: 'dataglow-ship-pack',
    version: SHIP_PACK_VERSION,
    exportedAt: new Date().toISOString(),
    datasetName: typeof a.datasetName === 'string' && a.datasetName.trim() ? a.datasetName.trim() : null,
    fileNames: Object.keys(files),
    files,
  };
}

/**
 * Serialize buildShipPack()'s output into a flat list of
 * {path, contents, mimeType} entries ready to hand to a ZIP writer or a
 * sequence of anchor-download clicks: JSON files are pretty-printed with a
 * trailing newline, honest_claims.md is written verbatim as text/markdown.
 * @param {object} shipPack Result of buildShipPack().
 */
export function serializeShipPackFiles(shipPack) {
  const pack = isPlainObject(shipPack) ? shipPack : buildShipPack({});
  const files = isPlainObject(pack.files) ? pack.files : {};
  return Object.keys(files).map((path) => {
    const value = files[path];
    if (path.endsWith('.md')) {
      return { path, contents: String(value), mimeType: 'text/markdown' };
    }
    return { path, contents: JSON.stringify(value, null, 2) + '\n', mimeType: 'application/json' };
  });
}

// ------------------------------------------------------------
// Public namespace export. window.DataGlowShipPack.export() (the SPEC's
// exact requested API) is the DOM-facing wrapper the canvas UI module
// installs; this pure module exposes buildShipPack()/serializeShipPackFiles()
// as the data half of that call so window.DataGlowShipPack.export() has no
// logic of its own beyond gathering live inputs and triggering the download.
// ------------------------------------------------------------
export const DataGlowShipPackEngine = {
  SHIP_PACK_VERSION,
  buildKeepersFile,
  claimFromReceiptEntry,
  buildClaimsFile,
  buildValidationSummaryFile,
  buildHonestClaimsMarkdown,
  buildShipPack,
  serializeShipPackFiles,
};

export default DataGlowShipPackEngine;
