// ============================================================
// DATAGLOW — Rooms: async collaboration via signed findings JSON (Feature 11)
// ============================================================
// A DataGlow "Room" (this file's Room, NOT the WebRTC live-pairing Room in
// js/rooms/room-signaling.js / room-broadcast.js / room-ui.js /
// room-transport-adapter.js — see the note at the bottom of this header for
// how the two relate) is a small, static, signed JSON object an analyst
// exports from the Canvas and hands to a collaborator through ANY channel —
// Slack, email, a shared drive, a git repo, a USB stick. It carries:
//
//   - the validation findings for a dataset (descriptions of what was
//     wrong — severity, column, message, rows affected — never a raw cell
//     value or row),
//   - the institutional memory timeline (js/memory/institutional-memory.js's
//     generateTimeline() output — plain-language "who did what when"),
//   - the full memory NDJSON audit trail (exportNDJSON() — optional),
//   - the Story View's key-finding sentence (optional),
//   - the Proof Export package hash (optional, js/proof/proof-builder.js).
//
// It NEVER carries the dataset itself. This is the same zero-raw-data
// discipline every other DataGlow feature already follows (Proof Export,
// institutional memory, the live WebRTC Rooms above) taken to its logical
// async conclusion: a Room is proof that two people can fully understand and
// verify what was found in a dataset without either of them ever receiving
// the file.
//
// PURITY: pure logic — no DOM, no browser APIs, no file I/O, no network, no
// crypto library. Mirrors js/memory/institutional-memory.js, js/story/
// story-builder.js, and js/proof/proof-builder.js exactly: identical
// behavior in the browser, the Tauri desktop shell, and headless Node
// tests. The caller (the Canvas import/export UI) owns the actual file
// save/load dialog; this module only ever produces/consumes plain strings
// and plain objects.
//
// SIGNED, NOT CRYPTOGRAPHIC: every Room carries a `signature` field — a
// djb2 hash (the same dependency-free algorithm used throughout this
// codebase; see js/memory/institutional-memory.js, js/story/story-builder.js,
// js/proof/proof-builder.js) computed over every other field, LAST, after
// everything else is final. verifyRoom() re-derives it and compares. This
// detects accidental corruption and casual tampering — editing a Room by
// hand and forgetting to fix the signature is caught immediately — but it
// is NOT a cryptographic MAC: there is no secret key, so a
// determined adversary with the algorithm (it's public, right here) can
// forge a valid-looking signature over an edited Room. See docs/rooms.md
// Section 6 for the honest limits and how to pair a Room with a
// cryptographically-verifiable .proof file for a stronger guarantee.
//
// RELATIONSHIP TO THE OTHER "DataGlow Rooms": js/rooms/room-signaling.js and
// its Batch 2-4 siblings are a *live, synchronous, WebRTC-peer-to-peer*
// concept — two browsers open, both online, at the same time, watching each
// other's Object Space entries update. THIS file is Feature 11 from the
// Canvas spec / NORTH_STAR.md: an *async, offline-friendly, file-based*
// concept — a signed JSON blob, no browser tab needs to be open on either
// end simultaneously. They share the "Room" name and the zero-raw-data
// principle, but are otherwise independent features living side by side in
// the same js/rooms/ directory; neither imports the other.
// ============================================================

export const ROOM_VERSION = 1;
export const ROOM_FORMAT = 'dataglow-room';

