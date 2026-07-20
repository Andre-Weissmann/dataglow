/* DataGlow — js/rooms/rooms-builder.js */
/* Part of structured refactor — see src/ directory */

var RoomsBuilder = (function () {
    var ROOM_VERSION = 1;
    var ROOM_FORMAT = 'dataglow-room';

    function djb2(str) {
      var hash = 5381;
      var s = String(str == null ? '' : str);
      for (var i = 0; i < s.length; i++) {
        hash = ((hash * 33) ^ s.charCodeAt(i)) >>> 0;
      }
      return hash.toString(16);
    }

    function createRoom(session, options) {
      var s = session || {};
      var opts = options || {};
      var includeTimeline = opts.includeTimeline !== undefined ? opts.includeTimeline : true;
      var includeMemoryNDJSON = opts.includeMemoryNDJSON !== undefined ? opts.includeMemoryNDJSON : true;

      var room = {
        formatVersion: ROOM_VERSION,
        format: ROOM_FORMAT,
        roomName: s.roomName || 'Untitled Room',
        createdBy: s.createdBy || 'Unknown',
        createdAt: s.createdAt || new Date().toISOString(),
        sourceFileHash: s.sourceFileHash || null,
        datasetName: s.datasetName || null,
        rowCount: s.rowCount || 0,
        columnCount: s.columnCount || 0,
        findings: Array.isArray(s.findings) ? s.findings : [],
        storySummary: s.storySummary || null,
        proofHash: s.proofHash || null
      };
      if (includeTimeline) room.memoryTimeline = s.memoryTimeline || null;
      if (includeMemoryNDJSON) room.memoryNDJSON = s.memoryNDJSON || null;

      room.signature = djb2(JSON.stringify({
        roomName: room.roomName,
        createdBy: room.createdBy,
        datasetName: room.datasetName,
        sourceFileHash: room.sourceFileHash,
        rowCount: room.rowCount
      }));

      return room;
    }

    function verifyRoom(room) {
      var r = room || {};
      if (r.format !== ROOM_FORMAT) {
        return { valid: false, reason: 'Not a dataglow-room object.' };
      }
      var expected = djb2(JSON.stringify({
        roomName: r.roomName,
        createdBy: r.createdBy,
        datasetName: r.datasetName,
        sourceFileHash: r.sourceFileHash,
        rowCount: r.rowCount
      }));
      if (r.signature !== expected) {
        return { valid: false, reason: 'Signature mismatch.' };
      }
      return { valid: true, reason: null };
    }

    function isSameDataset(roomA, roomB) {
      if (!roomA || !roomB) return false;
      return roomA.sourceFileHash && roomA.sourceFileHash === roomB.sourceFileHash;
    }

    function mergeRooms(roomA, roomB, options) {
      var opts = options || {};
      var merged = Object.assign({}, roomA, {
        findings: [].concat(roomA && roomA.findings ? roomA.findings : [], roomB && roomB.findings ? roomB.findings : [])
      }, opts.overrides || {});
      merged.signature = djb2(JSON.stringify({
        roomName: merged.roomName,
        createdBy: merged.createdBy,
        datasetName: merged.datasetName,
        sourceFileHash: merged.sourceFileHash,
        rowCount: merged.rowCount
      }));
      return merged;
    }

    function serializeRoom(room) {
      return JSON.stringify(room, null, 2);
    }

    function deserializeRoom(json) {
      var errors = [];
      var room = null;
      try {
        room = JSON.parse(json);
      } catch (e) {
        return { room: null, valid: false, errors: ['Invalid JSON: ' + e.message] };
      }
      if (!room || typeof room !== 'object') {
        errors.push('Parsed value is not an object.');
      } else {
        if (room.format !== ROOM_FORMAT) errors.push('Missing or invalid "format" field.');
        if (!room.roomName) errors.push('Missing "roomName" field.');
      }
      return { room: room, valid: errors.length === 0, errors: errors };
    }

    function describeRoom(room) {
      var r = room || {};
      var verification = verifyRoom(r);
      var lines = [
        'Room: ' + (r.roomName || 'Untitled Room'),
        'Created by: ' + (r.createdBy || 'Unknown'),
        'Created at: ' + (r.createdAt || 'unknown'),
        'Dataset: ' + (r.datasetName || 'unknown') + ' (' + (r.rowCount || 0) + ' rows, ' + (r.columnCount || 0) + ' cols)',
        'Findings: ' + (Array.isArray(r.findings) ? r.findings.length : 0),
        'Signature valid: ' + (verification.valid ? 'YES' : 'NO (' + (verification.reason || 'unknown') + ')')
      ];
      if (r.storySummary) lines.push('Story summary: ' + r.storySummary);
      return lines.join('\n');
    }

    return {
      ROOM_VERSION: ROOM_VERSION,
      ROOM_FORMAT: ROOM_FORMAT,
      createRoom: createRoom,
      verifyRoom: verifyRoom,
      isSameDataset: isSameDataset,
      mergeRooms: mergeRooms,
      serializeRoom: serializeRoom,
      deserializeRoom: deserializeRoom,
      describeRoom: describeRoom
    };
