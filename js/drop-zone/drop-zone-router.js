// ============================================================
// DATAGLOW — Universal Drop Zone: Format Detection & Routing
// ============================================================
// This module is the pure-logic routing layer that sits between a file drop
// event and DataGlow's ingestion pipeline. It contains NO browser APIs —
// no File, no FileReader, no drag/drop event handling. All of that lives in
// the UI layer, which reads File objects and passes plain data structures
// (strings, numbers, Uint8Array) into the functions exported here.
//
// Why this split matters:
//   - Pure logic is trivially unit-testable in Node (see
//     test/drop-zone/drop-zone-router.test.js) with no DOM, no jsdom, no
//     File API polyfills.
//   - The UI layer owns all async File reading. By the time anything in
//     this module runs, the bytes are already in memory as a Uint8Array.
//
// How the UI layer builds `firstBytes` for detectFileFormat / buildDropManifest:
//
//   const buf = await file.arrayBuffer();
//   const firstBytes = new Uint8Array(buf.slice(0, 16));
//
// Pipeline overview:
//   1. UI layer collects dropped/selected File objects, reads the first 16
//      bytes of each, and builds `{ name, mimeType, size, firstBytes }`.
//   2. buildDropManifest(files) turns that into a DropManifest — one item
//      per file, each carrying its detected format/handler/confidence plus
//      a cleaned display name and tab order.
//   3. routeDropManifest(manifest) partitions the manifest's items into
//      per-handler buckets (duckdbFiles, univerFiles, ragFiles,
//      transcriptionFiles, webCodecsFiles, unknownFiles) so the app shell
//      knows which subsystem to hand each file to.
//   4. buildTabDescriptor() produces the per-file tab strip entry (name,
//      format, status, icon) that the UI renders and updates as each file
//      moves through loading → ready/error/transcribing/indexing.
//   5. Once tabular datasets are loaded, buildJoinPanelDescriptor() inspects
//      their columns and proposes candidate joins. This is a HEURISTIC ONLY:
//      the suggestion engine never executes a join on its own — the user
//      always reviews and confirms a suggested join before it runs against
//      DuckDB.
// ============================================================

// ---------------------------------------------------------------
// Types (JSDoc only — no runtime overhead)
// ---------------------------------------------------------------
/**
 * @typedef {'csv'|'tsv'|'xlsx'|'json'|'ndjson'|'parquet'|'pdf'|'audio'|'video'|'unknown'} FileFormat
 * @typedef {'high'|'medium'|'low'} Confidence
 * @typedef {'duckdb'|'univer'|'rag'|'whisper'|'webcodecs'|'unknown'} Handler
 * @typedef {{ format: FileFormat, confidence: Confidence, handler: Handler }} FormatDetection
 * @typedef {{ name: string, mimeType: string, size: number, firstBytes: Uint8Array }} DroppedFile
 * @typedef {{
 *   fileId: string, name: string, size: number, format: FileFormat,
 *   handler: Handler, confidence: Confidence, displayName: string, tabOrder: number
 * }} ManifestItem
 * @typedef {{
 *   manifestId: string, totalFiles: number, items: ManifestItem[],
 *   hasMixedFormats: boolean, requiresTranscription: boolean, requiresRAG: boolean
 * }} DropManifest
 * @typedef {{
 *   duckdbFiles: ManifestItem[], univerFiles: ManifestItem[], ragFiles: ManifestItem[],
 *   transcriptionFiles: ManifestItem[], webCodecsFiles: ManifestItem[], unknownFiles: ManifestItem[]
 * }} RoutingPlan
 * @typedef {{ name: string, type: string }} ColumnDef
 * @typedef {{ tabId: string, displayName: string, columns: ColumnDef[] }} LoadedDataset
 * @typedef {{
 *   leftDataset: string, rightDataset: string, leftColumn: string, rightColumn: string,
 *   confidence: Confidence, reason: string
 * }} SuggestedJoin
 * @typedef {{ availableDatasets: LoadedDataset[], suggestedJoins: SuggestedJoin[] }} JoinPanelDescriptor
 * @typedef {'loading'|'ready'|'error'|'transcribing'|'indexing'} TabStatus
 * @typedef {'table'|'grid'|'document'|'audio'|'video'|'unknown'} TabIcon
 * @typedef {{ fileId: string, displayName: string, format: FileFormat, status: TabStatus, icon: TabIcon }} TabDescriptor
 */

