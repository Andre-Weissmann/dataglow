// ============================================================
// DATAGLOW — Rooms builder test suite
// ============================================================
// Pure Node, no DOM, no DuckDB, no network.
// RUN WITH: node test/rooms/rooms-builder.test.js

import {
  ROOM_VERSION,
  ROOM_FORMAT,
  createRoom,
  verifyRoom,
  mergeRooms,
  serializeRoom,
  deserializeRoom,
  describeRoom,
  isSameDataset,
} from '../../js/rooms/rooms-builder.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- Fixtures ----------

const findingsA = [
  { severity: 'error', column: 'claim_amount', message: 'Negative values found', rowsAffected: 5, suggestedFix: 'Take absolute value', status: 'open' },
  { severity: 'warning', column: 'patient_id', message: 'Duplicate IDs detected', rowsAffected: 3, suggestedFix: null, status: 'open' },
];

const findingsB = [
  { severity: 'error', column: 'claim_amount', message: 'Negative values found', rowsAffected: 5, suggestedFix: 'Take absolute value', status: 'resolved' }, // exact key dup, different status only -> no severity conflict
  { severity: 'critical', column: 'diagnosis_code', message: 'Referential integrity broken', rowsAffected: 40, suggestedFix: 'Re-map codes', status: 'open' },
];

const findingsBConflict = [
  { severity: 'warning', column: 'patient_id', message: 'Duplicate IDs detected', rowsAffected: 3, suggestedFix: null, status: 'open' }, // same key, different severity than findingsA's warning-> wait needs diff severity
];

const timelineA = [
  'File loaded: claims_Q2_2026.csv (2026-07-10 10:00)',
  'Agent fixed 5 values in claim_amount — accepted by analyst (2026-07-10 10:05)',
];

const timelineB = [
  'Validation issue on diagnosis_code resolved by analyst (2026-07-10 10:02)',
  'File loaded: claims_Q2_2026.csv (2026-07-10 10:00)', // exact dup of timelineA's first entry
];

const ndjsonA = [
  JSON.stringify({ id: 'r1', type: 'file_loaded', actor: 'human', timestamp: '2026-07-10T10:00:00.000Z' }),
  JSON.stringify({ id: 'r2', type: 'manual_edit', actor: 'human', timestamp: '2026-07-10T10:05:00.000Z' }),
].join('\n');

const ndjsonB = [
  JSON.stringify({ id: 'r2', type: 'manual_edit', actor: 'human', timestamp: '2026-07-10T10:05:00.000Z' }), // dup id
  JSON.stringify({ id: 'r3', type: 'validation_resolved', actor: 'human', timestamp: '2026-07-10T10:10:00.000Z' }),
].join('\n');

function baseSession(overrides = {}) {
  return {
    roomName: 'Claims Q2 Review',
    datasetName: 'claims_Q2_2026.csv',
    sourceFileHash: 'djb2:abc12345',
    rowCount: 14203,
    columnCount: 18,
    findings: findingsA,
    memoryTimeline: timelineA,
    memoryNDJSON: ndjsonA,
    storySummary: 'Claims data is largely clean, with 5 negative claim amounts needing review.',
    proofHash: 'djb2:c001d00d',
    createdBy: 'Andre W.',
    createdAt: '2026-07-19T15:00:00.000Z',
    ...overrides,
  };
}

