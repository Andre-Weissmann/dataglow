/* DataGlow — js/ingestion/text-line-parser.js */
/* Part of structured refactor — see src/ directory */

var TextLineParser = (function () {
    function parseTextLines(text, opts) {
      opts = opts || {};
      var skipEmpty = opts.skipEmpty || false;
      var maxLines = opts.maxLines || 500000;
      if (typeof text !== 'string') return { rows: [], lineCount: 0, skippedEmpty: 0 };

      var raw = text.split('\n');
      var rows = [];
      var skippedEmpty = 0;

      for (var i = 0; i < raw.length && rows.length < maxLines; i++) {
        var content = raw[i].replace(/\r$/, '');
        if (skipEmpty && content.trim() === '') {
          skippedEmpty++;
          continue;
        }
        rows.push({ line_number: i + 1, content: content });
      }

      return { rows: rows, lineCount: raw.length, skippedEmpty: skippedEmpty };
    }

    function inferTextKind(sampleLines) {
      if (!Array.isArray(sampleLines) || sampleLines.length === 0) return 'unknown';
      var sample = sampleLines.slice(0, 20);
      var tsPattern = /^\d{4}-\d{2}-\d{2}|^\[\d{2}[:/]\d{2}/;
      var severityPattern = /\b(INFO|WARN|WARNING|ERROR|DEBUG|CRITICAL|FATAL|TRACE)\b/i;
      var delimPattern = /\t|,(?=\S)/;
      var tsHits = 0, sevHits = 0, delimHits = 0;
      for (var i = 0; i < sample.length; i++) {
        var line = sample[i];
        if (tsPattern.test(line)) tsHits++;
        if (severityPattern.test(line)) sevHits++;
        if (delimPattern.test(line)) delimHits++;
      }
      if (tsHits >= 3 || sevHits >= 3) return 'log';
      if (delimHits >= Math.floor(sample.length * 0.7)) return 'delimited';
      var allLong = sample.every(function (l) { return l.trim().length > 40; });
      if (allLong) return 'prose';
      return 'unknown';
    }

    function buildTextDataset(parsed, fileName, kind) {
      return {
        columns: ['line_number', 'content'],
        rows: parsed.rows,
        meta: {
          source: fileName,
          format: 'txt',
          kind: kind,
          lineCount: parsed.lineCount,
          skippedEmpty: parsed.skippedEmpty || 0,
          note: kind === 'log'
            ? 'Log file detected  -  timestamps and severity levels present. Query content for patterns.'
            : kind === 'delimited'
            ? 'Delimited text detected  -  consider renaming to .csv or .tsv for richer column parsing.'
            : 'Plain text loaded as line-numbered rows. Use SQL LIKE/REGEXP on content column.'
        }
      };
    }

    return {
      parseTextLines: parseTextLines,
      inferTextKind: inferTextKind,
      buildTextDataset: buildTextDataset
    };