// ---------------------------------------------------------------
// Constants
// ---------------------------------------------------------------

/** Handler for each detected format. */
const FORMAT_HANDLERS = /** @type {Record<FileFormat, Handler>} */ ({
  csv: 'duckdb',
  tsv: 'duckdb',
  json: 'duckdb',
  ndjson: 'duckdb',
  parquet: 'duckdb',
  xlsx: 'univer',
  pdf: 'rag',
  audio: 'whisper',
  video: 'webcodecs',
  unknown: 'unknown',
});

/** Tab strip icon for each detected format. */
const FORMAT_ICONS = /** @type {Record<FileFormat, TabIcon>} */ ({
  csv: 'table',
  tsv: 'table',
  json: 'table',
  ndjson: 'table',
  parquet: 'table',
  xlsx: 'grid',
  pdf: 'document',
  audio: 'audio',
  video: 'video',
  unknown: 'unknown',
});

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.flac'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm'];

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------

/** Lowercased file extension including the leading dot, or '' if none. */
function extOf(fileName) {
  const m = /\.[^./\\]+$/.exec(fileName || '');
  return m ? m[0].toLowerCase() : '';
}

/** True if `bytes` starts with the given ASCII string, at the given offset. */
function bytesStartWith(bytes, ascii, offset = 0) {
  if (!bytes || bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/** True if `bytes` starts with a raw zip local-file-header signature `PK\x03\x04` (or the general `PK`). */
function bytesStartWithPK(bytes) {
  return !!bytes && bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b; // 'P','K'
}

function handlerForFormat(format) {
  return FORMAT_HANDLERS[format] || 'unknown';
}

function iconForFormat(format) {
  return FORMAT_ICONS[format] || 'unknown';
}

// ---------------------------------------------------------------
// detectFileFormat
// ---------------------------------------------------------------

/**
 * Detect a dropped file's format using magic bytes first, then MIME type,
 * then filename extension as a last resort.
 *
 * @param {string} fileName
 * @param {string} mimeType
 * @param {Uint8Array} firstBytes  first 16 bytes of the file
 * @returns {FormatDetection}
 */
export function detectFileFormat(fileName, mimeType, firstBytes) {
  const name = fileName || '';
  const mime = mimeType || '';
  const ext = extOf(name);

  // ---- 1. Magic bytes (highest confidence) ----
  if (bytesStartWith(firstBytes, 'PAR1', 0)) {
    return { format: 'parquet', confidence: 'high', handler: handlerForFormat('parquet') };
  }
  if (bytesStartWith(firstBytes, '%PDF', 0)) {
    return { format: 'pdf', confidence: 'high', handler: handlerForFormat('pdf') };
  }
  if (bytesStartWithPK(firstBytes) && ext === '.xlsx') {
    return { format: 'xlsx', confidence: 'high', handler: handlerForFormat('xlsx') };
  }

  // ---- 2. MIME type fallbacks ----
  if (mime === 'text/csv') {
    return { format: 'csv', confidence: 'medium', handler: handlerForFormat('csv') };
  }
  if (mime === 'application/json') {
    return { format: 'json', confidence: 'medium', handler: handlerForFormat('json') };
  }
  if (mime.startsWith('audio/')) {
    return { format: 'audio', confidence: 'medium', handler: handlerForFormat('audio') };
  }
  if (mime.startsWith('video/')) {
    return { format: 'video', confidence: 'medium', handler: handlerForFormat('video') };
  }

  // ---- 3. Filename extension as last resort ----
  if (ext === '.tsv') {
    return { format: 'tsv', confidence: 'low', handler: handlerForFormat('tsv') };
  }
  if (ext === '.parquet') {
    return { format: 'parquet', confidence: 'low', handler: handlerForFormat('parquet') };
  }
  if (ext === '.csv') {
    return { format: 'csv', confidence: 'low', handler: handlerForFormat('csv') };
  }
  if (ext === '.json') {
    return { format: 'json', confidence: 'low', handler: handlerForFormat('json') };
  }
  if (ext === '.ndjson') {
    // Extension distinguishes intent, but the JSON vs NDJSON parse strategy
    // itself is decided by the DuckDB layer at load time.
    return { format: 'json', confidence: 'low', handler: handlerForFormat('json') };
  }
  if (ext === '.xlsx') {
    return { format: 'xlsx', confidence: 'low', handler: handlerForFormat('xlsx') };
  }
  if (ext === '.pdf') {
    return { format: 'pdf', confidence: 'low', handler: handlerForFormat('pdf') };
  }
  if (AUDIO_EXTENSIONS.includes(ext)) {
    return { format: 'audio', confidence: 'low', handler: handlerForFormat('audio') };
  }
  if (VIDEO_EXTENSIONS.includes(ext)) {
    return { format: 'video', confidence: 'low', handler: handlerForFormat('video') };
  }

  return { format: 'unknown', confidence: 'low', handler: 'unknown' };
}

// ---------------------------------------------------------------
// buildDropManifest
// ---------------------------------------------------------------

/** Strip the extension and replace underscores with spaces for tab labels. */
function cleanDisplayName(fileName) {
  const ext = extOf(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  return base.replace(/_/g, ' ');
}

let _manifestCounter = 0;
/** Reset the manifest/file id counters — tests only. */
export function _resetDropZoneCounters() {
  _manifestCounter = 0;
}

function nextManifestId() {
  return `manifest_${Date.now().toString(36)}_${(++_manifestCounter).toString(36)}`;
}

function fileIdFor(index, name) {
  return `file_${index}_${(name || '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
}

/**
 * Build a DropManifest describing every file in a single drop event.
 *
 * @param {DroppedFile[]} files
 * @returns {DropManifest}
 */
export function buildDropManifest(files) {
  const list = files || [];
  const items = list.map((f, index) => {
    const { format, confidence, handler } = detectFileFormat(f.name, f.mimeType, f.firstBytes);
    return {
      fileId: fileIdFor(index, f.name),
      name: f.name,
      size: f.size,
      format,
      handler,
      confidence,
      displayName: cleanDisplayName(f.name || ''),
      tabOrder: index,
    };
  });

  const handlersPresent = new Set(items.map((i) => i.handler));
  const hasMixedFormats = handlersPresent.size > 1;
  const requiresTranscription = items.some((i) => i.format === 'audio' || i.format === 'video');
  const requiresRAG = items.some((i) => i.format === 'pdf');

  return {
    manifestId: nextManifestId(),
    totalFiles: items.length,
    items,
    hasMixedFormats,
    requiresTranscription,
    requiresRAG,
  };
}

// ---------------------------------------------------------------
// routeDropManifest
// ---------------------------------------------------------------

/**
 * Partition a DropManifest's items into per-handler buckets for the app
 * shell to dispatch to the correct subsystem.
 *
 * @param {DropManifest} manifest
 * @returns {RoutingPlan}
 */
export function routeDropManifest(manifest) {
  const plan = {
    duckdbFiles: [],
    univerFiles: [],
    ragFiles: [],
    transcriptionFiles: [],
    webCodecsFiles: [],
    unknownFiles: [],
  };

  const items = (manifest && manifest.items) || [];
  for (const item of items) {
    switch (item.handler) {
      case 'duckdb':
        plan.duckdbFiles.push(item);
        break;
      case 'univer':
        plan.univerFiles.push(item);
        break;
      case 'rag':
        plan.ragFiles.push(item);
        break;
      case 'whisper':
        plan.transcriptionFiles.push(item);
        break;
      case 'webcodecs':
        plan.webCodecsFiles.push(item);
        break;
      default:
        plan.unknownFiles.push(item);
    }
  }

  return plan;
}

// ---------------------------------------------------------------
// buildJoinPanelDescriptor
// ---------------------------------------------------------------

/** Normalize a SQL-ish type string for compatibility comparisons. */
function normalizeType(type) {
  const t = (type || '').toUpperCase();
  if (/^(VARCHAR|TEXT|STRING|CHAR)/.test(t)) return 'STRING';
  if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT)/.test(t)) return 'INTEGER';
  if (/^(DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)/.test(t)) return 'NUMERIC';
  if (/^(DATE|TIMESTAMP|DATETIME)/.test(t)) return 'DATE';
  if (/^BOOL/.test(t)) return 'BOOLEAN';
  return t;
}

function typesCompatible(a, b) {
  return normalizeType(a) === normalizeType(b);
}

/**
 * True if one column name contains the other as a meaningful substring
 * (e.g. 'patient_id' contains 'id', but only counted when it's not an
 * exact match — exact matches are handled separately with high confidence).
 */
function isFuzzyNameMatch(a, b) {
  if (a === b) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 2) return false;
  return longer.includes(shorter);
}

/**
 * Build the join panel descriptor: the list of available datasets plus
 * heuristic join suggestions between every pair of datasets. This is a
 * heuristic-only aid — no join is ever executed automatically. The user
 * always reviews and confirms a suggestion before it runs against DuckDB.
 *
 * @param {LoadedDataset[]} loadedDatasets
 * @returns {JoinPanelDescriptor}
 */
export function buildJoinPanelDescriptor(loadedDatasets) {
  const datasets = loadedDatasets || [];
  const suggestedJoins = [];

  for (let i = 0; i < datasets.length; i++) {
    for (let j = i + 1; j < datasets.length; j++) {
      const left = datasets[i];
      const right = datasets[j];
      const leftCols = left.columns || [];
      const rightCols = right.columns || [];

      for (const lc of leftCols) {
        for (const rc of rightCols) {
          if (!typesCompatible(lc.type, rc.type)) continue;

          if (lc.name === rc.name) {
            suggestedJoins.push({
              leftDataset: left.tabId,
              rightDataset: right.tabId,
              leftColumn: lc.name,
              rightColumn: rc.name,
              confidence: 'high',
              reason: `Both datasets have a '${lc.name}' column of type ${normalizeType(lc.type)}`,
            });
          } else if (isFuzzyNameMatch(lc.name, rc.name)) {
            suggestedJoins.push({
              leftDataset: left.tabId,
              rightDataset: right.tabId,
              leftColumn: lc.name,
              rightColumn: rc.name,
              confidence: 'medium',
              reason: `Column '${lc.name}' and '${rc.name}' appear related and share type ${normalizeType(lc.type)}`,
            });
          }
        }
      }
    }
  }

  return {
    availableDatasets: datasets,
    suggestedJoins,
  };
}

// ---------------------------------------------------------------
// buildTabDescriptor
// ---------------------------------------------------------------

/**
 * Build a tab descriptor for the UI tab strip.
 *
 * @param {string} fileId
 * @param {string} displayName
 * @param {FileFormat} format
 * @param {TabStatus} status
 * @returns {TabDescriptor}
 */
export function buildTabDescriptor(fileId, displayName, format, status) {
  return {
    fileId,
    displayName,
    format,
    status,
    icon: iconForFormat(format),
  };
}