function main() {
  // ---------- createRoom: shape ----------
  {
    const room = createRoom(baseSession());
    ok(room.version === ROOM_VERSION, 'createRoom: version field set');
    ok(room.format === ROOM_FORMAT, 'createRoom: format field set');
    ok(typeof room.roomId === 'string' && room.roomId.length > 0, 'createRoom: roomId present');
    ok(room.roomName === 'Claims Q2 Review', 'createRoom: roomName carried through');
    ok(room.createdBy === 'Andre W.', 'createRoom: createdBy carried through');
    ok(room.createdAt === '2026-07-19T15:00:00.000Z', 'createRoom: createdAt carried through');
    ok(isPlainObj(room.dataset) && room.dataset.sourceFileHash === 'djb2:abc12345', 'createRoom: dataset.sourceFileHash set');
    ok(room.dataset.rowCount === 14203 && room.dataset.columnCount === 18, 'createRoom: dataset row/col counts set');
    ok(Array.isArray(room.findings) && room.findings.length === 2, 'createRoom: findings array present');
    ok(isPlainObj(room.summary) && room.summary.totalFindings === 2, 'createRoom: summary.totalFindings correct');
    ok(room.summary.errorCount === 1 && room.summary.warningCount === 1, 'createRoom: summary error/warning counts correct');
    ok(room.summary.storySummary === baseSession().storySummary, 'createRoom: summary.storySummary carried through');
    ok(Array.isArray(room.timeline) && room.timeline.length === 2, 'createRoom: timeline included by default');
    ok(typeof room.memoryNDJSON === 'string' && room.memoryNDJSON.length > 0, 'createRoom: memoryNDJSON included by default');
    ok(room.proofHash === 'djb2:c001d00d', 'createRoom: proofHash carried through');
    ok(typeof room.signature === 'string' && room.signature.length > 0, 'createRoom: signature present');
  }

  // ---------- createRoom: options ----------
  {
    const room = createRoom(baseSession(), { includeTimeline: false, includeMemoryNDJSON: false });
    ok(room.timeline === null, 'createRoom: includeTimeline=false yields null timeline');
    ok(room.memoryNDJSON === null, 'createRoom: includeMemoryNDJSON=false yields null memoryNDJSON');
  }

  // ---------- createRoom: no raw data leakage ----------
  {
    const rawRowLike = [['row1val1', 'row1val2'], ['row2val1', 'row2val2']];
    const session = baseSession({ rawRows: rawRowLike, sourceRows: rawRowLike, cellValues: ['secret-cell-value-42'] });
    const room = createRoom(session);
    const serialized = JSON.stringify(room);
    ok(!serialized.includes('row1val1') && !serialized.includes('secret-cell-value-42'), 'createRoom: extraneous raw-data-shaped session fields never leak into Room output');
    // Structural check: no array-of-arrays (a classic "row data" shape) anywhere in the Room.
    ok(!containsArrayOfArrays(room), 'createRoom: Room contains no array-of-arrays (raw row) structures');
  }

  // ---------- createRoom: deterministic roomId ----------
  {
    const session = baseSession();
    const roomX = createRoom(session);
    const roomY = createRoom(session);
    ok(roomX.roomId === roomY.roomId, 'createRoom: roomId is deterministic given identical roomName+sourceFileHash+createdAt');

    const sessionDifferentTime = baseSession({ createdAt: '2026-07-19T16:00:00.000Z' });
    const roomZ = createRoom(sessionDifferentTime);
    ok(roomZ.roomId !== roomX.roomId, 'createRoom: roomId changes when createdAt changes');
  }

  // ---------- createRoom: signature computed over all other fields ----------
  {
    const room = createRoom(baseSession());
    const { signature, ...rest } = room;
    const room2 = createRoom(baseSession({ roomName: 'Different Name' }));
    ok(room.signature !== room2.signature, 'createRoom: signature changes when roomName (and therefore content) changes');
    ok(Object.keys(rest).length > 0, 'createRoom: signature is separable from the rest of the Room content');
  }

  // ---------- verifyRoom: fresh room ----------
  {
    const room = createRoom(baseSession());
    const result = verifyRoom(room);
    ok(result.valid === true, 'verifyRoom: passes on a freshly created Room');
    ok(result.reason === null, 'verifyRoom: reason is null when valid');
  }

  // ---------- verifyRoom: tampering detection ----------
  {
    const room = createRoom(baseSession());
    const tamperedFindings = JSON.parse(JSON.stringify(room));
    tamperedFindings.findings[0].message = 'Tampered message';
    const result1 = verifyRoom(tamperedFindings);
    ok(result1.valid === false, 'verifyRoom: detects tampered findings');
    ok(typeof result1.reason === 'string' && result1.reason.length > 0, 'verifyRoom: gives a reason for tampered findings');

    const tamperedSig = JSON.parse(JSON.stringify(room));
    tamperedSig.signature = 'djb2:00000000';
    const result2 = verifyRoom(tamperedSig);
    ok(result2.valid === false, 'verifyRoom: detects tampered signature');
  }

  // ---------- verifyRoom: malformed input ----------
  {
    ok(verifyRoom(null).valid === false, 'verifyRoom: null input is invalid');
    ok(verifyRoom({}).valid === false, 'verifyRoom: object with no signature is invalid');
  }

  // ---------- isSameDataset ----------
  {
    const roomA = createRoom(baseSession());
    const roomBSame = createRoom(baseSession({ roomName: 'Another Review' }));
    const roomBDiff = createRoom(baseSession({ roomName: 'Different File Review', sourceFileHash: 'djb2:zzz99999' }));
    ok(isSameDataset(roomA, roomBSame) === true, 'isSameDataset: true for matching sourceFileHash');
    ok(isSameDataset(roomA, roomBDiff) === false, 'isSameDataset: false for different sourceFileHash');
  }

  // ---------- mergeRooms: same dataset, no conflicts ----------
  {
    const roomA = createRoom(baseSession({
      roomName: 'Room A',
      findings: [{ severity: 'info', column: 'x', message: 'unique to A', rowsAffected: 0, status: 'open' }],
      memoryTimeline: null,
      memoryNDJSON: null,
      storySummary: null,
      proofHash: null,
    }));
    const roomB = createRoom(baseSession({
      roomName: 'Room B',
      findings: [{ severity: 'info', column: 'y', message: 'unique to B', rowsAffected: 0, status: 'open' }],
      memoryTimeline: null,
      memoryNDJSON: null,
      storySummary: null,
      proofHash: null,
    }));
    const { merged, conflicts } = mergeRooms(roomA, roomB, { mergedBy: 'Reviewer' });
    ok(merged !== null, 'mergeRooms: returns a merged Room for same-dataset Rooms');
    ok(conflicts.length === 0, 'mergeRooms: no conflicts when findings/timelines/NDJSON/story/proof do not overlap or contradict');
    ok(merged.roomName === 'Merged: Room A + Room B', 'mergeRooms: merged roomName follows the "Merged: A + B" convention');
    ok(merged.createdBy === 'Reviewer', 'mergeRooms: merged createdBy is mergedBy');
  }

  // ---------- mergeRooms: dedupe findings by column+message ----------
  {
    const roomA = createRoom(baseSession({ roomName: 'Room A', findings: findingsA }));
    const roomB = createRoom(baseSession({ roomName: 'Room B', findings: findingsB }));
    const { merged } = mergeRooms(roomA, roomB, { mergedBy: 'Reviewer' });
    // findingsA has claim_amount/"Negative values found" and patient_id/"Duplicate IDs detected"
    // findingsB has the SAME claim_amount/"Negative values found" (dup key) plus a new diagnosis_code finding
    const keys = merged.findings.map((f) => `${f.column}::${f.message}`);
    const uniqueKeys = new Set(keys);
    ok(uniqueKeys.size === keys.length, 'mergeRooms: merged findings have no duplicate column+message keys');
    ok(merged.findings.length === 3, 'mergeRooms: deduplicates the shared finding, keeping 3 unique findings total');
  }

  // ---------- mergeRooms: severity conflict flagged ----------
  {
    const roomA = createRoom(baseSession({
      roomName: 'Room A',
      findings: [{ severity: 'warning', column: 'patient_id', message: 'Duplicate IDs detected', rowsAffected: 3, status: 'open' }],
    }));
    const roomB = createRoom(baseSession({
      roomName: 'Room B',
      findings: [{ severity: 'error', column: 'patient_id', message: 'Duplicate IDs detected', rowsAffected: 3, status: 'open' }],
    }));
    const { merged, conflicts } = mergeRooms(roomA, roomB, { mergedBy: 'Reviewer' });
    const severityConflicts = conflicts.filter((c) => c.field === 'findings.severity');
    ok(severityConflicts.length === 1, 'mergeRooms: flags exactly one conflict when same column+message has different severity');
    ok(severityConflicts[0].roomAValue === 'warning' && severityConflicts[0].roomBValue === 'error', 'mergeRooms: conflict records both roomA and roomB severities');
    ok(merged.findings.some((f) => f.column === 'patient_id' && f.severity === 'error'), 'mergeRooms: keeps the more severe finding in the merged list');
  }

  // ---------- mergeRooms: interleave timelines ----------
  {
    const roomA = createRoom(baseSession({ roomName: 'Room A', memoryTimeline: timelineA }));
    const roomB = createRoom(baseSession({ roomName: 'Room B', memoryTimeline: timelineB }));
    const { merged } = mergeRooms(roomA, roomB, { mergedBy: 'Reviewer' });
    ok(Array.isArray(merged.timeline), 'mergeRooms: merged timeline is an array');
    ok(merged.timeline.length === 3, 'mergeRooms: merged timeline deduplicates the exact-duplicate entry (2+2-1=3)');
    // Chronological check: the 10:00 entry should appear before the 10:02 entry which should appear before 10:05.
    const idx1000 = merged.timeline.findIndex((l) => l.includes('10:00'));
    const idx1002 = merged.timeline.findIndex((l) => l.includes('10:02'));
    const idx1005 = merged.timeline.findIndex((l) => l.includes('10:05'));
    ok(idx1000 < idx1002 && idx1002 < idx1005, 'mergeRooms: merged timeline is sorted chronologically by embedded timestamp');
  }

  // ---------- mergeRooms: dedupe NDJSON by id ----------
  {
    const roomA = createRoom(baseSession({ roomName: 'Room A', memoryNDJSON: ndjsonA }));
    const roomB = createRoom(baseSession({ roomName: 'Room B', memoryNDJSON: ndjsonB }));
    const { merged } = mergeRooms(roomA, roomB, { mergedBy: 'Reviewer' });
    const lines = merged.memoryNDJSON.split('\n').filter((l) => l.trim());
    const ids = lines.map((l) => JSON.parse(l).id);
    ok(new Set(ids).size === ids.length, 'mergeRooms: merged NDJSON has no duplicate ids');
    ok(ids.length === 3, 'mergeRooms: merged NDJSON has r1, r2 (deduped), r3 = 3 records');
  }

  // ---------- mergeRooms: different sourceFileHash rejected ----------
  {
    const roomA = createRoom(baseSession({ roomName: 'Room A', sourceFileHash: 'djb2:aaaa1111' }));
    const roomB = createRoom(baseSession({ roomName: 'Room B', sourceFileHash: 'djb2:bbbb2222' }));
    const { merged, conflicts } = mergeRooms(roomA, roomB, { mergedBy: 'Reviewer' });
    ok(merged === null, 'mergeRooms: returns null merged Room for mismatched sourceFileHash');
    ok(conflicts.length === 1 && conflicts[0].field === 'sourceFileHash', 'mergeRooms: flags a single sourceFileHash conflict for mismatched datasets');
  }

  // ---------- mergeRooms: storySummary and proofHash conflicts ----------
  {
    const roomA = createRoom(baseSession({ roomName: 'Room A', storySummary: 'Summary from A', proofHash: 'djb2:aaaaaaaa' }));
    const roomB = createRoom(baseSession({ roomName: 'Room B', storySummary: 'Summary from B', proofHash: 'djb2:bbbbbbbb' }));
    const { merged, conflicts } = mergeRooms(roomA, roomB, { mergedBy: 'Reviewer' });
    ok(conflicts.some((c) => c.field === 'storySummary'), 'mergeRooms: flags a storySummary conflict when both present and different');
    ok(merged.summary.storySummary === 'Summary from A', "mergeRooms: keeps Room A's storySummary in the merged Room on conflict");
    ok(conflicts.some((c) => c.field === 'proofHash'), 'mergeRooms: flags a proofHash conflict when both present and different');
    ok(Array.isArray(merged.proofHashes) && merged.proofHashes.includes('djb2:aaaaaaaa') && merged.proofHashes.includes('djb2:bbbbbbbb'), 'mergeRooms: keeps both proof hashes in merged.proofHashes[]');
  }

  // ---------- mergeRooms: re-signs the merged Room ----------
  {
    const roomA = createRoom(baseSession({ roomName: 'Room A' }));
    const roomB = createRoom(baseSession({ roomName: 'Room B' }));
    const { merged } = mergeRooms(roomA, roomB, { mergedBy: 'Reviewer' });
    const result = verifyRoom(merged);
    ok(result.valid === true, 'mergeRooms: verifyRoom passes on the merged Room (it is correctly re-signed)');
  }

  // ---------- serializeRoom / deserializeRoom ----------
  {
    const room = createRoom(baseSession());
    const json = serializeRoom(room);
    ok(typeof json === 'string', 'serializeRoom: returns a string');
    let parsedOk = true;
    let parsed;
    try { parsed = JSON.parse(json); } catch { parsedOk = false; }
    ok(parsedOk, 'serializeRoom: output is valid JSON');
    ok(parsed && parsed.roomId === room.roomId, 'serializeRoom: round-trips roomId through JSON.parse');

    const { room: roundTripped, valid, errors } = deserializeRoom(json);
    ok(valid === true, 'deserializeRoom: round-trips a freshly serialized Room as valid');
    ok(errors.length === 0, 'deserializeRoom: no errors on a valid Room');
    ok(roundTripped.roomName === room.roomName, 'deserializeRoom: round-tripped Room has the same roomName');
    ok(verifyRoom(roundTripped).valid === true, 'deserializeRoom: round-tripped Room still verifies (signature survives serialize/deserialize)');
  }

  // ---------- deserializeRoom: malformed input ----------
  {
    const room = createRoom(baseSession());
    const withoutVersion = { ...room };
    delete withoutVersion.version;
    const r1 = deserializeRoom(JSON.stringify(withoutVersion));
    ok(r1.valid === false, 'deserializeRoom: invalid when version field is missing');
    ok(r1.errors.some((e) => /version/i.test(e)), 'deserializeRoom: error message mentions the missing version field');

    const withoutSignature = { ...room };
    delete withoutSignature.signature;
    const r2 = deserializeRoom(JSON.stringify(withoutSignature));
    ok(r2.valid === false, 'deserializeRoom: invalid when signature field is missing');
    ok(r2.errors.some((e) => /signature/i.test(e)), 'deserializeRoom: error message mentions the missing signature field');

    const r3 = deserializeRoom('{not valid json');
    ok(r3.valid === false && r3.room === null, 'deserializeRoom: invalid JSON string is handled without throwing');
  }

  // ---------- describeRoom ----------
  {
    const room = createRoom(baseSession());
    const text = describeRoom(room);
    ok(text.includes('Claims Q2 Review'), 'describeRoom: contains the room name');
    ok(text.includes('claims_Q2_2026.csv'), 'describeRoom: contains the dataset name');
    ok(text.includes('1 errors') || text.includes('1 error'), 'describeRoom: contains the error count');
    ok(text.includes('VALID'), 'describeRoom: shows VALID for a correctly signed Room');

    const tampered = JSON.parse(JSON.stringify(room));
    tampered.findings[0].message = 'tampered';
    const tamperedText = describeRoom(tampered);
    ok(tamperedText.includes('INVALID'), 'describeRoom: shows INVALID for a tampered Room');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// ---------- test helpers ----------

function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function containsArrayOfArrays(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.some((v) => Array.isArray(v))) return true;
    return value.some((v) => containsArrayOfArrays(v, seen));
  }
  return Object.values(value).some((v) => containsArrayOfArrays(v, seen));
}

main();