// ---------- djb2 hash (dependency-free, deterministic, sync) ----------
// Same algorithm used elsewhere in the codebase (js/memory/institutional-memory.js,
// js/story/story-builder.js, js/proof/proof-builder.js) — NOT a cryptographic
// security boundary, just a fast, deterministic, dependency-free fingerprint
// over a string. See docs/rooms.md Section 6 for the SubtleCrypto upgrade
// path and why Rooms deliberately doesn't need it (that's what pairing with
// a .proof file is for).
function djb2(str) {
  let hash = 5381;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0; // hash * 33 + c
  }
  return `djb2:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// ---------- Canonical serialization helpers ----------

// Canonical, order-independent representation of a single Finding — mirrors
// canonicalFinding in js/proof/proof-builder.js exactly, so a Finding hashes
// identically whether it travels through a .proof package or a Room.
// Deliberately excludes anything resembling a raw value: only severity,
// column, message, rowsAffected, suggestedFix, status ever pass through.
function canonicalFinding(f) {
  const safe = {
    severity: (f && f.severity) ?? null,
    column: (f && f.column) ?? null,
    message: (f && f.message) ?? null,
    rowsAffected: (f && typeof f.rowsAffected === 'number') ? f.rowsAffected : null,
    suggestedFix: (f && f.suggestedFix) ?? null,
    status: (f && f.status) ?? null,
  };
  return JSON.stringify(safe, Object.keys(safe).sort());
}

function severityRank(severity) {
  switch (severity) {
    case 'critical': return 0;
    case 'error': return 1;
    case 'warning': return 2;
    case 'info': return 3;
    default: return 4;
  }
}

function sortFindingsDeterministically(findings) {
  return findings.slice().sort((a, b) => {
    const rankDiff = severityRank(a && a.severity) - severityRank(b && b.severity);
    if (rankDiff !== 0) return rankDiff;
    const colA = (a && a.column) || '';
    const colB = (b && b.column) || '';
    if (colA !== colB) return colA < colB ? -1 : 1;
    const msgA = (a && a.message) || '';
    const msgB = (b && b.message) || '';
    if (msgA !== msgB) return msgA < msgB ? -1 : 1;
    return 0;
  });
}

function sanitizeFinding(f) {
  return {
    severity: (f && f.severity) ?? 'info',
    column: (f && f.column) ?? null,
    message: (f && f.message) ?? '',
    rowsAffected: (f && typeof f.rowsAffected === 'number') ? f.rowsAffected : 0,
    suggestedFix: (f && f.suggestedFix) ?? null,
    status: (f && f.status) ?? 'open',
  };
}

function countBySeverity(findings, severities) {
  const set = new Set(severities);
  return findings.filter((f) => f && set.has(f.severity)).length;
}

function findingKey(f) {
  return `${(f && f.column) ?? ''}\u0000${(f && f.message) ?? ''}`;
}

// ---------- createRoom ----------

/**
 * createRoom(session, options = {})
 * Builds a Room object from a live session — findings, institutional memory
 * timeline/NDJSON, the story's key-finding sentence, and the Proof Export
 * package hash. See file header + docs/rooms.md for the full schema and
 * the zero-raw-data guarantee. NO field of a Room ever holds row data,
 * cell values, or source file content, regardless of what garbage might be
 * present on the input `session` object — createRoom only ever reads the
 * specific documented fields off `session` and re-derives everything else.
 */
export function createRoom(session, options = {}) {
  const s = isPlainObject(session) ? session : {};
  const opts = isPlainObject(options) ? options : {};
  const includeTimeline = opts.includeTimeline !== false; // default true
  const includeMemoryNDJSON = opts.includeMemoryNDJSON !== false; // default true

  const rawFindings = Array.isArray(s.findings) ? s.findings : [];
  const findings = sortFindingsDeterministically(rawFindings).map(sanitizeFinding);

  const errorCount = countBySeverity(findings, ['error', 'critical']);
  const warningCount = countBySeverity(findings, ['warning']);
  const totalFindings = findings.length;

  const roomName = isNonEmptyString(s.roomName) ? s.roomName : 'Untitled Room';
  const createdBy = isNonEmptyString(s.createdBy) ? s.createdBy : 'Unknown analyst';
  const createdAt = isNonEmptyString(s.createdAt) ? s.createdAt : new Date().toISOString();
  const sourceFileHash = isNonEmptyString(s.sourceFileHash) ? s.sourceFileHash : null;

  const dataset = {
    name: s.datasetName ?? null,
    sourceFileHash,
    rowCount: typeof s.rowCount === 'number' ? s.rowCount : 0,
    columnCount: typeof s.columnCount === 'number' ? s.columnCount : 0,
  };

  const timeline = includeTimeline && Array.isArray(s.memoryTimeline)
    ? s.memoryTimeline.slice()
    : null;

  const memoryNDJSON = includeMemoryNDJSON && typeof s.memoryNDJSON === 'string'
    ? s.memoryNDJSON
    : null;

  const storySummary = isNonEmptyString(s.storySummary) ? s.storySummary : null;
  const proofHash = isNonEmptyString(s.proofHash) ? s.proofHash : null;

  const roomId = djb2(`${roomName}\u0000${sourceFileHash ?? ''}\u0000${createdAt}`);

  const summary = {
    totalFindings,
    errorCount,
    warningCount,
    storySummary,
  };

  const roomWithoutSignature = {
    version: ROOM_VERSION,
    format: ROOM_FORMAT,
    roomId,
    roomName,
    createdBy,
    createdAt,
    dataset,
    findings,
    summary,
    timeline,
    memoryNDJSON,
    proofHash,
  };

  // Signature computed LAST, over every other field, mirroring
  // proof-builder.js's packageHash discipline exactly.
  const signature = djb2(JSON.stringify(roomWithoutSignature));

  return {
    ...roomWithoutSignature,
    signature,
  };
}

// ---------- verifyRoom ----------

/**
 * verifyRoom(room)
 * Re-computes the signature over every field except `signature` itself and
 * compares against the stored value. Returns { valid, reason }. `reason` is
 * null when valid, otherwise a short human-readable explanation.
 */
export function verifyRoom(room) {
  if (!isPlainObject(room)) {
    return { valid: false, reason: 'Room is not an object' };
  }
  if (!isNonEmptyString(room.signature)) {
    return { valid: false, reason: 'Room has no signature field' };
  }

  const { signature, ...rest } = room;
  const expected = djb2(JSON.stringify(rest));

  if (expected !== signature) {
    return { valid: false, reason: 'Signature does not match Room contents — the Room may have been edited or corrupted after signing' };
  }

  return { valid: true, reason: null };
}

// ---------- isSameDataset ----------

/**
 * isSameDataset(roomA, roomB)
 * True if both Rooms' dataset.sourceFileHash match (and are non-null).
 */
export function isSameDataset(roomA, roomB) {
  const hashA = isPlainObject(roomA) && isPlainObject(roomA.dataset) ? roomA.dataset.sourceFileHash : null;
  const hashB = isPlainObject(roomB) && isPlainObject(roomB.dataset) ? roomB.dataset.sourceFileHash : null;
  return isNonEmptyString(hashA) && isNonEmptyString(hashB) && hashA === hashB;
}

// ---------- mergeRooms ----------

// Extracts a leading ISO-ish timestamp prefix from a timeline string (the
// describeRecord() strings in institutional-memory.js embed a
// "(YYYY-MM-DD HH:MM)" suffix, not a prefix — so we look for either a
// leading ISO date or the trailing parenthesized timestamp, falling back to
// no ordering key when neither is present).
const LEADING_ISO_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)/;
const TRAILING_PAREN_RE = /\((\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?)\)\s*[^()]*$/;

function timelineSortKey(line) {
  if (typeof line !== 'string') return null;
  const lead = line.match(LEADING_ISO_RE);
  if (lead) return lead[1];
  const trail = line.match(TRAILING_PAREN_RE);
  if (trail) return trail[1];
  return null;
}

function interleaveTimelines(timelineA, timelineB) {
  const a = Array.isArray(timelineA) ? timelineA : [];
  const b = Array.isArray(timelineB) ? timelineB : [];

  if (a.length === 0 && b.length === 0) return null;

  const seen = new Set();
  const combined = [];
  for (const line of [...a, ...b]) {
    if (typeof line !== 'string') continue;
    if (seen.has(line)) continue;
    seen.add(line);
    combined.push(line);
  }

  const allHaveKeys = combined.every((line) => timelineSortKey(line) !== null);
  if (allHaveKeys) {
    combined.sort((x, y) => {
      const kx = timelineSortKey(x);
      const ky = timelineSortKey(y);
      return kx < ky ? -1 : kx > ky ? 1 : 0;
    });
  }
  // else: keep concat-then-dedupe order (roomA then roomB), as specified.

  return combined;
}

function ndjsonRecordId(line) {
  try {
    const parsed = JSON.parse(line);
    if (isPlainObject(parsed) && parsed.id !== undefined && parsed.id !== null) {
      return String(parsed.id);
    }
  } catch {
    // fall through
  }
  return null;
}

function mergeNDJSON(ndjsonA, ndjsonB) {
  const hasA = typeof ndjsonA === 'string' && ndjsonA.length > 0;
  const hasB = typeof ndjsonB === 'string' && ndjsonB.length > 0;
  if (!hasA && !hasB) return null;
  if (hasA && !hasB) return ndjsonA;
  if (!hasA && hasB) return ndjsonB;

  const lines = [...ndjsonA.split('\n'), ...ndjsonB.split('\n')].filter((l) => l.trim() !== '');
  const byId = new Map(); // id (or line itself if no id) -> line, first-seen wins
  const noIdLines = [];
  const order = [];

  for (const line of lines) {
    const id = ndjsonRecordId(line);
    if (id === null) {
      if (!noIdLines.includes(line)) {
        noIdLines.push(line);
        order.push(line);
      }
      continue;
    }
    if (!byId.has(id)) {
      byId.set(id, line);
      order.push(line);
    }
  }

  return order.join('\n');
}

function mergeFindings(findingsA, findingsB) {
  const a = Array.isArray(findingsA) ? findingsA : [];
  const b = Array.isArray(findingsB) ? findingsB : [];

  const byKey = new Map(); // key -> finding (roomA's version wins on exact dup)
  const conflicts = [];

  for (const f of a) {
    byKey.set(findingKey(f), f);
  }

  for (const f of b) {
    const key = findingKey(f);
    if (!byKey.has(key)) {
      byKey.set(key, f);
      continue;
    }
    const existing = byKey.get(key);
    if (existing.severity !== f.severity) {
      conflicts.push({
        field: 'findings.severity',
        roomAValue: existing.severity,
        roomBValue: f.severity,
        description: `Column "${f.column ?? '(none)'}" / "${f.message}" has severity "${existing.severity}" in Room A but "${f.severity}" in Room B`,
      });
      // Keep the more severe of the two in the merged findings list.
      if (severityRank(f.severity) < severityRank(existing.severity)) {
        byKey.set(key, f);
      }
    }
    // exact duplicate (same severity too) -> dedupe silently, no conflict.
  }

  const merged = sortFindingsDeterministically([...byKey.values()]).map(sanitizeFinding);
  return { merged, conflicts };
}

/**
 * mergeRooms(roomA, roomB, options = {})
 * Merges two Rooms about the SAME dataset (matched by sourceFileHash) into
 * one re-signed Room. Returns { merged, conflicts }. If the Rooms are about
 * different datasets, returns { merged: null, conflicts: [...] } with a
 * single sourceFileHash conflict describing the mismatch. See file header /
 * docs/rooms.md for the full field-by-field merge rules.
 */
export function mergeRooms(roomA, roomB, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const a = isPlainObject(roomA) ? roomA : {};
  const b = isPlainObject(roomB) ? roomB : {};
  const datasetA = isPlainObject(a.dataset) ? a.dataset : {};
  const datasetB = isPlainObject(b.dataset) ? b.dataset : {};

  if (datasetA.sourceFileHash !== datasetB.sourceFileHash) {
    return {
      merged: null,
      conflicts: [{
        field: 'sourceFileHash',
        roomAValue: datasetA.sourceFileHash ?? null,
        roomBValue: datasetB.sourceFileHash ?? null,
        description: 'Rooms are about different source files and cannot be merged',
      }],
    };
  }

  const conflicts = [];

  // ---- findings ----
  const { merged: mergedFindings, conflicts: findingConflicts } = mergeFindings(a.findings, b.findings);
  conflicts.push(...findingConflicts);

  // ---- timeline ----
  const mergedTimeline = interleaveTimelines(a.timeline, b.timeline);

  // ---- memoryNDJSON ----
  const mergedNDJSON = mergeNDJSON(a.memoryNDJSON, b.memoryNDJSON);

  // ---- storySummary ----
  const summaryA = isPlainObject(a.summary) ? a.summary : {};
  const summaryB = isPlainObject(b.summary) ? b.summary : {};
  const storySummaryA = summaryA.storySummary ?? null;
  const storySummaryB = summaryB.storySummary ?? null;
  let mergedStorySummary = storySummaryA;
  if (isNonEmptyString(storySummaryA) && isNonEmptyString(storySummaryB) && storySummaryA !== storySummaryB) {
    conflicts.push({
      field: 'storySummary',
      roomAValue: storySummaryA,
      roomBValue: storySummaryB,
      description: 'Rooms carry different story summaries — Room A\'s summary was kept in the merged Room',
    });
    mergedStorySummary = storySummaryA;
  } else if (!isNonEmptyString(mergedStorySummary) && isNonEmptyString(storySummaryB)) {
    mergedStorySummary = storySummaryB;
  }

  // ---- proofHash ----
  const proofHashA = a.proofHash ?? null;
  const proofHashB = b.proofHash ?? null;
  let mergedProofHash = proofHashA ?? proofHashB ?? null;
  let proofHashes = null;
  if (isNonEmptyString(proofHashA) && isNonEmptyString(proofHashB) && proofHashA !== proofHashB) {
    conflicts.push({
      field: 'proofHash',
      roomAValue: proofHashA,
      roomBValue: proofHashB,
      description: 'Rooms carry different proof hashes — both were kept in merged.proofHashes[]',
    });
    proofHashes = [proofHashA, proofHashB];
  }

  const errorCount = countBySeverity(mergedFindings, ['error', 'critical']);
  const warningCount = countBySeverity(mergedFindings, ['warning']);

  const mergedBy = isNonEmptyString(opts.mergedBy) ? opts.mergedBy : 'Unknown analyst';
  const mergedAt = isNonEmptyString(opts.mergedAt) ? opts.mergedAt : new Date().toISOString();
  const roomNameA = isNonEmptyString(a.roomName) ? a.roomName : 'Untitled Room';
  const roomNameB = isNonEmptyString(b.roomName) ? b.roomName : 'Untitled Room';
  const roomName = `Merged: ${roomNameA} + ${roomNameB}`;

  const dataset = {
    name: datasetA.name ?? datasetB.name ?? null,
    sourceFileHash: datasetA.sourceFileHash,
    rowCount: typeof datasetA.rowCount === 'number' ? datasetA.rowCount : (datasetB.rowCount ?? 0),
    columnCount: typeof datasetA.columnCount === 'number' ? datasetA.columnCount : (datasetB.columnCount ?? 0),
  };

  const roomId = djb2(`${roomName}\u0000${dataset.sourceFileHash ?? ''}\u0000${mergedAt}`);

  const mergedRoomWithoutSignature = {
    version: ROOM_VERSION,
    format: ROOM_FORMAT,
    roomId,
    roomName,
    createdBy: mergedBy,
    createdAt: mergedAt,
    dataset,
    findings: mergedFindings,
    summary: {
      totalFindings: mergedFindings.length,
      errorCount,
      warningCount,
      storySummary: mergedStorySummary,
    },
    timeline: mergedTimeline,
    memoryNDJSON: mergedNDJSON,
    proofHash: mergedProofHash,
  };

  if (proofHashes) {
    mergedRoomWithoutSignature.proofHashes = proofHashes;
  }

  const signature = djb2(JSON.stringify(mergedRoomWithoutSignature));

  const merged = {
    ...mergedRoomWithoutSignature,
    signature,
  };

  return { merged, conflicts };
}

// ---------- serializeRoom / deserializeRoom ----------

/**
 * serializeRoom(room)
 * Returns JSON.stringify(room, null, 2) — the actual Room export file
 * content.
 */
export function serializeRoom(room) {
  return JSON.stringify(room, null, 2);
}

const REQUIRED_ROOM_FIELDS = ['version', 'format', 'roomId', 'roomName', 'createdBy', 'createdAt', 'dataset', 'findings', 'summary', 'signature'];

/**
 * deserializeRoom(json)
 * Parses a Room JSON string and validates its structure (required fields
 * present, version/format correct). Does NOT verify the signature — call
 * verifyRoom() separately on the returned room. Returns
 * { room, valid, errors }.
 */
export function deserializeRoom(json) {
  const errors = [];

  if (typeof json !== 'string') {
    return { room: null, valid: false, errors: ['Input is not a JSON string'] };
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { room: null, valid: false, errors: [`Invalid JSON: ${e.message}`] };
  }

  if (!isPlainObject(parsed)) {
    return { room: null, valid: false, errors: ['Parsed content is not an object'] };
  }

  for (const field of REQUIRED_ROOM_FIELDS) {
    if (!(field in parsed) || parsed[field] === undefined) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if ('version' in parsed && parsed.version !== ROOM_VERSION) {
    errors.push(`Unexpected version: ${parsed.version} (expected ${ROOM_VERSION})`);
  }

  if ('format' in parsed && parsed.format !== ROOM_FORMAT) {
    errors.push(`Unexpected format: ${parsed.format} (expected "${ROOM_FORMAT}")`);
  }

  return {
    room: parsed,
    valid: errors.length === 0,
    errors,
  };
}

// ---------- describeRoom ----------

function formatDisplayDate(iso) {
  if (typeof iso !== 'string') return 'an unknown date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * describeRoom(room)
 * Returns a plain-text, human-readable summary of a Room for display in the
 * Canvas import UI. See file header for the exact expected format.
 */
export function describeRoom(room) {
  const r = isPlainObject(room) ? room : {};
  const dataset = isPlainObject(r.dataset) ? r.dataset : {};
  const summary = isPlainObject(r.summary) ? r.summary : {};

  const roomName = r.roomName ?? 'Untitled Room';
  const datasetName = dataset.name ?? 'Unknown dataset';
  const rowCount = typeof dataset.rowCount === 'number' ? dataset.rowCount : 0;
  const columnCount = typeof dataset.columnCount === 'number' ? dataset.columnCount : 0;
  const createdBy = r.createdBy ?? 'Unknown analyst';
  const createdAtDisplay = formatDisplayDate(r.createdAt);
  const errorCount = typeof summary.errorCount === 'number' ? summary.errorCount : 0;
  const warningCount = typeof summary.warningCount === 'number' ? summary.warningCount : 0;
  const storySummary = isNonEmptyString(summary.storySummary) ? summary.storySummary : 'Not included';
  const proofHash = isNonEmptyString(r.proofHash) ? r.proofHash.slice(0, 12) : 'Not included';

  const { valid } = verifyRoom(room);
  const signatureLabel = valid ? 'VALID' : 'INVALID';

  const lines = [];
  lines.push(`Room: "${roomName}"`);
  lines.push(`Dataset: ${datasetName} (${rowCount} rows, ${columnCount} cols)`);
  lines.push(`Created by: ${createdBy} on ${createdAtDisplay}`);
  lines.push(`Findings: ${errorCount} errors, ${warningCount} warnings`);
  lines.push(`Story: ${storySummary}`);
  lines.push(`Proof hash: ${proofHash}`);
  lines.push(`Signature: ${signatureLabel}`);

  return lines.join('\n');
}
