/* DataGlow — js/drop-zone/drop-zone-router.js */
/* Part of structured refactor — see src/ directory */

var DropZoneRouter = (function () {
    var FORMAT_HANDLERS = {
      csv: 'duckdb', tsv: 'duckdb', json: 'duckdb', ndjson: 'duckdb', parquet: 'duckdb',
      xlsx: 'univer', pdf: 'rag', audio: 'whisper', video: 'webcodecs',
      txt: 'duckdb', log: 'duckdb', arrow: 'duckdb', feather: 'duckdb', xml: 'rag',
      image: 'ocr',
      unknown: 'unknown'
    };
    var FORMAT_ICONS = {
      csv: 'table', tsv: 'table', json: 'table', ndjson: 'table', parquet: 'table',
      xlsx: 'grid', pdf: 'document', audio: 'audio', video: 'video',
      txt: 'table', log: 'table', arrow: 'table', feather: 'table', xml: 'document',
      image: 'document',
      unknown: 'unknown'
    };
    var AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.flac'];
    var VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm'];
    var IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'];

    function extOf(fileName) {
      var m = /\.[^./\\]+$/.exec(fileName || '');
      return m ? m[0].toLowerCase() : '';
    }
    function bytesStartWith(bytes, ascii, offset) {
      offset = offset || 0;
      if (!bytes || bytes.length < offset + ascii.length) return false;
      for (var i = 0; i < ascii.length; i++) {
        if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
      }
      return true;
    }
    function bytesStartWithPK(bytes) {
      return !!bytes && bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    }
    function handlerForFormat(format) { return FORMAT_HANDLERS[format] || 'unknown'; }
    function iconForFormat(format) { return FORMAT_ICONS[format] || 'unknown'; }

    function detectFileFormat(fileName, mimeType, firstBytes) {
      var name = fileName || '';
      var mime = mimeType || '';
      var ext = extOf(name);

      if (bytesStartWith(firstBytes, 'PAR1', 0)) {
        return { format: 'parquet', confidence: 'high', handler: handlerForFormat('parquet') };
      }
      if (bytesStartWith(firstBytes, '%PDF', 0)) {
        return { format: 'pdf', confidence: 'high', handler: handlerForFormat('pdf') };
      }
      if (bytesStartWithPK(firstBytes) && ext === '.xlsx') {
        return { format: 'xlsx', confidence: 'high', handler: handlerForFormat('xlsx') };
      }
      if (mime === 'text/csv') {
        return { format: 'csv', confidence: 'medium', handler: handlerForFormat('csv') };
      }
      if (mime === 'application/json') {
        return { format: 'json', confidence: 'medium', handler: handlerForFormat('json') };
      }
      if (mime.indexOf('audio/') === 0) {
        return { format: 'audio', confidence: 'medium', handler: handlerForFormat('audio') };
      }
      if (mime.indexOf('video/') === 0) {
        return { format: 'video', confidence: 'medium', handler: handlerForFormat('video') };
      }
      // Arrow IPC / Feather v2  -  magic bytes "ARROW1\0\0" (first 6 bytes)
      if (firstBytes && firstBytes.length >= 6) {
        var arrowMagic = [0x41, 0x52, 0x52, 0x4F, 0x57, 0x31]; // "ARROW1"
        var isArrowMagic = true;
        for (var ai = 0; ai < arrowMagic.length; ai++) {
          if (firstBytes[ai] !== arrowMagic[ai]) { isArrowMagic = false; break; }
        }
        if (isArrowMagic) {
          return { format: 'arrow', confidence: 'high', handler: handlerForFormat('arrow') };
        }
      }
      // Image magic bytes: PNG (89 50 4E 47), JPEG (FF D8 FF), BMP (42 4D), GIF (47 49 46)
      if (firstBytes && firstBytes.length >= 4) {
        if (firstBytes[0] === 0x89 && firstBytes[1] === 0x50 && firstBytes[2] === 0x4E && firstBytes[3] === 0x47) {
          return { format: 'image', confidence: 'high', handler: handlerForFormat('image') };
        }
        if (firstBytes[0] === 0xFF && firstBytes[1] === 0xD8 && firstBytes[2] === 0xFF) {
          return { format: 'image', confidence: 'high', handler: handlerForFormat('image') };
        }
        if (firstBytes[0] === 0x42 && firstBytes[1] === 0x4D) {
          return { format: 'image', confidence: 'high', handler: handlerForFormat('image') };
        }
        if (firstBytes[0] === 0x47 && firstBytes[1] === 0x49 && firstBytes[2] === 0x46) {
          return { format: 'image', confidence: 'high', handler: handlerForFormat('image') };
        }
      }

      if (ext === '.tsv') return { format: 'tsv', confidence: 'low', handler: handlerForFormat('tsv') };
      if (ext === '.parquet') return { format: 'parquet', confidence: 'low', handler: handlerForFormat('parquet') };
      if (ext === '.csv') return { format: 'csv', confidence: 'low', handler: handlerForFormat('csv') };
      if (ext === '.json') return { format: 'json', confidence: 'low', handler: handlerForFormat('json') };
      if (ext === '.ndjson') return { format: 'json', confidence: 'low', handler: handlerForFormat('json') };
      if (ext === '.xlsx') return { format: 'xlsx', confidence: 'low', handler: handlerForFormat('xlsx') };
      if (ext === '.pdf') return { format: 'pdf', confidence: 'low', handler: handlerForFormat('pdf') };
      if (ext === '.txt' || ext === '.log') return { format: 'txt', confidence: 'low', handler: handlerForFormat('txt') };
      if (ext === '.arrow') return { format: 'arrow', confidence: 'low', handler: handlerForFormat('arrow') };
      if (ext === '.feather') return { format: 'feather', confidence: 'low', handler: handlerForFormat('feather') };
      if (ext === '.xml') return { format: 'xml', confidence: 'low', handler: handlerForFormat('xml') };
      if (AUDIO_EXTENSIONS.indexOf(ext) !== -1) return { format: 'audio', confidence: 'low', handler: handlerForFormat('audio') };
      if (VIDEO_EXTENSIONS.indexOf(ext) !== -1) return { format: 'video', confidence: 'low', handler: handlerForFormat('video') };
      if (IMAGE_EXTS.indexOf(ext) !== -1) return { format: 'image', confidence: 'low', handler: handlerForFormat('image') };

      return { format: 'unknown', confidence: 'low', handler: 'unknown' };
    }

    function cleanDisplayName(fileName) {
      var ext = extOf(fileName);
      var base = ext ? fileName.slice(0, -ext.length) : fileName;
      return base.replace(/_/g, ' ');
    }

    var _manifestCounter = 0;
    function nextManifestId() {
      return 'manifest_' + Date.now().toString(36) + '_' + (++_manifestCounter).toString(36);
    }
    function fileIdFor(index, name) {
      return 'file_' + index + '_' + (name || '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
    }

    function buildDropManifest(files) {
      var list = files || [];
      var items = list.map(function (f, index) {
        var d = detectFileFormat(f.name, f.mimeType, f.firstBytes);
        return {
          fileId: fileIdFor(index, f.name),
          name: f.name,
          size: f.size,
          format: d.format,
          handler: d.handler,
          confidence: d.confidence,
          displayName: cleanDisplayName(f.name || ''),
          tabOrder: index
        };
      });

      var handlersPresent = {};
      items.forEach(function (i) { handlersPresent[i.handler] = true; });
      var hasMixedFormats = Object.keys(handlersPresent).length > 1;
      var requiresTranscription = items.some(function (i) { return i.format === 'audio' || i.format === 'video'; });
      var requiresRAG = items.some(function (i) { return i.format === 'pdf'; });

      return {
        manifestId: nextManifestId(),
        totalFiles: items.length,
        items: items,
        hasMixedFormats: hasMixedFormats,
        requiresTranscription: requiresTranscription,
        requiresRAG: requiresRAG
      };
    }

    function routeDropManifest(manifest) {
      var plan = { duckdbFiles: [], univerFiles: [], ragFiles: [], transcriptionFiles: [], webCodecsFiles: [], ocrFiles: [], unknownFiles: [] };
      var items = (manifest && manifest.items) || [];
      items.forEach(function (item) {
        switch (item.handler) {
          case 'duckdb': plan.duckdbFiles.push(item); break;
          case 'univer': plan.univerFiles.push(item); break;
          case 'rag': plan.ragFiles.push(item); break;
          case 'whisper': plan.transcriptionFiles.push(item); break;
          case 'webcodecs': plan.webCodecsFiles.push(item); break;
          case 'ocr': plan.ocrFiles.push(item); break;
          default: plan.unknownFiles.push(item);
        }
      });
      return plan;
    }

    function buildTabDescriptor(fileId, displayName, format, status) {
      return { fileId: fileId, displayName: displayName, format: format, status: status, icon: iconForFormat(format) };
    }

    return {
      detectFileFormat: detectFileFormat,
      buildDropManifest: buildDropManifest,
      routeDropManifest: routeDropManifest,
      buildTabDescriptor: buildTabDescriptor
    };
